import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import {
  BoundedMultiDestinationWriter,
  BridgeError,
  LineFramer,
  PARTIAL_LINE_LIMIT,
  PENDING_WRITE_LIMIT,
  RAW_OPEN_OPTIONS,
  classifyBridgeFailure,
  completeEnvelope,
  createDegradationTracker,
  deliverDecodedEvent,
  processEventLine,
  redactSensitive,
  renderLiveEvent,
  renderReadableEvent,
  serializeRawLine,
} from '../scripts/autopilot-observability.mjs';

const bridgeContext = (sourceStream = 'stdout') => ({
  receivedAt: '2026-08-11T10:11:12.000Z',
  runId: 'run-123',
  phase: 'implement',
  attempt: 2,
  harness: 'claude',
  sourceStream,
});

class ControlledWritable extends Writable {
  constructor(results = [true], { autoComplete = true } = {}) {
    super({ write(_chunk, _encoding, callback) { callback(); } });
    this.results = [...results];
    this.chunks = [];
    this.failure = null;
    this.autoComplete = autoComplete;
    this.callbacks = [];
  }

  write(chunk, callback) {
    if (this.failure) throw this.failure;
    this.chunks.push(String(chunk));
    if (typeof callback === 'function') {
      if (this.autoComplete) callback();
      else this.callbacks.push(callback);
    }
    return this.results.length > 0 ? this.results.shift() : true;
  }

  completeAll(error = null) {
    for (const callback of this.callbacks.splice(0)) callback(error);
  }
}

describe('incremental line framing', () => {
  it('handles fragmented Unicode, multiple lines, source identity, and a final unterminated line', () => {
    const stdout = new LineFramer({ sourceStream: 'stdout' });
    const bytes = Buffer.from('one\nemoji 🫣\nlast', 'utf8');
    const splitInsideEmoji = bytes.indexOf(Buffer.from('🫣')) + 2;

    assert.deepEqual(stdout.push(bytes.subarray(0, 2)), []);
    assert.deepEqual(stdout.push(bytes.subarray(2, splitInsideEmoji)), [
      { sourceStream: 'stdout', line: 'one' },
    ]);
    assert.deepEqual(stdout.push(bytes.subarray(splitInsideEmoji)), [
      { sourceStream: 'stdout', line: 'emoji 🫣' },
    ]);
    assert.deepEqual(stdout.end(), [{ sourceStream: 'stdout', line: 'last' }]);

    const stderr = new LineFramer({ sourceStream: 'stderr' });
    assert.deepEqual(stderr.push('a\r\nb\nc\n'), [
      { sourceStream: 'stderr', line: 'a' },
      { sourceStream: 'stderr', line: 'b' },
      { sourceStream: 'stderr', line: 'c' },
    ]);
    assert.deepEqual(stderr.end(), []);
  });

  it('classifies the 1 MiB partial-line bound as blocking raw persistence', () => {
    assert.equal(PARTIAL_LINE_LIMIT, 1024 * 1024);
    const framer = new LineFramer({ sourceStream: 'stdout', maxPartialBytes: 4 });
    assert.throws(
      () => framer.push('12345'),
      (error) => error instanceof BridgeError
        && error.code === 'RAW_PARTIAL_LINE_LIMIT'
        && error.blocking === true,
    );
  });
});

describe('privacy and serialization', () => {
  const sensitiveKeys = [
    'authorization', 'Proxy_Authorization', 'API_KEY', 'apiKey', 'access_token',
    'Refresh-Token', 'TOKEN', 'secret', 'Password', 'PASSWD', 'cookie',
    'Set_Cookie', 'credential', 'private_key',
  ];
  const credentialSamples = [
    'Bearer bearer-value',
    'Basic dXNlcjpwYXNz',
    'sk-proj-1234567890',
    'ghp_1234567890abcdef',
    'xoxb-1234567890-secret',
    'AKIA1234567890ABCD',
    '-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----',
  ];

  it('redacts every locked sensitive key case-insensitively, including underscore variants', () => {
    const source = Object.fromEntries(sensitiveKeys.map((key, index) => [key, `value-${index}`]));
    source.nested = [{ safe: 'visible', API_KEY: 'nested-value' }];
    const redacted = redactSensitive(source);

    for (const key of sensitiveKeys) assert.equal(redacted[key], '[REDACTED]', key);
    assert.equal(redacted.nested[0].API_KEY, '[REDACTED]');
    assert.equal(redacted.nested[0].safe, 'visible');
  });

  it('redacts every locked credential shape in safe raw, readable, and live output', () => {
    const source = {
      ...Object.fromEntries(sensitiveKeys.map((key) => [key, 'sensitive-value'])),
      message: credentialSamples.join(' | '),
    };
    const safeRaw = serializeRawLine({
      line: JSON.stringify(source), sourceStream: 'stdout',
      timestamp: bridgeContext().receivedAt, mode: 'safe',
    });
    const envelope = completeEnvelope({
      event: 'message',
      summary: [
        ...sensitiveKeys.map((key) => `${key}=sensitive-value`),
        ...credentialSamples,
      ].join(' | '),
    }, bridgeContext());
    const readable = renderReadableEvent(envelope);
    const live = renderLiveEvent(envelope);

    for (const output of [safeRaw, readable, live]) {
      assert.ok(output.includes('[REDACTED]'));
      assert.doesNotMatch(output, /sensitive-value|bearer-value|dXNlcjpwYXNz|proj-123|ghp_|xoxb-|AKIA123|private-material/i);
    }
  });

  it('redacts complete authorization and multi-value cookie header values', () => {
    const headers = [
      'Authorization: Bearer header-secret',
      'Proxy_Authorization: Basic proxy-secret',
      'Cookie: session=cookie-secret; theme=dark',
      'Set-Cookie: refresh=refresh-secret; HttpOnly; SameSite=Lax',
    ].join('\n');
    const raw = serializeRawLine({
      line: headers, sourceStream: 'stderr', timestamp: bridgeContext().receivedAt, mode: 'safe',
    });
    const envelope = completeEnvelope({ event: 'message', summary: headers }, bridgeContext('stderr'));

    for (const output of [raw, renderReadableEvent(envelope), renderLiveEvent(envelope)]) {
      assert.doesNotMatch(output, /header-secret|proxy-secret|cookie-secret|theme=dark|refresh-secret|HttpOnly|SameSite/i);
      assert.match(output, /\[REDACTED\]/);
    }
  });

  it('preserves exact source text inside JSON escaping only in exact raw mode', () => {
    const original = '  {"message":"🫣\\n\\u001b[31m","token":"sk-exact-123456"}  ';
    const serialized = serializeRawLine({
      line: original, sourceStream: 'stderr', timestamp: bridgeContext().receivedAt, mode: 'exact',
    });
    assert.ok(serialized.endsWith('\n'));
    assert.deepEqual(JSON.parse(serialized), {
      timestamp: bridgeContext().receivedAt,
      sourceStream: 'stderr',
      line: original,
    });
    assert.ok(serialized.includes('sk-exact-123456'));

    const envelope = completeEnvelope({ event: 'message', summary: original }, bridgeContext('stderr'));
    assert.doesNotMatch(renderLiveEvent(envelope), /sk-exact-123456/);
    assert.doesNotMatch(renderReadableEvent(envelope), /sk-exact-123456/);
  });

  it('exposes exclusive POSIX raw-open options with mode 0600', () => {
    assert.deepEqual(RAW_OPEN_OPTIONS, { flags: 'wx', mode: 0o600 });
    assert.ok(Object.isFrozen(RAW_OPEN_OPTIONS));
  });
});

describe('envelope completion and curated rendering', () => {
  it('completes only deterministic conductor context and preserves source stream identity', () => {
    assert.deepEqual(completeEnvelope({ event: 'session.started', actor: null }, bridgeContext('stderr')), {
      schemaVersion: 1,
      timestamp: '2026-08-11T10:11:12.000Z',
      runId: 'run-123',
      phase: 'implement',
      attempt: 2,
      harness: 'claude',
      sessionId: null,
      actor: null,
      actorId: null,
      parentActorId: null,
      event: 'session.started',
      summary: null,
      metadata: { sourceStream: 'stderr' },
    });
  });

  it('strips ANSI/control characters, collapses whitespace, allowlists fields, and excludes reasoning', () => {
    const rendered = renderLiveEvent(completeEnvelope({
      sessionId: 'session-1',
      actor: 'agent',
      actorId: 'scripts-agent',
      event: 'tool.completed',
      summary: '\u001b[31mhello\u0000\n   world\u001b[0m',
      metadata: {
        toolName: 'Bash', exitCode: 0, status: 'ok', repoRelativePath: 'tests/example.test.mjs',
        command: 'must-not-render', arbitrary: 'must-not-render', reasoning: 'private-thought',
      },
    }, bridgeContext()));
    assert.match(rendered, /implement/);
    assert.match(rendered, /scripts-agent/);
    assert.match(rendered, /tool\.completed/);
    assert.match(rendered, /Bash/);
    assert.match(rendered, /hello world/);
    assert.match(rendered, /exit 0/);
    assert.match(rendered, /status ok/);
    assert.match(rendered, /tests\/example\.test\.mjs/);
    assert.doesNotMatch(rendered, /\u001b|31m|0m|must-not-render|private-thought/);
    assert.equal(renderReadableEvent({ event: 'reasoning', summary: 'never visible' }), null);
  });

  it('omits unsafe paths and caps a rendered line at 500 Unicode code points', () => {
    const long = renderLiveEvent(completeEnvelope({
      event: 'message', summary: '🫣'.repeat(700), metadata: { repoRelativePath: '/private/secret' },
    }, bridgeContext()));
    assert.equal(Array.from(long).length, 500);
    assert.doesNotMatch(long, /private\/secret/);
  });

  it('does not render token deltas one by one', () => {
    for (const event of ['token.delta', 'message.delta', 'content.delta']) {
      const envelope = completeEnvelope({ event, summary: 'fragment' }, bridgeContext());
      assert.equal(renderReadableEvent(envelope), null);
      assert.equal(renderLiveEvent(envelope), null);
    }
  });
});

describe('decoder/renderer degradation', () => {
  it('delivers a successfully decoded envelope only when the bridge explicitly accepts its raw line', () => {
    const delivered = [];
    const envelope = completeEnvelope({
      event: 'completed',
      sessionId: 'session-1',
      usage: { inputTokens: 7, scope: 'phase', attribution: 'session' },
    }, bridgeContext());
    const result = processEventLine({
      line: '{"type":"result"}', sourceStream: 'stdout', context: bridgeContext(),
      decoder: () => ({ disposition: 'decoded', envelope }),
    });

    assert.deepEqual(delivered, [], 'decoding alone must not run observational side effects');
    assert.equal(deliverDecodedEvent(result.envelope, (event) => delivered.push(event)), null);
    assert.deepEqual(delivered, [envelope]);
  });

  it('turns a decoded-event callback failure into non-blocking degradation', () => {
    const degradations = createDegradationTracker();
    const callback = () => { throw new Error('observational sink failed'); };
    const first = deliverDecodedEvent({ event: 'completed' }, callback, degradations);
    const second = deliverDecodedEvent({ event: 'completed' }, callback, degradations);

    assert.equal(first.capability, 'decodedEvent');
    assert.equal(first.reason, 'decoded-event-callback-error');
    assert.equal(second, null);
  });

  it('accepts a decoder callback, deduplicates by reason, and returns a sanitized plain fallback', () => {
    const degradations = createDegradationTracker();
    const decoder = () => { throw new Error('decoder unavailable'); };
    const first = processEventLine({
      line: 'Bearer secret-value', sourceStream: 'stdout', context: bridgeContext(),
      decoder, degradations,
    });
    const second = processEventLine({
      line: 'Bearer another-secret', sourceStream: 'stdout', context: bridgeContext(),
      decoder, degradations,
    });

    assert.equal(first.blockingError, null);
    assert.equal(first.degradation.event, 'observability.degraded');
    assert.equal(first.degradation.reason, 'decoder-error');
    assert.equal(second.degradation, null);
    assert.equal(first.readable, '[stdout] Bearer [REDACTED]');
    assert.doesNotMatch(first.readable, /secret-value/);
    assert.equal(first.readable, first.live);
    assert.ok(JSON.parse(first.raw).line.includes('[REDACTED]'));
  });

  it('degrades once on renderer failure and keeps a strict generic fallback', () => {
    const degradations = createDegradationTracker();
    const decoder = (line, context) => ({
      disposition: 'decoded', envelope: completeEnvelope({ event: 'message', summary: line }, context),
    });
    const renderer = () => { throw new Error('renderer unavailable'); };
    const first = processEventLine({
      line: 'Basic dXNlcjpwYXNz', sourceStream: 'stderr', context: bridgeContext('stderr'),
      decoder, renderer, degradations,
    });
    const second = processEventLine({
      line: 'plain fallback', sourceStream: 'stderr', context: bridgeContext('stderr'),
      decoder, renderer, degradations,
    });

    assert.equal(first.degradation.reason, 'renderer-error');
    assert.equal(second.degradation, null);
    assert.equal(first.live, '[stderr] structured event unavailable');
    assert.doesNotMatch(first.live, /dXNlcjpwYXNz/);
  });

  it('treats an invalid decoded envelope as a decoder degradation', () => {
    const result = processEventLine({
      line: 'safe fallback', sourceStream: 'stdout', context: bridgeContext(),
      decoder: () => ({ disposition: 'decoded', envelope: null }),
    });
    assert.equal(result.blockingError, null);
    assert.equal(result.degradation.reason, 'decoder-error');
    assert.equal(result.live, '[stdout] structured event unavailable');
  });

  it('never republishes reasoning or arbitrary metadata through structured fallback', () => {
    const reasoning = 'private chain of thought';
    const arbitrary = 'internal metadata value';
    const unknown = processEventLine({
      line: JSON.stringify({ type: 'future', reasoning, arbitrary }),
      sourceStream: 'stdout', context: bridgeContext(),
      decoder: (line) => ({ disposition: 'unknown', line, reason: 'unknown-event' }),
    });
    const malformed = processEventLine({
      line: `\u001b[31m{"reasoning":"${reasoning}","arbitrary":`,
      sourceStream: 'stderr', context: bridgeContext('stderr'),
      decoder: (line) => ({ disposition: 'malformed', line, reason: 'invalid-json' }),
    });
    const rendererError = processEventLine({
      line: JSON.stringify({ reasoning, arbitrary }),
      sourceStream: 'stdout', context: bridgeContext(),
      decoder: (_line, context) => ({
        disposition: 'decoded',
        envelope: completeEnvelope({
          event: 'message', summary: reasoning, metadata: { arbitrary },
        }, context),
      }),
      renderer: () => { throw new Error('renderer failed'); },
    });

    // Unknown valid-JSON events are preserved in raw and ignored by the curated
    // feed; only the one-time decoder degradation survives.
    assert.equal(unknown.readable, null);
    assert.equal(unknown.live, null);
    assert.equal(unknown.degradation.reason, 'unknown-event');
    assert.doesNotMatch(unknown.degradation.passthrough, /private chain|internal metadata|reasoning|arbitrary/i);

    for (const result of [malformed, rendererError]) {
      assert.match(result.live, /structured event unavailable/);
      assert.equal(result.live, result.readable);
      assert.doesNotMatch(result.live, /private chain|internal metadata|reasoning|arbitrary/i);
      assert.doesNotMatch(result.degradation.passthrough, /private chain|internal metadata|reasoning|arbitrary/i);
    }
  });

  it('keeps ignored plumbing events raw-only without readable, live, or degradation output', () => {
    const degradations = createDegradationTracker();
    const first = processEventLine({
      line: JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' }),
      sourceStream: 'stdout', context: bridgeContext(),
      decoder: (line) => ({ disposition: 'ignored', line, reason: 'lifecycle-plumbing' }),
      degradations,
    });
    const second = processEventLine({
      line: JSON.stringify({ type: 'system', subtype: 'hook_response', exit_code: 0 }),
      sourceStream: 'stdout', context: bridgeContext(),
      decoder: (line) => ({ disposition: 'ignored', line, reason: 'lifecycle-plumbing' }),
      degradations,
    });

    for (const result of [first, second]) {
      assert.ok(result.raw.includes('lifecycle-plumbing') === false);
      assert.ok(JSON.parse(result.raw).line.includes('hook_'));
      assert.equal(result.readable, null);
      assert.equal(result.live, null);
      assert.equal(result.envelope, null);
      assert.equal(result.degradation, null);
      assert.equal(result.blockingError, null);
    }
    assert.equal(degradations.size, 0);
  });

  it('duplicates an actionable plain stderr fallback with controls stripped, whitespace collapsed, secrets redacted, and a 500-code-point cap', () => {
    const result = processEventLine({
      line: `\u001b[31m[ERROR] request   failed\nBearer secret-value ${'x'.repeat(700)}`,
      sourceStream: 'stderr',
      context: bridgeContext('stderr'),
      decoder: (line) => ({ disposition: 'malformed', line, reason: 'invalid-json' }),
    });

    assert.match(result.live, /^\[stderr\] \[ERROR\] request failed Bearer \[REDACTED\] /);
    assert.equal(result.live, result.readable);
    assert.equal(Array.from(result.live).length, 500);
    assert.doesNotMatch(result.live, /secret-value|\u001b|\n/);
    assert.equal(result.degradation.passthrough, result.live);
  });

  it('classifies a serializer/redaction throw as blocking before any fallback is rendered', () => {
    const result = processEventLine({
      line: '{"message":"safe"}', sourceStream: 'stdout', context: bridgeContext(),
      decoder: () => ({ disposition: 'unknown', reason: 'unknown-event' }),
      serializer: () => { throw new Error('injected redaction failure'); },
    });

    assert.equal(result.raw, null);
    assert.equal(result.readable, null);
    assert.equal(result.live, null);
    assert.equal(result.blockingError.code, 'RAW_REDACTION_FAILED');
  });
});

describe('bounded multi-destination writing', () => {
  it('pauses on slow required destinations and resumes only after all drains', () => {
    const raw = new ControlledWritable([false]);
    const readable = new ControlledWritable([false]);
    const source = { pauses: 0, resumes: 0, pause() { this.pauses += 1; }, resume() { this.resumes += 1; } };
    const writer = new BoundedMultiDestinationWriter({
      destinations: [
        { name: 'raw', role: 'raw', stream: raw },
        { name: 'readable', role: 'readable', stream: readable },
      ],
    });

    const result = writer.write({ raw: 'raw\n', readable: 'readable\n' }, { source });
    assert.equal(result.ok, true);
    assert.equal(result.paused, true);
    assert.equal(source.pauses, 1);
    raw.emit('drain');
    assert.equal(source.resumes, 0);
    readable.emit('drain');
    assert.equal(source.resumes, 1);
  });

  it('enforces the 8 MiB aggregate pending-write bound as blocking', () => {
    assert.equal(PENDING_WRITE_LIMIT, 8 * 1024 * 1024);
    const raw = new ControlledWritable([false], { autoComplete: false });
    const source = { pause() {}, resume() {} };
    const writer = new BoundedMultiDestinationWriter({
      destinations: [{ name: 'raw', role: 'raw', stream: raw }],
      maxPendingBytes: 3,
    });
    const result = writer.write({ raw: 'four' }, { source });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'RAW_PENDING_WRITE_LIMIT');
    assert.equal(result.error.blocking, true);
  });

  it('counts every outstanding accepted write across destinations and sources', () => {
    const raw = new ControlledWritable([true, true], { autoComplete: false });
    const readable = new ControlledWritable([true, true], { autoComplete: false });
    const sourceA = { pauses: 0, resumes: 0, pause() { this.pauses += 1; }, resume() { this.resumes += 1; } };
    const sourceB = { pauses: 0, resumes: 0, pause() { this.pauses += 1; }, resume() { this.resumes += 1; } };
    const writer = new BoundedMultiDestinationWriter({
      destinations: [
        { name: 'raw', role: 'raw', stream: raw },
        { name: 'readable', role: 'readable', stream: readable },
      ],
      maxPendingBytes: 10,
    });

    const first = writer.write({ raw: 'aaa', readable: 'bbbb' }, { source: sourceA });
    assert.equal(first.ok, true);
    assert.equal(writer.pendingBytes, 7);
    assert.equal(sourceA.pauses, 0);

    const crossed = writer.write({ raw: 'cc', readable: 'dd' }, { source: sourceB });
    assert.equal(crossed.ok, false);
    assert.equal(crossed.error.code, 'RAW_PENDING_WRITE_LIMIT');
    assert.equal(writer.pendingBytes, 11);
    assert.equal(crossed.paused, true);
    assert.equal(sourceA.pauses, 1, 'a global blocking bound pauses every known source');
    assert.equal(sourceB.pauses, 1);

    raw.completeAll();
    readable.completeAll();
    assert.equal(writer.pendingBytes, 0);
    assert.equal(sourceB.resumes, 0, 'a blocking bound error must never resume ingestion');
  });

  it('classifies raw writes as blocking but readable failure as one non-blocking degradation', () => {
    const rawFailure = new ControlledWritable();
    rawFailure.failure = new Error('disk full');
    const rawWriter = new BoundedMultiDestinationWriter({
      destinations: [{ name: 'raw', role: 'raw', stream: rawFailure }],
    });
    const blocked = rawWriter.write({ raw: 'evidence\n' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'RAW_WRITE_FAILED');
    assert.equal(blocked.error.blocking, true);

    const raw = new ControlledWritable();
    const readable = new ControlledWritable();
    readable.failure = new Error('readable unavailable');
    const live = new ControlledWritable();
    const degradations = [];
    const writer = new BoundedMultiDestinationWriter({
      destinations: [
        { name: 'raw', role: 'raw', stream: raw },
        { name: 'readable', role: 'readable', stream: readable },
        { name: 'live', role: 'live', stream: live },
      ],
      onDegradation: (degradation) => degradations.push(degradation),
    });
    const degraded = writer.write({ raw: 'raw-1', readable: 'read-1', live: 'live-1' });
    assert.equal(degraded.ok, true);
    assert.equal(degraded.degradations.length, 1);
    writer.write({ raw: 'raw-2', readable: 'read-2', live: 'live-2' });
    assert.equal(degradations.length, 1);
    assert.deepEqual(raw.chunks, ['raw-1', 'raw-2']);
    assert.deepEqual(live.chunks, ['live-1', 'live-2']);
  });

  it('classifies raw open, drain, and bound failures as blocking bridge errors', () => {
    for (const [kind, code] of [
      ['raw-open', 'RAW_OPEN_FAILED'],
      ['raw-drain', 'RAW_DRAIN_FAILED'],
      ['pending-write-limit', 'RAW_PENDING_WRITE_LIMIT'],
      ['partial-line-limit', 'RAW_PARTIAL_LINE_LIMIT'],
    ]) {
      const failure = classifyBridgeFailure(kind, new Error(kind));
      assert.equal(failure.code, code);
      assert.equal(failure.blocking, true);
    }
  });

  it('turns a raw drain timeout into one blocking failure and never resumes after termination', () => {
    const raw = new ControlledWritable([false]);
    const source = { pauses: 0, resumes: 0, pause() { this.pauses += 1; }, resume() { this.resumes += 1; } };
    const timers = [];
    const blocking = [];
    const writer = new BoundedMultiDestinationWriter({
      destinations: [{ name: 'raw', role: 'raw', stream: raw }],
      drainTimeoutMs: 25,
      setTimer: (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => { timer.cleared = true; },
      onBlockingError: (error) => blocking.push(error),
    });

    const result = writer.write({ raw: 'evidence\n' }, { source });
    assert.equal(result.ok, true);
    assert.equal(source.pauses, 1);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 25);
    timers[0].callback();
    assert.equal(blocking.length, 1);
    assert.equal(blocking[0].code, 'RAW_DRAIN_FAILED');

    writer.terminate();
    raw.emit('drain');
    raw.emit('error', new Error('late raw error'));
    assert.equal(source.resumes, 0);
    assert.equal(blocking.length, 1, 'late drain/error must not settle the bridge twice');
  });

  it('degrades a readable drain timeout once, releases backpressure, and keeps raw writable', () => {
    const raw = new ControlledWritable([true, true]);
    const readable = new ControlledWritable([false]);
    const source = { pauses: 0, resumes: 0, pause() { this.pauses += 1; }, resume() { this.resumes += 1; } };
    let drainTimer;
    const degradations = [];
    const writer = new BoundedMultiDestinationWriter({
      destinations: [
        { name: 'raw', role: 'raw', stream: raw },
        { name: 'readable', role: 'readable', stream: readable },
      ],
      drainTimeoutMs: 25,
      setTimer: (callback) => { drainTimer = callback; return { id: 'drain' }; },
      clearTimer: () => {},
      onDegradation: (degradation) => degradations.push(degradation),
    });

    assert.equal(writer.write({ raw: 'raw-1', readable: 'read-1' }, { source }).ok, true);
    drainTimer();
    assert.equal(source.resumes, 1);
    assert.equal(degradations.length, 1);
    assert.equal(degradations[0].reason, 'readable-drain-error');
    assert.equal(writer.write({ raw: 'raw-2', readable: 'read-2' }, { source }).ok, true);
    assert.deepEqual(raw.chunks, ['raw-1', 'raw-2']);
    assert.deepEqual(readable.chunks, ['read-1']);
  });
});

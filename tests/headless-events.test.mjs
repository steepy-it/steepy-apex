import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeHeadlessEvent } from '../adapters/headless-events.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures', 'headless-events');
const context = (harness, sourceStream = 'stdout', providerVersion) => ({
  runId: 'run-123', phase: 'implement', attempt: 2, harness, sourceStream,
  receivedAt: '2026-08-11T10:00:00.000Z',
  ...(providerVersion === undefined ? {} : { providerVersion }),
});
const lines = (name) => readFileSync(join(fixtures, name), 'utf8').trim().split('\n');
const ACTOR_ENUM = new Set(['conductor', 'phase', 'agent', 'subagent', 'tool']);
function decoded(line, eventContext) {
  const result = decodeHeadlessEvent(line, eventContext);
  assert.equal(result.disposition, 'decoded');
  assert.equal(result.line, line);
  const expectedKeys = [
    'actor', 'actorId', 'attempt', 'event', 'harness', 'metadata', 'parentActorId',
    'phase', 'runId', 'schemaVersion', 'sessionId', 'summary', 'timestamp',
  ];
  if (result.envelope.usage !== undefined) expectedKeys.push('usage');
  assert.deepEqual(Object.keys(result.envelope).sort(), expectedKeys.sort());
  assert.equal(result.envelope.schemaVersion, 1);
  assert.equal(result.envelope.runId, 'run-123');
  assert.equal(result.envelope.phase, 'implement');
  assert.equal(result.envelope.attempt, 2);
  assert.equal(result.envelope.harness, eventContext.harness);
  assert.equal(result.envelope.timestamp, '2026-08-11T10:00:00.000Z');
  assert.equal(result.envelope.metadata.sourceStream, eventContext.sourceStream);
  if (result.envelope.actor !== null) {
    assert.equal(
      ACTOR_ENUM.has(result.envelope.actor),
      true,
      `v1 actor must use the common enum, got ${result.envelope.actor}`,
    );
  }
  return result.envelope;
}

describe('headless event decoder', () => {
  it('decodes Claude stream-json lifecycle, messages, tool calls, completion, failure, and explicit parentage', () => {
    const source = lines('claude.jsonl');
    assert.match(
      JSON.parse(source[5])._fixture_note,
      /synthetic.*actor-attribution/i,
      'the synthetic Claude actor usage evidence must identify itself as a fixture contract',
    );
    const init = decoded(source[0], context('claude'));
    assert.equal(init.event, 'session.started');
    assert.equal(init.sessionId, 'claude-session-123');
    const ordinaryMessage = decoded(source[1], context('claude'));
    assert.equal(ordinaryMessage.event, 'message');
    assert.equal(ordinaryMessage.summary, 'Starting the task.');
    assert.equal(ordinaryMessage.actor, 'phase');
    assert.equal(ordinaryMessage.actorId, null);
    assert.equal(ordinaryMessage.parentActorId, null);
    const forwarded = decoded(source[2], context('claude'));
    assert.equal(forwarded.actor, 'subagent');
    assert.equal(forwarded.actorId, 'claude-subagent-7');
    assert.equal(forwarded.parentActorId, null, 'a parent tool-use ID is not an actor ID');
    assert.equal(forwarded.metadata.parentToolUseId, 'tool-parent-42');
    assert.equal(forwarded.summary, 'Subagent update.');
    const toolStart = decoded(source[3], context('claude'));
    assert.equal(toolStart.event, 'tool.started');
    assert.equal(toolStart.actor, 'tool');
    assert.equal(toolStart.metadata.toolId, 'tool-1');
    assert.equal(toolStart.metadata.toolName, 'Bash');
    const toolEnd = decoded(source[4], context('claude'));
    assert.equal(toolEnd.event, 'tool.completed');
    assert.equal(toolEnd.actor, 'tool');
    assert.equal(toolEnd.metadata.toolId, 'tool-1');
    const completion = decoded(source[5], context('claude'));
    assert.equal(completion.event, 'completed');
    assert.equal(completion.actor, 'subagent');
    assert.equal(completion.actorId, 'claude-subagent-7');
    assert.deepEqual(completion.usage, {
      // Claude result.usage.input_tokens -> inputTokens
      inputTokens: 120,
      // Claude result.usage.cache_read_input_tokens -> cacheReadTokens
      cacheReadTokens: 0,
      // Claude result.usage.cache_creation_input_tokens -> cacheWriteTokens
      cacheWriteTokens: 4,
      // Claude result.usage.output_tokens -> outputTokens
      outputTokens: 32,
      // Claude result.total_cost_usd -> cost; no currency is inferred from the name.
      cost: 0.0125,
      // Claude result.num_turns -> turns
      turns: 3,
    });
    assert.deepEqual(completion.metadata.observationScope, {
      kind: 'actor', actorId: 'claude-subagent-7',
    });
    assert.match(completion.metadata.observationFingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.equal(Object.hasOwn(completion.metadata, 'measurementId'), false);
    assert.equal(Object.hasOwn(completion.metadata, 'measurementScope'), false);
    assert.equal(decoded(source[6], context('claude')).event, 'failed');
  });

  it('decodes one tool.started per assistant message but carries the parallel tool_use block count', () => {
    const parallel = decodeHeadlessEvent(
      JSON.stringify({
        type: 'assistant',
        session_id: 'claude-session-123',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} },
            { type: 'tool_use', id: 'tool-2', name: 'Read', input: {} },
          ],
        },
      }),
      context('claude'),
    );
    assert.equal(parallel.disposition, 'decoded');
    assert.equal(parallel.envelope.event, 'tool.started');
    assert.equal(parallel.envelope.metadata.toolId, 'tool-1', 'id/name stay the first block\'s');
    assert.equal(parallel.envelope.metadata.toolName, 'Bash');
    assert.equal(parallel.envelope.metadata.toolUseCount, 2, 'a volume reader counts calls, not messages');

    const single = decodeHeadlessEvent(
      JSON.stringify({
        type: 'assistant',
        session_id: 'claude-session-123',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }] },
      }),
      context('claude'),
    );
    assert.equal(single.envelope.metadata.toolUseCount, 1);
  });

  it('decodes Codex JSONL session, message, tool, completion and failure events without curating reasoning', () => {
    const source = lines('codex.jsonl');
    assert.equal(decoded(source[0], context('codex')).sessionId, 'codex-thread-123');
    assert.equal(decoded(source[1], context('codex')).summary, 'Starting the task.');
    assert.equal(decoded(source[1], context('codex')).actor, 'phase');
    const toolStart = decoded(source[2], context('codex'));
    assert.equal(toolStart.event, 'tool.started');
    assert.equal(toolStart.actor, 'tool');
    const toolEnd = decoded(source[3], context('codex'));
    assert.equal(toolEnd.event, 'tool.completed');
    assert.equal(toolEnd.actor, 'tool');
    assert.equal(toolEnd.metadata.exitCode, 0);
    const reasoning = decoded(source[4], context('codex'));
    assert.equal(reasoning.event, 'reasoning');
    assert.equal(reasoning.summary, null);
    const completion = decoded(source[5], context('codex'));
    assert.equal(completion.event, 'completed');
    assert.deepEqual(completion.usage, {
      // Codex turn.completed.usage.input_tokens -> inputTokens
      inputTokens: 10,
      // Codex turn.completed.usage.cached_input_tokens -> cacheReadTokens
      cacheReadTokens: 0,
      // Codex turn.completed.usage.output_tokens -> outputTokens
      outputTokens: 5,
      // Codex turn.completed.usage.reasoning_tokens -> reasoningTokens
      reasoningTokens: 0,
      // Codex turn.completed.usage.total_tokens -> totalTokens (not calculated).
      totalTokens: 15,
    });
    assert.deepEqual(completion.metadata.observationScope, {
      kind: 'session', sessionId: 'codex-thread-123',
    });
    assert.equal(Object.hasOwn(completion.metadata, 'measurementScope'), false);
    assert.equal(decoded(source[6], context('codex')).event, 'failed');
  });

  it('decodes each OpenCode step-finish as a provider-step measurement with distinct retransmission identity', () => {
    const source = lines('opencode.jsonl');
    const opencodeContext = context('opencode', 'stdout', '1.18.27');
    const ignoredStart = decodeHeadlessEvent(source[0], opencodeContext);
    assert.equal(ignoredStart.disposition, 'ignored');
    assert.equal(ignoredStart.reason, 'step-start-plumbing');
    const message = decoded(source[1], opencodeContext);
    assert.equal(message.event, 'message');
    assert.equal(message.sessionId, 'ses_fe6236a6cffeBOqLQUbgNWcjZI');
    assert.equal(message.summary, 'Starting the task.');
    assert.equal(message.actor, 'phase');
    const toolEnd = decoded(source[2], opencodeContext);
    assert.equal(toolEnd.event, 'tool.completed');
    assert.equal(toolEnd.actor, 'tool');
    assert.equal(toolEnd.metadata.toolName, 'bash');
    assert.equal(toolEnd.metadata.toolId, 'call_00_YhZaxNN9SOXjaqESF8Wn3374');
    assert.equal(toolEnd.metadata.status, 'completed');
    const toolFailed = decoded(source[3], opencodeContext);
    assert.equal(toolFailed.event, 'tool.failed');
    assert.equal(toolFailed.actor, 'tool');
    assert.equal(toolFailed.metadata.toolName, 'edit');
    assert.equal(toolFailed.metadata.status, 'error');
    const firstStep = decoded(source[4], opencodeContext);
    assert.equal(firstStep.event, 'usage.observed');
    assert.deepEqual(firstStep.usage, {
      inputTokens: 7515,
      outputTokens: 115,
      reasoningTokens: 89,
      cacheReadTokens: 2304,
      cacheWriteTokens: 0,
      totalTokens: 10023,
      cost: 0.0011156712,
    });
    const completion = decoded(source[5], opencodeContext);
    assert.equal(completion.event, 'completed');
    assert.deepEqual(completion.usage, {
      inputTokens: 227,
      outputTokens: 294,
      reasoningTokens: 0,
      cacheReadTokens: 236416,
      cacheWriteTokens: 0,
      totalTokens: 236937,
      cost: 0.0007760648,
    });
    assert.notEqual(firstStep.metadata.observationFingerprint, completion.metadata.observationFingerprint);
    for (const [event, part] of [[firstStep, JSON.parse(source[4]).part], [completion, JSON.parse(source[5]).part]]) {
      assert.equal(
        event.metadata.measurementId,
        `opencode:step:${part.sessionID}:${part.messageID}:${part.id}`,
      );
      assert.deepEqual(event.metadata.measurementScope, {
        provider: 'opencode',
        kind: 'step',
        sessionId: part.sessionID,
        messageId: part.messageID,
        partId: part.id,
      });
      assert.deepEqual(event.metadata.observationScope, {
        kind: 'session', sessionId: part.sessionID,
      });
      assert.equal(event.metadata.providerVersion, '1.18.27');
    }
    assert.equal(decoded(source[6], opencodeContext).event, 'failed');
  });

  it('keeps unversioned and mismatched OpenCode usage as observations without additive scope', () => {
    const line = lines('opencode.jsonl')[4];
    const missing = decoded(line, context('opencode'));
    const mismatched = decoded(line, context('opencode', 'stdout', '1.18.26'));

    for (const event of [missing, mismatched]) {
      assert.equal(event.event, 'usage.observed');
      assert.ok(event.usage.inputTokens > 0);
      assert.equal(Object.hasOwn(event.metadata, 'measurementId'), false);
      assert.equal(Object.hasOwn(event.metadata, 'measurementScope'), false);
    }
    assert.equal(Object.hasOwn(missing.metadata, 'providerVersion'), false);
    assert.equal(mismatched.metadata.providerVersion, '1.18.26');
  });

  it('identifies intermediate OpenCode observations even when the provider supplies no usage', () => {
    const event = decoded(JSON.stringify({
      type: 'step_finish', sessionID: 'ses-no-usage',
      part: { type: 'step-finish', reason: 'tool-calls', sessionID: 'ses-no-usage', messageID: 'msg-1', id: 'prt-1' },
    }), context('opencode', 'stdout', '1.18.27'));
    assert.equal(event.event, 'usage.observed');
    assert.equal(Object.hasOwn(event, 'usage'), false);
    assert.match(event.metadata.observationFingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(event.metadata.observationScope, { kind: 'session', sessionId: 'ses-no-usage' });
  });

  it('identifies an OpenCode completion observation even when the provider supplies no usage', () => {
    const line = JSON.stringify({
      type: 'step_finish',
      sessionID: 'ses-no-usage',
      part: { type: 'step-finish', reason: 'stop', sessionID: 'ses-no-usage' },
    });
    const completion = decoded(line, context('opencode', 'stdout', '1.18.27'));

    assert.equal(completion.event, 'completed');
    assert.equal(Object.hasOwn(completion, 'usage'), false);
    assert.match(completion.metadata.observationFingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(completion.metadata.observationScope, {
      kind: 'session', sessionId: 'ses-no-usage',
    });
  });

  it('preserves unknown valid JSON for fallback and classifies malformed structured lines', () => {
    const unknownLine = '{"type":"future.event","session_id":"future-session"}';
    const unknown = decodeHeadlessEvent(unknownLine, context('claude', 'stderr'));
    assert.equal(unknown.disposition, 'unknown');
    assert.equal(unknown.line, unknownLine);
    assert.deepEqual(unknown.parsed, JSON.parse(unknownLine));
    assert.equal(unknown.reason, 'unknown-event');
    const malformedLine = '{"type":';
    const malformed = decodeHeadlessEvent(malformedLine, context('claude'));
    assert.equal(malformed.disposition, 'malformed');
    assert.equal(malformed.line, malformedLine);
    assert.equal(malformed.reason, 'invalid-json');
  });

  it('classifies Claude thinking-token deltas as reasoning and hook plumbing as ignored', () => {
    const thinking = decodeHeadlessEvent(
      JSON.stringify({ type: 'system', subtype: 'thinking_tokens', session_id: 'claude-session-123', estimated_tokens: 50 }),
      context('claude'),
    );
    assert.equal(thinking.disposition, 'decoded');
    assert.equal(thinking.envelope.event, 'reasoning');
    assert.equal(thinking.envelope.sessionId, 'claude-session-123');
    assert.equal(thinking.envelope.summary, null);

    for (const subtype of ['hook_started', 'hook_response']) {
      const hook = decodeHeadlessEvent(
        JSON.stringify({ type: 'system', subtype, hook_name: 'SessionStart:startup', session_id: 'claude-session-123' }),
        context('claude'),
      );
      assert.equal(hook.disposition, 'ignored', `${subtype} must be classified as ignored`);
      assert.equal(hook.reason, 'lifecycle-plumbing');
    }
  });

  it('decodes Claude task events into agent.started / agent.completed / agent.failed and keeps progress/updated as plumbing', () => {
    const source = lines('claude.jsonl');
    const started = decoded(source[7], context('claude'));
    assert.equal(started.event, 'agent.started');
    assert.equal(started.actor, 'subagent');
    assert.equal(started.actorId, 'bash');
    assert.equal(started.summary, 'run the test suite');
    assert.equal(started.metadata.taskId, 'task-1');
    assert.equal(started.metadata.parentToolUseId, 'tool-task-1');

    const completed = decoded(source[8], context('claude'));
    assert.equal(completed.event, 'agent.completed');
    assert.equal(completed.actor, 'subagent');
    assert.equal(completed.actorId, 'bash');
    assert.equal(completed.metadata.status, 'completed');
    assert.equal(completed.metadata.taskId, 'task-1');
    assert.equal(completed.metadata.parentToolUseId, 'tool-task-1');
    assert.equal(completed.summary, 'tests pass');

    const failed = decoded(source[9], context('claude'));
    assert.equal(failed.event, 'agent.failed');
    assert.equal(failed.actor, 'subagent');
    assert.equal(failed.metadata.status, 'error');

    for (const envelope of [started, completed, failed]) {
      assert.notEqual(
        envelope.event,
        'completed',
        'a task-event envelope must never be the bare completed event, or the usage observer would falsely report missing-usage',
      );
    }

    const progress = decodeHeadlessEvent(source[10], context('claude'));
    assert.equal(progress.disposition, 'ignored');
    assert.equal(progress.reason, 'task-progress-plumbing');
    assert.equal(progress.envelope, undefined);

    const updated = decodeHeadlessEvent(source[11], context('claude'));
    assert.equal(updated.disposition, 'ignored');
    assert.equal(updated.reason, 'task-updated-plumbing');
    assert.equal(updated.envelope, undefined);
  });

  it('treats non-terminal Claude task_notification and OpenCode tool_use statuses as ignored, never forcing failed/completed', () => {
    const runningTask = decodeHeadlessEvent(
      JSON.stringify({
        type: 'system',
        subtype: 'task_notification',
        session_id: 'claude-session-123',
        status: 'running',
        task_id: 'task-3',
        subagent_type: 'bash',
        tool_use_id: 'tool-task-3',
      }),
      context('claude'),
    );
    assert.equal(runningTask.disposition, 'ignored');
    assert.equal(runningTask.envelope, undefined);

    const pendingTool = decodeHeadlessEvent(
      JSON.stringify({
        type: 'tool_use',
        timestamp: 1787140285021,
        sessionID: 'ses_fe6236a6cffeBOqLQUbgNWcjZI',
        part: {
          type: 'tool',
          tool: 'bash',
          callID: 'call_00_pending',
          state: { status: 'pending', input: { command: 'npm test' } },
        },
      }),
      context('opencode'),
    );
    assert.equal(pendingTool.disposition, 'ignored');
    assert.equal(pendingTool.envelope, undefined);
  });

  it('never fabricates agent or subagent hierarchy from ordinary assistant messages', () => {
    const envelope = decoded(lines('claude.jsonl')[1], context('claude'));
    assert.equal(envelope.actor, 'phase');
    assert.equal(envelope.actorId, null);
    assert.equal(envelope.parentActorId, null);
  });

  it('keeps only valid partial usage and preserves zero rather than coercing malformed values', () => {
    const completion = decoded(lines('codex.jsonl')[7], context('codex'));
    assert.equal(completion.event, 'completed');
    assert.deepEqual(completion.usage, {
      // Codex turn.completed.usage.input_tokens -> inputTokens; zero is reported source data.
      inputTokens: 0,
    });
    assert.deepEqual(completion.metadata.observationScope, {
      kind: 'session', sessionId: 'codex-thread-123',
    });
  });
});

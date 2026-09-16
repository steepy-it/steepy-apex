import { StringDecoder } from 'node:string_decoder';

export const PARTIAL_LINE_LIMIT = 1024 * 1024;
export const PENDING_WRITE_LIMIT = 8 * 1024 * 1024;
export const DRAIN_TIMEOUT_MS = 5000;
export const RAW_OPEN_OPTIONS = Object.freeze({ flags: 'wx', mode: 0o600 });

const REDACTED = '[REDACTED]';
const NO_SOURCE = Symbol('no-source');
const SENSITIVE_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'token',
  'secret',
  'password',
  'passwd',
  'cookie',
  'setcookie',
  'credential',
  'privatekey',
]);

const FAILURE_CODES = Object.freeze({
  'raw-open': 'RAW_OPEN_FAILED',
  'raw-write': 'RAW_WRITE_FAILED',
  'raw-drain': 'RAW_DRAIN_FAILED',
  'pending-write-limit': 'RAW_PENDING_WRITE_LIMIT',
  'partial-line-limit': 'RAW_PARTIAL_LINE_LIMIT',
  'safe-redaction': 'RAW_REDACTION_FAILED',
});

export class BridgeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BridgeError';
    this.code = code;
    this.blocking = options.blocking ?? true;
    this.details = options.details ?? null;
  }
}

export function classifyBridgeFailure(kind, cause, details = null) {
  const code = FAILURE_CODES[kind] ?? 'BRIDGE_FAILURE';
  const message = cause instanceof Error ? cause.message : String(cause ?? kind);
  return new BridgeError(code, `${kind}: ${message}`, { cause, details, blocking: true });
}

function byteLength(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : value ?? '');
}

export class LineFramer {
  constructor({ sourceStream, maxPartialBytes = PARTIAL_LINE_LIMIT } = {}) {
    if (!sourceStream) throw new TypeError('sourceStream is required');
    if (!Number.isSafeInteger(maxPartialBytes) || maxPartialBytes < 1) {
      throw new TypeError('maxPartialBytes must be a positive safe integer');
    }
    this.sourceStream = sourceStream;
    this.maxPartialBytes = maxPartialBytes;
    this.decoder = new StringDecoder('utf8');
    this.partial = '';
    this.ended = false;
  }

  push(chunk) {
    if (this.ended) throw new Error('cannot push after end');
    const decoded = Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk)
      ? this.decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      : String(chunk);
    return this.#accept(decoded);
  }

  end(chunk) {
    if (this.ended) return [];
    const framed = chunk === undefined ? [] : this.push(chunk);
    this.ended = true;
    framed.push(...this.#accept(this.decoder.end()));
    if (this.partial.length > 0) {
      this.#checkBound(this.partial);
      framed.push({ sourceStream: this.sourceStream, line: this.partial });
      this.partial = '';
    }
    return framed;
  }

  #accept(text) {
    if (!text) return [];
    this.partial += text;
    const framed = [];
    let newline = this.partial.indexOf('\n');
    while (newline !== -1) {
      let line = this.partial.slice(0, newline);
      this.#checkBound(line);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      framed.push({ sourceStream: this.sourceStream, line });
      this.partial = this.partial.slice(newline + 1);
      newline = this.partial.indexOf('\n');
    }
    this.#checkBound(this.partial);
    return framed;
  }

  #checkBound(value) {
    if (byteLength(value) <= this.maxPartialBytes) return;
    throw classifyBridgeFailure('partial-line-limit', new Error(
      `partial ${this.sourceStream} line exceeds ${this.maxPartialBytes} bytes`,
    ), { sourceStream: this.sourceStream, maxPartialBytes: this.maxPartialBytes });
  }
}

function normalizedKey(key) {
  return String(key).toLowerCase().replaceAll('-', '').replaceAll('_', '');
}

function sensitiveKey(key) {
  return SENSITIVE_KEYS.has(normalizedKey(key));
}

function redactText(text) {
  let value = String(text);
  value = value.replace(
    /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi,
    REDACTED,
  );
  value = value.replace(
    /\b((?:proxy[-_]?authorization|authorization|set[-_]?cookie|cookie)\s*:\s*)[^\r\n]*/gi,
    `$1${REDACTED}`,
  );
  value = value.replace(
    /((?:"|')?([A-Za-z][A-Za-z0-9_-]*)(?:"|')?\s*[:=]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;|}]+)/g,
    (match, prefix, key) => sensitiveKey(key) ? `${prefix}${REDACTED}` : match,
  );
  value = value.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`);
  value = value.replace(/\bsk-[A-Za-z0-9_-]{6,}/gi, REDACTED);
  value = value.replace(/\bgh[pousr]_[A-Za-z0-9]{6,}/gi, REDACTED);
  value = value.replace(/\bxox[baprs]-[A-Za-z0-9-]{6,}/gi, REDACTED);
  value = value.replace(/\bAKIA[A-Z0-9]{12,}\b/g, REDACTED);
  return value;
}

export function redactSensitive(value, seen = new WeakMap()) {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);

  const output = Array.isArray(value) ? [] : {};
  seen.set(value, output);
  if (Array.isArray(value)) {
    for (const item of value) output.push(redactSensitive(item, seen));
    return output;
  }
  for (const [key, item] of Object.entries(value)) {
    output[key] = sensitiveKey(key) ? REDACTED : redactSensitive(item, seen);
  }
  return output;
}

function safeSourceLine(line) {
  try {
    return JSON.stringify(redactSensitive(JSON.parse(line)));
  } catch (error) {
    if (error instanceof SyntaxError) return redactText(line);
    throw error;
  }
}

export function serializeRawLine({ line, sourceStream, timestamp, mode = 'safe' }) {
  if (!['safe', 'exact'].includes(mode)) throw new TypeError(`unsupported log mode: ${mode}`);
  const content = mode === 'exact' ? String(line) : safeSourceLine(String(line));
  return `${JSON.stringify({ timestamp, sourceStream, line: content })}\n`;
}

export function completeEnvelope(event, context = {}) {
  const source = event?.disposition === 'decoded' ? event.envelope : event;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('event envelope must be an object');
  }
  const metadata = source.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata)
    ? { ...source.metadata }
    : {};
  const sourceStream = context.sourceStream ?? metadata.sourceStream;
  if (sourceStream !== undefined) metadata.sourceStream = sourceStream;

  const usage = source.usage && typeof source.usage === 'object' && !Array.isArray(source.usage)
    ? { ...source.usage }
    : null;
  return {
    schemaVersion: source.schemaVersion ?? 1,
    timestamp: source.timestamp ?? context.receivedAt ?? null,
    runId: source.runId ?? context.runId ?? null,
    phase: source.phase ?? context.phase ?? null,
    attempt: source.attempt ?? context.attempt ?? null,
    harness: source.harness ?? context.harness ?? null,
    sessionId: source.sessionId ?? null,
    actor: source.actor ?? null,
    actorId: source.actorId ?? null,
    parentActorId: source.parentActorId ?? null,
    event: source.event ?? null,
    summary: source.summary ?? null,
    metadata,
    ...(usage === null ? {} : { usage }),
  };
}

function stripAnsiAndControls(value) {
  return String(value)
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

function curatedText(value) {
  return stripAnsiAndControls(redactText(value)).replace(/\s+/gu, ' ').trim();
}

function capCodePoints(value, limit = 500) {
  const points = Array.from(value);
  return points.length <= limit ? value : points.slice(0, limit).join('');
}

function repoRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return null;
  if (normalized.split('/').includes('..')) return null;
  return curatedText(normalized);
}

function renderCuratedEvent(envelope) {
  if (!envelope || typeof envelope !== 'object') throw new TypeError('envelope must be an object');
  const event = curatedText(envelope.event ?? 'event');
  if (/reasoning/i.test(event) || /(?:token|text|message|content).*delta$/i.test(event)) return null;

  const parts = [];
  const metadata = envelope.metadata && typeof envelope.metadata === 'object' ? envelope.metadata : {};
  if (['stdout', 'stderr'].includes(metadata.sourceStream)) parts.push(`[${metadata.sourceStream}]`);
  if (typeof envelope.timestamp === 'string' && envelope.timestamp.length >= 19) {
    parts.push(`[${curatedText(envelope.timestamp.slice(11, 19))}]`);
  }
  if (envelope.phase !== null && envelope.phase !== undefined) parts.push(curatedText(envelope.phase));
  if (envelope.attempt !== null && envelope.attempt !== undefined) parts.push(`attempt ${curatedText(envelope.attempt)}`);
  if (envelope.sessionId) parts.push(`session ${curatedText(envelope.sessionId)}`);
  if (envelope.actorId) parts.push(`${curatedText(envelope.actor ?? 'actor')} ${curatedText(envelope.actorId)}`);
  else if (envelope.actor) parts.push(curatedText(envelope.actor));
  parts.push(event);

  if (metadata.toolName !== null && metadata.toolName !== undefined) {
    parts.push(`tool ${curatedText(metadata.toolName)}`);
  }
  if (envelope.summary !== null && envelope.summary !== undefined) parts.push(curatedText(envelope.summary));
  if (metadata.exitCode !== null && metadata.exitCode !== undefined) {
    parts.push(`exit ${curatedText(metadata.exitCode)}`);
  }
  if (metadata.status !== null && metadata.status !== undefined) {
    parts.push(`status ${curatedText(metadata.status)}`);
  }
  const path = repoRelativePath(metadata.repoRelativePath ?? metadata.path);
  if (path) parts.push(path);
  return capCodePoints(parts.filter(Boolean).join(' · '));
}

export function renderReadableEvent(envelope) {
  return renderCuratedEvent(envelope);
}

export function renderLiveEvent(envelope) {
  return renderCuratedEvent(envelope);
}

export function createDegradationTracker() {
  const emitted = new Set();
  return Object.freeze({
    record(capability, reason, passthrough = null) {
      const key = `${String(capability)}:${String(reason)}`;
      if (emitted.has(key)) return null;
      emitted.add(key);
      return {
        key,
        event: 'observability.degraded',
        capability: curatedText(capability),
        reason: curatedText(reason),
        passthrough: passthrough === null ? null : capCodePoints(curatedText(passthrough)),
      };
    },
    has(capability, reason) {
      return emitted.has(`${String(capability)}:${String(reason)}`);
    },
    get size() {
      return emitted.size;
    },
  });
}

// Called by the bridge only after its required raw destination has accepted the
// source line. Decoding stays side-effect free; failures in an observational
// consumer degrade instead of escaping into process-lifetime ownership.
export function deliverDecodedEvent(
  envelope,
  callback,
  degradations = createDegradationTracker(),
) {
  if (!envelope || typeof callback !== 'function') return null;
  try {
    callback(envelope);
    return null;
  } catch {
    return degradations.record('decodedEvent', 'decoded-event-callback-error');
  }
}

function structuredFallback(sourceStream) {
  const stream = ['stdout', 'stderr'].includes(sourceStream) ? sourceStream : 'stream';
  return `[${stream}] structured event unavailable`;
}

function sanitizedPlainFallback(line, sourceStream) {
  const fallback = structuredFallback(sourceStream);
  const text = String(line ?? '');
  // JSON-looking failures stay generic: a partial or future structured event can
  // carry reasoning or arbitrary metadata that the curated renderer never allows.
  const shape = stripAnsiAndControls(text).trimStart();
  if (/^\{|^\[\s*[\[{"']/u.test(shape)) return fallback;
  const sanitized = curatedText(text);
  if (!sanitized) return fallback;
  const stream = ['stdout', 'stderr'].includes(sourceStream) ? sourceStream : 'stream';
  return capCodePoints(`[${stream}] ${sanitized}`);
}

export function processEventLine({
  line,
  sourceStream,
  context,
  decoder,
  mode = 'safe',
  renderer = renderReadableEvent,
  serializer = serializeRawLine,
  degradations = createDegradationTracker(),
}) {
  const eventContext = { ...context, sourceStream };
  let raw;
  try {
    raw = serializer({
      line,
      sourceStream,
      timestamp: eventContext.receivedAt,
      mode,
    });
  } catch (cause) {
    return {
      raw: null,
      readable: null,
      live: null,
      envelope: null,
      degradation: null,
      blockingError: classifyBridgeFailure('safe-redaction', cause, { sourceStream }),
    };
  }

  const fallback = structuredFallback(sourceStream);
  const plainFallback = sanitizedPlainFallback(line, sourceStream);
  let decoded;
  try {
    decoded = decoder(line, eventContext);
  } catch {
    return {
      raw,
      readable: plainFallback,
      live: plainFallback,
      envelope: null,
      degradation: degradations.record('decoder', 'decoder-error', plainFallback),
      blockingError: null,
    };
  }

  if (!decoded || decoded.disposition !== 'decoded') {
    const reason = decoded?.reason ?? 'decoder-empty-result';
    const disposition = decoded?.disposition ?? null;
    if (disposition === 'ignored') {
      return {
        raw,
        readable: null,
        live: null,
        envelope: null,
        degradation: null,
        blockingError: null,
      };
    }
    const isMalformed = disposition === 'malformed';
    // Malformed (non-JSON) lines keep a sanitized plain duplication as the
    // actionable fallback. Valid JSON the decoder does not recognize is preserved
    // in raw and ignored by the curated feed per the observability contract; the
    // one-time decoder degradation names the raw capture as the diagnosis source.
    const isUnknown = disposition === 'unknown';
    const passthrough = isMalformed ? plainFallback : (isUnknown ? null : fallback);
    return {
      raw,
      readable: passthrough,
      live: passthrough,
      envelope: null,
      degradation: degradations.record('decoder', reason, isMalformed ? plainFallback : fallback),
      blockingError: null,
    };
  }

  let envelope;
  try {
    envelope = completeEnvelope(decoded.envelope, eventContext);
  } catch {
    return {
      raw,
      readable: fallback,
      live: fallback,
      envelope: null,
      degradation: degradations.record('decoder', 'decoder-error', fallback),
      blockingError: null,
    };
  }
  try {
    const rendered = renderer(envelope);
    return {
      raw,
      readable: rendered,
      live: rendered,
      envelope,
      degradation: null,
      blockingError: null,
    };
  } catch {
    return {
      raw,
      readable: fallback,
      live: fallback,
      envelope,
      degradation: degradations.record('renderer', 'renderer-error', fallback),
      blockingError: null,
    };
  }
}

export class BoundedMultiDestinationWriter {
  constructor({
    destinations,
    maxPendingBytes = PENDING_WRITE_LIMIT,
    drainTimeoutMs = DRAIN_TIMEOUT_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onBlockingError = () => {},
    onDegradation = () => {},
  } = {}) {
    if (!Array.isArray(destinations) || destinations.length === 0) {
      throw new TypeError('at least one destination is required');
    }
    if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < 1) {
      throw new TypeError('maxPendingBytes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 1) {
      throw new TypeError('drainTimeoutMs must be a positive safe integer');
    }
    if (typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
      throw new TypeError('setTimer and clearTimer must be functions');
    }
    this.destinations = new Map();
    this.maxPendingBytes = maxPendingBytes;
    this.drainTimeoutMs = drainTimeoutMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onBlockingError = onBlockingError;
    this.onDegradation = onDegradation;
    this.degradations = createDegradationTracker();
    this.blockedByDestination = new Map();
    this.sourceBlocks = new Map();
    this.sources = new Set();
    this.blockingPausedSources = new Set();
    this.drainTimers = new Map();
    this.pendingBytes = 0;
    this.blockingError = null;
    this.terminated = false;

    for (const destination of destinations) {
      if (!destination?.name || !destination.stream || typeof destination.stream.write !== 'function') {
        throw new TypeError('each destination requires a name and writable stream');
      }
      if (this.destinations.has(destination.name)) throw new TypeError(`duplicate destination: ${destination.name}`);
      const state = {
        name: destination.name,
        role: destination.role ?? destination.name,
        required: destination.required ?? true,
        stream: destination.stream,
        active: true,
      };
      this.destinations.set(state.name, state);
      if (typeof state.stream.on === 'function') {
        state.stream.on('drain', () => this.#drain(state));
        state.stream.on('error', (cause) => {
          const operation = this.blockedByDestination.has(state.name) ? 'drain' : 'write';
          this.#destinationFailure(state, operation, cause);
        });
      }
    }
  }

  write(chunks, { source = null } = {}) {
    if (this.blockingError || this.terminated) {
      return { ok: false, paused: this.#sourcePaused(source), degradations: [], error: this.blockingError };
    }
    if (source) this.sources.add(source);
    const emitted = [];
    for (const destination of this.destinations.values()) {
      if (!destination.active || !Object.hasOwn(chunks, destination.name)) continue;
      const chunk = chunks[destination.name];
      const sourceKey = source ?? NO_SOURCE;
      const alreadyBlocked = this.blockedByDestination.get(destination.name)?.has(sourceKey) ?? false;
      const bytes = byteLength(chunk);
      this.pendingBytes += bytes;
      let settled = false;
      let callbackFailure = null;
      const complete = (cause = null) => {
        if (settled) return;
        settled = true;
        this.pendingBytes = Math.max(0, this.pendingBytes - bytes);
        if (!cause) return;
        callbackFailure = this.#destinationFailure(destination, 'write', cause);
        if (callbackFailure && !(callbackFailure instanceof BridgeError)) emitted.push(callbackFailure);
      };
      let accepted;
      try {
        accepted = destination.stream.write(chunk, complete);
      } catch (cause) {
        complete();
        const failure = this.#destinationFailure(destination, 'write', cause);
        if (failure instanceof BridgeError) {
          return { ok: false, paused: this.#sourcePaused(source), degradations: emitted, error: failure };
        }
        if (failure) emitted.push(failure);
        continue;
      }

      if (callbackFailure instanceof BridgeError) {
        return { ok: false, paused: this.#sourcePaused(source), degradations: emitted, error: callbackFailure };
      }
      if (!destination.active) continue;

      if (destination.required && (accepted === false || alreadyBlocked)) {
        this.#block(destination, sourceKey, source);
      }
      if (this.pendingBytes > this.maxPendingBytes) {
        const error = classifyBridgeFailure('pending-write-limit', new Error(
          `pending writes exceed ${this.maxPendingBytes} bytes`,
        ), { maxPendingBytes: this.maxPendingBytes, pendingBytes: this.pendingBytes });
        this.#setBlockingError(error);
        return { ok: false, paused: this.#sourcePaused(source), degradations: emitted, error };
      }
    }
    return { ok: true, paused: this.#sourcePaused(source), degradations: emitted, error: null };
  }

  failDrain(destinationName, cause) {
    const destination = this.destinations.get(destinationName);
    if (!destination) throw new TypeError(`unknown destination: ${destinationName}`);
    return this.#destinationFailure(destination, 'drain', cause);
  }

  terminate() {
    if (this.terminated) return;
    this.terminated = true;
    for (const timer of this.drainTimers.values()) this.clearTimer(timer);
    this.drainTimers.clear();
    this.blockedByDestination.clear();
    this.sourceBlocks.clear();
  }

  #block(destination, sourceKey, source) {
    let sources = this.blockedByDestination.get(destination.name);
    if (!sources) {
      sources = new Set();
      this.blockedByDestination.set(destination.name, sources);
    }
    if (sources.has(sourceKey)) return;
    sources.add(sourceKey);
    if (!this.drainTimers.has(destination.name)) {
      const timer = this.setTimer(() => {
        this.drainTimers.delete(destination.name);
        if (this.terminated || !destination.active) return;
        this.#destinationFailure(destination, 'drain', new Error(
          `${destination.name} did not drain within ${this.drainTimeoutMs}ms`,
        ));
      }, this.drainTimeoutMs);
      this.drainTimers.set(destination.name, timer);
    }

    let blocks = this.sourceBlocks.get(sourceKey);
    if (!blocks) {
      blocks = new Set();
      this.sourceBlocks.set(sourceKey, blocks);
      if (source && typeof source.pause === 'function') source.pause();
    }
    blocks.add(destination.name);
  }

  #drain(destination) {
    if (this.terminated || !destination.active) return;
    this.#clearDrainTimer(destination.name);
    const sources = this.blockedByDestination.get(destination.name);
    if (!sources) return;
    this.blockedByDestination.delete(destination.name);
    for (const sourceKey of sources) {
      const blocks = this.sourceBlocks.get(sourceKey);
      if (!blocks) continue;
      blocks.delete(destination.name);
      if (blocks.size > 0) continue;
      this.sourceBlocks.delete(sourceKey);
      if (sourceKey !== NO_SOURCE && typeof sourceKey.resume === 'function' && !this.blockingError) {
        sourceKey.resume();
      }
    }
  }

  #destinationFailure(destination, operation, cause) {
    if (this.terminated || !destination.active) return null;
    this.#clearDrainTimer(destination.name);
    if (destination.role === 'raw') {
      const error = classifyBridgeFailure(`raw-${operation}`, cause, { destination: destination.name });
      this.#setBlockingError(error);
      return error;
    }
    destination.active = false;
    this.#releaseDestination(destination.name);
    const degradation = this.degradations.record(
      destination.role,
      `${destination.role}-${operation}-error`,
    );
    if (degradation) this.onDegradation(degradation);
    return degradation;
  }

  #releaseDestination(destinationName) {
    const sources = this.blockedByDestination.get(destinationName);
    if (!sources) return;
    this.blockedByDestination.delete(destinationName);
    for (const sourceKey of sources) {
      const blocks = this.sourceBlocks.get(sourceKey);
      blocks?.delete(destinationName);
      if (!blocks || blocks.size > 0) continue;
      this.sourceBlocks.delete(sourceKey);
      if (sourceKey !== NO_SOURCE && typeof sourceKey.resume === 'function' && !this.blockingError) {
        sourceKey.resume();
      }
    }
  }

  #clearDrainTimer(destinationName) {
    const timer = this.drainTimers.get(destinationName);
    if (timer === undefined) return;
    this.drainTimers.delete(destinationName);
    this.clearTimer(timer);
  }

  #setBlockingError(error) {
    if (this.blockingError) return;
    this.blockingError = error;
    for (const timer of this.drainTimers.values()) this.clearTimer(timer);
    this.drainTimers.clear();
    for (const source of this.sources) {
      if (!this.sourceBlocks.has(source) && typeof source.pause === 'function') source.pause();
      this.blockingPausedSources.add(source);
    }
    this.onBlockingError(error);
  }

  #sourcePaused(source) {
    return this.sourceBlocks.has(source ?? NO_SOURCE) || this.blockingPausedSources.has(source);
  }
}

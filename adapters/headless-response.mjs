// Correlate source events to one direct, terminal role response. This module
// checks transport provenance only; response grammar and approval belong to
// the controller.
const DEFAULT_MAX_BYTES = 64 * 1024;
const HARNESSES = new Set(['claude', 'codex', 'opencode']);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function direct(event, part = null) {
  const noChildMarkers = (source) => source === null || (
    source.agent_id == null && source.agentId == null
    && source.parent_actor_id == null && source.parentActorId == null
    && source.parent_tool_use_id == null && source.parentToolUseId == null
  );
  return noChildMarkers(event) && noChildMarkers(part)
    && noChildMarkers(object(event.item) ? event.item : null);
}

function sessionId(harness, event, part = null) {
  const value = harness === 'claude' ? event.session_id
    : harness === 'codex' ? event.thread_id ?? event.threadId
      : event.sessionID ?? event.sessionId ?? part?.sessionID ?? part?.sessionId;
  if (value == null) return null;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value;
}

export function createHeadlessResponseCorrelator(harness, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!HARNESSES.has(harness)) throw new Error('unsupported headless harness');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('invalid terminal response limit');

  let candidate = null;
  let candidateSession = null;
  let streamSession = null;
  let terminalSession = null;
  let terminalCount = 0;
  let reason = null;
  let retainedBytes = 0;

  const bind = (id) => {
    if (id === undefined) { reason ??= 'invalid-identity'; return; }
    if (id !== null && streamSession !== null && id !== streamSession) reason ??= 'identity-mismatch';
  };
  const retain = (value, id) => {
    bind(id);
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > maxBytes) { reason ??= 'oversized-response'; return; }
    candidate = value;
    // A lifecycle event may identify an otherwise ID-less native message.
    // The candidate's own ID cannot retroactively identify a later ID-less
    // completion, or vice versa.
    candidateSession = id ?? streamSession;
    retainedBytes = bytes;
  };
  const reset = () => {
    candidate = null;
    candidateSession = null;
    retainedBytes = 0;
  };
  const complete = (id, value = candidate) => {
    bind(id);
    const completionSession = id ?? streamSession;
    terminalSession = completionSession;
    terminalCount++;
    if (terminalCount > 1) reason ??= 'multiple-terminals';
    if (value === null) reason ??= 'missing-response';
    if (candidate !== null && candidateSession !== completionSession) reason ??= 'identity-mismatch';
    if (value !== null && value !== candidate) {
      const bytes = Buffer.byteLength(value, 'utf8');
      if (bytes > maxBytes) reason ??= 'oversized-response';
      else { candidate = value; retainedBytes = bytes; }
    }
  };

  return Object.freeze({
    accept(line, sourceStream = 'stdout') {
      if (sourceStream !== 'stdout' || line.length === 0) return;
      let event;
      try { event = JSON.parse(line); } catch { reason ??= 'invalid-json'; return; }
      if (!object(event)) { reason ??= 'invalid-event'; return; }

      const part = object(event.part) ? event.part : null;
      if (!direct(event, part)) return;
      if (harness === 'opencode' && part !== null) {
        const outer = event.sessionID ?? event.sessionId;
        const inner = part.sessionID ?? part.sessionId;
        if (outer != null && inner != null && outer !== inner) reason ??= 'identity-mismatch';
      }
      const id = sessionId(harness, event, part);
      const lifecycle = harness === 'claude' ? event.type === 'system' && event.subtype === 'init'
        : harness === 'codex' ? event.type === 'thread.started'
          : event.type === 'step_start';
      if (lifecycle) {
        bind(id);
        if (id !== null && id !== undefined) {
          if (streamSession !== null && streamSession !== id) reason ??= 'identity-mismatch';
          else streamSession = id;
        }
        return;
      }
      if (harness === 'claude') {
        if (event.type === 'result') {
          if (event.subtype === 'success' && typeof event.result === 'string') complete(id, event.result);
          else if (event.subtype === 'error' || event.subtype === 'failure') { bind(id); terminalSession = id ?? streamSession; terminalCount++; reason ??= 'failed-terminal'; }
          else reason ??= 'invalid-terminal';
        }
        return;
      }
      if (harness === 'codex') {
        if (event.type === 'item.completed' && event.item?.type === 'agent_message'
          && typeof event.item.text === 'string' && terminalCount === 0) retain(event.item.text, id);
        else if (event.item?.type === 'command_execution' || event.item?.type === 'tool_call') reset();
        else if (event.type === 'turn.completed') complete(id);
        else if (event.type === 'turn.failed' || event.type === 'error') { bind(id); terminalSession = id ?? streamSession; terminalCount++; reason ??= 'failed-terminal'; }
        return;
      }
      if (event.type === 'text' && typeof part?.text === 'string' && terminalCount === 0) retain(part.text, id);
      else if (event.type === 'tool_use' || (event.type === 'step_finish' && part?.reason === 'tool-calls')) reset();
      else if (event.type === 'step_finish' && part?.reason === 'stop') complete(id);
      else if (event.type === 'error') { bind(id); terminalSession = id ?? streamSession; terminalCount++; reason ??= 'failed-terminal'; }
    },
    result() {
      const failure = reason ?? (terminalCount === 0 ? 'missing-terminal' : candidate === null ? 'missing-response' : null);
      return Object.freeze({
        payload: failure === null ? candidate : null,
        identity: terminalCount === 0 && streamSession === null ? null : Object.freeze({
          sessionId: terminalCount === 0 ? streamSession : terminalSession,
          actor: 'direct',
        }),
        reason: failure,
        retainedBytes,
      });
    },
  });
}

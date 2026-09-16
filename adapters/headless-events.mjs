// Protocol-only decoders for one complete structured headless-output line.
// Workflow policy (ordering, persistence, timeouts, and halting) belongs to the
// conductor, not this adapter.
import { createHash } from 'node:crypto';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const SUPPORTED_OPENCODE_USAGE_VERSION = '1.18.27';

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const text = content.find((part) => object(part) && part.type === 'text' && typeof part.text === 'string');
  return text?.text ?? null;
}

function sourceIdentity(source, message = {}) {
  const actorId = source.agent_id ?? source.agentId ?? source.actor_id ?? source.actorId ?? null;
  const parentActorId = source.parent_actor_id ?? source.parentActorId ?? null;
  const parentToolUseId = source.parent_tool_use_id ?? source.parentToolUseId ?? null;
  const sourceRole = typeof message.role === 'string'
    ? message.role
    : (typeof source.role === 'string' ? source.role : null);
  return {
    actor: actorId === null
      ? (sourceRole === null ? null : 'phase')
      : (parentActorId !== null || parentToolUseId !== null ? 'subagent' : 'agent'),
    actorId,
    parentActorId,
    parentToolUseId,
    sourceRole,
  };
}

const validCount = (value) => Number.isSafeInteger(value) && value >= 0;
const validAmount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const validCurrency = (value) => typeof value === 'string' && value.trim().length > 0;

function addUsageValue(usage, field, value, validator) {
  if (validator(value)) usage[field] = value;
}

function normalizeUsage(source, provider) {
  const providerUsage = object(source.usage) ? source.usage : {};
  const usage = {};

  if (provider === 'claude') {
    addUsageValue(usage, 'inputTokens', providerUsage.input_tokens, validCount);
    addUsageValue(usage, 'cacheReadTokens', providerUsage.cache_read_input_tokens, validCount);
    addUsageValue(usage, 'cacheWriteTokens', providerUsage.cache_creation_input_tokens, validCount);
    addUsageValue(usage, 'outputTokens', providerUsage.output_tokens, validCount);
    addUsageValue(usage, 'totalTokens', providerUsage.total_tokens, validCount);
    addUsageValue(usage, 'reasoningTokens', providerUsage.reasoning_tokens, validCount);
    addUsageValue(usage, 'cost', source.total_cost_usd, validAmount);
    addUsageValue(usage, 'currency', source.currency, validCurrency);
    addUsageValue(usage, 'turns', source.num_turns, validCount);
  }

  if (provider === 'codex') {
    addUsageValue(usage, 'inputTokens', providerUsage.input_tokens, validCount);
    addUsageValue(usage, 'cacheReadTokens', providerUsage.cached_input_tokens, validCount);
    addUsageValue(usage, 'cacheWriteTokens', providerUsage.cache_creation_input_tokens, validCount);
    addUsageValue(usage, 'outputTokens', providerUsage.output_tokens, validCount);
    addUsageValue(usage, 'reasoningTokens', providerUsage.reasoning_tokens, validCount);
    addUsageValue(usage, 'totalTokens', providerUsage.total_tokens, validCount);
    addUsageValue(usage, 'cost', providerUsage.cost, validAmount);
    addUsageValue(usage, 'currency', providerUsage.currency, validCurrency);
    addUsageValue(usage, 'turns', providerUsage.turns, validCount);
  }

  if (provider === 'opencode') {
    // OpenCode v1.18.27 creates one fresh step-finish part from that step's
    // Session.getUsage(value.usage). It is a provider-step measurement, not a
    // session-cumulative total. See the version-pinned sources documented below.
    const tokens = object(source.part?.tokens) ? source.part.tokens : {};
    const cache = object(tokens.cache) ? tokens.cache : {};
    addUsageValue(usage, 'inputTokens', tokens.input, validCount);
    addUsageValue(usage, 'outputTokens', tokens.output, validCount);
    addUsageValue(usage, 'reasoningTokens', tokens.reasoning, validCount);
    addUsageValue(usage, 'cacheReadTokens', cache.read, validCount);
    addUsageValue(usage, 'cacheWriteTokens', cache.write, validCount);
    addUsageValue(usage, 'totalTokens', tokens.total, validCount);
    addUsageValue(usage, 'cost', source.part?.cost, validAmount);
  }

  if (Object.keys(usage).length === 0) return null;
  return usage;
}

function usageObservationScope(identity, sessionId) {
  if (identity.actorId !== null) return { kind: 'actor', actorId: identity.actorId };
  if (sessionId !== null) return { kind: 'session', sessionId };
  return null;
}

function envelope(context, source, details, line) {
  const identity = sourceIdentity(source, details.message);
  const usage = details.usageProvider === undefined
    ? null
    : normalizeUsage(source, details.usageProvider);
  const isObservation = usage !== null
    || details.event === 'completed'
    || details.event === 'usage.observed';
  const observationScope = !isObservation
    ? null
    : usageObservationScope(identity, details.sessionId ?? null);
  return {
    schemaVersion: 1,
    timestamp: context.receivedAt,
    runId: context.runId,
    phase: context.phase,
    attempt: context.attempt,
    harness: context.harness,
    sessionId: details.sessionId ?? null,
    actor: details.actor ?? identity.actor,
    actorId: details.actorId ?? identity.actorId,
    parentActorId: details.parentActorId ?? identity.parentActorId,
    event: details.event,
    summary: details.summary ?? null,
    metadata: {
      sourceStream: context.sourceStream,
      ...(!isObservation ? {} : {
        observationFingerprint: `sha256:${createHash('sha256').update(line).digest('hex')}`,
      }),
      ...(observationScope === null ? {} : { observationScope }),
      ...(details.measurementId === undefined ? {} : { measurementId: details.measurementId }),
      ...(details.measurementScope === undefined ? {} : { measurementScope: details.measurementScope }),
      ...(identity.parentToolUseId === null ? {} : { parentToolUseId: identity.parentToolUseId }),
      ...(identity.sourceRole === null ? {} : { sourceRole: identity.sourceRole }),
      ...(details.metadata ?? {}),
    },
    ...(usage === null ? {} : { usage }),
  };
}

function claude(source, context) {
  const sessionId = source.session_id ?? null;
  if (source.type === 'system' && source.subtype === 'init') {
    return { event: 'session.started', sessionId };
  }
  if (source.type === 'system' && source.subtype === 'thinking_tokens') {
    // Token-delta plumbing is reasoning, never curated text: the renderer drops
    // `reasoning` events so the live/readable feeds stay silent while the raw
    // capture keeps them.
    return { event: 'reasoning', sessionId };
  }
  if (source.type === 'system' && (source.subtype === 'hook_started' || source.subtype === 'hook_response')) {
    // SessionStart hook lifecycle is intentional plumbing: preserved in the raw
    // capture but not significant enough to render or to count as degradation.
    return { disposition: 'ignored', reason: 'lifecycle-plumbing' };
  }
  if (source.type === 'system' && source.subtype === 'task_started') {
    return {
      event: 'agent.started',
      sessionId,
      actor: 'subagent',
      actorId: source.subagent_type ?? null,
      summary: source.description ?? null,
      metadata: {
        taskId: source.task_id ?? null,
        ...(source.tool_use_id == null ? {} : { parentToolUseId: source.tool_use_id }),
      },
    };
  }
  if (source.type === 'system' && source.subtype === 'task_notification') {
    const terminal = source.status === 'completed' || source.status === 'error' || source.status === 'failed';
    if (!terminal) {
      // Non-terminal statuses (e.g. `running`, `pending`, absent) are chatty plumbing,
      // same disposition as task_progress/task_updated — never force a terminal outcome.
      return { disposition: 'ignored', reason: 'task-notification-plumbing' };
    }
    return {
      event: source.status === 'completed' ? 'agent.completed' : 'agent.failed',
      sessionId,
      actor: 'subagent',
      actorId: source.subagent_type ?? null,
      summary: source.summary ?? null,
      metadata: {
        taskId: source.task_id ?? null,
        ...(source.tool_use_id == null ? {} : { parentToolUseId: source.tool_use_id }),
        status: source.status ?? null,
      },
    };
  }
  if (source.type === 'system' && source.subtype === 'task_progress') {
    return { disposition: 'ignored', reason: 'task-progress-plumbing' };
  }
  if (source.type === 'system' && source.subtype === 'task_updated') {
    return { disposition: 'ignored', reason: 'task-updated-plumbing' };
  }
  if (source.type === 'assistant' && object(source.message)) {
    const content = source.message.content;
    // One assistant message may carry N parallel `tool_use` blocks. The
    // one-line→one-envelope contract still emits a single `tool.started`, but
    // the block count rides `metadata.toolUseCount` so volume readers count
    // calls, not messages — `toolId`/`toolName` stay the first block's.
    const tools = Array.isArray(content) ? content.filter((part) => object(part) && part.type === 'tool_use') : [];
    if (tools.length > 0) {
      return {
        event: 'tool.started',
        sessionId,
        actor: 'tool',
        message: source.message,
        metadata: { toolId: tools[0].id ?? null, toolName: tools[0].name ?? null, toolUseCount: tools.length },
      };
    }
    const summary = textFromContent(content);
    if (summary !== null) return { event: 'message', sessionId, message: source.message, summary };
  }
  if (source.type === 'user' && object(source.message) && Array.isArray(source.message.content)) {
    const tool = source.message.content.find((part) => object(part) && part.type === 'tool_result');
    if (tool) return { event: 'tool.completed', sessionId, actor: 'tool', message: source.message, metadata: { toolId: tool.tool_use_id ?? null } };
  }
  if (source.type === 'result' && source.subtype === 'success') return { event: 'completed', sessionId, summary: source.result ?? null, usageProvider: 'claude' };
  if (source.type === 'result' && ['error', 'failure'].includes(source.subtype)) return { event: 'failed', sessionId, summary: source.error ?? source.result ?? null };
  return null;
}

function codex(source) {
  const sessionId = source.thread_id ?? source.threadId ?? null;
  if (source.type === 'thread.started') return { event: 'session.started', sessionId };
  if (source.type === 'turn.completed') return { event: 'completed', sessionId, usageProvider: 'codex' };
  if (source.type === 'error' || source.type === 'turn.failed') return { event: 'failed', sessionId, summary: source.message ?? source.error ?? null };
  const item = source.item;
  if (!object(item)) return null;
  if (item.type === 'agent_message' && source.type === 'item.completed') {
    return { event: 'message', sessionId, actor: 'phase', summary: item.text ?? null };
  }
  if (item.type === 'reasoning') return { event: 'reasoning', sessionId, actor: 'phase' };
  if (item.type === 'command_execution') {
    return {
      event: source.type === 'item.started' ? 'tool.started' : (source.type === 'item.completed' ? 'tool.completed' : null),
      sessionId,
      actor: 'tool',
      metadata: { toolId: item.id ?? null, toolName: 'command_execution', command: item.command ?? null, exitCode: item.exit_code ?? null },
    };
  }
  return null;
}

// The OpenCode decoder targets the actual `opencode run --format json` event
// stream (source-verified for OpenCode v1.18.27): one JSON
// object per line with a top-level `type`, `sessionID`, and `part`. The emitted
// vocabulary is `step_start` / `text` / `tool_use` / `step_finish`; there is no
// session-idle event and no tool "before" event — the process exiting is the
// phase-completion signal. Every step-finish part is freshly created with
// provider usage and stable part/message/session identity; the CLI emits each
// one after filtering by session. Sources:
// https://github.com/anomalyco/opencode/blob/v1.18.27/packages/opencode/src/session/processor.ts#L407-L441
// https://github.com/anomalyco/opencode/blob/v1.18.27/packages/opencode/src/cli/cmd/run.ts#L681-L708
function opencode(source, context) {
  const part = object(source.part) ? source.part : {};
  const sessionId = source.sessionID
    ?? source.sessionId
    ?? part.sessionID
    ?? part.sessionId
    ?? null;
  if (source.type === 'error') {
    return { event: 'failed', sessionId, summary: source.error ?? part.error ?? null };
  }
  if (source.type === 'step_start') {
    return { disposition: 'ignored', reason: 'step-start-plumbing' };
  }
  if (source.type === 'text' && typeof part.text === 'string') {
    return {
      event: 'message',
      sessionId,
      actor: 'phase',
      summary: part.text,
      metadata: { messageId: part.messageID ?? part.id ?? null },
    };
  }
  if (source.type === 'tool_use') {
    const state = object(part.state) ? part.state : {};
    const failed = state.status === 'error';
    const terminal = state.status === 'completed' || failed;
    if (!terminal) {
      // Non-terminal statuses (e.g. `pending`, absent) are chatty plumbing, mirroring
      // step_start/step_finish — never default an unknown status to `tool.completed`.
      return { disposition: 'ignored', reason: 'tool-use-plumbing' };
    }
    return {
      event: failed ? 'tool.failed' : 'tool.completed',
      sessionId,
      actor: 'tool',
      summary: failed && typeof state.error === 'string' ? state.error : null,
      metadata: {
        toolId: part.callID ?? part.callId ?? null,
        toolName: part.tool ?? null,
        status: state.status ?? null,
      },
    };
  }
  if (source.type === 'step_finish') {
    const partId = typeof part.id === 'string' ? part.id : null;
    const messageId = typeof part.messageID === 'string' ? part.messageID : null;
    const scopedSessionId = typeof part.sessionID === 'string' ? part.sessionID : null;
    const hasMeasurementIdentity = partId !== null && messageId !== null && scopedSessionId !== null;
    const providerVersion = typeof context.providerVersion === 'string' ? context.providerVersion : null;
    const hasSupportedSemantics = providerVersion === SUPPORTED_OPENCODE_USAGE_VERSION;
    return {
      event: part.reason === 'stop' ? 'completed' : 'usage.observed',
      sessionId,
      usageProvider: 'opencode',
      metadata: providerVersion === null ? {} : { providerVersion },
      ...(hasMeasurementIdentity && hasSupportedSemantics ? {
        measurementId: `opencode:step:${scopedSessionId}:${messageId}:${partId}`,
        measurementScope: {
          provider: 'opencode', kind: 'step', sessionId: scopedSessionId, messageId, partId,
        },
      } : {}),
    };
  }
  return null;
}

const decoderFor = { claude, codex, opencode };

export function decodeHeadlessEvent(line, context) {
  let source;
  try {
    source = JSON.parse(line);
  } catch {
    return { disposition: 'malformed', line, reason: 'invalid-json' };
  }
  if (!object(source)) return { disposition: 'unknown', line, parsed: source, reason: 'unknown-event' };
  const decoder = decoderFor[context.harness];
  if (!decoder) return { disposition: 'unknown', line, parsed: source, reason: 'unsupported-harness' };
  const details = decoder(source, context);
  if (details?.disposition === 'ignored') {
    return { disposition: 'ignored', line, reason: details.reason ?? 'ignored-event' };
  }
  if (!details || !details.event) return { disposition: 'unknown', line, parsed: source, reason: 'unknown-event' };
  return { disposition: 'decoded', line, envelope: envelope(context, source, details, line) };
}

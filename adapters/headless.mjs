// Maps a harness ID to its fresh headless one-shot session descriptor; null =
// harness has no headless mode, so autopilot must not be offered silently.

import { bareModelMappingsForHarness } from './model-mappings.mjs';

export { CODEX_MODEL_MAPPING_SOURCE } from './model-mappings.mjs';

export const SUPPORTED_HARNESSES = Object.freeze(['claude', 'codex', 'opencode']);

const MODEL_TIERS = Object.freeze(['cheap', 'standard', 'most-capable']);
const SAFE_CONCRETE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

// The tools a chain-phase child needs. Declaring them keeps an unattended Claude
// child usable when subprocess environment scrubbing resets its permission mode.
export const CLAUDE_ALLOWED_TOOLS = Object.freeze([
  'Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'TodoWrite', 'Skill',
]);

const freezeRecord = (record) => Object.freeze(record);

export const HEADLESS_CAPABILITIES = freezeRecord({
  claude: freezeRecord({
    structuredEvents: 'yes', nativeSessionIdentity: 'yes', nativeOpenResume: 'unproven',
    nativeDisplayName: 'yes', agentIdentity: 'yes', parentLink: 'unavailable', nativeStop: 'unavailable',
  }),
  codex: freezeRecord({
    structuredEvents: 'yes', nativeSessionIdentity: 'yes', nativeOpenResume: 'yes',
    nativeDisplayName: 'unavailable', agentIdentity: 'unavailable', parentLink: 'unavailable', nativeStop: 'unavailable',
  }),
  opencode: freezeRecord({
    structuredEvents: 'yes', nativeSessionIdentity: 'yes', nativeOpenResume: 'yes',
    nativeDisplayName: 'yes', agentIdentity: 'unavailable', parentLink: 'unavailable', nativeStop: 'unavailable',
  }),
});

export const NATIVE_SESSION_METADATA = freezeRecord({
  claude: freezeRecord({
    open: 'claude --resume <session-id>',
    resume: 'claude --resume <session-id>',
    reason: 'Claude --resume is an unproven native-session hint: the canary did not complete a resumed request.',
  }),
  codex: freezeRecord({
    open: 'codex resume --include-non-interactive',
    resume: 'codex exec resume <thread-id>',
    reason: 'Official Codex CLI documentation supports persisted exec session resumption.',
  }),
  opencode: freezeRecord({
    open: 'opencode session list --format json',
    resume: 'opencode run --session <session-id>',
    reason: 'OpenCode emits a sessionID on every structured event and `opencode session list --format json` lists persisted sessions; `opencode run --session <session-id>` resumes one (verified against the real `--format json` stream on opencode 1.18).',
  }),
});

function displayNameFor(harness, descriptorInput) {
  const displayName = descriptorInput?.displayName;
  if (displayName === undefined) return `steepy-${harness}`;
  if (typeof displayName !== 'string' || displayName.length === 0) {
    throw new TypeError('displayName must be a non-empty string when provided');
  }
  return displayName;
}

function modelTierFor(descriptorInput) {
  const modelTier = descriptorInput?.modelTier;
  if (modelTier === undefined) return undefined;
  if (!MODEL_TIERS.includes(modelTier)) {
    throw new TypeError('modelTier must be one of cheap, standard, most-capable');
  }
  return modelTier;
}

function validatedModelMappings(descriptorInput) {
  const modelMappings = descriptorInput?.modelMappings;
  if (modelMappings === undefined) return undefined;

  const prototype = typeof modelMappings === 'object' && modelMappings !== null
    ? Object.getPrototypeOf(modelMappings)
    : undefined;
  const isPlainRecord = prototype === Object.prototype || prototype === null;
  const keys = isPlainRecord ? Object.getOwnPropertyNames(modelMappings) : [];
  const isValid =
    isPlainRecord &&
    keys.length === Object.keys(modelMappings ?? {}).length &&
    Object.getOwnPropertySymbols(modelMappings ?? {}).length === 0 &&
    keys.every((key) => {
      const property = Object.getOwnPropertyDescriptor(modelMappings, key);
      return MODEL_TIERS.includes(key) && property?.enumerable && 'value' in property &&
        typeof property.value === 'string' && SAFE_CONCRETE_MODEL.test(property.value);
    });
  if (!isValid) {
    throw new TypeError(
      'modelMappings must contain only own canonical tier keys with safe non-empty concrete model strings',
    );
  }
  return modelMappings;
}

function modelResolutionFor(harness, descriptorInput) {
  const requestedModelTier = modelTierFor(descriptorInput);
  const modelMappings = validatedModelMappings(descriptorInput);
  if (requestedModelTier === undefined) return {};

  const resolvedModel = (harness === 'opencode' ? modelMappings : bareModelMappingsForHarness(harness))?.[requestedModelTier];
  if (resolvedModel === undefined) {
    return {
      requestedModelTier,
      resolvedModel: undefined,
      modelSelection: 'degraded',
      degradationReason: `No verified concrete model mapping is available for ${harness} tier "${requestedModelTier}".`,
    };
  }
  // `applied` means the concrete selection argument is present in the descriptor.
  // Only the spawned process's success/failure establishes provider acceptance.
  return { requestedModelTier, resolvedModel, modelSelection: 'applied' };
}

function descriptor(harness, cmd, args, protocol, displayName, modelResolution) {
  if (modelResolution.modelSelection === 'applied' &&
    !args.some((arg, index) => arg === '--model' && args[index + 1] === modelResolution.resolvedModel)) {
    throw new Error('applied model selection requires a concrete --model argument');
  }
  return Object.freeze({
    cmd,
    args: Object.freeze(args),
    protocol,
    displayName,
    capabilities: HEADLESS_CAPABILITIES[harness],
    nativeSession: NATIVE_SESSION_METADATA[harness],
    ...modelResolution,
  });
}

export function headlessCommand(harness, prompt, descriptorInput) {
  if (!SUPPORTED_HARNESSES.includes(harness)) return null;
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new TypeError('prompt must be a non-empty string');
  }

  const displayName = displayNameFor(harness, descriptorInput);
  const modelResolution = modelResolutionFor(harness, descriptorInput);
  switch (harness) {
    case 'claude': {
      const args = [
        '-p', prompt,
        '--dangerously-skip-permissions',
        '--allowedTools', CLAUDE_ALLOWED_TOOLS.join(','),
        '--output-format', 'stream-json',
        '--verbose',
        '--forward-subagent-text',
        '--name', displayName,
      ];
      if (modelResolution.modelSelection === 'applied') args.push('--model', modelResolution.resolvedModel);
      return descriptor('claude', 'claude', args, 'stream-json', displayName, modelResolution);
    }
    case 'codex': {
      const args = [];
      if (modelResolution.modelSelection === 'applied') args.push('--model', modelResolution.resolvedModel);
      args.push('exec', '--dangerously-bypass-approvals-and-sandbox', '--color', 'never', '--json');
      args.push(prompt);
      return descriptor('codex', 'codex', args, 'jsonl', displayName, modelResolution);
    }
    case 'opencode': {
      // Deliberate default degradation: OpenCode has no built-in mapping until a
      // caller supplies a separately verified modelMappings record.
      const args = ['run', '--auto', '--format', 'json', '--title', displayName];
      if (modelResolution.modelSelection === 'applied') args.push('--model', modelResolution.resolvedModel);
      args.push(prompt);
      return descriptor('opencode', 'opencode', args, 'json', displayName, modelResolution);
    }
    default:
      return null;
  }
}

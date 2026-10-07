// Maps a harness ID to its session-store descriptor; null = the harness's
// session records have no verified readable shape, so cost reporting must not
// silently treat them as zero spend. Pure knowledge, exactly parallel to
// `headlessCommand` in adapters/headless.mjs: no workflow policy lives here.

import { homedir } from 'node:os';
import { join } from 'node:path';

// The store root is computed from node:os homedir() plus the harness's relative
// subpath — never a machine-specific absolute literal — so the descriptor stays
// portable across hosts.
const SESSION_STORES = Object.freeze({
  // Claude Code writes one JSONL record per session event under the user's home
  // directory at `.claude/projects/<project-slug>/<session-id>.jsonl`. Field
  // mapping is spec-verified against real records: session lines carry
  // `attributionSkill`, `attributionPlugin`, `message.model`, `message.usage`,
  // `entrypoint` (`cli` = interactive, `sdk-cli` = headless), `cwd` (the project
  // working directory, which scopes a headless session to its repo), and
  // `timestamp`; a subagent dispatch's `toolUseResult` carries `agentType`,
  // `resolvedModel`, `totalTokens`, `usage`, `totalDurationMs`,
  // `totalToolUseCount`. Per-dispatch attribution therefore needs no parent-chain
  // walking. One API message is stored as one record PER CONTENT BLOCK, each
  // repeating the same `message.id` and the same full-request `message.usage` —
  // a usage reader that does not deduplicate on `message.id` overcounts by the
  // blocks-per-message factor (measured 2-3x on real stores).
  claude: Object.freeze({
    rootPath: join(homedir(), '.claude', 'projects'),
    format: 'jsonl',
    modelField: 'message.model',
    usageField: 'message.usage',
    messageIdField: 'message.id',
    skillAttributionField: 'attributionSkill',
    pluginAttributionField: 'attributionPlugin',
    entrypointField: 'entrypoint',
    entrypointValues: Object.freeze({ interactive: 'cli', headless: 'sdk-cli' }),
    timestampField: 'timestamp',
    cwdField: 'cwd',
    dispatchResult: Object.freeze({
      containerField: 'toolUseResult',
      agentTypeField: 'agentType',
      resolvedModelField: 'resolvedModel',
      totalTokensField: 'totalTokens',
      usageField: 'usage',
      totalDurationMsField: 'totalDurationMs',
      totalToolUseCountField: 'totalToolUseCount',
    }),
  }),
  // No verified descriptor exists yet for these harnesses; degrade explicitly.
  opencode: null,
  pi: null,
});

export function sessionStoreDescriptor(harness) {
  return SESSION_STORES[harness] ?? null;
}

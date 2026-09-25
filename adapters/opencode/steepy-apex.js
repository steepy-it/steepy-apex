// Steepy Apex — OpenCode adapter.
//
// A zero-dependency, plain-ESM OpenCode plugin. It wires discovery, invocation
// ergonomics, and one-time bootstrap injection for the shared canonical `skills/`
// core; it holds no workflow behavior of its own (that lives in `skills/`).
//
// Surface: adapters (.apex/standards/adapters.md). Core rule is fail-open —
// every optional host API is behind a capability check and the module no-ops
// safely on a stub, empty, or frozen context. Node built-ins only, no build step.
//
// Shape (obra/superpowers v6.1.1 `.opencode/plugins/`): an exported async
// function receiving the host context object, returning a hooks object.

import { fileURLToPath } from 'node:url';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync,
} from 'node:fs';
import { resolveProviderFromModel, tierModelsForProvider } from '../model-mappings.mjs';

// Resolve the package's own location from this module's URL — never a hardcoded
// or cwd-relative path. This file lives at <root>/adapters/opencode/, so the
// package root is two directories up.
const HERE = dirname(fileURLToPath(import.meta.url)); // <root>/adapters/opencode
const PACKAGE_ROOT = dirname(dirname(HERE)); // <root>
const SKILLS_DIR = join(PACKAGE_ROOT, 'skills');

// The ten canonical skill names: the nine chain/hub-aware skills in invocation order
// per the routing chain, plus the pre-hub `inception` skill appended last — it has no
// chain role and is listed here purely as an invocation identifier (adapters never
// read `.apex/inception/**`).
const SKILL_NAMES = [
  'init', 'check', 'new-surface', 'discovery', 'brainstorm',
  'plan', 'implement', 'review', 'loop-engineer', 'inception',
];

// The marker is bootstrap content, not ownership evidence. The WeakSet below
// recognizes only exact parts this adapter injected into a live host projection.
const BOOTSTRAP_MARKER = '<!-- steepy-apex:bootstrap -->';
const injectedBootstrapParts = new WeakSet();
const MAX_AGENT_BYTES = 1024 * 1024;
const MAX_DIAGNOSTICS = 8;
const MAX_DIAGNOSTIC_CHARS = 256;

// Built once per process (not per message), then cached.
let bootstrapBlock;
function getBootstrapBlock() {
  if (bootstrapBlock !== undefined) return bootstrapBlock;
  bootstrapBlock = [
    BOOTSTRAP_MARKER,
    'Steepy Apex is installed in this session (OpenCode adapter).',
    `Engine root: ${PACKAGE_ROOT}`,
    'Before touching code, read applicable `AGENTS.md` files in root-to-project order.',
    'Locate and run the project canonical bootstrap under `.agents/skills`.',
    'If that bootstrap is unavailable, fall back to `.apex/_INDEX.md`, execute the relevant',
    'owning standard inline, and declare the inline-standard degradation. If neither the',
    'bootstrap nor the index exists, this project has no governed hub yet: do not impose',
    'a standard. For a brand-new application the user wants governed, offer the pre-hub',
    '`inception` skill; for an existing codebase, offer `init`, then `discovery`. Never',
    'start either skill unless the user asks.',
    '',
    'Skills: invoke any of the ten steepy-apex skills with the native skill tool,',
    'or via the registered `steepy-apex-<skill>` commands',
    `(${SKILL_NAMES.join(', ')}), passing arguments through.`,
    '',
    'Harness capabilities:',
    '- Subagent dispatch (D1): available natively — dispatch specialists via OpenCode',
    '  agents / the Task tool rather than running everything inline.',
    '- Per-dispatch tier choice (D2): available with a pinned provider — pin `model` in',
    '  `opencode.json` (e.g. `zai-coding-plan/glm-5.3`); the plugin then registers the tier',
    "  trio `steepy-cheap` / `steepy-standard` / `steepy-most-capable` on the provider's",
    '  concrete models — that trio is the per-dispatch tier choice, made by dispatching the',
    "  matching agent by name. The project's hub surface agents register at their",
    '  frontmatter tier (agent-static), so dispatching a specialist by name runs it at that',
    '  registered tier, not at a per-dispatch one.',
    "  Reconciliation: when a task's Complexity tier differs from the dispatched surface",
    "  agent's registered tier, dispatch the matching `steepy-<tier>` agent carrying the same",
    '  implementer prompt — the task brief plus the owning surface standard transport the',
    '  specialist contract — and record the specialist-prompt degradation in the ledger.',
    '  Without a mapped pin nothing tier-related registers and every dispatch',
    '  degrades to the session model (declared degradation).',
    '- Interactive questions (D3): ask in plain text, one at a time, with numbered',
    '  options and a recommendation.',
    '- Coherence gate (D4): OpenCode has no end-of-turn hook, so the hub gate runs at',
    '  `check` / `review` time (scripts/validate-hub.mjs); the RELEASE.md capability',
    '  matrix records the canary verdict for this harness.',
    '',
  ].join('\n');
  return bootstrapBlock;
}

// --- config hook -----------------------------------------------------------
// Registers skills discovery and (where the host exposes one) a command map,
// then the D2 dispatch agents (tier trio + project hub agents).
function applyConfig(config, ctx) {
  if (!config || typeof config !== 'object') return;

  // Skills discovery: create the array path defensively. Fail open if the host
  // handed us a frozen / non-extensible config.
  try {
    config.skills ??= {};
    config.skills.paths ??= [];
    if (Array.isArray(config.skills.paths) && !config.skills.paths.includes(SKILLS_DIR)) {
      config.skills.paths.push(SKILLS_DIR);
    }
  } catch {
    // host config not writable here — skip gracefully (fail-open).
  }

  // Command map: only where the host supports one (capability check). A plain or
  // frozen `{}` lacks `config.command`, so we skip it entirely — no partial state.
  const commandMap = config.command;
  if (
    commandMap &&
    typeof commandMap === 'object' &&
    !Array.isArray(commandMap) &&
    Object.isExtensible(commandMap)
  ) {
    for (const name of SKILL_NAMES) {
      const key = `steepy-apex-${name}`;
      if (key in commandMap) continue; // never overwrite an existing command
      try {
        commandMap[key] = {
          description: `Run the steepy-apex ${name} skill.`,
          template: `Use the skills tool to run the \`${name}\` skill. Arguments: $ARGUMENTS`,
        };
      } catch {
        // command entry not writable — stop, but leave what was written intact.
        break;
      }
    }
  }

  applyAgentRegistration(config, ctx);
}

// --- D2 agent registration --------------------------------------------------
// Registers dispatchable subagents into the host config's agent map, all
// fail-open: same defensive pattern as `config.skills.paths` — `??=` the
// container (skip cleanly when frozen/non-extensible), never overwrite an
// existing same-named entry, try/catch per write (stop, leaving prior writes
// intact). Tier entries register only when `config.model` is a mapped
// provider/model pin; anything else registers nothing tier-related (SC5).
// Project hub agents register only when <project>/.apex exists, with the
// frontmatter tier word (haiku/sonnet/opus) mapped through the session
// provider's concrete ids — a non-tier word, or no mapped pin, registers
// without a `model` field (declared session-model degradation).
const TIER_ORDER = ['cheap', 'standard', 'most-capable'];
const FRONTMATTER_TIER_BY_WORD = Object.freeze({ haiku: 'cheap', sonnet: 'standard', opus: 'most-capable' });

// The host context's project-directory property (a string), else process.cwd().
function projectDirectoryFromContext(ctx) {
  for (const candidate of [ctx?.directory, ctx?.project]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return process.cwd();
}

// A scalar frontmatter value: strip trailing ` # comment`, then surrounding quotes.
function scalarFrontmatterValue(raw) {
  let value = raw.split(/\s+#/, 1)[0].trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

// `---\nkey: value\n---\nbody` → parsed fields; undefined when unparsable.
function parseAgentFile(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (!match) return undefined;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = scalarFrontmatterValue(kv[2]);
  }
  return { name: fields.name, mode: fields.mode, model: fields.model, body: match[2].trim() };
}

function diagnosticReporter(ctx) {
  let remaining = MAX_DIAGNOSTICS;
  return (code, path) => {
    if (remaining <= 0) return;
    const app = ctx?.client?.app;
    if (!app || typeof app.log !== 'function') return;
    remaining -= 1;
    const label = typeof path === 'string' ? basename(path) : 'unknown';
    const message = `adapter discovery skipped ${label}: ${code}`.slice(0, MAX_DIAGNOSTIC_CHARS);
    try {
      const pending = app.log({
        body: { service: 'steepy-apex', level: 'warn', message },
      });
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {
      // Logging is optional evidence; discovery remains fail-open if it rejects.
    }
  };
}

// Resolve each package-relative namespace component with lstat: a symlink or
// non-directory is invalid, and only an actual ENOENT is absence. The project
// root is included so a host-supplied alias cannot redirect discovery. Inspect
// the raw native-platform components first: resolve() would otherwise erase a
// symlink or non-directory followed by `..` before it could be rejected.
function physicalDirectoryState(project, components, diagnose) {
  const lexicalRoot = parse(project).root;
  const lexicalTail = project.slice(lexicalRoot.length);
  const lexicalComponents = sep === '\\' ? lexicalTail.split(/[\\/]+/) : lexicalTail.split(sep);
  if (lexicalComponents.some((component) => component === '..')) {
    diagnose('unsafe-parent-traversal', project);
    return { state: 'invalid' };
  }

  const absoluteProject = resolve(project);
  const filesystemRoot = parse(absoluteProject).root;
  let current = filesystemRoot;
  const paths = [filesystemRoot];
  for (const component of absoluteProject.slice(filesystemRoot.length).split(sep)) {
    if (component.length === 0) continue;
    current = join(current, component);
    paths.push(current);
  }
  for (const component of components) {
    current = join(current, component);
    paths.push(current);
  }
  for (const path of paths) {
    let descriptor;
    try {
      descriptor = lstatSync(path);
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: 'absent' };
      diagnose('directory-unreadable', path);
      return { state: 'invalid' };
    }
    if (descriptor.isSymbolicLink() || !descriptor.isDirectory()) {
      diagnose('unsafe-directory-ancestor', path);
      return { state: 'invalid' };
    }
  }
  return { state: 'present', path: current };
}

// lstat rejects links before open; O_NOFOLLOW narrows the replacement race,
// O_NONBLOCK makes a replaced FIFO harmless, and fstat verifies the opened
// descriptor itself. The incremental cap catches growth after the pre-read size
// check. Node has no portable openat walk, so ancestor replacement remains a
// documented best-effort boundary rather than a claimed race-free sandbox.
function readOrdinaryFileBounded(path, diagnose) {
  let before;
  try {
    before = lstatSync(path);
  } catch {
    diagnose('entry-unreadable', path);
    return undefined;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    diagnose('entry-not-ordinary-file', path);
    return undefined;
  }
  if (before.size > MAX_AGENT_BYTES) {
    diagnose('entry-too-large', path);
    return undefined;
  }

  let fd;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    const nonBlock = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0;
    fd = openSync(path, constants.O_RDONLY | noFollow | nonBlock);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_AGENT_BYTES) {
      diagnose(opened.isFile() ? 'entry-too-large' : 'entry-not-ordinary-file', path);
      return undefined;
    }

    const chunks = [];
    let total = 0;
    while (total <= MAX_AGENT_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, (MAX_AGENT_BYTES + 1) - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_AGENT_BYTES) {
        diagnose('entry-grew-too-large', path);
        return undefined;
      }
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } catch {
    diagnose('entry-open-failed', path);
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* fail-open */ }
    }
  }
}

function agentEntriesFromDirectory(agentsDir, tierModels, diagnose) {
  let files;
  try {
    files = readdirSync(agentsDir);
  } catch {
    diagnose('directory-read-failed', agentsDir);
    return []; // present-but-unreadable is invalid.
  }
  const entries = [];
  for (const file of files) {
    if (typeof file !== 'string' || !file.endsWith('.md')) continue;
    let parsed;
    const path = join(agentsDir, file);
    const content = readOrdinaryFileBounded(path, diagnose);
    if (content === undefined) continue;
    parsed = parseAgentFile(content);
    if (!parsed) {
      diagnose('descriptor-parse-failed', path);
      continue;
    }
    // OpenCode agent identity is its native filename.
    const name = file.slice(0, -'.md'.length);
    if (name.length === 0) {
      diagnose('missing-native-identity', path);
      continue;
    }
    if (parsed.mode !== 'subagent') {
      diagnose('invalid-native-mode', path);
      continue;
    }
    const agent = { mode: 'subagent', prompt: parsed.body };
    const tier = parsed.model !== undefined ? FRONTMATTER_TIER_BY_WORD[parsed.model] : undefined;
    if (tier && tierModels) agent.model = tierModels[tier];
    entries.push({ name, agent });
  }
  return entries;
}

// Project specialists are read only from OpenCode's native namespace.
function collectProjectAgentEntries(ctx, tierModels, diagnose) {
  const project = projectDirectoryFromContext(ctx);
  const hub = physicalDirectoryState(project, ['.apex'], diagnose);
  if (hub.state !== 'present') return [];
  const native = physicalDirectoryState(project, ['.opencode', 'agents'], diagnose);
  if (native.state !== 'present') return [];
  return agentEntriesFromDirectory(native.path, tierModels, diagnose);
}

function applyAgentRegistration(config, ctx) {
  const diagnose = diagnosticReporter(ctx);
  const tierModels = tierModelsForProvider(resolveProviderFromModel(config.model));
  const projectEntries = collectProjectAgentEntries(ctx, tierModels, diagnose);
  if (!tierModels && projectEntries.length === 0) return; // nothing to register

  let agentMap;
  try {
    config.agent ??= {};
  } catch {
    return; // host config not writable here — skip gracefully (fail-open).
  }
  agentMap = config.agent;
  if (
    !agentMap ||
    typeof agentMap !== 'object' ||
    Array.isArray(agentMap) ||
    !Object.isExtensible(agentMap)
  ) {
    return; // absent / non-object / frozen agent map — no partial trio.
  }

  if (tierModels) {
    for (const tier of TIER_ORDER) {
      const name = `steepy-${tier}`;
      if (name in agentMap) continue; // never overwrite an existing agent entry
      try {
        agentMap[name] = {
          description: `Steepy Apex dispatched specialist at the ${tier} tier.`,
          mode: 'subagent',
          model: tierModels[tier],
          prompt: `steepy-apex dispatched specialist at tier ${tier}; follow the brief`,
        };
      } catch {
        // agent entry not writable — stop, but leave what was written intact.
        break;
      }
    }
  }

  for (const { name, agent } of projectEntries) {
    if (name in agentMap) continue; // never overwrite an existing agent entry
    try {
      agentMap[name] = agent;
    } catch {
      // agent entry not writable — stop, but leave what was written intact.
      break;
    }
  }
}

// --- message transform hook ------------------------------------------------
// Prepends the bootstrap block to the first user message exactly once per
// session (the marker persists in that message, so later passes are no-ops).
function applyMessageTransform(output) {
  if (!output || !Array.isArray(output.messages) || output.messages.length === 0) return;
  const firstUser = output.messages.find((m) => m && m.info && m.info.role === 'user');
  if (!firstUser || !Array.isArray(firstUser.parts) || firstUser.parts.length === 0) return;

  const alreadyInjected = firstUser.parts.some(
    (part) => part && typeof part === 'object' && injectedBootstrapParts.has(part),
  );
  if (alreadyInjected) return;

  // A fresh minimal part — never spread the host's part, which would duplicate
  // host-assigned identifiers (id/partID/messageID) onto the injected part.
  try {
    const part = { type: 'text', text: getBootstrapBlock() };
    firstUser.parts.unshift(part);
    injectedBootstrapParts.add(part);
  } catch {
    // parts array not writable (frozen/sealed) — skip gracefully (fail-open).
  }
}

export const SteepyApex = async (ctx = {}) => ({
  config: async (config) => {
    applyConfig(config, ctx);
  },
  'experimental.chat.messages.transform': async (_input, output) => {
    applyMessageTransform(output);
  },
});

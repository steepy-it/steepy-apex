// Steepy Apex — Pi adapter.
//
// A zero-dependency, plain-ESM Pi extension. It wires invocation ergonomics and
// once-per-session bootstrap injection for the shared canonical `skills/` core; it holds
// no workflow behavior of its own (that lives in `skills/`).
//
// Surface: adapters (.apex/standards/adapters.md). Core rule is fail-open —
// every optional host API is behind a capability check and the module no-ops
// safely on a stub, empty, or frozen context. Node built-ins only, no build step.
//
// Shape (badlogic/pi-mono packages/coding-agent/docs/extensions.md; obra/superpowers
// v6.1.1 `.pi/extensions/`): a default-exported factory receiving the Pi
// ExtensionAPI, which registers slash commands and lifecycle-event handlers as
// side effects on the object it is handed. Skills are invoked via `/skill:<name>`
// and skills paths come from the package's `pi.skills` manifest (package.json),
// so this module wires only commands + bootstrap injection, never discovery.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Resolve the package's own location from this module's URL — never a hardcoded
// or cwd-relative path. This file lives at <root>/adapters/pi/, so the package
// root is two directories up.
const HERE = dirname(fileURLToPath(import.meta.url)); // <root>/adapters/pi
const PACKAGE_ROOT = dirname(dirname(HERE)); // <root>

// The ten canonical skill names: the nine chain/hub-aware skills in invocation order
// per the routing chain, plus the pre-hub `inception` skill appended last — it has no
// chain role and is listed here purely as an invocation identifier (adapters never
// read `.apex/inception/**`).
const SKILL_NAMES = [
  'init', 'check', 'new-surface', 'discovery', 'brainstorm',
  'plan', 'implement', 'review', 'loop-engineer', 'inception',
];

// Marker guard for the once-per-session bootstrap injection (mirrors the OpenCode
// adapter): if the session already carries it, the handler no-ops.
const BOOTSTRAP_MARKER = '<!-- steepy-apex:bootstrap -->';
const BOOTSTRAP_CUSTOM_TYPE = 'steepy-apex-instructions';

// Built once per process (not per event), then cached.
let bootstrapBlock;
function getBootstrapBlock() {
  if (bootstrapBlock !== undefined) return bootstrapBlock;
  bootstrapBlock = [
    BOOTSTRAP_MARKER,
    'Steepy Apex is installed in this session (Pi adapter).',
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
    'Skills: invoke any of the ten steepy-apex skills with `/skill:<name>` (or let the',
    'model load a model-invocable skill), or via the registered `/steepy-<skill>`',
    `wrapper commands (${SKILL_NAMES.join(', ')}), passing arguments through.`,
    '',
    'Harness capabilities:',
    '- Subagents (D1): Pi has no subagent dispatch — degrade to inline specialist work',
    '  in the same session and declare the degradation in the output and the ledger.',
    '- Model choice (D2): Pi has no per-dispatch model selection — use the session model',
    '  and record it in the ledger.',
    '- Interactive questions (D3): ask in plain text, one at a time, with numbered options',
    '  and a recommendation.',
    '- Coherence gate (D4): Pi has no end-of-turn gate, so the hub gate runs at `check` /',
    '  `review` time (scripts/validate-hub.mjs); the RELEASE.md capability matrix records',
    '  the canary verdict for this harness.',
    '',
  ].join('\n');
  return bootstrapBlock;
}

// --- ergonomic wrapper commands --------------------------------------------
// `/steepy-<skill> args` expands to the native `/skill:<name> args` invocation,
// passing arguments straight through. Registered only where the host exposes a
// command registry (capability check); each registration is independently
// try/guarded so one rejection never aborts the rest.
function skillInvocation(name, args) {
  const argStr = typeof args === 'string' ? args.trim() : '';
  return argStr ? `/skill:${name} ${argStr}` : `/skill:${name}`;
}

function registerCommands(pi) {
  if (typeof pi.registerCommand !== 'function') return; // optional host API — skip.
  for (const name of SKILL_NAMES) {
    try {
      pi.registerCommand(`steepy-${name}`, {
        description: `Run the steepy-apex ${name} skill.`,
        handler: async (args, ctx) => {
          const invocation = skillInvocation(name, args);
          if (typeof pi.sendUserMessage === 'function') {
            try {
              pi.sendUserMessage(invocation);
              return;
            } catch {
              // send rejected — fall through to a non-throwing notice.
            }
          }
          if (ctx && ctx.ui && typeof ctx.ui.notify === 'function') {
            try { ctx.ui.notify(`Run ${invocation}`, 'info'); } catch { /* fail-open */ }
          }
        },
      });
    } catch {
      // registration rejected for this name — skip it, keep going (fail-open).
    }
  }
}

// --- bootstrap injection ----------------------------------------------------
// The cross-restart guard: a resumed / reloaded session that already carries the
// adapter-owned custom message (persisted from an earlier injection) must not get
// a second block. Public marker text is content, never ownership evidence.
// `null` means the current session history cannot be inspected; keep that
// distinct from a readable marker-free session so a live extension instance
// never suppresses bootstrap injection after new / fork / resume switches it to
// a different session.
function sessionMarkerState(ctx) {
  const sm = ctx && ctx.sessionManager;
  if (!sm || typeof sm.getEntries !== 'function') return null;
  let entries;
  try { entries = sm.getEntries(); } catch { return null; }
  if (!Array.isArray(entries)) return null;
  return entries.some((e) => {
    if (!e || typeof e !== 'object') return false;
    return e.type === 'custom_message' && e.customType === BOOTSTRAP_CUSTOM_TYPE;
  });
}

export default function steepyApex(pi) {
  if (!pi || typeof pi !== 'object') return; // stub / empty context — nothing to wire.

  registerCommands(pi);

  if (typeof pi.on !== 'function') return; // no event bus — bootstrap can't be wired.

  // The session-marker scan is authoritative whenever current history is
  // readable. The process-local fallback prevents duplicates only when Pi does
  // not expose readable session history; it cannot prove per-session delivery.
  let injectedWithoutSessionHistory = false;
  const injectBootstrap = async (_event, ctx) => {
    const markerState = sessionMarkerState(ctx);
    if (markerState === true) return;
    if (markerState === null && injectedWithoutSessionHistory) return;
    if (typeof pi.sendMessage !== 'function') return; // optional host API — skip.
    try {
      pi.sendMessage({
        customType: BOOTSTRAP_CUSTOM_TYPE,
        content: getBootstrapBlock(),
        display: true,
      });
      if (markerState === null) injectedWithoutSessionHistory = true;
    } catch {
      // Send rejected — leave the fallback clear so a later event can retry.
    }
  };

  // session_start fires on startup / new / reload / resume / fork; post-compaction
  // reloads surface here too (Pi has no separate post-compact event), so this one
  // handler covers resume and compaction. The marker scan keeps repeats idempotent.
  try { pi.on('session_start', injectBootstrap); } catch { /* fail-open */ }
}

// Steepy Apex — dsh adapter.
//
// A zero-dependency, plain-ESM dsh plugin. It wires invocation ergonomics and
// one-time bootstrap injection for the shared canonical `skills/` core; it holds
// no workflow behavior of its own (that lives in `skills/`).
//
// Surface: adapters (.apex/standards/adapters.md). Core rule is fail-open —
// every optional host service is behind a capability gate and the module no-ops
// safely on a stub, empty, or frozen context. Node built-ins only, no build
// step, nothing imported from the host's own packages.
//
// Shape: a plugin module with named `name` + `apply(ctx)` exports. The dsh
// loader normalizes an imported module with `exports.default ?? exports`, so
// named exports are themselves the plugin object.
//
// --- inject choice, and why -------------------------------------------------
// This module declares NO top-level `inject`, and gates each capability behind
// its own `ctx.inject([service], callback)` child fiber instead. The three
// candidate patterns and why the third wins:
//
//   1. Bare read + capability check (`if (ctx.commands) ...`) — illegal here. On
//      a real host every service this adapter wants (`tools`, `commands`,
//      `systemPrompt`) is a flat SIBLING of the adapter's own row, never an
//      ancestor, so an undeclared read THROWS ("cannot get property ... without
//      inject") instead of returning undefined. There is nothing to check.
//   2. Top-level `inject: ['tools', 'commands', 'systemPrompt']` — worse. A
//      single unmet entry leaves the WHOLE fiber pending forever: `apply()`
//      never runs and nothing errors, so a host missing any one service would
//      get no steepy-apex at all — no bootstrap, no commands, no tool, and no
//      explanation. That is the opposite of fail-open.
//   3. No top-level `inject`, plus one `ctx.inject([service], cb)` per
//      capability — what this module does. The adapter's own fiber declares
//      nothing, so it always loads; each capability is an independent child
//      fiber gated on exactly one service, activated by the host's own
//      dependency graph the moment that service is really ready. Inside such a
//      callback the service IS declared on that child's own fiber, so the direct
//      property read there is the one legal bare read.
//
// One call per capability, never one combined call: a combined
// `ctx.inject(['tools', 'commands', 'systemPrompt'], cb)` reintroduces the same
// failure one level down — a host missing any ONE of the three would lose ALL
// the registrations, even the two whose services are healthy. It also isolates
// failure: a callback that throws affects only its own capability.
//
// A synchronous presence probe is not a substitute either: a fiber that declares
// nothing runs strictly before a gated sibling's, and the host's tools service
// is itself gated, so a probe reads "absent" on a host where the service becomes
// healthy microseconds later — silently registering nothing on a healthy host.
//
// Residual degradation (declared in the bootstrap block, never hidden): a
// service the host never composes leaves its child fiber pending forever, which
// at runtime is indistinguishable from "not loaded yet". The host offers no
// event, timeout, or status hook to observe it.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

// Resolve the package's own location from this module's URL — never a hardcoded
// or cwd-relative path. This file lives at <root>/adapters/dsh/, so the package
// root is two directories up.
const HERE = dirname(fileURLToPath(import.meta.url)); // <root>/adapters/dsh
const PACKAGE_ROOT = dirname(dirname(HERE)); // <root>

// The ten canonical skill names: the nine chain/hub-aware skills in invocation order
// per the routing chain, plus the pre-hub `inception` skill appended last — it has no
// chain role and is listed here purely as an invocation identifier (adapters never
// read `.apex/inception/**`).
const SKILL_NAMES = [
  'init', 'check', 'new-surface', 'discovery', 'brainstorm',
  'plan', 'implement', 'review', 'loop-engineer', 'inception',
];

// The model-facing channel. A command's output is rendered to the human and
// never enters model history, so a command can only tell the human which tool
// call to ask for; the model loads a skill by calling this tool.
const SKILL_TOOL_NAME = 'steepy_skill';

// Marker guard for the bootstrap block (GC6): the block opens with it, and the
// once-per-context registration below keeps a repeat `apply()` from adding a
// second copy — which the host would reject anyway, since a section name is
// unique and a duplicate throws.
const BOOTSTRAP_MARKER = '<!-- steepy-apex:bootstrap -->';
const BOOTSTRAP_SECTION_NAME = 'steepy-apex';

// The host's documented tool-guidance band is 100-199: its own SDK section sits
// at 150 and its mode-collapse rule at 99. Only `name` must be unique — `order`
// values may collide, but a tie concatenates in registration order, which is not
// deterministic relative to another package. 120 is inside the band and
// deterministically after the collapse rule and before the SDK section,
// colliding with neither. (The plan's parenthetical target was 150; that would
// tie with the shipped SDK section, so this deviates on purpose.)
const BOOTSTRAP_SECTION_ORDER = 120;

// Built once per process (not per registration), then cached. This caching is
// separate from the once-per-context registration guard below.
let bootstrapBlock;
function getBootstrapBlock() {
  if (bootstrapBlock !== undefined) return bootstrapBlock;
  bootstrapBlock = [
    BOOTSTRAP_MARKER,
    'Steepy Apex is installed in this session (dsh adapter).',
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
    `Skills: ${SKILL_NAMES.join(', ')}.`,
    `Load one by calling the \`${SKILL_TOOL_NAME}\` tool with that skill's name; the tool`,
    "returns the skill's exact prose. The `steepy-<skill>` commands are for the human:",
    'their output is rendered to the human and never enters model history (F3), so a',
    'command can only name the tool call to run — never treat command output as a loaded',
    'skill, and never expect the model to have read it.',
    '',
    'Harness capabilities:',
    '- Subagent dispatch (D1): no subagent dispatch is wired in this version — degrade to',
    '  inline specialist work in the same session, declared in the output and recorded in',
    '  the ledger (the host is documented to expose an agents service; wiring it is a follow-up).',
    '- Model choice (D2): no per-dispatch tier choice — every dispatch uses the session',
    '  model, recorded in the ledger as a declared degradation.',
    '- Interactive questions (D3): ask in plain prose, one at a time, with numbered options',
    '  and a recommendation.',
    '- Coherence gate (D4): no end-of-turn gate, so the hub gate runs at `check` / `review`',
    '  time (scripts/validate-hub.mjs).',
    '- Wiring degradation: each capability is registered on its own dependency-gated fiber.',
    '  A host that does not compose one of those services simply never registers that',
    '  capability — silently, with no error, and indistinguishable from "not loaded yet".',
    `  If the \`steepy-<skill>\` commands are missing here, ask for the \`${SKILL_TOOL_NAME}\` tool`,
    '  directly; if this block is stale, re-read `.apex/_INDEX.md`.',
    '',
  ].join('\n');
  return bootstrapBlock;
}

function registerBootstrapSection(scoped) {
  const systemPrompt = scoped && scoped.systemPrompt;
  if (!systemPrompt || typeof systemPrompt.section !== 'function') return; // nothing to register on.
  try {
    systemPrompt.section({
      name: BOOTSTRAP_SECTION_NAME,
      order: BOOTSTRAP_SECTION_ORDER,
      text: getBootstrapBlock(),
    });
  } catch {
    // the host rejected the section (a duplicate name from another instance, say)
    // — never let that escape; this run simply carries no block.
  }
}

// --- gating -----------------------------------------------------------------
// One dependency-gated child fiber per capability (see the header). The child
// activates when the host's own dependency graph says that one service is ready;
// if the host never composes it, only this child stays pending — the adapter and
// every other capability are untouched.
function gate(ctx, service, wire) {
  try {
    ctx.inject([service], (scoped) => {
      try {
        wire(scoped);
      } catch {
        // this capability failed after its service arrived — never let it reach
        // the host or the other capabilities (fail-open).
      }
    });
  } catch {
    // the host rejected the gate itself — skip this capability.
  }
}

// --- ergonomic wrapper commands ---------------------------------------------
// `/steepy-<skill> args` renders the exact `steepy_skill` call to run, with
// arguments passed through verbatim. Each registration is independently
// try/guarded so one rejection never aborts the rest.
function invocationNotice(skill, args) {
  const call = args
    ? `${SKILL_TOOL_NAME} { "skill": ${JSON.stringify(skill)}, "args": ${JSON.stringify(args)} }`
    : `${SKILL_TOOL_NAME} { "skill": ${JSON.stringify(skill)} }`;
  return [
    `Steepy Apex — ${skill}.`,
    'This output is rendered to you and never enters model history, so the command',
    'cannot hand the skill to the model by itself. Ask the model to call:',
    '',
    `    ${call}`,
    '',
    `The \`${SKILL_TOOL_NAME}\` tool returns that skill's exact prose from the engine root:`,
    PACKAGE_ROOT,
  ].join('\n');
}

function commandResult(skill, invocation) {
  try {
    const signal = invocation && invocation.signal;
    if (signal && signal.aborted) {
      return { kind: 'error', text: `steepy-apex: the ${skill} command was aborted before it ran.` };
    }
    const rawInput = invocation && invocation.rawInput;
    const args = typeof rawInput === 'string' ? rawInput.trim() : '';
    return { kind: 'success', text: invocationNotice(skill, args) };
  } catch {
    return { kind: 'error', text: `steepy-apex: could not prepare the ${skill} invocation.` };
  }
}

function registerCommands(scoped) {
  const commands = scoped && scoped.commands;
  if (!commands || typeof commands.register !== 'function') return; // nothing to register on.
  for (const skill of SKILL_NAMES) {
    try {
      commands.register({
        name: `steepy-${skill}`,
        description: `Steepy Apex — how to run the ${skill} skill in this session.`,
        input: { hint: `Arguments for ${skill} (optional) — passed through verbatim.` },
        handler: (invocation) => commandResult(skill, invocation),
      });
    } catch {
      // this one name was rejected — keep going, the other eight still register.
    }
  }
}

// --- model-invocable skill tool ---------------------------------------------
// `steepy_skill` is the channel the header comment names: a command's output
// is rendered to the human and never enters model history (F3), so the model
// can only be TOLD which tool call to make; this tool is that call. `skill` is
// validated against the closed SKILL_NAMES allowlist by EXACT MATCH before any
// filesystem access (GC7) — a non-string, empty string, unknown name, or a
// traversal attempt is rejected with a message naming the ten valid values,
// and no path is ever built from the rejected input. Only once that match
// succeeds is the path composed, from the ALLOWLISTED constant, never from a
// normalized/resolved form of the input:
//   join(PACKAGE_ROOT, 'skills', <allowlisted name>, 'SKILL.md')
const SKILL_TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    skill: {
      type: 'string',
      enum: [...SKILL_NAMES],
      description: `One of the ten canonical skill names: ${SKILL_NAMES.join(', ')}.`,
    },
    args: {
      type: 'string',
      description: 'Optional arguments for the skill, echoed into the framing verbatim.',
    },
  },
  required: ['skill'],
  additionalProperties: false,
};

// Read failures (a missing/unreadable SKILL.md) and GC7 validation rejections
// both return the tool's error shape rather than throwing. The pinned
// ToolDefinition contract (dsh-contract.md Point 2) declares no structured
// error field for a tool the way ctx.commands declares { kind: 'error' } —
// that union belongs to a different service, gated by a different contract.
// The honest choice inside THIS contract is a value output.schema already
// admits: since output.schema is declared as a plain string, every rejection
// and every success is simply the returned string, and render() never has to
// special-case either one.
function skillRejectionText() {
  return `steepy_skill: "skill" must be exactly one of: ${SKILL_NAMES.join(', ')}.`;
}

async function executeSkillTool(args) {
  const skill = args && typeof args === 'object' ? args.skill : undefined;
  if (typeof skill !== 'string' || !SKILL_NAMES.includes(skill)) return skillRejectionText();

  // `skill` is now provably a member of SKILL_NAMES — compose the path from
  // that allowlisted value, never from a normalized/resolved form of `args`.
  const skillDir = join(PACKAGE_ROOT, 'skills', skill);
  let contents;
  try {
    contents = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  } catch {
    return `steepy_skill: could not read SKILL.md for "${skill}" at ${skillDir}/.`;
  }

  const rawArgs = args && typeof args === 'object' ? args.args : undefined;
  const framingLines = [`Skill base directory: ${skillDir}/`];
  if (typeof rawArgs === 'string' && rawArgs) framingLines.push(`Arguments: ${rawArgs}`);
  // The exact bytes of SKILL.md end the string — no trailing banner or
  // newline follows, so the engine's skill-relative script resolution sees
  // only the framing above it plus the file's own content, byte-for-byte.
  return `${framingLines.join('\n')}\n\n${contents}`;
}

function renderSkillTool(args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : String(value) }];
}

function registerSkillTool(scoped) {
  const tools = scoped && scoped.tools;
  if (!tools || typeof tools.register !== 'function') return; // nothing to register on.
  try {
    tools.register({
      name: SKILL_TOOL_NAME,
      description: `Load one of the ten canonical Steepy Apex skills (${SKILL_NAMES.join(', ')}) and return its exact prose from the engine root.`,
      parameters: SKILL_TOOL_PARAMETERS,
      output: { schema: { type: 'string' }, render: renderSkillTool },
      execute: executeSkillTool,
    });
  } catch {
    // the host rejected the tool registration — never let that escape.
  }
}

// Contexts whose wiring is currently LIVE. Two properties, both required:
//
//   * keyed by the context object, not a module-level boolean — a second
//     legitimate host context must still get its own full wiring, which a
//     singleton would wrongly suppress;
//   * scoped to the lifetime of the wiring it guards, not to the context
//     forever. The entry is released by a `ctx.effect(...)` disposer, so it dies
//     in the same teardown that removes the registrations themselves.
//
// The lifetime scoping is the load-bearing half. A host reload disposes this
// fiber's effects first — tearing down the ten commands and the bootstrap
// section — and then re-invokes `apply()` with the SAME ctx object. A guard that
// outlived its own registrations would short-circuit that second call and leave
// the adapter silently dead for the rest of the session: no block, no commands,
// no error. Since cordis always precedes a reload with a full unload, the host
// never calls `apply()` twice over a live context on its own; the guard exists
// for a caller that does, and must not survive the unload.
const WIRED = new WeakSet();

export const name = 'steepy-apex';

export function apply(ctx) {
  if (!ctx || typeof ctx !== 'object') return; // stub / empty context — nothing to wire.
  if (typeof ctx.inject !== 'function') return; // no dependency gate — no safe way to reach a service.
  if (WIRED.has(ctx)) return; // already wired, and that wiring is still live.
  WIRED.add(ctx);

  // Release the guard when this wiring is torn down. `ctx.effect` is a mixin
  // accessor, not a service, so reading it needs no inject — it resolves before
  // the fiber walk that throws on an undeclared service read.
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => { WIRED.delete(ctx); }, 'steepy-apex once-guard');
    } else {
      WIRED.delete(ctx); // no effect lifecycle — prefer re-wiring over dying silently.
    }
  } catch {
    WIRED.delete(ctx); // never let the guard outlive its own registration path.
  }

  gate(ctx, 'tools', registerSkillTool);
  gate(ctx, 'commands', registerCommands);
  gate(ctx, 'systemPrompt', registerBootstrapSection);
}

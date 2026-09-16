// Codex packaging lock suite for the `adapters` surface (.apex/standards/adapters.md).
//
// Locks the Codex-native packaging trio introduced by T6 of the
// native-multi-harness-plugins plan: `.codex-plugin/plugin.json` (the Codex plugin
// manifest), `.agents/plugins/marketplace.json` (the repo-level marketplace file that
// enables `codex plugin marketplace add <owner>/<repo>` / `add ./local-checkout`), and
// `hooks/hooks-codex.json` (the Codex-native Stop-hook manifest, `$PLUGIN_ROOT` instead
// of Claude's `${CLAUDE_PLUGIN_ROOT}`). The existing Claude packaging
// (`.claude-plugin/plugin.json`, `hooks/hooks.json`) is untouched by this task; it is
// read here only to assert the three-way version lockstep.
import { test, describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, existsSync, statSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, isAbsolute, relative, sep as pathSep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CLAUDE_ALLOWED_TOOLS, CODEX_MODEL_MAPPING_SOURCE, headlessCommand,
} from '../adapters/headless.mjs';
import { sessionStoreDescriptor } from '../adapters/session-store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
}

// Manifest-declared relative paths (`./skills/`, `./hooks/...`, marketplace `source`)
// are relative to the plugin root — i.e. the repo root, since `.codex-plugin/` and
// `.agents/plugins/` are metadata subfolders, not the plugin root themselves (mirrors
// the shipped superpowers `.codex-plugin/plugin.json` reference, where `skills` is a
// sibling of `.codex-plugin/`, both at the plugin root).
function resolveFromRoot(relativePath) {
  return join(root, relativePath);
}

test('.codex-plugin/plugin.json parses and carries non-empty name/version/description, in three-way version lockstep', () => {
  const pkg = readJson('package.json');
  const claudePlugin = readJson('.claude-plugin/plugin.json');
  const codexPlugin = readJson('.codex-plugin/plugin.json');

  assert.equal(codexPlugin.name, 'steepy-apex');
  assert.ok(codexPlugin.description && codexPlugin.description.length > 0, 'description must be non-empty');
  assert.equal(codexPlugin.description, claudePlugin.description);

  assert.match(codexPlugin.version, /^\d+\.\d+\.\d+$/);
  assert.equal(
    codexPlugin.version,
    pkg.version,
    '.codex-plugin/plugin.json version must stay in lockstep with package.json'
  );
  assert.equal(
    codexPlugin.version,
    claudePlugin.version,
    '.codex-plugin/plugin.json version must stay in lockstep with .claude-plugin/plugin.json'
  );
  assert.equal(
    pkg.version,
    claudePlugin.version,
    'sanity: package.json and .claude-plugin/plugin.json must already be in lockstep'
  );
});

test('.codex-plugin/plugin.json declares the interface block the marketplace listing needs', () => {
  const codexPlugin = readJson('.codex-plugin/plugin.json');

  assert.ok(codexPlugin.interface, 'plugin.json must declare an interface block');
  assert.ok(
    codexPlugin.interface.displayName && codexPlugin.interface.displayName.length > 0,
    'interface.displayName must be non-empty'
  );
  assert.ok(
    codexPlugin.interface.category && codexPlugin.interface.category.length > 0,
    'interface.category must be non-empty'
  );
  assert.ok(
    Array.isArray(codexPlugin.interface.capabilities) && codexPlugin.interface.capabilities.length > 0,
    'interface.capabilities must be a non-empty list'
  );
});

test('.codex-plugin/plugin.json ships one square 512px PNG for its logo and composer icon', () => {
  const codexPlugin = readJson('.codex-plugin/plugin.json');
  const { logo, composerIcon } = codexPlugin.interface;

  assert.equal(logo, './assets/plugin-icon.png');
  assert.equal(composerIcon, logo, 'logo and composer icon must reuse the same branded asset');

  const png = readFileSync(resolveFromRoot(logo));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'asset must be a PNG');
  assert.equal(png.readUInt32BE(16), 512, 'plugin icon width must be 512px');
  assert.equal(png.readUInt32BE(20), 512, 'plugin icon height must be 512px');
});

test('every ./-relative path .codex-plugin/plugin.json references (skills, hooks) exists in the repo', () => {
  const codexPlugin = readJson('.codex-plugin/plugin.json');

  assert.ok(codexPlugin.skills, 'plugin.json must declare a skills path');
  const skillsPath = resolveFromRoot(codexPlugin.skills);
  assert.ok(existsSync(skillsPath), `skills path ${codexPlugin.skills} does not exist`);
  assert.ok(statSync(skillsPath).isDirectory(), `skills path ${codexPlugin.skills} must be a directory`);

  assert.ok(codexPlugin.hooks, 'plugin.json must declare a hooks path');
  const hooksPath = resolveFromRoot(codexPlugin.hooks);
  assert.ok(existsSync(hooksPath), `hooks path ${codexPlugin.hooks} does not exist`);
  assert.ok(statSync(hooksPath).isFile(), `hooks path ${codexPlugin.hooks} must be a file`);
});

test('.agents/plugins/marketplace.json parses and lists the steepy-apex plugin with a resolvable local source', () => {
  const marketplace = readJson('.agents/plugins/marketplace.json');

  assert.ok(Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0, 'marketplace must list at least one plugin');
  const entry = marketplace.plugins.find((p) => p.name === 'steepy-apex');
  assert.ok(entry, 'marketplace must list a plugin named steepy-apex');
  assert.ok(entry.source, 'the steepy-apex marketplace entry must declare a source');

  const sourcePath = resolveFromRoot(entry.source);
  assert.ok(
    existsSync(sourcePath),
    `marketplace source ${entry.source} must resolve to an existing repo path`
  );
});

test('hooks/hooks-codex.json parses, uses $PLUGIN_ROOT (never CLAUDE_*), and points at an existing stop-hook script', () => {
  const hooksCodex = readJson('hooks/hooks-codex.json');

  const commands = (hooksCodex.hooks?.Stop ?? [])
    .flatMap((entry) => entry.hooks ?? [])
    .filter((h) => h.type === 'command')
    .map((h) => h.command);
  assert.ok(commands.length > 0, 'expected at least one Stop command hook');

  for (const command of commands) {
    assert.match(command, /\$PLUGIN_ROOT/, `hook command must reference $PLUGIN_ROOT: ${command}`);
    assert.doesNotMatch(command, /CLAUDE_/, `Codex hook command must never reference CLAUDE_*: ${command}`);
  }

  assert.ok(existsSync(join(root, 'scripts', 'stop-hook.mjs')), 'scripts/stop-hook.mjs must exist');
});

test("hooks/hooks.json (Claude packaging) stays untouched by the Codex packaging task", () => {
  // Guards the adapters standard's boundary: Claude's hook manifest is separate
  // packaging and keeps its own env var; this task must not fold the two together.
  const claudeHooks = readJson('hooks/hooks.json');
  const commands = (claudeHooks.hooks?.Stop ?? [])
    .flatMap((entry) => entry.hooks ?? [])
    .filter((h) => h.type === 'command')
    .map((h) => h.command);
  assert.ok(commands.length > 0, 'expected at least one Stop command hook');
  for (const command of commands) {
    assert.match(command, /\$\{CLAUDE_PLUGIN_ROOT\}/, `Claude hook command must keep \${CLAUDE_PLUGIN_ROOT}: ${command}`);
  }
});

// ---------------------------------------------------------------------------
// T7 — OpenCode adapter (adapters/opencode/steepy-apex.js).
//
// The adapter is unit-tested in-process (no OpenCode runtime): its plugin
// function returns hooks, and each hook is a pure mutation of the config /
// message objects the host would hand it. The surface standard's core rule is
// fail-open — every optional host API is behind a capability check and the
// module no-ops safely on a stub or frozen context.
// ---------------------------------------------------------------------------
describe('opencode adapter (adapters/opencode/steepy-apex.js)', () => {
  const modulePath = join(root, 'adapters', 'opencode', 'steepy-apex.js');
  const skillsDir = join(root, 'skills');
  const bootstrapMarker = 'steepy-apex:bootstrap';
  const transformHook = 'experimental.chat.messages.transform';
  const skillNames = [
    'init', 'check', 'new-surface', 'discovery', 'brainstorm',
    'plan', 'implement', 'review', 'loop-engineer',
  ];

  let mod;
  before(async () => {
    mod = await import(pathToFileURL(modulePath));
  });

  it('imports cleanly and exports SteepyApex as an async function', () => {
    assert.equal(typeof mod.SteepyApex, 'function');
    assert.equal(mod.SteepyApex.constructor.name, 'AsyncFunction');
  });

  it('returns config + message-transform hooks from a stub context', async () => {
    const hooks = await mod.SteepyApex({ directory: root, project: {}, client: {} });
    assert.equal(typeof hooks.config, 'function');
    assert.equal(typeof hooks[transformHook], 'function');
  });

  it('config hook pushes the resolved skills/ dir (absolute, on disk, this repo)', async () => {
    const hooks = await mod.SteepyApex({});
    const config = {};
    await hooks.config(config);

    assert.ok(Array.isArray(config.skills?.paths), 'config.skills.paths must be an array');
    assert.ok(config.skills.paths.includes(skillsDir), 'skills dir must be registered');
    const pushed = config.skills.paths.find((p) => p === skillsDir);
    assert.ok(isAbsolute(pushed), 'registered skills path must be absolute');
    assert.ok(existsSync(pushed), 'registered skills path must exist on disk');
    assert.ok(statSync(pushed).isDirectory(), 'registered skills path must be a directory');
    assert.equal(pushed, skillsDir, "registered skills path must point at this repo's skills/");
  });

  it('config hook is idempotent — a second call does not duplicate the skills path', async () => {
    const hooks = await mod.SteepyApex({});
    const config = {};
    await hooks.config(config);
    await hooks.config(config);
    const hits = config.skills.paths.filter((p) => p === skillsDir);
    assert.equal(hits.length, 1);
  });

  it('config hook registers nine steepy-apex-<skill> commands with $ARGUMENTS when the host exposes a command map', async () => {
    const hooks = await mod.SteepyApex({});
    const config = { command: {} };
    await hooks.config(config);

    for (const name of skillNames) {
      const key = `steepy-apex-${name}`;
      assert.ok(config.command[key], `command ${key} must be registered`);
      assert.equal(typeof config.command[key].template, 'string');
      assert.match(config.command[key].template, /\$ARGUMENTS/, `${key} template must pass $ARGUMENTS through`);
      assert.match(config.command[key].template, new RegExp(name.replace(/[-]/g, '\\-')), `${key} template must name the ${name} skill`);
    }
    assert.equal(Object.keys(config.command).length, skillNames.length, 'exactly nine commands');
  });

  it('config hook does not overwrite an existing same-named command', async () => {
    const hooks = await mod.SteepyApex({});
    const config = { command: { 'steepy-apex-init': { template: 'CUSTOM $ARGUMENTS' } } };
    await hooks.config(config);
    assert.equal(config.command['steepy-apex-init'].template, 'CUSTOM $ARGUMENTS', 'existing command preserved');
    assert.ok(config.command['steepy-apex-review'], 'other commands still registered');
  });

  it('config hook fails open on a frozen config — no throw, no partial state', async () => {
    const hooks = await mod.SteepyApex({});
    const frozen = Object.freeze({});
    await assert.doesNotReject(async () => hooks.config(frozen));
    assert.deepEqual(Object.keys(frozen), [], 'frozen config must be left untouched');
  });

  it('message-transform hook injects the marker-guarded bootstrap block exactly once', async () => {
    const hooks = await mod.SteepyApex({});
    const transform = hooks[transformHook];
    const output = {
      messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'first task' }] }],
    };

    await transform({}, output);
    const parts = output.messages[0].parts;
    assert.equal(parts.length, 2, 'a bootstrap part is prepended');
    assert.equal(parts[0].type, 'text');
    assert.match(parts[0].text, new RegExp(bootstrapMarker), 'block carries the marker');
    // block content: generic project instructions + invocation ergonomics + D1..D4 notes.
    assert.ok(parts[0].text.includes(root), 'block states the resolved engine-root path');
    assert.match(parts[0].text, /AGENTS\.md[\s\S]*root[\s\S]*project/i, 'block orders root AGENTS.md instructions');
    assert.match(parts[0].text, /\.agents\/skills/, 'block locates the canonical bootstrap generically');
    assert.match(parts[0].text, /\.apex\/_INDEX\.md/, 'block retains the navigation fallback');
    assert.match(parts[0].text, /inline[\s\S]*standard/i, 'missing bootstrap declares inline-standard degradation');
    assert.doesNotMatch(parts[0].text, /steepy-apex-bootstrap/, 'bootstrap name is never hardcoded');
    assert.match(parts[0].text, /steepy-apex-/, 'block names the steepy-apex-<skill> commands');
    assert.match(
      parts[0].text,
      /Per-dispatch tier choice \(D2\): available with a pinned provider/,
      'block records the D2 pinned-provider mechanism',
    );
    assert.ok(parts[0].text.includes('`opencode.json`'), 'D2 names where to pin the model');
    assert.match(parts[0].text, /steepy-standard/, 'D2 names the steepy-standard tier agent');
    assert.match(
      parts[0].text,
      /hub surface agents register at their[\s\S]*?frontmatter tier \(agent-static\)/,
      'D2 states that hub surface agents are registered agent-static, not per-dispatch',
    );
    assert.match(
      parts[0].text,
      /when a task's Complexity tier differs from the dispatched surface[\s\S]*?agent's registered tier, dispatch the matching `steepy-<tier>` agent/,
      'D2 states the tier-mismatch → steepy-<tier> reconciliation rule',
    );
    assert.match(
      parts[0].text,
      /record the specialist-prompt degradation in the ledger/,
      'the reconciliation rule declares its ledger degradation',
    );
    assert.match(parts[0].text, /degrades to the session model/, 'D2 declares the no-pin degradation');
    assert.match(parts[0].text, /validate-hub/, 'block records the coherence-gate approximation (D4)');

    await transform({}, output);
    assert.equal(output.messages[0].parts.length, 2, 'second pass over marked content is a no-op');
  });

  it('owns injected bootstrap parts by adapter identity, never by user-controlled marker text', async () => {
    const hooks = await mod.SteepyApex({});
    const transform = hooks[transformHook];
    const forged = `user evidence includes <!-- ${bootstrapMarker} --> but is not adapter-owned`;
    const output = {
      messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: forged }] }],
    };

    await transform({}, output);
    assert.equal(output.messages[0].parts.length, 2, 'a forged public marker cannot suppress injection');
    await transform({}, output);
    assert.equal(output.messages[0].parts.length, 2, 'the adapter recognizes its own part on a repeated projection');

    const nextProjection = {
      messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: forged }] }],
    };
    await transform({}, nextProjection);
    assert.equal(nextProjection.messages[0].parts.length, 2, 'a new host projection receives its own injected part');
  });

  it('injected bootstrap part is a fresh minimal part — no fields leaked from the host part', async () => {
    const hooks = await mod.SteepyApex({});
    const transform = hooks[transformHook];
    const output = {
      messages: [{
        info: { role: 'user' },
        parts: [{ type: 'text', text: 'first task', id: 'prt_host_1', partID: 'prt_host_1', messageID: 'msg_1' }],
      }],
    };

    await transform({}, output);
    const injected = output.messages[0].parts[0];
    assert.deepEqual(
      Object.keys(injected).sort(),
      ['text', 'type'],
      'injected part must carry exactly type + text — no id/partID/messageID inherited from the host part',
    );
  });

  it('message-transform hook fails open on a frozen parts array — no throw, content unchanged', async () => {
    const hooks = await mod.SteepyApex({});
    const transform = hooks[transformHook];
    const frozenParts = Object.freeze([{ type: 'text', text: 'first task' }]);
    const output = { messages: [{ info: { role: 'user' }, parts: frozenParts }] };

    await assert.doesNotReject(() => transform({}, output));
    assert.equal(output.messages[0].parts.length, 1, 'frozen parts must be left untouched');
    assert.equal(output.messages[0].parts[0].text, 'first task');
  });

  it('every returned hook is exception-safe with the emptiest plausible arguments', async () => {
    const hooks = await mod.SteepyApex();
    await assert.doesNotReject(() => hooks.config({}));
    await assert.doesNotReject(() => hooks.config(Object.freeze({})));
    await assert.doesNotReject(() => hooks.config(undefined));
    const transform = hooks[transformHook];
    await assert.doesNotReject(() => transform({}, undefined));
    await assert.doesNotReject(() => transform({}, {}));
    await assert.doesNotReject(() => transform({}, { messages: [] }));
    await assert.doesNotReject(() => transform(undefined, { messages: [{ info: { role: 'assistant' }, parts: [] }] }));
  });

  it('package.json main/exports resolve to the plugin module file', () => {
    const pkg = readJson('package.json');
    const rel = './adapters/opencode/steepy-apex.js';
    const mainOk = pkg.main === rel;
    const exportOk =
      pkg.exports &&
      (pkg.exports === rel ||
        pkg.exports['.'] === rel ||
        (pkg.exports['.'] && pkg.exports['.'].default === rel) ||
        (pkg.exports['.'] && pkg.exports['.'].import === rel));
    assert.ok(mainOk || exportOk, 'package.json must point main/exports at the OpenCode plugin module');
    assert.ok(existsSync(modulePath), 'the plugin module file must exist');
  });
});

// ---------------------------------------------------------------------------
// Task 2 — OpenCode adapter D2 agent registration
// (adapters/opencode/steepy-apex.js × adapters/model-mappings.mjs).
//
// The config hook registers dispatchable subagents when the session model is a
// pinned provider/model id: the tier trio (steepy-cheap / steepy-standard /
// steepy-most-capable) with the provider's concrete ids, plus (further below)
// the project hub's surface agents from <project>/.opencode/agents/*.md —
// only when <project>/.apex exists. Everything fails open: a stub, frozen, or
// unpinned host config never throws and never leaves a partial trio. Fixtures
// are hermetic mkdtemp projects, never the repo itself.
// ---------------------------------------------------------------------------
describe('opencode adapter agent registration (D2 tier dispatch)', () => {
  const modulePath = join(root, 'adapters', 'opencode', 'steepy-apex.js');
  const pin = 'zai-coding-plan/glm-5.3';
  const tierAgentIds = {
    'steepy-cheap': 'zai-coding-plan/glm-5.3-flash',
    'steepy-standard': 'zai-coding-plan/glm-5.3-highspeed',
    'steepy-most-capable': 'zai-coding-plan/glm-5.3',
  };

  let mod;
  before(async () => {
    mod = await import(pathToFileURL(modulePath));
  });

  function tempProject(suffix) {
    return realpathSync(mkdtempSync(join(tmpdir(), `steepy-opencode-${suffix}-`)));
  }

  function writeAgentFile(project, file, frontmatter, body) {
    mkdirSync(join(project, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(project, '.claude', 'agents', file), `---\n${frontmatter}\n---\n${body}`);
  }

  function writeOpenCodeAgentFile(project, file, frontmatter, body) {
    mkdirSync(join(project, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(project, '.opencode', 'agents', file), `---\n${frontmatter}\n---\n${body}`);
  }

  it('a mapped session-model pin registers the tier trio with concrete models, mode subagent', async () => {
    const dir = tempProject('trio');
    try {
      const hooks = await mod.SteepyApex({ directory: dir });
      const config = { model: pin };
      await hooks.config(config);

      for (const [name, model] of Object.entries(tierAgentIds)) {
        const tier = name.slice('steepy-'.length);
        const entry = config.agent?.[name];
        assert.ok(entry, `${name} must be registered into config.agent`);
        assert.equal(entry.mode, 'subagent', `${name} must be a subagent`);
        assert.equal(entry.model, model, `${name} must carry the provider's concrete ${tier} id`);
        assert.equal(
          entry.prompt,
          `steepy-apex dispatched specialist at tier ${tier}; follow the brief`,
          `${name} prompt names its tier`,
        );
        assert.equal(typeof entry.description, 'string', `${name} must carry a description`);
        assert.ok(entry.description.length > 0, `${name} description must be non-empty`);
      }
      assert.equal(Object.keys(config.agent).length, 3, 'exactly the trio registers in an empty project');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no model key → no tier entries, no throw', async () => {
    const dir = tempProject('nomodel');
    try {
      const hooks = await mod.SteepyApex({ directory: dir });
      const config = {};
      await assert.doesNotReject(() => hooks.config(config));
      assert.equal(config.agent, undefined, 'nothing tier-related registers without a model pin');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("model: 'unknown/foo' → no tier entries, no throw", async () => {
    const dir = tempProject('unknown');
    try {
      const hooks = await mod.SteepyApex({ directory: dir });
      const config = { model: 'unknown/foo' };
      await assert.doesNotReject(() => hooks.config(config));
      assert.equal(config.agent, undefined, 'an unmapped provider prefix registers nothing tier-related');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a frozen config with a pin → no throw, no partial trio', async () => {
    const dir = tempProject('frozen');
    try {
      const hooks = await mod.SteepyApex({ directory: dir });
      const frozen = Object.freeze({ model: pin });
      await assert.doesNotReject(() => hooks.config(frozen));
      assert.deepEqual(Object.keys(frozen), ['model'], 'frozen config must be left untouched');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a frozen agent map → no throw, no partial trio', async () => {
    const dir = tempProject('frozenmap');
    try {
      const hooks = await mod.SteepyApex({ directory: dir });
      const agent = Object.freeze({});
      const config = { model: pin, agent };
      await assert.doesNotReject(() => hooks.config(config));
      assert.deepEqual(Object.keys(agent), [], 'a frozen agent map stays empty — no partial trio');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an existing steepy-standard entry is never overwritten', async () => {
    const dir = tempProject('keep');
    try {
      const hooks = await mod.SteepyApex({ directory: dir });
      const config = {
        model: pin,
        agent: { 'steepy-standard': { mode: 'primary', model: 'custom/x' } },
      };
      await hooks.config(config);
      assert.deepEqual(
        config.agent['steepy-standard'],
        { mode: 'primary', model: 'custom/x' },
        'an existing same-named agent entry is preserved',
      );
      assert.ok(config.agent['steepy-cheap'], 'the other trio entries still register');
      assert.ok(config.agent['steepy-most-capable'], 'the other trio entries still register');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -- project hub agents (<project>/.opencode/agents/*.md, gated on .apex) --

  it('registers a project hub agent under its native filename on the tier-mapped concrete model', async () => {
    const dir = tempProject('hub');
    try {
      mkdirSync(join(dir, '.apex'), { recursive: true });
      writeOpenCodeAgentFile(dir, 'adapters-agent.md', 'description: Adapters specialist\nmode: subagent\nmodel: sonnet', 'You specialize in adapters work for `adapters`.');
      const hooks = await mod.SteepyApex({ directory: dir });
      const config = { model: pin };
      await hooks.config(config);

      const entry = config.agent?.['adapters-agent'];
      assert.ok(entry, 'the hub agent registers under its native filename');
      assert.equal(entry.mode, 'subagent');
      assert.equal(entry.model, 'zai-coding-plan/glm-5.3-highspeed', 'sonnet maps to the provider standard-tier id');
      assert.equal(entry.prompt, 'You specialize in adapters work for `adapters`.', 'the file body is the prompt');
      assert.equal(Object.keys(config.agent).length, 4, 'trio + the one hub agent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers native .opencode/agents thin syntax over Claude .claude/agents', async () => {
    const dir = tempProject('native-first');
    try {
      mkdirSync(join(dir, '.apex'), { recursive: true });
      writeAgentFile(dir, 'adapters-agent.md', 'name: adapters-agent\nmodel: sonnet', 'Claude prompt.');
      writeOpenCodeAgentFile(
        dir,
        'adapters-agent.md',
        'description: Native adapters specialist\nmode: subagent\nmodel: sonnet',
        'Native prompt.',
      );
      const hooks = await mod.SteepyApex({ directory: dir });
      const config = { model: pin };
      await hooks.config(config);
      assert.equal(config.agent?.['adapters-agent']?.prompt, 'Native prompt.');
      assert.equal(config.agent?.['adapters-agent']?.model, 'zai-coding-plan/glm-5.3-highspeed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not fall back to Claude agents when present native directory is invalid', async () => {
    const dir = tempProject('native-invalid');
    try {
      mkdirSync(join(dir, '.apex'), { recursive: true });
      writeAgentFile(dir, 'adapters-agent.md', 'name: adapters-agent\nmodel: sonnet', 'Claude prompt.');
      mkdirSync(join(dir, '.opencode', 'agents'), { recursive: true });
      writeFileSync(join(dir, '.opencode', 'agents', 'adapters-agent.md'), 'invalid native agent');
      const hooks = await mod.SteepyApex({ directory: dir });
      const config = { model: pin };
      await hooks.config(config);
      assert.equal(config.agent?.['adapters-agent'], undefined, 'invalid native layout must not select Claude');
      assert.equal(Object.keys(config.agent).length, 3, 'only the tier trio remains');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats native symlink layouts, including dangling links, as invalid rather than absent', async () => {
    for (const dangling of [false, true]) {
      const dir = tempProject(dangling ? 'native-dangling-link' : 'native-dir-link');
      const external = tempProject('native-external');
      try {
        mkdirSync(join(dir, '.apex'), { recursive: true });
        writeAgentFile(dir, 'adapters-agent.md', 'name: adapters-agent\nmodel: sonnet', 'Claude prompt.');
        mkdirSync(join(dir, '.opencode'), { recursive: true });
        if (!dangling) {
          mkdirSync(join(external, 'agents'));
          writeFileSync(
            join(external, 'agents', 'adapters-agent.md'),
            '---\ndescription: External\nmode: subagent\nmodel: sonnet\n---\nExternal prompt.',
          );
        }
        symlinkSync(
          dangling ? join(external, 'missing-agents') : join(external, 'agents'),
          join(dir, '.opencode', 'agents'),
          'dir',
        );
        const hooks = await mod.SteepyApex({ directory: dir });
        const config = { model: pin };
        await hooks.config(config);
        assert.equal(config.agent?.['adapters-agent'], undefined, 'unsafe native namespace must select neither native nor Claude');
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(external, { recursive: true, force: true });
      }
    }
  });

  it('rejects an intermediate symlink in the host project path without selecting native or Claude agents', async () => {
    const targetRoot = tempProject('project-path-target');
    const lexicalRoot = tempProject('project-path-lexical');
    const project = join(targetRoot, 'project');
    try {
      mkdirSync(join(project, '.apex'), { recursive: true });
      writeOpenCodeAgentFile(
        project,
        'native-agent.md',
        'description: Native through unsafe ancestor\nmode: subagent\nmodel: sonnet',
        'Native external prompt.',
      );
      writeAgentFile(
        project,
        'claude-agent.md',
        'name: claude-agent\nmodel: sonnet',
        'Claude external prompt.',
      );
      symlinkSync(targetRoot, join(lexicalRoot, 'alias'), 'dir');
      const logs = [];
      const hooks = await mod.SteepyApex({
        directory: join(lexicalRoot, 'alias', 'project'),
        client: { app: { log(entry) { logs.push(entry); } } },
      });
      const config = { model: pin };
      await assert.doesNotReject(() => hooks.config(config));
      assert.equal(config.agent?.['native-agent'], undefined, 'native discovery cannot cross a project-path symlink');
      assert.equal(config.agent?.['claude-agent'], undefined, 'an unsafe project ancestor never selects Claude fallback');
      assert.equal(logs.length, 1, 'one bounded fail-open warning identifies the unsafe ancestor');
      assert.match(logs[0].body?.message ?? '', /unsafe-directory-ancestor/);
      assert.ok(logs[0].body.message.length <= 256);
    } finally {
      rmSync(lexicalRoot, { recursive: true, force: true });
      rmSync(targetRoot, { recursive: true, force: true });
    }
  });

  it('rejects a native project path whose symlink ancestor is canceled by parent traversal', async () => {
    const fixture = tempProject('parent-native');
    const lexicalProject = join(fixture, 'lexical', 'project');
    const physicalProject = join(fixture, 'physical', 'project');
    const physicalChild = join(fixture, 'physical', 'child');
    try {
      mkdirSync(join(lexicalProject, '.apex'), { recursive: true });
      mkdirSync(join(physicalProject, '.apex'), { recursive: true });
      mkdirSync(physicalChild, { recursive: true });
      writeOpenCodeAgentFile(
        lexicalProject,
        'probe.md',
        'description: Lexical alternate\nmode: subagent',
        'LEXICAL ALTERNATE',
      );
      writeOpenCodeAgentFile(
        physicalProject,
        'probe.md',
        'description: Actual physical project\nmode: subagent',
        'ACTUAL PROJECT',
      );
      symlinkSync(physicalChild, join(fixture, 'lexical', 'alias'), 'dir');
      const supplied = `${join(fixture, 'lexical', 'alias')}${pathSep}..${pathSep}project`;
      assert.match(
        readFileSync(`${supplied}${pathSep}.opencode${pathSep}agents${pathSep}probe.md`, 'utf8'),
        /ACTUAL PROJECT/,
        'the raw OS path reaches the physical project, not the lexical alternate',
      );

      const logs = [];
      const hooks = await mod.SteepyApex({
        directory: supplied,
        client: { app: { log(entry) { logs.push(entry); } } },
      });
      const config = {};
      await assert.doesNotReject(() => hooks.config(config));

      assert.equal(config.agent?.probe, undefined, 'unsafe parent traversal selects neither native project');
      assert.equal(logs.length, 1, 'the rejected supplied path emits one fail-open warning');
      assert.match(logs[0].body?.message ?? '', /unsafe-parent-traversal/);
      assert.ok(logs[0].body.message.length <= 256);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('rejects a Claude project path whose symlink ancestor is canceled by parent traversal', async () => {
    const fixture = tempProject('parent-claude');
    const lexicalProject = join(fixture, 'lexical', 'project');
    const physicalProject = join(fixture, 'physical', 'project');
    const physicalChild = join(fixture, 'physical', 'child');
    try {
      mkdirSync(join(lexicalProject, '.apex'), { recursive: true });
      mkdirSync(join(physicalProject, '.apex'), { recursive: true });
      mkdirSync(physicalChild, { recursive: true });
      writeAgentFile(
        lexicalProject,
        'probe-agent.md',
        'name: probe',
        'LEXICAL ALTERNATE',
      );
      writeAgentFile(
        physicalProject,
        'probe-agent.md',
        'name: probe',
        'ACTUAL PROJECT',
      );
      symlinkSync(physicalChild, join(fixture, 'lexical', 'alias'), 'dir');
      const supplied = `${join(fixture, 'lexical', 'alias')}${pathSep}..${pathSep}project`;
      assert.match(
        readFileSync(`${supplied}${pathSep}.claude${pathSep}agents${pathSep}probe-agent.md`, 'utf8'),
        /ACTUAL PROJECT/,
        'the raw OS path reaches the physical Claude project, not the lexical alternate',
      );

      const logs = [];
      const hooks = await mod.SteepyApex({
        directory: supplied,
        client: { app: { log(entry) { logs.push(entry); } } },
      });
      const config = {};
      await assert.doesNotReject(() => hooks.config(config));

      assert.equal(config.agent?.probe, undefined, 'unsafe parent traversal never selects Claude fallback');
      assert.equal(logs.length, 1, 'the rejected supplied path emits one fail-open warning');
      assert.match(logs[0].body?.message ?? '', /unsafe-parent-traversal/);
      assert.ok(logs[0].body.message.length <= 256);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('rejects a canceled non-directory component before project-path normalization', async () => {
    const fixture = tempProject('parent-nondirectory');
    const project = join(fixture, 'project');
    try {
      mkdirSync(join(project, '.apex'), { recursive: true });
      writeOpenCodeAgentFile(
        project,
        'canceled-component.md',
        'description: Must not survive canceled component\nmode: subagent',
        'CANCELED NON-DIRECTORY',
      );
      writeFileSync(join(fixture, 'not-a-directory'), 'ordinary file');
      const supplied = `${join(fixture, 'not-a-directory')}${pathSep}..${pathSep}project`;
      const logs = [];
      const hooks = await mod.SteepyApex({
        directory: supplied,
        client: { app: { log(entry) { logs.push(entry); } } },
      });
      const config = {};
      await assert.doesNotReject(() => hooks.config(config));

      assert.equal(
        config.agent?.['canceled-component'],
        undefined,
        'normalization cannot erase a canceled non-directory component and admit the project',
      );
      assert.equal(logs.length, 1);
      assert.match(logs[0].body?.message ?? '', /unsafe-parent-traversal/);
      assert.ok(logs[0].body.message.length <= 256);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('supports relative project paths that contain no parent traversal', async () => {
    const fixture = realpathSync(mkdtempSync(join(process.cwd(), '.steepy-opencode-relative-')));
    const project = join(fixture, 'project');
    try {
      mkdirSync(join(project, '.apex'), { recursive: true });
      writeOpenCodeAgentFile(
        project,
        'relative-agent.md',
        'description: Safe relative project\nmode: subagent',
        'SAFE RELATIVE PROJECT',
      );
      const relativeProject = `.${pathSep}${relative(process.cwd(), project)}`;
      assert.equal(isAbsolute(relativeProject), false);
      assert.equal(relativeProject.split(pathSep).includes('..'), false);

      const hooks = await mod.SteepyApex({ directory: relativeProject });
      const config = {};
      await hooks.config(config);
      assert.equal(config.agent?.['relative-agent']?.prompt, 'SAFE RELATIVE PROJECT');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('preserves a literal-backslash POSIX project component when discovering native agents', async (t) => {
    if (process.platform === 'win32') {
      t.skip('Windows cannot represent a backslash as a filename character');
      return;
    }
    const fixture = tempProject('literal-backslash-native');
    const actualProject = join(fixture, 'project\\name');
    const alternateProject = join(fixture, 'project', 'name');
    try {
      mkdirSync(join(actualProject, '.apex'), { recursive: true });
      mkdirSync(join(alternateProject, '.apex'), { recursive: true });
      writeOpenCodeAgentFile(
        actualProject,
        'actual-native.md',
        'description: Actual project native specialist\nmode: subagent\nmodel: sonnet',
        'ACTUAL HOST PROJECT NATIVE',
      );
      writeOpenCodeAgentFile(
        alternateProject,
        'external-agent.md',
        'description: Slash-expanded alternate specialist\nmode: subagent\nmodel: sonnet',
        'OUTSIDE HOST PROJECT NATIVE',
      );

      const hooks = await mod.SteepyApex({ directory: actualProject });
      const config = { model: pin };
      await hooks.config(config);

      assert.equal(config.agent?.['actual-native']?.prompt, 'ACTUAL HOST PROJECT NATIVE');
      assert.equal(
        config.agent?.['external-agent'],
        undefined,
        'a POSIX backslash component must not be expanded into an alternate project tree',
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('does not use Claude agents for a literal-backslash POSIX project component', async (t) => {
    if (process.platform === 'win32') {
      t.skip('Windows cannot represent a backslash as a filename character');
      return;
    }
    const fixture = tempProject('literal-backslash-claude');
    const actualProject = join(fixture, 'project\\name');
    const alternateProject = join(fixture, 'project', 'name');
    try {
      mkdirSync(join(actualProject, '.apex'), { recursive: true });
      mkdirSync(join(alternateProject, '.apex'), { recursive: true });
      writeAgentFile(
        actualProject,
        'actual-claude-agent.md',
        'name: actual-claude-agent\nmodel: sonnet',
        'ACTUAL HOST PROJECT CLAUDE',
      );
      writeOpenCodeAgentFile(
        alternateProject,
        'external-agent.md',
        'description: Slash-expanded alternate specialist\nmode: subagent\nmodel: sonnet',
        'OUTSIDE HOST PROJECT NATIVE',
      );

      const hooks = await mod.SteepyApex({ directory: actualProject });
      const config = { model: pin };
      await hooks.config(config);

      assert.equal(config.agent?.['actual-claude-agent'], undefined);
      assert.equal(
        config.agent?.['external-agent'],
        undefined,
        'native absence in the real project must not redirect fallback through an alternate tree',
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('reads only descriptor-verified ordinary agent files and rejects links and files over 1 MiB', async () => {
    const dir = tempProject('descriptor-files');
    const external = tempProject('descriptor-external');
    try {
      mkdirSync(join(dir, '.apex'), { recursive: true });
      mkdirSync(join(dir, '.opencode', 'agents'), { recursive: true });
      const valid = '---\ndescription: Valid\nmode: subagent\nmodel: sonnet\n---\nValid prompt.';
      writeFileSync(join(dir, '.opencode', 'agents', 'valid-agent.md'), valid);
      writeFileSync(join(external, 'linked.md'), valid.replace('Valid prompt.', 'Linked prompt.'));
      symlinkSync(join(external, 'linked.md'), join(dir, '.opencode', 'agents', 'linked-agent.md'));
      writeFileSync(
        join(dir, '.opencode', 'agents', 'oversized-agent.md'),
        Buffer.alloc((1024 * 1024) + 1, 0x61),
      );

      const hooks = await mod.SteepyApex({ directory: dir });
      const config = { model: pin };
      await hooks.config(config);
      assert.equal(config.agent?.['valid-agent']?.prompt, 'Valid prompt.');
      assert.equal(config.agent?.['linked-agent'], undefined, 'agent-file symlinks are never read');
      assert.equal(config.agent?.['oversized-agent'], undefined, 'oversized descriptors are never read');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it('rejects a FIFO agent without blocking the adapter process', (t) => {
    const probe = spawnSync('mkfifo', ['--help'], { encoding: 'utf8' });
    if (probe.error?.code === 'ENOENT') {
      t.skip('mkfifo is unavailable');
      return;
    }
    const dir = tempProject('fifo');
    try {
      mkdirSync(join(dir, '.apex'), { recursive: true });
      mkdirSync(join(dir, '.opencode', 'agents'), { recursive: true });
      const fifo = join(dir, '.opencode', 'agents', 'blocked-agent.md');
      const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
      assert.equal(made.status, 0, made.stderr);
      const script = [
        `import { SteepyApex } from ${JSON.stringify(pathToFileURL(modulePath).href)};`,
        `const hooks = await SteepyApex({ directory: ${JSON.stringify(dir)} });`,
        `const config = { model: ${JSON.stringify(pin)} };`,
        'await hooks.config(config);',
        "if (config.agent?.['blocked-agent']) process.exit(3);",
      ].join('\n');
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        encoding: 'utf8',
        timeout: 1500,
      });
      assert.notEqual(result.error?.code, 'ETIMEDOUT', 'descriptor validation must not block opening a FIFO');
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps mixed filesystem and semantic diagnostics through the optional official host logger', async () => {
    const dir = tempProject('diagnostics');
    const external = tempProject('diagnostics-external');
    try {
      mkdirSync(join(dir, '.apex'), { recursive: true });
      mkdirSync(join(dir, '.opencode', 'agents'), { recursive: true });
      writeFileSync(join(external, 'agent.md'), 'not safe through a link');
      for (let i = 0; i < 6; i += 1) {
        symlinkSync(join(external, 'agent.md'), join(dir, '.opencode', 'agents', `bad-${i}-agent.md`));
      }
      for (let i = 0; i < 6; i += 1) {
        writeFileSync(join(dir, '.opencode', 'agents', `malformed-${i}-agent.md`), 'no frontmatter');
      }
      const logs = [];
      const client = { app: { log(entry) { logs.push(entry); } } };
      const hooks = await mod.SteepyApex({ directory: dir, client });
      const config = { model: pin };
      await assert.doesNotReject(() => hooks.config(config));
      assert.equal(logs.length, 8, 'mixed filesystem and semantic diagnostics are capped per config pass');
      for (const log of logs) {
        assert.equal(log.body?.service, 'steepy-apex');
        assert.equal(log.body?.level, 'warn');
        assert.ok(log.body?.message.length <= 256, 'diagnostic messages are bounded');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it('a string ctx.project property also drives project resolution', async () => {
    const dir = tempProject('hubproject');
    try {
      mkdirSync(join(dir, '.apex'), { recursive: true });
      writeOpenCodeAgentFile(dir, 'adapters-agent.md', 'description: Adapters specialist\nmode: subagent\nmodel: sonnet', 'Body via the project property.');
      const hooks = await mod.SteepyApex({ project: dir });
      const config = { model: pin };
      await hooks.config(config);
      assert.equal(config.agent?.['adapters-agent']?.model, 'zai-coding-plan/glm-5.3-highspeed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('inline frontmatter comments are stripped from field values', async () => {
    const dir = tempProject('comment');
    try {
      mkdirSync(join(dir, '.apex'), { recursive: true });
      writeOpenCodeAgentFile(
        dir,
        'adapters-agent.md',
        'description: Adapters specialist\nmode: subagent\nmodel: sonnet  # standard tier — implementation from a well-specified plan',
        'Body.',
      );
      const hooks = await mod.SteepyApex({ directory: dir });
      const config = { model: pin };
      await hooks.config(config);
      assert.equal(
        config.agent?.['adapters-agent']?.model,
        'zai-coding-plan/glm-5.3-highspeed',
        'the model word before the inline comment must map to its tier',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a project without .apex/ registers no project agents', async () => {
    const dir = tempProject('nohub');
    try {
      writeOpenCodeAgentFile(dir, 'adapters-agent.md', 'description: Adapters specialist\nmode: subagent\nmodel: sonnet', 'Body.');
      const hooks = await mod.SteepyApex({ directory: dir });
      const config = { model: pin };
      await hooks.config(config);
      assert.equal(config.agent?.['adapters-agent'], undefined, 'no project hub → no project agents');
      assert.equal(Object.keys(config.agent).length, 3, 'only the trio registers');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unparsable ordinary agent warns and skips without hiding a parsable sibling', async () => {
    const dir = tempProject('unparsable');
    try {
      mkdirSync(join(dir, '.apex'), { recursive: true });
      mkdirSync(join(dir, '.opencode', 'agents'), { recursive: true });
      writeFileSync(join(dir, '.opencode', 'agents', 'broken-agent.md'), 'this file has no frontmatter at all');
      writeOpenCodeAgentFile(dir, 'adapters-agent.md', 'description: Adapters specialist\nmode: subagent\nmodel: sonnet', 'Good body.');
      const logs = [];
      const hooks = await mod.SteepyApex({ directory: dir, client: { app: { log(entry) { logs.push(entry); } } } });
      const config = { model: pin };
      await assert.doesNotReject(() => hooks.config(config));
      assert.equal(config.agent?.['broken-agent'], undefined, 'an unparsable file registers nothing');
      assert.ok(config.agent?.['adapters-agent'], 'a parsable sibling still registers');
      assert.ok(
        logs.some((entry) => entry.body?.message.includes('descriptor-parse-failed')),
        'parse rejection emits a stable bounded reason code',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not read Claude descriptors when the OpenCode namespace is absent', async () => {
    const dir = tempProject('native-absent');
    try {
      mkdirSync(join(dir, '.apex'), { recursive: true });
      writeAgentFile(dir, 'ghost-agent.md', 'name: ghost-agent\nmodel: sonnet', 'Claude-only body.');
      const hooks = await mod.SteepyApex({ directory: dir });
      const config = { model: pin };
      await hooks.config(config);
      assert.equal(config.agent?.['ghost-agent'], undefined);
      assert.equal(Object.keys(config.agent).length, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a native descriptor with a non-subagent mode warns and skips while a valid sibling registers', async () => {
    const dir = tempProject('native-mode');
    try {
      mkdirSync(join(dir, '.apex'), { recursive: true });
      writeOpenCodeAgentFile(
        dir,
        'primary-agent.md',
        'description: Wrong mode\nmode: primary\nmodel: sonnet',
        'Wrong mode body.',
      );
      writeOpenCodeAgentFile(
        dir,
        'valid-agent.md',
        'description: Valid\nmode: subagent\nmodel: sonnet',
        'Valid body.',
      );
      const logs = [];
      const hooks = await mod.SteepyApex({ directory: dir, client: { app: { log(entry) { logs.push(entry); } } } });
      const config = { model: pin };
      await assert.doesNotReject(() => hooks.config(config));
      assert.equal(config.agent?.['primary-agent'], undefined, 'invalid native mode registers nothing');
      assert.equal(config.agent?.['valid-agent']?.prompt, 'Valid body.', 'valid sibling still registers');
      assert.ok(
        logs.some((entry) => entry.body?.message.includes('invalid-native-mode')),
        'invalid native mode emits a stable bounded reason code',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a non-tier frontmatter model registers without a model field (session-model degradation)', async () => {
    const dir = tempProject('nontier');
    try {
      mkdirSync(join(dir, '.apex'), { recursive: true });
      writeOpenCodeAgentFile(dir, 'custom-agent.md', 'description: Custom specialist\nmode: subagent\nmodel: glm-4.7', 'Custom body.');
      const hooks = await mod.SteepyApex({ directory: dir });
      const config = { model: pin };
      await hooks.config(config);
      const entry = config.agent?.['custom-agent'];
      assert.ok(entry, 'a non-tier agent still registers');
      assert.ok(!('model' in entry), 'no model field — dispatch degrades to the session model');
      assert.equal(entry.mode, 'subagent');
      assert.equal(entry.prompt, 'Custom body.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a tier-word frontmatter model without a mapped provider pin registers without a model field', async () => {
    const dir = tempProject('nopin');
    try {
      mkdirSync(join(dir, '.apex'), { recursive: true });
      writeOpenCodeAgentFile(dir, 'adapters-agent.md', 'description: Adapters specialist\nmode: subagent\nmodel: sonnet', 'Body without a pin.');
      const hooks = await mod.SteepyApex({ directory: dir });
      const config = {}; // no model pin
      await assert.doesNotReject(() => hooks.config(config));
      const entry = config.agent?.['adapters-agent'];
      assert.ok(entry, 'project agents still register without a pin (degraded, not dropped)');
      assert.ok(!('model' in entry), 'no concrete model without a mapped provider pin');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an existing project-agent entry is never overwritten', async () => {
    const dir = tempProject('keepagent');
    try {
      mkdirSync(join(dir, '.apex'), { recursive: true });
      writeOpenCodeAgentFile(dir, 'adapters-agent.md', 'description: Adapters specialist\nmode: subagent\nmodel: sonnet', 'File body.');
      const hooks = await mod.SteepyApex({ directory: dir });
      const config = { model: pin, agent: { 'adapters-agent': { mode: 'subagent', prompt: 'HOST-OWNED' } } };
      await hooks.config(config);
      assert.deepEqual(
        config.agent['adapters-agent'],
        { mode: 'subagent', prompt: 'HOST-OWNED' },
        'a host-owned same-named agent entry is preserved',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// T8 — Pi adapter (adapters/pi/steepy-apex.js).
//
// The adapter is a default-exported Pi extension factory: it registers
// ergonomic wrapper commands and a session_start bootstrap-injection handler as
// side effects on the Pi ExtensionAPI it receives. It is unit-tested in-process
// with a stub `pi` (no Pi runtime). The surface standard's core rule is
// fail-open — every optional host API is behind a capability check and the
// module no-ops safely on a stub or empty context. It mirrors the OpenCode
// adapter's layout, fail-open idioms, and marker-guard naming.
// ---------------------------------------------------------------------------
describe('pi adapter (adapters/pi/steepy-apex.js)', () => {
  const modulePath = join(root, 'adapters', 'pi', 'steepy-apex.js');
  const skillsDir = join(root, 'skills');
  const bootstrapMarker = 'steepy-apex:bootstrap';
  const skillNames = [
    'init', 'check', 'new-surface', 'discovery', 'brainstorm',
    'plan', 'implement', 'review', 'loop-engineer',
  ];

  // A minimal stub of the Pi ExtensionAPI + event context. `sendMessage`
  // reflects into the session entries so the marker-guard scan can observe it,
  // exactly as a real host would persist the injected block.
  function makePi(caps = {}) {
    const state = { commands: {}, handlers: {}, sent: [], entries: [] };
    const pi = {};
    if (caps.registerCommand !== false) {
      pi.registerCommand = (name, spec) => { state.commands[name] = spec; };
    }
    if (caps.on !== false) {
      pi.on = (event, handler) => { (state.handlers[event] ??= []).push(handler); };
    }
    if (caps.sendMessage !== false) {
      pi.sendMessage = (msg) => {
        state.sent.push({ kind: 'message', msg });
        state.entries.push({ type: 'custom_message', customType: msg?.customType, content: msg?.content });
      };
    }
    if (caps.sendUserMessage !== false) {
      pi.sendUserMessage = (text) => { state.sent.push({ kind: 'user', text }); };
    }
    const ctx = { sessionManager: { getEntries: () => state.entries }, ui: { notify() {} } };
    return { pi, ctx, state };
  }

  async function fireSessionStart(state, ctx, event = { reason: 'startup' }) {
    for (const h of state.handlers.session_start ?? []) await h(event, ctx);
  }

  let mod;
  before(async () => {
    mod = await import(pathToFileURL(modulePath));
  });

  it('imports cleanly without a Pi runtime and default-exports a function (no side effects on import)', () => {
    // A top-level side effect that threw would have failed the `before` import.
    assert.equal(typeof mod.default, 'function', 'default export must be a function');
  });

  it('the default factory no-ops (no throw) on a stub / empty context', () => {
    assert.doesNotThrow(() => mod.default());
    assert.doesNotThrow(() => mod.default({}));
    assert.doesNotThrow(() => mod.default(Object.freeze({})));
  });

  it('registers nine /steepy-<skill> wrapper commands when registerCommand is present', () => {
    const { pi, state } = makePi();
    mod.default(pi);
    for (const name of skillNames) {
      const key = `steepy-${name}`;
      assert.ok(state.commands[key], `command /${key} must be registered`);
      assert.equal(typeof state.commands[key].handler, 'function', `${key} must carry a handler`);
      assert.ok(state.commands[key].description, `${key} must carry a description`);
    }
    assert.equal(Object.keys(state.commands).length, skillNames.length, 'exactly nine wrapper commands');
  });

  it('a /steepy-<skill> wrapper invokes the named skill via /skill:<name> with argument passthrough', async () => {
    const { pi, ctx, state } = makePi();
    mod.default(pi);
    await state.commands['steepy-plan'].handler('my working spec', ctx);
    assert.equal(state.sent.length, 1, 'the wrapper sends exactly one invocation');
    assert.equal(state.sent[0].kind, 'user');
    assert.match(state.sent[0].text, /\/skill:plan\b/, 'invokes the plan skill via /skill:<name>');
    assert.match(state.sent[0].text, /my working spec/, 'passes arguments through');
  });

  it('a /steepy-<skill> wrapper with no arguments still invokes the skill and does not throw', async () => {
    const { pi, ctx, state } = makePi();
    mod.default(pi);
    await assert.doesNotReject(() => state.commands['steepy-init'].handler('', ctx));
    await assert.doesNotReject(() => state.commands['steepy-init'].handler(undefined, ctx));
    assert.ok(state.sent.every((s) => /\/skill:init\b/.test(s.text)), 'each call invokes /skill:init');
  });

  it('registerCommand absent → no throw, no commands (fail-open)', () => {
    const { pi, state } = makePi({ registerCommand: false });
    assert.doesNotThrow(() => mod.default(pi));
    assert.deepEqual(Object.keys(state.commands), []);
  });

  it('session_start injects the marker-guarded bootstrap block exactly once (second event no-ops)', async () => {
    const { pi, ctx, state } = makePi();
    mod.default(pi);
    await fireSessionStart(state, ctx);
    assert.equal(state.sent.length, 1, 'one injection on first session_start');
    assert.equal(state.sent[0].kind, 'message');

    const block = state.sent[0].msg.content;
    assert.match(block, new RegExp(bootstrapMarker), 'block carries the marker guard');
    assert.ok(block.includes(root), 'block states the resolved engine-root path');
    assert.match(block, /AGENTS\.md[\s\S]*root[\s\S]*project/i, 'block orders root AGENTS.md instructions');
    assert.match(block, /\.agents\/skills/, 'block locates the canonical bootstrap generically');
    assert.match(block, /\.apex\/_INDEX\.md/, 'block retains the navigation fallback');
    assert.match(block, /inline[\s\S]*standard/i, 'missing bootstrap declares inline-standard degradation');
    assert.doesNotMatch(block, /steepy-apex-bootstrap/, 'bootstrap name is never hardcoded');
    assert.match(block, /\/skill:/, 'block documents /skill:<name> invocation');
    assert.match(block, /steepy-/, 'block names the /steepy-<skill> wrapper commands');
    assert.match(block, /D1/, 'block carries the D1 (no subagents → inline) note');
    assert.match(block, /D2/, 'block carries the D2 (no per-dispatch model) note');
    assert.match(block, /D3/, 'block carries the D3 (plain-text questions) note');
    assert.match(block, /D4/, 'block carries the D4 (no end-of-turn gate) note');
    assert.match(block, /validate-hub/, 'D4 points the coherence gate at validate-hub');

    await fireSessionStart(state, ctx, { reason: 'resume' });
    assert.equal(state.sent.length, 1, 'a second session_start over marked context is a no-op');
  });

  it('injects once into each marker-free session on the same live extension instance', async () => {
    const { pi, ctx, state } = makePi();
    mod.default(pi);

    await fireSessionStart(state, ctx, { reason: 'startup' });
    await fireSessionStart(state, ctx, { reason: 'resume' });
    assert.equal(state.sent.length, 1, 'repeat event in the marked first session must not duplicate');

    // Pi keeps the extension instance alive across new/fork/resume. Switching
    // the session manager's current entries to a fresh empty history must make
    // the guard session-scoped rather than extension-instance-scoped.
    state.entries = [];
    await fireSessionStart(state, ctx, { reason: 'new' });
    assert.equal(state.sent.length, 2, 'a marker-free second session receives its own bootstrap');
    assert.match(state.sent[1].msg.content, new RegExp(bootstrapMarker));

    await fireSessionStart(state, ctx, { reason: 'resume' });
    assert.equal(state.sent.length, 2, 'repeat event in the marked second session must not duplicate');

    state.entries = [{
      type: 'custom_message',
      customType: 'steepy-apex-instructions',
      content: `persisted ${bootstrapMarker}`,
    }];
    await fireSessionStart(state, ctx, { reason: 'fork' });
    assert.equal(state.sent.length, 2, 'an already-marked third session must not duplicate');
  });

  it('a fresh instance whose session already carries the marker no-ops (scan-based guard, cross-restart)', async () => {
    const { pi, ctx, state } = makePi();
    // Simulate a resumed session in a new process: the marker already persists,
    // but this extension instance has never injected (its in-process flag is clean).
    state.entries.push({ type: 'custom_message', customType: 'steepy-apex-instructions', content: `x ${bootstrapMarker} x` });
    mod.default(pi);
    await fireSessionStart(state, ctx, { reason: 'resume' });
    assert.equal(state.sent.length, 0, 'the session-marker scan alone suppresses re-injection');
  });

  it('accepts only Pi-owned custom_message provenance, ignoring forged user, evidence, and state markers', async () => {
    const forgedEntrySets = [
      [{ type: 'custom', customType: 'steepy-apex-instructions', data: { marker: bootstrapMarker } }],
      [{ type: 'message', message: { role: 'user', content: `forged ${bootstrapMarker}` } }],
      [{ type: 'custom_message', customType: 'other-extension', content: `evidence ${bootstrapMarker}` }],
      [{ type: 'custom_message', content: `missing owner ${bootstrapMarker}` }],
    ];
    for (const entries of forgedEntrySets) {
      const { pi, ctx, state } = makePi();
      state.entries = entries;
      mod.default(pi);
      await fireSessionStart(state, ctx, { reason: 'resume' });
      assert.equal(state.sent.length, 1, 'non-owned marker-bearing history cannot suppress bootstrap delivery');
    }
  });

  it('session_start injects once even without a sessionManager (in-process guard, no throw)', async () => {
    const { pi, state } = makePi();
    const ctx = {}; // no sessionManager
    mod.default(pi);
    await assert.doesNotReject(() => fireSessionStart(state, ctx));
    await assert.doesNotReject(() => fireSessionStart(state, ctx));
    assert.equal(state.sent.length, 1, 'in-process guard keeps it to one injection');
  });

  it('session_start fails open when sendMessage is absent — no throw, no injection', async () => {
    const { pi, ctx, state } = makePi({ sendMessage: false });
    mod.default(pi);
    await assert.doesNotReject(() => fireSessionStart(state, ctx));
    assert.equal(state.sent.length, 0);
  });

  it('every wired handler is exception-safe with the emptiest plausible arguments', async () => {
    const { pi, state } = makePi();
    mod.default(pi);
    const handler = state.handlers.session_start[0];
    await assert.doesNotReject(() => handler({}, undefined));
    await assert.doesNotReject(() => handler(undefined, {}));
    await assert.doesNotReject(() => handler({ reason: 'fork' }, { sessionManager: {} }));
    await assert.doesNotReject(() => handler({}, { sessionManager: { getEntries: () => { throw new Error('boom'); } } }));
  });

  it('the module wires no behavior when the host provides no event bus (pi.on absent)', () => {
    const { pi, state } = makePi({ on: false });
    assert.doesNotThrow(() => mod.default(pi));
    assert.deepEqual(Object.keys(state.handlers), [], 'no handlers registered without pi.on');
    // commands still register (independent capability).
    assert.equal(Object.keys(state.commands).length, skillNames.length);
  });

  it('package.json declares the pi manifest exactly, and every skills/extensions path resolves to a repo directory', () => {
    const pkg = readJson('package.json');
    assert.deepEqual(
      pkg.pi,
      { skills: ['./skills'], extensions: ['./adapters/pi'] },
      'package.json pi manifest must be exactly { skills: ["./skills"], extensions: ["./adapters/pi"] }',
    );
    for (const rel of [...pkg.pi.skills, ...pkg.pi.extensions]) {
      const abs = resolveFromRoot(rel);
      assert.ok(existsSync(abs), `pi manifest path ${rel} must exist in the repo`);
      assert.ok(statSync(abs).isDirectory(), `pi manifest path ${rel} must be a directory`);
    }
    assert.equal(resolveFromRoot(pkg.pi.skills[0]), skillsDir, 'pi.skills[0] must point at this repo skills/');
    assert.ok(existsSync(modulePath), 'the pi extension module file must exist');
  });
});

// ---------------------------------------------------------------------------
// T9 — dsh adapter (adapters/dsh/steepy-apex.js).
//
// The adapter is a cordis-style plugin module: named `name` + `apply(ctx)`
// exports, wired as side effects on the context it receives. It is unit-tested
// in-process with a stub `ctx` (no dsh runtime).
//
// The stub models `ctx.inject(deps, callback)` — the only legal way to reach a
// dsh service — rather than bare service properties, because that is the shape
// the real host has: on a real host the services are flat SIBLINGS of the
// adapter row, so a bare `ctx.commands` read throws instead of returning
// undefined, and a top-level `inject` listing them would leave the whole plugin
// PENDING (never loaded, never errored) on a host missing any one of them. The
// stub therefore exposes throwing getters for bare service reads: a module that
// did a bare read would pass a property-shaped stub and then break on a real
// host.
// ---------------------------------------------------------------------------
describe('dsh adapter (adapters/dsh/steepy-apex.js)', () => {
  const modulePath = join(root, 'adapters', 'dsh', 'steepy-apex.js');
  const bootstrapMarker = 'steepy-apex:bootstrap';
  const skillNames = [
    'init', 'check', 'new-surface', 'discovery', 'brainstorm',
    'plan', 'implement', 'review', 'loop-engineer',
  ];
  const serviceNames = ['tools', 'commands', 'systemPrompt'];

  // A minimal stub of the dsh plugin context, faithful to the pinned semantics:
  //   * `inject(deps, cb)` runs `cb` with a scoped ctx carrying those deps only
  //     when every dep is present; a missing dep is the PENDING case — `cb`
  //     never runs and nothing throws;
  //   * a bare `ctx.<service>` read throws, on the outer ctx and on a scoped ctx
  //     alike, for every service that ctx did not declare;
  //   * `systemPrompt.section()` throws on a duplicate section name;
  //   * registrations are LIFECYCLE-BOUND: `commands.register()` /
  //     `systemPrompt.section()` return real disposers (the shipped services back
  //     both with `ctx.effect(...)`), and `ctx.effect(setup)` collects the
  //     disposer `setup()` returns. `state.reload()` is the observable
  //     equivalent of a fiber unload: it runs every collected disposer in
  //     reverse, so the registrations really go away — which is what a host
  //     reload does before it re-invokes `apply()` with the same ctx object.
  // `caps` switches each service — plus `inject` and `effect` themselves — off
  // independently, and can make one command registration or the section
  // registration reject.
  function makeDsh(caps = {}) {
    const state = {
      commands: {}, commandRegistrations: [], sections: [], tools: [], injects: [], disposers: [],
    };

    // Every registration hands back a disposer that removes its own entry, and
    // the stub keeps it so a reload can run it — the real services do the same
    // through the host's effect lifecycle.
    function lifecycleBound(dispose) {
      state.disposers.push(dispose);
      return dispose;
    }

    const services = {};
    if (caps.tools !== false) {
      services.tools = {
        register: (definition) => {
          state.tools.push(definition);
          return lifecycleBound(() => {
            const at = state.tools.indexOf(definition);
            if (at >= 0) state.tools.splice(at, 1);
          });
        },
      };
    }
    if (caps.commands !== false) {
      services.commands = {
        register: (definition) => {
          const commandName = definition && definition.name;
          if (caps.rejectCommand && caps.rejectCommand === commandName) {
            throw new Error(`command "${commandName}" rejected`);
          }
          state.commandRegistrations.push(commandName);
          state.commands[commandName] = definition;
          return lifecycleBound(() => {
            const at = state.commandRegistrations.indexOf(commandName);
            if (at >= 0) state.commandRegistrations.splice(at, 1);
            delete state.commands[commandName];
          });
        },
      };
    }
    if (caps.systemPrompt !== false) {
      services.systemPrompt = {
        section: (section) => {
          if (caps.rejectSection) throw new Error('section rejected');
          const sectionName = section && section.name;
          if (state.sections.some((s) => s.name === sectionName)) {
            throw new Error(`duplicate section "${sectionName}"`);
          }
          state.sections.push(section);
          return lifecycleBound(() => {
            const at = state.sections.indexOf(section);
            if (at >= 0) state.sections.splice(at, 1);
          });
        },
      };
    }

    function inject(deps, callback) {
      const declared = Array.isArray(deps) ? [...deps] : [deps];
      state.injects.push(declared);
      if (!declared.every((dep) => Object.hasOwn(services, dep))) return; // PENDING.
      callback(makeCtx(declared));
    }

    // `ctx.effect(setup)` — a mixin accessor on a real host, so it is legal to
    // read without inject. `setup()` runs immediately and its return value is
    // the disposer the fiber owns.
    function effect(setup) {
      const dispose = typeof setup === 'function' ? setup() : undefined;
      if (typeof dispose !== 'function') return () => {};
      return lifecycleBound(dispose);
    }

    function makeCtx(declared) {
      const ctx = {};
      for (const service of serviceNames) {
        if (declared.includes(service) && Object.hasOwn(services, service)) {
          Object.defineProperty(ctx, service, { value: services[service], enumerable: true });
        } else {
          Object.defineProperty(ctx, service, {
            get() { throw new Error(`cannot get property "${service}" without inject`); },
          });
        }
      }
      if (caps.inject !== false) ctx.inject = inject;
      if (caps.effect !== false) ctx.effect = effect;
      return ctx;
    }

    // A fiber unload: every effect this wiring owns is disposed, in reverse.
    state.reload = () => {
      const owned = state.disposers.splice(0, state.disposers.length).reverse();
      for (const dispose of owned) dispose();
    };

    return { ctx: makeCtx([]), state };
  }

  let mod;
  before(async () => {
    mod = await import(pathToFileURL(modulePath));
  });

  it('imports cleanly without a dsh runtime, exports name + apply, and declares no top-level inject', () => {
    // A top-level side effect that threw would have failed the `before` import.
    assert.equal(typeof mod.apply, 'function', 'apply must be an exported function');
    assert.equal(typeof mod.name, 'string', 'name must be an exported string');
    assert.ok(mod.name.length > 0, 'name must be non-empty');
    assert.ok(
      mod.inject === undefined || (Array.isArray(mod.inject) && mod.inject.length === 0),
      'a top-level inject would leave the whole plugin PENDING on a host missing any one service',
    );
  });

  it('apply() no-ops (no throw) on undefined / empty / frozen / inject-less contexts', () => {
    assert.doesNotThrow(() => mod.apply());
    assert.doesNotThrow(() => mod.apply({}));
    assert.doesNotThrow(() => mod.apply(Object.freeze({})));

    const { ctx, state } = makeDsh({ inject: false }); // degenerate host: no gate at all.
    assert.doesNotThrow(() => mod.apply(ctx));
    assert.deepEqual(state.injects, [], 'nothing is wired without ctx.inject');
    assert.deepEqual(state.commandRegistrations, []);
    assert.deepEqual(state.sections, []);
  });

  it('reaches host services only through single-capability ctx.inject() calls, never a bare read', () => {
    const { ctx, state } = makeDsh();
    assert.throws(() => ctx.commands, /without inject/, 'sanity: a bare service read throws on this ctx');
    mod.apply(ctx);
    assert.ok(state.injects.length > 0, 'wiring must be gated behind ctx.inject()');
    for (const declared of state.injects) {
      assert.equal(
        declared.length, 1,
        `each ctx.inject() gates exactly one capability, so a missing service loses only its own: ${JSON.stringify(declared)}`,
      );
    }
    const gated = state.injects.flat();
    assert.ok(gated.includes('commands'), 'the commands capability is dependency-gated');
    assert.ok(gated.includes('systemPrompt'), 'the bootstrap capability is dependency-gated');
    assert.equal(new Set(gated).size, gated.length, 'no capability is gated twice');
  });

  it('registers exactly nine steepy-<skill> commands, each with a description and a handler', () => {
    const { ctx, state } = makeDsh();
    mod.apply(ctx);
    for (const skill of skillNames) {
      const key = `steepy-${skill}`;
      const definition = state.commands[key];
      assert.ok(definition, `command ${key} must be registered`);
      assert.equal(definition.name, key, 'a dsh command name carries no leading slash');
      assert.ok(definition.description, `${key} must carry a description`);
      assert.equal(typeof definition.handler, 'function', `${key} must carry a handler`);
    }
    assert.equal(state.commandRegistrations.length, skillNames.length, 'exactly nine command registrations');
  });

  it('a command handler passes arguments through and names the exact steepy_skill invocation', async () => {
    const { ctx, state } = makeDsh();
    mod.apply(ctx);
    const result = await state.commands['steepy-plan'].handler({
      rawInput: 'my working spec', signal: new AbortController().signal,
    });
    assert.equal(result.kind, 'success', 'the success shape is what the host renders');
    assert.match(result.text, /steepy_skill/, 'names the tool the model must call');
    assert.match(result.text, /"skill"\s*:\s*"plan"/, 'names the exact skill argument');
    assert.match(result.text, /"args"\s*:\s*"my working spec"/, 'passes arguments through');
  });

  it('a command handler does not throw on empty, missing, or absent arguments', async () => {
    const { ctx, state } = makeDsh();
    mod.apply(ctx);
    for (const invocation of [{ rawInput: '' }, { rawInput: undefined }, {}, undefined]) {
      const result = await state.commands['steepy-init'].handler(invocation);
      assert.equal(result.kind, 'success');
      assert.match(result.text, /"skill"\s*:\s*"init"/, 'still names the invocation to run');
    }
  });

  it('a command handler honors an already-aborted invocation signal', async () => {
    const { ctx, state } = makeDsh();
    mod.apply(ctx);
    const controller = new AbortController();
    controller.abort();
    const result = await state.commands['steepy-review'].handler({ rawInput: 'x', signal: controller.signal });
    assert.equal(result.kind, 'error', 'an aborted invocation returns the error shape rather than throwing');
    assert.ok(result.text.length > 0, 'the error shape must carry text');
  });

  it('the commands service missing → nothing registered, no throw (the gated callback never runs)', () => {
    const { ctx, state } = makeDsh({ commands: false });
    assert.doesNotThrow(() => mod.apply(ctx));
    assert.deepEqual(state.commandRegistrations, [], 'no command is registered without the service');
  });

  it('one rejected command registration never aborts the other eight', () => {
    const { ctx, state } = makeDsh({ rejectCommand: 'steepy-plan' });
    assert.doesNotThrow(() => mod.apply(ctx));
    assert.equal(state.commandRegistrations.length, skillNames.length - 1, 'the other eight still register');
    assert.ok(!state.commands['steepy-plan'], 'the rejected one is simply absent');
    assert.ok(state.commands['steepy-review'], 'a registration after the rejected one still happens');
  });

  it('registers the marker-guarded bootstrap section once, in the tool-guidance band, with the resolved engine root', () => {
    const { ctx, state } = makeDsh();
    mod.apply(ctx);
    assert.equal(state.sections.length, 1, 'exactly one bootstrap section');

    const section = state.sections[0];
    assert.ok(section.name, 'the section must carry a name (the host keys uniqueness on it)');
    assert.equal(section.order, 120, 'inside the 100-199 tool-guidance band, colliding with no shipped section');

    const text = typeof section.text === 'function' ? section.text({}) : section.text;
    assert.match(text, new RegExp(bootstrapMarker), 'block carries the marker guard');
    assert.ok(text.startsWith('<!-- steepy-apex:bootstrap -->'), 'the marker opens the block');
    assert.ok(text.includes(root), 'block states the resolved engine-root path');
    assert.match(text, /AGENTS\.md[\s\S]*root[\s\S]*project/i, 'block orders root AGENTS.md instructions');
    assert.match(text, /\.agents\/skills/, 'block locates the canonical bootstrap generically');
    assert.match(text, /\.apex\/_INDEX\.md/, 'block points at the navigation hub');
    assert.match(text, /inline[\s\S]*standard/i, 'missing bootstrap declares inline-standard degradation');
    assert.doesNotMatch(text, /steepy-apex-bootstrap/, 'bootstrap name is never hardcoded');
    for (const skill of skillNames) {
      assert.match(text, new RegExp(`\\b${skill}\\b`), `block names the ${skill} skill`);
    }
    assert.match(text, /steepy_skill/, 'block names the model-facing tool');
    assert.match(text, /never enter[s]? model history/, 'block states F3 explicitly');
    assert.match(text, /D1/, 'block carries the D1 (no subagent dispatch → inline) note');
    assert.match(text, /ledger/, 'D1/D2 degradations are recorded in the ledger');
    assert.match(text, /D2/, 'block carries the D2 (session model) note');
    assert.match(text, /D3/, 'block carries the D3 (plain-prose questions) note');
    assert.match(text, /D4/, 'block carries the D4 (no end-of-turn gate) note');
    assert.match(text, /validate-hub/, 'D4 points the coherence gate at validate-hub');
    assert.match(text, /silent/i, 'the residual degradation is declared, not hidden');
  });

  it('a repeat apply() over the same context registers no second section and no second round of commands', () => {
    const { ctx, state } = makeDsh();
    mod.apply(ctx);
    mod.apply(ctx);
    assert.equal(state.sections.length, 1, 'a duplicate section name would be rejected by the host');
    assert.equal(state.commandRegistrations.length, skillNames.length, 'and the nine commands register once');
  });

  it('a host reload re-wires the adapter (the once-guard is scoped to the wiring, not to the context forever)', () => {
    const { ctx, state } = makeDsh();
    mod.apply(ctx);
    assert.equal(state.commandRegistrations.length, skillNames.length, 'boot registers the nine commands');
    assert.equal(state.sections.length, 1, 'boot registers the bootstrap section');

    // A cordis reload disposes the fiber's effects first — the registrations
    // really go away — and then re-invokes apply() with the SAME ctx object.
    state.reload();
    assert.deepEqual(Object.keys(state.commands), [], 'the unload tears the commands down');
    assert.deepEqual(state.sections, [], 'the unload tears the bootstrap section down');

    mod.apply(ctx);
    assert.equal(
      state.commandRegistrations.length, skillNames.length,
      'a guard that outlived its wiring would leave the adapter silently dead for the rest of the session',
    );
    assert.equal(state.sections.length, 1, 'the bootstrap section comes back after a reload');

    // A second cycle (the host's restart path): the release must be re-armed by
    // every wiring, not spent once.
    state.reload();
    mod.apply(ctx);
    assert.equal(state.commandRegistrations.length, skillNames.length, 'a second reload re-wires too');
    assert.equal(state.sections.length, 1, 'and still exactly one bootstrap section');
  });

  it('a host without an effect lifecycle re-wires rather than dying silently, and never duplicates the section', () => {
    const { ctx, state } = makeDsh({ effect: false });
    assert.doesNotThrow(() => mod.apply(ctx));
    assert.doesNotThrow(() => mod.apply(ctx));
    assert.equal(state.sections.length, 1, 'the host rejects a duplicate section name and the adapter swallows it');
    assert.equal(Object.keys(state.commands).length, skillNames.length, 'the nine commands are present');
  });

  it('a second, distinct host context wires independently (the once-guard is per context, not a module singleton)', () => {
    const first = makeDsh();
    const second = makeDsh();
    mod.apply(first.ctx);
    mod.apply(second.ctx);
    assert.equal(first.state.sections.length, 1);
    assert.equal(second.state.sections.length, 1, 'a second legitimate host context still gets its bootstrap block');
    assert.equal(second.state.commandRegistrations.length, skillNames.length);
  });

  it('the systemPrompt service missing → no section, no throw, and the nine commands still register', () => {
    const { ctx, state } = makeDsh({ systemPrompt: false });
    assert.doesNotThrow(() => mod.apply(ctx));
    assert.deepEqual(state.sections, [], 'the gated callback never runs');
    assert.equal(
      state.commandRegistrations.length, skillNames.length,
      'a missing capability never suppresses a healthy one',
    );
  });

  it('a rejected section registration never escapes and never costs the commands capability', () => {
    const { ctx, state } = makeDsh({ rejectSection: true });
    assert.doesNotThrow(() => mod.apply(ctx));
    assert.deepEqual(state.sections, []);
    assert.equal(state.commandRegistrations.length, skillNames.length);
  });

  // -- Task 3: steepy_skill model-invocable tool (GC7 allowlist validation, --
  // -- gated on its own single-capability 'tools' child fiber) ---------------
  it('registers a steepy_skill tool with a name, description, parameter schema, and output contract, on its own single-capability gate', () => {
    const { ctx, state } = makeDsh();
    mod.apply(ctx);
    assert.equal(state.tools.length, 1, 'exactly one tool registered');

    const tool = state.tools[0];
    assert.equal(tool.name, 'steepy_skill');
    assert.ok(tool.description && tool.description.length > 0, 'the tool must carry a description');
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.properties.skill.type, 'string');
    assert.deepEqual(tool.parameters.required, ['skill'], 'skill is required, args is optional');
    assert.equal(tool.parameters.properties.args.type, 'string');
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.output, 'object');
    assert.deepEqual(tool.output.schema, { type: 'string' }, 'output.schema is declared as a plain string');
    assert.equal(typeof tool.output.render, 'function');

    const gated = state.injects.flat();
    assert.ok(gated.includes('tools'), 'the steepy_skill capability is dependency-gated on its own child fiber');
  });

  it("execute() returns each canonical skill's exact SKILL.md bytes at the end of the string, naming the base directory", async () => {
    const { ctx, state } = makeDsh();
    mod.apply(ctx);
    const tool = state.tools[0];

    for (const skill of skillNames) {
      const skillDir = join(root, 'skills', skill);
      const expectedBytes = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');

      const value = await tool.execute({ skill });
      assert.equal(typeof value, 'string', `${skill}: execute must return a string`);
      assert.ok(value.endsWith(expectedBytes), `${skill}: output must end with the exact SKILL.md bytes, with nothing following`);
      assert.ok(value.includes(`${skillDir}/`), `${skill}: output must state the skill's base directory`);

      const rendered = tool.output.render({ skill }, value);
      assert.ok(Array.isArray(rendered) && rendered.length === 1, `${skill}: render must return a single content block`);
      assert.equal(rendered[0].type, 'text');
      assert.equal(rendered[0].text, value, 'render carries the execute() value through verbatim');
    }
  });

  it('echoes args into the framing when given, and omits it entirely when absent', async () => {
    const { ctx, state } = makeDsh();
    mod.apply(ctx);
    const tool = state.tools[0];

    const withArgs = await tool.execute({ skill: 'plan', args: 'my working spec' });
    assert.match(withArgs, /my working spec/, 'args is echoed into the framing');

    for (const invocation of [{ skill: 'plan' }, { skill: 'plan', args: '' }, { skill: 'plan', args: undefined }]) {
      const withoutArgs = await tool.execute(invocation);
      assert.doesNotMatch(withoutArgs, /Arguments:/, 'no args line when args is absent or empty');
    }
  });

  it('rejects a non-string, empty string, and unknown skill name before any filesystem access, naming all nine valid values', async () => {
    const { ctx, state } = makeDsh();
    mod.apply(ctx);
    const tool = state.tools[0];

    for (const bad of [42, null, undefined, {}, [], '', 'not-a-real-skill', 'PLAN', ' plan']) {
      let value;
      await assert.doesNotReject(async () => { value = await tool.execute({ skill: bad }); }, `skill=${JSON.stringify(bad)} must not throw`);
      assert.equal(typeof value, 'string', `skill=${JSON.stringify(bad)} must reject with a string, not throw`);
      for (const name of skillNames) {
        assert.match(value, new RegExp(`\\b${name}\\b`), `rejection for ${JSON.stringify(bad)} must name ${name} as a valid value`);
      }
      assert.doesNotMatch(
        value, /could not read/i,
        `rejection for ${JSON.stringify(bad)} must be the validation message, not a read-failure message — proves no read was attempted`,
      );
    }
  });

  it('a traversal attempt is rejected before any filesystem access, proven by a decoy SKILL.md it must never read', async () => {
    const decoyDir = mkdtempSync(join(tmpdir(), 'steepy-dsh-skill-traversal-'));
    try {
      writeFileSync(join(decoyDir, 'SKILL.md'), 'DECOY CONTENT — must never surface via traversal');

      const { ctx, state } = makeDsh();
      mod.apply(ctx);
      const tool = state.tools[0];

      // The exact number of `../` segments needed to walk from PACKAGE_ROOT's
      // skills/ dir out to the decoy — computed, never hardcoded, so the test
      // stays correct regardless of the repo's absolute location on disk.
      const traversal = relative(join(root, 'skills'), decoyDir);
      const value = await tool.execute({ skill: traversal });

      assert.equal(typeof value, 'string');
      assert.doesNotMatch(value, /DECOY CONTENT/, 'no path is built from the traversal input — the decoy is never reached');
      for (const name of skillNames) {
        assert.match(value, new RegExp(`\\b${name}\\b`), `rejection must still name ${name} as a valid value`);
      }
    } finally {
      rmSync(decoyDir, { recursive: true, force: true });
    }
  });

  it('the tools service missing → no steepy_skill tool registered, no throw, and the other capabilities still register', () => {
    const { ctx, state } = makeDsh({ tools: false });
    assert.doesNotThrow(() => mod.apply(ctx));
    assert.deepEqual(state.tools, [], 'the gated callback never runs without the tools service');
    assert.equal(state.commandRegistrations.length, skillNames.length, 'a missing capability never suppresses a healthy one');
    assert.equal(state.sections.length, 1, 'the bootstrap section still registers');
  });

  it('contains no CLAUDE_* reference, no absolute path literal, and imports only Node built-ins', () => {
    const source = readFileSync(modulePath, 'utf8');
    assert.doesNotMatch(source, /CLAUDE_/, 'adapter code never references CLAUDE_* env vars');
    assert.doesNotMatch(source, /\/Users\//, 'no absolute path literal');
    assert.doesNotMatch(source, /\/home\//, 'no absolute path literal');
    assert.doesNotMatch(source, /~\//, 'no user-home path literal');
    assert.doesNotMatch(source, /from ['"]@deepseek-ai/, 'zero runtime dependencies on host packages');
    assert.match(source, /import\.meta\.url/, 'the engine root is resolved from import.meta.url');
    for (const match of source.matchAll(/^import [^;]* from '([^']+)';$/gm)) {
      assert.match(match[1], /^node:/, `adapters import only Node built-ins: ${match[1]}`);
    }
  });
});

// ---------------------------------------------------------------------------
// T2 — Headless model-tier routing (adapters/headless.mjs).
// ---------------------------------------------------------------------------
describe('headless adapter model-tier routing', () => {
  const prompt = 'complete the current phase';
  const tiers = ['cheap', 'standard', 'most-capable'];
  const claudeModels = ['haiku', 'sonnet', 'opus'];
  const codexModels = ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'];
  // Frontier models per harness: the tier ladder must never resolve one of these
  // for `cheap`, or every mechanical task runs on the most expensive model.
  const frontierModels = {
    claude: ['fable', 'opus', 'claude-fable-5', 'claude-opus-5'],
    codex: ['gpt-5.6-sol'],
  };

  it('pins Codex model-tier provenance to the official model guide', () => {
    assert.equal(
      CODEX_MODEL_MAPPING_SOURCE,
      'https://developers.openai.com/api/docs/guides/latest-model',
    );
  });

  function descriptorFor(harness, modelTier, extra = {}) {
    return headlessCommand(harness, prompt, { displayName: 'phase-controller', modelTier, ...extra });
  }

  it('leaves model selection to the host when no tier is requested', () => {
    const descriptor = headlessCommand('claude', prompt, { displayName: 'phase-controller' });
    assert.equal(descriptor.requestedModelTier, undefined);
    assert.equal(descriptor.resolvedModel, undefined);
    assert.equal(descriptor.modelSelection, undefined);
    assert.equal(descriptor.args.at(-1), 'phase-controller');
  });

  it('pins the Claude agentIdentity capability as yes on the adapter surface', () => {
    const descriptor = headlessCommand('claude', prompt, { displayName: 'phase-controller' });
    assert.equal(descriptor.capabilities.agentIdentity, 'yes');
  });

  for (const [index, tier] of tiers.entries()) {
    it(`applies Claude ${tier} with the concrete model argument while preserving flags and ordering`, () => {
      const descriptor = descriptorFor('claude', tier);
      assert.equal(descriptor.requestedModelTier, tier);
      assert.equal(descriptor.resolvedModel, claudeModels[index]);
      assert.equal(descriptor.modelSelection, 'applied');
      assert.equal(descriptor.degradationReason, undefined);
      assert.deepEqual(descriptor.args, [
        '-p', prompt,
        '--dangerously-skip-permissions',
        '--allowedTools', CLAUDE_ALLOWED_TOOLS.join(','),
        '--output-format', 'stream-json',
        '--verbose',
        '--forward-subagent-text',
        '--name', 'phase-controller',
        '--model', claudeModels[index],
      ]);
    });

    it(`applies Codex ${tier} with the concrete model argument while preserving flags and ordering`, () => {
      const descriptor = descriptorFor('codex', tier);
      assert.equal(descriptor.requestedModelTier, tier);
      assert.equal(descriptor.resolvedModel, codexModels[index]);
      assert.equal(descriptor.modelSelection, 'applied');
      assert.equal(descriptor.degradationReason, undefined);
      assert.deepEqual(descriptor.args, [
        '--model', codexModels[index], 'exec', '--dangerously-bypass-approvals-and-sandbox',
        '--color', 'never', '--json', prompt,
      ]);
    });

    it(`visibly degrades OpenCode ${tier} without a verified mapping or model argument`, () => {
      const descriptor = descriptorFor('opencode', tier);
      assert.equal(descriptor.requestedModelTier, tier);
      assert.equal(descriptor.resolvedModel, undefined);
      assert.equal(descriptor.modelSelection, 'degraded');
      assert.match(descriptor.degradationReason, /mapping/i);
      assert.deepEqual(descriptor.args, [
        'run', '--auto', '--format', 'json', '--title', 'phase-controller', prompt,
      ]);
    });
  }

  it('never resolves a frontier model for the cheap tier, and keeps each tier distinct', () => {
    for (const harness of ['claude', 'codex']) {
      const resolved = tiers.map((tier) => descriptorFor(harness, tier).resolvedModel);
      for (const model of resolved) {
        assert.equal(typeof model, 'string', `${harness} must resolve every tier`);
      }
      assert.ok(
        !frontierModels[harness].includes(resolved[0]),
        `${harness} cheap tier resolved the frontier model '${resolved[0]}' — the ladder is inverted`,
      );
      assert.equal(
        new Set(resolved).size, tiers.length,
        `${harness} must resolve a distinct model per tier, got ${resolved.join(', ')}`,
      );
    }
  });

  it('applies a verified injected OpenCode mapping at the model flag before its prompt', () => {
    const descriptor = descriptorFor('opencode', 'standard', {
      modelMappings: { standard: 'openai/gpt-5.6-terra' },
    });
    assert.equal(descriptor.resolvedModel, 'openai/gpt-5.6-terra');
    assert.equal(descriptor.modelSelection, 'applied');
    assert.deepEqual(descriptor.args, [
      'run', '--auto', '--format', 'json', '--title', 'phase-controller',
      '--model', 'openai/gpt-5.6-terra', prompt,
    ]);
  });

  it('degrades a requested OpenCode tier when its injected mapping omits that tier', () => {
    const descriptor = descriptorFor('opencode', 'most-capable', {
      modelMappings: { standard: 'openai/gpt-5.6-terra' },
    });
    assert.equal(descriptor.modelSelection, 'degraded');
    assert.equal(descriptor.resolvedModel, undefined);
    assert.match(descriptor.degradationReason, /most-capable/);
    assert.ok(!descriptor.args.includes('--model'));
  });

  it('rejects invalid abstract tiers before building a descriptor', () => {
    for (const tier of ['', 'fast', 'standard ', 1, null]) {
      assert.throws(
        () => descriptorFor('claude', tier),
        /modelTier must be one of cheap, standard, most-capable/,
      );
    }
  });

  it('rejects malformed injected mappings without accepting unexpected, inherited, empty, or unsafe values', () => {
    const inheritedMapping = Object.create({ cheap: 'openai/gpt-5.6-luna' });
    for (const modelMappings of [
      { fast: 'openai/gpt-5.6-luna' },
      inheritedMapping,
      { cheap: '' },
      { cheap: 'openai/gpt 5.6-luna' },
      ['openai/gpt-5.6-luna'],
    ]) {
      assert.throws(
        () => descriptorFor('opencode', 'cheap', { modelMappings }),
        /modelMappings must contain only own canonical tier keys with safe non-empty concrete model strings/,
      );
    }
  });

  it('preserves unknown/no-headless behavior even when a tier is supplied', () => {
    assert.equal(headlessCommand('unsupported', prompt, { modelTier: 'standard' }), null);
  });
});

// ---------------------------------------------------------------------------
// Shared provider-keyed tier tables (adapters/model-mappings.mjs).
//
// The module is the single source of truth for provider → tier → concrete
// model ids (prefixed, directly usable as an OpenCode `model` value), each row
// carrying its provenance (`source` + `verifiedAt`). headless.mjs sources its
// claude/codex bare-id rows from it, so the ascent rule and provenance
// discipline (standards/adapters.md:36-47) are testable here in one place.
// ---------------------------------------------------------------------------
describe('model-mappings module (adapters/model-mappings.mjs)', () => {
  // Mirrors headless.mjs's SAFE_CONCRETE_MODEL shape (left unexported there to
  // keep its public API unchanged); the lock is the shape, not the identity.
  const SAFE_CONCRETE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
  const tiers = ['cheap', 'standard', 'most-capable'];
  const providers = ['zai-coding-plan', 'deepseek', 'anthropic', 'openai'];
  const expectedModels = {
    'zai-coding-plan': ['zai-coding-plan/glm-5.3-flash', 'zai-coding-plan/glm-5.3-highspeed', 'zai-coding-plan/glm-5.3'],
    deepseek: ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-pro'],
    anthropic: ['anthropic/haiku', 'anthropic/sonnet', 'anthropic/opus'],
    openai: ['openai/gpt-5.6-luna', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-sol'],
  };

  let mm;
  before(async () => {
    mm = await import(pathToFileURL(join(root, 'adapters', 'model-mappings.mjs')));
  });

  it('keys the table by exactly the four canonical providers with exactly the three canonical tier keys each', () => {
    assert.deepEqual(
      Object.keys(mm.PROVIDER_MODEL_MAPPINGS).sort(),
      [...providers].sort(),
    );
    for (const provider of providers) {
      assert.deepEqual(
        Object.keys(mm.PROVIDER_MODEL_MAPPINGS[provider]).sort(),
        [...tiers].sort(),
        `${provider} must carry exactly cheap, standard, most-capable`,
      );
    }
  });

  it('pins every concrete model id verbatim from the verified table', () => {
    for (const provider of providers) {
      const rows = mm.PROVIDER_MODEL_MAPPINGS[provider];
      for (const [index, tier] of tiers.entries()) {
        assert.equal(rows[tier].model, expectedModels[provider][index]);
      }
    }
  });

  it('every model id is a non-empty prefixed string matching headless SAFE_CONCRETE_MODEL shape', () => {
    for (const provider of providers) {
      for (const tier of tiers) {
        const model = mm.PROVIDER_MODEL_MAPPINGS[provider][tier].model;
        assert.equal(typeof model, 'string', `${provider}/${tier}.model must be a string`);
        assert.ok(model.length > 0, `${provider}/${tier}.model must be non-empty`);
        assert.ok(
          model.startsWith(`${provider}/`),
          `${provider}/${tier}.model must carry its provider prefix: ${model}`,
        );
        assert.match(model, SAFE_CONCRETE_MODEL);
      }
    }
  });

  it('every row carries non-empty source and verifiedAt, with harness constants as provenance', () => {
    for (const provider of providers) {
      for (const tier of tiers) {
        const row = mm.PROVIDER_MODEL_MAPPINGS[provider][tier];
        assert.equal(typeof row.source, 'string', `${provider}/${tier}.source must be a string`);
        assert.ok(row.source.length > 0, `${provider}/${tier}.source must be non-empty`);
        const expectedVerifiedAt = provider === 'zai-coding-plan' ? '2026-08-27' : '2026-08-20';
        assert.equal(row.verifiedAt, expectedVerifiedAt, `${provider}/${tier}.verifiedAt must be the ISO verification date`);
      }
    }
    assert.equal(mm.CODEX_MODEL_MAPPING_SOURCE, 'https://developers.openai.com/api/docs/guides/latest-model');
    assert.match(mm.ANTHROPIC_MODEL_MAPPING_SOURCE, /^https:\/\/docs\.anthropic\.com\//);
    for (const tier of tiers) {
      assert.equal(mm.PROVIDER_MODEL_MAPPINGS.openai[tier].source, mm.CODEX_MODEL_MAPPING_SOURCE);
      assert.equal(mm.PROVIDER_MODEL_MAPPINGS.anthropic[tier].source, mm.ANTHROPIC_MODEL_MAPPING_SOURCE);
    }
    assert.match(mm.PROVIDER_MODEL_MAPPINGS['zai-coding-plan'].cheap.source, /opencode models/);
    assert.match(mm.PROVIDER_MODEL_MAPPINGS.deepseek.cheap.source, /api-docs\.deepseek\.com/);
  });

  it('headless re-exports the shared CODEX_MODEL_MAPPING_SOURCE unchanged', () => {
    assert.equal(mm.CODEX_MODEL_MAPPING_SOURCE, CODEX_MODEL_MAPPING_SOURCE);
  });

  it('ascends: cheap differs from most-capable everywhere; ids are distinct (deepseek keeps its two)', () => {
    for (const provider of providers) {
      const resolved = tiers.map((tier) => mm.tierModelsForProvider(provider)[tier]);
      assert.notEqual(
        resolved[0], resolved[2],
        `${provider} inverts the ladder: cheap === most-capable`,
      );
      const expectedDistinct = provider === 'deepseek' ? 2 : 3;
      assert.equal(
        new Set(resolved).size, expectedDistinct,
        `${provider} must resolve ${expectedDistinct} distinct ids, got ${resolved.join(', ')}`,
      );
    }
  });

  it('freezes the tables at every level', () => {
    assert.ok(Object.isFrozen(mm.PROVIDER_MODEL_MAPPINGS));
    for (const provider of providers) {
      const rows = mm.PROVIDER_MODEL_MAPPINGS[provider];
      assert.ok(Object.isFrozen(rows), `${provider} tier set must be frozen`);
      for (const tier of tiers) assert.ok(Object.isFrozen(rows[tier]), `${provider}/${tier} row must be frozen`);
    }
    for (const provider of providers) assert.ok(Object.isFrozen(mm.tierModelsForProvider(provider)));
    for (const harness of ['claude', 'codex']) assert.ok(Object.isFrozen(mm.bareModelMappingsForHarness(harness)));
  });

  it('resolveProviderFromModel maps a prefixed id to its table key and returns undefined otherwise', () => {
    for (const provider of providers) {
      assert.equal(mm.resolveProviderFromModel(expectedModels[provider][0]), provider);
    }
    assert.equal(mm.resolveProviderFromModel('openai/gpt-5.6-luna/extra'), 'openai', 'the FIRST slash splits provider from id');
    assert.equal(mm.resolveProviderFromModel('unknown/model'), undefined);
    assert.equal(mm.resolveProviderFromModel('openai'), undefined, 'missing slash');
    assert.equal(mm.resolveProviderFromModel(''), undefined);
    assert.equal(mm.resolveProviderFromModel('/openai/gpt-5.6-luna'), undefined, 'empty prefix');
    assert.equal(mm.resolveProviderFromModel(undefined), undefined);
    assert.equal(mm.resolveProviderFromModel(null), undefined);
    assert.equal(mm.resolveProviderFromModel(42), undefined);
    assert.equal(mm.resolveProviderFromModel({ model: 'openai/gpt-5.6-luna' }), undefined);
  });

  it('tierModelsForProvider returns the frozen concrete tier record or undefined for unknown/prototype keys', () => {
    for (const provider of providers) {
      assert.deepEqual(mm.tierModelsForProvider(provider), {
        cheap: expectedModels[provider][0],
        standard: expectedModels[provider][1],
        'most-capable': expectedModels[provider][2],
      });
    }
    assert.equal(mm.tierModelsForProvider('unknown'), undefined);
    assert.equal(mm.tierModelsForProvider(''), undefined);
    assert.equal(mm.tierModelsForProvider(undefined), undefined);
    assert.equal(mm.tierModelsForProvider('toString'), undefined, 'prototype keys must not resolve');
    assert.equal(mm.tierModelsForProvider('constructor'), undefined, 'prototype keys must not resolve');
  });

  it('bareModelMappingsForHarness strips the provider prefix for claude/codex only', () => {
    assert.deepEqual(mm.bareModelMappingsForHarness('claude'), {
      cheap: 'haiku', standard: 'sonnet', 'most-capable': 'opus',
    });
    assert.deepEqual(mm.bareModelMappingsForHarness('codex'), {
      cheap: 'gpt-5.6-luna', standard: 'gpt-5.6-terra', 'most-capable': 'gpt-5.6-sol',
    });
    assert.equal(mm.bareModelMappingsForHarness('opencode'), undefined);
    assert.equal(mm.bareModelMappingsForHarness('pi'), undefined);
    assert.equal(mm.bareModelMappingsForHarness(''), undefined);
    assert.equal(mm.bareModelMappingsForHarness(undefined), undefined);
    assert.equal(mm.bareModelMappingsForHarness('toString'), undefined, 'prototype keys must not resolve');
  });

  it('contains no engine-script import, no CLAUDE_* reference, and no absolute/user-home path literal', () => {
    const source = readFileSync(join(root, 'adapters', 'model-mappings.mjs'), 'utf8');
    assert.doesNotMatch(source, /from ['"]\.\.?\//);
    assert.doesNotMatch(source, /CLAUDE_/);
    assert.doesNotMatch(source, /\/Users\//);
    assert.doesNotMatch(source, /\/home\//);
    assert.doesNotMatch(source, /~\//);
  });
});

// ---------------------------------------------------------------------------
// T1 — Harness session-store descriptor (adapters/session-store.mjs).
//
// Pure harness → session-store knowledge, exactly parallel to headless.mjs's
// harness → command map: where a harness keeps its session records is
// per-harness knowledge that lives in adapters/, never in the canonical core.
// The descriptor carries the store root path pattern (computed from node:os
// homedir() plus the harness's relative subpath — never a /Users/...|/home/...|~/
// literal), the record format, and the spec-verified field names for model,
// usage, skill attribution, entrypoint, and subagent dispatch results. A
// harness without a verified descriptor maps to null so degradation is
// explicit rather than silent.
// ---------------------------------------------------------------------------
describe('session-store adapter (adapters/session-store.mjs)', () => {
  it('imports cleanly and exports sessionStoreDescriptor as a function', () => {
    assert.equal(typeof sessionStoreDescriptor, 'function');
  });

  it('maps Claude Code to a frozen descriptor with a root path computed from homedir()', () => {
    const descriptor = sessionStoreDescriptor('claude');
    assert.ok(descriptor, 'claude must have a session-store descriptor');
    assert.ok(Object.isFrozen(descriptor), 'descriptor must be frozen');
    assert.equal(descriptor.rootPath, join(homedir(), '.claude', 'projects'));
    assert.equal(descriptor.format, 'jsonl');
  });

  it('carries the spec-verified Claude Code field names', () => {
    const descriptor = sessionStoreDescriptor('claude');
    assert.equal(descriptor.modelField, 'message.model');
    assert.equal(descriptor.usageField, 'message.usage');
    assert.equal(descriptor.skillAttributionField, 'attributionSkill');
    assert.equal(descriptor.pluginAttributionField, 'attributionPlugin');
    assert.equal(descriptor.entrypointField, 'entrypoint');
    assert.deepEqual(descriptor.entrypointValues, { interactive: 'cli', headless: 'sdk-cli' });
    assert.equal(descriptor.timestampField, 'timestamp');
  });

  it('carries the spec-verified subagent dispatch result field names', () => {
    const descriptor = sessionStoreDescriptor('claude');
    assert.deepEqual(descriptor.dispatchResult, {
      containerField: 'toolUseResult',
      agentTypeField: 'agentType',
      resolvedModelField: 'resolvedModel',
      totalTokensField: 'totalTokens',
      usageField: 'usage',
      totalDurationMsField: 'totalDurationMs',
      totalToolUseCountField: 'totalToolUseCount',
    });
  });

  it('returns explicit null for every harness without a verified descriptor', () => {
    assert.equal(sessionStoreDescriptor('opencode'), null);
    assert.equal(sessionStoreDescriptor('pi'), null);
    assert.equal(sessionStoreDescriptor('codex'), null);
    assert.equal(sessionStoreDescriptor('unsupported'), null);
  });

  it('contains no CLAUDE_* reference and no machine-specific absolute path literal', () => {
    const source = readFileSync(join(root, 'adapters', 'session-store.mjs'), 'utf8');
    assert.doesNotMatch(source, /CLAUDE_/);
    assert.doesNotMatch(source, /\/Users\//);
    assert.doesNotMatch(source, /\/home\//);
    assert.doesNotMatch(source, /~\//);
  });
});

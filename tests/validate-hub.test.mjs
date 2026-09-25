import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import fs, {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { classifyHub, collectViolations, main } from '../scripts/validate-hub.mjs';
import { createInitialInceptionState, serializeInceptionState } from '../scripts/inception-state.mjs';
import { scaffold } from '../scripts/new-surface.mjs';
import { applyProjectScaffold, planProjectScaffold } from '../scripts/project-scaffold.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => join(here, 'fixtures', n);
const templates = join(here, '..', 'templates');
const validator = join(here, '..', 'scripts', 'validate-hub.mjs');
const stopHook = join(here, '..', 'scripts', 'stop-hook.mjs');

function runValidator(hub, timeout = 2_000, cwd) {
  return spawnSync(process.execPath, [validator, hub], { encoding: 'utf8', timeout, cwd });
}

function makeFifo(path) {
  const result = spawnSync('mkfifo', [path], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function storageAliasesCase(directory) {
  const lower = join(directory, 'steepy-case-probe');
  mkdirSync(lower);
  try {
    const canonical = lstatSync(lower, { bigint: true });
    const alias = lstatSync(join(directory, 'STEEPY-CASE-PROBE'), { bigint: true });
    return canonical.dev === alias.dev && canonical.ino === alias.ino;
  } catch {
    return false;
  }
}

// Run main() while capturing what it writes to stdout/stderr, so we can assert on
// the user-facing message (not just the exit code) without spawning a subprocess.
function captureMain(argv) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  console.warn = (...a) => err.push(a.join(' '));
  let code;
  try {
    code = main(argv);
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
  }
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function codeAnchorStandardHub(suffix, standardText, opts = {}) {
  const hub = mkdtempSync(join(tmpdir(), `steepy-anchor-${suffix}-`));
  mkdirSync(join(hub, '.apex', 'standards'), { recursive: true });
  writeFileSync(
    join(hub, '.apex', '_INDEX.md'),
    opts.indexText ?? '# Index\n\n- [Web](standards/web.md)\n',
  );
  writeFileSync(join(hub, '.apex', 'standards', 'web.md'), standardText);
  if (opts.packageText !== undefined) {
    writeFileSync(join(hub, 'package.json'), opts.packageText);
  }
  return hub;
}

// The canonical bootstrap every release from v1.0.0 through v1.0.4 rendered for
// `portable-demo`: the released template before its inception boundary section.
// The current bootstrap in portableHub() is this body plus that section. A
// second copy of these literal bytes lives in portable-workflow-composition
// (planner/new-surface side), consciously duplicated so each suite stays hermetic.
const V1_0_PORTABLE_DEMO_BOOTSTRAP_BODY = [
  '---',
  'name: portable-demo-bootstrap',
  'description: Project entry point for portable-demo. Loads the root instructions and routes work through the governed hub.',
  'user-invocable: true',
  '---',
  '<!-- steepy:generated:portable-demo-bootstrap:v1 -->',
  '',
  '# portable-demo bootstrap',
  '',
  'Use this skill before working on the project.',
  '',
  '## Procedure',
  '',
  '1. Read `AGENTS.md` in full for the project overview, development commands, and confirmed surfaces.',
  '2. Read `.apex/_INDEX.md` in full for the routing table and semantic knowledge map.',
  '3. Match the task to the owning surface and read only the minimum documents named by its routing row.',
  '4. State the owning surface and specialist agent before changing files.',
  '5. When a Steepy workflow is needed, invoke it by its semantic skill name as listed in `.apex/_INDEX.md`.',
  '6. Run the owning surface\'s test command and the hub coherence gate before reporting completion.',
  '',
  '## Work-artifact boundary',
  '',
  'Do not ordinarily enumerate, search, or read under `.apex/work/**`.',
  '',
  'A workflow phase may consume only the exact work inputs named by an accepted handoff. A pathless workflow invocation may perform only bounded workflow-header recovery discovery. Exact paths or a broader work-area scope are permitted only when the user explicitly delimits them. This applies transitively to child agents: only the phase orchestrator interprets a handoff.',
];
const V1_0_PORTABLE_DEMO_BOOTSTRAP = [...V1_0_PORTABLE_DEMO_BOOTSTRAP_BODY, ''].join('\n');

function putPortable(hub, path, content) {
  mkdirSync(dirname(join(hub, path)), { recursive: true });
  writeFileSync(join(hub, path), content);
}

function portableHub() {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-portable-v1-'));
  putPortable(hub, '.apex/_INDEX.md', [
    '# Index',
    '- [Web](standards/web.md)',
    '',
    '| Surface | Min docs | Specialist agent | Applicable skill |',
    '|---|---|---|---|',
    '| `web` | [standards/web.md](standards/web.md) | `web-agent` | — |',
    '',
  ].join('\n'));
  putPortable(hub, '.apex/standards/web.md', '# web — Technical Standard\n');
  putPortable(hub, 'AGENTS.md', [
    '<!-- steepy:managed:project-instructions:v1:start -->',
    '# portable-demo',
    '',
    'Portable demo project.',
    '',
    '## Development commands',
    '',
    '- `npm test`',
    '',
    '## Confirmed surfaces',
    '',
    '- `web` (`apps/web`) — `web-agent`',
    '',
    '## Project navigation',
    '',
    'For every task, use the `portable-demo-bootstrap` skill first. If that skill is unavailable, read `.apex/_INDEX.md` before making changes.',
    '<!-- steepy:managed:project-instructions:v1:end -->',
    '',
  ].join('\n'));
  putPortable(hub, 'CLAUDE.md', [
    '<!-- steepy:managed:claude-import:v1:start -->',
    '@AGENTS.md',
    '<!-- steepy:managed:claude-import:v1:end -->',
    '',
  ].join('\n'));
  putPortable(hub, '.agents/skills/portable-demo-bootstrap/SKILL.md', [
    ...V1_0_PORTABLE_DEMO_BOOTSTRAP_BODY,
    '',
    '## Inception boundary',
    '',
    'Do not ordinarily enumerate, search, or read under `.apex/inception/**`.',
    '',
    'Only the exact input paths supplied for the current step, or a broader scope the user explicitly authorizes, permit a read here. The inception boundary has no pathless recovery of its own: the bounded workflow-header recovery above is specific to `.apex/work/**` and does not extend to it. This applies transitively to child agents.',
    '',
  ].join('\n'));
  putPortable(hub, '.claude/skills/portable-demo-bootstrap/SKILL.md', [
    '---',
    'name: portable-demo-bootstrap',
    'description: Claude adapter for the canonical portable-demo project bootstrap.',
    'user-invocable: true',
    '---',
    '<!-- steepy:generated:portable-demo-bootstrap-stub:v1 -->',
    '',
    'Read `.agents/skills/portable-demo-bootstrap/SKILL.md` in full and execute that canonical bootstrap exactly.',
    '',
  ].join('\n'));
  putPortable(hub, '.claude/agents/web-agent.md', [
    '---',
    'name: web-agent',
    'description: >-',
    '  Portable demo project.',
    'model: inherit',
    '---',
    '<!-- steepy:generated:web-agent-claude:v1 -->',
    '',
    '# web-agent',
    '',
    'You are the specialist agent for the `web` surface at `apps/web`.',
    '',
    'Run the `portable-demo-bootstrap` skill, then read `.apex/standards/web.md` before working on this surface. Follow that standard without copying its rules into this adapter.',
    '',
  ].join('\n'));
  putPortable(hub, '.codex/agents/web-agent.toml', [
    '# steepy:generated:web-agent-codex:v1',
    '# Project description: Portable demo project.',
    '# Surface path: apps/web',
    'name = "web-agent"',
    'description = "Specialist agent for web work."',
    'developer_instructions = """',
    'You are the web-agent specialist for the web surface.',
    '',
    'Run the `portable-demo-bootstrap` skill, then read `.apex/standards/web.md` before working on this surface. Follow that standard without copying its rules into this adapter.',
    '"""',
    '',
  ].join('\n'));
  putPortable(hub, '.opencode/agents/web-agent.md', [
    '---',
    'description: >-',
    '  Portable demo project.',
    'mode: subagent',
    'model: inherit',
    '---',
    '<!-- steepy:generated:web-agent-opencode:v1 -->',
    '',
    '# web-agent',
    '',
    'You are the specialist agent for the `web` surface at `apps/web`.',
    '',
    'Run the `portable-demo-bootstrap` skill, then read `.apex/standards/web.md` before working on this surface. Follow that standard without copying its rules into this adapter.',
    '',
  ].join('\n'));
  return hub;
}

function preparatoryHub() {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-portable-preparatory-'));
  mkdirSync(join(hub, '.apex'), { recursive: true });
  mkdirSync(join(hub, 'apps', 'web'), { recursive: true });
  const { row } = scaffold({
    name: 'web',
    surfacePath: 'apps/web',
    agent: 'web-agent',
    hubRoot: hub,
    templatesDir: templates,
    testCmd: 'npm test',
  });
  putPortable(hub, '.apex/_INDEX.md', [
    '<!-- steepy-hub-version: 1 -->',
    '# Index',
    '- [Web](standards/web.md)',
    '',
    '| Surface | Min docs | Specialist agent | Applicable skill |',
    '|---|---|---|---|',
    row,
    '',
  ].join('\n'));
  return hub;
}

function modularPreparatoryHub() {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-portable-modular-preparatory-'));
  mkdirSync(join(hub, 'apps', 'web'), { recursive: true });
  const corePath = '.apex/standards/web/web-core.md';
  putPortable(hub, corePath, [
    '# web — Surface Core',
    '',
    '> Owning path: `apps/web`. Read this before editing `apps/web`.',
    '',
    '## Scope',
    '- Owns: web.',
    '',
  ].join('\n'));
  const repaired = scaffold({
    name: 'web',
    surfacePath: 'apps/web',
    agent: 'web-agent',
    hubRoot: hub,
    templatesDir: templates,
    testCmd: 'npm test',
    repair: true,
  });
  assert.equal(repaired.standardPath, join(hub, corePath));
  assert.ok(repaired.preserved.includes('standard'));
  putPortable(hub, '.apex/_INDEX.md', [
    '<!-- steepy-hub-version: 1 -->',
    '# Index',
    '- [Web core](standards/web/web-core.md)',
    '',
    '| Surface | Min docs | Specialist agent | Applicable skill |',
    '|---|---|---|---|',
    '| `web` | [standards/web/web-core.md](standards/web/web-core.md) | `web-agent` | — |',
    '',
  ].join('\n'));
  return hub;
}

function portableErrors(hub) {
  return collectViolations(hub).filter((item) => item.level === 'error');
}

test('good hub: zero error-level violations', () => {
  const v = collectViolations(fx('good-hub')).filter((x) => x.level === 'error');
  assert.deepEqual(v, []);
});

test('portable v1: a complete canonical hub is valid', () => {
  const violations = collectViolations(portableHub());
  assert.deepEqual(violations.filter((item) => item.level === 'error'), [], JSON.stringify(violations));
  assert.equal(violations.some((item) => /portable-v1: unmarked/i.test(item.msg)), false);
});

test('portable v1: an untouched v1.0.0-v1.0.4 bootstrap only warns, while quiet mode and the Stop hook stay silent', () => {
  const hub = portableHub();
  try {
    const path = '.agents/skills/portable-demo-bootstrap/SKILL.md';
    putPortable(hub, path, V1_0_PORTABLE_DEMO_BOOTSTRAP);
    const violations = collectViolations(hub);
    assert.deepEqual(violations.filter(({ level }) => level === 'error'), [], JSON.stringify(violations));
    assert.deepEqual(
      violations.filter(({ msg }) => msg.startsWith('portable-v1:')),
      [{
        level: 'warn',
        msg: `portable-v1: canonical bootstrap at ${path} is the v1.0.0-v1.0.4 rendering; init repair updates it to the current rendering`,
      }],
    );

    const loud = captureMain([hub]);
    assert.equal(loud.code, 0, loud.err);
    assert.match(loud.out, /OK/u);
    assert.match(loud.err, /warn: portable-v1: canonical bootstrap at .* is the v1\.0\.0-v1\.0\.4 rendering/u);
    assert.deepEqual(captureMain([hub, '--quiet']), { code: 0, out: '', err: '' });

    const cli = spawnSync(process.execPath, [validator, hub, '--quiet'], { encoding: 'utf8' });
    assert.deepEqual([cli.status, cli.stdout, cli.stderr], [0, '', '']);
    const hook = spawnSync(process.execPath, [stopHook, hub], { input: '{}', encoding: 'utf8' });
    assert.deepEqual([hook.status, hook.stdout, hook.stderr], [0, '', '']);
  } finally {
    rmSync(hub, { recursive: true, force: true });
  }
});

test('portable v1: any byte beyond the v1.0.0-v1.0.4 bootstrap rendering stays customized', () => {
  const path = '.agents/skills/portable-demo-bootstrap/SKILL.md';
  for (const [label, bytes] of [
    ['one extra trailing byte', `${V1_0_PORTABLE_DEMO_BOOTSTRAP}\n`],
    ['one extra inner byte', V1_0_PORTABLE_DEMO_BOOTSTRAP.replace('Use this skill', 'Use this  skill')],
    ['CRLF line endings', V1_0_PORTABLE_DEMO_BOOTSTRAP.replaceAll('\n', '\r\n')],
  ]) {
    const hub = portableHub();
    try {
      putPortable(hub, path, bytes);
      const portable = collectViolations(hub).filter(({ msg }) => msg.startsWith('portable-v1:'));
      assert.deepEqual(portable, [{
        level: 'error',
        msg: `portable-v1: canonical bootstrap at ${path} is customized`,
      }], label);
      assert.equal(captureMain([hub, '--quiet']).code, 1, label);
      const hook = spawnSync(process.execPath, [stopHook, hub], { input: '{}', encoding: 'utf8' });
      assert.equal(JSON.parse(hook.stdout).decision, 'block', label);
    } finally {
      rmSync(hub, { recursive: true, force: true });
    }
  }
});

test('portable v1: an exact complete new-surface preparatory triad remains compatible before project binding', () => {
  const hub = preparatoryHub();
  assert.deepEqual(portableErrors(hub), []);
  assert.equal(captureMain([hub]).code, 0);
});

test('portable v1: one exact preparatory triad cannot mask a wholly absent routed triad', () => {
  const hub = preparatoryHub();
  putPortable(hub, '.apex/standards/api.md', [
    '# api — Technical Standard',
    '',
    '> Owning surface: `apps/api`.',
    '',
  ].join('\n'));
  putPortable(hub, '.apex/_INDEX.md',
    readFileSync(join(hub, '.apex/_INDEX.md'), 'utf8')
      .replace('- [Web](standards/web.md)', [
        '- [Web](standards/web.md)',
        '- [API](standards/api.md)',
      ].join('\n'))
      .replace('| `web` | [standards/web.md](standards/web.md) | `web-agent` | — |', [
        '| `web` | [standards/web.md](standards/web.md) | `web-agent` | — |',
        '| `api` | [standards/api.md](standards/api.md) | `api-agent` | — |',
      ].join('\n')));

  const messages = portableErrors(hub).map(({ msg }) => msg).join('\n');
  assert.match(messages, /portable-v1:.*api-agent.*claude.*missing/i);
  assert.match(messages, /portable-v1:.*api-agent.*codex.*missing/i);
  assert.match(messages, /portable-v1:.*api-agent.*opencode.*missing/i);
  assert.equal(captureMain(['--quiet', hub]).code, 1);
});

test('portable v1: one-member and two-member preparatory placeholder sets fail closed', () => {
  for (const [label, remove] of [
    ['one-member', ['.codex/agents/web-agent.toml', '.opencode/agents/web-agent.md']],
    ['two-member', ['.opencode/agents/web-agent.md']],
  ]) {
    const hub = preparatoryHub();
    for (const path of remove) unlinkSync(join(hub, path));
    const errors = portableErrors(hub);
    assert.ok(errors.length > 0, `${label}: ${JSON.stringify(errors)}`);
    assert.match(errors.map(({ msg }) => msg).join('\n'), /portable-v1:.*missing/i, label);
    const quiet = captureMain(['--quiet', hub]);
    assert.equal(quiet.code, 1, label);
    assert.match(quiet.err, /violation/i, label);
  }
});

test('portable v1: invalid preparatory versions, markers, bodies, targets, identities, and mixed triads fail', () => {
  const cases = [
    ['unknown-version', (hub) => putPortable(
      hub,
      '.codex/agents/web-agent.toml',
      readFileSync(join(hub, '.codex/agents/web-agent.toml'), 'utf8').replace(':v1', ':v2'),
    )],
    ['malformed-marker', (hub) => putPortable(
      hub,
      '.claude/agents/web-agent.md',
      `${readFileSync(join(hub, '.claude/agents/web-agent.md'), 'utf8')}<!-- steepy:generated:web-agent-claude:v1 -->\n`,
    )],
    ['customized-body', (hub) => putPortable(
      hub,
      '.opencode/agents/web-agent.md',
      readFileSync(join(hub, '.opencode/agents/web-agent.md'), 'utf8').replace('mode: subagent', 'mode: primary'),
    )],
    ['wrong-target', (hub) => renameSync(
      join(hub, '.codex/agents/web-agent.toml'),
      join(hub, '.codex/agents/relocated.toml'),
    )],
    ['identity-mismatch', (hub) => putPortable(
      hub,
      '.codex/agents/web-agent.toml',
      readFileSync(join(hub, '.codex/agents/web-agent.toml'), 'utf8')
        .replace('web-agent-codex:v1', 'api-agent-codex:v1'),
    )],
    ['wrong-standard', (hub) => putPortable(
      hub,
      '.claude/agents/web-agent.md',
      readFileSync(join(hub, '.claude/agents/web-agent.md'), 'utf8')
        .replace('.apex/standards/web.md', '.apex/standards/api.md'),
    )],
    ['mixed-project-bound', (hub) => putPortable(
      hub,
      '.opencode/agents/web-agent.md',
      readFileSync(join(hub, '.opencode/agents/web-agent.md'), 'utf8')
        .replace('`project-bootstrap`', '`portable-demo-bootstrap`'),
    )],
  ];

  for (const [label, mutate] of cases) {
    const hub = preparatoryHub();
    mutate(hub);
    const errors = portableErrors(hub);
    assert.ok(errors.length > 0, `${label} fell through to exit 0`);
    assert.equal(captureMain([hub]).code, 1, label);
    assert.equal(collectViolations(hub).some((item) => /portable-v1: unmarked/i.test(item.msg)), false, label);
  }
});

test('portable v1: a copied adapter outside agents exposes duplicate and wrong-target provenance', () => {
  const hub = preparatoryHub();
  const canonical = '.codex/agents/web-agent.toml';
  const relocated = '.codex/relocated/web-agent.toml';
  putPortable(hub, relocated, readFileSync(join(hub, canonical), 'utf8'));

  const messages = portableErrors(hub).map(({ msg }) => msg).join('\n');
  assert.match(messages, /portable-v1:.*web-agent-codex.*duplicate provenance/i);
  assert.match(messages, /portable-v1:.*web-agent-codex.*wrong target.*\.codex\/relocated\/web-agent\.toml/i);
  assert.equal(captureMain(['--quiet', hub]).code, 1);
});

test('portable v1: an adapter moved outside agents stays missing at canonical and wrong at relocated target', () => {
  const hub = preparatoryHub();
  const canonical = '.codex/agents/web-agent.toml';
  const relocated = '.codex/relocated/web-agent.toml';
  mkdirSync(dirname(join(hub, relocated)), { recursive: true });
  renameSync(join(hub, canonical), join(hub, relocated));

  const messages = portableErrors(hub).map(({ msg }) => msg).join('\n');
  assert.match(messages, /portable-v1:.*web-agent codex adapter is missing.*\.codex\/agents\/web-agent\.toml/i);
  assert.match(messages, /portable-v1:.*web-agent-codex.*wrong target.*\.codex\/relocated\/web-agent\.toml/i);
  assert.equal(captureMain(['--quiet', hub]).code, 1);
});

test('portable v1: a canonical project artifact closes validation over unresolved preparatory adapters', () => {
  const hub = preparatoryHub();
  const canonical = portableHub();
  putPortable(hub, 'AGENTS.md', readFileSync(join(canonical, 'AGENTS.md'), 'utf8'));

  const messages = portableErrors(hub).map(({ msg }) => msg).join('\n');
  assert.match(messages, /portable-v1:.*web-agent.*claude.*customized/i);
  assert.match(messages, /portable-v1:.*web-agent.*codex.*customized/i);
  assert.match(messages, /portable-v1:.*web-agent.*opencode.*customized/i);
  assert.equal(captureMain([hub]).code, 1);
});

test('portable v1: Task 5 modular-core repair triads are exact only while complete and unbound', () => {
  const exact = modularPreparatoryHub();
  assert.deepEqual(portableErrors(exact), []);
  assert.equal(captureMain([exact]).code, 0);

  for (const adapter of ['claude', 'codex', 'opencode']) {
    const extension = adapter === 'codex' ? 'toml' : 'md';
    const path = `.${adapter}/agents/web-agent.${extension}`;

    const removed = modularPreparatoryHub();
    unlinkSync(join(removed, path));
    assert.ok(portableErrors(removed).length > 0, `${adapter} removal fell through`);
    assert.equal(captureMain([removed]).code, 1, `${adapter} removal`);

    const mutated = modularPreparatoryHub();
    const original = readFileSync(join(mutated, path), 'utf8');
    const mutation = adapter === 'codex'
      ? original.replace('description = "Specialist', 'description = "Changed')
      : original.replace('model', 'changed-model');
    assert.notEqual(mutation, original, `${adapter} fixture mutation must change bytes`);
    putPortable(
      mutated,
      path,
      mutation,
    );
    assert.ok(portableErrors(mutated).length > 0, `${adapter} mutation fell through`);
    assert.equal(captureMain([mutated]).code, 1, `${adapter} mutation`);
  }

  const activated = modularPreparatoryHub();
  const canonical = portableHub();
  putPortable(activated, 'AGENTS.md', readFileSync(join(canonical, 'AGENTS.md'), 'utf8'));
  const messages = portableErrors(activated).map(({ msg }) => msg).join('\n');
  assert.match(messages, /portable-v1:.*web-agent.*claude.*customized/i);
  assert.match(messages, /portable-v1:.*web-agent.*codex.*customized/i);
  assert.match(messages, /portable-v1:.*web-agent.*opencode.*customized/i);
  assert.equal(captureMain([activated]).code, 1);
});

test('portable v1: a full project fails when producer adapters target single-file but routing targets modular core', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-portable-active-modular-'));
  putPortable(hub, '.apex/standards/web/web-core.md', [
    '# web — Surface Core',
    '',
    '> Owning path: `apps/web`. Read this before editing `apps/web`.',
    '',
    '## Scope',
    '- Owns: web.',
    '',
  ].join('\n'));
  putPortable(hub, '.apex/_INDEX.md', [
    '<!-- steepy-hub-version: 1 -->',
    '# Index',
    '- [Web core](standards/web/web-core.md)',
    '',
    '| Surface | Min docs | Specialist agent | Applicable skill |',
    '|---|---|---|---|',
    '| `web` | [standards/web/web-core.md](standards/web/web-core.md) | `web-agent` | — |',
    '',
  ].join('\n'));
  const plan = planProjectScaffold({
    hubRoot: hub,
    templatesDir: templates,
    model: {
      projectName: 'portable-demo',
      description: 'Portable demo project.',
      devCommands: ['npm test'],
      surfaces: [{ name: 'web', path: 'apps/web', agent: 'web-agent', testCmd: 'npm test' }],
      resolutions: {},
    },
  });
  applyProjectScaffold({ hubRoot: hub, plan });

  assert.equal(existsSync(join(hub, '.apex/standards/web.md')), false);
  assert.match(
    readFileSync(join(hub, '.claude/agents/web-agent.md'), 'utf8'),
    /\.apex\/standards\/web\.md/,
  );
  const messages = portableErrors(hub).map(({ msg }) => msg).join('\n');
  assert.match(messages, /portable-v1:.*standard.*adapter.*mismatch/i);
  assert.equal(captureMain(['--quiet', hub]).code, 1);
});

test('portable v1: managed root blocks require producer placement and accept producer-preserved content', () => {
  const preserved = portableHub();
  putPortable(preserved, 'AGENTS.md', '# User-owned AGENTS instructions\n');
  putPortable(preserved, 'CLAUDE.md', '# User-owned Claude instructions\n');
  applyProjectScaffold({
    hubRoot: preserved,
    plan: planProjectScaffold({
      hubRoot: preserved,
      templatesDir: templates,
      model: {
        projectName: 'portable-demo',
        description: 'Portable demo project.',
        devCommands: ['npm test'],
        surfaces: [{ name: 'web', path: 'apps/web', agent: 'web-agent', testCmd: 'npm test' }],
        resolutions: {},
      },
    }),
  });
  assert.match(
    readFileSync(join(preserved, 'AGENTS.md'), 'utf8'),
    /^# User-owned AGENTS instructions\n\n<!-- steepy:managed:project-instructions:v1:start -->/u,
  );
  assert.match(
    readFileSync(join(preserved, 'CLAUDE.md'), 'utf8'),
    /^# User-owned Claude instructions\n\n<!-- steepy:managed:claude-import:v1:start -->/u,
  );
  assert.deepEqual(portableErrors(preserved), []);

  for (const [path, label] of [
    ['AGENTS.md', 'project instructions'],
    ['CLAUDE.md', 'CLAUDE.md managed import'],
  ]) {
    for (const [position, relocate] of [
      ['before', (content) => `# Misplaced user content\n${content}`],
      ['after', (content) => `${content}# Misplaced user content\n`],
    ]) {
      const hub = portableHub();
      putPortable(hub, path, relocate(readFileSync(join(hub, path), 'utf8')));
      const messages = portableErrors(hub).map(({ msg }) => msg).join('\n');
      assert.match(messages, new RegExp(`portable-v1:.*${label}.*position`, 'i'), `${path} ${position}`);
      assert.equal(captureMain(['--quiet', hub]).code, 1, `${path} ${position}`);
    }
  }
});

test('portable v1: a stamped Claude-only hub is rejected by both normal and quiet validation', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-portable-unmarked-'));
  putPortable(hub, '.apex/_INDEX.md', [
    '<!-- steepy-hub-version: 1 -->',
    '# Index',
    '- [Web](standards/web.md)',
    '| Surface | Docs | Agent | Skill |',
    '|---|---|---|---|',
    '| `web` | [standards/web.md](standards/web.md) | `web-agent` | — |',
  ].join('\n'));
  putPortable(hub, '.apex/standards/web.md', '# web\n');
  putPortable(hub, '.claude/agents/web-agent.md', '# unmarked web agent\n');

  const violations = collectViolations(hub);
  assert.ok(violations.some((item) => item.level === 'error' && /unsupported project artifacts/i.test(item.msg)));
  assert.equal(captureMain([hub]).code, 1);
  assert.equal(captureMain(['--quiet', hub]).code, 1);
});

test('portable v1: any v1 fragment closes validation and missing canonicals cannot fall back to unmarked', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-portable-partial-'));
  putPortable(hub, '.apex/_INDEX.md', [
    '# Index',
    '- [Web](standards/web.md)',
    '| Surface | Docs | Agent | Skill |',
    '|---|---|---|---|',
    '| `web` | [standards/web.md](standards/web.md) | `web-agent` | — |',
  ].join('\n'));
  putPortable(hub, '.apex/standards/web.md', '# web\n');
  putPortable(hub, '.claude/agents/web-agent.md', '# unmarked web agent\n');
  putPortable(hub, 'AGENTS.md', [
    '<!-- steepy:managed:project-instructions:v1:start -->',
    '# incomplete',
    '<!-- steepy:managed:project-instructions:v1:end -->',
  ].join('\n'));

  const messages = collectViolations(hub).filter((item) => item.level === 'error').map((item) => item.msg).join('\n');
  assert.match(messages, /portable-v1:.*project instructions.*customized/i);
  assert.match(messages, /portable-v1:.*CLAUDE\.md.*missing/i);
  assert.match(messages, /portable-v1:.*canonical bootstrap.*missing/i);
  assert.match(messages, /portable-v1:.*web-agent.*codex.*missing/i);
  assert.match(messages, /portable-v1:.*web-agent.*opencode.*missing/i);
  assert.match(messages, /portable-v1:.*web-agent.*claude.*customized/i);
  assert.equal(captureMain([hub]).code, 1);
});

test('portable v1: routing, standard, and adapter identities are a coherent bijection', () => {
  const mismatch = portableHub();
  putPortable(mismatch, '.codex/agents/web-agent.toml',
    readFileSync(join(mismatch, '.codex/agents/web-agent.toml'), 'utf8')
      .replace('web-agent-codex:v1', 'api-agent-codex:v1'));
  putPortable(mismatch, '.opencode/agents/web-agent.md',
    readFileSync(join(mismatch, '.opencode/agents/web-agent.md'), 'utf8')
      .replace('.apex/standards/web.md', '.apex/standards/api.md'));
  const mismatchMessages = collectViolations(mismatch).map((item) => item.msg).join('\n');
  assert.match(mismatchMessages, /portable-v1:.*codex.*surface-mismatch/i);
  assert.match(mismatchMessages, /portable-v1:.*opencode.*customized|portable-v1:.*standard.*mismatch/i);

  const collision = portableHub();
  putPortable(collision, '.apex/_INDEX.md',
    readFileSync(join(collision, '.apex/_INDEX.md'), 'utf8')
      .replace('| `web` | [standards/web.md](standards/web.md) | `web-agent` | — |', [
        '| `web` | [standards/web.md](standards/web.md) | `web-agent` | — |',
        '| `api` | [standards/web.md](standards/web.md) | `web-agent` | — |',
      ].join('\n')));
  const collisionMessages = collectViolations(collision).map((item) => item.msg).join('\n');
  assert.match(collisionMessages, /portable-v1:.*collision/i);
});

test('portable v1: malformed, unknown-version, duplicate, orphan, and customized artifacts are errors', () => {
  const hub = portableHub();
  putPortable(hub, 'AGENTS.md',
    `${readFileSync(join(hub, 'AGENTS.md'), 'utf8')}<!-- steepy:managed:project-instructions:v1:start -->\n`);
  putPortable(hub, '.codex/agents/web-agent.toml',
    readFileSync(join(hub, '.codex/agents/web-agent.toml'), 'utf8').replace(':v1', ':v2'));
  putPortable(hub, '.claude/agents/web-agent.md',
    readFileSync(join(hub, '.claude/agents/web-agent.md'), 'utf8').replace('Portable demo project.', 'Customized description.'));
  putPortable(hub, '.opencode/agents/ghost-agent.md', '<!-- steepy:generated:ghost-agent-opencode:v1 -->\n');

  const messages = collectViolations(hub).filter((item) => item.level === 'error').map((item) => item.msg).join('\n');
  assert.match(messages, /portable-v1:.*project instructions.*duplicate/i);
  assert.match(messages, /portable-v1:.*codex.*unknown-version/i);
  assert.match(messages, /portable-v1:.*claude.*customized/i);
  assert.match(messages, /portable-v1:.*ghost-agent.*orphan/i);
});

test('uninitialized repo (no .apex/ hub): zero violations, hook stays silent', () => {
  // A repo that never ran init has no .apex/ directory at all. The Stop hook
  // runs validate-hub on every Stop in every project, so an absent hub must be a
  // no-op (exit 0), NOT a "missing _INDEX.md" error. An empty .apex/ that exists but
  // lacks _INDEX.md is still a genuine error (the repo opted into steepy).
  const repo = mkdtempSync(join(tmpdir(), 'steepy-uninit-'));
  assert.deepEqual(collectViolations(repo), []);

  const optedIn = mkdtempSync(join(tmpdir(), 'steepy-broken-'));
  mkdirSync(join(optedIn, '.apex'), { recursive: true });
  const broken = collectViolations(optedIn);
  assert.equal(broken.length, 1);
  assert.match(broken[0].msg, /missing _INDEX\.md/);
});

test('stable reads reject an external root-index symlink without consuming its sentinel bytes', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-index-symlink-'));
  const external = mkdtempSync(join(tmpdir(), 'steepy-index-external-'));
  mkdirSync(join(hub, '.apex'));
  const sentinel = 'EXTERNAL_INDEX_SENTINEL_MUST_NOT_BE_READ';
  writeFileSync(join(external, '_INDEX.md'), `# ${sentinel}\n`);
  symlinkSync(join(external, '_INDEX.md'), join(hub, '.apex', '_INDEX.md'));

  const result = runValidator(hub);
  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(sentinel));
  assert.match(result.stderr, /stable-read: \.apex\/_INDEX\.md is symlink/i);
});

test('external .apex mount preserves portable validation and repository-relative links', () => {
  for (const relativeLink of [false, true]) {
    const hub = portableHub();
    const external = mkdtempSync(join(tmpdir(), 'steepy-external-apex-'));
    try {
      const baseline = collectViolations(hub);
      renameSync(join(hub, '.apex'), join(external, 'hub'));
      symlinkSync(relativeLink ? relative(hub, join(external, 'hub')) : join(external, 'hub'), join(hub, '.apex'), 'dir');
      assert.deepEqual(collectViolations(hub), baseline);
      assert.equal(runValidator(hub).status, 0);
      writeFileSync(join(external, 'hub', 'extra.md'), '# Extra\n- [Root](../AGENTS.md)\n');
      const index = join(external, 'hub', '_INDEX.md');
      writeFileSync(index, readFileSync(index, 'utf8') + '\n- [Extra](extra.md)\n');
      mkdirSync(join(external, 'hub', 'work'), { recursive: true });
      writeFileSync(join(external, 'hub', 'work', 'ignored.md'), '[Missing](missing.md)\n');
      assert.deepEqual(collectViolations(hub), baseline);
      writeFileSync(join(external, 'hub', 'orphan.md'), '# Orphan\n');
      assert.match(collectViolations(hub).map(v => v.msg).join('\n'), /anti-orphan: .apex\/orphan.md/);
      writeFileSync(index, readFileSync(index, 'utf8') + '\n- [Work](work/ignored.md)\n');
      assert.match(collectViolations(hub).map(v => v.msg).join('\n'), /stable docs must not link into .apex\/work/);
      symlinkSync(join(external, 'hub', 'work'), join(external, 'hub', 'alias'), 'dir');
      assert.match(collectViolations(hub).map(v => v.msg).join('\n'), /stable-read: .apex\/alias is symlink/);
      symlinkSync(join(hub, 'AGENTS.md'), join(external, 'hub', 'nested.md'));
      assert.match(collectViolations(hub).map(v => v.msg).join('\n'), /stable-read: .apex\/nested.md is symlink/);
    } finally {
      rmSync(hub, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  }
});

test('invalid .apex mounts are errors rather than absent hubs', () => {
  for (const kind of ['dangling', 'file', 'loop']) {
    const hub = mkdtempSync(join(tmpdir(), 'steepy-invalid-apex-'));
    try {
      const target = join(hub, 'target');
      if (kind === 'file') writeFileSync(target, '# Not a directory\n');
      symlinkSync(kind === 'loop' ? '.apex' : target, join(hub, '.apex'));
      const result = runValidator(hub);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /stable-read: .apex/);
    } finally {
      rmSync(hub, { recursive: true, force: true });
    }
  }
});

test('hub-root admission refuses a direct root symlink before external index bytes are consumed', () => {
  const parent = mkdtempSync(join(tmpdir(), 'steepy-root-direct-link-'));
  const external = mkdtempSync(join(tmpdir(), 'steepy-root-direct-external-'));
  mkdirSync(join(external, '.apex'));
  const sentinel = 'DIRECT_ROOT_LINK_SENTINEL_MUST_NOT_BE_READ.md';
  writeFileSync(join(external, '.apex', '_INDEX.md'), `# Index\n- [sentinel](${sentinel})\n`);
  const alias = join(parent, 'root-alias');
  symlinkSync(external, alias, 'dir');

  const result = runValidator(alias);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /stable-read: hub root is symlink/i);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(sentinel));
});

test('hub-root admission rejects parent traversal before alias and file components are normalized away', () => {
  for (const kind of ['symlink', 'file']) {
    const fixture = mkdtempSync(join(tmpdir(), `steepy-root-parent-${kind}-`));
    const lexical = join(fixture, 'lexical');
    const physical = join(fixture, 'physical');
    mkdirSync(join(lexical, 'project', '.apex'), { recursive: true });
    mkdirSync(join(physical, 'child'), { recursive: true });
    mkdirSync(join(physical, 'project', '.apex'), { recursive: true });
    const lexicalSentinel = `LEXICAL_${kind.toUpperCase()}_NAMESAKE_MUST_NOT_BE_READ.md`;
    const physicalSentinel = `PHYSICAL_${kind.toUpperCase()}_NAMESAKE_MUST_NOT_BE_READ.md`;
    writeFileSync(join(lexical, 'project', '.apex', '_INDEX.md'), `# Index\n- [sentinel](${lexicalSentinel})\n`);
    writeFileSync(join(physical, 'project', '.apex', '_INDEX.md'), `# Index\n- [sentinel](${physicalSentinel})\n`);
    const component = join(lexical, kind === 'symlink' ? 'alias' : 'file');
    if (kind === 'symlink') symlinkSync(join(physical, 'child'), component, 'dir');
    else writeFileSync(component, 'ordinary blocker\n');
    const supplied = `${component}${process.platform === 'win32' ? '\\' : '/'}..${process.platform === 'win32' ? '\\' : '/'}project`;

    const result = runValidator(supplied);
    assert.equal(result.status, 1, `${kind}: ${result.stderr}`);
    assert.match(result.stderr, /stable-read: hub root contains unsupported parent traversal/i);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(lexicalSentinel));
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(physicalSentinel));
  }
});

test('hub-root admission preserves ordinary relative coherent and no-hub roots', () => {
  const coherent = runValidator('.', 2_000, fx('good-hub'));
  assert.equal(coherent.status, 0, coherent.stderr);
  assert.match(coherent.stdout, /OK — doc graph is coherent/);

  const noHub = mkdtempSync(join(tmpdir(), 'steepy-relative-no-hub-'));
  const absent = runValidator('.', 2_000, noHub);
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /no \.apex hub found/i);
});

test('stable reads reject a root-index FIFO within the subprocess bound', {
  skip: !['darwin', 'linux'].includes(process.platform),
}, () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-index-fifo-'));
  mkdirSync(join(hub, '.apex'));
  makeFifo(join(hub, '.apex', '_INDEX.md'));

  const result = runValidator(hub);
  assert.notEqual(result.error?.code, 'ETIMEDOUT');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /stable-read: \.apex\/_INDEX\.md is non-file/i);
});

test('BFS refuses a symlink into work and never lets work sentinel links establish reachability', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-bfs-work-symlink-'));
  mkdirSync(join(hub, '.apex', 'decisions'), { recursive: true });
  mkdirSync(join(hub, '.apex', 'work'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n- [Decisions](decisions/_INDEX.md)\n');
  writeFileSync(join(hub, '.apex', 'leaf.md'), '# Stable leaf\n');
  writeFileSync(
    join(hub, '.apex', 'work', 'sentinel.md'),
    '# WORK_SENTINEL_MUST_NOT_BE_READ\n- [Leaf](../leaf.md)\n',
  );
  symlinkSync(join(hub, '.apex', 'work', 'sentinel.md'), join(hub, '.apex', 'decisions', '_INDEX.md'));

  const messages = collectViolations(hub).map((item) => item.msg).join('\n');
  assert.match(messages, /stable-read: \.apex\/decisions\/_INDEX\.md is symlink/i);
  assert.match(messages, /anti-orphan: \.apex\/leaf\.md/);
  assert.doesNotMatch(messages, /WORK_SENTINEL_MUST_NOT_BE_READ/);
});

test('BFS refuses an external symlink and preserves native backslash filename identity', {
  skip: process.platform === 'win32',
}, () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-bfs-external-symlink-'));
  const external = mkdtempSync(join(tmpdir(), 'steepy-bfs-external-target-'));
  mkdirSync(join(hub, '.apex', 'notes'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), [
    '# Index',
    '- [External](notes/external.md)',
    '- [Literal backslash](notes\\literal.md)',
    '',
  ].join('\n'));
  writeFileSync(join(external, 'sentinel.md'), '# EXTERNAL_BFS_SENTINEL_MUST_NOT_BE_READ\n');
  symlinkSync(join(external, 'sentinel.md'), join(hub, '.apex', 'notes', 'external.md'));
  writeFileSync(join(hub, '.apex', 'notes\\literal.md'), '# Legal POSIX filename\n');

  const messages = collectViolations(hub).map((item) => item.msg).join('\n');
  assert.match(messages, /stable-read: \.apex\/notes\/external\.md is symlink/i);
  assert.doesNotMatch(messages, /EXTERNAL_BFS_SENTINEL_MUST_NOT_BE_READ/);
  assert.doesNotMatch(messages, /notes\\literal\.md.*broken link/i);
});

test('bad hub: flags orphan, unrouted agent, and broken link', () => {
  const msgs = collectViolations(fx('bad-hub')).map((x) => x.msg).join('\n');
  assert.match(msgs, /orphan/i);
  assert.match(msgs, /ghost-agent/);
  assert.match(msgs, /nope\.md/);
});

test('single-CLAUDE rule is opt-in (off by default)', () => {
  const off = collectViolations(fx('good-hub')).filter((x) => /single-CLAUDE/i.test(x.msg));
  assert.equal(off.length, 0);
});

test('routing-table missing standard produces exactly two violations when also in prose', () => {
  // Build a temp hub where _INDEX.md routing table references a standards/missing.md
  // that does not exist. The same link also appears in prose (below the table).
  // The linter must report exactly TWO violations mentioning 'missing.md':
  //   - one routing: (check 3, from the routing-table row)
  //   - one broken link: (check 4, from the prose line — distinct fault, not a duplicate)
  // This locks in the non-overlapping design: check 3 owns routing-table standards/ links;
  // check 4 owns all other occurrences (prose, non-standards table rows).
  const hub = mkdtempSync(join(tmpdir(), 'steepy-dedup-'));
  mkdirSync(join(hub, '.apex', 'standards'), { recursive: true });
  mkdirSync(join(hub, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(hub, '.apex', 'standards', 'web.md'), '# web\n');
  // Agent that IS referenced in _INDEX.md
  writeFileSync(join(hub, '.claude', 'agents', 'web-agent.md'), '# web-agent\n');
  // _INDEX.md: routing table has TWO rows linking standards/missing.md (duplicated target) —
  // those two rows must collapse to ONE routing: violation (check 3 dedupes).
  // Prose also links standards/missing.md — that yields ONE broken link: violation (check 4).
  // Total: exactly 2 violations mentioning missing.md.
  writeFileSync(join(hub, '.apex', '_INDEX.md'), [
    '# Index',
    '- [Web](standards/web.md)',
    '- [Missing](standards/missing.md)',
    '',
    '| Surface | Docs | Agent | Skill |',
    '|---|---|---|---|',
    '| `web` | [standards/web.md](standards/web.md) | `web-agent` | — |',
    '| `missing` | [standards/missing.md](standards/missing.md) | `web-agent` | — |',
    '| `missing2` | [standards/missing.md](standards/missing.md) | `web-agent` | — |',
  ].join('\n'));

  const violations = collectViolations(hub).filter((v) => v.msg.includes('missing.md'));
  assert.equal(violations.length, 2, `expected 2 violations mentioning missing.md, got: ${JSON.stringify(violations)}`);
  const routingViolation = violations.find((v) => /routing:/.test(v.msg));
  const brokenLinkViolation = violations.find((v) => /broken link:/.test(v.msg));
  assert.ok(routingViolation, 'expected a routing: violation for missing.md');
  assert.ok(brokenLinkViolation, 'expected a broken link: violation for missing.md in prose');
});

test('non-standards broken link in routing-table row is flagged by check 4', () => {
  // Regression test for the coverage gap: a broken link in a routing-table row that
  // does NOT contain 'standards/' was previously checked by neither check 3 nor check 4.
  // After the fix, check 4 must report it exactly once.
  const hub = mkdtempSync(join(tmpdir(), 'steepy-nonstd-'));
  mkdirSync(join(hub, '.apex', 'standards'), { recursive: true });
  mkdirSync(join(hub, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(hub, '.apex', 'standards', 'web.md'), '# web\n');
  writeFileSync(join(hub, '.claude', 'agents', 'web-agent.md'), '# web-agent\n');
  // _INDEX.md: routing table row links skills/ghost.md which does NOT exist.
  // This is a non-standards path so check 3 ignores it; check 4 must catch it.
  writeFileSync(join(hub, '.apex', '_INDEX.md'), [
    '# Index',
    '- [Web](standards/web.md)',
    '',
    '| Surface | Docs | Agent | Skill |',
    '|---|---|---|---|',
    '| `web` | [standards/web.md](standards/web.md) | `web-agent` | [ghost](skills/ghost.md) |',
  ].join('\n'));

  const violations = collectViolations(hub).filter((v) => v.msg.includes('skills/ghost.md'));
  assert.equal(violations.length, 1, `expected 1 violation for skills/ghost.md, got: ${JSON.stringify(violations)}`);
  assert.match(violations[0].msg, /broken link:/);
});

test('routing check: an agent named only in prose (not a table row) is still unrouted', () => {
  // Check 2 must require the agent to appear as a backtick token in a ROUTING-TABLE
  // ROW (a line starting with '|'), not merely anywhere in _INDEX.md. A prose mention
  // like "the `web-agent` handles the web surface" must NOT satisfy routing — otherwise
  // the linter green-lights an agent that has no actual routing entry.
  const hub = mkdtempSync(join(tmpdir(), 'steepy-prose-agent-'));
  mkdirSync(join(hub, '.apex', 'standards'), { recursive: true });
  mkdirSync(join(hub, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(hub, '.apex', 'standards', 'web.md'), '# web\n');
  writeFileSync(join(hub, '.claude', 'agents', 'web-agent.md'), '# web-agent\n');
  // `web-agent` appears ONLY in prose, never in a routing-table row.
  writeFileSync(join(hub, '.apex', '_INDEX.md'), [
    '# Index',
    '- [Web](standards/web.md)',
    '',
    'The `web-agent` handles the web surface.',
    '',
    '| Surface | Docs | Agent | Skill |',
    '|---|---|---|---|',
    '| `web` | [standards/web.md](standards/web.md) | — | — |',
  ].join('\n'));
  const v = collectViolations(hub).filter((x) => /routing:.*web-agent/.test(x.msg));
  assert.equal(v.length, 1, `expected web-agent to be flagged as unrouted, got: ${JSON.stringify(v)}`);
});

test('routing check: an agent in a routing-table row is routed (regression)', () => {
  // The positive case the prose test contrasts with: the same agent placed in the
  // Specialist-agent column of a table row must satisfy routing (no violation).
  const hub = mkdtempSync(join(tmpdir(), 'steepy-row-agent-'));
  mkdirSync(join(hub, '.apex', 'standards'), { recursive: true });
  mkdirSync(join(hub, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(hub, '.apex', 'standards', 'web.md'), '# web\n');
  writeFileSync(join(hub, '.claude', 'agents', 'web-agent.md'), '# web-agent\n');
  writeFileSync(join(hub, '.apex', '_INDEX.md'), [
    '# Index',
    '- [Web](standards/web.md)',
    '',
    '| Surface | Docs | Agent | Skill |',
    '|---|---|---|---|',
    '| `web` | [standards/web.md](standards/web.md) | `web-agent` | — |',
  ].join('\n'));
  const v = collectViolations(hub).filter((x) => /routing:.*web-agent/.test(x.msg));
  assert.deepEqual(v, [], JSON.stringify(v));
});

test('CLAUDE.md with a valid relative link: no broken-link violation', () => {
  const v = collectViolations(fx('good-hub')).filter((x) => /CLAUDE\.md broken link/.test(x.msg));
  assert.deepEqual(v, []);
});

test('CLAUDE.md with a broken relative link is flagged', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-claudemd-'));
  mkdirSync(join(hub, '.apex'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n');
  writeFileSync(
    join(hub, 'CLAUDE.md'),
    '# proj\n\nSee [hub](.apex/_INDEX.md) and [gone](.apex/missing.md).\n'
  );
  const v = collectViolations(hub).filter((x) => /CLAUDE\.md broken link/.test(x.msg));
  assert.equal(v.length, 1, JSON.stringify(v));
  assert.match(v[0].msg, /\.apex\/missing\.md/);
  assert.equal(v[0].level, 'error');
});

test('CLAUDE.md absent: no violation (existence not required)', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-noclaude-'));
  mkdirSync(join(hub, '.apex'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n');
  const v = collectViolations(hub).filter((x) => /CLAUDE\.md broken link/.test(x.msg));
  assert.deepEqual(v, []);
});

test('CLAUDE.md http and anchor links are ignored', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-claudeurl-'));
  mkdirSync(join(hub, '.apex'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n');
  writeFileSync(
    join(hub, 'CLAUDE.md'),
    '# proj\n\n[site](https://example.com) [top](#intro)\n'
  );
  const v = collectViolations(hub).filter((x) => /CLAUDE\.md broken link/.test(x.msg));
  assert.deepEqual(v, []);
});

test('AGENTS.md with a broken relative link is flagged', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-agentsmd-'));
  mkdirSync(join(hub, '.apex'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n');
  writeFileSync(
    join(hub, 'AGENTS.md'),
    '# proj\n\nSee [hub](.apex/_INDEX.md) and [gone](.apex/missing.md).\n'
  );
  const v = collectViolations(hub).filter((x) => /AGENTS\.md broken link/.test(x.msg));
  assert.equal(v.length, 1, JSON.stringify(v));
  assert.match(v[0].msg, /\.apex\/missing\.md/);
  assert.equal(v[0].level, 'error');
});

test('AGENTS.md with a valid relative link: no broken-link violation', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-agentsok-'));
  mkdirSync(join(hub, '.apex'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n');
  writeFileSync(join(hub, 'AGENTS.md'), '# proj\n\nSee [hub](.apex/_INDEX.md).\n');
  const v = collectViolations(hub).filter((x) => /AGENTS\.md broken link/.test(x.msg));
  assert.deepEqual(v, []);
});

test('AGENTS.md absent: no violation (existence not required)', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-noagents-'));
  mkdirSync(join(hub, '.apex'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n');
  const v = collectViolations(hub).filter((x) => /AGENTS\.md broken link/.test(x.msg));
  assert.deepEqual(v, []);
});

test('root AGENTS.md and CLAUDE.md non-files produce controlled stable-read violations', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-root-doc-directories-'));
  mkdirSync(join(hub, '.apex'), { recursive: true });
  mkdirSync(join(hub, 'AGENTS.md'));
  mkdirSync(join(hub, 'CLAUDE.md'));
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n');

  let all;
  assert.doesNotThrow(() => {
    all = collectViolations(hub);
  });
  const rootDocChecks = all.filter((item) => /^stable-read: (?:AGENTS|CLAUDE)\.md/u.test(item.msg));
  assert.equal(rootDocChecks.length, 2, JSON.stringify(all));
  assert.ok(rootDocChecks.every((item) => item.level === 'error'));
  assert.equal(captureMain(['--quiet', hub]).code, 1);
});

test('root instructions mounts are read and their logical links are validated', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-root-doc-symlink-'));
  const external = mkdtempSync(join(tmpdir(), 'steepy-root-doc-external-'));
  mkdirSync(join(hub, '.apex'));
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n');
  writeFileSync(join(external, 'AGENTS.md'), '# Instructions\n[Missing](missing-root-doc.md)\n');
  symlinkSync(join(external, 'AGENTS.md'), join(hub, 'AGENTS.md'));

  const messages = collectViolations(hub).map((item) => item.msg).join('\n');
  assert.doesNotMatch(messages, /stable-read: AGENTS\.md/);
  assert.match(messages, /AGENTS.md broken link: AGENTS.md -> missing-root-doc.md/);
});

test('a stub CLAUDE.md importing @AGENTS.md errors when AGENTS.md is missing', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-stubclaude-'));
  mkdirSync(join(hub, '.apex'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n');
  // The steepy managed claude-import stub shape (templates/claude-import.md).
  writeFileSync(
    join(hub, 'CLAUDE.md'),
    '<!-- steepy:managed:claude-import:v1:start -->\n@AGENTS.md\n<!-- steepy:managed:claude-import:v1:end -->\n'
  );
  const v = collectViolations(hub).filter((x) => /imports @AGENTS\.md but AGENTS\.md is missing/.test(x.msg));
  assert.equal(v.length, 1, JSON.stringify(v));
  assert.equal(v[0].level, 'error');
});

test('a stub CLAUDE.md whose AGENTS.md is present stays silent', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-stubpair-'));
  mkdirSync(join(hub, '.apex'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n');
  writeFileSync(
    join(hub, 'CLAUDE.md'),
    '<!-- steepy:managed:claude-import:v1:start -->\n@AGENTS.md\n<!-- steepy:managed:claude-import:v1:end -->\n'
  );
  writeFileSync(join(hub, 'AGENTS.md'), '# proj\n');
  const v = collectViolations(hub).filter((x) => /imports @AGENTS\.md but AGENTS\.md is missing/.test(x.msg));
  assert.deepEqual(v, []);
});

test('transitive anti-orphan: a stable doc reachable via a sub-index is NOT an orphan', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-reach-'));
  mkdirSync(join(hub, '.apex', 'decisions'), { recursive: true });
  // root -> decisions/_INDEX.md -> decisions/feature.md  (two hops)
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n- [Decisions](decisions/_INDEX.md)\n');
  writeFileSync(join(hub, '.apex', 'decisions', '_INDEX.md'), '# Decisions\n- [Feature](feature.md)\n');
  writeFileSync(join(hub, '.apex', 'decisions', 'feature.md'), '# Feature\n');
  const v = collectViolations(hub).filter((x) => /anti-orphan/.test(x.msg));
  assert.deepEqual(v, [], JSON.stringify(v));
});

test('transitive anti-orphan: a stable doc linked from nowhere IS an orphan', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-orphan-'));
  mkdirSync(join(hub, '.apex', 'decisions'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n- [Decisions](decisions/_INDEX.md)\n');
  writeFileSync(join(hub, '.apex', 'decisions', '_INDEX.md'), '# Decisions\n'); // does NOT link feature.md
  writeFileSync(join(hub, '.apex', 'decisions', 'feature.md'), '# Feature\n');
  const v = collectViolations(hub).filter((x) => /anti-orphan/.test(x.msg));
  assert.equal(v.length, 1, JSON.stringify(v));
  assert.match(v[0].msg, /decisions\/feature\.md/);
});

test('transitive anti-orphan: a cycle in the link graph terminates and stays green', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-cycle-'));
  mkdirSync(join(hub, '.apex'), { recursive: true });
  // root <-> a.md form a cycle; both must be reachable, no infinite loop.
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n- [A](a.md)\n');
  writeFileSync(join(hub, '.apex', 'a.md'), '# A\n- [Back](_INDEX.md)\n');
  const v = collectViolations(hub).filter((x) => /anti-orphan/.test(x.msg));
  assert.deepEqual(v, [], JSON.stringify(v));
});

test('valid parent-relative links stay green after physical component admission', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-parent-link-'));
  mkdirSync(join(hub, '.apex', 'notes'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n- [Note](notes/note.md)\n');
  writeFileSync(join(hub, '.apex', 'conventions.md'), '# Conventions\n');
  writeFileSync(join(hub, '.apex', 'notes', 'note.md'), '# Note\n- [Conventions](../conventions.md)\n');

  const errors = collectViolations(hub).filter((item) => item.level === 'error');
  assert.deepEqual(errors, [], JSON.stringify(errors));
});

test('a symlink component traversed before parent navigation is rejected before normalization', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-pre-normalize-link-'));
  const external = mkdtempSync(join(tmpdir(), 'steepy-pre-normalize-external-'));
  mkdirSync(join(hub, '.apex', 'notes'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n- [Note](notes/note.md)\n');
  writeFileSync(join(hub, '.apex', 'conventions.md'), '# Conventions\n');
  symlinkSync(external, join(hub, '.apex', 'notes', 'alias'));
  writeFileSync(
    join(hub, '.apex', 'notes', 'note.md'),
    '# Note\n- [Unsafe](alias/../conventions.md)\n',
  );

  const messages = collectViolations(hub).map((item) => item.msg).join('\n');
  assert.match(messages, /stable-read: \.apex\/notes\/alias\/\.\.\/conventions\.md has symlinked component/i);
});

test('non-quiet main on a repo with no .apex hub: points to init, not "coherent"', () => {
  // A repo that never opted into steepy has no .apex/ hub. Running the linter directly
  // (non-quiet) must not claim the doc graph is "coherent" — there is nothing to
  // validate. It should tell the user how to opt in. Exit code stays 0 (no-op).
  const repo = mkdtempSync(join(tmpdir(), 'steepy-uninit-main-'));
  const { code, out } = captureMain([repo]);
  assert.equal(code, 0);
  assert.match(out, /no \.apex hub found/i);
  assert.match(out, /init/);
  assert.doesNotMatch(out, /coherent/i);
});

test('quiet main on a repo with no .apex hub: stays completely silent (Stop-hook no-op)', () => {
  // The Stop hook runs `validate-hub --quiet` on every Stop in every project. A repo
  // without a hub must produce ZERO output on stdout and stderr, or the hook would
  // spam unrelated projects. Exit code 0.
  const repo = mkdtempSync(join(tmpdir(), 'steepy-uninit-quiet-'));
  const { code, out, err } = captureMain(['--quiet', repo]);
  assert.equal(code, 0);
  assert.equal(out, '');
  assert.equal(err, '');
});

test('non-quiet main on a coherent hub still reports OK (regression)', () => {
  const { code, out } = captureMain([fx('good-hub')]);
  assert.equal(code, 0);
  assert.match(out, /OK — doc graph is coherent/);
});

test('transitive anti-orphan: links escaping .apex/ are not followed for reachability', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-escape-'));
  mkdirSync(join(hub, '.apex', 'decisions'), { recursive: true });
  // root links OUT of .apex/ (../README.md); that must not make decisions/feature.md reachable.
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n- [Readme](../README.md)\n');
  writeFileSync(join(hub, 'README.md'), '# proj\n- [Feature](.apex/decisions/feature.md)\n');
  writeFileSync(join(hub, '.apex', 'decisions', 'feature.md'), '# Feature\n');
  const v = collectViolations(hub).filter((x) => /anti-orphan/.test(x.msg));
  assert.equal(v.length, 1, JSON.stringify(v));
  assert.match(v[0].msg, /decisions\/feature\.md/);
});

test('work artifacts under .apex/work are ignored by stable hub scans', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-work-ignored-'));
  mkdirSync(join(hub, '.apex', 'work', 'specs'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n');
  writeFileSync(join(hub, '.apex', 'work', 'specs', 'draft.md'), '# Draft\n[Broken](missing.md)\n');

  const v = collectViolations(hub).filter((x) => x.level === 'error');
  assert.deepEqual(v, [], JSON.stringify(v));
});

test('stable hub docs must not link into gitignored .apex/work artifacts', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-work-link-'));
  mkdirSync(join(hub, '.apex', 'work', 'specs'), { recursive: true });
  writeFileSync(join(hub, '.apex', 'work', 'specs', 'draft.md'), '# Draft\n');
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n- [Draft](work/specs/draft.md)\n');

  const v = collectViolations(hub).filter((x) => x.msg.includes('.apex/work'));
  assert.equal(v.length, 1, JSON.stringify(v));
  assert.match(v[0].msg, /stable docs must not link into \.apex\/work/);
  assert.equal(v[0].level, 'error');
});

test('case aliases into reserved work are refused before BFS consumes hidden bytes', (t) => {
  const capability = mkdtempSync(join(tmpdir(), 'steepy-work-case-capability-'));
  if (!storageAliasesCase(capability)) {
    t.skip('temporary storage keeps case-distinct directory identities');
    return;
  }

  for (const alias of ['WORK', 'WoRk']) {
    const hub = mkdtempSync(join(tmpdir(), `steepy-work-case-link-${alias}-`));
    mkdirSync(join(hub, '.apex', 'work'), { recursive: true });
    writeFileSync(join(hub, '.apex', '_INDEX.md'), [
      '# Index',
      `- [Hidden](${alias}/sentinel.md)`,
      `- [Traversal](${alias}/../leaf.md)`,
      '',
    ].join('\n'));
    writeFileSync(join(hub, '.apex', 'work', 'sentinel.md'), [
      '# Hidden',
      '[Sentinel](SYNTHETIC_WORK_BYTE_SENTINEL.md)',
      '[Leaf](../leaf.md)',
      '',
    ].join('\n'));
    writeFileSync(join(hub, '.apex', 'leaf.md'), '# Leaf\n');

    const messages = collectViolations(hub).map(({ msg }) => msg).join('\n');
    assert.match(messages, /enters excluded \.apex\/work|stable docs must not link into \.apex\/work/i, alias);
    assert.match(messages, /anti-orphan: \.apex\/leaf\.md/i, alias);
    assert.doesNotMatch(messages, /SYNTHETIC_WORK_BYTE_SENTINEL/u, alias);
    const cli = runValidator(hub);
    assert.equal(cli.status, 1, `${alias}: ${cli.stderr}`);
    assert.doesNotMatch(`${cli.stdout}\n${cli.stderr}`, /SYNTHETIC_WORK_BYTE_SENTINEL/u, alias);
  }
});

test('nested parent-relative work aliases are refused before hidden BFS reads', (t) => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-work-case-nested-'));
  if (!storageAliasesCase(hub)) {
    t.skip('temporary storage keeps case-distinct directory identities');
    return;
  }
  mkdirSync(join(hub, '.apex', 'docs'), { recursive: true });
  mkdirSync(join(hub, '.apex', 'work'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n- [Start](docs/start.md)\n');
  writeFileSync(join(hub, '.apex', 'docs', 'start.md'), [
    '# Start',
    '- [Hidden](../WoRk/sentinel.md)',
    '- [Traversal](../WORK/../leaf.md)',
    '',
  ].join('\n'));
  writeFileSync(join(hub, '.apex', 'work', 'sentinel.md'), [
    '# Hidden',
    '[Sentinel](NESTED_WORK_BYTE_SENTINEL.md)',
    '[Leaf](../leaf.md)',
    '',
  ].join('\n'));
  writeFileSync(join(hub, '.apex', 'leaf.md'), '# Leaf\n');

  const messages = collectViolations(hub).map(({ msg }) => msg).join('\n');
  assert.match(messages, /enters excluded \.apex\/work/i);
  assert.match(messages, /anti-orphan: \.apex\/leaf\.md/i);
  assert.doesNotMatch(messages, /NESTED_WORK_BYTE_SENTINEL/u);
});

test('root instruction aliases for both apex and work are controlled refusals', (t) => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-work-case-root-link-'));
  if (!storageAliasesCase(hub)) {
    t.skip('temporary storage keeps case-distinct directory identities');
    return;
  }
  mkdirSync(join(hub, '.apex', 'work'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n');
  writeFileSync(join(hub, '.apex', 'work', 'sentinel.md'), '# ROOT_WORK_BYTE_SENTINEL\n');
  writeFileSync(join(hub, 'AGENTS.md'), [
    '# Instructions',
    '- [Hidden](.APEX/WORK/sentinel.md)',
    '- [Traversal](.APEX/WoRk/../_INDEX.md)',
    '',
  ].join('\n'));

  const result = runValidator(hub);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /enters excluded \.apex\/work/i);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /ROOT_WORK_BYTE_SENTINEL/u);
});

test('a noncanonical stored work-case alias is silently excluded from incidental scans', (t) => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-work-case-stored-'));
  mkdirSync(join(hub, '.apex', 'WORK'), { recursive: true });
  if (!storageAliasesCase(hub) || !existsSync(join(hub, '.apex', 'work'))) {
    t.skip('temporary storage keeps case-distinct directory identities');
    return;
  }
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n');
  writeFileSync(
    join(hub, '.apex', 'WORK', 'sentinel.md'),
    '# Hidden\n[Sentinel](STORED_WORK_BYTE_SENTINEL.md)\n',
  );
  writeFileSync(join(hub, '.apex', 'WORK', 'oversized.md'), 'x'.repeat(1024 * 1024 + 1));
  symlinkSync(join(hub, '.apex', '_INDEX.md'), join(hub, '.apex', 'WORK', 'refused.md'));

  assert.deepEqual(collectViolations(hub), []);
  const quiet = captureMain(['--quiet', hub]);
  assert.equal(quiet.code, 0, quiet.err);
  assert.equal(quiet.err, '');
  assert.doesNotMatch(quiet.out, /STORED_WORK_BYTE_SENTINEL/u);
});

test('a physically distinct uppercase WORK directory remains stable content', (t) => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-work-case-distinct-'));
  if (storageAliasesCase(hub)) {
    t.skip('temporary storage aliases case spellings');
    return;
  }
  mkdirSync(join(hub, '.apex', 'WORK'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n');
  writeFileSync(
    join(hub, '.apex', 'WORK', 'visible.md'),
    '# Visible\n[Sentinel](CASE_DISTINCT_VISIBLE_SENTINEL.md)\n',
  );

  const messages = collectViolations(hub).map(({ msg }) => msg).join('\n');
  assert.match(messages, /\.apex\/WORK\/visible\.md/u);
  assert.match(messages, /CASE_DISTINCT_VISIBLE_SENTINEL/u);
  assert.doesNotMatch(messages, /enters excluded \.apex\/work/i);
});

test('warn: a standard over 150 lines is flagged, with no error violations', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-long-standard-'));
  mkdirSync(join(hub, '.apex', 'standards'), { recursive: true });
  writeFileSync(join(hub, '.apex', 'standards', 'long.md'), Array(151).fill('x').join('\n'));
  writeFileSync(join(hub, '.apex', '_INDEX.md'), [
    '# Index',
    '',
    '| Surface | Docs | Agent | Skill |',
    '|---|---|---|---|',
    '| `web` | [standards/long.md](standards/long.md) | — | — |',
  ].join('\n'));

  const all = collectViolations(hub);
  const warns = all.filter((v) => v.level === 'warn');
  const errors = all.filter((v) => v.level === 'error');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(warns.length, 1, JSON.stringify(warns));
  assert.match(warns[0].msg, /consider the modular folder form/);
  assert.equal(captureMain([hub]).code, 0);
});

test('warn boundary: exactly 150 lines with a trailing newline stays silent; 151 warns with the true count', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-boundary-standard-'));
  mkdirSync(join(hub, '.apex', 'standards'), { recursive: true });
  // A trailing newline terminates the 150th line — it must not count as a 151st.
  writeFileSync(join(hub, '.apex', 'standards', 'edge.md'), Array(150).fill('x').join('\n') + '\n');
  writeFileSync(join(hub, '.apex', 'standards', 'long.md'), Array(151).fill('x').join('\n') + '\n');
  writeFileSync(join(hub, '.apex', '_INDEX.md'), [
    '# Index',
    '',
    '| Surface | Docs | Agent | Skill |',
    '|---|---|---|---|',
    '| `edge` | [standards/edge.md](standards/edge.md) | — | — |',
    '| `long` | [standards/long.md](standards/long.md) | — | — |',
  ].join('\n'));

  const warns = collectViolations(hub).filter((v) => v.level === 'warn');
  assert.equal(warns.length, 1, JSON.stringify(warns));
  assert.match(warns[0].msg, /\(151 lines\)/);
  assert.match(warns[0].msg, /long\.md/);
});

test('warn: --quiet never prints warns (Stop hook stays a no-op)', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-long-standard-quiet-'));
  mkdirSync(join(hub, '.apex', 'standards'), { recursive: true });
  writeFileSync(join(hub, '.apex', 'standards', 'long.md'), Array(151).fill('x').join('\n'));
  writeFileSync(join(hub, '.apex', '_INDEX.md'), [
    '# Index',
    '',
    '| Surface | Docs | Agent | Skill |',
    '|---|---|---|---|',
    '| `web` | [standards/long.md](standards/long.md) | — | — |',
  ].join('\n'));

  const { code, out, err } = captureMain(['--quiet', hub]);
  assert.equal(code, 0);
  assert.equal(out, '');
  assert.equal(err, '');
});

test('warn: good-hub standards are all under the threshold', () => {
  const warns = collectViolations(fx('good-hub'))
    .filter((x) => x.level === 'warn' && /standard is long/.test(x.msg));
  assert.deepEqual(warns, []);
});

test('warn: an error and a warn together still fail the build, error still on stderr', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-long-standard-and-error-'));
  mkdirSync(join(hub, '.apex', 'standards'), { recursive: true });
  writeFileSync(join(hub, '.apex', 'standards', 'long.md'), Array(151).fill('x').join('\n'));
  // Orphaned doc (not linked from _INDEX.md) is a genuine error.
  writeFileSync(join(hub, '.apex', 'orphan.md'), '# Orphan\n');
  writeFileSync(join(hub, '.apex', '_INDEX.md'), [
    '# Index',
    '',
    '| Surface | Docs | Agent | Skill |',
    '|---|---|---|---|',
    '| `web` | [standards/long.md](standards/long.md) | — | — |',
  ].join('\n'));

  const { code, err } = captureMain([hub]);
  assert.equal(code, 1);
  assert.match(err, /anti-orphan/);
});

test('modular-hub fixture: zero errors (modular folder form is supported)', () => {
  // Proves the existing engine (no new linter code) already supports a standard
  // shipped as a folder: _INDEX.md routes to the folder's core doc, and the core
  // doc's own mini-routing table links the leaf. The anti-orphan BFS reaches the
  // leaf transitively through the core; check 3 accepts the subfolder target because
  // it still contains 'standards/'.
  // Guard against the false-green trap: an ABSENT hub also yields zero violations
  // (the uninitialized-repo short-circuit in check 0), so the fixture's existence
  // must be asserted directly, not inferred from an empty violations array.
  assert.ok(existsSync(join(fx('modular-hub'), '.apex', 'standards', 'web', 'web-auth.md')),
    'modular-hub fixture leaf standards/web/web-auth.md must exist');
  const all = collectViolations(fx('modular-hub')).filter((item) => item.level === 'error');
  assert.deepEqual(all, [], JSON.stringify(all));
});

test('modular-hub regression: a leaf not linked from its folder core is an anti-orphan', () => {
  // Mutated copy of the modular-hub fixture: web-core.md's mini-routing table no
  // longer links web-auth.md. The leaf becomes unreachable from _INDEX.md, so it
  // must be flagged as exactly one anti-orphan error naming the leaf. No new linter
  // code is exercised here — this is the same BFS check 1 already runs.
  const hub = mkdtempSync(join(tmpdir(), 'steepy-modular-orphan-'));
  mkdirSync(join(hub, '.apex', 'standards', 'web'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), [
    '# Index',
    '- [Standards: web](standards/web/web-core.md)',
    '',
    '| Surface | Docs | Agent | Skill |',
    '|---|---|---|---|',
    '| `web` | [standards/web/web-core.md](standards/web/web-core.md) | `web-agent` | — |',
  ].join('\n'));
  // web-core.md has NO link to web-auth.md (the mutation under test).
  writeFileSync(join(hub, '.apex', 'standards', 'web', 'web-core.md'), [
    '# web core',
    '',
    'Mini-routing table for the web standard\'s sub-areas.',
    '',
    '| Sub-area | When to read it (path/topic) | Doc |',
    '|---|---|---|',
  ].join('\n'));
  writeFileSync(join(hub, '.apex', 'standards', 'web', 'web-auth.md'), '# web auth\n');

  const v = collectViolations(hub).filter((x) => x.level === 'error');
  assert.equal(v.length, 1, JSON.stringify(v));
  assert.match(v[0].msg, /anti-orphan/);
  assert.match(v[0].msg, /web-auth\.md/);
});

test('code-anchor: a dead backtick path citation in .apex/ prose warns once per (file, token)', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-anchor-dead-'));
  mkdirSync(join(hub, '.apex'), { recursive: true });
  // The same dead token is cited twice — check 9 must dedupe to ONE warn.
  writeFileSync(join(hub, '.apex', '_INDEX.md'), [
    '# Index',
    '',
    'See `docs/missing-guide.md` and again `docs/missing-guide.md`.',
  ].join('\n'));

  const all = collectViolations(hub);
  const warns = all.filter((v) => v.level === 'warn' && /code-anchor:/.test(v.msg));
  assert.equal(warns.length, 1, JSON.stringify(all));
  assert.match(warns[0].msg, /^code-anchor: \.apex\/_INDEX\.md cites missing path: docs\/missing-guide\.md$/);
});

test('code-anchor: citations resolving via each root individually stay silent', () => {
  // Repo root only: docs/guide.md exists at the hub root, nowhere else.
  const byRepoRoot = mkdtempSync(join(tmpdir(), 'steepy-anchor-repo-root-'));
  mkdirSync(join(byRepoRoot, '.apex'), { recursive: true });
  mkdirSync(join(byRepoRoot, 'docs'), { recursive: true });
  writeFileSync(join(byRepoRoot, 'docs', 'guide.md'), '# Guide\n');
  writeFileSync(join(byRepoRoot, '.apex', '_INDEX.md'), '# Index\n\nSee `docs/guide.md`.\n');

  // Citing doc's own directory only: .apex/notes/n.md cites peer/guide.md,
  // which exists only under .apex/notes/.
  const byDocDir = mkdtempSync(join(tmpdir(), 'steepy-anchor-doc-dir-'));
  mkdirSync(join(byDocDir, '.apex', 'notes', 'peer'), { recursive: true });
  writeFileSync(join(byDocDir, '.apex', '_INDEX.md'), '# Index\n- [Notes](notes/n.md)\n');
  writeFileSync(join(byDocDir, '.apex', 'notes', 'n.md'), '# Notes\n\nSee `peer/guide.md`.\n');
  writeFileSync(join(byDocDir, '.apex', 'notes', 'peer', 'guide.md'), '# Guide\n');

  // .apex root only: .apex/notes/n.md cites standards/web.md, which exists
  // only under .apex/ — neither the repo root nor .apex/notes/ has it.
  const byApexRoot = mkdtempSync(join(tmpdir(), 'steepy-anchor-apex-root-'));
  mkdirSync(join(byApexRoot, '.apex', 'standards'), { recursive: true });
  mkdirSync(join(byApexRoot, '.apex', 'notes'), { recursive: true });
  writeFileSync(join(byApexRoot, '.apex', '_INDEX.md'), '# Index\n- [Web](standards/web.md)\n- [Notes](notes/n.md)\n');
  writeFileSync(join(byApexRoot, '.apex', 'notes', 'n.md'), '# Notes\n\nSee `standards/web.md`.\n');
  writeFileSync(join(byApexRoot, '.apex', 'standards', 'web.md'), '# web\n');

  for (const [label, hub] of [['repo root', byRepoRoot], ['doc dir', byDocDir], ['.apex root', byApexRoot]]) {
    const v = collectViolations(hub).filter((x) => /code-anchor:/.test(x.msg));
    assert.deepEqual(v, [], `${label}: ${JSON.stringify(v)}`);
  }
});

test('code-anchor: glob, placeholder, template, whitespace, ellipsis, URL, flag, absolute, and backslash tokens are never reported', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-anchor-shapes-'));
  mkdirSync(join(hub, '.apex'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), [
    '# Index',
    '',
    '- `standards/**/*.md` glob',
    '- `tests/fixtures/<name>/` placeholder',
    '- `{{hub}}/standards/web.md` template',
    '- `node scripts/validate-hub.mjs .` command',
    '- `docs/…/guide.md` ellipsis',
    '- `https://example.com/docs/guide.md` url',
    '- `--config/settings.yml` flag',
    '- `/usr/local/share/proj.conf` absolute',
    '- `lib\\internal\\util.mjs` backslash',
  ].join('\n'));

  const v = collectViolations(hub).filter((x) => /code-anchor:/.test(x.msg));
  assert.deepEqual(v, [], JSON.stringify(v));
});

test('code-anchor: dead citations in root AGENTS.md, root CLAUDE.md, and .claude/agents/*.md warn', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-anchor-locations-'));
  mkdirSync(join(hub, '.apex'), { recursive: true });
  mkdirSync(join(hub, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n');
  writeFileSync(join(hub, 'AGENTS.md'), '# proj\n\nRead `docs/gone.md` first.\n');
  writeFileSync(join(hub, 'CLAUDE.md'), '# proj\n\nSee `docs/also-gone.md`.\n');
  writeFileSync(join(hub, '.claude', 'agents', 'web-agent.md'), '# web-agent\n\nCites `tools/missing.sh`.\n');

  const msgs = collectViolations(hub)
    .filter((v) => v.level === 'warn' && /code-anchor:/.test(v.msg))
    .map((v) => v.msg);
  assert.deepEqual(msgs.sort(), [
    'code-anchor: AGENTS.md cites missing path: docs/gone.md',
    'code-anchor: CLAUDE.md cites missing path: docs/also-gone.md',
    'code-anchor: .claude/agents/web-agent.md cites missing path: tools/missing.sh',
  ].sort(), JSON.stringify(msgs));
});

test('code-anchor: a warn-only hub exits 0, prints the warn, and stays silent under --quiet', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-anchor-exit-'));
  mkdirSync(join(hub, '.apex'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n\nSee `docs/gone.md`.\n');

  const all = collectViolations(hub);
  assert.equal(all.filter((v) => v.level === 'error').length, 0, JSON.stringify(all));
  assert.equal(all.filter((v) => v.level === 'warn' && /code-anchor:/.test(v.msg)).length, 1);

  const loud = captureMain([hub]);
  assert.equal(loud.code, 0);
  assert.match(loud.out, /OK — doc graph is coherent/);
  assert.match(loud.err, /code-anchor: \.apex\/_INDEX\.md cites missing path: docs\/gone\.md/);

  assert.deepEqual(captureMain(['--quiet', hub]), { code: 0, out: '', err: '' });
});

test('code-anchor: a single-file standard whose owning header cites a missing directory errors', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-owner-dir-missing-'));
  mkdirSync(join(hub, '.apex', 'standards'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n- [Web](standards/web.md)\n');
  writeFileSync(join(hub, '.apex', 'standards', 'web.md'), [
    '# web — Technical Standard',
    '',
    '> Owning surface: `apps/ghost`. Read this before editing `apps/ghost`.',
    '',
    '## Scope',
    '- Owns: web.',
    '',
  ].join('\n'));

  const all = collectViolations(hub);
  const v = all.filter((x) => /owning-surface directory does not exist/.test(x.msg));
  assert.equal(v.length, 1, JSON.stringify(all));
  assert.equal(v[0].level, 'error');
  assert.match(
    v[0].msg,
    /^code-anchor: \.apex\/standards\/web\.md owning-surface directory does not exist: apps\/ghost$/,
  );
  // Error level is exit-affecting: exits stay 0/1, never 2.
  assert.equal(captureMain([hub]).code, 1);
});

test('code-anchor: an owning header citing an existing file (not a directory) errors', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-owner-dir-file-'));
  mkdirSync(join(hub, '.apex', 'standards'), { recursive: true });
  writeFileSync(join(hub, 'apps-web.txt'), 'a file, not a directory\n');
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n- [Web](standards/web.md)\n');
  writeFileSync(join(hub, '.apex', 'standards', 'web.md'), '# web\n\n> Owning surface: `apps-web.txt`.\n');

  const v = collectViolations(hub).filter((x) => /owning-surface directory does not exist/.test(x.msg));
  assert.equal(v.length, 1, JSON.stringify(v));
  assert.match(v[0].msg, /owning-surface directory does not exist: apps-web\.txt$/);
});

test('code-anchor: owning headers citing an existing directory, absent headers, and nonconforming headers stay silent', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-owner-dir-silent-'));
  mkdirSync(join(hub, '.apex', 'standards'), { recursive: true });
  mkdirSync(join(hub, 'apps', 'web'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), [
    '# Index',
    '- [Web](standards/web.md)',
    '- [Api](standards/api.md)',
    '- [Ops](standards/ops.md)',
    '- [Abs](standards/abs.md)',
    '- [Esc](standards/esc.md)',
    '',
  ].join('\n'));
  // Conforming header citing an existing directory — silent.
  writeFileSync(join(hub, '.apex', 'standards', 'web.md'), '# web\n\n> Owning surface: `apps/web`. Read this before editing `apps/web`.\n');
  // Absent header — skip-if-absent, never a violation.
  writeFileSync(join(hub, '.apex', 'standards', 'api.md'), '# api\n\nNo owning header at all.\n');
  // Nonconforming header shapes — no backticked value / wrong label.
  writeFileSync(join(hub, '.apex', 'standards', 'ops.md'), '# ops\n\n> Owning surface: apps/web (no backticks).\n');
  // Absolute value — nonconforming, silent skip.
  writeFileSync(join(hub, '.apex', 'standards', 'abs.md'), '# abs\n\n> Owning surface: `/usr/local/src`.\n');
  // Value escaping the repo root — nonconforming, silent skip.
  writeFileSync(join(hub, '.apex', 'standards', 'esc.md'), '# esc\n\n> Owning surface: `../outside`.\n');

  const v = collectViolations(hub).filter((x) => /owning-surface directory does not exist/.test(x.msg));
  assert.deepEqual(v, [], JSON.stringify(collectViolations(hub)));
});

test('code-anchor: the Owning path core form is checked identically and modular leaves are not scanned', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-owner-dir-core-'));
  mkdirSync(join(hub, '.apex', 'standards', 'web'), { recursive: true });
  mkdirSync(join(hub, '.apex', 'standards', 'api'), { recursive: true });
  mkdirSync(join(hub, 'services', 'api'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), [
    '# Index',
    '- [Web core](standards/web/web-core.md)',
    '- [Web auth](standards/web/web-auth.md)',
    '- [Api core](standards/api/api-core.md)',
    '',
  ].join('\n'));
  // Core citing a missing directory — error, same message shape as the single-file form.
  writeFileSync(join(hub, '.apex', 'standards', 'web', 'web-core.md'),
    '# web core\n\n> Owning path: `apps/ghost`. Read this before editing `apps/ghost`.\n');
  // Modular leaf (nested, not *-core.md) citing a missing directory — never scanned.
  writeFileSync(join(hub, '.apex', 'standards', 'web', 'web-auth.md'),
    '# web auth\n\n> Owning path: `apps/also-ghost`.\n');
  // Core citing an existing directory — silent.
  writeFileSync(join(hub, '.apex', 'standards', 'api', 'api-core.md'),
    '# api core\n\n> Owning path: `services/api`.\n');

  const all = collectViolations(hub);
  const v = all.filter((x) => /owning-surface directory does not exist/.test(x.msg));
  assert.equal(v.length, 1, JSON.stringify(all));
  assert.match(
    v[0].msg,
    /^code-anchor: \.apex\/standards\/web\/web-core\.md owning-surface directory does not exist: apps\/ghost$/,
  );
  assert.equal(captureMain([hub]).code, 1);
});

test('code-anchor: unrouted top-level standards are selected by shape for checks 10 and 11', () => {
  const hub = codeAnchorStandardHub('unrouted-standard', [
    '# web — Technical Standard',
    '',
    '> Owning surface: `missing/dir`.',
    '',
    '## Testing',
    '',
    '```sh',
    'node --test tests/missing.test.mjs',
    '```',
    '',
  ].join('\n'), {
    // This is an ordinary prose link, not a routing-table row. It keeps the
    // standard reachable while proving routing membership is irrelevant.
    indexText: '# Index\n\n- [Web reference](standards/web.md)\n',
  });

  const errors = collectViolations(hub)
    .filter((item) => item.level === 'error' && /^code-anchor:/u.test(item.msg))
    .map((item) => item.msg)
    .sort();
  assert.deepEqual(errors, [
    'code-anchor: .apex/standards/web.md Testing command cites missing path: tests/missing.test.mjs',
    'code-anchor: .apex/standards/web.md owning-surface directory does not exist: missing/dir',
  ].sort());
});

test('code-anchor: a Testing sh block citing a missing path-shaped file errors', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-testing-path-'));
  mkdirSync(join(hub, '.apex', 'standards'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n- [Web](standards/web.md)\n');
  writeFileSync(join(hub, '.apex', 'standards', 'web.md'), [
    '# web — Technical Standard',
    '',
    '## Testing',
    '',
    '```sh',
    'node --test tests/web.test.mjs',
    '```',
    '',
  ].join('\n'));

  const all = collectViolations(hub);
  const v = all.filter((x) => /Testing command cites missing path/.test(x.msg));
  assert.equal(v.length, 1, JSON.stringify(all));
  assert.equal(v[0].level, 'error');
  assert.match(
    v[0].msg,
    /^code-anchor: \.apex\/standards\/web\.md Testing command cites missing path: tests\/web\.test\.mjs$/,
  );
  assert.equal(captureMain([hub]).code, 1);
});

test("code-anchor: npm test in a Testing block without scripts.test errors", () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-testing-npm-test-'));
  mkdirSync(join(hub, '.apex', 'standards'), { recursive: true });
  writeFileSync(join(hub, 'package.json'), JSON.stringify({ name: 'demo', scripts: { lint: 'eslint .' } }));
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n- [Web](standards/web.md)\n');
  writeFileSync(join(hub, '.apex', 'standards', 'web.md'), [
    '# web — Technical Standard',
    '',
    '## Testing',
    '',
    '```sh',
    'npm test',
    '```',
    '',
  ].join('\n'));

  const all = collectViolations(hub);
  const v = all.filter((x) => /Testing command references missing npm script/.test(x.msg));
  assert.equal(v.length, 1, JSON.stringify(all));
  assert.equal(v[0].level, 'error');
  assert.match(
    v[0].msg,
    /^code-anchor: \.apex\/standards\/web\.md Testing command references missing npm script 'test'$/,
  );
  assert.equal(captureMain([hub]).code, 1);
});

test('code-anchor: npm run naming a missing script errors', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-testing-npm-run-'));
  mkdirSync(join(hub, '.apex', 'standards'), { recursive: true });
  writeFileSync(join(hub, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }));
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n- [Web](standards/web.md)\n');
  writeFileSync(join(hub, '.apex', 'standards', 'web.md'), [
    '# web — Technical Standard',
    '',
    '## Testing',
    '',
    '```sh',
    'npm run lint',
    '```',
    '',
  ].join('\n'));

  const all = collectViolations(hub);
  const v = all.filter((x) => /Testing command references missing npm script/.test(x.msg));
  assert.equal(v.length, 1, JSON.stringify(all));
  assert.match(
    v[0].msg,
    /^code-anchor: \.apex\/standards\/web\.md Testing command references missing npm script 'lint'$/,
  );
  assert.equal(captureMain([hub]).code, 1);
});

test('code-anchor: a hub with no package.json skips the npm half but still errors on dead paths', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-testing-no-pkg-'));
  mkdirSync(join(hub, '.apex', 'standards'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n- [Web](standards/web.md)\n');
  writeFileSync(join(hub, '.apex', 'standards', 'web.md'), [
    '# web — Technical Standard',
    '',
    '## Testing',
    '',
    '```sh',
    'npm test',
    'npm run lint',
    'node --test tests/web.test.mjs',
    '```',
    '',
  ].join('\n'));

  const all = collectViolations(hub);
  const v = all.filter((x) => /Testing command/.test(x.msg));
  assert.equal(v.length, 1, JSON.stringify(all));
  assert.match(v[0].msg, /cites missing path: tests\/web\.test\.mjs$/);
  assert.equal(v.filter((x) => /npm script/.test(x.msg)).length, 0);
  assert.equal(captureMain([hub]).code, 1);
});

test('code-anchor: a heading inside a Testing sh fence does not truncate the section', () => {
  const hub = codeAnchorStandardHub('testing-fenced-heading', [
    '# web — Technical Standard',
    '',
    '## Testing',
    '',
    '```sh',
    '## This heading is command text inside the fence',
    'node --test tests/after-heading.test.mjs',
    '```',
    '',
    '## Conventions',
    '',
  ].join('\n'));

  const errors = collectViolations(hub).filter((item) => /Testing command/u.test(item.msg));
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.equal(errors[0].level, 'error');
  assert.match(errors[0].msg, /cites missing path: tests\/after-heading\.test\.mjs$/u);
});

test('code-anchor: npm word boundaries reject npm tests and mynpm test', () => {
  const hub = codeAnchorStandardHub('testing-npm-word-boundaries', [
    '# web — Technical Standard',
    '',
    '## Testing',
    '',
    '```sh',
    'npm tests',
    'mynpm test',
    '```',
    '',
  ].join('\n'), {
    packageText: JSON.stringify({ scripts: {} }),
  });

  const errors = collectViolations(hub).filter((item) => /Testing command/u.test(item.msg));
  assert.deepEqual(errors, [], JSON.stringify(errors));
});

test('code-anchor: unparseable package.json skips npm checks but still enforces Testing paths', () => {
  const hub = codeAnchorStandardHub('testing-unparseable-package', [
    '# web — Technical Standard',
    '',
    '## Testing',
    '',
    '```sh',
    'npm test',
    'npm run lint',
    'node --test tests/missing.test.mjs',
    '```',
    '',
  ].join('\n'), {
    packageText: '{ this is not JSON',
  });

  const errors = collectViolations(hub).filter((item) => /Testing command/u.test(item.msg));
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0].msg, /cites missing path: tests\/missing\.test\.mjs$/u);
  assert.doesNotMatch(errors[0].msg, /npm script/u);
});

test('code-anchor: parseable package.json with non-object scripts treats npm references as missing', () => {
  const hub = codeAnchorStandardHub('testing-non-object-scripts', [
    '# web — Technical Standard',
    '',
    '## Testing',
    '',
    '```sh',
    'npm test',
    'npm run lint',
    '```',
    '',
  ].join('\n'), {
    packageText: JSON.stringify({ scripts: 'not-an-object' }),
  });

  const errors = collectViolations(hub)
    .filter((item) => /Testing command references missing npm script/u.test(item.msg))
    .map((item) => item.msg)
    .sort();
  assert.deepEqual(errors, [
    "code-anchor: .apex/standards/web.md Testing command references missing npm script 'lint'",
    "code-anchor: .apex/standards/web.md Testing command references missing npm script 'test'",
  ].sort());
});

test('code-anchor: sh blocks outside the Testing section and Testing-less standards stay silent', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-testing-scope-'));
  mkdirSync(join(hub, '.apex', 'standards'), { recursive: true });
  writeFileSync(
    join(hub, '.apex', '_INDEX.md'),
    '# Index\n- [Web](standards/web.md)\n- [Api](standards/api.md)\n',
  );
  // web.md: a dead path and an npm invocation inside ## Conventions (NOT Testing)
  // — check 11 reads only ## Testing sections, so none of this is scanned.
  writeFileSync(join(hub, '.apex', 'standards', 'web.md'), [
    '# web — Technical Standard',
    '',
    '## Conventions',
    '',
    '```sh',
    'node --test tests/ghost.test.mjs',
    'npm test',
    '```',
    '',
  ].join('\n'));
  // api.md: the only Testing block under test — its dead token is the sole error.
  writeFileSync(join(hub, '.apex', 'standards', 'api.md'), [
    '# api — Technical Standard',
    '',
    '## Testing',
    '',
    '```sh',
    'node --test tests/api.test.mjs',
    '```',
    '',
  ].join('\n'));

  const all = collectViolations(hub);
  const v = all.filter((x) => /Testing command/.test(x.msg));
  assert.equal(v.length, 1, JSON.stringify(all));
  assert.match(
    v[0].msg,
    /^code-anchor: \.apex\/standards\/api\.md Testing command cites missing path: tests\/api\.test\.mjs$/,
  );
  assert.equal(v.filter((x) => /web\.md/.test(x.msg)).length, 0);
  assert.equal(captureMain([hub]).code, 1);
});

test('code-anchor: placeholder tokens are never reported and real commands stay green', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-testing-placeholder-'));
  mkdirSync(join(hub, '.apex', 'standards'), { recursive: true });
  mkdirSync(join(hub, 'tests'), { recursive: true });
  writeFileSync(join(hub, 'package.json'), JSON.stringify({ scripts: { test: 'node --test tests/web.test.mjs' } }));
  writeFileSync(join(hub, 'tests', 'web.test.mjs'), "import { test } from 'node:test';\n");
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n- [Web](standards/web.md)\n');
  // Placeholders are shape-rejected; the only real token is dead — exactly one error.
  writeFileSync(join(hub, '.apex', 'standards', 'web.md'), [
    '# web — Technical Standard',
    '',
    '## Testing',
    '',
    '```sh',
    'node --test tests/<suite>.test.mjs',
    'node --test {{pkg}}/tests/web.test.mjs',
    'node --test tests/gone.test.mjs',
    '```',
    '',
  ].join('\n'));

  const all = collectViolations(hub);
  const v = all.filter((x) => /Testing command cites missing path/.test(x.msg));
  assert.equal(v.length, 1, JSON.stringify(all));
  assert.match(v[0].msg, /cites missing path: tests\/gone\.test\.mjs$/);

  // A fully real command (existing scripts, existing path, comments/blanks skipped) stays green.
  const green = mkdtempSync(join(tmpdir(), 'steepy-testing-green-'));
  mkdirSync(join(green, '.apex', 'standards'), { recursive: true });
  mkdirSync(join(green, 'tests'), { recursive: true });
  writeFileSync(
    join(green, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --test tests/web.test.mjs', lint: 'eslint .' } }),
  );
  writeFileSync(join(green, 'tests', 'web.test.mjs'), "import { test } from 'node:test';\n");
  writeFileSync(join(green, '.apex', '_INDEX.md'), '# Index\n- [Web](standards/web.md)\n');
  writeFileSync(join(green, '.apex', 'standards', 'web.md'), [
    '# web — Technical Standard',
    '',
    '## Testing',
    '',
    '```sh',
    '# a comment line, then a blank line below',
    '',
    'npm test',
    'npm run lint',
    'node --test tests/web.test.mjs',
    '```',
    '',
  ].join('\n'));
  const greenAll = collectViolations(green);
  assert.deepEqual(greenAll.filter((x) => x.level === 'error'), [], JSON.stringify(greenAll));
  assert.equal(captureMain([green]).code, 0);
});

test('code-anchor: the modular core form is scanned and a token dead in two sh blocks errors once', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-testing-core-'));
  mkdirSync(join(hub, '.apex', 'standards', 'web'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n- [Web core](standards/web/web-core.md)\n');
  writeFileSync(join(hub, '.apex', 'standards', 'web', 'web-core.md'), [
    '# web core',
    '',
    '## Testing',
    '',
    '```sh',
    'node --test tests/web.test.mjs',
    '```',
    '',
    'Also from the fixture suite:',
    '',
    '```sh',
    'node --test tests/web.test.mjs',
    '```',
    '',
  ].join('\n'));

  const all = collectViolations(hub);
  const v = all.filter((x) => /Testing command cites missing path/.test(x.msg));
  assert.equal(v.length, 1, JSON.stringify(all));
  assert.match(
    v[0].msg,
    /^code-anchor: \.apex\/standards\/web\/web-core\.md Testing command cites missing path: tests\/web\.test\.mjs$/,
  );
  assert.equal(captureMain([hub]).code, 1);
});

test('routing-table standards links into .apex/work are rejected', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-routing-work-link-'));
  mkdirSync(join(hub, '.apex', 'work', 'standards'), { recursive: true });
  mkdirSync(join(hub, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(hub, '.apex', 'work', 'standards', 'draft.md'), '# Draft\n');
  writeFileSync(join(hub, '.claude', 'agents', 'web-agent.md'), '# web-agent\n');
  writeFileSync(join(hub, '.apex', '_INDEX.md'), [
    '# Index',
    '',
    '| Surface | Docs | Agent | Skill |',
    '|---|---|---|---|',
    '| `web` | [Draft](work/standards/draft.md) | `web-agent` | — |',
  ].join('\n'));

  const v = collectViolations(hub).filter((x) => x.msg.includes('.apex/work'));
  assert.equal(v.length, 1, JSON.stringify(v));
  assert.match(v[0].msg, /stable docs must not link into \.apex\/work/);
  assert.equal(v[0].level, 'error');
});

test('standards and unmarked-agent FIFOs are rejected without blocking', {
  skip: !['darwin', 'linux'].includes(process.platform),
}, () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-stable-fifos-'));
  mkdirSync(join(hub, '.apex', 'standards'), { recursive: true });
  mkdirSync(join(hub, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), [
    '# Index',
    '- [Web](standards/web.md)',
    '',
    '| Surface | Docs | Agent | Skill |',
    '|---|---|---|---|',
    '| `web` | [standards/web.md](standards/web.md) | `web-agent` | — |',
    '',
  ].join('\n'));
  makeFifo(join(hub, '.apex', 'standards', 'web.md'));
  makeFifo(join(hub, '.claude', 'agents', 'web-agent.md'));

  const result = runValidator(hub);
  assert.notEqual(result.error?.code, 'ETIMEDOUT');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /stable-read: \.apex\/standards\/web\.md is non-file/i);
  assert.match(result.stderr, /stable-read: \.claude\/agents\/web-agent\.md is non-file/i);
});

test('unmarked reverse routing requires canonical top-level agent identity and diagnoses nested namesakes', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-unmarked-agent-namesake-'));
  mkdirSync(join(hub, '.apex', 'standards'), { recursive: true });
  mkdirSync(join(hub, '.claude', 'agents', 'nested'), { recursive: true });
  writeFileSync(join(hub, '.apex', 'standards', 'web.md'), '# web\n');
  writeFileSync(join(hub, '.claude', 'agents', 'nested', 'web-agent.md'), '# web-agent\n');
  writeFileSync(join(hub, '.apex', '_INDEX.md'), [
    '# Index',
    '- [Web](standards/web.md)',
    '',
    '| Surface | Docs | Agent | Skill |',
    '|---|---|---|---|',
    '| `web` | [standards/web.md](standards/web.md) | `web-agent` | — |',
    '',
  ].join('\n'));

  const messages = collectViolations(hub).map((item) => item.msg).join('\n');
  assert.match(
    messages,
    /routing: agent 'web-agent' must use canonical top-level path \.claude\/agents\/web-agent\.md; found nested namesake at \.claude\/agents\/nested\/web-agent\.md/i,
  );
});

test('an oversized portable candidate is a controlled error, never absent provenance', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-portable-oversized-candidate-'));
  mkdirSync(join(hub, '.apex'));
  mkdirSync(join(hub, '.agents', 'skills', 'demo'), { recursive: true });
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# Index\n');
  const secret = 'REFUSED_GENERATED_MARKER_MUST_NOT_LEAK';
  writeFileSync(
    join(hub, '.agents', 'skills', 'demo', 'SKILL.md'),
    `<!-- steepy:generated:${secret}:v1 -->\n${'x'.repeat(1024 * 1024)}`,
  );

  const result = runValidator(hub);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /stable-read: \.agents\/skills\/demo\/SKILL\.md exceeds 1048576 bytes/i);
  assert.doesNotMatch(result.stderr, new RegExp(secret));
});

test('permission-denied portable candidates and nested namespaces return controlled errors', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, () => {
  const candidateHub = mkdtempSync(join(tmpdir(), 'steepy-portable-unreadable-candidate-'));
  mkdirSync(join(candidateHub, '.apex'));
  mkdirSync(join(candidateHub, '.codex'));
  writeFileSync(join(candidateHub, '.apex', '_INDEX.md'), '# Index\n');
  const candidate = join(candidateHub, '.codex', 'relocated.toml');
  writeFileSync(candidate, '# steepy:generated:REFUSED_PERMISSION_MARKER:v1\n');
  chmodSync(candidate, 0o000);
  try {
    let candidateViolations;
    assert.doesNotThrow(() => { candidateViolations = collectViolations(candidateHub); });
    assert.match(
      candidateViolations.map((item) => item.msg).join('\n'),
      /stable-read: \.codex\/relocated\.toml could not be opened safely/i,
    );
    const cli = runValidator(candidateHub);
    assert.equal(cli.status, 1, cli.stderr);
    assert.doesNotMatch(cli.stderr, /REFUSED_PERMISSION_MARKER|at .*validate-hub\.mjs/i);
  } finally {
    chmodSync(candidate, 0o600);
  }

  const namespaceHub = mkdtempSync(join(tmpdir(), 'steepy-portable-unreadable-namespace-'));
  mkdirSync(join(namespaceHub, '.apex'));
  mkdirSync(join(namespaceHub, '.opencode', 'nested'), { recursive: true });
  writeFileSync(join(namespaceHub, '.apex', '_INDEX.md'), '# Index\n');
  const nested = join(namespaceHub, '.opencode', 'nested');
  chmodSync(nested, 0o000);
  try {
    let namespaceViolations;
    assert.doesNotThrow(() => { namespaceViolations = collectViolations(namespaceHub); });
    assert.match(
      namespaceViolations.map((item) => item.msg).join('\n'),
      /stable-read: \.opencode\/nested is unreadable/i,
    );
    const cli = runValidator(namespaceHub);
    assert.equal(cli.status, 1, cli.stderr);
    assert.doesNotMatch(cli.stderr, /at .*validate-hub\.mjs/i);
  } finally {
    chmodSync(nested, 0o700);
  }
});

test('terminal slash and dot require a directory without rejecting actual directories', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-terminal-directory-semantics-'));
  mkdirSync(join(hub, '.apex'));
  mkdirSync(join(hub, 'ordinary-dir'));
  writeFileSync(join(hub, 'ordinary.txt'), 'ordinary file\n');
  writeFileSync(join(hub, '.apex', '_INDEX.md'), [
    '# Index',
    '- [file slash](../ordinary.txt/)',
    '- [file dot](../ordinary.txt/.)',
    '- [directory slash](../ordinary-dir/)',
    '- [directory dot](../ordinary-dir/.)',
    '',
  ].join('\n'));

  const physicalErrors = collectViolations(hub).filter((item) => item.msg.startsWith('stable-read:'));
  assert.equal(physicalErrors.length, 2, JSON.stringify(physicalErrors));
  assert.match(physicalErrors[0].msg, /\.apex\/\.\.\/ordinary\.txt\/.*non-directory component/i);
  assert.match(physicalErrors[1].msg, /\.apex\/\.\.\/ordinary\.txt\/\..*non-directory component/i);
  assert.ok(physicalErrors.every((item) => !item.msg.includes('ordinary-dir')));
});

test('portable provenance discovers unconventional ordinary filenames in every provider namespace', () => {
  const cases = [
    ['agents', '.agents/skills/demo/RENAMED.md'],
    ['claude', '.claude/agents/renamed.txt'],
    ['codex', '.codex/nested/renamed.txt'],
    ['opencode', '.opencode/agents/renamed'],
  ];
  for (const [artifact, path] of cases) {
    const hub = mkdtempSync(join(tmpdir(), `steepy-portable-unconventional-${artifact}-`));
    putPortable(hub, '.apex/_INDEX.md', '# Index\n');
    putPortable(hub, path, `<!-- steepy:generated:orphan-${artifact}:v1 -->\n`);

    const messages = portableErrors(hub).map(({ msg }) => msg).join('\n');
    assert.match(messages, new RegExp(`portable-v1:.*orphan-${artifact}.*${path.replaceAll('.', '\\.')}`), path);
    assert.equal(runValidator(hub).status, 1, path);
  }
});

test('portable provenance excludes only exact node_modules directory subtrees', () => {
  const excluded = mkdtempSync(join(tmpdir(), 'steepy-portable-excluded-node-modules-'));
  putPortable(excluded, '.apex/_INDEX.md', '# Index\n');
  for (const provider of ['.agents', '.claude', '.codex', '.opencode']) {
    putPortable(
      excluded,
      `${provider}/node_modules/nested/renamed.any`,
      `<!-- steepy:generated:excluded-${provider.slice(1)}:v1 -->\n`,
    );
  }
  assert.deepEqual(collectViolations(excluded), []);
  assert.equal(runValidator(excluded).status, 0);

  for (const [artifact, path] of [
    ['dash', '.agents/node_modules-copy/renamed.any'],
    ['suffix', '.claude/node_modulesx/renamed.any'],
    ['singular', '.codex/node_module/renamed.any'],
    ['case', '.opencode/Node_Modules/renamed.any'],
    ['file', '.codex/node_modules'],
  ]) {
    const hub = mkdtempSync(join(tmpdir(), `steepy-portable-node-modules-near-${artifact}-`));
    putPortable(hub, '.apex/_INDEX.md', '# Index\n');
    putPortable(hub, path, `<!-- steepy:generated:near-${artifact}:v1 -->\n`);
    const messages = portableErrors(hub).map(({ msg }) => msg).join('\n');
    assert.match(messages, new RegExp(`portable-v1:.*near-${artifact}.*${path.replaceAll('.', '\\.')}`), path);
    assert.equal(runValidator(hub).status, 1, path);
  }
});

test('unmarked presence, agent routing, and skill scans exclude node_modules at every depth', () => {
  const cases = [
    [
      'agent-unmarked',
      '.claude/agents/node_modules/pkg/agent.md',
      '# dependency agent\n',
    ],
    [
      'agent-generated-deep',
      '.claude/agents/team/node_modules/pkg/generated.md',
      '<!-- steepy:generated:excluded-agent:v1 -->\n',
    ],
    [
      'skill-unmarked',
      '.claude/skills/demo/node_modules/pkg/SKILL.md',
      '# Dependency\n[standard](standards/DEPENDENCY_SENTINEL.md)\n',
    ],
    [
      'skill-generated-deep',
      '.claude/skills/demo/nested/node_modules/pkg/SKILL.md',
      '<!-- steepy:generated:excluded-skill:v1 -->\n[standard](standards/GENERATED_SENTINEL.md)\n',
    ],
  ];

  for (const [name, path, content] of cases) {
    const hub = mkdtempSync(join(tmpdir(), `steepy-unmarked-node-modules-${name}-`));
    putPortable(hub, '.apex/_INDEX.md', '# Index\n');
    putPortable(hub, path, content);

    assert.deepEqual(collectViolations(hub), [], path);
    const quiet = captureMain(['--quiet', hub]);
    assert.equal(quiet.code, 0, `${path}: ${quiet.err}`);
    assert.equal(quiet.err, '', path);
    assert.doesNotMatch(quiet.out, /DEPENDENCY_SENTINEL|GENERATED_SENTINEL/u, path);
  }
});

test('oversized files and descendant symlinks inside excluded node_modules are never visited', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-unmarked-node-modules-unvisited-'));
  const external = mkdtempSync(join(tmpdir(), 'steepy-unmarked-node-modules-external-'));
  putPortable(hub, '.apex/_INDEX.md', '# Index\n');
  putPortable(
    hub,
    '.claude/agents/team/node_modules/pkg/generated.md',
    `<!-- steepy:generated:OVERSIZED_DEPENDENCY_SENTINEL:v1 -->\n${'x'.repeat(1024 * 1024)}`,
  );
  const linkedSkill = join(hub, '.claude', 'skills', 'demo', 'node_modules', 'pkg', 'SKILL.md');
  mkdirSync(dirname(linkedSkill), { recursive: true });
  putPortable(external, 'skill.md', '# Dependency\n[standard](standards/LINK_TARGET_SENTINEL.md)\n');
  symlinkSync(join(external, 'skill.md'), linkedSkill);

  let violations;
  assert.doesNotThrow(() => { violations = collectViolations(hub); });
  assert.deepEqual(violations, []);
  const quiet = captureMain(['--quiet', hub]);
  assert.equal(quiet.code, 0, quiet.err);
  assert.equal(quiet.err, '');
  assert.doesNotMatch(
    `${quiet.out}\n${quiet.err}`,
    /OVERSIZED_DEPENDENCY_SENTINEL|LINK_TARGET_SENTINEL/u,
  );
});

test('unreadable ordinary descendants inside excluded node_modules are never visited', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-unmarked-node-modules-unreadable-'));
  putPortable(hub, '.apex/_INDEX.md', '# Index\n');
  const unreadable = join(hub, '.claude', 'agents', 'deep', 'node_modules', 'pkg', 'unreadable.md');
  putPortable(hub, '.claude/agents/deep/node_modules/pkg/unreadable.md', '# dependency agent\n');
  chmodSync(unreadable, 0o000);
  try {
    let violations;
    assert.doesNotThrow(() => { violations = collectViolations(hub); });
    assert.deepEqual(violations, []);
    const quiet = captureMain(['--quiet', hub]);
    assert.equal(quiet.code, 0, quiet.err);
    assert.equal(quiet.err, '');
  } finally {
    chmodSync(unreadable, 0o600);
  }
});

test('a symlink named node_modules is refused without traversing its synthetic target', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-portable-node-modules-link-'));
  const external = mkdtempSync(join(tmpdir(), 'steepy-portable-node-modules-link-target-'));
  putPortable(hub, '.apex/_INDEX.md', '# Index\n');
  mkdirSync(join(hub, '.codex'));
  const secret = 'NODE_MODULES_LINK_TARGET_MUST_NOT_BE_READ';
  putPortable(external, 'nested/renamed.any', `<!-- steepy:generated:${secret}:v1 -->\n`);
  symlinkSync(external, join(hub, '.codex', 'node_modules'), 'dir');

  const result = runValidator(hub);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /stable-read: \.codex\/node_modules is symlink/i);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret));
});

test('a node_modules symlink at an unmarked scan boundary remains a controlled refusal', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-unmarked-node-modules-boundary-link-'));
  const external = mkdtempSync(join(tmpdir(), 'steepy-unmarked-node-modules-boundary-target-'));
  putPortable(hub, '.apex/_INDEX.md', '# Index\n');
  mkdirSync(join(hub, '.claude', 'agents'), { recursive: true });
  const secret = 'DEPENDENCY_BOUNDARY_TARGET_MUST_NOT_BE_READ';
  putPortable(external, 'pkg/agent.md', `# ${secret}\n`);
  symlinkSync(external, join(hub, '.claude', 'agents', 'node_modules'), 'dir');

  const result = runValidator(hub);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /stable-read: \.claude\/agents\/node_modules is symlink/i);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret));
});

test('renamed nested copies remain duplicate and wrong-target provenance beside a canonical set', () => {
  const hub = portableHub();
  const copies = [
    ['.agents/skills/portable-demo-bootstrap/SKILL.md', '.agents/nested/bootstrap.copy', 'portable-demo-bootstrap'],
    ['.claude/agents/web-agent.md', '.claude/nested/web-agent.copy', 'web-agent-claude'],
    ['.codex/agents/web-agent.toml', '.codex/nested/web-agent.copy', 'web-agent-codex'],
    ['.opencode/agents/web-agent.md', '.opencode/nested/web-agent.copy', 'web-agent-opencode'],
  ];
  for (const [canonical, relocated] of copies) {
    putPortable(hub, relocated, readFileSync(join(hub, canonical), 'utf8'));
  }

  const messages = portableErrors(hub).map(({ msg }) => msg).join('\n');
  for (const [, relocated, artifactId] of copies) {
    assert.match(messages, new RegExp(`portable-v1:.*${artifactId}.*duplicate provenance`), artifactId);
    assert.match(
      messages,
      new RegExp(`portable-v1:.*${artifactId}.*wrong target.*${relocated.replaceAll('.', '\\.')}`),
      relocated,
    );
  }
  assert.equal(runValidator(hub).status, 1);
});

test('refused package metadata is a controlled error, distinct from absent or malformed JSON', {
  skip: !['darwin', 'linux'].includes(process.platform),
}, () => {
  const standard = [
    '# web — Technical Standard',
    '',
    '## Testing',
    '',
    '```sh',
    'npm test',
    '```',
    '',
  ].join('\n');

  const linked = codeAnchorStandardHub('package-link', standard);
  mkdirSync(join(linked, '.apex', 'work'), { recursive: true });
  const secret = 'PACKAGE_WORK_SENTINEL_MUST_NOT_LEAK';
  writeFileSync(join(linked, '.apex', 'work', 'sentinel.json'), JSON.stringify({ secret }));
  symlinkSync(join(linked, '.apex', 'work', 'sentinel.json'), join(linked, 'package.json'));
  const linkedResult = runValidator(linked);
  assert.equal(linkedResult.status, 1, linkedResult.stderr);
  assert.match(linkedResult.stderr, /stable-read: package\.json is symlink/i);
  assert.doesNotMatch(`${linkedResult.stdout}\n${linkedResult.stderr}`, new RegExp(secret));

  const oversized = codeAnchorStandardHub('package-oversized', standard, {
    packageText: JSON.stringify({ scripts: { test: 'node --test' }, padding: 'x'.repeat(1024 * 1024) }),
  });
  const oversizedResult = runValidator(oversized);
  assert.equal(oversizedResult.status, 1, oversizedResult.stderr);
  assert.match(oversizedResult.stderr, /stable-read: package\.json exceeds 1048576 bytes/i);

  const fifoHub = codeAnchorStandardHub('package-fifo', standard);
  makeFifo(join(fifoHub, 'package.json'));
  const fifoResult = runValidator(fifoHub);
  assert.notEqual(fifoResult.error?.code, 'ETIMEDOUT');
  assert.equal(fifoResult.status, 1, fifoResult.stderr);
  assert.match(fifoResult.stderr, /stable-read: package\.json is non-file/i);

  const absent = codeAnchorStandardHub('package-absent', standard);
  assert.equal(collectViolations(absent).some(({ msg }) => /package\.json/u.test(msg)), false);
  const malformed = codeAnchorStandardHub('package-malformed-safe', standard, {
    packageText: '{ safely read but malformed JSON',
  });
  assert.equal(collectViolations(malformed).some(({ msg }) => /package\.json/u.test(msg)), false);
});

test('permission-denied package metadata returns controlled violations without throwing', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, () => {
  const hub = codeAnchorStandardHub('package-unreadable', [
    '# web — Technical Standard',
    '',
    '## Testing',
    '',
    '```sh',
    'npm test',
    '```',
    '',
  ].join('\n'), {
    packageText: JSON.stringify({ scripts: { test: 'node --test' } }),
  });
  const manifest = join(hub, 'package.json');
  chmodSync(manifest, 0o000);
  try {
    let violations;
    assert.doesNotThrow(() => { violations = collectViolations(hub); });
    assert.match(
      violations.map(({ msg }) => msg).join('\n'),
      /stable-read: package\.json could not be opened safely/i,
    );
    const cli = runValidator(hub);
    assert.equal(cli.status, 1, cli.stderr);
    assert.doesNotMatch(cli.stderr, /at .*validate-hub\.mjs/i);
  } finally {
    chmodSync(manifest, 0o600);
  }
});

// ---------------------------------------------------------------------------
// Pre-hub inception state (spec §8 state matrix) and local-area exclusion.
// ---------------------------------------------------------------------------

const RUN = '0b6f1b8e-3c1a-4e2b-9f3d-5a7c9e1b2d4f';
const PROPOSAL = `.apex/inception/${RUN}/proposal.md`;
const LOCAL_SENTINEL = 'LOCAL_AREA_BODY_SENTINEL';
const APPROVAL = Object.freeze({ path: PROPOSAL, sha256: 'a'.repeat(64) });

function withTempRepo(suffix, fn) {
  const repo = mkdtempSync(join(tmpdir(), `steepy-prehub-${suffix}-`));
  try {
    return fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function descriptorBytes(overrides = {}) {
  return serializeInceptionState({ ...createInitialInceptionState(RUN), ...overrides });
}

// A guarded descriptor plus local run and work documents whose bodies must
// never be read by the linter.
function seedInception(repo, overrides = {}) {
  putPortable(repo, '.apex/inception/.gitignore', '*\n');
  putPortable(repo, PROPOSAL, `# ${LOCAL_SENTINEL}\n- [Leaf](../../leaf.md)\n`);
  putPortable(repo, '.apex/work/specs/draft.md', `# ${LOCAL_SENTINEL}\n[Broken](missing.md)\n`);
  putPortable(repo, '.apex/inception/state.json', descriptorBytes(overrides));
}

const initDescriptor = (status) => ({
  phase: 'init',
  approval: APPROVAL,
  init: { status, handoff: null, receipt: null },
});

function recordFsAccess(fn) {
  const names = ['openSync', 'readFileSync', 'readdirSync', 'opendirSync'];
  const originals = Object.fromEntries(names.map((name) => [name, fs[name]]));
  const accesses = [];
  try {
    for (const name of names) {
      fs[name] = function recorded(...args) {
        accesses.push({ name, path: String(args[0]) });
        return originals[name].apply(this, args);
      };
    }
    syncBuiltinESMExports();
    return { result: fn(), accesses };
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
}

function under(path, directory) {
  const candidate = path.toLowerCase();
  const prefix = directory.toLowerCase();
  return candidate === prefix || candidate.startsWith(`${prefix}${sep}`);
}

// Zero body reads and zero enumeration inside either local area; only the
// canonical descriptor and its guard may be opened, and only when allowed.
function assertNoLocalBodyAccess(repo, accesses, { descriptor = false } = {}) {
  const physical = realpathSync.native(repo);
  const areas = ['inception', 'work'].flatMap((name) => [join(repo, '.apex', name), join(physical, '.apex', name)]);
  const allowed = new Set(descriptor
    ? ['state.json', '.gitignore'].map((file) => join(physical, '.apex', 'inception', file).toLowerCase())
    : []);
  const offending = accesses.filter(({ name, path }) => areas.some((area) => under(path, area))
    && !(name === 'openSync' && allowed.has(path.toLowerCase())));
  assert.deepEqual(offending, []);
}

function errorMessages(violations) {
  return violations.filter(({ level }) => level === 'error').map(({ msg }) => msg).join('\n');
}

test('pre-hub matrix: a valid pre-init descriptor without hub artifacts is recognized, never called coherent', () => {
  for (const overrides of [{}, { phase: 'bootstrap', status: 'blocked', approval: APPROVAL }]) {
    withTempRepo('valid', (repo) => {
      seedInception(repo, overrides);
      putPortable(repo, 'AGENTS.md', '# My app\n\nPlain user notes without provenance.\n');
      putPortable(repo, 'CLAUDE.md', '# Claude notes\n\nSee [agents](AGENTS.md).\n');
      putPortable(repo, '.claude/settings.json', '{"permissions":{}}\n');
      putPortable(repo, '.claude/agents/helper.md', '# A user agent\n');
      writeFileSync(join(repo, '.apex', '.DS_Store'), Buffer.from([0, 1, 2]));

      const { result, accesses } = recordFsAccess(() => classifyHub(repo));
      assert.equal(result.state, 'pre-hub', JSON.stringify(result));
      assert.deepEqual(result.violations, []);
      assert.deepEqual(collectViolations(repo), []);
      assertNoLocalBodyAccess(repo, accesses, { descriptor: true });

      const loud = captureMain([repo]);
      assert.equal(loud.code, 0, loud.err);
      assert.match(loud.out, /pre-hub/i);
      assert.match(loud.out, new RegExp(RUN, 'u'));
      assert.doesNotMatch(loud.out, /coherent/i);
      assert.doesNotMatch(loud.out, /no \.apex hub found/i);
      assert.doesNotMatch(`${loud.out}\n${loud.err}`, new RegExp(LOCAL_SENTINEL, 'u'));

      const quiet = captureMain(['--quiet', repo]);
      assert.deepEqual(quiet, { code: 0, out: '', err: '' });
    });
  }
});

test('pre-hub matrix: no .apex stays uninitialized and a coherent hub stays coherent', () => {
  withTempRepo('none', (repo) => {
    assert.deepEqual({ ...classifyHub(repo) }, { state: 'no-hub', violations: [] });
  });
  const hub = portableHub();
  try {
    const classified = classifyHub(hub);
    assert.equal(classified.state, 'hub');
    assert.deepEqual(classified.violations.filter(({ level }) => level === 'error'), []);
  } finally {
    rmSync(hub, { recursive: true, force: true });
  }
});

test('pre-hub matrix: .apex without an index and without a valid inception keeps the missing-index error', {
  skip: process.platform === 'win32',
}, () => {
  const cases = [
    ['area directory only', (repo) => mkdirSync(join(repo, '.apex', 'inception'), { recursive: true }), /incomplete/],
    ['guard without descriptor', (repo) => putPortable(repo, '.apex/inception/.gitignore', '*\n'), /incomplete/],
    ['descriptor without guard', (repo) => {
      seedInception(repo);
      rmSync(join(repo, '.apex', 'inception', '.gitignore'));
    }, /guard/],
    ['foreign guard', (repo) => {
      seedInception(repo);
      writeFileSync(join(repo, '.apex', 'inception', '.gitignore'), '*\n!state.json\n');
    }, /guard/],
    ['malformed descriptor', (repo) => {
      seedInception(repo);
      writeFileSync(join(repo, '.apex', 'inception', 'state.json'), `{"${LOCAL_SENTINEL}":`);
    }, /JSON/],
    ['unknown descriptor version', (repo) => {
      seedInception(repo);
      writeFileSync(join(repo, '.apex', 'inception', 'state.json'),
        `${JSON.stringify({ ...createInitialInceptionState(RUN), schemaVersion: 2 }, null, 2)}\n`);
    }, /schemaVersion/],
    ['noncanonical descriptor bytes', (repo) => {
      seedInception(repo);
      writeFileSync(join(repo, '.apex', 'inception', 'state.json'), JSON.stringify(createInitialInceptionState(RUN)));
    }, /canonical/],
    ['symlinked descriptor', (repo) => {
      seedInception(repo);
      renameSync(join(repo, '.apex', 'inception', 'state.json'), join(repo, 'state.json'));
      symlinkSync(join(repo, 'state.json'), join(repo, '.apex', 'inception', 'state.json'));
    }, /symlink/],
    ['hard-linked descriptor', (repo) => {
      seedInception(repo);
      linkSync(join(repo, '.apex', 'inception', 'state.json'), join(repo, 'state-copy.json'));
    }, /hard-linked/],
    ['symlinked area', (repo) => {
      const external = join(repo, 'external-inception');
      putPortable(repo, 'external-inception/.gitignore', '*\n');
      putPortable(repo, 'external-inception/state.json', descriptorBytes());
      mkdirSync(join(repo, '.apex'), { recursive: true });
      symlinkSync(external, join(repo, '.apex', 'inception'), 'dir');
    }, /symlink/],
    ['unreadable descriptor', (repo) => {
      seedInception(repo);
      if (process.getuid?.() !== 0) chmodSync(join(repo, '.apex', 'inception', 'state.json'), 0o000);
    }, /inception/],
  ];
  for (const [label, mutate, reason] of cases) {
    withTempRepo('invalid', (repo) => {
      mutate(repo);
      try {
        const { result, accesses } = recordFsAccess(() => classifyHub(repo));
        assert.equal(result.state, 'invalid', label);
        const messages = errorMessages(result.violations);
        assert.match(messages, /missing _INDEX\.md/u, label);
        assert.match(messages, /inception: pre-hub state not recognized \((incomplete|invalid)\)/u, label);
        assert.match(messages, reason, label);
        assert.doesNotMatch(messages, new RegExp(LOCAL_SENTINEL, 'u'), label);
        assertNoLocalBodyAccess(repo, accesses, { descriptor: true });
        const quiet = captureMain(['--quiet', repo]);
        assert.equal(quiet.code, 1, label);
        assert.match(quiet.err, /missing _INDEX\.md/u, label);
      } finally {
        const state = join(repo, '.apex', 'inception', 'state.json');
        if (existsSync(state)) chmodSync(state, 0o600);
      }
    });
  }
});

test('pre-hub matrix: init in progress or complete without an index is always an error', () => {
  for (const status of ['in-progress', 'complete']) {
    withTempRepo(`init-${status}`, (repo) => {
      seedInception(repo, initDescriptor(status));
      const { result, accesses } = recordFsAccess(() => classifyHub(repo));
      assert.equal(result.state, 'invalid', status);
      const messages = errorMessages(result.violations);
      assert.match(messages, /missing _INDEX\.md/u, status);
      assert.match(messages, new RegExp(`inception: init is ${status}; an activated hub requires \\.apex/_INDEX\\.md`, 'u'), status);
      assertNoLocalBodyAccess(repo, accesses, { descriptor: true });
      assert.equal(captureMain([repo]).code, 1, status);
    });
  }
});

test('pre-hub matrix: hub artifacts beside a pre-init descriptor are a partial hub, not an inception', () => {
  const cases = [
    ['.apex/standards', (repo) => mkdirSync(join(repo, '.apex', 'standards'))],
    ['.apex/standards', (repo) => putPortable(repo, '.apex/standards/web.md', '# web — Technical Standard\n')],
    ['.apex/conventions.md', (repo) => putPortable(repo, '.apex/conventions.md', '# Conventions\n')],
    ['.apex/glossary.md', (repo) => putPortable(repo, '.apex/glossary.md', '# Glossary\n')],
    ['.apex/decisions/_INDEX.md', (repo) => putPortable(repo, '.apex/decisions/_INDEX.md', '| `web` | [s](../standards/web.md) | `web-agent` |\n')],
    ['AGENTS.md', (repo) => putPortable(repo, 'AGENTS.md', '<!-- steepy:managed:project-instructions:v1:start -->\n# x\n<!-- steepy:managed:project-instructions:v1:end -->\n')],
    ['CLAUDE.md', (repo) => putPortable(repo, 'CLAUDE.md', '<!-- steepy:managed:claude-import:v1:start -->\n@AGENTS.md\n<!-- steepy:managed:claude-import:v1:end -->\n')],
    ['CLAUDE.md', (repo) => putPortable(repo, 'CLAUDE.md', '<!-- steepy:start -->\nlegacy\n<!-- steepy:end -->\n')],
    ['.claude/agents/web-agent.md', (repo) => putPortable(repo, '.claude/agents/web-agent.md', '<!-- steepy:generated:web-agent-claude:v1 -->\n')],
    ['.codex/agents/web-agent.toml', (repo) => putPortable(repo, '.codex/agents/web-agent.toml', '# steepy:generated:web-agent-codex:v1\n')],
    ['.agents/skills/demo-bootstrap/SKILL.md', (repo) => putPortable(repo, '.agents/skills/demo-bootstrap/SKILL.md', '<!-- steepy:generated:demo-bootstrap:v1 -->\n')],
    ['.opencode/nested/any.txt', (repo) => putPortable(repo, '.opencode/nested/any.txt', 'steepy:generated:web-agent-opencode:v2\n')],
  ];
  for (const [artifact, mutate] of cases) {
    withTempRepo('partial', (repo) => {
      seedInception(repo);
      mutate(repo);
      const { result, accesses } = recordFsAccess(() => classifyHub(repo));
      assert.equal(result.state, 'invalid', artifact);
      const messages = errorMessages(result.violations);
      assert.match(messages, /missing _INDEX\.md/u, artifact);
      assert.ok(messages.includes(`inception: pre-hub state is incompatible with hub artifact ${artifact}`), `${artifact}\n${messages}`);
      assertNoLocalBodyAccess(repo, accesses, { descriptor: true });
    });
  }
});

test('an index removed from an operational hub stays an error even beside a surviving pre-init descriptor', () => {
  const hub = portableHub();
  try {
    seedInception(hub);
    unlinkSync(join(hub, '.apex', '_INDEX.md'));
    const { result, accesses } = recordFsAccess(() => classifyHub(hub));
    assert.equal(result.state, 'invalid');
    const messages = errorMessages(result.violations);
    assert.match(messages, /missing _INDEX\.md/u);
    for (const artifact of ['.apex/standards', 'AGENTS.md', 'CLAUDE.md', '.claude/agents/web-agent.md']) {
      assert.ok(messages.includes(`incompatible with hub artifact ${artifact}`), `${artifact}\n${messages}`);
    }
    assertNoLocalBodyAccess(hub, accesses, { descriptor: true });
    const hook = captureMain(['--quiet', hub]);
    assert.equal(hook.code, 1);
  } finally {
    rmSync(hub, { recursive: true, force: true });
  }
});

test('an index removed from a hub activated by a completed transfer stays an error; the completed run grants nothing', () => {
  for (const [label, descriptor] of [
    ['init complete', initDescriptor('complete')],
    ['run complete', { ...initDescriptor('complete'), phase: 'complete', status: 'complete' }],
  ]) {
    const hub = portableHub();
    try {
      seedInception(hub, descriptor);
      assert.equal(errorMessages(collectViolations(hub)), '', `${label}: green while the index exists`);
      unlinkSync(join(hub, '.apex', '_INDEX.md'));
      const { result, accesses } = recordFsAccess(() => classifyHub(hub));
      assert.equal(result.state, 'invalid', label);
      const messages = errorMessages(result.violations);
      assert.match(messages, /missing _INDEX\.md/u, label);
      assert.match(messages, /inception: init is complete; an activated hub requires \.apex\/_INDEX\.md and never returns to pre-hub/u, label);
      assert.doesNotMatch(messages, new RegExp(LOCAL_SENTINEL, 'u'), label);
      assertNoLocalBodyAccess(hub, accesses, { descriptor: true });
      const loud = captureMain([hub]);
      assert.equal(loud.code, 1, label);
      assert.doesNotMatch(loud.out, /pre-hub|coherent/u, label);
      assert.equal(captureMain(['--quiet', hub]).code, 1, `${label}: the Stop hook path blocks too`);
    } finally {
      rmSync(hub, { recursive: true, force: true });
    }
  }
});

test('an operational hub applies every check and never depends on local inception or work state', {
  skip: process.platform === 'win32',
}, () => {
  const variants = [
    ['absent', () => {}],
    ['valid pre-init', (hub) => seedInception(hub)],
    ['malformed', (hub) => {
      seedInception(hub);
      writeFileSync(join(hub, '.apex', 'inception', 'state.json'), '{');
    }],
    ['unknown version', (hub) => {
      seedInception(hub);
      writeFileSync(join(hub, '.apex', 'inception', 'state.json'),
        `${JSON.stringify({ ...createInitialInceptionState(RUN), schemaVersion: 9 }, null, 2)}\n`);
    }],
    ['init in progress', (hub) => seedInception(hub, initDescriptor('in-progress'))],
    ['init complete', (hub) => seedInception(hub, initDescriptor('complete'))],
    ['run complete', (hub) => seedInception(hub, { ...initDescriptor('complete'), phase: 'complete', status: 'complete' })],
    ['symlinked areas', (hub) => {
      const external = mkdtempSync(join(tmpdir(), 'steepy-prehub-external-'));
      putPortable(external, 'inception/doc.md', `# ${LOCAL_SENTINEL}\n[Broken](missing.md)\n`);
      putPortable(external, 'work/doc.md', `# ${LOCAL_SENTINEL}\n[Broken](missing.md)\n`);
      symlinkSync(join(external, 'inception'), join(hub, '.apex', 'inception'), 'dir');
      symlinkSync(join(external, 'work'), join(hub, '.apex', 'work'), 'dir');
      return () => rmSync(external, { recursive: true, force: true });
    }],
    ['unreadable area', (hub) => {
      seedInception(hub);
      if (process.getuid?.() !== 0) chmodSync(join(hub, '.apex', 'inception'), 0o000);
      return () => chmodSync(join(hub, '.apex', 'inception'), 0o700);
    }],
  ];
  for (const [label, mutate] of variants) {
    const hub = portableHub();
    let cleanup;
    try {
      const baseline = collectViolations(hub);
      assert.deepEqual(baseline.filter(({ level }) => level === 'error'), [], label);
      cleanup = mutate(hub);
      const { result, accesses } = recordFsAccess(() => classifyHub(hub));
      assert.equal(result.state, 'hub', label);
      assert.deepEqual(result.violations, baseline, label);
      assertNoLocalBodyAccess(hub, accesses);
      const loud = captureMain([hub]);
      assert.equal(loud.code, 0, `${label}: ${loud.err}`);
      assert.match(loud.out, /OK — doc graph is coherent/u, label);
    } finally {
      cleanup?.();
      rmSync(hub, { recursive: true, force: true });
    }
  }
});

test('stable docs never reach inception through links, traversal, hard links, routing, or mounts', () => {
  const hub = portableHub();
  try {
    seedInception(hub);
    putPortable(hub, '.apex/leaf.md', '# Leaf\n');
    const index = join(hub, '.apex', '_INDEX.md');
    writeFileSync(index, [
      readFileSync(index, 'utf8'),
      `- [Proposal](inception/${RUN}/proposal.md)`,
      '- [Traversal](inception/../leaf.md)',
      `| \`ghost\` | [standards/ghost.md](inception/${RUN}/ghost.md) | \`ghost-agent\` | — |`,
      '',
    ].join('\n'));
    putPortable(hub, '.apex/notes.md', '# Notes\n');
    writeFileSync(index, `${readFileSync(index, 'utf8')}- [Notes](notes.md)\n`);
    unlinkSync(join(hub, '.apex', 'notes.md'));
    linkSync(join(hub, PROPOSAL), join(hub, '.apex', 'notes.md'));
    writeFileSync(join(hub, 'AGENTS.md'), `${readFileSync(join(hub, 'AGENTS.md'), 'utf8')}\n- [State](.apex/inception/state.json)\n`);
    putPortable(hub, `.apex/inception/${RUN}/claude.md`, `# ${LOCAL_SENTINEL}\n`);
    unlinkSync(join(hub, 'CLAUDE.md'));
    symlinkSync(`.apex/inception/${RUN}/claude.md`, join(hub, 'CLAUDE.md'));
    rmSync(join(hub, '.opencode'), { recursive: true });
    symlinkSync(`.apex/inception/${RUN}`, join(hub, '.opencode'), 'dir');

    const { result, accesses } = recordFsAccess(() => classifyHub(hub));
    const messages = errorMessages(result.violations);
    assert.equal(result.state, 'hub');
    assert.match(messages, /stable docs must not link into \.apex\/inception: \.apex\/_INDEX\.md -> inception\/.*proposal\.md/u);
    assert.match(messages, /stable docs must not link into \.apex\/inception: \.apex\/_INDEX\.md -> inception\/\.\.\/leaf\.md/u);
    assert.match(messages, /anti-orphan: \.apex\/leaf\.md/u, 'enter-and-exit links never establish reachability');
    assert.match(messages, /stable docs must not link into \.apex\/inception: \.apex\/_INDEX\.md -> inception\/.*ghost\.md/u);
    assert.match(messages, /stable-read: \.apex\/notes\.md is hard-linked/u);
    assert.match(messages, /stable-read: \.apex\/inception\/state\.json enters excluded \.apex\/inception/u);
    assert.match(messages, /stable-read: CLAUDE\.md symlink mount enters excluded \.apex\/inception/u);
    assert.match(messages, /stable-read: \.opencode.* symlink mount enters excluded \.apex\/inception/u);
    assert.doesNotMatch(messages, new RegExp(LOCAL_SENTINEL, 'u'));
    assertNoLocalBodyAccess(hub, accesses);
  } finally {
    rmSync(hub, { recursive: true, force: true });
  }
});

test('case aliases of inception are refused before any hidden byte is consumed', (t) => {
  withTempRepo('case', (hub) => {
    if (!storageAliasesCase(hub)) {
      t.skip('temporary storage keeps case-distinct directory identities');
      return;
    }
    seedInception(hub);
    putPortable(hub, '.apex/leaf.md', '# Leaf\n');
    putPortable(hub, '.apex/_INDEX.md', [
      '# Index',
      `- [Hidden](INCEPTION/${RUN}/proposal.md)`,
      '- [Traversal](InCePtIoN/../leaf.md)',
      '',
    ].join('\n'));
    const { result, accesses } = recordFsAccess(() => classifyHub(hub));
    const messages = errorMessages(result.violations);
    assert.match(messages, /enters excluded \.apex\/inception/u);
    assert.match(messages, /anti-orphan: \.apex\/leaf\.md/u);
    assert.doesNotMatch(messages, new RegExp(LOCAL_SENTINEL, 'u'));
    assertNoLocalBodyAccess(hub, accesses);
  });
});

test('I1(a,d): a local area linked to a stable .apex subdirectory is a hub error, never a silent skip', () => {
  for (const area of ['work', 'inception']) {
    withTempRepo(`alias-hub-${area}`, (hub) => {
      putPortable(hub, '.apex/_INDEX.md', '# Index\n');
      putPortable(hub, '.apex/sub/orphan.md', `# ${LOCAL_SENTINEL}\n[Broken](missing.md)\n`);
      symlinkSync('sub', join(hub, '.apex', area), 'dir');
      const { result, accesses } = recordFsAccess(() => classifyHub(hub));
      assert.equal(result.state, 'hub', area);
      const messages = errorMessages(result.violations);
      assert.match(messages, new RegExp(`stable-read: \\.apex/sub aliases excluded \\.apex/${area}`, 'u'), area);
      assert.doesNotMatch(messages, new RegExp(LOCAL_SENTINEL, 'u'), area);
      assertNoLocalBodyAccess(hub, accesses);
      const physical = realpathSync.native(hub);
      assert.deepEqual(accesses.filter(({ path }) => under(path, join(hub, '.apex', 'sub'))
        || under(path, join(physical, '.apex', 'sub'))), [], `${area}: the aliased area storage is never read`);
      const loud = captureMain([hub]);
      assert.equal(loud.code, 1, area);
      assert.doesNotMatch(loud.out, /coherent/iu, area);
    });
  }
});

test('I1(b,d): a work area linked to residual routing beside a pre-init descriptor is not a pre-hub', () => {
  withTempRepo('alias-prehub', (repo) => {
    seedInception(repo);
    rmSync(join(repo, '.apex', 'work'), { recursive: true });
    putPortable(repo, '.apex/decisions/_INDEX.md', '| `web` | [s](../standards/web.md) | `web-agent` |\n');
    symlinkSync('decisions', join(repo, '.apex', 'work'), 'dir');
    const { result, accesses } = recordFsAccess(() => classifyHub(repo));
    assert.equal(result.state, 'invalid');
    const messages = errorMessages(result.violations);
    assert.match(messages, /missing _INDEX\.md/u);
    assert.match(messages, /stable-read: \.apex\/decisions aliases excluded \.apex\/work/u);
    assertNoLocalBodyAccess(repo, accesses, { descriptor: true });
    const physical = realpathSync.native(repo);
    assert.deepEqual(accesses.filter(({ path }) => under(path, join(physical, '.apex', 'decisions'))), []);
    const hook = captureMain(['--quiet', repo]);
    assert.equal(hook.code, 1);
  });
});

test('M1: a reader-refused stable document is reported once, not also as an orphan', () => {
  const hub = portableHub();
  const outside = mkdtempSync(join(tmpdir(), 'steepy-hardlink-outside-'));
  try {
    const index = join(hub, '.apex', '_INDEX.md');
    writeFileSync(index, `${readFileSync(index, 'utf8')}- [Notes](notes.md)\n`);
    putPortable(hub, '.apex/notes.md', '# Notes\n');
    putPortable(hub, '.apex/loose.md', '# Loose\n');
    linkSync(join(hub, '.apex', 'notes.md'), join(outside, 'notes.md'));
    linkSync(join(hub, '.apex', 'loose.md'), join(outside, 'loose.md'));
    const messages = errorMessages(collectViolations(hub));
    assert.match(messages, /stable-read: \.apex\/notes\.md is hard-linked/u);
    assert.match(messages, /stable-read: \.apex\/loose\.md is hard-linked/u);
    assert.doesNotMatch(messages, /anti-orphan: \.apex\/(notes|loose)\.md/u);
  } finally {
    rmSync(hub, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('M3: a pre-init descriptor refused only by a stable-read failure carries an inception reason', () => {
  withTempRepo('prehub-read-failure', (repo) => {
    seedInception(repo);
    putPortable(repo, 'notes.md', '# Notes\n');
    symlinkSync(join(repo, 'notes.md'), join(repo, '.apex', 'stray.md'));
    const result = classifyHub(repo);
    assert.equal(result.state, 'invalid');
    const messages = errorMessages(result.violations);
    assert.match(messages, /stable-read: \.apex\/stray\.md is symlink/u);
    assert.match(messages, /inception: pre-hub state not recognized: stable reads failed/u);
  });
});

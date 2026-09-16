// Structural canary suite (spec "Cross-harness canary criteria", CI-testable half of
// criteria 1-5/9 — .apex/work/specs/2026-07-14-native-multi-harness-plugins.md).
//
// Without any live harness installed, proves the engine is structurally installable
// and runnable anywhere: engine scripts resolve through the literal skill-relative
// path a harness would compute (`skills/<name>/../../scripts/<x>.mjs`, unnormalized),
// nothing depends on `CLAUDE_*` env or `~/.claude`/`$HOME` (criterion 9's scripted
// half), and all nine SKILL.md are open-subset discoverable with the canonical
// Engine-root block. The live halves (real harness install, discovery listing, chain
// drive) land in RELEASE.md's evidence matrix (T11), human-executed.
//
// Relationship to tests/portability-contract.test.mjs: that suite's lock (b)
// (frontmatter) and lock (c) (engine-root resolution) already assert two of the same
// facts about skills/**. This suite intentionally re-asserts them in canary shape —
// parse-based discovery framed as "can a harness bootstrap from this", plus the
// isolated-HOME/scrubbed-env spawn case that portability-contract does not cover at
// all — rather than deduplicating the two suites (T10 brief). Per
// .apex/standards/tests.md's anti-patterns note, the frontmatter-extraction regex
// below is a consciously-flagged fourth copy (portability-contract.test.mjs,
// new-surface.test.mjs, and discovery-skill.test.mjs already carry one each).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  existsSync,
  cpSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const skillsDir = join(root, 'skills');
const goodHubDir = join(root, 'tests', 'fixtures', 'good-hub');

// The nine skills a harness discovers and chains (brief's enumeration order).
const SKILL_NAMES = [
  'init',
  'check',
  'new-surface',
  'discovery',
  'brainstorm',
  'plan',
  'implement',
  'review',
  'loop-engineer',
];

// The canonical Engine-root block sentence, pinned verbatim from skills/check/SKILL.md
// (identical, single-line, across all nine — verified below by test, not assumed here).
const ENGINE_ROOT_CANONICAL = 'scripts live two levels up, at `<engine-root>/scripts/`.';

// Builds the literal `skills/<name>/../../scripts/<file>` string a harness would
// compute by walking two levels up from the skill's own reported base directory.
// Deliberately uses Array#join(sep) instead of node:path's join/resolve — those
// normalize away the '..' segments, which would defeat the point: this suite spawns
// (and stats) the *unnormalized* literal form, so the engine-root resolution the
// harness contract documents is exercised for real, not pre-solved by the test.
function skillRelative(name, ...scriptParts) {
  return [skillsDir, name, '..', '..', 'scripts', ...scriptParts].join(sep);
}

const gitProbe = spawnSync('git', ['--version'], { encoding: 'utf8' });
const HAS_GIT = gitProbe.status === 0;

// A fresh, isolated fixture repo: a git-initialized copy of tests/fixtures/good-hub
// (the smallest hub validate-hub.test.mjs already proves is error/warn-free) in its
// own temp dir. Never mutates the repo's own tests/fixtures/good-hub.
function makeFixtureRepo(suffix) {
  const fixture = mkdtempSync(join(tmpdir(), `steepy-canary-fixture-${suffix}-`));
  cpSync(goodHubDir, fixture, { recursive: true });
  const init = spawnSync('git', ['init', '--quiet'], { cwd: fixture, encoding: 'utf8' });
  if (init.status !== 0) {
    rmSync(fixture, { recursive: true, force: true });
    throw new Error(`git init failed in the fixture repo: ${init.stderr || init.error}`);
  }
  return fixture;
}

// process.env with every CLAUDE_* key filtered out, HOME/USERPROFILE pointed at the
// fake home. Everything else (PATH, etc.) passes through unchanged so node/git resolve.
function scrubbedEnv(fakeHome) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('CLAUDE_')) continue;
    env[key] = value;
  }
  env.HOME = fakeHome;
  env.USERPROFILE = fakeHome;
  return env;
}

function assertFakeHomeUntouched(fakeHome) {
  assert.equal(
    existsSync(join(fakeHome, '.claude')),
    false,
    'no .claude/ may be created under the fake HOME'
  );
  assert.deepEqual(
    readdirSync(fakeHome),
    [],
    'the fake HOME must be byte-empty after the run — the engine must not create or read-create anything under it'
  );
}

// --- Case 1: isolated-HOME engine run (spec criterion 9's scripted half) ----------

test('validate-hub runs green through the literal skill-relative path with a CLAUDE_*-scrubbed, isolated-HOME environment, and never touches the fake HOME (criterion 9)', (t) => {
  if (!HAS_GIT) {
    t.skip('git is not available in this environment');
    return;
  }
  const fakeHome = mkdtempSync(join(tmpdir(), 'steepy-canary-home-'));
  const fixture = makeFixtureRepo('validate-hub');
  try {
    const script = skillRelative('check', 'validate-hub.mjs');
    assert.ok(
      existsSync(script),
      `sanity: the literal skill-relative path must resolve to a real file first: ${script}`
    );
    const result = spawnSync(process.execPath, [script, fixture], {
      encoding: 'utf8',
      env: scrubbedEnv(fakeHome),
    });
    assert.equal(
      result.status,
      0,
      `validate-hub must exit 0 on the scaffolded fixture — stderr:\n${result.stderr}\nstdout:\n${result.stdout}`
    );
    assert.match(result.stdout, /steepy validate-hub: OK/);
    assertFakeHomeUntouched(fakeHome);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('new-surface scaffolds into the fixture through the literal skill-relative path with the same isolated environment, and never touches the fake HOME', (t) => {
  if (!HAS_GIT) {
    t.skip('git is not available in this environment');
    return;
  }
  const fakeHome = mkdtempSync(join(tmpdir(), 'steepy-canary-home-'));
  const fixture = makeFixtureRepo('new-surface');
  try {
    const script = skillRelative('new-surface', 'new-surface.mjs');
    assert.ok(
      existsSync(script),
      `sanity: the literal skill-relative path must resolve to a real file first: ${script}`
    );
    const result = spawnSync(
      process.execPath,
      [script, '--name', 'x', '--path', 'x', '--agent', 'x-agent', '--test', 'true', '--hub', fixture],
      { encoding: 'utf8', env: scrubbedEnv(fakeHome) }
    );
    assert.equal(
      result.status,
      0,
      `new-surface must exit 0 — stderr:\n${result.stderr}\nstdout:\n${result.stdout}`
    );
    assert.match(result.stdout, /created/);
    assert.ok(
      existsSync(join(fixture, '.apex', 'standards', 'x.md')),
      'new-surface must scaffold the standard doc into the fixture'
    );
    assert.ok(
      existsSync(join(fixture, '.claude', 'agents', 'x-agent.md')),
      'new-surface must scaffold the agent doc into the fixture'
    );
    assertFakeHomeUntouched(fakeHome);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

// --- Case 2: nine-skill open-subset discovery parse -------------------------------

test('all nine skills/<name>/SKILL.md declare open-subset name + description frontmatter and carry the canonical Engine-root block', () => {
  assert.deepEqual(
    [...SKILL_NAMES].sort(),
    readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(),
    'SKILL_NAMES must track skills/* exactly (a tenth skill or a removed one must fail this suite)'
  );

  const offenders = [];
  for (const name of SKILL_NAMES) {
    const path = join(skillsDir, name, 'SKILL.md');
    if (!existsSync(path)) {
      offenders.push(`${name}/SKILL.md: file missing`);
      continue;
    }
    const text = readFileSync(path, 'utf8');
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatter) {
      offenders.push(`${name}/SKILL.md: no --- frontmatter block found`);
    } else {
      if (!/^name:\s*\S+/m.test(frontmatter[1])) offenders.push(`${name}/SKILL.md: missing or empty 'name' key`);
      if (!/^description:\s*\S+/m.test(frontmatter[1])) offenders.push(`${name}/SKILL.md: missing or empty 'description' key`);
    }
    if (!text.includes(ENGINE_ROOT_CANONICAL)) {
      offenders.push(`${name}/SKILL.md: missing the canonical Engine-root sentence ('${ENGINE_ROOT_CANONICAL}')`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `a harness must be able to discover every skill from an open frontmatter subset ` +
      `(name + description) and resolve its engine root via the canonical block; violations:\n` +
      offenders.join('\n')
  );
});

// --- Case 3: engine-root resolution invariant for all nine skills -----------------

test('engine-root resolution invariant: skills/<name>/../../scripts/validate-hub.mjs resolves to an existing file for all nine skills', () => {
  const offenders = [];
  for (const name of SKILL_NAMES) {
    const resolved = join(skillsDir, name, '..', '..', 'scripts', 'validate-hub.mjs');
    if (!existsSync(resolved)) {
      offenders.push(`${name}: ${resolved} does not exist`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `every skill must resolve its engine root two levels up to scripts/; violations:\n` + offenders.join('\n')
  );
});

test('portable root and bootstrap sources are model-generic, while the routing index stays harness-neutral', () => {
  const rootTemplate = readFileSync(join(root, 'templates', 'AGENTS.md'), 'utf8');
  const bootstrapTemplate = readFileSync(join(root, 'templates', 'project-bootstrap-skill.md'), 'utf8');
  const index = readFileSync(join(root, '.apex', '_INDEX.md'), 'utf8');
  for (const [label, text] of [['root template', rootTemplate], ['bootstrap template', bootstrapTemplate]]) {
    assert.match(text, /\{\{projectName\}\}/, `${label} must derive its project identity from the public model`);
    assert.doesNotMatch(text, /steepy-apex/i, `${label} must not hard-code this repository name`);
  }
  assert.match(index, /## Routing Table/);
  assert.doesNotMatch(index, /\b(?:pi|dsh)\b[^\n]*(?:runner|--)/i, 'the routing index must not invent Pi/DSH runner declarations');
});

test('Pi and DeepSeek structural canaries report runner-unavailable without a live harness', () => {
  const temp = mkdtempSync(join(tmpdir(), 'steepy-canary-unavailable-'));
  try {
    for (const harness of ['pi', 'deepseek']) {
      const output = join(temp, `${harness}.json`);
      const result = spawnSync(
        process.execPath,
        [join(root, 'scripts', 'live-scaffold-canary.mjs'), '--harness', harness, '--output', output],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 1, 'a non-runnable harness must keep the release gate closed');
      const [row] = readFileSync(output, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.match(row.identity.sourceRevision, /^[a-f0-9]{40}$/u);
      assert.match(row.identity.payloadSha256, /^[a-f0-9]{64}$/u);
      assert.deepEqual(row, {
        schemaVersion: 1,
        harness,
        cli: null,
        version: null,
        durationMs: 0,
        log: '',
        verdict: 'NOT RUN',
        reasonCode: 'runner-unavailable',
        identity: row.identity,
        capabilities: [],
      });
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('live canary rows bind product identity and scope descriptor PASS to nonce evidence only', () => {
  const driver = readFileSync(join(root, 'scripts', 'live-scaffold-canary.mjs'), 'utf8');
  assert.match(driver, /sourceRevision/);
  assert.match(driver, /payloadSha256/);
  assert.match(driver, /productVersion/);
  assert.match(driver, /canonical-headless-descriptor/);
  assert.match(driver, /descriptor-nonce-response/);
  assert.doesNotMatch(driver, /RUNNABLE_HARNESSES\s*=\s*new Set\([^)]*['"]pi['"]/);
  assert.doesNotMatch(driver, /RUNNABLE_HARNESSES\s*=\s*new Set\([^)]*['"]deepseek['"]/);
});

test('OpenCode local-checkout instructions retain a complete relocated package and its documented entry loads', async () => {
  const installationGuide = readFileSync(join(root, 'docs/installation.md'), 'utf8');
  const openCodeSection = installationGuide.match(/### OpenCode\n([\s\S]*?)\n### Pi\n/)?.[1] ?? '';
  assert.match(
    openCodeSection,
    /file:\/\/\/ABSOLUTE\/PATH\/TO\/steepy-apex\/adapters\/opencode\/steepy-apex\.js/,
    'local checkout instructions must use OpenCode\'s documented file-URL entry shape',
  );
  assert.doesNotMatch(
    openCodeSection,
    /drop `?adapters\/opencode\/steepy-apex\.js`?/i,
    'instructions must not suggest copying the entry module away from its package payload',
  );

  const fixture = mkdtempSync(join(tmpdir(), 'steepy-opencode-relocated-'));
  const payload = join(fixture, 'steepy-apex');
  try {
    mkdirSync(payload);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    cpSync(join(root, 'package.json'), join(payload, 'package.json'));
    for (const relativePath of pkg.files) {
      cpSync(join(root, relativePath), join(payload, relativePath), { recursive: true });
    }
    const entry = typeof pkg.exports === 'string' ? pkg.exports : pkg.exports['.'];
    const entryPath = join(payload, entry);
    const relocated = await import(`${pathToFileURL(entryPath).href}?relocated=${Date.now()}`);
    assert.equal(typeof relocated.SteepyApex, 'function', 'the package export loads after relocation');
    const hooks = await relocated.SteepyApex({});
    const config = {};
    await hooks.config(config);
    assert.ok(
      config.skills.paths.some((path) => realpathSync(path) === realpathSync(join(payload, 'skills'))),
      'the documented entry resolves canonical skills from the complete relocated payload',
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

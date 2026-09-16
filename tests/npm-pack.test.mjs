import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Locks the multi-harness release payload (spec criterion 11): everything a
// Codex/OpenCode/Pi/Claude Code install needs must actually land in the npm tarball,
// not just exist in the working tree. `npm pack --dry-run --json` is the only
// authoritative source for "what files[] + .npmignore/.gitignore resolve to" — it's
// somewhat slow (~1-3s), so it runs ONCE in before() and every test below shares the
// parsed file list.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

let paths;
let cacheDir;
let packFilename;

before(() => {
  // A scratch --cache dir keeps this hermetic (no dependency on / mutation of the
  // invoking machine's real npm cache) and matches tests/release-metadata.test.mjs's
  // existing npm-pack-dry-run test. --dry-run means npm never writes a tarball to disk.
  cacheDir = mkdtempSync(join(tmpdir(), 'steepy-npm-pack-cache-'));
  const result = spawnSync(
    npmBin,
    ['--cache', cacheDir, 'pack', '--dry-run', '--json'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(
    result.status,
    0,
    `npm pack --dry-run --json must exit 0 — stderr:\n${result.stderr || '(empty)'}\nstdout:\n${result.stdout || '(empty)'}`,
  );

  let pack;
  try {
    [pack] = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`npm pack --dry-run --json produced non-JSON stdout: ${err.message}\n${result.stdout}`);
  }
  paths = pack.files.map((file) => file.path);
  packFilename = pack.filename;
});

after(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

function assertPacked(required, label) {
  for (const path of required) {
    assert.ok(paths.includes(path), `${label ? `${label}: ` : ''}tarball must include ${path}`);
  }
}

test('npm tarball includes the Claude Code plugin manifest + marketplace file', () => {
  assertPacked(['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']);
});

test('npm tarball includes the Codex plugin manifest', () => {
  assertPacked(['.codex-plugin/plugin.json']);
});

test('npm tarball includes the Codex plugin visual assets', () => {
  assertPacked(['assets/plugin-icon.png', 'assets/plugin-icon.svg']);
});

test('npm tarball includes the .agents plugin marketplace file', () => {
  assertPacked(['.agents/plugins/marketplace.json']);
});

test('npm tarball includes the OpenCode, Pi, and dsh adapters, and the headless adapter', () => {
  assertPacked([
    'adapters/opencode/steepy-apex.js',
    'adapters/pi/steepy-apex.js',
    'adapters/dsh/steepy-apex.js',
    'adapters/headless.mjs',
  ]);
});

test('npm tarball includes the dsh cordis bundle patch manifest', () => {
  assertPacked(['cordis.patch.yml']);
});

test('npm tarball includes all nine SKILL.md files', () => {
  const skillNames = [
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
  assertPacked(skillNames.map((name) => `skills/${name}/SKILL.md`), 'nine SKILL.md files');
});

test('npm tarball includes the six subagent prompt templates', () => {
  assertPacked([
    'skills/implement/implementer-prompt.md',
    'skills/implement/task-reviewer-prompt.md',
    'skills/implement/final-review-prompt.md',
    'skills/discovery/explore-surface-prompt.md',
    'skills/loop-engineer/loop-implementer-prompt.md',
    'skills/loop-engineer/loop-final-review-prompt.md',
  ], 'six prompt templates');
});

test('npm tarball includes the engine scripts', () => {
  assertPacked([
    'scripts/validate-hub.mjs',
    'scripts/stop-hook.mjs',
    'scripts/new-surface.mjs',
    'scripts/bump-version.mjs',
    'scripts/autopilot.mjs',
    'scripts/capture-review-evidence.mjs',
    'scripts/workflow-state.mjs',
    'scripts/loop-engineer.mjs',
    'scripts/validate-release-evidence.mjs',
  ], 'engine scripts');
});

test('npm tarball includes the portable scaffold runtime, v1 sources, and canonical dogfood bootstrap', () => {
  assertPacked([
    'scripts/project-scaffold.mjs',
    'scripts/live-scaffold-canary.mjs',
    '.agents/skills/steepy-apex-bootstrap/SKILL.md',
    'templates/AGENTS.md',
    'templates/claude-import.md',
    'templates/project-bootstrap-skill.md',
    'templates/claude-bootstrap-stub.md',
    'templates/surface-agent-claude.md',
    'templates/surface-agent-codex.toml',
    'templates/surface-agent-opencode.md',
  ], 'portable scaffold payload');
});

test('npm pack dry-run leaves no repository tarball behind', () => {
  assert.equal(
    existsSync(join(root, packFilename)),
    false,
    'npm pack --dry-run must not create its reported tarball in the repository',
  );
});

test('npm tarball includes both harness hook manifests', () => {
  assertPacked(['hooks/hooks.json', 'hooks/hooks-codex.json']);
});

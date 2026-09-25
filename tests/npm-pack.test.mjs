import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

// Every module specifier a source can load: static `import`/`export … from`,
// bare side-effect imports, and dynamic `import(…)` (a non-literal dynamic
// argument is reported as such so it can never pass a boundary check).
function moduleSpecifiers(source) {
  return [
    ...source.matchAll(/^(?:import|export)\s[^'";]*?\sfrom\s+['"]([^'"]+)['"]/gmu),
    ...source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gmu),
    ...source.matchAll(/\bimport\s*\(\s*(?:['"]([^'"]+)['"]\s*\))?/gu),
  ].map((match) => match[1] ?? '<non-literal dynamic import>');
}

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

test('npm tarball includes all ten SKILL.md files', () => {
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
    'inception',
  ];
  assertPacked(skillNames.map((name) => `skills/${name}/SKILL.md`), 'ten SKILL.md files');
});

test('npm tarball includes every inception support file', () => {
  assertPacked([
    'skills/inception/protocol.md',
    'skills/inception/reconnaissance.md',
    'skills/inception/architecture.md',
    'skills/inception/bootstrap.md',
    'skills/inception/init-handoff.md',
  ], 'inception support files');
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
    'scripts/task-results.mjs',
    'scripts/source-observation.mjs',
    'scripts/capture-review-evidence.mjs',
    'scripts/workflow-state.mjs',
    'scripts/loop-engineer.mjs',
    'scripts/validate-release-evidence.mjs',
  ], 'engine scripts');
});

test('npm tarball includes the inception helpers, which import only Node built-ins and packaged siblings', () => {
  const helpers = ['scripts/inception-paths.mjs', 'scripts/inception-state.mjs', 'scripts/inception-handoff.mjs'];
  assertPacked(helpers, 'inception helpers');
  for (const helper of helpers) {
    const specifiers = moduleSpecifiers(readFileSync(join(root, helper), 'utf8'));
    assert.ok(specifiers.length > 0, `${helper} must declare its imports`);
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('./'),
        `${helper} must stay dependency-free, got import '${specifier}'`,
      );
      if (specifier.startsWith('./')) assertPacked([`scripts/${specifier.slice(2)}`], `${helper} sibling`);
    }
  }
});

test('npm tarball includes the stable-paths reader, which imports only Node built-ins and sanitize', () => {
  // The linter and later scaffold readers share this module, so it must not
  // import either of them back (no validate-hub -> project-scaffold cycle).
  const helper = 'scripts/stable-paths.mjs';
  assertPacked([helper, 'scripts/sanitize.mjs'], 'stable-paths reader');
  const specifiers = moduleSpecifiers(readFileSync(join(root, helper), 'utf8'));
  assert.ok(specifiers.includes('./sanitize.mjs'), `${helper} must reuse sanitize.mjs mount binding`);
  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith('node:') || specifier === './sanitize.mjs',
      `${helper} may import only Node built-ins and sanitize.mjs, got '${specifier}'`,
    );
  }
});

test('npm tarball includes receipt instructions and both reviewer transport schemas', () => {
  assertPacked([
    'skills/implement/task-results-protocol.md',
    'skills/implement/reviewer-recovery.md',
    'skills/implement/reviewer-response.schema.json',
    'skills/implement/reviewer-response-v2.schema.json',
    'adapters/reviewer-response.mjs',
  ]);
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

test('npm tarball includes the inception and project skeleton templates', () => {
  assertPacked([
    'templates/inception-project.md',
    'templates/inception-verification.md',
    'templates/project-context.md',
    'templates/project-architecture.md',
  ], 'inception and project skeleton templates');
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

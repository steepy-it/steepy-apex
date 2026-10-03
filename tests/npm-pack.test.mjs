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
    'templates/prior/v1.0/project-bootstrap-skill.md',
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

test('npm tarball includes the controller runtime payload the conductor fingerprints and binds', async () => {
  assertPacked([
    'scripts/autopilot-controller.mjs',
    'scripts/autopilot-recovery.mjs',
    'scripts/autopilot-state.mjs',
    'scripts/autopilot-runtime.mjs',
    'scripts/reviewer-response.mjs',
    'scripts/headless-runner.mjs',
    'adapters/headless-response.mjs',
    'skills/implement/controller-role-prompt.md',
    'skills/implement/reviewer-correction-prompt.md',
    'skills/implement/reviewer-response-v3.schema.json',
    'skills/plan/controller-response.schema.json',
    'skills/review/controller-response.schema.json',
  ], 'controller payload');
  // Every file a run's immutable identity fingerprints must ship, or an
  // installed engine could never resume a run it started.
  const { fingerprintAutopilotRuntime } = await import('../scripts/autopilot-runtime.mjs');
  assertPacked(fingerprintAutopilotRuntime(root).files.map(({ path }) => path), 'fingerprinted runtime file');
  // The controller and recovery CLIs load only Node built-ins and packaged modules.
  const seen = new Set();
  const visit = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    assertPacked([path], 'controller import closure');
    for (const specifier of moduleSpecifiers(readFileSync(join(root, path), 'utf8'))) {
      if (specifier.startsWith('node:')) continue;
      assert.match(specifier, /^\.\.?\//, `${path} must import only Node built-ins and packaged modules, got '${specifier}'`);
      visit(join(dirname(path), specifier).split('\\').join('/'));
    }
  };
  for (const entry of ['scripts/autopilot.mjs', 'scripts/autopilot-controller.mjs', 'scripts/autopilot-recovery.mjs']) visit(entry);
});

// The skills invoke engine scripts by `<engine-root>/scripts/<name>.mjs`; an
// installed engine must carry each one, including the plan skill's v2 gate.
test('npm tarball includes every engine script the packaged skills invoke', () => {
  const skillFiles = paths.filter((path) => path.startsWith('skills/') && path.endsWith('.md'));
  const invoked = new Set(skillFiles.flatMap((path) => [...readFileSync(join(root, path), 'utf8')
    .matchAll(/<engine-root>\/(scripts\/[a-z0-9-]+\.mjs)/g)].map((match) => match[1])));
  for (const script of ['scripts/autopilot-context.mjs', 'scripts/task-results.mjs', 'scripts/reviewer-response.mjs',
    'scripts/capture-review-evidence.mjs', 'scripts/validate-hub.mjs']) {
    assert.ok(invoked.has(script), `the skills must still invoke ${script}`);
  }
  assertPacked([...invoked].sort(), 'skill-invoked engine script');
  assertPacked(['scripts/autopilot-plan.mjs'], 'v2 plan grammar behind --verify-plan --controller-protocol 2');
});

test('npm tarball excludes the synthetic controller fixtures and the opt-in native smoke driver', () => {
  for (const path of ['tests/fixtures/autopilot-controller/fake-harness.mjs', 'tests/fixtures/autopilot-controller/native-smoke.mjs']) {
    assert.ok(existsSync(join(root, path)), `${path} must exist in the repository`);
    assert.equal(paths.includes(path), false, `${path} is test-only and must not ship`);
  }
  assert.deepEqual(paths.filter((path) => path.startsWith('tests/')), [], 'no test file ships in the payload');
});

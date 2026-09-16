import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldBlock } from '../scripts/push-version-guard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const hook = join(root, 'scripts', 'push-version-guard.mjs');

// ---------------------------------------------------------------------------
// Pure shouldBlock() matrix — no I/O.
// ---------------------------------------------------------------------------

test('shouldBlock: git push + main + unbumped -> block, reason instructs patch/minor/major', () => {
  const { block, reason } = shouldBlock({
    command: 'git push',
    branch: 'main',
    headVersion: '1.0.0',
    originVersion: '1.0.0',
  });
  assert.equal(block, true);
  assert.match(reason, /patch/);
  assert.match(reason, /minor/);
  assert.match(reason, /major/);
  assert.match(reason, /bump-version\.mjs/);
  assert.match(reason, /1\.0\.0/);
});

test('shouldBlock: git push + main + already bumped -> no block', () => {
  const { block } = shouldBlock({
    command: 'git push',
    branch: 'main',
    headVersion: '1.0.1',
    originVersion: '1.0.0',
  });
  assert.equal(block, false);
});

test('shouldBlock: non-push command on main, unbumped -> no block', () => {
  const { block } = shouldBlock({
    command: 'git status',
    branch: 'main',
    headVersion: '1.0.0',
    originVersion: '1.0.0',
  });
  assert.equal(block, false);
});

test('shouldBlock: known invalid versions and downgrades block; numeric increases pass', () => {
  for (const [headVersion, originVersion] of [
    ['1.2.9', '1.2.10'], ['1.9.99', '1.10.0'], ['9.99.99', '10.0.0'],
    ['01.2.3', '1.2.2'], ['1.2.3', '1.02.2'], ['9007199254740992.0.0', '1.0.0'],
    [42, '1.0.0'], ['1.0.0', null],
  ]) {
    assert.equal(shouldBlock({ command: 'git push', branch: 'main', headVersion, originVersion }).block, true);
    assert.equal(shouldBlock({ command: 'git status', branch: 'main', headVersion, originVersion }).block, false);
    assert.equal(shouldBlock({ command: 'git push', branch: 'feature', headVersion, originVersion }).block, false);
  }
  for (const [headVersion, originVersion] of [['1.2.10', '1.2.9'], ['1.10.0', '1.9.99'], ['10.0.0', '9.99.99']]) {
    assert.equal(shouldBlock({ command: 'git push', branch: 'main', headVersion, originVersion }).block, false);
  }
});

test('shouldBlock: git push on a non-main branch, unbumped -> no block', () => {
  const { block } = shouldBlock({
    command: 'git push',
    branch: 'feature/x',
    headVersion: '1.0.0',
    originVersion: '1.0.0',
  });
  assert.equal(block, false);
});

test('shouldBlock: "git push origin feature:main" from a non-main checkout is out of scope -> no block', () => {
  // The checked-out branch decides, not the push refspec target.
  const { block } = shouldBlock({
    command: 'git push origin feature:main',
    branch: 'feature',
    headVersion: '1.0.0',
    originVersion: '1.0.0',
  });
  assert.equal(block, false);
});

test('shouldBlock: missing headVersion/originVersion -> no block (cannot determine bump state)', () => {
  assert.equal(shouldBlock({ command: 'git push', branch: 'main' }).block, false);
  assert.equal(
    shouldBlock({ command: 'git push', branch: 'main', headVersion: '1.0.0' }).block,
    false,
  );
  assert.equal(
    shouldBlock({ command: 'git push', branch: 'main', originVersion: '1.0.0' }).block,
    false,
  );
});

test('shouldBlock: a command that merely contains "push" as a substring does not false-positive', () => {
  const { block } = shouldBlock({
    command: 'echo gitpush',
    branch: 'main',
    headVersion: '1.0.0',
    originVersion: '1.0.0',
  });
  assert.equal(block, false);
});

// ---------------------------------------------------------------------------
// Spawned-process tests — fixture git repos, stdin fixtures, exit codes.
// ---------------------------------------------------------------------------

function run(input, cwd) {
  return spawnSync(process.execPath, [hook], { input, cwd, encoding: 'utf8' });
}

function sh(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function writePluginJson(dir, version) {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'demo', version }, null, 2) + '\n',
  );
}

// Builds a temp git repo with a committed origin/main ref (faked via
// `update-ref`, no real remote needed) and, optionally, a local HEAD that has
// since moved (bumped version) and/or checked out a different branch.
function makeGitFixture({ headVersion = '1.0.0', originVersion = headVersion, branch = 'main' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'steepy-push-guard-'));
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.email', 'test@example.com']);
  sh(dir, ['config', 'user.name', 'Test']);

  writePluginJson(dir, originVersion);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'origin state']);
  sh(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

  if (headVersion !== originVersion) {
    writePluginJson(dir, headVersion);
    sh(dir, ['add', '-A']);
    sh(dir, ['commit', '-q', '-m', 'local bump']);
  }

  if (branch !== 'main') {
    sh(dir, ['checkout', '-q', '-b', branch]);
  }

  return dir;
}

const pushInput = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push' } });

test('spawned: git push on main, unbumped -> exit 2, reason on stderr, nothing on stdout', () => {
  const dir = makeGitFixture({ headVersion: '1.0.0', originVersion: '1.0.0' });
  try {
    const r = run(pushInput, dir);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /bump/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawned: git push on main, already bumped -> exit 0', () => {
  const dir = makeGitFixture({ headVersion: '1.0.1', originVersion: '1.0.0' });
  try {
    const r = run(pushInput, dir);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawned: downgrade and known malformed versions cannot pass the main push guard', () => {
  for (const [headVersion, originVersion] of [['1.2.9', '1.2.10'], ['01.2.4', '1.2.3'], [42, '1.2.3']]) {
    const dir = makeGitFixture({ headVersion, originVersion });
    try {
      const result = run(pushInput, dir);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /downgrade|invalid/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('spawned: git push on a feature branch, unbumped -> exit 0', () => {
  const dir = makeGitFixture({ branch: 'feature/x' });
  try {
    const r = run(pushInput, dir);
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawned: non-push Bash command on main, unbumped -> exit 0', () => {
  const dir = makeGitFixture();
  try {
    const r = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' } }), dir);
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawned: non-Bash tool call -> exit 0', () => {
  const dir = makeGitFixture();
  try {
    const r = run(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'foo.md' } }), dir);
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawned: malformed JSON stdin -> exit 0 (fail-open)', () => {
  const dir = makeGitFixture();
  try {
    const r = run('{not valid json', dir);
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawned: empty stdin -> exit 0 (fail-open)', () => {
  const dir = makeGitFixture();
  try {
    const r = run('', dir);
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawned: missing origin/main ref -> exit 0 (fail-open)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'steepy-push-guard-noorigin-'));
  try {
    sh(dir, ['init', '-q', '-b', 'main']);
    sh(dir, ['config', 'user.email', 'test@example.com']);
    sh(dir, ['config', 'user.name', 'Test']);
    writePluginJson(dir, '1.0.0');
    sh(dir, ['add', '-A']);
    sh(dir, ['commit', '-q', '-m', 'init']);
    const r = run(pushInput, dir);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '', 'a failing "git show origin/main:..." must not leak "fatal: ..." onto the hook stderr');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawned: unreadable/missing local plugin.json -> exit 0 (fail-open)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'steepy-push-guard-noplugin-'));
  try {
    sh(dir, ['init', '-q', '-b', 'main']);
    sh(dir, ['config', 'user.email', 'test@example.com']);
    sh(dir, ['config', 'user.name', 'Test']);
    writeFileSync(join(dir, 'README.md'), 'placeholder\n');
    sh(dir, ['add', '-A']);
    sh(dir, ['commit', '-q', '-m', 'init']);
    sh(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const r = run(pushInput, dir);
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawned: not a git repo at all -> exit 0 (fail-open), no raw git error on stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'steepy-push-guard-nogit-'));
  try {
    const r = run(pushInput, dir);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '', 'a failing internal git call must not leak "fatal: ..." onto the hook stderr');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawned: non-push Bash command from a cwd that is not a git repo -> exit 0, empty stderr, no git I/O attempted', () => {
  // Regression: main() used to do git/file I/O (rev-parse, plugin.json read, git show) on
  // EVERY Bash call before checking whether the command was a push at all. Two costs: (1)
  // wasted subprocess spawns on the common non-push path, and (2) execFileSync's sync exec
  // methods inherit stderr from the parent by default, so a failing `git rev-parse` in a
  // non-repo cwd printed a raw `fatal: not a git repository ...` line on THIS hook's
  // stderr for every unrelated Bash call (e.g. `ls`, `npm test`) — even though the exit
  // code stayed a fail-open 0. The push-detection check must happen first, before any I/O.
  const dir = mkdtempSync(join(tmpdir(), 'steepy-push-guard-nonpush-nogit-'));
  try {
    const r = run(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' } }),
      dir,
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '', 'a non-push command must exit before touching git at all, so no git error can leak');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Doc-lock: .claude/settings.json registers the hook; hooks/hooks.json (which
// ships to plugin users) must stay untouched.
// ---------------------------------------------------------------------------

test('.claude/settings.json registers a PreToolUse Bash hook pointing at push-version-guard.mjs', () => {
  const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
  const preToolUse = settings.hooks.PreToolUse;
  assert.ok(Array.isArray(preToolUse) && preToolUse.length >= 1);
  const bashEntry = preToolUse.find((entry) => entry.matcher === 'Bash');
  assert.ok(bashEntry, 'a Bash-matcher PreToolUse entry must exist');
  const commands = bashEntry.hooks.map((h) => h.command);
  assert.ok(
    commands.some((c) => c.includes('push-version-guard.mjs')),
    'PreToolUse Bash hook must reference push-version-guard.mjs',
  );
});

test('hooks/hooks.json (shipped to plugin users) does not reference push-version-guard.mjs', () => {
  const hooksJson = readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8');
  assert.doesNotMatch(hooksJson, /push-version-guard/);
});

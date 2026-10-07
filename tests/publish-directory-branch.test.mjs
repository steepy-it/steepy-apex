import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIRECTORY_DENYLIST,
  directoryCommitMessage,
  directoryPaths,
} from '../scripts/publish-directory-branch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'scripts', 'publish-directory-branch.mjs');
const BRANCH = 'claude-directory';
const SHA = 'a'.repeat(40);

// The five fixture paths the denylist must drop, written out literally so the
// expectation never depends on the code under test.
const DENYLISTED_FIXTURE_PATHS = [
  'tests/a.test.mjs',
  'tests/fixtures/f.txt',
  '.github/workflows/release.yml',
  '.codex-plugin/plugin.json',
  'CLAUDE.md',
];

function hermeticEnv(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Steepy Test',
    GIT_COMMITTER_NAME: 'Steepy Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'steepy-directory-'));
  try {
    const env = hermeticEnv(root);
    const remote = join(root, 'remote.git');
    const work = join(root, 'work');

    const git = (dir, ...args) => {
      const result = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
      assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
      return result.stdout.trim();
    };
    const remoteHead = (branch) => {
      const result = spawnSync(
        'git',
        [`--git-dir=${remote}`, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
        { cwd: root, env, encoding: 'utf8' },
      );
      return result.status === 0 ? result.stdout.trim() : null;
    };
    const treePaths = (rev) => git(work, 'ls-tree', '-r', '-z', '--name-only', rev).split('\0').filter(Boolean);
    const write = (path, content) => {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), content);
    };
    const commitVersion = (version) => {
      write('.claude-plugin/plugin.json', JSON.stringify({ name: 'fixture', version }));
      git(work, 'add', '.claude-plugin/plugin.json');
      git(work, 'commit', '-q', '-m', `v${version} - payload`);
      return git(work, 'rev-parse', 'HEAD');
    };
    const run = (args, extraEnv = {}) => spawnSync(process.execPath, [script, ...args], {
      cwd: work,
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
    });

    git(root, 'init', '-q', '--bare', 'remote.git');
    git(root, 'init', '-q', '-b', 'main', 'work');
    write('.claude-plugin/plugin.json', '{"name":"fixture","version":"1.0.0"}');
    write('README.md', '# fixture\n');
    write('scripts/tool.mjs', 'export const tool = 1;\n');
    write('assets/blob.bin', Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]));
    write('docs/tests/keep.md', 'nested tests namesake\n');
    write('docs/CLAUDE.md', 'nested CLAUDE namesake\n');
    write('tests-extra/keep.md', 'prefix namesake\n');
    write('CLAUDE.md.bak', 'suffix namesake\n');
    write('tests/a.test.mjs', 'denylisted\n');
    write('tests/fixtures/f.txt', 'denylisted\n');
    write('.github/workflows/release.yml', 'denylisted\n');
    write('.codex-plugin/plugin.json', '{"name":"fixture"}\n');
    write('CLAUDE.md', 'denylisted\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'v1.0.0 - first payload');
    git(work, 'remote', 'add', 'origin', remote);

    return { root, env, remote, work, git, remoteHead, treePaths, write, commitVersion, run };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function withFixture(body) {
  const fixture = makeFixture();
  try {
    body(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function publish(fixture) {
  const result = fixture.run(['--push']);
  assert.equal(result.status, 0, result.stderr);
  const head = fixture.remoteHead(BRANCH);
  assert.ok(head, 'the directory branch must exist after a publish');
  return head;
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

// ---------------------------------------------------------------------------
// Pure exports
// ---------------------------------------------------------------------------

test('DIRECTORY_DENYLIST is the frozen root-anchored denylist', () => {
  assert.deepEqual(DIRECTORY_DENYLIST, ['tests/', '.github/', '.codex-plugin/', 'CLAUDE.md']);
  assert.ok(Object.isFrozen(DIRECTORY_DENYLIST));
});

test('directoryPaths drops only root-anchored denylist matches and keeps input order', () => {
  const input = [
    'docs/tests/a',
    'tests/a',
    'docs/CLAUDE.md',
    '.github/workflows/r.yml',
    'tests-extra/a',
    'tests/x/y',
    'CLAUDE.md.bak',
    '.codex-plugin/plugin.json',
    '.githubx/a',
    'CLAUDE.md',
  ];
  assert.deepEqual(directoryPaths(input), [
    'docs/tests/a',
    'docs/CLAUDE.md',
    'tests-extra/a',
    'CLAUDE.md.bak',
    '.githubx/a',
  ]);
});

test('directoryCommitMessage carries the source subject and a Source-Commit trailer', () => {
  assert.equal(directoryCommitMessage('v1.2.0 - x', SHA), `v1.2.0 - x\n\nSource-Commit: ${SHA}\n`);
  assert.equal(directoryCommitMessage('  first line  \nsecond line', SHA), `first line\n\nSource-Commit: ${SHA}\n`);
  assert.equal(directoryCommitMessage('   ', SHA), `Claude directory payload\n\nSource-Commit: ${SHA}\n`);
  const sha256Name = 'b'.repeat(64);
  assert.equal(directoryCommitMessage('s', sha256Name), `s\n\nSource-Commit: ${sha256Name}\n`);
});

test('directoryCommitMessage rejects a non-hex, short or malformed source SHA', () => {
  for (const bad of ['z'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), `${SHA}\n`, '']) {
    assert.throws(() => directoryCommitMessage('v1.2.0 - x', bad), Error, `must reject ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// CLI against a local bare remote
// ---------------------------------------------------------------------------

test('first publish makes a root commit of the source tree minus the denylist, leaving tree and index untouched', () => {
  withFixture((fx) => {
    const sourceSha = fx.git(fx.work, 'rev-parse', 'HEAD');
    fx.write('README.md', '# fixture\nunstaged edit\n');
    fx.write('scripts/tool.mjs', 'export const tool = 2;\n');
    fx.git(fx.work, 'add', 'scripts/tool.mjs');
    fx.write('scratch.txt', 'untracked\n');

    const statusArgs = ['status', '--porcelain=v1', '-z', '--untracked-files=all'];
    const indexPath = join(fx.work, '.git', 'index');
    const statusBefore = fx.git(fx.work, ...statusArgs);
    const indexBefore = sha256(indexPath);
    const readmeBefore = readFileSync(join(fx.work, 'README.md'));
    const scriptTmp = join(fx.root, 'tmp');
    mkdirSync(scriptTmp);

    const result = fx.run(['--push'], { TMPDIR: scriptTmp });

    const indexAfter = sha256(indexPath);
    const statusAfter = fx.git(fx.work, ...statusArgs);
    assert.equal(result.status, 0, result.stderr);
    const head = fx.remoteHead(BRANCH);
    assert.ok(head, 'the directory branch must exist');
    assert.match(result.stdout, new RegExp(`published 1\\.0\\.0 to ${BRANCH} as ${head} \\(8 paths\\)`));

    assert.equal(fx.git(fx.work, 'rev-list', '--parents', '-n', '1', head).split(' ').length, 1, 'root commit');

    const sourcePaths = fx.treePaths('HEAD');
    for (const path of DENYLISTED_FIXTURE_PATHS) assert.ok(sourcePaths.includes(path), `fixture must track ${path}`);
    assert.deepEqual(fx.treePaths(head), sourcePaths.filter((path) => !DENYLISTED_FIXTURE_PATHS.includes(path)));

    const entries = (rev) => fx.git(fx.work, 'ls-tree', '-r', '-z', rev).split('\0').filter(Boolean);
    assert.deepEqual(
      entries(head),
      entries('HEAD').filter((entry) => !DENYLISTED_FIXTURE_PATHS.includes(entry.split('\t')[1])),
      'kept entries carry the source modes and blobs byte for byte',
    );
    assert.equal(fx.git(fx.work, 'rev-parse', `${head}:README.md`), fx.git(fx.work, 'rev-parse', 'HEAD:README.md'));
    assert.equal(fx.git(fx.work, 'rev-parse', `${head}:scripts/tool.mjs`), fx.git(fx.work, 'rev-parse', 'HEAD:scripts/tool.mjs'));

    const message = fx.git(fx.work, 'log', '-1', '--format=%B', head);
    assert.equal(message.split('\n')[0], 'v1.0.0 - first payload');
    assert.ok(message.includes(`Source-Commit: ${sourceSha}`));

    assert.equal(indexAfter, indexBefore, 'the real index is untouched');
    assert.equal(statusAfter, statusBefore, 'the checkout status is untouched');
    assert.ok(readFileSync(join(fx.work, 'README.md')).equals(readmeBefore), 'the working tree is untouched');
    assert.deepEqual(readdirSync(scriptTmp), [], 'the temporary index directory is removed');
  });
});

test('build without --push reports the commit and pushes nothing', () => {
  withFixture((fx) => {
    const result = fx.run([]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      new RegExp(`built [0-9a-f]{40} for ${BRANCH} \\(1\\.0\\.0, 8 paths, parent none\\); not pushed`),
    );
    assert.equal(fx.remoteHead(BRANCH), null);
  });
});

test('next version appends a commit parented on the previous payload commit', () => {
  withFixture((fx) => {
    const previous = publish(fx);
    fx.commitVersion('1.1.0');

    const built = fx.run([]);
    assert.equal(built.status, 0, built.stderr);
    assert.match(built.stdout, new RegExp(`\\(1\\.1\\.0, 8 paths, parent ${previous}\\); not pushed`));
    assert.equal(fx.remoteHead(BRANCH), previous, 'a build without --push leaves the remote alone');

    const result = fx.run(['--push']);
    assert.equal(result.status, 0, result.stderr);
    const next = fx.remoteHead(BRANCH);
    assert.notEqual(next, previous);
    assert.equal(fx.git(fx.work, 'rev-parse', `${next}^`), previous);
    assert.equal(JSON.parse(fx.git(fx.work, 'show', `${next}:.claude-plugin/plugin.json`)).version, '1.1.0');
    assert.equal(fx.git(fx.work, 'log', '-1', '--format=%s', next), 'v1.1.0 - payload');
  });
});

test('same version is skipped with and without --push', () => {
  withFixture((fx) => {
    const head = publish(fx);
    for (const args of [['--push'], []]) {
      const result = fx.run(args);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /nothing to publish/);
      assert.equal(fx.remoteHead(BRANCH), head);
    }
  });
});

test('lower version is refused', () => {
  withFixture((fx) => {
    fx.commitVersion('1.1.0');
    const head = publish(fx);
    fx.commitVersion('1.0.5');
    const result = fx.run(['--push']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refus/i);
    assert.equal(fx.remoteHead(BRANCH), head);
  });
});

test('a remote that moves before the push fails and is never forced', () => {
  withFixture((fx) => {
    const head = publish(fx);
    fx.commitVersion('1.1.0');
    const moved = fx.git(fx.root, `--git-dir=${fx.remote}`, 'commit-tree', `${head}^{tree}`, '-m', 'moved');

    const realGit = spawnSync('sh', ['-c', 'command -v git'], { env: fx.env, encoding: 'utf8' }).stdout.trim();
    assert.ok(realGit, 'git must be on PATH');
    const shimDir = join(fx.root, 'shim');
    mkdirSync(shimDir);
    const shim = join(shimDir, 'git');
    writeFileSync(shim, [
      '#!/bin/sh',
      'if [ "$1" = push ] && [ -n "$STEEPY_TEST_MOVE_TO" ]; then',
      '  "$STEEPY_TEST_REAL_GIT" --git-dir="$STEEPY_TEST_REMOTE" update-ref refs/heads/claude-directory "$STEEPY_TEST_MOVE_TO" || exit 99',
      'fi',
      'exec "$STEEPY_TEST_REAL_GIT" "$@"',
      '',
    ].join('\n'));
    chmodSync(shim, 0o755);

    const result = fx.run(['--push'], {
      PATH: `${shimDir}${delimiter}${fx.env.PATH}`,
      STEEPY_TEST_MOVE_TO: moved,
      STEEPY_TEST_REAL_GIT: realGit,
      STEEPY_TEST_REMOTE: fx.remote,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not forcing/);
    assert.equal(fx.remoteHead(BRANCH), moved, 'the moved remote head is neither overwritten nor reverted');
  });
});

test('a network remote is refused before any connection with bounded diagnostics', () => {
  withFixture((fx) => {
    fx.git(fx.work, 'remote', 'set-url', 'origin', 'https://user:secret-value@example.invalid/x.git');
    const result = fx.run(['--push']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^steepy publish-directory-branch: [^\n]*\n$/, 'one fixed diagnostic line, no Git output');
    assert.ok(!result.stderr.includes('secret-value'), 'stderr must not echo the credential');
    assert.ok(!result.stderr.includes('example.invalid'), 'stderr must not echo the remote host');
    assert.ok(Buffer.byteLength(result.stderr) <= 400, `stderr too long: ${Buffer.byteLength(result.stderr)} bytes`);
  });
});

test('usage errors exit 2 and an unknown source exits 1 without creating the branch', () => {
  withFixture((fx) => {
    for (const args of [
      ['--bogus'],
      ['positional'],
      ['--branch', 'bad..name'],
      ['--source', '-x'],
      ['--source=-x'],
      ['--branch=-x'],
    ]) {
      const result = fx.run(args);
      assert.equal(result.status, 2, `${JSON.stringify(args)} must be a usage error: ${result.stderr}`);
      assert.match(result.stderr, /^steepy publish-directory-branch: /);
    }
    const unknown = fx.run(['--source', 'no-such-rev', '--push']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /^steepy publish-directory-branch: /);
    assert.equal(fx.remoteHead(BRANCH), null);
  });
});

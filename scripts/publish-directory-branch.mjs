#!/usr/bin/env node
// Builds the Claude directory payload: one commit whose tree is a source commit's tracked
// tree minus the root-anchored DIRECTORY_DENYLIST. The tree is assembled in a temporary
// index, so the working tree and the real index are never touched, and file content is
// never rewritten.
//
// Contract: the directory branch is append-only and is never force-pushed. A version the
// branch already carries is skipped, a lower one is refused, and each new commit is
// parented on the previous payload commit with a `Source-Commit` trailer. If the remote
// moves before the push, the plain push is rejected and this script stops; it never
// retries with force. Diagnostics are fixed strings: Git's own error output, the remote
// location and environment values are never echoed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { compareVersions, parseVersion } from './version-policy.mjs';

const PREFIX = 'steepy publish-directory-branch: ';
const USAGE = 'usage: node scripts/publish-directory-branch.mjs [--source <commit>] [--branch <name>] [--push]';
const MANIFEST = '.claude-plugin/plugin.json';
const OBJECT_NAME_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

// Root-anchored: an entry ending in `/` drops that top-level directory, any other entry
// drops exactly that root file. Nested namesakes such as `docs/tests/` survive.
export const DIRECTORY_DENYLIST = Object.freeze(['tests/', '.github/', '.codex-plugin/', 'CLAUDE.md']);

export function directoryPaths(paths) {
  return paths.filter(
    (path) => !DIRECTORY_DENYLIST.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry)),
  );
}

export function directoryCommitMessage(sourceSubject, sourceSha) {
  if (typeof sourceSha !== 'string' || !OBJECT_NAME_RE.test(sourceSha)) {
    throw new TypeError('source commit must be a full lowercase hexadecimal object name');
  }
  const firstLine = typeof sourceSubject === 'string' ? sourceSubject.split('\n')[0].trim() : '';
  const subject = firstLine || 'Claude directory payload';
  return `${subject}\n\nSource-Commit: ${sourceSha}\n`;
}

class PublishError extends Error {}

// The subcommand is always the first argument (no `-C` or other global flags), and the
// output stays piped so Git's stderr never reaches ours.
function runGit(subcommand, args, { cwd, env = process.env, input } = {}) {
  return spawnSync('git', [subcommand, ...args], {
    cwd,
    encoding: 'utf8',
    env,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function git(subcommand, args, options) {
  const result = runGit(subcommand, args, options);
  if (result.error || result.status !== 0) {
    throw new PublishError(`git ${subcommand} failed (exit ${result.status ?? 'none'})`);
  }
  return result.stdout;
}

const nulSplit = (output) => output.split('\0').filter(Boolean);

function sameSet(left, right) {
  const set = new Set(left);
  return set.size === new Set(right).size && right.every((item) => set.has(item));
}

function manifestVersion(rev, label, at) {
  try {
    const version = JSON.parse(git('show', [`${rev}:${MANIFEST}`], at)).version;
    parseVersion(version);
    return version;
  } catch {
    throw new PublishError(`${label} ${MANIFEST} does not carry a canonical X.Y.Z version`);
  }
}

function remoteHead(branch, at) {
  const listed = runGit('ls-remote', ['--exit-code', 'origin', `refs/heads/${branch}`], at);
  if (listed.error || (listed.status !== 0 && listed.status !== 2)) {
    throw new PublishError(`git ls-remote failed (exit ${listed.status ?? 'none'})`);
  }
  if (listed.status === 2) return null;
  git('fetch', ['--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], at);
  return git('rev-parse', ['--verify', `refs/remotes/origin/${branch}^{commit}`], at).trim();
}

// Filters the source tree through a throwaway index file: `read-tree`, `update-index` and
// `write-tree` only ever see GIT_INDEX_FILE, which lives in its own temporary directory.
function buildTree(sha, at) {
  const tmp = mkdtempSync(join(tmpdir(), 'steepy-directory-index-'));
  try {
    const scratch = { ...at, env: { ...process.env, GIT_INDEX_FILE: join(tmp, 'index') } };
    git('read-tree', [sha], scratch);
    const all = nulSplit(git('ls-tree', ['-r', '-z', '--full-tree', '--name-only', sha], at));
    const keep = directoryPaths(all);
    const kept = new Set(keep);
    const removed = all.filter((path) => !kept.has(path));
    if (removed.length > 0) {
      git('update-index', ['-z', '--force-remove', '--stdin'], { ...scratch, input: `${removed.join('\0')}\0` });
    }
    const tree = git('write-tree', [], scratch).trim();
    if (!sameSet(nulSplit(git('ls-tree', ['-r', '-z', '--name-only', tree], at)), keep)) {
      throw new PublishError('payload tree does not match the filtered source paths');
    }
    return { tree, keep };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function publishDirectoryBranch({ source, branch, push }) {
  let top;
  try {
    top = git('rev-parse', ['--show-toplevel']).trim();
  } catch {
    throw new PublishError('not inside a Git work tree');
  }
  // `update-index --stdin` paths are relative to the cwd, so every later call runs at the top.
  const at = { cwd: top };
  let sha;
  try {
    sha = git('rev-parse', ['--verify', '--quiet', `${source}^{commit}`], at).trim();
  } catch {
    throw new PublishError('source is not a commit');
  }
  const subject = git('log', ['-1', '--format=%s', sha], at);
  const version = manifestVersion(sha, 'source', at);

  const head = remoteHead(branch, at);
  if (head) {
    const headVersion = manifestVersion(head, branch, at);
    const order = compareVersions(headVersion, version);
    if (order === 0) return `${branch} already carries ${version}; nothing to publish`;
    if (order > 0) {
      throw new PublishError(`refusing: ${branch} carries ${headVersion}, newer than source ${version}`);
    }
  }

  const { tree, keep } = buildTree(sha, at);
  const parent = head ? ['-p', head] : [];
  const commit = git('commit-tree', [tree, ...parent, '-F', '-'], {
    ...at,
    input: directoryCommitMessage(subject, sha),
  }).trim();

  if (!push) {
    return `built ${commit} for ${branch} (${version}, ${keep.length} paths, parent ${head ?? 'none'}); not pushed`;
  }
  // A plain refspec only: the remote accepts it solely as a fast-forward of what we read.
  const pushed = runGit('push', ['--quiet', 'origin', `${commit}:refs/heads/${branch}`], at);
  if (pushed.error || pushed.status !== 0) {
    throw new PublishError(`push to ${branch} was rejected or failed; the remote may have moved; not forcing`);
  }
  return `published ${version} to ${branch} as ${commit} (${keep.length} paths)`;
}

// Thin CLI. Exit codes: 0 published, built or skipped; 1 refusal or Git failure; 2 usage.
export function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        source: { type: 'string', default: 'HEAD' },
        branch: { type: 'string', default: 'claude-directory' },
        push: { type: 'boolean', default: false },
      },
    }));
  } catch {
    console.error(PREFIX + USAGE);
    return 2;
  }
  const { source, branch, push } = values;
  if (source.startsWith('-') || branch.startsWith('-')) {
    console.error(`${PREFIX}--source and --branch values must not start with "-"`);
    return 2;
  }
  if (runGit('check-ref-format', [`refs/heads/${branch}`]).status !== 0) {
    console.error(`${PREFIX}--branch is not a valid branch name`);
    return 2;
  }

  try {
    console.log(PREFIX + publishDirectoryBranch({ source, branch, push }));
    return 0;
  } catch (error) {
    console.error(PREFIX + (error instanceof PublishError ? error.message : 'unexpected failure'));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());

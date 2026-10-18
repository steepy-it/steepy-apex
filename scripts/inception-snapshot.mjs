// Full application observations. Local workflow/Git areas are bound before traversal;
// evidence is consumed separately through exact references, never discovered here.
// The walk and Git status share one excluded set, computed once per observation:
// reserved areas, recognized scaffold lease directories, and the exclusions in force
// (the start exclusions before approval, the approved contract's after).
// Structurally recognized lease directories, live or dead, are excluded by exact path
// for every observer; every other lock-like path remains inventory. Recognition runs
// once before the walk and again after it: any change is a transient refusal.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { validatePath, validateSnapshotScope, validateGit } from './inception-protocol.mjs';

import { withProjectScaffoldLock, recognizeProjectScaffoldLeases } from './project-scaffold.mjs';
// Serialization only: holding the lease never changes what an observation excludes.
export function withApplicationSnapshotLease(root, action) {
  return withProjectScaffoldLock({ hubRoot: root }, action);
}
const RESERVED = ['.apex/inception', '.apex/work', '.git'];
const absentGit = () => ({ present: false, branch: null, head: null, status: [] });
const identity = stat => `${stat.dev}:${stat.ino}`;
const within = (path, root) => root === '.' || path === root || path.startsWith(`${root}/`);
function statOrNull(path) { try { return fs.lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
// Name the rejected path in a refusal so the user can exclude it; escapes keep it one line.
const named = path => JSON.stringify(path).replace(/[\x7f-\x9f]/gu, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
function excludedPaths(leases, exclusions) {
  return [...new Set([...RESERVED, ...leases.map(lease => lease.name), ...exclusions.map(e => e.path)])].sort();
}
// Inherited pathspec modes would reinterpret or disable the exclude magic.
const PATHSPEC_ENV = ['GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS'];
export function observeSnapshotGit(root, excluded) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of PATHSPEC_ENV) delete env[key];
  // Status of a large untracked tree exceeds the 1 MiB default; match source-observation.mjs.
  const run = args => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env, maxBuffer: 128 * 1024 * 1024 });
  const probe = run(['rev-parse', '--show-toplevel']);
  if (probe.error && probe.error.code !== 'ENOENT') throw probe.error;
  if (probe.status !== 0 || fs.realpathSync(probe.stdout.trim()) !== fs.realpathSync(root)) return absentGit();
  const branch = run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const head = run(['rev-parse', '--verify', '--quiet', 'HEAD']);
  // Submodule work trees are application bytes the inventory already observes; a
  // moved submodule commit still appears.
  const status = run(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=dirty', '--', '.', ...excluded.map(p => `:(exclude,literal)${p}`)]);
  if (status.error || status.status !== 0) throw new Error(`Git provenance observation failed${status.error ? `: ${status.error.code ?? status.error.message}` : ''}`);
  return validateGit({ present: true, branch: branch.status === 0 ? branch.stdout.trim() : null, head: head.status === 0 ? head.stdout.trim() : null, status: status.stdout.split('\0').filter(Boolean).sort() });
}
export function observeApplication(repoRoot, { contract = null, roots = ['.'], exclusions = [], git } = {}) {
  validateSnapshotScope({ roots, exclusions });
  const root = resolve(repoRoot);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('snapshot root must be a physical directory');
  const leases = recognizeProjectScaffoldLeases(root);
  const excluded = excludedPaths(leases, exclusions);
  // Only reserved areas skip physical aliases. A lease directory is excluded by its
  // exact path alone, so a symlink to it anywhere else remains an error.
  const excludedIdentities = new Set();
  for (const path of RESERVED) {
    const absolute = join(root, path);
    if (statOrNull(absolute)) excludedIdentities.add(identity(fs.statSync(absolute)));
  }
  const files = new Map(); const visited = new Set();
  function walk(path) {
    if (excluded.some(p => within(path, p))) return;
    const absolute = path === '.' ? root : join(root, path);
    const stat = fs.lstatSync(absolute);
    // Resolve only for the physical exclusion check; no descendant is enumerated.
    const physical = stat.isSymbolicLink() ? fs.statSync(absolute) : stat;
    if (excludedIdentities.has(identity(physical))) return;
    if (path !== '.') validatePath(path, `application path ${named(path)}`);
    if (stat.isSymbolicLink()) throw new Error(`${path}: symlink is not an application file`);
    if (stat.isDirectory()) {
      if (visited.has(identity(stat))) return;
      visited.add(identity(stat));
      const names = fs.readdirSync(absolute, { encoding: 'buffer' }).map(bytes => {
        try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { throw new Error(`${path}: holds a name that is not valid UTF-8`); }
      }).sort();
      for (const name of names) walk(path === '.' ? name : `${path}/${name}`);
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`${path}: requires an ordinary single-link file`);
    const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (identity(opened) !== identity(stat) || !opened.isFile() || opened.nlink !== 1) throw new Error(`${path}: file identity changed`);
      const hash = createHash('sha256'); const buffer = Buffer.alloc(64 * 1024); let bytes = 0;
      for (;;) { const n = fs.readSync(fd, buffer, 0, buffer.length, null); if (!n) break; bytes += n; hash.update(buffer.subarray(0, n)); }
      const end = fs.fstatSync(fd);
      if (end.size !== bytes || end.mtimeMs !== opened.mtimeMs || end.ctimeMs !== opened.ctimeMs) throw new Error(`${path}: changed during observation`);
      files.set(path, { path, mode: opened.mode & 0o7777, bytes, sha256: hash.digest('hex') });
    } finally { fs.closeSync(fd); }
  }
  for (const scope of roots) {
    // Check every scope ancestor before walking so an exact nested root cannot
    // bypass the symlink rejection that a root-wide traversal would enforce.
    // A root that bootstrap has not created yet, or has removed, holds no files.
    const parts = scope.split('/');
    let present = true;
    for (let n = 1; n < parts.length && present; n++) {
      const parent = parts.slice(0, n).join('/');
      const stat = statOrNull(join(root, parent));
      if (stat === null) present = false;
      else if (stat.isSymbolicLink()) throw new Error(`${parent}: symlink scope ancestor`);
    }
    if (present && (scope === '.' || statOrNull(join(root, scope)) !== null)) walk(scope);
  }
  const observedGit = git === undefined ? observeSnapshotGit(root, excluded) : validateGit(git);
  if (JSON.stringify(recognizeProjectScaffoldLeases(root)) !== JSON.stringify(leases)) throw new Error('recognized lease directories changed during observation');
  return { contract, roots: [...roots], exclusions: structuredClone(exclusions), files: [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), git: observedGit };
}
export function applicationIdentity(snapshot) {
  return createHash('sha256').update(JSON.stringify({ roots: snapshot.roots, exclusions: snapshot.exclusions, files: snapshot.files })).digest('hex');
}
export function applicationChanges(before, after) {
  const old = new Map(before.files.map(f => [f.path, f])); const next = new Map(after.files.map(f => [f.path, f]));
  return [...new Set([...old.keys(), ...next.keys()])].sort().filter(path => JSON.stringify(old.get(path)) !== JSON.stringify(next.get(path))).map(path => ({ path, before: old.get(path) ?? null, after: next.get(path) ?? null }));
}

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digestPattern = /^[a-f0-9]{64}$/;
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !equal(Object.keys(value).sort(), [...expected].sort())) throw new Error('invalid source observation schema');
}
// Git paths are literal UTF-8 strings. Reject undecodable filenames instead of
// silently merging two byte identities through replacement characters.
function decode(value) { return new TextDecoder('utf-8', { fatal: true }).decode(value); }
export function assertSourcePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.startsWith('/')
    || !equal(decode(Buffer.from(path)), path)
    || path.split('/').some((part) => !part || part === '.' || part === '..')
    || path === '.git' || path.startsWith('.git/')) throw new Error('invalid literal source path');
  return path;
}
const included = (path) => path !== '.apex/work' && !path.startsWith('.apex/work/');
function git(root, ...args) { return execFileSync('git', args, { cwd: root, maxBuffer: 128 * 1024 * 1024 }); }
function nulRecords(bytes) {
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0) throw new Error('unterminated Git path output');
  return decode(bytes.subarray(0, -1)).split('\0');
}
function metadata(root) {
  const branch = decode(git(root, 'symbolic-ref', '-q', 'HEAD')).trimEnd();
  const head = decode(git(root, 'rev-parse', '--verify', 'HEAD')).trimEnd();
  const tree = nulRecords(git(root, 'ls-tree', '-r', '-z', '--full-tree', 'HEAD')).map((line) => {
    const tab = line.indexOf('\t');
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]+)$/.exec(line.slice(0, tab));
    if (!match || tab < 0) throw new Error('invalid Git tree record');
    return { path: assertSourcePath(line.slice(tab + 1)), mode: match[1], oid: match[3] };
  }).filter((entry) => included(entry.path));
  const index = nulRecords(git(root, 'ls-files', '--stage', '-z')).map((line) => {
    const tab = line.indexOf('\t');
    const match = /^(\d{6}) ([a-f0-9]+) ([0-3])$/.exec(line.slice(0, tab));
    if (!match || tab < 0) throw new Error('invalid Git index record');
    return { path: assertSourcePath(line.slice(tab + 1)), mode: match[1], oid: match[2], stage: Number(match[3]) };
  }).filter((entry) => included(entry.path));
  const flags = new Map(nulRecords(git(root, 'ls-files', '-v', '-z')).map((line) => [assertSourcePath(line.slice(2)), line[0]]));
  for (const entry of index) entry.flag = flags.get(entry.path);
  const untracked = nulRecords(git(root, 'ls-files', '--others', '--exclude-standard', '-z')).map(assertSourcePath).filter(included);
  return { branch, head, tree, index, untracked };
}
function identity(stat) { return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; }
function workIdentity(root, path) {
  const parts = path.split('/');
  const parents = [];
  for (let i = 0; i < parts.length; i++) {
    const parent = join(root, ...parts.slice(0, i));
    let stat;
    try { stat = lstatSync(parent, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`unsafe source ancestor: ${JSON.stringify(path)}`);
    // HEAD can still name descendants of a directory replaced by an ordinary
    // file. Those descendants are absent; the replacement is observed separately.
    if (stat.isFile()) return null;
    if (!stat.isDirectory()) throw new Error(`unsafe source ancestor: ${JSON.stringify(path)}`);
    parents.push([parent, `${stat.dev}:${stat.ino}`]);
  }
  const target = join(root, path);
  let stat;
  try { stat = lstatSync(target, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (stat.isDirectory()) return null; // A former file replaced by a directory.
  let bytes;
  let kind;
  if (stat.isSymbolicLink()) { kind = 'symlink'; bytes = readlinkSync(target, { encoding: 'buffer' }); }
  else if (stat.isFile()) {
    kind = 'file';
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (identity(fstatSync(fd, { bigint: true })) !== identity(stat)) throw new Error('source file identity changed');
      bytes = readFileSync(fd);
      if (identity(fstatSync(fd, { bigint: true })) !== identity(stat)) throw new Error('source file changed during observation');
    } finally { closeSync(fd); }
  } else throw new Error(`unsupported source type: ${JSON.stringify(path)}`);
  if (identity(lstatSync(target, { bigint: true })) !== identity(stat)) throw new Error('source file changed during observation');
  for (const [parent, bound] of parents) {
    const current = lstatSync(parent, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || `${current.dev}:${current.ino}` !== bound) throw new Error('source parent identity changed');
  }
  return { kind, mode: Number(stat.mode & 0o7777n), size: bytes.length, digest: hash(bytes) };
}

export function validateSourceObservation(value) {
  keys(value, ['version', 'branch', 'head', 'files', 'digest']);
  if (value.version !== 1 || typeof value.branch !== 'string' || !/^refs\/heads\/[^\0\r\n]+$/.test(value.branch)
    || !oidPattern.test(value.head) || !Array.isArray(value.files)) throw new Error('invalid source observation');
  let previous = null;
  const blob = (entry, fields) => {
    keys(entry, fields);
    if (!/^(100644|100755|120000|160000)$/.test(entry.mode) || !oidPattern.test(entry.oid)) throw new Error('invalid source Git identity');
  };
  for (const file of value.files) {
    keys(file, ['path', 'head', 'index', 'work']); assertSourcePath(file.path);
    if (!included(file.path) || previous !== null && previous >= file.path || !Array.isArray(file.index)) throw new Error('invalid source path ordering');
    previous = file.path;
    if (file.head !== null) blob(file.head, ['mode', 'oid']);
    let stage = -1;
    for (const entry of file.index) {
      blob(entry, ['mode', 'oid', 'stage', 'flag']);
      if (!Number.isInteger(entry.stage) || entry.stage < 0 || entry.stage > 3 || entry.stage <= stage || !/^[A-Za-z?]$/.test(entry.flag)) throw new Error('invalid source index stage');
      stage = entry.stage;
    }
    if (file.work !== null) {
      keys(file.work, ['kind', 'mode', 'size', 'digest']);
      if (!['file', 'symlink'].includes(file.work.kind) || !Number.isInteger(file.work.mode) || file.work.mode < 0 || file.work.mode > 0o7777
        || !Number.isSafeInteger(file.work.size) || file.work.size < 0 || !digestPattern.test(file.work.digest)) throw new Error('invalid source work identity');
    }
  }
  const { digest, ...body } = value;
  if (digest !== hash(JSON.stringify(body))) throw new Error('source observation digest mismatch');
  return value;
}

export function observeSource(repoRoot) {
  const root = realpathSync(resolve(repoRoot));
  const before = metadata(root);
  if ([...before.tree, ...before.index].some((entry) => entry.mode === '160000')) throw new Error('source observations do not support Git submodules');
  const tree = new Map(before.tree.map(({ path, ...entry }) => [path, entry]));
  const index = new Map();
  for (const { path, ...entry } of before.index) index.set(path, [...(index.get(path) ?? []), entry]);
  const paths = [...new Set([...tree.keys(), ...index.keys(), ...before.untracked])].sort();
  const body = { version: 1, branch: before.branch, head: before.head,
    files: paths.map((path) => ({ path, head: tree.get(path) ?? null, index: index.get(path) ?? [], work: workIdentity(root, path) })) };
  if (!equal(before, metadata(root))) throw new Error('source Git state changed during observation');
  return validateSourceObservation({ ...body, digest: hash(JSON.stringify(body)) });
}

export function changedSourcePaths(before, after) {
  validateSourceObservation(before); validateSourceObservation(after);
  const old = new Map(before.files.map((file) => [file.path, file]));
  const current = new Map(after.files.map((file) => [file.path, file]));
  return [...new Set([...old.keys(), ...current.keys()])].sort().filter((path) => !equal(old.get(path), current.get(path)));
}

export function assertSourceContinuation(root, before, after) {
  validateSourceObservation(before); validateSourceObservation(after);
  if (before.branch !== after.branch) throw new Error('source branch changed during task');
  if (before.head !== after.head) {
    try { git(root, 'merge-base', '--is-ancestor', before.head, after.head); }
    catch { throw new Error('source HEAD history is not a continuation of the task baseline'); }
  }
}

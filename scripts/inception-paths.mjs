// Confined access to the local inception area `.apex/inception/`.
//
// The area holds one canonical descriptor (`state.json`), its local ignore
// guard (`.gitignore` = `*\n`, written before anything else), and exact files
// of one declared run under `<run-id>/`. Paths are validated lexically before
// any normalization; physical access binds the admitted `.apex` mount once and
// rejects descendant symlinks, non-ordinary files, and hardlinks, opening
// through verified descriptors whose identity is rechecked. Reads are bounded
// to MAX_INCEPTION_READ_BYTES. Writes are per-file atomic (staged temp, fsync,
// rename), compare the expected previous digest, and are no-ops for identical
// bytes. No directory is enumerated and no reference is followed here.
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as FS,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { bindProjectMount } from './sanitize.mjs';
import { writeAllSync } from './write-all.mjs';

export const INCEPTION_AREA = '.apex/inception';
export const INCEPTION_STATE_PATH = `${INCEPTION_AREA}/state.json`;
export const INCEPTION_GUARD_PATH = `${INCEPTION_AREA}/.gitignore`;
export const INCEPTION_GUARD_CONTENT = '*\n';
export const MAX_INCEPTION_READ_BYTES = 1024 * 1024;

const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CONTROL = /[\x00-\x1F\x7F]/;
const GLOB = /[*?[\]{}]/;
const GUARD_BYTES = Buffer.from(INCEPTION_GUARD_CONTENT, 'utf8');
const NOFOLLOW = FS.O_NOFOLLOW ?? 0;
const NONBLOCK = FS.O_NONBLOCK ?? 0;
const DIRECTORY = FS.O_DIRECTORY ?? 0;

function fail(code, message) {
  const error = new Error(`inception path: ${message}`);
  error.code = code;
  throw error;
}

function freeze(value) {
  return Object.freeze(value);
}

export function isCanonicalRunId(value) {
  return typeof value === 'string' && RUN_ID.test(value);
}

export function isSha256Hex(value) {
  return typeof value === 'string' && SHA256.test(value);
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Lexical validation happens on the raw string, before any path API sees it.
export function classifyInceptionPath(value, options = {}) {
  const runId = options?.runId;
  if (typeof value !== 'string' || value.length === 0) fail('INCEPTION_PATH', 'path must be a non-empty string');
  if (value.length > MAX_PATH_LENGTH) fail('INCEPTION_PATH', 'path is too long');
  if (CONTROL.test(value)) fail('INCEPTION_PATH', 'path contains a control character');
  if (value.includes('\\')) fail('INCEPTION_PATH', 'path contains a backslash');
  if (value.startsWith('/')) fail('INCEPTION_PATH', 'path must be repository-relative');
  if (GLOB.test(value)) fail('INCEPTION_PATH', 'globs are not exact paths');
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment === '') fail('INCEPTION_PATH', 'path contains an empty segment');
    if (segment === '.' || segment === '..') fail('INCEPTION_PATH', `path contains a '${segment}' segment`);
    if (segment.length > MAX_SEGMENT_LENGTH) fail('INCEPTION_PATH', 'path segment is too long');
  }
  if (segments[0] !== '.apex' || segments[1] !== 'inception') {
    fail('INCEPTION_PATH', 'path is outside the .apex/inception area');
  }
  if (value === INCEPTION_STATE_PATH) return freeze({ path: value, kind: 'descriptor', runId: null });
  if (value === INCEPTION_GUARD_PATH) return freeze({ path: value, kind: 'guard', runId: null });
  if (segments.length >= 3 && isCanonicalRunId(segments[2])) {
    if (runId === undefined || runId === null) fail('INCEPTION_PATH', 'run files require a declared run id');
    if (!isCanonicalRunId(runId)) fail('INCEPTION_PATH', 'declared run id is not a canonical lowercase UUID');
    if (segments[2] !== runId) fail('INCEPTION_PATH', 'path belongs to a run other than the declared run');
    if (segments.length === 3) fail('INCEPTION_PATH', 'path is the run directory, not an exact run file');
    for (const segment of segments.slice(3)) {
      if (!RUN_SEGMENT.test(segment)) fail('INCEPTION_PATH', 'path segment contains unsafe characters');
    }
    return freeze({ path: value, kind: 'run-file', runId });
  }
  return fail('INCEPTION_PATH', 'path is not an exact inception file');
}

function statIdentity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

// Size and timestamps make an in-place edit of the same inode observable.
function fileFingerprint(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function lstatOrNull(path, label, code = 'INCEPTION_UNSAFE') {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return fail(code, `cannot inspect ${label} (${error.code ?? 'error'})`);
  }
}

function bindRoot(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    fail('INCEPTION_ROOT', 'repository root must be a non-empty path');
  }
  const parts = sep === '\\' ? repoRoot.split(/[\\/]+/u) : repoRoot.split('/');
  if (parts.includes('..')) fail('INCEPTION_ROOT', 'repository root contains parent traversal');
  const lexical = resolve(repoRoot);
  const stat = lstatOrNull(lexical, 'repository root', 'INCEPTION_ROOT');
  if (stat === null) fail('INCEPTION_ROOT', 'repository root does not exist');
  if (stat.isSymbolicLink()) fail('INCEPTION_ROOT', 'repository root is a symlink');
  if (!stat.isDirectory()) fail('INCEPTION_ROOT', 'repository root is not a directory');
  let path;
  try {
    path = realpathSync.native(lexical);
  } catch (error) {
    fail('INCEPTION_ROOT', `repository root is not physically resolvable (${error.code ?? 'error'})`);
  }
  const physical = lstatOrNull(path, 'repository root', 'INCEPTION_ROOT');
  if (physical === null || !physical.isDirectory()) fail('INCEPTION_ROOT', 'repository root changed during binding');
  return { path, identity: statIdentity(physical) };
}

// The exact repository `.apex` entry may be a project mount (relative or
// absolute directory symlink). Its physical target is bound once; everything
// below it must be physical.
function bindApex(root, { create }) {
  let mount;
  try {
    mount = bindProjectMount(root.path, '.apex');
  } catch (error) {
    fail('INCEPTION_UNSAFE', `.apex mount could not be bound safely: ${error.message}`);
  }
  if (mount) return { path: mount.physical, identity: statIdentity(mount.stat), mounted: true };
  const logical = join(root.path, '.apex');
  let stat = lstatOrNull(logical, '.apex');
  if (stat === null) {
    if (!create) return null;
    verifyDirectory(root, '.apex');
    try {
      mkdirSync(logical, { mode: 0o755 });
    } catch (error) {
      if (error.code !== 'EEXIST') fail('INCEPTION_UNSAFE', `cannot create .apex (${error.code ?? 'error'})`);
    }
    stat = lstatOrNull(logical, '.apex');
    if (stat === null) fail('INCEPTION_UNSAFE', '.apex disappeared during creation');
  }
  if (stat.isSymbolicLink()) fail('INCEPTION_UNSAFE', '.apex mount changed during binding');
  if (!stat.isDirectory()) fail('INCEPTION_UNSAFE', '.apex is a non-directory');
  return { path: logical, identity: statIdentity(stat), mounted: false };
}

function verifyDirectory(bound, label) {
  const stat = lstatOrNull(bound.path, label);
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory() || statIdentity(stat) !== bound.identity) {
    fail('INCEPTION_UNSAFE', `directory identity changed for '${label}'`);
  }
}

function assertOrdinary(stat, path) {
  if (stat.isSymbolicLink()) fail('INCEPTION_UNSAFE', `symlink target blocks '${path}'`);
  if (!stat.isFile()) fail('INCEPTION_UNSAFE', `non-file target blocks '${path}'`);
  if (stat.nlink !== 1n) fail('INCEPTION_UNSAFE', `hard-linked target blocks '${path}'`);
}

function createContext(repoRoot, path, { createApex = false, runId } = {}) {
  const classified = classifyInceptionPath(path, { runId });
  const root = bindRoot(repoRoot);
  const apex = bindApex(root, { create: createApex });
  return { classified, path, root, apex, segments: path.split('/').slice(1) };
}

function walk(context) {
  const { apex, path, segments } = context;
  verifyDirectory(apex, '.apex');
  const ancestors = [{ path: apex.path, identity: apex.identity }];
  let cursor = apex.path;
  let missing = false;
  for (const part of segments.slice(0, -1)) {
    cursor = join(cursor, part);
    if (missing) {
      ancestors.push({ path: cursor, identity: null });
      continue;
    }
    const stat = lstatOrNull(cursor, `ancestor of '${path}'`);
    if (stat === null) {
      missing = true;
      ancestors.push({ path: cursor, identity: null });
      continue;
    }
    if (stat.isSymbolicLink()) fail('INCEPTION_UNSAFE', `symlink ancestor blocks '${path}'`);
    if (!stat.isDirectory()) fail('INCEPTION_UNSAFE', `non-directory ancestor blocks '${path}'`);
    ancestors.push({ path: cursor, identity: statIdentity(stat) });
  }
  const target = join(cursor, segments.at(-1));
  const stat = missing ? null : lstatOrNull(target, `'${path}'`);
  if (stat === null) return { target, ancestors, exists: false, fingerprint: null, mode: null, size: 0 };
  assertOrdinary(stat, path);
  return {
    target,
    ancestors,
    exists: true,
    fingerprint: fileFingerprint(stat),
    mode: Number(stat.mode & 0o777n),
    size: Number(stat.size),
  };
}

function stateFingerprint(state) {
  const ancestors = state.ancestors.map((ancestor) => ancestor.identity ?? 'missing').join('|');
  return `${ancestors}::${state.exists ? state.fingerprint : 'absent'}`;
}

function rebind(context, previous, phase) {
  const current = walk(context);
  if (stateFingerprint(current) !== stateFingerprint(previous)) {
    fail('INCEPTION_UNSAFE', `physical identity changed ${phase} for '${context.path}'`);
  }
  return current;
}

function invokeCheckpoint(options, operation, phase, path) {
  options.onCheckpoint?.(freeze({ operation, phase, path }));
}

function readBound(bound, path) {
  if (bound.size > MAX_INCEPTION_READ_BYTES) {
    fail('INCEPTION_TOO_LARGE', `'${path}' exceeds ${MAX_INCEPTION_READ_BYTES} bytes`);
  }
  let fd;
  try {
    fd = openSync(bound.target, FS.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (error) {
    fail('INCEPTION_UNSAFE', `cannot open '${path}' safely (${error.code ?? 'error'})`);
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    assertOrdinary(opened, path);
    if (fileFingerprint(opened) !== bound.fingerprint) {
      fail('INCEPTION_UNSAFE', `target identity changed during open for '${path}'`);
    }
    const chunks = [];
    let total = 0;
    while (total <= MAX_INCEPTION_READ_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_INCEPTION_READ_BYTES + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_INCEPTION_READ_BYTES) {
        fail('INCEPTION_TOO_LARGE', `'${path}' grew beyond ${MAX_INCEPTION_READ_BYTES} bytes`);
      }
      chunks.push(chunk.subarray(0, count));
    }
    const after = lstatOrNull(bound.target, `'${path}'`);
    if (after === null) fail('INCEPTION_UNSAFE', `target identity changed during read for '${path}'`);
    assertOrdinary(after, path);
    if (fileFingerprint(after) !== bound.fingerprint) {
      fail('INCEPTION_UNSAFE', `target identity changed during read for '${path}'`);
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(fd);
  }
}

function parseCommonOptions(options) {
  if (options === null || typeof options !== 'object') fail('INCEPTION_ARGUMENT', 'options must be an object');
  if (options.onCheckpoint !== undefined && typeof options.onCheckpoint !== 'function') {
    fail('INCEPTION_ARGUMENT', 'onCheckpoint must be a function');
  }
  return options;
}

export function readInceptionFile(repoRoot, path, options = {}) {
  parseCommonOptions(options);
  if (options.encoding !== undefined && typeof options.encoding !== 'string') {
    fail('INCEPTION_ARGUMENT', 'encoding must be a string');
  }
  const context = createContext(repoRoot, path, { runId: options.runId });
  if (context.apex === null) fail('INCEPTION_MISSING', `missing inception file '${path}'`);
  const bound = walk(context);
  if (!bound.exists) fail('INCEPTION_MISSING', `missing inception file '${path}'`);
  invokeCheckpoint(options, 'read', 'after-bind', path);
  const current = rebind(context, bound, 'after read checkpoint');
  const bytes = readBound(current, path);
  return options.encoding === undefined ? bytes : bytes.toString(options.encoding);
}

function guardContext(repoRoot, { createApex }) {
  return createContext(repoRoot, INCEPTION_GUARD_PATH, { createApex });
}

// Returns 'missing' | 'exact' | 'foreign'; unsafe physical states throw.
function guardState(context) {
  const bound = walk(context);
  if (!bound.exists) return { state: 'missing', bound };
  const bytes = readBound(bound, INCEPTION_GUARD_PATH);
  return { state: bytes.equals(GUARD_BYTES) ? 'exact' : 'foreign', bound };
}

function requireGuard(repoRoot) {
  const context = guardContext(repoRoot, { createApex: false });
  if (context.apex === null) fail('INCEPTION_UNGUARDED', 'the inception area has no ignore guard yet');
  const { state } = guardState(context);
  if (state === 'missing') fail('INCEPTION_UNGUARDED', 'the inception area has no ignore guard yet');
  if (state === 'foreign') fail('INCEPTION_UNGUARDED', 'the inception ignore guard has unexpected content');
}

function bindCreatedDirectory(path, label) {
  const stat = lstatOrNull(path, label);
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('INCEPTION_UNSAFE', `unsafe directory created for '${label}'`);
  }
  return { path, identity: statIdentity(stat) };
}

function syncDirectory(bound, label) {
  let fd;
  try {
    fd = openSync(bound.path, FS.O_RDONLY | NOFOLLOW | DIRECTORY);
  } catch (error) {
    fail('INCEPTION_UNSAFE', `cannot open directory for '${label}' (${error.code ?? 'error'})`);
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isDirectory() || statIdentity(stat) !== bound.identity) {
      fail('INCEPTION_UNSAFE', `directory identity changed for '${label}'`);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ensureAncestors(bound, path) {
  let created = false;
  for (let index = 1; index < bound.ancestors.length; index += 1) {
    const ancestor = bound.ancestors[index];
    if (ancestor.identity !== null) continue;
    const parent = bound.ancestors[index - 1];
    verifyDirectory(parent, path);
    try {
      mkdirSync(ancestor.path, { mode: 0o755 });
    } catch (error) {
      if (error.code !== 'EEXIST') fail('INCEPTION_UNSAFE', `cannot create a directory for '${path}' (${error.code ?? 'error'})`);
    }
    bound.ancestors[index] = bindCreatedDirectory(ancestor.path, path);
    syncDirectory(parent, path);
    created = true;
  }
  return created;
}

function verifyTargetStillBound(bound, path, phase) {
  const stat = lstatOrNull(bound.target, `'${path}'`);
  if (stat === null) {
    if (!bound.exists) return;
    fail('INCEPTION_UNSAFE', `target identity changed ${phase} for '${path}'`);
  }
  if (!bound.exists) fail('INCEPTION_UNSAFE', `target identity changed ${phase} for '${path}'`);
  assertOrdinary(stat, path);
  if (fileFingerprint(stat) !== bound.fingerprint) {
    fail('INCEPTION_UNSAFE', `target identity changed ${phase} for '${path}'`);
  }
}

function verifyAncestors(bound, path) {
  // Check from the admitted physical mount downwards, stopping before any
  // descendant access if an ancestor has changed.
  for (const ancestor of bound.ancestors) verifyDirectory(ancestor, path);
}

// Stages a sibling temp, fsyncs it, re-verifies all ancestors, the target and
// staged file, then renames. Cleanup requires the original safe ancestor chain.
function publish(context, bound, bytes, mode, options) {
  const { path } = context;
  const parent = bound.ancestors.at(-1);
  const temp = join(
    dirname(bound.target),
    `.${basename(bound.target)}.steepy-inception-${process.pid}-${randomBytes(12).toString('hex')}.tmp`,
  );
  let stagedIdentity = null;
  try {
    verifyAncestors(bound, path);
    const fd = openSync(temp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | NOFOLLOW, mode);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile()) fail('INCEPTION_UNSAFE', `staged temp is not a file for '${path}'`);
      stagedIdentity = statIdentity(opened);
      writeAllSync(fd, bytes);
      fchmodSync(fd, mode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const staged = lstatOrNull(temp, `staged temp for '${path}'`);
    if (staged === null || staged.isSymbolicLink() || !staged.isFile() || staged.nlink !== 1n || statIdentity(staged) !== stagedIdentity) {
      fail('INCEPTION_UNSAFE', `staged temp identity changed for '${path}'`);
    }
    invokeCheckpoint(options, 'write', 'before-publish', path);
    verifyAncestors(bound, path);
    verifyTargetStillBound(bound, path, 'before publish');
    const currentStaged = lstatOrNull(temp, `staged temp for '${path}'`);
    if (currentStaged === null || currentStaged.isSymbolicLink() || !currentStaged.isFile()
      || currentStaged.nlink !== 1n || fileFingerprint(currentStaged) !== fileFingerprint(staged)) {
      fail('INCEPTION_UNSAFE', `staged temp identity changed before publish for '${path}'`);
    }
    renameSync(temp, bound.target);
    const renamed = lstatOrNull(bound.target, `'${path}'`);
    if (renamed === null || renamed.isSymbolicLink() || !renamed.isFile() || statIdentity(renamed) !== stagedIdentity) {
      fail('INCEPTION_UNSAFE', `target identity changed after publish for '${path}'`);
    }
    syncDirectory(parent, path);
  } catch (error) {
    if (stagedIdentity !== null) {
      try {
        verifyAncestors(bound, path);
        const current = lstatSync(temp, { bigint: true });
        if (current.isFile() && current.nlink === 1n && statIdentity(current) === stagedIdentity) unlinkSync(temp);
      } catch {
        // A changed chain leaves residue untouched. Preserve the primary error
        // also when the temp was already published or removed.
      }
    }
    throw error;
  }
}

function contentBytes(content) {
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  if (content instanceof Uint8Array) return Buffer.from(content);
  return fail('INCEPTION_ARGUMENT', 'content must be a string or bytes');
}

// Creates `.apex/` (when absent and not mounted), `.apex/inception/`, and the
// local ignore guard `*\n`. A present guard must match exactly; it is never
// overwritten.
export function ensureInceptionGuard(repoRoot) {
  const context = guardContext(repoRoot, { createApex: true });
  const areaPath = join(context.apex.path, 'inception');
  const area = lstatOrNull(areaPath, INCEPTION_AREA);
  if (area === null) {
    verifyDirectory(context.apex, INCEPTION_AREA);
    try {
      mkdirSync(areaPath, { mode: 0o755 });
    } catch (error) {
      if (error.code !== 'EEXIST') fail('INCEPTION_UNSAFE', `cannot create ${INCEPTION_AREA} (${error.code ?? 'error'})`);
    }
    bindCreatedDirectory(areaPath, INCEPTION_AREA);
    syncDirectory(context.apex, INCEPTION_AREA);
  } else if (area.isSymbolicLink()) {
    fail('INCEPTION_UNSAFE', `symlink ancestor blocks '${INCEPTION_GUARD_PATH}'`);
  } else if (!area.isDirectory()) {
    fail('INCEPTION_UNSAFE', `non-directory ancestor blocks '${INCEPTION_GUARD_PATH}'`);
  }
  const { state, bound } = guardState(context);
  if (state === 'exact') return freeze({ path: INCEPTION_GUARD_PATH, created: false });
  if (state === 'foreign') {
    fail('INCEPTION_UNGUARDED', 'the inception ignore guard has unexpected content; it is never overwritten');
  }
  publish(context, rebind(context, bound, 'before guard staging'), GUARD_BYTES, 0o644, {});
  return freeze({ path: INCEPTION_GUARD_PATH, created: true });
}

export function ensureInceptionRunDirectory(repoRoot, runId) {
  if (!isCanonicalRunId(runId)) fail('INCEPTION_PATH', 'declared run id is not a canonical lowercase UUID');
  requireGuard(repoRoot);
  const context = guardContext(repoRoot, { createApex: false });
  const areaBound = walk(context).ancestors[1];
  const runPath = join(areaBound.path, runId);
  const display = `${INCEPTION_AREA}/${runId}`;
  const stat = lstatOrNull(runPath, display);
  if (stat !== null) {
    if (stat.isSymbolicLink()) fail('INCEPTION_UNSAFE', `symlink run directory blocks '${display}'`);
    if (!stat.isDirectory()) fail('INCEPTION_UNSAFE', `non-directory run entry blocks '${display}'`);
    return freeze({ path: display, created: false });
  }
  verifyDirectory(areaBound, display);
  try {
    mkdirSync(runPath, { mode: 0o755 });
  } catch (error) {
    if (error.code !== 'EEXIST') fail('INCEPTION_UNSAFE', `cannot create '${display}' (${error.code ?? 'error'})`);
  }
  bindCreatedDirectory(runPath, display);
  syncDirectory(areaBound, display);
  return freeze({ path: display, created: true });
}

// Writes the canonical descriptor or an exact run file. `expectedSha256` is
// mandatory: null requires absence (create-only); a digest must match the
// current bytes. Identical bytes return `changed: false` without any write.
export function writeInceptionFile(repoRoot, path, content, options = {}) {
  parseCommonOptions(options);
  if (!Object.hasOwn(options, 'expectedSha256')
    || (options.expectedSha256 !== null && !isSha256Hex(options.expectedSha256))) {
    fail('INCEPTION_ARGUMENT', 'expectedSha256 must be null or a lowercase SHA-256 digest');
  }
  const mode = options.mode ?? 0o644;
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) fail('INCEPTION_ARGUMENT', 'mode must be an integer between 000 and 777');
  const classified = classifyInceptionPath(path, { runId: options.runId });
  if (classified.kind === 'guard') fail('INCEPTION_PATH', 'the ignore guard is written only by ensureInceptionGuard');
  const bytes = contentBytes(content);
  if (bytes.length > MAX_INCEPTION_READ_BYTES) {
    fail('INCEPTION_TOO_LARGE', `content for '${path}' exceeds ${MAX_INCEPTION_READ_BYTES} bytes`);
  }
  requireGuard(repoRoot);
  const context = createContext(repoRoot, path, { runId: options.runId });
  let bound = walk(context);
  const expected = options.expectedSha256;
  if (expected === null && bound.exists) fail('INCEPTION_EXISTS', `'${path}' already exists`);
  if (expected !== null && !bound.exists) fail('INCEPTION_STALE', `'${path}' is absent but a previous digest was expected`);
  const current = bound.exists ? readBound(bound, path) : null;
  if (current !== null && sha256Hex(current) !== expected) {
    fail('INCEPTION_STALE', `'${path}' does not match the expected previous digest`);
  }
  const digest = sha256Hex(bytes);
  if (current !== null && current.equals(bytes)) {
    return freeze({ path, sha256: digest, bytes: bytes.length, changed: false });
  }
  ensureAncestors(bound, path);
  bound = rebind(context, bound, 'before staging');
  invokeCheckpoint(options, 'write', 'after-bind', path);
  bound = rebind(context, bound, 'after write checkpoint');
  publish(context, bound, bytes, bound.exists ? bound.mode : mode, options);
  return freeze({ path, sha256: digest, bytes: bytes.length, changed: true });
}

// Physical metadata only: whether `.apex` and the area exist, and the
// physical area directory (for callers that must run tools inside it).
export function bindInceptionArea(repoRoot) {
  const root = bindRoot(repoRoot);
  const apex = bindApex(root, { create: false });
  if (apex === null) return freeze({ apex: 'missing', area: 'missing', areaPath: null, mounted: false });
  const areaPath = join(apex.path, 'inception');
  const area = lstatOrNull(areaPath, INCEPTION_AREA);
  if (area === null) return freeze({ apex: 'present', area: 'missing', areaPath: null, mounted: apex.mounted });
  if (area.isSymbolicLink()) fail('INCEPTION_UNSAFE', `symlink ancestor blocks '${INCEPTION_AREA}'`);
  if (!area.isDirectory()) fail('INCEPTION_UNSAFE', `non-directory ancestor blocks '${INCEPTION_AREA}'`);
  return freeze({ apex: 'present', area: 'present', areaPath, mounted: apex.mounted });
}

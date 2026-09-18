import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as FS_CONSTANTS,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

const WORK_TYPES = new Set(['spec', 'goal', 'criteria', 'work-output']);
const SEGMENT_CHARS = /^[A-Za-z0-9._-]+$/;
const NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const AGGREGATE_RAW_NAME = /^phase-[1-9]\d*\.log$/;
const ATTEMPT_RAW_NAME = /^phase-[1-9]\d*-attempt-[1-9]\d*(\.log|\.raw\.jsonl)$/;
const MANIFEST_NAME = /^(?:phase-(?:plan|implement|review|[1-9]\d*)-attempt-[1-9]\d*|task-[1-9]\d*-(?:implement|review|fix)(?:-[1-9]\d*)?|final-review)\.json$/;
const FIXED_TASK_FILES = new Map([
  ['autopilot-status.md', 'status'],
  ['resource-usage.jsonl', 'ledger'],
  ['branch-diff.txt', 'diff'],
  ['task-result-index.md', 'task-result-index'],
  ['evidence-report.md', 'evidence'],
  ['review-report.md', 'review-report'],
]);
const FIXED_LOOP_FILES = new Map([
  ['events.jsonl', 'events'],
  ['ledger.md', 'ledger'],
  ['branch-diff.txt', 'diff'],
  ['evidence-report.md', 'evidence'],
  ['review-report.md', 'review-report'],
]);
const LOOP_NAME = /^(\d{4})-(\d{2})-(\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const LOOP_ATTEMPT_FILES = [
  [new RegExp(`^run-${UUID}-attempt-[1-9]\\d*-report\\.md$`), 'runner-report'],
  [new RegExp(`^run-${UUID}-attempt-[1-9]\\d*\\.log$`), 'runner-log'],
  [new RegExp(`^run-${UUID}-attempt-[1-9]\\d*\\.raw\\.jsonl$`), 'runner-raw'],
  [new RegExp(`^run-${UUID}-attempt-[1-9]\\d*-diff\\.txt$`), 'runner-diff'],
  [new RegExp(`^run-${UUID}-review-[1-9]\\d*-report\\.md$`), 'reviewer-report'],
  [new RegExp(`^run-${UUID}-review-[1-9]\\d*\\.log$`), 'reviewer-log'],
  [new RegExp(`^run-${UUID}-review-[1-9]\\d*\\.raw\\.jsonl$`), 'reviewer-raw'],
  [new RegExp(`^run-${UUID}-review-[1-9]\\d*-diff\\.txt$`), 'reviewer-diff'],
];

function fail(message) {
  throw new Error(`work path: ${message}`);
}

function mdStem(fileName) {
  if (!fileName.endsWith('.md') || fileName.length <= '.md'.length) return null;
  return fileName.slice(0, -'.md'.length);
}

function isCanonicalLoopName(value) {
  const match = LOOP_NAME.exec(value);
  if (match === null) return false;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function assertCanonicalRelative(value) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('work path must be a non-empty string');
  }
  if (value.startsWith('/')) {
    fail(`work path must be repo-relative, got absolute '${value}'`);
  }
  if (value.endsWith('/')) {
    fail(`work path must not end with a slash: '${value}'`);
  }
  for (const segment of value.split('/')) {
    if (segment === '') fail(`work path must not contain an empty segment: '${value}'`);
    if (segment === '.' || segment === '..') {
      fail(`work path must not contain a '${segment}' segment: '${value}'`);
    }
    if (!SEGMENT_CHARS.test(segment)) {
      fail(`work path segment contains unsafe characters: '${value}'`);
    }
  }
}

function classifyRest(rest, value) {
  if (rest.length === 2 && rest[0] === 'specs') {
    const stem = mdStem(rest[1]);
    if (stem !== null && NAME_SEGMENT.test(stem)) return { type: 'spec', family: 'spec' };
  }
  if (rest.length === 2 && rest[0] === 'plans') {
    const stem = mdStem(rest[1]);
    if (stem !== null && NAME_SEGMENT.test(stem)) return { type: 'work-output', family: 'plan' };
  }
  if (rest.length >= 2 && rest[0] === 'tasks') {
    if (!NAME_SEGMENT.test(rest[1])) fail(`invalid task run name in '${value}'`);
    if (rest.length === 2) fail(`'${value}' is not a work artifact file`);
    if (rest.length === 3) {
      if (/^task-[1-9]\d*-execution-[1-9]\d*-(?:baseline|capture|result)\.json$/.test(rest[2])) return { type: 'work-output', family: 'task-result' };
      if (/^task-[1-9]\d*-execution-[1-9]\d*-report\.md$/.test(rest[2])) return { type: 'work-output', family: 'task-result-report' };
      if (/^task-[1-9]\d*-report\.md$/.test(rest[2])) return { type: 'work-output', family: 'task-report' };
      if (/^(?:task-[1-9]\d*|final)-review-guard-attempt-[1-9]\d*-iteration-[1-9]\d*-(?:baseline|original|reserved|corrected)\.json$/.test(rest[2])) return { type: 'work-output', family: 'review-guard' };
      if (/^(?:task-[1-9]\d*-(?:review|issues)|final-review(?:-issues)?)\.md$/.test(rest[2])) return { type: 'work-output', family: 'review-artifact' };
      if (rest[2] === 'success-criteria.md') return { type: 'criteria', family: 'criteria' };
      const fixed = FIXED_TASK_FILES.get(rest[2]);
      if (fixed !== undefined) return { type: 'work-output', family: fixed };
      if (AGGREGATE_RAW_NAME.test(rest[2]) || ATTEMPT_RAW_NAME.test(rest[2])) {
        return { type: 'work-output', family: 'raw' };
      }
    }
    if (rest.length === 4 && rest[2] === 'context' && MANIFEST_NAME.test(rest[3])) {
      return { type: 'work-output', family: 'manifest' };
    }
  }
  if (rest.length >= 2 && rest[0] === 'loops') {
    if (!isCanonicalLoopName(rest[1])) fail(`invalid loop run name in '${value}'`);
    if (rest.length === 3) {
      if (rest[2] === 'goal.md') return { type: 'goal', family: 'goal' };
      const fixed = FIXED_LOOP_FILES.get(rest[2]);
      if (fixed !== undefined) return { type: 'work-output', family: fixed };
      for (const [pattern, family] of LOOP_ATTEMPT_FILES) {
        if (pattern.test(rest[2])) return { type: 'work-output', family };
      }
    }
  }
  fail(`unrecognized work artifact '${value}'`);
}

export function classifyWorkPath(value) {
  assertCanonicalRelative(value);
  const segments = value.split('/');
  if (segments[0] !== '.apex' || segments[1] !== 'work') {
    fail(`'${value}' is outside the .apex/work/ contract of this module`);
  }
  const classified = classifyRest(segments.slice(2), value);
  return Object.freeze({ path: value, ...classified });
}

export function parseWorkPath(value, expectType, family) {
  const parsed = classifyWorkPath(value);
  if (expectType !== undefined) {
    if (!WORK_TYPES.has(expectType)) fail(`unknown work path type expectation '${expectType}'`);
    if (parsed.type !== expectType) {
      fail(`'${value}' is a ${parsed.type} path; this call site expects ${expectType}`);
    }
  }
  if (family !== undefined && parsed.family !== family) {
    fail(`'${value}' is a ${parsed.family} artifact; this call site expects ${family}`);
  }
  return parsed;
}

function parseOptions(options, path) {
  if (options === undefined) return {};
  if (options === null || typeof options !== 'object') fail(`options must be an object for '${path}'`);
  if (options.expect !== undefined && !WORK_TYPES.has(options.expect)) {
    fail(`unknown work path type expectation '${options.expect}'`);
  }
  if (options.onCheckpoint !== undefined && typeof options.onCheckpoint !== 'function') {
    fail(`onCheckpoint option must be a function for '${path}'`);
  }
  return options;
}

function invokeCheckpoint(options, operation, phase, path) {
  options.onCheckpoint?.(Object.freeze({ operation, phase, path }));
}

function statIdentity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function assertOrdinaryTarget(stat, path) {
  if (stat.isSymbolicLink()) fail(`symlink target blocks '${path}'`);
  if (!stat.isFile()) fail(`non-file target blocks '${path}'`);
  if (stat.nlink !== 1n) fail(`hard-linked target blocks '${path}'`);
}

function physicalRoot(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    fail('repository root must be a non-empty string');
  }
  let root;
  try {
    root = realpathSync(resolve(repoRoot));
  } catch (error) {
    fail(`repository root is not physically resolvable: ${error.message}`);
  }
  const stat = lstatSync(root, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`repository root is not a physical directory: '${repoRoot}'`);
  }
  return { path: root, identity: statIdentity(stat) };
}

function lstatBound(path, pathLabel) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    fail(`cannot inspect ${pathLabel}: ${error.message}`);
  }
}

function walkWorkTarget(root, path) {
  const target = resolve(root.path, path);
  if (target === root.path || !target.startsWith(`${root.path}${sep}`)) {
    fail(`'${path}' escapes the repository root`);
  }
  const ancestors = [{ path: root.path, identity: root.identity }];
  let cursor = root.path;
  let missing = false;
  for (const part of path.split('/').slice(0, -1)) {
    cursor = join(cursor, part);
    if (missing) {
      ancestors.push({ path: cursor, identity: null });
      continue;
    }
    let stat;
    try {
      stat = lstatSync(cursor, { bigint: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        missing = true;
        ancestors.push({ path: cursor, identity: null });
        continue;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) fail(`symlink ancestor blocks '${path}' at ${cursor}`);
    if (!stat.isDirectory()) fail(`non-directory ancestor blocks '${path}' at ${cursor}`);
    if (realpathSync(cursor) !== cursor) fail(`physical ancestor escape blocks '${path}' at ${cursor}`);
    ancestors.push({ path: cursor, identity: statIdentity(stat) });
  }
  let stat = null;
  try {
    stat = lstatSync(target, { bigint: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (stat === null) {
    return { target, ancestors, exists: false, identity: null, mode: 0o644 };
  }
  assertOrdinaryTarget(stat, path);
  return {
    target,
    ancestors,
    exists: true,
    identity: statIdentity(stat),
    mode: Number(stat.mode & 0o777n),
  };
}

function verifyBoundDirectory(bound, path) {
  const stat = lstatBound(bound.path, `ancestor of '${path}'`);
  if (stat.isSymbolicLink() || !stat.isDirectory() || statIdentity(stat) !== bound.identity) {
    fail(`ancestor identity changed for '${path}' at ${bound.path}`);
  }
}

function openBoundDirectoryFd(bound, path) {
  const fd = openSync(
    bound.path,
    FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW | (FS_CONSTANTS.O_DIRECTORY ?? 0),
  );
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isDirectory() || statIdentity(stat) !== bound.identity) {
      fail(`ancestor identity changed for '${path}' at ${bound.path}`);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function bindCreatedDirectory(dirPath, path) {
  const stat = lstatBound(dirPath, `created ancestor of '${path}'`);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`unsafe ancestor created for '${path}'`);
  if (realpathSync(dirPath) !== dirPath) fail(`physical ancestor escape blocks '${path}' at ${dirPath}`);
  return { path: dirPath, identity: statIdentity(stat) };
}

function ensureAncestorDirs(state, path) {
  let created = false;
  for (let index = 1; index < state.ancestors.length; index += 1) {
    const ancestor = state.ancestors[index];
    if (ancestor.identity !== null) continue;
    verifyBoundDirectory(state.ancestors[index - 1], path);
    try {
      mkdirSync(ancestor.path, { mode: 0o755 });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        fail(`cannot create ancestor directory for '${path}' at ${ancestor.path}: ${error.message}`);
      }
    }
    state.ancestors[index] = bindCreatedDirectory(ancestor.path, path);
    created = true;
  }
  return created;
}

function stateFingerprint(state) {
  const ancestors = state.ancestors.map((ancestor) => ancestor.identity ?? 'missing').join('|');
  return `${ancestors}::${state.exists ? `file:${state.identity}` : 'absent'}`;
}

function verifyBoundState(root, path, bound, phase) {
  const current = walkWorkTarget(root, path);
  if (stateFingerprint(current) !== stateFingerprint(bound)) {
    fail(`physical identity change detected ${phase} for '${path}'`);
  }
  return current;
}

function verifyTargetStillBound(bound, path) {
  let stat;
  try {
    stat = lstatSync(bound.target, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT' && !bound.exists) return;
    fail(`target identity changed for '${path}': ${error.message}`);
  }
  if (!bound.exists) {
    fail(`target identity changed for '${path}'`);
  }
  assertOrdinaryTarget(stat, path);
  if (statIdentity(stat) !== bound.identity) fail(`target identity changed for '${path}'`);
}

function requireExistingAncestors(state, path) {
  for (const ancestor of state.ancestors) {
    if (ancestor.identity === null) fail(`missing ancestor directory for '${path}': ${ancestor.path}`);
  }
}

function contentBytes(content) {
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  if (content instanceof Uint8Array) return Buffer.from(content);
  return fail('content must be a string or Buffer');
}

// Opens a canonical work artifact as a persistent, verified write descriptor.
// Streaming call sites own the returned fd and must close it. `create-new`
// preserves immutable-attempt semantics; `append` creates an absent aggregate
// or ledger once and otherwise appends to the bound single-link ordinary file.
export function openWorkPathFd(repoRoot, path, options = {}) {
  parseOptions(options, path);
  parseWorkPath(path, options.expect, options.family);
  const disposition = options.disposition ?? 'append';
  if (!['append', 'create-new'].includes(disposition)) {
    fail(`unknown work path open disposition '${disposition}'`);
  }
  const mode = options.mode ?? 0o644;
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    fail(`open mode must be an integer between 000 and 777 for '${path}'`);
  }

  const root = physicalRoot(repoRoot);
  let bound = walkWorkTarget(root, path);
  if (ensureAncestorDirs(bound, path)) bound = walkWorkTarget(root, path);
  bound = verifyBoundState(root, path, bound, 'before open');
  invokeCheckpoint(options, 'open', 'after-bind', path);
  bound = verifyBoundState(root, path, bound, 'after open checkpoint');
  if (disposition === 'create-new' && bound.exists) {
    fail(`work artifact already exists: '${path}'`);
  }
  verifyBoundDirectory(bound.ancestors[bound.ancestors.length - 1], path);

  const creating = !bound.exists;
  const flags = FS_CONSTANTS.O_WRONLY
    | FS_CONSTANTS.O_NOFOLLOW
    | (disposition === 'append' ? FS_CONSTANTS.O_APPEND : 0)
    | (creating ? FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL : 0);
  let fd;
  let openedIdentity = null;
  try {
    fd = openSync(bound.target, flags, mode);
    const opened = fstatSync(fd, { bigint: true });
    assertOrdinaryTarget(opened, path);
    openedIdentity = statIdentity(opened);
    if (bound.exists && openedIdentity !== bound.identity) {
      fail(`target identity changed for '${path}'`);
    }
    const published = lstatBound(bound.target, `opened target '${path}'`);
    assertOrdinaryTarget(published, path);
    if (statIdentity(published) !== openedIdentity) {
      fail(`target identity changed for '${path}'`);
    }
    const parent = bound.ancestors[bound.ancestors.length - 1];
    verifyBoundDirectory(parent, path);
    if (creating) {
      const parentFd = openBoundDirectoryFd(parent, path);
      try {
        fsyncSync(parentFd);
      } finally {
        closeSync(parentFd);
      }
    }
    return fd;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (creating && openedIdentity !== null) {
      try {
        const current = lstatSync(bound.target, { bigint: true });
        if (current.isFile() && !current.isSymbolicLink() && statIdentity(current) === openedIdentity) {
          unlinkSync(bound.target);
        }
      } catch {
        // Never replace the primary confinement error with cleanup noise.
      }
    }
    throw error;
  }
}

export function readWorkPath(repoRoot, path, options = {}) {
  parseOptions(options, path);
  parseWorkPath(path, options.expect, options.family);
  if (options.encoding !== undefined && typeof options.encoding !== 'string') {
    fail('encoding option must be a string');
  }
  const root = physicalRoot(repoRoot);
  const bound = walkWorkTarget(root, path);
  requireExistingAncestors(bound, path);
  if (!bound.exists) fail(`missing work artifact '${path}'`);
  invokeCheckpoint(options, 'read', 'after-bind', path);
  verifyBoundState(root, path, bound, 'after read checkpoint');
  const fd = openSync(bound.target, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    assertOrdinaryTarget(opened, path);
    if (statIdentity(opened) !== bound.identity) {
      fail(`target identity changed for '${path}'`);
    }
    const bytes = readFileSync(fd);
    const after = lstatSync(bound.target, { bigint: true });
    assertOrdinaryTarget(after, path);
    if (statIdentity(after) !== bound.identity) {
      fail(`target identity changed for '${path}'`);
    }
    return options.encoding === undefined ? bytes : bytes.toString(options.encoding);
  } finally {
    closeSync(fd);
  }
}

export function writeWorkPath(repoRoot, path, content, options = {}) {
  parseOptions(options, path);
  if (options.createOnly !== undefined && typeof options.createOnly !== 'boolean') fail('createOnly must be boolean');
  parseWorkPath(path, options.expect, options.family);
  const bytes = contentBytes(content);
  const root = physicalRoot(repoRoot);
  let bound = walkWorkTarget(root, path);
  if (options.createOnly && bound.exists) fail(`work artifact already exists '${path}'`);
  if (ensureAncestorDirs(bound, path)) bound = walkWorkTarget(root, path);
  bound = verifyBoundState(root, path, bound, 'before staging');
  invokeCheckpoint(options, 'write', 'after-bind', path);
  bound = verifyBoundState(root, path, bound, 'after write checkpoint');
  const temp = join(
    dirname(bound.target),
    `.${basename(bound.target)}.steepy-work-${process.pid}-${randomBytes(12).toString('hex')}.tmp`,
  );
  let parentFd;
  try {
    verifyTargetStillBound(bound, path);
    const fd = openSync(temp, FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | FS_CONSTANTS.O_NOFOLLOW, bound.mode);
    let stagedIdentity;
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile()) fail(`staged temp is not a file for '${path}'`);
      stagedIdentity = statIdentity(opened);
      writeFileSync(fd, bytes);
      fchmodSync(fd, bound.mode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const staged = lstatSync(temp, { bigint: true });
    if (!staged.isFile() || staged.isSymbolicLink() || statIdentity(staged) !== stagedIdentity) {
      fail(`staged temp identity changed for '${path}'`);
    }
    verifyTargetStillBound(bound, path);
    const parent = bound.ancestors[bound.ancestors.length - 1];
    verifyBoundDirectory(parent, path);
    parentFd = openBoundDirectoryFd(parent, path);
    invokeCheckpoint(options, 'write', 'before-publish', path);
    verifyTargetStillBound(bound, path);
    verifyBoundDirectory(parent, path);
    renameSync(temp, bound.target);
    const renamed = lstatSync(bound.target, { bigint: true });
    assertOrdinaryTarget(renamed, path);
    if (statIdentity(renamed) !== stagedIdentity) {
      fail(`target identity changed after publish for '${path}'`);
    }
    fsyncSync(parentFd);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError;
    }
    throw error;
  } finally {
    if (parentFd !== undefined) closeSync(parentFd);
  }
  return { path, bytes: bytes.length };
}

export function appendWorkPath(repoRoot, path, content, options = {}) {
  parseOptions(options, path);
  parseWorkPath(path, options.expect, options.family);
  const bytes = contentBytes(content);
  const root = physicalRoot(repoRoot);
  const bound = walkWorkTarget(root, path);
  requireExistingAncestors(bound, path);
  if (!bound.exists) fail(`missing work artifact '${path}'`);
  invokeCheckpoint(options, 'append', 'after-bind', path);
  verifyBoundState(root, path, bound, 'after append checkpoint');
  const fd = openSync(bound.target, FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_APPEND | FS_CONSTANTS.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    assertOrdinaryTarget(opened, path);
    if (statIdentity(opened) !== bound.identity) {
      fail(`target identity changed for '${path}'`);
    }
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    const after = lstatSync(bound.target, { bigint: true });
    assertOrdinaryTarget(after, path);
    if (statIdentity(after) !== bound.identity) {
      fail(`target identity changed for '${path}'`);
    }
  } finally {
    closeSync(fd);
  }
  return { path, bytes: bytes.length };
}

export function mkdirWorkPath(repoRoot, path, options = {}) {
  parseOptions(options, path);
  parseWorkPath(path, options.expect, options.family);
  const root = physicalRoot(repoRoot);
  let bound = walkWorkTarget(root, path);
  const created = ensureAncestorDirs(bound, path);
  if (created) bound = walkWorkTarget(root, path);
  verifyBoundState(root, path, bound, 'after directory creation');
  return { path, created };
}

#!/usr/bin/env node
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync,
  openSync, readFileSync, realpathSync, renameSync, unlinkSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEMVER_RE, parseVersion, validateVersionTransition } from './version-policy.mjs';
import { withProjectScaffoldLock } from './project-scaffold.mjs';
import { writeAllSync } from './write-all.mjs';
export { SEMVER_RE } from './version-policy.mjs';

const MANIFEST_FILES = ['package.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json'];
export const TRANSACTION_FILE = '.steepy-version-transaction.json';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const USAGE = 'steepy bump-version: usage: node scripts/bump-version.mjs <patch|minor|major|X.Y.Z> | --check';

// Deliberately narrower than full SemVer; explicit targets must increase.
export function bumpVersion(current, kind) {
  const [major, minor, patch] = parseVersion(current);
  let target;
  if (kind === 'patch') target = major + '.' + minor + '.' + (patch + 1);
  else if (kind === 'minor') target = major + '.' + (minor + 1) + '.0';
  else if (kind === 'major') target = (major + 1) + '.0.0';
  else target = kind;
  validateVersionTransition(target, current);
  return target;
}

function statOrNull(path) {
  try { return lstatSync(path); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function ordinaryParents(path) {
  const parent = dirname(resolve(path));
  if (realpathSync(parent) !== parent) throw new Error('manifest parent must be a physical directory');
}

function sameIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function readOrdinary(path, maxBytes = MAX_MANIFEST_BYTES) {
  ordinaryParents(path);
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error('version transaction requires ordinary single-link files');
  }
  if (before.size > maxBytes) throw new Error('version transaction file exceeds byte limit');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!sameIdentity(before, opened) || !opened.isFile() || opened.nlink !== 1) {
      throw new Error('version file identity changed during read');
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const named = lstatSync(path);
    if (bytes.length > maxBytes || !sameIdentity(opened, named)
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || after.mode !== opened.mode || named.nlink !== 1) {
      throw new Error('version file changed during read');
    }
    return { bytes, mode: opened.mode & 0o7777, stat: opened };
  } finally { closeSync(fd); }
}

// JSON.parse validates syntax; the scanner locates only top-level version values.
// Every other byte (including CRLF, indentation, escapes and nested versions) survives.
function manifestValue(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const json = JSON.parse(text);
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('invalid manifest object');
  }
  const tokens = /"(?:\\.|[^"\\])*"|[{}\[\]:,]/g;
  const values = [];
  let depth = 0;
  for (const token of text.matchAll(tokens)) {
    const value = token[0];
    if (value === '{' || value === '[') { depth += 1; continue; }
    if (value === '}' || value === ']') { depth -= 1; continue; }
    if (depth !== 1 || value[0] !== '"' || JSON.parse(value) !== 'version') continue;
    let cursor = token.index + value.length;
    while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor += 1;
    if (text[cursor] !== ':') continue;
    cursor += 1;
    while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor += 1;
    const literal = /"(?:\\.|[^"\\])*"/y;
    literal.lastIndex = cursor;
    const match = literal.exec(text);
    if (!match) throw new Error('invalid manifest version: expected a string');
    values.push({ start: cursor, end: literal.lastIndex, version: JSON.parse(match[0]) });
  }
  if (values.length !== 1) throw new Error('missing or duplicate manifest version key');
  return { text, ...values[0] };
}

function replaceVersion(bytes, target) {
  parseVersion(target);
  const { text, start, end } = manifestValue(bytes);
  return Buffer.from(text.slice(0, start) + JSON.stringify(target) + text.slice(end));
}

function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function createDurable(path, bytes, mode) {
  ordinaryParents(path);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    fchmodSync(fd, mode);
    writeAllSync(fd, bytes);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function assertBytesMode(snapshot, bytes, mode) {
  if (snapshot.mode !== mode || !snapshot.bytes.equals(bytes)) {
    throw new Error('unexpected version file bytes or mode changed');
  }
}

export function readManifestVersions(rootDir) {
  const root = realpathSync(resolve(rootDir));
  return MANIFEST_FILES.map((rel) => {
    const filePath = join(root, rel);
    return { rel, filePath, version: manifestValue(readOrdinary(filePath).bytes).version };
  });
}

// Single-file public helper; applyBump supplies a prevalidated complete-set stage.
// This is per-file atomic replacement, never a three-file atomicity claim.
export function writeManifestVersion(filePath, newVersion, { stagePath } = {}) {
  const before = readOrdinary(filePath);
  const oldVersion = manifestValue(before.bytes).version;
  parseVersion(oldVersion);
  parseVersion(newVersion);
  if (oldVersion === newVersion) return oldVersion;
  validateVersionTransition(newVersion, oldVersion);
  const bytes = replaceVersion(before.bytes, newVersion);
  const stage = stagePath ?? join(dirname(filePath), '.steepy-version-single-' + randomBytes(16).toString('hex') + '.tmp');
  if (stagePath === undefined) createDurable(stage, bytes, before.mode);
  assertBytesMode(readOrdinary(stage), bytes, before.mode);
  assertBytesMode(readOrdinary(filePath), before.bytes, before.mode);
  renameSync(stage, filePath);
  syncDirectory(dirname(filePath));
  return oldVersion;
}

function stagePath(root, transaction, index) {
  return join(dirname(join(root, MANIFEST_FILES[index])), '.steepy-version-' + transaction.id + '-' + index + '.tmp');
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function decodeBytes(value) {
  if (typeof value !== 'string') throw new Error('invalid transaction bytes');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_MANIFEST_BYTES || bytes.toString('base64') !== value) {
    throw new Error('invalid transaction bytes');
  }
  return bytes;
}

function validateTransaction(transaction) {
  if (!exactKeys(transaction, ['schemaVersion', 'id', 'kind', 'target', 'manifests'])
    || transaction.schemaVersion !== 1 || typeof transaction.id !== 'string'
    || !/^[a-f0-9]{32}$/.test(transaction.id)
    || !Array.isArray(transaction.manifests) || transaction.manifests.length !== 3) {
    throw new Error('invalid pending version transaction');
  }
  parseVersion(transaction.target);
  let base;
  transaction.manifests.forEach((row, index) => {
    if (!exactKeys(row, ['rel', 'before', 'after', 'mode']) || row.rel !== MANIFEST_FILES[index]
      || !Number.isInteger(row.mode) || row.mode < 0 || row.mode > 0o7777) {
      throw new Error('invalid pending version transaction manifest');
    }
    const before = decodeBytes(row.before);
    const after = decodeBytes(row.after);
    const version = manifestValue(before).version;
    if (base !== undefined && base !== version) throw new Error('pending version transaction has drift');
    base = version;
    if (bumpVersion(version, transaction.kind) !== transaction.target
      || !replaceVersion(before, transaction.target).equals(after)) {
      throw new Error('invalid pending version transaction target');
    }
  });
  return transaction;
}

function currentStates(root, transaction) {
  return transaction.manifests.map((row) => {
    const snapshot = readOrdinary(join(root, row.rel));
    if (snapshot.mode !== row.mode) throw new Error('unexpected manifest mode changed');
    if (snapshot.bytes.equals(decodeBytes(row.after))) return 'after';
    if (snapshot.bytes.equals(decodeBytes(row.before))) return 'before';
    throw new Error('unexpected manifest bytes changed');
  });
}

function assertStagePrefix(snapshot, bytes, mode) {
  if (snapshot.mode !== mode || snapshot.bytes.length > bytes.length
    || !bytes.subarray(0, snapshot.bytes.length).equals(snapshot.bytes)) {
    throw new Error('unexpected staging file changed');
  }
}

function ensureStage(root, transaction, index, checkpoint) {
  const row = transaction.manifests[index];
  const path = stagePath(root, transaction, index);
  const bytes = decodeBytes(row.after);
  let observed = null;
  if (statOrNull(path) !== null) {
    observed = readOrdinary(path);
    // An owned interrupted stage may contain only an exact accepted prefix.
    // Anything else is an unexpected edit and must remain untouched.
    assertStagePrefix(observed, bytes, row.mode);
    if (observed.bytes.equals(bytes)) return;
  }
  const flags = constants.O_WRONLY | constants.O_NOFOLLOW
    | (observed === null ? constants.O_CREAT | constants.O_EXCL : 0);
  const fd = openSync(path, flags, row.mode);
  try {
    if (observed !== null && !sameIdentity(fstatSync(fd), observed.stat)) {
      throw new Error('staging file identity changed');
    }
    fchmodSync(fd, row.mode);
    checkpoint({ phase: 'stage-opened', index });
    if (observed !== null) ftruncateSync(fd, 0);
    writeAllSync(fd, bytes);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  assertBytesMode(readOrdinary(path), bytes, row.mode);
  syncDirectory(dirname(path));
  checkpoint({ phase: 'stage-durable', index });
}

function applyLocked(root, kind, checkpoint) {
  const journal = join(root, TRANSACTION_FILE);
  let transaction;
  let journalSnapshot;
  if (statOrNull(journal) !== null) {
    journalSnapshot = readOrdinary(journal, MAX_MANIFEST_BYTES * 9);
    transaction = validateTransaction(JSON.parse(journalSnapshot.bytes.toString('utf8')));
    if (kind !== transaction.kind && kind !== transaction.target) {
      throw new Error('pending version transaction must finish its recorded target');
    }
  } else {
    const snapshots = MANIFEST_FILES.map((rel) => readOrdinary(join(root, rel)));
    const versions = snapshots.map((snapshot) => manifestValue(snapshot.bytes).version);
    versions.forEach(parseVersion);
    if (!versions.every((version) => version === versions[0])) throw new Error('manifest version drift before bump');
    if (kind === versions[0]) {
      return MANIFEST_FILES.map((rel) => ({ rel, oldVersion: kind, newVersion: kind }));
    }
    const target = bumpVersion(versions[0], kind);
    transaction = {
      schemaVersion: 1, id: randomBytes(16).toString('hex'), kind, target,
      manifests: snapshots.map((snapshot, index) => ({
        rel: MANIFEST_FILES[index], before: snapshot.bytes.toString('base64'),
        after: replaceVersion(snapshot.bytes, target).toString('base64'), mode: snapshot.mode,
      })),
    };
    validateTransaction(transaction);
    const stagingJournal = journal + '.' + transaction.id + '.tmp';
    createDurable(stagingJournal, Buffer.from(JSON.stringify(transaction) + '\n'), 0o600);
    if (statOrNull(journal) !== null) throw new Error('version transaction publication conflict');
    renameSync(stagingJournal, journal);
    syncDirectory(root);
    journalSnapshot = readOrdinary(journal, MAX_MANIFEST_BYTES * 9);
    checkpoint({ phase: 'journal-durable' });
  }
  assertBytesMode(readOrdinary(journal, MAX_MANIFEST_BYTES * 9), journalSnapshot.bytes, journalSnapshot.mode);
  let states = currentStates(root, transaction);
  for (let index = 0; index < 3; index += 1) {
    if (states[index] === 'before') ensureStage(root, transaction, index, checkpoint);
  }
  // Stage the complete remaining set before the first publication.
  for (let index = 0; index < 3; index += 1) {
    if (states[index] === 'after') continue;
    checkpoint({ phase: 'before-publish', index });
    assertBytesMode(readOrdinary(journal, MAX_MANIFEST_BYTES * 9), journalSnapshot.bytes, journalSnapshot.mode);
    states = currentStates(root, transaction);
    for (let pending = index; pending < 3; pending += 1) {
      if (states[pending] === 'before') {
        const row = transaction.manifests[pending];
        assertBytesMode(readOrdinary(stagePath(root, transaction, pending)), decodeBytes(row.after), row.mode);
      }
    }
    if (states[index] === 'before') {
      writeManifestVersion(join(root, MANIFEST_FILES[index]), transaction.target,
        { stagePath: stagePath(root, transaction, index) });
    }
    checkpoint({ phase: 'after-publish', index });
  }
  checkpoint({ phase: 'before-complete' });
  if (!currentStates(root, transaction).every((state) => state === 'after')) {
    throw new Error('version transaction remains incomplete');
  }
  assertBytesMode(readOrdinary(journal, MAX_MANIFEST_BYTES * 9), journalSnapshot.bytes, journalSnapshot.mode);
  // A target may already match after recovery or an equivalent external write.
  // Remove only validated transaction-owned stages; never delete unknown bytes.
  const redundantStages = transaction.manifests.flatMap((row, index) => {
    const path = stagePath(root, transaction, index);
    if (statOrNull(path) === null) return [];
    const snapshot = readOrdinary(path);
    assertStagePrefix(snapshot, decodeBytes(row.after), row.mode);
    return [{ path, snapshot }];
  });
  for (const { path, snapshot } of redundantStages) {
    assertBytesMode(readOrdinary(path), snapshot.bytes, snapshot.mode);
    unlinkSync(path);
    syncDirectory(dirname(path));
  }
  unlinkSync(journal);
  syncDirectory(root);
  return transaction.manifests.map((row) => ({
    rel: row.rel, oldVersion: manifestValue(decodeBytes(row.before)).version, newVersion: transaction.target,
  }));
}

// Existing repository lease serializes cooperating scaffold/version writers.
// An uncooperative filesystem editor is not an adversarial-atomicity guarantee.
export function applyBump(rootDir, kind, { checkpoint = () => {} } = {}) {
  if (typeof checkpoint !== 'function') throw new TypeError('checkpoint must be a function');
  const root = realpathSync(resolve(rootDir));
  return withProjectScaffoldLock({ hubRoot: root }, () => applyLocked(root, kind, checkpoint));
}

export function checkVersions(rootDir) {
  const manifests = readManifestVersions(rootDir);
  const allSemver = manifests.every((manifest) => {
    try { parseVersion(manifest.version); return true; } catch { return false; }
  });
  const allMatch = manifests.every((manifest) => manifest.version === manifests[0].version);
  const incompleteTransaction = statOrNull(join(rootDir, TRANSACTION_FILE)) !== null;
  return { ok: allSemver && allMatch && !incompleteTransaction, manifests, incompleteTransaction };
}

// rootDir is a plain JS parameter (not parsed from argv): the CLI always bumps the
// repo it runs from (process.cwd()), while tests call main(argv, tmpRoot) directly
// against a temp fixture instead of spawning a subprocess.
export function main(argv = process.argv.slice(2), rootDir = process.cwd()) {
  if (argv.includes('--check')) {
    let result;
    try {
      result = checkVersions(rootDir);
    } catch (err) {
      console.error(`steepy bump-version: ${err.message}`);
      return 1;
    }
    const { ok, manifests } = result;
    if (ok) {
      console.log(`steepy bump-version: OK — ${manifests[0].version}`);
      return 0;
    }
    if (result.incompleteTransaction) {
      console.error('steepy bump-version: incomplete version transaction; retry its recorded target before release validation');
      return 1;
    }
    console.error(
      `steepy bump-version: drift — ${manifests.map((m) => `${m.rel}=${m.version}`).join(', ')}`,
    );
    return 1;
  }

  const arg = argv[0];
  const validKind = arg === 'patch' || arg === 'minor' || arg === 'major' || (!!arg && SEMVER_RE.test(arg));
  if (!validKind) {
    console.error(USAGE);
    return 1;
  }

  let results;
  try {
    results = applyBump(rootDir, arg);
  } catch (err) {
    console.error(`steepy bump-version: ${err.message}`);
    return 1;
  }
  for (const { rel, oldVersion, newVersion } of results) {
    console.log(`${rel}: ${oldVersion} -> ${newVersion}`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}

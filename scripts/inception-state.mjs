// Records and verifies inception run state under `.apex/inception/`. The helper never asks
// questions, chooses a phase, approves, or runs project commands: the inception skill decides,
// and this module only validates and records. It reads fixed paths only and never lists a
// directory, so a stray file in the area can never change what it reports.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { assertSafeLine, assertSafeRelPath } from './sanitize.mjs';
import { writeAllSync } from './write-all.mjs';

export const INCEPTION_AREA = '.apex/inception';
export const INCEPTION_GITIGNORE = `${INCEPTION_AREA}/.gitignore`;
export const INCEPTION_GITIGNORE_BYTES = '*\n';
export const RUN_DESCRIPTOR_PATH = `${INCEPTION_AREA}/run.json`;
export const HUB_INDEX_PATH = '.apex/_INDEX.md';
export const RESUME_NOTES_DIR = `${INCEPTION_AREA}/resume-notes`;
export const ABANDONED_DIR = `${INCEPTION_AREA}/abandoned`;

// Abandon order: `run.json` moves last, so a present descriptor always means an unfinished run.
export const RUN_CHILDREN = Object.freeze([
  'approvals', 'checkpoints', 'resume-notes', 'project', 'research', 'bootstrap', 'verification',
  'effects.jsonl', 'run.json',
]);

export const PHASES = Object.freeze([
  'reconnaissance', 'architecture', 'research', 'approval', 'bootstrap', 'verification', 'complete',
]);
export const STATUSES = Object.freeze(['active', 'blocked', 'complete']);
export const CAPABILITIES = Object.freeze(['shell', 'network', 'browser', 'subagents', 'question-tool', 'headless']);
export const GIT_COMMIT_POLICIES = Object.freeze(['allowed', 'forbidden', 'none']);

export const RUN_SCHEMA = 'steepy-inception-run/v1';

const RUN_ID_PATTERN = /^inc-\d{8}T\d{6}Z-[0-9a-f]{8}$/u;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_LINE_CHARACTERS = 1000;

const RUN_KEYS = Object.freeze([
  'schema', 'runId', 'phase', 'status', 'harness', 'git', 'nextRecord', 'approvalEntry', 'approvals',
  'checkpoints', 'resumeNotes', 'finalCheckpoint', 'verification', 'history',
]);
const HISTORY_KEYS = Object.freeze(['at', 'from', 'to', 'reason']);
const STATE_KEYS = Object.freeze(['phase', 'status']);

// One record counter is shared by approvals, checkpoints, and resume notes.
const RECORD_KINDS = Object.freeze({
  approvals: Object.freeze({ directory: `${INCEPTION_AREA}/approvals/`, extension: '.json' }),
  checkpoints: Object.freeze({ directory: `${INCEPTION_AREA}/checkpoints/`, extension: '.json' }),
  resumeNotes: Object.freeze({ directory: `${RESUME_NOTES_DIR}/`, extension: '.md' }),
});
const VERIFICATION_PREFIX = `${INCEPTION_AREA}/verification/`;
const PROJECT_PREFIX = `${INCEPTION_AREA}/project/`;
export const DECISION_REGISTER_PATH = `${PROJECT_PREFIX}decision-register.md`;

// ---------------------------------------------------------------------------
// Shared validators
// ---------------------------------------------------------------------------

function fail(reason) {
  throw new Error(reason);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expectKeys(value, keys, where) {
  if (!isPlainObject(value)) fail(`${where} must be an object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    fail(`${where} must have exactly the keys ${keys.join(', ')} in that order`);
  }
}

function expectOneOf(value, allowed, where) {
  if (!allowed.includes(value)) fail(`${where} must be one of ${allowed.join(' | ')}`);
}

function isTimestamp(value) {
  return typeof value === 'string' && TIMESTAMP_PATTERN.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

// Single-line text (HC5): `assertSafeLine` plus 1..1000 characters.
function isSafeText(value) {
  try {
    assertSafeLine(value);
  } catch {
    return false;
  }
  const length = [...value].length;
  return length >= 1 && length <= MAX_LINE_CHARACTERS;
}

// Area paths (HC5): `assertSafeRelPath` plus a non-empty remainder strictly under `prefix`,
// without empty or `.` segments (`..` is already refused by `assertSafeRelPath`).
function isAreaPathUnder(value, prefix) {
  try {
    assertSafeRelPath(value);
  } catch {
    return false;
  }
  return value.startsWith(prefix) && value.length > prefix.length
    && value.split('/').every((segment) => segment !== '' && segment !== '.');
}

function recordPath(kind, number) {
  const { directory, extension } = RECORD_KINDS[kind];
  return `${directory}${String(number).padStart(4, '0')}${extension}`;
}

function recordNumber(kind, value, where) {
  const { directory, extension } = RECORD_KINDS[kind];
  if (typeof value !== 'string' || !value.startsWith(directory) || !value.endsWith(extension)) {
    fail(`${where} must be a path under ${directory}`);
  }
  const digits = value.slice(directory.length, value.length - extension.length);
  const number = /^\d+$/u.test(digits) ? Number(digits) : Number.NaN;
  if (!Number.isSafeInteger(number) || number < 1 || recordPath(kind, number) !== value) {
    fail(`${where} must name a zero-padded record number`);
  }
  return number;
}

// Throws when any object in already-valid JSON text repeats a key. `JSON.parse` keeps the last
// value of a repeated key, so a textual extra key would otherwise pass. Keys are compared after
// decoding, so an escaped spelling of a key is the same key.
function assertNoDuplicateKeys(text, where) {
  const frames = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      let end = index + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const frame = frames.at(-1);
      if (frame?.keys && frame.expectKey) {
        const key = JSON.parse(text.slice(index, end + 1));
        if (frame.keys.has(key)) fail(`${where} has a duplicate key ${JSON.stringify(key)}`);
        frame.keys.add(key);
        frame.expectKey = false;
      }
      index = end + 1;
      continue;
    }
    if (character === '{') frames.push({ keys: new Set(), expectKey: true });
    else if (character === '[') frames.push({ keys: null, expectKey: false });
    else if (character === '}' || character === ']') frames.pop();
    else if (character === ',' && frames.at(-1)?.keys) frames.at(-1).expectKey = true;
    index += 1;
  }
}

// `JSON.parse` plus duplicate-key rejection; every area JSON value goes through here.
function parseStrictJson(text, where) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(`${where} is not valid JSON`);
  }
  assertNoDuplicateKeys(text, where);
  return value;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Run descriptor (HC3)
// ---------------------------------------------------------------------------

function validateRecordList(descriptor, kind) {
  const list = descriptor[kind];
  if (!Array.isArray(list)) fail(`${kind} must be an array`);
  let previous = 0;
  list.forEach((entry, index) => {
    const number = recordNumber(kind, entry, `${kind}[${index}]`);
    if (number >= descriptor.nextRecord) fail(`${kind}[${index}] must be below nextRecord`);
    if (number <= previous) fail(`${kind} must be strictly increasing`);
    previous = number;
  });
}

function validateState(state, where) {
  expectKeys(state, STATE_KEYS, where);
  expectOneOf(state.phase, PHASES, `${where}.phase`);
  expectOneOf(state.status, STATUSES, `${where}.status`);
}

function validateRunDescriptor(d) {
  expectKeys(d, RUN_KEYS, 'run descriptor');
  if (d.schema !== RUN_SCHEMA) fail(`schema must be ${RUN_SCHEMA}`);
  if (typeof d.runId !== 'string' || !RUN_ID_PATTERN.test(d.runId)) fail('runId is malformed');
  expectOneOf(d.phase, PHASES, 'phase');
  expectOneOf(d.status, STATUSES, 'status');
  if ((d.phase === 'complete') !== (d.status === 'complete')) {
    fail('phase complete and status complete must go together');
  }

  expectKeys(d.harness, ['name', 'capabilities'], 'harness');
  if (typeof d.harness.name !== 'string' || !SLUG_PATTERN.test(d.harness.name)) {
    fail('harness.name must be a safe slug');
  }
  expectKeys(d.harness.capabilities, CAPABILITIES, 'harness.capabilities');
  for (const name of CAPABILITIES) {
    if (typeof d.harness.capabilities[name] !== 'boolean') fail(`harness.capabilities.${name} must be a boolean`);
  }

  expectKeys(d.git, ['present', 'branch', 'commits'], 'git');
  if (typeof d.git.present !== 'boolean') fail('git.present must be a boolean');
  if (d.git.branch !== null && typeof d.git.branch !== 'string') fail('git.branch must be a string or null');
  expectOneOf(d.git.commits, GIT_COMMIT_POLICIES, 'git.commits');
  if ((d.git.commits === 'none') === d.git.present) fail('git.commits is none exactly when Git is absent');

  if (!Number.isSafeInteger(d.nextRecord) || d.nextRecord < 1) fail('nextRecord must be a safe integer >= 1');
  for (const kind of Object.keys(RECORD_KINDS)) validateRecordList(d, kind);
  if (d.approvalEntry !== null
    && (!Number.isSafeInteger(d.approvalEntry) || d.approvalEntry < 0 || d.approvalEntry > d.approvals.length)) {
    fail('approvalEntry must be null or an integer in 0..approvals.length');
  }
  if (d.finalCheckpoint !== null && !d.checkpoints.includes(d.finalCheckpoint)) {
    fail('finalCheckpoint must be null or a recorded checkpoint');
  }
  if (d.verification !== null) {
    expectKeys(d.verification, ['path', 'bytes', 'sha256'], 'verification');
    const { path, bytes, sha256 } = d.verification;
    if (!isAreaPathUnder(path, VERIFICATION_PREFIX)) fail(`verification.path must be a safe path under ${VERIFICATION_PREFIX}`);
    if (!Number.isSafeInteger(bytes) || bytes < 0) fail('verification.bytes must be a safe integer >= 0');
    if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) fail('verification.sha256 must be lowercase hex');
  }
  if (d.status === 'complete' && (d.finalCheckpoint === null || d.verification === null)) {
    fail('a complete run must bind finalCheckpoint and verification');
  }

  if (!Array.isArray(d.history)) fail('history must be an array');
  d.history.forEach((entry, index) => {
    const where = `history[${index}]`;
    expectKeys(entry, HISTORY_KEYS, where);
    if (!isTimestamp(entry.at)) fail(`${where}.at must be an ISO timestamp`);
    validateState(entry.from, `${where}.from`);
    validateState(entry.to, `${where}.to`);
    if (!isSafeText(entry.reason)) fail(`${where}.reason must be single-line text`);
  });
}

export function parseRunDescriptor(text) {
  if (typeof text !== 'string') fail('run descriptor must be text');
  const value = parseStrictJson(text, 'run descriptor');
  validateRunDescriptor(value);
  return deepFreeze(value);
}

export function serializeRunDescriptor(descriptor) {
  return `${JSON.stringify(descriptor, null, 2)}\n`;
}

// `capabilities` lists the enabled capability names; every other capability is recorded false.
export function createRunDescriptor({ runId, harnessName, capabilities = [], git }) {
  const enabled = new Set(capabilities);
  for (const name of enabled) {
    if (!CAPABILITIES.includes(name)) fail(`unknown capability: ${JSON.stringify(name)}`);
  }
  return parseRunDescriptor(serializeRunDescriptor({
    schema: RUN_SCHEMA,
    runId,
    phase: 'reconnaissance',
    status: 'active',
    harness: {
      name: harnessName,
      capabilities: Object.fromEntries(CAPABILITIES.map((name) => [name, enabled.has(name)])),
    },
    git: { present: git?.present, branch: git?.branch, commits: git?.commits },
    nextRecord: 1,
    approvalEntry: null,
    approvals: [],
    checkpoints: [],
    resumeNotes: [],
    finalCheckpoint: null,
    verification: null,
    history: [],
  }));
}

export function nextStepFor(descriptor) {
  if (descriptor.status === 'complete') {
    return 'run the init skill, then the discovery skill with the inception source';
  }
  if (descriptor.status === 'blocked') {
    return 'resolve the block recorded in the latest resume note, then resume with the inception skill';
  }
  return `resume with the inception skill (phase ${descriptor.phase})`;
}

// ---------------------------------------------------------------------------
// File safety (HC4): fixed paths, real directories, ordinary single-link area files
// ---------------------------------------------------------------------------

// Exit 1: refused precondition, invalid state, or failed verification. Exit 2: usage error.
class InceptionError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

function refuse(message) {
  return new InceptionError(1, message);
}

function usage(message) {
  return new InceptionError(2, message);
}

function lstatOrNull(absolute) {
  try {
    return lstatSync(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// True when `relative` is a real directory, false when absent; anything else refuses.
function realDirectory(root, relative) {
  const stat = lstatOrNull(join(root, relative));
  if (stat === null) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw refuse(`${relative} is not a real directory`);
  return true;
}

// Opens the ordinary file `stat` describes without following a symlink. Returns null when the
// path no longer names that same file.
function openObserved(absolute, stat) {
  let fd;
  try {
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ELOOP' || error.code === 'ENOENT') return null;
    throw error;
  }
  const opened = fstatSync(fd);
  if (opened.isFile() && opened.nlink === stat.nlink && opened.ino === stat.ino && opened.dev === stat.dev) return fd;
  closeSync(fd);
  return null;
}

function forEachChunk(fd, visit) {
  const buffer = Buffer.alloc(65536);
  let count;
  while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) visit(buffer.subarray(0, count));
}

// Streams the bytes: `bytes` plus the lowercase hex `sha256` (HC4).
function digestFd(fd) {
  const hash = createHash('sha256');
  let bytes = 0;
  forEachChunk(fd, (chunk) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  return { bytes, sha256: hash.digest('hex') };
}

// Reads an area file that must be an ordinary, non-symlink file with exactly one link (PD3c).
function readAreaFile(root, relative) {
  const absolute = join(root, relative);
  const stat = lstatOrNull(absolute);
  if (stat === null) throw refuse(`${relative} does not exist`);
  if (!stat.isFile()) throw refuse(`${relative} is not an ordinary file`);
  if (stat.nlink !== 1) throw refuse(`${relative} has more than one hard link`);
  const fd = openObserved(absolute, stat);
  if (fd === null) throw refuse(`${relative} changed while it was read`);
  try {
    const chunks = [];
    forEachChunk(fd, (chunk) => chunks.push(Buffer.from(chunk)));
    return Buffer.concat(chunks);
  } finally {
    closeSync(fd);
  }
}

// Observes one file without throwing on what it finds. `missing`: the file or a parent directory
// is absent. `unsafe` (with a reason): a parent is not a real directory, or the file is not an
// ordinary non-symlink file (with exactly one link when `singleLink`). Otherwise `present` with
// the file's size and digest. Area files need `singleLink` (PD3c); application files take any
// link count.
function inspectFile(root, relative, { singleLink }) {
  const segments = relative.split('/');
  for (let index = 1; index < segments.length; index += 1) {
    const parent = segments.slice(0, index).join('/');
    const stat = lstatOrNull(join(root, parent));
    if (stat === null) return { state: 'missing' };
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { state: 'unsafe', reason: `${parent} is not a real directory` };
  }
  const absolute = join(root, relative);
  const stat = lstatOrNull(absolute);
  if (stat === null) return { state: 'missing' };
  if (!stat.isFile()) return { state: 'unsafe', reason: `${relative} is not an ordinary file` };
  if (singleLink && stat.nlink !== 1) return { state: 'unsafe', reason: `${relative} has more than one hard link` };
  const fd = openObserved(absolute, stat);
  if (fd === null) return { state: 'unsafe', reason: `${relative} changed while it was read` };
  try {
    return { state: 'present', ...digestFd(fd) };
  } finally {
    closeSync(fd);
  }
}

// The `{ path, bytes, sha256 }` digest of a file that must be present and safe; refuses otherwise.
function digestFile(root, relative, { singleLink }) {
  const observed = inspectFile(root, relative, { singleLink });
  if (observed.state === 'missing') throw refuse(`${relative} does not exist`);
  if (observed.state === 'unsafe') throw refuse(observed.reason);
  return { path: relative, bytes: observed.bytes, sha256: observed.sha256 };
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

// Area text is strict UTF-8: an invalid byte is invalid state, never a silent U+FFFD that a later
// rewrite would persist. `ignoreBOM` keeps a leading BOM in the text, so JSON parsing rejects it.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decodeAreaText(bytes, relative) {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw refuse(`${relative} is not valid UTF-8`);
  }
}

// ---------------------------------------------------------------------------
// Observation and classification (HC8)
// ---------------------------------------------------------------------------

function observeHub(root) {
  const stat = lstatOrNull(join(root, HUB_INDEX_PATH));
  if (stat === null) return { hub: 'absent', error: null };
  if (stat.isFile()) return { hub: 'present', error: null };
  return { hub: 'invalid', error: `${HUB_INDEX_PATH} is not an ordinary file` };
}

function observeRun(root) {
  if (!realDirectory(root, '.apex') || !realDirectory(root, INCEPTION_AREA)) return { run: 'none', descriptor: null, error: null };
  if (lstatOrNull(join(root, RUN_DESCRIPTOR_PATH)) === null) return { run: 'none', descriptor: null, error: null };
  try {
    const descriptor = parseRunDescriptor(decodeAreaText(readAreaFile(root, RUN_DESCRIPTOR_PATH), RUN_DESCRIPTOR_PATH));
    return { run: descriptor.status, descriptor, error: null };
  } catch (error) {
    return { run: 'invalid', descriptor: null, error: `invalid run descriptor: ${message(error)}` };
  }
}

// Observes fixed paths only. Only ENOENT means absent; every other failure is invalid state.
export function observeState(repoRoot) {
  let apex;
  try {
    apex = lstatOrNull(join(repoRoot, '.apex'));
  } catch (error) {
    return { hub: 'invalid', run: 'invalid', descriptor: null, error: `.apex cannot be inspected: ${message(error)}` };
  }
  if (apex === null) return { hub: 'absent', run: 'none', descriptor: null, error: null };
  if (apex.isSymbolicLink() || !apex.isDirectory()) {
    return { hub: 'invalid', run: 'invalid', descriptor: null, error: '.apex is not a real directory' };
  }
  let hub;
  let run;
  try {
    hub = observeHub(repoRoot);
  } catch (error) {
    hub = { hub: 'invalid', error: `${HUB_INDEX_PATH} cannot be inspected: ${message(error)}` };
  }
  try {
    run = observeRun(repoRoot);
  } catch (error) {
    run = { run: 'invalid', descriptor: null, error: message(error) };
  }
  return { hub: hub.hub, run: run.run, descriptor: run.descriptor, error: hub.error ?? run.error };
}

export const MATURITIES = Object.freeze(['suitable', 'mature']);

export function classifyState({ hub, run, maturity }) {
  if (hub === 'invalid' || run === 'invalid') return 'invalid-state';
  if (run === 'none') {
    if (hub === 'present') return 'ordinary-workflow';
    if (maturity === 'suitable') return 'start-new-run';
    if (maturity === 'mature') return 'propose-init-discovery';
    return 'maturity-decision-required';
  }
  if (run === 'complete') return hub === 'present' ? 'run-complete-ordinary-workflow' : 'report-next-steps';
  return hub === 'present' ? 'conflict-run-beside-hub' : 'resume-run';
}

function classifyCommand(root, values) {
  const observed = observeState(root);
  const row = classifyState({ hub: observed.hub, run: observed.run, maturity: values.maturity });
  const fields = { row, hub: observed.hub, run: observed.run };
  if (observed.descriptor !== null && row !== 'invalid-state') fields.nextStep = nextStepFor(observed.descriptor);
  if (row === 'invalid-state') return { ok: false, fields, error: observed.error };
  return { ok: true, fields };
}

// ---------------------------------------------------------------------------
// Writes (HC4)
// ---------------------------------------------------------------------------

function fsyncDirectory(absolute) {
  const fd = openSync(absolute, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Replaces a file by temp + rename. A failure before the rename leaves the old file
// byte-identical and removes only the temp file. The temp descriptor is closed exactly once,
// and removing the temp file never depends on that close succeeding.
export function replaceFileAtomic(absolutePath, bytes, { writeToFd = writeSync, closeFd = closeSync } = {}) {
  const directory = dirname(absolutePath);
  const temp = join(directory, `.${basename(absolutePath)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(temp, 'wx', 0o644);
  let failure = null;
  try {
    writeAllSync(fd, bytes, writeToFd);
    fsyncSync(fd);
  } catch (error) {
    failure = error;
  }
  try {
    closeFd(fd);
  } catch (error) {
    failure ??= error;
  }
  if (failure === null) {
    try {
      renameSync(temp, absolutePath);
    } catch (error) {
      failure = error;
    }
  }
  if (failure !== null) {
    try {
      unlinkSync(temp);
    } catch {
      // The original failure is the one reported.
    }
    throw failure;
  }
  fsyncDirectory(directory);
}

// Creates a file that must not exist yet; it is never opened for writing again.
function createFileExclusive(absolute, bytes) {
  const fd = openSync(absolute, 'wx', 0o644);
  try {
    writeAllSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Creates one directory component (never recursive) and makes the entry durable.
function createDirectory(root, relative) {
  mkdirSync(join(root, relative));
  fsyncDirectory(dirname(join(root, relative)));
}

// Validates a candidate descriptor before it is written: the helper never writes a
// descriptor it would itself reject.
function writeDescriptor(root, descriptor, replaceFile) {
  const bytes = serializeRunDescriptor(parseRunDescriptor(serializeRunDescriptor(descriptor)));
  replaceFile(join(root, RUN_DESCRIPTOR_PATH), bytes);
}

function loadDescriptor(root) {
  const observed = observeRun(root);
  if (observed.run === 'none') throw refuse(`no inception run: ${RUN_DESCRIPTOR_PATH} does not exist`);
  if (observed.run === 'invalid') throw refuse(observed.error);
  return observed.descriptor;
}

function assertText(value, option) {
  if (!isSafeText(value)) throw refuse(`${option} must be single-line text of 1..${MAX_LINE_CHARACTERS} characters`);
  return value;
}

// ---------------------------------------------------------------------------
// Git observation (HC10)
// ---------------------------------------------------------------------------

// `env` defaults to the process environment; in-process callers (tests) pass a hermetic one.
function runGit(root, args, env = process.env) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env });
}

function observeGit(root, env) {
  const inside = runGit(root, ['rev-parse', '--is-inside-work-tree'], env);
  if (inside.error) {
    if (inside.error.code === 'ENOENT') return { present: false, branch: null };
    throw refuse(`git could not be run: ${inside.error.message}`);
  }
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return { present: false, branch: null };
  const branch = runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], env);
  if (branch.error) throw refuse(`git could not be run: ${branch.error.message}`);
  return { present: true, branch: branch.status === 0 ? branch.stdout.trim() : null };
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

function runIdFor(now, randomHex) {
  const stamp = `${now.toISOString().slice(0, 19).replace(/[-:]/gu, '')}Z`;
  return `inc-${stamp}-${randomHex}`;
}

// The start command body. Every precondition is checked before the first write; the area
// `.gitignore` is written before the descriptor so no run file is ever visible to Git.
export function startRun(repoRoot, {
  harnessName,
  capabilities = [],
  gitCommits,
  now = new Date(),
  randomHex = randomBytes(4).toString('hex'),
  replaceFile = replaceFileAtomic,
  env = process.env,
} = {}) {
  const root = resolveRepoRoot(repoRoot);
  if (typeof harnessName !== 'string' || !SLUG_PATTERN.test(harnessName)) {
    throw refuse('--harness must be a safe slug (lowercase letters, digits, dashes; at most 40 characters)');
  }
  if (gitCommits !== 'allowed' && gitCommits !== 'forbidden') throw usage('--git-commits must be one of allowed | forbidden');
  for (const name of capabilities) {
    if (!CAPABILITIES.includes(name)) throw usage(`unknown capability: ${JSON.stringify(name)}`);
  }

  const apexExists = realDirectory(root, '.apex');
  if (apexExists && lstatOrNull(join(root, HUB_INDEX_PATH)) !== null) {
    throw refuse(`${HUB_INDEX_PATH} exists: this project already has a hub`);
  }
  const areaExists = apexExists && realDirectory(root, INCEPTION_AREA);
  let gitignoreExists = false;
  if (areaExists) {
    if (lstatOrNull(join(root, RUN_DESCRIPTOR_PATH)) !== null) {
      throw refuse(`${RUN_DESCRIPTOR_PATH} exists: an inception run descriptor is already present`);
    }
    if (lstatOrNull(join(root, INCEPTION_GITIGNORE)) !== null) {
      if (readAreaFile(root, INCEPTION_GITIGNORE).toString('utf8') !== INCEPTION_GITIGNORE_BYTES) {
        throw refuse(`${INCEPTION_GITIGNORE} exists with bytes other than ${JSON.stringify(INCEPTION_GITIGNORE_BYTES)}`);
      }
      gitignoreExists = true;
    }
  }

  const observed = observeGit(root, env);
  const git = observed.present
    ? { present: true, branch: observed.branch, commits: gitCommits }
    : { present: false, branch: null, commits: 'none' };
  let descriptor;
  try {
    descriptor = createRunDescriptor({ runId: runIdFor(now, randomHex), harnessName, capabilities, git });
  } catch (error) {
    throw refuse(`cannot create the run descriptor: ${message(error)}`);
  }

  if (!apexExists) createDirectory(root, '.apex');
  if (!areaExists) createDirectory(root, INCEPTION_AREA);
  if (!gitignoreExists) {
    createFileExclusive(join(root, INCEPTION_GITIGNORE), INCEPTION_GITIGNORE_BYTES);
    fsyncDirectory(join(root, INCEPTION_AREA));
  }
  writeDescriptor(root, descriptor, replaceFile);
  return { runId: descriptor.runId, descriptor: RUN_DESCRIPTOR_PATH };
}

function parseCapabilities(csv) {
  if (csv === '') return [];
  const names = csv.split(',');
  const seen = new Set();
  for (const name of names) {
    if (name === '') throw usage('--capabilities has an empty capability name');
    if (!CAPABILITIES.includes(name)) throw usage(`--capabilities names an unknown capability: ${JSON.stringify(name)}`);
    if (seen.has(name)) throw usage(`--capabilities repeats ${JSON.stringify(name)}`);
    seen.add(name);
  }
  return names;
}

function startCommand(root, values) {
  const result = startRun(root, {
    harnessName: values.harness,
    capabilities: values.capabilities,
    gitCommits: values['git-commits'],
  });
  return { ok: true, fields: result };
}

// ---------------------------------------------------------------------------
// transition (HC9)
// ---------------------------------------------------------------------------

export const TRANSITION_TARGETS = Object.freeze([...PHASES, 'blocked', 'active']);

function isReturnToApproval(descriptor, to) {
  return to === 'approval' && (descriptor.phase === 'bootstrap' || descriptor.phase === 'verification');
}

// Returns the next descriptor for an accepted transition, or throws a refusal. The edge rules are
// pure; `gates` run the read-only HC9 checks of the two gated edges and never write.
function applyTransition(descriptor, { to, reason, gitCommits, checkpoint, verification, now }, gates) {
  const from = { phase: descriptor.phase, status: descriptor.status };
  if (descriptor.status === 'complete') throw refuse('the run is complete: no transition is allowed');
  let { phase, status, approvalEntry } = descriptor;
  let edge = null;
  if (to === 'active') {
    if (descriptor.status !== 'blocked') throw refuse('the run is not blocked: --to active only resumes a blocked run');
    status = 'active';
  } else if (descriptor.status === 'blocked') {
    throw refuse('the run is blocked: --to active is the only transition allowed');
  } else if (to === 'blocked') {
    status = 'blocked';
  } else {
    edge = `${descriptor.phase} -> ${to}`;
    const forward = PHASES.indexOf(to) === PHASES.indexOf(descriptor.phase) + 1;
    if (!forward && !isReturnToApproval(descriptor, to)) throw refuse(`transition not allowed: ${edge}`);
    phase = to;
    if (to === 'approval') approvalEntry = descriptor.approvals.length;
  }
  if (gitCommits !== undefined && !isReturnToApproval(descriptor, to)) {
    throw refuse('--git-commits is allowed only on a return to approval');
  }
  const completing = edge === 'verification -> complete';
  if (!completing && (checkpoint !== undefined || verification !== undefined)) {
    throw refuse('--checkpoint and --verification are allowed only on verification -> complete');
  }
  let bindings = {};
  if (edge === 'approval -> bootstrap') gates.approval();
  if (completing) {
    bindings = gates.complete({ checkpoint, verification });
    status = 'complete';
  }
  // Without Git the policy stays `none`, as `start` records it (HC10).
  const commits = gitCommits !== undefined && descriptor.git.present ? gitCommits : descriptor.git.commits;
  return {
    ...descriptor,
    phase,
    status,
    git: { ...descriptor.git, commits },
    approvalEntry,
    ...bindings,
    history: [...descriptor.history, { at: now.toISOString(), from, to: { phase, status }, reason }],
  };
}

function transitionRun(repoRoot, {
  to,
  reason,
  gitCommits,
  checkpoint,
  verification,
  now = new Date(),
  replaceFile = replaceFileAtomic,
} = {}) {
  const root = resolveRepoRoot(repoRoot);
  if (!TRANSITION_TARGETS.includes(to)) throw usage(`--to must be one of ${TRANSITION_TARGETS.join(' | ')}`);
  assertText(reason, '--reason');
  const descriptor = loadDescriptor(root);
  const gates = {
    approval: () => assertApprovalGate(root, descriptor),
    complete: (bindings) => completeGate(root, descriptor, bindings, process.env),
  };
  const next = applyTransition(descriptor, { to, reason, gitCommits, checkpoint, verification, now }, gates);
  writeDescriptor(root, next, replaceFile);
  return { phase: next.phase, status: next.status };
}

function transitionCommand(root, values) {
  const result = transitionRun(root, {
    to: values.to,
    reason: values.reason,
    gitCommits: values['git-commits'],
    checkpoint: values.checkpoint,
    verification: values.verification,
  });
  return { ok: true, fields: result };
}

// ---------------------------------------------------------------------------
// resume-note (HC11)
// ---------------------------------------------------------------------------

function assertAreaPath(value, option, prefix = `${INCEPTION_AREA}/`) {
  if (!isAreaPathUnder(value, prefix)) throw refuse(`${option} must be a safe path under ${prefix}: ${JSON.stringify(value)}`);
  return value;
}

// An existing area file: every directory on the way is real, the file is ordinary with one link.
function assertAreaFile(root, relative) {
  const segments = relative.split('/');
  for (let index = 1; index < segments.length; index += 1) {
    if (!realDirectory(root, segments.slice(0, index).join('/'))) throw refuse(`${relative} does not exist`);
  }
  const stat = lstatOrNull(join(root, relative));
  if (stat === null) throw refuse(`${relative} does not exist`);
  if (!stat.isFile()) throw refuse(`${relative} is not an ordinary file`);
  if (stat.nlink !== 1) throw refuse(`${relative} has more than one hard link`);
}

function renderResumeNote({ number, descriptor, next, needs, note }) {
  return [
    `# Inception resume note ${String(number).padStart(4, '0')}`,
    '',
    `- Run: ${descriptor.runId}`,
    `- Descriptor: \`${RUN_DESCRIPTOR_PATH}\``,
    `- Phase: ${descriptor.phase}`,
    `- Status: ${descriptor.status}`,
    `- Next: ${next}`,
    '',
    '## Exact paths',
    '',
    ...needs.map((need) => `- \`${need}\``),
    '',
    '## Note',
    '',
    note ?? 'none',
    '',
  ].join('\n');
}

// Writes one numbered record of `kind` (approvals, checkpoints, resume notes) and binds it (HC4):
// reserve the number first, create the record exclusively, then bind it. A crash leaves only a gap
// or an unbound record, and no record is ever opened for writing again. Every refusal happens
// before the first write.
function writeRecord(root, descriptor, kind, render, replaceFile) {
  const number = descriptor.nextRecord;
  const path = recordPath(kind, number);
  const directory = RECORD_KINDS[kind].directory.slice(0, -1);
  const directoryExists = realDirectory(root, directory);
  if (directoryExists && lstatOrNull(join(root, path)) !== null) throw refuse(`${path} already exists`);
  const bytes = render(number);

  const reserved = { ...descriptor, nextRecord: number + 1 };
  writeDescriptor(root, reserved, replaceFile);
  if (!directoryExists) createDirectory(root, directory);
  createFileExclusive(join(root, path), bytes);
  fsyncDirectory(join(root, directory));
  writeDescriptor(root, { ...reserved, [kind]: [...descriptor[kind], path] }, replaceFile);
  return path;
}

function writeResumeNote(repoRoot, { next, needs = [], note, replaceFile = replaceFileAtomic } = {}) {
  const root = resolveRepoRoot(repoRoot);
  assertText(next, '--next');
  if (note !== undefined) assertText(note, '--note');
  for (const need of needs) assertAreaPath(need, '--need');
  const descriptor = loadDescriptor(root);
  for (const need of needs) assertAreaFile(root, need);
  const notePath = writeRecord(
    root, descriptor, 'resumeNotes',
    (number) => renderResumeNote({ number, descriptor, next, needs, note }),
    replaceFile,
  );
  return { note: notePath };
}

function resumeNoteCommand(root, values) {
  return { ok: true, fields: writeResumeNote(root, { next: values.next, needs: values.need, note: values.note }) };
}

// ---------------------------------------------------------------------------
// approve and verify-approval (HC12)
// ---------------------------------------------------------------------------

export const APPROVAL_SCHEMA = 'steepy-inception-approval/v1';
const APPROVAL_KEYS = Object.freeze(['schema', 'runId', 'record', 'at', 'statement', 'documents']);
const DIGEST_KEYS = Object.freeze(['path', 'bytes', 'sha256']);
const MAX_STATEMENT_CHARACTERS = 8000;
const STATEMENT_FORBIDDEN = /[\x00-\x08\x0B-\x1F\x7F]/u;

// `--statement` (HC5): 1..8000 characters; newline and tab are the only control characters.
function isStatement(value) {
  if (typeof value !== 'string' || STATEMENT_FORBIDDEN.test(value)) return false;
  const length = [...value].length;
  return length >= 1 && length <= MAX_STATEMENT_CHARACTERS;
}

function validateDigestList(list, where, isPath) {
  if (!Array.isArray(list) || list.length === 0) fail(`${where} must be a non-empty array`);
  list.forEach((entry, index) => {
    const at = `${where}[${index}]`;
    expectKeys(entry, DIGEST_KEYS, at);
    if (!isPath(entry.path)) fail(`${at}.path is not an allowed path`);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) fail(`${at}.bytes must be a safe integer >= 0`);
    if (typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) fail(`${at}.sha256 must be lowercase hex`);
    if (index > 0 && !(list[index - 1].path < entry.path)) fail(`${where} must be sorted by path without duplicates`);
  });
}

function parseApprovalRecord(text, { runId, number }) {
  const value = parseStrictJson(text, 'approval record');
  expectKeys(value, APPROVAL_KEYS, 'approval record');
  if (value.schema !== APPROVAL_SCHEMA) fail(`schema must be ${APPROVAL_SCHEMA}`);
  if (value.runId !== runId) fail(`runId must be ${runId}`);
  if (value.record !== number) fail(`record must be ${number}`);
  if (!isTimestamp(value.at)) fail('at must be an ISO timestamp');
  if (!isStatement(value.statement)) fail('statement is not a valid statement');
  validateDigestList(value.documents, 'documents', (path) => isAreaPathUnder(path, PROJECT_PREFIX));
  if (!value.documents.some((entry) => entry.path === DECISION_REGISTER_PATH)) fail(`documents must include ${DECISION_REGISTER_PATH}`);
  return value;
}

// Reads and validates a bound record; any problem with the record itself is a refusal.
function readRecord(root, descriptor, kind, path, parse) {
  const number = recordNumber(kind, path, path);
  assertAreaFile(root, path);
  const text = decodeAreaText(readAreaFile(root, path), path);
  try {
    return parse(text, { runId: descriptor.runId, number });
  } catch (error) {
    throw refuse(`${path} is invalid: ${message(error)}`);
  }
}

// The latest bound record of `kind`, or the requested one, which must be bound.
function selectBoundRecord(descriptor, kind, requested, option) {
  const noun = kind === 'approvals' ? 'approval' : 'checkpoint';
  const bound = descriptor[kind];
  if (bound.length === 0) throw refuse(`no ${noun} is recorded`);
  if (requested === undefined) return bound.at(-1);
  assertAreaPath(requested, option, RECORD_KINDS[kind].directory);
  if (!bound.includes(requested)) throw refuse(`${option} ${requested} is not a recorded ${noun}`);
  return requested;
}

function approvalDivergences(root, record) {
  const divergences = [];
  for (const document of record.documents) {
    const observed = inspectFile(root, document.path, { singleLink: true });
    if (observed.state !== 'present') divergences.push({ path: document.path, kind: observed.state });
    else if (observed.bytes !== document.bytes || observed.sha256 !== document.sha256) {
      divergences.push({ path: document.path, kind: 'changed' });
    }
  }
  return divergences;
}

function verifyApprovalRecord(root, descriptor, path) {
  const record = readRecord(root, descriptor, 'approvals', path, parseApprovalRecord);
  return { record, divergences: approvalDivergences(root, record) };
}

function describeDivergences(divergences) {
  return divergences.map(({ path, kind }) => (path === undefined ? kind : `${path} ${kind}`)).join(', ');
}

// The helper stores the statement it is given; a record is not proof that a human approved.
function approveRun(repoRoot, { statement, documents = [], now = new Date(), replaceFile = replaceFileAtomic } = {}) {
  const root = resolveRepoRoot(repoRoot);
  if (!isStatement(statement)) {
    throw refuse(`--statement must be 1..${MAX_STATEMENT_CHARACTERS} characters with no control character other than newline and tab`);
  }
  for (const path of documents) assertAreaPath(path, '--document', PROJECT_PREFIX);
  const paths = [...documents].sort();
  paths.forEach((path, index) => {
    if (index > 0 && paths[index - 1] === path) throw refuse(`--document names ${path} more than once`);
  });
  if (!paths.includes(DECISION_REGISTER_PATH)) throw refuse(`--document must include ${DECISION_REGISTER_PATH}`);
  const descriptor = loadDescriptor(root);
  if (descriptor.phase !== 'approval' || descriptor.status !== 'active') {
    throw refuse(`approve needs phase approval with status active; the run is in phase ${descriptor.phase} with status ${descriptor.status}`);
  }
  const digests = paths.map((path) => digestFile(root, path, { singleLink: true }));
  const approval = writeRecord(root, descriptor, 'approvals', (record) => `${JSON.stringify({
    schema: APPROVAL_SCHEMA,
    runId: descriptor.runId,
    record,
    at: now.toISOString(),
    statement,
    documents: digests,
  }, null, 2)}\n`, replaceFile);
  return { approval, documents: digests };
}

function approveCommand(root, values) {
  return { ok: true, fields: approveRun(root, { statement: values.statement, documents: values.document }) };
}

function verifyApprovalCommand(root, values) {
  const descriptor = loadDescriptor(root);
  const approval = selectBoundRecord(descriptor, 'approvals', values.approval, '--approval');
  const { record, divergences } = verifyApprovalRecord(root, descriptor, approval);
  if (divergences.length > 0) {
    return { ok: false, fields: { approval, divergences }, error: `${approval} diverges: ${describeDivergences(divergences)}` };
  }
  return { ok: true, fields: { approval, documents: record.documents } };
}

// HC9 gate for approval -> bootstrap: a new approval since entering approval, and it is clean.
function assertApprovalGate(root, descriptor) {
  if (descriptor.approvalEntry === null || descriptor.approvals.length <= descriptor.approvalEntry) {
    throw refuse('approval -> bootstrap needs a new approval recorded since the run entered approval');
  }
  const latest = descriptor.approvals.at(-1);
  const { divergences } = verifyApprovalRecord(root, descriptor, latest);
  if (divergences.length > 0) {
    throw refuse(`approval -> bootstrap refused: the latest approval ${latest} diverges: ${describeDivergences(divergences)}`);
  }
}

// ---------------------------------------------------------------------------
// effect intent, outcome, status (HC13)
// ---------------------------------------------------------------------------

export const EFFECT_LOG_PATH = `${INCEPTION_AREA}/effects.jsonl`;
export const EFFECT_SCHEMA = 'steepy-inception-effect/v1';
export const EFFECT_KINDS = Object.freeze(['install', 'generator', 'migration', 'external-resource', 'deploy', 'commit', 'remote']);
export const EFFECT_RESULTS = Object.freeze(['succeeded', 'failed']);
// Remote operations and deploys are always authorized per operation (D11).
const AUTHORIZED_KINDS = Object.freeze(['remote', 'deploy']);
const EFFECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const INTENT_KEYS = Object.freeze(['schema', 'type', 'id', 'kind', 'summary', 'authorization', 'phase', 'at']);
const OUTCOME_KEYS = Object.freeze(['schema', 'type', 'id', 'result', 'observed', 'phase', 'at']);

function isEffectId(value) {
  return typeof value === 'string' && EFFECT_ID_PATTERN.test(value);
}

function parseEffectLine(text) {
  const value = parseStrictJson(text, 'effect line');
  if (!isPlainObject(value)) fail('an effect line must be an object');
  if (value.type === 'intent') {
    expectKeys(value, INTENT_KEYS, 'intent');
    expectOneOf(value.kind, EFFECT_KINDS, 'kind');
    if (!isSafeText(value.summary)) fail('summary must be single-line text');
    if (value.authorization !== null && !isSafeText(value.authorization)) fail('authorization must be null or single-line text');
    if (AUTHORIZED_KINDS.includes(value.kind) && value.authorization === null) fail(`a ${value.kind} intent needs an authorization`);
  } else if (value.type === 'outcome') {
    expectKeys(value, OUTCOME_KEYS, 'outcome');
    expectOneOf(value.result, EFFECT_RESULTS, 'result');
    if (!isSafeText(value.observed)) fail('observed must be single-line text');
  } else {
    fail('type must be intent or outcome');
  }
  if (value.schema !== EFFECT_SCHEMA) fail(`schema must be ${EFFECT_SCHEMA}`);
  if (!isEffectId(value.id)) fail('id is malformed');
  expectOneOf(value.phase, PHASES, 'phase');
  if (!isTimestamp(value.at)) fail('at must be an ISO timestamp');
  // Only the helper writes the log, always as compact `JSON.stringify` text: any other spelling
  // (whitespace, a carriage return) means the log was edited elsewhere.
  if (JSON.stringify(value) !== text) fail('an effect line must be compact JSON');
  return value;
}

// Parses the whole log strictly (HC13): every line is one intent or outcome object ending in
// `\n`, an outcome follows its intent, and each id has at most one of each. An absent log is
// empty. Returns the parsed size and the effects in intent order.
function readEffectLog(root) {
  if (lstatOrNull(join(root, EFFECT_LOG_PATH)) === null) return { exists: false, size: 0, effects: new Map() };
  const bytes = readAreaFile(root, EFFECT_LOG_PATH);
  const effects = new Map();
  let start = 0;
  let line = 0;
  while (start < bytes.length) {
    line += 1;
    const end = bytes.indexOf(0x0a, start);
    const malformed = () => refuse(`effect log is malformed at line ${line}`);
    if (end === -1) throw malformed();
    let entry;
    try {
      entry = parseEffectLine(UTF8.decode(bytes.subarray(start, end)));
    } catch {
      throw malformed();
    }
    const known = effects.get(entry.id);
    if (entry.type === 'intent') {
      if (known !== undefined) throw malformed();
      effects.set(entry.id, { id: entry.id, kind: entry.kind, result: null });
    } else {
      if (known === undefined || known.result !== null) throw malformed();
      known.result = entry.result;
    }
    start = end + 1;
  }
  return { exists: true, size: bytes.length, effects };
}

// Appends one line to the log that was just parsed: an absent log is created exclusively, an
// existing one is opened append-only, never through a symlink, and must still be the parsed file.
function appendEffect(root, log, entry) {
  const line = `${JSON.stringify(entry)}\n`;
  parseEffectLine(line.slice(0, -1));
  const create = log.exists ? 0 : constants.O_CREAT | constants.O_EXCL;
  let fd;
  try {
    fd = openSync(join(root, EFFECT_LOG_PATH), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | create, 0o644);
  } catch (error) {
    if (['ELOOP', 'EEXIST', 'ENOENT'].includes(error.code)) throw refuse(`${EFFECT_LOG_PATH} changed before the append`);
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== log.size) throw refuse(`${EFFECT_LOG_PATH} changed before the append`);
    writeAllSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!log.exists) fsyncDirectory(join(root, INCEPTION_AREA));
}

function effectStatus(log) {
  const effects = [...log.effects.values()].map(({ id, kind, result }) => (
    result === null ? { id, kind, state: 'uncertain' } : { id, kind, state: 'concluded', result }
  ));
  return { effects, uncertain: effects.filter((effect) => effect.state === 'uncertain').length };
}

function assertActive(descriptor, command) {
  if (descriptor.status !== 'active') {
    throw refuse(`${command} needs status active; the run is ${descriptor.status}`);
  }
}

function assertEffectId(id) {
  if (!isEffectId(id)) throw refuse(`--id must match ${EFFECT_ID_PATTERN.source}: ${JSON.stringify(id)}`);
}

function effectIntentRun(repoRoot, { id, kind, summary, authorization, now = new Date() } = {}) {
  const root = resolveRepoRoot(repoRoot);
  assertEffectId(id);
  if (!EFFECT_KINDS.includes(kind)) throw usage(`--kind must be one of ${EFFECT_KINDS.join(' | ')}`);
  assertText(summary, '--summary');
  if (authorization !== undefined) assertText(authorization, '--authorization');
  if (AUTHORIZED_KINDS.includes(kind) && authorization === undefined) {
    throw refuse(`--authorization is required for an effect of kind ${kind}`);
  }
  const descriptor = loadDescriptor(root);
  assertActive(descriptor, 'effect intent');
  const log = readEffectLog(root);
  if (log.effects.has(id)) throw refuse(`effect ${id} is already in the effect log`);
  const effect = {
    schema: EFFECT_SCHEMA,
    type: 'intent',
    id,
    kind,
    summary,
    authorization: authorization ?? null,
    phase: descriptor.phase,
    at: now.toISOString(),
  };
  appendEffect(root, log, effect);
  return { effect };
}

function effectOutcomeRun(repoRoot, { id, result, observed, now = new Date() } = {}) {
  const root = resolveRepoRoot(repoRoot);
  assertEffectId(id);
  if (!EFFECT_RESULTS.includes(result)) throw usage(`--result must be one of ${EFFECT_RESULTS.join(' | ')}`);
  assertText(observed, '--observed');
  const descriptor = loadDescriptor(root);
  assertActive(descriptor, 'effect outcome');
  const log = readEffectLog(root);
  const known = log.effects.get(id);
  if (known === undefined) throw refuse(`effect ${id} has no intent in the effect log`);
  if (known.result !== null) throw refuse(`effect ${id} already has an outcome`);
  const effect = { schema: EFFECT_SCHEMA, type: 'outcome', id, result, observed, phase: descriptor.phase, at: now.toISOString() };
  appendEffect(root, log, effect);
  return { effect };
}

function effectIntentCommand(root, values) {
  return {
    ok: true,
    fields: effectIntentRun(root, { id: values.id, kind: values.kind, summary: values.summary, authorization: values.authorization }),
  };
}

function effectOutcomeCommand(root, values) {
  return { ok: true, fields: effectOutcomeRun(root, { id: values.id, result: values.result, observed: values.observed }) };
}

function effectStatusCommand(root) {
  loadDescriptor(root);
  return { ok: true, fields: effectStatus(readEffectLog(root)) };
}

// ---------------------------------------------------------------------------
// checkpoint create and verify (HC10, HC14)
// ---------------------------------------------------------------------------

export const CHECKPOINT_SCHEMA = 'steepy-inception-checkpoint/v1';
const CHECKPOINT_KEYS = Object.freeze(['schema', 'runId', 'record', 'at', 'label', 'phase', 'files', 'git']);
const GIT_STATE_KEYS = Object.freeze(['present', 'branch', 'head', 'status']);
const HEAD_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const MAX_APPLICATION_PATH_BYTES = 4096;

// Application paths (HC5). `assertSafeRelPath`'s character set would refuse ordinary names such
// as `app/[id]/page.tsx`, so this validator only refuses what is never a project file path. The
// area check ignores case, so a case-insensitive filesystem cannot alias a run file.
function applicationPathProblem(value) {
  if (typeof value !== 'string' || value.length === 0) return 'must be a non-empty path';
  if (Buffer.byteLength(value, 'utf8') > MAX_APPLICATION_PATH_BYTES) return `must be at most ${MAX_APPLICATION_PATH_BYTES} UTF-8 bytes`;
  if (/[\x00-\x1F\x7F]/u.test(value)) return 'must not contain a control character';
  if (value.startsWith('/')) return 'must be relative';
  if (value.includes('\\')) return 'must not contain a backslash';
  if (value.endsWith('/')) return 'must not end with /';
  if (value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'must not contain an empty, . or .. segment';
  }
  const folded = value.toLowerCase();
  if (folded === INCEPTION_AREA || folded.startsWith(`${INCEPTION_AREA}/`)) return `must not be under ${INCEPTION_AREA}/`;
  return null;
}

function isApplicationPath(value) {
  return applicationPathProblem(value) === null;
}

function assertApplicationPath(value, option) {
  const problem = applicationPathProblem(value);
  if (problem !== null) throw refuse(`${option} ${problem}: ${JSON.stringify(value)}`);
  return value;
}

// Branch, HEAD, and sorted porcelain status (HC10), or `{ present: false }` without Git.
// `--no-optional-locks` keeps `git status` from refreshing the index, so verifying never writes.
function observeGitState(root, env) {
  const { present, branch } = observeGit(root, env);
  if (!present) return { present: false };
  const head = runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], env);
  if (head.error) throw refuse(`git could not be run: ${head.error.message}`);
  const status = runGit(root, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], env);
  if (status.error) throw refuse(`git could not be run: ${status.error.message}`);
  if (status.status !== 0) throw refuse(`git status failed: ${status.stderr.trim().split('\n')[0]}`);
  return {
    present: true,
    branch,
    head: head.status === 0 ? head.stdout.trim() : null,
    status: status.stdout.split('\0').filter((entry) => entry !== '').sort(),
  };
}

function validateGitState(git) {
  if (isPlainObject(git) && git.present === false) {
    expectKeys(git, ['present'], 'git');
    return;
  }
  expectKeys(git, GIT_STATE_KEYS, 'git');
  if (git.present !== true) fail('git.present must be a boolean');
  if (git.branch !== null && (typeof git.branch !== 'string' || git.branch === '')) fail('git.branch must be a non-empty string or null');
  if (git.head !== null && (typeof git.head !== 'string' || !HEAD_PATTERN.test(git.head))) fail('git.head must be a commit id or null');
  if (!Array.isArray(git.status)) fail('git.status must be an array');
  git.status.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry === '') fail(`git.status[${index}] must be a non-empty string`);
    if (index > 0 && git.status[index - 1] > entry) fail('git.status must be sorted');
  });
}

function parseCheckpointRecord(text, { runId, number }) {
  const value = parseStrictJson(text, 'checkpoint record');
  expectKeys(value, CHECKPOINT_KEYS, 'checkpoint record');
  if (value.schema !== CHECKPOINT_SCHEMA) fail(`schema must be ${CHECKPOINT_SCHEMA}`);
  if (value.runId !== runId) fail(`runId must be ${runId}`);
  if (value.record !== number) fail(`record must be ${number}`);
  if (!isTimestamp(value.at)) fail('at must be an ISO timestamp');
  if (!isSafeText(value.label)) fail('label must be single-line text');
  expectOneOf(value.phase, PHASES, 'phase');
  validateDigestList(value.files, 'files', isApplicationPath);
  validateGitState(value.git);
  return value;
}

// The `--files-from` list: an area file, strict UTF-8, one application path per line, blank
// lines ignored.
function readFileList(root, relative) {
  assertAreaFile(root, relative);
  const lines = decodeAreaText(readAreaFile(root, relative), relative).split('\n');
  return lines.filter((line) => line.trim() !== '').map((line) => assertApplicationPath(line, `--files-from ${relative} line`));
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// Every divergence between a checkpoint record and the current files and Git state (HC14).
function checkpointDivergences(root, record, env) {
  const divergences = [];
  for (const file of record.files) {
    const observed = inspectFile(root, file.path, { singleLink: false });
    if (observed.state === 'missing') divergences.push({ kind: 'file-missing', path: file.path });
    else if (observed.state === 'unsafe') divergences.push({ kind: 'file-unsafe', path: file.path });
    else if (observed.bytes !== file.bytes || observed.sha256 !== file.sha256) {
      divergences.push({
        kind: 'file-changed',
        path: file.path,
        expected: { bytes: file.bytes, sha256: file.sha256 },
        observed: { bytes: observed.bytes, sha256: observed.sha256 },
      });
    }
  }
  const git = observeGitState(root, env);
  if (git.present !== record.git.present) {
    divergences.push({ kind: 'git-presence', expected: record.git.present, observed: git.present });
  } else if (git.present) {
    if (git.branch !== record.git.branch) divergences.push({ kind: 'branch', expected: record.git.branch, observed: git.branch });
    if (git.head !== record.git.head) divergences.push({ kind: 'head', expected: record.git.head, observed: git.head });
    if (!sameStrings(git.status, record.git.status)) divergences.push({ kind: 'status', expected: record.git.status, observed: git.status });
  }
  return divergences;
}

function verifyCheckpointRecord(root, descriptor, path, env) {
  const record = readRecord(root, descriptor, 'checkpoints', path, parseCheckpointRecord);
  return { record, divergences: checkpointDivergences(root, record, env) };
}

function checkpointCreateRun(repoRoot, {
  label,
  files = [],
  filesFrom,
  now = new Date(),
  replaceFile = replaceFileAtomic,
  env = process.env,
} = {}) {
  const root = resolveRepoRoot(repoRoot);
  assertText(label, '--label');
  for (const path of files) assertApplicationPath(path, '--file');
  if (filesFrom !== undefined) assertAreaPath(filesFrom, '--files-from');
  const descriptor = loadDescriptor(root);
  assertActive(descriptor, 'checkpoint create');
  const paths = [...files, ...(filesFrom === undefined ? [] : readFileList(root, filesFrom))].sort();
  if (paths.length === 0) throw refuse('checkpoint create needs at least one file (--file or --files-from)');
  paths.forEach((path, index) => {
    if (index > 0 && paths[index - 1] === path) throw refuse(`checkpoint create names ${path} more than once`);
  });
  const digests = paths.map((path) => digestFile(root, path, { singleLink: false }));
  const git = observeGitState(root, env);
  const checkpoint = writeRecord(root, descriptor, 'checkpoints', (record) => `${JSON.stringify({
    schema: CHECKPOINT_SCHEMA,
    runId: descriptor.runId,
    record,
    at: now.toISOString(),
    label,
    phase: descriptor.phase,
    files: digests,
    git,
  }, null, 2)}\n`, replaceFile);
  return { checkpoint, files: digests };
}

function checkpointCreateCommand(root, values) {
  return {
    ok: true,
    fields: checkpointCreateRun(root, { label: values.label, files: values.file, filesFrom: values['files-from'] }),
  };
}

function checkpointVerifyCommand(root, values) {
  const descriptor = loadDescriptor(root);
  const checkpoint = selectBoundRecord(descriptor, 'checkpoints', values.checkpoint, '--checkpoint');
  const { divergences } = verifyCheckpointRecord(root, descriptor, checkpoint, process.env);
  if (divergences.length > 0) {
    return { ok: false, fields: { checkpoint, divergences }, error: `${checkpoint} diverges: ${describeDivergences(divergences)}` };
  }
  return { ok: true, fields: { checkpoint } };
}

// HC9 gate for verification -> complete. `--checkpoint` is the last recorded checkpoint and
// verifies clean, `--verification` is an ordinary single-link file under `verification/`, and no
// effect is uncertain. Returns the two descriptor bindings; reads only.
function completeGate(root, descriptor, { checkpoint, verification }, env) {
  if (checkpoint === undefined || verification === undefined) {
    throw refuse('verification -> complete needs --checkpoint and --verification');
  }
  assertAreaPath(checkpoint, '--checkpoint', RECORD_KINDS.checkpoints.directory);
  const last = descriptor.checkpoints.at(-1);
  if (checkpoint !== last) throw refuse(`--checkpoint must be the last recorded checkpoint (${last ?? 'none is recorded'})`);
  const { divergences } = verifyCheckpointRecord(root, descriptor, checkpoint, env);
  if (divergences.length > 0) {
    throw refuse(`verification -> complete refused: ${checkpoint} diverges: ${describeDivergences(divergences)}`);
  }
  assertAreaPath(verification, '--verification', VERIFICATION_PREFIX);
  const bound = digestFile(root, verification, { singleLink: true });
  const { uncertain } = effectStatus(readEffectLog(root));
  if (uncertain > 0) throw refuse(`verification -> complete refused: ${uncertain} uncertain effect(s) in the effect log`);
  return { finalCheckpoint: checkpoint, verification: bound };
}

// ---------------------------------------------------------------------------
// abandon (HC15)
// ---------------------------------------------------------------------------

export const ABANDON_SCHEMA = 'steepy-inception-abandon/v1';
const ABANDON_KEYS = Object.freeze(['schema', 'runId', 'at', 'reason', 'phase', 'status']);

function parseAbandonRecord(text) {
  const value = parseStrictJson(text, 'abandon.json');
  expectKeys(value, ABANDON_KEYS, 'abandon.json');
  if (value.schema !== ABANDON_SCHEMA) fail(`abandon.json schema must be ${ABANDON_SCHEMA}`);
  if (typeof value.runId !== 'string' || !RUN_ID_PATTERN.test(value.runId)) fail('abandon.json runId is malformed');
  if (!isTimestamp(value.at)) fail('abandon.json at must be an ISO timestamp');
  if (!isSafeText(value.reason)) fail('abandon.json reason must be single-line text');
  expectOneOf(value.phase, PHASES, 'abandon.json phase');
  expectOneOf(value.status, STATUSES, 'abandon.json status');
  return value;
}

// Moves every present run child into `abandoned/<runId>/`, descriptor last. Nothing is deleted
// and the descriptor is never rewritten. An archive that already holds this run's record is an
// interrupted abandon and resumes.
function abandonRun(repoRoot, { reason, now = new Date() } = {}) {
  const root = resolveRepoRoot(repoRoot);
  assertText(reason, '--reason');
  const descriptor = loadDescriptor(root);
  const archive = `${ABANDONED_DIR}/${descriptor.runId}`;
  const abandonedExists = realDirectory(root, ABANDONED_DIR);
  const archiveExists = abandonedExists && realDirectory(root, archive);
  if (archiveExists) {
    const recordPath = `${archive}/abandon.json`;
    if (lstatOrNull(join(root, recordPath)) === null) throw refuse(`${archive} exists without abandon.json`);
    let record;
    try {
      record = parseAbandonRecord(decodeAreaText(readAreaFile(root, recordPath), recordPath));
    } catch (error) {
      throw refuse(`${recordPath} is invalid: ${message(error)}`);
    }
    if (record.runId !== descriptor.runId) throw refuse(`${recordPath} belongs to runId ${record.runId}`);
  }
  const moves = [];
  for (const child of RUN_CHILDREN) {
    const source = `${INCEPTION_AREA}/${child}`;
    const target = `${archive}/${child}`;
    if (lstatOrNull(join(root, source)) === null) continue;
    if (archiveExists && lstatOrNull(join(root, target)) !== null) {
      throw refuse(`ambiguous abandon: both ${source} and ${target} exist`);
    }
    moves.push([source, target]);
  }

  if (!archiveExists) {
    if (!abandonedExists) createDirectory(root, ABANDONED_DIR);
    createDirectory(root, archive);
    createFileExclusive(join(root, archive, 'abandon.json'), `${JSON.stringify({
      schema: ABANDON_SCHEMA,
      runId: descriptor.runId,
      at: now.toISOString(),
      reason,
      phase: descriptor.phase,
      status: descriptor.status,
    }, null, 2)}\n`);
  }
  for (const [source, target] of moves) renameSync(join(root, source), join(root, target));
  fsyncDirectory(join(root, archive));
  fsyncDirectory(join(root, INCEPTION_AREA));
  return { archive };
}

function abandonCommand(root, values) {
  return { ok: true, fields: abandonRun(root, { reason: values.reason }) };
}

// ---------------------------------------------------------------------------
// CLI (HC1, HC6, HC7)
// ---------------------------------------------------------------------------

const REPO_ROOT_OPTION = Object.freeze({ type: 'string' });
const STRING_OPTION = Object.freeze({ type: 'string' });
const GIT_COMMITS_CHOICES = Object.freeze(['allowed', 'forbidden']);

const COMMANDS = Object.freeze({
  classify: {
    options: { 'repo-root': REPO_ROOT_OPTION, maturity: STRING_OPTION },
    required: [],
    enums: { maturity: MATURITIES },
    run: classifyCommand,
  },
  start: {
    options: { 'repo-root': REPO_ROOT_OPTION, harness: STRING_OPTION, capabilities: STRING_OPTION, 'git-commits': STRING_OPTION },
    required: ['harness', 'capabilities', 'git-commits'],
    enums: { 'git-commits': GIT_COMMITS_CHOICES },
    parsers: { capabilities: parseCapabilities },
    run: startCommand,
  },
  transition: {
    options: {
      'repo-root': REPO_ROOT_OPTION,
      to: STRING_OPTION,
      reason: STRING_OPTION,
      'git-commits': STRING_OPTION,
      checkpoint: STRING_OPTION,
      verification: STRING_OPTION,
    },
    required: ['to', 'reason'],
    enums: { to: TRANSITION_TARGETS, 'git-commits': GIT_COMMITS_CHOICES },
    run: transitionCommand,
  },
  'resume-note': {
    options: {
      'repo-root': REPO_ROOT_OPTION,
      next: STRING_OPTION,
      need: { type: 'string', multiple: true },
      note: STRING_OPTION,
    },
    required: ['next'],
    enums: {},
    run: resumeNoteCommand,
  },
  approve: {
    options: { 'repo-root': REPO_ROOT_OPTION, statement: STRING_OPTION, document: { type: 'string', multiple: true } },
    required: ['statement', 'document'],
    enums: {},
    run: approveCommand,
  },
  'verify-approval': {
    options: { 'repo-root': REPO_ROOT_OPTION, approval: STRING_OPTION },
    required: [],
    enums: {},
    run: verifyApprovalCommand,
  },
  // A command family: the second positional names the subcommand, and the output names both.
  effect: {
    subcommands: {
      intent: {
        options: {
          'repo-root': REPO_ROOT_OPTION,
          id: STRING_OPTION,
          kind: STRING_OPTION,
          summary: STRING_OPTION,
          authorization: STRING_OPTION,
        },
        required: ['id', 'kind', 'summary'],
        enums: { kind: EFFECT_KINDS },
        run: effectIntentCommand,
      },
      outcome: {
        options: { 'repo-root': REPO_ROOT_OPTION, id: STRING_OPTION, result: STRING_OPTION, observed: STRING_OPTION },
        required: ['id', 'result', 'observed'],
        enums: { result: EFFECT_RESULTS },
        run: effectOutcomeCommand,
      },
      status: {
        options: { 'repo-root': REPO_ROOT_OPTION },
        required: [],
        enums: {},
        run: effectStatusCommand,
      },
    },
  },
  checkpoint: {
    subcommands: {
      create: {
        options: {
          'repo-root': REPO_ROOT_OPTION,
          label: STRING_OPTION,
          file: { type: 'string', multiple: true },
          'files-from': STRING_OPTION,
        },
        required: ['label'],
        enums: {},
        run: checkpointCreateCommand,
      },
      verify: {
        options: { 'repo-root': REPO_ROOT_OPTION, checkpoint: STRING_OPTION },
        required: [],
        enums: {},
        run: checkpointVerifyCommand,
      },
    },
  },
  abandon: {
    options: { 'repo-root': REPO_ROOT_OPTION, reason: STRING_OPTION },
    required: ['reason'],
    enums: {},
    run: abandonCommand,
  },
});

const COMMAND_SPECS = Object.freeze(Object.values(COMMANDS).flatMap((spec) => (
  spec.subcommands ? Object.values(spec.subcommands) : [spec]
)));
// Every option of every command, so the command lookup never mistakes an option value for a positional.
const ALL_OPTIONS = Object.freeze(Object.assign({}, ...COMMAND_SPECS.map((spec) => spec.options)));

function oneLine(value) {
  return String(value).replace(/[\x00-\x1F\x7F\u2028\u2029]/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// Resolves the command (and a family's subcommand) from the positionals. `command` is what the
// output names: the HC7 spelling such as `effect intent`, or the family alone when its
// subcommand is missing or unknown.
function resolveCommand(argv) {
  const { positionals } = parseArgs({ args: argv, options: ALL_OPTIONS, strict: false, allowPositionals: true });
  const [first, second] = positionals;
  if (first === undefined) return { command: null, error: usage('missing command') };
  if (!Object.hasOwn(COMMANDS, first)) return { command: first, error: usage(`unknown command: ${JSON.stringify(first)}`) };
  const spec = COMMANDS[first];
  if (!spec.subcommands) return { command: first, spec, positionals: 1 };
  const choices = Object.keys(spec.subcommands).join(' | ');
  if (second === undefined) return { command: first, error: usage(`missing ${first} subcommand (${choices})`) };
  if (!Object.hasOwn(spec.subcommands, second)) {
    return { command: first, error: usage(`unknown ${first} subcommand: ${JSON.stringify(second)} (${choices})`) };
  }
  return { command: `${first} ${second}`, spec: spec.subcommands[second], positionals: 2 };
}

function parseCommandArgs(argv, spec, positionalCount) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: spec.options, strict: true, allowPositionals: true, tokens: true });
  } catch (error) {
    throw usage(message(error).split('\n')[0]);
  }
  const { values, positionals, tokens } = parsed;
  if (positionals.length !== positionalCount) throw usage(`unexpected argument: ${JSON.stringify(positionals[positionalCount])}`);
  const seen = new Set();
  for (const token of tokens) {
    if (token.kind !== 'option' || spec.options[token.name].multiple) continue;
    if (seen.has(token.name)) throw usage(`--${token.name} given more than once`);
    seen.add(token.name);
  }
  for (const name of spec.required) {
    if (values[name] === undefined) throw usage(`missing required option --${name}`);
  }
  for (const [name, allowed] of Object.entries(spec.enums)) {
    if (values[name] !== undefined && !allowed.includes(values[name])) {
      throw usage(`--${name} must be one of ${allowed.join(' | ')}`);
    }
  }
  const parsedValues = { ...values };
  for (const [name, parse] of Object.entries(spec.parsers ?? {})) {
    if (parsedValues[name] !== undefined) parsedValues[name] = parse(parsedValues[name]);
  }
  return parsedValues;
}

function resolveRepoRoot(value) {
  const requested = value ?? process.cwd();
  let root;
  try {
    root = realpathSync(requested);
  } catch {
    throw refuse('--repo-root must be an existing directory');
  }
  if (!statSync(root).isDirectory()) throw refuse('--repo-root must be an existing directory');
  return root;
}

function emit(fd, line) {
  writeAllSync(fd, `${line}\n`);
}

export function main(argv = process.argv.slice(2)) {
  let command = null;
  let result;
  let exitCode;
  try {
    const resolved = resolveCommand(argv);
    command = resolved.command;
    if (resolved.error) throw resolved.error;
    const values = parseCommandArgs(argv, resolved.spec, resolved.positionals);
    result = resolved.spec.run(resolveRepoRoot(values['repo-root']), values);
    exitCode = result.ok ? 0 : 1;
  } catch (error) {
    result = { ok: false, fields: {}, error: message(error) };
    exitCode = error instanceof InceptionError ? error.exitCode : 1;
  }
  const output = { ok: result.ok, command, ...result.fields };
  if (!result.ok) {
    output.error = oneLine(result.error);
    emit(1, JSON.stringify(output));
    emit(2, `inception-state: ${output.error}`);
  } else {
    emit(1, JSON.stringify(output));
  }
  return exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());

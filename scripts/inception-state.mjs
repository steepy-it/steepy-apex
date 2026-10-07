// Records and verifies inception run state under `.apex/inception/`. The helper never asks
// questions, chooses a phase, approves, or runs project commands: the inception skill decides,
// and this module only validates and records. It reads fixed paths only and never lists a
// directory, so a stray file in the area can never change what it reports.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('run descriptor is not valid JSON');
  }
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

// Reads an area file that must be an ordinary, non-symlink file with exactly one link (PD3c).
function readAreaFile(root, relative) {
  const absolute = join(root, relative);
  const stat = lstatOrNull(absolute);
  if (stat === null) throw refuse(`${relative} does not exist`);
  if (!stat.isFile()) throw refuse(`${relative} is not an ordinary file`);
  if (stat.nlink !== 1) throw refuse(`${relative} has more than one hard link`);
  let fd;
  try {
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ELOOP') throw refuse(`${relative} is not an ordinary file`);
    throw error;
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino || opened.dev !== stat.dev) {
      throw refuse(`${relative} changed while it was read`);
    }
    const chunks = [];
    const buffer = Buffer.alloc(65536);
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    return Buffer.concat(chunks);
  } finally {
    closeSync(fd);
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
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
    const descriptor = parseRunDescriptor(readAreaFile(root, RUN_DESCRIPTOR_PATH).toString('utf8'));
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
// byte-identical and removes only the temp file.
export function replaceFileAtomic(absolutePath, bytes, { writeToFd = writeSync } = {}) {
  const directory = dirname(absolutePath);
  const temp = join(directory, `.${basename(absolutePath)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let fd = openSync(temp, 'wx', 0o644);
  try {
    writeAllSync(fd, bytes, writeToFd);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, absolutePath);
  } catch (error) {
    try {
      if (fd !== null) closeSync(fd);
      unlinkSync(temp);
    } catch {
      // The original failure is the one reported.
    }
    throw error;
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

function runGit(root, args) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

function observeGit(root) {
  const inside = runGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.error) {
    if (inside.error.code === 'ENOENT') return { present: false, branch: null };
    throw refuse(`git could not be run: ${inside.error.message}`);
  }
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return { present: false, branch: null };
  const branch = runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
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

  const observed = observeGit(root);
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

// Task 2 owns these gates; until then both edges refuse with a fixed diagnostic.
const GATED_EDGES = Object.freeze(['approval -> bootstrap', 'verification -> complete']);

function isReturnToApproval(descriptor, to) {
  return to === 'approval' && (descriptor.phase === 'bootstrap' || descriptor.phase === 'verification');
}

// Pure: returns the next descriptor for an accepted transition, or throws a refusal.
function applyTransition(descriptor, { to, reason, gitCommits, checkpoint, verification, now }) {
  const from = { phase: descriptor.phase, status: descriptor.status };
  if (descriptor.status === 'complete') throw refuse('the run is complete: no transition is allowed');
  let { phase, status, approvalEntry } = descriptor;
  if (to === 'active') {
    if (descriptor.status !== 'blocked') throw refuse('the run is not blocked: --to active only resumes a blocked run');
    status = 'active';
  } else if (descriptor.status === 'blocked') {
    throw refuse('the run is blocked: --to active is the only transition allowed');
  } else if (to === 'blocked') {
    status = 'blocked';
  } else {
    const edge = `${descriptor.phase} -> ${to}`;
    const forward = PHASES.indexOf(to) === PHASES.indexOf(descriptor.phase) + 1;
    if (forward && GATED_EDGES.includes(edge)) throw refuse(`gated transition not available: ${edge}`);
    if (!forward && !isReturnToApproval(descriptor, to)) throw refuse(`transition not allowed: ${edge}`);
    phase = to;
    if (to === 'approval') approvalEntry = descriptor.approvals.length;
  }
  if (gitCommits !== undefined && !isReturnToApproval(descriptor, to)) {
    throw refuse('--git-commits is allowed only on a return to approval');
  }
  if (checkpoint !== undefined || verification !== undefined) {
    throw refuse('--checkpoint and --verification are allowed only on verification -> complete');
  }
  // Without Git the policy stays `none`, as `start` records it (HC10).
  const commits = gitCommits !== undefined && descriptor.git.present ? gitCommits : descriptor.git.commits;
  return {
    ...descriptor,
    phase,
    status,
    git: { ...descriptor.git, commits },
    approvalEntry,
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
  const next = applyTransition(loadDescriptor(root), { to, reason, gitCommits, checkpoint, verification, now });
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

// Reserve the record number first, create the note, then bind it (HC4).
function writeResumeNote(repoRoot, { next, needs = [], note, replaceFile = replaceFileAtomic } = {}) {
  const root = resolveRepoRoot(repoRoot);
  assertText(next, '--next');
  if (note !== undefined) assertText(note, '--note');
  for (const need of needs) assertAreaPath(need, '--need');
  const descriptor = loadDescriptor(root);
  for (const need of needs) assertAreaFile(root, need);
  const number = descriptor.nextRecord;
  const notePath = recordPath('resumeNotes', number);
  const directoryExists = realDirectory(root, RESUME_NOTES_DIR);
  if (directoryExists && lstatOrNull(join(root, notePath)) !== null) throw refuse(`${notePath} already exists`);
  const bytes = renderResumeNote({ number, descriptor, next, needs, note });

  const reserved = { ...descriptor, nextRecord: number + 1 };
  writeDescriptor(root, reserved, replaceFile);
  if (!directoryExists) createDirectory(root, RESUME_NOTES_DIR);
  createFileExclusive(join(root, notePath), bytes);
  fsyncDirectory(join(root, RESUME_NOTES_DIR));
  writeDescriptor(root, { ...reserved, resumeNotes: [...descriptor.resumeNotes, notePath] }, replaceFile);
  return { note: notePath };
}

function resumeNoteCommand(root, values) {
  return { ok: true, fields: writeResumeNote(root, { next: values.next, needs: values.need, note: values.note }) };
}

// ---------------------------------------------------------------------------
// abandon (HC15)
// ---------------------------------------------------------------------------

export const ABANDON_SCHEMA = 'steepy-inception-abandon/v1';
const ABANDON_KEYS = Object.freeze(['schema', 'runId', 'at', 'reason', 'phase', 'status']);

function parseAbandonRecord(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('abandon.json is not valid JSON');
  }
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
      record = parseAbandonRecord(readAreaFile(root, recordPath).toString('utf8'));
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
  abandon: {
    options: { 'repo-root': REPO_ROOT_OPTION, reason: STRING_OPTION },
    required: ['reason'],
    enums: {},
    run: abandonCommand,
  },
});

const ALL_OPTIONS = Object.freeze(Object.assign({}, ...Object.values(COMMANDS).map((spec) => spec.options)));

function oneLine(value) {
  return String(value).replace(/[\x00-\x1F\x7F\u2028\u2029]/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function commandName(argv) {
  const { positionals } = parseArgs({ args: argv, options: ALL_OPTIONS, strict: false, allowPositionals: true });
  return positionals.length > 0 ? positionals[0] : null;
}

function parseCommandArgs(argv, spec) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: spec.options, strict: true, allowPositionals: true, tokens: true });
  } catch (error) {
    throw usage(message(error).split('\n')[0]);
  }
  const { values, positionals, tokens } = parsed;
  if (positionals.length !== 1) throw usage(`unexpected argument: ${JSON.stringify(positionals[1])}`);
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
    command = commandName(argv);
    if (command === null) throw usage('missing command');
    if (!Object.hasOwn(COMMANDS, command)) throw usage(`unknown command: ${JSON.stringify(command)}`);
    const spec = COMMANDS[command];
    const values = parseCommandArgs(argv, spec);
    result = spec.run(resolveRepoRoot(values['repo-root']), values);
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

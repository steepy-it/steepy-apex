// Records and verifies inception run state under `.apex/inception/`. The helper never asks
// questions, chooses a phase, approves, or runs project commands: the inception skill decides,
// and this module only validates and records. Run evidence is read by exact references;
// the separate snapshot module inventories application roots without listing local work areas.
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
  readFileSync,
  readSync,
  readdirSync,
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
import { RUN_CHILDREN_V2, validateSnapshotScope, ABANDON_INTENT_SCHEMA_V2, ABANDON_SCHEMA_V2, ABANDON_RECEIPT_SCHEMA_V2, parseAbandonRecordV2, serializeAbandonRecordV2, RUN_SCHEMA_V2, createRunDescriptorV2, parseRunDescriptorV2, serializeRunDescriptorV2, validateId, validatePath, validateRef, preparePublication, publicationRef, publicationStagingDirectory, readPublicationFile, stagePublicationTargets, verifyPublicationTargets, parseStrictJson as parseV2Json, parseInceptionRecord, serializeInceptionRecord, parseVerificationContract, validateText, validateEnvironment, validateManualInput, CAPTURE_SCHEMA_V2, parseCaptureReceipt, serializeCaptureReceipt, publicationFileRef, renderVerificationReport } from './inception-protocol.mjs';
import { observeApplication, applicationIdentity, applicationChanges, withApplicationSnapshotLease } from './inception-snapshot.mjs';
import { withProjectScaffoldLock } from './project-scaffold.mjs';
import { verifyGovernance as verifyCanonicalGovernance } from './inception-governance.mjs';
export { RUN_SCHEMA_V2, createRunDescriptorV2 } from './inception-protocol.mjs';

export const INCEPTION_AREA = '.apex/inception';
export const INCEPTION_GITIGNORE = `${INCEPTION_AREA}/.gitignore`;
export const INCEPTION_GITIGNORE_BYTES = '*\n';
export const RUN_DESCRIPTOR_PATH = `${INCEPTION_AREA}/run.json`;
export const HUB_INDEX_PATH = '.apex/_INDEX.md';
export const RESUME_NOTES_DIR = `${INCEPTION_AREA}/resume-notes`;
export const ABANDONED_DIR = `${INCEPTION_AREA}/abandoned`;

// Abandon order: `run.json` moves last, so a present descriptor always means an unfinished run.
export const RUN_CHILDREN = RUN_CHILDREN_V2;

export const PHASES = Object.freeze([
  'reconnaissance', 'architecture', 'research', 'approval', 'bootstrap', 'verification', 'complete',
]);
export const STATUSES = Object.freeze(['active', 'blocked', 'complete']);
export const CAPABILITIES = Object.freeze(['shell', 'network', 'browser', 'subagents', 'question-tool', 'headless']);

export const RUN_SCHEMA = RUN_SCHEMA_V2;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const MAX_LINE_CHARACTERS = 1000;

// One record counter is shared by approvals, checkpoints, and resume notes.
const RECORD_KINDS = Object.freeze({
  approvals: Object.freeze({ directory: `${INCEPTION_AREA}/approvals/`, extension: '.json' }),
  checkpoints: Object.freeze({ directory: `${INCEPTION_AREA}/checkpoints/`, extension: '.json' }),
  resumeNotes: Object.freeze({ directory: `${RESUME_NOTES_DIR}/`, extension: '.md' }),
});
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

// ---------------------------------------------------------------------------
// Run descriptor (HC3)
// ---------------------------------------------------------------------------

export function parseRunDescriptor(text) {
  if (typeof text !== 'string') fail('run descriptor must be text');
  const value = parseStrictJson(text, 'run descriptor');
  if (value?.schema !== RUN_SCHEMA_V2) {
    fail(`run descriptor schema ${JSON.stringify(value?.schema ?? null)} is unsupported; supported: ${RUN_SCHEMA_V2}`);
  }
  return parseRunDescriptorV2(text);
}

export function serializeRunDescriptor(descriptor) {
  return serializeRunDescriptorV2(descriptor);
}

// `capabilities` lists the enabled capability names; every other capability is recorded false.
export function createRunDescriptor(options) {
  return createRunDescriptorV2(options);
}

export function nextStepFor(descriptor) {
  if (descriptor.pending) return `publish resume --reservation ${descriptor.pending.id}; do not rerun the application operation`;
  if (descriptor.status === 'complete') return 'verify-complete before running the init skill, then the discovery skill with the inception source';
  if (descriptor.activeUnit !== null) return `observe unit ${descriptor.activeUnit}; unit finish, reconcile, or close-incomplete only after writer stop`;
  if (descriptor.status === 'blocked' || descriptor.blocks.length) return 'resolve each named human block with block resolve and observe uncertain effects; transition --to active only when all blocks and effects are resolved';
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
  if (observed.run !== 'invalid' && observed.hub !== 'invalid') {
    const abandoned = inspectAbandon(root);
    if (abandoned?.intent.status === 'prepared') return { ok: true, fields: { row: 'resume-abandon', hub: observed.hub, run: 'abandoning', nextStep: 'resume abandon with --resume' } };
  }
  const row = classifyState({ hub: observed.hub, run: observed.run, maturity: values.maturity });
  const fields = { row, hub: observed.hub, run: observed.run };
  if (observed.descriptor !== null && row !== 'invalid-state') fields.nextStep = nextStepFor(observed.descriptor);
  if (row === 'invalid-state') return { ok: false, fields, error: observed.error };
  return { ok: true, fields };
}

// Version inspection reads the descriptor only; it neither discovers nor opens its refs.
function inspectCommand(root) {
  const descriptor = loadDescriptor(root);
  const inputPaths = new Set([RUN_DESCRIPTOR_PATH]);
  const collect = value => {
    if (value === null || typeof value !== 'object') return;
    if (typeof value.path === 'string' && Object.hasOwn(value, 'bytes') && Object.hasOwn(value, 'sha256')) inputPaths.add(value.path);
    for (const child of Object.values(value)) collect(child);
  };
  collect(descriptor);
  return { ok: true, fields: {
    format: descriptor.schema, runId: descriptor.runId, phase: descriptor.phase, status: descriptor.status,
    allowedActions: ['classify', 'inspect', 'resume-check', 'verify-approval', 'checkpoint verify', 'effect status', 'verify-complete', ...(descriptor.pending ? ['publish resume'] : descriptor.status === 'complete' ? ['resume-note', 'abandon'] : descriptor.activeUnit ? ['unit finish', 'unit reconcile', 'unit close-incomplete', 'effect intent', 'effect outcome', 'effect reconcile', 'block resolve'] : ['unit begin', 'block resolve', 'transition', 'approve', 'checkpoint create', 'verification begin', 'verification resume', 'verification status', 'verification attest', 'verification summarize', 'resume-note', 'abandon'])],
    inputPaths: [...inputPaths], nextStep: nextStepFor(descriptor),
  } };
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
export function startRun(repoRoot, options = {}) {
  return withInceptionLease(repoRoot, options, startRunUnlocked);
}

function startRunUnlocked(repoRoot, {
  harnessName,
  capabilities = [],
  gitCommits,
  exclusions = [],
  now = new Date(),
  randomHex = randomBytes(4).toString('hex'),
  replaceFile = replaceFileAtomic,
  env = process.env,
} = {}, preflight = false) {
  const root = resolveRepoRoot(repoRoot);
  if (typeof harnessName !== 'string' || !SLUG_PATTERN.test(harnessName)) {
    throw refuse('--harness must be a safe slug (lowercase letters, digits, dashes; at most 40 characters)');
  }
  if (gitCommits !== 'allowed' && gitCommits !== 'forbidden') throw usage('--git-commits must be one of allowed | forbidden');
  for (const name of capabilities) {
    if (!CAPABILITIES.includes(name)) throw usage(`unknown capability: ${JSON.stringify(name)}`);
  }
  try { validateSnapshotScope({ roots: ['.'], exclusions }); } catch (error) { throw refuse(`--exclusions-stdin: ${message(error)}`); }

  const apexExists = realDirectory(root, '.apex');
  if (apexExists && lstatOrNull(join(root, HUB_INDEX_PATH)) !== null) {
    throw refuse(`${HUB_INDEX_PATH} exists: this project already has a hub`);
  }
  const areaExists = apexExists && realDirectory(root, INCEPTION_AREA);
  let gitignoreExists = false;
  if (areaExists) {
    const abandoned = inspectAbandon(root);
    if (abandoned?.intent.status === 'prepared') throw refuse('pending abandon intent: resume abandon before starting a new run');
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
    descriptor = createRunDescriptor({ runId: runIdFor(now, randomHex), harnessName, capabilities, git, preapprovalExclusions: exclusions });
  } catch (error) {
    throw refuse(`cannot create the run descriptor: ${message(error)}`);
  }

  if (preflight) return;
  // Every later pre-approval command observes this scope, so prove it observable
  // before the first write: a run that cannot be inventoried is never created.
  try { observeApplication(root, { exclusions }); } catch (error) {
    throw refuse(`cannot observe the application: ${message(error)}; declare exact dependency, cache or generated paths with --exclusions-stdin, never manifests, lockfiles, configuration or migrations`);
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

// A strict JSON array of {path, kind, reason}; startRun validates the entries. The run
// does not exist yet, so this is not a run file: standard input (a quoted heredoc)
// keeps the human reasons out of shell word splitting and expansion.
function readStdinExclusions(read = () => readFileSync(0)) {
  let bytes;
  try { bytes = read(); } catch (error) { throw usage(`--exclusions-stdin cannot read standard input: ${message(error)}`); }
  try { return parseV2Json(bytes, '--exclusions-stdin'); } catch (error) { throw usage(message(error)); }
}

function startCommand(root, values) {
  const result = startRun(root, {
    harnessName: values.harness,
    capabilities: values.capabilities,
    gitCommits: values['git-commits'],
    exclusions: values['exclusions-stdin'] ? readStdinExclusions() : [],
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

export function transitionRun(repoRoot, {
  to, reason, gitCommits, checkpoint, verification, cycle, now = new Date(), reservation, expectedRevision, fault,
} = {}) {
  const root = resolveRepoRoot(repoRoot); v2Descriptor(root);
  if (!TRANSITION_TARGETS.includes(to)) throw usage(`--to must be one of ${TRANSITION_TARGETS.join(' | ')}`);
  assertText(reason, '--reason');
  return transitionV2(root, { to, reason, gitCommits, checkpoint, verification, cycle, now, reservation, expectedRevision, fault });
}

function transitionCommand(root, values) {
  const result = transitionRun(root, {
    to: values.to,
    reason: values.reason,
    gitCommits: values['git-commits'],
    checkpoint: values.checkpoint,
    verification: values.verification,
    cycle: values.cycle,
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

export function writeResumeNote(repoRoot, { next, needs = [], note, reservation, expectedRevision, unitId, fault } = {}) {
  const root = resolveRepoRoot(repoRoot); v2Descriptor(root);
  assertText(next, '--next');
  if (note !== undefined) assertText(note, '--note');
  for (const need of needs) assertAreaPath(need, '--need');
  return resumeNoteV2(root, { next, needs, note, reservation, expectedRevision, unitId, fault });
}

function resumeNoteCommand(root, values) {
  return { ok: true, fields: writeResumeNote(root, { next: values.next, needs: values.need, note: values.note }) };
}

// ---------------------------------------------------------------------------
// approve and verify-approval (HC12)
// ---------------------------------------------------------------------------

// The helper stores the statement it is given; a record is not proof that a human approved.
export function approveRun(repoRoot, { statement, documents = [], contract, reservation, expectedRevision, fault } = {}) {
  const root = resolveRepoRoot(repoRoot); v2Descriptor(root);
  return approveRunV2(root, { statement, documents, contract, reservation, expectedRevision, fault });
}

function approveCommand(root, values) {
  if (values.contract === undefined) throw usage('--contract is required for approval');
  return { ok: true, fields: approveRun(root, { statement: values.statement, documents: values.document, contract: values.contract }) };
}

function verifyApprovalCommand(root, values) {
  return { ok: true, fields: verifyApprovalV2(root, { approval: values.approval }) };
}

// ---------------------------------------------------------------------------
// effect intent, outcome, status (HC13)
// ---------------------------------------------------------------------------

function effectIntentCommand(root, values) {
  if (!values.input) throw refuse('effect intent requires --input');
  return { ok: true, fields: recordEffectIntent(root, { id: values.id, input: v2Input(root, values.input) }) };
}

function effectOutcomeCommand(root, values) {
  if (!values.input) throw refuse('effect outcome requires --input');
  return { ok: true, fields: recordEffectOutcome(root, { id: values.id, input: v2Input(root, values.input) }) };
}

function effectStatusCommand(root) {
  return { ok: true, fields: effectStatusV2(root) };
}

// ---------------------------------------------------------------------------
// checkpoint create and verify (HC10, HC14)
// ---------------------------------------------------------------------------

function checkpointCreateCommand(root, values) {
  return { ok: true, fields: createCheckpoint(root, { label: values.label, files: values.file, filesFrom: values['files-from'] }) };
}

function checkpointVerifyCommand(root, values) {
  const result = verifyCheckpointV2(root, values.checkpoint);
  return { ok: result.ok, fields: result, error: result.ok ? undefined : 'checkpoint drift' };
}

// ---------------------------------------------------------------------------
// abandon (C7)
// ---------------------------------------------------------------------------

export const ABANDON_SCHEMA = ABANDON_SCHEMA_V2;
export const ABANDON_INTENT_PATH = `${INCEPTION_AREA}/abandon-intent.json`;

function archiveEntry(root, path) {
  validatePath(path);
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    if (!realDirectory(root, parts.slice(0, i).join('/'))) return null;
  }
  const stat = lstatOrNull(join(root, path));
  if (!stat) return null;
  if ((!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) throw refuse(`${path}: must be an ordinary single-link file or real directory`);
  if (realpathSync(join(root, path)) !== join(root, path)) throw refuse(`${path}: physical alias is forbidden`);
  return { stat: lstatSync(join(root, path), { bigint: true }), physicalPath: join(root, path) };
}
const physicalIdentity = entry => ({ device: String(entry.stat.dev), inode: String(entry.stat.ino) });
function assertArchiveIdentity(entry, child, path) {
  if (!entry || !sameValue(physicalIdentity(entry), { device: child.device, inode: child.inode })
    || entry.stat.isDirectory() !== (child.kind === 'directory')) throw refuse(`${path}: archive child identity differs`);
}
function archiveRecordBytes(intent, identity) {
  const prepared = { ...intent, status: 'prepared' };
  const bytes = serializeAbandonRecordV2(prepared);
  const archive = `${INCEPTION_AREA}/${intent.archive}`;
  return {
    intent: bytes,
    abandon: identity ? serializeAbandonRecordV2({ schema: ABANDON_SCHEMA_V2, id: intent.id, runId: intent.runId,
      at: intent.at, reason: intent.reason, descriptor: intent.descriptor,
      intent: publicationRef(`${archive}/intent.json`, bytes), archiveIdentity: identity, children: intent.children.map(c => c.name) }) : null,
  };
}
function validateArchiveReceipt(bytes, intent) {
  const receipt = parseAbandonRecordV2(bytes);
  const expected = { schema: ABANDON_RECEIPT_SCHEMA_V2, id: intent.id, runId: intent.runId,
    intentSha256: publicationRef('intent.json', archiveRecordBytes(intent).intent).sha256,
    descriptor: intent.descriptor, archive: intent.archive, completedAt: receipt.completedAt };
  if (!sameValue(receipt, expected) || receipt.completedAt < intent.at
    || !Buffer.from(serializeAbandonRecordV2(receipt)).equals(bytes)) throw refuse('abandon receipt does not match the prepared intent');
  return receipt;
}

// Reads only the canonical pointer and its exact record/child paths. Directory
// bodies are opaque: only the immediate archive names are inspected for conflicts.
// The linter supplies its bounded, physically bound reader at this same boundary.
export function inspectAbandon(repoRoot, { readFile, inspectEntry } = {}) {
  const root = resolveRepoRoot(repoRoot);
  const read = readFile ?? (path => readPublicationFile(root, path, { missing: true }));
  const entry = inspectEntry ?? (path => archiveEntry(root, path));
  const raw = read(ABANDON_INTENT_PATH);
  if (raw === null) return null;
  const intent = parseAbandonRecordV2(raw);
  if (intent.schema !== ABANDON_INTENT_SCHEMA_V2 || !Buffer.from(serializeAbandonRecordV2(intent)).equals(raw)) throw refuse('abandon-intent.json must contain a canonical abandon intent');
  const archive = `${INCEPTION_AREA}/${intent.archive}`;
  const directory = entry(archive);
  if (directory && !directory.stat.isDirectory()) throw refuse(`${archive}: not a real directory`);
  const expected = archiveRecordBytes(intent, directory ? physicalIdentity(directory) : null);
  const copy = read(`${archive}/intent.json`);
  const record = read(`${archive}/abandon.json`);
  const receipt = read(`${archive}/receipt.json`);
  const receiptStage = `${archive}/receipt.json.${intent.id}.staging`;
  const receiptReservation = read(`${receiptStage}/reservation.json`);
  if (copy !== null && !copy.equals(Buffer.from(expected.intent))) throw refuse('archive intent.json differs from prepared intent');
  if (record !== null && (copy === null || !record.equals(Buffer.from(expected.abandon)))) throw refuse('archive abandon.json identity or bytes differ');
  if (receiptReservation !== null) {
    if (record === null) throw refuse('receipt reservation precedes abandon.json');
    validateArchiveReceipt(receiptReservation, intent);
  }
  if (receipt !== null && (receiptReservation === null || !receipt.equals(receiptReservation))) throw refuse('archive receipt.json differs from its reservation');
  if (directory) {
    const allowed = new Set(['intent.json', `intent.json.${intent.id}.staging`]);
    if (copy !== null) { allowed.add('abandon.json'); allowed.add(`abandon.json.${intent.id}.staging`); }
    if (record !== null) {
      for (const child of intent.children) allowed.add(child.name);
      allowed.add('receipt.json'); allowed.add(`receipt.json.${intent.id}.staging`);
    }
    for (const name of readdirSync(directory.physicalPath)) {
      if (!allowed.has(name)) throw refuse(`${archive}/${name}: unexpected foreign archive content`);
      if (name.endsWith('.staging') && !entry(`${archive}/${name}`)?.stat.isDirectory()) throw refuse(`${name}: staging must be a real directory`);
    }
  }
  let gap = false;
  let allMoved = true;
  for (const child of intent.children) {
    const source = `${INCEPTION_AREA}/${child.name}`; const target = `${archive}/${child.name}`;
    // A completed archive remains immutable while an explicitly started new run
    // may legitimately own canonical active paths again.
    const from = intent.status === 'complete' ? null : entry(source);
    const to = entry(target);
    if (from && to) throw refuse(`${child.name}: ambiguous abandon, both source and destination exist`);
    if (!from && !to) throw refuse(`${child.name}: ambiguous abandon, neither source nor destination exists`);
    if (to && (gap || record === null)) throw refuse(`${child.name}: moved children must be an ordered prefix after abandon.json`);
    if (from) { gap = true; allMoved = false; }
    assertArchiveIdentity(to ?? from, child, to ? target : source);
    if (child.name === 'run.json') {
      const bytes = read(to ? target : source);
      if (bytes === null || !sameValue(publicationRef(intent.descriptor.path, bytes), intent.descriptor)) throw refuse('abandon descriptor digest differs');
      const descriptor = parseRunDescriptor(decodeAreaText(bytes, target));
      if (descriptor.runId !== intent.runId) throw refuse('abandon descriptor runId differs');
    }
  }
  if (intent.status === 'prepared') {
    for (const name of RUN_CHILDREN) if (!intent.children.some(c => c.name === name) && entry(`${INCEPTION_AREA}/${name}`)) throw refuse(`${name}: foreign active child appeared after abandon intent`);
  }
  if ((receiptReservation !== null || receipt !== null) && !allMoved) throw refuse('receipt precedes completed child moves');
  if (intent.status === 'complete' && receipt === null) throw refuse('complete abandon intent has no receipt');
  return { intent, archive, allMoved, receipt, receiptReservation };
}

export function abandonRun(repoRoot, options = {}) {
  if (options.resume !== undefined && typeof options.resume !== 'boolean') throw usage('--resume must be boolean');
  if ((options.resume === true) === (options.reason !== undefined)) throw usage('abandon requires exactly one of --reason or --resume');
  if (options.reason !== undefined) validateText(options.reason, '--reason');
  if (options.fault !== undefined && typeof options.fault !== 'function') throw refuse('fault must be a synchronous API hook');
  return withInceptionLease(repoRoot, options, abandonRunUnlocked);
}
function abandonRunUnlocked(repoRoot, { reason, resume = false, now = new Date(), fault } = {}, preflight = false) {
  const root = resolveRepoRoot(repoRoot);
  let observed = inspectAbandon(root);
  let intent;
  if (resume) {
    if (!observed) throw refuse('no canonical abandon intent to resume');
    intent = observed.intent;
    if (intent.status === 'complete') return { archive: observed.archive };
  } else {
    if (observed?.intent.status === 'prepared') throw refuse('pending abandon intent: use --resume');
    const descriptor = loadDescriptor(root);
    if (descriptor.activeUnit !== null) throw refuse(`activeUnit ${descriptor.activeUnit} excludes the abandon writer; close or reconcile that unit first`);
    const archive = `${ABANDONED_DIR}/${descriptor.runId}`;
    if (archiveEntry(root, archive)) throw refuse(`${archive} exists without this operation intent`);
    const children = RUN_CHILDREN.flatMap(name => {
      const found = archiveEntry(root, `${INCEPTION_AREA}/${name}`);
      if (!found) return [];
      const kind = name.includes('.') ? 'file' : 'directory';
      if (found.stat.isDirectory() !== (kind === 'directory')) throw refuse(`${name}: wrong run child kind`);
      return [{ name, kind, ...physicalIdentity(found) }];
    });
    intent = { schema: ABANDON_INTENT_SCHEMA_V2, id: `abandon-${randomBytes(16).toString('hex')}`, runId: descriptor.runId,
      at: now.toISOString(), reason,
      descriptor: publicationRef(`${archive}/run.json`, readPublicationFile(root, RUN_DESCRIPTOR_PATH)),
      archive: `abandoned/${descriptor.runId}`, children, status: 'prepared' };
    serializeAbandonRecordV2(intent);
  }
  if (preflight) return;
  if (!resume) {
    fault?.('before-intent');
    replaceFileAtomic(join(root, ABANDON_INTENT_PATH), serializeAbandonRecordV2(intent));
    fault?.('after-intent');
  }
  const archive = `${INCEPTION_AREA}/${intent.archive}`;
  const verify = () => {
    const state = inspectAbandon(root);
    if (!state || !sameValue(state.intent, intent)) throw refuse('abandon intent changed');
    return state;
  };
  verify();
  if (!realDirectory(root, ABANDONED_DIR)) createDirectory(root, ABANDONED_DIR);
  if (!realDirectory(root, archive)) {
    fault?.('before-mkdir');
    createDirectory(root, archive);
    fault?.('after-mkdir');
  }
  const bytes = archiveRecordBytes(intent, physicalIdentity(archiveEntry(root, archive)));
  const publish = (name, content) => {
    verify();
    const path = `${archive}/${name}`;
    stagePublicationTargets(root, { id: intent.id, targets: [{ ...publicationRef(path, content), contentBase64: Buffer.from(content).toString('base64') }] }, { fault, archiveIntent: intent });
  };
  publish('intent.json', bytes.intent);
  publish('abandon.json', bytes.abandon);
  for (const child of intent.children) {
    verify();
    const source = `${INCEPTION_AREA}/${child.name}`; const target = `${archive}/${child.name}`;
    if (!archiveEntry(root, source)) continue;
    fault?.('before-move', { name: child.name });
    verify(); // Rebind identity immediately before each rename.
    renameSync(join(root, source), join(root, target));
    fsyncDirectory(join(root, archive)); fsyncDirectory(join(root, INCEPTION_AREA));
    fault?.('after-move', { name: child.name });
  }
  observed = verify();
  fault?.('before-receipt');
  // completedAt is rendered once, after all moves. Its durable token-bound
  // reservation retains exact bytes across partial staging generations/retries.
  let receiptBytes = observed.receiptReservation;
  if (receiptBytes === null) {
    receiptBytes = Buffer.from(serializeAbandonRecordV2({ schema: ABANDON_RECEIPT_SCHEMA_V2, id: intent.id, runId: intent.runId,
      intentSha256: publicationRef(`${archive}/intent.json`, bytes.intent).sha256, descriptor: intent.descriptor,
      archive: intent.archive, completedAt: new Date().toISOString() }));
    const stage = publicationStagingDirectory(`${archive}/receipt.json`, intent.id, intent);
    if (!realDirectory(root, stage)) createDirectory(root, stage);
    fault?.('before-receipt-reservation');
    replaceFileAtomic(join(root, stage, 'reservation.json'), receiptBytes);
    fault?.('after-receipt-reservation');
  }
  publish('receipt.json', receiptBytes);
  fault?.('after-receipt');
  verify();
  fault?.('before-complete');
  replaceFileAtomic(join(root, ABANDON_INTENT_PATH), serializeAbandonRecordV2({ ...intent, status: 'complete' }));
  fault?.('after-complete');
  return { archive };
}
function abandonCommand(root, values) {
  return { ok: true, fields: abandonRun(root, { reason: values.reason, resume: values.resume }) };
}

// ---------------------------------------------------------------------------
// V2 registration and recovery. No caller-supplied descriptor or "passed" flag
// enters this API. Only these operation handlers can construct nextDescriptor.
// ---------------------------------------------------------------------------

// Start and archive preflight before acquiring a lease, then repeat under lock.
function withInceptionLease(repoRoot, options, operation) {
  const root = resolveRepoRoot(repoRoot);
  operation(root, options, true);
  return withProjectScaffoldLock({ hubRoot: root }, () => operation(root, options, false));
}

function assertV2Options({ reservation, expectedRevision, fault }) {
  if (reservation !== undefined) validateId(reservation, 'reservation');
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) throw refuse('expected revision must be a positive safe integer');
  if (fault !== undefined && typeof fault !== 'function') throw refuse('fault must be a synchronous API hook');
}
function v2Descriptor(root) {
  return loadDescriptor(root);
}
function withV2SnapshotLease(root, observed, action) {
  const currentDescriptor = () => {
    const descriptor = v2Descriptor(root);
    if (descriptor.runId !== observed.runId || descriptor.revision !== observed.revision) throw refuse('incompatible descriptor revision or run identity');
    return descriptor;
  };
  // The scaffold lease retains a reclaimed generation until release. Complete
  // that retirement before observing application files, using only the public
  // lease API; lock-like paths that fail structural recognition remain part of the inventory.
  withProjectScaffoldLock({ hubRoot: root }, currentDescriptor);
  // Another cooperating writer may run between leases. Recheck the descriptor
  // under the observation lease before any application read or publication.
  return withApplicationSnapshotLease(root, () => action(currentDescriptor()));
}
function withV2Mutation(repoRoot, options, action) {
  assertV2Options(options);
  const root = resolveRepoRoot(repoRoot);
  const observed = v2Descriptor(root); // Form validation precedes the lease.
  const expectedRevision = options.expectedRevision ?? observed.revision;
  return withV2SnapshotLease(root, observed, descriptor => {
    if (descriptor.runId !== observed.runId || descriptor.revision !== expectedRevision) throw refuse('incompatible descriptor revision');
    if (descriptor.pending !== null) throw refuse(`pending reservation ${descriptor.pending.id} must be resumed`);
    if (descriptor.activeUnit !== null && descriptor.activeUnit !== options.unitId) throw refuse(`activeUnit ${descriptor.activeUnit} excludes this writer`);
    return action(root, descriptor);
  });
}
function finishPublicationLocked(root, descriptor, { fault } = {}) {
  const pending = descriptor.pending;
  if (pending.operation === 'complete') verifyTerminalReservation(root, descriptor);
  else if (descriptor.status === 'complete') verifyCompletedState(root, { ...descriptor, pending: null });
  stagePublicationTargets(root, pending, { fault });
  fault?.('before-bind', { reservation: pending.id });
  // Binding is the already-rendered next descriptor, never a rerun of the
  // original writer, report parser, or application operation.
  verifyPublicationTargets(root, pending.targets);
  if (pending.operation === 'complete') verifyCompletedState(root, pending.nextDescriptor, { live: false });
  const current = v2Descriptor(root);
  if (serializeRunDescriptorV2(current) !== serializeRunDescriptorV2(descriptor)) throw refuse('incompatible descriptor revision or reservation');
  fault?.('after-bind', { reservation: pending.id });
  fault?.('before-descriptor-replace', { reservation: pending.id });
  writeDescriptor(root, pending.nextDescriptor, replaceFileAtomic);
  fault?.('after-descriptor-replace', { reservation: pending.id });
  return { reservation: pending.id, revision: pending.nextDescriptor.revision, noop: false };
}
function publishMutation(root, descriptor, nextDescriptor, targets, operation, options) {
  const id = options.reservation ?? `pub-${randomBytes(16).toString('hex')}`;
  const reserved = preparePublication(descriptor, { id, operation, targets, nextDescriptor });
  for (const target of reserved.pending.targets) {
    if (readPublicationFile(root, target.path, { missing: true }) !== null) throw refuse(`${target.path} already exists: foreign publication target`);
    const stagingDirectory = publicationStagingDirectory(target.path, id);
    if (readPublicationFile(root, stagingDirectory, { missing: true }) !== null) throw refuse(`${stagingDirectory} already exists: foreign staging namespace`);
    const initialStage = `${target.path}.${id}.stage-0001.tmp`;
    if (readPublicationFile(root, initialStage, { missing: true }) !== null) throw refuse(`${initialStage} already exists: foreign staging file`);
  }
  options.fault?.('before-reserve', { reservation: id });
  writeDescriptor(root, reserved, replaceFileAtomic);
  options.fault?.('after-reserve', { reservation: id });
  return finishPublicationLocked(root, reserved, options);
}
export function resumePublication(repoRoot, { reservation, fault } = {}) {
  validateId(reservation, 'reservation'); assertV2Options({ fault });
  const root = resolveRepoRoot(repoRoot);
  const observed = v2Descriptor(root);
  if (observed.pending?.id === reservation && observed.pending.operation.startsWith('capture-')) {
    const attempt = observed.units.find(u => u.id === observed.activeUnit)?.capture
      ?? observed.pending.nextDescriptor.units.find(u => u.id === observed.pending.nextDescriptor.activeUnit)?.capture;
    if (!attempt) throw refuse('capture publication has no registered collector');
    assertDeadCollector(attempt);
    if (observed.pending.operation === 'capture-finish') {
      recoverCapture(root, { unit: observed.activeUnit, fault });
      return { reservation, revision: observed.pending.nextDescriptor.revision, noop: false };
    }
  }
  return withV2SnapshotLease(root, observed, descriptor => {
    if (descriptor.runId !== observed.runId) throw refuse('reservation run identity changed');
    const completed = descriptor.publications.find(p => p.id === reservation);
    if (completed) {
      verifyPublicationTargets(root, completed.targets);
      return { reservation, revision: completed.revision, noop: true };
    }
    if (descriptor.pending?.id !== reservation) throw refuse('reservation is not the pending publication');
    return finishPublicationLocked(root, descriptor, { fault });
  });
}
function assertRegistrationInput(input) {
  expectKeys(input, ['kind', 'inputs', 'outputs', 'allowedPaths'], 'unit input');
  if (!['decision', 'research', 'bootstrap', 'check', 'publication', 'transition'].includes(input.kind)) throw refuse('unknown unit kind');
  if (!Array.isArray(input.inputs) || !Array.isArray(input.outputs) || !Array.isArray(input.allowedPaths)) throw refuse('unit input lists are required');
  input.inputs.forEach(r => validateRef(r));
  input.allowedPaths.forEach(path => { validatePath(path); if (path.startsWith('.apex/inception') || path.startsWith('.apex/work') || path === '.git' || path.startsWith('.git/')) throw refuse('reserved application scope'); });
  for (const output of input.outputs) {
    expectKeys(output, ['path', 'role'], 'unit output'); validatePath(output.path);
    // Only project/research working documents may be updated by a child. Run
    // records, descriptor, snapshots and frozen outputs are helper-owned.
    if (output.path.startsWith(`${INCEPTION_AREA}/`) && !['project', 'research', 'bootstrap'].some(area => output.path.startsWith(`${INCEPTION_AREA}/${area}/`))) throw refuse('helper-owned output is forbidden');
    if (!output.path.startsWith(`${INCEPTION_AREA}/`) && !withinAllowed(output.path, input.allowedPaths)) throw refuse('application output requires declared allowedPaths scope');
    if (!['decision', 'report', 'evidence'].includes(output.role)) throw refuse('unknown output role');
  }
  if (!input.outputs.some(o => o.role === 'report')) throw refuse('unit requires a declared report output');
}
function verifyUnitInputs(root, refs) {
  return refs.map(ref => {
    const bytes = readPublicationFile(root, ref.path);
    const observed = publicationRef(ref.path, bytes);
    if (observed.bytes !== ref.bytes || observed.sha256 !== ref.sha256) throw refuse(`${ref.path}: input digest is divergent`);
    return bytes;
  });
}
function unitInputCopyPath(id, index) {
  return `${INCEPTION_AREA}/units/${id}/inputs/${String(index + 1).padStart(4, '0')}.bin`;
}
export function beginUnit(repoRoot, { id, input, previousUnit = null, expectedRevision, reservation, fault } = {}) {
  validateId(id); assertRegistrationInput(input);
  if (previousUnit !== null) validateId(previousUnit);
  const options = { expectedRevision, reservation, fault };
  return withV2Mutation(repoRoot, options, (root, descriptor) => {
    if (descriptor.status !== 'active') throw refuse('unit begin requires an active run');
    if (descriptor.units.some(u => u.id === id)) throw refuse('unit ID already exists; use a new ID');
    if (previousUnit !== null && !descriptor.units.some(u => u.id === previousUnit)) throw refuse('previousUnit does not exist');
    if (descriptor.approvals.length && descriptor.phase !== 'approval') {
      const late = input.outputs.find(isProjectDecision);
      if (late) throw refuse(`${late.path}: a new project decision after approval requires returning to the approval phase`);
      const approval = readApprovalV2(root, descriptor, descriptor.approvals.at(-1)).record;
      if (input.outputs.some(o => approval.body.documents.some(d => d.path === o.path))) throw refuse('approved project documents may change only in approval phase');
    }
    let unitInputs = input.inputs;
    if (input.kind === 'check') {
      const context = verificationContext(root, descriptor, descriptor.currentCycle?.path);
      unitInputs = [...input.inputs];
      for (const ref of [context.ref, descriptor.verificationSession]) if (!unitInputs.some(i => sameValue(i, ref))) unitInputs.push(ref);
    }
    const inputContents = verifyUnitInputs(root, unitInputs);
    if (descriptor.blocks.length) throw refuse('unresolved blocks prevent new work');
    if (readEffectsV2(root, descriptor).unresolved.length) throw refuse('unresolved effects prevent new work');
    const snapshot = observeRunApplication(root, descriptor);
    assertBaseline(root, descriptor, snapshot);
    const beforeRecord = newRecordV2(descriptor, 'snapshot', snapshot, id);
    // Keep the declared source identities and freeze their exact opening bytes
    // before the writer starts. Ordered copy paths retain the source mapping.
    const targets = inputContents.map((content, index) => ({ path: unitInputCopyPath(id, index), content }));
    const openingEvidence = targets.map(target => publicationRef(target.path, target.content));
    targets.push(beforeRecord.target);
    const unit = { id, previousUnit, kind: input.kind, phase: descriptor.phase, inputs: unitInputs, outputs: input.outputs, allowedPaths: input.allowedPaths, before: beforeRecord.ref, state: 'started', evidence: openingEvidence, after: null, capture: null };
    const next = { ...descriptor, nextRecord: descriptor.nextRecord + 1, baseline: descriptor.baseline ?? beforeRecord.ref, units: [...descriptor.units, unit], activeUnit: id };
    return { id, ...publishMutation(root, descriptor, next, targets, 'unit-begin', options) };
  });
}
function verifyUnitReport(bytes, id) {
  let report;
  try { report = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw refuse('report must be valid UTF-8'); }
  const header = /^<!-- steepy-inception-unit: v2; id: ([a-z0-9-]+); status: (DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT) -->\r?\n/u.exec(report);
  const footer = `<!-- steepy-inception-unit-end: ${id} -->`;
  if (!header || header[1] !== id || !['DONE', 'DONE_WITH_CONCERNS'].includes(header[2])
    || !report.trimEnd().endsWith(footer) || report.slice(header[0].length, report.lastIndexOf(footer)).trim().length === 0) throw refuse('report is incomplete, unsuccessful, or has a different unit identity');
}
function verifyOpeningUnitInputs(root, unit) {
  const openingInputs = unit.inputs.map((input, index) => ({ ...input, path: unitInputCopyPath(unit.id, index) }));
  for (const opening of openingInputs) {
    if (!unit.evidence.some(ref => ref.path === opening.path && ref.bytes === opening.bytes && ref.sha256 === opening.sha256)) throw refuse(`${opening.path}: missing bound opening input evidence`);
  }
  verifyUnitInputs(root, openingInputs);
  // Only an exact declared output may change its live working copy. Every
  // read-only input must still match, and the opening copies always match.
  const workingOutputs = new Set(unit.outputs.map(output => output.path));
  verifyUnitInputs(root, unit.inputs.filter(input => !workingOutputs.has(input.path)));
}
export function finishUnit(repoRoot, { id, evidence = [], expectedRevision, reservation, fault } = {}) {
  validateId(id);
  if (!Array.isArray(evidence)) throw refuse('evidence must be an array of exact paths');
  evidence.forEach(path => validatePath(path));
  const options = { unitId: id, expectedRevision, reservation, fault };
  return withV2Mutation(repoRoot, options, (root, descriptor) => {
    if (descriptor.activeUnit !== id) throw refuse('activeUnit does not identify this writer');
    const unit = descriptor.units.find(u => u.id === id);
    assertRegistrationInput({ kind: unit.kind, inputs: unit.inputs, outputs: unit.outputs, allowedPaths: unit.allowedPaths });
    if (unit.capture !== null && unit.capture.state !== 'captured') throw refuse('capture is incomplete');
    if (readEffectsV2(root, descriptor).unresolved.length) throw refuse('unresolved effects prevent unit finish');
    const excess = unitEffectExcess(root, descriptor, id);
    if (excess.length) throw refuse(effectExcessSummary(excess));
    verifyOpeningUnitInputs(root, unit);
    const targets = unit.outputs.map((output, index) => {
      const content = readPublicationFile(root, output.path);
      if (output.role === 'report') verifyUnitReport(content, id);
      return { path: `${INCEPTION_AREA}/units/${id}/outputs/${String(index + 1).padStart(4, '0')}.bin`, content };
    });
    const references = targets.map(t => publicationRef(t.path, t.content));
    // Extra evidence is also frozen: later working-copy edits cannot rewrite history.
    for (const [index, path] of evidence.entries()) {
      const content = readPublicationFile(root, path);
      const target = { path: `${INCEPTION_AREA}/units/${id}/evidence/${String(index + 1).padStart(4, '0')}.bin`, content };
      targets.push(target); references.push(publicationRef(target.path, content));
    }
    const before = readRecordV2(root, descriptor, unit.before, 'snapshot').body;
    const after = observeRunApplication(root, descriptor);
    const changes = applicationChanges(before, after);
    if (unit.kind === 'check' && applicationIdentity(before) !== applicationIdentity(after)) throw refuse('check application drift requires reconciliation and a new cycle');
    if (unit.kind === 'check') verificationContext(root, descriptor, descriptor.currentCycle?.path);
    if (changes.some(change => !withinAllowed(change.path, unit.allowedPaths))) throw refuse('unexplained application changes outside unit scope');
    assertGitExplained(root, descriptor, before, after, id);
    const afterRecord = newRecordV2(descriptor, 'snapshot', after, id);
    targets.push(afterRecord.target);
    const changed = applicationIdentity(before) !== applicationIdentity(after);
    const next = { ...descriptor, nextRecord: descriptor.nextRecord + 1, baseline: afterRecord.ref,
      currentCycle: changed ? null : descriptor.currentCycle, verificationSession: changed ? null : descriptor.verificationSession,
      units: descriptor.units.map(u => u.id === id ? { ...u, state: 'completed', evidence: [...u.evidence, ...references], after: afterRecord.ref } : u), activeUnit: null };
    return { id, ...publishMutation(root, descriptor, next, targets, 'unit-finish', options) };
  });
}
function resumeNoteV2(repoRoot, options) {
  return withV2Mutation(repoRoot, options, (root, descriptor) => {
    if (descriptor.status === 'complete') {
      verifyCompletedState(root, descriptor);
      if (!options.needs.includes(descriptor.completion.path)) throw refuse('complete presentation note must reference the existing completion');
    }
    options.needs.forEach(path => readPublicationFile(root, path));
    const number = descriptor.nextRecord;
    const path = recordPath('resumeNotes', number);
    const content = renderResumeNote({ number, descriptor, ...options });
    const next = { ...descriptor, nextRecord: number + 1, resumeNotes: [...descriptor.resumeNotes, publicationRef(path, content)] };
    return { note: path, ...publishMutation(root, descriptor, next, [{ path, content }], 'resume-note', options) };
  });
}
function transitionV2(repoRoot, options) {
  return withV2Mutation(repoRoot, options, (root, descriptor) => {
    if (options.to === 'complete') return completeV2(root, descriptor, options);
    if (options.cycle !== undefined) throw refuse('--cycle is allowed only on verification -> complete');
    // Blocking, unblocking and returning to approval advance no work, so an edited
    // approved document cannot strand them; forward transitions compare the working copies.
    if (descriptor.phase !== 'approval' && !['approval', 'blocked', 'active'].includes(options.to) && descriptor.approvals.length) readApprovalV2(root, descriptor, descriptor.approvals.at(-1));
    if (options.to !== 'blocked') {
      if (descriptor.blocks.length || readEffectsV2(root, descriptor).unresolved.length) throw refuse('unresolved blocks or effects prevent transition');
      assertBaseline(root, descriptor, observeRunApplication(root, descriptor));
    }
    const unavailable = () => { throw refuse('transition guard is not yet supported'); };
    const next = applyTransition(descriptor, options, { approval: () => {
      if (descriptor.approvalEntry === null || descriptor.approvals.length <= descriptor.approvalEntry) throw refuse('approval -> bootstrap requires a new approval since entry');
      readApprovalV2(root, descriptor, descriptor.approvals.at(-1));
    }, complete: unavailable });
    return { phase: next.phase, status: next.status, ...publishMutation(root, descriptor, next, [], 'transition', options) };
  });
}
// V2 inventory/effect registrations all use the same reserved immutable publication.
const withinAllowed = (path, allowed) => allowed.some(p => path === p || path.startsWith(`${p}/`));
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Git status is filtered by the snapshot scope, so statuses compare only within one scope.
const sameScope = (a, b) => sameValue(a.roots, b.roots) && sameValue(a.exclusions, b.exclusions);
function newRecordV2(descriptor, kind, body, unitId = null, offset = 0) {
  const record = descriptor.nextRecord + offset;
  const family = { snapshot: 'snapshots', checkpoint: 'checkpoints', 'effect-intent': 'effects', 'effect-outcome': 'effects', reconciliation: 'reconciliations', approval: 'approvals', cycle: 'verification/cycles', 'verification-session': 'verification/sessions', manual: 'verification/manual', result: 'verification/results', summary: 'verification/summaries', completion: 'verification/completions' }[kind];
  const path = `${INCEPTION_AREA}/${family}/${String(record).padStart(4, '0')}.json`;
  const content = serializeInceptionRecord({ schema: 'steepy-inception-record/v2', runId: descriptor.runId, record, kind, at: new Date().toISOString(), unitId, body });
  return { ref: publicationRef(path, content), target: { path, content } };
}
function readRefV2(root, ref) {
  validateRef(ref);
  const content = readPublicationFile(root, ref.path);
  if (!sameValue(publicationRef(ref.path, content), ref)) throw refuse(`${ref.path}: reference digest diverges`);
  return content;
}
function readRecordV2(root, descriptor, ref, kind) {
  if (ref === null) throw refuse('required record reference is absent');
  const record = parseInceptionRecord(readRefV2(root, ref), { runId: descriptor.runId, number: Number(basename(ref.path, '.json')) });
  if (kind !== undefined && record.kind !== kind) throw refuse(`${ref.path}: expected ${kind}`);
  return record;
}
function observeRunApplication(root, descriptor) {
  const approvalRef = descriptor.approvals.at(-1);
  if (approvalRef) {
    const { record: approval, contract } = readApprovalV2(root, descriptor, approvalRef, { historical: true });
    return observeApplication(root, { contract: approval.body.contract, roots: contract.roots, exclusions: contract.exclusions });
  }
  return observeApplication(root, { exclusions: descriptor.preapprovalExclusions });
}
// Name the drifted paths so they can be restored or reconciled; JSON keeps each one line.
function driftSummary(before, after) {
  const changes = applicationChanges(before, after);
  if (changes.length === 0) return 'roots or exclusions';
  const shown = changes.slice(0, 5).map(change => JSON.stringify(change.path)).join(', ');
  return changes.length > 5 ? `${shown} and ${changes.length - 5} more` : shown;
}
function assertBaseline(root, descriptor, observed) {
  if (descriptor.baseline === null) return;
  const baseline = readRecordV2(root, descriptor, descriptor.baseline, 'snapshot').body;
  if (applicationIdentity(baseline) !== applicationIdentity(observed)) throw refuse(`application or Git baseline drift requires reconciliation: ${driftSummary(baseline, observed)}`);
  if (!sameValue(baseline.git, observed.git)) throw refuse('application or Git baseline drift requires reconciliation: Git branch, HEAD or status');
}
function effectBlockId(id) { return `effect-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`; }
function assertGitExplained(root, descriptor, before, after, unitId) {
  if (!sameScope(before, after)) throw refuse('Git status from a different snapshot scope is unexplained drift');
  if (sameValue(before.git, after.git)) return;
  // Dirty status normally changes with the authorized application diff. A branch
  // or HEAD change, or status-only drift, requires a correlated commit observation.
  // Git names some of that diff differently: macOS reports precomposed names for
  // decomposed files, and an untracked nested repository is one `dir/` entry for the
  // files beneath it. An unchanged untracked file that appears or disappears is
  // accepted when a .gitignore in one of its ancestor directories also changed; the
  // old rules are not retained, so this is correlation, not proof of cause.
  const changedPaths = applicationChanges(before, after).map(change => change.path.normalize('NFC'));
  const prior = new Map(before.files.map(file => [file.path, file]));
  const unchangedPaths = after.files.filter(file => sameValue(prior.get(file.path), file)).map(file => file.path.normalize('NFC'));
  const changedSet = new Set(changedPaths); const unchangedSet = new Set(unchangedPaths);
  const ignoreDirectories = changedPaths.filter(path => path === '.gitignore' || path.endsWith('/.gitignore')).map(path => path.slice(0, -'.gitignore'.length));
  const covers = (path, paths, set) => path.endsWith('/') ? paths.some(p => p.startsWith(path)) : set.has(path);
  const beforeStatus = new Set(before.git.status); const afterStatus = new Set(after.git.status);
  const statusChanges = [...before.git.status.filter(entry => !afterStatus.has(entry)), ...after.git.status.filter(entry => !beforeStatus.has(entry))];
  const explained = entry => {
    const path = (/^[ MARCUD?!]{2} /u.test(entry) ? entry.slice(3) : entry).normalize('NFC');
    if (changedSet.has(path)) return true;
    if (!entry.startsWith('?? ')) return false;
    return (path.endsWith('/') && covers(path, changedPaths, changedSet)) || (ignoreDirectories.some(directory => path.startsWith(directory)) && covers(path, unchangedPaths, unchangedSet));
  };
  if (before.git.present === after.git.present && before.git.branch === after.git.branch && before.git.head === after.git.head
      && statusChanges.every(explained)) return;
  const effects = readEffectsV2(root, descriptor);
  const committed = e => {
    const observed = readRecordV2(root, descriptor, e.outcome.body.after, 'snapshot').body;
    return sameScope(observed, after) && sameValue(observed.git, after.git);
  };
  if (!effects.effects.some(e => e.intent.body.unitId === unitId && e.intent.body.kind === 'commit'
      && e.outcome?.body.result === 'succeeded' && committed(e))) throw refuse('Git drift requires a correlated commit observation or human reconciliation');
}
function verifyCorrelation(intent, outcome) {
  if (!sameValue(intent.correlation, outcome.correlation)) throw refuse('effect correlation differs from intent');
  if (outcome.method === 'reconciled' && outcome.correlation.length === 0) throw refuse('automatic reconciliation requires exact correlation');
}
function verifyEffectObservation(bytes, intent, outcome) {
  const observation = parseV2Json(bytes);
  expectKeys(observation, ['id', 'procedure', 'result', 'correlation', 'observed'], 'effect observation');
  if (observation.id !== intent.id || observation.procedure !== intent.observation.procedure || observation.result !== outcome.result
      || !sameValue(observation.correlation, intent.correlation) || observation.observed !== outcome.observed) throw refuse('structured effect observation does not match intent correlation or outcome');
}
function readEffectsV2(root, descriptor) {
  const effects = new Map();
  for (const ref of descriptor.effects) {
    const record = readRecordV2(root, descriptor, ref);
    const body = record.body;
    if (record.kind === 'effect-intent') {
      if (effects.has(body.id)) throw refuse('effect intent ID already exists');
      readRecordV2(root, descriptor, body.before, 'snapshot');
      effects.set(body.id, { id: body.id, ref, intent: record, outcome: null });
    } else if (record.kind === 'effect-outcome') {
      const effect = effects.get(body.id);
      if (!effect || !sameValue(effect.ref, body.intent) || record.unitId !== effect.intent.unitId
          || (effect.outcome !== null && effect.outcome.body.result !== 'partial')) throw refuse('effect outcome has invalid intent correlation or terminal replay');
      verifyCorrelation(effect.intent.body, body);
      if (body.evidence.length === 0) throw refuse('effect outcome requires structured evidence');
      for (const evidence of body.evidence) verifyEffectObservation(readRefV2(root, evidence), effect.intent.body, body);
      readRecordV2(root, descriptor, body.after, 'snapshot');
      effect.outcome = record;
    } else throw refuse('effects list contains a non-effect record');
  }
  const list = [...effects.values()];
  return { effects: list, unresolved: list.filter(e => e.outcome === null || e.outcome.body.result === 'partial').map(e => e.id) };
}
export function effectStatusV2(repoRoot) {
  const root = resolveRepoRoot(repoRoot); const descriptor = v2Descriptor(root);
  const result = readEffectsV2(root, descriptor);
  return { effects: result.effects.map(e => ({ id: e.id, kind: e.intent.body.kind, state: !e.outcome || e.outcome.body.result === 'partial' ? 'uncertain' : 'concluded', result: e.outcome?.body.result ?? null })), unresolved: result.unresolved, uncertain: result.unresolved.length };
}
export function recordEffectIntent(repoRoot, options = {}) {
  const { id, input } = options; validateId(id);
  expectKeys(input, ['id', 'kind', 'summary', 'command', 'procedure', 'scope', 'authorization', 'correlation', 'observation'], 'effect intent input');
  if (input.id !== id) throw refuse('effect ID does not match input');
  const unitId = v2Descriptor(resolveRepoRoot(repoRoot)).activeUnit;
  return withV2Mutation(repoRoot, { ...options, unitId }, (root, descriptor) => {
    if (descriptor.status !== 'active' || !unitId) throw refuse('effect intent requires an active unit');
    const known = readEffectsV2(root, descriptor);
    if (known.effects.some(e => e.id === id)) throw refuse('effect ID already exists; replay forbidden');
    if (known.unresolved.length || descriptor.blocks.length) throw refuse('unresolved effects or blocks prevent new execution');
    if (['remote', 'deploy', 'external-resource'].includes(input.kind) && input.authorization === null) throw refuse('remote effect requires authorization');
    if (input.kind === 'commit' && descriptor.git.commits !== 'allowed') throw refuse('commit effect requires authorized Git policy');
    const unit = descriptor.units.find(u => u.id === unitId);
    const before = observeRunApplication(root, descriptor);
    const opening = readRecordV2(root, descriptor, unit.before, 'snapshot').body;
    if (applicationChanges(opening, before).some(c => !withinAllowed(c.path, unit.allowedPaths))) throw refuse('unexplained changes outside unit scope before effect');
    if (input.scope.some(path => !withinAllowed(path, unit.allowedPaths))) throw refuse('effect scope exceeds unit scope');
    assertGitExplained(root, descriptor, opening, before, unitId);
    const snapshot = newRecordV2(descriptor, 'snapshot', before, unitId);
    const body = { id, kind: input.kind, unitId, summary: input.summary, command: input.command, procedure: input.procedure, scope: input.scope, authorization: input.authorization, correlation: input.correlation, observation: input.observation, before: snapshot.ref };
    const intent = newRecordV2(descriptor, 'effect-intent', body, unitId, 1);
    const block = { id: effectBlockId(id), reason: `Effect ${id} awaits a correlated observation`, evidence: [intent.ref] };
    const next = { ...descriptor, nextRecord: descriptor.nextRecord + 2, effects: [...descriptor.effects, intent.ref], blocks: [...descriptor.blocks, block] };
    return { id, intent: intent.ref, ...publishMutation(root, descriptor, next, [snapshot.target, intent.target], 'effect-intent', options) };
  });
}
export function recordEffectOutcome(repoRoot, options = {}) {
  const { id, input, method = 'observed' } = options; validateId(id);
  expectKeys(input, ['result', 'observed', 'correlation', 'evidence'], 'effect outcome input');
  if (!['observed', 'reconciled'].includes(method)) throw refuse('invalid effect observation method');
  const root = resolveRepoRoot(repoRoot); const descriptor = v2Descriptor(root);
  const initial = readEffectsV2(root, descriptor).effects.find(e => e.id === id);
  if (!initial) throw refuse('effect intent does not exist');
  const unitId = initial.intent.unitId;
  return withV2Mutation(root, { ...options, unitId }, (root, descriptor) => {
    const effect = readEffectsV2(root, descriptor).effects.find(e => e.id === id);
    if (effect.outcome && effect.outcome.body.result !== 'partial') throw refuse('effect already concluded; replay forbidden');
    verifyCorrelation(effect.intent.body, { ...input, method });
    if (!Array.isArray(input.evidence) || input.evidence.length === 0 || !sameValue(input.evidence, effect.intent.body.observation.evidencePaths)) throw refuse('effect observation requires the exact declared evidence paths');
    const targets = input.evidence.map((path, index) => {
      const content = readPublicationFile(root, path);
      verifyEffectObservation(content, effect.intent.body, input);
      return { path: `${INCEPTION_AREA}/units/${unitId}/effect-evidence/${String(descriptor.nextRecord).padStart(4, '0')}/${String(index + 1).padStart(4, '0')}.bin`, content };
    });
    const after = observeRunApplication(root, descriptor);
    const before = readRecordV2(root, descriptor, effect.intent.body.before, 'snapshot').body;
    // The observed result is recorded even when the effect went outside its scope;
    // accepting those paths stays a human unit reconciliation (unitEffectExcess).
    const outsideScope = outsideEffectScope(effect.intent.body, before, after);
    const snapshot = newRecordV2(descriptor, 'snapshot', after, unitId);
    const body = { id, intent: effect.ref, result: input.result, observed: input.observed, correlation: input.correlation, evidence: targets.map(t => publicationRef(t.path, t.content)), after: snapshot.ref, method };
    const outcome = newRecordV2(descriptor, 'effect-outcome', body, unitId, 1);
    const next = { ...descriptor, nextRecord: descriptor.nextRecord + 2, effects: [...descriptor.effects, outcome.ref], blocks: input.result === 'partial' ? descriptor.blocks : descriptor.blocks.filter(b => b.id !== effectBlockId(id)) };
    return { id, outcome: outcome.ref, outsideScope, ...publishMutation(root, descriptor, next, [...targets, snapshot.target, outcome.target], 'effect-outcome', options) };
  });
}
// Paths an effect changed outside its declared scope, derived from its bound snapshots.
function outsideEffectScope(intent, before, after) {
  return applicationChanges(before, after).filter(c => !withinAllowed(c.path, intent.scope)).map(c => c.path);
}
// Concluded effects of a unit whose observed changes exceed their own scope:
// unit finish refuses them, and only a reconciliation with a human statement accepts them.
function unitEffectExcess(root, descriptor, unitId) {
  const snapshot = ref => readRecordV2(root, descriptor, ref, 'snapshot').body;
  return readEffectsV2(root, descriptor).effects
    .filter(e => e.intent.body.unitId === unitId && e.outcome !== null)
    .map(e => ({ id: e.id, paths: outsideEffectScope(e.intent.body, snapshot(e.intent.body.before), snapshot(e.outcome.body.after)) }))
    .filter(e => e.paths.length);
}
function effectExcessSummary(excess) {
  const named = excess.map(({ id, paths }) => {
    const shown = paths.slice(0, 5).map(path => JSON.stringify(path)).join(', ');
    return `effect ${id} changed ${paths.length > 5 ? `${shown} and ${paths.length - 5} more` : shown}`;
  });
  return `${named.join('; ')} outside its declared scope: only unit reconcile with an explicit human statement accepts them`;
}
export function createCheckpoint(repoRoot, options = {}) {
  validateText(options.label, 'checkpoint label');
  if (options.files !== undefined || options.filesFrom !== undefined) throw refuse('v2 checkpoint requires full inventory; --file and --files-from are forbidden');
  return withV2Mutation(repoRoot, options, (root, descriptor) => {
    if (descriptor.status === 'complete') throw refuse('complete run cannot create checkpoints');
    if (descriptor.blocks.length || readEffectsV2(root, descriptor).unresolved.length) throw refuse('unresolved blocks/effects prevent checkpoint');
    const application = observeRunApplication(root, descriptor); assertBaseline(root, descriptor, application);
    const snapshot = newRecordV2(descriptor, 'snapshot', application);
    const checkpoint = newRecordV2(descriptor, 'checkpoint', { label: options.label, phase: descriptor.phase, snapshot: snapshot.ref, previous: descriptor.checkpoints.at(-1) ?? null, unitIds: descriptor.units.filter(u => u.state === 'completed').map(u => u.id), effectIds: readEffectsV2(root, descriptor).effects.map(e => e.id) }, null, 1);
    const next = { ...descriptor, nextRecord: descriptor.nextRecord + 2, baseline: descriptor.baseline ?? snapshot.ref, checkpoints: [...descriptor.checkpoints, checkpoint.ref] };
    return { checkpoint: checkpoint.ref, ...publishMutation(root, descriptor, next, [snapshot.target, checkpoint.target], 'checkpoint', options) };
  });
}
export function verifyCheckpointV2(repoRoot, path) {
  const root = resolveRepoRoot(repoRoot); const descriptor = v2Descriptor(root);
  const ref = path === undefined ? descriptor.checkpoints.at(-1) : descriptor.checkpoints.find(r => r.path === path);
  if (!ref) throw refuse('checkpoint is not bound by descriptor');
  const checkpoint = readRecordV2(root, descriptor, ref, 'checkpoint');
  const snapshot = readRecordV2(root, descriptor, checkpoint.body.snapshot, 'snapshot').body;
  const observed = observeRunApplication(root, descriptor);
  const changes = applicationChanges(snapshot, observed);
  const divergences = [...changes.map(c => ({ path: c.path, reason: 'application-drift' })), ...(!sameValue(snapshot.git, observed.git) ? [{ path: '.git', reason: 'git-drift' }] : [])];
  if (!sameScope(snapshot, observed)) divergences.push({ path: '.', reason: 'scope-drift' });
  return { ok: divergences.length === 0, checkpoint: ref, divergences };
}
export function reconcileUnit(repoRoot, options = {}) {
  const { id, input } = options; validateId(id);
  expectKeys(input, ['evidence', 'reason', 'statement'], 'unit reconciliation input');
  validateText(input.reason); if (input.statement !== null) validateText(input.statement);
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) throw refuse('unit reconciliation requires evidence');
  input.evidence.forEach(path => validatePath(path));
  return withV2Mutation(repoRoot, { ...options, unitId: id }, (root, descriptor) => {
    const unit = descriptor.units.find(u => u.id === id);
    if (!unit || descriptor.status === 'complete') throw refuse('unit is unavailable for reconciliation');
    const unfinished = descriptor.activeUnit === id && ['started', 'blocked'].includes(unit.state);
    const closedIncomplete = unit.state === 'closed-incomplete';
    // Historical scope is not authority for later edits. Idle reconciliation is
    // a new human acceptance record, never a continuation of completed work.
    if (!unfinished && input.statement === null) throw refuse('historical unit reconciliation requires an explicit human statement');
    if (closedIncomplete) {
      if (descriptor.activeUnit !== null) throw refuse('closed-incomplete acceptance requires no active writer');
      verifyClosedUnitObservation(root, descriptor, unit);
    } else if (unit.capture !== null && unit.capture.state !== 'captured') throw refuse('writer stop must be established before reconciliation');
    if (readEffectsV2(root, descriptor).unresolved.length) throw refuse('uncertain effects require effect observation, not unit reconciliation');
    verifyOpeningUnitInputs(root, unit);
    const beforeRef = unfinished ? unit.before : descriptor.baseline;
    const before = readRecordV2(root, descriptor, beforeRef, 'snapshot').body;
    const after = observeRunApplication(root, descriptor); const changes = applicationChanges(before, after);
    let gitExplained = true;
    try { assertGitExplained(root, descriptor, before, after, id); } catch { gitExplained = false; }
    const unexplained = changes.some(c => !withinAllowed(c.path, unit.allowedPaths)) || !gitExplained || unitEffectExcess(root, descriptor, id).length > 0;
    if (unexplained && input.statement === null) throw refuse('outside-scope or Git drift requires explicit human statement');
    // Only a bound observed-stop closure permits missing interrupted outputs.
    // Human acceptance retains incomplete history and never attests check success.
    const outputs = closedIncomplete ? [] : unit.outputs;
    const reports = outputs.filter(o => o.role === 'report');
    for (const report of reports) verifyUnitReport(readPublicationFile(root, report.path), id);
    const paths = [...new Set([...outputs.map(o => o.path), ...input.evidence])];
    const targets = paths.map((path, i) => ({ path: `${INCEPTION_AREA}/units/${id}/reconciliation-evidence/${String(descriptor.nextRecord).padStart(4, '0')}/${String(i + 1).padStart(4, '0')}.bin`, content: readPublicationFile(root, path) }));
    const snapshot = newRecordV2(descriptor, 'snapshot', after, id);
    const evidence = targets.map(t => publicationRef(t.path, t.content));
    const reconciliation = newRecordV2(descriptor, 'reconciliation', { unitId: id, before: beforeRef, after: snapshot.ref, changes, effects: descriptor.effects.filter(ref => readRecordV2(root, descriptor, ref).unitId === id), evidence, reason: input.reason, statement: input.statement }, id, 1);
    const changed = applicationIdentity(before) !== applicationIdentity(after);
    const next = { ...descriptor, nextRecord: descriptor.nextRecord + 2, baseline: snapshot.ref, currentCycle: changed ? null : descriptor.currentCycle, verificationSession: changed ? null : descriptor.verificationSession,
      units: descriptor.units.map(u => u.id === id ? { ...u, ...(unfinished ? { state: 'completed', after: snapshot.ref } : {}), evidence: [...u.evidence, reconciliation.ref] } : u), activeUnit: null };
    return { id, reconciliation: reconciliation.ref, ...publishMutation(root, descriptor, next, [...targets, snapshot.target, reconciliation.target], 'unit-reconcile', options) };
  });
}
function requireObservationEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) throw refuse('stopped-writer observation or human decision requires evidence');
  evidence.forEach(path => validatePath(path));
  if (new Set(evidence).size !== evidence.length) throw refuse('duplicate observation evidence');
}
function stoppedWriterStatement(content, unitId) {
  // The coordinator records a human/cooperative-writer observation. As with
  // manual attest, shape and identity are checked, not the human's truthfulness.
  const observation = parseV2Json(content);
  expectKeys(observation, ['unitId', 'writerStopped', 'statement'], 'stopped-writer observation');
  if (observation.unitId !== unitId || observation.writerStopped !== true) throw refuse('stopped-writer observation must identify this unit and explicitly observe stop');
  validateText(observation.statement, 'stopped-writer statement');
  return observation.statement;
}
function observeStoppedWriter(root, unit, evidence, probe) {
  if (unit.capture !== null) {
    assertDeadCollector(unit.capture, probe);
    return null;
  }
  return stoppedWriterStatement(readPublicationFile(root, evidence[0]), unit.id);
}
function verifyClosedUnitObservation(root, descriptor, unit) {
  const opening = readRecordV2(root, descriptor, unit.before, 'snapshot');
  const closing = readRecordV2(root, descriptor, unit.after, 'snapshot');
  if (opening.unitId !== unit.id || closing.unitId !== unit.id) throw refuse('closure snapshots must identify this unit');
  const prefix = `${INCEPTION_AREA}/units/${unit.id}/closure-evidence/${String(closing.record).padStart(4, '0')}/`;
  for (const ref of unit.evidence) {
    if (ref.path !== `${INCEPTION_AREA}/reconciliations/${String(closing.record + 1).padStart(4, '0')}.json`) continue;
    const record = readRecordV2(root, descriptor, ref, 'reconciliation');
    const body = record.body;
    if (record.unitId !== unit.id || body.unitId !== unit.id || record.record !== closing.record + 1
        || !sameValue(body.before, unit.before) || !sameValue(body.after, unit.after) || !sameValue(body.changes, applicationChanges(opening.body, closing.body))
        || body.evidence.length === 0 || body.evidence.some((e, i) => e.path !== `${prefix}${String(i + 1).padStart(4, '0')}.bin`)) {
      throw refuse('invalid unit closure observation');
    }
    const targets = [...body.evidence, unit.after, ref];
    const publication = descriptor.publications.find(p => sameValue(p.targets, targets));
    if (!publication) throw refuse('unit closure observation lacks its bound publication');
    verifyPublicationTargets(root, publication.targets);
    if (unit.capture === null) {
      if (stoppedWriterStatement(readRefV2(root, body.evidence[0]), unit.id) !== body.statement) throw refuse('closure stopped-writer statement diverges');
    } else if (!['incomplete', 'captured'].includes(unit.capture.state) || body.statement !== null) {
      throw refuse('invalid captured writer closure observation');
    }
    // The closure publication already observed stop. Re-probing a historical
    // PID could instead inspect an unrelated process after PID reuse.
    return;
  }
  throw refuse('closed-incomplete unit lacks a bound stopped-writer closure observation');
}
export function closeIncompleteUnit(repoRoot, options = {}) {
  const { id, reason, evidence = [], probe } = options;
  validateId(id); validateText(reason, 'closure reason'); requireObservationEvidence(evidence);
  if (probe !== undefined && typeof probe !== 'function') throw refuse('writer probe must be a function');
  const root = resolveRepoRoot(repoRoot); const observed = v2Descriptor(root);
  const opening = observed.units.find(u => u.id === id);
  if (!opening || observed.activeUnit !== id || !['started', 'blocked'].includes(opening.state)) throw refuse('close-incomplete requires the active unfinished unit');
  observeStoppedWriter(root, opening, evidence, probe);
  return withV2Mutation(root, { ...options, unitId: id }, (root, descriptor) => {
    const unit = descriptor.units.find(u => u.id === id);
    if (descriptor.activeUnit !== id || !['started', 'blocked'].includes(unit.state)) throw refuse('unit writer identity changed');
    const statement = observeStoppedWriter(root, unit, evidence, probe);
    verifyOpeningUnitInputs(root, unit);
    const before = readRecordV2(root, descriptor, unit.before, 'snapshot').body;
    const after = observeRunApplication(root, descriptor);
    const targets = evidence.map((path, index) => ({ path: `${INCEPTION_AREA}/units/${id}/closure-evidence/${String(descriptor.nextRecord).padStart(4, '0')}/${String(index + 1).padStart(4, '0')}.bin`, content: readPublicationFile(root, path) }));
    const snapshot = newRecordV2(descriptor, 'snapshot', after, id);
    const reconciliation = newRecordV2(descriptor, 'reconciliation', { unitId: id, before: unit.before, after: snapshot.ref,
      changes: applicationChanges(before, after), effects: descriptor.effects.filter(ref => readRecordV2(root, descriptor, ref).unitId === id),
      evidence: targets.map(t => publicationRef(t.path, t.content)), reason, statement }, id, 1);
    const changed = applicationIdentity(before) !== applicationIdentity(after);
    const next = { ...descriptor, nextRecord: descriptor.nextRecord + 2,
      currentCycle: changed ? null : descriptor.currentCycle, verificationSession: changed ? null : descriptor.verificationSession,
      units: descriptor.units.map(u => u.id === id ? { ...u, state: 'closed-incomplete', after: snapshot.ref,
        evidence: [...u.evidence, reconciliation.ref], capture: u.capture && u.capture.state !== 'captured' ? { ...u.capture, state: 'incomplete', receipt: null } : u.capture } : u), activeUnit: null };
    // Observation does not accept application drift, resolve effects/blocks, or
    // produce a completed unit/result. Baseline deliberately retains its value.
    return { id, state: 'closed-incomplete', reconciliation: reconciliation.ref,
      ...publishMutation(root, descriptor, next, [...targets, snapshot.target, reconciliation.target], 'unit-close-incomplete', options) };
  });
}
export function resolveBlock(repoRoot, options = {}) {
  const { id, statement, evidence = [] } = options;
  validateId(id); validateText(statement, 'human block statement'); requireObservationEvidence(evidence);
  const root = resolveRepoRoot(repoRoot); const observed = v2Descriptor(root);
  return withV2Mutation(root, { ...options, unitId: observed.activeUnit }, (root, descriptor) => {
    if (descriptor.status === 'complete') throw refuse('complete run cannot resolve blocks');
    const block = descriptor.blocks.find(b => b.id === id);
    if (!block) throw refuse('named block does not exist');
    const number = descriptor.nextRecord;
    const targets = [...block.evidence.map(ref => readRefV2(root, ref)), ...evidence.map(path => readPublicationFile(root, path))]
      .map((content, index) => ({ path: `${INCEPTION_AREA}/resume-notes/${String(number).padStart(4, '0')}-evidence/${String(index + 1).padStart(4, '0')}.bin`, content }));
    const path = recordPath('resumeNotes', number);
    const content = renderResumeNote({ number, descriptor, next: `Human decision resolves only block ${id}`, needs: targets.map(t => t.path),
      note: `Block: ${id}\nReason: ${block.reason}\n\nHuman statement (verbatim):\n${statement}` });
    const next = { ...descriptor, nextRecord: number + 1, blocks: descriptor.blocks.filter(b => b.id !== id),
      resumeNotes: [...descriptor.resumeNotes, publicationRef(path, content)] };
    return { id, note: path, ...publishMutation(root, descriptor, next, [...targets, { path, content }], 'block-resolve', options) };
  });
}
export function resumeCheck(repoRoot) {
  const root = resolveRepoRoot(repoRoot); const descriptor = v2Descriptor(root); const divergences = [];
  if (descriptor.status === 'complete') {
    const result = verifyComplete(root);
    return { ok: result.ok, runId: descriptor.runId, activeUnit: null, next: descriptor.pending ? 'publish resume' : completedNextStep(root, descriptor), divergences: result.ok ? [] : [{ kind: 'completion', reason: result.reason }] };
  }
  const inspect = (name, action) => { try { action(); } catch (error) { divergences.push({ kind: name, reason: message(error) }); } };
  for (const publication of descriptor.publications) inspect('record', () => verifyPublicationTargets(root, publication.targets));
  if (descriptor.pending) divergences.push({ kind: 'pending', reason: `Resume publication ${descriptor.pending.id}` });
  const latestApproval = descriptor.approvals.at(-1);
  if (latestApproval) inspect('approval', () => readApprovalV2(root, descriptor, latestApproval));
  inspect('baseline', () => assertBaseline(root, descriptor, observeRunApplication(root, descriptor)));
  if (descriptor.checkpoints.length) inspect('checkpoint', () => {
    // Historical checkpoint contents remain valid after explained unit changes.
    // The latest baseline, rather than an older checkpoint, guards current work.
    const checkpoint = readRecordV2(root, descriptor, descriptor.checkpoints.at(-1), 'checkpoint');
    readRecordV2(root, descriptor, checkpoint.body.snapshot, 'snapshot');
  });
  let unresolved = [];
  inspect('effect', () => { unresolved = readEffectsV2(root, descriptor).unresolved; });
  for (const id of unresolved) divergences.push({ kind: 'effect', reason: `Effect ${id} remains uncertain` });
  for (const block of descriptor.blocks) divergences.push({ kind: 'block', id: block.id, reason: block.reason });
  return { ok: divergences.length === 0, runId: descriptor.runId, activeUnit: descriptor.activeUnit, next: descriptor.pending ? 'publish resume' : unresolved.length ? 'effect reconcile' : descriptor.activeUnit ? 'unit finish or reconcile' : nextStepFor(descriptor), divergences };
}
// Approval keeps source paths as logical identities; historical reads resolve
// the frozen copies, including the contract, rather than changing working bytes.
const CONTRACT_PATH_V2 = `${INCEPTION_AREA}/project/verification-contract.json`;
// One predicate decides which registered outputs every approval must cover.
const isProjectDecision = output => output.role === 'decision' && output.path.startsWith(PROJECT_PREFIX);
// Every unit counts, in any state, including closed-incomplete ones.
function projectDecisionPaths(descriptor) {
  return [...new Set(descriptor.units.flatMap(unit => unit.outputs.filter(isProjectDecision).map(output => output.path)))].sort();
}
function readApprovalV2(root, descriptor, ref, { historical = false } = {}) {
  if (!ref || !descriptor.approvals.some(r => sameValue(r, ref))) throw refuse('approval is not recorded');
  const record = readRecordV2(root, descriptor, ref, 'approval');
  const { body } = record;
  if (!body.documents.some(d => d.path === DECISION_REGISTER_PATH)
    || !body.documents.some(d => sameValue(d, body.contract))) throw refuse('approval must include decision register and contract');
  // Only the latest approval read as current compares the working documents and must
  // cover every registered decision; historical reads and earlier approvals verify
  // their frozen copies and keep their recorded scope.
  const current = !historical && sameValue(ref, descriptor.approvals.at(-1));
  let contract;
  for (const frozen of body.frozenDocuments) {
    const source = body.documents.find(d => d.path === frozen.sourcePath);
    if (!source.path.startsWith(PROJECT_PREFIX)) throw refuse('approval document must be in project scope');
    const bytes = readRefV2(root, frozen.artifact);
    if (current) readRefV2(root, source);
    if (source.path === body.contract.path) contract = parseVerificationContract(bytes);
  }
  if (current) {
    const covered = new Set(body.documents.map(d => d.path));
    const uncovered = projectDecisionPaths(descriptor).find(path => !covered.has(path));
    if (uncovered !== undefined) throw refuse(`${uncovered}: registered project decision is not covered by the latest approval`);
  }
  return { record, contract };
}
export function verifyApprovalV2(repoRoot, { approval, historical = false } = {}) {
  const root = resolveRepoRoot(repoRoot); const descriptor = v2Descriptor(root);
  const ref = approval === undefined ? descriptor.approvals.at(-1) : descriptor.approvals.find(r => r.path === approval);
  const { record } = readApprovalV2(root, descriptor, ref, { historical });
  return { ok: true, approval: ref.path, documents: record.body.documents, contract: record.body.contract };
}
// Discovery reads a decision's verification only from the coverage entry whose id is
// its lowercase register ID (DR-3 -> dr-3), so every register row needs one.
function assertDecisionCoverage(register, contract) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(register); } catch { throw refuse(`${DECISION_REGISTER_PATH}: must be valid UTF-8`); }
  const covered = new Set(contract.coverage.map(entry => entry.id));
  // A register row starts with its ID cell, optionally indented, emphasized or code-quoted.
  const rows = text.matchAll(/^[ \t]*\|?[ \t]*[*_`]*(DR-\d+)[*_`]*[ \t]*\|/gmu);
  const missing = [...new Set([...rows].map(match => match[1]))].filter(id => !covered.has(id.toLowerCase()));
  if (missing.length) throw refuse(`${DECISION_REGISTER_PATH}: ${missing.join(', ')}: no contract coverage entry with the lowercase register ID (dr-n)`);
}
function approveRunV2(repoRoot, options) {
  validateText(options.statement, 'statement');
  if (options.contract !== CONTRACT_PATH_V2) throw refuse('contract must be the exact project/verification-contract.json path');
  if (!Array.isArray(options.documents) || !options.documents.includes(DECISION_REGISTER_PATH)) throw refuse('documents must include the decision register');
  for (const path of options.documents) { validatePath(path); if (!path.startsWith(PROJECT_PREFIX)) throw refuse('document must be in project scope'); }
  if (new Set(options.documents).size !== options.documents.length) throw refuse('duplicate document');
  const paths = [...new Set([...options.documents, options.contract])].sort();
  // Reject malformed external JSON before acquiring a writer; repeat the read
  // and validation under the lease before freezing any approved bytes.
  parseVerificationContract(readPublicationFile(resolveRepoRoot(repoRoot), options.contract));
  return withV2Mutation(repoRoot, options, (root, descriptor) => {
    if (descriptor.phase !== 'approval' || descriptor.status !== 'active') throw refuse('approve requires active approval phase');
    if (descriptor.blocks.length || readEffectsV2(root, descriptor).unresolved.length) throw refuse('unresolved blocks or effects prevent approval');
    // Inventory admission uses the prior frozen contract, so editing its working
    // copy in approval cannot silently replace the accepted application baseline.
    assertBaseline(root, descriptor, observeRunApplication(root, descriptor));
    const requiredDocuments = new Set(descriptor.approvals.length ? readApprovalV2(root, descriptor, descriptor.approvals.at(-1), { historical: true }).record.body.documents.map(d => d.path) : []);
    for (const path of projectDecisionPaths(descriptor)) requiredDocuments.add(path);
    if ([...requiredDocuments].some(path => !paths.includes(path))) throw refuse('approval must include all current project decision documents');
    const targets = paths.map((path, index) => ({ path: `${INCEPTION_AREA}/approvals/${String(descriptor.nextRecord).padStart(4, '0')}-documents/${String(index + 1).padStart(4, '0')}.bin`, content: readPublicationFile(root, path) }));
    const documents = targets.map((t, i) => publicationRef(paths[i], t.content));
    const contractRef = documents.find(d => d.path === options.contract);
    const contract = parseVerificationContract(targets[paths.indexOf(options.contract)].content);
    assertDecisionCoverage(targets[paths.indexOf(DECISION_REGISTER_PATH)].content, contract);
    const approval = newRecordV2(descriptor, 'approval', { statement: options.statement, documents, contract: contractRef, frozenDocuments: targets.map((t, i) => ({ sourcePath: paths[i], artifact: publicationRef(t.path, t.content) })) });
    const snapshot = newRecordV2(descriptor, 'snapshot', observeApplication(root, { contract: contractRef, roots: contract.roots, exclusions: contract.exclusions }), null, 1);
    const next = { ...descriptor, nextRecord: descriptor.nextRecord + 2, approvals: [...descriptor.approvals, approval.ref], currentCycle: null, verificationSession: null, baseline: snapshot.ref };
    return { approval: approval.ref.path, documents, ...publishMutation(root, descriptor, next, [...targets, approval.target, snapshot.target], 'approve', options) };
  });
}
function assertVerificationEnvironment(contract, environment) {
  validateEnvironment(environment);
  const names = values => [...values].sort();
  if (!sameValue(names(environment.tools.map(t => t.name)), names(contract.environment.tools))
    || !sameValue(names(environment.resources.map(r => r.id)), names(contract.environment.resources.map(r => r.id)))) throw refuse('environment must observe exactly the approved tools and resources');
}
function assertVerificationReady(root, descriptor) {
  if (descriptor.phase !== 'verification' || descriptor.status !== 'active') throw refuse('verification requires active verification phase');
  if (descriptor.blocks.length || readEffectsV2(root, descriptor).unresolved.length) throw refuse('unresolved blocks or effects prevent verification');
  if (descriptor.pending) throw refuse('pending publication prevents verification');
}
// `live: false` reads the recorded baseline instead of the application, and the approval's
// frozen copies instead of the working documents: only a durable terminal reservation
// uses it, because its live comparison ran before it was written.
function verificationContext(root, descriptor, path, { live = true } = {}) {
  assertVerificationReady(root, descriptor);
  const ref = descriptor.currentCycle;
  if (!ref || ref.path !== path) throw refuse('cycle must identify the current verification cycle');
  const cycle = readRecordV2(root, descriptor, ref, 'cycle');
  if (!sameValue(cycle.body.approval, descriptor.approvals.at(-1))) throw refuse('cycle approval is stale');
  const { record: approval, contract } = readApprovalV2(root, descriptor, cycle.body.approval, { historical: !live });
  if (!sameValue(cycle.body.contract, approval.body.contract)) throw refuse('cycle contract is stale');
  assertVerificationEnvironment(contract, cycle.body.environment);
  const snapshot = readRecordV2(root, descriptor, cycle.body.snapshot, 'snapshot').body;
  let observed;
  if (live) { observed = observeRunApplication(root, descriptor); assertBaseline(root, descriptor, observed); }
  else observed = readRecordV2(root, descriptor, descriptor.baseline, 'snapshot').body;
  if (applicationIdentity(snapshot) !== applicationIdentity(observed)) throw refuse('cycle snapshot drift requires a new cycle');
  const session = readRecordV2(root, descriptor, descriptor.verificationSession, 'verification-session');
  if (!sameValue(session.body.cycle, ref)) throw refuse('verification session belongs to another cycle');
  return { ref, cycle, contract, snapshot, observed, session };
}
export function beginVerification(repoRoot, options = {}) {
  validateEnvironment(options.environment); validateText(options.reason);
  return withV2Mutation(repoRoot, options, (root, descriptor) => {
    assertVerificationReady(root, descriptor);
    const approvalRef = descriptor.approvals.at(-1);
    const { record: approval, contract } = readApprovalV2(root, descriptor, approvalRef);
    assertVerificationEnvironment(contract, options.environment);
    const observed = observeRunApplication(root, descriptor); assertBaseline(root, descriptor, observed);
    if (descriptor.currentCycle) {
      const prior = readRecordV2(root, descriptor, descriptor.currentCycle, 'cycle');
      const priorSnapshot = readRecordV2(root, descriptor, prior.body.snapshot, 'snapshot').body;
      if (sameValue(prior.body.approval, approvalRef) && sameValue(prior.body.contract, approval.body.contract)
        && sameValue(prior.body.environment, options.environment) && applicationIdentity(priorSnapshot) === applicationIdentity(observed)) {
        verificationContext(root, descriptor, descriptor.currentCycle.path);
        return { cycle: descriptor.currentCycle, session: descriptor.verificationSession, noop: true };
      }
    }
    const snapshot = newRecordV2(descriptor, 'snapshot', observed);
    const cycle = newRecordV2(descriptor, 'cycle', { approval: approvalRef, contract: approval.body.contract, snapshot: snapshot.ref, environment: options.environment, previous: descriptor.cycles.at(-1) ?? null, reason: options.reason }, null, 1);
    const session = newRecordV2(descriptor, 'verification-session', { cycle: cycle.ref, previous: null }, null, 2);
    const next = { ...descriptor, nextRecord: descriptor.nextRecord + 3, cycles: [...descriptor.cycles, cycle.ref], currentCycle: cycle.ref, verificationSession: session.ref, baseline: snapshot.ref };
    return { cycle: cycle.ref, session: session.ref, ...publishMutation(root, descriptor, next, [snapshot.target, cycle.target, session.target], 'verification-begin', options) };
  });
}
export function resumeVerification(repoRoot, options = {}) {
  validatePath(options.cycle);
  return withV2Mutation(repoRoot, options, (root, descriptor) => {
    const context = verificationContext(root, descriptor, options.cycle);
    const session = newRecordV2(descriptor, 'verification-session', { cycle: context.ref, previous: descriptor.verificationSession });
    const next = { ...descriptor, nextRecord: descriptor.nextRecord + 1, verificationSession: session.ref };
    return { cycle: context.ref, session: session.ref, ...publishMutation(root, descriptor, next, [session.target], 'verification-resume', options) };
  });
}
// The collector is the only command owner. These APIs only reserve and bind
// evidence; recovering an exact pending publication never executes its command.
function captureUnit(descriptor, id) {
  const unit = descriptor.units.find(u => u.id === id);
  if (!unit || unit.kind !== 'check') throw refuse('capture requires a check unit');
  return unit;
}
function captureCommandFor(context, checkId, purpose) {
  const check = context.contract.checks.find(c => c.id === checkId);
  const command = purpose === 'check' ? check?.automatic : check?.reuse.automatic;
  if (!command) throw refuse('automatic command is not approved for this check and purpose');
  return command;
}
function assertCaptureCwd(root, cwd) {
  if (cwd === '.') return;
  let path = root;
  for (const part of cwd.split('/')) {
    path = join(path, part); const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== resolve(path)) throw refuse('command cwd must be an ordinary confined directory');
  }
}
function captureOptions(options, allowed) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw refuse('capture options must be an object');
  for (const key of Object.keys(options)) if (!allowed.includes(key)) throw refuse(`unknown capture option: ${key}`);
}
function captureArgs(options) {
  captureOptions(options, ['unit', 'cycle', 'check', 'purpose', 'expectedRevision', 'reservation', 'fault']);
  validateId(options.unit); validatePath(options.cycle); validateId(options.check);
  if (options.purpose !== undefined && !['check', 'revalidate'].includes(options.purpose)) throw refuse('invalid capture purpose');
}
export function beginCapture(repoRoot, options = {}) {
  captureArgs(options);
  const root = resolveRepoRoot(repoRoot); const initial = v2Descriptor(root);
  const existing = captureUnit(initial, options.unit).capture;
  if (existing) {
    if (existing.cycle.path !== options.cycle || existing.checkId !== options.check || existing.purpose !== (options.purpose ?? 'check')) throw refuse('capture identity does not match the requested observation');
    return { recovery: recoverCapture(root, { unit: options.unit }) };
  }
  return withV2Mutation(root, { ...options, unitId: options.unit }, (root, descriptor) => {
    const context = verificationContext(root, descriptor, options.cycle);
    const unit = captureUnit(descriptor, options.unit);
    if (descriptor.activeUnit !== unit.id || unit.state !== 'started' || unit.capture !== null) throw refuse('capture requires an unused active check unit');
    if (!unit.inputs.some(r => sameValue(r, context.ref)) || !unit.inputs.some(r => sameValue(r, descriptor.verificationSession))) throw refuse('capture unit must bind cycle and session');
    const before = readRecordV2(root, descriptor, unit.before, 'snapshot').body;
    if (applicationIdentity(before) !== applicationIdentity(context.observed)) throw refuse('capture opening snapshot drift');
    const purpose = options.purpose ?? 'check'; const command = captureCommandFor(context, options.check, purpose);
    assertCaptureCwd(root, command.cwd);
    const directory = `${INCEPTION_AREA}/verification/captures/${String(descriptor.nextRecord).padStart(4, '0')}`;
    // Even an empty pre-existing directory is foreign; a reservation is always
    // published before the collector creates its namespace and any stream.
    if (lstatOrNull(join(root, directory)) !== null) throw refuse('foreign capture destination');
    const capture = { token: randomBytes(32).toString('hex'), pid: process.pid, cycle: context.ref, session: descriptor.verificationSession, checkId: options.check, purpose, command, stdoutPath: `${directory}/stdout.bin`, stderrPath: `${directory}/stderr.bin`, receiptPath: `${directory}/receipt.json`, state: 'running', receipt: null };
    const next = { ...descriptor, nextRecord: descriptor.nextRecord + 1, units: descriptor.units.map(u => u.id === unit.id ? { ...u, capture } : u) };
    publishMutation(root, descriptor, next, [], 'capture-begin', options);
    return { capture, root };
  });
}
function captureOutcome(receipt) {
  return receipt.signal === null && receipt.command.successExitCodes.includes(receipt.exitCode) ? 'succeeded' : 'failed';
}
function compactCapture(receipt, path) {
  return { path, check: receipt.checkId, exitCode: receipt.exitCode, signal: receipt.signal, outcome: captureOutcome(receipt) };
}
function validateBoundCapture(root, descriptor, unit, receipt, context, snapshotReader = ref => readRecordV2(root, descriptor, ref, 'snapshot').body) {
  const attempt = unit.capture;
  if (!attempt || receipt.runId !== descriptor.runId || receipt.unitId !== unit.id || receipt.token !== attempt.token
    || receipt.checkId !== attempt.checkId || receipt.purpose !== attempt.purpose || !sameValue(receipt.cycle, attempt.cycle)
    || !sameValue(receipt.session, attempt.session) || !sameValue(receipt.command, attempt.command)
    || receipt.stdout.path !== attempt.stdoutPath || receipt.stderr.path !== attempt.stderrPath
    || !sameValue(receipt.before, unit.before)) throw refuse('capture receipt does not match its reservation');
  if (!sameValue(receipt.cycle, context.ref) || !sameValue(receipt.command, captureCommandFor(context, receipt.checkId, receipt.purpose))) throw refuse('capture command or cycle is not approved');
  if (!unit.inputs.some(r => sameValue(r, receipt.cycle)) || !unit.inputs.some(r => sameValue(r, receipt.session))) throw refuse('capture unit input mismatch');
  const session = readRecordV2(root, descriptor, receipt.session, 'verification-session');
  if (!sameValue(session.body.cycle, receipt.cycle) || !sameValue(receipt.environment, context.cycle.body.environment)) throw refuse('capture session or environment mismatch');
  for (const ref of [receipt.stdout, receipt.stderr]) if (!sameValue(publicationFileRef(root, ref.path), ref)) throw refuse(`${ref.path}: capture stream digest diverges`);
  for (const ref of [receipt.before, receipt.after, ...(unit.after ? [unit.after] : [])]) {
    if (applicationIdentity(snapshotReader(ref)) !== applicationIdentity(context.snapshot)) throw refuse('capture snapshot drift');
  }
}
function captureObservation(receipt, ref, record) {
  return { ref, automatic: true, record: { record, body: { cycle: receipt.cycle, session: receipt.session, purpose: receipt.purpose, checks: [{ id: receipt.checkId, result: captureOutcome(receipt), observed: `Command exit ${receipt.exitCode ?? 'none'}, signal ${receipt.signal ?? 'none'}` }] } } };
}
function automaticObservations(root, descriptor, context, includeUnit = null) {
  const observations = [];
  for (const unit of descriptor.units) {
    if (unit.kind !== 'check' || (unit.state !== 'completed' && unit.id !== includeUnit) || unit.capture?.state !== 'captured') continue;
    if (!sameValue(unit.capture.cycle, context.ref)) continue;
    for (const evidence of unit.evidence) readRefV2(root, evidence);
    const ref = unit.capture.receipt;
    if (!unit.evidence.some(r => sameValue(r, ref))) throw refuse('capture receipt is not bound to unit evidence');
    const receipt = parseCaptureReceipt(readRefV2(root, ref));
    validateBoundCapture(root, descriptor, unit, receipt, context);
    observations.push(captureObservation(receipt, ref, Number(basename(receipt.after.path, '.json'))));
  }
  return observations.sort((a, b) => a.record.record - b.record.record);
}
function verificationObservations(root, descriptor, context, includeUnit = null) {
  return [...manualObservations(root, descriptor, context, includeUnit), ...automaticObservations(root, descriptor, context, includeUnit)].sort((a, b) => a.record.record - b.record.record);
}
function resultBody(context, observations, status, checkId) {
  const candidates = observations.filter(o => o.record.body.checks.some(c => c.id === checkId));
  const latest = automatic => candidates.filter(o => !!o.automatic === automatic && o.record.body.purpose === 'check').at(-1)?.ref ?? null;
  return { cycle: context.ref, checkId, result: status.result, automatic: latest(true), manual: latest(false), revalidation: status.evidence.filter(ref => candidates.some(o => sameValue(o.ref, ref) && o.record.body.purpose === 'revalidate')), observed: status.observed, limits: status.limits };
}
export function finishCapture(repoRoot, options = {}) {
  captureOptions(options, ['unit', 'token', 'startedAt', 'endedAt', 'exitCode', 'signal', 'failure', 'expectedRevision', 'reservation', 'fault']);
  validateId(options.unit);
  if (typeof options.token !== 'string' || !/^[a-f0-9]{64}$/u.test(options.token)) throw refuse('capture token is required');
  if (options.failure !== undefined) validateText(options.failure, 'capture failure');
  return withV2Mutation(repoRoot, { ...options, unitId: options.unit }, (root, descriptor) => {
    const unit = captureUnit(descriptor, options.unit); const attempt = unit.capture;
    if (!attempt || attempt.token !== options.token || attempt.pid !== process.pid || attempt.state !== 'running') throw refuse('capture reservation is not owned by this collector');
    if (options.failure !== undefined) return markCaptureIncomplete(root, descriptor, unit, options);
    const context = verificationContext(root, descriptor, attempt.cycle.path);
    const snapshot = newRecordV2(descriptor, 'snapshot', context.observed, unit.id);
    const receipt = { schema: CAPTURE_SCHEMA_V2, runId: descriptor.runId, cycle: attempt.cycle, session: attempt.session, checkId: attempt.checkId, unitId: unit.id, purpose: attempt.purpose, token: attempt.token, command: attempt.command, startedAt: options.startedAt, endedAt: options.endedAt, exitCode: options.exitCode, signal: options.signal, stdout: publicationFileRef(root, attempt.stdoutPath), stderr: publicationFileRef(root, attempt.stderrPath), before: unit.before, after: snapshot.ref, environment: context.cycle.body.environment };
    const content = serializeCaptureReceipt(receipt); const ref = publicationRef(attempt.receiptPath, content);
    validateBoundCapture(root, descriptor, unit, receipt, context, r => sameValue(r, snapshot.ref) ? context.observed : readRecordV2(root, descriptor, r, 'snapshot').body);
    const observations = [...verificationObservations(root, descriptor, context, unit.id), captureObservation(receipt, ref, descriptor.nextRecord)].sort((a, b) => a.record.record - b.record.record);
    const status = verificationCheckStatuses(context, observations, descriptor.verificationSession).find(s => s.id === attempt.checkId);
    const result = newRecordV2(descriptor, 'result', resultBody(context, observations, status, attempt.checkId), unit.id, 1);
    const next = { ...descriptor, nextRecord: descriptor.nextRecord + 2, units: descriptor.units.map(u => u.id === unit.id ? { ...u, capture: { ...attempt, state: 'captured', receipt: ref }, evidence: [...u.evidence, snapshot.ref, ref, result.ref] } : u) };
    publishMutation(root, descriptor, next, [snapshot.target, { path: ref.path, content }, result.target], 'capture-finish', options);
    return compactCapture(receipt, ref.path);
  });
}
function assertDeadCollector(attempt, probe = pid => process.kill(pid, 0)) {
  try { probe(attempt.pid); } catch (error) { if (error.code === 'ESRCH') return; throw refuse('capture collector is unverifiable'); }
  throw refuse('capture collector is alive');
}
function markCaptureIncomplete(root, descriptor, unit, options) {
  if (unit.capture.state !== 'incomplete') {
    const next = { ...descriptor, units: descriptor.units.map(u => u.id === unit.id ? { ...u, capture: { ...u.capture, state: 'incomplete', receipt: null } } : u) };
    publishMutation(root, descriptor, next, [], 'capture-incomplete', options);
  }
  return { path: unit.capture.receiptPath, check: unit.capture.checkId, exitCode: null, signal: null, outcome: 'incomplete' };
}
export function recoverCapture(repoRoot, options = {}) {
  captureOptions(options, ['unit', 'probe', 'expectedRevision', 'reservation', 'fault']);
  validateId(options.unit); assertV2Options(options);
  const root = resolveRepoRoot(repoRoot); const observed = v2Descriptor(root);
  if (options.expectedRevision !== undefined && options.expectedRevision !== observed.revision) throw refuse('incompatible capture revision');
  const initial = captureUnit(observed, options.unit);
  if (!initial.capture) throw refuse('no registered capture attempt');
  if (initial.capture.state !== 'captured') assertDeadCollector(initial.capture, options.probe);
  return withV2SnapshotLease(root, observed, descriptor => {
    const unit = captureUnit(descriptor, options.unit);
    if (!sameValue(unit.capture, initial.capture) || descriptor.revision !== observed.revision) throw refuse('capture reservation changed');
    if (unit.capture.state !== 'captured') assertDeadCollector(unit.capture, options.probe);
    if (descriptor.pending) {
      const pending = descriptor.pending;
      if (pending.operation !== 'capture-finish' || descriptor.activeUnit !== unit.id) throw refuse('unrelated pending publication prevents capture recovery');
      const target = pending.targets.find(t => t.path === unit.capture.receiptPath);
      if (!target) throw refuse('pending capture has no complete receipt');
      const receipt = parseCaptureReceipt(Buffer.from(target.contentBase64, 'base64'));
      const context = verificationContext(root, { ...descriptor, pending: null }, unit.capture.cycle.path);
      validateBoundCapture(root, descriptor, unit, receipt, context, ref => {
        const staged = pending.targets.find(t => sameValue({ path: t.path, bytes: t.bytes, sha256: t.sha256 }, ref));
        return staged ? parseInceptionRecord(Buffer.from(staged.contentBase64, 'base64'), { runId: descriptor.runId }).body : readRecordV2(root, descriptor, ref, 'snapshot').body;
      });
      const bound = captureUnit(pending.nextDescriptor, unit.id).capture;
      if (bound.state !== 'captured' || !sameValue(bound.receipt, publicationRef(target.path, Buffer.from(target.contentBase64, 'base64')))) throw refuse('pending capture binding mismatch');
      finishPublicationLocked(root, descriptor, options);
      return compactCapture(receipt, target.path);
    }
    if (unit.capture.state === 'captured') {
      const context = verificationContext(root, descriptor, unit.capture.cycle.path);
      const receipt = parseCaptureReceipt(readRefV2(root, unit.capture.receipt));
      validateBoundCapture(root, descriptor, unit, receipt, context);
      return compactCapture(receipt, unit.capture.receiptPath);
    }
    // No command rerun, no receipt import, and no success inferred from merely
    // present output. Partial streams remain at their reserved exact paths.
    return markCaptureIncomplete(root, descriptor, unit, options);
  });
}

function manualObservations(root, descriptor, context, includeUnit = null) {
  const observations = [];
  for (const unit of descriptor.units) {
    if (unit.kind !== 'check' || (unit.state !== 'completed' && unit.id !== includeUnit)) continue;
    for (const ref of unit.evidence.filter(r => r.path.startsWith(`${INCEPTION_AREA}/verification/manual/`))) {
      const manual = readRecordV2(root, descriptor, ref, 'manual');
      if (!sameValue(manual.body.cycle, context.ref)) continue;
      if (manual.unitId !== unit.id || !unit.inputs.some(r => sameValue(r, manual.body.cycle)) || !unit.inputs.some(r => sameValue(r, manual.body.session))) throw refuse('manual evidence has a different unit, cycle or session');
      for (const evidence of unit.evidence) readRefV2(root, evidence);
      if (!sameValue(manual.body.before, unit.before)) throw refuse('manual before is not the opening unit snapshot');
      for (const snapshotRef of [manual.body.before, manual.body.after, ...(unit.after ? [unit.after] : [])]) {
        const snapshot = readRecordV2(root, descriptor, snapshotRef, 'snapshot').body;
        if (applicationIdentity(snapshot) !== applicationIdentity(context.snapshot)) throw refuse('manual snapshot drift');
      }
      const session = readRecordV2(root, descriptor, manual.body.session, 'verification-session');
      if (!sameValue(session.body.cycle, context.ref) || !sameValue(manual.body.environment, context.cycle.body.environment)) throw refuse('manual session or environment mismatch');
      for (const item of manual.body.checks) {
        const check = context.contract.checks.find(c => c.id === item.id);
        const procedure = manual.body.purpose === 'check' ? check?.manual : check?.reuse.manual;
        if (!procedure || item.procedure !== procedure.procedure) throw refuse('manual procedure is not approved');
      }
      observations.push({ ref, record: manual });
    }
  }
  return observations.sort((a, b) => a.record.record - b.record.record);
}
function verificationCheckStatuses(context, observations, sessionRef) {
  return context.contract.checks.map(check => {
    const candidates = observations.filter(o => o.record.body.checks.some(c => c.id === check.id));
    const latest = automatic => candidates.filter(o => !!o.automatic === automatic && o.record.body.purpose === 'check').at(-1);
    const primary = [check.automatic ? latest(true) : null, check.manual ? latest(false) : null].filter(Boolean);
    const expected = Number(check.automatic !== null) + Number(check.manual !== null);
    const item = o => o?.record.body.checks.find(c => c.id === check.id);
    const newest = Math.max(0, ...primary.map(o => o.record.record));
    const revalidation = [true, false].map(automatic => candidates.filter(o => !!o.automatic === automatic && o.record.body.purpose === 'revalidate'
      && sameValue(o.record.body.session, sessionRef) && o.record.record > newest).at(-1));
    const freshNeeded = primary.some(o => check.reuse.policy === 'reobserve' && !sameValue(o.record.body.session, sessionRef));
    const refreshMissing = freshNeeded && ((check.reuse.automatic !== null && item(revalidation[0])?.result !== 'succeeded')
      || (check.reuse.manual !== null && item(revalidation[1])?.result !== 'succeeded'));
    let result = primary.some(o => item(o).result === 'failed') ? 'failed' : primary.length === expected ? 'succeeded' : primary.length ? 'executed' : 'not-executed';
    if (refreshMissing) result = 'not-executed';
    if (primary.length && revalidation.some(o => item(o)?.result === 'failed')) result = 'failed';
    const evidence = [...primary, ...revalidation.filter(Boolean)].sort((a, b) => a.record.record - b.record.record);
    return { id: check.id, required: check.required, type: check.type, result, evidence: evidence.map(o => o.ref), observed: item(evidence.at(-1))?.observed ?? '', limits: refreshMissing ? 'Current session reobservation required' : primary.length < expected ? 'Required evidence not recorded' : '' };
  });
}
export function verificationStatus(repoRoot, { cycle } = {}) {
  const root = resolveRepoRoot(repoRoot); const descriptor = v2Descriptor(root);
  const context = verificationContext(root, descriptor, cycle);
  const checks = verificationCheckStatuses(context, verificationObservations(root, descriptor, context), descriptor.verificationSession);
  return { cycle: context.ref, session: descriptor.verificationSession, checks, missing: checks.filter(c => c.required && c.result !== 'succeeded').map(c => c.id) };
}
export function attestVerification(repoRoot, options = {}) {
  validatePath(options.cycle); validateManualInput(options.input);
  const root = resolveRepoRoot(repoRoot); const initial = v2Descriptor(root);
  const unitId = initial.activeUnit;
  if (unitId === null) throw refuse('manual attest requires an active check unit');
  return withV2Mutation(root, { ...options, unitId }, (root, descriptor) => {
    const context = verificationContext(root, descriptor, options.cycle);
    const unit = descriptor.units.find(u => u.id === unitId);
    if (unit.kind !== 'check' || unit.state !== 'started') throw refuse('manual attest requires a started check unit');
    if (!unit.inputs.some(r => sameValue(r, context.ref)) || !unit.inputs.some(r => sameValue(r, descriptor.verificationSession))) throw refuse('check unit must bind current cycle and session before observation');
    if (!sameValue(options.input.environment, context.cycle.body.environment)) throw refuse('manual environment differs from cycle');
    // Each check has one manual observation boundary per unit, regardless of
    // purpose. Distinct IDs can share a unit; another attempt needs a new unit.
    const alreadyObserved = new Set(unit.evidence.filter(ref => ref.path.startsWith(`${INCEPTION_AREA}/verification/manual/`))
      .flatMap(ref => readRecordV2(root, descriptor, ref, 'manual').body.checks.map(check => check.id)));
    if (options.input.checks.some(check => alreadyObserved.has(check.id))) throw refuse('check already observed in this unit; register a new unit for another observation');
    for (const item of options.input.checks) {
      const check = context.contract.checks.find(c => c.id === item.id);
      const procedure = options.input.purpose === 'check' ? check?.manual : check?.reuse.manual;
      if (!procedure || procedure.procedure !== item.procedure) throw refuse('manual procedure must match the approved check or revalidation procedure');
    }
    const before = readRecordV2(root, descriptor, unit.before, 'snapshot').body;
    if (applicationIdentity(before) !== applicationIdentity(context.observed)) throw refuse('manual check snapshot drift');
    assertGitExplained(root, descriptor, before, context.observed, unit.id);
    const snapshot = newRecordV2(descriptor, 'snapshot', context.observed, unit.id);
    const manual = newRecordV2(descriptor, 'manual', { cycle: context.ref, session: descriptor.verificationSession, purpose: options.input.purpose, checks: options.input.checks, statement: options.input.statement, environment: options.input.environment, before: unit.before, after: snapshot.ref }, unit.id, 1);
    const observations = [...verificationObservations(root, descriptor, context, unit.id), { ref: manual.ref, record: { record: descriptor.nextRecord + 1, body: { ...options.input, cycle: context.ref, session: descriptor.verificationSession } } }];
    const statuses = verificationCheckStatuses(context, observations, descriptor.verificationSession);
    const results = options.input.checks.map((check, index) => {
      const status = statuses.find(s => s.id === check.id);
      return newRecordV2(descriptor, 'result', resultBody(context, observations, status, check.id), unit.id, index + 2);
    });
    const next = { ...descriptor, nextRecord: descriptor.nextRecord + 2 + results.length, units: descriptor.units.map(u => u.id === unit.id ? { ...u, evidence: [...u.evidence, snapshot.ref, manual.ref, ...results.map(r => r.ref)] } : u) };
    return { manual: manual.ref, results: results.map(r => r.ref), ...publishMutation(root, descriptor, next, [snapshot.target, manual.target, ...results.map(r => r.target)], 'verification-attest', options) };
  });
}

function validateSummaryLimits(limits) {
  if (!Array.isArray(limits)) throw refuse('limits must be an array of descriptive strings');
  limits.forEach(limit => validateText(limit, 'summary limit'));
}
function deriveSummary(context, descriptor, observations, limits) {
  validateSummaryLimits(limits);
  const checks = verificationCheckStatuses(context, observations, descriptor.verificationSession).map(check => ({ ...check,
    observed: check.observed || 'No accepted evidence recorded',
    limits: check.limits || (check.result === 'failed' ? 'Recorded check failed' : ''),
  }));
  const coverage = context.contract.coverage.map(entry => ({ id: entry.id, component: entry.component,
    status: entry.status === 'future' ? 'future' : entry.checks.length > 0 && entry.checks.every(id => checks.find(check => check.id === id)?.result === 'succeeded') ? 'verified' : 'unverified', checks: entry.checks }));
  return { cycle: context.ref, checks, coverage, limits: [...limits] };
}
function summaryTargets(descriptor, body) {
  const summary = newRecordV2(descriptor, 'summary', body);
  const reportPath = `${INCEPTION_AREA}/verification/reports/${String(descriptor.nextRecord + 1).padStart(4, '0')}.md`;
  const report = { path: reportPath, content: renderVerificationReport(parseInceptionRecord(summary.target.content)) };
  return { summary, report, reportRef: publicationRef(report.path, report.content) };
}
export function summarizeVerification(repoRoot, options = {}) {
  validatePath(options.cycle); validateSummaryLimits(options.limits);
  return withV2Mutation(repoRoot, options, (root, descriptor) => {
    const context = verificationContext(root, descriptor, options.cycle);
    verifyEvidenceClosure(root, descriptor);
    const body = deriveSummary(context, descriptor, verificationObservations(root, descriptor, context), options.limits);
    const { summary, report, reportRef } = summaryTargets(descriptor, body);
    const next = { ...descriptor, nextRecord: descriptor.nextRecord + 2 };
    return { summary: summary.ref, report: reportRef, ...publishMutation(root, descriptor, next, [summary.target, report], 'verification-summarize', options) };
  });
}

// Traverse only declared immutable refs. Historical project inputs resolve through
// their approved/frozen copies, never through an overwritten working document.
// File existence, filesystem recency and agent-authored result prose confer no authority.
function verifyEvidenceClosure(root, descriptor) {
  for (const publication of descriptor.publications) verifyPublicationTargets(root, publication.targets);
  const frozen = new Map();
  const key = ref => JSON.stringify(ref);
  for (const ref of descriptor.approvals) {
    const { record } = readApprovalV2(root, descriptor, ref, { historical: true });
    for (const document of record.body.documents) frozen.set(key(document), record.body.frozenDocuments.find(f => f.sourcePath === document.path).artifact);
  }
  const refs = new Map();
  const walk = value => {
    if (value === null || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'path') && Object.hasOwn(value, 'bytes') && Object.hasOwn(value, 'sha256') && !Object.hasOwn(value, 'mode')) { visit(value); return; }
    for (const child of Object.values(value)) walk(child);
  };
  const visit = original => {
    const ref = frozen.get(key(original)) ?? original;
    const previous = refs.get(ref.path);
    if (previous) { if (!sameValue(previous, ref)) throw refuse('evidence has conflicting reference digests'); return; }
    // Hash streams without buffering their potentially large content in memory.
    if (ref.path.endsWith('/stdout.bin') || ref.path.endsWith('/stderr.bin')) {
      if (!sameValue(publicationFileRef(root, ref.path), ref)) throw refuse(`${ref.path}: stream digest diverges`);
      refs.set(ref.path, ref); return;
    }
    const bytes = readRefV2(root, ref); refs.set(ref.path, ref);
    if (/\/(?:approvals|snapshots|checkpoints|effects|reconciliations|verification\/(?:cycles|sessions|manual|results))\/\d+\.json$/u.test(ref.path)) {
      const record = readRecordV2(root, descriptor, ref); walk(record.body);
    } else if (/\/verification\/captures\/\d+\/receipt\.json$/u.test(ref.path)) {
      const receipt = parseCaptureReceipt(bytes);
      if (receipt.runId !== descriptor.runId) throw refuse('capture belongs to a different run');
      walk(receipt);
    }
  };
  walk([descriptor.approvals, descriptor.checkpoints, descriptor.effects, descriptor.cycles, descriptor.verificationSession, descriptor.baseline]);
  for (const unit of descriptor.units) {
    walk([unit.before, unit.after, unit.evidence, unit.capture?.receipt ?? null]);
    for (const [index, input] of unit.inputs.entries()) {
      const copy = { ...input, path: unitInputCopyPath(unit.id, index) };
      if (!unit.evidence.some(ref => sameValue(ref, copy))) throw refuse('unit is missing its frozen opening input');
      visit(copy);
    }
  }
  return [...refs.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function assertTerminalWriters(root, descriptor) {
  if (descriptor.activeUnit !== null || descriptor.units.some(unit => ['started', 'blocked'].includes(unit.state))) throw refuse('active writer prevents completion');
  if (descriptor.units.some(unit => unit.capture && unit.capture.state !== 'captured' && unit.state !== 'closed-incomplete')) throw refuse('incomplete capture writer prevents completion');
  if (descriptor.blocks.length || readEffectsV2(root, descriptor).unresolved.length) throw refuse('unresolved blocks or uncertain effects prevent completion');
  if (descriptor.pending) throw refuse('pending publication prevents completion');
}
function finalCheckpoint(root, descriptor, context, path, { historical = false } = {}) {
  const ref = descriptor.checkpoints.at(-1);
  if (!ref || ref.path !== path) throw refuse('complete requires the current final checkpoint');
  const checkpoint = readRecordV2(root, descriptor, ref, 'checkpoint');
  const snapshot = readRecordV2(root, descriptor, checkpoint.body.snapshot, 'snapshot').body;
  if (checkpoint.body.phase !== 'verification' || applicationIdentity(snapshot) !== applicationIdentity(context.snapshot)
    || !sameValue(checkpoint.body.unitIds, descriptor.units.filter(unit => unit.state === 'completed').map(unit => unit.id))
    || !sameValue(checkpoint.body.effectIds, readEffectsV2(root, descriptor).effects.map(effect => effect.id))
    || checkpoint.record <= context.session.record
    || descriptor.units.some(unit => unit.after && Number(basename(unit.after.path, '.json')) >= checkpoint.record)) throw refuse('final checkpoint does not cover the current verified delivery');
  if (!historical && !sameValue(snapshot.git, context.observed.git)) throw refuse('final checkpoint Git drift');
  return { ref, snapshot: checkpoint.body.snapshot };
}
function requireSuccessfulChecks(summary) {
  const missing = summary.checks.filter(check => check.required && check.result !== 'succeeded');
  if (missing.length) throw refuse(`required checks lack successful evidence: ${missing.map(check => check.id).join(', ')}`);
}
function latestSummaryLimits(root, descriptor) {
  for (const publication of [...descriptor.publications].reverse()) {
    const ref = publication.targets.find(target => target.path.startsWith(`${INCEPTION_AREA}/verification/summaries/`));
    if (!ref) continue;
    const summary = readRecordV2(root, descriptor, ref, 'summary');
    if (sameValue(summary.body.cycle, descriptor.currentCycle)) return summary.body.limits;
  }
  return [];
}
function completionInputs(root, descriptor, options) {
  assertTerminalWriters(root, descriptor);
  const live = options.live ?? true;
  const context = verificationContext(root, descriptor, options.cycle, { live });
  const checkpoint = finalCheckpoint(root, descriptor, context, options.checkpoint, { historical: !live });
  const evidence = verifyEvidenceClosure(root, descriptor);
  const summary = deriveSummary(context, descriptor, verificationObservations(root, descriptor, context), options.limits ?? latestSummaryLimits(root, descriptor));
  requireSuccessfulChecks(summary);
  return { context, checkpoint, evidence, summary };
}
function completeV2(root, descriptor, options) {
  if (options.verification !== undefined) throw refuse('v2 complete forbids --verification; report is derived from evidence');
  if (options.gitCommits !== undefined) throw refuse('--git-commits is allowed only on a return to approval');
  if (!options.cycle || !options.checkpoint) throw refuse('complete requires --cycle and --checkpoint');
  // Complete always compares the live application; only binding its reservation does not.
  const { context, checkpoint, evidence, summary: body } = completionInputs(root, descriptor, { ...options, live: true });
  const { summary, report, reportRef } = summaryTargets(descriptor, body);
  const completion = newRecordV2(descriptor, 'completion', { approval: context.cycle.body.approval, contract: context.cycle.body.contract,
    cycle: context.ref, snapshot: checkpoint.snapshot, checkpoint: checkpoint.ref, summary: summary.ref, report: reportRef, evidence }, null, 2);
  const next = { ...descriptor, nextRecord: descriptor.nextRecord + 3, phase: 'complete', status: 'complete', completion: completion.ref,
    history: [...descriptor.history, { at: options.now.toISOString(), from: { phase: descriptor.phase, status: descriptor.status }, to: { phase: 'complete', status: 'complete' }, reason: options.reason }] };
  return { phase: 'complete', status: 'complete', completion: completion.ref,
    ...publishMutation(root, descriptor, next, [summary.target, report, { path: `${INCEPTION_AREA}/verification/results.md`, content: report.content }, completion.target], 'complete', options) };
}

function verifyTerminalReservation(root, descriptor) {
  const pending = descriptor.pending;
  const plannedRecord = (ref, kind) => {
    const target = pending.targets.find(target => sameValue(({ path: target.path, bytes: target.bytes, sha256: target.sha256 }), ref));
    if (!target) throw refuse(`terminal reservation is missing ${kind}`);
    const record = parseInceptionRecord(Buffer.from(target.contentBase64, 'base64'), { runId: descriptor.runId, number: Number(basename(ref.path, '.json')) });
    if (record.kind !== kind) throw refuse(`terminal reservation expected ${kind}`);
    return record;
  };
  const completion = plannedRecord(pending.nextDescriptor.completion, 'completion');
  const summary = plannedRecord(completion.body.summary, 'summary');
  // The reservation is the commit point: complete compared the live application and
  // Git under the lease before writing it. Binding it re-derives the completion from
  // recorded evidence only; later drift is verify-complete's application drift.
  const { context, checkpoint, evidence, summary: derived } = completionInputs(root, { ...descriptor, pending: null }, {
    cycle: completion.body.cycle.path, checkpoint: completion.body.checkpoint.path, limits: summary.body.limits, live: false,
  });
  const report = renderVerificationReport(summary);
  const expected = { approval: context.cycle.body.approval, contract: context.cycle.body.contract, cycle: context.ref,
    snapshot: checkpoint.snapshot, checkpoint: checkpoint.ref, summary: completion.body.summary,
    report: publicationRef(completion.body.report.path, report), evidence };
  if (!sameValue(summary.body, derived) || !sameValue(completion.body, expected)) throw refuse('terminal reservation differs from receipt-derived completion');
  for (const path of [completion.body.report.path, `${INCEPTION_AREA}/verification/results.md`]) {
    const target = pending.targets.find(target => target.path === path);
    if (!target || !Buffer.from(target.contentBase64, 'base64').equals(Buffer.from(report))) throw refuse('terminal reservation report diverges');
  }
}

function verifyCompletedState(root, descriptor, { verifyGovernance = verifyCanonicalGovernance, live = true } = {}) {
  if (descriptor.phase !== 'complete' || descriptor.status !== 'complete' || descriptor.completion === null) throw refuse('run is not complete');
  assertTerminalWriters(root, descriptor);
  const completion = readRecordV2(root, descriptor, descriptor.completion, 'completion');
  const body = completion.body;
  if (!sameValue(body.approval, descriptor.approvals.at(-1)) || !sameValue(body.cycle, descriptor.currentCycle)) throw refuse('completion approval or cycle mismatch');
  const { record: approval, contract } = readApprovalV2(root, descriptor, body.approval, { historical: !live });
  if (!sameValue(body.contract, approval.body.contract)) throw refuse('completion contract mismatch');
  const cycle = readRecordV2(root, descriptor, body.cycle, 'cycle');
  if (!sameValue(cycle.body.approval, body.approval) || !sameValue(cycle.body.contract, body.contract)) throw refuse('completion cycle binding mismatch');
  assertVerificationEnvironment(contract, cycle.body.environment);
  const snapshot = readRecordV2(root, descriptor, cycle.body.snapshot, 'snapshot').body;
  const finalSnapshot = readRecordV2(root, descriptor, body.snapshot, 'snapshot').body;
  const baseline = readRecordV2(root, descriptor, descriptor.baseline, 'snapshot').body;
  if (![finalSnapshot, baseline].every(value => applicationIdentity(value) === applicationIdentity(snapshot))) throw refuse('completion snapshot mismatch');
  const session = readRecordV2(root, descriptor, descriptor.verificationSession, 'verification-session');
  if (!sameValue(session.body.cycle, body.cycle)) throw refuse('completion session mismatch');
  // Binding a terminal reservation checks recorded evidence only (see verifyTerminalReservation).
  let observed = live ? observeApplication(root, { contract: body.contract, roots: contract.roots, exclusions: contract.exclusions }) : snapshot;
  // The canonical init receipt can certify an exact inverse projection.
  // No provider directory is implicitly excluded here.
  if (live && verifyGovernance !== undefined) {
    if (typeof verifyGovernance !== 'function') throw refuse('governance verifier must be a synchronous function');
    const projected = verifyGovernance(root, { descriptor, completion, snapshot, observed });
    if (projected !== null && projected !== undefined) {
      // Reuse the snapshot schema instead of accepting a boolean bypass.
      serializeInceptionRecord({ schema: 'steepy-inception-record/v2', runId: descriptor.runId, record: 1, kind: 'snapshot', at: completion.at, unitId: null, body: projected });
      observed = projected;
    }
  }
  if (applicationIdentity(snapshot) !== applicationIdentity(observed)) throw refuse(`application-drift: completed application identity changed: ${driftSummary(snapshot, observed)}`);
  const context = { ref: body.cycle, cycle, contract, snapshot, observed, session };
  const checkpoint = finalCheckpoint(root, descriptor, context, body.checkpoint.path, { historical: true });
  if (!sameValue(checkpoint.ref, body.checkpoint) || !sameValue(checkpoint.snapshot, body.snapshot)) throw refuse('completion checkpoint mismatch');
  const evidence = verifyEvidenceClosure(root, descriptor);
  if (!sameValue(evidence, body.evidence)) throw refuse('completion transitive evidence closure mismatch');
  const summary = readRecordV2(root, descriptor, body.summary, 'summary');
  const derived = deriveSummary(context, descriptor, verificationObservations(root, descriptor, context), summary.body.limits);
  requireSuccessfulChecks(derived);
  if (!sameValue(summary.body, derived)) throw refuse('summary differs from receipt-derived results');
  const report = renderVerificationReport(summary);
  if (!readRefV2(root, body.report).equals(Buffer.from(report))) throw refuse('report differs from receipt-derived summary');
  if (!readPublicationFile(root, `${INCEPTION_AREA}/verification/results.md`).equals(Buffer.from(report))) throw refuse('final report projection diverges');
  for (const ref of descriptor.resumeNotes) readRefV2(root, ref);
  return { ok: true, runId: descriptor.runId, completion: descriptor.completion,
    inputPaths: [...new Set([RUN_DESCRIPTOR_PATH, body.approval.path, ...approval.body.documents.map(ref => ref.path), body.summary.path, body.report.path])],
    checks: derived.checks.map(({ id, required, type, result }) => ({ id, required, type, result })), coverage: derived.coverage };
}
export function verifyComplete(repoRoot, options = {}) {
  try { const root = resolveRepoRoot(repoRoot); return verifyCompletedState(root, v2Descriptor(root), { ...options, live: true }); }
  catch (error) { return { ok: false, reason: message(error) }; }
}
function completedNextStep(root, descriptor) {
  const hasClosingNote = descriptor.resumeNotes.some(ref => {
    try { return readRefV2(root, ref).toString('utf8').includes(`- \`${descriptor.completion.path}\``); } catch { return false; }
  });
  return hasClosingNote ? nextStepFor(descriptor) : 'resume closing presentation only; reference the published completion in a resume-note';
}

function v2Input(root, path) {
  validatePath(path); if (!path.startsWith(`${INCEPTION_AREA}/`)) throw refuse('input must be an exact inception file');
  return parseV2Json(readPublicationFile(root, path));
}

function unitBeginCommand(root, values) {
  validatePath(values.input);
  if (!values.input.startsWith(`${INCEPTION_AREA}/`)) throw refuse('unit input must be an exact inception file');
  return { ok: true, fields: beginUnit(root, { id: values.id, input: parseV2Json(readPublicationFile(root, values.input)), previousUnit: values['previous-unit'] ?? null }) };
}

// ---------------------------------------------------------------------------
// CLI (HC1, HC6, HC7)
// ---------------------------------------------------------------------------

const REPO_ROOT_OPTION = Object.freeze({ type: 'string' });
const STRING_OPTION = Object.freeze({ type: 'string' });
const GIT_COMMITS_CHOICES = Object.freeze(['allowed', 'forbidden']);

// Commands that handle a missing or unsupported descriptor themselves: start needs no run,
// classify reports invalid-state, abandon --resume runs after run.json has moved, and
// verify-complete returns its read-only { ok: false, reason } refusal.
const ADMISSION_EXEMPT = Object.freeze(['start', 'classify', 'abandon', 'verify-complete']);

const COMMANDS = Object.freeze({
  block: { subcommands: {
    resolve: { options: { 'repo-root': REPO_ROOT_OPTION, id: STRING_OPTION, statement: STRING_OPTION, evidence: { type: 'string', multiple: true } }, required: ['id', 'statement', 'evidence'], enums: {}, run: (root, values) => ({ ok: true, fields: resolveBlock(root, { id: values.id, statement: values.statement, evidence: values.evidence }) }) },
  } },
  'verify-complete': { options: { 'repo-root': REPO_ROOT_OPTION }, required: [], enums: {}, run: root => { const result = verifyComplete(root); return { ok: result.ok, fields: result, error: result.reason }; } },
  'resume-check': { options: { 'repo-root': REPO_ROOT_OPTION }, required: [], enums: {}, run: root => { const result = resumeCheck(root); return { ok: result.ok, fields: result, error: result.ok ? undefined : 'resume has unresolved divergences' }; } },
  verification: { subcommands: {
    summarize: { options: { 'repo-root': REPO_ROOT_OPTION, cycle: STRING_OPTION, limits: STRING_OPTION }, required: ['cycle', 'limits'], enums: {}, run: (root, values) => ({ ok: true, fields: summarizeVerification(root, { cycle: values.cycle, limits: v2Input(root, values.limits) }) }) },
    begin: { options: { 'repo-root': REPO_ROOT_OPTION, environment: STRING_OPTION, reason: STRING_OPTION }, required: ['environment', 'reason'], enums: {}, run: (root, values) => ({ ok: true, fields: beginVerification(root, { environment: v2Input(root, values.environment), reason: values.reason }) }) },
    resume: { options: { 'repo-root': REPO_ROOT_OPTION, cycle: STRING_OPTION }, required: ['cycle'], enums: {}, run: (root, values) => ({ ok: true, fields: resumeVerification(root, { cycle: values.cycle }) }) },
    status: { options: { 'repo-root': REPO_ROOT_OPTION, cycle: STRING_OPTION }, required: ['cycle'], enums: {}, run: (root, values) => ({ ok: true, fields: verificationStatus(root, { cycle: values.cycle }) }) },
    attest: { options: { 'repo-root': REPO_ROOT_OPTION, cycle: STRING_OPTION, input: STRING_OPTION }, required: ['cycle', 'input'], enums: {}, run: (root, values) => ({ ok: true, fields: attestVerification(root, { cycle: values.cycle, input: v2Input(root, values.input) }) }) },
  } },
  unit: { subcommands: {
    'close-incomplete': { options: { 'repo-root': REPO_ROOT_OPTION, id: STRING_OPTION, reason: STRING_OPTION, evidence: { type: 'string', multiple: true } }, required: ['id', 'reason', 'evidence'], enums: {}, run: (root, values) => ({ ok: true, fields: closeIncompleteUnit(root, { id: values.id, reason: values.reason, evidence: values.evidence }) }) },
    reconcile: { options: { 'repo-root': REPO_ROOT_OPTION, id: STRING_OPTION, input: STRING_OPTION }, required: ['id', 'input'], enums: {}, run: (root, values) => ({ ok: true, fields: reconcileUnit(root, { id: values.id, input: v2Input(root, values.input) }) }) },
    begin: { options: { 'repo-root': REPO_ROOT_OPTION, id: STRING_OPTION, input: STRING_OPTION, 'previous-unit': STRING_OPTION }, required: ['id', 'input'], enums: {}, run: unitBeginCommand },
    finish: { options: { 'repo-root': REPO_ROOT_OPTION, id: STRING_OPTION, evidence: { type: 'string', multiple: true } }, required: ['id'], enums: {}, run: (root, values) => ({ ok: true, fields: finishUnit(root, { id: values.id, evidence: values.evidence }) }) },
  } },
  publish: { subcommands: {
    resume: { options: { 'repo-root': REPO_ROOT_OPTION, reservation: STRING_OPTION }, required: ['reservation'], enums: {}, run: (root, values) => ({ ok: true, fields: resumePublication(root, { reservation: values.reservation }) }) },
  } },
  inspect: {
    options: { 'repo-root': REPO_ROOT_OPTION },
    required: [],
    enums: {},
    run: inspectCommand,
  },
  classify: {
    options: { 'repo-root': REPO_ROOT_OPTION, maturity: STRING_OPTION },
    required: [],
    enums: { maturity: MATURITIES },
    run: classifyCommand,
  },
  start: {
    options: { 'repo-root': REPO_ROOT_OPTION, harness: STRING_OPTION, capabilities: STRING_OPTION, 'git-commits': STRING_OPTION, 'exclusions-stdin': { type: 'boolean' } },
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
      cycle: STRING_OPTION,
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
    options: { 'repo-root': REPO_ROOT_OPTION, statement: STRING_OPTION, document: { type: 'string', multiple: true }, contract: STRING_OPTION },
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
          input: STRING_OPTION,
        },
        required: ['id', 'input'],
        enums: {},
        run: effectIntentCommand,
      },
      outcome: {
        options: { 'repo-root': REPO_ROOT_OPTION, id: STRING_OPTION, input: STRING_OPTION },
        required: ['id', 'input'],
        enums: {},
        run: effectOutcomeCommand,
      },
      reconcile: { options: { 'repo-root': REPO_ROOT_OPTION, id: STRING_OPTION, input: STRING_OPTION }, required: ['id', 'input'], enums: {}, run: (root, values) => ({ ok: true, fields: recordEffectOutcome(root, { id: values.id, input: v2Input(root, values.input), method: 'reconciled' }) }) },
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
    options: { 'repo-root': REPO_ROOT_OPTION, reason: STRING_OPTION, resume: { type: 'boolean' } },
    required: [],
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
    const root = resolveRepoRoot(values['repo-root']);
    // Admission precedes command-specific input reads, writer leases and files.
    if (!ADMISSION_EXEMPT.includes(command)) v2Descriptor(root);
    result = resolved.spec.run(root, values);
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

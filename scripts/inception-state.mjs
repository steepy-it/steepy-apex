#!/usr/bin/env node
// The v1 local inception descriptor `.apex/inception/state.json`: closed
// schema and combination rules, canonical bytes, monotone init transitions,
// and a thin CLI for `start`, `inspect`, and `update`.
//
// The descriptor recognizes pre-hub state and the transfer to init. It is not
// a workflow manifest, never certifies human approval or completion on its
// own, and never runs bootstrap, deploy, or Git-mutating commands. `inspect`
// reads only the descriptor and the ignore guard; references are data.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  INCEPTION_AREA,
  INCEPTION_GUARD_CONTENT,
  INCEPTION_GUARD_PATH,
  INCEPTION_STATE_PATH,
  bindInceptionArea,
  classifyInceptionPath,
  ensureInceptionGuard,
  ensureInceptionRunDirectory,
  isCanonicalRunId,
  isSha256Hex,
  readInceptionFile,
  sha256Hex,
  writeInceptionFile,
} from './inception-paths.mjs';

export const INCEPTION_STATE_SCHEMA_VERSION = 1;
export const INCEPTION_PHASES = Object.freeze([
  'reconnaissance', 'architecture', 'research', 'approval', 'bootstrap', 'verification', 'init', 'complete',
]);
export const INCEPTION_STATUSES = Object.freeze(['active', 'blocked', 'complete']);
export const INCEPTION_INIT_STATUSES = Object.freeze(['not-started', 'in-progress', 'complete']);

const TOP_KEYS = ['schemaVersion', 'runId', 'phase', 'status', 'approval', 'checkpoint', 'init'];
const INIT_KEYS = ['status', 'handoff', 'receipt'];
const REFERENCE_KEYS = ['path', 'sha256'];
const MUTABLE_KEYS = ['phase', 'status', 'approval', 'checkpoint', 'init'];
const DESCRIPTOR_STATES = ['pre-hub', 'init-in-progress', 'init-complete'];
const PATH_ERROR_CODES = new Set([
  'INCEPTION_PATH', 'INCEPTION_UNSAFE', 'INCEPTION_MISSING', 'INCEPTION_TOO_LARGE', 'INCEPTION_UNGUARDED',
]);
const MAX_REPORTED_TRACKED = 50;
const GIT_LOCATION_VARIABLES = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
];
const USAGE = `usage: inception-state.mjs <start|inspect|update> --root <dir> --state ${INCEPTION_STATE_PATH}`
  + ' [start: --run-id <uuid>] [update: --expected-sha256 <hex> --set <json>]';

function fail(code, message) {
  const error = new Error(`inception state: ${message}`);
  error.code = code;
  throw error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Unknown names and values are never echoed: they may carry credentials.
function assertExactKeys(value, keys, label) {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    fail('INCEPTION_STATE_INVALID', `${label} has an unsupported field; allowed fields are ${keys.join(', ')}`);
  }
  if (keys.some((key) => !Object.hasOwn(value, key))) {
    fail('INCEPTION_STATE_INVALID', `${label} fields are incomplete; expected ${keys.join(', ')}`);
  }
}

function validateReference(value, label, runId) {
  if (value === null) return null;
  if (!isPlainObject(value)) fail('INCEPTION_STATE_INVALID', `${label} must be null or an exact reference { path, sha256 }`);
  assertExactKeys(value, REFERENCE_KEYS, label);
  let classified = null;
  try {
    classified = classifyInceptionPath(value.path, { runId });
  } catch {
    // Reported below without echoing the rejected value.
  }
  if (classified?.kind !== 'run-file') {
    fail('INCEPTION_STATE_INVALID', `${label}.path must be an exact file of run ${runId}`);
  }
  if (!isSha256Hex(value.sha256)) fail('INCEPTION_STATE_INVALID', `${label}.sha256 must be a lowercase SHA-256 digest`);
  return Object.freeze({ path: value.path, sha256: value.sha256 });
}

export function validateInceptionState(value) {
  if (!isPlainObject(value)) fail('INCEPTION_STATE_INVALID', 'descriptor must be a JSON object');
  assertExactKeys(value, TOP_KEYS, 'descriptor');
  if (value.schemaVersion !== INCEPTION_STATE_SCHEMA_VERSION) {
    fail('INCEPTION_STATE_INVALID', `schemaVersion must be ${INCEPTION_STATE_SCHEMA_VERSION}; other versions are unsupported`);
  }
  if (!isCanonicalRunId(value.runId)) fail('INCEPTION_STATE_INVALID', 'runId must be a canonical lowercase UUID');
  if (!INCEPTION_PHASES.includes(value.phase)) {
    fail('INCEPTION_STATE_INVALID', `phase must be one of ${INCEPTION_PHASES.join(', ')}`);
  }
  if (!INCEPTION_STATUSES.includes(value.status)) {
    fail('INCEPTION_STATE_INVALID', `status must be one of ${INCEPTION_STATUSES.join(', ')}`);
  }
  const approval = validateReference(value.approval, 'approval', value.runId);
  const checkpoint = validateReference(value.checkpoint, 'checkpoint', value.runId);
  if (!isPlainObject(value.init)) fail('INCEPTION_STATE_INVALID', 'init must be an object { status, handoff, receipt }');
  assertExactKeys(value.init, INIT_KEYS, 'init');
  if (!INCEPTION_INIT_STATUSES.includes(value.init.status)) {
    fail('INCEPTION_STATE_INVALID', `init.status must be one of ${INCEPTION_INIT_STATUSES.join(', ')}`);
  }
  const handoff = validateReference(value.init.handoff, 'init.handoff', value.runId);
  const receipt = validateReference(value.init.receipt, 'init.receipt', value.runId);

  const phaseIndex = INCEPTION_PHASES.indexOf(value.phase);
  if (phaseIndex >= INCEPTION_PHASES.indexOf('bootstrap') && approval === null) {
    fail('INCEPTION_STATE_INVALID', `phase ${value.phase} requires an approval reference`);
  }
  if (value.phase === 'complete' && value.init.status !== 'complete') {
    fail('INCEPTION_STATE_INVALID', 'phase complete requires init.status complete');
  }
  if (value.status === 'complete' && value.init.status !== 'complete') {
    fail('INCEPTION_STATE_INVALID', 'status complete requires init.status complete');
  }
  if (value.init.status !== 'not-started' && phaseIndex < INCEPTION_PHASES.indexOf('init')) {
    fail('INCEPTION_STATE_INVALID', `init.status ${value.init.status} requires phase init or complete`);
  }
  return Object.freeze({
    schemaVersion: INCEPTION_STATE_SCHEMA_VERSION,
    runId: value.runId,
    phase: value.phase,
    status: value.status,
    approval,
    checkpoint,
    init: Object.freeze({ status: value.init.status, handoff, receipt }),
  });
}

export function createInitialInceptionState(runId) {
  return validateInceptionState({
    schemaVersion: INCEPTION_STATE_SCHEMA_VERSION,
    runId,
    phase: 'reconnaissance',
    status: 'active',
    approval: null,
    checkpoint: null,
    init: { status: 'not-started', handoff: null, receipt: null },
  });
}

export function serializeInceptionState(value) {
  return `${JSON.stringify(validateInceptionState(value), null, 2)}\n`;
}

// Accepts only canonical bytes, so duplicate keys, reordering, and
// whitespace variants cannot alias a valid descriptor.
export function parseInceptionState(input) {
  let text = input;
  if (input instanceof Uint8Array) {
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
    } catch {
      fail('INCEPTION_STATE_INVALID', 'descriptor is not valid UTF-8');
    }
  }
  if (typeof text !== 'string') fail('INCEPTION_STATE_INVALID', 'descriptor must be text');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('INCEPTION_STATE_INVALID', 'descriptor is not valid JSON');
  }
  const valid = validateInceptionState(parsed);
  if (serializeInceptionState(valid) !== text) fail('INCEPTION_STATE_INVALID', 'descriptor bytes are not canonical');
  return valid;
}

function sameReference(left, right) {
  return left?.path === right?.path && left?.sha256 === right?.sha256;
}

// The static schema stays open so seeded descriptors remain classifiable; the
// transfer rules apply to transitions: starting init binds its handoff and
// its receipt identity, both paths stay fixed afterwards, and the receipt
// digest advances only when init completes.
export function assertInceptionTransition(previous, next) {
  const before = validateInceptionState(previous);
  const after = validateInceptionState(next);
  if (before.runId !== after.runId) fail('INCEPTION_STATE_TRANSITION', 'runId is immutable within a run');
  const from = INCEPTION_INIT_STATUSES.indexOf(before.init.status);
  const to = INCEPTION_INIT_STATUSES.indexOf(after.init.status);
  if (to < from) {
    fail('INCEPTION_STATE_TRANSITION', `init.status cannot move back from ${before.init.status} to ${after.init.status}`);
  }
  if (from === 0 && to > 0 && after.init.handoff === null) {
    fail('INCEPTION_STATE_TRANSITION', 'starting init requires the init.handoff reference');
  }
  if (from === 0 && to > 0 && after.init.receipt === null) {
    fail('INCEPTION_STATE_TRANSITION', 'starting init requires the init.receipt reference that binds its receipt');
  }
  if (from > 0 && !sameReference(before.init.handoff, after.init.handoff)) {
    fail('INCEPTION_STATE_TRANSITION', 'init.handoff is immutable once init has started');
  }
  if (from > 0 && before.init.receipt !== null) {
    if (after.init.receipt?.path !== before.init.receipt.path) {
      fail('INCEPTION_STATE_TRANSITION', 'the init.receipt path is immutable once bound');
    }
    if (!(from === 1 && to === 2) && after.init.receipt.sha256 !== before.init.receipt.sha256) {
      fail('INCEPTION_STATE_TRANSITION', 'the init.receipt digest advances only when init completes');
    }
  }
  if (from < 2 && to === 2 && after.init.receipt === null) {
    fail('INCEPTION_STATE_TRANSITION', 'completing init requires the init.receipt reference');
  }
}

function isPathError(error) {
  return PATH_ERROR_CODES.has(error?.code);
}

function guardStatus(root) {
  let bytes;
  try {
    bytes = readInceptionFile(root, INCEPTION_GUARD_PATH);
  } catch (error) {
    if (error.code === 'INCEPTION_MISSING') return 'missing';
    throw error;
  }
  return bytes.toString('latin1') === INCEPTION_GUARD_CONTENT ? 'exact' : 'foreign';
}

function invalid(reason) {
  return Object.freeze({ state: 'invalid', reason });
}

// Classifies local inception state from the canonical descriptor and the
// ignore guard only. It never reads referenced documents and never grants
// validity to a hub.
export function inspectInceptionState(root) {
  try {
    const area = bindInceptionArea(root);
    if (area.area === 'missing') return Object.freeze({ state: 'absent' });
    let bytes;
    try {
      bytes = readInceptionFile(root, INCEPTION_STATE_PATH);
    } catch (error) {
      if (error.code !== 'INCEPTION_MISSING') throw error;
      const guard = guardStatus(root);
      if (guard === 'foreign') return invalid('ignore guard has unexpected content');
      return Object.freeze({ state: 'incomplete', reason: 'descriptor is absent' });
    }
    const guard = guardStatus(root);
    if (guard === 'missing') return invalid('ignore guard is missing');
    if (guard === 'foreign') return invalid('ignore guard has unexpected content');
    const descriptor = parseInceptionState(bytes);
    const state = {
      'not-started': 'pre-hub',
      'in-progress': 'init-in-progress',
      complete: 'init-complete',
    }[descriptor.init.status];
    return Object.freeze({ state, sha256: sha256Hex(bytes), descriptor });
  } catch (error) {
    if (isPathError(error) || error?.code === 'INCEPTION_STATE_INVALID') return invalid(error.message);
    throw error;
  }
}

// The hub linter's view: the same descriptor-and-guard classification,
// reduced to what pre-hub recognition needs. It never throws, never returns
// the descriptor's references, and never follows them. Only `pre-hub` can
// qualify for the linter's exemption; hub compatibility is the linter's call.
export function inspectPreHubState(root) {
  let inspected;
  try {
    inspected = inspectInceptionState(root);
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z_]+$/u.test(error.code) ? ` (${error.code})` : '';
    return Object.freeze({ state: 'invalid', reason: `inception state could not be inspected safely${code}` });
  }
  if (!DESCRIPTOR_STATES.includes(inspected.state)) return inspected;
  const { runId, phase, status } = inspected.descriptor;
  return Object.freeze({ state: inspected.state, runId, phase, status });
}

function gitEnvironment(env) {
  const result = { ...(env ?? process.env), LC_ALL: 'C', LANGUAGE: 'C' };
  for (const key of GIT_LOCATION_VARIABLES) delete result[key];
  return result;
}

function runGit(cwd, env, args, input) {
  return spawnSync('git', args, {
    cwd,
    env,
    input,
    encoding: 'buffer',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
}

function boundedText(bytes) {
  return Buffer.from(bytes ?? []).toString('utf8').replace(/[\x00-\x1F\x7F]+/g, ' ').trim().slice(0, 200);
}

function repositoryRoot(root) {
  if (typeof root !== 'string' || root.length === 0) fail('INCEPTION_ROOT', 'repository root must be a non-empty path');
  const path = resolve(root);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    fail('INCEPTION_ROOT', `repository root cannot be inspected (${error.code ?? 'error'})`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('INCEPTION_ROOT', 'repository root must be a physical directory');
  return path;
}

function gitLine(result, label) {
  if (result.error || ![0, 1].includes(result.status)) {
    fail('INCEPTION_STATE_GIT', `${label} failed: ${boundedText(result.stderr) || result.error?.code || 'error'}`);
  }
  return result.status === 0 ? Buffer.from(result.stdout).toString('utf8').replace(/\n$/u, '') : null;
}

// Read-only branch and HEAD of the repository containing `root`, or null when
// Git is unavailable or `root` is not in a work tree. A detached HEAD has no
// branch and an unborn branch has no HEAD commit; neither is fabricated.
export function observeRepositoryRevision(root, { env } = {}) {
  const cwd = repositoryRoot(root);
  const childEnv = gitEnvironment(env);
  const probe = runGit(cwd, childEnv, ['rev-parse', '--is-inside-work-tree']);
  if (probe.error?.code === 'ENOENT') return null;
  if (probe.error) fail('INCEPTION_STATE_GIT', `git could not run (${probe.error.code ?? 'error'})`);
  if (probe.status !== 0) {
    if (/not a git repository/i.test(boundedText(probe.stderr))) return null;
    fail('INCEPTION_STATE_GIT', boundedText(probe.stderr) || 'git rev-parse failed');
  }
  if (boundedText(probe.stdout) !== 'true') fail('INCEPTION_STATE_GIT', 'the repository root is not inside a Git work tree');
  const branch = gitLine(runGit(cwd, childEnv, ['symbolic-ref', '--quiet', '--short', 'HEAD']), 'git symbolic-ref');
  const head = gitLine(runGit(cwd, childEnv, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']), 'git rev-parse HEAD');
  if (head !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head)) fail('INCEPTION_STATE_GIT', 'git returned a malformed HEAD commit id');
  return Object.freeze({ branch: branch || null, head });
}

// Verifies effective Git exclusion for the physical area and reports already
// tracked area content. Read-only: it never adds, removes, or commits.
export function observeInceptionGit(root, { runId, env } = {}) {
  if (runId !== undefined && !isCanonicalRunId(runId)) {
    fail('INCEPTION_STATE_ARGUMENT', 'runId must be a canonical lowercase UUID');
  }
  const area = bindInceptionArea(root);
  if (area.area === 'missing') return null;
  const childEnv = gitEnvironment(env);
  const probe = runGit(area.areaPath, childEnv, ['rev-parse', '--is-inside-work-tree']);
  if (probe.error?.code === 'ENOENT') return Object.freeze({ state: 'unavailable' });
  if (probe.error) return Object.freeze({ state: 'unverified', reason: `git could not run (${probe.error.code ?? 'error'})` });
  if (probe.status !== 0) {
    if (/not a git repository/i.test(boundedText(probe.stderr))) return Object.freeze({ state: 'not-repository' });
    return Object.freeze({ state: 'unverified', reason: boundedText(probe.stderr) || 'git rev-parse failed' });
  }
  if (boundedText(probe.stdout) !== 'true') {
    return Object.freeze({ state: 'unverified', reason: 'the inception area is not inside a Git work tree' });
  }

  const probes = ['state.json', '.gitignore', ...(runId ? [`${runId}/document.md`] : [])];
  const check = runGit(
    area.areaPath,
    childEnv,
    ['check-ignore', '--no-index', '--verbose', '--non-matching', '-z', '--stdin'],
    Buffer.from(`${probes.join('\0')}\0`, 'utf8'),
  );
  if (check.error || ![0, 1].includes(check.status)) {
    return Object.freeze({ state: 'unverified', reason: boundedText(check.stderr) || 'git check-ignore failed' });
  }
  const fields = Buffer.from(check.stdout).toString('utf8').split('\0');
  const records = [];
  for (let index = 0; index + 3 < fields.length; index += 4) records.push(fields[index + 2]);
  if (records.length !== probes.length) {
    return Object.freeze({ state: 'unverified', reason: 'git check-ignore returned an unexpected record count' });
  }
  const ignored = records.every((pattern) => pattern !== '' && !pattern.startsWith('!'));

  const listed = runGit(area.areaPath, childEnv, ['ls-files', '-z', '--', '.']);
  if (listed.error || listed.status !== 0) {
    return Object.freeze({ state: 'unverified', reason: boundedText(listed.stderr) || 'git ls-files failed' });
  }
  const tracked = Buffer.from(listed.stdout).toString('utf8').split('\0')
    .filter((entry) => entry !== '')
    .map((entry) => `${INCEPTION_AREA}/${entry}`)
    .sort();
  return Object.freeze({
    state: ignored ? 'ignored' : 'not-ignored',
    tracked: Object.freeze(tracked.slice(0, MAX_REPORTED_TRACKED)),
    trackedCount: tracked.length,
  });
}

function checkpointOption(onCheckpoint) {
  if (onCheckpoint !== undefined && typeof onCheckpoint !== 'function') {
    fail('INCEPTION_STATE_ARGUMENT', 'onCheckpoint must be a function');
  }
  return onCheckpoint;
}

// Starts a run: ignore guard first, then verified Git exclusion, then the
// create-only descriptor, then the run directory. An existing descriptor is
// never overwritten; an exactly initial descriptor of the same run is the
// known start, which a retry may complete.
export function startInceptionRun(root, { runId, onCheckpoint, env } = {}) {
  const checkpoint = checkpointOption(onCheckpoint);
  const id = runId ?? randomUUID();
  if (!isCanonicalRunId(id)) fail('INCEPTION_STATE_ARGUMENT', 'runId must be a canonical lowercase UUID');
  const initial = createInitialInceptionState(id);
  const initialBytes = serializeInceptionState(initial);
  const existing = inspectInceptionState(root);
  if (DESCRIPTOR_STATES.includes(existing.state)) {
    if (existing.descriptor.runId === id && existing.sha256 === sha256Hex(initialBytes)) {
      ensureInceptionRunDirectory(root, id);
      const git = observeInceptionGit(root, { runId: id, env });
      return Object.freeze({ created: false, runId: id, sha256: existing.sha256, descriptor: existing.descriptor, git });
    }
    fail('INCEPTION_STATE_EXISTS', 'an inception run already exists; start never overwrites it');
  }
  if (existing.state === 'invalid') {
    fail('INCEPTION_STATE_EXISTS', `an inception area already exists in an invalid state (${existing.reason})`);
  }

  ensureInceptionGuard(root);
  const git = observeInceptionGit(root, { runId: id, env });
  if (git.state === 'not-ignored' || git.state === 'unverified') {
    fail('INCEPTION_STATE_GIT', `Git does not confirm that the inception area is ignored (${git.state}); no descriptor was written`);
  }
  checkpoint?.(Object.freeze({ operation: 'start', phase: 'before-descriptor' }));
  const written = writeInceptionFile(root, INCEPTION_STATE_PATH, initialBytes, { expectedSha256: null });
  checkpoint?.(Object.freeze({ operation: 'start', phase: 'before-run-directory' }));
  ensureInceptionRunDirectory(root, id);
  return Object.freeze({ created: true, runId: id, sha256: written.sha256, descriptor: initial, git });
}

function verifyReferences(root, descriptor) {
  const references = [
    ['approval', descriptor.approval],
    ['checkpoint', descriptor.checkpoint],
    ['init.handoff', descriptor.init.handoff],
    ['init.receipt', descriptor.init.receipt],
  ];
  for (const [label, reference] of references) {
    if (reference === null) continue;
    let bytes;
    try {
      bytes = readInceptionFile(root, reference.path, { runId: descriptor.runId });
    } catch (error) {
      if (error.code === 'INCEPTION_MISSING') {
        fail('INCEPTION_STATE_REFERENCE', `${label} reference file is missing: '${reference.path}'`);
      }
      throw error;
    }
    if (sha256Hex(bytes) !== reference.sha256) {
      fail('INCEPTION_STATE_REFERENCE', `${label} reference digest does not match '${reference.path}'`);
    }
  }
}

// Applies explicit changes to the current descriptor. The caller supplies the
// digest it last observed; every reference is re-verified against its file.
// Nothing is derived: approval and completion are only what the caller sets,
// and init completion additionally needs `verifyInitCompletion` (supplied by
// the init receipt finalization) to accept the exact next descriptor, so the
// CLI alone can never record it.
export function updateInceptionState(root, { expectedSha256, changes, onCheckpoint, verifyInitCompletion } = {}) {
  checkpointOption(onCheckpoint);
  if (verifyInitCompletion !== undefined && typeof verifyInitCompletion !== 'function') {
    fail('INCEPTION_STATE_ARGUMENT', 'verifyInitCompletion must be a function');
  }
  if (!isSha256Hex(expectedSha256)) {
    fail('INCEPTION_STATE_ARGUMENT', 'expectedSha256 must be the lowercase SHA-256 digest of the current descriptor');
  }
  if (!isPlainObject(changes)) fail('INCEPTION_STATE_ARGUMENT', 'changes must be a JSON object');
  if (Object.keys(changes).some((key) => !MUTABLE_KEYS.includes(key))) {
    fail('INCEPTION_STATE_ARGUMENT', `changes may set only ${MUTABLE_KEYS.join(', ')}`);
  }
  const current = inspectInceptionState(root);
  if (!DESCRIPTOR_STATES.includes(current.state)) {
    fail('INCEPTION_STATE_INVALID', `no valid descriptor to update (${current.state}${current.reason ? `: ${current.reason}` : ''})`);
  }
  if (current.sha256 !== expectedSha256) {
    fail('INCEPTION_STATE_STALE', 'the current descriptor digest does not match the expected digest');
  }
  const next = validateInceptionState({ ...current.descriptor, ...changes });
  assertInceptionTransition(current.descriptor, next);
  verifyReferences(root, next);
  if (next.init.status === 'complete' && current.descriptor.init.status !== 'complete') {
    if (verifyInitCompletion === undefined) {
      fail('INCEPTION_STATE_TRANSITION', 'init completion is recorded only through a verified init receipt (inception-handoff finalize)');
    }
    verifyInitCompletion(next);
  }
  const written = writeInceptionFile(root, INCEPTION_STATE_PATH, serializeInceptionState(next), {
    expectedSha256,
    onCheckpoint,
  });
  return Object.freeze({ changed: written.changed, sha256: written.sha256, descriptor: next });
}

function usage(io, reason) {
  io.stderr.write(`inception-state: ${reason}\n${USAGE}\n`);
  return 2;
}

function emit(io, value) {
  io.stdout.write(`${JSON.stringify(value)}\n`);
}

export function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr, env: process.env }) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        root: { type: 'string' },
        state: { type: 'string' },
        'run-id': { type: 'string' },
        'expected-sha256': { type: 'string' },
        set: { type: 'string' },
      },
    });
  } catch {
    return usage(io, 'unrecognized or malformed arguments');
  }
  const { positionals, values } = parsed;
  const [command] = positionals;
  if (positionals.length !== 1 || !['start', 'inspect', 'update'].includes(command)) {
    return usage(io, 'expected exactly one command: start, inspect, or update');
  }
  if (typeof values.root !== 'string' || values.root.length === 0) return usage(io, '--root is required');
  if (values.state !== INCEPTION_STATE_PATH) return usage(io, `--state must be exactly ${INCEPTION_STATE_PATH}`);
  const accepted = { start: ['run-id'], inspect: [], update: ['expected-sha256', 'set'] }[command];
  for (const option of ['run-id', 'expected-sha256', 'set']) {
    if (values[option] !== undefined && !accepted.includes(option)) return usage(io, `--${option} is not accepted by ${command}`);
  }
  if (command === 'update' && (values['expected-sha256'] === undefined || values.set === undefined)) {
    return usage(io, 'update requires --expected-sha256 and --set');
  }

  try {
    if (command === 'start') {
      const result = startInceptionRun(values.root, { runId: values['run-id'], env: io.env });
      emit(io, result);
      if (result.git?.trackedCount > 0) {
        io.stderr.write(`inception-state: warning: ${result.git.trackedCount} file(s) under ${INCEPTION_AREA} are already tracked by Git; they were not removed\n`);
      }
      return 0;
    }
    if (command === 'inspect') {
      const result = inspectInceptionState(values.root);
      let git = null;
      if (result.state !== 'absent') {
        try {
          git = observeInceptionGit(values.root, { runId: result.descriptor?.runId, env: io.env });
        } catch {
          git = null;
        }
      }
      emit(io, { ...result, git });
      return result.state === 'absent' || DESCRIPTOR_STATES.includes(result.state) ? 0 : 1;
    }
    let changes;
    try {
      changes = JSON.parse(values.set);
    } catch {
      fail('INCEPTION_STATE_ARGUMENT', '--set must be a JSON object');
    }
    emit(io, updateInceptionState(values.root, { expectedSha256: values['expected-sha256'], changes }));
    return 0;
  } catch (error) {
    io.stderr.write(`inception-state: ${String(error?.message ?? error).slice(0, 1000)}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}

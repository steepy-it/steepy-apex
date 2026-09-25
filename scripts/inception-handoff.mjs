#!/usr/bin/env node
// The exact inception -> init transfer. It closes the machine-readable
// `inception-handoff: steepy-apex/v1` envelope (distinct from the chain's
// manual `handoff: steepy-apex/v1`, which it never parses), binds the human
// approval recorded by the inception skill to the exact bytes it approved,
// projects the authoritative confirmed-inputs record into Project model v1,
// compares the verified code checkpoint with the current code, and records
// and verifies the local init receipt.
//
// It is not a hub applicator or controller: it never writes stable
// documentation, never invents an approval from a digest, never runs the hub
// gate, and never decides whether a divergence is an admitted correction.
import { createHash } from 'node:crypto';
import { closeSync, constants as FS, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { normalizeProjectModel } from './project-scaffold.mjs';
import { LOCAL_AREA_NAMES, assertSafeRelPath } from './sanitize.mjs';
import { MAX_STABLE_FILE_BYTES, admitHubRoot, createStableReader } from './stable-paths.mjs';
import {
  INCEPTION_STATE_PATH,
  classifyInceptionPath,
  isCanonicalRunId,
  isSha256Hex,
  readInceptionFile,
  sha256Hex,
  writeInceptionFile,
} from './inception-paths.mjs';
import { inspectInceptionState, observeRepositoryRevision, updateInceptionState } from './inception-state.mjs';

export const INCEPTION_HANDOFF_VERSION = 'steepy-apex/v1';
export const INCEPTION_HANDOFF_ROLES = Object.freeze([
  'state', 'approval', 'project', 'verification', 'confirmed-inputs', 'promotion',
]);
export const CONFIRMED_INPUT_KEYS = Object.freeze([
  'projectName', 'description', 'devCommands', 'surfaces', 'domainVocabulary', 'gitPolicyDirective',
]);

const HANDOFF_KEYS = ['inception-handoff', 'next', 'run-id', 'required'];
const APPROVAL_KEYS = ['inception-approval', 'run-id', 'project'];
const CHECKPOINT_KEYS = ['inception-checkpoint', 'run-id', 'git', 'files'];
const PROMOTION_KEYS = ['inception-promotion', 'run-id', 'decisions'];
const REFERENCE_KEYS = ['path', 'sha256'];
const GIT_KEYS = ['branch', 'head'];
const SURFACE_KEYS = ['name', 'path', 'agent', 'testCmd'];
const VOCABULARY_KEYS = ['hasSpecializedVocabulary', 'entries'];
const ENTRY_KEYS = ['term', 'definition'];
const PROMOTE_KEYS = ['id', 'outcome', 'destination', 'content'];
const EXCLUDE_KEYS = ['id', 'outcome', 'reason'];
const RECEIPT_KEYS = ['inception-receipt', 'run-id', 'status', 'handoff', 'inputs', 'decisions', 'writes', 'gate'];
const INPUT_KEYS = ['role', 'path', 'sha256'];
const WRITE_KEYS = ['path', 'previous', 'observed'];
const RECEIPT_PROMOTE_KEYS = ['id', 'outcome', 'destination', 'sha256'];
const INPUT_ROLES = ['approval', 'project', 'verification', 'confirmed-inputs', 'promotion'];
const DECISION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const GIT_HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const GIT_POLICY = /^4\. \*\*Git policy:\*\* \S/u;
const CONTROL = /[\x00-\x1F\x7F]/u;
const TEXT_CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u;
const MAX_PATH_LENGTH = 1024;
const DESCRIPTOR_STATES = ['pre-hub', 'init-in-progress', 'init-complete'];
const NOFOLLOW = FS.O_NOFOLLOW ?? 0;
const NONBLOCK = FS.O_NONBLOCK ?? 0;

export const MAX_CHECKPOINT_FILE_BYTES = 64 * 1024 * 1024;

function fail(code, message) {
  const error = new Error(`inception handoff: ${message}`);
  error.code = code;
  throw error;
}

function invalid(message) {
  return fail('INCEPTION_HANDOFF_INVALID', message);
}

function binding(message) {
  return fail('INCEPTION_HANDOFF_BINDING', message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// Unknown names and values are never echoed: they may carry credentials.
function assertExactKeys(value, keys, label) {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    invalid(`${label} has an unsupported field; allowed fields are ${keys.join(', ')}`);
  }
  if (keys.some((key) => !Object.hasOwn(value, key))) {
    invalid(`${label} fields are incomplete; expected ${keys.join(', ')}`);
  }
}

function assertObject(value, keys, label) {
  if (!isPlainObject(value)) invalid(`${label} must be a JSON object`);
  assertExactKeys(value, keys, label);
}

function assertList(value, label, { nonEmpty = true } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    invalid(`${label} must be a ${nonEmpty ? 'non-empty ' : ''}list`);
  }
}

function assertVersion(value, key, label) {
  if (value[key] !== INCEPTION_HANDOFF_VERSION) {
    invalid(`${label} version must be ${key}: ${INCEPTION_HANDOFF_VERSION}; other versions are unsupported`);
  }
}

function assertRun(value, runId, label) {
  if (value['run-id'] !== runId) invalid(`${label} run-id must be the handoff run ${runId}`);
}

function requireRunId(options) {
  const runId = options?.runId;
  if (!isCanonicalRunId(runId)) fail('INCEPTION_HANDOFF_ARGUMENT', 'runId must be a canonical lowercase UUID');
  return runId;
}

function isValidUtf8(value) {
  return Buffer.from(value, 'utf8').toString('utf8') === value;
}

function isSingleLine(value) {
  return typeof value === 'string' && value.trim() !== '' && !CONTROL.test(value) && isValidUtf8(value);
}

function isText(value) {
  return typeof value === 'string' && value.trim() !== '' && !TEXT_CONTROL.test(value) && isValidUtf8(value);
}

// A syntactically valid JSON text is scanned once more for object keys; the
// unescaped key decides duplication, so `"a"` and `"\u0061"` collide.
function assertNoDuplicateKeys(text, label) {
  const frames = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      let end = index + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const frame = frames.at(-1);
      if (frame?.keys && frame.expectKey) {
        const key = JSON.parse(text.slice(index, end + 1));
        if (frame.keys.has(key)) invalid(`${label} has a duplicate key`);
        frame.keys.add(key);
        frame.expectKey = false;
      }
      index = end;
    } else if (character === '{') {
      frames.push({ keys: new Set(), expectKey: true });
    } else if (character === '[') {
      frames.push({ keys: null, expectKey: false });
    } else if (character === '}' || character === ']') {
      frames.pop();
    } else if (character === ',' && frames.at(-1)?.keys) {
      frames.at(-1).expectKey = true;
    }
  }
}

// Strict JSON for model-authored transfer inputs: fatal UTF-8, no byte order
// mark, and no duplicate keys, so no two readers can disagree on a value.
export function parseStrictJson(input, label = 'input') {
  let text = input;
  if (input instanceof Uint8Array) {
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
    } catch {
      invalid(`${label} is not valid UTF-8`);
    }
  }
  if (typeof text !== 'string') invalid(`${label} must be JSON text`);
  if (text.startsWith('\uFEFF')) invalid(`${label} must not start with a byte order mark`);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    invalid(`${label} is not valid JSON`);
  }
  assertNoDuplicateKeys(text, label);
  return value;
}

function runFile(value, runId, label) {
  let classified = null;
  try {
    classified = typeof value === 'string' ? classifyInceptionPath(value, { runId }) : null;
  } catch {
    // Reported below without echoing the rejected value.
  }
  if (classified?.kind !== 'run-file') invalid(`${label} must be an exact file of run ${runId}`);
  return value;
}

function assertUniquePaths(paths, label) {
  const seen = new Set();
  for (const path of paths) {
    const folded = path.toLowerCase();
    if (seen.has(folded)) invalid(`${label}: '${path}' is named more than once`);
    seen.add(folded);
  }
}

function sha256Field(value, label) {
  if (!isSha256Hex(value)) invalid(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

// Shared by code checkpoint paths and promotion destinations: repository
// content only, never Git internals or a repository-local `.apex/<area>`
// (case-folded, so an alias on a case-insensitive filesystem is refused too).
function assertRepositorySegments(value, label) {
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    invalid(`${label} must not contain empty, '.', or '..' path segments`);
  }
  if (segments[0].toLowerCase() === '.git') invalid(`${label} names .git internals, not repository content`);
  if (segments[0].toLowerCase() === '.apex' && segments.length > 1
    && LOCAL_AREA_NAMES.includes(segments[1].toLowerCase())) {
    invalid(`${label} is inside a local area; local areas are never checkpoint or stable content`);
  }
}

function codePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) {
    invalid(`${label} must be a non-empty repository-relative path`);
  }
  if (CONTROL.test(value) || !isValidUtf8(value)) invalid(`${label} must be valid single-line UTF-8`);
  if (value.includes('\\')) invalid(`${label} must use '/' separators`);
  if (value.startsWith('/')) invalid(`${label} must be repository-relative`);
  if (/[*?]/u.test(value)) invalid(`${label} must be exact, not a glob`);
  assertRepositorySegments(value, label);
  return value;
}

function stablePath(value, label) {
  try {
    assertSafeRelPath(value, label);
  } catch {
    invalid(`${label} must be a safe repository-relative path (letters, digits, '.', '@', '_', '-', '/')`);
  }
  assertRepositorySegments(value, label);
  return value;
}

export function validateInceptionHandoff(value) {
  assertObject(value, HANDOFF_KEYS, 'handoff');
  assertVersion(value, 'inception-handoff', 'handoff');
  if (value.next !== 'init') invalid('handoff next must be init');
  const runId = value['run-id'];
  if (!isCanonicalRunId(runId)) invalid('handoff run-id must be a canonical lowercase UUID');
  if (!isPlainObject(value.required)) invalid('handoff required must be a role map');
  assertExactKeys(value.required, INCEPTION_HANDOFF_ROLES, 'handoff required');
  const { required } = value;
  if (required.state !== INCEPTION_STATE_PATH) invalid(`required state must be exactly ${INCEPTION_STATE_PATH}`);
  const single = (role) => runFile(required[role], runId, `required ${role}`);
  const list = (role) => required[role].map((path, index) => runFile(path, runId, `required ${role}[${index}]`));
  const approval = single('approval');
  assertList(required.project, 'required project');
  const project = list('project');
  if (!Array.isArray(required.verification) || required.verification.length < 2) {
    invalid('required verification must list the code checkpoint and at least one verification-results document');
  }
  const verification = list('verification');
  const confirmedInputs = single('confirmed-inputs');
  const promotion = single('promotion');
  assertUniquePaths([approval, ...project, ...verification, confirmedInputs, promotion], 'handoff required');
  return deepFreeze({
    runId,
    required: {
      state: INCEPTION_STATE_PATH,
      approval,
      project,
      verification,
      'confirmed-inputs': confirmedInputs,
      promotion,
    },
  });
}

export function validateApprovalRecord(value, options) {
  const runId = requireRunId(options);
  assertObject(value, APPROVAL_KEYS, 'approval');
  assertVersion(value, 'inception-approval', 'approval');
  assertRun(value, runId, 'approval');
  assertList(value.project, 'approval project');
  const project = value.project.map((reference, index) => {
    const label = `approval project[${index}]`;
    assertObject(reference, REFERENCE_KEYS, label);
    return {
      path: runFile(reference.path, runId, `${label}.path`),
      sha256: sha256Field(reference.sha256, `${label}.sha256`),
    };
  });
  assertUniquePaths(project.map(({ path }) => path), 'approval project');
  return deepFreeze({ runId, project });
}

export function validateCodeCheckpoint(value, options) {
  const runId = requireRunId(options);
  assertObject(value, CHECKPOINT_KEYS, 'checkpoint');
  assertVersion(value, 'inception-checkpoint', 'checkpoint');
  assertRun(value, runId, 'checkpoint');
  let git = null;
  if (value.git !== null) {
    assertObject(value.git, GIT_KEYS, 'checkpoint git');
    const { branch, head } = value.git;
    if (branch !== null && !(isSingleLine(branch) && branch.length <= 255)) {
      invalid('checkpoint git branch must be null or a non-empty single line');
    }
    if (head !== null && !(typeof head === 'string' && GIT_HEAD.test(head))) {
      invalid('checkpoint git head must be null or a full lowercase commit id');
    }
    git = { branch, head };
  }
  assertList(value.files, 'checkpoint files');
  const files = value.files.map((entry, index) => {
    const label = `checkpoint files[${index}]`;
    assertObject(entry, REFERENCE_KEYS, label);
    return {
      path: codePath(entry.path, `${label}.path`),
      sha256: entry.sha256 === null ? null : sha256Field(entry.sha256, `${label}.sha256`),
    };
  });
  for (let index = 1; index < files.length; index += 1) {
    if (!(files[index - 1].path < files[index].path)) invalid('checkpoint files must be sorted by path without duplicates');
  }
  return deepFreeze({ runId, git, files });
}

function projectionOf(record, resolutions) {
  if (!isPlainObject(resolutions)) invalid('resolutions must be a map of conflict id to choice');
  assertList(record.surfaces, 'confirmed inputs surfaces', { nonEmpty: false });
  const surfaces = record.surfaces.map((surface, index) => {
    assertObject(surface, SURFACE_KEYS, `confirmed inputs surfaces[${index}]`);
    return { name: surface.name, path: surface.path, agent: surface.agent, testCmd: surface.testCmd };
  });
  const projection = {
    projectName: record.projectName,
    description: record.description,
    devCommands: Array.isArray(record.devCommands) ? [...record.devCommands] : record.devCommands,
    surfaces,
    resolutions: { ...resolutions },
  };
  try {
    normalizeProjectModel(projection);
  } catch (error) {
    invalid(`confirmed inputs are not a valid Project model v1 projection: ${error.message}`);
  }
  return deepFreeze(projection);
}

function validateVocabulary(value) {
  assertObject(value, VOCABULARY_KEYS, 'confirmed inputs domainVocabulary');
  if (typeof value.hasSpecializedVocabulary !== 'boolean') {
    invalid('confirmed inputs domainVocabulary.hasSpecializedVocabulary must be a boolean');
  }
  assertList(value.entries, 'confirmed inputs domainVocabulary.entries', { nonEmpty: false });
  value.entries.forEach((entry, index) => {
    const label = `confirmed inputs domainVocabulary.entries[${index}]`;
    assertObject(entry, ENTRY_KEYS, label);
    if (!isText(entry.term)) invalid(`${label}.term must be non-empty text`);
    if (!isText(entry.definition)) invalid(`${label}.definition must be non-empty text`);
  });
  if (value.hasSpecializedVocabulary && value.entries.length === 0) {
    invalid('confirmed inputs domainVocabulary.entries must be non-empty when hasSpecializedVocabulary is true');
  }
  if (!value.hasSpecializedVocabulary && value.entries.length > 0) {
    invalid('confirmed inputs domainVocabulary.entries must be empty when hasSpecializedVocabulary is false');
  }
}

// The six-field authoritative record defined by the init skill. Its five
// Project fields are verified by the public planner normalizer; nothing here
// consults the stack detector.
export function validateConfirmedInputs(value) {
  assertObject(value, CONFIRMED_INPUT_KEYS, 'confirmed inputs');
  validateVocabulary(value.domainVocabulary);
  const policy = value.gitPolicyDirective;
  if (typeof policy !== 'string' || (policy !== '' && !(isText(policy) && GIT_POLICY.test(policy)))) {
    invalid('confirmed inputs gitPolicyDirective must be empty or text starting with "4. **Git policy:** "');
  }
  projectionOf(value, {});
  return deepFreeze(structuredClone(value));
}

// The exact five-key planner projection. Conflict resolutions are supplied
// separately and never written back into the authoritative record.
export function projectConfirmedInputs(record, { resolutions = {} } = {}) {
  validateConfirmedInputs(record);
  return projectionOf(record, resolutions);
}

function decisionId(id, seen, label) {
  if (typeof id !== 'string' || !DECISION_ID.test(id)) invalid(`${label}.id must match ${DECISION_ID.source}`);
  if (seen.has(id)) invalid(`decision '${id}' is named more than once`);
  seen.add(id);
  return id;
}

export function validatePromotionTable(value, options) {
  const runId = requireRunId(options);
  assertObject(value, PROMOTION_KEYS, 'promotion');
  assertVersion(value, 'inception-promotion', 'promotion');
  assertRun(value, runId, 'promotion');
  assertList(value.decisions, 'promotion decisions');
  const ids = new Set();
  const decisions = value.decisions.map((decision, index) => {
    const label = `promotion decisions[${index}]`;
    if (!isPlainObject(decision)) invalid(`${label} must be a JSON object`);
    if (decision.outcome !== 'promote' && decision.outcome !== 'exclude') {
      invalid(`${label}.outcome must be promote or exclude`);
    }
    assertExactKeys(decision, decision.outcome === 'promote' ? PROMOTE_KEYS : EXCLUDE_KEYS, label);
    decisionId(decision.id, ids, label);
    if (decision.outcome === 'exclude') {
      if (!isText(decision.reason)) invalid(`${label}.reason must be non-empty text`);
      return { id: decision.id, outcome: 'exclude', reason: decision.reason };
    }
    if (!isText(decision.content)) invalid(`${label}.content must be non-empty text without control characters`);
    return {
      id: decision.id,
      outcome: 'promote',
      destination: stablePath(decision.destination, `${label}.destination`),
      content: decision.content,
    };
  });
  return deepFreeze({ runId, decisions });
}

function recordRunId(value, label) {
  const runId = isPlainObject(value) ? value['run-id'] : undefined;
  if (!isCanonicalRunId(runId)) invalid(`${label} run-id must be a canonical lowercase UUID`);
  return runId;
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function serializeCodeCheckpoint(record) {
  const { runId, git, files } = validateCodeCheckpoint(record, { runId: recordRunId(record, 'checkpoint') });
  return serialize({ 'inception-checkpoint': INCEPTION_HANDOFF_VERSION, 'run-id': runId, git, files });
}

// Repository bytes are admitted by the shared stable reader: an admitted
// physical root, no symlinked component, no local area, one link, an
// ordinary file. The descriptor is then bound to that identity for the read.
function bindRepository(root) {
  if (typeof root !== 'string' || root.length === 0) {
    fail('INCEPTION_HANDOFF_ARGUMENT', 'root must be a non-empty repository path');
  }
  const admission = admitHubRoot(root);
  if (admission.state !== 'present') {
    fail('INCEPTION_HANDOFF_UNSAFE', `repository root ${admission.state === 'missing' ? 'is missing' : admission.reason}`);
  }
  const diagnostics = [];
  return { diagnostics, reader: createStableReader(root, diagnostics, admission) };
}

function readRepositoryFile(repository, path, { maxBytes, collect = false }) {
  repository.diagnostics.length = 0;
  const admitted = repository.reader.inspect(path, { kind: 'file' });
  if (admitted.state === 'missing') return null;
  if (admitted.state !== 'present') {
    const detail = repository.diagnostics.map(({ msg }) => msg.replace(/^stable-read: /u, '')).join('; ');
    fail('INCEPTION_HANDOFF_UNSAFE', `'${path}' cannot be read safely: ${detail || `is ${admitted.state}`}`);
  }
  if (admitted.stat.size > BigInt(maxBytes)) fail('INCEPTION_HANDOFF_UNSAFE', `'${path}' exceeds ${maxBytes} bytes`);
  let fd;
  try {
    fd = openSync(admitted.physicalPath, FS.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (error) {
    fail('INCEPTION_HANDOFF_UNSAFE', `'${path}' could not be opened safely (${error.code ?? 'error'})`);
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== admitted.stat.dev || opened.ino !== admitted.stat.ino) {
      fail('INCEPTION_HANDOFF_UNSAFE', `'${path}' changed physical identity during open`);
    }
    const hash = createHash('sha256');
    const chunks = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) fail('INCEPTION_HANDOFF_UNSAFE', `'${path}' grew beyond ${maxBytes} bytes`);
      hash.update(buffer.subarray(0, count));
      if (collect) chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    const after = fstatSync(fd, { bigint: true });
    if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || BigInt(total) !== after.size) {
      fail('INCEPTION_HANDOFF_UNSAFE', `'${path}' changed during the read`);
    }
    return { sha256: hash.digest('hex'), bytes: collect ? Buffer.concat(chunks, total) : null };
  } finally {
    closeSync(fd);
  }
}

// Observes an explicit inventory of relevant repository paths (manifests,
// lockfiles, command files, representative code): exact-byte digests, null
// for a relevant path that is absent, plus branch/HEAD when Git exists. It
// never enumerates the repository, so the caller names every relevant path.
export function observeCodeCheckpoint(root, { runId, paths, env } = {}) {
  const id = requireRunId({ runId });
  if (!Array.isArray(paths) || paths.length === 0) {
    fail('INCEPTION_HANDOFF_ARGUMENT', 'paths must be a non-empty list of repository paths');
  }
  const inventory = [...new Set(paths.map((path, index) => codePath(path, `paths[${index}]`)))].sort();
  const repository = bindRepository(root);
  const files = inventory.map((path) => ({
    path,
    sha256: readRepositoryFile(repository, path, { maxBytes: MAX_CHECKPOINT_FILE_BYTES })?.sha256 ?? null,
  }));
  const revision = observeRepositoryRevision(root, { env });
  const record = {
    'inception-checkpoint': INCEPTION_HANDOFF_VERSION,
    'run-id': id,
    git: revision === null ? null : { branch: revision.branch, head: revision.head },
    files,
  };
  validateCodeCheckpoint(record, { runId: id });
  return deepFreeze(record);
}

function sameRevision(left, right) {
  if (left === null || right === null) return left === right;
  return left.branch === right.branch && left.head === right.head;
}

// Pure comparison of the recorded checkpoint with a current observation of
// at least the recorded paths. It reports divergence; deciding whether it is
// an admitted correction, needs new evidence, or a human decision is not its job.
export function compareCodeCheckpoints(recorded, observed) {
  const runId = recordRunId(recorded, 'recorded checkpoint');
  const before = validateCodeCheckpoint(recorded, { runId });
  const after = validateCodeCheckpoint(observed, { runId });
  const was = new Map(before.files.map(({ path, sha256 }) => [path, sha256]));
  const now = new Map(after.files.map(({ path, sha256 }) => [path, sha256]));
  if ([...was.keys()].some((path) => !now.has(path))) {
    fail('INCEPTION_HANDOFF_ARGUMENT', 'the observation must cover every recorded path');
  }
  const changed = [];
  const added = [];
  const removed = [];
  for (const [path, digest] of now) {
    const previous = was.get(path) ?? null;
    if (digest !== null && previous === null) added.push(path);
    else if (digest === null && previous !== null) removed.push(path);
    else if (digest !== previous) changed.push(path);
  }
  const gitChanged = !sameRevision(before.git, after.git);
  return deepFreeze({
    diverged: gitChanged || changed.length + added.length + removed.length > 0,
    changed,
    added,
    removed,
    git: { changed: gitChanged, recorded: before.git, observed: after.git },
  });
}

function sameReference(left, right) {
  return left?.path === right?.path && left?.sha256 === right?.sha256;
}

function handoffRun(path) {
  const runId = typeof path === 'string' ? path.split('/')[2] : undefined;
  if (!isCanonicalRunId(runId)) invalid('the handoff must be an exact file of an inception run');
  runFile(path, runId, 'the handoff');
  return runId;
}

function readInput(root, path, runId) {
  return readInceptionFile(root, path, { runId });
}

// A role the descriptor also records is admitted only when both name the same
// path and the bytes still hash to the recorded digest.
function boundInput(root, runId, reference, path, role, field) {
  if (reference === null) binding(`the inception state records no ${field} reference for the ${role} input`);
  if (reference.path !== path) binding(`required ${role} is not the ${field} recorded in the inception state`);
  const bytes = readInput(root, path, runId);
  if (sha256Hex(bytes) !== reference.sha256) {
    binding(`${role} refers to other bytes than the inception state recorded; it needs a new ${field}`);
  }
  return bytes;
}

function inspectRun(root, runId, label) {
  const inspected = inspectInceptionState(root);
  if (!DESCRIPTOR_STATES.includes(inspected.state)) {
    binding(`the inception state is ${inspected.state}${inspected.reason ? ` (${inspected.reason})` : ''}`);
  }
  if (inspected.descriptor.runId !== runId) binding(`${label} belongs to a different run than the inception state`);
  return inspected;
}

function verifyTransfer(root, { handoff, paths = [], env } = {}) {
  if (typeof root !== 'string' || root.length === 0) fail('INCEPTION_HANDOFF_ARGUMENT', 'root must be a non-empty repository path');
  if (!Array.isArray(paths)) fail('INCEPTION_HANDOFF_ARGUMENT', 'paths must be a list of repository paths');
  const runId = handoffRun(handoff);
  const inspected = inspectRun(root, runId, 'the handoff');
  const { descriptor } = inspected;
  const handoffBytes = readInput(root, handoff, runId);
  const envelope = validateInceptionHandoff(parseStrictJson(handoffBytes, 'handoff'));
  if (envelope.runId !== runId) binding('the handoff run-id must be the run that holds the handoff');
  const { required } = envelope;
  assertUniquePaths([handoff, required.approval, ...required.project, ...required.verification,
    required['confirmed-inputs'], required.promotion], 'handoff and its inputs');
  if (!['init', 'complete'].includes(descriptor.phase)) {
    binding(`the inception phase is ${descriptor.phase}; the init transfer requires phase init`);
  }
  const handoffReference = { path: handoff, sha256: sha256Hex(handoffBytes) };
  if (descriptor.init.handoff !== null && !sameReference(descriptor.init.handoff, handoffReference)) {
    binding('the inception state pins a different init handoff');
  }

  const approvalBytes = boundInput(root, runId, descriptor.approval, required.approval, 'approval', 'approval');
  const approval = validateApprovalRecord(parseStrictJson(approvalBytes, 'approval'), { runId });
  const approved = new Map(approval.project.map(({ path, sha256 }) => [path, sha256]));
  if (approved.size !== required.project.length || required.project.some((path) => !approved.has(path))) {
    binding('required project must name exactly the approved project documents');
  }
  const project = required.project.map((path) => {
    const digest = sha256Hex(readInput(root, path, runId));
    if (digest !== approved.get(path)) {
      binding(`project document '${path}' differs from its approved bytes; a substantial change needs a new approval`);
    }
    return { role: 'project', path, sha256: digest };
  });

  if (descriptor.checkpoint === null) binding('the inception state records no checkpoint reference for the verification input');
  if (!required.verification.includes(descriptor.checkpoint.path)) {
    binding('required verification must include the checkpoint recorded in the inception state');
  }
  // The checkpoint is bound to the descriptor and parsed; every other
  // verification entry is an opaque results document judged by the skill.
  const verification = required.verification.map((path) => ({
    role: 'verification',
    path,
    bytes: path === descriptor.checkpoint.path
      ? boundInput(root, runId, descriptor.checkpoint, path, 'verification', 'checkpoint')
      : readInput(root, path, runId),
  }));
  const checkpointBytes = verification.find(({ path }) => path === descriptor.checkpoint.path).bytes;
  const recorded = parseStrictJson(checkpointBytes, 'verification checkpoint');
  validateCodeCheckpoint(recorded, { runId });
  if (serializeCodeCheckpoint(recorded) !== checkpointBytes.toString('utf8')) {
    invalid('verification checkpoint bytes are not canonical');
  }
  const confirmedBytes = readInput(root, required['confirmed-inputs'], runId);
  const confirmedInputs = validateConfirmedInputs(parseStrictJson(confirmedBytes, 'confirmed inputs'));
  const promotionBytes = readInput(root, required.promotion, runId);
  const promotion = validatePromotionTable(parseStrictJson(promotionBytes, 'promotion'), { runId });
  const inventory = new Set(recorded.files.map(({ path }) => path.toLowerCase()));
  for (const decision of promotion.decisions) {
    if (decision.outcome === 'promote' && inventory.has(decision.destination.toLowerCase())) {
      binding(`promotion decision '${decision.id}' writes '${decision.destination}', a checkpoint inventory path; init's own write would diverge the checkpoint`);
    }
  }

  const inputs = [
    { role: 'approval', path: required.approval, sha256: sha256Hex(approvalBytes) },
    ...project,
    ...verification.map(({ role, path, bytes }) => ({ role, path, sha256: sha256Hex(bytes) })),
    { role: 'confirmed-inputs', path: required['confirmed-inputs'], sha256: sha256Hex(confirmedBytes) },
    { role: 'promotion', path: required.promotion, sha256: sha256Hex(promotionBytes) },
  ];
  const observed = observeCodeCheckpoint(root, {
    runId,
    paths: [...recorded.files.map(({ path }) => path), ...paths],
    env,
  });
  const checkpoint = compareCodeCheckpoints(recorded, observed);
  const report = deepFreeze({
    status: checkpoint.diverged ? 'diverged' : 'verified',
    runId,
    handoff: handoffReference,
    state: { sha256: inspected.sha256, phase: descriptor.phase, status: descriptor.status, init: descriptor.init.status },
    inputs,
    checkpoint,
    confirmedInputs,
    promotion,
  });
  return { report, descriptor };
}

// Verifies the exact inception -> init transfer and reads only the handoff,
// the descriptor with its guard, the inputs the handoff names, and the
// checkpoint's repository paths (plus any explicitly named current paths).
// Code divergence is reported in the result; every other mismatch throws.
export function verifyInceptionHandoff(root, options = {}) {
  return verifyTransfer(root, options).report;
}

// The local init receipt: the accepted input digests, one outcome per
// decision (a promoted destination with the digest of its stable text, or a
// motivated exclusion), the write checkpoint of every destination (bytes
// before init and, on completion, as observed), and the hub gate outcome
// reported by the init skill. A complete receipt has no pending decision.
export function validateInitReceipt(value, options) {
  const runId = requireRunId(options);
  assertObject(value, RECEIPT_KEYS, 'receipt');
  assertVersion(value, 'inception-receipt', 'receipt');
  assertRun(value, runId, 'receipt');
  if (value.status !== 'in-progress' && value.status !== 'complete') invalid('receipt status must be in-progress or complete');
  const complete = value.status === 'complete';
  assertObject(value.handoff, REFERENCE_KEYS, 'receipt handoff');
  const handoff = {
    path: runFile(value.handoff.path, runId, 'receipt handoff.path'),
    sha256: sha256Field(value.handoff.sha256, 'receipt handoff.sha256'),
  };
  assertList(value.inputs, 'receipt inputs');
  const inputs = value.inputs.map((entry, index) => {
    const label = `receipt inputs[${index}]`;
    assertObject(entry, INPUT_KEYS, label);
    if (!INPUT_ROLES.includes(entry.role)) invalid(`${label}.role must be one of ${INPUT_ROLES.join(', ')}`);
    return {
      role: entry.role,
      path: runFile(entry.path, runId, `${label}.path`),
      sha256: sha256Field(entry.sha256, `${label}.sha256`),
    };
  });
  const roles = inputs.map(({ role }) => role);
  const projects = roles.filter((role) => role === 'project');
  const verifications = roles.filter((role) => role === 'verification');
  if (projects.length === 0 || verifications.length < 2
    || roles.join('\0') !== ['approval', ...projects, ...verifications, 'confirmed-inputs', 'promotion'].join('\0')) {
    invalid('receipt inputs must list approval, every project document, every verification entry (checkpoint and results), confirmed-inputs, and promotion in that order');
  }
  assertUniquePaths([handoff.path, ...inputs.map(({ path }) => path)], 'receipt handoff and inputs');

  assertList(value.decisions, 'receipt decisions');
  const ids = new Set();
  const decisions = value.decisions.map((decision, index) => {
    const label = `receipt decisions[${index}]`;
    if (!isPlainObject(decision)) invalid(`${label} must be a JSON object`);
    const { outcome } = decision;
    if (!['pending', 'promoted', 'excluded'].includes(outcome)) invalid(`${label}.outcome must be pending, promoted, or excluded`);
    if (complete && outcome === 'pending') invalid(`${label} is pending; a complete receipt cannot carry an unresolved decision`);
    if (!complete && outcome === 'promoted') invalid(`${label} is promoted; an in-progress receipt records promotion only on completion`);
    assertExactKeys(decision, outcome === 'excluded' ? EXCLUDE_KEYS : RECEIPT_PROMOTE_KEYS, label);
    const id = decisionId(decision.id, ids, label);
    if (outcome === 'excluded') {
      if (!isText(decision.reason)) invalid(`${label}.reason must be non-empty text`);
      return { id, outcome, reason: decision.reason };
    }
    return {
      id,
      outcome,
      destination: stablePath(decision.destination, `${label}.destination`),
      sha256: sha256Field(decision.sha256, `${label}.sha256`),
    };
  });

  assertList(value.writes, 'receipt writes', { nonEmpty: false });
  const writes = value.writes.map((entry, index) => {
    const label = `receipt writes[${index}]`;
    assertObject(entry, WRITE_KEYS, label);
    const path = stablePath(entry.path, `${label}.path`);
    const previous = entry.previous === null ? null : sha256Field(entry.previous, `${label}.previous`);
    const observed = entry.observed === null ? null : sha256Field(entry.observed, `${label}.observed`);
    if (complete && observed === null) invalid(`${label}.observed must record the destination digest of a complete receipt`);
    if (!complete && observed !== null) invalid(`${label}.observed is recorded only on completion`);
    return { path, previous, observed };
  });
  const destinations = [...new Set(decisions.filter(({ outcome }) => outcome !== 'excluded')
    .map(({ destination }) => destination))].sort();
  if (writes.map(({ path }) => path).join('\0') !== destinations.join('\0')) {
    invalid('receipt writes must list every promoted destination once, sorted by path');
  }
  if (value.gate !== (complete ? 'pass' : 'not-run')) {
    invalid(`receipt gate must be ${complete ? 'pass in a complete receipt' : 'not-run until completion'}`);
  }
  return deepFreeze({ runId, status: value.status, handoff, inputs, decisions, writes, gate: value.gate });
}

export function serializeInitReceipt(value) {
  const receipt = validateInitReceipt(value, { runId: recordRunId(value, 'receipt') });
  return serialize({
    'inception-receipt': INCEPTION_HANDOFF_VERSION,
    'run-id': receipt.runId,
    status: receipt.status,
    handoff: receipt.handoff,
    inputs: receipt.inputs,
    decisions: receipt.decisions,
    writes: receipt.writes,
    gate: receipt.gate,
  });
}

function readReceipt(root, path, runId) {
  let bytes;
  try {
    bytes = readInput(root, path, runId);
  } catch (error) {
    if (error.code === 'INCEPTION_MISSING') return null;
    throw error;
  }
  const value = parseStrictJson(bytes, 'receipt');
  const receipt = validateInitReceipt(value, { runId });
  const text = bytes.toString('utf8');
  if (serializeInitReceipt(value) !== text) invalid('receipt bytes are not canonical');
  return { receipt, text, sha256: sha256Hex(bytes) };
}

function receiptTarget(path, report) {
  runFile(path, report.runId, 'receipt');
  assertUniquePaths([report.handoff.path, ...report.inputs.map((input) => input.path), path], 'receipt and transfer inputs');
  return path;
}

// A started init owns exactly the receipt its descriptor binds: resume finds
// it there, and any other receipt path is refused so no second receipt can
// re-baseline previous bytes. Only a not-started init takes a new path.
function resolveReceipt(requested, descriptor, report) {
  const bound = descriptor.init.receipt;
  if (descriptor.init.status !== 'not-started') {
    if (bound === null) {
      fail('INCEPTION_HANDOFF_RECEIPT', `init is ${descriptor.init.status} without a bound receipt; it cannot be resumed without re-baselining`);
    }
    if (requested !== undefined && requested !== bound.path) {
      fail('INCEPTION_HANDOFF_RECEIPT', `init is bound to receipt '${bound.path}'; any other receipt path is refused`);
    }
    return receiptTarget(bound.path, report);
  }
  if (requested === undefined) fail('INCEPTION_HANDOFF_ARGUMENT', 'a receipt path is required to start init');
  return receiptTarget(requested, report);
}

function readBoundReceipt(root, target, report, descriptor) {
  const existing = readReceipt(root, target, report.runId);
  if (existing === null) fail('INCEPTION_HANDOFF_RECEIPT', 'the bound receipt is missing; it is never re-baselined');
  if (descriptor.init.status === 'complete' && existing.receipt.status !== 'complete') {
    fail('INCEPTION_HANDOFF_RECEIPT', 'init is complete but the receipt is not complete; it is never rewritten');
  }
  if (existing.receipt.status === 'in-progress' && existing.sha256 !== descriptor.init.receipt.sha256) {
    fail('INCEPTION_HANDOFF_RECEIPT', 'the bound receipt bytes changed since init started; it is never re-baselined');
  }
  return existing;
}

function promotedContents(report, destination) {
  return report.promotion.decisions
    .filter((decision) => decision.outcome === 'promote' && decision.destination === destination)
    .map(({ content }) => Buffer.from(content, 'utf8'));
}

function receiptFor(report, status, writes) {
  return {
    'inception-receipt': INCEPTION_HANDOFF_VERSION,
    'run-id': report.runId,
    status,
    handoff: report.handoff,
    inputs: report.inputs,
    decisions: report.promotion.decisions.map((decision) => (decision.outcome === 'exclude'
      ? { id: decision.id, outcome: 'excluded', reason: decision.reason }
      : {
        id: decision.id,
        outcome: status === 'complete' ? 'promoted' : 'pending',
        destination: decision.destination,
        sha256: sha256Hex(Buffer.from(decision.content, 'utf8')),
      })),
    writes,
    gate: status === 'complete' ? 'pass' : 'not-run',
  };
}

// An existing receipt is reused only for the same handoff, the same accepted
// input bytes, and the same decisions; anything else is another transfer.
function assertReceiptBinding(receipt, report) {
  const expected = validateInitReceipt(receiptFor(report, receipt.status, receipt.writes), { runId: report.runId });
  if (JSON.stringify([receipt.handoff, receipt.inputs, receipt.decisions])
    !== JSON.stringify([expected.handoff, expected.inputs, expected.decisions])) {
    fail('INCEPTION_HANDOFF_RECEIPT', 'the receipt belongs to other transfer inputs; the current handoff needs its own receipt');
  }
}

// Compares prepared (previous), expected (every promoted text present), and
// observed destination bytes. The init skill decides what a change means.
function observeDestinations(root, report, writes) {
  if (writes.length === 0) return [];
  const repository = bindRepository(root);
  return writes.map(({ path, previous }) => {
    const current = readRepositoryFile(repository, path, { maxBytes: MAX_STABLE_FILE_BYTES, collect: true });
    const observed = current?.sha256 ?? null;
    const realized = current !== null
      && promotedContents(report, path).every((content) => current.bytes.includes(content));
    const state = realized ? 'realized' : observed === previous ? 'pending' : 'changed';
    return { path, previous, observed, state, bytes: current?.bytes ?? null };
  });
}

function publicDestinations(destinations) {
  return destinations.map(({ path, previous, observed, state }) => ({ path, previous, observed, state }));
}

// Before the first hub write: writes a create-only receipt holding each
// destination's previous bytes (a local write), then records init in-progress
// binding this exact handoff and that receipt. A resume uses the bound
// receipt, keeps its previous bytes, and reports each destination; after a
// crash between the two writes it binds the same receipt instead of a new one.
export function prepareInitReceipt(root, { handoff, receipt, paths = [], env } = {}) {
  const { report, descriptor } = verifyTransfer(root, { handoff, paths, env });
  if (report.checkpoint.diverged) {
    fail('INCEPTION_HANDOFF_DIVERGED', 'the current code diverges from the verified checkpoint; reconcile it before promotion');
  }
  if (descriptor.init.status === 'complete') fail('INCEPTION_HANDOFF_RECEIPT', 'init is already complete; finalize verifies it');
  const target = resolveReceipt(receipt, descriptor, report);
  const started = descriptor.init.status === 'in-progress';
  const existing = started ? readBoundReceipt(root, target, report, descriptor) : readReceipt(root, target, report.runId);
  if (existing?.receipt.status === 'complete') {
    fail('INCEPTION_HANDOFF_RECEIPT', 'the receipt is already complete; finalize records init completion');
  }
  if (existing !== null) assertReceiptBinding(existing.receipt, report);

  let reference = existing === null ? null : { path: target, sha256: existing.sha256 };
  let writes = existing?.receipt.writes;
  if (existing === null) {
    const destinations = [...new Set(report.promotion.decisions
      .filter(({ outcome }) => outcome === 'promote').map(({ destination }) => destination))].sort();
    writes = observeDestinations(root, report, destinations.map((path) => ({ path, previous: null })))
      .map(({ path, observed }) => ({ path, previous: observed, observed: null }));
    const written = writeInceptionFile(root, target, serializeInitReceipt(receiptFor(report, 'in-progress', writes)), {
      expectedSha256: null,
      runId: report.runId,
    });
    reference = { path: target, sha256: written.sha256 };
  }
  if (!started) {
    updateInceptionState(root, {
      expectedSha256: report.state.sha256,
      changes: { init: { status: 'in-progress', handoff: report.handoff, receipt: reference } },
    });
  }
  return deepFreeze({
    status: 'in-progress',
    runId: report.runId,
    receipt: reference,
    changed: { state: !started, receipt: existing === null },
    destinations: publicDestinations(observeDestinations(root, report, writes)),
  });
}

function verifyCompletion(root, report, next) {
  if (!sameReference(next.init.handoff, report.handoff)) {
    fail('INCEPTION_HANDOFF_RECEIPT', 'init completion must keep the verified handoff');
  }
  const completed = readReceipt(root, next.init.receipt.path, report.runId);
  if (completed === null || completed.sha256 !== next.init.receipt.sha256 || completed.receipt.status !== 'complete') {
    fail('INCEPTION_HANDOFF_RECEIPT', 'init completion must reference the verified complete receipt');
  }
  assertReceiptBinding(completed.receipt, report);
}

// After the init skill promoted every decision and the hub gate passed:
// requires unchanged code, bound inputs, and every promoted text present,
// then completes the receipt and records init complete. An exact repetition
// is a no-op; stable bytes that diverge from a complete receipt are refused.
export function finalizeInitReceipt(root, { handoff, receipt, gate, paths = [], env } = {}) {
  if (gate !== 'pass' && gate !== 'fail') fail('INCEPTION_HANDOFF_ARGUMENT', 'gate must be pass or fail');
  if (gate !== 'pass') fail('INCEPTION_HANDOFF_GATE', 'the hub gate did not pass; init is not finalized');
  const { report, descriptor } = verifyTransfer(root, { handoff, paths, env });
  if (report.checkpoint.diverged) {
    fail('INCEPTION_HANDOFF_DIVERGED', 'the current code diverges from the verified checkpoint; finalization is refused');
  }
  if (descriptor.init.status === 'not-started') {
    fail('INCEPTION_HANDOFF_RECEIPT', 'init was never started for this handoff; run prepare first');
  }
  const target = resolveReceipt(receipt, descriptor, report);
  const existing = readBoundReceipt(root, target, report, descriptor);
  assertReceiptBinding(existing.receipt, report);

  const destinations = observeDestinations(root, report, existing.receipt.writes);
  for (const decision of report.promotion.decisions) {
    if (decision.outcome !== 'promote') continue;
    const current = destinations.find(({ path }) => path === decision.destination);
    if (current.bytes === null || !current.bytes.includes(Buffer.from(decision.content, 'utf8'))) {
      fail('INCEPTION_HANDOFF_UNREALIZED', `decision '${decision.id}' is not realized in '${decision.destination}'`);
    }
  }
  const text = serializeInitReceipt(receiptFor(report, 'complete',
    destinations.map(({ path, previous, observed }) => ({ path, previous, observed }))));
  let receiptChanged = false;
  if (existing.receipt.status === 'complete') {
    if (text !== existing.text) {
      fail('INCEPTION_HANDOFF_DIVERGED', 'stable bytes diverge from the complete receipt; reconcile the human change before finalizing again');
    }
  } else {
    writeInceptionFile(root, target, text, { expectedSha256: existing.sha256, runId: report.runId });
    receiptChanged = true;
  }
  const reference = { path: target, sha256: sha256Hex(Buffer.from(text, 'utf8')) };
  let stateChanged = false;
  if (descriptor.init.status === 'complete') {
    if (!sameReference(descriptor.init.receipt, reference)) {
      fail('INCEPTION_HANDOFF_RECEIPT', 'the inception state records a different receipt');
    }
  } else {
    updateInceptionState(root, {
      expectedSha256: report.state.sha256,
      changes: { init: { status: 'complete', handoff: report.handoff, receipt: reference } },
      verifyInitCompletion: (next) => verifyCompletion(root, report, next),
    });
    stateChanged = true;
  }
  return deepFreeze({
    status: 'complete',
    runId: report.runId,
    receipt: reference,
    changed: { state: stateChanged, receipt: receiptChanged },
    destinations: publicDestinations(destinations),
  });
}

// Writes a helper-produced checkpoint to an exact file of the active run:
// create-only, with an identical rewrite as a no-op.
export function writeCodeCheckpoint(root, { runId, output, paths, env } = {}) {
  const id = requireRunId({ runId });
  runFile(output, id, 'checkpoint output');
  inspectRun(root, id, 'the checkpoint output');
  const text = serializeCodeCheckpoint(observeCodeCheckpoint(root, { runId: id, paths, env }));
  let current = null;
  try {
    current = readInput(root, output, id).toString('utf8');
  } catch (error) {
    if (error.code !== 'INCEPTION_MISSING') throw error;
  }
  if (current !== null && current !== text) {
    fail('INCEPTION_HANDOFF_EXISTS', `'${output}' already holds a different checkpoint; record a new one at a new exact path`);
  }
  if (current === null) writeInceptionFile(root, output, text, { expectedSha256: null, runId: id });
  return deepFreeze({ path: output, sha256: sha256Hex(Buffer.from(text, 'utf8')), changed: current === null });
}

const USAGE = [
  'usage: inception-handoff.mjs <command> --root <dir> ...',
  '  verify     --handoff <run-file> [--path <repo-path>]...',
  '  project    --handoff <run-file> [--resolution <id=choice>]...',
  '  checkpoint --run-id <uuid> --output <run-file> --path <repo-path>...',
  '  prepare    --handoff <run-file> [--receipt <run-file>] [--path <repo-path>]...',
  '  finalize   --handoff <run-file> --gate <pass|fail> [--receipt <run-file>] [--path <repo-path>]...',
  '  (--receipt names a new receipt when init starts; a started init uses the receipt its state binds)',
].join('\n');
const COMMANDS = {
  verify: { required: ['handoff'], optional: ['path'] },
  project: { required: ['handoff'], optional: ['resolution'] },
  checkpoint: { required: ['run-id', 'output', 'path'], optional: [] },
  prepare: { required: ['handoff'], optional: ['receipt', 'path'] },
  finalize: { required: ['handoff', 'gate'], optional: ['receipt', 'path'] },
};
const OPTIONS = ['handoff', 'receipt', 'output', 'run-id', 'gate', 'path', 'resolution'];

function usage(io, reason) {
  io.stderr.write(`inception-handoff: ${reason}\n${USAGE}\n`);
  return 2;
}

function parseResolutions(values) {
  const resolutions = {};
  for (const value of values ?? []) {
    const separator = value.indexOf('=');
    if (separator <= 0 || separator === value.length - 1) return null;
    const id = value.slice(0, separator);
    if (Object.hasOwn(resolutions, id)) return null;
    resolutions[id] = value.slice(separator + 1);
  }
  return resolutions;
}

function summary(report) {
  return {
    status: report.status,
    runId: report.runId,
    handoff: report.handoff,
    state: report.state,
    inputs: report.inputs,
    checkpoint: report.checkpoint,
    decisions: report.promotion.decisions.map(({ id, outcome, destination }) => (
      outcome === 'promote' ? { id, outcome, destination } : { id, outcome })),
  };
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
        handoff: { type: 'string' },
        receipt: { type: 'string' },
        output: { type: 'string' },
        'run-id': { type: 'string' },
        gate: { type: 'string' },
        path: { type: 'string', multiple: true },
        resolution: { type: 'string', multiple: true },
      },
    });
  } catch {
    return usage(io, 'unrecognized or malformed arguments');
  }
  const { positionals, values } = parsed;
  const [command] = positionals;
  if (positionals.length !== 1 || !Object.hasOwn(COMMANDS, command)) {
    return usage(io, `expected exactly one command: ${Object.keys(COMMANDS).join(', ')}`);
  }
  if (typeof values.root !== 'string' || values.root.length === 0) return usage(io, '--root is required');
  const { required, optional } = COMMANDS[command];
  for (const option of OPTIONS) {
    if (values[option] !== undefined && !required.includes(option) && !optional.includes(option)) {
      return usage(io, `--${option} is not accepted by ${command}`);
    }
  }
  const missing = required.find((option) => values[option] === undefined);
  if (missing) return usage(io, `${command} requires --${missing}`);
  const resolutions = parseResolutions(values.resolution);
  if (resolutions === null) return usage(io, '--resolution must be a unique <id=choice> pair');

  const common = { handoff: values.handoff, paths: values.path ?? [], env: io.env };
  try {
    let result;
    if (command === 'verify') {
      result = summary(verifyInceptionHandoff(values.root, common));
    } else if (command === 'project') {
      const report = verifyInceptionHandoff(values.root, { handoff: values.handoff, env: io.env });
      io.stdout.write(serialize(projectConfirmedInputs(report.confirmedInputs, { resolutions })));
      return 0;
    } else if (command === 'checkpoint') {
      result = writeCodeCheckpoint(values.root, {
        runId: values['run-id'], output: values.output, paths: values.path, env: io.env,
      });
    } else if (command === 'prepare') {
      result = prepareInitReceipt(values.root, { ...common, receipt: values.receipt });
    } else {
      result = finalizeInitReceipt(values.root, { ...common, receipt: values.receipt, gate: values.gate });
    }
    io.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`inception-handoff: ${String(error?.message ?? error).slice(0, 1000)}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}

import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { appendWorkPath, readWorkPath, writeWorkPath } from './work-paths.mjs';
import {
  assertNextWorkflowSequence, correlateRun, normalizeWorkflowEnvelope, selectBaseline,
} from './workflow-state.mjs';
import { verifyAutopilotRuntime } from './autopilot-runtime.mjs';

export const AUTOPILOT_EVENT_SCHEMA_VERSION = 1;
export const AUTOPILOT_RUN_SCHEMA_VERSION = 1;
export const AUTOPILOT_CONTROLLER_PROTOCOL = 2;
export const AUTOPILOT_ROLES = Object.freeze([
  'plan', 'review', 'implementer', 'task-reviewer', 'fix', 'final-review',
  'task-review-correction', 'final-review-correction',
]);
const PHASES = new Set(['plan', 'implement', 'review', 'final-review']);
const ROLES = new Set(AUTOPILOT_ROLES);
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const COMMON = ['schemaVersion', 'sequence', 'runId', 'timestamp', 'event'];
const SCHEMAS = Object.freeze({
  RUN_STARTED: ['baseline', 'branch', 'runtimeFingerprint'],
  PHASE_RESERVED: ['scope'],
  PHASE_ACCEPTED: ['scope'],
  ROLE_RESERVED: ['scope', 'roleSequence', 'role', 'reservationPath', 'reservationDigest', 'requestedModel', 'descriptorModel', 'degradationReason'],
  RESPONSE_CAPTURED: ['scope', 'roleSequence', 'responsePath', 'responseDigest', 'observedModel'],
  RESULT_ACCEPTED: ['scope', 'roleSequence', 'receiptPath', 'receiptDigest'],
  REPAIR_RESERVED: ['scope', 'roleSequence', 'role', 'correctionOf', 'reservationPath', 'reservationDigest', 'requestedModel', 'descriptorModel', 'degradationReason'],
  RECOVERY_IMPORTED: ['scope', 'importPath', 'importDigest'],
  RECONCILIATION_REQUIRED: ['scope', 'reason'],
  RUN_HALTED: ['reason'],
  RUN_COMPLETED: [],
});
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => { throw new Error(`autopilot state: ${message}`); };
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const line = (value) => typeof value === 'string' && value.length > 0
  && value.trim() === value && !/[\u0000-\u001f]/u.test(value);
const bytesOf = (value) => Buffer.isBuffer(value) ? value : Buffer.from(value);
const keyOf = (scope) => JSON.stringify(scope);
const paths = (dir) => ({ run: `${dir}/autopilot-run.json`, events: `${dir}/autopilot-events.jsonl`, status: `${dir}/autopilot-status.md` });

function exact(value, names, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...names].sort().join(',')) {
    fail(`${label} fields must be closed: ${names.join(', ')}`);
  }
}

function digest(value, label) { if (typeof value !== 'string' || !SHA256.test(value)) fail(`${label} must be SHA-256`); }
function optionalModel(value, label) { if (value !== null && !line(value)) fail(`${label} must be a model ID or null`); }
function scopeOf(scope) {
  exact(scope, ['phase', 'attempt', 'task', 'iteration'], 'scope');
  if (!PHASES.has(scope.phase) || !positive(scope.attempt) || !positive(scope.iteration)
    || !(scope.task === null || positive(scope.task))) fail('invalid phase/attempt/task/iteration scope');
  if (['plan', 'final-review'].includes(scope.phase) && scope.task !== null) fail('whole-branch phase requires null task');
  if (['implement', 'review'].includes(scope.phase) && scope.task === null) fail('task phase requires task identity');
  return Object.freeze({ ...scope });
}

function runtimeOf(runtime) {
  exact(runtime, ['fingerprint', 'files'], 'runtime identity');
  digest(runtime.fingerprint, 'runtime fingerprint');
  if (!Array.isArray(runtime.files) || runtime.files.length === 0) fail('runtime file inventory required');
  let previous = '';
  for (const file of runtime.files) {
    exact(file, ['path', 'sha256'], 'runtime file');
    if (!line(file.path) || file.path <= previous || !/^(?:scripts|adapters|skills)\/[A-Za-z0-9._/-]+$|^package\.json$|^\.claude-plugin\/[A-Za-z0-9._-]+$|^\.codex-plugin\/[A-Za-z0-9._-]+$|^cordis\.patch\.yml$/u.test(file.path)
      || file.path.split('/').some((part) => part === '.' || part === '..' || part === '')) fail('invalid runtime file path or order');
    digest(file.sha256, 'runtime file digest');
    previous = file.path;
  }
  if (runtime.fingerprint !== sha(Buffer.from(JSON.stringify(runtime.files.map((file) => [file.path, file.sha256]))))) {
    fail('runtime fingerprint does not match its file inventory');
  }
  return runtime;
}

function eventOf(candidate) {
  normalizeWorkflowEnvelope(candidate);
  const fields = SCHEMAS[candidate.event];
  if (!fields) fail(`unknown Gear 3 event ${String(candidate.event)}`);
  exact(candidate, [...COMMON, ...fields], candidate.event);
  if (candidate.event === 'RUN_STARTED') {
    if (!line(candidate.branch) || !GIT_ID.test(candidate.baseline)) fail('invalid branch or baseline');
    digest(candidate.runtimeFingerprint, 'runtime fingerprint');
  }
  if (Object.hasOwn(candidate, 'scope') && candidate.scope !== null) scopeOf(candidate.scope);
  if (['PHASE_RESERVED', 'PHASE_ACCEPTED', 'ROLE_RESERVED', 'REPAIR_RESERVED', 'RESPONSE_CAPTURED', 'RESULT_ACCEPTED', 'RECOVERY_IMPORTED'].includes(candidate.event) && candidate.scope === null) fail('event requires scope');
  if (Object.hasOwn(candidate, 'roleSequence') && !positive(candidate.roleSequence)) fail('invalid role sequence');
  if (['ROLE_RESERVED', 'REPAIR_RESERVED'].includes(candidate.event)) {
    if (!ROLES.has(candidate.role)) fail('unknown role');
    if (!line(candidate.reservationPath)) fail('invalid reservation path');
    digest(candidate.reservationDigest, 'reservation digest');
    optionalModel(candidate.requestedModel, 'requested model');
    optionalModel(candidate.descriptorModel, 'descriptor model');
    if (candidate.degradationReason !== null && !line(candidate.degradationReason)) fail('invalid degradation reason');
    if (candidate.event === 'REPAIR_RESERVED' && !positive(candidate.correctionOf)) fail('invalid correction target');
  }
  for (const [pathField, digestField] of [
    ['responsePath', 'responseDigest'], ['receiptPath', 'receiptDigest'], ['importPath', 'importDigest'],
  ]) {
    if (Object.hasOwn(candidate, pathField)) {
      if (!line(candidate[pathField])) fail(`invalid ${pathField}`);
      digest(candidate[digestField], digestField);
    }
  }
  if (Object.hasOwn(candidate, 'observedModel')) optionalModel(candidate.observedModel, 'observed model');
  if (Object.hasOwn(candidate, 'reason') && !line(candidate.reason)) fail('invalid reason');
  return Object.freeze({ ...candidate });
}

export function validateAutopilotEvent(candidate) { return eventOf(candidate); }

function parseJson(bytes, label) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(`${label} has invalid UTF-8`); }
  let value;
  try { value = JSON.parse(text); } catch { fail(`${label} is invalid JSON`); }
  if (`${JSON.stringify(value)}\n` !== text) fail(`${label} must be canonical JSON with final newline`);
  return value;
}

function journal(input) {
  const bytes = bytesOf(input);
  if (bytes.length === 0 || bytes.at(-1) !== 10) fail('journal is empty or missing final newline');
  const entries = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 10) continue;
    const end = index + 1;
    const event = eventOf(parseJson(bytes.subarray(start, end), 'journal line'));
    entries.push({ event, start, end });
    start = end;
  }
  if (start !== bytes.length) fail('truncated journal');
  return entries;
}

export function parseAutopilotJsonl(input) { return Object.freeze(journal(input).map(({ event }) => event)); }

export function createAutopilotState() {
  return { runId: null, branch: null, baseline: null, runtimeFingerprint: null,
    lastSequence: 0, lastTimestamp: null, status: 'ABSENT', phases: [], roles: [], imports: [], reason: null,
    reconciliationPending: false };
}

export function reduceAutopilotEvent(current, candidate) {
  const event = eventOf(candidate);
  assertNextWorkflowSequence(current.lastSequence, event);
  if (current.lastTimestamp !== null && event.timestamp < current.lastTimestamp) fail('reordered timestamp');
  if (current.runId === null) {
    if (event.event !== 'RUN_STARTED') fail('first event must be RUN_STARTED');
    selectBaseline(null, event.baseline);
    return { ...current, runId: event.runId, branch: event.branch, baseline: event.baseline,
      runtimeFingerprint: event.runtimeFingerprint, lastSequence: event.sequence,
      lastTimestamp: event.timestamp, status: 'RUNNING' };
  }
  correlateRun(current.runId, event);
  if (current.status !== 'RUNNING') fail('terminal run cannot accept more events');
  if (current.reconciliationPending && event.event !== 'RUN_HALTED') fail('reconciliation must halt the run');
  if (event.event === 'RUN_STARTED') fail('duplicate run identity');
  const next = { ...current, lastSequence: event.sequence, lastTimestamp: event.timestamp };
  const scoped = event.scope && keyOf(event.scope);
  const phase = current.phases.find((item) => keyOf(item.scope) === scoped);
  const role = current.roles.find((item) => item.roleSequence === event.roleSequence);
  switch (event.event) {
    case 'PHASE_RESERVED':
      if (phase) fail('phase already reserved');
      next.phases = [...current.phases, { scope: event.scope, accepted: false }];
      break;
    case 'PHASE_ACCEPTED':
      if (!phase || phase.accepted) fail('phase cannot be accepted');
      if (current.roles.some((item) => keyOf(item.scope) === scoped && !item.accepted && !item.superseded)) fail('phase has unaccepted role');
      next.phases = current.phases.map((item) => item === phase ? { ...item, accepted: true } : item);
      break;
    case 'ROLE_RESERVED':
    case 'REPAIR_RESERVED': {
      if (event.roleSequence !== current.roles.length + 1) fail('role sequence is not contiguous');
      const active = current.roles.find((item) => !item.accepted && !item.superseded);
      if (active && (event.event !== 'REPAIR_RESERVED' || active.roleSequence !== event.correctionOf || !active.responseCaptured)) {
        fail('active role reservation cannot be reused');
      }
      if (phase?.accepted) fail('phase already accepted');
      if (current.roles.some((item) => keyOf(item.scope) === scoped && item.role === event.role)) fail('role identity already reserved in scope');
      if (event.event === 'REPAIR_RESERVED') {
        if (!active || active.roleSequence !== event.correctionOf || !active.responseCaptured
          || current.roles.some((item) => item.correctionOf === event.correctionOf)) fail('repair target has no single captured response');
      }
      const priorRoles = event.event === 'REPAIR_RESERVED'
        ? current.roles.map((item) => item === active ? { ...item, superseded: true } : item)
        : current.roles;
      next.roles = [...priorRoles, { scope: event.scope, roleSequence: event.roleSequence,
        role: event.role, reservationPath: event.reservationPath, reservationDigest: event.reservationDigest,
        responseCaptured: false, accepted: false, correctionOf: event.correctionOf ?? null }];
      break;
    }
    case 'RESPONSE_CAPTURED':
      if (!role || role.responseCaptured || keyOf(role.scope) !== scoped) fail('response does not match active role');
      next.roles = current.roles.map((item) => item === role ? { ...item, responseCaptured: true,
        responsePath: event.responsePath, responseDigest: event.responseDigest, observedModel: event.observedModel } : item);
      break;
    case 'RESULT_ACCEPTED':
      if (!role || !role.responseCaptured || role.accepted || keyOf(role.scope) !== scoped) fail('result requires a captured response');
      next.roles = current.roles.map((item) => item === role ? { ...item, accepted: true,
        receiptPath: event.receiptPath, receiptDigest: event.receiptDigest } : item);
      break;
    case 'RECOVERY_IMPORTED':
      if (current.imports.some((item) => keyOf(item.scope) === scoped)) fail('recovery already imported for scope');
      next.imports = [...current.imports, { scope: event.scope, path: event.importPath, digest: event.importDigest }];
      break;
    case 'RECONCILIATION_REQUIRED':
      next.reason = event.reason; next.reconciliationPending = true;
      break;
    case 'RUN_HALTED':
      next.status = 'HALTED'; next.reason = event.reason;
      break;
    case 'RUN_COMPLETED':
      if (current.roles.some((item) => !item.accepted && !item.superseded) || current.phases.some((item) => !item.accepted)) fail('cannot complete with unaccepted work');
      next.status = 'COMPLETED';
      break;
    default: fail('unknown transition');
  }
  return next;
}

export function reduceAutopilotEvents(events) {
  if (!Array.isArray(events) || events.length === 0) fail('journal has no RUN_STARTED event');
  return events.reduce(reduceAutopilotEvent, createAutopilotState());
}

export function renderAutopilotStatus(state) {
  if (state.runId === null) fail('cannot project absent run');
  return `# Autopilot status\n\nRun: ${state.runId}\nStatus: ${state.status}\nBranch: ${state.branch}\nBaseline: ${state.baseline}\nLast event: ${state.lastSequence}\nRoles: ${state.roles.length}\n${state.reason === null ? '' : `Reason: ${state.reason}\n`}`;
}

export function projectAutopilotStatus(root, dir) {
  const { state } = readAutopilotRun(root, dir);
  writeWorkPath(root, paths(dir).status, renderAutopilotStatus(state), { family: 'status' });
  return state;
}

function optionalRead(root, path, family) {
  try { return readWorkPath(root, path, { family }); } catch (error) {
    if (/missing work artifact/u.test(error.message)) return null;
    throw error;
  }
}

function verifyBytes(root, path, family, expected) {
  const actual = readWorkPath(root, path, { family });
  if (sha(actual) !== expected) fail(`artifact digest mismatch: ${path}`);
  return actual;
}

function readIdentity(root, dir, engineRoot) {
  const run = parseJson(readWorkPath(root, paths(dir).run, { family: 'autopilot-run' }), 'run identity');
  exact(run, ['schemaVersion', 'controllerProtocol', 'runId', 'branch', 'baseline', 'runtime'], 'run identity');
  if (run.schemaVersion !== AUTOPILOT_RUN_SCHEMA_VERSION || run.controllerProtocol !== AUTOPILOT_CONTROLLER_PROTOCOL
    || !line(run.runId) || !line(run.branch) || !GIT_ID.test(run.baseline)) fail('invalid run identity');
  runtimeOf(run.runtime);
  if (engineRoot !== undefined) verifyAutopilotRuntime(engineRoot, run.runtime);
  return run;
}

function readRun(root, dir, { engineRoot, allowOrphanReservation = false } = {}) {
  const p = paths(dir);
  const run = readIdentity(root, dir, engineRoot);
  const journalBytes = readWorkPath(root, p.events, { family: 'autopilot-events' });
  const entries = journal(journalBytes);
  const state = reduceAutopilotEvents(entries.map((entry) => entry.event));
  if (state.runId !== run.runId || state.branch !== run.branch || state.baseline !== run.baseline
    || state.runtimeFingerprint !== run.runtime.fingerprint) fail('journal RUN_STARTED mismatches immutable run');
  for (const entry of entries) {
    const { event } = entry;
    if (['ROLE_RESERVED', 'REPAIR_RESERVED'].includes(event.event)) {
      const expectedPath = `${dir}/role-${event.roleSequence}-reservation.json`;
      if (event.reservationPath !== expectedPath) fail('reservation path mismatch');
      const reservationBytes = verifyBytes(root, expectedPath, 'role-reservation', event.reservationDigest);
      const reservation = parseJson(reservationBytes, 'role reservation');
      exact(reservation, ['schemaVersion', 'runId', 'roleSequence', 'scope', 'role', 'prefixBytes', 'prefixDigest', 'runtimeFingerprint', 'requestedModel', 'descriptorModel', 'degradationReason', 'correctionOf'], 'role reservation');
      if (reservation.schemaVersion !== 1 || reservation.runId !== run.runId || reservation.roleSequence !== event.roleSequence
        || keyOf(reservation.scope) !== keyOf(event.scope) || reservation.role !== event.role
        || reservation.prefixBytes !== entry.start || reservation.prefixDigest !== sha(journalBytes.subarray(0, entry.start))
        || reservation.runtimeFingerprint !== run.runtime.fingerprint
        || reservation.requestedModel !== event.requestedModel || reservation.descriptorModel !== event.descriptorModel
        || reservation.degradationReason !== event.degradationReason || reservation.correctionOf !== (event.correctionOf ?? null)) {
        fail('reservation journal prefix or identity mismatch');
      }
    }
    if (event.event === 'RESPONSE_CAPTURED') {
      if (event.responsePath !== `${dir}/role-${event.roleSequence}-response.json`) fail('response path mismatch');
      verifyBytes(root, event.responsePath, 'role-response', event.responseDigest);
    }
    if (event.event === 'RESULT_ACCEPTED') {
      if (!event.receiptPath.startsWith(`${dir}/`)) fail('receipt is outside this run');
      verifyBytes(root, event.receiptPath, 'task-result', event.receiptDigest);
    }
    if (event.event === 'RECOVERY_IMPORTED') {
      if (event.importPath !== `${dir}/task-${event.scope.task}-import.json`) fail('recovery import path mismatch');
      verifyBytes(root, event.importPath, 'task-import', event.importDigest);
    }
  }
  const orphanPath = `${dir}/role-${state.roles.length + 1}-reservation.json`;
  const orphanReservation = optionalRead(root, orphanPath, 'role-reservation');
  if (orphanReservation !== null && !allowOrphanReservation) fail('orphan role reservation requires reconciliation');
  const pendingResponses = state.roles.filter((item) => !item.responseCaptured
    && optionalRead(root, `${dir}/role-${item.roleSequence}-response.json`, 'role-response') !== null)
    .map((item) => item.roleSequence);
  return Object.freeze({ run, state, events: Object.freeze(entries.map(({ event }) => event)),
    journalBytes, orphanReservation, pendingResponses: Object.freeze(pendingResponses) });
}

export function readAutopilotRun(root, dir, { engineRoot } = {}) { return readRun(root, dir, { engineRoot }); }

export function resumeAutopilotRun(root, dir, engineRoot) {
  if (typeof engineRoot !== 'string' || engineRoot.length === 0) fail('selected engine root is required for resume');
  return readRun(root, dir, { engineRoot });
}

export function reconcileAutopilotStart(root, dir, engineRoot) {
  if (typeof engineRoot !== 'string' || engineRoot.length === 0) fail('selected engine root is required for start reconciliation');
  const run = readIdentity(root, dir, engineRoot);
  const p = paths(dir);
  if (optionalRead(root, p.events, 'autopilot-events') !== null) return resumeAutopilotRun(root, dir, engineRoot);
  if (optionalRead(root, `${dir}/role-1-reservation.json`, 'role-reservation') !== null) fail('role reservation exists without a journal');
  const first = eventOf({ schemaVersion: 1, sequence: 1, runId: run.runId, timestamp: new Date().toISOString(),
    event: 'RUN_STARTED', branch: run.branch, baseline: run.baseline, runtimeFingerprint: run.runtime.fingerprint });
  writeWorkPath(root, p.events, `${JSON.stringify(first)}\n`, { createOnly: true, family: 'autopilot-events' });
  const state = reduceAutopilotEvents([first]);
  writeWorkPath(root, p.status, renderAutopilotStatus(state), { family: 'status' });
  return readRun(root, dir, { engineRoot });
}

// A complete orphan reservation is adopted as a spent identity. No child is
// dispatched by this operation; the caller must reconcile captured evidence.
export function reconcileAutopilotReservation(root, dir, options = {}) {
  const { run, state, journalBytes, orphanReservation } = readRun(root, dir, {
    ...options, allowOrphanReservation: true,
  });
  if (orphanReservation === null) fail('no orphan reservation to reconcile');
  const reservation = parseJson(orphanReservation, 'orphan role reservation');
  exact(reservation, ['schemaVersion', 'runId', 'roleSequence', 'scope', 'role', 'prefixBytes', 'prefixDigest', 'runtimeFingerprint', 'requestedModel', 'descriptorModel', 'degradationReason', 'correctionOf'], 'orphan role reservation');
  if (reservation.schemaVersion !== 1 || reservation.runId !== run.runId
    || reservation.roleSequence !== state.roles.length + 1
    || reservation.prefixBytes !== journalBytes.length || reservation.prefixDigest !== sha(journalBytes)
    || reservation.runtimeFingerprint !== run.runtime.fingerprint) fail('orphan reservation prefix or identity mismatch');
  scopeOf(reservation.scope);
  const reservationPath = `${dir}/role-${reservation.roleSequence}-reservation.json`;
  const event = eventFrom(state, { event: reservation.correctionOf === null ? 'ROLE_RESERVED' : 'REPAIR_RESERVED',
    scope: reservation.scope, roleSequence: reservation.roleSequence, role: reservation.role,
    ...(reservation.correctionOf === null ? {} : { correctionOf: reservation.correctionOf }),
    reservationPath, reservationDigest: sha(orphanReservation),
    requestedModel: reservation.requestedModel, descriptorModel: reservation.descriptorModel,
    degradationReason: reservation.degradationReason });
  publishEvent(root, dir, state, event);
  return event;
}

function nextTimestamp(previous) {
  const now = Date.now();
  return new Date(Math.max(now, previous === null ? 0 : Date.parse(previous))).toISOString();
}

function eventFrom(state, fields) {
  return eventOf({ schemaVersion: AUTOPILOT_EVENT_SCHEMA_VERSION, sequence: state.lastSequence + 1,
    runId: state.runId, timestamp: nextTimestamp(state.lastTimestamp), ...fields });
}

function publishEvent(root, dir, state, event) {
  const next = reduceAutopilotEvent(state, event);
  appendWorkPath(root, paths(dir).events, `${JSON.stringify(event)}\n`, { family: 'autopilot-events' });
  writeWorkPath(root, paths(dir).status, renderAutopilotStatus(next), { family: 'status' });
  return next;
}

export function createAutopilotRun(root, dir, identity, { engineRoot } = {}) {
  exact(identity, ['runId', 'branch', 'baseline', 'runtime'], 'start identity');
  if (!line(identity.runId) || !line(identity.branch) || !GIT_ID.test(identity.baseline)) fail('invalid start identity');
  runtimeOf(identity.runtime);
  if (engineRoot !== undefined) verifyAutopilotRuntime(engineRoot, identity.runtime);
  const run = { schemaVersion: AUTOPILOT_RUN_SCHEMA_VERSION, controllerProtocol: AUTOPILOT_CONTROLLER_PROTOCOL, ...identity };
  const p = paths(dir);
  writeWorkPath(root, p.run, `${JSON.stringify(run)}\n`, { createOnly: true, family: 'autopilot-run' });
  const first = eventOf({ schemaVersion: 1, sequence: 1, runId: run.runId, timestamp: new Date().toISOString(),
    event: 'RUN_STARTED', branch: run.branch, baseline: run.baseline, runtimeFingerprint: run.runtime.fingerprint });
  writeWorkPath(root, p.events, `${JSON.stringify(first)}\n`, { createOnly: true, family: 'autopilot-events' });
  const state = reduceAutopilotEvents([first]);
  writeWorkPath(root, p.status, renderAutopilotStatus(state), { family: 'status' });
  return Object.freeze({ run, state });
}

export function appendAutopilotEvent(root, dir, fields, options = {}) {
  if (['RUN_STARTED', 'ROLE_RESERVED', 'REPAIR_RESERVED', 'RESPONSE_CAPTURED', 'RESULT_ACCEPTED'].includes(fields.event)) {
    fail('event requires its dedicated durable publication operation');
  }
  const { state } = readAutopilotRun(root, dir, options);
  const event = eventFrom(state, fields);
  if (event.event === 'RECOVERY_IMPORTED') {
    if (event.importPath !== `${dir}/task-${event.scope.task}-import.json`) fail('recovery import path mismatch');
    verifyBytes(root, event.importPath, 'task-import', event.importDigest);
  }
  publishEvent(root, dir, state, event);
  return event;
}

export function reserveAutopilotRole(root, dir, {
  scope, role, correctionOf = null, requestedModel = null, descriptorModel = null, degradationReason = null,
}, options = {}) {
  scopeOf(scope);
  if (!ROLES.has(role)) fail('unknown role');
  const { run, state, journalBytes } = readAutopilotRun(root, dir, options);
  const roleSequence = state.roles.length + 1;
  const reservationPath = `${dir}/role-${roleSequence}-reservation.json`;
  const reservation = { schemaVersion: 1, runId: run.runId, roleSequence, scope, role,
    prefixBytes: journalBytes.length, prefixDigest: sha(journalBytes),
    runtimeFingerprint: run.runtime.fingerprint, requestedModel, descriptorModel,
    degradationReason, correctionOf };
  const event = eventFrom(state, { event: correctionOf === null ? 'ROLE_RESERVED' : 'REPAIR_RESERVED',
    scope, roleSequence, role, ...(correctionOf === null ? {} : { correctionOf }), reservationPath,
    reservationDigest: sha(Buffer.from(`${JSON.stringify(reservation)}\n`)),
    requestedModel, descriptorModel, degradationReason });
  // Validate the transition before publishing the create-only reservation.
  reduceAutopilotEvent(state, event);
  writeWorkPath(root, reservationPath, `${JSON.stringify(reservation)}\n`, { createOnly: true, family: 'role-reservation' });
  publishEvent(root, dir, state, event);
  return Object.freeze(reservation);
}

export function captureAutopilotResponse(root, dir, roleSequence, response, { observedModel = null, engineRoot } = {}) {
  const { state } = readAutopilotRun(root, dir, { engineRoot });
  const role = state.roles.find((item) => item.roleSequence === roleSequence);
  if (!role || role.responseCaptured) fail('response does not match an uncaptured role');
  const bytes = bytesOf(response);
  // The captured response is opaque JSON: its semantics belong to the selected response gate.
  try { JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('response is not valid UTF-8 JSON'); }
  const responsePath = `${dir}/role-${roleSequence}-response.json`;
  const existing = optionalRead(root, responsePath, 'role-response');
  if (existing === null) writeWorkPath(root, responsePath, bytes, { createOnly: true, family: 'role-response' });
  else if (!existing.equals(bytes)) fail('captured response collision');
  const event = eventFrom(state, { event: 'RESPONSE_CAPTURED', scope: role.scope, roleSequence,
    responsePath, responseDigest: sha(bytes), observedModel });
  publishEvent(root, dir, state, event);
  return event;
}

export function acceptAutopilotResult(root, dir, roleSequence, receipt, { verifyReceipt, engineRoot } = {}) {
  if (typeof verifyReceipt !== 'function') fail('receipt verifier is required before acceptance');
  const { state } = readAutopilotRun(root, dir, { engineRoot });
  const role = state.roles.find((item) => item.roleSequence === roleSequence);
  if (!role || !role.responseCaptured || role.accepted) fail('result requires a captured, unaccepted response');
  exact(receipt, ['path', 'digest'], 'receipt reference');
  digest(receipt.digest, 'receipt digest');
  const bytes = verifyBytes(root, receipt.path, 'task-result', receipt.digest);
  if (verifyReceipt(bytes, receipt.path, role) !== true) fail('receipt verification rejected');
  const event = eventFrom(state, { event: 'RESULT_ACCEPTED', scope: role.scope, roleSequence,
    receiptPath: receipt.path, receiptDigest: receipt.digest });
  publishEvent(root, dir, state, event);
  return event;
}

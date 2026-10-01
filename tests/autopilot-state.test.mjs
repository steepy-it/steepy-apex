import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  createAutopilotRun, readAutopilotRun, reserveAutopilotRole,
  captureAutopilotResponse, acceptAutopilotResult, appendAutopilotEvent,
  parseAutopilotJsonl, renderAutopilotStatus, reconcileAutopilotReservation,
  projectAutopilotStatus,
} from '../scripts/autopilot-state.mjs';
import { readWorkPath, writeWorkPath } from '../scripts/work-paths.mjs';

const DIR = '.apex/work/tasks/2026-10-01-autopilot-test';
const HASH = 'a'.repeat(64);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const scope = { phase: 'implement', attempt: 1, task: 1, iteration: 1 };

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'steepy-autopilot-state-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function start(root) {
  const files = [{ path: 'package.json', sha256: HASH }];
  return createAutopilotRun(root, DIR, {
    runId: 'run-one', branch: 'feature/run-one', baseline: 'b'.repeat(40),
    runtime: { fingerprint: sha(Buffer.from(JSON.stringify(files.map((file) => [file.path, file.sha256])))), files },
  });
}

test('role reservation binds the exact preceding journal and accepts only captured, receipted output', () => fixture((root) => {
  start(root);
  appendAutopilotEvent(root, DIR, { event: 'PHASE_RESERVED', scope });
  const reservation = reserveAutopilotRole(root, DIR, { scope, role: 'implementer' });
  assert.equal(reservation.roleSequence, 1);
  const prefix = readFileSync(join(root, DIR, 'autopilot-events.jsonl'));
  assert.equal(reservation.prefixBytes < prefix.length, true);
  assert.equal(sha(prefix.subarray(0, reservation.prefixBytes)), reservation.prefixDigest);
  assert.throws(() => acceptAutopilotResult(root, DIR, 1, { path: `${DIR}/task-1-execution-1-result.json`, digest: HASH }), /response|receipt/i);
  assert.throws(() => appendAutopilotEvent(root, DIR, { event: 'RESULT_ACCEPTED', scope, roleSequence: 1,
    receiptPath: `${DIR}/task-1-execution-1-result.json`, receiptDigest: HASH }), /dedicated durable publication/i);
  const responsePath = `${DIR}/role-1-response.json`;
  const response = Buffer.from('{"status":"DONE"}\n');
  captureAutopilotResponse(root, DIR, 1, response);
  assert.throws(() => acceptAutopilotResult(root, DIR, 1,
    { path: `${DIR}/task-1-execution-1-result.json`, digest: HASH }), /receipt verifier.*required/i);
  assert.deepEqual(readWorkPath(root, responsePath, { family: 'role-response' }), response);
  const receiptPath = `${DIR}/task-1-execution-1-result.json`;
  writeWorkPath(root, receiptPath, '{"ok":true}\n', { createOnly: true, family: 'task-result' });
  acceptAutopilotResult(root, DIR, 1, { path: receiptPath, digest: sha(Buffer.from('{"ok":true}\n')) }, { verifyReceipt: (bytes) => JSON.parse(bytes).ok === true });
  const state = readAutopilotRun(root, DIR).state;
  assert.equal(state.roles[0].accepted, true);
  assert.match(renderAutopilotStatus(state), /run-one/);
  assert.throws(() => reserveAutopilotRole(root, DIR, { scope, role: 'implementer' }), /phase|accepted|active|already reserved/i);
}));

test('a changed valid journal prefix fails reservation verification', () => fixture((root) => {
  start(root);
  appendAutopilotEvent(root, DIR, { event: 'PHASE_RESERVED', scope });
  reserveAutopilotRole(root, DIR, { scope, role: 'implementer' });
  const path = `${DIR}/autopilot-events.jsonl`;
  const journalBytes = readWorkPath(root, path, { family: 'autopilot-events' });
  const changed = journalBytes.toString('utf8').replace('"phase":"implement"', '"phase":"review"');
  assert.notEqual(changed, journalBytes.toString('utf8'));
  writeWorkPath(root, path, changed, { family: 'autopilot-events' });
  assert.throws(() => readAutopilotRun(root, DIR), /prefix.*mismatch/i);
}));

test('a reservation without its event remains spent and reconciles only against the exact prefix', () => fixture((root) => {
  start(root);
  reserveAutopilotRole(root, DIR, { scope, role: 'implementer' });
  const path = `${DIR}/autopilot-events.jsonl`;
  const bytes = readWorkPath(root, path, { family: 'autopilot-events' });
  writeWorkPath(root, path, bytes.subarray(0, bytes.indexOf(10) + 1), { family: 'autopilot-events' });
  assert.throws(() => readAutopilotRun(root, DIR), /orphan.*reconciliation/i);
  reconcileAutopilotReservation(root, DIR);
  assert.equal(readAutopilotRun(root, DIR).state.roles.length, 1);
  assert.throws(() => reserveAutopilotRole(root, DIR, { scope, role: 'implementer' }), /active/i);
  const response = '{"status":"DONE"}\n';
  writeWorkPath(root, `${DIR}/role-1-response.json`, response, { createOnly: true, family: 'role-response' });
  assert.deepEqual(readAutopilotRun(root, DIR).pendingResponses, [1]);
  captureAutopilotResponse(root, DIR, 1, response);
  assert.deepEqual(readAutopilotRun(root, DIR).pendingResponses, []);
}));

test('one correction reserves a new role identity while retaining the captured original', () => fixture((root) => {
  start(root);
  reserveAutopilotRole(root, DIR, { scope, role: 'task-reviewer' });
  captureAutopilotResponse(root, DIR, 1, '{}\n');
  const correction = reserveAutopilotRole(root, DIR, { scope, role: 'task-review-correction', correctionOf: 1 });
  assert.equal(correction.roleSequence, 2);
  const state = readAutopilotRun(root, DIR).state;
  assert.equal(state.roles[0].superseded, true);
  assert.equal(state.roles[1].correctionOf, 1);
  assert.throws(() => reserveAutopilotRole(root, DIR, { scope, role: 'task-review-correction', correctionOf: 1 }), /active|already reserved/i);
}));

test('invalid and truncated journal prefixes refuse replay and cannot rebaseline a reservation', () => fixture((root) => {
  start(root);
  const reservation = reserveAutopilotRole(root, DIR, { scope, role: 'implementer' });
  assert.throws(() => reserveAutopilotRole(root, DIR, { scope, role: 'implementer' }), /active|reserved|exists/i);
  const bytes = readWorkPath(root, `${DIR}/autopilot-events.jsonl`, { family: 'autopilot-events' });
  assert.throws(() => parseAutopilotJsonl(bytes.subarray(0, bytes.length - 1)), /journal|jsonl|newline/i);
  writeWorkPath(root, `${DIR}/autopilot-events.jsonl`, bytes.subarray(1), { family: 'autopilot-events' });
  assert.throws(() => readAutopilotRun(root, DIR), /journal|sequence|prefix|JSON/i);
  assert.equal(reservation.roleSequence, 1);
}));

test('immutable run and role identities reject collisions', () => fixture((root) => {
  start(root);
  assert.throws(() => start(root), /exists/i);
  reserveAutopilotRole(root, DIR, { scope, role: 'implementer' });
  assert.throws(() => reserveAutopilotRole(root, DIR, { scope, role: 'implementer' }), /active|reserved|exists/i);
}));

test('status is a replaceable projection and never becomes a replay input', () => fixture((root) => {
  start(root);
  const eventPath = `${DIR}/autopilot-events.jsonl`;
  const before = readWorkPath(root, eventPath, { family: 'autopilot-events' });
  writeWorkPath(root, `${DIR}/autopilot-status.md`, '# stale\n', { family: 'status' });
  assert.equal(readAutopilotRun(root, DIR).state.status, 'RUNNING');
  projectAutopilotStatus(root, DIR);
  assert.match(readWorkPath(root, `${DIR}/autopilot-status.md`, { family: 'status' }).toString(), /Status: RUNNING/u);
  assert.deepEqual(readWorkPath(root, eventPath, { family: 'autopilot-events' }), before);
}));

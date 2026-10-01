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
const planScope = { phase: 'plan', attempt: 1, task: null, iteration: 1 };
const reviewScope = { phase: 'review', attempt: 1, task: 1, iteration: 1 };
const finalScope = { phase: 'final-review', attempt: 1, task: null, iteration: 1 };

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
  acceptAutopilotResult(root, DIR, 1, { path: receiptPath, digest: sha(Buffer.from('{"ok":true}\n')) }, {
    verifyReceipt: (bytes, _path, invocation) => JSON.parse(bytes).ok === true
      ? { ...invocation, accepted: true } : null,
  });
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
  reserveAutopilotRole(root, DIR, { scope: reviewScope, role: 'task-reviewer' });
  captureAutopilotResponse(root, DIR, 1, '{}\n');
  const correction = reserveAutopilotRole(root, DIR, { scope: reviewScope, role: 'task-review-correction', correctionOf: 1 });
  assert.equal(correction.roleSequence, 2);
  const state = readAutopilotRun(root, DIR).state;
  assert.equal(state.roles[0].superseded, true);
  assert.equal(state.roles[1].correctionOf, 1);
  assert.throws(() => reserveAutopilotRole(root, DIR, { scope: reviewScope, role: 'task-review-correction', correctionOf: 1 }), /active|already reserved/i);
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

test('plan and reviewer roles accept their own exact evidence with invocation proof', () => fixture((root) => {
  start(root);
  const planPath = '.apex/work/plans/2026-10-01-autopilot-test.md';
  reserveAutopilotRole(root, DIR, { scope: planScope, role: 'plan' });
  captureAutopilotResponse(root, DIR, 1, '{}\n');
  writeWorkPath(root, planPath, '# Plan\n', { createOnly: true, family: 'plan' });
  acceptAutopilotResult(root, DIR, 1, { path: planPath, digest: sha(Buffer.from('# Plan\n')) },
    { verifyReceipt: (_bytes, _path, invocation) => ({ ...invocation, accepted: true }) });
  const planReceipt = JSON.parse(readWorkPath(root, `${DIR}/role-1-receipt.json`, { family: 'role-receipt' }));
  assert.equal(planReceipt.sourcePath, planPath);
  assert.equal(planReceipt.sourceDigest, sha(Buffer.from('# Plan\n')));
  writeWorkPath(root, planPath, '# Plan READY\n', { family: 'plan' });
  assert.equal(readAutopilotRun(root, DIR).state.roles[0].accepted, true);
  const guardPath = `${DIR}/task-1-review-guard-attempt-1-iteration-1-original.json`;
  reserveAutopilotRole(root, DIR, { scope: reviewScope, role: 'task-reviewer', expectedReceiptPath: guardPath });
  captureAutopilotResponse(root, DIR, 2, '{}\n');
  writeWorkPath(root, guardPath, '{"accepted":true}\n', { createOnly: true, family: 'review-guard' });
  acceptAutopilotResult(root, DIR, 2, { path: guardPath, digest: sha(Buffer.from('{"accepted":true}\n')) },
    { verifyReceipt: (_bytes, _path, invocation) => ({ ...invocation, accepted: true }) });
  assert.equal(readAutopilotRun(root, DIR).state.roles.every((role) => role.accepted), true);
}));

test('whole-branch review and final reviewer use their existing evidence families', () => fixture((root) => {
  start(root);
  const wholeReview = { phase: 'review', attempt: 1, task: null, iteration: 1 };
  const reviewPath = `${DIR}/review-report.md`;
  reserveAutopilotRole(root, DIR, { scope: wholeReview, role: 'review' });
  captureAutopilotResponse(root, DIR, 1, '{}\n');
  writeWorkPath(root, reviewPath, '# Review DRAFT\n', { createOnly: true, family: 'review-report' });
  const reviewDigest = sha(Buffer.from('# Review DRAFT\n'));
  assert.throws(() => acceptAutopilotResult(root, DIR, 1, { path: reviewPath, digest: reviewDigest },
    { verifyReceipt: () => true }), /semantic proof/i);
  assert.throws(() => acceptAutopilotResult(root, DIR, 1, { path: reviewPath, digest: reviewDigest },
    { verifyReceipt: (_bytes, _path, invocation) => ({ ...invocation, runId: 'foreign-run', accepted: true }) }), /semantic proof/i);
  acceptAutopilotResult(root, DIR, 1, { path: reviewPath, digest: reviewDigest },
    { verifyReceipt: (_bytes, _path, invocation) => ({ ...invocation, accepted: true }) });
  writeWorkPath(root, reviewPath, '# Review READY\n', { family: 'review-report' });
  assert.equal(readAutopilotRun(root, DIR).state.roles[0].accepted, true);
  const finalPath = `${DIR}/final-review-guard-attempt-1-iteration-1-original.json`;
  reserveAutopilotRole(root, DIR, { scope: finalScope, role: 'final-review' });
  captureAutopilotResponse(root, DIR, 2, '{}\n');
  writeWorkPath(root, finalPath, '{"approved":true}\n', { createOnly: true, family: 'review-guard' });
  acceptAutopilotResult(root, DIR, 2, { path: finalPath, digest: sha(Buffer.from('{"approved":true}\n')) },
    { verifyReceipt: (_bytes, _path, invocation) => ({ ...invocation, accepted: true }) });
  assert.equal(readAutopilotRun(root, DIR).state.roles.every((role) => role.accepted), true);
}));

test('reviewer evidence from another task or iteration cannot serve this invocation', () => fixture((root) => {
  start(root);
  reserveAutopilotRole(root, DIR, { scope: reviewScope, role: 'task-reviewer' });
  captureAutopilotResponse(root, DIR, 1, '{}\n');
  for (const path of [
    `${DIR}/task-2-review-guard-attempt-1-iteration-1-original.json`,
    `${DIR}/task-1-review-guard-attempt-1-iteration-2-original.json`,
  ]) {
    writeWorkPath(root, path, '{}\n', { createOnly: true, family: 'review-guard' });
    assert.throws(() => acceptAutopilotResult(root, DIR, 1, { path, digest: sha(Buffer.from('{}\n')) },
      { verifyReceipt: () => true }), /receipt.*invocation/i);
  }
}));

test('phase receipt substitution and forged role binding fail replay even with a matching event digest', () => fixture((root) => {
  start(root);
  reserveAutopilotRole(root, DIR, { scope: planScope, role: 'plan' });
  captureAutopilotResponse(root, DIR, 1, '{}\n');
  const sourcePath = '.apex/work/plans/2026-10-01-autopilot-test.md';
  writeWorkPath(root, sourcePath, '# Draft\n', { createOnly: true, family: 'plan' });
  acceptAutopilotResult(root, DIR, 1, { path: sourcePath, digest: sha(Buffer.from('# Draft\n')) },
    { verifyReceipt: (_bytes, _path, invocation) => ({ ...invocation, accepted: true }) });
  const receiptPath = `${DIR}/role-1-receipt.json`;
  const valid = readWorkPath(root, receiptPath, { family: 'role-receipt' });
  const forged = Buffer.from(`${JSON.stringify({ ...JSON.parse(valid), role: 'review' })}\n`);
  writeWorkPath(root, receiptPath, forged, { family: 'role-receipt' });
  assert.throws(() => readAutopilotRun(root, DIR), /digest mismatch/i);
  const eventsPath = `${DIR}/autopilot-events.jsonl`;
  const events = readWorkPath(root, eventsPath, { family: 'autopilot-events' }).toString().trimEnd().split('\n').map((line) => JSON.parse(line));
  events.at(-1).receiptDigest = sha(forged);
  writeWorkPath(root, eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, { family: 'autopilot-events' });
  assert.throws(() => readAutopilotRun(root, DIR), /phase receipt invocation mismatch/i);
}));

test('writer acceptance refuses a different execution receipt even for the same task', () => fixture((root) => {
  start(root);
  const own = `${DIR}/task-1-execution-1-result.json`;
  const other = `${DIR}/task-1-execution-2-result.json`;
  reserveAutopilotRole(root, DIR, { scope, role: 'implementer', expectedReceiptPath: own });
  captureAutopilotResponse(root, DIR, 1, '{}\n');
  writeWorkPath(root, other, '{"accepted":true}\n', { createOnly: true, family: 'task-result' });
  assert.throws(() => acceptAutopilotResult(root, DIR, 1,
    { path: other, digest: sha(Buffer.from('{"accepted":true}\n')) }, { verifyReceipt: () => true }), /receipt|binding|expected/i);
}));

test('correction must match reviewer role and exact scope; superseded response cannot be accepted', () => fixture((root) => {
  start(root);
  const guardPath = `${DIR}/task-1-review-guard-attempt-1-iteration-1-original.json`;
  reserveAutopilotRole(root, DIR, { scope: reviewScope, role: 'task-reviewer', expectedReceiptPath: guardPath });
  captureAutopilotResponse(root, DIR, 1, '{}\n');
  assert.throws(() => reserveAutopilotRole(root, DIR, { scope: { ...reviewScope, task: 2 }, role: 'task-review-correction', correctionOf: 1,
    expectedReceiptPath: `${DIR}/task-2-review-guard-attempt-1-iteration-1-corrected.json` }), /scope|correction/i);
  assert.throws(() => reserveAutopilotRole(root, DIR, { scope: reviewScope, role: 'fix', correctionOf: 1,
    expectedReceiptPath: `${DIR}/task-1-execution-2-result.json` }), /role|correction/i);
  reserveAutopilotRole(root, DIR, { scope: reviewScope, role: 'task-review-correction', correctionOf: 1,
    expectedReceiptPath: `${DIR}/task-1-review-guard-attempt-1-iteration-1-corrected.json` });
  writeWorkPath(root, guardPath, '{"accepted":true}\n', { createOnly: true, family: 'review-guard' });
  assert.throws(() => acceptAutopilotResult(root, DIR, 1,
    { path: guardPath, digest: sha(Buffer.from('{"accepted":true}\n')) }, { verifyReceipt: () => true }), /superseded|correction/i);
}));

test('final-review correction requires the final-review-correction role', () => fixture((root) => {
  start(root);
  reserveAutopilotRole(root, DIR, { scope: finalScope, role: 'final-review',
    expectedReceiptPath: `${DIR}/final-review-guard-attempt-1-iteration-1-original.json` });
  captureAutopilotResponse(root, DIR, 1, '{}\n');
  assert.throws(() => reserveAutopilotRole(root, DIR, { scope: finalScope, role: 'task-review-correction', correctionOf: 1,
    expectedReceiptPath: `${DIR}/final-review-guard-attempt-1-iteration-1-corrected.json` }), /correction|role/i);
}));

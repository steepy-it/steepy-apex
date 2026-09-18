import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeReviewerResponse, serializeReviewerResponse, reviewerResponseSchema } from '../adapters/reviewer-response.mjs';

test('JSON responses use the shipped reviewer schema and serialize without normalization', () => {
  const result = { signals: 'review:clean', 'changed-paths': 'none', artifact: 'report.md', status: 'APPROVED' };
  assert.equal(serializeReviewerResponse(result), 'status: APPROVED\nartifact: report.md\nchanged-paths: none\nsignals: review:clean\n');
  assert.equal(reviewerResponseSchema().properties['changed-paths'].const, 'none');
  assert.equal(decodeReviewerResponse(JSON.stringify(result), 'json').status, 'APPROVED');
  for (const invalid of [{ ...result, 'changed-paths': 'report.md' }, { ...result, status: 'DONE' }, { ...result, extra: 'x' }, { ...result, signals: '' }]) {
    assert.throws(() => serializeReviewerResponse(invalid));
  }
  assert.throws(() => decodeReviewerResponse('{}', 'xml'));
});


test('JSON transport rejects duplicate and escaped duplicate verdict keys', () => {
  for (const key of ['status', '\\u0073tatus']) {
    const text = `{"status":"ISSUES_FOUND","${key}":"APPROVED","artifact":"report.md","changed-paths":"none","signals":"none"}`;
    assert.throws(() => decodeReviewerResponse(text, 'json'), /duplicate/);
  }
});

test('v2 reviewer transport accepts semantic fields and retains legacy path telemetry literally', () => {
  const text = 'status: APPROVED\nartifact: report.md\nsignals: none\n';
  assert.equal(decodeReviewerResponse(text, 'text', { protocol: 2 }).status, 'APPROVED');
  const legacy = text.replace('signals:', 'changed-paths: apps/(protected)/[id]/{page.tsx,page.test.tsx}\nsignals:');
  assert.equal(decodeReviewerResponse(legacy, 'text', { protocol: 2 })['changed-paths'], 'apps/(protected)/[id]/{page.tsx,page.test.tsx}');
  assert.deepEqual(reviewerResponseSchema(2).required, ['status', 'artifact', 'signals']);
  assert.throws(() => decodeReviewerResponse(text + 'extra: no\n', 'text', { protocol: 2 }));
});

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

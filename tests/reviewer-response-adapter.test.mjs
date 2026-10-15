import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { decodeReviewerResponse, serializeReviewerResponse, reviewerResponseSchema } from '../adapters/reviewer-response.mjs';

test('JSON responses use the shipped reviewer schema and serialize without normalization', () => {
  const result = { signals: 'review:clean', artifact: 'report.md', status: 'APPROVED' };
  assert.equal(serializeReviewerResponse(result), 'status: APPROVED\nartifact: report.md\nsignals: review:clean\n');
  assert.deepEqual(reviewerResponseSchema().required, ['status', 'artifact', 'signals']);
  assert.equal(decodeReviewerResponse(JSON.stringify(result), 'json').status, 'APPROVED');
  for (const invalid of [{ ...result, 'changed-paths': 'none' }, { ...result, status: 'DONE' }, { ...result, extra: 'x' }, { ...result, signals: '' }]) {
    assert.throws(() => serializeReviewerResponse(invalid));
  }
  assert.throws(() => decodeReviewerResponse('{}', 'xml'));
});


test('JSON transport rejects duplicate and escaped duplicate verdict keys', () => {
  for (const key of ['status', '\\u0073tatus']) {
    const text = `{"status":"ISSUES_FOUND","${key}":"APPROVED","artifact":"report.md","signals":"none"}`;
    assert.throws(() => decodeReviewerResponse(text, 'json'), /duplicate/);
  }
});

test('reviewer transport accepts exactly status, artifact, signals and rejects changed-paths in text and JSON', () => {
  const text = 'status: APPROVED\nartifact: report.md\nsignals: none\n';
  assert.equal(decodeReviewerResponse(text, 'text').status, 'APPROVED');
  const withPaths = text.replace('signals:', 'changed-paths: none\nsignals:');
  assert.throws(() => decodeReviewerResponse(withPaths, 'text'), /expected ordered reviewer semantic fields/);
  const json = { status: 'APPROVED', artifact: 'report.md', 'changed-paths': 'none', signals: 'none' };
  assert.throws(() => decodeReviewerResponse(JSON.stringify(json), 'json'), /invalid reviewer response fields/);
  assert.throws(() => reviewerResponseSchema(1), /unsupported reviewer response protocol/);
  assert.equal(existsSync(new URL('../skills/implement/reviewer-response.schema.json', import.meta.url)), false);
  assert.throws(() => decodeReviewerResponse(text + 'extra: no\n', 'text'));
});

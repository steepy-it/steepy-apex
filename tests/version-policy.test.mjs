import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compareVersions, validateVersionTransition } from '../scripts/version-policy.mjs';

test('normal versions are strict safe-integer numeric triplets', () => {
  assert.deepEqual(parseVersion('10.20.300'), [10, 20, 300]);
  assert.deepEqual(parseVersion('0.0.0'), [0, 0, 0]);
  assert.deepEqual(parseVersion('9007199254740991.0.0'), [Number.MAX_SAFE_INTEGER, 0, 0]);
  for (const value of [null, 123, ['1.2.3'], '', '1.2', 'v1.2.3', '1.2.3-beta', '1.2.3+build',
    '01.2.3', '1.02.3', '1.2.03', '1.2.3\n', ' 1.2.3', '1.2.-3', '9007199254740992.0.0']) {
    assert.throws(() => parseVersion(value), /invalid version/, JSON.stringify(value));
  }
});

test('version precedence compares every component numerically', () => {
  for (const [before, after] of [['1.2.9', '1.2.10'], ['1.9.99', '1.10.0'], ['9.99.99', '10.0.0']]) {
    assert.equal(compareVersions(after, before), 1);
    assert.equal(compareVersions(before, after), -1);
    assert.equal(compareVersions(before, before), 0);
  }
});

test('required transitions reject equal versions and downgrades', () => {
  assert.equal(validateVersionTransition('1.2.10', '1.2.9'), 1);
  assert.throws(() => validateVersionTransition('1.2.9', '1.2.9'), /increase/);
  assert.throws(() => validateVersionTransition('1.2.8', '1.2.9'), /downgrade/);
});

test('no-release exemption permits equality but never invalidity or downgrade', () => {
  assert.equal(validateVersionTransition('1.2.3', '1.2.3', { requireIncrement: false }), 0);
  for (const [head, base] of [['01.2.3', '1.2.3'], ['1.2.3', '1.02.3'], ['1.2.2', '1.2.3']]) {
    assert.throws(() => validateVersionTransition(head, base, { requireIncrement: false }), /invalid|downgrade/);
  }
});

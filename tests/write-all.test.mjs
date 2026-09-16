import assert from 'node:assert/strict';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { writeAllSync } from '../scripts/write-all.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'steepy-write-all-'));
  return { dir, path: join(dir, 'output.bin') };
}

test('writeAllSync persists every byte across positive short writes', () => {
  const { dir, path } = fixture();
  const fd = openSync(path, 'wx', 0o600);
  const bytes = Buffer.from('complete output across short writes', 'utf8');
  const calls = [];
  try {
    const accepted = writeAllSync(fd, bytes, (targetFd, buffer, offset, length) => {
      const requested = Math.min(length, 3);
      calls.push({ offset, length, requested });
      return writeSync(targetFd, buffer, offset, requested);
    });

    assert.equal(accepted, bytes.length);
    assert.ok(calls.length > 1);
    assert.deepEqual(readFileSync(path), bytes);
    assert.deepEqual(calls.map(({ offset }) => offset), calls.map((_, index) => index * 3));
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeAllSync rejects non-progress and invalid byte counts', () => {
  const bytes = Buffer.from('abcd', 'utf8');
  for (const count of [0, -1, 1.5, 5, true, undefined]) {
    assert.throws(
      () => writeAllSync(123, bytes, () => count),
      /invalid write count/u,
      String(count),
    );
  }
});

test('writeAllSync propagates a write error after an accepted prefix', () => {
  const { dir, path } = fixture();
  const fd = openSync(path, 'wx', 0o600);
  const bytes = Buffer.from('prefix-and-failure', 'utf8');
  let calls = 0;
  try {
    assert.throws(
      () => writeAllSync(fd, bytes, (targetFd, buffer, offset, length) => {
        calls += 1;
        if (calls === 2) throw new Error('injected write failure');
        return writeSync(targetFd, buffer, offset, Math.min(length, 6));
      }),
      /injected write failure/u,
    );
    assert.equal(readFileSync(path, 'utf8'), 'prefix');
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runManagedHeadlessDescriptor } from '../scripts/headless-runner.mjs';

const RUN = '12345678-1234-4234-8234-123456789abc';
const rawPath = `.apex/work/loops/2026-09-03-demo-loop/run-${RUN}-attempt-1.raw.jsonl`;
const readablePath = `.apex/work/loops/2026-09-03-demo-loop/run-${RUN}-attempt-1.log`;
const quiet = { write(_chunk, callback) { callback?.(); return true; } };

function withRepo(fn) {
  const repo = mkdtempSync(join(tmpdir(), 'steepy-headless-runner-'));
  return Promise.resolve().then(() => fn(repo)).finally(() => rmSync(repo, { recursive: true, force: true }));
}

function run(repo, script, options = {}) {
  return runManagedHeadlessDescriptor(
    { cmd: process.execPath, args: ['-e', script] }, 'codex', repo,
    { rawPath, readablePath, liveStdout: quiet, liveStderr: quiet, ...options },
  );
}

test('direct runner separates process exit, terminal response, and durable capture', () => withRepo(async (repo) => {
  const script = [
    "process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'status: DONE'}})+'\\n');",
    "process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n');",
  ].join('');
  const result = await run(repo, script);
  assert.deepEqual(result.process, { status: 0, signal: null });
  assert.equal(result.transport.error, null);
  assert.equal(result.terminal.payload, 'status: DONE');
  assert.equal(result.terminal.reason, null);
  assert.deepEqual(result.capture, { persisted: true, error: null });
  assert.match(readFileSync(join(repo, rawPath), 'utf8'), /turn\.completed/u);
}));

test('zero exit without a terminal is distinct from transport success', () => withRepo(async (repo) => {
  const result = await run(repo, "process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'abc'})+'\\n');");
  assert.equal(result.process.status, 0);
  assert.equal(result.transport.error, null);
  assert.equal(result.terminal.payload, null);
  assert.equal(result.terminal.reason, 'missing-terminal');
  assert.equal(result.capture.persisted, true);
}));

test('short raw writes retry, while an invalid write count blocks capture', () => withRepo(async (repo) => {
  let calls = 0;
  const script = "process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n');";
  const first = await run(repo, script, {
    rawWrite(fd, bytes, offset, length) {
      const count = Math.min(length, 2);
      calls++;
      return writeSync(fd, bytes, offset, count);
    },
  });
  assert.equal(first.capture.persisted, true);
  assert.equal(first.transport.error, null);
  assert.ok(calls > 1);
  assert.match(readFileSync(join(repo, rawPath), 'utf8'), /turn\.completed/u);
}));

test('invalid raw write count blocks transport and capture even after a zero exit', () => withRepo(async (repo) => {
  const script = "process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n');";
  const result = await run(repo, script, { rawWrite() { return 0; } });
  assert.equal(result.capture.persisted, false);
  assert.match(result.capture.error?.message ?? '', /invalid write count/u);
  assert.match(result.transport.error?.message ?? '', /invalid write count/u);
  assert.equal(result.terminal.payload, null);
}));

test('runner refuses a confined work artifact that is not a raw log', () => withRepo(async (repo) => {
  const planPath = '.apex/work/plans/unrelated.md';
  const result = await run(repo, 'process.exit(0)', { rawPath: planPath });
  assert.equal(result.process.status, null);
  assert.equal(result.capture.persisted, false);
  assert.match(result.capture.error?.message ?? '', /admitted raw log/u);
}));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const hook = join(root, 'scripts', 'stop-hook.mjs');
const goodHub = join(root, 'tests', 'fixtures', 'good-hub');
const badHub = join(root, 'tests', 'fixtures', 'bad-hub');

function run(args, stdin = '', timeout) {
  return spawnSync(process.execPath, [hook, ...args], { input: stdin, encoding: 'utf8', timeout });
}

function storageAliasesCase(directory) {
  const lower = join(directory, 'steepy-case-probe');
  mkdirSync(lower);
  try {
    const canonical = lstatSync(lower, { bigint: true });
    const alias = lstatSync(join(directory, 'STEEPY-CASE-PROBE'), { bigint: true });
    return canonical.dev === alias.dev && canonical.ino === alias.ino;
  } catch {
    return false;
  }
}

test('green hub: silent, exit 0', () => {
  const r = run([goodHub], '{}');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});

test('no .apex hub: silent, exit 0', () => {
  const r = run([join(root, 'tests', 'fixtures', 'single-pkg')], '{}');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});

test('violations + not in a stop loop: emits a block decision, exit 0', () => {
  const r = run([badHub], '{"stop_hook_active": false}');
  assert.equal(r.status, 0);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.decision, 'block');
  assert.match(payload.reason, /validate-hub|violation/i);
});

test('violations + stop_hook_active true: does NOT block (loop guard)', () => {
  const r = run([badHub], '{"stop_hook_active": true}');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '', 'must not emit a block decision while already in a stop loop');
});

test('crash on a missing module is fail-safe (non-zero, never exit 2)', () => {
  const bogus = join(root, 'no-such-root', 'scripts', 'stop-hook.mjs');
  const r = spawnSync(process.execPath, [bogus, '.'], { input: '{}', encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.notEqual(r.status, 2);
});

test('a non-ordinary root index blocks without hanging the Stop hook', {
  skip: !['darwin', 'linux'].includes(process.platform),
}, () => {
  const repo = mkdtempSync(join(tmpdir(), 'steepy-stop-fifo-'));
  mkdirSync(join(repo, '.apex'));
  const fifo = join(repo, '.apex', '_INDEX.md');
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);

  const r = run([repo], '{}', 2_000);
  assert.notEqual(r.error?.code, 'ETIMEDOUT');
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.decision, 'block');
  assert.match(payload.reason, /stable-read: \.apex\/_INDEX\.md is non-file/i);
});

test('an unreadable portable namespace is a controlled Stop-hook block payload', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, () => {
  const repo = mkdtempSync(join(tmpdir(), 'steepy-stop-unreadable-namespace-'));
  mkdirSync(join(repo, '.apex'));
  mkdirSync(join(repo, '.opencode', 'nested'), { recursive: true });
  writeFileSync(join(repo, '.apex', '_INDEX.md'), '# Index\n');
  const nested = join(repo, '.opencode', 'nested');
  chmodSync(nested, 0o000);
  try {
    const r = run([repo], '{}', 2_000);
    assert.notEqual(r.error?.code, 'ETIMEDOUT');
    assert.equal(r.status, 0, r.stderr);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.decision, 'block');
    assert.match(payload.reason, /stable-read: \.opencode\/nested is unreadable/i);
    assert.doesNotMatch(r.stderr, /at .*validate-hub\.mjs/i);
  } finally {
    chmodSync(nested, 0o700);
  }
});

test('a non-ordinary package manifest blocks without hanging the Stop hook', {
  skip: !['darwin', 'linux'].includes(process.platform),
}, () => {
  const repo = mkdtempSync(join(tmpdir(), 'steepy-stop-package-fifo-'));
  mkdirSync(join(repo, '.apex', 'standards'), { recursive: true });
  writeFileSync(join(repo, '.apex', '_INDEX.md'), '# Index\n- [Web](standards/web.md)\n');
  writeFileSync(join(repo, '.apex', 'standards', 'web.md'), [
    '# web — Technical Standard',
    '',
    '## Testing',
    '',
    '```sh',
    'npm test',
    '```',
    '',
  ].join('\n'));
  const fifo = join(repo, 'package.json');
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);

  const r = run([repo], '{}', 2_000);
  assert.notEqual(r.error?.code, 'ETIMEDOUT');
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.decision, 'block');
  assert.match(payload.reason, /stable-read: package\.json is non-file/i);
});

test('a case alias into reserved work emits a Stop-hook block without consuming it', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'steepy-stop-work-case-alias-'));
  if (!storageAliasesCase(repo)) {
    t.skip('temporary storage keeps case-distinct directory identities');
    return;
  }
  mkdirSync(join(repo, '.apex', 'work'), { recursive: true });
  writeFileSync(join(repo, '.apex', '_INDEX.md'), '# Index\n- [Hidden](WORK/sentinel.md)\n');
  writeFileSync(join(repo, '.apex', 'work', 'sentinel.md'), '# STOP_WORK_BYTE_SENTINEL\n');

  const r = run([repo], '{}', 2_000);
  assert.notEqual(r.error?.code, 'ETIMEDOUT');
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.decision, 'block');
  assert.match(payload.reason, /enters excluded \.apex\/work|stable docs must not link into \.apex\/work/i);
  assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /STOP_WORK_BYTE_SENTINEL/u);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInitialInceptionState, serializeInceptionState } from '../scripts/inception-state.mjs';

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

const RUN = '0b6f1b8e-3c1a-4e2b-9f3d-5a7c9e1b2d4f';
const HOOK_SENTINEL = 'STOP_HOOK_LOCAL_BODY_SENTINEL';

function put(repo, path, text) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

// A guarded pre-init descriptor with a local run document the hook never reads.
function inceptionRepo(suffix, overrides = {}) {
  const repo = mkdtempSync(join(tmpdir(), `steepy-stop-prehub-${suffix}-`));
  put(repo, '.apex/inception/.gitignore', '*\n');
  put(repo, `.apex/inception/${RUN}/proposal.md`, `# ${HOOK_SENTINEL}\n`);
  put(repo, '.apex/inception/state.json', serializeInceptionState({ ...createInitialInceptionState(RUN), ...overrides }));
  return repo;
}

test('a recognized pre-hub inception keeps the Stop hook silent', () => {
  const repo = inceptionRepo('valid');
  try {
    put(repo, 'AGENTS.md', '# User notes\n');
    const r = run([repo], '{}', 2_000);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('init in progress without an index, and a partial hub beside a pre-init descriptor, block the turn', () => {
  const approval = { path: `.apex/inception/${RUN}/proposal.md`, sha256: 'a'.repeat(64) };
  for (const [label, arrange, reason] of [
    ['init in progress', () => inceptionRepo('init', {
      phase: 'init', approval, init: { status: 'in-progress', handoff: null, receipt: null },
    }), /inception: init is in-progress/u],
    ['partial hub', () => {
      const repo = inceptionRepo('partial');
      put(repo, '.apex/conventions.md', '# Conventions\n');
      return repo;
    }, /incompatible with hub artifact \.apex\/conventions\.md/u],
    ['unknown state', () => {
      const repo = inceptionRepo('unknown');
      put(repo, '.apex/inception/state.json', `${JSON.stringify({ ...createInitialInceptionState(RUN), schemaVersion: 7 }, null, 2)}\n`);
      return repo;
    }, /pre-hub state not recognized \(invalid\)/u],
  ]) {
    // Each fixture is created inside its own iteration so `finally` always
    // removes the repository it made, even if an earlier case fails.
    const repo = arrange();
    try {
      const blocked = run([repo], '{}', 2_000);
      assert.equal(blocked.status, 0, `${label}: ${blocked.stderr}`);
      const payload = JSON.parse(blocked.stdout);
      assert.equal(payload.decision, 'block', label);
      assert.match(payload.reason, /missing _INDEX\.md/u, label);
      assert.match(payload.reason, reason, label);
      assert.doesNotMatch(`${blocked.stdout}\n${blocked.stderr}`, new RegExp(HOOK_SENTINEL, 'u'), label);

      const looping = run([repo], '{"stop_hook_active": true}', 2_000);
      assert.equal(looping.status, 0, label);
      assert.equal(looping.stdout, '', label);
      assert.match(looping.stderr, reason, label);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('an unfinished start and an activated hub without its index block the turn; neither is a pre-hub', () => {
  const approval = { path: `.apex/inception/${RUN}/proposal.md`, sha256: 'a'.repeat(64) };
  const complete = {
    phase: 'complete', status: 'complete', approval,
    init: { status: 'complete', handoff: { path: `.apex/inception/${RUN}/init-handoff.json`, sha256: 'b'.repeat(64) },
      receipt: { path: `.apex/inception/${RUN}/init-receipt.json`, sha256: 'c'.repeat(64) } },
  };
  for (const [label, arrange, reason] of [
    ['start stopped before its descriptor', () => {
      const repo = inceptionRepo('unfinished');
      rmSync(join(repo, '.apex', 'inception', 'state.json'));
      return repo;
    }, /pre-hub state not recognized \(incomplete\)/u],
    ['activated hub whose index was removed', () => {
      const repo = inceptionRepo('activated', complete);
      put(repo, 'AGENTS.md', '# User notes\n');
      put(repo, '.apex/standards/app.md', '# app — Technical Standard\n');
      return repo;
    }, /inception: init is complete; an activated hub requires \.apex\/_INDEX\.md/u],
  ]) {
    const repo = arrange();
    try {
      const blocked = run([repo], '{}', 2_000);
      assert.equal(blocked.status, 0, `${label}: ${blocked.stderr}`);
      const payload = JSON.parse(blocked.stdout);
      assert.equal(payload.decision, 'block', label);
      assert.match(payload.reason, /missing _INDEX\.md/u, label);
      assert.match(payload.reason, reason, label);
      assert.doesNotMatch(`${blocked.stdout}\n${blocked.stderr}`, new RegExp(HOOK_SENTINEL, 'u'), label);
      if (label.startsWith('activated')) {
        put(repo, '.apex/_INDEX.md', '# Index\n- [App](standards/app.md)\n');
        const restored = run([repo], '{}', 2_000);
        assert.deepEqual([restored.status, restored.stdout], [0, ''], `${label}: the restored hub is silent again`);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('an operational hub with malformed local inception state stays silent', () => {
  const repo = inceptionRepo('hub');
  try {
    put(repo, '.apex/inception/state.json', '{');
    put(repo, '.apex/_INDEX.md', '# Index\n');
    const r = run([repo], '{}', 2_000);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

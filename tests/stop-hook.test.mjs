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

// Inception area mirror of the reserved-work case-alias block above. The
// temporary root is resolved with realpathSync and removed in `finally`.
import { realpathSync, rmSync } from 'node:fs';

test('a case alias into the inception area emits a Stop-hook block without consuming it', (t) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'steepy-stop-inception-case-alias-')));
  try {
    if (!storageAliasesCase(repo)) {
      t.skip('temporary storage keeps case-distinct directory identities');
      return;
    }
    mkdirSync(join(repo, '.apex', 'inception'), { recursive: true });
    writeFileSync(join(repo, '.apex', '_INDEX.md'), '# Index\n- [Hidden](INCEPTION/sentinel.md)\n');
    writeFileSync(
      join(repo, '.apex', 'inception', 'sentinel.md'),
      '# Hidden\n[Sentinel](STOP_INCEPTION_BYTE_SENTINEL.md)\n',
    );

    const r = run([repo], '{}', 2_000);
    assert.notEqual(r.error?.code, 'ETIMEDOUT');
    assert.equal(r.status, 0, r.stderr);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.decision, 'block');
    assert.match(payload.reason, /enters excluded \.apex\/inception/i);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /STOP_INCEPTION_BYTE_SENTINEL/u);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// Pre-hub inception state: `.apex/` holds the inception area but no `_INDEX.md`.
// The hook stays silent for a valid run descriptor and blocks on an unparseable
// one. Each temporary root is resolved with realpathSync and removed in `finally`.
import { createRunDescriptor, serializeRunDescriptor } from '../scripts/inception-state.mjs';

function preHubRepo(suffix, descriptorBytes) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), `steepy-stop-prehub-${suffix}-`)));
  mkdirSync(join(repo, '.apex', 'inception'), { recursive: true });
  writeFileSync(join(repo, '.apex', 'inception', '.gitignore'), '*\n');
  writeFileSync(join(repo, '.apex', 'inception', 'run.json'), descriptorBytes);
  return repo;
}

test('pre-hub: a valid inception run descriptor keeps the Stop hook silent', () => {
  const repo = preHubRepo('valid', serializeRunDescriptor(createRunDescriptor({
    runId: 'inc-20261007T120000Z-1a2b3c4d',
    harnessName: 'claude-code',
    capabilities: ['shell'],
    git: { present: false, branch: null, commits: 'none' },
  })));
  try {
    const r = run([repo], '{}', 2_000);
    assert.notEqual(r.error?.code, 'ETIMEDOUT');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('pre-hub: an unparseable inception run descriptor emits a block naming its path', () => {
  const repo = preHubRepo('invalid', '{ "schema": \n');
  try {
    const r = run([repo], '{}', 2_000);
    assert.notEqual(r.error?.code, 'ETIMEDOUT');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    const payload = JSON.parse(r.stdout);
    assert.deepEqual(payload, {
      decision: 'block',
      reason: [
        'steepy validate-hub: 1 hub violation(s):',
        '  - inception run descriptor .apex/inception/run.json cannot be parsed: run descriptor is not valid JSON',
        'Fix the hub (or run /steepy-apex:check) before ending the turn.',
      ].join('\n'),
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('C7 Stop hook admits a pending archive without a descriptor, then restores missing-index blocking', async () => {
  const { rmSync } = await import('node:fs');
  const repo = mkdtempSync(join(tmpdir(), 'steepy-stop-abandon-'));
  const helper = new URL('../scripts/inception-state.mjs', import.meta.url).href;
  try {
    const crash = spawnSync(process.execPath, ['--input-type=module', '-e', `import {startRun,abandonRun} from ${JSON.stringify(helper)}; startRun(process.argv[1], {harnessName:'codex',gitCommits:'forbidden'}); abandonRun(process.argv[1], {reason:'Stop',fault(p,d){if(p==='after-move'&&d.name==='run.json')process.exit(73);}});`, repo], { encoding: 'utf8' });
    assert.equal(crash.status, 73, crash.stderr);
    let observed = run([repo], '{}'); assert.equal(observed.status, 0); assert.equal(observed.stdout, '');
    const resume = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/inception-state.mjs', import.meta.url)), 'abandon', '--repo-root', repo, '--resume'], { encoding: 'utf8' });
    assert.equal(resume.status, 0, resume.stdout + resume.stderr);
    observed = run([repo], '{}'); assert.equal(observed.status, 0); assert.equal(JSON.parse(observed.stdout).decision, 'block');
    writeFileSync(join(repo, '.apex/inception/abandon-intent.json'), '{}');
    observed = run([repo], '{}'); assert.equal(observed.status, 0); assert.match(JSON.parse(observed.stdout).reason, /abandon/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('pre-hub hook accepts raw legacy active, blocked and complete without treating them as v2 sources', () => {
  for (const status of ['active', 'blocked', 'complete']) {
    const initial = createRunDescriptor({ runId: 'inc-20261007T120000Z-1a2b3c4d', harnessName: 'codex', git: { present: false, branch: null, commits: 'none' } });
    const raw = { schema: 'steepy-inception-run/v1', runId: initial.runId, phase: status === 'complete' ? 'complete' : 'research', status, harness: initial.harness, git: initial.git, nextRecord: 2, approvalEntry: null, approvals: [], checkpoints: status === 'complete' ? ['.apex/inception/checkpoints/0001.json'] : [], resumeNotes: [], finalCheckpoint: status === 'complete' ? '.apex/inception/checkpoints/0001.json' : null, verification: status === 'complete' ? { path: '.apex/inception/verification/results.md', bytes: 1, sha256: 'a'.repeat(64) } : null, history: [] };
    const repo = preHubRepo(`legacy-${status}`, serializeRunDescriptor(raw));
    try { const result = run([repo], '{}', 2_000); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, ''); }
    finally { rmSync(repo, { recursive: true, force: true }); }
  }
});

test('pre-hub hook v2 status matrix stays silent while unknown schema blocks', () => {
  const initial = createRunDescriptor({ runId: 'inc-20261007T120000Z-1a2b3c4d', harnessName: 'codex', git: { present: false, branch: null, commits: 'none' } });
  const ref = path => ({ path, bytes: 1, sha256: 'a'.repeat(64) });
  const cycle = ref('.apex/inception/verification/cycles/0001.json');
  const complete = { ...initial, phase: 'complete', status: 'complete', nextRecord: 4, cycles: [cycle], currentCycle: cycle, baseline: ref('.apex/inception/snapshots/0002.json'), completion: ref('.apex/inception/verification/completions/0003.json') };
  for (const descriptor of [initial, { ...initial, status: 'blocked', blocks: [{ id: 'human', reason: 'Human decision needed', evidence: [] }] }, complete, { ...initial, schema: 'unknown/v99' }]) {
    const repo = preHubRepo('v2-matrix', serializeRunDescriptor(descriptor));
    try { const result = run([repo], '{}', 2_000); assert.equal(result.status, 0, result.stderr); if (descriptor.schema === 'unknown/v99') assert.match(JSON.parse(result.stdout).reason, /schema is unsupported/); else assert.equal(result.stdout, ''); }
    finally { rmSync(repo, { recursive: true, force: true }); }
  }
});

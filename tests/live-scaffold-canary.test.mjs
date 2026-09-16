import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headlessCommand } from '../adapters/headless.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'scripts', 'live-scaffold-canary.mjs');
const credentialNames = {
  claude: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
  opencode: 'OPENCODE_API_KEY',
};

function tempCase() {
  const root = mkdtempSync(join(tmpdir(), 'steepy-live-canary-test-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  return { root, bin, output: join(root, 'report.jsonl'), events: join(root, 'events.jsonl') };
}

function fakeHarness(run, harness, {
  exitCode = 0,
  omitNonce = false,
  emptyVersion = false,
  traceNonces = false,
  reverseNonces = false,
  extraFinalField = false,
} = {}) {
  const path = join(run.bin, harness);
  const source = `#!${process.execPath}
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const harness = ${JSON.stringify(harness)};
const args = process.argv.slice(2);
const eventPath = process.env.STEEPY_CANARY_TEST_EVENTS;
const emit = (event) => appendFileSync(eventPath, JSON.stringify(event) + '\\n');
if (args.length === 1 && args[0] === '--version') {
  emit({ harness, phase: 'version', args, cwd: process.cwd() });
  const secret = process.env[${JSON.stringify(credentialNames[harness])}] ?? '';
  if (!${emptyVersion}) process.stdout.write(harness + ' 9.9.9 secret=' + secret + '\\n');
  process.exit(0);
}
emit({ harness, phase: 'run', args, cwd: process.cwd() });
const bootstrapDir = join(process.cwd(), '.agents', 'skills');
const bootstrapName = readdirSync(bootstrapDir).find((name) => name.endsWith('-bootstrap'));
const adapter = {
  claude: join('.claude', 'agents', 'canary-agent.md'),
  codex: join('.codex', 'agents', 'canary-agent.toml'),
  opencode: join('.opencode', 'agents', 'canary-agent.md'),
}[harness];
const inputs = [
  readFileSync(join(process.cwd(), 'AGENTS.md'), 'utf8'),
  readFileSync(join(bootstrapDir, bootstrapName, 'SKILL.md'), 'utf8'),
  readFileSync(join(process.cwd(), '.apex', 'standards', 'canary.md'), 'utf8'),
  readFileSync(join(process.cwd(), adapter), 'utf8'),
];
const nonces = inputs.map((text) => text.match(/LIVE_CANARY_(?:ROOT|BOOTSTRAP|STANDARD|ADAPTER)_[a-f0-9]+/u)?.[0]);
const secret = process.env[${JSON.stringify(credentialNames[harness])}] ?? '';
const reportedNonces = ${omitNonce} ? nonces.slice(0, 3) : nonces;
if (${traceNonces}) {
  const trace = harness === 'claude'
    ? { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: nonces.join(' ') }] } }
    : harness === 'codex'
      ? { type: 'item.completed', item: { type: 'command_execution', id: 'trace', command: 'read', aggregated_output: nonces.join(' ') } }
      : { type: 'tool_use', part: { type: 'tool', tool: 'read', callID: 'trace', state: { status: 'completed', output: nonces.join(' ') } } };
  process.stdout.write(JSON.stringify(trace) + '\\n');
}
const finalNonces = ${reverseNonces} ? [...reportedNonces].reverse() : reportedNonces;
const finalResponse = JSON.stringify({
  lifecycle: 'complete',
  nonces: finalNonces,
  ...(${extraFinalField} ? { extra: true } : {}),
});
if (harness === 'claude') {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: finalResponse }) + '\\n');
} else if (harness === 'codex') {
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: finalResponse } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: {} }) + '\\n');
} else {
  process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: finalResponse } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } }) + '\\n');
}
process.stderr.write('stderr-token=' + secret + '\\n');
process.exit(${exitCode});
`;
  writeFileSync(path, source, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function runDriver(run, harness, {
  credentials = {}, output = run.output, path = run.bin, extraArgs = [],
} = {}) {
  return spawnSync(process.execPath, [
    script,
    '--harness', harness,
    '--output', output,
    ...extraArgs,
  ], {
    cwd: run.root,
    encoding: 'utf8',
    env: {
      PATH: path,
      TMPDIR: tmpdir(),
      STEEPY_CANARY_TEST_EVENTS: run.events,
      ...credentials,
    },
  });
}

function rows(path) {
  return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function assertEvidenceIdentity(row, harness) {
  assert.deepEqual(Object.keys(row.identity).sort(), [
    'installation', 'payloadSha256', 'productVersion', 'sourceRevision',
  ]);
  assert.match(row.identity.sourceRevision, /^[a-f0-9]{40}$/u);
  assert.match(row.identity.payloadSha256, /^[a-f0-9]{64}$/u);
  assert.match(row.identity.productVersion, /^\d+\.\d+\.\d+$/u);
  assert.deepEqual(row.identity.installation, {
    method: 'canonical-headless-descriptor',
    composition: [`${harness}-cli`, 'scaffold-fixture'],
  });
}

function events(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('all runs only canonical descriptors, proves nonce lifecycle, redacts logs, and stays nonzero', () => {
  const run = tempCase();
  for (const harness of ['claude', 'codex', 'opencode']) fakeHarness(run, harness);
  const secrets = {
    ANTHROPIC_API_KEY: 'anthropic-super-secret-value',
    OPENAI_API_KEY: 'openai-super-secret-value',
    OPENCODE_API_KEY: 'opencode-super-secret-value',
  };

  const result = runDriver(run, 'all', { credentials: secrets });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.signal, null);
  const report = rows(run.output);
  assert.deepEqual(report.map(({ harness }) => harness), [
    'claude', 'codex', 'opencode', 'pi', 'deepseek',
  ]);
  assert.deepEqual(report.map(({ verdict }) => verdict), [
    'PASS', 'PASS', 'PASS', 'NOT RUN', 'NOT RUN',
  ]);
  assert.deepEqual(report.slice(3).map(({ reasonCode }) => reasonCode), [
    'runner-unavailable', 'runner-unavailable',
  ]);
  assert.ok(report.slice(3).every(({ cli, version, durationMs, log }) => (
    cli === null && version === null && durationMs === 0 && log === ''
  )));

  const observed = events(run.events);
  for (const [index, harness] of ['claude', 'codex', 'opencode'].entries()) {
    const lifecycle = observed.filter((event) => event.harness === harness);
    assert.deepEqual(lifecycle.map(({ phase }) => phase), ['version', 'run']);
    assert.deepEqual(lifecycle[0].args, ['--version']);
    assert.equal(existsSync(lifecycle[1].cwd), false, 'fixture must be cleaned in finally');

    const row = report[index];
    assert.equal(row.schemaVersion, 1);
    assertEvidenceIdentity(row, harness);
    assert.deepEqual(row.capabilities, [{
      capability: 'descriptor-nonce-response',
      result: 'PASS',
    }]);
    assert.equal(row.reasonCode, null);
    assert.equal(Number.isInteger(row.durationMs), true);
    assert.ok(row.durationMs >= 0);
    assert.deepEqual(row.cli, [harness, ...lifecycle[1].args]);
    const prompt = harness === 'claude' ? lifecycle[1].args[1] : lifecycle[1].args.at(-1);
    assert.doesNotMatch(prompt, /LIVE_CANARY_/u, 'prompt echo must not satisfy nonce evidence');
    assert.deepEqual(
      lifecycle[1].args,
      headlessCommand(harness, prompt, { displayName: 'steepy-live-scaffold-canary' }).args,
    );
    assert.match(row.version, new RegExp(`^${harness} 9\\.9\\.9 secret=\\[REDACTED\\]$`, 'u'));
    assert.match(row.log, /\[REDACTED\]/u);
    const nonceEvidence = [...row.log.matchAll(/LIVE_CANARY_(ROOT|BOOTSTRAP|STANDARD|ADAPTER)_[a-f0-9]+/gu)];
    assert.deepEqual(nonceEvidence.map((match) => match[1]), [
      'ROOT', 'BOOTSTRAP', 'STANDARD', 'ADAPTER',
    ]);
    assert.equal(new Set(nonceEvidence.map((match) => match[0])).size, 4);
    for (const secret of Object.values(secrets)) {
      assert.doesNotMatch(JSON.stringify(row), new RegExp(secret, 'u'));
    }
  }
});

test('a supported single harness exits zero only after a genuine PASS verdict', () => {
  const run = tempCase();
  fakeHarness(run, 'claude');
  const result = runDriver(run, 'claude', {
    credentials: { ANTHROPIC_API_KEY: 'single-secret' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(rows(run.output).map(({ verdict }) => verdict), ['PASS']);
  assert.deepEqual(rows(run.output)[0].capabilities, [{
    capability: 'descriptor-nonce-response',
    result: 'PASS',
  }]);
});

test('a nonzero descriptor process is FAIL and never promoted', () => {
  const run = tempCase();
  fakeHarness(run, 'codex', { exitCode: 7 });
  const result = runDriver(run, 'codex', {
    credentials: { OPENAI_API_KEY: 'failure-secret' },
  });
  assert.equal(result.status, 1, result.stderr);
  const [row] = rows(run.output);
  assert.equal(row.verdict, 'FAIL');
  assert.equal(row.reasonCode, 'process-exit');
  assert.doesNotMatch(JSON.stringify(row), /failure-secret/u);
});

test('exit zero without complete nonce evidence is FAIL, never a false PASS', () => {
  const run = tempCase();
  fakeHarness(run, 'opencode', { omitNonce: true });
  const result = runDriver(run, 'opencode', {
    credentials: { OPENCODE_API_KEY: 'verification-secret' },
  });
  assert.equal(result.status, 1, result.stderr);
  const [row] = rows(run.output);
  assert.equal(row.verdict, 'FAIL');
  assert.equal(row.reasonCode, 'verification-failed');
});

test('nonces in tool traces cannot compensate for an incomplete final assistant response', () => {
  for (const harness of ['claude', 'codex', 'opencode']) {
    const run = tempCase();
    fakeHarness(run, harness, { omitNonce: true, traceNonces: true });
    const result = runDriver(run, harness, {
      credentials: { [credentialNames[harness]]: 'trace-only-secret' },
    });
    assert.equal(result.status, 1, `${harness}: ${result.stderr}`);
    const [row] = rows(run.output);
    assert.equal(row.verdict, 'FAIL', harness);
    assert.equal(row.reasonCode, 'verification-failed', harness);
  }
});

test('the final assistant response must preserve nonce order and exact object shape', () => {
  for (const [label, options] of [
    ['out-of-order', { reverseNonces: true }],
    ['extra-field', { extraFinalField: true }],
  ]) {
    const run = tempCase();
    fakeHarness(run, 'codex', options);
    const result = runDriver(run, 'codex', {
      credentials: { OPENAI_API_KEY: 'exact-shape-secret' },
    });
    assert.equal(result.status, 1, `${label}: ${result.stderr}`);
    const [row] = rows(run.output);
    assert.equal(row.verdict, 'FAIL', label);
    assert.equal(row.reasonCode, 'verification-failed', label);
  }
});

test('exit zero with an empty version probe is FAIL, never a false PASS', () => {
  const run = tempCase();
  fakeHarness(run, 'claude', { emptyVersion: true });
  const result = runDriver(run, 'claude', {
    credentials: { ANTHROPIC_API_KEY: 'version-secret' },
  });
  assert.equal(result.status, 1, result.stderr);
  const [row] = rows(run.output);
  assert.equal(row.verdict, 'FAIL');
  assert.equal(row.reasonCode, 'version-probe');
  assert.equal(row.version, '');
});

test('missing binary and missing credentials are honest NOT RUN verdicts', () => {
  const missingBinary = tempCase();
  const binaryResult = runDriver(missingBinary, 'claude', {
    credentials: { ANTHROPIC_API_KEY: 'present-secret' },
  });
  assert.equal(binaryResult.status, 1, binaryResult.stderr);
  assert.equal(rows(missingBinary.output)[0].verdict, 'NOT RUN');
  assert.equal(rows(missingBinary.output)[0].reasonCode, 'binary-missing');
  assert.equal(rows(missingBinary.output)[0].cli[0], 'claude');
  assert.deepEqual(events(missingBinary.events), [], 'the fake-bin-only PATH must confine the test from host CLIs');

  const missingCredential = tempCase();
  fakeHarness(missingCredential, 'opencode');
  const credentialResult = runDriver(missingCredential, 'opencode');
  assert.equal(credentialResult.status, 1, credentialResult.stderr);
  assert.equal(rows(missingCredential.output)[0].verdict, 'NOT RUN');
  assert.equal(rows(missingCredential.output)[0].reasonCode, 'credentials-missing');
  assert.equal(rows(missingCredential.output)[0].cli[0], 'opencode');
  assert.deepEqual(events(missingCredential.events), []);
});

test('Pi and DeepSeek are always runner-unavailable without invoking lookalike binaries', () => {
  for (const harness of ['pi', 'deepseek']) {
    const run = tempCase();
    fakeHarness(run, harness);
    const result = runDriver(run, harness);
    assert.equal(result.status, 1, result.stderr);
    const [row] = rows(run.output);
    assertEvidenceIdentity(row, harness);
    assert.deepEqual(row, {
      schemaVersion: 1,
      harness,
      cli: null,
      version: null,
      durationMs: 0,
      log: '',
      verdict: 'NOT RUN',
      reasonCode: 'runner-unavailable',
      identity: row.identity,
      capabilities: [],
    });
    assert.deepEqual(events(run.events), []);
  }
});

test('CLI parsing is strict and produces no report on usage errors', () => {
  const cases = [
    [],
    ['--harness', 'claude'],
    ['--output', 'report.jsonl'],
    ['--harness', 'unknown', '--output', 'report.jsonl'],
    ['--harness', 'pi', '--output', 'report.jsonl', 'positional'],
    ['--harness', 'pi', '--output', 'report.jsonl', '--extra'],
    ['--harness', 'pi', '--harness', 'pi', '--output', 'report.jsonl'],
  ];
  for (const args of cases) {
    const run = tempCase();
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: run.root,
      encoding: 'utf8',
      env: { PATH: run.bin, TMPDIR: tmpdir() },
    });
    assert.equal(result.status, 2, `${JSON.stringify(args)}: ${result.stderr}`);
    assert.equal(existsSync(run.output), false);
  }
});

test('output rejects symlink parents before making a fixture or invoking a runner', () => {
  const run = tempCase();
  fakeHarness(run, 'claude');
  const outside = join(run.root, 'outside');
  mkdirSync(outside);
  const linkedParent = join(run.root, 'linked');
  symlinkSync(outside, linkedParent, 'dir');
  const output = join(linkedParent, 'report.jsonl');

  const result = runDriver(run, 'claude', {
    output,
    credentials: { ANTHROPIC_API_KEY: 'parent-secret' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /output.*symlink|symlink.*output/iu);
  assert.equal(existsSync(join(outside, 'report.jsonl')), false);
  assert.deepEqual(events(run.events), []);
});

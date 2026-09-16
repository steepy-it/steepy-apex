import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectReviewEvidence,
  RECEIPT_EXCERPT_BYTES,
} from '../scripts/capture-review-evidence.mjs';
import { classifyWorkPath } from '../scripts/work-paths.mjs';

const scriptPath = new URL('../scripts/capture-review-evidence.mjs', import.meta.url);
const EVIDENCE = '.apex/work/tasks/demo/evidence-report.md';
const GROUPS_SUPPORTED = process.platform === 'linux' || process.platform === 'darwin';

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'steepy-review-evidence-'));
  mkdirSync(join(repo, '.apex'), { recursive: true });
  writeFileSync(join(repo, '.apex', '_INDEX.md'), '# Test hub\n');
  return repo;
}

function nodeCommand(source) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

test('work-path grammar admits only canonical task and loop review evidence reports', () => {
  assert.equal(classifyWorkPath(EVIDENCE).family, 'evidence');
  assert.equal(
    classifyWorkPath('.apex/work/loops/2026-09-02-demo/evidence-report.md').family,
    'evidence',
  );
  assert.equal(classifyWorkPath('.apex/work/tasks/demo/review-report.md').family, 'review-report');
  assert.equal(
    classifyWorkPath('.apex/work/loops/2026-09-02-demo/review-report.md').family,
    'review-report',
  );
  for (const path of [
    '.apex/work/tasks/demo/evidence.txt',
    '.apex/work/tasks/demo/nested/evidence-report.md',
    '.apex/work/loops/demo/other.md',
  ]) {
    assert.throws(() => classifyWorkPath(path), /work path/u, path);
  }
});

test('collector streams the complete transcript to disk and returns a bounded receipt', async () => {
  const repo = fixture();
  const payload = 'X'.repeat(120_000);
  let writeCalls = 0;
  try {
    const receipt = await collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      testCommand: nodeCommand(`process.stdout.write(${JSON.stringify(payload)})`),
      writeToFd(fd, buffer, offset, length) {
        writeCalls += 1;
        return writeSync(fd, buffer, offset, Math.min(length, 11));
      },
    });

    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.artifact, EVIDENCE);
    assert.equal(receipt.allPassed, true);
    assert.deepEqual(receipt.commands.map(({ label }) => label), ['surface-test', 'validate-hub']);

    const testResult = receipt.commands[0];
    assert.equal(testResult.exitCode, 0);
    assert.equal(testResult.outputBytes, Buffer.byteLength(payload));
    assert.equal(testResult.outputLines, 1);
    assert.equal(
      testResult.outputSha256,
      createHash('sha256').update(payload).digest('hex'),
    );
    assert.equal(Buffer.byteLength(testResult.excerpt), RECEIPT_EXCERPT_BYTES);
    assert.equal(testResult.excerptTruncated, true);
    assert.ok(writeCalls > 10_000, 'positive short writes must be retried to completion');

    const report = readFileSync(join(repo, EVIDENCE), 'utf8');
    assert.match(report, /^# Review evidence/mu);
    assert.ok(report.includes(payload), 'the full command output must remain durable on disk');
    assert.ok(report.includes(testResult.outputSha256), 'the report must bind the transcript to its receipt hash');
    assert.ok(
      Buffer.byteLength(JSON.stringify(receipt)) < 5_000,
      'the model-facing receipt must stay bounded independently of command output size',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('capture failure after an accepted prefix converges the group, closes once, and starts no next command', {
  timeout: 5_000,
  skip: !GROUPS_SUPPORTED,
}, async () => {
  const repo = fixture();
  const pidPath = join(repo, 'capture-descendant.pid');
  const readyPath = join(repo, 'capture-descendant.ready');
  const descendant = [
    "const fs=require('node:fs');",
    "process.on('SIGTERM',()=>{});",
    `fs.writeFileSync(${JSON.stringify(readyPath)},'ready');`,
    'setTimeout(()=>process.exit(0),1800);',
  ].join('');
  const leader = [
    "const fs=require('node:fs');",
    "const {spawn}=require('node:child_process');",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']});`,
    `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
    'const begin=()=>{',
    `if(!fs.existsSync(${JSON.stringify(readyPath)})){setTimeout(begin,5);return;}`,
    "process.on('SIGTERM',()=>process.stdout.write(['AFTER','FAILURE','SHOULD','NOT','PERSIST'].join('_')));",
    "process.stdout.write('CAPTURE_FAILURE_MARKER-and-more-output');",
    'setTimeout(()=>process.exit(0),1800);',
    '};begin();',
  ].join('');
  let markerCalls = 0;
  let closeCalls = 0;
  const started = Date.now();
  try {
    await assert.rejects(() => collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      testCommand: nodeCommand(leader),
      killGraceMs: 50,
      processGroupConvergenceMs: 800,
      streamSettlementMs: 800,
      writeToFd(fd, buffer, offset, length) {
        const remaining = buffer.subarray(offset, offset + length);
        if (remaining.indexOf(Buffer.from('CAPTURE_FAILURE_MARKER')) === 0) {
          markerCalls += 1;
          if (markerCalls === 2) throw new Error('injected capture write failure');
          return writeSync(fd, buffer, offset, Math.min(length, 7));
        }
        if (markerCalls === 1) {
          markerCalls += 1;
          throw new Error('injected capture write failure');
        }
        return writeSync(fd, buffer, offset, length);
      },
      closeFd(fd) {
        closeCalls += 1;
        closeSync(fd);
      },
    }), /injected capture write failure/u);

    assert.equal(closeCalls, 1);
    assert.ok(Date.now() - started < 1_200, `capture teardown took ${Date.now() - started}ms`);
    const report = readFileSync(join(repo, EVIDENCE), 'utf8');
    assert.match(report, /CAPTURE/u);
    assert.doesNotMatch(report, /AFTER_FAILURE_SHOULD_NOT_PERSIST/u);
    assert.doesNotMatch(report, /steepy validate-hub: OK/u);
    const descendantPid = Number(readFileSync(pidPath, 'utf8'));
    assert.throws(() => process.kill(descendantPid, 0));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('capture failure settles cleanup without waiting for a leader that denied group signals', {
  timeout: 5_000,
  skip: !GROUPS_SUPPORTED,
}, async () => {
  const repo = fixture();
  const leader = [
    "process.on('SIGTERM',()=>{});",
    "process.stdout.write('WRITE_FAULT');",
    'setTimeout(()=>process.exit(0),3000);',
  ].join('');
  const signals = [];
  let groupPid = null;
  let closeCalls = 0;
  let collector;
  try {
    collector = collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      testCommand: nodeCommand(leader),
      killGraceMs: 20,
      processGroupConvergenceMs: 50,
      streamSettlementMs: 50,
      writeToFd(fd, buffer, offset, length) {
        const remaining = buffer.subarray(offset, offset + length);
        if (remaining.indexOf(Buffer.from('WRITE_FAULT')) === 0) {
          throw new Error('injected write failure');
        }
        return writeSync(fd, buffer, offset, length);
      },
      processGroupSignal(pid, signal) {
        groupPid = pid;
        signals.push(signal);
        throw Object.assign(new Error('injected signal denied'), { code: 'EPERM' });
      },
      closeFd(fd) {
        closeCalls += 1;
        closeSync(fd);
      },
    });
    const outcome = await Promise.race([
      collector.then(
        (value) => ({ kind: 'fulfilled', value }),
        (error) => ({ kind: 'rejected', error }),
      ),
      new Promise((resolveTimeout) => {
        setTimeout(() => resolveTimeout({ kind: 'timeout' }), 500);
      }),
    ]);

    assert.equal(outcome.kind, 'rejected', 'collector must settle before external fixture rescue');
    assert.match(outcome.error.message, /injected write failure/u);
    assert.match(outcome.error.cleanupError?.message ?? '', /process-group convergence timed out/u);
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(closeCalls, 1);
    const report = readFileSync(join(repo, EVIDENCE), 'utf8');
    assert.doesNotMatch(report, /steepy validate-hub: OK/u);
  } finally {
    if (Number.isInteger(groupPid)) {
      try { process.kill(-groupPid, 'SIGKILL'); } catch { /* fixture group already exited */ }
    }
    await collector?.catch(() => {});
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a null capture failure after an accepted prefix rejects, closes once, and starts no next command', {
  timeout: 5_000,
  skip: !GROUPS_SUPPORTED,
}, async () => {
  const repo = fixture();
  let markerWrites = 0;
  let closeCalls = 0;
  try {
    await assert.rejects(() => collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      testCommand: nodeCommand("process.stdout.write('NULL_CAPTURE_FAILURE')"),
      writeToFd(fd, buffer, offset, length) {
        const remaining = buffer.subarray(offset, offset + length);
        if (remaining.indexOf(Buffer.from('NULL_CAPTURE_FAILURE')) === 0) {
          markerWrites += 1;
          return writeSync(fd, buffer, offset, Math.min(length, 6));
        }
        if (markerWrites === 1) {
          markerWrites += 1;
          throw null;
        }
        return writeSync(fd, buffer, offset, length);
      },
      closeFd(fd) {
        closeCalls += 1;
        closeSync(fd);
      },
    }), /capture failed with non-Error reason: null/u);

    assert.equal(markerWrites, 2);
    assert.equal(closeCalls, 1);
    const report = readFileSync(join(repo, EVIDENCE), 'utf8');
    assert.match(report, /NULL_C/u);
    assert.doesNotMatch(report, /steepy validate-hub: OK/u);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('an escaped inherited-pipe holder is outside containment but local stream teardown stays bounded', {
  timeout: 4_000,
  skip: !GROUPS_SUPPORTED,
}, async () => {
  const repo = fixture();
  const pidPath = join(repo, 'escaped-descendant.pid');
  const escaped = "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),2500);";
  const leader = [
    "const fs=require('node:fs');",
    "const {spawn}=require('node:child_process');",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(escaped)}],{detached:true,stdio:['ignore','inherit','inherit']});`,
    'child.unref();',
    `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
    "process.stdout.write('leader-complete');",
  ].join('');
  let closeCalls = 0;
  let escapedPid = null;
  const started = Date.now();
  try {
    await assert.rejects(() => collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      testCommand: nodeCommand(leader),
      killGraceMs: 50,
      processGroupConvergenceMs: 300,
      streamSettlementMs: 100,
      closeFd(fd) {
        closeCalls += 1;
        closeSync(fd);
      },
    }), /stream settlement timed out/u);
    assert.equal(closeCalls, 1);
    assert.ok(Date.now() - started < 1_000, `escaped-pipe teardown took ${Date.now() - started}ms`);
    escapedPid = Number(readFileSync(pidPath, 'utf8'));
    assert.doesNotThrow(() => process.kill(escapedPid, 0));
  } finally {
    if (Number.isInteger(escapedPid)) {
      try { process.kill(-escapedPid, 'SIGKILL'); } catch { /* fixture process already exited */ }
    }
    rmSync(repo, { recursive: true, force: true });
  }
});

test('normal and nonzero leaders converge signal-ignoring inherited-pipe descendants before continuing', {
  timeout: 7_000,
  skip: !GROUPS_SUPPORTED,
}, async () => {
  for (const exitCode of [0, 7]) {
    const repo = fixture();
    const pidPath = join(repo, `capture-descendant-${exitCode}.pid`);
    const readyPath = join(repo, `capture-descendant-${exitCode}.ready`);
    const descendant = [
      "const fs=require('node:fs');",
      "process.on('SIGTERM',()=>{});",
      `fs.writeFileSync(${JSON.stringify(readyPath)},'ready');`,
      'setTimeout(()=>process.exit(0),1800);',
    ].join('');
    const leader = [
      "const fs=require('node:fs');",
      "const {spawn}=require('node:child_process');",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']});`,
      `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
      'const finish=()=>{',
      `if(!fs.existsSync(${JSON.stringify(readyPath)})){setTimeout(finish,5);return;}`,
      `process.stdout.write('leader-output',()=>process.exit(${exitCode}));`,
      '};finish();',
    ].join('');
    const started = Date.now();
    try {
      const receipt = await collectReviewEvidence({
        repoRoot: repo,
        evidencePath: EVIDENCE,
        testCommand: nodeCommand(leader),
        killGraceMs: 50,
        processGroupConvergenceMs: 800,
        streamSettlementMs: 800,
      });
      assert.equal(receipt.commands[0].exitCode, exitCode);
      assert.equal(receipt.commands[1].label, 'validate-hub');
      assert.ok(Date.now() - started < 1_200, `exit ${exitCode} took ${Date.now() - started}ms`);
      const descendantPid = Number(readFileSync(pidPath, 'utf8'));
      assert.throws(() => process.kill(descendantPid, 0), undefined, `exit ${exitCode}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('collector refuses unsupported process-group platforms before creating evidence', async () => {
  const repo = fixture();
  try {
    await assert.rejects(() => collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      testCommand: nodeCommand("process.stdout.write('must-not-run')"),
      platform: 'aix',
    }), /unsupported platform/u);
    assert.equal(existsSync(join(repo, EVIDENCE)), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('receipt remains bounded for non-UTF-8 and JSON-escaped command output', async () => {
  const repo = fixture();
  try {
    const receipt = await collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      testCommand: nodeCommand('process.stdout.write(Buffer.alloc(120_000, 255))'),
      verifierCommand: nodeCommand('process.stdout.write(Buffer.alloc(120_000, 0))'),
    });

    assert.equal(receipt.commands[0].outputBytes, 120_000);
    assert.equal(receipt.commands[1].outputBytes, 120_000);
    assert.ok(Buffer.byteLength(receipt.commands[0].excerpt) <= RECEIPT_EXCERPT_BYTES);
    assert.ok(Buffer.byteLength(JSON.stringify(receipt.commands[1].excerpt)) <= RECEIPT_EXCERPT_BYTES + 2);
    assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 5_000);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a red test remains collected evidence, runs validate-hub, and exits the CLI successfully', () => {
  const repo = fixture();
  try {
    const result = spawnSync(process.execPath, [
      scriptPath.pathname,
      '--repo-root', repo,
      '--evidence', EVIDENCE,
      '--test-command', nodeCommand("process.stdout.write('failure-detail'); process.exit(7)"),
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.length < 5_000, 'stdout must contain a compact receipt, not the transcript');
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.allPassed, false);
    assert.equal(receipt.commands[0].exitCode, 7);
    assert.equal(receipt.commands[0].excerpt, 'failure-detail');
    assert.equal(receipt.commands[1].label, 'validate-hub');
    assert.equal(receipt.commands[1].exitCode, 0);

    const report = readFileSync(join(repo, EVIDENCE), 'utf8');
    assert.match(report, /failure-detail/u);
    assert.match(report, /Exit code: 7/u);
    assert.match(report, /steepy validate-hub: OK/u);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a new collection replaces stale evidence instead of merging history', async () => {
  const repo = fixture();
  try {
    await collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      testCommand: nodeCommand("process.stdout.write('first-run-only')"),
    });
    await collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      testCommand: nodeCommand("process.stdout.write('second-run-only')"),
    });

    const report = readFileSync(join(repo, EVIDENCE), 'utf8');
    assert.doesNotMatch(report, /first-run-only/u);
    assert.match(report, /second-run-only/u);
    assert.equal((report.match(/^# Review evidence$/gmu) ?? []).length, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('invalid CLI input fails closed before creating an evidence artifact', () => {
  const repo = fixture();
  const outside = join(repo, 'outside.md');
  try {
    const result = spawnSync(process.execPath, [
      scriptPath.pathname,
      '--repo-root', repo,
      '--evidence', '../outside.md',
      '--test-command', 'npm test',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /^steepy capture-review-evidence: /u);
    assert.equal(result.stdout, '');
    assert.equal(existsSync(outside), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI refuses an existing symlinked evidence target without changing its referent', () => {
  const repo = fixture();
  const target = join(repo, 'outside.md');
  try {
    writeFileSync(target, 'sentinel');
    const evidenceAbs = join(repo, EVIDENCE);
    const parent = evidenceAbs.slice(0, evidenceAbs.lastIndexOf('/'));
    mkdirSync(parent, { recursive: true });
    symlinkSync(target, evidenceAbs, 'file');

    const result = spawnSync(process.execPath, [
      scriptPath.pathname,
      '--repo-root', repo,
      '--evidence', EVIDENCE,
      '--test-command', 'npm test',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /symlink target blocks/u);
    assert.equal(readFileSync(target, 'utf8'), 'sentinel');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

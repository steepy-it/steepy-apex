#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  closeSync,
  fsyncSync,
  writeSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertSafeHubRoot, assertSafeLine } from './sanitize.mjs';
import {
  openWorkPathFd,
  parseWorkPath,
  writeWorkPath,
} from './work-paths.mjs';
import { writeAllSync } from './write-all.mjs';

export const RECEIPT_EXCERPT_BYTES = 1_024;

const VALIDATE_HUB_SCRIPT = fileURLToPath(new URL('./validate-hub.mjs', import.meta.url));
const USAGE = 'usage: node scripts/capture-review-evidence.mjs --repo-root <root> --evidence <canonical-path> --test-command <command> [--verifier-command <command>]';

function safeCommand(value, label) {
  assertSafeLine(value, label);
  if (value.trim() === '') throw new Error(`${label} must not be empty`);
  return value;
}

function writeText(fd, value, writeToFd) {
  writeAllSync(fd, Buffer.from(value, 'utf8'), writeToFd);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function settlesWithin(promise, timeoutMs) {
  let timer;
  const settled = await Promise.race([
    promise.then(() => true),
    new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), timeoutMs);
    }),
  ]);
  if (settled) clearTimeout(timer);
  return settled;
}

function signalProcessGroup(child, signal, processGroupSignal) {
  if (!child?.pid) return;
  if (processGroupSignal !== null) {
    processGroupSignal(child.pid, signal);
    return;
  }
  process.kill(-child.pid, signal);
}

function processGroupAlive(child, processGroupProbe) {
  if (!child?.pid) return false;
  try {
    if (processGroupProbe !== null) return processGroupProbe(child.pid) !== false;
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function awaitProcessGroupState(child, expectedAlive, timeoutMs, processGroupProbe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (processGroupAlive(child, processGroupProbe) === expectedAlive) return true;
    if (Date.now() >= deadline) return false;
    await delay(10);
  }
}

async function convergeProcessGroup({
  child,
  killGraceMs,
  processGroupConvergenceMs,
  processGroupProbe,
  processGroupSignal,
}) {
  if (!child?.pid) return true;
  const confirmationMs = Math.min(processGroupConvergenceMs, 100);
  if (!await awaitProcessGroupState(
    child,
    true,
    Math.min(killGraceMs, 100),
    processGroupProbe,
  )) {
    await delay(confirmationMs);
    if (!processGroupAlive(child, processGroupProbe)) return true;
  }
  try { signalProcessGroup(child, 'SIGTERM', processGroupSignal); } catch { /* escalate below */ }
  if (await awaitProcessGroupState(child, false, killGraceMs, processGroupProbe)) {
    await delay(confirmationMs);
    if (!processGroupAlive(child, processGroupProbe)) return true;
  }
  try { signalProcessGroup(child, 'SIGKILL', processGroupSignal); } catch { /* verify below */ }
  if (!await awaitProcessGroupState(
    child,
    false,
    processGroupConvergenceMs,
    processGroupProbe,
  )) return false;
  await delay(confirmationMs);
  return !processGroupAlive(child, processGroupProbe);
}

async function settleChildStreams(child, streamSettlements, streamSettlementMs) {
  const allSettled = Promise.all(streamSettlements);
  if (await settlesWithin(allSettled, streamSettlementMs)) {
    return { settled: true, timedOut: false };
  }
  child.stdout.destroy();
  child.stderr.destroy();
  return {
    settled: await settlesWithin(allSettled, streamSettlementMs),
    timedOut: true,
  };
}

function normalizedCaptureError(error) {
  if (error instanceof Error) return error;
  return new Error(`capture failed with non-Error reason: ${String(error)}`, { cause: error });
}

function cleanupErrorFor(result, processGroupConvergenceMs, streamSettlementMs) {
  const errors = [];
  if (!result.converged) {
    errors.push(new Error(
      `process-group convergence timed out after ${processGroupConvergenceMs}ms`,
    ));
  }
  if (result.streams.timedOut) {
    errors.push(new Error(`stream settlement timed out after ${streamSettlementMs}ms`));
  }
  if (!result.streams.settled) {
    errors.push(new Error(
      `stream destruction did not settle after an additional ${streamSettlementMs}ms`,
    ));
  }
  if (errors.length === 0) return null;
  if (errors.length === 1) return errors[0];
  return new AggregateError(errors, errors.map(({ message }) => message).join('; '));
}

function attachCleanupError(primaryError, cleanupError) {
  if (cleanupError === null) return primaryError;
  try {
    primaryError.cleanupError = cleanupError;
    return primaryError;
  } catch {
    const wrapped = new Error(primaryError.message, { cause: primaryError });
    wrapped.cleanupError = cleanupError;
    return wrapped;
  }
}

function appendTail(current, chunk) {
  if (chunk.length >= RECEIPT_EXCERPT_BYTES) return chunk.subarray(chunk.length - RECEIPT_EXCERPT_BYTES);
  if (current.length + chunk.length <= RECEIPT_EXCERPT_BYTES) {
    return Buffer.concat([current, chunk]);
  }
  const keep = RECEIPT_EXCERPT_BYTES - chunk.length;
  return Buffer.concat([current.subarray(current.length - keep), chunk]);
}

function outputLineCount(newlines, bytes, finalByte) {
  return newlines + (bytes > 0 && finalByte !== 0x0a ? 1 : 0);
}

function boundedUtf8(buffer) {
  const characters = Array.from(buffer.toString('utf8'));
  const kept = [];
  let serializedBytes = 0;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index];
    const encoded = JSON.stringify(character).slice(1, -1);
    const bytes = Buffer.byteLength(encoded);
    if (serializedBytes + bytes > RECEIPT_EXCERPT_BYTES) break;
    kept.push(character);
    serializedBytes += bytes;
  }
  return kept.reverse().join('');
}

function commandDisplayHash(command) {
  return createHash('sha256').update(command).digest('hex');
}

async function captureCommand({
  label,
  displayCommand,
  file,
  args = [],
  shell = false,
  cwd,
  fd,
  writeToFd,
  killGraceMs,
  processGroupConvergenceMs,
  streamSettlementMs,
  processGroupProbe,
  processGroupSignal,
}) {
  const startedAt = new Date().toISOString();
  writeText(fd, [
    '',
    `## ${label}`,
    '',
    `Command JSON: ${JSON.stringify(displayCommand)}`,
    `Started: ${startedAt}`,
    '',
    '--- combined stdout/stderr begin ---',
    '',
  ].join('\n'), writeToFd);

  const hash = createHash('sha256');
  let outputBytes = 0;
  let newlines = 0;
  let finalByte = null;
  let tail = Buffer.alloc(0);
  let spawnError = null;

  const child = spawn(file, args, {
    cwd,
    shell,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  let captureFailed = false;
  let captureError;
  let triggerFailure;
  const failureTriggered = new Promise((resolveFailure) => {
    triggerFailure = resolveFailure;
  });
  let cleanupReady;
  const readyForCleanup = new Promise((resolveReady) => {
    cleanupReady = resolveReady;
  });
  let cleanupPromise = null;
  let streamSettlements;
  const startCleanup = () => {
    cleanupPromise ??= readyForCleanup.then(async () => {
      const [converged, streams] = await Promise.all([
        convergeProcessGroup({
          child,
          killGraceMs,
          processGroupConvergenceMs,
          processGroupProbe,
          processGroupSignal,
        }),
        settleChildStreams(child, streamSettlements, streamSettlementMs),
      ]);
      return { converged, streams };
    });
    return cleanupPromise;
  };
  const requestStop = (error) => {
    if (captureFailed) return;
    captureFailed = true;
    captureError = normalizedCaptureError(error);
    triggerFailure();
    startCleanup();
  };
  const collect = (value) => {
    if (captureFailed) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (chunk.length === 0) return;
    try {
      writeAllSync(fd, chunk, writeToFd);
      hash.update(chunk);
      outputBytes += chunk.length;
      for (const byte of chunk) if (byte === 0x0a) newlines += 1;
      finalByte = chunk[chunk.length - 1];
      tail = appendTail(tail, chunk);
    } catch (error) {
      requestStop(error);
    }
  };

  streamSettlements = [child.stdout, child.stderr].map((stream) => new Promise((resolveStream) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolveStream();
    };
    stream.on('data', collect);
    stream.once('end', settle);
    stream.once('close', settle);
    stream.once('error', (error) => {
      requestStop(error);
      settle();
    });
  }));

  const leaderSettlement = new Promise((resolveLeader) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolveLeader(result);
    };
    child.once('error', (error) => {
      spawnError = error;
      settle({ code: null, signal: null });
    });
    child.once('exit', (exitCode, exitSignal) => {
      settle({ code: exitCode, signal: exitSignal });
    });
  });
  cleanupReady();
  const firstSettlement = await Promise.race([
    leaderSettlement.then((result) => ({ kind: 'leader', result })),
    failureTriggered.then(() => ({ kind: 'failure' })),
  ]);
  const cleanup = await startCleanup();
  const cleanupError = cleanupErrorFor(
    cleanup,
    processGroupConvergenceMs,
    streamSettlementMs,
  );
  if (captureFailed) throw attachCleanupError(captureError, cleanupError);
  if (cleanupError !== null) throw cleanupError;
  const { code, signal } = firstSettlement.kind === 'leader'
    ? firstSettlement.result
    : { code: null, signal: null };

  if (finalByte !== null && finalByte !== 0x0a) writeText(fd, '\n', writeToFd);
  const finishedAt = new Date().toISOString();
  const outputSha256 = hash.digest('hex');
  const lines = outputLineCount(newlines, outputBytes, finalByte);
  writeText(fd, [
    '',
    '--- combined stdout/stderr end ---',
    '',
    `Exit code: ${code === null ? 'none' : code}`,
    `Signal: ${signal ?? 'none'}`,
    `Spawn error: ${spawnError?.message ?? 'none'}`,
    `Output bytes: ${outputBytes}`,
    `Output lines: ${lines}`,
    `Output SHA-256: ${outputSha256}`,
    `Finished: ${finishedAt}`,
    '',
  ].join('\n'), writeToFd);

  return {
    label,
    commandSha256: commandDisplayHash(displayCommand),
    startedAt,
    finishedAt,
    exitCode: code,
    signal,
    ...(spawnError === null ? {} : { error: spawnError.message }),
    outputBytes,
    outputLines: lines,
    outputSha256,
    // Bound the JSON-serialized representation, not only the decoded string:
    // control bytes can otherwise expand sixfold as `\u0000` in the receipt.
    excerpt: boundedUtf8(tail),
    excerptTruncated: outputBytes > tail.length,
    passed: spawnError === null && code === 0,
  };
}

export async function collectReviewEvidence({
  repoRoot,
  evidencePath,
  testCommand,
  verifierCommand,
  writeToFd = writeSync,
  closeFd = closeSync,
  killGraceMs = 500,
  processGroupConvergenceMs = 1_000,
  streamSettlementMs = 1_000,
  processGroupProbe = null,
  processGroupSignal = null,
  platform = process.platform,
}) {
  if (platform !== 'linux' && platform !== 'darwin') {
    throw new Error(`unsupported platform for process-group capture: ${platform}`);
  }
  const root = assertSafeHubRoot(repoRoot);
  const evidence = parseWorkPath(evidencePath, 'work-output', 'evidence').path;
  const test = safeCommand(testCommand, 'test command');
  const verifier = verifierCommand === undefined
    ? null
    : safeCommand(verifierCommand, 'verifier command');
  const startedAt = new Date().toISOString();

  writeWorkPath(root, evidence, [
    '# Review evidence',
    '',
    `Run started: ${startedAt}`,
    'Capture: combined stdout/stderr bytes are persisted in arrival order.',
    '',
  ].join('\n'), { expect: 'work-output', family: 'evidence' });

  const fd = openWorkPathFd(root, evidence, {
    expect: 'work-output',
    family: 'evidence',
    disposition: 'append',
  });
  const commands = [];
  try {
    commands.push(await captureCommand({
      label: 'surface-test',
      displayCommand: test,
      file: test,
      shell: true,
      cwd: root,
      fd,
      writeToFd,
      killGraceMs,
      processGroupConvergenceMs,
      streamSettlementMs,
      processGroupProbe,
      processGroupSignal,
    }));
    if (verifier !== null) {
      commands.push(await captureCommand({
        label: 'goal-verifier',
        displayCommand: verifier,
        file: verifier,
        shell: true,
        cwd: root,
        fd,
        writeToFd,
        killGraceMs,
        processGroupConvergenceMs,
        streamSettlementMs,
        processGroupProbe,
        processGroupSignal,
      }));
    }
    const validateDisplay = `${JSON.stringify(process.execPath)} ${JSON.stringify(VALIDATE_HUB_SCRIPT)} .`;
    commands.push(await captureCommand({
      label: 'validate-hub',
      displayCommand: validateDisplay,
      file: process.execPath,
      args: [VALIDATE_HUB_SCRIPT, '.'],
      cwd: root,
      fd,
      writeToFd,
      killGraceMs,
      processGroupConvergenceMs,
      streamSettlementMs,
      processGroupProbe,
      processGroupSignal,
    }));

    const finishedAt = new Date().toISOString();
    const allPassed = commands.every(({ passed }) => passed);
    writeText(fd, [
      '## Collection result',
      '',
      `Run finished: ${finishedAt}`,
      `All commands passed: ${allPassed}`,
      '',
    ].join('\n'), writeToFd);
    fsyncSync(fd);
    return {
      schemaVersion: 1,
      artifact: evidence,
      startedAt,
      finishedAt,
      allPassed,
      commands,
    };
  } finally {
    closeFd(fd);
  }
}

export async function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        'repo-root': { type: 'string' },
        evidence: { type: 'string' },
        'test-command': { type: 'string' },
        'verifier-command': { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    }));
    if (!values['repo-root'] || !values.evidence || !values['test-command']) {
      throw new Error(USAGE);
    }
    const receipt = await collectReviewEvidence({
      repoRoot: values['repo-root'],
      evidencePath: values.evidence,
      testCommand: values['test-command'],
      verifierCommand: values['verifier-command'],
    });
    console.log(JSON.stringify(receipt));
    return 0;
  } catch (error) {
    console.error(`steepy capture-review-evidence: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

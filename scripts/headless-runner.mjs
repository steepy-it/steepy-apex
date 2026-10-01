import { spawn } from 'node:child_process';
import { closeSync, fsyncSync, writeSync } from 'node:fs';

import { decodeHeadlessEvent } from '../adapters/headless-events.mjs';
import { createHeadlessResponseCorrelator } from '../adapters/headless-response.mjs';
import { BoundedMultiDestinationWriter, LineFramer, processEventLine } from './autopilot-observability.mjs';
import { openWorkPathFd, parseWorkPath } from './work-paths.mjs';
import { writeAllSync } from './write-all.mjs';

const TERMINAL_RESPONSE_LIMIT = 64 * 1024;
const DIAGNOSTIC_LIMIT = 4 * 1024;
const RAW_FAMILIES = new Set(['runner-raw', 'reviewer-raw', 'role-raw']);
const LOG_FAMILIES = new Set(['runner-log', 'reviewer-log', 'role-log']);

function confinedLogFamily(path, allowed, kind) {
  const family = parseWorkPath(path, 'work-output').family;
  if (!allowed.has(family)) throw new Error(`${kind} path is not an admitted ${kind} log`);
  return family;
}

function runResult({ processResult, transportError, terminal, captureError, stderr = '', degraded = false }) {
  const output = terminal?.payload ?? '';
  const process = Object.freeze({ status: processResult.status, signal: processResult.signal });
  const transport = Object.freeze({ error: transportError });
  const capture = Object.freeze({ persisted: captureError === null, error: captureError });
  return Object.freeze({
    process, transport, terminal, capture,
    status: process.status, signal: process.signal,
    stdout: output, stderr, output,
    retainedBytes: (terminal?.retainedBytes ?? 0) + Buffer.byteLength(stderr, 'utf8'),
    evidencePersisted: capture.persisted, degraded, error: transport.error,
  });
}

function appendBoundedDiagnostic(current, chunk, limit = DIAGNOSTIC_LIMIT) {
  const combined = Buffer.concat([Buffer.from(current, 'utf8'), Buffer.from(chunk)]);
  return combined.subarray(Math.max(0, combined.length - limit)).toString('utf8');
}

function killProcessTree(child, signal, processGroupSignal = null) {
  if (!child) return;
  if (processGroupSignal !== null) {
    try { processGroupSignal(child.pid, signal); } catch { /* convergence will fail closed */ }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* the process tree is already gone */ }
  }
}

function processTreeAlive(child, processGroupProbe = null) {
  if (!child?.pid) return false;
  if (processGroupProbe !== null) {
    try {
      return processGroupProbe(child.pid) !== false;
    } catch {
      return true;
    }
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function awaitProcessTreeExit(child, timeoutMs, processGroupProbe = null) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!processTreeAlive(child, processGroupProbe)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function awaitProcessTreePresence(child, timeoutMs, processGroupProbe = null) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (processTreeAlive(child, processGroupProbe)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function convergeProcessTree(
  child,
  termGraceMs,
  convergenceMs,
  processGroupProbe = null,
  processGroupSignal = null,
) {
  if (!child?.pid) return true;
  const confirmationMs = Math.min(convergenceMs, 100);
  if (!await awaitProcessTreePresence(
    child,
    Math.min(termGraceMs, 100),
    processGroupProbe,
  )) {
    await new Promise((resolveWait) => setTimeout(resolveWait, confirmationMs));
    if (!processTreeAlive(child, processGroupProbe)) return true;
  }
  killProcessTree(child, 'SIGTERM', processGroupSignal);
  if (await awaitProcessTreeExit(child, termGraceMs, processGroupProbe)) {
    await new Promise((resolveWait) => setTimeout(resolveWait, confirmationMs));
    if (!processTreeAlive(child, processGroupProbe)) return true;
  }
  killProcessTree(child, 'SIGKILL', processGroupSignal);
  if (!await awaitProcessTreeExit(child, convergenceMs, processGroupProbe)) return false;
  await new Promise((resolveWait) => setTimeout(resolveWait, confirmationMs));
  return !processTreeAlive(child, processGroupProbe);
}

function durableFdDestination(fd, writeToFd = writeSync) {
  let closed = false;
  return {
    on() { return this; },
    write(chunk, callback) {
      try {
        if (closed) throw new Error('destination is closed');
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
        writeAllSync(fd, bytes, writeToFd);
        fsyncSync(fd);
        callback?.();
        return true;
      } catch (error) {
        callback?.(error);
        return false;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try { fsyncSync(fd); } finally { closeSync(fd); }
    },
  };
}

export function runManagedHeadlessDescriptor(descriptor, harness, cwd, options = {}) {
  return new Promise((resolveRun) => {
    let correlator;
    let setup;
    try {
      if (typeof descriptor?.cmd !== 'string' || descriptor.cmd.length === 0
        || !Array.isArray(descriptor.args) || descriptor.args.some((arg) => typeof arg !== 'string')) {
        throw new TypeError('descriptor requires a command and string argv');
      }
      setup = {
        cmd: descriptor.cmd,
        args: [...descriptor.args],
        rawPath: options.rawPath,
        readablePath: options.readablePath,
        rawWrite: options.rawWrite ?? writeSync,
        liveStdout: options.liveStdout ?? process.stdout,
        liveStderr: options.liveStderr ?? process.stderr,
        writerMaxPendingBytes: options.writerMaxPendingBytes,
        drainTimeoutMs: options.drainTimeoutMs,
        killGraceMs: options.killGraceMs ?? 500,
        processGroupConvergenceMs: options.processGroupConvergenceMs ?? 1000,
        processGroupProbe: options.processGroupProbe ?? null,
        processGroupSignal: options.processGroupSignal ?? null,
        abortSignal: options.signal ?? null,
      };
      correlator = createHeadlessResponseCorrelator(harness, {
        maxBytes: options.terminalResponseLimit ?? TERMINAL_RESPONSE_LIMIT,
      });
      for (const [value, label] of [
        [setup.writerMaxPendingBytes, 'maxPendingBytes'],
        [setup.drainTimeoutMs, 'drainTimeoutMs'],
        [setup.processGroupConvergenceMs, 'processGroupConvergenceMs'],
      ]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
          throw new TypeError(`${label} must be a positive safe integer`);
        }
      }
      if (!Number.isSafeInteger(setup.killGraceMs) || setup.killGraceMs < 0) {
        throw new TypeError('killGraceMs must be a nonnegative safe integer');
      }
      for (const stream of [setup.liveStdout, setup.liveStderr]) {
        if (typeof stream?.write !== 'function') throw new TypeError('live destination must be writable');
      }
      if (typeof setup.rawWrite !== 'function') throw new TypeError('rawWrite must be a function');
      if (setup.processGroupProbe !== null && typeof setup.processGroupProbe !== 'function') {
        throw new TypeError('processGroupProbe must be a function');
      }
      if (setup.processGroupSignal !== null && typeof setup.processGroupSignal !== 'function') {
        throw new TypeError('processGroupSignal must be a function');
      }
      const { abortSignal } = setup;
      if (abortSignal !== null && (
        typeof abortSignal.aborted !== 'boolean'
        || typeof abortSignal.addEventListener !== 'function'
        || typeof abortSignal.removeEventListener !== 'function'
      )) throw new TypeError('signal must support aborted, addEventListener, and removeEventListener');
    } catch (error) {
      resolveRun(runResult({
        processResult: { status: null, signal: null }, transportError: error,
        terminal: null, captureError: error,
      }));
      return;
    }
    const { rawPath, readablePath } = setup;
    let raw;
    try {
      const rawFamily = confinedLogFamily(rawPath, RAW_FAMILIES, 'raw');
      const fd = openWorkPathFd(cwd, rawPath, {
        expect: 'work-output', family: rawFamily, disposition: 'create-new', mode: 0o600,
      });
      raw = durableFdDestination(fd, setup.rawWrite);
    } catch (error) {
      const captureError = new Error(`raw-open failed: ${error.message}`);
      resolveRun(runResult({
        processResult: { status: null, signal: null }, transportError: captureError,
        terminal: null, captureError,
      }));
      return;
    }

    let degraded = false;
    let readable = null;
    try {
      const readableFamily = confinedLogFamily(readablePath, LOG_FAMILIES, 'readable');
      const fd = openWorkPathFd(cwd, readablePath, {
        expect: 'work-output', family: readableFamily, disposition: 'create-new', mode: 0o600,
      });
      readable = durableFdDestination(fd);
    } catch {
      degraded = true;
    }

    const { liveStdout, liveStderr, abortSignal } = setup;
    let bridgeError = null;
    let captureError = null;
    let child = null;
    let stopRequested = false;
    let graceTimer = null;
    let settled = false;
    let convergenceStarted = false;
    let convergenceComplete = false;
    let abortCleanup = null;
    let interrupted = null;
    let stopForwarding = () => {};
    const { killGraceMs, processGroupConvergenceMs, processGroupProbe, processGroupSignal } = setup;
    const requestStop = (error, captureFailure = true) => {
      if (stopRequested || settled) return;
      stopRequested = true;
      if (error && bridgeError === null) bridgeError = error;
      if (error && captureFailure && captureError === null) captureError = error;
      if (!convergenceStarted && !convergenceComplete) {
        killProcessTree(child, 'SIGTERM', processGroupSignal);
        graceTimer = setTimeout(() => {
          graceTimer = null;
          if (!settled) killProcessTree(child, 'SIGKILL', processGroupSignal);
        }, killGraceMs);
      }
    };
    const writer = new BoundedMultiDestinationWriter({
      destinations: [
        { name: 'raw', role: 'raw', stream: raw },
        ...(readable === null ? [] : [{ name: 'readable', role: 'readable', stream: readable }]),
        { name: 'liveStdout', role: 'liveStdout', stream: liveStdout },
        { name: 'liveStderr', role: 'liveStderr', stream: liveStderr },
      ],
      ...(setup.writerMaxPendingBytes === undefined
        ? {} : { maxPendingBytes: setup.writerMaxPendingBytes }),
      ...(setup.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: setup.drainTimeoutMs }),
      onBlockingError: requestStop,
      onDegradation() { degraded = true; },
    });
    let stderrDiagnostic = '';
    const framers = {
      stdout: new LineFramer({ sourceStream: 'stdout' }),
      stderr: new LineFramer({ sourceStream: 'stderr' }),
    };
    const consume = (frame, source) => {
      if (bridgeError) return;
      const result = processEventLine({
        line: frame.line,
        sourceStream: frame.sourceStream,
        context: {
          harness,
          runId: options.runId ?? null,
          phase: options.phase ?? 'loop-engineer',
          attempt: options.attempt ?? null,
          receivedAt: new Date().toISOString(),
        },
        decoder: decodeHeadlessEvent,
      });
      if (result.blockingError) {
        requestStop(result.blockingError);
        return;
      }
      if (result.degradation) degraded = true;
      const rawResult = writer.write({ raw: result.raw }, { source });
      if (!rawResult.ok) return;
      correlator.accept(frame.line, frame.sourceStream);
      const chunks = {};
      if (result.readable !== null) chunks.readable = `${result.readable}\n`;
      if (result.live !== null) {
        chunks[frame.sourceStream === 'stderr' ? 'liveStderr' : 'liveStdout'] = `${result.live}\n`;
      }
      if (Object.keys(chunks).length > 0) writer.write(chunks, { source });
    };
    const closeAll = () => {
      writer.terminate();
      try { raw.close(); } catch (error) { captureError ??= error; bridgeError ??= error; }
      try { readable?.close(); } catch { degraded = true; }
    };
    try {
      child = spawn(setup.cmd, setup.args, {
        cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true,
      });
    } catch (error) {
      closeAll();
      resolveRun(runResult({
        processResult: { status: null, signal: null }, transportError: captureError ?? error,
        terminal: null, captureError, degraded,
      }));
      return;
    }
    try {
      if (abortSignal !== null) {
        const onAbort = () => requestStop(new Error('headless descriptor aborted'), false);
        if (abortSignal.aborted) onAbort();
        else {
          abortCleanup = () => abortSignal.removeEventListener('abort', onAbort);
          abortSignal.addEventListener('abort', onAbort, { once: true });
        }
      }
      const forwardSignal = (signal) => {
        stopForwarding();
        interrupted = signal;
        requestStop(new Error(`headless descriptor interrupted by ${signal}`), false);
      };
      const onSigint = () => forwardSignal('SIGINT');
      const onSigterm = () => forwardSignal('SIGTERM');
      const onSighup = () => forwardSignal('SIGHUP');
      stopForwarding = () => {
        process.removeListener('SIGINT', onSigint);
        process.removeListener('SIGTERM', onSigterm);
        process.removeListener('SIGHUP', onSighup);
      };
      process.once('SIGINT', onSigint);
      process.once('SIGTERM', onSigterm);
      process.once('SIGHUP', onSighup);
      for (const sourceStream of ['stdout', 'stderr']) {
        const source = child[sourceStream];
        source.on('data', (chunk) => {
          if (sourceStream === 'stderr') stderrDiagnostic = appendBoundedDiagnostic(stderrDiagnostic, chunk);
          try {
            for (const frame of framers[sourceStream].push(chunk)) consume(frame, source);
          } catch (error) {
            requestStop(error);
          }
        });
        source.on('end', () => {
          try {
            for (const frame of framers[sourceStream].end()) consume(frame, source);
          } catch (error) {
            requestStop(error);
          }
        });
      }
    } catch (error) {
      requestStop(error, false);
    }
    let leaderResult = null;
    let streamsFinalized = false;
    let convergenceError = null;
    const finishIfReady = () => {
      if (settled || leaderResult === null || !streamsFinalized || !convergenceComplete) return;
      settled = true;
      if (graceTimer !== null) { clearTimeout(graceTimer); graceTimer = null; }
      try { abortCleanup?.(); } catch (error) { bridgeError ??= error; }
      stopForwarding();
      closeAll();
      const correlated = correlator.result();
      if (interrupted !== null && convergenceError === null) {
        process.kill(process.pid, interrupted);
        return;
      }
      resolveRun(runResult({
        processResult: leaderResult,
        transportError: bridgeError ?? leaderResult.error ?? convergenceError,
        terminal: correlated, captureError, stderr: stderrDiagnostic, degraded,
      }));
    };
    const startConvergence = () => {
      if (convergenceStarted) return;
      convergenceStarted = true;
      if (graceTimer !== null) { clearTimeout(graceTimer); graceTimer = null; }
      void convergeProcessTree(
        child,
        killGraceMs,
        processGroupConvergenceMs,
        processGroupProbe,
        processGroupSignal,
      ).then((converged) => {
        convergenceError = converged
          ? null
          : new Error(`process-group convergence timed out after ${processGroupConvergenceMs}ms`);
        convergenceComplete = true;
        finishIfReady();
      });
    };
    child.once('error', (error) => {
      leaderResult = leaderResult === null
        ? { status: null, signal: null, error }
        : { ...leaderResult, error };
      startConvergence();
    });
    child.once('exit', (code, signal) => {
      leaderResult = { status: code, signal, error: leaderResult?.error ?? null };
      startConvergence();
    });
    child.once('close', (code, signal) => {
      if (leaderResult === null) leaderResult = { status: code, signal, error: null };
      streamsFinalized = true;
      startConvergence();
      finishIfReady();
    });
  });
}

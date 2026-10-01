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
    const rawPath = options.rawPath;
    const readablePath = options.readablePath;
    let raw;
    try {
      const rawFamily = confinedLogFamily(rawPath, RAW_FAMILIES, 'raw');
      const fd = openWorkPathFd(cwd, rawPath, {
        expect: 'work-output', family: rawFamily, disposition: 'create-new', mode: 0o600,
      });
      raw = durableFdDestination(fd, options.rawWrite ?? writeSync);
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

    const liveStdout = options.liveStdout ?? process.stdout;
    const liveStderr = options.liveStderr ?? process.stderr;
    let bridgeError = null;
    let captureError = null;
    let child = null;
    let stopRequested = false;
    let graceTimer = null;
    let abortCleanup = null;
    let interrupted = null;
    let stopForwarding = () => {};
    const killGraceMs = options.killGraceMs ?? 500;
    const processGroupConvergenceMs = options.processGroupConvergenceMs ?? 1000;
    const processGroupProbe = options.processGroupProbe ?? null;
    const processGroupSignal = options.processGroupSignal ?? null;
    const requestStop = (error, captureFailure = true) => {
      if (stopRequested) return;
      stopRequested = true;
      if (error && bridgeError === null) bridgeError = error;
      if (error && captureFailure && captureError === null) captureError = error;
      killProcessTree(child, 'SIGTERM', processGroupSignal);
      graceTimer = setTimeout(
        () => killProcessTree(child, 'SIGKILL', processGroupSignal),
        killGraceMs,
      );
    };
    const writer = new BoundedMultiDestinationWriter({
      destinations: [
        { name: 'raw', role: 'raw', stream: raw },
        ...(readable === null ? [] : [{ name: 'readable', role: 'readable', stream: readable }]),
        { name: 'liveStdout', role: 'liveStdout', stream: liveStdout },
        { name: 'liveStderr', role: 'liveStderr', stream: liveStderr },
      ],
      ...(options.writerMaxPendingBytes === undefined
        ? {} : { maxPendingBytes: options.writerMaxPendingBytes }),
      ...(options.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.drainTimeoutMs }),
      onBlockingError: requestStop,
      onDegradation() { degraded = true; },
    });
    const correlator = createHeadlessResponseCorrelator(harness, {
      maxBytes: options.terminalResponseLimit ?? TERMINAL_RESPONSE_LIMIT,
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
      child = spawn(descriptor.cmd, descriptor.args, {
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
    if (options.signal) {
      const onAbort = () => requestStop(new Error('headless descriptor aborted'), false);
      if (options.signal.aborted) onAbort();
      else {
        options.signal.addEventListener('abort', onAbort, { once: true });
        abortCleanup = () => options.signal.removeEventListener('abort', onAbort);
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
    let settled = false;
    let leaderResult = null;
    let streamsFinalized = false;
    let convergenceStarted = false;
    let convergenceComplete = false;
    let convergenceError = null;
    const finishIfReady = () => {
      if (settled || leaderResult === null || !streamsFinalized || !convergenceComplete) return;
      settled = true;
      abortCleanup?.();
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
      if (graceTimer) clearTimeout(graceTimer);
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

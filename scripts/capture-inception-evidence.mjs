#!/usr/bin/env node
// Runs exactly one approved command. Descriptor writes belong to inception-state;
// stream bytes stay separate from the small recoverable binding publication.
import { spawn } from 'node:child_process';
import { closeSync, fsyncSync, writeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { beginCapture, finishCapture } from './inception-state.mjs';
import { openPublicationOutput, validateId, validatePath } from './inception-protocol.mjs';
import { writeAllSync } from './write-all.mjs';

const delay = ms => new Promise(done => setTimeout(done, ms));
async function within(promise, ms) {
  let timer;
  try { return await Promise.race([promise.then(() => true), new Promise(done => { timer = setTimeout(() => done(false), ms); })]); }
  finally { clearTimeout(timer); }
}
function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function absent(pid, ms) {
  const deadline = Date.now() + ms;
  do { if (!groupAlive(pid)) return true; await delay(10); } while (Date.now() < deadline);
  return !groupAlive(pid);
}
async function stopGroup(child, grace, convergence) {
  if (!child.pid || !groupAlive(child.pid)) return;
  for (const [signal, timeout] of [['SIGTERM', grace], ['SIGKILL', convergence]]) {
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (await absent(child.pid, timeout)) return;
  }
  throw new Error('capture process-group convergence timed out');
}
async function settleStreams(child, settlements, ms) {
  const settled = Promise.all(settlements);
  if (await within(settled, ms)) return;
  child.stdout.destroy(); child.stderr.destroy();
  if (!await within(settled, ms)) throw new Error('capture streams did not settle after destruction');
  throw new Error('capture stream settlement timed out');
}
async function execute({ root, capture, fds, writeToFd, killGraceMs, processGroupConvergenceMs, streamSettlementMs }) {
  let failure = null; let triggerFailure;
  const failed = new Promise(done => { triggerFailure = done; });
  const stop = error => { failure ??= error instanceof Error ? error : new Error(String(error)); triggerFailure(); };
  const child = spawn(capture.command.executable, capture.command.args, { cwd: join(root, capture.command.cwd), shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const onTerm = () => stop(new Error('collector interrupted by SIGTERM'));
  const onInt = () => stop(new Error('collector interrupted by SIGINT'));
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
  const streams = [child.stdout, child.stderr].map((stream, index) => new Promise(done => {
    let settled = false;
    const settle = () => { if (!settled) { settled = true; done(); } };
    stream.on('data', chunk => { if (failure) return; try { writeAllSync(fds[index], chunk, writeToFd); } catch (error) { stop(error); } });
    stream.once('end', settle); stream.once('close', settle); stream.once('error', error => { stop(error); settle(); });
  }));
  const leader = new Promise(done => {
    child.once('error', error => { stop(error); done({ exitCode: null, signal: null }); });
    child.once('exit', (exitCode, signal) => done({ exitCode, signal }));
  });
  // One awaited cleanup owns both success and failure; no descriptor can close
  // while a stream callback can still write. Normal leader exit also cleans up
  // descendants that keep pipes open or ignore TERM.
  try {
    const first = await Promise.race([leader, failed.then(() => null)]);
    const cleanup = await Promise.allSettled([
      stopGroup(child, killGraceMs, processGroupConvergenceMs),
      settleStreams(child, streams, streamSettlementMs),
    ]);
    const errors = cleanup.filter(item => item.status === 'rejected').map(item => item.reason);
    if (failure) { if (errors.length) failure.cleanupError = new AggregateError(errors); throw failure; }
    if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '));
    return first;
  } finally { process.removeListener('SIGTERM', onTerm); process.removeListener('SIGINT', onInt); }
}

export async function collectInceptionEvidence(options = {}) {
  for (const key of Object.keys(options)) if (!['repoRoot', 'cycle', 'check', 'unit', 'purpose', 'platform', 'writeToFd', 'closeFd', 'killGraceMs', 'processGroupConvergenceMs', 'streamSettlementMs', 'fault'].includes(key)) throw new Error(`unknown capture option: ${key}`);
  const { repoRoot, cycle, check, unit, purpose = 'check', platform = process.platform, writeToFd = writeSync, closeFd = closeSync, killGraceMs = 500, processGroupConvergenceMs = 1000, streamSettlementMs = 1500, fault } = options;
  if (platform !== 'linux' && platform !== 'darwin') throw new Error(`unsupported platform for process-group capture: ${platform}`);
  const begun = beginCapture(repoRoot, { cycle, check, unit, purpose });
  if (begun.recovery) {
    if (begun.recovery.outcome === 'incomplete') throw new Error('capture remains incomplete; no command was rerun');
    return begun.recovery;
  }
  const { root, capture } = begun;
  const fds = []; let result; let failure = null;
  const startedAt = new Date().toISOString();
  try {
    fault?.('after-begin', { capture });
    fds.push(openPublicationOutput(root, capture.stdoutPath));
    fds.push(openPublicationOutput(root, capture.stderrPath));
    result = await execute({ root, capture, fds, writeToFd, killGraceMs, processGroupConvergenceMs, streamSettlementMs });
    for (const fd of fds) fsyncSync(fd);
  } catch (error) { failure = error; }
  finally {
    for (const fd of fds) { try { closeFd(fd); } catch (error) { failure ??= error; } }
  }
  if (failure) {
    // Cleanup failure is uncertainty: do not publish a terminal stopped claim.
    if (!failure.cleanupError && !/convergence|settle/iu.test(failure.message)) {
      try { finishCapture(root, { unit, token: capture.token, failure: 'Capture failed after stream settlement' }); }
      catch (registrationError) { failure.registrationError = registrationError; }
    }
    throw failure;
  }
  const endedAt = new Date().toISOString();
  fault?.('before-finish', { capture });
  return finishCapture(root, { unit, token: capture.token, startedAt, endedAt, ...result, fault: (event, detail) => {
    fault?.(event, detail);
    if (event === 'after-rename' && detail.path === capture.receiptPath) fault?.('after-receipt', detail);
  } });
}

export async function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: Object.fromEntries(['repo-root', 'cycle', 'check', 'unit', 'purpose'].map(key => [key, { type: 'string' }])), strict: true, allowPositionals: false }));
    if (!values['repo-root'] || !values.cycle || !values.check || !values.unit) throw new Error('required: --repo-root --cycle --check --unit');
    validatePath(values.cycle); validateId(values.check); validateId(values.unit);
    if (values.purpose !== undefined && !['check', 'revalidate'].includes(values.purpose)) throw new Error('purpose must be check or revalidate');
  } catch (error) { console.error(`steepy capture-inception-evidence: ${error.message}`); return 2; }
  try {
    const result = await collectInceptionEvidence({ repoRoot: values['repo-root'], cycle: values.cycle, check: values.check, unit: values.unit, purpose: values.purpose });
    console.log(JSON.stringify(result)); return 0;
  } catch (error) { console.error(`steepy capture-inception-evidence: ${error.message}`); return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();

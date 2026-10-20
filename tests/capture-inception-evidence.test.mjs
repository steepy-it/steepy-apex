import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, writeSync, closeSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as state from '../scripts/inception-state.mjs';
import { createRunDescriptorV2, serializeRunDescriptorV2 } from '../scripts/inception-protocol.mjs';

const area = '.apex/inception';
const script = fileURLToPath(new URL('../scripts/capture-inception-evidence.mjs', import.meta.url));
const stateScript = fileURLToPath(new URL('../scripts/inception-state.mjs', import.meta.url));
const environment = { tools: [], resources: [] };
const command = code => ({ executable: process.execPath, args: ['-e', code], cwd: '.', successExitCodes: [0] });
const read = root => JSON.parse(readFileSync(join(root, area, 'run.json')));
function fixture({ code = "process.stdout.write('hello'); process.stderr.write('error')", successExitCodes = [0], executable = process.execPath, type = 'automatic', reuse = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'steepy-inception-capture-'));
  mkdirSync(join(root, area, 'project'), { recursive: true });
  const descriptor = createRunDescriptorV2({ runId: 'inc-20261012T120000Z-12345678', harnessName: 'codex', git: { present: false, branch: null, commits: 'none' } });
  writeFileSync(join(root, area, 'run.json'), serializeRunDescriptorV2(descriptor));
  writeFileSync(join(root, 'app.js'), 'app');
  for (const to of ['architecture', 'research', 'approval']) state.transitionRun(root, { to, reason: 'Ready' });
  writeFileSync(join(root, area, 'project/decision-register.md'), 'Approved');
  const contract = { schema: 'steepy-inception-checks/v2', roots: ['.'], exclusions: [], environment: { tools: [], resources: [] }, checks: [{ id: 'test', required: true, type, subject: 'Application', procedure: 'Run check', expected: 'Expected exit', evidenceRequired: 'Full streams', automatic: { ...command(code), executable, successExitCodes }, manual: type === 'both' ? { procedure: 'Open page', acceptance: 'Readable' } : null, reuse: reuse ?? { policy: 'snapshot', automatic: null, manual: null } }], coverage: [{ id: 'app', component: 'App', checks: ['test'], status: 'current' }] };
  writeFileSync(join(root, area, 'project/verification-contract.json'), JSON.stringify(contract));
  state.approveRun(root, { statement: 'Approved', documents: [`${area}/project/decision-register.md`], contract: `${area}/project/verification-contract.json` });
  for (const to of ['bootstrap', 'verification']) state.transitionRun(root, { to, reason: 'Ready' });
  state.beginVerification(root, { environment, reason: 'Verify' });
  begin(root, 'check');
  return root;
}
function begin(root, id) {
  state.beginUnit(root, { id, input: { kind: 'check', inputs: [], outputs: [{ path: `${area}/project/${id}.md`, role: 'report' }], allowedPaths: [] } });
  writeFileSync(join(root, area, 'project', `${id}.md`), `<!-- steepy-inception-unit: v2; id: ${id}; status: DONE -->\nComplete observation.\n<!-- steepy-inception-unit-end: ${id} -->\n`);
}
const options = (root, unit = 'check', purpose = 'check') => ({ repoRoot: root, cycle: read(root).currentCycle.path, check: 'test', unit, purpose });
const status = root => state.verificationStatus(root, { cycle: read(root).currentCycle.path }).checks[0].result;
const cli = root => spawnSync(process.execPath, [script, '--repo-root', root, '--cycle', read(root).currentCycle.path, '--check', 'test', '--unit', 'check'], { encoding: 'utf8' });

for (const [code, exits, expected] of [[0, [0], 'succeeded'], [7, [7], 'succeeded'], [7, [0], 'failed']]) {
  test(`collector streams binary output and binds exit ${code} (${expected})`, async () => {
    const root = fixture({ code: `process.stdout.write(Buffer.alloc(1048577, 0xff)); process.stderr.write(Buffer.alloc(524289, 0x80)); process.exitCode=${code}`, successExitCodes: exits });
    try {
      const result = cli(root); assert.equal(result.status, 0, result.stderr);
      const compact = JSON.parse(result.stdout); assert.equal(compact.outcome, expected); assert.ok(result.stdout.length < 1000);
      const descriptor = read(root); const attempt = descriptor.units[0].capture;
      const receipt = JSON.parse(readFileSync(join(root, compact.path)));
      assert.equal(attempt.state, 'captured'); assert.equal(receipt.command.successExitCodes[0], exits[0]);
      assert.equal(receipt.stdout.bytes, 1048577); assert.equal(receipt.stderr.bytes, 524289);
      assert.deepEqual(readFileSync(join(root, receipt.stdout.path)), Buffer.alloc(1048577, 0xff));
      assert.equal(status(root), 'not-executed'); state.finishUnit(root, { id: 'check' }); assert.equal(status(root), expected);
      assert.equal(read(root).pending, null); assert.ok(!JSON.stringify(read(root).publications).includes('contentBase64'));
      writeFileSync(join(root, receipt.stderr.path), 'tampered'); assert.throws(() => status(root), /digest/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('both combines automatic and manual observations in either order', async () => {
  const { collectInceptionEvidence } = await import('../scripts/capture-inception-evidence.mjs');
  for (const order of ['automatic', 'manual']) {
    const root = fixture({ type: 'both' });
    try {
      const attest = () => state.attestVerification(root, { cycle: read(root).currentCycle.path, input: { checks: [{ id: 'test', procedure: 'Open page', result: 'succeeded', observed: 'Readable' }], statement: 'I checked the page', environment, purpose: 'check' } });
      if (order === 'manual') attest();
      await collectInceptionEvidence(options(root));
      if (order === 'automatic') attest();
      state.finishUnit(root, { id: 'check' }); assert.equal(status(root), 'succeeded');
      const refs = read(root).units[0].evidence.filter(r => r.path.includes('/results/'));
      const result = JSON.parse(readFileSync(join(root, refs.at(-1).path))).body;
      assert.ok(result.automatic); assert.ok(result.manual); assert.equal(result.result, 'succeeded');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('short writes preserve every byte; capture failure settles and closes each stream exactly once', async () => {
  const { collectInceptionEvidence } = await import('../scripts/capture-inception-evidence.mjs');
  for (const fail of [false, true]) {
    const root = fixture({ code: fail ? "process.on('SIGTERM',()=>{}); process.stdout.write('x'); setInterval(()=>{},1000)" : "process.stdout.write('abcdefghijkl'); process.stderr.write('123456789')" });
    const closes = new Map();
    try {
      const run = collectInceptionEvidence({ ...options(root), writeToFd: (fd, bytes, offset, length) => { if (fail) throw new Error('stream disk failure'); return writeSync(fd, bytes, offset, Math.min(length, 3)); }, closeFd: fd => { closes.set(fd, (closes.get(fd) ?? 0) + 1); closeSync(fd); }, killGraceMs: 30 });
      if (fail) {
        const error = await run.then(() => assert.fail('capture must fail'), error => error);
        assert.match(error.message, /stream disk failure/);
        // Preserve fail-closed cleanup: expose the actual uncertainty before the
        // terminal-state assertion instead of obscuring it as running/incomplete.
        assert.equal(error.cleanupError, undefined, error.cleanupError?.errors?.map(e => e.stack).join('\n'));
        assert.equal(error.registrationError, undefined, error.registrationError?.stack);
        assert.equal(read(root).units[0].capture.state, 'incomplete');
      }
      else { const compact = await run; const receipt = JSON.parse(readFileSync(join(root, compact.path))); assert.equal(readFileSync(join(root, receipt.stdout.path), 'utf8'), 'abcdefghijkl'); }
      assert.equal(closes.size, 2); assert.deepEqual([...closes.values()], [1, 1]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('signal exit is a complete red capture; application drift refuses binding', async () => {
  const { collectInceptionEvidence } = await import('../scripts/capture-inception-evidence.mjs');
  for (const drift of [false, true]) {
    const root = fixture({ code: drift ? "require('node:fs').writeFileSync('app.js','changed')" : "process.kill(process.pid,'SIGTERM')" });
    try {
      if (drift) await assert.rejects(collectInceptionEvidence(options(root)), /drift/);
      else { const output = await collectInceptionEvidence(options(root)); assert.equal(output.signal, 'SIGTERM'); assert.equal(output.outcome, 'failed'); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('automatic reobservation refreshes a session without rerunning the primary command', async () => {
  const { collectInceptionEvidence } = await import('../scripts/capture-inception-evidence.mjs');
  const root = fixture({ reuse: { policy: 'reobserve', automatic: command("process.stdout.write('refresh')"), manual: null } });
  try {
    await collectInceptionEvidence(options(root)); state.finishUnit(root, { id: 'check' }); assert.equal(status(root), 'succeeded');
    state.resumeVerification(root, { cycle: read(root).currentCycle.path }); assert.equal(status(root), 'not-executed');
    begin(root, 'refresh'); const output = await collectInceptionEvidence(options(root, 'refresh', 'revalidate'));
    const receipt = JSON.parse(readFileSync(join(root, output.path))); assert.equal(readFileSync(join(root, receipt.stdout.path), 'utf8'), 'refresh');
    state.finishUnit(root, { id: 'refresh' }); assert.equal(status(root), 'succeeded');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const boundary of ['before-finish', 'after-reserve', 'after-receipt', 'before-bind']) {
  test(`dead collector recovery at ${boundary} never reruns the command`, () => {
    const root = fixture();
    try {
      const source = `import { collectInceptionEvidence } from ${JSON.stringify(new URL('../scripts/capture-inception-evidence.mjs', import.meta.url).href)}; await collectInceptionEvidence({ ...${JSON.stringify(options(root))}, fault: (event, detail) => { if(event === ${JSON.stringify(boundary)} || (${JSON.stringify(boundary)} === 'after-receipt' && event === 'after-target' && detail.path?.endsWith('/receipt.json'))) process.exit(91); } });`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' }); assert.equal(child.status, 91, child.stderr);
      const before = read(root); assert.ok(before.units[0].capture);
      const result = state.recoverCapture(root, { unit: 'check' });
      if (boundary === 'before-finish') { assert.equal(result.outcome, 'incomplete'); assert.equal(read(root).units[0].capture.state, 'incomplete'); }
      else { assert.equal(result.outcome, 'succeeded'); state.finishUnit(root, { id: 'check' }); assert.equal(status(root), 'succeeded'); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('live or unverifiable collector cannot be recovered; foreign command and receipt inputs are refused', async () => {
  const root = fixture();
  try {
    assert.equal(typeof state.beginCapture, 'function');
    state.beginCapture(root, { cycle: read(root).currentCycle.path, check: 'test', unit: 'check' });
    assert.throws(() => state.recoverCapture(root, { unit: 'check' }), /alive|live/);
    assert.throws(() => state.recoverCapture(root, { unit: 'check', probe: () => { throw Object.assign(new Error('unknown'), { code: 'EPERM' }); } }), /unverifiable|alive|live/);
    const revision = read(root).revision;
    const bad = spawnSync(process.execPath, [script, '--repo-root', root, '--cycle', read(root).currentCycle.path, '--check', 'test', '--unit', 'check', '--command', 'true'], { encoding: 'utf8' });
    assert.equal(bad.status, 2); assert.equal(read(root).revision, revision);
    const helper = spawnSync(process.execPath, [stateScript, 'import-receipt', '--repo-root', root], { encoding: 'utf8' }); assert.equal(helper.status, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unsupported runtime refuses before any capture reservation or command', async () => {
  const { collectInceptionEvidence } = await import('../scripts/capture-inception-evidence.mjs'); const root = fixture();
  try { const before = readFileSync(join(root, area, 'run.json')); await assert.rejects(collectInceptionEvidence({ ...options(root), platform: 'win32' }), /unsupported platform/); assert.deepEqual(readFileSync(join(root, area, 'run.json')), before); assert.equal(existsSync(join(root, area, 'verification/captures')), false); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('API refuses alternative command, external receipt and forged finish ownership before writes', async () => {
  const { collectInceptionEvidence } = await import('../scripts/capture-inception-evidence.mjs'); const root = fixture();
  try {
    const revision = read(root).revision;
    await assert.rejects(collectInceptionEvidence({ ...options(root), command: command('process.exit(0)') }), /unknown|unexpected|option/);
    assert.throws(() => state.beginCapture(root, { cycle: read(root).currentCycle.path, check: 'test', unit: 'check', receipt: 'external.json' }), /unknown|unexpected|option/);
    assert.equal(read(root).revision, revision);
    const { capture } = state.beginCapture(root, { cycle: read(root).currentCycle.path, check: 'test', unit: 'check' });
    assert.throws(() => state.finishCapture(root, { unit: 'check', token: 'f'.repeat(64), failure: 'Fake failure' }), /owned|reservation/);
    assert.equal(read(root).units[0].capture.token, capture.token);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('generic publication resume cannot take over a live capture writer', async () => {
  const { collectInceptionEvidence } = await import('../scripts/capture-inception-evidence.mjs'); const root = fixture();
  try {
    await assert.rejects(collectInceptionEvidence({ ...options(root), fault: event => { if (event === 'after-reserve') throw new Error('pause binding'); } }), /pause binding/);
    const pending = read(root).pending;
    assert.throws(() => state.resumePublication(root, { reservation: pending.id }), /alive|live/);
    assert.equal(read(root).pending.id, pending.id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('automatic applicability verifies bound result and report digests too', async () => {
  const { collectInceptionEvidence } = await import('../scripts/capture-inception-evidence.mjs'); const root = fixture();
  try {
    await collectInceptionEvidence(options(root)); state.finishUnit(root, { id: 'check' });
    const resultRef = read(root).units[0].evidence.find(r => r.path.includes('/results/'));
    writeFileSync(join(root, resultRef.path), '{}'); assert.throws(() => status(root), /digest/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('capture failure kills a ready TERM-ignoring process group before closing output descriptors', async () => {
  const { collectInceptionEvidence } = await import('../scripts/capture-inception-evidence.mjs');
  const descendant = "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)";
  const root = fixture({ code: `const {spawn}=require('node:child_process'); process.on('SIGTERM',()=>{}); const sub=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit','ipc']}); sub.once('message',()=>process.stdout.write(String(process.pid))); setInterval(()=>{},1000)` });
  let pid; const closedGroups = [];
  try {
    const error = await collectInceptionEvidence({ ...options(root), killGraceMs: 100, processGroupConvergenceMs: 5000, streamSettlementMs: 5000,
      writeToFd: (fd, bytes) => { pid = Number(bytes.toString()); throw new Error('injected write failure'); },
      closeFd: fd => { closeSync(fd); try { process.kill(-pid, 0); closedGroups.push('alive'); } catch (error) { closedGroups.push(error.code); } },
    }).then(() => assert.fail('capture must fail'), error => error);
    assert.match(error.message, /injected write failure/); assert.equal(error.cleanupError, undefined, String(error.cleanupError));
    assert.deepEqual(closedGroups, ['ESRCH', 'ESRCH'], 'both output closes observe group absence');
    assert.equal(read(root).units[0].capture.state, 'incomplete');
  } finally { if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch {} } rmSync(root, { recursive: true, force: true }); }
});

test('collector SIGTERM waits for child-group cleanup and leaves an incomplete attempt', async () => {
  const { spawn } = await import('node:child_process');
  const root = fixture({ code: "process.on('SIGTERM',()=>{}); process.stdout.write(String(process.pid)); setInterval(()=>{},1000)" });
  let child; let pid;
  try {
    child = spawn(process.execPath, [script, '--repo-root', root, '--cycle', read(root).currentCycle.path, '--check', 'test', '--unit', 'check'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const finished = new Promise(done => child.once('exit', (code, signal) => done({ code, signal })));
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const attempt = read(root).units[0].capture;
      if (attempt && existsSync(join(root, attempt.stdoutPath))) { const text = readFileSync(join(root, attempt.stdoutPath), 'utf8'); if (text) { pid = Number(text); break; } }
      await new Promise(done => setTimeout(done, 20));
    }
    assert.ok(pid, 'child announced its PID'); child.kill('SIGTERM');
    const result = await finished; assert.deepEqual(result, { code: 1, signal: null });
    assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' }); assert.equal(read(root).units[0].capture.state, 'incomplete');
  } finally { child?.kill('SIGKILL'); if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch {} } rmSync(root, { recursive: true, force: true }); }
});

for (const tamper of ['stream', 'cycle', 'command', 'source']) {
  test(`dead capture recovery refuses ${tamper} divergence without rerunning`, () => {
    const root = fixture();
    try {
      const source = `import { collectInceptionEvidence } from ${JSON.stringify(new URL('../scripts/capture-inception-evidence.mjs', import.meta.url).href)}; await collectInceptionEvidence({ ...${JSON.stringify(options(root))}, fault: event => { if(event === 'before-bind') process.exit(91); } });`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' }); assert.equal(child.status, 91, child.stderr);
      const descriptor = read(root); const attempt = descriptor.units[0].capture;
      if (tamper === 'stream') writeFileSync(join(root, attempt.stdoutPath), 'truncated');
      if (tamper === 'source') writeFileSync(join(root, 'app.js'), 'changed');
      if (tamper === 'cycle' || tamper === 'command') {
        const path = join(root, attempt.receiptPath); const receipt = JSON.parse(readFileSync(path));
        if (tamper === 'cycle') receipt.cycle.path = `${area}/verification/cycles/9999.json`;
        else receipt.command.args = ['-e', 'process.exit(0)'];
        writeFileSync(path, JSON.stringify(receipt));
      }
      assert.throws(() => state.recoverCapture(root, { unit: 'check' }), /digest|diverg|drift/);
      assert.equal(read(root).units[0].capture.state, 'running'); assert.equal(read(root).pending.id, descriptor.pending.id);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('both reobservation procedures must succeed in the resumed session', async () => {
  const { collectInceptionEvidence } = await import('../scripts/capture-inception-evidence.mjs');
  const root = fixture({ type: 'both', reuse: { policy: 'reobserve', automatic: command('process.exit(0)'), manual: { procedure: 'Reopen page', acceptance: 'Readable' } } });
  const attest = purpose => state.attestVerification(root, { cycle: read(root).currentCycle.path, input: { checks: [{ id: 'test', procedure: purpose === 'check' ? 'Open page' : 'Reopen page', result: 'succeeded', observed: 'Readable' }], statement: 'I observed the page', environment, purpose } });
  try {
    await collectInceptionEvidence(options(root)); attest('check'); state.finishUnit(root, { id: 'check' }); assert.equal(status(root), 'succeeded');
    state.resumeVerification(root, { cycle: read(root).currentCycle.path }); begin(root, 'refresh-auto');
    await collectInceptionEvidence(options(root, 'refresh-auto', 'revalidate')); state.finishUnit(root, { id: 'refresh-auto' }); assert.equal(status(root), 'not-executed');
    begin(root, 'refresh-manual'); attest('revalidate'); state.finishUnit(root, { id: 'refresh-manual' }); assert.equal(status(root), 'succeeded');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spawn failure leaves an incomplete capture with no imported receipt', async () => {
  const { collectInceptionEvidence } = await import('../scripts/capture-inception-evidence.mjs');
  const root = fixture({ executable: '/steepy-nonexistent-synthetic-command' });
  try {
    await assert.rejects(collectInceptionEvidence(options(root)), /ENOENT/);
    const attempt = read(root).units[0].capture;
    assert.equal(attempt.state, 'incomplete'); assert.equal(attempt.receipt, null); assert.equal(existsSync(join(root, attempt.receiptPath)), false);
    assert.throws(() => state.finishUnit(root, { id: 'check' }), /incomplete/);
    assert.throws(() => begin(root, 'retry'), /activeUnit/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a plausible handwritten receipt has no provenance without a registered attempt', async () => {
  const { collectInceptionEvidence } = await import('../scripts/capture-inception-evidence.mjs');
  const origin = fixture(); const root = fixture();
  try {
    const compact = await collectInceptionEvidence(options(origin));
    const directory = join(root, area, 'verification/captures', String(read(root).nextRecord).padStart(4, '0'));
    mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'receipt.json'), readFileSync(join(origin, compact.path)));
    const descriptor = readFileSync(join(root, area, 'run.json'));
    await assert.rejects(collectInceptionEvidence(options(root)), /foreign/);
    assert.throws(() => state.recoverCapture(root, { unit: 'check' }), /registered/);
    assert.deepEqual(readFileSync(join(root, area, 'run.json')), descriptor);
  } finally { rmSync(origin, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

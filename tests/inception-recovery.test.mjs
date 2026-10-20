import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fixture, area, check, contract, command, governanceInput, script, moduleURL, v1RunDescriptorText } from './helpers/inception-fixture.mjs';
import { parseRunDescriptorV2, serializeRunDescriptorV2 } from '../scripts/inception-protocol.mjs';
import { planProjectScaffold } from '../scripts/project-scaffold.mjs';
import { GOVERNANCE_PENDING, GOVERNANCE_RECEIPT } from '../scripts/inception-governance.mjs';

test('M01 CLI session recovery preserves completed work without a resume note', t => {
  const f = fixture(t);
  f.begin('survey'); f.report('survey'); f.finish('survey');
  const before = f.snapshot();
  assert.equal(f.cli('resume-check').ok, true);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.descriptor().resumeNotes.length, 0);
});

for (const phase of ['reconnaissance', 'architecture', 'research', 'approval', 'bootstrap', 'verification']) {
  test(`M01 ${phase}: new process resumes exact completed identity; missing report cannot finish`, t => {
    const f = fixture(t, { phase });
    f.begin('work', { kind: phase === 'verification' ? 'check' : 'decision' });
    const before = f.snapshot();
    f.refuse('unit', 'finish', '--id', 'work');
    assert.deepEqual(f.snapshot(), before);
    f.report('work'); f.finish('work');
    f.put(`${area}/research/unrelated.md`, 'Do not open this report');
    f.put('.apex/work/unrelated.md', 'Do not inspect work');
    const completed = f.snapshot();
    const inspected = f.audit(['inspect'], { forbiddenReads: [`${area}/research/unrelated.md`, '.apex/work'] });
    assert.equal(inspected.result.phase, phase);
    assert.equal(f.audit(['resume-check'], { forbiddenReads: [`${area}/research/unrelated.md`, '.apex/work'] }).result.ok, true);
    assert.deepEqual(f.snapshot(), completed);
    const retryInput = f.input({ kind: 'decision', inputs: [], outputs: [{ path: `${area}/project/work.md`, role: 'report' }], allowedPaths: [] });
    f.refuse('unit', 'begin', '--id', 'work', '--input', retryInput);
    assert.equal(f.descriptor().units.length, 1);
    assert.equal(f.descriptor().resumeNotes.length, 0);
  });
}

test('M02 approval recovery asks before approval, advances once after approval, and rejects changed documents', t => {
  const f = fixture(t, { phase: 'approval' });
  f.cli('resume-check'); f.refuse('transition', '--to', 'bootstrap', '--reason', 'Missing approval');
  assert.equal(f.descriptor().approvals.length, 0);
  f.approve(); const frozen = f.snapshot(`${area}/approvals`);
  f.cli('resume-check'); f.refuse('transition', '--to', 'approval', '--reason', 'Duplicate approval');
  f.transition('bootstrap');
  f.put(`${area}/project/decision-register.md`, 'Changed approved decision');
  assert.equal(f.refuse('resume-check').ok, false);
  f.refuse('transition', '--to', 'verification', '--reason', 'Stale approval');
  f.transition('approval'); f.approve(); f.transition('bootstrap');
  for (const [path, metadata] of Object.entries(frozen)) assert.deepEqual(f.snapshot(`${area}/approvals`)[path], metadata);
  assert.equal(f.descriptor().approvals.length, 2);
});

test('M02 a blocked run with an edited approved document unblocks and returns to approval; forward gates still refuse', t => {
  const f = fixture(t, { phase: 'bootstrap' });
  f.transition('blocked');
  f.put(`${area}/project/decision-register.md`, 'Edited approved decisions');
  f.transition('active');
  assert.match(f.refuse('transition', '--to', 'verification', '--reason', 'Stale approval').error, /decision-register\.md: reference digest diverges/);
  assert.match(f.refuse('verify-approval').error, /decision-register\.md: reference digest diverges/);
  f.transition('approval'); f.approve(); f.transition('bootstrap');
  assert.equal(f.descriptor().approvals.length, 2);
});

test('M02 an older approval verifies its frozen copies after a reapproval changed the working documents', t => {
  const f = fixture(t, { phase: 'bootstrap' });
  const older = f.descriptor().approvals[0].path;
  f.transition('approval');
  f.put(`${area}/project/decision-register.md`, 'Revised approved decisions');
  f.approve();
  assert.equal(f.cli('verify-approval').ok, true);
  assert.equal(f.cli('verify-approval', '--approval', older).ok, true);
  // Control: the older approval still authenticates its own frozen copy.
  const frozen = f.read(older).body.frozenDocuments.find(d => d.sourcePath.endsWith('decision-register.md')).artifact.path;
  f.put(frozen, 'Forged frozen copy');
  assert.match(f.refuse('verify-approval', '--approval', older).error, /reference digest diverges/);
});

test('M11 a terminal reservation binds after an approved working document changes; verify-complete reports it', t => {
  const f = fixture(t, { phase: 'verification' }); f.manual('verified', ['app']); const checkpoint = f.checkpoint();
  f.crash('inception-state', `api.transitionRun(root,{to:'complete',reason:'Verified',cycle:${JSON.stringify(f.cycle())},checkpoint:${JSON.stringify(checkpoint)},reservation:'terminal',fault:event=>{if(event==='after-reserve')process.exit(73)}});`);
  f.put(`${area}/project/decision-register.md`, 'Changed after the terminal commit point');
  f.cli('publish', 'resume', '--reservation', 'terminal');
  assert.equal(f.descriptor().status, 'complete'); assert.equal(f.descriptor().pending, null);
  const verified = f.refuse('verify-complete');
  assert.equal(verified.ok, false);
  assert.match(verified.reason, /decision-register\.md: reference digest diverges/);
});

for (const type of ['automatic', 'manual', 'both']) {
  test(`M03 required ${type} missing/red refuses complete; optional red survives successful closure`, t => {
    const required = check('required', type, type === 'manual' ? {} : { automatic: command('process.exit(7)') });
    const f = fixture(t, { phase: 'verification', checks: [required, check('optional', 'manual', { required: false })] });
    f.complete(1);
    if (type !== 'manual') f.automatic('automatic-red', 'required');
    if (type !== 'automatic') f.manual('manual-red', ['required'], 'failed');
    f.manual('optional-red', ['optional'], 'failed');
    f.complete(1);
    assert.equal(f.status().checks.find(c => c.id === 'optional').result, 'failed');
    if (type !== 'manual') {
      // Explicit approval of a repaired check command opens a new cycle. No
      // editing required/type/outcome to manufacture a green summary.
      f.transition('approval'); f.contract.checks[0].automatic = command('process.exit(0)');
      f.json(`${area}/project/verification-contract.json`, f.contract); f.approve(); f.transition('bootstrap'); f.transition('verification'); f.beginCycle();
      f.automatic('automatic-green', 'required');
      if (type === 'both') f.complete(1);
    }
    if (type !== 'automatic') f.manual('manual-green', ['required']);
    if (type !== 'manual') f.manual('optional-red-current', ['optional'], 'failed');
    f.complete(); const verified = f.cli('verify-complete');
    assert.equal(verified.ok, true);
    assert.equal(verified.checks.find(c => c.id === 'optional').result, 'failed');
    assert.equal(verified.coverage.find(c => c.id === 'later').status, 'future');
  });
}

test('M04 application fix and contract reapproval invalidate every required result and preserve history', t => {
  const f = fixture(t, { phase: 'verification', checks: [check('auto', 'automatic'), check('manual'), check('both', 'both')] });
  const satisfy = suffix => { f.automatic(`auto-${suffix}`, 'auto'); f.automatic(`both-${suffix}`, 'both'); f.manual(`manual-${suffix}`, ['manual', 'both']); };
  satisfy('original'); const originalCycle = f.cycle(); const historical = f.snapshot(`${area}/verification`);
  f.begin('fix', { kind: 'bootstrap', allowedPaths: ['src/app.js'] }); f.put('src/app.js', 'Fixed application\n'); f.report('fix'); f.finish('fix'); f.beginCycle();
  assert.notEqual(f.cycle(), originalCycle); assert.ok(f.status().checks.every(c => c.result === 'not-executed'));
  f.complete(1); satisfy('fixed');
  const fixedCycle = f.cycle(); f.transition('approval'); f.contract.checks[1].expected = 'Works after explicit scope confirmation';
  f.json(`${area}/project/verification-contract.json`, f.contract); f.approve(); f.transition('bootstrap'); f.transition('verification'); f.beginCycle();
  assert.notEqual(f.cycle(), fixedCycle); assert.ok(f.status().checks.every(c => c.result === 'not-executed'));
  satisfy('reapproved'); f.complete();
  const after = f.snapshot(`${area}/verification`);
  for (const [path, bytes] of Object.entries(historical)) assert.deepEqual(after[path], bytes, path);
});

test('M05 pause preserves snapshot results and requires only approved session reobservation', t => {
  const f = fixture(t, { phase: 'verification', checks: [check('stable', 'automatic'), check('service', 'both', { reuse: { policy: 'reobserve', automatic: command('process.stdout.write("reobserved")'), manual: { procedure: 'Reopen service', acceptance: 'Same service' } } })] });
  f.automatic('stable-once', 'stable'); f.automatic('service-once', 'service'); f.manual('service-human', ['service']);
  const cycle = f.cycle(); const original = f.descriptor().units.map(u => structuredClone(u));
  const before = f.snapshot(); f.cli('resume-check'); assert.deepEqual(f.snapshot(), before);
  f.cli('verification', 'resume', '--cycle', cycle);
  assert.equal(f.status().checks.find(c => c.id === 'stable').result, 'succeeded');
  assert.equal(f.status().checks.find(c => c.id === 'service').result, 'not-executed');
  f.automatic('reobserve-auto', 'service', 'revalidate'); f.complete(1);
  f.manual('reobserve-human', ['service'], 'succeeded', 'revalidate'); f.complete();
  assert.equal(f.cycle(), cycle); assert.deepEqual(f.descriptor().units.slice(0, original.length), original);
  assert.equal(f.descriptor().units.filter(u => u.capture?.checkId === 'stable').length, 1);
});

test('M06 ambiguous and partial external observations never replay or bypass required manual proof', t => {
  const f = fixture(t, { phase: 'verification' });
  f.begin('remote', { kind: 'bootstrap' });
  const evidence = `${area}/project/observation.json`; const correlation = [{ name: 'operation', value: 'exact-operation-token' }];
  const intent = { id: 'provision', kind: 'remote', summary: 'Provision once', command: null, procedure: 'Create once', scope: [], authorization: 'User approved this exact operation', correlation, observation: { procedure: 'Read operation identity', expected: 'Exact operation identity matches', evidencePaths: [evidence] } };
  const intentPath = f.input(intent); f.cli('effect', 'intent', '--id', 'provision', '--input', intentPath);
  const outcome = result => f.input({ result, observed: 'Resource observed', correlation, evidence: [evidence] });
  f.json(evidence, { name: 'same-looking-resource' }); f.refuse('effect', 'reconcile', '--id', 'provision', '--input', outcome('succeeded'));
  assert.equal(f.refuse('resume-check').next, 'effect reconcile');
  f.json(evidence, { id: 'provision', procedure: 'Read operation identity', result: 'partial', correlation, observed: 'Resource observed' });
  f.cli('effect', 'reconcile', '--id', 'provision', '--input', outcome('partial'));
  f.refuse('effect', 'intent', '--id', 'provision', '--input', intentPath);
  assert.deepEqual(f.cli('effect', 'status').unresolved, ['provision']);
  f.json(evidence, { id: 'provision', procedure: 'Read operation identity', result: 'succeeded', correlation, observed: 'Resource observed' });
  f.cli('effect', 'reconcile', '--id', 'provision', '--input', outcome('succeeded'));
  f.report('remote'); f.finish('remote'); f.complete(1);
  assert.equal(f.status().checks[0].result, 'not-executed');
  f.manual('human-check', ['app']); f.complete();
  assert.equal(f.descriptor().effects.length, 3);
});

for (const git of [false, true]) test(`M07/M09 ${git ? 'Git' : 'no Git'} checkpoint cannot erase add/delete/mode/config/provider drift`, t => {
  const f = fixture(t, { phase: 'verification', git, initialFiles: { '.gitignore': 'generated/\n' }, approvedContract: contract(undefined, { exclusions: [{ path: 'generated', kind: 'generated', reason: 'Disposable output' }] }) });
  f.manual('verified', ['app']); const cycle = f.cycle();
  f.begin('generate', { kind: 'bootstrap', allowedPaths: ['generated'] });
  f.put('generated/result.log', 'Excluded output'); f.report('generate'); f.finish('generate');
  assert.equal(f.cli('resume-check').ok, true); f.beginCycle(); assert.equal(f.cycle(), cycle);
  for (const mutation of ['add', 'delete', 'mode', 'config', 'provider']) {
    const app = join(f.root, 'src/app.js'); const bytes = fs.readFileSync(app); const mode = fs.statSync(app).mode & 0o7777;
    const path = mutation === 'add' ? 'src/new.js' : mutation === 'config' ? 'package-lock.json' : '.codex/config.toml';
    if (mutation === 'delete') fs.unlinkSync(app); else if (mutation === 'mode') fs.chmodSync(app, mode ^ 0o100); else f.put(path, 'Unexplained input');
    const before = f.snapshot();
    f.refuse('checkpoint', 'create', '--label', 'Cannot reset baseline'); f.refuse('resume-check'); assert.deepEqual(f.snapshot(), before);
    if (mutation === 'delete') fs.writeFileSync(app, bytes); else if (mutation === 'mode') fs.chmodSync(app, mode); else fs.unlinkSync(join(f.root, path));
  }
  f.complete(); assert.equal(f.cli('verify-complete').ok, true);
});

for (const git of [false, true]) test(`M08 complete → init → discovery source verification (${git ? 'Git' : 'no Git'})`, t => {
  const f = fixture(t, { phase: 'verification', git }); f.manual('check', ['app']); f.complete();
  const completed = f.snapshot(area); const input = governanceInput(f); const inputPath = f.json('.apex/work/init/input.json', input);
  f.run('inception-governance', ['prepare', '--repo-root', f.root, '--input', inputPath]);
  const model = f.json('.apex/work/init/model.json', input.projectModel);
  f.run('project-scaffold', ['--hub', f.root, '--model', join(f.root, model)]);
  for (const doc of input.documents) f.put(doc.path, doc.content);
  f.run('project-scaffold', ['--hub', f.root, '--model', join(f.root, model), '--apply']);
  f.run('inception-governance', ['finish', '--repo-root', f.root]);
  if (git) { f.git('add', '.'); f.git('commit', '-qm', 'Certified governance'); }
  const source = f.audit(['verify-complete']).result;
  assert.equal(source.ok, true); assert.ok(source.inputPaths.includes(`${area}/run.json`));
  assert.ok(!source.inputPaths.some(p => p.includes('/captures/')));
  f.run('validate-hub', [f.root]); assert.deepEqual(f.snapshot(area), completed);
  for (const path of ['src/app.js', '.agents/foreign.md', '.codex/config.toml', 'package-lock.json', '.apex/conventions.md', f.descriptor().completion.path]) {
    const absolute = join(f.root, path); const previous = fs.existsSync(absolute) ? fs.readFileSync(absolute) : null;
    f.put(path, 'Drift or substituted evidence'); const before = f.snapshot();
    const rejected = f.refuse('verify-complete'); assert.equal(rejected.ok, false); assert.equal(rejected.inputPaths, undefined);
    assert.deepEqual(f.snapshot(), before, 'source rejection is read-only');
    if (previous) fs.writeFileSync(absolute, previous); else fs.unlinkSync(absolute);
  }
  assert.equal(f.cli('verify-complete').ok, true); assert.equal(f.descriptor().status, 'complete');
});

for (const boundary of ['before-finish', 'after-reserve', 'after-receipt', 'before-bind']) test(`M10 collector ${boundary}: CLI recovery never reexecutes command`, t => {
  const f = fixture(t, { phase: 'verification', checks: [check('auto', 'automatic', { automatic: command(`require('node:fs').appendFileSync('${area}/project/executions.log','once\\n');process.stdout.write('complete stream')`) })] });
  f.begin('capture', { kind: 'check' }); f.report('capture');
  const options = { repoRoot: f.root, cycle: f.cycle(), check: 'auto', unit: 'capture' };
  f.crash('capture-inception-evidence', `await api.collectInceptionEvidence({...${JSON.stringify(options)},fault:event=>{if(event===${JSON.stringify(boundary)})process.exit(73)}});`);
  const attempt = f.descriptor().units[0].capture;
  assert.equal(fs.readFileSync(join(f.root, `${area}/project/executions.log`), 'utf8'), 'once\n');
  f.capture('capture', 'auto', 'check', boundary === 'before-finish' ? 1 : 0);
  if (boundary === 'before-finish') {
    assert.equal(f.descriptor().units[0].capture.state, 'incomplete');
    f.refuse('unit', 'finish', '--id', 'capture');
    const stopped = f.json(`${area}/project/stopped.json`, { unitId: 'capture', writerStopped: true, statement: 'The crashed collector process exited.' });
    f.cli('unit', 'close-incomplete', '--id', 'capture', '--reason', 'Collector terminated', '--evidence', stopped);
    f.begin('retry', { kind: 'check', previousUnit: 'capture' }); f.report('retry'); f.capture('retry', 'auto'); f.finish('retry');
  } else { f.finish('capture'); assert.equal(f.descriptor().units[0].capture.token, attempt.token); }
  assert.equal(fs.readFileSync(join(f.root, `${area}/project/executions.log`), 'utf8'), boundary === 'before-finish' ? 'once\nonce\n' : 'once\n');
  f.complete(); assert.equal(f.cli('verify-complete').ok, true);
});

test('M10 forged receipt and partial stream refuse publication recovery without command replay', t => {
  const f = fixture(t, { phase: 'verification', checks: [check('auto', 'automatic')] });
  f.begin('capture', { kind: 'check' }); f.report('capture');
  f.crash('capture-inception-evidence', `await api.collectInceptionEvidence({repoRoot:root,cycle:${JSON.stringify(f.cycle())},check:'auto',unit:'capture',fault:event=>{if(event==='before-bind')process.exit(73)}});`);
  const attempt = f.descriptor().units[0].capture; const path = attempt.receiptPath;
  const receipt = fs.readFileSync(join(f.root, path)); f.put(path, JSON.stringify({ ...JSON.parse(receipt), token: 'f'.repeat(64) }));
  let before = f.snapshot();
  // Recovery legitimately retires exactly the crashed writer's dead lease.
  // Every application and evidence file remains byte/mode/mtime identical.
  assert.ok(before['.steepy-project-scaffold.lock/owner.json']);
  delete before['.steepy-project-scaffold.lock/owner.json'];
  f.capture('capture', 'auto', 'check', 1); assert.deepEqual(f.snapshot(), before);
  f.put(path, receipt); f.put(attempt.stdoutPath, 'partial'); before = f.snapshot();
  f.capture('capture', 'auto', 'check', 1); assert.deepEqual(f.snapshot(), before); assert.equal(f.descriptor().units[0].capture.state, 'running');
});

test('M09 correlated real Git commit preserves application identity and valid verification results', t => {
  const f = fixture(t, { phase: 'verification', git: true }); f.manual('verified', ['app']); const cycle = f.cycle();
  f.begin('commit', { kind: 'bootstrap' });
  const correlation = [{ name: 'operation', value: 'authorized-empty-commit' }]; const evidence = `${area}/project/commit-proof.json`;
  f.cli('effect', 'intent', '--id', 'commit-effect', '--input', f.input({ id: 'commit-effect', kind: 'commit', summary: 'Authorized provenance commit', command: { executable: 'git', args: ['commit', '--allow-empty', '-m', 'Authorized commit'], cwd: '.', successExitCodes: [0] }, procedure: null, scope: [], authorization: 'User authorized commits', correlation, observation: { procedure: 'Observe committed HEAD', expected: 'Exact operation committed', evidencePaths: [evidence] } }));
  const head = f.git('rev-parse', 'HEAD'); f.git('commit', '--allow-empty', '-qm', 'Authorized commit'); assert.notEqual(f.git('rev-parse', 'HEAD'), head);
  f.json(evidence, { id: 'commit-effect', procedure: 'Observe committed HEAD', result: 'succeeded', correlation, observed: `HEAD ${f.git('rev-parse', 'HEAD')}` });
  f.cli('effect', 'reconcile', '--id', 'commit-effect', '--input', f.input({ result: 'succeeded', observed: `HEAD ${f.git('rev-parse', 'HEAD')}`, correlation, evidence: [evidence] }));
  f.report('commit'); f.finish('commit'); f.beginCycle(); assert.equal(f.cycle(), cycle);
  assert.equal(f.status().checks[0].result, 'succeeded'); f.complete();
});

test('M11 simultaneous fresh CLI writer refuses the live lease and persisted unit owner', t => {
  const f = fixture(t);
  const input = { kind: 'research', inputs: [], outputs: [{ path: `${area}/project/owner.md`, role: 'report' }], allowedPaths: [] };
  const other = f.input({ ...input, outputs: [{ path: `${area}/project/other.md`, role: 'report' }] });
  f.crash('inception-state', `const {spawnSync}=await import('node:child_process');api.beginUnit(root,{id:'owner',input:${JSON.stringify(input)},reservation:'owner-begin',fault:event=>{if(event==='after-reserve'){const child=spawnSync(process.execPath,[${JSON.stringify(script('inception-state'))},'unit','begin','--repo-root',root,'--id','other','--input',${JSON.stringify(other)}],{encoding:'utf8'});if(child.status!==1)throw Error(child.stdout+child.stderr);process.exit(73)}}});`);
  f.cli('publish', 'resume', '--reservation', 'owner-begin');
  f.refuse('unit', 'begin', '--id', 'other', '--input', other); assert.equal(f.descriptor().activeUnit, 'owner');
  f.report('owner'); f.finish('owner'); assert.equal(f.descriptor().units.length, 1);
});

for (const boundary of ['before-reserve', 'after-reserve', 'before-stage', 'after-stage', 'before-rename', 'after-rename', 'before-bind', 'after-bind', 'before-descriptor-replace', 'after-descriptor-replace']) test(`M11 finish publication ${boundary} composes with a new CLI session`, t => {
  const f = fixture(t); f.begin('research', { outputs: [{ path: `${area}/project/research.md`, role: 'report' }, { path: `${area}/project/decision.md`, role: 'decision' }] });
  f.report('research'); f.put(`${area}/project/decision.md`, 'Frozen decision');
  f.crash('inception-state', `api.finishUnit(root,{id:'research',reservation:'finish-research',fault:event=>{if(event===${JSON.stringify(boundary)})process.exit(73)}});`);
  if (boundary === 'before-reserve') f.finish('research');
  else {
    const blocked = f.input({ kind: 'decision', inputs: [], outputs: [{ path: `${area}/project/other.md`, role: 'report' }], allowedPaths: [] });
    if (f.descriptor().pending) f.refuse('unit', 'begin', '--id', 'other', '--input', blocked);
    f.cli('publish', 'resume', '--reservation', 'finish-research');
    const before = f.snapshot(); f.cli('publish', 'resume', '--reservation', 'finish-research'); assert.deepEqual(f.snapshot(), before);
  }
  assert.equal(f.descriptor().units[0].state, 'completed'); f.audit(['resume-check']);
  f.transition('architecture'); assert.equal(f.descriptor().units.length, 1);
});

for (const boundary of ['after-reserve', 'before-bind', 'after-bind']) test(`M11 terminal transition ${boundary} closes only its persisted publication`, t => {
  const f = fixture(t, { phase: 'verification' }); f.manual('verified', ['app']); const checkpoint = f.checkpoint();
  f.crash('inception-state', `api.transitionRun(root,{to:'complete',reason:'Verified',cycle:${JSON.stringify(f.cycle())},checkpoint:${JSON.stringify(checkpoint)},reservation:'terminal',fault:event=>{if(event===${JSON.stringify(boundary)})process.exit(73)}});`);
  f.cli('publish', 'resume', '--reservation', 'terminal'); assert.equal(f.cli('verify-complete').ok, true);
  const before = f.snapshot(); f.cli('publish', 'resume', '--reservation', 'terminal'); f.cli('resume-check'); assert.deepEqual(f.snapshot(), before);
});

test('M11 complete compares the live application and Git once, before reserving, and names the drift it refuses', t => {
  const f = fixture(t, { phase: 'verification', git: true }); f.manual('verified', ['app']); const checkpoint = f.checkpoint();
  const complete = () => f.process([script('inception-state'), 'transition', '--repo-root', f.root, '--to', 'complete', '--reason', 'Verified', '--cycle', f.cycle(), '--checkpoint', checkpoint]);
  f.put('src/app.js', 'Changed after the final checkpoint\n');
  let r = complete(); assert.equal(r.status, 1, r.stdout);
  assert.match(JSON.parse(r.stdout).error, /baseline drift requires reconciliation: "src\/app\.js"/);
  f.put('src/app.js', 'Application\n'); f.git('commit', '--allow-empty', '-qm', 'Provenance change');
  r = complete(); assert.equal(r.status, 1, r.stdout);
  assert.match(JSON.parse(r.stdout).error, /baseline drift requires reconciliation: Git branch, HEAD or status/);
  assert.notEqual(f.descriptor().status, 'complete'); assert.equal(f.descriptor().pending, null);
});

test('M13 an unsupported v1 run format is refused by every command without mutation', t => {
  for (const status of ['active', 'blocked', 'complete']) {
    const f = fixture(t, { start: false }); f.put(`${area}/run.json`, v1RunDescriptorText(status));
    f.put(`${area}/project/opaque.md`, 'Historical private report'); f.put(`${area}/foreign.txt`, 'Unowned file');
    const before = f.snapshot();
    f.refuse('inspect'); f.refuse('classify'); f.refuse('verify-complete'); f.refuse('abandon', '--reason', 'Archive');
    f.refuse('resume-note', '--next', 'Must not upgrade'); f.refuse('start', '--harness', 'codex', '--capabilities', 'shell', '--git-commits', 'allowed');
    f.run('validate-hub', [f.root], 1); assert.equal(JSON.parse(f.run('stop-hook', [f.root]).stdout).decision, 'block');
    assert.deepEqual(f.snapshot(), before, status);
  }
});

for (const descriptor of ['{"schema":"unknown"}', '{"schema":']) test('M13 unknown or corrupt descriptors fail closed without mutation', t => {
  const f = fixture(t, { start: false }); f.put(`${area}/run.json`, descriptor); const before = f.snapshot();
  f.refuse('inspect'); f.refuse('classify'); f.refuse('verify-complete'); f.refuse('abandon', '--reason', 'Invalid source');
  assert.equal(JSON.parse(f.run('stop-hook', [f.root]).stdout).decision, 'block');
  f.run('validate-hub', [f.root], 1); assert.deepEqual(f.snapshot(), before);
});

// F2: approved exclusions hide the same paths from the walk and from Git status,
// so excluded generated output and dependencies never read as Git drift.
const excluded = checks => contract(checks, { exclusions: [{ path: 'dist', kind: 'generated', reason: 'Build output' }, { path: 'node_modules', kind: 'dependencies', reason: 'Installed packages' }] });
const BUILD = command(`const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/out.js','built\\n')`);
const F2_VARIANTS = { git: { git: true }, 'git-literal-pathspecs': { git: true }, 'no-git': { git: false }, gitignored: { git: true, initialFiles: { '.gitignore': 'dist/\nnode_modules/\n' } } };
function f2Fixture(t, variant, { phase = 'verification', initialFiles = {} } = {}) {
  const checks = [check('build', 'automatic', { automatic: BUILD }), check('app')];
  const options = F2_VARIANTS[variant];
  const f = fixture(t, { phase, approvedContract: excluded(checks), git: options.git, initialFiles: { ...options.initialFiles, ...initialFiles } });
  // The fixture env object reaches every later process by reference.
  if (variant === 'git-literal-pathspecs') f.env.GIT_LITERAL_PATHSPECS = '1';
  return f;
}
// Read-only and refused calls leave every byte, mode and mtime unchanged.
function unchanged(f, action) { const before = f.snapshot(); const result = action(); assert.deepEqual(f.snapshot(), before); return result; }
const checkResult = (f, id) => unchanged(f, () => f.status()).checks.find(c => c.id === id).result;
for (const variant of ['git', 'git-literal-pathspecs', 'no-git', 'gitignored']) {
  test(`F2 SC4 ${variant}: an approved check capture may write excluded build output`, t => {
    const f = f2Fixture(t, variant);
    f.automatic('capture-build', 'build');
    assert.equal(fs.readFileSync(join(f.root, 'dist/out.js'), 'utf8'), 'built\n');
    assert.equal(checkResult(f, 'build'), 'succeeded');
  });

  test(`F2 SC4 ${variant}: an excluded write outside any unit is not drift`, t => {
    const f = f2Fixture(t, variant);
    const cp = f.checkpoint();
    f.put('dist/manual.js', 'Manual excluded output\n');
    assert.equal(unchanged(f, () => f.cli('resume-check')).ok, true);
    assert.equal(unchanged(f, () => f.cli('checkpoint', 'verify', '--checkpoint', cp)).ok, true);
    f.manual('human', ['app']);
    assert.equal(checkResult(f, 'app'), 'succeeded');
  });

  test(`F2 SC4 ${variant}: a bootstrap install records its manifests but not excluded dependencies`, t => {
    const f = f2Fixture(t, variant, { phase: 'bootstrap' });
    f.begin('install', { kind: 'bootstrap', allowedPaths: ['package.json', 'package-lock.json'] });
    f.put('package.json', '{"name":"sample"}\n'); f.put('package-lock.json', '{"lockfileVersion":3}\n'); f.put('node_modules/dep/index.js', 'module.exports = 1;\n');
    f.report('install'); f.finish('install');
    const after = f.read(f.descriptor().units.find(u => u.id === 'install').after.path).body;
    const paths = after.files.map(file => file.path);
    for (const path of ['package.json', 'package-lock.json']) assert.ok(paths.includes(path), path);
    assert.equal(paths.some(path => path.startsWith('node_modules/')), false);
    if (variant === 'no-git') assert.deepEqual(after.git, { present: false, branch: null, head: null, status: [] });
    else {
      for (const entry of ['?? package.json', '?? package-lock.json']) assert.ok(after.git.status.includes(entry), entry);
      assert.equal(after.git.status.some(entry => entry.includes('node_modules')), false);
    }
  });

  if (['git', 'no-git'].includes(variant)) test(`F2 SC5 ${variant}: unexcluded application, branch and config drift is still refused`, t => {
    const f = f2Fixture(t, variant);
    const refused = () => unchanged(f, () => {
      assert.equal(f.refuse('resume-check').ok, false);
      assert.equal(f.refuse('checkpoint', 'create', '--label', 'Cannot absorb drift').ok, false);
    });
    f.put('src/new.js', 'Unexplained application file\n'); refused(); fs.unlinkSync(join(f.root, 'src/new.js'));
    if (variant === 'git') {
      // GIT_CONFIG_GLOBAL=/dev/null leaves the initial branch name unspecified.
      const branch = f.git('symbolic-ref', '--short', 'HEAD');
      f.git('checkout', '-qb', 'other'); refused(); f.git('checkout', '-q', branch);
    }
    f.put('package-lock.json', '{"lockfileVersion":3}\n'); refused(); fs.unlinkSync(join(f.root, 'package-lock.json'));
    assert.equal(unchanged(f, () => f.cli('resume-check')).ok, true);
  });
}

test('F2 SC4 git: an approved check may rewrite a tracked file under an exclusion', t => {
  const f = f2Fixture(t, 'git', { initialFiles: { 'dist/out.js': 'v1' } });
  assert.equal(f.git('ls-files', 'dist/out.js'), 'dist/out.js');
  f.automatic('capture-build', 'build');
  assert.equal(fs.readFileSync(join(f.root, 'dist/out.js'), 'utf8'), 'built\n');
  assert.equal(checkResult(f, 'build'), 'succeeded');
});

test('F2 SC6 a changed approved scope is scope drift and never a filtered equal checkpoint', t => {
  const f = fixture(t, { phase: 'verification', git: true });
  const dist = [{ path: 'dist', kind: 'generated', reason: 'Build output' }];
  const reapprove = exclusions => { f.transition('approval'); f.json(`${area}/project/verification-contract.json`, { ...f.contract, exclusions }); f.approve(); };
  const divergences = cp => unchanged(f, () => f.refuse('checkpoint', 'verify', '--checkpoint', cp)).divergences;
  const has = (list, path, reason) => list.some(d => d.path === path && d.reason === reason);
  f.manual('v1', ['app']); const cp1 = f.checkpoint();
  reapprove(dist);
  assert.deepEqual(f.read(f.descriptor().baseline.path).body.exclusions, dist);
  assert.ok(has(divergences(cp1), '.', 'scope-drift'));
  f.transition('bootstrap'); f.transition('verification'); f.beginCycle();
  assert.ok(unchanged(f, () => f.status()).checks.every(c => c.result === 'not-executed'));
  f.put('dist/out.js', 'built\n'); const cp2 = f.checkpoint();
  reapprove([]);
  const drift = divergences(cp2);
  assert.ok(has(drift, '.', 'scope-drift'), JSON.stringify(drift));
  assert.ok(has(drift, 'dist/out.js', 'application-drift'), JSON.stringify(drift));
});

// F3: every registered project decision must be covered by the latest approval.
// Outside approval a new decision is refused at registration.
for (const phase of ['bootstrap', 'verification']) test(`F3 SC7 ${phase}: a new project decision after approval is refused at registration`, t => {
  const f = fixture(t, { phase });
  const input = f.input({ kind: 'decision', inputs: [], outputs: [{ path: `${area}/project/late.md`, role: 'report' }, { path: `${area}/project/late-decision.md`, role: 'decision' }], allowedPaths: [] });
  const units = f.descriptor().units;
  const refused = unchanged(f, () => f.refuse('unit', 'begin', '--id', 'late', '--input', input));
  assert.match(refused.error, /project\/late-decision\.md/);
  assert.match(refused.error, /approval/);
  assert.deepEqual(f.descriptor().units, units);
  // Control: a report-only decision unit is still admitted.
  f.begin('control');
  assert.deepEqual(f.descriptor().units.map(u => u.id), [...units.map(u => u.id), 'control']);
});

// Inside approval a decision registered after the latest approval stays
// uncovered until a new approval names it.
const ADDENDUM = `${area}/project/addendum-decision.md`;
function addendum(f) {
  f.begin('addendum', { outputs: [{ path: `${area}/project/addendum.md`, role: 'report' }, { path: ADDENDUM, role: 'decision' }] });
  f.put(ADDENDUM, 'Addendum decision\n'); f.report('addendum'); f.finish('addendum');
}
const namesAddendum = text => assert.match(text, /project\/addendum-decision\.md/);

test('F3 SC8 a decision registered after approval blocks the approval gate until a new approval covers it', t => {
  const f = fixture(t, { phase: 'approval' });
  f.approve(); addendum(f);
  const resumed = unchanged(f, () => f.refuse('resume-check'));
  assert.ok(resumed.divergences.some(d => d.kind === 'approval' && /project\/addendum-decision\.md/.test(d.reason)), JSON.stringify(resumed.divergences));
  namesAddendum(unchanged(f, () => f.refuse('transition', '--to', 'bootstrap', '--reason', 'Uncovered decision')).error);
  namesAddendum(unchanged(f, () => f.refuse('verify-approval')).error);
  f.cli('approve', '--statement', 'I approve this exact delivery and its checks.', '--document', `${area}/project/decision-register.md`, '--document', ADDENDUM, '--contract', `${area}/project/verification-contract.json`);
  // Control (SC9 positive): the covering approval reopens every gate.
  f.transition('bootstrap');
  assert.equal(f.cli('resume-check').ok, true);
  f.transition('verification'); f.beginCycle(); f.manual('check', ['app']); f.complete();
  assert.ok(f.cli('verify-complete').inputPaths.includes(ADDENDUM));
});

test('F3 SC8 a historical approval is read without the coverage rule', t => {
  const f = fixture(t, { phase: 'approval' });
  f.approve(); f.transition('bootstrap'); f.transition('approval'); f.approve();
  const [first, latest] = f.descriptor().approvals.map(ref => ref.path);
  assert.notEqual(first, latest);
  addendum(f);
  // Control: the earlier approval still verifies.
  assert.equal(unchanged(f, () => f.cli('verify-approval', '--approval', first)).ok, true);
  namesAddendum(unchanged(f, () => f.refuse('verify-approval')).error);
});

// Corrected CLIs no longer produce an uncovered decision outside approval, so
// the state is built faithfully: one closed-incomplete unit at the same revision.
const UNCOVERED = `${area}/project/uncovered-decision.md`;
function injectUncoveredDecision(f) {
  const path = join(f.root, `${area}/run.json`);
  const d = parseRunDescriptorV2(fs.readFileSync(path));
  const unit = { id: 'uncovered', previousUnit: null, kind: 'decision', phase: 'verification', inputs: [], outputs: [{ path: `${area}/project/uncovered-report.md`, role: 'report' }, { path: UNCOVERED, role: 'decision' }], allowedPaths: [], before: d.baseline, state: 'closed-incomplete', evidence: [], after: d.baseline, capture: null };
  fs.writeFileSync(path, serializeRunDescriptorV2({ ...d, units: [...d.units, unit] }));
}

test('F3 SC9 complete refuses a registered decision the latest approval does not cover', t => {
  const f = fixture(t, { phase: 'verification' });
  f.manual('check', ['app']);
  injectUncoveredDecision(f);
  assert.match(f.complete(1).error, /uncovered-decision\.md/);
  // The refused terminal transition publishes nothing.
  const checkpoint = f.descriptor().checkpoints.at(-1).path;
  assert.match(unchanged(f, () => f.refuse('transition', '--to', 'complete', '--reason', 'Verified delivery', '--cycle', f.cycle(), '--checkpoint', checkpoint)).error, /uncovered-decision\.md/);
  assert.equal(f.descriptor().status, 'active');
});

test('F3 SC9 verify-complete refuses only the source of a completed run with an uncovered decision', t => {
  const f = fixture(t, { phase: 'verification' });
  f.manual('check', ['app']); f.complete();
  assert.equal(f.cli('verify-complete').ok, true);
  injectUncoveredDecision(f);
  const refused = unchanged(f, () => f.refuse('verify-complete'));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, `${UNCOVERED}: registered project decision is not covered by the latest approval`);
  assert.equal(f.descriptor().status, 'complete');
});

// F4: structurally recognized lease directories, live or dead, own or foreign,
// are excluded for every observer. Read-only readers never acquire or retire.
const LOCK = '.steepy-project-scaffold.lock';
const leaseBytes = (pid, token) => `${JSON.stringify({ schemaVersion: 1, pid, token })}\n`;
const leaseToken = () => randomBytes(16).toString('hex');
// Recognition never consults liveness, so residues name an already exited pid.
function exitedPid() { const r = spawnSync(process.execPath, ['-e', '']); assert.equal(r.status, 0); return r.pid; }
function leaseDir(f, name, bytes, mode = 0o600) {
  fs.mkdirSync(join(f.root, name), { mode: 0o700 });
  const owner = join(f.root, name, 'owner.json'); fs.writeFileSync(owner, bytes); fs.chmodSync(owner, mode);
  return name;
}
// A canonical residue whose name agrees with its own record.
function residue(f, kind, pid = exitedPid(), token = leaseToken()) {
  return leaseDir(f, kind === 'candidate' ? `${LOCK}.candidate-${pid}-${token}` : `${LOCK}.${kind}-${token}`, leaseBytes(pid, token));
}
const deadLock = f => { f.crash('project-scaffold', 'api.withProjectScaffoldLock({ hubRoot: root }, () => process.exit(73))'); return LOCK; };
const LEASE_STATES = { 'dead lock': deadLock, stale: f => residue(f, 'stale'), retired: f => residue(f, 'retired'), candidate: f => residue(f, 'candidate') };
const verificationReaders = (f, cp) => () => ({ resume: f.cli('resume-check'), checkpoint: f.cli('checkpoint', 'verify', '--checkpoint', cp), status: f.cli('verification', 'status', '--cycle', f.cycle()) });
const completeReaders = f => () => ({ verify: f.cli('verify-complete'), resume: f.cli('resume-check') });
// Reference outputs come from the lease-free tree and must be deterministic.
function referenceReads(readers) { const expected = readers(); assert.deepEqual(readers(), expected, 'reader outputs are deterministic'); return expected; }
// Each state is read, then removed by the test; readers never retire it.
function leaseMatrix(f, readers) {
  const clean = f.snapshot(); const expected = referenceReads(readers);
  for (const [state, make] of Object.entries(LEASE_STATES)) {
    const name = make(f); const before = f.snapshot();
    assert.ok(before[`${name}/owner.json`], state);
    assert.deepEqual(readers(), expected, state);
    assert.deepEqual(f.snapshot(), before, state);
    fs.rmSync(join(f.root, name), { recursive: true });
    assert.deepEqual(f.snapshot(), clean, state);
  }
  return expected;
}
// A foreign process holds the live lease until the test writes `stop`. Its
// signal files stay in the sandbox, outside the observed repository root.
const LEASE_HOLDER_MARKER = 'steepy-f4-foreign-lease-holder';
let holders = 0;
async function underForeignLease(t, f, readers) {
  const clean = f.snapshot(); const expected = referenceReads(readers);
  const ready = join(f.sandbox, `ready-${++holders}`); const stop = join(f.sandbox, `stop-${holders}`);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `// ${LEASE_HOLDER_MARKER}
import fs from 'node:fs'; import { withProjectScaffoldLock } from ${JSON.stringify(moduleURL('project-scaffold'))};
withProjectScaffoldLock({ hubRoot: ${JSON.stringify(f.root)} }, () => {
  fs.writeFileSync(${JSON.stringify(ready)}, '');
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(${JSON.stringify(stop)})) Atomics.wait(cell, 0, 0, 25);
});`], { cwd: f.root, env: f.env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } });
  for (const deadline = Date.now() + 10000; !fs.existsSync(ready);) {
    assert.ok(child.exitCode === null && child.signalCode === null, `lease holder exited early: ${stderr}`);
    assert.ok(Date.now() < deadline, 'lease holder was not ready within 10 s');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const held = f.snapshot();
  assert.equal(JSON.parse(Buffer.from(held[`${LOCK}/owner.json`][0], 'base64')).pid, child.pid);
  assert.deepEqual(readers(), expected);
  assert.deepEqual(f.snapshot(), held);
  fs.writeFileSync(stop, '');
  assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
  assert.deepEqual(f.snapshot(), clean);
}
// Structures that fail recognition. `.stale-*` and the bare lock name with a
// record are omitted: the lease itself legitimately retires stale generations.
const UNRECOGNIZED = {
  'retired with an extra file': f => { const name = residue(f, 'retired'); f.put(`${name}/extra.txt`, 'Extra entry\n'); return name; },
  'candidate with a truncated record': f => { const pid = exitedPid(); const token = leaseToken(); return leaseDir(f, `${LOCK}.candidate-${pid}-${token}`, leaseBytes(pid, token).slice(0, 10)); },
  'retired with reordered record keys': f => { const token = leaseToken(); return leaseDir(f, `${LOCK}.retired-${token}`, `${JSON.stringify({ token, pid: exitedPid(), schemaVersion: 1 })}\n`); },
  // A symlink to a regular file: the fixture snapshot reads through links.
  'retired symlink to a sandbox file': f => {
    const token = leaseToken(); const target = join(f.sandbox, `outside-${token}.json`); const name = `${LOCK}.retired-${token}`;
    fs.writeFileSync(target, leaseBytes(exitedPid(), token)); fs.chmodSync(target, 0o600); fs.symlinkSync(target, join(f.root, name));
    return name;
  },
  'candidate record with mode 0644': f => { const pid = exitedPid(); const token = leaseToken(); return leaseDir(f, `${LOCK}.candidate-${pid}-${token}`, leaseBytes(pid, token), 0o644); },
  'retired name with a foreign token': f => leaseDir(f, `${LOCK}.retired-${leaseToken()}`, leaseBytes(exitedPid(), leaseToken())),
  'canonical lock below the root': f => leaseDir(f, `src/${LOCK}`, leaseBytes(exitedPid(), leaseToken())),
};
function refusedFor(f, commands) {
  for (const [shape, make] of Object.entries(UNRECOGNIZED)) {
    const name = make(f);
    for (const args of commands) {
      const before = f.snapshot(); const refused = f.refuse(...args);
      assert.equal(refused.ok, false, `${shape}: ${args.join(' ')}`);
      assert.match(JSON.stringify(refused), /drift|symlink is not an application file/, `${shape}: ${args.join(' ')}`);
      assert.deepEqual(f.snapshot(), before, `${shape}: ${args.join(' ')}`);
    }
    fs.rmSync(join(f.root, name), { recursive: true });
  }
}

for (const git of [false, true]) {
  const label = git ? 'Git' : 'no Git';
  test(`F4 SC10 ${label}: readers ignore dead and residual lease directories without retiring them`, t => {
    const f = fixture(t, { phase: 'verification', git });
    f.manual('check', ['app']); const cp = f.checkpoint();
    const reads = leaseMatrix(f, verificationReaders(f, cp));
    assert.equal(reads.resume.ok, true); assert.equal(reads.checkpoint.ok, true);
    f.complete();
    const completed = leaseMatrix(f, completeReaders(f));
    assert.equal(completed.verify.ok, true); assert.equal(completed.resume.ok, true);
  });

  test(`F4 SC10 ${label}: readers ignore a live foreign lease`, async t => {
    const f = fixture(t, { phase: 'verification', git });
    f.manual('check', ['app']); const cp = f.checkpoint();
    await underForeignLease(t, f, verificationReaders(f, cp));
    f.complete();
    await underForeignLease(t, f, completeReaders(f));
  });

  test(`F4 SC10 ${label}: a crashed lease holder leaves a dead lock that readers ignore`, t => {
    const f = fixture(t, { phase: 'verification', git });
    f.begin('w'); f.report('w');
    f.crash('inception-state', "api.finishUnit(root,{id:'w',reservation:'finish-w',fault:e=>{if(e==='before-reserve')process.exit(73)}})");
    const crashed = f.snapshot();
    assert.ok(crashed[`${LOCK}/owner.json`], 'the writer crashed inside the lease');
    assert.equal(f.cli('resume-check').ok, true);
    assert.deepEqual(f.snapshot(), crashed, 'the dead lock is still there');
    f.finish('w'); f.manual('check', ['app']); f.complete();
    deadLock(f);
    const completed = f.snapshot();
    assert.ok(completed[`${LOCK}/owner.json`]);
    assert.equal(f.cli('verify-complete').ok, true);
    assert.deepEqual(f.snapshot(), completed);
  });

  test(`F4 SC11 ${label}: unrecognized lease structures stay drift for readers and lease holders`, t => {
    const f = fixture(t, { phase: 'verification', git });
    f.manual('check', ['app']);
    refusedFor(f, [['resume-check'], ['checkpoint', 'create', '--label', 'Cannot absorb lease drift']]);
    f.complete();
    refusedFor(f, [['resume-check'], ['verify-complete']]);
  });

  test(`F4 SC12 ${label}: a lease-holding checkpoint retires dead generations and preserves foreign residues`, t => {
    const f = fixture(t, { phase: 'verification', git });
    f.manual('check', ['app']);
    for (const [state, make] of [['dead lock', deadLock], ['stale', f => residue(f, 'stale')]]) {
      const name = make(f); assert.ok(fs.existsSync(join(f.root, name, 'owner.json')), state);
      const cp = f.checkpoint();
      assert.equal(fs.existsSync(join(f.root, name)), false, `${state} is retired`);
      assert.equal(f.cli('checkpoint', 'verify', '--checkpoint', cp).ok, true, state);
    }
    for (const kind of ['retired', 'candidate']) {
      const name = residue(f, kind);
      const metadata = () => { const dir = fs.lstatSync(join(f.root, name)); return { dir: [dir.ino, dir.mode, dir.mtimeMs], files: f.snapshot(name) }; };
      const before = metadata();
      const cp = f.checkpoint();
      assert.deepEqual(metadata(), before, `${kind} is preserved`);
      assert.equal(f.cli('checkpoint', 'verify', '--checkpoint', cp).ok, true, kind);
      fs.rmSync(join(f.root, name), { recursive: true });
    }
  });
}

// F1: `documents` is the only writer of the certified stable documents. Their
// mode comes from the receipt, never from the umask, and recovery completes
// only what is missing.
const INIT_INPUT = '.apex/work/init/input.json';
const INIT_PLAN = '.apex/work/init/plan.json';
function initFixture(t) {
  const f = fixture(t, { phase: 'verification' });
  f.manual('verified', ['app']); f.complete();
  const request = governanceInput(f); f.json(INIT_INPUT, request);
  // The runner only plans, read-only; every repository write runs in a child.
  f.json(INIT_PLAN, planProjectScaffold({ hubRoot: f.root, model: request.projectModel }));
  return { f, request, paths: request.documents.map(d => d.path).sort() };
}
const governanceCli = (f, ...args) => JSON.parse(f.run('inception-governance', [...args, '--repo-root', f.root]).stdout);
function applyPlan(f) {
  const r = f.process(['--input-type=module', '-e', `import { applyProjectScaffold } from ${JSON.stringify(moduleURL('project-scaffold'))};
import plan from ${JSON.stringify(pathToFileURL(join(f.root, INIT_PLAN)).href)} with { type: 'json' };
applyProjectScaffold({ hubRoot: ${JSON.stringify(f.root)}, plan });`]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
}
// Control: the preload really sets the child umask, so no mode check is vacuous.
function assertChildUmask(f, mask) {
  const probe = join(f.sandbox, `umask-probe-${mask.toString(8)}`);
  const r = f.process(['-e', `require('node:fs').writeFileSync(${JSON.stringify(probe)}, '')`]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.statSync(probe).mode & 0o777, 0o666 & ~mask);
  fs.unlinkSync(probe);
}
function assertDocuments(f, request) {
  for (const doc of request.documents) {
    const absolute = join(f.root, doc.path);
    assert.equal(fs.readFileSync(absolute, 'utf8'), doc.content, doc.path);
    assert.equal(fs.lstatSync(absolute).mode & 0o7777, 0o644, doc.path);
  }
}
for (const mask of [0o022, 0o002, 0o077]) test(`F1 SC1 umask 0${mask.toString(8).padStart(3, '0')}: documents certifies every stable document at 0644`, t => {
  const { f, request, paths } = initFixture(t);
  f.umask = mask; assertChildUmask(f, mask);
  assert.equal(f.cli('verify-complete').ok, true);
  governanceCli(f, 'prepare', '--input', INIT_INPUT); applyPlan(f);
  const written = governanceCli(f, 'documents', '--input', INIT_INPUT);
  assert.equal(written.ok, true); assert.deepEqual(written.created, paths); assert.deepEqual(written.preserved, []);
  governanceCli(f, 'finish');
  assert.equal(f.cli('verify-complete').ok, true);
  f.run('validate-hub', [f.root]);
  assertDocuments(f, request);
});

function crashDocuments(f, request, boundary) {
  const fault = join(f.sandbox, 'fault.json');
  f.crash('inception-governance', `const { writeFileSync } = await import('node:fs'); api.writeGovernanceDocuments(root, ${JSON.stringify(request)}, { fault: (event, detail) => { if (event === ${JSON.stringify(boundary)}) { writeFileSync(${JSON.stringify(fault)}, JSON.stringify(detail)); process.exit(73); } } });`);
  return JSON.parse(fs.readFileSync(fault, 'utf8'));
}
// Recovery `documents` runs through the CLI in a fresh process. A sandbox preload
// records every rename, so the published stage is observed directly.
function recoverDocuments(f) {
  const log = join(f.sandbox, 'renames.jsonl'); const preload = join(f.sandbox, 'record-renames.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';
const rename = fs.renameSync;
fs.renameSync = (from, to) => { fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ from: String(from), to: String(to) }) + '\\n'); return rename(from, to); };
`);
  const r = f.process(['--import', preload, script('inception-governance'), 'documents', '--input', INIT_INPUT, '--repo-root', f.root]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const renames = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { output: JSON.parse(r.stdout), renames };
}
function fileIdentity(f, path) {
  const absolute = join(f.root, path); const st = fs.lstatSync(absolute);
  return { bytes: fs.readFileSync(absolute).toString('base64'), mode: st.mode & 0o7777, mtimeMs: st.mtimeMs, ino: st.ino };
}
const sibling = (stage, generation) => stage.replace(/-0001\.tmp$/u, `-${generation}.tmp`);
function documentsRecovery(t, boundary, alterStage) {
  const { f, request, paths } = initFixture(t); f.umask = 0o002;
  const { id } = governanceCli(f, 'prepare', '--input', INIT_INPUT); applyPlan(f);
  const detail = crashDocuments(f, request, boundary);
  assert.equal(detail.path, paths[0]);
  if (boundary === 'documents-after-stage') assert.match(detail.stage, /^\.apex\/work\/init-provenance\/[0-9a-f]{64}\/document-[0-9a-f]{64}-0001\.tmp$/u);
  // After the crash every certified path is absent or exact at 0644.
  for (const op of f.read(GOVERNANCE_PENDING).operations) {
    const absolute = join(f.root, op.path);
    if (!fs.existsSync(absolute)) continue;
    const bytes = fs.readFileSync(absolute);
    assert.deepEqual({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mode: fs.lstatSync(absolute).mode & 0o7777 },
      { bytes: op.after.bytes, sha256: op.after.sha256, mode: 0o644 }, op.path);
  }
  const complete = Object.fromEntries(paths.filter(path => fs.existsSync(join(f.root, path))).map(path => [path, fileIdentity(f, path)]));
  assert.deepEqual(Object.keys(complete), boundary === 'documents-after-rename' ? [paths[0]] : []);
  alterStage?.(f, detail.stage);
  // Recovery in fresh processes: the same input, then the same plan.
  assert.equal(governanceCli(f, 'prepare', '--input', INIT_INPUT).id, id);
  applyPlan(f);
  const { output, renames } = recoverDocuments(f);
  assert.deepEqual(output, { ok: true, id, created: paths.filter(path => !(path in complete)), preserved: Object.keys(complete) });
  governanceCli(f, 'finish');
  assert.equal(f.cli('verify-complete').ok, true);
  for (const [path, identity] of Object.entries(complete)) assert.deepEqual(fileIdentity(f, path), identity, `${path} keeps bytes, mode and mtime`);
  assert.equal(f.read(GOVERNANCE_RECEIPT).id, id);
  assertDocuments(f, request);
  // The stages renamed onto the crashed document path, in order.
  const published = renames.filter(r => r.to === join(f.root, detail.path)).map(r => r.from);
  return { f, detail, published };
}
for (const boundary of ['documents-before-stage', 'documents-after-stage', 'documents-after-rename']) test(`F1 SC2 crash at ${boundary}: fresh-process recovery completes only the missing documents`, t => {
  const { f, detail, published } = documentsRecovery(t, boundary);
  if (boundary === 'documents-after-rename') assert.deepEqual(published, [], 'the complete document is not republished');
  else if (boundary === 'documents-before-stage') { assert.equal(published.length, 1); assert.match(published[0], /\/document-[0-9a-f]{64}-0001\.tmp$/u); }
  else {
    assert.deepEqual(published, [join(f.root, detail.stage)], 'the complete stage is reused');
    assert.equal(fs.existsSync(join(f.root, detail.stage)), false);
  }
});
test('F1 SC2 documents-after-stage (a): a truncated stage stays byte-identical and publication uses generation -0002', t => {
  let partial;
  const { f, detail, published } = documentsRecovery(t, 'documents-after-stage', (f, stage) => {
    fs.truncateSync(join(f.root, stage), 10); partial = fs.readFileSync(join(f.root, stage));
    assert.equal(fs.existsSync(join(f.root, sibling(stage, '0002'))), false);
  });
  assert.equal(partial.length, 10);
  assert.deepEqual(fs.readFileSync(join(f.root, detail.stage)), partial);
  assert.deepEqual(published, [join(f.root, sibling(detail.stage, '0002'))]);
  for (const generation of ['0002', '0003']) assert.equal(fs.existsSync(join(f.root, sibling(detail.stage, generation))), false, generation);
});
test('F1 SC2 documents-after-stage (b): a stage chmodded to 0600 is published at 0644', t => {
  const { f, detail, published } = documentsRecovery(t, 'documents-after-stage', (f, stage) => fs.chmodSync(join(f.root, stage), 0o600));
  assert.deepEqual(published, [join(f.root, detail.stage)]);
  assert.equal(fs.lstatSync(join(f.root, detail.path)).mode & 0o7777, 0o644);
});

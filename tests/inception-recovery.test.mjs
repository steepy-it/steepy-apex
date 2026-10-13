import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { fixture, area, check, contract, command, governanceInput, script } from './helpers/inception-fixture.mjs';

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

function legacy(status) {
  return { schema: 'steepy-inception-run/v1', runId: 'inc-20261007T120000Z-1a2b3c4d', phase: status === 'complete' ? 'complete' : 'reconnaissance', status,
    harness: { name: 'codex', capabilities: { shell: true, network: false, browser: false, subagents: false, 'question-tool': false, headless: false } }, git: { present: false, branch: null, commits: 'none' }, nextRecord: status === 'complete' ? 3 : 1, approvalEntry: null, approvals: [], checkpoints: status === 'complete' ? [`${area}/checkpoints/0002.json`] : [], resumeNotes: [], finalCheckpoint: status === 'complete' ? `${area}/checkpoints/0002.json` : null, verification: status === 'complete' ? { path: `${area}/verification/results.md`, bytes: 12, sha256: 'a'.repeat(64) } : null, history: [] };
}
for (const status of ['active', 'blocked', 'complete']) for (const [boundary, child] of [['after-mkdir', null], ['after-move', 'project'], ['after-move', 'run.json']]) test(`M12/M13 legacy ${status} archive at ${boundary} ${child ?? ''} preserves raw bytes`, t => {
  const f = fixture(t, { start: false }); f.json(`${area}/run.json`, legacy(status));
  f.put(`${area}/project/opaque.md`, 'Historical private report'); f.put(`${area}/foreign.txt`, 'Unowned file');
  const raw = fs.readFileSync(join(f.root, `${area}/run.json`));
  f.audit(['inspect'], { forbiddenReads: [`${area}/project`] }); f.cli('classify'); f.refuse('verify-complete');
  f.run('validate-hub', [f.root]); assert.equal(f.run('stop-hook', [f.root]).stdout, '');
  const before = f.snapshot(); f.refuse('resume-note', '--next', 'Must not upgrade'); assert.deepEqual(f.snapshot(), before);
  f.crash('inception-state', `api.abandonRun(root,{reason:'Archive legacy',fault:(event,detail)=>{if(event===${JSON.stringify(boundary)}&&(${JSON.stringify(child)}===null||detail?.name===${JSON.stringify(child)}))process.exit(73)}});`);
  assert.equal(f.cli('classify').row, 'resume-abandon');
  f.refuse('start', '--harness', 'codex', '--capabilities', 'shell', '--git-commits', 'allowed');
  f.audit(['abandon', '--resume'], { forbiddenLists: [area], allowedLists: [`${area}/abandoned/${legacy(status).runId}`], forbiddenReads: [`${area}/project/opaque.md`, `${area}/abandoned/${legacy(status).runId}/project/opaque.md`] });
  const archive = `${area}/abandoned/${legacy(status).runId}`;
  assert.deepEqual(fs.readFileSync(join(f.root, archive, 'run.json')), raw);
  assert.equal(fs.readFileSync(join(f.root, `${area}/foreign.txt`), 'utf8'), 'Unowned file');
  assert.equal(fs.existsSync(join(f.root, area, 'run.json')), false);
  const finished = f.snapshot(); f.cli('abandon', '--resume'); assert.deepEqual(f.snapshot(), finished);
});

for (const descriptor of ['{"schema":"unknown"}', '{"schema":']) test('M13 unknown or corrupt descriptors fail closed without mutation', t => {
  const f = fixture(t, { start: false }); f.put(`${area}/run.json`, descriptor); const before = f.snapshot();
  f.refuse('inspect'); f.refuse('classify'); f.refuse('verify-complete'); f.refuse('abandon', '--reason', 'Invalid source');
  assert.equal(JSON.parse(f.run('stop-hook', [f.root]).stdout).decision, 'block');
  f.run('validate-hub', [f.root], 1); assert.deepEqual(f.snapshot(), before);
});

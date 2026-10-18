import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import * as state from '../scripts/inception-state.mjs';
import { planProjectScaffold, applyProjectScaffold, renderProjectArtifact, withProjectScaffoldLock } from '../scripts/project-scaffold.mjs';
import { fixture as processFixture, governanceInput } from './helpers/inception-fixture.mjs';
import { renderTemplate } from '../scripts/template.mjs';
import { prepareGovernance, writeGovernanceDocuments, finishGovernance, GOVERNANCE_PENDING, GOVERNANCE_RECEIPT } from '../scripts/inception-governance.mjs';

const area = '.apex/inception';
const put = (root, path, bytes) => { fs.mkdirSync(join(root, path, '..'), { recursive: true }); fs.writeFileSync(join(root, path), bytes); };
const read = (root, path) => JSON.parse(fs.readFileSync(join(root, path)));
const descriptor = root => read(root, `${area}/run.json`);
const model = () => ({ projectName: 'sample', description: 'Sample app', devCommands: ['node --test'], surfaces: [{ name: 'src', path: 'src', agent: 'src-agent', testCmd: 'node --test' }], resolutions: {} });
const template = (name, vars) => renderTemplate(fs.readFileSync(new URL(`../templates/${name}`, import.meta.url), 'utf8'), vars);
const documents = () => [
  { path: '.apex/_INDEX.md', content: template('_INDEX.md', { projectName: 'sample', routingRows: template('routing-row.md', { surface: 'src', docsPath: 'standards/src.md', agent: 'src-agent', skill: '—' }).trimEnd(), gitPolicyDirective: '' }) },
  { path: '.apex/standards/src.md', content: template('surface-standard.md', { name: 'src', path: 'src', testCmd: 'node --test' }) },
  ...['conventions', 'glossary', 'testing-and-checklist'].map(name => ({ path: `.apex/${name}.md`, content: `# ${name}\nConfirmed interview decisions.\n` })),
];
const input = root => ({ schema: 'steepy-inception-governance-input/v1', runId: descriptor(root).runId, completion: descriptor(root).completion, projectModel: model(), documents: documents() });
function git(root, ...args) { const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); }
function fixture(t, { mixed = false, gitRepo = false, initialRoots, roots = ['.'], exclusions = [] } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'steepy-governance-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  put(root, 'src/app.js', 'Application\n');
  if (mixed) { put(root, 'AGENTS.md', 'User prefix\r\nKeep exactly.'); put(root, 'CLAUDE.md', 'User Claude instructions\n'); }
  if (initialRoots) initialRoots(root);
  if (gitRepo) { git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.test'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'Application'); }
  state.startRun(root, { harnessName: 'codex', gitCommits: 'forbidden' });
  for (const to of ['architecture', 'research', 'approval']) state.transitionRun(root, { to, reason: 'Ready' });
  const contractPath = `${area}/project/verification-contract.json`;
  put(root, `${area}/project/decision-register.md`, 'Approved decisions');
  put(root, contractPath, JSON.stringify({ schema: 'steepy-inception-checks/v2', roots, exclusions, environment: { tools: [], resources: [] }, checks: [{ id: 'app', required: true, type: 'manual', subject: 'App', procedure: 'Inspect app', expected: 'Works', evidenceRequired: 'Confirmation', automatic: null, manual: { procedure: 'Open app', acceptance: 'Works' }, reuse: { policy: 'snapshot', automatic: null, manual: null } }], coverage: [{ id: 'app', component: 'App', checks: ['app'], status: 'current' }] }));
  state.approveRun(root, { statement: 'Approved', documents: [`${area}/project/decision-register.md`], contract: contractPath });
  for (const to of ['bootstrap', 'verification']) state.transitionRun(root, { to, reason: 'Ready' });
  state.beginVerification(root, { environment: { tools: [], resources: [] }, reason: 'Verify app' });
  const report = `${area}/project/check.md`;
  state.beginUnit(root, { id: 'check', input: { kind: 'check', inputs: [], outputs: [{ path: report, role: 'report' }], allowedPaths: [] } });
  put(root, report, '<!-- steepy-inception-unit: v2; id: check; status: DONE -->\nVerified\n<!-- steepy-inception-unit-end: check -->\n');
  state.attestVerification(root, { cycle: descriptor(root).currentCycle.path, input: { checks: [{ id: 'app', procedure: 'Open app', result: 'succeeded', observed: 'Works' }], statement: 'I opened the app and it works.', environment: { tools: [], resources: [] }, purpose: 'check' } });
  state.finishUnit(root, { id: 'check' });
  state.transitionRun(root, { to: 'complete', reason: 'Verified', cycle: descriptor(root).currentCycle.path, checkpoint: state.createCheckpoint(root, { label: 'Final' }).checkpoint.path });
  assert.equal(state.verifyComplete(root).ok, true);
  return root;
}
function apply(root, request) {
  const plan = planProjectScaffold({ hubRoot: root, model: request.projectModel });
  assert.equal(plan.conflicts.length, 0);
  for (const document of request.documents) put(root, document.path, document.content);
  applyProjectScaffold({ hubRoot: root, plan });
}
function metadata(root) {
  const result = {};
  function walk(path) { for (const name of fs.readdirSync(join(root, path))) { const p = path ? `${path}/${name}` : name; const st = fs.lstatSync(join(root, p)); if (st.isDirectory()) walk(p); else result[p] = [fs.readFileSync(join(root, p)).toString('base64'), st.mode, st.mtimeMs]; } }
  walk(''); return result;
}
test('complete → prepare → real plan/apply → finish → default verify preserves the completed run', t => {
  const root = fixture(t, { mixed: true }); const request = input(root); const run = metadata(join(root, area));
  const prepared = prepareGovernance(root, request); assert.equal(prepared.status, 'prepared');
  assert.equal(state.verifyComplete(root).ok, false, 'prepared receipt cannot certify incomplete init');
  apply(root, request); const finished = finishGovernance(root); assert.equal(finished.status, 'complete');
  assert.equal(state.verifyComplete(root).ok, true, state.verifyComplete(root).reason);
  assert.deepEqual(metadata(join(root, area)), run);
  const hub = spawnSync(process.execPath, [resolve('scripts/validate-hub.mjs'), root], { encoding: 'utf8' }); assert.equal(hub.status, 0, hub.stdout + hub.stderr);
  const before = metadata(root); prepareGovernance(root, request); finishGovernance(root); state.verifyComplete(root); assert.deepEqual(metadata(root), before);
});
for (const path of ['src/app.js', '.agents/foreign.md', '.codex/config.toml', 'package-lock.json', 'AGENTS.md', '.apex/conventions.md']) {
  test(`certified init does not hide drift at ${path}`, t => {
    const root = fixture(t, { mixed: true }); const request = input(root); prepareGovernance(root, request); apply(root, request); finishGovernance(root);
    put(root, path, 'Unexpected change'); const before = metadata(root);
    assert.equal(state.verifyComplete(root).ok, false); assert.throws(() => finishGovernance(root)); assert.deepEqual(metadata(root), before);
  });
}
test('finish refuses incomplete or extraneous changes; prepare cannot overwrite a different reservation', t => {
  const root = fixture(t); const request = input(root); prepareGovernance(root, request);
  assert.throws(() => finishGovernance(root));
  const different = structuredClone(request); different.documents[0].content += 'Different';
  const before = metadata(root); assert.throws(() => prepareGovernance(root, different)); assert.deepEqual(metadata(root), before);
  apply(root, request); put(root, 'foreign.txt', 'foreign'); assert.throws(() => finishGovernance(root));
  fs.unlinkSync(join(root, 'foreign.txt')); finishGovernance(root); assert.equal(state.verifyComplete(root).ok, true);
});
for (const path of [GOVERNANCE_PENDING, GOVERNANCE_RECEIPT]) {
  test(`altered or missing ${path} is rejected read-only`, t => {
    const root = fixture(t); const request = input(root); prepareGovernance(root, request); apply(root, request); finishGovernance(root);
    const receipt = read(root, path); receipt.operations[0].after.sha256 = 'f'.repeat(64); put(root, path, JSON.stringify(receipt));
    const before = metadata(root); assert.equal(state.verifyComplete(root).ok, false); assert.deepEqual(metadata(root), before);
    fs.unlinkSync(join(root, path)); assert.equal(state.verifyComplete(root).ok, false);
  });
}
test('init-only Git provenance drift is accepted after real init commit', t => {
  const root = fixture(t, { gitRepo: true }); const request = input(root); prepareGovernance(root, request); apply(root, request); finishGovernance(root);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Init governance'); assert.equal(state.verifyComplete(root).ok, true);
});
for (const boundary of ['after-prepare', 'before-finish', 'after-finish']) {
  test(`interruption at ${boundary} retries the same reservation without modifying the run`, t => {
    const root = fixture(t); const request = input(root); const run = metadata(join(root, area));
    const fault = point => { if (point === boundary) throw Error('Interrupted'); };
    if (boundary === 'after-prepare') assert.throws(() => prepareGovernance(root, request, { fault }), /Interrupted/);
    else prepareGovernance(root, request);
    const id = read(root, GOVERNANCE_PENDING).id; prepareGovernance(root, request); apply(root, request);
    if (boundary !== 'after-prepare') assert.throws(() => finishGovernance(root, { fault }), /Interrupted/);
    finishGovernance(root); assert.equal(read(root, GOVERNANCE_RECEIPT).id, id); assert.equal(state.verifyComplete(root).ok, true); assert.deepEqual(metadata(join(root, area)), run);
  });
}
for (const git of [false, true]) for (const boundary of ['after-prepare', 'before-finish', 'after-finish']) {
  test(`FR-R1 ${git ? 'Git' : 'no-Git'} first fresh-process recovery after ${boundary}`, t => {
    const f = processFixture(t, { phase: 'verification', git });
    f.manual('verified', ['app']); f.complete();
    const request = governanceInput(f); const run = f.snapshot(area);
    const inputPath = f.json('.apex/work/init/input.json', request);
    const plan = planProjectScaffold({ hubRoot: f.root, model: request.projectModel });
    const planPath = f.json('.apex/work/init/plan.json', plan);
    const command = boundary === 'after-prepare' ? 'prepare' : 'finish';
    if (command === 'finish') {
      prepareGovernance(f.root, request);
      for (const doc of request.documents) f.put(doc.path, doc.content);
      applyProjectScaffold({ hubRoot: f.root, plan });
    }
    f.crash('inception-governance', `api.${command}Governance(root,${command === 'prepare' ? `${JSON.stringify(request)},` : ''}{fault:point=>{if(point===${JSON.stringify(boundary)})process.exit(73)}});`);
    const pending = f.read(GOVERNANCE_PENDING);
    const reservation = `.apex/work/init-provenance/${pending.id}/reservation.json`;
    // Compare every preexisting file except the exact dead active lease. Git
    // metadata is not application output; its stat cache may be refreshed.
    const retained = () => Object.fromEntries(Object.entries(f.snapshot()).filter(([path]) => !path.startsWith('.git/') && !path.startsWith('.steepy-project-scaffold.lock/')));
    const before = retained();
    const recovered = f.run('inception-governance', [command, '--repo-root', f.root, ...(command === 'prepare' ? ['--input', inputPath] : [])]);
    assert.equal(JSON.parse(recovered.stdout).id, pending.id);
    const after = retained();
    for (const [path, identity] of Object.entries(before)) assert.deepEqual(after[path], identity, `${path} preserved`);
    assert.deepEqual(f.snapshot(area), run);
    assert.deepEqual(f.read(inputPath), request); assert.deepEqual(f.read(planPath), plan);
    assert.deepEqual(f.read(reservation), pending);
    if (command === 'prepare') {
      for (const doc of request.documents) f.put(doc.path, doc.content);
      applyProjectScaffold({ hubRoot: f.root, plan });
      f.run('inception-governance', ['finish', '--repo-root', f.root]);
    }
    assert.equal(f.read(GOVERNANCE_RECEIPT).id, pending.id);
    assert.equal(f.cli('verify-complete').ok, true);
    assert.deepEqual(f.snapshot(area), run);
    assert.deepEqual(fs.readdirSync(f.root).filter(name => name.startsWith('.steepy-project-scaffold.lock')), []);
  });
}
test('FR-R1 fresh prepare refuses a same-input reservation published in the lease gap', t => {
  const root = fixture(t); const request = input(root); let published;
  assert.throws(() => prepareGovernance(root, request, { fault: point => {
    if (point !== 'after-lease-retirement') return;
    prepareGovernance(root, request); published = metadata(root);
  } }), /changed between leases/);
  assert.deepEqual(metadata(root), published);
  prepareGovernance(root, request); apply(root, request); finishGovernance(root);
  assert.equal(state.verifyComplete(root).ok, true);
});
for (const command of ['prepare', 'finish']) {
  test(`FR-R1 ${command} rejects changed authority across the lease gap`, t => {
    const root = fixture(t); const request = input(root);
    const pending = prepareGovernance(root, request); apply(root, request);
    const reservation = `.apex/work/init-provenance/${pending.id}/reservation.json`;
    const invoke = options => command === 'prepare' ? prepareGovernance(root, request, options) : finishGovernance(root, options);
    const mutations = [
      [`${area}/run.json`, bytes => { const value = JSON.parse(bytes); value.revision++; return JSON.stringify(value); }],
      [`${area}/run.json`, bytes => { const value = JSON.parse(bytes); value.runId = value.runId.replace(/.$/u, value.runId.endsWith('0') ? '1' : '0'); return JSON.stringify(value); }],
      [`${area}/run.json`, bytes => { const value = JSON.parse(bytes); value.completion.sha256 = '0'.repeat(64); return JSON.stringify(value); }],
      [GOVERNANCE_PENDING, () => null],
      [GOVERNANCE_RECEIPT, () => 'Foreign receipt'],
      [reservation, () => 'Foreign reservation'],
      [reservation, bytes => bytes], // Even equal bytes at a new inode are a different reservation.
    ];
    for (const [path, mutate] of mutations) {
      const original = fs.existsSync(join(root, path)) ? fs.readFileSync(join(root, path)) : null;
      let duringGap;
      try {
        assert.throws(() => invoke({ fault: point => {
          if (point !== 'after-lease-retirement') return;
          withProjectScaffoldLock({ hubRoot: root }, () => {
            const changed = mutate(original);
            if (changed === null) fs.unlinkSync(join(root, path));
            else { const staged = `${path}.replacement`; put(root, staged, changed); fs.renameSync(join(root, staged), join(root, path)); }
          });
          duringGap = metadata(root);
        } }), /changed between leases/, path);
        assert.deepEqual(metadata(root), duringGap, 'refusal preserves the intervening writer');
      } finally {
        if (original === null) fs.unlinkSync(join(root, path)); else put(root, path, original);
      }
    }
    let completedByOtherWriter;
    assert.throws(() => invoke({ fault: point => {
      if (point !== 'after-lease-retirement') return;
      finishGovernance(root); completedByOtherWriter = metadata(root);
    } }), /changed between leases/);
    assert.deepEqual(metadata(root), completedByOtherWriter);
    assert.equal(state.verifyComplete(root).ok, true);
  });
  test(`FR-R1 ${command} rejects live, unverifiable and foreign lease owners`, t => {
    const root = fixture(t); const request = input(root);
    prepareGovernance(root, request); apply(root, request);
    const invoke = () => command === 'prepare' ? prepareGovernance(root, request) : finishGovernance(root);
    withProjectScaffoldLock({ hubRoot: root }, () => {
      const before = metadata(root);
      assert.throws(invoke, /live owner/); assert.deepEqual(metadata(root), before);
      const kill = process.kill;
      process.kill = () => { const error = Error('Unverifiable PID'); error.code = 'EPERM'; throw error; };
      try { assert.throws(invoke, /live owner/); assert.deepEqual(metadata(root), before); }
      finally { process.kill = kill; }
    });
    const owner = '.steepy-project-scaffold.lock/owner.json';
    put(root, owner, 'foreign ownership'); const foreign = metadata(root);
    assert.throws(invoke, /owner record/); assert.deepEqual(metadata(root), foreign);
    fs.unlinkSync(join(root, owner)); fs.rmdirSync(join(root, '.steepy-project-scaffold.lock'));
    for (const path of ['.steepy-unrelated.txt', '.steepy-project-scaffold.lock.stale-foreign/application.txt']) {
      put(root, path, 'Unrelated application content'); const before = metadata(root);
      assert.throws(invoke, /application-drift/); assert.deepEqual(metadata(root), before);
      fs.unlinkSync(join(root, path));
      if (path.includes('/')) fs.rmdirSync(join(root, path, '..'));
    }
    finishGovernance(root); assert.equal(state.verifyComplete(root).ok, true);
  });
}
test('input scope, existing stable documents, unsafe targets and strict CLI are rejected before effects', t => {
  const root = fixture(t); const request = input(root);
  for (const mutation of [r => r.documents.push({ path: 'src/app.js', content: 'bad' }), r => r.documents.push({ path: '.codex/config.toml', content: 'bad' }), r => r.extra = true, r => r.documents[0].path = '.apex/../app.js']) {
    const bad = structuredClone(request); mutation(bad); const before = metadata(root); assert.throws(() => prepareGovernance(root, bad)); assert.deepEqual(metadata(root), before);
  }
  put(root, '.apex/conventions.md', 'Existing'); assert.throws(() => prepareGovernance(root, request)); fs.unlinkSync(join(root, '.apex/conventions.md'));
  fs.symlinkSync(join(root, 'src/app.js'), join(root, '.apex/conventions.md')); assert.throws(() => prepareGovernance(root, request)); fs.unlinkSync(join(root, '.apex/conventions.md'));
  const cli = spawnSync(process.execPath, [resolve('scripts/inception-governance.mjs'), 'prepare', '--repo-root', root, '--unknown'], { encoding: 'utf8' }); assert.equal(cli.status, 2, cli.stderr);
});
for (const phase of ['prepare', 'finish']) {
  test(`${phase} recovers a complete token-bound staging file after interruption`, t => {
    const root = fixture(t); const request = input(root); const run = metadata(join(root, area));
    if (phase === 'finish') { prepareGovernance(root, request); apply(root, request); }
    const invoke = options => phase === 'prepare' ? prepareGovernance(root, request, options) : finishGovernance(root, options);
    assert.throws(() => invoke({ fault: point => { if (point === 'after-stage') throw Error('Staged interruption'); } }), /Staged interruption/);
    assert.equal(state.verifyComplete(root).ok, phase === 'prepare', 'staging alone preserves the original completed application');
    invoke(); if (phase === 'prepare') { apply(root, request); finishGovernance(root); }
    assert.equal(state.verifyComplete(root).ok, true); assert.deepEqual(metadata(join(root, area)), run);
  });
}
for (const phase of ['prepare', 'finish']) {
  test(`${phase} preserves partial reserved generations, verifies by exact paths and does not redispatch init`, t => {
    const root = fixture(t); const request = input(root); const run = metadata(join(root, area));
    if (phase === 'finish') { prepareGovernance(root, request); apply(root, request); }
    const invoke = options => phase === 'prepare' ? prepareGovernance(root, request, options) : finishGovernance(root, options);
    let stage;
    assert.throws(() => invoke({ fault: (point, info) => { if (point === 'after-stage') { stage = info.stage; throw Error('Crash'); } } }), /Crash/);
    const partial = fs.readFileSync(join(root, stage)).subarray(0, 80); fs.writeFileSync(join(root, stage), partial);
    const originalReadDir = fs.readdirSync;
    fs.readdirSync = (path, ...args) => { assert.ok(!String(path).includes('/.apex/work'), 'no discovery inside work'); return originalReadDir(path, ...args); };
    try { invoke(); } finally { fs.readdirSync = originalReadDir; }
    assert.deepEqual(fs.readFileSync(join(root, stage)), partial);
    if (phase === 'prepare') { apply(root, request); finishGovernance(root); }
    assert.equal(state.verifyComplete(root).ok, true); assert.deepEqual(metadata(join(root, area)), run);
  });
}
test('foreign staging, invalid receipt, duplicate JSON keys and symlink scopes never gain provenance', t => {
  const root = fixture(t); const request = input(root);
  put(root, GOVERNANCE_PENDING, '{"schema":"unknown"}'); assert.equal(state.verifyComplete(root).ok, false); fs.unlinkSync(join(root, GOVERNANCE_PENDING));
  let stage;
  assert.throws(() => prepareGovernance(root, request, { fault: (point, info) => { if (point === 'after-stage') { stage = info.stage; throw Error('Crash'); } } }), /Crash/);
  put(root, stage, 'foreign'); const before = metadata(root); assert.throws(() => prepareGovernance(root, request), /collision/); assert.deepEqual(metadata(root), before);
  const cliInput = '.apex/work/input.json'; put(root, cliInput, '{"schema":"a","schema":"b"}');
  const cli = spawnSync(process.execPath, [resolve('scripts/inception-governance.mjs'), 'prepare', '--repo-root', root, '--input', cliInput], { encoding: 'utf8' }); assert.equal(cli.status, 1); assert.match(cli.stderr, /duplicate/);
});
test('producer refuses alias staging ancestors without writing through them', t => {
  const root = fixture(t); const request = input(root); fs.mkdirSync(join(root, '.apex/work'));
  fs.symlinkSync(join(root, 'src'), join(root, '.apex/work/init-provenance'));
  const before = fs.readFileSync(join(root, 'src/app.js')); assert.throws(() => prepareGovernance(root, request), /ancestor|alias/);
  assert.deepEqual(fs.readFileSync(join(root, 'src/app.js')), before); assert.equal(fs.existsSync(join(root, GOVERNANCE_PENDING)), false);
});
test('managed-root replacement preserves CRLF prefix and suffix bytes exactly', t => {
  const prefix = 'User prefix\r\n'; const suffix = '\r\nUser suffix\r\n';
  const root = fixture(t, { initialRoots: root => put(root, 'AGENTS.md', prefix + renderProjectArtifact('project-instructions', { ...model(), description: 'Before init' }).trimEnd().replaceAll('\n', '\r\n') + suffix) });
  const request = input(root); request.projectModel.resolutions['v1:project-instructions:customized'] = 'replace';
  prepareGovernance(root, request); apply(root, request); finishGovernance(root);
  const rendered = fs.readFileSync(join(root, 'AGENTS.md'), 'utf8'); assert.ok(rendered.startsWith(prefix)); assert.ok(rendered.endsWith(suffix)); assert.equal(state.verifyComplete(root).ok, true);
});
// CR1: an unmarked CLAUDE.md that imports AGENTS.md (create-next-app's default) offers only
// adopt; governance certifies exactly the planner's relocation of the import into the block.
for (const [label, claude] of [
  ['bare import', '@AGENTS.md\n'],
  ['notes then import', '# Notes\n\n@AGENTS.md\n'],
  ['import between lines', '# Notes\n@AGENTS.md\nKeep this line.\n'],
  ['CRLF', '# Notes\r\n@AGENTS.md\r\nKeep this line.\r\n'],
]) {
  test(`certified init adopts an unmarked CLAUDE.md import: ${label}`, t => {
    const root = fixture(t, { initialRoots: root => { put(root, 'AGENTS.md', '# Agent notes\n'); put(root, 'CLAUDE.md', claude); } });
    const request = input(root);
    const conflict = planProjectScaffold({ hubRoot: root, model: request.projectModel }).conflicts.find(c => c.path === 'CLAUDE.md');
    assert.deepEqual(conflict.choices, ['adopt', 'abort']);
    request.projectModel.resolutions[conflict.id] = 'adopt';
    prepareGovernance(root, request); apply(root, request); finishGovernance(root);
    assert.equal(state.verifyComplete(root).ok, true, state.verifyComplete(root).reason);
    const adopted = fs.readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    for (const line of claude.split(/\r?\n/u).filter(line => line && line !== '@AGENTS.md')) assert.ok(adopted.includes(line), line);
    assert.equal(adopted.includes('\r\n'), claude.includes('\r\n'));
    const before = metadata(root); prepareGovernance(root, request); finishGovernance(root); assert.deepEqual(metadata(root), before);
    // Unmanaged bytes stay certified: a later hand edit is drift.
    put(root, 'CLAUDE.md', `User addition\n${adopted}`);
    assert.equal(state.verifyComplete(root).ok, false);
  });
}
test('a planner replacement that would discard unmanaged root bytes cannot become an init-only exception', t => {
  const root = fixture(t, { initialRoots: root => put(root, 'AGENTS.md', 'User content\n<!-- steepy:managed:project-instructions:v2:start -->\nOld\n<!-- steepy:managed:project-instructions:v2:end -->\nUser suffix\n') });
  const request = input(root); request.projectModel.resolutions['v1:project-instructions:unknown-version'] = 'replace';
  const before = metadata(root); assert.throws(() => prepareGovernance(root, request), /unmanaged|managed/); assert.deepEqual(metadata(root), before);
});
test('CLI prepare/finish shares the typed API and keeps its exact input in work scope', t => {
  const root = fixture(t); const request = input(root); const path = '.apex/work/init/input.json'; put(root, path, JSON.stringify(request));
  const run = command => spawnSync(process.execPath, [resolve('scripts/inception-governance.mjs'), command, '--repo-root', root, ...(command === 'prepare' ? ['--input', path] : [])], { encoding: 'utf8' });
  const prepared = run('prepare'); assert.equal(prepared.status, 0, prepared.stderr); assert.equal(JSON.parse(prepared.stdout).status, 'prepared');
  apply(root, request); const finished = run('finish'); assert.equal(finished.status, 0, finished.stderr); assert.equal(JSON.parse(finished.stdout).status, 'complete');
  assert.equal(state.verifyComplete(root).ok, true); assert.deepEqual(read(root, path), request);
});
test('reserved prepare retry and cross-completion replay are bounded without touching the completed run', t => {
  const root = fixture(t); const request = input(root); const run = metadata(join(root, area));
  assert.throws(() => prepareGovernance(root, request, { fault: point => { if (point === 'after-reservation') throw Error('Reserved crash'); } }), /Reserved crash/);
  prepareGovernance(root, request); const pending = read(root, GOVERNANCE_PENDING);
  const bad = structuredClone(request); bad.completion.sha256 = '0'.repeat(64); assert.throws(() => prepareGovernance(root, bad), /completion/);
  apply(root, request); finishGovernance(root); assert.equal(read(root, GOVERNANCE_RECEIPT).id, pending.id); assert.deepEqual(metadata(join(root, area)), run);
});
test('prepare recovers an atomically staged reservation without adopting an empty or foreign namespace', t => {
  const root = fixture(t); const request = input(root); const run = metadata(join(root, area)); let stage;
  assert.throws(() => prepareGovernance(root, request, { fault: (point, info) => { if (point === 'after-reservation-stage') { stage = info.stage; throw Error('Reservation stage crash'); } } }), /Reservation stage crash/);
  assert.ok(fs.existsSync(join(root, stage))); assert.equal(fs.existsSync(join(root, GOVERNANCE_PENDING)), false);
  const bytes = fs.readFileSync(join(root, stage)); fs.unlinkSync(join(root, stage));
  assert.throws(() => prepareGovernance(root, request), /unowned staging namespace/);
  put(root, stage, 'foreign'); assert.throws(() => prepareGovernance(root, request), /foreign reservation stage/);
  put(root, stage, bytes);
  prepareGovernance(root, request); assert.equal(fs.existsSync(join(root, stage)), false); apply(root, request); finishGovernance(root);
  assert.equal(state.verifyComplete(root).ok, true); assert.deepEqual(metadata(join(root, area)), run);
});
test('a partially applied prepared init resumes registration without rewriting its completed files', t => {
  const root = fixture(t); const request = input(root); const pending = prepareGovernance(root, request);
  put(root, request.documents[0].path, request.documents[0].content); const before = metadata(root);
  assert.deepEqual(prepareGovernance(root, request), pending); assert.deepEqual(metadata(root), before); assert.throws(() => finishGovernance(root));
  apply(root, request); finishGovernance(root); assert.equal(state.verifyComplete(root).ok, true);
});
test('a receipt cannot claim the status belonging to the other canonical path', t => {
  const root = fixture(t); const request = input(root); prepareGovernance(root, request);
  const pending = read(root, GOVERNANCE_PENDING); pending.status = 'complete'; pending.applicationAfter = [];
  put(root, GOVERNANCE_PENDING, `${JSON.stringify(pending, null, 2)}\n`); const before = metadata(root);
  assert.throws(() => prepareGovernance(root, request), /status|prepared/); assert.deepEqual(metadata(root), before); assert.equal(state.verifyComplete(root).ok, false);
});

for (const scope of ['narrow-roots', 'excluded-root', 'existing-provider']) {
  test(`R9-1 ${scope} certifies exact out-of-scope governance while retaining all drift guards`, t => {
    const providerPath = '.codex/agents/src-agent.toml';
    const narrow = scope !== 'excluded-root';
    const root = fixture(t, {
      mixed: true,
      roots: narrow ? ['src'] : ['.'],
      exclusions: narrow ? [] : [{ path: 'AGENTS.md', kind: 'generated', reason: 'Governance instructions are separate from the application' }],
      initialRoots: scope === 'existing-provider' ? root => put(root, providerPath, renderProjectArtifact('src-agent-codex', model()) + '\n# Existing customization\n') : undefined,
    });
    const request = input(root);
    if (scope === 'existing-provider') request.projectModel.resolutions['v1:src-agent-codex:customized'] = 'replace';
    const run = metadata(join(root, area));
    const originalAgents = fs.readFileSync(join(root, 'AGENTS.md'));
    const completion = read(root, descriptor(root).completion.path);
    const snapshot = read(root, completion.body.snapshot.path).body;
    assert.equal(snapshot.files.some(file => file.path === 'AGENTS.md'), false);
    assert.equal(state.verifyComplete(root).ok, true);
    const pending = prepareGovernance(root, request);
    const agentsOperation = pending.operations.find(op => op.path === 'AGENTS.md');
    assert.equal(agentsOperation.before.bytes, originalAgents.length);
    assert.equal(agentsOperation.before.mode, fs.statSync(join(root, 'AGENTS.md')).mode & 0o7777);
    if (scope === 'existing-provider') {
      const providerOperation = pending.operations.find(op => op.path === providerPath);
      assert.equal(providerOperation.kind, 'replace-generated');
      assert.equal(providerOperation.before.bytes, fs.readFileSync(join(root, providerPath)).length);
    }
    assert.deepEqual(prepareGovernance(root, request), pending);
    apply(root, request); finishGovernance(root);
    assert.equal(state.verifyComplete(root).ok, true, state.verifyComplete(root).reason);
    assert.ok(fs.readFileSync(join(root, 'AGENTS.md')).subarray(0, originalAgents.length).equals(originalAgents));
    assert.deepEqual(metadata(join(root, area)), run);
    const stable = metadata(root); prepareGovernance(root, request); finishGovernance(root); state.verifyComplete(root); assert.deepEqual(metadata(root), stable);
    // Attested targets are authenticated even if roots/exclusions omit them.
    // The application comparison continues to use exactly the approved scope.
    for (const [path, mutate] of [
      ['AGENTS.md', bytes => Buffer.from(bytes.toString().replace('User prefix', 'Altered prefix'))],
      ['AGENTS.md', bytes => Buffer.from(bytes.toString().replace('Sample app', 'Altered managed description'))],
      ['.claude/agents/src-agent.md', bytes => Buffer.concat([bytes, Buffer.from('foreign addition')])],
      ['src/app.js', bytes => Buffer.concat([bytes, Buffer.from('application drift')])],
    ]) {
      const original = fs.readFileSync(join(root, path)); put(root, path, mutate(original)); const before = metadata(root);
      assert.equal(state.verifyComplete(root).ok, false, path); assert.deepEqual(metadata(root), before, 'verification is read-only');
      assert.throws(() => finishGovernance(root)); assert.deepEqual(metadata(root), before);
      put(root, path, original); assert.equal(state.verifyComplete(root).ok, true);
    }
    const originalMode = fs.statSync(join(root, providerPath)).mode & 0o7777;
    fs.chmodSync(join(root, providerPath), originalMode ^ 0o100); const modeDrift = metadata(root);
    assert.equal(state.verifyComplete(root).ok, false); assert.deepEqual(metadata(root), modeDrift);
    fs.chmodSync(join(root, providerPath), originalMode); assert.equal(state.verifyComplete(root).ok, true);
    // Matching edits to both canonical receipts cannot rewrite the physical
    // before observation authenticated by the immutable producer reservation.
    const receiptBytes = [GOVERNANCE_PENDING, GOVERNANCE_RECEIPT].map(path => [path, fs.readFileSync(join(root, path))]);
    for (const [path, bytes] of receiptBytes) {
      const changed = JSON.parse(bytes); changed.operations.find(op => op.path === 'AGENTS.md').before.sha256 = '0'.repeat(64);
      put(root, path, `${JSON.stringify(changed, null, 2)}\n`);
    }
    const receiptDrift = metadata(root); const rejected = state.verifyComplete(root);
    assert.equal(rejected.ok, false); assert.match(rejected.reason, /staging reservation collision/); assert.deepEqual(metadata(root), receiptDrift);
    for (const [path, bytes] of receiptBytes) put(root, path, bytes);
    assert.equal(state.verifyComplete(root).ok, true);
    assert.deepEqual(metadata(join(root, area)), run);
  });
}

// F1: `documents` is the only writer of the certified stable documents. The
// receipt fixes their mode; a refusal happens before any write.
const DOCUMENT_PATHS = documents().map(d => d.path).sort();
// Applies only the provider plan; the stable documents stay with `documents`.
// CR4: discovery's inception source is one-time because its own write-back drifts the certificate.
test('CR4 a discovery write-back to a certified document ends the source with governance output drift', t => {
  const root = fixture(t); const request = input(root); prepareGovernance(root, request); apply(root, request); finishGovernance(root);
  assert.equal(state.verifyComplete(root).ok, true);
  fs.appendFileSync(join(root, '.apex/conventions.md'), '- Accepted discovery rule.\n');
  assert.match(state.verifyComplete(root).reason, /\.apex\/conventions\.md governance output drift/);
});
function applyProviders(root, request) {
  const plan = planProjectScaffold({ hubRoot: root, model: request.projectModel });
  assert.equal(plan.conflicts.length, 0);
  applyProjectScaffold({ hubRoot: root, plan });
}
function fileMetadata(root, path) {
  const absolute = join(root, path);
  if (!fs.existsSync(absolute)) return null;
  const st = fs.lstatSync(absolute); return [fs.readFileSync(absolute).toString('base64'), st.mode, st.mtimeMs, st.ino];
}
const F1_REFUSALS = [
  ['no pending receipt', { prepared: false }, /governance: documents requires the prepared pending receipt/],
  ['an input that differs from the prepared receipt', { change: r => { r.documents[0].content += 'Different'; } }, /governance: documents input differs from the prepared receipt/],
  ['an existing document with different bytes', { setup: root => put(root, '.apex/conventions.md', 'Different bytes\n') },
    /governance: \.apex\/conventions\.md exists with bytes that differ from the certified document/],
  ['an exact document at mode 0664', { setup: (root, request) => {
    put(root, '.apex/conventions.md', request.documents.find(d => d.path === '.apex/conventions.md').content); fs.chmodSync(join(root, '.apex/conventions.md'), 0o664);
  } }, /governance: \.apex\/conventions\.md mode 0664 differs from certified mode 0644; documents never changes modes/],
  ['foreign application drift', { setup: root => put(root, 'foreign.txt', 'foreign') }, /^(?:Error: )?governance: application-drift outside certified init operations: foreign\.txt$/],
];
for (const [name, { prepared = true, change, setup }, error] of F1_REFUSALS) {
  test(`F1 SC3 documents refuses ${name} before any write`, t => {
    const root = fixture(t); const request = input(root);
    if (prepared) prepareGovernance(root, request);
    setup?.(root, request);
    const call = structuredClone(request); change?.(call);
    const before = metadata(root);
    assert.throws(() => writeGovernanceDocuments(root, call), error);
    assert.deepEqual(metadata(root), before);
  });
}
for (const [name, linked, link] of [
  ['.apex/standards as a symlink to src', '.apex/standards', root => fs.symlinkSync(join(root, 'src'), join(root, '.apex/standards'))],
  ['.apex/conventions.md as a symlink', '.apex/conventions.md', root => fs.symlinkSync(join(root, 'src/app.js'), join(root, '.apex/conventions.md'))],
]) {
  test(`F1 SC3 documents refuses ${name} created after prepare without writing through it`, t => {
    const root = fixture(t); const request = input(root); prepareGovernance(root, request); link(root);
    // metadata() reads through links, so the link target, receipts, run and work are compared.
    const guarded = () => ({ src: metadata(join(root, 'src')), run: metadata(join(root, area)), work: metadata(join(root, '.apex/work')),
      receipts: [GOVERNANCE_PENDING, GOVERNANCE_RECEIPT].map(path => fileMetadata(root, path)) });
    const before = guarded();
    const target = linked === '.apex/standards' ? '.apex/standards/src.md' : linked;
    assert.throws(() => writeGovernanceDocuments(root, request), new RegExp(`governance: ${target.replaceAll('.', '\\.')} has an unsafe target or ancestor: `));
    assert.deepEqual(guarded(), before);
    for (const path of DOCUMENT_PATHS) assert.equal(fs.existsSync(join(root, path)), path === linked, path);
  });
}
test('F1 documents preserves an exact 0644 document, creates the rest at 0644 and replays without writes', t => {
  const root = fixture(t); const request = input(root);
  const pending = prepareGovernance(root, request); applyProviders(root, request);
  const kept = request.documents.find(d => d.path === '.apex/glossary.md');
  put(root, kept.path, kept.content); fs.chmodSync(join(root, kept.path), 0o644); const keptBefore = fileMetadata(root, kept.path);
  assert.deepEqual(writeGovernanceDocuments(root, request), { receipt: pending, created: DOCUMENT_PATHS.filter(path => path !== kept.path), preserved: [kept.path] });
  assert.deepEqual(fileMetadata(root, kept.path), keptBefore, 'the exact document is preserved, not rewritten');
  for (const doc of request.documents) {
    assert.equal(fs.readFileSync(join(root, doc.path), 'utf8'), doc.content, doc.path);
    assert.equal(fs.lstatSync(join(root, doc.path)).mode & 0o7777, 0o644, doc.path);
  }
  const written = metadata(root);
  assert.deepEqual(writeGovernanceDocuments(root, request), { receipt: pending, created: [], preserved: DOCUMENT_PATHS });
  assert.deepEqual(metadata(root), written);
  const final = finishGovernance(root); assert.equal(state.verifyComplete(root).ok, true);
  const complete = metadata(root);
  assert.deepEqual(writeGovernanceDocuments(root, request), { receipt: final, created: [], preserved: DOCUMENT_PATHS });
  assert.deepEqual(metadata(root), complete);
  put(root, kept.path, 'Altered after the final receipt\n'); const altered = metadata(root);
  assert.throws(() => writeGovernanceDocuments(root, request), /\.apex\/glossary\.md governance output drift/);
  assert.deepEqual(metadata(root), altered);
});
test('F1 CLI documents requires its exact work input and reports the receipt id with created and preserved paths', t => {
  const root = fixture(t); const request = input(root); const path = '.apex/work/init/input.json'; put(root, path, JSON.stringify(request));
  const cli = (...args) => spawnSync(process.execPath, [resolve('scripts/inception-governance.mjs'), ...args], { encoding: 'utf8' });
  const pending = prepareGovernance(root, request); applyProviders(root, request);
  const usage = cli(); assert.equal(usage.status, 2, usage.stderr);
  assert.match(usage.stderr, /\| documents --repo-root <root> --input <exact-json> \|/);
  let before = metadata(root);
  const missing = cli('documents', '--repo-root', root); assert.equal(missing.status, 2, missing.stderr); assert.match(missing.stderr, /missing required option/);
  assert.deepEqual(metadata(root), before);
  put(root, 'input.json', JSON.stringify(request)); before = metadata(root);
  const outside = cli('documents', '--repo-root', root, '--input', 'input.json'); assert.equal(outside.status, 1, outside.stderr); assert.match(outside.stderr, /authorized work scope/);
  assert.deepEqual(metadata(root), before); fs.unlinkSync(join(root, 'input.json'));
  const written = cli('documents', '--repo-root', root, '--input', path); assert.equal(written.status, 0, written.stderr);
  const output = JSON.parse(written.stdout);
  assert.deepEqual(Object.keys(output), ['ok', 'id', 'created', 'preserved']);
  assert.deepEqual(output, { ok: true, id: pending.id, created: DOCUMENT_PATHS, preserved: [] });
  finishGovernance(root); assert.equal(state.verifyComplete(root).ok, true);
});

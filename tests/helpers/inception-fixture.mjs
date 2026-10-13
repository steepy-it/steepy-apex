// Real CLI fixture: every call starts a fresh Node process. No provider/session store.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderTemplate } from '../../scripts/template.mjs';

export const area = '.apex/inception';
export const environment = { tools: [], resources: [] };
export const command = code => ({ executable: process.execPath, args: ['-e', code], cwd: '.', successExitCodes: [0] });
export function check(id, type = 'manual', extra = {}) {
  return { id, required: true, type, subject: id, procedure: `Verify ${id}`, expected: 'Works', evidenceRequired: 'Recorded observation', automatic: type === 'manual' ? null : command('process.stdout.write("checked")'), manual: type === 'automatic' ? null : { procedure: `Open ${id}`, acceptance: 'Works' }, reuse: { policy: 'snapshot', automatic: null, manual: null }, ...extra };
}
export const contract = (checks = [check('app')], extra = {}) => ({ schema: 'steepy-inception-checks/v2', roots: ['.'], exclusions: [], environment, checks, coverage: [{ id: 'app', component: 'Application', checks: checks.filter(c => c.required).map(c => c.id), status: 'current' }, { id: 'later', component: 'Future delivery', checks: [], status: 'future' }], ...extra });
export const script = name => fileURLToPath(new URL(`../../scripts/${name}.mjs`, import.meta.url));
export const moduleURL = name => new URL(`../../scripts/${name}.mjs`, import.meta.url).href;
export function physicalSnapshot(root) {
  const result = {};
  const walk = path => { for (const name of fs.readdirSync(join(root, path)).sort()) { const rel = path ? `${path}/${name}` : name; const st = fs.lstatSync(join(root, rel)); if (st.isDirectory()) walk(rel); else result[rel] = [fs.readFileSync(join(root, rel)).toString('base64'), st.mode, st.mtimeMs]; } };
  walk(''); return result;
}
export function fixture(t, { checks, approvedContract = contract(checks), phase = 'reconnaissance', git = false, start = true, initialFiles = {} } = {}) {
  const sandbox = fs.mkdtempSync(join(tmpdir(), 'steepy-inception-recovery-'));
  fs.mkdirSync(join(sandbox, 'repo'));
  const root = fs.realpathSync(join(sandbox, 'repo'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const env = { ...process.env, HOME: join(sandbox, 'home'), XDG_CONFIG_HOME: join(sandbox, 'config'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'].includes(key)) delete env[key];
  fs.mkdirSync(env.HOME); fs.mkdirSync(env.XDG_CONFIG_HOME);
  let serial = 0;
  const f = {
    root, sandbox, env, contract: approvedContract,
    put(path, bytes) { fs.mkdirSync(dirname(join(root, path)), { recursive: true }); fs.writeFileSync(join(root, path), bytes); return path; },
    json(path, value) { return f.put(path, JSON.stringify(value)); },
    read(path) { return JSON.parse(fs.readFileSync(join(root, path))); },
    descriptor() { return f.read(`${area}/run.json`); },
    snapshot(path = '') { return physicalSnapshot(join(root, path)); },
    input(value) { return f.json(`${area}/inputs/${++serial}.json`, value); },
    process(args, options = {}) { return spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 30000, ...options }); },
    run(name, args, expected = 0) { const r = f.process([script(name), ...args]); assert.equal(r.status, expected, `${name} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`); return r; },
    cli(...args) { return JSON.parse(f.run('inception-state', [...args, '--repo-root', root]).stdout); },
    refuse(...args) { return JSON.parse(f.run('inception-state', [...args, '--repo-root', root], 1).stdout); },
    transition(to) { return f.cli('transition', '--to', to, '--reason', 'Explicit approved phase progression'); },
    approve() { return f.cli('approve', '--statement', 'I approve this exact delivery and its checks.', '--document', `${area}/project/decision-register.md`, '--contract', `${area}/project/verification-contract.json`); },
    begin(id, { kind = 'decision', allowedPaths = [], previousUnit, outputs = [{ path: `${area}/project/${id}.md`, role: 'report' }] } = {}) { return f.cli('unit', 'begin', '--id', id, '--input', f.input({ kind, inputs: [], outputs, allowedPaths }), ...(previousUnit ? ['--previous-unit', previousUnit] : [])); },
    report(id) { return f.put(`${area}/project/${id}.md`, `<!-- steepy-inception-unit: v2; id: ${id}; status: DONE -->\nObserved required work.\n<!-- steepy-inception-unit-end: ${id} -->\n`); },
    finish(id) { return f.cli('unit', 'finish', '--id', id); },
    cycle() { return f.descriptor().currentCycle.path; },
    beginCycle() { return f.cli('verification', 'begin', '--environment', f.input(environment), '--reason', 'Verify approved delivery'); },
    status() { return f.cli('verification', 'status', '--cycle', f.cycle()); },
    capture(unit, id, purpose = 'check', expected = 0) { return f.run('capture-inception-evidence', ['--repo-root', root, '--cycle', f.cycle(), '--unit', unit, '--check', id, '--purpose', purpose], expected); },
    attest(ids, result = 'succeeded', purpose = 'check') {
      const checks = ids.map(id => {
        const approved = f.contract.checks.find(c => c.id === id);
        const manual = purpose === 'check' ? approved.manual : approved.reuse.manual;
        return { id, procedure: manual.procedure, result, observed: 'Explicit human observation' };
      });
      return f.cli('verification', 'attest', '--cycle', f.cycle(), '--input', f.input({ checks, statement: 'I performed every named procedure and confirm the recorded outcome.', environment, purpose }));
    },
    manual(id, ids, result = 'succeeded', purpose = 'check') { f.begin(id, { kind: 'check' }); f.report(id); f.attest(ids, result, purpose); f.finish(id); },
    automatic(unit, id, purpose = 'check') { f.begin(unit, { kind: 'check' }); f.report(unit); f.capture(unit, id, purpose); f.finish(unit); },
    checkpoint() { return f.cli('checkpoint', 'create', '--label', 'Final verified snapshot').checkpoint.path; },
    complete(expected = 0) { return JSON.parse(f.run('inception-state', ['transition', '--repo-root', root, '--to', 'complete', '--reason', 'Verified delivery', '--cycle', f.cycle(), '--checkpoint', f.checkpoint()], expected).stdout); },
    crash(name, expression, expected = 73) { const r = f.process(['--input-type=module', '-e', `import * as api from ${JSON.stringify(moduleURL(name))}; const root=${JSON.stringify(root)}; ${expression}`]); assert.equal(r.status, expected, r.stdout + r.stderr); return r; },
    git(...args) { const r = spawnSync('git', ['-C', root, ...args], { env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); },
    // Audit *attempts* before access, including readers that catch errors. The
    // preload patches builtin named imports before importing the real CLI.
    audit(args, { forbiddenReads = [], forbiddenLists = [area, '.apex/work', '.git'], allowedLists = [], expected = 0, name = 'inception-state' } = {}) {
      const log = join(sandbox, `audit-${++serial}.jsonl`); const preload = join(sandbox, `audit-${serial}.mjs`);
      fs.writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; import {resolve} from 'node:path'; import {fileURLToPath} from 'node:url';
const root=${JSON.stringify(root)}, log=${JSON.stringify(log)}, reads=${JSON.stringify(forbiddenReads)}, lists=${JSON.stringify(forbiddenLists)}, allowedLists=${JSON.stringify(allowedLists)}; const append=fs.appendFileSync; const record=(kind,p)=>{if(typeof p==='number')return;let path=resolve(p instanceof URL?fileURLToPath(p):String(p)); if(!path.startsWith(root+'/'))return;path=path.slice(root.length+1);const forbidden=!(kind==='list'&&allowedLists.includes(path))&&(kind==='list'?lists:reads).some(x=>path===x||path.startsWith(x+'/'));append(log,JSON.stringify({kind,path,forbidden})+'\\n');if(forbidden)throw Error('FORBIDDEN ACCESS '+kind+' '+path);};
for(const name of ['readFileSync','openSync','readdirSync','opendirSync']){const original=fs[name];fs[name]=function(p,...rest){record(name.includes('dir')?'list':'read',p);return original.call(this,p,...rest);};}syncBuiltinESMExports();`);
      const r = f.process(['--import', preload, script(name), ...args, ...(name === 'inception-state' ? ['--repo-root', root] : [])]);
      const events = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
      assert.deepEqual(events.filter(e => e.forbidden), [], `forbidden access attempts: ${JSON.stringify(events.filter(e => e.forbidden))}`);
      assert.equal(r.status, expected, r.stdout + r.stderr);
      assert.ok(events.length, 'instrumentation observed real accesses');
      return { result: name === 'inception-state' ? JSON.parse(r.stdout) : r, events };
    },
  };
  f.put('src/app.js', 'Application\n');
  for (const [path, bytes] of Object.entries(initialFiles)) f.put(path, bytes);
  if (git) { f.git('init', '-q'); f.git('config', 'user.name', 'Fixture'); f.git('config', 'user.email', 'fixture@example.test'); f.git('add', '.'); f.git('commit', '-qm', 'Initial application'); }
  if (start) f.cli('start', '--harness', 'codex', '--capabilities', 'shell', '--git-commits', 'allowed');
  if (phase !== 'reconnaissance') {
    for (const to of ['architecture', 'research', 'approval']) { f.transition(to); if (phase === to && to !== 'approval') return f; }
    f.put(`${area}/project/decision-register.md`, 'Approved application decisions');
    f.json(`${area}/project/verification-contract.json`, approvedContract);
    if (phase !== 'approval') { f.approve(); f.transition('bootstrap'); if (phase !== 'bootstrap') { f.transition('verification'); f.beginCycle(); } }
  }
  return f;
}

export function governanceInput(f) {
  const template = (name, vars) => renderTemplate(fs.readFileSync(new URL(`../../templates/${name}`, import.meta.url), 'utf8'), vars);
  return { schema: 'steepy-inception-governance-input/v1', runId: f.descriptor().runId, completion: f.descriptor().completion,
    projectModel: { projectName: 'sample', description: 'Sample app', devCommands: ['node --test'], surfaces: [{ name: 'src', path: 'src', agent: 'src-agent', testCmd: 'node --test' }], resolutions: {} },
    documents: [{ path: '.apex/_INDEX.md', content: template('_INDEX.md', { projectName: 'sample', routingRows: template('routing-row.md', { surface: 'src', docsPath: 'standards/src.md', agent: 'src-agent', skill: '—' }).trimEnd(), gitPolicyDirective: '' }) }, { path: '.apex/standards/src.md', content: template('surface-standard.md', { name: 'src', path: 'src', testCmd: 'node --test' }) }, ...['conventions', 'glossary', 'testing-and-checklist'].map(name => ({ path: `.apex/${name}.md`, content: `# ${name}\nApproved conventions.\n` }))] };
}

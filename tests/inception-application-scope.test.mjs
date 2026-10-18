// Pre-merge code-review fixes for the application scope, driven through fresh CLI processes.
// CR1: application names are literal, so framework route syntax is ordinary inventory.
// CR2: start binds exact pre-approval exclusions, so installed dependencies never stop
// reconnaissance; symlinks and hard links outside them still fail closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { area, contract, fixture } from './helpers/inception-fixture.mjs';

const ROUTES = {
  'app/[id]/page.tsx': 'Dynamic route\n',
  'app/(shop)/[...slug]/page.tsx': 'Catch-all route\n',
  'app/{draft}/x*?:y.txt': 'Literal name\n',
};
const inventory = (f, ref) => f.read(ref.path).body.files.map(file => file.path);
const unitAfter = (f, id) => f.descriptor().units.find(u => u.id === id).after;
function toApproval(f, exclusions) {
  for (const to of ['architecture', 'research', 'approval']) f.transition(to);
  f.put(`${area}/project/decision-register.md`, 'Approved application decisions');
  f.json(`${area}/project/verification-contract.json`, { ...f.contract, exclusions });
}

test('CR1 bracketed, braced and colon route names round-trip from reconnaissance through bootstrap', t => {
  const f = fixture(t, { git: true, initialFiles: ROUTES });
  f.begin('recon'); f.report('recon'); f.finish('recon');
  for (const path of Object.keys(ROUTES)) assert.ok(inventory(f, unitAfter(f, 'recon')).includes(path), path);
  toApproval(f, [{ path: 'app/[id]/.cache', kind: 'cache', reason: 'Route render cache' }]);
  f.approve(); f.transition('bootstrap');
  f.begin('route', { kind: 'bootstrap', allowedPaths: ['app/[id]'], outputs: [{ path: `${area}/project/route.md`, role: 'report' }, { path: 'app/[id]/page.tsx', role: 'evidence' }] });
  f.put('app/[id]/page.tsx', 'Updated dynamic route\n'); f.put('app/[id]/.cache/render.bin', 'cache\n');
  f.report('route'); f.finish('route');
  const after = inventory(f, unitAfter(f, 'route'));
  assert.ok(after.includes('app/[id]/page.tsx'));
  assert.equal(after.some(path => path.startsWith('app/[id]/.cache')), false);
  assert.equal(f.cli('resume-check').ok, true);
  f.checkpoint();
  // A literal name is still exact scope: an undeclared bracketed change is drift.
  f.put('app/(shop)/[...slug]/page.tsx', 'Unexplained change\n');
  assert.equal(f.refuse('resume-check').ok, false);
});

const DEPENDENCIES = [{ path: 'node_modules', kind: 'dependencies', reason: 'Installed packages; package.json and the lockfile stay inventoried' }];
function installedDependencies(f) {
  f.put('package.json', '{"name":"sample"}\n'); f.put('package-lock.json', '{"lockfileVersion":3}\n');
  f.put('node_modules/dep/cli.js', 'cli\n');
  fs.mkdirSync(join(f.root, 'node_modules/.bin'));
  fs.symlinkSync('../dep/cli.js', join(f.root, 'node_modules/.bin/dep'));
  f.put('node_modules/.pnpm/dep/index.js', 'shared\n');
  fs.linkSync(join(f.root, 'node_modules/.pnpm/dep/index.js'), join(f.root, 'node_modules/dep/index.js'));
}
const START = ['start', '--harness', 'codex', '--capabilities', 'shell', '--git-commits', 'allowed'];
// Exclusions arrive on standard input, never as a shell word.
function start(f, exclusions = null, expected = 0) {
  const args = [join(import.meta.dirname, '../scripts/inception-state.mjs'), ...START, '--repo-root', f.root, ...(exclusions === null ? [] : ['--exclusions-stdin'])];
  const r = f.process(args, exclusions === null ? {} : { input: typeof exclusions === 'string' ? exclusions : JSON.stringify(exclusions) });
  assert.equal(r.status, expected, r.stdout + r.stderr);
  return JSON.parse(r.stdout);
}

for (const git of [false, true]) {
  test(`CR2 ${git ? 'git' : 'no-git'}: start binds pre-approval exclusions so installed dependencies never stop the run`, t => {
    const f = fixture(t, { start: false, git });
    installedDependencies(f);
    const before = f.snapshot();
    const refused = start(f, null, 1);
    assert.match(refused.error, /node_modules\/\.bin\/dep: symlink is not an application file/);
    assert.match(refused.error, /--exclusions-stdin/);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(fs.existsSync(join(f.root, '.apex')), false);

    start(f, DEPENDENCIES);
    assert.deepEqual(f.descriptor().preapprovalExclusions, DEPENDENCIES);
    f.begin('recon'); f.put('node_modules/dep/later.js', 'Installed later\n'); f.report('recon'); f.finish('recon');
    const recon = f.read(unitAfter(f, 'recon').path).body;
    assert.deepEqual(recon.exclusions, DEPENDENCIES);
    for (const path of ['package.json', 'package-lock.json']) assert.ok(recon.files.some(file => file.path === path), path);
    assert.equal(recon.files.some(file => file.path.startsWith('node_modules/')), false);
    if (git) assert.equal(recon.git.status.some(entry => entry.includes('node_modules')), false);
    assert.equal(f.cli('resume-check').ok, true);

    // The approved contract replaces the start scope; omitting the dependency
    // exclusion there fails closed on the same symlink without mutation.
    toApproval(f, []);
    const descriptor = f.descriptor();
    assert.match(f.refuse('approve', '--statement', 'I approve this exact delivery and its checks.', '--document', `${area}/project/decision-register.md`, '--contract', `${area}/project/verification-contract.json`).error, /node_modules\/\.bin\/dep: symlink/);
    assert.deepEqual(f.descriptor(), descriptor);
    f.json(`${area}/project/verification-contract.json`, { ...f.contract, exclusions: DEPENDENCIES });
    f.approve();
    assert.equal(f.cli('resume-check').ok, true);

    // Manifests and lockfiles stay inventoried under the dependency exclusion.
    f.put('package-lock.json', '{"lockfileVersion":3,"changed":true}\n');
    assert.equal(f.refuse('resume-check').ok, false);
  });
}

test('CR2 a start refusal names an unrepresentable application path so it can be excluded', t => {
  const f = fixture(t, { start: false });
  f.put('node_modules/dep/a\\b.js', 'Backslash name\n');
  const refused = start(f, null, 1);
  assert.match(refused.error, /application path "node_modules\/dep\/a\\\\b\.js"/);
  assert.equal(fs.existsSync(join(f.root, '.apex')), false);
  start(f, DEPENDENCIES);
});

test('CR2 start refuses malformed or non-literal exclusions before any write', t => {
  const f = fixture(t, { start: false });
  const before = f.snapshot();
  for (const value of ['not json', '{}', JSON.stringify([{ path: 'node_modules', kind: 'vendor', reason: 'Packages' }]),
    JSON.stringify([...DEPENDENCIES, ...DEPENDENCIES]), JSON.stringify([{ path: '../outside', kind: 'cache', reason: 'Outside' }]),
    JSON.stringify([{ ...DEPENDENCIES[0], extra: true }]), '[{"path":"node_modules","path":"x","kind":"cache","reason":"Duplicate key"}]']) {
    const r = f.process([join(import.meta.dirname, '../scripts/inception-state.mjs'), ...START, '--repo-root', f.root, '--exclusions-stdin'], { input: value });
    assert.ok([1, 2].includes(r.status), r.stdout + r.stderr);
    const refused = JSON.parse(r.stdout);
    assert.equal(refused.ok, false, value);
    assert.match(refused.error, /exclusions/, value);
  }
  for (const [args, input] of [[['--exclusions-stdin'], ''], [['--exclusions', JSON.stringify(DEPENDENCIES)], undefined]]) {
    const r = f.process([join(import.meta.dirname, '../scripts/inception-state.mjs'), ...START, '--repo-root', f.root, ...args], { input });
    assert.equal(r.status, 2, r.stdout + r.stderr);
  }
  assert.deepEqual(f.snapshot(), before);
  assert.equal(fs.existsSync(join(f.root, '.apex')), false);
});

// CR9: contract roots name paths bootstrap creates or removes. An absent root is an
// empty part of the application, never an observation failure.
test('CR9 roots that do not exist yet are approved, then created and removed by bootstrap units', t => {
  const f = fixture(t, { phase: 'approval', approvedContract: contract(undefined, { roots: ['apps/web', 'src', 'web'] }) });
  f.approve(); f.transition('bootstrap');
  assert.deepEqual(inventory(f, f.descriptor().baseline), ['src/app.js']);
  f.begin('create-web', { kind: 'bootstrap', allowedPaths: ['web'] });
  f.put('web/index.html', '<p>Ready</p>\n'); f.report('create-web'); f.finish('create-web');
  assert.deepEqual(inventory(f, unitAfter(f, 'create-web')), ['src/app.js', 'web/index.html']);
  f.begin('drop-web', { kind: 'bootstrap', allowedPaths: ['web'] });
  fs.rmSync(join(f.root, 'web'), { recursive: true }); f.report('drop-web'); f.finish('drop-web');
  assert.deepEqual(inventory(f, unitAfter(f, 'drop-web')), ['src/app.js']);
  assert.equal(f.cli('resume-check').ok, true);
  f.begin('drop-src', { kind: 'bootstrap', allowedPaths: ['src'] });
  fs.rmSync(join(f.root, 'src'), { recursive: true }); f.report('drop-src');
  const statement = f.input({ evidence: [`${area}/project/drop-src.md`], reason: 'Source moved', statement: 'I accept removing src.' });
  assert.equal(f.cli('unit', 'reconcile', '--id', 'drop-src', '--input', statement).ok, true);
  f.checkpoint();
});

// CR14: a confirmed reason is free human text. A quoted heredoc passes apostrophes,
// backticks, command substitution and redirection signs byte-exact, with nothing run.
test('CR14 start reads exclusions from a quoted heredoc so their reasons are never shell code', t => {
  const f = fixture(t, { start: false });
  installedDependencies(f);
  const reason = "Vite's pre-bundle cache; rebuilt by `npm run dev` -> $(touch pwned) && 'build' > out";
  const exclusions = [{ path: 'node_modules', kind: 'dependencies', reason }];
  const script = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dirname, '../scripts/inception-state.mjs'))} ${START.join(' ')} --repo-root . --exclusions-stdin <<'JSON'\n${JSON.stringify(exclusions)}\nJSON\n`;
  const r = spawnSync('/bin/sh', ['-c', script], { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(f.descriptor().preapprovalExclusions, exclusions);
  for (const stray of ['pwned', 'out']) assert.equal(fs.existsSync(join(f.root, stray)), false, stray);
});

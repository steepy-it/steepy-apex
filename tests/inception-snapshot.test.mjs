import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { observeApplication, applicationIdentity, applicationChanges } from '../scripts/inception-snapshot.mjs';

function fixture(fn) {
  const root = fs.mkdtempSync(join(tmpdir(), 'steepy-inception-snapshot-'));
  try { fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function put(root, path, content = path) { fs.mkdirSync(join(root, path, '..'), { recursive: true }); fs.writeFileSync(join(root, path), content); }
test('full no-Git inventory includes ignored files, provider files, modes and additions/removals', () => fixture(root => {
  for (const path of ['.gitignore', '.env', 'package-lock.json', '.agents/app.txt', 'src/a']) put(root, path);
  const before = observeApplication(root);
  assert.deepEqual(before.files.map(f => f.path), ['.agents/app.txt', '.env', '.gitignore', 'package-lock.json', 'src/a']);
  assert.deepEqual(before.git, { present: false, branch: null, head: null, status: [] });
  fs.chmodSync(join(root, 'src/a'), 0o700); fs.unlinkSync(join(root, '.env')); put(root, 'new');
  const after = observeApplication(root);
  assert.deepEqual(applicationChanges(before, after).map(c => c.path), ['.env', 'new', 'src/a']);
  assert.notEqual(applicationIdentity(before), applicationIdentity(after));
  assert.equal(applicationIdentity(before), applicationIdentity({ ...before, git: { ...before.git, branch: 'provenance-only' } }));
}));
test('reserved local areas and their physical aliases are excluded before readdir', () => fixture(root => {
  for (const path of ['.apex/inception/private', '.apex/work/private', '.git/private', 'src/a']) put(root, path);
  fs.symlinkSync(join(root, '.apex/work'), join(root, 'work-alias'));
  const original = fs.readdirSync; const attempted = [];
  fs.readdirSync = (path, ...args) => { attempted.push(fs.realpathSync(path)); return original(path, ...args); };
  try {
    assert.deepEqual(observeApplication(root, { git: { present: false, branch: null, head: null, status: [] } }).files.map(f => f.path), ['src/a']);
  } finally { fs.readdirSync = original; }
  for (const path of ['.apex/work', '.apex/inception', '.git']) assert.equal(attempted.some(p => p === join(root, path) || p.startsWith(join(root, path) + '/')), false);
}));
test('explicit roots and motivated exclusions are exact, no implicit dependency or lock exclusions', () => fixture(root => {
  for (const path of ['app/src/a', 'app/cache/data', 'other/a', 'node_modules/a', '.steepy-project-scaffold.lock/user']) put(root, path);
  const all = observeApplication(root);
  assert.ok(all.files.some(f => f.path === 'node_modules/a')); assert.ok(all.files.some(f => f.path.endsWith('/user')));
  const scoped = observeApplication(root, { roots: ['app'], exclusions: [{ path: 'app/cache', kind: 'cache', reason: 'Rebuildable cache' }] });
  assert.deepEqual(scoped.files.map(f => f.path), ['app/src/a']);
  assert.throws(() => observeApplication(root, { roots: ['app/../other'] }), /path|scope|relative/);
  assert.throws(() => observeApplication(root, { exclusions: [{ path: 'app', kind: 'cache', reason: '' }] }), /text/);
}));
test('unsafe links and unrepresentable filenames refuse the entire observation', () => fixture(root => {
  put(root, 'ok'); fs.symlinkSync('ok', join(root, 'link'));
  assert.throws(() => observeApplication(root), /symlink/); fs.unlinkSync(join(root, 'link'));
  fs.linkSync(join(root, 'ok'), join(root, 'hard'));
  assert.throws(() => observeApplication(root), /single-link/); fs.unlinkSync(join(root, 'hard'));
  put(root, 'bad\nname'); assert.throws(() => observeApplication(root), /path|line|control/);
}));
test('Git is separate provenance and changing HEAD with identical files preserves application identity', () => fixture(root => {
  const run = (...args) => { const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  run('init', '-q'); run('config', 'user.name', 'Test'); run('config', 'user.email', 'test@example.test'); put(root, 'app'); run('add', 'app'); run('commit', '-qm', 'Initial');
  const before = observeApplication(root); run('commit', '--allow-empty', '-qm', 'Provenance'); const after = observeApplication(root);
  assert.notEqual(before.git.head, after.git.head); assert.equal(applicationIdentity(before), applicationIdentity(after));
}));
test('callers cannot exempt a lock-looking directory by passing a boolean', () => fixture(root => {
  put(root, '.steepy-project-scaffold.lock/user');
  assert.ok(observeApplication(root, { activeLease: true }).files.some(f => f.path.endsWith('/user')));
}));
test('UTF-8 filenames are never normalized into another application entry', () => fixture(root => {
  put(root, 'name', 'plain'); put(root, '\ufeffname', 'different bytes');
  const snapshot = observeApplication(root);
  assert.deepEqual(snapshot.files.map(f => f.path), ['name', '\ufeffname']);
  assert.notEqual(snapshot.files[0].sha256, snapshot.files[1].sha256);
}));
test('governance receipt names are ordinary inventory files until the completion verifier authenticates them', () => fixture(root => {
  for (const path of ['.apex/init-provenance.pending.json', '.apex/init-provenance.json', '.agents/foreign.md']) put(root, path, 'not a receipt');
  assert.deepEqual(observeApplication(root).files.map(file => file.path), ['.agents/foreign.md', '.apex/init-provenance.json', '.apex/init-provenance.pending.json']);
}));

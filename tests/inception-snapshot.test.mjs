import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { observeApplication, applicationIdentity, applicationChanges, withApplicationSnapshotLease } from '../scripts/inception-snapshot.mjs';

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

// F2: one excluded set drives both the walk and Git status. The repository has
// no .gitignore, so only the approved contract exclusions can hide these paths.
const EXCLUSIONS = [{ path: 'dist', kind: 'generated', reason: 'Build output' }, { path: 'node_modules', kind: 'dependencies', reason: 'Installed packages' }];
function withEnv(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
// Isolate Git from user/system configuration such as a global core.excludesFile.
const hermeticGit = fn => withEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, fn);
function excludedTree(root) {
  const run = (...args) => { const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  run('init', '-q'); run('config', 'user.name', 'Test'); run('config', 'user.email', 'test@example.test');
  put(root, 'src/app.js'); put(root, 'dist/tracked.js', 'v1'); run('add', 'src/app.js', 'dist/tracked.js'); run('commit', '-qm', 'Initial');
  put(root, 'dist/tracked.js', 'v2'); put(root, 'dist/out.js'); put(root, 'node_modules/dep/index.js'); put(root, 'package.json', '{}');
  for (const path of ['.apex/inception/run.json', '.apex/work/notes.md']) put(root, path);
}
// Excluded and reserved paths are absent from both inventories; package.json is in both.
function assertFiltered(snapshot) {
  assert.deepEqual(snapshot.files.map(f => f.path), ['package.json', 'src/app.js']);
  assert.deepEqual(snapshot.git.status, ['?? package.json']);
}
test('F2 contract exclusions hide untracked, dependency and modified tracked paths from files and Git status', () => fixture(root => hermeticGit(() => {
  excludedTree(root);
  assertFiltered(observeApplication(root, { exclusions: EXCLUSIONS }));
})));
test('F2 inherited GIT_LITERAL_PATHSPECS cannot disable the exclusion pathspecs', () => fixture(root => hermeticGit(() => {
  excludedTree(root);
  withEnv({ GIT_LITERAL_PATHSPECS: '1' }, () => assertFiltered(observeApplication(root, { exclusions: EXCLUSIONS })));
})));
test('F2 an absent exclusion leaves files unchanged but still changes the application scope identity', () => fixture(root => hermeticGit(() => {
  excludedTree(root);
  const none = observeApplication(root, { exclusions: [] });
  const absent = observeApplication(root, { exclusions: [{ path: 'absent', kind: 'cache', reason: 'Absent cache' }] });
  assert.deepEqual(absent.files, none.files);
  assert.notEqual(applicationIdentity(absent), applicationIdentity(none));
})));

// F4: structurally recognized scaffold lease directories, live or dead, are
// excluded by exact path for every observer. Every other lock-like path stays.
const LOCK = '.steepy-project-scaffold.lock';
const scaffoldModule = new URL('../scripts/project-scaffold.mjs', import.meta.url).href;
const ownerBytes = (pid, token) => `${JSON.stringify({ schemaVersion: 1, pid, token })}\n`;
const newToken = () => randomBytes(16).toString('hex');
// Recognition never consults liveness, so residues name an already exited pid.
function exitedPid() { const r = spawnSync(process.execPath, ['-e', '']); assert.equal(r.status, 0); return r.pid; }
function leaseEntry(root, name, bytes, mode = 0o600) {
  fs.mkdirSync(join(root, name), { mode: 0o700 });
  fs.writeFileSync(join(root, name, 'owner.json'), bytes); fs.chmodSync(join(root, name, 'owner.json'), mode);
  return name;
}
// A canonical residue whose name agrees with its own record.
function residue(root, kind, pid = exitedPid(), token = newToken()) {
  return leaseEntry(root, kind === 'candidate' ? `${LOCK}.candidate-${pid}-${token}` : `${LOCK}.${kind}-${token}`, ownerBytes(pid, token));
}
// The canonical lock of a holder that terminated inside the lease.
function deadLock(root) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { withProjectScaffoldLock } from ${JSON.stringify(scaffoldModule)}; withProjectScaffoldLock({ hubRoot: ${JSON.stringify(root)} }, () => process.exit(73));`], { encoding: 'utf8' });
  assert.equal(r.status, 73, r.stderr);
  return LOCK;
}
// Comparison metadata from lstat only: a link records its target, never its content.
function lstatTree(root, path = '', out = {}) {
  for (const name of fs.readdirSync(join(root, path)).sort()) {
    const rel = path ? `${path}/${name}` : name;
    if (rel === '.git') continue; // Git metadata is provenance, not observed application output.
    const st = fs.lstatSync(join(root, rel));
    if (st.isSymbolicLink()) out[rel] = ['link', fs.readlinkSync(join(root, rel)), st.mtimeMs];
    else if (st.isDirectory()) { out[rel] = ['dir', st.mode, st.mtimeMs]; lstatTree(root, rel, out); }
    else out[rel] = ['file', st.mode, st.mtimeMs, fs.readFileSync(join(root, rel)).toString('base64')];
  }
  return out;
}
// One committed and one untracked application file keep each assertion non-vacuous.
function leaseApp(root, git) {
  put(root, 'src/app.js');
  if (git) {
    const run = (...args) => { const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
    run('init', '-q'); run('config', 'user.name', 'Test'); run('config', 'user.email', 'test@example.test'); run('add', 'src/app.js'); run('commit', '-qm', 'Initial');
  }
  put(root, 'src/new.js');
}
const APP_FILES = ['src/app.js', 'src/new.js'];
for (const git of [false, true]) {
  const label = git ? 'Git' : 'no Git';
  test(`F4 ${label}: a dead canonical lock and canonical stale, retired and candidate residues are absent from files and Git status`, () => fixture(root => hermeticGit(() => {
    leaseApp(root, git);
    const leases = [deadLock(root), ...['stale', 'retired', 'candidate'].map(kind => residue(root, kind))];
    assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith(LOCK)).sort(), [...leases].sort());
    const before = lstatTree(root);
    const snapshot = observeApplication(root);
    assert.deepEqual(snapshot.files.map(f => f.path), APP_FILES);
    assert.equal(snapshot.git.present, git);
    assert.deepEqual(snapshot.git.status, git ? ['?? src/new.js'] : []);
    assert.deepEqual(lstatTree(root), before, 'observation is read-only');
  })));

  const unrecognized = {
    'an extra entry': root => { const name = residue(root, 'retired'); put(root, `${name}/extra.txt`, 'Extra entry'); return [`${name}/extra.txt`, `${name}/owner.json`]; },
    'a mode 0644 record': root => { const token = newToken(); return [`${leaseEntry(root, `${LOCK}.retired-${token}`, ownerBytes(exitedPid(), token), 0o644)}/owner.json`]; },
    'a discordant token': root => [`${leaseEntry(root, `${LOCK}.retired-${newToken()}`, ownerBytes(exitedPid(), newToken()))}/owner.json`],
  };
  for (const [shape, make] of Object.entries(unrecognized)) test(`F4 ${label}: a lease-named directory with ${shape} stays in files and Git status`, () => fixture(root => hermeticGit(() => {
    leaseApp(root, git);
    const lockFiles = make(root);
    const before = lstatTree(root);
    const snapshot = observeApplication(root);
    assert.deepEqual(snapshot.files.map(f => f.path), [...lockFiles, ...APP_FILES].sort());
    assert.deepEqual(snapshot.git.status, git ? [...lockFiles, 'src/new.js'].map(path => `?? ${path}`).sort() : []);
    assert.deepEqual(lstatTree(root), before, 'observation is read-only');
  })));

  test(`F4 ${label}: a lease-named symlink to an external canonical lease directory refuses the observation`, () => fixture(root => hermeticGit(() => {
    leaseApp(root, git);
    const outside = fs.mkdtempSync(join(tmpdir(), 'steepy-inception-snapshot-outside-'));
    try {
      const pid = exitedPid(), token = newToken();
      leaseEntry(outside, 'lease', ownerBytes(pid, token));
      fs.symlinkSync(join(outside, 'lease'), join(root, `${LOCK}.retired-${token}`));
      const before = lstatTree(root); const external = lstatTree(outside);
      assert.throws(() => observeApplication(root), /symlink/);
      assert.deepEqual(lstatTree(root), before); assert.deepEqual(lstatTree(outside), external);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  })));
}
test('F4 a symlink alias to the recognized live lease directory stays an error inside the lease', () => fixture(root => {
  put(root, 'src/app.js');
  withApplicationSnapshotLease(root, () => {
    fs.symlinkSync(join(root, LOCK), join(root, 'lease-alias'));
    assert.throws(() => observeApplication(root, { git: { present: false, branch: null, head: null, status: [] } }), /lease-alias: symlink/);
  });
}));
test('F4 a recognized lease directory that changes during the walk refuses the observation', () => fixture(root => {
  put(root, 'src/app.js'); const name = residue(root, 'retired');
  // Only the walk's default-export listing is replaced; recognition keeps its named import.
  const original = fs.readdirSync; let listed = false;
  fs.readdirSync = function (path, ...rest) {
    if (!listed && path === root) { listed = true; fs.writeFileSync(join(root, name, 'extra.txt'), 'Late entry'); }
    return original.call(this, path, ...rest);
  };
  try {
    assert.throws(() => observeApplication(root), /recognized lease directories changed during observation/);
  } finally { fs.readdirSync = original; }
  assert.equal(listed, true);
}));
test('Git status larger than the default 1 MiB child buffer is observed in full', () => fixture(root => hermeticGit(() => {
  const run = (...args) => { const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  run('init', '-q');
  // About 0.7 KiB per status entry: 1,500 untracked files exceed 1 MiB of porcelain output.
  const dir = `${'d'.repeat(240)}/${'e'.repeat(240)}`; fs.mkdirSync(join(root, dir), { recursive: true });
  for (let n = 0; n < 1500; n++) fs.writeFileSync(join(root, dir, `${String(n).padStart(4, '0')}${'f'.repeat(236)}`), '');
  const snapshot = observeApplication(root);
  assert.equal(snapshot.files.length, 1500);
  assert.equal(snapshot.git.status.length, 1500);
  assert.ok(snapshot.git.status.join('\0').length > 1024 * 1024);
})));
test('a root or root ancestor that does not exist yet contributes no files; a file ancestor still refuses', () => fixture(root => {
  const git = { present: false, branch: null, head: null, status: [] };
  put(root, 'src/a'); put(root, 'package.json', '{}');
  const snapshot = observeApplication(root, { roots: ['src', 'web', 'apps/web', 'Cargo.toml'], git });
  assert.deepEqual(snapshot.files.map(f => f.path), ['src/a']);
  assert.deepEqual(snapshot.roots, ['src', 'web', 'apps/web', 'Cargo.toml']);
  put(root, 'web/index.html');
  assert.deepEqual(observeApplication(root, { roots: ['src', 'web'], git }).files.map(f => f.path), ['src/a', 'web/index.html']);
  assert.throws(() => observeApplication(root, { roots: ['package.json/x'], git }), /ENOTDIR|not a directory/);
}));

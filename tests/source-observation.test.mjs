import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { observeSource, changedSourcePaths } from '../scripts/source-observation.mjs';

test('source observations preserve literal route names, index changes, deletions, modes and symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'steepy-source-observation-'));
  const git = (...args) => execFileSync('git', args, { cwd: root });
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  try {
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
    put('.gitignore', '.apex/work/\n'); put('deleted', 'old'); put('executable', 'old'); git('add', '.'); git('commit', '-qm', 'baseline');
    const before = observeSource(root);
    const names = ['apps/web/app/admin/(protected)/generation/[id]/page.tsx', 'apps/web/app/admin/(protected)/generation/[id]/page.test.tsx', 'apps/web/app/admin/(protected)/issues/[id]/page.tsx', 'apps/web/app/admin/(protected)/issues/[id]/page.test.tsx', 'spaces ü,semi;\nline'];
    for (const name of names) put(name, name);
    chmodSync(join(root, 'executable'), 0o755); rmSync(join(root, 'deleted')); symlinkSync('missing', join(root, 'link'));
    put('.apex/work/tasks/run/task-1-report.md', 'ignored');
    const after = observeSource(root);
    assert.deepEqual(changedSourcePaths(before, after), [...names, 'deleted', 'executable', 'link'].sort());
    git('add', '--', names[0]);
    assert.notEqual(observeSource(root).digest, after.digest);
    git('commit', '-qm', 'one'); git('add', '.'); git('commit', '-qm', 'two');
    assert.deepEqual(changedSourcePaths(before, observeSource(root)), [...names, 'deleted', 'executable', 'link'].sort());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('source observation rejects traversing tracked paths through a symlink parent', () => {
  const root = mkdtempSync(join(tmpdir(), 'steepy-source-parent-'));
  const git = (...args) => execFileSync('git', args, { cwd: root });
  try {
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
    mkdirSync(join(root, 'dir')); writeFileSync(join(root, 'dir', 'file'), 'x'); git('add', '.'); git('commit', '-qm', 'baseline');
    rmSync(join(root, 'dir'), { recursive: true }); symlinkSync(tmpdir(), join(root, 'dir'));
    assert.throws(() => observeSource(root), /unsafe source ancestor/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dirty and staged starting state, renames and index-only updates remain observable', () => {
  const root = mkdtempSync(join(tmpdir(), 'steepy-source-dirty-'));
  const git = (...args) => execFileSync('git', args, { cwd: root });
  try {
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
    writeFileSync(join(root, 'old'), 'base'); git('add', '.'); git('commit', '-qm', 'baseline');
    writeFileSync(join(root, 'old'), 'staged'); git('add', 'old'); writeFileSync(join(root, 'old'), 'unstaged');
    const dirty = observeSource(root);
    git('add', 'old'); assert.deepEqual(changedSourcePaths(dirty, observeSource(root)), ['old']);
    renameSync(join(root, 'old'), join(root, 'renamed')); git('add', '-A'); git('commit', '-qm', 'rename');
    assert.deepEqual(changedSourcePaths(dirty, observeSource(root)), ['old', 'renamed']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const direction of ['directory-to-file', 'file-to-directory']) test(`source observation captures ordinary ${direction} replacements`, () => {
  const root = mkdtempSync(join(tmpdir(), 'steepy-source-replacement-'));
  const git = (...args) => execFileSync('git', args, { cwd: root });
  try {
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
    if (direction === 'directory-to-file') { mkdirSync(join(root, 'item')); writeFileSync(join(root, 'item', 'old'), 'old'); }
    else writeFileSync(join(root, 'item'), 'old');
    git('add', '.'); git('commit', '-qm', 'baseline'); const before = observeSource(root);
    rmSync(join(root, 'item'), { recursive: true });
    if (direction === 'directory-to-file') writeFileSync(join(root, 'item'), 'new');
    else { mkdirSync(join(root, 'item')); writeFileSync(join(root, 'item', 'new'), 'new'); }
    git('add', '-A');
    assert.deepEqual(changedSourcePaths(before, observeSource(root)), ['item', `item/${direction === 'directory-to-file' ? 'old' : 'new'}`]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

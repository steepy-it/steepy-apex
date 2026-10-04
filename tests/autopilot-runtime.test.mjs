import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprintAutopilotRuntime, loadAutopilotRuntime, verifyAutopilotRuntime } from '../scripts/autopilot-runtime.mjs';
import { createAutopilotRun, reconcileAutopilotStart, resumeAutopilotRun } from '../scripts/autopilot-state.mjs';
import { writeWorkPath } from '../scripts/work-paths.mjs';

test('selected engine identity follows packaged instructions and mapping, not target code', () => {
  const root = mkdtempSync(join(tmpdir(), 'steepy-autopilot-runtime-'));
  try {
    for (const dir of ['scripts', 'adapters', 'skills/implement', 'target']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"version":"1.0.0"}\n');
    writeFileSync(join(root, 'scripts/autopilot.mjs'), 'export {}\n');
    writeFileSync(join(root, 'adapters/model-mappings.mjs'), 'export {}\n');
    writeFileSync(join(root, 'skills/implement/SKILL.md'), '# Implement\n');
    writeFileSync(join(root, 'target/code.js'), 'one\n');
    const identity = fingerprintAutopilotRuntime(root);
    const runDir = '.apex/work/tasks/2026-10-01-selected-runtime';
    createAutopilotRun(join(root, 'target'), runDir, {
      runId: 'selected-runtime', branch: 'feature/runtime', baseline: 'a'.repeat(40), runtime: identity,
    }, { engineRoot: root });
    assert.equal(resumeAutopilotRun(join(root, 'target'), runDir, root).state.runId, 'selected-runtime');
    const incompleteDir = '.apex/work/tasks/2026-10-01-incomplete-start';
    writeWorkPath(join(root, 'target'), `${incompleteDir}/autopilot-run.json`, `${JSON.stringify({
      schemaVersion: 1, controllerProtocol: 2, runId: 'incomplete-start',
      branch: 'feature/runtime', baseline: 'a'.repeat(40), runtime: identity,
    })}\n`, { createOnly: true, family: 'autopilot-run' });
    assert.equal(reconcileAutopilotStart(join(root, 'target'), incompleteDir, root).state.runId, 'incomplete-start');
    assert.equal(identity.files.some((file) => file.path === 'package.json'), true);
    assert.equal(identity.files.some((file) => file.path === 'target/code.js'), false);
    assert.equal(verifyAutopilotRuntime(root, identity).fingerprint, identity.fingerprint);
    writeFileSync(join(root, 'target/code.js'), 'two\n');
    assert.equal(fingerprintAutopilotRuntime(root).fingerprint, identity.fingerprint);
    writeFileSync(join(root, 'adapters/model-mappings.mjs'), 'export const changed = true;\n');
    assert.throws(() => verifyAutopilotRuntime(root, identity), /runtime|fingerprint|mismatch/i);
    assert.throws(() => resumeAutopilotRun(join(root, 'target'), runDir, root), /runtime|fingerprint|mismatch/i);
    assert.equal(loadAutopilotRuntime(root).files.some((file) => file.path === 'skills/implement/SKILL.md'), true);
    symlinkSync(join(root, 'target'), join(root, '.claude-plugin'));
    assert.throws(() => fingerprintAutopilotRuntime(root), /symlink/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const engine = join(dirname(fileURLToPath(import.meta.url)), '..');

// A clean copy of the real engine package: dotfiles skipped so a dev checkout's own junk never leaks in.
function engineCopy() {
  const root = mkdtempSync(join(tmpdir(), 'steepy-autopilot-junk-'));
  for (const area of ['scripts', 'adapters', 'skills']) {
    cpSync(join(engine, area), join(root, area), { recursive: true, filter: (source) => !basename(source).startsWith('.') });
  }
  for (const file of ['package.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.codex-plugin/plugin.json', 'cordis.patch.yml']) {
    if (!existsSync(join(engine, file))) continue;
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(engine, file), join(root, file));
  }
  return root;
}

const junk = ['skills/.DS_Store', 'skills/x/._foo.md', 'skills/implement/.SKILL.md.swp', 'scripts/.DS_Store', 'scripts/._autopilot.mjs', 'adapters/.hidden.json'];

function addJunk(root) {
  mkdirSync(join(root, 'skills/x'), { recursive: true });
  for (const file of junk) writeFileSync(join(root, file), 'junk\n');
}

test('operating-system and editor junk never enters the runtime identity', () => {
  const root = engineCopy();
  try {
    const clean = fingerprintAutopilotRuntime(root);
    addJunk(root);
    const dirty = fingerprintAutopilotRuntime(root);
    assert.deepEqual(dirty.files, clean.files);
    assert.equal(dirty.fingerprint, clean.fingerprint);
    assert.deepEqual(loadAutopilotRuntime(root).files.map(({ path }) => path), clean.files.map(({ path }) => path));
    assert.equal(verifyAutopilotRuntime(root, clean).fingerprint, clean.fingerprint);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('skipping dotfiles still fingerprints every tracked runtime file', () => {
  const listed = spawnSync('git', ['ls-files', 'scripts', 'adapters', 'skills'], { cwd: engine, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const tracked = listed.stdout.split('\n').filter(Boolean);
  assert.deepEqual(tracked.filter((path) => path.split('/').some((part) => part.startsWith('.'))), [], 'no tracked dotfile may exist under the walked areas');
  const expected = tracked.filter((path) => path.startsWith('skills/') || /\.(?:mjs|js|json)$/u.test(path));
  const fingerprinted = new Set(fingerprintAutopilotRuntime(engine).files.map(({ path }) => path));
  for (const path of expected) assert.equal(fingerprinted.has(path), true, `${path} must stay fingerprinted`);
});

test('fingerprinted files stay inside the npm tarball even with junk present', () => {
  const root = engineCopy();
  const cache = mkdtempSync(join(tmpdir(), 'steepy-autopilot-junk-cache-'));
  try {
    addJunk(root);
    const packed = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--cache', cache, 'pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    const tarball = new Set(JSON.parse(packed.stdout)[0].files.map(({ path }) => path));
    for (const { path } of fingerprintAutopilotRuntime(root).files) assert.equal(tarball.has(path), true, `tarball must include ${path}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

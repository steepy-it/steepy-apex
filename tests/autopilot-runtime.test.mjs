import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

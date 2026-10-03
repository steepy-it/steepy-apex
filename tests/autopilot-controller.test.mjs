import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildControllerTaskManifest, ensureControllerTaskBrief, writeContextManifest,
} from '../scripts/autopilot-context.mjs';
import { decodePhaseResponse, runController } from '../scripts/autopilot-controller.mjs';
import { readAutopilotRun } from '../scripts/autopilot-state.mjs';
import { decodeReviewerResponse } from '../adapters/reviewer-response.mjs';
import { verifyTaskResults } from '../scripts/task-results.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const contextScript = join(here, '..', 'scripts', 'autopilot-context.mjs');
const SPEC = '.apex/work/specs/topic.md';
const PLAN = '.apex/work/plans/topic.md';
const DIR = '.apex/work/tasks/topic';
const ROUTING = '# Hub\n\n| Surface | Min docs | Specialist agent | Applicable skill |\n|---|---|---|---|\n| `scripts` | [standards/scripts.md](standards/scripts.md) | `scripts-agent` | — |\n';

const specText = `<!-- verdict: GAP | gear: 3
drive: autopilot
branch: gear3-topic
commit-auth: per-task
harness: claude
blast-radius: branch-only, no-push, stop-before-PR
-->

# Topic spec

- **Owning surface:** \`scripts\`
- **Feature complexity:** \`integration\`

## Success criteria

1. SC1 — The value is updated.
2. SC2 — The second value is updated.
`;

function taskSection(id, { complexity = 'integration', path = `src/value-${id}.mjs`, criteria = `SC${id}` } = {}) {
  return `## Task ${id} — update value ${id}

- **Requirements and deliverables:** Set value ${id} to its next number.
- **Relevant global constraints:** Node built-ins only.
- **Surface:** \`scripts\`
- **Specialist agent:** \`scripts-agent\`
- **Exact paths:** \`${path}\`
- **Test command:** \`npm test\`
- **Dependencies:** ${id === 1 ? 'none' : 'Task 1'}
- **Complexity:** ${complexity}
- **Success criteria:** ${criteria}
`;
}

function planText(tasks = [taskSection(1)], status = 'DRAFT') {
  return `<!-- steepy-workflow: v1
phase: plan
status: ${status}
next: implement
source: ${SPEC}
consumed-by: none
-->
# Plan

${tasks.join('\n')}`;
}

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'steepy-controller-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  git('init', '-q', '-b', 'gear3-topic');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  put('.gitignore', '.apex/work/\n');
  put('.apex/_INDEX.md', ROUTING);
  put('.apex/standards/scripts.md', '# Scripts\n\n> Owning surface: `scripts`.\n');
  put('.apex/testing-and-checklist.md', '# Tests\n\n`npm test`\n');
  put('.apex/conventions.md', '# Conventions\n');
  put('src/value-1.mjs', 'export const value = 0;\n');
  put('src/value-2.mjs', 'export const value = 0;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'baseline');
  put(SPEC, specText);
  return { root, git, put, read: (path) => readFileSync(join(root, path), 'utf8') };
}

const briefInput = (root, text = planText()) => ({
  controllerProtocol: 2, repoRoot: root, planText: text, taskId: '1', routingText: ROUTING,
  briefPath: `${DIR}/task-1-brief.md`, sourcePlanPath: PLAN,
});

test('controller briefs are created once, reused only when byte-identical, and drift halts', (t) => {
  const { root, put, read } = repository(t);
  const first = ensureControllerTaskBrief(briefInput(root));
  assert.equal(first.created, true);
  const bytes = read(`${DIR}/task-1-brief.md`);
  assert.match(bytes, /Set value 1 to its next number\./);
  const again = ensureControllerTaskBrief(briefInput(root));
  assert.equal(again.created, false);
  assert.equal(read(`${DIR}/task-1-brief.md`), bytes);
  put(`${DIR}/task-1-brief.md`, `${bytes}tampered\n`);
  assert.throws(() => ensureControllerTaskBrief(briefInput(root)), /Task 1 brief drift/);
  assert.equal(read(`${DIR}/task-1-brief.md`), `${bytes}tampered\n`, 'drift is never overwritten');
});

test('a controller task manifest binds the brief bytes to the validated plan materialization', (t) => {
  const { root, put, read } = repository(t);
  ensureControllerTaskBrief(briefInput(root));
  const input = { ...briefInput(root), runId: 'run-1', modelTier: 'standard', attempt: 1 };
  assert.equal(buildControllerTaskManifest('implementer', input).scope.task, 1);
  put(`${DIR}/task-1-brief.md`, read(`${DIR}/task-1-brief.md`).replace('Set value 1', 'Delete value 1'));
  assert.throws(() => buildControllerTaskManifest('implementer', input), /Task 1 brief drift/);
});

test('role manifests can be published create-only before dispatch', (t) => {
  const { root } = repository(t);
  ensureControllerTaskBrief(briefInput(root));
  const manifest = buildControllerTaskManifest('implementer',
    { ...briefInput(root), runId: 'run-1', modelTier: 'standard', attempt: 1 });
  const manifestPath = `${DIR}/context/role-1.json`;
  writeContextManifest(manifest, { repoRoot: root, manifestPath, createOnly: true });
  assert.throws(() => writeContextManifest(manifest, { repoRoot: root, manifestPath, createOnly: true }),
    /already exists/);
});

test('the controller-protocol-2 plan verifier runs the executable grammar; legacy output is unchanged', (t) => {
  const { root, put } = repository(t);
  const verify = (...extra) => spawnSync(process.execPath, [contextScript,
    '--verify-plan', '--repo-root', root, '--plan', PLAN, ...extra], { encoding: 'utf8' });
  put(PLAN, planText([taskSection(1), taskSection(2)]));
  const accepted = verify('--controller-protocol', '2');
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /plan OK — controller protocol 2 — 2 task\(s\): 1, 2/);
  assert.match(verify().stdout, /^plan OK — 2 task\(s\): 1, 2\n$/);
  assert.match(verify('--controller-protocol', '1').stdout, /^plan OK — 2 task\(s\): 1, 2\n$/);

  for (const [plan, reason] of [
    [planText([taskSection(1, { path: '.apex/work/tasks/topic/notes.md' })]), /must not enter repository-local area \.apex\/work/],
    [planText([taskSection(1, { path: '.apex/inception/state.json' })]), /must not enter repository-local area \.apex\/inception/],
    [planText([taskSection(1).replace('Set value 1', `Apply ${SPEC} as written. Set value 1`)]), /spec section needs an exact path and heading capability/],
    [planText([taskSection(1).replace('- **Specialist agent:** `scripts-agent`\n', '')]), /missing Specialist agent/],
  ]) {
    put(PLAN, plan);
    const legacy = verify();
    assert.equal(legacy.status, 0, `the legacy grammar keeps accepting: ${legacy.stderr}`);
    const refused = verify('--controller-protocol', '2');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /autopilot-context: plan rejected: /);
    assert.match(refused.stderr, reason);
  }
  const misused = verify('--controller-protocol', '3');
  assert.equal(misused.status, 2);
});

const RUN_ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const contract = {
  verdict: 'GAP', gear: 3, drive: 'autopilot', branch: 'gear3-topic', commitAuth: 'per-task',
  harness: 'claude', blastRadius: 'branch-only, no-push, stop-before-PR', logMode: 'safe',
};
// capture-review-evidence.mjs output shape: one section per command, then the collection result.
function evidenceReport({ command = 'npm test', surfaceExit = 0, hubExit = 0, started = new Date().toISOString(), passed } = {}) {
  const section = (label, display, exit) => {
    const output = `${label} output\n`;
    return `\n## ${label}\n\nCommand JSON: ${JSON.stringify(display)}\nStarted: ${started}\n\n--- combined stdout/stderr begin ---\n${output}`
      + `\n--- combined stdout/stderr end ---\n\nExit code: ${exit}\nSignal: none\nSpawn error: none\nOutput bytes: ${Buffer.byteLength(output)}\n`
      + `Output lines: 1\nOutput SHA-256: ${createHash('sha256').update(output).digest('hex')}\nFinished: ${started}\n`;
  };
  return `# Review evidence\n\nRun started: ${started}\nCapture: combined stdout/stderr bytes are persisted in arrival order.\n`
    + section('surface-test', command, surfaceExit) + section('validate-hub', '"node" "scripts/validate-hub.mjs" .', hubExit)
    + `## Collection result\n\nRun finished: ${started}\nAll commands passed: ${passed ?? (surfaceExit === 0 && hubExit === 0)}\n`;
}
const writerPayload = (task, status = 'DONE', signals = 'tdd:red-green') => `status: ${status}\nartifact: ${DIR}/task-${task}-report.md\nsignals: ${signals}`;
const fixTargets = (rows) => `# Final issues\n\nFinding F1: value drift.\n\nsteepy-fix-targets: v1\n\`\`\`json\n${JSON.stringify(rows)}\n\`\`\`\n`;

// The injected runner stands in for one fresh child per role invocation. It
// reads only the manifest the controller published before dispatch, performs
// that role's assigned writes, and returns the closed role payload.
function scriptedRunner(repo, { tasks = [taskSection(1)], script = {} } = {}) {
  const calls = [];
  const queues = Object.fromEntries(Object.entries(script).map(([role, steps]) => [role, [...steps]]));
  const executions = new Map();
  const defaults = {
    plan: () => { repo.put(PLAN, planText(tasks)); return 'status: DONE\nsignals: none'; },
    implementer: ({ task }) => {
      const execution = (executions.get(task) ?? 0) + 1;
      executions.set(task, execution);
      repo.put(`src/value-${task}.mjs`, `export const value = ${execution};\n`);
      repo.put(`${DIR}/task-${task}-report.md`, `# Task ${task} report\n\nExecution ${execution}: RED then GREEN.\n`);
      return writerPayload(task);
    },
    'task-reviewer': ({ task }) => { repo.put(`${DIR}/task-${task}-review.md`, `# Task ${task} review\n\nApproved.\n`); return 'status: APPROVED\nsignals: none'; },
    'final-review': () => { repo.put(`${DIR}/final-review.md`, '# Final review\n\nApproved.\n'); return 'status: APPROVED\nsignals: none'; },
    review: () => {
      repo.put(`${DIR}/review-report.md`, `<!-- steepy-workflow: v1\nphase: review\nstatus: DRAFT\nnext: none\nsource: ${DIR}/task-result-index.md\nconsumed-by: none\n-->\n# Review report\n\nSC1 met.\n`);
      repo.put(`${DIR}/evidence-report.md`, evidenceReport());
      return 'status: READY_FOR_PR\nsignals: none';
    },
  };
  defaults.fix = defaults.implementer;
  defaults['task-review-correction'] = () => 'status: APPROVED\nsignals: none';
  defaults['final-review-correction'] = defaults['task-review-correction'];
  const runner = {
    prepare(request) {
      return {
        requestedModel: null, descriptorModel: null, degradationReason: 'injected test runner',
        run: async ({ rawPath }) => {
          const manifest = JSON.parse(repo.read(request.manifestPath));
          const task = manifest.scope.task === undefined ? null : String(manifest.scope.task);
          calls.push({ role: request.role, roleSequence: request.roleSequence, task, iteration: request.scope.iteration, modelTier: request.modelTier });
          const step = queues[request.role]?.shift() ?? defaults[request.role];
          const outcome = step({ ...repo, manifest, request, task, defaults });
          const result = typeof outcome === 'string' ? { payload: outcome, exit: { status: 0, signal: null } } : outcome;
          // The transport persists the child's complete stream after it exits.
          repo.put(rawPath, `${JSON.stringify({ type: 'result', result: result.payload ?? null })}\n`);
          return result;
        },
      };
    },
  };
  return { runner, calls };
}

function control(repo, runner, extra = {}) {
  return runController({
    repoRoot: repo.root, specName: 'topic', contract, runId: RUN_ID,
    services: { runner, log: () => {}, ...extra },
  });
}

const journal = (repo) => readAutopilotRun(repo.root, DIR).state;
const header = (text) => Object.fromEntries(/<!-- steepy-workflow: v1\n([\s\S]*?)\n-->/.exec(text)[1]
  .split('\n').map((line) => line.split(': ')));

test('a fresh controller run drives plan, writer, task review, final review, and review to completion', async (t) => {
  const repo = repository(t);
  const { runner, calls } = scriptedRunner(repo);
  const result = await control(repo, runner);
  assert.equal(result.code, 0, result.reason);
  assert.deepEqual(calls.map(({ role }) => role), ['plan', 'implementer', 'task-reviewer', 'final-review', 'review']);
  const state = journal(repo);
  assert.equal(state.status, 'COMPLETED');
  assert.ok(state.roles.every((role) => role.accepted));
  assert.deepEqual(state.phases.map(({ scope, accepted }) => [scope.phase, accepted]),
    [['plan', true], ['implement', true], ['review', true]]);
  for (const role of state.roles) {
    const manifest = JSON.parse(repo.read(`${DIR}/context/role-${role.roleSequence}.json`));
    if (!role.role.endsWith('-correction')) {
      assert.equal(manifest.contract.controllerProtocol, 2);
      assert.equal(manifest.contract.taskResultProtocol, 2);
      assert.equal(manifest.contract.taskResultIndexProtocol, 2);
      assert.equal(manifest.contract.reviewerResponseProtocol, 3);
      assert.equal(manifest.contract.roleSequence, role.roleSequence);
    }
  }
  assert.deepEqual(header(repo.read(PLAN)), { phase: 'plan', status: 'CONSUMED', next: 'implement', source: SPEC, 'consumed-by': `${DIR}/task-result-index.md` });
  assert.deepEqual(header(repo.read(`${DIR}/task-result-index.md`)), { phase: 'implement', status: 'CONSUMED', next: 'none', source: PLAN, 'consumed-by': `${DIR}/review-report.md` });
  assert.equal(header(repo.read(`${DIR}/review-report.md`)).status, 'READY');
  assert.match(repo.read(`${DIR}/task-result-index.md`), /^Reviewer gate Task 1: \.apex\/work\/tasks\/topic\/task-1-review-guard-attempt-1-iteration-1$/m);
  assert.match(repo.read(`${DIR}/task-result-index.md`), /^Reviewer gate final: \.apex\/work\/tasks\/topic\/final-review-guard-attempt-1-iteration-1$/m);
  assert.match(repo.git('log', '-1', '--format=%s'), /^steepy autopilot: Task 1 execution 1 \(run 0f0e0d0c-0b0a-4908-8706-050403020100 role 2\)$/m);
  assert.equal(repo.git('status', '--porcelain'), '');
  assert.equal(verifyTaskResults(repo.root, { indexPath: `${DIR}/task-result-index.md`, expectedTasks: ['1'] }).entries[0].receipt,
    `${DIR}/task-1-execution-1`);
  assert.match(repo.read(`${DIR}/autopilot-status.md`), /Status: COMPLETED/);
  const again = await control(repo, scriptedRunner(repo).runner);
  assert.equal(again.code, 0, 'a completed run is an idempotent no-op');
});

const sequence = (calls) => calls.map(({ role, task, iteration }) => `${role}${task === null ? '' : `:${task}`}@${iteration}`);
const manifestOf = (repo, roleSequence) => JSON.parse(repo.read(`${DIR}/context/role-${roleSequence}.json`));

test('task issues start the assigned fix and a new review; a format repair uses one reserved correction', async (t) => {
  const repo = repository(t);
  const issues = ({ task }) => {
    repo.put(`${DIR}/task-${task}-review.md`, '# Review\n\nIssues found.\n');
    repo.put(`${DIR}/task-${task}-issues.md`, '# Issues\n\n1. Value must be 2.\n');
    return 'status: ISSUES_FOUND\nsignals: none';
  };
  const reversed = ({ task }) => { repo.put(`${DIR}/task-${task}-review.md`, '# Review\n\nApproved after fix.\n'); return 'signals: none\nstatus: APPROVED'; };
  const { runner, calls } = scriptedRunner(repo, {
    tasks: [taskSection(1), taskSection(2, { complexity: 'mechanical' })],
    script: { 'task-reviewer': [issues, reversed], 'task-review-correction': [() => 'status: APPROVED\nsignals: none'] },
  });
  const result = await control(repo, runner);
  assert.equal(result.code, 0, result.reason);
  assert.deepEqual(sequence(calls), ['plan@1', 'implementer:1@1', 'task-reviewer:1@1', 'fix:1@2', 'task-reviewer:1@2',
    'task-review-correction:1@2', 'implementer:2@1', 'final-review@1', 'review@1']);
  const state = journal(repo);
  const fix = state.roles.find((role) => role.role === 'fix');
  assert.equal(fix.expectedReceiptPath, `${DIR}/task-1-execution-2-result.json`);
  assert.deepEqual(manifestOf(repo, fix.roleSequence).required.map(({ path }) => path),
    [`${DIR}/task-1-brief.md`, `${DIR}/task-1-issues.md`, `${DIR}/task-1-diff.txt`, '.apex/standards/scripts.md']);
  const correction = state.roles.find((role) => role.role === 'task-review-correction');
  const reviewer = state.roles.find((role) => role.roleSequence === correction.correctionOf);
  assert.equal(reviewer.role, 'task-reviewer');
  assert.equal(reviewer.superseded, true);
  assert.equal(correction.expectedReceiptPath, `${DIR}/task-1-review-guard-attempt-1-iteration-2-corrected.json`);
  assert.deepEqual(manifestOf(repo, correction.roleSequence).contract, { reviewerResponseProtocol: 3 });
  assert.match(repo.read(`${DIR}/task-result-index.md`), /^Reviewer gate Task 1: \S+-iteration-2$/m);
  assert.doesNotMatch(repo.read(`${DIR}/task-result-index.md`), /^Reviewer gate Task 2:/m, 'a mechanical task keeps its review waiver');
  const verified = verifyTaskResults(repo.root, { indexPath: `${DIR}/task-result-index.md`, expectedTasks: ['1', '2'] });
  assert.deepEqual(verified.executions.map(({ state: path }) => path),
    [`${DIR}/task-1-execution-1`, `${DIR}/task-1-execution-2`, `${DIR}/task-2-execution-1`]);
  assert.deepEqual(repo.git('log', '--format=%s').trim().split('\n').slice(0, 3).map((subject) => subject.replace(/ \(run .*$/, '')),
    ['steepy autopilot: Task 2 execution 1', 'steepy autopilot: Task 1 execution 2', 'steepy autopilot: Task 1 execution 1']);
});

test('whole-branch issues dispatch the targeted fix, refresh its task approval, and review the branch again', async (t) => {
  const repo = repository(t);
  const finalIssues = () => {
    repo.put(`${DIR}/final-review.md`, '# Final review\n\nIssues found.\n');
    repo.put(`${DIR}/final-review-issues.md`, fixTargets([{ task: '2', issueIds: ['F1'] }]));
    return 'status: ISSUES_FOUND\nsignals: none';
  };
  const { runner, calls } = scriptedRunner(repo, {
    tasks: [taskSection(1), taskSection(2)], script: { 'final-review': [finalIssues] },
  });
  const result = await control(repo, runner);
  assert.equal(result.code, 0, result.reason);
  assert.deepEqual(sequence(calls), ['plan@1', 'implementer:1@1', 'task-reviewer:1@1', 'implementer:2@1', 'task-reviewer:2@1',
    'final-review@1', 'fix:2@2', 'task-reviewer:2@2', 'final-review@2', 'review@1']);
  const state = journal(repo);
  const fix = state.roles.find((role) => role.role === 'fix');
  assert.deepEqual(manifestOf(repo, fix.roleSequence).required.map(({ path }) => path),
    [`${DIR}/task-2-brief.md`, `${DIR}/final-review-issues.md`, `${DIR}/branch-diff.txt`, '.apex/standards/scripts.md']);
  const index = repo.read(`${DIR}/task-result-index.md`);
  assert.match(index, /^Reviewer gate Task 2: \S+-iteration-2$/m);
  assert.match(index, /^Reviewer gate final: \S+final-review-guard-attempt-1-iteration-2$/m);
});

test('an undeclared or unmapped whole-branch finding blocks the fix', async (t) => {
  const repo = repository(t);
  const { runner, calls } = scriptedRunner(repo, {
    script: { 'final-review': [() => {
      repo.put(`${DIR}/final-review.md`, '# Final review\n');
      repo.put(`${DIR}/final-review-issues.md`, fixTargets([{ task: '1', issueIds: ['F9'] }]));
      return 'status: ISSUES_FOUND\nsignals: none';
    }] },
  });
  const result = await control(repo, runner);
  assert.equal(result.code, 1);
  assert.match(result.reason, /final review fix targets rejected: finding F9 is not named/);
  assert.equal(calls.at(-1).role, 'final-review');
  assert.equal(journal(repo).status, 'HALTED');
});

const note = (put, task, kind = 'report') => put(`${DIR}/task-${task}-${kind}.md`, `# ${kind}\n\nNeeds a decision.\n`);
for (const [label, role, step, reason] of [
  ['writer BLOCKED', 'implementer', ({ task, put }) => { note(put, task); return writerPayload(task, 'BLOCKED'); },
    /role 2 implementer Task 1 iteration 1 returned BLOCKED; see \.apex\/work\/tasks\/topic\/task-1-report\.md/],
  ['writer NEEDS_CONTEXT', 'implementer', ({ task, put }) => { note(put, task); return writerPayload(task, 'NEEDS_CONTEXT'); },
    /returned NEEDS_CONTEXT/],
  ['malformed writer payload', 'implementer', ({ task, put }) => { note(put, task); return 'status: DONE\nsignals: none'; },
    /role 2 implementer Task 1 iteration 1 response rejected: invalid task response schema/],
  ['reviewer NEEDS_CONTEXT', 'task-reviewer', ({ task, put }) => { note(put, task, 'review'); return 'status: NEEDS_CONTEXT\nsignals: none'; },
    /role 3 task-reviewer Task 1 iteration 1 returned NEEDS_CONTEXT/],
  ['plan BLOCKED', 'plan', () => 'status: BLOCKED\nsignals: spec:ambiguous', /role 1 plan iteration 1 returned BLOCKED \(signals: spec:ambiguous\)/],
  ['review BLOCKED', 'review', () => 'status: BLOCKED\nsignals: none', /review iteration 1 returned BLOCKED/],
  ['missing terminal response', 'implementer', () => ({ payload: null, reason: 'missing-terminal', exit: { status: 1, signal: null } }),
    /role 2 implementer Task 1 iteration 1: no terminal response \(missing-terminal\); child exited 1/],
  ['runner failure', 'task-reviewer', () => { throw new Error('spawn exploded'); },
    /role 3 task-reviewer Task 1 iteration 1: no terminal response \(runner-error\); child exited without a status; transport error: spawn exploded/],
]) {
  test(`${label} halts with its correlated diagnosis and stays halted on resume`, async (t) => {
    const repo = repository(t);
    const { runner } = scriptedRunner(repo, { script: { [role]: [step] } });
    const result = await control(repo, runner);
    assert.equal(result.code, 1);
    assert.match(result.reason, reason);
    assert.doesNotMatch(result.reason, /completion marker/);
    assert.equal(journal(repo).status, 'HALTED');
    assert.match(repo.read(`${DIR}/autopilot-status.md`), /Status: HALTED/);
    const resumed = scriptedRunner(repo);
    const again = await control(repo, resumed.runner);
    assert.equal(again.code, 1);
    assert.match(again.reason, /controller run halted: /);
    assert.deepEqual(resumed.calls, [], 'a halted run never dispatches again');
  });
}

const crashAt = (point, match = {}) => (at, detail) => {
  if (at === point && Object.entries(match).every(([key, value]) => detail[key] === value)) {
    throw Object.assign(new Error(`simulated crash at ${point}`), { simulated: true });
  }
};
const dropLastEvent = (repo) => {
  const lines = repo.read(`${DIR}/autopilot-events.jsonl`).split('\n').filter(Boolean);
  repo.put(`${DIR}/autopilot-events.jsonl`, `${lines.slice(0, -1).join('\n')}\n`);
  return JSON.parse(lines.at(-1)).event;
};
const subjects = (repo) => repo.git('log', '--format=%s').trim().split('\n');

for (const point of ['response-captured', 'committed', 'task-recorded', 'result-accepted']) {
  test(`a writer interrupted at ${point} resumes from durable evidence without redispatch`, async (t) => {
    const repo = repository(t);
    await assert.rejects(control(repo, scriptedRunner(repo).runner, { crash: crashAt(point, { role: 'implementer' }) }), /simulated crash/);
    const resumed = scriptedRunner(repo);
    const result = await control(repo, resumed.runner);
    assert.equal(result.code, 0, result.reason);
    assert.deepEqual(sequence(resumed.calls), ['task-reviewer:1@1', 'final-review@1', 'review@1']);
    assert.equal(subjects(repo).filter((subject) => subject.startsWith('steepy autopilot: Task 1 execution 1 ')).length, 1,
      'the controller commit is recognized, never repeated');
  });
}

test('a durable task capture without its result finishes publication without redispatch', async (t) => {
  const repo = repository(t);
  await assert.rejects(control(repo, scriptedRunner(repo).runner, { crash: crashAt('task-recorded', { role: 'implementer' }) }), /simulated crash/);
  rmSync(join(repo.root, `${DIR}/task-1-execution-1-result.json`));
  const resumed = scriptedRunner(repo);
  const result = await control(repo, resumed.runner);
  assert.equal(result.code, 0, result.reason);
  assert.equal(resumed.calls[0].role, 'task-reviewer');
});

test('a response file whose capture event was lost is captured on resume without redispatch', async (t) => {
  const repo = repository(t);
  await assert.rejects(control(repo, scriptedRunner(repo).runner, { crash: crashAt('response-captured', { role: 'implementer' }) }), /simulated crash/);
  assert.equal(dropLastEvent(repo), 'RESPONSE_CAPTURED');
  const resumed = scriptedRunner(repo);
  const result = await control(repo, resumed.runner);
  assert.equal(result.code, 0, result.reason);
  assert.equal(resumed.calls[0].role, 'task-reviewer');
});

test('a checked review resumes to acceptance without another reviewer dispatch', async (t) => {
  const repo = repository(t);
  await assert.rejects(control(repo, scriptedRunner(repo).runner, { crash: crashAt('review-checked', { role: 'task-reviewer' }) }), /simulated crash/);
  const resumed = scriptedRunner(repo);
  const result = await control(repo, resumed.runner);
  assert.equal(result.code, 0, result.reason);
  assert.deepEqual(sequence(resumed.calls), ['final-review@1', 'review@1']);
});

for (const point of ['role-reserved', 'manifest-published', 'runner-returned']) {
  test(`a reservation interrupted at ${point} has no outcome and halts instead of dispatching again`, async (t) => {
    const repo = repository(t);
    await assert.rejects(control(repo, scriptedRunner(repo).runner, { crash: crashAt(point, { role: 'implementer' }) }), /simulated crash/);
    const resumed = scriptedRunner(repo);
    const result = await control(repo, resumed.runner);
    assert.equal(result.code, 1);
    assert.match(result.reason, /role 2 implementer Task 1 iteration 1 was reserved without a captured response; refusing to dispatch it again/);
    assert.deepEqual(resumed.calls, []);
    const events = repo.read(`${DIR}/autopilot-events.jsonl`).trim().split('\n').map((line) => JSON.parse(line).event);
    assert.deepEqual(events.slice(-2), ['RECONCILIATION_REQUIRED', 'RUN_HALTED']);
  });
}

test('an orphan reservation is adopted as a spent identity and halts', async (t) => {
  const repo = repository(t);
  await assert.rejects(control(repo, scriptedRunner(repo).runner, { crash: crashAt('role-reserved', { role: 'implementer' }) }), /simulated crash/);
  assert.equal(dropLastEvent(repo), 'ROLE_RESERVED');
  const resumed = scriptedRunner(repo);
  const result = await control(repo, resumed.runner);
  assert.equal(result.code, 1);
  assert.match(result.reason, /role 2 implementer .* was reserved without a captured response/);
  assert.deepEqual(resumed.calls, []);
});

for (const failing of [false, true]) {
  test(`a journal changed while a child ${failing ? 'fails' : 'succeeds'} is refused without repair`, async (t) => {
    const repo = repository(t);
    const forged = { implementer: [({ task, defaults, ...context }) => {
      const events = `${DIR}/autopilot-events.jsonl`;
      repo.put(events, repo.read(events).replace('"PHASE_RESERVED"', '"PHASE_RESERVED" '));
      if (failing) throw new Error('child crashed after editing the journal');
      return defaults.implementer({ task, ...context });
    }] };
    const { runner } = scriptedRunner(repo, { script: forged });
    await assert.rejects(control(repo, runner), /journal or run identity changed while role 2 implementer was in flight; refusing to repair it/);
    assert.match(repo.read(`${DIR}/autopilot-events.jsonl`), /"PHASE_RESERVED" /, 'the controller does not rewrite the journal');
    assert.equal(existsSync(join(repo.root, `${DIR}/role-2-response.json`)), false);
  });
}

test('runController re-renders a child-rewritten projection and regenerates a forged one when it starts', async (t) => {
  const repo = repository(t);
  const { runner } = scriptedRunner(repo, { script: { implementer: [({ defaults, ...context }) => {
    repo.put(`${DIR}/autopilot-status.md`, '# Autopilot status\n\nStatus: COMPLETED\n');
    return defaults.implementer(context);
  }] } });
  assert.equal((await control(repo, runner)).code, 0);
  repo.put(`${DIR}/autopilot-status.md`, 'forged\n');
  assert.equal((await control(repo, scriptedRunner(repo).runner)).code, 0);
  assert.match(repo.read(`${DIR}/autopilot-status.md`), /^# Autopilot status\n\nRun: 0f0e0d0c-0b0a-4908-8706-050403020100\nStatus: COMPLETED\n/);
});

test('a brief that drifted from the plan halts before the fix is dispatched', async (t) => {
  const repo = repository(t);
  const { runner, calls } = scriptedRunner(repo, { script: { 'task-reviewer': [({ task, put }) => {
    put(`${DIR}/task-1-brief.md`, `${repo.read(`${DIR}/task-1-brief.md`)}Also delete the tests.\n`);
    put(`${DIR}/task-${task}-review.md`, '# Review\n');
    put(`${DIR}/task-${task}-issues.md`, '# Issues\n\n1. Wrong value.\n');
    return 'status: ISSUES_FOUND\nsignals: none';
  }] } });
  const result = await control(repo, runner);
  assert.equal(result.code, 1);
  assert.match(result.reason, /Task 1 brief: Task 1 brief drift: .*task-1-brief\.md differs from the validated plan materialization/);
  assert.equal(calls.some(({ role }) => role === 'fix'), false);
});

for (const [label, plan, reason] of [
  ['a local-area exact path', () => planText([taskSection(1, { path: `${DIR}/notes.md` })]), /plan rejected: Task 1 Exact paths must not enter repository-local area \.apex\/work/],
  ['a whole-file spec mention', () => planText([taskSection(1).replace('Set value 1', `Follow ${SPEC}. Set value 1`)]), /plan rejected: Task 1 spec section needs an exact path and heading capability/],
  ['a missing DRAFT lifecycle', () => planText().replace('status: DRAFT', 'status: READY'), /plan rejected: the assigned plan must carry a DRAFT plan lifecycle header/],
]) {
  test(`the plan gate refuses ${label} at plan acceptance`, async (t) => {
    const repo = repository(t);
    const { runner, calls } = scriptedRunner(repo, { script: { plan: [() => { repo.put(PLAN, plan()); return 'status: DONE\nsignals: none'; }] } });
    const result = await control(repo, runner);
    assert.equal(result.code, 1);
    assert.match(result.reason, reason);
    assert.deepEqual(calls.map(({ role }) => role), ['plan']);
    assert.equal(journal(repo).roles[0].accepted, false);
  });
}

test('a published plan whose body changed after acceptance halts as publication drift', async (t) => {
  const repo = repository(t);
  await assert.rejects(control(repo, scriptedRunner(repo).runner, { crash: crashAt('plan-published') }), /simulated crash/);
  assert.equal(header(repo.read(PLAN)).status, 'READY');
  repo.put(PLAN, repo.read(PLAN).replace('Set value 1', 'Set value 9'));
  const result = await control(repo, scriptedRunner(repo).runner);
  assert.equal(result.code, 1);
  assert.match(result.reason, /plan publication drift/);
});

for (const [label, role, step, reason] of [
  ['the plan role edits source', 'plan', ({ put, defaults }) => { put('src/value-1.mjs', 'export const value = 7;\n'); return defaults.plan(); },
    /role 1 plan iteration 1 changed repository source: the plan role is read-only on source/],
  ['a task reviewer edits source', 'task-reviewer', ({ task, put }) => {
    put('src/value-1.mjs', 'export const value = 7;\n');
    put(`${DIR}/task-${task}-review.md`, '# Review\n');
    return 'status: APPROVED\nsignals: none';
  }, /role 3 task-reviewer Task 1 iteration 1 blocked by the reviewer gate: cannot safely observe review repository or artifacts/],
  ['a writer moves the checkout', 'implementer', ({ defaults, ...context }) => {
    const payload = defaults.implementer(context);
    context.git('checkout', '-q', '-b', 'elsewhere');
    return payload;
  }, /role 2 implementer Task 1 iteration 1: checkout moved to "elsewhere" outside the run branch "gear3-topic"/],
]) {
  test(`${label} halts the run`, async (t) => {
    const repo = repository(t);
    const { runner } = scriptedRunner(repo, { script: { [role]: [step] } });
    const result = await control(repo, runner);
    assert.equal(result.code, 1);
    assert.match(result.reason, reason);
  });
}

test('after a durable writer capture the controller never commits again; later edits are drift', async (t) => {
  const repo = repository(t);
  const reportOnly = ({ task, put }) => {
    put(`${DIR}/task-${task}-report.md`, '# Report\n\nNo source change was needed.\n');
    return writerPayload(task, 'DONE_WITH_CONCERNS', 'review:none-needed');
  };
  const first = scriptedRunner(repo, { script: { implementer: [reportOnly] } });
  await assert.rejects(control(repo, first.runner, { crash: crashAt('task-recorded', { role: 'implementer' }) }), /simulated crash/);
  rmSync(join(repo.root, `${DIR}/task-1-execution-1-result.json`));
  repo.put('src/human.mjs', 'export const edited = true;\n');
  const before = subjects(repo);
  const resumed = scriptedRunner(repo);
  const result = await control(repo, resumed.runner);
  assert.equal(result.code, 1);
  assert.match(result.reason, /role 2 implementer Task 1 iteration 1: interrupted task capture replay mismatch/);
  assert.deepEqual(subjects(repo), before, 'no controller commit after the durable capture');
  assert.deepEqual(resumed.calls, []);
});

test('a fenced final verdict is repaired by one reserved final-review correction', async (t) => {
  const repo = repository(t);
  const fenced = () => { repo.put(`${DIR}/final-review.md`, '# Final review\n'); return '```text\nstatus: APPROVED\nsignals: none\n```\n'; };
  const { runner, calls } = scriptedRunner(repo, { script: {
    'final-review': [fenced], 'final-review-correction': [() => 'status: APPROVED\nsignals: none'],
  } });
  const result = await control(repo, runner);
  assert.equal(result.code, 0, result.reason);
  assert.deepEqual(sequence(calls).slice(-3), ['final-review@1', 'final-review-correction@1', 'review@1']);
  const correction = journal(repo).roles.find((role) => role.role === 'final-review-correction');
  assert.equal(correction.expectedReceiptPath, `${DIR}/final-review-guard-attempt-1-iteration-1-corrected.json`);
});

test('a resumed run refuses a different selected engine without writing', async (t) => {
  const repo = repository(t);
  await assert.rejects(control(repo, scriptedRunner(repo).runner, { crash: crashAt('phase-accepted', { phase: 'plan' }) }), /simulated crash/);
  const engine = mkdtempSync(join(tmpdir(), 'steepy-controller-engine-'));
  t.after(() => rmSync(engine, { recursive: true, force: true }));
  for (const area of ['scripts', 'adapters', 'skills']) cpSync(join(here, '..', area), join(engine, area), { recursive: true });
  for (const file of ['package.json', 'cordis.patch.yml']) cpSync(join(here, '..', file), join(engine, file));
  for (const dir of ['.claude-plugin', '.codex-plugin']) cpSync(join(here, '..', dir), join(engine, dir), { recursive: true });
  writeFileSync(join(engine, 'scripts', 'task-results.mjs'), `${readFileSync(join(engine, 'scripts', 'task-results.mjs'), 'utf8')}// changed\n`);
  const events = repo.read(`${DIR}/autopilot-events.jsonl`);
  const resumed = scriptedRunner(repo);
  await assert.rejects(runController({ repoRoot: repo.root, specName: 'topic', contract, runId: RUN_ID, engineRoot: engine,
    services: { runner: resumed.runner } }), /selected runtime fingerprint mismatch/);
  assert.equal(repo.read(`${DIR}/autopilot-events.jsonl`), events);
  assert.deepEqual(resumed.calls, []);
});

const headeredSpec = (status = 'READY', consumedBy = 'none', phase = 'brainstorm') => specText.replace('-->\n\n# Topic spec',
  `-->\n<!-- steepy-workflow: v1\nphase: ${phase}\nstatus: ${status}\nnext: plan\nsource: none\nconsumed-by: ${consumedBy}\n-->\n\n# Topic spec`);

test('a headered brainstorm spec is consumed by the published plan and later runs are no-ops', async (t) => {
  const repo = repository(t);
  repo.put(SPEC, headeredSpec());
  const result = await control(repo, scriptedRunner(repo).runner);
  assert.equal(result.code, 0, result.reason);
  assert.deepEqual(header(repo.read(SPEC)), { phase: 'brainstorm', status: 'CONSUMED', next: 'plan', source: 'none', 'consumed-by': PLAN });
  assert.match(repo.read(SPEC), /^<!-- verdict: GAP \| gear: 3\n/, 'the verdict contract stays at the head');
  assert.match(repo.read(`${DIR}/success-criteria.md`), /SC1 — The value is updated\./);
  const spec = repo.read(SPEC);
  const again = scriptedRunner(repo);
  assert.equal((await control(repo, again.runner)).code, 0);
  assert.equal(repo.read(SPEC), spec);
  assert.deepEqual(again.calls, []);
});

for (const [label, spec] of [
  ['consumed by another plan', () => headeredSpec('CONSUMED', '.apex/work/plans/other.md')],
  ['still a DRAFT', () => headeredSpec('DRAFT')],
  ['not a brainstorm output', () => headeredSpec('READY', 'none', 'plan')],
]) {
  test(`a spec ${label} is refused before the plan role is dispatched`, async (t) => {
    const repo = repository(t);
    repo.put(SPEC, spec());
    const { runner, calls } = scriptedRunner(repo);
    const result = await control(repo, runner);
    assert.deepEqual([result.code, result.halted], [1, false], 'a refusal before any effect is not a recorded halt');
    assert.match(result.reason, /spec lifecycle is not a READY brainstorm input for \.apex\/work\/plans\/topic\.md/);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(join(repo.root, `${DIR}/autopilot-run.json`)), false, 'a refused spec creates no run identity');
    repo.put(SPEC, headeredSpec());
    assert.equal((await control(repo, scriptedRunner(repo).runner)).code, 0, 'the corrected spec then runs');
  });
}

// A child that writes the controller's capture path, then fails its transport.
const forgeCapture = (repo) => ({ task, defaults, ...context }) => {
  defaults.implementer({ task, defaults, ...context });
  const record = { schemaVersion: 1, roleSequence: 2, role: 'implementer', payload: writerPayload(task),
    terminalReason: null, sessionId: null, exit: { status: 0, signal: null }, transportError: null,
    capturePersisted: true, observedModel: null };
  repo.put(`${DIR}/role-2-response.json`, `${JSON.stringify(record)}\n`);
  return { payload: null, reason: 'missing-terminal', exit: { status: 1, signal: null }, capturePersisted: false };
};
const eventNames = (repo) => repo.read(`${DIR}/autopilot-events.jsonl`).trim().split('\n').map((line) => JSON.parse(line).event);

test('a child-authored capture file during dispatch halts as forged controller state with the real diagnosis', async (t) => {
  const repo = repository(t);
  const result = await control(repo, scriptedRunner(repo, { script: { implementer: [forgeCapture(repo)] } }).runner);
  assert.equal(result.code, 1);
  assert.match(result.reason, /role 2 implementer Task 1 iteration 1: the child wrote controller capture \.apex\/work\/tasks\/topic\/role-2-response\.json; no terminal response \(missing-terminal\); child exited 1; raw capture was not persisted/);
  assert.deepEqual(eventNames(repo).slice(-2), ['RECONCILIATION_REQUIRED', 'RUN_HALTED']);
  const role = journal(repo).roles[1];
  assert.deepEqual([role.responseCaptured, role.accepted], [false, false]);
  const resumed = scriptedRunner(repo);
  const again = await control(repo, resumed.runner);
  assert.equal(again.code, 1);
  assert.match(again.reason, /controller run halted: /);
  assert.deepEqual(resumed.calls, []);
});

test('resume never adopts a foreign response file beside an uncaptured reservation', async (t) => {
  const repo = repository(t);
  await assert.rejects(control(repo, scriptedRunner(repo, { script: { implementer: [forgeCapture(repo)] } }).runner,
    { crash: crashAt('runner-returned', { role: 'implementer' }) }), /simulated crash/);
  const resumed = scriptedRunner(repo);
  const result = await control(repo, resumed.runner);
  assert.equal(result.code, 1);
  assert.match(result.reason, /role 2 implementer Task 1 iteration 1 was reserved without a captured response; refusing to adopt an uncorroborated response file or dispatch it again/);
  assert.deepEqual(resumed.calls, []);
  assert.deepEqual(eventNames(repo).slice(-2), ['RECONCILIATION_REQUIRED', 'RUN_HALTED']);
  assert.equal(journal(repo).roles[1].accepted, false);
});

for (const [complexity, reviewer, final] of [['design', 'most-capable', 'most-capable'], ['integration', 'standard', 'standard']]) {
  test(`reviewer tiers for ${complexity} work: task reviewer ${reviewer}, final review ${final}, corrections standard`, async (t) => {
    const repo = repository(t);
    const reversed = ({ task, put }) => { put(`${DIR}/task-${task}-review.md`, '# Review\n'); return 'signals: none\nstatus: APPROVED'; };
    const { runner, calls } = scriptedRunner(repo, {
      tasks: [taskSection(1, { complexity })],
      script: { 'task-reviewer': [reversed], 'task-review-correction': [() => 'status: APPROVED\nsignals: none'] },
    });
    assert.equal((await control(repo, runner)).code, 0);
    const tiers = Object.fromEntries(calls.map(({ role, modelTier }) => [role, modelTier]));
    assert.deepEqual([tiers['task-reviewer'], tiers['final-review'], tiers['task-review-correction']], [reviewer, final, 'standard']);
    for (const role of journal(repo).roles) {
      assert.equal(manifestOf(repo, role.roleSequence).modelTier, tiers[role.role], role.role);
    }
  });
}

for (const [label, evidence, reason] of [
  ['a narrower surface test command', () => evidenceReport({ command: 'npm test -- tests/one.test.mjs' }),
    /surface-test command .* is not the plan's exact surface test command/],
  ['a failing surface test claimed as passing', () => evidenceReport({ surfaceExit: 1, passed: true }), /surface-test exited 1/],
  ['a failing coherence gate claimed as passing', () => evidenceReport({ hubExit: 1, passed: true }), /validate-hub exited 1/],
  ['stale evidence from before the review role', () => evidenceReport({ started: '2020-01-01T00:00:00.000Z' }),
    /evidence predates the review role reservation/],
  ['a truncated command section', () => evidenceReport().replace(/Output SHA-256: [0-9a-f]+\n/, 'Output SHA-256: 0\n'),
    /evidence report is not one complete surface-test and validate-hub collection/],
]) {
  test(`the review evidence gate refuses ${label}`, async (t) => {
    const repo = repository(t);
    const { runner } = scriptedRunner(repo, { script: { review: [({ put, defaults }) => {
      const payload = defaults.review();
      put(`${DIR}/evidence-report.md`, evidence());
      return payload;
    }] } });
    const result = await control(repo, runner);
    assert.equal(result.code, 1);
    assert.match(result.reason, /review evidence rejected: /);
    assert.match(result.reason, reason);
    assert.equal(journal(repo).roles.at(-1).accepted, false);
  });
}

test('spec metadata errors are refused before any run identity is created', async (t) => {
  const repo = repository(t);
  repo.put(SPEC, specText.replace('- **Owning surface:** `scripts`\n', ''));
  const result = await control(repo, scriptedRunner(repo).runner);
  assert.deepEqual([result.code, result.halted], [1, false]);
  assert.match(result.reason, /plan context: spec is missing Owning surface metadata/);
  assert.equal(existsSync(join(repo.root, `${DIR}/autopilot-run.json`)), false);
});

test('a descriptor failure before the reservation is a refusal that leaves the run resumable', async (t) => {
  const repo = repository(t);
  const first = scriptedRunner(repo);
  const prepare = first.runner.prepare;
  first.runner.prepare = (request) => {
    if (request.role === 'implementer') throw new Error('model mapping unavailable');
    return prepare(request);
  };
  const refused = await control(repo, first.runner);
  assert.deepEqual([refused.code, refused.halted], [1, false]);
  assert.match(refused.reason, /role 2 implementer descriptor: model mapping unavailable/);
  assert.equal(journal(repo).status, 'RUNNING');
  assert.equal(journal(repo).roles.length, 1, 'no role was reserved for the refused dispatch');
  const resumed = scriptedRunner(repo);
  const result = await control(repo, resumed.runner);
  assert.equal(result.code, 0, result.reason);
  assert.equal(resumed.calls[0].role, 'implementer', 'the accepted plan is not redispatched');
});

test('post-effect gate halts stay terminal and say so', async (t) => {
  const repo = repository(t);
  const { runner } = scriptedRunner(repo, { script: { implementer: [({ task, put }) => {
    put(`${DIR}/task-${task}-report.md`, '# Report\n');
    return writerPayload(task, 'BLOCKED');
  }] } });
  const result = await control(repo, runner);
  assert.deepEqual([result.code, result.halted], [1, true]);
});

const stripHeader = (text) => text.replace(/<!-- steepy-workflow: v1\n[\s\S]*?\n-->\n/, '');
for (const [label, point, match, path, reason] of [
  ['plan', 'plan-published', {}, PLAN, /plan publication drift: lifecycle header missing/],
  ['review report', 'result-accepted', { role: 'review' }, `${DIR}/review-report.md`, /review report publication drift: lifecycle header missing/],
]) {
  test(`a ${label} that lost its lifecycle header after acceptance halts as named publication drift`, async (t) => {
    const repo = repository(t);
    await assert.rejects(control(repo, scriptedRunner(repo).runner, { crash: crashAt(point, match) }), /simulated crash/);
    repo.put(path, stripHeader(repo.read(path)));
    const result = await control(repo, scriptedRunner(repo).runner);
    assert.deepEqual([result.code, result.halted], [1, true]);
    assert.match(result.reason, reason);
    assert.equal(journal(repo).status, 'HALTED');
  });
}

const finalIssuesFor = (repo, task) => () => {
  repo.put(`${DIR}/final-review.md`, '# Final review\n\nIssues found.\n');
  repo.put(`${DIR}/final-review-issues.md`, fixTargets([{ task, issueIds: ['F1'] }]));
  return 'status: ISSUES_FOUND\nsignals: none';
};
const reversedApproval = ({ task, put }) => { put(`${DIR}/task-${task}-review.md`, '# Review\n'); return 'signals: none\nstatus: APPROVED'; };
for (const [flow, options, point, match, remaining] of [
  ['whole-branch', (repo) => ({ tasks: [taskSection(1), taskSection(2)], script: { 'final-review': [finalIssuesFor(repo, '2')] } }),
    'result-accepted', { role: 'final-review' }, ['fix:2@2', 'task-reviewer:2@2', 'final-review@2', 'review@1']],
  ['whole-branch', (repo) => ({ tasks: [taskSection(1), taskSection(2)], script: { 'final-review': [finalIssuesFor(repo, '2')] } }),
    'result-accepted', { role: 'fix' }, ['task-reviewer:2@2', 'final-review@2', 'review@1']],
  ['whole-branch', (repo) => ({ tasks: [taskSection(1), taskSection(2)], script: { 'final-review': [finalIssuesFor(repo, '2')] } }),
    'review-checked', { roleSequence: 8 }, ['final-review@2', 'review@1']],
  ['correction', () => ({ script: { 'task-reviewer': [reversedApproval], 'task-review-correction': [() => 'status: APPROVED\nsignals: none'] } }),
    'review-checked', { role: 'task-reviewer' }, ['task-review-correction:1@1', 'final-review@1', 'review@1']],
  ['correction', () => ({ script: { 'task-reviewer': [reversedApproval], 'task-review-correction': [() => 'status: APPROVED\nsignals: none'] } }),
    'response-captured', { role: 'task-review-correction' }, ['final-review@1', 'review@1']],
  ['correction', () => ({ script: { 'task-reviewer': [reversedApproval], 'task-review-correction': [() => 'status: APPROVED\nsignals: none'] } }),
    'review-checked', { role: 'task-review-correction' }, ['final-review@1', 'review@1']],
  ['review-phase', () => ({}), 'response-captured', { role: 'review' }, []],
  ['review-phase', () => ({}), 'result-accepted', { role: 'review' }, []],
  ['review-phase', () => ({}), 'review-published', {}, []],
]) {
  test(`the ${flow} flow interrupted at ${point} ${JSON.stringify(match)} resumes without redispatching completed roles`, async (t) => {
    const repo = repository(t);
    await assert.rejects(control(repo, scriptedRunner(repo, options(repo)).runner, { crash: crashAt(point, match) }), /simulated crash/);
    const resumed = scriptedRunner(repo, { tasks: options(repo).tasks });
    const result = await control(repo, resumed.runner);
    assert.equal(result.code, 0, result.reason);
    assert.deepEqual(sequence(resumed.calls), remaining);
    assert.equal(journal(repo).status, 'COMPLETED');
  });
}

for (const command of ['node --test tests/*.test.mjs', 'FOO_BAR=1 npm test']) {
  test(`review roles carry the exact plan test command ${command} and its fresh evidence is accepted`, async (t) => {
    const repo = repository(t);
    const seen = {};
    const capture = (role) => ({ manifest, defaults, ...context }) => {
      seen[role] = { testCommand: manifest.testCommand, criterionIds: manifest.criterionIds };
      return defaults[role]({ manifest, defaults, ...context });
    };
    const { runner } = scriptedRunner(repo, {
      tasks: [taskSection(1).replace('`npm test`', `\`${command}\``)],
      script: {
        'task-reviewer': [capture('task-reviewer')],
        'final-review': [capture('final-review')],
        review: [({ manifest, put, defaults }) => {
          seen.review = { testCommand: manifest.testCommand, criterionIds: manifest.criterionIds };
          const payload = defaults.review();
          put(`${DIR}/evidence-report.md`, evidenceReport({ command: manifest.testCommand }));
          return payload;
        }],
      },
    });
    const result = await control(repo, runner);
    assert.deepEqual([result.code, result.reason], [0, 'READY_FOR_PR']);
    for (const role of ['task-reviewer', 'final-review', 'review']) {
      assert.deepEqual(seen[role], { testCommand: command, criterionIds: ['SC1'] }, role);
    }
    assert.ok(repo.read(`${DIR}/task-1-brief.md`).includes(`- **Test command:** \`${command}\``));
  });
}

test('a genuinely failing evidence collection is refused with its specific exit diagnosis', async (t) => {
  const repo = repository(t);
  const { runner } = scriptedRunner(repo, { script: { review: [({ put, defaults }) => {
    const payload = defaults.review();
    put(`${DIR}/evidence-report.md`, evidenceReport({ surfaceExit: 1 }));
    return payload;
  }] } });
  const result = await control(repo, runner);
  assert.deepEqual([result.code, result.halted], [1, true]);
  assert.match(result.reason, /review evidence rejected: surface-test exited 1 \(signal none, spawn error none\)/);
});

test('a recovery input never converts a run: a fresh run refuses it unless explicitly started, an existing run refuses the start', async (t) => {
  const repo = repository(t);
  repo.put(`${DIR}/recovery-input.json`, '{}\n');
  const stray = scriptedRunner(repo);
  const refused = await control(repo, stray.runner);
  assert.deepEqual([refused.code, refused.halted], [1, false]);
  assert.match(refused.reason, /a recovery input exists at \.apex\/work\/tasks\/topic\/recovery-input\.json; start it explicitly with --recovery-input/);
  assert.equal(existsSync(join(repo.root, `${DIR}/autopilot-run.json`)), false);
  const malformed = await runController({ repoRoot: repo.root, specName: 'topic', contract, runId: RUN_ID, recoveryInput: `${DIR}/recovery-input.json`,
    services: { runner: stray.runner, log: () => {} } });
  assert.deepEqual([malformed.code, malformed.halted], [1, false]);
  assert.match(malformed.reason, /^recovery input: recovery input fields must be closed/);
  assert.equal(existsSync(join(repo.root, `${DIR}/autopilot-run.json`)), false, 'a refused recovery creates no run identity');
  assert.deepEqual(stray.calls, []);

  rmSync(join(repo.root, `${DIR}/recovery-input.json`));
  await assert.rejects(control(repo, scriptedRunner(repo).runner, { crash: crashAt('phase-accepted', { phase: 'plan' }) }), /simulated crash/);
  const events = repo.read(`${DIR}/autopilot-events.jsonl`);
  const started = await runController({ repoRoot: repo.root, specName: 'topic', contract, runId: RUN_ID, recoveryInput: `${DIR}/recovery-input.json`,
    services: { runner: scriptedRunner(repo).runner, log: () => {} } });
  assert.deepEqual([started.code, started.halted], [1, false]);
  assert.match(started.reason, /--recovery-input starts a new recovery run; the existing run resumes from its journal without it/);
  assert.equal(repo.read(`${DIR}/autopilot-events.jsonl`), events);
  repo.put(`${DIR}/recovery-input.json`, '{}\n');
  const converted = await control(repo, scriptedRunner(repo).runner);
  assert.deepEqual([converted.code, converted.halted], [1, false], 'a stray input beside a plan-phase run is refused, never a conversion');
  assert.match(converted.reason, /a recovery input beside a run that did not start from it is refused/);
  assert.equal(repo.read(`${DIR}/autopilot-events.jsonl`), events);
  rmSync(join(repo.root, `${DIR}/recovery-input.json`));
  assert.equal((await control(repo, scriptedRunner(repo).runner)).code, 0, 'without the stray input the run resumes normally');
});

for (const [label, stray] of [['malformed', '{}\n'], ['valid-looking', `${JSON.stringify({ schemaVersion: 1, source: {}, reuse: ['1'], current: {}, destination: {} })}\n`]]) {
  test(`a ${label} stray recovery input beside a run crashed at creation is refused without any journal effect`, async (t) => {
    const repo = repository(t);
    await assert.rejects(control(repo, scriptedRunner(repo).runner, { crash: crashAt('run-created') }), /simulated crash/);
    const events = repo.read(`${DIR}/autopilot-events.jsonl`);
    repo.put(`${DIR}/recovery-input.json`, stray);
    const resumed = scriptedRunner(repo);
    const refused = await control(repo, resumed.runner);
    assert.deepEqual([refused.code, refused.halted], [1, false]);
    assert.match(refused.reason, /a recovery input beside a run that did not start from it is refused/);
    assert.equal(repo.read(`${DIR}/autopilot-events.jsonl`), events, 'no RECONCILIATION_REQUIRED or RUN_HALTED');
    assert.deepEqual(resumed.calls, []);
    rmSync(join(repo.root, `${DIR}/recovery-input.json`));
    const result = await control(repo, scriptedRunner(repo).runner);
    assert.equal(result.code, 0, result.reason);
    assert.equal(journal(repo).status, 'COMPLETED');
  });
}

// A refusal from a post-effect acceptance is a recorded terminal halt, never a
// raw error: the review was checked, then its evidence drifted before acceptance.
const lastEvents = (repo, count) => repo.read(`${DIR}/autopilot-events.jsonl`).trim().split('\n').slice(-count).map((line) => JSON.parse(line));
for (const [role, phase] of [['task-reviewer', 'review'], ['final-review', 'final-review']]) {
  test(`a ${role} acceptance refused after its checked review halts terminally and stays halted`, async (t) => {
    const repo = repository(t);
    let fired = 0;
    const drift = (at, detail) => {
      if (at === 'review-checked' && detail.role === role && fired++ === 0) repo.put('src/value-2.mjs', 'export const value = 9;\n');
    };
    const { runner, calls } = scriptedRunner(repo);
    const result = await control(repo, runner, { crash: drift });
    assert.equal(fired, 1);
    assert.deepEqual([result.code, result.halted], [1, true]);
    assert.match(result.reason, new RegExp(`^role \\d+ ${role}(?: Task 1)? iteration 1 acceptance: reviewer receipt does not bind an accepted verdict for this invocation$`));
    const [reconciliation, halted] = lastEvents(repo, 2);
    assert.deepEqual([reconciliation.event, reconciliation.scope.phase, halted.event, halted.reason], ['RECONCILIATION_REQUIRED', phase, 'RUN_HALTED', result.reason]);
    assert.match(repo.read(`${DIR}/autopilot-status.md`), /Status: HALTED/);
    const journalBytes = repo.read(`${DIR}/autopilot-events.jsonl`);
    const dispatched = calls.length;
    const again = await control(repo, runner);
    assert.deepEqual([again.code, again.halted, again.reason], [1, true, `controller run halted: ${result.reason}`]);
    assert.equal(calls.length, dispatched, 'a halted run never dispatches again');
    assert.equal(repo.read(`${DIR}/autopilot-events.jsonl`), journalBytes);
  });
}

test('a review acceptance refused after its evidence gate halts terminally', async (t) => {
  const repo = repository(t);
  const { runner, calls } = scriptedRunner(repo);
  const reviewEvidenceGate = ({ root, reportPath }) => writeFileSync(join(root, reportPath), `${readFileSync(join(root, reportPath), 'utf8')}Edited after the gate read it.\n`);
  const result = await control(repo, runner, { reviewEvidenceGate });
  assert.deepEqual([result.code, result.halted], [1, true]);
  assert.match(result.reason, /^role \d+ review iteration 1 acceptance: autopilot state: artifact digest mismatch: \.apex\/work\/tasks\/topic\/review-report\.md$/);
  assert.deepEqual(lastEvents(repo, 2).map(({ event }) => event), ['RECONCILIATION_REQUIRED', 'RUN_HALTED']);
  const dispatched = calls.length;
  const again = await control(repo, runner, { reviewEvidenceGate });
  assert.deepEqual([again.code, again.halted, again.reason], [1, true, `controller run halted: ${result.reason}`]);
  assert.equal(calls.length, dispatched);
});

test('a task review reference refused after the review was accepted halts terminally', async (t) => {
  const repo = repository(t);
  const index = `${DIR}/task-result-index.md`;
  let fired = 0;
  const stale = (at, detail) => {
    if (at === 'result-accepted' && detail.role === 'task-reviewer' && fired++ === 0) {
      repo.put(index, `${repo.read(index)}Reviewer gate Task 1: ${DIR}/task-1-review-guard-attempt-1-iteration-9\n`);
    }
  };
  const { runner, calls } = scriptedRunner(repo);
  const result = await control(repo, runner, { crash: stale });
  assert.deepEqual([result.code, result.halted], [1, true]);
  assert.match(result.reason, /^role 3 task-reviewer Task 1 iteration 1 acceptance: review reference must advance to a newer iteration$/);
  const [reconciliation, halted] = lastEvents(repo, 2);
  assert.deepEqual([reconciliation.event, reconciliation.scope.phase, halted.event], ['RECONCILIATION_REQUIRED', 'review', 'RUN_HALTED']);
  const dispatched = calls.length;
  const again = await control(repo, runner);
  assert.deepEqual([again.code, again.halted, again.reason], [1, true, `controller run halted: ${result.reason}`]);
  assert.equal(calls.length, dispatched);
});

// The pure branch and recovery-binding checks read only the immutable run
// identity, so their refusals precede any start reconciliation.
for (const [label, disturb, reason] of [
  ['a stray recovery input', (repo) => repo.put(`${DIR}/recovery-input.json`, '{}\n'), /^a recovery input beside a run that did not start from it is refused/],
  ['a wrong checkout branch', (repo) => repo.git('checkout', '-q', '-b', 'elsewhere'),
    /^controller run belongs to branch "gear3-topic"; refusing to drive it from "elsewhere"$/],
]) {
  test(`${label} beside an orphan reservation is refused before start reconciliation journals anything`, async (t) => {
    const repo = repository(t);
    await assert.rejects(control(repo, scriptedRunner(repo).runner, { crash: crashAt('role-reserved', { role: 'implementer' }) }), /simulated crash/);
    assert.equal(dropLastEvent(repo), 'ROLE_RESERVED');
    disturb(repo);
    const events = repo.read(`${DIR}/autopilot-events.jsonl`);
    const resumed = scriptedRunner(repo);
    const refused = await control(repo, resumed.runner);
    assert.deepEqual([refused.code, refused.halted], [1, false]);
    assert.match(refused.reason, reason);
    assert.equal(repo.read(`${DIR}/autopilot-events.jsonl`), events, 'the orphan reservation is not adopted');
    assert.deepEqual(resumed.calls, []);
  });
}

// ---- Role response shape ---------------------------------------------------
// Each role prompt states its exact final message. The expected text is written
// out here, from each decoder's own grammar, so the lock compares the prompt
// with the decoders rather than with the controller's prompt builder.
const SHAPE_MARKER = 'Example (shape only, not your verdict):';
const SIGNALS_RULE = '`signals` is `none` alone or distinct machine IDs separated by a comma and a space; '
  + 'each ID starts with a letter or digit and uses only letters, digits, and `:._-`; never prose.';
const NO_EXTRA = 'No JSON, no Markdown fence, no extra text before or after; put all prose in the assigned artifacts.';
const REVIEWER_SHAPE = {
  lines: 2, fields: '`status`, `signals`', statuses: '`APPROVED`, `ISSUES_FOUND`, `BLOCKED`, `NEEDS_CONTEXT`',
  example: 'status: APPROVED\nsignals: none',
};
const expectedShape = (role, task) => {
  const shape = {
    plan: { lines: 2, fields: '`status`, `signals`', statuses: '`DONE`, `BLOCKED`, `NEEDS_CONTEXT`', example: 'status: DONE\nsignals: none' },
    review: { lines: 2, fields: '`status`, `signals`', statuses: '`READY_FOR_PR`, `BLOCKED`, `NEEDS_CONTEXT`', example: 'status: READY_FOR_PR\nsignals: none' },
    'task-reviewer': REVIEWER_SHAPE, 'final-review': REVIEWER_SHAPE,
    'task-review-correction': REVIEWER_SHAPE, 'final-review-correction': REVIEWER_SHAPE,
  }[role] ?? {
    lines: 3, fields: '`status`, `artifact`, `signals`', statuses: '`DONE`, `DONE_WITH_CONCERNS`, `BLOCKED`, `NEEDS_CONTEXT`',
    artifact: `${DIR}/task-${task}-report.md`, example: `status: DONE\nartifact: ${DIR}/task-${task}-report.md\nsignals: none`,
  };
  return [
    `Final message: exactly ${shape.lines} plain-text lines in this order, each \`field: value\`: ${shape.fields}.`,
    `\`status\` is one of ${shape.statuses}.`,
    ...(shape.artifact ? [`\`artifact\` is exactly \`${shape.artifact}\`.`] : []),
    SIGNALS_RULE,
    ...(shape.artifact ? ['`signals` carries `discovery:unplanned` exactly when the report contains that ID, never with status `DONE`, and keeps it in every later fix of the task.'] : []),
    NO_EXTRA, SHAPE_MARKER,
  ].join(' ') + `\n${shape.example}`;
};
// A literal follower returns the prompt's example rows and nothing else.
const literalExample = (prompt) => {
  const at = prompt.indexOf(` ${SHAPE_MARKER}\n`);
  assert.ok(at > 0, `the role prompt states no example: ${prompt}`);
  return prompt.slice(at + SHAPE_MARKER.length + 2);
};
const literally = (role) => (context) => { context.defaults[role](context); return literalExample(context.request.prompt); };
function recordPrompts(runner) {
  const prompts = new Map();
  const prepare = runner.prepare;
  runner.prepare = (request) => { prompts.set(request.roleSequence, request.prompt); return prepare(request); };
  return prompts;
}
const payloadOf = (repo, roleSequence) => JSON.parse(repo.read(`${DIR}/role-${roleSequence}-response.json`)).payload;

test('every role prompt states its exact response rows, and a literal follower is accepted by that role\'s decoder', async (t) => {
  const issues = (repo) => ({ task }) => {
    repo.put(`${DIR}/task-${task}-review.md`, '# Review\n\nIssues found.\n');
    repo.put(`${DIR}/task-${task}-issues.md`, '# Issues\n\n1. Value must be 2.\n');
    return 'status: ISSUES_FOUND\nsignals: none';
  };
  const reversed = (repo) => ({ task }) => { repo.put(`${DIR}/task-${task}-review.md`, '# Review\n\nApproved after fix.\n'); return 'signals: none\nstatus: APPROVED'; };
  const fenced = (repo) => () => { repo.put(`${DIR}/final-review.md`, '# Final review\n'); return '```text\nstatus: APPROVED\nsignals: none\n```\n'; };
  const runs = [
    {
      // Triggers (non-literal) reach the fix and both correction roles.
      label: 'fix and corrections', tasks: [taskSection(1), taskSection(2)],
      script: (repo) => ({
        plan: [literally('plan')], implementer: [literally('implementer'), literally('implementer')],
        'task-reviewer': [issues(repo), reversed(repo), literally('task-reviewer')], fix: [literally('fix')],
        'task-review-correction': [literally('task-review-correction')], 'final-review': [fenced(repo)],
        'final-review-correction': [literally('final-review-correction')], review: [literally('review')],
      }),
      sequence: ['plan@1', 'implementer:1@1', 'task-reviewer:1@1', 'fix:1@2', 'task-reviewer:1@2', 'task-review-correction:1@2',
        'implementer:2@1', 'task-reviewer:2@1', 'final-review@1', 'final-review-correction@1', 'review@1'],
      literal: [1, 2, 4, 6, 7, 8, 10, 11],
    },
    {
      label: 'every role literal', tasks: [taskSection(1)],
      script: () => Object.fromEntries(['plan', 'implementer', 'task-reviewer', 'final-review', 'review'].map((role) => [role, [literally(role)]])),
      sequence: ['plan@1', 'implementer:1@1', 'task-reviewer:1@1', 'final-review@1', 'review@1'],
      literal: [1, 2, 3, 4, 5],
    },
  ];
  const accepted = new Set();
  for (const run of runs) {
    const repo = repository(t);
    const { runner, calls } = scriptedRunner(repo, { tasks: run.tasks, script: run.script(repo) });
    const prompts = recordPrompts(runner);
    const result = await control(repo, runner);
    assert.equal(result.code, 0, `${run.label}: ${result.reason}`);
    assert.deepEqual(sequence(calls), run.sequence, run.label);
    for (const entry of journal(repo).roles) {
      const prompt = prompts.get(entry.roleSequence);
      assert.equal(prompt.slice(prompt.indexOf('Final message:')), expectedShape(entry.role, entry.scope.task),
        `${run.label}: role ${entry.roleSequence} ${entry.role} prompt states its exact response rows`);
      if (!run.literal.includes(entry.roleSequence)) continue;
      assert.equal(payloadOf(repo, entry.roleSequence), literalExample(prompt), `${run.label}: role ${entry.roleSequence} returned its example`);
      assert.equal(entry.accepted, true, `${run.label}: literal role ${entry.roleSequence} ${entry.role} is accepted by its decoder`);
      accepted.add(entry.role);
    }
  }
  assert.deepEqual([...accepted].sort(), ['final-review', 'final-review-correction', 'fix', 'implementer', 'plan', 'review',
    'task-review-correction', 'task-reviewer']);
});

// The first native Codex run returned this JSON object with prose signals for
// the plan role. The decoders stay strict: the role prompt fixes the child.
const NATIVE_PLAN_PAYLOAD = '{"status":"DONE","signals":"Created DRAFT plan at .apex/work/plans/native-smoke.md. Self-review passed; …"}';

test('a JSON-with-prose plan response is still refused as a terminal halt', async (t) => {
  const repo = repository(t);
  const { runner, calls } = scriptedRunner(repo, { script: { plan: [({ defaults, ...context }) => {
    defaults.plan({ defaults, ...context });
    return NATIVE_PLAN_PAYLOAD;
  }] } });
  const result = await control(repo, runner);
  assert.deepEqual([result.code, result.halted], [1, true]);
  assert.equal(result.reason, 'role 1 plan iteration 1 response rejected: plan response must be exactly the ordered fields status, signals');
  assert.deepEqual(calls.map(({ role }) => role), ['plan']);
  const state = journal(repo);
  assert.equal(state.status, 'HALTED');
  assert.equal(state.roles[0].accepted, false);
  assert.equal(payloadOf(repo, 1), NATIVE_PLAN_PAYLOAD, 'the original response stays captured');
});

test('JSON or prose stays outside every role decoder\'s grammar', () => {
  const prose = 'Created DRAFT plan at .apex/work/plans/native-smoke.md. Self-review passed';
  for (const phase of ['plan', 'review']) {
    assert.throws(() => decodePhaseResponse(NATIVE_PLAN_PAYLOAD, phase), new RegExp(`^Error: ${phase} response must be exactly the ordered fields status, signals$`));
    assert.throws(() => decodePhaseResponse(`status: ${phase === 'plan' ? 'DONE' : 'READY_FOR_PR'}\nsignals: ${prose}`, phase),
      new RegExp(`^Error: ${phase} response has invalid signals$`));
  }
  assert.throws(() => decodeReviewerResponse('{"status":"APPROVED","signals":"none"}', 'text', { protocol: 3 }), /expected ordered reviewer semantic fields/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectRecovery, prepareRecovery, recoveryCopies } from '../scripts/autopilot-recovery.mjs';
import { controllerPlanContext } from '../scripts/autopilot-context.mjs';
import { materializeTaskBrief } from '../scripts/autopilot-plan.mjs';
import { beginTask, recordTaskResult } from '../scripts/task-results.mjs';
import { observeSource } from '../scripts/source-observation.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const recoveryScript = join(here, '..', 'scripts', 'autopilot-recovery.mjs');
const SOURCE = '.apex/work/tasks/topic';
const OLD_SPEC = '.apex/work/specs/topic.md';
const OLD_PLAN = '.apex/work/plans/topic.md';
const DEST = '.apex/work/tasks/topic-recovery';
const NEW_SPEC = '.apex/work/specs/topic-recovery.md';
const NEW_PLAN = '.apex/work/plans/topic-recovery.md';
const INPUT = `${DEST}/recovery-input.json`;
const MANIFEST = `${SOURCE}/context/phase-implement-attempt-1.json`;
const LEGACY_RUN = 'legacy-run-1';
const ROUTING = '# Hub\n\n| Surface | Min docs | Specialist agent | Applicable skill |\n|---|---|---|---|\n| `scripts` | [standards/scripts.md](standards/scripts.md) | `scripts-agent` | — |\n';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

const specText = `<!-- verdict: GAP | gear: 3
drive: autopilot
branch: gear3-topic
commit-auth: per-task
harness: claude
blast-radius: branch-only, no-push, stop-before-PR
-->
<!-- steepy-workflow: v1
phase: brainstorm
status: CONSUMED
next: plan
source: none
consumed-by: ${OLD_PLAN}
-->

# Topic spec

- **Owning surface:** \`scripts\`
- **Feature complexity:** \`integration\`

## Success criteria

1. SC1 — The first value is updated.
2. SC2 — The second value is updated.
3. SC3 — The third value is updated.
`;

function taskSection(id, { complexity = 'integration', requirements = `Set value ${id} to its next number.` } = {}) {
  return `## Task ${id} — update value ${id}

- **Requirements and deliverables:** ${requirements}
- **Relevant global constraints:** Node built-ins only.
- **Surface:** \`scripts\`
- **Specialist agent:** \`scripts-agent\`
- **Exact paths:** \`src/value-${id}.mjs\`
- **Test command:** \`npm test\`
- **Dependencies:** ${id === 1 ? 'none' : 'Task 1'}
- **Complexity:** ${complexity}
- **Success criteria:** SC${id}
`;
}

const planText = (tasks) => `<!-- steepy-workflow: v1
phase: plan
status: READY
next: implement
source: ${OLD_SPEC}
consumed-by: none
-->
# Plan

${tasks.join('\n')}`;

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'steepy-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const read = (path) => readFileSync(join(root, path), 'utf8');
  git('init', '-q', '-b', 'gear3-topic');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  put('.gitignore', '.apex/work/\n');
  put('.apex/_INDEX.md', ROUTING);
  put('.apex/standards/scripts.md', '# Scripts\n\n> Owning surface: `scripts`.\n');
  put('.apex/testing-and-checklist.md', '# Tests\n\n`npm test`\n');
  put('.apex/conventions.md', '# Conventions\n');
  for (const id of [1, 2, 3]) put(`src/value-${id}.mjs`, 'export const value = 0;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'baseline');
  put(OLD_SPEC, specText);
  return { root, git, put, read };
}

// A halted legacy run: phase manifest with task result protocol 2, and the
// executed tasks committed and recorded in one global lineage.
function legacyRun(repo, { tasks = [taskSection(1), taskSection(2), taskSection(3)], executed = [1, 2], protocol = 2 } = {}) {
  repo.put(OLD_PLAN, planText(tasks));
  repo.put(MANIFEST, `${JSON.stringify({ schemaVersion: 1, runId: LEGACY_RUN, attempt: 1, scope: { phase: 'implement', role: 'implement' },
    contract: { taskResultProtocol: protocol } })}\n`);
  repo.put(`${SOURCE}/autopilot-status.md`, '2026-09-30T10:00:00.000Z — CONDUCTOR — STATUS_PROTOCOL — version=1\n');
  let parent = null;
  for (const id of executed) {
    const state = `${SOURCE}/task-${id}-execution-1`;
    const report = `${SOURCE}/task-${id}-report.md`;
    beginTask(repo.root, state, { runId: LEGACY_RUN, attempt: 1, task: String(id), execution: 1, role: 'implementer', report,
      planPath: OLD_PLAN, parentState: parent });
    repo.put(`src/value-${id}.mjs`, 'export const value = 1;\n');
    repo.put(report, `# Task ${id} report\n\nRED then GREEN.\n`);
    repo.git('add', '-A', '--', '.');
    repo.git('commit', '-q', '-m', `legacy task ${id}`);
    recordTaskResult(repo.root, state, `status: DONE\nartifact: ${report}\nsignals: tdd:red-green`);
    parent = state;
  }
}

function writeInput(repo, { reuse = ['1', '2'], delta = [], change = (value) => value } = {}) {
  const observation = observeSource(repo.root);
  const digest = (path) => sha(readFileSync(join(repo.root, path)));
  const input = {
    schemaVersion: 1,
    source: {
      run: SOURCE,
      spec: { path: OLD_SPEC, sha256: digest(OLD_SPEC) },
      plan: { path: OLD_PLAN, sha256: digest(OLD_PLAN) },
      manifests: [{ path: MANIFEST, sha256: digest(MANIFEST) }],
      receipts: reuse.map((task) => ({ task, path: `${SOURCE}/task-${task}-execution-1-result.json`,
        sha256: digest(`${SOURCE}/task-${task}-execution-1-result.json`) })),
    },
    reuse,
    current: { branch: 'gear3-topic', head: observation.head, observation: observation.digest, delta },
    destination: { spec: NEW_SPEC, plan: NEW_PLAN, run: DEST },
  };
  repo.put(INPUT, `${JSON.stringify(change(input), null, 2)}\n`);
  return input;
}

function prepared(t, options = {}) {
  const repo = repository(t);
  legacyRun(repo, options);
  writeInput(repo, options);
  return repo;
}

const sourceBytes = (repo) => Object.fromEntries([OLD_SPEC, OLD_PLAN, MANIFEST, `${SOURCE}/task-1-execution-1-result.json`,
  `${SOURCE}/task-1-execution-1-baseline.json`, `${SOURCE}/autopilot-status.md`].map((path) => [path, repo.read(path)]));

test('inspection classifies reusable evidence, pending review, and residual work without writing', (t) => {
  const repo = prepared(t);
  const before = sourceBytes(repo);
  const result = inspectRecovery(repo.root, INPUT);
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.reconciliation, []);
  assert.deepEqual(result.tasks, [
    { task: '1', class: 'import', review: 'pending', receipt: `${SOURCE}/task-1-execution-1` },
    { task: '2', class: 'import', review: 'pending', receipt: `${SOURCE}/task-2-execution-1` },
    { task: '3', class: 'residual', review: null, receipt: null },
  ]);
  assert.equal(result.source.head, `${SOURCE}/task-2-execution-1`);
  assert.deepEqual(result.observed.delta, []);
  assert.equal(existsSync(join(repo.root, NEW_PLAN)), false);
  assert.equal(existsSync(join(repo.root, NEW_SPEC)), false);
  assert.deepEqual(sourceBytes(repo), before, 'inspection never rewrites the source run');
});

test('preparation writes deterministic copies with recorded provenance that pass the v2 plan gate', async (t) => {
  const repo = prepared(t);
  const before = sourceBytes(repo);
  const result = await prepareRecovery(repo.root, INPUT);
  assert.deepEqual(result.prepared, [NEW_SPEC, NEW_PLAN]);
  const plan = repo.read(NEW_PLAN);
  assert.match(plan, /^<!-- steepy-workflow: v1\nphase: plan\nstatus: READY\nnext: implement\nsource: \.apex\/work\/specs\/topic-recovery\.md\nconsumed-by: none\n-->\n<!-- steepy-recovery: v1\n/);
  assert.match(plan, /^source: \.apex\/work\/plans\/topic\.md$/m);
  assert.match(plan, new RegExp(`^source-sha256: ${sha(readFileSync(join(repo.root, OLD_PLAN)))}$`, 'm'));
  assert.match(plan, /^source-lifecycle: phase=plan status=READY consumed-by=none$/m);
  assert.match(plan, new RegExp(`^recovery-input-sha256: ${sha(readFileSync(join(repo.root, INPUT)))}$`, 'm'));
  assert.match(plan, /^transformation: lifecycle source rebound to \.apex\/work\/specs\/topic-recovery\.md$/m);
  assert.ok(plan.endsWith(repo.read(OLD_PLAN).slice(repo.read(OLD_PLAN).indexOf('# Plan'))), 'approved requirement text is copied verbatim');
  assert.deepEqual(controllerPlanContext({ repoRoot: repo.root, planText: plan }).tasks.map(({ task }) => task), ['1', '2', '3']);
  const spec = repo.read(NEW_SPEC);
  assert.match(spec, /^<!-- verdict: GAP \| gear: 3\n/);
  assert.match(spec, /^status: CONSUMED\nnext: plan\nsource: none\nconsumed-by: \.apex\/work\/plans\/topic-recovery\.md$/m);
  assert.match(spec, /^transformation: lifecycle consumed-by rebound to \.apex\/work\/plans\/topic-recovery\.md$/m);
  assert.match(spec, /^source-lifecycle: phase=brainstorm status=CONSUMED consumed-by=\.apex\/work\/plans\/topic\.md$/m);
  assert.deepEqual(sourceBytes(repo), before, 'the originals are preserved with their own lifecycle');
  const again = await prepareRecovery(repo.root, INPUT);
  assert.deepEqual(again.prepared, [NEW_SPEC, NEW_PLAN]);
  assert.equal(repo.read(NEW_PLAN), plan, 'a repeated preparation is an exact no-op');
  repo.put(NEW_PLAN, plan.replace('Set value 1', 'Set value 9'));
  await assert.rejects(prepareRecovery(repo.root, INPUT), /destination .*topic-recovery\.md exists with different bytes/);
});

test('a source plan the v2 grammar refuses stops preparation with the named plan error and no destination', async (t) => {
  const repo = prepared(t, { tasks: [taskSection(1, { requirements: `Follow ${OLD_SPEC} as written.` }), taskSection(2), taskSection(3)] });
  const result = inspectRecovery(repo.root, INPUT);
  assert.equal(result.status, 'RECONCILIATION_REQUIRED');
  assert.match(result.reconciliation.join('\n'), /plan rejected: Task 1 spec section needs an exact path and heading capability/);
  await assert.rejects(prepareRecovery(repo.root, INPUT), /plan rejected: Task 1 spec section needs an exact path and heading capability/);
  assert.equal(existsSync(join(repo.root, NEW_PLAN)), false);
  assert.equal(existsSync(join(repo.root, NEW_SPEC)), false);
});

// A halted legacy plan may repeat its Requirements bullet inside a task, which
// the strict v2 grammar refuses. Preparation folds each contiguous run into one
// field, in order and losslessly, and records the merge as provenance.
const repeatedRequirements = (id, values) => taskSection(id).replace(`- **Requirements and deliverables:** Set value ${id} to its next number.\n`,
  values.map((value) => `- **Requirements and deliverables:** ${value}\n`).join(''));

test('preparation merges repeated Requirements bullets in order, records each merge, and stays an exact no-op', async (t) => {
  const repo = prepared(t, { tasks: [
    repeatedRequirements(1, ['Set value 1 to its next number.', 'Keep the export name\n  `value` unchanged.', 'Log nothing.']),
    repeatedRequirements(2, ['Set value 2 to its next number.\n', 'Keep the export.', 'Change no other file.']),
    taskSection(3),
  ] });
  assert.equal(inspectRecovery(repo.root, INPUT).status, 'READY');
  const result = await prepareRecovery(repo.root, INPUT);
  assert.equal(result.status, 'READY');
  const plan = repo.read(NEW_PLAN);
  assert.match(plan, /^transformation: lifecycle source rebound to \.apex\/work\/specs\/topic-recovery\.md; Task 1 Requirements and deliverables: 3 bullets merged in order; Task 2 Requirements and deliverables: 3 bullets merged in order$/m);
  assert.ok(plan.includes('- **Requirements and deliverables:**\n  - Set value 1 to its next number.\n  - Keep the export name\n    `value` unchanged.\n  - Log nothing.\n- **Relevant global constraints:**'),
    'the merged field sits at the first occurrence, with each continuation re-indented under its own sub-bullet');
  assert.ok(plan.endsWith(taskSection(3)), 'a task without repeats is copied verbatim');
  const { tasks } = controllerPlanContext({ repoRoot: repo.root, planText: plan });
  assert.deepEqual(tasks.map(({ requirements }) => requirements), [
    '\n  - Set value 1 to its next number.\n  - Keep the export name\n    `value` unchanged.\n  - Log nothing.',
    '\n  - Set value 2 to its next number.\n\n  - Keep the export.\n  - Change no other file.',
    'Set value 3 to its next number.',
  ], 'every original value, in order, with a blank line kept where it stood');
  const brief = materializeTaskBrief(tasks[0], { sourcePlanPath: NEW_PLAN });
  assert.ok(brief.includes('- **Requirements and deliverables:**\n  - Set value 1 to its next number.\n  - Keep the export name\n    `value` unchanged.\n  - Log nothing.\n'), brief);
  assert.equal(recoveryCopies(repo.root, INPUT).plan, plan, 'the controller re-derives the prepared bytes exactly');
  const written = statSync(join(repo.root, NEW_PLAN)).mtimeMs;
  const again = await prepareRecovery(repo.root, INPUT);
  assert.equal(again.status, 'READY');
  assert.equal(repo.read(NEW_PLAN), plan, 'a repeated preparation is byte-identical');
  assert.equal(statSync(join(repo.root, NEW_PLAN)).mtimeMs, written, 'and writes nothing');
});

test('a duplicate field other than Requirements still fails preparation with the named plan error', async (t) => {
  const doubled = (label, line) => repeatedRequirements(1, ['Set value 1 to its next number.', 'Log nothing.'])
    .replace('- **Success criteria:** SC1\n', `- **Success criteria:** SC1\n${line}`).replace(new RegExp(`^(- \\*\\*${label}:\\*\\*.*\\n)`, 'm'), '$1$1');
  for (const [label, extra] of [['Relevant global constraints'], ['Surface'], ['Specialist agent'], ['Exact paths'], ['Test command'],
    ['Dependencies'], ['Complexity'], ['Success criteria'],
    ['Standard paths', '- **Standard paths:** `.apex/standards/scripts.md`\n'], ['Routing reasons', '- **Routing reasons:** Core only.\n']]) {
    const repo = prepared(t, { tasks: [doubled(label, extra ?? ''), taskSection(2), taskSection(3)] });
    const result = inspectRecovery(repo.root, INPUT);
    assert.deepEqual(result.reconciliation, [`plan rejected: Task 1 has duplicate ${label} field`], label);
    if (label !== 'Test command') continue;
    await assert.rejects(prepareRecovery(repo.root, INPUT), /recovery requires reconciliation: plan rejected: Task 1 has duplicate Test command field$/);
    assert.equal(existsSync(join(repo.root, NEW_PLAN)), false);
    assert.equal(existsSync(join(repo.root, NEW_SPEC)), false);
  }
});

// The merge is narrow: only a contiguous run of plain inline values. Anything
// else is refused by name for human reconciliation, never moved or re-indented.
test('repeated Requirements around another field, without an inline value, or with a fence or comment are refused by name', async (t) => {
  for (const [label, task, reason] of [
    ['around another field', taskSection(1).replace('- **Surface:**', '- **Requirements and deliverables:** Log nothing.\n- **Surface:**'),
      /plan rejected: Task 1 repeats Requirements and deliverables around another field; only a contiguous run is merged/],
    ['without an inline value', repeatedRequirements(1, ['Set value 1 to its next number.', '\n  - Log nothing.']),
      /plan rejected: Task 1 repeats Requirements and deliverables without an inline value; only inline values are merged/],
    ['with a code fence', repeatedRequirements(1, ['Set value 1 to its next number.', 'Run it:\n  ```sh\n  npm test\n  ```']),
      /plan rejected: Task 1 repeats Requirements and deliverables with a code fence or HTML comment; only plain values are merged/],
    ['with an HTML comment', repeatedRequirements(1, ['Set value 1 to its next number.', 'Log nothing. <!-- reviewer note -->']),
      /plan rejected: Task 1 repeats Requirements and deliverables with a code fence or HTML comment; only plain values are merged/],
  ]) {
    const repo = prepared(t, { tasks: [task, taskSection(2), taskSection(3)] });
    const result = inspectRecovery(repo.root, INPUT);
    assert.equal(result.reconciliation.length, 1, label);
    assert.match(result.reconciliation[0], reason, label);
    await assert.rejects(prepareRecovery(repo.root, INPUT), reason, label);
    assert.equal(existsSync(join(repo.root, NEW_PLAN)), false, label);
  }
});

for (const [label, mutate, reason] of [
  ['an unexplained delta', (repo) => { repo.put('src/value-3.mjs', 'export const value = 7;\n'); repo.git('commit', '-qam', 'manual edit'); },
    /unexplained source delta requires reconciliation: src\/value-3\.mjs/],
  ['a drifted source receipt', (repo) => {
    const path = `${SOURCE}/task-1-execution-1-result.json`;
    repo.put(path, repo.read(path).replace('"tdd:red-green"', '"tdd:invented"'));
  }, /Task 1: source receipt digest drift/],
  ['a drifted source plan', (repo) => repo.put(OLD_PLAN, `${repo.read(OLD_PLAN)}\n`), /source plan digest drift/],
  ['a moved checkout', (repo) => repo.git('checkout', '-q', '-b', 'elsewhere'), /current snapshot differs from the accepted recovery snapshot/],
]) {
  test(`inspection requires reconciliation for ${label} and preparation writes nothing`, async (t) => {
    const repo = prepared(t);
    mutate(repo);
    const result = inspectRecovery(repo.root, INPUT);
    assert.equal(result.status, 'RECONCILIATION_REQUIRED');
    assert.match(result.reconciliation.join('\n'), reason);
    await assert.rejects(prepareRecovery(repo.root, INPUT), /recovery requires reconciliation/);
    assert.equal(existsSync(join(repo.root, NEW_PLAN)), false);
  });
}

test('foreign-run substitution and protocol downgrade are refused before any destination', async (t) => {
  const foreign = prepared(t);
  foreign.put('.apex/work/tasks/other/task-1-execution-1-result.json', foreign.read(`${SOURCE}/task-1-execution-1-result.json`));
  writeInput(foreign, { change: (input) => ({ ...input, source: { ...input.source, receipts: input.source.receipts.map((receipt, index) => (index === 0
    ? { ...receipt, path: '.apex/work/tasks/other/task-1-execution-1-result.json' } : receipt)) } }) });
  assert.throws(() => inspectRecovery(foreign.root, INPUT), /recovery input receipt for Task 1 must be an execution result of \.apex\/work\/tasks\/topic/);

  const roleManifest = prepared(t);
  writeInput(roleManifest, { change: (input) => ({ ...input, source: { ...input.source, manifests: [{ path: `${SOURCE}/context/role-2.json`, sha256: '0'.repeat(64) }] } }) });
  assert.throws(() => inspectRecovery(roleManifest.root, INPUT), /controller protocol 2 source runs are not importable/);

  const downgraded = prepared(t, { protocol: 1 });
  const result = inspectRecovery(downgraded.root, INPUT);
  assert.match(result.reconciliation.join('\n'), /source attempt 1 is not task result protocol 2; refusing implicit conversion/);
  await assert.rejects(prepareRecovery(downgraded.root, INPUT), /refusing implicit conversion/);
  assert.equal(existsSync(join(downgraded.root, NEW_PLAN)), false);
});

test('the recovery input is an exact, closed contract named by its own run directory', (t) => {
  const repo = prepared(t);
  for (const [change, reason] of [
    [(input) => ({ ...input, extra: true }), /recovery input fields must be closed/],
    [(input) => ({ ...input, reuse: ['2', '1'] }), /reuse must list the receipt tasks in order/],
    [(input) => ({ ...input, reuse: ['1'] }), /reuse must list the receipt tasks in order/],
    [(input) => ({ ...input, destination: { ...input.destination, plan: '.apex/work/plans/elsewhere.md' } }), /destination must be this recovery run/],
    [(input) => ({ ...input, source: { ...input.source, run: DEST } }), /source run must differ from the recovery destination/],
    [(input) => ({ ...input, current: { ...input.current, delta: ['b', 'a'] } }), /current delta must be sorted unique source paths/],
  ]) {
    writeInput(repo, { change });
    assert.throws(() => inspectRecovery(repo.root, INPUT), reason);
  }
  writeInput(repo);
  assert.throws(() => inspectRecovery(repo.root, `${SOURCE}/recovery-input.json`), /missing work artifact/, 'only the exact named input is read');
  assert.throws(() => inspectRecovery(repo.root, `${DEST}/task-1-import.json`), /recovery input must be a run's exact recovery-input\.json/);
  assert.throws(() => inspectRecovery(repo.root, '.apex/work/tasks/topic-recovery/../topic-recovery/recovery-input.json'), /work path/);
});

test('the recovery CLI inspects and prepares exactly the named input', (t) => {
  const repo = prepared(t);
  const cli = (...args) => spawnSync(process.execPath, [recoveryScript, ...args], { encoding: 'utf8' });
  const inspected = cli('inspect', '--repo-root', repo.root, '--recovery-input', INPUT);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).status, 'READY');
  assert.equal(existsSync(join(repo.root, NEW_PLAN)), false);
  const preparedRun = cli('prepare', '--repo-root', repo.root, '--recovery-input', INPUT);
  assert.equal(preparedRun.status, 0, preparedRun.stderr);
  assert.deepEqual(JSON.parse(preparedRun.stdout).prepared, [NEW_SPEC, NEW_PLAN]);
  assert.equal(cli('inspect', '--repo-root', repo.root).status, 2);
  assert.equal(cli('resume', '--repo-root', repo.root, '--recovery-input', INPUT).status, 2);
  repo.put('src/value-3.mjs', 'export const value = 5;\n');
  repo.git('commit', '-qam', 'drift');
  const drifted = cli('inspect', '--repo-root', repo.root, '--recovery-input', INPUT);
  assert.equal(drifted.status, 1);
  assert.equal(JSON.parse(drifted.stdout).status, 'RECONCILIATION_REQUIRED');
});

// ---- The recovery run, driven through the conductor CLI ------------------
const RUN = '2f2e2d2c-2b2a-4928-8726-252423222120';
const evidenceReport = () => {
  const started = new Date().toISOString();
  const section = (label, display) => {
    const output = `${label} output\n`;
    return `\n## ${label}\n\nCommand JSON: ${JSON.stringify(display)}\nStarted: ${started}\n\n--- combined stdout/stderr begin ---\n${output}`
      + `\n--- combined stdout/stderr end ---\n\nExit code: 0\nSignal: none\nSpawn error: none\nOutput bytes: ${Buffer.byteLength(output)}\n`
      + `Output lines: 1\nOutput SHA-256: ${sha(output)}\nFinished: ${started}\n`;
  };
  return `# Review evidence\n\nRun started: ${started}\nCapture: combined stdout/stderr bytes are persisted in arrival order.\n`
    + section('surface-test', 'npm test') + section('validate-hub', '"node" "scripts/validate-hub.mjs" .')
    + `## Collection result\n\nRun finished: ${started}\nAll commands passed: true\n`;
};

// One fresh child per role: it reads only its published manifest, writes its
// assigned artifacts, and returns the closed role payload.
function roleRunner(repo, script = {}) {
  const calls = [];
  const queues = Object.fromEntries(Object.entries(script).map(([role, steps]) => [role, [...steps]]));
  const writer = ({ task }) => {
    repo.put(`src/value-${task}.mjs`, `export const value = ${calls.length + 10};\n`);
    repo.put(`${DEST}/task-${task}-report.md`, `# Task ${task} report\n\nRED then GREEN.\n`);
    return `status: DONE\nartifact: ${DEST}/task-${task}-report.md\nsignals: tdd:red-green`;
  };
  const defaults = {
    implementer: writer, fix: writer,
    'task-reviewer': ({ task }) => { repo.put(`${DEST}/task-${task}-review.md`, `# Task ${task} review\n\nApproved.\n`); return 'status: APPROVED\nsignals: none'; },
    'final-review': () => { repo.put(`${DEST}/final-review.md`, '# Final review\n\nApproved.\n'); return 'status: APPROVED\nsignals: none'; },
    review: () => {
      repo.put(`${DEST}/review-report.md`, `<!-- steepy-workflow: v1\nphase: review\nstatus: DRAFT\nnext: none\nsource: ${DEST}/task-result-index.md\nconsumed-by: none\n-->\n# Review report\n`);
      repo.put(`${DEST}/evidence-report.md`, evidenceReport());
      return 'status: READY_FOR_PR\nsignals: none';
    },
  };
  const runner = {
    prepare: (request) => ({
      requestedModel: null, descriptorModel: null, degradationReason: 'injected test runner',
      run: async ({ rawPath }) => {
        const manifest = JSON.parse(repo.read(request.manifestPath));
        const task = manifest.scope.task === undefined ? null : String(manifest.scope.task);
        calls.push(`${request.role}${task === null ? '' : `:${task}`}@${request.scope.iteration}`);
        const payload = (queues[request.role]?.shift() ?? defaults[request.role])({ task, manifest });
        repo.put(rawPath, `${JSON.stringify({ type: 'result', result: payload })}\n`);
        return { payload, exit: { status: 0, signal: null } };
      },
    }),
  };
  return { runner, calls };
}

async function conduct(repo, argv, opts = {}) {
  const autopilot = await import('../scripts/autopilot.mjs');
  const err = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = () => {};
  console.error = (...args) => err.push(args.join(' '));
  try {
    const code = await autopilot.main(argv, { cwd: repo.root, runId: RUN,
      commandFor: () => { throw new Error('the legacy driver must not dispatch'); }, ...opts });
    return { code, err: err.join('\n') };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

async function recoveryRepo(t, options) {
  const repo = prepared(t, options);
  await prepareRecovery(repo.root, INPUT);
  return repo;
}
const START = [NEW_SPEC, '--recovery-input', INPUT];
const events = (repo) => repo.read(`${DEST}/autopilot-events.jsonl`).trim().split('\n').map((line) => JSON.parse(line));
const writerRoles = (repo) => events(repo).filter((event) => event.event === 'ROLE_RESERVED' && ['implementer', 'fix'].includes(event.role));
const header = (text) => Object.fromEntries(/<!-- steepy-workflow: v1\n([\s\S]*?)\n-->/.exec(text)[1].split('\n').map((line) => line.split(': ')));

test('a recovery run imports reused evidence, reviews it, and dispatches only the residual work', async (t) => {
  // Task 2 is mechanical: imported evidence still needs a review in this run.
  const repo = await recoveryRepo(t, { tasks: [taskSection(1), taskSection(2, { complexity: 'mechanical' }), taskSection(3)] });
  const before = sourceBytes(repo);
  const { runner, calls } = roleRunner(repo);
  const result = await conduct(repo, START, { controllerServices: { runner } });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(calls, ['task-reviewer:1@1', 'task-reviewer:2@1', 'implementer:3@1', 'task-reviewer:3@1', 'final-review@1', 'review@1']);
  const journal = events(repo);
  assert.deepEqual(journal.slice(0, 4).map(({ event }) => event), ['RUN_STARTED', 'RECOVERY_IMPORTED', 'RECOVERY_IMPORTED', 'PHASE_RESERVED']);
  assert.equal(journal[0].baseline, JSON.parse(repo.read(INPUT)).current.head, 'the run records its own newly observed baseline');
  assert.deepEqual(journal.filter(({ event }) => event === 'RECOVERY_IMPORTED').map(({ importPath }) => importPath),
    [`${DEST}/task-1-import.json`, `${DEST}/task-2-import.json`]);
  assert.equal(journal.some(({ event, scope }) => event === 'PHASE_RESERVED' && scope.phase === 'plan'), false, 'no plan phase is invented');
  assert.equal(journal.some(({ event, role }) => event === 'ROLE_RESERVED' && role === 'plan'), false);
  assert.equal(journal.at(-1).event, 'RUN_COMPLETED');
  const index = repo.read(`${DEST}/task-result-index.md`);
  assert.match(index, /^<!-- steepy-task-results: v3 -->$/m);
  assert.deepEqual(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(index)[1]).map(({ task, kind, status }) => [task, kind, status]),
    [['1', 'import', 'IMPORTED'], ['2', 'import', 'IMPORTED'], ['3', 'execution', 'DONE']]);
  for (const task of [1, 2, 3]) assert.match(index, new RegExp(`^Reviewer gate Task ${task}: \\S+task-${task}-review-guard-attempt-1-iteration-1$`, 'm'));
  const reviewer = journal.find((event) => event.event === 'ROLE_RESERVED' && event.role === 'task-reviewer');
  const manifest = JSON.parse(repo.read(`${DEST}/context/role-${reviewer.roleSequence}.json`));
  assert.equal(manifest.contract.taskResultIndexProtocol, 3);
  assert.equal(manifest.contract.reviewedEvidence, 'import');
  assert.equal(manifest.contract.recoveryInputDigest, sha(readFileSync(join(repo.root, INPUT))));
  assert.ok(manifest.required.some(({ path }) => path === `${DEST}/task-1-import.json`));
  assert.match(repo.read(`${DEST}/branch-diff.txt`), /src\/value-1\.mjs/, 'the final review sees the imported work');
  assert.deepEqual(header(repo.read(NEW_PLAN)), { phase: 'plan', status: 'CONSUMED', next: 'implement', source: NEW_SPEC, 'consumed-by': `${DEST}/task-result-index.md` });
  assert.deepEqual(sourceBytes(repo), before, 'the source run keeps its own incomplete lifecycle');
  assert.equal(writerRoles(repo).length, 1, 'only the residual task has a writer');
});

test('a recovery run from a plan with repeated Requirements bullets binds the merged copy and completes', async (t) => {
  const repo = await recoveryRepo(t, { tasks: [
    repeatedRequirements(1, ['Set value 1 to its next number.', 'Log nothing.']),
    taskSection(2),
    repeatedRequirements(3, ['Set value 3 to its next number.', 'Keep the export name\n  `value` unchanged.', 'Change no other file.']),
  ] });
  const { runner, calls } = roleRunner(repo);
  const result = await conduct(repo, START, { controllerServices: { runner } });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(calls, ['task-reviewer:1@1', 'task-reviewer:2@1', 'implementer:3@1', 'task-reviewer:3@1', 'final-review@1', 'review@1']);
  assert.ok(repo.read(`${DEST}/task-3-brief.md`).includes('- **Requirements and deliverables:**\n  - Set value 3 to its next number.\n  - Keep the export name\n    `value` unchanged.\n  - Change no other file.\n'));
  assert.equal(header(repo.read(NEW_PLAN)).status, 'CONSUMED', 'the merged copy still binds at implement acceptance');
});

test('a fix after an import is a real execution linked to the imported evidence', async (t) => {
  const repo = await recoveryRepo(t);
  const issues = ({ task }) => {
    repo.put(`${DEST}/task-${task}-review.md`, '# Review\n\nIssues found.\n');
    repo.put(`${DEST}/task-${task}-issues.md`, '# Issues\n\n1. Value must change again.\n');
    return 'status: ISSUES_FOUND\nsignals: none';
  };
  const { runner, calls } = roleRunner(repo, { 'task-reviewer': [issues] });
  const result = await conduct(repo, START, { controllerServices: { runner } });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(calls.slice(0, 3), ['task-reviewer:1@1', 'fix:1@2', 'task-reviewer:1@2']);
  const baseline = JSON.parse(repo.read(`${DEST}/task-1-execution-2-baseline.json`));
  assert.deepEqual([baseline.version, baseline.config.role, baseline.config.previousImport, baseline.config.previousState],
    [3, 'fix', `${DEST}/task-1-import.json`, null]);
  assert.equal(baseline.previousDigest, sha(readFileSync(join(repo.root, `${DEST}/task-1-import.json`))));
  const index = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(repo.read(`${DEST}/task-result-index.md`))[1]);
  assert.deepEqual(index.map(({ task, kind }) => [task, kind]), [['1', 'execution'], ['2', 'import'], ['3', 'execution']]);
  assert.deepEqual(writerRoles(repo).map(({ role }) => role), ['fix', 'implementer']);
});

for (const [point, match] of [['run-created', {}], ['recovery-imported', { task: '1' }], ['phase-reserved', {}], ['response-captured', { role: 'implementer' }]]) {
  test(`a recovery run interrupted at ${point} resumes from its journal without repeating a writer`, async (t) => {
    const repo = await recoveryRepo(t);
    const crash = (at, detail) => {
      if (at === point && Object.entries(match).every(([key, value]) => String(detail[key]) === value)) throw new Error(`simulated crash at ${point}`);
    };
    const first = roleRunner(repo);
    const crashed = await conduct(repo, START, { controllerServices: { runner: first.runner, crash } });
    assert.equal(crashed.code, 1);
    assert.match(crashed.err, /simulated crash/);
    const refused = await conduct(repo, START, { controllerServices: { runner: roleRunner(repo).runner } });
    assert.equal(refused.code, 1);
    assert.match(refused.err, /--recovery-input starts a new recovery run; the existing run resumes from its journal without it/);
    const resumed = roleRunner(repo);
    const result = await conduct(repo, [NEW_SPEC], { controllerServices: { runner: resumed.runner } });
    assert.equal(result.code, 0, result.err);
    assert.equal([...first.calls, ...resumed.calls].filter((call) => /^(?:implementer|fix):/.test(call)).length, 1);
    assert.equal(writerRoles(repo).length, 1);
    assert.equal(events(repo).filter(({ event }) => event === 'RECOVERY_IMPORTED').length, 2);
  });
}

test('the recovery entry is explicit, exact, and distinct from resume', async (t) => {
  const repo = await recoveryRepo(t);
  const { runner, calls } = roleRunner(repo);
  for (const [argv, reason] of [
    [[NEW_SPEC], /a recovery input exists at \.apex\/work\/tasks\/topic-recovery\/recovery-input\.json; start it explicitly with --recovery-input/],
    [[...START, '--controller-protocol', '1'], /a recovery run requires controller protocol 2/],
    [[...START, '--resume-input', `${DEST}/task-1-report.md`], /explicit resume inputs belong to the legacy implement phase/],
    [[NEW_SPEC, '--recovery-input', `${SOURCE}/recovery-input.json`], /recovery input must be exactly \.apex\/work\/tasks\/topic-recovery\/recovery-input\.json/],
  ]) {
    const result = await conduct(repo, argv, { controllerServices: { runner } });
    assert.equal(result.code, 1);
    assert.match(result.err, reason);
    assert.equal(existsSync(join(repo.root, `${DEST}/autopilot-run.json`)), false, 'a refused entry creates no run identity');
  }
  assert.deepEqual(calls, []);
});

test('drift after preparation is refused before any run identity, import, or dispatch', async (t) => {
  const repo = await recoveryRepo(t);
  repo.put('src/value-3.mjs', 'export const value = 4;\n');
  repo.git('commit', '-qam', 'unrecorded change');
  const { runner, calls } = roleRunner(repo);
  const result = await conduct(repo, START, { controllerServices: { runner } });
  assert.equal(result.code, 1);
  assert.match(result.err, /refused — recovery input: recovery requires reconciliation: .*unexplained source delta requires reconciliation: src\/value-3\.mjs/);
  assert.equal(existsSync(join(repo.root, `${DEST}/autopilot-run.json`)), false);
  assert.equal(existsSync(join(repo.root, `${DEST}/task-1-import.json`)), false);
  assert.deepEqual(calls, []);
});

test('a tampered import or a substituted prepared plan halts the recovery run', async (t) => {
  for (const [label, point, mutate, reason] of [
    ['import', 'recovery-imported', (repo) => repo.put(`${DEST}/task-1-import.json`, repo.read(`${DEST}/task-1-import.json`).replace('"delta":[]', '"delta":["src/value-1.mjs"]')),
      /artifact digest mismatch|task import delta mismatch/],
    ['plan', 'phase-reserved', (repo) => repo.put(NEW_PLAN, repo.read(NEW_PLAN).replace('Set value 3', 'Delete value 3')),
      /plan publication drift: the plan no longer matches the prepared recovery copy/],
  ]) {
    const repo = await recoveryRepo(t);
    const crash = (at, detail) => { if (at === point && (point !== 'recovery-imported' || String(detail.task) === '2')) throw new Error('simulated crash'); };
    assert.equal((await conduct(repo, START, { controllerServices: { runner: roleRunner(repo).runner, crash } })).code, 1, label);
    mutate(repo);
    const resumed = roleRunner(repo);
    const result = await conduct(repo, [NEW_SPEC], { controllerServices: { runner: resumed.runner } });
    assert.equal(result.code, 1, label);
    assert.match(result.err, reason);
    assert.deepEqual(resumed.calls, [], label);
    assert.ok(writerRoles(repo).length === 0, label);
  }
});

test('whole-branch issues on an imported task dispatch a real fix linked to the import', async (t) => {
  const repo = await recoveryRepo(t);
  const finalIssues = () => {
    repo.put(`${DEST}/final-review.md`, '# Final review\n\nIssues found.\n');
    repo.put(`${DEST}/final-review-issues.md`, `# Final issues\n\nFinding F1: value drift.\n\nsteepy-fix-targets: v1\n\`\`\`json\n${JSON.stringify([{ task: '1', issueIds: ['F1'] }])}\n\`\`\`\n`);
    return 'status: ISSUES_FOUND\nsignals: none';
  };
  const { runner, calls } = roleRunner(repo, { 'final-review': [finalIssues] });
  const result = await conduct(repo, START, { controllerServices: { runner } });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(calls.slice(4), ['final-review@1', 'fix:1@2', 'task-reviewer:1@2', 'final-review@2', 'review@1']);
  assert.equal(JSON.parse(repo.read(`${DEST}/task-1-execution-2-baseline.json`)).config.previousImport, `${DEST}/task-1-import.json`);
  assert.match(repo.read(`${DEST}/task-result-index.md`), /^Reviewer gate Task 1: \S+task-1-review-guard-attempt-1-iteration-2$/m);
});

test('recovery registration interrupted by another event, or a downgraded role manifest, halts the run', async (t) => {
  const { appendAutopilotEvent } = await import('../scripts/autopilot-state.mjs');
  const interrupted = await recoveryRepo(t);
  const crashAfterFirst = (at, detail) => { if (at === 'recovery-imported' && String(detail.task) === '1') throw new Error('simulated crash'); };
  assert.equal((await conduct(interrupted, START, { controllerServices: { runner: roleRunner(interrupted).runner, crash: crashAfterFirst } })).code, 1);
  appendAutopilotEvent(interrupted.root, DEST, { event: 'PHASE_RESERVED', scope: { phase: 'implement', attempt: 1, task: null, iteration: 1 } });
  const resumed = roleRunner(interrupted);
  const halted = await conduct(interrupted, [NEW_SPEC], { controllerServices: { runner: resumed.runner } });
  assert.equal(halted.code, 1);
  assert.match(halted.err, /HALTED — recovery registration was interrupted by other run events/);
  assert.deepEqual(resumed.calls, []);

  const downgraded = await recoveryRepo(t);
  const crashAtFinal = (at, detail) => { if (at === 'result-accepted' && detail.role === 'final-review') throw new Error('simulated crash'); };
  assert.equal((await conduct(downgraded, START, { controllerServices: { runner: roleRunner(downgraded).runner, crash: crashAtFinal } })).code, 1);
  const writer = writerRoles(downgraded)[0];
  const manifestPath = `${DEST}/context/role-${writer.roleSequence}.json`;
  downgraded.put(manifestPath, downgraded.read(manifestPath).replace('"taskResultIndexProtocol": 3', '"taskResultIndexProtocol": 2'));
  const result = await conduct(downgraded, [NEW_SPEC], { controllerServices: { runner: roleRunner(downgraded).runner } });
  assert.equal(result.code, 1);
  assert.match(result.err, /HALTED — implement acceptance: task execution \S+task-3-execution-1 manifest provenance mismatch/);
});

test('a recovery run keeps its bound kind: a missing or changed input fails closed, never converting to a planned run', async (t) => {
  const repo = await recoveryRepo(t);
  const input = repo.read(INPUT);
  const crash = (at) => { if (at === 'run-created') throw new Error('simulated crash'); };
  assert.equal((await conduct(repo, START, { controllerServices: { runner: roleRunner(repo).runner, crash } })).code, 1);
  assert.equal(JSON.parse(repo.read(`${DEST}/autopilot-run.json`)).recovery.sha256, sha(input));
  const journal = repo.read(`${DEST}/autopilot-events.jsonl`);
  for (const [label, change, reason] of [
    ['missing', () => rmSync(join(repo.root, INPUT)), /refused — this recovery run's input is missing: \.apex\/work\/tasks\/topic-recovery\/recovery-input\.json/],
    ['changed', () => repo.put(INPUT, input.replace('"reuse"', '"reuse" ')), /refused — this recovery run's input changed since the run was created/],
  ]) {
    change();
    const resumed = roleRunner(repo);
    const result = await conduct(repo, [NEW_SPEC], { controllerServices: { runner: resumed.runner } });
    assert.equal(result.code, 1, label);
    assert.match(result.err, reason, label);
    assert.deepEqual(resumed.calls, [], `${label}: no plan role and no writer`);
    assert.equal(repo.read(`${DEST}/autopilot-events.jsonl`), journal, `${label}: the journal is unchanged`);
  }
  repo.put(INPUT, input);
  const restored = roleRunner(repo);
  const result = await conduct(repo, [NEW_SPEC], { controllerServices: { runner: restored.runner } });
  assert.equal(result.code, 0, result.err);
  assert.equal(restored.calls.includes('implementer:1@1'), false);
  assert.equal(writerRoles(repo).length, 1);
  assert.equal(events(repo).some(({ event, role }) => event === 'ROLE_RESERVED' && role === 'plan'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { beginTask, recordTaskResult, inspectTaskResult, projectTaskResults, verifyTaskResults, parseTaskResultProjection, importTaskResult, inspectTaskImport } from '../scripts/task-results.mjs';

const dir = '.apex/work/tasks/run';
const indexPath = `${dir}/task-result-index.md`;
const state = `${dir}/task-1-execution-1`;
const config = { runId: 'test-run', attempt: 1, task: '1', execution: 1, role: 'implementer', report: `${dir}/task-1-report.md`, planPath: '.apex/work/plans/run.md' };
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'steepy-task-results-'));
  const git = (...args) => execFileSync('git', args, { cwd: root });
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  try {
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
    put('.gitignore', '.apex/work/\n'); put('source', 'baseline'); git('add', '.'); git('commit', '-qm', 'baseline');
    put(config.planPath, '# Plan\nTask 1 implement source\n'); put(indexPath, '# Index\nReviewer gate Task 1: retained\n');
    return fn({ root, git, put });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const response = `status: DONE\nartifact: ${config.report}\nsignals: tdd:red-green`;
const retryConfig = (execution = 2) => ({ ...config, execution, role: 'retry', previousState: `${dir}/task-1-execution-${execution - 1}` });

for (const status of ['NEEDS_CONTEXT', 'BLOCKED']) test(`explicit retry after valid ${status} preserves partial work and immutable evidence`, () => fixture(({ root, put }) => {
  beginTask(root, state, config); put('partial', 'work before needing help'); put(config.report, 'Needs additional context or an external remedy.');
  const pending = recordTaskResult(root, state, response.replace('DONE', status));
  assert.equal(pending.accepted, false); assert.equal(pending.retryable, true);
  const oldBytes = ['baseline.json', 'capture.json', 'report.md', 'result.json'].map((suffix) => readFileSync(join(root, `${state}-${suffix}`)));
  const next = `${dir}/task-1-execution-2`;
  assert.throws(() => beginTask(root, next, { ...retryConfig(), role: 'fix' }), /incomplete/);
  assert.throws(() => beginTask(root, `${dir}/task-2-execution-1`, { ...config, task: '2', report: `${dir}/task-2-report.md`, parentState: state }), /parent/);
  beginTask(root, next, retryConfig());
  put('completed', 'work after context/remedy supplied'); put(config.report, 'Completed with supplied context/remedy.');
  const done = recordTaskResult(root, next, response);
  assert.equal(done.accepted, true); assert.equal(done.retryable, false);
  assert.deepEqual(done.changedPaths, ['completed', 'partial']); assert.deepEqual(done.executionChangedPaths, ['completed']);
  projectTaskResults(root, { indexPath, states: [next] });
  const verified = verifyTaskResults(root, { indexPath, expectedTasks: ['1'] });
  assert.deepEqual(verified.executions.map(({ state: path, sequence }) => [path, sequence]), [[state, 1], [next, 2]]);
  assert.equal(verified.executions[0].digest, pending.digest);
  assert.equal(verified.proofs.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(root, `${next}-baseline.json`))).taskBefore,
    JSON.parse(oldBytes[0]).taskBefore);
  ['baseline.json', 'capture.json', 'report.md', 'result.json'].forEach((suffix, i) => assert.deepEqual(readFileSync(join(root, `${state}-${suffix}`)), oldBytes[i]));
}));

test('repeated retry requires valid non-success, then a successful retry admits fixes only', () => fixture(({ root, put }) => {
  beginTask(root, state, config); put(config.report, 'Needs context.');
  recordTaskResult(root, state, response.replace('DONE', 'NEEDS_CONTEXT'));
  const second = `${dir}/task-1-execution-2`, third = `${dir}/task-1-execution-3`, fourth = `${dir}/task-1-execution-4`;
  beginTask(root, second, retryConfig()); put(config.report, 'External prerequisite still blocked.');
  assert.equal(recordTaskResult(root, second, response.replace('DONE', 'BLOCKED')).retryable, true);
  assert.throws(() => beginTask(root, third, { ...retryConfig(3), parentState: state }), /lineage|parent/);
  beginTask(root, third, retryConfig(3)); put(config.report, 'Prerequisite resolved.');
  assert.equal(recordTaskResult(root, third, response).accepted, true);
  assert.throws(() => beginTask(root, fourth, retryConfig(4)), /retry/);
  beginTask(root, fourth, { ...retryConfig(4), role: 'fix' }); put(config.report, 'Review fix.');
  recordTaskResult(root, fourth, response);
  projectTaskResults(root, { indexPath, states: [fourth] });
  assert.equal(verifyTaskResults(root, { indexPath }).executions.length, 4);
}));

test('failed fix can retry while retaining discovery until DONE_WITH_CONCERNS', () => fixture(({ root, put }) => {
  const discovered = response.replace('DONE', 'DONE_WITH_CONCERNS').replace('tdd:red-green', 'discovery:unplanned');
  beginTask(root, state, config); put(config.report, 'discovery:unplanned initial finding');
  recordTaskResult(root, state, discovered);
  const fix = `${dir}/task-1-execution-2`, retry = `${dir}/task-1-execution-3`;
  beginTask(root, fix, { ...retryConfig(), role: 'fix' }); put('partial-fix', 'partial'); put(config.report, 'discovery:unplanned needs context');
  const blocked = recordTaskResult(root, fix, discovered.replace('DONE_WITH_CONCERNS', 'NEEDS_CONTEXT'));
  assert.equal(blocked.retryable, true); assert.deepEqual(blocked.signals, ['discovery:unplanned']);
  beginTask(root, retry, retryConfig(3)); put('final-fix', 'resolved'); put(config.report, 'discovery:unplanned resolved with concerns');
  const done = recordTaskResult(root, retry, discovered);
  assert.equal(done.accepted, true); assert.deepEqual(done.changedPaths, ['final-fix', 'partial-fix']);
  projectTaskResults(root, { indexPath, states: [retry] });
  assert.deepEqual(verifyTaskResults(root, { indexPath }).entries[0].signals, ['discovery:unplanned']);
}));

for (const invalid of ['malformed', 'unknown-status', 'wrong-artifact', 'bad-signals', 'missing-report', 'empty-report', 'baseline-only', 'capture-only', 'source-drift', 'report-drift', 'frozen-report-drift']) {
  test(`explicit retry refuses ${invalid} evidence`, () => fixture(({ root, put }) => {
    beginTask(root, state, config);
    if (invalid !== 'missing-report') put(config.report, invalid === 'empty-report' ? ' \n' : 'Needs context.');
    if (invalid !== 'baseline-only') {
      let raw = response.replace('DONE', 'NEEDS_CONTEXT');
      if (invalid === 'malformed') raw += '\nunknown: value';
      if (invalid === 'unknown-status') raw = raw.replace('NEEDS_CONTEXT', 'UNKNOWN');
      if (invalid === 'wrong-artifact') raw = raw.replace(config.report, `${dir}/other.md`);
      if (invalid === 'bad-signals') raw = raw.replace('tdd:red-green', 'bad signal');
      recordTaskResult(root, state, raw);
    }
    if (invalid === 'capture-only') rmSync(join(root, `${state}-result.json`));
    if (invalid === 'source-drift') put('source', 'unattributed edit');
    if (invalid === 'report-drift') put(config.report, 'changed report');
    if (invalid === 'frozen-report-drift') put(`${state}-report.md`, 'changed frozen report');
    if (!['source-drift', 'report-drift', 'frozen-report-drift'].includes(invalid)) assert.equal(inspectTaskResult(root, state).retryable, false);
    assert.throws(() => beginTask(root, `${dir}/task-1-execution-2`, retryConfig()), /retry|drift|digest/);
    assert.throws(() => readFileSync(join(root, `${dir}/task-1-execution-2-baseline.json`)), /ENOENT/);
  }));
}

for (const stage of ['report.md', 'result.json']) test(`process interruption before ${stage} publication resumes the durable capture`, () => fixture(({ root, put }) => {
  beginTask(root, state, config); put(config.report, 'durable report');
  const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const paths=new Map(), open=fs.openSync, write=fs.writeSync, writeFile=fs.writeFileSync;
    fs.openSync=(path,...args)=>{const fd=open(path,...args);paths.set(fd,String(path));return fd;};
    const crash=(fd)=>{if(paths.get(fd)?.includes(${JSON.stringify(`${state.split('/').at(-1)}-${stage}`)}))process.exit(86);};
    fs.writeSync=(fd,...args)=>{crash(fd);return write(fd,...args);};
    fs.writeFileSync=(fd,...args)=>{crash(fd);return writeFile(fd,...args);};
    syncBuiltinESMExports();
    const {recordTaskResult}=await import(${JSON.stringify(new URL('../scripts/task-results.mjs', import.meta.url).href)});
    recordTaskResult(${JSON.stringify(root)},${JSON.stringify(state)},${JSON.stringify(response)});`;
  const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(crashed.status, 86, crashed.stderr);
  const resumed = spawnSync(process.execPath, [new URL('../scripts/task-results.mjs', import.meta.url).pathname,
    '--repo-root', root, '--action', 'resume', '--state', state], { encoding: 'utf8' });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).accepted, true);
  assert.equal(inspectTaskResult(root, state).accepted, true);
}));

test('receipt creation, baseline-only resume, exact replay and projection bind real observed paths', () => fixture(({ root, put }) => {
  assert.equal(beginTask(root, state, config).resume, false);
  assert.equal(beginTask(root, state, config).resume, true);
  assert.equal(inspectTaskResult(root, state).status, 'PENDING');
  const route = 'apps/web/app/admin/(protected)/issues/[id]/page.test.tsx'; put(route, 'test'); put(config.report, 'report');
  const result = recordTaskResult(root, state, `${response}\nchanged-paths: bogus/{a,b}; path`);
  assert.deepEqual(result.changedPaths, [route]);
  assert.deepEqual(recordTaskResult(root, state, `${response}\nchanged-paths: bogus/{a,b}; path`), result);
  projectTaskResults(root, { indexPath, states: [state] });
  const index = readFileSync(join(root, indexPath), 'utf8');
  assert.match(index, /Reviewer gate Task 1: retained/);
  assert.deepEqual(parseTaskResultProjection(index)[0].changedPaths, [route]);
  assert.equal(verifyTaskResults(root, { indexPath, expectedTasks: ['1'] }).entries.length, 1);
  put(route, 'drift'); assert.throws(() => inspectTaskResult(root, state), /source.*drift/);
}));

test('projection marker words inside a literal source filename remain data', () => fixture(({ root, put }) => {
  beginTask(root, state, config); put('docs/steepy-task-results.md', 'example'); put(config.report, 'report');
  recordTaskResult(root, state, response);
  projectTaskResults(root, { indexPath, states: [state] });
  assert.deepEqual(verifyTaskResults(root, { indexPath }).entries[0].changedPaths, ['docs/steepy-task-results.md']);
}));

test('fixes freeze reports and keep cumulative task paths across sequential executions', () => fixture(({ root, put }) => {
  beginTask(root, state, config); put('first', 'one'); put(config.report, 'first report'); recordTaskResult(root, state, response);
  const fixState = `${dir}/task-1-execution-2`;
  beginTask(root, fixState, { ...config, execution: 2, role: 'fix', previousState: state });
  put('second', 'two'); put(config.report, 'second report');
  assert.deepEqual(recordTaskResult(root, fixState, response).changedPaths, ['first', 'second']);
  assert.deepEqual(inspectTaskResult(root, state, { checkCurrent: false }).changedPaths, ['first']);
  projectTaskResults(root, { indexPath, states: [fixState] });
  assert.equal(verifyTaskResults(root, { indexPath, expectedTasks: ['1'] }).entries[0].receipt, fixState);
  put(`${state}-report.md`, 'tampered'); assert.throws(() => verifyTaskResults(root, { indexPath, expectedTasks: ['1'] }), /report|digest/);
}));

test('malformed projections, semantic contradictions, changed plan and report tampering fail closed', () => fixture(({ root, put }) => {
  assert.equal(parseTaskResultProjection('- Task 1: DONE'), null);
  assert.throws(() => parseTaskResultProjection('<!-- steepy-task-results: v2 -->\ninvalid'), /projection/);
  beginTask(root, state, config); put(config.report, 'discovery:unplanned');
  const rejected = recordTaskResult(root, state, response);
  assert.equal(rejected.status, 'BLOCKED'); assert.match(rejected.reason, /discovery/);
  assert.equal(JSON.parse(readFileSync(join(root, `${state}-result.json`))).response, response);
  assert.throws(() => recordTaskResult(root, state, response + '\n'), /response|replay/);
  put(config.planPath, 'changed'); assert.throws(() => inspectTaskResult(root, state), /plan/);
}));

test('global lineage handles a late Task 1 fix without attributing Task 2 changes to Task 1', () => fixture(({ root, put }) => {
  beginTask(root, state, config); put('first', 'one'); put(config.report, 'first'); recordTaskResult(root, state, response);
  const second = `${dir}/task-2-execution-1`;
  const secondConfig = { ...config, task: '2', report: `${dir}/task-2-report.md`, parentState: state };
  beginTask(root, second, secondConfig); put('unrelated', 'two'); put(secondConfig.report, 'second');
  recordTaskResult(root, second, response.replace(config.report, secondConfig.report));
  const fix = `${dir}/task-1-execution-2`;
  beginTask(root, fix, { ...config, execution: 2, role: 'fix', previousState: state, parentState: second });
  put('fix', 'three'); put(config.report, 'fixed');
  const result = recordTaskResult(root, fix, response);
  assert.deepEqual(result.changedPaths, ['first', 'fix']); assert.deepEqual(result.executionChangedPaths, ['fix']);
  assert.equal(result.sequence, 3);
  projectTaskResults(root, { indexPath, states: [fix, second] });
  assert.equal(verifyTaskResults(root, { indexPath, expectedTasks: ['1', '2'] }).proofs[0].sequence, 3);
  const firstStat = statSync(join(root, indexPath));
  assert.equal(projectTaskResults(root, { indexPath, states: [second, fix] }).changed, false);
  assert.equal(statSync(join(root, indexPath)).mtimeMs, firstStat.mtimeMs);
}));

test('interrupted capture resumes in another CLI process, while baseline-only never invents completion', () => fixture(({ root, put }) => {
  const cli = (...args) => spawnSync(process.execPath, ['scripts/task-results.mjs', '--repo-root', root, ...args], { encoding: 'utf8', input: response });
  beginTask(root, state, config); put('source', 'changed'); put(config.report, 'report');
  assert.equal(cli('--action', 'inspect', '--state', state).status, 0);
  const completed = recordTaskResult(root, state, response);
  rmSync(join(root, `${state}-result.json`)); rmSync(join(root, `${state}-report.md`));
  const pending = cli('--action', 'inspect', '--state', state);
  assert.equal(JSON.parse(pending.stdout).status, 'PENDING');
  const resumed = cli('--action', 'resume', '--state', state);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).digest, completed.digest);
  put(config.report, 'drift'); assert.throws(() => recordTaskResult(root, state, response), /report drift/);
}));

test('receipt replay binds source, raw response, closed schemas, generated projection and safe artifacts', () => {
  for (const tamper of ['result', 'capture', 'baseline', 'projection', 'report-link']) fixture(({ root, put }) => {
    beginTask(root, state, config); put(config.report, 'report'); recordTaskResult(root, state, response);
    projectTaskResults(root, { indexPath, states: [state] });
    if (['result', 'capture', 'baseline'].includes(tamper)) {
      const path = `${state}-${tamper}.json`; const value = JSON.parse(readFileSync(join(root, path)));
      value.unknown = true; put(path, JSON.stringify(value));
    } else if (tamper === 'projection') put(indexPath, readFileSync(join(root, indexPath), 'utf8').replace('"changedPaths": []', '"changedPaths": ["invented"]'));
    else { rmSync(join(root, config.report)); symlinkSync(join(root, 'source'), join(root, config.report)); }
    assert.throws(() => verifyTaskResults(root, { indexPath, expectedTasks: ['1'] }), /schema|replay|mismatch|symlink/);
  });
});

test('discovery persists through fixes, JSON semantics work, and only canonical plan lifecycle may change', () => fixture(({ root, put }) => {
  const plan = '<!-- steepy-workflow: v1\nphase: plan\nstatus: READY\nnext: implement\nsource: .apex/work/specs/run.md\nconsumed-by: none\n-->\n# Plan\n';
  put(config.planPath, plan);
  beginTask(root, state, { ...config, format: 'json' }); put(config.report, 'discovery:unplanned details');
  const raw = JSON.stringify({ status: 'DONE_WITH_CONCERNS', artifact: config.report, signals: ['discovery:unplanned'] });
  assert.equal(recordTaskResult(root, state, raw).accepted, true);
  projectTaskResults(root, { indexPath, states: [state] });
  put(config.planPath, plan.replace('status: READY', 'status: CONSUMED').replace('consumed-by: none', `consumed-by: ${indexPath}`));
  assert.equal(verifyTaskResults(root, { indexPath }).entries[0].status, 'DONE_WITH_CONCERNS');
  const fix = `${dir}/task-1-execution-2`;
  beginTask(root, fix, { ...config, execution: 2, role: 'fix', previousState: state }); put(config.report, 'clean');
  assert.equal(recordTaskResult(root, fix, response).accepted, false);
}));

test('versioned projection rejects duplicate, unknown, mixed and malformed blocks', () => fixture(({ root, put }) => {
  beginTask(root, state, config); put(config.report, 'report'); recordTaskResult(root, state, response);
  projectTaskResults(root, { indexPath, states: [state] });
  const good = readFileSync(join(root, indexPath), 'utf8');
  for (const text of [good + good, good.replace('v2 -->', 'v3 -->'), good + '- Task 1: DONE\n', good.replace('"changedPaths": []', '"changedPaths": null')]) {
    assert.throws(() => parseTaskResultProjection(text), /projection/);
  }
}));

test('later conductor attempts may change run ID while same-attempt provenance cannot', () => fixture(({ root, put }) => {
  beginTask(root, state, config); put(config.report, 'report'); recordTaskResult(root, state, response);
  const second = `${dir}/task-2-execution-1`;
  const secondConfig = { ...config, runId: 'resumed-run', task: '2', report: `${dir}/task-2-report.md`, parentState: state };
  assert.throws(() => beginTask(root, second, secondConfig), /correlation/);
  beginTask(root, second, { ...secondConfig, attempt: 2 }); put('task-two', 'two'); put(secondConfig.report, 'second');
  recordTaskResult(root, second, response.replace(config.report, secondConfig.report));
  const fix = `${dir}/task-1-execution-2`;
  beginTask(root, fix, { ...config, runId: 'third-run', attempt: 3, execution: 2, role: 'fix', previousState: state, parentState: second });
  put(config.report, 'fix'); recordTaskResult(root, fix, response);
  projectTaskResults(root, { indexPath, states: [fix, second] });
  assert.equal(verifyTaskResults(root, { indexPath }).proofs[0].config.runId, 'third-run');
}));

test('duplicate JSON keys and escaped aliases persist raw rejection evidence', () => {
  for (const statusKey of ['status', '\\u0073tatus']) fixture(({ root, put }) => {
    beginTask(root, state, { ...config, format: 'json' }); put(config.report, 'report');
    const raw = `{"status":"BLOCKED","${statusKey}":"DONE","artifact":${JSON.stringify(config.report)},"signals":[]}`;
    const rejected = recordTaskResult(root, state, raw);
    assert.equal(rejected.status, 'BLOCKED'); assert.match(rejected.reason, /duplicate JSON/);
    assert.equal(JSON.parse(readFileSync(join(root, `${state}-capture.json`))).response, raw);
  });
});

test('a branch switch blocks recording without rewriting source and a missing report preserves raw rejection', () => {
  fixture(({ root, git, put }) => {
    beginTask(root, state, config); put(config.report, 'report'); git('switch', '-qc', 'other');
    assert.throws(() => recordTaskResult(root, state, response), /branch changed/);
    assert.equal(readFileSync(join(root, 'source'), 'utf8'), 'baseline');
  });
  fixture(({ root }) => {
    beginTask(root, state, config);
    const result = recordTaskResult(root, state, response);
    assert.equal(result.accepted, false); assert.match(result.reason, /missing or empty/);
    assert.equal(JSON.parse(readFileSync(join(root, `${state}-result.json`))).response, response);
  });
});

test('a controller commit after the writer returns and before record stays inside the observed execution', () => fixture(({ root, git, put }) => {
  beginTask(root, state, config);
  put('source', 'implemented'); put('added', 'new file'); put(config.report, 'Implemented with tests.');
  git('add', '-A', '--', '.'); git('commit', '-qm', 'controller commit');
  const done = recordTaskResult(root, state, response);
  assert.equal(done.accepted, true);
  assert.deepEqual(done.changedPaths, ['added', 'source']);
  const next = `${dir}/task-2-execution-1`;
  const second = { ...config, task: '2', report: `${dir}/task-2-report.md`, parentState: state };
  assert.equal(beginTask(root, next, second).status, 'READY', 'the next execution starts from the captured committed state');
}));

test('a commit after record is drift for the next execution, never part of the recorded one', () => fixture(({ root, git, put }) => {
  beginTask(root, state, config);
  put('source', 'implemented'); put(config.report, 'Implemented.');
  recordTaskResult(root, state, response);
  git('add', '-A', '--', '.'); git('commit', '-qm', 'late commit');
  assert.throws(() => inspectTaskResult(root, state), /source snapshot drift/);
  assert.throws(() => beginTask(root, `${dir}/task-2-execution-1`, { ...config, task: '2', report: `${dir}/task-2-report.md`, parentState: state }),
    /parent source or correlation drift/);
}));

test('payload capture is durable independently of semantic success', () => fixture(({ root, put }) => {
  const malformed = `${dir}/task-1-execution-1`;
  beginTask(root, malformed, config); put(config.report, 'Report.');
  const rejected = recordTaskResult(root, malformed, 'status: DONE\nsignals: none');
  assert.deepEqual([rejected.accepted, rejected.retryable, rejected.reason], [false, false, 'invalid task response schema']);
  for (const suffix of ['capture.json', 'report.md', 'result.json']) assert.ok(statSync(join(root, `${malformed}-${suffix}`)).isFile());
  assert.equal(JSON.parse(readFileSync(join(root, `${malformed}-capture.json`))).response, 'status: DONE\nsignals: none');
}));

test('a semantic non-success is captured, retryable, and keeps its own status', () => fixture(({ root, put }) => {
  beginTask(root, state, config); put(config.report, 'Needs the missing context.');
  const pending = recordTaskResult(root, state, response.replace('DONE', 'NEEDS_CONTEXT'));
  assert.deepEqual([pending.status, pending.accepted, pending.retryable], ['NEEDS_CONTEXT', false, true]);
}));

// A legacy source run (phase manifests, task result protocol 2) and a new
// recovery run directory that imports its accepted evidence.
const SOURCE = '.apex/work/tasks/old';
const TARGET = '.apex/work/tasks/new';
const OLD_PLAN = '.apex/work/plans/old.md';
const NEW_PLAN = '.apex/work/plans/new.md';
const sourceManifest = `${SOURCE}/context/phase-implement-attempt-1.json`;
const lifecyclePlan = (spec) => `<!-- steepy-workflow: v1\nphase: plan\nstatus: READY\nnext: implement\nsource: ${spec}\nconsumed-by: none\n-->\n# Plan\n\n## Task 1 — one\n`;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function recovery(fn, { protocol = 2, manifestRunId = 'legacy-run' } = {}) {
  return fixture((repo) => {
    const { root, git, put } = repo;
    put(OLD_PLAN, lifecyclePlan('.apex/work/specs/old.md'));
    const source = `${SOURCE}/task-1-execution-1`;
    const sourceConfig = { runId: 'legacy-run', attempt: 1, task: '1', execution: 1, role: 'implementer', report: `${SOURCE}/task-1-report.md`, planPath: OLD_PLAN };
    beginTask(root, source, sourceConfig);
    put('source', 'task one'); put(sourceConfig.report, 'Task 1 report: RED then GREEN.');
    git('add', '-A', '--', '.'); git('commit', '-qm', 'task 1');
    recordTaskResult(root, source, `status: DONE\nartifact: ${sourceConfig.report}\nsignals: tdd:red-green`);
    put(sourceManifest, `${JSON.stringify({ schemaVersion: 1, runId: manifestRunId, attempt: 1, scope: { phase: 'implement', role: 'implement' },
      contract: protocol === null ? {} : { taskResultProtocol: protocol } })}\n`);
    put(NEW_PLAN, lifecyclePlan('.apex/work/specs/new.md'));
    put(`${TARGET}/recovery-input.json`, '{"declared":"recovery"}\n');
    const manifests = [{ path: sourceManifest, sha256: sha(readFileSync(join(root, sourceManifest))) }];
    const importInput = { runId: 'recovery-run', task: '1', sourceState: source, sourceHead: source, manifests, explainedDelta: [] };
    return fn({ ...repo, source, sourceConfig, manifests, importInput });
  });
}
const importPath = `${TARGET}/task-1-import.json`;
const targetIndex = `${TARGET}/task-result-index.md`;

test('an import receipt binds verified historical evidence, the present observation, and the explained delta', () => recovery(({ root, source, importInput }) => {
  const facts = importTaskResult(root, importPath, importInput);
  assert.equal(facts.kind, 'import');
  assert.equal(facts.digest, sha(readFileSync(join(root, importPath))));
  const receipt = JSON.parse(readFileSync(join(root, importPath), 'utf8'));
  assert.deepEqual(Object.keys(receipt).sort(), ['delta', 'kind', 'observation', 'planDigest', 'planPath', 'recoveryInput', 'runId', 'source', 'task', 'version']);
  assert.equal(receipt.source.state, source);
  assert.deepEqual(receipt.delta, []);
  assert.equal(Object.hasOwn(receipt, 'response'), false, 'an import never serializes a writer response');
  assert.equal(Object.hasOwn(receipt, 'status'), false, 'an import never claims a completion status');
  assert.deepEqual(importTaskResult(root, importPath, importInput), facts, 'an identical import is an exact replay');
  assert.equal(inspectTaskImport(root, importPath).digest, facts.digest);
  projectTaskResults(root, { indexPath: targetIndex, states: [], imports: [importPath], protocol: 3 });
  const index = readFileSync(join(root, targetIndex), 'utf8');
  assert.match(index, /^<!-- steepy-task-results: v3 -->$/m);
  assert.deepEqual(parseTaskResultProjection(index), [{ task: '1', kind: 'import', status: 'IMPORTED', artifact: `${source}-report.md`,
    changedPaths: ['source'], signals: ['tdd:red-green'], receipt: importPath }]);
  const verified = verifyTaskResults(root, { indexPath: targetIndex, expectedTasks: ['1'], protocol: 3 });
  assert.deepEqual(verified.imports.map(({ receipt: path }) => path), [importPath]);
  assert.deepEqual(verified.executions, []);
  assert.throws(() => verifyTaskResults(root, { indexPath: targetIndex, protocol: 2 }), /task result index protocol 3 does not match required protocol 2/);
}));

test('an unexplained delta requires reconciliation and writes no import', () => recovery(({ root, git, put, importInput }) => {
  put('source', 'edited after the source run'); git('commit', '-qam', 'later edit');
  assert.throws(() => importTaskResult(root, importPath, importInput), /unexplained source delta requires reconciliation: source/);
  assert.throws(() => readFileSync(join(root, importPath)), /ENOENT/);
  const facts = importTaskResult(root, importPath, { ...importInput, explainedDelta: ['source'] });
  assert.deepEqual(facts.delta, ['source']);
}));

const tamperResult = ({ root, put, source }) => {
  const value = JSON.parse(readFileSync(join(root, `${source}-result.json`), 'utf8'));
  value.signals = ['invented'];
  put(`${source}-result.json`, `${JSON.stringify(value)}\n`);
};
const insideTarget = (input) => ({ ...input, sourceState: `${TARGET}/task-1-execution-1`, sourceHead: `${TARGET}/task-1-execution-1` });
for (const [label, options, mutate, reason, adjust = (input) => input] of [
  ['a drifted source receipt', {}, tamperResult, /task result replay mismatch/],
  ['a drifted declared manifest', {}, ({ put }) => put(sourceManifest, '{}\n'), /source manifest digest mismatch/],
  ['a manifest from another run', { manifestRunId: 'foreign-run' }, () => {}, /source attempt 1 manifest does not bind run legacy-run/],
  ['a protocol 1 source', { protocol: 1 }, () => {}, /source attempt 1 is not task result protocol 2; refusing implicit conversion/],
  ['a source without a task result protocol', { protocol: null }, () => {}, /source attempt 1 is not task result protocol 2; refusing implicit conversion/],
  ['a source state inside the recovery run', {}, () => {}, /import source must belong to another run/, insideTarget],
]) {
  test(`an import refuses ${label}`, () => recovery((repo) => {
    mutate(repo);
    assert.throws(() => importTaskResult(repo.root, importPath, adjust(repo.importInput)), reason);
    assert.throws(() => readFileSync(join(repo.root, importPath)), /ENOENT/);
  }, options));
}

test('a v2 index never carries an import and the selected protocol is never converted', () => recovery(({ root, importInput }) => {
  importTaskResult(root, importPath, importInput);
  assert.throws(() => projectTaskResults(root, { indexPath: targetIndex, states: [], imports: [importPath] }), /imports require task result index protocol 3/);
  projectTaskResults(root, { indexPath: targetIndex, states: [], imports: [importPath], protocol: 3 });
  const v3 = readFileSync(join(root, targetIndex), 'utf8');
  assert.throws(() => projectTaskResults(root, { indexPath: targetIndex, states: [] }), /task result index protocol 3 does not match required protocol 2/);
  writeFileSync(join(root, targetIndex), v3.replace('v3 -->', 'v2 -->'));
  assert.throws(() => verifyTaskResults(root, { indexPath: targetIndex }), /projection/);
}));

test('a fix after an import is a real execution linked to the import digest', () => recovery(({ root, put, importInput }) => {
  const imported = importTaskResult(root, importPath, importInput);
  const fix = `${TARGET}/task-1-execution-2`;
  const fixConfig = { runId: 'recovery-run', attempt: 1, task: '1', execution: 2, role: 'fix', report: `${TARGET}/task-1-report.md`, planPath: NEW_PLAN, previousImport: importPath };
  assert.throws(() => beginTask(root, fix, { ...fixConfig, role: 'implementer' }), /import lineage/);
  assert.throws(() => beginTask(root, `${TARGET}/task-1-execution-1`, { ...fixConfig, execution: 1 }), /import lineage/);
  assert.throws(() => beginTask(root, fix, { ...fixConfig, previousImport: `${TARGET}/task-2-import.json` }), /import lineage/);
  beginTask(root, fix, fixConfig);
  const baseline = JSON.parse(readFileSync(join(root, `${fix}-baseline.json`), 'utf8'));
  assert.equal(baseline.version, 3);
  assert.equal(baseline.previousDigest, imported.digest);
  assert.deepEqual(baseline.taskBefore, imported.taskBefore);
  put('fixed', 'fix'); put(fixConfig.report, 'Fix report: RED then GREEN.');
  const done = recordTaskResult(root, fix, `status: DONE\nartifact: ${fixConfig.report}\nsignals: tdd:red-green`);
  assert.equal(done.accepted, true);
  assert.deepEqual(done.changedPaths, ['fixed', 'source'], 'cumulative task paths continue from the imported evidence');
  assert.deepEqual(done.executionChangedPaths, ['fixed']);
  projectTaskResults(root, { indexPath: targetIndex, states: [fix], imports: [], protocol: 3 });
  const verified = verifyTaskResults(root, { indexPath: targetIndex, expectedTasks: ['1'], protocol: 3 });
  assert.deepEqual(verified.entries.map(({ kind, receipt }) => [kind, receipt]), [['execution', fix]]);
  assert.deepEqual(verified.imports.map(({ receipt }) => receipt), [importPath], 'the import ancestor is verified with the execution');
  const tampered = JSON.parse(readFileSync(join(root, importPath), 'utf8'));
  tampered.delta = ['invented'];
  writeFileSync(join(root, importPath), `${JSON.stringify(tampered)}\n`);
  assert.throws(() => verifyTaskResults(root, { indexPath: targetIndex, protocol: 3 }), /import/);
}));

test('a residual task after an import starts from the import observation', () => recovery(({ root, put, importInput }) => {
  importTaskResult(root, importPath, importInput);
  const second = `${TARGET}/task-2-execution-1`;
  const secondConfig = { runId: 'recovery-run', attempt: 1, task: '2', execution: 1, role: 'implementer', report: `${TARGET}/task-2-report.md`, planPath: NEW_PLAN };
  beginTask(root, second, secondConfig);
  put('second', 'two'); put(secondConfig.report, 'Task 2 report.');
  recordTaskResult(root, second, `status: DONE\nartifact: ${secondConfig.report}\nsignals: none`);
  projectTaskResults(root, { indexPath: targetIndex, states: [second], imports: [importPath], protocol: 3 });
  const verified = verifyTaskResults(root, { indexPath: targetIndex, expectedTasks: ['1', '2'], protocol: 3 });
  assert.deepEqual(verified.entries.map(({ task, kind }) => [task, kind]), [['1', 'import'], ['2', 'execution']]);
  assert.throws(() => projectTaskResults(root, { indexPath: targetIndex, states: [second], imports: [importPath, importPath], protocol: 3 }), /states/);
}));

test('a fix after an import refuses source drift since the import observation', () => recovery(({ root, git, put, importInput }) => {
  importTaskResult(root, importPath, importInput);
  put('source', 'edited after the import'); git('commit', '-qam', 'unrecorded edit');
  const fix = `${TARGET}/task-1-execution-2`;
  assert.throws(() => beginTask(root, fix, { runId: 'recovery-run', attempt: 1, task: '1', execution: 2, role: 'fix',
    report: `${TARGET}/task-1-report.md`, planPath: NEW_PLAN, previousImport: importPath }), /task import source drift/);
  assert.throws(() => inspectTaskImport(root, importPath, { checkCurrent: true }), /task import source snapshot drift/);
  assert.throws(() => beginTask(root, fix, { runId: 'other-run', attempt: 1, task: '1', execution: 2, role: 'fix',
    report: `${TARGET}/task-1-report.md`, planPath: NEW_PLAN, previousImport: importPath }), /task import lineage mismatch/);
}));

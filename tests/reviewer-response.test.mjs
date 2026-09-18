import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { beginReview, checkReview, reserveRepair, inspectReview, parseReviewerResponse, verifyImplementReviews, captureRetainedApproval, setReviewReference } from '../scripts/reviewer-response.mjs';

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'steepy-reviewer-response-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  const dir = '.apex/work/tasks/topic';
  const report = `${dir}/task-4-review.md`, issues = `${dir}/task-4-issues.md`;
  const state = `${dir}/task-4-review-guard-attempt-3-iteration-2`;
  const put = (path, text) => writeFileSync(join(root, path), text);
  try {
    git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
    put('.gitignore', '.apex/work/\n'); put('code.js', 'implemented then fixed\n');
    git('add', '.'); git('commit', '-m', 'fix');
    mkdirSync(join(root, dir), { recursive: true });
    put(`${dir}/ledger.md`, 'Task 1: complete\nTask 2: complete\nTask 3: complete\n');
    put(`${dir}/phase-2-attempt-2.log`, 'previous attempt\n');
    put(issues, 'Status: Issues Found\nOrder incorrect; test order.\n');
    const config = { runId: 'test-run', attempt: 3, iteration: 2, task: '4', report, issues };
    const envelope = (paths = 'none') => `status: APPROVED\nartifact: ${report}\nchanged-paths: ${paths}\nsignals: review:clean\n`;
    fn({ root, state, config, put, report, issues, dir, envelope, git });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const removed of ['src', 'src/legacy']) {
  test(`review accepts an unstaged deletion of ${removed} and detects restoration`, () => fixture(({ root, state, config, put, report, envelope, git }) => {
    mkdirSync(join(root, 'src/legacy'), { recursive: true });
    put('src/legacy/parser.js', 'original\n');
    git('add', 'src'); git('commit', '-m', 'add legacy module');
    rmSync(join(root, removed), { recursive: true });

    beginReview(root, state, config);
    put(report, 'Approved deletion.\n');
    assert.equal(checkReview(root, state, envelope()).accepted, true);
    assert.equal(inspectReview(root, state).accepted, true);

    mkdirSync(join(root, 'src/legacy'), { recursive: true });
    put('src/legacy/parser.js', 'original\n');
    assert.equal(inspectReview(root, state).status, 'BLOCKED');
  }));
}

for (const replacement of ['symlink', 'dangling-symlink', 'file']) {
  test(`review refuses a source ancestor replaced by a ${replacement}`, () => fixture(({ root, state, config, put, git }) => {
    mkdirSync(join(root, 'src/legacy'), { recursive: true });
    put('src/legacy/parser.js', 'original\n');
    git('add', 'src'); git('commit', '-m', 'add legacy module');
    rmSync(join(root, 'src/legacy'), { recursive: true });
    if (replacement === 'file') put('src/legacy', 'not a directory\n');
    else symlinkSync(replacement === 'symlink' ? '..' : '../missing', join(root, 'src/legacy'));

    assert.throws(() => beginReview(root, state, config), /unsafe source ancestor/);
    assert.throws(() => readFileSync(join(root, `${state}-baseline.json`)), /ENOENT/);
  }));
}

test('issues → fixed implementation → Approved with malformed response → one correction → accepted; prior progress is preserved', () => fixture(({ root, state, config, put, report, issues, dir, envelope, git }) => {
  const firstState = state.replace('iteration-2', 'iteration-1');
  put('code.js', 'initial implementation with wrong order\n');
  git('add', 'code.js'); git('commit', '-m', 'implementation');
  beginReview(root, firstState, { ...config, iteration: 1 });
  put(report, 'Status: Issues Found\nOrder incorrect; test order.\n');
  const findings = `status: ISSUES_FOUND\nartifact: ${issues}\nchanged-paths: none\nsignals: review:critical\n`;
  assert.equal(checkReview(root, firstState, findings).status, 'ISSUES_FOUND');
  put('code.js', 'implemented then fixed\n');
  git('add', 'code.js'); git('commit', '-m', 'fix order and regression checks');
  beginReview(root, state, config);
  put(report, 'Status: Approved\nOrder tests passed\n');
  const first = checkReview(root, state, envelope(report));
  assert.equal(first.status, 'REPAIRABLE');
  assert.equal(first.accepted, false);
  reserveRepair(root, state);
  assert.throws(() => reserveRepair(root, state), /already exists/);
  assert.equal(checkReview(root, state, envelope(), true).status, 'APPROVED');
  assert.equal(inspectReview(root, state).accepted, true);
  assert.equal(readFileSync(join(root, 'code.js'), 'utf8'), 'implemented then fixed\n');
  assert.equal(readFileSync(join(root, dir, 'ledger.md'), 'utf8'), 'Task 1: complete\nTask 2: complete\nTask 3: complete\n');
  assert.equal(readFileSync(join(root, dir, 'phase-2-attempt-2.log'), 'utf8'), 'previous attempt\n');
  assert.throws(() => beginReview(root, state, config), /already exists/);
}));

test('Approved report alone and a second malformed response never complete a task', () => fixture(({ root, state, config, put, report, envelope }) => {
  beginReview(root, state, config); put(report, 'Status: Approved\n');
  assert.equal(checkReview(root, state, envelope(report)).accepted, false);
  reserveRepair(root, state);
  assert.equal(checkReview(root, state, envelope(report), true).status, 'BLOCKED');
  assert.throws(() => reserveRepair(root, state), /already exists/);
}));

for (const mutation of ['tracked', 'untracked', 'index', 'head', 'report']) {
  test(`unauthorized ${mutation} mutation blocks even a valid correction`, () => fixture(({ root, state, config, put, report, envelope, git }) => {
    beginReview(root, state, config); put(report, 'Status: Approved\n');
    checkReview(root, state, envelope(report)); reserveRepair(root, state);
    if (mutation === 'tracked') put('code.js', 'unauthorized\n');
    if (mutation === 'untracked') put('extra.js', 'unauthorized\n');
    if (mutation === 'index') { put('code.js', 'staged\n'); git('add', 'code.js'); put('code.js', 'implemented then fixed\n'); }
    if (mutation === 'head') git('commit', '--allow-empty', '-m', 'unauthorized');
    if (mutation === 'report') put(report, 'Status: Approved\nrewritten\n');
    assert.equal(checkReview(root, state, envelope(), true).status, 'BLOCKED');
  }));
}

test('original review code edits block without offering repair', () => fixture(({ root, state, config, put, report, envelope }) => {
  beginReview(root, state, config); put(report, 'Status: Approved\n'); put('code.js', 'unauthorized');
  assert.equal(checkReview(root, state, envelope(report)).status, 'BLOCKED');
  assert.throws(() => reserveRepair(root, state), /not repairable/);
}));

test('crash after reservation consumes the retry and retained original bytes never change', () => fixture(({ root, state, config, put, report, envelope }) => {
  beginReview(root, state, config); put(report, 'Status: Approved\n');
  checkReview(root, state, envelope(report));
  const bytes = readFileSync(join(root, `${state}-original.json`));
  assert.equal(inspectReview(root, state).status, 'REPAIRABLE');
  reserveRepair(root, state);
  assert.equal(inspectReview(root, state).status, 'BLOCKED');
  assert.throws(() => reserveRepair(root, state), /already exists/);
  assert.deepEqual(readFileSync(join(root, `${state}-original.json`)), bytes);
}));

test('response-only correction cannot promote an issues verdict', () => fixture(({ root, state, config, put, report, issues, envelope }) => {
  beginReview(root, state, config); put(report, 'Status: Approved\n');
  checkReview(root, state, `status: ISSUES_FOUND\nartifact: ${issues}\nchanged-paths: ${report}\nsignals: review:critical\n`);
  reserveRepair(root, state);
  assert.equal(checkReview(root, state, envelope(), true).status, 'BLOCKED');
}));

test('strict parser rejects wrong fields, paths, status, and extra prose', () => fixture(({ config, envelope }) => {
  for (const text of [envelope() + 'extra', envelope().replace('APPROVED', 'DONE'), envelope().replace(config.report, '../report.md'), envelope().replace('signals:', 'other:'), envelope().replace('none', config.report)]) {
    assert.throws(() => parseReviewerResponse(text, config));
  }
}));

test('real CLI accepts stdin and resumes accepted evidence in a new process', () => fixture(({ root, state, config, put, report, envelope }) => {
  const script = new URL('../scripts/reviewer-response.mjs', import.meta.url).pathname;
  const call = (action, args = [], input = '') => JSON.parse(execFileSync(process.execPath, [script, '--repo-root', root, '--state', state, '--action', action, ...args], { input, encoding: 'utf8' }));
  call('begin', ['--run-id', config.runId, '--attempt', '3', '--iteration', '2', '--task', '4', '--report', report, '--issues', config.issues]);
  put(report, 'Status: Approved\n');
  assert.equal(call('check', [], envelope(report)).status, 'REPAIRABLE');
  call('reserve');
  assert.equal(call('correct', [], envelope()).accepted, true);
  assert.equal(call('inspect').accepted, true);
}));

test('whole-branch reviewer uses the same bounded gate and exact final issue binding', () => fixture(({ root, state, config, put, dir }) => {
  const finalState = state.replace('task-4-', 'final-');
  const finalConfig = { ...config, task: 'final', report: `${dir}/final-review.md`, issues: `${dir}/final-review-issues.md` };
  beginReview(root, finalState, finalConfig);
  put(finalConfig.report, 'Status: Approved\n');
  const response = `status: APPROVED\nartifact: ${finalConfig.report}\nchanged-paths: none\nsignals: review:clean\n`;
  assert.equal(checkReview(root, finalState, response).accepted, true);
  put('code.js', 'later drift');
  assert.equal(inspectReview(root, finalState).status, 'BLOCKED');
}));

test('missing report cannot authorize completion; Markdown is not parsed for verdicts', () => fixture(({ root, state, config, put, report, envelope }) => {
  beginReview(root, state, config);
  assert.equal(checkReview(root, state, envelope()).status, 'BLOCKED');
  const next = state.replace('iteration-2', 'iteration-3');
  beginReview(root, next, { ...config, iteration: 3 });
  put(report, 'Status: Issues Found\n');
  assert.equal(checkReview(root, next, envelope()).status, 'APPROVED');
}));

test('missing run correlation cannot create a baseline', () => fixture(({ root, state, config }) => {
  assert.throws(() => beginReview(root, state, { ...config, runId: undefined }), /invalid review correlation/);
  assert.throws(() => readFileSync(join(root, `${state}-baseline.json`)), /ENOENT/);
}));

for (const invalid of ['empty', 'unknown-status', 'wrong-artifact', 'extra-field']) {
  test(`ambiguous ${invalid} response blocks without spending a recovery`, () => fixture(({ root, state, config, put, report, envelope }) => {
    beginReview(root, state, config); put(report, '# Review\nAll checks passed.\n');
    const text = { empty: '', 'unknown-status': envelope(report).replace('APPROVED', 'UNKNOWN'), 'wrong-artifact': envelope(report).replace(`artifact: ${report}`, 'artifact: wrong.md'), 'extra-field': envelope(report) + 'extra: ignored\n' }[invalid];
    assert.equal(checkReview(root, state, text).status, 'BLOCKED');
    assert.throws(() => reserveRepair(root, state), /not repairable/);
  }));
}

test('resume rejects edited envelope, acceptance flag, schema version, and correlation', () => fixture(({ root, state, config, put, report, envelope }) => {
  beginReview(root, state, config); put(report, '# Review\nApproved; checks passed.\n');
  assert.equal(checkReview(root, state, envelope()).accepted, true);
  const path = `${state}-original.json`;
  const original = readFileSync(join(root, path), 'utf8');
  for (const mutate of [
    (value) => { value.response = envelope(report); },
    (value) => { value.accepted = false; },
    (value) => { value.version = 999; },
    (value) => { value.config.runId = 'another-run'; },
    (value) => { value.extra = true; },
  ]) {
    const value = JSON.parse(original); mutate(value); put(path, JSON.stringify(value));
    assert.throws(() => inspectReview(root, state), /invalid|mismatch|correlation|evidence/);
  }
}));

test('Markdown layout is not a second verdict protocol', () => fixture(({ root, state, config, put, report, envelope }) => {
  beginReview(root, state, config); put(report, '## Verdict\n**Approved**\nTests passed.\n');
  assert.equal(checkReview(root, state, envelope()).accepted, true);
}));

test('JSON transport applies the same schema and bounded recovery without coercing changed paths', () => fixture(({ root, state, config, put, report }) => {
  beginReview(root, state, { ...config, format: 'json' });
  put(report, '## Verdict\n**Approved**\n');
  const invalid = { status: 'APPROVED', artifact: report, 'changed-paths': report, signals: 'review:clean' };
  assert.equal(checkReview(root, state, JSON.stringify(invalid)).status, 'REPAIRABLE');
  reserveRepair(root, state);
  assert.equal(checkReview(root, state, JSON.stringify({ ...invalid, 'changed-paths': 'none' }), true).accepted, true);
  assert.equal(inspectReview(root, state).accepted, true);
}));

for (const stage of ['baseline', 'reserved', 'corrected']) {
  test(`resume refuses corrupted ${stage} evidence`, () => fixture(({ root, state, config, put, report, envelope }) => {
    beginReview(root, state, config); put(report, 'Approved.\n');
    checkReview(root, state, envelope(report)); reserveRepair(root, state); checkReview(root, state, envelope(), true);
    const path = `${state}-${stage}.json`;
    const record = JSON.parse(readFileSync(join(root, path), 'utf8'));
    if (stage === 'baseline') record.config.runId = 'wrong-run';
    if (stage === 'reserved') record.budget = 2;
    if (stage === 'corrected') record.envelope.artifact = config.issues;
    put(path, JSON.stringify(record));
    assert.throws(() => inspectReview(root, state), /invalid|mismatch|correlation|evidence/);
  }));
}

function handoffFixture(fn) {
  fixture((ctx) => {
    const { root, dir, config, state, put, report, envelope } = ctx;
    mkdirSync(join(root, '.apex/work/plans'), { recursive: true });
    mkdirSync(join(root, dir, 'context'), { recursive: true });
    const planPath = '.apex/work/plans/topic.md', indexPath = `${dir}/task-result-index.md`;
    const plan = '<!-- steepy-workflow: v1\nphase: plan\nstatus: READY\nnext: implement\nsource: .apex/work/specs/topic.md\nconsumed-by: none\n-->\n# Plan\n\n## Task 4\n- **Surface:** scripts\n- **Complexity:** integration\n- **Success criteria:** SC1\n- **Requirements and deliverables:** Preserve ordering.\n- **Exact paths:** code.js\n- **Dependencies:** Task 3\n\n## Constraints\nNever drop data.\n';
    put(planPath, plan);
    put(`${dir}/context/phase-implement-attempt-3.json`, JSON.stringify({ runId: config.runId, attempt: 3, scope: { phase: 'implement', role: 'implement' } }));
    beginReview(root, state, config); put(report, 'Approved.\n'); checkReview(root, state, envelope());
    const finalState = `${dir}/final-review-guard-attempt-3-iteration-1`;
    const finalConfig = { ...config, task: 'final', iteration: 1, report: `${dir}/final-review.md`, issues: `${dir}/final-review-issues.md`, plan: planPath, index: indexPath };
    const index = `# Results\n- Task 4: DONE; artifact: ${dir}/task-4-report.md; changed-paths: code.js; signals: none\nReviewer gate Task 4: ${state}\nReviewer gate final: ${finalState}\n`;
    put(indexPath, index);
    const verify = (extra = {}) => verifyImplementReviews(root, { planPath, indexPath, runId: config.runId, attempt: 3, ...extra });
    const approveFinal = () => {
      beginReview(root, finalState, finalConfig); put(finalConfig.report, 'Approved.\n');
      checkReview(root, finalState, `status: APPROVED\nartifact: ${finalConfig.report}\nchanged-paths: none\nsignals: review:clean\n`);
    };
    fn({ ...ctx, planPath, indexPath, plan, index, finalState, finalConfig, verify, approveFinal });
  });
}

for (const [field, before, after] of [
  ['requirements', 'Preserve ordering.', 'Reverse the ordering.'],
  ['paths', '**Exact paths:** code.js', '**Exact paths:** other.js'],
  ['dependencies', '**Dependencies:** Task 3', '**Dependencies:** none'],
  ['constraints', 'Never drop data.', 'Drop old data.'],
  ['source', 'source: .apex/work/specs/topic.md', 'source: .apex/work/specs/other.md'],
]) {
  test(`full plan binding invalidates approval after changing ${field}`, () => handoffFixture(({ approveFinal, verify, put, planPath, plan }) => {
    approveFinal(); assert.equal(verify().status, 'APPROVED');
    put(planPath, plan.replace(before, after));
    assert.throws(() => verify(), /handoff.*changed|handoff.*mismatch/);
  }));
}

test('plan READY → CONSUMED lifecycle is allowed only with the bound result index', () => handoffFixture(({ approveFinal, verify, put, planPath, indexPath, plan }) => {
  approveFinal();
  put(planPath, plan.replace('status: READY', 'status: CONSUMED').replace('consumed-by: none', `consumed-by: ${indexPath}`));
  assert.equal(verify().status, 'APPROVED');
  put(planPath, plan.replace('status: READY', 'status: CONSUMED').replace('consumed-by: none', 'consumed-by: .apex/work/tasks/other/task-result-index.md'));
  assert.throws(() => verify(), /lifecycle|handoff/);
}));

test('retained final approval requires explicit provenance and unchanged evidence in the next attempt', () => handoffFixture(({ root, dir, put, approveFinal, verify, planPath, indexPath, finalState, finalConfig }) => {
  approveFinal();
  put(`${dir}/context/phase-implement-attempt-4.json`, JSON.stringify({ runId: 'next-run', attempt: 4, scope: { phase: 'implement', role: 'implement' } }));
  const next = { planPath, indexPath, runId: 'next-run', attempt: 4 };
  assert.throws(() => verify(next), /correlation mismatch/);
  const retainedApproval = captureRetainedApproval(root, next);
  assert.equal(retainedApproval.state, finalState);
  assert.equal(verify({ ...next, retainedApproval }).status, 'APPROVED');
  assert.throws(() => verify({ ...next, retainedApproval: { ...retainedApproval, digest: '0'.repeat(64) } }), /correlation mismatch/);
  put(finalConfig.report, 'changed report');
  assert.throws(() => verify({ ...next, retainedApproval }), /not approved|mismatch/);
}));

test('active final reference advances after Issues Found without changing earlier guard evidence', () => handoffFixture(({ root, put, indexPath, finalState, finalConfig, verify }) => {
  beginReview(root, finalState, finalConfig);
  put(finalConfig.report, 'Issues Found.\n'); put(finalConfig.issues, 'Fix branch ordering.\n');
  checkReview(root, finalState, `status: ISSUES_FOUND\nartifact: ${finalConfig.issues}\nchanged-paths: none\nsignals: review:critical\n`);
  const evidence = ['baseline', 'original'].map((stage) => readFileSync(join(root, `${finalState}-${stage}.json`)));
  put('code.js', 'branch ordering fixed\n');
  const next = finalState.replace('iteration-1', 'iteration-2');
  assert.throws(() => setReviewReference(root, { indexPath, state: next }), /refusing overwrite/);
  assert.equal(setReviewReference(root, { indexPath, state: next, previousState: finalState }).changed, true);
  assert.equal(setReviewReference(root, { indexPath, state: next, previousState: finalState }).changed, false);
  assert.equal(readFileSync(join(root, indexPath), 'utf8').match(/^Reviewer gate final:/gm).length, 1);
  beginReview(root, next, { ...finalConfig, iteration: 2 });
  put(finalConfig.report, 'Approved.\n');
  checkReview(root, next, `status: APPROVED\nartifact: ${finalConfig.report}\nchanged-paths: none\nsignals: review:clean\n`);
  assert.equal(verify().status, 'APPROVED');
  ['baseline', 'original'].forEach((stage, i) => assert.deepEqual(readFileSync(join(root, `${finalState}-${stage}.json`)), evidence[i]));
  assert.throws(() => setReviewReference(root, { indexPath, state: finalState, previousState: next }), /must advance/);
}));

test('lifecycle normalization preserves leading verdict metadata and body lifecycle-looking prose', () => handoffFixture(({ approveFinal, verify, put, planPath, indexPath, plan }) => {
  const prefix = '<!-- verdict: Ready | gear: 3\ndrive: autopilot\n-->\n';
  const body = '\nNotes:\nstatus: READY\nconsumed-by: none\n';
  put(planPath, prefix + plan + body); approveFinal();
  const consumed = prefix + plan.replace('status: READY', 'status: CONSUMED').replace('consumed-by: none', `consumed-by: ${indexPath}`) + body;
  put(planPath, consumed); assert.equal(verify().status, 'APPROVED');
  put(planPath, consumed.replace('verdict: Ready', 'verdict: Different'));
  assert.throws(() => verify(), /handoff.*changed/);
  put(planPath, consumed.replace('Notes:\nstatus: READY', 'Notes:\nstatus: CONSUMED'));
  assert.throws(() => verify(), /handoff.*changed/);
}));

test('reference binding creates exactly one reference and preserves CRLF on replacement', () => handoffFixture(({ root, put, indexPath, index, finalState }) => {
  put(indexPath, index.replace(/^Reviewer gate final:.*\n/m, '').replace(/\n/g, '\r\n'));
  assert.equal(setReviewReference(root, { indexPath, state: finalState }).changed, true);
  const next = finalState.replace('iteration-1', 'iteration-2');
  setReviewReference(root, { indexPath, state: next, previousState: finalState });
  const text = readFileSync(join(root, indexPath), 'utf8');
  assert.ok(text.includes(`Reviewer gate final: ${next}\r\n`));
  assert.equal(text.replace(/\r\n/g, '').includes('\n'), false);
}));

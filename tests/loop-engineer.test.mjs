import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  LoopControllerError,
  createCliGitAdapter,
  main,
  parseGoalContract,
  runLoopController,
  runStreamingHeadlessDescriptor,
  validateLoopPreflight,
  validateLoopTerminal,
} from '../scripts/loop-engineer.mjs';
import { readWorkPath, writeWorkPath } from '../scripts/work-paths.mjs';
import { parseWorkflowJsonl, reduceWorkflowJsonl } from '../scripts/workflow-state.mjs';
import { headlessCommand } from '../adapters/headless.mjs';

const GOAL_PATH = '.apex/work/loops/2026-09-03-demo-loop/goal.md';
const LEDGER_PATH = '.apex/work/loops/2026-09-03-demo-loop/ledger.md';
const EVENTS_PATH = '.apex/work/loops/2026-09-03-demo-loop/events.jsonl';
const RUN_ID = '12345678-1234-4234-8234-123456789abc';
const LOCK_TOKEN = '87654321-4321-4321-8321-cba987654321';
const BASELINE = 'a'.repeat(40);
const ROUTING_PATH = '.apex/_INDEX.md';
const SCRIPT_STANDARD = '.apex/standards/scripts.md';

function fixture() {
  return mkdtempSync(join(tmpdir(), 'steepy-loop-controller-'));
}

function writeSingleRoute(repo, {
  surface = 'scripts',
  standardPath = `.apex/standards/${surface}.md`,
  standardText = `# ${surface} standard\n\n## Paths governed\n\n- \`${surface}/\`\n`,
} = {}) {
  const relative = standardPath.replace(/^\.apex\//u, '');
  mkdirSync(join(repo, '.apex', 'standards'), { recursive: true });
  writeFileSync(join(repo, ROUTING_PATH), [
    '# Fixture hub',
    '',
    '## Routing table',
    '',
    '| Surface | Standard | Agent |',
    '|---|---|---|',
    `| \`${surface}\` | [${surface} standard](${relative}) | \`${surface}-agent\` |`,
    '',
  ].join('\n'));
  mkdirSync(dirname(join(repo, standardPath)), { recursive: true });
  writeFileSync(join(repo, standardPath), standardText);
  return Object.freeze({
    routingPath: ROUTING_PATH,
    standardPaths: Object.freeze([standardPath]),
  });
}

function goalText(overrides = {}) {
  const values = {
    goal: 'Make the deterministic verifier green',
    surface: 'scripts',
    verifier: 'node --test tests/example.test.mjs',
    mode: 'boolean',
    budget: '3',
    'blast-radius': 'scripts/**, tests/**',
    notes: 'Do not change public artifact bytes',
    ...overrides,
  };
  const fields = Object.entries(values).map(([key, value]) => `${key}: ${value}`).join('\n');
  return `<!-- verdict: GAP | gear: 4 -->
<!-- steepy-workflow: v1
phase: goal-contract
status: READY
next: loop-engineer
source: none
consumed-by: none
-->
# Demo loop goal

${fields}
`;
}

function dependencies(overrides = {}) {
  const calls = [];
  const routing = typeof overrides.repoRoot === 'string'
    ? writeSingleRoute(overrides.repoRoot)
    : { routingPath: ROUTING_PATH, standardPaths: [SCRIPT_STANDARD] };
  return {
    calls,
    options: {
      repoRoot: undefined,
      harness: 'codex',
      commitAuthorized: true,
      expectedBranch: 'feature/loop',
      ...routing,
      runner: {
        descriptor(harness, prompt, descriptorInput) {
          calls.push(`runner-descriptor:${harness}:${prompt.length > 0}:${descriptorInput.modelTier}`);
          return Object.freeze({
            cmd: harness,
            args: Object.freeze([]),
            protocol: 'jsonl',
            requestedModelTier: descriptorInput.modelTier,
            modelSelection: 'applied',
            resolvedModel: 'fixture-model',
          });
        },
        run() {
          calls.push('runner-run');
          throw new Error('Task 4 must not spawn the model runner');
        },
      },
      reviewer: { run() { calls.push('reviewer-run'); } },
      verifier: {
        run(command) {
          calls.push(`verifier:${command}`);
          return { status: 1, stdout: 'still red\n', stderr: '' };
        },
      },
      git: {
        branch() { calls.push('git-branch'); return 'feature/loop'; },
        status() { calls.push('git-status'); return ''; },
        baseline() { calls.push('git-baseline'); return BASELINE; },
      },
      clock: () => '2026-09-03T12:00:00.000Z',
      uuid() { calls.push('uuid'); return RUN_ID; },
      crashHook(name) { calls.push(`crash:${name}`); },
      processProbe(pid) { calls.push(`process-probe:${pid}`); return false; },
      startOnly: true,
      ...overrides,
    },
  };
}

function executionDependencies({
  repoRoot,
  verifierResults,
  changedPaths = [],
  reviews = ['approved'],
  reviewStatuses = [],
  runnerStatuses = [],
} = {}) {
  const routing = writeSingleRoute(repoRoot);
  const calls = [];
  const commits = [];
  const discards = [];
  const prepared = [];
  let mutation = 0;
  let review = 0;
  let verifier = 0;
  let snapshotVersion = 'stable';
  let activeChangedPaths = [];
  const commitIds = ['b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40), 'e'.repeat(40)];
  const options = {
    repoRoot,
    harness: 'codex',
    commitAuthorized: true,
    expectedBranch: 'feature/loop',
    ...routing,
    runner: {
      descriptor(_harness, prompt, descriptorInput) {
        calls.push({ kind: 'descriptor', prompt, ...descriptorInput });
        return {
          cmd: 'codex', args: [], protocol: 'jsonl',
          requestedModelTier: descriptorInput.modelTier,
          modelSelection: 'applied',
          resolvedModel: 'fixture-model',
        };
      },
      run(_descriptor, context) {
        mutation += 1;
        calls.push({ kind: 'runner', ...context });
        writeWorkPath(repoRoot, context.reportPath, `attempt ${context.attempt} report\n`, {
          family: 'runner-report',
        });
        const status = runnerStatuses[mutation - 1] ?? 'DONE';
        const paths = changedPaths[mutation - 1] ?? ['scripts/example.mjs'];
        snapshotVersion = `attempt-${mutation}`;
        activeChangedPaths = [...paths];
        const output = [
          `status: ${status}`,
          `artifact: ${context.reportPath}`,
          `changed-paths: ${paths.length === 0 ? 'none' : paths.join(', ')}`,
          'signals: none',
        ].join('\n');
        return { status: 0, output: `${output}\n`, raw: `{"attempt":${context.attempt}}\n`, readable: `${output}\n` };
      },
    },
    reviewer: {
      run(prompt, context) {
        review += 1;
        const verdict = reviews[review - 1] ?? 'approved';
        calls.push({ kind: 'reviewer', prompt, ...context, verdict });
        const report = verdict === 'approved'
          ? '## Loop Branch Review\n**Status:** Approved\n'
          : '## Loop Branch Review\n**Status:** Issues Found\n- scripts/example.mjs:1: fix it\n';
        writeWorkPath(repoRoot, context.reportPath, report, { family: 'reviewer-report' });
        return {
          status: 0,
          output: [
            `status: ${reviewStatuses[review - 1] ?? 'DONE'}`,
            `artifact: ${context.reportPath}`,
            'changed-paths: none',
            `signals: ${verdict === 'approved' ? 'approved' : 'issues-found'}`,
          ].join('\n') + '\n',
          raw: `{"review":${review}}\n`,
          readable: report,
        };
      },
    },
    verifier: {
      run(command) {
        calls.push({ kind: 'verifier', command, index: verifier });
        const result = verifierResults[verifier];
        verifier += 1;
        return result;
      },
    },
    git: {
      branch: () => 'feature/loop',
      status: () => '',
      baseline: () => BASELINE,
      head: () => commits.at(-1)?.commit ?? BASELINE,
      snapshot(_root, { excludePaths = [] } = {}) {
        return {
          head: commits.at(-1)?.commit ?? BASELINE,
          indexTree: 'f'.repeat(40),
          trackedDiffDigest: createHash('sha256').update(`tracked:${snapshotVersion}`).digest('hex'),
          untracked: excludePaths.includes('ignored') ? [] : [],
        };
      },
      diff(_root, baseline) {
        calls.push({ kind: 'diff', baseline });
        return { text: `diff from ${baseline}\n`, untracked: [] };
      },
      changedPaths() {
        return [...activeChangedPaths];
      },
      prepareCommit(_root, metadata) {
        const prior = prepared.find((candidate) => (
          JSON.stringify(candidate.metadata) === JSON.stringify(metadata)
        ));
        const preparedCommit = {
          commit: prior?.commit ?? commitIds[new Set(prepared.map(({ commit }) => commit)).size],
          expectedParent: commits.at(-1)?.commit ?? BASELINE,
          metadata,
        };
        prepared.push(preparedCommit);
        return preparedCommit;
      },
      inspectCommit(_root, expectation) {
        const candidate = prepared.find(({ commit }) => commit === expectation.commit);
        return {
          head: commits.at(-1)?.commit ?? BASELINE,
          worktreeClean: true,
          commit: expectation.commit,
          parent: candidate?.expectedParent ?? 'f'.repeat(40),
          runId: candidate?.metadata.runId ?? 'forged-run',
          attempt: candidate?.metadata.attempt ?? 99,
          expectedParent: candidate?.metadata.expectedParent ?? 'f'.repeat(40),
          owner: candidate?.metadata.owner ?? 'forged-owner',
          unique: candidate !== undefined,
          snapshotDigest: candidate === undefined ? null : expectation.snapshotDigest,
        };
      },
      commit(_root, candidate) {
        commits.push(candidate);
        activeChangedPaths = [];
        calls.push({ kind: 'commit', ...candidate });
        return candidate.commit;
      },
      ownsAttempt(_root, ownership) {
        calls.push({ kind: 'owns-attempt', ...ownership });
        return ownership.expectedParent === (commits.at(-1)?.commit ?? BASELINE);
      },
      discard(_root, ownership) {
        discards.push(ownership);
        snapshotVersion = 'stable';
        activeChangedPaths = [];
        calls.push({ kind: 'discard', ...ownership });
        return ownership.expectedParent;
      },
    },
    clock: () => '2026-09-03T12:00:00.000Z',
    uuid: (() => {
      const ids = [RUN_ID, LOCK_TOKEN];
      return () => ids.shift() ?? LOCK_TOKEN;
    })(),
    crashHook() {},
    processProbe: () => false,
  };
  return {
    options, calls, commits, discards, prepared,
    mutateSnapshot(value) { snapshotVersion = value; },
  };
}

async function assertCrashReplay({
  point,
  occurrence = 1,
  budget = '2',
  verifierResults = [
    { status: 1, stdout: 'baseline red\n', stderr: '' },
    { status: 0, stdout: 'green\n', stderr: '' },
    { status: 0, stdout: 'green replay\n', stderr: '' },
  ],
  mode = 'boolean',
  metricDirection,
  expectedOutcome = 'GOAL_REACHED',
  expectedRunners = 1,
  expectedReviewers = 1,
  expectedCommits = 1,
  expectedDiscards = 0,
}) {
  const repo = fixture();
  try {
    const overrides = { budget, mode };
    if (metricDirection !== undefined) overrides['metric-direction'] = metricDirection;
    writeWorkPath(repo, GOAL_PATH, goalText(overrides), { expect: 'goal', family: 'goal' });
    const deps = executionDependencies({ repoRoot: repo, verifierResults });
    let uuidCall = 0;
    deps.options.uuid = () => (uuidCall++ % 2 === 0 ? RUN_ID : LOCK_TOKEN);
    let observed = 0;
    deps.options.crashHook = (candidate) => {
      if (candidate === point && ++observed === occurrence) {
        throw new Error(`crash at ${point} occurrence ${occurrence}`);
      }
    };
    await assert.rejects(
      () => runLoopController(GOAL_PATH, deps.options),
      new RegExp(`crash at ${point.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'),
    );
    assert.equal(observed, occurrence, `${point} was not reached at the requested occurrence`);

    const hasEvents = existsSync(join(repo, EVENTS_PATH));
    deps.options.resume = hasEvents;
    deps.options.ledgerPath = hasEvents ? LEDGER_PATH : undefined;
    deps.options.crashHook = () => {};
    const result = await runLoopController(GOAL_PATH, deps.options);
    if (expectedOutcome === null) assert.equal(result.status, 'HALTED', point);
    else assert.equal(result.outcome, expectedOutcome, point);

    const runnerCalls = deps.calls.filter(({ kind }) => kind === 'runner');
    const reviewerCalls = deps.calls.filter(({ kind }) => kind === 'reviewer');
    assert.equal(runnerCalls.length, expectedRunners, `${point}: model spawn count`);
    assert.equal(reviewerCalls.length, expectedReviewers, `${point}: review count`);
    assert.equal(deps.commits.length, expectedCommits, `${point}: commit count`);
    assert.equal(deps.discards.length, expectedDiscards, `${point}: discard count`);

    const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
    const reservations = events.filter(({ event }) => event === 'ATTEMPT_RESERVED');
    assert.equal(
      new Set(reservations.map(({ attempt }) => attempt)).size,
      reservations.length,
      `${point}: duplicate reservation identity`,
    );
    for (const event of events.filter(({ event }) => [
      'CHILD_COMPLETED', 'DISCARD_INTENT', 'COMMIT_INTENT',
    ].includes(event.event))) {
      assert.ok(
        reservations.some(({ attempt, sequence }) => (
          attempt === event.attempt && sequence < event.sequence
        )),
        `${point}: mutation ${event.event} lacks a preceding reservation`,
      );
    }
    assert.ok(
      events.filter(({ event }) => event === 'TERMINAL_RECORDED').length <= 1,
      `${point}: duplicate terminal event`,
    );
    if (expectedOutcome === null) {
      assert.match(readWorkPath(repo, GOAL_PATH, { family: 'goal', encoding: 'utf8' }), /status: READY/u);
      assert.match(readWorkPath(repo, LEDGER_PATH, { family: 'ledger', encoding: 'utf8' }), /status: DRAFT/u);
    }
    return { deps, events, repo };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

test('goal parsing is closed, versioned, gear-4-only, and mode aware', () => {
  assert.deepEqual(parseGoalContract(goalText()), {
    goal: 'Make the deterministic verifier green',
    surface: 'scripts',
    verifier: 'node --test tests/example.test.mjs',
    verifierArgv: ['node', '--test', 'tests/example.test.mjs'],
    mode: 'BOOLEAN',
    metricDirection: null,
    budget: 3,
    blastRadius: ['scripts/**', 'tests/**'],
    notes: 'Do not change public artifact bytes',
  });
  assert.equal(parseGoalContract(goalText({
    mode: 'metric',
    'metric-direction': 'min',
  })).metricDirection, 'min');

  const invalid = [
    goalText().replace('verdict: GAP', 'verdict: BOGUS'),
    goalText().replace('gear: 4', 'gear: 3'),
    goalText().replace('status: READY', 'status: DRAFT'),
    goalText().replace('next: loop-engineer', 'next: review'),
    goalText().replace('consumed-by: none', 'consumed-by: ledger.md'),
    goalText().replace('budget: 3', 'budget: 0'),
    goalText().replace('surface: scripts', 'surface: ../scripts'),
    goalText().replace('verifier: node --test tests/example.test.mjs', 'verifier: npm test; rm -rf x'),
    goalText().replace('blast-radius: scripts/**, tests/**', 'blast-radius: ../**'),
    goalText().replace('notes: Do not change public artifact bytes\n', ''),
    goalText().replace('budget: 3', 'budget: 3\nbudget: 4'),
    goalText({ extra: 'not allowed' }),
    goalText({ 'metric-direction': 'max' }),
    goalText({ mode: 'metric' }),
    goalText({ mode: 'metric', 'metric-direction': 'sideways' }),
    goalText().replace('-->\n<!-- steepy-workflow', '-->\nunauthorized\n<!-- steepy-workflow'),
    goalText().replace('<!-- steepy-workflow: v1', '<!-- steepy-workflow: v2'),
    goalText().replace('phase: goal-contract\nstatus: READY', 'status: READY\nphase: goal-contract'),
    goalText().replace('goal: Make the deterministic verifier green', 'Goal: disguised\ngoal: Make the deterministic verifier green'),
    goalText().replace('goal: Make the deterministic verifier green', 'unknown_key: value\ngoal: Make the deterministic verifier green'),
    goalText().replace('goal: Make the deterministic verifier green', '  hidden: value\ngoal: Make the deterministic verifier green'),
    `${goalText()}\n## Unauthorized trailing structure\n`,
  ];
  for (const text of invalid) assert.throws(() => parseGoalContract(text), LoopControllerError);
});

test('preflight rejects unsafe paths, unbound routing, branch drift, dirty fresh state, and missing authorization', () => {
  const contract = parseGoalContract(goalText());
  const base = {
    goalPath: GOAL_PATH,
    ledgerPath: undefined,
    resume: false,
    commitAuthorized: true,
    harness: 'codex',
    contract,
    branch: 'feature/loop',
    dirty: false,
    expectedBranch: 'feature/loop',
    routing: {
      surface: 'scripts',
      routingPath: ROUTING_PATH,
      standardPaths: [SCRIPT_STANDARD],
    },
    runnerDescriptor: {
      cmd: 'codex', requestedModelTier: 'standard', modelSelection: 'applied',
    },
  };
  assert.equal(validateLoopPreflight(base).ledgerPath, LEDGER_PATH);
  for (const overrides of [
    { goalPath: '/tmp/goal.md' },
    { goalPath: '.apex/work/loops/2026-09-03-demo-loop/../goal.md' },
    { routing: { surface: 'tests', routingPath: ROUTING_PATH, standardPaths: [SCRIPT_STANDARD] } },
    { branch: 'main' },
    { branch: 'master' },
    { branch: 'feature/other' },
    { dirty: true },
    { commitAuthorized: false },
    { runnerDescriptor: null },
    { resume: true },
    { ledgerPath: LEDGER_PATH },
  ]) {
    assert.throws(() => validateLoopPreflight({ ...base, ...overrides }), LoopControllerError);
  }
  assert.equal(validateLoopPreflight({
    ...base,
    resume: true,
    ledgerPath: LEDGER_PATH,
    dirty: true,
  }).resume, true);
});

test('fresh controller entry validates before side effects, sanity-runs, then writes RUN_STARTED and a digest-bound DRAFT ledger', async () => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
    const deps = dependencies({ repoRoot: repo });
    const result = await runLoopController(GOAL_PATH, deps.options);
    assert.equal(result.status, 'STARTED');
    assert.equal(result.runId, RUN_ID);
    assert.equal(result.ledgerPath, LEDGER_PATH);
    assert.equal(deps.calls.includes('runner-run'), false);
    assert.equal(deps.calls.includes('reviewer-run'), false);
    assert.ok(deps.calls.indexOf('git-status') < deps.calls.findIndex((call) => call.startsWith('verifier:')));

    const eventBytes = readWorkPath(repo, EVENTS_PATH, { family: 'events' });
    const replay = reduceWorkflowJsonl(eventBytes);
    assert.equal(replay.runId, RUN_ID);
    assert.equal(replay.branch, 'feature/loop');
    assert.equal(replay.baseline, BASELINE);
    assert.equal(replay.budget, 3);
    assert.equal(replay.controllerCommitAuthorized, true);
    assert.equal(replay.goalDigest, createHash('sha256').update(goalText()).digest('hex'));
    assert.equal(replay.verifier, 'node --test tests/example.test.mjs');
    assert.deepEqual(replay.verifierArgv, ['node', '--test', 'tests/example.test.mjs']);
    assert.equal(replay.metricDirection, null);
    assert.deepEqual(replay.blastRadius, ['scripts/**', 'tests/**']);

    const ledger = readWorkPath(repo, LEDGER_PATH, { family: 'ledger', encoding: 'utf8' });
    assert.match(ledger, /phase: loop-engineer\nstatus: DRAFT\nnext: review/u);
    assert.match(ledger, new RegExp(`source: ${GOAL_PATH.replaceAll('.', '\\.')}`, 'u'));
    assert.match(ledger, /events-sha256: [0-9a-f]{64}/u);
    assert.match(ledger, /goal-sha256: [0-9a-f]{64}/u);
    assert.match(ledger, /verifier: node --test tests\/example\.test\.mjs/u);
    assert.equal(existsSync(join(repo, dirname(GOAL_PATH), '.loop-engineer.lock')), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a status-2 baseline renders byte-identically from unchanged events on resume', async () => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
    const fresh = dependencies({
      repoRoot: repo,
      verifier: { run: () => ({ status: 2, stdout: 'red with status two\n', stderr: '' }) },
    });
    await runLoopController(GOAL_PATH, fresh.options);
    const events = readWorkPath(repo, EVENTS_PATH, { family: 'events' });
    const ledger = readWorkPath(repo, LEDGER_PATH, { family: 'ledger' });
    assert.match(ledger.toString('utf8'), /^sanity-exit: 2$/mu);

    const resumed = dependencies({
      repoRoot: repo,
      resume: true,
      ledgerPath: LEDGER_PATH,
      verifier: { run: () => assert.fail('resume must not rerun the baseline verifier') },
    });
    const result = await runLoopController(GOAL_PATH, resumed.options);
    assert.equal(result.status, 'RESUMED');
    assert.deepEqual(readWorkPath(repo, EVENTS_PATH, { family: 'events' }), events);
    assert.deepEqual(readWorkPath(repo, LEDGER_PATH, { family: 'ledger' }), ledger);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('every refusal happens before model spawn or durable machine state', async () => {
  const cases = [
    { name: 'main branch', overrides: { git: { branch: () => 'main', status: () => '', baseline: () => BASELINE } } },
    { name: 'unexpected branch', overrides: { expectedBranch: 'feature/other' } },
    { name: 'dirty fresh', overrides: { git: { branch: () => 'feature/loop', status: () => ' M dirty', baseline: () => BASELINE } } },
    { name: 'commit declined', overrides: { commitAuthorized: false } },
    { name: 'runner unavailable', overrides: { runner: { descriptor: () => null, run: () => assert.fail('spawn') } } },
    { name: 'unreliable verifier', overrides: { verifier: { run: () => ({ status: null, stdout: '', stderr: 'spawn failed', error: new Error('ENOENT') }) } } },
  ];
  for (const entry of cases) {
    const repo = fixture();
    try {
      writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
      const deps = dependencies({ repoRoot: repo, ...entry.overrides });
      await assert.rejects(() => runLoopController(GOAL_PATH, deps.options), LoopControllerError, entry.name);
      assert.equal(deps.calls.includes('runner-run'), false, entry.name);
      assert.throws(() => readWorkPath(repo, EVENTS_PATH), /missing work artifact/u, entry.name);
      assert.throws(() => readWorkPath(repo, LEDGER_PATH), /missing work artifact/u, entry.name);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('an unreliable sanity verifier observes no repository-local preflight lock or artifact even when it crashes', async () => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
    const loopDir = join(repo, dirname(GOAL_PATH));
    const before = readdirSync(loopDir).sort();
    let during = null;
    const deps = dependencies({
      repoRoot: repo,
      verifier: {
        run() {
          during = readdirSync(loopDir).sort();
          throw new Error('simulated verifier-process crash');
        },
      },
    });
    await assert.rejects(
      () => runLoopController(GOAL_PATH, deps.options),
      /simulated verifier-process crash/u,
    );
    assert.deepEqual(during, before, 'sanity verifier must run before repo-local lock publication');
    assert.deepEqual(readdirSync(loopDir).sort(), before, 'crashed preflight leaves no repo-local state');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('resume uses exact events state, restores a stale projection, and locking replaces only a provably dead owner', async () => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
    const fresh = dependencies({ repoRoot: repo });
    await runLoopController(GOAL_PATH, fresh.options);
    writeWorkPath(repo, LEDGER_PATH, 'stale projection\n', { family: 'ledger' });

    const lock = join(repo, dirname(GOAL_PATH), '.loop-engineer.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), `{"pid":999999,"token":"${LOCK_TOKEN}"}\n`);
    const resumed = dependencies({ repoRoot: repo, resume: true, ledgerPath: LEDGER_PATH });
    const result = await runLoopController(GOAL_PATH, resumed.options);
    assert.equal(result.status, 'RESUMED');
    assert.equal(result.runId, RUN_ID);
    assert.match(readWorkPath(repo, LEDGER_PATH, { encoding: 'utf8' }), /events-sha256: [0-9a-f]{64}/u);
    assert.equal(existsSync(lock), false);

    mkdirSync(lock);
    const liveToken = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    writeFileSync(join(lock, 'owner.json'), `{"pid":${process.pid},"token":"${liveToken}"}\n`);
    const contended = dependencies({
      repoRoot: repo,
      resume: true,
      ledgerPath: LEDGER_PATH,
      processProbe: () => true,
    });
    await assert.rejects(() => runLoopController(GOAL_PATH, contended.options), /lock owner is live/u);
    assert.equal(readFileSync(join(lock, 'owner.json'), 'utf8').includes(liveToken), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('resume rejects untrusted run identities and every goal-contract drift before lock or verifier effects', async () => {
  const unsafeIds = ['../../../escaped-lock', 'not-a-uuid', 'bad token', `${RUN_ID}/child`];
  for (const unsafeId of unsafeIds) {
    const repo = fixture();
    try {
      writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
      const fresh = dependencies({ repoRoot: repo });
      await runLoopController(GOAL_PATH, fresh.options);
      const event = JSON.parse(readWorkPath(repo, EVENTS_PATH, { encoding: 'utf8' }));
      event.runId = unsafeId;
      writeWorkPath(repo, EVENTS_PATH, `${JSON.stringify(event)}\n`, { family: 'events' });
      const resumed = dependencies({ repoRoot: repo, resume: true, ledgerPath: LEDGER_PATH });
      await assert.rejects(() => runLoopController(GOAL_PATH, resumed.options), /run.*UUID|run identity/iu);
      assert.equal(resumed.calls.some((call) => call.startsWith('verifier:')), false);
      assert.equal(existsSync(join(repo, dirname(GOAL_PATH), '.loop-engineer.lock')), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  const driftedGoals = [
    goalText().replace('# Demo loop goal', '# Byte-only changed title'),
    goalText({ goal: 'Different goal' }),
    goalText({ verifier: 'npm test' }),
    goalText({ budget: '4' }),
    goalText({ 'blast-radius': 'scripts/**' }),
    goalText({ notes: 'Different constraints' }),
    goalText({ mode: 'metric', 'metric-direction': 'min' }),
  ];
  for (const drifted of driftedGoals) {
    const repo = fixture();
    try {
      writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
      await runLoopController(GOAL_PATH, dependencies({ repoRoot: repo }).options);
      writeWorkPath(repo, GOAL_PATH, drifted, { expect: 'goal', family: 'goal' });
      const resumed = dependencies({ repoRoot: repo, resume: true, ledgerPath: LEDGER_PATH });
      await assert.rejects(() => runLoopController(GOAL_PATH, resumed.options), /goal.*drift|contract.*drift/iu);
      assert.equal(resumed.calls.some((call) => call.startsWith('verifier:')), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('resume rejects every contradictory RUN_STARTED contract field before lock-token allocation', async () => {
  const mutations = [
    (event) => { event.goalDigest = 'e'.repeat(64); },
    (event) => { event.verifier = 'node --test tests/other.test.mjs'; },
    (event) => { event.verifierArgv = ['node', '--test', 'tests/other.test.mjs']; },
    (event) => { event.budget = 9; },
    (event) => { event.blastRadius = ['scripts/**']; },
    (event) => { event.mode = 'METRIC'; event.metricDirection = 'min'; },
    (event) => { event.metricDirection = 'min'; },
    (event) => { event.controllerCommitAuthorized = false; },
  ];
  for (const mutate of mutations) {
    const repo = fixture();
    try {
      writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
      await runLoopController(GOAL_PATH, dependencies({ repoRoot: repo }).options);
      const ledgerBefore = readWorkPath(repo, LEDGER_PATH);
      const event = JSON.parse(readWorkPath(repo, EVENTS_PATH, { encoding: 'utf8' }));
      mutate(event);
      writeWorkPath(repo, EVENTS_PATH, `${JSON.stringify(event)}\n`, { family: 'events' });
      const resumed = dependencies({ repoRoot: repo, resume: true, ledgerPath: LEDGER_PATH });
      await assert.rejects(() => runLoopController(GOAL_PATH, resumed.options), /drift|metric|authorization/iu);
      assert.equal(resumed.calls.includes('uuid'), false);
      assert.equal(resumed.calls.some((call) => call.startsWith('process-probe:')), false);
      assert.equal(resumed.calls.some((call) => call.startsWith('verifier:')), false);
      assert.deepEqual(readWorkPath(repo, LEDGER_PATH), ledgerBefore);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('metric sanity requires a successful command and a present canonical finite scalar', async () => {
  const invalid = [
    { status: 0, stdout: '', stderr: '' },
    { status: 0, stdout: '   \n', stderr: '' },
    { status: 0, stdout: 'NaN\n', stderr: '' },
    { status: 0, stdout: 'Infinity\n', stderr: '' },
    { status: 0, stdout: '1.2 trailing\n', stderr: '' },
    { status: 1, stdout: '1.2\n', stderr: 'failed' },
    { status: null, stdout: '1.2\n', stderr: 'signal' },
  ];
  for (const observation of invalid) {
    const repo = fixture();
    try {
      writeWorkPath(repo, GOAL_PATH, goalText({ mode: 'metric', 'metric-direction': 'min' }), {
        expect: 'goal', family: 'goal',
      });
      const deps = dependencies({
        repoRoot: repo,
        verifier: { run: () => observation },
      });
      await assert.rejects(() => runLoopController(GOAL_PATH, deps.options), /metric|verifier/iu);
      assert.throws(() => readWorkPath(repo, EVENTS_PATH), /missing work artifact/u);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText({ mode: 'metric', 'metric-direction': 'max' }), {
      expect: 'goal', family: 'goal',
    });
    const deps = dependencies({
      repoRoot: repo,
      verifier: { run: () => ({ status: 0, stdout: '0\n', stderr: '' }) },
    });
    const result = await runLoopController(GOAL_PATH, deps.options);
    assert.equal(result.verifier.metric, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('stale lock takeover revalidates the exact generation after the process probe', async () => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
    await runLoopController(GOAL_PATH, dependencies({ repoRoot: repo }).options);
    const lock = join(repo, dirname(GOAL_PATH), '.loop-engineer.lock');
    const displaced = join(repo, dirname(GOAL_PATH), '.observed-stale-lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), `{"pid":999999,"token":"${LOCK_TOKEN}"}\n`);
    const competingToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const resumed = dependencies({
      repoRoot: repo,
      resume: true,
      ledgerPath: LEDGER_PATH,
      processProbe() {
        renameSync(lock, displaced);
        mkdirSync(lock);
        writeFileSync(join(lock, 'owner.json'), `{"pid":${process.pid},"token":"${competingToken}"}\n`);
        return false;
      },
    });
    await assert.rejects(() => runLoopController(GOAL_PATH, resumed.options), /lock.*changed|unverifiable/iu);
    assert.match(readFileSync(join(lock, 'owner.json'), 'utf8'), new RegExp(competingToken, 'u'));
    assert.match(readFileSync(join(displaced, 'owner.json'), 'utf8'), new RegExp(LOCK_TOKEN, 'u'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('delayed stale contender cannot displace a newly published canonical lock', async () => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
    await runLoopController(GOAL_PATH, dependencies({ repoRoot: repo }).options);
    const loopDir = join(repo, dirname(GOAL_PATH));
    const lock = join(loopDir, '.loop-engineer.lock');
    const quarantine = join(loopDir, `.loop-engineer.lock.stale-${LOCK_TOKEN}`);
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), `{"pid":999999,"token":"${LOCK_TOKEN}"}\n`);
    const competingToken = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const delayedToken = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    let competingIdentity = null;
    const delayed = dependencies({
      repoRoot: repo,
      resume: true,
      ledgerPath: LEDGER_PATH,
      uuid: () => delayedToken,
      lockTransitionHook() {
        renameSync(lock, quarantine);
        mkdirSync(lock);
        writeFileSync(join(lock, 'owner.json'), `{"pid":${process.pid},"token":"${competingToken}"}\n`);
        const stat = lstatSync(lock, { bigint: true });
        competingIdentity = `${stat.dev}:${stat.ino}`;
      },
    });
    await assert.rejects(() => runLoopController(GOAL_PATH, delayed.options), /lock.*changed|unverifiable/iu);
    const current = lstatSync(lock, { bigint: true });
    assert.equal(`${current.dev}:${current.ino}`, competingIdentity);
    assert.match(readFileSync(join(lock, 'owner.json'), 'utf8'), new RegExp(competingToken, 'u'));
    assert.match(readFileSync(join(quarantine, 'owner.json'), 'utf8'), new RegExp(LOCK_TOKEN, 'u'));
    assert.equal(delayed.calls.some((call) => call.startsWith('verifier:')), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('strict CLI refuses unsupported runners and malformed resume pairs without inline fallback', async () => {
  const writes = [];
  const status = await main([
    '--repo-root', '.', '--goal', GOAL_PATH, '--harness', 'pi', '--commit-authorized',
    '--routing-index', ROUTING_PATH, '--standard', SCRIPT_STANDARD,
  ], {
    stdout: { write: (value) => writes.push(String(value)) },
    stderr: { write: (value) => writes.push(String(value)) },
  });
  assert.equal(status, 1);
  assert.match(writes.join(''), /runner-unavailable/u);

  assert.equal(await main([
    '--repo-root', '.', '--goal', GOAL_PATH, '--harness', 'codex', '--commit-authorized', '--resume',
    '--routing-index', ROUTING_PATH, '--standard', SCRIPT_STANDARD,
  ], { stdout: { write() {} }, stderr: { write() {} } }), 2);
  assert.equal(await main([
    '--repo-root', '.', '--goal', GOAL_PATH, '--harness', 'codex', '--commit-authorized', '--ledger', LEDGER_PATH,
    '--routing-index', ROUTING_PATH, '--standard', SCRIPT_STANDARD,
  ], { stdout: { write() {} }, stderr: { write() {} } }), 2);

  const singletonFlags = [
    ['--repo-root', '.'],
    ['--goal', GOAL_PATH],
    ['--harness', 'pi'],
    ['--commit-authorized'],
    ['--resume'],
    ['--ledger', LEDGER_PATH],
    ['--routing-index', ROUTING_PATH],
  ];
  const base = [
    '--repo-root', '.', '--goal', GOAL_PATH, '--harness', 'pi', '--commit-authorized',
    '--resume', '--ledger', LEDGER_PATH,
    '--routing-index', ROUTING_PATH, '--standard', SCRIPT_STANDARD,
  ];
  for (const duplicate of singletonFlags) {
    assert.equal(
      await main([...base, ...duplicate], { stdout: { write() {} }, stderr: { write() {} } }),
      2,
      duplicate[0],
    );
  }
});

test('already-green boolean run uses zero mutation budget and finalizes exact machine artifacts', async () => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
    const deps = executionDependencies({
      repoRoot: repo,
      verifierResults: [{ status: 0, stdout: 'green\n', stderr: '' }],
    });
    const result = await runLoopController(GOAL_PATH, deps.options);
    assert.equal(result.status, 'GOAL_REACHED');
    assert.equal(result.outcome, 'GOAL_REACHED');
    assert.equal(result.attempts, 0);
    assert.deepEqual(deps.commits, []);
    assert.equal(deps.calls.some(({ kind }) => kind === 'runner'), false);

    const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
    assert.deepEqual(events.map(({ event }) => event), [
      'RUN_STARTED', 'REVIEW_COMPLETED', 'TERMINAL_RECORDED',
    ]);
    assert.equal(events[0].baselinePassed, true);
    assert.equal(events[0].baselineMetric, null);
    assert.equal(events.filter(({ event }) => event === 'TERMINAL_RECORDED').length, 1);

    const eventBytes = readWorkPath(repo, EVENTS_PATH, { family: 'events' });
    const ledger = readWorkPath(repo, LEDGER_PATH, { family: 'ledger', encoding: 'utf8' });
    assert.match(ledger, /status: READY/u);
    assert.match(ledger, new RegExp(`events-sha256: ${createHash('sha256').update(eventBytes).digest('hex')}`, 'u'));
    assert.match(readWorkPath(repo, GOAL_PATH, { expect: 'goal', encoding: 'utf8' }), new RegExp(
      `status: CONSUMED\\nnext: loop-engineer\\nsource: none\\nconsumed-by: ${LEDGER_PATH.replaceAll('.', '\\.')}`,
      'u',
    ));
    assert.match(readWorkPath(repo, '.apex/work/loops/2026-09-03-demo-loop/branch-diff.txt', {
      family: 'diff', encoding: 'utf8',
    }), new RegExp(BASELINE, 'u'));
    assert.deepEqual(result.handoff, { goal: GOAL_PATH, 'loop-ledger': LEDGER_PATH });

    const before = Object.freeze({
      goal: readWorkPath(repo, GOAL_PATH, { family: 'goal' }),
      ledger: readWorkPath(repo, LEDGER_PATH, { family: 'ledger' }),
      events: readWorkPath(repo, EVENTS_PATH, { family: 'events' }),
    });
    const authority = reduceWorkflowJsonl(before.events);
    const receipt = validateLoopTerminal(GOAL_PATH, LEDGER_PATH, {
      repoRoot: repo, git: deps.options.git,
    });
    assert.deepEqual(receipt, {
      status: 'VALIDATED',
      goal: GOAL_PATH,
      'loop-ledger': LEDGER_PATH,
      'run-id': RUN_ID,
      outcome: 'GOAL_REACHED',
      'goal-succeeded': true,
      'events-sha256': createHash('sha256').update(before.events).digest('hex'),
      mode: 'boolean',
      'branch-review': {
        verdict: 'APPROVED',
        'issues-found': false,
        review: 1,
        attempt: null,
        report: `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-review-1-report.md`,
        'report-sha256': authority.review.reportDigest,
        diff: `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-review-1-diff.txt`,
        'diff-sha256': authority.review.diffDigest,
      },
      'final-projection': {
        diff: '.apex/work/loops/2026-09-03-demo-loop/branch-diff.txt',
        'diff-sha256': authority.terminalEvidence.diffDigest,
        branch: 'feature/loop',
        head: BASELINE,
        clean: true,
        'snapshot-sha256': authority.terminalEvidence.snapshotDigest,
      },
      'attempt-budget': { reserved: 0, budget: 3, exhausted: false },
      candidate: {
        acceptable: true,
        'boolean-green': true,
        'metric-baseline': null,
        'metric-best': null,
        'metric-strict-improvement': null,
      },
    });
    assert.deepEqual(readWorkPath(repo, GOAL_PATH, { family: 'goal' }), before.goal);
    assert.deepEqual(readWorkPath(repo, LEDGER_PATH, { family: 'ledger' }), before.ledger);
    assert.deepEqual(readWorkPath(repo, EVENTS_PATH, { family: 'events' }), before.events);

    const cliWrites = [];
    assert.equal(await main([
      '--repo-root', repo, '--validate-terminal', '--goal', GOAL_PATH, '--ledger', LEDGER_PATH,
    ], {
      stdout: { write: (value) => cliWrites.push(String(value)) },
      stderr: { write: (value) => cliWrites.push(String(value)) },
      git: deps.options.git,
    }), 0);
    assert.deepEqual(JSON.parse(cliWrites.join('')), receipt);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('boolean policy commits cumulative red checkpoints, reaches green, and persists immutable evidence', async () => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText({ budget: '2' }), { expect: 'goal', family: 'goal' });
    const deps = executionDependencies({
      repoRoot: repo,
      verifierResults: [
        { status: 1, stdout: 'initial red\n', stderr: '' },
        { status: 1, stdout: 'still red\n', stderr: '' },
        { status: 0, stdout: 'green\n', stderr: '' },
      ],
      changedPaths: [['scripts/first.mjs'], ['scripts/second.mjs']],
    });
    const result = await runLoopController(GOAL_PATH, deps.options);
    assert.equal(result.outcome, 'GOAL_REACHED');
    assert.equal(result.attempts, 2);
    assert.equal(deps.commits.length, 2);
    assert.deepEqual(deps.prepared.map(({ expectedParent }) => expectedParent), [BASELINE, 'b'.repeat(40)]);
    for (const [index, prepared] of deps.prepared.entries()) {
      assert.equal(prepared.metadata.runId, RUN_ID);
      assert.equal(prepared.metadata.attempt, index + 1);
      assert.equal(prepared.metadata.expectedParent, prepared.expectedParent);
      assert.equal(prepared.metadata.owner, 'steepy-loop-engineer-v1');
    }

    const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
    assert.deepEqual(
      events.filter(({ event }) => event === 'VERIFIER_RECORDED').map(({ verdict }) => verdict),
      ['KEEP', 'GOAL_REACHED'],
    );
    assert.equal(events.filter(({ event }) => event === 'ATTEMPT_RESERVED').length, 2);
    for (const attempt of [1, 2]) {
      for (const [suffix, family] of [
        ['report.md', 'runner-report'], ['raw.jsonl', 'runner-raw'], ['log', 'runner-log'],
      ]) {
        assert.doesNotThrow(() => readWorkPath(
          repo, `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-attempt-${attempt}-${suffix}`
            .replace('-raw.jsonl', '.raw.jsonl').replace('-log', '.log'),
          { family },
        ));
      }
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('initial Gear-4 event persistence completes positive short writes', async () => {
  const repo = fixture();
  let writes = 0;
  try {
    writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
    const deps = dependencies({ repoRoot: repo });
    deps.options.initialWrite = (fd, buffer, offset, length) => {
      writes += 1;
      return writeSync(fd, buffer, offset, Math.min(length, 5));
    };
    const result = await runLoopController(GOAL_PATH, deps.options);
    assert.equal(result.status, 'STARTED');
    assert.ok(writes > 1);
    const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
    assert.deepEqual(events.map(({ event }) => event), ['RUN_STARTED']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('initial Gear-4 event write errors after a prefix cannot publish success state', async () => {
  const repo = fixture();
  let writes = 0;
  try {
    writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
    const deps = dependencies({ repoRoot: repo });
    deps.options.initialWrite = (fd, buffer, offset, length) => {
      writes += 1;
      if (writes === 2) throw new Error('injected initial event failure');
      return writeSync(fd, buffer, offset, Math.min(length, 7));
    };
    await assert.rejects(
      () => runLoopController(GOAL_PATH, deps.options),
      /injected initial event failure/u,
    );
    assert.equal(writes, 2);
    assert.equal(existsSync(join(repo, LEDGER_PATH)), false);
    assert.equal(deps.calls.includes('crash:after-event-append:RUN_STARTED'), false);
    assert.equal(deps.calls.includes('crash:after-run-started'), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Gear-4 immutable artifact persistence completes positive short writes', async () => {
  const repo = fixture();
  let writes = 0;
  try {
    writeWorkPath(repo, GOAL_PATH, goalText({ budget: '1' }), { expect: 'goal', family: 'goal' });
    const deps = executionDependencies({
      repoRoot: repo,
      verifierResults: [
        { status: 1, stdout: 'initial red\n', stderr: '' },
        { status: 0, stdout: 'green\n', stderr: '' },
      ],
      changedPaths: [['scripts/example.mjs']],
    });
    deps.options.immutableWrite = (fd, buffer, offset, length) => {
      writes += 1;
      return writeSync(fd, buffer, offset, Math.min(length, 3));
    };
    const result = await runLoopController(GOAL_PATH, deps.options);
    assert.equal(result.outcome, 'GOAL_REACHED');
    assert.ok(writes > 10);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Gear-4 immutable write errors after a prefix cannot publish CHILD_COMPLETED', async () => {
  const repo = fixture();
  let writes = 0;
  try {
    writeWorkPath(repo, GOAL_PATH, goalText({ budget: '1' }), { expect: 'goal', family: 'goal' });
    const deps = executionDependencies({
      repoRoot: repo,
      verifierResults: [
        { status: 1, stdout: 'initial red\n', stderr: '' },
        { status: 0, stdout: 'green\n', stderr: '' },
      ],
      changedPaths: [['scripts/example.mjs']],
    });
    deps.options.immutableWrite = (fd, buffer, offset, length) => {
      writes += 1;
      if (writes === 2) throw new Error('injected immutable failure');
      return writeSync(fd, buffer, offset, Math.min(length, 5));
    };
    await assert.rejects(
      () => runLoopController(GOAL_PATH, deps.options),
      /injected immutable failure/u,
    );
    assert.equal(writes, 2);
    const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
    assert.equal(events.some(({ event }) => event === 'CHILD_COMPLETED'), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('boolean exhaustion and reviewer rejection are clean outcomes with no hidden fix allowance', async () => {
  for (const scenario of [
    {
      name: 'exhaustion',
      verifierResults: [
        { status: 1, stdout: 'red\n', stderr: '' },
        { status: 1, stdout: 'red\n', stderr: '' },
      ],
      reviews: ['approved'],
      outcome: 'BUDGET_EXHAUSTED',
    },
    {
      name: 'rejected',
      verifierResults: [
        { status: 0, stdout: 'green\n', stderr: '' },
        { status: 0, stdout: 'green\n', stderr: '' },
      ],
      reviews: ['issues', 'issues'],
      outcome: 'REVIEW_REJECTED',
      acceptable: true,
    },
    {
      name: 'rejected-red',
      verifierResults: [
        { status: 1, stdout: 'red\n', stderr: '' },
        { status: 1, stdout: 'still red\n', stderr: '' },
      ],
      reviews: ['issues'],
      outcome: 'BUDGET_EXHAUSTED',
      acceptable: false,
    },
  ]) {
    const repo = fixture();
    try {
      writeWorkPath(repo, GOAL_PATH, goalText({ budget: '1' }), { expect: 'goal', family: 'goal' });
      const deps = executionDependencies({
        repoRoot: repo,
        verifierResults: scenario.verifierResults,
        changedPaths: [['scripts/fix.mjs']],
        reviews: scenario.reviews,
      });
      const result = await runLoopController(GOAL_PATH, deps.options);
      assert.equal(result.outcome, scenario.outcome, scenario.name);
      assert.equal(result.attempts, 1, scenario.name);
      const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
      assert.equal(events.filter(({ event }) => event === 'ATTEMPT_RESERVED').length, 1, scenario.name);
      assert.equal(events.filter(({ event }) => event === 'TERMINAL_RECORDED').length, 1, scenario.name);
      const receipt = validateLoopTerminal(GOAL_PATH, LEDGER_PATH, {
        repoRoot: repo, git: deps.options.git,
      });
      assert.equal(receipt['branch-review'].verdict,
        scenario.name.startsWith('rejected') ? 'ISSUES_FOUND' : 'APPROVED');
      assert.deepEqual(receipt['attempt-budget'], { reserved: 1, budget: 1, exhausted: true });
      assert.equal(receipt.candidate.acceptable, scenario.acceptable ?? false);
      assert.equal(receipt.candidate['boolean-green'], scenario.acceptable ?? false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('a discarded final review-fix retains the prior boolean-green branch for terminal selection and proof', async () => {
  for (const finalReview of ['approved', 'issues']) {
    const repo = fixture();
    try {
      writeWorkPath(repo, GOAL_PATH, goalText({ budget: '2' }), { expect: 'goal', family: 'goal' });
      const deps = executionDependencies({
        repoRoot: repo,
        verifierResults: [
          { status: 1, stdout: 'baseline red\n', stderr: '' },
          { status: 0, stdout: 'green\n', stderr: '' },
        ],
        changedPaths: [['scripts/fix.mjs'], ['docs/outside.md']],
        reviews: ['issues', finalReview],
      });
      const result = await runLoopController(GOAL_PATH, deps.options);
      assert.equal(
        result.outcome,
        finalReview === 'approved' ? 'GOAL_REACHED' : 'REVIEW_REJECTED',
        finalReview,
      );
      const receipt = validateLoopTerminal(GOAL_PATH, LEDGER_PATH, {
        repoRoot: repo,
        git: deps.options.git,
      });
      assert.equal(receipt.candidate.acceptable, true, finalReview);
      assert.equal(receipt.candidate['boolean-green'], true, finalReview);
      assert.equal(
        receipt['branch-review'].verdict,
        finalReview === 'approved' ? 'APPROVED' : 'ISSUES_FOUND',
        finalReview,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('terminal validation authenticates reviewer report, reviewer diff, final diff, and current Git for every outcome', async () => {
  const scenarios = [
    {
      outcome: 'GOAL_REACHED',
      goal: {},
      verifierResults: [{ status: 0, stdout: 'green\n', stderr: '' }],
      reviews: ['approved'],
    },
    {
      outcome: 'BUDGET_EXHAUSTED',
      goal: { budget: '1' },
      verifierResults: [
        { status: 1, stdout: 'red\n', stderr: '' },
        { status: 1, stdout: 'still red\n', stderr: '' },
      ],
      reviews: ['approved'],
    },
    {
      outcome: 'NO_IMPROVEMENT',
      goal: { mode: 'metric', 'metric-direction': 'min', budget: '1' },
      verifierResults: [
        { status: 0, stdout: '10\n', stderr: '' },
        { status: 0, stdout: '11\n', stderr: '' },
      ],
      reviews: ['issues'],
    },
    {
      outcome: 'REVIEW_REJECTED',
      goal: { budget: '1' },
      verifierResults: [
        { status: 1, stdout: 'red\n', stderr: '' },
        { status: 0, stdout: 'green\n', stderr: '' },
      ],
      reviews: ['issues'],
    },
  ];
  for (const scenario of scenarios) {
    const repo = fixture();
    try {
      writeWorkPath(repo, GOAL_PATH, goalText(scenario.goal), { expect: 'goal', family: 'goal' });
      const deps = executionDependencies({
        repoRoot: repo,
        verifierResults: scenario.verifierResults,
        changedPaths: [['scripts/fix.mjs']],
        reviews: scenario.reviews,
      });
      const result = await runLoopController(GOAL_PATH, deps.options);
      assert.equal(result.outcome, scenario.outcome);
      const state = reduceWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
      const validate = (git = deps.options.git) => validateLoopTerminal(GOAL_PATH, LEDGER_PATH, {
        repoRoot: repo,
        git,
      });
      const receipt = validate();
      assert.equal(receipt.outcome, scenario.outcome);
      assert.match(state.review.reportDigest, /^[0-9a-f]{64}$/u);
      assert.match(receipt['branch-review']['report-sha256'], /^[0-9a-f]{64}$/u);
      assert.match(receipt['final-projection']['diff-sha256'], /^[0-9a-f]{64}$/u);

      const evidence = [
        [state.review.reportPath, 'reviewer-report'],
        [state.review.diffPath, 'reviewer-diff'],
        [result.diffPath, 'diff'],
      ];
      for (const [path, family] of evidence) {
        const original = readWorkPath(repo, path, { family });
        writeWorkPath(repo, path, Buffer.concat([original, Buffer.from('tamper\n')]), { family });
        assert.throws(validate, /digest|drift|projection|evidence/iu, `${scenario.outcome}: ${family} tamper`);
        writeWorkPath(repo, path, original, { family });
        unlinkSync(join(repo, path));
        assert.throws(validate, /missing|evidence|report|diff|projection/iu,
          `${scenario.outcome}: ${family} deletion`);
        writeWorkPath(repo, path, original, { family });

        const wrong = join(repo, dirname(path), `wrong-${family}.txt`);
        writeFileSync(wrong, original);
        unlinkSync(join(repo, path));
        linkSync(wrong, join(repo, path));
        assert.throws(validate, /link|physical|evidence|projection/iu,
          `${scenario.outcome}: ${family} wrong physical file`);
        unlinkSync(join(repo, path));
        unlinkSync(wrong);
        writeWorkPath(repo, path, original, { family });
      }

      assert.throws(
        () => validate({ ...deps.options.git, head: () => 'f'.repeat(40) }),
        /HEAD|Git|snapshot|branch/iu,
        `${scenario.outcome}: changed HEAD`,
      );
      assert.throws(
        () => validate({ ...deps.options.git, branch: () => 'feature/foreign' }),
        /branch/iu,
        `${scenario.outcome}: changed branch`,
      );
      assert.throws(
        () => validate({ ...deps.options.git, status: () => ' M foreign.txt' }),
        /dirty|clean|Git|snapshot/iu,
        `${scenario.outcome}: dirty tree`,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('terminal validation rejects baseline-exit and observability runtime-field drift', async (t) => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText({ budget: '1' }), { expect: 'goal', family: 'goal' });
    const deps = executionDependencies({
      repoRoot: repo,
      verifierResults: [
        { status: 2, stdout: 'red with status two\n', stderr: '' },
        { status: 0, stdout: 'green\n', stderr: '' },
      ],
      changedPaths: [['scripts/fix.mjs']],
      reviews: ['approved'],
    });
    const run = deps.options.runner.run.bind(deps.options.runner);
    deps.options.runner.run = (...args) => ({ ...run(...args), degraded: true });
    const result = await runLoopController(GOAL_PATH, deps.options);
    assert.equal(result.outcome, 'GOAL_REACHED');
    const ledger = readWorkPath(repo, LEDGER_PATH, { family: 'ledger', encoding: 'utf8' });
    assert.match(ledger, /^sanity-exit: 2$/mu);
    assert.match(ledger, /^observability-degraded: true$/mu);
    const validate = () => validateLoopTerminal(GOAL_PATH, LEDGER_PATH, {
      repoRoot: repo,
      git: deps.options.git,
    });
    assert.equal(validate().status, 'VALIDATED');

    await t.test('baseline exit is authenticated by events', () => {
      try {
        writeWorkPath(repo, LEDGER_PATH, ledger.replace(
          /^sanity-exit: 2$/mu,
          'sanity-exit: 3',
        ), { family: 'ledger' });
        assert.throws(validate, /ledger|event authority|projection|baseline.*exit/iu);
      } finally {
        writeWorkPath(repo, LEDGER_PATH, ledger, { family: 'ledger' });
      }
    });

    await t.test('observability degradation is authenticated by events', () => {
      try {
        writeWorkPath(repo, LEDGER_PATH, ledger.replace(
          /^observability-degraded: true$/mu,
          'observability-degraded: false',
        ), { family: 'ledger' });
        assert.throws(validate, /ledger|event authority|projection|observability/iu);
      } finally {
        writeWorkPath(repo, LEDGER_PATH, ledger, { family: 'ledger' });
      }
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('terminal validation rejects stale projections and forged event commitments without mutation', async () => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
    const deps = executionDependencies({
      repoRoot: repo,
      verifierResults: [{ status: 0, stdout: 'green\n', stderr: '' }],
    });
    await runLoopController(GOAL_PATH, deps.options);
    const originalLedger = readWorkPath(repo, LEDGER_PATH, { family: 'ledger', encoding: 'utf8' });
    const originalEvents = readWorkPath(repo, EVENTS_PATH, { family: 'events' });

    writeWorkPath(repo, LEDGER_PATH, originalLedger.replace(
      /events-sha256: [0-9a-f]{64}/u,
      `events-sha256: ${'f'.repeat(64)}`,
    ), { family: 'ledger' });
    assert.throws(
      () => validateLoopTerminal(GOAL_PATH, LEDGER_PATH, { repoRoot: repo, git: deps.options.git }),
      /ledger.*event|event.*digest|projection/iu,
    );
    assert.deepEqual(readWorkPath(repo, EVENTS_PATH, { family: 'events' }), originalEvents);

    writeWorkPath(repo, LEDGER_PATH, originalLedger, { family: 'ledger' });
    assert.throws(
      () => validateLoopTerminal(GOAL_PATH, `${dirname(LEDGER_PATH)}/other.md`, {
        repoRoot: repo, git: deps.options.git,
      }),
      /exact ledger|invalid.*ledger/iu,
    );
    assert.equal(await main([
      '--repo-root', repo, '--validate-terminal', '--goal', GOAL_PATH, '--ledger', LEDGER_PATH,
      '--commit-authorized',
    ], { stdout: { write() {} }, stderr: { write() {} } }), 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('metric policy keeps strict improvements, discards regressions to the owned best, and distinguishes no improvement', async () => {
  for (const scenario of [
    { values: [10, 8], budget: '2', outcome: 'GOAL_REACHED', commits: 1, discards: 0, best: 8 },
    { values: [10, 11, 8], budget: '2', outcome: 'GOAL_REACHED', commits: 1, discards: 1, best: 8 },
    { values: [10, 11], budget: '1', outcome: 'NO_IMPROVEMENT', commits: 0, discards: 1, best: 10 },
    { values: [10, 10], budget: '1', outcome: 'NO_IMPROVEMENT', commits: 0, discards: 1, best: 10, reviews: ['issues'] },
  ]) {
    const repo = fixture();
    try {
      writeWorkPath(repo, GOAL_PATH, goalText({
        mode: 'metric', 'metric-direction': 'min', budget: scenario.budget,
      }), { expect: 'goal', family: 'goal' });
      const deps = executionDependencies({
        repoRoot: repo,
        verifierResults: scenario.values.map((value) => ({ status: 0, stdout: `${value}\n`, stderr: '' })),
        changedPaths: scenario.values.slice(1).map(() => ['scripts/metric.mjs']),
        reviews: scenario.reviews,
      });
      const result = await runLoopController(GOAL_PATH, deps.options);
      assert.equal(result.outcome, scenario.outcome);
      assert.equal(deps.commits.length, scenario.commits);
      assert.equal(deps.discards.length, scenario.discards);
      const state = reduceWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
      assert.equal(state.baselineVerifier.metric, 10);
      assert.deepEqual(state.attempts.map(({ metric }) => metric), scenario.values.slice(1));
      const receipt = validateLoopTerminal(GOAL_PATH, LEDGER_PATH, {
        repoRoot: repo, git: deps.options.git,
      });
      assert.deepEqual(receipt.candidate, {
        acceptable: scenario.best < 10,
        'boolean-green': null,
        'metric-baseline': 10,
        'metric-best': scenario.best,
        'metric-strict-improvement': scenario.best < 10,
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('blast-radius enforcement discards an owned violating attempt before its verifier runs', async () => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText({ budget: '1' }), { expect: 'goal', family: 'goal' });
    const deps = executionDependencies({
      repoRoot: repo,
      verifierResults: [{ status: 1, stdout: 'red\n', stderr: '' }],
      changedPaths: [['docs/outside.md']],
    });
    const result = await runLoopController(GOAL_PATH, deps.options);
    assert.equal(result.outcome, 'BUDGET_EXHAUSTED');
    assert.equal(deps.discards.length, 1);
    assert.equal(deps.calls.filter(({ kind }) => kind === 'verifier').length, 1);
    const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
    assert.deepEqual(events.filter(({ event }) => event === 'BLAST_RADIUS_CHECKED').map(({ passed }) => passed), [false]);
    assert.equal(events.some(({ event }) => event === 'VERIFIER_RECORDED'), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('whole-branch reviewer is proven read-only before its completion event is accepted', async () => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
    const deps = executionDependencies({
      repoRoot: repo,
      verifierResults: [{ status: 0, stdout: 'green\n', stderr: '' }],
    });
    let head = BASELINE;
    deps.options.git.head = () => head;
    const review = deps.options.reviewer.run;
    deps.options.reviewer.run = (...args) => {
      const result = review(...args);
      head = 'f'.repeat(40);
      return result;
    };
    await assert.rejects(
      () => runLoopController(GOAL_PATH, deps.options),
      /reviewer.*read-only|read-only.*reviewer/iu,
    );
    const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
    assert.equal(events.some(({ event }) => event === 'REVIEW_COMPLETED'), false);
    assert.equal(events.filter(({ event }) => event === 'ATTEMPT_RESERVED').length, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a model child cannot move HEAD because controller commits have exclusive ownership', async () => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText({ budget: '1' }), { expect: 'goal', family: 'goal' });
    const deps = executionDependencies({
      repoRoot: repo,
      verifierResults: [
        { status: 1, stdout: 'red\n', stderr: '' },
        { status: 0, stdout: 'green\n', stderr: '' },
      ],
      changedPaths: [['scripts/fix.mjs']],
    });
    let head = BASELINE;
    deps.options.git.head = () => head;
    const run = deps.options.runner.run;
    deps.options.runner.run = (...args) => {
      const result = run(...args);
      head = 'f'.repeat(40);
      return result;
    };
    const result = await runLoopController(GOAL_PATH, deps.options);
    assert.equal(result.status, 'HALTED');
    assert.equal(deps.commits.length, 0);
    const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
    assert.equal(events.at(-1).event, 'RUN_HALTED');
    assert.equal(events.filter(({ event }) => event === 'VERIFIER_RECORDED').length, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('resume spends an interrupted reservation and always advances to a fresh attempt identity', async () => {
  for (const crashPoint of ['after-attempt-1-reserved', 'after-attempt-1-raw-evidence']) {
    const repo = fixture();
    try {
      writeWorkPath(repo, GOAL_PATH, goalText({ budget: '2' }), { expect: 'goal', family: 'goal' });
      const first = executionDependencies({
        repoRoot: repo,
        verifierResults: [
          { status: 1, stdout: 'baseline red\n', stderr: '' },
          { status: 1, stdout: 'unused attempt result\n', stderr: '' },
        ],
        changedPaths: [[]],
      });
      first.options.crashHook = (name) => {
        if (name === crashPoint) throw new Error(`simulated ${crashPoint}`);
      };
      await assert.rejects(() => runLoopController(GOAL_PATH, first.options), /simulated/iu);
      if (crashPoint.endsWith('raw-evidence')) {
        assert.doesNotThrow(() => readWorkPath(
          repo,
          `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-attempt-1.raw.jsonl`,
          { family: 'runner-raw' },
        ));
      }

      const resumed = executionDependencies({
        repoRoot: repo,
        verifierResults: [{ status: 0, stdout: 'green\n', stderr: '' }],
        changedPaths: [[], ['scripts/second.mjs']],
      });
      resumed.options.resume = true;
      resumed.options.ledgerPath = LEDGER_PATH;
      const result = await runLoopController(GOAL_PATH, resumed.options);
      assert.equal(result.outcome, 'GOAL_REACHED', crashPoint);
      assert.deepEqual(
        resumed.calls.filter(({ kind }) => kind === 'runner').map(({ attempt }) => attempt),
        [2],
        crashPoint,
      );
      const state = reduceWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
      assert.deepEqual(state.reservedAttempts, [1, 2], crashPoint);
      assert.equal(state.attempts[0].spent, true, crashPoint);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('an interrupted final reservation halts explicitly instead of reusing exhausted budget', async () => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText({ budget: '1' }), { expect: 'goal', family: 'goal' });
    const first = executionDependencies({
      repoRoot: repo,
      verifierResults: [{ status: 1, stdout: 'red\n', stderr: '' }],
    });
    first.options.crashHook = (name) => {
      if (name === 'after-attempt-1-reserved') throw new Error('simulated reservation crash');
    };
    await assert.rejects(() => runLoopController(GOAL_PATH, first.options), /reservation crash/u);
    const resumed = executionDependencies({ repoRoot: repo, verifierResults: [] });
    resumed.options.resume = true;
    resumed.options.ledgerPath = LEDGER_PATH;
    const result = await runLoopController(GOAL_PATH, resumed.options);
    assert.equal(result.status, 'HALTED');
    assert.equal(resumed.calls.some(({ kind }) => kind === 'runner'), false);
    const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
    assert.equal(events.at(-1).event, 'RUN_HALTED');
    assert.match(events.at(-1).reason, /interrupted.*budget|budget.*interrupted/iu);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('review proof detects tracked and untracked same-path byte mutation even when HEAD and path names stay fixed', async () => {
  for (const kind of ['tracked', 'untracked']) {
    const repo = fixture();
    try {
      writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
      const deps = executionDependencies({
        repoRoot: repo,
        verifierResults: [{ status: 0, stdout: 'green\n', stderr: '' }],
      });
      let mutated = false;
      deps.options.git.snapshot = () => ({
        head: BASELINE,
        indexTree: 'f'.repeat(40),
        trackedDiffDigest: createHash('sha256').update(mutated && kind === 'tracked' ? 'after' : 'before').digest('hex'),
        untracked: [{
          path: 'scratch.txt', type: 'file',
          digest: createHash('sha256').update(mutated && kind === 'untracked' ? 'after' : 'before').digest('hex'),
        }],
      });
      const review = deps.options.reviewer.run;
      deps.options.reviewer.run = (...args) => {
        const result = review(...args);
        mutated = true;
        return result;
      };
      await assert.rejects(
        () => runLoopController(GOAL_PATH, deps.options),
        /reviewer.*read-only|read-only.*reviewer/iu,
        kind,
      );
      const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
      assert.equal(events.some(({ event }) => event === 'REVIEW_COMPLETED'), false, kind);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('attempt and review diff evidence are create-new, digest-bound, and event-correlated', async () => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText({ budget: '1' }), { expect: 'goal', family: 'goal' });
    const deps = executionDependencies({
      repoRoot: repo,
      verifierResults: [
        { status: 1, stdout: 'red\n', stderr: '' },
        { status: 0, stdout: 'green\n', stderr: '' },
      ],
      changedPaths: [['scripts/fix.mjs', 'tests/new.test.mjs']],
    });
    deps.options.git.diff = () => ({
      text: 'diff --git a/scripts/fix.mjs b/scripts/fix.mjs\n+fixed\n',
      untracked: ['tests/new.test.mjs'],
    });
    const result = await runLoopController(GOAL_PATH, deps.options);
    assert.equal(result.outcome, 'GOAL_REACHED');
    const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
    const child = events.find(({ event }) => event === 'CHILD_COMPLETED');
    assert.equal(child.attempt, 1);
    assert.equal(child.diffPath, `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-attempt-1-diff.txt`);
    const diffBytes = readWorkPath(repo, child.diffPath, { family: 'runner-diff' });
    assert.match(diffBytes.toString('utf8'), /tests\/new\.test\.mjs/u);
    assert.equal(child.diffDigest, createHash('sha256').update(diffBytes).digest('hex'));
    const review = deps.calls.find(({ kind }) => kind === 'reviewer');
    const reviewEvent = events.find(({ event }) => event === 'REVIEW_COMPLETED');
    assert.match(review.diffPath, /-review-1-diff\.txt$/u);
    assert.match(review.prompt, new RegExp(review.diffPath.replaceAll('.', '\\.'), 'u'));
    const reviewBytes = readWorkPath(repo, review.diffPath, { family: 'reviewer-diff' });
    assert.match(reviewBytes.toString('utf8'), new RegExp(child.diffPath.replaceAll('.', '\\.'), 'u'));
    assert.equal(reviewEvent.diffPath, review.diffPath);
    assert.equal(reviewEvent.diffDigest, createHash('sha256').update(reviewBytes).digest('hex'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('immutable diff publication failure cannot publish a correlated CHILD_COMPLETED event', async () => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText({ budget: '1' }), { expect: 'goal', family: 'goal' });
    const collision = `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-attempt-1-diff.txt`;
    writeWorkPath(repo, collision, 'collision\n', { family: 'runner-diff' });
    const deps = executionDependencies({
      repoRoot: repo,
      verifierResults: [{ status: 1, stdout: 'red\n', stderr: '' }],
      changedPaths: [['scripts/fix.mjs']],
    });
    await assert.rejects(() => runLoopController(GOAL_PATH, deps.options), /already exists/iu);
    const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
    assert.equal(events.some(({ event }) => event === 'CHILD_COMPLETED'), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('review and terminal durable prefixes resume without duplicate terminality or evidence collisions', async () => {
  for (const crashPoint of [
    'after-review-1-completed',
    'after-terminal-recorded',
    'after-final-diff',
    'after-goal-consumed',
  ]) {
    const repo = fixture();
    try {
      writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
      const deps = executionDependencies({
        repoRoot: repo,
        verifierResults: [{ status: 0, stdout: 'green\n', stderr: '' }],
        reviews: ['approved', 'approved'],
      });
      deps.options.crashHook = (name) => {
        if (name === crashPoint) throw new Error(`simulated ${crashPoint}`);
      };
      await assert.rejects(() => runLoopController(GOAL_PATH, deps.options), /simulated/iu);
      deps.options.crashHook = () => {};
      deps.options.resume = true;
      deps.options.ledgerPath = LEDGER_PATH;
      const result = await runLoopController(GOAL_PATH, deps.options);
      assert.equal(result.outcome, 'GOAL_REACHED', crashPoint);
      const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
      assert.equal(events.filter(({ event }) => event === 'TERMINAL_RECORDED').length, 1, crashPoint);
      assert.match(readWorkPath(repo, GOAL_PATH, { family: 'goal', encoding: 'utf8' }), /status: CONSUMED/u);
      assert.match(readWorkPath(repo, LEDGER_PATH, { family: 'ledger', encoding: 'utf8' }), /status: READY/u);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('deterministic runtime/fake-runner evidence: unbound abandoned review artifacts halt instead of becoming authority', async () => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
    const deps = executionDependencies({
      repoRoot: repo,
      verifierResults: [{ status: 0, stdout: 'green\n', stderr: '' }],
    });
    deps.options.crashHook = (point) => {
      if (point === 'after-review-1-evidence') throw new Error('unbound review result');
    };
    await assert.rejects(() => runLoopController(GOAL_PATH, deps.options), /unbound review result/u);
    const callsBeforeResume = deps.calls.length;
    deps.options.resume = true;
    deps.options.ledgerPath = LEDGER_PATH;
    deps.options.crashHook = () => {};
    const result = await runLoopController(GOAL_PATH, deps.options);
    assert.equal(result.status, 'HALTED');
    assert.equal(deps.calls.slice(callsBeforeResume).some(({ kind }) => kind === 'reviewer'), false);
    const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
    assert.equal(events.some(({ event }) => event === 'REVIEW_COMPLETED'), false);
    assert.deepEqual(events.slice(-2).map(({ event }) => event), [
      'RECONCILIATION_REQUIRED', 'RUN_HALTED',
    ]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('deterministic runtime/fake-runner evidence: terminal replay proves Git state before projections', async () => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
    const deps = executionDependencies({
      repoRoot: repo,
      verifierResults: [{ status: 0, stdout: 'green\n', stderr: '' }],
    });
    deps.options.crashHook = (point) => {
      if (point === 'after-terminal-recorded') throw new Error('terminal event durable');
    };
    await assert.rejects(() => runLoopController(GOAL_PATH, deps.options), /terminal event durable/u);
    const forged = 'f'.repeat(40);
    const snapshot = deps.options.git.snapshot;
    deps.options.git.head = () => forged;
    deps.options.git.status = () => ' M foreign.txt';
    deps.options.git.snapshot = (...args) => ({ ...snapshot(...args), head: forged });
    deps.options.resume = true;
    deps.options.ledgerPath = LEDGER_PATH;
    deps.options.crashHook = () => {};
    const result = await runLoopController(GOAL_PATH, deps.options);
    assert.equal(result.status, 'HALTED');
    assert.match(readWorkPath(repo, GOAL_PATH, { family: 'goal', encoding: 'utf8' }), /status: READY/u);
    assert.match(readWorkPath(repo, LEDGER_PATH, { family: 'ledger', encoding: 'utf8' }), /status: DRAFT/u);
    assert.equal(existsSync(join(repo, '.apex/work/loops/2026-09-03-demo-loop/branch-diff.txt')), true);
    const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
    assert.deepEqual(events.slice(-2).map(({ event }) => event), [
      'RECONCILIATION_REQUIRED', 'RUN_HALTED',
    ]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('deterministic runtime/fake-runner evidence: after-return hooks expose the pre-persistence gaps', async () => {
  for (const boundary of ['child', 'review']) {
    const repo = fixture();
    try {
      writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
      const deps = executionDependencies({
        repoRoot: repo,
        verifierResults: boundary === 'child'
          ? [{ status: 1, stdout: 'red\n', stderr: '' }]
          : [{ status: 0, stdout: 'green\n', stderr: '' }],
      });
      const point = boundary === 'child' ? 'after-child-return' : 'after-loop-branch-review';
      deps.options.crashHook = (candidate) => {
        if (candidate === point) throw new Error(`${boundary} return gap`);
      };
      await assert.rejects(() => runLoopController(GOAL_PATH, deps.options), /return gap/u);
      const stem = boundary === 'child'
        ? `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-attempt-1`
        : `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-review-1`;
      assert.equal(existsSync(join(repo, `${stem}.raw.jsonl`)), false, boundary);
      assert.equal(existsSync(join(repo, `${stem}.log`)), false, boundary);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('deterministic runtime/fake-runner evidence: pre-intent commit preparation repeats one identity', async () => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText({ budget: '1' }), { expect: 'goal', family: 'goal' });
    const deps = executionDependencies({
      repoRoot: repo,
      verifierResults: [
        { status: 1, stdout: 'baseline red\n', stderr: '' },
        { status: 0, stdout: 'green\n', stderr: '' },
      ],
    });
    deps.options.crashHook = (point) => {
      if (point === 'before-commit-intent') throw new Error('pre-intent preparation crash');
    };
    await assert.rejects(() => runLoopController(GOAL_PATH, deps.options), /pre-intent preparation crash/u);
    const intended = deps.prepared[0].commit;
    deps.options.resume = true;
    deps.options.ledgerPath = LEDGER_PATH;
    deps.options.crashHook = () => {};
    assert.equal((await runLoopController(GOAL_PATH, deps.options)).outcome, 'GOAL_REACHED');
    assert.deepEqual(deps.prepared.map(({ commit }) => commit), [intended, intended]);
    assert.equal(deps.commits.length, 1);
    assert.equal(deps.commits[0].commit, intended);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('deterministic runtime/fake-runner evidence: commit crashes reconcile once without respawn or recommit', async () => {
  for (const crashPoint of ['before-git-commit', 'after-git-commit']) {
    const repo = fixture();
    try {
      writeWorkPath(repo, GOAL_PATH, goalText({ budget: '1' }), { expect: 'goal', family: 'goal' });
      const deps = executionDependencies({
        repoRoot: repo,
        verifierResults: [
          { status: 1, stdout: 'baseline red\n', stderr: '' },
          { status: 0, stdout: 'green\n', stderr: '' },
        ],
      });
      deps.options.crashHook = (point) => {
        if (point === crashPoint) throw new Error(`simulated ${crashPoint}`);
      };
      await assert.rejects(() => runLoopController(GOAL_PATH, deps.options), /simulated/iu);
      const callsBeforeResume = deps.calls.length;
      deps.options.resume = true;
      deps.options.ledgerPath = LEDGER_PATH;
      deps.options.crashHook = () => {};
      const result = await runLoopController(GOAL_PATH, deps.options);
      assert.equal(result.outcome, 'GOAL_REACHED', crashPoint);
      const resumedCalls = deps.calls.slice(callsBeforeResume);
      assert.equal(resumedCalls.some(({ kind }) => kind === 'runner'), false, crashPoint);
      assert.equal(deps.calls.filter(({ kind }) => kind === 'commit').length, 1, crashPoint);
      const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
      assert.equal(events.filter(({ event }) => event === 'ATTEMPT_RESERVED').length, 1, crashPoint);
      assert.equal(events.filter(({ event }) => event === 'COMMIT_RECORDED').length, 1, crashPoint);
      assert.equal(events.filter(({ event }) => event === 'TERMINAL_RECORDED').length, 1, crashPoint);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('deterministic runtime/fake-runner evidence: child event replay regenerates stale ledger without duplicate spawn', async () => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText({ budget: '1' }), { expect: 'goal', family: 'goal' });
    const deps = executionDependencies({
      repoRoot: repo,
      verifierResults: [
        { status: 1, stdout: 'baseline red\n', stderr: '' },
        { status: 0, stdout: 'green\n', stderr: '' },
      ],
    });
    deps.options.crashHook = (point) => {
      if (point === 'after-event-append:CHILD_COMPLETED') throw new Error('simulated child event crash');
    };
    await assert.rejects(() => runLoopController(GOAL_PATH, deps.options), /child event crash/u);
    writeWorkPath(repo, LEDGER_PATH, 'stale projection bytes\n', { family: 'ledger' });
    const callsBeforeResume = deps.calls.length;
    deps.options.resume = true;
    deps.options.ledgerPath = LEDGER_PATH;
    deps.options.crashHook = () => {};
    const result = await runLoopController(GOAL_PATH, deps.options);
    assert.equal(result.outcome, 'GOAL_REACHED');
    assert.equal(deps.calls.slice(callsBeforeResume).some(({ kind }) => kind === 'runner'), false);
    assert.match(readWorkPath(repo, LEDGER_PATH, { family: 'ledger', encoding: 'utf8' }), /status: READY/u);
    const state = reduceWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
    assert.deepEqual(state.reservedAttempts, [1]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('deterministic runtime/fake-runner evidence: branch and dirty replay drift halt without mutation', async () => {
  for (const hazard of ['branch', 'dirty']) {
    const repo = fixture();
    try {
      writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
      const first = dependencies({ repoRoot: repo });
      first.options.crashHook = (point) => {
        if (point === 'after-event-append:RUN_STARTED') throw new Error('durable start crash');
      };
      await assert.rejects(() => runLoopController(GOAL_PATH, first.options), /durable start crash/u);

      const resumed = executionDependencies({ repoRoot: repo, verifierResults: [] });
      resumed.options.resume = true;
      resumed.options.ledgerPath = LEDGER_PATH;
      if (hazard === 'branch') resumed.options.git.branch = () => 'feature/foreign';
      if (hazard === 'dirty') resumed.options.git.status = () => ' M foreign.txt';
      const result = await runLoopController(GOAL_PATH, resumed.options);
      assert.equal(result.status, 'HALTED', hazard);
      assert.equal(resumed.calls.some(({ kind }) => kind === 'runner'), false, hazard);
      assert.equal(resumed.calls.some(({ kind }) => ['commit', 'discard'].includes(kind)), false, hazard);
      const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
      assert.deepEqual(events.slice(-2).map(({ event }) => event), [
        'RECONCILIATION_REQUIRED', 'RUN_HALTED',
      ], hazard);
      assert.match(readWorkPath(repo, GOAL_PATH, { family: 'goal', encoding: 'utf8' }), /status: READY/u);
      assert.match(readWorkPath(repo, LEDGER_PATH, { family: 'ledger', encoding: 'utf8' }), /status: DRAFT/u);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('a halted run is permanently abandoned, including a consumed-goal terminal prefix, and repeated resume is inert', async () => {
  for (const consumedPrefix of [false, true]) {
    const repo = fixture();
    try {
      writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
      const deps = executionDependencies({
        repoRoot: repo,
        verifierResults: [{ status: 0, stdout: 'green\n', stderr: '' }],
      });
      if (consumedPrefix) {
        deps.options.crashHook = (point) => {
          if (point === 'after-goal-consumed') throw new Error('consumed terminal prefix');
        };
        await assert.rejects(() => runLoopController(GOAL_PATH, deps.options), /consumed terminal prefix/u);
      } else {
        deps.options.crashHook = (point) => {
          if (point === 'after-event-append:RUN_STARTED') throw new Error('durable start prefix');
        };
        await assert.rejects(() => runLoopController(GOAL_PATH, deps.options), /durable start prefix/u);
      }
      deps.options.resume = true;
      deps.options.ledgerPath = LEDGER_PATH;
      deps.options.crashHook = () => {};
      deps.options.git.branch = () => 'feature/foreign';
      const halted = await runLoopController(GOAL_PATH, deps.options);
      assert.equal(halted.status, 'HALTED', `consumed=${consumedPrefix}`);
      const haltedBytes = readWorkPath(repo, EVENTS_PATH, { family: 'events' });

      for (let repetition = 0; repetition < 2; repetition += 1) {
        const repeated = await runLoopController(GOAL_PATH, deps.options);
        assert.equal(repeated.status, 'HALTED', `consumed=${consumedPrefix}, repetition=${repetition}`);
        assert.deepEqual(
          readWorkPath(repo, EVENTS_PATH, { family: 'events' }),
          haltedBytes,
          'permanently abandoned resume must not append or reuse identities',
        );
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('deterministic runtime/fake-runner evidence: forged commit proof records reconciliation and never commits', async () => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText({ budget: '1' }), { expect: 'goal', family: 'goal' });
    const deps = executionDependencies({
      repoRoot: repo,
      verifierResults: [
        { status: 1, stdout: 'baseline red\n', stderr: '' },
        { status: 0, stdout: 'green\n', stderr: '' },
      ],
    });
    deps.options.crashHook = (point) => {
      if (point === 'after-commit-intent') throw new Error('intent durable');
    };
    await assert.rejects(() => runLoopController(GOAL_PATH, deps.options), /intent durable/u);
    deps.options.resume = true;
    deps.options.ledgerPath = LEDGER_PATH;
    deps.options.crashHook = () => {};
    const inspect = deps.options.git.inspectCommit;
    deps.options.git.inspectCommit = (...args) => ({ ...inspect(...args), unique: false });
    const result = await runLoopController(GOAL_PATH, deps.options);
    assert.equal(result.status, 'HALTED');
    assert.equal(deps.calls.filter(({ kind }) => kind === 'runner').length, 1);
    assert.equal(deps.calls.some(({ kind }) => kind === 'commit'), false);
    assert.equal(deps.calls.some(({ kind }) => kind === 'discard'), false);
    const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
    assert.deepEqual(events.slice(-2).map(({ event }) => event), [
      'RECONCILIATION_REQUIRED', 'RUN_HALTED',
    ]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('deterministic runtime/fake-runner evidence: corrupt and substituted state fails closed byte-for-byte', async () => {
  for (const substitution of ['corrupt', 'symlink', 'hardlink', 'special']) {
    const repo = fixture();
    try {
      writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
      await runLoopController(GOAL_PATH, dependencies({ repoRoot: repo }).options);
      const eventAbsolute = join(repo, EVENTS_PATH);
      let protectedPath = eventAbsolute;
      if (substitution === 'corrupt') {
        const corrupt = Buffer.concat([readFileSync(eventAbsolute), Buffer.from('{"truncated":true}')]);
        writeFileSync(eventAbsolute, corrupt);
      } else if (substitution === 'special') {
        const ledgerAbsolute = join(repo, LEDGER_PATH);
        unlinkSync(ledgerAbsolute);
        mkdirSync(ledgerAbsolute);
        protectedPath = ledgerAbsolute;
      } else {
        const outside = join(repo, `${substitution}-events.jsonl`);
        writeFileSync(outside, readFileSync(eventAbsolute));
        unlinkSync(eventAbsolute);
        if (substitution === 'symlink') symlinkSync(outside, eventAbsolute);
        else linkSync(outside, eventAbsolute);
        protectedPath = outside;
      }
      const before = substitution === 'special' ? null : readFileSync(protectedPath);
      const resumed = dependencies({ repoRoot: repo, resume: true, ledgerPath: LEDGER_PATH });
      await assert.rejects(() => runLoopController(GOAL_PATH, resumed.options), /work artifact|symlink|link|file|JSONL|truncated/iu);
      if (before !== null) assert.deepEqual(readFileSync(protectedPath), before, substitution);
      assert.equal(resumed.calls.includes('runner-run'), false, substitution);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('deterministic runtime/fake-runner hostile/replay matrix crashes and resumes every external and lifecycle boundary', async (t) => {
  const scenarios = [
    { point: 'before-reservation' },
    { point: 'after-reservation' },
    { point: 'before-child-return' },
    {
      point: 'after-child-return', expectedOutcome: null,
      expectedReviewers: 0, expectedCommits: 0,
    },
    { point: 'before-verifier-result', occurrence: 1 },
    {
      point: 'after-verifier-result', occurrence: 1,
      verifierResults: [
        { status: 1, stdout: 'baseline red\n', stderr: '' },
        { status: 1, stdout: 'baseline red replay\n', stderr: '' },
        { status: 0, stdout: 'green\n', stderr: '' },
      ],
    },
    { point: 'before-verifier-result', occurrence: 2 },
    { point: 'after-verifier-result', occurrence: 2 },
    { point: 'before-commit-intent' },
    { point: 'after-commit-intent' },
    { point: 'before-git-commit' },
    { point: 'after-git-commit' },
    { point: 'before-loop-branch-review' },
    {
      point: 'after-loop-branch-review', expectedOutcome: null,
      expectedCommits: 1,
    },
    { point: 'before-terminal-event' },
    { point: 'after-terminal-event' },
    { point: 'before-goal-transition' },
    { point: 'after-goal-transition' },
    { point: 'before-ledger-render' },
    { point: 'after-ledger-render' },
    { point: 'before-ledger-transition' },
    { point: 'after-ledger-transition' },
  ];
  for (const scenario of scenarios) {
    await t.test(`${scenario.point}:${scenario.occurrence ?? 1}`, () => assertCrashReplay(scenario));
  }
});

test('deterministic runtime/fake-runner hostile/replay matrix crashes and resumes every immutable artifact boundary', async (t) => {
  for (const family of ['runner-raw', 'runner-log', 'runner-diff']) {
    for (const edge of ['before', 'after']) {
      const point = `${edge}-immutable-artifact:${family}`;
      await t.test(point, () => assertCrashReplay({
        point,
        expectedOutcome: null,
        expectedReviewers: 0,
        expectedCommits: 0,
      }));
    }
  }
  for (const family of ['reviewer-diff']) {
    for (const edge of ['before', 'after']) {
      const point = `${edge}-immutable-artifact:${family}`;
      await t.test(point, () => assertCrashReplay({ point }));
    }
  }
  for (const family of ['reviewer-raw', 'reviewer-log']) {
    for (const edge of ['before', 'after']) {
      const point = `${edge}-immutable-artifact:${family}`;
      await t.test(point, () => assertCrashReplay({
        point,
        expectedOutcome: null,
        expectedCommits: 1,
      }));
    }
  }
  for (const edge of ['before', 'after']) {
    const point = `${edge}-immutable-artifact:branch-diff`;
    await t.test(point, () => assertCrashReplay({ point }));
  }
});

test('deterministic runtime/fake-runner hostile/replay matrix crashes and resumes every successful event append', async (t) => {
  const names = [
    'RUN_STARTED', 'ATTEMPT_RESERVED', 'CHILD_COMPLETED', 'BLAST_RADIUS_CHECKED',
    'VERIFIER_RECORDED', 'COMMIT_INTENT', 'COMMIT_RECORDED', 'REVIEW_COMPLETED',
    'TERMINAL_RECORDED',
  ];
  for (const name of names) {
    for (const edge of ['before', 'after']) {
      const point = `${edge}-event-append:${name}`;
      const scenario = { point };
      if (edge === 'before' && name === 'RUN_STARTED') {
        scenario.verifierResults = [
          { status: 1, stdout: 'baseline red\n', stderr: '' },
          { status: 1, stdout: 'baseline red replay\n', stderr: '' },
          { status: 0, stdout: 'green\n', stderr: '' },
        ];
      }
      if (edge === 'before' && name === 'CHILD_COMPLETED') {
        Object.assign(scenario, {
          expectedOutcome: null, expectedReviewers: 0, expectedCommits: 0,
        });
      }
      if (edge === 'before' && name === 'REVIEW_COMPLETED') {
        Object.assign(scenario, { expectedOutcome: null, expectedCommits: 1 });
      }
      await t.test(point, () => assertCrashReplay(scenario));
    }
  }
});

test('deterministic runtime/fake-runner hostile/replay matrix binds and replays discard before owned cleanup', async (t) => {
  for (const point of [
    'before-discard-intent', 'after-discard-intent',
    'before-git-discard', 'after-git-discard',
    'before-event-append:DISCARD_INTENT', 'after-event-append:DISCARD_INTENT',
    'before-event-append:DISCARD_RECORDED', 'after-event-append:DISCARD_RECORDED',
  ]) {
    await t.test(point, () => assertCrashReplay({
      point,
      budget: '1',
      mode: 'metric',
      metricDirection: 'min',
      verifierResults: [
        { status: 0, stdout: '10\n', stderr: '' },
        { status: 0, stdout: '11\n', stderr: '' },
      ],
      expectedOutcome: 'NO_IMPROVEMENT',
      expectedCommits: 0,
      expectedDiscards: 1,
    }));
  }
});

test('deterministic runtime/fake-runner hostile/replay matrix crashes and resumes every halt event append', async (t) => {
  for (const event of ['RECONCILIATION_REQUIRED', 'RUN_HALTED']) {
    for (const edge of ['before', 'after']) {
      const point = `${edge}-event-append:${event}`;
      await t.test(point, async () => {
        const repo = fixture();
        try {
          writeWorkPath(repo, GOAL_PATH, goalText({ budget: '1' }), {
            expect: 'goal', family: 'goal',
          });
          const deps = executionDependencies({
            repoRoot: repo,
            verifierResults: [
              { status: 1, stdout: 'baseline red\n', stderr: '' },
              { status: 0, stdout: 'green\n', stderr: '' },
            ],
          });
          deps.options.crashHook = (candidate) => {
            if (candidate === 'after-loop-branch-review') throw new Error('unbound review result');
          };
          await assert.rejects(() => runLoopController(GOAL_PATH, deps.options), /unbound review result/u);

          deps.options.resume = true;
          deps.options.ledgerPath = LEDGER_PATH;
          deps.options.crashHook = (candidate) => {
            if (candidate === point) throw new Error(`crash at ${point}`);
          };
          await assert.rejects(() => runLoopController(GOAL_PATH, deps.options), /crash at/u);

          deps.options.crashHook = () => {};
          const result = await runLoopController(GOAL_PATH, deps.options);
          assert.equal(result.status, 'HALTED');
          assert.equal(deps.calls.filter(({ kind }) => kind === 'runner').length, 1);
          assert.equal(deps.calls.filter(({ kind }) => kind === 'reviewer').length, 1);
          assert.equal(deps.commits.length, 1);
          assert.equal(deps.discards.length, 0);
          const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
          assert.equal(events.filter(({ event: name }) => name === 'RECONCILIATION_REQUIRED').length, 1);
          assert.equal(events.filter(({ event: name }) => name === 'RUN_HALTED').length, 1);
          assert.match(readWorkPath(repo, GOAL_PATH, { family: 'goal', encoding: 'utf8' }), /status: READY/u);
          assert.match(readWorkPath(repo, LEDGER_PATH, { family: 'ledger', encoding: 'utf8' }), /status: DRAFT/u);
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });
    }
  }
});

test('reviewer envelope accepts only the exact DONE status promised by its prompt', async () => {
  for (const status of ['DONE_WITH_CONCERNS', 'BLOCKED', 'NEEDS_CONTEXT', 'done']) {
    const repo = fixture();
    try {
      writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
      const deps = executionDependencies({
        repoRoot: repo,
        verifierResults: [{ status: 0, stdout: 'green\n', stderr: '' }],
        reviewStatuses: [status],
      });
      await assert.rejects(() => runLoopController(GOAL_PATH, deps.options), /status.*allowed/iu, status);
      const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
      assert.equal(events.some(({ event }) => event === 'REVIEW_COMPLETED'), false, status);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('real Git ownership snapshot refuses same-path byte drift before destructive discard', async () => {
  const repo = fixture();
  try {
    execFileSync('git', ['init', '-b', 'feature/loop'], { cwd: repo });
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    writeFileSync(join(repo, '.gitignore'), '.apex/work/\n');
    writeFileSync(join(repo, 'scripts', 'metric.mjs'), 'export const score = 10;\n');
    writeSingleRoute(repo);
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Steepy', '-c', 'user.email=steepy@example.invalid', 'commit', '-m', 'baseline'], { cwd: repo });
    writeWorkPath(repo, GOAL_PATH, goalText({
      mode: 'metric', 'metric-direction': 'min', budget: '1',
    }), { expect: 'goal', family: 'goal' });
    const git = createCliGitAdapter();
    const runner = {
      descriptor: (_harness, _prompt, { modelTier }) => ({
        cmd: 'codex', args: [], protocol: 'jsonl', requestedModelTier: modelTier,
        modelSelection: 'applied', resolvedModel: 'fixture-model',
      }),
      run(_descriptor, context) {
        writeFileSync(join(repo, 'scripts', 'metric.mjs'), 'export const score = 11;\n');
        writeWorkPath(repo, context.reportPath, 'attempt report\n', { family: 'runner-report' });
        return {
          status: 0,
          output: `status: DONE\nartifact: ${context.reportPath}\nchanged-paths: scripts/metric.mjs\nsignals: none\n`,
          raw: '{"done":true}\n',
          readable: 'done\n',
        };
      },
    };
    let verifierCall = 0;
    const result = await runLoopController(GOAL_PATH, {
      repoRoot: repo,
      harness: 'codex',
      commitAuthorized: true,
      expectedBranch: 'feature/loop',
      routingPath: ROUTING_PATH,
      standardPaths: [SCRIPT_STANDARD],
      runner,
      reviewer: { run: () => assert.fail('reviewer must not run') },
      verifier: {
        run() {
          verifierCall += 1;
          if (verifierCall === 1) return { status: 0, stdout: '10\n', stderr: '' };
          writeFileSync(join(repo, 'scripts', 'metric.mjs'), 'export const score = 999;\n');
          return { status: 0, stdout: '11\n', stderr: '' };
        },
      },
      git,
      clock: () => '2026-09-03T12:00:00.000Z',
      uuid: (() => {
        const ids = [RUN_ID, LOCK_TOKEN];
        return () => ids.shift() ?? LOCK_TOKEN;
      })(),
      crashHook() {},
      processProbe: () => false,
    });
    assert.equal(result.status, 'HALTED');
    assert.equal(readFileSync(join(repo, 'scripts', 'metric.mjs'), 'utf8'), 'export const score = 999;\n');
    const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
    assert.equal(events.some(({ event }) => event === 'DISCARD_INTENT'), false);
    assert.match(events.at(-1).reason, /snapshot|drift|owned/iu);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI streaming persists raw evidence while the child is alive and leaves readable output usable', async () => {
  const repo = fixture();
  try {
    const rawPath = `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-attempt-1.raw.jsonl`;
    const readablePath = `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-attempt-1.log`;
    const script = [
      "const fs = require('node:fs');",
      "const raw = process.argv[1];",
      "process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'probe'}})+'\\n');",
      "const timer=setInterval(()=>{",
      "  if (fs.existsSync(raw) && fs.readFileSync(raw,'utf8').includes('item.completed')) {",
      "    clearInterval(timer);",
      "    process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'status: DONE\\nartifact: report.md\\nchanged-paths: none\\nsignals: none'}})+'\\n');",
      "    process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n');",
      "    clearTimeout(timeout);",
      "  }",
      "}, 5);",
      "const timeout=setTimeout(()=>process.exit(42), 1500);",
    ].join('');
    const result = await runStreamingHeadlessDescriptor(
      { cmd: process.execPath, args: ['-e', script, join(repo, rawPath)] },
      'codex',
      repo,
      { rawPath, readablePath, liveStdout: { write() { return true; } }, liveStderr: { write() { return true; } } },
    );
    assert.equal(result.status, 0, JSON.stringify(result));
    assert.match(result.output, /status: DONE/u);
    assert.match(readWorkPath(repo, rawPath, { family: 'runner-raw', encoding: 'utf8' }), /item\.completed/u);
    assert.ok(readWorkPath(repo, readablePath, { family: 'runner-log' }).length > 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI streaming interruption preserves the fsynced raw prefix', async () => {
  const repo = fixture();
  try {
    const rawPath = `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-attempt-1.raw.jsonl`;
    const readablePath = `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-attempt-1.log`;
    const script = "process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'abc'})+'\\n');setTimeout(()=>process.kill(process.pid,'SIGTERM'),30);";
    const result = await runStreamingHeadlessDescriptor(
      { cmd: process.execPath, args: ['-e', script] },
      'codex',
      repo,
      { rawPath, readablePath, liveStdout: { write() { return true; } }, liveStderr: { write() { return true; } } },
    );
    assert.equal(result.signal, 'SIGTERM');
    assert.match(readWorkPath(repo, rawPath, { family: 'runner-raw', encoding: 'utf8' }), /thread\.started/u);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI streaming treats raw failure as blocking and cosmetic output failure as degradation', async () => {
  const repo = fixture();
  try {
    const rawPath = `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-attempt-1.raw.jsonl`;
    const readablePath = `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-attempt-1.log`;
    writeWorkPath(repo, rawPath, 'collision\n', { family: 'runner-raw' });
    const blocked = await runStreamingHeadlessDescriptor(
      { cmd: process.execPath, args: ['-e', 'process.exit(0)'] },
      'codex',
      repo,
      { rawPath, readablePath, liveStdout: { write() { return true; } }, liveStderr: { write() { return true; } } },
    );
    assert.match(blocked.error.message, /raw-open/iu);
    unlinkSync(join(repo, rawPath));

    const degraded = await runStreamingHeadlessDescriptor(
      {
        cmd: process.execPath,
        args: ['-e', "process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'abc'})+'\\n')"],
      },
      'codex',
      repo,
      {
        rawPath,
        readablePath,
        liveStdout: { write(_chunk, callback) { callback?.(new Error('display failed')); return false; } },
        liveStderr: { write() { return true; } },
      },
    );
    assert.equal(degraded.status, 0);
    assert.equal(degraded.error, null);
    assert.equal(degraded.degraded, true);
    assert.match(readWorkPath(repo, rawPath, { family: 'runner-raw', encoding: 'utf8' }), /thread\.started/u);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('hostile implementers cannot change, replace, truncate, delete, or rewrite controller authority', async () => {
  const mutations = {
    change(path, bytes) { writeFileSync(path, Buffer.concat([bytes, Buffer.from('\nattacker-change\n')])); },
    replace(path, bytes) {
      renameSync(path, `${path}.attacker-backup`);
      writeFileSync(path, bytes);
    },
    truncate(path, bytes) { writeFileSync(path, bytes.subarray(0, Math.max(0, bytes.length >> 1))); },
    delete(path) { unlinkSync(path); },
    rewrite(path, bytes) { writeFileSync(path, bytes); },
  };

  for (const family of ['goal', 'events', 'ledger']) {
    for (const [mutationName, mutate] of Object.entries(mutations)) {
      const repo = fixture();
      try {
        const outside = join(repo, 'outside-sentinel.txt');
        writeFileSync(outside, 'outside stays\n');
        writeWorkPath(repo, GOAL_PATH, goalText({ budget: '2' }), { expect: 'goal', family: 'goal' });
        const deps = executionDependencies({
          repoRoot: repo,
          verifierResults: [
            { status: 1, stdout: 'red\n', stderr: '' },
            { status: 0, stdout: 'green\n', stderr: '' },
          ],
        });
        const baseRun = deps.options.runner.run;
        deps.options.runner.run = (...args) => {
          const result = baseRun(...args);
          const relative = { goal: GOAL_PATH, events: EVENTS_PATH, ledger: LEDGER_PATH }[family];
          const absolute = join(repo, relative);
          mutate(absolute, readFileSync(absolute));
          return result;
        };

        await assert.rejects(
          () => runLoopController(GOAL_PATH, deps.options),
          /CONTROLLER_ARTIFACT_DRIFT/u,
          `${family}/${mutationName}`,
        );
        assert.equal(readFileSync(outside, 'utf8'), 'outside stays\n', `${family}/${mutationName}`);
        assert.equal(deps.commits.length, 0, `${family}/${mutationName}: no commit`);
        assert.equal(deps.discards.length, 0, `${family}/${mutationName}: no discard`);
        assert.equal(deps.calls.filter(({ kind }) => kind === 'verifier').length, 1,
          `${family}/${mutationName}: no post-child verifier`);
        assert.equal(deps.calls.some(({ kind }) => kind === 'reviewer'), false,
          `${family}/${mutationName}: no review`);

        deps.options.resume = true;
        deps.options.ledgerPath = LEDGER_PATH;
        let resumed;
        try {
          resumed = await runLoopController(GOAL_PATH, deps.options);
        } catch (error) {
          assert.ok(error instanceof Error, `${family}/${mutationName}: resume refusal`);
        }
        assert.notEqual(resumed?.outcome, 'GOAL_REACHED', `${family}/${mutationName}: no terminal handoff`);
        assert.equal(deps.calls.filter(({ kind }) => kind === 'runner').length, 1,
          `${family}/${mutationName}: uncertain attempt is never rerun`);
        assert.equal(deps.commits.length, 0, `${family}/${mutationName}: resume does not commit`);
        assert.equal(deps.discards.length, 0, `${family}/${mutationName}: resume does not discard`);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  }
});

test('target-project routing carries exact custom and modular standards into both child prompts', async () => {
  const cases = [
    {
      surface: 'firmware',
      standardPaths: ['.apex/standards/firmware.md'],
      write(repo) {
        writeSingleRoute(repo, { surface: 'firmware', standardPath: '.apex/standards/firmware.md' });
      },
    },
    {
      surface: 'mobile',
      standardPaths: [
        '.apex/standards/mobile-core.md',
        '.apex/standards/mobile-ios.md',
        '.apex/standards/mobile-store.md',
      ],
      write(repo) {
        writeSingleRoute(repo, {
          surface: 'mobile',
          standardPath: '.apex/standards/mobile-core.md',
          standardText: [
            '# Mobile core standard', '', '## Mini-routing table', '',
            '| Concern | Standard |', '|---|---|',
            '| iOS | [iOS](mobile-ios.md) |',
            '| Store | [Store](mobile-store.md) |',
            '| Android | [Android](mobile-android.md) |', '',
          ].join('\n'),
        });
        for (const leaf of ['mobile-ios.md', 'mobile-store.md', 'mobile-android.md']) {
          writeFileSync(join(repo, '.apex', 'standards', leaf), `# ${leaf} standard\n`);
        }
      },
    },
  ];

  for (const scenario of cases) {
    const repo = fixture();
    try {
      writeWorkPath(repo, GOAL_PATH, goalText({ surface: scenario.surface, budget: '1' }), {
        expect: 'goal', family: 'goal',
      });
      const deps = executionDependencies({
        repoRoot: repo,
        verifierResults: [
          { status: 1, stdout: 'red\n', stderr: '' },
          { status: 0, stdout: 'green\n', stderr: '' },
        ],
      });
      scenario.write(repo);
      deps.options.routingPath = ROUTING_PATH;
      deps.options.standardPaths = scenario.standardPaths;
      const result = await runLoopController(GOAL_PATH, deps.options);
      assert.equal(result.outcome, 'GOAL_REACHED', scenario.surface);
      const implementer = deps.calls.find(({ kind, prompt }) => kind === 'descriptor' && prompt.includes(GOAL_PATH));
      const reviewer = deps.calls.find(({ kind }) => kind === 'reviewer');
      for (const call of [implementer, reviewer]) {
        assert.ok(call, `${scenario.surface}: child prompt exists`);
        assert.match(call.prompt, new RegExp(ROUTING_PATH.replaceAll('.', '\\.'), 'u'));
        let prior = -1;
        for (const path of scenario.standardPaths) {
          const index = call.prompt.indexOf(path);
          assert.ok(index > prior, `${scenario.surface}: ${path} preserves inventory order`);
          prior = index;
        }
        assert.doesNotMatch(call.prompt, /\.apex\/standards\/\[SURFACE\]|\.apex\/standards\/<surface>/u);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('unrouted and missing or malformed target standards refuse before runner, verifier, or mutation', async () => {
  const cases = [
    {
      name: 'unrouted built-in surface',
      surface: 'adapters',
      mutate() {},
    },
    {
      name: 'missing routed standard',
      surface: 'scripts',
      mutate(repo) { unlinkSync(join(repo, SCRIPT_STANDARD)); },
    },
    {
      name: 'malformed routed standard',
      surface: 'scripts',
      mutate(repo) { writeFileSync(join(repo, SCRIPT_STANDARD), 'not a governed standard\n'); },
    },
  ];
  for (const scenario of cases) {
    const repo = fixture();
    try {
      writeWorkPath(repo, GOAL_PATH, goalText({ surface: scenario.surface }), {
        expect: 'goal', family: 'goal',
      });
      const deps = executionDependencies({
        repoRoot: repo,
        verifierResults: [{ status: 1, stdout: 'red\n', stderr: '' }],
      });
      scenario.mutate(repo);
      await assert.rejects(() => runLoopController(GOAL_PATH, deps.options), LoopControllerError, scenario.name);
      assert.equal(deps.calls.some(({ kind }) => kind === 'runner'), false, scenario.name);
      assert.equal(deps.calls.some(({ kind }) => kind === 'verifier'), false, scenario.name);
      assert.equal(existsSync(join(repo, EVENTS_PATH)), false, scenario.name);
      assert.equal(deps.commits.length, 0, scenario.name);
      assert.equal(deps.discards.length, 0, scenario.name);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('every Gear-4 child receives a concrete tier matching its descriptor, with deterministic escalation/degradation', async () => {
  for (const harness of ['claude', 'codex', 'opencode']) {
    const repo = fixture();
    try {
      writeWorkPath(repo, GOAL_PATH, goalText({ budget: '2' }), { expect: 'goal', family: 'goal' });
      const deps = executionDependencies({
        repoRoot: repo,
        verifierResults: [
          { status: 1, stdout: 'red\n', stderr: '' },
          { status: 0, stdout: 'green\n', stderr: '' },
          { status: 0, stdout: 'green\n', stderr: '' },
        ],
        reviews: ['issues', 'approved'],
      });
      deps.options.harness = harness;
      deps.options.runner.descriptor = (_harness, prompt, descriptorInput) => {
        const modelMappings = harness === 'opencode'
          ? { standard: 'open-standard', 'most-capable': 'open-max' }
          : undefined;
        const descriptor = headlessCommand(harness, prompt, { ...descriptorInput, modelMappings });
        deps.calls.push({ kind: 'descriptor', prompt, ...descriptorInput, descriptor });
        return descriptor;
      };
      const baseReview = deps.options.reviewer.run;
      deps.options.reviewer.run = (prompt, context) => {
        assert.match(prompt, new RegExp(`model: ${context.modelTier}`, 'u'));
        assert.doesNotMatch(prompt, /<tier>|\[MODEL_TIER\]/u);
        const result = baseReview(prompt, context);
        const modelMappings = harness === 'opencode'
          ? { standard: 'open-standard', 'most-capable': 'open-max' }
          : undefined;
        return {
          ...result,
          descriptor: headlessCommand(harness, prompt, { modelTier: context.modelTier, modelMappings }),
        };
      };

      await runLoopController(GOAL_PATH, deps.options);
      const implementers = deps.calls.filter(({ kind, prompt, descriptor }) => (
        kind === 'descriptor' && descriptor && prompt.includes(GOAL_PATH)
      ));
      assert.deepEqual(implementers.map(({ modelTier }) => modelTier), ['standard', 'most-capable'], harness);
      for (const call of implementers) {
        assert.equal(call.descriptor.requestedModelTier, call.modelTier, harness);
        assert.equal(call.descriptor.modelSelection, 'applied', harness);
        assert.equal(call.descriptor.args.includes(call.descriptor.resolvedModel), true, harness);
        assert.match(call.prompt, new RegExp(`model: ${call.modelTier}`, 'u'));
        assert.doesNotMatch(call.prompt, /<tier>|\[MODEL_TIER\]/u);
      }
      const reviews = deps.calls.filter(({ kind }) => kind === 'reviewer');
      assert.deepEqual(reviews.map(({ modelTier }) => modelTier), ['standard', 'most-capable'], harness);
      const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
      assert.deepEqual(
        events.filter(({ event }) => event === 'CHILD_COMPLETED').map(({ modelTier }) => modelTier),
        ['standard', 'most-capable'],
        `${harness}: implementer model tiers are durable event evidence`,
      );
      assert.deepEqual(
        events.filter(({ event }) => event === 'REVIEW_COMPLETED').map(({ modelTier }) => modelTier),
        ['standard', 'most-capable'],
        `${harness}: reviewer model tiers are durable event evidence`,
      );
      assert.equal(
        events.filter(({ event }) => event === 'REVIEW_COMPLETED')
          .every(({ modelSelection, resolvedModel }) => modelSelection === 'applied' && resolvedModel),
        true,
        `${harness}: reviewer descriptor application is durable`,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  const degraded = headlessCommand('opencode', 'prompt', { modelTier: 'standard' });
  assert.equal(degraded.requestedModelTier, 'standard');
  assert.equal(degraded.modelSelection, 'degraded');
  assert.match(degraded.degradationReason, /No verified concrete model mapping/u);
});

test('an abandoned reviewer cannot make its tracked mutation the next reviewer baseline', async () => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
    const deps = executionDependencies({
      repoRoot: repo,
      verifierResults: [{ status: 0, stdout: 'green\n', stderr: '' }],
      reviews: ['approved', 'approved'],
    });
    const review = deps.options.reviewer.run;
    deps.options.reviewer.run = (...args) => {
      review(...args);
      deps.mutateSnapshot('reviewer-owned-mutation');
      throw new Error('simulated reviewer interruption');
    };
    await assert.rejects(
      () => runLoopController(GOAL_PATH, deps.options),
      /simulated reviewer interruption/u,
    );

    deps.options.reviewer.run = review;
    deps.options.resume = true;
    deps.options.ledgerPath = LEDGER_PATH;
    const result = await runLoopController(GOAL_PATH, deps.options);
    assert.equal(result.status, 'HALTED');
    assert.equal(deps.calls.filter(({ kind }) => kind === 'reviewer').length, 1);
    const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
    assert.equal(events.at(-1).event, 'RUN_HALTED');
    assert.match(events.at(-1).reason, /review.*drift|drift.*review/iu);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('an abandoned reviewer cannot mutate ignored goal, events, or ledger artifacts without refusal', async () => {
  for (const family of ['goal', 'events', 'ledger']) {
    const repo = fixture();
    try {
      writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
      const deps = executionDependencies({
        repoRoot: repo,
        verifierResults: [{ status: 0, stdout: 'green\n', stderr: '' }],
        reviews: ['approved', 'approved'],
      });
      const review = deps.options.reviewer.run;
      deps.options.reviewer.run = (...args) => {
        review(...args);
        if (family === 'goal') {
          writeWorkPath(repo, GOAL_PATH, `${goalText()}attacker-owned: true\n`, {
            expect: 'goal', family: 'goal',
          });
        } else if (family === 'events') {
          writeWorkPath(repo, EVENTS_PATH, `${readWorkPath(repo, EVENTS_PATH, {
            family: 'events', encoding: 'utf8',
          })}{}\n`, { family: 'events' });
        } else {
          writeWorkPath(repo, LEDGER_PATH, 'attacker-owned ledger\n', { family: 'ledger' });
        }
        throw new Error(`simulated ${family} reviewer interruption`);
      };
      await assert.rejects(
        () => runLoopController(GOAL_PATH, deps.options),
        new RegExp(`simulated ${family} reviewer interruption`, 'u'),
      );

      deps.options.reviewer.run = review;
      deps.options.resume = true;
      deps.options.ledgerPath = LEDGER_PATH;
      let resumed = null;
      let refusal = null;
      try {
        resumed = await runLoopController(GOAL_PATH, deps.options);
      } catch (error) {
        refusal = error;
      }
      assert.ok(
        resumed?.status === 'HALTED' || refusal instanceof Error,
        `${family} mutation must refuse resume`,
      );
      assert.equal(deps.calls.filter(({ kind }) => kind === 'reviewer').length, 1, family);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('KEEP refuses tracked and untracked verifier drift before any index or ref mutation', async () => {
  for (const kind of ['tracked', 'untracked']) {
    const repo = fixture();
    try {
      execFileSync('git', ['init', '-b', 'feature/loop'], { cwd: repo });
      mkdirSync(join(repo, 'scripts'), { recursive: true });
      mkdirSync(join(repo, 'docs'), { recursive: true });
      writeFileSync(join(repo, '.gitignore'), '.apex/work/\n');
      writeFileSync(join(repo, 'scripts', 'metric.mjs'), 'export const fixed = false;\n');
      writeSingleRoute(repo);
      if (kind === 'tracked') writeFileSync(join(repo, 'docs', 'late.md'), 'baseline\n');
      execFileSync('git', ['add', '.'], { cwd: repo });
      execFileSync('git', [
        '-c', 'user.name=Steepy', '-c', 'user.email=steepy@example.invalid',
        'commit', '-m', 'baseline',
      ], { cwd: repo });
      const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      writeWorkPath(repo, GOAL_PATH, goalText({ budget: '1', 'blast-radius': 'scripts/**' }), {
        expect: 'goal', family: 'goal',
      });
      const runner = {
        descriptor: (_harness, _prompt, { modelTier }) => ({
          cmd: 'codex', args: [], protocol: 'jsonl', requestedModelTier: modelTier,
          modelSelection: 'applied', resolvedModel: 'fixture-model',
        }),
        run(_descriptor, context) {
          writeFileSync(join(repo, 'scripts', 'metric.mjs'), 'export const fixed = true;\n');
          writeWorkPath(repo, context.reportPath, 'attempt report\n', { family: 'runner-report' });
          return {
            status: 0,
            output: `status: DONE\nartifact: ${context.reportPath}\nchanged-paths: scripts/metric.mjs\nsignals: none\n`,
            raw: '{"done":true}\n',
            readable: 'done\n',
          };
        },
      };
      let verifierCall = 0;
      const result = await runLoopController(GOAL_PATH, {
        repoRoot: repo,
        harness: 'codex',
        commitAuthorized: true,
        expectedBranch: 'feature/loop',
        routingPath: ROUTING_PATH,
        standardPaths: [SCRIPT_STANDARD],
        runner,
        reviewer: { run: () => assert.fail('late verifier drift must halt before review') },
        verifier: {
          run() {
            verifierCall += 1;
            if (verifierCall === 1) return { status: 1, stdout: 'red\n', stderr: '' };
            writeFileSync(
              join(repo, 'docs', 'late.md'),
              kind === 'tracked' ? 'mutated after child\n' : 'created after child\n',
            );
            return { status: 0, stdout: 'green\n', stderr: '' };
          },
        },
        git: createCliGitAdapter(),
        clock: () => '2026-09-03T12:00:00.000Z',
        uuid: (() => {
          const ids = [RUN_ID, LOCK_TOKEN];
          return () => ids.shift() ?? LOCK_TOKEN;
        })(),
        crashHook() {},
        processProbe: () => false,
      });
      assert.equal(result.status, 'HALTED', kind);
      assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), baseline);
      assert.equal(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' }), '');
      const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
      assert.equal(events.some(({ event }) => event === 'COMMIT_INTENT'), false, kind);
      assert.match(events.at(-1).reason, /snapshot|changed.path|blast|drift|owned/iu, kind);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('the real Git adapter crash-completes commit and discard command boundaries for tracked, untracked, and mixed work', () => {
  for (const kind of ['tracked', 'untracked', 'mixed']) {
    const repo = fixture();
    try {
      execFileSync('git', ['init', '-b', 'feature/loop'], { cwd: repo });
      mkdirSync(join(repo, 'scripts'), { recursive: true });
      writeFileSync(join(repo, 'scripts', 'tracked.mjs'), 'export const value = 0;\n');
      execFileSync('git', ['add', '.'], { cwd: repo });
      execFileSync('git', [
        '-c', 'user.name=Steepy', '-c', 'user.email=steepy@example.invalid',
        'commit', '-m', 'baseline',
      ], { cwd: repo });
      const adapter = createCliGitAdapter();
      const baseline = adapter.head(repo);
      if (kind !== 'untracked') {
        writeFileSync(join(repo, 'scripts', 'tracked.mjs'), 'export const value = 1;\n');
      }
      if (kind !== 'tracked') writeFileSync(join(repo, 'scripts', 'new.mjs'), 'export const added = true;\n');
      const snapshot = adapter.snapshot(repo);
      const metadata = {
        runId: RUN_ID,
        attempt: 1,
        reservedAt: '2026-09-03T12:00:00.000Z',
        expectedParent: baseline,
        changedPaths: adapter.changedPaths(repo),
        snapshotDigest: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
        blastRadius: ['scripts/**'],
        owner: 'steepy-loop-engineer-v1',
      };
      const prepared = adapter.prepareCommit(repo, metadata);
      assert.throws(
        () => adapter.commit(repo, prepared, (point) => {
          if (point === 'after-git-commit-update-ref') throw new Error(`commit crash ${kind}`);
        }),
        new RegExp(`commit crash ${kind}`, 'u'),
      );
      assert.equal(adapter.head(repo), prepared.commit, `${kind}: durable ref landed`);
      assert.notEqual(adapter.status(repo), '', `${kind}: interrupted index remains visible`);
      assert.equal(adapter.commit(repo, prepared), prepared.commit, `${kind}: new adapter invocation reconciles`);
      assert.equal(adapter.status(repo), '', `${kind}: commit reconciliation is clean`);

      if (kind !== 'untracked') {
        writeFileSync(join(repo, 'scripts', 'tracked.mjs'), 'export const value = 2;\n');
      }
      if (kind !== 'tracked') writeFileSync(join(repo, 'scripts', 'discard.mjs'), 'discard me\n');
      const discardSnapshot = adapter.snapshot(repo);
      const ownership = {
        runId: RUN_ID,
        attempt: 2,
        expectedParent: prepared.commit,
        changedPaths: adapter.changedPaths(repo),
        snapshot: discardSnapshot,
        snapshotDigest: createHash('sha256').update(JSON.stringify(discardSnapshot)).digest('hex'),
        owner: 'steepy-loop-engineer-v1',
      };
      assert.throws(
        () => adapter.discard(repo, ownership, (point) => {
          if (point === 'after-git-discard-reset-hard') throw new Error(`discard crash ${kind}`);
        }),
        new RegExp(`discard crash ${kind}`, 'u'),
      );
      assert.equal(adapter.head(repo), prepared.commit, `${kind}: reset restored parent`);
      if (kind !== 'tracked') assert.notEqual(adapter.status(repo), '', `${kind}: owned untracked cleanup pending`);
      assert.equal(adapter.discard(repo, ownership), prepared.commit, `${kind}: discard reconciles once`);
      assert.equal(adapter.status(repo), '', `${kind}: discard reconciliation is clean`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('real Git commit and discard transitions reconcile after the controller process exits between commands', () => {
  const repo = fixture();
  try {
    execFileSync('git', ['init', '-b', 'feature/loop'], { cwd: repo });
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    writeFileSync(join(repo, 'scripts', 'tracked.mjs'), 'export const value = 0;\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', [
      '-c', 'user.name=Steepy', '-c', 'user.email=steepy@example.invalid',
      'commit', '-m', 'baseline',
    ], { cwd: repo });
    const adapter = createCliGitAdapter();
    const baseline = adapter.head(repo);
    writeFileSync(join(repo, 'scripts', 'tracked.mjs'), 'export const value = 1;\n');
    writeFileSync(join(repo, 'scripts', 'new.mjs'), 'export const added = true;\n');
    const snapshot = adapter.snapshot(repo);
    const prepared = adapter.prepareCommit(repo, {
      runId: RUN_ID,
      attempt: 1,
      reservedAt: '2026-09-03T12:00:00.000Z',
      expectedParent: baseline,
      changedPaths: adapter.changedPaths(repo),
      snapshotDigest: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
      blastRadius: ['scripts/**'],
      owner: 'steepy-loop-engineer-v1',
    });
    const moduleUrl = new URL('../scripts/loop-engineer.mjs', import.meta.url).href;
    const invoke = (method, payload, crashPoint = null) => spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { createCliGitAdapter } from ${JSON.stringify(moduleUrl)};
const payload = JSON.parse(Buffer.from(process.argv.at(-2), 'base64').toString('utf8'));
const repo = process.argv.at(-1);
const hook = ${crashPoint === null ? '() => {}' : `(point) => { if (point === ${JSON.stringify(crashPoint)}) process.exit(86); }`};
createCliGitAdapter()[${JSON.stringify(method)}](repo, payload, hook);`,
      Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
      repo,
    ], { encoding: 'utf8' });

    assert.equal(invoke('commit', prepared, 'after-git-commit-update-ref').status, 86);
    assert.equal(invoke('commit', prepared).status, 0);
    assert.equal(adapter.status(repo), '');

    writeFileSync(join(repo, 'scripts', 'tracked.mjs'), 'export const value = 2;\n');
    writeFileSync(join(repo, 'scripts', 'discard.mjs'), 'discard me\n');
    const discardSnapshot = adapter.snapshot(repo);
    const ownership = {
      runId: RUN_ID,
      attempt: 2,
      expectedParent: prepared.commit,
      changedPaths: adapter.changedPaths(repo),
      snapshot: discardSnapshot,
      snapshotDigest: createHash('sha256').update(JSON.stringify(discardSnapshot)).digest('hex'),
      owner: 'steepy-loop-engineer-v1',
    };
    assert.equal(invoke('discard', ownership, 'after-git-discard-reset-hard').status, 86);
    assert.equal(invoke('discard', ownership).status, 0);
    assert.equal(adapter.status(repo), '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the controller resumes real-Git intra-command commit and discard crashes without rerunning the child', async () => {
  for (const transition of ['commit', 'discard']) {
    const repo = fixture();
    try {
      execFileSync('git', ['init', '-b', 'feature/loop'], { cwd: repo });
      mkdirSync(join(repo, 'scripts'), { recursive: true });
      writeFileSync(join(repo, '.gitignore'), '.apex/work/\n');
      writeFileSync(join(repo, 'scripts', 'tracked.mjs'), 'export const value = 0;\n');
      writeSingleRoute(repo);
      execFileSync('git', ['add', '.'], { cwd: repo });
      execFileSync('git', [
        '-c', 'user.name=Steepy', '-c', 'user.email=steepy@example.invalid',
        'commit', '-m', 'baseline',
      ], { cwd: repo });
      writeWorkPath(repo, GOAL_PATH, goalText(transition === 'discard' ? {
        mode: 'metric', 'metric-direction': 'min', budget: '1', 'blast-radius': 'scripts/**',
      } : {
        budget: '1', 'blast-radius': 'scripts/**',
      }), { expect: 'goal', family: 'goal' });
      let runnerCalls = 0;
      let verifierCalls = 0;
      const verifierValues = transition === 'commit' ? ['red', 'green'] : ['10', '11'];
      const options = {
        repoRoot: repo,
        harness: 'codex',
        commitAuthorized: true,
        expectedBranch: 'feature/loop',
        routingPath: ROUTING_PATH,
        standardPaths: [SCRIPT_STANDARD],
        runner: {
          descriptor(_harness, _prompt, { modelTier }) {
            return {
              cmd: 'codex', args: [], protocol: 'jsonl', requestedModelTier: modelTier,
              modelSelection: 'applied', resolvedModel: 'fixture-model',
            };
          },
          run(_descriptor, context) {
            runnerCalls += 1;
            writeFileSync(join(repo, 'scripts', 'tracked.mjs'), 'export const value = 1;\n');
            writeFileSync(join(repo, 'scripts', 'new.mjs'), 'export const added = true;\n');
            writeWorkPath(repo, context.reportPath, 'attempt report\n', { family: 'runner-report' });
            return {
              status: 0,
              output: `status: DONE\nartifact: ${context.reportPath}\nchanged-paths: scripts/tracked.mjs, scripts/new.mjs\nsignals: none\n`,
              raw: '{"done":true}\n', readable: 'done\n',
            };
          },
        },
        reviewer: {
          run(_prompt, context) {
            const report = '## Loop Branch Review\n**Status:** Approved\n';
            writeWorkPath(repo, context.reportPath, report, { family: 'reviewer-report' });
            return {
              status: 0,
              output: `status: DONE\nartifact: ${context.reportPath}\nchanged-paths: none\nsignals: approved\n`,
              raw: '{"review":true}\n', readable: report,
            };
          },
        },
        verifier: {
          run() {
            const value = verifierValues[verifierCalls++];
            return transition === 'commit'
              ? { status: value === 'green' ? 0 : 1, stdout: `${value}\n`, stderr: '' }
              : { status: 0, stdout: `${value}\n`, stderr: '' };
          },
        },
        git: createCliGitAdapter(),
        clock: () => '2026-09-03T12:00:00.000Z',
        uuid: (() => {
          const ids = [RUN_ID, LOCK_TOKEN];
          return () => ids.shift() ?? LOCK_TOKEN;
        })(),
        crashHook(point) {
          const expected = transition === 'commit'
            ? 'after-git-commit-update-ref'
            : 'after-git-discard-reset-hard';
          if (point === expected) throw new Error(`intra-command ${transition} crash`);
        },
        processProbe: () => false,
      };
      await assert.rejects(
        () => runLoopController(GOAL_PATH, options),
        new RegExp(`intra-command ${transition} crash`, 'u'),
      );
      options.resume = true;
      options.ledgerPath = LEDGER_PATH;
      options.crashHook = () => {};
      const result = await runLoopController(GOAL_PATH, options);
      assert.equal(
        result.outcome,
        transition === 'commit' ? 'GOAL_REACHED' : 'NO_IMPROVEMENT',
        JSON.stringify({
          result,
          lastEvent: parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' })).at(-1),
        }),
      );
      assert.equal(runnerCalls, 1, `${transition}: child result is not rerun`);
      assert.equal(execFileSync('git', ['status', '--short'], { cwd: repo, encoding: 'utf8' }), '');
      const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
      assert.equal(events.filter(({ event }) => event === (
        transition === 'commit' ? 'COMMIT_RECORDED' : 'DISCARD_RECORDED'
      )).length, 1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('the CLI Git adapter repeats bound snapshot and changed-path checks immediately before staging', () => {
  const repo = fixture();
  try {
    execFileSync('git', ['init', '-b', 'feature/loop'], { cwd: repo });
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'scripts', 'fix.mjs'), 'export const fixed = false;\n');
    writeFileSync(join(repo, 'docs', 'late.md'), 'baseline\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', [
      '-c', 'user.name=Steepy', '-c', 'user.email=steepy@example.invalid',
      'commit', '-m', 'baseline',
    ], { cwd: repo });
    const git = createCliGitAdapter();
    const expectedParent = git.head(repo);
    writeFileSync(join(repo, 'scripts', 'fix.mjs'), 'export const fixed = true;\n');
    const snapshot = git.snapshot(repo);
    const snapshotDigest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    writeFileSync(join(repo, 'docs', 'late.md'), 'late actor drift\n');

    assert.throws(
      () => git.prepareCommit(repo, {
        runId: RUN_ID,
        attempt: 1,
        expectedParent,
        changedPaths: ['scripts/fix.mjs'],
        snapshotDigest,
        blastRadius: ['scripts/**'],
        owner: 'steepy-loop-engineer-v1',
      }),
      /snapshot|blast|ownership/iu,
    );
    assert.equal(execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: repo, encoding: 'utf8',
    }), '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('deterministic runtime/real-Git evidence: pre-intent preparation replays the same commit object', async () => {
  const repo = fixture();
  try {
    execFileSync('git', ['init', '-b', 'feature/loop'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Steepy'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'steepy@example.invalid'], { cwd: repo });
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    writeFileSync(join(repo, '.gitignore'), '.apex/work/\n');
    writeFileSync(join(repo, 'scripts', 'fix.mjs'), 'export const fixed = false;\n');
    writeSingleRoute(repo);
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: repo });
    const baseline = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo, encoding: 'utf8',
    }).trim();
    writeWorkPath(repo, GOAL_PATH, goalText({ budget: '1' }), {
      expect: 'goal', family: 'goal',
    });

    let verifierCall = 0;
    let runnerCall = 0;
    let reviewCall = 0;
    const prepared = [];
    const cliGit = createCliGitAdapter();
    const git = {
      ...cliGit,
      prepareCommit(root, metadata) {
        const candidate = cliGit.prepareCommit(root, metadata);
        prepared.push(candidate.commit);
        return candidate;
      },
    };
    const options = {
      repoRoot: repo,
      harness: 'codex',
      commitAuthorized: true,
      expectedBranch: 'feature/loop',
      routingPath: ROUTING_PATH,
      standardPaths: [SCRIPT_STANDARD],
      runner: {
        descriptor: (_harness, _prompt, { modelTier }) => ({
          cmd: 'codex', args: [], protocol: 'jsonl', requestedModelTier: modelTier,
          modelSelection: 'applied', resolvedModel: 'fixture-model',
        }),
        run(_descriptor, context) {
          runnerCall += 1;
          writeFileSync(join(repo, 'scripts', 'fix.mjs'), 'export const fixed = true;\n');
          writeWorkPath(repo, context.reportPath, 'attempt report\n', { family: 'runner-report' });
          return {
            status: 0,
            output: `status: DONE\nartifact: ${context.reportPath}\nchanged-paths: scripts/fix.mjs\nsignals: none\n`,
            raw: '{"done":true}\n',
            readable: 'done\n',
          };
        },
      },
      reviewer: {
        run(_prompt, context) {
          reviewCall += 1;
          const report = '## Loop Branch Review\n**Status:** Approved\n';
          writeWorkPath(repo, context.reportPath, report, { family: 'reviewer-report' });
          return {
            status: 0,
            output: `status: DONE\nartifact: ${context.reportPath}\nchanged-paths: none\nsignals: approved\n`,
            raw: '{"approved":true}\n',
            readable: report,
          };
        },
      },
      verifier: {
        run() {
          verifierCall += 1;
          return verifierCall === 1
            ? { status: 1, stdout: 'red\n', stderr: '' }
            : { status: 0, stdout: 'green\n', stderr: '' };
        },
      },
      git,
      clock: () => '2026-09-03T12:00:00.000Z',
      uuid: (() => {
        const ids = [RUN_ID, LOCK_TOKEN];
        return () => ids.shift() ?? LOCK_TOKEN;
      })(),
      crashHook(point) {
        if (point === 'before-commit-intent') throw new Error('pre-intent object crash');
      },
      processProbe: () => false,
    };
    await assert.rejects(() => runLoopController(GOAL_PATH, options), /pre-intent object crash/u);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo, encoding: 'utf8',
    }).trim(), baseline);
    assert.equal(prepared.length, 1);
    execFileSync('git', ['cat-file', '-e', `${prepared[0]}^{commit}`], { cwd: repo });

    options.resume = true;
    options.ledgerPath = LEDGER_PATH;
    options.crashHook = () => {};
    const result = await runLoopController(GOAL_PATH, options);
    assert.equal(result.outcome, 'GOAL_REACHED');
    assert.deepEqual(prepared, [prepared[0], prepared[0]]);
    assert.equal(runnerCall, 1);
    assert.equal(reviewCall, 1);
    assert.equal(execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: repo, encoding: 'utf8',
    }).trim(), '2');
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo, encoding: 'utf8',
    }).trim(), prepared[0]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('deterministic runtime/real-Git evidence: a committed durable intent records once on resume', async () => {
  const repo = fixture();
  try {
    execFileSync('git', ['init', '-b', 'feature/loop'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Steepy'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'steepy@example.invalid'], { cwd: repo });
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    writeFileSync(join(repo, '.gitignore'), '.apex/work/\n');
    writeFileSync(join(repo, 'scripts', 'fix.mjs'), 'export const fixed = false;\n');
    writeSingleRoute(repo);
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: repo });
    writeWorkPath(repo, GOAL_PATH, goalText({ budget: '1' }), { expect: 'goal', family: 'goal' });

    let verifierCall = 0;
    let runnerCall = 0;
    let reviewCall = 0;
    const options = {
      repoRoot: repo,
      harness: 'codex',
      commitAuthorized: true,
      expectedBranch: 'feature/loop',
      routingPath: ROUTING_PATH,
      standardPaths: [SCRIPT_STANDARD],
      runner: {
        descriptor: (_harness, _prompt, { modelTier }) => ({
          cmd: 'codex', args: [], protocol: 'jsonl', requestedModelTier: modelTier,
          modelSelection: 'applied', resolvedModel: 'fixture-model',
        }),
        run(_descriptor, context) {
          runnerCall += 1;
          writeFileSync(join(repo, 'scripts', 'fix.mjs'), 'export const fixed = true;\n');
          writeWorkPath(repo, context.reportPath, 'attempt report\n', { family: 'runner-report' });
          return {
            status: 0,
            output: `status: DONE\nartifact: ${context.reportPath}\nchanged-paths: scripts/fix.mjs\nsignals: none\n`,
            raw: '{"done":true}\n',
            readable: 'done\n',
          };
        },
      },
      reviewer: {
        run(_prompt, context) {
          reviewCall += 1;
          const report = '## Loop Branch Review\n**Status:** Approved\n';
          writeWorkPath(repo, context.reportPath, report, { family: 'reviewer-report' });
          return {
            status: 0,
            output: `status: DONE\nartifact: ${context.reportPath}\nchanged-paths: none\nsignals: approved\n`,
            raw: '{"approved":true}\n',
            readable: report,
          };
        },
      },
      verifier: {
        run() {
          verifierCall += 1;
          return verifierCall === 1
            ? { status: 1, stdout: 'red\n', stderr: '' }
            : { status: 0, stdout: 'green\n', stderr: '' };
        },
      },
      git: createCliGitAdapter(),
      clock: () => '2026-09-03T12:00:00.000Z',
      uuid: (() => {
        const ids = [RUN_ID, LOCK_TOKEN];
        return () => ids.shift() ?? LOCK_TOKEN;
      })(),
      crashHook(point) {
        if (point === 'after-git-commit') throw new Error('committed intent crash');
      },
      processProbe: () => false,
    };
    await assert.rejects(() => runLoopController(GOAL_PATH, options), /committed intent crash/u);
    const committedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    options.resume = true;
    options.ledgerPath = LEDGER_PATH;
    options.crashHook = () => {};
    const result = await runLoopController(GOAL_PATH, options);
    assert.equal(result.outcome, 'GOAL_REACHED');
    assert.equal(runnerCall, 1);
    assert.equal(reviewCall, 1);
    assert.equal(execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: repo, encoding: 'utf8',
    }).trim(), '2');
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo, encoding: 'utf8',
    }).trim(), committedHead);
    const events = parseWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
    assert.equal(events.filter(({ event }) => event === 'COMMIT_RECORDED').length, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('streaming retains only bounded terminal correlation while durable raw evidence stays complete', async () => {
  const repo = fixture();
  try {
    const rawPath = `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-attempt-1.raw.jsonl`;
    const readablePath = `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-attempt-1.log`;
    const script = [
      "const payload='x'.repeat(96*1024);",
      "process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'command_execution',output:payload}})+'\\n');",
      "process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'status: DONE\\nartifact: report.md\\nchanged-paths: none\\nsignals: none'}})+'\\n');",
      "process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n');",
    ].join('');
    const listeners = new Map();
    let exercisedBackpressure = false;
    const liveStdout = {
      on(name, listener) { listeners.set(name, listener); return this; },
      write(_chunk, callback) {
        if (!exercisedBackpressure) {
          exercisedBackpressure = true;
          setTimeout(() => {
            callback?.();
            listeners.get('drain')?.();
          }, 20);
          return false;
        }
        callback?.();
        return true;
      },
    };
    const result = await runStreamingHeadlessDescriptor(
      { cmd: process.execPath, args: ['-e', script] },
      'codex',
      repo,
      {
        rawPath,
        readablePath,
        terminalResponseLimit: 64 * 1024,
        liveStdout,
        liveStderr: { write() { return true; } },
      },
    );
    assert.equal(result.status, 0, JSON.stringify(result));
    assert.match(result.output, /status: DONE/u);
    assert.equal(exercisedBackpressure, true);
    assert.ok(result.retainedBytes <= 64 * 1024, String(result.retainedBytes));
    assert.ok(statSync(join(repo, rawPath)).size > 96 * 1024);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a blocking stream failure terminates and awaits the detached descendant process group', { timeout: 5000 }, async () => {
  const repo = fixture();
  try {
    const rawPath = `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-attempt-1.raw.jsonl`;
    const readablePath = `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-attempt-1.log`;
    const pidPath = join(repo, 'descendant.pid');
    const descendant = "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),1800);";
    const script = [
      "const fs=require('node:fs');",
      "const {spawn}=require('node:child_process');",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']});`,
      `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
      "setTimeout(()=>process.stdout.write('x'.repeat(1024*1024+1)),100);",
      "setInterval(()=>{},1000);",
    ].join('');
    const started = Date.now();
    const result = await runStreamingHeadlessDescriptor(
      { cmd: process.execPath, args: ['-e', script] },
      'codex',
      repo,
      {
        rawPath,
        readablePath,
        killGraceMs: 100,
        liveStdout: { write() { return true; } },
        liveStderr: { write() { return true; } },
      },
    );
    assert.match(result.error?.message ?? '', /partial.*line|limit/iu);
    assert.ok(Date.now() - started < 1200, `teardown took ${Date.now() - started}ms`);
    const descendantPid = Number(readFileSync(pidPath, 'utf8'));
    assert.throws(() => process.kill(descendantPid, 0));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a CONSUMED goal is rejected unless event replay is already terminal', async () => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
    await runLoopController(GOAL_PATH, dependencies({ repoRoot: repo }).options);
    const consumed = goalText().replace(
      'status: READY\nnext: loop-engineer\nsource: none\nconsumed-by: none',
      `status: CONSUMED\nnext: loop-engineer\nsource: none\nconsumed-by: ${LEDGER_PATH}`,
    );
    writeWorkPath(repo, GOAL_PATH, consumed, { expect: 'goal', family: 'goal' });
    const resumed = dependencies({ repoRoot: repo, resume: true, ledgerPath: LEDGER_PATH });
    await assert.rejects(
      () => runLoopController(GOAL_PATH, resumed.options),
      /consumed.*terminal|terminal.*consumed/iu,
    );
    assert.equal(resumed.calls.some((call) => call === 'crash:after-lock'), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('terminal resume preserves READY before any DRAFT-ledger hook across repeated recovery', async () => {
  const repo = fixture();
  try {
    writeWorkPath(repo, GOAL_PATH, goalText(), { expect: 'goal', family: 'goal' });
    const first = executionDependencies({
      repoRoot: repo,
      verifierResults: [{ status: 0, stdout: 'green\n', stderr: '' }],
    });
    assert.equal((await runLoopController(GOAL_PATH, first.options)).outcome, 'GOAL_REACHED');
    const ready = readWorkPath(repo, LEDGER_PATH, { family: 'ledger' });

    for (let pass = 0; pass < 2; pass += 1) {
      const resumed = executionDependencies({ repoRoot: repo, verifierResults: [] });
      resumed.options.resume = true;
      resumed.options.ledgerPath = LEDGER_PATH;
      resumed.options.crashHook = (point) => {
        if (point === 'after-ledger') throw new Error('DRAFT regression');
      };
      const result = await runLoopController(GOAL_PATH, resumed.options);
      assert.equal(result.outcome, 'GOAL_REACHED');
      assert.deepEqual(readWorkPath(repo, LEDGER_PATH, { family: 'ledger' }), ready);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('gapped review identities remain unique for issues and approved-still-red reviews', async () => {
  for (const scenario of [
    {
      name: 'issues',
      secondCrash: 'after-review-2-completed',
      verifierResults: [
        { status: 1, stdout: 'baseline red\n', stderr: '' },
        { status: 0, stdout: 'attempt 1 green\n', stderr: '' },
        { status: 0, stdout: 'attempt 2 green\n', stderr: '' },
      ],
      expectedReviews: [2, 3],
      expectedAttempts: [1, 2],
    },
    {
      name: 'approved-still-red',
      secondCrash: 'after-review-2-completed',
      verifierResults: [
        { status: 1, stdout: 'baseline red\n', stderr: '' },
        { status: 0, stdout: 'attempt 1 green\n', stderr: '' },
        { status: 1, stdout: 'attempt 2 still red\n', stderr: '' },
        { status: 0, stdout: 'attempt 3 green\n', stderr: '' },
      ],
      expectedReviews: [2, 3, 4],
      expectedAttempts: [1, 2, 3],
    },
  ]) {
    const repo = fixture();
    try {
      writeWorkPath(repo, GOAL_PATH, goalText({ budget: '3' }), { expect: 'goal', family: 'goal' });
      const deps = executionDependencies({
        repoRoot: repo,
        verifierResults: scenario.verifierResults,
        changedPaths: [
          ['scripts/fix-1.mjs'],
          ['scripts/fix-2.mjs'],
          ['scripts/fix-3.mjs'],
        ],
        reviews: ['issues', 'approved', 'approved'],
      });
      deps.options.crashHook = (point) => {
        if (point === 'before-loop-branch-review') throw new Error('abandon review 1');
      };
      await assert.rejects(() => runLoopController(GOAL_PATH, deps.options), /abandon review 1/u);

      deps.options.resume = true;
      deps.options.ledgerPath = LEDGER_PATH;
      deps.options.crashHook = (point) => {
        if (point === scenario.secondCrash) throw new Error(`stop after ${scenario.name}`);
      };
      await assert.rejects(
        () => runLoopController(GOAL_PATH, deps.options),
        new RegExp(`stop after ${scenario.name}`, 'u'),
      );

      deps.options.crashHook = () => {};
      const result = await runLoopController(GOAL_PATH, deps.options);
      assert.equal(result.outcome, 'GOAL_REACHED', scenario.name);
      const state = reduceWorkflowJsonl(readWorkPath(repo, EVENTS_PATH, { family: 'events' }));
      assert.deepEqual(state.reviewHistory.map(({ review }) => review), scenario.expectedReviews, scenario.name);
      assert.deepEqual(state.reservedAttempts, scenario.expectedAttempts, scenario.name);
      assert.equal(state.phase, 'TERMINAL_RECORDED', scenario.name);
      assert.equal(state.haltReason, null, scenario.name);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('normal zero and nonzero child closes terminate and await unrefed detached descendants', { timeout: 6000 }, async () => {
  for (const exitCode of [0, 7]) {
    const repo = fixture();
    try {
      const rawPath = `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-attempt-1.raw.jsonl`;
      const readablePath = `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-attempt-1.log`;
      const pidPath = join(repo, `descendant-${exitCode}.pid`);
      const descendant = "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),2500);";
      const script = [
        "const fs=require('node:fs');",
        "const {spawn}=require('node:child_process');",
        `const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});`,
        'child.unref();',
        `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
        ...(exitCode === 0 ? [
          "process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'status: DONE\\nartifact: report.md\\nchanged-paths: none\\nsignals: none'}})+'\\n');",
          "process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n');",
        ] : []),
        `process.exit(${exitCode});`,
      ].join('');
      const started = Date.now();
      const result = await runStreamingHeadlessDescriptor(
        { cmd: process.execPath, args: ['-e', script] },
        'codex',
        repo,
        {
          rawPath,
          readablePath,
          killGraceMs: 100,
          processGroupConvergenceMs: 1000,
          liveStdout: { write() { return true; } },
          liveStderr: { write() { return true; } },
        },
      );
      assert.equal(result.status, exitCode);
      assert.equal(result.error, null, result.error?.message);
      assert.ok(Date.now() - started < 1500, `exit ${exitCode} convergence took ${Date.now() - started}ms`);
      const descendantPid = Number(readFileSync(pidPath, 'utf8'));
      assert.throws(() => process.kill(descendantPid, 0), undefined, `exit ${exitCode}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('leader exit starts bounded convergence before inherited descendant pipes close for zero, nonzero, and signal exits', { timeout: 8000 }, async () => {
  for (const leaderExit of ['zero', 'nonzero', 'signal']) {
    const repo = fixture();
    try {
      const rawPath = `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-attempt-1.raw.jsonl`;
      const readablePath = `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-attempt-1.log`;
      const pidPath = join(repo, `inherited-descendant-${leaderExit}.pid`);
      const readyPath = join(repo, `inherited-descendant-${leaderExit}.ready`);
      const descendant = [
        "const fs=require('node:fs');",
        "process.on('SIGTERM',()=>{});",
        `fs.writeFileSync(${JSON.stringify(readyPath)},'ready');`,
        'setTimeout(()=>process.exit(0),1300);',
      ].join('');
      const terminal = leaderExit === 'zero'
        ? [
          "process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'status: DONE\\nartifact: report.md\\nchanged-paths: none\\nsignals: none'}})+'\\n');",
          "process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n',leave);",
        ].join('')
        : "process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'abc'})+'\\n',leave);";
      const leave = leaderExit === 'zero' ? 'process.exit(0)'
        : leaderExit === 'nonzero' ? 'process.exit(7)'
          : "process.kill(process.pid,'SIGTERM')";
      const script = [
        "const fs=require('node:fs');",
        "const {spawn}=require('node:child_process');",
        `const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']});`,
        `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
        `const leave=()=>${leave};`,
        `const ready=setInterval(()=>{if(fs.existsSync(${JSON.stringify(readyPath)})){clearInterval(ready);${terminal}}},5);`,
      ].join('');
      const started = Date.now();
      const result = await runStreamingHeadlessDescriptor(
        { cmd: process.execPath, args: ['-e', script] },
        'codex',
        repo,
        {
          rawPath,
          readablePath,
          killGraceMs: 100,
          processGroupConvergenceMs: 500,
          liveStdout: { write() { return true; } },
          liveStderr: { write() { return true; } },
        },
      );
      if (leaderExit === 'zero') {
        assert.equal(result.status, 0);
        assert.equal(result.signal, null);
        assert.match(result.output, /status: DONE/u);
      } else if (leaderExit === 'nonzero') {
        assert.equal(result.status, 7);
        assert.equal(result.signal, null);
      } else {
        assert.equal(result.status, null);
        assert.equal(result.signal, 'SIGTERM');
      }
      assert.equal(result.error, null, result.error?.message);
      assert.ok(Date.now() - started < 800, `${leaderExit} convergence took ${Date.now() - started}ms`);
      const descendantPid = Number(readFileSync(pidPath, 'utf8'));
      assert.throws(() => process.kill(descendantPid, 0), undefined, leaderExit);
      const raw = readWorkPath(repo, rawPath, { family: 'runner-raw', encoding: 'utf8' });
      assert.match(raw, leaderExit === 'zero' ? /turn\.completed/u : /thread\.started/u);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('process-group convergence timeout is a blocking result after raw stream finalization', async () => {
  const repo = fixture();
  try {
    const rawPath = `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-attempt-1.raw.jsonl`;
    const readablePath = `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-attempt-1.log`;
    const pidPath = join(repo, 'convergence-timeout-descendant.pid');
    const readyPath = join(repo, 'convergence-timeout-descendant.ready');
    const descendant = [
      "const fs=require('node:fs');",
      "process.on('SIGTERM',()=>{});",
      `fs.writeFileSync(${JSON.stringify(readyPath)},'ready');`,
      'setTimeout(()=>process.exit(0),1300);',
    ].join('');
    const script = [
      "const fs=require('node:fs');",
      "const {spawn}=require('node:child_process');",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']});`,
      `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
      `const ready=setInterval(()=>{if(fs.existsSync(${JSON.stringify(readyPath)})){`,
      'clearInterval(ready);',
      "process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'status: DONE\\nartifact: report.md\\nchanged-paths: none\\nsignals: none'}})+'\\n');",
      "process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n',()=>process.exit(0));",
      '}},5);',
    ].join('');
    const result = await runStreamingHeadlessDescriptor(
      { cmd: process.execPath, args: ['-e', script] },
      'codex',
      repo,
      {
        rawPath,
        readablePath,
        killGraceMs: 10,
        processGroupConvergenceMs: 20,
        processGroupProbe: () => true,
        liveStdout: { write() { return true; } },
        liveStderr: { write() { return true; } },
      },
    );
    assert.equal(result.status, 0);
    assert.match(result.error?.message ?? '', /process-group convergence timed out/iu);
    assert.match(readWorkPath(repo, rawPath, {
      family: 'runner-raw', encoding: 'utf8',
    }), /turn\.completed/u);
    const descendantPid = Number(readFileSync(pidPath, 'utf8'));
    assert.throws(() => process.kill(descendantPid, 0));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

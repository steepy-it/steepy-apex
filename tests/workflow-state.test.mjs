import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLEAN_TERMINAL_OUTCOMES,
  VERIFIER_VERDICTS,
  WORKFLOW_EVENT_NAMES,
  WORKFLOW_EVENT_SCHEMA_VERSION,
  WORKFLOW_MODES,
  classifyWorkflowStart,
  classifyCommitReconciliation,
  correlateAttempt,
  correlateRun,
  createWorkflowState,
  goalAcceptableCandidate,
  nextWorkflowAttempt,
  normalizeWorkflowEnvelope,
  parseWorkflowJsonl,
  replayPhaseWorkflow,
  reduceWorkflowEvent,
  reduceWorkflowEvents,
  reduceWorkflowJsonl,
  reserveAttempt,
  selectTerminalOutcome,
  selectBaseline,
  validateTerminalState,
  validateWorkflowEvent,
  workflowScopeCompleted,
} from '../scripts/workflow-state.mjs';

const RUN_ID = 'gear-4-run-1';
const BASELINE = 'a'.repeat(40);
const COMMIT = 'b'.repeat(40);
const SECOND_COMMIT = 'c'.repeat(40);
const TIMESTAMP = '2026-09-03T10:00:00.000Z';

function envelope(event, fields = {}, sequence = 1) {
  return {
    schemaVersion: 1,
    sequence,
    runId: RUN_ID,
    timestamp: TIMESTAMP,
    event,
    ...fields,
  };
}

function sequenced(event, fields, sequence) {
  return {
    ...envelope(event, fields, sequence),
    timestamp: new Date(Date.parse(TIMESTAMP) + (sequence * 1000)).toISOString(),
  };
}

function start(fields = {}) {
  const event = {
    branch: 'feature/gear-4',
    baseline: BASELINE,
    mode: 'BOOLEAN',
    budget: 1,
    controllerCommitAuthorized: true,
    goalDigest: 'd'.repeat(64),
    verifier: 'npm test',
    verifierArgv: ['npm', 'test'],
    metricDirection: null,
    blastRadius: ['scripts/**', 'tests/**'],
    baselineExit: 1,
    baselinePassed: false,
    baselineMetric: null,
    ...fields,
  };
  if (!Object.hasOwn(fields, 'baselineExit') && event.baselinePassed === true) {
    event.baselineExit = 0;
  }
  if (event.mode === 'METRIC') {
    if (!Object.hasOwn(fields, 'metricDirection')) event.metricDirection = 'min';
    if (!Object.hasOwn(fields, 'baselinePassed')) event.baselinePassed = true;
    if (!Object.hasOwn(fields, 'baselineMetric')) event.baselineMetric = 0;
    if (!Object.hasOwn(fields, 'baselineExit')) event.baselineExit = 0;
  }
  return sequenced('RUN_STARTED', event, 1);
}

function goalReachedStream({ approved = true, outcome = 'GOAL_REACHED', budget = 1 } = {}) {
  return [
    start({ budget }),
    sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 2),
    sequenced('CHILD_COMPLETED', { attempt: 1 }, 3),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 1, passed: true }, 4),
    sequenced('VERIFIER_RECORDED', { attempt: 1, verdict: 'GOAL_REACHED', metric: null }, 5),
    sequenced('COMMIT_INTENT', { attempt: 1, commit: COMMIT }, 6),
    sequenced('COMMIT_RECORDED', { attempt: 1, commit: COMMIT }, 7),
    sequenced('REVIEW_COMPLETED', { approved }, 8),
    sequenced('TERMINAL_RECORDED', { outcome }, 9),
  ];
}

function unsuccessfulTerminalStream({
  mode = 'BOOLEAN',
  outcome = 'BUDGET_EXHAUSTED',
  approved = true,
} = {}) {
  if (mode === 'BOOLEAN') {
    return [
      start({ mode }),
      sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 2),
      sequenced('CHILD_COMPLETED', { attempt: 1 }, 3),
      sequenced('BLAST_RADIUS_CHECKED', { attempt: 1, passed: true }, 4),
      sequenced('VERIFIER_RECORDED', { attempt: 1, verdict: 'KEEP', metric: null }, 5),
      sequenced('COMMIT_INTENT', { attempt: 1, commit: COMMIT }, 6),
      sequenced('COMMIT_RECORDED', { attempt: 1, commit: COMMIT }, 7),
      sequenced('REVIEW_COMPLETED', { approved }, 8),
      sequenced('TERMINAL_RECORDED', { outcome }, 9),
    ];
  }
  return [
    start({ mode }),
    sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 2),
    sequenced('CHILD_COMPLETED', { attempt: 1 }, 3),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 1, passed: true }, 4),
    sequenced('VERIFIER_RECORDED', {
      attempt: 1, verdict: 'DISCARD', metric: mode === 'METRIC' ? 10 : null,
    }, 5),
    sequenced('DISCARD_INTENT', { attempt: 1 }, 6),
    sequenced('DISCARD_RECORDED', { attempt: 1 }, 7),
    sequenced('REVIEW_COMPLETED', { approved }, 8),
    sequenced('TERMINAL_RECORDED', { outcome }, 9),
  ];
}

test('the v1 vocabulary is closed and stable', () => {
  assert.equal(WORKFLOW_EVENT_SCHEMA_VERSION, 1);
  assert.deepEqual(WORKFLOW_EVENT_NAMES, [
    'RUN_STARTED',
    'ATTEMPT_RESERVED',
    'CHILD_COMPLETED',
    'BLAST_RADIUS_CHECKED',
    'VERIFIER_RECORDED',
    'COMMIT_INTENT',
    'COMMIT_RECORDED',
    'DISCARD_INTENT',
    'DISCARD_RECORDED',
    'REVIEW_COMPLETED',
    'TERMINAL_RECORDED',
    'RECONCILIATION_REQUIRED',
    'RUN_HALTED',
  ]);
  assert.deepEqual(CLEAN_TERMINAL_OUTCOMES, [
    'GOAL_REACHED',
    'BUDGET_EXHAUSTED',
    'NO_IMPROVEMENT',
    'REVIEW_REJECTED',
  ]);
  assert.ok(Object.isFrozen(WORKFLOW_EVENT_NAMES));
  assert.ok(Object.isFrozen(CLEAN_TERMINAL_OUTCOMES));
  assert.deepEqual(WORKFLOW_MODES, ['BOOLEAN', 'METRIC']);
  assert.deepEqual(VERIFIER_VERDICTS, ['GOAL_REACHED', 'KEEP', 'DISCARD']);
});

test('attempt reservation is positive, immutable, unique, monotonic, and budget bounded', () => {
  const none = Object.freeze([]);
  const one = reserveAttempt(none, 1, 2);
  const two = reserveAttempt(one, 2, 2);

  assert.deepEqual(none, []);
  assert.deepEqual(one, [1]);
  assert.deepEqual(two, [1, 2]);
  assert.ok(Object.isFrozen(one));
  assert.ok(Object.isFrozen(two));
  assert.throws(() => reserveAttempt(two, 2, 3), /attempt identity 2 was already reserved/u);
  assert.throws(() => reserveAttempt(one, 3, 3), /next attempt must be 2/u);
  assert.throws(() => reserveAttempt(none, 0, 1), /positive safe integer/u);
  assert.throws(() => reserveAttempt(two, 3, 2), /exceeds budget 2/u);
});

test('baseline selection is one-time and correlation helpers reject cross-run or reordered attempts', () => {
  assert.equal(selectBaseline(null, BASELINE), BASELINE);
  assert.equal(selectBaseline(BASELINE, BASELINE), BASELINE);
  assert.throws(() => selectBaseline(BASELINE, 'b'.repeat(40)), /baseline is already selected/u);
  assert.throws(() => selectBaseline(null, 'main'), /Git object identity/u);

  const event = { runId: RUN_ID, attempt: 2 };
  assert.strictEqual(correlateRun(RUN_ID, event), event);
  assert.strictEqual(correlateAttempt(2, event), event);
  assert.throws(() => correlateRun('another-run', event), /run correlation/u);
  assert.throws(() => correlateAttempt(3, event), /attempt correlation/u);
  assert.throws(() => correlateAttempt(1, event), /reordered attempt correlation/u);
});

test('the shared phase projection replays normalized envelopes without owning a source format', () => {
  const runId = 'phase-run-1';
  const phaseEnvelope = (sequence, event, fields = {}) => normalizeWorkflowEnvelope({
    schemaVersion: 1,
    sequence,
    runId: fields.runId ?? runId,
    timestamp: new Date(Date.parse(TIMESTAMP) + (sequence * 1000)).toISOString(),
    event,
    kind: 'OBSERVED',
    scope: null,
    attempt: null,
    ...fields,
  }, { allowUncorrelated: true });
  const events = [
    phaseEnvelope(1, 'BASELINE', {
      kind: 'BASELINE', scope: null, attempt: null, baseline: BASELINE,
    }),
    phaseEnvelope(2, 'ATTEMPT_RESERVED', {
      kind: 'ATTEMPT_RESERVED', scope: 'plan', attempt: 1,
    }),
    phaseEnvelope(3, 'SPAWNED', {
      kind: 'ATTEMPT_STARTED', scope: 'plan', attempt: 1,
    }),
    phaseEnvelope(4, 'DONE', {
      kind: 'OBSERVED', scope: 'plan', attempt: 1,
    }),
    phaseEnvelope(5, 'ATTEMPT_RESERVED', {
      kind: 'ATTEMPT_RESERVED', scope: 'review', attempt: 3,
    }),
    phaseEnvelope(6, 'READY_FOR_PR', {
      kind: 'OBSERVED', scope: 'review', attempt: 3,
    }),
  ];

  const state = replayPhaseWorkflow(events, {
    scopes: ['plan', 'implement', 'review'],
    completionEvents: { plan: 'DONE', implement: 'DONE', review: 'READY_FOR_PR' },
  });

  assert.equal(state.baseline, BASELINE);
  assert.deepEqual(state.attemptsByScope, { plan: [1], implement: [], review: [3] });
  assert.equal(nextWorkflowAttempt(state, 'plan'), 2);
  assert.equal(nextWorkflowAttempt(state, 'review'), 4);
  assert.equal(workflowScopeCompleted(state, 'plan'), true);
  assert.equal(
    workflowScopeCompleted(state, 'plan', { runId, scope: 'plan', attempt: 1 }),
    true,
  );
  assert.equal(workflowScopeCompleted(state, 'review'), false, 'a reservation is not a spawn');
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.attemptsByScope.plan));
});

test('uncorrelated completion markers never complete a phase, including before the first spawn', () => {
  const marker = normalizeWorkflowEnvelope({
    schemaVersion: 1, sequence: 1, runId: null, timestamp: TIMESTAMP,
    event: 'DONE', kind: 'OBSERVED', scope: 'plan', attempt: null,
  }, { allowUncorrelated: true });
  const state = replayPhaseWorkflow([marker], {
    scopes: ['plan'], completionEvents: { plan: 'DONE' },
  });
  assert.equal(workflowScopeCompleted(state, 'plan'), false);
  assert.deepEqual(state.completions, []);
});

test('shared start classification permits dirty resumes but refuses dirty fresh commit state', () => {
  assert.deepEqual(
    classifyWorkflowStart({ hasDurableState: true }),
    { classification: 'RESUME_ALLOWED' },
  );
  assert.deepEqual(
    classifyWorkflowStart({ hasDurableState: false }),
    { classification: 'WORKTREE_OBSERVATION_REQUIRED' },
  );
  assert.deepEqual(
    classifyWorkflowStart({ hasDurableState: false, worktreeStatus: '' }),
    { classification: 'FRESH_ALLOWED' },
  );
  assert.deepEqual(
    classifyWorkflowStart({ hasDurableState: false, worktreeStatus: '?? stray.txt' }),
    { classification: 'DIRTY_FRESH_REFUSED' },
  );
});

test('the closed v1 envelope validates every event-specific schema', () => {
  const cases = [
    start({
      branch: 'feature/gear-4',
      baseline: BASELINE,
      mode: 'BOOLEAN',
      budget: 2,
      controllerCommitAuthorized: true,
    }),
    envelope('ATTEMPT_RESERVED', { attempt: 1 }),
    envelope('CHILD_COMPLETED', {
      attempt: 1,
      changedPaths: ['scripts/fix.mjs'],
      diffPath: `.apex/work/loops/2026-09-03-demo-loop/run-12345678-1234-4234-8234-123456789abc-attempt-1-diff.txt`,
      diffDigest: 'e'.repeat(64),
      snapshotDigest: 'f'.repeat(64),
    }),
    envelope('BLAST_RADIUS_CHECKED', { attempt: 1, passed: true }),
    envelope('VERIFIER_RECORDED', { attempt: 1, verdict: 'GOAL_REACHED', metric: null }),
    envelope('COMMIT_INTENT', { attempt: 1, commit: COMMIT }),
    envelope('COMMIT_RECORDED', { attempt: 1, commit: COMMIT }),
    envelope('DISCARD_INTENT', { attempt: 1 }),
    envelope('DISCARD_RECORDED', { attempt: 1 }),
    envelope('REVIEW_COMPLETED', { approved: true }),
    envelope('TERMINAL_RECORDED', { outcome: 'GOAL_REACHED' }),
    envelope('RECONCILIATION_REQUIRED', { attempt: 1, reason: 'ambiguous Git state' }),
    envelope('RUN_HALTED', { attempt: 1, reason: 'human recovery required' }),
  ];

  for (const candidate of cases) {
    const validated = validateWorkflowEvent(candidate);
    assert.deepEqual(validated, candidate, candidate.event);
    assert.notStrictEqual(validated, candidate, candidate.event);
    assert.ok(Object.isFrozen(validated), candidate.event);
  }
  assert.deepEqual(
    cases.map((candidate) => candidate.event),
    WORKFLOW_EVENT_NAMES,
  );
  assert.deepEqual(
    validateWorkflowEvent(envelope('RUN_HALTED', { attempt: null, reason: 'halted before mutation' })),
    envelope('RUN_HALTED', { attempt: null, reason: 'halted before mutation' }),
  );
});

test('the event envelope rejects malformed, unknown, missing, and extra data', () => {
  const started = start({
    branch: 'feature/gear-4',
    baseline: BASELINE,
    mode: 'BOOLEAN',
    budget: 2,
    controllerCommitAuthorized: true,
  });
  assert.throws(() => validateWorkflowEvent({ ...started, schemaVersion: 2 }), /unsupported schemaVersion 2/u);
  assert.throws(() => validateWorkflowEvent({ ...started, event: 'RUN_PAUSED' }), /unknown event name/u);
  assert.throws(() => validateWorkflowEvent({ ...started, surprise: true }), /unknown field 'surprise'/u);
  const { timestamp: _timestamp, ...missingTimestamp } = started;
  assert.throws(() => validateWorkflowEvent(missingTimestamp), /missing field 'timestamp'/u);
  assert.throws(() => validateWorkflowEvent({ ...started, sequence: 0 }), /sequence must be a positive/u);
  assert.throws(() => validateWorkflowEvent({ ...started, runId: '' }), /runId must be a non-empty/u);
  assert.throws(() => validateWorkflowEvent({ ...started, timestamp: 'tomorrow' }), /canonical UTC timestamp/u);
  assert.throws(() => validateWorkflowEvent({ ...started, baseline: 'HEAD' }), /Git object identity/u);
  assert.throws(() => validateWorkflowEvent({ ...started, mode: 'BOOL' }), /mode must be one of/u);
  assert.throws(() => validateWorkflowEvent({ ...started, budget: 0 }), /budget must be a positive/u);
  assert.throws(
    () => validateWorkflowEvent({ ...started, controllerCommitAuthorized: false }),
    /controller commit authorization must be true/u,
  );
  assert.throws(
    () => validateWorkflowEvent(envelope('VERIFIER_RECORDED', {
      attempt: 1, verdict: 'MAYBE', metric: null,
    })),
    /verdict must be one of/u,
  );
  assert.throws(
    () => validateWorkflowEvent(envelope('BLAST_RADIUS_CHECKED', { attempt: 1, passed: 'yes' })),
    /passed must be a boolean/u,
  );
  assert.throws(
    () => validateWorkflowEvent(envelope('RUN_HALTED', { reason: 'missing correlation' })),
    /missing field 'attempt'/u,
  );
});

test('the reducer covers the complete goal-reached commit and terminal transition chain', () => {
  const empty = createWorkflowState();
  const state = reduceWorkflowEvents(goalReachedStream());

  assert.equal(empty.phase, 'EMPTY');
  assert.equal(empty.executionTerminal, false);
  assert.deepEqual(empty.reservedAttempts, []);
  assert.equal(state.phase, 'TERMINAL_RECORDED');
  assert.equal(state.runId, RUN_ID);
  assert.equal(state.branch, 'feature/gear-4');
  assert.equal(state.baseline, BASELINE);
  assert.equal(state.lastSequence, 9);
  assert.deepEqual(state.reservedAttempts, [1]);
  assert.deepEqual(state.commits, [COMMIT]);
  assert.equal(state.attempts[0].verdict, 'GOAL_REACHED');
  assert.equal(state.attempts[0].disposition, 'COMMIT');
  assert.equal(state.attempts[0].commit, COMMIT);
  assert.equal(state.executionTerminal, true);
  assert.equal(state.goalSucceeded, true);
  assert.equal(state.terminalOutcome, 'GOAL_REACHED');
  assert.strictEqual(validateTerminalState(state), state);
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.attempts));
  assert.ok(Object.isFrozen(state.attempts[0]));
});

test('discard, review, and terminal reduction distinguish every clean outcome from goal success', () => {
  const cases = [
    [unsuccessfulTerminalStream(), 'BUDGET_EXHAUSTED', false],
    [unsuccessfulTerminalStream({ mode: 'METRIC', outcome: 'NO_IMPROVEMENT' }), 'NO_IMPROVEMENT', false],
    [goalReachedStream({ approved: false, outcome: 'REVIEW_REJECTED' }), 'REVIEW_REJECTED', false],
    [goalReachedStream(), 'GOAL_REACHED', true],
  ];

  for (const [events, outcome, goalSucceeded] of cases) {
    const state = reduceWorkflowEvents(events);
    assert.equal(state.executionTerminal, true, outcome);
    assert.equal(state.goalSucceeded, goalSucceeded, outcome);
    assert.equal(state.terminalOutcome, outcome, outcome);
    assert.strictEqual(validateTerminalState(state), state, outcome);
  }
});

test('shared terminal classification requires a goal-acceptable candidate for REVIEW_REJECTED', () => {
  const cases = [
    {
      name: 'boolean green rejected at exhaustion',
      events: goalReachedStream({ approved: false, outcome: 'REVIEW_REJECTED' }).slice(0, -1),
      acceptable: true,
      outcome: 'REVIEW_REJECTED',
    },
    {
      name: 'boolean red rejected at exhaustion',
      events: unsuccessfulTerminalStream({ approved: false }).slice(0, -1),
      acceptable: false,
      outcome: 'BUDGET_EXHAUSTED',
    },
    {
      name: 'metric equal rejected at exhaustion',
      events: unsuccessfulTerminalStream({ mode: 'METRIC', approved: false }).slice(0, -1),
      acceptable: false,
      outcome: 'NO_IMPROVEMENT',
    },
    {
      name: 'metric strict improvement rejected at exhaustion',
      events: [
        start({ mode: 'METRIC' }),
        sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 2),
        sequenced('CHILD_COMPLETED', { attempt: 1 }, 3),
        sequenced('BLAST_RADIUS_CHECKED', { attempt: 1, passed: true }, 4),
        sequenced('VERIFIER_RECORDED', { attempt: 1, verdict: 'KEEP', metric: -1 }, 5),
        sequenced('COMMIT_INTENT', { attempt: 1, commit: COMMIT }, 6),
        sequenced('COMMIT_RECORDED', { attempt: 1, commit: COMMIT }, 7),
        sequenced('REVIEW_COMPLETED', { approved: false }, 8),
      ],
      acceptable: true,
      outcome: 'REVIEW_REJECTED',
    },
  ];

  for (const scenario of cases) {
    const state = reduceWorkflowEvents(scenario.events);
    assert.equal(goalAcceptableCandidate(state), scenario.acceptable, scenario.name);
    assert.equal(selectTerminalOutcome(state), scenario.outcome, scenario.name);
    const terminal = reduceWorkflowEvent(state, sequenced(
      'TERMINAL_RECORDED',
      { outcome: scenario.outcome },
      state.lastSequence + 1,
    ));
    assert.strictEqual(validateTerminalState(terminal), terminal, scenario.name);
    assert.equal(terminal.goalSucceeded, scenario.outcome === 'GOAL_REACHED', scenario.name);
  }
});

test('shared terminal classification leaves non-exhausted rejected candidates open', () => {
  const acceptable = reduceWorkflowEvents(
    goalReachedStream({ approved: false, budget: 2 }).slice(0, -1),
  );
  assert.equal(goalAcceptableCandidate(acceptable), true);
  assert.equal(selectTerminalOutcome(acceptable), null);

  const red = reduceWorkflowEvents([
    start({ budget: 3 }),
    sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 2),
    sequenced('CHILD_COMPLETED', { attempt: 1 }, 3),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 1, passed: true }, 4),
    sequenced('VERIFIER_RECORDED', { attempt: 1, verdict: 'GOAL_REACHED', metric: null }, 5),
    sequenced('COMMIT_INTENT', { attempt: 1, commit: COMMIT }, 6),
    sequenced('COMMIT_RECORDED', { attempt: 1, commit: COMMIT }, 7),
    sequenced('REVIEW_COMPLETED', { approved: false }, 8),
    sequenced('ATTEMPT_RESERVED', { attempt: 2 }, 9),
    sequenced('CHILD_COMPLETED', { attempt: 2 }, 10),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 2, passed: true }, 11),
    sequenced('VERIFIER_RECORDED', { attempt: 2, verdict: 'KEEP', metric: null }, 12),
    sequenced('COMMIT_INTENT', { attempt: 2, commit: SECOND_COMMIT }, 13),
    sequenced('COMMIT_RECORDED', { attempt: 2, commit: SECOND_COMMIT }, 14),
    sequenced('REVIEW_COMPLETED', { approved: false }, 15),
  ]);
  assert.equal(goalAcceptableCandidate(red), false);
  assert.equal(selectTerminalOutcome(red), null);
});

test('boolean terminal classification follows the retained committed branch across a discarded review fix', () => {
  for (const approved of [true, false]) {
    const events = [
      start({ budget: 2 }),
      sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 2),
      sequenced('CHILD_COMPLETED', { attempt: 1 }, 3),
      sequenced('BLAST_RADIUS_CHECKED', { attempt: 1, passed: true }, 4),
      sequenced('VERIFIER_RECORDED', { attempt: 1, verdict: 'GOAL_REACHED', metric: null }, 5),
      sequenced('COMMIT_INTENT', { attempt: 1, commit: COMMIT }, 6),
      sequenced('COMMIT_RECORDED', { attempt: 1, commit: COMMIT }, 7),
      sequenced('REVIEW_COMPLETED', { approved: false }, 8),
      sequenced('ATTEMPT_RESERVED', { attempt: 2 }, 9),
      sequenced('CHILD_COMPLETED', { attempt: 2 }, 10),
      sequenced('BLAST_RADIUS_CHECKED', { attempt: 2, passed: false }, 11),
      sequenced('DISCARD_INTENT', { attempt: 2 }, 12),
      sequenced('DISCARD_RECORDED', { attempt: 2 }, 13),
      sequenced('REVIEW_COMPLETED', { approved }, 14),
    ];
    const state = reduceWorkflowEvents(events);
    assert.equal(goalAcceptableCandidate(state), true, `approved=${approved}`);
    assert.equal(
      selectTerminalOutcome(state),
      approved ? 'GOAL_REACHED' : 'REVIEW_REJECTED',
      `approved=${approved}`,
    );
  }
});

test('a rejected review can consume another reserved budget unit, but attempts are never reused', () => {
  const first = goalReachedStream({ approved: false, outcome: 'REVIEW_REJECTED', budget: 2 }).slice(0, -1);
  const state = reduceWorkflowEvents([
    ...first,
    sequenced('ATTEMPT_RESERVED', { attempt: 2 }, 9),
  ]);
  assert.equal(state.phase, 'ATTEMPT_RESERVED');
  assert.deepEqual(state.reservedAttempts, [1, 2]);
  assert.equal(state.review, null);
  assert.equal(state.reviewHistory.length, 1);
  assert.throws(
    () => reduceWorkflowEvent(state, sequenced('ATTEMPT_RESERVED', { attempt: 2 }, 10)),
    /attempt identity 2 was already reserved/u,
  );
});

test('every budgeted review-fix attempt is reviewed again even when its verifier remains red', () => {
  const firstReview = goalReachedStream({ approved: false, budget: 3 }).slice(0, -1);
  const state = reduceWorkflowEvents([
    ...firstReview,
    sequenced('ATTEMPT_RESERVED', { attempt: 2 }, 9),
    sequenced('CHILD_COMPLETED', { attempt: 2 }, 10),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 2, passed: true }, 11),
    sequenced('VERIFIER_RECORDED', { attempt: 2, verdict: 'KEEP', metric: null }, 12),
    sequenced('COMMIT_INTENT', { attempt: 2, commit: SECOND_COMMIT }, 13),
    sequenced('COMMIT_RECORDED', { attempt: 2, commit: SECOND_COMMIT }, 14),
    sequenced('REVIEW_COMPLETED', { approved: false }, 15),
  ]);
  assert.equal(state.phase, 'REVIEW_COMPLETED');
  assert.equal(state.reviewHistory.length, 2);
  assert.equal(state.reservedAttempts.length, 2);
});

test('review approval cannot turn a still-red fix into goal success or hide remaining budget', () => {
  const firstReview = goalReachedStream({ approved: false, budget: 3 }).slice(0, -1);
  const state = reduceWorkflowEvents([
    ...firstReview,
    sequenced('ATTEMPT_RESERVED', { attempt: 2 }, 9),
    sequenced('CHILD_COMPLETED', { attempt: 2 }, 10),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 2, passed: true }, 11),
    sequenced('VERIFIER_RECORDED', { attempt: 2, verdict: 'KEEP', metric: null }, 12),
    sequenced('COMMIT_INTENT', { attempt: 2, commit: SECOND_COMMIT }, 13),
    sequenced('COMMIT_RECORDED', { attempt: 2, commit: SECOND_COMMIT }, 14),
    sequenced('REVIEW_COMPLETED', { approved: true }, 15),
    sequenced('ATTEMPT_RESERVED', { attempt: 3 }, 16),
  ]);
  assert.equal(state.phase, 'ATTEMPT_RESERVED');
  assert.equal(state.currentAttempt, 3);
  assert.equal(state.goalSucceeded, false);
});

test('ambiguous commit reconciliation and failed blast-radius checks halt without a clean outcome', () => {
  const pendingCommit = goalReachedStream().slice(0, 6);
  const reconciliationState = reduceWorkflowEvents([
    ...pendingCommit,
    sequenced('RECONCILIATION_REQUIRED', { attempt: 1, reason: 'dirty worktree' }, 7),
    sequenced('RUN_HALTED', { attempt: 1, reason: 'human recovery required' }, 8),
  ]);
  assert.equal(reconciliationState.executionTerminal, true);
  assert.equal(reconciliationState.goalSucceeded, false);
  assert.equal(reconciliationState.terminalOutcome, null);
  assert.equal(reconciliationState.reconciliation.reason, 'dirty worktree');
  assert.throws(() => validateTerminalState(reconciliationState), /not a clean terminal state/u);

  const failedBlast = reduceWorkflowEvents([
    start(),
    sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 2),
    sequenced('CHILD_COMPLETED', { attempt: 1 }, 3),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 1, passed: false }, 4),
    sequenced('RUN_HALTED', { attempt: 1, reason: 'blast radius exceeded' }, 5),
  ]);
  assert.equal(failedBlast.phase, 'RUN_HALTED');
  assert.equal(failedBlast.haltReason, 'blast radius exceeded');
  assert.equal(failedBlast.terminalOutcome, null);
});

test('terminal Git ambiguity may only append reconciliation then halt', () => {
  const terminal = reduceWorkflowEvents(goalReachedStream());
  const reconciliation = reduceWorkflowEvent(terminal, sequenced(
    'RECONCILIATION_REQUIRED',
    { attempt: null, reason: 'terminal replay HEAD drift' },
    terminal.lastSequence + 1,
  ));
  assert.equal(reconciliation.phase, 'RECONCILIATION_REQUIRED');
  assert.equal(reconciliation.executionTerminal, true);
  assert.throws(
    () => reduceWorkflowEvent(reconciliation, sequenced(
      'ATTEMPT_RESERVED',
      { attempt: 2 },
      reconciliation.lastSequence + 1,
    )),
    /event after execution terminality/u,
  );
  const halted = reduceWorkflowEvent(reconciliation, sequenced(
    'RUN_HALTED',
    { attempt: null, reason: 'terminal replay HEAD drift' },
    reconciliation.lastSequence + 1,
  ));
  assert.equal(halted.phase, 'RUN_HALTED');
  assert.equal(halted.terminalOutcome, null);
  assert.equal(halted.goalSucceeded, false);
});

test('reduction rejects duplicate, reordered, cross-run, truncated, and post-terminal identities', () => {
  const started = reduceWorkflowEvent(createWorkflowState(), start());
  assert.throws(
    () => reduceWorkflowEvent(started, { ...start(), timestamp: sequenced('x', {}, 2).timestamp }),
    /duplicate sequence identity 1/u,
  );
  assert.throws(
    () => reduceWorkflowEvent(started, sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 3)),
    /truncated stream.*expected sequence 2/u,
  );
  assert.throws(
    () => reduceWorkflowEvent(started, {
      ...sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 2),
      runId: 'another-run',
    }),
    /run correlation/u,
  );
  assert.throws(
    () => reduceWorkflowEvent(started, {
      ...sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 2),
      timestamp: '2026-09-03T09:59:59.000Z',
    }),
    /reordered timestamp/u,
  );
  assert.throws(
    () => reduceWorkflowEvent(started, sequenced('ATTEMPT_RESERVED', { attempt: 2 }, 2)),
    /next attempt must be 1/u,
  );
  const terminal = reduceWorkflowEvents(goalReachedStream());
  assert.throws(
    () => reduceWorkflowEvent(terminal, sequenced('RUN_HALTED', { attempt: null, reason: 'too late' }, 10)),
    /event after execution terminality/u,
  );
});

test('the reducer rejects impossible transitions, mismatched actions, and duplicate commit identities', () => {
  assert.throws(
    () => reduceWorkflowEvents([sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 1)]),
    /first event must be RUN_STARTED/u,
  );
  assert.throws(
    () => reduceWorkflowEvents([start(), sequenced('CHILD_COMPLETED', { attempt: 1 }, 2)]),
    /CHILD_COMPLETED cannot follow RUN_STARTED/u,
  );
  assert.throws(
    () => reduceWorkflowEvents([
      start(),
      sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 2),
      sequenced('CHILD_COMPLETED', { attempt: 1 }, 3),
      sequenced('BLAST_RADIUS_CHECKED', { attempt: 1, passed: false }, 4),
      sequenced('VERIFIER_RECORDED', { attempt: 1, verdict: 'GOAL_REACHED', metric: null }, 5),
    ]),
    /verifier requires a passed blast-radius check/u,
  );
  assert.throws(
    () => reduceWorkflowEvents([
      ...unsuccessfulTerminalStream({ mode: 'METRIC' }).slice(0, 5),
      sequenced('COMMIT_INTENT', { attempt: 1, commit: COMMIT }, 6),
    ]),
    /commit intent requires a keep verdict/u,
  );
  assert.throws(
    () => reduceWorkflowEvents([
      ...goalReachedStream().slice(0, 6),
      sequenced('COMMIT_RECORDED', { attempt: 1, commit: 'c'.repeat(40) }, 7),
    ]),
    /does not match commit intent/u,
  );
  assert.throws(
    () => reduceWorkflowEvents(goalReachedStream({ outcome: 'BUDGET_EXHAUSTED' })),
    /terminal outcome must be GOAL_REACHED/u,
  );
  assert.throws(
    () => reduceWorkflowEvents([
      ...goalReachedStream({ budget: 2 }).slice(0, 7),
      sequenced('ATTEMPT_RESERVED', { attempt: 2 }, 8),
    ]),
    /goal-reaching attempt requires review/u,
  );

  const firstCommit = reduceWorkflowEvents([
    start({ mode: 'METRIC', budget: 2, baselineMetric: 10 }),
    sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 2),
    sequenced('CHILD_COMPLETED', { attempt: 1 }, 3),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 1, passed: true }, 4),
    sequenced('VERIFIER_RECORDED', { attempt: 1, verdict: 'KEEP', metric: 9 }, 5),
    sequenced('COMMIT_INTENT', { attempt: 1, commit: COMMIT }, 6),
    sequenced('COMMIT_RECORDED', { attempt: 1, commit: COMMIT }, 7),
    sequenced('ATTEMPT_RESERVED', { attempt: 2 }, 8),
    sequenced('CHILD_COMPLETED', { attempt: 2 }, 9),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 2, passed: true }, 10),
    sequenced('VERIFIER_RECORDED', { attempt: 2, verdict: 'KEEP', metric: 8 }, 11),
  ]);
  assert.throws(
    () => reduceWorkflowEvent(firstCommit, sequenced('COMMIT_INTENT', { attempt: 2, commit: COMMIT }, 12)),
    /commit identity.*already belongs to attempt 1/u,
  );
});

test('JSONL parsing and reduction preserve the validated source byte-for-byte', () => {
  const lines = goalReachedStream().map((event) => JSON.stringify(event));
  const source = `${lines.join('\r\n')}\r\n`;
  const bytes = Buffer.from(source, 'utf8');
  const parsed = parseWorkflowJsonl(bytes);

  assert.equal(parsed.length, 9);
  assert.deepEqual(parsed, goalReachedStream());
  assert.equal(parsed.sourceBytes, source);
  assert.equal(parsed.byteLength, bytes.length);
  assert.equal(parsed.records[0].bytes, `${lines[0]}\r\n`);
  assert.equal(parsed.records[0].lineNumber, 1);
  assert.strictEqual(parsed.records[0].event, parsed[0]);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.records));

  const state = reduceWorkflowJsonl(bytes);
  assert.equal(state.terminalOutcome, 'GOAL_REACHED');
  assert.equal(state.validatedJsonl, source);
  assert.equal(state.validatedByteLength, bytes.length);
  assert.equal(Buffer.compare(Buffer.from(state.validatedJsonl, 'utf8'), bytes), 0);
});

test('JSONL fails closed on malformed, duplicated, gapped, unknown-version, blank, and truncated streams', () => {
  const [started, reserved] = goalReachedStream();
  assert.throws(() => parseWorkflowJsonl('{"broken":\n'), /malformed JSONL at line 1/u);
  assert.throws(() => parseWorkflowJsonl(`${JSON.stringify(started)}\n\n`), /blank JSONL record at line 2/u);
  assert.throws(
    () => parseWorkflowJsonl(Buffer.from([0xc3, 0x28, 0x0a])),
    /JSONL must be valid UTF-8/u,
  );
  assert.throws(
    () => parseWorkflowJsonl(JSON.stringify(started)),
    /truncated JSONL stream.*final LF/u,
  );
  assert.throws(
    () => reduceWorkflowJsonl(`${JSON.stringify(started)}\n${JSON.stringify(started)}\n`),
    /duplicate sequence identity 1/u,
  );
  assert.throws(
    () => reduceWorkflowJsonl(`${JSON.stringify(started)}\n${JSON.stringify({ ...reserved, sequence: 3 })}\n`),
    /truncated stream.*expected sequence 2/u,
  );
  assert.throws(
    () => reduceWorkflowJsonl(`${JSON.stringify({ ...started, schemaVersion: 99 })}\n`),
    /unsupported schemaVersion 99/u,
  );
  assert.throws(
    () => parseWorkflowJsonl(`${JSON.stringify({ ...started, extra: 'closed' })}\n`),
    /unknown field 'extra'/u,
  );
  assert.throws(() => parseWorkflowJsonl(42), /JSONL input must be a string or byte array/u);
});

test('commit reconciliation identifies the one safe controller-owned case and never proposes Git mutation', () => {
  const pending = reduceWorkflowEvents([
    start(),
    sequenced('ATTEMPT_RESERVED', {
      attempt: 1, expectedParent: BASELINE, snapshotDigest: '1'.repeat(64),
    }, 2),
    sequenced('CHILD_COMPLETED', {
      attempt: 1,
      changedPaths: ['scripts/fix.mjs'],
      diffPath: `.apex/work/loops/demo/run-${RUN_ID}-attempt-1-diff.txt`,
      diffDigest: '2'.repeat(64),
      snapshotDigest: '3'.repeat(64),
    }, 3),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 1, passed: true }, 4),
    sequenced('VERIFIER_RECORDED', { attempt: 1, verdict: 'GOAL_REACHED', metric: null }, 5),
    sequenced('COMMIT_INTENT', { attempt: 1, commit: COMMIT }, 6),
  ]);
  const proof = {
    head: COMMIT,
    worktreeClean: true,
    commit: COMMIT,
    parent: BASELINE,
    runId: RUN_ID,
    attempt: 1,
    expectedParent: BASELINE,
    owner: 'steepy-loop-engineer-v1',
    unique: true,
    snapshotDigest: null,
  };
  const safe = classifyCommitReconciliation(pending, {
    ...proof,
  });
  assert.deepEqual(safe, {
    classification: 'SAFE_CONTROLLER_COMMIT',
    attempt: 1,
    commit: COMMIT,
  });
  assert.ok(Object.isFrozen(safe));
  assert.deepEqual(Object.keys(safe), ['classification', 'attempt', 'commit']);

  assert.deepEqual(
    classifyCommitReconciliation(pending, { ...proof, worktreeClean: false }),
    { classification: 'AMBIGUOUS_GIT_STATE', reason: 'DIRTY_WORKTREE' },
  );
  assert.deepEqual(
    classifyCommitReconciliation(pending, {
      ...proof,
      worktreeClean: false,
      worktreeMatchesCommit: true,
    }),
    {
      classification: 'SAFE_PARTIAL_CONTROLLER_COMMIT',
      attempt: 1,
      commit: COMMIT,
      expectedParent: BASELINE,
    },
  );
  assert.deepEqual(
    classifyCommitReconciliation(pending, { ...proof, runId: 'forged-run' }),
    { classification: 'AMBIGUOUS_GIT_STATE', reason: 'COMMIT_METADATA_MISMATCH' },
  );
  assert.deepEqual(
    classifyCommitReconciliation(pending, {
      ...proof,
      head: BASELINE,
      snapshotDigest: '3'.repeat(64),
    }),
    {
      classification: 'SAFE_PENDING_CONTROLLER_COMMIT',
      attempt: 1,
      commit: COMMIT,
      expectedParent: BASELINE,
    },
  );

  const recorded = reduceWorkflowEvents(goalReachedStream().slice(0, 7));
  assert.deepEqual(
    classifyCommitReconciliation(recorded, proof),
    { classification: 'NOT_REQUIRED' },
  );
  assert.throws(
    () => classifyCommitReconciliation(pending, { ...proof, reset: true }),
    /unknown Git observation field 'reset'/u,
  );
});

test('a durable reconciliation-required event can never be reclassified as safe automatically', () => {
  const ambiguous = reduceWorkflowEvents([
    ...goalReachedStream().slice(0, 6),
    sequenced('RECONCILIATION_REQUIRED', { attempt: 1, reason: 'operator decision needed' }, 7),
  ]);
  assert.deepEqual(
    classifyCommitReconciliation(ambiguous, {
      head: COMMIT,
      worktreeClean: true,
      commit: COMMIT,
      parent: BASELINE,
      runId: RUN_ID,
      attempt: 1,
      expectedParent: BASELINE,
      owner: 'steepy-loop-engineer-v1',
      unique: true,
      snapshotDigest: null,
    }),
    { classification: 'AMBIGUOUS_GIT_STATE', reason: 'RECONCILIATION_ALREADY_REQUIRED' },
  );
});

test('the selected baseline can never become a controller commit identity or safe reconciliation', () => {
  const collidingIntent = [
    start(),
    sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 2),
    sequenced('CHILD_COMPLETED', { attempt: 1 }, 3),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 1, passed: true }, 4),
    sequenced('VERIFIER_RECORDED', { attempt: 1, verdict: 'GOAL_REACHED', metric: null }, 5),
    sequenced('COMMIT_INTENT', { attempt: 1, commit: BASELINE }, 6),
  ];
  assert.throws(
    () => reduceWorkflowEvents(collidingIntent),
    /commit identity.*selected baseline/u,
  );

  const inconsistentState = reduceWorkflowEvents(goalReachedStream().slice(0, 6));
  const baselineCollision = Object.freeze({
    ...inconsistentState,
    baseline: inconsistentState.pendingCommit.commit,
  });
  assert.deepEqual(
    classifyCommitReconciliation(baselineCollision, {
      head: COMMIT, worktreeClean: true, commit: COMMIT, parent: BASELINE,
      runId: RUN_ID, attempt: 1, expectedParent: BASELINE,
      owner: 'steepy-loop-engineer-v1', unique: true, snapshotDigest: null,
    }),
    { classification: 'AMBIGUOUS_GIT_STATE', reason: 'BASELINE_IDENTITY_COLLISION' },
  );
  assert.deepEqual(
    classifyCommitReconciliation(inconsistentState, {
      head: COMMIT, worktreeClean: true, commit: COMMIT, parent: BASELINE,
      runId: RUN_ID, attempt: 1, expectedParent: BASELINE,
      owner: 'steepy-loop-engineer-v1', unique: true, snapshotDigest: null,
    }),
    { classification: 'AMBIGUOUS_GIT_STATE', reason: 'MISSING_EXPECTED_PARENT' },
  );
});

test('reconciliation is a durable general halt transition for any active replay prefix', () => {
  const child = reduceWorkflowEvents([
    start(),
    sequenced('ATTEMPT_RESERVED', {
      attempt: 1, expectedParent: BASELINE, snapshotDigest: '1'.repeat(64),
    }, 2),
    sequenced('CHILD_COMPLETED', {
      attempt: 1,
      changedPaths: ['scripts/fix.mjs'],
      diffPath: `.apex/work/loops/demo/run-${RUN_ID}-attempt-1-diff.txt`,
      diffDigest: '2'.repeat(64),
      snapshotDigest: '3'.repeat(64),
    }, 3),
  ]);
  const required = reduceWorkflowEvent(child, sequenced('RECONCILIATION_REQUIRED', {
    attempt: 1, reason: 'snapshot proof is ambiguous',
  }, 4));
  const halted = reduceWorkflowEvent(required, sequenced('RUN_HALTED', {
    attempt: 1, reason: 'snapshot proof is ambiguous',
  }, 5));
  assert.equal(halted.executionTerminal, true);
  assert.equal(halted.reconciliation.reason, 'snapshot proof is ambiguous');
  assert.equal(halted.goalSucceeded, false);
});

test('a recorded blast-radius discard permits the next immutable attempt reservation', () => {
  const state = reduceWorkflowEvents([
    start({ budget: 2 }),
    sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 2),
    sequenced('CHILD_COMPLETED', { attempt: 1 }, 3),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 1, passed: false }, 4),
    sequenced('DISCARD_INTENT', { attempt: 1 }, 5),
    sequenced('DISCARD_RECORDED', { attempt: 1 }, 6),
    sequenced('ATTEMPT_RESERVED', { attempt: 2 }, 7),
  ]);
  assert.equal(state.phase, 'ATTEMPT_RESERVED');
  assert.equal(state.currentAttempt, 2);
  assert.deepEqual(state.reservedAttempts, [1, 2]);
  assert.equal(state.attempts[0].disposition, 'DISCARD');
});

test('a metric KEEP commit is reviewable and can reach a clean goal terminal before budget exhaustion', () => {
  const state = reduceWorkflowEvents([
    start({ mode: 'METRIC', budget: 2, baselineMetric: 10 }),
    sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 2),
    sequenced('CHILD_COMPLETED', { attempt: 1 }, 3),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 1, passed: true }, 4),
    sequenced('VERIFIER_RECORDED', { attempt: 1, verdict: 'KEEP', metric: 9 }, 5),
    sequenced('COMMIT_INTENT', { attempt: 1, commit: COMMIT }, 6),
    sequenced('COMMIT_RECORDED', { attempt: 1, commit: COMMIT }, 7),
    sequenced('REVIEW_COMPLETED', { approved: true }, 8),
    sequenced('TERMINAL_RECORDED', { outcome: 'GOAL_REACHED' }, 9),
  ]);
  assert.equal(state.executionTerminal, true);
  assert.equal(state.goalSucceeded, true);
  assert.equal(state.terminalOutcome, 'GOAL_REACHED');
  assert.deepEqual(state.reservedAttempts, [1]);
  assert.equal(state.budget, 2);
  assert.deepEqual(state.commits, [COMMIT]);
  assert.strictEqual(validateTerminalState(state), state);
});

test('metric replay rejects boolean-only verdicts and non-improving commit intents', () => {
  const metricPrefix = (metricDirection = 'min') => reduceWorkflowEvents([
    start({ mode: 'METRIC', budget: 2, baselineMetric: 10, metricDirection }),
    sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 2),
    sequenced('CHILD_COMPLETED', { attempt: 1 }, 3),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 1, passed: true }, 4),
  ]);
  assert.throws(
    () => reduceWorkflowEvent(metricPrefix(), sequenced(
      'VERIFIER_RECORDED', { attempt: 1, verdict: 'GOAL_REACHED', metric: 9 }, 5,
    )),
    /metric.*verdict|verdict.*metric/iu,
  );

  const booleanPrefix = reduceWorkflowEvents([
    start(),
    sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 2),
    sequenced('CHILD_COMPLETED', { attempt: 1 }, 3),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 1, passed: true }, 4),
  ]);
  assert.throws(
    () => reduceWorkflowEvent(booleanPrefix, sequenced(
      'VERIFIER_RECORDED', { attempt: 1, verdict: 'DISCARD', metric: null }, 5,
    )),
    /boolean.*verdict|verdict.*boolean/iu,
  );

  for (const scenario of [
    { direction: 'min', retained: 9, candidate: 9 },
    { direction: 'min', retained: 9, candidate: 10 },
    { direction: 'max', retained: 11, candidate: 11 },
    { direction: 'max', retained: 11, candidate: 10 },
  ]) {
    const state = reduceWorkflowEvents([
      start({
        mode: 'METRIC', budget: 2, baselineMetric: 10,
        metricDirection: scenario.direction,
      }),
      sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 2),
      sequenced('CHILD_COMPLETED', { attempt: 1 }, 3),
      sequenced('BLAST_RADIUS_CHECKED', { attempt: 1, passed: true }, 4),
      sequenced('VERIFIER_RECORDED', {
        attempt: 1, verdict: 'KEEP', metric: scenario.retained,
      }, 5),
      sequenced('COMMIT_INTENT', { attempt: 1, commit: COMMIT }, 6),
      sequenced('COMMIT_RECORDED', { attempt: 1, commit: COMMIT }, 7),
      sequenced('ATTEMPT_RESERVED', { attempt: 2 }, 8),
      sequenced('CHILD_COMPLETED', { attempt: 2 }, 9),
      sequenced('BLAST_RADIUS_CHECKED', { attempt: 2, passed: true }, 10),
      sequenced('VERIFIER_RECORDED', {
        attempt: 2, verdict: 'KEEP', metric: scenario.candidate,
      }, 11),
    ]);
    assert.throws(
      () => reduceWorkflowEvent(state, sequenced(
        'COMMIT_INTENT', { attempt: 2, commit: SECOND_COMMIT }, 12,
      )),
      /strict improvement|metric.*keep|commit intent/iu,
      JSON.stringify(scenario),
    );
  }
});

test('a metric KEEP commit continues to a second attempt and a clean goal terminal', () => {
  const state = reduceWorkflowEvents([
    start({ mode: 'METRIC', budget: 2, baselineMetric: 10 }),
    sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 2),
    sequenced('CHILD_COMPLETED', { attempt: 1 }, 3),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 1, passed: true }, 4),
    sequenced('VERIFIER_RECORDED', { attempt: 1, verdict: 'KEEP', metric: 9 }, 5),
    sequenced('COMMIT_INTENT', { attempt: 1, commit: COMMIT }, 6),
    sequenced('COMMIT_RECORDED', { attempt: 1, commit: COMMIT }, 7),
    sequenced('ATTEMPT_RESERVED', { attempt: 2 }, 8),
    sequenced('CHILD_COMPLETED', { attempt: 2 }, 9),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 2, passed: true }, 10),
    sequenced('VERIFIER_RECORDED', { attempt: 2, verdict: 'KEEP', metric: 8 }, 11),
    sequenced('COMMIT_INTENT', { attempt: 2, commit: SECOND_COMMIT }, 12),
    sequenced('COMMIT_RECORDED', { attempt: 2, commit: SECOND_COMMIT }, 13),
    sequenced('REVIEW_COMPLETED', { approved: true }, 14),
    sequenced('TERMINAL_RECORDED', { outcome: 'GOAL_REACHED' }, 15),
  ]);
  assert.equal(state.executionTerminal, true);
  assert.equal(state.goalSucceeded, true);
  assert.equal(state.terminalOutcome, 'GOAL_REACHED');
  assert.deepEqual(state.commits, [COMMIT, SECOND_COMMIT]);
  assert.deepEqual(state.attempts.map(({ verdict }) => verdict), ['KEEP', 'KEEP']);
  assert.strictEqual(validateTerminalState(state), state);
});

test('baseline verifier facts support zero-attempt boolean success and metric baselines', () => {
  const boolean = reduceWorkflowEvents([
    start({ budget: 2, baselinePassed: true }),
    sequenced('REVIEW_COMPLETED', { approved: true }, 2),
    sequenced('TERMINAL_RECORDED', { outcome: 'GOAL_REACHED' }, 3),
  ]);
  assert.deepEqual(boolean.reservedAttempts, []);
  assert.deepEqual(boolean.baselineVerifier, { exit: 0, passed: true, metric: null });
  assert.equal(boolean.terminalOutcome, 'GOAL_REACHED');

  const metric = reduceWorkflowEvents([
    start({ mode: 'METRIC', budget: 1, metricDirection: 'max', baselinePassed: true, baselineMetric: 4.25 }),
    sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 2),
  ]);
  assert.deepEqual(metric.baselineVerifier, { exit: 0, passed: true, metric: 4.25 });
  assert.equal(metric.currentAttempt, 1);
});

test('boolean red checkpoints use KEEP commits and blast violations discard without verification', () => {
  const redCheckpoint = reduceWorkflowEvents([
    start({ budget: 2 }),
    sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 2),
    sequenced('CHILD_COMPLETED', { attempt: 1 }, 3),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 1, passed: true }, 4),
    sequenced('VERIFIER_RECORDED', { attempt: 1, verdict: 'KEEP', metric: null }, 5),
    sequenced('COMMIT_INTENT', { attempt: 1, commit: COMMIT }, 6),
    sequenced('COMMIT_RECORDED', { attempt: 1, commit: COMMIT }, 7),
    sequenced('ATTEMPT_RESERVED', { attempt: 2 }, 8),
  ]);
  assert.equal(redCheckpoint.attempts[0].verdict, 'KEEP');
  assert.equal(redCheckpoint.currentAttempt, 2);

  const violating = reduceWorkflowEvents([
    start({ budget: 2 }),
    sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 2),
    sequenced('CHILD_COMPLETED', { attempt: 1 }, 3),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 1, passed: false }, 4),
    sequenced('DISCARD_INTENT', { attempt: 1 }, 5),
    sequenced('DISCARD_RECORDED', { attempt: 1 }, 6),
    sequenced('ATTEMPT_RESERVED', { attempt: 2 }, 7),
  ]);
  assert.equal(violating.attempts[0].blastRadiusPassed, false);
  assert.equal(violating.attempts[0].disposition, 'DISCARD');
});

test('metric terminality derives success from any strict improvement, not the last discarded trial', () => {
  const state = reduceWorkflowEvents([
    start({ mode: 'METRIC', budget: 2, metricDirection: 'min', baselinePassed: true, baselineMetric: 10 }),
    sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 2),
    sequenced('CHILD_COMPLETED', { attempt: 1 }, 3),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 1, passed: true }, 4),
    sequenced('VERIFIER_RECORDED', { attempt: 1, verdict: 'KEEP', metric: 8 }, 5),
    sequenced('COMMIT_INTENT', { attempt: 1, commit: COMMIT }, 6),
    sequenced('COMMIT_RECORDED', { attempt: 1, commit: COMMIT }, 7),
    sequenced('ATTEMPT_RESERVED', { attempt: 2 }, 8),
    sequenced('CHILD_COMPLETED', { attempt: 2 }, 9),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 2, passed: true }, 10),
    sequenced('VERIFIER_RECORDED', { attempt: 2, verdict: 'DISCARD', metric: 9 }, 11),
    sequenced('DISCARD_INTENT', { attempt: 2 }, 12),
    sequenced('DISCARD_RECORDED', { attempt: 2 }, 13),
    sequenced('REVIEW_COMPLETED', { approved: true }, 14),
    sequenced('TERMINAL_RECORDED', { outcome: 'GOAL_REACHED' }, 15),
  ]);
  assert.deepEqual(state.attempts.map(({ metric }) => metric), [8, 9]);
  assert.equal(state.terminalOutcome, 'GOAL_REACHED');
});

test('a run can halt before reserving an attempt with explicit null correlation', () => {
  const state = reduceWorkflowEvents([
    start({ budget: 2 }),
    sequenced('RUN_HALTED', { attempt: null, reason: 'preflight refused' }, 2),
  ]);
  assert.equal(state.phase, 'RUN_HALTED');
  assert.equal(state.executionTerminal, true);
  assert.equal(state.goalSucceeded, false);
  assert.equal(state.terminalOutcome, null);
  assert.equal(state.currentAttempt, null);
  assert.equal(state.haltReason, 'preflight refused');
});

test('RUN_STARTED is the sole durable baseline fact and mode semantics are closed', () => {
  const boolean = validateWorkflowEvent(start({
    baselineExit: 0, baselinePassed: true, baselineMetric: null,
  }));
  assert.equal(boolean.baselineExit, 0);
  assert.equal(boolean.baselinePassed, true);
  assert.equal(boolean.baselineMetric, null);
  const metric = validateWorkflowEvent(start({
    mode: 'METRIC', metricDirection: 'min', baselineExit: 0,
    baselinePassed: true, baselineMetric: 3.5,
  }));
  assert.equal(metric.baselineExit, 0);
  assert.equal(metric.baselineMetric, 3.5);
  const failed = reduceWorkflowEvents([start({ baselineExit: 2 })]);
  assert.equal(failed.baselineVerifier.exit, 2);
  assert.equal(failed.baselineVerifier.passed, false);
  assert.throws(
    () => validateWorkflowEvent(start({ baselineMetric: 1 })),
    /boolean.*baselineMetric|baselineMetric.*boolean/iu,
  );
  assert.throws(
    () => validateWorkflowEvent(start({ mode: 'METRIC', metricDirection: 'min', baselineMetric: null })),
    /metric.*baselineMetric|baselineMetric.*metric/iu,
  );
  for (const candidate of [
    start({ baselineExit: -1 }),
    start({ baselineExit: 1.5 }),
    start({ baselineExit: 0, baselinePassed: false }),
    start({ baselineExit: 2, baselinePassed: true }),
    start({ mode: 'METRIC', metricDirection: 'min', baselineExit: 2 }),
  ]) {
    assert.throws(() => validateWorkflowEvent(candidate), /baselineExit|baseline.*exit/iu);
  }
});

test('observability degradation is reduced monotonically from existing event fields', () => {
  const degraded = reduceWorkflowEvents([
    start(),
    sequenced('ATTEMPT_RESERVED', { attempt: 1 }, 2),
    sequenced('CHILD_COMPLETED', { attempt: 1, observabilityDegraded: true }, 3),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 1, passed: false }, 4),
    sequenced('DISCARD_INTENT', { attempt: 1 }, 5),
    sequenced('DISCARD_RECORDED', { attempt: 1 }, 6),
  ]);
  assert.equal(degraded.observabilityDegraded, true);
  assert.throws(
    () => reduceWorkflowEvent(degraded, sequenced('REVIEW_COMPLETED', {
      approved: true, observabilityDegraded: false,
    }, 7)),
    /observability.*(?:regress|monotonic)|degrad/iu,
  );
});

test('spent incomplete reservations advance monotonically while preserving both budget identities', () => {
  const firstSnapshot = '1'.repeat(64);
  const secondSnapshot = '2'.repeat(64);
  const state = reduceWorkflowEvents([
    start({ budget: 2 }),
    sequenced('ATTEMPT_RESERVED', {
      attempt: 1, expectedParent: BASELINE, snapshotDigest: firstSnapshot,
    }, 2),
    sequenced('ATTEMPT_RESERVED', {
      attempt: 2, expectedParent: BASELINE, snapshotDigest: secondSnapshot,
    }, 3),
  ]);
  assert.deepEqual(state.reservedAttempts, [1, 2]);
  assert.equal(state.attempts[0].completed, false);
  assert.equal(state.attempts[0].spent, true);
  assert.equal(state.currentAttempt, 2);
  assert.throws(
    () => reduceWorkflowEvent(state, sequenced('ATTEMPT_RESERVED', {
      attempt: 3, expectedParent: BASELINE, snapshotDigest: '3'.repeat(64),
    }, 4)),
    /budget/iu,
  );
});

test('child completion binds immutable diff evidence and replay accepts every durable prefix', () => {
  const diffPath = `.apex/work/loops/2026-09-03-demo-loop/run-${'12345678-1234-4234-8234-123456789abc'}-attempt-1-diff.txt`;
  const reviewDiffPath = `.apex/work/loops/2026-09-03-demo-loop/run-${'12345678-1234-4234-8234-123456789abc'}-review-1-diff.txt`;
  const stream = [
    start(),
    sequenced('ATTEMPT_RESERVED', {
      attempt: 1, expectedParent: BASELINE, snapshotDigest: '1'.repeat(64),
    }, 2),
    sequenced('CHILD_COMPLETED', {
      attempt: 1,
      changedPaths: ['scripts/fix.mjs', 'tests/fix.test.mjs'],
      diffPath,
      diffDigest: '2'.repeat(64),
      snapshotDigest: '3'.repeat(64),
    }, 3),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 1, passed: true }, 4),
    sequenced('VERIFIER_RECORDED', { attempt: 1, verdict: 'GOAL_REACHED', metric: null }, 5),
    sequenced('COMMIT_INTENT', { attempt: 1, commit: COMMIT }, 6),
    sequenced('COMMIT_RECORDED', { attempt: 1, commit: COMMIT }, 7),
    sequenced('REVIEW_COMPLETED', {
      approved: true,
      review: 1,
      attempt: 1,
      diffPath: reviewDiffPath,
      diffDigest: '4'.repeat(64),
      reportPath: `.apex/work/loops/2026-09-03-demo-loop/run-12345678-1234-4234-8234-123456789abc-review-1-report.md`,
      reportDigest: '5'.repeat(64),
    }, 8),
    sequenced('TERMINAL_RECORDED', { outcome: 'GOAL_REACHED' }, 9),
  ];
  for (let length = 1; length <= stream.length; length += 1) {
    assert.equal(reduceWorkflowEvents(stream.slice(0, length)).lastSequence, length);
  }
  const state = reduceWorkflowEvents(stream);
  assert.equal(state.attempts[0].diffPath, diffPath);
  assert.equal(state.attempts[0].diffDigest, '2'.repeat(64));
  assert.equal(state.review.diffDigest, '4'.repeat(64));
  assert.throws(
    () => validateWorkflowEvent({ ...stream[2], diffDigest: 'bad' }),
    /digest/iu,
  );
});

test('review completion binds its own immutable review-correlated evidence without changing event vocabulary', () => {
  const attemptDiff = `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-attempt-1-diff.txt`;
  const reviewDiff = `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-review-1-diff.txt`;
  const state = reduceWorkflowEvents([
    start(),
    sequenced('ATTEMPT_RESERVED', {
      attempt: 1, expectedParent: BASELINE, snapshotDigest: '1'.repeat(64),
    }, 2),
    sequenced('CHILD_COMPLETED', {
      attempt: 1,
      changedPaths: ['scripts/fix.mjs'],
      diffPath: attemptDiff,
      diffDigest: '2'.repeat(64),
      snapshotDigest: '3'.repeat(64),
    }, 3),
    sequenced('BLAST_RADIUS_CHECKED', { attempt: 1, passed: true }, 4),
    sequenced('VERIFIER_RECORDED', { attempt: 1, verdict: 'GOAL_REACHED', metric: null }, 5),
    sequenced('COMMIT_INTENT', { attempt: 1, commit: COMMIT }, 6),
    sequenced('COMMIT_RECORDED', { attempt: 1, commit: COMMIT }, 7),
    sequenced('REVIEW_COMPLETED', {
      approved: true,
      review: 1,
      attempt: 1,
      diffPath: reviewDiff,
      diffDigest: '4'.repeat(64),
      reportPath: `.apex/work/loops/2026-09-03-demo-loop/run-${RUN_ID}-review-1-report.md`,
      reportDigest: '5'.repeat(64),
    }, 8),
  ]);
  assert.equal(state.review.diffPath, reviewDiff);
  assert.equal(state.review.diffDigest, '4'.repeat(64));
  assert.equal(WORKFLOW_EVENT_NAMES.length, 13);
});

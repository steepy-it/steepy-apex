export const WORKFLOW_EVENT_SCHEMA_VERSION = 1;

export const WORKFLOW_EVENT_NAMES = Object.freeze([
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

export const CLEAN_TERMINAL_OUTCOMES = Object.freeze([
  'GOAL_REACHED',
  'BUDGET_EXHAUSTED',
  'NO_IMPROVEMENT',
  'REVIEW_REJECTED',
]);

export const WORKFLOW_MODES = Object.freeze(['BOOLEAN', 'METRIC']);
export const VERIFIER_VERDICTS = Object.freeze(['GOAL_REACHED', 'KEEP', 'DISCARD']);

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ABBREVIATED_GIT_OBJECT_ID = /^(?:[0-9a-f]{7,40}|[0-9a-f]{64})$/u;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const COMMON_EVENT_FIELDS = Object.freeze([
  'schemaVersion',
  'sequence',
  'runId',
  'timestamp',
  'event',
]);
const EVENT_FIELDS = Object.freeze({
  RUN_STARTED: Object.freeze([
    'branch',
    'baseline',
    'mode',
    'budget',
    'controllerCommitAuthorized',
    'goalDigest',
    'verifier',
    'verifierArgv',
    'metricDirection',
    'blastRadius',
    'baselineExit',
    'baselinePassed',
    'baselineMetric',
  ]),
  ATTEMPT_RESERVED: Object.freeze(['attempt']),
  CHILD_COMPLETED: Object.freeze(['attempt']),
  BLAST_RADIUS_CHECKED: Object.freeze(['attempt', 'passed']),
  VERIFIER_RECORDED: Object.freeze(['attempt', 'verdict', 'metric']),
  COMMIT_INTENT: Object.freeze(['attempt', 'commit']),
  COMMIT_RECORDED: Object.freeze(['attempt', 'commit']),
  DISCARD_INTENT: Object.freeze(['attempt']),
  DISCARD_RECORDED: Object.freeze(['attempt']),
  REVIEW_COMPLETED: Object.freeze(['approved']),
  TERMINAL_RECORDED: Object.freeze(['outcome']),
  RECONCILIATION_REQUIRED: Object.freeze(['attempt', 'reason']),
  RUN_HALTED: Object.freeze(['attempt', 'reason']),
});
const EVENT_OPTIONAL_FIELDS = Object.freeze({
  ATTEMPT_RESERVED: Object.freeze(['expectedParent', 'snapshotDigest']),
  CHILD_COMPLETED: Object.freeze([
    'changedPaths', 'diffPath', 'diffDigest', 'snapshotDigest',
    'modelTier', 'modelSelection', 'resolvedModel', 'degradationReason',
    'observabilityDegraded',
  ]),
  REVIEW_COMPLETED: Object.freeze([
    'review', 'attempt', 'diffPath', 'diffDigest', 'reportPath', 'reportDigest',
    'modelTier', 'modelSelection', 'resolvedModel', 'degradationReason',
    'observabilityDegraded',
  ]),
  TERMINAL_RECORDED: Object.freeze([
    'diffPath', 'diffDigest', 'head', 'snapshotDigest',
  ]),
  DISCARD_INTENT: Object.freeze(['snapshot']),
  RECONCILIATION_REQUIRED: Object.freeze(['observabilityDegraded']),
  RUN_HALTED: Object.freeze(['observabilityDegraded']),
});
const EVENT_NAME_SET = new Set(WORKFLOW_EVENT_NAMES);
const MODE_SET = new Set(WORKFLOW_MODES);
const VERDICT_SET = new Set(VERIFIER_VERDICTS);
const TERMINAL_OUTCOME_SET = new Set(CLEAN_TERMINAL_OUTCOMES);
const MODEL_TIER_SET = new Set(['cheap', 'standard', 'most-capable']);
const MODEL_SELECTION_SET = new Set(['applied', 'degraded']);

export class WorkflowStateError extends Error {
  constructor(code, message) {
    super(`workflow state [${code}]: ${message}`);
    this.name = 'WorkflowStateError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new WorkflowStateError(code, message);
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('INVALID_POSITIVE_INTEGER', `${label} must be a positive safe integer`);
  }
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_OBJECT', `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('INVALID_OBJECT', `${label} must be a plain object`);
  }
}

function assertNonEmptyLine(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.trim() !== value
    || /[\u0000\r\n]/u.test(value)
  ) {
    fail('INVALID_STRING', `${label} must be a non-empty single-line string`);
  }
}

function assertModelRouting(candidate) {
  const fields = ['modelTier', 'modelSelection', 'resolvedModel', 'degradationReason'];
  const count = fields.filter((field) => Object.hasOwn(candidate, field)).length;
  if (count !== 0 && count !== fields.length) {
    fail('MISSING_FIELD', 'model routing evidence fields must be supplied together');
  }
  if (count === 0) return;
  assertOneOf(candidate.modelTier, MODEL_TIER_SET, 'modelTier');
  assertOneOf(candidate.modelSelection, MODEL_SELECTION_SET, 'modelSelection');
  if (candidate.modelSelection === 'applied') {
    assertNonEmptyLine(candidate.resolvedModel, 'resolvedModel');
    if (candidate.degradationReason !== null) {
      fail('INVALID_MODEL_ROUTING', 'applied model selection requires null degradationReason');
    }
  } else {
    if (candidate.resolvedModel !== null) {
      fail('INVALID_MODEL_ROUTING', 'degraded model selection requires null resolvedModel');
    }
    assertNonEmptyLine(candidate.degradationReason, 'degradationReason');
  }
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('INVALID_ARRAY', `${label} must be a non-empty array`);
  }
  for (const [index, item] of value.entries()) assertNonEmptyLine(item, `${label}[${index}]`);
}

function assertPossiblyEmptyStringArray(value, label) {
  if (!Array.isArray(value)) fail('INVALID_ARRAY', `${label} must be an array`);
  for (const [index, item] of value.entries()) assertNonEmptyLine(item, `${label}[${index}]`);
}

function assertRepoRelativePath(value, label) {
  assertNonEmptyLine(value, label);
  if (value.startsWith('/') || value.includes('\\')
    || value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('INVALID_PATH', `${label} must be a confined repo-relative path`);
  }
}

function assertOneOf(value, values, label) {
  if (!values.has(value)) {
    fail('INVALID_ENUM', `${label} must be one of: ${[...values].join(', ')}`);
  }
}

function assertOptionalFiniteNumber(value, label) {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
    fail('INVALID_NUMBER', `${label} must be null or a finite number`);
  }
}

function assertOptionalObservability(candidate) {
  if (Object.hasOwn(candidate, 'observabilityDegraded')
    && typeof candidate.observabilityDegraded !== 'boolean') {
    fail('INVALID_BOOLEAN', 'observabilityDegraded must be a boolean');
  }
}

function assertGitSnapshot(value, label) {
  assertPlainObject(value, label);
  const expected = ['head', 'indexTree', 'trackedDiffDigest', 'untracked'];
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail('INVALID_GIT_SNAPSHOT', `${label} fields must be closed`);
  }
  assertGitObjectId(value.head, `${label} head`);
  assertGitObjectId(value.indexTree, `${label} indexTree`);
  if (typeof value.trackedDiffDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.trackedDiffDigest)) {
    fail('INVALID_GIT_SNAPSHOT', `${label} trackedDiffDigest must be SHA-256`);
  }
  if (!Array.isArray(value.untracked)) fail('INVALID_GIT_SNAPSHOT', `${label} untracked must be an array`);
  const paths = [];
  for (const [index, entry] of value.untracked.entries()) {
    assertPlainObject(entry, `${label} untracked[${index}]`);
    if (Object.keys(entry).sort().join(',') !== 'digest,path,type') {
      fail('INVALID_GIT_SNAPSHOT', `${label} untracked entry fields must be closed`);
    }
    assertRepoRelativePath(entry.path, `${label} untracked path`);
    if (!['file', 'symlink'].includes(entry.type)
      || typeof entry.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.digest)) {
      fail('INVALID_GIT_SNAPSHOT', `${label} untracked entry is invalid`);
    }
    paths.push(entry.path);
  }
  if (new Set(paths).size !== paths.length) {
    fail('INVALID_GIT_SNAPSHOT', `${label} untracked paths must be unique`);
  }
}

function assertExactFields(event, specificFields, optionalFields = []) {
  const required = new Set([...COMMON_EVENT_FIELDS, ...specificFields]);
  const allowed = new Set([...required, ...optionalFields]);
  for (const key of Reflect.ownKeys(event)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      fail('UNKNOWN_FIELD', `unknown field '${String(key)}'`);
    }
  }
  for (const field of required) {
    if (!Object.hasOwn(event, field)) fail('MISSING_FIELD', `missing field '${field}'`);
  }
}

function assertGitObjectId(value, label = 'baseline') {
  if (typeof value !== 'string' || !GIT_OBJECT_ID.test(value)) {
    fail('INVALID_GIT_IDENTITY', `${label} must be a lowercase 40- or 64-character Git object identity`);
  }
}

function assertBaselineIdentity(value, label, allowAbbreviated) {
  if (!allowAbbreviated) {
    assertGitObjectId(value, label);
    return;
  }
  if (typeof value !== 'string' || !ABBREVIATED_GIT_OBJECT_ID.test(value)) {
    fail(
      'INVALID_GIT_IDENTITY',
      `${label} must be a lowercase 7- to 40-character abbreviated or 64-character Git object identity`,
    );
  }
}

function assertAttemptList(attempts) {
  if (!Array.isArray(attempts)) {
    fail('INVALID_ATTEMPTS', 'reserved attempts must be an array');
  }
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    assertPositiveInteger(attempt, `reserved attempt at index ${index}`);
    if (attempt !== index + 1) {
      fail('INVALID_ATTEMPTS', 'reserved attempts must be unique and monotonically contiguous');
    }
  }
}

export function reserveAttempt(reservedAttempts, attempt, budget) {
  assertAttemptList(reservedAttempts);
  assertPositiveInteger(attempt, 'attempt');
  assertPositiveInteger(budget, 'budget');
  if (reservedAttempts.includes(attempt)) {
    fail('DUPLICATE_ATTEMPT', `attempt identity ${attempt} was already reserved`);
  }
  const expected = reservedAttempts.length + 1;
  if (attempt !== expected) {
    fail('ATTEMPT_ORDER', `next attempt must be ${expected}, got ${attempt}`);
  }
  if (attempt > budget) {
    fail('BUDGET_EXHAUSTED', `attempt ${attempt} exceeds budget ${budget}`);
  }
  return Object.freeze([...reservedAttempts, attempt]);
}

export function selectBaseline(selectedBaseline, candidateBaseline, options = {}) {
  assertPlainObject(options, 'baseline selection options');
  const allowed = new Set(['allowAbbreviated', 'preserveExisting']);
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      fail('UNKNOWN_FIELD', `unknown baseline selection option '${String(key)}'`);
    }
  }
  const allowAbbreviated = options.allowAbbreviated === true;
  const preserveExisting = options.preserveExisting === true;
  assertBaselineIdentity(candidateBaseline, 'baseline', allowAbbreviated);
  if (selectedBaseline === null || selectedBaseline === undefined) return candidateBaseline;
  assertBaselineIdentity(selectedBaseline, 'selected baseline', allowAbbreviated);
  if (selectedBaseline !== candidateBaseline) {
    if (preserveExisting) return selectedBaseline;
    fail('BASELINE_ALREADY_SELECTED', `baseline is already selected as '${selectedBaseline}'`);
  }
  return selectedBaseline;
}

// Validates the shared in-memory envelope used by source adapters before their
// domain-specific reducer runs. Unlike validateWorkflowEvent(), this boundary
// intentionally leaves event-specific fields to the adapter/reducer and may
// carry null run correlation for historical observational records.
export function normalizeWorkflowEnvelope(candidate, { allowUncorrelated = false } = {}) {
  assertPlainObject(candidate, 'workflow envelope');
  if (!Object.hasOwn(candidate, 'schemaVersion')) {
    fail('MISSING_FIELD', "missing field 'schemaVersion'");
  }
  if (candidate.schemaVersion !== WORKFLOW_EVENT_SCHEMA_VERSION) {
    fail('UNKNOWN_VERSION', `unsupported schemaVersion ${String(candidate.schemaVersion)}`);
  }
  if (!Object.hasOwn(candidate, 'sequence')) fail('MISSING_FIELD', "missing field 'sequence'");
  if (!Object.hasOwn(candidate, 'runId')) fail('MISSING_FIELD', "missing field 'runId'");
  if (!Object.hasOwn(candidate, 'timestamp')) fail('MISSING_FIELD', "missing field 'timestamp'");
  if (!Object.hasOwn(candidate, 'event')) fail('MISSING_FIELD', "missing field 'event'");
  assertPositiveInteger(candidate.sequence, 'sequence');
  if (candidate.runId === null && allowUncorrelated) {
    // Historical adapters can preserve an uncorrelated source record without
    // inventing an identity. Correlated transitions still reject null below.
  } else {
    assertNonEmptyLine(candidate.runId, 'runId');
  }
  if (
    typeof candidate.timestamp !== 'string'
    || !CANONICAL_UTC_TIMESTAMP.test(candidate.timestamp)
    || Number.isNaN(Date.parse(candidate.timestamp))
    || new Date(candidate.timestamp).toISOString() !== candidate.timestamp
  ) {
    fail('INVALID_TIMESTAMP', 'timestamp must be a canonical UTC timestamp');
  }
  assertNonEmptyLine(candidate.event, 'event');
  return Object.freeze({ ...candidate });
}

function assertCorrelationEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    fail('INVALID_EVENT', 'correlation requires an event object');
  }
}

export function validateWorkflowEvent(candidate) {
  assertPlainObject(candidate, 'event');
  if (!Object.hasOwn(candidate, 'schemaVersion')) {
    fail('MISSING_FIELD', "missing field 'schemaVersion'");
  }
  if (candidate.schemaVersion !== WORKFLOW_EVENT_SCHEMA_VERSION) {
    fail('UNKNOWN_VERSION', `unsupported schemaVersion ${String(candidate.schemaVersion)}`);
  }
  if (!Object.hasOwn(candidate, 'event')) fail('MISSING_FIELD', "missing field 'event'");
  if (!EVENT_NAME_SET.has(candidate.event)) {
    fail('UNKNOWN_EVENT', `unknown event name '${String(candidate.event)}'`);
  }
  assertExactFields(
    candidate,
    EVENT_FIELDS[candidate.event],
    EVENT_OPTIONAL_FIELDS[candidate.event] ?? [],
  );
  assertPositiveInteger(candidate.sequence, 'sequence');
  assertNonEmptyLine(candidate.runId, 'runId');
  if (
    typeof candidate.timestamp !== 'string'
    || !CANONICAL_UTC_TIMESTAMP.test(candidate.timestamp)
    || Number.isNaN(Date.parse(candidate.timestamp))
    || new Date(candidate.timestamp).toISOString() !== candidate.timestamp
  ) {
    fail('INVALID_TIMESTAMP', 'timestamp must be a canonical UTC timestamp');
  }

  switch (candidate.event) {
    case 'RUN_STARTED':
      assertNonEmptyLine(candidate.branch, 'branch');
      assertGitObjectId(candidate.baseline);
      assertOneOf(candidate.mode, MODE_SET, 'mode');
      assertPositiveInteger(candidate.budget, 'budget');
      if (typeof candidate.goalDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(candidate.goalDigest)) {
        fail('INVALID_DIGEST', 'goalDigest must be a lowercase SHA-256 digest');
      }
      assertNonEmptyLine(candidate.verifier, 'verifier');
      assertStringArray(candidate.verifierArgv, 'verifierArgv');
      assertStringArray(candidate.blastRadius, 'blastRadius');
      if (candidate.mode === 'BOOLEAN' && candidate.metricDirection !== null) {
        fail('INVALID_METRIC_DIRECTION', 'boolean mode requires null metricDirection');
      }
      if (candidate.mode === 'METRIC' && !['min', 'max'].includes(candidate.metricDirection)) {
        fail('INVALID_METRIC_DIRECTION', 'metric mode requires min or max metricDirection');
      }
      if (candidate.controllerCommitAuthorized !== true) {
        fail('MISSING_AUTHORIZATION', 'controller commit authorization must be true');
      }
      if (!Number.isSafeInteger(candidate.baselineExit) || candidate.baselineExit < 0) {
        fail('INVALID_BASELINE_EXIT', 'baselineExit must be a non-negative safe integer');
      }
      if (typeof candidate.baselinePassed !== 'boolean') {
        fail('INVALID_BOOLEAN', 'baselinePassed must be a boolean');
      }
      if ((candidate.baselineExit === 0) !== candidate.baselinePassed) {
        fail('INVALID_BASELINE_EXIT', 'baselinePassed must match whether baselineExit is zero');
      }
      assertOptionalFiniteNumber(candidate.baselineMetric, 'baselineMetric');
      if (candidate.mode === 'BOOLEAN' && candidate.baselineMetric !== null) {
        fail('INVALID_BASELINE', 'boolean RUN_STARTED requires null baselineMetric');
      }
      if (candidate.mode === 'METRIC'
        && (candidate.baselinePassed !== true || candidate.baselineMetric === null)) {
        fail('INVALID_BASELINE', 'metric RUN_STARTED requires successful finite baselineMetric');
      }
      break;
    case 'ATTEMPT_RESERVED':
      assertPositiveInteger(candidate.attempt, 'attempt');
      if (Object.hasOwn(candidate, 'expectedParent')) {
        assertGitObjectId(candidate.expectedParent, 'expectedParent');
      }
      if (Object.hasOwn(candidate, 'snapshotDigest')) {
        if (typeof candidate.snapshotDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(candidate.snapshotDigest)) {
          fail('INVALID_DIGEST', 'snapshotDigest must be a lowercase SHA-256 digest');
        }
      }
      if (Object.hasOwn(candidate, 'expectedParent') !== Object.hasOwn(candidate, 'snapshotDigest')) {
        fail('MISSING_FIELD', 'attempt ownership fields must be supplied together');
      }
      break;
    case 'CHILD_COMPLETED':
    case 'DISCARD_INTENT':
    case 'DISCARD_RECORDED':
      assertPositiveInteger(candidate.attempt, 'attempt');
      if (candidate.event === 'DISCARD_INTENT' && Object.hasOwn(candidate, 'snapshot')) {
        assertGitSnapshot(candidate.snapshot, 'discard snapshot');
      }
      if (candidate.event === 'CHILD_COMPLETED') {
        const evidenceFields = ['changedPaths', 'diffPath', 'diffDigest', 'snapshotDigest'];
        const evidenceCount = evidenceFields.filter((field) => Object.hasOwn(candidate, field)).length;
        if (evidenceCount !== 0 && evidenceCount !== evidenceFields.length) {
          fail('MISSING_FIELD', 'child diff evidence fields must be supplied together');
        }
      }
      if (candidate.event === 'CHILD_COMPLETED' && Object.hasOwn(candidate, 'diffPath')) {
        assertPossiblyEmptyStringArray(candidate.changedPaths, 'changedPaths');
        for (const path of candidate.changedPaths) assertRepoRelativePath(path, 'changed path');
        assertRepoRelativePath(candidate.diffPath, 'diffPath');
        if (!candidate.diffPath.endsWith(`-attempt-${candidate.attempt}-diff.txt`)) {
          fail('ATTEMPT_CORRELATION', 'child diffPath does not match its attempt identity');
        }
        for (const name of ['diffDigest', 'snapshotDigest']) {
          if (typeof candidate[name] !== 'string' || !/^[0-9a-f]{64}$/u.test(candidate[name])) {
            fail('INVALID_DIGEST', `${name} must be a lowercase SHA-256 digest`);
          }
        }
      }
      if (candidate.event === 'CHILD_COMPLETED') assertModelRouting(candidate);
      assertOptionalObservability(candidate);
      break;
    case 'BLAST_RADIUS_CHECKED':
      assertPositiveInteger(candidate.attempt, 'attempt');
      if (typeof candidate.passed !== 'boolean') {
        fail('INVALID_BOOLEAN', 'passed must be a boolean');
      }
      break;
    case 'VERIFIER_RECORDED':
      assertPositiveInteger(candidate.attempt, 'attempt');
      assertOneOf(candidate.verdict, VERDICT_SET, 'verdict');
      assertOptionalFiniteNumber(candidate.metric, 'metric');
      break;
    case 'COMMIT_INTENT':
    case 'COMMIT_RECORDED':
      assertPositiveInteger(candidate.attempt, 'attempt');
      assertGitObjectId(candidate.commit, 'commit');
      break;
    case 'REVIEW_COMPLETED':
      if (typeof candidate.approved !== 'boolean') {
        fail('INVALID_BOOLEAN', 'approved must be a boolean');
      }
      {
        const evidenceFields = [
          'review', 'attempt', 'diffPath', 'diffDigest', 'reportPath', 'reportDigest',
        ];
        const evidenceCount = evidenceFields.filter((field) => Object.hasOwn(candidate, field)).length;
        if (evidenceCount !== 0 && evidenceCount !== evidenceFields.length) {
          fail('MISSING_FIELD', 'review evidence fields must be supplied together');
        }
      }
      if (Object.hasOwn(candidate, 'review')) {
        assertPositiveInteger(candidate.review, 'review');
        if (candidate.attempt !== null) assertPositiveInteger(candidate.attempt, 'review attempt');
        assertRepoRelativePath(candidate.diffPath, 'review diffPath');
        assertRepoRelativePath(candidate.reportPath, 'review reportPath');
        if (!candidate.reportPath.endsWith(`-review-${candidate.review}-report.md`)) {
          fail('REVIEW_CORRELATION', 'review reportPath does not match its review identity');
        }
        const expectedDiffSuffix = `-review-${candidate.review}-diff.txt`;
        if (!candidate.diffPath.endsWith(expectedDiffSuffix)) {
          fail('DIFF_CORRELATION', 'review diffPath does not match its attempt/review identity');
        }
        for (const name of ['diffDigest', 'reportDigest']) {
          if (typeof candidate[name] !== 'string' || !/^[0-9a-f]{64}$/u.test(candidate[name])) {
            fail('INVALID_DIGEST', `review ${name} must be a lowercase SHA-256 digest`);
          }
        }
      }
      assertModelRouting(candidate);
      assertOptionalObservability(candidate);
      break;
    case 'TERMINAL_RECORDED':
      assertOneOf(candidate.outcome, TERMINAL_OUTCOME_SET, 'outcome');
      {
        const evidenceFields = ['diffPath', 'diffDigest', 'head', 'snapshotDigest'];
        const evidenceCount = evidenceFields.filter((field) => Object.hasOwn(candidate, field)).length;
        if (evidenceCount !== 0 && evidenceCount !== evidenceFields.length) {
          fail('MISSING_FIELD', 'terminal projection evidence fields must be supplied together');
        }
        if (evidenceCount !== 0) {
          assertRepoRelativePath(candidate.diffPath, 'terminal diffPath');
          if (!candidate.diffPath.endsWith('/branch-diff.txt')) {
            fail('DIFF_CORRELATION', 'terminal diffPath must be the canonical branch-diff projection');
          }
          assertGitObjectId(candidate.head, 'terminal head');
          for (const name of ['diffDigest', 'snapshotDigest']) {
            if (typeof candidate[name] !== 'string' || !/^[0-9a-f]{64}$/u.test(candidate[name])) {
              fail('INVALID_DIGEST', `terminal ${name} must be a lowercase SHA-256 digest`);
            }
          }
        }
      }
      break;
    case 'RECONCILIATION_REQUIRED':
      if (candidate.attempt !== null) assertPositiveInteger(candidate.attempt, 'attempt');
      assertNonEmptyLine(candidate.reason, 'reason');
      assertOptionalObservability(candidate);
      break;
    case 'RUN_HALTED':
      if (candidate.attempt !== null) assertPositiveInteger(candidate.attempt, 'attempt');
      assertNonEmptyLine(candidate.reason, 'reason');
      assertOptionalObservability(candidate);
      break;
    default:
      fail('UNKNOWN_EVENT', `unknown event name '${String(candidate.event)}'`);
  }

  const normalized = { ...candidate };
  if (candidate.event === 'RUN_STARTED') {
    normalized.verifierArgv = Object.freeze([...candidate.verifierArgv]);
    normalized.blastRadius = Object.freeze([...candidate.blastRadius]);
  }
  if (candidate.event === 'DISCARD_INTENT' && Object.hasOwn(candidate, 'snapshot')) {
    normalized.snapshot = Object.freeze({
      ...candidate.snapshot,
      untracked: Object.freeze(candidate.snapshot.untracked.map((entry) => Object.freeze({ ...entry }))),
    });
  }
  return Object.freeze(normalized);
}

export function correlateRun(expectedRunId, event) {
  assertCorrelationEvent(event);
  if (typeof expectedRunId !== 'string' || expectedRunId.length === 0) {
    fail('INVALID_RUN_ID', 'expected run identity must be a non-empty string');
  }
  if (event.runId !== expectedRunId) {
    fail('RUN_CORRELATION', `run correlation expected '${expectedRunId}', got '${String(event.runId)}'`);
  }
  return event;
}

export function correlateAttempt(expectedAttempt, event) {
  assertPositiveInteger(expectedAttempt, 'expected attempt');
  assertCorrelationEvent(event);
  assertPositiveInteger(event.attempt, 'event attempt');
  if (event.attempt !== expectedAttempt) {
    const qualifier = event.attempt > expectedAttempt ? 'reordered ' : '';
    fail(
      'ATTEMPT_CORRELATION',
      `${qualifier}attempt correlation expected ${expectedAttempt}, got ${event.attempt}`,
    );
  }
  return event;
}

const PHASE_WORKFLOW_KINDS = new Set([
  'OBSERVED',
  'BASELINE',
  'ATTEMPT_OBSERVED',
  'ATTEMPT_RESERVED',
  'ATTEMPT_STARTED',
]);

function phaseWorkflowScope(scopes, value) {
  if (typeof value !== 'string' || !scopes.includes(value)) {
    fail('INVALID_SCOPE', `workflow scope must be one of: ${scopes.join(', ')}`);
  }
  return value;
}

function phaseWorkflowIdentity(envelope, scopes) {
  const scope = phaseWorkflowScope(scopes, envelope.scope);
  assertPositiveInteger(envelope.attempt, 'attempt');
  if (envelope.runId === null) {
    fail('RUN_CORRELATION', `${envelope.kind} requires run correlation`);
  }
  return Object.freeze({ runId: envelope.runId, scope, attempt: envelope.attempt });
}

function identitiesMatch(expected, candidate) {
  if (expected.scope !== candidate.scope) return false;
  try {
    correlateRun(expected.runId, candidate);
    correlateAttempt(expected.attempt, candidate);
    return true;
  } catch (error) {
    if (error instanceof WorkflowStateError) return false;
    throw error;
  }
}

function freezePhaseWorkflowState(state) {
  const attemptsByScope = {};
  for (const [scope, attempts] of Object.entries(state.attemptsByScope)) {
    attemptsByScope[scope] = Object.freeze([...attempts]);
  }
  return Object.freeze({
    ...state,
    attemptsByScope: Object.freeze(attemptsByScope),
    spawns: Object.freeze(state.spawns.map((identity) => Object.freeze({ ...identity }))),
    completions: Object.freeze(state.completions.map((completion) => Object.freeze({ ...completion }))),
    events: Object.freeze([...state.events]),
  });
}

// Replays any finite phase controller whose source adapter emits the shared
// envelope plus one of the generic phase-workflow kinds above. The kernel owns
// ordering, first-baseline selection, scoped attempt observation, correlation,
// and completion reduction; it remains unaware of Markdown or any other source
// serialization.
export function replayPhaseWorkflow(envelopes, { scopes, completionEvents }) {
  if (!Array.isArray(envelopes)) fail('INVALID_EVENTS', 'workflow envelopes must be an array');
  if (!Array.isArray(scopes) || scopes.length === 0) {
    fail('INVALID_SCOPES', 'workflow scopes must be a non-empty array');
  }
  const normalizedScopes = [];
  for (const scope of scopes) {
    assertNonEmptyLine(scope, 'workflow scope');
    if (normalizedScopes.includes(scope)) fail('DUPLICATE_SCOPE', `duplicate workflow scope '${scope}'`);
    normalizedScopes.push(scope);
  }
  assertPlainObject(completionEvents, 'completion events');
  for (const scope of normalizedScopes) {
    if (!Object.hasOwn(completionEvents, scope)) {
      fail('MISSING_FIELD', `missing completion event for scope '${scope}'`);
    }
    assertNonEmptyLine(completionEvents[scope], `completion event for ${scope}`);
  }
  for (const key of Reflect.ownKeys(completionEvents)) {
    if (typeof key !== 'string' || !normalizedScopes.includes(key)) {
      fail('UNKNOWN_FIELD', `unknown completion scope '${String(key)}'`);
    }
  }

  const state = {
    schemaVersion: WORKFLOW_EVENT_SCHEMA_VERSION,
    baseline: null,
    eventCount: 0,
    attemptsByScope: Object.fromEntries(normalizedScopes.map((scope) => [scope, []])),
    spawns: [],
    completions: [],
    events: [],
  };

  for (let index = 0; index < envelopes.length; index += 1) {
    const envelope = normalizeWorkflowEnvelope(envelopes[index], { allowUncorrelated: true });
    const expectedSequence = index + 1;
    if (envelope.sequence !== expectedSequence) {
      fail(
        envelope.sequence < expectedSequence ? 'REORDERED_SEQUENCE' : 'TRUNCATED_STREAM',
        `workflow envelope sequence expected ${expectedSequence}, got ${envelope.sequence}`,
      );
    }
    if (!PHASE_WORKFLOW_KINDS.has(envelope.kind)) {
      fail('UNKNOWN_EVENT_KIND', `unknown phase workflow kind '${String(envelope.kind)}'`);
    }

    state.events.push(envelope);
    state.eventCount += 1;
    if (envelope.kind === 'BASELINE') {
      state.baseline = selectBaseline(state.baseline, envelope.baseline, {
        allowAbbreviated: true,
        preserveExisting: true,
      });
    }

    if (['ATTEMPT_OBSERVED', 'ATTEMPT_RESERVED', 'ATTEMPT_STARTED'].includes(envelope.kind)) {
      const identity = phaseWorkflowIdentity(envelope, normalizedScopes);
      const attempts = state.attemptsByScope[identity.scope];
      if (!attempts.includes(identity.attempt)) {
        attempts.push(identity.attempt);
        attempts.sort((left, right) => left - right);
      }
      if (envelope.kind === 'ATTEMPT_STARTED') state.spawns.push(identity);
    }

    if (
      typeof envelope.scope === 'string'
      && normalizedScopes.includes(envelope.scope)
      && envelope.event === completionEvents[envelope.scope]
    ) {
      if (envelope.runId !== null && envelope.attempt !== null) {
        const completionIdentity = {
          runId: envelope.runId,
          scope: envelope.scope,
          attempt: envelope.attempt,
        };
        if (state.spawns.some((spawn) => identitiesMatch(spawn, completionIdentity))) {
          state.completions.push({
            ...completionIdentity,
            event: envelope.event,
            timestamp: envelope.timestamp,
          });
        }
      }
    }
  }

  return freezePhaseWorkflowState(state);
}

export function nextWorkflowAttempt(state, scope) {
  assertPlainObject(state, 'phase workflow state');
  if (
    state.attemptsByScope === null
    || typeof state.attemptsByScope !== 'object'
    || !Array.isArray(state.attemptsByScope[scope])
  ) {
    fail('INVALID_SCOPE', `unknown workflow scope '${String(scope)}'`);
  }
  const attempts = state.attemptsByScope[scope];
  for (const attempt of attempts) assertPositiveInteger(attempt, 'observed attempt');
  const highest = attempts.length === 0 ? 0 : Math.max(...attempts);
  if (highest >= Number.MAX_SAFE_INTEGER) fail('ATTEMPT_ORDER', 'next attempt exceeds safe integer range');
  return highest + 1;
}

export function workflowScopeCompleted(state, scope, expectedIdentity = null) {
  assertPlainObject(state, 'phase workflow state');
  if (!Array.isArray(state.completions) || !Object.hasOwn(state.attemptsByScope ?? {}, scope)) {
    fail('INVALID_SCOPE', `unknown workflow scope '${String(scope)}'`);
  }
  if (expectedIdentity === null) {
    return state.completions.some((completion) => completion.scope === scope);
  }
  assertPlainObject(expectedIdentity, 'expected workflow identity');
  const normalizedExpected = {
    runId: expectedIdentity.runId,
    scope: expectedIdentity.scope,
    attempt: expectedIdentity.attempt,
  };
  assertNonEmptyLine(normalizedExpected.runId, 'expected run identity');
  if (normalizedExpected.scope !== scope) return false;
  assertPositiveInteger(normalizedExpected.attempt, 'expected attempt');
  return state.completions.some((completion) => (
    identitiesMatch(normalizedExpected, completion)
  ));
}

// The fresh-run dirty-tree gate is commit-state policy, not source-format
// policy. A durable run may legitimately resume its child's dirty work; a new
// run requires an explicit clean observation before it can start.
export function classifyWorkflowStart(candidate) {
  assertPlainObject(candidate, 'workflow start observation');
  const allowed = new Set(['hasDurableState', 'worktreeStatus']);
  for (const key of Reflect.ownKeys(candidate)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      fail('UNKNOWN_FIELD', `unknown workflow start field '${String(key)}'`);
    }
  }
  if (typeof candidate.hasDurableState !== 'boolean') {
    fail('INVALID_BOOLEAN', 'hasDurableState must be a boolean');
  }
  if (candidate.hasDurableState) {
    return Object.freeze({ classification: 'RESUME_ALLOWED' });
  }
  if (!Object.hasOwn(candidate, 'worktreeStatus')) {
    return Object.freeze({ classification: 'WORKTREE_OBSERVATION_REQUIRED' });
  }
  if (typeof candidate.worktreeStatus !== 'string') {
    fail('INVALID_STRING', 'worktreeStatus must be a string');
  }
  return Object.freeze({
    classification: candidate.worktreeStatus === '' ? 'FRESH_ALLOWED' : 'DIRTY_FRESH_REFUSED',
  });
}

function freezeAttempt(attempt) {
  return Object.freeze({ ...attempt });
}

function freezeState(state) {
  const attempts = Object.freeze(state.attempts.map((attempt) => (
    Object.isFrozen(attempt) ? attempt : freezeAttempt(attempt)
  )));
  const reviewHistory = Object.freeze(state.reviewHistory.map((review) => (
    Object.isFrozen(review) ? review : Object.freeze({ ...review })
  )));
  return Object.freeze({
    ...state,
    verifierArgv: state.verifierArgv === null ? null : Object.freeze([...state.verifierArgv]),
    blastRadius: state.blastRadius === null ? null : Object.freeze([...state.blastRadius]),
    baselineVerifier: state.baselineVerifier === null
      ? null
      : Object.freeze({ ...state.baselineVerifier }),
    reservedAttempts: Object.freeze([...state.reservedAttempts]),
    attempts,
    commits: Object.freeze([...state.commits]),
    pendingCommit: state.pendingCommit === null
      ? null
      : Object.freeze({ ...state.pendingCommit }),
    reconciliation: state.reconciliation === null
      ? null
      : Object.freeze({ ...state.reconciliation }),
    review: state.review === null ? null : Object.freeze({ ...state.review }),
    reviewHistory,
  });
}

export function createWorkflowState() {
  return freezeState({
    schemaVersion: WORKFLOW_EVENT_SCHEMA_VERSION,
    phase: 'EMPTY',
    runId: null,
    branch: null,
    baseline: null,
    mode: null,
    budget: null,
    controllerCommitAuthorized: false,
    goalDigest: null,
    verifier: null,
    verifierArgv: null,
    metricDirection: null,
    blastRadius: null,
    baselineVerifier: null,
    observabilityDegraded: false,
    startedAt: null,
    lastSequence: 0,
    lastTimestamp: null,
    eventCount: 0,
    reservedAttempts: [],
    attempts: [],
    currentAttempt: null,
    commits: [],
    pendingCommit: null,
    reconciliation: null,
    review: null,
    reviewHistory: [],
    executionTerminal: false,
    goalSucceeded: false,
    terminalOutcome: null,
    terminalEvidence: null,
    haltReason: null,
  });
}

function transitionError(event, state, detail) {
  fail('IMPOSSIBLE_TRANSITION', detail ?? `${event.event} cannot follow ${state.phase}`);
}

function assertPhase(state, event, expected) {
  if (state.phase !== expected) transitionError(event, state);
}

function latestAttempt(state) {
  return state.attempts.at(-1) ?? null;
}

function metricImproves(direction, candidate, best) {
  return direction === 'min' ? candidate < best : candidate > best;
}

function replaceLatestAttempt(state, patch) {
  const latest = latestAttempt(state);
  if (latest === null) fail('IMPOSSIBLE_TRANSITION', 'no attempt has been reserved');
  return [
    ...state.attempts.slice(0, -1),
    freezeAttempt({ ...latest, ...patch }),
  ];
}

function advancedState(state, event, patch = {}) {
  if (state.observabilityDegraded === true
    && Object.hasOwn(event, 'observabilityDegraded')
    && event.observabilityDegraded !== true) {
    fail('OBSERVABILITY_REGRESSION', 'observability degradation is monotonic');
  }
  return freezeState({
    ...state,
    phase: event.event,
    lastSequence: event.sequence,
    lastTimestamp: event.timestamp,
    eventCount: state.eventCount + 1,
    observabilityDegraded: state.observabilityDegraded === true
      || event.observabilityDegraded === true,
    ...patch,
  });
}

function validateSequenceAndCorrelation(state, event) {
  const expectedSequence = state.lastSequence + 1;
  if (event.sequence < expectedSequence) {
    if (event.sequence === state.lastSequence) {
      fail('DUPLICATE_IDENTITY', `duplicate sequence identity ${event.sequence}`);
    }
    fail(
      'REORDERED_SEQUENCE',
      `reordered sequence identity ${event.sequence}; expected ${expectedSequence}`,
    );
  }
  if (event.sequence > expectedSequence) {
    fail(
      'TRUNCATED_STREAM',
      `truncated stream before event ${event.sequence}; expected sequence ${expectedSequence}`,
    );
  }
  if (state.runId === null) {
    if (event.event !== 'RUN_STARTED') {
      fail('IMPOSSIBLE_TRANSITION', 'first event must be RUN_STARTED');
    }
  } else {
    correlateRun(state.runId, event);
  }
  if (state.lastTimestamp !== null && event.timestamp < state.lastTimestamp) {
    fail(
      'REORDERED_TIMESTAMP',
      `reordered timestamp '${event.timestamp}' precedes '${state.lastTimestamp}'`,
    );
  }
  const terminalReconciliation = state.phase === 'TERMINAL_RECORDED'
    && event.event === 'RECONCILIATION_REQUIRED';
  const terminalHalt = state.phase === 'RECONCILIATION_REQUIRED'
    && state.executionTerminal === true
    && event.event === 'RUN_HALTED';
  if (state.executionTerminal && !terminalReconciliation && !terminalHalt) {
    fail('IMPOSSIBLE_TRANSITION', `event after execution terminality: ${event.event}`);
  }
}

function assertCurrentAttempt(state, event) {
  if (state.currentAttempt === null) transitionError(event, state, `${event.event} has no active attempt`);
  correlateAttempt(state.currentAttempt, event);
}

function canReview(state) {
  const attempt = latestAttempt(state);
  if (attempt === null) {
    return state.mode === 'BOOLEAN'
      && state.phase === 'RUN_STARTED'
      && state.baselineVerifier?.passed === true;
  }
  if (!['COMMIT_RECORDED', 'DISCARD_RECORDED'].includes(state.phase)) return false;
  const priorReview = state.reviewHistory.at(-1);
  const completedReviewFix = priorReview?.approved === false
    && attempt.attempt > (priorReview.afterAttempt ?? 0);
  return attempt.verdict === 'GOAL_REACHED'
    || (state.mode === 'METRIC' && attempt.verdict === 'KEEP')
    || completedReviewFix
    || state.reservedAttempts.length === state.budget;
}

export function retainedGoalCandidate(state) {
  assertPlainObject(state, 'workflow state');
  if (state.mode === 'METRIC') {
    const baseline = state.baselineVerifier?.metric ?? null;
    const committedMetrics = state.attempts
      .filter((attempt) => attempt.disposition === 'COMMIT' && Number.isFinite(attempt.metric))
      .map((attempt) => attempt.metric);
    const best = committedMetrics.reduce(
      (selected, candidate) => (
        metricImproves(state.metricDirection, candidate, selected) ? candidate : selected
      ),
      baseline,
    );
    const improved = baseline !== null && best !== null
      && metricImproves(state.metricDirection, best, baseline);
    return Object.freeze({
      acceptable: improved,
      booleanGreen: null,
      metricBaseline: baseline,
      metricBest: best,
      metricStrictImprovement: improved,
    });
  }
  const retained = state.attempts.filter((attempt) => attempt.disposition === 'COMMIT').at(-1);
  const green = retained === undefined
    ? state.baselineVerifier?.passed === true
    : retained.verdict === 'GOAL_REACHED';
  return Object.freeze({
    acceptable: green,
    booleanGreen: green,
    metricBaseline: null,
    metricBest: null,
    metricStrictImprovement: null,
  });
}

export function goalAcceptableCandidate(state) {
  return retainedGoalCandidate(state).acceptable;
}

export function selectTerminalOutcome(state) {
  assertPlainObject(state, 'workflow state');
  if (state.review === null) return null;
  const exhausted = state.reservedAttempts.length === state.budget;
  const acceptable = retainedGoalCandidate(state).acceptable;
  if (!state.review.approved) {
    if (!exhausted) return null;
    if (acceptable) return 'REVIEW_REJECTED';
    return state.mode === 'METRIC' ? 'NO_IMPROVEMENT' : 'BUDGET_EXHAUSTED';
  }
  if (acceptable) return 'GOAL_REACHED';
  if (!exhausted) return null;
  return state.mode === 'METRIC' ? 'NO_IMPROVEMENT' : 'BUDGET_EXHAUSTED';
}

export function reduceWorkflowEvent(currentState, candidate) {
  assertPlainObject(currentState, 'workflow state');
  const event = validateWorkflowEvent(candidate);
  validateSequenceAndCorrelation(currentState, event);

  switch (event.event) {
    case 'RUN_STARTED': {
      assertPhase(currentState, event, 'EMPTY');
      const baseline = selectBaseline(currentState.baseline, event.baseline);
      return advancedState(currentState, event, {
        runId: event.runId,
        branch: event.branch,
        baseline,
        mode: event.mode,
        budget: event.budget,
        controllerCommitAuthorized: event.controllerCommitAuthorized,
        goalDigest: event.goalDigest,
        verifier: event.verifier,
        verifierArgv: event.verifierArgv,
        metricDirection: event.metricDirection,
        blastRadius: event.blastRadius,
        baselineVerifier: {
          exit: event.baselineExit,
          passed: event.baselinePassed,
          metric: event.baselineMetric,
        },
        startedAt: event.timestamp,
      });
    }
    case 'ATTEMPT_RESERVED': {
      if (currentState.reservedAttempts.includes(event.attempt)) {
        fail('DUPLICATE_ATTEMPT', `attempt identity ${event.attempt} was already reserved`);
      }
      const allowed = [
        'RUN_STARTED', 'ATTEMPT_RESERVED', 'COMMIT_RECORDED', 'DISCARD_RECORDED',
      ];
      const resumingNonterminalReview = currentState.phase === 'REVIEW_COMPLETED'
        && selectTerminalOutcome(currentState) === null;
      if (!allowed.includes(currentState.phase) && !resumingNonterminalReview) {
        transitionError(event, currentState);
      }
      const prior = latestAttempt(currentState);
      if (
        currentState.phase === 'COMMIT_RECORDED'
        && prior?.verdict === 'GOAL_REACHED'
      ) {
        transitionError(event, currentState, 'goal-reaching attempt requires review before another attempt');
      }
      const reservedAttempts = reserveAttempt(
        currentState.reservedAttempts,
        event.attempt,
        currentState.budget,
      );
      const attempt = freezeAttempt({
        attempt: event.attempt,
        reservedAt: event.timestamp,
        expectedParent: event.expectedParent ?? null,
        reservationSnapshotDigest: event.snapshotDigest ?? null,
        childCompleted: false,
        completed: false,
        spent: false,
        blastRadiusPassed: null,
        verdict: null,
        disposition: null,
        discardSnapshot: null,
        expectedCommit: null,
        commit: null,
        metric: null,
      });
      const priorAttempts = currentState.phase === 'ATTEMPT_RESERVED'
        ? replaceLatestAttempt(currentState, { spent: true })
        : currentState.attempts;
      return advancedState(currentState, event, {
        reservedAttempts,
        attempts: [...priorAttempts, attempt],
        currentAttempt: event.attempt,
        pendingCommit: null,
        reconciliation: null,
        review: null,
      });
    }
    case 'CHILD_COMPLETED': {
      assertPhase(currentState, event, 'ATTEMPT_RESERVED');
      assertCurrentAttempt(currentState, event);
      return advancedState(currentState, event, {
        attempts: replaceLatestAttempt(currentState, {
          childCompleted: true,
          completed: true,
          spent: true,
          changedPaths: event.changedPaths ?? null,
          diffPath: event.diffPath ?? null,
          diffDigest: event.diffDigest ?? null,
          snapshotDigest: event.snapshotDigest ?? null,
          modelTier: event.modelTier ?? null,
          modelSelection: event.modelSelection ?? null,
          resolvedModel: event.resolvedModel ?? null,
          degradationReason: event.degradationReason ?? null,
        }),
      });
    }
    case 'BLAST_RADIUS_CHECKED': {
      assertPhase(currentState, event, 'CHILD_COMPLETED');
      assertCurrentAttempt(currentState, event);
      return advancedState(currentState, event, {
        attempts: replaceLatestAttempt(currentState, { blastRadiusPassed: event.passed }),
      });
    }
    case 'VERIFIER_RECORDED': {
      assertPhase(currentState, event, 'BLAST_RADIUS_CHECKED');
      assertCurrentAttempt(currentState, event);
      if (latestAttempt(currentState).blastRadiusPassed !== true) {
        transitionError(event, currentState, 'verifier requires a passed blast-radius check');
      }
      if (currentState.mode === 'BOOLEAN' && event.metric !== null) {
        transitionError(event, currentState, 'boolean verifier requires null metric');
      }
      if (currentState.mode === 'BOOLEAN' && !['GOAL_REACHED', 'KEEP'].includes(event.verdict)) {
        transitionError(event, currentState, 'boolean verifier requires GOAL_REACHED or KEEP verdict');
      }
      if (currentState.mode === 'METRIC' && event.metric === null) {
        transitionError(event, currentState, 'metric verifier requires a finite metric');
      }
      if (currentState.mode === 'METRIC' && !['KEEP', 'DISCARD'].includes(event.verdict)) {
        transitionError(event, currentState, 'metric verifier requires KEEP or DISCARD verdict');
      }
      return advancedState(currentState, event, {
        attempts: replaceLatestAttempt(currentState, { verdict: event.verdict, metric: event.metric }),
      });
    }
    case 'COMMIT_INTENT': {
      assertPhase(currentState, event, 'VERIFIER_RECORDED');
      assertCurrentAttempt(currentState, event);
      const attempt = latestAttempt(currentState);
      if (currentState.mode === 'METRIC') {
        const metricBest = retainedGoalCandidate(currentState).metricBest;
        if (attempt.verdict !== 'KEEP') {
          transitionError(event, currentState, 'metric commit intent requires a keep verdict');
        }
        if (!metricImproves(currentState.metricDirection, attempt.metric, metricBest)) {
          transitionError(
            event,
            currentState,
            'metric commit intent requires a strict improvement over the retained best',
          );
        }
      } else if (!['GOAL_REACHED', 'KEEP'].includes(attempt.verdict)) {
        transitionError(event, currentState, 'commit intent requires a keep verdict');
      }
      if (event.commit === currentState.baseline) {
        fail(
          'DUPLICATE_IDENTITY',
          `commit identity '${event.commit}' collides with the selected baseline`,
        );
      }
      const owner = currentState.attempts.find((item) => (
        item.expectedCommit === event.commit || item.commit === event.commit
      ));
      if (owner !== undefined) {
        fail(
          'DUPLICATE_IDENTITY',
          `commit identity '${event.commit}' already belongs to attempt ${owner.attempt}`,
        );
      }
      return advancedState(currentState, event, {
        attempts: replaceLatestAttempt(currentState, { expectedCommit: event.commit }),
        pendingCommit: { attempt: event.attempt, commit: event.commit },
      });
    }
    case 'COMMIT_RECORDED': {
      assertPhase(currentState, event, 'COMMIT_INTENT');
      assertCurrentAttempt(currentState, event);
      if (event.commit !== currentState.pendingCommit?.commit) {
        fail(
          'COMMIT_CORRELATION',
          `commit '${event.commit}' does not match commit intent '${currentState.pendingCommit?.commit}'`,
        );
      }
      return advancedState(currentState, event, {
        attempts: replaceLatestAttempt(currentState, {
          disposition: 'COMMIT',
          commit: event.commit,
        }),
        currentAttempt: null,
        commits: [...currentState.commits, event.commit],
        pendingCommit: null,
      });
    }
    case 'DISCARD_INTENT': {
      if (!['VERIFIER_RECORDED', 'BLAST_RADIUS_CHECKED'].includes(currentState.phase)) {
        transitionError(event, currentState);
      }
      assertCurrentAttempt(currentState, event);
      const attempt = latestAttempt(currentState);
      const verifierDiscard = currentState.phase === 'VERIFIER_RECORDED'
        && attempt.verdict === 'DISCARD';
      const blastDiscard = currentState.phase === 'BLAST_RADIUS_CHECKED'
        && attempt.blastRadiusPassed === false;
      if (!verifierDiscard && !blastDiscard) {
        transitionError(event, currentState, 'discard intent requires a discard verdict');
      }
      return advancedState(currentState, event, {
        attempts: Object.hasOwn(event, 'snapshot')
          ? replaceLatestAttempt(currentState, { discardSnapshot: event.snapshot })
          : currentState.attempts,
      });
    }
    case 'DISCARD_RECORDED': {
      assertPhase(currentState, event, 'DISCARD_INTENT');
      assertCurrentAttempt(currentState, event);
      return advancedState(currentState, event, {
        attempts: replaceLatestAttempt(currentState, { disposition: 'DISCARD' }),
        currentAttempt: null,
      });
    }
    case 'REVIEW_COMPLETED': {
      if (!canReview(currentState)) transitionError(event, currentState, 'review has no terminal candidate');
      if (Object.hasOwn(event, 'review')) {
        const priorReviewIdentity = currentState.reviewHistory.at(-1)?.review ?? 0;
        if (event.review <= priorReviewIdentity) {
          fail('REVIEW_CORRELATION', `review identity must exceed ${priorReviewIdentity}, got ${event.review}`);
        }
        const afterAttempt = latestAttempt(currentState)?.attempt ?? null;
        if (event.attempt !== afterAttempt) {
          fail('ATTEMPT_CORRELATION', `review attempt expected ${afterAttempt}, got ${event.attempt}`);
        }
      }
      const review = Object.freeze({
        approved: event.approved,
        afterAttempt: latestAttempt(currentState)?.attempt ?? null,
        timestamp: event.timestamp,
        ...(Object.hasOwn(event, 'review') ? {
          review: event.review,
          attempt: event.attempt,
          diffPath: event.diffPath,
          diffDigest: event.diffDigest,
          reportPath: event.reportPath,
          reportDigest: event.reportDigest,
          modelTier: event.modelTier ?? null,
          modelSelection: event.modelSelection ?? null,
          resolvedModel: event.resolvedModel ?? null,
          degradationReason: event.degradationReason ?? null,
        } : {}),
      });
      return advancedState(currentState, event, {
        review,
        reviewHistory: [...currentState.reviewHistory, review],
      });
    }
    case 'TERMINAL_RECORDED': {
      assertPhase(currentState, event, 'REVIEW_COMPLETED');
      const expected = selectTerminalOutcome(currentState);
      if (expected === null) {
        transitionError(event, currentState, 'rejected review requires another budgeted attempt');
      }
      if (event.outcome !== expected) {
        transitionError(event, currentState, `terminal outcome must be ${expected}, got ${event.outcome}`);
      }
      return advancedState(currentState, event, {
        executionTerminal: true,
        goalSucceeded: event.outcome === 'GOAL_REACHED',
        terminalOutcome: event.outcome,
        terminalEvidence: Object.hasOwn(event, 'diffPath') ? Object.freeze({
          diffPath: event.diffPath,
          diffDigest: event.diffDigest,
          head: event.head,
          snapshotDigest: event.snapshotDigest,
        }) : null,
      });
    }
    case 'RECONCILIATION_REQUIRED': {
      if (currentState.phase === 'EMPTY' || currentState.phase === 'RECONCILIATION_REQUIRED') {
        transitionError(event, currentState);
      }
      if (currentState.currentAttempt === null) {
        if (event.attempt !== null) {
          fail('ATTEMPT_CORRELATION', `attempt correlation expected null, got ${event.attempt}`);
        }
      } else {
        if (event.attempt === null) {
          fail(
            'ATTEMPT_CORRELATION',
            `attempt correlation expected ${currentState.currentAttempt}, got null`,
          );
        }
        assertCurrentAttempt(currentState, event);
      }
      return advancedState(currentState, event, {
        reconciliation: {
          attempt: event.attempt,
          commit: currentState.pendingCommit?.commit ?? null,
          reason: event.reason,
        },
      });
    }
    case 'RUN_HALTED': {
      if (currentState.phase === 'EMPTY') transitionError(event, currentState);
      if (currentState.pendingCommit !== null && currentState.phase !== 'RECONCILIATION_REQUIRED') {
        transitionError(event, currentState, 'pending commit requires RECONCILIATION_REQUIRED before halt');
      }
      if (currentState.currentAttempt === null) {
        if (event.attempt !== null) {
          fail('ATTEMPT_CORRELATION', `attempt correlation expected null, got ${event.attempt}`);
        }
      } else {
        if (event.attempt === null) {
          fail(
            'ATTEMPT_CORRELATION',
            `attempt correlation expected ${currentState.currentAttempt}, got null`,
          );
        }
        assertCurrentAttempt(currentState, event);
      }
      return advancedState(currentState, event, {
        executionTerminal: true,
        goalSucceeded: false,
        terminalOutcome: null,
        haltReason: event.reason,
      });
    }
    default:
      fail('UNKNOWN_EVENT', `unknown event name '${String(event.event)}'`);
  }
}

export function reduceWorkflowEvents(events, initialState = createWorkflowState()) {
  if (!Array.isArray(events)) fail('INVALID_EVENTS', 'events must be an array');
  return events.reduce((state, event) => reduceWorkflowEvent(state, event), initialState);
}

export function validateTerminalState(state) {
  assertPlainObject(state, 'workflow state');
  if (
    state.executionTerminal !== true
    || state.phase !== 'TERMINAL_RECORDED'
    || !TERMINAL_OUTCOME_SET.has(state.terminalOutcome)
  ) {
    fail('NOT_CLEAN_TERMINAL', 'workflow state is not a clean terminal state');
  }
  const expected = selectTerminalOutcome(state);
  if (expected !== state.terminalOutcome) {
    fail(
      'INVALID_TERMINAL_STATE',
      `terminal state outcome '${state.terminalOutcome}' conflicts with '${String(expected)}'`,
    );
  }
  if (state.goalSucceeded !== (state.terminalOutcome === 'GOAL_REACHED')) {
    fail('INVALID_TERMINAL_STATE', 'goal success must be derived only from GOAL_REACHED');
  }
  return state;
}

function jsonlInputBytes(input) {
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  fail('INVALID_JSONL_INPUT', 'JSONL input must be a string or byte array');
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail('INVALID_UTF8', 'JSONL must be valid UTF-8');
  }
}

export function parseWorkflowJsonl(input) {
  const bytes = jsonlInputBytes(input);
  const sourceBytes = decodeUtf8(bytes);
  if (bytes.length > 0 && bytes.at(-1) !== 0x0a) {
    fail('TRUNCATED_STREAM', 'truncated JSONL stream: final LF is missing');
  }

  const events = [];
  const records = [];
  let recordStart = 0;
  let lineNumber = 1;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    const rawRecord = bytes.subarray(recordStart, index + 1);
    let contentEnd = index;
    if (contentEnd > recordStart && bytes[contentEnd - 1] === 0x0d) contentEnd -= 1;
    if (contentEnd === recordStart) {
      fail('BLANK_JSONL_RECORD', `blank JSONL record at line ${lineNumber}`);
    }
    const content = decodeUtf8(bytes.subarray(recordStart, contentEnd));
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      fail('MALFORMED_JSONL', `malformed JSONL at line ${lineNumber}: ${error.message}`);
    }
    const event = validateWorkflowEvent(parsed);
    events.push(event);
    records.push(Object.freeze({
      lineNumber,
      bytes: decodeUtf8(rawRecord),
      event,
    }));
    recordStart = index + 1;
    lineNumber += 1;
  }

  Object.defineProperties(events, {
    sourceBytes: { value: sourceBytes, enumerable: false },
    byteLength: { value: bytes.length, enumerable: false },
    records: { value: Object.freeze(records), enumerable: false },
  });
  return Object.freeze(events);
}

export function reduceWorkflowJsonl(input) {
  const events = parseWorkflowJsonl(input);
  const state = reduceWorkflowEvents(events);
  return freezeState({
    ...state,
    validatedJsonl: events.sourceBytes,
    validatedByteLength: events.byteLength,
  });
}

export function classifyCommitReconciliation(state, gitObservation) {
  assertPlainObject(state, 'workflow state');
  assertPlainObject(gitObservation, 'Git observation');
  const allowed = new Set([
    'head',
    'worktreeClean',
    'commit',
    'parent',
    'runId',
    'attempt',
    'expectedParent',
    'owner',
    'unique',
    'snapshotDigest',
    'worktreeMatchesCommit',
  ]);
  for (const key of Reflect.ownKeys(gitObservation)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      fail('UNKNOWN_GIT_OBSERVATION', `unknown Git observation field '${String(key)}'`);
    }
  }
  for (const field of [...allowed].filter((name) => name !== 'worktreeMatchesCommit')) {
    if (!Object.hasOwn(gitObservation, field)) {
      fail('INVALID_GIT_OBSERVATION', `missing Git observation field '${field}'`);
    }
  }
  assertGitObjectId(gitObservation.head, 'observed HEAD');
  if (typeof gitObservation.worktreeClean !== 'boolean') {
    fail('INVALID_GIT_OBSERVATION', 'worktreeClean must be a boolean');
  }
  if (Object.hasOwn(gitObservation, 'worktreeMatchesCommit')
    && typeof gitObservation.worktreeMatchesCommit !== 'boolean') {
    fail('INVALID_GIT_OBSERVATION', 'worktreeMatchesCommit must be a boolean when supplied');
  }
  assertGitObjectId(gitObservation.commit, 'observed commit');
  assertGitObjectId(gitObservation.parent, 'observed commit parent');
  assertNonEmptyLine(gitObservation.runId, 'observed commit runId');
  assertPositiveInteger(gitObservation.attempt, 'observed commit attempt');
  assertGitObjectId(gitObservation.expectedParent, 'observed expectedParent');
  assertNonEmptyLine(gitObservation.owner, 'observed commit owner');
  if (typeof gitObservation.unique !== 'boolean') {
    fail('INVALID_GIT_OBSERVATION', 'unique must be a boolean');
  }
  if (gitObservation.snapshotDigest !== null
    && (typeof gitObservation.snapshotDigest !== 'string'
      || !/^[0-9a-f]{64}$/u.test(gitObservation.snapshotDigest))) {
    fail('INVALID_GIT_OBSERVATION', 'snapshotDigest must be null or a lowercase SHA-256 digest');
  }

  if (state.reconciliation !== null || state.phase === 'RECONCILIATION_REQUIRED') {
    return Object.freeze({
      classification: 'AMBIGUOUS_GIT_STATE',
      reason: 'RECONCILIATION_ALREADY_REQUIRED',
    });
  }
  if (state.pendingCommit === null) {
    return Object.freeze({ classification: 'NOT_REQUIRED' });
  }
  if (state.pendingCommit.commit === state.baseline) {
    return Object.freeze({
      classification: 'AMBIGUOUS_GIT_STATE',
      reason: 'BASELINE_IDENTITY_COLLISION',
    });
  }
  if (state.phase !== 'COMMIT_INTENT' || state.controllerCommitAuthorized !== true) {
    return Object.freeze({
      classification: 'AMBIGUOUS_GIT_STATE',
      reason: 'PENDING_INTENT_STATE_MISMATCH',
    });
  }
  const attempt = state.attempts.at(-1) ?? null;
  if (attempt?.expectedParent === null || attempt?.expectedParent === undefined) {
    return Object.freeze({
      classification: 'AMBIGUOUS_GIT_STATE',
      reason: 'MISSING_EXPECTED_PARENT',
    });
  }
  if (gitObservation.unique !== true
    || gitObservation.commit !== state.pendingCommit.commit
    || gitObservation.parent !== attempt.expectedParent
    || gitObservation.runId !== state.runId
    || gitObservation.attempt !== state.pendingCommit.attempt
    || gitObservation.expectedParent !== attempt.expectedParent
    || gitObservation.owner !== 'steepy-loop-engineer-v1') {
    return Object.freeze({
      classification: 'AMBIGUOUS_GIT_STATE',
      reason: 'COMMIT_METADATA_MISMATCH',
    });
  }
  if (gitObservation.head === state.pendingCommit.commit) {
    if (!gitObservation.worktreeClean) {
      if (gitObservation.worktreeMatchesCommit === true) {
        return Object.freeze({
          classification: 'SAFE_PARTIAL_CONTROLLER_COMMIT',
          attempt: state.pendingCommit.attempt,
          commit: state.pendingCommit.commit,
          expectedParent: attempt.expectedParent,
        });
      }
      return Object.freeze({
        classification: 'AMBIGUOUS_GIT_STATE',
        reason: 'DIRTY_WORKTREE',
      });
    }
    return Object.freeze({
      classification: 'SAFE_CONTROLLER_COMMIT',
      attempt: state.pendingCommit.attempt,
      commit: state.pendingCommit.commit,
    });
  }
  if (gitObservation.head === attempt.expectedParent
    && gitObservation.snapshotDigest === attempt.snapshotDigest) {
    return Object.freeze({
      classification: 'SAFE_PENDING_CONTROLLER_COMMIT',
      attempt: state.pendingCommit.attempt,
      commit: state.pendingCommit.commit,
      expectedParent: attempt.expectedParent,
    });
  }
  return Object.freeze({
    classification: 'AMBIGUOUS_GIT_STATE',
    reason: 'UNEXPECTED_HEAD',
  });
}

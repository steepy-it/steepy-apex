import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  constants as FS_CONSTANTS,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { headlessCommand } from '../adapters/headless.mjs';
import { decodeHeadlessEvent } from '../adapters/headless-events.mjs';
import {
  BoundedMultiDestinationWriter,
  LineFramer,
  processEventLine,
} from './autopilot-observability.mjs';
import {
  appendWorkPath,
  openWorkPathFd,
  parseWorkPath,
  readWorkPath,
  writeWorkPath,
} from './work-paths.mjs';
import { writeAllSync } from './write-all.mjs';
import {
  WORKFLOW_EVENT_SCHEMA_VERSION,
  classifyCommitReconciliation,
  parseWorkflowJsonl,
  reduceWorkflowEvent,
  reduceWorkflowJsonl,
  retainedGoalCandidate,
  selectTerminalOutcome,
  validateTerminalState,
  validateWorkflowEvent,
} from './workflow-state.mjs';

const GOAL_FIELDS = Object.freeze([
  'goal', 'surface', 'verifier', 'mode', 'metric-direction', 'budget', 'blast-radius', 'notes',
]);
const GOAL_FIELD_SET = new Set(GOAL_FIELDS);
const SAFE_SURFACE = /^[a-z][a-z0-9-]*$/u;
const SAFE_VERIFIER_TOKEN = /^[A-Za-z0-9_./:@=,+-]+$/u;
const SAFE_BLAST_PATTERN = /^[A-Za-z0-9._/*?+-]+$/u;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const GIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const IMPLEMENTER_PROMPT = readFileSync(
  new URL('../skills/loop-engineer/loop-implementer-prompt.md', import.meta.url),
  'utf8',
);
const REVIEWER_PROMPT = readFileSync(
  new URL('../skills/loop-engineer/loop-final-review-prompt.md', import.meta.url),
  'utf8',
);

export class LoopControllerError extends Error {
  constructor(code, message) {
    super(`loop controller [${code}]: ${message}`);
    this.name = 'LoopControllerError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new LoopControllerError(code, message);
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_INPUT', `${label} must be an object`);
  }
}

function nonEmptyLine(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || /[\r\n\0]/u.test(value)) {
    fail('INVALID_GOAL', `${label} must be a non-empty single line`);
  }
  return value;
}

const GOAL_PREAMBLE = /^<!-- verdict: (?:COVERED|CONFLICT|GAP) \| gear: 4 -->\n<!-- steepy-workflow: v1\nphase: goal-contract\nstatus: READY\nnext: loop-engineer\nsource: none\nconsumed-by: none\n-->\n# [^\r\n]+\n\n/u;

function goalForEntry(text, { resume, ledgerPath }) {
  if (GOAL_PREAMBLE.test(text)) return Object.freeze({ canonicalText: text, consumed: false });
  if (resume === true) {
    const consumed = `phase: goal-contract\nstatus: CONSUMED\nnext: loop-engineer\nsource: none\nconsumed-by: ${ledgerPath}`;
    const ready = 'phase: goal-contract\nstatus: READY\nnext: loop-engineer\nsource: none\nconsumed-by: none';
    if (text.includes(consumed)) {
      const canonicalText = text.replace(consumed, ready);
      if (GOAL_PREAMBLE.test(canonicalText)) {
        return Object.freeze({ canonicalText, consumed: true });
      }
    }
  }
  fail('INVALID_GOAL_HEADER', 'goal requires the exact ratified gear-4 v1 preamble');
}

function bodyOffsetAfterHeader(text) {
  const match = GOAL_PREAMBLE.exec(text);
  if (match === null) {
    fail('INVALID_GOAL_HEADER', 'goal requires the exact ratified gear-4 v1 preamble');
  }
  return match[0].length;
}

function parseVerifier(value) {
  nonEmptyLine(value, 'verifier');
  const argv = value.split(/\s+/u);
  if (argv.some((token) => !SAFE_VERIFIER_TOKEN.test(token))) {
    fail('INVALID_VERIFIER', 'verifier must use plain safe argv tokens without shell syntax');
  }
  return Object.freeze(argv);
}

function parseBlastRadius(value) {
  nonEmptyLine(value, 'blast-radius');
  const patterns = value.split(',').map((pattern) => pattern.trim());
  if (patterns.some((pattern) => pattern.length === 0
    || pattern.startsWith('/')
    || pattern.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    || !SAFE_BLAST_PATTERN.test(pattern))) {
    fail('INVALID_BLAST_RADIUS', 'blast-radius must contain safe repo-relative comma-separated globs');
  }
  return Object.freeze(patterns);
}

export function parseGoalContract(text) {
  if (typeof text !== 'string') fail('INVALID_GOAL', 'goal contract must be UTF-8 text');
  const body = text.slice(bodyOffsetAfterHeader(text));
  if (body.length === 0 || !body.endsWith('\n') || body.includes('\r')) {
    fail('INVALID_GOAL', 'goal body must be non-empty canonical line records');
  }
  const fields = new Map();
  for (const line of body.slice(0, -1).split('\n')) {
    const match = /^([a-z][a-z-]*): (.*)$/u.exec(line);
    if (match === null) fail('INVALID_GOAL', 'goal body contains a malformed structural line');
    const [, key, value] = match;
    if (!GOAL_FIELD_SET.has(key)) fail('UNKNOWN_GOAL_FIELD', `unknown goal field '${key}'`);
    if (fields.has(key)) fail('DUPLICATE_GOAL_FIELD', `duplicate goal field '${key}'`);
    fields.set(key, value);
  }
  const modeText = fields.get('mode');
  if (modeText !== 'boolean' && modeText !== 'metric') fail('INVALID_GOAL', 'mode must be boolean or metric');
  const required = modeText === 'metric'
    ? GOAL_FIELDS
    : GOAL_FIELDS.filter((field) => field !== 'metric-direction');
  const missing = required.filter((field) => !fields.has(field));
  if (missing.length > 0) fail('MISSING_GOAL_FIELD', `missing goal fields: ${missing.join(', ')}`);
  if (modeText === 'boolean' && fields.has('metric-direction')) {
    fail('INVALID_GOAL', 'metric-direction is allowed only in metric mode');
  }
  const budgetText = fields.get('budget');
  const budget = Number(budgetText);
  if (!Number.isSafeInteger(budget) || budget < 1 || String(budget) !== budgetText) {
    fail('INVALID_GOAL', 'budget must be a canonical positive safe integer');
  }
  const metricDirection = fields.get('metric-direction') ?? null;
  if (modeText === 'metric' && !['min', 'max'].includes(metricDirection)) {
    fail('INVALID_GOAL', 'metric-direction must be min or max in metric mode');
  }
  const surface = nonEmptyLine(fields.get('surface'), 'surface');
  if (!SAFE_SURFACE.test(surface)) fail('INVALID_GOAL', 'surface must be a canonical lowercase surface name');
  const verifier = nonEmptyLine(fields.get('verifier'), 'verifier');
  return Object.freeze({
    goal: nonEmptyLine(fields.get('goal'), 'goal'),
    surface,
    verifier,
    verifierArgv: parseVerifier(verifier),
    mode: modeText.toUpperCase(),
    metricDirection,
    budget,
    blastRadius: parseBlastRadius(fields.get('blast-radius')),
    notes: nonEmptyLine(fields.get('notes'), 'notes'),
  });
}

function derivedPaths(goalPath) {
  const loopDir = dirname(goalPath);
  return Object.freeze({
    loopDir,
    ledgerPath: `${loopDir}/ledger.md`,
    eventsPath: `${loopDir}/events.jsonl`,
    diffPath: `${loopDir}/branch-diff.txt`,
  });
}

function safeStablePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value
    || value.startsWith('/') || value.includes('\\')
    || value.split('/').some((part) => part === '' || part === '.' || part === '..')
    || /[\r\n\0]/u.test(value)
    || !value.startsWith('.apex/') || value.startsWith('.apex/work/') || !value.endsWith('.md')) {
    fail('INVALID_ROUTING', `${label} must be a stable confined .apex Markdown path`);
  }
  return value;
}

function readStableRoutingFile(repoRoot, path, label) {
  safeStablePath(path, label);
  const absolute = resolve(repoRoot, path);
  const root = realpathSync(resolve(repoRoot));
  let fd;
  try {
    const entry = lstatSync(absolute, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink()) {
      fail('INVALID_ROUTING', `${label} is not a physical regular file: ${path}`);
    }
    const physical = realpathSync(absolute);
    if (!physical.startsWith(`${root}${sep}`)) {
      fail('INVALID_ROUTING', `${label} escapes the target repository: ${path}`);
    }
    fd = openSync(absolute, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino) {
      fail('INVALID_ROUTING', `${label} identity changed while opening: ${path}`);
    }
    return readFileSync(fd, 'utf8');
  } catch (error) {
    if (error instanceof LoopControllerError) throw error;
    fail('INVALID_ROUTING', `${label} cannot be read: ${path}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function routingRows(indexText) {
  const rows = [];
  for (const line of indexText.split('\n')) {
    const match = /^\|\s*`([a-z][a-z0-9-]*)`\s*\|\s*\[[^\]]+\]\(([^)]+\.md)\)\s*\|/u.exec(line);
    if (match !== null) rows.push(Object.freeze({ surface: match[1], target: match[2] }));
  }
  return rows;
}

function standardLinks(corePath, coreText) {
  const links = [];
  for (const line of coreText.split('\n')) {
    const match = /^\|[^\r\n]*\[[^\]]+\]\(([^)]+\.md)\)[^\r\n]*\|\s*$/u.exec(line);
    if (match === null) continue;
    const linked = join(dirname(corePath), match[1]);
    safeStablePath(linked, 'modular standard link');
    if (!links.includes(linked)) links.push(linked);
  }
  return links;
}

export function resolveLoopRouting(repoRoot, surface, routingPath, standardPaths) {
  if (routingPath !== '.apex/_INDEX.md') {
    fail('INVALID_ROUTING', "routing index must be the exact stable path '.apex/_INDEX.md'");
  }
  if (!Array.isArray(standardPaths) || standardPaths.length === 0
    || new Set(standardPaths).size !== standardPaths.length) {
    fail('INVALID_ROUTING', 'one ordered, duplicate-free standard inventory is required');
  }
  const indexText = readStableRoutingFile(repoRoot, routingPath, 'routing index');
  const rows = routingRows(indexText).filter((row) => row.surface === surface);
  if (rows.length !== 1) {
    fail('UNSUPPORTED_SURFACE', `surface '${surface}' must have exactly one target-project routing row`);
  }
  const routedStandard = `.apex/${rows[0].target}`;
  safeStablePath(routedStandard, 'routed standard');
  if (standardPaths[0] !== routedStandard) {
    fail('INVALID_ROUTING', `standard inventory must begin with routed standard '${routedStandard}'`);
  }
  const texts = standardPaths.map((path) => readStableRoutingFile(repoRoot, path, 'surface standard'));
  for (const [index, text] of texts.entries()) {
    if (!/^# [^\r\n]*standard[^\r\n]*$/imu.test(text)) {
      fail('INVALID_ROUTING', `surface standard is malformed: ${standardPaths[index]}`);
    }
  }
  const modular = routedStandard.endsWith('-core.md');
  if (!modular && standardPaths.length !== 1) {
    fail('INVALID_ROUTING', 'single-file routing accepts only its exact registered standard');
  }
  if (modular) {
    const reachable = standardLinks(routedStandard, texts[0]);
    let cursor = -1;
    for (const leaf of standardPaths.slice(1)) {
      const index = reachable.indexOf(leaf);
      if (index < 0 || index <= cursor) {
        fail('INVALID_ROUTING', 'modular leaves must be reachable and preserve core table order');
      }
      cursor = index;
    }
  }
  return Object.freeze({
    surface,
    routingPath,
    standardPaths: Object.freeze([...standardPaths]),
  });
}

export function validateLoopPreflight(candidate) {
  assertPlainObject(candidate, 'preflight');
  try {
    parseWorkPath(candidate.goalPath, 'goal', 'goal');
  } catch (error) {
    fail('UNSAFE_PATH', error.message);
  }
  const paths = derivedPaths(candidate.goalPath);
  if (candidate.resume === true) {
    if (candidate.ledgerPath !== paths.ledgerPath) {
      fail('INVALID_RESUME', `resume requires exact ledger '${paths.ledgerPath}'`);
    }
  } else if (candidate.resume !== false || candidate.ledgerPath !== undefined) {
    fail('INVALID_RESUME', 'fresh entry forbids --ledger and resume must be explicit');
  }
  if (candidate.routing === null || typeof candidate.routing !== 'object'
    || candidate.routing.surface !== candidate.contract?.surface
    || candidate.routing.routingPath !== '.apex/_INDEX.md'
    || !Array.isArray(candidate.routing.standardPaths)
    || candidate.routing.standardPaths.length === 0) {
    fail('UNSUPPORTED_SURFACE', `unbound surface routing '${String(candidate.contract?.surface)}'`);
  }
  nonEmptyLine(candidate.branch, 'branch');
  if (candidate.branch === 'main' || candidate.branch === 'master') {
    fail('PROTECTED_BRANCH', `loop controller refuses protected branch '${candidate.branch}'`);
  }
  if (candidate.resume !== true
    && candidate.expectedBranch !== undefined
    && candidate.branch !== candidate.expectedBranch) {
    fail('UNEXPECTED_BRANCH', `expected branch '${candidate.expectedBranch}', got '${candidate.branch}'`);
  }
  if (candidate.resume !== true && candidate.dirty === true) {
    fail('DIRTY_FRESH_TREE', 'fresh loop entry requires a clean working tree');
  }
  if (candidate.commitAuthorized !== true) {
    fail('COMMIT_REQUIRED', 'controller-owned commits must be explicitly authorized');
  }
  if (candidate.runnerDescriptor === null || candidate.runnerDescriptor === undefined) {
    fail('RUNNER_UNAVAILABLE', `runner-unavailable: ${String(candidate.harness)}`);
  }
  return Object.freeze({ ...candidate, ...paths, resume: candidate.resume === true });
}

function optionalWorkBytes(repoRoot, path, family) {
  try {
    return readWorkPath(repoRoot, path, { expect: 'work-output', family });
  } catch (error) {
    if (/missing work artifact/u.test(error.message)) return null;
    throw error;
  }
}

function validateTimestamp(value) {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)
    || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail('INVALID_CLOCK', 'clock must return a canonical UTC timestamp');
  }
  return value;
}

function validateRunId(value) {
  if (typeof value !== 'string' || !CANONICAL_UUID.test(value)) {
    fail('INVALID_RUN_ID', 'UUID source must return a canonical UUID');
  }
  return value;
}

function validateGitIdentity(value) {
  if (typeof value !== 'string' || !GIT_ID.test(value)) {
    fail('INVALID_GIT_STATE', 'Git baseline must be a full lowercase object identity');
  }
  return value;
}

function verifierObservation(contract, verifier, repoRoot) {
  if (verifier === null || typeof verifier !== 'object' || typeof verifier.run !== 'function') {
    fail('INVALID_DEPENDENCY', 'verifier.run must be injected');
  }
  const result = verifier.run(contract.verifier, {
    argv: contract.verifierArgv,
    cwd: repoRoot,
    mode: contract.mode,
  });
  if (result === null || typeof result !== 'object'
    || !Number.isSafeInteger(result.status) || result.status < 0 || result.error) {
    fail('UNRELIABLE_VERIFIER', 'verifier did not execute to a deterministic exit status');
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  let metric = null;
  if (contract.mode === 'METRIC') {
    if (result.status !== 0) {
      fail('UNRELIABLE_VERIFIER', 'metric verifier must exit successfully');
    }
    const withoutTrailingNewlines = stdout.replace(/(?:\r?\n)+$/u, '');
    const scalar = withoutTrailingNewlines.split(/\r?\n/u).at(-1) ?? '';
    if (!/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(scalar)) {
      fail('UNRELIABLE_VERIFIER', 'metric verifier last stdout line must be a canonical finite scalar');
    }
    metric = Number(scalar);
    if (!Number.isFinite(metric)) fail('UNRELIABLE_VERIFIER', 'metric result is outside the finite range');
  }
  return Object.freeze({ status: result.status, stdout, stderr, metric });
}
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function goalIdentity(contract, goalBytes) {
  return Object.freeze({
    goalDigest: sha256(goalBytes),
    mode: contract.mode,
    budget: contract.budget,
    verifier: contract.verifier,
    verifierArgv: contract.verifierArgv,
    metricDirection: contract.metricDirection,
    blastRadius: contract.blastRadius,
    controllerCommitAuthorized: true,
  });
}

function assertGoalIdentity(state, identity) {
  const arraysEqual = (left, right) => Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => value === right[index]);
  if (state.goalDigest !== identity.goalDigest
    || state.mode !== identity.mode
    || state.budget !== identity.budget
    || state.verifier !== identity.verifier
    || !arraysEqual(state.verifierArgv, identity.verifierArgv)
    || state.metricDirection !== identity.metricDirection
    || !arraysEqual(state.blastRadius, identity.blastRadius)
    || state.controllerCommitAuthorized !== identity.controllerCommitAuthorized) {
    fail('GOAL_DRIFT', 'goal contract drifted from the RUN_STARTED machine-state identity');
  }
}

function renderLedger({
  goalPath,
  eventBytes,
  state,
}) {
  const terminal = state.phase === 'TERMINAL_RECORDED';
  return `<!-- steepy-workflow: v1
phase: loop-engineer
status: ${terminal ? 'READY' : 'DRAFT'}
next: review
source: ${goalPath}
consumed-by: none
-->
# Gear-4 loop ledger

events-sha256: ${sha256(eventBytes)}
goal-sha256: ${state.goalDigest}
run-id: ${state.runId}
branch: ${state.branch}
baseline: ${state.baseline}
mode: ${state.mode.toLowerCase()}
metric-direction: ${state.metricDirection ?? 'none'}
budget: ${state.budget}
blast-radius: ${state.blastRadius.join(', ')}
commit-authorized: true
verifier: ${state.verifier}
sanity-exit: ${state.baselineVerifier.exit}
sanity-metric: ${state.baselineVerifier.metric ?? 'none'}
attempts-reserved: ${state.reservedAttempts.length}
outcome: ${terminal ? state.terminalOutcome : 'none'}
goal-succeeded: ${state.goalSucceeded === true ? 'true' : 'false'}
observability-degraded: ${state.observabilityDegraded === true ? 'true' : 'false'}
`;
}

function terminalCandidateFacts(state) {
  const retained = retainedGoalCandidate(state);
  return Object.freeze({
    acceptable: retained.acceptable,
    'boolean-green': retained.booleanGreen,
    'metric-baseline': retained.metricBaseline,
    'metric-best': retained.metricBest,
    'metric-strict-improvement': retained.metricStrictImprovement,
  });
}

export function validateLoopTerminal(goalPath, ledgerPath, options = {}) {
  assertPlainObject(options, 'terminal validation options');
  const optionKeys = Reflect.ownKeys(options);
  if (optionKeys.some((key) => !['repoRoot', 'git'].includes(key))) {
    fail('INVALID_TERMINAL_INPUT', 'terminal validation accepts only repoRoot and an internal read-only Git adapter');
  }
  const repoRoot = options.repoRoot;
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    fail('INVALID_TERMINAL_INPUT', 'repoRoot is required');
  }
  try {
    parseWorkPath(goalPath, 'goal', 'goal');
  } catch (error) {
    fail('INVALID_TERMINAL_INPUT', error.message);
  }
  const paths = derivedPaths(goalPath);
  if (ledgerPath !== paths.ledgerPath) {
    fail('INVALID_TERMINAL_INPUT', `terminal validation requires exact ledger '${paths.ledgerPath}'`);
  }
  try {
    parseWorkPath(ledgerPath, 'work-output', 'ledger');
  } catch (error) {
    fail('INVALID_TERMINAL_INPUT', error.message);
  }
  const eventsPath = `${dirname(ledgerPath)}/events.jsonl`;
  if (eventsPath !== paths.eventsPath) {
    fail('INVALID_TERMINAL_INPUT', 'accepted ledger does not derive the canonical event identity');
  }

  let goalBytes;
  let ledgerBytes;
  let eventBytes;
  try {
    goalBytes = readWorkPath(repoRoot, goalPath, { expect: 'goal', family: 'goal' });
    ledgerBytes = readWorkPath(repoRoot, ledgerPath, { expect: 'work-output', family: 'ledger' });
    // events.jsonl is controller-private authority: derive it from the exact
    // accepted ledger only after the public goal/ledger pair has been validated.
    eventBytes = readWorkPath(repoRoot, eventsPath, { expect: 'work-output', family: 'events' });
  } catch (error) {
    fail('INVALID_TERMINAL_INPUT', error.message);
  }

  const goalEntry = goalForEntry(goalBytes.toString('utf8'), { resume: true, ledgerPath });
  if (goalEntry.consumed !== true) {
    fail('INVALID_TERMINAL_LIFECYCLE', 'terminal validation requires the controller-consumed goal');
  }
  const canonicalGoalBytes = Buffer.from(goalEntry.canonicalText, 'utf8');
  const contract = parseGoalContract(goalEntry.canonicalText);
  const state = reduceWorkflowJsonl(eventBytes);
  validateTerminalState(state);
  assertGoalIdentity(state, goalIdentity(contract, canonicalGoalBytes));
  const git = options.git ?? createCliGitAdapter();
  for (const method of ['branch', 'head', 'status', 'diff', 'snapshot']) {
    if (typeof git?.[method] !== 'function') {
      fail('INVALID_TERMINAL_INPUT', `read-only Git adapter requires ${method}`);
    }
  }

  const expectedLedger = renderLedger({
    goalPath,
    eventBytes,
    state,
  });
  if (!ledgerBytes.equals(Buffer.from(expectedLedger, 'utf8'))) {
    fail('INVALID_TERMINAL_PROJECTION', 'terminal ledger projection conflicts with event authority or digest');
  }

  const review = state.review;
  if (review === null || !Number.isSafeInteger(review.review) || review.review < 1
    || (review.attempt !== null && (!Number.isSafeInteger(review.attempt) || review.attempt < 1))
    || typeof review.reportPath !== 'string' || typeof review.diffPath !== 'string'
    || typeof review.diffDigest !== 'string' || typeof review.reportDigest !== 'string') {
    fail('INVALID_TERMINAL_REVIEW', 'terminal event authority lacks bounded branch-review evidence');
  }
  if (state.terminalEvidence === null) {
    fail('INVALID_TERMINAL_PROJECTION', 'terminal event authority lacks final projection evidence');
  }
  let reportBytes;
  let reviewDiffBytes;
  let finalDiffBytes;
  try {
    reportBytes = readWorkPath(repoRoot, review.reportPath, {
      expect: 'work-output', family: 'reviewer-report',
    });
    reviewDiffBytes = readWorkPath(repoRoot, review.diffPath, {
      expect: 'work-output', family: 'reviewer-diff',
    });
    finalDiffBytes = readWorkPath(repoRoot, state.terminalEvidence.diffPath, {
      expect: 'work-output', family: 'diff',
    });
  } catch (error) {
    fail('INVALID_TERMINAL_EVIDENCE', error.message);
  }
  if (sha256(reportBytes) !== review.reportDigest) {
    fail('INVALID_TERMINAL_EVIDENCE', 'reviewer report digest drifted from event authority');
  }
  if (sha256(reviewDiffBytes) !== review.diffDigest) {
    fail('INVALID_TERMINAL_EVIDENCE', 'reviewer diff digest drifted from event authority');
  }
  if (sha256(finalDiffBytes) !== state.terminalEvidence.diffDigest) {
    fail('INVALID_TERMINAL_PROJECTION', 'final branch diff digest drifted from event authority');
  }
  const currentBranch = git.branch(repoRoot);
  const currentHead = validateGitIdentity(git.head(repoRoot));
  if (currentBranch !== state.branch) {
    fail('INVALID_TERMINAL_GIT', `current branch '${currentBranch}' differs from reviewed branch '${state.branch}'`);
  }
  if (git.status(repoRoot) !== '') {
    fail('INVALID_TERMINAL_GIT', 'terminal validation requires the reviewed clean tree');
  }
  const retained = state.attempts.at(-1) ?? null;
  const expectedHead = retained === null
    ? state.baseline
    : retained.disposition === 'COMMIT' ? retained.commit : retained.expectedParent;
  if (currentHead !== expectedHead || currentHead !== state.terminalEvidence.head) {
    fail('INVALID_TERMINAL_GIT', 'current HEAD differs from event-derived retained and terminal identities');
  }
  const currentSnapshot = captureGitSnapshot(repoRoot, git);
  if (gitSnapshotDigest(currentSnapshot) !== state.terminalEvidence.snapshotDigest) {
    fail('INVALID_TERMINAL_GIT', 'current Git snapshot differs from the terminal event binding');
  }
  const currentDiff = renderDiffEvidence(state.baseline, git.diff(repoRoot, state.baseline));
  const parsedReviewDiff = parseReviewerEvidence(reviewDiffBytes);
  if (parsedReviewDiff.diffText !== currentDiff) {
    fail('INVALID_TERMINAL_EVIDENCE', 'reviewer diff does not describe the current reviewed Git tree');
  }
  if (!finalDiffBytes.equals(Buffer.from(currentDiff, 'utf8'))) {
    fail('INVALID_TERMINAL_PROJECTION', 'final branch diff does not describe the current reviewed Git tree');
  }
  const eventDigest = sha256(eventBytes);
  return Object.freeze({
    status: 'VALIDATED',
    goal: goalPath,
    'loop-ledger': ledgerPath,
    'run-id': state.runId,
    outcome: state.terminalOutcome,
    'goal-succeeded': state.goalSucceeded,
    'events-sha256': eventDigest,
    mode: state.mode.toLowerCase(),
    'branch-review': Object.freeze({
      verdict: review.approved ? 'APPROVED' : 'ISSUES_FOUND',
      'issues-found': !review.approved,
      review: review.review,
      attempt: review.attempt,
      report: review.reportPath,
      'report-sha256': review.reportDigest,
      diff: review.diffPath,
      'diff-sha256': review.diffDigest,
    }),
    'final-projection': Object.freeze({
      diff: state.terminalEvidence.diffPath,
      'diff-sha256': state.terminalEvidence.diffDigest,
      branch: currentBranch,
      head: currentHead,
      clean: true,
      'snapshot-sha256': state.terminalEvidence.snapshotDigest,
    }),
    'attempt-budget': Object.freeze({
      reserved: state.reservedAttempts.length,
      budget: state.budget,
      exhausted: state.reservedAttempts.length === state.budget,
    }),
    candidate: terminalCandidateFacts(state),
  });
}

function lockIdentity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function readLockSnapshot(lockPath) {
  const lockBefore = lstatSync(lockPath, { bigint: true });
  if (!lockBefore.isDirectory() || lockBefore.isSymbolicLink()) {
    fail('LOCK_UNVERIFIABLE', 'loop lock is not a physical directory');
  }
  const ownerPath = join(lockPath, 'owner.json');
  let fd;
  try {
    fd = openSync(ownerPath, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
  } catch {
    fail('LOCK_UNVERIFIABLE', 'lock owner cannot be opened safely');
  }
  let bytes;
  let ownerStat;
  try {
    ownerStat = fstatSync(fd, { bigint: true });
    if (!ownerStat.isFile() || ownerStat.nlink !== 1n) {
      fail('LOCK_UNVERIFIABLE', 'lock owner is not a single-link ordinary file');
    }
    bytes = readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
  const ownerAfter = lstatSync(ownerPath, { bigint: true });
  const lockAfter = lstatSync(lockPath, { bigint: true });
  if (!ownerAfter.isFile() || ownerAfter.isSymbolicLink() || ownerAfter.nlink !== 1n
    || lockIdentity(ownerAfter) !== lockIdentity(ownerStat)
    || !lockAfter.isDirectory() || lockAfter.isSymbolicLink()
    || lockIdentity(lockAfter) !== lockIdentity(lockBefore)) {
    fail('LOCK_UNVERIFIABLE', 'lock identity changed while reading its owner');
  }
  if (!ownerStat.isFile() || ownerStat.nlink !== 1n) {
    fail('LOCK_UNVERIFIABLE', 'lock owner is not a single-link ordinary file');
  }
  let owner;
  try {
    owner = JSON.parse(bytes);
  } catch {
    fail('LOCK_UNVERIFIABLE', 'lock owner record is not valid JSON');
  }
  const keys = owner && typeof owner === 'object' && !Array.isArray(owner)
    ? Object.keys(owner).sort()
    : [];
  if (keys.join(',') !== 'pid,token' || !Number.isSafeInteger(owner.pid) || owner.pid < 1
    || typeof owner.token !== 'string' || !CANONICAL_UUID.test(owner.token)) {
    fail('LOCK_UNVERIFIABLE', 'lock owner record is malformed');
  }
  return Object.freeze({
    owner: Object.freeze(owner),
    bytes,
    lockIdentity: lockIdentity(lockAfter),
    ownerIdentity: lockIdentity(ownerAfter),
  });
}

function sameLockGeneration(left, right) {
  return left.lockIdentity === right.lockIdentity
    && left.ownerIdentity === right.ownerIdentity
    && left.bytes === right.bytes;
}

function defaultProcessProbe(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    fail('LOCK_UNVERIFIABLE', `cannot verify lock owner process ${pid}`);
  }
}

function acquireLoopLock(
  repoRoot,
  loopDir,
  token,
  processProbe = defaultProcessProbe,
  transitionHook = () => {},
) {
  validateRunId(token);
  const physicalRoot = realpathSync(resolve(repoRoot));
  const physicalLoop = realpathSync(resolve(physicalRoot, loopDir));
  if (!physicalLoop.startsWith(`${physicalRoot}${sep}`)) {
    fail('UNSAFE_LOCK', 'loop directory escapes repository');
  }
  const lockPath = join(physicalLoop, '.loop-engineer.lock');
  let stalePath = null;
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') fail('LOCK_FAILED', `cannot acquire loop lock: ${error.message}`);
    const observed = readLockSnapshot(lockPath);
    let live;
    try {
      live = processProbe(observed.owner.pid);
    } catch {
      fail('LOCK_UNVERIFIABLE', `cannot verify lock owner process ${observed.owner.pid}`);
    }
    if (live !== false) {
      fail('LOCK_CONTENDED', `lock owner is live or unverifiable: ${observed.owner.pid}`);
    }
    let confirmed;
    try {
      confirmed = readLockSnapshot(lockPath);
    } catch {
      fail('LOCK_UNVERIFIABLE', 'lock changed after stale-owner probe');
    }
    if (!sameLockGeneration(observed, confirmed)) {
      fail('LOCK_UNVERIFIABLE', 'lock generation changed after stale-owner probe');
    }
    // Every contender that observed this stale generation converges on the
    // same nonempty destination. Once one contender moves it and publishes a
    // successor, a delayed pathname rename cannot replace that live lock.
    stalePath = join(physicalLoop, `.loop-engineer.lock.stale-${observed.owner.token}`);
    try {
      lstatSync(stalePath);
      fail('LOCK_UNVERIFIABLE', 'stale-lock quarantine already exists');
    } catch (quarantineError) {
      if (quarantineError instanceof LoopControllerError) throw quarantineError;
      if (quarantineError.code !== 'ENOENT') {
        fail('LOCK_UNVERIFIABLE', 'stale-lock quarantine cannot be verified absent');
      }
    }
    transitionHook();
    try {
      renameSync(lockPath, stalePath);
    } catch {
      fail('LOCK_UNVERIFIABLE', 'lock changed during stale-owner quarantine');
    }
    const quarantined = readLockSnapshot(stalePath);
    if (!sameLockGeneration(observed, quarantined)) {
      fail('LOCK_UNVERIFIABLE', 'quarantined lock does not match the probed stale generation');
    }
    mkdirSync(lockPath, { mode: 0o700 });
  }

  const lockStat = lstatSync(lockPath, { bigint: true });
  const acquiredIdentity = lockIdentity(lockStat);
  const ownerPath = join(lockPath, 'owner.json');
  const fd = openSync(
    ownerPath,
    FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | FS_CONSTANTS.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, `${JSON.stringify({ pid: process.pid, token })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  const acquired = readLockSnapshot(lockPath);
  if (acquired.lockIdentity !== acquiredIdentity
    || acquired.owner.pid !== process.pid || acquired.owner.token !== token) {
    fail('LOCK_UNVERIFIABLE', 'new lock identity changed during acquisition');
  }

  // A quarantined stale generation is intentionally retained. Deleting a
  // path-controlled directory cannot be made generation-safe with Node's
  // path-only unlink APIs; retention is the fail-closed choice.
  void stalePath;

  return () => {
    try {
      const current = lstatSync(lockPath, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink()
        || lockIdentity(current) !== acquiredIdentity) return;
      const snapshot = readLockSnapshot(lockPath);
      if (snapshot.lockIdentity !== acquiredIdentity
        || snapshot.owner.pid !== process.pid || snapshot.owner.token !== token) return;
      unlinkSync(ownerPath);
      rmdirSync(lockPath);
    } catch {
      // Never delete a lock whose physical identity or ownership changed.
    }
  };
}

function writeEventStream(
  repoRoot,
  eventsPath,
  event,
  crashHook = () => {},
  writeToFd = writeSync,
) {
  validateWorkflowEvent(event);
  const bytes = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
  crashHook(`before-event-append:${event.event}`);
  const fd = openWorkPathFd(repoRoot, eventsPath, {
    expect: 'work-output',
    family: 'events',
    disposition: 'create-new',
    mode: 0o600,
  });
  try {
    writeAllSync(fd, bytes, writeToFd);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  crashHook(`after-event-append:${event.event}`);
  return bytes;
}

function appendWorkflowEvent(
  repoRoot,
  eventsPath,
  state,
  clock,
  event,
  fields = {},
  crashHook = () => {},
) {
  const candidate = {
    schemaVersion: WORKFLOW_EVENT_SCHEMA_VERSION,
    sequence: state.lastSequence + 1,
    runId: state.runId,
    timestamp: validateTimestamp(clock()),
    event,
    ...fields,
  };
  const nextState = reduceWorkflowEvent(state, candidate);
  crashHook(`before-event-append:${event}`);
  appendWorkPath(repoRoot, eventsPath, `${JSON.stringify(candidate)}\n`, {
    expect: 'work-output',
    family: 'events',
  });
  crashHook(`after-event-append:${event}`);
  return nextState;
}

function attemptPaths(loopDir, runId, attempt) {
  const stem = `${loopDir}/run-${runId}-attempt-${attempt}`;
  return Object.freeze({
    reportPath: `${stem}-report.md`,
    rawPath: `${stem}.raw.jsonl`,
    readablePath: `${stem}.log`,
    diffPath: `${stem}-diff.txt`,
  });
}

function reviewPaths(loopDir, runId, review) {
  const stem = `${loopDir}/run-${runId}-review-${review}`;
  return Object.freeze({
    reportPath: `${stem}-report.md`,
    rawPath: `${stem}.raw.jsonl`,
    readablePath: `${stem}.log`,
    diffPath: `${stem}-diff.txt`,
  });
}

function resultOutput(result) {
  if (result && typeof result.output === 'string') return result.output;
  if (result && typeof result.stdout === 'string') return result.stdout;
  if (result && typeof result.response === 'string') return result.response;
  return '';
}

function writeImmutableBytes(
  repoRoot,
  path,
  family,
  content,
  crashHook = () => {},
  writeToFd = writeSync,
) {
  crashHook(`before-immutable-artifact:${family}`);
  const fd = openWorkPathFd(repoRoot, path, {
    expect: 'work-output', family, disposition: 'create-new', mode: 0o600,
  });
  try {
    const bytes = Buffer.isBuffer(content)
      ? content
      : Buffer.from(typeof content === 'string' ? content : String(content ?? ''), 'utf8');
    writeAllSync(fd, bytes, writeToFd);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  crashHook(`after-immutable-artifact:${family}`);
}

function persistChildEvidence(
  repoRoot,
  paths,
  result,
  families,
  onRawPersisted = () => {},
  crashHook = () => {},
  writeToFd = writeSync,
) {
  const output = resultOutput(result);
  if (result?.evidencePersisted === true) {
    readWorkPath(repoRoot, paths.rawPath, { expect: 'work-output', family: families.raw });
    let degraded = result.degraded === true;
    try {
      readWorkPath(repoRoot, paths.readablePath, { expect: 'work-output', family: families.readable });
    } catch {
      degraded = true;
    }
    return Object.freeze({ output, degraded });
  }
  const raw = typeof result?.raw === 'string' ? result.raw : output;
  writeImmutableBytes(repoRoot, paths.rawPath, families.raw, raw, crashHook, writeToFd);
  onRawPersisted();
  let degraded = false;
  let readableWritten = false;
  crashHook(`before-immutable-artifact:${families.readable}`);
  try {
    const readable = typeof result?.readable === 'string' ? result.readable : output;
    const durableReadable = `${output.endsWith('\n') ? output : `${output}\n`}\n${readable}`;
    writeImmutableBytes(
      repoRoot,
      paths.readablePath,
      families.readable,
      durableReadable,
      () => {},
      writeToFd,
    );
    readableWritten = true;
  } catch {
    degraded = true;
  }
  if (readableWritten) crashHook(`after-immutable-artifact:${families.readable}`);
  return Object.freeze({ output, degraded });
}

function safeRepoPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value
    || value.startsWith('/') || value.includes('\\')
    || value.split('/').some((part) => part === '' || part === '.' || part === '..')
    || /[\r\n\0]/u.test(value)) {
    fail('INVALID_CHILD_ENVELOPE', `${label} is not a confined repo-relative path`);
  }
  return value;
}

function parseChildEnvelope(text, { expectedArtifact, reviewer = false } = {}) {
  if (typeof text !== 'string') fail('INVALID_CHILD_ENVELOPE', 'child response must be text');
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (lines.length !== 4) fail('INVALID_CHILD_ENVELOPE', 'child response must contain exactly four fields');
  const names = ['status', 'artifact', 'changed-paths', 'signals'];
  const values = {};
  for (const [index, name] of names.entries()) {
    const prefix = `${name}: `;
    if (!lines[index].startsWith(prefix) || lines[index].length === prefix.length) {
      fail('INVALID_CHILD_ENVELOPE', `child response field ${index + 1} must be '${name}'`);
    }
    values[name] = lines[index].slice(prefix.length);
  }
  const statuses = reviewer
    ? ['DONE']
    : ['DONE', 'DONE_WITH_CONCERNS', 'BLOCKED', 'NEEDS_CONTEXT'];
  if (!statuses.includes(values.status)) fail('INVALID_CHILD_ENVELOPE', 'child status is not allowed');
  const artifact = safeRepoPath(values.artifact, 'artifact');
  if (artifact !== expectedArtifact) {
    fail('INVALID_CHILD_ENVELOPE', `child artifact must be '${expectedArtifact}'`);
  }
  const changedPaths = values['changed-paths'] === 'none'
    ? []
    : values['changed-paths'].split(', ').map((path) => safeRepoPath(path, 'changed path'));
  if (new Set(changedPaths).size !== changedPaths.length) {
    fail('INVALID_CHILD_ENVELOPE', 'child changed paths must be unique');
  }
  nonEmptyLine(values.signals, 'signals');
  return Object.freeze({
    status: values.status,
    artifact,
    changedPaths: Object.freeze(changedPaths),
    signals: values.signals,
  });
}

function globRegex(pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += /[\\^$.*+?()[\]{}|]/u.test(char) ? `\\${char}` : char;
    }
  }
  return new RegExp(`${source}$`, 'u');
}

function blastRadiusPasses(paths, patterns) {
  const matchers = patterns.map(globRegex);
  return paths.every((path) => matchers.some((matcher) => matcher.test(path)));
}

function samePathSet(left, right) {
  return left.length === right.length
    && [...left].sort().every((path, index) => path === [...right].sort()[index]);
}

function normalizedGitSnapshot(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    fail('INVALID_GIT_STATE', 'Git snapshot must be an object');
  }
  const head = validateGitIdentity(candidate.head);
  const indexTree = validateGitIdentity(candidate.indexTree);
  if (typeof candidate.trackedDiffDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(candidate.trackedDiffDigest)) {
    fail('INVALID_GIT_STATE', 'Git snapshot tracked diff digest must be SHA-256');
  }
  if (!Array.isArray(candidate.untracked)) fail('INVALID_GIT_STATE', 'Git snapshot untracked inventory must be an array');
  const untracked = candidate.untracked.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('INVALID_GIT_STATE', 'Git snapshot untracked entry must be an object');
    }
    const path = safeRepoPath(entry.path, 'Git untracked path');
    if (!['file', 'symlink'].includes(entry.type)) {
      fail('INVALID_GIT_STATE', 'Git snapshot untracked type must be file or symlink');
    }
    if (typeof entry.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.digest)) {
      fail('INVALID_GIT_STATE', 'Git snapshot untracked digest must be SHA-256');
    }
    return Object.freeze({ path, type: entry.type, digest: entry.digest });
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(untracked.map(({ path }) => path)).size !== untracked.length) {
    fail('INVALID_GIT_STATE', 'Git snapshot untracked paths must be unique');
  }
  return Object.freeze({ head, indexTree, trackedDiffDigest: candidate.trackedDiffDigest, untracked: Object.freeze(untracked) });
}

function captureGitSnapshot(repoRoot, git, excludePaths = []) {
  return normalizedGitSnapshot(git.snapshot(repoRoot, { excludePaths: Object.freeze([...excludePaths]) }));
}

function gitSnapshotDigest(snapshot) {
  return sha256(Buffer.from(JSON.stringify(snapshot), 'utf8'));
}

function renderDiffEvidence(baseline, result) {
  const text = typeof result === 'string' ? result : result?.text;
  if (typeof text !== 'string') fail('INVALID_GIT_STATE', 'Git diff must return text');
  const untracked = Array.isArray(result?.untracked)
    ? result.untracked.map((path) => safeRepoPath(path, 'Git untracked path')).sort()
    : [];
  const sections = [`=== branch diff: ${baseline}..working tree ===`, text.trimEnd()];
  sections.push('=== untracked path inventory ===', ...(untracked.length === 0 ? ['none'] : untracked));
  return `${sections.filter((section) => section !== '').join('\n')}\n`;
}

function createDiffEvidence(
  repoRoot,
  path,
  family,
  baseline,
  git,
  crashHook = () => {},
  writeToFd = writeSync,
) {
  const bytes = Buffer.from(renderDiffEvidence(baseline, git.diff(repoRoot, baseline)), 'utf8');
  writeImmutableBytes(repoRoot, path, family, bytes, crashHook, writeToFd);
  const persisted = readWorkPath(repoRoot, path, { expect: 'work-output', family });
  if (!Buffer.from(persisted).equals(bytes)) fail('DIFF_EVIDENCE_FAILED', 'immutable diff evidence changed during publication');
  return Object.freeze({ path, digest: sha256(persisted), bytes: persisted });
}

const REVIEW_OWNERSHIP_HEADER = '=== steepy reviewer ownership v1 ===';
const REVIEW_DIFF_HEADER = '=== reviewer-visible branch diff ===';

function reviewArtifactDescriptors(goalPath, preflight, latest) {
  return Object.freeze([
    Object.freeze({ path: goalPath, family: 'goal' }),
    Object.freeze({ path: preflight.eventsPath, family: 'events' }),
    Object.freeze({ path: preflight.ledgerPath, family: 'ledger' }),
    ...(latest?.diffPath ? [Object.freeze({ path: latest.diffPath, family: 'runner-diff' })] : []),
  ]);
}

function captureReviewArtifacts(repoRoot, descriptors) {
  return Object.freeze(descriptors.map(({ path, family }) => Object.freeze({
    path,
    family,
    digest: sha256(readWorkPath(repoRoot, path, { expect: family === 'goal' ? 'goal' : 'work-output', family })),
  })));
}

function controllerArtifactIdentity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mode, stat.nlink, stat.mtimeNs, stat.ctimeNs]
    .map(String)
    .join(':');
}

function captureControllerArtifacts(repoRoot, descriptors) {
  try {
    return Object.freeze(descriptors.map(({ path, family }) => {
      const absolute = resolve(repoRoot, path);
      const before = lstatSync(absolute, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
        fail('CONTROLLER_ARTIFACT_DRIFT', `controller artifact is not an owned regular file: ${path}`);
      }
      const bytes = readWorkPath(repoRoot, path, {
        expect: family === 'goal' ? 'goal' : 'work-output', family,
      });
      const after = lstatSync(absolute, { bigint: true });
      if (controllerArtifactIdentity(before) !== controllerArtifactIdentity(after)) {
        fail('CONTROLLER_ARTIFACT_DRIFT', `controller artifact changed while captured: ${path}`);
      }
      return Object.freeze({
        path,
        family,
        identity: controllerArtifactIdentity(after),
        digest: sha256(bytes),
      });
    }));
  } catch (error) {
    if (error instanceof LoopControllerError) throw error;
    fail('CONTROLLER_ARTIFACT_DRIFT', `controller artifact capture failed: ${error.message}`);
  }
}

function verifyControllerArtifacts(repoRoot, captured) {
  const current = captureControllerArtifacts(
    repoRoot,
    captured.map(({ path, family }) => ({ path, family })),
  );
  for (const [index, prior] of captured.entries()) {
    const next = current[index];
    if (prior.path !== next.path || prior.family !== next.family
      || prior.identity !== next.identity || prior.digest !== next.digest) {
      fail('CONTROLLER_ARTIFACT_DRIFT', `mutating child changed controller authority: ${prior.path}`);
    }
  }
}

function renderReviewerEvidence(baseline, diff, ownership) {
  return `${REVIEW_OWNERSHIP_HEADER}\n${JSON.stringify(ownership)}\n${REVIEW_DIFF_HEADER}\n`
    + renderDiffEvidence(baseline, diff);
}

function parseReviewerEvidence(bytes) {
  const text = Buffer.from(bytes).toString('utf8');
  const firstBreak = text.indexOf('\n');
  const secondBreak = text.indexOf('\n', firstBreak + 1);
  const thirdBreak = text.indexOf('\n', secondBreak + 1);
  if (firstBreak < 0 || secondBreak < 0 || thirdBreak < 0
    || text.slice(0, firstBreak) !== REVIEW_OWNERSHIP_HEADER
    || text.slice(secondBreak + 1, thirdBreak) !== REVIEW_DIFF_HEADER) {
    fail('REVIEW_OWNERSHIP_DRIFT', 'review ownership evidence header is malformed');
  }
  let ownership;
  try {
    ownership = JSON.parse(text.slice(firstBreak + 1, secondBreak));
  } catch {
    fail('REVIEW_OWNERSHIP_DRIFT', 'review ownership evidence manifest is malformed');
  }
  assertPlainObject(ownership, 'review ownership evidence');
  const keys = Object.keys(ownership).sort();
  const expectedKeys = ['afterAttempt', 'artifacts', 'review', 'runId', 'snapshotDigest', 'version'];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    fail('REVIEW_OWNERSHIP_DRIFT', 'review ownership evidence fields are not closed');
  }
  if (ownership.version !== 1 || !Number.isSafeInteger(ownership.review) || ownership.review < 1
    || (ownership.afterAttempt !== null
      && (!Number.isSafeInteger(ownership.afterAttempt) || ownership.afterAttempt < 1))
    || typeof ownership.snapshotDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(ownership.snapshotDigest)
    || !Array.isArray(ownership.artifacts)) {
    fail('REVIEW_OWNERSHIP_DRIFT', 'review ownership evidence values are invalid');
  }
  const artifacts = ownership.artifacts.map((artifact) => {
    assertPlainObject(artifact, 'review ownership artifact');
    if (Object.keys(artifact).sort().join(',') !== 'digest,family,path'
      || typeof artifact.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(artifact.digest)
      || !['goal', 'events', 'ledger', 'runner-diff'].includes(artifact.family)) {
      fail('REVIEW_OWNERSHIP_DRIFT', 'review ownership artifact fields are invalid');
    }
    return Object.freeze({
      path: safeRepoPath(artifact.path, 'review ownership artifact path'),
      family: artifact.family,
      digest: artifact.digest,
    });
  });
  return Object.freeze({
    ownership: Object.freeze({ ...ownership, artifacts: Object.freeze(artifacts) }),
    diffText: text.slice(thirdBreak + 1),
  });
}

function createReviewerEvidence({
  repoRoot,
  path,
  baseline,
  git,
  state,
  review,
  snapshot,
  artifacts,
  crashHook = () => {},
  writeToFd = writeSync,
}) {
  const ownership = Object.freeze({
    version: 1,
    runId: state.runId,
    review,
    afterAttempt: state.attempts.at(-1)?.attempt ?? null,
    snapshotDigest: gitSnapshotDigest(snapshot),
    artifacts,
  });
  const bytes = Buffer.from(renderReviewerEvidence(baseline, git.diff(repoRoot, baseline), ownership), 'utf8');
  writeImmutableBytes(repoRoot, path, 'reviewer-diff', bytes, crashHook, writeToFd);
  const persisted = readWorkPath(repoRoot, path, { expect: 'work-output', family: 'reviewer-diff' });
  if (!persisted.equals(bytes)) fail('DIFF_EVIDENCE_FAILED', 'review evidence changed during publication');
  return Object.freeze({ path, digest: sha256(persisted), bytes: persisted });
}

function verifyReviewerOwnership({
  repoRoot,
  paths,
  goalPath,
  preflight,
  state,
  review,
  git,
}) {
  const bytes = readWorkPath(repoRoot, paths.diffPath, {
    expect: 'work-output', family: 'reviewer-diff',
  });
  const { ownership, diffText } = parseReviewerEvidence(bytes);
  const latest = state.attempts.at(-1) ?? null;
  if (ownership.runId !== state.runId || ownership.review !== review
    || ownership.afterAttempt !== (latest?.attempt ?? null)) {
    fail('REVIEW_OWNERSHIP_DRIFT', 'review ownership identity does not match event replay');
  }
  const descriptors = reviewArtifactDescriptors(goalPath, preflight, latest);
  if (ownership.artifacts.length !== descriptors.length
    || ownership.artifacts.some((artifact, index) => (
      artifact.path !== descriptors[index].path || artifact.family !== descriptors[index].family
    ))) {
    fail('REVIEW_OWNERSHIP_DRIFT', 'review ownership artifact inventory does not match event replay');
  }
  for (const artifact of ownership.artifacts) {
    const bytesNow = readWorkPath(repoRoot, artifact.path, {
      expect: artifact.family === 'goal' ? 'goal' : 'work-output', family: artifact.family,
    });
    if (sha256(bytesNow) !== artifact.digest) {
      fail('REVIEW_OWNERSHIP_DRIFT', `review-visible workflow artifact drifted: ${artifact.path}`);
    }
  }
  const reviewerOutputs = [paths.reportPath, paths.rawPath, paths.readablePath, paths.diffPath];
  const snapshot = captureGitSnapshot(repoRoot, git, reviewerOutputs);
  if (gitSnapshotDigest(snapshot) !== ownership.snapshotDigest) {
    fail('REVIEW_OWNERSHIP_DRIFT', 'reviewer branch snapshot drifted from controller ownership');
  }
  if (diffText !== renderDiffEvidence(state.baseline, git.diff(repoRoot, state.baseline))) {
    fail('REVIEW_OWNERSHIP_DRIFT', 'reviewer branch diff drifted from controller ownership');
  }
  return Object.freeze({ bytes, digest: sha256(bytes), snapshot });
}

function readBoundDiffEvidence(repoRoot, path, family, expectedDigest) {
  const bytes = readWorkPath(repoRoot, path, { expect: 'work-output', family });
  if (sha256(bytes) !== expectedDigest) fail('DIFF_DRIFT', 'immutable diff evidence digest mismatch');
  return bytes;
}

function captureLoopDiff(repoRoot, diffPath, baseline, git, crashHook = () => {}) {
  crashHook('before-immutable-artifact:branch-diff');
  const bytes = Buffer.from(renderDiffEvidence(baseline, git.diff(repoRoot, baseline)), 'utf8');
  writeWorkPath(repoRoot, diffPath, bytes, {
    expect: 'work-output', family: 'diff',
  });
  crashHook('after-immutable-artifact:branch-diff');
  const persisted = readWorkPath(repoRoot, diffPath, { expect: 'work-output', family: 'diff' });
  if (!persisted.equals(bytes)) fail('DIFF_EVIDENCE_FAILED', 'final diff changed during publication');
  return Object.freeze({ path: diffPath, digest: sha256(persisted), bytes: persisted });
}

function consumeGoal(repoRoot, goalPath, ledgerPath) {
  const goal = readWorkPath(repoRoot, goalPath, { expect: 'goal', family: 'goal', encoding: 'utf8' });
  const ready = 'phase: goal-contract\nstatus: READY\nnext: loop-engineer\nsource: none\nconsumed-by: none';
  const consumed = `phase: goal-contract\nstatus: CONSUMED\nnext: loop-engineer\nsource: none\nconsumed-by: ${ledgerPath}`;
  if (goal.includes(consumed)) return;
  if (!goal.includes(ready)) fail('GOAL_DRIFT', 'goal is not READY for terminal consumption');
  writeWorkPath(repoRoot, goalPath, goal.replace(ready, consumed), {
    expect: 'goal', family: 'goal',
  });
}

function buildImplementerPrompt({
  contract, goalPath, reportPath, lastFailure, ledgerDigest, routing, modelTier,
}) {
  return IMPLEMENTER_PROMPT
    .replaceAll('[GOAL_FILE]', goalPath)
    .replaceAll('[SURFACE]', contract.surface)
    .replaceAll('[ROUTING_INDEX]', routing.routingPath)
    .replaceAll('[STANDARD_INPUTS]', routing.standardPaths.map((path) => `- ${path}`).join('\n'))
    .replaceAll('[MODEL_TIER]', modelTier)
    .replaceAll('[LAST_FAILURE]', lastFailure || 'none')
    .replaceAll('[LEDGER_DIGEST]', ledgerDigest)
    .replaceAll('[REPORT_FILE]', reportPath);
}

function buildReviewerPrompt({
  contract, goalPath, diffPath, ledgerPath, reportPath, routing, modelTier,
}) {
  return `${REVIEWER_PROMPT
    .replaceAll('[GOAL_FILE]', goalPath)
    .replaceAll('[DIFF_FILE]', diffPath)
    .replaceAll('[LEDGER_FILE]', ledgerPath)
    .replaceAll('[SURFACE]', contract.surface)
    .replaceAll('[ROUTING_INDEX]', routing.routingPath)
    .replaceAll('[STANDARD_INPUTS]', routing.standardPaths.map((path) => `- ${path}`).join('\n'))
    .replaceAll('[MODEL_TIER]', modelTier)}

Write the full review to ${reportPath}, then return exactly four fields:
status: DONE
artifact: ${reportPath}
changed-paths: none
signals: approved | issues-found
`;
}

function dispatchTier(state) {
  return state.reviewHistory.some(({ approved }) => approved === false)
    ? 'most-capable'
    : 'standard';
}

function modelRoutingEvidence(descriptor, modelTier, label) {
  if (descriptor === null || descriptor === undefined) {
    fail('RUNNER_UNAVAILABLE', `${label} descriptor is unavailable`);
  }
  if (descriptor.requestedModelTier !== modelTier) {
    fail('MODEL_TIER_MISMATCH', `${label} descriptor does not match prompt tier '${modelTier}'`);
  }
  if (descriptor.modelSelection === 'applied') {
    nonEmptyLine(descriptor.resolvedModel, `${label} resolved model`);
    return Object.freeze({
      modelTier,
      modelSelection: 'applied',
      resolvedModel: descriptor.resolvedModel,
      degradationReason: null,
    });
  }
  if (descriptor.modelSelection === 'degraded') {
    return Object.freeze({
      modelTier,
      modelSelection: 'degraded',
      resolvedModel: null,
      degradationReason: nonEmptyLine(descriptor.degradationReason, `${label} degradation reason`),
    });
  }
  fail('MODEL_TIER_MISMATCH', `${label} descriptor lacks a closed model selection`);
}

function reviewerModelEvidence(result, modelTier) {
  if (result?.descriptor !== undefined) {
    return modelRoutingEvidence(result.descriptor, modelTier, 'reviewer');
  }
  return Object.freeze({
    modelTier,
    modelSelection: 'degraded',
    resolvedModel: null,
    degradationReason: 'Injected reviewer did not expose a verifiable model descriptor.',
  });
}

function reviewerApproval(report, envelope) {
  const approved = /^\*\*Status:\*\* Approved$/mu.test(report);
  const issues = /^\*\*Status:\*\* Issues Found$/mu.test(report);
  if (approved === issues) fail('INVALID_REVIEW', 'review report must contain one closed status');
  if (envelope.changedPaths.length !== 0) fail('INVALID_REVIEW', 'reviewer must be read-only');
  if (envelope.signals !== (approved ? 'approved' : 'issues-found')) {
    fail('INVALID_REVIEW', 'review signal conflicts with review artifact');
  }
  return approved;
}

function metricImproves(direction, candidate, best) {
  return direction === 'min' ? candidate < best : candidate > best;
}

function assertDependencies(options) {
  if (!options.runner || typeof options.runner.descriptor !== 'function') {
    fail('INVALID_DEPENDENCY', 'runner descriptor builder must be injected');
  }
  if (!options.reviewer || typeof options.reviewer.run !== 'function') {
    fail('INVALID_DEPENDENCY', 'reviewer must be injected');
  }
  if (!options.git || !['branch', 'status', 'baseline'].every((name) => typeof options.git[name] === 'function')) {
    fail('INVALID_DEPENDENCY', 'Git adapter branch/status/baseline methods must be injected');
  }
  if (typeof options.clock !== 'function' || typeof options.uuid !== 'function'
    || typeof options.crashHook !== 'function') {
    fail('INVALID_DEPENDENCY', 'clock, UUID source, and crash hook must be injected');
  }
  if (options.lockTransitionHook !== undefined && typeof options.lockTransitionHook !== 'function') {
    fail('INVALID_DEPENDENCY', 'lock transition hook must be a function when supplied');
  }
  for (const name of ['initialWrite', 'immutableWrite']) {
    if (options[name] !== undefined && typeof options[name] !== 'function') {
      fail('INVALID_DEPENDENCY', `${name} must be a function when supplied`);
    }
  }
}

function assertPolicyDependencies(options) {
  if (typeof options.runner.run !== 'function') {
    fail('INVALID_DEPENDENCY', 'runner.run must be injected');
  }
  const gitMethods = [
    'head', 'diff', 'changedPaths', 'snapshot', 'prepareCommit', 'inspectCommit', 'commit',
    'ownsAttempt', 'discard',
  ];
  if (!gitMethods.every((name) => typeof options.git[name] === 'function')) {
    fail('INVALID_DEPENDENCY', `Git policy adapter requires ${gitMethods.join(', ')}`);
  }
}

export async function runLoopController(goalPath, options = {}) {
  assertPlainObject(options, 'controller options');
  assertDependencies(options);
  if (options.startOnly !== true) assertPolicyDependencies(options);
  const repoRoot = options.repoRoot;
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) fail('INVALID_INPUT', 'repoRoot is required');

  let goalBytes;
  try {
    goalBytes = readWorkPath(repoRoot, goalPath, { expect: 'goal', family: 'goal' });
  } catch (error) {
    fail('INVALID_GOAL_PATH', error.message);
  }
  const expectedPaths = derivedPaths(goalPath);
  const goalEntry = goalForEntry(goalBytes.toString('utf8'), {
    resume: options.resume === true,
    ledgerPath: expectedPaths.ledgerPath,
  });
  const canonicalGoalBytes = Buffer.from(goalEntry.canonicalText, 'utf8');
  const contract = parseGoalContract(goalEntry.canonicalText);
  const identity = goalIdentity(contract, canonicalGoalBytes);
  const routing = resolveLoopRouting(
    repoRoot,
    contract.surface,
    options.routingPath,
    options.standardPaths,
  );
  const availabilityTier = 'standard';
  const runnerDescriptor = options.runner.descriptor(
    options.harness,
    'Execute the bounded Gear-4 goal contract.',
    { modelTier: availabilityTier },
  );
  modelRoutingEvidence(runnerDescriptor, availabilityTier, 'runner availability');
  const branch = options.git.branch(repoRoot);
  const dirty = options.git.status(repoRoot) !== '';
  const preflight = validateLoopPreflight({
    goalPath,
    ledgerPath: options.ledgerPath,
    resume: options.resume === true,
    commitAuthorized: options.commitAuthorized,
    harness: options.harness,
    contract,
    branch,
    dirty,
    expectedBranch: options.expectedBranch,
    routing,
    runnerDescriptor,
  });

  const priorEvents = optionalWorkBytes(repoRoot, preflight.eventsPath, 'events');
  const priorLedger = optionalWorkBytes(repoRoot, preflight.ledgerPath, 'ledger');
  let eventBytes;
  let state;
  let runId;
  let timestamp;
  let baseline;
  let resumeHazard = null;
  let parsedEvents = null;
  if (preflight.resume) {
    if (priorEvents === null) {
      fail('INVALID_RESUME', 'resume requires the canonical events.jsonl state authority');
    }
    parsedEvents = parseWorkflowJsonl(priorEvents);
    state = reduceWorkflowJsonl(priorEvents);
    eventBytes = priorEvents;
    runId = validateRunId(state.runId);
    if (state.branch !== branch) {
      resumeHazard = `recorded branch '${state.branch}', got '${branch}'`;
    } else if (options.expectedBranch !== undefined && branch !== options.expectedBranch) {
      resumeHazard = `expected branch '${options.expectedBranch}', got '${branch}'`;
    }
    assertGoalIdentity(state, identity);
    if (goalEntry.consumed) {
      if (state.executionTerminal === true && state.phase === 'TERMINAL_RECORDED') {
        validateTerminalState(state);
      } else if (state.phase === 'RUN_HALTED') {
        const terminalIndex = parsedEvents.findIndex(({ event }) => event === 'TERMINAL_RECORDED');
        if (terminalIndex < 0) {
          fail('INVALID_RESUME', 'a CONSUMED halted goal requires a valid terminal event prefix');
        }
        validateTerminalState(reduceWorkflowJsonl(
          parsedEvents.slice(0, terminalIndex + 1).map((event) => `${JSON.stringify(event)}\n`).join(''),
        ));
      } else {
        fail('INVALID_RESUME', 'a CONSUMED goal requires a terminal or terminal-then-halted event replay');
      }
    }
  } else {
    if (priorEvents !== null || priorLedger !== null) {
      fail('EXISTING_MACHINE_STATE', 'fresh entry rejects existing events or ledger state');
    }
    runId = validateRunId(options.uuid());
    timestamp = validateTimestamp(options.clock());
  }

  const lockToken = validateRunId(options.uuid());
  let observation;
  if (!preflight.resume) {
    options.crashHook('before-verifier-result');
    observation = verifierObservation(contract, options.verifier, repoRoot);
    options.crashHook('after-verifier-result');
  }
  const releaseLock = acquireLoopLock(
    repoRoot,
    preflight.loopDir,
    lockToken,
    options.processProbe,
    options.lockTransitionHook,
  );
  try {
    options.crashHook('after-lock');
    if (preflight.resume) {
      observation = Object.freeze({
        status: state.baselineVerifier.exit,
        stdout: '',
        stderr: '',
        metric: state.baselineVerifier.metric,
      });
    } else {
      const lockedBranch = options.git.branch(repoRoot);
      if (lockedBranch !== branch || options.git.status(repoRoot) !== '') {
        fail('PREFLIGHT_DRIFT', 'branch or clean-tree state changed during sanity verification');
      }
      baseline = validateGitIdentity(options.git.baseline(repoRoot));
    }
    if (!preflight.resume) {
      const event = {
        schemaVersion: WORKFLOW_EVENT_SCHEMA_VERSION,
        sequence: 1,
        runId,
        timestamp,
        event: 'RUN_STARTED',
        branch,
        baseline,
        mode: contract.mode,
        budget: contract.budget,
        controllerCommitAuthorized: true,
        goalDigest: identity.goalDigest,
        verifier: identity.verifier,
        verifierArgv: identity.verifierArgv,
        metricDirection: identity.metricDirection,
        blastRadius: identity.blastRadius,
        baselineExit: observation.status,
        baselinePassed: contract.mode === 'BOOLEAN' ? observation.status === 0 : true,
        baselineMetric: observation.metric,
      };
      options.crashHook('before-run-started');
      eventBytes = writeEventStream(
        repoRoot,
        preflight.eventsPath,
        event,
        options.crashHook,
        options.initialWrite ?? writeSync,
      );
      options.crashHook('after-run-started');
      state = reduceWorkflowJsonl(eventBytes);
    }
    const writeLedger = () => {
      const currentEventBytes = readWorkPath(repoRoot, preflight.eventsPath, {
        expect: 'work-output', family: 'events',
      });
      options.crashHook('before-ledger-render');
      const ledger = renderLedger({
        goalPath,
        eventBytes: currentEventBytes,
        state,
      });
      options.crashHook('after-ledger-render');
      options.crashHook('before-ledger-transition');
      writeWorkPath(repoRoot, preflight.ledgerPath, ledger, {
        expect: 'work-output',
        family: 'ledger',
      });
      options.crashHook('after-ledger-transition');
    };
    if (options.startOnly === true) {
      if (!state.executionTerminal) {
        writeLedger();
        options.crashHook('after-ledger');
      }
      return Object.freeze({
        status: preflight.resume ? 'RESUMED' : 'STARTED',
        runId,
        eventsPath: preflight.eventsPath,
        ledgerPath: preflight.ledgerPath,
        verifier: observation,
        runnerDescriptor,
      });
    }

    let observabilityDegraded = state.observabilityDegraded;
    let lastFailure = observation.stderr || observation.stdout || 'none';

    const terminalResult = (outcome) => Object.freeze({
      status: outcome,
      outcome,
      runId: state.runId,
      attempts: state.reservedAttempts.length,
      eventsPath: preflight.eventsPath,
      ledgerPath: preflight.ledgerPath,
      diffPath: preflight.diffPath,
      handoff: Object.freeze({ goal: goalPath, 'loop-ledger': preflight.ledgerPath }),
    });

    const finishTerminalProjections = (outcome) => {
      validateTerminalState(state);
      if (state.terminalEvidence === null) {
        fail('INVALID_TERMINAL_PROJECTION', 'terminal event lacks final diff and Git evidence');
      }
      const finalBytes = readBoundDiffEvidence(
        repoRoot,
        state.terminalEvidence.diffPath,
        'diff',
        state.terminalEvidence.diffDigest,
      );
      const expectedBytes = Buffer.from(
        renderDiffEvidence(state.baseline, options.git.diff(repoRoot, state.baseline)),
        'utf8',
      );
      if (!finalBytes.equals(expectedBytes)) {
        fail('INVALID_TERMINAL_PROJECTION', 'final diff no longer matches the retained branch');
      }
      options.crashHook('before-goal-transition');
      consumeGoal(repoRoot, goalPath, preflight.ledgerPath);
      options.crashHook('after-goal-transition');
      options.crashHook('after-goal-consumed');
      writeLedger();
      options.crashHook('after-ledger-ready');
      return terminalResult(outcome);
    };

    const appendState = (event, fields = {}) => {
      state = appendWorkflowEvent(
        repoRoot,
        preflight.eventsPath,
        state,
        options.clock,
        event,
        fields,
        options.crashHook,
      );
      return state;
    };
    const haltedResult = () => Object.freeze({
      status: 'HALTED',
      outcome: null,
      runId: state.runId,
      attempts: state.reservedAttempts.length,
      eventsPath: preflight.eventsPath,
      ledgerPath: preflight.ledgerPath,
    });
    const reconciliationHalt = (reason) => {
      if (state.phase !== 'RECONCILIATION_REQUIRED') {
        appendState('RECONCILIATION_REQUIRED', {
          attempt: state.currentAttempt,
          reason,
          observabilityDegraded,
        });
      }
      appendState('RUN_HALTED', {
        attempt: state.currentAttempt,
        reason,
        observabilityDegraded: state.observabilityDegraded,
      });
      writeLedger();
      return haltedResult();
    };
    const stableReplayState = () => {
      const latest = state.attempts.at(-1) ?? null;
      const expectedHead = latest === null
        ? state.baseline
        : latest.disposition === 'COMMIT'
          ? latest.commit
          : latest.expectedParent;
      return validateGitIdentity(options.git.head(repoRoot)) === expectedHead
        && options.git.status(repoRoot) === '';
    };

    if (state.phase === 'RUN_HALTED') {
      writeLedger();
      return haltedResult();
    }
    if (resumeHazard !== null) return reconciliationHalt(`branch drift: ${resumeHazard}`);
    if (state.phase === 'RECONCILIATION_REQUIRED') {
      appendState('RUN_HALTED', {
        attempt: state.currentAttempt,
        reason: state.reconciliation.reason,
        observabilityDegraded: state.observabilityDegraded,
      });
      writeLedger();
      return haltedResult();
    }
    if (state.executionTerminal) {
      if (!stableReplayState()) {
        return reconciliationHalt('terminal replay has ambiguous branch, HEAD, or dirty-tree state');
      }
      return finishTerminalProjections(state.terminalOutcome);
    }

    // The ledger is a projection only. Re-render it from events before it can
    // participate in reviewer ownership verification, replacing missing or
    // stale projection bytes without consulting them as state.
    writeLedger();
    options.crashHook('after-ledger');

    let abandonedReview = (state.reviewHistory.at(-1)?.review ?? 0) + 1;
    for (;;) {
      const paths = reviewPaths(preflight.loopDir, state.runId, abandonedReview);
      const evidence = [
        optionalWorkBytes(repoRoot, paths.reportPath, 'reviewer-report'),
        optionalWorkBytes(repoRoot, paths.rawPath, 'reviewer-raw'),
        optionalWorkBytes(repoRoot, paths.readablePath, 'reviewer-log'),
        optionalWorkBytes(repoRoot, paths.diffPath, 'reviewer-diff'),
      ];
      if (evidence.every((value) => value === null)) break;
      try {
        if (evidence[3] === null) {
          fail('REVIEW_OWNERSHIP_DRIFT', 'abandoned reviewer has no durable ownership evidence');
        }
        verifyReviewerOwnership({
          repoRoot,
          paths,
          goalPath,
          preflight,
          state,
          review: abandonedReview,
          git: options.git,
        });
        if (evidence[0] !== null || evidence[1] !== null || evidence[2] !== null) {
          fail(
            'REVIEW_OWNERSHIP_DRIFT',
            'review artifacts have no event-backed completion authority',
          );
        }
      } catch (error) {
        return reconciliationHalt(`abandoned reviewer ownership drift: ${error.message}`);
      }
      abandonedReview += 1;
    }

    const readyForReview = () => {
      const attempt = state.attempts.at(-1) ?? null;
      if (attempt === null) {
        return state.mode === 'BOOLEAN'
          && state.phase === 'RUN_STARTED'
          && state.baselineVerifier?.passed === true;
      }
      if (!['COMMIT_RECORDED', 'DISCARD_RECORDED'].includes(state.phase)) return false;
      if (attempt.verdict === 'GOAL_REACHED') return true;
      if (state.mode === 'METRIC' && attempt.verdict === 'KEEP') return true;
      if (state.reservedAttempts.length === state.budget) return true;
      const priorReview = state.reviewHistory.at(-1);
      return priorReview?.approved === false
        && attempt.attempt > (priorReview.afterAttempt ?? 0);
    };

    const ownershipFor = (attemptState) => Object.freeze({
      runId: state.runId,
      attempt: attemptState.attempt,
      expectedParent: attemptState.expectedParent,
      changedPaths: Object.freeze([...(attemptState.changedPaths ?? [])]),
      snapshot: attemptState.discardSnapshot ?? null,
      snapshotDigest: attemptState.snapshotDigest,
      owner: 'steepy-loop-engineer-v1',
    });
    const attemptStillOwned = (attemptState, requireBlastPass = true) => {
      if (attemptState?.snapshotDigest === null || attemptState?.changedPaths === null) return false;
      const ownership = ownershipFor(attemptState);
      const current = captureGitSnapshot(repoRoot, options.git);
      return current.head === ownership.expectedParent
        && gitSnapshotDigest(current) === ownership.snapshotDigest
        && samePathSet(
          options.git.changedPaths(repoRoot).map((path) => safeRepoPath(path, 'Git changed path')),
          ownership.changedPaths,
        )
        && (!requireBlastPass || blastRadiusPasses(ownership.changedPaths, contract.blastRadius))
        && options.git.ownsAttempt(repoRoot, ownership) === true;
    };

    for (;;) {
      if (['RUN_STARTED', 'COMMIT_RECORDED', 'DISCARD_RECORDED', 'REVIEW_COMPLETED'].includes(state.phase)) {
        if (!stableReplayState()) {
          return reconciliationHalt('stable replay prefix has ambiguous branch or dirty-tree state');
        }
      }
      if (state.phase === 'REVIEW_COMPLETED' && selectTerminalOutcome(state) !== null) {
        const outcome = selectTerminalOutcome(state);
        const finalDiff = captureLoopDiff(
          repoRoot,
          preflight.diffPath,
          state.baseline,
          options.git,
          options.crashHook,
        );
        options.crashHook('after-final-diff');
        const terminalSnapshot = captureGitSnapshot(repoRoot, options.git);
        options.crashHook('before-terminal-event');
        appendState('TERMINAL_RECORDED', {
          outcome,
          diffPath: finalDiff.path,
          diffDigest: finalDiff.digest,
          head: terminalSnapshot.head,
          snapshotDigest: gitSnapshotDigest(terminalSnapshot),
        });
        options.crashHook('after-terminal-event');
        options.crashHook('after-terminal-recorded');
        return finishTerminalProjections(outcome);
      }

      if (readyForReview()) {
        const latest = state.attempts.at(-1) ?? null;
        let reviewNumber = (state.reviewHistory.at(-1)?.review ?? 0) + 1;
        let paths = reviewPaths(preflight.loopDir, state.runId, reviewNumber);
        while ([
          optionalWorkBytes(repoRoot, paths.reportPath, 'reviewer-report'),
          optionalWorkBytes(repoRoot, paths.rawPath, 'reviewer-raw'),
          optionalWorkBytes(repoRoot, paths.readablePath, 'reviewer-log'),
          optionalWorkBytes(repoRoot, paths.diffPath, 'reviewer-diff'),
        ].some((value) => value !== null)) {
          reviewNumber += 1;
          paths = reviewPaths(preflight.loopDir, state.runId, reviewNumber);
        }
        if (latest?.diffPath) {
          readBoundDiffEvidence(repoRoot, latest.diffPath, 'runner-diff', latest.diffDigest);
        }
        const reviewerOutputs = [paths.reportPath, paths.rawPath, paths.readablePath, paths.diffPath];
        const reviewSnapshot = captureGitSnapshot(repoRoot, options.git, reviewerOutputs);
        const artifacts = captureReviewArtifacts(
          repoRoot,
          reviewArtifactDescriptors(goalPath, preflight, latest),
        );
        const boundDiff = createReviewerEvidence({
          repoRoot,
          path: paths.diffPath,
          baseline: state.baseline,
          git: options.git,
          state,
          review: reviewNumber,
          snapshot: reviewSnapshot,
          artifacts,
          crashHook: options.crashHook,
          writeToFd: options.immutableWrite ?? writeSync,
        });
        const modelTier = dispatchTier(state);
        const prompt = buildReviewerPrompt({
          contract,
          goalPath,
          diffPath: boundDiff.path,
          ledgerPath: preflight.ledgerPath,
          reportPath: paths.reportPath,
          routing,
          modelTier,
        });
        const reviewHead = validateGitIdentity(options.git.head(repoRoot));
        options.crashHook('before-loop-branch-review');
        const reviewResult = await options.reviewer.run(prompt, {
          cwd: repoRoot,
          harness: options.harness,
          runId: state.runId,
          review: reviewNumber,
          reportPath: paths.reportPath,
          rawPath: paths.rawPath,
          readablePath: paths.readablePath,
          diffPath: boundDiff.path,
          modelTier,
          routingPath: routing.routingPath,
          standardPaths: routing.standardPaths,
        });
        options.crashHook('after-loop-branch-review');
        const reviewModel = reviewerModelEvidence(reviewResult, modelTier);
        observabilityDegraded ||= reviewModel.modelSelection === 'degraded';
        const persisted = persistChildEvidence(
          repoRoot,
          paths,
          reviewResult,
          { raw: 'reviewer-raw', readable: 'reviewer-log' },
          () => {},
          options.crashHook,
          options.immutableWrite ?? writeSync,
        );
        observabilityDegraded ||= persisted.degraded || reviewResult?.degraded === true;
        const reportBytes = readWorkPath(repoRoot, paths.reportPath, {
          expect: 'work-output', family: 'reviewer-report',
        });
        const report = reportBytes.toString('utf8');
        if (reviewResult === null || reviewResult.error || reviewResult.status !== 0) {
          fail('REVIEW_FAILED', 'reviewer did not complete successfully');
        }
        const afterReviewSnapshot = captureGitSnapshot(repoRoot, options.git, reviewerOutputs);
        const afterReviewHead = validateGitIdentity(options.git.head(repoRoot));
        if (afterReviewHead !== reviewHead
          || gitSnapshotDigest(afterReviewSnapshot) !== gitSnapshotDigest(reviewSnapshot)) {
          fail('REVIEW_MUTATED', 'whole-branch reviewer violated its read-only contract');
        }
        const verifiedReview = verifyReviewerOwnership({
          repoRoot,
          paths,
          goalPath,
          preflight,
          state,
          review: reviewNumber,
          git: options.git,
        });
        if (verifiedReview.digest !== boundDiff.digest) {
          fail('REVIEW_OWNERSHIP_DRIFT', 'review evidence digest changed during execution');
        }
        const envelope = parseChildEnvelope(persisted.output, {
          expectedArtifact: paths.reportPath,
          reviewer: true,
        });
        const approved = reviewerApproval(report, envelope);
        options.crashHook(`after-review-${reviewNumber}-evidence`);
        appendState('REVIEW_COMPLETED', {
          approved,
          review: reviewNumber,
          attempt: latest?.attempt ?? null,
          diffPath: boundDiff.path,
          diffDigest: boundDiff.digest,
          reportPath: paths.reportPath,
          reportDigest: sha256(reportBytes),
          observabilityDegraded,
          ...reviewModel,
        });
        options.crashHook(`after-review-${reviewNumber}-completed`);
        if (selectTerminalOutcome(state) === null) {
          lastFailure = approved ? lastFailure : report;
          writeLedger();
          continue;
        }
        continue;
      }

      const active = state.attempts.at(-1) ?? null;
      if (state.phase === 'COMMIT_INTENT') {
        let proof;
        try {
          const observed = options.git.inspectCommit(repoRoot, {
            commit: state.pendingCommit.commit,
            runId: state.runId,
            attempt: state.pendingCommit.attempt,
            reservedAt: active.reservedAt,
            expectedParent: active.expectedParent,
            changedPaths: Object.freeze([...active.changedPaths]),
            snapshotDigest: active.snapshotDigest,
            blastRadius: state.blastRadius,
            owner: 'steepy-loop-engineer-v1',
          });
          const snapshot = captureGitSnapshot(repoRoot, options.git);
          proof = classifyCommitReconciliation(state, {
            ...observed,
            snapshotDigest: gitSnapshotDigest(snapshot),
          });
        } catch (error) {
          return reconciliationHalt(`commit intent cannot be proven uniquely: ${error.message}`);
        }
        if (proof.classification === 'AMBIGUOUS_GIT_STATE') {
          return reconciliationHalt(`commit intent cannot be proven uniquely: ${proof.reason}`);
        }
        if (['SAFE_PENDING_CONTROLLER_COMMIT', 'SAFE_PARTIAL_CONTROLLER_COMMIT'].includes(
          proof.classification,
        )) {
          options.crashHook('before-git-commit');
          const committed = options.git.commit(repoRoot, {
            commit: proof.commit,
            expectedParent: proof.expectedParent,
            metadata: Object.freeze({
              runId: state.runId,
              attempt: proof.attempt,
              expectedParent: proof.expectedParent,
              owner: 'steepy-loop-engineer-v1',
            }),
          }, options.crashHook);
          if (committed !== proof.commit) {
            return reconciliationHalt('controller commit result does not match its durable intent');
          }
          options.crashHook('after-git-commit');
        }
        appendState('COMMIT_RECORDED', {
          attempt: state.pendingCommit.attempt,
          commit: state.pendingCommit.commit,
        });
        writeLedger();
        continue;
      }

      if (state.phase === 'DISCARD_INTENT') {
        const currentSnapshot = captureGitSnapshot(repoRoot, options.git);
        const restored = currentSnapshot.head === active.expectedParent
          && gitSnapshotDigest(currentSnapshot) === active.reservationSnapshotDigest;
        if (!restored) {
          const ownership = ownershipFor(active);
          const owned = attemptStillOwned(active, active.blastRadiusPassed === true);
          const partial = !owned && typeof options.git.inspectDiscard === 'function'
            && options.git.inspectDiscard(repoRoot, ownership) === 'SAFE_PARTIAL_DISCARD';
          if (!owned && !partial) {
            return reconciliationHalt('discard intent snapshot is ambiguous; resume will not clean it');
          }
          options.crashHook('before-git-discard');
          const restoredParent = options.git.discard(repoRoot, ownership, options.crashHook);
          if (restoredParent !== active.expectedParent) {
            return reconciliationHalt('discard did not restore the expected parent');
          }
          options.crashHook('after-git-discard');
        }
        appendState('DISCARD_RECORDED', { attempt: active.attempt });
        lastFailure = active.blastRadiusPassed === false ? 'blast radius exceeded' : lastFailure;
        writeLedger();
        continue;
      }

      if (state.phase === 'VERIFIER_RECORDED') {
        if (active.verdict === 'DISCARD') {
          if (!attemptStillOwned(active)) {
            return reconciliationHalt('non-improvement snapshot drift is not safely controller-owned');
          }
          options.crashHook('before-discard-intent');
          appendState('DISCARD_INTENT', {
            attempt: active.attempt,
            snapshot: captureGitSnapshot(repoRoot, options.git),
          });
          options.crashHook('after-discard-intent');
          continue;
        }
        let keepOwned = false;
        try {
          readBoundDiffEvidence(repoRoot, active.diffPath, 'runner-diff', active.diffDigest);
          keepOwned = attemptStillOwned(active);
        } catch {
          keepOwned = false;
        }
        if (!keepOwned) {
          return reconciliationHalt('KEEP snapshot, changed-path, or blast-radius drift is not safely controller-owned');
        }
        const metadata = Object.freeze({
          runId: state.runId,
          attempt: active.attempt,
          reservedAt: active.reservedAt,
          expectedParent: active.expectedParent,
          changedPaths: Object.freeze([...active.changedPaths]),
          snapshotDigest: active.snapshotDigest,
          blastRadius: contract.blastRadius,
          owner: 'steepy-loop-engineer-v1',
        });
        const prepared = options.git.prepareCommit(repoRoot, metadata);
        if (prepared === null || typeof prepared !== 'object'
          || validateGitIdentity(prepared.commit) !== prepared.commit
          || prepared.expectedParent !== active.expectedParent) {
          return reconciliationHalt('prepared commit does not preserve the expected parent');
        }
        options.crashHook('before-commit-intent');
        appendState('COMMIT_INTENT', { attempt: active.attempt, commit: prepared.commit });
        options.crashHook('after-commit-intent');
        continue;
      }

      if (state.phase === 'BLAST_RADIUS_CHECKED') {
        if (active.blastRadiusPassed === false) {
          if (!attemptStillOwned(active, false)) {
            return reconciliationHalt('blast-radius violation snapshot drift is not safely controller-owned');
          }
          options.crashHook('before-discard-intent');
          appendState('DISCARD_INTENT', {
            attempt: active.attempt,
            snapshot: captureGitSnapshot(repoRoot, options.git),
          });
          options.crashHook('after-discard-intent');
          continue;
        }
        if (!attemptStillOwned(active)) {
          return reconciliationHalt('verifier input snapshot is not safely controller-owned');
        }
        options.crashHook('before-verifier-result');
        const verification = verifierObservation(contract, options.verifier, repoRoot);
        options.crashHook('after-verifier-result');
        let verdict;
        if (contract.mode === 'BOOLEAN') {
          verdict = verification.status === 0 ? 'GOAL_REACHED' : 'KEEP';
        } else {
          const committedMetrics = state.attempts
            .slice(0, -1)
            .filter((item) => item.disposition === 'COMMIT')
            .map((item) => item.metric);
          const best = committedMetrics.reduce(
            (selected, value) => (
              metricImproves(contract.metricDirection, value, selected) ? value : selected
            ),
            state.baselineVerifier.metric,
          );
          verdict = metricImproves(contract.metricDirection, verification.metric, best)
            ? 'KEEP'
            : 'DISCARD';
        }
        appendState('VERIFIER_RECORDED', {
          attempt: active.attempt,
          verdict,
          metric: verification.metric,
        });
        lastFailure = verification.stderr || verification.stdout || 'none';
        continue;
      }

      if (state.phase === 'CHILD_COMPLETED') {
        let owned = false;
        try {
          readBoundDiffEvidence(repoRoot, active.diffPath, 'runner-diff', active.diffDigest);
          owned = attemptStillOwned(active, false);
        } catch {
          owned = false;
        }
        if (!owned) {
          return reconciliationHalt('completed child snapshot or immutable evidence is ambiguous');
        }
        appendState('BLAST_RADIUS_CHECKED', {
          attempt: active.attempt,
          passed: blastRadiusPasses(active.changedPaths, contract.blastRadius),
        });
        continue;
      }

      if (state.phase === 'ATTEMPT_RESERVED' && state.currentAttempt !== null) {
        const currentSnapshot = captureGitSnapshot(repoRoot, options.git);
        const reservationIntact = active.expectedParent === currentSnapshot.head
          && active.reservationSnapshotDigest === gitSnapshotDigest(currentSnapshot);
        if (!reservationIntact) {
          return reconciliationHalt('interrupted attempt snapshot drift is not safely controller-owned');
        }
        if (state.reservedAttempts.length === state.budget) {
          return reconciliationHalt('interrupted attempt exhausted the mutation budget');
        }
      }

      const attempt = state.reservedAttempts.length + 1;
      const reservationSnapshot = captureGitSnapshot(repoRoot, options.git);
      const expectedParent = reservationSnapshot.head;
      options.crashHook('before-reservation');
      appendState('ATTEMPT_RESERVED', {
        attempt,
        expectedParent,
        snapshotDigest: gitSnapshotDigest(reservationSnapshot),
      });
      options.crashHook('after-reservation');
      options.crashHook(`after-attempt-${attempt}-reserved`);
      writeLedger();

      const paths = attemptPaths(preflight.loopDir, state.runId, attempt);
      const currentEventBytes = readWorkPath(repoRoot, preflight.eventsPath, {
        expect: 'work-output', family: 'events',
      });
      const modelTier = dispatchTier(state);
      const prompt = buildImplementerPrompt({
        contract,
        goalPath,
        reportPath: paths.reportPath,
        lastFailure,
        ledgerDigest: sha256(currentEventBytes),
        routing,
        modelTier,
      });
      const descriptor = options.runner.descriptor(options.harness, prompt, { modelTier });
      const modelRouting = modelRoutingEvidence(descriptor, modelTier, 'implementer');
      observabilityDegraded ||= modelRouting.modelSelection === 'degraded';
      const controllerArtifacts = captureControllerArtifacts(repoRoot, [
        { path: goalPath, family: 'goal' },
        { path: preflight.eventsPath, family: 'events' },
        { path: preflight.ledgerPath, family: 'ledger' },
      ]);
      options.crashHook('before-child-return');
      const childResult = await options.runner.run(descriptor, {
        cwd: repoRoot,
        runId: state.runId,
        attempt,
        surface: contract.surface,
        reportPath: paths.reportPath,
        rawPath: paths.rawPath,
        readablePath: paths.readablePath,
        expectedParent,
        prompt,
        modelTier,
        modelSelection: modelRouting.modelSelection,
        resolvedModel: modelRouting.resolvedModel,
        degradationReason: modelRouting.degradationReason,
        routingPath: routing.routingPath,
        standardPaths: routing.standardPaths,
      });
      verifyControllerArtifacts(repoRoot, controllerArtifacts);
      options.crashHook('after-child-return');
      const persisted = persistChildEvidence(
        repoRoot,
        paths,
        childResult,
        { raw: 'runner-raw', readable: 'runner-log' },
        () => options.crashHook(`after-attempt-${attempt}-raw-evidence`),
        options.crashHook,
        options.immutableWrite ?? writeSync,
      );
      observabilityDegraded ||= persisted.degraded || childResult?.degraded === true;
      readWorkPath(repoRoot, paths.reportPath, {
        expect: 'work-output', family: 'runner-report', encoding: 'utf8',
      });
      if (childResult === null || childResult.error || childResult.status !== 0) {
        return reconciliationHalt(`attempt ${attempt} did not complete successfully`);
      }
      const envelope = parseChildEnvelope(persisted.output, { expectedArtifact: paths.reportPath });
      if (['BLOCKED', 'NEEDS_CONTEXT'].includes(envelope.status)) {
        return reconciliationHalt(`implementer returned ${envelope.status}`);
      }
      if (validateGitIdentity(options.git.head(repoRoot)) !== expectedParent) {
        return reconciliationHalt('model child moved HEAD outside controller ownership');
      }
      const changedPaths = options.git.changedPaths(repoRoot)
        .map((path) => safeRepoPath(path, 'Git changed path'));
      if (!samePathSet(changedPaths, envelope.changedPaths)) {
        return reconciliationHalt('child changed-paths do not match the controller Git observation');
      }
      const attemptSnapshot = captureGitSnapshot(repoRoot, options.git);
      const diffEvidence = createDiffEvidence(
        repoRoot,
        paths.diffPath,
        'runner-diff',
        state.baseline,
        options.git,
        options.crashHook,
        options.immutableWrite ?? writeSync,
      );
      appendState('CHILD_COMPLETED', {
        attempt,
        changedPaths,
        diffPath: diffEvidence.path,
        diffDigest: diffEvidence.digest,
        snapshotDigest: gitSnapshotDigest(attemptSnapshot),
        observabilityDegraded,
        ...modelRouting,
      });
    }
  } finally {
    releaseLock();
  }
}

function commandResult(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function gitValue(repoRoot, args) {
  const result = commandResult('git', args, repoRoot);
  if (result.status !== 0) {
    fail('INVALID_GIT_STATE', result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trimEnd();
}

function gitValueWithEnv(repoRoot, args, env) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, ...env },
  });
  if (result.status !== 0 || result.error) {
    fail('GIT_FAILED', result.stderr?.trim() || result.error?.message || `git ${args[0]} failed`);
  }
  return result.stdout.trim();
}

const TERMINAL_RESPONSE_LIMIT = 64 * 1024;
const DIAGNOSTIC_LIMIT = 4 * 1024;

function createTerminalResponseCorrelator(harness, maxBytes = TERMINAL_RESPONSE_LIMIT) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    fail('INVALID_DEPENDENCY', 'terminal response limit must be a positive safe integer');
  }
  let lastMessage = '';
  let terminalMessage = '';
  let completions = 0;
  let invalid = false;
  const retain = (value) => {
    if (Buffer.byteLength(value, 'utf8') > maxBytes) {
      invalid = true;
      lastMessage = '';
      return;
    }
    lastMessage = value;
  };
  return Object.freeze({
    accept(line, sourceStream) {
      if (sourceStream !== 'stdout' || line.length === 0) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        invalid = true;
        return;
      }
      if (event === null || typeof event !== 'object' || Array.isArray(event)) {
        invalid = true;
        return;
      }
      if (harness === 'claude') {
        if (event.type === 'result' && event.subtype === 'success'
          && event.agent_id == null && typeof event.result === 'string') {
          retain(event.result);
          terminalMessage = lastMessage;
          completions += 1;
        }
        return;
      }
      if (harness === 'codex') {
        if (event.type === 'item.completed' && event.item?.type === 'agent_message'
          && typeof event.item.text === 'string' && completions === 0) {
          retain(event.item.text);
        } else if (event.type === 'turn.completed') {
          terminalMessage = lastMessage;
          completions += 1;
        }
        return;
      }
      if (harness === 'opencode') {
        if (event.type === 'text' && typeof event.part?.text === 'string' && completions === 0) {
          retain(event.part.text);
        } else if (event.type === 'step_finish' && event.part?.reason === 'stop') {
          terminalMessage = lastMessage;
          completions += 1;
        }
        return;
      }
      invalid = true;
    },
    result() {
      const output = !invalid && completions === 1 ? terminalMessage : '';
      return Object.freeze({ output, retainedBytes: Buffer.byteLength(lastMessage, 'utf8') });
    },
  });
}

function appendBoundedDiagnostic(current, chunk, limit = DIAGNOSTIC_LIMIT) {
  const combined = Buffer.concat([Buffer.from(current, 'utf8'), Buffer.from(chunk)]);
  return combined.subarray(Math.max(0, combined.length - limit)).toString('utf8');
}

function killProcessTree(child, signal, processGroupSignal = null) {
  if (!child) return;
  if (processGroupSignal !== null) {
    try { processGroupSignal(child.pid, signal); } catch { /* convergence will fail closed */ }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* the process tree is already gone */ }
  }
}

function processTreeAlive(child, processGroupProbe = null) {
  if (!child?.pid) return false;
  if (processGroupProbe !== null) {
    try {
      return processGroupProbe(child.pid) !== false;
    } catch {
      return true;
    }
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function awaitProcessTreeExit(child, timeoutMs, processGroupProbe = null) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!processTreeAlive(child, processGroupProbe)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function awaitProcessTreePresence(child, timeoutMs, processGroupProbe = null) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (processTreeAlive(child, processGroupProbe)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function convergeProcessTree(
  child,
  termGraceMs,
  convergenceMs,
  processGroupProbe = null,
  processGroupSignal = null,
) {
  if (!child?.pid) return true;
  const confirmationMs = Math.min(convergenceMs, 100);
  if (!await awaitProcessTreePresence(
    child,
    Math.min(termGraceMs, 100),
    processGroupProbe,
  )) {
    await new Promise((resolveWait) => setTimeout(resolveWait, confirmationMs));
    if (!processTreeAlive(child, processGroupProbe)) return true;
  }
  killProcessTree(child, 'SIGTERM', processGroupSignal);
  if (await awaitProcessTreeExit(child, termGraceMs, processGroupProbe)) {
    await new Promise((resolveWait) => setTimeout(resolveWait, confirmationMs));
    if (!processTreeAlive(child, processGroupProbe)) return true;
  }
  killProcessTree(child, 'SIGKILL', processGroupSignal);
  if (!await awaitProcessTreeExit(child, convergenceMs, processGroupProbe)) return false;
  await new Promise((resolveWait) => setTimeout(resolveWait, confirmationMs));
  return !processTreeAlive(child, processGroupProbe);
}

function durableFdDestination(fd, writeToFd = writeSync) {
  let closed = false;
  return {
    on() { return this; },
    write(chunk, callback) {
      try {
        if (closed) throw new Error('destination is closed');
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
        const written = writeToFd(fd, bytes);
        if (written !== bytes.length) throw new Error(`short write: ${written} of ${bytes.length}`);
        fsyncSync(fd);
        callback?.();
        return true;
      } catch (error) {
        callback?.(error);
        return false;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try { fsyncSync(fd); } finally { closeSync(fd); }
    },
  };
}

export function runStreamingHeadlessDescriptor(descriptor, harness, cwd, options = {}) {
  return new Promise((resolveRun) => {
    const rawPath = options.rawPath;
    const readablePath = options.readablePath;
    const opened = [];
    let raw;
    try {
      const rawFamily = parseWorkPath(rawPath, 'work-output').family;
      const fd = openWorkPathFd(cwd, rawPath, {
        expect: 'work-output', family: rawFamily, disposition: 'create-new', mode: 0o600,
      });
      raw = durableFdDestination(fd, options.rawWrite ?? writeSync);
      opened.push(raw);
    } catch (error) {
      resolveRun({
        status: null, stdout: '', stderr: '', output: '', evidencePersisted: false,
        degraded: false, error: new Error(`raw-open failed: ${error.message}`),
      });
      return;
    }

    let degraded = false;
    let readable = null;
    try {
      const readableFamily = parseWorkPath(readablePath, 'work-output').family;
      const fd = openWorkPathFd(cwd, readablePath, {
        expect: 'work-output', family: readableFamily, disposition: 'create-new', mode: 0o600,
      });
      readable = durableFdDestination(fd);
      opened.push(readable);
    } catch {
      degraded = true;
    }

    const liveStdout = options.liveStdout ?? process.stdout;
    const liveStderr = options.liveStderr ?? process.stderr;
    let bridgeError = null;
    let child = null;
    let stopRequested = false;
    let graceTimer = null;
    let abortCleanup = null;
    let interrupted = null;
    let stopForwarding = () => {};
    const killGraceMs = options.killGraceMs ?? 500;
    const processGroupConvergenceMs = options.processGroupConvergenceMs ?? 1000;
    const processGroupProbe = options.processGroupProbe ?? null;
    const processGroupSignal = options.processGroupSignal ?? null;
    const requestStop = (error) => {
      if (stopRequested) return;
      stopRequested = true;
      if (error && bridgeError === null) bridgeError = error;
      killProcessTree(child, 'SIGTERM', processGroupSignal);
      graceTimer = setTimeout(
        () => killProcessTree(child, 'SIGKILL', processGroupSignal),
        killGraceMs,
      );
    };
    const writer = new BoundedMultiDestinationWriter({
      destinations: [
        { name: 'raw', role: 'raw', stream: raw },
        ...(readable === null ? [] : [{ name: 'readable', role: 'readable', stream: readable }]),
        { name: 'liveStdout', role: 'liveStdout', stream: liveStdout },
        { name: 'liveStderr', role: 'liveStderr', stream: liveStderr },
      ],
      ...(options.writerMaxPendingBytes === undefined
        ? {} : { maxPendingBytes: options.writerMaxPendingBytes }),
      ...(options.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.drainTimeoutMs }),
      onBlockingError: requestStop,
      onDegradation() { degraded = true; },
    });
    const correlator = createTerminalResponseCorrelator(
      harness,
      options.terminalResponseLimit ?? TERMINAL_RESPONSE_LIMIT,
    );
    let stderrDiagnostic = '';
    const framers = {
      stdout: new LineFramer({ sourceStream: 'stdout' }),
      stderr: new LineFramer({ sourceStream: 'stderr' }),
    };
    const consume = (frame, source) => {
      if (bridgeError) return;
      const result = processEventLine({
        line: frame.line,
        sourceStream: frame.sourceStream,
        context: {
          harness,
          runId: options.runId ?? null,
          phase: options.phase ?? 'loop-engineer',
          attempt: options.attempt ?? null,
          receivedAt: new Date().toISOString(),
        },
        decoder: decodeHeadlessEvent,
      });
      if (result.blockingError) {
        requestStop(result.blockingError);
        return;
      }
      if (result.degradation) degraded = true;
      const rawResult = writer.write({ raw: result.raw }, { source });
      if (!rawResult.ok) return;
      correlator.accept(frame.line, frame.sourceStream);
      const chunks = {};
      if (result.readable !== null) chunks.readable = `${result.readable}\n`;
      if (result.live !== null) {
        chunks[frame.sourceStream === 'stderr' ? 'liveStderr' : 'liveStdout'] = `${result.live}\n`;
      }
      if (Object.keys(chunks).length > 0) writer.write(chunks, { source });
    };
    const closeAll = () => {
      writer.terminate();
      for (const destination of opened) {
        try { destination.close(); } catch { degraded = true; }
      }
    };
    try {
      child = spawn(descriptor.cmd, descriptor.args, {
        cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true,
      });
    } catch (error) {
      closeAll();
      resolveRun({
        status: null, stdout: '', stderr: '', output: '', evidencePersisted: true,
        degraded, error,
      });
      return;
    }
    if (options.signal) {
      const onAbort = () => requestStop(new Error('headless descriptor aborted'));
      if (options.signal.aborted) onAbort();
      else {
        options.signal.addEventListener('abort', onAbort, { once: true });
        abortCleanup = () => options.signal.removeEventListener('abort', onAbort);
      }
    }
    const forwardSignal = (signal) => {
      stopForwarding();
      interrupted = signal;
      requestStop(new Error(`headless descriptor interrupted by ${signal}`));
    };
    const onSigint = () => forwardSignal('SIGINT');
    const onSigterm = () => forwardSignal('SIGTERM');
    const onSighup = () => forwardSignal('SIGHUP');
    stopForwarding = () => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener('SIGHUP', onSighup);
    };
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    process.once('SIGHUP', onSighup);
    for (const sourceStream of ['stdout', 'stderr']) {
      const source = child[sourceStream];
      source.on('data', (chunk) => {
        if (sourceStream === 'stderr') stderrDiagnostic = appendBoundedDiagnostic(stderrDiagnostic, chunk);
        try {
          for (const frame of framers[sourceStream].push(chunk)) consume(frame, source);
        } catch (error) {
          requestStop(error);
        }
      });
      source.on('end', () => {
        try {
          for (const frame of framers[sourceStream].end()) consume(frame, source);
        } catch (error) {
          requestStop(error);
        }
      });
    }
    let settled = false;
    let leaderResult = null;
    let streamsFinalized = false;
    let convergenceStarted = false;
    let convergenceComplete = false;
    let convergenceError = null;
    const finishIfReady = () => {
      if (settled || leaderResult === null || !streamsFinalized || !convergenceComplete) return;
      settled = true;
      abortCleanup?.();
      stopForwarding();
      closeAll();
      const correlated = correlator.result();
      if (interrupted !== null && convergenceError === null) {
        process.kill(process.pid, interrupted);
        return;
      }
      resolveRun({
        status: leaderResult.status,
        signal: leaderResult.signal,
        stdout: correlated.output,
        stderr: stderrDiagnostic,
        output: correlated.output,
        retainedBytes: correlated.retainedBytes + Buffer.byteLength(stderrDiagnostic, 'utf8'),
        evidencePersisted: true,
        degraded,
        error: bridgeError ?? leaderResult.error ?? convergenceError,
      });
    };
    const startConvergence = () => {
      if (convergenceStarted) return;
      convergenceStarted = true;
      if (graceTimer) clearTimeout(graceTimer);
      void convergeProcessTree(
        child,
        killGraceMs,
        processGroupConvergenceMs,
        processGroupProbe,
        processGroupSignal,
      ).then((converged) => {
        convergenceError = converged
          ? null
          : new Error(`process-group convergence timed out after ${processGroupConvergenceMs}ms`);
        convergenceComplete = true;
        finishIfReady();
      });
    };
    child.once('error', (error) => {
      leaderResult = leaderResult === null
        ? { status: null, signal: null, error }
        : { ...leaderResult, error };
      startConvergence();
    });
    child.once('exit', (code, signal) => {
      leaderResult = { status: code, signal, error: leaderResult?.error ?? null };
      startConvergence();
    });
    child.once('close', (code, signal) => {
      if (leaderResult === null) leaderResult = { status: code, signal, error: null };
      streamsFinalized = true;
      startConvergence();
      finishIfReady();
    });
  });
}

function cliChangedPaths(repoRoot) {
  const tracked = gitValue(repoRoot, ['diff', '--name-only', 'HEAD'])
    .split('\n').filter(Boolean);
  const untracked = gitValue(repoRoot, ['ls-files', '--others', '--exclude-standard'])
    .split('\n').filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}

function cliDiff(repoRoot, baseline) {
  return {
    text: gitValue(repoRoot, ['diff', '--binary', '--no-color', baseline]),
    untracked: gitValue(repoRoot, ['ls-files', '--others', '--exclude-standard'])
      .split('\n').filter(Boolean),
  };
}

function cliGitSnapshot(repoRoot, { excludePaths = [] } = {}) {
  const excluded = new Set(excludePaths);
  const trackedDiff = spawnSync(
    'git', ['diff', '--binary', '--no-color', 'HEAD'], { cwd: repoRoot, shell: false },
  );
  if (trackedDiff.status !== 0) {
    fail('INVALID_GIT_STATE', trackedDiff.stderr?.toString('utf8').trim() || 'git diff HEAD failed');
  }
  const untrackedPaths = gitValue(repoRoot, ['ls-files', '--others', '--exclude-standard'])
    .split('\n').filter(Boolean).filter((path) => !excluded.has(path)).sort();
  const untracked = untrackedPaths.map((path) => {
    const safePath = safeRepoPath(path, 'Git untracked path');
    const absolute = join(repoRoot, safePath);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      return Object.freeze({ path: safePath, type: 'symlink', digest: sha256(readlinkSync(absolute)) });
    }
    if (!stat.isFile()) fail('INVALID_GIT_STATE', `untracked path is not a file or symlink: ${safePath}`);
    return Object.freeze({ path: safePath, type: 'file', digest: sha256(readFileSync(absolute)) });
  });
  return Object.freeze({
    head: gitValue(repoRoot, ['rev-parse', 'HEAD']),
    indexTree: gitValue(repoRoot, ['write-tree']),
    trackedDiffDigest: sha256(trackedDiff.stdout ?? Buffer.alloc(0)),
    untracked: Object.freeze(untracked),
  });
}

function commitMessage(metadata) {
  return `steepy loop ${metadata.runId} attempt ${metadata.attempt}\n\n`
    + `Steepy-Run-ID: ${metadata.runId}\n`
    + `Steepy-Attempt: ${metadata.attempt}\n`
    + `Steepy-Reserved-At: ${metadata.reservedAt}\n`
    + `Steepy-Expected-Parent: ${metadata.expectedParent}\n`
    + `Steepy-Snapshot-Digest: ${metadata.snapshotDigest}\n`
    + `Steepy-Changed-Paths: ${JSON.stringify(metadata.changedPaths)}\n`
    + `Steepy-Blast-Radius: ${JSON.stringify(metadata.blastRadius)}\n`
    + `Steepy-Controller: ${metadata.owner}`;
}

function cliWorktreeMatchesCommit(repoRoot, commit) {
  const indexDir = mkdtempSync(join(tmpdir(), 'steepy-loop-proof-index-'));
  const indexPath = join(indexDir, 'index');
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    gitValueWithEnv(repoRoot, ['read-tree', commit], env);
    gitValueWithEnv(repoRoot, ['add', '-A'], env);
    const observedTree = gitValueWithEnv(repoRoot, ['write-tree'], env);
    const expectedTree = gitValue(repoRoot, ['rev-parse', `${commit}^{tree}`]);
    return observedTree === expectedTree;
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}

function cliDiscardTransitionState(repoRoot, ownership) {
  const bound = ownership.snapshot === null || ownership.snapshot === undefined
    ? null
    : normalizedGitSnapshot(ownership.snapshot);
  if (bound !== null && gitSnapshotDigest(bound) !== ownership.snapshotDigest) return null;
  const current = normalizedGitSnapshot(cliGitSnapshot(repoRoot));
  if (gitSnapshotDigest(current) === ownership.snapshotDigest) {
    return Object.freeze({ classification: 'SAFE_PENDING_DISCARD', bound });
  }
  const parentTree = gitValue(repoRoot, ['rev-parse', `${ownership.expectedParent}^{tree}`]);
  if (bound !== null
    && current.head === ownership.expectedParent
    && current.indexTree === parentTree
    && current.trackedDiffDigest === sha256(Buffer.alloc(0))
    && JSON.stringify(current.untracked) === JSON.stringify(bound.untracked)) {
    return Object.freeze({ classification: 'SAFE_PARTIAL_DISCARD', bound });
  }
  return null;
}

export function createCliGitAdapter() {
  return {
    branch: (repoRoot) => gitValue(repoRoot, ['branch', '--show-current']),
    status: (repoRoot) => gitValue(repoRoot, ['status', '--short']),
    baseline: (repoRoot) => gitValue(repoRoot, ['rev-parse', 'HEAD']),
    head: (repoRoot) => gitValue(repoRoot, ['rev-parse', 'HEAD']),
    diff: cliDiff,
    changedPaths: cliChangedPaths,
    snapshot: cliGitSnapshot,
    prepareCommit(repoRoot, metadata) {
      const snapshot = normalizedGitSnapshot(cliGitSnapshot(repoRoot));
      const changedPaths = cliChangedPaths(repoRoot).map((path) => safeRepoPath(path, 'Git changed path'));
      if (snapshot.head !== metadata.expectedParent
        || gitSnapshotDigest(snapshot) !== metadata.snapshotDigest
        || !samePathSet(changedPaths, metadata.changedPaths)
        || !blastRadiusPasses(changedPaths, metadata.blastRadius)) {
        fail('ATTEMPT_OWNERSHIP', 'attempt snapshot or blast radius changed before commit preparation');
      }
      const indexDir = mkdtempSync(join(tmpdir(), 'steepy-loop-index-'));
      const indexPath = join(indexDir, 'index');
      const env = {
        GIT_INDEX_FILE: indexPath,
        GIT_AUTHOR_NAME: 'Steepy Loop Controller',
        GIT_AUTHOR_EMAIL: 'steepy-loop@localhost.invalid',
        GIT_AUTHOR_DATE: metadata.reservedAt,
        GIT_COMMITTER_NAME: 'Steepy Loop Controller',
        GIT_COMMITTER_EMAIL: 'steepy-loop@localhost.invalid',
        GIT_COMMITTER_DATE: metadata.reservedAt,
      };
      try {
        gitValueWithEnv(repoRoot, ['read-tree', metadata.expectedParent], env);
        gitValueWithEnv(repoRoot, ['add', '-A'], env);
        const tree = gitValueWithEnv(repoRoot, ['write-tree'], env);
        const commit = gitValueWithEnv(repoRoot, [
          'commit-tree', tree, '-p', metadata.expectedParent, '-m', commitMessage(metadata),
        ], env);
        return Object.freeze({ commit, expectedParent: metadata.expectedParent, metadata });
      } finally {
        rmSync(indexDir, { recursive: true, force: true });
      }
    },
    inspectCommit(repoRoot, expectation) {
      const commit = validateGitIdentity(expectation.commit);
      const object = commandResult('git', ['cat-file', '-p', commit], repoRoot);
      const message = commandResult('git', ['log', '-1', '--format=%B', commit], repoRoot);
      const parents = commandResult('git', ['rev-list', '--parents', '-n', '1', commit], repoRoot);
      const parentFields = (parents.stdout ?? '').trim().split(/\s+/u);
      const parent = parentFields.length === 2 && GIT_ID.test(parentFields[1])
        ? parentFields[1]
        : '0'.repeat(40);
      const body = message.status === 0 ? (message.stdout ?? '').trimEnd() : '';
      const trailer = (name) => {
        const match = new RegExp(`^${name}: (.+)$`, 'mu').exec(body);
        return match?.[1] ?? '';
      };
      const parsedAttempt = Number(trailer('Steepy-Attempt'));
      const runId = trailer('Steepy-Run-ID') || 'missing-run-id';
      const expectedParent = trailer('Steepy-Expected-Parent');
      const owner = trailer('Steepy-Controller') || 'missing-owner';
      const exactMessage = commitMessage(expectation);
      return Object.freeze({
        head: gitValue(repoRoot, ['rev-parse', 'HEAD']),
        worktreeClean: gitValue(repoRoot, ['status', '--short']) === '',
        worktreeMatchesCommit: cliWorktreeMatchesCommit(repoRoot, commit),
        commit,
        parent,
        runId,
        attempt: Number.isSafeInteger(parsedAttempt) && parsedAttempt > 0 ? parsedAttempt : 1,
        expectedParent: GIT_ID.test(expectedParent) ? expectedParent : '0'.repeat(40),
        owner,
        unique: object.status === 0
          && message.status === 0
          && parents.status === 0
          && parentFields.length === 2
          && body === exactMessage,
        snapshotDigest: null,
      });
    },
    commit(repoRoot, prepared, transitionHook = () => {}) {
      if (typeof transitionHook !== 'function') fail('INVALID_DEPENDENCY', 'Git transition hook must be a function');
      const head = gitValue(repoRoot, ['rev-parse', 'HEAD']);
      if (head === prepared.expectedParent) {
        gitValue(repoRoot, ['update-ref', 'HEAD', prepared.commit, prepared.expectedParent]);
        transitionHook('after-git-commit-update-ref');
      } else if (head !== prepared.commit) {
        fail('INVALID_GIT_STATE', 'commit transition HEAD matches neither expected parent nor prepared commit');
      }
      if (!cliWorktreeMatchesCommit(repoRoot, prepared.commit)) {
        fail('ATTEMPT_OWNERSHIP', 'working tree no longer matches the prepared controller commit');
      }
      gitValue(repoRoot, ['reset', '--mixed', prepared.commit]);
      transitionHook('after-git-commit-reset-mixed');
      if (gitValue(repoRoot, ['status', '--short']) !== '') {
        fail('INVALID_GIT_STATE', 'controller commit transition did not converge to a clean tree');
      }
      return gitValue(repoRoot, ['rev-parse', 'HEAD']);
    },
    ownsAttempt(repoRoot, ownership) {
      return gitSnapshotDigest(normalizedGitSnapshot(cliGitSnapshot(repoRoot))) === ownership.snapshotDigest;
    },
    inspectDiscard(repoRoot, ownership) {
      return cliDiscardTransitionState(repoRoot, ownership)?.classification ?? 'AMBIGUOUS_GIT_STATE';
    },
    discard(repoRoot, ownership, transitionHook = () => {}) {
      if (typeof transitionHook !== 'function') fail('INVALID_DEPENDENCY', 'Git transition hook must be a function');
      const transition = cliDiscardTransitionState(repoRoot, ownership);
      if (transition === null) {
        fail('ATTEMPT_OWNERSHIP', 'attempt snapshot drifted outside the recoverable discard transition');
      }
      const { bound } = transition;
      if (transition.classification === 'SAFE_PENDING_DISCARD') {
        gitValue(repoRoot, ['reset', '--hard', ownership.expectedParent]);
        transitionHook('after-git-discard-reset-hard');
      }
      const untrackedPaths = bound?.untracked.map(({ path }) => path) ?? [];
      if (untrackedPaths.length > 0) {
        gitValue(repoRoot, ['clean', '-fd', '--', ...untrackedPaths]);
        transitionHook('after-git-discard-clean');
      }
      if (gitValue(repoRoot, ['status', '--short']) !== '') {
        fail('INVALID_GIT_STATE', 'controller discard transition did not converge to a clean tree');
      }
      return gitValue(repoRoot, ['rev-parse', 'HEAD']);
    },
  };
}

function cliDependencies({ modelMappings } = {}) {
  return {
    runner: {
      descriptor: (harness, prompt, descriptorInput) => headlessCommand(harness, prompt, {
        ...descriptorInput,
        ...(modelMappings === undefined ? {} : { modelMappings }),
      }),
      run(descriptor, context) {
        const harness = descriptor.cmd === 'claude' ? 'claude'
          : descriptor.cmd === 'codex' ? 'codex'
            : 'opencode';
        return runStreamingHeadlessDescriptor(descriptor, harness, context.cwd, context);
      },
    },
    reviewer: {
      async run(prompt, context) {
        const { cwd, harness, modelTier } = context;
        const descriptor = headlessCommand(harness, prompt, {
          modelTier,
          ...(modelMappings === undefined ? {} : { modelMappings }),
        });
        if (descriptor === null) fail('RUNNER_UNAVAILABLE', `runner-unavailable: ${harness}`);
        const result = await runStreamingHeadlessDescriptor(descriptor, harness, cwd, context);
        return Object.freeze({ ...result, descriptor });
      },
    },
    verifier: {
      run(_command, { argv, cwd }) {
        return commandResult(argv[0], argv.slice(1), cwd);
      },
    },
    git: createCliGitAdapter(),
    clock: () => new Date().toISOString(),
    uuid: () => randomUUID(),
    crashHook() {},
    processProbe: defaultProcessProbe,
    lockTransitionHook() {},
  };
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  let values;
  let tokens;
  try {
    ({ values, tokens } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      tokens: true,
      options: {
        'repo-root': { type: 'string' },
        'validate-terminal': { type: 'boolean' },
        goal: { type: 'string' },
        harness: { type: 'string' },
        'commit-authorized': { type: 'boolean' },
        resume: { type: 'boolean' },
        ledger: { type: 'string' },
        'routing-index': { type: 'string' },
        standard: { type: 'string', multiple: true },
      },
    }));
  } catch (error) {
    stderr.write(`loop-engineer usage: ${error.message}\n`);
    return 2;
  }
  const counts = new Map();
  for (const token of tokens) {
    if (token.kind === 'option') counts.set(token.name, (counts.get(token.name) ?? 0) + 1);
  }
  const singletonNames = [
    'repo-root', 'validate-terminal', 'goal', 'harness', 'commit-authorized', 'resume', 'ledger',
    'routing-index',
  ];
  const duplicate = singletonNames.some((name) => (counts.get(name) ?? 0) > 1);
  const terminalValidation = values['validate-terminal'] === true;
  const validValidationShape = terminalValidation
    && counts.get('repo-root') === 1 && counts.get('validate-terminal') === 1
    && counts.get('goal') === 1 && counts.get('ledger') === 1
    && (counts.get('harness') ?? 0) === 0 && (counts.get('commit-authorized') ?? 0) === 0
    && (counts.get('resume') ?? 0) === 0 && (counts.get('routing-index') ?? 0) === 0
    && (counts.get('standard') ?? 0) === 0
    && typeof values['repo-root'] === 'string' && values['repo-root'].length > 0
    && typeof values.goal === 'string' && values.goal.length > 0
    && typeof values.ledger === 'string' && values.ledger.length > 0;
  const validRunShape = !terminalValidation
    && counts.get('repo-root') === 1 && counts.get('goal') === 1
    && counts.get('harness') === 1 && counts.get('commit-authorized') === 1
    && counts.get('routing-index') === 1 && (counts.get('standard') ?? 0) >= 1
    && (counts.get('resume') ?? 0) <= 1 && (counts.get('ledger') ?? 0) <= 1
    && values['repo-root'] && values.goal && values.harness
    && values['commit-authorized'] === true && values['routing-index'] === '.apex/_INDEX.md'
    && Array.isArray(values.standard) && values.standard.length > 0
    && (values.resume === true) === (typeof values.ledger === 'string');
  if (duplicate || (!validValidationShape && !validRunShape)) {
    stderr.write('loop-engineer usage: --repo-root --validate-terminal --goal --ledger | --repo-root --goal --harness --commit-authorized --routing-index .apex/_INDEX.md --standard <path>... [--resume --ledger]\n');
    return 2;
  }
  if (terminalValidation) {
    try {
      const receipt = validateLoopTerminal(values.goal, values.ledger, {
        repoRoot: values['repo-root'],
        ...(io.git === undefined ? {} : { git: io.git }),
      });
      stdout.write(`${JSON.stringify(receipt)}\n`);
      return 0;
    } catch (error) {
      const message = error instanceof LoopControllerError
        ? error.message
        : `loop controller [UNEXPECTED]: ${error.message}`;
      stderr.write(`${message}\n`);
      return 1;
    }
  }
  if (headlessCommand(values.harness, 'Validate Gear-4 runner availability.', { modelTier: 'standard' }) === null) {
    stderr.write(`runner-unavailable: ${values.harness}\n`);
    return 1;
  }
  try {
    const result = await runLoopController(values.goal, {
      ...cliDependencies(),
      repoRoot: values['repo-root'],
      harness: values.harness,
      commitAuthorized: true,
      resume: values.resume === true,
      ledgerPath: values.ledger,
      routingPath: values['routing-index'],
      standardPaths: values.standard,
    });
    stdout.write(`${JSON.stringify({
      status: result.status,
      runId: result.runId,
      terminal: result.outcome !== null && result.outcome !== undefined && result.handoff !== undefined,
      goal: result.handoff?.goal ?? values.goal,
      'loop-ledger': result.handoff?.['loop-ledger'] ?? result.ledgerPath,
    })}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof LoopControllerError
      ? error.message
      : `loop controller [UNEXPECTED]: ${error.message}`;
    stderr.write(`${message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  process.exitCode = await main();
}

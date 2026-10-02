// Gear-3 controller protocol 2: the conductor itself drives every role. Plan,
// writer, reviewer, correction, and review children are fresh one-shot
// invocations with an immutable reservation, manifest, and captured response;
// the controller validates each response through the existing gates, records
// acceptance in the authoritative journal, and owns commits and lifecycle
// publication. Every decision is re-derived from the journal and helper
// receipts, so a resumed process continues from durable evidence without
// repeating a dispatched writer. Runner, Git, crash, and evidence-gate services
// are injected; this module never spawns a harness itself.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acceptAutopilotResult, appendAutopilotEvent, captureAutopilotResponse, createAutopilotRun,
  projectAutopilotStatus, readAutopilotRun, reconcileAutopilotReservation, reconcileAutopilotStart,
  reserveAutopilotRole,
} from './autopilot-state.mjs';
import { fingerprintAutopilotRuntime } from './autopilot-runtime.mjs';
import {
  CONTROLLER_ROUTING_PATH, buildControllerTaskManifest, buildFinalReviewManifest, buildPlanManifest,
  buildReviewManifest, buildFinalReviewCorrectionManifest, buildTaskReviewCorrectionManifest,
  controllerPlanContext, ensureControllerTaskBrief, materializeSuccessCriteria, reviewPhaseContext,
  specPhaseContext, standardsBySurfaceFromRouting, writeContextManifest,
} from './autopilot-context.mjs';
import { parseFixTargets } from './autopilot-plan.mjs';
import { inspectRecovery, loadRecoveryInput, recoveryCopies } from './autopilot-recovery.mjs';
import {
  beginTask, importTaskResult, inspectTaskImport, inspectTaskResult, projectTaskResults, recordTaskResult, resumeTaskResult,
  verifyTaskResults,
} from './task-results.mjs';
import { beginReview, checkReview, inspectReview, reserveRepair, setReviewReference } from './reviewer-response.mjs';
import { readStableDocument } from './stable-paths.mjs';
import { mkdirWorkPath, parseWorkPath, readWorkPath, writeWorkPath } from './work-paths.mjs';

export const CONTROLLER_PROTOCOL = 2;
// Versions are selected once per run and pinned in every role manifest. A
// recovery run (started from its exact recovery input) selects index protocol
// 3, which also projects verified imports; every other run keeps protocol 2.
export const CONTROLLER_CONTRACT = Object.freeze({
  controllerProtocol: CONTROLLER_PROTOCOL,
  taskResultProtocol: 2,
  taskResultIndexProtocol: 2,
  reviewerResponseProtocol: 3,
});
const ENGINE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const RESPONSE_SCHEMA_VERSION = 1;
const STATUS_PROJECTION_HEADER = '# Autopilot status\n';
const TIER = Object.freeze({ mechanical: 'cheap', integration: 'standard', design: 'most-capable' });
// Reviewers keep the standard floor and rise to most-capable for design work;
// response-only corrections stay at the floor.
const REVIEWER_TIER = 'standard';
const taskReviewerTier = (task) => (task.complexity === 'design' ? 'most-capable' : REVIEWER_TIER);
const finalReviewerTier = (plan) => (plan.tasks.some((task) => task.complexity === 'design') ? 'most-capable' : REVIEWER_TIER);
const SIGNALS = /^(?:none|[A-Za-z0-9][A-Za-z0-9:._-]*(?:, [A-Za-z0-9][A-Za-z0-9:._-]*)*)$/;
const LIFECYCLE = /^((?:[ \t\r\n]*<!--(?!\s*steepy-workflow:)[\s\S]*?-->)*[ \t\r\n]*<!-- steepy-workflow: v1\r?\n)([\s\S]*?)(\r?\n-->)/;
const LIFECYCLE_FIELDS = ['phase', 'status', 'next', 'source', 'consumed-by'];
const ROLE_PROMPTS = Object.freeze({
  plan: ['skills/plan/SKILL.md'],
  review: ['skills/review/SKILL.md'],
  implementer: ['skills/implement/controller-role-prompt.md', 'skills/implement/implementer-prompt.md'],
  fix: ['skills/implement/controller-role-prompt.md', 'skills/implement/implementer-prompt.md'],
  'task-reviewer': ['skills/implement/controller-role-prompt.md', 'skills/implement/task-reviewer-prompt.md'],
  'final-review': ['skills/implement/controller-role-prompt.md', 'skills/implement/final-review-prompt.md'],
  'task-review-correction': ['skills/implement/controller-role-prompt.md', 'skills/implement/reviewer-correction-prompt.md'],
  'final-review-correction': ['skills/implement/controller-role-prompt.md', 'skills/implement/reviewer-correction-prompt.md'],
});
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// A decided stop: recorded in the journal as RUN_HALTED before it unwinds.
class ControllerHalt extends Error {}
// A refusal before any effect of the step it guards: nothing is journaled, so
// the run (or the absent run) stays resumable once the cause is fixed.
class ControllerRefusal extends Error {}

export function controllerPaths(specName) {
  const dir = `.apex/work/tasks/${specName}`;
  return Object.freeze({
    dir, spec: `.apex/work/specs/${specName}.md`, plan: `.apex/work/plans/${specName}.md`,
    index: `${dir}/task-result-index.md`, criteria: `${dir}/success-criteria.md`,
    branchDiff: `${dir}/branch-diff.txt`, reviewReport: `${dir}/review-report.md`,
    evidence: `${dir}/evidence-report.md`, finalReport: `${dir}/final-review.md`,
    finalIssues: `${dir}/final-review-issues.md`, run: `${dir}/autopilot-run.json`,
    events: `${dir}/autopilot-events.jsonl`, status: `${dir}/autopilot-status.md`,
    recoveryInput: `${dir}/recovery-input.json`,
  });
}

function optionalWork(root, path, family) {
  try { return readWorkPath(root, path, { family }); } catch (error) {
    if (/^work path: missing (?:work artifact|ancestor directory)/.test(error.message)) return null;
    throw error;
  }
}

// Exact controller-owned paths only: no work-area listing. A present run
// identity imposes protocol 2 whatever the replaceable projection holds; the
// controller validates the identity and regenerates the projection from events.
// A controller marker without its immutable identity is corrupt new state,
// never legacy.
export function inspectControllerState(root, specName) {
  const paths = controllerPaths(specName);
  if (optionalWork(root, paths.run, 'autopilot-run') !== null) {
    return Object.freeze({ controllerProtocol: CONTROLLER_PROTOCOL });
  }
  const status = optionalWork(root, paths.status, 'status');
  if (optionalWork(root, paths.events, 'autopilot-events') !== null
    || optionalWork(root, `${paths.dir}/role-1-reservation.json`, 'role-reservation') !== null
    || (status !== null && status.toString('utf8').startsWith(STATUS_PROJECTION_HEADER))) {
    throw new Error('controller protocol 2 state exists without its immutable run identity; refusing legacy fallback');
  }
  return null;
}

// Captured transport is opaque to the journal; this closed record keeps the
// specific diagnosis (terminal reason, exit, transport, raw persistence). It is
// written only by the controller after the child is gone, and binds the digest
// of the complete raw capture, which a running child cannot know.
function responseRecord(roleSequence, role, outcome, rawDigest) {
  const text = (value) => (typeof value === 'string' && value.length > 0 ? value : null);
  const model = text(outcome?.observedModel);
  return {
    schemaVersion: RESPONSE_SCHEMA_VERSION, roleSequence, role,
    payload: typeof outcome?.payload === 'string' ? outcome.payload : null,
    terminalReason: text(outcome?.reason),
    sessionId: text(outcome?.sessionId),
    exit: {
      status: Number.isSafeInteger(outcome?.exit?.status) ? outcome.exit.status : null,
      signal: text(outcome?.exit?.signal),
    },
    transportError: text(outcome?.transportError),
    capturePersisted: outcome?.capturePersisted !== false,
    observedModel: model !== null && model.trim() === model && !/[\u0000-\u001f]/.test(model) ? model : null,
    rawDigest,
  };
}

function parseResponseRecord(bytes, entry) {
  const record = JSON.parse(bytes.toString('utf8'));
  const keys = ['schemaVersion', 'roleSequence', 'role', 'payload', 'terminalReason', 'sessionId', 'exit',
    'transportError', 'capturePersisted', 'observedModel', 'rawDigest'];
  if (!record || typeof record !== 'object' || Object.keys(record).sort().join() !== [...keys].sort().join()
    || record.schemaVersion !== RESPONSE_SCHEMA_VERSION || record.roleSequence !== entry.roleSequence
    || record.role !== entry.role || !(record.rawDigest === null || /^[0-9a-f]{64}$/.test(record.rawDigest))) {
    throw new Error(`captured response for role ${entry.roleSequence} does not bind its reservation`);
  }
  return record;
}

function transportProblems(record) {
  const problems = [];
  if (record.payload === null) problems.push(`no terminal response (${record.terminalReason ?? 'missing-terminal'})`);
  else if (record.terminalReason !== null) problems.push(`terminal ${record.terminalReason}`);
  if (record.exit.signal !== null) problems.push(`child killed by ${record.exit.signal}`);
  else if (record.exit.status !== 0) problems.push(`child exited ${record.exit.status ?? 'without a status'}`);
  if (record.transportError !== null) problems.push(`transport error: ${record.transportError}`);
  if (!record.capturePersisted) problems.push('raw capture was not persisted');
  return problems;
}

function transportDiagnosis(label, record) {
  const problems = transportProblems(record);
  return problems.length === 0 ? null : `${label}: ${problems.join('; ')}`;
}

const SCHEMAS = new Map();
function phaseSchema(phase) {
  if (!SCHEMAS.has(phase)) {
    SCHEMAS.set(phase, JSON.parse(readFileSync(new URL(`../skills/${phase}/controller-response.schema.json`, import.meta.url), 'utf8')));
  }
  return SCHEMAS.get(phase);
}

// The closed plan/review outcome schemas, in the selected text transport:
// exactly `status` then `signals`. Values are never inferred from prose.
export function decodePhaseResponse(payload, phase) {
  const schema = phaseSchema(phase);
  if (typeof payload !== 'string') throw new Error(`${phase} response is not text`);
  const lines = payload.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  if (lines.length !== schema.required.length
    || schema.required.some((field, index) => !lines[index].startsWith(`${field}: `))) {
    throw new Error(`${phase} response must be exactly the ordered fields ${schema.required.join(', ')}`);
  }
  const value = Object.fromEntries(schema.required.map((field, index) => [field, lines[index].slice(field.length + 2)]));
  if (!schema.properties.status.enum.includes(value.status)) throw new Error(`${phase} response has invalid status`);
  if (!SIGNALS.test(value.signals)) throw new Error(`${phase} response has invalid signals`);
  return value;
}

export function createGitService(run = spawnSync) {
  const git = (root, args) => {
    const result = run('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.error) throw new Error(`git ${args[0]} failed: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${String(result.stderr).trim()}`);
    return result.stdout;
  };
  const source = ['--', '.', ':(exclude).apex/work'];
  return Object.freeze({
    branch: (root) => git(root, ['branch', '--show-current']).trim(),
    head: (root) => git(root, ['rev-parse', '--verify', 'HEAD']).trim(),
    headSubject: (root) => git(root, ['log', '-1', '--format=%s']).replace(/\n$/, ''),
    dirty: (root) => git(root, ['status', '--porcelain', '--untracked-files=all', ...source]).length > 0,
    // Naming an ignored work area in `git add` fails, so stage the source tree
    // and then unstage anything the work area contributed.
    commitAll: (root, message) => {
      git(root, ['add', '-A', '--', '.']);
      git(root, ['reset', '-q', '--', '.apex/work']);
      git(root, ['commit', '-q', '-m', message]);
    },
    diff: (root, base) => git(root, ['diff', '--no-color', base]),
    untracked: (root) => git(root, ['ls-files', '--others', '--exclude-standard'])
      .split('\n').map((line) => line.trim()).filter(Boolean),
  });
}

// The aggregate branch diff is derived data: `git diff <baseline>` covers committed
// and uncommitted tracked work, and untracked paths are named explicitly.
export function captureBranchDiff({ cwd, baseline, outputPath, family = 'diff' }) {
  const safePath = parseWorkPath(outputPath, 'work-output', family).path;
  const diff = spawnSync('git', ['diff', '--no-color', baseline], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (diff.error) throw new Error(`git diff ${baseline} failed: ${diff.error.message}`);
  if (diff.status !== 0) throw new Error(`git diff ${baseline} failed: ${diff.stderr.trim()}`);
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  if (untracked.error) throw new Error(`git ls-files --others failed: ${untracked.error.message}`);
  if (untracked.status !== 0) throw new Error(`git ls-files --others failed: ${untracked.stderr.trim()}`);
  const untrackedPaths = untracked.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const sections = [`=== branch diff: ${baseline}..working tree ===`, diff.stdout.trimEnd()];
  if (untrackedPaths.length > 0) {
    sections.push('=== untracked files (present on disk, no diff above) ===', untrackedPaths.join('\n'));
  }
  const contents = `${sections.filter(Boolean).join('\n')}\n`;
  mkdirWorkPath(cwd, safePath, { expect: 'work-output', family });
  writeWorkPath(cwd, safePath, contents, { expect: 'work-output', family });
  return { path: safePath, bytes: Buffer.byteLength(contents), untracked: untrackedPaths };
}

function lifecycleOf(text) {
  const match = LIFECYCLE.exec(text);
  if (!match) return null;
  const entries = match[2].split(/\r?\n/).map((line) => /^([a-z-]+): (.+)$/.exec(line));
  if (entries.some((entry) => !entry) || entries.map((entry) => entry[1]).join() !== LIFECYCLE_FIELDS.join()) {
    throw new Error('invalid steepy-workflow lifecycle header');
  }
  return Object.fromEntries(entries.map((entry) => [entry[1], entry[2]]));
}

// Rewrites only lifecycle values inside the leading header; every other byte stays.
function withLifecycle(text, changes) {
  const match = LIFECYCLE.exec(text);
  if (!match) throw new Error('lifecycle header missing');
  let body = match[2];
  for (const [field, value] of Object.entries(changes)) {
    body = body.replace(new RegExp(`^${field}: [^\\r\\n]+(?=\\r?$)`, 'm'), `${field}: ${value}`);
  }
  return match[1] + body + match[3] + text.slice(match[0].length);
}

const sameScope = (a, b) => a.phase === b.phase && a.attempt === b.attempt && a.task === b.task && a.iteration === b.iteration;
const scopeOf = (phase, task = null, iteration = 1) => ({ phase, attempt: 1, task, iteration });
const describe = (entry) => `role ${entry.roleSequence} ${entry.role}${entry.scope.task === null ? '' : ` Task ${entry.scope.task}`} iteration ${entry.scope.iteration}`;
const lineOf = (value) => String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'unspecified';

function createContext({ repoRoot, specName, contract, runId, recoveryInput, engineRoot = ENGINE_ROOT, services = {} }) {
  if (typeof services.runner?.prepare !== 'function') throw new TypeError('controller requires an injected role runner');
  return {
    root: repoRoot, specName, contract, requestedRunId: runId, requestedRecovery: recoveryInput ?? null, engineRoot,
    recovery: false, recoveryDigest: null, indexProtocol: CONTROLLER_CONTRACT.taskResultIndexProtocol,
    paths: controllerPaths(specName),
    runner: services.runner,
    git: services.git ?? createGitService(),
    crash: services.crash ?? (() => {}),
    log: services.log ?? (() => {}),
    evidenceGate: services.reviewEvidenceGate ?? defaultReviewEvidenceGate,
    run: null, state: null, pending: [],
  };
}

function refresh(ctx) {
  const current = readAutopilotRun(ctx.root, ctx.paths.dir);
  ctx.run = current.run;
  ctx.state = current.state;
  ctx.events = current.events;
  ctx.pending = current.pendingResponses;
}

function halt(ctx, reason, { reconciliation = false, scope = null } = {}) {
  const clean = lineOf(reason);
  if (reconciliation) appendAutopilotEvent(ctx.root, ctx.paths.dir, { event: 'RECONCILIATION_REQUIRED', scope, reason: clean });
  appendAutopilotEvent(ctx.root, ctx.paths.dir, { event: 'RUN_HALTED', reason: clean });
  refresh(ctx);
  throw new ControllerHalt(clean);
}

// Turns a helper's evidence or drift refusal into a recorded halt with the
// helper's own diagnosis. Crash hooks are never called inside these regions.
function gate(ctx, label, action, options) {
  try { return action(); } catch (error) {
    if (error instanceof ControllerHalt || error instanceof ControllerRefusal) throw error;
    return halt(ctx, label ? `${label}: ${error.message}` : error.message, options);
  }
}

function refusing(label, action) {
  try { return action(); } catch (error) {
    if (error instanceof ControllerHalt || error instanceof ControllerRefusal) throw error;
    throw new ControllerRefusal(lineOf(label ? `${label}: ${error.message}` : error.message));
  }
}

function startOrResume(ctx) {
  const { root, paths } = ctx;
  if (optionalWork(root, paths.run, 'autopilot-run') === null) {
    createAutopilotRun(root, paths.dir, {
      runId: ctx.requestedRunId, branch: ctx.contract.branch, baseline: ctx.git.head(root),
      runtime: fingerprintAutopilotRuntime(ctx.engineRoot),
    }, { engineRoot: ctx.engineRoot });
    refresh(ctx);
    ctx.crash('run-created', {});
    return;
  }
  try {
    reconcileAutopilotStart(root, paths.dir, ctx.engineRoot);
  } catch (error) {
    if (!/orphan role reservation requires reconciliation/.test(error.message)) throw error;
    // A complete orphan reservation is a spent identity; adopting it never dispatches.
    reconcileAutopilotReservation(root, paths.dir, { engineRoot: ctx.engineRoot });
  }
  refresh(ctx);
}

function roleIn(ctx, scope, role) {
  return ctx.state.roles.find((entry) => sameScope(entry.scope, scope) && entry.role === role);
}

function contractFor(ctx, roleSequence) {
  const { contract } = ctx;
  return {
    verdict: contract.verdict, gear: contract.gear, drive: contract.drive, branch: contract.branch,
    commitAuth: contract.commitAuth, harness: contract.harness, blastRadius: contract.blastRadius,
    logMode: contract.logMode, ...CONTROLLER_CONTRACT, taskResultIndexProtocol: ctx.indexProtocol,
    ...(ctx.recovery ? { recoveryInputDigest: ctx.recoveryDigest } : {}), roleSequence, responseFormat: 'text',
  };
}

function rolePrompt(ctx, role, roleSequence, scope, manifestPath) {
  const prompts = ROLE_PROMPTS[role].map((path) => join(ctx.engineRoot, path));
  return [
    `Steepy controller protocol 2 role ${role}: run-id \`${ctx.state.runId}\`, role-sequence \`${roleSequence}\`,`,
    `phase \`${scope.phase}\`, attempt \`${scope.attempt}\`, ${scope.task === null ? 'whole-branch scope' : `task \`${scope.task}\``}, iteration \`${scope.iteration}\`.`,
    `Apply the packaged instructions ${prompts.join(' and ')}; do not invoke an installed skill by name.`,
    `Context manifest: ${manifestPath} (authoritative input inventory). Read required inputs; use onDemand only for a concrete missing fact.`,
    'Unattended autopilot: never ask questions or wait for a human; never push, bump versions, open PRs, commit, or write controller state.',
    'Return only the closed response payload selected by the manifest contract.',
  ].join(' ');
}

function digestOf(ctx, path, family) {
  const bytes = optionalWork(ctx.root, path, family);
  return bytes === null ? null : sha(bytes);
}

// Reservation, then role effects, then the immutable manifest, then dispatch.
// The journal and run identity are checked even when the child fails; a changed
// journal is never repaired from the child's messages. A rewritten projection
// needs no check: every event publication re-renders it from valid events.
async function dispatchRole(ctx, spec) {
  const { root, paths } = ctx;
  const roleSequence = ctx.state.roles.length + 1;
  const manifestPath = `${paths.dir}/context/role-${roleSequence}.json`;
  const prompt = rolePrompt(ctx, spec.role, roleSequence, spec.scope, manifestPath);
  const displayName = `steepy-${ctx.specName}-${spec.role}-r${roleSequence}-${ctx.state.runId.slice(0, 8).toLowerCase()}`;
  const label = `role ${roleSequence} ${spec.role}`;
  const prepared = refusing(`${label} descriptor`, () => ctx.runner.prepare({
    role: spec.role, roleSequence, scope: spec.scope, prompt, manifestPath, modelTier: spec.modelTier, displayName,
    runId: ctx.state.runId,
  }));
  reserveAutopilotRole(root, paths.dir, {
    scope: spec.scope, role: spec.role, correctionOf: spec.correctionOf ?? null,
    expectedReceiptPath: spec.expectedReceiptPath,
    requestedModel: prepared.requestedModel ?? null, descriptorModel: prepared.descriptorModel ?? null,
    degradationReason: prepared.degradationReason ?? null,
  });
  refresh(ctx);
  ctx.crash('role-reserved', { roleSequence, role: spec.role });
  const entry = () => ctx.state.roles.find((item) => item.roleSequence === roleSequence);
  gate(ctx, `${label} preparation`, () => {
    spec.effects?.(roleSequence);
    writeContextManifest(spec.manifest(roleSequence), { repoRoot: root, manifestPath, createOnly: true });
  }, { reconciliation: true, scope: spec.scope });
  ctx.crash('manifest-published', { roleSequence, role: spec.role });
  const guard = { journal: digestOf(ctx, paths.events, 'autopilot-events'), run: digestOf(ctx, paths.run, 'autopilot-run') };
  ctx.log(`${label} dispatched${spec.scope.task === null ? '' : ` for Task ${spec.scope.task}`} (iteration ${spec.scope.iteration})`);
  let outcome;
  try {
    outcome = await prepared.run({ rawPath: `${paths.dir}/role-${roleSequence}.raw.jsonl`, readablePath: `${paths.dir}/role-${roleSequence}.log` });
  } catch (error) {
    outcome = { payload: null, reason: 'runner-error', transportError: error.message, exit: { status: null, signal: null } };
  }
  ctx.crash('runner-returned', { roleSequence, role: spec.role });
  if (digestOf(ctx, paths.events, 'autopilot-events') !== guard.journal || digestOf(ctx, paths.run, 'autopilot-run') !== guard.run) {
    throw new Error(`autopilot journal or run identity changed while ${label} was in flight; refusing to repair it from the child's response`);
  }
  const record = responseRecord(roleSequence, spec.role, outcome, digestOf(ctx, `${paths.dir}/role-${roleSequence}.raw.jsonl`, 'role-raw'));
  // Only the controller writes a role's capture and receipt. A child-authored
  // one is never adopted: halt with it named beside the real transport outcome.
  const forged = [[`${paths.dir}/role-${roleSequence}-response.json`, 'role-response'], [`${paths.dir}/role-${roleSequence}-receipt.json`, 'role-receipt']]
    .filter(([path, family]) => optionalWork(root, path, family) !== null).map(([path]) => path);
  if (forged.length > 0) {
    halt(ctx, [`${describe(entry())}: the child wrote controller capture ${forged.join(', ')}`, ...transportProblems(record)].join('; '),
      { reconciliation: true, scope: spec.scope });
  }
  captureAutopilotResponse(root, paths.dir, roleSequence, `${JSON.stringify(record)}\n`, { observedModel: record.observedModel });
  refresh(ctx);
  ctx.crash('response-captured', { roleSequence, role: spec.role });
  return entry();
}

// The response recorded for a reserved role. A reservation without a captured
// response never earns another dispatch: the child may already have acted. A
// response file whose capture event was lost is adopted only when it binds the
// current controller-side raw capture; anything else may be child-authored.
function capturedRecord(ctx, entry) {
  if (!entry.responseCaptured) {
    if (!ctx.pending.includes(entry.roleSequence)) {
      halt(ctx, `${describe(entry)} was reserved without a captured response; refusing to dispatch it again`,
        { reconciliation: true, scope: entry.scope });
    }
    const bytes = readWorkPath(ctx.root, `${ctx.paths.dir}/role-${entry.roleSequence}-response.json`, { family: 'role-response' });
    let pending = null;
    try { pending = parseResponseRecord(bytes, entry); } catch { /* not a controller record */ }
    if (pending === null || pending.rawDigest === null
      || pending.rawDigest !== digestOf(ctx, `${ctx.paths.dir}/role-${entry.roleSequence}.raw.jsonl`, 'role-raw')) {
      halt(ctx, `${describe(entry)} was reserved without a captured response; refusing to adopt an uncorroborated response file or dispatch it again`,
        { reconciliation: true, scope: entry.scope });
    }
    captureAutopilotResponse(ctx.root, ctx.paths.dir, entry.roleSequence, bytes, { observedModel: pending.observedModel });
    refresh(ctx);
  }
  const bytes = readWorkPath(ctx.root, `${ctx.paths.dir}/role-${entry.roleSequence}-response.json`, { family: 'role-response' });
  return gate(ctx, describe(entry), () => parseResponseRecord(bytes, entry), { reconciliation: true, scope: entry.scope });
}

function assertCheckout(ctx, label) {
  const branch = ctx.git.branch(ctx.root);
  if (branch !== ctx.run.branch) halt(ctx, `${label}: checkout moved to "${branch}" outside the run branch "${ctx.run.branch}"`, { reconciliation: true });
}

function ensurePhase(ctx, scope) {
  if (!ctx.state.phases.some((phase) => sameScope(phase.scope, scope))) {
    appendAutopilotEvent(ctx.root, ctx.paths.dir, { event: 'PHASE_RESERVED', scope });
    refresh(ctx);
    ctx.crash('phase-reserved', { phase: scope.phase });
  }
  return ctx.state.phases.find((phase) => sameScope(phase.scope, scope)).accepted;
}

function acceptPhase(ctx, scope) {
  appendAutopilotEvent(ctx.root, ctx.paths.dir, { event: 'PHASE_ACCEPTED', scope });
  refresh(ctx);
  ctx.crash('phase-accepted', { phase: scope.phase });
}

function readText(ctx, path, family) {
  return readWorkPath(ctx.root, path, { family, encoding: 'utf8' });
}

function roleReceipt(ctx, entry) {
  return JSON.parse(readWorkPath(ctx.root, entry.receiptPath, { family: 'role-receipt' }).toString('utf8'));
}

// The lifecycle header of an artifact the controller already accepted or
// published; a missing or malformed header is named publication drift.
function publishedHeader(ctx, label, text) {
  let header = null;
  try { header = lifecycleOf(text); } catch (error) {
    halt(ctx, `${label} publication drift: ${error.message}`, { reconciliation: true });
  }
  if (header === null) halt(ctx, `${label} publication drift: lifecycle header missing`, { reconciliation: true });
  return header;
}

// A published DRAFT-sourced artifact is bound by its receipt: restoring the
// DRAFT lifecycle values must reproduce the accepted source digest exactly.
function assertPublished(ctx, label, text, entry, draft) {
  const header = publishedHeader(ctx, label, text);
  if (sha(Buffer.from(withLifecycle(text, draft))) !== roleReceipt(ctx, entry).sourceDigest) {
    halt(ctx, `${label} publication drift: its content no longer matches the accepted DRAFT receipt`, { reconciliation: true });
  }
  return header;
}

function specRoute(ctx) {
  const text = readWorkPath(ctx.root, ctx.paths.spec, { expect: 'spec', encoding: 'utf8' });
  return specPhaseContext(text);
}

function routing(ctx) {
  const routingText = readStableDocument(ctx.root, CONTROLLER_ROUTING_PATH, 'routing index');
  return { routingText, standardsBySurface: standardsBySurfaceFromRouting(routingText, { repoRoot: ctx.root }) };
}

// A headered spec is the plan's brainstorm input: READY and unconsumed before
// publication, or already consumed by exactly this plan. Headerless specs carry
// no lifecycle. Checked before the run or plan role exists (a refusal) and at
// publication (a halt).
function specInput(ctx) {
  const text = readWorkPath(ctx.root, ctx.paths.spec, { expect: 'spec', encoding: 'utf8' });
  const header = lifecycleOf(text);
  if (header !== null && (header.phase !== 'brainstorm' || header.next !== 'plan'
    || !(header.status === 'READY' && header['consumed-by'] === 'none'
      || header.status === 'CONSUMED' && header['consumed-by'] === ctx.paths.plan))) {
    throw new Error(`spec lifecycle is not a READY brainstorm input for ${ctx.paths.plan}`);
  }
  return { text, header };
}

function planInputs(ctx) {
  refusing(null, () => specInput(ctx));
  const route = refusing('plan context', () => specRoute(ctx));
  const { standardsBySurface } = refusing('plan context', () => routing(ctx));
  return { route, standardsBySurface };
}

async function planPhase(ctx) {
  const scope = scopeOf('plan');
  if (ensurePhase(ctx, scope)) return;
  const { paths, root } = ctx;
  let entry = roleIn(ctx, scope, 'plan');
  if (!entry) {
    const { route, standardsBySurface } = planInputs(ctx);
    entry = await dispatchRole(ctx, {
      scope, role: 'plan', modelTier: route.modelTier,
      manifest: (roleSequence) => buildPlanManifest({
        repoRoot: root, runId: ctx.state.runId, attempt: 1, modelTier: route.modelTier,
        specPath: paths.spec, routingPath: CONTROLLER_ROUTING_PATH, testingPath: '.apex/testing-and-checklist.md',
        owningSurface: route.owningSurface, crossCuttingSurfaces: route.crossCuttingSurfaces, standardsBySurface,
        onUnroutedSurface: () => {}, otherHubPaths: ['.apex/conventions.md'], outputs: [paths.plan],
        contract: contractFor(ctx, roleSequence),
      }),
    });
  }
  if (!entry.accepted) {
    const record = capturedRecord(ctx, entry);
    assertCheckout(ctx, describe(entry));
    const diagnosis = transportDiagnosis(describe(entry), record);
    if (diagnosis) halt(ctx, diagnosis);
    const verdict = gate(ctx, `${describe(entry)} response rejected`, () => decodePhaseResponse(record.payload, 'plan'));
    if (verdict.status !== 'DONE') halt(ctx, `${describe(entry)} returned ${verdict.status} (signals: ${verdict.signals})`);
    gate(ctx, `${describe(entry)} changed repository source`, () => {
      if (ctx.git.dirty(root) || ctx.git.head(root) !== ctx.run.baseline) throw new Error('the plan role is read-only on source');
    }, { reconciliation: true });
    const draft = gate(ctx, 'plan rejected', () => {
      const bytes = readWorkPath(root, paths.plan, { family: 'plan' });
      const header = lifecycleOf(bytes.toString('utf8'));
      if (!header || header.phase !== 'plan' || header.status !== 'DRAFT' || header.next !== 'implement'
        || header.source !== paths.spec || header['consumed-by'] !== 'none') {
        throw new Error(`the assigned plan must carry a DRAFT plan lifecycle header sourced from ${paths.spec}`);
      }
      controllerPlanContext({ repoRoot: root, planText: bytes.toString('utf8') });
      return bytes;
    });
    acceptAutopilotResult(root, paths.dir, entry.roleSequence, { path: paths.plan, digest: sha(draft) }, {
      verifyReceipt: (bytes, _path, invocation) => {
        controllerPlanContext({ repoRoot: root, planText: bytes.toString('utf8') });
        return { ...invocation, accepted: true };
      },
    });
    refresh(ctx);
    ctx.crash('result-accepted', { roleSequence: entry.roleSequence, role: 'plan' });
    entry = roleIn(ctx, scope, 'plan');
  }
  publishPlan(ctx, entry);
  acceptPhase(ctx, scope);
}

function publishPlan(ctx, entry) {
  const { paths, root } = ctx;
  const text = readText(ctx, paths.plan, 'plan');
  const header = assertPublished(ctx, 'plan', text, entry, { status: 'DRAFT', 'consumed-by': 'none' });
  if (header.status === 'DRAFT') {
    writeWorkPath(root, paths.plan, withLifecycle(text, { status: 'READY' }), { family: 'plan' });
    ctx.crash('plan-published', {});
  } else if (!['READY', 'CONSUMED'].includes(header.status)) halt(ctx, `plan publication has invalid status ${header.status}`, { reconciliation: true });
  const spec = gate(ctx, null, () => specInput(ctx), { reconciliation: true });
  if (spec.header?.status === 'READY') {
    writeWorkPath(root, paths.spec, withLifecycle(spec.text, { status: 'CONSUMED', 'consumed-by': paths.plan }), { expect: 'spec' });
  }
}

function loadPlan(ctx) {
  const planText = readText(ctx, ctx.paths.plan, 'plan');
  const context = gate(ctx, 'plan rejected', () => controllerPlanContext({ repoRoot: ctx.root, planText }));
  return { planText, ...context };
}

const writerRoles = (ctx, task) => ctx.state.roles.filter((entry) => ['implementer', 'fix'].includes(entry.role)
  && entry.scope.phase === 'implement' && entry.scope.task === Number(task));
const stateOf = (entry) => entry.expectedReceiptPath.slice(0, -'-result.json'.length);
const guardOf = (ctx, scope) => `${ctx.paths.dir}/${scope.phase === 'final-review' ? 'final' : `task-${scope.task}`}-review-guard-attempt-${scope.attempt}-iteration-${scope.iteration}`;

function latestAcceptedWriter(ctx, task = null) {
  return ctx.state.roles.filter((entry) => ['implementer', 'fix'].includes(entry.role) && entry.accepted
    && (task === null || entry.scope.task === Number(task))).at(-1) ?? null;
}

function ensureIndex(ctx) {
  const { paths } = ctx;
  const text = optionalWork(ctx.root, paths.index, 'task-result-index');
  if (text === null) {
    writeWorkPath(ctx.root, paths.index, `<!-- steepy-workflow: v1\nphase: implement\nstatus: DRAFT\nnext: review\nsource: ${paths.plan}\nconsumed-by: none\n-->\n# Task results\n\n`,
      { family: 'task-result-index', createOnly: true });
    return;
  }
  const header = gate(ctx, 'task-result index', () => lifecycleOf(text.toString('utf8')));
  if (!header || header.phase !== 'implement' || header.source !== paths.plan) {
    halt(ctx, 'task-result index lifecycle does not bind the run plan', { reconciliation: true });
  }
}

const importOf = (ctx, task) => ctx.state.imports.find((item) => item.scope.task === Number(task)) ?? null;

// Each task's current evidence: its latest accepted execution, otherwise its import.
function indexEvidence(ctx, plan) {
  const states = [];
  const imports = [];
  for (const task of plan.tasks) {
    const writer = latestAcceptedWriter(ctx, task.task);
    if (writer) states.push(stateOf(writer));
    else if (importOf(ctx, task.task)) imports.push(importOf(ctx, task.task).path);
  }
  return { states, imports, protocol: ctx.indexProtocol };
}

function projectIndex(ctx, plan) {
  gate(ctx, 'task-result projection', () => projectTaskResults(ctx.root, { indexPath: ctx.paths.index, ...indexEvidence(ctx, plan) }),
    { reconciliation: true });
}

function taskBinding(ctx, plan, task, roleSequence, modelTier) {
  return {
    controllerProtocol: CONTROLLER_PROTOCOL, repoRoot: ctx.root, planText: plan.planText, taskId: task.task,
    routingText: plan.routingText, standardsBySurface: plan.standardsBySurface, sourcePlanPath: ctx.paths.plan,
    briefPath: `${ctx.paths.dir}/task-${task.task}-brief.md`, runId: ctx.state.runId, attempt: 1, modelTier,
    contract: contractFor(ctx, roleSequence),
  };
}

// The task diff starts where the task started: its first execution, or the
// historical task baseline its verified import carries.
function writeTaskDiff(ctx, task) {
  const imported = importOf(ctx, task);
  const first = `${ctx.paths.dir}/task-${task}-execution-1-baseline.json`;
  const base = imported ? inspectTaskImport(ctx.root, imported.path).taskBefore.head
    : JSON.parse(readWorkPath(ctx.root, first, { family: 'task-result' }).toString('utf8')).taskBefore.head;
  return captureBranchDiff({ cwd: ctx.root, baseline: base, outputPath: `${ctx.paths.dir}/task-${task}-diff.txt`, family: 'task-diff' }).path;
}

// An imported task's import is its first evidence: its first fix is
// execution 2 and continues the import through a digest-bound link.
async function dispatchWriter(ctx, plan, task, role, iteration, fix = null) {
  const { root, paths } = ctx;
  const imported = importOf(ctx, task.task);
  const prior = writerRoles(ctx, task.task).length;
  const execution = prior + (imported ? 2 : 1);
  const state = `${paths.dir}/task-${task.task}-execution-${execution}`;
  const parent = latestAcceptedWriter(ctx);
  const modelTier = TIER[task.complexity];
  gate(ctx, `Task ${task.task} brief`, () => ensureControllerTaskBrief(taskBinding(ctx, plan, task, 0, modelTier)),
    { reconciliation: true });
  const entry = await dispatchRole(ctx, {
    scope: scopeOf('implement', Number(task.task), iteration), role, modelTier,
    expectedReceiptPath: `${state}-result.json`,
    effects: () => beginTask(root, state, {
      runId: ctx.state.runId, attempt: 1, task: task.task, execution, role,
      report: `${paths.dir}/task-${task.task}-report.md`, planPath: paths.plan,
      previousState: prior === 0 ? null : `${paths.dir}/task-${task.task}-execution-${execution - 1}`,
      ...(imported && prior === 0 ? { previousImport: imported.path } : {}),
      parentState: parent === null ? null : stateOf(parent), format: 'text',
    }),
    manifest: (roleSequence) => buildControllerTaskManifest(role, {
      ...taskBinding(ctx, plan, task, roleSequence, modelTier),
      outputs: [`${paths.dir}/task-${task.task}-report.md`],
      ...(fix === null ? {} : { issuePath: fix.issuePath, taskDiffPath: fix.diffPath() }),
    }),
  });
  await settleWriter(ctx, plan, task, entry);
}

// The controller owns commits: authorized source writes are committed inside
// the observed execution, after the response is durable and before capture.
// The deterministic subject makes an interrupted commit recognizable on resume.
function commitWriter(ctx, entry, task, execution) {
  const subject = `steepy autopilot: Task ${task} execution ${execution} (run ${ctx.state.runId} role ${entry.roleSequence})`;
  if (ctx.git.headSubject(ctx.root) === subject) {
    if (ctx.git.dirty(ctx.root)) halt(ctx, `${describe(entry)}: source changed after the controller commit`, { reconciliation: true });
    return;
  }
  if (!ctx.git.dirty(ctx.root)) return;
  gate(ctx, `${describe(entry)} commit`, () => ctx.git.commitAll(ctx.root, subject), { reconciliation: true });
  ctx.crash('committed', { roleSequence: entry.roleSequence, role: entry.role });
}

async function settleWriter(ctx, plan, task, entry) {
  if (entry.accepted) return;
  const state = stateOf(entry);
  const execution = Number(/-execution-(\d+)$/.exec(state)[1]);
  const record = capturedRecord(ctx, entry);
  assertCheckout(ctx, describe(entry));
  const pending = gate(ctx, describe(entry), () => inspectTaskResult(ctx.root, state, { checkCurrent: false }), { reconciliation: true });
  if (pending.status === 'PENDING' && pending.recoverableCapture) {
    // A complete durable capture finishes publication without redispatch.
    gate(ctx, describe(entry), () => resumeTaskResult(ctx.root, state), { reconciliation: true });
  } else if (pending.status === 'PENDING') {
    const diagnosis = transportDiagnosis(describe(entry), record);
    if (diagnosis) halt(ctx, diagnosis);
    commitWriter(ctx, entry, task.task, execution);
    gate(ctx, describe(entry), () => recordTaskResult(ctx.root, state, record.payload), { reconciliation: true });
    ctx.crash('task-recorded', { roleSequence: entry.roleSequence, role: entry.role });
  }
  const facts = gate(ctx, describe(entry), () => inspectTaskResult(ctx.root, state), { reconciliation: true });
  if (!facts.accepted) {
    halt(ctx, facts.retryable
      ? `${describe(entry)} returned ${facts.status}; see ${facts.artifact}`
      : `${describe(entry)} response rejected: ${facts.reason}`);
  }
  const receiptPath = `${state}-result.json`;
  const bytes = readWorkPath(ctx.root, receiptPath, { family: 'task-result' });
  acceptAutopilotResult(ctx.root, ctx.paths.dir, entry.roleSequence, { path: receiptPath, digest: sha(bytes) }, {
    verifyReceipt: (_bytes, _path, invocation) => {
      const current = inspectTaskResult(ctx.root, state);
      if (!current.accepted || current.config.runId !== ctx.state.runId || current.config.attempt !== entry.scope.attempt
        || current.config.task !== String(entry.scope.task) || current.config.role !== entry.role
        || current.config.execution !== execution) throw new Error('task result receipt does not bind this writer invocation');
      return { ...invocation, accepted: true };
    },
  });
  refresh(ctx);
  ctx.crash('result-accepted', { roleSequence: entry.roleSequence, role: entry.role });
  projectIndex(ctx, plan);
}

function bindReference(ctx, task, state) {
  const label = task === 'final' ? 'final' : `Task ${task}`;
  const index = readText(ctx, ctx.paths.index, 'task-result-index');
  const current = new RegExp(`^Reviewer gate ${label}: (\\S+)$`, 'm').exec(index)?.[1] ?? null;
  setReviewReference(ctx.root, { indexPath: ctx.paths.index, state, previousState: current });
}

const correctionRole = (role) => (role === 'final-review' ? 'final-review-correction' : 'task-review-correction');

function guardResult(ctx, path) {
  return JSON.parse(readWorkPath(ctx.root, path, { family: 'review-guard' }).toString('utf8'));
}

function acceptReviewer(ctx, entry, guard, receiptPath) {
  const bytes = readWorkPath(ctx.root, receiptPath, { family: 'review-guard' });
  const task = entry.scope.task === null ? 'final' : String(entry.scope.task);
  acceptAutopilotResult(ctx.root, ctx.paths.dir, entry.roleSequence, { path: receiptPath, digest: sha(bytes) }, {
    verifyReceipt: (stored, _path, invocation) => {
      const result = inspectReview(ctx.root, guard);
      const { config } = JSON.parse(stored.toString('utf8'));
      if (!result.accepted || !['APPROVED', 'ISSUES_FOUND'].includes(result.status)
        || config.runId !== ctx.state.runId || config.attempt !== entry.scope.attempt
        || config.iteration !== entry.scope.iteration || config.task !== task) {
        throw new Error('reviewer receipt does not bind an accepted verdict for this invocation');
      }
      return { ...invocation, accepted: true };
    },
  });
  refresh(ctx);
  ctx.crash('result-accepted', { roleSequence: entry.roleSequence, role: entry.role });
}

// One captured reviewer response, through the v3 gate, at most one reserved
// response-only correction, and receipt-bound acceptance. Returns the verdict.
async function settleReview(ctx, reviewer, correctionManifest) {
  const guard = guardOf(ctx, reviewer.scope);
  const original = `${guard}-original.json`;
  const corrected = `${guard}-corrected.json`;
  if (reviewer.accepted) return guardResult(ctx, original).status;
  let correction = roleIn(ctx, reviewer.scope, correctionRole(reviewer.role));
  if (correction?.accepted) return guardResult(ctx, corrected).status;
  if (!correction) {
    const record = capturedRecord(ctx, reviewer);
    assertCheckout(ctx, describe(reviewer));
    let result;
    if (optionalWork(ctx.root, original, 'review-guard') === null) {
      const diagnosis = transportDiagnosis(describe(reviewer), record);
      if (diagnosis) halt(ctx, diagnosis);
      result = gate(ctx, describe(reviewer), () => checkReview(ctx.root, guard, record.payload), { reconciliation: true });
      ctx.crash('review-checked', { roleSequence: reviewer.roleSequence, role: reviewer.role });
    } else {
      result = gate(ctx, describe(reviewer), () => inspectReview(ctx.root, guard), { reconciliation: true });
    }
    if (result.accepted) {
      acceptReviewer(ctx, reviewer, guard, original);
      return result.status;
    }
    if (result.status !== 'REPAIRABLE') {
      halt(ctx, `${describe(reviewer)} ${result.reason ? `blocked by the reviewer gate: ${result.reason}` : `returned ${result.status}`}`);
    }
    correction = await dispatchRole(ctx, {
      scope: reviewer.scope, role: correctionRole(reviewer.role), correctionOf: reviewer.roleSequence,
      expectedReceiptPath: corrected, modelTier: REVIEWER_TIER,
      effects: () => { if (optionalWork(ctx.root, `${guard}-reserved.json`, 'review-guard') === null) reserveRepair(ctx.root, guard); },
      manifest: () => correctionManifest(original),
    });
  }
  const record = capturedRecord(ctx, correction);
  assertCheckout(ctx, describe(correction));
  let result;
  if (optionalWork(ctx.root, corrected, 'review-guard') === null) {
    const diagnosis = transportDiagnosis(describe(correction), record);
    if (diagnosis) halt(ctx, diagnosis);
    result = gate(ctx, describe(correction), () => checkReview(ctx.root, guard, record.payload, true), { reconciliation: true });
    ctx.crash('review-checked', { roleSequence: correction.roleSequence, role: correction.role });
  } else {
    result = gate(ctx, describe(correction), () => inspectReview(ctx.root, guard), { reconciliation: true });
  }
  if (!result.accepted) {
    halt(ctx, `${describe(correction)} ${result.reason ? `blocked by the reviewer gate: ${result.reason}` : `returned ${result.status}`}`);
  }
  acceptReviewer(ctx, correction, guard, corrected);
  return result.status;
}

// Reviews the task's current evidence: the latest accepted execution, or (with
// no execution yet) the verified import, which is never approval by itself.
async function reviewTask(ctx, plan, task, writer, iteration) {
  const { root, paths } = ctx;
  const imported = writer === null ? importOf(ctx, task.task) : null;
  const scope = scopeOf('review', Number(task.task), iteration);
  const guard = guardOf(ctx, scope);
  const report = `${paths.dir}/task-${task.task}-review.md`;
  const issues = `${paths.dir}/task-${task.task}-issues.md`;
  const correctionManifest = (original) => buildTaskReviewCorrectionManifest({
    repoRoot: root, runId: ctx.state.runId, attempt: 1, task: Number(task.task), modelTier: REVIEWER_TIER,
    originalReceiptPath: original, reportPath: report, issuePath: issues,
  });
  let reviewer = roleIn(ctx, scope, 'task-reviewer');
  if (!reviewer) {
    // An imported task is reviewed before any writer has published its brief.
    gate(ctx, `Task ${task.task} brief`, () => ensureControllerTaskBrief(taskBinding(ctx, plan, task, 0, TIER[task.complexity])),
      { reconciliation: true });
    const taskDiffPath = gate(ctx, `Task ${task.task} diff`, () => writeTaskDiff(ctx, task.task), { reconciliation: true });
    const importReport = imported && gate(ctx, `Task ${task.task} import`, () => inspectTaskImport(root, imported.path).report.path,
      { reconciliation: true });
    reviewer = await dispatchRole(ctx, {
      scope, role: 'task-reviewer', modelTier: taskReviewerTier(task),
      effects: () => beginReview(root, guard, {
        runId: ctx.state.runId, attempt: 1, iteration: scope.iteration, task: task.task, report, issues,
        format: 'text', ...(imported ? { import: imported.path } : { execution: stateOf(writer) }), reviewerResponseProtocol: 3,
      }),
      manifest: (roleSequence) => buildControllerTaskManifest('task-reviewer', {
        ...taskBinding(ctx, plan, task, roleSequence, taskReviewerTier(task)),
        reportPath: imported ? importReport : `${paths.dir}/task-${task.task}-report.md`,
        ...(imported ? { importPath: imported.path } : {}), taskDiffPath, outputs: [report, issues],
      }),
    });
  }
  const verdict = await settleReview(ctx, reviewer, correctionManifest);
  if (verdict === 'APPROVED') bindReference(ctx, task.task, guard);
  return verdict;
}

// Writer → review → fix until the task's latest evidence is approved. A
// whole-branch fix (`after` the final review that requested it) re-enters the
// same loop; a mechanical task keeps its review waiver unless its evidence is,
// or continues, an import, which no review of this run has approved yet. An
// imported task never gets an implementer: its import is iteration 1.
async function settleTask(ctx, plan, task, wholeBranch = null) {
  const imported = importOf(ctx, task.task) !== null;
  for (;;) {
    const writers = writerRoles(ctx, task.task);
    const writer = writers.at(-1) ?? null;
    if (!writer && !imported) { await dispatchWriter(ctx, plan, task, 'implementer', 1); continue; }
    if (writer && !writer.accepted) { await settleWriter(ctx, plan, task, writer); continue; }
    const iteration = writer?.scope.iteration ?? 1;
    if (wholeBranch !== null && (writer === null || writer.roleSequence < wholeBranch.after)) {
      await dispatchWriter(ctx, plan, task, 'fix', iteration + 1,
        { issuePath: ctx.paths.finalIssues, diffPath: () => ctx.paths.branchDiff });
      continue;
    }
    if (task.complexity === 'mechanical' && !imported) return;
    const verdict = await reviewTask(ctx, plan, task, writer, iteration);
    if (verdict === 'APPROVED') return;
    await dispatchWriter(ctx, plan, task, 'fix', iteration + 1, {
      issuePath: `${ctx.paths.dir}/task-${task.task}-issues.md`,
      diffPath: () => writeTaskDiff(ctx, task.task),
    });
  }
}

// A recovery run's branch diff starts where the imported lineage started, so
// whole-branch review covers imported and new work alike.
function branchBase(ctx) {
  if (ctx.state.imports.length === 0) return ctx.run.baseline;
  return inspectTaskImport(ctx.root, ctx.state.imports[0].path).chainBase;
}

function materializeReviewInputs(ctx, plan) {
  gate(ctx, 'review inputs', () => {
    materializeSuccessCriteria({ repoRoot: ctx.root, specPath: ctx.paths.spec, outputPath: ctx.paths.criteria });
    projectTaskResults(ctx.root, { indexPath: ctx.paths.index, ...indexEvidence(ctx, plan) });
    captureBranchDiff({ cwd: ctx.root, baseline: branchBase(ctx), outputPath: ctx.paths.branchDiff });
  }, { reconciliation: true });
}

const finalRoles = (ctx) => ctx.state.roles.filter((entry) => entry.role === 'final-review');
const standardUnion = (plan) => [...new Set(plan.tasks.flatMap((task) => task.standardPaths))];

// Whole-branch role values come from the executable plan only, never from the
// compact parser (which strips backticks, `*`, and `_`): the exact test
// command the task briefs carry (absent when tasks declare several), the full
// command set the evidence gate binds, and the ordered criteria union.
function branchContract(plan) {
  const testCommands = [...new Set(plan.tasks.map((task) => task.testCommand))];
  return {
    testCommands,
    ...(testCommands.length === 1 ? { testCommand: testCommands[0] } : {}),
    criterionIds: [...new Set(plan.tasks.flatMap((task) => task.criterionIds))],
  };
}

async function finalReview(ctx, plan, iteration) {
  const { root, paths } = ctx;
  const scope = scopeOf('final-review', null, iteration);
  const guard = guardOf(ctx, scope);
  materializeReviewInputs(ctx, plan);
  const { testCommand, criterionIds } = branchContract(plan);
  return dispatchRole(ctx, {
    scope, role: 'final-review', modelTier: finalReviewerTier(plan),
    effects: () => {
      bindReference(ctx, 'final', guard);
      beginReview(root, guard, {
        runId: ctx.state.runId, attempt: 1, iteration, task: 'final', report: paths.finalReport,
        issues: paths.finalIssues, format: 'text', plan: paths.plan, index: paths.index, reviewerResponseProtocol: 3,
      });
    },
    manifest: (roleSequence) => buildFinalReviewManifest({
      repoRoot: root, runId: ctx.state.runId, attempt: 1, modelTier: finalReviewerTier(plan),
      criteriaPath: paths.criteria, taskResultIndexPath: paths.index, branchDiffPath: paths.branchDiff,
      standardPaths: standardUnion(plan), outputs: [paths.finalReport, paths.finalIssues],
      ...(testCommand === undefined ? {} : { testCommand }), criterionIds, contract: contractFor(ctx, roleSequence),
    }),
  });
}

// Finding IDs are the explicit IDs the issue artifact names outside its
// fix-target block; the strict mapping must cover each exactly once.
function finalTargets(ctx, plan) {
  return gate(ctx, 'final review fix targets rejected', () => {
    const text = readText(ctx, ctx.paths.finalIssues, 'review-artifact');
    const marker = text.search(/^steepy-fix-targets:/m);
    const block = marker < 0 ? '' : text.slice(marker);
    const ids = [...new Set([...block.matchAll(/"issueIds"\s*:\s*\[([^\]]*)\]/g)]
      .flatMap((match) => [...match[1].matchAll(/"([^"\\]+)"/g)].map((id) => id[1])))];
    const prose = marker < 0 ? text : text.slice(0, marker);
    for (const id of ids) {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`).test(prose)) throw new Error(`finding ${id} is not named in the issue artifact`);
    }
    const rows = parseFixTargets(text, { taskIds: plan.tasks.map((task) => task.task), findingIds: ids.length ? ids : ['<none>'] });
    return new Set(rows.map((row) => row.task));
  });
}

async function implementPhase(ctx) {
  const scope = scopeOf('implement');
  if (ensurePhase(ctx, scope)) return;
  if (ctx.recovery) assertRecoveryPlan(ctx, readText(ctx, ctx.paths.plan, 'plan'));
  const plan = loadPlan(ctx);
  ensureIndex(ctx);
  for (const task of plan.tasks) await settleTask(ctx, plan, task);
  const correctionManifest = (original) => buildFinalReviewCorrectionManifest({
    repoRoot: ctx.root, runId: ctx.state.runId, attempt: 1, modelTier: REVIEWER_TIER,
    originalReceiptPath: original, reportPath: ctx.paths.finalReport, issuePath: ctx.paths.finalIssues,
  });
  for (;;) {
    let final = finalRoles(ctx).at(-1);
    if (!final) final = await finalReview(ctx, plan, 1);
    const verdict = await settleReview(ctx, final, correctionManifest);
    if (verdict === 'APPROVED') break;
    const targets = finalTargets(ctx, plan);
    for (const task of plan.tasks.filter((item) => targets.has(item.task))) {
      await settleTask(ctx, plan, task, { after: final.roleSequence });
    }
    await finalReview(ctx, plan, final.scope.iteration + 1);
  }
  acceptImplement(ctx, plan);
}

// New provenance binds every execution to an accepted controller reservation
// and manifest; no legacy phase dispatch is fabricated.
function acceptImplement(ctx, plan) {
  const { root, paths } = ctx;
  if (ctx.state.roles.some((entry) => !entry.accepted && !entry.superseded)) {
    halt(ctx, 'implement acceptance found an unaccepted role', { reconciliation: true });
  }
  materializeReviewInputs(ctx, plan);
  const writers = new Map(ctx.state.roles.filter((entry) => ['implementer', 'fix'].includes(entry.role))
    .map((entry) => [entry.expectedReceiptPath, entry]));
  gate(ctx, 'implement acceptance', () => {
    const verified = verifyTaskResults(root, { indexPath: paths.index, expectedTasks: plan.tasks.map((task) => task.task),
      protocol: ctx.indexProtocol });
    for (const imported of verified.imports) {
      if (!ctx.state.imports.some((item) => item.path === imported.receipt && item.digest === imported.digest)) {
        throw new Error(`task import ${imported.receipt} lacks recovery registration provenance`);
      }
    }
    for (const execution of verified.executions) {
      const entry = writers.get(`${execution.state}-result.json`);
      if (!entry?.accepted || execution.config.runId !== ctx.state.runId || execution.config.attempt !== 1
        || execution.config.task !== String(entry.scope.task) || execution.config.role !== entry.role) {
        throw new Error(`task execution ${execution.state} lacks controller reservation provenance`);
      }
      const manifest = JSON.parse(readWorkPath(root, `${paths.dir}/context/role-${entry.roleSequence}.json`, { family: 'manifest' }).toString('utf8'));
      if (manifest.contract?.controllerProtocol !== CONTROLLER_PROTOCOL || manifest.contract.roleSequence !== entry.roleSequence
        || manifest.contract.taskResultProtocol !== 2 || manifest.contract.taskResultIndexProtocol !== ctx.indexProtocol) {
        throw new Error(`task execution ${execution.state} manifest provenance mismatch`);
      }
    }
    const final = finalRoles(ctx).at(-1);
    const result = inspectReview(root, guardOf(ctx, final.scope));
    if (!result.accepted || result.status !== 'APPROVED') throw new Error('final reviewer gate is not approved');
  }, { reconciliation: true });
  const planText = readText(ctx, paths.plan, 'plan');
  // A recovery plan has no plan role: it is bound by re-deriving the prepared copy.
  const planHeader = ctx.recovery ? assertRecoveryPlan(ctx, planText)
    : assertPublished(ctx, 'plan', planText, roleIn(ctx, scopeOf('plan'), 'plan'), { status: 'DRAFT', 'consumed-by': 'none' });
  const index = readText(ctx, paths.index, 'task-result-index');
  if (publishedHeader(ctx, 'task-result index', index).status === 'DRAFT') {
    writeWorkPath(root, paths.index, withLifecycle(index, { status: 'READY' }), { family: 'task-result-index' });
  }
  if (planHeader.status === 'READY') {
    writeWorkPath(root, paths.plan, withLifecycle(planText, { status: 'CONSUMED', 'consumed-by': paths.index }), { family: 'plan' });
  }
  acceptPhase(ctx, scopeOf('implement'));
}

// Parses the exact capture-review-evidence.mjs layout: each command section is
// located by its recorded output length and digest, so command output can
// never forge a trailer, exit code, or collection result.
function evidenceSections(bytes) {
  const incomplete = () => { throw new Error('evidence report is not one complete surface-test and validate-hub collection'); };
  const head = /^# Review evidence\n\nRun started: ([^\n]+)\nCapture: [^\n]*\n/.exec(bytes.toString('latin1'));
  if (!head) incomplete();
  let cursor = Buffer.byteLength(head[0], 'latin1');
  const sections = {};
  for (const label of ['surface-test', 'validate-hub']) {
    const opening = new RegExp(`^\\n## ${label}\\n\\nCommand JSON: ([^\\n]*)\\nStarted: [^\\n]+\\n\\n--- combined stdout/stderr begin ---\\n`)
      .exec(bytes.subarray(cursor).toString('latin1'));
    if (!opening) incomplete();
    const start = cursor + opening[0].length;
    const closing = /\n--- combined stdout\/stderr end ---\n\nExit code: ([^\n]+)\nSignal: ([^\n]+)\nSpawn error: ([^\n]+)\nOutput bytes: (\d+)\nOutput lines: \d+\nOutput SHA-256: ([0-9a-f]{64})\nFinished: [^\n]+\n/g;
    const tail = bytes.subarray(start).toString('latin1');
    let match;
    let section = null;
    while ((match = closing.exec(tail)) !== null) {
      const size = Number(match[4]);
      const padded = size > 0 && bytes[start + size - 1] !== 0x0a ? 1 : 0;
      if (match.index === size + padded && start + size <= bytes.length
        && sha(bytes.subarray(start, start + size)) === match[5]) {
        section = { command: JSON.parse(Buffer.from(opening[1], 'latin1').toString('utf8')), exit: match[1], signal: match[2],
          spawnError: match[3] };
        cursor = start + match.index + match[0].length;
        break;
      }
    }
    if (section === null) incomplete();
    sections[label] = section;
  }
  const result = /^## Collection result\n\nRun finished: [^\n]+\nAll commands passed: (true|false)\n$/.exec(bytes.subarray(cursor).toString('latin1'));
  if (!result) incomplete();
  return { runStarted: head[1], sections, allPassed: result[1] === 'true' };
}

// Fresh evidence for this review role: the plan's exact surface test command
// and the coherence gate, both exiting 0, collected after the role was reserved.
function defaultReviewEvidenceGate({ root, evidencePath, testCommands, notBefore }) {
  const { runStarted, sections, allPassed } = evidenceSections(readWorkPath(root, evidencePath, { family: 'evidence' }));
  if (!(Date.parse(runStarted) >= Date.parse(notBefore))) throw new Error('evidence predates the review role reservation');
  if (!testCommands.includes(sections['surface-test'].command)) {
    throw new Error(`surface-test command ${JSON.stringify(sections['surface-test'].command)} is not the plan's exact surface test command`);
  }
  for (const [label, section] of Object.entries(sections)) {
    if (section.exit !== '0' || section.signal !== 'none' || section.spawnError !== 'none') {
      throw new Error(`${label} exited ${section.exit} (signal ${section.signal}, spawn error ${section.spawnError})`);
    }
  }
  if (!allPassed) throw new Error('evidence collection did not record all commands passing');
}

async function reviewPhase(ctx) {
  const scope = scopeOf('review');
  if (ensurePhase(ctx, scope)) return;
  const { root, paths } = ctx;
  const plan = loadPlan(ctx);
  let entry = roleIn(ctx, scope, 'review');
  if (!entry) {
    materializeReviewInputs(ctx, plan);
    // The compact handoff parse still validates index coverage and the reviewer tier.
    const route = gate(ctx, 'review context', () => reviewPhaseContext(plan.planText, readText(ctx, paths.index, 'task-result-index')));
    const { testCommand, criterionIds } = branchContract(plan);
    entry = await dispatchRole(ctx, {
      scope, role: 'review', modelTier: route.modelTier,
      manifest: (roleSequence) => buildReviewManifest({
        repoRoot: root, runId: ctx.state.runId, attempt: 1, modelTier: route.modelTier,
        criteriaPath: paths.criteria, taskResultIndexPath: paths.index, branchDiffPath: paths.branchDiff,
        tasks: plan.tasks, standardsBySurface: plan.standardsBySurface, onUnroutedSurface: () => {},
        otherHubPaths: ['.apex/conventions.md'], outputs: [paths.evidence, paths.reviewReport],
        ...(testCommand === undefined ? {} : { testCommand }), criterionIds, contract: contractFor(ctx, roleSequence),
      }),
    });
  }
  if (!entry.accepted) {
    const record = capturedRecord(ctx, entry);
    assertCheckout(ctx, describe(entry));
    const diagnosis = transportDiagnosis(describe(entry), record);
    if (diagnosis) halt(ctx, diagnosis);
    const verdict = gate(ctx, `${describe(entry)} response rejected`, () => decodePhaseResponse(record.payload, 'review'));
    if (verdict.status !== 'READY_FOR_PR') halt(ctx, `${describe(entry)} returned ${verdict.status} (signals: ${verdict.signals})`);
    const draft = gate(ctx, 'review evidence rejected', () => {
      verifyTaskResults(root, { indexPath: paths.index, expectedTasks: plan.tasks.map((task) => task.task), protocol: ctx.indexProtocol });
      const bytes = readWorkPath(root, paths.reviewReport, { family: 'review-report' });
      const header = lifecycleOf(bytes.toString('utf8'));
      if (!header || header.phase !== 'review' || header.status !== 'DRAFT' || header.next !== 'none'
        || header.source !== paths.index || header['consumed-by'] !== 'none') {
        throw new Error(`the review report must carry a DRAFT review lifecycle header sourced from ${paths.index}`);
      }
      const reserved = ctx.events.find((event) => event.event === 'ROLE_RESERVED' && event.roleSequence === entry.roleSequence);
      ctx.evidenceGate({ root, evidencePath: paths.evidence, reportPath: paths.reviewReport, notBefore: reserved.timestamp,
        testCommands: branchContract(plan).testCommands });
      return bytes;
    }, { reconciliation: true });
    acceptAutopilotResult(root, paths.dir, entry.roleSequence, { path: paths.reviewReport, digest: sha(draft) }, {
      verifyReceipt: (_bytes, _path, invocation) => ({ ...invocation, accepted: true }),
    });
    refresh(ctx);
    ctx.crash('result-accepted', { roleSequence: entry.roleSequence, role: 'review' });
    entry = roleIn(ctx, scope, 'review');
  }
  const report = readText(ctx, paths.reviewReport, 'review-report');
  if (assertPublished(ctx, 'review report', report, entry, { status: 'DRAFT' }).status === 'DRAFT') {
    writeWorkPath(root, paths.reviewReport, withLifecycle(report, { status: 'READY' }), { family: 'review-report' });
    ctx.crash('review-published', {});
  }
  const index = readText(ctx, paths.index, 'task-result-index');
  const header = publishedHeader(ctx, 'task-result index', index);
  if (header.status === 'READY') {
    writeWorkPath(root, paths.index, withLifecycle(index, { status: 'CONSUMED', next: 'none', 'consumed-by': paths.reviewReport }),
      { family: 'task-result-index' });
  } else if (header.status !== 'CONSUMED' || header['consumed-by'] !== paths.reviewReport) {
    halt(ctx, 'task-result index cannot be consumed by the review report', { reconciliation: true });
  }
  acceptPhase(ctx, scope);
}

// ---- Recovery runs --------------------------------------------------------
// The prepared plan, bound by re-derivation from the digest-bound source plan
// and recovery input; only its READY/CONSUMED lifecycle values may change.
function assertRecoveryPlan(ctx, planText) {
  const header = publishedHeader(ctx, 'plan', planText);
  const expected = gate(ctx, 'plan publication drift', () => recoveryCopies(ctx.root, ctx.paths.recoveryInput).plan, { reconciliation: true });
  if (withLifecycle(planText, { status: 'READY', 'consumed-by': 'none' }) !== expected) {
    halt(ctx, 'plan publication drift: the plan no longer matches the prepared recovery copy', { reconciliation: true });
  }
  return header;
}

// Pre-effect: a READY inspection, prepared copies on disk byte-equal to their
// re-derivation, and the accepted branch equal to the contract branch.
function verifyRecoveryStart(ctx) {
  const inspection = inspectRecovery(ctx.root, ctx.paths.recoveryInput);
  if (inspection.status !== 'READY') throw new Error(`recovery requires reconciliation: ${inspection.reconciliation.join('; ')}`);
  for (const [path, text, family] of [[ctx.paths.spec, inspection.copies.spec, 'spec'], [ctx.paths.plan, inspection.copies.plan, 'plan']]) {
    const bytes = optionalWork(ctx.root, path, family);
    if (bytes === null || !bytes.equals(Buffer.from(text))) {
      throw new Error(`${path} is not the prepared recovery copy; run scripts/autopilot-recovery.mjs prepare first`);
    }
  }
  if (inspection.input.current.branch !== ctx.contract.branch) throw new Error('the accepted recovery branch is not the contract branch');
  return inspection;
}

// Registration records one RECOVERY_IMPORTED event per reused task, before any
// other run event. An interrupted registration completes from the same exact
// input and byte-reproducible receipts; anything else needs reconciliation.
function registerRecovery(ctx) {
  const { root, paths } = ctx;
  const { input } = gate(ctx, 'recovery input', () => loadRecoveryInput(root, paths.recoveryInput), { reconciliation: true });
  const registered = ctx.state.imports.map((item) => String(item.scope.task));
  if (JSON.stringify(registered) !== JSON.stringify(input.reuse.slice(0, registered.length))) {
    halt(ctx, 'recovery imports do not follow the recovery input', { reconciliation: true });
  }
  if (registered.length === input.reuse.length) return;
  if (ctx.events.slice(1).some((event) => event.event !== 'RECOVERY_IMPORTED')) {
    halt(ctx, 'recovery registration was interrupted by other run events', { reconciliation: true });
  }
  const inspection = ctx.recoveryStart ?? gate(ctx, 'recovery input', () => {
    const current = inspectRecovery(root, paths.recoveryInput);
    if (current.status !== 'READY') throw new Error(`recovery requires reconciliation: ${current.reconciliation.join('; ')}`);
    return current;
  }, { reconciliation: true });
  for (const task of input.reuse.slice(registered.length)) {
    const scope = scopeOf('implement', Number(task));
    const importPath = `${paths.dir}/task-${task}-import.json`;
    const receipt = input.source.receipts.find((item) => item.task === task);
    const imported = gate(ctx, `Task ${task} recovery import`, () => importTaskResult(root, importPath, {
      runId: ctx.state.runId, task, sourceState: receipt.path.slice(0, -'-result.json'.length), sourceHead: inspection.source.head,
      manifests: input.source.manifests, explainedDelta: input.current.delta,
    }), { reconciliation: true, scope });
    appendAutopilotEvent(root, paths.dir, { event: 'RECOVERY_IMPORTED', scope, importPath, importDigest: imported.digest });
    refresh(ctx);
    ctx.crash('recovery-imported', { task });
  }
}

function useRecovery(ctx, bytes) {
  ctx.recovery = true;
  ctx.recoveryDigest = sha(bytes);
  ctx.indexProtocol = 3;
}

// A fresh run starts as a recovery run only from its explicit exact input.
function selectFreshRecovery(ctx) {
  const present = optionalWork(ctx.root, ctx.paths.recoveryInput, 'recovery-input');
  if (ctx.requestedRecovery === null) {
    if (present !== null) throw new ControllerRefusal(`a recovery input exists at ${ctx.paths.recoveryInput}; start it explicitly with --recovery-input`);
    return;
  }
  if (ctx.requestedRecovery !== ctx.paths.recoveryInput) throw new ControllerRefusal(`recovery input must be exactly ${ctx.paths.recoveryInput}`);
  if (present === null) throw new ControllerRefusal(`recovery input is missing: ${ctx.paths.recoveryInput}`);
  useRecovery(ctx, present);
}

// A resumed run keeps the kind its journal shows: a recovery run registers its
// imports right after RUN_STARTED. A stray input never converts a run.
function selectResumedRecovery(ctx) {
  const present = optionalWork(ctx.root, ctx.paths.recoveryInput, 'recovery-input');
  const second = ctx.events[1];
  if (present === null) {
    if (ctx.state.imports.length > 0) halt(ctx, 'recovery imports exist without their recovery input', { reconciliation: true });
    return;
  }
  if (second !== undefined && second.event !== 'RECOVERY_IMPORTED') {
    throw new ControllerRefusal(`a recovery input beside a run that did not start from it is refused: ${ctx.paths.recoveryInput}`);
  }
  useRecovery(ctx, present);
}

// Drives (or resumes) one controller-protocol-2 run under the caller's lease.
// Returns { code, reason, halted }: `halted` is true only for a halt recorded in
// the journal; a refusal before any effect journals nothing and stays resumable.
export async function runController(options) {
  const ctx = createContext(options);
  try {
    const fresh = optionalWork(ctx.root, ctx.paths.run, 'autopilot-run') === null;
    if (!fresh && ctx.requestedRecovery !== null) {
      throw new ControllerRefusal('--recovery-input starts a new recovery run; the existing run resumes from its journal without it');
    }
    // A fresh run validates its inputs before creating any run identity.
    if (fresh) selectFreshRecovery(ctx);
    if (fresh && ctx.recovery) ctx.recoveryStart = refusing('recovery input', () => verifyRecoveryStart(ctx));
    else if (fresh) planInputs(ctx);
    startOrResume(ctx);
    projectAutopilotStatus(ctx.root, ctx.paths.dir);
    if (ctx.state.status === 'HALTED') return { code: 1, reason: `controller run halted: ${ctx.state.reason}`, halted: true };
    if (ctx.state.status === 'COMPLETED') return { code: 0, reason: 'controller run already completed', halted: false };
    if (ctx.run.branch !== ctx.contract.branch || ctx.git.branch(ctx.root) !== ctx.run.branch) {
      throw new ControllerRefusal(`controller run belongs to branch "${ctx.run.branch}"; refusing to drive it from "${ctx.git.branch(ctx.root)}"`);
    }
    if (!fresh) selectResumedRecovery(ctx);
    if (ctx.recovery) registerRecovery(ctx);
    else await planPhase(ctx);
    await implementPhase(ctx);
    await reviewPhase(ctx);
    appendAutopilotEvent(ctx.root, ctx.paths.dir, { event: 'RUN_COMPLETED' });
    refresh(ctx);
    return { code: 0, reason: 'READY_FOR_PR', halted: false };
  } catch (error) {
    if (error instanceof ControllerHalt) return { code: 1, reason: error.message, halted: true };
    if (error instanceof ControllerRefusal) return { code: 1, reason: error.message, halted: false };
    throw error;
  }
}

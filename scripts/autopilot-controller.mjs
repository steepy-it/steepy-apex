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
import {
  beginTask, inspectTaskResult, projectTaskResults, recordTaskResult, resumeTaskResult, verifyTaskResults,
} from './task-results.mjs';
import { beginReview, checkReview, inspectReview, reserveRepair, setReviewReference } from './reviewer-response.mjs';
import { readStableDocument } from './stable-paths.mjs';
import { mkdirWorkPath, parseWorkPath, readWorkPath, writeWorkPath } from './work-paths.mjs';

export const CONTROLLER_PROTOCOL = 2;
// Versions are selected once per run and pinned in every role manifest. The
// writer-only index stays on protocol 2 until imported evidence is supported.
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
const REVIEWER_TIER = 'standard';
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

export function controllerPaths(specName) {
  const dir = `.apex/work/tasks/${specName}`;
  return Object.freeze({
    dir, spec: `.apex/work/specs/${specName}.md`, plan: `.apex/work/plans/${specName}.md`,
    index: `${dir}/task-result-index.md`, criteria: `${dir}/success-criteria.md`,
    branchDiff: `${dir}/branch-diff.txt`, reviewReport: `${dir}/review-report.md`,
    evidence: `${dir}/evidence-report.md`, finalReport: `${dir}/final-review.md`,
    finalIssues: `${dir}/final-review-issues.md`, run: `${dir}/autopilot-run.json`,
    events: `${dir}/autopilot-events.jsonl`, status: `${dir}/autopilot-status.md`,
  });
}

function optionalWork(root, path, family) {
  try { return readWorkPath(root, path, { family }); } catch (error) {
    if (/^work path: missing (?:work artifact|ancestor directory)/.test(error.message)) return null;
    throw error;
  }
}

// Exact controller-owned paths only: no work-area listing. A controller
// marker without its immutable identity is corrupt new state, never legacy.
export function inspectControllerState(root, specName) {
  const paths = controllerPaths(specName);
  const run = optionalWork(root, paths.run, 'autopilot-run');
  const status = optionalWork(root, paths.status, 'status');
  const projection = status !== null && status.toString('utf8').startsWith(STATUS_PROJECTION_HEADER);
  if (run === null) {
    if (optionalWork(root, paths.events, 'autopilot-events') !== null
      || optionalWork(root, `${paths.dir}/role-1-reservation.json`, 'role-reservation') !== null || projection) {
      throw new Error('controller protocol 2 state exists without its immutable run identity; refusing legacy fallback');
    }
    return null;
  }
  if (status !== null && status.length > 0 && !projection) {
    throw new Error('legacy status and controller run identity coexist; refusing to guess the run protocol');
  }
  return Object.freeze({ controllerProtocol: CONTROLLER_PROTOCOL });
}

// Captured transport is opaque to the journal; this closed record keeps the
// specific diagnosis (terminal reason, exit, transport, raw persistence).
function responseRecord(roleSequence, role, outcome) {
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
  };
}

function parseResponseRecord(bytes, entry) {
  const record = JSON.parse(bytes.toString('utf8'));
  const keys = ['schemaVersion', 'roleSequence', 'role', 'payload', 'terminalReason', 'sessionId', 'exit',
    'transportError', 'capturePersisted', 'observedModel'];
  if (!record || typeof record !== 'object' || Object.keys(record).sort().join() !== [...keys].sort().join()
    || record.schemaVersion !== RESPONSE_SCHEMA_VERSION || record.roleSequence !== entry.roleSequence
    || record.role !== entry.role) {
    throw new Error(`captured response for role ${entry.roleSequence} does not bind its reservation`);
  }
  return record;
}

function transportDiagnosis(label, record) {
  const problems = [];
  if (record.payload === null) problems.push(`no terminal response (${record.terminalReason ?? 'missing-terminal'})`);
  else if (record.terminalReason !== null) problems.push(`terminal ${record.terminalReason}`);
  if (record.exit.signal !== null) problems.push(`child killed by ${record.exit.signal}`);
  else if (record.exit.status !== 0) problems.push(`child exited ${record.exit.status ?? 'without a status'}`);
  if (record.transportError !== null) problems.push(`transport error: ${record.transportError}`);
  if (!record.capturePersisted) problems.push('raw capture was not persisted');
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

function createContext({ repoRoot, specName, contract, runId, engineRoot = ENGINE_ROOT, services = {} }) {
  if (typeof services.runner?.prepare !== 'function') throw new TypeError('controller requires an injected role runner');
  return {
    root: repoRoot, specName, contract, requestedRunId: runId, engineRoot,
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
    if (error instanceof ControllerHalt) throw error;
    return halt(ctx, `${label}: ${error.message}`, options);
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
    logMode: contract.logMode, ...CONTROLLER_CONTRACT, roleSequence, responseFormat: 'text',
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
  const prepared = gate(ctx, `${label} descriptor`, () => ctx.runner.prepare({
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
  const record = responseRecord(roleSequence, spec.role, outcome);
  captureAutopilotResponse(root, paths.dir, roleSequence, `${JSON.stringify(record)}\n`, { observedModel: record.observedModel });
  refresh(ctx);
  ctx.crash('response-captured', { roleSequence, role: spec.role });
  return entry();
}

// The response recorded for a reserved role. A reservation without a captured
// response never earns another dispatch: the child may already have acted.
function capturedRecord(ctx, entry) {
  if (!entry.responseCaptured) {
    if (!ctx.pending.includes(entry.roleSequence)) {
      halt(ctx, `${describe(entry)} was reserved without a captured response; refusing to dispatch it again`,
        { reconciliation: true, scope: entry.scope });
    }
    const bytes = readWorkPath(ctx.root, `${ctx.paths.dir}/role-${entry.roleSequence}-response.json`, { family: 'role-response' });
    const pending = gate(ctx, describe(entry), () => parseResponseRecord(bytes, entry), { reconciliation: true, scope: entry.scope });
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

// A published DRAFT-sourced artifact is bound by its receipt: restoring the
// DRAFT lifecycle values must reproduce the accepted source digest exactly.
function assertPublished(ctx, label, text, entry, draft) {
  if (sha(Buffer.from(withLifecycle(text, draft))) !== roleReceipt(ctx, entry).sourceDigest) {
    halt(ctx, `${label} publication drift: its content no longer matches the accepted DRAFT receipt`, { reconciliation: true });
  }
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
// no lifecycle. Checked before the plan role is dispatched and at publication.
function specLifecycle(ctx) {
  const text = readWorkPath(ctx.root, ctx.paths.spec, { expect: 'spec', encoding: 'utf8' });
  const header = gate(ctx, 'spec lifecycle', () => lifecycleOf(text));
  if (header !== null && (header.phase !== 'brainstorm' || header.next !== 'plan'
    || !(header.status === 'READY' && header['consumed-by'] === 'none'
      || header.status === 'CONSUMED' && header['consumed-by'] === ctx.paths.plan))) {
    halt(ctx, `spec lifecycle is not a READY brainstorm input for ${ctx.paths.plan}`);
  }
  return { text, header };
}

async function planPhase(ctx) {
  const scope = scopeOf('plan');
  if (ensurePhase(ctx, scope)) return;
  const { paths, root } = ctx;
  let entry = roleIn(ctx, scope, 'plan');
  if (!entry) {
    specLifecycle(ctx);
    const route = gate(ctx, 'plan context', () => specRoute(ctx));
    const { standardsBySurface } = gate(ctx, 'plan context', () => routing(ctx));
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
  const header = gate(ctx, 'plan publication', () => lifecycleOf(text));
  assertPublished(ctx, 'plan', text, entry, { status: 'DRAFT', 'consumed-by': 'none' });
  if (header.status === 'DRAFT') {
    writeWorkPath(root, paths.plan, withLifecycle(text, { status: 'READY' }), { family: 'plan' });
    ctx.crash('plan-published', {});
  } else if (!['READY', 'CONSUMED'].includes(header.status)) halt(ctx, `plan publication has invalid status ${header.status}`, { reconciliation: true });
  const spec = specLifecycle(ctx);
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

function projectIndex(ctx, plan) {
  const states = plan.tasks.map((task) => latestAcceptedWriter(ctx, task.task)).filter(Boolean).map(stateOf);
  gate(ctx, 'task-result projection', () => projectTaskResults(ctx.root, { indexPath: ctx.paths.index, states }),
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

function writeTaskDiff(ctx, task) {
  const first = `${ctx.paths.dir}/task-${task}-execution-1-baseline.json`;
  const base = JSON.parse(readWorkPath(ctx.root, first, { family: 'task-result' }).toString('utf8')).taskBefore.head;
  return captureBranchDiff({ cwd: ctx.root, baseline: base, outputPath: `${ctx.paths.dir}/task-${task}-diff.txt`, family: 'task-diff' }).path;
}

async function dispatchWriter(ctx, plan, task, role, iteration, fix = null) {
  const { root, paths } = ctx;
  const execution = writerRoles(ctx, task.task).length + 1;
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
      previousState: execution === 1 ? null : `${paths.dir}/task-${task.task}-execution-${execution - 1}`,
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

async function reviewTask(ctx, plan, task, writer) {
  const { root, paths } = ctx;
  const scope = scopeOf('review', Number(task.task), writer.scope.iteration);
  const guard = guardOf(ctx, scope);
  const report = `${paths.dir}/task-${task.task}-review.md`;
  const issues = `${paths.dir}/task-${task.task}-issues.md`;
  const correctionManifest = (original) => buildTaskReviewCorrectionManifest({
    repoRoot: root, runId: ctx.state.runId, attempt: 1, task: Number(task.task), modelTier: REVIEWER_TIER,
    originalReceiptPath: original, reportPath: report, issuePath: issues,
  });
  let reviewer = roleIn(ctx, scope, 'task-reviewer');
  if (!reviewer) {
    const taskDiffPath = gate(ctx, `Task ${task.task} diff`, () => writeTaskDiff(ctx, task.task), { reconciliation: true });
    reviewer = await dispatchRole(ctx, {
      scope, role: 'task-reviewer', modelTier: REVIEWER_TIER,
      effects: () => beginReview(root, guard, {
        runId: ctx.state.runId, attempt: 1, iteration: scope.iteration, task: task.task, report, issues,
        format: 'text', execution: stateOf(writer), reviewerResponseProtocol: 3,
      }),
      manifest: (roleSequence) => buildControllerTaskManifest('task-reviewer', {
        ...taskBinding(ctx, plan, task, roleSequence, REVIEWER_TIER),
        reportPath: `${paths.dir}/task-${task.task}-report.md`, taskDiffPath, outputs: [report, issues],
      }),
    });
  }
  const verdict = await settleReview(ctx, reviewer, correctionManifest);
  if (verdict === 'APPROVED') bindReference(ctx, task.task, guard);
  return verdict;
}

// Writer → review → fix until the task's latest execution is approved. A
// whole-branch fix (`after` the final review that requested it) re-enters the
// same loop; a mechanical task keeps its review waiver.
async function settleTask(ctx, plan, task, wholeBranch = null) {
  for (;;) {
    const writers = writerRoles(ctx, task.task);
    const writer = writers.at(-1);
    if (!writer) { await dispatchWriter(ctx, plan, task, 'implementer', 1); continue; }
    if (!writer.accepted) { await settleWriter(ctx, plan, task, writer); continue; }
    if (wholeBranch !== null && writer.roleSequence < wholeBranch.after) {
      await dispatchWriter(ctx, plan, task, 'fix', writer.scope.iteration + 1,
        { issuePath: ctx.paths.finalIssues, diffPath: () => ctx.paths.branchDiff });
      continue;
    }
    if (task.complexity === 'mechanical') return;
    const verdict = await reviewTask(ctx, plan, task, writer);
    if (verdict === 'APPROVED') return;
    await dispatchWriter(ctx, plan, task, 'fix', writer.scope.iteration + 1, {
      issuePath: `${ctx.paths.dir}/task-${task.task}-issues.md`,
      diffPath: () => writeTaskDiff(ctx, task.task),
    });
  }
}

function materializeReviewInputs(ctx, plan) {
  gate(ctx, 'review inputs', () => {
    materializeSuccessCriteria({ repoRoot: ctx.root, specPath: ctx.paths.spec, outputPath: ctx.paths.criteria });
    projectTaskResults(ctx.root, { indexPath: ctx.paths.index,
      states: plan.tasks.map((task) => stateOf(latestAcceptedWriter(ctx, task.task))) });
    captureBranchDiff({ cwd: ctx.root, baseline: ctx.run.baseline, outputPath: ctx.paths.branchDiff });
  }, { reconciliation: true });
}

const finalRoles = (ctx) => ctx.state.roles.filter((entry) => entry.role === 'final-review');
const standardUnion = (plan) => [...new Set(plan.tasks.flatMap((task) => task.standardPaths))];

async function finalReview(ctx, plan, iteration) {
  const { root, paths } = ctx;
  const scope = scopeOf('final-review', null, iteration);
  const guard = guardOf(ctx, scope);
  materializeReviewInputs(ctx, plan);
  const compact = plan.compact;
  return dispatchRole(ctx, {
    scope, role: 'final-review', modelTier: REVIEWER_TIER,
    effects: () => {
      bindReference(ctx, 'final', guard);
      beginReview(root, guard, {
        runId: ctx.state.runId, attempt: 1, iteration, task: 'final', report: paths.finalReport,
        issues: paths.finalIssues, format: 'text', plan: paths.plan, index: paths.index, reviewerResponseProtocol: 3,
      });
    },
    manifest: (roleSequence) => buildFinalReviewManifest({
      repoRoot: root, runId: ctx.state.runId, attempt: 1, modelTier: REVIEWER_TIER,
      criteriaPath: paths.criteria, taskResultIndexPath: paths.index, branchDiffPath: paths.branchDiff,
      standardPaths: standardUnion(plan), outputs: [paths.finalReport, paths.finalIssues],
      ...(compact.testCommand === undefined ? {} : { testCommand: compact.testCommand }),
      criterionIds: compact.criterionIds, contract: contractFor(ctx, roleSequence),
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
    const verified = verifyTaskResults(root, { indexPath: paths.index, expectedTasks: plan.tasks.map((task) => task.task) });
    for (const execution of verified.executions) {
      const entry = writers.get(`${execution.state}-result.json`);
      if (!entry?.accepted || execution.config.runId !== ctx.state.runId || execution.config.attempt !== 1
        || execution.config.task !== String(entry.scope.task) || execution.config.role !== entry.role) {
        throw new Error(`task execution ${execution.state} lacks controller reservation provenance`);
      }
      const manifest = JSON.parse(readWorkPath(root, `${paths.dir}/context/role-${entry.roleSequence}.json`, { family: 'manifest' }).toString('utf8'));
      if (manifest.contract?.controllerProtocol !== CONTROLLER_PROTOCOL || manifest.contract.roleSequence !== entry.roleSequence
        || manifest.contract.taskResultProtocol !== 2) throw new Error(`task execution ${execution.state} manifest provenance mismatch`);
    }
    const final = finalRoles(ctx).at(-1);
    const result = inspectReview(root, guardOf(ctx, final.scope));
    if (!result.accepted || result.status !== 'APPROVED') throw new Error('final reviewer gate is not approved');
  }, { reconciliation: true });
  const planEntry = roleIn(ctx, scopeOf('plan'), 'plan');
  const planText = readText(ctx, paths.plan, 'plan');
  assertPublished(ctx, 'plan', planText, planEntry, { status: 'DRAFT', 'consumed-by': 'none' });
  const index = readText(ctx, paths.index, 'task-result-index');
  if (lifecycleOf(index).status === 'DRAFT') writeWorkPath(root, paths.index, withLifecycle(index, { status: 'READY' }), { family: 'task-result-index' });
  if (lifecycleOf(planText).status === 'READY') {
    writeWorkPath(root, paths.plan, withLifecycle(planText, { status: 'CONSUMED', 'consumed-by': paths.index }), { family: 'plan' });
  }
  acceptPhase(ctx, scopeOf('implement'));
}

function defaultReviewEvidenceGate({ root, evidencePath }) {
  const text = readWorkPath(root, evidencePath, { family: 'evidence', encoding: 'utf8' });
  const results = [...text.matchAll(/^All commands passed: (true|false)$/gm)];
  if (results.length !== 1 || results[0][1] !== 'true') throw new Error('evidence report does not record one passing command collection');
}

async function reviewPhase(ctx) {
  const scope = scopeOf('review');
  if (ensurePhase(ctx, scope)) return;
  const { root, paths } = ctx;
  const plan = loadPlan(ctx);
  let entry = roleIn(ctx, scope, 'review');
  if (!entry) {
    materializeReviewInputs(ctx, plan);
    const route = gate(ctx, 'review context', () => reviewPhaseContext(plan.planText, readText(ctx, paths.index, 'task-result-index')));
    entry = await dispatchRole(ctx, {
      scope, role: 'review', modelTier: route.modelTier,
      manifest: (roleSequence) => buildReviewManifest({
        repoRoot: root, runId: ctx.state.runId, attempt: 1, modelTier: route.modelTier,
        criteriaPath: paths.criteria, taskResultIndexPath: paths.index, branchDiffPath: paths.branchDiff,
        tasks: route.tasks, standardsBySurface: plan.standardsBySurface, onUnroutedSurface: () => {},
        otherHubPaths: ['.apex/conventions.md'], outputs: [paths.evidence, paths.reviewReport],
        ...(route.testCommand === undefined ? {} : { testCommand: route.testCommand }),
        criterionIds: route.criterionIds, contract: contractFor(ctx, roleSequence),
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
      verifyTaskResults(root, { indexPath: paths.index, expectedTasks: plan.tasks.map((task) => task.task) });
      const bytes = readWorkPath(root, paths.reviewReport, { family: 'review-report' });
      const header = lifecycleOf(bytes.toString('utf8'));
      if (!header || header.phase !== 'review' || header.status !== 'DRAFT' || header.next !== 'none'
        || header.source !== paths.index || header['consumed-by'] !== 'none') {
        throw new Error(`the review report must carry a DRAFT review lifecycle header sourced from ${paths.index}`);
      }
      ctx.evidenceGate({ root, evidencePath: paths.evidence, reportPath: paths.reviewReport });
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
  assertPublished(ctx, 'review report', report, entry, { status: 'DRAFT' });
  if (lifecycleOf(report).status === 'DRAFT') {
    writeWorkPath(root, paths.reviewReport, withLifecycle(report, { status: 'READY' }), { family: 'review-report' });
    ctx.crash('review-published', {});
  }
  const index = readText(ctx, paths.index, 'task-result-index');
  const header = lifecycleOf(index);
  if (header.status === 'READY') {
    writeWorkPath(root, paths.index, withLifecycle(index, { status: 'CONSUMED', next: 'none', 'consumed-by': paths.reviewReport }),
      { family: 'task-result-index' });
  } else if (header.status !== 'CONSUMED' || header['consumed-by'] !== paths.reviewReport) {
    halt(ctx, 'task-result index cannot be consumed by the review report', { reconciliation: true });
  }
  acceptPhase(ctx, scope);
}

// Drives (or resumes) one controller-protocol-2 run under the caller's lease.
// Returns { code, reason }; a decided halt is recorded in the journal first.
export async function runController(options) {
  const ctx = createContext(options);
  startOrResume(ctx);
  projectAutopilotStatus(ctx.root, ctx.paths.dir);
  if (ctx.state.status === 'HALTED') return { code: 1, reason: `controller run halted: ${ctx.state.reason}` };
  if (ctx.state.status === 'COMPLETED') return { code: 0, reason: 'controller run already completed' };
  if (ctx.run.branch !== ctx.contract.branch || ctx.git.branch(ctx.root) !== ctx.run.branch) {
    return { code: 1, reason: `controller run belongs to branch "${ctx.run.branch}"; refusing to drive it from "${ctx.git.branch(ctx.root)}"` };
  }
  try {
    await planPhase(ctx);
    await implementPhase(ctx);
    await reviewPhase(ctx);
    appendAutopilotEvent(ctx.root, ctx.paths.dir, { event: 'RUN_COMPLETED' });
    refresh(ctx);
    return { code: 0, reason: 'READY_FOR_PR' };
  } catch (error) {
    if (error instanceof ControllerHalt) return { code: 1, reason: error.message };
    throw error;
  }
}

import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openWorkPathFd, readWorkPath, parseWorkPath, writeWorkPath } from './work-paths.mjs';
import { decodeReviewerResponse } from '../adapters/reviewer-response.mjs';
import { reviewPhaseContext } from './autopilot-context.mjs';
import { assertSafeRelPath } from './sanitize.mjs';
import { writeAllSync } from './write-all.mjs';
import { inspectTaskResult, verifyTaskResults } from './task-results.mjs';
import { observeSource } from './source-observation.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
function pathFor(state, stage) {
  const path = `${state}-${stage}.json`;
  parseWorkPath(path, 'work-output', 'review-guard');
  return path;
}
function save(root, state, stage, value) {
  const fd = openWorkPathFd(root, pathFor(state, stage), { disposition: 'create-new' });
  try { writeAllSync(fd, Buffer.from(`${JSON.stringify(value)}\n`)); fsyncSync(fd); }
  finally { closeSync(fd); }
  return value;
}
function loadOptional(root, state, stage) {
  try { return load(root, state, stage); }
  catch (error) { if (error.message === `work path: missing work artifact '${pathFor(state, stage)}'`) return null; throw error; }
}
function load(root, state, stage) {
  return JSON.parse(readWorkPath(root, pathFor(state, stage)).toString());
}
function artifacts(root, config) {
  const result = {};
  for (const path of [config.report, config.issues]) {
    let bytes;
    try { bytes = readWorkPath(root, path); }
    catch (error) { if (error.message === `work path: missing work artifact '${path}'`) bytes = null; else throw error; }
    result[path] = bytes === null || !bytes.toString().trim() ? null : hash(bytes);
  }
  return result;
}
const digestPattern = /^[a-f0-9]{64}$/;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function keys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !equal(Object.keys(value).sort(), [...expected].sort())) throw new Error(`invalid ${label} schema`);
}
function validateConfig(state, config) {
  keys(config, ['runId', 'attempt', 'iteration', 'task', 'report', 'issues', 'format', 'plan', 'index', 'taskResultProtocol',
    ...(Object.hasOwn(config, 'execution') ? ['execution'] : [])], 'review correlation');
  if (config.taskResultProtocol !== 2) throw new Error('unsupported reviewer task result protocol');
  if (config.task !== 'final' && !Object.hasOwn(config, 'execution')) throw new Error('task review requires an execution receipt');
  if (typeof config.runId !== 'string' || !/^[A-Za-z0-9-]+$/.test(config.runId)
    || !Number.isSafeInteger(config.attempt) || config.attempt < 1
    || !Number.isSafeInteger(config.iteration) || config.iteration < 1
    || typeof config.task !== 'string' || !(config.task === 'final' || /^[1-9]\d*$/.test(config.task) && Number.isSafeInteger(Number(config.task)))
    || !['text', 'json'].includes(config.format)) throw new Error('invalid review correlation');
  const scope = config.task === 'final' ? 'final' : `task-${config.task}`;
  if (!state.endsWith(`/${scope}-review-guard-attempt-${config.attempt}-iteration-${config.iteration}`)) throw new Error('state correlation mismatch');
  pathFor(state, 'baseline');
  const dir = state.slice(0, state.lastIndexOf('/'));
  if (config.report !== `${dir}/${scope}-review.md` || config.issues !== `${dir}/${scope === 'final' ? 'final-review' : scope}-issues.md`) throw new Error('wrong review artifact paths');
  for (const path of [config.report, config.issues]) parseWorkPath(path, 'work-output', 'review-artifact');
  if (Object.hasOwn(config, 'execution')) {
    if (config.task === 'final' || typeof config.execution !== 'string'
      || !config.execution.startsWith(`${dir}/task-${config.task}-execution-`)) throw new Error('wrong task execution binding');
    parseWorkPath(`${config.execution}-result.json`, 'work-output', 'task-result');
  }
  if (config.plan !== null || config.index !== null) {
    if (config.task !== 'final' || config.plan !== `.apex/work/plans/${dir.split('/').at(-1)}.md`
      || config.index !== `${dir}/task-result-index.md`) throw new Error('invalid review handoff paths');
  }
}
function baselineFor(root, state) {
  const baseline = load(root, state, 'baseline');
  if (baseline?.version !== 4) throw new Error(`unsupported review evidence: baseline version ${baseline?.version} (task result protocol 1); finish the run manually or start a fresh run`);
  keys(baseline, ['version', 'config', 'snapshot', 'handoff', 'implementation'], 'review baseline');
  if (!digestPattern.test(baseline.snapshot)
    || !(baseline.handoff === null || digestPattern.test(baseline.handoff))) throw new Error('invalid review baseline evidence');
  validateConfig(state, baseline.config);
  if (baseline.config.task === 'final' ? baseline.implementation !== null : !digestPattern.test(baseline.implementation)) throw new Error('invalid review execution digest');
  if ((baseline.config.plan === null) !== (baseline.handoff === null)) throw new Error('invalid handoff evidence');
  return baseline;
}
export function beginReview(root, state, input) {
  const config = { taskResultProtocol: 2, ...input, format: input.format ?? 'text', plan: input.plan ?? null, index: input.index ?? null };
  validateConfig(state, config);
  const handoff = config.plan === null ? null : handoffDetails(root, config.plan, config.index, state).digest;
  let implementation;
  if (config.execution !== undefined) {
    const execution = inspectTaskResult(root, config.execution);
    if (!execution.accepted || execution.config.task !== config.task) throw new Error('task execution is not ready for review');
    implementation = execution.digest;
  }
  return save(root, state, 'baseline', { version: 4, config, snapshot: observeSource(root).digest, handoff, implementation: implementation ?? null });
}
function candidateResponse(text, config) {
  const value = decodeReviewerResponse(text, config.format ?? 'text');
  if (!/^(?:none|[A-Za-z0-9][A-Za-z0-9:._-]*(?:, [A-Za-z0-9][A-Za-z0-9:._-]*)*)$/.test(value.signals)) throw new Error('invalid reviewer signals');
  if (value.artifact !== (value.status === 'ISSUES_FOUND' ? config.issues : config.report)) throw new Error('wrong reviewer artifact');
  // v2 paths are an observation owned by this gate. outcome() accepts this
  // semantic candidate only after independently proving source immutability.
  return { ...value, 'changed-paths': 'none' };
}
export function parseReviewerResponse(text, config) {
  return candidateResponse(text, config);
}
function outcome(response, baseline, observation) {
  const blocked = (reason) => ({ status: 'BLOCKED', accepted: false, reason });
  if (observation.error !== null) return blocked(observation.error);
  if (observation.snapshot !== baseline.snapshot) return blocked('unauthorized repository change during review');
  if (observation.artifacts[baseline.config.report] === null) return blocked('missing or empty review report');
  let candidate;
  try { candidate = candidateResponse(response, baseline.config); }
  catch (error) { return blocked(error.message); }
  if (observation.artifacts[candidate.artifact] === null) return blocked('missing or empty reviewer artifact');
  return { status: candidate.status, accepted: ['APPROVED', 'ISSUES_FOUND'].includes(candidate.status), envelope: candidate };
}
function observe(root, baseline) {
  try {
    if (baseline.config.execution !== undefined) {
      const execution = inspectTaskResult(root, baseline.config.execution);
      if (!execution.accepted || execution.digest !== baseline.implementation) throw new Error('task execution changed during review');
    }
    return { snapshot: observeSource(root).digest, artifacts: artifacts(root, baseline.config), error: null };
  } catch { return { snapshot: null, artifacts: null, error: 'cannot safely observe review repository or artifacts' }; }
}
function validateObservation(value, config) {
  keys(value, ['snapshot', 'artifacts', 'error'], 'review observation');
  if (value.error !== null) {
    if (value.snapshot !== null || value.artifacts !== null || value.error !== 'cannot safely observe review repository or artifacts') throw new Error('invalid failed observation');
    return;
  }
  if (!digestPattern.test(value.snapshot)) throw new Error('invalid observation snapshot');
  keys(value.artifacts, [config.report, config.issues], 'review artifacts');
  for (const digest of Object.values(value.artifacts)) if (digest !== null && !digestPattern.test(digest)) throw new Error('invalid artifact digest');
}
function validateResult(result, baseline) {
  if (typeof result?.response !== 'string') throw new Error('invalid review response evidence');
  validateObservation(result.observation, baseline.config);
  const expected = { version: baseline.version, config: baseline.config, response: result.response, observation: result.observation,
    ...outcome(result.response, baseline, result.observation) };
  // Closed schema and replayed outcome: stored acceptance is never itself authority.
  keys(result, Object.keys(expected), 'review result');
  for (const field of Object.keys(expected)) if (!equal(result[field], expected[field])) throw new Error(`review evidence mismatch: ${field}`);
  return expected;
}
function readEvidence(root, state) {
  const baseline = baselineFor(root, state);
  const original = validateResult(load(root, state, 'original'), baseline);
  // The review-guard family keeps these names only so retained files are refused.
  if (loadOptional(root, state, 'reserved') !== null || loadOptional(root, state, 'corrected') !== null) {
    throw new Error('unsupported review evidence: response-only correction (task result protocol 1); finish the run manually or start a fresh run');
  }
  // The persisted handoff digest hashes this exact object shape.
  return { baseline, original, reserved: null, corrected: null, result: original };
}
export function checkReview(root, state, response) {
  const baseline = baselineFor(root, state);
  const observation = observe(root, baseline);
  const result = { version: baseline.version, config: baseline.config, response, observation, ...outcome(response, baseline, observation) };
  return save(root, state, 'original', result);
}
export function inspectReview(root, state) {
  const evidence = readEvidence(root, state);
  if (!equal(observe(root, evidence.baseline), evidence.result.observation)) return { accepted: false, status: 'BLOCKED', reason: 'review evidence drift on resume' };
  if (evidence.baseline.config.execution !== undefined) {
    const execution = inspectTaskResult(root, evidence.baseline.config.execution);
    if (!execution.accepted || execution.digest !== evidence.baseline.implementation) throw new Error('reviewed execution evidence changed');
  }
  if (evidence.baseline.handoff !== null && handoffDetails(root, evidence.baseline.config.plan, evidence.baseline.config.index, state).digest !== evidence.baseline.handoff) throw new Error('review handoff evidence mismatch');
  return evidence.result;
}

// Only lifecycle values in the leading canonical plan header may change after
// review. Requirements, paths, dependencies, prose, and all other bytes stay bound.
function boundPlanText(plan, indexPath) {
  const header = /^((?:[ \t\r\n]*<!--(?!\s*steepy-workflow:)[\s\S]*?-->)*[ \t\r\n]*<!-- steepy-workflow: v1\r?\n)([\s\S]*?)(\r?\n-->)/.exec(plan);
  if (!header) return plan;
  const entries = header[2].split(/\r?\n/).map((line) => /^([a-z-]+): (.+)$/.exec(line));
  if (entries.some((entry) => !entry)) throw new Error('invalid plan lifecycle header');
  const fields = Object.fromEntries(entries.map((entry) => [entry[1], entry[2]]));
  keys(fields, ['phase', 'status', 'next', 'source', 'consumed-by'], 'plan lifecycle');
  if (entries.length !== 5 || fields.phase !== 'plan' || fields.next !== 'implement'
    || !(fields.status === 'READY' && fields['consumed-by'] === 'none'
      || fields.status === 'CONSUMED' && fields['consumed-by'] === indexPath)) throw new Error('invalid plan lifecycle transition');
  assertSafeRelPath(fields.source, 'plan lifecycle source');
  const normalized = header[2].replace(/^status: (READY|CONSUMED)(?=\r?$)/m, 'status: <lifecycle>')
    .replace(/^consumed-by: [^\r\n]+(?=\r?$)/m, 'consumed-by: <lifecycle>');
  return header[1] + normalized + header[3] + plan.slice(header[0].length);
}

// Update only the active reference. Earlier review evidence remains create-only.
// previousState is a compare-and-set precondition under the conductor's checkout lease.
export function setReviewReference(root, { indexPath, state, previousState = null }) {
  parseWorkPath(indexPath, 'work-output', 'task-result-index');
  pathFor(state, 'baseline');
  const dir = indexPath.slice(0, indexPath.lastIndexOf('/'));
  const parse = (value) => {
    if (!value.startsWith(`${dir}/`)) throw new Error('review reference outside task directory');
    const match = /\/(final|task-([1-9]\d*))-review-guard-attempt-([1-9]\d*)-iteration-([1-9]\d*)$/.exec(value);
    if (!match || ![match[3], match[4]].every((n) => Number.isSafeInteger(Number(n)))) throw new Error('invalid review reference');
    return { label: match[1] === 'final' ? 'final' : `Task ${match[2]}`, attempt: Number(match[3]), iteration: Number(match[4]) };
  };
  const target = parse(state);
  const index = readWorkPath(root, indexPath, { encoding: 'utf8' });
  const matches = [...index.matchAll(/^Reviewer gate (Task [1-9]\d*|final): ([^\s]+)\r?$/gm)].filter((match) => match[1] === target.label);
  const referenceLines = index.split(/\r?\n/).filter((line) => line.startsWith(`Reviewer gate ${target.label}:`));
  if (matches.length > 1 || referenceLines.length !== matches.length) throw new Error('invalid or duplicate active reviewer reference');
  const current = matches[0]?.[2] ?? null;
  if (current === state) return { indexPath, state, changed: false };
  if (current !== previousState) throw new Error('active reviewer reference changed; refusing overwrite');
  if (current !== null) {
    const old = parse(current);
    if (old.label !== target.label || target.attempt < old.attempt
      || target.attempt === old.attempt && target.iteration <= old.iteration) throw new Error('review reference must advance to a newer iteration');
  }
  const replacement = `Reviewer gate ${target.label}: ${state}`;
  const eol = index.includes('\r\n') ? '\r\n' : '\n';
  const next = matches.length === 0 ? index + (index.endsWith('\n') ? '' : eol) + replacement + eol
    : index.slice(0, matches[0].index) + replacement + (matches[0][0].endsWith('\r') ? '\r' : '')
      + index.slice(matches[0].index + matches[0][0].length);
  writeWorkPath(root, indexPath, next);
  return { indexPath, state, changed: true };
}

function handoffDetails(root, planPath, indexPath, finalState) {
  const plan = readWorkPath(root, planPath, { encoding: 'utf8' });
  const index = readWorkPath(root, indexPath, { encoding: 'utf8' });
  const route = reviewPhaseContext(plan, index);
  const executions = verifyTaskResults(root, { indexPath, expectedTasks: route.tasks });
  const projection = executions.entries;
  const refs = new Map();
  for (const line of index.split(/\r?\n/)) {
    if (!/^Reviewer gate\b/.test(line)) continue;
    const match = /^Reviewer gate (Task [1-9]\d*|final): (\S+)$/.exec(line);
    if (!match || refs.has(match[1])) throw new Error('invalid or duplicate reviewer gate reference');
    pathFor(match[2], 'baseline');
    if (!match[2].startsWith(`${indexPath.slice(0, indexPath.lastIndexOf('/'))}/`)) throw new Error('reviewer gate outside task directory');
    refs.set(match[1], match[2]);
  }
  if (refs.get('final') !== finalState) throw new Error('missing or mismatched final reviewer gate');
  const proofs = [];
  for (const task of route.tasks) {
    const state = refs.get(`Task ${task.task}`);
    refs.delete(`Task ${task.task}`);
    if (!state && task.complexity === 'mechanical') continue;
    if (!state) throw new Error(`missing reviewer gate for Task ${task.task}`);
    const proof = readEvidence(root, state);
    if (proof.baseline.config.task !== task.task || proof.result.status !== 'APPROVED' || !proof.result.accepted
      || !equal(artifacts(root, proof.baseline.config), proof.result.observation.artifacts)) throw new Error(`invalid approval evidence for Task ${task.task}`);
    const entry = projection.find((item) => item.task === task.task);
    const execution = inspectTaskResult(root, entry.receipt, { checkCurrent: false });
    if (proof.baseline.config.execution !== entry.receipt || proof.baseline.implementation !== execution.digest) {
      throw new Error(`task review does not approve current execution for Task ${task.task}`);
    }
    proofs.push({ task: task.task, state, config: proof.baseline.config, digest: hash(JSON.stringify(proof)) });
  }
  refs.delete('final');
  if (refs.size) throw new Error('unknown task reviewer gate');
  return { proofs, digest: hash(JSON.stringify({ plan: boundPlanText(plan, indexPath), tasks: route.tasks,
    results: projection, finalState, proofs, executions: executions.digest })) };
}
function assertAttemptManifest(root, indexPath, identity) {
  const dir = indexPath.slice(0, indexPath.lastIndexOf('/'));
  if (!Number.isSafeInteger(identity.attempt) || identity.attempt < 1 || typeof identity.runId !== 'string' || !identity.runId) throw new Error('invalid review attempt identity');
  const manifest = JSON.parse(readWorkPath(root, `${dir}/context/phase-implement-attempt-${identity.attempt}.json`, { encoding: 'utf8' }));
  if (manifest.runId !== identity.runId || manifest.attempt !== identity.attempt
    || manifest.scope?.phase !== 'implement' || manifest.scope?.role !== 'implement') throw new Error('reviewer gate run correlation mismatch');
  if (manifest.contract?.taskResultProtocol !== 2) throw new Error('unsupported task result protocol in phase manifest; finish the run manually or start a fresh run');
  return manifest;
}

export function captureRetainedApproval(root, { planPath, indexPath, runId, attempt }) {
  assertAttemptManifest(root, indexPath, { runId, attempt });
  let index;
  try { index = readWorkPath(root, indexPath, { encoding: 'utf8' }); }
  catch (error) { if (error.message === `work path: missing work artifact '${indexPath}'`) return null; throw error; }
  const matches = [...index.matchAll(/^Reviewer gate final: (\S+)$/gm)];
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error('ambiguous retained final reviewer gate');
  const state = matches[0][1];
  const baseline = baselineFor(root, state);
  if (baseline.config.attempt >= attempt) return null;
  // Interrupted dispatches without a result are not approvals; the skill handles
  // their existing blocked/re-review path without manufacturing a receipt.
  if (loadOptional(root, state, 'original') === null) return null;
  const evidence = readEvidence(root, state);
  if (evidence.result.status !== 'APPROVED' || !evidence.result.accepted) return null;
  verifyImplementReviews(root, { planPath, indexPath, runId: baseline.config.runId, attempt: baseline.config.attempt });
  return Object.freeze({ state, runId: baseline.config.runId, attempt: baseline.config.attempt, digest: hash(JSON.stringify(evidence)) });
}

export function verifyImplementReviews(root, { planPath, indexPath, runId, attempt, retainedApproval = null }) {
  const index = readWorkPath(root, indexPath, { encoding: 'utf8' });
  const { tasks } = reviewPhaseContext(readWorkPath(root, planPath, { encoding: 'utf8' }), index);
  const matches = [...index.matchAll(/^Reviewer gate final: (\S+)$/gm)];
  if (matches.length !== 1) throw new Error('missing or ambiguous final reviewer gate');
  const state = matches[0][1];
  const baseline = baselineFor(root, state);
  if (baseline.config.task !== 'final' || baseline.config.plan !== planPath || baseline.config.index !== indexPath) throw new Error('final reviewer gate correlation mismatch');
  assertAttemptManifest(root, indexPath, { runId, attempt });
  const executionProof = verifyTaskResults(root, { indexPath, expectedTasks: tasks, required: true });
  for (const execution of executionProof.executions) {
    if (execution.config.attempt > attempt) throw new Error('task result is from a future attempt');
    assertAttemptManifest(root, indexPath, execution.config);
  }
  const sameAttempt = baseline.config.runId === runId && baseline.config.attempt === attempt;
  if (!sameAttempt && !(retainedApproval?.state === state && retainedApproval.runId === baseline.config.runId
    && retainedApproval.attempt === baseline.config.attempt && retainedApproval.attempt < attempt
    && retainedApproval.digest === hash(JSON.stringify(readEvidence(root, state))))) throw new Error('final reviewer gate correlation mismatch');
  assertAttemptManifest(root, indexPath, baseline.config);
  const details = handoffDetails(root, planPath, indexPath, state);
  if (baseline.handoff !== details.digest) throw new Error('reviewed task handoff changed');
  for (const proof of details.proofs) {
    if (proof.config.attempt > baseline.config.attempt) throw new Error('task reviewer gate is from a future attempt');
    assertAttemptManifest(root, indexPath, proof.config);
  }
  const result = inspectReview(root, state);
  if (!result.accepted || result.status !== 'APPROVED') throw new Error('final reviewer gate is not approved');
  return { state, runId, attempt, status: 'APPROVED', ...(sameAttempt ? {} : { retainedApproval }) };
}
export function main(argv) {
  const { values } = parseArgs({ args: argv, options: Object.fromEntries(['repo-root', 'state', 'action', 'run-id', 'attempt', 'iteration', 'task', 'report', 'issues', 'format', 'plan', 'task-result-index', 'previous-state', 'resume-final', 'execution'].map((name) => [name, { type: 'string' }])) });
  const root = resolve(values['repo-root'] ?? '.');
  const state = values.state;
  let result;
  if (values.action === 'begin') result = beginReview(root, state, { runId: values['run-id'], attempt: Number(values.attempt), iteration: Number(values.iteration), task: values.task, report: values.report, issues: values.issues, format: values.format ?? 'text', plan: values.plan ?? null, index: values['task-result-index'] ?? null,
    ...(values.execution === undefined ? {} : { execution: values.execution }) });
  else if (values.action === 'inspect') result = inspectReview(root, state);
  else if (values.action === 'bind-reference') result = setReviewReference(root, { indexPath: values['task-result-index'], state, previousState: values['previous-state'] ?? null });
  else if (values.action === 'verify-handoff') {
    const options = { planPath: values.plan, indexPath: values['task-result-index'], runId: values['run-id'], attempt: Number(values.attempt) };
    const retainedApproval = values['resume-final'] === undefined ? null : captureRetainedApproval(root, options);
    if (values['resume-final'] !== undefined && retainedApproval?.state !== values['resume-final']) throw new Error('invalid explicit retained review capability');
    result = verifyImplementReviews(root, { ...options, retainedApproval });
  }
  else if (values.action === 'check') result = checkReview(root, state, readFileSync(0, 'utf8'));
  else throw new Error('action must be begin, check, inspect, verify-handoff, or bind-reference');
  const { response, observation, snapshot: ignoredSnapshot, ...receipt } = result;
  console.log(JSON.stringify(receipt));
  return result.status === 'BLOCKED' || result.status === 'NEEDS_CONTEXT' ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

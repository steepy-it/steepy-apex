import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readWorkPath, writeWorkPath, parseWorkPath } from './work-paths.mjs';
import { observeSource, validateSourceObservation, changedSourcePaths, assertSourceContinuation, assertSourcePath } from './source-observation.mjs';

const VERSION = 2;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digestPattern = /^[a-f0-9]{64}$/;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const followsAttempt = (before, after) => before.attempt < after.attempt || before.attempt === after.attempt && before.runId === after.runId;
const taskNumber = (value) => typeof value === 'string' && /^[1-9]\d*$/.test(value) && positive(Number(value));
const START = '<!-- steepy-task-results: v2 -->';
const END = '<!-- /steepy-task-results -->';
function keys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !equal(Object.keys(value).sort(), [...expected].sort())) throw new Error(`invalid ${label} schema`);
}
// JSON.parse accepts duplicate properties, including escaped aliases. Receipt
// and semantic transport objects must have one unambiguous value per key.
function strictJson(text) {
  const value = JSON.parse(text);
  let at = 0;
  const whitespace = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
  const string = () => {
    const start = at++;
    while (at < text.length) {
      if (text[at] === '\\') at += 2;
      else if (text[at++] === '"') return JSON.parse(text.slice(start, at));
    }
    throw new Error('invalid JSON string');
  };
  const walk = () => {
    whitespace();
    if (text[at] === '"') { string(); return; }
    if (text[at] === '{') {
      at++; whitespace(); const found = new Set();
      while (text[at] !== '}') {
        whitespace(); const key = string();
        if (found.has(key)) throw new Error('duplicate JSON field');
        found.add(key); whitespace(); at++; walk(); whitespace();
        if (text[at] !== ',') break;
        at++;
      }
      at++; return;
    }
    if (text[at] === '[') {
      at++; whitespace();
      while (text[at] !== ']') { walk(); whitespace(); if (text[at] !== ',') break; at++; }
      at++; return;
    }
    while (at < text.length && !/[\s,}\]]/.test(text[at])) at++;
  };
  walk(); return value;
}
function pathFor(state, stage) {
  const path = `${state}-${stage}.${stage === 'report' ? 'md' : 'json'}`;
  parseWorkPath(path, 'work-output', stage === 'report' ? 'task-result-report' : 'task-result');
  return path;
}
function optional(root, path) {
  try { return readWorkPath(root, path); }
  catch (error) { if (error.message === `work path: missing work artifact '${path}'` || error.message.startsWith(`work path: missing ancestor directory for '${path}':`)) return null; throw error; }
}
function loadOptional(root, state, stage) {
  const bytes = optional(root, pathFor(state, stage));
  return bytes === null ? null : strictJson(bytes.toString('utf8'));
}
function saveBytes(root, path, bytes) {
  const previous = optional(root, path);
  if (previous !== null) {
    if (!previous.equals(bytes)) throw new Error('immutable task evidence replay mismatch');
    return;
  }
  // Under the conductor's exclusive cooperating-writer lease, publish complete
  // fsynced bytes by atomic rename. A killed staging writer leaves no partial
  // canonical artifact; a matching repeat is an immutable no-op above.
  writeWorkPath(root, path, bytes, { createOnly: true });
}
function save(root, state, stage, value) { saveBytes(root, pathFor(state, stage), Buffer.from(`${JSON.stringify(value)}\n`)); return value; }
function configFor(state, input) {
  const config = { ...input, previousState: input.previousState ?? null, parentState: input.parentState ?? input.previousState ?? null, format: input.format ?? 'text' };
  keys(config, ['runId', 'attempt', 'task', 'execution', 'role', 'report', 'planPath', 'previousState', 'parentState', 'format'], 'task config');
  if (typeof config.runId !== 'string' || !/^[A-Za-z0-9-]+$/.test(config.runId)
    || !positive(config.attempt) || !taskNumber(config.task) || !positive(config.execution)
    || !['implementer', 'fix', 'retry'].includes(config.role) || !['text', 'json'].includes(config.format)
    || state !== `${dirname(state)}/task-${config.task}-execution-${config.execution}`) throw new Error('invalid task correlation');
  pathFor(state, 'baseline');
  if (config.report !== `${dirname(state)}/task-${config.task}-report.md`) throw new Error('wrong task report path');
  parseWorkPath(config.report, 'work-output', 'task-report');
  parseWorkPath(config.planPath, 'work-output', 'plan');
  if (config.planPath !== `.apex/work/plans/${dirname(state).split('/').at(-1)}.md`) throw new Error('task plan correlation mismatch');
  if (config.role === 'implementer' ? config.execution !== 1 || config.previousState !== null
    : config.execution <= 1 || config.previousState !== `${dirname(state)}/task-${config.task}-execution-${config.execution - 1}`) throw new Error('invalid task fix lineage');
  if (config.role === 'retry' && config.parentState !== config.previousState) throw new Error('task retry requires the latest parent to be its previous execution');
  if (config.parentState !== null) {
    pathFor(config.parentState, 'baseline');
    if (dirname(config.parentState) !== dirname(state) || config.parentState === state) throw new Error('invalid task parent state');
  }
  return Object.fromEntries(['runId', 'attempt', 'task', 'execution', 'role', 'report', 'planPath', 'previousState', 'parentState', 'format'].map((field) => [field, config[field]]));
}
// Only a replay-validated semantic non-success is retryable. Malformed transport,
// absent reports and incomplete publication never acquire this derived capability.
function retryable(evidence) {
  return evidence?.result?.accepted === false && evidence.result.reason === 'task did not complete'
    && ['NEEDS_CONTEXT', 'BLOCKED'].includes(evidence.result.status);
}
function permitsParent(config, parent) {
  return parent?.result?.accepted || config.role === 'retry' && config.parentState === config.previousState && retryable(parent);
}
function permitsPrevious(config, previous) {
  return config.role === 'retry' ? retryable(previous) : previous?.result?.accepted;
}
function planDigest(root, config) {
  const text = readWorkPath(root, config.planPath, { encoding: 'utf8' });
  const header = /^((?:[ \t\r\n]*<!--(?!\s*steepy-workflow:)[\s\S]*?-->)*[ \t\r\n]*<!-- steepy-workflow: v1\r?\n)([\s\S]*?)(\r?\n-->)/.exec(text);
  if (!header) {
    if (/<!--\s*steepy-workflow:/.test(text)) throw new Error('invalid task plan lifecycle header');
    return hash(text);
  }
  const entries = header[2].split(/\r?\n/).map((line) => /^([a-z-]+): (.+)$/.exec(line));
  if (entries.some((entry) => !entry) || entries.length !== 5) throw new Error('invalid task plan lifecycle header');
  const fields = Object.fromEntries(entries.map((entry) => [entry[1], entry[2]]));
  keys(fields, ['phase', 'status', 'next', 'source', 'consumed-by'], 'task plan lifecycle');
  const index = `${dirname(config.report)}/task-result-index.md`;
  if (fields.phase !== 'plan' || fields.next !== 'implement'
    || !(fields.status === 'READY' && fields['consumed-by'] === 'none' || fields.status === 'CONSUMED' && fields['consumed-by'] === index)) throw new Error('invalid task plan lifecycle transition');
  parseWorkPath(fields.source, 'spec');
  return hash(header[1] + header[2].replace(/^status: (READY|CONSUMED)(?=\r?$)/m, 'status: <lifecycle>')
    .replace(/^consumed-by: [^\r\n]+(?=\r?$)/m, 'consumed-by: <lifecycle>') + header[3] + text.slice(header[0].length));
}
function readBaseline(root, state, cache) {
  const baseline = loadOptional(root, state, 'baseline');
  keys(baseline, ['version', 'config', 'planDigest', 'previousDigest', 'parentDigest', 'sequence', 'before', 'taskBefore'], 'task baseline');
  if (baseline.version !== VERSION || !digestPattern.test(baseline.planDigest) || !positive(baseline.sequence)) throw new Error('invalid task baseline');
  const config = configFor(state, baseline.config);
  if (!equal(config, baseline.config) || planDigest(root, config) !== baseline.planDigest) throw new Error('task plan binding changed');
  validateSourceObservation(baseline.before); validateSourceObservation(baseline.taskBefore);
  const parent = config.parentState === null ? null : readEvidence(root, config.parentState, cache);
  if (parent === null) {
    if (baseline.parentDigest !== null || baseline.sequence !== 1 || config.previousState !== null) throw new Error('invalid initial execution lineage');
  } else if (!permitsParent(config, parent) || baseline.parentDigest !== parent.digest || baseline.sequence !== parent.baseline.sequence + 1
    || !equal(baseline.before, parent.result.after) || !followsAttempt(parent.baseline.config, config)
    || parent.baseline.planDigest !== baseline.planDigest) throw new Error('task parent lineage mismatch');
  if (config.previousState === null) {
    if (baseline.previousDigest !== null || !equal(baseline.before, baseline.taskBefore)) throw new Error('invalid initial task baseline');
    if (parent?.history.some((entry) => entry.config.task === config.task)) throw new Error('task execution cannot restart');
  } else {
    const previous = readEvidence(root, config.previousState, cache);
    const latest = parent?.history.filter((entry) => entry.config.task === config.task).at(-1);
    if (!permitsPrevious(config, previous) || baseline.previousDigest !== previous.digest || latest?.state !== config.previousState
      || !equal(baseline.taskBefore, previous.baseline.taskBefore) || !followsAttempt(previous.baseline.config, config)
      || previous.baseline.planDigest !== baseline.planDigest) throw new Error('task fix lineage mismatch');
  }
  return baseline;
}
function parseResponse(response, config, report, priorSignals = []) {
  if (typeof response !== 'string' || Buffer.from(response).toString('utf8') !== response) throw new Error('invalid task response');
  let value;
  if (config.format === 'json') value = strictJson(response);
  else {
    const lines = response.trim().split(/\r?\n/);
    const entries = lines.map((line) => /^(status|artifact|signals|changed-paths): (.*)$/.exec(line));
    if (entries.some((entry) => !entry) || new Set(entries.map((entry) => entry[1])).size !== entries.length) throw new Error('invalid task response fields');
    value = Object.fromEntries(entries.map((entry) => [entry[1], entry[2]]));
  }
  keys(value, ['status', 'artifact', 'signals', ...(Object.hasOwn(value, 'changed-paths') ? ['changed-paths'] : [])], 'task response');
  if (Object.hasOwn(value, 'changed-paths') && typeof value['changed-paths'] !== 'string') throw new Error('invalid legacy task telemetry');
  if (!['DONE', 'DONE_WITH_CONCERNS', 'BLOCKED', 'NEEDS_CONTEXT'].includes(value.status) || value.artifact !== config.report) throw new Error('invalid task response status or artifact');
  const signals = Array.isArray(value.signals) && config.format === 'json' ? value.signals
    : typeof value.signals === 'string' ? value.signals === 'none' ? [] : value.signals.split(', ') : null;
  if (!signals || signals.some((signal) => typeof signal !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(signal) || signal === 'none')
    || new Set(signals).size !== signals.length) throw new Error('invalid task response signals');
  const discovery = signals.includes('discovery:unplanned');
  if (discovery !== report.includes('discovery:unplanned') || discovery && value.status === 'DONE'
    || priorSignals.includes('discovery:unplanned') && !discovery) throw new Error('inconsistent task discovery signal');
  return { status: value.status, artifact: value.artifact, signals };
}
function deriveResult(baseline, capture, priorResult) {
  const report = Buffer.from(capture.reportBytes, 'base64');
  const result = { version: VERSION, baselineDigest: hash(JSON.stringify(baseline)), response: capture.response,
    after: capture.after, report: { path: capture.reportPath, digest: hash(report), size: report.length },
    status: 'BLOCKED', accepted: false, artifact: baseline.config.report,
    changedPaths: [...new Set([...(priorResult?.changedPaths ?? []), ...changedSourcePaths(baseline.before, capture.after)])].sort(), executionChangedPaths: changedSourcePaths(baseline.before, capture.after), signals: [] };
  try {
    if (!report.toString('utf8').trim()) throw new Error('missing or empty task report');
    const semantic = parseResponse(capture.response, baseline.config, report.toString('utf8'), priorResult?.signals ?? []);
    Object.assign(result, semantic, { accepted: ['DONE', 'DONE_WITH_CONCERNS'].includes(semantic.status) });
    if (!result.accepted) result.reason = 'task did not complete';
  } catch (error) { result.reason = error.message; }
  return result;
}
function readEvidence(root, state, cache = new Map()) {
  if (cache.has(state)) {
    if (cache.get(state) === null) throw new Error('cyclic task lineage');
    return cache.get(state);
  }
  cache.set(state, null);
  const baseline = readBaseline(root, state, cache);
  const parent = baseline.config.parentState === null ? null : readEvidence(root, baseline.config.parentState, cache);
  const history = [...(parent?.history ?? []), { state, config: baseline.config, sequence: baseline.sequence }];
  const finish = (evidence) => { const value = { ...evidence, history }; cache.set(state, value); return value; };
  const capture = loadOptional(root, state, 'capture');
  const result = loadOptional(root, state, 'result');
  if (capture === null) {
    if (result !== null || optional(root, pathFor(state, 'report')) !== null) throw new Error('task result lacks capture evidence');
    return finish({ baseline, capture: null, result: null, digest: null });
  }
  keys(capture, ['version', 'baselineDigest', 'response', 'after', 'reportPath', 'reportBytes'], 'task capture');
  if (capture.version !== VERSION || capture.baselineDigest !== hash(JSON.stringify(baseline)) || typeof capture.response !== 'string'
    || capture.reportPath !== pathFor(state, 'report') || typeof capture.reportBytes !== 'string'
    || Buffer.from(capture.reportBytes, 'base64').toString('base64') !== capture.reportBytes) throw new Error('invalid task capture binding');
  validateSourceObservation(capture.after); assertSourceContinuation(root, baseline.before, capture.after);
  if (result === null) return finish({ baseline, capture, result: null, digest: null });
  const priorResult = baseline.config.previousState === null ? null : readEvidence(root, baseline.config.previousState, cache).result;
  const expected = deriveResult(baseline, capture, priorResult);
  if (!equal(result, expected)) throw new Error('task result replay mismatch');
  const frozen = readWorkPath(root, pathFor(state, 'report'));
  if (!frozen.equals(Buffer.from(capture.reportBytes, 'base64'))) throw new Error('frozen task report digest mismatch');
  return finish({ baseline, capture, result, digest: hash(JSON.stringify({ baseline, capture, result })) });
}
function facts(state, evidence) {
  if (!evidence.result) return { status: 'PENDING', accepted: false, retryable: false, resume: true, recoverableCapture: evidence.capture !== null, receipt: state, config: evidence.baseline.config };
  const { status, accepted, artifact, changedPaths, executionChangedPaths, signals, reason } = evidence.result;
  return { status, accepted, retryable: retryable(evidence), resume: true, artifact, changedPaths, executionChangedPaths, signals, receipt: state,
    digest: evidence.digest, sequence: evidence.baseline.sequence, config: evidence.baseline.config, ...(reason === undefined ? {} : { reason }) };
}
export function beginTask(root, state, input) {
  const config = configFor(state, input);
  const existing = loadOptional(root, state, 'baseline');
  if (existing !== null) {
    if (!equal(existing.config, config)) throw new Error('task begin config replay mismatch');
    return inspectTaskResult(root, state);
  }
  for (const stage of ['capture', 'result', 'report']) if (optional(root, pathFor(state, stage)) !== null) throw new Error('task execution evidence exists without baseline');
  const previous = config.previousState === null ? null : readEvidence(root, config.previousState);
  if (previous !== null) {
    if (!permitsPrevious(config, previous)) throw new Error(config.role === 'retry' ? 'cannot retry without a valid captured non-success task receipt' : 'cannot fix an incomplete task receipt');
    if (hash(readWorkPath(root, config.report)) !== previous.result.report.digest) throw new Error('task report drift before next execution');
  }
  const parent = config.parentState === null ? null : readEvidence(root, config.parentState);
  const before = observeSource(root);
  if (parent && (!permitsParent(config, parent) || parent.result.after.digest !== before.digest || !followsAttempt(parent.baseline.config, config))) throw new Error('task parent source or correlation drift');
  if (previous && parent?.history.filter((entry) => entry.config.task === config.task).at(-1)?.state !== config.previousState) throw new Error('task fix lineage mismatch');
  if (!previous && parent?.history.some((entry) => entry.config.task === config.task)) throw new Error('task execution cannot restart');
  if (previous && !parent) throw new Error('task fix requires parent receipt');
  const baseline = { version: VERSION, config, planDigest: planDigest(root, config), previousDigest: previous?.digest ?? null, parentDigest: parent?.digest ?? null, sequence: (parent?.baseline.sequence ?? 0) + 1,
    before, taskBefore: previous?.baseline.taskBefore ?? before };
  if (previous && (!followsAttempt(previous.baseline.config, config) || previous.baseline.planDigest !== baseline.planDigest)) throw new Error('task fix lineage mismatch');
  if (parent && parent.baseline.planDigest !== baseline.planDigest) throw new Error('task parent plan drift');
  save(root, state, 'baseline', baseline);
  return { status: 'READY', accepted: false, resume: false, receipt: state, config };
}
export function recordTaskResult(root, state, response) {
  const evidence = readEvidence(root, state);
  if (typeof response !== 'string') throw new Error('task response must be raw text');
  if (evidence.result !== null) {
    if (evidence.result.response !== response) throw new Error('task response replay mismatch');
    return inspectTaskResult(root, state);
  }
  const report = optional(root, evidence.baseline.config.report) ?? Buffer.alloc(0);
  const after = observeSource(root);
  assertSourceContinuation(root, evidence.baseline.before, after);
  const capture = { version: VERSION, baselineDigest: hash(JSON.stringify(evidence.baseline)), response, after,
    reportPath: pathFor(state, 'report'), reportBytes: report.toString('base64') };
  if (evidence.capture !== null && !equal(evidence.capture, capture)) throw new Error('interrupted task capture replay mismatch');
  save(root, state, 'capture', capture);
  saveBytes(root, pathFor(state, 'report'), report);
  const priorResult = evidence.baseline.config.previousState === null ? null : readEvidence(root, evidence.baseline.config.previousState).result;
  save(root, state, 'result', deriveResult(evidence.baseline, capture, priorResult));
  return inspectTaskResult(root, state);
}
export function inspectTaskResult(root, state, { checkCurrent = true } = {}) {
  const evidence = readEvidence(root, state);
  if (checkCurrent && evidence.result !== null) {
    if (observeSource(root).digest !== evidence.result.after.digest) throw new Error('task source snapshot drift');
    if (hash(optional(root, evidence.baseline.config.report) ?? Buffer.alloc(0)) !== evidence.result.report.digest) throw new Error('task report drift');
  }
  return facts(state, evidence);
}
export function resumeTaskResult(root, state) {
  const evidence = readEvidence(root, state);
  if (evidence.result !== null || evidence.capture === null) return inspectTaskResult(root, state);
  return recordTaskResult(root, state, evidence.capture.response);
}
function validateEntry(value) {
  keys(value, ['task', 'status', 'artifact', 'changedPaths', 'signals', 'receipt'], 'task result projection entry');
  if (!taskNumber(value.task) || !['DONE', 'DONE_WITH_CONCERNS'].includes(value.status)
    || !Array.isArray(value.changedPaths) || !Array.isArray(value.signals)) throw new Error('invalid task result projection entry');
  parseWorkPath(value.artifact, 'work-output', 'task-report'); pathFor(value.receipt, 'baseline');
  if (value.artifact !== `${dirname(value.receipt)}/task-${value.task}-report.md`
    || !value.receipt.startsWith(`${dirname(value.artifact)}/task-${value.task}-execution-`)) throw new Error('task result projection correlation mismatch');
  for (const path of value.changedPaths) assertSourcePath(path);
  if (!equal([...new Set(value.changedPaths)].sort(), value.changedPaths)
    || value.signals.some((signal) => typeof signal !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(signal))
    || new Set(value.signals).size !== value.signals.length) throw new Error('invalid task result projection values');
  return value;
}
function projectionBlock(text) {
  const markers = text.match(/^<!--\s*\/?steepy-task-results\b[^\r\n]*/gm) ?? [];
  if (!markers.length) return null;
  const matches = [...text.matchAll(/^<!-- steepy-task-results: v2 -->\r?\n```json\r?\n([\s\S]*?)\r?\n```\r?\n<!-- \/steepy-task-results -->$/gm)];
  if (matches.length !== 1 || markers.length !== 2 || /^\s*[-*]\s+Task\b/m.test(text)) throw new Error('invalid task result projection block');
  return matches[0];
}
export function parseTaskResultProjection(text) {
  const block = projectionBlock(text);
  if (block === null) return null;
  let entries;
  try { entries = strictJson(block[1]); } catch { throw new Error('invalid task result projection JSON'); }
  if (!Array.isArray(entries)) throw new Error('invalid task result projection array');
  let previous = 0;
  for (const entry of entries) {
    validateEntry(entry);
    if (Number(entry.task) <= previous) throw new Error('invalid task result projection task order');
    previous = Number(entry.task);
  }
  return entries;
}
function entryFor(state, evidence) {
  const result = evidence.result;
  if (!result?.accepted) throw new Error('task receipt is not a completed execution');
  return { task: evidence.baseline.config.task, status: result.status, artifact: result.artifact,
    changedPaths: result.changedPaths, signals: result.signals, receipt: state };
}
export function projectTaskResults(root, { indexPath, states }) {
  parseWorkPath(indexPath, 'work-output', 'task-result-index');
  if (!Array.isArray(states) || new Set(states).size !== states.length) throw new Error('invalid task projection states');
  const entries = states.map((state) => {
    if (dirname(state) !== dirname(indexPath)) throw new Error('task projection outside index directory');
    return entryFor(state, readEvidence(root, state));
  }).sort((a, b) => Number(a.task) - Number(b.task));
  const block = `${START}\n\`\`\`json\n${JSON.stringify(entries, null, 2)}\n\`\`\`\n${END}`;
  parseTaskResultProjection(block);
  const before = optional(root, indexPath)?.toString('utf8') ?? '';
  const old = projectionBlock(before);
  const after = old === null ? before.replace(/^- Task[^\r\n]*(?:\r?\n|$)/gm, '') + (before.endsWith('\n') || !before ? '' : '\n') + block + '\n'
    : before.slice(0, old.index) + block + before.slice(old.index + old[0].length);
  if (after !== before) writeWorkPath(root, indexPath, after);
  return { indexPath, entries, changed: after !== before };
}
export function verifyTaskResults(root, { indexPath, expectedTasks, checkCurrent = true, required = true }) {
  parseWorkPath(indexPath, 'work-output', 'task-result-index');
  const entries = parseTaskResultProjection(readWorkPath(root, indexPath, { encoding: 'utf8' }));
  if (entries === null) {
    if (required) throw new Error('required v2 task result receipts are missing');
    return { entries: null, proofs: [], executions: [], digest: null };
  }
  if (!entries.length) throw new Error('task result receipts are empty');
  if (expectedTasks !== undefined) {
    const tasks = expectedTasks.map((task) => typeof task === 'string' ? task : task.task);
    if (!equal(tasks, entries.map((entry) => entry.task))) throw new Error('task result projection coverage mismatch');
  }
  const cache = new Map();
  const evidence = entries.map((entry) => {
    if (dirname(entry.receipt) !== dirname(indexPath)) throw new Error('task receipt outside index directory');
    const proof = readEvidence(root, entry.receipt, cache);
    if (!equal(entry, entryFor(entry.receipt, proof))) throw new Error('task result projection receipt mismatch');
    if (hash(readWorkPath(root, proof.baseline.config.report)) !== proof.result.report.digest) throw new Error('task report drift');
    return proof;
  });
  const latest = evidence.reduce((current, proof) => proof.baseline.sequence > current.baseline.sequence ? proof : current);
  const latestPerTask = new Map(latest.history.map((entry) => [entry.config.task, entry.state]));
  if (latestPerTask.size !== entries.length || entries.some((entry) => latestPerTask.get(entry.task) !== entry.receipt)) throw new Error('task execution chain coverage mismatch');
  if (checkCurrent && latest.result.after.digest !== observeSource(root).digest) throw new Error('latest task source snapshot drift');
  const proofs = evidence.map((proof, index) => ({ task: entries[index].task, state: entries[index].receipt, digest: proof.digest, sequence: proof.baseline.sequence, config: proof.baseline.config }));
  // The validated global chain includes superseded same-task executions. Expose
  // their provenance without changing the established latest-per-task proof digest.
  const executions = latest.history.map((entry) => ({ ...entry, digest: cache.get(entry.state).digest }));
  return { entries, proofs, executions, digest: hash(JSON.stringify({ entries, proofs })) };
}

export function main(argv) {
  const { values } = parseArgs({ args: argv, options: Object.fromEntries(['repo-root', 'action', 'state', 'run-id', 'attempt', 'task', 'execution', 'role', 'report', 'plan', 'previous-state', 'parent-state', 'format', 'task-result-index', 'states', 'expected-tasks'].map((name) => [name, { type: 'string' }])) });
  const root = resolve(values['repo-root'] ?? '.');
  let result;
  if (values.action === 'begin') result = beginTask(root, values.state, { runId: values['run-id'], attempt: Number(values.attempt), task: values.task,
    execution: Number(values.execution), role: values.role, report: values.report, planPath: values.plan, previousState: values['previous-state'] ?? null, parentState: values['parent-state'] ?? values['previous-state'] ?? null, format: values.format ?? 'text' });
  else if (values.action === 'record') result = recordTaskResult(root, values.state, readFileSync(0, 'utf8'));
  else if (values.action === 'inspect') result = inspectTaskResult(root, values.state);
  else if (values.action === 'resume') result = resumeTaskResult(root, values.state);
  else if (values.action === 'project') result = projectTaskResults(root, { indexPath: values['task-result-index'], states: JSON.parse(values.states) });
  else if (values.action === 'verify') result = verifyTaskResults(root, { indexPath: values['task-result-index'], expectedTasks: values['expected-tasks'] === undefined ? undefined : JSON.parse(values['expected-tasks']) });
  else throw new Error('action must be begin, record, inspect, resume, project, or verify');
  console.log(JSON.stringify(result));
  return result.status === 'BLOCKED' || result.status === 'NEEDS_CONTEXT' ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readWorkPath, writeWorkPath, parseWorkPath } from './work-paths.mjs';
import { observeSource, validateSourceObservation, changedSourcePaths, assertSourceContinuation, assertSourcePath } from './source-observation.mjs';

const VERSION = 2;
// A baseline whose fix continues an imported task carries one more correlation
// field, so it is a distinct on-disk schema version. The writer protocol and its
// capture/result artifacts stay version 2.
const IMPORT_LINEAGE_VERSION = 3;
const IMPORT_VERSION = 1;
const CONFIG_FIELDS = ['runId', 'attempt', 'task', 'execution', 'role', 'report', 'planPath', 'previousState', 'parentState', 'format'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digestPattern = /^[a-f0-9]{64}$/;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const followsAttempt = (before, after) => before.attempt < after.attempt || before.attempt === after.attempt && before.runId === after.runId;
const taskNumber = (value) => typeof value === 'string' && /^[1-9]\d*$/.test(value) && positive(Number(value));
// Index protocol 2 projects only this run's executions; protocol 3 also
// projects verified imports, each entry naming its explicit kind.
const START = Object.freeze({ 2: '<!-- steepy-task-results: v2 -->', 3: '<!-- steepy-task-results: v3 -->' });
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
  const imported = config.previousImport !== undefined && config.previousImport !== null;
  if (!imported) delete config.previousImport;
  keys(config, [...CONFIG_FIELDS, ...(imported ? ['previousImport'] : [])], 'task config');
  if (typeof config.runId !== 'string' || !/^[A-Za-z0-9-]+$/.test(config.runId)
    || !positive(config.attempt) || !taskNumber(config.task) || !positive(config.execution)
    || !['implementer', 'fix', 'retry'].includes(config.role) || !['text', 'json'].includes(config.format)
    || state !== `${dirname(state)}/task-${config.task}-execution-${config.execution}`) throw new Error('invalid task correlation');
  pathFor(state, 'baseline');
  if (config.report !== `${dirname(state)}/task-${config.task}-report.md`) throw new Error('wrong task report path');
  parseWorkPath(config.report, 'work-output', 'task-report');
  parseWorkPath(config.planPath, 'work-output', 'plan');
  if (config.planPath !== `.apex/work/plans/${dirname(state).split('/').at(-1)}.md`) throw new Error('task plan correlation mismatch');
  if (imported) {
    // The import is the task's first evidence, so its first fix is execution 2
    // and continues the import, never an earlier execution of this run.
    if (config.role !== 'fix' || config.execution !== 2 || config.previousState !== null
      || config.previousImport !== `${dirname(state)}/task-${config.task}-import.json`) throw new Error('invalid task import lineage');
    parseWorkPath(config.previousImport, 'work-output', 'task-import');
  } else if (config.role === 'implementer' ? config.execution !== 1 || config.previousState !== null
    : config.execution <= 1 || config.previousState !== `${dirname(state)}/task-${config.task}-execution-${config.execution - 1}`) throw new Error('invalid task fix lineage');
  if (config.role === 'retry' && config.parentState !== config.previousState) throw new Error('task retry requires the latest parent to be its previous execution');
  if (config.parentState !== null) {
    pathFor(config.parentState, 'baseline');
    if (dirname(config.parentState) !== dirname(state) || config.parentState === state) throw new Error('invalid task parent state');
  }
  return Object.fromEntries([...CONFIG_FIELDS, ...(imported ? ['previousImport'] : [])].map((field) => [field, config[field]]));
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
  const config = configFor(state, baseline.config);
  if (baseline.version !== (config.previousImport === undefined ? VERSION : IMPORT_LINEAGE_VERSION)
    || !digestPattern.test(baseline.planDigest) || !positive(baseline.sequence)) throw new Error('invalid task baseline');
  if (!equal(config, baseline.config) || planDigest(root, config) !== baseline.planDigest) throw new Error('task plan binding changed');
  validateSourceObservation(baseline.before); validateSourceObservation(baseline.taskBefore);
  const parent = config.parentState === null ? null : readEvidence(root, config.parentState, cache);
  if (parent === null) {
    if (baseline.parentDigest !== null || baseline.sequence !== 1 || config.previousState !== null) throw new Error('invalid initial execution lineage');
  } else if (!permitsParent(config, parent) || baseline.parentDigest !== parent.digest || baseline.sequence !== parent.baseline.sequence + 1
    || !equal(baseline.before, parent.result.after) || !followsAttempt(parent.baseline.config, config)
    || parent.baseline.planDigest !== baseline.planDigest) throw new Error('task parent lineage mismatch');
  if (config.previousImport !== undefined) {
    const imported = inspectTaskImport(root, config.previousImport);
    if (baseline.previousDigest !== imported.digest || imported.task !== config.task || imported.runId !== config.runId
      || !equal(baseline.taskBefore, imported.taskBefore) || imported.planDigest !== baseline.planDigest
      || parent === null && baseline.before.digest !== imported.observation.digest) throw new Error('task import lineage mismatch');
    if (parent?.history.some((entry) => entry.config.task === config.task)) throw new Error('task execution cannot restart');
  } else if (config.previousState === null) {
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
  const expected = deriveResult(baseline, capture, priorResultOf(root, baseline.config, cache));
  if (!equal(result, expected)) throw new Error('task result replay mismatch');
  const frozen = readWorkPath(root, pathFor(state, 'report'));
  if (!frozen.equals(Buffer.from(capture.reportBytes, 'base64'))) throw new Error('frozen task report digest mismatch');
  return finish({ baseline, capture, result, digest: hash(JSON.stringify({ baseline, capture, result })) });
}
// The prior same-task result continues cumulative paths and signals. A fix of
// an imported task continues the verified historical result it imports.
function priorResultOf(root, config, cache = new Map()) {
  if (config.previousState !== null) return readEvidence(root, config.previousState, cache).result;
  if (config.previousImport === undefined) return null;
  const imported = inspectTaskImport(root, config.previousImport);
  return { changedPaths: imported.changedPaths, signals: imported.signals };
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
  const imported = config.previousImport === undefined ? null : inspectTaskImport(root, config.previousImport);
  const parent = config.parentState === null ? null : readEvidence(root, config.parentState);
  const before = observeSource(root);
  if (parent && (!permitsParent(config, parent) || parent.result.after.digest !== before.digest || !followsAttempt(parent.baseline.config, config))) throw new Error('task parent source or correlation drift');
  if (imported && (imported.task !== config.task || imported.runId !== config.runId)) throw new Error('task import lineage mismatch');
  if (imported && !parent && imported.observation.digest !== before.digest) throw new Error('task import source drift');
  if (previous && parent?.history.filter((entry) => entry.config.task === config.task).at(-1)?.state !== config.previousState) throw new Error('task fix lineage mismatch');
  if (!previous && parent?.history.some((entry) => entry.config.task === config.task)) throw new Error('task execution cannot restart');
  if (previous && !parent) throw new Error('task fix requires parent receipt');
  const baseline = { version: imported ? IMPORT_LINEAGE_VERSION : VERSION, config, planDigest: planDigest(root, config),
    previousDigest: previous?.digest ?? imported?.digest ?? null, parentDigest: parent?.digest ?? null, sequence: (parent?.baseline.sequence ?? 0) + 1,
    before, taskBefore: previous?.baseline.taskBefore ?? imported?.taskBefore ?? before };
  if (imported && imported.planDigest !== baseline.planDigest) throw new Error('task import plan drift');
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
  save(root, state, 'result', deriveResult(evidence.baseline, capture, priorResultOf(root, evidence.baseline.config)));
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
// ---- Imported evidence ----------------------------------------------------
// A recovery run imports a verified historical execution as its own receipt
// type. It records the present observation, the delta from the source lineage
// head to it, and the source digests; it never carries a writer response, a
// completion status, or a re-dated execution baseline.
const IMPORT_FIELDS = ['version', 'kind', 'runId', 'task', 'planPath', 'planDigest', 'recoveryInput', 'source', 'observation', 'delta'];
function isAncestor(root, ancestor, head) {
  try { execFileSync('git', ['merge-base', '--is-ancestor', ancestor, head], { cwd: root, stdio: 'ignore' }); return true; }
  catch { return false; }
}
function sortedPaths(values, label) {
  if (!Array.isArray(values)) throw new Error(`invalid ${label}`);
  for (const path of values) assertSourcePath(path);
  if (!equal([...new Set(values)].sort(), values)) throw new Error(`invalid ${label}`);
  return values;
}
// Every attempt of the imported lineage needs its individually declared legacy
// phase manifest: the exact digest, its own run identity, and protocol 2.
function verifySourceManifests(root, sourceDir, history, manifests) {
  const attempts = new Map();
  for (const entry of history) {
    if (attempts.has(entry.config.attempt) && attempts.get(entry.config.attempt) !== entry.config.runId) {
      throw new Error(`source attempt ${entry.config.attempt} mixes run identities`);
    }
    attempts.set(entry.config.attempt, entry.config.runId);
  }
  const ordered = [...attempts.keys()].sort((a, b) => a - b);
  if (!Array.isArray(manifests) || manifests.length !== ordered.length) throw new Error('source manifests must name exactly each attempt of the imported lineage');
  manifests.forEach((manifest, index) => {
    keys(manifest, ['path', 'sha256'], 'source manifest reference');
    const attempt = ordered[index];
    if (manifest.path !== `${sourceDir}/context/phase-implement-attempt-${attempt}.json` || !digestPattern.test(manifest.sha256)) {
      throw new Error('source manifests must name exactly each attempt of the imported lineage');
    }
    const bytes = readWorkPath(root, manifest.path, { family: 'manifest' });
    if (hash(bytes) !== manifest.sha256) throw new Error(`source manifest digest mismatch: ${manifest.path}`);
    let value;
    try { value = strictJson(bytes.toString('utf8')); } catch { throw new Error(`invalid source manifest: ${manifest.path}`); }
    const runId = attempts.get(attempt);
    if (value?.runId !== runId || value.attempt !== attempt || value.scope?.phase !== 'implement' || value.scope?.role !== 'implement') {
      throw new Error(`source attempt ${attempt} manifest does not bind run ${runId}`);
    }
    if (value.contract?.taskResultProtocol !== 2) throw new Error(`source attempt ${attempt} is not task result protocol 2; refusing implicit conversion`);
  });
}
// Historical validation follows only the schema-authorized lineage links of
// the source run; its HEAD is never equated with the present one.
function sourceEvidence(root, targetDir, task, source) {
  for (const state of [source.state, source.head]) pathFor(state, 'baseline');
  const sourceDir = dirname(source.state);
  if (sourceDir === targetDir) throw new Error('import source must belong to another run');
  if (dirname(source.head) !== sourceDir) throw new Error('import source head must belong to the source run');
  const cache = new Map();
  const head = readEvidence(root, source.head, cache);
  const evidence = readEvidence(root, source.state, cache);
  if (!evidence.result?.accepted || evidence.baseline.config.task !== task) throw new Error('import source is not an accepted execution of this task');
  if (head.result === null) throw new Error('import source head has no recorded result');
  if (head.history.filter((entry) => entry.config.task === task).at(-1)?.state !== source.state) {
    throw new Error('import source is not the latest execution of this task in its lineage');
  }
  verifySourceManifests(root, sourceDir, head.history, source.manifests);
  const first = cache.get(head.history[0].state);
  return { evidence, head, chainBase: first.baseline.before.head, result: hash(readWorkPath(root, pathFor(source.state, 'result'))) };
}
function importFacts(root, path, bytes) {
  const dir = dirname(path);
  let body;
  try { body = strictJson(bytes.toString('utf8')); } catch { throw new Error('invalid task import JSON'); }
  keys(body, IMPORT_FIELDS, 'task import');
  if (body.version !== IMPORT_VERSION || body.kind !== 'import' || typeof body.runId !== 'string' || !/^[A-Za-z0-9-]+$/.test(body.runId)
    || !taskNumber(body.task) || path !== `${dir}/task-${body.task}-import.json`
    || body.planPath !== `.apex/work/plans/${basename(dir)}.md` || !digestPattern.test(body.planDigest)) throw new Error('invalid task import correlation');
  keys(body.recoveryInput, ['path', 'sha256'], 'task import recovery input');
  if (body.recoveryInput.path !== `${dir}/recovery-input.json`
    || hash(readWorkPath(root, body.recoveryInput.path, { family: 'recovery-input' })) !== body.recoveryInput.sha256) {
    throw new Error('task import recovery input digest mismatch');
  }
  if (planDigest(root, { planPath: body.planPath, report: `${dir}/task-${body.task}-report.md` }) !== body.planDigest) throw new Error('task import plan binding changed');
  keys(body.source, ['state', 'evidence', 'result', 'head', 'headEvidence', 'manifests'], 'task import source');
  const source = sourceEvidence(root, dir, body.task, body.source);
  if (source.evidence.digest !== body.source.evidence || source.head.digest !== body.source.headEvidence
    || source.result !== body.source.result) throw new Error('task import source evidence digest mismatch');
  validateSourceObservation(body.observation);
  if (!equal(sortedPaths(body.delta, 'task import delta'), changedSourcePaths(source.head.result.after, body.observation))) {
    throw new Error('task import delta mismatch');
  }
  for (const ancestor of [source.chainBase, source.evidence.baseline.taskBefore.head]) {
    if (!isAncestor(root, ancestor, body.observation.head)) throw new Error('task import source history is not an ancestor of the observed HEAD');
  }
  return Object.freeze({
    kind: 'import', receipt: path, task: body.task, runId: body.runId, digest: hash(bytes), planDigest: body.planDigest,
    observation: body.observation, delta: body.delta, taskBefore: source.evidence.baseline.taskBefore, chainBase: source.chainBase,
    report: { path: pathFor(body.source.state, 'report'), digest: source.evidence.result.report.digest },
    changedPaths: source.evidence.result.changedPaths, signals: source.evidence.result.signals, source: body.source,
  });
}
// Validates a prospective import without writing it: historical source
// evidence, its declared manifests, and the delta to `observation`, which must
// equal the explained delta whenever one is supplied.
export function inspectImportSource(root, targetDir, { task, sourceState, sourceHead, manifests, explainedDelta, observation }) {
  if (!taskNumber(task)) throw new Error('invalid task import correlation');
  const source = sourceEvidence(root, targetDir, task, { state: sourceState, head: sourceHead, manifests });
  validateSourceObservation(observation);
  const delta = changedSourcePaths(source.head.result.after, observation);
  const declared = explainedDelta === undefined ? delta : sortedPaths([...new Set(explainedDelta)].sort(), 'explained delta');
  if (!equal(delta, declared)) {
    const unexplained = [...delta.filter((item) => !declared.includes(item)),
      ...declared.filter((item) => !delta.includes(item)).map((item) => `${item} (declared but unchanged)`)];
    throw new Error(`unexplained source delta requires reconciliation: ${unexplained.join(', ')}`);
  }
  for (const ancestor of [source.chainBase, source.evidence.baseline.taskBefore.head]) {
    if (!isAncestor(root, ancestor, observation.head)) throw new Error('task import source history is not an ancestor of the observed HEAD');
  }
  return Object.freeze({ ...source, delta, sequence: source.head.baseline.sequence });
}
export function importTaskResult(root, importPath, { runId, task, sourceState, sourceHead, manifests, explainedDelta }) {
  const { path } = parseWorkPath(importPath, 'work-output', 'task-import');
  const dir = dirname(path);
  if (typeof runId !== 'string' || !/^[A-Za-z0-9-]+$/.test(runId) || !taskNumber(task) || path !== `${dir}/task-${task}-import.json`) {
    throw new Error('invalid task import correlation');
  }
  const observation = observeSource(root);
  const { delta, ...source } = inspectImportSource(root, dir, { task, sourceState, sourceHead, manifests, explainedDelta: explainedDelta ?? [], observation });
  const planPath = `.apex/work/plans/${basename(dir)}.md`;
  const recoveryPath = `${dir}/recovery-input.json`;
  const body = { version: IMPORT_VERSION, kind: 'import', runId, task, planPath,
    planDigest: planDigest(root, { planPath, report: `${dir}/task-${task}-report.md` }),
    recoveryInput: { path: recoveryPath, sha256: hash(readWorkPath(root, recoveryPath, { family: 'recovery-input' })) },
    source: { state: sourceState, evidence: source.evidence.digest, result: source.result, head: sourceHead,
      headEvidence: source.head.digest, manifests },
    observation, delta };
  const bytes = Buffer.from(`${JSON.stringify(body)}\n`);
  importFacts(root, path, bytes);
  const previous = optional(root, path);
  if (previous !== null && !previous.equals(bytes)) throw new Error('task import replay mismatch');
  if (previous === null) writeWorkPath(root, path, bytes, { createOnly: true, family: 'task-import' });
  return inspectTaskImport(root, path);
}
export function inspectTaskImport(root, importPath, { checkCurrent = false } = {}) {
  const { path } = parseWorkPath(importPath, 'work-output', 'task-import');
  const facts = importFacts(root, path, readWorkPath(root, path, { family: 'task-import' }));
  if (checkCurrent && observeSource(root).digest !== facts.observation.digest) throw new Error('task import source snapshot drift');
  return facts;
}

// ---- Task result index projection ----------------------------------------
function validateEntry(value, protocol = 2) {
  if (protocol === 3) {
    keys(value, ['task', 'kind', 'status', 'artifact', 'changedPaths', 'signals', 'receipt'], 'task result projection entry');
    if (value.kind === 'import') {
      if (!taskNumber(value.task) || value.status !== 'IMPORTED' || !Array.isArray(value.changedPaths) || !Array.isArray(value.signals)) {
        throw new Error('invalid task result projection entry');
      }
      parseWorkPath(value.receipt, 'work-output', 'task-import');
      parseWorkPath(value.artifact, 'work-output', 'task-result-report');
      if (basename(value.receipt) !== `task-${value.task}-import.json` || dirname(value.artifact) === dirname(value.receipt)
        || !basename(value.artifact).startsWith(`task-${value.task}-execution-`)) throw new Error('task result projection correlation mismatch');
      validateValues(value);
      return value;
    }
    if (value.kind !== 'execution') throw new Error('invalid task result projection entry kind');
    const { kind: ignored, ...execution } = value;
    validateEntry(execution);
    return value;
  }
  keys(value, ['task', 'status', 'artifact', 'changedPaths', 'signals', 'receipt'], 'task result projection entry');
  if (!taskNumber(value.task) || !['DONE', 'DONE_WITH_CONCERNS'].includes(value.status)
    || !Array.isArray(value.changedPaths) || !Array.isArray(value.signals)) throw new Error('invalid task result projection entry');
  parseWorkPath(value.artifact, 'work-output', 'task-report'); pathFor(value.receipt, 'baseline');
  if (value.artifact !== `${dirname(value.receipt)}/task-${value.task}-report.md`
    || !value.receipt.startsWith(`${dirname(value.artifact)}/task-${value.task}-execution-`)) throw new Error('task result projection correlation mismatch');
  validateValues(value);
  return value;
}
function validateValues(value) {
  for (const path of value.changedPaths) assertSourcePath(path);
  if (!equal([...new Set(value.changedPaths)].sort(), value.changedPaths)
    || value.signals.some((signal) => typeof signal !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(signal))
    || new Set(value.signals).size !== value.signals.length) throw new Error('invalid task result projection values');
}
function projectionBlock(text) {
  const markers = text.match(/^<!--\s*\/?steepy-task-results\b[^\r\n]*/gm) ?? [];
  if (!markers.length) return null;
  const matches = [...text.matchAll(/^<!-- steepy-task-results: v([23]) -->\r?\n```json\r?\n([\s\S]*?)\r?\n```\r?\n<!-- \/steepy-task-results -->$/gm)];
  if (matches.length !== 1 || markers.length !== 2 || /^\s*[-*]\s+Task\b/m.test(text)) throw new Error('invalid task result projection block');
  return { index: matches[0].index, length: matches[0][0].length, protocol: Number(matches[0][1]), json: matches[0][2] };
}
function parseBlock(block) {
  let entries;
  try { entries = strictJson(block.json); } catch { throw new Error('invalid task result projection JSON'); }
  if (!Array.isArray(entries)) throw new Error('invalid task result projection array');
  let previous = 0;
  for (const entry of entries) {
    validateEntry(entry, block.protocol);
    if (Number(entry.task) <= previous) throw new Error('invalid task result projection task order');
    previous = Number(entry.task);
  }
  return entries;
}
export function parseTaskResultProjection(text) {
  const block = projectionBlock(text);
  return block === null ? null : parseBlock(block);
}
// The selected index protocol of a projection (2 or 3), or null without one.
export function taskResultIndexProtocol(text) {
  return projectionBlock(text)?.protocol ?? null;
}
function requireProtocol(actual, required) {
  if (required !== undefined && actual !== required) {
    throw new Error(`task result index protocol ${actual} does not match required protocol ${required}`);
  }
}
function entryFor(state, evidence) {
  const result = evidence.result;
  if (!result?.accepted) throw new Error('task receipt is not a completed execution');
  return { task: evidence.baseline.config.task, status: result.status, artifact: result.artifact,
    changedPaths: result.changedPaths, signals: result.signals, receipt: state };
}
const executionEntry = (entry) => ({ task: entry.task, kind: 'execution', status: entry.status, artifact: entry.artifact,
  changedPaths: entry.changedPaths, signals: entry.signals, receipt: entry.receipt });
// An imported task is never projected as a completed writer response.
const importEntry = (facts) => ({ task: facts.task, kind: 'import', status: 'IMPORTED', artifact: facts.report.path,
  changedPaths: facts.changedPaths, signals: facts.signals, receipt: facts.receipt });
const importLineage = (history) => history.some((entry) => entry.config.previousImport !== undefined);
export function projectTaskResults(root, { indexPath, states, imports = [], protocol = 2 }) {
  parseWorkPath(indexPath, 'work-output', 'task-result-index');
  if (![2, 3].includes(protocol)) throw new Error('task result index protocol must be 2 or 3');
  if (!Array.isArray(states) || !Array.isArray(imports) || new Set([...states, ...imports]).size !== states.length + imports.length) {
    throw new Error('invalid task projection states');
  }
  if (protocol === 2 && imports.length) throw new Error('imports require task result index protocol 3');
  const cache = new Map();
  const executions = states.map((state) => {
    if (dirname(state) !== dirname(indexPath)) throw new Error('task projection outside index directory');
    const evidence = readEvidence(root, state, cache);
    if (protocol === 2 && importLineage(evidence.history)) throw new Error('imported evidence requires task result index protocol 3');
    const entry = entryFor(state, evidence);
    return protocol === 3 ? executionEntry(entry) : entry;
  });
  const imported = imports.map((path) => {
    if (dirname(path) !== dirname(indexPath)) throw new Error('task projection outside index directory');
    return importEntry(inspectTaskImport(root, path));
  });
  const entries = [...executions, ...imported].sort((a, b) => Number(a.task) - Number(b.task));
  if (new Set(entries.map((entry) => entry.task)).size !== entries.length) throw new Error('invalid task projection states');
  const block = `${START[protocol]}\n\`\`\`json\n${JSON.stringify(entries, null, 2)}\n\`\`\`\n${END}`;
  parseTaskResultProjection(block);
  const before = optional(root, indexPath)?.toString('utf8') ?? '';
  const old = projectionBlock(before);
  if (old !== null) requireProtocol(old.protocol, protocol);
  const after = old === null ? before.replace(/^- Task[^\r\n]*(?:\r?\n|$)/gm, '') + (before.endsWith('\n') || !before ? '' : '\n') + block + '\n'
    : before.slice(0, old.index) + block + before.slice(old.index + old.length);
  if (after !== before) writeWorkPath(root, indexPath, after);
  return { indexPath, entries, changed: after !== before };
}
export function verifyTaskResults(root, { indexPath, expectedTasks, checkCurrent = true, required = true, protocol }) {
  parseWorkPath(indexPath, 'work-output', 'task-result-index');
  const block = projectionBlock(readWorkPath(root, indexPath, { encoding: 'utf8' }));
  if (block === null) {
    if (required) throw new Error(protocol === 3 ? 'required v3 task result receipts are missing' : 'required v2 task result receipts are missing');
    return { entries: null, proofs: [], executions: [], imports: [], digest: null };
  }
  requireProtocol(block.protocol, protocol);
  const entries = parseBlock(block);
  if (!entries.length) throw new Error('task result receipts are empty');
  if (expectedTasks !== undefined) {
    const tasks = expectedTasks.map((task) => typeof task === 'string' ? task : task.task);
    if (!equal(tasks, entries.map((entry) => entry.task))) throw new Error('task result projection coverage mismatch');
  }
  return block.protocol === 3 ? verifyV3(root, indexPath, entries, checkCurrent) : verifyV2(root, indexPath, entries, checkCurrent);
}
function verifyV2(root, indexPath, entries, checkCurrent) {
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
  if (importLineage(latest.history)) throw new Error('imported evidence requires task result index protocol 3');
  if (checkCurrent && latest.result.after.digest !== observeSource(root).digest) throw new Error('latest task source snapshot drift');
  const proofs = evidence.map((proof, index) => ({ task: entries[index].task, state: entries[index].receipt, digest: proof.digest, sequence: proof.baseline.sequence, config: proof.baseline.config }));
  // The validated global chain includes superseded same-task executions. Expose
  // their provenance without changing the established latest-per-task proof digest.
  const executions = latest.history.map((entry) => ({ ...entry, digest: cache.get(entry.state).digest }));
  return { entries, proofs, executions, imports: [], digest: hash(JSON.stringify({ entries, proofs })) };
}
// Protocol 3: execution entries cover this run's global chain exactly; import
// entries cover the tasks no execution has superseded. Every import shares the
// recovery run's observed baseline, from which the first execution starts.
function verifyV3(root, indexPath, entries, checkCurrent) {
  const dir = dirname(indexPath);
  const cache = new Map();
  const imports = new Map();
  const loadImport = (path) => {
    if (!imports.has(path)) imports.set(path, inspectTaskImport(root, path));
    return imports.get(path);
  };
  const proofs = [];
  const executionProofs = [];
  for (const entry of entries) {
    if (dirname(entry.receipt) !== dir) throw new Error('task receipt outside index directory');
    if (entry.kind === 'import') {
      const facts = loadImport(entry.receipt);
      if (!equal(entry, importEntry(facts))) throw new Error('task result projection import mismatch');
      proofs.push({ task: entry.task, kind: 'import', state: entry.receipt, digest: facts.digest });
      continue;
    }
    const proof = readEvidence(root, entry.receipt, cache);
    if (!equal(entry, executionEntry(entryFor(entry.receipt, proof)))) throw new Error('task result projection receipt mismatch');
    if (hash(readWorkPath(root, proof.baseline.config.report)) !== proof.result.report.digest) throw new Error('task report drift');
    executionProofs.push({ entry, proof });
    proofs.push({ task: entry.task, kind: 'execution', state: entry.receipt, digest: proof.digest, sequence: proof.baseline.sequence, config: proof.baseline.config });
  }
  let latest = null;
  if (executionProofs.length) {
    latest = executionProofs.reduce((current, item) => item.proof.baseline.sequence > current.proof.baseline.sequence ? item : current).proof;
    const latestPerTask = new Map(latest.history.map((entry) => [entry.config.task, entry.state]));
    if (latestPerTask.size !== executionProofs.length || executionProofs.some(({ entry }) => latestPerTask.get(entry.task) !== entry.receipt)) {
      throw new Error('task execution chain coverage mismatch');
    }
  }
  const history = latest?.history ?? [];
  for (const entry of history) if (entry.config.previousImport !== undefined) loadImport(entry.config.previousImport);
  const facts = [...imports.values()].sort((a, b) => Number(a.task) - Number(b.task));
  if (new Set(facts.map((item) => `${item.runId}:${item.observation.digest}`)).size > 1) {
    throw new Error('recovery imports disagree on the run or its observed baseline');
  }
  if (facts.length && history.some((entry) => entry.config.runId !== facts[0].runId)) throw new Error('task execution does not belong to the importing run');
  if (facts.length && history.length && cache.get(history[0].state).baseline.before.digest !== facts[0].observation.digest) {
    throw new Error('the first recovery execution does not start from the import observation');
  }
  if (checkCurrent) {
    const current = observeSource(root).digest;
    if ((latest ? latest.result.after.digest : facts[0].observation.digest) !== current) throw new Error('latest task source snapshot drift');
  }
  const executions = history.map((entry) => ({ ...entry, digest: cache.get(entry.state).digest }));
  return { entries, proofs, executions, imports: facts, digest: hash(JSON.stringify({ entries, proofs })) };
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

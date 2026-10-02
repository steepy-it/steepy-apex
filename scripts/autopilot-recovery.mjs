#!/usr/bin/env node
// Explicit recovery of a halted legacy Gear-3 run into a new controller run.
// One exact recovery-input.json, in the new run's own directory, declares the
// source run's spec, plan, phase manifests, and execution receipts with their
// digests, the tasks to reuse, the accepted current branch/HEAD/observation and
// delta, and the new spec/plan/run destinations. Nothing is discovered by
// listing: receipt ancestors are followed only through their own schema links.
//
// Inspection classifies each plan task (imported with a pending review, or
// residual work) and every condition that needs human reconciliation.
// Preparation writes deterministic copies of the approved spec and plan with
// their provenance and recovery authorization recorded in the present; the
// prepared plan must pass the controller's v2 plan gate first. The source run,
// spec, and plan are never rewritten. Importing and dispatch belong to the
// controller (`autopilot.mjs --recovery-input`).
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseStrictJson } from './inception-handoff.mjs';
import { controllerPlanContext, specPhaseContext } from './autopilot-context.mjs';
import { assertSourcePath, observeSource } from './source-observation.mjs';
import { inspectImportSource, inspectTaskResult } from './task-results.mjs';
import { parseWorkPath, readWorkPath, writeWorkPath } from './work-paths.mjs';

export const RECOVERY_INPUT_SCHEMA_VERSION = 1;
const RUN_DIR = /^\.apex\/work\/tasks\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;
const GIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TASK = /^[1-9]\d*$/;
const LIFECYCLE = /^((?:[ \t\r\n]*<!--(?!\s*steepy-workflow:)[\s\S]*?-->)*[ \t\r\n]*<!-- steepy-workflow: v1\r?\n)([\s\S]*?)(\r?\n-->)/;
const LIFECYCLE_FIELDS = ['phase', 'status', 'next', 'source', 'consumed-by'];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const lineOf = (value) => String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const fail = (message) => { throw new Error(message); };

function exact(value, names, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !equal(Object.keys(value).sort(), [...names].sort())) fail(`${label} fields must be closed: ${names.join(', ')}`);
  return value;
}

function fileReference(value, label, path) {
  exact(value, ['path', 'sha256'], label);
  if (value.path !== path || !SHA256.test(value.sha256)) fail(`${label} must name ${path} with its SHA-256`);
  return value;
}

function optionalWork(root, path, family) {
  try { return readWorkPath(root, path, { family }); } catch (error) {
    if (/^work path: missing (?:work artifact|ancestor directory)/.test(error.message)) return null;
    throw error;
  }
}

// The closed contract. Structural errors are refusals; drift found later is
// reported as reconciliation.
export function loadRecoveryInput(root, inputPath) {
  let path;
  try { ({ path } = parseWorkPath(inputPath, 'work-output', 'recovery-input')); } catch (error) {
    fail(`recovery input must be a run's exact recovery-input.json: ${error.message}`);
  }
  const dir = dirname(path);
  const destName = basename(dir);
  const bytes = readWorkPath(root, path, { family: 'recovery-input' });
  const input = parseStrictJson(bytes, 'recovery input');
  exact(input, ['schemaVersion', 'source', 'reuse', 'current', 'destination'], 'recovery input');
  if (input.schemaVersion !== RECOVERY_INPUT_SCHEMA_VERSION) fail('unsupported recovery input schemaVersion');
  exact(input.destination, ['spec', 'plan', 'run'], 'recovery input destination');
  if (input.destination.run !== dir || input.destination.spec !== `.apex/work/specs/${destName}.md`
    || input.destination.plan !== `.apex/work/plans/${destName}.md`) fail('recovery input destination must be this recovery run');
  exact(input.source, ['run', 'spec', 'plan', 'manifests', 'receipts'], 'recovery input source');
  const run = typeof input.source.run === 'string' ? RUN_DIR.exec(input.source.run) : null;
  if (!run) fail('recovery input source run must be a task run directory');
  if (input.source.run === dir) fail('recovery input source run must differ from the recovery destination');
  const sourceName = run[1];
  fileReference(input.source.spec, 'recovery input source spec', `.apex/work/specs/${sourceName}.md`);
  fileReference(input.source.plan, 'recovery input source plan', `.apex/work/plans/${sourceName}.md`);
  if (!Array.isArray(input.source.manifests) || input.source.manifests.length === 0) fail('recovery input source manifests must be a non-empty list');
  let attempt = 0;
  for (const manifest of input.source.manifests) {
    exact(manifest, ['path', 'sha256'], 'recovery input source manifest');
    if (typeof manifest.path === 'string' && manifest.path.startsWith(`${input.source.run}/context/role-`)) {
      fail('controller protocol 2 source runs are not importable by this recovery input; it declares legacy phase manifests only');
    }
    const match = typeof manifest.path === 'string'
      ? new RegExp(`^${input.source.run.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/context/phase-implement-attempt-([1-9]\\d*)\\.json$`).exec(manifest.path) : null;
    if (!match || Number(match[1]) <= attempt || !SHA256.test(manifest.sha256)) {
      fail(`recovery input source manifests must be ${input.source.run} implement phase manifests in attempt order`);
    }
    parseWorkPath(manifest.path, 'work-output', 'manifest');
    attempt = Number(match[1]);
  }
  if (!Array.isArray(input.source.receipts) || input.source.receipts.length === 0) fail('recovery input source receipts must be a non-empty list');
  let task = 0;
  for (const receipt of input.source.receipts) {
    exact(receipt, ['task', 'path', 'sha256'], 'recovery input receipt');
    if (typeof receipt.task !== 'string' || !TASK.test(receipt.task) || Number(receipt.task) <= task) {
      fail('recovery input receipts must name distinct tasks in order');
    }
    if (typeof receipt.path !== 'string' || !receipt.path.startsWith(`${input.source.run}/task-${receipt.task}-execution-`)
      || !receipt.path.endsWith('-result.json') || !SHA256.test(receipt.sha256)) {
      fail(`recovery input receipt for Task ${receipt.task} must be an execution result of ${input.source.run}`);
    }
    parseWorkPath(receipt.path, 'work-output', 'task-result');
    task = Number(receipt.task);
  }
  if (!equal(input.reuse, input.source.receipts.map((receipt) => receipt.task))) {
    fail('recovery input reuse must list the receipt tasks in order');
  }
  exact(input.current, ['branch', 'head', 'observation', 'delta'], 'recovery input current');
  if (typeof input.current.branch !== 'string' || !/^[^\s\u0000-\u001f]+$/.test(input.current.branch)
    || !GIT_ID.test(input.current.head) || !SHA256.test(input.current.observation)) {
    fail('recovery input current must name the accepted branch, HEAD, and observation digest');
  }
  try {
    if (!Array.isArray(input.current.delta)) throw new Error('not a list');
    input.current.delta.forEach(assertSourcePath);
    if (!equal([...new Set(input.current.delta)].sort(), input.current.delta)) throw new Error('not sorted');
  } catch { fail('recovery input current delta must be sorted unique source paths'); }
  return Object.freeze({ path, digest: sha(bytes), dir, destName, sourceName, input });
}

function lifecycle(text, label) {
  const match = LIFECYCLE.exec(text);
  if (!match) {
    if (/<!--\s*steepy-workflow:/.test(text)) fail(`${label} lifecycle header is invalid`);
    return null;
  }
  const entries = match[2].split(/\r?\n/).map((line) => /^([a-z-]+): (.+)$/.exec(line));
  if (entries.some((entry) => !entry) || !equal(entries.map((entry) => entry[1]), LIFECYCLE_FIELDS)) fail(`${label} lifecycle header is invalid`);
  return { match, fields: Object.fromEntries(entries.map((entry) => [entry[1], entry[2]])) };
}

const headerText = (fields) => LIFECYCLE_FIELDS.map((field) => `${field}: ${fields[field]}`).join('\n');
const lifecycleSummary = (header) => (header === null ? 'none'
  : `phase=${header.fields.phase} status=${header.fields.status} consumed-by=${header.fields['consumed-by']}`);

function provenance(kind, loaded, reference, header, transformation) {
  return ['<!-- steepy-recovery: v1', `kind: ${kind}`, `source: ${reference.path}`, `source-sha256: ${reference.sha256}`,
    `source-lifecycle: ${lifecycleSummary(header)}`, `recovery-input: ${loaded.path}`, `recovery-input-sha256: ${loaded.digest}`,
    `transformation: ${transformation}`, '-->'].join('\n');
}

function changes(before, after, describe) {
  return Object.entries(describe).filter(([field]) => before?.[field] !== after[field]).map(([, text]) => text);
}

// The approved spec, verbatim but for its lifecycle header: a brainstorm
// header is consumed by the prepared plan. Provenance follows the leading
// contract/lifecycle comments, so the verdict contract stays at the head.
function prepareSpec(text, loaded) {
  const { destination } = loaded.input;
  const header = lifecycle(text, 'source spec');
  if (header === null) {
    const end = text.indexOf('-->');
    if (!/^\s*<!--/.test(text) || end < 0) fail('source spec has no leading verdict contract');
    return `${text.slice(0, end + 3)}\n${provenance('spec', loaded, loaded.input.source.spec, null, 'none')}${text.slice(end + 3)}`;
  }
  if (header.fields.phase !== 'brainstorm' || header.fields.next !== 'plan') fail('source spec lifecycle is not a brainstorm output');
  const fields = { ...header.fields, status: 'CONSUMED', 'consumed-by': destination.plan };
  const transformation = changes(header.fields, fields, {
    status: 'lifecycle status set to CONSUMED', 'consumed-by': `lifecycle consumed-by rebound to ${destination.plan}`,
  }).join('; ') || 'none';
  const { match } = header;
  return `${match[1]}${headerText(fields)}${match[3]}\n${provenance('spec', loaded, loaded.input.source.spec, header, transformation)}`
    + text.slice(match[0].length);
}

// The approved plan, verbatim but for a READY lifecycle sourced from the new
// spec. Provenance precedes the first task, so no task text or brief changes.
function preparePlan(text, loaded) {
  const { destination } = loaded.input;
  const header = lifecycle(text, 'source plan');
  if (header !== null && (header.fields.phase !== 'plan' || header.fields.next !== 'implement')) fail('source plan lifecycle is not a plan output');
  const fields = { phase: 'plan', status: 'READY', next: 'implement', source: destination.spec, 'consumed-by': 'none' };
  const transformation = header === null ? `lifecycle header added with source ${destination.spec}`
    : changes(header.fields, fields, {
      source: `lifecycle source rebound to ${destination.spec}`, status: 'lifecycle status reset to READY',
      'consumed-by': 'lifecycle consumed-by reset to none',
    }).join('; ') || 'none';
  const note = provenance('plan', loaded, loaded.input.source.plan, header, transformation);
  if (header === null) return `<!-- steepy-workflow: v1\n${headerText(fields)}\n-->\n${note}\n${text}`;
  const { match } = header;
  return `${match[1]}${headerText(fields)}${match[3]}\n${note}${text.slice(match[0].length)}`;
}

function declaredText(root, reference, family, label) {
  const bytes = readWorkPath(root, reference.path, { family });
  if (sha(bytes) !== reference.sha256) fail(`${label} digest drift`);
  return bytes.toString('utf8');
}

function copiesOf(root, loaded, specText, planText) {
  const spec = prepareSpec(specText, loaded);
  try { specPhaseContext(spec); } catch (error) { fail(`spec rejected: ${error.message}`); }
  const plan = preparePlan(planText, loaded);
  let tasks;
  try { ({ tasks } = controllerPlanContext({ repoRoot: root, planText: plan })); } catch (error) { fail(`plan rejected: ${error.message}`); }
  return Object.freeze({ spec, plan, tasks: tasks.map((task) => task.task) });
}

// The deterministic prepared copies, re-derived from the digest-bound source
// documents. The controller uses this to bind the prepared plan on resume.
export function recoveryCopies(root, inputPath) {
  const loaded = loadRecoveryInput(root, inputPath);
  return copiesOf(root, loaded, declaredText(root, loaded.input.source.spec, 'spec', 'source spec'),
    declaredText(root, loaded.input.source.plan, 'plan', 'source plan'));
}

export function inspectRecovery(root, inputPath) {
  const loaded = loadRecoveryInput(root, inputPath);
  const { input } = loaded;
  const reconciliation = [];
  const note = (message) => reconciliation.push(lineOf(message));
  const attempt = (action) => { try { return action(); } catch (error) { note(error.message); return null; } };
  const specText = attempt(() => declaredText(root, input.source.spec, 'spec', 'source spec'));
  const planText = attempt(() => declaredText(root, input.source.plan, 'plan', 'source plan'));
  const copies = specText === null || planText === null ? null : attempt(() => copiesOf(root, loaded, specText, planText));

  const observation = observeSource(root);
  const observed = { branch: observation.branch.replace(/^refs\/heads\//, ''), head: observation.head,
    observation: observation.digest, delta: null };
  if (observed.branch !== input.current.branch || observed.head !== input.current.head || observed.observation !== input.current.observation) {
    note('current snapshot differs from the accepted recovery snapshot');
  }

  const receipts = [];
  for (const receipt of input.source.receipts) {
    const state = receipt.path.slice(0, -'-result.json'.length);
    const bytes = attempt(() => readWorkPath(root, receipt.path, { family: 'task-result' }));
    if (bytes === null) continue;
    if (sha(bytes) !== receipt.sha256) note(`Task ${receipt.task}: source receipt digest drift`);
    const facts = attempt(() => inspectTaskResult(root, state, { checkCurrent: false }));
    if (facts !== null) receipts.push({ task: receipt.task, state, sequence: facts.sequence ?? 0 });
  }
  // The lineage head is the latest declared execution; the delta runs from its
  // recorded observation to the present one.
  const head = receipts.reduce((latest, item) => (latest === null || item.sequence > latest.sequence ? item : latest), null);
  if (head !== null) {
    for (const receipt of receipts) {
      const source = attempt(() => inspectImportSource(root, loaded.dir, { task: receipt.task, sourceState: receipt.state,
        sourceHead: head.state, manifests: input.source.manifests, observation }));
      if (source !== null) observed.delta ??= source.delta;
    }
  }
  if (observed.delta !== null && !equal(observed.delta, input.current.delta)) {
    const unexplained = [...observed.delta.filter((path) => !input.current.delta.includes(path)),
      ...input.current.delta.filter((path) => !observed.delta.includes(path)).map((path) => `${path} (declared but unchanged)`)];
    note(`unexplained source delta requires reconciliation: ${unexplained.join(', ')}`);
  }
  if (copies !== null) {
    for (const task of input.reuse) if (!copies.tasks.includes(task)) note(`Task ${task} is not a task of the approved plan`);
    for (const [path, text, family] of [[input.destination.spec, copies.spec, 'spec'], [input.destination.plan, copies.plan, 'plan']]) {
      const existing = attempt(() => optionalWork(root, path, family));
      if (existing !== null && !existing.equals(Buffer.from(text))) note(`destination ${path} exists with different bytes`);
    }
  }
  const taskIds = copies?.tasks ?? input.reuse;
  const tasks = taskIds.map((task) => {
    const reused = input.source.receipts.find((receipt) => receipt.task === task);
    return reused === undefined ? { task, class: 'residual', review: null, receipt: null }
      : { task, class: 'import', review: 'pending', receipt: reused.path.slice(0, -'-result.json'.length) };
  });
  return Object.freeze({
    status: reconciliation.length === 0 ? 'READY' : 'RECONCILIATION_REQUIRED',
    recoveryInput: { path: loaded.path, sha256: loaded.digest },
    source: { run: input.source.run, head: head?.state ?? null },
    observed, tasks, reconciliation, destination: input.destination,
    input, copies,
  });
}

// Writes the prepared copies only after a READY inspection whose prepared plan
// passed the v2 gate. An identical existing copy is an exact no-op.
export async function prepareRecovery(root, inputPath) {
  const inspection = inspectRecovery(root, inputPath);
  if (inspection.status !== 'READY') fail(`recovery requires reconciliation: ${inspection.reconciliation.join('; ')}`);
  if (optionalWork(root, `${inspection.destination.run}/autopilot-run.json`, 'autopilot-run') !== null) {
    fail('the recovery run has already started; resume it from its journal');
  }
  // The conductor parses the same contract; a branch change needs a new spec.
  const { parseContract } = await import('./autopilot.mjs');
  const contract = parseContract(inspection.copies.spec);
  if (contract.branch !== inspection.input.current.branch) {
    fail(`the approved spec contract branch "${contract.branch}" differs from the accepted recovery branch "${inspection.input.current.branch}"; refusing to rewrite the contract`);
  }
  for (const [path, text, family] of [[inspection.destination.spec, inspection.copies.spec, 'spec'],
    [inspection.destination.plan, inspection.copies.plan, 'plan']]) {
    const existing = optionalWork(root, path, family);
    if (existing === null) writeWorkPath(root, path, text, { family, createOnly: true });
    else if (!existing.equals(Buffer.from(text))) fail(`destination ${path} exists with different bytes`);
  }
  return Object.freeze({ ...inspection, prepared: [inspection.destination.spec, inspection.destination.plan] });
}

function publicView(result) {
  const { input: ignoredInput, copies: ignoredCopies, ...view } = result;
  return view;
}

const USAGE = 'usage: node scripts/autopilot-recovery.mjs <inspect|prepare> --repo-root <root> --recovery-input <exact recovery-input.json path>';

export async function main(argv = process.argv.slice(2)) {
  let action;
  let values;
  try {
    const parsed = parseArgs({ args: argv, allowPositionals: true, strict: true,
      options: { 'repo-root': { type: 'string' }, 'recovery-input': { type: 'string' } } });
    [action] = parsed.positionals;
    values = parsed.values;
    if (parsed.positionals.length !== 1 || !['inspect', 'prepare'].includes(action) || !values['recovery-input']) throw new Error('usage');
  } catch {
    console.error(USAGE);
    return 2;
  }
  const root = resolve(values['repo-root'] ?? '.');
  try {
    const result = action === 'inspect' ? inspectRecovery(root, values['recovery-input']) : await prepareRecovery(root, values['recovery-input']);
    console.log(JSON.stringify(publicView(result)));
    return result.status === 'READY' ? 0 : 1;
  } catch (error) {
    console.error(`autopilot-recovery: ${lineOf(error.message)}`);
    return 1;
  }
}

// No top-level await: preparation imports the conductor's contract parser,
// whose module graph imports this one back, so evaluation must finish first.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; });
}

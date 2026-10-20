// Closed v2 wire contracts and immutable publication primitives. The state helper
// alone mutates descriptors and decides admissible registrations; no commands run here.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { writeAllSync } from './write-all.mjs';
import { assertSafeLine } from './sanitize.mjs';

export const RUN_SCHEMA_V2 = 'steepy-inception-run/v2';
export const RECORD_SCHEMA_V2 = 'steepy-inception-record/v2';
export const CHECKS_SCHEMA_V2 = 'steepy-inception-checks/v2';
export const CAPTURE_SCHEMA_V2 = 'steepy-inception-capture/v2';
export const ABANDON_INTENT_SCHEMA_V2 = 'steepy-inception-abandon-intent/v2';
export const ABANDON_SCHEMA_V2 = 'steepy-inception-abandon/v2';
export const ABANDON_RECEIPT_SCHEMA_V2 = 'steepy-inception-abandon-receipt/v2';
const AREA = '.apex/inception/';
const PHASES = ['reconnaissance', 'architecture', 'research', 'approval', 'bootstrap', 'verification', 'complete'];
const CAPABILITIES = ['shell', 'network', 'browser', 'subagents', 'question-tool', 'headless'];
const EFFECT_KINDS = ['install', 'generator', 'migration', 'external-resource', 'deploy', 'commit', 'remote'];
export const RUN_CHILDREN_V2 = Object.freeze([
  'approvals', 'checkpoints', 'resume-notes', 'project', 'research', 'bootstrap', 'verification',
  'snapshots', 'effects', 'reconciliations', 'units', 'run.json',
]);

const fail = (where, reason) => { throw new Error(`${where}: ${reason}`); };
const assert = (condition, where, reason) => { if (!condition) fail(where, reason); };
const string = (v, w = 'value') => {
  assert(typeof v === 'string' && v.isWellFormed(), w, 'must be a well-formed string');
  return v;
};
export function validateText(v, w = 'text', { empty = false } = {}) {
  string(v, w);
  assert((empty || v.trim().length > 0) && [...v].length <= 8000
    && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(v), w, 'must be text of at most 8000 characters without controls except tab/newline');
  return v;
}
const text = (v, w) => validateText(v, w);
const optionalText = (v, w) => validateText(v, w, { empty: true });
const bool = (v, w) => { assert(typeof v === 'boolean', w, 'must be boolean'); return v; };
const integer = (min, max = Number.MAX_SAFE_INTEGER) => (v, w) => {
  assert(Number.isSafeInteger(v) && v >= min && v <= max, w, `must be a safe integer in ${min}..${max}`); return v;
};
const positive = integer(1);
const nonnegative = integer(0);
const enumeration = (...choices) => (v, w) => { assert(choices.includes(v), w, `must be one of ${choices.join(' | ')}`); return v; };
const nullable = validator => (v, w) => v === null ? null : validator(v, w);
const shape = (v, fields, w) => {
  assert(v !== null && typeof v === 'object' && !Array.isArray(v), w, 'must be an object');
  const keys = Object.keys(fields);
  assert(Object.keys(v).length === keys.length && Object.keys(v).every((key, i) => key === keys[i]), w, `must have exactly the keys ${keys.join(', ')} in that order`);
  for (const [key, validate] of Object.entries(fields)) validate(v[key], `${w}.${key}`);
  return v;
};
const list = (validate, { min = 0, key = null, sorted = false } = {}) => (v, w) => {
  assert(Array.isArray(v) && v.length >= min, w, `must be an array of at least ${min} entries`);
  const seen = new Set();
  v.forEach((item, index) => {
    validate(item, `${w}[${index}]`);
    if (key) {
      const id = key(item); assert(!seen.has(id), w, 'duplicate entry'); seen.add(id);
      if (sorted && index > 0) assert(key(v[index - 1]) < id, w, 'must be strictly sorted');
    }
  });
  return v;
};
const pattern = (regex, description) => (v, w) => { string(v, w); assert(regex.test(v), w, description); return v; };
export const validateId = (v, w = 'id') => pattern(/^[a-z0-9][a-z0-9-]{0,63}$/u, 'must be a lowercase ID of 1..64 characters')(v, w);
const runId = pattern(/^inc-\d{8}T\d{6}Z-[0-9a-f]{8}$/u, 'malformed runId');
const digest = pattern(/^[0-9a-f]{64}$/u, 'must be lowercase SHA-256');
const timestamp = (v, w) => {
  string(v, w);
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v)
    && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v, w, 'must be an ISO UTC timestamp with milliseconds');
  return v;
};
// Names are literal: `app/[id]/page.tsx` is an ordinary application path. No reader
// expands patterns, and Git receives exclusions only through literal pathspec magic.
export function validatePath(v, w = 'path') {
  string(v, w); assertSafeLine(v, w);
  assert(v.length > 0 && Buffer.byteLength(v, 'utf8') <= 4096 && !/[\\\x7f-\x9f]/u.test(v)
    && v.split('/').every(part => part !== '' && part !== '.' && part !== '..'), w, 'must be an exact relative path of at most 4096 UTF-8 bytes without aliases');
  return v;
}
const rootPath = (v, w) => v === '.' ? v : validatePath(v, w);
const paths = list(validatePath, { key: v => v });
const ids = list(validateId, { key: v => v });
const roots = list(rootPath, { min: 1, key: v => v });
const phase = enumeration(...PHASES);
const result = enumeration('configured', 'executed', 'succeeded', 'not-executed', 'failed');
const checkType = enumeration('automatic', 'manual', 'both');
const purpose = enumeration('check', 'revalidate');
const state = (v, w) => {
  shape(v, { phase, status: enumeration('active', 'blocked', 'complete') }, w);
  assert((v.phase === 'complete') === (v.status === 'complete'), w, 'complete phase/status must go together');
};

export function validateRef(v, { runId: expectedRun, where = 'ref' } = {}) {
  shape(v, { path: validatePath, bytes: nonnegative, sha256: digest }, where);
  if (v.path.startsWith(`${AREA}abandoned/`)) {
    const archivedRun = v.path.slice(`${AREA}abandoned/`.length).split('/')[0];
    runId(archivedRun, `${where}.path`);
    if (expectedRun !== undefined) assert(archivedRun === expectedRun, where, 'cross-run reference');
  }
  return v;
}
const ref = (v, w) => validateRef(v, { where: w });
const refs = list(ref, { key: v => v.path });
const areaRef = (v, w) => { ref(v, w); assert(v.path.startsWith(AREA) && !v.path.startsWith(`${AREA}abandoned/`), w, 'must reference the active inception area'); };
const numberedPath = (path, family, extension = 'json') => {
  const prefix = `${AREA}${family}/`;
  if (typeof path !== 'string' || !path.startsWith(prefix) || !path.endsWith(`.${extension}`)) return null;
  const digits = path.slice(prefix.length, -extension.length - 1);
  const n = /^\d+$/u.test(digits) ? Number(digits) : NaN;
  return Number.isSafeInteger(n) && n >= 1 && String(n).padStart(4, '0') === digits ? n : null;
};
export function inceptionRecordPath(kind, number) {
  positive(number, 'record');
  const family = RECORD_FAMILIES[kind];
  assert(family !== undefined, 'kind', 'unknown record kind');
  return `${AREA}${family}/${String(number).padStart(4, '0')}.json`;
}
const familyRef = (family, extension = 'json') => (v, w) => {
  areaRef(v, w); assert(numberedPath(v.path, family, extension) !== null, w, `must name a canonical ${family} record`);
};
const contractRef = (v, w) => { areaRef(v, w); assert(v.path === `${AREA}project/verification-contract.json`, w, 'must reference verification-contract.json'); };
const cycleRef = familyRef('verification/cycles');
const sessionRef = familyRef('verification/sessions');
const snapshotRef = familyRef('snapshots');

export function validateAppEntry(v, w = 'application entry') {
  return shape(v, { path: validatePath, mode: integer(0, 0o7777), bytes: nonnegative, sha256: digest }, w);
}
export function validateGit(v, w = 'git') {
  shape(v, { present: bool, branch: nullable(text), head: nullable(pattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u, 'must be a commit ID')), status: list(text) }, w);
  assert(v.present || (v.branch === null && v.head === null && v.status.length === 0), w, 'absent Git has null branch/head and empty status');
  assert(v.status.every((entry, i) => i === 0 || v.status[i - 1] <= entry), w, 'status must be sorted');
  return v;
}
export function validateCommand(v, w = 'command') {
  return shape(v, {
    executable: (s, p) => { string(s, p); assert(s.length > 0 && !s.includes('\0'), p, 'must be a nonempty executable without NUL'); },
    args: list((s, p) => { string(s, p); assert(!s.includes('\0'), p, 'must not contain NUL'); }),
    cwd: rootPath, successExitCodes: list(integer(0, 255), { min: 1, key: n => n }),
  }, w);
}
export function validateEnvironment(v, w = 'environment') {
  return shape(v, {
    tools: list((t, p) => shape(t, { name: text, version: text }, p), { key: t => t.name }),
    resources: list((r, p) => shape(r, { id: validateId, identity: text }, p), { key: r => r.id }),
  }, w);
}
const exclusions = list((v, w) => shape(v, { path: validatePath, kind: enumeration('dependencies', 'cache', 'generated'), reason: text }, w), { key: v => v.path });
export function validateSnapshotScope(v) { return shape(v, { roots, exclusions }, 'snapshot scope'); }
const manualProcedure = (v, w) => shape(v, { procedure: text, acceptance: text }, w);
const reuse = (v, w) => {
  shape(v, { policy: enumeration('snapshot', 'reobserve'), automatic: nullable(validateCommand), manual: nullable(manualProcedure) }, w);
  assert(v.policy === 'snapshot' ? v.automatic === null && v.manual === null : v.automatic !== null || v.manual !== null, w, 'procedures must match reuse policy');
};
const check = (v, w) => {
  shape(v, { id: validateId, required: bool, type: checkType, subject: text, procedure: text, expected: text, evidenceRequired: text, automatic: nullable(validateCommand), manual: nullable(manualProcedure), reuse }, w);
  assert((v.automatic !== null) === (v.type !== 'manual') && (v.manual !== null) === (v.type !== 'automatic'), w, 'automatic/manual must exactly match type');
};
export function validateVerificationContract(v) {
  shape(v, {
    schema: enumeration(CHECKS_SCHEMA_V2), roots, exclusions,
    environment: (e, w) => shape(e, { tools: list(text, { key: s => s }), resources: list((r, p) => shape(r, { id: validateId, description: text }, p), { key: r => r.id }) }, w),
    checks: list(check, { min: 1, key: c => c.id }),
    coverage: list((c, w) => shape(c, { id: validateId, component: text, checks: ids, status: enumeration('current', 'future') }, w), { key: c => c.id }),
  }, 'verification contract');
  assert(v.checks.some(c => c.required), 'checks', 'at least one required check is necessary');
  const checks = new Set(v.checks.map(c => c.id));
  for (const c of v.coverage) assert(c.checks.every(id => checks.has(id)), 'coverage', 'unknown check reference');
  return v;
}

// CLI and exported API attestations share this closed input contract.
export function validateManualInput(v) {
  return shape(v, { checks: list((c, w) => shape(c, { id: validateId, procedure: text, result: enumeration('succeeded', 'failed'), observed: text }, w), { min: 1, key: c => c.id }), statement: text, environment: validateEnvironment, purpose }, 'manual input');
}

const correlation = list((v, w) => shape(v, { name: text, value: text }, w), { key: v => v.name });
const RECORD_FAMILIES = Object.freeze({ approval: 'approvals', snapshot: 'snapshots', checkpoint: 'checkpoints', cycle: 'verification/cycles', 'verification-session': 'verification/sessions', 'effect-intent': 'effects', 'effect-outcome': 'effects', manual: 'verification/manual', result: 'verification/results', reconciliation: 'reconciliations', summary: 'verification/summaries', completion: 'verification/completions' });
const BODY_SHAPES = {
  approval: { statement: text, documents: list(ref, { min: 1, key: v => v.path }), contract: contractRef, frozenDocuments: list((v, w) => shape(v, { sourcePath: validatePath, artifact: areaRef }, w), { min: 1, key: v => v.sourcePath }) },
  snapshot: { contract: nullable(contractRef), roots, exclusions, files: list(validateAppEntry, { key: v => v.path, sorted: true }), git: validateGit },
  checkpoint: { label: text, phase, snapshot: snapshotRef, previous: nullable(familyRef('checkpoints')), unitIds: ids, effectIds: ids },
  cycle: { approval: familyRef('approvals'), contract: contractRef, snapshot: snapshotRef, environment: validateEnvironment, previous: nullable(cycleRef), reason: text },
  'verification-session': { cycle: cycleRef, previous: nullable(sessionRef) },
  'effect-intent': { id: validateId, kind: enumeration(...EFFECT_KINDS), unitId: validateId, summary: text, command: nullable(validateCommand), procedure: nullable(text), scope: paths, authorization: nullable(text), correlation, observation: (v, w) => shape(v, { procedure: text, expected: text, evidencePaths: paths }, w), before: snapshotRef },
  'effect-outcome': { id: validateId, intent: familyRef('effects'), result: enumeration('succeeded', 'failed', 'not-started', 'partial'), observed: text, correlation, evidence: refs, after: snapshotRef, method: enumeration('observed', 'reconciled') },
  manual: { cycle: cycleRef, session: sessionRef, purpose, checks: list((v, w) => shape(v, { id: validateId, procedure: text, result: enumeration('succeeded', 'failed'), observed: text }, w), { min: 1, key: v => v.id }), statement: text, environment: validateEnvironment, before: snapshotRef, after: snapshotRef },
  result: { cycle: cycleRef, checkId: validateId, result, automatic: nullable(areaRef), manual: nullable(familyRef('verification/manual')), revalidation: refs, observed: text, limits: optionalText },
  reconciliation: { unitId: validateId, before: snapshotRef, after: snapshotRef, changes: list((v, w) => {
    shape(v, { path: validatePath, before: nullable(validateAppEntry), after: nullable(validateAppEntry) }, w);
    assert((v.before !== null || v.after !== null) && [v.before, v.after].every(e => e === null || e.path === v.path), w, 'change must bind its path and an entry');
  }, { key: v => v.path, sorted: true }), effects: refs, evidence: refs, reason: text, statement: nullable(text) },
  summary: { cycle: cycleRef, checks: list((v, w) => shape(v, { id: validateId, required: bool, type: checkType, result, evidence: refs, observed: text, limits: optionalText }, w), { key: v => v.id }), coverage: list((v, w) => shape(v, { id: validateId, component: text, status: enumeration('verified', 'unverified', 'future'), checks: ids }, w), { key: v => v.id }), limits: list(text) },
  completion: { approval: familyRef('approvals'), contract: contractRef, cycle: cycleRef, snapshot: snapshotRef, checkpoint: familyRef('checkpoints'), summary: familyRef('verification/summaries'), report: familyRef('verification/reports', 'md'), evidence: refs },
};

// References carry no runId themselves. In-memory cross-run checks reject archive
// aliases; resolving an immutable record additionally requires its expected runId.
function validateReferenceRuns(value, expectedRun) {
  if (value === null || typeof value !== 'object') return;
  if (Object.hasOwn(value, 'path') && Object.hasOwn(value, 'bytes') && Object.hasOwn(value, 'sha256')) {
    if (value.path.startsWith(`${AREA}abandoned/`)) validateRef({ path: value.path, bytes: value.bytes, sha256: value.sha256 }, { runId: expectedRun });
  }
  for (const child of Object.values(value)) validateReferenceRuns(child, expectedRun);
}
function expectedIdentity(v, { runId: expectedRun, number } = {}) {
  if (expectedRun !== undefined) assert(v.runId === expectedRun, 'runId', 'does not match expected runId');
  if (number !== undefined) assert(v.record === number, 'record', 'does not match expected record');
  validateReferenceRuns(v, v.runId);
}
export function validateInceptionRecord(v, options = {}) {
  shape(v, { schema: enumeration(RECORD_SCHEMA_V2), runId, record: positive, kind: enumeration(...Object.keys(BODY_SHAPES)), at: timestamp, unitId: nullable(validateId), body: (b, w) => {
    assert(Object.hasOwn(BODY_SHAPES, v.kind), w, 'unknown record kind'); shape(b, BODY_SHAPES[v.kind], w);
  } }, 'record');
  expectedIdentity(v, options);
  const b = v.body;
  if (v.kind === 'approval') {
    assert(b.documents.length === b.frozenDocuments.length && b.frozenDocuments.every(f => b.documents.some(d => d.path === f.sourcePath)), 'frozenDocuments', 'must bind every document exactly once');
    assert(new Set(b.frozenDocuments.map(f => f.artifact.path)).size === b.frozenDocuments.length, 'frozenDocuments', 'artifacts must be unique');
    for (const [index, frozen] of b.frozenDocuments.entries()) {
      // Copies follow the source document order, with 1-based minimum-four-digit
      // indices. Their allocation belongs to this approval, never a live source.
      const source = b.documents[index];
      const copyPath = `${AREA}approvals/${String(v.record).padStart(4, '0')}-documents/${String(index + 1).padStart(4, '0')}.bin`;
      assert(frozen.sourcePath === source.path && frozen.artifact.path === copyPath, 'frozenDocuments', 'copy must use its owning approval and ordered canonical index');
      assert(source.bytes === frozen.artifact.bytes && source.sha256 === frozen.artifact.sha256, 'frozenDocuments', 'frozen copy must bind the source bytes');
    }
  }
  if (v.kind === 'effect-intent') {
    assert(b.command !== null || b.procedure !== null, 'effect-intent', 'requires command or procedure');
    assert(v.unitId === b.unitId, 'effect-intent', 'causal unitId must match body');
  }
  if (v.kind === 'effect-outcome' && b.method === 'reconciled') assert(b.correlation.length > 0, 'correlation', 'reconciliation requires correlation');
  if (v.kind === 'summary') {
    const checks = new Map(b.checks.map(c => [c.id, c]));
    for (const c of b.coverage) {
      assert(c.checks.every(id => checks.has(id)), 'coverage', 'unknown check reference');
      if (c.status === 'verified') assert(c.checks.length > 0 && c.checks.every(id => checks.get(id).result === 'succeeded'), 'coverage', 'verified coverage requires successful assigned checks');
    }
  }
  return v;
}

// Markdown is a deterministic projection of the validated summary record.
export function renderVerificationReport(summary) {
  validateInceptionRecord(summary);
  assert(summary.kind === 'summary', 'report', 'requires a summary record');
  const { body } = summary;
  const literal = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\\', '&#92;').replaceAll('`', '&#96;').replaceAll('*', '&#42;').replaceAll('_', '&#95;').replaceAll('[', '&#91;').replaceAll(']', '&#93;').replaceAll('#', '&#35;');
  const lines = ['# Inception verification', '', `Run: ${summary.runId}`, `Cycle: ${body.cycle.path}`, '', '## Checks', ''];
  for (const check of body.checks) lines.push(`### ${check.id}`, '', `Requirement: ${check.required ? 'required' : 'optional'}`, `Type: ${check.type}`, `Result: ${check.result}`, '', literal(check.observed), '', `Limits: ${literal(check.limits || 'None recorded')}`, '', ...check.evidence.map(ref => `Evidence: ${ref.path} (${ref.sha256}, ${ref.bytes} bytes)`), '');
  lines.push('## Coverage', '');
  for (const entry of body.coverage) lines.push(`- ${entry.id}: ${literal(entry.component)} — ${entry.status}; checks: ${entry.checks.join(', ') || 'none'}`);
  lines.push('', '## Limits', '', ...(body.limits.length ? body.limits.map(limit => `- ${literal(limit)}`) : ['None recorded']), '');
  return lines.join('\n');
}

function capturePaths(stdout, stderr, receipt, w) {
  const prefix = `${AREA}verification/captures/`;
  assert(stdout.startsWith(prefix) && stdout.endsWith('/stdout.bin'), w, 'invalid stdout capture path');
  const digits = stdout.slice(prefix.length, -'/stdout.bin'.length);
  const n = Number(digits);
  assert(Number.isSafeInteger(n) && n >= 1 && String(n).padStart(4, '0') === digits, w, 'invalid capture number');
  const base = `${prefix}${digits}/`;
  assert(stderr === `${base}stderr.bin` && (receipt === null || receipt === `${base}receipt.json`), w, 'capture paths must share one capture identity');
}
export function validateCaptureAttempt(v, w = 'capture') {
  shape(v, { token: digest, pid: positive, cycle: cycleRef, session: sessionRef, checkId: validateId, purpose, command: validateCommand, stdoutPath: validatePath, stderrPath: validatePath, receiptPath: validatePath, state: enumeration('reserved', 'running', 'captured', 'incomplete'), receipt: nullable(areaRef) }, w);
  capturePaths(v.stdoutPath, v.stderrPath, v.receiptPath, w);
  assert((v.state === 'captured') === (v.receipt !== null), w, 'only captured requires a receipt');
  if (v.receipt !== null) assert(v.receipt.path === v.receiptPath, w, 'receipt path must match');
  return v;
}
export function validateCaptureReceipt(v, options = {}) {
  shape(v, { schema: enumeration(CAPTURE_SCHEMA_V2), runId, cycle: cycleRef, session: sessionRef, checkId: validateId, unitId: validateId, purpose, token: digest, command: validateCommand, startedAt: timestamp, endedAt: timestamp, exitCode: nullable(integer(0, 255)), signal: nullable(text), stdout: areaRef, stderr: areaRef, before: snapshotRef, after: snapshotRef, environment: validateEnvironment }, 'capture receipt');
  expectedIdentity(v, options);
  assert(v.exitCode !== null || v.signal !== null, 'capture receipt', 'requires exitCode or signal');
  assert(v.endedAt >= v.startedAt, 'capture receipt', 'endedAt precedes startedAt');
  capturePaths(v.stdout.path, v.stderr.path, null, 'capture receipt');
  return v;
}

const unit = (v, w) => shape(v, {
  id: validateId, previousUnit: nullable(validateId), kind: enumeration('decision', 'research', 'bootstrap', 'check', 'publication', 'transition'), phase,
  inputs: refs, outputs: list((o, p) => shape(o, { path: validatePath, role: enumeration('decision', 'report', 'evidence') }, p), { key: o => o.path }),
  allowedPaths: paths, before: nullable(snapshotRef), state: enumeration('started', 'completed', 'blocked', 'closed-incomplete'), evidence: refs, after: nullable(snapshotRef), capture: nullable(validateCaptureAttempt),
}, w);
const harness = (v, w) => shape(v, {
  name: pattern(/^[a-z0-9][a-z0-9-]{0,39}$/u, 'must be a safe harness slug'), capabilities: (c, p) => shape(c, Object.fromEntries(CAPABILITIES.map(n => [n, bool])), p),
}, w);
const runGit = (v, w) => {
  shape(v, { present: bool, branch: nullable(string), commits: enumeration('allowed', 'forbidden', 'none') }, w);
  assert((v.commits === 'none') !== v.present, w, 'commits must be none exactly when Git is absent');
};
const history = list((v, w) => shape(v, { at: timestamp, from: state, to: state, reason: (r, p) => {
  assertSafeLine(r, p); assert([...r].length >= 1 && [...r].length <= 1000, p, 'must be v1 single-line history text');
} }, w));
const publication = (v, w) => shape(v, { id: validateId, revision: positive, targets: refs }, w);
const target = (v, w) => {
  shape(v, { path: validatePath, bytes: nonnegative, sha256: digest, contentBase64: string }, w);
  const bytes = Buffer.from(v.contentBase64, 'base64');
  assert(bytes.toString('base64') === v.contentBase64 && bytes.length === v.bytes && createHash('sha256').update(bytes).digest('hex') === v.sha256, w, 'target bytes/digest/base64 mismatch');
};

const RECORD_PATH_FORMATS = [
  ...new Set(Object.values(RECORD_FAMILIES)),
].map(family => [family, 'json']).concat([
  ['resume-notes', 'md'], ['verification/reports', 'md'],
]);

function canonicalAllocationNumber(digits, where) {
  const n = Number(digits);
  assert(Number.isSafeInteger(n) && n >= 1 && String(n).padStart(4, '0') === digits,
    where, 'allocation number must be canonical and safe');
  return n;
}

// Match only reserved record families, not arbitrary filenames containing digits.
// Capture streams share their receipt's allocation, and frozen document copies
// share their owning approval's allocation. Their individual file digests differ.
function allocationForPath(path) {
  for (const [family, extension] of RECORD_PATH_FORMATS) {
    const prefix = `${AREA}${family}/`;
    const suffix = `.${extension}`;
    if (!path.startsWith(prefix) || !path.endsWith(suffix)) continue;
    const digits = path.slice(prefix.length, -suffix.length);
    if (/^\d+$/u.test(digits)) {
      return { number: canonicalAllocationNumber(digits, path), identity: path };
    }
  }
  const capture = /^\.apex\/inception\/verification\/captures\/(\d+)\/(?:stdout\.bin|stderr\.bin|receipt\.json)$/u.exec(path);
  if (capture) {
    return { number: canonicalAllocationNumber(capture[1], path), identity: `${AREA}verification/captures/${capture[1]}/receipt.json` };
  }
  const copy = /^\.apex\/inception\/approvals\/(\d+)-documents\/(\d+)\.bin$/u.exec(path);
  if (copy) {
    canonicalAllocationNumber(copy[2], path);
    return { number: canonicalAllocationNumber(copy[1], path), identity: `${AREA}approvals/${copy[1]}.json` };
  }
  return null;
}

function validateDescriptorAllocations(descriptor) {
  const allocations = new Map();
  const files = new Map();
  const observe = (path, reference = null) => {
    const allocation = allocationForPath(path);
    if (allocation === null) return;
    const { number, identity } = allocation;
    assert(number < descriptor.nextRecord, path, 'allocation must be below nextRecord');
    assert(!allocations.has(number) || allocations.get(number) === identity,
      path, 'allocation number is reused by a different record identity');
    allocations.set(number, identity);
    if (reference !== null) {
      const previous = files.get(path);
      assert(previous === undefined || (previous.bytes === reference.bytes && previous.sha256 === reference.sha256),
        path, 'record identity has inconsistent bytes or digest');
      files.set(path, reference);
    }
  };
  const visit = value => {
    if (value === null || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'path') && Object.hasOwn(value, 'bytes') && Object.hasOwn(value, 'sha256')) {
      observe(value.path, value);
      return;
    }
    // A running attempt already reserves an allocation before it has a receipt Ref.
    if (Object.hasOwn(value, 'stdoutPath')) {
      for (const key of ['stdoutPath', 'stderrPath', 'receiptPath']) observe(value[key]);
    }
    for (const child of Object.values(value)) visit(child);
  };
  // nextDescriptor was validated recursively with its own nextRecord. Its pending
  // targets are future publications, not already allocated references in this state.
  for (const [key, value] of Object.entries(descriptor)) if (key !== 'pending') visit(value);
}

export function validateRunDescriptorV2(v, options = {}) {
  shape(v, {
    schema: enumeration(RUN_SCHEMA_V2), runId, revision: positive, phase, status: enumeration('active', 'blocked', 'complete'), harness, git: runGit, preapprovalExclusions: exclusions, nextRecord: positive,
    approvalEntry: nullable(nonnegative), approvals: list(familyRef('approvals'), { key: r => r.path }), checkpoints: list(familyRef('checkpoints'), { key: r => r.path }), resumeNotes: list(familyRef('resume-notes', 'md'), { key: r => r.path }),
    units: list(unit, { key: u => u.id }), activeUnit: nullable(validateId), effects: list(familyRef('effects'), { key: r => r.path }), cycles: list(cycleRef, { key: r => r.path }), currentCycle: nullable(cycleRef), verificationSession: nullable(sessionRef), baseline: nullable(snapshotRef),
    blocks: list((b, w) => shape(b, { id: validateId, reason: text, evidence: refs }, w), { key: b => b.id }),
    pending: (p, w) => {
      if (p === null) return;
      assert(options.pendingAllowed !== false, w, 'recursive pending is forbidden');
      shape(p, { id: validateId, baseRevision: positive, operation: validateId, targets: list(target, { key: t => t.path }), nextDescriptor: next => validateRunDescriptorV2(next, { runId: v.runId, pendingAllowed: false }) }, w);
    },
    publications: list(publication, { key: p => p.id }), completion: nullable(familyRef('verification/completions')), history,
  }, 'run descriptor v2');
  expectedIdentity(v, options);
  assert((v.phase === 'complete') === (v.status === 'complete'), 'run descriptor v2', 'complete phase/status must go together');
  assert(v.approvalEntry === null || v.approvalEntry <= v.approvals.length, 'approvalEntry', 'must not exceed approvals length');
  validateDescriptorAllocations(v);
  for (const [key, family, ext] of [['approvals', 'approvals', 'json'], ['checkpoints', 'checkpoints', 'json'], ['resumeNotes', 'resume-notes', 'md'], ['effects', 'effects', 'json'], ['cycles', 'verification/cycles', 'json']]) {
    let previous = 0;
    for (const r of v[key]) {
      const n = numberedPath(r.path, family, ext);
      assert(n > previous, key, 'record numbers must be increasing');
      previous = n;
    }
  }
  if (v.currentCycle !== null) assert(v.cycles.some(r => JSON.stringify(r) === JSON.stringify(v.currentCycle)), 'currentCycle', 'must be a recorded cycle Ref');
  assert(v.verificationSession === null || v.currentCycle !== null, 'verificationSession', 'requires currentCycle');
  const prior = new Set();
  for (const u of v.units) {
    assert(u.previousUnit === null || prior.has(u.previousUnit), 'previousUnit', 'must name a preceding unit'); prior.add(u.id);
    if (u.capture !== null) {
      assert(v.cycles.some(c => JSON.stringify(c) === JSON.stringify(u.capture.cycle)), 'capture.cycle', 'must match a recorded cycle');
      if (u.state === 'started' || u.state === 'blocked') {
        assert(JSON.stringify(u.capture.cycle) === JSON.stringify(v.currentCycle), 'capture.cycle', 'active capture must match currentCycle');
        assert(JSON.stringify(u.capture.session) === JSON.stringify(v.verificationSession), 'capture.session', 'must match verificationSession');
      }
    }
  }
  const writers = v.units.filter(u => u.state === 'started' || u.state === 'blocked');
  assert(v.activeUnit === null ? writers.length === 0 : writers.length === 1 && writers[0].id === v.activeUnit, 'activeUnit', 'must identify the only started/blocked writer');
  let revision = 0;
  for (const p of v.publications) { assert(p.revision > revision && p.revision <= v.revision, 'publications', 'revisions must be increasing and published'); revision = p.revision; }
  if (v.pending !== null) {
    const p = v.pending;
    assert(p.baseRevision === v.revision && p.nextDescriptor.revision === v.revision + 1, 'pending', 'revision must advance exactly once');
    const published = p.nextDescriptor.publications.find(entry => entry.id === p.id);
    const targets = p.targets.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
    assert(published?.revision === p.nextDescriptor.revision && JSON.stringify(published.targets) === JSON.stringify(targets), 'pending', 'nextDescriptor must retain matching publication');
    assert(!v.publications.some(entry => entry.id === p.id), 'pending', 'reservation ID was already published');
  }
  assert(v.status !== 'complete' || (v.completion !== null && v.currentCycle !== null && v.baseline !== null && v.activeUnit === null && v.blocks.length === 0), 'completion', 'complete requires completion, cycle, baseline and no active writer/blocks');
  return v;
}

// Before approval the whole repository is observed except these exact start exclusions;
// the approved contract's roots and exclusions replace them from approval onwards.
export function createRunDescriptorV2({ runId: id, harnessName, capabilities = [], git, preapprovalExclusions = [] }) {
  list(enumeration(...CAPABILITIES), { key: c => c })(capabilities, 'capabilities');
  return parseRunDescriptorV2(serializeRunDescriptorV2({
    schema: RUN_SCHEMA_V2, runId: id, revision: 1, phase: 'reconnaissance', status: 'active', harness: { name: harnessName, capabilities: Object.fromEntries(CAPABILITIES.map(c => [c, capabilities.includes(c)])) },
    git: { present: git?.present, branch: git?.branch, commits: git?.commits }, preapprovalExclusions: structuredClone(preapprovalExclusions), nextRecord: 1, approvalEntry: null, approvals: [], checkpoints: [], resumeNotes: [], units: [], activeUnit: null, effects: [], cycles: [], currentCycle: null, verificationSession: null, baseline: null, blocks: [], pending: null, publications: [], completion: null, history: [],
  }));
}

const decimal = pattern(/^(?:0|[1-9][0-9]*)$/u, 'must be a decimal device/inode string');
const archiveIdentity = (v, w) => shape(v, { device: decimal, inode: decimal }, w);
function archiveChildren(v, objects) {
  let previous = -1;
  for (const child of v) {
    const name = objects ? child.name : child;
    const index = RUN_CHILDREN_V2.indexOf(name);
    assert(index > previous, 'children', 'must use canonical child order without duplicates'); previous = index;
    if (objects) assert(child.kind === (name.includes('.') ? 'file' : 'directory'), 'children', 'wrong child kind');
  }
  assert(v.length > 0 && (objects ? v.at(-1).name : v.at(-1)) === 'run.json', 'children', 'run.json must be last');
}
export function validateAbandonRecordV2(v, options = {}) {
  assert(v !== null && typeof v === 'object', 'abandon', 'must be an object');
  const base = { schema: enumeration(v.schema), id: validateId, runId };
  if (v.schema === ABANDON_INTENT_SCHEMA_V2) {
    shape(v, { ...base, at: timestamp, reason: text, descriptor: ref, archive: validatePath, children: list((c, w) => shape(c, { name: enumeration(...RUN_CHILDREN_V2), kind: enumeration('file', 'directory'), device: decimal, inode: decimal }, w)), status: enumeration('prepared', 'complete') }, 'abandon intent');
    archiveChildren(v.children, true);
  } else if (v.schema === ABANDON_SCHEMA_V2) {
    shape(v, { ...base, at: timestamp, reason: text, descriptor: ref, intent: ref, archiveIdentity, children: list(enumeration(...RUN_CHILDREN_V2)) }, 'abandon');
    archiveChildren(v.children, false);
    assert(v.intent.path === `${AREA}abandoned/${v.runId}/intent.json`, 'intent', 'must reference own prepared archive intent');
  } else if (v.schema === ABANDON_RECEIPT_SCHEMA_V2) {
    shape(v, { ...base, intentSha256: digest, descriptor: ref, archive: validatePath, completedAt: timestamp }, 'abandon receipt');
  } else fail('schema', 'unsupported abandon format');
  expectedIdentity(v, options);
  assert(v.descriptor.path === `${AREA}abandoned/${v.runId}/run.json`, 'descriptor', 'must reference own archived descriptor');
  if (Object.hasOwn(v, 'archive')) assert(v.archive === `abandoned/${v.runId}`, 'archive', 'must name own archive');
  return v;
}

// Parse valid JSON first, then scan its strings to detect duplicate *decoded* keys.
// The scanner never interprets strings as structure, and JSON.parse supplies syntax validation.
export function parseStrictJson(input, where = 'JSON') {
  let source = input;
  if (input instanceof Uint8Array) {
    try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input); }
    catch { fail(where, 'must be valid UTF-8'); }
  }
  string(source, where);
  let value;
  try { value = JSON.parse(source); } catch { fail(where, 'is not valid JSON'); }
  const frames = [];
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (c === '"') {
      let end = i + 1;
      while (source[end] !== '"') end += source[end] === '\\' ? 2 : 1;
      const frame = frames.at(-1);
      if (frame?.keys && frame.expectKey) {
        const key = JSON.parse(source.slice(i, end + 1));
        assert(!frame.keys.has(key), where, `duplicate key ${JSON.stringify(key)}`);
        frame.keys.add(key); frame.expectKey = false;
      }
      i = end;
    } else if (c === '{') frames.push({ keys: new Set(), expectKey: true });
    else if (c === '[') frames.push({ keys: null });
    else if (c === '}' || c === ']') frames.pop();
    else if (c === ',' && frames.at(-1)?.keys) frames.at(-1).expectKey = true;
  }
  return value;
}
function freeze(v) {
  if (v !== null && typeof v === 'object') { for (const child of Object.values(v)) freeze(child); Object.freeze(v); }
  return v;
}
const parser = validator => (input, options) => freeze(validator(parseStrictJson(input), options));
const renderer = validator => (value, options) => `${JSON.stringify(validator(value, options), null, 2)}\n`;
export const parseRunDescriptorV2 = parser(validateRunDescriptorV2);
export const serializeRunDescriptorV2 = renderer(validateRunDescriptorV2);
export const parseInceptionRecord = parser(validateInceptionRecord);
export const serializeInceptionRecord = renderer(validateInceptionRecord);
export const parseVerificationContract = parser(validateVerificationContract);
export const serializeVerificationContract = renderer(validateVerificationContract);
export const parseCaptureReceipt = parser(validateCaptureReceipt);
export const serializeCaptureReceipt = renderer(validateCaptureReceipt);
export const parseAbandonRecordV2 = parser(validateAbandonRecordV2);
export const serializeAbandonRecordV2 = renderer(validateAbandonRecordV2);

// These primitives require the caller to hold the public scaffold lease. They
// never replace a descriptor, choose a workflow phase, or dispatch a writer.
export function publicationRef(path, content) {
  validatePath(path);
  const bytes = Buffer.from(content);
  return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
function publicationPath(path, archiveIntent) {
  validatePath(path);
  if (archiveIntent !== undefined) {
    validateAbandonRecordV2(archiveIntent);
    assert(archiveIntent.schema === ABANDON_INTENT_SCHEMA_V2 && archiveIntent.status === 'prepared', 'archive intent', 'must be prepared');
    assert(['intent.json', 'abandon.json', 'receipt.json'].some(name => path === `${AREA}${archiveIntent.archive}/${name}`), path, 'must be an exact reserved archive record');
    return;
  }
  assert(path.startsWith(AREA) && !path.startsWith(`${AREA}abandoned/`)
    && path !== `${AREA}run.json` && path !== `${AREA}.gitignore`
    && path !== `${AREA}abandon-intent.json`, path, 'must be an immutable inception target');
}
export function preparePublication(descriptor, { id, operation, targets, nextDescriptor }) {
  validateRunDescriptorV2(descriptor);
  validateId(id); validateId(operation);
  assert(descriptor.pending === null, 'pending', 'must resume the existing reservation');
  assert(!descriptor.publications.some(p => p.id === id), 'reservation', 'already published');
  const rendered = targets.map(({ path, content }) => {
    publicationPath(path);
    assert(typeof content === 'string' || content instanceof Uint8Array, path, 'content must be bytes or text');
    const bytes = Buffer.from(content);
    return { ...publicationRef(path, bytes), contentBase64: bytes.toString('base64') };
  });
  const next = structuredClone(nextDescriptor);
  assert(next.runId === descriptor.runId && next.revision === descriptor.revision, 'revision', 'next descriptor must derive from current revision');
  assert(next.pending === null, 'pending', 'next descriptor cannot reserve another operation');
  assert(JSON.stringify(next.publications) === JSON.stringify(descriptor.publications), 'publications', 'must preserve previous publications');
  next.revision += 1;
  next.publications.push({ id, revision: next.revision, targets: rendered.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) });
  const reserved = { ...descriptor, pending: { id, baseRevision: descriptor.revision, operation, targets: rendered, nextDescriptor: next } };
  return parseRunDescriptorV2(serializeRunDescriptorV2(reserved));
}
function publicationStat(path) {
  try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function syncPublicationDirectory(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function publicationParents(root, path, create = false) {
  validatePath(path);
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    const parent = join(root, ...parts.slice(0, i));
    let stat = publicationStat(parent);
    if (stat === null) {
      if (!create) return false;
      mkdirSync(parent); syncPublicationDirectory(dirname(parent)); stat = lstatSync(parent);
    }
    assert(stat.isDirectory() && !stat.isSymbolicLink(), path, 'ancestor must be an ordinary directory');
    assert(realpathSync(parent) === resolve(parent), path, 'ancestor alias is forbidden');
  }
  return true;
}
export function readPublicationFile(root, path, { missing = false } = {}) {
  validatePath(path);
  const parents = publicationParents(root, path);
  const absolute = join(root, path);
  const stat = parents ? publicationStat(absolute) : null;
  if (stat === null) { assert(missing, path, 'does not exist'); return null; }
  assert(stat.isFile() && stat.nlink === 1, path, 'must be an ordinary single-link file');
  assert(realpathSync(absolute) === resolve(absolute), path, 'physical alias is forbidden');
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    assert(opened.isFile() && opened.nlink === 1 && opened.dev === stat.dev && opened.ino === stat.ino, path, 'file identity changed');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
// Binary capture outputs are hashed incrementally and never embedded in pending.
export function publicationFileRef(root, path) {
  validatePath(path);
  assert(publicationParents(root, path), path, 'does not exist');
  const absolute = join(root, path); const stat = publicationStat(absolute);
  assert(stat?.isFile() && stat.nlink === 1, path, 'must be an ordinary single-link file');
  assert(realpathSync(absolute) === resolve(absolute), path, 'physical alias is forbidden');
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    assert(opened.isFile() && opened.nlink === 1 && opened.dev === stat.dev && opened.ino === stat.ino, path, 'file identity changed');
    const hash = createHash('sha256'); const buffer = Buffer.alloc(64 * 1024); let bytes = 0;
    for (;;) { const count = readSync(fd, buffer, 0, buffer.length, null); if (count === 0) break; hash.update(buffer.subarray(0, count)); bytes += count; }
    const after = fstatSync(fd);
    assert(after.size === bytes && after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs, path, 'file changed while hashing');
    return { path, bytes, sha256: hash.digest('hex') };
  } finally { closeSync(fd); }
}
export function openPublicationOutput(root, path) {
  publicationPath(path); publicationParents(root, path, true);
  const fd = openSync(join(root, path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { syncPublicationDirectory(dirname(join(root, path))); return fd; }
  catch (error) { closeSync(fd); throw error; }
}
export function verifyPublicationTargets(root, targets, { prefix = false, archiveIntent } = {}) {
  let gap = false;
  for (const target of targets) {
    publicationPath(target.path, archiveIntent);
    const bytes = readPublicationFile(root, target.path, { missing: prefix });
    if (bytes === null) { gap = true; continue; }
    assert(!gap, target.path, 'published targets must be an ordered prefix');
    const observed = publicationRef(target.path, bytes);
    assert(observed.bytes === target.bytes && observed.sha256 === target.sha256, target.path, 'target digest is divergent');
  }
}
// The state owner admits this entire namespace as absent before persisting the
// reservation. Its durable pending record therefore owns every subsequent
// staging generation here; matching bytes in unrelated sibling temps grant no
// ownership. A generation cannot predate a directory that did not yet exist.
export function publicationStagingDirectory(path, reservation, archiveIntent) {
  publicationPath(path, archiveIntent); validateId(reservation, 'reservation');
  return `${path}.${reservation}.staging`;
}
export function stagePublicationTargets(root, pending, { fault, archiveIntent } = {}) {
  validateId(pending.id);
  if (archiveIntent !== undefined) assert(pending.id === archiveIntent.id, 'reservation', 'must match archive intent');
  // Validate the complete set before any new target or directory is written.
  verifyPublicationTargets(root, pending.targets, { prefix: true, archiveIntent });
  for (const target of pending.targets) {
    if (readPublicationFile(root, target.path, { missing: true }) !== null) continue;
    const stagingDirectory = publicationStagingDirectory(target.path, pending.id, archiveIntent);
    publicationParents(root, `${stagingDirectory}/0001.tmp`, true);
    let generation = 1;
    let tempPath;
    for (;;) {
      tempPath = `${stagingDirectory}/${String(generation).padStart(4, '0')}.tmp`;
      const existing = readPublicationFile(root, tempPath, { missing: true });
      if (existing === null) break;
      const observed = publicationRef(tempPath, existing);
      if (observed.bytes === target.bytes && observed.sha256 === target.sha256) break;
      // Retain a partial generation as interruption evidence. Only inspect the
      // next exact token-bound generation; never discover files by listing.
      generation += 1;
      assert(Number.isSafeInteger(generation), tempPath, 'staging generation overflow');
    }
    if (readPublicationFile(root, tempPath, { missing: true }) === null) {
      fault?.('before-stage', { reservation: pending.id, path: target.path, tempPath });
      const fd = openSync(join(root, tempPath), 'wx', 0o644);
      try { writeAllSync(fd, Buffer.from(target.contentBase64, 'base64')); fsyncSync(fd); }
      finally { closeSync(fd); }
      syncPublicationDirectory(dirname(join(root, tempPath)));
      fault?.('after-stage', { reservation: pending.id, path: target.path, tempPath });
    }
    const staged = publicationRef(tempPath, readPublicationFile(root, tempPath));
    assert(staged.bytes === target.bytes && staged.sha256 === target.sha256, tempPath, 'staging digest is divergent');
    fault?.('before-rename', { reservation: pending.id, path: target.path, tempPath });
    assert(readPublicationFile(root, target.path, { missing: true }) === null, target.path, 'target appeared before rename');
    renameSync(join(root, tempPath), join(root, target.path));
    syncPublicationDirectory(dirname(join(root, tempPath)));
    syncPublicationDirectory(dirname(join(root, target.path)));
    fault?.('after-rename', { reservation: pending.id, path: target.path, tempPath });
  }
  verifyPublicationTargets(root, pending.targets, { archiveIntent });
}

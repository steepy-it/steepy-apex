// Init provenance certifies only the public producer's exact file operations.
// It never edits the completed run, applies the scaffold, or excludes providers.
import fs from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { normalizeProjectModel, planProjectScaffold, renderProjectArtifact, withProjectScaffoldLock } from './project-scaffold.mjs';
import { parseStrictJson, validateRef, validateAppEntry, validateId, validatePath, publicationRef, readPublicationFile, parseInceptionRecord } from './inception-protocol.mjs';
import { observeApplication, applicationIdentity, withApplicationSnapshotLease } from './inception-snapshot.mjs';
import { parseRunDescriptor, verifyComplete } from './inception-state.mjs';
import { writeAllSync } from './write-all.mjs';

export const GOVERNANCE_PENDING = '.apex/init-provenance.pending.json';
export const GOVERNANCE_RECEIPT = '.apex/init-provenance.json';
const SCHEMA = 'steepy-inception-governance/v1';
const INPUT_SCHEMA = 'steepy-inception-governance-input/v1';
const RUN = '.apex/inception/run.json';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const render = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const requireThat = (ok, reason) => { if (!ok) throw new Error(`governance: ${reason}`); };
function shape(value, keys, where) {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), `${where} has invalid keys`);
}
function text(value, where) {
  requireThat(typeof value === 'string' && !value.includes('\0') && Buffer.from(value).toString('utf8') === value, `${where} must be representable UTF-8 text`);
  return value;
}
function documentPaths(model) {
  return ['.apex/_INDEX.md', '.apex/conventions.md', '.apex/glossary.md', '.apex/testing-and-checklist.md', ...model.surfaces.map(s => `.apex/standards/${s.name}.md`)].sort();
}
function canonicalDocuments(documents, model, contents) {
  requireThat(Array.isArray(documents), 'documents must be an array');
  const docs = documents.map(document => {
    shape(document, ['path', contents ? 'content' : 'sha256'], 'document'); validatePath(document.path);
    if (contents) return { path: document.path, content: text(document.content, 'document content') };
    requireThat(/^[0-9a-f]{64}$/u.test(document.sha256), 'document digest must be SHA-256');
    return { path: document.path, sha256: document.sha256 };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  requireThat(same(docs.map(d => d.path), documentPaths(model)), 'documents must name exactly the stable init documents for this model');
  return docs;
}
export function validateGovernanceInput(input) {
  shape(input, ['schema', 'runId', 'completion', 'projectModel', 'documents'], 'input');
  requireThat(input.schema === INPUT_SCHEMA, 'unsupported input schema');
  validateRef(input.completion); requireThat(/^inc-\d{8}T\d{6}Z-[0-9a-f]{8}$/u.test(input.runId), 'malformed runId');
  const projectModel = normalizeProjectModel(input.projectModel);
  return { schema: INPUT_SCHEMA, runId: input.runId, completion: { ...input.completion }, projectModel, documents: canonicalDocuments(input.documents, projectModel, true) };
}
function producerFor(input) {
  return { name: 'init', projectModel: input.projectModel, documents: input.documents.map(({ path, content }) => ({ path, sha256: sha(Buffer.from(content)) })) };
}
function receiptId(runId, completion, producer) { return sha(render({ runId, completion, producer })); }
function artifactIds(model) {
  return new Map([
    ['AGENTS.md', 'project-instructions'], ['CLAUDE.md', 'claude-import'],
    [`.agents/skills/${model.projectName}-bootstrap/SKILL.md`, 'project-bootstrap'],
    [`.claude/skills/${model.projectName}-bootstrap/SKILL.md`, 'claude-bootstrap-stub'],
    ...model.surfaces.flatMap(s => [[`.claude/agents/${s.agent}.md`, `${s.agent}-claude`], [`.codex/agents/${s.agent}.toml`, `${s.agent}-codex`], [`.opencode/agents/${s.agent}.md`, `${s.agent}-opencode`]]),
  ]);
}
export function validateGovernanceReceipt(value) {
  shape(value, ['schema', 'id', 'runId', 'completion', 'producer', 'operations', 'applicationBefore', 'applicationAfter', 'status'], 'receipt');
  requireThat(value.schema === SCHEMA, 'unsupported receipt schema'); validateId(value.id); validateRef(value.completion); validateRef(value.applicationBefore);
  requireThat(/^inc-\d{8}T\d{6}Z-[0-9a-f]{8}$/u.test(value.runId), 'malformed runId');
  shape(value.producer, ['name', 'projectModel', 'documents'], 'producer'); requireThat(value.producer.name === 'init', 'unsupported producer');
  const projectModel = normalizeProjectModel(value.producer.projectModel);
  const producer = { name: 'init', projectModel, documents: canonicalDocuments(value.producer.documents, projectModel, false) };
  requireThat(value.id === receiptId(value.runId, value.completion, producer), 'receipt input identity mismatch');
  requireThat(['prepared', 'complete'].includes(value.status), 'unsupported status');
  const ids = artifactIds(projectModel); const documents = new Map(producer.documents.map(d => [d.path, d.sha256]));
  requireThat(Array.isArray(value.operations), 'operations must be an array');
  const operations = value.operations.map(op => {
    shape(op, ['path', 'kind', 'before', 'after', 'managedBefore', 'managedAfter'], 'operation'); validatePath(op.path);
    requireThat(ids.has(op.path) || documents.has(op.path), 'operation is not a canonical governance destination');
    if (op.before !== null) { validateAppEntry(op.before); requireThat(op.before.path === op.path, 'before path mismatch'); }
    validateAppEntry(op.after); requireThat(op.after.path === op.path, 'after path mismatch');
    requireThat(['create', 'replace-managed', 'replace-generated'].includes(op.kind), 'unsupported operation kind');
    requireThat((op.kind === 'create') === (op.before === null), 'operation before/kind mismatch');
    const mixed = op.path === 'AGENTS.md' || op.path === 'CLAUDE.md';
    if (op.kind === 'replace-managed') {
      requireThat(mixed, 'managed replacement must be a root instruction'); text(op.managedBefore, 'managedBefore'); text(op.managedAfter, 'managedAfter');
      requireThat(op.managedAfter.length > 0, 'empty managed replacement');
    } else requireThat(op.managedBefore === null && op.managedAfter === null, 'non-managed operation has managed text');
    requireThat(op.kind !== 'replace-generated' || (!mixed && ids.has(op.path)), 'generated replacement must be a provider artifact');
    if (documents.has(op.path)) requireThat(op.kind === 'create' && op.after.sha256 === documents.get(op.path), 'stable documents are create-only and digest-bound');
    else if (!mixed || op.kind === 'create') {
      const bytes = Buffer.from(renderProjectArtifact(ids.get(op.path), projectModel));
      requireThat(op.after.sha256 === sha(bytes) && op.after.bytes === bytes.length, 'generated artifact differs from the public renderer');
    }
    return { path: op.path, kind: op.kind, before: op.before, after: op.after, managedBefore: op.managedBefore, managedAfter: op.managedAfter };
  });
  requireThat(operations.every((op, i) => i === 0 || operations[i - 1].path < op.path), 'operations must have unique sorted paths');
  requireThat([...documents.keys()].every(path => operations.some(op => op.path === path)), 'receipt omits a stable document');
  if (value.status === 'prepared') requireThat(value.applicationAfter === null, 'prepared receipt cannot claim an applicationAfter');
  else {
    requireThat(Array.isArray(value.applicationAfter), 'complete receipt requires applicationAfter');
    value.applicationAfter.forEach(entry => validateAppEntry(entry));
    requireThat(value.applicationAfter.every((entry, i) => i === 0 || value.applicationAfter[i - 1].path < entry.path), 'applicationAfter must be unique and sorted');
  }
  return { schema: SCHEMA, id: value.id, runId: value.runId, completion: value.completion, producer, operations, applicationBefore: value.applicationBefore, applicationAfter: value.applicationAfter, status: value.status };
}
function readReceipt(root, path, missing = false) {
  const bytes = readPublicationFile(root, path, { missing }); if (bytes === null) return null;
  const receipt = validateGovernanceReceipt(parseStrictJson(bytes));
  requireThat(receipt.status === (path === GOVERNANCE_PENDING ? 'prepared' : 'complete'), `${path} has the wrong receipt status`);
  requireThat(bytes.equals(render(receipt)), `${path} is not a canonical receipt`); return receipt;
}
function entry(path, bytes, mode) { return { path, mode, ...Object.fromEntries(Object.entries(publicationRef(path, bytes)).filter(([key]) => key !== 'path')) }; }
function currentEntry(root, path) {
  const bytes = readPublicationFile(root, path, { missing: true });
  return bytes === null ? null : entry(path, bytes, fs.lstatSync(join(root, path)).mode & 0o7777);
}
function exactRef(root, ref) {
  const bytes = readPublicationFile(root, ref.path); requireThat(same(publicationRef(ref.path, bytes), ref), `${ref.path} digest mismatch`); return bytes;
}
function context(root) {
  const descriptor = parseRunDescriptor(readPublicationFile(root, RUN).toString('utf8'));
  requireThat(descriptor.schema === 'steepy-inception-run/v2' && descriptor.status === 'complete', 'requires a complete v2 run');
  const completion = parseInceptionRecord(exactRef(root, descriptor.completion));
  const snapshot = parseInceptionRecord(exactRef(root, completion.body.snapshot)).body;
  return { descriptor, completion, snapshot };
}
function inScope(path, snapshot) {
  const within = (path, scope) => scope === '.' || path === scope || path.startsWith(`${scope}/`);
  return snapshot.roots.some(root => within(path, root)) && !snapshot.exclusions.some(e => within(path, e.path));
}
function expectedAfter(receipt, snapshot) {
  const files = new Map(snapshot.files.map(file => [file.path, file]));
  for (const op of receipt.operations) if (inScope(op.path, snapshot)) files.set(op.path, op.after);
  return [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function bindReceipt(receipt, { descriptor, completion, snapshot }) {
  requireThat(receipt.runId === descriptor.runId && same(receipt.completion, descriptor.completion)
    && same(receipt.applicationBefore, completion.body.snapshot), 'receipt is not bound to this completion');
  for (const op of receipt.operations) {
    // The completed inventory proves presence/absence only inside its approved
    // scope. Other targets retain the exact physical before observation bound
    // by prepare's immutable reservation; inverse still authenticates them.
    if (!inScope(op.path, snapshot)) continue;
    const old = snapshot.files.find(file => file.path === op.path) ?? null;
    requireThat(same(old, op.before), `${op.path} before is not the completed snapshot`);
  }
}
function withoutReceipts(observed) { return { ...observed, files: observed.files.filter(file => ![GOVERNANCE_PENDING, GOVERNANCE_RECEIPT].includes(file.path)) }; }
function inverse(root, receipt, ctx, { partial = false } = {}) {
  bindReceipt(receipt, ctx);
  const observed = ctx.observed ?? observeApplication(root, ctx.snapshot);
  const clean = withoutReceipts(observed);
  const files = new Map(clean.files.map(file => [file.path, file]));
  for (const op of receipt.operations) {
    const current = currentEntry(root, op.path);
    if (partial && same(current, op.before)) continue;
    requireThat(same(current, op.after), `${op.path} governance output drift`);
    if (op.kind === 'replace-managed') {
      const after = readPublicationFile(root, op.path).toString('utf8');
      const offset = after.indexOf(op.managedAfter);
      requireThat(offset >= 0 && after.indexOf(op.managedAfter, offset + 1) < 0, `${op.path} managed replacement is not unique`);
      const before = after.slice(0, offset) + op.managedBefore + after.slice(offset + op.managedAfter.length);
      requireThat(same(entry(op.path, Buffer.from(before), op.before.mode), op.before), `${op.path} unmanaged bytes changed`);
      requireThat(same(managedDelta(before, after, op.path), { managedBefore: op.managedBefore, managedAfter: op.managedAfter }), `${op.path} uncertified unmanaged replacement`);
      // The current managed content must still contain the exact public block.
      const rendered = renderProjectArtifact(artifactIds(receipt.producer.projectModel).get(op.path), receipt.producer.projectModel).trimEnd();
      requireThat(after.replaceAll('\r\n', '\n').includes(rendered), `${op.path} managed block differs from public renderer`);
    }
    if (inScope(op.path, ctx.snapshot)) {
      if (op.before === null) files.delete(op.path); else files.set(op.path, op.before);
    }
  }
  const projected = { ...clean, files: [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
  requireThat(applicationIdentity(projected) === applicationIdentity(ctx.snapshot), 'application-drift outside certified init operations');
  if (!partial) {
    requireThat(same(clean.files, expectedAfter(receipt, ctx.snapshot)), 'applicationAfter differs from prepared operations');
    if (receipt.status === 'complete') requireThat(same(clean.files, receipt.applicationAfter), 'applicationAfter drift');
  }
  return projected;
}
// Called by verifyComplete only after its transitive completion inputs are bound.
export function verifyGovernance(root, ctx) {
  const pending = readReceipt(root, GOVERNANCE_PENDING, true);
  const final = readReceipt(root, GOVERNANCE_RECEIPT, true);
  if (pending === null && final === null) return ctx.observed;
  requireThat(pending !== null && final !== null && pending.status === 'prepared' && final.status === 'complete', 'init provenance is incomplete');
  requireThat(same({ ...final, applicationAfter: null, status: 'prepared' }, pending), 'final receipt differs from its reservation');
  stagingReservation(root, pending);
  return inverse(root, final, ctx);
}
function checkCompletion(root, receipt, partial) {
  let projection;
  const result = verifyComplete(root, { verifyGovernance: (_root, ctx) => { projection = inverse(root, receipt, ctx, { partial }); return projection; } });
  requireThat(result.ok, result.reason); return projection;
}
function syncDirectory(path) { const fd = fs.openSync(path, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function stagingBase(receipt) { return `.apex/work/init-provenance/${receipt.id}`; }
function prepareReceipt(receipt) { return { ...receipt, applicationAfter: null, status: 'prepared' }; }
function ensureDirectory(root, path) {
  validatePath(path);
  const parts = path.split('/');
  for (let n = 1; n <= parts.length; n++) {
    const absolute = join(root, ...parts.slice(0, n));
    let stat;
    try { stat = fs.lstatSync(absolute); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!stat) { fs.mkdirSync(absolute); syncDirectory(dirname(absolute)); stat = fs.lstatSync(absolute); }
    requireThat(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(absolute) === absolute, `${path} has an unsafe staging ancestor`);
  }
}
function stagingReservation(root, receipt, { create = false, fault } = {}) {
  const base = stagingBase(receipt); const path = `${base}/reservation.json`; const bytes = render(prepareReceipt(receipt));
  const reserved = readPublicationFile(root, path, { missing: true });
  if (reserved !== null) { requireThat(reserved.equals(bytes), 'staging reservation collision'); return; }
  requireThat(create, 'missing producer staging reservation');
  // Admit a fresh namespace, or recover only the complete, digest-exact
  // journal stage. An empty/foreign namespace or partial journal is not a
  // reservation and cannot confer ownership of publication generations.
  const stage = `${base}/reservation.tmp`;
  const staged = readPublicationFile(root, stage, { missing: true });
  if (staged !== null) requireThat(staged.equals(bytes), 'incomplete or foreign reservation stage');
  else {
    let present = false;
    try { fs.lstatSync(join(root, base)); present = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    requireThat(!present, 'unowned staging namespace collision');
    ensureDirectory(root, base);
    const fd = fs.openSync(join(root, stage), 'wx', 0o644);
    try { writeAllSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(join(root, base));
  }
  fault?.('after-reservation-stage', { stage });
  requireThat(readPublicationFile(root, path, { missing: true }) === null, 'reservation appeared before publication');
  fs.renameSync(join(root, stage), join(root, path)); syncDirectory(join(root, base));
}
function publish(root, path, receipt, { fault } = {}) {
  const bytes = render(receipt); const existing = readPublicationFile(root, path, { missing: true });
  if (existing !== null) { requireThat(existing.equals(bytes), `${path} collision`); return; }
  stagingReservation(root, receipt);
  const base = stagingBase(receipt); const family = path === GOVERNANCE_PENDING ? 'pending' : 'complete';
  let generation = 1; let stage;
  for (;;) {
    stage = `${base}/${family}-${String(generation).padStart(4, '0')}.tmp`;
    const staged = readPublicationFile(root, stage, { missing: true });
    if (staged === null) {
      const fd = fs.openSync(join(root, stage), 'wx', 0o644);
      try { writeAllSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      syncDirectory(join(root, base)); break;
    }
    if (staged.equals(bytes)) break;
    requireThat(staged.length < bytes.length && bytes.subarray(0, staged.length).equals(staged), `${stage} divergent staging collision`);
    // The durable reservation owns the namespace: retain an incomplete exact
    // prefix and write a new generation, never promote or overwrite the prefix.
    generation++; requireThat(Number.isSafeInteger(generation), 'staging generation overflow');
  }
  fault?.('after-stage', { path, stage });
  requireThat(readPublicationFile(root, path, { missing: true }) === null, `${path} appeared before publication`);
  fs.renameSync(join(root, stage), join(root, path)); syncDirectory(join(root, base)); syncDirectory(dirname(join(root, path)));
}
function managedDelta(before, after, path) {
  const id = path === 'AGENTS.md' ? 'project-instructions' : 'claude-import';
  const startMarker = `<!-- steepy:managed:${id}:v1:start -->`;
  const endMarker = `<!-- steepy:managed:${id}:v1:end -->`;
  const start = before.indexOf(startMarker); const end = before.indexOf(endMarker);
  if (start >= 0 && end > start && before.indexOf(startMarker, start + 1) < 0 && before.indexOf(endMarker, end + 1) < 0) {
    const limit = end + endMarker.length; const prefix = before.slice(0, start); const suffix = before.slice(limit);
    requireThat(after.startsWith(prefix) && after.endsWith(suffix) && after.length >= prefix.length + suffix.length, `${path} replacement would discard unmanaged bytes`);
    return { managedBefore: before.slice(start, limit), managedAfter: after.slice(prefix.length, after.length - suffix.length) };
  }
  // First init may append a block to an unmarked root. A destructive repair of
  // malformed/legacy roots is still an ordinary planner operation, but cannot
  // be certified as an init-only addition to a completed application.
  requireThat(after.startsWith(before), `${path} replacement would discard unmanaged bytes`);
  return { managedBefore: '', managedAfter: after.slice(before.length) };
}
function withGovernanceSnapshotLease(root, observed, expectedId, options, action) {
  const identity = path => {
    const file = currentEntry(root, path);
    if (file === null) return null;
    const stat = fs.lstatSync(join(root, path));
    return { ...file, device: String(stat.dev), inode: String(stat.ino) };
  };
  // The public lease retains a reclaimed dead generation until release. Retire
  // it before any application observation; do not exempt stale-looking paths.
  const authority = withProjectScaffoldLock({ hubRoot: root }, () => {
    requireThat(same(context(root).descriptor, observed.descriptor), 'descriptor revision, run identity or completion changed');
    const pending = readReceipt(root, GOVERNANCE_PENDING, true);
    const final = readReceipt(root, GOVERNANCE_RECEIPT, true);
    const ids = new Set([expectedId, pending?.id, final?.id].filter(Boolean));
    const paths = [RUN, GOVERNANCE_PENDING, GOVERNANCE_RECEIPT,
      ...[...ids].flatMap(id => [`${stagingBase({ id })}/reservation.json`, `${stagingBase({ id })}/reservation.tmp`])];
    return paths.map(path => [path, identity(path)]);
  });
  options.fault?.('after-lease-retirement');
  return withApplicationSnapshotLease(root, () => {
    // A cooperating writer can enter the gap. Bind presence, bytes, modes and
    // physical identity of the descriptor and exact reservations across it.
    requireThat(authority.every(([path, before]) => same(identity(path), before)), 'descriptor or governance reservation changed between leases');
    return action(context(root));
  });
}
export function prepareGovernance(repoRoot, rawInput, options = {}) {
  const input = validateGovernanceInput(rawInput); const root = fs.realpathSync(repoRoot); const producer = producerFor(input);
  const ctx = context(root);
  requireThat(input.runId === ctx.descriptor.runId && same(input.completion, ctx.descriptor.completion), 'input completion mismatch');
  return withGovernanceSnapshotLease(root, ctx, receiptId(input.runId, input.completion, producer), options, current => {
    const pending = readReceipt(root, GOVERNANCE_PENDING, true); const final = readReceipt(root, GOVERNANCE_RECEIPT, true);
    if (pending !== null) {
      requireThat(pending.id === receiptId(input.runId, input.completion, producer) && same(pending.producer, producer), 'different input reservation collision');
      if (final !== null) { const result = verifyComplete(root); requireThat(result.ok, result.reason); return final; }
      stagingReservation(root, pending); checkCompletion(root, pending, true); return pending;
    }
    requireThat(final === null, 'final receipt without a reservation');
    const verified = verifyComplete(root); requireThat(verified.ok, verified.reason);
    for (const doc of input.documents) requireThat(readPublicationFile(root, doc.path, { missing: true }) === null, `${doc.path} already exists; stable documents are create-only`);
    const plan = planProjectScaffold({ hubRoot: root, model: input.projectModel });
    requireThat(plan.conflicts.length === 0, 'public scaffold planner has unresolved conflicts');
    const operations = [
      ...input.documents.map(doc => ({ path: doc.path, kind: 'create', content: doc.content })),
      ...plan.operations,
    ].map(op => {
      const before = currentEntry(root, op.path); const bytes = Buffer.from(op.content);
      const after = entry(op.path, bytes, before === null ? 0o644 : (before.mode & 0o777) || 0o644);
      const delta = op.kind === 'replace-managed' ? managedDelta(readPublicationFile(root, op.path).toString('utf8'), op.content, op.path) : { managedBefore: null, managedAfter: null };
      return { path: op.path, kind: op.kind, before, after, ...delta };
    }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const receipt = validateGovernanceReceipt({ schema: SCHEMA, id: receiptId(input.runId, input.completion, producer), runId: input.runId, completion: input.completion, producer, operations, applicationBefore: current.completion.body.snapshot, applicationAfter: null, status: 'prepared' });
    bindReceipt(receipt, current); stagingReservation(root, receipt, { create: true, fault: options.fault }); options.fault?.('after-reservation'); publish(root, GOVERNANCE_PENDING, receipt, options); options.fault?.('after-prepare'); return receipt;
  });
}
export function finishGovernance(repoRoot, options = {}) {
  const root = fs.realpathSync(repoRoot); const observed = context(root);
  return withGovernanceSnapshotLease(root, observed, null, options, ctx => {
    const pending = readReceipt(root, GOVERNANCE_PENDING); requireThat(pending.status === 'prepared', 'pending receipt must be prepared');
    const final = readReceipt(root, GOVERNANCE_RECEIPT, true);
    if (final !== null) { const result = verifyComplete(root); requireThat(result.ok, result.reason); return final; }
    stagingReservation(root, pending); checkCompletion(root, pending, false);
    const receipt = validateGovernanceReceipt({ ...pending, applicationAfter: expectedAfter(pending, ctx.snapshot), status: 'complete' });
    options.fault?.('before-finish'); publish(root, GOVERNANCE_RECEIPT, receipt, options); options.fault?.('after-finish'); return receipt;
  });
}
export function main(argv = process.argv.slice(2)) {
  let command; let values;
  try {
    command = argv[0]; requireThat(['prepare', 'finish'].includes(command), 'usage: prepare --repo-root <root> --input <exact-json> | finish --repo-root <root>');
    ({ values } = parseArgs({ args: argv.slice(1), strict: true, allowPositionals: false, options: { 'repo-root': { type: 'string' }, ...(command === 'prepare' ? { input: { type: 'string' } } : {}) } }));
    requireThat(values['repo-root'] && (command !== 'prepare' || values.input), 'missing required option');
  } catch (error) { console.error(error.message); return 2; }
  try {
    const root = fs.realpathSync(values['repo-root']);
    if (command === 'prepare') { validatePath(values.input); requireThat(values.input.startsWith('.apex/work/'), 'init input must be an exact file in its authorized work scope'); }
    const receipt = command === 'prepare' ? prepareGovernance(root, parseStrictJson(readPublicationFile(root, values.input))) : finishGovernance(root);
    console.log(JSON.stringify({ ok: true, id: receipt.id, status: receipt.status, path: receipt.status === 'complete' ? GOVERNANCE_RECEIPT : GOVERNANCE_PENDING })); return 0;
  } catch (error) { console.error(error.message); return 1; }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main();

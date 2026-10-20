import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as protocol from '../scripts/inception-protocol.mjs';

const runId = 'inc-20261012T120000Z-1234abcd';
const otherRun = 'inc-20261012T120000Z-1234abce';
const at = '2026-10-12T12:00:00.000Z';
const area = '.apex/inception/';
const ref = (path = 'snapshots/0001.json') => ({ path: area + path, bytes: 1, sha256: 'a'.repeat(64) });
const app = (path = 'app.js') => ({ path, mode: 0o644, bytes: 1, sha256: 'b'.repeat(64) });
const command = () => ({ executable: 'node', args: ['--test', 'test file.js'], cwd: '.', successExitCodes: [0] });
const environment = () => ({ tools: [{ name: 'node', version: '24.0.0' }], resources: [{ id: 'db', identity: 'local-fixture' }] });
const manual = () => ({ procedure: 'Inspect the page', acceptance: 'Page is readable' });
const contract = () => ({
  schema: 'steepy-inception-checks/v2', roots: ['.'], exclusions: [{ path: 'node_modules', kind: 'dependencies', reason: 'Installed dependencies' }],
  environment: { tools: ['node'], resources: [{ id: 'db', description: 'Fixture database' }] },
  checks: [{ id: 'test', required: true, type: 'automatic', subject: 'Application', procedure: 'Run tests', expected: 'Tests pass', evidenceRequired: 'Full output', automatic: command(), manual: null, reuse: { policy: 'snapshot', automatic: null, manual: null } }],
  coverage: [{ id: 'app', component: 'Application', checks: ['test'], status: 'current' }],
});
const descriptor = () => protocol.createRunDescriptorV2({ runId, harnessName: 'codex', capabilities: ['shell'], git: { present: false, branch: null, commits: 'none' } });
const mutable = () => structuredClone(descriptor());
const record = (kind, body) => ({ schema: 'steepy-inception-record/v2', runId, record: 2, kind, at, unitId: null, body });
const roundtrip = (value, parse, render, options = {}) => {
  const bytes = render(value);
  assert.equal(bytes.endsWith('\n'), true);
  assert.deepEqual(parse(Buffer.from(bytes), options), value);
  assert.equal(render(parse(bytes, options)), bytes);
};

test('v2 constructor is explicit, frozen, canonical and versioned', () => {
  const d = descriptor();
  assert.equal(d.schema, 'steepy-inception-run/v2');
  assert.equal(d.revision, 1);
  assert.equal(d.nextRecord, 1);
  assert.deepEqual(Object.keys(d), ['schema', 'runId', 'revision', 'phase', 'status', 'harness', 'git', 'preapprovalExclusions', 'nextRecord', 'approvalEntry', 'approvals', 'checkpoints', 'resumeNotes', 'units', 'activeUnit', 'effects', 'cycles', 'currentCycle', 'verificationSession', 'baseline', 'blocks', 'pending', 'publications', 'completion', 'history']);
  assert.ok(Object.isFrozen(d.units));
  roundtrip(d, protocol.parseRunDescriptorV2, protocol.serializeRunDescriptorV2);
});

test('strict JSON rejects duplicate escaped keys, malformed UTF-8, extra/missing/reordered keys and versions', () => {
  const bytes = protocol.serializeRunDescriptorV2(descriptor());
  for (const bad of [bytes.replace('"revision": 1', '"revision": 1, "revis\\u0069on": 1'), Buffer.from([0xff]), '{', bytes.replace('/v2', '/v3')]) {
    assert.throws(() => protocol.parseRunDescriptorV2(bad));
  }
  for (const change of [d => { delete d.pending; }, d => { d.extra = true; }, d => { d.revision = 0; }, d => { d.nextRecord = Number.MAX_SAFE_INTEGER + 1; }, d => { d.runId = 'wrong'; }, d => { d.history = [{ at: '2026-02-30T12:00:00.000Z', from: { phase: 'research', status: 'active' }, to: { phase: 'approval', status: 'active' }, reason: 'Ready' }]; }]) {
    const d = mutable(); change(d); assert.throws(() => protocol.parseRunDescriptorV2(JSON.stringify(d)));
  }
  const { schema, ...rest } = descriptor();
  assert.throws(() => protocol.parseRunDescriptorV2(JSON.stringify({ ...rest, schema })));
  assert.throws(() => protocol.parseRunDescriptorV2(bytes, { runId: otherRun }), /runId/);
});

test('shared values reject unsafe IDs, non-exact paths, invalid digests, integers, text and commands', () => {
  for (const id of ['', 'A', '-start', 'x'.repeat(65), 'a/b']) assert.throws(() => protocol.validateId(id));
  assert.equal(protocol.validateId('x'.repeat(64)), 'x'.repeat(64));
  for (const path of ['/tmp/x', './x', '../x', 'a//b', 'a/./b', 'a/../b', 'a/', 'a\\b', 'a\n', '.', `ab/${'é'.repeat(2047)}`]) assert.throws(() => protocol.validatePath(path));
  // Names are literal, never patterns: framework route syntax is an ordinary path.
  for (const path of ['src/é file.js', 'app/[id]/page.tsx', 'app/(shop)/[...slug]/page.tsx', 'a*', 'a?', 'a{b}', 'c:d', `a/${'é'.repeat(2047)}`]) assert.equal(protocol.validatePath(path), path);
  for (const value of [{ ...ref(), bytes: -1 }, { ...ref(), sha256: 'A'.repeat(64) }, { ...ref(), path: area + 'abandoned/' + otherRun + '/snapshots/0001.json' }]) assert.throws(() => protocol.validateRef(value, { runId }));
  for (const value of [{ ...app(), mode: 0o100644 }, { ...app(), bytes: 0.5 }]) assert.throws(() => protocol.validateAppEntry(value));
  for (const value of [{ ...command(), args: ['a\0'] }, { ...command(), cwd: '../outside' }, { ...command(), successExitCodes: [] }, { ...command(), successExitCodes: [256] }, { ...command(), shell: true }]) assert.throws(() => protocol.validateCommand(value));
  for (const value of ['', 'x'.repeat(8001), 'a\r', 'a\0']) assert.throws(() => protocol.validateText(value));
  assert.equal(protocol.validateText('one\n\ttwo'), 'one\n\ttwo');
});

test('check contracts enforce type, reuse, required checks, unique IDs and coverage references', () => {
  roundtrip(contract(), protocol.parseVerificationContract, protocol.serializeVerificationContract);
  for (const change of [c => { c.checks[0].required = false; }, c => { c.checks.push(c.checks[0]); }, c => { c.coverage[0].checks = ['missing']; }, c => { c.checks[0].type = 'manual'; }, c => { c.checks[0].reuse.policy = 'reobserve'; }, c => { c.checks[0].reuse.manual = manual(); }, c => { c.roots = []; }, c => { c.exclusions[0].kind = 'anything'; }]) {
    const c = contract(); change(c); assert.throws(() => protocol.parseVerificationContract(JSON.stringify(c)));
  }
  for (const type of ['manual', 'both']) {
    const c = contract(); c.checks[0].type = type; c.checks[0].manual = manual();
    if (type === 'manual') c.checks[0].automatic = null;
    c.checks[0].reuse = { policy: 'reobserve', automatic: command(), manual: manual() };
    roundtrip(c, protocol.parseVerificationContract, protocol.serializeVerificationContract);
  }
});

const bodies = () => ({
  approval: { statement: 'Approved\nexact scope', documents: [ref('project/design.md')], contract: ref('project/verification-contract.json'), frozenDocuments: [{ sourcePath: area + 'project/design.md', artifact: ref('approvals/0002-documents/0001.bin') }] },
  snapshot: { contract: null, roots: ['.'], exclusions: [], files: [app()], git: { present: false, branch: null, head: null, status: [] } },
  checkpoint: { label: 'Ready', phase: 'bootstrap', snapshot: ref(), previous: null, unitIds: ['build'], effectIds: [] },
  cycle: { approval: ref('approvals/0001.json'), contract: ref('project/verification-contract.json'), snapshot: ref(), environment: environment(), previous: null, reason: 'Run checks' },
  'verification-session': { cycle: ref('verification/cycles/0001.json'), previous: null },
  'effect-intent': { id: 'install', kind: 'install', unitId: 'build', summary: 'Install dependencies', command: command(), procedure: null, scope: ['package-lock.json'], authorization: null, correlation: [{ name: 'operation', value: 'install-1' }], observation: { procedure: 'Inspect lockfile', expected: 'Lockfile exists', evidencePaths: ['package-lock.json'] }, before: ref() },
  'effect-outcome': { id: 'install', intent: ref('effects/0001.json'), result: 'partial', observed: 'Interrupted', correlation: [{ name: 'operation', value: 'install-1' }], evidence: [ref('research/evidence.md')], after: ref(), method: 'observed' },
  manual: { cycle: ref('verification/cycles/0001.json'), session: ref('verification/sessions/0001.json'), purpose: 'check', checks: [{ id: 'test', procedure: 'Inspect', result: 'succeeded', observed: 'Readable' }], statement: 'Confirmed', environment: environment(), before: ref(), after: ref() },
  result: { cycle: ref('verification/cycles/0001.json'), checkId: 'test', result: 'succeeded', automatic: ref('verification/captures/0001/receipt.json'), manual: null, revalidation: [], observed: 'Pass', limits: '' },
  reconciliation: { unitId: 'build', before: ref(), after: ref(), changes: [{ path: 'app.js', before: null, after: app() }], effects: [], evidence: [], reason: 'Observed change', statement: null },
  summary: { cycle: ref('verification/cycles/0001.json'), checks: [{ id: 'test', required: true, type: 'automatic', result: 'succeeded', evidence: [ref()], observed: 'Pass', limits: '' }], coverage: [{ id: 'app', component: 'Application', status: 'verified', checks: ['test'] }], limits: [] },
  completion: { approval: ref('approvals/0001.json'), contract: ref('project/verification-contract.json'), cycle: ref('verification/cycles/0001.json'), snapshot: ref(), checkpoint: ref('checkpoints/0001.json'), summary: ref('verification/summaries/0001.json'), report: ref('verification/reports/0001.md'), evidence: [] },
});

test('every immutable record kind round-trips, is closed and binds the expected run and record', () => {
  for (const [kind, body] of Object.entries(bodies())) {
    const r = record(kind, body);
    if (kind === 'effect-intent') r.unitId = 'build';
    roundtrip(r, protocol.parseInceptionRecord, protocol.serializeInceptionRecord, { runId, number: 2 });
    assert.throws(() => protocol.parseInceptionRecord(JSON.stringify(r), { runId: otherRun }), /runId/);
    assert.throws(() => protocol.parseInceptionRecord(JSON.stringify(r), { number: 3 }), /record/);
    for (const key of Object.keys(body)) {
      const bad = structuredClone(r); delete bad.body[key];
      assert.throws(() => protocol.parseInceptionRecord(JSON.stringify(bad)), kind + ':' + key);
    }
    r.body.extra = true; assert.throws(() => protocol.serializeInceptionRecord(r));
  }
  const bad = bodies().summary; bad.coverage[0].checks = ['missing'];
  assert.throws(() => protocol.serializeInceptionRecord(record('summary', bad)));
  bad.coverage[0].checks = []; assert.throws(() => protocol.serializeInceptionRecord(record('summary', bad)));
  bad.coverage[0].checks = ['test']; bad.checks[0].result = 'failed';
  assert.throws(() => protocol.serializeInceptionRecord(record('summary', bad)));
  const approval = bodies().approval; approval.frozenDocuments[0].sourcePath = 'unknown.md';
  assert.throws(() => protocol.serializeInceptionRecord(record('approval', approval)));
});

test('record bodies reject malformed nested types and unresolved provenance', () => {
  const cases = [
    ['snapshot', b => { b.files = [app('z.js'), app('a.js')]; }],
    ['snapshot', b => { b.git.head = 'not-a-hash'; }],
    ['cycle', b => { b.environment.tools[0].version = ''; }],
    ['checkpoint', b => { b.unitIds.push('build'); }],
    ['manual', b => { b.checks[0].result = 'configured'; }],
    ['manual', b => { b.purpose = 'retry'; }],
    ['result', b => { b.result = 'passed'; }],
    ['reconciliation', b => { b.changes[0].after.path = 'different.js'; }],
    ['effect-intent', b => { b.command = null; }],
    ['effect-outcome', b => { b.result = 'unknown'; }],
    ['effect-outcome', b => { b.method = 'reconciled'; b.correlation = []; }],
    ['approval', b => { b.frozenDocuments.push(b.frozenDocuments[0]); }],
    ['completion', b => { b.cycle.path = area + 'project/design.md'; }],
  ];
  for (const [kind, change] of cases) {
    const body = bodies()[kind]; change(body);
    const r = record(kind, body); if (kind === 'effect-intent') r.unitId = 'build';
    assert.throws(() => protocol.serializeInceptionRecord(r), kind);
  }
});

test('units, active writer, cycle/session references and global record numbering are validated', () => {
  const d = mutable(); d.nextRecord = 4;
  d.cycles = [ref('verification/cycles/0001.json')]; d.currentCycle = d.cycles[0];
  d.verificationSession = ref('verification/sessions/0002.json');
  d.units = [{ id: 'check', previousUnit: null, kind: 'check', phase: 'verification', inputs: [], outputs: [{ path: area + 'research/report.md', role: 'report' }], allowedPaths: ['src'], before: ref('snapshots/0003.json'), state: 'started', evidence: [], after: null, capture: null }];
  d.activeUnit = 'check';
  roundtrip(d, protocol.parseRunDescriptorV2, protocol.serializeRunDescriptorV2);
  for (const change of [v => { v.activeUnit = 'missing'; }, v => { v.units[0].previousUnit = 'check'; }, v => { v.units[0].state = 'completed'; }, v => { v.currentCycle = ref('verification/cycles/0002.json'); }, v => { v.currentCycle = null; }, v => { v.nextRecord = 1; }, v => { v.checkpoints = [ref('checkpoints/0001.json')]; }]) {
    const v = structuredClone(d); change(v); assert.throws(() => protocol.serializeRunDescriptorV2(v));
  }
});

function descriptorWithUnit() {
  const d = mutable(); d.nextRecord = 2;
  d.units = [{ id: 'research', previousUnit: null, kind: 'research', phase: 'research', inputs: [], outputs: [], allowedPaths: [], before: ref(), state: 'started', evidence: [], after: null, capture: null }];
  d.activeUnit = 'research';
  return d;
}

for (const field of ['before', 'after', 'inputs', 'evidence']) {
  test(`R1: nested unit ${field} cannot reference an unallocated record`, () => {
    const d = descriptorWithUnit(); const r = ref('snapshots/9999.json');
    d.units[0][field] = ['inputs', 'evidence'].includes(field) ? [r] : r;
    assert.throws(() => protocol.serializeRunDescriptorV2(d), /allocat|nextRecord/);
  });
}

test('R1: nested records cannot reuse a top-level cycle number', () => {
  const d = descriptorWithUnit();
  d.cycles = [ref('verification/cycles/0001.json')]; d.currentCycle = d.cycles[0];
  assert.throws(() => protocol.serializeRunDescriptorV2(d), /allocat|identity/);
});

for (const owner of ['evidence', 'block', 'publication']) {
  test(`R1: ${owner} references cannot contradict a nested record identity or digest`, () => {
    for (const r of [ref('effects/0001.json'), { ...ref(), bytes: 2 }, { ...ref(), sha256: 'b'.repeat(64) }]) {
      const d = descriptorWithUnit();
      if (owner === 'evidence') d.units[0].evidence = [r];
      if (owner === 'block') d.blocks = [{ id: 'blocked', reason: 'Observe', evidence: [r] }];
      if (owner === 'publication') d.publications = [{ id: 'published', revision: 1, targets: [r] }];
      assert.throws(() => protocol.serializeRunDescriptorV2(d), /allocat|identity|digest|bytes/);
    }
  });
}

test('R1: identical repeated refs are valid and unrelated digit-bearing paths are not allocations', () => {
  const d = descriptorWithUnit(); const same = ref();
  d.baseline = same; d.units[0].inputs = [same, { ...ref(), path: 'fixtures/snapshots/9999.json' }];
  d.units[0].after = same; d.units[0].evidence = [same, ref('research/9999.json')];
  d.blocks = [{ id: 'check', reason: 'Observe', evidence: [same] }];
  d.publications = [{ id: 'record', revision: 1, targets: [same] }];
  roundtrip(d, protocol.parseRunDescriptorV2, protocol.serializeRunDescriptorV2);
});

test('R1: reserved future targets use only the pending nextDescriptor allocation context', () => {
  const d = mutable(); const next = mutable(); next.revision = 2; next.nextRecord = 2;
  const bytes = Buffer.from('snapshot\n');
  const target = { path: area + 'snapshots/0001.json', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), contentBase64: bytes.toString('base64') };
  const r = { path: target.path, bytes: target.bytes, sha256: target.sha256 };
  next.baseline = r; next.publications = [{ id: 'snapshot', revision: 2, targets: [r] }];
  d.pending = { id: 'snapshot', baseRevision: 1, operation: 'snapshot', targets: [target], nextDescriptor: next };
  roundtrip(d, protocol.parseRunDescriptorV2, protocol.serializeRunDescriptorV2);
  const bad = structuredClone(d); bad.pending.nextDescriptor.blocks = [{ id: 'bad', reason: 'Observe', evidence: [ref('effects/0001.json')] }];
  assert.throws(() => protocol.serializeRunDescriptorV2(bad), /allocat|identity/);
});

test('current direct record references obey the global allocator', () => {
  for (const change of [d => { d.baseline = ref('snapshots/0001.json'); }, d => { d.completion = ref('verification/completions/0001.json'); }]) {
    const d = mutable(); change(d); assert.throws(() => protocol.serializeRunDescriptorV2(d));
  }
  const d = mutable(); d.nextRecord = 2; d.cycles = [ref('verification/cycles/0001.json')]; d.currentCycle = d.cycles[0];
  d.verificationSession = ref('verification/sessions/0001.json');
  assert.throws(() => protocol.serializeRunDescriptorV2(d));
});

test('completed capture history stays valid when a later cycle becomes current', () => {
  const d = mutable(); d.nextRecord = 8;
  d.cycles = [ref('verification/cycles/0002.json'), ref('verification/cycles/0006.json')];
  d.currentCycle = d.cycles[1]; d.verificationSession = ref('verification/sessions/0007.json');
  d.units = [{ id: 'old-check', previousUnit: null, kind: 'check', phase: 'verification', inputs: [], outputs: [], allowedPaths: [], before: ref(), state: 'completed', evidence: [ref('verification/captures/0004/receipt.json')], after: ref('snapshots/0005.json'), capture: {
    token: 'c'.repeat(64), pid: 123, cycle: d.cycles[0], session: ref('verification/sessions/0003.json'), checkId: 'test', purpose: 'check', command: command(), stdoutPath: area + 'verification/captures/0004/stdout.bin', stderrPath: area + 'verification/captures/0004/stderr.bin', receiptPath: area + 'verification/captures/0004/receipt.json', state: 'captured', receipt: ref('verification/captures/0004/receipt.json'),
  } }];
  roundtrip(d, protocol.parseRunDescriptorV2, protocol.serializeRunDescriptorV2);
});

test('R1: a capture allocation cannot collide with another record or exceed the counter', () => {
  const d = mutable(); d.nextRecord = 4;
  d.cycles = [ref('verification/cycles/0002.json')]; d.currentCycle = d.cycles[0];
  d.verificationSession = ref('verification/sessions/0003.json');
  d.units = [{ id: 'check', previousUnit: null, kind: 'check', phase: 'verification', inputs: [], outputs: [], allowedPaths: [], before: ref(), state: 'started', evidence: [], after: null, capture: {
    token: 'c'.repeat(64), pid: 123, cycle: d.currentCycle, session: d.verificationSession, checkId: 'test', purpose: 'check', command: command(), stdoutPath: area + 'verification/captures/0001/stdout.bin', stderrPath: area + 'verification/captures/0001/stderr.bin', receiptPath: area + 'verification/captures/0001/receipt.json', state: 'running', receipt: null,
  } }];
  d.activeUnit = 'check';
  assert.throws(() => protocol.serializeRunDescriptorV2(d), /allocat|identity/);
  for (const key of ['stdoutPath', 'stderrPath', 'receiptPath']) d.units[0].capture[key] = d.units[0].capture[key].replace('/0001/', '/9999/');
  assert.throws(() => protocol.serializeRunDescriptorV2(d), /allocat|nextRecord/);
});

test('frozen approval copies bind the source bytes as well as its path', () => {
  const r = record('approval', bodies().approval); r.body.frozenDocuments[0].artifact.bytes += 1;
  assert.throws(() => protocol.serializeInceptionRecord(r));
});

test('R2: frozen copies must use their own approval directory and canonical .bin indices', () => {
  for (const path of [
    'project/design.md', 'approvals/0001-documents/0001.bin', 'approvals/2-documents/0001.bin',
    'approvals/00002-documents/0001.bin', 'research/0001.bin', 'approvals/0002-documents/0001.json',
    'approvals/0002-documents/0.bin', 'approvals/0002-documents/0000.bin',
    'approvals/0002-documents/1.bin', 'approvals/0002-documents/00001.bin',
    'approvals/0002-documents/first.bin', 'approvals/0002-documents/0002.bin',
  ]) {
    const r = record('approval', bodies().approval); r.body.frozenDocuments[0].artifact.path = area + path;
    assert.throws(() => protocol.serializeInceptionRecord(r), /frozen|copy|approval|index/);
  }
});

test('R2: ordered distinct frozen copies round-trip and preserve source bijection', () => {
  const r = record('approval', bodies().approval);
  r.body.documents.push(ref('project/decision-register.md'));
  r.body.frozenDocuments.push({ sourcePath: area + 'project/decision-register.md', artifact: ref('approvals/0002-documents/0002.bin') });
  roundtrip(r, protocol.parseInceptionRecord, protocol.serializeInceptionRecord);
  for (const change of [
    b => { b.frozenDocuments[1].artifact.path = b.frozenDocuments[0].artifact.path; },
    b => { b.frozenDocuments.reverse(); },
    b => { b.frozenDocuments[1].sourcePath = b.frozenDocuments[0].sourcePath; },
  ]) {
    const bad = structuredClone(r); change(bad.body);
    assert.throws(() => protocol.serializeInceptionRecord(bad));
  }
});

test('capture receipts and attempts validate terminal evidence, token, PID and strict associations', () => {
  const receipt = { schema: 'steepy-inception-capture/v2', runId, cycle: ref('verification/cycles/0001.json'), session: ref('verification/sessions/0002.json'), checkId: 'test', unitId: 'check', purpose: 'check', token: 'c'.repeat(64), command: command(), startedAt: at, endedAt: at, exitCode: 1, signal: null, stdout: ref('verification/captures/0003/stdout.bin'), stderr: ref('verification/captures/0003/stderr.bin'), before: ref(), after: ref(), environment: environment() };
  roundtrip(receipt, protocol.parseCaptureReceipt, protocol.serializeCaptureReceipt, { runId });
  for (const change of [r => { r.exitCode = null; }, r => { r.token = 'short'; }, r => { r.passed = true; }, r => { r.stderr.path = area + 'verification/captures/0004/stderr.bin'; }]) {
    const r = structuredClone(receipt); change(r); assert.throws(() => protocol.serializeCaptureReceipt(r));
  }
  const attempt = { token: receipt.token, pid: 123, cycle: receipt.cycle, session: receipt.session, checkId: 'test', purpose: 'check', command: command(), stdoutPath: receipt.stdout.path, stderrPath: receipt.stderr.path, receiptPath: area + 'verification/captures/0003/receipt.json', state: 'running', receipt: null };
  protocol.validateCaptureAttempt(attempt);
  assert.throws(() => protocol.validateCaptureAttempt({ ...attempt, pid: 0 }));
  assert.throws(() => protocol.validateCaptureAttempt({ ...attempt, state: 'captured' }));
});

test('abandon formats bind exact archive, descriptor and ordered canonical children', () => {
  const archive = 'abandoned/' + runId;
  const descriptorRef = ref(archive + '/run.json');
  const intent = { schema: 'steepy-inception-abandon-intent/v2', id: 'abandon-1', runId, at, reason: 'Start over', descriptor: descriptorRef, archive, children: [{ name: 'project', kind: 'directory', device: '1', inode: '2' }, { name: 'run.json', kind: 'file', device: '1', inode: '3' }], status: 'prepared' };
  const abandonment = { schema: 'steepy-inception-abandon/v2', id: 'abandon-1', runId, at, reason: 'Start over', descriptor: descriptorRef, intent: ref(archive + '/intent.json'), archiveIdentity: { device: '1', inode: '4' }, children: ['project', 'run.json'] };
  const receipt = { schema: 'steepy-inception-abandon-receipt/v2', id: 'abandon-1', runId, intentSha256: 'd'.repeat(64), descriptor: descriptorRef, archive, completedAt: at };
  for (const value of [intent, abandonment, receipt]) {
    roundtrip(value, protocol.parseAbandonRecordV2, protocol.serializeAbandonRecordV2, { runId });
    assert.throws(() => protocol.parseAbandonRecordV2(JSON.stringify(value), { runId: otherRun }));
  }
  assert.throws(() => protocol.serializeAbandonRecordV2({ ...intent, archive: 'abandoned/' + otherRun }));
  assert.throws(() => protocol.serializeAbandonRecordV2({ ...intent, children: [...intent.children].reverse() }));
});

test('pending descriptor is nonrecursive and binds exact target bytes and next revision', () => {
  const d = mutable(); const next = mutable(); next.revision = 2;
  const bytes = Buffer.from('record\n');
  const target = { path: area + 'research/report.md', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), contentBase64: bytes.toString('base64') };
  next.publications = [{ id: 'publish-1', revision: 2, targets: [{ path: target.path, bytes: target.bytes, sha256: target.sha256 }] }];
  d.pending = { id: 'publish-1', baseRevision: 1, operation: 'record', targets: [target], nextDescriptor: next };
  roundtrip(d, protocol.parseRunDescriptorV2, protocol.serializeRunDescriptorV2);
  for (const change of [v => { v.pending.nextDescriptor.revision = 1; }, v => { v.pending.nextDescriptor.runId = otherRun; }, v => { v.pending.targets[0].contentBase64 = 'eA=='; }, v => { v.pending.nextDescriptor.pending = structuredClone(d.pending); }, v => { v.pending.nextDescriptor.publications = []; }]) {
    const v = structuredClone(d); change(v); assert.throws(() => protocol.serializeRunDescriptorV2(v));
  }
});

test('publication reservation renders immutable bytes and binds exactly one next revision', () => {
  const d = mutable();
  const next = structuredClone(d);
  const reserved = protocol.preparePublication(d, { id: 'publish-one', operation: 'publication', targets: [{ path: area + 'project/output.md', content: 'complete\n' }], nextDescriptor: next });
  assert.equal(reserved.revision, 1);
  assert.equal(reserved.pending.nextDescriptor.revision, 2);
  assert.equal(reserved.pending.targets[0].contentBase64, Buffer.from('complete\n').toString('base64'));
  assert.equal(reserved.pending.nextDescriptor.publications[0].id, 'publish-one');
  assert.equal(d.pending, null);
  assert.throws(() => protocol.preparePublication(reserved, { id: 'second', operation: 'publication', targets: [], nextDescriptor: next }), /pending/);
  assert.throws(() => protocol.preparePublication(d, { id: 'escape', operation: 'publication', targets: [{ path: 'app.js', content: 'bad' }], nextDescriptor: next }), /inception/);
});

test('manual purpose remains mandatory and separate from check procedures', () => {
  const body = { cycle: ref('verification/cycles/0001.json'), session: ref('verification/sessions/0001.json'), purpose: 'check', checks: [{ id: 'test', procedure: 'Inspect', result: 'succeeded', observed: 'Readable' }], statement: 'Confirmed', environment: environment(), before: ref(), after: ref() };
  for (const purpose of ['check', 'revalidate']) assert.equal(protocol.parseInceptionRecord(protocol.serializeInceptionRecord(record('manual', { ...body, purpose }))).body.purpose, purpose);
  const missing = { ...body }; delete missing.purpose;
  assert.throws(() => protocol.serializeInceptionRecord(record('manual', missing)), /keys/);
  assert.throws(() => protocol.serializeInceptionRecord(record('manual', { ...body, purpose: 'approve' })), /purpose/);
});

test('manual attestation input validator closes purpose and explicit check scope', () => {
  const input = { checks: [{ id: 'test', procedure: 'Inspect', result: 'succeeded', observed: 'Readable' }], statement: 'Confirmed test', environment: environment(), purpose: 'check' };
  assert.deepEqual(protocol.validateManualInput(input), input);
  for (const change of [v => { delete v.purpose; }, v => { v.checks = []; }, v => { v.checks.push(v.checks[0]); }, v => { v.passed = true; }]) { const value = structuredClone(input); change(value); assert.throws(() => protocol.validateManualInput(value)); }
});

test('capture stream refs hash exact binary bytes and refuse linked, aliased or colliding outputs', async () => {
  const fs = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'steepy-inception-stream-ref-')));
  const path = `${area}verification/captures/0001/stdout.bin`; const bytes = Buffer.alloc(256 * 1024 + 1, 0xfe);
  try {
    const fd = protocol.openPublicationOutput(root, path);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    assert.deepEqual(protocol.publicationFileRef(root, path), protocol.publicationRef(path, bytes));
    assert.throws(() => protocol.openPublicationOutput(root, path), /exist/i);
    assert.throws(() => protocol.publicationFileRef(root, path.replace('/stdout.bin', '/../0001/stdout.bin')));
    fs.linkSync(join(root, path), join(root, 'hardlink'));
    assert.throws(() => protocol.publicationFileRef(root, path), /single-link/);
    fs.unlinkSync(join(root, 'hardlink'));
    fs.symlinkSync(join(root, path), join(root, 'linked'));
    assert.throws(() => protocol.publicationFileRef(root, 'linked'), /ordinary/);
    fs.symlinkSync(join(root, area, 'verification/captures'), join(root, 'ancestor'));
    assert.throws(() => protocol.publicationFileRef(root, 'ancestor/0001/stdout.bin'), /ancestor/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verification report is derived from validated summary and keeps optional outcomes explicit', () => {
  const summary = record('summary', { cycle: ref('verification/cycles/0001.json'), checks: [{ id: 'optional', required: false, type: 'manual', result: 'not-executed', evidence: [], observed: 'No evidence', limits: 'Not checked' }], coverage: [{ id: 'future', component: '<Later feature>', status: 'future', checks: [] }], limits: ['<script> is descriptive text'] });
  const rendered = protocol.renderVerificationReport(summary);
  for (const expected of ['optional', 'not-executed', 'Not checked', 'future', '&lt;script&gt;']) assert.ok(rendered.includes(expected));
  assert.equal(rendered, protocol.renderVerificationReport(protocol.parseInceptionRecord(protocol.serializeInceptionRecord(summary))));
  assert.throws(() => protocol.renderVerificationReport({ ...summary, kind: 'result' }));
});

test('C7 archived records use reserved generation staging without widening ordinary publication targets', async () => {
  const fs = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'steepy-abandon-publication-')));
  const intent = { schema: protocol.ABANDON_INTENT_SCHEMA_V2, id: 'archive-token', runId, at, reason: 'Stop', descriptor: ref(`abandoned/${runId}/run.json`), archive: `abandoned/${runId}`, children: [{ name: 'run.json', kind: 'file', device: '1', inode: '2' }], status: 'prepared' };
  const path = `${area}${intent.archive}/intent.json`; const content = protocol.serializeAbandonRecordV2(intent);
  const pending = { id: intent.id, targets: [{ ...protocol.publicationRef(path, content), contentBase64: Buffer.from(content).toString('base64') }] };
  try {
    assert.throws(() => protocol.stagePublicationTargets(root, pending), /immutable/);
    protocol.stagePublicationTargets(root, pending, { archiveIntent: intent });
    assert.equal(fs.readFileSync(join(root, path), 'utf8'), content);
    for (const name of ['run.json', 'unowned.json', '../escape.json']) {
      const bad = { id: intent.id, targets: [{ ...pending.targets[0], path: `${area}${intent.archive}/${name}` }] };
      assert.throws(() => protocol.stagePublicationTargets(root, bad, { archiveIntent: intent }));
    }
    assert.throws(() => protocol.stagePublicationTargets(root, { ...pending, id: 'foreign' }, { archiveIntent: intent }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

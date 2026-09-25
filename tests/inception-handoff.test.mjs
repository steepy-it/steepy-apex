import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INCEPTION_HANDOFF_ROLES,
  compareCodeCheckpoints,
  finalizeInitReceipt,
  observeCodeCheckpoint,
  parseStrictJson,
  prepareInitReceipt,
  projectConfirmedInputs,
  serializeCodeCheckpoint,
  validateApprovalRecord,
  validateCodeCheckpoint,
  validateConfirmedInputs,
  validateInceptionHandoff,
  validateInitReceipt,
  validatePromotionTable,
  verifyInceptionHandoff,
} from '../scripts/inception-handoff.mjs';
import {
  createInitialInceptionState,
  inspectInceptionState,
  serializeInceptionState,
} from '../scripts/inception-state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const RUN = '0b6f1b8e-3c1a-4e2b-9f3d-5a7c9e1b2d4f';
const OTHER = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const STATE = '.apex/inception/state.json';
const run = (name, id = RUN) => `.apex/inception/${id}/${name}`;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const canRestrictAccess = process.platform !== 'win32' && process.getuid?.() !== 0;

function withTemp(suffix, fn) {
  const root = mkdtempSync(join(tmpdir(), `steepy-inception-handoff-${suffix}-`));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function put(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

// Hermetic Git: no system/global configuration, no discovery above the fixture.
function gitEnv(root) {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CEILING_DIRECTORIES: realpathSync(dirname(root)),
  };
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, env: gitEnv(root), stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
}

function assertCode(fn, code, pattern, secret) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    if (pattern) assert.match(error.message, pattern);
    if (secret) assert.doesNotMatch(error.message, secret, 'rejected names and values are never echoed');
    return true;
  });
}

function handoffValue(overrides = {}) {
  return {
    'inception-handoff': 'steepy-apex/v1',
    next: 'init',
    'run-id': RUN,
    required: {
      state: STATE,
      approval: run('approval.json'),
      project: [run('architecture.md'), run('decisions/stack.md')],
      verification: [run('checkpoint.json'), run('verification/report.md')],
      'confirmed-inputs': run('confirmed-inputs.json'),
      promotion: run('promotion.json'),
    },
    ...overrides,
  };
}

function withRequired(changes) {
  const value = handoffValue();
  value.required = { ...value.required, ...changes };
  for (const [key, entry] of Object.entries(changes)) if (entry === undefined) delete value.required[key];
  return value;
}

function confirmedInputs(overrides = {}) {
  return {
    projectName: 'demo-app',
    description: '',
    devCommands: ['npm test', 'npm run build'],
    surfaces: [
      { name: 'web', path: 'apps/web', agent: 'web-agent', testCmd: 'npm test -- --grep "`web`"' },
      { name: 'api', path: 'apps/@scope/api', agent: 'api-agent', testCmd: 'npm test' },
    ],
    domainVocabulary: {
      hasSpecializedVocabulary: true,
      entries: [{ term: 'Tenant', definition: 'An isolated customer workspace.' }],
    },
    gitPolicyDirective: '4. **Git policy:** Ask before any `git` command.',
    ...overrides,
  };
}

function promotionTable(decisions) {
  return {
    'inception-promotion': 'steepy-apex/v1',
    'run-id': RUN,
    decisions: decisions ?? [
      { id: 'arch-001', outcome: 'promote', destination: '.apex/standards/web.md', content: '- Render on the server.\n' },
      { id: 'glossary-001', outcome: 'promote', destination: '.apex/glossary.md', content: '- **Tenant:** workspace.\n' },
      { id: 'deploy-001', outcome: 'exclude', reason: 'The deploy target is local research only.' },
    ],
  };
}

test('the handoff roles are the closed inventory in their documented order', () => {
  assert.deepEqual([...INCEPTION_HANDOFF_ROLES], [
    'state', 'approval', 'project', 'verification', 'confirmed-inputs', 'promotion',
  ]);
  assert.ok(Object.isFrozen(INCEPTION_HANDOFF_ROLES));
});

test('strict JSON rejects duplicate keys at every depth, escapes included, and non-UTF-8 or BOM input', () => {
  const text = JSON.stringify(handoffValue(), null, 2);
  assert.deepEqual(parseStrictJson(Buffer.from(text), 'handoff'), handoffValue());
  for (const [label, bytes] of [
    ['top-level duplicate', text.replace('"next": "init",', '"next": "init",\n  "next": "init",')],
    ['nested duplicate', text.replace(`"state": "${STATE}",`, `"state": "${STATE}",\n    "state": "${STATE}",`)],
    ['escaped duplicate', text.replace('"next": "init",', '"next": "init",\n  "\\u006eext": "init",')],
    ['duplicate inside an array member', '{"a":[{"b":1,"b":2}]}'],
  ]) {
    assertCode(() => parseStrictJson(bytes, 'handoff'), 'INCEPTION_HANDOFF_INVALID', /duplicate key/, /\bb\b|\\u006e/);
  }
  assert.deepEqual(parseStrictJson('{"a":{"b":1},"c":{"b":2},"d":["b","b"]}', 'x'), { a: { b: 1 }, c: { b: 2 }, d: ['b', 'b'] });
  assertCode(() => parseStrictJson(`\uFEFF${text}`, 'handoff'), 'INCEPTION_HANDOFF_INVALID', /byte order mark/);
  assertCode(() => parseStrictJson(Buffer.from([0x7b, 0xff, 0x7d]), 'handoff'), 'INCEPTION_HANDOFF_INVALID', /UTF-8/);
  assertCode(() => parseStrictJson('{', 'handoff'), 'INCEPTION_HANDOFF_INVALID', /not valid JSON/);
});

test('the inception handoff envelope is closed: identifier, version, next, run, roles, and exact run paths', () => {
  const valid = validateInceptionHandoff(handoffValue());
  assert.deepEqual(valid, {
    runId: RUN,
    required: {
      state: STATE,
      approval: run('approval.json'),
      project: [run('architecture.md'), run('decisions/stack.md')],
      verification: [run('checkpoint.json'), run('verification/report.md')],
      'confirmed-inputs': run('confirmed-inputs.json'),
      promotion: run('promotion.json'),
    },
  });
  assert.ok(Object.isFrozen(valid.required.project));
  assert.ok(Object.isFrozen(valid.required.verification));

  const secret = /sk-live-secret|apiToken|research/;
  const invalid = [
    ['chain envelope identifier', (() => { const { 'inception-handoff': _, ...rest } = handoffValue(); return { handoff: 'steepy-apex/v1', ...rest }; })(), /unsupported field|fields/],
    ['unknown version', handoffValue({ 'inception-handoff': 'steepy-apex/v2' }), /version/],
    ['wrong next', handoffValue({ next: 'plan' }), /next/],
    ['uppercase run', handoffValue({ 'run-id': RUN.toUpperCase() }), /run-id/],
    ['extra top-level field', handoffValue({ apiToken: 'sk-live-secret' }), /unsupported field/],
    ['onDemand map', handoffValue({ onDemand: { research: run('research.md') } }), /unsupported field/],
    ['unknown role', withRequired({ research: run('research.md') }), /unsupported field/],
    ['missing role', withRequired({ promotion: undefined }), /incomplete/],
    ['required not a map', handoffValue({ required: [STATE] }), /required/],
    ['state elsewhere', withRequired({ state: run('state.json') }), /state/],
    ['approval of another run', withRequired({ approval: run('approval.json', OTHER) }), /approval/],
    ['approval as a run directory', withRequired({ approval: `.apex/inception/${RUN}` }), /approval/],
    ['approval outside inception', withRequired({ approval: '.apex/work/specs/demo.md' }), /approval/],
    ['approval not a string', withRequired({ approval: 7 }), /approval/],
    ['project single path', withRequired({ project: run('architecture.md') }), /project/],
    ['project empty', withRequired({ project: [] }), /project/],
    ['project glob', withRequired({ project: [run('*.md')] }), /project/],
    ['project parent segment', withRequired({ project: [`.apex/inception/${RUN}/../x.md`] }), /project/],
    ['project case duplicate', withRequired({ project: [run('architecture.md'), run('Architecture.md')] }), /more than once/],
    ['role reuse', withRequired({ promotion: run('approval.json') }), /more than once/],
    ['project reuses a role', withRequired({ project: [run('architecture.md'), run('checkpoint.json')] }), /more than once/],
    ['verification single path', withRequired({ verification: run('checkpoint.json') }), /verification/],
    ['verification without results', withRequired({ verification: [run('checkpoint.json')] }), /verification/],
    ['verification glob', withRequired({ verification: [run('checkpoint.json'), run('verification/*.md')] }), /verification/],
    ['verification directory', withRequired({ verification: [run('checkpoint.json'), `.apex/inception/${RUN}`] }), /verification/],
    ['verification duplicate', withRequired({ verification: [run('checkpoint.json'), run('Checkpoint.json')] }), /more than once/],
    ['verification reuses project', withRequired({ verification: [run('checkpoint.json'), run('architecture.md')] }), /more than once/],
  ];
  for (const [label, value, pattern] of invalid) {
    assert.throws(() => validateInceptionHandoff(value), (error) => {
      assert.equal(error.code, 'INCEPTION_HANDOFF_INVALID', `${label}: ${error.message}`);
      assert.match(error.message, pattern, label);
      assert.doesNotMatch(error.message, secret, `${label}: rejected names and values are never echoed`);
      return true;
    }, label);
  }
  for (const value of [null, [], 'handoff']) {
    assertCode(() => validateInceptionHandoff(value), 'INCEPTION_HANDOFF_INVALID', /object/);
  }
});

test('the approval record binds the approved project documents to exact digests of the same run', () => {
  const record = {
    'inception-approval': 'steepy-apex/v1',
    'run-id': RUN,
    project: [
      { path: run('architecture.md'), sha256: sha('architecture') },
      { path: run('decisions/stack.md'), sha256: sha('stack') },
    ],
  };
  assert.deepEqual(validateApprovalRecord(record, { runId: RUN }), { runId: RUN, project: record.project });
  for (const [label, value, pattern] of [
    ['version', { ...record, 'inception-approval': 'steepy-apex/v9' }, /version/],
    ['other run', { ...record, 'run-id': OTHER }, /run/],
    ['extra field', { ...record, approvedBy: 'me' }, /unsupported field/],
    ['empty project', { ...record, project: [] }, /project/],
    ['uppercase digest', { ...record, project: [{ path: run('architecture.md'), sha256: sha('a').toUpperCase() }] }, /sha256/],
    ['reference extra key', { ...record, project: [{ path: run('architecture.md'), sha256: sha('a'), note: 'x' }] }, /unsupported field/],
    ['foreign path', { ...record, project: [{ path: run('architecture.md', OTHER), sha256: sha('a') }] }, /path/],
    ['duplicate path', { ...record, project: [record.project[0], { ...record.project[0], sha256: sha('b') }] }, /more than once/],
  ]) {
    assertCode(() => validateApprovalRecord(value, { runId: RUN }), 'INCEPTION_HANDOFF_INVALID', pattern, /approvedBy|note/);
  }
});

test('the code checkpoint is an explicit sorted inventory of repository paths with digests and optional Git revision', () => {
  const record = {
    'inception-checkpoint': 'steepy-apex/v1',
    'run-id': RUN,
    git: { branch: 'main', head: 'a'.repeat(40) },
    files: [
      { path: 'app/[slug]/page.tsx', sha256: sha('page') },
      { path: 'package-lock.json', sha256: null },
      { path: 'package.json', sha256: sha('manifest') },
    ],
  };
  assert.deepEqual(validateCodeCheckpoint(record, { runId: RUN }), { runId: RUN, git: record.git, files: record.files });
  assert.deepEqual(validateCodeCheckpoint({ ...record, git: null }, { runId: RUN }).git, null);
  assert.deepEqual(validateCodeCheckpoint({ ...record, git: { branch: null, head: null } }, { runId: RUN }).git, { branch: null, head: null });
  const file = (path) => ({ ...record, files: [{ path, sha256: sha('x') }] });
  for (const [label, value, pattern] of [
    ['version', { ...record, 'inception-checkpoint': 'v1' }, /version/],
    ['other run', { ...record, 'run-id': OTHER }, /run/],
    ['empty inventory', { ...record, files: [] }, /files/],
    ['unsorted', { ...record, files: [...record.files].reverse() }, /sorted/],
    ['duplicate', { ...record, files: [record.files[0], record.files[0]] }, /sorted/],
    ['short head', { ...record, git: { branch: 'main', head: 'abc' } }, /head/],
    ['empty branch', { ...record, git: { branch: '', head: null } }, /branch/],
    ['git extra key', { ...record, git: { branch: 'main', head: null, dirty: true } }, /unsupported field/],
    ['absolute', file('/etc/passwd'), /path/],
    ['parent', file('src/../package.json'), /path/],
    ['backslash', file('src\\index.js'), /path/],
    ['control', file('src/in\ndex.js'), /path/],
    ['glob', file('src/*.js'), /path/],
    ['work area', file('.apex/work/specs/x.md'), /local area/],
    ['inception case alias', file('.APEX/Inception/state.json'), /local area/],
    ['git internals', file('.git/HEAD'), /\.git/],
  ]) {
    assertCode(() => validateCodeCheckpoint(value, { runId: RUN }), 'INCEPTION_HANDOFF_INVALID', pattern);
  }
});

test('the init skill example record validates and projects to exactly its documented planner projection', () => {
  const skill = readFileSync(join(here, '..', 'skills', 'init', 'SKILL.md'), 'utf8');
  const blocks = [...skill.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
  const [record, planner] = blocks;
  assert.deepEqual(Object.keys(record), [
    'projectName', 'description', 'devCommands', 'surfaces', 'domainVocabulary', 'gitPolicyDirective',
  ]);
  assert.deepEqual(validateConfirmedInputs(record), record);
  assert.deepEqual(projectConfirmedInputs(record), planner);
});

test('confirmed inputs keep all six authoritative fields and project exactly five Project v1 keys', () => {
  const record = confirmedInputs();
  const before = clone(record);
  const valid = validateConfirmedInputs(record);
  assert.deepEqual(valid, record, 'empty description, every command, surface order, testCmd, vocabulary, and git policy survive');
  assert.ok(Object.isFrozen(valid.surfaces[0]));

  const projection = projectConfirmedInputs(record, { resolutions: { 'conflict-1': 'keep' } });
  assert.deepEqual(Object.keys(projection), ['projectName', 'description', 'devCommands', 'surfaces', 'resolutions']);
  assert.deepEqual(projection, {
    projectName: 'demo-app',
    description: '',
    devCommands: ['npm test', 'npm run build'],
    surfaces: record.surfaces,
    resolutions: { 'conflict-1': 'keep' },
  });
  assert.doesNotMatch(JSON.stringify(projection), /domainVocabulary|gitPolicyDirective|Tenant/);
  assert.deepEqual(record, before, 'resolutions are a separate projection and never mutate the record');
  assert.deepEqual(projectConfirmedInputs(record).resolutions, {});

  assert.deepEqual(validateConfirmedInputs(confirmedInputs({
    devCommands: [],
    domainVocabulary: { hasSpecializedVocabulary: false, entries: [] },
    gitPolicyDirective: '',
  })).gitPolicyDirective, '');

  // No rule is stricter than the init skill's record: multi-line texts and
  // repeated terms that init would accept survive verbatim.
  const initAccepted = confirmedInputs({
    domainVocabulary: {
      hasSpecializedVocabulary: true,
      entries: [{ term: 'Tenant', definition: 'A workspace.\nIsolated per customer.' }, { term: 'Tenant', definition: 'Also a billing unit.' }],
    },
    gitPolicyDirective: '4. **Git policy:** Ask before any `git` command.\nNever force-push.',
  });
  assert.deepEqual(validateConfirmedInputs(initAccepted), initAccepted);

  const { gitPolicyDirective: _, ...fiveKeys } = confirmedInputs();
  for (const [label, value, pattern] of [
    ['missing field', fiveKeys, /incomplete/],
    ['planner projection as record', { ...fiveKeys, resolutions: {} }, /unsupported field/],
    ['empty surfaces', confirmedInputs({ surfaces: [] }), /surfaces/],
    ['backtick command', confirmedInputs({ devCommands: ['run `x`'] }), /devCommands/],
    ['unsafe surface path', confirmedInputs({ surfaces: [{ name: 'web', path: '../web', agent: 'web-agent', testCmd: 'npm test' }] }), /path/],
    ['vocabulary contradiction', confirmedInputs({ domainVocabulary: { hasSpecializedVocabulary: false, entries: [{ term: 'A', definition: 'B' }] } }), /entries/],
    ['vocabulary without entries', confirmedInputs({ domainVocabulary: { hasSpecializedVocabulary: true, entries: [] } }), /entries/],
    ['vocabulary not boolean', confirmedInputs({ domainVocabulary: { hasSpecializedVocabulary: 'yes', entries: [] } }), /hasSpecializedVocabulary/],
    ['entry extra key', confirmedInputs({ domainVocabulary: { hasSpecializedVocabulary: true, entries: [{ term: 'A', definition: 'B', note: 'x' }] } }), /unsupported field/],
    ['control character in a definition', confirmedInputs({ domainVocabulary: { hasSpecializedVocabulary: true, entries: [{ term: 'Secret-Term', definition: 'B\u0000C' }] } }), /definition/],
    ['blank term', confirmedInputs({ domainVocabulary: { hasSpecializedVocabulary: true, entries: [{ term: ' ', definition: 'B' }] } }), /term/],
    ['git policy without directive prefix', confirmedInputs({ gitPolicyDirective: 'Ask first.' }), /gitPolicyDirective/],
    ['git policy prefix without text', confirmedInputs({ gitPolicyDirective: '4. **Git policy:** ' }), /gitPolicyDirective/],
  ]) {
    assertCode(() => validateConfirmedInputs(value), 'INCEPTION_HANDOFF_INVALID', pattern, /Secret-Term/);
  }
  assertCode(() => projectConfirmedInputs(record, { resolutions: { id: 'a\nb' } }), 'INCEPTION_HANDOFF_INVALID', /resolutions/);
  assertCode(() => projectConfirmedInputs(record, { resolutions: ['keep'] }), 'INCEPTION_HANDOFF_INVALID', /resolutions/);
});

test('the promotion table gives every decision an ID and either a stable destination with text or a motivated exclusion', () => {
  const table = promotionTable();
  assert.deepEqual(validatePromotionTable(table, { runId: RUN }), { runId: RUN, decisions: table.decisions });
  const promote = (changes) => promotionTable([{ id: 'd-1', outcome: 'promote', destination: '.apex/glossary.md', content: 'text\n', ...changes }]);
  for (const [label, value, pattern] of [
    ['version', { ...table, 'inception-promotion': 'steepy-apex/v2' }, /version/],
    ['other run', { ...table, 'run-id': OTHER }, /run/],
    ['no decisions', promotionTable([]), /decisions/],
    ['duplicate id', promotionTable([table.decisions[0], { ...table.decisions[0], destination: '.apex/conventions.md' }]), /more than once/],
    ['bad id', promote({ id: 'has space' }), /id/],
    ['unknown outcome', promote({ outcome: 'defer' }), /outcome/],
    ['promote without text', (() => { const value = promote(); delete value.decisions[0].content; return value; })(), /incomplete/],
    ['blank text', promote({ content: ' \n\t' }), /content/],
    ['control text', promote({ content: 'a\u0000b' }), /content/],
    ['exclusion with destination', promotionTable([{ id: 'd-1', outcome: 'exclude', reason: 'why', destination: '.apex/glossary.md' }]), /unsupported field/],
    ['exclusion without reason', promotionTable([{ id: 'd-1', outcome: 'exclude', reason: '  ' }]), /reason/],
    ['work destination', promote({ destination: '.apex/work/specs/demo.md' }), /local area/],
    ['inception destination', promote({ destination: `.apex/inception/${RUN}/notes.md` }), /local area/],
    ['case-aliased local destination', promote({ destination: '.Apex/WORK/notes.md' }), /local area/],
    ['git destination', promote({ destination: '.git/info/exclude' }), /\.git/],
    ['absolute destination', promote({ destination: '/tmp/x.md' }), /destination/],
    ['traversal destination', promote({ destination: 'docs/../../x.md' }), /destination/],
    ['glob destination', promote({ destination: 'docs/*.md' }), /destination/],
  ]) {
    assertCode(() => validatePromotionTable(value, { runId: RUN }), 'INCEPTION_HANDOFF_INVALID', pattern);
  }
});

test('the code checkpoint observes exact bytes of an explicit inventory, records absence, and reads nothing else', () => withTemp('observe', (root) => {
  put(root, 'package.json', '{"name":"demo"}\n');
  put(root, 'src/index.js', 'export {};\n');
  put(root, 'src/unlisted.js', 'UNLISTED_SENTINEL\n');
  const inventory = ['src/index.js', 'package.json', 'package-lock.json', 'package.json'];
  const observe = () => observeCodeCheckpoint(root, { runId: RUN, paths: inventory, env: gitEnv(root) });
  const expected = {
    'inception-checkpoint': 'steepy-apex/v1',
    'run-id': RUN,
    git: null,
    files: [
      { path: 'package-lock.json', sha256: null },
      { path: 'package.json', sha256: sha('{"name":"demo"}\n') },
      { path: 'src/index.js', sha256: sha('export {};\n') },
    ],
  };
  assert.deepEqual(observe(), expected, 'sorted, deduplicated, absent paths recorded as null, no Git claimed');
  assert.deepEqual(validateCodeCheckpoint(observe(), { runId: RUN }).files, expected.files);
  assert.equal(serializeCodeCheckpoint(observe()), `${JSON.stringify(expected, null, 2)}\n`);

  if (canRestrictAccess) {
    // Exact names stay reachable; listing the directory or opening an
    // unlisted file would fail, so success proves neither happened.
    chmodSync(join(root, 'src/unlisted.js'), 0o000);
    chmodSync(join(root, 'src'), 0o311);
    try {
      assert.deepEqual(observe(), expected);
    } finally {
      chmodSync(join(root, 'src'), 0o755);
      chmodSync(join(root, 'src/unlisted.js'), 0o644);
    }
  }

  git(root, 'init', '-q');
  git(root, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
  assert.deepEqual(observe().git, { branch: 'trunk', head: null }, 'an unborn repository has no baseline commit');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.test');
  git(root, 'add', 'package.json');
  git(root, 'commit', '-qm', 'baseline');
  assert.deepEqual(observe().git, { branch: 'trunk', head: git(root, 'rev-parse', 'HEAD').trim() });

  assertCode(() => observeCodeCheckpoint(root, { runId: RUN, paths: [], env: gitEnv(root) }), 'INCEPTION_HANDOFF_ARGUMENT', /paths/);
  assertCode(() => observeCodeCheckpoint(root, { runId: 'nope', paths: ['package.json'] }), 'INCEPTION_HANDOFF_ARGUMENT', /runId/);
  assertCode(() => observeCodeCheckpoint(root, { runId: RUN, paths: ['.apex/work/specs/x.md'] }), 'INCEPTION_HANDOFF_INVALID', /local area/);
}));

test('the code checkpoint refuses links, non-files, and hard links instead of hashing aliased bytes', () => withTemp('observe-unsafe', (root) => {
  put(root, 'src/index.js', 'export {};\n');
  symlinkSync('src/index.js', join(root, 'link.js'));
  symlinkSync('src', join(root, 'lib'));
  linkSync(join(root, 'src/index.js'), join(root, 'copy.js'));
  mkdirSync(join(root, 'dir.js'));
  const fifo = spawnSync('mkfifo', [join(root, 'pipe.js')], { encoding: 'utf8' });
  assert.equal(fifo.status, 0, fifo.stderr);
  for (const [path, pattern] of [
    ['link.js', /symlink/],
    ['lib/index.js', /symlinked component/],
    ['copy.js', /hard-linked/],
    ['dir.js', /non-file/],
    ['pipe.js', /non-file/],
  ]) {
    assertCode(() => observeCodeCheckpoint(root, { runId: RUN, paths: [path] }), 'INCEPTION_HANDOFF_UNSAFE', pattern);
  }
  const external = mkdtempSync(join(tmpdir(), 'steepy-inception-handoff-root-'));
  try {
    symlinkSync(root, join(external, 'mounted-root'));
    assertCode(() => observeCodeCheckpoint(join(external, 'mounted-root'), { runId: RUN, paths: ['src/index.js'] }),
      'INCEPTION_HANDOFF_UNSAFE', /repository root/);
  } finally {
    rmSync(external, { recursive: true, force: true });
  }
}));

test('checkpoint comparison reports changed, added, and removed paths and a moved Git revision', () => {
  const record = (git, files) => ({ 'inception-checkpoint': 'steepy-apex/v1', 'run-id': RUN, git, files });
  const at = (head) => ({ branch: 'trunk', head: head.repeat(40) });
  const recorded = record(at('a'), [
    { path: 'a.js', sha256: sha('a') },
    { path: 'b.lock', sha256: null },
    { path: 'c.js', sha256: sha('c') },
    { path: 'd.json', sha256: sha('d') },
  ]);
  const observed = record(at('b'), [
    { path: 'a.js', sha256: sha('a') },
    { path: 'b.lock', sha256: sha('b') },
    { path: 'c.js', sha256: null },
    { path: 'd.json', sha256: sha('d2') },
    { path: 'e.js', sha256: sha('e') },
    { path: 'f.js', sha256: null },
  ]);
  assert.deepEqual(compareCodeCheckpoints(recorded, observed), {
    diverged: true,
    changed: ['d.json'],
    added: ['b.lock', 'e.js'],
    removed: ['c.js'],
    git: { changed: true, recorded: at('a'), observed: at('b') },
  });
  assert.deepEqual(compareCodeCheckpoints(recorded, recorded), {
    diverged: false, changed: [], added: [], removed: [], git: { changed: false, recorded: at('a'), observed: at('a') },
  });
  const files = recorded.files;
  assert.equal(compareCodeCheckpoints(record(null, files), record(null, files)).diverged, false, 'a run without Git stays supported');
  assert.equal(compareCodeCheckpoints(record(null, files), record(at('a'), files)).git.changed, true);
  assert.equal(compareCodeCheckpoints(record(at('a'), files), record({ branch: 'other', head: 'a'.repeat(40) }, files)).diverged, true);
  assertCode(() => compareCodeCheckpoints(recorded, record(at('a'), files.slice(1))), 'INCEPTION_HANDOFF_ARGUMENT', /every recorded path/);
  assertCode(() => compareCodeCheckpoints(recorded, { ...observed, 'run-id': OTHER }), 'INCEPTION_HANDOFF_INVALID', /run/);
});

const HANDOFF = run('handoff.json');
const PROJECT_DOCS = [[run('architecture.md'), '# Architecture\n'], [run('decisions/stack.md'), '# Stack\n']];
const CODE_PATHS = ['package-lock.json', 'package.json', 'src/index.js'];
const VERIFICATION_REPORT = run('verification/report.md');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function approvalRecord(project = PROJECT_DOCS.map(([path, text]) => ({ path, sha256: sha(text) }))) {
  return { 'inception-approval': 'steepy-apex/v1', 'run-id': RUN, project };
}

function writeState(root, overrides = {}) {
  const base = createInitialInceptionState(RUN);
  put(root, STATE, serializeInceptionState({
    ...base,
    phase: 'init',
    approval: { path: run('approval.json'), sha256: sha(readFileSync(join(root, run('approval.json')))) },
    checkpoint: { path: run('checkpoint.json'), sha256: sha(readFileSync(join(root, run('checkpoint.json')))) },
    ...overrides,
  }));
}

// A complete, approved, verified inception run ready for the init transfer.
function seedRun(root) {
  put(root, 'package.json', '{"name":"demo-app"}\n');
  put(root, 'src/index.js', 'export const ok = true;\n');
  put(root, '.apex/inception/.gitignore', '*\n');
  for (const [path, text] of PROJECT_DOCS) put(root, path, text);
  put(root, run('approval.json'), json(approvalRecord()));
  put(root, run('checkpoint.json'), serializeCodeCheckpoint(observeCodeCheckpoint(root, { runId: RUN, paths: CODE_PATHS, env: gitEnv(root) })));
  put(root, VERIFICATION_REPORT, '# Verification\n\n- npm test: pass\n');
  put(root, run('confirmed-inputs.json'), json(confirmedInputs()));
  put(root, run('promotion.json'), json(promotionTable()));
  put(root, HANDOFF, json(handoffValue()));
  writeState(root);
}

const verify = (root, options = {}) => verifyInceptionHandoff(root, { handoff: HANDOFF, env: gitEnv(root), ...options });

test('a valid handoff verifies every exact input, binds approval and checkpoint, and reads nothing unnamed', () => withTemp('verify', (root) => {
  seedRun(root);
  const file = (path) => sha(readFileSync(join(root, path)));
  const expectedInputs = [
    { role: 'approval', path: run('approval.json'), sha256: file(run('approval.json')) },
    ...PROJECT_DOCS.map(([path, text]) => ({ role: 'project', path, sha256: sha(text) })),
    { role: 'verification', path: run('checkpoint.json'), sha256: file(run('checkpoint.json')) },
    { role: 'verification', path: VERIFICATION_REPORT, sha256: file(VERIFICATION_REPORT) },
    { role: 'confirmed-inputs', path: run('confirmed-inputs.json'), sha256: file(run('confirmed-inputs.json')) },
    { role: 'promotion', path: run('promotion.json'), sha256: file(run('promotion.json')) },
  ];
  const check = (report) => {
    assert.equal(report.status, 'verified');
    assert.equal(report.runId, RUN);
    assert.deepEqual(report.handoff, { path: HANDOFF, sha256: file(HANDOFF) });
    assert.deepEqual(report.state, { sha256: file(STATE), phase: 'init', status: 'active', init: 'not-started' });
    assert.deepEqual(report.inputs, expectedInputs);
    assert.deepEqual(report.confirmedInputs, confirmedInputs());
    assert.deepEqual(report.promotion.decisions, promotionTable().decisions);
    assert.equal(report.checkpoint.diverged, false);
  };
  check(verify(root));

  put(root, run('research/notes.md'), 'UNNAMED_RESEARCH_SENTINEL\n');
  if (canRestrictAccess) {
    // Exact names stay reachable while the run directory cannot be listed and
    // the unnamed research file cannot be opened.
    chmodSync(join(root, run('research/notes.md')), 0o000);
    chmodSync(join(root, `.apex/inception/${RUN}`), 0o311);
    try {
      check(verify(root));
    } finally {
      chmodSync(join(root, `.apex/inception/${RUN}`), 0o755);
      chmodSync(join(root, run('research/notes.md')), 0o644);
    }
  }
}));

test('code divergence from the verified checkpoint is reported, never silently accepted', () => withTemp('verify-diverged', (root) => {
  seedRun(root);
  put(root, 'src/index.js', 'export const ok = false;\n');
  put(root, 'package-lock.json', '{}\n');
  put(root, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
  const report = verify(root, { paths: ['pnpm-lock.yaml'] });
  assert.equal(report.status, 'diverged');
  assert.deepEqual(report.checkpoint, {
    diverged: true,
    changed: ['src/index.js'],
    added: ['package-lock.json', 'pnpm-lock.yaml'],
    removed: [],
    git: { changed: false, recorded: null, observed: null },
  });
  rmSync(join(root, 'package.json'));
  assert.deepEqual(verify(root).checkpoint.removed, ['package.json']);
  git(root, 'init', '-q');
  assert.equal(verify(root).checkpoint.git.changed, true, 'Git appearing after the checkpoint is a divergence');
}));

test('the handoff is refused when its inputs, run, approval, or checkpoint do not bind', () => {
  const cases = [
    ['approval bytes changed after approval', (root) => put(root, run('approval.json'), json({ ...approvalRecord(), project: approvalRecord().project.slice(0, 1) })),
      'INCEPTION_HANDOFF_BINDING', /approval refers to other bytes/],
    ['project document changed after approval', (root) => put(root, PROJECT_DOCS[0][0], '# Architecture, reworked\n'),
      'INCEPTION_HANDOFF_BINDING', /differs from its approved bytes/],
    ['unapproved project document', (root) => {
      put(root, run('extra.md'), '# Extra\n');
      put(root, HANDOFF, json(withRequired({ project: [...handoffValue().required.project, run('extra.md')] })));
    }, 'INCEPTION_HANDOFF_BINDING', /approved project documents/],
    ['approved document omitted', (root) => put(root, HANDOFF, json(withRequired({ project: [PROJECT_DOCS[0][0]] }))),
      'INCEPTION_HANDOFF_BINDING', /approved project documents/],
    ['approval path not recorded', (root) => {
      put(root, run('approval-2.json'), readFileSync(join(root, run('approval.json'))));
      put(root, HANDOFF, json(withRequired({ approval: run('approval-2.json') })));
    }, 'INCEPTION_HANDOFF_BINDING', /approval/],
    ['verification is not the recorded checkpoint', (root) => {
      put(root, run('checkpoint-2.json'), readFileSync(join(root, run('checkpoint.json'))));
      put(root, HANDOFF, json(withRequired({ verification: [run('checkpoint-2.json'), VERIFICATION_REPORT] })));
    }, 'INCEPTION_HANDOFF_BINDING', /verification/],
    ['missing verification report', (root) => rmSync(join(root, VERIFICATION_REPORT)), 'INCEPTION_MISSING', /report\.md/],
    ['promotion destination in the checkpoint inventory', (root) => put(root, run('promotion.json'), json(promotionTable([
      ...promotionTable().decisions, { id: 'manifest-001', outcome: 'promote', destination: 'package.json', content: '"private": true' },
    ]))), 'INCEPTION_HANDOFF_BINDING', /checkpoint inventory/],
    ['case alias of a checkpoint path as destination', (root) => put(root, run('promotion.json'), json(promotionTable([
      ...promotionTable().decisions, { id: 'manifest-001', outcome: 'promote', destination: 'Package.json', content: '"private": true' },
    ]))), 'INCEPTION_HANDOFF_BINDING', /checkpoint inventory/],
    ['no recorded checkpoint', (root) => writeState(root, { checkpoint: null }), 'INCEPTION_HANDOFF_BINDING', /checkpoint/],
    ['checkpoint of another run', (root) => {
      const recorded = JSON.parse(readFileSync(join(root, run('checkpoint.json')), 'utf8'));
      put(root, run('checkpoint.json'), serializeCodeCheckpoint({ ...recorded, 'run-id': OTHER }));
      writeState(root);
    }, 'INCEPTION_HANDOFF_INVALID', new RegExp(`checkpoint run-id must be the handoff run ${RUN}`)],
    ['checkpoint bytes not canonical', (root) => {
      put(root, run('checkpoint.json'), JSON.stringify(JSON.parse(readFileSync(join(root, run('checkpoint.json')), 'utf8'))));
      writeState(root);
    }, 'INCEPTION_HANDOFF_INVALID', /canonical/],
    ['state of another run', (root) => put(root, STATE, serializeInceptionState({ ...createInitialInceptionState(OTHER) })),
      'INCEPTION_HANDOFF_BINDING', /different run/],
    ['state before init', (root) => writeState(root, { phase: 'verification' }), 'INCEPTION_HANDOFF_BINDING', /phase/],
    ['state pins another handoff', (root) => writeState(root, { init: { status: 'not-started', handoff: { path: HANDOFF, sha256: sha('other') }, receipt: null } }),
      'INCEPTION_HANDOFF_BINDING', /handoff/],
    ['no inception state', (root) => rmSync(join(root, STATE)), 'INCEPTION_HANDOFF_BINDING', /state/],
    ['handoff names another run', (root) => put(root, HANDOFF, json({ ...handoffValue(), 'run-id': OTHER })),
      'INCEPTION_HANDOFF_INVALID', /run/],
    ['handoff with a duplicate key', (root) => put(root, HANDOFF, json(handoffValue()).replace('"next": "init",', '"next": "init",\n  "next": "init",')),
      'INCEPTION_HANDOFF_INVALID', /duplicate key/],
    ['handoff reused as an input', (root) => put(root, HANDOFF, json(withRequired({ promotion: HANDOFF }))),
      'INCEPTION_HANDOFF_INVALID', /more than once/],
    ['missing promotion input', (root) => rmSync(join(root, run('promotion.json'))), 'INCEPTION_MISSING', /promotion\.json/],
    ['promotion of another run', (root) => put(root, run('promotion.json'), json({ ...promotionTable(), 'run-id': OTHER })),
      'INCEPTION_HANDOFF_INVALID', /run/],
    ['invalid confirmed inputs', (root) => put(root, run('confirmed-inputs.json'), json(confirmedInputs({ surfaces: [] }))),
      'INCEPTION_HANDOFF_INVALID', /surfaces/],
  ];
  for (const [label, arrange, code, pattern] of cases) {
    withTemp('verify-refused', (root) => {
      seedRun(root);
      arrange(root);
      assert.throws(() => verify(root), (error) => {
        assert.equal(error.code, code, `${label}: ${error.message}`);
        assert.match(error.message, pattern, label);
        return true;
      }, label);
    });
  }
  withTemp('verify-path', (root) => {
    seedRun(root);
    for (const handoff of ['.apex/work/handoff.json', `.apex/inception/${RUN}`, STATE, undefined]) {
      assertCode(() => verifyInceptionHandoff(root, { handoff }), 'INCEPTION_HANDOFF_INVALID', /handoff/);
    }
    assertCode(() => verifyInceptionHandoff(root, { handoff: run('handoff.json', OTHER) }), 'INCEPTION_HANDOFF_BINDING', /different run/);
  });
});

const RECEIPT = run('init-receipt.json');
const GLOSSARY = '# Glossary\n\nHuman-written glossary text.\n';
const WEB_TEXT = '- Render on the server.\n';
const TERM_TEXT = '- **Tenant:** workspace.\n';
const prepare = (root, options = {}) => prepareInitReceipt(root, { handoff: HANDOFF, receipt: RECEIPT, env: gitEnv(root), ...options });
const finalize = (root, options = {}) => finalizeInitReceipt(root, { handoff: HANDOFF, receipt: RECEIPT, gate: 'pass', env: gitEnv(root), ...options });
const digestOf = (root, path) => sha(readFileSync(join(root, path)));

// What the init skill does between prepare and finalize: it writes the
// promoted texts without overwriting human text.
function promote(root) {
  put(root, '.apex/standards/web.md', `# web — Technical Standard\n\n${WEB_TEXT}`);
  put(root, '.apex/glossary.md', `${GLOSSARY}${TERM_TEXT}`);
}

function snapshot(root, paths) {
  return paths.map((path) => {
    if (!existsSync(join(root, path))) return [path, null];
    const stat = lstatSync(join(root, path), { bigint: true });
    return [path, readFileSync(join(root, path)).toString('base64'), stat.mtimeNs, stat.ino];
  });
}

function receiptValue(overrides = {}) {
  return {
    'inception-receipt': 'steepy-apex/v1',
    'run-id': RUN,
    status: 'in-progress',
    handoff: { path: HANDOFF, sha256: sha('handoff') },
    inputs: [
      { role: 'approval', path: run('approval.json'), sha256: sha('approval') },
      { role: 'project', path: run('architecture.md'), sha256: sha('architecture') },
      { role: 'verification', path: run('checkpoint.json'), sha256: sha('checkpoint') },
      { role: 'verification', path: run('verification/report.md'), sha256: sha('report') },
      { role: 'confirmed-inputs', path: run('confirmed-inputs.json'), sha256: sha('inputs') },
      { role: 'promotion', path: run('promotion.json'), sha256: sha('promotion') },
    ],
    decisions: [
      { id: 'arch-001', outcome: 'pending', destination: '.apex/standards/web.md', sha256: sha(WEB_TEXT) },
      { id: 'deploy-001', outcome: 'excluded', reason: 'Local research only.' },
    ],
    writes: [{ path: '.apex/standards/web.md', previous: null, observed: null }],
    gate: 'not-run',
    ...overrides,
  };
}

test('the receipt schema closes run, inputs, decision outcomes, write checkpoints, and gate', () => {
  const pending = receiptValue();
  assert.equal(validateInitReceipt(pending, { runId: RUN }).status, 'in-progress');
  const complete = receiptValue({
    status: 'complete',
    decisions: [{ ...pending.decisions[0], outcome: 'promoted' }, pending.decisions[1]],
    writes: [{ path: '.apex/standards/web.md', previous: null, observed: sha('web') }],
    gate: 'pass',
  });
  assert.equal(validateInitReceipt(complete, { runId: RUN }).status, 'complete');
  const onlyExcluded = receiptValue({ decisions: [pending.decisions[1]], writes: [] });
  assert.deepEqual(validateInitReceipt(onlyExcluded, { runId: RUN }).writes, []);

  for (const [label, value, pattern] of [
    ['unresolved marked complete', { ...complete, decisions: pending.decisions }, /pending/],
    ['complete without a passing gate', { ...complete, gate: 'not-run' }, /gate/],
    ['complete with an unobserved write', { ...complete, writes: pending.writes }, /observed/],
    ['in-progress claiming promotion', { ...pending, decisions: complete.decisions }, /promoted/],
    ['in-progress with a gate result', { ...pending, gate: 'pass' }, /gate/],
    ['unknown status', { ...pending, status: 'done' }, /status/],
    ['other run', { ...pending, 'run-id': OTHER }, /run/],
    ['duplicate decision', { ...pending, decisions: [pending.decisions[0], pending.decisions[0]] }, /more than once/],
    ['local destination', { ...pending,
      decisions: [{ ...pending.decisions[0], destination: '.apex/work/specs/x.md' }],
      writes: [{ path: '.apex/work/specs/x.md', previous: null, observed: null }] }, /local area/],
    ['write without decision', { ...pending, writes: [...pending.writes, { path: '.apex/glossary.md', previous: null, observed: null }] }, /writes/],
    ['decision without write', { ...pending, writes: [] }, /writes/],
    ['missing promotion input', { ...pending, inputs: pending.inputs.slice(0, 5) }, /inputs/],
    ['single verification input', { ...pending, inputs: pending.inputs.filter(({ path }) => !path.endsWith('report.md')) }, /inputs/],
    ['unknown input role', { ...pending, inputs: [...pending.inputs, { role: 'state', path: STATE, sha256: sha('s') }] }, /role/],
    ['extra field', { ...pending, approvedBy: 'me' }, /unsupported field/],
  ]) {
    assertCode(() => validateInitReceipt(value, { runId: RUN }), 'INCEPTION_HANDOFF_INVALID', pattern, /approvedBy/);
  }
});

test('prepare records init in-progress before any hub write and a create-only receipt of previous destination bytes', () => withTemp('prepare', (root) => {
  seedRun(root);
  put(root, '.apex/glossary.md', GLOSSARY);
  const inputs = verify(root).inputs;
  const result = prepare(root);

  const inspected = inspectInceptionState(root);
  assert.equal(inspected.state, 'init-in-progress');
  assert.deepEqual(inspected.descriptor.init, {
    status: 'in-progress',
    handoff: { path: HANDOFF, sha256: digestOf(root, HANDOFF) },
    receipt: { path: RECEIPT, sha256: digestOf(root, RECEIPT) },
  }, 'the started init binds the receipt identity in the descriptor');
  assert.equal(readFileSync(join(root, RECEIPT), 'utf8'), json({
    'inception-receipt': 'steepy-apex/v1',
    'run-id': RUN,
    status: 'in-progress',
    handoff: { path: HANDOFF, sha256: digestOf(root, HANDOFF) },
    inputs,
    decisions: [
      { id: 'arch-001', outcome: 'pending', destination: '.apex/standards/web.md', sha256: sha(WEB_TEXT) },
      { id: 'glossary-001', outcome: 'pending', destination: '.apex/glossary.md', sha256: sha(TERM_TEXT) },
      { id: 'deploy-001', outcome: 'excluded', reason: 'The deploy target is local research only.' },
    ],
    writes: [
      { path: '.apex/glossary.md', previous: sha(GLOSSARY), observed: null },
      { path: '.apex/standards/web.md', previous: null, observed: null },
    ],
    gate: 'not-run',
  }));
  assert.deepEqual(result, {
    status: 'in-progress',
    runId: RUN,
    receipt: { path: RECEIPT, sha256: digestOf(root, RECEIPT) },
    changed: { state: true, receipt: true },
    destinations: [
      { path: '.apex/glossary.md', previous: sha(GLOSSARY), observed: sha(GLOSSARY), state: 'pending' },
      { path: '.apex/standards/web.md', previous: null, observed: null, state: 'pending' },
    ],
  });

  // Resume after partial work: the prepared previous bytes are kept, a
  // realized destination is a no-op, and a human change is only reported.
  put(root, '.apex/standards/web.md', `# web\n\n${WEB_TEXT}`);
  put(root, '.apex/glossary.md', `${GLOSSARY}A human edit.\n`);
  utimesSync(join(root, RECEIPT), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  const kept = snapshot(root, [STATE, RECEIPT]);
  const resumed = prepare(root, { receipt: undefined });
  assert.deepEqual(snapshot(root, [STATE, RECEIPT]), kept, 'resume rewrites neither the state nor the receipt');
  assert.equal(resumed.receipt.path, RECEIPT, 'resume finds the receipt from the descriptor alone');
  assert.deepEqual(resumed.changed, { state: false, receipt: false });
  assert.deepEqual(resumed.destinations.map(({ path, state }) => [path, state]), [
    ['.apex/glossary.md', 'changed'],
    ['.apex/standards/web.md', 'realized'],
  ]);
}));

test('a started init is bound to one receipt: other receipt paths are refused and resume never re-baselines', () => withTemp('receipt-bound', (root) => {
  seedRun(root);
  put(root, '.apex/glossary.md', GLOSSARY);
  prepare(root);
  put(root, '.apex/glossary.md', `${GLOSSARY}A human edit.\n`);
  const other = run('receipt-b.json');
  const watched = [STATE, RECEIPT, other, '.apex/glossary.md', '.apex/standards/web.md'];
  let before = snapshot(root, watched);
  assertCode(() => prepare(root, { receipt: other }), 'INCEPTION_HANDOFF_RECEIPT', /bound to receipt/);
  promote(root);
  before = snapshot(root, watched);
  assertCode(() => finalize(root, { receipt: other }), 'INCEPTION_HANDOFF_RECEIPT', /bound to receipt/);
  assert.deepEqual(snapshot(root, watched), before, 'a second receipt is never started or finalized');

  put(root, '.apex/glossary.md', `${GLOSSARY}A human edit.\n`);
  const resumed = prepare(root, { receipt: undefined });
  assert.deepEqual(resumed.destinations.find(({ path }) => path === '.apex/glossary.md'),
    { path: '.apex/glossary.md', previous: sha(GLOSSARY), observed: digestOf(root, '.apex/glossary.md'), state: 'changed' },
    'the human edit stays visible against the original previous bytes');
  promote(root);
  const done = finalize(root, { receipt: undefined });
  assert.equal(done.receipt.path, RECEIPT);
  assert.equal(JSON.parse(readFileSync(join(root, RECEIPT), 'utf8')).writes[0].previous, sha(GLOSSARY));
  assert.deepEqual(inspectInceptionState(root).descriptor.init.receipt, { path: RECEIPT, sha256: digestOf(root, RECEIPT) });
  assert.equal(existsSync(join(root, other)), false);
}));

test('a crash between the receipt write and the state write resumes onto the same receipt and its original previous bytes', () => {
  withTemp('receipt-crash', (root) => {
    seedRun(root);
    put(root, '.apex/glossary.md', GLOSSARY);
    const notStarted = readFileSync(join(root, STATE));
    prepare(root);
    const receipt = readFileSync(join(root, RECEIPT));
    writeFileSync(join(root, STATE), notStarted);
    put(root, '.apex/glossary.md', `${GLOSSARY}A human edit.\n`);
    const resumed = prepare(root);
    assert.deepEqual(resumed.changed, { state: true, receipt: false });
    assert.deepEqual(readFileSync(join(root, RECEIPT)), receipt, 'the prepared previous digests are kept');
    assert.deepEqual(inspectInceptionState(root).descriptor.init.receipt, { path: RECEIPT, sha256: sha(receipt) });
    assert.equal(resumed.destinations[0].state, 'changed');
  });

  withTemp('receipt-lost', (root) => {
    seedRun(root);
    prepare(root);
    rmSync(join(root, RECEIPT));
    promote(root);
    const watched = [STATE, RECEIPT];
    const before = snapshot(root, watched);
    assertCode(() => prepare(root), 'INCEPTION_HANDOFF_RECEIPT', /bound receipt is missing/);
    assertCode(() => finalize(root), 'INCEPTION_HANDOFF_RECEIPT', /bound receipt is missing/);
    assert.deepEqual(snapshot(root, watched), before, 'a lost bound receipt is never re-baselined');
  });

  withTemp('receipt-tampered', (root) => {
    seedRun(root);
    prepare(root);
    const value = JSON.parse(readFileSync(join(root, RECEIPT), 'utf8'));
    value.writes[0].previous = sha('forged');
    writeFileSync(join(root, RECEIPT), json(value));
    promote(root);
    assertCode(() => prepare(root), 'INCEPTION_HANDOFF_RECEIPT', /bound receipt bytes changed/);
    assertCode(() => finalize(root), 'INCEPTION_HANDOFF_RECEIPT', /bound receipt bytes changed/);
  });
});

test('finalize requires a passing gate, realized promotions, and unchanged code, then records init complete exactly once', () => withTemp('finalize', (root) => {
  seedRun(root);
  put(root, '.apex/glossary.md', GLOSSARY);
  prepare(root);
  const preparedReceipt = readFileSync(join(root, RECEIPT));
  const watched = [STATE, RECEIPT, '.apex/glossary.md', '.apex/standards/web.md'];
  let before = snapshot(root, watched);
  assertCode(() => finalize(root, { gate: 'fail' }), 'INCEPTION_HANDOFF_GATE', /gate/);
  assertCode(() => finalize(root), 'INCEPTION_HANDOFF_UNREALIZED', /arch-001/);
  assert.deepEqual(snapshot(root, watched), before, 'refused finalization writes nothing');

  promote(root);
  put(root, 'src/index.js', 'export const ok = false;\n');
  before = snapshot(root, watched);
  assertCode(() => finalize(root), 'INCEPTION_HANDOFF_DIVERGED', /checkpoint/);
  assert.deepEqual(snapshot(root, watched), before, 'a changed checkpoint refuses finalization');
  put(root, 'src/index.js', 'export const ok = true;\n');

  const done = finalize(root);
  const receipt = JSON.parse(readFileSync(join(root, RECEIPT), 'utf8'));
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.gate, 'pass');
  assert.deepEqual(receipt.decisions.map(({ id, outcome }) => [id, outcome]), [
    ['arch-001', 'promoted'], ['glossary-001', 'promoted'], ['deploy-001', 'excluded'],
  ]);
  assert.deepEqual(receipt.writes, [
    { path: '.apex/glossary.md', previous: sha(GLOSSARY), observed: digestOf(root, '.apex/glossary.md') },
    { path: '.apex/standards/web.md', previous: null, observed: digestOf(root, '.apex/standards/web.md') },
  ]);
  assert.deepEqual(done.changed, { state: true, receipt: true });
  const inspected = inspectInceptionState(root);
  assert.equal(inspected.state, 'init-complete');
  assert.deepEqual(inspected.descriptor.init.receipt, { path: RECEIPT, sha256: digestOf(root, RECEIPT) });
  assert.equal(inspected.descriptor.phase, 'init', 'finalize records init completion only');

  utimesSync(join(root, RECEIPT), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  utimesSync(join(root, STATE), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  before = snapshot(root, watched);
  assert.deepEqual(finalize(root).changed, { state: false, receipt: false });
  assert.deepEqual(snapshot(root, watched), before, 'an exact repetition is a no-op');

  put(root, '.apex/glossary.md', `${GLOSSARY}${TERM_TEXT}A later human edit.\n`);
  before = snapshot(root, watched);
  assertCode(() => finalize(root), 'INCEPTION_HANDOFF_DIVERGED', /receipt/);
  assert.deepEqual(snapshot(root, watched), before, 'divergent human bytes refuse finalization');
  assertCode(() => prepare(root), 'INCEPTION_HANDOFF_RECEIPT', /already complete/);

  put(root, '.apex/glossary.md', `${GLOSSARY}${TERM_TEXT}`);
  writeFileSync(join(root, RECEIPT), preparedReceipt);
  before = snapshot(root, watched);
  assertCode(() => finalize(root), 'INCEPTION_HANDOFF_RECEIPT', /not complete/);
  assert.deepEqual(snapshot(root, watched), before, 'a completed state never rewrites a reverted receipt');
}));

test('an interrupted finalization resumes without rewriting its receipt', () => withTemp('finalize-resume', (root) => {
  seedRun(root);
  prepare(root);
  promote(root);
  const inProgress = readFileSync(join(root, STATE));
  finalize(root);
  writeFileSync(join(root, STATE), inProgress);
  utimesSync(join(root, RECEIPT), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  const kept = snapshot(root, [RECEIPT]);
  assertCode(() => prepare(root), 'INCEPTION_HANDOFF_RECEIPT', /already complete/);
  const resumed = finalize(root);
  assert.deepEqual(resumed.changed, { state: true, receipt: false });
  assert.deepEqual(snapshot(root, [RECEIPT]), kept);
  assert.equal(inspectInceptionState(root).state, 'init-complete');
}));

test('prepare and finalize refuse divergent code, foreign receipts, changed inputs, and unsafe destinations without writing', () => {
  withTemp('prepare-diverged', (root) => {
    seedRun(root);
    put(root, 'src/index.js', 'export const ok = false;\n');
    const state = readFileSync(join(root, STATE));
    assertCode(() => prepare(root), 'INCEPTION_HANDOFF_DIVERGED', /reconcile/);
    assert.deepEqual(readFileSync(join(root, STATE)), state);
    assert.equal(existsSync(join(root, RECEIPT)), false);
    assertCode(() => finalize(root), 'INCEPTION_HANDOFF_DIVERGED', /checkpoint/);
  });

  withTemp('prepare-paths', (root) => {
    seedRun(root);
    for (const receipt of [run('init-receipt.json', OTHER), run('promotion.json'), HANDOFF, '.apex/work/receipt.json']) {
      assertCode(() => prepare(root, { receipt }), 'INCEPTION_HANDOFF_INVALID', /receipt|more than once/);
    }
    assertCode(() => finalize(root), 'INCEPTION_HANDOFF_RECEIPT', /prepare/);
  });

  withTemp('prepare-inputs-changed', (root) => {
    seedRun(root);
    prepare(root);
    put(root, run('promotion.json'), json(promotionTable(promotionTable().decisions.slice(0, 2))));
    const kept = snapshot(root, [STATE, RECEIPT]);
    assertCode(() => prepare(root), 'INCEPTION_HANDOFF_RECEIPT', /other transfer inputs/);
    promote(root);
    assertCode(() => finalize(root), 'INCEPTION_HANDOFF_RECEIPT', /other transfer inputs/);
    assert.deepEqual(snapshot(root, [STATE, RECEIPT]), kept);
  });

  withTemp('verification-report-changed', (root) => {
    seedRun(root);
    prepare(root);
    promote(root);
    put(root, VERIFICATION_REPORT, '# Verification\n\n- npm test: fail\n');
    const kept = snapshot(root, [STATE, RECEIPT]);
    assertCode(() => finalize(root), 'INCEPTION_HANDOFF_RECEIPT', /other transfer inputs/);
    assert.deepEqual(snapshot(root, [STATE, RECEIPT]), kept);
  });

  withTemp('prepare-unsafe-destination', (root) => {
    seedRun(root);
    put(root, '.apex/work/specs/draft.md', 'LOCAL_WORK_SENTINEL\n');
    symlinkSync('work/specs/draft.md', join(root, '.apex/glossary.md'));
    const state = readFileSync(join(root, STATE));
    assertCode(() => prepare(root), 'INCEPTION_HANDOFF_UNSAFE', /glossary\.md/);
    assert.deepEqual(readFileSync(join(root, STATE)), state, 'unsafe destinations are refused before init starts');
    assert.equal(existsSync(join(root, RECEIPT)), false);
  });

  withTemp('finalize-not-started', (root) => {
    seedRun(root);
    put(root, RECEIPT, '{}\n');
    assertCode(() => finalize(root), 'INCEPTION_HANDOFF_RECEIPT', /prepare/);
  });
});

const cli = join(here, '..', 'scripts', 'inception-handoff.mjs');
const runCli = (root, args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: gitEnv(root) });

test('CLI usage errors exit 2 without output or writes', () => withTemp('cli-usage', (root) => {
  seedRun(root);
  const before = snapshot(root, [STATE, RECEIPT, run('checkpoint-2.json')]);
  for (const args of [
    [],
    ['bogus', '--root', root],
    ['verify', '--handoff', HANDOFF],
    ['verify', '--root', root],
    ['verify', '--root', root, '--handoff', HANDOFF, '--unknown'],
    ['verify', '--root', root, '--handoff', HANDOFF, 'extra'],
    ['project', '--root', root, '--handoff', HANDOFF, '--receipt', RECEIPT],
    ['project', '--root', root, '--handoff', HANDOFF, '--resolution', 'no-choice'],
    ['project', '--root', root, '--handoff', HANDOFF, '--resolution', 'a=keep', '--resolution', 'a=replace'],
    ['checkpoint', '--root', root, '--run-id', RUN, '--output', run('checkpoint-2.json')],
    ['checkpoint', '--root', root, '--run-id', RUN, '--path', 'package.json'],
    ['prepare', '--root', root, '--handoff', HANDOFF, '--gate', 'pass'],
    ['finalize', '--root', root, '--handoff', HANDOFF, '--receipt', RECEIPT],
    ['finalize', '--root', root, '--handoff', HANDOFF, '--receipt', RECEIPT, '--gate', 'pass', '--resolution', 'a=b'],
  ]) {
    const result = runCli(root, args);
    assert.equal(result.status, 2, `${args.join(' ')} -> ${result.status}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /usage/i);
  }
  assert.deepEqual(snapshot(root, [STATE, RECEIPT, run('checkpoint-2.json')]), before);
}));

test('CLI produces the checkpoint, verification report, projection, and receipts as exact outputs', () => withTemp('cli', (root) => {
  seedRun(root);
  const checkpoint = runCli(root, ['checkpoint', '--root', root, '--run-id', RUN, '--output', run('checkpoint-2.json'),
    '--path', 'src/index.js', '--path', 'package.json']);
  assert.equal(checkpoint.status, 0, checkpoint.stderr);
  const written = JSON.parse(checkpoint.stdout);
  assert.deepEqual(written, { path: run('checkpoint-2.json'), sha256: digestOf(root, run('checkpoint-2.json')), changed: true });
  assert.equal(readFileSync(join(root, run('checkpoint-2.json')), 'utf8'),
    serializeCodeCheckpoint(observeCodeCheckpoint(root, { runId: RUN, paths: ['package.json', 'src/index.js'], env: gitEnv(root) })));
  const again = runCli(root, ['checkpoint', '--root', root, '--run-id', RUN, '--output', run('checkpoint-2.json'),
    '--path', 'package.json', '--path', 'src/index.js']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).changed, false, 'an identical checkpoint is a no-op');
  const foreign = runCli(root, ['checkpoint', '--root', root, '--run-id', OTHER, '--output', run('checkpoint.json', OTHER), '--path', 'package.json']);
  assert.equal(foreign.status, 1);
  assert.match(foreign.stderr, /checkpoint output belongs to a different run/);

  const verified = runCli(root, ['verify', '--root', root, '--handoff', HANDOFF]);
  assert.equal(verified.status, 0, verified.stderr);
  const report = JSON.parse(verified.stdout);
  assert.equal(report.status, 'verified');
  assert.deepEqual(report.inputs, verify(root).inputs);
  assert.deepEqual(report.decisions, [
    { id: 'arch-001', outcome: 'promote', destination: '.apex/standards/web.md' },
    { id: 'glossary-001', outcome: 'promote', destination: '.apex/glossary.md' },
    { id: 'deploy-001', outcome: 'exclude' },
  ]);
  assert.doesNotMatch(verified.stdout, /Render on the server|Tenant/, 'the report carries no promoted text or record values');

  const projected = runCli(root, ['project', '--root', root, '--handoff', HANDOFF, '--resolution', 'agents-md=keep']);
  assert.equal(projected.status, 0, projected.stderr);
  assert.equal(projected.stdout, json(projectConfirmedInputs(confirmedInputs(), { resolutions: { 'agents-md': 'keep' } })));
  assert.equal(readFileSync(join(root, run('confirmed-inputs.json')), 'utf8'), json(confirmedInputs()));

  put(root, 'src/index.js', 'export const ok = false;\n');
  const diverged = runCli(root, ['verify', '--root', root, '--handoff', HANDOFF, '--path', 'pnpm-lock.yaml']);
  assert.equal(diverged.status, 0, 'divergence is reported, not an invalid handoff');
  assert.equal(JSON.parse(diverged.stdout).status, 'diverged');
  const overwrite = runCli(root, ['checkpoint', '--root', root, '--run-id', RUN, '--output', run('checkpoint-2.json'),
    '--path', 'package.json', '--path', 'src/index.js']);
  assert.equal(overwrite.status, 1, 'a recorded checkpoint is never overwritten');
  assert.match(overwrite.stderr, /already holds a different checkpoint/);
  assert.equal(JSON.parse(checkpoint.stdout).sha256, digestOf(root, run('checkpoint-2.json')));
  const refused = runCli(root, ['prepare', '--root', root, '--handoff', HANDOFF, '--receipt', RECEIPT]);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /reconcile/);
  put(root, 'src/index.js', 'export const ok = true;\n');

  const unnamed = runCli(root, ['prepare', '--root', root, '--handoff', HANDOFF]);
  assert.equal(unnamed.status, 1);
  assert.match(unnamed.stderr, /receipt path is required to start init/);
  const prepared = runCli(root, ['prepare', '--root', root, '--handoff', HANDOFF, '--receipt', RECEIPT]);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(JSON.parse(prepared.stdout).status, 'in-progress');
  promote(root);
  const failedGate = runCli(root, ['finalize', '--root', root, '--handoff', HANDOFF, '--receipt', RECEIPT, '--gate', 'fail']);
  assert.equal(failedGate.status, 1);
  assert.match(failedGate.stderr, /gate/);
  const finalized = runCli(root, ['finalize', '--root', root, '--handoff', HANDOFF, '--receipt', RECEIPT, '--gate', 'pass']);
  assert.equal(finalized.status, 0, finalized.stderr);
  assert.deepEqual(JSON.parse(finalized.stdout).changed, { state: true, receipt: true });
  const repeated = runCli(root, ['finalize', '--root', root, '--handoff', HANDOFF, '--gate', 'pass']);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(JSON.parse(repeated.stdout).changed, { state: false, receipt: false });
  assert.equal(inspectInceptionState(root).state, 'init-complete');

  put(root, HANDOFF, json({ ...handoffValue(), apiToken: 'sk-live-secret' }));
  const secret = runCli(root, ['verify', '--root', root, '--handoff', HANDOFF]);
  assert.equal(secret.status, 1);
  assert.doesNotMatch(secret.stderr, /sk-live-secret|apiToken/);
}));

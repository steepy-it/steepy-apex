import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  cpSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CAPABILITIES,
  INCEPTION_AREA,
  INCEPTION_GITIGNORE,
  INCEPTION_GITIGNORE_BYTES,
  PHASES,
  RUN_CHILDREN,
  RUN_DESCRIPTOR_PATH,
  RUN_SCHEMA,
  RUN_SCHEMA_V1,
  RUN_SCHEMA_V2,
  STATUSES,
  classifyState,
  createRunDescriptor,
  createRunDescriptorV2,
  nextStepFor,
  parseRunDescriptor,
  replaceFileAtomic,
  serializeRunDescriptor,
  startRun,
} from '../scripts/inception-state.mjs';

const SCRIPT = realpathSync(fileURLToPath(new URL('../scripts/inception-state.mjs', import.meta.url)));
const RUN_ID = 'inc-20261007T120000Z-1a2b3c4d';
const RUN_ID_PATTERN = /^inc-\d{8}T\d{6}Z-[0-9a-f]{8}$/u;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseDescriptor(overrides = {}) {
  return {
    schema: 'steepy-inception-run/v1',
    runId: RUN_ID,
    phase: 'reconnaissance',
    status: 'active',
    harness: {
      name: 'claude-code',
      capabilities: {
        shell: true, network: true, browser: false, subagents: true, 'question-tool': true, headless: false,
      },
    },
    git: { present: true, branch: 'main', commits: 'allowed' },
    nextRecord: 1,
    approvalEntry: null,
    approvals: [],
    checkpoints: [],
    resumeNotes: [],
    finalCheckpoint: null,
    verification: null,
    history: [],
    ...overrides,
  };
}

function completeDescriptor() {
  return baseDescriptor({
    phase: 'complete',
    status: 'complete',
    nextRecord: 3,
    checkpoints: ['.apex/inception/checkpoints/0002.json'],
    finalCheckpoint: '.apex/inception/checkpoints/0002.json',
    verification: { path: '.apex/inception/verification/results.md', bytes: 12, sha256: 'a'.repeat(64) },
  });
}

function text(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// Rebuild an object with `key` moved to the end (to prove key order is checked).
function moveKeyToEnd(object, key) {
  const { [key]: moved, ...rest } = object;
  return { ...rest, [key]: moved };
}

// ---------------------------------------------------------------------------
// Module shape (HC1, HC2)
// ---------------------------------------------------------------------------

test('exports the fixed inception paths, run children, and closed enums', () => {
  assert.equal(INCEPTION_AREA, '.apex/inception');
  assert.equal(INCEPTION_GITIGNORE, '.apex/inception/.gitignore');
  assert.equal(INCEPTION_GITIGNORE_BYTES, '*\n');
  assert.equal(RUN_DESCRIPTOR_PATH, '.apex/inception/run.json');
  assert.deepEqual(RUN_CHILDREN, [
    'approvals', 'checkpoints', 'resume-notes', 'project', 'research', 'bootstrap', 'verification',
    'effects.jsonl', 'snapshots', 'effects', 'reconciliations', 'units', 'run.json',
  ]);
  assert.deepEqual(PHASES, [
    'reconnaissance', 'architecture', 'research', 'approval', 'bootstrap', 'verification', 'complete',
  ]);
  assert.deepEqual(STATUSES, ['active', 'blocked', 'complete']);
  assert.deepEqual(CAPABILITIES, ['shell', 'network', 'browser', 'subagents', 'question-tool', 'headless']);
});

// ---------------------------------------------------------------------------
// Run descriptor schema (HC3)
// ---------------------------------------------------------------------------

test('createRunDescriptor returns the frozen initial descriptor with the six capabilities in order', () => {
  const descriptor = createRunDescriptor({
    runId: RUN_ID,
    harnessName: 'claude-code',
    capabilities: ['question-tool', 'subagents', 'network', 'shell'],
    git: { present: true, branch: 'main', commits: 'allowed' },
  });
  assert.deepEqual(descriptor, createRunDescriptorV2({ runId: RUN_ID, harnessName: 'claude-code', capabilities: ['question-tool', 'subagents', 'network', 'shell'], git: { present: true, branch: 'main', commits: 'allowed' } }));
  assert.equal(descriptor.schema, RUN_SCHEMA_V2);
  assert.deepEqual(Object.keys(descriptor.harness.capabilities), CAPABILITIES);
  assert.ok(Object.isFrozen(descriptor));
  assert.ok(Object.isFrozen(descriptor.harness.capabilities));
  assert.ok(Object.isFrozen(descriptor.history));
  assert.throws(
    () => createRunDescriptor({
      runId: RUN_ID, harnessName: 'claude-code', capabilities: ['telepathy'],
      git: { present: false, branch: null, commits: 'none' },
    }),
    /capabilit/u,
  );
});

test('serializeRunDescriptor and parseRunDescriptor round-trip a descriptor', () => {
  const parsed = parseRunDescriptor(text(completeDescriptor()));
  assert.deepEqual(parsed, completeDescriptor());
  assert.equal(serializeRunDescriptor(parsed), text(completeDescriptor()));
  assert.ok(Object.isFrozen(parsed.verification));
});

test('the descriptor admits the seven phases and three statuses only', () => {
  for (const phase of PHASES.filter((name) => name !== 'complete')) {
    for (const status of ['active', 'blocked']) {
      assert.equal(parseRunDescriptor(text(baseDescriptor({ phase, status }))).phase, phase);
    }
    assert.throws(() => parseRunDescriptor(text(baseDescriptor({ phase, status: 'complete' }))), /complete/u);
  }
  for (const status of ['active', 'blocked']) {
    assert.throws(
      () => parseRunDescriptor(text({ ...completeDescriptor(), status })),
      /complete/u,
    );
  }
  assert.equal(parseRunDescriptor(text(completeDescriptor())).status, 'complete');
  assert.throws(() => parseRunDescriptor(text(baseDescriptor({ phase: 'design' }))), /phase/u);
  assert.throws(() => parseRunDescriptor(text(baseDescriptor({ status: 'paused' }))), /status/u);
});

test('parseRunDescriptor rejects every invalid descriptor shape with a one-line reason', () => {
  const base = baseDescriptor();
  const capabilities = base.harness.capabilities;
  const invalid = {
    'invalid JSON': '{"schema": ',
    'not an object': '[]\n',
    'missing key': text((({ history, ...rest }) => rest)(base)),
    'extra key': text({ ...base, extra: true }),
    'reordered keys': text(moveKeyToEnd(base, 'schema')),
    'wrong schema': text({ ...base, schema: 'steepy-inception-run/v2' }),
    'malformed runId': text({ ...base, runId: 'inc-2026-1a2b3c4d' }),
    'uppercase runId hex': text({ ...base, runId: 'inc-20261007T120000Z-1A2B3C4D' }),
    'unsafe harness name': text({ ...base, harness: { ...base.harness, name: 'Claude Code' } }),
    'extra harness key': text({ ...base, harness: { ...base.harness, version: 1 } }),
    'unknown capability': text({ ...base, harness: { ...base.harness, capabilities: { ...capabilities, telepathy: true } } }),
    'reordered capabilities': text({ ...base, harness: { ...base.harness, capabilities: moveKeyToEnd(capabilities, 'shell') } }),
    'non-boolean capability': text({ ...base, harness: { ...base.harness, capabilities: { ...capabilities, shell: 'yes' } } }),
    'non-boolean git.present': text({ ...base, git: { ...base.git, present: 'yes' } }),
    'numeric git.branch': text({ ...base, git: { ...base.git, branch: 7 } }),
    'unknown git.commits': text({ ...base, git: { ...base.git, commits: 'sometimes' } }),
    'commits none with Git present': text({ ...base, git: { present: true, branch: 'main', commits: 'none' } }),
    'commits allowed without Git': text({ ...base, git: { present: false, branch: null, commits: 'allowed' } }),
    'zero nextRecord': text({ ...base, nextRecord: 0 }),
    'fractional nextRecord': text({ ...base, nextRecord: 1.5 }),
    'approvalEntry above approvals': text({ ...base, approvalEntry: 1 }),
    'negative approvalEntry': text({ ...base, approvalEntry: -1 }),
    'approval outside its directory': text({ ...base, nextRecord: 2, approvals: ['.apex/inception/checkpoints/0001.json'] }),
    'approval at nextRecord': text({ ...base, nextRecord: 2, approvals: ['.apex/inception/approvals/0002.json'] }),
    'unpadded record number': text({ ...base, nextRecord: 2, resumeNotes: ['.apex/inception/resume-notes/1.md'] }),
    'records not increasing': text({
      ...base,
      nextRecord: 4,
      checkpoints: ['.apex/inception/checkpoints/0003.json', '.apex/inception/checkpoints/0002.json'],
    }),
    'finalCheckpoint not a checkpoint': text({
      ...base, nextRecord: 3, checkpoints: ['.apex/inception/checkpoints/0002.json'],
      finalCheckpoint: '.apex/inception/checkpoints/0001.json',
    }),
    'verification outside its directory': text({
      ...base, verification: { path: '.apex/inception/project/results.md', bytes: 1, sha256: 'b'.repeat(64) },
    }),
    'verification escaping its directory': text({
      ...base, verification: { path: '.apex/inception/verification/../../../etc/passwd', bytes: 1, sha256: 'b'.repeat(64) },
    }),
    'verification with an empty segment': text({
      ...base, verification: { path: '.apex/inception/verification//results.md', bytes: 1, sha256: 'b'.repeat(64) },
    }),
    'verification with a dot segment': text({
      ...base, verification: { path: '.apex/inception/verification/./results.md', bytes: 1, sha256: 'b'.repeat(64) },
    }),
    'verification with a control character': text({
      ...base, verification: { path: '.apex/inception/verification/results\n.md', bytes: 1, sha256: 'b'.repeat(64) },
    }),
    'verification naming its directory': text({
      ...base, verification: { path: '.apex/inception/verification/', bytes: 1, sha256: 'b'.repeat(64) },
    }),
    'verification with a bad digest': text({
      ...base, verification: { path: '.apex/inception/verification/results.md', bytes: 1, sha256: 'B'.repeat(64) },
    }),
    'complete without finalCheckpoint': text({ ...completeDescriptor(), finalCheckpoint: null }),
    'complete without verification': text({ ...completeDescriptor(), verification: null }),
    'malformed history entry': text({
      ...base,
      history: [{ at: '2026-10-07T12:00:00.000Z', from: { phase: 'reconnaissance' }, to: { phase: 'architecture', status: 'active' }, reason: 'x' }],
    }),
    'history entry with a bad timestamp': text({
      ...base,
      history: [{
        at: 'yesterday',
        from: { phase: 'reconnaissance', status: 'active' },
        to: { phase: 'architecture', status: 'active' },
        reason: 'x',
      }],
    }),
  };
  for (const [label, bytes] of Object.entries(invalid)) {
    assert.throws(
      () => parseRunDescriptor(bytes),
      (error) => error instanceof Error && error.message.length > 0 && !error.message.includes('\n'),
      label,
    );
  }
});

// Inserts `entry` (a `"key": value` fragment) right after the first occurrence of `anchor`.
function insertAfter(source, anchor, entry) {
  const index = source.indexOf(anchor);
  assert.ok(index >= 0, `anchor ${anchor} not found`);
  return `${source.slice(0, index + anchor.length)}${entry}${source.slice(index + anchor.length)}`;
}

test('parseRunDescriptor rejects a duplicate key at any level, including an escaped spelling', () => {
  const withHistory = text(baseDescriptor({
    phase: 'architecture',
    history: [{
      at: '2026-10-07T12:00:00.000Z',
      from: { phase: 'reconnaissance', status: 'active' },
      to: { phase: 'architecture', status: 'active' },
      reason: 'x',
    }],
  }));
  const valid = text(baseDescriptor());
  assert.equal(parseRunDescriptor(withHistory).history.length, 1, 'the fixture itself is valid');
  const duplicates = {
    'top-level key': insertAfter(valid, '{\n', '  "schema": "bogus",\n'),
    'escaped top-level key': insertAfter(valid, '{\n', '  "sch\\u0065ma": "bogus",\n'),
    'harness key': insertAfter(valid, '"harness": {\n', '    "name": "Bogus Name",\n'),
    'capability key': insertAfter(valid, '"capabilities": {\n', '      "shell": "yes",\n'),
    'git key': insertAfter(valid, '"git": {\n', '    "branch": 7,\n'),
    'history entry key': insertAfter(withHistory, '"reason": "x"', ',\n      "reason": "two\\nlines"'),
    'history state key': insertAfter(withHistory, '"from": {\n', '        "phase": "design",\n'),
  };
  for (const [label, bytes] of Object.entries(duplicates)) {
    assert.doesNotThrow(() => JSON.parse(bytes), `${label}: the fixture is syntactically valid JSON`);
    assert.throws(
      () => parseRunDescriptor(bytes),
      (error) => error instanceof Error && /duplicate key/u.test(error.message) && !error.message.includes('\n'),
      label,
    );
  }
});

test('nextStepFor names the next step for each run status', () => {
  assert.equal(
    nextStepFor(parseRunDescriptor(text(completeDescriptor()))),
    'legacy v1 run: inspect or abandon explicitly; no migration or v2 verification is available',
  );
  assert.equal(
    nextStepFor(parseRunDescriptor(text(baseDescriptor({ status: 'blocked' })))),
    'legacy v1 run: inspect or abandon explicitly; no migration or v2 verification is available',
  );
  assert.equal(
    nextStepFor(parseRunDescriptor(text(baseDescriptor({ phase: 'research' })))),
    'legacy v1 run: inspect or abandon explicitly; no migration or v2 verification is available',
  );
});

test('public descriptor creation is v2 while dispatch preserves raw v1 bytes', () => {
  assert.equal(RUN_SCHEMA, RUN_SCHEMA_V2);
  assert.equal(RUN_SCHEMA_V2, 'steepy-inception-run/v2');
  const d = createRunDescriptorV2({ runId: RUN_ID, harnessName: 'codex', capabilities: [], git: { present: false, branch: null, commits: 'none' } });
  assert.equal(parseRunDescriptor(serializeRunDescriptor(d)).schema, RUN_SCHEMA_V2);
  assert.deepEqual(parseRunDescriptor(text(baseDescriptor())), baseDescriptor());
  assert.throws(() => parseRunDescriptor(text({ ...d, schema: 'steepy-inception-run/v3' })), /schema/);
  assert.throws(() => parseRunDescriptor(text({ ...baseDescriptor(), revision: 1 })), /keys/);
  assert.throws(() => parseRunDescriptor(text({ ...d, finalCheckpoint: null })), /keys/);
});

// ---------------------------------------------------------------------------
// Hermetic CLI harness (GC4, GC5, GC6)
// ---------------------------------------------------------------------------

function hermeticEnv(base) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
    GIT_CEILING_DIRECTORIES: base,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Steepy Test',
    GIT_COMMITTER_NAME: 'Steepy Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}

// Each case owns `<tmp>/repo` (the repository under test) and `<tmp>/home` (the hermetic home),
// so inventories of the repository never see the harness's own files.
function withCase(name, fn) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `steepy-inception-${name}-`)));
  try {
    const repo = join(base, 'repo');
    mkdirSync(repo);
    return fn({ base, repo, env: hermeticEnv(base) });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// Builds one case through the real CLI, then runs each fixture on a fresh copy of that tree,
// so a slow setup runs once per test rather than once per fixture.
function eachCopy(name, build, fixtures, fn) {
  withCase(`${name}-template`, (template) => {
    const built = build(template);
    for (const fixture of fixtures) {
      withCase(name, (c) => {
        cpSync(template.repo, c.repo, { recursive: true });
        fn(c, fixture, built);
      });
    }
  });
}

function spawnHelper(c, args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: c.repo, env: c.env, encoding: 'utf8' });
  assert.match(result.stdout, /^[^\n]+\n$/u, `exactly one stdout line expected:\n${result.stdout}\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  if (output.ok) {
    assert.equal(result.stderr, '', 'a success writes nothing on stderr');
  } else {
    assert.equal(result.stderr, `inception-state: ${output.error}\n`, 'a refusal repeats its error on stderr');
  }
  return { status: result.status, output };
}

// Runs the real CLI against the case repository.
function cli(c, ...args) {
  return spawnHelper(c, [...args, '--repo-root', c.repo]);
}

function git(c, ...args) {
  const result = spawnSync('git', args, { cwd: c.repo, env: c.env, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

// Byte, link, and mtime inventory of a tree (tests may list; the helper may not).
function snapshot(root, { exclude = [] } = {}) {
  const entries = {};
  const walk = (relative) => {
    const absolute = relative === '' ? root : join(root, relative);
    for (const name of readdirSync(absolute).sort()) {
      const child = relative === '' ? name : `${relative}/${name}`;
      if (exclude.includes(child)) continue;
      const stat = lstatSync(join(root, child), { bigint: true });
      if (stat.isSymbolicLink()) {
        entries[child] = { type: 'symlink', target: readlinkSync(join(root, child)), mtimeNs: stat.mtimeNs };
      } else if (stat.isDirectory()) {
        entries[child] = { type: 'dir', mtimeNs: stat.mtimeNs };
        walk(child);
      } else {
        entries[child] = {
          type: 'file',
          bytes: readFileSync(join(root, child)).toString('base64'),
          nlink: stat.nlink,
          mtimeNs: stat.mtimeNs,
        };
      }
    }
  };
  walk('');
  return entries;
}

function files(root, options) {
  return Object.fromEntries(Object.entries(snapshot(root, options))
    .filter(([, entry]) => entry.type === 'file')
    .map(([path, entry]) => [path, Buffer.from(entry.bytes, 'base64').toString('utf8')]));
}

function writeFile(c, relative, content) {
  const absolute = join(c.repo, relative);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
}

function writeArea(c, descriptorText) {
  writeFile(c, '.apex/inception/.gitignore', '*\n');
  writeFile(c, '.apex/inception/run.json', descriptorText);
}

function writeDescriptor(c, descriptor) {
  writeArea(c, text(descriptor));
}

function writeHub(c) {
  writeFile(c, '.apex/_INDEX.md', '# Hub\n');
}

test('inspect is read-only and reports exact format, state, actions and references for either version', () => {
  for (const d of [baseDescriptor(), createRunDescriptorV2({ runId: RUN_ID, harnessName: 'codex', git: { present: false, branch: null, commits: 'none' } })]) {
    withCase('inspect-version', c => {
      writeDescriptor(c, d);
      const before = snapshot(c.repo);
      const result = cli(c, 'inspect');
      assert.equal(result.status, 0);
      assert.equal(result.output.format, d.schema);
      assert.equal(result.output.phase, d.phase);
      assert.equal(result.output.status, d.status);
      assert.equal(result.output.legacy, d.schema === RUN_SCHEMA_V1);
      if (result.output.legacy) assert.match(result.output.nextStep, /legacy v1.*inspect.*abandon/);
      assert.ok(result.output.allowedActions.includes('inspect'));
      assert.deepEqual(result.output.inputPaths, [RUN_DESCRIPTOR_PATH]);
      assert.deepEqual(snapshot(c.repo), before);
      assert.equal(cli(c, 'inspect', '--maturity', 'suitable').status, 2);
    });
  }
  withCase('inspect-invalid', c => {
    writeArea(c, text({ ...baseDescriptor(), schema: 'unknown/v9' }));
    const before = snapshot(c.repo);
    assert.equal(cli(c, 'inspect').status, 1);
    assert.deepEqual(snapshot(c.repo), before);
  });
});


function readDescriptor(c) {
  return JSON.parse(readFileSync(join(c.repo, '.apex/inception/run.json'), 'utf8'));
}

// Decoys hold valid descriptors at non-descriptor paths: reading any of them would change a row.
function addDecoys(c) {
  writeFile(c, '.apex/inception/project/x.md', text(completeDescriptor()));
  writeFile(c, '.apex/inception/zzz-run.json', text(baseDescriptor({ status: 'blocked' })));
  writeFile(c, '.apex/inception/run.json.bak', text(completeDescriptor()));
}

// ---------------------------------------------------------------------------
// Classification (HC8, SC1)
// ---------------------------------------------------------------------------

const MATURITIES = [[], ['--maturity', 'suitable'], ['--maturity', 'mature']];

const VALID_CLASSIFICATIONS = [
  { label: 'empty repository', setup() {}, hub: 'absent', run: 'none', rows: ['maturity-decision-required', 'start-new-run', 'propose-init-discovery'] },
  {
    label: '.DS_Store beside the area',
    setup(c) { writeFile(c, '.apex/.DS_Store', 'finder'); },
    hub: 'absent', run: 'none', rows: ['maturity-decision-required', 'start-new-run', 'propose-init-discovery'],
  },
  {
    label: 'area without a descriptor',
    setup(c) { writeFile(c, '.apex/inception/.gitignore', '*\n'); writeFile(c, '.apex/inception/.DS_Store', 'finder'); },
    hub: 'absent', run: 'none', rows: ['maturity-decision-required', 'start-new-run', 'propose-init-discovery'],
  },
  { label: 'hub without a run', setup(c) { writeHub(c); }, hub: 'present', run: 'none', rows: ['ordinary-workflow'] },
  {
    label: 'hard-linked hub index',
    setup(c) { writeHub(c); linkSync(join(c.repo, '.apex/_INDEX.md'), join(c.repo, 'index-copy.md')); },
    hub: 'present', run: 'none', rows: ['ordinary-workflow'],
  },
  { label: 'active run', setup(c) { writeDescriptor(c, baseDescriptor()); }, hub: 'absent', run: 'active', rows: ['resume-run'] },
  {
    label: 'blocked run',
    setup(c) { writeDescriptor(c, baseDescriptor({ status: 'blocked' })); },
    hub: 'absent', run: 'blocked', rows: ['resume-run'],
  },
  { label: 'complete run', setup(c) { writeDescriptor(c, completeDescriptor()); }, hub: 'absent', run: 'complete', rows: ['report-next-steps'] },
  {
    label: 'complete run beside a hub',
    setup(c) { writeDescriptor(c, completeDescriptor()); writeHub(c); },
    hub: 'present', run: 'complete', rows: ['run-complete-ordinary-workflow'],
  },
  {
    label: 'active run beside a hub',
    setup(c) { writeDescriptor(c, baseDescriptor()); writeHub(c); },
    hub: 'present', run: 'active', rows: ['conflict-run-beside-hub'],
  },
  {
    label: 'blocked run beside a hub',
    setup(c) { writeDescriptor(c, baseDescriptor({ status: 'blocked' })); writeHub(c); },
    hub: 'present', run: 'blocked', rows: ['conflict-run-beside-hub'],
  },
];

test('classifyState maps every HC8 observation to its row', () => {
  const table = [
    ['absent', 'none', undefined, 'maturity-decision-required'],
    ['absent', 'none', 'suitable', 'start-new-run'],
    ['absent', 'none', 'mature', 'propose-init-discovery'],
    ['present', 'none', undefined, 'ordinary-workflow'],
    ['absent', 'active', 'mature', 'resume-run'],
    ['absent', 'blocked', 'suitable', 'resume-run'],
    ['absent', 'complete', undefined, 'report-next-steps'],
    ['present', 'complete', 'suitable', 'run-complete-ordinary-workflow'],
    ['present', 'active', undefined, 'conflict-run-beside-hub'],
    ['present', 'blocked', 'mature', 'conflict-run-beside-hub'],
    ['absent', 'invalid', 'suitable', 'invalid-state'],
    ['present', 'invalid', undefined, 'invalid-state'],
    ['invalid', 'none', 'suitable', 'invalid-state'],
    ['invalid', 'complete', 'mature', 'invalid-state'],
  ];
  for (const [hub, run, maturity, row] of table) {
    assert.equal(classifyState({ hub, run, maturity }), row, `${hub}/${run}/${maturity}`);
  }
});

test('classify reports every HC8 row for every maturity without writing, and decoys never change a row', () => {
  for (const fixture of VALID_CLASSIFICATIONS) {
    for (const decoys of [false, true]) {
      withCase('classify', (c) => {
        fixture.setup(c);
        if (decoys) addDecoys(c);
        MATURITIES.forEach((maturity, index) => {
          const before = snapshot(c.repo);
          const { status, output } = cli(c, 'classify', ...maturity);
          const row = fixture.rows[Math.min(index, fixture.rows.length - 1)];
          const label = `${fixture.label}${decoys ? ' with decoys' : ''} ${maturity.join(' ')}`;
          assert.equal(status, 0, label);
          const expected = { ok: true, command: 'classify', row, hub: fixture.hub, run: fixture.run };
          if (fixture.run !== 'none') expected.nextStep = nextStepFor(parseRunDescriptor(readFileSync(join(c.repo, RUN_DESCRIPTOR_PATH), 'utf8')));
          assert.deepEqual(output, expected, label);
          assert.deepEqual(snapshot(c.repo), before, `${label}: classify must not write`);
        });
      });
    }
  }
});

// A valid descriptor whose `git.branch` holds one invalid UTF-8 byte: a lenient decode would read
// it as U+FFFD and accept it.
function invalidUtf8Descriptor() {
  const [head, tail] = text(baseDescriptor()).split('"branch": "main"');
  return Buffer.concat([Buffer.from(`${head}"branch": "ma`), Buffer.from([0xff]), Buffer.from(`in"${tail}`)]);
}

function bomDescriptor() {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text(baseDescriptor()))]);
}

const INVALID_CLASSIFICATIONS = [
  { label: 'invalid JSON', setup(c) { writeArea(c, '{"schema": '); } },
  { label: 'invalid UTF-8 byte', setup(c) { writeArea(c, invalidUtf8Descriptor()); } },
  { label: 'byte order mark', setup(c) { writeArea(c, bomDescriptor()); } },
  { label: 'extra key', setup(c) { writeDescriptor(c, { ...baseDescriptor(), extra: 1 }); } },
  { label: 'phase/status mismatch', setup(c) { writeDescriptor(c, baseDescriptor({ status: 'complete' })); } },
  {
    label: 'symlinked descriptor',
    setup(c) {
      writeFile(c, 'elsewhere/run.json', text(baseDescriptor()));
      writeFile(c, '.apex/inception/.gitignore', '*\n');
      symlinkSync(join(c.repo, 'elsewhere/run.json'), join(c.repo, '.apex/inception/run.json'));
    },
  },
  {
    label: 'hard-linked descriptor',
    setup(c) {
      writeDescriptor(c, baseDescriptor());
      linkSync(join(c.repo, '.apex/inception/run.json'), join(c.repo, 'run-copy.json'));
    },
  },
  {
    label: 'descriptor that is a directory',
    setup(c) { mkdirSync(join(c.repo, '.apex/inception/run.json'), { recursive: true }); },
  },
  {
    label: 'symlinked .apex',
    setup(c) {
      mkdirSync(join(c.repo, 'real-apex/inception'), { recursive: true });
      writeFile(c, 'real-apex/inception/run.json', text(baseDescriptor()));
      symlinkSync(join(c.repo, 'real-apex'), join(c.repo, '.apex'));
    },
  },
  {
    label: 'symlinked inception area',
    setup(c) {
      writeFile(c, 'real-area/run.json', text(baseDescriptor()));
      mkdirSync(join(c.repo, '.apex'));
      symlinkSync(join(c.repo, 'real-area'), join(c.repo, '.apex/inception'));
    },
  },
  { label: '.apex is a file', setup(c) { writeFile(c, '.apex', 'not a directory'); } },
  { label: 'hub index is a directory', setup(c) { mkdirSync(join(c.repo, '.apex/_INDEX.md'), { recursive: true }); } },
  {
    label: 'symlinked hub index',
    setup(c) {
      writeFile(c, 'index.md', '# Hub\n');
      mkdirSync(join(c.repo, '.apex'));
      symlinkSync(join(c.repo, 'index.md'), join(c.repo, '.apex/_INDEX.md'));
    },
  },
  { label: 'invalid descriptor beside a hub', setup(c) { writeHub(c); writeArea(c, 'not json'); } },
];

test('classify reports invalid-state with exit 1 and leaves every byte and mtime unchanged', () => {
  for (const fixture of INVALID_CLASSIFICATIONS) {
    withCase('classify-invalid', (c) => {
      fixture.setup(c);
      for (const maturity of MATURITIES) {
        const before = snapshot(c.repo);
        const { status, output } = cli(c, 'classify', ...maturity);
        const label = `${fixture.label} ${maturity.join(' ')}`;
        assert.equal(status, 1, label);
        assert.equal(output.ok, false, label);
        assert.equal(output.command, 'classify', label);
        assert.equal(output.row, 'invalid-state', label);
        assert.ok(output.hub === 'invalid' || output.run === 'invalid', label);
        assert.equal(typeof output.error, 'string', label);
        assert.ok(output.error.length > 0, label);
        assert.equal('nextStep' in output, false, label);
        assert.deepEqual(snapshot(c.repo), before, `${label}: classify must not write`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Output and usage contract (HC1, HC6, HC7)
// ---------------------------------------------------------------------------

test('usage errors exit 2 with one JSON line and never write', () => {
  const cases = [
    { args: [], command: null, error: /missing command/u },
    { args: ['bogus'], command: 'bogus', error: /unknown command/u },
    { args: ['approve', '--document', '.apex/inception/project/decision-register.md'], command: 'approve', error: /--statement/u },
    { args: ['approve', '--statement', 'yes'], command: 'approve', error: /--document/u },
    {
      args: ['approve', '--statement', 'yes', '--document', '.apex/inception/project/decision-register.md', '--statement', 'no'],
      command: 'approve', error: /--statement/u,
    },
    { args: ['approve', '--statement', 'yes', '--document', '.apex/inception/project/decision-register.md', 'extra'], command: 'approve', error: /extra/u },
    { args: ['verify-approval', '--approval'], command: 'verify-approval', error: /approval/u },
    { args: ['verify-approval', '--document', '.apex/inception/project/decision-register.md'], command: 'verify-approval', error: /document/u },
    { args: ['effect'], command: 'effect', error: /missing effect subcommand/u },
    { args: ['effect', 'bogus'], command: 'effect', error: /unknown effect subcommand/u },
    { args: ['effect intent', '--id', 'x', '--kind', 'install', '--summary', 's'], command: 'effect intent', error: /unknown command/u },
    { args: ['effect', 'intent', '--id', 'x', '--kind', 'telepathy', '--summary', 's'], command: 'effect intent', error: /--kind/u },
    { args: ['effect', 'intent', '--id', 'x'], command: 'effect intent', error: /--input/u },
    { args: ['effect', 'intent', '--input', 'input.json'], command: 'effect intent', error: /--id/u },
    { args: ['effect', 'intent'], command: 'effect intent', error: /--id/u },
    { args: ['effect', 'intent', '--id', 'x', '--input', 'input.json', '--result', 'failed'], command: 'effect intent', error: /result/u },
    { args: ['effect', 'outcome', '--id', 'x', '--result', 'maybe', '--observed', 'o'], command: 'effect outcome', error: /--result/u },
    { args: ['effect', 'outcome', '--id', 'x'], command: 'effect outcome', error: /--input/u },
    { args: ['effect', 'status', 'extra'], command: 'effect status', error: /extra/u },
    { args: ['effect', 'status', '--id', 'x'], command: 'effect status', error: /id/u },
    { args: ['checkpoint'], command: 'checkpoint', error: /missing checkpoint subcommand/u },
    { args: ['checkpoint', 'bogus'], command: 'checkpoint', error: /unknown checkpoint subcommand/u },
    { args: ['checkpoint', 'create', '--file', 'a.txt'], command: 'checkpoint create', error: /--label/u },
    { args: ['checkpoint', 'create', '--label', 'x', '--file', 'a.txt', '--label', 'y'], command: 'checkpoint create', error: /--label/u },
    { args: ['checkpoint', 'create', '--label', 'x', '--files-from'], command: 'checkpoint create', error: /files-from/u },
    { args: ['checkpoint', 'create', '--label', 'x', '--checkpoint', 'y'], command: 'checkpoint create', error: /checkpoint/u },
    { args: ['checkpoint', 'verify', '--approval', 'x'], command: 'checkpoint verify', error: /approval/u },
    { args: ['checkpoint', 'verify', 'extra'], command: 'checkpoint verify', error: /extra/u },
    { args: ['classify', '--bogus'], command: 'classify', error: /bogus/u },
    { args: ['classify', '--git-commits', 'allowed'], command: 'classify', error: /git-commits/u },
    { args: ['classify', '--maturity', 'medium'], command: 'classify', error: /maturity/u },
    { args: ['classify', '--maturity', 'suitable', '--maturity', 'mature'], command: 'classify', error: /maturity/u },
    { args: ['classify', 'extra'], command: 'classify', error: /extra/u },
    { args: ['classify', '--maturity'], command: 'classify', error: /maturity/u },
  ];
  for (const { args, command, error } of cases) {
    withCase('usage', (c) => {
      const before = snapshot(c.repo);
      const { status, output } = spawnHelper(c, args.length === 0 ? args : [...args, '--repo-root', c.repo]);
      assert.equal(status, 2, args.join(' '));
      assert.equal(output.ok, false, args.join(' '));
      assert.equal(output.command, command, args.join(' '));
      assert.match(output.error, error, args.join(' '));
      assert.deepEqual(snapshot(c.repo), before);
    });
  }
});

test('the repository root defaults to the working directory and must be an existing directory', () => {
  withCase('repo-root', (c) => {
    writeHub(c);
    assert.equal(spawnHelper(c, ['classify']).output.row, 'ordinary-workflow');
    const missing = spawnHelper(c, ['classify', '--repo-root', join(c.repo, 'missing')]);
    assert.equal(missing.status, 1);
    assert.match(missing.output.error, /repo-root/u);
    writeFile(c, 'plain-file', 'x');
    assert.equal(spawnHelper(c, ['classify', '--repo-root', join(c.repo, 'plain-file')]).status, 1);
  });
});

// ---------------------------------------------------------------------------
// start (HC7, HC10, SC2)
// ---------------------------------------------------------------------------

const HUB_ARTIFACTS = ['.apex/_INDEX.md', '.apex/standards', '.agents', '.claude', '.codex', '.opencode', 'AGENTS.md', 'CLAUDE.md'];

// Every file the helper created lives under `.apex/inception/`; the only directory it created
// outside the area is `.apex/` itself; no hub or provider artifact exists.
function assertConfinedToArea(c, before, { exclude = [] } = {}) {
  const after = snapshot(c.repo, { exclude });
  for (const path of Object.keys(after)) {
    if (path in before) continue;
    const insideArea = path === INCEPTION_AREA || path.startsWith(`${INCEPTION_AREA}/`);
    assert.ok(insideArea || (path === '.apex' && after[path].type === 'dir'), `unexpected path created: ${path}`);
  }
  for (const path of HUB_ARTIFACTS) {
    assert.equal(lstatOrNull(join(c.repo, path)), null, `${path} must not exist`);
  }
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function startArgs(overrides = {}) {
  const options = { harness: 'claude-code', capabilities: 'shell,network,subagents', 'git-commits': 'allowed', ...overrides };
  return ['start', ...Object.entries(options).filter(([, value]) => value !== undefined).map(([name, value]) => `--${name}=${value}`)];
}

test('start in an empty directory creates the ignored area first and an initial descriptor without Git', () => {
  withCase('start-plain', (c) => {
    const before = snapshot(c.repo);
    const { status, output } = cli(c, ...startArgs());
    assert.equal(status, 0);
    assert.deepEqual(Object.keys(output), ['ok', 'command', 'runId', 'descriptor']);
    assert.equal(output.command, 'start');
    assert.match(output.runId, RUN_ID_PATTERN);
    assert.equal(output.descriptor, RUN_DESCRIPTOR_PATH);
    assert.deepEqual(Object.keys(snapshot(c.repo)).sort(), [
      '.apex', '.apex/inception', '.apex/inception/.gitignore', '.apex/inception/run.json',
    ]);
    assert.equal(readFileSync(join(c.repo, INCEPTION_GITIGNORE), 'utf8'), '*\n');
    const bytes = readFileSync(join(c.repo, RUN_DESCRIPTOR_PATH), 'utf8');
    assert.equal(bytes, serializeRunDescriptor(createRunDescriptor({
      runId: output.runId,
      harnessName: 'claude-code',
      capabilities: ['shell', 'network', 'subagents'],
      git: { present: false, branch: null, commits: 'none' },
    })));
    assertConfinedToArea(c, before);
    assert.equal(lstatOrNull(join(c.repo, '.gitignore')), null, 'the root .gitignore is never created');
  });
});

test('start in a Git repository observes the branch, keeps the area untracked, and never edits the root .gitignore', () => {
  withCase('start-git', (c) => {
    git(c, 'init', '--quiet', '-b', 'main');
    writeFile(c, '.gitignore', 'node_modules\n');
    const before = snapshot(c.repo, { exclude: ['.git'] });
    const { status, output } = cli(c, ...startArgs({ capabilities: '', 'git-commits': 'forbidden' }));
    assert.equal(status, 0);
    const descriptor = readDescriptor(c);
    assert.deepEqual(descriptor.git, { present: true, branch: 'main', commits: 'forbidden' });
    assert.deepEqual(Object.values(descriptor.harness.capabilities), [false, false, false, false, false, false]);
    assert.equal(descriptor.runId, output.runId);
    assert.equal(readFileSync(join(c.repo, '.gitignore'), 'utf8'), 'node_modules\n');
    assert.equal(git(c, 'status', '--porcelain=v1', '--untracked-files=all'), '?? .gitignore\n');
    assertConfinedToArea(c, before, { exclude: ['.git'] });
  });
});

test('start records a detached HEAD as a null branch', () => {
  withCase('start-detached', (c) => {
    git(c, 'init', '--quiet', '-b', 'main');
    writeFile(c, 'README.md', 'x\n');
    git(c, 'add', 'README.md');
    git(c, 'commit', '--quiet', '-m', 'init');
    git(c, 'checkout', '--quiet', '--detach');
    assert.equal(cli(c, ...startArgs()).status, 0);
    assert.deepEqual(readDescriptor(c).git, { present: true, branch: null, commits: 'allowed' });
  });
});

test('start refuses an existing hub, an existing descriptor, or a foreign area .gitignore without writing', () => {
  const fixtures = [
    { label: 'hub index present', setup(c) { writeHub(c); }, error: /_INDEX\.md/u },
    { label: 'valid descriptor present', setup(c) { writeDescriptor(c, baseDescriptor()); }, error: /descriptor/u },
    { label: 'invalid descriptor present', setup(c) { writeArea(c, 'not json'); }, error: /descriptor/u },
    { label: 'foreign .gitignore bytes', setup(c) { writeFile(c, INCEPTION_GITIGNORE, '*\n!run.json\n'); }, error: /\.gitignore/u },
    { label: 'empty .gitignore', setup(c) { writeFile(c, INCEPTION_GITIGNORE, ''); }, error: /\.gitignore/u },
    {
      label: 'symlinked .gitignore',
      setup(c) {
        writeFile(c, 'ignore', '*\n');
        mkdirSync(join(c.repo, INCEPTION_AREA), { recursive: true });
        symlinkSync(join(c.repo, 'ignore'), join(c.repo, INCEPTION_GITIGNORE));
      },
      error: /\.gitignore/u,
    },
    {
      label: 'symlinked area',
      setup(c) { mkdirSync(join(c.repo, 'real-area')); mkdirSync(join(c.repo, '.apex')); symlinkSync(join(c.repo, 'real-area'), join(c.repo, INCEPTION_AREA)); },
      error: /real directory/u,
    },
  ];
  for (const fixture of fixtures) {
    withCase('start-refused', (c) => {
      fixture.setup(c);
      const before = snapshot(c.repo);
      const { status, output } = cli(c, ...startArgs());
      assert.equal(status, 1, fixture.label);
      assert.match(output.error, fixture.error, fixture.label);
      assert.deepEqual(snapshot(c.repo), before, `${fixture.label}: refusal must not write`);
    });
  }
});

test('start validates its options: enums and capability names are usage errors, an unsafe harness slug refuses', () => {
  const cases = [
    { overrides: { harness: undefined }, status: 2, error: /--harness/u },
    { overrides: { capabilities: undefined }, status: 2, error: /--capabilities/u },
    { overrides: { 'git-commits': undefined }, status: 2, error: /--git-commits/u },
    { overrides: { 'git-commits': 'none' }, status: 2, error: /--git-commits/u },
    { overrides: { capabilities: 'shell,telepathy' }, status: 2, error: /telepathy/u },
    { overrides: { capabilities: 'shell,,network' }, status: 2, error: /capabilit/u },
    { overrides: { capabilities: 'shell,shell' }, status: 2, error: /shell/u },
    { overrides: { harness: 'Claude Code' }, status: 1, error: /--harness/u },
    { overrides: { harness: '-leading-dash' }, status: 1, error: /--harness/u },
  ];
  for (const { overrides, status, error } of cases) {
    withCase('start-options', (c) => {
      const result = cli(c, ...startArgs(overrides));
      assert.equal(result.status, status, JSON.stringify(overrides));
      assert.match(result.output.error, error, JSON.stringify(overrides));
      assert.deepEqual(snapshot(c.repo), {}, 'a refused start writes nothing');
    });
  }
});

// Points the test process's own GIT_DIR at another repository for the duration of `fn`: an
// in-process helper call that inherited the ambient environment would observe that repository.
function withLeakingGitDir(c, fn) {
  const leak = join(c.base, 'leak');
  mkdirSync(leak);
  const init = spawnSync('git', ['init', '--quiet', '-b', 'leak'], { cwd: leak, env: c.env, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = join(leak, '.git');
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  }
}

test('startRun writes the area .gitignore before the descriptor and runs Git only with the given env', () => {
  withCase('start-seam', (c) => {
    const options = {
      harnessName: 'codex',
      capabilities: ['shell'],
      gitCommits: 'allowed',
      now: new Date('2026-10-07T12:00:00.000Z'),
      randomHex: '0badcafe',
      env: c.env,
    };
    withLeakingGitDir(c, () => {
      assert.throws(
        () => startRun(c.repo, { ...options, replaceFile() { throw new Error('descriptor write failed'); } }),
        /descriptor write failed/u,
      );
      assert.equal(readFileSync(join(c.repo, INCEPTION_GITIGNORE), 'utf8'), '*\n');
      assert.equal(lstatOrNull(join(c.repo, RUN_DESCRIPTOR_PATH)), null);

      const result = startRun(c.repo, options);
      assert.deepEqual(result, { runId: 'inc-20261007T120000Z-0badcafe', descriptor: RUN_DESCRIPTOR_PATH });
    });
    assert.equal(readDescriptor(c).harness.name, 'codex');
    assert.deepEqual(readDescriptor(c).git, { present: false, branch: null, commits: 'none' }, 'the ambient GIT_DIR never leaks in');
    assert.deepEqual(readdirSync(join(c.repo, INCEPTION_AREA)).sort(), ['.gitignore', 'run.json']);
  });
});

test('replaceFileAtomic replaces the descriptor and leaves it byte-identical when a write fails', () => {
  withCase('replace', (c) => {
    writeDescriptor(c, baseDescriptor());
    const target = join(c.repo, RUN_DESCRIPTOR_PATH);
    const before = readFileSync(target);
    assert.throws(
      () => replaceFileAtomic(target, text(baseDescriptor({ phase: 'architecture' })), {
        writeToFd() { throw new Error('disk full'); },
      }),
      /disk full/u,
    );
    assert.deepEqual(readFileSync(target), before);
    assert.deepEqual(readdirSync(join(c.repo, INCEPTION_AREA)).filter((name) => name.endsWith('.tmp')), []);
    assert.deepEqual(readdirSync(join(c.repo, INCEPTION_AREA)).sort(), ['.gitignore', 'run.json']);

    replaceFileAtomic(target, text(baseDescriptor({ phase: 'architecture' })));
    assert.equal(readFileSync(target, 'utf8'), text(baseDescriptor({ phase: 'architecture' })));
    assert.equal(lstatSync(target).nlink, 1);
    assert.deepEqual(readdirSync(join(c.repo, INCEPTION_AREA)).sort(), ['.gitignore', 'run.json']);
  });
});

test('replaceFileAtomic removes its temp file even when closing the temp file fails', () => {
  withCase('replace-close', (c) => {
    writeDescriptor(c, baseDescriptor());
    const target = join(c.repo, RUN_DESCRIPTOR_PATH);
    const before = readFileSync(target);
    const next = text(baseDescriptor({ phase: 'architecture' }));
    const failures = {
      // The success-path close fails after really closing the descriptor.
      'close throws': {
        options: { closeFd(fd) { closeSync(fd); throw new Error('close failed'); } },
        error: /close failed/u,
      },
      // Someone else closed the descriptor: fsync fails and a second close would fail too.
      'descriptor closed underneath': {
        options: { writeToFd(fd, buffer, offset, length) { const count = writeSync(fd, buffer, offset, length); closeSync(fd); return count; } },
        error: /EBADF/u,
      },
    };
    for (const [label, { options, error }] of Object.entries(failures)) {
      assert.throws(() => replaceFileAtomic(target, next, options), error, label);
      assert.deepEqual(readFileSync(target), before, `${label}: the descriptor stays byte-identical`);
      assert.deepEqual(readdirSync(join(c.repo, INCEPTION_AREA)).sort(), ['.gitignore', 'run.json'], `${label}: only the temp file is removed`);
    }
  });
});

// Raw v1 reader/archive fixtures; public active flows below use v2.
const REGISTER = '.apex/inception/project/decision-register.md';
const RESULTS = '.apex/inception/verification/results.md';

function transition(c, to, ...extra) {
  return cli(c, 'transition', '--to', to, '--reason', `move to ${to}`, ...extra);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function digestOf(c, path) {
  const bytes = readFileSync(join(c.repo, path));
  return { path, bytes: bytes.length, sha256: sha256(bytes) };
}

function intentLine(id, kind = 'install', overrides = {}) {
  return JSON.stringify({
    schema: 'steepy-inception-effect/v1', type: 'intent', id, kind, summary: `run ${id}`,
    authorization: null, phase: 'architecture', at: '2026-10-07T12:00:00.000Z', ...overrides,
  });
}

function outcomeLine(id, overrides = {}) {
  return JSON.stringify({
    schema: 'steepy-inception-effect/v1', type: 'outcome', id, result: 'succeeded', observed: `observed ${id}`,
    phase: 'architecture', at: '2026-10-07T12:00:01.000Z', ...overrides,
  });
}

const ABANDONED = '.apex/inception/abandoned';

function populateRunChildren(c) {
  writeFile(c, '.apex/inception/approvals/0002.json', '{"record":2}\n');
  writeFile(c, '.apex/inception/checkpoints/0003.json', '{"record":3}\n');
  writeFile(c, '.apex/inception/project/decision-register.md', '# Decisions\n');
  writeFile(c, '.apex/inception/project/nested/deep.md', '# Deep\n');
  writeFile(c, '.apex/inception/research/stack.md', '# Stack\n');
  writeFile(c, '.apex/inception/bootstrap/web.md', '# Web\n');
  writeFile(c, '.apex/inception/verification/results.md', '# Results\n');
  writeFile(c, '.apex/inception/effects.jsonl', '{"type":"intent"}\n');
  writeFile(c, '.apex/inception/.DS_Store', 'finder');
}

// Where every pre-abandon file must be afterwards: run children move under the archive.
function expectedAfterAbandon(before, archive) {
  return Object.fromEntries(Object.entries(before).map(([path, content]) => {
    const rest = path.startsWith(`${INCEPTION_AREA}/`) ? path.slice(INCEPTION_AREA.length + 1) : null;
    const child = rest?.split('/')[0];
    return [rest !== null && RUN_CHILDREN.includes(child) ? `${archive}/${rest}` : path, content];
  }));
}

function abandonRecord(c, archive) {
  return readFileSync(join(c.repo, archive, 'abandon.json'), 'utf8');
}

test('abandon archives every present run child byte-identical, deletes nothing, and frees the area for a new run', () => {
  withCase('abandon', (c) => {
    const first = cli(c, ...startArgs()).output.runId;
    assert.equal(transition(c, 'architecture').status, 0);
    assert.equal(cli(c, 'resume-note', '--next', 'continue').status, 0);
    populateRunChildren(c);
    const before = files(c.repo);
    const archive = `.apex/inception/abandoned/${first}`;

    const { status, output } = cli(c, 'abandon', '--reason', 'restart with a smaller scope');
    assert.equal(status, 0);
    assert.deepEqual(output, { ok: true, command: 'abandon', archive });

    const after = files(c.repo);
    const record = abandonRecord(c, archive);
    for (const [path, bytes] of Object.entries(expectedAfterAbandon(before, archive))) assert.equal(after[path], bytes);
    assert.equal(after[`${archive}/run.json`], before[RUN_DESCRIPTOR_PATH], 'the descriptor moves byte-identical');
    assert.equal(after[INCEPTION_GITIGNORE], '*\n');
    const parsed = JSON.parse(record);
    assert.equal(parsed.schema, 'steepy-inception-abandon/v2');
    assert.equal(parsed.runId, first);
    assert.equal(parsed.reason, 'restart with a smaller scope');
    assert.equal(parsed.descriptor.path, `${archive}/run.json`);
    assert.equal(JSON.parse(after[`${archive}/intent.json`]).status, 'prepared');
    assert.equal(JSON.parse(after[`${INCEPTION_AREA}/abandon-intent.json`]).status, 'complete');
    assert.match(parsed.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);

    assert.deepEqual(cli(c, 'classify', '--maturity', 'suitable').output, {
      ok: true, command: 'classify', row: 'start-new-run', hub: 'absent', run: 'none',
    });

    const firstArchive = snapshot(join(c.repo, archive));
    const second = cli(c, ...startArgs()).output.runId;
    assert.notEqual(second, first);
    assert.equal(cli(c, 'abandon', '--reason', 'second thoughts').output.archive, `.apex/inception/abandoned/${second}`);
    assert.ok(existsSync(join(c.repo, `.apex/inception/abandoned/${second}/receipt.json`)));
    assert.deepEqual(snapshot(join(c.repo, archive)), firstArchive, 'an earlier archive is never touched');
    assert.equal(cli(c, 'classify').output.row, 'maturity-decision-required');
  });
});

test('abandon refuses a foreign or ambiguous archive and unsafe input without writing', () => {
  const fixtures = [
    { label: 'archive without a record', setup(c, archive) { mkdirSync(join(c.repo, archive), { recursive: true }); }, error: /exists|real directory/u },
    {
      label: 'archive of another run',
      setup(c, archive) { writeFile(c, `${archive}/abandon.json`, text({ schema: 'steepy-inception-abandon/v1', runId: 'inc-20261007T120000Z-ffffffff', at: '2026-10-07T12:00:00.000Z', reason: 'r', phase: 'reconnaissance', status: 'active' })); },
      error: /exists|real directory/u,
    },
    { label: 'malformed archive record', setup(c, archive) { writeFile(c, `${archive}/abandon.json`, '{}\n'); }, error: /exists|real directory/u },
    {
      label: 'archive record with a duplicate runId',
      setup(c, archive, runId) {
        const record = text({ schema: 'steepy-inception-abandon/v1', runId, at: '2026-10-07T12:00:00.000Z', reason: 'r', phase: 'reconnaissance', status: 'active' });
        writeFile(c, `${archive}/abandon.json`, insertAfter(record, '{\n', '  "runId": "inc-20261007T120000Z-ffffffff",\n'));
      },
      error: /exists|real directory/u,
    },
    {
      label: 'archive record with an invalid UTF-8 byte',
      setup(c, archive, runId) {
        const [head, tail] = text({ schema: 'steepy-inception-abandon/v1', runId, at: '2026-10-07T12:00:00.000Z', reason: 'r', phase: 'reconnaissance', status: 'active' }).split('"reason": "r"');
        writeFile(c, `${archive}/abandon.json`, Buffer.concat([Buffer.from(`${head}"reason": "r`), Buffer.from([0xff]), Buffer.from(`"${tail}`)]));
      },
      error: /exists|real directory/u,
    },
    {
      label: 'child at both source and archive',
      setup(c, archive, runId) {
        writeFile(c, `${archive}/abandon.json`, text({ schema: 'steepy-inception-abandon/v1', runId, at: '2026-10-07T12:00:00.000Z', reason: 'r', phase: 'reconnaissance', status: 'active' }));
        writeFile(c, `${archive}/project/old.md`, 'old\n');
        writeFile(c, '.apex/inception/project/new.md', 'new\n');
      },
      error: /exists|real directory/u,
    },
    {
      label: 'symlinked archive',
      setup(c, archive) { mkdirSync(join(c.repo, 'elsewhere')); mkdirSync(join(c.repo, ABANDONED)); symlinkSync(join(c.repo, 'elsewhere'), join(c.repo, archive)); },
      error: /exists|real directory/u,
    },
    { label: 'abandoned is a file', setup(c) { writeFile(c, ABANDONED, 'x'); }, error: /exists|real directory/u },
  ];
  for (const fixture of fixtures) {
    withCase('abandon-refused', (c) => {
      const runId = cli(c, ...startArgs()).output.runId;
      fixture.setup(c, `${ABANDONED}/${runId}`, runId);
      const before = snapshot(c.repo);
      const { status, output } = cli(c, 'abandon', '--reason', 'stop');
      assert.equal(status, 1, fixture.label);
      assert.match(output.error, fixture.error, fixture.label);
      assert.deepEqual(snapshot(c.repo), before, `${fixture.label}: refusal must not write`);
    });
  }
  withCase('abandon-options', (c) => {
    assert.equal(cli(c, 'abandon', '--reason', 'stop').status, 1, 'no run to abandon');
    cli(c, ...startArgs());
    const before = snapshot(c.repo);
    assert.equal(cli(c, 'abandon').status, 2);
    assert.equal(cli(c, 'abandon', '--reason=').status, 1);
    assert.equal(cli(c, 'abandon', '--reason', 'stop', '--to', 'approval').status, 2);
    assert.deepEqual(snapshot(c.repo), before);
  });
});


// ---------------------------------------------------------------------------
// Cross-command invariants (SC2, SC3)
// ---------------------------------------------------------------------------

test('an invalid descriptor refuses every command without writing', () => {
  const fixtures = [
    { label: 'invalid JSON', setup(c) { writeArea(c, '{'); } },
    { label: 'invalid UTF-8 byte', setup(c) { writeArea(c, invalidUtf8Descriptor()); } },
    { label: 'duplicate key', setup(c) { writeArea(c, insertAfter(text(baseDescriptor()), '{\n', '  "status": "blocked",\n')); } },
    { label: 'extra key', setup(c) { writeDescriptor(c, { ...baseDescriptor(), extra: 1 }); } },
    {
      label: 'hard-linked descriptor',
      setup(c) { writeDescriptor(c, baseDescriptor()); linkSync(join(c.repo, RUN_DESCRIPTOR_PATH), join(c.repo, 'copy.json')); },
    },
    {
      label: 'symlinked descriptor',
      setup(c) {
        writeFile(c, 'elsewhere/run.json', text(baseDescriptor()));
        writeFile(c, INCEPTION_GITIGNORE, '*\n');
        symlinkSync(join(c.repo, 'elsewhere/run.json'), join(c.repo, RUN_DESCRIPTOR_PATH));
      },
    },
    {
      label: 'symlinked .apex',
      setup(c) {
        writeFile(c, 'real-apex/inception/.gitignore', '*\n');
        writeFile(c, 'real-apex/inception/run.json', text(baseDescriptor()));
        symlinkSync(join(c.repo, 'real-apex'), join(c.repo, '.apex'));
      },
    },
  ];
  const commands = [
    ['classify', '--maturity', 'suitable'],
    startArgs(),
    ['transition', '--to', 'architecture', '--reason', 'next'],
    ['transition', '--to', 'blocked', '--reason', 'stop'],
    ['transition', '--to', 'complete', '--reason', 'done', '--checkpoint', '.apex/inception/checkpoints/0001.json', '--verification', RESULTS],
    ['resume-note', '--next', 'continue'],
    ['approve', '--statement', 'yes', '--document', REGISTER],
    ['verify-approval'],
    ['effect', 'intent', '--id', 'install-deps', '--input', REGISTER],
    ['effect', 'outcome', '--id', 'install-deps', '--input', REGISTER],
    ['effect', 'status'],
    ['checkpoint', 'create', '--label', 'x', '--file', 'package.json'],
    ['checkpoint', 'verify'],
    ['abandon', '--reason', 'stop'],
  ];
  for (const fixture of fixtures) {
    withCase('invalid-every-command', (c) => {
      fixture.setup(c);
      for (const args of commands) {
        const before = snapshot(c.repo);
        const { status, output } = cli(c, ...args);
        assert.equal(status, 1, `${fixture.label}: ${args[0]}`);
        assert.equal(output.ok, false);
        assert.deepEqual(snapshot(c.repo), before, `${fixture.label}: ${args[0]} must not write`);
      }
    });
  }
});


// Paths outside the area (and `.apex/` itself, which `start` creates) keep their exact bytes,
// link counts, and mtimes.


// Active flow fixtures use public v2 start; legacy fixtures above and below remain raw.
const stateV2 = await import('../scripts/inception-state.mjs');
function fixtureV2() {
  const root = mkdtempSync(join(tmpdir(), 'steepy-inception-publication-'));
  startRun(root, { harnessName: 'codex', gitCommits: 'forbidden', now: new Date('2026-10-07T12:00:00.000Z'), randomHex: '1a2b3c4d' });
  return root;
}
const readV2 = root => parseRunDescriptor(readFileSync(join(root, RUN_DESCRIPTOR_PATH), 'utf8'));
const reportV2 = id => `<!-- steepy-inception-unit: v2; id: ${id}; status: DONE -->\nComplete report\n<!-- steepy-inception-unit-end: ${id} -->\n`;
const unitInputV2 = id => ({ kind: 'publication', inputs: [], outputs: [{ path: `${INCEPTION_AREA}/project/${id}.md`, role: 'report' }], allowedPaths: [] });

test('v2 units exclude other writers, require complete reports and freeze output bytes', () => {
  const root = fixtureV2();
  try {
    stateV2.beginUnit(root, { id: 'first', input: unitInputV2('first') });
    assert.equal(readV2(root).activeUnit, 'first');
    assert.throws(() => stateV2.beginUnit(root, { id: 'second', input: unitInputV2('second') }), /activeUnit/);
    assert.throws(() => stateV2.writeResumeNote(root, { next: 'Continue' }), /activeUnit/);
    assert.throws(() => stateV2.finishUnit(root, { id: 'first' }), /does not exist/);
    mkdirSync(join(root, INCEPTION_AREA, 'project'));
    const output = join(root, unitInputV2('first').outputs[0].path);
    for (const bad of ['partial', reportV2('other'), reportV2('first').replace('DONE', 'BLOCKED'), reportV2('first') + 'trailing']) {
      writeFileSync(output, bad);
      assert.throws(() => stateV2.finishUnit(root, { id: 'first' }), /report/);
      assert.equal(readV2(root).activeUnit, 'first');
    }
    writeFileSync(output, reportV2('first'));
    stateV2.finishUnit(root, { id: 'first' });
    const done = readV2(root);
    assert.equal(done.activeUnit, null);
    assert.equal(done.units[0].state, 'completed');
    const frozen = done.units[0].evidence[0];
    assert.equal(frozen.path, `${INCEPTION_AREA}/units/first/outputs/0001.bin`);
    writeFileSync(output, 'later working copy');
    assert.equal(readFileSync(join(root, frozen.path), 'utf8'), reportV2('first'));
    assert.throws(() => stateV2.beginUnit(root, { id: 'first', input: unitInputV2('first') }), /already/);
    assert.throws(() => stateV2.finishUnit(root, { id: 'first' }), /activeUnit/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('v2 expansion refuses undeclared application outputs and stale revisions without mutation', () => {
  const root = fixtureV2();
  try {
    const original = readFileSync(join(root, RUN_DESCRIPTOR_PATH));
    for (const input of [ { ...unitInputV2('bad'), outputs: [{ path: 'app.js', role: 'report' }] } ]) {
      assert.throws(() => stateV2.beginUnit(root, { id: 'bad', input }), /snapshot|application/);
    }
    assert.throws(() => stateV2.beginUnit(root, { id: 'stale', input: unitInputV2('stale'), expectedRevision: 2 }), /revision/);
    assert.deepEqual(readFileSync(join(root, RUN_DESCRIPTOR_PATH)), original);
    stateV2.transitionRun(root, { to: 'architecture', reason: 'Recorded decision' });
    assert.equal(readV2(root).phase, 'architecture');
    assert.throws(() => stateV2.transitionRun(root, { to: 'architecture', reason: 'Repeat' }), /transition/);
    stateV2.transitionRun(root, { to: 'research', reason: 'Recorded research' });
    stateV2.transitionRun(root, { to: 'approval', reason: 'Ready for approval' });
    assert.throws(() => stateV2.transitionRun(root, { to: 'bootstrap', reason: 'Unverified' }), /approval/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const event of ['before-reserve', 'after-reserve', 'before-stage', 'after-stage', 'before-rename', 'after-rename', 'before-bind', 'after-bind', 'before-descriptor-replace', 'after-descriptor-replace']) {
  test(`v2 publication survives process interruption at ${event} without writer replay`, () => {
    const root = fixtureV2();
    try {
      const script = `import { writeResumeNote } from ${JSON.stringify(new URL('../scripts/inception-state.mjs', import.meta.url).href)}; writeResumeNote(${JSON.stringify(root)}, { next: 'Continue', reservation: 'crash-note', fault: event => { if (event === ${JSON.stringify(event)}) process.exit(73); } });`;
      const crash = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
      assert.equal(crash.status, 73, crash.stderr);
      const resume = spawnSync(process.execPath, [SCRIPT, 'publish', 'resume', '--repo-root', root, '--reservation', 'crash-note'], { encoding: 'utf8' });
      if (event === 'before-reserve') {
        assert.equal(resume.status, 1);
        assert.equal(readV2(root).revision, 1);
      } else {
        assert.equal(resume.status, 0, resume.stderr);
        const done = readV2(root);
        assert.equal(done.pending, null);
        assert.equal(done.revision, 2);
        assert.equal(done.resumeNotes.length, 1);
        assert.match(readFileSync(join(root, done.resumeNotes[0].path), 'utf8'), /Continue/);
        const before = lstatSync(join(root, RUN_DESCRIPTOR_PATH)).mtimeMs;
        const again = stateV2.resumePublication(root, { reservation: 'crash-note' });
        assert.equal(again.noop, true);
        assert.equal(lstatSync(join(root, RUN_DESCRIPTOR_PATH)).mtimeMs, before);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('v2 publication preserves partial staging generations and refuses divergent final files', () => {
  const root = fixtureV2();
  try {
    let temp;
    assert.throws(() => stateV2.writeResumeNote(root, { next: 'Continue', reservation: 'partial', fault: (event, data) => {
      if (event === 'before-stage') { temp = data.tempPath; writeFileSync(join(root, temp), 'partial'); throw new Error('injected'); }
    } }), /injected/);
    stateV2.resumePublication(root, { reservation: 'partial' });
    assert.equal(readFileSync(join(root, temp), 'utf8'), 'partial');
    const note = readV2(root).resumeNotes[0];
    writeFileSync(join(root, note.path), 'divergent');
    assert.throws(() => stateV2.resumePublication(root, { reservation: 'partial' }), /divergen|digest/);
    assert.equal(readFileSync(join(root, note.path), 'utf8'), 'divergent');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('v2 reservation preflight rejects foreign targets and pending blocks every fresh mutation', () => {
  const root = fixtureV2();
  try {
    mkdirSync(join(root, INCEPTION_AREA, 'resume-notes'));
    const foreign = join(root, INCEPTION_AREA, 'resume-notes/0001.md');
    writeFileSync(foreign, 'foreign');
    assert.throws(() => stateV2.writeResumeNote(root, { next: 'Continue' }), /already|foreign/);
    assert.equal(readV2(root).pending, null);
    rmSync(foreign);
    assert.throws(() => stateV2.writeResumeNote(root, { next: 'Continue', reservation: 'reserved', fault: event => { if (event === 'after-reserve') throw new Error('stop'); } }), /stop/);
    assert.throws(() => stateV2.writeResumeNote(root, { next: 'Other' }), /pending/);
    assert.throws(() => stateV2.beginUnit(root, { id: 'other', input: unitInputV2('other') }), /pending/);
    assert.throws(() => stateV2.transitionRun(root, { to: 'architecture', reason: 'Other' }), /pending/);
    assert.throws(() => stateV2.resumePublication(root, { reservation: 'wrong' }), /reservation/);
    const target = readV2(root).pending.targets[0];
    writeFileSync(join(root, target.path), 'broken');
    assert.throws(() => stateV2.resumePublication(root, { reservation: 'reserved' }), /divergen|digest/);
    assert.equal(readFileSync(join(root, target.path), 'utf8'), 'broken');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('v2 multi-target finish resumes an ordered prefix and never reads changed working copies', () => {
  const root = fixtureV2();
  try {
    const input = unitInputV2('multiple');
    input.outputs.push({ path: `${INCEPTION_AREA}/project/decision.md`, role: 'decision' });
    stateV2.beginUnit(root, { id: 'multiple', input });
    mkdirSync(join(root, INCEPTION_AREA, 'project'));
    writeFileSync(join(root, input.outputs[0].path), reportV2('multiple'));
    writeFileSync(join(root, input.outputs[1].path), 'Approved decision');
    assert.throws(() => stateV2.finishUnit(root, { id: 'multiple', reservation: 'finish-multiple', fault: event => { if (event === 'after-rename') throw new Error('stop'); } }), /stop/);
    writeFileSync(join(root, input.outputs[0].path), 'changed working copy');
    writeFileSync(join(root, input.outputs[1].path), 'changed decision');
    const resumed = spawnSync(process.execPath, [SCRIPT, 'publish', 'resume', '--repo-root', root, '--reservation', 'finish-multiple'], { encoding: 'utf8' });
    assert.equal(resumed.status, 0, resumed.stderr);
    const done = readV2(root);
    assert.equal(done.units[0].state, 'completed');
    assert.equal(readFileSync(join(root, done.units[0].evidence[1].path), 'utf8'), 'Approved decision');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('v2 public lease excludes a second process and unit ownership survives lease release', () => {
  const root = fixtureV2();
  try {
    let competing;
    stateV2.beginUnit(root, { id: 'owner', input: unitInputV2('owner'), fault: event => {
      if (event === 'before-reserve') competing = spawnSync(process.execPath, [SCRIPT, 'resume-note', '--repo-root', root, '--next', 'Contender'], { encoding: 'utf8' });
    } });
    assert.equal(competing.status, 1);
    assert.match(competing.stderr, /lock|owner|lease/);
    const next = spawnSync(process.execPath, [SCRIPT, 'resume-note', '--repo-root', root, '--next', 'Contender'], { encoding: 'utf8' });
    assert.equal(next.status, 1);
    assert.match(next.stderr, /activeUnit/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('v2 unit CLI strictly validates declared input and requires a report output', () => {
  const root = fixtureV2();
  try {
    const inputPath = `${INCEPTION_AREA}/unit-input.json`;
    for (const input of [{ ...unitInputV2('cli'), extra: true }, { ...unitInputV2('cli'), outputs: [] }]) {
      writeFileSync(join(root, inputPath), JSON.stringify(input));
      const invalid = spawnSync(process.execPath, [SCRIPT, 'unit', 'begin', '--repo-root', root, '--id', 'cli', '--input', inputPath], { encoding: 'utf8' });
      assert.equal(invalid.status, 1);
      assert.equal(readV2(root).units.length, 0);
    }
    writeFileSync(join(root, inputPath), JSON.stringify(unitInputV2('cli')));
    const begin = spawnSync(process.execPath, [SCRIPT, 'unit', 'begin', '--repo-root', root, '--id', 'cli', '--input', inputPath], { encoding: 'utf8' });
    assert.equal(begin.status, 0, begin.stderr);
    mkdirSync(join(root, INCEPTION_AREA, 'project'));
    writeFileSync(join(root, unitInputV2('cli').outputs[0].path), reportV2('cli'));
    const finish = spawnSync(process.execPath, [SCRIPT, 'unit', 'finish', '--repo-root', root, '--id', 'cli'], { encoding: 'utf8' });
    assert.equal(finish.status, 0, finish.stderr);
    const invalidFlag = spawnSync(process.execPath, [SCRIPT, 'publish', 'resume', '--repo-root', root, '--reservation', 'x', '--fault', 'after-stage'], { encoding: 'utf8' });
    assert.equal(invalidFlag.status, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('v2 publication checks every target before writes and rejects a non-prefix final set', () => {
  for (const divergent of [true, false]) {
    const root = fixtureV2();
    try {
      const input = unitInputV2('ordered');
      input.outputs.push({ path: `${INCEPTION_AREA}/project/extra.md`, role: 'decision' });
      stateV2.beginUnit(root, { id: 'ordered', input });
      mkdirSync(join(root, INCEPTION_AREA, 'project'));
      writeFileSync(join(root, input.outputs[0].path), reportV2('ordered'));
      writeFileSync(join(root, input.outputs[1].path), 'extra');
      assert.throws(() => stateV2.finishUnit(root, { id: 'ordered', reservation: 'ordered-finish', fault: event => { if (event === 'after-reserve') throw new Error('stop'); } }), /stop/);
      const targets = readV2(root).pending.targets;
      mkdirSync(join(root, INCEPTION_AREA, 'units/ordered/outputs'), { recursive: true });
      writeFileSync(join(root, targets[1].path), divergent ? 'divergent' : Buffer.from(targets[1].contentBase64, 'base64'));
      assert.throws(() => stateV2.resumePublication(root, { reservation: 'ordered-finish' }), /divergen|digest|prefix/);
      assert.throws(() => lstatSync(join(root, targets[0].path)), { code: 'ENOENT' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('start, checkpoint and abandon cooperate with the existing public scaffold lease', async () => {
  const { withProjectScaffoldLock } = await import('../scripts/project-scaffold.mjs');
  const root = mkdtempSync(join(tmpdir(), 'steepy-inception-lease-'));
  try {
    withProjectScaffoldLock({ hubRoot: root }, () => {
      const start = spawnSync(process.execPath, [SCRIPT, 'start', '--repo-root', root, '--harness', 'codex', '--capabilities', 'shell', '--git-commits', 'forbidden'], { encoding: 'utf8' });
      assert.equal(start.status, 1);
      assert.match(start.stderr, /lock|owner|lease/);
    });
    startRun(root, { harnessName: 'codex', capabilities: ['shell'], gitCommits: 'forbidden' });
    writeFileSync(join(root, 'app.js'), 'app');
    withProjectScaffoldLock({ hubRoot: root }, () => {
      for (const args of [['checkpoint', 'create', '--label', 'Before'], ['abandon', '--reason', 'Explicit archive']]) {
        const result = spawnSync(process.execPath, [SCRIPT, ...args, '--repo-root', root], { encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /lock|owner|lease/);
      }
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a pre-existing staging file is not adopted by a fresh reservation', () => {
  const root = fixtureV2();
  try {
    mkdirSync(join(root, INCEPTION_AREA, 'resume-notes'));
    const foreign = `${INCEPTION_AREA}/resume-notes/0001.md.foreign.stage-0001.tmp`;
    writeFileSync(join(root, foreign), 'foreign staging');
    assert.throws(() => stateV2.writeResumeNote(root, { next: 'Continue', reservation: 'foreign' }), /foreign|already/);
    assert.equal(readV2(root).pending, null);
    assert.equal(readFileSync(join(root, foreign), 'utf8'), 'foreign staging');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('R1: cumulative working inputs may change only as declared outputs, with frozen opening provenance', async () => {
  const { publicationRef } = await import('../scripts/inception-protocol.mjs');
  const root = fixtureV2();
  const design = `${INCEPTION_AREA}/project/design.md`;
  const guide = `${INCEPTION_AREA}/project/guide.md`;
  try {
    mkdirSync(join(root, INCEPTION_AREA, 'project'));
    writeFileSync(join(root, design), 'Original design');
    writeFileSync(join(root, guide), 'Read-only instructions');
    for (const [index, id] of ['edit-one', 'edit-two'].entries()) {
      const input = unitInputV2(id);
      input.inputs = [publicationRef(design, readFileSync(join(root, design))), publicationRef(guide, readFileSync(join(root, guide)))];
      input.outputs.push({ path: design, role: 'decision' });
      stateV2.beginUnit(root, { id, input, previousUnit: index === 0 ? null : 'edit-one' });
      const started = readV2(root).units.at(-1);
      const opening = started.evidence.find(ref => ref.path === `${INCEPTION_AREA}/units/${id}/inputs/0001.bin`);
      writeFileSync(join(root, input.outputs[0].path), reportV2(id));
      writeFileSync(join(root, design), `Updated design ${index + 1}`);
      stateV2.finishUnit(root, { id });
      assert.ok(opening, 'begin binds immutable opening bytes before the working copy changes');
      assert.equal(readFileSync(join(root, opening.path), 'utf8'), index === 0 ? 'Original design' : 'Updated design 1');
      assert.equal(readV2(root).units.at(-1).state, 'completed');
    }
    const done = readV2(root);
    for (const [index, unit] of done.units.entries()) {
      const output = unit.evidence.find(ref => ref.path === `${INCEPTION_AREA}/units/${unit.id}/outputs/0002.bin`);
      assert.equal(readFileSync(join(root, output.path), 'utf8'), `Updated design ${index + 1}`);
      assert.equal(unit.inputs[0].sha256, publicationRef(design, index === 0 ? 'Original design' : 'Updated design 1').sha256);
    }
    const input = unitInputV2('read-only-drift');
    input.inputs = [publicationRef(guide, readFileSync(join(root, guide)))];
    stateV2.beginUnit(root, { id: 'read-only-drift', input });
    writeFileSync(join(root, input.outputs[0].path), reportV2('read-only-drift'));
    writeFileSync(join(root, guide), 'Changed instructions');
    assert.throws(() => stateV2.finishUnit(root, { id: 'read-only-drift' }), /input digest is divergent/);
    assert.equal(readV2(root).activeUnit, 'read-only-drift');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('R1: changing frozen opening bytes cannot bypass finish by declaring the live input as an output', async () => {
  const { publicationRef } = await import('../scripts/inception-protocol.mjs');
  const root = fixtureV2();
  try {
    mkdirSync(join(root, INCEPTION_AREA, 'project'));
    const input = unitInputV2('opening-drift');
    const path = `${INCEPTION_AREA}/project/design.md`;
    writeFileSync(join(root, path), 'Opening');
    input.inputs = [publicationRef(path, 'Opening')];
    input.outputs.push({ path, role: 'decision' });
    stateV2.beginUnit(root, { id: 'opening-drift', input });
    const opening = readV2(root).units[0].evidence.find(ref => ref.path.endsWith('/inputs/0001.bin'));
    assert.ok(opening);
    writeFileSync(join(root, opening.path), 'Substituted opening');
    writeFileSync(join(root, path), 'Authorized edit');
    writeFileSync(join(root, input.outputs[0].path), reportV2('opening-drift'));
    assert.throws(() => stateV2.finishUnit(root, { id: 'opening-drift' }), /input|opening|digest/);
    assert.equal(readV2(root).activeUnit, 'opening-drift');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const generation of [2, 4]) for (const matching of [true, false]) {
  test(`R2: pre-existing generation ${generation}, matching=${matching}, is preserved without adoption`, () => {
    const root = fixtureV2();
    try {
      const input = unitInputV2('foreign-later');
      stateV2.beginUnit(root, { id: 'foreign-later', input });
      mkdirSync(join(root, INCEPTION_AREA, 'project'));
      const report = reportV2('foreign-later');
      writeFileSync(join(root, input.outputs[0].path), report);
      const frozen = `${INCEPTION_AREA}/units/foreign-later/outputs/0001.bin`;
      mkdirSync(join(root, INCEPTION_AREA, 'units/foreign-later/outputs'), { recursive: true });
      const foreign = `${frozen}.finish-foreign.stage-${String(generation).padStart(4, '0')}.tmp`;
      const foreignBytes = matching ? report : 'Unowned bytes';
      writeFileSync(join(root, foreign), foreignBytes);
      const partials = [];
      const fault = (event, data) => {
        if (event === 'before-stage') { partials.push(data.tempPath); writeFileSync(join(root, data.tempPath), 'partial'); throw new Error('partial-interruption'); }
      };
      assert.throws(() => stateV2.finishUnit(root, { id: 'foreign-later', reservation: 'finish-foreign', fault }), /partial-interruption/);
      for (let n = 2; n < generation; n += 1) assert.throws(() => stateV2.resumePublication(root, { reservation: 'finish-foreign', fault }), /partial-interruption/);
      const resumed = spawnSync(process.execPath, [SCRIPT, 'publish', 'resume', '--repo-root', root, '--reservation', 'finish-foreign'], { encoding: 'utf8' });
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.equal(readFileSync(join(root, foreign), 'utf8'), foreignBytes, 'foreign generation stays at its original path');
      assert.equal(readFileSync(join(root, frozen), 'utf8'), report);
      for (const partial of partials) assert.equal(readFileSync(join(root, partial), 'utf8'), 'partial');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('R2: an existing staging ownership directory refuses before reservation', () => {
  const root = fixtureV2();
  try {
    const container = `${INCEPTION_AREA}/resume-notes/0001.md.owned.staging`;
    mkdirSync(join(root, container), { recursive: true });
    writeFileSync(join(root, container, '0004.tmp'), 'foreign generation');
    assert.throws(() => stateV2.writeResumeNote(root, { next: 'Continue', reservation: 'owned' }), /foreign|already|ordinary/);
    assert.equal(readV2(root).pending, null);
    assert.equal(readFileSync(join(root, container, '0004.tmp'), 'utf8'), 'foreign generation');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('R2: fresh processes resume complete owned staging after multiple retained partial generations', () => {
  const root = fixtureV2();
  const moduleUrl = new URL('../scripts/inception-state.mjs', import.meta.url).href;
  try {
    for (const attempt of [1, 2, 3]) {
      const invocation = attempt === 1 ? `writeResumeNote(root, { next: 'Continue', reservation: 'generations', fault })` : `resumePublication(root, { reservation: 'generations', fault })`;
      const script = `import { writeResumeNote, resumePublication } from ${JSON.stringify(moduleUrl)}; import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; const root=${JSON.stringify(root)}; const fault=(event,data)=>{ if(event==='before-stage' && ${attempt}<3) {writeFileSync(join(root,data.tempPath),'partial-'+${attempt}); process.exit(73);} if(event==='after-stage' && ${attempt}===3) process.exit(73); }; ${invocation};`;
      const interrupted = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
      assert.equal(interrupted.status, 73, interrupted.stderr);
    }
    const container = `${INCEPTION_AREA}/resume-notes/0001.md.generations.staging`;
    assert.equal(readFileSync(join(root, container, '0001.tmp'), 'utf8'), 'partial-1');
    assert.equal(readFileSync(join(root, container, '0002.tmp'), 'utf8'), 'partial-2');
    const complete = readFileSync(join(root, container, '0003.tmp'));
    const result = spawnSync(process.execPath, [SCRIPT, 'publish', 'resume', '--repo-root', root, '--reservation', 'generations'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(join(root, readV2(root).resumeNotes[0].path)), complete);
    assert.equal(readFileSync(join(root, container, '0001.tmp'), 'utf8'), 'partial-1');
    assert.equal(readFileSync(join(root, container, '0002.tmp'), 'utf8'), 'partial-2');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Task 3: inventories guard every persisted writer and cannot be reset by checkpoints.
test('v2 full snapshots bind unit before/after and checkpoint cannot hide unexplained drift', () => {
  const root = fixtureV2();
  try {
    writeFileSync(join(root, 'app.js'), 'old');
    stateV2.createCheckpoint(root, { label: 'Initial' });
    const baseline = readV2(root).baseline;
    writeFileSync(join(root, 'app.js'), 'unexplained');
    assert.throws(() => stateV2.createCheckpoint(root, { label: 'Hide drift' }), /drift/);
    assert.throws(() => stateV2.beginUnit(root, { id: 'drift', input: unitInputV2('drift') }), /drift/);
    assert.deepEqual(readV2(root).baseline, baseline);
    writeFileSync(join(root, 'app.js'), 'old');
    stateV2.beginUnit(root, { id: 'build', input: { ...unitInputV2('build'), kind: 'bootstrap', allowedPaths: ['app.js'] } });
    assert.ok(readV2(root).units[0].before);
    writeFileSync(join(root, 'app.js'), 'new');
    mkdirSync(join(root, INCEPTION_AREA, 'project')); writeFileSync(join(root, INCEPTION_AREA, 'project/build.md'), reportV2('build'));
    stateV2.finishUnit(root, { id: 'build' });
    assert.ok(readV2(root).units[0].after);
    stateV2.createCheckpoint(root, { label: 'Completed build' });
    assert.equal(stateV2.resumeCheck(root).ok, true);
    writeFileSync(join(root, 'new-file'), 'unexplained addition');
    assert.equal(stateV2.resumeCheck(root).ok, false);
    assert.throws(() => stateV2.createCheckpoint(root, { label: 'Still cannot hide drift' }), /drift/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('v2 unit reconciliation derives changes and requires human acceptance outside declared scope', () => {
  const root = fixtureV2();
  try {
    stateV2.beginUnit(root, { id: 'edit', input: unitInputV2('edit') });
    mkdirSync(join(root, INCEPTION_AREA, 'project'));
    const report = `${INCEPTION_AREA}/project/edit.md`; writeFileSync(join(root, report), reportV2('edit'));
    writeFileSync(join(root, 'outside.js'), 'outside');
    assert.throws(() => stateV2.finishUnit(root, { id: 'edit' }), /unexplained|scope/);
    assert.throws(() => stateV2.reconcileUnit(root, { id: 'edit', input: { evidence: [report], reason: 'Observed change', statement: null } }), /human|statement|scope/);
    stateV2.reconcileUnit(root, { id: 'edit', input: { evidence: [report], reason: 'Observed change', statement: 'I accept outside.js as an application correction.' } });
    const d = readV2(root); assert.equal(d.activeUnit, null); assert.equal(d.currentCycle, null);
    const ref = d.units[0].evidence.find(r => r.path.includes('/reconciliations/'));
    const record = JSON.parse(readFileSync(join(root, ref.path), 'utf8'));
    assert.equal(record.body.changes[0].path, 'outside.js'); assert.equal(record.body.changes[0].before, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
const intentV2 = id => ({ id, kind: 'remote', summary: 'Create exact resource', command: null, procedure: 'Create once', scope: [], authorization: 'User authorized resource creation', correlation: [{ name: 'operation', value: 'exact-token' }], observation: { procedure: 'Read operation identity', expected: 'Exact operation identity matches', evidencePaths: [`${INCEPTION_AREA}/project/observation.json`] } });
test('v2 immutable effects require exact structured correlation, retain partial and preserve other blocks', () => {
  const root = fixtureV2();
  try {
    stateV2.beginUnit(root, { id: 'remote-unit', input: unitInputV2('remote-unit') });
    stateV2.recordEffectIntent(root, { id: 'create', input: intentV2('create') });
    mkdirSync(join(root, INCEPTION_AREA, 'project'));
    const path = `${INCEPTION_AREA}/project/observation.json`;
    const input = { result: 'succeeded', observed: 'Resource exists', correlation: [{ name: 'operation', value: 'exact-token' }], evidence: [path] };
    writeFileSync(join(root, path), JSON.stringify({ name: 'same-looking-resource' }));
    assert.throws(() => stateV2.recordEffectOutcome(root, { id: 'create', input, method: 'reconciled' }), /correlation|observation/);
    const observation = { id: 'create', procedure: 'Read operation identity', result: 'partial', correlation: input.correlation, observed: 'Resource exists' };
    writeFileSync(join(root, path), JSON.stringify(observation));
    stateV2.recordEffectOutcome(root, { id: 'create', input: { ...input, result: 'partial' }, method: 'reconciled' });
    assert.deepEqual(stateV2.effectStatusV2(root).unresolved, ['create']);
    assert.throws(() => stateV2.recordEffectIntent(root, { id: 'create', input: intentV2('create') }), /exists|unresolved/);
    let d = structuredClone(readV2(root)); d.blocks.push({ id: 'other-block', reason: 'Independent decision', evidence: [] }); writeFileSync(join(root, RUN_DESCRIPTOR_PATH), serializeRunDescriptor(d));
    writeFileSync(join(root, path), JSON.stringify({ ...observation, result: 'succeeded' }));
    stateV2.recordEffectOutcome(root, { id: 'create', input, method: 'reconciled' });
    assert.deepEqual(stateV2.effectStatusV2(root).unresolved, []);
    assert.ok(readV2(root).blocks.some(b => b.id === 'other-block'));
    assert.equal(readV2(root).effects.length, 3);
    assert.equal(existsSync(join(root, INCEPTION_AREA, 'effects.jsonl')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('v2 effect publication interruption resumes only reserved records and never replays work', () => {
  const root = fixtureV2();
  try {
    stateV2.beginUnit(root, { id: 'effect-crash', input: unitInputV2('effect-crash') });
    assert.throws(() => stateV2.recordEffectIntent(root, { id: 'create', input: intentV2('create'), reservation: 'intent-crash', fault: event => { if (event === 'after-reserve') throw new Error('interrupted'); } }), /interrupted/);
    assert.equal(readV2(root).effects.length, 0);
    stateV2.resumePublication(root, { reservation: 'intent-crash' });
    assert.deepEqual(stateV2.effectStatusV2(root).unresolved, ['create']);
    const bytes = readFileSync(join(root, readV2(root).effects[0].path));
    assert.equal(stateV2.resumePublication(root, { reservation: 'intent-crash' }).noop, true);
    assert.deepEqual(readFileSync(join(root, readV2(root).effects[0].path)), bytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('v2 completed decision snapshots permit guarded phase progression and reject later drift', () => {
  const root = fixtureV2();
  try {
    const input = { ...unitInputV2('decision'), kind: 'decision' };
    stateV2.beginUnit(root, { id: 'decision', input });
    mkdirSync(join(root, INCEPTION_AREA, 'project')); writeFileSync(join(root, input.outputs[0].path), reportV2('decision'));
    stateV2.finishUnit(root, { id: 'decision' });
    stateV2.transitionRun(root, { to: 'architecture', reason: 'Decision recorded' });
    assert.equal(readV2(root).phase, 'architecture');
    writeFileSync(join(root, 'unexpected'), 'change');
    assert.throws(() => stateV2.transitionRun(root, { to: 'research', reason: 'Continue' }), /drift/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('v2 reconciliation preserves opening input integrity and cannot turn corrupted input into success', async () => {
  const { publicationRef } = await import('../scripts/inception-protocol.mjs');
  const root = fixtureV2();
  try {
    mkdirSync(join(root, INCEPTION_AREA, 'project'));
    const source = `${INCEPTION_AREA}/project/source.md`; writeFileSync(join(root, source), 'Original');
    const input = { ...unitInputV2('reconcile-input'), inputs: [publicationRef(source, 'Original')] };
    stateV2.beginUnit(root, { id: 'reconcile-input', input });
    writeFileSync(join(root, input.outputs[0].path), reportV2('reconcile-input'));
    const frozen = readV2(root).units[0].evidence.find(r => r.path.includes('/inputs/'));
    writeFileSync(join(root, frozen.path), 'Tampered');
    assert.throws(() => stateV2.reconcileUnit(root, { id: 'reconcile-input', input: { evidence: [input.outputs[0].path], reason: 'Finish interrupted writer', statement: 'Accept observed application differences' } }), /input|digest/);
    assert.equal(readV2(root).activeUnit, 'reconcile-input');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('v2 resume-check is read-only and catches bound snapshot corruption independently of blocks', () => {
  const root = fixtureV2();
  try {
    stateV2.createCheckpoint(root, { label: 'Initial inventory' });
    const descriptor = structuredClone(readV2(root)); descriptor.blocks.push({ id: 'human-decision', reason: 'A separate unresolved decision', evidence: [] });
    writeFileSync(join(root, RUN_DESCRIPTOR_PATH), serializeRunDescriptor(descriptor));
    const before = readFileSync(join(root, RUN_DESCRIPTOR_PATH));
    const snap = descriptor.baseline.path; writeFileSync(join(root, snap), '{}\n');
    const first = stateV2.resumeCheck(root); const second = stateV2.resumeCheck(root);
    assert.deepEqual(first, second); assert.equal(first.ok, false);
    assert.ok(first.divergences.some(d => d.kind === 'baseline'));
    assert.ok(first.divergences.some(d => d.id === 'human-decision'));
    assert.deepEqual(readFileSync(join(root, RUN_DESCRIPTOR_PATH)), before);
    const cliResult = spawnSync(process.execPath, [SCRIPT, 'resume-check', '--repo-root', root], { encoding: 'utf8' });
    assert.equal(cliResult.status, 1); assert.equal(JSON.parse(cliResult.stdout).ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('v2 checkpoint CLI rejects file-list substitution and observes whole inventory', () => {
  const root = fixtureV2();
  try {
    writeFileSync(join(root, 'app'), 'v1');
    const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args, '--repo-root', root], { encoding: 'utf8' });
    assert.equal(run('checkpoint', 'create', '--label', 'Partial', '--file', 'app').status, 1);
    assert.equal(readV2(root).baseline, null);
    const created = run('checkpoint', 'create', '--label', 'Whole'); assert.equal(created.status, 0, created.stderr);
    assert.equal(run('checkpoint', 'verify').status, 0);
    writeFileSync(join(root, 'added'), 'new');
    assert.equal(run('checkpoint', 'verify').status, 1);
    assert.equal(run('checkpoint', 'create', '--label', 'Drift').status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('v2 automatic unit reconciliation accepts explained application changes with ordinary Git dirtiness', () => {
  const root = fixtureV2();
  try {
    const git = (...args) => { const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
    writeFileSync(join(root, 'app.js'), 'before'); git('add', 'app.js'); git('commit', '-qm', 'Initial');
    const input = { ...unitInputV2('git-reconcile'), kind: 'bootstrap', allowedPaths: ['app.js'] };
    stateV2.beginUnit(root, { id: 'git-reconcile', input });
    mkdirSync(join(root, INCEPTION_AREA, 'project')); writeFileSync(join(root, input.outputs[0].path), reportV2('git-reconcile'));
    writeFileSync(join(root, 'app.js'), 'after');
    stateV2.reconcileUnit(root, { id: 'git-reconcile', input: { evidence: [input.outputs[0].path], reason: 'Completed writer report and authorized diff', statement: null } });
    assert.equal(readV2(root).activeUnit, null);
    assert.equal(stateV2.resumeCheck(root).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const laterUnit of [false, true]) {
  test(`R1: completed unit cannot automatically absorb later drift (later unit: ${laterUnit})`, () => {
    const root = fixtureV2();
    try {
      mkdirSync(join(root, INCEPTION_AREA, 'project'));
      writeFileSync(join(root, 'app.js'), 'original');
      const input = { ...unitInputV2('build'), kind: 'bootstrap', allowedPaths: ['app.js'] };
      stateV2.beginUnit(root, { id: 'build', input });
      writeFileSync(join(root, input.outputs[0].path), reportV2('build'));
      stateV2.finishUnit(root, { id: 'build' });
      if (laterUnit) {
        stateV2.beginUnit(root, { id: 'later-build', input: { ...unitInputV2('later-build'), kind: 'bootstrap', allowedPaths: ['app.js'] } });
        writeFileSync(join(root, 'app.js'), 'authorized later unit');
        writeFileSync(join(root, INCEPTION_AREA, 'project/later-build.md'), reportV2('later-build'));
        stateV2.finishUnit(root, { id: 'later-build' });
      }
      writeFileSync(join(root, 'app.js'), 'later unexplained mutation');
      assert.equal(stateV2.resumeCheck(root).ok, false);
      const unchanged = snapshot(root);
      assert.throws(() => stateV2.reconcileUnit(root, { id: 'build', input: { evidence: [input.outputs[0].path], reason: 'Use old report', statement: null } }), /unfinished|human|completed|historical/);
      assert.deepEqual(snapshot(root), unchanged, 'refusal must publish no descriptor, snapshot or reconciliation');
      assert.equal(stateV2.resumeCheck(root).ok, false);
      assert.throws(() => stateV2.createCheckpoint(root, { label: 'After unexplained mutation' }), /drift/);
      assert.deepEqual(snapshot(root), unchanged);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
test('R1: explicit human idle reconciliation preserves historical unit boundaries and needs a new work identity', () => {
  const root = fixtureV2();
  try {
    mkdirSync(join(root, INCEPTION_AREA, 'project'));
    writeFileSync(join(root, 'app.js'), 'original');
    const input = { ...unitInputV2('original-build'), kind: 'bootstrap', allowedPaths: ['app.js'] };
    stateV2.beginUnit(root, { id: 'original-build', input });
    writeFileSync(join(root, input.outputs[0].path), reportV2('original-build'));
    stateV2.finishUnit(root, { id: 'original-build' });
    const historical = readV2(root).units[0];
    const originalAfter = readFileSync(join(root, historical.after.path));
    writeFileSync(join(root, 'app.js'), 'human-accepted later correction');
    const priorBaseline = readV2(root).baseline;
    stateV2.reconcileUnit(root, { id: 'original-build', input: { evidence: [input.outputs[0].path], reason: 'Accept observed idle drift', statement: 'I accept the observed later app.js correction.' } });
    const reconciled = readV2(root); const unit = reconciled.units[0];
    assert.deepEqual(unit.before, historical.before);
    assert.deepEqual(unit.after, historical.after, 'later acceptance cannot rewrite the completed work boundary');
    assert.equal(unit.state, 'completed');
    assert.deepEqual(readFileSync(join(root, unit.after.path)), originalAfter);
    const reconciliationRef = unit.evidence.at(-1);
    const reconciliation = JSON.parse(readFileSync(join(root, reconciliationRef.path), 'utf8'));
    assert.deepEqual(reconciliation.body.before, priorBaseline);
    assert.deepEqual(reconciliation.body.after, reconciled.baseline);
    assert.equal(reconciliation.body.changes[0].path, 'app.js');
    assert.equal(stateV2.resumeCheck(root).ok, true);
    stateV2.createCheckpoint(root, { label: 'Human accepted drift' });
    assert.throws(() => stateV2.beginUnit(root, { id: 'original-build', input }), /already/);
    // A repeated automatic reconciliation must still refuse a fresh mutation.
    writeFileSync(join(root, 'app.js'), 'another unexplained mutation');
    const beforeRetry = snapshot(root);
    assert.throws(() => stateV2.reconcileUnit(root, { id: 'original-build', input: { evidence: [input.outputs[0].path], reason: 'Repeat historical acceptance', statement: null } }), /unfinished|human|completed|historical/);
    assert.deepEqual(snapshot(root), beforeRetry);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Task 4: approved verification contracts and immutable manual observations.
const contractPathV2 = `${INCEPTION_AREA}/project/verification-contract.json`;
const environmentV2 = () => ({ tools: [{ name: 'node', version: '24' }], resources: [] });
function checksV2(policy = 'snapshot', type = 'manual') {
  return { schema: 'steepy-inception-checks/v2', roots: ['.'], exclusions: [], environment: { tools: ['node'], resources: [] }, checks: [{ id: 'page', required: true, type, subject: 'Page', procedure: 'Inspect page', expected: 'Readable', evidenceRequired: 'Human observation', automatic: type === 'manual' ? null : { executable: 'node', args: ['--version'], cwd: '.', successExitCodes: [0] }, manual: { procedure: 'Open page', acceptance: 'Readable' }, reuse: { policy, automatic: null, manual: policy === 'snapshot' ? null : { procedure: 'Reopen service', acceptance: 'Same service' } } }], coverage: [{ id: 'app', component: 'Page', checks: ['page'], status: 'current' }] };
}
function approvalFixtureV2(contract = checksV2()) {
  const root = fixtureV2();
  for (const to of ['architecture', 'research', 'approval']) stateV2.transitionRun(root, { to, reason: 'Ready' });
  mkdirSync(join(root, INCEPTION_AREA, 'project'));
  writeFileSync(join(root, REGISTER), 'Approved decisions');
  writeFileSync(join(root, contractPathV2), JSON.stringify(contract));
  writeFileSync(join(root, 'app.js'), 'Application');
  return root;
}
const approveV2 = root => stateV2.approveRun(root, { statement: 'I approve exactly these checks.\nSigned owner', documents: [REGISTER], contract: contractPathV2 });
function verificationFixtureV2(contract) {
  const root = approvalFixtureV2(contract); approveV2(root);
  stateV2.transitionRun(root, { to: 'bootstrap', reason: 'Approved' });
  stateV2.transitionRun(root, { to: 'verification', reason: 'Built' });
  stateV2.beginVerification(root, { environment: environmentV2(), reason: 'Check delivery' });
  return root;
}
function beginCheckV2(root, id) {
  stateV2.beginUnit(root, { id, input: { ...unitInputV2(id), kind: 'check', allowedPaths: ['app.js'] } });
  writeFileSync(join(root, unitInputV2(id).outputs[0].path), reportV2(id));
}
const attestInputV2 = (purpose = 'check', result = 'succeeded') => ({ checks: [{ id: 'page', procedure: purpose === 'check' ? 'Open page' : 'Reopen service', result, observed: 'Readable' }], statement: 'I checked page: readable.', environment: environmentV2(), purpose });

test('v2 approval freezes documents and contract; approval phase is not blindly re-entered', () => {
  const root = approvalFixtureV2();
  try {
    assert.throws(() => stateV2.transitionRun(root, { to: 'bootstrap', reason: 'Bypass' }), /approval/);
    assert.throws(() => stateV2.approveRun(root, { statement: 'yes', documents: [REGISTER] }), /contract/);
    const approval = approveV2(root);
    const record = JSON.parse(readFileSync(join(root, approval.approval), 'utf8'));
    assert.equal(record.body.statement, 'I approve exactly these checks.\nSigned owner');
    assert.equal(record.body.frozenDocuments.length, 2);
    assert.equal(stateV2.verifyApprovalV2(root).ok, true);
    assert.throws(() => stateV2.transitionRun(root, { to: 'approval', reason: 'Repeat' }), /not allowed/);
    stateV2.transitionRun(root, { to: 'bootstrap', reason: 'Only missing step' });
    writeFileSync(join(root, REGISTER), 'Changed');
    assert.throws(() => stateV2.verifyApprovalV2(root), /digest|diverge/);
    assert.equal(stateV2.verifyApprovalV2(root, { approval: approval.approval, historical: true }).ok, true);
    assert.throws(() => stateV2.transitionRun(root, { to: 'verification', reason: 'Stale' }), /digest|diverge/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('v2 contract validation, document scope and all project decision outputs are mandatory before approval', () => {
  const root = approvalFixtureV2();
  try {
    const invalid = checksV2(); invalid.checks[0].required = false;
    writeFileSync(join(root, contractPathV2), JSON.stringify(invalid));
    assert.throws(() => approveV2(root), /required/);
    writeFileSync(join(root, contractPathV2), JSON.stringify(checksV2()));
    stateV2.beginUnit(root, { id: 'design', input: { ...unitInputV2('design'), outputs: [...unitInputV2('design').outputs, { path: `${INCEPTION_AREA}/project/design-decision.md`, role: 'decision' }] } });
    writeFileSync(join(root, unitInputV2('design').outputs[0].path), reportV2('design'));
    writeFileSync(join(root, INCEPTION_AREA, 'project/design-decision.md'), 'Design');
    stateV2.finishUnit(root, { id: 'design' });
    assert.throws(() => approveV2(root), /document/);
    assert.equal(readV2(root).approvals.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('v2 same-cycle begin and read-only resume-check preserve evidence, sessions invalidate only reobserve', () => {
  for (const policy of ['snapshot', 'reobserve']) {
    const root = verificationFixtureV2(checksV2(policy));
    try {
      const cycle = readV2(root).currentCycle;
      const bytes = readFileSync(join(root, RUN_DESCRIPTOR_PATH));
      assert.equal(stateV2.beginVerification(root, { environment: environmentV2(), reason: 'Resume' }).noop, true);
      assert.deepEqual(readFileSync(join(root, RUN_DESCRIPTOR_PATH)), bytes);
      beginCheckV2(root, 'manual-one');
      stateV2.attestVerification(root, { cycle: cycle.path, input: attestInputV2() });
      assert.equal(stateV2.verificationStatus(root, { cycle: cycle.path }).checks[0].result, 'not-executed');
      stateV2.finishUnit(root, { id: 'manual-one' });
      assert.equal(stateV2.verificationStatus(root, { cycle: cycle.path }).checks[0].result, 'succeeded');
      const beforeResume = readFileSync(join(root, RUN_DESCRIPTOR_PATH));
      assert.equal(stateV2.resumeCheck(root).ok, true); assert.equal(stateV2.resumeCheck(root).ok, true);
      assert.deepEqual(readFileSync(join(root, RUN_DESCRIPTOR_PATH)), beforeResume);
      stateV2.resumeVerification(root, { cycle: cycle.path });
      assert.equal(stateV2.verificationStatus(root, { cycle: cycle.path }).checks[0].result, policy === 'snapshot' ? 'succeeded' : 'not-executed');
      if (policy === 'reobserve') {
        beginCheckV2(root, 'reobserve');
        assert.throws(() => stateV2.attestVerification(root, { cycle: cycle.path, input: { ...attestInputV2('revalidate'), checks: attestInputV2().checks } }), /procedure/);
        stateV2.attestVerification(root, { cycle: cycle.path, input: attestInputV2('revalidate') });
        stateV2.finishUnit(root, { id: 'reobserve' });
        assert.equal(stateV2.verificationStatus(root, { cycle: cycle.path }).checks[0].result, 'succeeded');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
test('v2 failed and both checks remain incomplete, retries retain history and wrong cycles/drift refuse', () => {
  for (const type of ['manual', 'both']) {
    const root = verificationFixtureV2(checksV2('snapshot', type));
    try {
      const cycle = readV2(root).currentCycle.path;
      assert.throws(() => stateV2.attestVerification(root, { cycle, input: attestInputV2() }), /unit/);
      beginCheckV2(root, 'failed');
      assert.throws(() => stateV2.attestVerification(root, { cycle: `${INCEPTION_AREA}/verification/cycles/9999.json`, input: attestInputV2() }), /cycle/);
      stateV2.attestVerification(root, { cycle, input: attestInputV2('check', 'failed') });
      stateV2.finishUnit(root, { id: 'failed' });
      assert.equal(stateV2.verificationStatus(root, { cycle }).checks[0].result, 'failed');
      beginCheckV2(root, 'retry'); stateV2.attestVerification(root, { cycle, input: attestInputV2() }); stateV2.finishUnit(root, { id: 'retry' });
      assert.equal(stateV2.verificationStatus(root, { cycle }).checks[0].result, type === 'manual' ? 'succeeded' : 'executed');
      assert.equal(readV2(root).units.length, 2);
      beginCheckV2(root, 'drift'); writeFileSync(join(root, 'app.js'), 'Changed');
      assert.throws(() => stateV2.attestVerification(root, { cycle, input: attestInputV2() }), /drift|snapshot/);
      assert.throws(() => stateV2.finishUnit(root, { id: 'drift' }), /check.*chang|drift/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
test('v2 new approval or changed environment opens a fresh cycle with no inherited success', () => {
  const root = verificationFixtureV2();
  try {
    const first = readV2(root).currentCycle;
    beginCheckV2(root, 'pass'); stateV2.attestVerification(root, { cycle: first.path, input: attestInputV2() }); stateV2.finishUnit(root, { id: 'pass' });
    stateV2.beginVerification(root, { environment: { tools: [{ name: 'node', version: '25' }], resources: [] }, reason: 'New runtime' });
    assert.notDeepEqual(readV2(root).currentCycle, first);
    assert.equal(stateV2.verificationStatus(root, { cycle: readV2(root).currentCycle.path }).checks[0].result, 'not-executed');
    stateV2.transitionRun(root, { to: 'approval', reason: 'Owner revises expected scope' });
    const updated = checksV2(); updated.checks[0].expected = 'New approved expectation'; writeFileSync(join(root, contractPathV2), JSON.stringify(updated));
    approveV2(root); assert.equal(readV2(root).currentCycle, null);
    stateV2.transitionRun(root, { to: 'bootstrap', reason: 'Reapproved' }); stateV2.transitionRun(root, { to: 'verification', reason: 'Ready' });
    stateV2.beginVerification(root, { environment: environmentV2(), reason: 'New approval' });
    assert.equal(readV2(root).cycles.length, 3);
    assert.equal(stateV2.verificationStatus(root, { cycle: readV2(root).currentCycle.path }).checks[0].result, 'not-executed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('v2 approval and verification CLI use strict exact inputs and recover a reserved approval', () => {
  const root = approvalFixtureV2();
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args, '--repo-root', root], { encoding: 'utf8' });
  try {
    assert.equal(run('approve', '--statement', 'yes', '--document', REGISTER).status, 2);
    assert.throws(() => stateV2.approveRun(root, { statement: 'Approved', documents: [REGISTER], contract: contractPathV2, reservation: 'approval-crash', fault: event => { if (event === 'after-rename') throw Error('interrupted'); } }), /interrupted/);
    assert.equal(run('publish', 'resume', '--reservation', 'approval-crash').status, 0);
    assert.equal(run('verify-approval').status, 0);
    assert.equal(run('transition', '--to', 'bootstrap', '--reason', 'Approved').status, 0);
    assert.equal(run('transition', '--to', 'verification', '--reason', 'Built').status, 0);
    const env = `${INCEPTION_AREA}/environment.json`; writeFileSync(join(root, env), JSON.stringify(environmentV2()));
    assert.equal(run('verification', 'begin', '--environment', env, '--reason', 'Verify').status, 0);
    const cycle = readV2(root).currentCycle.path;
    assert.equal(run('verification', 'status', '--cycle', cycle).status, 0);
    assert.equal(run('verification', 'resume', '--cycle', cycle).status, 0);
    beginCheckV2(root, 'cli-check');
    const inputPath = `${INCEPTION_AREA}/attestation.json`; writeFileSync(join(root, inputPath), JSON.stringify(attestInputV2()));
    assert.equal(run('verification', 'attest', '--cycle', cycle, '--input', inputPath).status, 0);
    assert.equal(run('unit', 'finish', '--id', 'cli-check').status, 0);
    assert.equal(JSON.parse(run('verification', 'status', '--cycle', cycle).stdout).checks[0].result, 'succeeded');
    assert.equal(run('verification', 'status', '--cycle', cycle, '--passed', 'true').status, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('v2 manual composite scope, environment identity and session binding reject ambiguous input', () => {
  const contract = checksV2(); contract.checks.push({ ...structuredClone(contract.checks[0]), id: 'second' });
  const root = verificationFixtureV2(contract);
  try {
    const cycle = readV2(root).currentCycle.path;
    beginCheckV2(root, 'composite');
    const valid = attestInputV2(); valid.checks.push({ ...valid.checks[0], id: 'second' }); valid.statement = 'I checked page and second: both readable.';
    for (const input of [
      { ...valid, checks: [...valid.checks, valid.checks[0]] },
      { ...valid, checks: [{ ...valid.checks[0], id: 'unknown' }] },
      { ...valid, environment: { tools: [{ name: 'node', version: 'wrong' }], resources: [] } },
      { ...valid, passed: true },
      { ...valid, purpose: 'other' },
      { ...valid, statement: '   ' },
    ]) assert.throws(() => stateV2.attestVerification(root, { cycle, input }));
    assert.throws(() => stateV2.resumeVerification(root, { cycle }), /activeUnit/);
    stateV2.attestVerification(root, { cycle, input: valid }); stateV2.finishUnit(root, { id: 'composite' });
    assert.deepEqual(stateV2.verificationStatus(root, { cycle }).checks.map(c => c.result), ['succeeded', 'succeeded']);
    const evidence = readV2(root).units.at(-1).evidence.find(r => r.path.includes('/verification/manual/'));
    const manual = JSON.parse(readFileSync(join(root, evidence.path), 'utf8'));
    assert.equal(manual.body.statement, valid.statement); assert.equal(manual.body.purpose, 'check');
    writeFileSync(join(root, evidence.path), JSON.stringify({ ...manual, body: { ...manual.body, statement: 'Forged' } }));
    assert.throws(() => stateV2.verificationStatus(root, { cycle }), /digest/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('v2 malformed approval contract is rejected before attempting a writer lease', async () => {
  const { withProjectScaffoldLock } = await import('../scripts/project-scaffold.mjs');
  const root = approvalFixtureV2();
  try {
    const contract = checksV2(); contract.checks[0].required = false;
    writeFileSync(join(root, contractPathV2), JSON.stringify(contract));
    const before = readFileSync(join(root, RUN_DESCRIPTOR_PATH));
    withProjectScaffoldLock({ hubRoot: root }, () => assert.throws(() => approveV2(root), /at least one required/));
    assert.deepEqual(readFileSync(join(root, RUN_DESCRIPTOR_PATH)), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Task 4 review: reobservation failure must invalidate applicability, and each
// check gets one observation per unit so retries obtain a new opening boundary.
for (const resumed of [false, true]) {
  test(`R1: failed revalidation prevents success and newer observations restore it (resumed=${resumed})`, () => {
    const root = verificationFixtureV2(checksV2('reobserve'));
    try {
      const cycle = readV2(root).currentCycle.path;
      const observe = (id, purpose, result) => {
        beginCheckV2(root, id);
        const input = attestInputV2(purpose, result); input.checks[0].observed = `Observed ${id}: ${result}`;
        const registered = stateV2.attestVerification(root, { cycle, input });
        stateV2.finishUnit(root, { id });
        const persisted = JSON.parse(readFileSync(join(root, registered.results[0].path), 'utf8')).body;
        const status = stateV2.verificationStatus(root, { cycle });
        assert.equal(persisted.result, status.checks[0].result, 'persisted and read-only applicability agree');
        assert.equal(persisted.observed, status.checks[0].observed, 'status displays the applicable observation rather than superseded text');
        return { registered, status };
      };
      const primary = observe('primary', 'check', 'succeeded');
      assert.equal(primary.status.checks[0].result, 'succeeded');
      const unchanged = readFileSync(join(root, RUN_DESCRIPTOR_PATH));
      assert.equal(stateV2.verificationStatus(root, { cycle }).checks[0].result, 'succeeded');
      assert.deepEqual(readFileSync(join(root, RUN_DESCRIPTOR_PATH)), unchanged, 'same-session status is read-only without requiring revalidation');
      if (resumed) stateV2.resumeVerification(root, { cycle });
      const failed = observe('failed-observation', 'revalidate', 'failed');
      assert.notEqual(failed.status.checks[0].result, 'succeeded');
      assert.deepEqual(failed.status.missing, ['page']);
      const failedBytes = readFileSync(join(root, failed.registered.manual.path));
      const retry = observe('new-observation', 'revalidate', 'succeeded');
      assert.equal(retry.status.checks[0].result, 'succeeded');
      assert.deepEqual(retry.status.missing, []);
      assert.deepEqual(readFileSync(join(root, failed.registered.manual.path)), failedBytes, 'failed observation remains immutable');
      observe('another-failure', 'revalidate', 'failed');
      const fresh = observe('fresh-primary', 'check', 'succeeded');
      assert.equal(fresh.status.checks[0].result, 'succeeded', 'a fresh primary attempt supersedes older failed reobservation');
      assert.deepEqual(fresh.status.checks[0].evidence, [fresh.registered.manual], 'older revalidation is historical rather than applicable evidence');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
for (const sequence of [['check', 'failed', 'check', 'succeeded'], ['check', 'succeeded', 'revalidate', 'succeeded']]) {
  test(`R2: same-unit ${sequence.join('/')} refuses without writes and a fresh unit succeeds`, () => {
    const root = verificationFixtureV2(checksV2('reobserve'));
    try {
      const cycle = readV2(root).currentCycle.path;
      beginCheckV2(root, 'original-unit');
      const first = stateV2.attestVerification(root, { cycle, input: attestInputV2(sequence[0], sequence[1]) });
      const originalBytes = readFileSync(join(root, first.manual.path));
      const before = snapshot(root);
      assert.throws(() => stateV2.attestVerification(root, { cycle, input: attestInputV2(sequence[2], sequence[3]) }), /already observed|new.*unit/);
      assert.deepEqual(snapshot(root), before, 'rejection publishes no descriptor or record changes');
      assert.equal(stateV2.verificationStatus(root, { cycle }).checks[0].result, 'not-executed', 'unfinished unit never counts as success');
      stateV2.finishUnit(root, { id: 'original-unit' });
      assert.equal(stateV2.verificationStatus(root, { cycle }).checks[0].result, sequence[1]);
      beginCheckV2(root, 'new-unit');
      const second = stateV2.attestVerification(root, { cycle, input: attestInputV2(sequence[2], sequence[3]) });
      stateV2.finishUnit(root, { id: 'new-unit' });
      const result = JSON.parse(readFileSync(join(root, second.results[0].path), 'utf8')).body;
      assert.equal(result.result, 'succeeded');
      assert.equal(stateV2.verificationStatus(root, { cycle }).checks[0].result, result.result);
      assert.deepEqual(result.manual, sequence[2] === 'check' ? second.manual : first.manual);
      assert.deepEqual(readFileSync(join(root, first.manual.path)), originalBytes);
      assert.equal(readV2(root).units.length, 2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
test('R2: one unit may accept disjoint explicit composite observations', () => {
  const contract = checksV2();
  for (const id of ['second', 'third']) contract.checks.push({ ...structuredClone(contract.checks[0]), id });
  const root = verificationFixtureV2(contract);
  try {
    const cycle = readV2(root).currentCycle.path;
    beginCheckV2(root, 'disjoint');
    stateV2.attestVerification(root, { cycle, input: attestInputV2() });
    const input = attestInputV2(); input.checks = ['second', 'third'].map(id => ({ ...input.checks[0], id })); input.statement = 'I checked second and third: both readable.';
    const composite = stateV2.attestVerification(root, { cycle, input });
    assert.deepEqual(stateV2.verificationStatus(root, { cycle }).missing, ['page', 'second', 'third']);
    stateV2.finishUnit(root, { id: 'disjoint' });
    assert.deepEqual(stateV2.verificationStatus(root, { cycle }).checks.map(c => c.result), ['succeeded', 'succeeded', 'succeeded']);
    for (const ref of composite.results) assert.equal(JSON.parse(readFileSync(join(root, ref.path), 'utf8')).body.result, 'succeeded');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('capture helper reserves only the approved command and active cycle before stream creation', () => {
  const root = verificationFixtureV2(checksV2('snapshot', 'both'));
  try {
    beginCheckV2(root, 'capture-boundary');
    const cycle = readV2(root).currentCycle.path;
    const before = snapshot(root);
    for (const options of [
      { cycle, check: 'missing', unit: 'capture-boundary' },
      { cycle: `${INCEPTION_AREA}/verification/cycles/9999.json`, check: 'page', unit: 'capture-boundary' },
      { cycle, check: 'page', unit: 'other' },
      { cycle, check: 'page', unit: 'capture-boundary', purpose: 'revalidate' },
    ]) { assert.throws(() => stateV2.beginCapture(root, options)); assert.deepEqual(snapshot(root), before); }
    const { capture } = stateV2.beginCapture(root, { cycle, check: 'page', unit: 'capture-boundary' });
    assert.deepEqual(capture.command, checksV2('snapshot', 'both').checks[0].automatic);
    assert.equal(capture.pid, process.pid); assert.match(capture.token, /^[a-f0-9]{64}$/);
    assert.equal(existsSync(join(root, capture.stdoutPath)), false); assert.equal(existsSync(join(root, capture.receiptPath)), false);
    assert.equal(readV2(root).pending, null); assert.deepEqual(readV2(root).publications.at(-1).targets, []);
    const reserved = snapshot(root);
    assert.throws(() => stateV2.recoverCapture(root, { unit: 'capture-boundary' }), /alive/);
    assert.throws(() => stateV2.finishCapture(root, { unit: 'capture-boundary', token: 'f'.repeat(64), failure: 'Invented' }), /owned/);
    assert.deepEqual(snapshot(root), reserved);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Task 6: completion is derived from receipts, never editable summary claims.
function observePageV2(root, id = 'accepted-page', result = 'succeeded') {
  beginCheckV2(root, id);
  stateV2.attestVerification(root, { cycle: readV2(root).currentCycle.path, input: attestInputV2('check', result) });
  stateV2.finishUnit(root, { id });
}
function completeOptionsV2(root) {
  return { to: 'complete', reason: 'Approved delivery verified', cycle: readV2(root).currentCycle.path,
    checkpoint: stateV2.createCheckpoint(root, { label: 'Final verification' }).checkpoint.path };
}
function completedFixtureV2() {
  const root = verificationFixtureV2(); observePageV2(root);
  stateV2.transitionRun(root, completeOptionsV2(root)); return root;
}

test('v2 summarize renders derived required/optional outcomes and coverage from one object', () => {
  const contract = checksV2();
  contract.checks.push({ ...structuredClone(contract.checks[0]), id: 'optional-red', required: false }, { ...structuredClone(contract.checks[0]), id: 'optional-missing', required: false });
  contract.coverage.push({ id: 'future', component: 'Later feature', checks: [], status: 'future' });
  const root = verificationFixtureV2(contract);
  try {
    observePageV2(root);
    beginCheckV2(root, 'optional'); const input = attestInputV2('check', 'failed'); input.checks[0].id = 'optional-red';
    stateV2.attestVerification(root, { cycle: readV2(root).currentCycle.path, input }); stateV2.finishUnit(root, { id: 'optional' });
    const result = stateV2.summarizeVerification(root, { cycle: readV2(root).currentCycle.path, limits: ['Visual checks cover the fixture only'] });
    const body = JSON.parse(readFileSync(join(root, result.summary.path))).body;
    assert.deepEqual(body.checks.map(c => c.result), ['succeeded', 'failed', 'not-executed']);
    assert.ok(body.checks[2].limits.length); assert.deepEqual(body.coverage.map(c => c.status), ['verified', 'future']);
    const report = readFileSync(join(root, result.report.path), 'utf8');
    for (const token of ['optional-red', 'failed', 'optional-missing', 'not-executed', 'Visual checks cover the fixture only']) assert.ok(report.includes(token));
    stateV2.transitionRun(root, completeOptionsV2(root));
    assert.equal(stateV2.verifyComplete(root).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
for (const mode of ['missing', 'failed', 'both-incomplete', 'active-writer', 'block', 'reobserve']) {
  test(`v2 complete rejects ${mode} before publication`, () => {
    const root = verificationFixtureV2(checksV2(mode === 'reobserve' ? 'reobserve' : 'snapshot', mode === 'both-incomplete' ? 'both' : 'manual'));
    try {
      if (mode !== 'missing') observePageV2(root, 'primary', mode === 'failed' ? 'failed' : 'succeeded');
      const options = completeOptionsV2(root);
      if (mode === 'active-writer') beginCheckV2(root, 'pending-writer');
      if (mode === 'reobserve') stateV2.resumeVerification(root, { cycle: options.cycle });
      if (mode === 'block') { const d = structuredClone(readV2(root)); d.blocks.push({ id: 'owner-decision', reason: 'Unresolved decision', evidence: [] }); writeFileSync(join(root, RUN_DESCRIPTOR_PATH), serializeRunDescriptor(d)); }
      const before = snapshot(root);
      assert.throws(() => stateV2.transitionRun(root, options), /required|evidence|writer|activeUnit|block|reobservation|checkpoint/);
      assert.deepEqual(snapshot(root), before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
test('v2 complete publishes proof closure and read-only verification rejects every altered authority', () => {
  const root = completedFixtureV2();
  try {
    const descriptor = readV2(root); const completion = JSON.parse(readFileSync(join(root, descriptor.completion.path))).body;
    assert.ok(completion.evidence.some(ref => ref.path.includes('/verification/manual/')));
    assert.ok(completion.evidence.some(ref => ref.path.includes('/units/')));
    assert.equal(readFileSync(join(root, completion.report.path), 'utf8'), readFileSync(join(root, RESULTS), 'utf8'));
    const unchanged = snapshot(root); const verified = stateV2.verifyComplete(root);
    assert.equal(verified.ok, true); assert.equal(verified.runId, descriptor.runId);
    for (const path of [RUN_DESCRIPTOR_PATH, descriptor.approvals.at(-1).path, REGISTER, completion.summary.path, completion.report.path]) assert.ok(verified.inputPaths.includes(path));
    assert.deepEqual(snapshot(root), unchanged);
    for (const ref of [completion.report, completion.summary, completion.contract, ...completion.evidence]) {
      const path = join(root, ref.path); const bytes = readFileSync(path); writeFileSync(path, Buffer.concat([bytes, Buffer.from(' ')]));
      const changed = snapshot(root); const rejected = stateV2.verifyComplete(root);
      assert.equal(rejected.ok, false, ref.path); assert.deepEqual(Object.keys(rejected), ['ok', 'reason']); assert.deepEqual(snapshot(root), changed);
      writeFileSync(path, bytes);
    }
    writeFileSync(join(root, 'new-app.js'), 'new application'); const drift = snapshot(root);
    assert.match(stateV2.verifyComplete(root).reason, /application.*drift/); assert.deepEqual(snapshot(root), drift);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('v2 completed presentation can resume without reopening verification or bootstrap', () => {
  const root = completedFixtureV2();
  try {
    const completed = readV2(root); assert.equal(completed.resumeNotes.length, 0);
    const resumed = stateV2.resumeCheck(root); assert.equal(resumed.ok, true); assert.match(resumed.next, /presentation|closing/);
    assert.throws(() => stateV2.beginVerification(root, { environment: environmentV2(), reason: 'Rerun' }), /verification/);
    assert.throws(() => stateV2.transitionRun(root, { to: 'bootstrap', reason: 'Reopen' }), /complete/);
    assert.throws(() => stateV2.writeResumeNote(root, { next: 'Rerun checks', needs: [], note: 'Not bound' }), /completion|presentation/);
    const note = stateV2.writeResumeNote(root, { next: 'Present verified delivery', needs: [completed.completion.path], note: 'Closing presentation' });
    assert.ok(readFileSync(join(root, note.note), 'utf8').includes(completed.completion.path));
    assert.deepEqual(readV2(root).completion, completed.completion); assert.equal(readV2(root).status, 'complete');
    assert.equal(stateV2.verifyComplete(root).ok, true); assert.match(stateV2.resumeCheck(root).next, /init/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('v2 terminal reservation resumes exact publication after interruption and rejects foreign pending', () => {
  for (const event of ['after-reserve', 'after-rename', 'before-descriptor-replace', 'after-descriptor-replace']) {
    const root = verificationFixtureV2();
    try {
      observePageV2(root); const options = completeOptionsV2(root);
      assert.throws(() => stateV2.transitionRun(root, { ...options, reservation: 'terminal', fault: step => { if (step === event) throw Error('interrupted terminal'); } }), /interrupted terminal/);
      stateV2.resumePublication(root, { reservation: 'terminal' });
      assert.equal(stateV2.verifyComplete(root).ok, true);
      const before = snapshot(root); assert.equal(stateV2.resumePublication(root, { reservation: 'terminal' }).noop, true); assert.deepEqual(snapshot(root), before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
test('v2 verification CLI rejects legacy and uses exact summarize/complete inputs', () => {
  const root = verificationFixtureV2(); const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args, '--repo-root', root], { encoding: 'utf8' });
  try {
    observePageV2(root); const options = completeOptionsV2(root); const limits = `${INCEPTION_AREA}/limits.json`; writeFileSync(join(root, limits), '[]');
    assert.equal(run('verification', 'summarize', '--cycle', options.cycle, '--limits', limits).status, 0);
    assert.equal(run('verification', 'summarize', '--cycle', options.cycle, '--limits', limits, '--passed', 'true').status, 2);
    assert.equal(run('transition', '--to', 'complete', '--reason', 'Verified', '--cycle', options.cycle, '--checkpoint', options.checkpoint).status, 0);
    const before = snapshot(root); const result = run('verify-complete'); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).ok, true); assert.deepEqual(snapshot(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
  withCase('legacy-verify-complete', c => { writeDescriptor(c, baseDescriptor()); const before = snapshot(c.repo); const result = cli(c, 'verify-complete'); assert.equal(result.status, 1); assert.match(result.output.reason, /legacy/); assert.deepEqual(snapshot(c.repo), before); });
});

test('v2 terminal recovery rechecks application and proof bytes before publishing reserved targets', () => {
  const root = verificationFixtureV2();
  try {
    observePageV2(root); const options = completeOptionsV2(root);
    assert.throws(() => stateV2.transitionRun(root, { ...options, reservation: 'terminal-drift', fault: step => { if (step === 'after-reserve') throw Error('interrupted'); } }), /interrupted/);
    writeFileSync(join(root, 'app.js'), 'Changed after reservation'); const before = snapshot(root);
    assert.throws(() => stateV2.resumePublication(root, { reservation: 'terminal-drift' }), /drift/);
    assert.deepEqual(snapshot(root), before, 'no reserved output appears after refused recovery');
    assert.notEqual(readV2(root).status, 'complete');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('v2 complete and verify-complete include captured stdout/stderr and require both proof types', () => {
  const root = verificationFixtureV2(checksV2('snapshot', 'both'));
  try {
    const cycle = readV2(root).currentCycle.path; beginCheckV2(root, 'captured-check');
    const collector = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/capture-inception-evidence.mjs', import.meta.url)), '--repo-root', root, '--cycle', cycle, '--check', 'page', '--unit', 'captured-check'], { encoding: 'utf8' });
    assert.equal(collector.status, 0, collector.stderr);
    stateV2.finishUnit(root, { id: 'captured-check' });
    const incomplete = completeOptionsV2(root); assert.throws(() => stateV2.transitionRun(root, incomplete), /required/);
    observePageV2(root, 'manual-half'); stateV2.transitionRun(root, completeOptionsV2(root));
    const completion = JSON.parse(readFileSync(join(root, readV2(root).completion.path))).body;
    for (const name of ['stdout.bin', 'stderr.bin', 'receipt.json']) {
      const ref = completion.evidence.find(ref => ref.path.endsWith(`/${name}`)); assert.ok(ref, name);
      const bytes = readFileSync(join(root, ref.path)); writeFileSync(join(root, ref.path), 'tampered');
      const before = snapshot(root); assert.equal(stateV2.verifyComplete(root).ok, false); assert.deepEqual(snapshot(root), before); writeFileSync(join(root, ref.path), bytes);
    }
    assert.equal(stateV2.verifyComplete(root).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('v2 completion rejects self-consistent summary/report edits after rebuilding receipts', async () => {
  const protocol = await import('../scripts/inception-protocol.mjs'); const root = completedFixtureV2();
  try {
    const descriptor = structuredClone(readV2(root)); const completion = JSON.parse(readFileSync(join(root, descriptor.completion.path)));
    const summary = JSON.parse(readFileSync(join(root, completion.body.summary.path)));
    summary.body.checks[0].observed = 'Agent-authored replacement observation';
    const replacements = new Map();
    const replace = (ref, content) => { writeFileSync(join(root, ref.path), content); const next = protocol.publicationRef(ref.path, content); replacements.set(ref.path, next); return next; };
    completion.body.summary = replace(completion.body.summary, protocol.serializeInceptionRecord(summary));
    const report = protocol.renderVerificationReport(summary); completion.body.report = replace(completion.body.report, report);
    replace(protocol.publicationRef(RESULTS, report), report);
    descriptor.completion = replace(descriptor.completion, protocol.serializeInceptionRecord(completion));
    descriptor.publications = descriptor.publications.map(publication => ({ ...publication, targets: publication.targets.map(ref => replacements.get(ref.path) ?? ref) }));
    writeFileSync(join(root, RUN_DESCRIPTOR_PATH), serializeRunDescriptor(descriptor));
    const before = snapshot(root); assert.match(stateV2.verifyComplete(root).reason, /receipt-derived/); assert.deepEqual(snapshot(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('v2 completed verification offers only a validated snapshot hook for later governance provenance', () => {
  const root = completedFixtureV2();
  try {
    let called = false;
    assert.equal(stateV2.verifyComplete(root, { verifyGovernance: (_root, inputs) => { called = true; assert.equal(inputs.completion.kind, 'completion'); return inputs.observed; } }).ok, true);
    assert.equal(called, true);
    assert.equal(stateV2.verifyComplete(root, { verifyGovernance: () => true }).ok, false);
    assert.equal(stateV2.verifyComplete(root, { verifyGovernance: () => { throw Error('invalid provenance'); } }).ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('v2 completion preserves closed-incomplete capture history while accepting a new proven attempt', () => {
  const root = verificationFixtureV2(checksV2('snapshot', 'both'));
  try {
    const proof = stoppedCaptureV2(root, 'interrupted');
    stateV2.closeIncompleteUnit(root, { id: 'interrupted', reason: 'Interrupted collector', evidence: [proof] });
    const descriptor = readV2(root);
    const cycle = descriptor.currentCycle.path; beginCheckV2(root, 'successful-retry');
    const collector = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/capture-inception-evidence.mjs', import.meta.url)), '--repo-root', root, '--cycle', cycle, '--check', 'page', '--unit', 'successful-retry'], { encoding: 'utf8' });
    assert.equal(collector.status, 0, collector.stderr); stateV2.finishUnit(root, { id: 'successful-retry' }); observePageV2(root, 'manual-retry');
    stateV2.transitionRun(root, completeOptionsV2(root));
    assert.equal(readV2(root).units[0].state, 'closed-incomplete'); assert.equal(stateV2.verifyComplete(root).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('v2 complete refuses foreign pending publications and unresolved partial effects without writes', () => {
  for (const mode of ['pending', 'uncertain', 'partial']) {
    const root = verificationFixtureV2();
    try {
      observePageV2(root); const options = completeOptionsV2(root);
      if (mode === 'pending') {
        assert.throws(() => stateV2.writeResumeNote(root, { next: 'Pending note', reservation: 'foreign-note', fault: event => { if (event === 'after-reserve') throw Error('interrupted'); } }), /interrupted/);
      } else {
        beginCheckV2(root, 'effect-unit'); const intent = intentV2('unfinished-effect'); stateV2.recordEffectIntent(root, { id: intent.id, input: intent });
        if (mode === 'partial') {
          const observed = 'Operation partly finished'; const input = { result: 'partial', observed, correlation: intent.correlation, evidence: intent.observation.evidencePaths };
          writeFileSync(join(root, input.evidence[0]), JSON.stringify({ id: intent.id, procedure: intent.observation.procedure, result: 'partial', correlation: intent.correlation, observed }));
          stateV2.recordEffectOutcome(root, { id: intent.id, input });
        }
        // Closing a unit cannot erase uncertainty, even if its block were lost.
        const descriptor = structuredClone(readV2(root)); descriptor.units.at(-1).state = 'closed-incomplete'; descriptor.activeUnit = null; descriptor.blocks = [];
        writeFileSync(join(root, RUN_DESCRIPTOR_PATH), serializeRunDescriptor(descriptor));
      }
      const before = snapshot(root); assert.throws(() => stateV2.transitionRun(root, options), /pending|uncertain|effect/); assert.deepEqual(snapshot(root), before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('v2 closing-note interruption resumes publication while preserving the completed delivery', () => {
  const root = completedFixtureV2();
  try {
    const completion = readV2(root).completion;
    assert.throws(() => stateV2.writeResumeNote(root, { next: 'Present delivery', needs: [completion.path], reservation: 'closing-note', fault: event => { if (event === 'after-reserve') throw Error('interrupted closing'); } }), /interrupted closing/);
    assert.equal(readV2(root).status, 'complete');
    assert.equal(stateV2.resumeCheck(root).next, 'publish resume');
    stateV2.resumePublication(root, { reservation: 'closing-note' });
    assert.deepEqual(readV2(root).completion, completion); assert.equal(stateV2.verifyComplete(root).ok, true);
    assert.match(stateV2.resumeCheck(root).next, /init/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const outcome of ['not-executed', 'failed', 'succeeded']) {
  test(`v2 automatic-only required completion is derived as ${outcome}`, () => {
    const contract = checksV2('snapshot', 'both'); contract.checks[0].type = 'automatic'; contract.checks[0].manual = null;
    if (outcome === 'failed') contract.checks[0].automatic.args = ['-e', 'process.exit(7)'];
    const root = verificationFixtureV2(contract);
    try {
      const cycle = readV2(root).currentCycle.path;
      if (outcome !== 'not-executed') {
        beginCheckV2(root, 'automatic-only');
        const collector = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/capture-inception-evidence.mjs', import.meta.url)), '--repo-root', root, '--cycle', cycle, '--check', 'page', '--unit', 'automatic-only'], { encoding: 'utf8' });
        assert.equal(collector.status, 0, collector.stderr); stateV2.finishUnit(root, { id: 'automatic-only' });
      }
      const summarized = stateV2.summarizeVerification(root, { cycle, limits: [] });
      assert.equal(JSON.parse(readFileSync(join(root, summarized.summary.path))).body.checks[0].result, outcome);
      const options = completeOptionsV2(root);
      if (outcome === 'succeeded') { stateV2.transitionRun(root, options); assert.equal(stateV2.verifyComplete(root).ok, true); }
      else { const before = snapshot(root); assert.throws(() => stateV2.transitionRun(root, options), /required/); assert.deepEqual(snapshot(root), before); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

// C7: every boundary runs in a fresh writer process; recovery never needs run.json.
const ABANDON_INTENT = `${INCEPTION_AREA}/abandon-intent.json`;
function crashAbandon(c, boundary, child = null) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { abandonRun } from ${JSON.stringify(new URL('../scripts/inception-state.mjs', import.meta.url).href)};
    abandonRun(process.argv[1], { reason: 'Preserve interrupted run', fault(point, details) {
      if (point === process.argv[2] && (!process.argv[3] || details?.name === process.argv[3] || details?.path?.endsWith('/' + process.argv[3]))) process.exit(73);
    }});
  `, c.repo, boundary, ...(child ? [child] : [])], { encoding: 'utf8', env: c.env });
}
const archiveBoundaries = [
  ['before-intent'], ['after-intent'], ['before-mkdir'], ['after-mkdir'],
  ...['intent.json', 'abandon.json', 'receipt.json'].flatMap(name => ['before-stage', 'after-stage', 'before-rename', 'after-rename'].map(point => [point, name])),
  ...RUN_CHILDREN.flatMap(name => [['before-move', name], ['after-move', name]]),
  ['before-receipt'], ['before-receipt-reservation'], ['after-receipt-reservation'], ['after-receipt'], ['before-complete'], ['after-complete'],
];
for (const version of [1, 2]) for (const [point, name] of archiveBoundaries) {
  test(`C7 v${version}: fresh process recovers ${point} ${name ?? ''}`, () => withCase('abandon-crash', c => {
    const descriptor = version === 1 ? baseDescriptor() : createRunDescriptorV2({ runId: RUN_ID, harnessName: 'codex', git: { present: false, branch: null, commits: 'none' } });
    writeDescriptor(c, descriptor);
    for (const child of RUN_CHILDREN.filter(n => n !== 'run.json')) writeFile(c, `${INCEPTION_AREA}/${child}${child.includes('.') ? '' : '/opaque.bin'}`, 'Retain exact bytes\n');
    const before = files(c.repo); const archive = `${ABANDONED}/${RUN_ID}`;
    const result = crashAbandon(c, point, name);
    assert.equal(result.status, 73, result.stderr);
    if (point !== 'before-intent') {
      const classified = cli(c, 'classify'); assert.equal(classified.status, 0, JSON.stringify(classified.output));
      if (point !== 'after-complete') assert.equal(classified.output.row, 'resume-abandon');
      if (point !== 'after-complete') { const start = cli(c, ...startArgs()); assert.equal(start.status, 1, 'no replacement before complete'); }
    }
    const resumed = cli(c, 'abandon', ...(point === 'before-intent' ? ['--reason', 'Preserve interrupted run'] : ['--resume']));
    assert.equal(resumed.status, 0, JSON.stringify(resumed.output));
    for (const [path, bytes] of Object.entries(expectedAfterAbandon(before, archive))) assert.equal(files(c.repo)[path], bytes);
    const complete = snapshot(c.repo);
    assert.equal(cli(c, 'abandon', '--resume').status, 0);
    assert.deepEqual(snapshot(c.repo), complete, 'completed retry is byte/mode/mtime no-op');
    assert.equal(existsSync(join(c.repo, RUN_DESCRIPTOR_PATH)), false);
    assert.equal(JSON.parse(readFileSync(join(c.repo, archive, 'run.json'))).schema, descriptor.schema);
  }));
}
for (const scenario of ['both', 'neither', 'different-inode', 'changed-descriptor', 'foreign-file', 'foreign-staging', 'symlink', 'hardlink', 'corrupt-intent', 'corrupt-copy', 'corrupt-abandon', 'wrong-archive-identity', 'corrupt-receipt']) {
  test(`C7 rejects ${scenario} without changing either side`, () => withCase('abandon-conflict', c => {
    writeDescriptor(c, baseDescriptor());
    writeFile(c, `${INCEPTION_AREA}/project/opaque.bin`, 'Preserve');
    const archive = `${ABANDONED}/${RUN_ID}`;
    const point = scenario === 'corrupt-receipt' ? 'after-receipt' : 'before-move';
    assert.equal(crashAbandon(c, point, point === 'before-move' ? 'project' : null).status, 73);
    const source = join(c.repo, INCEPTION_AREA, 'project'); const target = join(c.repo, archive, 'project');
    if (scenario === 'both') mkdirSync(target);
    if (scenario === 'neither') renameSync(source, join(c.repo, 'retained-project'));
    if (scenario === 'different-inode') { renameSync(source, join(c.repo, 'retained-project')); mkdirSync(source); }
    if (scenario === 'changed-descriptor') writeFile(c, RUN_DESCRIPTOR_PATH, text(baseDescriptor({ status: 'blocked' })));
    if (scenario === 'foreign-file') writeFile(c, `${archive}/foreign.bin`, 'Foreign');
    if (scenario === 'foreign-staging') writeFile(c, `${archive}/receipt.json.foreign.staging/0001.tmp`, 'Foreign');
    if (scenario === 'symlink') { renameSync(source, join(c.repo, 'retained-project')); symlinkSync(join(c.repo, 'retained-project'), source); }
    if (scenario === 'hardlink') linkSync(join(c.repo, RUN_DESCRIPTOR_PATH), join(c.repo, 'foreign-link'));
    const corrupt = { 'corrupt-intent': ABANDON_INTENT, 'corrupt-copy': `${archive}/intent.json`, 'corrupt-abandon': `${archive}/abandon.json`, 'corrupt-receipt': `${archive}/receipt.json` }[scenario];
    if (corrupt) writeFile(c, corrupt, '{}\n');
    if (scenario === 'wrong-archive-identity') { const p = `${archive}/abandon.json`; const record = JSON.parse(readFileSync(join(c.repo, p))); record.archiveIdentity.inode = '0'; writeFile(c, p, text(record)); }
    const before = snapshot(c.repo);
    assert.equal(cli(c, 'abandon', '--resume').status, 1);
    assert.equal(cli(c, 'classify').status, 1);
    assert.equal(cli(c, ...startArgs()).status, 1);
    assert.deepEqual(snapshot(c.repo), before);
  }));
}
test('C7 validates mutually exclusive abandon modes and completed intent before explicit start', () => withCase('abandon-start', c => {
  writeDescriptor(c, baseDescriptor());
  for (const args of [[], ['--resume', '--reason', 'x']]) assert.equal(cli(c, 'abandon', ...args).status, 2);
  assert.equal(cli(c, 'abandon', '--reason', 'Done').status, 0);
  const pointer = readFileSync(join(c.repo, ABANDON_INTENT));
  assert.equal(cli(c, ...startArgs()).status, 0);
  assert.deepEqual(readFileSync(join(c.repo, ABANDON_INTENT)), pointer);
  assert.equal(cli(c, 'classify').output.row, 'resume-run');
}));

test('C7 refuses abandonment by a foreign writer while a v2 unit owns mutations', () => withCase('abandon-writer', c => {
  writeDescriptor(c, createRunDescriptorV2({ runId: RUN_ID, harnessName: 'codex', git: { present: false, branch: null, commits: 'none' } }));
  stateV2.beginUnit(c.repo, { id: 'writer', input: unitInputV2('writer') });
  const before = snapshot(c.repo);
  const result = cli(c, 'abandon', '--reason', 'Stop');
  assert.equal(result.status, 1); assert.match(result.output.error, /activeUnit|writer|unit/);
  assert.deepEqual(snapshot(c.repo), before);
}));

test('C7 readers inspect only immediate declared archive names and never open child report bodies', () => withCase('abandon-read-scope', c => {
  writeDescriptor(c, baseDescriptor()); writeFile(c, `${INCEPTION_AREA}/project/opaque.bin`, 'Do not open');
  assert.equal(crashAbandon(c, 'after-move', 'run.json').status, 73);
  const source = `
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const archive = process.argv[1] + '/${ABANDONED}/${RUN_ID}'; const calls = [];
    const list = fs.readdirSync; fs.readdirSync = function(path, ...args) {
      if (String(path).includes('/.apex/inception')) { calls.push(String(path)); if (String(path) !== archive) throw new Error('Forbidden area scan: ' + path); }
      return list.call(this, path, ...args);
    };
    const open = fs.openSync; fs.openSync = function(path, ...args) {
      if (String(path).endsWith('/opaque.bin')) throw new Error('Forbidden report body read');
      return open.call(this, path, ...args);
    }; syncBuiltinESMExports();
    const {inspectAbandon} = await import(${JSON.stringify(new URL('../scripts/inception-state.mjs', import.meta.url).href)});
    const {collectViolations} = await import(${JSON.stringify(new URL('../scripts/validate-hub.mjs', import.meta.url).href)});
    inspectAbandon(process.argv[1]); if (collectViolations(process.argv[1]).length) throw new Error('Expected coherent pending archive');
    process.stdout.write(JSON.stringify(calls));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, c.repo], { encoding: 'utf8', env: c.env });
  assert.equal(result.status, 0, result.stderr); assert.ok(JSON.parse(result.stdout).length >= 2);
}));

for (const name of ['intent.json', 'abandon.json', 'receipt.json']) {
  test(`C7 preserves a partial reserved ${name} generation and an unrelated temporary file`, () => withCase('abandon-partial-stage', c => {
    writeDescriptor(c, baseDescriptor());
    assert.equal(crashAbandon(c, 'before-stage', name).status, 73);
    const intent = JSON.parse(readFileSync(join(c.repo, ABANDON_INTENT)));
    const archive = `${ABANDONED}/${RUN_ID}`;
    const stage = `${archive}/${name}.${intent.id}.staging`;
    writeFile(c, `${stage}/0001.tmp`, '{partial');
    writeFile(c, `${stage}/foreign.tmp`, 'Foreign bytes');
    assert.equal(cli(c, 'abandon', '--resume').status, 0);
    assert.equal(readFileSync(join(c.repo, stage, '0001.tmp'), 'utf8'), '{partial');
    assert.equal(readFileSync(join(c.repo, stage, 'foreign.tmp'), 'utf8'), 'Foreign bytes');
    assert.equal(JSON.parse(readFileSync(join(c.repo, archive, name))).runId, RUN_ID);
  }));
}

// Task 8: lifecycle commands are public transitions, never caller-written terminal states.
function stoppedCaptureV2(root, id) {
  beginCheckV2(root, id);
  const helper = new URL('../scripts/inception-state.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { beginCapture } from ${JSON.stringify(helper)}; beginCapture(${JSON.stringify(root)}, { cycle: ${JSON.stringify(readV2(root).currentCycle.path)}, check: 'page', unit: ${JSON.stringify(id)} });`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const proof = `${INCEPTION_AREA}/project/${id}-stop.txt`;
  writeFileSync(join(root, proof), 'Collector process has exited; outputs are incomplete.');
  return proof;
}
test('C8 close-incomplete observes stopped collectors, preserves uncertainty and permits only explicit new identities', () => {
  for (const uncertain of [false, true]) {
    const root = verificationFixtureV2(checksV2('snapshot', 'both'));
    try {
      const proof = stoppedCaptureV2(root, 'interrupted-c8');
      if (uncertain) stateV2.recordEffectIntent(root, { id: 'remote-c8', input: intentV2('remote-c8') });
      const effects = readV2(root).effects; const blocks = readV2(root).blocks;
      const result = spawnSync(process.execPath, [SCRIPT, 'unit', 'close-incomplete', '--repo-root', root, '--id', 'interrupted-c8', '--reason', 'Collector stopped without complete output', '--evidence', proof], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const closed = readV2(root);
      assert.equal(closed.activeUnit, null); assert.equal(closed.units.at(-1).state, 'closed-incomplete');
      assert.equal(closed.units.at(-1).capture.state, 'incomplete');
      assert.deepEqual(closed.effects, effects); assert.deepEqual(closed.blocks, blocks);
      if (uncertain) { assert.throws(() => stateV2.verificationStatus(root, { cycle: closed.currentCycle.path }), /blocks|effects/); assert.equal(stateV2.effectStatusV2(root).uncertain, 1); }
      else assert.equal(stateV2.verificationStatus(root, { cycle: closed.currentCycle.path }).checks[0].result, 'not-executed');
      assert.throws(() => stateV2.beginUnit(root, { id: 'interrupted-c8', input: unitInputV2('interrupted-c8') }), /already|new ID/);
      const input = { ...unitInputV2('retry-c8'), kind: 'check' };
      if (uncertain) assert.throws(() => stateV2.beginUnit(root, { id: 'retry-c8', previousUnit: 'interrupted-c8', input }), /blocks|effects/);
      else { stateV2.beginUnit(root, { id: 'retry-c8', previousUnit: 'interrupted-c8', input }); assert.equal(readV2(root).units.at(-1).previousUnit, 'interrupted-c8'); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
test('C8 close-incomplete refuses live or unverifiable writers before any mutation', () => {
  const root = verificationFixtureV2(checksV2('snapshot', 'both'));
  try {
    beginCheckV2(root, 'live-c8'); stateV2.beginCapture(root, { cycle: readV2(root).currentCycle.path, check: 'page', unit: 'live-c8' });
    const evidence = `${INCEPTION_AREA}/project/stop.txt`; writeFileSync(join(root, evidence), 'Claimed stop');
    const before = snapshot(root);
    assert.throws(() => stateV2.closeIncompleteUnit(root, { id: 'live-c8', reason: 'Stop', evidence: [evidence] }), /alive/);
    assert.throws(() => stateV2.closeIncompleteUnit(root, { id: 'live-c8', reason: 'Stop', evidence: [evidence], probe: () => { const e = new Error('permission'); e.code = 'EPERM'; throw e; } }), /unverifiable/);
    assert.deepEqual(snapshot(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('C8 named block resolution freezes human decision and preserves independent blocks and unresolved effects', () => {
  const root = fixtureV2();
  try {
    const d = structuredClone(readV2(root)); d.status = 'blocked'; d.blocks = [{ id: 'human-one', reason: 'Need decision', evidence: [] }, { id: 'human-two', reason: 'Independent decision', evidence: [] }];
    writeFileSync(join(root, RUN_DESCRIPTOR_PATH), serializeRunDescriptor(d));
    mkdirSync(join(root, INCEPTION_AREA, 'project'));
    const proof = `${INCEPTION_AREA}/project/decision.txt`; writeFileSync(join(root, proof), 'User accepts first recovery choice.');
    const before = snapshot(root);
    assert.throws(() => stateV2.resolveBlock(root, { id: 'human-one', statement: '', evidence: [proof] }), /text|statement/);
    assert.deepEqual(snapshot(root), before);
    const result = spawnSync(process.execPath, [SCRIPT, 'block', 'resolve', '--repo-root', root, '--id', 'human-one', '--statement', 'I accept the first recovery choice.', '--evidence', proof], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const resolved = readV2(root); assert.deepEqual(resolved.blocks.map(b => b.id), ['human-two']); assert.equal(resolved.status, 'blocked');
    const note = readFileSync(join(root, resolved.resumeNotes.at(-1).path), 'utf8');
    assert.match(note, /human-one/); assert.match(note, /I accept the first recovery choice\./);
    assert.throws(() => stateV2.transitionRun(root, { to: 'active', reason: 'Resume' }), /blocks/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('C8 noncapture closure requires explicit unit-correlated stopped-writer observation', () => {
  const root = fixtureV2();
  try {
    stateV2.beginUnit(root, { id: 'research-stop', input: { ...unitInputV2('research-stop'), kind: 'research' } });
    mkdirSync(join(root, INCEPTION_AREA, 'project'));
    const path = `${INCEPTION_AREA}/project/stop.json`;
    for (const observation of [{ unitId: 'research-stop', writerStopped: false, statement: 'Still running' }, { unitId: 'other', writerStopped: true, statement: 'Observed stopped' }, { unitId: 'research-stop', writerStopped: true, statement: '' }, { status: 'DONE' }]) {
      writeFileSync(join(root, path), JSON.stringify(observation)); const before = snapshot(root);
      assert.throws(() => stateV2.closeIncompleteUnit(root, { id: 'research-stop', reason: 'Interrupted research', evidence: [path] }), /observ|stop|unit|text|statement|keys/);
      assert.deepEqual(snapshot(root), before);
    }
    writeFileSync(join(root, path), JSON.stringify({ unitId: 'research-stop', writerStopped: true, statement: 'I observed the research writer stop before closing this unit.' }));
    stateV2.closeIncompleteUnit(root, { id: 'research-stop', reason: 'Interrupted research', evidence: [path] });
    const d = readV2(root); assert.equal(d.units[0].state, 'closed-incomplete'); assert.equal(d.activeUnit, null);
    const record = JSON.parse(readFileSync(join(root, d.units[0].evidence.at(-1).path), 'utf8'));
    assert.equal(record.body.statement, 'I observed the research writer stop before closing this unit.');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('public v2 cutover rejects every legacy mutator before writer acquisition or new files', () => {
  const input = `${INCEPTION_AREA}/project/input.json`;
  const commands = [
    ['transition', '--to', 'architecture', '--reason', 'Next'], ['transition', '--to', 'complete', '--reason', 'Done', '--cycle', `${INCEPTION_AREA}/verification/cycles/0001.json`, '--checkpoint', `${INCEPTION_AREA}/checkpoints/0002.json`],
    ['resume-note', '--next', 'Continue'], ['approve', '--statement', 'Approved', '--document', REGISTER, '--contract', contractPathV2],
    ['unit', 'begin', '--id', 'new', '--input', input], ['unit', 'finish', '--id', 'new'], ['unit', 'reconcile', '--id', 'new', '--input', input], ['unit', 'close-incomplete', '--id', 'new', '--reason', 'Stopped', '--evidence', input],
    ['block', 'resolve', '--id', 'human', '--statement', 'Accepted', '--evidence', input], ['publish', 'resume', '--reservation', 'old'],
    ['effect', 'intent', '--id', 'remote', '--input', input], ['effect', 'outcome', '--id', 'remote', '--input', input], ['effect', 'reconcile', '--id', 'remote', '--input', input],
    ['checkpoint', 'create', '--label', 'Full'], ['verification', 'begin', '--environment', input, '--reason', 'Ready'], ['verification', 'resume', '--cycle', `${INCEPTION_AREA}/verification/cycles/0001.json`], ['verification', 'attest', '--cycle', `${INCEPTION_AREA}/verification/cycles/0001.json`, '--input', input], ['verification', 'summarize', '--cycle', `${INCEPTION_AREA}/verification/cycles/0001.json`, '--limits', input],
  ];
  for (const legacy of [baseDescriptor(), baseDescriptor({status:'blocked'}), completeDescriptor()]) withCase('v1-read-only', c => {
    writeDescriptor(c, legacy); writeFile(c, input, '{}');
    // A live writer lease makes the pre-lease legacy refusal observable.
    const lock = join(c.repo, '.steepy-project-scaffold.lock'); mkdirSync(lock);
    writeFileSync(join(lock, 'foreign.txt'), 'Keep this writer namespace');
    for (const args of commands) {
      const before = snapshot(c.repo); const result = cli(c, ...args);
      assert.equal(result.status, 1, args.join(' ')); assert.match(result.output.error, /legacy/i, args.join(' '));
      assert.deepEqual(snapshot(c.repo), before, args.join(' '));
    }
    const before = snapshot(c.repo); const verified = cli(c, 'verify-complete');
    assert.equal(verified.status, 1); assert.match(verified.output.reason, /legacy/); assert.equal(verified.output.inputPaths, undefined);
    assert.equal(cli(c, ...startArgs()).status, 1); assert.deepEqual(snapshot(c.repo), before);
  });
});
test('raw legacy readers retain approval, checkpoint and effect verification without migration', () => withCase('legacy-readers', c => {
  const approval = `${INCEPTION_AREA}/approvals/0001.json`; const checkpointPath = `${INCEPTION_AREA}/checkpoints/0002.json`;
  writeFile(c, REGISTER, 'Approved legacy decisions'); writeFile(c, 'app.js', 'Legacy application');
  writeFile(c, approval, text({ schema: 'steepy-inception-approval/v1', runId: RUN_ID, record: 1, at: '2026-10-07T12:00:00.000Z', statement: 'Approved', documents: [digestOf(c, REGISTER)] }));
  writeFile(c, checkpointPath, text({ schema: 'steepy-inception-checkpoint/v1', runId: RUN_ID, record: 2, at: '2026-10-07T12:00:00.000Z', label: 'Final', phase: 'verification', files: [digestOf(c, 'app.js')], git: { present: false } }));
  writeFile(c, `${INCEPTION_AREA}/effects.jsonl`, `${intentLine('legacy-install')}\n${outcomeLine('legacy-install')}\n`);
  writeDescriptor(c, baseDescriptor({ phase: 'verification', git: { present: false, branch: null, commits: 'none' }, nextRecord: 3, approvals: [approval], checkpoints: [checkpointPath] }));
  const before = snapshot(c.repo);
  for (const args of [['inspect'], ['classify'], ['verify-approval'], ['checkpoint', 'verify'], ['effect', 'status']]) { const result = cli(c,...args); assert.equal(result.status,0,JSON.stringify(result.output)); }
  assert.deepEqual(snapshot(c.repo),before);
  writeFile(c,'app.js','Drift'); assert.equal(cli(c,'checkpoint','verify').status,1);
  writeFile(c,REGISTER,'Drift'); assert.equal(cli(c,'verify-approval').status,1);
}));

test('C8 unit begin transports explicit retry lineage and rejects nonexistent predecessors', () => {
  const root = fixtureV2();
  try {
    const inputPath = `${INCEPTION_AREA}/retry-input.json`;
    writeFileSync(join(root, inputPath), JSON.stringify(unitInputV2('retry-command')));
    const run = (...args) => spawnSync(process.execPath, [SCRIPT, 'unit', 'begin', '--repo-root', root, '--id', 'retry-command', '--input', inputPath, '--previous-unit', ...args], { encoding: 'utf8' });
    const before = snapshot(root); const missing = run('missing'); assert.equal(missing.status, 1); assert.match(missing.stderr, /previousUnit/); assert.deepEqual(snapshot(root), before);
    stateV2.beginUnit(root, { id: 'original-command', input: unitInputV2('original-command') });
    mkdirSync(join(root, INCEPTION_AREA, 'project')); const proof = `${INCEPTION_AREA}/project/observed-stop.json`;
    writeFileSync(join(root, proof), JSON.stringify({ unitId: 'original-command', writerStopped: true, statement: 'Coordinator observed this writer stop.' }));
    stateV2.closeIncompleteUnit(root, { id: 'original-command', reason: 'Interrupted', evidence: [proof] });
    const retry = run('original-command'); assert.equal(retry.status, 0, retry.stderr); assert.equal(readV2(root).units.at(-1).previousUnit, 'original-command');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// R1: closing proves stop without accepting drift or fabricating a successful report.
for (const captured of [false, true]) test(`R1 closed-incomplete ${captured ? 'capture' : 'noncapture'} accepts explicit human drift reconciliation without success`, () => {
  const root = captured ? verificationFixtureV2(checksV2('snapshot', 'both')) : fixtureV2();
  try {
    const id = 'interrupted-drift';
    const oldCycle = readV2(root).currentCycle;
    let proof;
    if (captured) {
      proof = stoppedCaptureV2(root, id);
      rmSync(join(root, readV2(root).units.at(-1).outputs.find(o => o.role === 'report').path));
    }
    else {
      writeFileSync(join(root, 'app.js'), 'Before');
      stateV2.beginUnit(root, { id, input: { ...unitInputV2(id), kind: 'bootstrap', allowedPaths: ['app.js'], outputs: [...unitInputV2(id).outputs, { path: `${INCEPTION_AREA}/project/interrupted-output.json`, role: 'evidence' }] } });
      mkdirSync(join(root, INCEPTION_AREA, 'project'));
      proof = `${INCEPTION_AREA}/project/stop-drift.json`;
      writeFileSync(join(root, proof), JSON.stringify({ unitId: id, writerStopped: true, statement: 'I observed the application writer stop before its report was produced.' }));
    }
    writeFileSync(join(root, 'app.js'), 'Interrupted change');
    stateV2.closeIncompleteUnit(root, { id, reason: 'Stopped with unfinished application changes', evidence: [proof] });
    const closed = readV2(root); const historical = closed.units.at(-1); const baseline = closed.baseline;
    assert.equal(existsSync(join(root, unitInputV2(id).outputs[0].path)), false);
    assert.equal(closed.currentCycle, null); assert.equal(closed.verificationSession, null);
    const beforeAcceptance = snapshot(root);
    assert.throws(() => stateV2.createCheckpoint(root, { label: 'Cannot erase drift' }), /drift/);
    assert.throws(() => stateV2.beginUnit(root, { id: 'premature-retry', previousUnit: id, input: unitInputV2('premature-retry') }), /drift/);
    assert.throws(() => stateV2.reconcileUnit(root, { id, input: { evidence: [proof], reason: 'Accept change', statement: null } }), /human|statement/);
    assert.deepEqual(snapshot(root), beforeAcceptance);
    const input = { evidence: [proof], reason: 'Accept the observed application correction', statement: 'I accept the observed app.js change; the interrupted unit remains incomplete.' };
    const inputPath = `${INCEPTION_AREA}/reconcile-closed.json`; writeFileSync(join(root, inputPath), JSON.stringify(input));
    const result = spawnSync(process.execPath, [SCRIPT, 'unit', 'reconcile', '--repo-root', root, '--id', id, '--input', inputPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const accepted = readV2(root); const unit = accepted.units.find(u => u.id === id);
    assert.equal(unit.state, 'closed-incomplete'); assert.equal(accepted.activeUnit, null);
    assert.deepEqual(unit.before, historical.before); assert.deepEqual(unit.after, historical.after); assert.deepEqual(unit.capture, historical.capture);
    assert.deepEqual(unit.evidence.slice(0, historical.evidence.length), historical.evidence);
    assert.notDeepEqual(accepted.baseline, baseline); assert.equal(accepted.currentCycle, null);
    const reconciliation = JSON.parse(readFileSync(join(root, unit.evidence.at(-1).path), 'utf8'));
    assert.deepEqual(reconciliation.body.before, baseline); assert.deepEqual(reconciliation.body.after, accepted.baseline);
    assert.equal(reconciliation.body.statement, input.statement); assert.equal(reconciliation.body.changes[0].path, 'app.js');
    assert.equal(existsSync(join(root, unit.outputs[0].path)), false, 'recovery never fabricates an old report');
    assert.equal(unit.outputs.every(output => !existsSync(join(root, output.path))), true, 'interrupted declared outputs are not fabricated');
    assert.equal(stateV2.resumeCheck(root).ok, true);
    if (captured) {
      assert.equal(unit.capture.state, 'incomplete');
      stateV2.beginVerification(root, { environment: environmentV2(), reason: 'Verify all mandatory checks after accepted application changes' });
      assert.notDeepEqual(readV2(root).currentCycle, oldCycle);
      assert.equal(stateV2.verificationStatus(root, { cycle: readV2(root).currentCycle.path }).checks[0].result, 'not-executed');
    }
    stateV2.beginUnit(root, { id: 'explicit-drift-retry', previousUnit: id, input: { ...unitInputV2('explicit-drift-retry'), kind: captured ? 'check' : 'bootstrap', allowedPaths: captured ? [] : ['app.js'] } });
    assert.equal(readV2(root).units.at(-1).previousUnit, id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const problem of ['tampered-closure', 'tampered-stop', 'missing-closure', 'missing-publication', 'uncertain', 'partial']) test(`R1 closed-incomplete acceptance rejects ${problem} without mutation`, () => {
  const root = fixtureV2();
  try {
    writeFileSync(join(root, 'app.js'), 'Before');
    const id = 'guarded-closure'; stateV2.beginUnit(root, { id, input: { ...unitInputV2(id), kind: 'bootstrap', allowedPaths: ['app.js'] } });
    mkdirSync(join(root, INCEPTION_AREA, 'project'));
    const proof = `${INCEPTION_AREA}/project/stop-guard.json`;
    writeFileSync(join(root, proof), JSON.stringify({ unitId: id, writerStopped: true, statement: 'Coordinator observed this writer stop.' }));
    if (['uncertain', 'partial'].includes(problem)) stateV2.recordEffectIntent(root, { id: 'guard-effect', input: { ...intentV2('guard-effect'), scope: ['app.js'] } });
    writeFileSync(join(root, 'app.js'), 'Interrupted change');
    stateV2.closeIncompleteUnit(root, { id, reason: 'Interrupted', evidence: [proof] });
    const closed = structuredClone(readV2(root)); const unit = closed.units[0];
    const closureRef = unit.evidence.at(-1); const closure = JSON.parse(readFileSync(join(root, closureRef.path), 'utf8'));
    if (problem === 'tampered-closure') writeFileSync(join(root, closureRef.path), '{}');
    if (problem === 'tampered-stop') writeFileSync(join(root, closure.body.evidence[0].path), '{}');
    if (problem === 'missing-closure') { unit.evidence.pop(); writeFileSync(join(root, RUN_DESCRIPTOR_PATH), serializeRunDescriptor(closed)); }
    if (problem === 'missing-publication') {
      closed.publications = closed.publications.filter(p => !p.targets.some(ref => ref.path === closureRef.path));
      writeFileSync(join(root, RUN_DESCRIPTOR_PATH), serializeRunDescriptor(closed));
    }
    if (problem === 'partial') {
      const path = `${INCEPTION_AREA}/project/observation.json`;
      const correlation = [{ name: 'operation', value: 'exact-token' }];
      writeFileSync(join(root, path), JSON.stringify({ id: 'guard-effect', procedure: 'Read operation identity', result: 'partial', correlation, observed: 'Operation remains partial' }));
      stateV2.recordEffectOutcome(root, { id: 'guard-effect', input: { result: 'partial', observed: 'Operation remains partial', correlation, evidence: [path] } });
    }
    const before = snapshot(root);
    assert.throws(() => stateV2.reconcileUnit(root, { id, input: { evidence: [proof], reason: 'Accept observed app.js', statement: 'I accept this application change, not effect success.' } }), /digest|closure|stop|uncertain|effect/);
    assert.deepEqual(snapshot(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('R1 an incomplete capture without closure is not proof of a stopped historical writer', () => {
  const root = verificationFixtureV2(checksV2('snapshot', 'both'));
  try {
    const id = 'unclosed-capture'; const proof = stoppedCaptureV2(root, id);
    stateV2.recoverCapture(root, { unit: id });
    assert.equal(readV2(root).units.at(-1).capture.state, 'incomplete');
    const before = snapshot(root);
    assert.throws(() => stateV2.reconcileUnit(root, { id, input: { evidence: [proof], reason: 'Accept observation', statement: 'The collector exited; no closure is bound.' } }), /writer stop/);
    assert.deepEqual(snapshot(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('R1 closed-incomplete acceptance cannot displace another active writer', () => {
  const root = fixtureV2();
  try {
    const id = 'closed-without-drift'; stateV2.beginUnit(root, { id, input: unitInputV2(id) });
    mkdirSync(join(root, INCEPTION_AREA, 'project')); const proof = `${INCEPTION_AREA}/project/stopped.json`;
    writeFileSync(join(root, proof), JSON.stringify({ unitId: id, writerStopped: true, statement: 'Observed stop.' }));
    stateV2.closeIncompleteUnit(root, { id, reason: 'Interrupted', evidence: [proof] });
    stateV2.beginUnit(root, { id: 'new-active-writer', previousUnit: id, input: unitInputV2('new-active-writer') });
    const before = snapshot(root);
    assert.throws(() => stateV2.reconcileUnit(root, { id, input: { evidence: [proof], reason: 'Accept observation', statement: 'I accept the historical observation.' } }), /activeUnit|active writer/);
    assert.deepEqual(snapshot(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('R1 closed-incomplete human acceptance preserves unrelated blocks and freezes its new evidence', () => {
  const root = fixtureV2();
  try {
    writeFileSync(join(root, 'app.js'), 'Before'); const id = 'blocked-closure';
    stateV2.beginUnit(root, { id, input: { ...unitInputV2(id), allowedPaths: ['app.js'] } });
    mkdirSync(join(root, INCEPTION_AREA, 'project')); const proof = `${INCEPTION_AREA}/project/stopped.json`;
    writeFileSync(join(root, proof), JSON.stringify({ unitId: id, writerStopped: true, statement: 'Observed stop.' }));
    writeFileSync(join(root, 'app.js'), 'Accepted correction'); stateV2.closeIncompleteUnit(root, { id, reason: 'Interrupted', evidence: [proof] });
    const d = structuredClone(readV2(root)); d.blocks.push({ id: 'independent-human', reason: 'Still needs a separate decision', evidence: [] });
    writeFileSync(join(root, RUN_DESCRIPTOR_PATH), serializeRunDescriptor(d)); const blocks = readV2(root).blocks;
    stateV2.reconcileUnit(root, { id, input: { evidence: [proof], reason: 'Retain correction', statement: 'I accept app.js only; leave the other block unresolved.' } });
    const accepted = readV2(root); assert.deepEqual(accepted.blocks, blocks); assert.equal(accepted.units[0].state, 'closed-incomplete');
    assert.throws(() => stateV2.beginUnit(root, { id: 'blocked-retry', previousUnit: id, input: unitInputV2('blocked-retry') }), /blocks/);
    const record = JSON.parse(readFileSync(join(root, accepted.units[0].evidence.at(-1).path), 'utf8'));
    const frozen = readFileSync(join(root, record.body.evidence[0].path)); writeFileSync(join(root, proof), 'Working observation later changed');
    assert.deepEqual(readFileSync(join(root, record.body.evidence[0].path)), frozen);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

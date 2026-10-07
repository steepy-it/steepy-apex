import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
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
  STATUSES,
  classifyState,
  createRunDescriptor,
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
    'effects.jsonl', 'run.json',
  ]);
  assert.deepEqual(PHASES, [
    'reconnaissance', 'architecture', 'research', 'approval', 'bootstrap', 'verification', 'complete',
  ]);
  assert.deepEqual(STATUSES, ['active', 'blocked', 'complete']);
  assert.deepEqual(CAPABILITIES, ['shell', 'network', 'browser', 'subagents', 'question-tool', 'headless']);
});

test('the helper module never lists a directory', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  for (const forbidden of ['readdirSync', 'readdir(', 'opendirSync', 'opendir(']) {
    assert.equal(source.includes(forbidden), false, `module source must not contain ${forbidden}`);
  }
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
  assert.deepEqual(descriptor, baseDescriptor());
  assert.equal(serializeRunDescriptor(descriptor), text(baseDescriptor()));
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
    'run the init skill, then the discovery skill with the inception source',
  );
  assert.equal(
    nextStepFor(parseRunDescriptor(text(baseDescriptor({ status: 'blocked' })))),
    'resolve the block recorded in the latest resume note, then resume with the inception skill',
  );
  assert.equal(
    nextStepFor(parseRunDescriptor(text(baseDescriptor({ phase: 'research' })))),
    'resume with the inception skill (phase research)',
  );
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
    { args: ['effect', 'intent', '--id', 'x', '--summary', 's'], command: 'effect intent', error: /--kind/u },
    { args: ['effect', 'intent', '--id', 'x', '--kind', 'install'], command: 'effect intent', error: /--summary/u },
    { args: ['effect', 'intent', '--kind', 'install', '--summary', 's'], command: 'effect intent', error: /--id/u },
    { args: ['effect', 'intent', '--id', 'x', '--kind', 'install', '--summary', 's', '--result', 'failed'], command: 'effect intent', error: /result/u },
    { args: ['effect', 'outcome', '--id', 'x', '--result', 'maybe', '--observed', 'o'], command: 'effect outcome', error: /--result/u },
    { args: ['effect', 'outcome', '--id', 'x', '--result', 'failed'], command: 'effect outcome', error: /--observed/u },
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

// ---------------------------------------------------------------------------
// transition (HC9, SC3)
// ---------------------------------------------------------------------------

function transition(c, to, ...extra) {
  return cli(c, 'transition', '--to', to, '--reason', `move to ${to}`, ...extra);
}

const APPROVALS = ['.apex/inception/approvals/0001.json', '.apex/inception/approvals/0002.json'];

test('transition walks the forward edges, appends history, and sets approvalEntry on entering approval', () => {
  withCase('transition-forward', (c) => {
    assert.equal(cli(c, ...startArgs()).status, 0);
    const initial = readDescriptor(c);
    for (const to of ['architecture', 'research', 'approval']) {
      const { status, output } = transition(c, to);
      assert.equal(status, 0, to);
      assert.deepEqual(output, { ok: true, command: 'transition', phase: to, status: 'active' });
    }
    const descriptor = readDescriptor(c);
    assert.equal(descriptor.phase, 'approval');
    assert.equal(descriptor.approvalEntry, 0);
    assert.deepEqual(
      descriptor.history.map(({ from, to, reason }) => ({ from, to, reason })),
      [
        { from: { phase: 'reconnaissance', status: 'active' }, to: { phase: 'architecture', status: 'active' }, reason: 'move to architecture' },
        { from: { phase: 'architecture', status: 'active' }, to: { phase: 'research', status: 'active' }, reason: 'move to research' },
        { from: { phase: 'research', status: 'active' }, to: { phase: 'approval', status: 'active' }, reason: 'move to approval' },
      ],
    );
    for (const entry of descriptor.history) {
      assert.deepEqual(Object.keys(entry), ['at', 'from', 'to', 'reason']);
      assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    }
    assert.deepEqual(
      { ...descriptor, phase: initial.phase, approvalEntry: null, history: [] },
      initial,
      'a transition changes only phase, status, approvalEntry, and history',
    );
  });
});

test('bootstrap and verification may return to approval, which alone may change the commit policy', () => {
  withCase('transition-reapproval', (c) => {
    writeDescriptor(c, baseDescriptor({ phase: 'bootstrap', nextRecord: 3, approvals: APPROVALS, approvalEntry: 1 }));
    const { status, output } = transition(c, 'approval', '--git-commits', 'forbidden');
    assert.equal(status, 0);
    assert.deepEqual(output, { ok: true, command: 'transition', phase: 'approval', status: 'active' });
    const descriptor = readDescriptor(c);
    assert.equal(descriptor.git.commits, 'forbidden');
    assert.equal(descriptor.approvalEntry, 2);
    assert.deepEqual(descriptor.history.at(-1).from, { phase: 'bootstrap', status: 'active' });
  });
  withCase('transition-verification', (c) => {
    writeDescriptor(c, baseDescriptor({ phase: 'bootstrap', nextRecord: 3, approvals: APPROVALS, approvalEntry: 0 }));
    assert.equal(transition(c, 'verification').status, 0);
    assert.equal(readDescriptor(c).approvalEntry, 0, 'only entering approval moves approvalEntry');
    assert.equal(transition(c, 'approval').status, 0);
    const descriptor = readDescriptor(c);
    assert.equal(descriptor.phase, 'approval');
    assert.equal(descriptor.approvalEntry, 2);
    assert.equal(descriptor.git.commits, 'allowed');
  });
  withCase('transition-no-git', (c) => {
    writeDescriptor(c, baseDescriptor({ phase: 'verification', git: { present: false, branch: null, commits: 'none' } }));
    assert.equal(transition(c, 'approval', '--git-commits', 'allowed').status, 0);
    assert.deepEqual(readDescriptor(c).git, { present: false, branch: null, commits: 'none' }, 'without Git the policy stays none');
  });
});

test('a run blocks in place and only --to active resumes it', () => {
  withCase('transition-blocked', (c) => {
    writeDescriptor(c, baseDescriptor({ phase: 'research' }));
    assert.deepEqual(transition(c, 'blocked').output, { ok: true, command: 'transition', phase: 'research', status: 'blocked' });
    for (const to of ['approval', 'blocked', 'architecture']) {
      const before = snapshot(c.repo);
      assert.equal(transition(c, to).status, 1, `blocked -> ${to}`);
      assert.deepEqual(snapshot(c.repo), before);
    }
    assert.deepEqual(transition(c, 'active').output, { ok: true, command: 'transition', phase: 'research', status: 'active' });
    const before = snapshot(c.repo);
    assert.equal(transition(c, 'active').status, 1, 'an active run cannot be resumed');
    assert.deepEqual(snapshot(c.repo), before);
    assert.deepEqual(
      readDescriptor(c).history.map(({ from, to }) => [from, to]),
      [
        [{ phase: 'research', status: 'active' }, { phase: 'research', status: 'blocked' }],
        [{ phase: 'research', status: 'blocked' }, { phase: 'research', status: 'active' }],
      ],
    );
  });
});

test('every other transition refuses without writing', () => {
  const checkpoint = ['--checkpoint', '.apex/inception/checkpoints/0001.json', '--verification', '.apex/inception/verification/results.md'];
  const cases = [
    { label: 'skip a phase', descriptor: baseDescriptor(), args: ['research'] },
    { label: 'skip to complete', descriptor: baseDescriptor({ phase: 'research' }), args: ['complete'] },
    { label: 'backwards', descriptor: baseDescriptor({ phase: 'research' }), args: ['architecture'] },
    { label: 'backwards from approval', descriptor: baseDescriptor({ phase: 'approval', approvalEntry: 0 }), args: ['research'] },
    { label: 'backwards from verification', descriptor: baseDescriptor({ phase: 'verification' }), args: ['bootstrap'] },
    { label: 'same phase', descriptor: baseDescriptor({ phase: 'architecture' }), args: ['architecture'] },
    { label: 'approval to approval', descriptor: baseDescriptor({ phase: 'approval', approvalEntry: 0 }), args: ['approval'] },
    { label: 'complete to blocked', descriptor: completeDescriptor(), args: ['blocked'] },
    { label: 'complete to approval', descriptor: completeDescriptor(), args: ['approval'] },
    { label: 'complete to active', descriptor: completeDescriptor(), args: ['active'] },
    { label: '--git-commits on a forward edge', descriptor: baseDescriptor(), args: ['architecture', '--git-commits', 'forbidden'] },
    { label: '--git-commits entering approval forward', descriptor: baseDescriptor({ phase: 'research' }), args: ['approval', '--git-commits', 'forbidden'] },
    { label: '--git-commits on block', descriptor: baseDescriptor(), args: ['blocked', '--git-commits', 'forbidden'] },
    { label: '--checkpoint on a forward edge', descriptor: baseDescriptor(), args: ['architecture', ...checkpoint] },
    { label: '--checkpoint on a return to approval', descriptor: baseDescriptor({ phase: 'bootstrap' }), args: ['approval', ...checkpoint] },
    { label: '--verification alone on block', descriptor: baseDescriptor(), args: ['blocked', '--verification', '.apex/inception/verification/results.md'] },
  ];
  for (const { label, descriptor, args } of cases) {
    withCase('transition-refused', (c) => {
      writeDescriptor(c, descriptor);
      const before = snapshot(c.repo);
      const { status, output } = transition(c, ...args);
      assert.equal(status, 1, label);
      assert.equal(output.command, 'transition', label);
      assert.deepEqual(snapshot(c.repo), before, `${label}: refusal must not write`);
    });
  }
});

test('transition options: enums are usage errors, unsafe reasons and a missing run refuse', () => {
  withCase('transition-options', (c) => {
    writeDescriptor(c, baseDescriptor());
    const before = snapshot(c.repo);
    const cases = [
      { args: ['transition', '--reason', 'r'], status: 2, error: /--to/u },
      { args: ['transition', '--to', 'architecture'], status: 2, error: /--reason/u },
      { args: ['transition', '--to', 'done', '--reason', 'r'], status: 2, error: /--to/u },
      { args: ['transition', '--to', 'architecture', '--reason', 'r', '--git-commits', 'maybe'], status: 2, error: /--git-commits/u },
      { args: ['transition', '--to', 'architecture', '--reason', 'r', '--maturity', 'suitable'], status: 2, error: /maturity/u },
      { args: ['transition', '--to', 'architecture', '--reason=', ], status: 1, error: /--reason/u },
      { args: ['transition', '--to', 'architecture', '--reason', 'two\nlines'], status: 1, error: /--reason/u },
      { args: ['transition', '--to', 'architecture', '--reason', 'x'.repeat(1001)], status: 1, error: /--reason/u },
    ];
    for (const { args, status, error } of cases) {
      const result = cli(c, ...args);
      assert.equal(result.status, status, args.join(' '));
      assert.match(result.output.error, error, args.join(' '));
      assert.deepEqual(snapshot(c.repo), before);
    }
    assert.equal(cli(c, 'transition', '--to', 'architecture', '--reason', 'x'.repeat(1000)).status, 0);
  });
  withCase('transition-no-run', (c) => {
    const { status, output } = transition(c, 'architecture');
    assert.equal(status, 1);
    assert.match(output.error, /no inception run/u);
    assert.deepEqual(snapshot(c.repo), {});
  });
});

// ---------------------------------------------------------------------------
// resume-note (HC11, SC4)
// ---------------------------------------------------------------------------

test('two resume notes get distinct record paths, bind in order, and match the HC11 bytes', () => {
  withCase('resume-note', (c) => {
    const { runId } = cli(c, ...startArgs()).output;
    assert.equal(transition(c, 'architecture').status, 0);
    writeFile(c, '.apex/inception/project/decision-register.md', '# Decisions\n');
    writeFile(c, '.apex/inception/research/stack.md', '# Stack\n');

    const first = cli(
      c, 'resume-note', '--next', 'finish the architecture interview',
      '--need', '.apex/inception/project/decision-register.md',
      '--need', '.apex/inception/research/stack.md',
      '--note', 'waiting on the database choice',
    );
    assert.equal(first.status, 0);
    assert.deepEqual(first.output, { ok: true, command: 'resume-note', note: '.apex/inception/resume-notes/0001.md' });
    assert.equal(readFileSync(join(c.repo, first.output.note), 'utf8'), [
      '# Inception resume note 0001',
      '',
      `- Run: ${runId}`,
      '- Descriptor: `.apex/inception/run.json`',
      '- Phase: architecture',
      '- Status: active',
      '- Next: finish the architecture interview',
      '',
      '## Exact paths',
      '',
      '- `.apex/inception/project/decision-register.md`',
      '- `.apex/inception/research/stack.md`',
      '',
      '## Note',
      '',
      'waiting on the database choice',
      '',
    ].join('\n'));

    assert.equal(transition(c, 'blocked').status, 0);
    const second = cli(c, 'resume-note', '--next', 'resume after the block');
    assert.equal(second.status, 0);
    assert.equal(second.output.note, '.apex/inception/resume-notes/0002.md');
    assert.notEqual(second.output.note, first.output.note);
    assert.equal(readFileSync(join(c.repo, second.output.note), 'utf8'), [
      '# Inception resume note 0002',
      '',
      `- Run: ${runId}`,
      '- Descriptor: `.apex/inception/run.json`',
      '- Phase: architecture',
      '- Status: blocked',
      '- Next: resume after the block',
      '',
      '## Exact paths',
      '',
      '',
      '## Note',
      '',
      'none',
      '',
    ].join('\n'));

    const descriptor = readDescriptor(c);
    assert.deepEqual(descriptor.resumeNotes, ['.apex/inception/resume-notes/0001.md', '.apex/inception/resume-notes/0002.md']);
    assert.equal(descriptor.resumeNotes.at(-1), second.output.note);
    assert.equal(descriptor.nextRecord, 3);
    assert.equal(descriptor.status, 'blocked');
    assert.deepEqual(readdirSync(join(c.repo, '.apex/inception/resume-notes')).sort(), ['0001.md', '0002.md']);
  });
});

test('resume-note refuses a missing, unsafe, or out-of-area --need and an unsafe text without writing', () => {
  withCase('resume-note-refused', (c) => {
    writeDescriptor(c, baseDescriptor());
    writeFile(c, 'README.md', '# Project\n');
    writeFile(c, '.apex/inception/project/decision-register.md', '# Decisions\n');
    writeFile(c, 'elsewhere/notes.md', '# Notes\n');
    symlinkSync(join(c.repo, 'elsewhere/notes.md'), join(c.repo, '.apex/inception/project/link.md'));
    linkSync(join(c.repo, 'elsewhere/notes.md'), join(c.repo, '.apex/inception/project/hard.md'));
    symlinkSync(join(c.repo, 'elsewhere'), join(c.repo, '.apex/inception/research'));
    const cases = [
      { args: ['--need', '.apex/inception/project/missing.md'], status: 1, error: /missing\.md/u },
      { args: ['--need', 'README.md'], status: 1, error: /README\.md/u },
      { args: ['--need', '.apex/inception/../../README.md'], status: 1, error: /--need/u },
      { args: ['--need', '/etc/hosts'], status: 1, error: /--need/u },
      { args: ['--need', '.apex/inception/project/link.md'], status: 1, error: /link\.md/u },
      { args: ['--need', '.apex/inception/project/hard.md'], status: 1, error: /hard\.md/u },
      { args: ['--need', '.apex/inception/project'], status: 1, error: /project/u },
      { args: ['--need', '.apex/inception/research/notes.md'], status: 1, error: /research/u },
      { args: ['--need', '.apex/inception/project/decision-register.md', '--need', '.apex/inception/project/missing.md'], status: 1, error: /missing\.md/u },
      { args: ['--note', 'two\nlines'], status: 1, error: /--note/u },
      { args: ['--next='], status: 1, error: /--next/u, next: false },
      { args: [], status: 2, error: /--next/u, next: false },
      { args: ['--need'], status: 2, error: /need/u },
    ];
    for (const { args, status, error, next = true } of cases) {
      const before = snapshot(c.repo);
      const result = cli(c, 'resume-note', ...(next ? ['--next', 'continue'] : []), ...args);
      assert.equal(result.status, status, args.join(' '));
      assert.match(result.output.error, error, args.join(' '));
      assert.deepEqual(snapshot(c.repo), before, `${args.join(' ')}: refusal must not write`);
    }
  });
  withCase('resume-note-occupied', (c) => {
    writeDescriptor(c, baseDescriptor());
    writeFile(c, '.apex/inception/resume-notes/0001.md', 'stray\n');
    const before = snapshot(c.repo);
    const { status, output } = cli(c, 'resume-note', '--next', 'continue');
    assert.equal(status, 1);
    assert.match(output.error, /0001\.md/u);
    assert.deepEqual(snapshot(c.repo), before);
  });
  withCase('resume-note-no-run', (c) => {
    assert.equal(cli(c, 'resume-note', '--next', 'continue').status, 1);
    assert.deepEqual(snapshot(c.repo), {});
  });
});

// ---------------------------------------------------------------------------
// approve and verify-approval (HC12, SC5)
// ---------------------------------------------------------------------------

const REGISTER = '.apex/inception/project/decision-register.md';
const ARCHITECTURE = '.apex/inception/project/architecture.md';
const STACK = '.apex/inception/project/nested/stack.md';
const PROJECT_DOCS = Object.freeze({
  [REGISTER]: '# Decisions\n\n- D1: the stack is Node\n',
  [ARCHITECTURE]: '# Architecture\n\nOne web service.\n',
  [STACK]: '# Stack\n',
});
const STATEMENT = 'I approve this project as written.\n\tIt includes the stack and the decision register.\nSigned: the owner';
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function digestOf(c, path) {
  const bytes = readFileSync(join(c.repo, path));
  return { path, bytes: bytes.length, sha256: sha256(bytes) };
}

// Starts a run and walks it forward to `phase` (reconnaissance through verification) through the
// real CLI. Reaching bootstrap or later approves the project documents on the way.
function startAt(c, phase, startOverrides = {}) {
  const { runId } = cli(c, ...startArgs(startOverrides)).output;
  for (const to of PHASES.slice(1, PHASES.indexOf(phase) + 1)) {
    if (to === 'bootstrap') {
      writeProject(c);
      assert.equal(approve(c, STATEMENT, Object.keys(PROJECT_DOCS)).status, 0);
    }
    assert.equal(transition(c, to).status, 0, `transition to ${to}`);
  }
  return runId;
}

function writeProject(c, documents = PROJECT_DOCS) {
  for (const [path, content] of Object.entries(documents)) writeFile(c, path, content);
}

function approve(c, statement, documents) {
  return cli(c, 'approve', '--statement', statement, ...documents.flatMap((path) => ['--document', path]));
}

test('approve records every named document with its size and digest and the verbatim multi-line statement', () => {
  withCase('approve', (c) => {
    const runId = startAt(c, 'approval');
    writeProject(c);
    const before = snapshot(c.repo);
    const { status, output } = approve(c, STATEMENT, [STACK, REGISTER, ARCHITECTURE]);
    assert.equal(status, 0);
    const documents = [ARCHITECTURE, REGISTER, STACK].map((path) => digestOf(c, path));
    assert.deepEqual(output, { ok: true, command: 'approve', approval: '.apex/inception/approvals/0001.json', documents });

    const bytes = readFileSync(join(c.repo, output.approval), 'utf8');
    const record = JSON.parse(bytes);
    assert.equal(bytes, text(record));
    assert.deepEqual(Object.keys(record), ['schema', 'runId', 'record', 'at', 'statement', 'documents']);
    assert.match(record.at, TIMESTAMP_PATTERN);
    assert.deepEqual(record, { schema: 'steepy-inception-approval/v1', runId, record: 1, at: record.at, statement: STATEMENT, documents });
    assert.equal(record.statement, STATEMENT, 'the multi-line statement round-trips exactly');
    for (const entry of record.documents) assert.deepEqual(Object.keys(entry), ['path', 'bytes', 'sha256']);

    const descriptor = readDescriptor(c);
    assert.deepEqual(descriptor.approvals, [output.approval]);
    assert.equal(descriptor.nextRecord, 2);
    assert.deepEqual(
      Object.keys(snapshot(c.repo)).filter((path) => !(path in before)).sort(),
      ['.apex/inception/approvals', '.apex/inception/approvals/0001.json'],
      'approve writes only its record (and binds it in the descriptor)',
    );

    const limit = 'x'.repeat(8000);
    assert.equal(transition(c, 'blocked').status, 0);
    assert.equal(transition(c, 'active').status, 0);
    assert.equal(approve(c, limit, [REGISTER]).status, 0, 'a statement of exactly 8000 characters is accepted');
    assert.equal(JSON.parse(readFileSync(join(c.repo, '.apex/inception/approvals/0002.json'), 'utf8')).statement, limit);
  });
});

test('verify-approval passes unchanged documents and reports each changed, missing, or unsafe one with exit 1', () => {
  withCase('verify-approval', (c) => {
    startAt(c, 'approval');
    writeProject(c);
    const approval = approve(c, STATEMENT, Object.keys(PROJECT_DOCS)).output;
    const verify = () => {
      const before = snapshot(c.repo);
      const result = cli(c, 'verify-approval');
      assert.deepEqual(snapshot(c.repo), before, 'verify-approval never writes');
      return result;
    };

    assert.deepEqual(verify(), {
      status: 0,
      output: { ok: true, command: 'verify-approval', approval: approval.approval, documents: approval.documents },
    });

    const original = readFileSync(join(c.repo, ARCHITECTURE));
    const changed = Buffer.from(original);
    changed[0] ^= 1;
    writeFileSync(join(c.repo, ARCHITECTURE), changed);
    const oneByte = verify();
    assert.equal(oneByte.status, 1);
    assert.equal(oneByte.output.ok, false);
    assert.equal(oneByte.output.approval, approval.approval);
    assert.deepEqual(oneByte.output.divergences, [{ path: ARCHITECTURE, kind: 'changed' }]);
    assert.match(oneByte.output.error, /architecture\.md/u);

    writeFileSync(join(c.repo, ARCHITECTURE), Buffer.concat([original, Buffer.from('x')]));
    assert.deepEqual(verify().output.divergences, [{ path: ARCHITECTURE, kind: 'changed' }], 'one appended byte is a change');
    writeFileSync(join(c.repo, ARCHITECTURE), original);
    assert.equal(verify().status, 0, 'restoring the bytes verifies again');

    rmSync(join(c.repo, STACK));
    assert.deepEqual(verify().output.divergences, [{ path: STACK, kind: 'missing' }]);
    rmSync(join(c.repo, '.apex/inception/project/nested'), { recursive: true });
    assert.deepEqual(verify().output.divergences, [{ path: STACK, kind: 'missing' }], 'a missing parent directory is missing');

    writeFile(c, 'elsewhere/stack.md', PROJECT_DOCS[STACK]);
    symlinkSync(join(c.repo, 'elsewhere'), join(c.repo, '.apex/inception/project/nested'));
    assert.deepEqual(verify().output.divergences, [{ path: STACK, kind: 'unsafe' }], 'a symlinked parent is unsafe');
    rmSync(join(c.repo, '.apex/inception/project/nested'));
    writeFile(c, STACK, PROJECT_DOCS[STACK]);
    assert.equal(verify().status, 0);

    linkSync(join(c.repo, STACK), join(c.repo, 'stack-copy.md'));
    assert.deepEqual(verify().output.divergences, [{ path: STACK, kind: 'unsafe' }], 'a hard-linked document is unsafe');
    rmSync(join(c.repo, 'stack-copy.md'));
    rmSync(join(c.repo, REGISTER));
    symlinkSync(join(c.repo, 'elsewhere/stack.md'), join(c.repo, REGISTER));
    assert.deepEqual(verify().output.divergences, [{ path: REGISTER, kind: 'unsafe' }], 'a symlinked document is unsafe');
    rmSync(join(c.repo, REGISTER));
    mkdirSync(join(c.repo, REGISTER));
    rmSync(join(c.repo, ARCHITECTURE));
    assert.deepEqual(verify().output.divergences, [
      { path: ARCHITECTURE, kind: 'missing' },
      { path: REGISTER, kind: 'unsafe' },
    ], 'every divergence is reported, in document order');
  });
});

test('approve refuses outside phase approval, outside the project area, without the decision register, and for unsafe documents', () => {
  const fixtures = [
    {
      label: 'phase research',
      setup(c) { writeFile(c, RUN_DESCRIPTOR_PATH, text({ ...readDescriptor(c), phase: 'research', approvalEntry: null })); },
      documents: [REGISTER], error: /phase approval/u,
    },
    { label: 'blocked run', blocked: true, documents: [REGISTER], error: /status active/u },
    { label: 'research report', documents: [REGISTER, '.apex/inception/research/stack.md'], error: /research\/stack\.md/u },
    { label: 'application file', documents: [REGISTER, 'README.md'], error: /README\.md/u },
    { label: 'parent segment', documents: [REGISTER, '.apex/inception/project/../research/stack.md'], error: /--document/u },
    { label: 'project directory itself', documents: [REGISTER, '.apex/inception/project/'], error: /--document/u },
    { label: 'absolute path', documents: [REGISTER, '/etc/hosts'], error: /--document/u },
    { label: 'no decision register', documents: [ARCHITECTURE], error: /decision-register\.md/u },
    { label: 'duplicate document', documents: [REGISTER, ARCHITECTURE, REGISTER], error: /decision-register\.md/u },
    { label: 'missing document', documents: [REGISTER, '.apex/inception/project/missing.md'], error: /missing\.md/u },
    {
      label: 'hard-linked document',
      setup(c) { linkSync(join(c.repo, ARCHITECTURE), join(c.repo, 'architecture-copy.md')); },
      documents: [REGISTER, ARCHITECTURE], error: /architecture\.md/u,
    },
    {
      label: 'symlinked document',
      setup(c) { writeFile(c, 'elsewhere.md', 'x\n'); symlinkSync(join(c.repo, 'elsewhere.md'), join(c.repo, '.apex/inception/project/link.md')); },
      documents: [REGISTER, '.apex/inception/project/link.md'], error: /link\.md/u,
    },
    {
      label: 'symlinked document directory',
      setup(c) { writeFile(c, 'elsewhere/stack.md', 'x\n'); rmSync(join(c.repo, '.apex/inception/project/nested'), { recursive: true }); symlinkSync(join(c.repo, 'elsewhere'), join(c.repo, '.apex/inception/project/nested')); },
      documents: [REGISTER, STACK], error: /nested/u,
    },
    {
      label: 'document that is a directory',
      setup(c) { mkdirSync(join(c.repo, '.apex/inception/project/folder.md')); },
      documents: [REGISTER, '.apex/inception/project/folder.md'], error: /folder\.md/u,
    },
    { label: 'occupied record slot', setup(c) { writeFile(c, '.apex/inception/approvals/0001.json', '{}\n'); }, documents: [REGISTER], error: /0001\.json/u },
    {
      label: 'symlinked approvals directory',
      setup(c) { mkdirSync(join(c.repo, 'elsewhere-approvals')); symlinkSync(join(c.repo, 'elsewhere-approvals'), join(c.repo, '.apex/inception/approvals')); },
      documents: [REGISTER], error: /real directory/u,
    },
    { label: 'empty statement', statement: '', documents: [REGISTER], error: /--statement/u },
    { label: 'statement over 8000 characters', statement: 'x'.repeat(8001), documents: [REGISTER], error: /--statement/u },
    { label: 'statement with a carriage return', statement: 'yes\r\nno', documents: [REGISTER], error: /--statement/u },
    { label: 'statement with an escape character', statement: 'yes\u001b[31m', documents: [REGISTER], error: /--statement/u },
  ];
  eachCopy('approve-refused', (c) => { startAt(c, 'approval'); writeProject(c); }, fixtures, (c, fixture) => {
    if (fixture.blocked) assert.equal(transition(c, 'blocked').status, 0);
    fixture.setup?.(c);
    const before = snapshot(c.repo);
    const { status, output } = approve(c, fixture.statement ?? STATEMENT, fixture.documents);
    assert.equal(status, 1, fixture.label);
    assert.equal(output.command, 'approve', fixture.label);
    assert.match(output.error, fixture.error, fixture.label);
    assert.deepEqual(snapshot(c.repo), before, `${fixture.label}: refusal must not write`);
  });
  withCase('approve-no-run', (c) => {
    assert.match(approve(c, STATEMENT, [REGISTER]).output.error, /no inception run/u);
    assert.deepEqual(snapshot(c.repo), {});
  });
});

test('verify-approval refuses without an approval, for an unbound --approval, and for a missing or tampered record', () => {
  withCase('verify-approval-none', (c) => {
    startAt(c, 'approval');
    const before = snapshot(c.repo);
    const { status, output } = cli(c, 'verify-approval');
    assert.equal(status, 1);
    assert.match(output.error, /no approval/u);
    assert.equal('divergences' in output, false);
    assert.deepEqual(snapshot(c.repo), before);
  });
  const record = (c) => JSON.parse(readFileSync(join(c.repo, '.apex/inception/approvals/0001.json'), 'utf8'));
  const tamper = {
    'unbound --approval': { args: ['--approval', '.apex/inception/approvals/0002.json'], error: /0002\.json/u },
    'unsafe --approval': { args: ['--approval', '.apex/inception/approvals/../run.json'], error: /--approval/u },
    'record deleted': { setup(c) { rmSync(join(c.repo, '.apex/inception/approvals/0001.json')); }, error: /0001\.json/u },
    'record hard-linked': { setup(c) { linkSync(join(c.repo, '.apex/inception/approvals/0001.json'), join(c.repo, 'copy.json')); }, error: /hard link/u },
    'record with a foreign runId': {
      setup(c) { writeFile(c, '.apex/inception/approvals/0001.json', text({ ...record(c), runId: 'inc-20261007T120000Z-ffffffff' })); },
      error: /runId/u,
    },
    'record numbered for another slot': { setup(c) { writeFile(c, '.apex/inception/approvals/0001.json', text({ ...record(c), record: 2 })); }, error: /record/u },
    'record without the decision register': {
      setup(c) { const value = record(c); writeFile(c, '.apex/inception/approvals/0001.json', text({ ...value, documents: value.documents.filter((entry) => entry.path !== REGISTER) })); },
      error: /decision-register\.md/u,
    },
    'record with unsorted documents': {
      setup(c) { const value = record(c); writeFile(c, '.apex/inception/approvals/0001.json', text({ ...value, documents: [...value.documents].reverse() })); },
      error: /sorted/u,
    },
    'record with a duplicate key': {
      setup(c) { writeFile(c, '.apex/inception/approvals/0001.json', insertAfter(text(record(c)), '{\n', '  "statement": "forged",\n')); },
      error: /duplicate key/u,
    },
    'record with an extra key': { setup(c) { writeFile(c, '.apex/inception/approvals/0001.json', text({ ...record(c), approvedBy: 'someone' })); }, error: /keys/u },
  };
  const build = (c) => {
    startAt(c, 'approval');
    writeProject(c);
    assert.equal(approve(c, STATEMENT, Object.keys(PROJECT_DOCS)).status, 0);
  };
  eachCopy('verify-approval-refused', build, Object.entries(tamper), (c, [label, { setup, args = [], error }]) => {
    setup?.(c);
    const before = snapshot(c.repo);
    const { status, output } = cli(c, 'verify-approval', ...args);
    assert.equal(status, 1, label);
    assert.match(output.error, error, label);
    assert.equal('divergences' in output, false, `${label}: a refusal is not a divergence report`);
    assert.deepEqual(snapshot(c.repo), before, `${label}: verify-approval never writes`);
  });
});

test('approval -> bootstrap needs a new clean approval since entering approval', () => {
  withCase('gate-approval', (c) => {
    startAt(c, 'approval');
    writeProject(c);
    let before = snapshot(c.repo);
    let refused = transition(c, 'bootstrap');
    assert.equal(refused.status, 1);
    assert.match(refused.output.error, /new approval/u);
    assert.deepEqual(snapshot(c.repo), before);

    const first = approve(c, STATEMENT, Object.keys(PROJECT_DOCS)).output.approval;
    writeFileSync(join(c.repo, ARCHITECTURE), `${PROJECT_DOCS[ARCHITECTURE]}edited after approval\n`);
    before = snapshot(c.repo);
    refused = transition(c, 'bootstrap');
    assert.equal(refused.status, 1);
    assert.match(refused.output.error, /architecture\.md/u, 'a diverging latest approval refuses');
    assert.deepEqual(snapshot(c.repo), before);

    writeFileSync(join(c.repo, ARCHITECTURE), PROJECT_DOCS[ARCHITECTURE]);
    assert.deepEqual(transition(c, 'bootstrap').output, { ok: true, command: 'transition', phase: 'bootstrap', status: 'active' });

    // Back to approval: the first approval predates the new entry and no longer opens the gate.
    assert.equal(transition(c, 'approval').status, 0);
    assert.equal(readDescriptor(c).approvalEntry, 1);
    before = snapshot(c.repo);
    refused = transition(c, 'bootstrap');
    assert.equal(refused.status, 1);
    assert.match(refused.output.error, /new approval/u);
    assert.deepEqual(snapshot(c.repo), before);

    const firstBytes = readFileSync(join(c.repo, first));
    writeFileSync(join(c.repo, ARCHITECTURE), '# Architecture\n\nTwo web services.\n');
    const second = approve(c, 'Approved again after the change.', Object.keys(PROJECT_DOCS));
    assert.equal(second.status, 0);
    assert.notEqual(second.output.approval, first);
    assert.equal(second.output.approval, '.apex/inception/approvals/0002.json');
    assert.deepEqual(readFileSync(join(c.repo, first)), firstBytes, 'the first approval record stays byte-identical');
    assert.deepEqual(readDescriptor(c).approvals, [first, second.output.approval]);

    assert.equal(cli(c, 'verify-approval').output.approval, second.output.approval, 'the latest approval is verified by default');
    const old = cli(c, 'verify-approval', '--approval', first);
    assert.equal(old.status, 1, 'the first approval no longer matches the documents');
    assert.deepEqual(old.output.divergences, [{ path: ARCHITECTURE, kind: 'changed' }]);
    assert.equal(transition(c, 'bootstrap').status, 0);
  });
  withCase('gate-approval-no-entry', (c) => {
    writeDescriptor(c, baseDescriptor({ phase: 'approval', approvalEntry: null }));
    const before = snapshot(c.repo);
    assert.equal(transition(c, 'bootstrap').status, 1, 'an approval phase without an entry mark refuses');
    assert.deepEqual(snapshot(c.repo), before);
  });
});

// ---------------------------------------------------------------------------
// effect intent, outcome, status (HC13, SC6)
// ---------------------------------------------------------------------------

const EFFECT_LOG = '.apex/inception/effects.jsonl';
const EFFECT_KINDS = ['install', 'generator', 'migration', 'external-resource', 'deploy', 'commit', 'remote'];

function intent(c, id, kind, summary = `run ${id}`, ...extra) {
  return cli(c, 'effect', 'intent', '--id', id, '--kind', kind, '--summary', summary, ...extra);
}

function outcome(c, id, result = 'succeeded', observed = `observed ${id}`) {
  return cli(c, 'effect', 'outcome', '--id', id, '--result', result, '--observed', observed);
}

function effectLog(c) {
  return readFileSync(join(c.repo, EFFECT_LOG));
}

test('the effect log appends HC13 intent and outcome lines and never rewrites earlier bytes', () => {
  withCase('effects', (c) => {
    startAt(c, 'architecture');
    let previous = Buffer.alloc(0);
    const appended = [];
    const append = (result) => {
      assert.equal(result.status, 0, JSON.stringify(result.output));
      const bytes = effectLog(c);
      assert.deepEqual(bytes.subarray(0, previous.length), previous, 'earlier bytes are a prefix after each append');
      const line = bytes.subarray(previous.length).toString('utf8');
      assert.match(line, /^[^\n]+\n$/u, 'each append adds exactly one line');
      previous = bytes;
      appended.push(JSON.parse(line));
      assert.deepEqual(result.output.effect, appended.at(-1), 'the output echoes the appended line');
      return appended.at(-1);
    };

    const install = append(intent(c, 'install-deps', 'install', 'npm install'));
    assert.equal(JSON.stringify(install), effectLog(c).toString('utf8').trimEnd());
    assert.deepEqual(Object.keys(install), ['schema', 'type', 'id', 'kind', 'summary', 'authorization', 'phase', 'at']);
    assert.deepEqual({ ...install, at: undefined }, {
      schema: 'steepy-inception-effect/v1', type: 'intent', id: 'install-deps', kind: 'install', summary: 'npm install',
      authorization: null, phase: 'architecture', at: undefined,
    });
    assert.match(install.at, TIMESTAMP_PATTERN);

    const push = append(intent(c, 'push-main', 'remote', 'git push origin main', '--authorization', 'the owner authorized this push'));
    assert.equal(push.authorization, 'the owner authorized this push');
    append(intent(c, 'deploy-preview', 'deploy', 'deploy the preview', '--authorization', 'the owner authorized this deploy'));
    for (const kind of ['generator', 'migration', 'external-resource', 'commit']) append(intent(c, `${kind}-1`, kind));

    const done = append(outcome(c, 'install-deps', 'succeeded', 'added 120 packages'));
    assert.deepEqual(Object.keys(done), ['schema', 'type', 'id', 'result', 'observed', 'phase', 'at']);
    assert.deepEqual({ ...done, at: undefined }, {
      schema: 'steepy-inception-effect/v1', type: 'outcome', id: 'install-deps', result: 'succeeded',
      observed: 'added 120 packages', phase: 'architecture', at: undefined,
    });
    append(outcome(c, 'push-main', 'failed', 'the remote rejected the push'));
    assert.equal(transition(c, 'research').status, 0);
    assert.equal(append(outcome(c, 'commit-1')).phase, 'research', 'each line records the phase it was appended in');

    const before = snapshot(c.repo);
    const status = cli(c, 'effect', 'status');
    assert.deepEqual(snapshot(c.repo), before, 'effect status never writes');
    assert.deepEqual(status, {
      status: 0,
      output: {
        ok: true,
        command: 'effect status',
        effects: [
          { id: 'install-deps', kind: 'install', state: 'concluded', result: 'succeeded' },
          { id: 'push-main', kind: 'remote', state: 'concluded', result: 'failed' },
          { id: 'deploy-preview', kind: 'deploy', state: 'uncertain' },
          { id: 'generator-1', kind: 'generator', state: 'uncertain' },
          { id: 'migration-1', kind: 'migration', state: 'uncertain' },
          { id: 'external-resource-1', kind: 'external-resource', state: 'uncertain' },
          { id: 'commit-1', kind: 'commit', state: 'concluded', result: 'succeeded' },
        ],
        uncertain: 4,
      },
    });
  });
});

test('effect status on a run without a log lists nothing and is allowed while blocked', () => {
  withCase('effects-empty', (c) => {
    startAt(c, 'research');
    assert.equal(transition(c, 'blocked').status, 0);
    const before = snapshot(c.repo);
    assert.deepEqual(cli(c, 'effect', 'status').output, { ok: true, command: 'effect status', effects: [], uncertain: 0 });
    assert.deepEqual(snapshot(c.repo), before);
  });
});

test('an intent without an outcome stays uncertain across processes until its outcome is appended', () => {
  withCase('effects-interrupted', (c) => {
    startAt(c, 'architecture');
    // The intent is appended by one process; the interruption means no outcome ever follows it.
    assert.equal(intent(c, 'create-app', 'generator', 'npm create vite').status, 0);
    const fresh = cli(c, 'effect', 'status');
    assert.deepEqual(fresh.output.effects, [{ id: 'create-app', kind: 'generator', state: 'uncertain' }]);
    assert.equal(fresh.output.uncertain, 1);
    assert.equal(outcome(c, 'create-app', 'failed', 'the generator was interrupted').status, 0);
    assert.deepEqual(cli(c, 'effect', 'status').output.effects, [{ id: 'create-app', kind: 'generator', state: 'concluded', result: 'failed' }]);
  });
});

test('effect commands fail closed on a reused id, a missing intent, a second outcome, a missing authorization, or a non-active run', () => {
  withCase('effects-refused', (c) => {
    startAt(c, 'architecture');
    assert.equal(intent(c, 'install-deps', 'install').status, 0);
    assert.equal(outcome(c, 'install-deps').status, 0);
    assert.equal(intent(c, 'pending', 'migration').status, 0);
    const cases = [
      { label: 'intent for an id with an outcome', run: () => intent(c, 'install-deps', 'install'), error: /install-deps/u },
      { label: 'intent for an id with only an intent', run: () => intent(c, 'pending', 'migration'), error: /pending/u },
      { label: 'intent reusing an id with another kind', run: () => intent(c, 'pending', 'install'), error: /pending/u },
      { label: 'outcome without an intent', run: () => outcome(c, 'never-started'), error: /never-started/u },
      { label: 'second outcome', run: () => outcome(c, 'install-deps', 'failed'), error: /install-deps/u },
      { label: 'remote without authorization', run: () => intent(c, 'push', 'remote'), error: /--authorization/u },
      { label: 'deploy without authorization', run: () => intent(c, 'ship', 'deploy'), error: /--authorization/u },
      { label: 'empty authorization', run: () => intent(c, 'push', 'remote', 'git push', '--authorization='), error: /--authorization/u },
      { label: 'uppercase id', run: () => intent(c, 'Install', 'install'), error: /--id/u },
      { label: 'id with a slash', run: () => intent(c, 'a/b', 'install'), error: /--id/u },
      { label: 'id over 64 characters', run: () => intent(c, `a${'b'.repeat(64)}`, 'install'), error: /--id/u },
      { label: 'multi-line summary', run: () => intent(c, 'x', 'install', 'two\nlines'), error: /--summary/u },
      { label: 'empty observation', run: () => outcome(c, 'pending', 'failed', ''), error: /--observed/u },
      { label: 'multi-line authorization', run: () => intent(c, 'push', 'remote', 'git push', '--authorization', 'yes\nno'), error: /--authorization/u },
    ];
    for (const { label, run, error } of cases) {
      const before = snapshot(c.repo);
      const { status, output } = run();
      assert.equal(status, 1, label);
      assert.match(output.error, error, label);
      assert.deepEqual(snapshot(c.repo), before, `${label}: refusal must not write`);
    }
    assert.equal(intent(c, `a${'b'.repeat(63)}`, 'install').status, 0, 'a 64-character id is accepted');

    assert.equal(transition(c, 'blocked').status, 0);
    const before = snapshot(c.repo);
    for (const result of [intent(c, 'later', 'install'), outcome(c, 'pending')]) {
      assert.equal(result.status, 1);
      assert.match(result.output.error, /status active/u);
    }
    assert.deepEqual(snapshot(c.repo), before, 'a blocked run appends nothing');
    assert.equal(cli(c, 'effect', 'status').output.uncertain, 2, 'pending and the 64-character id');
  });
  withCase('effects-no-run', (c) => {
    for (const result of [intent(c, 'x', 'install'), outcome(c, 'x'), cli(c, 'effect', 'status')]) {
      assert.equal(result.status, 1);
      assert.match(result.output.error, /no inception run/u);
    }
    assert.deepEqual(snapshot(c.repo), {});
  });
});

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

function invalidUtf8Line(prefix) {
  const [head, tail] = intentLine('y').split('run y');
  return Buffer.concat([Buffer.from(`${prefix}${head}run `), Buffer.from([0xff]), Buffer.from(`${tail}\n`)]);
}

test('a malformed effect log refuses every effect command at its first bad line and appends nothing', () => {
  const good = `${intentLine('install-deps')}\n`;
  const fixtures = [
    { label: 'truncated final line', log: `${good}${intentLine('create-app').slice(0, 40)}`, line: 2 },
    { label: 'complete line without its newline', log: intentLine('install-deps'), line: 1 },
    { label: 'blank line', log: `${good}\n`, line: 2 },
    { label: 'not JSON', log: `${good}not json\n`, line: 2 },
    { label: 'an array line', log: '[]\n', line: 1 },
    { label: 'outcome before its intent', log: `${outcomeLine('install-deps')}\n${good}`, line: 1 },
    { label: 'two intents for one id', log: `${good}${intentLine('install-deps', 'generator')}\n`, line: 2 },
    { label: 'two outcomes for one id', log: `${good}${outcomeLine('install-deps')}\n${outcomeLine('install-deps', { result: 'failed' })}\n`, line: 3 },
    { label: 'duplicate key', log: `${good}${intentLine('x').replace('{', '{"id":"y",')}\n`, line: 2 },
    { label: 'extra key', log: `${intentLine('x', 'install', { extra: 1 })}\n`, line: 1 },
    { label: 'reordered keys', log: `${JSON.stringify({ type: 'intent', schema: 'steepy-inception-effect/v1', id: 'x', kind: 'install', summary: 's', authorization: null, phase: 'architecture', at: '2026-10-07T12:00:00.000Z' })}\n`, line: 1 },
    { label: 'wrong schema', log: `${intentLine('x', 'install', { schema: 'steepy-inception-effect/v2' })}\n`, line: 1 },
    { label: 'unknown type', log: `${intentLine('x', 'install', { type: 'note' })}\n`, line: 1 },
    { label: 'unknown kind', log: `${intentLine('x', 'telepathy')}\n`, line: 1 },
    { label: 'remote intent without authorization', log: `${intentLine('x', 'remote')}\n`, line: 1 },
    { label: 'unknown result', log: `${good}${outcomeLine('install-deps', { result: 'maybe' })}\n`, line: 2 },
    { label: 'bad timestamp', log: `${intentLine('x', 'install', { at: 'yesterday' })}\n`, line: 1 },
    { label: 'unknown phase', log: `${intentLine('x', 'install', { phase: 'design' })}\n`, line: 1 },
    { label: 'unsafe id', log: `${intentLine('X Y')}\n`, line: 1 },
    { label: 'carriage return line ending', log: `${intentLine('x')}\r\n`, line: 1 },
    { label: 'spaced JSON', log: `${good}${JSON.stringify(JSON.parse(intentLine('x')), null, 1).replaceAll('\n', '')}\n`, line: 2 },
    // A lenient decoder would read the byte as U+FFFD and accept the summary.
    { label: 'invalid UTF-8 in a summary', log: invalidUtf8Line(good), line: 2 },
  ];
  eachCopy('effects-malformed', (c) => startAt(c, 'architecture'), fixtures, (c, fixture) => {
    writeFile(c, EFFECT_LOG, fixture.log);
    const commands = [
      () => intent(c, 'next-effect', 'install'),
      () => outcome(c, 'install-deps'),
      () => outcome(c, 'x'),
      () => cli(c, 'effect', 'status'),
    ];
    for (const run of commands) {
      const before = snapshot(c.repo);
      const { status, output } = run();
      assert.equal(status, 1, fixture.label);
      assert.equal(output.error, `effect log is malformed at line ${fixture.line}`, fixture.label);
      assert.deepEqual(snapshot(c.repo), before, `${fixture.label}: nothing is appended`);
    }
  });
});

test('an unsafe effect log refuses every effect command without writing', () => {
  const fixtures = [
    { label: 'symlinked log', setup(c) { writeFile(c, 'elsewhere.jsonl', ''); symlinkSync(join(c.repo, 'elsewhere.jsonl'), join(c.repo, EFFECT_LOG)); } },
    { label: 'hard-linked log', setup(c) { writeFile(c, EFFECT_LOG, ''); linkSync(join(c.repo, EFFECT_LOG), join(c.repo, 'copy.jsonl')); } },
    { label: 'log that is a directory', setup(c) { mkdirSync(join(c.repo, EFFECT_LOG)); } },
  ];
  for (const fixture of fixtures) {
    withCase('effects-unsafe', (c) => {
      startAt(c, 'architecture');
      fixture.setup(c);
      for (const run of [() => intent(c, 'x', 'install'), () => outcome(c, 'x'), () => cli(c, 'effect', 'status')]) {
        const before = snapshot(c.repo);
        const { status, output } = run();
        assert.equal(status, 1, fixture.label);
        assert.match(output.error, /effects\.jsonl/u, fixture.label);
        assert.deepEqual(snapshot(c.repo), before, `${fixture.label}: refusal must not write`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// checkpoint create and verify (HC10, HC14, SC7)
// ---------------------------------------------------------------------------

const PAGE = 'app/[id]/page.tsx';
const APP_FILES = Object.freeze({
  'package.json': '{ "name": "app" }\n',
  'src/index.js': 'console.log(1);\n',
  [PAGE]: 'export default function Page() { return null; }\n',
});
const APP_PATHS = Object.keys(APP_FILES).sort();

function writeApp(c, files = APP_FILES) {
  for (const [path, content] of Object.entries(files)) writeFile(c, path, content);
}

// A temporary Git repository with one commit holding the application files.
function initRepo(c) {
  git(c, 'init', '--quiet', '-b', 'main');
  writeApp(c);
  git(c, 'add', '--all');
  git(c, 'commit', '--quiet', '-m', 'initial');
  return git(c, 'rev-parse', 'HEAD').trim();
}

function gitStatus(c) {
  return git(c, 'status', '--porcelain=v1', '-z', '--untracked-files=all').split('\0').filter((entry) => entry !== '').sort();
}

function checkpoint(c, label, files, ...extra) {
  return cli(c, 'checkpoint', 'create', '--label', label, ...files.flatMap((path) => ['--file', path]), ...extra);
}

// Runs `checkpoint verify` and proves it wrote nothing outside `.git`.
function verifyCheckpoint(c, ...args) {
  const before = snapshot(c.repo, { exclude: ['.git', '.git-away'] });
  const result = cli(c, 'checkpoint', 'verify', ...args);
  assert.deepEqual(snapshot(c.repo, { exclude: ['.git', '.git-away'] }), before, 'checkpoint verify never writes');
  return result;
}

test('checkpoint create records file digests plus Git branch, HEAD, and sorted porcelain status', () => {
  withCase('checkpoint', (c) => {
    const head = initRepo(c);
    const runId = startAt(c, 'bootstrap');
    writeFileSync(join(c.repo, 'src/index.js'), 'console.log(2);\n');
    writeApp(c, { 'z-untracked.txt': 'z\n', 'a-untracked.txt': 'a\n' });
    const status = gitStatus(c);
    assert.deepEqual(status, [' M src/index.js', '?? a-untracked.txt', '?? z-untracked.txt']);

    const before = snapshot(c.repo, { exclude: ['.git'] });
    const result = checkpoint(c, 'after the scaffold', ['src/index.js', PAGE, 'package.json']);
    assert.equal(result.status, 0);
    const files = APP_PATHS.map((path) => digestOf(c, path));
    assert.deepEqual(result.output, { ok: true, command: 'checkpoint create', checkpoint: '.apex/inception/checkpoints/0002.json', files });
    assert.deepEqual(
      Object.keys(snapshot(c.repo, { exclude: ['.git'] })).filter((path) => !(path in before)).sort(),
      ['.apex/inception/checkpoints', '.apex/inception/checkpoints/0002.json'],
    );

    const bytes = readFileSync(join(c.repo, result.output.checkpoint), 'utf8');
    const record = JSON.parse(bytes);
    assert.equal(bytes, text(record));
    assert.deepEqual(Object.keys(record), ['schema', 'runId', 'record', 'at', 'label', 'phase', 'files', 'git']);
    assert.deepEqual(Object.keys(record.git), ['present', 'branch', 'head', 'status']);
    assert.match(record.at, TIMESTAMP_PATTERN);
    assert.deepEqual(record, {
      schema: 'steepy-inception-checkpoint/v1', runId, record: 2, at: record.at, label: 'after the scaffold', phase: 'bootstrap',
      files, git: { present: true, branch: 'main', head, status },
    });
    assert.deepEqual(readDescriptor(c).checkpoints, [result.output.checkpoint]);
    assert.deepEqual(verifyCheckpoint(c).output, { ok: true, command: 'checkpoint verify', checkpoint: result.output.checkpoint });

    const firstBytes = readFileSync(join(c.repo, result.output.checkpoint));
    const second = checkpoint(c, 'second', ['package.json']);
    assert.equal(second.output.checkpoint, '.apex/inception/checkpoints/0003.json');
    assert.deepEqual(readFileSync(join(c.repo, result.output.checkpoint)), firstBytes, 'the first checkpoint stays byte-identical');
    assert.deepEqual(readDescriptor(c).checkpoints, [result.output.checkpoint, second.output.checkpoint]);
    assert.equal(verifyCheckpoint(c, '--checkpoint', result.output.checkpoint).status, 0, 'an earlier checkpoint verifies by path');
  });
});

test('checkpoint create without Git records only absence, and in an unborn repository HEAD is null', () => {
  withCase('checkpoint-no-git', (c) => {
    writeApp(c);
    startAt(c, 'bootstrap');
    const result = checkpoint(c, 'plain directory', ['package.json']);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(c.repo, result.output.checkpoint), 'utf8')).git, { present: false });
    assert.equal(verifyCheckpoint(c).status, 0);
    git(c, 'init', '--quiet', '-b', 'main');
    assert.deepEqual(verifyCheckpoint(c).output.divergences, [{ kind: 'git-presence', expected: false, observed: true }]);
  });
  withCase('checkpoint-unborn', (c) => {
    git(c, 'init', '--quiet', '-b', 'main');
    writeApp(c);
    startAt(c, 'bootstrap');
    const result = checkpoint(c, 'unborn', APP_PATHS);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(c.repo, result.output.checkpoint), 'utf8')).git, {
      present: true, branch: 'main', head: null, status: APP_PATHS.map((path) => `?? ${path}`),
    });
    assert.equal(verifyCheckpoint(c).status, 0);
  });
});

test('checkpoint verify reports a changed, deleted, or unsafe file, a new untracked file, a new commit, a switched branch, and lost Git', () => {
  withCase('checkpoint-verify', (c) => {
    const head = initRepo(c);
    startAt(c, 'bootstrap');
    const created = checkpoint(c, 'baseline', APP_PATHS).output.checkpoint;
    assert.equal(verifyCheckpoint(c).status, 0);
    const diverges = (expected, label) => {
      const { status, output } = verifyCheckpoint(c);
      assert.equal(status, 1, label);
      assert.equal(output.ok, false, label);
      assert.equal(output.checkpoint, created, label);
      assert.deepEqual(output.divergences, expected, label);
    };

    const original = digestOf(c, 'src/index.js');
    writeFileSync(join(c.repo, 'src/index.js'), 'console.log(2);\n');
    diverges([
      { kind: 'file-changed', path: 'src/index.js', expected: { bytes: original.bytes, sha256: original.sha256 }, observed: { bytes: 16, sha256: sha256('console.log(2);\n') } },
      { kind: 'status', expected: [], observed: [' M src/index.js'] },
    ], 'changed file');
    writeFileSync(join(c.repo, 'src/index.js'), APP_FILES['src/index.js']);
    assert.equal(verifyCheckpoint(c).status, 0, 'restored bytes verify again');

    rmSync(join(c.repo, 'package.json'));
    diverges([{ kind: 'file-missing', path: 'package.json' }, { kind: 'status', expected: [], observed: [' D package.json'] }], 'deleted file');
    writeApp(c, { 'package.json': APP_FILES['package.json'] });

    writeFile(c, 'notes.txt', 'new\n');
    diverges([{ kind: 'status', expected: [], observed: ['?? notes.txt'] }], 'new untracked file');
    rmSync(join(c.repo, 'notes.txt'));

    rmSync(join(c.repo, 'src/index.js'));
    writeFile(c, 'elsewhere/index.js', APP_FILES['src/index.js']);
    symlinkSync(join(c.repo, 'elsewhere/index.js'), join(c.repo, 'src/index.js'));
    diverges([
      { kind: 'file-unsafe', path: 'src/index.js' },
      { kind: 'status', expected: [], observed: [' T src/index.js', '?? elsewhere/index.js'] },
    ], 'symlinked file');
    rmSync(join(c.repo, 'src/index.js'));
    rmSync(join(c.repo, 'elsewhere'), { recursive: true });
    writeApp(c, { 'src/index.js': APP_FILES['src/index.js'] });
    assert.equal(verifyCheckpoint(c).status, 0);

    git(c, 'checkout', '--quiet', '-b', 'feature');
    diverges([{ kind: 'branch', expected: 'main', observed: 'feature' }], 'switched branch');
    git(c, 'checkout', '--quiet', 'main');

    git(c, 'commit', '--quiet', '--allow-empty', '-m', 'second');
    const next = git(c, 'rev-parse', 'HEAD').trim();
    diverges([{ kind: 'head', expected: head, observed: next }], 'new commit');
    git(c, 'reset', '--quiet', '--soft', head);
    assert.equal(verifyCheckpoint(c).status, 0);

    renameSync(join(c.repo, '.git'), join(c.repo, '.git-away'));
    diverges([{ kind: 'git-presence', expected: true, observed: false }], 'lost Git');
    renameSync(join(c.repo, '.git-away'), join(c.repo, '.git'));
    assert.equal(verifyCheckpoint(c).status, 0);
  });
});

test('checkpoint create reads --files-from inside the area and accepts hard-linked application files', () => {
  withCase('checkpoint-files-from', (c) => {
    initRepo(c);
    startAt(c, 'bootstrap');
    writeFile(c, '.apex/inception/bootstrap/files.txt', `src/index.js\n\n${PAGE}\n   \n`);
    linkSync(join(c.repo, 'package.json'), join(c.repo, 'package-link.json'));
    const result = checkpoint(c, 'from a list', ['package.json'], '--files-from', '.apex/inception/bootstrap/files.txt');
    assert.equal(result.status, 0, JSON.stringify(result.output));
    assert.deepEqual(result.output.files.map((entry) => entry.path), APP_PATHS);
    const onlyList = cli(c, 'checkpoint', 'create', '--label', 'list only', '--files-from', '.apex/inception/bootstrap/files.txt');
    assert.deepEqual(onlyList.output.files.map((entry) => entry.path), [PAGE, 'src/index.js']);
  });
});

test('checkpoint create refuses area paths, unsafe application paths, unsafe lists, and a non-active run without writing', () => {
  const LIST = '.apex/inception/bootstrap/files.txt';
  const cases = [
    { label: 'no file', files: [], error: /at least one/u },
    { label: 'the descriptor', files: [RUN_DESCRIPTOR_PATH], error: /\.apex\/inception/u },
    { label: 'the area itself', files: ['.apex/inception'], error: /\.apex\/inception/u },
    { label: 'an area path with other case', files: ['.APEX/Inception/run.json'], error: /\.apex\/inception/u },
    { label: 'absolute path', files: ['/etc/hosts'], error: /--file/u },
    { label: 'parent segment', files: ['../outside.txt'], error: /--file/u },
    { label: 'dot segment', files: ['src/./index.js'], error: /--file/u },
    { label: 'empty segment', files: ['src//index.js'], error: /--file/u },
    { label: 'trailing slash', files: ['src/'], error: /--file/u },
    { label: 'backslash', files: ['src\\index.js'], error: /--file/u },
    { label: 'control character', files: ['src/index\t.js'], error: /--file/u },
    { label: 'over 4096 bytes', files: [`${'é'.repeat(2048)}x`], error: /--file/u },
    { label: 'empty path', files: [''], error: /--file/u },
    { label: 'duplicate file', files: ['package.json', 'src/index.js', 'package.json'], error: /package\.json/u },
    { label: 'missing file', files: ['missing.js'], error: /missing\.js/u },
    { label: 'directory', files: ['src'], error: /src/u },
    { label: 'symlinked file', setup(c) { symlinkSync(join(c.repo, 'package.json'), join(c.repo, 'link.json')); }, files: ['link.json'], error: /link\.json/u },
    { label: 'symlinked parent', setup(c) { symlinkSync(join(c.repo, 'src'), join(c.repo, 'linked-src')); }, files: ['linked-src/index.js'], error: /linked-src/u },
    { label: 'unsafe label', label_: 'two\nlines', files: ['package.json'], error: /--label/u },
    { label: 'list outside the area', setup(c) { writeFile(c, 'files.txt', 'package.json\n'); }, files: [], extra: ['--files-from', 'files.txt'], error: /--files-from/u },
    { label: 'list escaping the area', setup(c) { writeFile(c, 'files.txt', 'package.json\n'); }, files: [], extra: ['--files-from', '.apex/inception/../../files.txt'], error: /--files-from/u },
    { label: 'missing list', files: [], extra: ['--files-from', LIST], error: /files\.txt/u },
    {
      label: 'symlinked list',
      setup(c) { writeFile(c, 'files.txt', 'package.json\n'); mkdirSync(join(c.repo, '.apex/inception/bootstrap')); symlinkSync(join(c.repo, 'files.txt'), join(c.repo, LIST)); },
      files: [], extra: ['--files-from', LIST], error: /files\.txt/u,
    },
    {
      label: 'hard-linked list',
      setup(c) { writeFile(c, LIST, 'package.json\n'); linkSync(join(c.repo, LIST), join(c.repo, 'files-copy.txt')); },
      files: [], extra: ['--files-from', LIST], error: /files\.txt/u,
    },
    { label: 'list naming an area path', setup(c) { writeFile(c, LIST, `package.json\n${RUN_DESCRIPTOR_PATH}\n`); }, files: [], extra: ['--files-from', LIST], error: /\.apex\/inception/u },
    { label: 'list with CRLF lines', setup(c) { writeFile(c, LIST, 'package.json\r\n'); }, files: [], extra: ['--files-from', LIST], error: /--files-from/u },
    { label: 'blank list', setup(c) { writeFile(c, LIST, '\n  \n'); }, files: [], extra: ['--files-from', LIST], error: /at least one/u },
    {
      label: 'list with an invalid UTF-8 byte',
      setup(c) { writeFile(c, LIST, Buffer.concat([Buffer.from('package'), Buffer.from([0xff]), Buffer.from('.json\n')])); },
      files: [], extra: ['--files-from', LIST], error: /UTF-8/u,
    },
    { label: 'blocked run', blocked: true, files: ['package.json'], error: /status active/u },
  ];
  eachCopy('checkpoint-refused', (c) => { initRepo(c); startAt(c, 'bootstrap'); }, cases, (c, fixture) => {
    if (fixture.blocked) assert.equal(transition(c, 'blocked').status, 0);
    fixture.setup?.(c);
    const before = snapshot(c.repo, { exclude: ['.git'] });
    const { status, output } = checkpoint(c, fixture.label_ ?? 'refused', fixture.files, ...(fixture.extra ?? []));
    assert.equal(status, 1, fixture.label);
    assert.equal(output.command, 'checkpoint create', fixture.label);
    assert.match(output.error, fixture.error, fixture.label);
    assert.deepEqual(snapshot(c.repo, { exclude: ['.git'] }), before, `${fixture.label}: refusal must not write`);
  });
  withCase('checkpoint-no-run', (c) => {
    writeApp(c);
    const before = snapshot(c.repo);
    assert.match(checkpoint(c, 'x', ['package.json']).output.error, /no inception run/u);
    assert.deepEqual(snapshot(c.repo), before);
  });
});

test('checkpoint verify refuses without a checkpoint, for an unbound --checkpoint, and for a missing or tampered record', () => {
  withCase('checkpoint-verify-none', (c) => {
    initRepo(c);
    startAt(c, 'bootstrap');
    const { status, output } = verifyCheckpoint(c);
    assert.equal(status, 1);
    assert.match(output.error, /no checkpoint/u);
  });
  const PATH = '.apex/inception/checkpoints/0002.json';
  const record = (c) => JSON.parse(readFileSync(join(c.repo, PATH), 'utf8'));
  const rewrite = (c, value) => writeFile(c, PATH, text(value));
  const tamper = {
    'unbound --checkpoint': { args: ['--checkpoint', '.apex/inception/checkpoints/0003.json'], error: /0003\.json/u },
    'unsafe --checkpoint': { args: ['--checkpoint', '.apex/inception/checkpoints/../run.json'], error: /--checkpoint/u },
    'record deleted': { setup(c) { rmSync(join(c.repo, PATH)); }, error: /0002\.json/u },
    'record hard-linked': { setup(c) { linkSync(join(c.repo, PATH), join(c.repo, 'copy.json')); }, error: /hard link/u },
    'foreign runId': { setup(c) { rewrite(c, { ...record(c), runId: 'inc-20261007T120000Z-ffffffff' }); }, error: /runId/u },
    'other record number': { setup(c) { rewrite(c, { ...record(c), record: 3 }); }, error: /record/u },
    'unsorted files': { setup(c) { rewrite(c, { ...record(c), files: [...record(c).files].reverse() }); }, error: /sorted/u },
    'area path in files': { setup(c) { const value = record(c); rewrite(c, { ...value, files: [{ ...value.files[0], path: RUN_DESCRIPTOR_PATH }] }); }, error: /path/u },
    'git without status': { setup(c) { const value = record(c); rewrite(c, { ...value, git: { present: true, branch: 'main', head: null } }); }, error: /git/u },
    'absent git with a branch': { setup(c) { rewrite(c, { ...record(c), git: { present: false, branch: 'main' } }); }, error: /git/u },
    'malformed head': { setup(c) { const value = record(c); rewrite(c, { ...value, git: { ...value.git, head: 'HEAD' } }); }, error: /head/u },
    'duplicate key': { setup(c) { writeFile(c, PATH, insertAfter(text(record(c)), '{\n', '  "label": "forged",\n')); }, error: /duplicate key/u },
  };
  const build = (c) => {
    initRepo(c);
    startAt(c, 'bootstrap');
    assert.equal(checkpoint(c, 'baseline', APP_PATHS).output.checkpoint, PATH);
  };
  eachCopy('checkpoint-verify-refused', build, Object.entries(tamper), (c, [label, { setup, args = [], error }]) => {
    setup?.(c);
    const { status, output } = verifyCheckpoint(c, ...args);
    assert.equal(status, 1, label);
    assert.match(output.error, error, label);
    assert.equal('divergences' in output, false, `${label}: a refusal is not a divergence report`);
  });
});

// ---------------------------------------------------------------------------
// verification -> complete (HC9, SC3)
// ---------------------------------------------------------------------------

const RESULTS = '.apex/inception/verification/results.md';

// A run in phase verification inside a one-commit repository, with verification results, one
// concluded effect, and one checkpoint of the application files.
function readyToComplete(c) {
  initRepo(c);
  startAt(c, 'verification');
  writeFile(c, RESULTS, '# Verification\n\nnpm test: 12 passing\n');
  assert.equal(intent(c, 'install-deps', 'install', 'npm install').status, 0);
  assert.equal(outcome(c, 'install-deps').status, 0);
  return checkpoint(c, 'final', APP_PATHS).output.checkpoint;
}

function complete(c, ...extra) {
  return transition(c, 'complete', ...extra);
}

test('verification -> complete binds the last clean checkpoint and the verification results, then refuses every transition', () => {
  withCase('gate-complete', (c) => {
    const final = readyToComplete(c);
    const before = readDescriptor(c);
    const { status, output } = complete(c, '--checkpoint', final, '--verification', RESULTS);
    assert.equal(status, 0, JSON.stringify(output));
    assert.deepEqual(output, { ok: true, command: 'transition', phase: 'complete', status: 'complete' });

    const descriptor = readDescriptor(c);
    assert.equal(descriptor.phase, 'complete');
    assert.equal(descriptor.status, 'complete');
    assert.equal(descriptor.finalCheckpoint, final);
    assert.deepEqual(descriptor.verification, digestOf(c, RESULTS));
    assert.deepEqual(Object.keys(descriptor.verification), ['path', 'bytes', 'sha256']);
    assert.deepEqual(descriptor.history.at(-1).from, { phase: 'verification', status: 'active' });
    assert.deepEqual(descriptor.history.at(-1).to, { phase: 'complete', status: 'complete' });
    assert.deepEqual(
      { ...descriptor, phase: before.phase, status: before.status, finalCheckpoint: null, verification: null, history: before.history },
      before,
      'completion changes only phase, status, the two bindings, and history',
    );
    assert.equal(serializeRunDescriptor(parseRunDescriptor(readFileSync(join(c.repo, RUN_DESCRIPTOR_PATH), 'utf8'))), readFileSync(join(c.repo, RUN_DESCRIPTOR_PATH), 'utf8'));

    const after = snapshot(c.repo, { exclude: ['.git'] });
    for (const to of ['reconnaissance', 'architecture', 'research', 'approval', 'bootstrap', 'verification', 'complete', 'blocked', 'active']) {
      const extra = to === 'complete' ? ['--checkpoint', final, '--verification', RESULTS] : [];
      const refused = transition(c, to, ...extra);
      assert.equal(refused.status, 1, `complete -> ${to}`);
      assert.match(refused.output.error, /complete/u, `complete -> ${to}`);
    }
    for (const result of [intent(c, 'late', 'install'), checkpoint(c, 'late', ['package.json'])]) {
      assert.equal(result.status, 1);
      assert.match(result.output.error, /status active/u);
    }
    assert.deepEqual(snapshot(c.repo, { exclude: ['.git'] }), after, 'nothing changes after completion');
    assert.deepEqual(cli(c, 'classify').output, {
      ok: true, command: 'classify', row: 'report-next-steps', hub: 'absent', run: 'complete',
      nextStep: 'run the init skill, then the discovery skill with the inception source',
    });
  });
});

test('verification -> complete refuses missing bindings, a stale or diverging checkpoint, unsafe results, and uncertain effects without writing', () => {
  const cases = [
    { label: 'no bindings', args: () => [], error: /--checkpoint and --verification/u },
    { label: 'no --verification', args: (final) => ['--checkpoint', final], error: /--verification/u },
    { label: 'no --checkpoint', args: () => ['--verification', RESULTS], error: /--checkpoint/u },
    {
      label: 'not the last checkpoint',
      setup(c) { assert.equal(checkpoint(c, 'later', ['package.json']).status, 0); },
      args: (final) => ['--checkpoint', final, '--verification', RESULTS], error: /last/u,
    },
    { label: 'unbound checkpoint', args: () => ['--checkpoint', '.apex/inception/checkpoints/0009.json', '--verification', RESULTS], error: /last/u },
    { label: 'unsafe checkpoint path', args: () => ['--checkpoint', '.apex/inception/checkpoints/../run.json', '--verification', RESULTS], error: /--checkpoint/u },
    {
      label: 'diverging checkpoint',
      setup(c) { writeFileSync(join(c.repo, 'src/index.js'), 'console.log(3);\n'); },
      args: (final) => ['--checkpoint', final, '--verification', RESULTS], error: /src\/index\.js file-changed/u,
    },
    {
      label: 'new commit since the checkpoint',
      setup(c) { git(c, 'commit', '--quiet', '--allow-empty', '-m', 'later'); },
      args: (final) => ['--checkpoint', final, '--verification', RESULTS], error: /head/u,
    },
    { label: 'results outside verification/', args: (final) => ['--checkpoint', final, '--verification', REGISTER], error: /--verification/u },
    { label: 'results escaping verification/', args: (final) => ['--checkpoint', final, '--verification', '.apex/inception/verification/../run.json'], error: /--verification/u },
    { label: 'the verification directory itself', args: (final) => ['--checkpoint', final, '--verification', '.apex/inception/verification/'], error: /--verification/u },
    { label: 'missing results', setup(c) { rmSync(join(c.repo, RESULTS)); }, args: (final) => ['--checkpoint', final, '--verification', RESULTS], error: /results\.md/u },
    {
      label: 'hard-linked results',
      // Links live outside the repository so the checkpoint's Git status stays clean.
      setup(c) { linkSync(join(c.repo, RESULTS), join(c.base, 'results-copy.md')); },
      args: (final) => ['--checkpoint', final, '--verification', RESULTS], error: /hard link/u,
    },
    {
      label: 'symlinked results',
      setup(c) { writeFileSync(join(c.base, 'elsewhere.md'), 'x\n'); rmSync(join(c.repo, RESULTS)); symlinkSync(join(c.base, 'elsewhere.md'), join(c.repo, RESULTS)); },
      args: (final) => ['--checkpoint', final, '--verification', RESULTS], error: /results\.md/u,
    },
    {
      label: 'uncertain effect',
      setup(c) { assert.equal(intent(c, 'deploy-preview', 'deploy', 'deploy', '--authorization', 'the owner said yes').status, 0); },
      args: (final) => ['--checkpoint', final, '--verification', RESULTS], error: /uncertain/u,
    },
    {
      label: 'malformed effect log',
      setup(c) { writeFileSync(join(c.repo, EFFECT_LOG), `${effectLog(c)}{"truncated"`); },
      args: (final) => ['--checkpoint', final, '--verification', RESULTS], error: /effect log is malformed at line 3/u,
    },
    {
      label: 'blocked run',
      setup(c) { assert.equal(transition(c, 'blocked').status, 0); },
      args: (final) => ['--checkpoint', final, '--verification', RESULTS], error: /blocked/u,
    },
    { label: '--git-commits on completion', args: (final) => ['--checkpoint', final, '--verification', RESULTS, '--git-commits', 'forbidden'], error: /--git-commits/u },
  ];
  eachCopy('gate-complete-refused', readyToComplete, cases, (c, fixture, final) => {
    fixture.setup?.(c);
    const before = snapshot(c.repo, { exclude: ['.git'] });
    const { status, output } = complete(c, ...fixture.args(final));
    assert.equal(status, 1, fixture.label);
    assert.match(output.error, fixture.error, fixture.label);
    assert.deepEqual(snapshot(c.repo, { exclude: ['.git'] }), before, `${fixture.label}: refusal must not write`);
    assert.notEqual(readDescriptor(c).status, 'complete', fixture.label);
  });
});

// ---------------------------------------------------------------------------
// abandon (HC15, SC8)
// ---------------------------------------------------------------------------

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
    assert.deepEqual(after, { ...expectedAfterAbandon(before, archive), [`${archive}/abandon.json`]: record });
    assert.equal(after[`${archive}/run.json`], before[RUN_DESCRIPTOR_PATH], 'the descriptor moves byte-identical');
    assert.equal(after[INCEPTION_GITIGNORE], '*\n');
    const parsed = JSON.parse(record);
    assert.deepEqual(Object.keys(parsed), ['schema', 'runId', 'at', 'reason', 'phase', 'status']);
    assert.equal(record, text(parsed));
    assert.deepEqual(
      { ...parsed, at: undefined },
      { schema: 'steepy-inception-abandon/v1', runId: first, at: undefined, reason: 'restart with a smaller scope', phase: 'architecture', status: 'active' },
    );
    assert.match(parsed.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);

    assert.deepEqual(cli(c, 'classify', '--maturity', 'suitable').output, {
      ok: true, command: 'classify', row: 'start-new-run', hub: 'absent', run: 'none',
    });

    const firstArchive = snapshot(join(c.repo, archive));
    const second = cli(c, ...startArgs()).output.runId;
    assert.notEqual(second, first);
    assert.equal(cli(c, 'abandon', '--reason', 'second thoughts').output.archive, `.apex/inception/abandoned/${second}`);
    assert.deepEqual(readdirSync(join(c.repo, `.apex/inception/abandoned/${second}`)).sort(), ['abandon.json', 'run.json']);
    assert.deepEqual(snapshot(join(c.repo, archive)), firstArchive, 'an earlier archive is never touched');
    assert.equal(cli(c, 'classify').output.row, 'maturity-decision-required');
  });
});

test('an interrupted abandon completes on re-run and keeps its original record', () => {
  withCase('abandon-resume', (c) => {
    const runId = cli(c, ...startArgs()).output.runId;
    assert.equal(cli(c, 'resume-note', '--next', 'continue').status, 0);
    writeFile(c, '.apex/inception/project/decision-register.md', '# Decisions\n');
    writeFile(c, '.apex/inception/effects.jsonl', '{"type":"intent"}\n');
    const before = files(c.repo);
    const archive = `.apex/inception/abandoned/${runId}`;
    const original = text({
      schema: 'steepy-inception-abandon/v1', runId, at: '2026-10-07T12:00:00.000Z', reason: 'original reason',
      phase: 'reconnaissance', status: 'active',
    });
    writeFile(c, `${archive}/abandon.json`, original);
    renameSync(join(c.repo, '.apex/inception/resume-notes'), join(c.repo, archive, 'resume-notes'));

    const { status, output } = cli(c, 'abandon', '--reason', 'retry');
    assert.equal(status, 0);
    assert.equal(output.archive, archive);
    assert.deepEqual(files(c.repo), { ...expectedAfterAbandon(before, archive), [`${archive}/abandon.json`]: original });
  });
});

test('abandon refuses a foreign or ambiguous archive and unsafe input without writing', () => {
  const fixtures = [
    { label: 'archive without a record', setup(c, archive) { mkdirSync(join(c.repo, archive), { recursive: true }); }, error: /abandon\.json/u },
    {
      label: 'archive of another run',
      setup(c, archive) { writeFile(c, `${archive}/abandon.json`, text({ schema: 'steepy-inception-abandon/v1', runId: 'inc-20261007T120000Z-ffffffff', at: '2026-10-07T12:00:00.000Z', reason: 'r', phase: 'reconnaissance', status: 'active' })); },
      error: /runId/u,
    },
    { label: 'malformed archive record', setup(c, archive) { writeFile(c, `${archive}/abandon.json`, '{}\n'); }, error: /abandon\.json/u },
    {
      label: 'archive record with a duplicate runId',
      setup(c, archive, runId) {
        const record = text({ schema: 'steepy-inception-abandon/v1', runId, at: '2026-10-07T12:00:00.000Z', reason: 'r', phase: 'reconnaissance', status: 'active' });
        writeFile(c, `${archive}/abandon.json`, insertAfter(record, '{\n', '  "runId": "inc-20261007T120000Z-ffffffff",\n'));
      },
      error: /duplicate key/u,
    },
    {
      label: 'archive record with an invalid UTF-8 byte',
      setup(c, archive, runId) {
        const [head, tail] = text({ schema: 'steepy-inception-abandon/v1', runId, at: '2026-10-07T12:00:00.000Z', reason: 'r', phase: 'reconnaissance', status: 'active' }).split('"reason": "r"');
        writeFile(c, `${archive}/abandon.json`, Buffer.concat([Buffer.from(`${head}"reason": "r`), Buffer.from([0xff]), Buffer.from(`"${tail}`)]));
      },
      error: /UTF-8/u,
    },
    {
      label: 'child at both source and archive',
      setup(c, archive, runId) {
        writeFile(c, `${archive}/abandon.json`, text({ schema: 'steepy-inception-abandon/v1', runId, at: '2026-10-07T12:00:00.000Z', reason: 'r', phase: 'reconnaissance', status: 'active' }));
        writeFile(c, `${archive}/project/old.md`, 'old\n');
        writeFile(c, '.apex/inception/project/new.md', 'new\n');
      },
      error: /ambiguous/u,
    },
    {
      label: 'symlinked archive',
      setup(c, archive) { mkdirSync(join(c.repo, 'elsewhere')); mkdirSync(join(c.repo, ABANDONED)); symlinkSync(join(c.repo, 'elsewhere'), join(c.repo, archive)); },
      error: /real directory/u,
    },
    { label: 'abandoned is a file', setup(c) { writeFile(c, ABANDONED, 'x'); }, error: /real directory/u },
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
    ['effect', 'intent', '--id', 'install-deps', '--kind', 'install', '--summary', 'npm install'],
    ['effect', 'outcome', '--id', 'install-deps', '--result', 'failed', '--observed', 'offline'],
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

test('a whole run lifecycle writes only under the area and never creates hub or provider artifacts', () => {
  for (const withGit of [false, true]) {
    withCase(withGit ? 'lifecycle-git' : 'lifecycle', (c) => {
      if (withGit) git(c, 'init', '--quiet', '-b', 'main');
      const exclude = withGit ? ['.git'] : [];
      const before = snapshot(c.repo, { exclude });
      const steps = [
        startArgs(),
        ['transition', '--to', 'architecture', '--reason', 'r'],
        ['transition', '--to', 'research', '--reason', 'r'],
        ['transition', '--to', 'approval', '--reason', 'r'],
        ['transition', '--to', 'blocked', '--reason', 'r'],
        ['resume-note', '--next', 'unblock'],
        ['transition', '--to', 'active', '--reason', 'r'],
        ['abandon', '--reason', 'r'],
      ];
      for (const args of steps) {
        assert.equal(cli(c, ...args).status, 0, args.join(' '));
        assertConfinedToArea(c, before, { exclude });
        assert.equal(lstatOrNull(join(c.repo, '.gitignore')), null, 'the root .gitignore is never created');
        if (withGit) assert.equal(git(c, 'status', '--porcelain=v1', '--untracked-files=all'), '', `${args[0]} leaves Git clean`);
      }
    });
  }
});

// Paths outside the area (and `.apex/` itself, which `start` creates) keep their exact bytes,
// link counts, and mtimes.
function outsideArea(entries) {
  return Object.fromEntries(Object.entries(entries).filter(([path]) => (
    path !== '.apex' && path !== INCEPTION_AREA && !path.startsWith(`${INCEPTION_AREA}/`)
  )));
}

test('a full run from start to complete writes only under the area and leaves every application file untouched', () => {
  for (const withGit of [false, true]) {
    withCase(withGit ? 'happy-path-git' : 'happy-path', (c) => {
      if (withGit) initRepo(c);
      else writeApp(c);
      const exclude = withGit ? ['.git'] : [];
      const before = snapshot(c.repo, { exclude });
      const LIST = '.apex/inception/bootstrap/checkpoint-files.txt';
      // `model` steps stand in for files the inception skill writes inside the area.
      const steps = [
        { args: startArgs() },
        { args: ['transition', '--to', 'architecture', '--reason', 'reconnaissance recorded'] },
        { args: ['transition', '--to', 'research', '--reason', 'architecture interview done'] },
        { model: () => writeProject(c) },
        { args: ['transition', '--to', 'approval', '--reason', 'research done'] },
        { args: ['approve', '--statement', STATEMENT, ...Object.keys(PROJECT_DOCS).flatMap((path) => ['--document', path])] },
        { args: ['verify-approval'] },
        { args: ['transition', '--to', 'bootstrap', '--reason', 'approved'] },
        { args: ['effect', 'intent', '--id', 'install-deps', '--kind', 'install', '--summary', 'npm install'] },
        { args: ['effect', 'outcome', '--id', 'install-deps', '--result', 'succeeded', '--observed', 'installed'] },
        { args: ['effect', 'status'] },
        { model: () => writeFile(c, LIST, `${PAGE}\nsrc/index.js\n`) },
        { args: ['checkpoint', 'create', '--label', 'bootstrap done', '--files-from', LIST, '--file', 'package.json'] },
        { args: ['checkpoint', 'verify'] },
        { args: ['transition', '--to', 'verification', '--reason', 'bootstrap done'] },
        { model: () => writeFile(c, RESULTS, '# Verification\n\nall checks pass\n') },
        { args: ['checkpoint', 'create', '--label', 'final', '--files-from', LIST, '--file', 'package.json'] },
        { args: ['resume-note', '--next', 'complete the run', '--need', RESULTS] },
        { args: ['transition', '--to', 'complete', '--reason', 'verified', '--checkpoint', '.apex/inception/checkpoints/0003.json', '--verification', RESULTS] },
        { args: ['classify'] },
        { args: ['verify-approval'] },
        { args: ['checkpoint', 'verify'] },
      ];
      for (const step of steps) {
        if (step.model) {
          step.model();
          continue;
        }
        const { status, output } = cli(c, ...step.args);
        assert.equal(status, 0, `${step.args.join(' ')}: ${JSON.stringify(output)}`);
        assertConfinedToArea(c, before, { exclude });
        assert.deepEqual(outsideArea(snapshot(c.repo, { exclude })), outsideArea(before), `${step.args[0]} changes nothing outside the area`);
        assert.equal(lstatOrNull(join(c.repo, '.gitignore')), null, 'the root .gitignore is never created');
        if (withGit) assert.equal(git(c, 'status', '--porcelain=v1', '--untracked-files=all'), '', `${step.args[0]} leaves Git clean`);
      }
      const descriptor = readDescriptor(c);
      assert.equal(descriptor.status, 'complete');
      assert.deepEqual(descriptor.approvals, ['.apex/inception/approvals/0001.json']);
      assert.deepEqual(descriptor.checkpoints, ['.apex/inception/checkpoints/0002.json', '.apex/inception/checkpoints/0003.json']);
      assert.deepEqual(descriptor.resumeNotes, ['.apex/inception/resume-notes/0004.md']);
      assert.equal(descriptor.finalCheckpoint, '.apex/inception/checkpoints/0003.json');
      assert.equal(descriptor.nextRecord, 5);
    });
  }
});

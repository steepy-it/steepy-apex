import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
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

const INVALID_CLASSIFICATIONS = [
  { label: 'invalid JSON', setup(c) { writeArea(c, '{"schema": '); } },
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
    { args: ['approve', '--statement', 'yes', '--document', '.apex/inception/project/decision-register.md'], command: 'approve', error: /unknown command/u },
    { args: ['verify-approval'], command: 'verify-approval', error: /unknown command/u },
    { args: ['effect', 'intent', '--id', 'x', '--kind', 'install', '--summary', 's'], command: 'effect', error: /unknown command/u },
    { args: ['checkpoint', 'create', '--label', 'x', '--file', 'a.txt'], command: 'checkpoint', error: /unknown command/u },
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

test('startRun writes the area .gitignore before the descriptor', () => {
  withCase('start-seam', (c) => {
    const options = {
      harnessName: 'codex',
      capabilities: ['shell'],
      gitCommits: 'allowed',
      now: new Date('2026-10-07T12:00:00.000Z'),
      randomHex: '0badcafe',
    };
    assert.throws(
      () => startRun(c.repo, { ...options, replaceFile() { throw new Error('descriptor write failed'); } }),
      /descriptor write failed/u,
    );
    assert.equal(readFileSync(join(c.repo, INCEPTION_GITIGNORE), 'utf8'), '*\n');
    assert.equal(lstatOrNull(join(c.repo, RUN_DESCRIPTOR_PATH)), null);

    const result = startRun(c.repo, options);
    assert.deepEqual(result, { runId: 'inc-20261007T120000Z-0badcafe', descriptor: RUN_DESCRIPTOR_PATH });
    assert.equal(readDescriptor(c).harness.name, 'codex');
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

test('the two gated edges refuse with a fixed diagnostic and leave the descriptor untouched', () => {
  const cases = [
    {
      descriptor: baseDescriptor({ phase: 'approval', nextRecord: 3, approvals: APPROVALS, approvalEntry: 0 }),
      args: ['bootstrap'],
      error: 'gated transition not available: approval -> bootstrap',
    },
    { descriptor: baseDescriptor({ phase: 'verification' }), args: ['complete'], error: 'gated transition not available: verification -> complete' },
    {
      descriptor: baseDescriptor({ phase: 'verification', nextRecord: 2, checkpoints: ['.apex/inception/checkpoints/0001.json'] }),
      args: ['complete', '--checkpoint', '.apex/inception/checkpoints/0001.json', '--verification', '.apex/inception/verification/results.md'],
      error: 'gated transition not available: verification -> complete',
    },
  ];
  for (const { descriptor, args, error } of cases) {
    withCase('transition-gated', (c) => {
      writeDescriptor(c, descriptor);
      const before = snapshot(c.repo);
      const { status, output } = transition(c, ...args);
      assert.equal(status, 1);
      assert.equal(output.error, error);
      assert.deepEqual(snapshot(c.repo), before);
    });
  }
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
    ['resume-note', '--next', 'continue'],
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
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
  INCEPTION_INIT_STATUSES,
  INCEPTION_PHASES,
  INCEPTION_STATUSES,
  assertInceptionTransition,
  createInitialInceptionState,
  inspectInceptionState,
  observeInceptionGit,
  parseInceptionState,
  serializeInceptionState,
  startInceptionRun,
  updateInceptionState,
  validateInceptionState,
} from '../scripts/inception-state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'scripts', 'inception-state.mjs');
const RUN = '0b6f1b8e-3c1a-4e2b-9f3d-5a7c9e1b2d4f';
const OTHER = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const STATE = '.apex/inception/state.json';
const PROPOSAL = `.apex/inception/${RUN}/proposal.md`;
const HANDOFF = `.apex/inception/${RUN}/handoff.md`;
const RECEIPT = `.apex/inception/${RUN}/init-receipt.json`;

const sha = (value) => createHash('sha256').update(value).digest('hex');

function withTemp(suffix, fn) {
  const root = mkdtempSync(join(tmpdir(), `steepy-inception-state-${suffix}-`));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

function gitInit(root) {
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.test');
  writeFileSync(join(root, 'README.md'), 'app\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'baseline');
}

function stateBytes(root) {
  return readFileSync(join(root, STATE));
}

function stateDigest(root) {
  return sha(stateBytes(root));
}

function put(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function assertCode(fn, code, pattern) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

function runCli(args, { env } = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: env ?? process.env });
}

function descriptor(overrides = {}) {
  return {
    ...createInitialInceptionState(RUN),
    ...overrides,
  };
}

const ref = (path, text) => ({ path, sha256: sha(text) });

test('the v1 descriptor has closed fields, closed vocabularies, and canonical bytes', () => {
  assert.deepEqual([...INCEPTION_PHASES], [
    'reconnaissance', 'architecture', 'research', 'approval', 'bootstrap', 'verification', 'init', 'complete',
  ]);
  assert.deepEqual([...INCEPTION_STATUSES], ['active', 'blocked', 'complete']);
  assert.deepEqual([...INCEPTION_INIT_STATUSES], ['not-started', 'in-progress', 'complete']);
  const initial = createInitialInceptionState(RUN);
  assert.deepEqual(initial, {
    schemaVersion: 1,
    runId: RUN,
    phase: 'reconnaissance',
    status: 'active',
    approval: null,
    checkpoint: null,
    init: { status: 'not-started', handoff: null, receipt: null },
  });
  const text = serializeInceptionState(initial);
  assert.equal(text, `${JSON.stringify(initial, null, 2)}\n`);
  assert.deepEqual(parseInceptionState(text), initial);
  assert.ok(Object.isFrozen(parseInceptionState(text).init));

  for (const [label, bytes] of [
    ['compact JSON', `${JSON.stringify(initial)}\n`],
    ['missing final newline', JSON.stringify(initial, null, 2)],
    ['reordered keys', `${JSON.stringify({ runId: RUN, ...initial }, null, 2)}\n`],
    ['duplicate key', text.replace('"phase": "reconnaissance",', '"phase": "architecture",\n  "phase": "reconnaissance",')],
    ['not JSON', '{'],
    ['byte order mark', `\uFEFF${text}`],
  ]) {
    assert.notEqual(bytes, text, label);
    assertCode(() => parseInceptionState(bytes), 'INCEPTION_STATE_INVALID');
  }
  assertCode(() => createInitialInceptionState('NOT-A-UUID'), 'INCEPTION_STATE_INVALID', /runId/);
});

test('schema validation rejects open, versioned, and malformed fields without echoing values', () => {
  const invalid = [
    ['extra field', { ...descriptor(), token: 'sk-live-secret' }, /unsupported field/],
    ['missing field', (() => { const { checkpoint, ...rest } = descriptor(); return rest; })(), /fields/],
    ['future version', descriptor({ schemaVersion: 2 }), /schemaVersion/],
    ['string version', descriptor({ schemaVersion: '1' }), /schemaVersion/],
    ['uppercase run id', descriptor({ runId: RUN.toUpperCase() }), /runId/],
    ['unknown phase', descriptor({ phase: 'deploy' }), /phase/],
    ['unknown status', descriptor({ status: 'done' }), /status/],
    ['init extra', descriptor({ init: { status: 'not-started', handoff: null, receipt: null, note: 'x' } }), /init/],
    ['init unknown status', descriptor({ init: { status: 'started', handoff: null, receipt: null } }), /init\.status/],
    ['ref extra key', descriptor({ checkpoint: { path: PROPOSAL, sha256: sha('x'), approvedBy: 'me' } }), /checkpoint/],
    ['ref uppercase digest', descriptor({ checkpoint: { path: PROPOSAL, sha256: sha('x').toUpperCase() } }), /checkpoint\.sha256/],
    ['ref outside run', descriptor({ checkpoint: { path: '.apex/work/specs/demo.md', sha256: sha('x') } }), /checkpoint\.path/],
    ['ref other run', descriptor({ checkpoint: { path: `.apex/inception/${OTHER}/p.md`, sha256: sha('x') } }), /checkpoint\.path/],
    ['ref descriptor', descriptor({ checkpoint: { path: STATE, sha256: sha('x') } }), /checkpoint\.path/],
    ['ref glob', descriptor({ checkpoint: { path: `.apex/inception/${RUN}/*.md`, sha256: sha('x') } }), /checkpoint\.path/],
    ['handoff not a ref', descriptor({ init: { status: 'not-started', handoff: PROPOSAL, receipt: null } }), /init\.handoff/],
    ['array', [], /object/],
    ['null', null, /object/],
  ];
  for (const [label, value, pattern] of invalid) {
    assert.throws(() => validateInceptionState(value), (error) => {
      assert.equal(error.code, 'INCEPTION_STATE_INVALID', label);
      assert.match(error.message, pattern, label);
      assert.doesNotMatch(error.message, /sk-live-secret|approvedBy|note/, `${label}: values and unknown names are not echoed`);
      return true;
    }, label);
  }
});

test('incompatible combinations are rejected and legal ones accepted', () => {
  const approval = ref(PROPOSAL, 'proposal');
  const handoff = ref(HANDOFF, 'handoff');
  const receipt = ref(RECEIPT, 'receipt');
  for (const phase of ['bootstrap', 'verification', 'init', 'complete']) {
    assertCode(() => validateInceptionState(descriptor({
      phase,
      status: phase === 'complete' ? 'complete' : 'active',
      init: { status: phase === 'complete' ? 'complete' : 'not-started', handoff: null, receipt: null },
    })), 'INCEPTION_STATE_INVALID', /approval/);
  }
  assertCode(() => validateInceptionState(descriptor({ phase: 'complete', status: 'complete', approval })),
    'INCEPTION_STATE_INVALID', /complete/);
  assertCode(() => validateInceptionState(descriptor({ phase: 'init', status: 'complete', approval })),
    'INCEPTION_STATE_INVALID', /complete/);
  for (const phase of ['reconnaissance', 'architecture', 'research', 'approval', 'bootstrap', 'verification']) {
    assertCode(() => validateInceptionState(descriptor({
      phase, approval, init: { status: 'in-progress', handoff, receipt: null },
    })), 'INCEPTION_STATE_INVALID', /init/);
  }

  for (const legal of [
    descriptor(),
    descriptor({ phase: 'approval', status: 'blocked' }),
    descriptor({ phase: 'bootstrap', approval, checkpoint: ref(`.apex/inception/${RUN}/verify/log.txt`, 'log') }),
    descriptor({ phase: 'init', approval }),
    descriptor({ phase: 'init', approval, init: { status: 'in-progress', handoff, receipt: null } }),
    descriptor({ phase: 'init', status: 'complete', approval, init: { status: 'complete', handoff, receipt } }),
    descriptor({ phase: 'complete', status: 'complete', approval, init: { status: 'complete', handoff, receipt } }),
  ]) {
    assert.deepEqual(validateInceptionState(legal), legal);
  }
});

test('transitions keep the run identity and init status monotone', () => {
  const approval = ref(PROPOSAL, 'proposal');
  const handoff = ref(HANDOFF, 'handoff');
  const inProgress = descriptor({ phase: 'init', approval, init: { status: 'in-progress', handoff, receipt: null } });
  const complete = descriptor({ phase: 'init', approval, init: { status: 'complete', handoff, receipt: null } });
  assertInceptionTransition(descriptor(), descriptor({ phase: 'architecture' }));
  assertInceptionTransition(descriptor({ phase: 'bootstrap', approval }), descriptor({ phase: 'architecture' }));
  assertInceptionTransition(descriptor({ phase: 'init', approval }), inProgress);
  assertInceptionTransition(inProgress, complete);
  assertCode(() => assertInceptionTransition(inProgress, descriptor({ phase: 'init', approval })),
    'INCEPTION_STATE_TRANSITION', /init/);
  assertCode(() => assertInceptionTransition(complete, inProgress), 'INCEPTION_STATE_TRANSITION', /init/);
  assertCode(() => assertInceptionTransition(descriptor(), { ...descriptor(), runId: OTHER }),
    'INCEPTION_STATE_TRANSITION', /runId/);
});

test('start writes the guard, verifies Git exclusion, then the descriptor; no Git mutation occurs', () => withTemp('start-git', (root) => {
  gitInit(root);
  const head = git(root, 'rev-parse', 'HEAD');
  const index = git(root, 'ls-files', '--stage');
  const seen = [];
  const result = startInceptionRun(root, {
    runId: RUN,
    env: gitEnv(root),
    onCheckpoint({ operation, phase }) {
      seen.push(`${operation}:${phase}`);
      if (phase === 'before-descriptor') {
        assert.equal(readFileSync(join(root, '.apex/inception/.gitignore'), 'utf8'), '*\n');
        assert.equal(existsSync(join(root, STATE)), false, 'guard precedes the descriptor');
      }
    },
  });
  assert.deepEqual(seen, ['start:before-descriptor', 'start:before-run-directory']);
  assert.equal(result.created, true);
  assert.equal(result.runId, RUN);
  assert.deepEqual(result.descriptor, createInitialInceptionState(RUN));
  assert.equal(result.sha256, stateDigest(root));
  assert.deepEqual(result.git, { state: 'ignored', tracked: [], trackedCount: 0 });
  assert.equal(lstatSync(join(root, `.apex/inception/${RUN}`)).isDirectory(), true);
  assert.deepEqual(readdirSync(join(root, '.apex/inception')).sort(), ['.gitignore', RUN, 'state.json']);

  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all'), '', 'area is invisible to Git');
  assert.equal(git(root, 'rev-parse', 'HEAD'), head, 'no commit');
  assert.equal(git(root, 'ls-files', '--stage'), index, 'no index mutation');
  const inspected = inspectInceptionState(root);
  assert.equal(inspected.state, 'pre-hub');
  assert.equal(inspected.sha256, result.sha256);
}));

test('Git that is not yet initialized honors the local guard at its next initialization', () => withTemp('start-nogit', (root) => {
  const run = runCli(['start', '--root', root, '--state', STATE, '--run-id', RUN], { env: gitEnv(root) });
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.equal(output.created, true);
  assert.deepEqual(output.git, { state: 'not-repository' });
  put(root, PROPOSAL, 'draft\n');

  gitInit(root);
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(git(root, 'check-ignore', STATE, PROPOSAL, '.apex/inception/.gitignore').trim().split('\n').length, 3);
  assert.deepEqual(observeInceptionGit(root, { runId: RUN, env: gitEnv(root) }), { state: 'ignored', tracked: [], trackedCount: 0 });
}));

test('already tracked inception content is reported, never removed from Git', () => withTemp('tracked', (root) => {
  gitInit(root);
  put(root, `.apex/inception/${OTHER}/notes.md`, 'leaked\n');
  git(root, 'add', '-f', `.apex/inception/${OTHER}/notes.md`);
  git(root, 'commit', '-qm', 'leak');
  const head = git(root, 'rev-parse', 'HEAD');
  const result = startInceptionRun(root, { runId: RUN, env: gitEnv(root) });
  assert.equal(result.created, true);
  assert.deepEqual(result.git, {
    state: 'ignored',
    tracked: [`.apex/inception/${OTHER}/notes.md`],
    trackedCount: 1,
  });
  assert.equal(git(root, 'ls-files', '.apex/inception').trim(), `.apex/inception/${OTHER}/notes.md`);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(root, `.apex/inception/${OTHER}/notes.md`), 'utf8'), 'leaked\n');

  const run = runCli(['inspect', '--root', root, '--state', STATE], { env: gitEnv(root) });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).git.trackedCount, 1);
}));

test('a failure between the area and the descriptor grants no pre-hub state; resume completes only the known start', () => withTemp('resume', (root) => {
  assertCode(() => startInceptionRun(root, {
    runId: RUN,
    onCheckpoint({ phase }) { if (phase === 'before-descriptor') throw Object.assign(new Error('crash'), { code: 'CRASH' }); },
  }), 'CRASH');
  assert.deepEqual({ ...inspectInceptionState(root) }, { state: 'incomplete', reason: 'descriptor is absent' });
  const restarted = startInceptionRun(root, { runId: OTHER });
  assert.equal(restarted.created, true, 'no descriptor existed, so any exact start may complete the area');
  assert.equal(inspectInceptionState(root).state, 'pre-hub');

  withTemp('resume-run-dir', (second) => {
    assertCode(() => startInceptionRun(second, {
      runId: RUN,
      onCheckpoint({ phase }) { if (phase === 'before-run-directory') throw Object.assign(new Error('crash'), { code: 'CRASH' }); },
    }), 'CRASH');
    assert.equal(existsSync(join(second, `.apex/inception/${RUN}`)), false);
    const bytes = stateBytes(second);
    assertCode(() => startInceptionRun(second, { runId: OTHER }), 'INCEPTION_STATE_EXISTS');
    assert.deepEqual(stateBytes(second), bytes);
    const resumed = startInceptionRun(second, { runId: RUN });
    assert.equal(resumed.created, false);
    assert.equal(lstatSync(join(second, `.apex/inception/${RUN}`)).isDirectory(), true);
    assert.deepEqual(stateBytes(second), bytes);
  });
}));

test('start never overwrites an existing, progressed, or invalid run', () => withTemp('repeat', (root) => {
  startInceptionRun(root, { runId: RUN });
  updateInceptionState(root, { expectedSha256: stateDigest(root), changes: { phase: 'architecture' } });
  const bytes = stateBytes(root);
  assertCode(() => startInceptionRun(root, { runId: RUN }), 'INCEPTION_STATE_EXISTS');
  assertCode(() => startInceptionRun(root), 'INCEPTION_STATE_EXISTS');
  assert.deepEqual(stateBytes(root), bytes);

  writeFileSync(join(root, STATE), '{"broken":');
  assertCode(() => startInceptionRun(root, { runId: RUN }), 'INCEPTION_STATE_EXISTS', /invalid/);
  assert.equal(readFileSync(join(root, STATE), 'utf8'), '{"broken":');

  withTemp('repeat-guard', (other) => {
    mkdirSync(join(other, '.apex/inception'), { recursive: true });
    writeFileSync(join(other, '.apex/inception/.gitignore'), '# mine\n');
    assertCode(() => startInceptionRun(other, { runId: RUN }), 'INCEPTION_STATE_EXISTS', /invalid/);
    assert.equal(readFileSync(join(other, '.apex/inception/.gitignore'), 'utf8'), '# mine\n');
    assert.equal(existsSync(join(other, STATE)), false);
  });

  withTemp('generated', (fresh) => {
    const generated = startInceptionRun(fresh);
    assert.match(generated.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
}));

test('update compares the previous digest, verifies references, applies only explicit legal changes', () => withTemp('update', (root) => {
  startInceptionRun(root, { runId: RUN });
  assertCode(() => updateInceptionState(root, { changes: { phase: 'architecture' } }), 'INCEPTION_STATE_ARGUMENT', /expectedSha256/);
  assertCode(() => updateInceptionState(root, { expectedSha256: sha('stale'), changes: { phase: 'architecture' } }), 'INCEPTION_STATE_STALE');
  assertCode(() => updateInceptionState(root, { expectedSha256: stateDigest(root), changes: { runId: OTHER } }), 'INCEPTION_STATE_ARGUMENT');
  assertCode(() => updateInceptionState(root, { expectedSha256: stateDigest(root), changes: { schemaVersion: 2 } }), 'INCEPTION_STATE_ARGUMENT');

  const step = (changes) => updateInceptionState(root, { expectedSha256: stateDigest(root), changes });
  assert.equal(step({ phase: 'architecture' }).changed, true);
  step({ phase: 'approval' });

  put(root, PROPOSAL, 'approved proposal\n');
  let bytes = stateBytes(root);
  assertCode(() => step({ phase: 'bootstrap' }), 'INCEPTION_STATE_INVALID', /approval/);
  assertCode(() => step({ phase: 'bootstrap', approval: ref(PROPOSAL, 'something else\n') }), 'INCEPTION_STATE_REFERENCE', /approval/);
  assertCode(() => step({ phase: 'bootstrap', approval: ref(`.apex/inception/${RUN}/missing.md`, 'x') }), 'INCEPTION_STATE_REFERENCE', /approval/);
  assert.deepEqual(stateBytes(root), bytes, 'refused updates preserve the descriptor');

  const bootstrapped = step({ phase: 'bootstrap', approval: ref(PROPOSAL, 'approved proposal\n') });
  assert.equal(bootstrapped.descriptor.phase, 'bootstrap');
  assert.equal(bootstrapped.sha256, stateDigest(root));

  // A changed approved document cannot carry its old approval forward.
  writeFileSync(join(root, PROPOSAL), 'substantially changed\n');
  assertCode(() => step({ status: 'blocked' }), 'INCEPTION_STATE_REFERENCE', /approval/);
  writeFileSync(join(root, PROPOSAL), 'approved proposal\n');

  // Identical content is a no-op preserving bytes, mode, and mtime.
  chmodSync(join(root, STATE), 0o600);
  utimesSync(join(root, STATE), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  const before = lstatSync(join(root, STATE), { bigint: true });
  bytes = stateBytes(root);
  const noop = step({ phase: 'bootstrap' });
  assert.equal(noop.changed, false);
  const after = lstatSync(join(root, STATE), { bigint: true });
  assert.deepEqual(stateBytes(root), bytes);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.mode, before.mode);
  assert.equal(after.ino, before.ino);

  put(root, HANDOFF, 'handoff\n');
  step({ phase: 'init', init: { status: 'in-progress', handoff: ref(HANDOFF, 'handoff\n'), receipt: null } });
  assert.equal(inspectInceptionState(root).state, 'init-in-progress');
  assertCode(() => step({ init: { status: 'not-started', handoff: null, receipt: null } }), 'INCEPTION_STATE_TRANSITION', /init/);
  assertCode(() => step({ phase: 'verification' }), 'INCEPTION_STATE_INVALID', /init/);

  put(root, RECEIPT, '{}\n');
  const completed = step({ init: { status: 'complete', handoff: ref(HANDOFF, 'handoff\n'), receipt: ref(RECEIPT, '{}\n') } });
  assert.equal(completed.descriptor.phase, 'init', 'update never advances a phase on its own');
  assert.equal(completed.descriptor.status, 'active', 'update never certifies completion on its own');
  assert.equal(inspectInceptionState(root).state, 'init-complete');
  const done = step({ phase: 'complete', status: 'complete' });
  assert.equal(done.descriptor.status, 'complete');
}));

test('a descriptor substituted during update is detected and preserved', () => withTemp('update-race', (root) => {
  startInceptionRun(root, { runId: RUN });
  const other = `${JSON.stringify({ ...createInitialInceptionState(RUN), phase: 'research' }, null, 2)}\n`;
  assertCode(() => updateInceptionState(root, {
    expectedSha256: stateDigest(root),
    changes: { phase: 'architecture' },
    onCheckpoint({ phase }) {
      if (phase === 'before-publish') {
        writeFileSync(join(root, '.apex/inception/intruder'), other);
        renameSync(join(root, '.apex/inception/intruder'), join(root, STATE));
      }
    },
  }), 'INCEPTION_UNSAFE', /changed/);
  assert.equal(readFileSync(join(root, STATE), 'utf8'), other);
  assert.deepEqual(readdirSync(join(root, '.apex/inception')).sort(), ['.gitignore', RUN, 'state.json']);
}));

test('inspect classifies local states from the descriptor alone and never follows references', () => {
  withTemp('inspect-absent', (root) => {
    assert.deepEqual({ ...inspectInceptionState(root) }, { state: 'absent' });
    mkdirSync(join(root, '.apex'));
    writeFileSync(join(root, '.apex/_INDEX.md'), '# hub\n');
    assert.deepEqual({ ...inspectInceptionState(root) }, { state: 'absent' });
  });

  withTemp('inspect-refs', (root) => {
    startInceptionRun(root, { runId: RUN });
    put(root, PROPOSAL, 'approved\n');
    for (const phase of ['architecture', 'approval']) {
      updateInceptionState(root, { expectedSha256: stateDigest(root), changes: { phase } });
    }
    updateInceptionState(root, { expectedSha256: stateDigest(root), changes: { phase: 'bootstrap', approval: ref(PROPOSAL, 'approved\n') } });
    rmSync(join(root, PROPOSAL));
    mkdirSync(join(root, PROPOSAL));
    const inspected = inspectInceptionState(root);
    assert.equal(inspected.state, 'pre-hub', 'references are data, not reads');
    assert.deepEqual(inspected.descriptor.approval, ref(PROPOSAL, 'approved\n'));
    assert.equal(Object.hasOwn(inspected, 'approved'), false, 'inspect never certifies approval');
  });

  const invalidCases = [
    ['malformed JSON', (root) => writeFileSync(join(root, STATE), '{'), /descriptor/],
    ['unknown version', (root) => writeFileSync(join(root, STATE), `${JSON.stringify({ ...createInitialInceptionState(RUN), schemaVersion: 2 }, null, 2)}\n`), /schemaVersion/],
    ['incompatible', (root) => writeFileSync(join(root, STATE), `${JSON.stringify({ ...createInitialInceptionState(RUN), phase: 'bootstrap' }, null, 2)}\n`), /approval/],
    ['guard missing', (root) => rmSync(join(root, '.apex/inception/.gitignore')), /guard/],
    ['guard foreign', (root) => writeFileSync(join(root, '.apex/inception/.gitignore'), '*\n!state.json\n'), /guard/],
    ['descriptor symlink', (root) => {
      const real = join(root, 'elsewhere.json');
      writeFileSync(real, readFileSync(join(root, STATE)));
      rmSync(join(root, STATE));
      symlinkSync(real, join(root, STATE));
    }, /symlink/],
    ['descriptor FIFO', (root) => {
      rmSync(join(root, STATE));
      const fifo = spawnSync('mkfifo', [join(root, STATE)], { encoding: 'utf8' });
      assert.equal(fifo.status, 0, fifo.stderr);
    }, /non-file/],
    ['descriptor oversize', (root) => writeFileSync(join(root, STATE), Buffer.alloc(1024 * 1024 + 1, 0x20)), /exceeds/],
  ];
  for (const [label, mutate, pattern] of invalidCases) {
    withTemp('inspect-invalid', (root) => {
      startInceptionRun(root, { runId: RUN });
      mutate(root);
      const inspected = inspectInceptionState(root);
      assert.equal(inspected.state, 'invalid', label);
      assert.match(inspected.reason, pattern, label);
    });
  }

  withTemp('inspect-mount', (root) => {
    symlinkSync(join(root, 'missing'), join(root, '.apex'));
    const inspected = inspectInceptionState(root);
    assert.equal(inspected.state, 'invalid');
    assert.match(inspected.reason, /mount/);
  });

  withTemp('inspect-mounted', (root) => {
    const external = mkdtempSync(join(tmpdir(), 'steepy-inception-state-external-'));
    try {
      symlinkSync(external, join(root, '.apex'));
      const started = startInceptionRun(root, { runId: RUN });
      assert.equal(existsSync(join(external, 'inception/state.json')), true);
      assert.equal(inspectInceptionState(root).sha256, started.sha256);
      assert.equal(lstatSync(join(root, '.apex')).isSymbolicLink(), true);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });
});

test('CLI requires explicit root and canonical state, maps usage errors to 2, and emits JSON', () => withTemp('cli', (root) => {
  const env = gitEnv(root);
  for (const args of [
    [],
    ['bogus', '--root', root, '--state', STATE],
    ['inspect', '--state', STATE],
    ['inspect', '--root', root],
    ['inspect', '--root', root, '--state', '.apex/inception/other.json'],
    ['inspect', '--root', root, '--state', STATE, '--unknown'],
    ['inspect', '--root', root, '--state', STATE, 'extra'],
    ['start', '--root', root, '--state', STATE, '--set', '{}'],
    ['update', '--root', root, '--state', STATE, '--set', '{"phase":"architecture"}'],
    ['update', '--root', root, '--state', STATE, '--expected-sha256', sha('x')],
    ['inspect', '--root', root, '--state', STATE, '--run-id', RUN],
  ]) {
    const run = runCli(args, { env });
    assert.equal(run.status, 2, `${args.join(' ')} → ${run.status}: ${run.stderr}`);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /usage/i);
  }
  assert.equal(existsSync(join(root, '.apex')), false, 'usage errors write nothing');

  const absent = runCli(['inspect', '--root', root, '--state', STATE], { env });
  assert.equal(absent.status, 0);
  assert.deepEqual(JSON.parse(absent.stdout), { state: 'absent', git: null });

  const started = runCli(['start', '--root', root, '--state', STATE, '--run-id', RUN], { env });
  assert.equal(started.status, 0, started.stderr);
  const first = JSON.parse(started.stdout);
  assert.equal(first.sha256, stateDigest(root));

  const updated = runCli(['update', '--root', root, '--state', STATE, '--expected-sha256', first.sha256, '--set', '{"phase":"architecture"}'], { env });
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(JSON.parse(updated.stdout).descriptor.phase, 'architecture');

  const stale = runCli(['update', '--root', root, '--state', STATE, '--expected-sha256', first.sha256, '--set', '{"phase":"research"}'], { env });
  assert.equal(stale.status, 1);
  assert.equal(stale.stdout, '');
  assert.match(stale.stderr, /digest/);

  const secret = runCli(['update', '--root', root, '--state', STATE, '--expected-sha256', stateDigest(root), '--set', '{"apiToken":"sk-live-secret"}'], { env });
  assert.equal(secret.status, 1);
  assert.doesNotMatch(secret.stderr, /sk-live-secret|apiToken/);

  const inspected = runCli(['inspect', '--root', root, '--state', STATE], { env });
  assert.equal(inspected.status, 0);
  const report = JSON.parse(inspected.stdout);
  assert.equal(report.state, 'pre-hub');
  assert.deepEqual(report.git, { state: 'not-repository' });

  writeFileSync(join(root, STATE), '{');
  const invalid = runCli(['inspect', '--root', root, '--state', STATE], { env });
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).state, 'invalid');
}));

test('this repository ignores its own local inception area; targets rely on the local guard', () => {
  const lines = readFileSync(join(here, '..', '.gitignore'), 'utf8').split('\n');
  assert.ok(lines.includes('/.apex/inception/'), 'repository .gitignore must ignore /.apex/inception/');
  assert.ok(lines.includes('/.apex/work/'), 'the existing work-area rule is preserved');
});

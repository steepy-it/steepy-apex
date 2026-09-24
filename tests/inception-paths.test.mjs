import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  INCEPTION_GUARD_CONTENT,
  INCEPTION_GUARD_PATH,
  INCEPTION_STATE_PATH,
  MAX_INCEPTION_READ_BYTES,
  classifyInceptionPath,
  ensureInceptionGuard,
  ensureInceptionRunDirectory,
  isCanonicalRunId,
  readInceptionFile,
  sha256Hex,
  writeInceptionFile,
} from '../scripts/inception-paths.mjs';

const RUN = '0b6f1b8e-3c1a-4e2b-9f3d-5a7c9e1b2d4f';
const OTHER = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const DOC = `.apex/inception/${RUN}/proposal.md`;

function withTemp(suffix, fn) {
  const root = mkdtempSync(join(tmpdir(), `steepy-inception-${suffix}-`));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function guarded(root) {
  ensureInceptionGuard(root);
  return root;
}

function physicalSnapshot(path) {
  const stat = lstatSync(path, { bigint: true });
  return { bytes: readFileSync(path), mode: stat.mode, mtimeNs: stat.mtimeNs, ino: stat.ino };
}

function assertCode(fn, code, pattern) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test('run identifiers are canonical lowercase UUIDs only', () => {
  assert.equal(isCanonicalRunId(RUN), true);
  for (const value of [
    RUN.toUpperCase(),
    '00000000-0000-0000-0000-000000000000',
    `${RUN}x`,
    RUN.replaceAll('-', ''),
    '0b6f1b8e-3c1a-0e2b-9f3d-5a7c9e1b2d4f',
    '0b6f1b8e-3c1a-4e2b-7f3d-5a7c9e1b2d4f',
    '',
    null,
    42,
  ]) {
    assert.equal(isCanonicalRunId(value), false, `rejects ${String(value)}`);
  }
});

test('lexical classification admits only the canonical descriptor, the guard, and exact files of the declared run', () => {
  assert.deepEqual({ ...classifyInceptionPath(INCEPTION_STATE_PATH) }, {
    path: '.apex/inception/state.json', kind: 'descriptor', runId: null,
  });
  assert.deepEqual({ ...classifyInceptionPath(INCEPTION_GUARD_PATH) }, {
    path: '.apex/inception/.gitignore', kind: 'guard', runId: null,
  });
  assert.deepEqual({ ...classifyInceptionPath(`.apex/inception/${RUN}/research/stack.md`, { runId: RUN }) }, {
    path: `.apex/inception/${RUN}/research/stack.md`, kind: 'run-file', runId: RUN,
  });
  assert.ok(Object.isFrozen(classifyInceptionPath(DOC, { runId: RUN })));

  const rejected = [
    ['', /non-empty/],
    [`/abs/${DOC}`, /repository-relative/],
    [`${DOC}/`, /empty segment/],
    [`.apex/inception//${RUN}/proposal.md`, /empty segment/],
    [`./${DOC}`, /'\.' segment/],
    [`.apex/inception/${RUN}/../state.json`, /'\.\.' segment/],
    [`.apex/inception/${RUN}/*.md`, /glob/],
    [`.apex/inception/${RUN}/proposal?.md`, /glob/],
    [`.apex/inception/${RUN}/[ab].md`, /glob/],
    [`.apex/inception/${RUN}/{a,b}.md`, /glob/],
    [`.apex/inception/${RUN}\\proposal.md`, /backslash/],
    [`.apex/inception/${RUN}/pro\nposal.md`, /control/],
    [`.apex/inception/${RUN}/pro posal.md`, /unsafe characters/],
    [`.apex/inception/${RUN}/.hidden.md`, /unsafe characters/],
    [`.apex/inception/${OTHER}/proposal.md`, /declared run/],
    [`.apex/inception/${RUN}`, /not an exact run file/],
    ['.apex/inception', /not an exact inception file/],
    ['.apex/inception/notes.md', /not an exact inception file/],
    ['.apex/work/specs/demo.md', /outside/],
    ['docs/state.json', /outside/],
    ['.APEX/inception/state.json', /outside/],
    [`.apex/inception/${RUN.toUpperCase()}/proposal.md`, /not an exact inception file/],
    [`.apex/inception/${RUN}/${'a'.repeat(256)}`, /too long/],
  ];
  for (const [value, pattern] of rejected) {
    assert.throws(
      () => classifyInceptionPath(value, { runId: RUN }),
      (error) => error.code === 'INCEPTION_PATH' && pattern.test(error.message),
      `must reject ${JSON.stringify(value)} with ${pattern}`,
    );
  }
  assertCode(() => classifyInceptionPath(DOC), 'INCEPTION_PATH', /declared run/);
  assertCode(() => classifyInceptionPath(DOC, { runId: 'not-a-uuid' }), 'INCEPTION_PATH', /run id/);
  assertCode(() => classifyInceptionPath(`.apex/inception/${RUN}/${'a/'.repeat(600)}x`, { runId: RUN }), 'INCEPTION_PATH', /too long/);
});

test('the guard is created first, before any document, and a rerun is an exact no-op', () => withTemp('guard', (root) => {
  const first = ensureInceptionGuard(root);
  assert.deepEqual({ ...first }, { path: INCEPTION_GUARD_PATH, created: true });
  assert.equal(readFileSync(join(root, '.apex/inception/.gitignore'), 'utf8'), '*\n');
  assert.equal(INCEPTION_GUARD_CONTENT, '*\n');
  assert.deepEqual(readdirSync(join(root, '.apex')), ['inception']);
  assert.deepEqual(readdirSync(join(root, '.apex/inception')), ['.gitignore']);

  const guardPath = join(root, '.apex/inception/.gitignore');
  utimesSync(guardPath, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  const before = physicalSnapshot(guardPath);
  assert.deepEqual({ ...ensureInceptionGuard(root) }, { path: INCEPTION_GUARD_PATH, created: false });
  assert.deepEqual(physicalSnapshot(guardPath), before);
}));

test('a foreign guard is never overwritten', () => withTemp('guard-foreign', (root) => {
  mkdirSync(join(root, '.apex/inception'), { recursive: true });
  writeFileSync(join(root, '.apex/inception/.gitignore'), '*\n!keep.md\n');
  assertCode(() => ensureInceptionGuard(root), 'INCEPTION_UNGUARDED', /unexpected content/);
  assert.equal(readFileSync(join(root, '.apex/inception/.gitignore'), 'utf8'), '*\n!keep.md\n');
}));

test('documents and the descriptor cannot be written before the ignore guard exists', () => withTemp('unguarded', (root) => {
  assertCode(
    () => writeInceptionFile(root, INCEPTION_STATE_PATH, '{}\n', { expectedSha256: null }),
    'INCEPTION_UNGUARDED',
  );
  assertCode(
    () => writeInceptionFile(root, DOC, 'draft\n', { runId: RUN, expectedSha256: null }),
    'INCEPTION_UNGUARDED',
  );
  assert.equal(existsSync(join(root, '.apex')), false, 'no area, no document');

  mkdirSync(join(root, '.apex/inception'), { recursive: true });
  assertCode(
    () => writeInceptionFile(root, DOC, 'draft\n', { runId: RUN, expectedSha256: null }),
    'INCEPTION_UNGUARDED',
  );
  assert.deepEqual(readdirSync(join(root, '.apex/inception')), []);
}));

test('writes compare the previous digest, publish atomically, and identical bytes are a no-op', () => withTemp('write', (root) => {
  guarded(root);
  assertCode(() => writeInceptionFile(root, DOC, 'draft\n', { runId: RUN }), 'INCEPTION_ARGUMENT', /expectedSha256/);

  const created = writeInceptionFile(root, DOC, 'draft\n', { runId: RUN, expectedSha256: null });
  assert.deepEqual({ ...created }, { path: DOC, sha256: sha256Hex('draft\n'), bytes: 6, changed: true });
  const target = join(root, DOC);
  assert.equal(readFileSync(target, 'utf8'), 'draft\n');
  assert.equal(statSync(target).mode & 0o777, 0o644);

  assertCode(() => writeInceptionFile(root, DOC, 'other\n', { runId: RUN, expectedSha256: null }), 'INCEPTION_EXISTS');
  assertCode(() => writeInceptionFile(root, DOC, 'other\n', { runId: RUN, expectedSha256: sha256Hex('stale\n') }), 'INCEPTION_STALE');
  assert.equal(readFileSync(target, 'utf8'), 'draft\n');
  assertCode(
    () => writeInceptionFile(root, `.apex/inception/${RUN}/absent.md`, 'x', { runId: RUN, expectedSha256: sha256Hex('x') }),
    'INCEPTION_STALE',
  );
  assert.equal(existsSync(join(root, `.apex/inception/${RUN}/absent.md`)), false);

  const replaced = writeInceptionFile(root, DOC, 'final\n', { runId: RUN, expectedSha256: sha256Hex('draft\n') });
  assert.equal(replaced.changed, true);
  assert.equal(readFileSync(target, 'utf8'), 'final\n');

  utimesSync(target, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  chmodSync(target, 0o600);
  const before = physicalSnapshot(target);
  const noop = writeInceptionFile(root, DOC, 'final\n', { runId: RUN, expectedSha256: sha256Hex('final\n') });
  assert.deepEqual({ ...noop }, { path: DOC, sha256: sha256Hex('final\n'), bytes: 6, changed: false });
  assert.deepEqual(physicalSnapshot(target), before, 'no-op preserves bytes, mode, mtime, and inode');

  writeInceptionFile(root, DOC, 'mode kept\n', { runId: RUN, expectedSha256: sha256Hex('final\n') });
  assert.equal(statSync(target).mode & 0o777, 0o600, 'replacement preserves the existing mode');
  assert.deepEqual(readdirSync(join(root, `.apex/inception/${RUN}`)), ['proposal.md'], 'no staging residue');
}));

test('reads are bounded to 1 MiB and oversize writes are refused before any output', () => withTemp('bounded', (root) => {
  guarded(root);
  mkdirSync(join(root, `.apex/inception/${RUN}`));
  const exact = `.apex/inception/${RUN}/exact.md`;
  const large = `.apex/inception/${RUN}/large.md`;
  writeFileSync(join(root, exact), Buffer.alloc(MAX_INCEPTION_READ_BYTES, 0x61));
  writeFileSync(join(root, large), Buffer.alloc(MAX_INCEPTION_READ_BYTES + 1, 0x61));
  assert.equal(MAX_INCEPTION_READ_BYTES, 1024 * 1024);
  assert.equal(readInceptionFile(root, exact, { runId: RUN }).length, MAX_INCEPTION_READ_BYTES);
  assertCode(() => readInceptionFile(root, large, { runId: RUN }), 'INCEPTION_TOO_LARGE');
  assertCode(
    () => writeInceptionFile(root, `.apex/inception/${RUN}/big.md`, Buffer.alloc(MAX_INCEPTION_READ_BYTES + 1), { runId: RUN, expectedSha256: null }),
    'INCEPTION_TOO_LARGE',
  );
  assert.equal(existsSync(join(root, `.apex/inception/${RUN}/big.md`)), false);
  assert.equal(readInceptionFile(root, exact, { runId: RUN, encoding: 'utf8' }).length, MAX_INCEPTION_READ_BYTES);
  assertCode(() => readInceptionFile(root, `.apex/inception/${RUN}/absent.md`, { runId: RUN }), 'INCEPTION_MISSING');
}));

test('descendant symlinks, FIFOs, directories, and hardlinks fail closed without touching outside bytes', () => withTemp('physical', (root) => {
  guarded(root);
  const outside = mkdtempSync(join(tmpdir(), 'steepy-inception-outside-'));
  try {
    const outsideFile = join(outside, 'secret.md');
    writeFileSync(outsideFile, 'outside\n');

    // Symlinked run directory.
    symlinkSync(outside, join(root, `.apex/inception/${RUN}`));
    assertCode(() => readInceptionFile(root, `.apex/inception/${RUN}/secret.md`, { runId: RUN }), 'INCEPTION_UNSAFE', /symlink/);
    assertCode(
      () => writeInceptionFile(root, `.apex/inception/${RUN}/new.md`, 'x', { runId: RUN, expectedSha256: null }),
      'INCEPTION_UNSAFE',
      /symlink/,
    );
    assert.deepEqual(readdirSync(outside), ['secret.md']);
    rmSync(join(root, `.apex/inception/${RUN}`));

    mkdirSync(join(root, `.apex/inception/${RUN}`));
    // Symlinked target file.
    symlinkSync(outsideFile, join(root, DOC));
    assertCode(() => readInceptionFile(root, DOC, { runId: RUN }), 'INCEPTION_UNSAFE', /symlink/);
    assertCode(() => writeInceptionFile(root, DOC, 'x', { runId: RUN, expectedSha256: sha256Hex('outside\n') }), 'INCEPTION_UNSAFE', /symlink/);
    rmSync(join(root, DOC));

    // Hardlinked target shares the outside inode.
    linkSync(outsideFile, join(root, DOC));
    assertCode(() => readInceptionFile(root, DOC, { runId: RUN }), 'INCEPTION_UNSAFE', /hard-linked/);
    assertCode(() => writeInceptionFile(root, DOC, 'x', { runId: RUN, expectedSha256: sha256Hex('outside\n') }), 'INCEPTION_UNSAFE', /hard-linked/);
    rmSync(join(root, DOC));
    assert.equal(readFileSync(outsideFile, 'utf8'), 'outside\n');

    // FIFO target: refused before any blocking open.
    const fifo = spawnSync('mkfifo', [join(root, DOC)], { encoding: 'utf8' });
    assert.equal(fifo.status, 0, `mkfifo: ${fifo.stderr}`);
    assertCode(() => readInceptionFile(root, DOC, { runId: RUN }), 'INCEPTION_UNSAFE', /non-file/);
    assertCode(() => writeInceptionFile(root, DOC, 'x', { runId: RUN, expectedSha256: null }), 'INCEPTION_UNSAFE', /non-file/);
    assert.equal(lstatSync(join(root, DOC)).isFIFO(), true);
    rmSync(join(root, DOC));

    // Directory target.
    mkdirSync(join(root, DOC));
    assertCode(() => readInceptionFile(root, DOC, { runId: RUN }), 'INCEPTION_UNSAFE', /non-file/);
    rmSync(join(root, DOC), { recursive: true });

    // Symlinked inception area below the admitted .apex mount.
    rmSync(join(root, '.apex/inception'), { recursive: true });
    mkdirSync(join(outside, 'area'));
    writeFileSync(join(outside, 'area', '.gitignore'), '*\n');
    symlinkSync(join(outside, 'area'), join(root, '.apex/inception'));
    assertCode(() => ensureInceptionGuard(root), 'INCEPTION_UNSAFE', /symlink/);
    assertCode(() => readInceptionFile(root, INCEPTION_GUARD_PATH), 'INCEPTION_UNSAFE', /symlink/);
    assert.deepEqual(readdirSync(join(outside, 'area')), ['.gitignore']);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}));

test('a target substituted during the write is detected and left untouched', () => withTemp('substitute', (root) => {
  guarded(root);
  writeInceptionFile(root, DOC, 'original\n', { runId: RUN, expectedSha256: null });
  const target = join(root, DOC);
  const intruder = join(root, `.apex/inception/${RUN}/intruder.md`);
  assertCode(() => writeInceptionFile(root, DOC, 'replacement\n', {
    runId: RUN,
    expectedSha256: sha256Hex('original\n'),
    onCheckpoint({ operation, phase }) {
      if (operation === 'write' && phase === 'before-publish') {
        writeFileSync(intruder, 'substituted\n');
        renameSync(intruder, target);
      }
    },
  }), 'INCEPTION_UNSAFE', /changed/);
  assert.equal(readFileSync(target, 'utf8'), 'substituted\n');
  assert.deepEqual(readdirSync(join(root, `.apex/inception/${RUN}`)), ['proposal.md'], 'staged temp is removed');

  // In-place modification between digest comparison and publish is also detected.
  assertCode(() => writeInceptionFile(root, DOC, 'second\n', {
    runId: RUN,
    expectedSha256: sha256Hex('substituted\n'),
    onCheckpoint({ operation, phase }) {
      if (operation === 'write' && phase === 'before-publish') writeFileSync(target, 'edited in place\n');
    },
  }), 'INCEPTION_UNSAFE', /changed/);
  assert.equal(readFileSync(target, 'utf8'), 'edited in place\n');

  // A read whose target is swapped after binding fails closed.
  assertCode(() => readInceptionFile(root, DOC, {
    runId: RUN,
    onCheckpoint() {
      writeFileSync(intruder, 'swap\n');
      renameSync(intruder, target);
    },
  }), 'INCEPTION_UNSAFE', /changed/);
}));

test('run directories are created only below a guarded area and only as physical directories', () => withTemp('run-dir', (root) => {
  assertCode(() => ensureInceptionRunDirectory(root, RUN), 'INCEPTION_UNGUARDED');
  assert.equal(existsSync(join(root, '.apex')), false);
  guarded(root);
  assert.deepEqual({ ...ensureInceptionRunDirectory(root, RUN) }, { path: `.apex/inception/${RUN}`, created: true });
  assert.deepEqual({ ...ensureInceptionRunDirectory(root, RUN) }, { path: `.apex/inception/${RUN}`, created: false });
  assert.equal(lstatSync(join(root, `.apex/inception/${RUN}`)).isDirectory(), true);
  assertCode(() => ensureInceptionRunDirectory(root, 'nope'), 'INCEPTION_PATH');
  writeFileSync(join(root, `.apex/inception/${OTHER}`), 'file');
  assertCode(() => ensureInceptionRunDirectory(root, OTHER), 'INCEPTION_UNSAFE', /non-directory/);
}));

test('the admitted .apex mount is honored at its physical target; broken and wrong-type mounts are controlled errors', () => {
  for (const kind of ['absolute', 'relative']) {
    withTemp(`mount-${kind}`, (root) => {
      const external = mkdtempSync(join(tmpdir(), 'steepy-inception-external-'));
      try {
        symlinkSync(kind === 'absolute' ? external : relative(root, external), join(root, '.apex'));
        ensureInceptionGuard(root);
        writeInceptionFile(root, DOC, 'mounted\n', { runId: RUN, expectedSha256: null });
        assert.equal(lstatSync(join(root, '.apex')).isSymbolicLink(), true, `${kind}: mount link preserved`);
        assert.equal(readFileSync(join(external, 'inception/.gitignore'), 'utf8'), '*\n');
        assert.equal(readFileSync(join(external, `inception/${RUN}/proposal.md`), 'utf8'), 'mounted\n');
        assert.equal(readInceptionFile(root, DOC, { runId: RUN, encoding: 'utf8' }), 'mounted\n');
      } finally {
        rmSync(external, { recursive: true, force: true });
      }
    });
  }

  withTemp('mount-broken', (root) => {
    const missing = join(root, 'missing-target');
    symlinkSync(missing, join(root, '.apex'));
    assertCode(() => ensureInceptionGuard(root), 'INCEPTION_UNSAFE', /mount/);
    assert.equal(existsSync(missing), false);
  });

  withTemp('mount-file', (root) => {
    writeFileSync(join(root, 'hub-file'), 'x');
    symlinkSync(join(root, 'hub-file'), join(root, '.apex'));
    assertCode(() => ensureInceptionGuard(root), 'INCEPTION_UNSAFE', /mount/);
  });

  withTemp('apex-file', (root) => {
    writeFileSync(join(root, '.apex'), 'x');
    assertCode(() => ensureInceptionGuard(root), 'INCEPTION_UNSAFE', /non-directory/);
    assert.equal(readFileSync(join(root, '.apex'), 'utf8'), 'x');
  });
});

test('repository root admission rejects parent traversal, a direct root symlink, and missing roots', () => withTemp('root', (base) => {
  const real = join(base, 'real');
  mkdirSync(real);
  symlinkSync(real, join(base, 'link'));
  assertCode(() => ensureInceptionGuard(`${base}/real/../real`), 'INCEPTION_ROOT', /parent traversal/);
  assertCode(() => ensureInceptionGuard(join(base, 'link')), 'INCEPTION_ROOT', /symlink/);
  assertCode(() => ensureInceptionGuard(join(base, 'absent')), 'INCEPTION_ROOT', /root/);
  assertCode(() => ensureInceptionGuard(''), 'INCEPTION_ROOT', /root/);
  writeFileSync(join(base, 'plain-file'), 'x');
  assertCode(() => readInceptionFile(join(base, 'plain-file'), INCEPTION_STATE_PATH), 'INCEPTION_ROOT', /not a directory/);
  assert.equal(existsSync(join(real, '.apex')), false);
}));

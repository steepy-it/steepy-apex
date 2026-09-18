import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  appendWorkPath,
  classifyWorkPath,
  mkdirWorkPath,
  openWorkPathFd,
  parseWorkPath,
  readWorkPath,
  writeWorkPath,
} from '../scripts/work-paths.mjs';

const RUN = '2026-09-02-demo-run';
const FAMILIES = [
  ['spec', '.apex/work/specs/demo-spec.md', 'spec'],
  ['criteria', `.apex/work/tasks/${RUN}/success-criteria.md`, 'criteria'],
  ['plan', '.apex/work/plans/demo-spec.md', 'work-output'],
  ['manifest', `.apex/work/tasks/${RUN}/context/phase-1-attempt-1.json`, 'work-output'],
  ['status', `.apex/work/tasks/${RUN}/autopilot-status.md`, 'work-output'],
  ['raw', `.apex/work/tasks/${RUN}/phase-1-attempt-1.raw.jsonl`, 'work-output'],
  ['ledger', `.apex/work/tasks/${RUN}/resource-usage.jsonl`, 'work-output'],
  ['diff', `.apex/work/tasks/${RUN}/branch-diff.txt`, 'work-output'],
  ['task-result-index', `.apex/work/tasks/${RUN}/task-result-index.md`, 'work-output'],
  ['task-report', `.apex/work/tasks/${RUN}/task-1-report.md`, 'work-output'],
  ['task-result', `.apex/work/tasks/${RUN}/task-1-execution-1-baseline.json`, 'work-output'],
  ['task-result', `.apex/work/tasks/${RUN}/task-1-execution-1-capture.json`, 'work-output'],
  ['task-result', `.apex/work/tasks/${RUN}/task-1-execution-1-result.json`, 'work-output'],
  ['task-result-report', `.apex/work/tasks/${RUN}/task-1-execution-1-report.md`, 'work-output'],
  ['evidence', `.apex/work/tasks/${RUN}/evidence-report.md`, 'work-output'],
  ['review-report', `.apex/work/tasks/${RUN}/review-report.md`, 'work-output'],
];
const SYMLINK_FAMILIES = [
  'manifest', 'criteria', 'status', 'raw', 'ledger', 'diff', 'evidence', 'review-report', 'task-report', 'task-result', 'task-result-report',
];
const LOOP = '2026-09-03-demo-loop';
const UUID = '12345678-1234-4234-8234-123456789abc';
const LOOP_FAMILIES = [
  ['goal', `.apex/work/loops/${LOOP}/goal.md`, 'goal'],
  ['events', `.apex/work/loops/${LOOP}/events.jsonl`, 'work-output'],
  ['ledger', `.apex/work/loops/${LOOP}/ledger.md`, 'work-output'],
  ['diff', `.apex/work/loops/${LOOP}/branch-diff.txt`, 'work-output'],
  ['evidence', `.apex/work/loops/${LOOP}/evidence-report.md`, 'work-output'],
  ['review-report', `.apex/work/loops/${LOOP}/review-report.md`, 'work-output'],
  ['runner-report', `.apex/work/loops/${LOOP}/run-${UUID}-attempt-1-report.md`, 'work-output'],
  ['runner-log', `.apex/work/loops/${LOOP}/run-${UUID}-attempt-2.log`, 'work-output'],
  ['runner-raw', `.apex/work/loops/${LOOP}/run-${UUID}-attempt-3.raw.jsonl`, 'work-output'],
  ['runner-diff', `.apex/work/loops/${LOOP}/run-${UUID}-attempt-4-diff.txt`, 'work-output'],
  ['reviewer-report', `.apex/work/loops/${LOOP}/run-${UUID}-review-1-report.md`, 'work-output'],
  ['reviewer-log', `.apex/work/loops/${LOOP}/run-${UUID}-review-2.log`, 'work-output'],
  ['reviewer-raw', `.apex/work/loops/${LOOP}/run-${UUID}-review-3.raw.jsonl`, 'work-output'],
  ['reviewer-diff', `.apex/work/loops/${LOOP}/run-${UUID}-review-4-diff.txt`, 'work-output'],
];

function fixture() {
  return mkdtempSync(join(tmpdir(), 'steepy-work-paths-'));
}

function snapshot(root, prefix = '') {
  const dir = join(root, prefix);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return snapshot(root, path);
    if (entry.isSymbolicLink()) return [`${path}:symlink`];
    const stat = lstatSync(join(root, path));
    return [`${path}:${stat.mode}:${readFileSync(join(root, path)).toString('hex')}`];
  }).sort();
}

test('typed grammar classifies every canonical family and never normalizes aliases', () => {
  for (const [family, path, type] of FAMILIES) {
    const parsed = classifyWorkPath(path);
    assert.equal(parsed.type, type, family);
    assert.equal(parsed.family, family, family);
    assert.deepEqual(parseWorkPath(path, type), parsed, family);
  }
  assert.equal(classifyWorkPath(`.apex/work/tasks/${RUN}/phase-2.log`).family, 'raw');
  assert.equal(classifyWorkPath(`.apex/work/tasks/${RUN}/phase-2-attempt-3.log`).family, 'raw');
  assert.equal(classifyWorkPath(`.apex/work/tasks/${RUN}/phase-2-attempt-3.raw.jsonl`).family, 'raw');
  assert.equal(classifyWorkPath(`.apex/work/tasks/${RUN}/context/phase-2-attempt-3.json`).family, 'manifest');

  const base = '.apex/work/specs/demo-spec.md';
  const aliases = [
    `./${base}`,
    `.apex//work/specs/demo-spec.md`,
    `.apex/work//specs/demo-spec.md`,
    `.apex/work/specs//demo-spec.md`,
    `${base}/`,
    `.apex/./work/specs/demo-spec.md`,
    `.apex/work/specs/./demo-spec.md`,
    `.apex/work/specs/../specs/demo-spec.md`,
    `/${base}`,
    '.apex/work/specs/.hidden-start.md',
    '.apex/work/specs/.md',
  ];
  const repo = fixture();
  try {
    for (const alias of aliases) {
      assert.throws(() => classifyWorkPath(alias), /work path/u, alias);
      assert.throws(() => parseWorkPath(alias), /work path/u, alias);
      assert.throws(() => readWorkPath(repo, alias), /work path/u, alias);
      assert.throws(() => writeWorkPath(repo, alias, 'x'), /work path/u, alias);
      assert.throws(() => appendWorkPath(repo, alias, 'x'), /work path/u, alias);
      assert.throws(() => mkdirWorkPath(repo, alias), /work path/u, alias);
    }
    for (const invalid of ['', 42, null, undefined]) {
      assert.throws(() => classifyWorkPath(invalid), /work path/u, String(invalid));
    }
    assert.deepEqual(readdirSync(repo), []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the implementation and both stable work-path descriptions share one ordered type grammar', () => {
  const source = readFileSync(new URL('../scripts/work-paths.mjs', import.meta.url), 'utf8');
  const declaration = source.match(/const WORK_TYPES = new Set\(\[(.*?)\]\);/u);
  assert.ok(declaration, 'work-path implementation must retain a closed WORK_TYPES declaration');
  const implementation = [...declaration[1].matchAll(/'([^']+)'/gu)]
    .map((match) => match[1])
    .join(' | ');
  assert.equal(implementation, 'spec | goal | criteria | work-output');

  for (const relative of ['../.apex/standards/scripts.md', '../docs/architecture.md']) {
    const stable = readFileSync(new URL(relative, import.meta.url), 'utf8');
    assert.ok(
      stable.includes('`spec | goal | criteria | work-output`'),
      `${relative} must match WORK_TYPES in canonical order`,
    );
  }
});

test('grammar rejects wrong-type paths for a call site and paths outside the work contract', () => {
  const specPath = '.apex/work/specs/demo-spec.md';
  const criteriaPath = `.apex/work/tasks/${RUN}/success-criteria.md`;
  const statusPath = `.apex/work/tasks/${RUN}/autopilot-status.md`;
  assert.throws(() => parseWorkPath(criteriaPath, 'spec'), /this call site expects spec/u);
  assert.throws(() => parseWorkPath(specPath, 'work-output'), /this call site expects work-output/u);
  assert.throws(() => parseWorkPath(statusPath, 'work-output', 'ledger'), /this call site expects ledger/u);
  assert.throws(() => parseWorkPath(specPath, 'bogus'), /unknown work path type/u);
  const repo = fixture();
  try {
    assert.throws(() => writeWorkPath(repo, statusPath, 'x', { expect: 'spec' }), /this call site expects spec/u);
    assert.throws(() => appendWorkPath(repo, criteriaPath, 'x', { family: 'status' }), /this call site expects status/u);
    assert.deepEqual(readdirSync(repo), []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  const outside = [
    'scripts/work-paths.mjs',
    '.apex/standards/scripts.md',
    '.apex',
    '.apex/work',
    '.apex/work/tasks',
    `.apex/work/tasks/${RUN}`,
    `.apex/work/tasks/${RUN}/task-1-brief.md`,
    `.apex/work/tasks/${RUN}/unknown.md`,
    '.apex/work/specs/nested/demo-spec.md',
    '.apex/work/other.md',
    '.apex/work/plans',
  ];
  for (const path of outside) {
    assert.throws(() => classifyWorkPath(path), /work path/u, path);
  }
});

test('manifest grammar admits exactly the conductor and protocol context names, never conveniences', () => {
  const ctx = (name) => `.apex/work/tasks/${RUN}/context/${name}`;
  const admitted = [
    'phase-plan-attempt-1.json',
    'phase-implement-attempt-2.json',
    'phase-review-attempt-3.json',
    'phase-3-attempt-1.json',
    'phase-12-attempt-34.json',
    'task-1-implement.json',
    'task-2-review.json',
    'task-3-fix.json',
    'task-1-implement-1.json',
    'task-2-review-4.json',
    'task-3-fix-2.json',
    'final-review.json',
  ];
  for (const name of admitted) {
    const parsed = classifyWorkPath(ctx(name));
    assert.equal(parsed.type, 'work-output', name);
    assert.equal(parsed.family, 'manifest', name);
  }
  const rejected = [
    'phase-Plan-attempt-1.json',
    'phase-deploy-attempt-1.json',
    'phase-01-attempt-1.json',
    'phase-1-attempt-01.json',
    'phase-plan-attempt-0.json',
    'phase-1-implement-attempt-1.json',
    'phase-plan-attempt-1.jsonx',
    'task-0-implement.json',
    'task-01-implement.json',
    'task-1-implementer.json',
    'task-1-oracle.json',
    'task-1-implement-0.json',
    'task-1-implement-01.json',
    'task-1-implement-abc.json',
    'task-1-fix-1-2.json',
    'final-review.json.bak',
    'final-reviews.json',
    'first.json',
    'notes.md',
    'phase-1-attempt-1.raw.jsonl',
  ];
  const repo = fixture();
  try {
    for (const name of rejected) {
      assert.throws(() => classifyWorkPath(ctx(name)), /work path/u, name);
      assert.throws(() => parseWorkPath(ctx(name), 'work-output', 'manifest'), /work path/u, name);
      assert.throws(() => writeWorkPath(repo, ctx(name), 'x', { family: 'manifest' }), /work path/u, name);
    }
    for (const name of ['final-review.json', 'task-2-review-3.json']) {
      writeWorkPath(repo, ctx(name), `${name}\n`, { expect: 'work-output', family: 'manifest' });
      assert.equal(readWorkPath(repo, ctx(name), { family: 'manifest', encoding: 'utf8' }), `${name}\n`, name);
    }
    assert.deepEqual(
      readdirSync(join(repo, '.apex', 'work', 'tasks', RUN, 'context')).sort(),
      ['final-review.json', 'task-2-review-3.json'],
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('loop grammar admits only the dated run directory and closed Gear-4 artifact families', () => {
  for (const [family, path, type] of LOOP_FAMILIES) {
    const parsed = classifyWorkPath(path);
    assert.equal(parsed.type, type, family);
    assert.equal(parsed.family, family, family);
    assert.deepEqual(parseWorkPath(path, type, family), parsed, family);
  }

  const inLoop = (name, run = LOOP) => `.apex/work/loops/${run}/${name}`;
  const rejected = [
    inLoop('goal.MD'),
    inLoop('events.json'),
    inLoop('ledger.md.bak'),
    inLoop('branch-diff.txt~'),
    inLoop('evidence-report.md.old'),
    inLoop('review-report.md/notes.md'),
    inLoop('ownership.lock'),
    inLoop('notes.md'),
    inLoop(`nested/run-${UUID}-attempt-1.log`),
    inLoop(`run-${UUID}-attempt-0.log`),
    inLoop(`run-${UUID}-attempt-01.log`),
    inLoop(`run-${UUID}-attempt-1.jsonl`),
    inLoop(`run-${UUID}-attempt-01-diff.txt`),
    inLoop(`run-${UUID}-attempt-1-diff.md`),
    inLoop(`run-${UUID}-attempt-1-report.md.bak`),
    inLoop(`run-${UUID}-review-0-report.md`),
    inLoop(`run-${UUID}-review-01.raw.jsonl`),
    inLoop(`run-${UUID}-review-1.txt`),
    inLoop(`run-${UUID}-review-01-diff.txt`),
    inLoop(`run-${UUID}-review-1-diff.md`),
    inLoop('run-12345678123442348234123456789abc-attempt-1.log'),
    inLoop('run-12345678-1234-0234-8234-123456789abc-attempt-1.log'),
    inLoop('run-12345678-1234-4234-7234-123456789abc-attempt-1.log'),
    inLoop('run-12345678-1234-4234-8234-123456789ABC-attempt-1.log'),
    inLoop(`run-${UUID}-attempt-1-review-1.log`),
    inLoop('goal.md', 'demo-loop'),
    inLoop('goal.md', '2026-9-03-demo-loop'),
    inLoop('goal.md', '2026-09-03-Demo-loop'),
    inLoop('goal.md', '2026-09-03-demo_loop'),
    inLoop('goal.md', '2026-09-03--demo-loop'),
    inLoop('goal.md', '2026-02-30-demo-loop'),
  ];
  const repo = fixture();
  try {
    for (const path of rejected) {
      assert.throws(() => classifyWorkPath(path), /work path/u, path);
      assert.throws(() => writeWorkPath(repo, path, 'x'), /work path/u, path);
      assert.throws(() => openWorkPathFd(repo, path), /work path/u, path);
    }
    assert.deepEqual(readdirSync(repo), []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('atomic create-only publication leaves no partial target and refuses replacement', () => {
  const repo = fixture();
  const path = `.apex/work/tasks/${RUN}/task-1-execution-1-result.json`;
  try {
    assert.throws(() => writeWorkPath(repo, path, 'complete', { createOnly: true, onCheckpoint(event) {
      if (event.phase === 'before-publish') throw new Error('interrupted staging');
    } }), /interrupted staging/);
    assert.equal(existsSync(join(repo, path)), false);
    writeWorkPath(repo, path, 'complete', { createOnly: true });
    assert.throws(() => writeWorkPath(repo, path, 'replacement', { createOnly: true }), /already exists/);
    assert.equal(readWorkPath(repo, path, { encoding: 'utf8' }), 'complete');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('every loop family supports confined read, write, append, create-new, and atomic replacement', () => {
  const repo = fixture();
  try {
    for (const [family, path, type] of LOOP_FAMILIES) {
      writeWorkPath(repo, path, `${family}-one\n`, { expect: type, family });
      appendWorkPath(repo, path, `${family}-two\n`, { expect: type, family });
      assert.equal(
        readWorkPath(repo, path, { expect: type, family, encoding: 'utf8' }),
        `${family}-one\n${family}-two\n`,
        family,
      );
      writeWorkPath(repo, path, `${family}-replacement\n`, { expect: type, family });
      assert.equal(readWorkPath(repo, path, { family, encoding: 'utf8' }), `${family}-replacement\n`, family);

      const createPath = path.replace(`/loops/${LOOP}/`, '/loops/2026-09-04-create-new/');
      const fd = openWorkPathFd(repo, createPath, {
        expect: type,
        family,
        disposition: 'create-new',
      });
      writeSync(fd, 'created-new\n');
      fsyncSync(fd);
      closeSync(fd);
      assert.equal(readWorkPath(repo, createPath, { encoding: 'utf8' }), 'created-new\n', family);
      assert.throws(
        () => openWorkPathFd(repo, createPath, { disposition: 'create-new' }),
        /work artifact already exists/u,
        family,
      );
      assert.ok(lstatSync(join(repo, path)).isFile(), family);
    }
    assert.equal(snapshot(repo).some((entry) => entry.includes('steepy-work-')), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('every loop family rejects symlinked ancestors and targets without touching outside bytes', () => {
  const outer = fixture();
  try {
    for (const [family, path, type] of LOOP_FAMILIES) {
      const segments = path.split('/').slice(0, -1);
      const targetName = path.split('/').at(-1);
      for (let position = 0; position <= segments.length; position += 1) {
        const repo = join(outer, `${family}-${targetName}-${position}-repo`);
        const outside = join(outer, `${family}-${targetName}-${position}-outside`);
        mkdirSync(repo);
        mkdirSync(outside);
        const linkPath = position < segments.length
          ? join(repo, ...segments.slice(0, position + 1))
          : join(repo, ...segments, targetName);
        if (position < segments.length) {
          const mirror = join(outside, 'mirror');
          const mirrorTarget = join(mirror, ...segments.slice(position + 1), targetName);
          mkdirSync(dirname(mirrorTarget), { recursive: true });
          writeFileSync(mirrorTarget, 'outside sentinel\n');
          mkdirSync(join(repo, ...segments.slice(0, position)), { recursive: true });
          symlinkSync(mirror, linkPath, 'dir');
        } else {
          const sentinel = join(outside, 'sentinel');
          writeFileSync(sentinel, 'outside sentinel\n');
          mkdirSync(join(repo, ...segments), { recursive: true });
          symlinkSync(sentinel, linkPath, 'file');
        }
        const outsideBefore = snapshot(outside);
        for (const [operation, invoke] of Object.entries({
          read: () => readWorkPath(repo, path, { expect: type, family }),
          write: () => writeWorkPath(repo, path, 'inside\n', { expect: type, family }),
          append: () => appendWorkPath(repo, path, 'inside\n', { expect: type, family }),
          open: () => closeSync(openWorkPathFd(repo, path, { expect: type, family })),
          mkdir: () => mkdirWorkPath(repo, path, { expect: type, family }),
        })) {
          assert.throws(invoke, /work path: .*(symlink|escape|identity)/u, `${family} ${position} ${operation}`);
          assert.deepEqual(snapshot(outside), outsideBefore, `${family} ${position} ${operation}`);
        }
        assert.equal(lstatSync(linkPath).isSymbolicLink(), true, `${family} ${position}`);
      }
    }
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test('every loop family rejects hardlinks, directories, FIFOs, replaced identities, and escaped aliases', () => {
  const outer = fixture();
  try {
    for (const [family, path, type] of LOOP_FAMILIES) {
      const operations = (repo) => ({
        read: () => readWorkPath(repo, path, { expect: type, family }),
        write: () => writeWorkPath(repo, path, 'inside\n', { expect: type, family }),
        append: () => appendWorkPath(repo, path, 'inside\n', { expect: type, family }),
        open: () => closeSync(openWorkPathFd(repo, path, { expect: type, family })),
        mkdir: () => mkdirWorkPath(repo, path, { expect: type, family }),
      });

      const hardlinkRepo = join(outer, `${family}-hardlink-repo`);
      const hardlinkOutside = join(outer, `${family}-hardlink-sentinel`);
      mkdirSync(dirname(join(hardlinkRepo, path)), { recursive: true });
      writeFileSync(hardlinkOutside, 'outside sentinel\n');
      linkSync(hardlinkOutside, join(hardlinkRepo, path));
      for (const [name, operation] of Object.entries(operations(hardlinkRepo))) {
        assert.throws(operation, /work path: .*hard-linked target/u, `${family} hardlink ${name}`);
        assert.equal(readFileSync(hardlinkOutside, 'utf8'), 'outside sentinel\n', `${family} hardlink ${name}`);
      }

      const directoryRepo = join(outer, `${family}-directory-repo`);
      mkdirSync(join(directoryRepo, path), { recursive: true });
      for (const [name, operation] of Object.entries(operations(directoryRepo))) {
        assert.throws(operation, /work path: .*non-file target/u, `${family} directory ${name}`);
      }

      const fifoRepo = join(outer, `${family}-fifo-repo`);
      const fifoTarget = join(fifoRepo, path);
      mkdirSync(dirname(fifoTarget), { recursive: true });
      const fifo = spawnSync('mkfifo', [fifoTarget], { encoding: 'utf8' });
      assert.equal(fifo.status, 0, `${family}: mkfifo: ${fifo.stderr}`);
      for (const [name, operation] of Object.entries(operations(fifoRepo))) {
        assert.throws(operation, /work path: .*non-file target/u, `${family} fifo ${name}`);
      }

      const replacementRepo = join(outer, `${family}-replacement-repo`);
      const replacementTarget = join(replacementRepo, path);
      const replacementOutside = join(outer, `${family}-replacement-sentinel`);
      const replacedIdentity = join(outer, `${family}-replaced-identity`);
      mkdirSync(dirname(replacementTarget), { recursive: true });
      writeFileSync(replacementOutside, 'outside replacement\n');
      writeFileSync(replacementTarget, 'original identity\n');
      renameSync(replacementTarget, replacedIdentity);
      symlinkSync(replacementOutside, replacementTarget, 'file');
      for (const [name, operation] of Object.entries(operations(replacementRepo))) {
        assert.throws(operation, /work path: .*symlink target/u, `${family} replacement ${name}`);
        assert.equal(readFileSync(replacementOutside, 'utf8'), 'outside replacement\n', `${family} replacement ${name}`);
        assert.equal(readFileSync(replacedIdentity, 'utf8'), 'original identity\n', `${family} replacement ${name}`);
      }

      const escaped = `../${path}`;
      const escapedRepo = join(outer, `${family}-escaped-repo`);
      mkdirSync(escapedRepo);
      for (const operation of [
        () => readWorkPath(escapedRepo, escaped),
        () => writeWorkPath(escapedRepo, escaped, 'inside\n'),
        () => appendWorkPath(escapedRepo, escaped, 'inside\n'),
        () => openWorkPathFd(escapedRepo, escaped),
        () => mkdirWorkPath(escapedRepo, escaped),
      ]) {
        assert.throws(operation, /work path/u, `${family} escaped`);
      }
    }
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test('every loop family fails closed on post-bind target and ancestor identity races', () => {
  const outer = fixture();
  try {
    for (const [family, path, type] of LOOP_FAMILIES) {
      for (const operation of ['read', 'append']) {
        const repo = join(outer, `${family}-${operation}-race-repo`);
        const absolute = join(repo, path);
        const displaced = join(outer, `${family}-${operation}-race-displaced`);
        const outside = join(outer, `${family}-${operation}-race-outside`);
        mkdirSync(repo);
        writeWorkPath(repo, path, 'original identity\n', { expect: type, family });
        writeFileSync(outside, 'outside sentinel\n');
        const options = {
          expect: type,
          family,
          onCheckpoint({ phase }) {
            if (phase !== 'after-bind') return;
            renameSync(absolute, displaced);
            symlinkSync(outside, absolute, 'file');
          },
        };
        const invoke = operation === 'read'
          ? () => readWorkPath(repo, path, options)
          : () => appendWorkPath(repo, path, 'untrusted append\n', options);
        assert.throws(invoke, /work path: .*(identity|symlink)/u, `${family} ${operation}`);
        assert.equal(readFileSync(outside, 'utf8'), 'outside sentinel\n', `${family} ${operation} outside`);
        assert.equal(readFileSync(displaced, 'utf8'), 'original identity\n', `${family} ${operation} original`);
      }

      const createPath = path.replace(`/loops/${LOOP}/`, `/loops/2026-09-04-${family}-create-race/`);
      const createRepo = join(outer, `${family}-create-race-repo`);
      const createTarget = join(createRepo, createPath);
      const createParent = dirname(createTarget);
      const createDisplaced = join(outer, `${family}-create-race-displaced`);
      const createOutside = join(outer, `${family}-create-race-outside`);
      mkdirSync(createParent, { recursive: true });
      mkdirSync(createOutside);
      assert.throws(
        () => {
          let fd;
          try {
            fd = openWorkPathFd(createRepo, createPath, {
              expect: type,
              family,
              disposition: 'create-new',
              onCheckpoint({ phase }) {
                if (phase !== 'after-bind') return;
                renameSync(createParent, createDisplaced);
                symlinkSync(createOutside, createParent, 'dir');
              },
            });
          } finally {
            if (fd !== undefined) closeSync(fd);
          }
        },
        /work path: .*(identity|symlink)/u,
        `${family} create-new ancestor`,
      );
      assert.deepEqual(readdirSync(createOutside), [], `${family} create-new outside`);
      assert.deepEqual(readdirSync(createDisplaced), [], `${family} create-new original`);

      const ancestorRepo = join(outer, `${family}-write-ancestor-race-repo`);
      const ancestorTarget = join(ancestorRepo, path);
      const ancestorParent = dirname(ancestorTarget);
      const ancestorDisplaced = join(outer, `${family}-write-ancestor-race-displaced`);
      const ancestorOutside = join(outer, `${family}-write-ancestor-race-outside`);
      mkdirSync(ancestorRepo);
      writeWorkPath(ancestorRepo, path, 'original identity\n', { expect: type, family });
      mkdirSync(ancestorOutside);
      writeFileSync(join(ancestorOutside, basename(ancestorTarget)), 'outside sentinel\n');
      assert.throws(
        () => writeWorkPath(ancestorRepo, path, 'untrusted replacement\n', {
          expect: type,
          family,
          onCheckpoint({ phase }) {
            if (phase !== 'after-bind') return;
            renameSync(ancestorParent, ancestorDisplaced);
            symlinkSync(ancestorOutside, ancestorParent, 'dir');
          },
        }),
        /work path: .*(identity|symlink)/u,
        `${family} atomic replace ancestor`,
      );
      assert.equal(
        readFileSync(join(ancestorOutside, basename(ancestorTarget)), 'utf8'),
        'outside sentinel\n',
        `${family} atomic replace ancestor outside`,
      );
      assert.equal(
        readFileSync(join(ancestorDisplaced, basename(ancestorTarget)), 'utf8'),
        'original identity\n',
        `${family} atomic replace ancestor original`,
      );

      const publishRepo = join(outer, `${family}-publish-race-repo`);
      const publishTarget = join(publishRepo, path);
      const publishDisplaced = join(outer, `${family}-publish-race-displaced`);
      const publishOutside = join(outer, `${family}-publish-race-outside`);
      mkdirSync(publishRepo);
      writeWorkPath(publishRepo, path, 'original identity\n', { expect: type, family });
      writeFileSync(publishOutside, 'outside sentinel\n');
      assert.throws(
        () => writeWorkPath(publishRepo, path, 'untrusted replacement\n', {
          expect: type,
          family,
          onCheckpoint({ phase }) {
            if (phase !== 'before-publish') return;
            renameSync(publishTarget, publishDisplaced);
            symlinkSync(publishOutside, publishTarget, 'file');
          },
        }),
        /work path: .*(identity|symlink)/u,
        `${family} atomic publish target`,
      );
      assert.equal(readFileSync(publishOutside, 'utf8'), 'outside sentinel\n', `${family} publish outside`);
      assert.equal(readFileSync(publishDisplaced, 'utf8'), 'original identity\n', `${family} publish original`);
      assert.equal(
        readdirSync(dirname(publishTarget)).some((entry) => entry.includes('steepy-work-')),
        false,
        `${family} publish temp residue`,
      );
    }
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test('confined primitives round-trip every canonical family as ordinary files', () => {
  const repo = fixture();
  try {
    for (const [family, path, type] of FAMILIES) {
      mkdirWorkPath(repo, path, { expect: type, family });
      writeWorkPath(repo, path, `${family}-one\n`, { expect: type, family });
      assert.equal(readWorkPath(repo, path, { expect: type, family, encoding: 'utf8' }), `${family}-one\n`, family);
      assert.ok(readWorkPath(repo, path, { expect: type, family }) instanceof Buffer, family);
      appendWorkPath(repo, path, `${family}-two\n`, { expect: type, family });
      assert.equal(readWorkPath(repo, path, { family, encoding: 'utf8' }), `${family}-one\n${family}-two\n`, family);
      writeWorkPath(repo, path, `${family}-three\n`, { family });
      assert.equal(readWorkPath(repo, path, { family, encoding: 'utf8' }), `${family}-three\n`, family);
      assert.ok(lstatSync(join(repo, path)).isFile(), family);
    }
    const created = `.apex/work/tasks/${RUN}-second/autopilot-status.md`;
    writeWorkPath(repo, created, 'created without prior mkdir\n');
    assert.equal(readWorkPath(repo, created, { encoding: 'utf8' }), 'created without prior mkdir\n');
    assert.equal(mkdirWorkPath(repo, `.apex/work/tasks/${RUN}-second/context/phase-1-attempt-2.json`).created, true);
    assert.equal(mkdirWorkPath(repo, created).created, false);
    assert.equal(snapshot(repo).some((entry) => entry.includes('steepy-work-')), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('hard-linked work targets fail closed without reading or changing the shared outside inode', () => {
  const outer = fixture();
  const repo = join(outer, 'repo');
  const outside = join(outer, 'outside-sentinel.md');
  const path = `.apex/work/tasks/${RUN}/autopilot-status.md`;
  try {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(outside, 'outside sentinel\n');
    linkSync(outside, join(repo, path));
    const before = readFileSync(outside, 'utf8');
    for (const [name, operation] of Object.entries({
      read: () => readWorkPath(repo, path),
      write: () => writeWorkPath(repo, path, 'inside bytes\n'),
      append: () => appendWorkPath(repo, path, 'inside bytes\n'),
      open: () => closeSync(openWorkPathFd(repo, path, {
        expect: 'work-output', family: 'status', disposition: 'append',
      })),
      mkdir: () => mkdirWorkPath(repo, path),
    })) {
      assert.throws(operation, /work path: .*hard-linked target/u, name);
      assert.equal(readFileSync(outside, 'utf8'), before, `${name}: outside inode must stay untouched`);
    }
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test('atomic replacement preserves an existing mode of 000 instead of widening it to 0644', () => {
  const repo = fixture();
  const path = `.apex/work/tasks/${RUN}/autopilot-status.md`;
  const absolute = join(repo, path);
  try {
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, 'old\n');
    chmodSync(absolute, 0o000);
    writeWorkPath(repo, path, 'new\n', { expect: 'work-output', family: 'status' });
    assert.equal(lstatSync(absolute).mode & 0o777, 0o000);
    chmodSync(absolute, 0o600);
    assert.equal(readFileSync(absolute, 'utf8'), 'new\n');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('negative symlink matrix: selected path families fail closed at every ancestor and target with zero outside bytes', () => {
  const outer = fixture();
  try {
    for (const [family, path] of FAMILIES) {
      if (!SYMLINK_FAMILIES.includes(family)) continue;
      const segments = path.split('/').slice(0, -1);
      const targetName = path.split('/').at(-1);
      for (let position = 0; position <= segments.length; position += 1) {
        const label = `${family} position ${position}`;
        const repo = join(outer, `${family}-${targetName}-${position}-repo`);
        const outside = join(outer, `${family}-${targetName}-${position}-outside`);
        mkdirSync(repo);
        mkdirSync(outside);
        const linkPath = position < segments.length
          ? join(repo, ...segments.slice(0, position + 1))
          : join(repo, ...segments, targetName);
        if (position < segments.length) {
          const mirror = join(outside, 'mirror');
          const mirrorTarget = join(mirror, ...segments.slice(position + 1), targetName);
          mkdirSync(dirname(mirrorTarget), { recursive: true });
          writeFileSync(mirrorTarget, 'outside sentinel\n');
          mkdirSync(join(repo, ...segments.slice(0, position)), { recursive: true });
          symlinkSync(mirror, linkPath, 'dir');
        } else {
          const sentinel = join(outside, 'sentinel.md');
          writeFileSync(sentinel, 'outside sentinel\n');
          mkdirSync(join(repo, ...segments), { recursive: true });
          symlinkSync(sentinel, linkPath, 'file');
        }
        const outsideBefore = snapshot(outside);
        const operations = {
          read: () => readWorkPath(repo, path),
          write: () => writeWorkPath(repo, path, 'inside bytes\n'),
          append: () => appendWorkPath(repo, path, 'inside bytes\n'),
          mkdir: () => mkdirWorkPath(repo, path),
        };
        for (const [name, operation] of Object.entries(operations)) {
          assert.throws(operation, /work path: .*(symlink|escape|non-directory|non-file|identity)/u, `${label} ${name}`);
          assert.deepEqual(snapshot(outside), outsideBefore, `${label} ${name} outside untouched`);
          assert.equal(snapshot(repo).some((entry) => entry.includes('steepy-work-')), false, `${label} ${name} no temp residue`);
        }
        assert.equal(lstatSync(linkPath).isSymbolicLink(), true, `${label} symlink preserved`);
      }
    }
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test('reads and appends fail closed on missing or non-ordinary targets and an unresolvable repository root', () => {
  const repo = fixture();
  try {
    const status = `.apex/work/tasks/${RUN}/autopilot-status.md`;
    assert.throws(() => readWorkPath(repo, status), /work path: .*missing/u);
    assert.throws(() => appendWorkPath(repo, status, 'x'), /work path: .*missing/u);
    writeWorkPath(repo, status, 'seed\n');
    appendWorkPath(repo, status, 'more\n');
    assert.equal(readWorkPath(repo, status, { encoding: 'utf8' }), 'seed\nmore\n');
    const diff = `.apex/work/tasks/${RUN}/branch-diff.txt`;
    mkdirSync(join(repo, diff), { recursive: true });
    assert.throws(() => readWorkPath(repo, diff), /work path: .*non-file/u);
    assert.throws(() => writeWorkPath(repo, diff, 'x'), /work path: .*non-file/u);
    assert.throws(() => appendWorkPath(repo, diff, 'x'), /work path: .*non-file/u);
    assert.throws(() => mkdirWorkPath(repo, diff), /work path: .*non-file/u);
    assert.throws(() => readWorkPath(join(repo, 'not-a-repo'), status), /work path: .*repository root/u);
    assert.equal(snapshot(repo).some((entry) => entry.includes('steepy-work-')), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

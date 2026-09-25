import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import {
  cpSync, existsSync, linkSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  buildFinalReviewManifest,
  buildFixManifest,
  buildImplementManifest,
  buildImplementerManifest,
  buildPhaseManifest,
  buildPlanManifest,
  buildReviewManifest,
  buildTaskManifest,
  buildTaskReviewerManifest,
  deriveImplicatedStandardPaths,
  manifestReferencePrompt,
  materializeSuccessCriteria,
  parseSuccessCriteria,
  planPhaseContext,
  reviewPhaseContext,
  specPhaseContext,
  standardsBySurfaceFromRouting,
  validateContextManifest,
  writeContextManifest,
} from '../scripts/autopilot-context.mjs';
import { phasePrompt } from '../scripts/autopilot.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, '..', 'scripts', 'autopilot-context.mjs');
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'autopilot-context', 'scenario.json'), 'utf8'));
const modularFixtureRoot = join(here, 'fixtures', 'modular-hub');

function seedFixture(repoRoot) {
  for (const [path, contents] of Object.entries(fixture.files)) {
    const absolute = join(repoRoot, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
}

function materialize(t) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'steepy-context-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  seedFixture(repoRoot);
  return repoRoot;
}

const base = {
  runId: 'run-2026-08-13',
  modelTier: 'most-capable',
  testCommand: 'npm test',
  criterionIds: ['SC3', 'SC5'],
  outputs: ['.apex/work/tasks/context-efficient/task-1-report.md'],
};

test('implementer manifest records bytes, preserves order, and keeps upstream artifacts non-eager', (t) => {
  const repoRoot = materialize(t);
  const manifest = buildImplementerManifest({
    ...base,
    repoRoot,
    task: 1,
    briefPath: '.apex/work/tasks/context-efficient/task-1-brief.md',
    standardPath: '.apex/standards/scripts.md',
    planPath: '.apex/work/plans/context-efficient.md',
    specPath: '.apex/work/specs/context-efficient.md',
    hubIndexPath: '.apex/_INDEX.md',
  });

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.scope.role, 'implementer');
  assert.deepEqual(manifest.required.map(({ path }) => path), [
    '.apex/work/tasks/context-efficient/task-1-brief.md',
    '.apex/standards/scripts.md',
  ]);
  assert.deepEqual(manifest.required.map(({ bytes }) => bytes), [
    statSync(join(repoRoot, '.apex/work/tasks/context-efficient/task-1-brief.md')).size,
    statSync(join(repoRoot, '.apex/standards/scripts.md')).size,
  ]);
  assert.deepEqual(manifest.onDemand.map(({ path }) => path), [
    '.apex/work/plans/context-efficient.md',
    '.apex/work/specs/context-efficient.md',
    '.apex/_INDEX.md',
  ]);
  assert.ok(!JSON.stringify(manifest).includes('Node built-ins only'));
});

test('validator rejects traversal, absolute paths, unknown roles, and missing required inputs', (t) => {
  const repoRoot = materialize(t);
  const valid = buildImplementerManifest({
    ...base, repoRoot, task: 1,
    briefPath: '.apex/work/tasks/context-efficient/task-1-brief.md',
    standardPath: '.apex/standards/scripts.md',
  });

  assert.throws(
    () => validateContextManifest({ ...valid, outputs: ['../escape.md'] }, { repoRoot }),
    /unsafe output path/,
  );
  assert.throws(
    () => validateContextManifest({ ...valid, required: [{ ...valid.required[0], path: '/etc/passwd' }] }, { repoRoot }),
    /unsafe required path/,
  );
  assert.throws(
    () => validateContextManifest({ ...valid, scope: { ...valid.scope, role: 'oracle' } }, { repoRoot }),
    /unknown context role/,
  );
  assert.throws(
    () => buildImplementerManifest({ ...base, repoRoot, task: 1, briefPath: 'missing.md', standardPath: '.apex/standards/scripts.md' }),
    /required input does not exist/,
  );
});

test('validator enforces a closed schema and compatible phase, role, and task scope', (t) => {
  const repoRoot = materialize(t);
  const valid = buildImplementerManifest({
    ...base, repoRoot, task: 1,
    briefPath: '.apex/work/tasks/context-efficient/task-1-brief.md',
    standardPath: '.apex/standards/scripts.md',
  });

  assert.throws(
    () => validateContextManifest({ ...valid, artifactBody: 'copied artifact' }, { repoRoot }),
    /unexpected manifest property 'artifactBody'/,
  );
  assert.throws(
    () => validateContextManifest({ ...valid, scope: { ...valid.scope, invented: 'value' } }, { repoRoot }),
    /unexpected scope property 'invented'/,
  );
  assert.throws(
    () => validateContextManifest({
      ...valid,
      required: [{ ...valid.required[0], contents: 'copied input' }, valid.required[1]],
    }, { repoRoot }),
    /unexpected required\[0\] property 'contents'/,
  );
  assert.throws(
    () => validateContextManifest({ ...valid, scope: { ...valid.scope, phase: 'plan' } }, { repoRoot }),
    /role 'implementer' requires phase 'implement'/,
  );
  assert.throws(
    () => validateContextManifest({ ...valid, scope: { phase: 'implement', role: 'implement', task: 1 } }, { repoRoot }),
    /phase role 'implement' must not declare a task|unexpected scope property 'task'/,
  );

  const callerOwned = structuredClone(valid);
  const normalized = validateContextManifest(callerOwned, { repoRoot });
  assert.notEqual(normalized, callerOwned);
  assert.notEqual(normalized.scope, callerOwned.scope);
  assert.notEqual(normalized.required[0], callerOwned.required[0]);
  assert.deepEqual(normalized, callerOwned);
});

test('writer produces byte-identical JSON for identical inputs', (t) => {
  const repoRoot = materialize(t);
  const input = {
    ...base, repoRoot, task: 1,
    briefPath: '.apex/work/tasks/context-efficient/task-1-brief.md',
    standardPath: '.apex/standards/scripts.md',
  };
  const first = buildTaskManifest('implementer', input);
  const second = buildTaskManifest('implementer', input);
  writeContextManifest(first, { repoRoot, manifestPath: '.apex/work/tasks/context-efficient/context/phase-plan-attempt-1.json' });
  writeContextManifest(second, { repoRoot, manifestPath: '.apex/work/tasks/context-efficient/context/phase-plan-attempt-2.json' });
  assert.deepEqual(first, second);
  assert.equal(
    readFileSync(join(repoRoot, '.apex/work/tasks/context-efficient/context/phase-plan-attempt-1.json'), 'utf8'),
    readFileSync(join(repoRoot, '.apex/work/tasks/context-efficient/context/phase-plan-attempt-2.json'), 'utf8'),
  );
});

test('manifest writes pin the typed manifest family and reject conveniences, aliases, and wrong types', (t) => {
  const repoRoot = materialize(t);
  const manifest = buildTaskManifest('implementer', {
    ...base, repoRoot, task: 1,
    briefPath: '.apex/work/tasks/context-efficient/task-1-brief.md',
    standardPath: '.apex/standards/scripts.md',
  });
  const ctx = (name) => `.apex/work/tasks/context-efficient/context/${name}`;
  for (const name of [
    'phase-plan-attempt-1.json',
    'phase-implement-attempt-2.json',
    'phase-review-attempt-3.json',
    'phase-4-attempt-1.json',
    'task-1-implement.json',
    'task-1-review.json',
    'task-1-fix.json',
    'task-2-implement-1.json',
    'task-2-review-4.json',
    'final-review.json',
  ]) {
    const result = writeContextManifest(manifest, { repoRoot, manifestPath: ctx(name) });
    assert.equal(result.path, ctx(name), name);
    assert.equal(JSON.parse(readFileSync(join(repoRoot, ctx(name)), 'utf8')).scope.role, 'implementer', name);
  }
  for (const name of [
    'first.json',
    'notes.json',
    'phase-deploy-attempt-1.json',
    'phase-01-attempt-1.json',
    'phase-plan-attempt-01.json',
    'phase-plan-attempt-0.json',
    'task-0-implement.json',
    'task-1-implementer.json',
    'task-1-implement-0.json',
    'final-review.json.bak',
    'phase-1-attempt-1.raw.jsonl',
  ]) {
    assert.throws(() => writeContextManifest(manifest, { repoRoot, manifestPath: ctx(name) }), /work path/u, name);
    assert.equal(existsSync(join(repoRoot, ctx(name))), false, `${name} must not partially write`);
  }
  for (const [manifestPath, reason] of [
    [`./${ctx('phase-plan-attempt-1.json')}`, /work path/u],
    ['.apex//work/tasks/context-efficient/context/phase-plan-attempt-1.json', /work path/u],
    [`${ctx('phase-plan-attempt-1.json')}/`, /work path/u],
    [`/${ctx('phase-plan-attempt-1.json')}`, /unsafe manifest path/u],
    ['.apex/work/tasks/context-efficient/context/../context/phase-plan-attempt-1.json', /unsafe manifest path/u],
    ['.apex/work/tasks/context-efficient/autopilot-status.md', /this call site expects manifest/u],
    ['.apex/work/specs/context-efficient.md', /this call site expects work-output/u],
  ]) {
    assert.throws(() => writeContextManifest(manifest, { repoRoot, manifestPath }), reason, manifestPath);
  }
});

test('task role builders expose exactly the approved eager inventories', (t) => {
  const repoRoot = materialize(t);
  const common = { ...base, repoRoot, task: 1 };
  const briefPath = '.apex/work/tasks/context-efficient/task-1-brief.md';
  const standardPath = '.apex/standards/scripts.md';
  const reportPath = '.apex/work/tasks/context-efficient/task-1-report.md';
  const taskDiffPath = '.apex/work/tasks/context-efficient/task-1.diff';
  const issuePath = '.apex/work/tasks/context-efficient/task-1-review.md';
  const standardPaths = [standardPath, '.apex/standards/adapters.md'];

  const reviewer = buildTaskReviewerManifest({ ...common, briefPath, reportPath, taskDiffPath, standardPaths, hubIndexPath: '.apex/_INDEX.md' });
  assert.deepEqual(reviewer.required.map((item) => item.path), [briefPath, reportPath, taskDiffPath, ...standardPaths]);
  assert.deepEqual(reviewer.onDemand.map((item) => item.path), ['.apex/_INDEX.md']);

  const fix = buildFixManifest({ ...common, briefPath, issuePath, taskDiffPath, standardPaths });
  assert.deepEqual(fix.required.map((item) => item.path), [briefPath, issuePath, taskDiffPath, ...standardPaths]);
  assert.throws(
    () => buildImplementerManifest({ ...common, briefPath, standardPaths: [standardPath, standardPath] }),
    /duplicate standard path/i,
  );

  const finalReview = buildFinalReviewManifest({
    ...base, repoRoot,
    criteriaPath: '.apex/work/tasks/context-efficient/success-criteria.md',
    taskResultIndexPath: '.apex/work/tasks/context-efficient/task-result-index.md',
    branchDiffPath: '.apex/work/tasks/context-efficient/branch-diff.txt',
    standardPaths: ['.apex/standards/scripts.md', '.apex/standards/adapters.md'],
  });
  assert.deepEqual(finalReview.required.map((item) => item.path), [
    '.apex/work/tasks/context-efficient/success-criteria.md',
    '.apex/work/tasks/context-efficient/task-result-index.md',
    '.apex/work/tasks/context-efficient/branch-diff.txt',
    '.apex/standards/scripts.md',
    '.apex/standards/adapters.md',
  ]);
  assert.throws(() => buildFinalReviewManifest({
    ...base, repoRoot,
    criteriaPath: '.apex/work/specs/context-efficient.md',
    taskResultIndexPath: '.apex/work/tasks/context-efficient/task-result-index.md',
    branchDiffPath: '.apex/work/tasks/context-efficient/branch-diff.txt',
    standardPaths: [],
  }), /final-review requires at least one relevant standard/);
  assert.throws(() => buildFinalReviewManifest({
    ...base, repoRoot,
    criteriaPath: '.apex/work/specs/context-efficient.md',
    taskResultIndexPath: '.apex/work/tasks/context-efficient/task-result-index.md',
    branchDiffPath: '.apex/work/tasks/context-efficient/branch-diff.txt',
    standardPaths: ['.apex/standards/scripts.md'],
  }), /criteria-only artifact.*is a spec path/i);

  const validReview = buildFinalReviewManifest({
    ...base, repoRoot,
    criteriaPath: '.apex/work/tasks/context-efficient/success-criteria.md',
    taskResultIndexPath: '.apex/work/tasks/context-efficient/task-result-index.md',
    branchDiffPath: '.apex/work/tasks/context-efficient/branch-diff.txt',
    standardPaths: ['.apex/standards/scripts.md'],
  });
  const specStat = statSync(join(repoRoot, '.apex/work/specs/context-efficient.md'));
  assert.throws(() => validateContextManifest({
    ...validReview,
    required: validReview.required.map((entry) => entry.purpose === 'success-criteria source'
      ? { ...entry, path: '.apex/work/specs/context-efficient.md', bytes: specStat.size }
      : entry),
  }, { repoRoot }), /criteria-only artifact.*is a spec path/i);
});

test('criteria materializer writes deterministic attributed criteria-only bytes', (t) => {
  const repoRoot = materialize(t);
  const specPath = '.apex/work/specs/sequential-criteria.md';
  writeFileSync(join(repoRoot, specPath), [
    '# Context-efficient autopilot',
    '',
    'Owning surface: scripts',
    '',
    '## Success criteria',
    '',
    '- SC1: role inventories retain required facts.',
    '- SC2: comparative prompt footprints shrink.',
    '',
  ].join('\n'));
  const outputPath = '.apex/work/tasks/context-efficient/success-criteria.md';
  const first = materializeSuccessCriteria({
    repoRoot,
    specPath,
    outputPath,
  });
  const firstText = readFileSync(join(repoRoot, outputPath), 'utf8');
  const second = materializeSuccessCriteria({
    repoRoot,
    specPath,
    outputPath,
  });
  assert.equal(firstText, readFileSync(join(repoRoot, outputPath), 'utf8'));
  assert.equal(first.path, outputPath);
  assert.equal(first.bytes, second.bytes);
  assert.match(firstText, /Source: `\.apex\/work\/specs\/sequential-criteria\.md`/);
  assert.match(firstText, /Heading: `## Success criteria`/);
  assert.match(firstText, /SC1: role inventories retain required facts/);
  assert.match(firstText, /SC2: comparative prompt footprints shrink/);
  assert.doesNotMatch(firstText, /Owning surface|Cross-cutting surfaces/);
});

test('criteria paths ride the typed grammar: aliases and wrong-type forms fail closed at both call sites', (t) => {
  const repoRoot = materialize(t);
  const specPath = '.apex/work/specs/sequential-criteria.md';
  writeFileSync(join(repoRoot, specPath), [
    '# Sequential fixture',
    '',
    '## Success criteria',
    '',
    '- SC1: first.',
    '- SC2: second.',
    '',
  ].join('\n'));
  const canonical = '.apex/work/tasks/context-efficient/success-criteria.md';
  const finalReview = (criteriaPath) => buildFinalReviewManifest({
    ...base, repoRoot,
    criteriaPath,
    taskResultIndexPath: '.apex/work/tasks/context-efficient/task-result-index.md',
    branchDiffPath: '.apex/work/tasks/context-efficient/branch-diff.txt',
    standardPaths: ['.apex/standards/scripts.md'],
  });
  assert.equal(finalReview(canonical).required[0].path, canonical);
  for (const criteriaPath of [
    `./${canonical}`,
    '.apex//work/tasks/context-efficient/success-criteria.md',
    '.apex/work//tasks/context-efficient/success-criteria.md',
    `${canonical}/`,
    '.apex/work/tasks/context-efficient/./success-criteria.md',
    '.apex/work/specs/sequential-criteria.md',
    '.apex/work/plans/context-efficient.md',
    '.apex/work/tasks/context-efficient/autopilot-status.md',
    '.apex/work/tasks/context-efficient/branch-diff.txt',
    '.apex/work/tasks/context-efficient/task-result-index.md',
    '.apex/work/tasks/context-efficient/context/task-1-implement.json',
    '.apex/work/tasks/context-efficient/ledger.md',
    '.apex/standards/scripts.md',
    'scripts/autopilot-context.mjs',
  ]) {
    assert.throws(() => finalReview(criteriaPath), /criteria-only artifact/u, criteriaPath);
    assert.throws(
      () => materializeSuccessCriteria({ repoRoot, specPath, outputPath: criteriaPath }),
      /criteria-only artifact/u,
      criteriaPath,
    );
  }
  for (const [criteriaPath, reason] of [
    [`/${canonical}`, /unsafe review criteria path/u],
    ['.apex/work/tasks/../tasks/context-efficient/success-criteria.md', /unsafe review criteria path/u],
  ]) {
    assert.throws(() => finalReview(criteriaPath), reason, criteriaPath);
  }
  for (const [source, reason] of [
    ['.apex/work/tasks/context-efficient/success-criteria.md', /criteria source must be a canonical spec under/u],
    ['.apex/work/plans/context-efficient.md', /criteria source must be a canonical spec under/u],
    ['./.apex/work/specs/sequential-criteria.md', /criteria source must be a canonical spec under/u],
    ['.apex/work/specs/nested/sequential-criteria.md', /criteria source must be a canonical spec under/u],
    ['scripts/autopilot-context.mjs', /criteria source must be a canonical spec under/u],
  ]) {
    assert.throws(
      () => materializeSuccessCriteria({ repoRoot, specPath: source, outputPath: canonical }),
      reason,
      source,
    );
  }
});

test('symlinked criteria, manifest, and spec-source targets and ancestors fail closed with the outside sentinel untouched', (t) => {
  const outer = mkdtempSync(join(tmpdir(), 'steepy-context-confine-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const sequentialSpecContents = [
    '# Sequential fixture',
    '',
    '## Success criteria',
    '',
    '- SC1: first.',
    '- SC2: second.',
    '',
  ].join('\n');
  const scenarios = [
    {
      family: 'criteria',
      path: '.apex/work/tasks/confine-run/success-criteria.md',
      positions: [2, 3, 4],
      seed: (repoRoot) => {
        mkdirSync(join(repoRoot, '.apex', 'work', 'specs'), { recursive: true });
        writeFileSync(join(repoRoot, '.apex/work/specs/sequential-criteria.md'), sequentialSpecContents);
      },
      write: (repoRoot) => materializeSuccessCriteria({
        repoRoot,
        specPath: '.apex/work/specs/sequential-criteria.md',
        outputPath: '.apex/work/tasks/confine-run/success-criteria.md',
      }),
    },
    {
      family: 'manifest',
      path: '.apex/work/tasks/confine-run/context/phase-plan-attempt-1.json',
      positions: [3, 4, 5],
      seed: seedFixture,
      write: (repoRoot) => writeContextManifest(buildTaskManifest('implementer', {
        ...base, repoRoot, task: 1,
        briefPath: '.apex/work/tasks/context-efficient/task-1-brief.md',
        standardPath: '.apex/standards/scripts.md',
      }), { repoRoot, manifestPath: '.apex/work/tasks/confine-run/context/phase-plan-attempt-1.json' }),
    },
    {
      family: 'spec-source',
      path: '.apex/work/specs/sequential-criteria.md',
      positions: [2, 3],
      seed: (repoRoot) => {
        mkdirSync(join(repoRoot, '.apex', 'work'), { recursive: true });
      },
      write: (repoRoot) => materializeSuccessCriteria({
        repoRoot,
        specPath: '.apex/work/specs/sequential-criteria.md',
        outputPath: '.apex/work/tasks/confine-run/success-criteria.md',
      }),
    },
  ];
  for (const scenario of scenarios) {
    const segments = scenario.path.split('/').slice(0, -1);
    const targetName = scenario.path.split('/').at(-1);
    for (const position of scenario.positions) {
      const label = `${scenario.family} position ${position}`;
      const repo = join(outer, `${scenario.family}-${position}-repo`);
      const outside = join(outer, `${scenario.family}-${position}-outside`);
      mkdirSync(repo);
      mkdirSync(outside);
      scenario.seed(repo);
      let sentinelPath;
      const linkPath = position < segments.length
        ? join(repo, ...segments.slice(0, position + 1))
        : join(repo, ...segments, targetName);
      if (position < segments.length) {
        const mirror = join(outside, 'mirror');
        sentinelPath = join(mirror, ...segments.slice(position + 1), targetName);
        mkdirSync(dirname(sentinelPath), { recursive: true });
        writeFileSync(sentinelPath, 'outside sentinel\n');
        mkdirSync(join(repo, ...segments.slice(0, position)), { recursive: true });
        symlinkSync(mirror, linkPath, 'dir');
      } else {
        sentinelPath = join(outside, 'sentinel.md');
        writeFileSync(sentinelPath, 'outside sentinel\n');
        mkdirSync(join(repo, ...segments), { recursive: true });
        symlinkSync(sentinelPath, linkPath, 'file');
      }
      const before = readdirSync(repo, { recursive: true }).sort();
      assert.throws(() => scenario.write(repo), /work path: .*(symlink|escape|non-directory|non-file|identity)/u, label);
      assert.equal(readFileSync(sentinelPath, 'utf8'), 'outside sentinel\n', `${label} outside sentinel untouched`);
      assert.equal(lstatSync(linkPath).isSymbolicLink(), true, `${label} symlink preserved`);
      assert.deepEqual(readdirSync(repo, { recursive: true }).sort(), before, `${label} no partial write inside the repo`);
      assert.equal(before.some((entry) => entry.includes('steepy-work-')), false, `${label} no temp residue`);
    }
  }
});

test('the exported success-criteria parser pins the shared strict grammar', () => {
  assert.deepEqual(parseSuccessCriteria('SC4'), { criterionIds: ['SC4'] });
  assert.deepEqual(parseSuccessCriteria('**SC1**, `SC2` prose').criterionIds, ['SC1', 'SC2']);
  assert.deepEqual(parseSuccessCriteria('SC1, SC3').criterionIds, ['SC1', 'SC3']);
  const section = parseSuccessCriteria('# Spec\n\n## Success criteria\n\n- SC1: a\n- SC2: b\n', { section: true, label: 'criteria source' });
  assert.deepEqual(section.criterionIds, ['SC1', 'SC2']);
  assert.equal(section.heading, '## Success criteria');
  assert.equal(section.section, '## Success criteria\n\n- SC1: a\n- SC2: b');
  assert.throws(() => parseSuccessCriteria('SC3, SC2'), /strictly increasing.*SC3.*SC2/i);
  const hugeHigh = `SC${'9'.repeat(400)}`;
  const hugeLow = `SC${'8'.repeat(400)}`;
  assert.throws(() => parseSuccessCriteria(`${hugeHigh}, ${hugeLow}`), /strictly increasing/i);
  assert.throws(() => parseSuccessCriteria('## Success criteria\n\n- SC2: only\n', { section: true }), /must start at SC1/i);
  assert.throws(() => parseSuccessCriteria('none', { section: true, label: 'criteria source' }), /exactly one '## Success criteria' heading; found 0/i);
});

test('the SC negative matrix keeps spec sequencing strict while task mappings may skip IDs', (t) => {
  const repoRoot = materialize(t);
  const specPath = '.apex/work/specs/sc-matrix.md';
  const outputPath = '.apex/work/tasks/sc-matrix-run/success-criteria.md';
  for (const [label, criteriaField, criteriaSection, reason] of [
    ['missing', 'none', '- Deliver every criterion.', /missing success-criterion IDs/i],
    ['duplicate', 'SC1, SC1', '- SC1: first\n- SC1: repeated', /duplicate success-criterion ID 'SC1'/i],
    ['out-of-order', 'SC2, SC1', '- SC2: second\n- SC1: first', /strictly (?:sequential|increasing)/i],
    ['leading zero', 'SC01', '- SC01: zero padded', /'SC01'.*no leading zeros/i],
  ]) {
    const fixture = `# Fixture\n\n## Task 1 — probe\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Success criteria:** ${criteriaField}\n\n## Success criteria\n\n${criteriaSection}\n`;
    assert.throws(() => planPhaseContext(fixture), reason, `${label} must fail the plan-side parse`);
    writeFileSync(join(repoRoot, specPath), fixture);
    assert.throws(
      () => materializeSuccessCriteria({ repoRoot, specPath, outputPath }),
      reason,
      `${label} must fail the spec-side parse`,
    );
    assert.equal(existsSync(join(repoRoot, outputPath)), false, `${label} must not partially write`);
  }
  const gapFixture = '# Fixture\n\n## Task 1 — probe\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Success criteria:** SC1, SC3\n\n## Success criteria\n\n- SC1: first\n- SC3: third\n';
  assert.deepEqual(planPhaseContext(gapFixture).criterionIds, ['SC1', 'SC3']);
  writeFileSync(join(repoRoot, specPath), gapFixture);
  assert.throws(
    () => materializeSuccessCriteria({ repoRoot, specPath, outputPath }),
    /strictly sequential.*SC1.*SC3/i,
  );
  assert.equal(existsSync(join(repoRoot, outputPath)), false);
  const secondHeading = '# Fixture\n\n## Success criteria\n\n- SC1: first\n\n## Success criteria\n\n- SC1: repeated\n';
  assert.throws(() => planPhaseContext(secondHeading), /no Task headings/i);
  writeFileSync(join(repoRoot, specPath), secondHeading);
  assert.throws(
    () => materializeSuccessCriteria({ repoRoot, specPath, outputPath }),
    /exactly one '## Success criteria' heading; found 2/i,
  );
});

test('markdown routing accepts canonical emphasis and rejects unsupported field aliases', () => {
  const spec = [
    '- **Owning surface**: scripts',
    '- **Cross-cutting surfaces:** `adapters`, prose',
    '- **Feature complexity**: design',
  ].join('\n');
  assert.deepEqual(specPhaseContext(spec), {
    owningSurface: 'scripts',
    crossCuttingSurfaces: ['adapters', 'prose'],
    complexity: 'design',
    modelTier: 'most-capable',
    evidence: 'spec:Feature-complexity=design',
  });

  const canonical = '# Plan\n\n## Task 1 — canonical\n\n- **Surface**: `scripts`\n- **Complexity**: integration\n- **Success criteria**: SC1, SC2\n';
  const unsupported = '# Plan\n\n## Task 1 — unsupported\n\n- **Surface:** `scripts`\n- **Complexity:** integration\n- **Spec criteria:** SC1, SC2\n';
  assert.deepEqual(planPhaseContext(canonical).criterionIds, ['SC1', 'SC2']);
  assert.throws(() => planPhaseContext(unsupported), /missing Success criteria/);
  assert.throws(() => planPhaseContext(canonical.replace('Surface', 'Owning surface')), /missing Surface/);
});

test('spec metadata rejects combined ownership and missing complexity', () => {
  for (const ownership of ['scripts (cross-cutting: `adapters`)', '`scripts`, `adapters`']) {
    assert.throws(() => specPhaseContext(`- **Owning surface:** ${ownership}\n- **Feature complexity:** integration`), /exactly one surface/);
  }
  assert.throws(() => specPhaseContext('- **Owning surface:** scripts'), /missing Feature complexity/);
});

test('unrouted cross-cutting prose is reported and skipped, while ownership stays strict', () => {
  const standardsBySurface = fixture.surfaces;
  const ignored = [];
  assert.deepEqual(
    deriveImplicatedStandardPaths({
      owningSurface: 'scripts',
      crossCuttingSurfaces: ['adapters', 'stable hub docs'],
      standardsBySurface,
      onUnroutedSurface: (surface) => ignored.push(surface),
    }),
    ['.apex/standards/scripts.md', '.apex/standards/adapters.md'],
    'an unregistered cross-cutting entry must not halt a run or drop a routed standard',
  );
  assert.deepEqual(ignored, ['stable hub docs'], 'each skipped surface must be reported once');

  assert.deepEqual(
    deriveImplicatedStandardPaths({ crossCuttingSurfaces: ['stable hub docs'], standardsBySurface }),
    [],
    'the reporting callback stays optional',
  );

  for (const input of [
    { owningSurface: 'ghost', standardsBySurface },
    { tasks: [{ owningSurface: 'ghost' }], standardsBySurface },
    // Cross-cutting is advisory only until the same surface is also a routing fact.
    { crossCuttingSurfaces: ['ghost'], tasks: [{ surface: 'ghost' }], standardsBySurface },
  ]) {
    assert.throws(
      () => deriveImplicatedStandardPaths(input),
      /no standard path registered for implicated surface 'ghost'/,
    );
  }

  assert.throws(
    () => deriveImplicatedStandardPaths({ owningSurface: 'scripts', standardsBySurface, onUnroutedSurface: 'nope' }),
    /onUnroutedSurface must be a function/,
  );
});

test('a canonical spec with cross-cutting surfaces builds its plan manifest', (t) => {
  const repoRoot = materialize(t);
  const route = specPhaseContext([
    '- **Owning surface:** `scripts`',
    '- **Cross-cutting surfaces:** `adapters`, stable hub docs',
    '- **Feature complexity:** design',
  ].join('\n'));
  const ignored = [];
  const manifest = buildPlanManifest({
    ...base, repoRoot,
    modelTier: route.modelTier,
    specPath: '.apex/work/specs/context-efficient.md',
    routingPath: '.apex/_INDEX.md',
    testingPath: '.apex/testing-and-checklist.md',
    owningSurface: route.owningSurface,
    crossCuttingSurfaces: route.crossCuttingSurfaces,
    standardsBySurface: fixture.surfaces,
    onUnroutedSurface: (surface) => ignored.push(surface),
  });
  assert.deepEqual(manifest.required.map((item) => item.path), [
    '.apex/work/specs/context-efficient.md', '.apex/_INDEX.md', '.apex/testing-and-checklist.md',
    '.apex/standards/scripts.md', '.apex/standards/adapters.md',
  ]);
  assert.deepEqual(manifest.onDemand.map((item) => item.path), []);
  assert.deepEqual(ignored, ['stable hub docs']);
});

test('plan routing fails closed when task boundaries or criterion IDs are absent', () => {
  assert.throws(() => planPhaseContext(
    '# Plan\n\n### 1. No canonical task boundary\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Success criteria:** SC1\n',
  ), /no Task headings/i);
  assert.throws(() => planPhaseContext(
    '# Plan\n\n## Task 1\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Success criteria:** none\n',
  ), /missing success-criterion IDs/i);
  for (const heading of ['## Task zero', '## Task 0', '## Task -1', '## Task 1a']) {
    assert.throws(() => planPhaseContext(
      `# Plan\n\n${heading}\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Success criteria:** SC1\n`,
    ), /invalid H2 Task heading/i, `${heading} must fail as a malformed canonical boundary`);
  }
  assert.throws(() => planPhaseContext(
    '# Plan\n\n### Task 1\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Success criteria:** SC1\n',
  ), /no Task headings/i, 'nested Task prose remains ignored');
  for (const [label, taskHeadings, reason] of [
    ['duplicate', ['## Task 1', '## Task 1'], /duplicate plan task id '1'/i],
    ['descending', ['## Task 2', '## Task 1'], /strictly increasing.*2.*1/i],
    ['non-increasing', ['## Task 3', '## Task 2'], /strictly increasing.*3.*2/i],
    ['unsafe', ['## Task 9007199254740992'], /safe integer/i],
  ]) {
    const plan = `# Plan\n\n${taskHeadings.map((heading) => `${heading}\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Success criteria:** SC1\n`).join('\n')}`;
    assert.throws(() => planPhaseContext(plan), reason, `${label} task order must fail closed`);
  }
  for (const invalidHeading of ['## Task 0', '## Task 02', '## Task -1', '## Task x', '## Task 1a']) {
    const mixed = `# Plan\n\n## Task 1\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Success criteria:** SC1\n\n${invalidHeading}\n\n- **Surface:** adapters\n- **Complexity:** mechanical\n- **Success criteria:** SC2\n`;
    assert.throws(
      () => planPhaseContext(mixed),
      /invalid H2 Task heading|positive safe integer/i,
      `${invalidHeading} must not disappear after a valid task`,
    );
  }
});

test('review routing accepts only the canonical task-result-index bullet grammar', () => {
  const plan = '# Plan\n\n## Task 1\n\n- **Surface:** `scripts`\n- **Complexity:** `mechanical`\n- **Success criteria:** SC1\n\n## Task 2\n\n- **Surface:** `adapters`\n- **Complexity:** `integration`\n- **Success criteria:** SC2\n';
  const canonical = '# Results\n\n- Task 1: DONE; artifact: .apex/work/tasks/topic/task-1-report.md; changed-paths: none; signals: tdd:red-green\n- Task 2: DONE_WITH_CONCERNS; artifact: .apex/work/tasks/topic/task-2-report.md; changed-paths: adapters/example.mjs; signals: follow-up:telemetry\n';
  assert.deepEqual(reviewPhaseContext(plan, canonical).tasks.map(({ task }) => task), ['1', '2']);
  assert.deepEqual(
    reviewPhaseContext(plan, canonical.replaceAll('\n', '\r\n')).tasks.map(({ task }) => task),
    ['1', '2'],
    'canonical CRLF indexes must parse identically',
  );
  assert.throws(
    () => reviewPhaseContext(plan, canonical.split('\n').filter((line) => !line.startsWith('- Task 2:')).join('\n')),
    /omits plan task ids: 2/i,
  );
  for (const shorthand of [
    '# Results\n\n- Task 1: DONE\n',
    '# Results\n\n- Task 1: DONE; report: task-1-report.md\n',
    '# Results\n\n* Task 1: DONE; artifact: .apex/work/tasks/topic/task-1-report.md; changed-paths: none; signals: none\n',
  ]) {
    assert.throws(() => reviewPhaseContext(plan, shorthand), /malformed reviewed task entry/i);
  }
});

test('review routing reads v2 receipt projections with literal steepysite paths', () => {
  const plan = '# Plan\n\n## Task 1\n\n- **Surface:** web\n- **Complexity:** integration\n- **Success criteria:** SC1\n';
  const entry = { task: '1', status: 'DONE', artifact: '.apex/work/tasks/topic/task-1-report.md',
    changedPaths: ['apps/web/app/admin/(protected)/generation/[id]/page.tsx', 'src/a,b;c è.ts'],
    signals: [], receipt: '.apex/work/tasks/topic/task-1-execution-1' };
  const index = `# Results\n<!-- steepy-task-results: v2 -->\n\`\`\`json\n${JSON.stringify([entry])}\n\`\`\`\n<!-- /steepy-task-results -->\n`;
  assert.deepEqual(reviewPhaseContext(plan, index).tasks.map(({ task }) => task), ['1']);
  assert.throws(() => reviewPhaseContext(plan, index.replace('"task":"1"', '"task":"2"')), /unknown reviewed task|correlation mismatch/);
  assert.throws(() => reviewPhaseContext(plan, index.replace('v2', 'v99')), /version|protocol|projection/i);
  assert.throws(() => reviewPhaseContext(plan, index + '- Task 1: DONE; artifact: x.md; changed-paths: none; signals: none\n'), /mixed|legacy|projection/i);
});

test('discovery signals survive the real review manifest boundary without loading per-task reports', (t) => {
  const repoRoot = materialize(t);
  const indexPath = '.apex/work/tasks/context-efficient/task-result-index.md';
  const plan = '# Plan\n\n## Task 1\n\n- **Surface:** `scripts`\n- **Complexity:** `integration`\n- **Success criteria:** SC3\n';
  for (const signals of ['discovery:unplanned,tdd:red-green', 'review:same-session', 'none']) {
    const index = `# Results\n\n- Task 1: DONE_WITH_CONCERNS; artifact: .apex/work/tasks/context-efficient/not-created-report.md; changed-paths: none; signals: ${signals}\n`;
    writeFileSync(join(repoRoot, indexPath), index);
    const manifest = buildReviewManifest({
      ...base, repoRoot,
      criteriaPath: '.apex/work/tasks/context-efficient/success-criteria.md',
      taskResultIndexPath: indexPath,
      branchDiffPath: '.apex/work/tasks/context-efficient/branch-diff.txt',
      tasks: reviewPhaseContext(plan, index).tasks, standardsBySurface: fixture.surfaces,
    });
    const declaredIndex = manifest.required.find(({ path }) => path === indexPath);
    assert.ok(declaredIndex);
    assert.equal(readFileSync(join(repoRoot, declaredIndex.path), 'utf8'), index);
    assert.equal(declaredIndex.bytes, Buffer.byteLength(index));
    assert.ok(![...manifest.required, ...manifest.onDemand].some(({ path }) => path.endsWith('not-created-report.md')));
  }
  // The manifest preserves bytes; the skill, not this transport, interprets the signal.
  const protocol = readFileSync(join(here, '..', 'skills/implement/autopilot-protocol.md'), 'utf8');
  assert.match(protocol, /preserve[^]*discovery:unplanned[^]*task-result index/i);
  assert.match(protocol, /ordinary concerns[^]*not[^]*discovery/i);
});

test('SC6: the phase-controller tier is floored and capped at standard, named with distribution evidence', () => {
  const mixedPlan = [
    '# Plan',
    '',
    '## Task 1 — bump a constant',
    '',
    '- **Surface:** `scripts`',
    '- **Complexity:** `mechanical`',
    '- **Success criteria:** SC1',
    '',
    '## Task 2 — redesign the tier ladder',
    '',
    '- **Surface:** `scripts`',
    '- **Complexity:** `design`',
    '- **Success criteria:** SC2',
    '',
  ].join('\n');

  const implement = planPhaseContext(mixedPlan);
  assert.equal(implement.modelTier, 'standard');
  assert.notEqual(implement.modelTier, 'most-capable');
  assert.match(implement.evidence, /phase-controller-tier=standard/);
  assert.match(implement.evidence, /distribution=mechanical:1,integration:0,design:1/);

  const index = [
    '# Results',
    '',
    '- Task 1: DONE; artifact: .apex/work/tasks/topic/task-1-report.md; changed-paths: none; signals: tdd:red-green',
    '- Task 2: DONE; artifact: .apex/work/tasks/topic/task-2-report.md; changed-paths: none; signals: tdd:red-green',
    '',
  ].join('\n');
  const review = reviewPhaseContext(mixedPlan, index);
  assert.equal(review.modelTier, 'standard');
  assert.notEqual(review.modelTier, 'most-capable');
  assert.match(review.evidence, /result-index:reviewed-tasks=1,2/);
  assert.match(review.evidence, /phase-controller-tier=standard/);
  assert.match(review.evidence, /distribution=mechanical:1,integration:0,design:1/);
});

test('phase builders derive only implicated standards and preserve scalar contract metadata', (t) => {
  const repoRoot = materialize(t);
  const standardsBySurface = fixture.surfaces;
  const plan = buildPlanManifest({
    ...base, repoRoot,
    specPath: '.apex/work/specs/context-efficient.md',
    routingPath: '.apex/_INDEX.md',
    testingPath: '.apex/testing-and-checklist.md',
    owningSurface: 'scripts',
    crossCuttingSurfaces: ['adapters'],
    standardsBySurface,
    otherHubPaths: ['.apex/standards/prose.md'],
    contract: { commitAuth: 'yes', drive: 'autopilot' },
  });
  assert.deepEqual(plan.required.map((item) => item.path), [
    '.apex/work/specs/context-efficient.md', '.apex/_INDEX.md', '.apex/testing-and-checklist.md',
    '.apex/standards/scripts.md', '.apex/standards/adapters.md',
  ]);
  assert.deepEqual(plan.onDemand.map((item) => item.path), [
    '.apex/standards/prose.md',
  ]);
  assert.deepEqual(plan.contract, { commitAuth: 'yes', drive: 'autopilot' });

  const implement = buildImplementManifest({
    ...base, repoRoot,
    planPath: '.apex/work/plans/context-efficient.md',
    ledgerPath: '.apex/work/tasks/context-efficient/ledger.md',
    specPath: '.apex/work/specs/context-efficient.md',
    routingPath: '.apex/_INDEX.md',
    tasks: [{ surface: 'scripts' }, { surface: 'adapters' }],
    standardsBySurface,
  });
  assert.deepEqual(implement.required.map((item) => item.path), [
    '.apex/work/plans/context-efficient.md',
  ]);
  assert.deepEqual(implement.onDemand.map((item) => item.path), [
    '.apex/_INDEX.md',
    '.apex/standards/scripts.md',
    '.apex/standards/adapters.md',
    '.apex/work/tasks/context-efficient/ledger.md',
    '.apex/work/specs/context-efficient.md',
  ]);

  const review = buildReviewManifest({
    ...base, repoRoot,
    criteriaPath: '.apex/work/tasks/context-efficient/success-criteria.md',
    taskResultIndexPath: '.apex/work/tasks/context-efficient/task-result-index.md',
    branchDiffPath: '.apex/work/tasks/context-efficient/branch-diff.txt',
    tasks: [{ owningSurface: 'scripts' }, { owningSurface: 'adapters' }],
    standardsBySurface,
  });
  assert.deepEqual(review.required.slice(-2).map((item) => item.path), [
    '.apex/standards/scripts.md', '.apex/standards/adapters.md',
  ]);
  assert.deepEqual(buildPhaseManifest('review', {
    ...base, repoRoot,
    criteriaPath: '.apex/work/tasks/context-efficient/success-criteria.md',
    taskResultIndexPath: '.apex/work/tasks/context-efficient/task-result-index.md',
    branchDiffPath: '.apex/work/tasks/context-efficient/branch-diff.txt',
    tasks: [{ surface: 'scripts' }], standardsBySurface,
  }), buildReviewManifest({
    ...base, repoRoot,
    criteriaPath: '.apex/work/tasks/context-efficient/success-criteria.md',
    taskResultIndexPath: '.apex/work/tasks/context-efficient/task-result-index.md',
    branchDiffPath: '.apex/work/tasks/context-efficient/branch-diff.txt',
    tasks: [{ surface: 'scripts' }], standardsBySurface,
  }));
});

test('comparative fixture retains required facts with lower eager input and prompt bytes', (t) => {
  const repoRoot = materialize(t);
  const manifest = buildImplementerManifest({
    ...base, repoRoot, task: 1,
    briefPath: '.apex/work/tasks/context-efficient/task-1-brief.md',
    standardPath: '.apex/standards/scripts.md',
    planPath: '.apex/work/plans/context-efficient.md',
  });
  const eagerText = manifest.required.map(({ path }) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');
  const baselineText = fixture.baselineEager.map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');
  const prompt = manifestReferencePrompt({
    phase: 'implement',
    manifestPath: '.apex/work/tasks/context-efficient/context/task-1-implement.json',
    skill: 'steepy-apex:implement',
    runId: base.runId,
    attempt: 1,
  });

  for (const fact of ['Surface: scripts', 'Test command: npm test', 'Criteria: SC3, SC5', 'Node built-ins only']) {
    assert.ok(eagerText.includes(fact), `required fact remains reachable: ${fact}`);
  }
  assert.ok(!eagerText.includes('UNRELATED_CONTEXT_SENTINEL_7B1D9E'));
  assert.ok(!eagerText.includes('This other task report must not be eager'));
  assert.ok(Buffer.byteLength(eagerText) < Buffer.byteLength(baselineText));
  assert.ok(Buffer.byteLength(prompt) < Buffer.byteLength(baselineText));
  assert.ok(!JSON.stringify(manifest).includes('UNRELATED_CONTEXT_SENTINEL_7B1D9E'));
});

test('a plan task id stops at the id, whatever separator the heading uses next', () => {
  for (const heading of ['## Task 1 — dash', '## Task 1: colon', '## Task 1', '## Task 1) paren', '## Task 1. dot']) {
    const plan = `# Plan\n\n${heading}\n\n- **Surface:** \`scripts\`\n- **Complexity:** \`integration\`\n- **Success criteria:** SC1\n`;
    assert.deepEqual(
      planPhaseContext(plan).tasks.map(({ task }) => task), ['1'],
      `${heading} must bind to task id 1, not to its punctuation`,
    );
  }
});

test('nested Task prose does not create or split canonical plan tasks', () => {
  const plan = '# Plan\n\n## Task 1 — outer\n\n- **Surface:** `scripts`\n- **Complexity:** `integration`\n- **Success criteria:** SC1\n\n### Task 99 — nested prose\n\n- **Complexity:** design\n- **Success criteria:** SC99\n\n## Task 2 — next\n\n- **Surface:** `adapters`\n- **Complexity:** `mechanical`\n- **Success criteria:** SC2\n';
  assert.deepEqual(planPhaseContext(plan).tasks.map(({ task, complexity }) => [task, complexity]), [
    ['1', 'integration'], ['2', 'mechanical'],
  ]);
});

test('phase prompts shrink independently while required-input bytes obey the workflow-total SC5 contract', (t) => {
  const repoRoot = materialize(t);
  const standardsBySurface = fixture.surfaces;
  const manifests = {
    plan: buildPlanManifest({
      ...base, repoRoot,
      specPath: '.apex/work/specs/context-efficient.md',
      routingPath: '.apex/_INDEX.md',
      testingPath: '.apex/testing-and-checklist.md',
      owningSurface: 'scripts', crossCuttingSurfaces: ['adapters'], standardsBySurface,
      otherHubPaths: [],
    }),
    implement: buildImplementManifest({
      ...base, repoRoot,
      planPath: '.apex/work/plans/context-efficient.md',
      ledgerPath: '.apex/work/tasks/context-efficient/ledger.md',
      routingPath: '.apex/_INDEX.md',
      specPath: '.apex/work/specs/context-efficient.md',
      tasks: [{ owningSurface: 'scripts' }, { owningSurface: 'adapters' }], standardsBySurface,
    }),
    review: buildReviewManifest({
      ...base, repoRoot,
      criteriaPath: '.apex/work/tasks/context-efficient/success-criteria.md',
      taskResultIndexPath: '.apex/work/tasks/context-efficient/task-result-index.md',
      branchDiffPath: '.apex/work/tasks/context-efficient/branch-diff.txt',
      tasks: [{ owningSurface: 'scripts' }, { owningSurface: 'adapters' }], standardsBySurface,
    }),
  };
  const requiredFacts = {
    plan: ['Owning surface: scripts', 'Run npm test', 'Node built-ins only'],
    implement: ['## Task 1', 'Surface: scripts', 'Criteria: SC3, SC5'],
    review: ['SC3: role inventories retain required facts', '- Task 2: DONE_WITH_CONCERNS', '+export const routed = true', 'Keep provider details adapter-local'],
  };
  let currentWorkflowRequiredBytes = 0;
  let baselineWorkflowRequiredBytes = 0;
  for (const [phase, manifest] of Object.entries(manifests)) {
    const eager = manifest.required.map(({ path }) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');
    const generatedPrompt = phasePrompt(phase, '/repo/.apex/work/specs/context-efficient.md', {
      runId: base.runId,
      attempt: 1,
      manifestPath: `.apex/work/tasks/context-efficient/context/phase-${phase}-attempt-1.json`,
    });
    const baseline = fixture.baselinePhases[phase];
    const currentRequiredBytes = manifest.required.reduce((total, { bytes }) => total + bytes, 0);
    const baselineRequiredBytes = baseline.eager
      .reduce((total, path) => total + statSync(join(repoRoot, path)).size, 0);
    assert.ok(Buffer.byteLength(generatedPrompt) < Buffer.byteLength(baseline.prompt),
      `${phase} generated prompt bytes must strictly shrink independently of required inputs`);
    if (phase === 'plan') {
      assert.equal(currentRequiredBytes, baselineRequiredBytes,
        'plan required bytes do not grow: approved spec+routing+testing+implicated standards equal baseline');
    } else {
      assert.ok(currentRequiredBytes < baselineRequiredBytes,
        `${phase} required-input bytes must strictly shrink against its matching honest baseline inventory`);
    }
    currentWorkflowRequiredBytes += currentRequiredBytes;
    baselineWorkflowRequiredBytes += baselineRequiredBytes;
    for (const fact of requiredFacts[phase]) assert.ok(eager.includes(fact), `${phase} eagerly retains ${fact}`);
    assert.doesNotMatch(eager, /UNRELATED_CONTEXT_SENTINEL_7B1D9E/);
  }
  assert.ok(currentWorkflowRequiredBytes < baselineWorkflowRequiredBytes,
    'SC5 total required-input bytes means the representative three-phase workflow total, which must strictly shrink');
  assert.deepEqual(manifests.implement.required.map(({ path }) => path), [
    '.apex/work/plans/context-efficient.md',
  ]);
});

test('modular routing preserves core and ordered leaves while plural task manifests materialize only skill-selected matches', (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'steepy-modular-context-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  cpSync(modularFixtureRoot, repoRoot, { recursive: true });
  mkdirSync(join(repoRoot, '.apex/work/plans'), { recursive: true });
  mkdirSync(join(repoRoot, '.apex/work/tasks/topic'), { recursive: true });
  writeFileSync(join(repoRoot, '.apex/work/plans/topic.md'), '# Plan\n');
  writeFileSync(join(repoRoot, '.apex/work/tasks/topic/task-1-brief.md'), '# Task 1\n\nExact paths: web/auth/session.mjs, web/data/store.mjs\nTopics: authentication and session handling; database and persistence paths\n');
  writeFileSync(join(repoRoot, '.apex/work/tasks/topic/task-2-brief.md'), '# Task 2\n\nExact paths: web/auth/session.mjs\nTopic: authentication and session handling\n');
  const bothLeafEvidence = readFileSync(join(repoRoot, '.apex/work/tasks/topic/task-1-brief.md'), 'utf8');
  for (const condition of ['authentication and session handling', 'database and persistence paths']) {
    assert.ok(bothLeafEvidence.includes(condition), `task evidence must match the real mini-routing condition: ${condition}`);
  }
  const routingPath = '.apex/_INDEX.md';
  const standardsBySurface = standardsBySurfaceFromRouting(
    readFileSync(join(repoRoot, routingPath), 'utf8'), { repoRoot },
  );
  const standardPaths = [
    '.apex/standards/web/web-core.md',
    '.apex/standards/web/web-auth.md',
    '.apex/standards/web/web-data.md',
  ];
  const manifest = buildImplementManifest({
    ...base, repoRoot,
    planPath: '.apex/work/plans/topic.md', routingPath,
    ledgerPath: '.apex/work/tasks/topic/ledger.md',
    tasks: [{ owningSurface: 'web' }], standardsBySurface,
  });
  assert.deepEqual(manifest.onDemand.slice(0, 4).map(({ path, purpose }) => [path, purpose]), [
    [routingPath, 'surface routing table'],
    [standardPaths[0], 'implicated surface standard'],
    [standardPaths[1], 'conditional surface standard'],
    [standardPaths[2], 'conditional surface standard'],
  ]);
  assert.deepEqual(standardsBySurface.web, {
    core: standardPaths[0],
    leaves: standardPaths.slice(1),
  }, 'engine preserves exact mini-routing order so the skill can match against evidence');
  const taskManifest = buildImplementerManifest({
    ...base, repoRoot, task: 1,
    briefPath: '.apex/work/tasks/topic/task-1-brief.md', standardPaths,
  });
  assert.deepEqual(taskManifest.required.slice(1).map(({ path }) => path), standardPaths);

  const cliOutput = '.apex/work/tasks/topic/context/task-1-implement.json';
  const cli = spawnSync(process.execPath, [scriptPath,
    '--repo-root', repoRoot, '--role', 'implementer', '--run-id', base.runId,
    '--task', '1', '--model-tier', 'standard',
    '--brief', '.apex/work/tasks/topic/task-1-brief.md',
    '--standard', standardPaths[0], '--standard', standardPaths[1], '--standard', standardPaths[2],
    '--output', cliOutput,
  ], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(
    JSON.parse(readFileSync(join(repoRoot, cliOutput), 'utf8')).required.slice(1).map(({ path }) => path),
    standardPaths,
    'repeated --standard preserves core plus both matching leaves in mini-routing order',
  );

  const authOnlyPaths = standardPaths.slice(0, 2);
  const authOnlyManifest = buildImplementerManifest({
    ...base, repoRoot, task: 2,
    briefPath: '.apex/work/tasks/topic/task-2-brief.md', standardPaths: authOnlyPaths,
  });
  assert.deepEqual(authOnlyManifest.required.slice(1).map(({ path }) => path), authOnlyPaths);
  assert.ok(!authOnlyManifest.required.some(({ path }) => path === standardPaths[2]),
    'skill-selected one-leaf materialization proves there is no eager read-all fallback');
});

test('the plan verifier runs planPhaseContext and rejects options outside its role', (t) => {
  const repoRoot = materialize(t);
  const planPath = '.apex/work/plans/verify-plan.md';
  const run = (extra = []) => spawnSync(process.execPath, [scriptPath,
    '--verify-plan', '--repo-root', repoRoot, '--plan', planPath, ...extra,
  ], { encoding: 'utf8' });

  writeFileSync(join(repoRoot, planPath), '# Plan\n\n### Task 1\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Success criteria:** SC1\n');
  const rejected = run();
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /plan rejected:.*no Task headings/i);

  writeFileSync(join(repoRoot, planPath), '# Plan\n\n## Task 1\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Success criteria:** SC1\n');
  const accepted = run();
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /plan OK — 1 task\(s\): 1/);

  for (const [invalidPlan, reason] of [
    ['# Plan\n\n## Task 1\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Success criteria:** SC1\n\n## Task 1\n\n- **Surface:** adapters\n- **Complexity:** mechanical\n- **Success criteria:** SC2\n', /duplicate plan task id '1'/i],
    ['# Plan\n\n## Task 2\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Success criteria:** SC1\n\n## Task 1\n\n- **Surface:** adapters\n- **Complexity:** mechanical\n- **Success criteria:** SC2\n', /strictly increasing/i],
    ['# Plan\n\n## Task 9007199254740992\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Success criteria:** SC1\n', /safe integer/i],
    ...['## Task 0', '## Task 02', '## Task -1', '## Task x', '## Task 1a'].map((heading) => [
      `# Plan\n\n## Task 1\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Success criteria:** SC1\n\n${heading}\n\n- **Surface:** adapters\n- **Complexity:** mechanical\n- **Success criteria:** SC2\n`,
      /invalid H2 Task heading|positive safe integer/i,
    ]),
  ]) {
    writeFileSync(join(repoRoot, planPath), invalidPlan);
    const invalid = run();
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, reason);
  }

  for (const extra of [['--test-command', 'npm test'], ['--role', 'implementer'], ['--task-result-index', 'x.md']]) {
    const misused = run(extra);
    assert.equal(misused.status, 2, `${extra[0]} must be rejected by verify-plan`);
    assert.match(misused.stderr, /--verify-plan --repo-root/);
  }
});

test('the plan verifier surfaces non-canonical success-criteria bytes as a fixable refusal', (t) => {
  const repoRoot = materialize(t);
  const planPath = '.apex/work/plans/sc-grammar.md';
  writeFileSync(
    join(repoRoot, planPath),
    '# Plan\n\n## Task 1\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Success criteria:** SC01\n',
  );
  const rejected = spawnSync(process.execPath, [scriptPath,
    '--verify-plan', '--repo-root', repoRoot, '--plan', planPath,
  ], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /plan rejected:.*'SC01'.*no leading zeros/i);
});

test('manifest reference validates and derives its one invocation from the skill argument', () => {
  const input = {
    phase: 'plan',
    manifestPath: '.apex/work/tasks/topic/context/phase-plan-attempt-1.json',
    skill: 'steepy-apex:plan',
    runId: base.runId,
    attempt: 1,
  };
  assert.match(manifestReferencePrompt(input), /steepy-apex 'plan' skill/);
  assert.throws(
    () => manifestReferencePrompt({ ...input, skill: 'steepy-apex:review' }),
    /skill.*plan/i,
  );
});

test('the handoff verifier runs the review-phase parse where implement can still fix it', (t) => {
  const repoRoot = materialize(t);
  const planPath = '.apex/work/plans/handoff.md';
  const indexPath = '.apex/work/tasks/context-efficient/task-result-index.md';
  writeFileSync(
    join(repoRoot, planPath),
    '# Plan\n\n## Task 1: colon heading\n\n- **Surface:** `scripts`\n- **Complexity:** `integration`\n- **Success criteria:** SC3\n',
  );
  const verify = (index) => {
    writeFileSync(join(repoRoot, indexPath), index);
    return spawnSync(process.execPath, [scriptPath,
      '--verify-handoff', '--repo-root', repoRoot,
      '--plan', planPath, '--task-result-index', indexPath,
    ], { encoding: 'utf8' });
  };

  const accepted = verify('# Results\n\n- Task 1: DONE; artifact: .apex/work/tasks/context-efficient/task-1-report.md; changed-paths: none; signals: tdd:red-green\n');
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /handoff OK — 1 reviewed task\(s\): 1/);

  for (const [index, reason] of [
    ['# Results\n\n  * Task 1: DONE; artifact: a.md; changed-paths: none; signals: none\n', /malformed reviewed task entry/],
    ['# Results\n\n- Task 1: DONE\n', /malformed reviewed task entry/],
    ['# Results\n\n- Task 9: DONE; artifact: a.md; changed-paths: none; signals: none\n', /unknown reviewed task id '9'/],
    ['# Results\n\nno bullets at all\n', /no reviewed task entries/],
  ]) {
    const rejected = verify(index);
    assert.equal(rejected.status, 1, index);
    assert.match(rejected.stderr, /handoff rejected/);
    assert.match(rejected.stderr, reason);
  }

  const misused = spawnSync(process.execPath, [scriptPath,
    '--verify-handoff', '--repo-root', repoRoot,
    '--plan', planPath, '--task-result-index', indexPath, '--role', 'implementer',
  ], { encoding: 'utf8' });
  assert.equal(misused.status, 2, 'the verifier takes only its own three inputs');
  assert.match(misused.stderr, /--verify-handoff --repo-root/);

  const testCommandMisuse = spawnSync(process.execPath, [scriptPath,
    '--verify-handoff', '--repo-root', repoRoot,
    '--plan', planPath, '--task-result-index', indexPath, '--test-command', 'npm test',
  ], { encoding: 'utf8' });
  assert.equal(testCommandMisuse.status, 2, 'handoff verification rejects task-role metadata');
});

test('task-role CLI uses strict role-specific named paths and writes a valid manifest', (t) => {
  const repoRoot = materialize(t);
  const output = '.apex/work/tasks/context-efficient/context/task-1-review.json';
  const result = spawnSync(process.execPath, [scriptPath,
    '--repo-root', repoRoot,
    '--role', 'task-reviewer',
    '--run-id', base.runId,
    '--task', '1',
    '--model-tier', 'standard',
    '--test-command', 'npm test',
    '--criterion', 'SC3',
    '--brief', '.apex/work/tasks/context-efficient/task-1-brief.md',
    '--report', '.apex/work/tasks/context-efficient/task-1-report.md',
    '--task-diff', '.apex/work/tasks/context-efficient/task-1.diff',
    '--standard', '.apex/standards/scripts.md',
    '--hub-index', '.apex/_INDEX.md',
    '--output', output,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(join(repoRoot, output), 'utf8'));
  assert.equal(manifest.scope.role, 'task-reviewer');
  assert.deepEqual(manifest.criterionIds, ['SC3']);

  const pluralOutput = '.apex/work/tasks/context-efficient/context/task-1-implement-2.json';
  const plural = spawnSync(process.execPath, [scriptPath,
    '--repo-root', repoRoot, '--role', 'implementer', '--run-id', base.runId,
    '--task', '1', '--model-tier', 'standard', '--brief', '.apex/work/tasks/context-efficient/task-1-brief.md',
    '--standard', '.apex/standards/scripts.md', '--standard', '.apex/standards/adapters.md',
    '--output', pluralOutput,
  ], { encoding: 'utf8' });
  assert.equal(plural.status, 0, plural.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(repoRoot, pluralOutput), 'utf8')).required.slice(1).map(({ path }) => path), [
    '.apex/standards/scripts.md', '.apex/standards/adapters.md',
  ]);
  const duplicate = spawnSync(process.execPath, [scriptPath,
    '--repo-root', repoRoot, '--role', 'implementer', '--run-id', base.runId,
    '--task', '1', '--model-tier', 'standard', '--brief', '.apex/work/tasks/context-efficient/task-1-brief.md',
    '--standard', '.apex/standards/scripts.md', '--standard', '.apex/standards/scripts.md',
    '--output', pluralOutput,
  ], { encoding: 'utf8' });
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /duplicate standard path/i);

  const rejected = spawnSync(process.execPath, [scriptPath, '--role', 'implementer', '--prompt', 'unconstrained'], { encoding: 'utf8' });
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /Unknown option.*prompt|unknown option.*prompt/i);

  const missingFinalStandard = spawnSync(process.execPath, [scriptPath,
    '--repo-root', repoRoot,
    '--role', 'final-review',
    '--run-id', base.runId,
    '--model-tier', 'standard',
    '--criteria', '.apex/work/tasks/context-efficient/success-criteria.md',
    '--task-result-index', '.apex/work/tasks/context-efficient/task-result-index.md',
    '--branch-diff', '.apex/work/tasks/context-efficient/branch-diff.txt',
    '--output', '.apex/work/tasks/context-efficient/context/final-review.json',
  ], { encoding: 'utf8' });
  assert.equal(missingFinalStandard.status, 1);
  assert.match(missingFinalStandard.stderr, /final-review requires at least one relevant standard/);
});

test('the CLI refuses unclassifiable manifest names and non-canonical criteria paths as real subprocesses', (t) => {
  const repoRoot = materialize(t);
  const unclassified = spawnSync(process.execPath, [scriptPath,
    '--repo-root', repoRoot, '--role', 'implementer', '--run-id', base.runId,
    '--task', '1', '--model-tier', 'standard',
    '--brief', '.apex/work/tasks/context-efficient/task-1-brief.md',
    '--standard', '.apex/standards/scripts.md',
    '--output', '.apex/work/tasks/context-efficient/context/first.json',
  ], { encoding: 'utf8' });
  assert.equal(unclassified.status, 1);
  assert.equal(unclassified.stdout, '');
  assert.match(unclassified.stderr, /unrecognized work artifact/u);
  assert.equal(
    existsSync(join(repoRoot, '.apex/work/tasks/context-efficient/context')),
    false,
    'a refused manifest name must not create the context directory',
  );

  const aliasedCriteria = spawnSync(process.execPath, [scriptPath,
    '--repo-root', repoRoot, '--role', 'final-review', '--run-id', base.runId,
    '--model-tier', 'standard',
    '--criteria', './.apex/work/tasks/context-efficient/success-criteria.md',
    '--task-result-index', '.apex/work/tasks/context-efficient/task-result-index.md',
    '--branch-diff', '.apex/work/tasks/context-efficient/branch-diff.txt',
    '--standard', '.apex/standards/scripts.md',
    '--output', '.apex/work/tasks/context-efficient/context/final-review.json',
  ], { encoding: 'utf8' });
  assert.equal(aliasedCriteria.status, 1);
  assert.equal(aliasedCriteria.stdout, '');
  assert.match(aliasedCriteria.stderr, /criteria-only artifact/u);
  assert.equal(
    existsSync(join(repoRoot, '.apex/work/tasks/context-efficient/context')),
    false,
    'a refused criteria path must not create the context directory',
  );
});

test('fixture repositories are removed after subtest cleanup', async (t) => {
  let repoRoot;
  await t.test('materialized fixture', (child) => {
    repoRoot = materialize(child);
    assert.equal(existsSync(repoRoot), true);
  });
  assert.equal(existsSync(repoRoot), false);
});

function resumeManifestInput(repoRoot, resumeInputs) {
  return {
    ...base, repoRoot, resumeInputs,
    planPath: '.apex/work/plans/context-efficient.md',
    specPath: '.apex/work/specs/context-efficient.md',
    ledgerPath: '.apex/work/tasks/context-efficient/ledger.md',
    taskResultIndexPath: '.apex/work/tasks/context-efficient/task-result-index.md',
    routingPath: '.apex/_INDEX.md',
    tasks: [{ surface: 'scripts' }],
    standardsBySurface: { scripts: '.apex/standards/scripts.md' },
  };
}

test('explicit resume inputs add only exact on-demand references without reading bodies or listing siblings', (t) => {
  const repoRoot = materialize(t);
  const paths = [
    '.apex/work/tasks/context-efficient/task-1-brief.md',
    '.apex/work/tasks/context-efficient/task-1-report.md',
    '.apex/work/tasks/context-efficient/task-1-diff.txt',
    '.apex/work/tasks/context-efficient/context/task-1-review.json',
    '.apex/work/tasks/context-efficient/task-1-review-guard-attempt-1-iteration-1-original.json',
  ];
  for (const path of paths) {
    mkdirSync(dirname(join(repoRoot, path)), { recursive: true });
    writeFileSync(join(repoRoot, path), 'EXPLICIT_RESUME_BODY_SENTINEL');
  }
  const ordinary = buildImplementManifest(resumeManifestInput(repoRoot));
  const originals = { readFileSync: fs.readFileSync, readdirSync: fs.readdirSync };
  const accesses = [];
  let manifest;
  try {
    for (const name of Object.keys(originals)) fs[name] = (...args) => {
      accesses.push([name, args[0]]);
      throw new Error('resume inventory must inspect metadata only');
    };
    syncBuiltinESMExports();
    manifest = buildImplementManifest(resumeManifestInput(repoRoot, paths));
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
  assert.deepEqual(accesses, []);
  assert.deepEqual(manifest.required, ordinary.required);
  assert.deepEqual(manifest.onDemand.slice(0, ordinary.onDemand.length), ordinary.onDemand);
  assert.deepEqual(manifest.onDemand.slice(ordinary.onDemand.length).map(({ path, read, available, bytes }) =>
    ({ path, read, available, bytes })), paths.map((path) =>
    ({ path, read: 'on-demand', available: true, bytes: Buffer.byteLength('EXPLICIT_RESUME_BODY_SENTINEL') })));
  assert.doesNotMatch(JSON.stringify(manifest), /EXPLICIT_RESUME_BODY_SENTINEL/);
});

test('explicit resume inputs reject aliases, globs, other runs, missing files, duplicates and base capabilities', (t) => {
  const repoRoot = materialize(t);
  const path = '.apex/work/tasks/context-efficient/task-1-brief.md';
  for (const paths of [
    null, path, [path, path], [path.replace('task-1', '*')],
    [path.replace('context-efficient/', 'another-run/')],
    [path.replace('/task-1', '/../task-1')], [path.replace('/task-1', '/./task-1')],
    [path.replace('/task-1', '//task-1')], [path + '/'], [join(repoRoot, path)],
    [path.replace('task-1', 'task-999')],
    ['.apex/work/tasks/context-efficient/ledger.md'],
    ['.apex/work/tasks/context-efficient/task-result-index.md'],
  ]) assert.throws(() => buildImplementManifest(resumeManifestInput(repoRoot, paths)), undefined, JSON.stringify(paths));
});

test('explicit resume inputs reject linked ancestors, linked targets, hardlinks and directories', (t) => {
  const repoRoot = materialize(t);
  const path = '.apex/work/tasks/context-efficient/task-999-report.md';
  const outside = join(repoRoot, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel.md'), 'private');
  const target = join(repoRoot, path);
  for (const kind of ['symlink', 'hardlink', 'directory']) {
    if (kind === 'symlink') symlinkSync(join(outside, 'sentinel.md'), target);
    if (kind === 'hardlink') linkSync(join(outside, 'sentinel.md'), target);
    if (kind === 'directory') mkdirSync(target);
    assert.throws(() => buildImplementManifest(resumeManifestInput(repoRoot, [path])), /symlink|hard.link|ordinary|non-file/);
    rmSync(target, { recursive: true });
  }
  const nested = '.apex/work/tasks/context-efficient/linked';
  symlinkSync(outside, join(repoRoot, nested));
  assert.throws(() => buildImplementManifest(resumeManifestInput(repoRoot, [nested + '/sentinel.md'])), /symlink/);
  assert.equal(readFileSync(join(outside, 'sentinel.md'), 'utf8'), 'private');
});

test('explicit resume inputs reject physical duplicates and base aliases independent of path spelling', (t) => {
  const repoRoot = materialize(t);
  const prefix = '.apex/work/tasks/context-efficient/';
  const original = fs.lstatSync;
  for (const name of ['ledger.md', 'task-result-index.md', 'task-1-report.md']) {
    const path = prefix + name;
    const alias = prefix + 'alias-' + name;
    writeFileSync(join(repoRoot, path), 'existing evidence');
    writeFileSync(join(repoRoot, alias), 'existing evidence');
    const target = join(fs.realpathSync(repoRoot), path);
    const aliasTarget = join(fs.realpathSync(repoRoot), alias);
    // Model a filesystem alias with a single-link target on every CI platform.
    fs.lstatSync = (candidate, ...args) => original(candidate === aliasTarget ? target : candidate, ...args);
    syncBuiltinESMExports();
    try {
      const variants = name === 'task-1-report.md' ? [[path, alias], [alias, path]] : [[alias]];
      for (const paths of variants) {
        assert.throws(() => buildImplementManifest(resumeManifestInput(repoRoot, paths)),
          /duplicate or already inventoried resume input/, JSON.stringify(paths));
      }
    } finally {
      fs.lstatSync = original;
      syncBuiltinESMExports();
    }
  }
});

test('explicit resume inputs distinguish native case aliases from physically distinct case variants', (t) => {
  const repoRoot = materialize(t);
  const prefix = '.apex/work/tasks/context-efficient/';
  for (const name of ['ledger.md', 'task-result-index.md', 'task-1-report.md']) {
    const path = prefix + name;
    const alias = prefix + name.toUpperCase();
    writeFileSync(join(repoRoot, path), 'existing evidence');
    const isAlias = existsSync(join(repoRoot, alias));
    if (!isAlias) writeFileSync(join(repoRoot, alias), 'distinct evidence');
    const paths = name === 'task-1-report.md' ? [path, alias] : [alias];
    if (isAlias) {
      assert.throws(() => buildImplementManifest(resumeManifestInput(repoRoot, paths)),
        /duplicate or already inventoried resume input/, name);
    } else {
      const manifest = buildImplementManifest(resumeManifestInput(repoRoot, paths));
      assert.deepEqual(manifest.onDemand.slice(-paths.length).map(({ path }) => path), paths);
    }
  }
});

const INCEPTION_RUN = '0b6f1b8e-3c1a-4e2b-9f3d-5a7c9e1b2d4f';

function recordFsAccess(fn) {
  const names = ['openSync', 'readFileSync', 'readdirSync', 'opendirSync'];
  const originals = Object.fromEntries(names.map((name) => [name, fs[name]]));
  const accesses = [];
  try {
    for (const name of names) {
      fs[name] = function recorded(...args) {
        accesses.push({ name, path: String(args[0]) });
        return originals[name].apply(this, args);
      };
    }
    syncBuiltinESMExports();
    let result;
    let error;
    try { result = fn(); } catch (caught) { error = caught; }
    return { result, error, accesses };
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
}

function inceptionAccesses(repoRoot, accesses) {
  const areas = [join(repoRoot, '.apex', 'inception'), join(fs.realpathSync.native(repoRoot), '.apex', 'inception')]
    .map((path) => path.toLowerCase());
  return accesses.filter(({ path }) => areas.some((area) => {
    const candidate = path.toLowerCase();
    return candidate === area || candidate.startsWith(`${area}/`);
  }));
}

function modularRepo(t) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'steepy-context-stable-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  cpSync(modularFixtureRoot, repoRoot, { recursive: true });
  mkdirSync(join(repoRoot, '.apex', 'inception', INCEPTION_RUN), { recursive: true });
  writeFileSync(join(repoRoot, '.apex', 'inception', '.gitignore'), '*\n');
  writeFileSync(join(repoRoot, '.apex', 'inception', INCEPTION_RUN, 'local.md'), '# CONTEXT_LOCAL_BODY_SENTINEL\n');
  return repoRoot;
}

const CORE = '.apex/standards/web/web-core.md';
const AUTH = '.apex/standards/web/web-auth.md';
const LOCAL = `.apex/inception/${INCEPTION_RUN}/local.md`;

test('modular routing reads the core and verifies every leaf through the stable reader before any body read', (t) => {
  const routing = (repoRoot) => fs.readFileSync(join(repoRoot, '.apex/_INDEX.md'), 'utf8');
  const replaceLeafLink = (repoRoot, link) => {
    const path = join(repoRoot, CORE);
    writeFileSync(path, fs.readFileSync(path, 'utf8').replace('[web-auth.md](web-auth.md)', `[web-auth.md](${link})`));
  };
  const cases = [
    ['hard-linked core', (repoRoot) => {
      rmSync(join(repoRoot, CORE));
      linkSync(join(repoRoot, LOCAL), join(repoRoot, CORE));
    }, /hard-linked/],
    ['symlinked core', (repoRoot) => {
      rmSync(join(repoRoot, CORE));
      symlinkSync(join(repoRoot, LOCAL), join(repoRoot, CORE));
    }, /symlink/],
    ['leaf entering inception', (repoRoot) => replaceLeafLink(repoRoot, `../../inception/${INCEPTION_RUN}/local.md`),
      /enters excluded \.apex\/inception/],
    ['leaf entering and leaving inception', (repoRoot) => replaceLeafLink(repoRoot, '../../inception/../standards/web/web-auth.md'),
      /enters excluded \.apex\/inception/],
    ['leaf entering and leaving work', (repoRoot) => replaceLeafLink(repoRoot, '../../work/../standards/web/web-auth.md'),
      /enters excluded \.apex\/work/],
    ['symlinked leaf', (repoRoot) => {
      rmSync(join(repoRoot, AUTH));
      symlinkSync(join(repoRoot, LOCAL), join(repoRoot, AUTH));
    }, /symlink/],
    ['hard-linked leaf', (repoRoot) => {
      rmSync(join(repoRoot, AUTH));
      linkSync(join(repoRoot, LOCAL), join(repoRoot, AUTH));
    }, /hard-linked/],
  ];
  for (const [label, mutate, reason] of cases) {
    const repoRoot = modularRepo(t);
    mutate(repoRoot);
    const { error, accesses } = recordFsAccess(() => standardsBySurfaceFromRouting(routing(repoRoot), { repoRoot }));
    assert.ok(error, `${label} must be refused`);
    assert.match(error.message, reason, label);
    assert.doesNotMatch(error.message, /CONTEXT_LOCAL_BODY_SENTINEL/u, label);
    assert.deepEqual(inceptionAccesses(repoRoot, accesses), [], label);
  }

  const repoRoot = modularRepo(t);
  assert.deepEqual(standardsBySurfaceFromRouting(routing(repoRoot), { repoRoot }).web, {
    core: CORE,
    leaves: [AUTH, '.apex/standards/web/web-data.md'],
  }, 'ordinary modular routing is unchanged');
  fs.rmSync(join(repoRoot, AUTH));
  assert.deepEqual(standardsBySurfaceFromRouting(routing(repoRoot), { repoRoot }).web.leaves,
    [AUTH, '.apex/standards/web/web-data.md'], 'a missing leaf stays an unavailable on-demand reference');
});

test('routing rows into local areas are refused even without a repository root', () => {
  for (const [target, area] of [
    [`inception/${INCEPTION_RUN}/web.md`, 'inception'],
    ['work/specs/web.md', 'work'],
  ]) {
    assert.throws(
      () => standardsBySurfaceFromRouting(`| \`web\` | [web](${target}) | \`web-agent\` |\n`),
      new RegExp(`standard path for web enters excluded \\.apex/${area}`, 'u'),
      target,
    );
  }
});

test('the plan verifier reads non-work inputs only through the stable reader', (t) => {
  const repoRoot = modularRepo(t);
  const plan = '# Plan\n\n## Task 1\n\n- **Surface:** `web`\n- **Complexity:** `integration`\n- **Success criteria:** SC1\n';
  const verify = (planPath) => spawnSync(process.execPath, [scriptPath,
    '--verify-plan', '--repo-root', repoRoot, '--plan', planPath,
  ], { encoding: 'utf8' });

  writeFileSync(join(repoRoot, '.apex', 'inception', INCEPTION_RUN, 'plan.md'), plan);
  const local = verify(`.apex/inception/${INCEPTION_RUN}/plan.md`);
  assert.equal(local.status, 1, local.stdout);
  assert.match(local.stderr, /plan rejected:.*enters excluded \.apex\/inception/u);

  mkdirSync(join(repoRoot, 'docs'));
  linkSync(join(repoRoot, '.apex', 'inception', INCEPTION_RUN, 'plan.md'), join(repoRoot, 'docs', 'linked-plan.md'));
  const hardLinked = verify('docs/linked-plan.md');
  assert.equal(hardLinked.status, 1, hardLinked.stdout);
  assert.match(hardLinked.stderr, /plan rejected:.*hard-linked/u);

  writeFileSync(join(repoRoot, 'docs', 'plan.md'), plan);
  const ordinary = verify('docs/plan.md');
  assert.equal(ordinary.status, 0, ordinary.stderr);
  assert.match(ordinary.stdout, /plan OK — 1 task\(s\): 1/u);
});

test('a routed single-file standard is verified on metadata before any child can read it', (t) => {
  const repoRoot = materialize(t);
  const routing = '| `scripts` | [standards/scripts.md](standards/scripts.md) | `scripts-agent` |\n';
  assert.deepEqual(standardsBySurfaceFromRouting(routing, { repoRoot }), { scripts: '.apex/standards/scripts.md' });
  mkdirSync(join(repoRoot, '.apex', 'inception', INCEPTION_RUN), { recursive: true });
  writeFileSync(join(repoRoot, '.apex', 'inception', INCEPTION_RUN, 'local.md'), '# CONTEXT_LOCAL_BODY_SENTINEL\n');
  rmSync(join(repoRoot, '.apex', 'standards', 'scripts.md'));
  symlinkSync(`../inception/${INCEPTION_RUN}/local.md`, join(repoRoot, '.apex', 'standards', 'scripts.md'));
  const { error, accesses } = recordFsAccess(() => standardsBySurfaceFromRouting(routing, { repoRoot }));
  assert.match(error?.message ?? '', /standard path for scripts cannot be read as a stable document: .*is symlink/u);
  assert.deepEqual(inceptionAccesses(repoRoot, accesses), []);
  rmSync(join(repoRoot, '.apex', 'standards', 'scripts.md'));
  assert.deepEqual(standardsBySurfaceFromRouting(routing, { repoRoot }), { scripts: '.apex/standards/scripts.md' },
    'a missing single-file standard stays for the manifest builder to report');
});

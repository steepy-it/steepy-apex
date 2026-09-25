import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectViolations } from '../scripts/validate-hub.mjs';
import { collectReviewEvidence } from '../scripts/capture-review-evidence.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const projectScaffold = join(repoRoot, 'scripts', 'project-scaffold.mjs');
const dogfoodModel = {
  projectName: 'steepy-apex',
  description: 'Scaffold a governed context-engineering hub (.apex/ DAG + routing + coherence linter) into any repo.',
  devCommands: ['npm test'],
  surfaces: [
    { name: 'adapters', path: 'adapters', agent: 'adapters-agent', testCmd: 'npm test' },
    { name: 'scripts', path: 'scripts', agent: 'scripts-agent', testCmd: 'npm test' },
    { name: 'skills', path: 'skills', agent: 'skills-agent', testCmd: 'npm test' },
    { name: 'templates', path: 'templates', agent: 'templates-agent', testCmd: 'npm test' },
    { name: 'tests', path: 'tests', agent: 'tests-agent', testCmd: 'npm test' },
  ],
  resolutions: {},
};

const dogfoodArtifacts = [
  'AGENTS.md',
  'CLAUDE.md',
  '.agents/skills/steepy-apex-bootstrap/SKILL.md',
  '.claude/skills/steepy-apex-bootstrap/SKILL.md',
  ...dogfoodModel.surfaces.flatMap(({ agent }) => [
    `.claude/agents/${agent}.md`,
    `.codex/agents/${agent}.toml`,
    `.opencode/agents/${agent}.md`,
  ]),
];

function runDogfoodScaffold({ apply = false } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'steepy-apex-dogfood-'));
  try {
    const modelPath = join(temp, 'model.json');
    writeFileSync(modelPath, `${JSON.stringify(dogfoodModel)}\n`);
    const args = [projectScaffold, '--hub', repoRoot, '--model', modelPath];
    if (apply) args.push('--apply');
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function artifactSnapshot() {
  return Object.fromEntries(dogfoodArtifacts.map((path) => {
    const absolute = join(repoRoot, path);
    const stat = lstatSync(absolute, { bigint: true });
    return [path, {
      bytes: readFileSync(absolute),
      mode: stat.mode,
      mtimeNs: stat.mtimeNs,
    }];
  }));
}

function dogfoodTempDirectories() {
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('steepy-apex-dogfood-'))
    .map((entry) => entry.name)
    .sort();
}

function stableApexMarkdownPaths(directory = join(repoRoot, '.apex')) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return ['work', 'inception'].includes(entry.name) ? [] : stableApexMarkdownPaths(absolute);
    return entry.isFile() && entry.name.endsWith('.md') ? [absolute] : [];
  });
}

test('the repo .apex/ hub is coherent (dogfood gate)', () => {
  assert.deepEqual(collectViolations(repoRoot), []);
});

test('terminal review evidence cannot report reviewed-clean when its owned hub gate is red', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'steepy-terminal-review-red-hub-'));
  try {
    writeFileSync(join(repo, '.gitignore'), '');
    const apex = join(repo, '.apex');
    mkdirSync(apex, { recursive: true });
    writeFileSync(join(apex, '_INDEX.md'), [
      '# Broken target hub', '', '## Routing table', '',
      '| Surface | Standard | Agent |', '|---|---|---|',
      '| `scripts` | [missing](standards/missing.md) | `scripts-agent` |', '',
    ].join('\n'));
    const receipt = await collectReviewEvidence({
      repoRoot: repo,
      evidencePath: '.apex/work/loops/2026-09-04-red-hub/evidence-report.md',
      testCommand: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.exit(0)')}`,
    });
    assert.equal(receipt.commands[0].passed, true);
    assert.equal(receipt.commands.at(-1).label, 'validate-hub');
    assert.equal(receipt.commands.at(-1).passed, false);
    assert.equal(receipt.allPassed, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the hub ships its satellite docs, reachable from _INDEX.md', () => {
  for (const f of ['conventions.md', 'glossary.md', 'testing-and-checklist.md']) {
    assert.ok(existsSync(join(repoRoot, '.apex', f)), `missing .apex/${f}`);
  }
  const index = readFileSync(join(repoRoot, '.apex', '_INDEX.md'), 'utf8');
  for (const f of ['conventions.md', 'glossary.md', 'testing-and-checklist.md']) {
    assert.ok(index.includes(`(${f})`), `_INDEX.md must link ${f}`);
  }
});

test('workflow specs and plans are not stable hub artifacts', () => {
  const index = readFileSync(join(repoRoot, '.apex', '_INDEX.md'), 'utf8');
  assert.doesNotMatch(index, /specs\/_INDEX\.md/);
  assert.doesNotMatch(index, /plans\/_INDEX\.md/);
  assert.ok(readFileSync(join(repoRoot, '.gitignore'), 'utf8').split('\n').includes('/.apex/work/'),
    'the repository must ignore the entire local work tree from its root');
});

test('anti-orphan directive scopes reachability to stable docs and excludes .apex/work', () => {
  const index = readFileSync(join(repoRoot, '.apex', '_INDEX.md'), 'utf8');
  assert.doesNotMatch(index, /every `?\.apex\/\*\*\.md`? must be reachable/i);
  assert.match(index, /(stable \.apex\/\*\*\.md docs|exclude[s]? `?\.apex\/work\/\*\*`?)/i);
});

test('scripts standard locks bounded physical stable reads and canonical provider agent identity', () => {
  const scripts = readFileSync(join(repoRoot, '.apex', 'standards', 'scripts.md'), 'utf8');
  assert.match(scripts, /stable hub reads[\s\S]*ordinary files[\s\S]*verified descriptors[\s\S]*bounded/i);
  assert.match(scripts, /never follow[\s\S]*symlink[\s\S]*\.apex\/work[\s\S]*external/i);
  assert.match(scripts, /hub root[\s\S]*parent traversal[\s\S]*direct root symlink[\s\S]*physical identity/i);
  assert.match(scripts, /failed candidate read[\s\S]*controlled error[\s\S]*not absence/i);
  assert.match(scripts, /reserved[\s\S]*\.apex\/work[\s\S]*physical identity[\s\S]*case alias[\s\S]*case-sensitive/i);
  assert.match(scripts, /portable provenance[\s\S]*every ordinary file[\s\S]*four provider namespaces[\s\S]*name[\s\S]*extension/i);
  assert.match(scripts, /node_modules[\s\S]*exact directory[\s\S]*not inspect[\s\S]*blind spot[\s\S]*near-name/i);
  assert.match(scripts, /all recursive[\s\S]*provider presence[\s\S]*reverse agent[\s\S]*skill[\s\S]*node_modules/i);
  assert.match(scripts, /package\.json[\s\S]*unsafe[\s\S]*controlled error[\s\S]*absent[\s\S]*malformed/i);
  assert.match(scripts, /terminal separator[\s\S]*dot[\s\S]*directory/i);
  assert.match(scripts, /reverse routing[\s\S]*canonical provider agent identities[\s\S]*nested namesake/i);
});

test('the five governed surfaces are wired (standard + agent + routing row)', () => {
  const index = readFileSync(join(repoRoot, '.apex', '_INDEX.md'), 'utf8');
  for (const s of ['adapters', 'scripts', 'skills', 'templates', 'tests']) {
    assert.ok(existsSync(join(repoRoot, '.apex', 'standards', `${s}.md`)), `missing standard ${s}.md`);
    assert.ok(existsSync(join(repoRoot, '.claude', 'agents', `${s}-agent.md`)), `missing agent ${s}-agent.md`);
    assert.ok(new RegExp(`\`${s}-agent\``).test(index), `_INDEX.md must route ${s}-agent`);
  }
});

test('the repo ships a generated root CLAUDE.md with the managed import block', () => {
  const claude = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /<!-- steepy:managed:claude-import:v1:start -->/);
  assert.match(claude, /@AGENTS\.md/);
});

test('the repository is the public Project model v1 scaffold for its five routing rows', () => {
  const index = readFileSync(join(repoRoot, '.apex', '_INDEX.md'), 'utf8');
  for (const { name, agent } of dogfoodModel.surfaces) {
    const row = '| `' + name + '` | [standards/' + name + '.md](standards/' + name + '.md) | `' + agent + '`';
    assert.ok(index.includes(row), `missing canonical routing row for ${name}`);
  }

  for (const path of dogfoodArtifacts) {
    const text = readFileSync(join(repoRoot, path), 'utf8');
    if (path === 'AGENTS.md' || path === 'CLAUDE.md') {
      assert.match(text, /<!-- steepy:managed:(project-instructions|claude-import):v1:start -->/);
    } else if (path.endsWith('.toml')) {
      assert.match(text, /^# steepy:generated:[a-z0-9-]+:v1$/m, `${path} must have v1 provenance`);
      assert.doesNotMatch(text, /^model\s*=/m, `${path} must inherit the spawning Codex model by omission`);
    } else {
      assert.match(text, /^<!-- steepy:generated:[a-z0-9-]+:v1 -->$/m, `${path} must have v1 provenance`);
    }
  }
  assert.deepEqual(collectViolations(repoRoot), []);
});

test('public scaffold CLI repair is a complete no-op for the dogfood hub', () => {
  const before = artifactSnapshot();
  const preview = runDogfoodScaffold();
  assert.deepEqual(preview, [{ schemaVersion: 1, event: 'preview', preview: [], conflicts: [] }]);

  const applied = runDogfoodScaffold({ apply: true });
  assert.deepEqual(applied, [
    { schemaVersion: 1, event: 'preview', preview: [], conflicts: [] },
    { schemaVersion: 1, event: 'applied', result: { applied: 0, paths: [] } },
  ]);
  assert.deepEqual(artifactSnapshot(), before, 'no-op repair must preserve bytes, mode, and mtime');
});

test('public dogfood preview cleans its temporary model directory', () => {
  const before = dogfoodTempDirectories();
  runDogfoodScaffold();
  assert.deepEqual(dogfoodTempDirectories(), before);
});

test('the tests standard locks the final cross-surface acceptance vertical', () => {
  const standard = readFileSync(join(repoRoot, '.apex', 'standards', 'tests.md'), 'utf8');
  assert.match(standard, /vertical TDD/i);
  assert.match(standard, /fake-executable canary/i);
  assert.match(standard, /full-tree idempotence/i);
  assert.match(standard, /release gate/i);
});

test('stable workflow knowledge is content-locked and manual transport remains model-only', () => {
  const readStable = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8');
  const glossary = readStable('.apex', 'glossary.md');
  const conventions = readStable('.apex', 'conventions.md');
  const skills = readStable('.apex', 'standards', 'skills.md');
  const templates = readStable('.apex', 'standards', 'templates.md');
  const scripts = readStable('.apex', 'standards', 'scripts.md');
  const tests = readStable('.apex', 'standards', 'tests.md');

  for (const text of [glossary, conventions, skills, templates, scripts, tests]) {
    assert.doesNotMatch(text, /\]\([^)]*\.apex\/work\//, 'stable Markdown must not link a concrete work artifact');
  }
  for (const path of stableApexMarkdownPaths()) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /\]\([^)]*\.apex\/work\//, `${path} must not link a concrete work artifact`);
  }

  assert.match(glossary, /Manual handoff envelope[\s\S]*model-enforced[\s\S]*manifest, parser, or validator/i);
  assert.match(glossary, /Workflow artifact state[\s\S]*DRAFT[\s\S]*READY[\s\S]*CONSUMED[\s\S]*most-recent artifact/i);
  assert.match(conventions, /Manual and autopilot runs have the same phase inputs, outputs, transitions, and\s+provenance semantics[\s\S]*manual manifest, parser, or validator/i);
  assert.match(conventions, /role-local autopilot manifest[\s\S]*required[\s\S]*onDemand/i);
  assert.match(skills, /common completion grammar[\s\S]*status: <DONE\|DONE_WITH_CONCERNS\|NEEDS_CONTEXT\|BLOCKED>[\s\S]*signals: <short IDs or none>/i);
  assert.match(skills, /phase-local role map[\s\S]*brainstorm[\s\S]*plan[\s\S]*implement[\s\S]*review[\s\S]*terminal human handoff/i);
  assert.match(skills, /DRAFT[\s\S]*READY[\s\S]*CONSUMED[\s\S]*bidirectional provenance/i);
  assert.match(skills, /No role chooses a most-recent artifact/i);
  assert.match(skills, /fail closed on absent IDs[\s\S]*Task-like heading[\s\S]*validated before task parsing/i);
  assert.match(templates, /default-deny boundary[\s\S]*exact work paths[\s\S]*pathless invocation[\s\S]*phase orchestrator interprets the handoff/i);
  assert.match(templates, /do not define phase role maps, lifecycle transitions, envelope grammar/i);
  assert.match(scripts, /Public scaffold repair[\s\S]*current canonical v1[\s\S]*customization conflicts[\s\S]*no prior-format[\s\S]*exact no-op/i);
  assert.match(scripts, /Codex output inherits[\s\S]*model = "inherit"[\s\S]*customization conflict[\s\S]*never an automatic upgrade/i);
  assert.match(templates, /Codex[\s\S]*omit(?:s|ting)? the `model` field[\s\S]*inherit/i);
  assert.match(scripts, /unmarked active Claude import offers `adopt`[\s\S]*preserves every other byte[\s\S]*exact no-op/i);
  assert.match(scripts, /deterministic versioned context manifest validation and writes,?\s+phase\s+lifecycle, status correlation, artifact timing[\s\S]*manual\/legacy v1 four fields; v2 semantic status\/artifact\/signals/i);

  assert.match(tests, /Content-byte-locks assert canonical model-facing prose and generated bytes; they do not claim a deterministic manual parser or validator\./);
  assert.match(tests, /Manual handoff tests lock model-only enforcement; autopilot manifest tests remain the stronger deterministic contract\./);
  assert.match(tests, /Public scaffold coverage records unsupported-format refusal, explicit customization resolution, hub\/work preservation, and an exact second no-op\./);
  assert.match(tests, /Content locks cover the common inline grammar, phase role maps, fail-closed errors, lifecycle\/provenance transitions, native-plus-canonical handoffs, and every most-recent fallback prohibition\./);
  assert.match(tests, /Dogfood covers every promoted glossary\/conventions\/surface-standard term and rule\./);
});

test('stable hub locks the deterministic Gear-4 event, recovery, and evidence boundaries', () => {
  const readStable = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8');
  const glossary = readStable('.apex', 'glossary.md');
  const scripts = readStable('.apex', 'standards', 'scripts.md');
  const tests = readStable('.apex', 'standards', 'tests.md');

  assert.match(glossary, /Workflow event log[\s\S]*authoritative state source/i);
  assert.match(glossary, /Loop ledger[\s\S]*deterministic\s+projection[\s\S]*never the state authority/i);
  assert.match(glossary, /Attempt reservation[\s\S]*ATTEMPT_RESERVED[\s\S]*before[\s\S]*side effects/i);
  assert.match(glossary, /Reconciliation-required halt[\s\S]*RECONCILIATION_REQUIRED[\s\S]*RUN_HALTED/i);
  assert.match(
    glossary,
    /Clean terminal outcome[\s\S]*GOAL_REACHED[\s\S]*BUDGET_EXHAUSTED[\s\S]*NO_IMPROVEMENT[\s\S]*REVIEW_REJECTED/i,
  );
  assert.match(glossary, /Goal contract[\s\S]*READY[\s\S]*commit authorization[\s\S]*CONSUMED/i);
  assert.match(glossary, /Keep\/discard[\s\S]*boolean[\s\S]*metric[\s\S]*strict/i);
  assert.match(glossary, /Verifier[\s\S]*baseline[\s\S]*last line[\s\S]*scalar/i);

  assert.match(scripts, /workflow-state\.mjs[\s\S]*versioned event schema[\s\S]*deterministic reducer/i);
  assert.match(scripts, /loop-engineer\.mjs[\s\S]*terminal Gear-4 controller/i);
  assert.match(scripts, /event log[\s\S]*sole state authority[\s\S]*ledger[\s\S]*projection/i);
  assert.match(scripts, /RECONCILIATION_REQUIRED[\s\S]*RUN_HALTED[\s\S]*never[\s\S]*reset/i);
  assert.match(scripts, /retained branch[\s\S]*committed attempts[\s\S]*discarded attempts/i);
  assert.match(scripts, /reviewer report digest[\s\S]*final branch-diff[\s\S]*current branch[\s\S]*HEAD[\s\S]*clean/i);
  assert.match(scripts, /commit[\s\S]*update-ref[\s\S]*reset --mixed[\s\S]*discard[\s\S]*reset --hard[\s\S]*clean[\s\S]*crash/i);
  assert.match(scripts, /sanity verifier[\s\S]*before[\s\S]*repository-local lock/i);
  assert.match(scripts, /RUN_HALTED[\s\S]*(?:permanently abandoned|not resumable)[\s\S]*new ratified goal/i);
  assert.match(
    scripts,
    /work-paths\.mjs[\s\S]{0,500}`spec \| goal \| criteria \| work-output`/i,
    'scripts standard must carry the implementation work-type order exactly',
  );
  assert.match(scripts, /Claude[\s\S]*Codex[\s\S]*OpenCode[\s\S]*Pi[\s\S]*DeepSeek[\s\S]*runner-unavailable/i);

  assert.match(tests, /workflow-state[\s\S]*loop-engineer[\s\S]*one-suite-per-script/i);
  assert.match(tests, /hostile deterministic runtime matrix/i);
  assert.match(tests, /external return[\s\S]*immutable artifact[\s\S]*event append/i);
  assert.match(tests, /retained-green[\s\S]*discarded review-fix/i);
  assert.match(tests, /report[\s\S]*diff[\s\S]*changed-HEAD[\s\S]*changed-branch[\s\S]*dirty-tree/i);
  assert.match(tests, /intra-command[\s\S]*tracked[\s\S]*untracked[\s\S]*mixed[\s\S]*new process/i);
  assert.match(tests, /unreliable verifier[\s\S]*zero repository-local mutation/i);
  assert.match(tests, /fake-runner[\s\S]*APEX-P2-10/i);
  assert.match(tests, /five-provider LIVE[\s\S]*APEX-P1-04[\s\S]*open/i);
});

test('the dogfood canonical bootstrap owns the public project-navigation contract', () => {
  const skill = readFileSync(
    join(repoRoot, '.agents', 'skills', 'steepy-apex-bootstrap', 'SKILL.md'),
    'utf8'
  );
  assert.match(skill, /^<!-- steepy:generated:steepy-apex-bootstrap:v1 -->/m);
  assert.match(skill, /Read `AGENTS\.md` in full/);
  assert.match(skill, /Read `\.apex\/_INDEX\.md` in full/);
  assert.match(skill, /minimum documents named by its routing row/);
  assert.match(skill, /owning surface and specialist agent/);
  assert.match(skill, /semantic skill name as listed in `.apex\/_INDEX\.md`/);
  assert.match(skill, /test command and the hub coherence gate/);
  assert.match(skill, /Do not ordinarily enumerate, search, or read under `\.apex\/work\/\*\*`/);
  assert.match(skill, /only the phase orchestrator interprets a handoff/i);
});

test('the dogfood Claude bootstrap remains a thin stub over the canonical bootstrap', () => {
  const stub = readFileSync(
    join(repoRoot, '.claude', 'skills', 'steepy-apex-bootstrap', 'SKILL.md'),
    'utf8'
  );
  assert.match(stub, /^<!-- steepy:generated:steepy-apex-bootstrap-stub:v1 -->/m);
  assert.match(stub, /Read `\.agents\/skills\/steepy-apex-bootstrap\/SKILL\.md` in full/);
  assert.match(stub, /execute that canonical bootstrap exactly/);
});

test('conventions.md documents the conditional-ceremony decision model', () => {
  const conventions = readFileSync(join(repoRoot, '.apex', 'conventions.md'), 'utf8');
  const match = conventions.match(/## Decision model \(conditional ceremony\)([\s\S]*)/);
  assert.ok(match, 'conventions.md must have a "## Decision model (conditional ceremony)" section');
  const section = match[1];
  for (const verdict of ['COVERED', 'CONFLICT', 'GAP']) {
    assert.ok(section.includes(verdict), `decision model section must define the ${verdict} verdict`);
  }
  for (const gear of ['Gear 1', 'Gear 2', 'Gear 3']) {
    assert.ok(section.includes(gear), `decision model section must define ${gear}`);
  }
  assert.match(
    section,
    /no command runs without a verdict/i,
    'decision model section must state the no-verdict-no-run invariant'
  );
  assert.match(
    section,
    /subagent reviewer.*only.*gear 3|gear 3.*subagent reviewer/is,
    'decision model section must state the subagent-reviewer-only-in-gear-3 invariant'
  );
});

test('conventions.md Execution discipline declares a session-per-phase rule, never imposed', () => {
  const conventions = readFileSync(join(repoRoot, '.apex', 'conventions.md'), 'utf8');
  const match = conventions.match(/## Execution discipline([\s\S]*?)(?=## |$)/);
  assert.ok(match, 'conventions.md must have a "## Execution discipline" section');
  const section = match[1];
  assert.match(section, /session per phase/i, 'Execution discipline must name the session-per-phase rule');
  assert.match(section, /never imposed/i, 'the session-per-phase rule must be declared, never imposed');
  assert.match(section, /17\.0M/, 'must cite the measured single-phase manual session figure');
  assert.match(section, /19\.6M/, 'must cite the measured mixed-phase manual session figure');
  assert.match(section, /3\.6M/, 'must cite the measured autopilot figure');
});

test('stable autopilot docs lock context protocol and canonical review handoff artifacts', () => {
  const conventions = readFileSync(join(repoRoot, '.apex', 'conventions.md'), 'utf8');
  const scripts = readFileSync(join(repoRoot, '.apex', 'standards', 'scripts.md'), 'utf8');
  const skills = readFileSync(join(repoRoot, '.apex', 'standards', 'skills.md'), 'utf8');
  const planSkill = readFileSync(join(repoRoot, 'skills', 'plan', 'SKILL.md'), 'utf8');
  const reviewSkill = readFileSync(join(repoRoot, 'skills', 'review', 'SKILL.md'), 'utf8');
  assert.match(conventions, /eager upstream context, not repository authorization/i);
  assert.match(conventions, /criteria-only `success-criteria\.md`/);
  assert.match(conventions, /`task-result-index\.md`/);
  assert.match(conventions, /`branch-diff\.txt`/);
  assert.match(scripts, /rejects a full[\s\S]{0,40}`\.apex\/work\/specs\/\*\*`[\s\S]{0,40}criteria input/i);
  assert.match(skills, /- Task <id>: <DONE\|DONE_WITH_CONCERNS>;/);
  assert.match(
    conventions,
    /owning or per-task surface[\s\S]{0,120}halts[\s\S]{0,200}`CONTEXT_SURFACE_IGNORED`/,
    'conventions must separate a binding error from advisory cross-cutting prose'
  );

  const adapters = readFileSync(join(repoRoot, '.apex', 'standards', 'adapters.md'), 'utf8');
  assert.match(
    adapters,
    /`cheap` is that harness's small\s+fast model and never a frontier one/,
    'adapters must state the tier ladder ordering invariant'
  );
  assert.match(
    scripts,
    /Derived review evidence is conductor-derived, never child-reported/,
    'scripts must assign derived review evidence to the conductor'
  );
  assert.match(scripts, /`BASELINE` commit/, 'scripts must name the baseline the aggregate diff spans');
  assert.match(scripts, /Plan requires the spec, routing index, testing checklist, and implicated routed core\/single\s+standards/i);
  assert.match(scripts, /mini-routing table[\s\S]{0,240}repeated `--standard`/i);
  assert.match(
    skills,
    /verifies that index against the plan before claiming completion/,
    'skills must require implement to parse its own handoff first'
  );
  assert.match(skills, /Every H2 Task-like heading is validated before task parsing/i);
  assert.match(skills, /matching[\s\S]{0,180}repeats `--standard`/i);
  assert.match(skills, /Plan matches[^.]*required spec[^.]*exact paths\/topics[\s\S]{0,180}every matching leaf/i);
  assert.match(skills, /Review matches[^.]*criteria[^.]*task-result index[^.]*branch diff[\s\S]{0,180}every matching leaf/i);
  assert.match(skills, /Manifest-backed implement and review[\s\S]*?scalar contract\s+metadata/i);
  for (const [phase, skillText] of [['plan', planSkill], ['review', reviewSkill]]) {
    assert.match(skillText, /zero\s+(?:leaves\s+)?match(?:es)?[^.]*core only/i, `${phase} must lock zero-match core-only semantics`);
    assert.match(skillText, /never read\s+all leaves[^.]*fallback/i, `${phase} must prohibit a read-all fallback`);
  }
  const planValidation = planSkill.match(/### Step 5 — Validate[\s\S]*?(?=### Step 6)/)?.[0];
  assert.ok(planValidation, 'plan must keep a local deterministic validation contract');
  assert.match(planValidation, /--verify-plan/);
  assert.match(planValidation, /before appending `DONE`/i);
});

test('conventions.md documents Review architecture (gear 3) with Complexity, ledger, and escalations', () => {
  const conventions = readFileSync(join(repoRoot, '.apex', 'conventions.md'), 'utf8');
  const match = conventions.match(/## Review architecture \(gear 3\)([\s\S]*?)(?=## |\Z)/);
  assert.ok(match, 'conventions.md must have a "## Review architecture (gear 3)" section');
  const section = match[1];
  assert.match(
    section,
    /Complexity/,
    'Review architecture section must document Complexity classification'
  );
  assert.match(
    section,
    /ledger/i,
    'Review architecture section must mention ledger'
  );
  assert.match(
    section,
    /escalat/i,
    'Review architecture section must mention escalations'
  );
});

test('conventions.md Review architecture keeps evidence collection deterministic and judgement local', () => {
  const conventions = readFileSync(join(repoRoot, '.apex', 'conventions.md'), 'utf8');
  const match = conventions.match(/## Review architecture \(gear 3\)([\s\S]*?)(?=## |$)/);
  assert.ok(match, 'conventions.md must have a "## Review architecture (gear 3)" section');
  const section = match[1];
  const reviewBullet = section.match(/- `review`[\s\S]*?\n\n/)?.[0];
  assert.ok(reviewBullet, 'Review architecture section must have a `review` bullet');
  assert.match(
    reviewBullet,
    /deterministic inline script[\s\S]{0,120}bounded receipt/i,
    'review evidence must cross into context only through the deterministic bounded receipt'
  );
  assert.match(
    reviewBullet,
    /judgement[\s\S]{0,160}remain in the review session/i,
    'review judgement must remain in the review session'
  );
  assert.doesNotMatch(
    reviewBullet,
    /delegat[^.]{0,80}(?:collection|judgement)|(?:collection|judgement)[^.]{0,80}delegat/i,
    'review must not reintroduce an LLM delegation path'
  );
  assert.match(
    reviewBullet,
    /Invariant 4/i,
    'review bullet must relate the collector to Invariant 4 (subagent reviewers only in gear 3)'
  );
});

test('conventions.md documents Modular standards with human-decision, core-wins, and zero-match rules', () => {
  const conventions = readFileSync(join(repoRoot, '.apex', 'conventions.md'), 'utf8');
  const match = conventions.match(/## Modular standards([\s\S]*?)(?=## |\Z)/);
  assert.ok(match, 'conventions.md must have a "## Modular standards" section');
  const section = match[1];
  assert.match(
    section,
    /human decision/i,
    'Modular standards section must state that splits are a human decision'
  );
  assert.match(
    section,
    /core wins/i,
    'Modular standards section must state the core-wins rule'
  );
  assert.match(
    section,
    /zero match|core only/i,
    'Modular standards section must document the zero-match load semantics'
  );
});

test('conventions.md Decision model defines Gear 4 with loop-engineer and goal contract', () => {
  const conventions = readFileSync(join(repoRoot, '.apex', 'conventions.md'), 'utf8');
  const match = conventions.match(/## Decision model \(conditional ceremony\)([\s\S]*?)(?=## |\Z)/);
  assert.ok(match, 'conventions.md must have a Decision model section');
  const section = match[1];
  assert.ok(section.includes('Gear 4'), 'Decision model must define Gear 4');
  assert.match(
    section,
    /loop-engineer/i,
    'Gear 4 definition must mention loop-engineer'
  );
  assert.match(
    section,
    /goal contract/i,
    'Gear 4 definition must mention goal contract'
  );
});

test('conventions.md Invariants include gear-4 downstream refusal and recorded override', () => {
  const conventions = readFileSync(join(repoRoot, '.apex', 'conventions.md'), 'utf8');
  const match = conventions.match(/\*\*Invariants:\*\*([\s\S]*?)(?=## |\Z)/);
  assert.ok(match, 'conventions.md must have an Invariants section');
  const section = match[1];
  assert.match(
    section,
    /gear.?4.*downstream.*refuse|refuse.*gear.?4|loop-engineer.*refuse/i,
    'Invariants must state that gear-4 downstream refuses without verdict artifact'
  );
  assert.match(
    section,
    /ratif|confirmation/i,
    'Invariants must mention ratification or confirmation'
  );
  assert.match(
    section,
    /recorded.*override|override.*recorded/i,
    'Invariants must mention recorded override'
  );
});

function glossaryEntry(glossary, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = glossary.match(new RegExp(`\\*\\*${escaped}\\*\\*[\\s\\S]*?(?=\\n- \\*\\*|$)`));
  return match ? match[0] : null;
}

test('glossary.md Gear entry\'s scale reaches gear 4', () => {
  const glossary = readFileSync(join(repoRoot, '.apex', 'glossary.md'), 'utf8');
  const entry = glossaryEntry(glossary, 'Gear');
  assert.ok(entry, 'glossary.md must have a Gear entry');
  assert.match(entry, /1.?4/, 'Gear entry must state the scale reaches 4');
  assert.match(entry, /gear 4/i, 'Gear entry must describe gear 4');
});

test('glossary.md skill-family entry documents the chain as five, with loop-engineer for gear 4, among three families of ten skills', () => {
  const glossary = readFileSync(join(repoRoot, '.apex', 'glossary.md'), 'utf8');
  const entry = glossaryEntry(glossary, 'Chain skill / Standalone skill / Pre-hub skill');
  assert.ok(entry, 'glossary.md must have a Chain skill / Standalone skill / Pre-hub skill entry');
  assert.match(entry, /five/i, 'entry must say the chain becomes five');
  assert.match(entry, /loop-engineer/, 'entry must mention loop-engineer');
  assert.match(entry, /gear 4/i, 'entry must relate loop-engineer to gear 4');
  const flatEntry = entry.replace(/\s+/g, ' ');
  assert.match(flatEntry, /three skill families of the ten canonical skills/i, 'entry must count three families and ten skills');
  assert.match(flatEntry, /`init`, `new-surface`, `check`, `discovery`/, 'entry must list the standalone hub-aware skills');
  assert.match(flatEntry, /pre-hub `inception` skill[^.]*needs no hub[^.]*no gear[^.]*`init`/i, 'entry must define the pre-hub family');
});

test('stable hub locks the pre-hub inception knowledge and keeps the local area out of stable docs', () => {
  const read = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8');
  const glossary = read('.apex', 'glossary.md');
  const conventions = read('.apex', 'conventions.md');
  const skills = read('.apex', 'standards', 'skills.md');

  const entry = (term) => glossaryEntry(glossary, term)?.replace(/\s+/g, ' ') ?? null;
  const run = entry('Inception run');
  assert.ok(run, 'glossary.md must define Inception run');
  assert.match(run, /pre-hub[^.]*`inception`[^.]*approved project[^.]*verified bootstrap[^.]*`init`/i);
  assert.match(run, /`\.apex\/inception\/<run-id>\/`[^.]*ignored[^.]*outside the hub DAG/i);
  const descriptor = entry('Inception descriptor');
  assert.ok(descriptor, 'glossary.md must define Inception descriptor');
  assert.match(descriptor, /`\.apex\/inception\/state\.json`[^.]*one canonical/i);
  assert.match(descriptor, /never proves approval or a valid hub/i);
  const handoff = entry('Inception handoff');
  assert.ok(handoff, 'glossary.md must define Inception handoff');
  assert.match(handoff, /`inception-handoff: steepy-apex\/v1`[\s\S]*`\.apex\/inception\/state\.json` for `state`[\s\S]*`approval`, `project`, `verification`, `confirmed-inputs`, `promotion`/);
  assert.match(handoff, /separate from the chain's `handoff: steepy-apex\/v1`/i);
  const promotion = entry('Promotion table');
  assert.ok(promotion, 'glossary.md must define Promotion table');
  assert.match(promotion, /promote[^.]*stable destination[^.]*exact text[^.]*exclude[^.]*reason/i);
  const receipt = entry('Init receipt');
  assert.ok(receipt, 'glossary.md must define Init receipt');
  assert.match(receipt, /input digests[\s\S]*one outcome per decision[\s\S]*gate/i);

  const section = conventions.match(/## Inception \(pre-hub\)\n([\s\S]*?)(?=\n## |$)/)?.[1];
  assert.ok(section, 'conventions.md must have an "## Inception (pre-hub)" section');
  const flat = section.replace(/\s+/g, ' ');
  assert.match(flat, /invents no specialist, standard, or bootstrap before `init`[^.]*no chain role, gear, handoff grammar, or controller/i);
  assert.match(flat, /own `\*` ignore guard before any document or state[^.]*outside the DAG, `validate-hub`, and every ordinary stable read/i);
  assert.match(flat, /descriptor and exact paths named for the current step[^.]*nothing is browsed or picked by recency/i);
  assert.match(flat, /approves the whole project once, before bootstrap[^.]*exact project bytes/i);
  assert.match(flat, /substantial change[^.]*targeted decision and a new approval/i);
  assert.match(flat, /official sources, explicit versions, and a verification date; no preset stack/i);
  assert.match(flat, /Helpers verify formats, paths, digests, and receipts; the skill owns dialogue, architecture judgement, evidence interpretation, and promotion decisions/i);
  assert.match(flat, /reuses the confirmed record, asks only for missing data, new decisions, or real conflicts, keeps the planner and Project model v1 unchanged/i);
  assert.match(flat, /per-decision receipt, a passing gate, and a hub that validates without `\.apex\/inception\/` or `\.apex\/work\/`/i);
  assert.match(flat, /Unbuilt intentions never appear as existing components; future flows stay context, not backlog/i);
  assert.match(flat, /`discovery` reads only stable knowledge and ordinary source[^.]*never re-approves/i);
  assert.match(conventions, /the ten skills in `skills\/`/);

  const flatSkills = skills.replace(/\s+/g, ' ');
  assert.match(flatSkills, /ten canonical skills in three families/i);
  assert.match(flatSkills, /`discovery` has its own prose dispatch policy; `inception` may delegate only under its exact-path rule; the rest do not dispatch/i);
  assert.match(flatSkills, /the pre-hub `inception` skill with its co-located `protocol\.md`, `reconnaissance\.md`, `architecture\.md`, `bootstrap\.md`, and `init-handoff\.md`/);
  assert.match(flatSkills, /`inception` loads one support file per phase[^.]*`protocol\.md` mirrors the helper formats and the helpers win/i);
  assert.match(flatSkills, /no gear-0, checklist, Model Selection lock, manual-handoff block, or workflow header/i);
  assert.match(flatSkills, /`init` checks for an inception transfer before its fresh\/repair fork/i);
  assert.match(flatSkills, /`discovery` and its explorer never read `\.apex\/inception\/\*\*` or `\.apex\/work\/\*\*` as knowledge/i);

  for (const path of stableApexMarkdownPaths()) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /\]\([^)]*\.apex\/inception\//, `${path} must not link local inception artifacts`);
  }
});

test('glossary.md defines Loop Engineer as the gear-4 mode and the human role', () => {
  const glossary = readFileSync(join(repoRoot, '.apex', 'glossary.md'), 'utf8');
  const entry = glossaryEntry(glossary, 'Loop Engineer');
  assert.ok(entry, 'glossary.md must have a Loop Engineer entry');
  assert.match(entry, /gear.?4/i, 'Loop Engineer entry must mention gear 4');
  assert.match(entry, /goal/i, 'Loop Engineer entry must mention the goal');
  assert.match(entry, /verifier/i, 'Loop Engineer entry must mention the verifier');
  assert.match(entry, /budget/i, 'Loop Engineer entry must mention the budget');
});

test('glossary.md defines Goal contract with its path and fields', () => {
  const glossary = readFileSync(join(repoRoot, '.apex', 'glossary.md'), 'utf8');
  const entry = glossaryEntry(glossary, 'Goal contract');
  assert.ok(entry, 'glossary.md must have a Goal contract entry');
  assert.match(entry, /\.apex\/work\/loops\/<YYYY-MM-DD>-<slug>\/goal\.md/, 'Goal contract entry must cite the exact artifact path');
  for (const field of ['verifier', 'mode', 'metric-direction', 'budget', 'blast-radius']) {
    assert.match(entry, new RegExp(field), `Goal contract entry must mention field ${field}`);
  }
  assert.match(entry, /verdict artifact/i, 'Goal contract entry must mention the gear-4 verdict artifact at its head');
  assert.match(entry, /human-ratified/i, 'Goal contract entry must say the human ratifies the authorization');
  assert.doesNotMatch(entry, /bootstrap/i, 'Goal contract authorization must stay outside bootstrap navigation');
});

test('glossary.md defines Loop ledger as the event-derived projection next to the goal contract', () => {
  const glossary = readFileSync(join(repoRoot, '.apex', 'glossary.md'), 'utf8');
  const entry = glossaryEntry(glossary, 'Loop ledger');
  assert.ok(entry, 'glossary.md must have a Loop ledger entry');
  assert.match(entry, /ledger\.md/, 'Loop ledger entry must name ledger.md');
  assert.match(entry, /goal contract/i, 'Loop ledger entry must relate to the goal contract');
  assert.match(entry, /deterministic\s+projection/i, 'Loop ledger entry must define the event-derived projection');
  assert.match(entry, /never the state authority/i, 'Loop ledger entry must deny state authority');
});

test('stable documentation locks the context-efficient autopilot contract and never links local work', () => {
  const stableDocs = [
    '.apex/conventions.md',
    '.apex/glossary.md',
    '.apex/standards/scripts.md',
    '.apex/standards/adapters.md',
    '.apex/standards/skills.md',
    '.apex/standards/tests.md',
    'docs/architecture.md',
    'docs/workflow.md',
    'README.md',
  ];
  for (const relativePath of stableDocs) {
    const text = readFileSync(join(repoRoot, relativePath), 'utf8');
    assert.doesNotMatch(
      text,
      /\]\([^)]*\.apex\/work\//,
      `${relativePath} must not link stable documentation into local .apex/work artifacts`
    );
  }

  const glossary = readFileSync(join(repoRoot, '.apex', 'glossary.md'), 'utf8');
  const autopilot = glossaryEntry(glossary, 'Autopilot contract');
  assert.ok(autopilot, 'glossary.md must define the Autopilot contract');
  assert.doesNotMatch(
    autopilot,
    /plus[^\n]*`budget`/,
    'gear-3 Autopilot contracts must not require budget'
  );
  assert.match(autopilot, /`budget` field is rejected[\s\S]*fresh and resumed/i);
  for (const term of ['Context manifest', 'Artifact-first completion', 'Resource-usage ledger']) {
    assert.ok(glossaryEntry(glossary, term), `glossary.md must define ${term}`);
  }

  const scripts = readFileSync(join(repoRoot, '.apex', 'standards', 'scripts.md'), 'utf8');
  assert.match(scripts, /manifest validation.*writes|manifest writes.*validation/is);
  assert.match(scripts, /artifact-first/i);
  assert.match(scripts, /resource-usage ledger/i);
  assert.match(scripts, /I\/O integrity timeout/i);
  assert.match(scripts, /no work timer/i);
  const manifestOwnership = scripts.match(
    /- The conductor owns deterministic versioned context manifest validation and writes,[\s\S]*?(?=\n- |\n## )/
  )?.[0];
  assert.ok(manifestOwnership, 'scripts must keep a local context-manifest ownership contract');
  assert.match(manifestOwnership, /implement skill\/controller validates/i);
  assert.match(manifestOwnership, /manual\/legacy v1 four fields; v2 semantic status\/artifact\/signals/i);
  assert.match(scripts, /phase-scoped measurements[\s\S]{0,220}must not be summed/i);

  const adapters = readFileSync(join(repoRoot, '.apex', 'standards', 'adapters.md'), 'utf8');
  assert.match(adapters, /concrete model apply\/degrade/i);
  assert.match(adapters, /direct provider usage evidence/i);
  assert.match(adapters, /never owns workflow policy/i, 'adapters must not own workflow policy');

  const skills = readFileSync(join(repoRoot, '.apex', 'standards', 'skills.md'), 'utf8');
  assert.match(skills, /self-contained briefs/i);
  assert.match(skills, /role-local manifests/i);
  assert.match(skills, /Manual drive and legacy autopilot protocol 1[^\n]*exact ordered four-field shape/i);
  assert.match(skills, /taskResultProtocol: 2[^]*responses contain status, artifact, signals/i);
  assert.match(skills, /abstract\s+tiers/i);
  assert.match(skills, /implement\s+skill\/controller/i, 'implement owns four-field envelope validation');

  const tests = readFileSync(join(repoRoot, '.apex', 'standards', 'tests.md'), 'utf8');
  for (const term of ['comparative reachability', 'irrelevant-absence fixture', 'descriptor vectors', 'usage provenance', 'no-stop', 'content locks']) {
    assert.match(tests, new RegExp(term, 'i'), `tests standard must own ${term}`);
  }
  assert.match(tests, /Generated prompt bytes shrink independently for every phase/i);
  assert.match(tests, /three-phase workflow total strictly shrinks/i);

  const architecture = readFileSync(join(repoRoot, 'docs', 'architecture.md'), 'utf8');
  const workflow = readFileSync(join(repoRoot, 'docs', 'workflow.md'), 'utf8');
  assert.match(workflow, /verdict\/gear\/drive come from manifest contract scalars/i);
  assert.match(workflow, /modular routes preserve the exact core and leaf links/i);
  assert.match(workflow, /plan[^.]*required spec[^.]*exact paths\/topics[\s\S]{0,220}review[^.]*criteria[^.]*task-result index[^.]*branch diff/i);
  assert.match(workflow, /every matching leaf[^.]*concrete reason/i);
  assert.match(workflow, /zero matches[^.]*core only[^.]*no read-all fallback/i);
  assert.doesNotMatch(architecture, /phase timeout/i, 'healthy work must not halt on a phase timeout');
  assert.match(architecture, /finite phase\/task lifecycle/i);
  assert.match(architecture, /effective abstract controller tier/i);
  for (const [name, text] of [['workflow', workflow], ['architecture', architecture]]) {
    assert.match(text, /exact retransmissions[^.]*deduplicat/i, `${name} must scope dedupe to retransmissions`);
    assert.match(text, /distinct[^.]*phase[^.]*aggregate[\s\S]{0,220}(?:must not|cannot|not safe to) (?:be )?summ/i,
      `${name} must prohibit summing distinct phase aggregates without scope evidence`);
    assert.doesNotMatch(text, /so (?:there is|no) no double-count|so no double-count occurs/i,
      `${name} must not infer no double-count from persistence dedupe`);
  }
  assert.match(architecture, /I\/O integrity timeout/i);
  assert.doesNotMatch(architecture, /artifact-first child completion/i, 'the conductor must not own envelope validation');
  assert.match(architecture, /implement skill\/controller/i, 'architecture must assign envelope validation to implement');

  assert.doesNotMatch(workflow, /budget timeout/i, 'gear-3 workflow must not have a budget timeout');
  assert.match(workflow, /resource JSONL/i);
  assert.match(workflow, /`budget` field is rejected[\s\S]*fresh and resumed/i);
  assert.match(workflow, /I\/O integrity timeout/i);
  assert.match(workflow, /stop-before-PR/i);

  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  assert.match(readme, /efficiency/i);
  assert.match(readme, /observability/i);
  assert.match(readme, /docs\/workflow\.md/);
});

test('glossary.md defines Keep/discard for boolean and metric verifier policy', () => {
  const glossary = readFileSync(join(repoRoot, '.apex', 'glossary.md'), 'utf8');
  const entry = glossaryEntry(glossary, 'Keep/discard');
  assert.ok(entry, 'glossary.md must have a Keep/discard entry');
  assert.match(entry, /commit/i, 'Keep/discard entry must mention commit for keep');
  assert.match(entry, /revert/i, 'Keep/discard entry must mention revert for discard');
  assert.match(entry, /recorded|record/i, 'Keep/discard entry must say the attempt is recorded regardless');
  assert.match(entry, /boolean/i, 'Keep/discard entry must define boolean mode');
  assert.match(entry, /metric/i, 'Keep/discard entry must define metric mode');
});

test('glossary.md defines Verifier as a deterministic boolean/metric command, never a model judgment', () => {
  const glossary = readFileSync(join(repoRoot, '.apex', 'glossary.md'), 'utf8');
  const entry = glossaryEntry(glossary, 'Verifier');
  assert.ok(entry, 'glossary.md must have a Verifier entry');
  assert.match(entry, /boolean/i, 'Verifier entry must mention boolean mode');
  assert.match(entry, /metric/i, 'Verifier entry must mention metric mode');
  assert.match(entry, /never a model judgment/i, 'Verifier entry must say never a model judgment');
});

test('glossary.md Verdict artifact entry also covers a gear-4 goal contract', () => {
  const glossary = readFileSync(join(repoRoot, '.apex', 'glossary.md'), 'utf8');
  const entry = glossaryEntry(glossary, 'Verdict artifact');
  assert.ok(entry, 'glossary.md must have a Verdict artifact entry');
  assert.match(entry, /gear-4 goal contract/i, 'Verdict artifact entry must extend to a gear-4 goal contract');
});

test('standards/skills.md documents the chain as five skills, naming loop-engineer', () => {
  const skillsStandard = readFileSync(join(repoRoot, '.apex', 'standards', 'skills.md'), 'utf8');
  assert.match(skillsStandard, /the five chain skills/i, 'skills.md Conventions must say "the five chain skills"');
  assert.match(skillsStandard, /loop-engineer/, 'skills.md must name loop-engineer');
});

test('standards/skills.md lists the loop-engineer co-located prompt templates', () => {
  const skillsStandard = readFileSync(join(repoRoot, '.apex', 'standards', 'skills.md'), 'utf8');
  assert.match(
    skillsStandard,
    /loop-engineer\/loop-implementer-prompt\.md/,
    'skills.md must list loop-engineer/loop-implementer-prompt.md'
  );
  assert.match(
    skillsStandard,
    /loop-engineer\/loop-final-review-prompt\.md/,
    'skills.md must list loop-engineer/loop-final-review-prompt.md'
  );
});

test('standards/skills.md makes review evidence capture inline and receipt-bounded', () => {
  const skillsStandard = readFileSync(join(repoRoot, '.apex', 'standards', 'skills.md'), 'utf8');
  assert.doesNotMatch(skillsStandard, /review\/evidence-prompt\.md/);
  assert.match(skillsStandard, /`review` collects command evidence inline through `capture-review-evidence\.mjs`/);
  assert.match(skillsStandard, /complete combined stdout\/stderr transcript[^.]*`evidence-report\.md`/i);
  assert.match(skillsStandard, /model context receives only[^.]*bounded receipt/i);
});

test('standards/skills.md Conventions states the plan task-cutting criterion (discovery belongs to plan)', () => {
  const skillsStandard = readFileSync(join(repoRoot, '.apex', 'standards', 'skills.md'), 'utf8');
  const match = skillsStandard.match(/## Conventions\n([\s\S]*?)(?=\n## |$)/);
  assert.ok(match, 'skills.md must have a "## Conventions" section');
  const section = match[1];
  assert.match(section, /`plan`[\s\S]{0,120}discover/i, "Conventions must state plan's task-cutting criterion");
  assert.match(section, /mis-cut/i, 'the criterion must name a mis-cut task');
});

test('docs/inception.md documents the greenfield path end to end and stays self-sufficient', () => {
  const path = join(repoRoot, 'docs', 'inception.md');
  assert.ok(existsSync(path), 'docs/inception.md must exist');
  const text = readFileSync(path, 'utf8');
  const flat = text.replace(/\s+/g, ' ');

  assert.match(flat, /needs no hub to start/i, 'must state inception needs no hub');
  assert.match(flat, /hands off to `init`/i, 'must state the handoff to init');

  for (const material of ['Empty', 'Starter', 'Design system', 'UI/UX prototype']) {
    assert.match(flat, new RegExp(`\\*\\*${material}\\*\\*`), `must list starting material: ${material}`);
  }
  assert.match(flat, /real \(working code, real data, a real integration\) or simulated/i,
    'must distinguish real from simulated elements');
  assert.match(flat, /mature application[^.]*out of scope/i, 'must exclude mature applications from scope');

  for (const phase of ['Reconnaissance', 'Architecture', 'Research', 'Approval', 'Bootstrap', 'Verification', 'Init']) {
    assert.match(flat, new RegExp(`\\*\\*${phase}\\*\\*`), `must name phase: ${phase}`);
  }
  assert.match(flat, /representative path/i, 'must describe the representative path');

  assert.match(flat, /approve the whole project once[^.]*before bootstrap starts/i,
    'must describe the one-time approval before bootstrap');
  assert.match(flat, /substantial[^.]*database, a boundary, a flow, the design, the deploy choice, or a foundational technology/i,
    'must enumerate what counts as a substantial change');
  assert.match(flat, /targeted decision and a new approval/i, 'must require a new approval for a substantial change');

  assert.match(flat, /configured\*\*, \*\*executed\*\*, \*\*succeeded\*\*, \*\*not-executed\*\*, or \*\*failed/i,
    'must keep verification results distinct');

  assert.match(flat, /deploy is optional/i, 'must state deploy is optional');
  assert.match(flat, /excluded deploy is not a shortcut/i, 'must not let excluded deploy skip verification claims');
  assert.match(flat, /never reported as succeeded without evidence/i, 'must never claim deploy success without evidence');

  assert.match(flat, /resume reads only the exact files/i, 'must describe exact-path resume');
  assert.match(flat, /never by browsing the run's own local directory/i, 'must forbid directory listing on resume');

  assert.match(flat, /`init` reuses everything the run already confirmed/i, 'must describe init reuse');
  assert.match(flat, /no deferred flow starts an implicit backlog/i, 'must deny an implicit backlog');
  assert.match(flat, /without the run's local, gitignored records/i, 'must state the hub stands without local records');

  assert.match(flat, /proposes no default stack/i, 'must not promise a universal stack');
  assert.match(flat, /no fixed document count/i, 'must not promise a fixed document count');

  assert.doesNotMatch(text, /\]\([^)]*\.apex\/work\//, 'must not link local .apex/work artifacts');
  assert.doesNotMatch(text, /\]\([^)]*\.apex\/inception\//, 'must not link local .apex/inception artifacts');
  assert.doesNotMatch(text, /\.apex\/work\/specs|\.apex\/work\/plans/, 'must not reference concrete spec/plan work paths');
});

// The native acceptance protocol is a stable, packaged document: reproducible
// inputs and judging rules, one closed result vocabulary, and results that a
// hermetic test can never supply. A result other than PENDING must carry the
// observation that produced it.
const ACCEPTANCE_RESULTS = ['PENDING', 'PASS', 'PARTIAL', 'FAIL', 'NOT RUN', 'BLOCKED'];
const HARNESS_RESULTS = ['PENDING', 'OBSERVED', 'FAIL', 'NOT RUN'];
const CRITERION_OUTCOMES = ['PASS', 'PARTIAL', 'FAIL', 'NOT OBSERVED', 'NOT RUN'];

function markdownTable(text, heading) {
  const section = text.split(`${heading}\n`)[1]?.split(/\n#{2,} /u)[0] ?? '';
  const rows = section.split('\n').filter((line) => line.startsWith('|'));
  assert.ok(rows.length >= 3, `${heading} must hold a table`);
  const cells = (line) => line.slice(1, -1).split('|').map((cell) => cell.trim());
  const header = cells(rows[0]);
  return rows.slice(2).map((line) => Object.fromEntries(cells(line).map((cell, index) => [header[index], cell])));
}

// A result table that records runs names every run's approver, first word
// `model` or `human`; only a human approver who is not a model can pass the
// approval criterion.
function assertObservedResult(row, label, { vocabulary = ACCEPTANCE_RESULTS, approver = false } = {}) {
  assert.ok(vocabulary.includes(row.Result), `${label}: result '${row.Result}' is outside the closed vocabulary`);
  if (approver) assert.ok(Object.hasOwn(row, 'Approver'), `${label}: the table keeps its Approver column`);
  if (row.Result === 'PENDING') return;
  assert.match(row['Observed on'], /^\d{4}-\d{2}-\d{2}$/u, `${label}: a ${row.Result} needs its observation date`);
  if (!(row.Result === 'NOT RUN' && /\bnot installed\b/iu.test(row['Harness and version']))) {
    assert.match(row['Harness and version'], /\S+ \S*\d/u, `${label}: a ${row.Result} needs the harness and its version`);
  }
  assert.match(row['Plugin revision'], /^`[0-9a-f]{7,40}`$/u, `${label}: a ${row.Result} needs the plugin revision`);
  if (approver) {
    assert.match(row.Approver, /^(?:model|human)\b/iu, `${label}: a ${row.Result} names its approver first, a model or a human`);
  }
  if (!['PASS', 'OBSERVED'].includes(row.Result)) {
    assert.match(row.Limits ?? row.Notes ?? '', /\w{3}/u, `${label}: a ${row.Result} states its reason`);
  }
}

const humanApprover = (approver) => /^human\b/iu.test(approver ?? '') && !/\bmodel\b/iu.test(approver);

// A criterion table uses legend criteria, an outcome from its own closed
// vocabulary, and a reason per row. Unless every approver is a human, the
// approval criterion is never PASS.
function assertCriterionTable(text, heading, criteria, approvers, label) {
  const rows = markdownTable(text, heading);
  for (const row of rows) {
    assert.ok(criteria.includes(row.Criterion), `${label}: '${row.Criterion}' is a legend criterion`);
    assert.ok(CRITERION_OUTCOMES.includes(row.Outcome), `${label} / ${row.Criterion}: outcome '${row.Outcome}' is outside the closed vocabulary`);
    assert.match(row.Reason ?? '', /\w{3}/u, `${label} / ${row.Criterion}: the outcome states its reason`);
  }
  if (!approvers.every(humanApprover)) {
    const approval = rows.find((row) => /^Approval\b/u.test(row.Criterion));
    assert.notEqual(approval?.Outcome, 'PASS', `${label}: a model approval never passes the approval gate`);
  }
  return rows;
}

test('docs/inception-acceptance.md is a reproducible native protocol whose results only native observation fills', () => {
  const path = join(repoRoot, 'docs', 'inception-acceptance.md');
  assert.ok(existsSync(path), 'docs/inception-acceptance.md must exist');
  const text = readFileSync(path, 'utf8');
  const flat = text.replace(/\s+/g, ' ');

  for (const [scenario, ecosystem] of [
    ['A', /JavaScript or TypeScript/u],
    ['B', /may reuse scenario A's ecosystem/iu],
    ['C', /Python or another ecosystem that is not JavaScript/u],
  ]) {
    const section = text.split(new RegExp(`\\n### Scenario ${scenario} — `, 'u'))[1]?.split(/\n### |\n## /u)[0];
    assert.ok(section, `must define scenario ${scenario}`);
    for (const label of ['Inputs', 'Observe', 'Judge', 'Ecosystem']) {
      assert.match(section, new RegExp(`\\*\\*${label}:\\*\\*`, 'u'), `scenario ${scenario} must state ${label}`);
    }
    assert.match(section.replace(/\s+/g, ' '), ecosystem, `scenario ${scenario} ecosystem`);
  }
  assert.match(flat, /through the public `inception` skill in a real harness/i, 'proofs run the public skill natively');
  assert.match(flat, /at least one scenario interrupts and resumes/i, 'a resume must be observed natively');

  for (const result of ['PARTIAL', 'OBSERVED', 'NOT OBSERVED']) {
    assert.match(flat, new RegExp(`\`${result}\` \\(`, 'u'), `the judging rules must define ${result}`);
  }
  assert.match(flat, /A partial proof stays open/i, 'a partial proof stays open');
  const criteria = markdownTable(text, '### Criteria').map((row) => row.Criterion);
  assert.equal(criteria.length, 16, 'the criteria legend names every criterion');
  assert.ok(criteria.some((name) => /^Approval\b/u.test(name)), 'the legend names the approval criterion');

  const scenarios = markdownTable(text, '## Scenario results');
  assert.deepEqual(scenarios.map((row) => row.Scenario), ['A', 'B', 'C']);
  scenarios.forEach((row) => assertObservedResult(row, `scenario ${row.Scenario}`, { approver: true }));
  let resultTables = 2;
  let criterionTables = 0;
  for (const scenario of scenarios.filter((row) => row.Result !== 'PENDING')) {
    const label = `scenario ${scenario.Scenario}`;
    const rows = assertCriterionTable(text, `### Scenario ${scenario.Scenario} result`, criteria, [scenario.Approver], label);
    assert.deepEqual(rows.map((row) => row.Criterion), criteria, `${label} lists every criterion in order`);
    criterionTables += 1;
  }
  if (text.includes('\n## Populated-hub re-check\n')) {
    const runs = markdownTable(text, '## Populated-hub re-check');
    runs.forEach((row) => assertObservedResult(row, `re-check ${row.Run}`, { approver: true }));
    assertCriterionTable(text, '### Re-check criteria', criteria, runs.map((row) => row.Approver), 're-check');
    resultTables += 1;
    criterionTables += 1;
  }
  const harnesses = markdownTable(text, '## Harness discovery and invocation matrix');
  assert.deepEqual(harnesses.map((row) => row.Harness), ['Claude Code', 'Codex', 'OpenCode', 'Pi', 'DeepSeek Harness']);
  harnesses.forEach((row) => assertObservedResult(row, row.Harness, { vocabulary: HARNESS_RESULTS }));
  const headers = text.split('\n').filter((line) => line.startsWith('|'));
  assert.equal(headers.filter((line) => /\|\s*Result\s*\|\s*Observed on\s*\|/u.test(line)).length, resultTables,
    'every result table sits under a checked heading');
  assert.equal(headers.filter((line) => /^\|\s*Criterion\s*\|\s*Outcome\s*\|/u.test(line)).length, criterionTables,
    'every criterion table sits under a checked heading');
  assert.match(flat, /fake-host[^.]*not native evidence/i, 'fixture and fake-host tests are not native evidence');

  assert.match(flat, /model approver/i, 'must state the approver used by native runs of this release');
  assert.match(flat, /never counts as observed human approval/i, 'a model-approved PASS is not human approval');
  assert.match(flat, /A blocked proof stays open/i, 'a blocked proof stays open');
  assert.match(flat, /`tests\/inception-integration\.test\.mjs`[^.]*not native evidence/i, 'the hermetic suite is not native evidence');
  assert.match(flat, /no paid service, publication, or real deploy/i);
  assert.match(flat, /No proof runs an uncertain or a real deploy/i, 'no deploy is run or simulated');
  assert.match(flat, /crash between a receipt write and its descriptor write[^.]*resumes by observing[^.]*never repeats/i,
    'must name the real hermetic analog of an uncertain effect');
  assert.match(flat, /uncertain[^.]*deploy[^.]*locked only as skill text[^.]*native observation/i,
    'deploy-specific uncertain-outcome reconciliation needs native observation');
  assert.doesNotMatch(flat, /(?:deploy|uncertain)[^.]*simulat[^.]*hermetic|hermetic[^.]*simulat[^.]*(?:deploy|uncertain)/i,
    'must not claim a hermetic deploy or uncertain-outcome simulation');
  assert.match(flat, /`<redacted>`/u, 'must state the redaction form');

  assert.doesNotMatch(text, /\]\([^)]*\.apex\/(?:work|inception)\//u, 'must not link local artifacts');
  assert.doesNotMatch(text, /\/(?:Users|home)\/[a-z]|[A-Z]:\\\\Users|\/private\/var\/|\/tmp\/steepy/u, 'must not carry local absolute paths');
  assert.doesNotMatch(text, /\/var\/folders\/|\/private\/tmp\/|(?:^|[\s(`'"])\/tmp\/|~\/\.[a-z]|\$(?:TMPDIR|HOME)\b/u,
    'must not carry a temporary, workspace, or home path');
  assert.doesNotMatch(text, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu, 'must not carry a session or run ID');
  assert.doesNotMatch(text, /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/iu, 'must not carry an email address');
  assert.doesNotMatch(text, /\b(?:sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,})|Bearer [A-Za-z0-9._-]{8,}/u,
    'must not carry a credential');
});

test('standards/tests.md keeps the hermetic inception matrix apart from the native acceptance protocol', () => {
  const tests = readFileSync(join(repoRoot, '.apex', 'standards', 'tests.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(tests, /`inception-integration`/u, 'must name the hermetic vertical suite');
  assert.match(tests, /\[Inception acceptance\]\(\.\.\/\.\.\/docs\/inception-acceptance\.md\)/u, 'must link the native protocol');
  assert.match(tests, /model approver/i, 'must state the approver boundary');
});

test('README introduces the greenfield inception entry alongside init and links docs/inception.md', () => {
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  assert.match(readme, /\|\s*`\/steepy-apex:inception`\s*\|/, 'Skills table must list /steepy-apex:inception');
  assert.match(readme, /new application with no code yet/i, 'Get started must name the greenfield entry point');
  assert.match(readme, /\[docs\/inception\.md\]\(docs\/inception\.md\)/, 'README must link docs/inception.md');
  const getStartedIdx = readme.indexOf('## Get started');
  assert.ok(getStartedIdx !== -1, 'README must have a "## Get started" section');
  const inceptionMentionIdx = readme.indexOf('inception', getStartedIdx);
  const initStepIdx = readme.indexOf('/steepy-apex:init` - Initialize', getStartedIdx);
  assert.ok(
    inceptionMentionIdx !== -1 && initStepIdx !== -1 && inceptionMentionIdx < initStepIdx,
    'README must introduce the greenfield entry before the ordinary numbered init step'
  );
});

test('_INDEX.md separates the stable DAG from both local areas and states the pre-hub exception', () => {
  const index = readFileSync(join(repoRoot, '.apex', '_INDEX.md'), 'utf8');
  const flat = index.replace(/\s+/g, ' ');
  assert.match(flat, /excludes `\.apex\/work\/\*\*` and `\.apex\/inception\/\*\*`/,
    '_INDEX.md must exclude both local areas from the anti-orphan check');
  assert.match(flat, /pre-hub `inception` run in progress/i, '_INDEX.md must name the pre-hub exception');
  assert.match(flat, /without ever treating it as a coherent hub/i, '_INDEX.md must deny pre-hub coherence');
  assert.match(flat, /never by listing the directory/i, '_INDEX.md must forbid directory listing of inception');
});

test('glossary.md defines Approved project, Representative path, Verified result, and Deferred flow', () => {
  const glossary = readFileSync(join(repoRoot, '.apex', 'glossary.md'), 'utf8');
  const flatEntry = (term) => glossaryEntry(glossary, term)?.replace(/\s+/g, ' ') ?? null;

  const approved = flatEntry('Approved project');
  assert.ok(approved, 'glossary.md must define Approved project');
  assert.match(approved, /exact digests of that approved text/i);
  assert.match(approved, /new approval at a new path/i);

  const path = flatEntry('Representative path');
  assert.ok(path, 'glossary.md must define Representative path');
  assert.match(path, /crosses its agreed boundaries end to end/i);
  assert.match(path, /other flows stay recorded context/i);

  const verified = flatEntry('Verified result');
  assert.ok(verified, 'glossary.md must define Verified result');
  assert.match(verified, /configured[\s\S]*executed[\s\S]*succeeded[\s\S]*not-executed[\s\S]*failed/i);

  const deferred = flatEntry('Deferred flow');
  assert.ok(deferred, 'glossary.md must define Deferred flow');
  assert.match(deferred, /project-context\.md/);
  assert.match(deferred, /never as an existing component, a spec, or a started backlog item/i);
});

test('conventions.md distinguishes the DAG, work, and inception local areas and points to the public guide', () => {
  const conventions = readFileSync(join(repoRoot, '.apex', 'conventions.md'), 'utf8');
  const section = conventions.match(/## Inception \(pre-hub\)\n([\s\S]*?)(?=\n## |$)/)?.[1];
  assert.ok(section, 'conventions.md must have an "## Inception (pre-hub)" section');
  const flat = section.replace(/\s+/g, ' ');
  assert.match(flat, /three distinct areas/i, 'must call out three distinct areas');
  assert.match(flat, /only the DAG is versioned and reachable from `_INDEX\.md`/i);
  assert.match(flat, /\[docs\/inception\.md\]\(\.\.\/docs\/inception\.md\)/, 'must link the public walkthrough');
});

test("standards/skills.md notes the public inception walkthrough is outside this standard's ownership", () => {
  const skillsStandard = readFileSync(join(repoRoot, '.apex', 'standards', 'skills.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(skillsStandard, /docs\/inception\.md/, 'skills.md must reference docs/inception.md');
  assert.match(skillsStandard, /outside this standard's ownership/i);
});

test('docs/architecture.md rows for stable-paths, validate-hub, inception-state, and inception-handoff match their implementation', () => {
  const architecture = readFileSync(join(repoRoot, 'docs', 'architecture.md'), 'utf8');
  const row = (script) => architecture.match(new RegExp(`\\| \`${script}\\.mjs\` \\|([^\\n]*)\\|`))?.[1] ?? '';

  const stablePaths = row('stable-paths');
  assert.match(stablePaths, /`\.apex\/inception`/, 'stable-paths.mjs row must name .apex/inception');
  assert.match(stablePaths, /readStableDocument/, 'stable-paths.mjs row must name readStableDocument');

  const validateHub = row('validate-hub');
  assert.match(validateHub, /pre-hub `inception` state/i, 'validate-hub.mjs row must document pre-hub recognition');
  assert.match(validateHub, /never counts as pre-hub|not[^.]*coherent hub/i);

  const inceptionState = row('inception-state');
  assert.match(inceptionState, /observeRepositoryRevision/, 'inception-state.mjs row must name observeRepositoryRevision');
  assert.match(inceptionState, /assertInceptionTransition/, 'inception-state.mjs row must name assertInceptionTransition');

  const inceptionHandoff = row('inception-handoff');
  assert.match(inceptionHandoff, /checkpoint inventory path[^.]*is refused/i,
    'inception-handoff.mjs row must document the destination/checkpoint non-overlap rule');
});

test('standards/tests.md keeps the structural-lock inventory at ten skills and flags duplicated fixture helpers', () => {
  const testsStandard = readFileSync(join(repoRoot, '.apex', 'standards', 'tests.md'), 'utf8');
  assert.match(testsStandard, /ten-skill, five-harness inventory/i, 'must update the stale nine-skill count');
  assert.doesNotMatch(testsStandard, /nine-skill/i, 'must not still say nine-skill');
  assert.match(testsStandard, /fs-access recorder/i, 'must flag the duplicated fs-access recorder');
  assert.match(testsStandard, /`withTemp`\/`put`\/`git`/, 'must flag the duplicated withTemp/put/git helpers');
});

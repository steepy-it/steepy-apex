// Content-lock suite for the pre-hub `inception` skill (skills/inception/**).
//
// These are instruction checks. They lock what the shipped prose says, and they
// prove that the record examples and helper command lines it documents are
// accepted by the real helpers (scripts/inception-state.mjs and
// scripts/inception-handoff.mjs). They do not prove that a model follows the
// workflow, and they are never evidence that a real application bootstrap ran:
// that needs native runs outside this suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyInceptionPath, sha256Hex } from '../scripts/inception-paths.mjs';
import {
  INCEPTION_PHASES,
  parseInceptionState,
  serializeInceptionState,
} from '../scripts/inception-state.mjs';
import {
  INCEPTION_HANDOFF_ROLES,
  serializeCodeCheckpoint,
  validateApprovalRecord,
  validateCodeCheckpoint,
  validateConfirmedInputs,
  validateInceptionHandoff,
  validatePromotionCoverage,
  validatePromotionTable,
} from '../scripts/inception-handoff.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const skillDir = join(root, 'skills', 'inception');
const read = (name) => readFileSync(join(skillDir, name), 'utf8');
const RUN = '0f8e6b8a-3c1d-4e2f-9a7b-5c6d7e8f9a0b';
const PHASE_FILES = ['reconnaissance.md', 'architecture.md', 'bootstrap.md', 'init-handoff.md'];
const SUPPORT_FILES = ['protocol.md', ...PHASE_FILES];
const TEMPLATES = [
  'inception-project.md',
  'inception-verification.md',
  'project-context.md',
  'project-architecture.md',
];

function section(text, start, end) {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `missing heading '${start}'`);
  const to = end ? text.indexOf(end, from + start.length) : -1;
  return to === -1 ? text.slice(from) : text.slice(from, to);
}

function flat(text) {
  return text.replace(/\s+/g, ' ');
}

function jsonBlockAfter(text, heading) {
  const body = section(text, heading);
  const match = body.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(match, `missing JSON block after '${heading}'`);
  return { value: JSON.parse(match[1]), text: `${match[1]}\n` };
}

function tableRows(text) {
  return text.split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .slice(1)
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

test('inception: SKILL.md is a user-invocable open-subset skill with the byte-exact engine-root block', () => {
  const text = read('SKILL.md');
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)?.[1];
  assert.ok(frontmatter, 'inception must carry YAML frontmatter');
  assert.match(frontmatter, /^name: inception$/m);
  assert.match(frontmatter, /^description: \S.{20,}$/m);
  assert.match(frontmatter, /^user-invocable: true$/m);
  const engineRootBlock =
    '> **Engine root:** this skill\'s base directory is `<engine-root>/skills/inception/`; engine\n' +
    '> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base\n' +
    '> directory your harness reports for this skill.';
  assert.ok(text.includes(engineRootBlock), 'inception must carry the byte-exact Engine-root block');
  for (const name of ['SKILL.md', ...SUPPORT_FILES]) {
    const body = read(name);
    assert.doesNotMatch(body, /CLAUDE_/, `${name} must stay harness-neutral`);
    assert.doesNotMatch(body, /\/steepy(?:-apex)?:/, `${name} must name skills semantically`);
  }
});

test('inception: it is the pre-hub family, with no hub prerequisite, gear, chain machinery, or invented hub artifact', () => {
  const text = read('SKILL.md');
  const intro = flat(section(text, '# inception', '> **Engine root:**'));
  assert.match(intro, /needs no `\.apex` hub/i);
  assert.match(intro, /not one of the five chain skills/i);
  assert.match(intro, /no gear/i);
  assert.match(intro, /no chain role, handoff grammar, or controller/i);
  assert.match(intro, /creates no hub artifact[^.]*routing[^.]*standard[^.]*specialist[^.]*bootstrap/i);
  for (const name of ['SKILL.md', ...SUPPORT_FILES]) {
    const body = read(name);
    assert.doesNotMatch(body, /### Step 0 — Read the gear/, `${name} must not copy the chain gear read`);
    assert.doesNotMatch(body, /^## (?:Checklist|Model Selection)$/m, `${name} must not carry chain-only sections`);
    assert.doesNotMatch(body, /steepy:manual-handoff|steepy-workflow:/, `${name} must not carry chain handoff markers`);
  }
});

test('inception: Step 0 routes every inspected state, an operational hub, and a mature application before any write', () => {
  const text = read('SKILL.md');
  const step0 = section(text, '## Step 0', '## Step 1');
  assert.ok(step0.includes(
    'node <engine-root>/scripts/inception-state.mjs inspect --root . --state .apex/inception/state.json',
  ), 'Step 0 must classify through the descriptor helper');
  const routes = flat(step0);
  for (const state of ['absent', 'incomplete', 'pre-hub', 'init-in-progress', 'init-complete', 'invalid']) {
    assert.match(routes, new RegExp(`(?:^| )- \`${state}\`[^→]*→`), `Step 0 must route ${state} from its own bullet`);
  }
  assert.match(routes, /empty repository, a starter, a design system, or a UI\/UX prototype → start a run/i);
  assert.match(routes, /mature application[^→]*→ do not start; recommend `init`, then `discovery`/i);
  assert.match(routes, /`_INDEX\.md` → the hub is operational; use the ordinary workflows/i);
  assert.match(routes, /`invalid` → stop[^.]*reason\. Repair nothing automatically/i);
  assert.match(routes, /more than one route[^.]*present the routes and let the user decide/i);
  assert.match(routes, /- `pre-hub` without `_INDEX\.md` → a run exists; resume it/i);
  assert.match(routes, /`pre-hub` or `incomplete` with `_INDEX\.md` → a leftover run beside an operational hub: report it and ask the user\. Never resume it automatically/i);
  assert.ok(text.indexOf('## Step 0') < text.indexOf('inception-state.mjs start'), 'classification precedes start');
  assert.match(flat(section(text, '## Step 1', '## Phases')), /never overwrites a run[^.]*\.[^.]*tracked[^.]*never run `git rm`/i);
});

test('inception: the phase table maps every descriptor phase to one co-located support file with an exit condition', () => {
  const text = read('SKILL.md');
  const phases = section(text, '## Phases', '## Stop');
  const rows = tableRows(phases);
  const mapped = rows.map(([phase]) => phase.replace(/`/g, ''));
  assert.deepEqual(mapped, [...INCEPTION_PHASES], 'the table must cover the helper phases in order');
  for (const [phase, load, exit] of rows) {
    const file = load.replace(/`/g, '');
    assert.ok(PHASE_FILES.includes(file), `${phase} must load a phase support file, got ${load}`);
    assert.ok(existsSync(join(skillDir, file)), `${file} must be co-located with SKILL.md`);
    assert.ok(exit.length > 10, `${phase} must state when the phase ends`);
  }
  assert.deepEqual([...new Set(rows.map(([, load]) => load.replace(/`/g, '')))].sort(), [...PHASE_FILES].sort());
  assert.match(flat(phases), /Load one support file per phase, when the phase starts/i);
  assert.match(flat(phases), /Load `protocol\.md` before the first write under `\.apex\/inception\/` and before every descriptor update/i);
  assert.deepEqual(
    readdirSync(skillDir).sort(),
    ['SKILL.md', ...SUPPORT_FILES].sort(),
    'skills/inception holds exactly SKILL.md and its five support files',
  );
});

test('inception: each phase support file declares its own phases and loads nothing eagerly', () => {
  const rows = tableRows(section(read('SKILL.md'), '## Phases', '## Stop'));
  for (const file of PHASE_FILES) {
    const phases = rows.filter(([, load]) => load.replace(/`/g, '') === file).map(([phase]) => phase);
    const opening = flat(read(file).split('\n## ')[0]);
    assert.match(opening, /Load this when the descriptor phase is/i, `${file} must say when it loads`);
    for (const phase of phases) assert.ok(opening.includes(phase), `${file} must name its phase ${phase}`);
    for (const other of PHASE_FILES.filter((name) => name !== file)) {
      assert.doesNotMatch(opening, new RegExp(other.replace('.', '\\.')), `${file} must not preload ${other}`);
    }
  }
  assert.match(flat(read('protocol.md').split('\n## ')[0]), /Load it before the first write under `\.apex\/inception\/` and before every descriptor update/i);
});

test('inception: the whole-run rules keep dialogue, approval scope, stack neutrality, exact reads, and the helper boundary', () => {
  const rules = flat(section(read('SKILL.md'), '## Rules for every phase', '## Step 0'));
  assert.match(rules, /one question at a time[^.]*numbered options and a recommendation/i);
  assert.match(rules, /approves the whole project once, before bootstrap/i);
  assert.match(rules, /on your own inside the approved scope/i);
  assert.match(rules, /substantial change needs a targeted decision and a new approval/i);
  assert.match(rules, /stack-agnostic[^.]*\. Propose no preset stack/i);
  assert.match(rules, /official sources you consulted/i);
  assert.match(rules, /only the descriptor \(through `inspect`\) and the exact run files the current step names/i);
  assert.match(rules, /Never list, search, or pick a most-recent file there/i);
  assert.match(rules, /Never read `\.apex\/work\/\*\*`/);
  assert.match(rules, /child agent only the exact paths/i);
  assert.match(rules, /Helpers check formats, paths, digests, and receipts[^.]*\. You own the dialogue, the architecture judgement, the reading of evidence, and the promotion decisions/i);
  assert.match(rules, /never proves that a human approved or that a rule is right/i);
  assert.doesNotMatch(read('SKILL.md'), /header recovery/i, 'inception has no pathless recovery of its own');
});

test('inception: stop, resume, and exit are explicit and never rebuild state by browsing', () => {
  const text = read('SKILL.md');
  const stop = flat(section(text, '## Stop', '## Resume'));
  assert.match(stop, /`status: blocked`/);
  assert.match(stop, /determining input cannot be read/i);
  assert.match(stop, /uncertain outcome/i);
  assert.match(stop, /resume note[^.]*descriptor path[^.]*current phase[^.]*every run file/i);
  const resume = flat(section(text, '## Resume', '## Exit'));
  assert.match(resume, /only from exact paths/i);
  assert.match(resume, /Never rebuild the run by listing its directory/i);
  assert.match(resume, /project document must still match its approved digest/i);
  assert.match(resume, /If an approval is bound, check it/i);
  assert.match(resume, /If a checkpoint is bound, check the code/i);
  assert.match(resume, /new checkpoint with the same inventory at a new exact path/i);
  assert.match(resume, /intent but no observed outcome is uncertain[^.]*reconcile[^.]*never repeat it automatically/i);
  const exit = flat(section(text, '## Exit'));
  assert.match(exit, /`phase: complete` and `status: complete`/);
  assert.match(exit, /abandon[^.]*stays local/i);
  assert.match(exit, /next skill is `init`[^.]*exact handoff path/i);
});

test('inception: protocol.md record examples are accepted by the real helpers and agree with one another', () => {
  const text = read('protocol.md');
  const descriptor = jsonBlockAfter(text, '## Descriptor');
  assert.equal(serializeInceptionState(descriptor.value), descriptor.text, 'the descriptor example uses canonical bytes');
  const state = parseInceptionState(descriptor.text);
  const runId = state.runId;
  assert.equal(state.phase, 'init', 'the example is the descriptor ready for the transfer');

  const approval = validateApprovalRecord(jsonBlockAfter(text, '## Approval record').value, { runId });
  const checkpoint = jsonBlockAfter(text, '## Code checkpoint');
  validateCodeCheckpoint(checkpoint.value, { runId });
  assert.equal(serializeCodeCheckpoint(checkpoint.value), checkpoint.text, 'the checkpoint example is helper-canonical');
  const handoff = validateInceptionHandoff(jsonBlockAfter(text, '### Handoff').value);
  const confirmed = validateConfirmedInputs(jsonBlockAfter(text, '### Confirmed inputs').value);
  const promotion = validatePromotionTable(jsonBlockAfter(text, '### Promotion table').value, { runId });

  assert.equal(handoff.runId, runId);
  assert.deepEqual(Object.keys(handoff.required), [...INCEPTION_HANDOFF_ROLES]);
  assert.equal(handoff.required.approval, state.approval.path);
  assert.deepEqual(handoff.required.project, approval.project.map(({ path }) => path));
  assert.ok(handoff.required.verification.includes(state.checkpoint.path));
  assert.ok(handoff.required.verification.length >= 2, 'verification lists the checkpoint and a results document');
  assert.deepEqual(Object.keys(confirmed), [
    'projectName', 'description', 'devCommands', 'surfaces', 'domainVocabulary', 'gitPolicyDirective',
  ]);
  const inventory = new Set(checkpoint.value.files.map(({ path }) => path.toLowerCase()));
  assert.deepEqual(new Set(promotion.decisions.map(({ outcome }) => outcome)), new Set(['promote', 'exclude']));
  const architecture = promotion.decisions.find(({ destination }) => destination === '.apex/project-architecture.md');
  assert.ok(architecture, 'the example promotes a cross-cutting choice');
  assert.match(architecture.content, /manifest and lockfile hold the resolved version/i, 'a promoted choice points at the manifest and lockfile');
  assert.doesNotMatch(architecture.content, /<version>|checked against/i, 'a promoted choice never repeats the resolved version');
  for (const decision of promotion.decisions.filter(({ outcome }) => outcome === 'promote')) {
    assert.ok(!inventory.has(decision.destination.toLowerCase()), `${decision.id} must not write a checkpoint path`);
  }
  assert.deepEqual(validatePromotionCoverage(confirmed, promotion),
    confirmed.surfaces.map(({ name }) => `.apex/standards/${name}.md`).sort(),
    'the example promotes a standard for every example surface');
  assert.ok(promotion.decisions.some(({ content }) => content?.includes('Not decided at inception; refine with `discovery`.')),
    'the example shows the explicit statement for a section with no approved content');
});

test('inception: the promotion table fills every surface standard and every section init creates from a template', () => {
  const table = flat(section(read('protocol.md'), '### Promotion table', '### Init receipt'));
  assert.match(table, /Every confirmed surface needs at least one `promote` row whose destination is its standard, `\.apex\/standards\/<name>\.md`; `verify` and `prepare` refuse the table otherwise/i);
  assert.match(table, /Cover the standard's Scope, Conventions, and Anti-patterns, and every section of a project document `init` creates from a template/i);
  const boundary = tableRows(section(read('protocol.md'), '## Helper checks and your judgement'));
  assert.ok(boundary.some(([helper, you]) => /promoted standard for every confirmed surface/i.test(helper) && /what each standard says/i.test(you)),
    'the helper checks only that each standard is promoted; its text stays your judgement');

  const matrix = flat(section(read('init-handoff.md'), '## Promotion matrix', '## Close the run'));
  assert.match(matrix, /Cover every section `init` creates from a template/i);
  assert.match(matrix, /every confirmed surface → `promote` decisions for `\.apex\/standards\/<name>\.md` that cover its Scope \(owns, does not own, exemplar\), Conventions, and Anti-patterns\. Take them from the approved project and the verified code/i);
  assert.match(matrix, /`project-architecture\.md` and `project-context\.md`[^→]*→ a `promote` decision for each of their sections, \*\*Version policy\*\* included/i);
  assert.match(matrix, /a section with no approved content → promote one short explicit statement, for example "Not decided at inception; refine with `discovery`\." Never leave the template text/i);
  assert.match(matrix, /`verify` and `prepare` refuse a promotion table without a `promote` decision for some confirmed surface's standard\. They check only that the decision exists; the text is your judgement/i);
});

test('inception: protocol.md documents the local area, binding rules, and the helper-versus-judgement boundary', () => {
  const text = flat(read('protocol.md'));
  assert.match(text, /`scripts\/inception-state\.mjs` and `scripts\/inception-handoff\.mjs` own these formats/i);
  assert.match(text, /When this file and a helper disagree, the helper wins/i);
  assert.match(text, /`\.apex\/inception\/\.gitignore` — exactly `\*` plus a newline; `start` writes it first/);
  assert.match(text, /Change it only through `start` and `update`; never edit it by hand/i);
  assert.match(text, /at most 1 MiB/i);
  assert.match(text, /Each path segment under `<run-id>\/` starts with a letter or digit, then uses letters, digits, `\.`, `_`, and `-`; nested directories are allowed \(`research\/runtime\.md`\)/);
  assert.equal(classifyInceptionPath(`.apex/inception/${RUN}/research/runtime.md`, { runId: RUN }).kind, 'run-file');
  assert.throws(() => classifyInceptionPath(`.apex/inception/${RUN}/.draft.md`, { runId: RUN }), /unsafe characters/);
  assert.match(text, /Promote a choice with its reason; the manifest and lockfile hold the resolved version/i);
  assert.match(text, /never edited after it is bound[^.]*\. A new decision or observation uses a new exact path/i);
  assert.match(text, /Leave `init` to `prepare` and `finalize`/);
  assert.match(text, /only after the user explicitly approves the whole project/i);
  assert.match(text, /Never name files `init` writes: `\.apex\/\*\*`, `AGENTS\.md`, `CLAUDE\.md`, `\.agents\/`, `\.claude\/`, `\.codex\/`, `\.opencode\/`/);
  assert.match(text, /`inception-handoff: steepy-apex\/v1`[^.]*separate from the chain's `handoff: steepy-apex\/v1`/i);
  assert.match(text, /No path serves two roles/i);
  assert.match(text, /A digest makes a change visible\. It does not identify a person or prove that you followed these instructions/i);
  const boundary = tableRows(section(read('protocol.md'), '## Helper checks and your judgement'));
  assert.ok(boundary.length >= 4, 'the boundary is a helper-versus-model table');
});

test('inception: the documented digest command prints the SHA-256 the helpers verify', () => {
  const line = read('protocol.md').split('\n').find((candidate) => candidate.startsWith('node -e '));
  assert.ok(line, 'protocol.md must document a portable digest command');
  const code = line.match(/^node -e "([^"]+)" <path>\.\.\.$/)?.[1];
  assert.ok(code, 'the digest command takes exact paths as arguments');
  const temp = mkdtempSync(join(tmpdir(), 'steepy-inception-digest-'));
  try {
    const file = join(temp, 'project.md');
    writeFileSync(file, '# Project\n\nApproved bytes.\n');
    const result = spawnSync(process.execPath, ['-e', code, file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.split(/\s+/)[0], sha256Hex(readFileSync(file)));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// Every documented helper line must be accepted by the real CLI parser. A
// usage error exits 2; any other exit (missing state, refused binding) is a
// runtime answer for an empty temporary repository, which is expected here.
const HELPER_LINE = /^\s*node <engine-root>\/scripts\/(inception-(?:state|handoff)\.mjs) (.+)$/;
const PLACEHOLDERS = {
  '<run-id>': RUN,
  '<n>': '1',
  '<descriptor-sha256>': 'a'.repeat(64),
  '<changes-json>': '{"phase":"architecture"}',
  '<repo-path>': 'package.json',
  '<handoff-path>': `.apex/inception/${RUN}/init-handoff.json`,
  '<id=choice>': 'conflict-1=keep',
};

function documentedHelperLines() {
  const sources = [
    ...['SKILL.md', ...SUPPORT_FILES].map((name) => [`skills/inception/${name}`, read(name)]),
    ['skills/init/SKILL.md', readFileSync(join(root, 'skills', 'init', 'SKILL.md'), 'utf8')],
  ];
  return sources.flatMap(([label, text]) => text.split('\n')
    .map((line) => line.match(HELPER_LINE))
    .filter(Boolean)
    .map((match) => ({ label, script: match[1], args: match[2] })));
}

function argv(args, repoRoot) {
  const command = args.split(' > ')[0];
  return command.split(/\s+/).map((token) => {
    let value = token.replace(/^'(.*)'$/, '$1');
    if (value === '<repo-root>') return repoRoot;
    for (const [placeholder, replacement] of Object.entries(PLACEHOLDERS)) {
      value = value.split(placeholder).join(replacement);
    }
    assert.doesNotMatch(value, /<[^>]+>/, `unknown placeholder in '${args}'`);
    return value;
  });
}

test('inception: every documented helper command line parses under the real CLIs', () => {
  const lines = documentedHelperLines();
  const used = new Set(lines.map(({ script, args }) => `${script} ${args.split(' ')[0]}`));
  for (const command of [
    'inception-state.mjs start', 'inception-state.mjs inspect', 'inception-state.mjs update',
    'inception-handoff.mjs checkpoint', 'inception-handoff.mjs verify', 'inception-handoff.mjs project',
    'inception-handoff.mjs prepare', 'inception-handoff.mjs finalize',
  ]) assert.ok(used.has(command), `the docs must show ${command}`);

  for (const { label, script, args } of lines) {
    const temp = mkdtempSync(join(tmpdir(), 'steepy-inception-cli-'));
    try {
      const result = spawnSync(process.execPath, [join(root, 'scripts', script), ...argv(args, temp)], {
        cwd: temp,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: temp, GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: temp },
      });
      assert.notEqual(result.status, 2, `${label}: '${args}' is not accepted by ${script}: ${result.stderr}`);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
});

test('inception: reconnaissance combines starting materials, separates facts from simulations, and asks in dependency order', () => {
  const text = flat(read('reconnaissance.md'));
  for (const material of ['empty repository', 'starter', 'design system', 'UI/UX prototype']) {
    assert.match(text, new RegExp(material.replace('/', '\\/'), 'i'), `reconnaissance must cover ${material}`);
  }
  assert.match(text, /a repository can hold more than one/i);
  assert.match(text, /mature application[^.]*not inception scope[^.]*recommend `init`, then `discovery`\. Never pull it into scope automatically/i);
  assert.match(text, /real → [^;]*;[ -]*simulated → /i);
  assert.match(text, /Never present a simulation as an existing component/i);
  assert.match(text, /cannot be read[^.]*ask the user for accessible content[^.]*\. Never state an analysis of an input you did not read/i);
  for (const topic of ['quality', 'constraints', 'goals', 'flows', 'harness capabilities', 'Git policy']) {
    assert.match(text, new RegExp(topic, 'i'), `reconnaissance must record ${topic}`);
  }
  assert.match(text, /Ask in dependency order: materials → real vs simulated → goals and flows → constraints/i);
  assert.match(text, /never batch dependent questions/i);
});

test('inception: architecture requires reasoned alternatives, sourced versions, isolated experiments, limits, and a byte-bound approval', () => {
  const text = flat(read('architecture.md'));
  assert.match(text, /alternatives with their trade-offs and a recommendation/i);
  assert.match(text, /boundaries and responsibilities, data and its owner, contracts between parts, and the patterns/i);
  assert.match(text, /observability[^.]*error handling/i);
  assert.match(text, /representative path[^.]*crosses the agreed boundaries/i);
  assert.match(text, /behaviors to preserve/i);
  assert.match(text, /runtime, framework, build tooling, generators, core dependencies/i);
  assert.match(text, /source, the explicit version, the verification date, the support status, and compatibility/i);
  assert.match(text, /never present a remembered version as verified/i);
  assert.match(text, /experiment before approval[^.]*isolated[^.]*records it as an experiment[^.]*\. It never becomes the bootstrap/i);
  assert.match(text, /State the limits explicitly/i);
  assert.match(text, /Present the whole project/i);
  assert.match(text, /one explicit approval of the whole project/i);
  assert.match(text, /digests of the exact approved bytes/i);
  assert.match(text, /database, boundaries, flows, design, deploy, or a foundational technology is substantial[^.]*targeted decision[^.]*new approval at a new path/i);
});

test('inception: bootstrap builds the approved path only, checkpoints effects, and reconciles uncertain outcomes', () => {
  const text = flat(read('bootstrap.md'));
  assert.match(text, /Pin commands and tools/i);
  assert.match(text, /Commit only if the Git policy allows it, and only before the final code checkpoint/i);
  assert.match(text, /manifests and lockfiles/i);
  assert.match(text, /install, build, test, and start commands/i);
  assert.match(text, /example configuration without secrets/i);
  assert.match(text, /integrations and migrations the representative path needs, and only those/i);
  assert.match(text, /representative path across the agreed boundaries/i);
  assert.match(text, /Reuse the planned assets/i);
  assert.match(text, /Do not implement the whole prototype/i);
  assert.match(text, /CI and deploy instructions[^.]*\. Execute deploy only when the approved project includes it/i);
  assert.match(text, /Build or test failures → fix them inside the approved scope/i);
  assert.match(text, /database, boundaries, flows, design, or deploy → targeted decision and new approval/i);
  assert.match(text, /Before each step with effects[^.]*intent[^.]*\. After it, append the observed outcome/i);
  assert.match(text, /uncertain outcome[^.]*reconciled[^.]*\. Never repeat it automatically/i);
  assert.ok(read('bootstrap.md').includes('architecture.md → "Approval"'), 'bootstrap reuses the approval rule by reference');
  assert.match(read('architecture.md'), /^## Approval$/m, 'the referenced heading exists');
});

test('inception: init-handoff verifies, names exact init inputs, separates approved/verified/future, and starts no backlog', () => {
  const text = flat(read('init-handoff.md'));
  assert.match(text, /`configured`, `executed`, `succeeded`, `not-executed`, and `failed` distinct/);
  assert.match(text, /local CI and remote success are separate/i);
  assert.match(text, /deploy excluded[^.]*not needed to conclude/i);
  assert.match(text, /deploy included → never "succeeded" without evidence/i);
  assert.match(text, /final code checkpoint and bind it/i);
  assert.match(text, /Finish the commits the Git policy allows before the final code checkpoint/i);
  assert.match(text, /change no code and make no commit until `init` finalizes/i);
  assert.match(text, /If `init` reports `diverged` before it starts, loop back: re-run the checks the change affects, record and bind a new checkpoint, then write a new handoff at a new exact path/i);
  assert.match(text, /Once `init` has started, its handoff is pinned: restore the checkpointed code instead/i);
  assert.match(text, /installed combination → the versions actually resolved[^;]*match the approved research; report a mismatch, never hide it/i);
  for (const file of ['confirmed-inputs.json', 'promotion.json', 'init-handoff.json']) {
    assert.ok(text.includes(file), `the transfer must name ${file}`);
  }
  assert.match(text, /Never re-ask for values the approval already covers/i);
  assert.match(text, /invoke the `init` skill with the exact handoff path/i);
  assert.match(text, /approved and verified → [^;]*;[ -]*approved, not yet verified → [^;]*never claimed as built;[ -]*future/i);
  assert.match(text, /promote → a stable destination and the exact text/i);
  assert.match(text, /exclude → a reason it stays local/i);
  assert.match(text, /Future flows go to `project-context\.md` → "Future flows" as context, never as components, specs, or a started backlog/i);
  assert.match(text, /No backlog item is implemented or turned into an approved spec/i);
  const close = flat(section(read('init-handoff.md'), '## Close the run'));
  for (const item of ['the hub', 'the evidence', 'deploy', 'deferred flows']) {
    assert.match(close, new RegExp(`- ${item}`, 'i'), `the final delivery must report ${item}`);
  }
});

test('inception: templates are referenced from the engine root and never copied into skill prose', () => {
  const all = ['SKILL.md', ...SUPPORT_FILES].map(read).join('\n');
  for (const name of TEMPLATES) {
    assert.ok(all.includes(`<engine-root>/templates/${name}`) || all.includes(`\`${name}\``),
      `the inception skill must reference templates/${name}`);
    const headings = readFileSync(join(root, 'templates', name), 'utf8').split('\n').filter((line) => line.startsWith('## '));
    for (const heading of headings) {
      assert.ok(!all.split('\n').includes(heading), `skill prose must not copy the ${name} heading '${heading}'`);
    }
  }
  assert.ok(all.includes('<engine-root>/templates/inception-project.md'));
  assert.ok(all.includes('<engine-root>/templates/inception-verification.md'));
});

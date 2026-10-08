// Content contracts for skills/inception/SKILL.md and its two prompt templates.
// Part 1: entry, local area, and reconnaissance through the single human approval (SC2, SC4, SC14).
// Part 2: the two pauses, bootstrap, effects and checkpoints, final verification, sessions,
// children, harness degradations, and the research and bootstrap-part prompts (SC15).
//
// Doc-content-lock suite: it reads files only and never writes. The helper command spellings
// below are the inception helper contract's HC7 lines with `<common>` written as
// `--repo-root .`; the classification rows are HC8's; the run file locations are HC2's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sectionBetween, frontmatter } from './support/markdown.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const skillPath = join(root, 'skills', 'inception', 'SKILL.md');

// Read inside each test, so a missing file fails every contract on its own.
function readSkill() {
  return readFileSync(skillPath, 'utf8');
}

// Collapses whitespace, so a phrase wrapped across lines still matches a single-space pattern.
function flat(text) {
  return text.replace(/\s+/g, ' ');
}

const DESCRIPTION =
  'Turn an idea and its starting materials into a minimal, verified, runnable application before ' +
  'the hub exists — reconnaissance, architecture decisions, verified versions, one human approval, ' +
  'bootstrap of one representative path, and final verification — then hand off to init and discovery.';

const ENGINE_ROOT_BLOCK =
  "> **Engine root:** this skill's base directory is `<engine-root>/skills/inception/`; engine\n" +
  '> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base\n' +
  '> directory your harness reports for this skill.';

const HEADINGS = [
  '# inception',
  '## Boundaries',
  '## Helper commands',
  '## Procedure',
  '### Step 0 — Classify the starting state',
  '### Step 1 — Start or resume the run',
  '### Step 2 — Reconnaissance',
  '### Step 3 — Architecture decisions',
  '### Step 4 — Research and versions',
  '### Step 5 — Project and approval',
  '### Step 6 — Pause after approval',
  '### Step 7 — Bootstrap',
  '### Step 8 — Effects and checkpoints',
  '### Step 9 — Pause after bootstrap',
  '### Step 10 — Final verification and conclusion',
  '## Sessions and context',
  '## Children and dispatch policy',
  '## Harness capabilities and degradations',
  '## Blocking and abandon',
];

// The section under `heading`, up to the next heading of the same or a higher level.
function sectionOf(text, heading) {
  const level = heading.match(/^#+/)[0].length;
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start !== -1, `missing heading '${heading}'`);
  const rest = text.slice(start + heading.length + 2);
  const next = rest.match(new RegExp(`^#{1,${level}} .*$`, 'm'));
  return sectionBetween(text, `\n${heading}\n`, next ? `\n${next[0]}\n` : undefined);
}

const HELPER = 'node <engine-root>/scripts/inception-state.mjs';

const HC7_COMMAND_LINES = [
  `${HELPER} classify --repo-root . [--maturity suitable|mature]`,
  `${HELPER} start --repo-root . --harness <slug> --capabilities <csv> --git-commits allowed|forbidden`,
  `${HELPER} transition --repo-root . --to <phase|blocked|active> --reason <text> [--git-commits allowed|forbidden] [--checkpoint <path> --verification <path>]`,
  `${HELPER} resume-note --repo-root . --next <text> [--need <path>]... [--note <text>]`,
  `${HELPER} approve --repo-root . --statement <text> --document <path>...`,
  `${HELPER} verify-approval --repo-root . [--approval <path>]`,
  `${HELPER} effect intent --repo-root . --id <id> --kind <kind> --summary <text> [--authorization <text>]`,
  `${HELPER} effect outcome --repo-root . --id <id> --result succeeded|failed --observed <text>`,
  `${HELPER} effect status --repo-root .`,
  `${HELPER} checkpoint create --repo-root . --label <text> [--file <path>]... [--files-from <path>]`,
  `${HELPER} checkpoint verify --repo-root . [--checkpoint <path>]`,
  `${HELPER} abandon --repo-root . --reason <text>`,
];

// Command name (family form included) → the option names its HC7 line allows.
const HC7_OPTIONS = new Map(
  HC7_COMMAND_LINES.map((line) => {
    const rest = line.slice(HELPER.length + 1);
    const name = rest.match(/^(?:effect|checkpoint) [a-z]+|^[a-z-]+/)[0];
    return [name, new Set([...rest.matchAll(/--([a-z][a-z-]*)/g)].map((match) => match[1]))];
  })
);
// Longest names first, so `effect status` is never read as a bare `effect`.
const HC7_NAMES = [...HC7_OPTIONS.keys()].sort((a, b) => b.length - a.length);

const FREE_TEXT_OPTIONS = ['statement', 'summary', 'observed', 'reason', 'label', 'next', 'note', 'authorization'];

const HC8_ROWS = [
  'maturity-decision-required',
  'start-new-run',
  'propose-init-discovery',
  'ordinary-workflow',
  'resume-run',
  'report-next-steps',
  'run-complete-ordinary-workflow',
  'conflict-run-beside-hub',
  'invalid-state',
];

const RUN_CHILDREN = [
  'run.json',
  'effects.jsonl',
  'approvals/',
  'checkpoints/',
  'resume-notes/',
  'project/',
  'research/',
  'bootstrap/',
  'verification/',
];

const ARCHITECTURE_CATEGORIES = [
  'system shape',
  'contracts between parts',
  'data',
  'identity and access',
  'internal architecture',
  'repository and tooling',
  'testing strategy',
  'hosting and deploy',
  'observability and errors',
];

const DECISION_REGISTER_HEADER = '| ID | Category | Decision | Reason | Alternatives | Confirmed |';

const VERSION_REVIEW_COLUMNS = [
  'component',
  'chosen version',
  'latest stable',
  'support or end of life',
  'reason for any deviation',
  'source and date',
];

// Splits a Markdown table row on unescaped pipes and unescapes `\|` inside each cell.
function tableCells(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function tableRows(text) {
  return text
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map(tableCells);
}

// The HC7 command name an invocation starts with, or null.
function commandOf(invocation) {
  return HC7_NAMES.find((name) => invocation === name || invocation.startsWith(`${name} `)) ?? null;
}

test('support/markdown: sectionBetween and frontmatter keep the shared semantics', () => {
  const doc = '---\nname: x\n---\n# t\n## A\na\n## B\nb\n';
  assert.equal(sectionBetween(doc, '## A', '## B'), '## A\na\n');
  assert.equal(sectionBetween(doc, '## B', '## C'), '## B\nb\n', 'a missing end slices to the end');
  assert.equal(sectionBetween(doc, '## A'), '## A\na\n## B\nb\n', 'an omitted end slices to the end');
  assert.throws(() => sectionBetween(doc, '## Z', '## B'), /missing heading '## Z'/);
  assert.equal(frontmatter(doc), 'name: x');
  assert.equal(frontmatter('# no frontmatter\n'), null);
});

test('inception: frontmatter is exactly name, the one-line description, and user-invocable', () => {
  assert.equal(
    frontmatter(readSkill()),
    `name: inception\ndescription: ${DESCRIPTION}\nuser-invocable: true`
  );
});

test('inception: title, pre-hub intro, and the canonical engine-root block', () => {
  const text = readSkill();
  assert.ok(text.includes('\n---\n\n# inception\n'), 'the title follows the frontmatter');
  const intro = flat(sectionBetween(text, '\n# inception\n', '\n## '));
  assert.match(intro, /pre-hub skill/);
  assert.match(intro, /not a gear/);
  assert.match(intro, /outside the brainstorm → plan → implement → review chain/);
  assert.match(intro, /no headless or autopilot mode/);
  assert.ok(text.includes(ENGINE_ROOT_BLOCK), 'must carry the byte-exact engine-root block');
  assert.ok(text.includes('scripts live two levels up, at `<engine-root>/scripts/`.'));
});

test('inception: every section heading appears once, in procedure order', () => {
  const lines = readSkill().split('\n');
  let previous = -1;
  for (const heading of HEADINGS) {
    const positions = lines.flatMap((line, index) => (line === heading ? [index] : []));
    assert.equal(positions.length, 1, `heading '${heading}' must appear exactly once`);
    assert.ok(positions[0] > previous, `heading '${heading}' is out of order`);
    previous = positions[0];
  }
});

test('inception: portable prose — semantic skill names, no slash commands, model IDs, CLAUDE_, or home paths', () => {
  const text = readSkill();
  assert.doesNotMatch(text, /\/steepy(?:-apex)?:/, 'skills are named semantically, never by slash command');
  assert.doesNotMatch(
    text,
    /\b(?:haiku|sonnet|opus|fable)\b|\bgpt-\d|\bgemini-\d|\bdeepseek-[a-z0-9]/i,
    'no concrete model ID'
  );
  assert.doesNotMatch(text, /CLAUDE_/);
  assert.doesNotMatch(text, /\/Users\/|\/home\/|~\//);
  assert.match(flat(text), /the `init` skill/);
  assert.match(flat(text), /the `discovery` skill/);
  assert.doesNotMatch(text, /steepy:manual-handoff|<!-- steepy-workflow:/, 'inception is outside the chain');
});

test('inception boundaries (SC2): local area only; the hub, routing, standards, adapters, and bootstrap belong to init', () => {
  const boundaries = flat(sectionOf(readSkill(), '## Boundaries'));
  assert.match(boundaries, /only inside `\.apex\/inception\/` and the application's own files/);
  for (const forbidden of [
    /`\.apex\/_INDEX\.md`/,
    /routing/,
    /standards/,
    /specialist adapters/,
    /project bootstrap/,
  ]) {
    assert.match(boundaries, forbidden);
  }
  assert.match(boundaries, /Never create [^.]*`\.apex\/_INDEX\.md`[^.]*belong to the `init` skill/);
  assert.match(
    boundaries,
    /Never create or edit the root `\.gitignore` for the run's own area; only an approved bootstrap tool may change it, as an application file \(Step 7\)/
  );
  assert.match(boundaries, /first run write is `\.apex\/inception\/\.gitignore`[^.]*`start`/);
  assert.match(boundaries, /One run per repository[^.]*`\.apex\/inception\/run\.json`/);
  assert.match(boundaries, /descriptor changes only through the helper/);
  assert.match(boundaries, /Never rewrite a record bound to an approval or a checkpoint/);
  for (const child of RUN_CHILDREN) {
    assert.ok(boundaries.includes(`\`${child}\``), `the run files list must name ${child}`);
  }
});

test('helper commands: the table quotes every HC7 command line exactly, in order', () => {
  const helper = sectionOf(readSkill(), '## Helper commands');
  const quoted = tableRows(helper)
    .map((cells) => cells[0].match(/^`([^`]+)`$/)?.[1])
    .filter((cell) => cell?.startsWith(`${HELPER} `));
  assert.deepEqual(quoted, HC7_COMMAND_LINES);
});

test('helper commands: role rule, one-line JSON result, exit codes, and the --option=<value> form', () => {
  const helper = flat(sectionOf(readSkill(), '## Helper commands'));
  assert.ok(
    helper.includes('The helper records and verifies; it never asks, chooses a phase, approves, or runs project commands.'),
    'must state the helper role rule'
  );
  assert.match(helper, /exactly one JSON object line on stdout/);
  assert.match(helper, /`"ok":true`/);
  assert.match(helper, /`"ok":false`[^.]*`error`/);
  assert.match(helper, /`inception-state: <reason>`/);
  assert.match(helper, /`command` field[^.]*`"effect intent"`[^.]*`"checkpoint verify"`/);
  assert.match(helper, /Exit `0`[^.]*success/);
  assert.match(helper, /Exit `1`[^.]*refused precondition, an invalid state, or a failed verification/);
  assert.match(helper, /Exit `2`[^.]*usage error/);
  assert.match(helper, /A refusal never writes/);
  for (const option of FREE_TEXT_OPTIONS) {
    assert.ok(helper.includes(`\`--${option}=<value>\``), `must name --${option}=<value>`);
  }
  assert.match(helper, /value that begins with `-`/);
  assert.match(helper, /Markdown list item/);
});

test('helper commands: every helper invocation in the skill uses an HC7 command and only its options', () => {
  const text = readSkill();
  const invocations = [
    ...[...text.matchAll(/inception-state\.mjs ([^`\n]*)/g)].map((match) => match[1]),
    ...[...text.matchAll(/`([a-z][a-z-]*(?: [a-z]+)? --[^`\n]*)`/g)]
      .map((match) => match[1])
      .filter((span) => commandOf(span) !== null),
  ];
  assert.ok(invocations.length >= HC7_COMMAND_LINES.length, 'sanity: the scan finds the invocations');
  for (const invocation of invocations) {
    const name = commandOf(invocation);
    assert.ok(name, `unknown helper command in '${invocation}'`);
    const allowed = HC7_OPTIONS.get(name);
    for (const [, option] of invocation.slice(name.length).matchAll(/--([a-z][a-z-]*)/g)) {
      assert.ok(allowed.has(option), `'${name}' has no --${option} option (in '${invocation}')`);
    }
  }
});

test('step 0: the maturity reading is only a proposal and every HC8 row has its action', () => {
  const step0 = sectionOf(readSkill(), '### Step 0 — Classify the starting state');
  const prose = flat(step0);
  assert.match(prose, /`node <engine-root>\/scripts\/detect-stack\.mjs \.`/);
  assert.match(prose, /only a proposal/);
  assert.match(prose, /The user decides an intermediate case/);
  assert.match(prose, /nearly complete prototype needs the user's explicit choice/);
  assert.match(prose, /`classify --maturity suitable` or `classify --maturity mature`/);
  assert.match(prose, /never lists directories/);
  assert.match(prose, /never picks a run by recency or file name/);

  const actions = new Map(
    tableRows(step0)
      .map((cells) => [cells[0].match(/^`([a-z-]+)`$/)?.[1], cells[1]])
      .filter(([row]) => HC8_ROWS.includes(row))
  );
  assert.deepEqual([...actions.keys()].sort(), [...HC8_ROWS].sort(), 'the table must give every HC8 row');
  const expectations = {
    'maturity-decision-required': [/maturity/, /`--maturity`/],
    'start-new-run': [/Step 1/, /start/i],
    'propose-init-discovery': [/the `init` skill, then the `discovery` skill/, /Start nothing/],
    'ordinary-workflow': [/ordinary workflow/, /Start nothing/],
    'resume-run': [/Resume/, /Step 1/],
    'report-next-steps': [/the `init` skill, then the `discovery` skill/],
    'run-complete-ordinary-workflow': [/"run complete, use the ordinary workflow"/],
    'conflict-run-beside-hub': [/conflict/, /no automatic resume/, /`init` ran too early/],
    'invalid-state': [/Preserve every file/, /explain/],
  };
  for (const [row, patterns] of Object.entries(expectations)) {
    for (const pattern of patterns) assert.match(actions.get(row), pattern, `row ${row}`);
  }
});

test('step 1 (SC4): capability record and commit policy before start; resume only from bound inputs', () => {
  const step1 = flat(sectionOf(readSkill(), '### Step 1 — Start or resume the run'));
  for (const capability of ['shell', 'network', 'browser', 'subagents', 'question-tool', 'headless']) {
    assert.ok(step1.includes(`\`${capability}\``), `the capability record must name ${capability}`);
  }
  assert.match(step1, /Ask the commit policy in one question/);
  assert.match(step1, /`start --harness <slug> --capabilities <csv> --git-commits allowed\|forbidden`/);
  assert.match(step1, /Resume reads only the descriptor, the records it binds, and the latest resume note/);
  assert.match(step1, /last element of `resumeNotes`/);
  assert.match(step1, /never lists a directory/);
  assert.match(step1, /never reopens a sibling file/);
  assert.match(step1, /`effect status`/);
  assert.match(step1, /observe the real state/);
  assert.match(step1, /explain any divergence/);
  assert.match(step1, /complete only the missing step the evidence proves/);
  assert.match(step1, /Never repeat a concluded or uncertain effect/);
  assert.match(
    step1,
    /Step 2 for `reconnaissance`, Step 3 for `architecture`, Step 4 for `research`, Step 5 for `approval`, Step 7 for `bootstrap`, Step 10 for `verification`/
  );
  assert.match(step1, /For `complete`, give the closing report \(Step 10\)/);
});

test('step 2 (SC14): reconnaissance record, real versus simulated, dialogue rules, and the identity check', () => {
  const step2 = flat(sectionOf(readSkill(), '### Step 2 — Reconnaissance'));
  assert.match(step2, /code, images, exported designs, documents, links/);
  assert.match(step2, /unreadable input needs an accessible alternative/);
  assert.match(step2, /never claims to have analyzed what it did not read/);
  assert.match(step2, /\*\*real\*\* or \*\*simulated\*\*/);
  assert.match(step2, /mocks, stub calls, and hard-coded data stay simulations even when the screen looks complete/);
  assert.match(step2, /`\.apex\/inception\/project\/reconnaissance\.md`/);
  for (const item of [
    /product goals and main flows/,
    /what works, what is fragile, and known defects/,
    /materials to reuse and behaviors to preserve/,
    /technical, product, hosting, cost, and time constraints/,
    /per-layer preferences, skills, and technologies to avoid/,
    /version policy[^;]*recent compatible stable[^;]*LTS or N-1[^;]*per-layer/,
    /the harness's real capabilities/,
    /Git presence, branch, and the commit and remote-operation policy/,
  ]) {
    assert.match(step2, item);
  }
  assert.match(step2, /one question at a time, in dependency order/);
  assert.match(step2, /options[^.]*trade-offs and a recommendation/);
  assert.match(step2, /confirmed answer that is still valid is never asked again/);
  assert.match(step2, /no cap or filter on product questions/);
  assert.match(step2, /authenticated identity and which owners are really accessible/);
  assert.match(step2, /`gh auth status`/);
  assert.match(step2, /`gh api user\/orgs`/);
  assert.match(step2, /propose only those/);
  assert.match(step2, /`transition --to architecture --reason=<value>`/);
});

test('step 3 (SC14): the nine categories, question rules, decision register, and surface map', () => {
  const raw = sectionOf(readSkill(), '### Step 3 — Architecture decisions');
  const step3 = flat(raw);
  const categories = [...raw.matchAll(/^\d+\. (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(categories, ARCHITECTURE_CATEGORIES, 'the nine stack-neutral categories, named exactly');
  assert.match(step3, /before the definitive project is written/);
  assert.match(step3, /real fork gets its own question with alternatives/);
  assert.match(step3, /one reasonable answer may join a grouped confirmation with its reason/);
  assert.match(step3, /does not apply is excluded with an explanation/);
  assert.match(step3, /Never merge dependent questions/);
  assert.match(step3, /No foundational choice appears for the first time at final approval/);
  assert.match(step3, /`\.apex\/inception\/project\/decision-register\.md`/);
  assert.ok(raw.includes(`\n${DECISION_REGISTER_HEADER}\n`), 'the decision register table header, byte for byte');
  assert.match(step3, /`DR-1`, `DR-2`/);
  assert.match(step3, /never renumbered/);
  assert.match(step3, /accepted or rejected/);
  assert.match(step3, /how it was confirmed/);
  assert.match(step3, /surface map[^.]*name, path, responsibility, specialist, and test command/);
  assert.match(step3, /project context for the `init` interview, not a machine input to `init`/);
  assert.match(step3, /No preset application stack/);
  assert.match(step3, /Node is the engine's runtime only/);
  assert.match(step3, /`transition --to research --reason=<value>`/);
});

test('step 4 (SC14): official sources, remembered versions, the six-column review, and isolated experiments', () => {
  const raw = sectionOf(readSkill(), '### Step 4 — Research and versions');
  const step4 = flat(raw);
  assert.match(step4, /runtime, framework, build tooling, generators, main dependencies/);
  assert.match(step4, /official source, an explicit version, a verification date, its support status, and a compatibility check/);
  assert.match(step4, /Versions you remember are not verified versions/);
  assert.match(step4, /Without network access, ask the user for official sources or block/);
  assert.match(step4, /never pin a remembered version/);
  const header = tableRows(raw).find((cells) => cells[0].toLowerCase() === 'component');
  assert.ok(header, 'the version review table must exist');
  assert.deepEqual(header.map((cell) => cell.toLowerCase()), VERSION_REVIEW_COLUMNS);
  assert.match(step4, /confirms the combination or corrects rows/);
  assert.match(step4, /isolated outside the application repository/);
  assert.match(step4, /OS temporary directory/);
  assert.match(step4, /recorded as an experiment in `\.apex\/inception\/research\/`/);
  assert.match(step4, /never silently becomes the bootstrap/);
  assert.match(step4, /exact inputs and one exact output/);
  assert.match(step4, /inline[^.]*declared degradation/);
});

test('step 5 (SC14): one complete project, a single verbatim human approval, and targeted re-approval', () => {
  const step5 = flat(sectionOf(readSkill(), '### Step 5 — Project and approval'));
  assert.match(step5, /one or more documents under `\.apex\/inception\/project\/`/);
  for (const part of [
    'materials and simulations',
    'constraints',
    'the decision register',
    'components and contracts',
    'official research',
    'reuse',
    'behaviors to preserve',
    'the representative path',
    'the verification plan',
    'deploy',
    'limits',
  ]) {
    assert.ok(step5.includes(part), `the project must cover ${part}`);
  }
  assert.match(step5, /one complete flow across the agreed boundaries \(interface, logic, data, needed integrations\)/);
  assert.match(step5, /never become an automatically started backlog/);
  assert.match(step5, /`transition --to approval --reason=<value>`/);
  assert.match(step5, /approves the complete project \*\*once\*\*, before bootstrap/);
  assert.match(step5, /Present every project document path/);
  assert.match(step5, /explicit human approval/);
  assert.match(step5, /Quote it verbatim/);
  assert.match(step5, /`approve --statement=<value> --document <path>`/);
  assert.match(step5, /Never self-approve/);
  assert.match(step5, /no human is available, block \(`transition --to blocked --reason=<value>`\) instead of approving/);
  assert.match(step5, /never presents a model's approval as a human's/);
  assert.match(step5, /`transition --to bootstrap --reason=<value>`[^.]*`verify-approval`/);
  assert.match(step5, /mismatch blocks until a targeted decision and a new approval/);
  assert.match(step5, /installation, generation, implementation, and ordinary fixes proceed autonomously inside the agreed scope/);
  assert.match(step5, /database, boundaries, flows, design, deploy, a foundational technology, or the commit policy/);
  assert.match(step5, /targeted decision and a new approval of the changed parts/);
  assert.match(step5, /`transition --to approval --git-commits allowed\|forbidden --reason=<value>`/);
  assert.match(step5, /local choice already covered does not reopen the questionnaire/);
});

test('blocking and abandon: block with a precise resume note; abandon only on request, then start anew', () => {
  const blocking = flat(sectionOf(readSkill(), '## Blocking and abandon'));
  for (const trigger of [
    'unreadable determining input',
    'out-of-scope change',
    'uncertain external effect',
    'unexplained divergence',
  ]) {
    assert.ok(blocking.includes(trigger), `blocking must cover ${trigger}`);
  }
  assert.match(blocking, /`transition --to blocked --reason=<value>`/);
  assert.match(blocking, /Preserve every file and result/);
  assert.match(blocking, /precise resume note[^.]*`resume-note --next=<value> --need <path> --note=<value>`/);
  assert.match(blocking, /Restart only on an explicit user request to abandon/);
  assert.match(blocking, /`abandon --reason=<value>`/);
  assert.match(blocking, /moves the run intact[^.]*deletes nothing/);
  assert.match(blocking, /start the new run in the same step/);
  assert.match(blocking, /Never delete `\.apex\/inception\/`/);
});

// ---------------------------------------------------------------------------
// Part 2 (SC15): pauses, bootstrap, effects, verification, sessions, children, degradations
// ---------------------------------------------------------------------------

// Options each HC7 command cannot run without (HC6: a missing one is a usage error, exit 2).
const REQUIRED_OPTIONS = new Map([
  ['classify', []],
  ['start', ['harness', 'capabilities', 'git-commits']],
  ['transition', ['to', 'reason']],
  ['resume-note', ['next']],
  ['approve', ['statement', 'document']],
  ['verify-approval', []],
  ['effect intent', ['id', 'kind', 'summary']],
  ['effect outcome', ['id', 'result', 'observed']],
  ['effect status', []],
  ['checkpoint create', ['label']],
  ['checkpoint verify', []],
  ['abandon', ['reason']],
]);

const CLOSING_NEXT = 'run the init skill, then the discovery skill with the inception source';

const RESULT_VALUES = ['configured', 'executed', 'succeeded', 'not-executed', 'failed'];

const CHECKS_HEADER = '| Check | Environment | Command or procedure | Expected | Observed | Limits | Result |';
const COVERAGE_HEADER = '| ID | Component | Status | Checks |';

// Every helper invocation the skill shows outside the `## Helper commands` table.
function shownInvocations(text) {
  const prose = text.replace(sectionOf(text, '## Helper commands'), '');
  return [
    ...[...prose.matchAll(/inception-state\.mjs ([^`\n]*)/g)].map((match) => match[1]),
    ...[...prose.matchAll(/`([a-z][a-z-]*(?: [a-z]+)? --[^`\n]*)`/g)]
      .map((match) => match[1])
      .filter((span) => commandOf(span) !== null),
  ];
}

test('helper commands (SC15): every invocation shown outside the table carries its required options and the = form', () => {
  const invocations = shownInvocations(readSkill());
  assert.ok(invocations.length >= 20, 'sanity: the scan finds the procedure invocations');
  for (const invocation of invocations) {
    const name = commandOf(invocation);
    const options = new Set([...invocation.matchAll(/--([a-z][a-z-]*)/g)].map((match) => match[1]));
    for (const option of REQUIRED_OPTIONS.get(name)) {
      assert.ok(options.has(option), `'${invocation}' misses the required --${option}`);
    }
    if (name === 'checkpoint create') {
      assert.ok(options.has('file') || options.has('files-from'), `'${invocation}' names no file`);
    }
    if (/--to complete\b/.test(invocation)) {
      assert.ok(options.has('checkpoint') && options.has('verification'), `'${invocation}' misses the complete gate options`);
    }
    for (const option of FREE_TEXT_OPTIONS.filter((free) => options.has(free))) {
      assert.match(invocation, new RegExp(`--${option}=`), `'${invocation}' must pass --${option} in the = form`);
    }
  }
});

test('step 6 and step 9 (SC15): each pause publishes the next phase, waits for children, writes a resume note, and stays active', () => {
  const text = readSkill();
  const pauses = [
    ['### Step 6 — Pause after approval', 'bootstrap'],
    ['### Step 9 — Pause after bootstrap', 'verification'],
  ];
  for (const [heading, phase] of pauses) {
    const step = flat(sectionOf(text, heading));
    assert.ok(step.includes(`\`transition --to ${phase} --reason=<value>\``), `${heading} publishes phase ${phase}`);
    assert.match(step, /Wait for every active child to return/);
    assert.ok(step.indexOf(`--to ${phase}`) < step.indexOf('Wait for every active child'), `${heading}: the phase first`);
    assert.ok(step.indexOf('Wait for every active child') < step.indexOf('`resume-note'), `${heading}: the note last`);
    assert.match(step, /`resume-note --next=<value> --need <path>`/);
    assert.match(step, /one `--need` for every exact path the next session needs/);
    assert.match(step, /Each `--need` is an existing file under `\.apex\/inception\/`/);
    assert.match(step, /The helper writes the descriptor path and the phase into the note/);
    assert.match(step, /The pause is not a block: the run stays `active`/);
    assert.doesNotMatch(step, /--to blocked/, `${heading} never blocks the run`);
    assert.match(step, /Recommend a new session/);
    assert.match(step, /context is paid again on every turn/);
    assert.match(step, /If the user explicitly asks to continue in the same session, continue, and state the cost/);
    assert.match(step, /A pause is never a refusal/);
  }
  const step6 = flat(sectionOf(text, '### Step 6 — Pause after approval'));
  assert.match(step6, /Step 5 ends with `transition --to bootstrap --reason=<value>`; check that its output says phase `bootstrap`/);
});

test('step 7 (SC15): dependency order, owned parts with reports, required deliverables, deploy with a reason, and the root .gitignore rule', () => {
  const step7 = flat(sectionOf(readSkill(), '### Step 7 — Bootstrap'));
  assert.match(step7, /dependency order: a contract's producer comes before its consumers/);
  assert.match(step7, /explicit ownership/);
  assert.match(step7, /`\.apex\/inception\/bootstrap\/<part>\.md`/);
  assert.match(step7, /`bootstrap-part-prompt\.md`, one at a time/);
  assert.match(step7, /A child modifies only its own part/);
  assert.match(step7, /You, the coordinator, keep the dialogue, the effect log, checkpoints, any commits, and the descriptor/);
  for (const deliverable of [
    /manifests and lockfiles produced with the official tools at the approved versions/,
    /install, build, test, and start commands usable from a clean checkout/,
    /an example configuration without secrets/,
    /the data, integrations, and migrations the representative path needs/,
    /reuse of the chosen materials and preservation of the agreed behaviors/,
    /the representative path, actually integrated/,
    /CI and deploy instructions when the project includes them/,
  ]) {
    assert.match(step7, deliverable);
  }
  assert.match(step7, /Deploy is included or excluded with a reason/);
  assert.match(step7, /Included → it needs evidence of its result/);
  assert.match(step7, /Excluded → it does not prevent bootstrap from concluding/);
  assert.ok(step7.includes('A passing local test does not prove a remote deploy or CI.'));
  assert.match(step7, /Never build every prototype screen/);
  assert.match(step7, /Build and test fixes inside the scope are autonomous/);
  assert.match(step7, /A substantial change follows the re-approval rule in Step 5/);
  assert.match(step7, /The run never creates or edits the root `\.gitignore` for its own area/);
  assert.match(step7, /approved tool[^.]*may create or edit the root `\.gitignore` as an application file/);
  assert.match(step7, /operation with effects, recorded with `effect intent` and `effect outcome` like any other generator output/);
});

test('step 8 (SC15): intent before, outcome after, checks, then a checkpoint; authorized remote operations; nothing repeated or hidden', () => {
  const raw = sectionOf(readSkill(), '### Step 8 — Effects and checkpoints');
  const step8 = flat(raw);
  assert.match(
    step8,
    /an installation, a generator, a migration, an external resource, a deploy, a commit, or a remote operation/
  );
  const order = [
    'Before it runs: `effect intent --id <id> --kind <kind> --summary=<value>`',
    'Run the operation.',
    'After it: `effect outcome --id <id> --result succeeded|failed --observed=<value>`',
    'Run the relevant checks',
    'Record a checkpoint: `checkpoint create --label=<value> --file <path>`',
  ];
  let previous = -1;
  for (const item of order) {
    const position = step8.indexOf(item);
    assert.ok(position > previous, `step 8 must give '${item}' in order`);
    previous = position;
  }
  assert.match(step8, /a push, a repository creation, a deploy/);
  assert.match(step8, /explicit authorization for that one operation/);
  assert.match(step8, /Quote it in `--authorization=<value>`/);
  assert.match(step8, /the commit and its checks come before the checkpoint/);
  assert.match(step8, /A repository without Git and an uncommitted tree are supported when the checkpoint records them faithfully/);
  assert.match(step8, /An interruption never authorizes repeating a concluded or uncertain effect/);
  assert.match(step8, /A checkpoint is never replaced by a new baseline to hide changes/);
  assert.match(step8, /Children never run an operation with effects/);
  assert.match(step8, /lists the effects it needs in its report, and you run them/);
  assert.match(step8, /refuses an application file reached through a symlinked ancestor directory/);
  assert.match(step8, /a path named twice across `--file` and `--files-from`/);
  assert.match(step8, /Name each application file once, by its real path/);
});

test('step 10 (SC15): clean-state checks, five distinct result values, the results file, then complete and the closing note', () => {
  const raw = sectionOf(readSkill(), '### Step 10 — Final verification and conclusion');
  const step10 = flat(raw);
  assert.match(step10, /from a clean state/);
  assert.match(step10, /install, build, test, start, the representative path, and the preserved behaviors/);
  assert.match(step10, /environment, exact command or procedure, expected result, observed result, and limits/);
  const values = [...raw.matchAll(/^- `([a-z-]+)`: /gm)].map((match) => match[1]);
  assert.deepEqual(values, RESULT_VALUES, 'the five result values, each its own list item, in order');
  assert.equal(new Set(values).size, 5, 'the five result values are distinct tokens');
  assert.match(step10, /exactly one of five result values/);
  assert.match(step10, /resolved versions[^.]*match the approved combination/);
  assert.match(step10, /`\.apex\/inception\/verification\/results\.md`/);
  assert.match(step10, /`## Checks`/);
  assert.match(step10, /`## Coverage`/);
  assert.ok(raw.includes(`\n${CHECKS_HEADER}\n`), 'the checks table header, byte for byte');
  assert.ok(raw.includes(`\n${COVERAGE_HEADER}\n`), 'the coverage table header, byte for byte');
  assert.match(step10, /one row for each decision-register ID and each component/);
  assert.match(step10, /Status is `verified`, `unverified`, or `future`/);
  assert.match(step10, /Never edit the approved documents to record the results/);
  assert.match(step10, /after the last authorized commits/);
  const finale = [
    '`checkpoint create --label=<value> --file <path>`',
    '`transition --to complete --checkpoint <path> --verification .apex/inception/verification/results.md --reason=<value>`',
    '`resume-note --next=<value> --need .apex/inception/verification/results.md`',
  ];
  let previous = step10.indexOf('after the last authorized commits');
  for (const item of finale) {
    const position = step10.indexOf(item);
    assert.ok(position > previous, `step 10 must give ${item} in order`);
    previous = position;
  }
  assert.match(step10, /output's `checkpoint` field is the path to pass/);
  assert.match(step10, /does not verify clean, or while any effect is `uncertain`/);
  assert.ok(step10.includes(`\`<value>\` is exactly \`${CLOSING_NEXT}\``), 'the closing note carries the helper next step');
  assert.match(step10, /the `init` skill, then the `discovery` skill with the inception source/);
  assert.match(step10, /The run ends at `complete`\. It does not run the `init` skill/);
});

test('sessions (SC15): three sessions with two planned pauses, after approval and after bootstrap', () => {
  const raw = sectionOf(readSkill(), '## Sessions and context');
  const sessions = flat(raw);
  assert.match(sessions, /three sessions with two planned pauses: after approval \(Step 6\) and after bootstrap \(Step 9\)/);
  const rows = tableRows(raw);
  assert.deepEqual(rows[0], ['Session', 'Phases', 'Ends at']);
  assert.deepEqual(
    rows.filter((cells) => /^\d+$/.test(cells[0])).map((cells) => cells.slice(0, 2)),
    [
      ['1', 'reconnaissance, architecture, research, approval'],
      ['2', 'bootstrap'],
      ['3', 'verification and conclusion'],
    ]
  );
  assert.match(sessions, /starts from the descriptor and the latest resume note \(Step 1\), not from the earlier conversation/);
  assert.match(sessions, /Earlier context is paid on every turn/);
});

test('children (SC15): exact inputs, one output, one child at a time, abstract tiers, recorded models and degradations', () => {
  const raw = sectionOf(readSkill(), '## Children and dispatch policy');
  const children = flat(raw);
  assert.match(children, /receives exact input paths and one exact output path/);
  assert.match(children, /writes its detail to its own report and returns a short answer/);
  assert.match(children, /`status`, `artifact`, `changed-paths`, `signals`/);
  assert.match(children, /Read a full child report only for a concrete missing fact/);
  assert.match(children, /Children never inherit the coordinator's read capability/);
  assert.match(children, /Only one child runs at a time/);
  assert.match(children, /Research may continue in the background while you keep the dialogue going/);
  assert.match(children, /`standard` for research and experiments, `most-capable` for bootstrap parts/);
  assert.match(children, /Never write a concrete model ID/);
  assert.match(children, /Record the concrete model each child ran on, and any degradation, in the next resume note/);
  assert.match(children, /Without subagents, run the work inline yourself, and write the explicit degradation/);
  const templates = new Map(
    tableRows(raw)
      .map((cells) => [cells[0].match(/^`([a-z-]+\.md)`$/)?.[1], cells])
      .filter(([file]) => file)
  );
  assert.deepEqual([...templates.keys()], ['research-prompt.md', 'bootstrap-part-prompt.md']);
  assert.equal(templates.get('research-prompt.md')[2], '`standard`');
  assert.equal(templates.get('bootstrap-part-prompt.md')[2], '`most-capable`');
  for (const file of templates.keys()) {
    assert.ok(existsSync(join(root, 'skills', 'inception', file)), `skills/inception/${file} must exist`);
  }
});

test('harness degradations (SC15): inline without subagents, prose questions, the Step 4 network rule, no headless mode', () => {
  const harness = flat(sectionOf(readSkill(), '## Harness capabilities and degradations'));
  assert.match(harness, /No subagents → run each child's work inline, with a declared degradation/);
  assert.match(harness, /No question tool → ask in plain prose: one question, numbered options, and a recommendation/);
  assert.match(harness, /No network → the Step 4 rule/);
  assert.match(harness, /no headless or autopilot mode on any harness/);
  assert.match(harness, /Record each exercised degradation in the reconnaissance record/);
  assert.match(harness, /A degradation first met after approval goes in the next resume note \(`--note=<value>`\)/);
});

// ---------------------------------------------------------------------------
// The two child prompt templates (SC15)
// ---------------------------------------------------------------------------

const RETURN_FIELDS =
  '    status: <DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED>\n' +
  '    artifact: [OUTPUT_FILE]\n' +
  '    changed-paths: <paths or none>\n' +
  '    signals: <short IDs or none>\n' +
  '```\n';

const PROMPTS = [
  {
    file: 'research-prompt.md',
    role: 'researcher',
    tier: 'standard',
    placeholders: ['[INPUT_PATHS]', '[OUTPUT_FILE]', '[QUESTION]'],
    absent: ['[PART]', '[ALLOWED_PATHS]'],
  },
  {
    file: 'bootstrap-part-prompt.md',
    role: 'bootstrap part',
    tier: 'most-capable',
    placeholders: ['[INPUT_PATHS]', '[OUTPUT_FILE]', '[PART]', '[ALLOWED_PATHS]'],
    absent: ['[QUESTION]'],
  },
];

function readPrompt(file) {
  return readFileSync(join(root, 'skills', 'inception', file), 'utf8');
}

test('prompt templates (SC15): one fenced Subagent block with an abstract tier, the placeholders, and the four-field return', () => {
  for (const { file, role, tier, placeholders, absent } of PROMPTS) {
    const text = readPrompt(file);
    const fences = text.match(/^```/gm) ?? [];
    assert.equal(fences.length, 2, `${file}: exactly one fenced block`);
    assert.ok(text.includes(`\n\`\`\`\nSubagent (${role}):\n`), `${file}: the block opens with Subagent (${role}):`);
    assert.match(text, new RegExp(`\\n  model: ${tier}  # [^\\n]*dispatcher translates the tier to a concrete model\\n`), `${file}: model: ${tier}`);
    for (const placeholder of placeholders) assert.ok(text.includes(placeholder), `${file}: ${placeholder}`);
    for (const placeholder of absent) assert.ok(!text.includes(placeholder), `${file}: no ${placeholder}`);
    assert.ok(text.endsWith(RETURN_FIELDS), `${file}: the block ends with the four-field return`);
    const body = flat(text);
    assert.match(body, /Read exactly the files in \[INPUT_PATHS\]/);
    assert.match(body, /Never list or read anything else under `\.apex\/inception\/`/);
    assert.match(body, /Write the full report to \[OUTPUT_FILE\]; it is your only report write/);
    assert.match(body, /return ONLY these four unbulleted fields, in order/);
    assert.match(body, /harness provides a task\/subagent tool/);
    assert.match(body, /Otherwise[^.]*yourself[^.]*inline degradation/);
  }
});

test('prompt templates (SC15): portable — no concrete model ID, run-state helper, slash command, CLAUDE_, or home path', () => {
  for (const { file } of PROMPTS) {
    const text = readPrompt(file);
    assert.doesNotMatch(text, /\b(?:haiku|sonnet|opus|fable)\b|\bgpt-\d|\bgemini-\d|\bdeepseek-[a-z0-9]/i, `${file}: no concrete model ID`);
    assert.doesNotMatch(text, /inception-state/, `${file}: a child never touches the run state`);
    assert.doesNotMatch(text, /\/steepy(?:-apex)?:/);
    assert.doesNotMatch(text, /general-purpose/);
    assert.doesNotMatch(text, /CLAUDE_/);
    assert.doesNotMatch(text, /\/Users\/|\/home\/|~\//);
  }
});

test('research prompt (SC15): official sources with version, date, and support status; experiments isolated outside the repository', () => {
  const research = flat(readPrompt('research-prompt.md'));
  assert.match(research, /Use official sources only/);
  assert.match(research, /its version, its date[^.]*and its support status/);
  assert.match(research, /A version you remember is not a verified version/);
  assert.match(research, /Run an experiment only in an isolated directory outside the repository/);
  assert.match(research, /Never install, generate, or migrate inside the repository/);
  assert.match(research, /never deploy, commit, push, or create an external resource/);
  assert.match(research, /An experiment never becomes the bootstrap/);
});

test('bootstrap part prompt (SC15): only the allowed paths, no operation with effects, local build and test checks allowed', () => {
  const part = flat(readPrompt('bootstrap-part-prompt.md'));
  assert.match(part, /\[ALLOWED_PATHS\] are the only application paths you may modify/);
  assert.match(part, /Run no installs, generators, migrations, deploys, commits, or remote operations/);
  assert.match(part, /list it in the report as an effect the coordinator must run/);
  assert.match(part, /You may run local build and test checks/);
  assert.match(part, /Never build every prototype screen/);
  assert.match(part, /outside \[ALLOWED_PATHS\] or outside the approved project, stop and report it/);
});

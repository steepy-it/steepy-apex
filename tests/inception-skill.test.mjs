// Content contracts for skills/inception/SKILL.md, part 1: entry, local area, and
// reconnaissance through the single human approval (SC2, SC4, SC14).
//
// Doc-content-lock suite: it reads files only and never writes. The helper command spellings
// below are the inception helper contract's HC7 lines with `<common>` written as
// `--repo-root .`; the classification rows are HC8's; the run file locations are HC2's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.match(boundaries, /Never edit the root `\.gitignore`/);
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { materializeTaskBrief, parseExecutablePlan, parseFixTargets } from '../scripts/autopilot-plan.mjs';

const routingText = '| Surface | Min docs | Specialist agent | Applicable skill |\n|---|---|---|---|\n| `scripts` | [scripts](standards/scripts.md) | `scripts-agent` | — |\n| `web` | [web](standards/web/web-core.md) | `web-agent` | — |\n';
const standardsBySurface = {
  scripts: '.apex/standards/scripts.md',
  web: { core: '.apex/standards/web/web-core.md', leaves: [
    '.apex/standards/web/web-auth.md', '.apex/standards/web/web-data.md',
  ] },
};
const task = (id, overrides = '') => `## Task ${id} — useful work\n\n- **Requirements and deliverables:** Implement the stated behavior.\n- **Relevant global constraints:** Preserve compatibility.\n- **Surface:** \`scripts\`\n- **Specialist agent:** \`scripts-agent\`\n- **Exact paths:** \`scripts/example.mjs\`, \`tests/example.test.mjs\`\n- **Test command:** \`npm test\`\n- **Dependencies:** ${id === 1 ? 'none' : 'Task 1'}\n- **Complexity:** integration\n- **Success criteria:** SC1, SC2\n${overrides}`;
const parse = (text, options = {}) => parseExecutablePlan(`# Plan\n\n${text}`, { routingText, standardsBySurface, ...options });

test('a complete task yields an independent brief with every executable field', () => {
  const [first, second] = parse(`${task(1)}\n${task(2)}`).tasks;
  assert.deepEqual(first.dependencies, []);
  assert.deepEqual(second.dependencies, ['1']);
  assert.deepEqual(first.exactPaths, ['scripts/example.mjs', 'tests/example.test.mjs']);
  const brief = materializeTaskBrief(second, { sourcePlanPath: '.apex/work/plans/example.md' });
  for (const fragment of ['Requirements and deliverables', 'Relevant global constraints', 'Surface',
    'Specialist agent', 'Exact paths', 'Test command', 'Dependencies', 'Complexity', 'Success criteria',
    'Implement the stated behavior.', 'Preserve compatibility.', 'scripts-agent', 'SC1, SC2']) {
    assert.ok(brief.includes(fragment), fragment);
  }
  assert.match(brief, /Dependencies:\*\* Task 1/);
});

test('missing or duplicate task fields fail before materialization', () => {
  for (const label of ['Requirements and deliverables', 'Relevant global constraints', 'Specialist agent',
    'Exact paths', 'Test command', 'Dependencies']) {
    assert.throws(() => parse(task(1).replace(new RegExp(`^- \\*\\*${label}:\\*\\*.*\\n`, 'm'), '')),
      new RegExp(`missing ${label}`, 'i'), label);
  }
  assert.throws(() => parse(task(1).replace('- **Complexity:** integration', '- **Complexity:** integration\n- **Complexity:** design')),
    /duplicate Complexity/i);
  assert.throws(() => parse(`${task(1)}\n${task(1)}`), /duplicate.*task/i);
});

test('dependencies, routing, paths, and criteria are validated', () => {
  assert.throws(() => parse(task(1).replace('Dependencies:** none', 'Dependencies:** Task 2')), /dependency.*prior/i);
  assert.throws(() => parse(`${task(1)}\n${task(2).replace('Task 1', 'Task 1, Task 1')}`), /duplicate dependency/i);
  assert.throws(() => parse(task(1).replace('scripts-agent', 'web-agent')), /Specialist agent.*routing/i);
  assert.throws(() => parse(task(1).replace('scripts/example.mjs', '../secret')), /path|traversal/i);
  assert.throws(() => parse(task(1).replace('SC1, SC2', 'SC2, SC1')), /criteria.*increasing/i);
});

test('a modular core requires explicit reachable ordered leaves and routing reasons', () => {
  const web = task(1).replace('`scripts`', '`web`').replace('`scripts-agent`', '`web-agent`');
  assert.throws(() => parse(web), /Standard paths.*modular/i);
  const selected = `${web}- **Standard paths:** \`.apex/standards/web/web-core.md\`, \`.apex/standards/web/web-auth.md\`\n- **Routing reasons:** \`web-auth.md\` covers the authentication path.\n`;
  const [parsed] = parse(selected).tasks;
  assert.deepEqual(parsed.standardPaths, ['.apex/standards/web/web-core.md', '.apex/standards/web/web-auth.md']);
  assert.doesNotMatch(materializeTaskBrief(parsed), /web-data\.md/);
  assert.throws(() => parse(selected.replace('web-auth.md`\n', 'web-ghost.md`\n')), /reachable|routed/i);
  assert.throws(() => parse(selected.replace('web-core.md`, `.apex/standards/web/web-auth.md', 'web-auth.md`, `.apex/standards/web/web-core.md')), /core.*first|order/i);
  assert.throws(() => parse(selected.replace('web-auth.md` covers the authentication path.', 'Unexplained selection.')), /Routing reasons.*web-auth/i);
});

test('a spec section reference needs an exact declared capability', () => {
  const referred = task(1).replace('Implement the stated behavior.',
    'Apply `.apex/work/specs/example.md#Required-behavior`.');
  assert.throws(() => parse(referred), /spec.*capability/i);
  const capabilities = [{ reference: '.apex/work/specs/example.md#Required-behavior', text: 'Preserve the old parser.' }];
  const [parsed] = parse(referred, { specCapabilities: capabilities }).tasks;
  assert.match(materializeTaskBrief(parsed), /Preserve the old parser\./);
  assert.throws(() => parse(referred, { specCapabilities: [{ ...capabilities[0], reference: '.apex/work/specs/example.md#Other' }] }),
    /spec.*capability/i);
  assert.throws(() => parse(task(1).replace('Implement the stated behavior.',
    'Apply `.apex/work/specs/example.md` section Required behavior.')), /spec.*exact|spec.*heading/i);
});

// The planner's canonical shape: nested annotated path bullets (the expected
// change at each path), nested field values, and task notes after the fields.
const plannerTask = `## Task 3 — Materialize briefs

- **Requirements and deliverables:** Build the brief materializer.
- **Relevant global constraints:**
  - No work-area search.
  - The legacy parser stays public.
- **Surface:** \`scripts\`
- **Specialist agent:** \`scripts-agent\`
- **Exact paths:**
  - \`scripts/example.mjs\` — create the parser, validation,
    and the brief writer.
  - \`tests/example.test.mjs\`, \`tests/other.test.mjs\` — tests-agent contribution: incomplete, duplicate, and future tasks.
- **Test command:** \`npm test\`
- **Dependencies:** none
- **Complexity:** design
- **Success criteria:** SC1, SC8

The compact parser, planPhaseContext, keeps its contract.

Targeted tests: \`node --test tests/example.test.mjs\`.
`;

test('the planner task shape keeps annotated paths, nested values, and task notes in the brief', () => {
  const [parsed] = parse(plannerTask).tasks;
  assert.deepEqual(parsed.exactPaths, ['scripts/example.mjs', 'tests/example.test.mjs', 'tests/other.test.mjs']);
  assert.deepEqual(parsed.criterionIds, ['SC1', 'SC8']);
  const brief = materializeTaskBrief(parsed);
  assert.match(brief, /- \*\*Relevant global constraints:\*\*\n {2}- No work-area search\.\n {2}- The legacy parser stays public\.\n/);
  assert.match(brief, /- \*\*Exact paths:\*\*\n {2}- `scripts\/example\.mjs` — create the parser, validation,\n {4}and the brief writer\.\n/);
  assert.ok(brief.includes('tests-agent contribution: incomplete, duplicate, and future tasks.'));
  assert.ok(brief.includes('The compact parser, planPhaseContext, keeps its contract.'));
  assert.ok(brief.includes('Targeted tests: `node --test tests/example.test.mjs`.'));
});

test('field-list ambiguity fails closed with a named reason', () => {
  assert.throws(() => parse(plannerTask.replace('- **Complexity:** design\n', '- **Complexity:** design\n- **Spec criteria:** SC3\n')),
    /unknown field Spec criteria/i);
  assert.throws(() => parse(`${plannerTask}\n- **Standard paths:** \`.apex/standards/scripts.md\`\n`), /follows task notes/i);
  for (const entry of ['`../secret.mjs` — escape', '`scripts/a.mjs` `scripts/b.mjs`', 'scripts/a.mjs and more']) {
    assert.throws(() => parse(plannerTask.replace('`scripts/example.mjs` — create the parser, validation,', entry)),
      /Exact paths/, entry);
  }
});

test('spec references anywhere in the task need an exact declared capability', () => {
  const reference = '.apex/work/specs/example.md#Required-behavior';
  const inNotes = plannerTask.replace('keeps its contract.', `keeps its contract per \`${reference}\`.`);
  assert.throws(() => parse(inNotes), /spec.*capability/i);
  const [parsed] = parse(inNotes, { specCapabilities: [{ reference, text: 'Keep the compact parser public.' }] }).tasks;
  assert.match(materializeTaskBrief(parsed), /Keep the compact parser public\./);
  assert.throws(() => parse(plannerTask.replace('and the brief writer.', `and the brief writer from \`${reference}\`.`)),
    /spec.*capability/i);
  assert.throws(() => parse(plannerTask.replace('keeps its contract.', 'keeps [its contract](../specs/example.md#Required-behavior).')),
    /spec.*exact/i);
});

test('a later global H2 is not absorbed into the final task field', () => {
  const plan = `${task(1)}\n## Notes\n\nHuman context remains outside the task.\n`;
  assert.deepEqual(parse(plan).tasks[0].criterionIds, ['SC1', 'SC2']);
});

test('fix targets are a strict declared mapping to known tasks and findings', () => {
  const issue = '# Findings\n\nFinding F1: broken output.\nFinding F2: missing guard.\n\nsteepy-fix-targets: v1\n```json\n[{"task":"1","issueIds":["F1"]},{"task":"2","issueIds":["F2"]}]\n```\n';
  const options = { taskIds: ['1', '2'], findingIds: ['F1', 'F2'] };
  assert.deepEqual(parseFixTargets(issue, options), [
    { task: '1', issueIds: ['F1'] }, { task: '2', issueIds: ['F2'] },
  ]);
  assert.throws(() => parseFixTargets(issue.replace('"F2"', '"F9"'), options), /unknown finding/i);
  assert.throws(() => parseFixTargets(issue.replace('"task":"2"', '"task":"3"'), options), /unknown task/i);
  assert.throws(() => parseFixTargets(issue.replace('"F2"', '"F1"'), options), /duplicate.*finding/i);
  assert.throws(() => parseFixTargets(issue.replace('steepy-fix-targets: v1', 'steepy-fix-targets: v1\nintervening'), options), /immediately/i);
  assert.throws(() => parseFixTargets(issue.replace('steepy-fix-targets: v1', 'steepy-fix-targets: v2\n\nsteepy-fix-targets: v1'), options),
    /exactly one.*marker/i);
});

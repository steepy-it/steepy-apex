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

// Review fix — iteration 1.

test('a fenced H2 in task notes stays in the brief while an unfenced global H2 stays out', () => {
  const fenced = `${task(1)}\nNotes start.\n\n\`\`\`markdown\n## Testing\nnpm test\n\`\`\`\n\n~~~~\n## Inside tilde\n~~~\nstill fenced\n~~~~\n\nMUST ALSO DO: critical requirement after fence.\n\n## Notes\n\nHuman context remains outside the task.\n`;
  const [parsed] = parse(fenced).tasks;
  const brief = materializeTaskBrief(parsed);
  assert.ok(brief.includes('```markdown\n## Testing\nnpm test\n```\n'), brief);
  assert.ok(brief.includes('~~~~\n## Inside tilde\n~~~\nstill fenced\n~~~~\n'), brief);
  assert.ok(brief.includes('MUST ALSO DO: critical requirement after fence.'), brief);
  assert.doesNotMatch(brief, /Human context remains outside the task/);
});

test('exact paths refuse Git metadata and repository-local areas but keep stable hub paths', () => {
  for (const path of ['.git', '.git/config', '.GIT/config', '.apex/work/plans/x.md', '.apex/inception/state.json', '.APEX/Work/x.md']) {
    assert.throws(() => parse(task(1).replace('scripts/example.mjs', path)), /Exact paths/, path);
  }
  for (const path of ['.apex/standards/scripts.md', '.apex/_INDEX.md', '.github/workflows/ci.yml']) {
    const [accepted] = parse(task(1).replace('scripts/example.mjs', path)).tasks;
    assert.deepEqual(accepted.exactPaths, [path, 'tests/example.test.mjs'], path);
  }
});

test('exact paths refuse absolute, non-canonical, and glob entries', () => {
  for (const path of ['/etc/x', 'scripts//a.mjs', './scripts/a.mjs', 'scripts/', 'scripts/*.mjs']) {
    assert.throws(() => parse(task(1).replace('scripts/example.mjs', path)), /Exact paths/, path);
  }
});

test('any spelling that can name the work spec area needs an exact capability', () => {
  for (const mention of ['.APEX/WORK/SPECS/x.md#a', 'work/specs/x.md#a', 'specs/x.md#a', '../../work/specs/x.md']) {
    assert.throws(() => parse(task(1).replace('Implement the stated behavior.', `Apply \`${mention}\`.`)),
      /spec.*capability/i, mention);
  }
  const reference = '.apex/work/specs/x.md#a';
  const [resolved] = parse(task(1).replace('Implement the stated behavior.', `Apply \`${reference}\`.`),
    { specCapabilities: [{ reference, text: 'Exact section text.' }] }).tasks;
  assert.deepEqual(resolved.resolvedSpecSections, [{ reference, text: 'Exact section text.' }]);
  const [ordinary] = parse(task(1).replace('scripts/example.mjs', 'docs/specs/guide.md')).tasks;
  assert.deepEqual(ordinary.exactPaths, ['docs/specs/guide.md', 'tests/example.test.mjs']);
});

test('routing reasons must name a selected leaf as a whole token', () => {
  const leaves = { ...standardsBySurface, web: { core: '.apex/standards/web/web-core.md', leaves: [
    '.apex/standards/web/auth.md', '.apex/standards/web/web-auth.md',
  ] } };
  const web = task(1).replace('`scripts`', '`web`').replace('`scripts-agent`', '`web-agent`');
  const select = (reasons) => `${web}- **Standard paths:** \`.apex/standards/web/web-core.md\`, \`.apex/standards/web/auth.md\`\n- **Routing reasons:** ${reasons}\n`;
  assert.throws(() => parse(select('`web-auth.md` covers sessions.'), { standardsBySurface: leaves }),
    /Routing reasons must explain selected leaf auth\.md/);
  for (const reasons of ['`auth.md` covers sessions.', 'See .apex/standards/web/auth.md for sessions.']) {
    assert.deepEqual(parse(select(reasons), { standardsBySurface: leaves }).tasks[0].standardPaths,
      ['.apex/standards/web/web-core.md', '.apex/standards/web/auth.md'], reasons);
  }
});

test('fix targets refuse omitted findings, missing markers, numeric tasks, empty issues, and repeated tasks', () => {
  const issue = (rows) => `# Findings\n\nsteepy-fix-targets: v1\n\`\`\`json\n${rows}\n\`\`\`\n`;
  const options = { taskIds: ['1', '2'], findingIds: ['F1', 'F2'] };
  assert.throws(() => parseFixTargets(issue('[{"task":"1","issueIds":["F1"]}]'), options), /omit finding F2/);
  assert.throws(() => parseFixTargets('# Findings\n\nNo mapping.\n', options), /exactly one.*marker/i);
  assert.throws(() => parseFixTargets(issue('[{"task":1,"issueIds":["F1","F2"]}]'), options), /unknown task/i);
  assert.throws(() => parseFixTargets(issue('[{"task":"1","issueIds":[]},{"task":"2","issueIds":["F1","F2"]}]'), options),
    /need issueIds/i);
  assert.throws(() => parseFixTargets(issue('[{"task":"1","issueIds":["F1"]},{"task":"1","issueIds":["F2"]}]'), options),
    /duplicate task/i);
});

// Review fix — iteration 2: a fence still open when its task section ends is
// refused by name, never allowed to absorb the global sections after it.

test('an unclosed fence in the last task fails before an unfenced global H2 can join the notes', () => {
  assert.throws(() => parse(`${task(1)}\nNotes.\n\n\`\`\`\ncode\n\n## Notes\n\nHuman context remains outside the task.\n`),
    /Task 1 has an unclosed code fence/);
});

test('an unclosed fence before the next task fails instead of absorbing a global section', () => {
  assert.throws(() => parse(`${task(1)}\nNotes.\n\n\`\`\`\ncode\n\n## Global footer\n\nGLOBAL CONTENT\n${task(2)}`),
    /Task 1 has an unclosed code fence/);
});

test('a mismatched closer leaves the fence open and fails by name', () => {
  for (const [opener, closer] of [['````', '```'], ['~~~', '```'], ['```', '``` trailing'], ['```', '~~~']]) {
    assert.throws(() => parse(`${task(1)}\nNotes.\n\n${opener}\ncode\n${closer}\n\n## Notes\n\nGLOBAL CONTENT\n`),
      /Task 1 has an unclosed code fence/, `${opener} closed by ${closer}`);
  }
});

test('an unclosed fence inside the last multi-line field fails before a global H2 can join the field', () => {
  assert.throws(() => parse(`${task(1)}- **Routing reasons:** Core only.\n  \`\`\`\n  sketch\n\n## Global footer\n\nGLOBAL CONTENT\n`),
    /Task 1 has an unclosed code fence/);
});

test('the bare hub directory is refused like the local areas it contains', () => {
  assert.throws(() => parse(task(1).replace('scripts/example.mjs', '.apex')), /repository-local area/);
});

test('a fence opened in a field value is unclosed when an unindented line ends its list item', () => {
  const inField = (lines) => task(1).replace('- **Relevant global constraints:** Preserve compatibility.\n',
    `- **Relevant global constraints:** Preserve compatibility:\n  \`\`\`\n${lines}\n`);
  for (const lines of ['## Global inside field fence\n  ```', 'COL0 TEXT\n  ```', '  code\n```']) {
    assert.throws(() => parse(inField(lines)), /Task 1 has an unclosed code fence in Relevant global constraints/, lines);
  }
  const [wellFormed] = parse(inField('  ## not a heading\n  ```')).tasks;
  assert.equal(wellFormed.constraints, 'Preserve compatibility:\n  ```\n  ## not a heading\n  ```');
});

test('an HTML comment still open at an H2 or at the section end fails instead of dropping notes', () => {
  assert.throws(() => parse(`${task(1)}\nNotes.\n\n<!--\n## commented\n-->\n\nMORE REQUIREMENTS\n`),
    /^Error: Task 1 has an HTML comment that spans an H2 line$/);
  assert.throws(() => parse(`${task(1)}\nNotes.\n\n<!-- still open\n${task(2)}`), /Task 1 has an unclosed HTML comment/);
  const [closed] = parse(`${task(1)}\nNotes.\n\n<!-- a closed comment -->\n<!--\nspans lines\n-->\n\nMORE REQUIREMENTS\n`).tasks;
  assert.ok(closed.notes.endsWith('MORE REQUIREMENTS'));
});

// CommonMark ends a comment at the first `-->` from its `<!--`, overlap included.
test('the overlapping comment forms are complete, and only a comment open at the section end is unclosed', () => {
  for (const comment of ['<!-->', '<!--->']) {
    for (const plan of [`${task(1)}\nNotes.\n\n${comment}\n\nMORE REQUIREMENTS\n`,
      `${task(1)}\nNotes.\n\n${comment}\n\nMORE REQUIREMENTS\n\n## Notes\n\nGlobal.\n`]) {
      const [parsed] = parse(plan).tasks;
      assert.equal(parsed.notes, `Notes.\n\n${comment}\n\nMORE REQUIREMENTS`, comment);
    }
  }
  assert.throws(() => parse(`${task(1)}\nNotes.\n\n<!---\nMORE REQUIREMENTS\n`), /^Error: Task 1 has an unclosed HTML comment$/);
  assert.throws(() => parse(`${task(1)}\nNotes.\n\n<!-- still open\nMORE REQUIREMENTS\n`), /^Error: Task 1 has an unclosed HTML comment$/);
});

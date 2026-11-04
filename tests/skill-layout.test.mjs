import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sectionBetween } from './support/markdown.mjs';
import { SKILL_HEAD_CEILING_BYTES, STEP_FILE_RULE, markdownFileRefs, skillHead, skillsDir, stepFiles } from './support/skills.mjs';

// Locks the compaction-safe skill layout: after a context compaction a harness re-attaches only
// the start of each invoked skill, so every SKILL.md must fit under the ceiling whole, and the
// step detail it moved out must stay named, present, and reachable.
const skillNames = readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

test('the ten canonical skill directories each hold a SKILL.md', () => {
  for (const name of skillNames) {
    assert.ok(existsSync(join(skillsDir, name, 'SKILL.md')), `skills/${name}/ must hold a SKILL.md`);
  }
  assert.equal(skillNames.length, 10, `expected the ten canonical skills, found: ${skillNames.join(', ')}`);
});

test('every SKILL.md fits under the compaction ceiling', () => {
  for (const name of skillNames) {
    const bytes = statSync(join(skillsDir, name, 'SKILL.md')).size;
    assert.ok(bytes <= SKILL_HEAD_CEILING_BYTES,
      `${name}/SKILL.md is ${bytes} bytes; move step detail into step files to stay within ${SKILL_HEAD_CEILING_BYTES}`);
  }
});

test('a split SKILL.md names existing step files and carries the canonical re-read rule', () => {
  for (const name of skillNames) {
    const files = stepFiles(name);
    if (files.length === 0) continue;
    const head = skillHead(name);
    assert.ok(head.includes(STEP_FILE_RULE), `${name}/SKILL.md must carry the canonical step-file re-read rule`);
    for (const file of files) {
      assert.ok(existsSync(join(skillsDir, name, file)), `${name}/${file} is named by the step map and must exist`);
      assert.doesNotMatch(readFileSync(join(skillsDir, name, file), 'utf8'), /^---\n/,
        `${name}/${file} is a step file, not a skill: it must not carry frontmatter`);
    }
  }
});

test('every Markdown file in a skill directory is reachable from its SKILL.md', () => {
  for (const name of skillNames) {
    const dir = join(skillsDir, name);
    const present = readdirSync(dir).filter((file) => file.endsWith('.md'));
    const reached = new Set(['SKILL.md']);
    const queue = ['SKILL.md'];
    while (queue.length > 0) {
      const text = readFileSync(join(dir, queue.pop()), 'utf8');
      for (const file of markdownFileRefs(text)) {
        if (present.includes(file) && !reached.has(file)) {
          reached.add(file);
          queue.push(file);
        }
      }
    }
    const orphans = present.filter((file) => !reached.has(file));
    assert.deepEqual(orphans, [], `${name}: every co-located Markdown file must be named from SKILL.md or a file it names`);
  }
});

test('rules that must hold for a whole run stay in the SKILL.md head', () => {
  for (const name of ['brainstorm', 'plan', 'implement', 'review', 'loop-engineer']) {
    const head = skillHead(name);
    assert.match(head, /\n## Checklist\n/, `${name} keeps its checklist in SKILL.md`);
    assert.match(head, /\n## Model Selection\n/, `${name} keeps Model Selection in SKILL.md`);
    assert.doesNotMatch(head, /steepy:manual-handoff/, `${name} reads the handoff block from manual-handoff.md`);
    assert.ok(stepFiles(name).includes('manual-handoff.md'), `${name} names manual-handoff.md in its step map`);
  }
  assert.match(skillHead('implement'), /\n## Fix-round cap\n/);
  assert.match(skillHead('loop-engineer'), /\n### Controller responsibility boundary\n/);
  assert.match(skillHead('discovery'), /\n## Model Selection\n/);
  assert.match(skillHead('init'), /\n## Workflow contract\n/);
  const inception = skillHead('inception');
  for (const heading of ['## Boundaries', '## Sessions and context', '## Children and dispatch policy', '## Harness capabilities and degradations']) {
    assert.ok(inception.includes(`\n${heading}\n`), `inception keeps ${heading} in SKILL.md`);
  }
  assert.match(inception, /Persist before work: once a run exists, begin a unit before any decision, research, child\s+dispatch, application write, or effect/);
});

// A step file whose rules a later or skipped step also relies on must be read there too, or a
// compaction or a gear that skips its usual trigger leaves those rules out of view.
test('step-map read points cover every step that relies on the file', () => {
  const row = (name, file) => skillHead(name).split('\n').find((line) => line.startsWith('|') && line.includes(`\`${file}\``));
  assert.match(row('brainstorm', 'manual-handoff.md'), /Step 7 in Gear 3, Step 8 in Gear 2/);
  assert.match(row('discovery', 'surface-loop.md'), /or the inception source/);
  assert.match(row('inception', 'bootstrap.md'), /in any session before you prepare or observe an effect \(Step 8\)/);
  assert.match(row('init', 'finish.md'), /explicit certification replay/);
});

// A read point that no step relies on only spends context.
test('step-map read points skip files a step never relies on', () => {
  const row = skillHead('brainstorm').split('\n').find((line) => line.startsWith('|') && line.includes('`manual-handoff.md`'));
  assert.doesNotMatch(row, /before accepting any input/, 'brainstorm accepts no handoff input, so it reads manual-handoff.md only to publish');
  assert.match(row, /accepts no handoff input/);
  const project = readFileSync(join(skillsDir, 'inception', 'project.md'), 'utf8');
  const bootstrap = readFileSync(join(skillsDir, 'inception', 'bootstrap.md'), 'utf8');
  assert.match(project, /\n### Step 6 — Pause after approval\n/, 'the pause after approval sits with the approval, not in bootstrap.md');
  assert.doesNotMatch(bootstrap, /### Step 6/);
});

// The head restates helper.md's unit rule so it survives a compaction; both copies must name the
// same work.
test('inception head and helper.md list the same work that needs a unit', () => {
  const flat = (text) => text.replace(/\s+/g, ' ');
  const head = flat(sectionBetween(skillHead('inception'), '- Persist before work:', '\n\n'));
  const helper = flat(sectionBetween(readFileSync(join(skillsDir, 'inception', 'helper.md'), 'utf8'),
    '### Persisted work units and recovery'));
  for (const [label, pattern] of [
    ['begin', /before any ((?:[a-z ]+?, )+?or [a-z ]+)/i],
    ['finish', /before a ((?:[a-z ]+?, )+?or [a-z ]+)/i],
  ]) {
    const inHead = head.match(pattern)?.[1].trim();
    const inHelper = helper.match(pattern)?.[1].trim();
    assert.ok(inHead && inHelper, `both copies must state what a unit must ${label} before`);
    assert.equal(inHead, inHelper, `the head and helper.md must list the same work to ${label} a unit before`);
  }
});

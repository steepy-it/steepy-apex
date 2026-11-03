import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_HEAD_CEILING_BYTES, STEP_FILE_RULE, skillHead, skillsDir, stepFiles } from './support/skills.mjs';

// Locks the compaction-safe skill layout: after a context compaction a harness re-attaches only
// the start of each invoked skill, so every SKILL.md must fit under the ceiling whole, and the
// step detail it moved out must stay named, present, and reachable.
const skillNames = readdirSync(skillsDir).filter((name) => existsSync(join(skillsDir, name, 'SKILL.md'))).sort();

test('the ten canonical skills are all checked', () => {
  assert.equal(skillNames.length, 10);
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
      for (const match of text.matchAll(/`([a-z0-9-]+\.md)`/g)) {
        if (present.includes(match[1]) && !reached.has(match[1])) {
          reached.add(match[1]);
          queue.push(match[1]);
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

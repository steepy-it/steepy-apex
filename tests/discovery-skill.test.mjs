import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const skillsDir = join(root, 'skills');
const promptPath = join(skillsDir, 'discovery', 'explore-surface-prompt.md');
const skillPath = join(skillsDir, 'discovery', 'SKILL.md');
const initSkillPath = join(skillsDir, 'init', 'SKILL.md');
const implementSkillPath = join(skillsDir, 'implement', 'SKILL.md');
const readmePath = join(root, 'README.md');
const skillsStandardPath = join(root, '.apex', 'standards', 'skills.md');

// Reuses the bare-invocation guard style from tests/workflow-skills.test.mjs.
const workflowCommands = ['init', 'new-surface', 'check', 'brainstorm', 'plan', 'implement', 'review'];

function assertNoBareWorkflowInvocations(text, label) {
  const commandAlternation = workflowCommands.join('|');
  const bareInvocation = new RegExp(`(^|[^\\w:.-])/(${commandAlternation})\\b`, 'm');
  assert.doesNotMatch(text, bareInvocation, `${label} must namespace shipped workflow slash commands`);
}

test('discovery: explore-surface-prompt.md exists', () => {
  assert.ok(existsSync(promptPath), 'skills/discovery/explore-surface-prompt.md should exist');
});

test('discovery: explore-surface-prompt.md instructs a per-area structured findings report', () => {
  const text = readFileSync(promptPath, 'utf8');
  assert.match(text, /observed conventions/i, 'must cover observed conventions');
  assert.match(text, /candidate anti-patterns/i, 'must cover candidate anti-patterns');
  assert.match(text, /candidate glossary terms/i, 'must cover candidate glossary terms');
  assert.match(text, /discovered doc files/i, 'must cover discovered doc files');
});

test('discovery: explore-surface-prompt.md enforces file:line evidence and no invention', () => {
  const text = readFileSync(promptPath, 'utf8');
  assert.match(text, /`file:line`/, 'must require file:line evidence on every finding');
  assert.match(text, /invent nothing/i, 'must instruct the explorer to invent nothing');
  assert.match(text, /drop/i, 'must instruct dropping unverifiable claims rather than guessing');
});

test('discovery: explore-surface-prompt.md sets an explicit model tier', () => {
  const text = readFileSync(promptPath, 'utf8');
  assert.match(text, /model:\s*(cheap|standard|most-capable)\b/, 'must set an explicit model tier');
});

test('discovery: explore-surface-prompt.md uses abstract tiers only, no concrete model ids', () => {
  const text = readFileSync(promptPath, 'utf8');
  assert.doesNotMatch(
    text,
    /\b(haiku|sonnet|opus)\b/,
    'must not hardcode a concrete model id — use the abstract tier'
  );
});

test('discovery: explore-surface-prompt.md accepts [REPORT_FILE] and writes the full report to it', () => {
  const text = readFileSync(promptPath, 'utf8');
  assert.match(text, /\[REPORT_FILE\]/, 'must name the [REPORT_FILE] dispatch parameter');
  assert.match(
    text,
    /writ(e|es|ing)[\s\S]{0,80}\[REPORT_FILE\]|\[REPORT_FILE\][\s\S]{0,80}writ(e|es|ing)/i,
    'must instruct writing the full report to [REPORT_FILE]'
  );
  assert.match(text, /full report/i, 'must call for the full report, not a partial one');
});

test('discovery: explore-surface-prompt.md returns only a terse (≤15-line) status', () => {
  const text = readFileSync(promptPath, 'utf8');
  assert.match(text, /≤\s*15|15\s*lines?/, 'must impose a terse ≤15-line return status');
});

test('discovery: explorer completion is self-contained, with counts in the report and no numeric schema dependency', () => {
  const text = readFileSync(promptPath, 'utf8');
  assert.doesNotMatch(text, /implementer-prompt\.md|\.md:\d+(?:-\d+)?/);
  assert.match(text, /status: <DONE\|BLOCKED>\n\s+artifact: \[REPORT_FILE\]\n\s+changed-paths: none\n\s+signals: <short IDs or none>/);
  assert.match(text, /item counts per area[^]*report/i);
  assert.match(text, /\*\*Current standard docs:\*\* \[STANDARD_PATHS\]/);
  assert.match(text, /\*\*Glossary:\*\* \[GLOSSARY_PATH\]/);
  const skill = readFileSync(skillPath, 'utf8');
  assert.match(skill, /explore-surface-prompt\.md[^]*Output Format/i);
  assert.match(skill, /\[STANDARD_PATHS\][^]*\[GLOSSARY_PATH\]/);
  assert.match(skill, /BLOCKED[^]*report[^]*stop[^]*interview/i);
});

test('changed cross-skill contract references resolve named headings and reject stale anchors', () => {
  const references = [
    {
      sourcePath: skillPath,
      targetPath: promptPath,
      targetLabel: 'skills/discovery/explore-surface-prompt.md',
      heading: 'Output Format',
    },
    {
      sourcePath: implementSkillPath,
      targetPath: initSkillPath,
      targetLabel: 'skills/init/SKILL.md',
      heading: 'Step 4 — Complete the governed hub',
    },
  ];
  for (const reference of references) assertNamedHeadingReference(reference);

  for (const path of [skillPath, promptPath, implementSkillPath]) {
    assert.doesNotMatch(
      readFileSync(path, 'utf8'),
      /(?:skills\/)?[^\s`]+\.md:\d+(?:-\d+)?/,
      `${path} must not retain numeric Markdown anchors`,
    );
  }

  assert.throws(() => assertNamedHeadingReference({
    ...references[0],
    heading: 'Then return ONLY (lines 47-52)',
  }));
  assert.throws(() => assertNamedHeadingReference({
    ...references[1],
    heading: 'Step 4.5',
  }));
});

test('discovery: explore-surface-prompt.md turns findings into item cards with the 4 named fields', () => {
  const text = readFileSync(promptPath, 'utf8');
  assert.match(text, /Proposed doc text/, 'must name the Proposed doc text field');
  assert.match(text, /Occurrences/, 'must name the Occurrences field');
  assert.match(text, /isolated precedent/i, 'must name the isolated precedent marker');
  assert.match(text, /Why it matters/, 'must name the Why it matters field');
});

test('discovery: SKILL.md exists with frontmatter name: discovery and user-invocable: true', () => {
  assert.ok(existsSync(skillPath), 'skills/discovery/SKILL.md should exist');
  const text = readFileSync(skillPath, 'utf8');
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fmMatch, 'discovery SKILL.md should have YAML frontmatter');
  assert.match(fmMatch[1], /name:\s*discovery\b/, 'frontmatter name must be discovery');
  assert.match(fmMatch[1], /user-invocable:\s*true/, 'must be user-invocable');
});

test('discovery: SKILL.md states the precondition — hub absent → run the abstract init skill and stop', () => {
  const text = readFileSync(skillPath, 'utf8');
  assert.match(text, /the `init` skill/, 'must point the user at the init skill by abstract name');
  assert.doesNotMatch(text, /\/steepy-apex:/, 'must not use a Claude-only namespaced slash invocation');
  assert.match(text, /absent/i, 'must name the absent-hub precondition');
  assert.match(text, /stop/i, 'must instruct the skill to stop when the hub is missing');
});

test('discovery: SKILL.md has a run-scoping step (surface + cross-cutting docs)', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step1 = sectionBetween(text, '### Step 1', '### Step 2');
  assert.match(step1, /scope/i, 'run-scoping step must use the word "scope"');
  assert.match(step1, /surface/i, 'run-scoping step must reference surface(s)');
  assert.match(
    step1,
    /cross-cutting|conventions\.md|glossary\.md/i,
    'run-scoping step must reference cross-cutting docs (conventions.md / glossary.md)'
  );
});

test('discovery: SKILL.md names the full area taxonomy — Scope, Conventions, Anti-patterns, Testing', () => {
  const text = readFileSync(skillPath, 'utf8');
  assert.match(text, /\bScope\b/, 'must name Scope as a taxonomy area');
  assert.match(text, /\bConventions\b/, 'must name Conventions as a taxonomy area');
  assert.match(text, /\bAnti-patterns\b/, 'must name Anti-patterns as a taxonomy area');
  assert.match(text, /\bTesting\b/, 'must name Testing as a taxonomy area');
});

test('discovery: SKILL.md describes the seeded interview — accept / correct / skip', () => {
  const text = readFileSync(skillPath, 'utf8');
  assert.match(text, /accept/i, 'seeded interview must describe accepting an item');
  assert.match(text, /correct/i, 'seeded interview must describe correcting an item');
  assert.match(text, /skip/i, 'seeded interview must describe skipping an item');
});

test('discovery: SKILL.md has an emergent-area re-ask before drafting', () => {
  const text = readFileSync(skillPath, 'utf8');
  assert.match(text, /emergent|new area(s)?/i, 'must name the emergent/new-area case');
  assert.match(text, /ask/i, 'must ask the user before folding an emergent area in');
});

test('discovery: SKILL.md carries additive + diff-gated write-back language', () => {
  const text = readFileSync(skillPath, 'utf8');
  const additiveDiffGated = /diff-gated/i.test(text)
    || (/additive/i.test(text) && /(never overwrite|never clobber)/i.test(text));
  assert.ok(additiveDiffGated, 'must state the write-back is diff-gated, or additive + never overwrite/clobber');
});

test('discovery: SKILL.md dispatches explore-surface-prompt.md and sets model: explicitly near the dispatch', () => {
  const text = readFileSync(skillPath, 'utf8');
  const idx = text.indexOf('explore-surface-prompt.md');
  assert.ok(idx !== -1, 'must dispatch skills/discovery/explore-surface-prompt.md');
  const window = text.slice(idx, idx + 700);
  assert.match(window, /model:\s*(cheap|standard|most-capable)\b/, 'must set an explicit model tier near the dispatch');
});

test('discovery: SKILL.md states the discovered-doc linking rule', () => {
  const text = readFileSync(skillPath, 'utf8');
  assert.match(text, /relative/i, 'linking rule must require a relative path');
  assert.match(text, /(exist|resolve)/i, 'linking rule must require the target to exist/resolve');
  assert.match(text, /never link into `?\.apex\/work/i, 'linking rule must forbid linking into .apex/work');
});

test('discovery: SKILL.md runs validate-hub.mjs with an explicit "." argument', () => {
  const text = readFileSync(skillPath, 'utf8');
  assert.match(text, /validate-hub\.mjs"?[ \t]+\./, 'must invoke validate-hub.mjs with an explicit \'.\' argument');
});

test('discovery: SKILL.md namespaces every shipped workflow slash invocation', () => {
  const text = readFileSync(skillPath, 'utf8');
  assertNoBareWorkflowInvocations(text, 'skills/discovery/SKILL.md');
});

test('discovery: SKILL.md states it dispatches no reviewer subagent', () => {
  const text = readFileSync(skillPath, 'utf8');
  assert.match(text, /no reviewer subagent|no subagent reviewer/i, 'must state no reviewer subagent is dispatched');
});

test('discovery: SKILL.md is standalone — no chain Step 0 gear-read heading, no verdict-artifact phrase', () => {
  const text = readFileSync(skillPath, 'utf8');
  assert.doesNotMatch(text, /### Step 0 — Read the gear/, 'must not copy the chain skills\' gear-read Step 0');
  assert.doesNotMatch(text, /verdict artifact/i, 'must not reference a verdict artifact (chain-only concept)');
});

test('discovery: init SKILL.md Step 8 points the user at the abstract discovery skill to populate empty docs', () => {
  const text = readFileSync(initSkillPath, 'utf8');
  const step8 = sectionBetween(text, '### Step 8', undefined);
  assert.match(step8, /the `discovery` skill/, 'Step 8 must point the user at the discovery skill by abstract name');
  assert.doesNotMatch(step8, /\/steepy-apex:/, 'Step 8 must not use a Claude-only namespaced slash invocation');
  assert.match(step8, /populate/i, 'Step 8 pointer must frame discovery as populating docs');
  assert.match(step8, /empty|scaffold/i, 'Step 8 pointer must name the docs as scaffolded/empty');
});

test('discovery: README.md Commands table registers the namespaced discovery command', () => {
  const text = readFileSync(readmePath, 'utf8');
  assert.match(text, /\/steepy-apex:discovery\b/, 'README must mention /steepy-apex:discovery');
});

test('discovery: skills standard Scope registers discovery', () => {
  const text = readFileSync(skillsStandardPath, 'utf8');
  assert.match(text, /\bdiscovery\b/, '.apex/standards/skills.md must mention discovery');
});

test('discovery: SKILL.md Step 2.2 passes [REPORT_FILE] and the interviewer reads the report from file', () => {
  const text = readFileSync(skillPath, 'utf8');
  assert.match(text, /\[REPORT_FILE\]/, 'must name the [REPORT_FILE] dispatch parameter');
  assert.match(
    text,
    /read(?:s)?[\s\S]{0,80}report[\s\S]{0,40}file|report file[\s\S]{0,80}read(?:s)?/i,
    'must instruct reading the report from the report file before the interview'
  );
});

test('discovery: SKILL.md Step 2.4 imposes a write-back preview with an explicit destination before acceptance', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  assert.match(step2, /preview/i, 'must name the write-back preview');
  assert.match(
    step2,
    /destination|→\s*section|section\s*(of|→)/i,
    'must require an explicit destination doc/section in the preview'
  );
});

test('discovery: SKILL.md Step 2.4 forbids bare-ID options and requires printing the full card before acceptance prompts', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  assert.match(step2, /bare ID|T1,\s*T2/i, 'must forbid bare-ID (T1, T2, …) options in the acceptance prompt');
});

test('discovery: SKILL.md Step 2.4 asks in harness-neutral prose — one question, numbered options, recommendation (D3)', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  // Flatten hard-wrapped prose so the lock pins the verbatim wording, not the wrap points.
  const flat = step2.replace(/\s+/g, ' ');
  assert.doesNotMatch(step2, /AskUserQuestion/, 'must not name the Claude-only AskUserQuestion tool');
  assert.match(
    flat,
    /ask one question at a time, with numbered options and a recommendation; use your harness's question UI if it has one/i,
    'must carry the ratified plain-prose questioning instruction (D3)'
  );
});

test('discovery: SKILL.md Step 2.2 dispatch is harness-conditional with an inline fallback (D1)', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  const flat = step2.replace(/\s+/g, ' ');
  assert.match(
    flat,
    /If your harness provides a task\/subagent tool[\s\S]{0,200}explore-surface-prompt\.md/i,
    'Step 2.2 must gate the subagent dispatch on the harness having a task/subagent tool'
  );
  assert.match(
    flat,
    /otherwise[\s\S]{0,140}inline[\s\S]{0,200}report/i,
    'Step 2.2 must fall back to an inline exploration pass and state the degradation in the run report'
  );
});

test('discovery: explore-surface-prompt.md names the split proposal and both trigger conditions', () => {
  const text = readFileSync(promptPath, 'utf8');
  assert.match(text, /split proposal/i, 'must name the split proposal item card');
  assert.match(text, /150\s*lines?/, 'must name the 150-line threshold as a trigger condition');
  assert.match(text, /heterogeneous/i, 'must name heterogeneous rule clusters as the other trigger condition');
});

test('discovery: SKILL.md Step 2.4 requires the complete-structure preview for a split proposal', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step24 = sectionBetween(text, '4. **Seeded interview.**', '5. **Write-back.**');
  assert.match(step24, /split proposal/i, 'must name the split proposal case');
  assert.match(step24, /core/i, 'must require the core doc in the preview');
  assert.match(step24, /routing row/i, 'must require the updated routing row in the preview');
});

test('discovery: SKILL.md Step 2.5 lists the split write-back moves', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step25 = sectionBetween(text, '5. **Write-back.**', '### Step 3');
  assert.match(step25, /removes `?standards\/<surface>\.md`?/i, 'must state removal of the single old standard file');
  assert.match(step25, /routing row/i, 'must state the routing-row update in _INDEX.md');
});

test('discovery: SKILL.md Step 0 recognizes the modular folder form from the routing-table link', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step0 = sectionBetween(text, '### Step 0', '### Step 1');
  assert.match(step0, /subfolder/i, 'must recognize a modular surface from a link inside a standards/ subfolder');
  assert.match(step0, /core/i, 'must name the link target as the surface core');
  assert.match(step0, /mini-routing/i, 'must name the mini-routing table as the leaf list');
});

test('discovery: SKILL.md routes modular-surface items via the core mini-routing table', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  assert.match(step2, /mini-routing/i, 'must route modular write-backs by the mini-routing table');
  assert.match(step2, /leaf/i, 'must name the leaf as a write-back destination');
  assert.match(step2, /no\s+leaf\s+covers/i, 'must send a rule no leaf covers to the core');
});

test('discovery: explore-surface-prompt.md restricts the split proposal to the single-file form', () => {
  const text = readFileSync(promptPath, 'utf8');
  assert.match(text, /single-file form/i, 'split proposal must be restricted to the single-file form');
  assert.match(
    text,
    /never gets a split proposal|already split/i,
    'must state a folder-form surface gets no split proposal'
  );
});

test('discovery: reads only stable knowledge and ordinary source, never the local inception or work areas', () => {
  const skill = readFileSync(skillPath, 'utf8');
  const step0 = sectionBetween(skill, '### Step 0', '### Step 1').replace(/\s+/g, ' ');
  assert.match(step0, /Read only stable hub documents and ordinary repository source/i);
  assert.match(step0, /`\.apex\/inception\/\*\*` and `\.apex\/work\/\*\*` are local areas, not knowledge: never enumerate, search, or read them/i);
  assert.match(step0, /only exception is this run's own report file under `\.apex\/work\/discovery\/`, which you write and read back/i);
  const prompt = readFileSync(promptPath, 'utf8').replace(/\s+/g, ' ');
  assert.match(prompt, /Never enumerate, search, or read `\.apex\/inception\/\*\*` or `\.apex\/work\/\*\*`: they are local areas, not stable knowledge/i);
  assert.match(prompt, /\[REPORT_FILE\] is the only path there you touch, and you only write it/i);
});

test('discovery: a hub populated by an inception transfer needs no second approval, and write-back stays additive and confirmed', () => {
  const skill = readFileSync(skillPath, 'utf8');
  const step24 = sectionBetween(skill, '4. **Seeded interview.**', '5. **Write-back.**').replace(/\s+/g, ' ');
  assert.match(step24, /hub that `init` populated from an inception transfer already holds approved decisions/i);
  assert.match(step24, /never ask the user to approve again what is already written/i);
  assert.match(step24, /surface only \*\*new\*\* or \*\*drifted\*\* items/i);
  const step25 = sectionBetween(skill, '5. **Write-back.**', '### Step 3').replace(/\s+/g, ' ');
  assert.match(step25, /additive and diff-gated/i);
  assert.match(step25, /gated per item by the user/i);
});

function sectionBetween(text, startHeading, endHeading) {
  const s = text.indexOf(startHeading);
  assert.ok(s !== -1, `missing heading '${startHeading}'`);
  const e = endHeading ? text.indexOf(endHeading, s + startHeading.length) : -1;
  return e === -1 ? text.slice(s) : text.slice(s, e);
}

function assertNamedHeadingReference({ sourcePath, targetPath, targetLabel, heading }) {
  const source = readFileSync(sourcePath, 'utf8');
  const target = readFileSync(targetPath, 'utf8');
  assert.ok(source.includes(targetLabel), `${sourcePath} must name ${targetLabel}`);
  assert.ok(source.includes(`"${heading}"`), `${sourcePath} must reference heading "${heading}"`);
  const headingLine = target.split('\n').some((line) => {
    const match = line.match(/^\s*#{1,6}\s+(.+?)\s*$/);
    return match?.[1] === heading;
  });
  assert.ok(headingLine, `${targetPath} must contain heading "${heading}"`);
}

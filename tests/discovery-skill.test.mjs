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

test('discovery: init SKILL.md Step 5 points the user at the abstract discovery skill to populate empty docs', () => {
  const text = readFileSync(initSkillPath, 'utf8');
  const step5 = sectionBetween(text, '### Step 5', undefined);
  assert.match(step5, /the `discovery` skill/, 'Step 5 must point the user at the discovery skill by abstract name');
  assert.doesNotMatch(step5, /\/steepy-apex:/, 'Step 5 must not use a Claude-only namespaced slash invocation');
  assert.match(step5, /populate/i, 'Step 5 pointer must frame discovery as populating docs');
  assert.match(step5, /empty|scaffold/i, 'Step 5 pointer must name the docs as scaffolded/empty');
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

// Inception source (inception v1): SC11 and SC12. Appended blocks; the blocks above stay unchanged.
const inceptionPromptPath = join(skillsDir, 'discovery', 'explore-inception-prompt.md');
const STEP_2A = '### Step 2a — Inception source (complete run only)';

// Flatten hard-wrapped prose so a lock pins the wording, not the wrap points.
function flat(text) {
  return text.replace(/\s+/g, ' ');
}

test('discovery inception source (SC11): Step 1 offers the source only for a complete run and reads only the descriptor', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step1 = flat(sectionBetween(text, '### Step 1', '### Step 2'));
  assert.match(
    step1,
    /If `\.apex\/inception\/run\.json` exists and its `status` is `complete`, also offer the \*\*inception source\*\*/,
    'Step 1 must offer the inception source only for a complete run',
  );
  assert.match(
    step1,
    /Read only that one file to check this, and never list `\.apex\/inception\/`\./,
    'Step 1 must read only the descriptor and never list the area',
  );
  assert.match(
    step1,
    /Otherwise do not mention the inception source, and run exactly as below\./,
    'Step 1 must stay silent about the source when no complete run exists',
  );
  assert.doesNotMatch(step1, /explore-surface-prompt\.md/, 'Step 1 must not mention the surface explorer prompt');
});

test('discovery inception source (SC11): Step 2a sits between Step 2 and Step 3 and runs only on the user\'s choice', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step2 = text.indexOf('### Step 2 — Per-surface iterative loop');
  const step2a = text.indexOf(STEP_2A);
  const step3 = text.indexOf('### Step 3 — Coherence gate');
  assert.ok(step2 !== -1 && step2a > step2 && step3 > step2a, 'Step 2a must sit between Step 2 and Step 3');
  const section = flat(sectionBetween(text, STEP_2A, '### Step 3'));
  assert.match(section, /Run this step only when the user chose the inception source in Step 1\./);
  assert.match(section, /never list `\.apex\/inception\/`/, 'Step 2a must never list the area');
  assert.match(section, /A stop in this step ends only the inception source/);
});

test('discovery inception source (SC11): Step 2a reads only the descriptor and its bound paths, then runs verify-approval', () => {
  const text = readFileSync(skillPath, 'utf8');
  const section = flat(sectionBetween(text, STEP_2A, '### Step 3'));
  assert.match(section, /Read the descriptor, `\.apex\/inception\/run\.json`, then only the paths it binds/);
  assert.match(
    section,
    /the last element of the descriptor's `approvals` array, by binding order, never by file recency/,
    'the approval record is chosen by binding order, never by file recency',
  );
  assert.match(section, /that record's `documents\[\]\.path`, and the descriptor's `verification\.path`/);
  assert.match(section, /node <engine-root>\/scripts\/inception-state\.mjs verify-approval --repo-root \./);
  assert.match(
    section,
    /On any divergence[^.]*stop the inception source[^.]*: drifted documents are not promoted\./,
    'a divergence stops the inception source and nothing drifted is promoted',
  );
  assert.match(section, /`\.apex\/inception\/project\/decision-register\.md` is not among the approved documents/);
});

test('discovery inception source (SC11): Step 2a passes exactly the bound paths as [INPUT_PATHS] with an explicit model:', () => {
  const text = readFileSync(skillPath, 'utf8');
  const raw = sectionBetween(text, STEP_2A, '### Step 3');
  const section = flat(raw);
  assert.match(section, /`\[REPORT_FILE\] = \.apex\/work\/discovery\/YYYY-MM-DD-inception\.md`/);
  assert.match(
    section,
    /If your harness provides a task\/subagent tool, dispatch a fresh subagent using `skills\/discovery\/explore-inception-prompt\.md`/,
  );
  const idx = raw.indexOf('explore-inception-prompt.md');
  assert.ok(idx !== -1, 'Step 2a must dispatch skills/discovery/explore-inception-prompt.md');
  assert.match(raw.slice(idx, idx + 300), /model: standard/, 'must set model: standard explicitly near the dispatch');
  assert.match(
    section,
    /Pass `\[INPUT_PATHS\]` = exactly the descriptor, the approval record, every approved document, and the verification results — no other path\./,
  );
  assert.match(section, /`\[GLOSSARY_PATH\]`[^]*`\[CONVENTIONS_PATH\]`[^]*`\[STANDARD_PATHS\]`/);
  assert.match(
    section,
    /Otherwise run the same prompt inline over the same inputs, and state the inline degradation in the run's report/,
  );
  assert.match(section, /`skills\/discovery\/explore-inception-prompt\.md` → "Output Format"/);
});

test('discovery inception source (SC11): the surface flow text is otherwise unchanged', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step0 = sectionBetween(text, '### Step 0', '### Step 1');
  assert.match(
    flat(step0),
    /If `\.apex\/_INDEX\.md` is \*\*absent\*\*, tell the user the hub does not exist yet: run the `init` skill \(invoke it the way your harness invokes skills\) first, then \*\*stop\*\* — `discovery` populates an existing hub, it does not create one\./,
    'Step 0 must keep its absent-hub stop',
  );
  assert.doesNotMatch(step0, /inception/i, 'Step 0 must not change for the inception source');
  const surfaceLoop = sectionBetween(text, '### Step 2 — Per-surface iterative loop', '### Step 2a');
  assert.doesNotMatch(surfaceLoop, /inception/i, 'the per-surface loop must not change for the inception source');
  assert.match(
    flat(surfaceLoop),
    /If your harness provides a task\/subagent tool, dispatch a fresh subagent per surface using `skills\/discovery\/explore-surface-prompt\.md`; otherwise perform the exploration inline in a dedicated pass over the same inputs, and state the inline degradation in the run's report \(Step 4\)\. When you dispatch, always set `model: standard` explicitly/,
    'Step 2 must keep its explorer dispatch',
  );
  const firstSurfacePrompt = text.indexOf('explore-surface-prompt.md');
  assert.ok(
    firstSurfacePrompt > text.indexOf('### Step 2 — Per-surface iterative loop') && firstSurfacePrompt < text.indexOf(STEP_2A),
    'the first mention of explore-surface-prompt.md must stay in Step 2.2',
  );
});

test('discovery inception source (SC12): Step 2a walks the decision register, one card per DR-n, under the Step 2.4 interview', () => {
  const text = readFileSync(skillPath, 'utf8');
  const section = flat(sectionBetween(text, STEP_2A, '### Step 3'));
  assert.match(section, /one item card per `DR-n`/);
  assert.match(section, /Proposed doc text/);
  assert.match(section, /Evidence \(the local file and line; it is for the interview only\)/);
  assert.match(section, /Verification status \(from the verification results' `## Coverage` rows\)/);
  assert.match(section, /Promotion class/);
  assert.match(section, /write-back preview: the destination and the exact text that would be written/);
  assert.match(section, /accept \/ correct \/ skip interview as Step 2\.4/);
  assert.match(section, /Never use bare IDs \(DR-1, DR-2, …\) as option labels/, 'the bare-ID ban must cover DR-n');
  assert.match(section, /A skip is a rejection: ask the user for its reason\./);
});

test('discovery inception source (SC12): Step 2a states the three promotion rules', () => {
  const text = readFileSync(skillPath, 'utf8');
  const section = flat(sectionBetween(text, STEP_2A, '### Step 3'));
  assert.match(section, /Approved and verified \(`verified`\) → may be written as an existing component or rule\./);
  assert.match(
    section,
    /Approved but unverified \(`unverified`\) → written as a design choice, not as an existing component\./,
  );
  assert.match(
    section,
    /A future flow \(`future`\) → written as context in `conventions\.md`, never as an implemented component, a spec, or a started task\./,
  );
});

test('discovery inception source (SC12): write-back goes only to conventions.md, routed standards, and glossary.md and never names the area', () => {
  const text = readFileSync(skillPath, 'utf8');
  const section = flat(sectionBetween(text, STEP_2A, '### Step 3'));
  assert.match(
    section,
    /Destinations are only `conventions\.md`, the routed surface standards, and `glossary\.md`: no new hub document and no `_INDEX\.md` change\./,
  );
  assert.match(section, /Write-back text never names, cites, or links `\.apex\/inception\/`/);
});

test('discovery inception source (SC12): every decision ends accepted or rejected with a reason under ## Decision outcomes', () => {
  const text = readFileSync(skillPath, 'utf8');
  const section = flat(sectionBetween(text, STEP_2A, '### Step 3'));
  assert.match(section, /Every register decision ends accepted \(written\) or rejected with a reason\./);
  assert.match(
    section,
    /Record the outcomes in `\[REPORT_FILE\]` under `## Decision outcomes`, one line per decision: `DR-n — accepted` or `DR-n — rejected: <reason>`\./,
  );
  assert.match(section, /Re-runs follow the new-or-drifted rule of Step 2\.4/);
  const step4 = flat(sectionBetween(text, '### Step 4', '## Model Selection'));
  assert.match(step4, /inception source[^]*`## Decision outcomes`/, 'Step 4 must report the inception decision outcomes');
});

test('discovery inception source (SC12): Model Selection covers the inception explorer', () => {
  const text = readFileSync(skillPath, 'utf8');
  const model = flat(sectionBetween(text, '## Model Selection'));
  assert.match(
    model,
    /Always set `model:` explicitly when dispatching the Explore subagent in Step 2\.2 and the inception explorer in Step 2a\.2/,
  );
  assert.match(model, /Never hardcode a concrete model id in `explore-surface-prompt\.md` or `explore-inception-prompt\.md`\./);
  assert.match(model, /no reviewer subagent/i);
});

test('discovery inception source (SC12): explore-inception-prompt.md is an explorer at the standard tier with its placeholders', () => {
  assert.ok(existsSync(inceptionPromptPath), 'skills/discovery/explore-inception-prompt.md should exist');
  const text = readFileSync(inceptionPromptPath, 'utf8');
  assert.match(text, /```\nSubagent \(explorer\):\n {2}model: standard\b/, 'must be a fenced explorer with model: standard');
  for (const placeholder of ['[INPUT_PATHS]', '[REPORT_FILE]', '[GLOSSARY_PATH]', '[CONVENTIONS_PATH]', '[STANDARD_PATHS]']) {
    assert.ok(text.includes(placeholder), `must name the ${placeholder} placeholder`);
  }
  assert.doesNotMatch(text, /\b(haiku|sonnet|opus)\b/, 'must not hardcode a concrete model id');
  assert.doesNotMatch(text, /general-purpose|\/steepy-apex:|CLAUDE_/);
  assert.doesNotMatch(text, /[^\s`]+\.md:\d+/, 'must not carry numeric Markdown anchors');
  const body = flat(text);
  assert.match(body, /If your harness provides a task\/subagent tool, dispatch a fresh explorer subagent/);
  assert.match(
    body,
    /Otherwise perform the exploration yourself in a dedicated pass over the same inputs, and state the inline degradation in the run's report\./,
  );
});

test('discovery inception source (SC12): explore-inception-prompt.md reads exactly its inputs and never lists the area or writes hub or code', () => {
  assert.ok(existsSync(inceptionPromptPath), 'skills/discovery/explore-inception-prompt.md should exist');
  const body = flat(readFileSync(inceptionPromptPath, 'utf8'));
  assert.match(body, /Read exactly the files in \[INPUT_PATHS\], \[GLOSSARY_PATH\], \[CONVENTIONS_PATH\], and \[STANDARD_PATHS\]\./);
  assert.match(
    body,
    /Never list `\.apex\/inception\/` or read anything else under it, never read under `\.apex\/work\/`, and never write to the hub or the codebase\./,
  );
});

test('discovery inception source (SC12): explore-inception-prompt.md writes one card per DR-n with file:line evidence and invents nothing', () => {
  assert.ok(existsSync(inceptionPromptPath), 'skills/discovery/explore-inception-prompt.md should exist');
  const text = readFileSync(inceptionPromptPath, 'utf8');
  const body = flat(text);
  assert.match(body, /One item card per `DR-n` row of the decision register, in register order/);
  for (const field of ['Proposed doc text', 'Evidence', 'Verification status', 'Promotion class', 'Destination']) {
    assert.match(text, new RegExp(`\\*\\*${field}:\\*\\*`), `each card must carry the ${field} field`);
  }
  assert.match(text, /`file:line`/, 'must require file:line evidence');
  assert.match(text, /## Invent Nothing/);
  assert.match(body, /`verified` → `existing component or rule`/);
  assert.match(body, /`unverified` → `design choice`/);
  assert.match(body, /`future` → `future context`/);
  assert.match(body, /The Proposed doc text never names, cites, or links `\.apex\/inception\/`/);
  assert.match(body, /the interviewer records `## Decision outcomes`/);
});

test('discovery inception source (SC12): explore-inception-prompt.md returns only the four-field status', () => {
  assert.ok(existsSync(inceptionPromptPath), 'skills/discovery/explore-inception-prompt.md should exist');
  const text = readFileSync(inceptionPromptPath, 'utf8');
  assert.match(text, /status: <DONE\|BLOCKED>\n\s+artifact: \[REPORT_FILE\]\n\s+changed-paths: none\n\s+signals: <short IDs or none>/);
  assert.match(text, /≤\s*15/, 'must impose a terse ≤15-line return');
  assertNamedHeadingReference({
    sourcePath: skillPath,
    targetPath: inceptionPromptPath,
    targetLabel: 'skills/discovery/explore-inception-prompt.md',
    heading: 'Output Format',
  });
});

test('discovery inception source (SC12): explore-surface-prompt.md gains the inception read boundary in its read paragraph', () => {
  const text = readFileSync(promptPath, 'utf8');
  assert.match(
    text,
    /beyond what is needed to confirm a finding\.\n {4}Never read under `\.apex\/work\/` or `\.apex\/inception\/`: inception material reaches discovery only\s+through its inception source\./,
  );
});

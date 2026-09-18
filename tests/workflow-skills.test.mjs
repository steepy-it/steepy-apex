import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(here, '..', 'skills');
const root = join(here, '..');
const workflowCommands = [
  'init',
  'new-surface',
  'check',
  'brainstorm',
  'plan',
  'implement',
  'review',
  'loop-engineer',
];

function namespacedCommand(command) {
  return `/steepy-apex:${command}`;
}

function assertNoBareWorkflowInvocations(text, label) {
  const commandAlternation = workflowCommands.join('|');
  const bareInvocation = new RegExp(`(^|[^\\w:.-])/(${commandAlternation})\\b`, 'm');
  assert.doesNotMatch(text, bareInvocation, `${label} must namespace shipped workflow slash commands`);
}

function checkSkill(name, mustReference) {
  const path = join(skillsDir, name, 'SKILL.md');
  assert.ok(existsSync(path), `${name}/SKILL.md should exist`);
  const text = readFileSync(path, 'utf8');
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fmMatch, `${name} should have YAML frontmatter`);
  const fm = fmMatch[1];
  assert.match(fm, new RegExp(`name:\\s*${name}\\b`), `${name} frontmatter name must match dir`);
  assert.match(fm, /user-invocable:\s*true/, `${name} must be user-invocable`);
  for (const ref of mustReference) {
    assert.ok(text.includes(ref), `${name} must reference '${ref}' (hub integration)`);
  }
}

test('brainstorm: valid user-invocable skill, writes spec into .apex/work/specs/', () => {
  checkSkill('brainstorm', ['.apex/work/specs/', '.apex/_INDEX.md', 'validate-hub.mjs']);
});

test('brainstorm: local-work contract is explicit and forbids stable registration', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  assert.match(
    text,
    /description:\s+Turn an idea into a local working spec under \.apex\/work\/specs\/\./,
    'brainstorm description must describe the local working-spec contract'
  );
  assert.match(text, /5\. Finalize the approved draft/);
  assert.match(text, /6\. Validate the stable hub with `validate-hub\.mjs` \(deterministic gate\)\./);
  assert.match(text, /### Step 5 — Finalize the approved draft/);
  assert.match(text, /Create `\.apex\/work\/specs\/` if it does not exist\./);
  assert.match(text, /Do not register the spec in `\.apex\/_INDEX\.md` and do not create a specs sub-index\./);
  assert.match(text, /Specs are local workflow artifacts, not stable hub documentation\./);
  assert.match(text, /A spec under `\.apex\/work\/specs\/` is intentionally ignored by the linter and does not need registration\./);
  assert.doesNotMatch(text, /hub-governed spec/i);
});

test('brainstorm: Step 4 writes the draft into the spec file (gate), Step 5 finalizes it', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step4 = sectionBetween(text, '### Step 4 — Present the design (gate)', '### Step 5');
  assert.match(step4, /`Status: DRAFT`/, 'Step 4 must mark the draft file Status: DRAFT');
  assert.match(step4, /\.apex\/work\/specs\//, 'Step 4 must write the draft to .apex/work/specs/');
  assert.match(
    step4,
    /no finalization,? no handoff,? no hub mutation until the user approves/i,
    'Step 4 must state the gate is unchanged: no finalization, no handoff, no hub mutation until approval'
  );

  const step5 = sectionBetween(text, '### Step 5 — Finalize the approved draft', '### Step 5.5');
  assert.match(
    step5,
    /drop the (?:old )?.?Status: DRAFT.? (?:prose )?marker|drop the DRAFT marker/i,
    'Step 5 must drop the Status: DRAFT marker'
  );
});

test('brainstorm: Step 1.5 resolves CONFLICT — doc-wins, confirm, override→doc rewritten to the active rule', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step15 = sectionBetween(text, '### Step 1.5', '### Step 2 — Understand');
  assert.match(step15, /`file:line`/, 'CONFLICT resolution must cite file:line');
  assert.match(step15, /doc-wins/i, 'CONFLICT resolution must default to doc-wins');
  assert.match(step15, /confirm/i, 'CONFLICT resolution must require explicit user confirmation');
  assert.match(step15, /override/i, 'CONFLICT resolution must support an explicit override');
  assert.match(step15, /the doc changes/i, 'override must update the governing doc');
  assert.match(step15, /active form only/i, 'override must state the new rule in active form only');
  assert.match(step15, /never\s+carries the superseded rule/i, 'stable docs must never carry the superseded rule');
  assert.doesNotMatch(step15, /record the supersession/i, 'override must not prescribe a supersession ledger');
});

test('brainstorm: Step 1.5 resolves GAP — explore-first, consistency threshold, isolated precedent, no-precedent→brainstorm', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step15 = sectionBetween(text, '### Step 1.5', '### Step 2 — Understand');
  assert.match(step15, /explore the codebase first/i, 'GAP resolution must explore the codebase before brainstorming');
  assert.match(step15, /2–3|2-3/, 'GAP resolution must define a ≥2-3 occurrence consistency threshold');
  assert.match(step15, /do NOT brainstorm/, 'a consistent latent convention must skip the brainstorm');
  assert.match(step15, /write it back/i, 'a consistent latent convention must be written back to the hub');
  assert.match(step15, /isolated precedent/i, 'a single isolated precedent must be named');
  assert.match(step15, /do not canonise automatically/i, 'an isolated precedent must not be auto-canonised');
  assert.match(step15, /no precedent/i, 'the no-precedent branch must be named');
  assert.match(step15, /genuine design gap/i, 'no precedent must be framed as a genuine design gap');
});

test('brainstorm: write-back routing wired — recurring→hub (glossary/standards/conventions), one-off stays local', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const writeBack = sectionBetween(text, '### Write-back routing', '### Step 6');
  assert.match(writeBack, /will recur/i, 'write-back must be gated on the fork recurring');
  assert.match(writeBack, /\.apex\/glossary\.md/, 'a term/ambiguity must route to the glossary');
  assert.match(writeBack, /exact routed single standard, modular core, or matching leaf/i, 'a surface-scoped rule must follow the actual owning route');
  assert.match(writeBack, /\.apex\/conventions\.md/, 'a cross-cutting recurring fork must route to conventions.md');
  assert.match(writeBack, /one-off/i, 'a genuine one-off must be named');
  assert.match(writeBack, /stays local/i, 'a one-off must stay local, not bloat the hub');
  assert.match(writeBack, /\.apex\/work\//, 'a one-off stays local in the .apex/work/ spec');
  assert.match(writeBack, /inline/i, 'write-back must happen inline, not batched at the end');
});

test('brainstorm: write-back three-condition filter for decision-shaped conventions entries', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const writeBack = sectionBetween(text, '### Write-back routing', '### Step 6');
  assert.match(writeBack, /hard to reverse/i, 'decision write-backs must require hard-to-reverse');
  assert.match(writeBack, /surprising without context/i, 'decision write-backs must require surprising-without-context');
  assert.match(writeBack, /real trade-off/i, 'decision write-backs must require a real trade-off');
  assert.match(writeBack, /any one missing.*stays local|stays local in the spec/i, 'a decision failing any condition must stay local in the spec');
  assert.match(writeBack, /recurrence test only|keep the recurrence test/i, 'glossary write-backs must keep the recurrence test only');
});

test('brainstorm: Step 2 is hub-aware grilling (gear 2-3), mutates no doc', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(text, '### Step 2 — Understand', '### Step 3');
  assert.match(step2, /Gear 2 and 3/, 'Step 2 grilling must be gated to gear 2 and 3');
  assert.match(step2, /glossar/i, 'Step 2 must name glossary/terminology sharpening');
  assert.match(step2, /scenario/i, 'Step 2 must probe concrete edge-case scenarios');
  assert.match(step2, /drift/i, 'Step 2 must cross-reference code for Drift');
  assert.match(step2, /one at a time|one question/i, 'Step 2 must keep one-question-at-a-time discipline');
  assert.match(step2, /does not mutate|write nothing to the hub/i, 'Step 2 must state it mutates no hub doc');
  assert.match(step2, /Step 1\.5/, 'Step 2 must route already-durable deltas to the existing Step 1.5 channel');
  assert.match(step2, /captured in the spec/i, 'Step 2 must state speculative deltas are captured in the spec');
});

test('brainstorm: Step 4/5 carry canonical Out of Scope + Testing Decisions sections', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step4 = sectionBetween(text, '### Step 4 — Present the design (gate)', '### Step 5');
  assert.match(step4, /Out of Scope/, 'Step 4 section list must name Out of Scope');
  assert.match(step4, /Testing Decisions/, 'Step 4 section list must name Testing Decisions');
  assert.match(step4, /required at gear 3.*recommended at gear 2|required.*gear 3.*recommended.*gear 2/i, 'both sections must be required at gear 3, recommended at gear 2');
  assert.match(step4, /prior art/i, 'Testing Decisions must include prior art in the repo');
  assert.match(step4, /nothing excluded|never omitted/i, 'an empty Out of Scope must be a real statement at gear 3, never omitted');
  const step5 = sectionBetween(text, '### Step 5 — Finalize the approved draft', '### Step 5.5');
  assert.match(step5, /Out of Scope[\s\S]*Testing Decisions|Testing Decisions[\s\S]*Out of Scope/, 'Step 5 finalize checklist must cover both canonical sections');
});

test('brainstorm: Step 2 grilling has structure — design tree, facts/decisions split, explicit exit criterion', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(text, '### Step 2 — Understand', '### Step 3');
  assert.match(step2, /design tree|tree of.*decisions/i, 'Step 2 must frame open decisions as a design tree');
  assert.match(step2, /dependency order|prerequisites/i, 'Step 2 must order questions by dependency — no decision before its prerequisites');
  assert.match(step2, /facts/i, 'Step 2 must split facts from decisions');
  assert.match(step2, /never ask the user for something look-up-able|explore the codebase instead of asking/i, 'facts must be explored, not asked');
  assert.match(step2, /every branch.*visited|visited.*every branch/i, 'exit criterion must require every branch of the tree visited');
  assert.match(step2, /silently assumed/i, 'exit criterion must forbid silent assumptions');
  assert.match(step2, /shared understanding/i, 'exit criterion must require user-confirmed shared understanding');
  assert.doesNotMatch(step2, /until the idea is clear/i, 'the vague exit criterion must be replaced');
});

test('plan: valid user-invocable skill, writes plan into .apex/work/plans/', () => {
  checkSkill('plan', ['.apex/work/plans/', '.apex/work/specs/', 'testing-and-checklist.md', '-agent', 'validate-hub.mjs']);
});

test('plan: local-work contract is explicit and forbids stable registration', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  assert.match(
    text,
    /description:\s+Turn a local working spec into a step-by-step implementation plan\./,
    'plan description must describe the local working-plan contract'
  );
  assert.doesNotMatch(text, /default: the most recent dated spec file/i);
  assert.match(text, /If no\s+candidate exists, tell the user to run the `brainstorm` skill/);
  assert.match(text, /### Step 4 — Write the local working plan/);
  assert.match(text, /> Source spec: \[<topic>\]\(\.\.\/specs\/<YYYY-MM-DD-topic>\.md\)/);
  assert.match(text, /Create `\.apex\/work\/plans\/` if it does not exist\./);
  assert.match(text, /Do not register the plan in `\.apex\/_INDEX\.md` and do not create a plans sub-index\./);
  assert.match(text, /Plans are local workflow artifacts, not stable hub documentation\./);
  assert.match(text, /A plan under `\.apex\/work\/plans\/` is intentionally ignored by the linter and does not need registration or a stable back-link\./);
});

test('chain skills: byte-identical canonical manual handoff contract', () => {
  const names = ['brainstorm', 'plan', 'implement', 'review', 'loop-engineer'];
  const blocks = names.map((name) => {
    const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    return text.match(/<!-- steepy:manual-handoff:v1:start -->[\s\S]*?<!-- steepy:manual-handoff:v1:end -->/)?.[0];
  });
  assert.ok(blocks.every(Boolean), 'all five chain skills must carry the common manual-handoff block');
  assert.ok(blocks.every((block) => block === blocks[0]), 'the common manual-handoff block must be byte-identical');
  const block = blocks[0];
  for (const phrase of [
    'handoff: steepy-apex/v1', 'next:', 'required:', 'onDemand:', 'explicit `none`',
    'brainstorm has `required: none`, `onDemand: none`', 'plan has required `spec`',
    'Gear-2 direct implement has required `spec`',
    'fresh `loop-engineer` has',
    'duplicate keys', 'unknown keys', 'unknown roles', 'absolute paths', '`..`', 'globs',
    'never preloaded', 'Stable routing inputs stay outside',
    'active harness',
  ]) assert.ok(block.includes(phrase), `manual block must contain ${phrase}`);
  assert.match(block, /fails closed\s+without discovery/);
  assert.match(block, /Gear-3 implement → review\s+maps `criteria`, `task-results`, `branch-diff`/);
  assert.match(block, /No child inherits general\s+`\.apex\/work\/\*\*` access/);
});

test('chain skills: canonical workflow-header phase identity includes the Gear-4 goal contract', () => {
  const names = ['brainstorm', 'plan', 'implement', 'review', 'loop-engineer'];
  const canonicalDomain = '<brainstorm|plan|implement|review|loop-engineer|goal-contract>';
  for (const name of names) {
    const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    const block = text.match(/<!-- steepy:manual-handoff:v1:start -->[\s\S]*?<!-- steepy:manual-handoff:v1:end -->/)?.[0];
    assert.ok(block, `${name} must carry the canonical manual-handoff block`);
    assert.ok(block.includes(`phase: ${canonicalDomain}`), `${name} must accept the canonical goal-contract phase identity`);
  }

  const loop = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  const review = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const loopEntry = sectionBetween(loop, '### Step 0', '### Step 1');
  const reviewProvenance = sectionBetween(review, '### Step 1', '### Step 2');
  assert.match(loopEntry, /phase: goal-contract/, 'loop entry must consume the canonical goal-contract phase');
  assert.match(reviewProvenance, /phase: goal-contract/, 'Gear-4 review provenance must use the same goal-contract phase');
  const standard = readFileSync(join(root, '.apex', 'standards', 'skills.md'), 'utf8');
  assert.ok(standard.includes(`phase: ${canonicalDomain}`), 'the stable skill standard must record the canonical phase domain');
});

test('chain skills: every declared transition emits exactly the destination accepted roles', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const block = text.match(/<!-- steepy:manual-handoff:v1:start -->([\s\S]*?)<!-- steepy:manual-handoff:v1:end -->/)?.[1];
  assert.ok(block, 'canonical manual-handoff block must exist');
  const acceptedAlternatives = new Map([
    ['plan', [['spec']]],
    ['implement', [['spec'], ['plan', 'source-spec']]],
    ['review', [
      ['branch-diff', 'criteria', 'task-results'],
      ['goal', 'loop-ledger'],
    ]],
  ]);
  const transitions = [
    ['Gear-2 brainstorm → implement', 'implement', ['spec']],
    ['brainstorm → plan', 'plan', ['spec']],
    ['plan → implement', 'implement', ['plan', 'source-spec']],
    ['Gear-3 implement → review', 'review', ['branch-diff', 'criteria', 'task-results']],
    ['loop-engineer → review', 'review', ['goal', 'loop-ledger']],
  ];
  for (const [transition, destination, emitted] of transitions) {
    const declaration = block.match(new RegExp(`${transition}\\s+maps ([^.;]+)`));
    assert.ok(declaration, `${transition} must be declared`);
    const declaredRoles = [...declaration[1].matchAll(/`([^`]+)`/g)].map((role) => role[1]).sort();
    assert.deepEqual(declaredRoles, emitted, `${transition} must emit its exact declared role set`);
    assert.ok(
      acceptedAlternatives.get(destination).some((roles) => JSON.stringify(roles) === JSON.stringify(emitted)),
      `${transition} must equal one mutually exclusive destination role alternative`
    );
  }
  assert.match(block, /regular Gear-3 `review` has required `criteria`, `task-results`, and `branch-diff`, `onDemand: none`/);
  assert.match(block, /Gear-4 `review` has required `goal` and `loop-ledger`, `onDemand: none`/);
  assert.match(block, /fresh `loop-engineer` has required `goal`, `onDemand: none`[\s\S]*resume[\s\S]*`loop-ledger` on demand/);
  assert.match(block, /mutually exclusive[\s\S]*never (?:merge|merged) or infer/i);
});

test('brainstorm and plan: versioned workflow headers and manual lifecycle are explicit', () => {
  const brainstorm = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const plan = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  assert.match(brainstorm, /phase: brainstorm[\s\S]*next: implement[^]*Gear 2[^]*next: plan[^]*Gear 3/i);
  assert.match(brainstorm, /Gear 2[^]*next: implement[^]*required:\n  spec: <exact-spec-path>[^]*onDemand: none/i);
  assert.match(brainstorm, /Gear 3[^]*next: plan[^]*required:\n  spec: <exact-spec-path>[^]*onDemand: none/i);
  assert.match(plan, /two exclusive manual entry paths/i);
  assert.match(plan, /only when no envelope or path was supplied/i);
  assert.match(plan, /immediate specs\s+directory[\s\S]*bounded `steepy-workflow` headers/i);
  assert.match(plan, /require user selection even when there is exactly one candidate/i);
  assert.match(plan, /phase: plan[\s\S]*status: DRAFT[\s\S]*next: implement[\s\S]*source: <exact-spec-path>[\s\S]*consumed-by: none/);
  assert.match(plan, /first[^]*plan to `status: READY`[^]*then[^]*spec to `status: CONSUMED`[^]*consumed-by: <plan-path>/i);
  assert.match(plan, /required:\n  plan: <plan-path>[\s\S]*onDemand:\n  source-spec: <spec-path>/);
});

test('implement: manual entry accepts the lean Gear-2 spec or exact plan provenance, with explicit resume capability', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const checklist = sectionBetween(text, '## Checklist', '## Procedure');
  const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
  const step1 = sectionBetween(text, '### Step 1', '### Step 2');

  assert.match(checklist, /Gear-2[^\n]*exact[^\n]*spec/i,
    'the checklist must name the direct Gear-2 spec capability');
  assert.match(checklist, /plan-backed[^\n]*plan[^\n]*source-spec/i,
    'the checklist must retain both plan-backed provenance capabilities');
  assert.doesNotMatch(step0, /an explicit plan path supplies the same capability/i,
    'a lone plan path must never authorize a source-spec header read');
  assert.match(step0, /direct[^]*both[^]*exact[^]*plan[^]*source-spec/i,
    'the direct form must explicitly bind both exact paths');
  assert.match(step0, /lone plan path[^]*(?:stop|reject|refuse)/i,
    'a lone plan path must fail closed before any source-spec header read');
  assert.match(step0, /source-spec header[^]*(?:only after|after)[^]*exact[^]*(?:capability|binding)/i,
    'the source-spec header read must follow acceptance of its own exact capability');
  assert.match(step0, /direct Gear-2[^]*required:\n\s+spec: <spec-path>[^]*onDemand: none/i,
    'the direct Gear-2 form must carry only the exact spec');
  assert.match(step0, /phase: brainstorm[^]*status: READY[^]*next: implement[^]*gear[^]*exactly 2/i,
    'a direct spec must be a READY brainstorm artifact routed to implement and must remain Gear 2');

  assert.doesNotMatch(step1, /read that exact ledger when present/i,
    'a derived existing ledger must not be read merely because it exists');
  assert.match(step1, /either derived artifact exists[^]*without its exact capability[^]*(?:stop|request)[^]*both resume bindings/i,
    'manual resume must stop unless both exact progress-ledger and task-results capabilities are present');
  assert.match(step1, /fresh run[^]*(?:create|initialize)[^]*ledger/i,
    'fresh-run output creation must remain allowed without historical read authority');
  const standard = readFileSync(join(root, '.apex', 'standards', 'skills.md'), 'utf8');
  assert.match(standard, /Manual implement has two mutually exclusive entries[^]*Gear-2 direct entry[^]*exact\s+`spec`[^]*plan-backed[^]*exact `plan`[^]*exact\s+`source-spec`/i);
  assert.match(standard, /Resume requires exact `progress-ledger` and `task-results` capabilities/i);
  assert.match(standard, /fresh-run output\s+creation remains allowed/i);
});

test('plan: manual recovery and bindings fail closed without candidate body reads', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  for (const phrase of ['exact', 'missing', 'malformed', 'wrong-state', 'wrong-role']) {
    assert.match(text, new RegExp(phrase, 'i'), `plan must state ${phrase} handling`);
  }
  assert.match(text, /headerless artifacts[\s\S]*ignored/i);
  assert.match(text, /never open or read a candidate body/i);
  assert.match(text, /After stable bootstrap orientation[\s\S]*read only the accepted spec body/i);
  assert.match(text, /never open a sibling or linked\s+work artifact/i);
});

test('plan: Step 0 accepts the exact manual spec capability before any verdict or body read', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
  const manualGate = step0.search(/\*\*Manual\/no-manifest[^*]*preflight[^*]*\*\*/i);
  const verdictRead = step0.search(/read the verdict artifact/i);

  assert.ok(manualGate !== -1, 'Step 0 must contain the manual/no-manifest capability preflight');
  assert.ok(verdictRead !== -1, 'Step 0 must retain the verdict/gear read');
  assert.ok(manualGate < verdictRead, 'the manual capability preflight must precede the verdict read');

  const gate = step0.slice(manualGate, verdictRead);
  assert.match(gate, /exact `spec` capability[^.]*before any verdict or spec-body read/i,
    'manual entry must accept its exact spec capability before reading verdict or body content');
  assert.match(gate, /no envelope or path[\s\S]{0,420}bounded[\s\S]{0,120}headers[\s\S]{0,240}require user selection/i,
    'pathless recovery must remain header-only and require selection');
  assert.match(gate, /after selection[\s\S]{0,160}exact\s+binding/i,
    'recovery selection must be converted into an accepted exact binding');
  assert.match(gate, /do not read[^.]*selected[^.]*verdict[^.]*body[^.]*until[^.]*binding[^.]*accepted/i,
    'recovery must not read the selected verdict or body before accepting the binding');
});

test('plan: Step 2 documents expand–contract for wide refactors, no graph machinery', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  assert.match(step2, /wide refactor/i, 'Step 2 must name the wide-refactor pattern');
  assert.match(step2, /expand\s*→\s*migrate\s*→\s*contract/i, 'Step 2 must state the expand → migrate → contract sequence');
  assert.match(step2, /beside the old/i, 'expand must add the new form beside the old');
  assert.match(step2, /batches/i, 'migration must proceed in batches sized by blast radius');
  assert.match(step2, /green between batches|suite green/i, 'the suite must stay green between batches');
  assert.match(step2, /no caller remains/i, 'contract must delete the old form when no caller remains');
  assert.match(step2, /ordinary sequential (plan\s+)?tasks/i, 'batches must be ordinary sequential tasks — no dependency-graph machinery');
  assert.match(step2, /lands green in one task.*not wide/i, 'the strict wide definition must be stated');
});

test('plan: Step 2 cuts tasks on a discovery criterion, not bite-sized alone', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  assert.doesNotMatch(step2, /bite-sized/i, 'Step 2 must no longer name bite-sized as the task-cutting criterion');
  assert.match(step2, /\bdiscover\b/i, 'Step 2 must name discovery as the mis-cut signal');
  assert.match(step2, /stated only as a goal|only[^.]*as a goal/i, 'Step 2 must flag requirements stateable only as a goal');
  assert.match(step2, /sketch of a diff.*exact paths/i, 'Step 2 must require a diff-shaped requirement against exact paths');
  assert.match(step2, /split the task/i, 'Step 2 must offer splitting the task as a remedy');
  assert.match(step2, /discovery task/i, 'Step 2 must offer a preceding discovery task as a remedy');
  assert.match(step2, /missing facts/i, 'the discovery task deliverable must be the missing facts');
  assert.match(step2, /each ending in an independently testable deliverable/i, 'Step 2 must retain the independently testable deliverable clause');
  // M4 (final-review): the retired term must not survive outside the locked slice — the skill's own
  // purpose line is what an agent reads first.
  assert.doesNotMatch(text, /bite-sized/i, 'the retired bite-sized criterion must be gone from the whole skill, purpose line included');
});

test('plan: Step 3 binds each task to Complexity and Step 4.5 verifies it', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  const step3 = sectionBetween(text, '### Step 3', '### Step 4');
  assert.match(
    step3,
    /\*\*Complexity:\*\*\s*`mechanical\s*\|\s*integration\s*\|\s*design`/,
    'Step 3 must define a Complexity binding with exactly mechanical | integration | design'
  );
  assert.match(
    step3,
    /`implement` reads this line[\s\S]*model tier[\s\S]*reviewer/i,
    'Step 3 must state that implement reads Complexity for the model tier and the reviewer decision'
  );
  const step45 = sectionBetween(text, '### Step 4.5', '### Step 5');
  assert.match(
    step45,
    /4\.\s+\*\*Complexity present\*\*/,
    'Step 4.5 must have a checklist item #4 verifying Complexity is present'
  );
});

test('implement: valid user-invocable skill, enforces TDD against the surface test command', () => {
  checkSkill('implement', ['.apex/work/specs/', '.apex/work/plans/', 'failing test', '-agent']);
});

test('implement: hands off to review with the exact minimal review capability', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const step5 = sectionBetween(text, '### Step 5 — Hand off', '## Model Selection');
  assert.match(step5, /Gear 3 only/i, 'the review handoff must be Gear-3 only');
  assert.match(step5, /Run the `review` skill in a new session/, 'handoff must still require a fresh session');
  assert.match(
    step5,
    /name the concrete inputs by repo-relative path/,
    'Step 5 must require the handoff message to carry the input paths'
  );
  assert.doesNotMatch(step5, /required:\n\s+plan:/, 'review must not receive the full plan');
  assert.match(step5, /required:\n\s+criteria: <criteria-path>\n\s+task-results: <task-result-index-path>\n\s+branch-diff: <branch-diff-path>\nonDemand: none/);
  assert.match(step5, /\.apex\/work\/tasks\/<plan-basename>\/task-result-index\.md/, 'handoff names the verified task-result-index path');
  assert.match(step5, /starts from those files, not from this conversation'?s memory/);
});

test('implement: manual entry supports mutually exclusive direct-spec and plan-backed forms, bounded and fail closed', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  assert.match(text, /two exclusive manual entry paths/i);
  assert.match(text, /required:\n\s+spec: <spec-path>\nonDemand: none/);
  assert.match(text, /required:\n\s+plan: <plan-path>\nonDemand:\n\s+source-spec: <spec-path>/);
  assert.match(text, /immediate specs and plans directories|immediate `?\.apex\/work\/specs\/`? and `?\.apex\/work\/plans\/`? directories/i);
  assert.match(text, /require user selection\s+even when there is exactly one candidate/i);
  assert.match(text, /explicit[\s\S]{0,100}(failure|invalid|malformed)[\s\S]{0,100}without (fallback|discovery)/i);
  assert.match(text, /optional `ledger\.md`[^]*canonical\s+`task-result-index\.md` solely from the accepted (?:spec or plan|entry artifact) basename/i);
  assert.doesNotMatch(text, /most recent dated plan/i);
  assert.match(text, /never search for a historical[^]*task directory or scan for a ledger\/index/i);
  assert.match(text, /If no candidate exists[^]*(?:brainstorm|plan)/i);
  assert.match(text, /\*\n!\.gitignore/, 'fallback .apex/work/.gitignore must be the two-line body');
  assert.doesNotMatch(text, /create it with content `\*`/, 'a bare * ignores the .gitignore itself');
});

test('implement: autopilot reads the phase manifest first while manual capabilities stay narrow', () => {
  const protocol = readFileSync(join(skillsDir, 'implement', 'autopilot-protocol.md'), 'utf8');
  assert.match(protocol, /conductor-supplied phase manifest/i);
  assert.match(protocol, /before any other task input/i);
  assert.match(protocol, /role and scope[\s\S]{0,100}implement phase/i);
  assert.match(protocol, /supplied correlation identity/i);
  assert.match(protocol, /every `required` input/i);
  assert.match(protocol, /`onDemand`[\s\S]{0,120}concrete named missing fact/i);
  assert.match(protocol, /authoritative input inventory/i);

  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const step1 = sectionBetween(text, '### Step 1', '### Step 2');
  assert.match(step1, /Manual drive/i);
  assert.match(step1, /read the accepted plan body/i);
  assert.match(step1, /direct Gear-2[^]*read the accepted spec body/i);
  assert.match(step1, /Do not\s+preload the source spec/i);
});

test('implement: result index lifecycle and supporting metadata are interrupt safe', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  assert.match(text, /phase: implement\nstatus: DRAFT\nnext: review\nsource: <plan-path>\nconsumed-by: none\n-->\nsource-spec: <spec-path>\ncriteria: <criteria-path>\nbranch-diff: <branch-diff-path>/);
  assert.match(text, /Gear 2[^]*phase: implement\nstatus: DRAFT\nnext: none\nsource: <spec-or-plan-path>\nconsumed-by: none/i);
  assert.match(text, /(failure|interruption)[\s\S]{0,160}plan `READY`|plan remains[\s\S]{0,80}`READY`/i);
  assert.match(text, /Gear 3[^]*every task gate succeeds[^]*whole-branch review approves[^]*handoff verification[^]*first[^]*index to `status: READY`[^]*then[^]*plan to `status: CONSUMED`/i);
  assert.match(text, /Gear 2[^]*index as `status: READY`[^]*accepted spec or plan as `status: CONSUMED`/i,
    'Gear 2 must publish terminal evidence before consuming its input');
  assert.match(text, /exact resume carrying both `progress-ledger` and `task-results`[^]*perform only the\s+input-consumption write/i,
    'Gear 2 must repair only the permitted READY-index\/READY-input prefix');
  assert.match(text, /`CONSUMED` input paired\s+with a DRAFT\/mismatched index fails closed/i,
    'an impossible terminal pair must fail closed');
  assert.match(text, /source spec[\s\S]{0,220}named fact/i);
  assert.match(text, /consumer role, exact path, and concrete reason[\s\S]{0,100}ledger/i);
  assert.match(text, /canonical `Source`[\s\S]{0,120}`Heading` attribution/i);
  assert.match(text, /unmodified aggregate `git diff`/i);
});

test('implement: materializes a self-contained Task 7 brief verbatim', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const step3 = sectionBetween(text, '### Step 3', '### Step 4');
  for (const field of [
    'Requirements and deliverables',
    'Relevant global constraints',
    'Surface',
    'Specialist agent',
    'Exact paths',
    'Test command',
    'Dependencies',
    'Complexity',
    'Success criteria',
  ]) {
    assert.match(step3, new RegExp(field, 'i'), `task brief must materialize ${field}`);
  }
  assert.match(step3, /verbatim/i, 'brief values must be copied verbatim from the approved plan');
  assert.match(step3, /direct Gear-2[^]*single[^]*Task 1[^]*accepted spec/i,
    'direct Gear-2 implementation must derive one self-contained task from the accepted spec');
  assert.match(step3, /cannot[^]*one independently testable task[^]*(?:offer|use|run)[^]*plan/i,
    'a direct spec that needs decomposition must stop before mutation and offer the optional plan');
  assert.match(step3, /implementer contract/i, 'the task brief must be the complete implementer contract');
  assert.match(step3, /no chat|conversation history/i, 'the brief must not depend on conversation context');
});

test('Gear 2 terminates in implement after surface tests and validate-hub, without plan or review', () => {
  const brainstorm = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const implement = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const brainstormHandoff = sectionBetween(brainstorm, '### Step 8 — Hand off', '## Model Selection');
  const implementStep5 = sectionBetween(implement, '### Step 5 — Hand off', '## Model Selection');

  assert.match(brainstormHandoff, /Gear 2[^]*direct[^]*`implement` skill/i);
  assert.match(brainstormHandoff, /required:\n\s+spec: <exact-spec-path>\nonDemand: none/);
  assert.match(brainstormHandoff, /Do not route Gear 2 through[^]*`plan` unless[^]*explicitly requested/i);
  assert.match(implementStep5, /Gear 2[^]*surface test[^]*validate-hub[^]*status: READY[^]*next: none[^]*status: CONSUMED/i);
  assert.match(implementStep5, /Gear 2[^]*(?:do not|does not|never)[^]*(?:invoke|hand off|handoff)[^]*review/i);
});

test('implement: autopilot creates every task-role manifest with strict CLI args and deterministic paths before dispatch', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'autopilot-protocol.md'), 'utf8');
  assert.match(text, /node <engine-root>\/scripts\/autopilot-context\.mjs/);
  for (const role of ['implementer', 'task-reviewer', 'fix', 'final-review']) {
    assert.match(text, new RegExp(`--role ${role}\\b`), `must invoke the context CLI for ${role}`);
  }
  for (const path of [
    'task-N-implement.json',
    'task-N-review-<iteration>.json',
    'task-N-fix-<iteration>.json',
    'final-review-<iteration>.json',
  ]) {
    assert.ok(text.includes(path), `must define deterministic manifest path ${path}`);
  }
  assert.match(text, /missing or invalid manifest[\s\S]{0,180}correlated `BLOCKED`/i);
  assert.match(text, /no (child )?dispatch/i);
  assert.match(text, /--brief[\s\S]*--standard[\s\S]*--artifact-output/,
    'role commands must use named paths and declare authoritative artifact outputs');
});

test('implement: role inventories are exact and never eagerly pass upstream bodies', () => {
  const skill = readFileSync(join(skillsDir, 'implement', 'autopilot-protocol.md'), 'utf8');
  const implementer = readFileSync(join(skillsDir, 'implement', 'implementer-prompt.md'), 'utf8');
  const reviewer = readFileSync(join(skillsDir, 'implement', 'task-reviewer-prompt.md'), 'utf8');
  const finalReviewer = readFileSync(join(skillsDir, 'implement', 'final-review-prompt.md'), 'utf8');

  assert.match(implementer, /required` inventory is exactly the task brief and (?:exact )?selected owning (?:surface )?standards/i);
  assert.match(reviewer, /required` inventory is exactly the task brief, implementer report, task diff, and (?:exact )?selected owning (?:surface )?standards/i);
  assert.match(reviewer, /hub index[\s\S]{0,120}`onDemand`[\s\S]{0,160}named suspected routing conflict/i);
  assert.match(finalReviewer, /required` inventory is exactly the success-criteria source, task-result index, aggregate branch diff, and relevant standards/i);
  assert.match(skill, /Fix `required` inventory is exactly the task brief, authoritative reviewer issue artifact, current task diff, and exact selected owning standards/i);
  assert.match(skill, /Never eagerly pass[\s\S]{0,180}(full spec|spec body)[\s\S]{0,180}(full plan|plan body)[\s\S]{0,180}(hub index|_INDEX)[\s\S]{0,180}transcript/i);
  assert.match(implementer, /efficiency protocol[\s\S]{0,180}not[\s\S]{0,80}(access control|sandbox)/i);
  assert.match(implementer, /repository (source|code) files[\s\S]{0,180}(inspect|read)[\s\S]{0,180}(implement|test|verify)/i);
  assert.match(implementer, /`onDemand`[\s\S]{0,180}upstream context[\s\S]{0,180}concrete[\s\S]{0,120}(reason|missing fact)/i);
  assert.doesNotMatch(implementer, /Do not read[\s\S]{0,160}other undeclared file/i);
});

test('implement: skill defines the conductor result-index grammar and canonical branch diff name exactly', () => {
  const skill = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const canonical = '- Task <id>: <DONE|DONE_WITH_CONCERNS>; artifact: <sanitized repo-relative path>; changed-paths: <comma list or none>; signals: <short machine-readable IDs or none>';
  assert.ok(skill.includes(canonical), 'skill must define the exact task-result-index bullet grammar');
  assert.match(skill, /task-result-index\.md[\s\S]{0,240}exact bullet grammar/i);
  assert.doesNotMatch(skill, /branch\.diff\b/);
  assert.ok(skill.includes('.apex/work/tasks/<plan-basename>/branch-diff.txt'));
});

test('implement: final review consumes a deterministic criteria-only artifact, never the full spec', () => {
  const skill = readFileSync(join(skillsDir, 'implement', 'autopilot-protocol.md'), 'utf8');
  const finalReviewer = readFileSync(join(skillsDir, 'implement', 'final-review-prompt.md'), 'utf8');
  const finalCommand = skill.split('\n').find((line) => line.includes('--role final-review')) ?? '';

  assert.ok(
    finalCommand.includes('--criteria .apex/work/tasks/<plan-basename>/success-criteria.md'),
    'final-review CLI must require the deterministic task-local criteria-only artifact'
  );
  assert.doesNotMatch(
    finalCommand,
    /--criteria \.apex\/work\/specs\//,
    'the full source spec must never be a final-review required input'
  );
  assert.match(skill, /materialize[\s\S]{0,180}`success-criteria\.md`/i);
  assert.match(skill, /canonical source attribution[\s\S]{0,180}spec path[\s\S]{0,180}heading/i);
  assert.match(skill, /verbatim[\s\S]{0,180}success.criteria[\s\S]{0,180}no unrelated spec sections/i);
  assert.match(finalReviewer, /criteria-only artifact/i);
  assert.match(finalReviewer, /never[\s\S]{0,120}full (source )?spec/i);
  assert.match(finalReviewer, /no unrelated spec sections/i);
});

test('implement: durable artifacts and exact four-field child envelopes keep detail off the parent context', () => {
  const files = ['SKILL.md', 'implementer-prompt.md', 'task-reviewer-prompt.md', 'final-review-prompt.md'];
  const texts = files.map((file) => readFileSync(join(skillsDir, 'implement', file), 'utf8'));
  const envelope = [
    'status: <enum>',
    'artifact: <sanitized repo-relative path>',
    'changed-paths: <comma list or none>',
    'signals: <short machine-readable IDs or none>',
  ].join('\n');
  for (const [index, text] of texts.entries()) {
    assert.ok(text.includes(index >= 2 ? envelope.replace('changed-paths: <comma list or none>', 'changed-paths: none') : envelope), `${files[index]} must carry the exact four-field envelope`);
    assert.match(text, /exactly four fields/i, `${files[index]} must prohibit extra response fields`);
    assert.match(text, /no headings|headings/i, `${files[index]} must prohibit response headings`);
    assert.match(text, /no .*commits.*tests.*prose concern details.*diff.*report.*test transcript/is,
      `${files[index]} must keep verbose payloads out of the envelope`);
  }

  const skill = texts[0];
  for (const artifact of ['task-N-report.md', 'task-N-review.md', 'task-N-issues.md', 'final-review.md', 'final-review-issues.md']) {
    assert.ok(skill.includes(artifact), `controller must define authoritative artifact ${artifact}`);
  }
  assert.match(skill, /validate[\s\S]{0,180}four-field shape[\s\S]{0,180}status[\s\S]{0,180}sanitized repo-relative[\s\S]{0,180}signals/i);
  assert.match(skill, /malformed envelope[\s\S]{0,180}(BLOCKED|degradation)/i);
  assert.match(skill, /opens? the artifact only when[\s\S]{0,160}(next decision|action status)/i);
  assert.match(skill, /ledger[\s\S]{0,100}task-result index[\s\S]{0,180}compact outcome[\s\S]{0,100}artifact reference/i);
});

test('artifact-first child contracts share ordered fields while status domains and placeholders stay role-specific', () => {
  const emitters = [
    ['implement/SKILL.md', 'controller'],
    ['implement/implementer-prompt.md', 'implementer'],
    ['implement/task-reviewer-prompt.md', 'reviewer'],
    ['implement/final-review-prompt.md', 'reviewer'],
  ];
  const orderedFields = ['status', 'artifact', 'changed-paths', 'signals'];

  for (const [relativePath, role] of emitters) {
    const text = readFileSync(join(skillsDir, relativePath), 'utf8');
    const envelope = text.match(/^[ \t]*status: <[^\n]+>\n[ \t]*artifact: <[^\n]+>\n[ \t]*changed-paths: (?:<[^\n]+>|none)\n[ \t]*signals: <[^\n]+>$/m)?.[0];
    assert.ok(envelope, `${relativePath} must emit the four-field ${role} result contract`);
    assert.deepEqual(
      envelope.split('\n').map((line) => line.trimStart().slice(0, line.trimStart().indexOf(':'))),
      orderedFields,
      `${relativePath} must preserve the canonical ordered field names`
    );
  }

  const standard = readFileSync(join(root, '.apex', 'standards', 'skills.md'), 'utf8');
  assert.match(standard, /exact ordered four-field shape/i);
  assert.match(standard, /status domains and placeholder (?:text|bytes) are role-specific[^.]*not byte-identical/i);
  assert.match(standard, /Implementer and fix[^`]*`DONE \| DONE_WITH_CONCERNS \| BLOCKED \| NEEDS_CONTEXT`/i);
  assert.match(standard, /Reviewer[^`]*`APPROVED \| ISSUES_FOUND \| BLOCKED \| NEEDS_CONTEXT`/i);
  assert.match(standard, /loop prompt templates[^.]*closed artifact-first envelopes[^.]*exact ordered\s+four-field shape/i);

  const implementSkill = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const implementer = readFileSync(join(skillsDir, 'implement', 'implementer-prompt.md'), 'utf8');
  const taskReviewer = readFileSync(join(skillsDir, 'implement', 'task-reviewer-prompt.md'), 'utf8');
  const finalReviewer = readFileSync(join(skillsDir, 'implement', 'final-review-prompt.md'), 'utf8');
  assert.match(implementSkill, /Implementer\/fix statuses are `DONE`,\s*\n`DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`/);
  assert.match(implementSkill, /reviewer statuses are `APPROVED`, `ISSUES_FOUND`,\s*\n`NEEDS_CONTEXT`, or `BLOCKED`/);
  assert.match(implementer, /DONE \| DONE_WITH_CONCERNS \| BLOCKED \| NEEDS_CONTEXT/);
  for (const [relativePath, text] of [
    ['implement/task-reviewer-prompt.md', taskReviewer],
    ['implement/final-review-prompt.md', finalReviewer],
  ]) {
    assert.match(text, /APPROVED \| ISSUES_FOUND \| BLOCKED \| NEEDS_CONTEXT/,
      `${relativePath} must preserve the reviewer-only status domain`);
  }
});

test('implement: multi-task parent state contains envelopes only while durable artifacts feed the next role', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const proof = sectionBetween(text, '### Multi-task artifact-flow proof', '### Step 4');
  assert.match(proof, /Task 1[\s\S]*Task 2/i);
  assert.match(proof, /parent[\s\S]{0,120}(only|solely)[\s\S]{0,120}four-field envelopes/i);
  assert.match(proof, /task-N-report\.md[\s\S]{0,180}task reviewer/i);
  assert.match(proof, /task-N-issues\.md[\s\S]{0,180}fix/i);
  assert.match(proof, /task-result-index\.md[\s\S]{0,180}final reviewer/i);
  assert.match(proof, /no (artifact )?bod(y|ies)[\s\S]{0,120}parent/i);
});

test('review: valid user-invocable skill, verifies bounded work artifacts and stable docs', () => {
  checkSkill('review', ['task-results', 'branch-diff', 'validate-hub.mjs', 'testing-and-checklist.md']);
});

test('review: verifies bounded local work artifacts and promotion of durable knowledge', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  assert.match(text, /manual[^]*criteria[^]*task-result[^]*diff/i);
  assert.match(text, /Eagerly read exactly the accepted `criteria`, `task-results`, and\n`branch-diff` artifacts/);
  assert.match(text, /stable routing inputs normally:[^]*`\.apex\/_INDEX\.md`[^]*`\.apex\/testing-and-checklist\.md`/);
  assert.match(text, /If the work changed a durable convention, standard, domain term, architecture decision, user-facing workflow, or README behavior, verify that the durable knowledge was promoted into stable versioned docs/);
  assert.match(text, /Specs and plans themselves are not sufficient evidence of durable documentation\./);
  assert.match(text, /If it reports violations in stable docs \(orphan stable doc, broken stable link, routing mismatch, or a stable link into `\.apex\/work\/\*\*`\), the change is incomplete\./);
});

test('review: Step 2 sweeps only bounded criteria and compact index insights', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  const manifestSweep = sectionBetween(step2, '- **Manifest-backed autopilot:**', '- **Manual/no-manifest:**');
  const manualSweep = sectionBetween(step2, '- **Manual/no-manifest:**', 'A recorded **discovery** occurrence');
  const discoverySweep = sectionBetween(step2, 'A recorded **discovery** occurrence', 'For each candidate:');
  assert.match(step2, /Insight sweep/, 'Step 2 must contain an active insight sweep');
  assert.match(manifestSweep, /criteria-only artifact[^.]*task-result index/i,
    'manifest review must derive insight evidence from its criteria/index inventory');
  assert.match(manifestSweep, /`signals`[^.]*`DONE_WITH_CONCERNS`|`DONE_WITH_CONCERNS`[^.]*`signals`/i,
    'manifest review must use compact concern status and signals');
  assert.match(manualSweep, /accepted criteria artifact[^.]*accepted task-result index/i,
    'manual review must derive insight evidence from its accepted criteria/index inventory');
  assert.match(manualSweep, /`DONE_WITH_CONCERNS`[^.]*`signals`|`signals`[^.]*`DONE_WITH_CONCERNS`/i,
    'manual review must use compact concern status and signals');
  assert.match(discoverySweep, /both regular-review branches[^.]*accepted task-result index/i,
    'both regular-review branches must derive discovery evidence from the accepted compact index');
  assert.doesNotMatch(
    step2,
    /(?:read|reading|open|consult|inspect|locate)[^.\n]{0,120}(?:the )?per-task (?:files?|reports?|reviews?)/i,
    'regular review must never direct a per-task-file read'
  );
  assert.match(text, /Sweep unpromoted insights/, 'the checklist must carry the insight sweep');
});

test('review: Step 2 insight sweep reports a recorded discovery occurrence as a rebuttal to the plan task-cutting criterion', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  assert.match(step2, /discovery[\s\S]{0,200}rebuttal[\s\S]{0,120}task-cutting criterion/i,
    'the sweep must report a recorded discovery occurrence as a rebuttal to the plan task-cutting criterion');
  assert.match(step2, /distinct from other\s+concerns/i,
    'the discovery occurrence must be reported distinct from other concerns');
  assert.match(step2, /No richer source\s+or per-task file read is authorized by a concern/i,
    'the manifest-backed branch must stay on its already-declared inventory, no new source');
});

test('review: Step 5 resolves a version bump (or no-release label) before offering the PR', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step5 = sectionBetween(text, '### Step 5', '## Model Selection');
  assert.match(step5, /bump-version\.mjs/, 'Step 5 must run bump-version.mjs before opening the PR');
  assert.match(step5, /CHANGELOG\.md/, 'Step 5 must add a CHANGELOG.md section for the bump');
  assert.match(step5, /no-release/, 'Step 5 must document the no-release label escape hatch');
  assert.match(step5, /version-gate\.yml/, 'Step 5 must scope-gate the bump on the target repo owning version-gate.yml');
});

test('review: gains an autopilot branch — Step 0 BLOCKED note, Autopilot paragraph stops before bump/PR at READY_FOR_PR', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');

  const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
  assert.match(step0, /drive:\s*autopilot/i, 'Step 0 must mention drive: autopilot');
  assert.match(step0, / — review — BLOCKED — /, 'Step 0 must describe appending " — review — BLOCKED — " to the status file');
  assert.match(step0, /autopilot-status\.md/, 'Step 0 must reference autopilot-status.md');
  assert.match(step0, /CONFLICT/, 'Step 0 must call out a discovered CONFLICT as always a halt');

  // the existing Step 5 bump/PR lock must stay green — the Autopilot paragraph must not
  // weaken or remove any of its required substrings
  const step5 = sectionBetween(text, '### Step 5', '## Model Selection');
  assert.match(step5, /bump-version\.mjs/);
  assert.match(step5, /CHANGELOG\.md/);
  assert.match(step5, /no-release/);
  assert.match(step5, /version-gate\.yml/);

  const autopilotSection = sectionBetween(text, '### Step 4', '## Model Selection');
  assert.match(autopilotSection, /\*\*Autopilot:\*\*/, 'Step 4/5 must carry an Autopilot paragraph');
  assert.match(autopilotSection, /drive:\s*autopilot/i, 'Autopilot paragraph must mention drive: autopilot');
  assert.match(autopilotSection, / — review — READY_FOR_PR — /, 'Autopilot paragraph must describe appending " — review — READY_FOR_PR — " to the status file');
  assert.match(autopilotSection, /autopilot-status\.md/, 'Autopilot paragraph must reference autopilot-status.md');
  assert.match(autopilotSection, /no version bump|no bump/i, 'Autopilot paragraph must state the run stops before any version bump');
});

test('canonical bootstrap routes root and index context to ownership and semantic workflow skills', () => {
  const tpl = readFileSync(join(here, '..', 'templates', 'project-bootstrap-skill.md'), 'utf8');
  assert.match(tpl, /Read `AGENTS\.md` in full/u, 'router should read the harness-neutral root spine');
  assert.match(tpl, /semantic skill name/i,
    'router should invoke workflow skills by their semantic names');
  assert.match(tpl, /\.apex\/_INDEX\.md/, 'router should read the hub routing table');
  assert.match(tpl, /owning surface and specialist agent/, 'router should name ownership before changes');
  assert.match(tpl, /test command and the hub coherence gate/, 'router should run validation before completion');
  assertNoBareWorkflowInvocations(tpl, 'templates/project-bootstrap-skill.md');
});

test('workflow-skills suite uses only the permanent bootstrap template source', () => {
  const suiteSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const excludedSources = [
    ['CL', 'AUDE.md'],
    ['bootstrap', '-skill.md'],
    ['surface-agent', '.md'],
  ].map(([prefix, suffix]) => `templates/${prefix}${suffix}`);

  for (const excludedSource of excludedSources) {
    assert.doesNotMatch(
      suiteSource,
      new RegExp(excludedSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `workflow-skills suite must not name excluded source ${excludedSource}`
    );
  }
  assert.match(
    suiteSource,
    /templates\/project-bootstrap-skill\.md/,
    'workflow-skills suite must name the permanent bootstrap template source'
  );
});

test('README and thin Claude stub expose only the approved canonical bootstrap routing contract', () => {
  const tpl = readFileSync(join(here, '..', 'templates', 'project-bootstrap-skill.md'), 'utf8');
  const stub = readFileSync(join(here, '..', 'templates', 'claude-bootstrap-stub.md'), 'utf8');
  const readme = readFileSync(join(here, '..', 'README.md'), 'utf8');
  const workflow = readFileSync(join(here, '..', 'docs', 'workflow.md'), 'utf8');
  const loopEngineer = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  assert.match(tpl, /steepy:generated:[^\n]+:v1/, 'bootstrap must carry the permanent v1 generation marker');
  assert.match(tpl, /name: \{\{projectName\}\}-bootstrap/, 'bootstrap name must use the project placeholder');
  assert.match(tpl, /user-invocable: true/, 'bootstrap must remain user-invocable');
  assert.match(tpl, /Read `AGENTS\.md` in full/, 'bootstrap must load root instructions');
  assert.match(tpl, /Read `\.apex\/_INDEX\.md` in full/, 'bootstrap must load the hub index');
  assert.match(tpl, /minimum documents named by its routing row/, 'bootstrap must preserve minimum-doc routing');
  assert.match(tpl, /owning surface and specialist agent/u, 'bootstrap must name routed ownership');
  assert.match(tpl, /semantic skill name/u, 'bootstrap must route workflows semantically');
  assert.doesNotMatch(tpl, /coverage verdict|gear selection|ratification|git branch|workflow state/iu,
    'canonical bootstrap must not regain the retired ceremony procedure');
  assert.match(stub, /Read `\.agents\/skills\/\{\{projectName\}\}-bootstrap\/SKILL\.md` in full/u);
  assert.doesNotMatch(stub, /\.apex\/_INDEX|## Procedure|coverage verdict|gear/iu,
    'Claude must remain a thin delegation stub');
  assert.doesNotMatch(readme,
    /generated bootstrap skill[^\n]*(?:classif|coverage verdict|gear)|generated bootstrap[^\n]*(?:ratif|branch)/iu,
    'README must not promise retired ceremony behavior from the generated bootstrap');
  assert.match(readme,
    /generated bootstrap[^\n]*(?:AGENTS\.md|root instructions)[^\n]*(?:\.apex\/_INDEX\.md|routing)[^\n]*semantic/iu,
    'README quick start must describe root/index navigation and semantic workflow routing');
  assert.doesNotMatch(workflow,
    /generated bootstrap[^\n]*(?:classifies|coverage verdict|gear selection|ratification|workflow-state router)/iu,
    'workflow docs must not restore the retired bootstrap ceremony contract');
  assert.doesNotMatch(loopEngineer,
    /auto-chain[^\n]*bootstrap|bootstrap[^\n]*(?:sole author|ratification signature|writes\/completes `goal\.md`)/iu,
    'workflow skills must not depend on a deleted bootstrap ceremony branch');
});

test('bootstrap template Step 3 describes core+leaf load semantics for modular surface standards', () => {
  const tpl = readFileSync(join(here, '..', 'templates', 'project-bootstrap-skill.md'), 'utf8');
  assert.match(tpl, /Match the task to the owning surface/, 'bootstrap must route tasks by owning surface');
  assert.match(tpl, /read only the minimum documents/, 'bootstrap must load only minimum routed docs');
  assert.match(tpl, /surface and specialist agent/, 'bootstrap must identify the specialist before edits');
});

function reviewerBody(name, file) {
  const path = join(skillsDir, name, file);
  assert.ok(existsSync(path), `${name}/${file} should exist`);
  const text = readFileSync(path, 'utf8');
  for (const marker of ['Status', 'Approved', 'Issues Found']) {
    assert.ok(text.includes(marker), `${name}/${file} must define output marker '${marker}'`);
  }
  assert.match(text, /routing table|_INDEX\.md/, `${name}/${file} must check routing-table ownership`);
  assert.match(text, /standards\/|STANDARD_INPUTS/, `${name}/${file} must reference the surface standard`);
  assert.match(text, /Completeness/, `${name}/${file} must check Completeness`);
  assert.match(text, /Calibration/i, `${name}/${file} must include a Calibration section`);
  return text;
}

function wiredAfterValidate(name, promptFile) {
  const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
  assert.ok(text.includes(promptFile), `${name} SKILL must cite ${promptFile}`);
  const vIdx = text.indexOf('validate-hub.mjs');
  const rIdx = text.indexOf(promptFile);
  assert.ok(vIdx !== -1, `${name} SKILL must still run validate-hub`);
  assert.ok(rIdx > vIdx, `${name} reviewer dispatch must come after validate-hub`);
  return text;
}

test('brainstorm: gear-3 spec gate is a human review, not a subagent', () => {
  const dir = join(skillsDir, 'brainstorm');
  assert.ok(!existsSync(join(dir, 'spec-reviewer-prompt.md')),
    'the spec-reviewer subagent prompt must be retired');
  const text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  assert.doesNotMatch(text, /spec-reviewer-prompt\.md/, 'brainstorm must not dispatch a spec-reviewer subagent');
  const step7 = sectionBetween(text, '### Step 7', '### Step 8');
  assert.match(step7, /Gear 3 only/i, 'the spec human gate is gear-3 only');
  assert.match(step7, /human/i, 'Step 7 must be a human review gate');
  assert.match(step7, /review it|review the (written )?spec/i, 'Step 7 must ask the user to review the written spec');
  assert.doesNotMatch(step7, /Dispatch a fresh/i, 'Step 7 must not dispatch a subagent reviewer');
});

test('brainstorm: Step 7 offers the drive-mode choice — manual default, autopilot launches the conductor', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step7 = sectionBetween(text, '### Step 7', '### Step 8');
  assert.match(step7, /#### Drive mode \(gear 3, on approval\)/, 'Step 7 must carry a Drive mode subsection');
  assert.match(step7, /drive `manual` or\s*\n?\s*`autopilot`/i, 'Step 7 must ask the drive-mode question');
  assert.match(step7, /`manual`\*\*? \(default\)/i, 'manual must be named as the default');
  assert.match(step7, /proceed to Step 8/i, 'manual must proceed to Step 8');
  assert.match(step7, /canonical envelope/i, 'manual must emit the canonical envelope');
  assert.match(step7, /adapters\/headless\.mjs/, 'Step 7 must cite the headless adapter map');
  assert.match(step7, /no headless (one-shot )?mode/i, 'Step 7 must name the no-headless-mode degradation');
  assert.match(step7, /do not offer autopilot/i, 'a harness with no headless mode must not be offered autopilot');
  assert.match(step7, /branch name \(suggest/i, 'autopilot must anticipate the branch-name decision');
  assert.match(step7, /commit authorization \(per-task commits\)/i, 'autopilot must anticipate the commit-auth decision');
  assert.match(step7, /Create the branch/, 'autopilot must create the branch');
  assert.match(step7, /harness`? = the current harness/i, 'the contract harness field must be the current harness');
  assert.doesNotMatch(step7, /^\s*budget:/m, 'new gear-3 autopilot contracts must not author a budget field');
  assert.match(step7, /`budget` field is rejected on fresh and resumed gear-3 contracts/i);
  assert.match(step7, /do not author it/i);
  assert.match(step7, /commit-auth: per-task/, 'the contract must fill commit-auth: per-task');
  assert.match(step7, /blast-radius: branch-only, no-push, stop-before-PR/, 'the contract must fill the blast-radius value');
  assert.match(step7, /launch the conductor in background/i, 'Step 7 must describe the launch as launching the conductor in background');
  assert.match(step7, /node <engine-root>\/scripts\/autopilot\.mjs <spec-path>/, 'Step 7 must launch autopilot.mjs on the spec path');
  assert.match(step7, /\.apex\/work\/tasks\/<spec-basename>\/autopilot-status\.md/, 'Step 7 must report the status file path');
  assert.match(step7, /phase-<n>\.log/, 'Step 7 must report the phase log path');
  assert.match(step7, /READY_FOR_PR/, 'Step 7 must name the READY_FOR_PR halt state');
  assert.match(step7, /gate 8 stays human/i, 'Step 7 must state gate 8 stays human');
  assert.match(step7, /interactive session/i, 'Step 7 must state gate 8 runs in an interactive session');
  assert.match(step7, /no new question is asked at gears 1-2/i, 'the manual path must state no new question at gears 1-2');
  assert.match(step7, /answering `manual` changes nothing downstream/i, 'the manual path must state manual changes nothing downstream');
  assert.doesNotMatch(step7, /dispatch a fresh/i, 'Step 7 must not use the forbidden phrase "dispatch a fresh"');
});

test('brainstorm: autopilot contracts default to safe logs, disclose exact capture, and hand off live artifacts without changing manual drive', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step7 = sectionBetween(text, '### Step 7', '### Step 8');
  assert.match(step7, /log-mode:\s*safe/i, 'gear-3 autopilot contracts must write log-mode: safe by default');
  assert.match(step7, /explicitly requests? sensitive exact capture/i, 'exact logging must require an explicit sensitive-capture request');
  assert.match(step7, /exact raw logs may contain secrets/i, 'exact logging must warn that raw logs may contain secrets');
  assert.match(step7, /EXACT_LOGGING/, 'exact logging must emit or record EXACT_LOGGING');
  assert.match(step7, /phase-<n>-attempt-<m>\.log/, 'launch handoff must name each readable attempt log');
  assert.match(step7, /phase-<n>-attempt-<m>\.raw\.jsonl/, 'launch handoff must name each raw attempt log');
  assert.match(step7, /aggregate `?phase-<n>\.log`?/i, 'launch handoff must name the aggregate phase log');
  assert.match(step7, /native open\/resume reference when supported/i, 'launch handoff must report native open/resume references when available');
  assert.match(step7, /no-steer/i, 'autopilot handoff must make the no-steer rule explicit');
  assert.match(step7, /stop-before-PR/i, 'autopilot handoff must make the stop-before-PR boundary explicit');
  assert.match(step7, /`manual`\*\*? \(default\)/i, 'manual drive must remain the default');
  assert.match(step7, /no new question is asked at gears 1-2/i, 'new logging behavior must not add a manual or lower-gear question');
});

test('brainstorm: finalized specs carry one allowed Feature complexity and the human gate validates it', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step5 = sectionBetween(text, '### Step 5', '### Step 5.5');
  assert.match(
    step5,
    /exactly one `Feature complexity: mechanical \| integration \| design`/,
    'the finalized spec format must require exactly one Feature complexity field'
  );
  const step55 = sectionBetween(text, '### Step 5.5', '### Write-back routing');
  assert.match(step55, /Feature complexity/i, 'self-review must inspect Feature complexity');
  assert.match(step55, /mechanical \| integration \| design/, 'self-review must enforce the allowed complexity vocabulary');
  const step7 = sectionBetween(text, '### Step 7', '### Step 8');
  assert.match(step7, /Feature complexity/i, 'the human gate must validate Feature complexity before handoff');
  assert.doesNotMatch(step7, /resource[- ]profile|resource profile/i, 'budget removal must not add a replacement resource-profile question');
});

test('plan: gear-3 plan gate is a human review, not a subagent', () => {
  const dir = join(skillsDir, 'plan');
  assert.ok(!existsSync(join(dir, 'plan-reviewer-prompt.md')),
    'the plan-reviewer subagent prompt must be retired');
  const text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  assert.doesNotMatch(text, /plan-reviewer-prompt\.md/, 'plan must not dispatch a plan-reviewer subagent');
  const step6 = sectionBetween(text, '### Step 6', '### Step 7');
  assert.match(step6, /Gear 3 only/i, 'the plan human gate is gear-3 only');
  assert.match(step6, /human/i, 'Step 6 must be a human review gate');
  assert.match(step6, /review it|review the (written )?plan/i, 'Step 6 must ask the user to review the written plan');
  assert.doesNotMatch(step6, /Dispatch a fresh/i, 'Step 6 must not dispatch a subagent reviewer');
});

test('plan: Step 6 gains autopilot branch — drive: autopilot → non-blocking checkpoint, append DONE to status file', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  const step6 = sectionBetween(text, '### Step 6', '### Step 7');
  assert.match(step6, /drive:\s*autopilot/i, 'Step 6 must mention drive: autopilot');
  assert.match(step6, /autopilot-status\.md/, 'Step 6 must reference autopilot-status.md');
  assert.match(step6, / — plan — DONE — /, 'Step 6 must describe appending " — plan — DONE — " to status file');
  assert.match(step6, /superseded|non-blocking/i, 'Step 6 must use a supersession word (superseded or non-blocking)');
  const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
  assert.match(step0, /drive:\s*autopilot/i, 'Step 0 must mention drive: autopilot');
  assert.match(step0, /BLOCKED/i, 'Step 0 must mention BLOCKED for autopilot runs');
  assert.match(step0, /autopilot-status\.md/, 'Step 0 must reference autopilot-status.md');
  // Verify existing plan locks still pass
  assert.match(step6, /Gear 3 only/i, 'the plan human gate must remain gear-3 only');
  assert.match(step6, /human/i, 'Step 6 must remain a human review gate');
  assert.match(step6, /review it|review the (written )?plan/i, 'Step 6 must still ask the user to review the written plan');
  assert.doesNotMatch(step6, /Dispatch a fresh/i, 'Step 6 must not use the phrase "dispatch a fresh"');
});

test('plan: autopilot consumes its phase manifest first; manual discovery remains unchanged', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
  assert.match(step0, /conductor-supplied phase manifest/i, 'autopilot plan must name the conductor-supplied phase manifest');
  assert.match(step0, /read[\s\S]{0,80}manifest (?:first|before any other)/i, 'autopilot plan must read the manifest first');
  assert.match(step0, /validate[^.]*role[^.]*scope|validate[^.]*scope[^.]*role/i, 'autopilot plan must validate manifest role and scope');
  assert.match(step0, /every `required`|all `required`/i, 'autopilot plan must eagerly read every required input');
  assert.match(step0, /do not preload `onDemand`/i, 'autopilot plan must not preload onDemand inputs');
  assert.match(step0, /concrete named missing fact/i, 'onDemand reads must require a concrete named missing fact');
  assert.match(step0, /record[^.]*read/i, 'onDemand reads must be recorded');
  assert.match(step0, /only when `drive: autopilot`|applies only when `drive: autopilot`/i,
    'phase-manifest authority must be autopilot-only');
  const step1 = sectionBetween(text, '### Step 1', '### Step 2');
  assert.match(step1, /Manual drive/i, 'Step 1 must explicitly preserve manual-drive discovery');
  assert.match(step1, /read only the accepted spec body/i, 'manual drive must read the selected full spec only');
  assert.match(step1, /\.apex\/_INDEX\.md/, 'manual drive must retain routing-table discovery');
  assert.match(step1, /\.apex\/testing-and-checklist\.md/, 'manual drive must retain testing-checklist discovery');
  assert.match(step1, /each required modular core[^.]*mini-routing table/i,
    'manifest-backed plan must inspect every required modular core mini-routing table');
  assert.match(step1, /required\s+spec[^.]*exact paths\/topics/i,
    'plan modular matching must use the required spec exact paths/topics');
  assert.match(step1, /read every matching\s+leaf[^.]*`onDemand`/i,
    'plan must read every matching declared onDemand leaf');
  assert.match(step1, /record[^.]*concrete reason[^.]*matching leaf/i,
    'plan must record a concrete reason for every matching leaf read');
  assert.match(step1, /zero\s+(?:leaves\s+)?match(?:es)?[^.]*core only/i,
    'plan must retain core-only loading for zero matches');
  assert.match(step1, /never read\s+all leaves[^.]*fallback/i,
    'plan must prohibit a read-all modular fallback');
});

test('plan: each task is a self-contained spec-to-brief contract with every mandatory field', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  const step3 = sectionBetween(text, '### Step 3', '### Step 4');
  for (const field of [
    'Requirements and deliverables',
    'Relevant global constraints',
    'Surface',
    'Specialist agent',
    'Exact paths',
    'Test command',
    'Dependencies',
    'Complexity',
    'Success criteria',
  ]) {
    assert.ok(step3.includes(`**${field}:**`), `plan task format must include ${field}`);
  }
  assert.match(step3, /repository-relative/i, 'task paths must be repository-relative');
  assert.match(step3, /canonical path \+ heading/i, 'large upstream references must use canonical path + heading');
  assert.match(step3, /No requirement may live only in conversation/i,
    'the plan must prohibit requirements that exist only in conversation');
  assert.match(step3, /mechanical \| integration \| design/, 'task complexity must use the allowed vocabulary');
  assert.match(step3, /## Task <positive integer>/i, 'plan must define the canonical machine-readable task boundary');
  assert.match(step3, /SC1/i, 'plan must define the canonical success-criterion ID grammar');
});

test('brainstorm: canonical autopilot metadata and success-criteria grammar is explicit', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step5 = sectionBetween(text, '### Step 5', '### Step 5.5');
  assert.match(step5, /## Success criteria/, 'brainstorm must require exactly one canonical success-criteria H2');
  assert.match(step5, /SC1/, 'brainstorm must assign stable criterion IDs');
  assert.match(step5, /Cross-cutting surfaces/, 'brainstorm must separate cross-cutting metadata from ownership');
});

test('plan: autopilot writes exactly the manifest-declared output while manual naming remains dated', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  const step4 = sectionBetween(text, '### Step 4', '### Step 4.5');
  assert.match(step4, /Autopilot[\s\S]*exactly[\s\S]*manifest[^.]*`outputs`/i);
  assert.match(step4, /Manual drive[\s\S]*YYYY-MM-DD-<topic>\.md/i);
});

test('plan: self-review gates completeness, binding, ordering, coverage, safe paths, and context independence', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  const step45 = sectionBetween(text, '### Step 4.5', '### Step 5');
  assert.match(step45, /every mandatory field/i, 'self-review must check every mandatory field');
  assert.match(step45, /known surface/i, 'self-review must validate a known surface');
  assert.match(step45, /registered specialist agent/i, 'self-review must validate the registered specialist agent');
  assert.match(step45, /dependency ordering/i, 'self-review must validate dependency ordering');
  assert.match(step45, /criteria coverage/i, 'self-review must validate criteria coverage');
  assert.match(step45, /allowed complexity/i, 'self-review must validate allowed complexity');
  assert.match(step45, /safe repository-relative paths/i, 'self-review must validate safe paths');
  assert.match(step45, /context independence/i, 'self-review must validate context independence');
  assert.match(step45, /before[^.]*DONE|before[^.]*human approval/i,
    'the plan may not complete or seek approval before the self-review gate passes');
});

test('plan: Step 4.5 checklist adds the discovery criterion without renumbering the first seven checks', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  const step45 = sectionBetween(text, '### Step 4.5', '### Step 5');
  assert.match(step45, /1\.\s+\*\*Every mandatory field\*\*/, 'checklist item 1 must stay Every mandatory field');
  assert.match(step45, /2\.\s+\*\*Binding consistency\*\*/, 'checklist item 2 must stay Binding consistency');
  assert.match(step45, /3\.\s+\*\*Dependency ordering\*\*/, 'checklist item 3 must stay Dependency ordering');
  assert.match(step45, /4\.\s+\*\*Complexity present\*\*/, 'checklist item 4 must stay Complexity present');
  assert.match(step45, /5\.\s+\*\*Criteria coverage\*\*/, 'checklist item 5 must stay Criteria coverage');
  assert.match(step45, /6\.\s+\*\*Safe repository-relative paths\*\*/, 'checklist item 6 must stay Safe repository-relative paths');
  assert.match(step45, /7\.\s+\*\*Context independence\*\*/, 'checklist item 7 must stay Context independence');
  assert.match(step45, /8\.\s+\*\*[^*]+\*\*/, 'an 8th checklist item must be added for the discovery criterion');
  const item8 = step45.match(/8\.\s+\*\*[^\n]*/)?.[0] ?? '';
  assert.match(item8, /stated only as a goal|only[^.]*as a goal/i, 'checklist item 8 must check no task is stateable only as a goal');
  assert.match(item8, /split|discovery task/i, 'checklist item 8 must name the split-or-precede-with-discovery remedy');
});

test('review: autopilot manifest and manual capability inventories are authoritative and exclude transcripts', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
  assert.match(step0, /conductor-supplied phase manifest/i, 'autopilot review must name the conductor-supplied phase manifest');
  assert.match(step0, /read[\s\S]{0,80}manifest (?:first|before any other)/i, 'autopilot review must read the manifest first');
  assert.match(step0, /validate[^.]*role[^.]*scope|validate[^.]*scope[^.]*role/i, 'autopilot review must validate manifest role and scope');
  assert.match(step0, /every `required`|all `required`/i, 'autopilot review must eagerly read every required input');
  assert.match(step0, /do not preload `onDemand`/i, 'autopilot review must not preload onDemand inputs');
  assert.match(step0, /concrete named missing fact/i, 'review onDemand reads must require a concrete named missing fact');
  assert.match(step0, /record[^.]*read/i, 'review onDemand reads must be recorded');
  assert.match(step0, /only when `drive: autopilot`|applies only when `drive: autopilot`/i,
    'review manifest authority must be autopilot-only');
  assert.match(step0, /manifest[^.]*failure[\s\S]{0,200}BLOCKED|BLOCKED[\s\S]{0,200}manifest[^.]*failure/i,
    'manifest failures must use the correlated BLOCKED protocol');
  assert.match(step0, /manifest\.contract\.(?:verdict|gear|drive)/,
    'manifest-backed review must take Step-0 scalars from manifest.contract');
  assert.match(step0, /do not read[^.]*spec/i,
    'manifest-backed review must prohibit the undeclared full-spec read');
  const manualBranch = step0.match(/\*\*Manual\/no-manifest[^]*?(?=\n\n|\n- \*\*)/)?.[0];
  assert.ok(manualBranch, 'review Step 0 must preserve a local manual/no-manifest branch');
  assert.match(manualBranch, /manual handoff/i);
  assert.match(manualBranch, /criteria[^]*task-results[^]*branch-diff/i);

  const step1 = sectionBetween(text, '### Step 1', '### Step 2');
  for (const inventory of [
    'success-criteria source',
    'task/result index',
    'aggregate diff',
    'relevant standards',
    'test commands',
  ]) {
    assert.match(step1, new RegExp(inventory.replace('/', '\\/'), 'i'), `review manifest must inventory ${inventory}`);
  }
  assert.match(step1, /exclude[^.]*per-task transcripts[^.]*conversations/i,
    'review must exclude per-task transcripts and conversations');
  assert.match(step1, /Manual drive/i, 'Step 1 must explicitly define manual review loading');
  assert.match(step1, /Eagerly read exactly[^]*criteria[^]*task-results[^]*branch-diff/i);
  assert.match(step1, /each required modular core[^.]*mini-routing table/i,
    'manifest-backed review must inspect every required modular core mini-routing table');
  assert.match(step1, /required\s+criteria[^.]*task(?:\/result|-result) index[^.]*branch diff/i,
    'review modular matching must use only declared criteria/index/diff evidence');
  assert.match(step1, /read every matching\s+leaf[^.]*`onDemand`/i,
    'review must read every matching declared onDemand leaf');
  assert.match(step1, /record[^.]*concrete reason[^.]*matching leaf/i,
    'review must record a concrete reason for every matching leaf read');
  assert.match(step1, /zero\s+(?:leaves\s+)?match(?:es)?[^.]*core only/i,
    'review must retain core-only loading for zero matches');
  assert.match(step1, /never read\s+all leaves[^.]*fallback/i,
    'review must prohibit a read-all modular fallback');
  const reviewModularRule = step1.match(/For each required modular core[^]*?(?=\n\n|\n\*\*Gear 4)/)?.[0] ?? '';
  assert.match(reviewModularRule, /never consult[^.]*spec[^.]*plan[^.]*ledger/i,
    'manifest-backed review modular matching must explicitly prohibit spec, plan, and ledger');

  const checklist = sectionBetween(text, '## Checklist', '## Procedure');
  const regularChecklist = checklist.replace(/\(gear 4:[^)]*\)/giu, '');
  assert.match(checklist,
    /manual[^\n]*criteria[^\n]*task-result index[^\n]*branch diff[^\n]*stable routed inputs/i,
    'regular manual review must name its exact bounded inventory');
  assert.match(checklist, /gear 4[^\n]*goal contract[^\n]*loop ledger/i,
    'the mutually exclusive Gear-4 inventory must remain explicit');
  assert.doesNotMatch(regularChecklist,
    /(?:read|load|locate|consult|inspect|sweep)[^\n]*(?:\bspec\b|\bplan\b|progress[- ]ledger)/i,
    'regular manual review must not name spec, plan, or progress-ledger reads');
  assert.match(checklist,
    /manual[^\n]*insight[^\n]*accepted criteria[^\n]*task-result index[^\n]*(?:status[^\n]*signals|signals[^\n]*status)/i,
    'manual insight sweep must use only accepted criteria and compact task-index status/signals');
  assert.match(checklist, /manifest[^\n]*criteria|criteria[^\n]*manifest/i,
    'review checklist must name manifest-backed criteria evidence');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  assert.match(step2, /Manifest-backed autopilot[\s\S]*criteria-only[\s\S]*task-result index/i);
  assert.match(step2, /Manual\/no-manifest[\s\S]*accepted criteria artifact[\s\S]*compact status and `signals`/i);
  const autopilotBlocks = [...text.matchAll(/\*\*(?:Manifest-backed )?Autopilot[^]*?(?=\n\*\*(?:Manual|Gear)|\n###|\Z)/g)]
    .map((match) => match[0]).join('\n');
  assert.doesNotMatch(autopilotBlocks, /(?:must|always) (?:load|read|locate)[^\n.]{0,60}(?:full )?spec/i,
    'review autopilot prose must never require the undeclared full spec');
  assert.doesNotMatch(autopilotBlocks, /(?:must|always) (?:load|read)[^\n.]{0,60}(?:progress )?ledger/i,
    'review autopilot prose must never require the undeclared progress ledger');
});

test('implement: autopilot resolves exact task standards from manifest routing evidence', () => {
  const protocol = readFileSync(join(skillsDir, 'implement', 'autopilot-protocol.md'), 'utf8');
  assert.match(protocol, /onDemand[\s\S]{0,240}routing/i);
  assert.match(protocol, /exact registered standard path/i);
  assert.match(protocol, /never (?:guess|manufacture)/i);
  assert.match(protocol, /<exact-standard-path-from-routing>/);
  assert.match(protocol, /repeat `--standard`|repeat --standard/i);
  assert.match(protocol, /core[^.]*mini-routing[\s\S]{0,220}matching (?:leaf|leaves)/i);
  assert.doesNotMatch(protocol, /--standard \.apex\/standards\/<(?:surface|relevant-surface)>\.md/);
  assert.match(protocol, /manifest\.contract\.(?:verdict|gear|drive)/,
    'manifest-backed implement must take scalars from manifest.contract');
  const autopilotBranch = protocol.match(/\*\*Manifest-backed autopilot:[\s\S]*?(?=\n\*\*)/)?.[0];
  assert.ok(autopilotBranch, 'autopilot-protocol.md needs an explicit manifest-backed branch');
  assert.doesNotMatch(autopilotBranch, /(?:must|always) (?:read|locate)[^.]*spec/i);
  assert.match(protocol, /spec[^.]*`onDemand`[\s\S]{0,180}concrete (?:named )?(?:missing fact|insufficiency)/i,
    'implement may read the onDemand spec only for concrete insufficiency');

  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
  assert.match(step0, /Manual\/no-manifest[\s\S]*accepted plan/i);
});

test('review: deterministic capture keeps verbatim evidence on disk behind a bounded receipt', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  assert.match(step2, /capture-review-evidence\.mjs/);
  assert.match(step2, /--evidence '<evidence-path>'[^\n]*--test-command '<exact surface test command>'/);
  assert.match(step2, /--verifier-command '<exact verifier command>'/);
  assert.match(step2, /verbatim output[^.]*on disk|verbatim[^.]*proof/i);
  assert.match(step2, /bounded JSON receipt/i);
  assert.match(step2, /do\s+not open or preload the complete `evidence-report\.md`/i);
  assert.match(step2, /smallest exact line or byte range/i);
  assert.match(step2, /stale evidence[^.]*replaced rather than merged/i);
  assert.doesNotMatch(step2, /task\/subagent tool|dispatch the collector|evidence-prompt\.md/i);
  assert.equal(existsSync(join(skillsDir, 'review', 'evidence-prompt.md')), false);
});

test('implement: ships an implementer prompt that dispatches the surface agent under TDD', () => {
  const path = join(skillsDir, 'implement', 'implementer-prompt.md');
  assert.ok(existsSync(path), 'implement must ship implementer-prompt.md');
  const text = readFileSync(path, 'utf8');
  assert.match(text, /-agent/, 'implementer prompt must dispatch the <surface>-agent');
  assert.match(text, /testing-and-checklist\.md|test command/i,
    'implementer prompt must reference the surface test command');
  assert.match(text, /STOP/, 'implementer prompt must keep a red-flag STOP signal');
  assert.match(text, /failing test/, 'implementer prompt must keep the TDD failing-test discipline');
});

test('implement: implementer prompt requires recording a discovery-vs-specified occurrence as a concern', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'implementer-prompt.md'), 'utf8');
  const durable = sectionBetween(text, '## Durable report and response');
  assert.match(durable, /discover\*\*[\s\S]{0,120}rather than execute what the brief specified/i,
    'the prompt must name the discover-vs-specified occurrence');
  assert.match(durable, /record\s+that occurrence in \[REPORT_FILE\][\s\S]{0,80}flag it as a concern[\s\S]{0,40}DONE_WITH_CONCERNS/i,
    'the occurrence must be recorded in the report file and flagged via DONE_WITH_CONCERNS');

  // M3 (final-review): NEEDS_CONTEXT and DONE_WITH_CONCERNS must not fire on the same trigger.
  assert.match(durable, /cannot resolve by reading the repository[\s\S]{0,120}NEEDS_CONTEXT/i,
    'ambiguity unresolvable from the repository routes to NEEDS_CONTEXT');
  assert.match(durable, /did close by discovering[\s\S]{0,140}DONE_WITH_CONCERNS/i,
    'a gap the implementer did close by discovering routes to DONE_WITH_CONCERNS');
  assert.match(text, /DONE \| DONE_WITH_CONCERNS \| BLOCKED \| NEEDS_CONTEXT/,
    'the status enum stays exactly as it is');
});

test('implement: ships a hub-aware task-reviewer prompt', () => {
  const text = reviewerBody('implement', 'task-reviewer-prompt.md');
  assert.match(text, /spec compliance/i, 'task-reviewer must check spec compliance');
});

test('implement: ships a whole-branch final-review prompt', () => {
  const path = join(skillsDir, 'implement', 'final-review-prompt.md');
  assert.ok(existsSync(path), 'implement must ship final-review-prompt.md');
  const text = readFileSync(path, 'utf8');
  for (const marker of ['Status', 'Approved', 'Issues Found']) {
    assert.ok(text.includes(marker), `final-review-prompt.md must define output marker '${marker}'`);
  }
  assert.match(text, /whole-branch|cross-task|all tasks/i,
    'final review must be whole-branch in scope');
});

test('implement: wires implementer -> task review -> final review -> handoff, in order', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const iImpl = text.indexOf('implementer-prompt.md');
  const iTask = text.indexOf('task-reviewer-prompt.md');
  const iFinal = text.indexOf('final-review-prompt.md');
  const iHandoff = text.indexOf('next step is the `review` skill');
  assert.ok(iImpl !== -1 && iTask !== -1 && iFinal !== -1 && iHandoff !== -1,
    'SKILL must cite all three prompts and the abstract `review` skill handoff');
  assert.ok(iImpl < iTask, 'implementer dispatch must precede the task review');
  assert.ok(iTask < iFinal, 'task review must precede the whole-branch final review');
  assert.ok(iFinal < iHandoff, 'final review must precede the `review` skill handoff');
});

test('shipped workflow handoffs use namespaced slash invocations', () => {
  const shippedInstructionFiles = [
    'skills/brainstorm/SKILL.md',
    'skills/plan/SKILL.md',
    'skills/implement/SKILL.md',
    'skills/implement/final-review-prompt.md',
    // terminal review emits only its human envelope; loop-engineer still hands off to review
    'skills/loop-engineer/SKILL.md',
    'skills/loop-engineer/loop-implementer-prompt.md',
    'skills/loop-engineer/loop-final-review-prompt.md',
    'templates/project-bootstrap-skill.md',
  ];

  for (const relativePath of shippedInstructionFiles) {
    const text = readFileSync(join(root, relativePath), 'utf8');
    assertNoBareWorkflowInvocations(text, relativePath);
  }
});

test('implement: gates commits, keeps the ledger under .apex/work/tasks/, runs sequentially', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  assert.match(text, /\.apex\/work\/tasks\//, 'SKILL must place the progress ledger under .apex/work/tasks/');
  assert.match(text, /commit/i, 'SKILL must address per-task commit authorization');
  assert.match(text, /sequential/i, 'SKILL must state sequential execution');
});

test('loop-engineer: valid gear-4 chain skill — frontmatter, Checklist, Step 0, both prompts wired', () => {
  const path = join(skillsDir, 'loop-engineer', 'SKILL.md');
  assert.ok(existsSync(path), 'loop-engineer/SKILL.md should exist');
  const text = readFileSync(path, 'utf8');
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fmMatch, 'loop-engineer should have YAML frontmatter');
  const fm = fmMatch[1];
  assert.match(fm, /name:\s*loop-engineer\b/, 'frontmatter name must be loop-engineer');
  assert.match(fm, /user-invocable:\s*true/, 'loop-engineer must be user-invocable');
  assert.match(fm, /argument-hint:/, 'loop-engineer frontmatter must declare argument-hint (seeds the goal field)');
  assert.match(text, /## Checklist/, 'loop-engineer must carry a ## Checklist');
  assert.match(text, /### Step 0 — Read the gear/, 'loop-engineer must read the gear at Step 0');
  assert.ok(text.includes('loop-implementer-prompt.md'), 'loop-engineer must cite the implementer prompt');
  assert.ok(text.includes('loop-final-review-prompt.md'), 'loop-engineer must cite the final-review prompt');
});

test('loop-engineer: Step 0 proceeds only on an exact complete ratified contract and otherwise refuses before autonomy', () => {
  const text = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  const step0 = sectionBetween(text, '### Step 0 — Read the gear', '### Step 1');
  // existing locks kept green under the four-outcome rewrite
  assert.match(step0, /goal contract|goal\.md/, 'Step 0 must read the goal contract artifact');
  assert.match(step0, /required:[^]*goal: <goal-path>/, 'Step 0 must require the exact goal capability');
  assert.match(step0, /gear[\s:`-]*4/i, 'Step 0 must gate on gear 4');
  assert.match(step0, /refuse/i, 'Step 0 must refuse on a non-gear-4 artifact');
  assert.match(step0, /never recompute/i, 'Step 0 must never recompute the gear inline');
  assert.match(step0, /never fabricate/i, 'Step 0 must never fabricate a field value');
  assert.match(step0, /absent[\s\S]{0,180}refuse|missing[\s\S]{0,180}refuse/i,
    'missing or partial contracts must refuse');
  assert.match(step0, /before any iteration, branch mutation, or commit question/i,
    'refusal must precede every autonomous or mutating action');
  assert.match(step0, /navigation and semantic-skill routing only/i,
    'Step 0 must preserve the approved bootstrap boundary');
  assert.doesNotMatch(step0, /auto-chain|completion interview|writes\/completes `goal\.md`/i,
    'Step 0 must not restore the retired bootstrap ceremony branch');
});

test('loop-engineer: Step 1 missing-field routes back to the Step 0 refusal', () => {
  const text = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  const step1 = sectionBetween(text, '### Step 1', '### Step 2');
  assert.match(step1, /mandatory field/i, 'Step 1 must keep the mandatory-field list');
  assert.match(step1, /Step 0/, 'a missing mandatory field must route back to Step 0');
  assert.match(step1, /refusal/i, 'a missing mandatory field routes to the Step 0 refusal');
  assert.doesNotMatch(step1, /auto-chain|completion interview/i, 'missing fields never start hidden authoring');
});

test('loop-engineer: delegates the deterministic run to the packaged controller and emits its review capability', () => {
  const text = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  assert.match(text, /node <engine-root>\/scripts\/loop-engineer\.mjs --repo-root \. --goal '<goal-path>' --harness '<active-harness>' --commit-authorized/);
  assert.match(text, /fresh[^]*omits `--resume` and `--ledger`/i);
  assert.match(text, /--resume --ledger '<loop-ledger-path>'/);
  assert.match(text, /active supported harness[^]*`adapters\/headless\.mjs`/i);
  assert.match(text, /runner-unavailable[^]*(?:stop|refuse)/i);
  assert.match(text, /controller output[^]*`status`[^]*`runId`[^]*`terminal`[^]*`goal`[^]*`loop-ledger`/i);
  assert.match(text, /validated terminal result[^]*exact returned paths[^]*canonical\s+Gear-4 review handoff/i);
  assert.doesNotMatch(text, /For iteration `i` from 1 to `budget`/);
  assert.doesNotMatch(text, /run at most \*\*2 fix passes beyond the budget\*\*/i);
  assert.doesNotMatch(text, /append one line: iteration/i);
  assert.doesNotMatch(text, /perform this review yourself in a fresh dedicated pass/i);
});

test('loop-engineer: closes exact target routing, ordered standards, and concrete model tiers into the CLI boundary', () => {
  const skill = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  const step1 = sectionBetween(skill, '### Step 1', '### Step 2');
  const step2 = sectionBetween(skill, '### Step 2', '### Step 3');
  assert.match(step1, /exact routing row/i);
  assert.match(step1, /single-file[^]*exact registered standard/i);
  assert.match(step1, /modular[^]*core[^]*matching leaves[^]*table order/i);
  assert.match(step1, /zero matches[^]*core only/i);
  assert.match(step1, /never (?:synthesize|manufacture)[^]*\.apex\/standards\/<surface>\.md/i);
  assert.match(step2, /--routing-index '\.apex\/_INDEX\.md'/u);
  assert.match(step2, /--standard '<exact-standard-path>'/u);
  assert.match(step2, /repeat[^]*--standard[^]*order/i);

  for (const file of ['loop-implementer-prompt.md', 'loop-final-review-prompt.md']) {
    const prompt = readFileSync(join(skillsDir, 'loop-engineer', file), 'utf8');
    assert.match(prompt, /^\s*model: \[MODEL_TIER\](?:\s+#.*)?$/mu, `${file}: concrete tier placeholder`);
    assert.match(prompt, /\[ROUTING_INDEX\]/u, `${file}: routed index placeholder`);
    assert.match(prompt, /\[STANDARD_INPUTS\]/u, `${file}: ordered standard inventory placeholder`);
    assert.doesNotMatch(prompt, /\.apex\/standards\/\[SURFACE\]\.md|\.apex\/standards\/<surface>\.md/u,
      `${file}: no synthesized standard path`);
  }
});

test('loop-engineer: the skill authorizes and routes but never becomes the state controller', () => {
  const text = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  const boundary = sectionBetween(text, '### Controller responsibility boundary', '### Step 0');
  for (const phrase of [
    'allocate attempts',
    'keep/discard policy',
    'interpret ledger Markdown as state',
    'perform Git recovery',
    'grant extra fixes',
    'inline runner fallback',
  ]) {
    assert.ok(boundary.includes(phrase), `controller boundary must prohibit: ${phrase}`);
  }
  assert.match(boundary, /scripts own deterministic state/i);
  assert.match(text, /Authorize controller-owned commits for this run\?/);
  assert.match(text, /boolean and metric[^.]*require `yes`/i);
  assert.match(text, /ask exactly once[^.]*before[^.]*controller/i);
  const resultHandling = sectionBetween(text, '### Step 3', '## Model Selection');
  assert.match(resultHandling, /do not (?:open|read|parse)[^]*goal or ledger[^]*lifecycle/i,
    'the skill must not recover controller state from Markdown projections');
  assert.match(resultHandling, /fail[^]*only[^]*result[^/]*path mismatch/i,
    'the skill must fail closed only on controller result/path mismatch');
  assert.doesNotMatch(resultHandling, /verify[^]*(?:goal[^]*`CONSUMED`|ledger[^]*`READY`)/i,
    'the skill must not independently verify terminal lifecycle markers');
});

test('loop-engineer: ships a loop-implementer prompt that dispatches the surface agent', () => {
  const path = join(skillsDir, 'loop-engineer', 'loop-implementer-prompt.md');
  assert.ok(existsSync(path), 'loop-engineer must ship loop-implementer-prompt.md');
  const text = readFileSync(path, 'utf8');
  assert.match(text, /-agent/, 'the loop implementer prompt must dispatch the <surface>-agent');
  assert.match(text, /STOP/, 'the loop implementer prompt must keep a red-flag STOP signal');
  assert.match(
    text,
    /DONE\s*\|\s*DONE_WITH_CONCERNS\s*\|\s*BLOCKED\s*\|\s*NEEDS_CONTEXT/,
    'the loop implementer prompt must define the status enum'
  );
  assert.match(text, /run-<run-id>-attempt-<attempt>-report\.md/, 'the loop implementer prompt must use the controller-owned immutable attempt report path');
  assert.match(text, /blast[ -]radius/i, 'the loop implementer prompt must constrain the implementer to the blast radius');
  assert.match(text, /goal contract/i, 'the loop implementer prompt must brief the implementer with the goal contract');
  assert.match(text, /[Nn]ever commit/, 'the implementer must never commit — the controller commits after the verifier decides keep/discard');
  assert.match(text, /never run Git|no Git/i, 'the implementer must not perform Git operations');
  assert.doesNotMatch(text, /Commit authorized/i, 'commit authorization is controller state and must not be delegated to the implementer');
  assert.match(text, /exactly four fields/i);
  assert.match(text, /status: DONE \| DONE_WITH_CONCERNS \| BLOCKED \| NEEDS_CONTEXT\n\s*artifact: \[REPORT_FILE\]\n\s*changed-paths: <comma-separated repo-relative paths or none>\n\s*signals: <short machine-readable IDs or none>/);
});

test('non-regression: the implementer status enum stays exactly DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT across glossary, implementer-prompt, implement SKILL, and loop-implementer-prompt', () => {
  const glossary = readFileSync(join(root, '.apex', 'glossary.md'), 'utf8');
  assert.match(glossary, /`DONE \| DONE_WITH_CONCERNS \| BLOCKED \| NEEDS_CONTEXT` enum/,
    'glossary "Implementer status" entry must keep the exact enum unchanged');

  const implementerPrompt = readFileSync(join(skillsDir, 'implement', 'implementer-prompt.md'), 'utf8');
  assert.match(implementerPrompt, /Allowed status values are\s*\n\s*DONE \| DONE_WITH_CONCERNS \| BLOCKED \| NEEDS_CONTEXT\./,
    'implementer-prompt.md must keep the exact enum sentence unchanged');

  const implementSkill = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  assert.match(implementSkill, /Implementer\/fix statuses are `DONE`,\s*\n`DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`/,
    'implement/SKILL.md must keep the exact enum sentence unchanged');

  const loopImplementerPrompt = readFileSync(join(skillsDir, 'loop-engineer', 'loop-implementer-prompt.md'), 'utf8');
  assert.match(loopImplementerPrompt, /\*\*Status:\*\* DONE \| DONE_WITH_CONCERNS \| BLOCKED \| NEEDS_CONTEXT/,
    'loop-implementer-prompt.md must keep the exact enum sentence unchanged');
});

test('loop-engineer: ships a whole-branch loop final-review prompt over the goal contract', () => {
  const text = reviewerBody('loop-engineer', 'loop-final-review-prompt.md');
  assert.match(text, /whole-branch|loop branch|entire loop/i, 'the loop final review must be whole-branch in scope');
  assert.match(text, /goal contract/i, 'the loop final review must use the goal contract as the criterion');
  assert.match(text, /run-<run-id>-review-<review>-report\.md/, 'the reviewer must write the immutable controller-owned review report');
  assert.match(text, /read-only/i);
  assert.match(text, /never run Git|no Git/i);
  assert.match(text, /exactly four fields/i);
  assert.match(text, /status: DONE\n\s*artifact: <controller-supplied report path>\n\s*changed-paths: none\n\s*signals: approved \| issues-found/);
});

const WHOLE_BRANCH_REVIEW_SENTENCE = 'The whole-branch review runs at the reviewer tier — `standard`, rising to `most-capable` when the branch is large or subtle — not at whatever model the harness happens to offer.';

const MODEL_SECTION_WITH_REVIEW = `## Model Selection

Always set \`model:\` explicitly when dispatching a subagent. An omitted model inherits the session model (usually the most capable and most expensive) and silently defeats this policy.

Pick the tier by task complexity and risk:

| Signal | Tier |
|--------|------|
| Mechanical / transcription (1-2 files, complete spec) | cheap |
| Integration / multi-file / judgment | standard |
| Design / architecture / high-risk or subtle change | most-capable |

Reviewers floor at **standard** and rise to **most-capable** when the artifact is high-risk or subtle.

**Turn count beats token price.** The cheapest model often takes 2-3× the turns on multi-step work — more wall-clock and context overall. Make a mid-tier model the floor for reviewers and for implementers working from prose; reserve the cheapest tier for transcription tasks whose exact code the plan already contains.

Translate the tier to a concrete model by judgment at dispatch time using your harness's available models. The three tiers are the whole ladder — \`most-capable\` is its top rung, not an open-ended "best available". A model that sits above that rung is outside the ladder: never reach it from a tier, and record a one-line reason in the ledger when you override to it. The whole-branch review runs at the reviewer tier — \`standard\`, rising to \`most-capable\` when the branch is large or subtle — not at whatever model the harness happens to offer. On a harness without per-dispatch model choice, everything runs on the session model — record that in the ledger.`;

const MODEL_SECTION_WITHOUT_REVIEW = `## Model Selection

Always set \`model:\` explicitly when dispatching a subagent. An omitted model inherits the session model (usually the most capable and most expensive) and silently defeats this policy.

Pick the tier by task complexity and risk:

| Signal | Tier |
|--------|------|
| Mechanical / transcription (1-2 files, complete spec) | cheap |
| Integration / multi-file / judgment | standard |
| Design / architecture / high-risk or subtle change | most-capable |

Reviewers floor at **standard** and rise to **most-capable** when the artifact is high-risk or subtle.

**Turn count beats token price.** The cheapest model often takes 2-3× the turns on multi-step work — more wall-clock and context overall. Make a mid-tier model the floor for reviewers and for implementers working from prose; reserve the cheapest tier for transcription tasks whose exact code the plan already contains.

Translate the tier to a concrete model by judgment at dispatch time using your harness's available models. The three tiers are the whole ladder — \`most-capable\` is its top rung, not an open-ended "best available". A model that sits above that rung is outside the ladder: never reach it from a tier, and record a one-line reason in the ledger when you override to it. On a harness without per-dispatch model choice, everything runs on the session model — record that in the ledger.`;

function modelSection(name) {
  const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
  const start = text.indexOf('## Model Selection');
  assert.ok(start !== -1, `${name} must contain a ## Model Selection section`);
  let rest = text.slice(start);
  const next = rest.indexOf('\n## ', 1);
  if (next !== -1) rest = rest.slice(0, next);
  return rest.trimEnd();
}

test('the five chain skills carry the canonical Model Selection block (with/without the whole-branch-review sentence)', () => {
  for (const s of ['implement', 'review']) {
    assert.equal(modelSection(s), MODEL_SECTION_WITH_REVIEW, `${s} Model Selection block must keep the whole-branch-review sentence`);
  }
  for (const s of ['brainstorm', 'plan', 'loop-engineer']) {
    assert.equal(modelSection(s), MODEL_SECTION_WITHOUT_REVIEW, `${s} Model Selection block must drop the whole-branch-review sentence`);
  }
});

test('SC7: the whole-branch-review sentence is absent in brainstorm/plan/loop-engineer and present in implement/review', () => {
  for (const s of ['brainstorm', 'plan', 'loop-engineer']) {
    const text = readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8');
    assert.ok(!text.includes(WHOLE_BRANCH_REVIEW_SENTENCE), `${s} must not carry the whole-branch-review sentence`);
  }
  for (const s of ['implement', 'review']) {
    const text = readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8');
    assert.ok(text.includes(WHOLE_BRANCH_REVIEW_SENTENCE), `${s} must carry the whole-branch-review sentence`);
  }
});

test('SC8: autopilot-protocol.md exists, is harness-neutral, and is named only under the drive: autopilot branch', () => {
  const protocolPath = join(skillsDir, 'implement', 'autopilot-protocol.md');
  assert.ok(existsSync(protocolPath), 'implement must ship autopilot-protocol.md');
  const protocol = readFileSync(protocolPath, 'utf8');
  assert.doesNotMatch(protocol, /CLAUDE_/, 'autopilot-protocol.md must be free of CLAUDE_* references');
  assert.doesNotMatch(protocol, /\/Users\/|\/home\/|~\//, 'autopilot-protocol.md must be free of machine-specific absolute paths');

  const skill = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const offenders = [];
  for (const para of skill.split(/\n\n+/)) {
    if (para.includes('autopilot-protocol.md') && !/drive:\s*autopilot/i.test(para)) {
      offenders.push(para.slice(0, 120));
    }
  }
  assert.deepEqual(offenders, [], 'autopilot-protocol.md may be named only under the drive: autopilot branch');
});

test('every reviewer prompt sets an explicit model tier (never a bare general-purpose dispatch)', () => {
  const prompts = [
    ['implement', 'task-reviewer-prompt.md'],
    ['implement', 'final-review-prompt.md'],
    ['loop-engineer', 'loop-final-review-prompt.md'],
  ];
  for (const [name, file] of prompts) {
    const text = readFileSync(join(skillsDir, name, file), 'utf8');
    const pattern = name === 'loop-engineer'
      ? /model:\s*\[MODEL_TIER\]/u
      : /model:\s*(cheap|standard|most-capable)\b/u;
    assert.match(text, pattern, `${name}/${file} must set an explicit controller-resolved model tier`);
  }
});

test('reviewer prompts use abstract tiers only — no concrete model ids (single alias source)', () => {
  // The tier vocabulary (cheap/standard/most-capable) is the canonical abstraction —
  // concrete model choice is deferred to dispatch time per harness (see the Model
  // Selection block in the workflow SKILLs, locked identical by the test above).
  // Reviewer prompts must reference tiers only, so a future model rename touches
  // nothing here.
  const prompts = [
    ['implement', 'task-reviewer-prompt.md'],
    ['implement', 'final-review-prompt.md'],
    ['loop-engineer', 'loop-final-review-prompt.md'],
  ];
  for (const [name, file] of prompts) {
    const text = readFileSync(join(skillsDir, name, file), 'utf8');
    assert.doesNotMatch(
      text,
      /\b(haiku|sonnet|opus)\b/,
      `${name}/${file} must not hardcode a concrete model id — use the abstract tier`
    );
  }
});

test('the four non-loop prompt templates keep the D1 harness-neutral dispatch conditional and drop general-purpose', () => {
  const prompts = [
    ['implement', 'implementer-prompt.md'],
    ['implement', 'task-reviewer-prompt.md'],
    ['implement', 'final-review-prompt.md'],
    ['discovery', 'explore-surface-prompt.md'],
  ];
  for (const [name, file] of prompts) {
    const text = readFileSync(join(skillsDir, name, file), 'utf8');
    assert.doesNotMatch(
      text,
      /general-purpose/,
      `${name}/${file} must not name the Claude-specific general-purpose agent type`
    );
    assert.match(
      text,
      /harness (provides|has) (a |no )?task(\/subagent)? tool/i,
      `${name}/${file} must gain the D1 harness-neutral dispatch conditional (mirrors T3/T4)`
    );
    assert.match(
      text,
      /otherwise|inline/i,
      `${name}/${file} must state the inline fallback for a harness with no task tool`
    );
    assert.match(
      text,
      /degradation/i,
      `${name}/${file} must state the degradation is recorded (ledger/run output)`
    );
    assert.doesNotMatch(
      text,
      /\/steepy-apex:/,
      `${name}/${file} must hand off to the next skill abstractly (e.g. "the \`review\` skill"), ` +
        'never via a hardcoded /steepy-apex: slash form — see T3/T4 SKILL.md handoff style'
    );
  }
});

test('loop prompt templates are controller-invoked role contracts with no inline-runner fallback', () => {
  for (const file of ['loop-implementer-prompt.md', 'loop-final-review-prompt.md']) {
    const text = readFileSync(join(skillsDir, 'loop-engineer', file), 'utf8');
    assert.match(text, /packaged deterministic controller/i);
    assert.doesNotMatch(text, /otherwise run .* inline|perform .* yourself inline/i);
    assert.doesNotMatch(text, /general-purpose/);
    assert.doesNotMatch(text, /\/steepy-apex:/);
  }
});

function sectionBetween(text, startHeading, endHeading) {
  const s = text.indexOf(startHeading);
  assert.ok(s !== -1, `missing heading '${startHeading}'`);
  const e = endHeading ? text.indexOf(endHeading, s + startHeading.length) : -1;
  return e === -1 ? text.slice(s) : text.slice(s, e);
}

// Content-contract checks, NOT a runtime manual parser or proof of model obedience.
function contractRows(text, heading) {
  const section = sectionBetween(text, heading);
  const table = section.match(/^\| .*(?:\n\|.*)*/m)?.[0];
  assert.ok(table, `missing contract table: ${heading}`);
  return table.split('\n').filter((line) => line.startsWith('| '))
    .slice(2).map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()));
}

// Fixture validator for the documented content contract only. It deliberately does not model or
// enforce manual skill execution.
function assertFreshBrainstormRoutingFixture(fixture) {
  const registeredPaths = new Map(
    fixture.routingRows.split('\n').map((row) => {
      const match = row.match(/^\| `([^`]+)` \| \[[^\]]+\]\(([^)]+)\) \|/);
      assert.ok(match, `invalid fixture routing row: ${row}`);
      return [match[1], `.apex/${match[2]}`];
    }),
  );
  for (const synthesizedPath of fixture.absentSynthesizedPaths) {
    assert.ok(!fixture.existingPaths.includes(synthesizedPath), `${synthesizedPath} must be absent`);
  }

  for (const routeCase of [fixture.single, ...fixture.modular.cases]) {
    const { taskEvidence } = routeCase;
    assert.ok(taskEvidence.paths.length > 0 && taskEvidence.topics.length > 0);
    const registeredPath = registeredPaths.get(taskEvidence.surface);
    assert.ok(registeredPath, `missing fixture route for ${taskEvidence.surface}`);
    assert.ok(fixture.existingPaths.includes(registeredPath));

    const miniRouting = taskEvidence.surface === fixture.modular.surface
      ? fixture.modular.miniRouting
      : [];
    const expectedLeaves = miniRouting.filter(({ when }) => (
      when.pathPrefixes.some((prefix) => taskEvidence.paths.some((path) => path.startsWith(prefix)))
      || when.topics.some((topic) => taskEvidence.topics.includes(topic))
    )).map(({ path }) => (
      `${registeredPath.slice(0, registeredPath.lastIndexOf('/') + 1)}${path}`
    ));
    const expectedPaths = [registeredPath, ...expectedLeaves];
    assert.deepEqual(routeCase.declaredSelection.map(({ path }) => path), expectedPaths);
    assert.ok(routeCase.declaredSelection.every(({ path, reason }) => (
      fixture.existingPaths.includes(path) && reason.length > 0
    )));
    assert.equal(routeCase.readAllFallback, false);
    for (const synthesizedPath of fixture.absentSynthesizedPaths) {
      assert.ok(!routeCase.declaredSelection.some(({ path }) => path === synthesizedPath));
    }
  }
}

function assertRegularReviewBumpFixture(fixture) {
  assert.deepEqual(Object.keys(fixture.inputs), ['criteria', 'task-results', 'branch-diff']);
  assert.ok(!('spec' in fixture.inputs), 'regular-review bump fixtures must not gain a full spec');
  const explicitBreakingEvidence = [
    /Release impact:\s*breaking change/i.test(fixture.inputs.criteria),
    /signals:\s*[^\n;]*\brelease:breaking\b/i.test(fixture.inputs['task-results']),
    /^\+.*BREAKING CHANGE:/im.test(fixture.inputs['branch-diff']),
  ];
  const derivedAction = explicitBreakingEvidence.every(Boolean) ? 'major' : 'ask-human';
  assert.equal(fixture.declaredAction, derivedAction);
}

test('manual publication contract covers each exact resume capability and every interruption prefix', () => {
  const expectedRoutes = [
    ['plan', 'spec', 'output-plan', 'none', 'brainstorm', 'plan', 'implement'],
    ['implement-2-direct', 'spec', 'task-results', 'progress-ledger', 'brainstorm', 'implement', 'none'],
    ['implement-2-plan', 'plan', 'task-results', 'source-spec,progress-ledger', 'plan', 'implement', 'none'],
    ['implement-3', 'plan', 'task-results', 'source-spec,progress-ledger', 'plan', 'implement', 'review'],
    ['review-3', 'task-results', 'review-report', 'criteria,branch-diff', 'implement', 'review', 'none'],
  ];
  const allowed = new Map([
    ['READY/absent', 'fresh-create'], ['READY/DRAFT', 'resume-work'],
    ['READY/READY', 'finish-consumption'], ['CONSUMED/READY', 'no-op'],
  ]);
  const expectedStates = [];
  for (const input of ['absent', 'DRAFT', 'READY', 'CONSUMED']) {
    for (const output of ['absent', 'DRAFT', 'READY', 'CONSUMED']) {
      expectedStates.push([input, output, allowed.get(`${input}/${output}`) ?? 'reject']);
    }
  }
  for (const name of ['brainstorm', 'plan', 'implement', 'review', 'loop-engineer']) {
    const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    assert.deepEqual(contractRows(text, '### Exact publication pairs'), expectedRoutes, name);
    assert.deepEqual(contractRows(text, '### Publication interruption prefixes'), expectedStates, name);
    const common = sectionBetween(text, '## Manual handoff envelope', '<!-- steepy:manual-handoff:v1:end -->');
    assert.match(common, /output\.source[^]*input path[^]*input\.consumed-by[^]*output path/i);
    assert.match(common, /before[^]*fresh-only READY[^]*gate/i);
    assert.match(common, /finish-consumption[^]*revalidate[^]*approval[^]*verification[^]*only[^]*input-consumption/i);
    assert.match(common, /no-op[^]*revalidate[^]*no[^]*redispatch/i);
    assert.match(common, /missing[^]*capabilit[^]*mismatch[^]*fail closed/i);
    assert.match(common, /model-based[^]*no manual parser[^]*content tests[^]*deterministic enforcement/i);
  }
});

test('phase-local entry and publication rules admit only verified exact-pair recovery', () => {
  for (const [name, role] of [['plan', 'output-plan'], ['implement', 'task-results'], ['review', 'review-report']]) {
    const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
    assert.ok(step0.includes(`onDemand.${role}`), `${name} resume explicitly binds its output`);
    assert.match(step0, /before[^]*fresh-only[^]*gate/i, name);
    assert.match(step0, /CONSUMED[^]*READY[^]*no-op/i, name);
    assert.match(step0, /READY[^]*READY[^]*finish-consumption/i, name);
  }
  const review = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step4 = sectionBetween(review, '### Step 4', '### Step 5');
  assert.match(step4, /phase: review\nstatus: DRAFT\nnext: none\nsource: <task-result-index-path>\nconsumed-by: none/);
  assert.match(step4, /first[^]*report[^]*`status: READY`[^]*then[^]*index[^]*`status: CONSUMED`/i);
  assert.doesNotMatch(readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8'), /Perform both edits together/i);
  for (const name of ['plan', 'implement']) {
    const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    assert.match(text, /record[^]*approval[^]*verification[^]*before[^]*READY/i, name);
  }
});

test('fresh brainstorm derives coverage and ratifies every gear without historical work reads', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
  assert.match(step0, /fresh entry[^]*human request[^]*stable[^]*repository/i);
  assert.match(step0, /no[^]*historical[^]*spec[^]*log[^]*verdict/i);
  assert.doesNotMatch(step0, /Read the verdict artifact[^]*spec head|Artifact absent and full gear-3|upstream workflow chain first/i);
  assert.match(step0, /Gear 3[^]*valid[^]*fresh entry/i);
  const step1 = sectionBetween(text, '### Step 1 —', '### Step 1.5');
  assert.match(step1, /exact[^]*routing[^]*single-file[^]*modular core/i);
  assert.match(step1, /every matching leaf[^]*reason[^]*zero matches[^]*core only/i);
  assert.doesNotMatch(step1, /Read the owning surface standard `\.apex\/standards\/<surface>\.md`/i);
  const step4 = sectionBetween(text, '### Step 4 —', '### Step 5 —');
  assert.ok(/existing target[^]*stop[^]*no[^]*read[^]*overwrite/i.test(step4), 'fresh brainstorm must not reuse a historical draft');
});

test('fresh brainstorm routing fixture selects registered custom/core paths and only reason-matched leaves', () => {
  const fixture = {
    routingRows: [
      '| `payments` | [Payment policy](standards/domain/payment-policy.md) | `payments-agent` | — |',
      '| `editor` | [Editor core](standards/editor/core.md) | `editor-agent` | — |',
    ].join('\n'),
    existingPaths: [
      '.apex/standards/domain/payment-policy.md',
      '.apex/standards/editor/core.md',
      '.apex/standards/editor/api.md',
      '.apex/standards/editor/style.md',
      '.apex/standards/editor/storage.md',
    ],
    absentSynthesizedPaths: ['.apex/standards/payments.md', '.apex/standards/editor.md'],
    single: {
      taskEvidence: {
        surface: 'payments',
        paths: ['services/payments/refunds.mjs'],
        topics: ['payment policy'],
      },
      declaredSelection: [
        { path: '.apex/standards/domain/payment-policy.md', reason: 'exact single-file routing link' },
      ],
      readAllFallback: false,
    },
    modular: {
      surface: 'editor',
      miniRouting: [
        {
          path: 'api.md',
          when: { pathPrefixes: ['editor/api/'], topics: ['public API'] },
        },
        {
          path: 'style.md',
          when: { pathPrefixes: ['editor/ui/'], topics: ['visual styling'] },
        },
        {
          path: 'storage.md',
          when: { pathPrefixes: ['editor/storage/'], topics: ['storage migration'] },
        },
      ],
      cases: [
        {
          taskEvidence: {
            surface: 'editor',
            paths: ['editor/api/routes.mjs', 'editor/storage/migrations/003.sql'],
            topics: ['storage migration'],
          },
          declaredSelection: [
            { path: '.apex/standards/editor/core.md', reason: 'registered modular core' },
            { path: '.apex/standards/editor/api.md', reason: 'task path matches editor/api/' },
            { path: '.apex/standards/editor/storage.md', reason: 'task path/topic matches storage' },
          ],
          readAllFallback: false,
        },
        {
          taskEvidence: {
            surface: 'editor',
            paths: ['docs/editor-release-notes.md'],
            topics: ['release notes'],
          },
          declaredSelection: [
            { path: '.apex/standards/editor/core.md', reason: 'zero leaf matches means core only' },
          ],
          readAllFallback: false,
        },
      ],
    },
  };
  assertFreshBrainstormRoutingFixture(fixture);

  const wrongRoute = structuredClone(fixture);
  wrongRoute.single.declaredSelection[0].path = '.apex/standards/payments.md';
  assert.throws(() => assertFreshBrainstormRoutingFixture(wrongRoute));

  const unrelatedLeaf = structuredClone(fixture);
  unrelatedLeaf.modular.cases[0].declaredSelection[2] =
    { path: '.apex/standards/editor/style.md', reason: 'unrelated leaf' };
  assert.throws(() => assertFreshBrainstormRoutingFixture(unrelatedLeaf));

  const readAllLeaves = structuredClone(fixture);
  readAllLeaves.modular.cases[0].declaredSelection.splice(2, 0,
    { path: '.apex/standards/editor/style.md', reason: 'read-all fallback' });
  readAllLeaves.modular.cases[0].readAllFallback = true;
  assert.throws(() => assertFreshBrainstormRoutingFixture(readAllLeaves));

  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step1 = sectionBetween(text, '### Step 1 —', '### Step 1.5');
  assert.match(step1, /follow the exact standard links in the routing row/i);
  assert.match(step1, /every matching leaf in table order[^]*concrete reason/i);
  assert.match(step1, /Never manufacture[^]*read unrelated leaves[^]*read-all fallback/i);
});

test('publication preflight refuses existing unbound review output before collection and guards unconsumed links', () => {
  const review = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step0 = sectionBetween(review, '### Step 0', '### Ceremony');
  assert.ok(/existing[^]*report[^]*without[^]*capability[^]*stop[^]*before[^]*collection/i.test(step0));
  for (const name of ['brainstorm', 'plan', 'implement', 'review', 'loop-engineer']) {
    const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    const common = sectionBetween(text, '## Manual handoff envelope', '<!-- steepy:manual-handoff:v1:end -->');
    assert.ok(/unconsumed input[^]*consumed-by: none/i.test(common), name);
  }
  const workflow = readFileSync(join(root, 'docs/workflow.md'), 'utf8');
  assert.doesNotMatch(workflow, /chain skills read the gear from the spec's verdict header|review time[^\n]*against the local spec\/plan/i);
});

test('terminal resume shortcuts retain gear and supporting-input provenance checks', () => {
  const implement = sectionBetween(readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8'), '### Step 0', '### Ceremony');
  assert.ok(/every resume[^]*gear[^]*phase[^]*next[^]*before[^]*terminal shortcut/i.test(implement));
  const review = sectionBetween(readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8'), '### Step 0', '### Ceremony');
  assert.ok(/every resume[^]*criteria[^]*branch.diff[^]*metadata[^]*content[^]*before[^]*terminal shortcut/i.test(review));
});

test('regular review derives release proposals only from criteria, compact index and diff', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step5 = sectionBetween(text, '### Step 5', '## Model Selection');
  assert.match(step5, /derive[^]*bump type[^]*criteria[^]*task-result index[^]*branch diff/i);
  assert.doesNotMatch(step5, /derive[^\n]*from the spec/i);
  assert.match(step5, /insufficient[^]*ask[^]*human[^]*no[^]*spec[^]*read/i);
  assert.match(step5, /Ask one confirmation question/);
});

test('regular-review bump fixtures use only authorized inputs for major or human clarification', () => {
  const breakingChange = {
    inputs: {
      criteria: 'SC1: Existing clients receive a migration path. Release impact: breaking change.',
      'task-results': '- Task 1: DONE; artifact: task-1-report.md; changed-paths: src/api.mjs; signals: release:breaking',
      'branch-diff': '- oldApi(request)\n+ newApi(request)\n+ BREAKING CHANGE: remove oldApi',
    },
    declaredAction: 'major',
  };
  const insufficientEvidence = {
    inputs: {
      criteria: 'SC1: Update the public behavior.',
      'task-results': '- Task 1: DONE; artifact: task-1-report.md; changed-paths: src/api.mjs; signals: none',
      'branch-diff': '+ adjust behavior',
    },
    declaredAction: 'ask-human',
  };
  assertRegularReviewBumpFixture(breakingChange);
  assertRegularReviewBumpFixture(insufficientEvidence);

  const missingDiff = structuredClone(breakingChange);
  delete missingDiff.inputs['branch-diff'];
  assert.throws(() => assertRegularReviewBumpFixture(missingDiff));

  const wrongUpstreamInput = structuredClone(breakingChange);
  wrongUpstreamInput.inputs.spec = '# Full spec (unauthorized)';
  assert.throws(() => assertRegularReviewBumpFixture(wrongUpstreamInput));

  const weakenedEvidence = [
    ['criteria', 'SC1: Existing clients receive a documented migration path.'],
    ['task-results', '- Task 1: DONE; artifact: task-1-report.md; changed-paths: src/api.mjs; signals: none'],
    ['branch-diff', '- oldApi(request)\n+ newApi(request)'],
  ];
  for (const [role, replacement] of weakenedEvidence) {
    const mutation = structuredClone(breakingChange);
    mutation.inputs[role] = replacement;
    assert.throws(() => assertRegularReviewBumpFixture(mutation), `${role} evidence must affect derivation`);
  }

  const wrongBump = structuredClone(breakingChange);
  wrongBump.declaredAction = 'minor';
  assert.throws(() => assertRegularReviewBumpFixture(wrongBump));

  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step5 = sectionBetween(text, '### Step 5', '## Model Selection');
  assert.match(step5, /breaking change[^]*`major`/i);
  assert.match(step5, /evidence is insufficient[^]*ask the human/i);
  assert.match(step5, /no spec, plan, ledger, or per-task report read is authorized/i);
});

test('unplanned discovery has an explicit signal preserved through the compact task index', () => {
  const prompt = readFileSync(join(skillsDir, 'implement', 'implementer-prompt.md'), 'utf8');
  assert.match(prompt, /discover[^]*DONE_WITH_CONCERNS[^]*discovery:unplanned/i);
  for (const file of ['SKILL.md', 'autopilot-protocol.md']) {
    const text = readFileSync(join(skillsDir, 'implement', file), 'utf8');
    assert.match(text, /preserve[^]*discovery:unplanned[^]*task-result index/i, file);
    assert.match(text, /ordinary concerns[^]*not[^]*discovery/i, file);
  }
  const review = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const expected = [
    ['DONE_WITH_CONCERNS', 'discovery:unplanned', 'unplanned-discovery'],
    ['DONE_WITH_CONCERNS', 'other-or-none', 'ordinary-or-unattributed-concern'],
    ['DONE', 'discovery:unplanned', 'inconsistent-result'],
    ['DONE', 'other-or-none', 'no-discovery-evidence'],
  ];
  assert.deepEqual(contractRows(review, '### Discovery signal interpretation'), expected);
  assert.match(review, /never infer discovery[^]*DONE_WITH_CONCERNS alone/i);
  for (const path of ['.apex/standards/skills.md', '.apex/conventions.md', 'docs/workflow.md']) {
    const stable = readFileSync(join(root, path), 'utf8');
    assert.ok(stable.includes('discovery:unplanned'), path);
    assert.match(stable, /output[^]*READY[^]*input[^]*CONSUMED/i, path);
  }
});

test('downstream plan and implement read only the accepted artifact gear at Step 0', () => {
  for (const s of ['plan', 'implement']) {
    const text = readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8');
    assert.match(text, /### Step 0 — Read the gear/, `${s} must have a Step 0 gear-read step`);
    assert.match(text, /verdict artifact/i, `${s} Step 0 must reference the verdict artifact`);
    if (s === 'implement') assert.match(text, /accepted plan's contract metadata/i, 'implement takes gear from the accepted plan contract');
    else assert.match(text, /`\.apex\/work\/`/, `${s} Step 0 must locate the verdict artifact under .apex/work/`);
    assert.match(text, /gear-1\/2 work/i, `${s} Step 0 must branch on artifact-absent gear-1/2 recompute`);
    assert.match(text, /recompute the coverage verdict inline/i, `${s} Step 0 must recompute the verdict inline when the artifact is absent for gear-1/2 work`);
    assert.match(text, /do not proceed\s+blind/i, `${s} Step 0 must refuse to proceed blind when full gear-3 ceremony is required and the artifact is absent`);
    assert.match(text, /### Ceremony by gear/, `${s} must have a "Ceremony by gear" subsection`);
    const step0Idx = text.indexOf('### Step 0 — Read the gear');
    const step1Idx = text.indexOf('### Step 1');
    assert.ok(step0Idx !== -1 && step1Idx !== -1 && step0Idx < step1Idx, `${s} Step 0 must precede Step 1`);
  }
});

test('brainstorm, plan, implement: Step 0 bounces gear-4 work to the abstract loop-engineer skill, Ceremony declares it', () => {
  for (const s of ['brainstorm', 'plan', 'implement']) {
    const text = readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8');
    const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
    assert.match(
      step0,
      /gear\W{0,3}4[\s\S]*?`loop-engineer` skill/i,
      `${s} Step 0 must bounce an artifact present with gear 4 to the abstract \`loop-engineer\` skill`
    );
    assert.doesNotMatch(
      step0,
      /\/steepy-apex:/,
      `${s} Step 0 must not use a Claude-only namespaced slash invocation`
    );
    const ceremony = sectionBetween(text, '### Ceremony by gear', '### Step 1');
    assert.match(
      ceremony,
      /Gear 4[\s\S]{0,200}`loop-engineer` skill/i,
      `${s} Ceremony by gear must carry a Gear 4 line bouncing to the abstract \`loop-engineer\` skill`
    );
  }
});

test('review: Step 0/Ceremony accepts gear 4 — verifier re-run + loop ledger as evidence, alongside self-verify', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const section = sectionBetween(text, '### Step 0', '### Step 1');
  assert.match(section, /Gear 4/, 'review must address gear 4 in Step 0/Ceremony');
  assert.match(section, /verifier/i, 'review gear-4 verification must re-run the verifier from the goal contract');
  assert.match(section, /ledger/i, 'review gear-4 verification must cite the loop ledger as evidence');
  assert.match(section, /self-verif/i, 'review gear-4 verification sits alongside the existing self-verify, not replacing it');
});

test('review: Steps 1-2 wire Gear 4 through exact goal + ledger capabilities and verifier evidence', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step1 = sectionBetween(text, '### Step 1', '### Step 2');
  assert.match(step1, /accepted goal and loop-ledger paths/);
  assert.match(step1, /loop ledger is primary/i);
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  assert.match(step2, /Gear 4/, 'Step 2 must carry a gear-4 verification branch');
  assert.match(step2, /verifier/i, 'Step 2 gear-4 verification must re-run the verifier as the criterion');
  assert.match(step2, /boolean[\s\S]{0,120}metric|metric[\s\S]{0,120}boolean/i, 'Step 2 gear-4 verification must branch on the mode');
  assert.match(step1, /public capability[^]*exactly[^]*goal[^+]*\+[^]*loop-ledger/i,
    'Gear-4 review must preserve the exact public goal+ledger capability');
  assert.match(step1, /--validate-terminal --goal '<goal-path>' --ledger '<loop-ledger-path>'/i,
    'Gear-4 review must invoke the deterministic terminal validator');
  assert.match(step1, /derives[^]*`events\.jsonl`[^]*internally[^]*recomputes[^]*events-sha256/i,
    'the controller must derive and authenticate its private event source');
  assert.match(step1, /read-only[^]*zero[^]*(?:lifecycle|Git)[^]*mutation/i,
    'terminal validation must remain read-only');
  assert.match(step1, /closed bounded\s+receipt[^]*branch-review[^]*attempt-budget/i,
    'review must consume exact controller facts from a bounded receipt');
  assert.doesNotMatch(step1, /canonical SHA-256 syntax is required/i,
    'syntax-only digest checks are not evidence');
  assert.match(step2, /surface test[^]*goal verifier[^]*validate-hub/i,
    'Gear-4 evidence capture must retain the bounded surface-test → verifier → hub-gate order');
});

test('review: manual entry is capability-bounded and fails closed without artifact discovery', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
  const step1 = sectionBetween(text, '### Step 1', '### Step 2');
  assert.match(step0, /manual handoff[^]*accepts exactly[^]*criteria[^]*task-results[^]*branch-diff/i);
  assert.match(step0, /pathless recovery[^]*(?:headers only|header-only)[^]*task-result index(?:es)?[^]*require[^]*selection/i);
  assert.match(step0, /explicit[^]*(?:malformed|stale|failure)[^]*never[^]*fall(?:s)? back/i);
  assert.match(step1, /eagerly read[^]*exactly[^]*criteria[^]*task-results[^]*branch-diff/i);
  assert.doesNotMatch(step1, /Identify the spec under review|most recent dated/);
  assert.match(step1, /Never locate or read the spec, plan, progress ledger/i);
  assert.match(step1, /task briefs/);
  assert.match(step1, /task[^]{0,30}reports/);
  assert.match(step1, /task[^]{0,30}reviews/);
  assert.match(step1, /sibling work files/);
});

test('review: regular evidence and terminal lifecycle use exact current-run capabilities', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  const step4 = sectionBetween(text, '### Step 4', '### Step 5');
  assert.match(step2, /regular review[^]*`\.apex\/work\/tasks\/<plan-basename>\/evidence-report\.md`/i);
  assert.match(step2, /surface test[^]*optional goal verifier[^]*`validate-hub\.mjs`/i);
  assert.match(step2, /receipt[^]*artifact path[^]*timestamps[^]*pass state/i);
  assert.doesNotMatch(step2, /\[TASK_DIR\]|per-task files under/);
  assert.match(step4, /criterion-by-criterion judgement[^]*review-report\.md/i);
  assert.match(step4, /task-result index/i);
  assert.match(step4, /`status: CONSUMED`/);
  assert.match(step4, /`consumed-by: <review-report-path>`/);
  assert.match(step4, /next: human[^]*required:\n\s+evidence: <review-report-path>\nonDemand: none/i);
  assert.match(step4, /human action/i);
});

test('loop-engineer: exact fresh/resume capabilities and lifecycle replace most-recent defaults', () => {
  const text = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  const step0 = sectionBetween(text, '### Step 0', '### Step 1');
  assert.match(step0, /fresh[^]*required[^]*goal[^]*onDemand: none/i);
  assert.match(step0, /resume[^]*onDemand[^]*loop-ledger/i);
  assert.match(step0, /pathless recovery[^]*(?:headers only|header-only)[^]*require[^]*selection/i);
  assert.doesNotMatch(step0, /default to the most recent/i);
  assert.match(step0, /phase: goal-contract[^]*status: READY[^]*next: loop-engineer/i);
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  assert.match(step2, /fresh invocation/i);
  assert.match(step2, /resume invocation/i);
  assert.match(step2, /controller owns[^]*ledger[^]*lifecycle/i);
  assert.match(step2, /`HALTED`[^]*(?:permanently abandoned|not resumable)/i);
  assert.match(step2, /new[^]*ratified goal[^]*(?:distinct|new)[^]*(?:goal path|loop workspace)/i);
  assert.doesNotMatch(step2, /`HALTED`[^]*later exact resume handoff/i);
  const step5 = sectionBetween(text, '### Step 5', '## Model Selection');
  assert.match(step5, /controller[^]*validated terminal[^]*exact returned[^]*goal[^]*loop-ledger/i);
  assert.doesNotMatch(step5, /goal[^]*CONSUMED|loop ledger[^]*READY/i);
  assert.match(step5, /required:\n\s+goal: <goal-path>\n\s+loop-ledger: <loop-ledger-path>\nonDemand: none/i);
});

test('loop-engineer: Gear-4 handoff emits known native review invocation beside canonical envelope', () => {
  const text = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  const step5 = sectionBetween(text, '### Step 5', '## Model Selection');
  assert.match(step5, /active harness[^]*native[^]*review invocation[^]*when known/i);
  assert.match(step5, /(?:unknown|unavailable)[\s\S]*do not[\s\S]*invent syntax/i);
  assert.match(step5, /handoff: steepy-apex\/v1\nnext: review\nrequired:\n\s+goal: <goal-path>\n\s+loop-ledger: <loop-ledger-path>\nonDemand: none/);
});

test('review: terminal human handoff emits no subsequent skill invocation', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step4 = sectionBetween(text, '### Step 4', '### Step 5');
  assert.match(step4, /next: human[^]*required:\n\s+evidence: <review-report-path>\nonDemand: none/i);
  assert.match(step4, /emit no native skill invocation/i);
});

test('review: Gear-4 review validates provenance and consumes only after terminal evidence', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(text, /default to the most recent/i);
  const step1 = sectionBetween(text, '### Step 1', '### Step 2');
  assert.match(step1, /loop ledger[^]*primary/i);
  assert.match(step1, /goal[^]*status: CONSUMED[^]*consumed-by[^]*loop-ledger/i);
  assert.match(step1, /terminal validator[^]*events[^]*sole authority/i);
  assert.match(step1, /receipt[^]*branch-review[^]*verdict[^]*issues-found/i);
  assert.match(step1, /receipt[^]*attempt-budget[^]*reserved[^]*budget[^]*exhausted/i);
  const step4 = sectionBetween(text, '### Step 4', '### Step 5');
  assert.match(step4, /write[^]*terminal review report[^]*before[^]*ledger[^]*status: CONSUMED/i);
});

test('review: Gear-4 terminal review judges each claimed outcome without calling negative completion success', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  const step4 = sectionBetween(text, '### Step 4', '### Step 5');

  assert.match(step2, /`GOAL_REACHED`[^]*boolean[^]*green[^]*metric[^]*strict\s+improvement[^]*approved branch review/i);
  assert.match(step2, /`BUDGET_EXHAUSTED`[^]*red boolean verifier[^]*full budget spent/i);
  assert.match(step2, /`NO_IMPROVEMENT`[^]*reproduced metric baseline[^]*no strict improvement/i);
  assert.match(step2, /`REVIEW_REJECTED`[^]*boolean[^]*green[^]*metric[^]*strict\s+improvement[^]*never[^]*(?:red|equal)[^]*unresolved\s+review issues[^]*no remaining mutation budget/i);
  assert.match(step2, /red verifier[^]*not[^]*invalid execution/i);
  assert.match(step4, /faithfully proven negative outcome[^]*approved terminal review[^]*not goal\s+success/i);
  assert.match(step4, /consume[^]*READY[^]*loop ledger[^]*review-report\.md/i);
  assert.match(step4, /negative outcome[^]*(?:suppress|no)[^]*(?:release|PR)/i);
  assert.match(step4, /new goal contract[^]*another run/i);
});

test('review capture and loop prompts preserve bounded role-local access', () => {
  const review = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(review, '### Step 2', '### Step 3');
  assert.match(step2, /Resolve the current output path from the accepted primary\s+artifact, never by directory discovery/i);
  assert.match(step2, /never fall back to a whole-file read/i);
  for (const file of ['loop-implementer-prompt.md', 'loop-final-review-prompt.md']) {
    const prompt = readFileSync(join(skillsDir, 'loop-engineer', file), 'utf8');
    assert.match(prompt, /exact role-local|only the exact/i);
    assert.match(prompt, /do not[^]*explore[^]*\.apex\/work/i);
  }
});

test('brainstorm, plan, implement, review: the inline-recompute branch ratifies the gear with the user (identical sentence)', () => {
  const ratificationSentences = [];
  for (const s of ['brainstorm', 'plan', 'implement', 'review']) {
    const text = readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8');
    const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
    assert.match(step0, /confirm/i, `${s} Step 0 inline-recompute branch must ask the user to confirm the recomputed gear`);
    assert.match(
      step0,
      /force|override/i,
      `${s} Step 0 inline-recompute branch must let the user force a different gear, recorded as an override`
    );
    const sentenceMatch = step0.match(/Declare the recomputed\s+verdict[\s\S]*?Then\s+proceed\./);
    assert.ok(sentenceMatch, `${s} Step 0 must contain the ratification sentence verbatim`);
    ratificationSentences.push(sentenceMatch[0]);
  }
  const [first, ...rest] = ratificationSentences;
  for (const sentence of rest) {
    assert.equal(sentence, first, 'the ratification sentence must be byte-identical across all four chain skills');
  }
});

test('brainstorm: ceremony scales by gear, Step 7 human gate gated to gear 3', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  assert.match(text, /Gear 1[\s\S]{0,300}produce NO spec/i, 'gear 1 must produce no spec');
  assert.match(text, /Gear 2[\s\S]{0,300}skip Step 7/i, 'gear 2 must skip Step 7');
  const step7 = sectionBetween(text, '### Step 7', '### Step 8');
  assert.match(step7, /Gear 3 only/i, 'Step 7 reviewer must be gated to gear 3 only');
});

test('plan: ceremony scales by gear, Step 6 human gate gated to gear 3', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  assert.match(text, /Gear 1[\s\S]{0,300}no plan needed/i, 'gear 1 needs no plan');
  assert.match(text, /Gear 2[\s\S]{0,300}skip only the human\s+question in Step 6[\s\S]{0,160}shared lifecycle transition/i,
    'gear 2 must skip only the human question and still complete the shared lifecycle transition');
  const step6 = sectionBetween(text, '### Step 6', '### Step 7');
  assert.match(step6, /Gear 3 only/i, 'Step 6 reviewer must be gated to gear 3 only');
});

test('implement: ceremony scales by gear, task + whole-branch reviewers gated to gear 3, refuses gear-3 entry with no upstream artifact', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  assert.match(text, /Gear 1[\s\S]{0,300}not an implement entry/i, 'gear 1 is not an implement entry point');
  assert.match(text, /Gear 2[\s\S]{0,400}skip the\s+Step 3\.4 task reviewer and the Step 4 whole-branch review/i,
    'gear 2 must skip both the Step 3.4 task reviewer and the Step 4 whole-branch review');
  assert.match(text, /Gear-3 refuse rule[\s\S]{0,300}refuse[\s\S]{0,200}upstream workflow chain/i,
    'gear-3 entry with no upstream artifact must be refused and bounced to the upstream workflow chain');
  const step3 = sectionBetween(text, '### Step 3', '### Step 4');
  assert.match(step3, /Gear 3 only/i, 'Step 3 task-reviewer sub-step must be gated to gear 3 only');
  const step4 = sectionBetween(text, '### Step 4', '### Step 5');
  assert.match(step4, /Gear 3 only/i, 'Step 4 whole-branch review must be gated to gear 3 only');
});

test('implement: task-reviewer is conditional on non-mechanical tasks, final review always', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const step3 = sectionBetween(text, '### Step 3', '### Step 4');
  assert.match(step3, /mechanical|transcription/i, 'per-task review must be skippable for mechanical tasks');
  assert.match(step3, /judgement|judgment/i, 'per-task review runs for tasks that carry judgement');
  const step4 = sectionBetween(text, '### Step 4', '### Step 5');
  assert.match(step4, /Gear 3 only/i, 'the whole-branch review stays gear-3');
});

test('implement: Step 3 derives dispatch tier + skip-reviewer from plan Complexity, ledger records model/review/escalation', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const step3 = sectionBetween(text, '### Step 3', '### Step 4');

  // 1. dispatch tier derived from the plan's Complexity line
  assert.ok(
    step3.includes(
      "Pick the model from the task's `Complexity` line: mechanical → cheap, integration → standard, design → most-capable"
    ),
    'Step 3 dispatch must derive the tier from Complexity (mechanical → cheap, integration → standard, design → most-capable)'
  );

  // 2. an override must carry a reason recorded in the ledger
  assert.ok(
    step3.includes('To override, record a one-line reason in the ledger'),
    'an override must carry a one-line reason recorded in the ledger'
  );
  assert.ok(
    step3.includes("If the plan has no `Complexity` lines, classify the task yourself at dispatch"),
    'a plan without Complexity lines must fall back to classifying at dispatch time'
  );

  // 3. Step 3.4 reads the same Complexity field for the skip-reviewer decision
  assert.ok(
    step3.includes(
      "the task's `Complexity` line decides: `integration`/`design` → review, `mechanical` → skip"
    ),
    'Step 3.4 review/skip decision must be anchored to the plan Complexity field'
  );

  // 4. ledger line format uses abstract tiers (no vendor model ids) and records a review outcome
  assert.ok(
    step3.includes('`Task N: complete (model: standard, review: 1 iteration, commits <base7>..<head7>)`'),
    'ledger example must show an abstract model tier and review: N iteration(s) alongside a commit range'
  );
  assert.ok(
    step3.includes('`Task N: complete (model: cheap, review: skipped (mechanical), no commit)`'),
    'ledger example must show an abstract model tier and review: skipped (mechanical) with no commit'
  );
  assert.doesNotMatch(
    step3,
    /\b(haiku|sonnet|opus)\b/,
    'Step 3 must not name a concrete vendor model — abstract tiers only'
  );

  // 4b. ledger records the no-per-dispatch-choice case and any degradation exercised (D1/D2)
  assert.ok(
    step3.includes('session model'),
    'ledger recording must cover the harness with no per-dispatch model choice (session model)'
  );
  assert.match(
    step3,
    /inline impl(ementation)?[\s\S]{0,80}same-session review/i,
    'ledger recording must note degradations exercised (inline implementation + same-session review pass)'
  );

  // 5. a BLOCKED escalation is recorded on the task's ledger line
  assert.ok(
    step3.includes("add `escalated: <from>→<to>` to the task's ledger line"),
    'a BLOCKED escalation must be recorded on the ledger line as escalated: <from>→<to>'
  );
});

test('implement: gains an autopilot branch — Step 0 note, Step 2 Autopilot paragraph (drive/commit-auth/BLOCKED), Step 5 appends DONE to status file', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const protocol = readFileSync(join(skillsDir, 'implement', 'autopilot-protocol.md'), 'utf8');

  assert.match(protocol, /drive:\s*autopilot/i, 'autopilot-protocol.md must mention drive: autopilot');
  assert.match(protocol, /BLOCKED/i, 'autopilot-protocol.md must mention BLOCKED for autopilot runs');
  assert.match(protocol, /autopilot-status\.md/, 'autopilot-protocol.md must reference autopilot-status.md');
  assert.match(protocol, /\*\*Autopilot:\*\*/, 'autopilot-protocol.md must carry an Autopilot paragraph');
  assert.match(protocol, /commit-auth/i, 'autopilot-protocol.md must mention commit-auth');
  assert.match(protocol, / — implement — DONE — /, 'autopilot-protocol.md must describe appending " — implement — DONE — " to the status file');

  const step2 = sectionBetween(text, '### Step 2 — Confirm branch and authorize commits', '### Step 2.5');
  // existing manual-path text stays intact
  assert.match(step2, /Check the current branch \(`git branch --show-current`\)\./, 'Step 2 manual-path branch check must remain intact');
  assert.match(step2, /Then ask: \*\*"Commit after each reviewed-clean task this run\?"\*\*/, 'Step 2 manual-path commit question must remain intact');
});

test('autopilot phase skills: status markers preserve the four-field protocol and carry only conductor-supplied correlated identity', () => {
  for (const [name, terminal] of [['plan', 'DONE'], ['implement', 'DONE'], ['review', 'READY_FOR_PR']]) {
    const text = name === 'implement'
      ? readFileSync(join(skillsDir, 'implement', 'autopilot-protocol.md'), 'utf8')
      : readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    assert.match(text, /phasePrompt[\s\S]{0,220}authoritative/i, `${name} must treat phasePrompt identity as authoritative`);
    assert.match(text, /do not derive[\s\S]{0,100}(?:filename|filenames)/i, `${name} must not derive identity from filenames`);
    assert.match(text, /do not invent/i, `${name} must not invent correlation identity`);
    assert.match(text, /run-id=<conductor-supplied>[\s\S]{0,80}attempt=<positive supplied>/i, `${name} status examples must echo supplied run-id and positive attempt`);
    assert.match(text, new RegExp(` — ${name} — ${terminal} — run-id=<conductor-supplied> attempt=<positive supplied>`), `${name} completion marker must keep identity in the note field`);
    assert.match(text, /without supplied run\/attempt identity[\s\S]{0,220}exit non-zero without appending/i, `${name} must block uncorrelated children without writing a new-protocol marker`);
    assert.match(text, /Only versioned, correlated status is supported; uncorrelated markers never complete a phase/i, `${name} must prohibit uncorrelated completion markers`);
  }
});

test('implement: has a pre-flight input-conflict scan before the per-task loop', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  assert.match(text, /### Step 2\.5 — Pre-flight input scan/, 'must add a Step 2.5 pre-flight scan');
  const step25 = sectionBetween(text, '### Step 2.5', '### Step 3');
  assert.match(step25, /one batched question|batch/i, 'pre-flight conflicts must be batched into one question');
  assert.match(step25, /direct Gear-2[^]*one[^]*independently testable task[^]*optional plan/i,
    'direct Gear-2 ambiguity must stop before mutation and route to the optional plan');
  const i25 = text.indexOf('### Step 2.5');
  const i3 = text.indexOf('### Step 3 —');
  assert.ok(i25 !== -1 && i3 !== -1 && i25 < i3, 'Step 2.5 must precede the per-task loop');
});

test('review: ceremony self-verifies across all gears, no Step 3b subagent', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(text, /### Step 3b/, 'the Step 3b evidence-reviewer sub-step must be removed');
  const ceremony = sectionBetween(text, '### Ceremony by gear', '### Step 1');
  assert.match(ceremony, /All gears/i, 'ceremony must self-verify across all gears');
  assert.match(ceremony, /self-verif/i, 'ceremony must state the review self-verifies');
});

test('review: inline evidence capture and in-session judgement are locked across the protocol', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');

  const checklist = sectionBetween(text, '## Checklist', '## Procedure');
  assert.match(checklist, /Run `capture-review-evidence\.mjs` once/i);
  assert.match(checklist, /verbatim command output[^]*`evidence-report\.md`/i);
  assert.match(checklist, /compact JSON receipt[^]*judge every criterion in\s+session/i);

  const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
  assert.match(step0, /dispatches \*\*no\s+subagent reviewer or evidence collector\*\*/i);
  assert.match(step0, /inline and deterministically/i);
  assert.match(step0, /Judgement is never delegated/i);

  const ceremony = sectionBetween(text, '### Ceremony by gear', '### Step 1');
  assert.match(ceremony, /deterministic inline\s+capture/i);
  assert.match(ceremony, /complete command bytes[^.]*durable on disk/i);
  assert.match(ceremony, /only the bounded receipt\s+enters model context/i);
  assert.match(ceremony, /Verification and judgement are never delegated, at any gear/i);
  assert.doesNotMatch(ceremony, /dispatch[^.]*collector/i);
});

test('standalone skills (init, check, new-surface, discovery) are harness-neutral — Engine-root block, no Claude-only slash/env syntax', () => {
  for (const name of ['init', 'check', 'new-surface', 'discovery']) {
    const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    const engineRootBlock =
      `> **Engine root:** this skill's base directory is \`<engine-root>/skills/${name}/\`; engine\n` +
      `> scripts live two levels up, at \`<engine-root>/scripts/\`. Resolve them relative to the base\n` +
      `> directory your harness reports for this skill.`;
    assert.ok(text.includes(engineRootBlock), `${name} must carry the byte-exact Engine-root block`);
    assert.doesNotMatch(text, /\$\{CLAUDE_PLUGIN_ROOT\}/, `${name} must not reference \${CLAUDE_PLUGIN_ROOT}`);
    assert.doesNotMatch(text, /\/steepy-apex:/, `${name} must name skills abstractly, not with /steepy-apex: slash syntax`);
  }
});

test('init and new-surface stay marker-free; loop-engineer owns workflow lifecycle headers', () => {
  for (const name of ['init', 'new-surface', 'loop-engineer']) {
    const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    const core = text.replace(/<!-- steepy:manual-handoff:v1:start -->[\s\S]*?<!-- steepy:manual-handoff:v1:end -->\n*/u, '');
    assert.doesNotMatch(text, /CLAUDE_[A-Z0-9_]*/u, `${name} must not use Claude environment variables`);
    assert.doesNotMatch(text, /\/steepy(?:-apex)?:/u, `${name} must use semantic skill names`);
    if (name === 'loop-engineer') assert.match(core, /<!-- steepy-workflow: v1/);
    else assert.doesNotMatch(core, /<!--\s*steepy(?::|-)/iu, `${name} must delegate non-handoff marker ownership to the planner`);
  }
});

test('new-surface uses the full active Project planner and keeps unbound preparation explicit', () => {
  const text = readFileSync(join(skillsDir, 'new-surface', 'SKILL.md'), 'utf8');
  assert.match(text, /project-scaffold\.mjs/, 'new-surface must name the common project planner');
  assert.match(text, /active-v1[^]*real Project identity[^]*full Project model/iu);
  assert.match(text, /--resolution <id=choice>/u);
  assert.match(text, /preparatory-unbound[^]*without pretending to update a Project/iu);
  assert.match(text, /standard[^]*create-only/iu);
  assert.match(text, /root, routing row, standard, and triad agree/iu);
  assert.match(text, /bytes, modes, and mtimes unchanged/iu);
  assert.match(text, /\.apex\/standards\/<name>\.md/);
  for (const path of [
    '.claude/agents/<agent>.md',
    '.codex/agents/<agent>.toml',
    '.opencode/agents/<agent>.md',
  ]) {
    assert.ok(text.includes(path), `new-surface must name ${path}`);
  }
  assert.match(text, /plans all four[^.]*before the first[^.]*write/i);
});

test('loop-engineer keeps bootstrap navigation separate from goal authorization', () => {
  const text = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  const step0 = sectionBetween(text, '### Step 0 — Read the gear', '### Step 1');
  assert.match(step0, /generated project bootstrap[^.]*root\/index navigation and semantic-skill routing only/i);
  assert.match(step0, /goal\.md[^]*absent[^]*refuse before any iteration, branch mutation, or commit question/i);
  assert.match(step0, /human-authored, gear-4-ratified goal contract/i);
  assert.doesNotMatch(step0, /\.agents\/skills\/<projectName>-bootstrap\/SKILL\.md|fallback/i);
  assert.doesNotMatch(step0, /CLAUDE\.md|\.claude\/skills/i);
});

test('on-demand linter skills invoke validate-hub with an explicit `.` cwd argument', () => {
  // init uses a <repo-root> placeholder (it can run before cwd is the repo),
  // but every on-demand linter skill should pass an explicit `.` — consistent with
  // its siblings and not silently dependent on whatever process.cwd() happens to be.
  const linterSkills = ['new-surface', 'check', 'plan', 'review', 'brainstorm'];
  for (const name of linterSkills) {
    const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    assert.match(
      text,
      /validate-hub\.mjs"?[ \t]+\./,
      `${name} must invoke validate-hub.mjs with an explicit '.' argument`
    );
  }
});

test('terminal review, not the loop controller, owns the mandatory hub coherence gate', () => {
  const loop = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  const review = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const standard = readFileSync(join(root, '.apex', 'standards', 'skills.md'), 'utf8');
  const controllerBoundary = sectionBetween(loop, '### Controller responsibility boundary', '### Step 0');
  const reviewEvidence = sectionBetween(review, '### Step 2', '### Step 3');
  assert.doesNotMatch(controllerBoundary, /loop-engineer\.mjs[^]*validate-hub/u);
  assert.match(controllerBoundary, /terminal review owns[^]*validate-hub\.mjs/u);
  assert.match(reviewEvidence, /capture-review-evidence\.mjs[^]*validate-hub\.mjs/u);
  assert.match(standard, /terminal review[^]*sole owner[^]*validate-hub\.mjs/i);
});

test('check: reports model-mapping freshness verdicts after the validate-hub steps, never blocking on UNKNOWN', () => {
  const text = readFileSync(join(skillsDir, 'check', 'SKILL.md'), 'utf8');
  assert.ok(
    text.includes('node <engine-root>/scripts/verify-model-mappings.mjs'),
    'check must run the freshness verifier through the engine-root path'
  );
  const vIdx = text.indexOf('validate-hub.mjs');
  const mIdx = text.indexOf('verify-model-mappings.mjs');
  assert.ok(vIdx !== -1 && mIdx > vIdx,
    'the freshness reporting step must come after the validate-hub reporting steps');
  assert.ok(text.includes('`OK | STALE | UNKNOWN`'),
    'the step must carry the per-row verdict vocabulary');
  assert.match(text, /`STALE`[^\n]*human-ratified table patch/,
    'STALE must require a human-ratified table patch');
  assert.match(text, /script prints the prepared patch/,
    'the step must point at the script-printed prepared patch');
  assert.match(text, /`UNKNOWN` is informational \(source unreachable/,
    'UNKNOWN must be informational (source unreachable)');
  assert.match(text, /never as a failure/,
    'the step must never block on UNKNOWN (declared offline degradation)');
});

test('live-observability docs lock the bridge boundary, safe logging contract, and conservative native capabilities', () => {
  const architecture = readFileSync(join(root, 'docs', 'architecture.md'), 'utf8');
  const workflow = readFileSync(join(root, 'docs', 'workflow.md'), 'utf8');
  const readme = readFileSync(join(root, 'README.md'), 'utf8');

  for (const required of [
    '`adapters/headless.mjs`',
    '`adapters/headless-events.mjs`',
    '`scripts/autopilot-observability.mjs`',
    '`scripts/autopilot.mjs`',
    'common event envelope',
    'raw-first',
    'bounded backpressure',
    'Node >= 24',
    'zero runtime dependencies',
  ]) {
    assert.ok(architecture.includes(required), `architecture must document: ${required}`);
  }

  for (const required of [
    'phase-<n>-attempt-<m>.log',
    'phase-<n>-attempt-<m>.raw.jsonl',
    'phase-<n>.log',
    'safe',
    'exact',
    'no-steer',
    'new attempt',
    'interruption',
    'timeout',
    'yes | unavailable | unproven',
    'OpenCode',
    'unproven',
    'https://code.claude.com/docs/en/cli-usage',
    'https://developers.openai.com/codex/cli/reference',
    'https://developers.openai.com/codex/noninteractive',
    'https://opencode.ai/docs/it/cli/',
  ]) {
    assert.ok(workflow.includes(required), `workflow must document: ${required}`);
  }
  assert.match(workflow, /exact[\s\S]{0,300}never changes[\s\S]{0,160}(?:live|readable)/i,
    'exact mode must not change curated live/readable output');
  assert.match(workflow, /safe[\s\S]{0,240}(?:best-effort|not a mathematical secrecy guarantee)/i,
    'safe redaction must be documented as best effort, not a secrecy guarantee');
  assert.match(workflow, /Native capability matrix — 2026-08-19, steepy-apex v0\.8\.5/,
    'capability matrix must remain dated and tied to the current plugin version');

  for (const required of [
    'claude -p <prompt> --dangerously-skip-permissions --allowedTools Task,Bash,Glob,Grep,Read,Edit,Write,TodoWrite,Skill --output-format stream-json --verbose --forward-subagent-text --name <display-name>',
    'codex exec --dangerously-bypass-approvals-and-sandbox --color never --json <prompt>',
    'opencode run --auto --format json --title <display-name> <prompt>',
  ]) {
    assert.ok(workflow.includes(required), `workflow must show the complete mapped command: ${required}`);
  }
  assert.match(workflow, /Native session identity \| Native discovery \| Native open\/resume/,
    'the matrix must distinguish observed session identity from discoverability and resume success');
  assert.match(workflow, /Claude Code[^\n]*\| yes \| yes \| yes \| unproven \| unproven:[^\n]*\| yes \| unavailable \| unavailable \|/,
    'Claude discovery and successful native resumption must remain unproven');
  assert.match(workflow, /Codex[^\n]*\| yes \| unavailable \| yes \| yes:[^\n]*\| yes:[^\n]*\| unavailable \| unavailable \| unavailable \|/,
    'Codex documented discovery and resume baseline must stay separate from its locally unavailable canary');
  assert.match(workflow, /OpenCode[^\n]*\| yes \| unavailable \| yes \| yes:[^\n]*\| yes:[^\n]*\| yes \| unavailable \| unavailable \|/,
    'OpenCode identity, discovery, and open/resume are yes on real event evidence (sessionID on every structured event)');
  assert.match(workflow, /flag-only[^\n]*?(?:never|does not)[^\n]*promot/i,
    'workflow must prohibit flag-only capability promotion explicitly');

  assert.match(readme, /live observability/i, 'README must summarize live observability');
  assert.ok(readme.includes('[docs/workflow.md](docs/workflow.md)'), 'README must link to detailed workflow docs');
  assert.ok(readme.includes('[docs/architecture.md](docs/architecture.md)'), 'README must link to detailed architecture docs');
});

test('all five chain skills declare session-per-phase discipline: entry declaration + autopilot no-op in Step 0, new-session instruction at handoff', () => {
  const handoffHeadings = {
    brainstorm: '### Step 8 — Hand off',
    plan: '### Step 7 — Hand off',
    implement: '### Step 5 — Hand off',
    review: '### Step 5 — Offer a pull request',
    'loop-engineer': '### Step 5 — Hand off',
  };
  const step0EndHeadings = {
    brainstorm: '### Ceremony by gear',
    plan: '### Ceremony by gear',
    implement: '### Ceremony by gear',
    review: '### Ceremony by gear',
    'loop-engineer': '### Step 1',
  };

  for (const s of ['brainstorm', 'plan', 'implement', 'review', 'loop-engineer']) {
    const text = readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8');

    // (b) In ingresso — Step 0 declares whether this session already ran another chain phase,
    // and names the cost when it did. Declares, never blocks. Anchored to Step 0 alone (not the
    // sibling "Ceremony by gear" subsection) so this slice can actually falsify a wrong placement.
    const step0 = sectionBetween(text, '### Step 0 — Read the gear', step0EndHeadings[s]);
    assert.match(step0, /already run an earlier phase/i, `${s} Step 0 must declare whether an earlier phase already ran this session`);
    assert.match(step0, /same session/i, `${s} Step 0 declaration must name the same-session case`);
    assert.match(step0, /every turn/i, `${s} Step 0 declaration must name the per-turn cost of an already-grown session`);
    assert.match(step0, /never refuse or gate/i, `${s} Step 0 declaration must never block or refuse sound work`);
    assert.match(step0, /determined with certainty/i, `${s} Step 0 declaration must cover the case it cannot determine session history with certainty`);

    // (c) No-op in autopilot — same paragraph, names the conductor's per-phase headless session
    // as the mechanism already enforcing this, so the declaration is a no-op there.
    assert.match(step0, /drive:\s*autopilot/i, `${s} Step 0 declaration must address drive: autopilot`);
    assert.match(step0, /no-op/i, `${s} Step 0 declaration must state the autopilot no-op`);
    assert.match(step0, /scripts\/autopilot\.mjs/, `${s} Step 0 declaration must cite the conductor (scripts/autopilot.mjs) as the enforcing mechanism`);

    // (a) In uscita — the hand off / terminal section instructs a new session for what comes next.
    const handoff = sectionBetween(text, handoffHeadings[s], '## Model Selection');
    assert.match(handoff, /new session/i, `${s} handoff must instruct running the next work in a new session`);
    assert.match(handoff, /does not serve/i, `${s} handoff must state this phase's context does not serve the next work`);
    assert.match(handoff, /every turn/i, `${s} handoff must state every turn of the next work would pay to carry this phase's context`);
  }
});

test('task reviewer explicitly rejects a review-file pointer for ISSUES_FOUND', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'task-reviewer-prompt.md'), 'utf8');
  assert.match(text, /ISSUES_FOUND artifact must be task-N-issues\.md/);
  assert.match(text, /A link from the review file to the issue file does not satisfy/);
  assert.match(text, /status: ISSUES_FOUND\n    artifact: \[ISSUE_FILE\]/);
});


test('legacy reviewer recovery retains literal none and a bounded durable reservation', () => {
  const recovery = readFileSync(join(skillsDir, 'implement/reviewer-recovery.md'), 'utf8');
  const schema = JSON.parse(readFileSync(join(skillsDir, 'implement/reviewer-response.schema.json'), 'utf8'));
  assert.equal(schema.properties['changed-paths'].const, 'none');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['status', 'artifact', 'changed-paths', 'signals']);
  for (const file of ['SKILL.md', 'autopilot-protocol.md']) assert.match(readFileSync(join(skillsDir, 'implement', file), 'utf8'), /reviewer-recovery\.md/);
  for (const file of ['task-reviewer-prompt.md', 'final-review-prompt.md']) {
    const prompt = readFileSync(join(skillsDir, 'implement', file), 'utf8');
    assert.doesNotMatch(prompt, /changed-paths: <comma/);
    assert.match(prompt, /artifacts is required and excluded from `changed-paths`/);
  }
  for (const action of ['begin', 'check', 'reserve', 'correct', 'inspect']) assert.ok(recovery.includes(`--action ${action}`));
  assert.match(recovery, /reservation is consumed even if the process crashes/);
  assert.match(recovery, /never another implementation/);
  assert.match(recovery, /do not invent a schema flag/);
});

test('receipt protocol selects semantic transport and records exact restart capabilities', () => {
  const protocol = readFileSync(join(skillsDir, 'implement/task-results-protocol.md'), 'utf8');
  for (const action of ['begin', 'record', 'inspect', 'resume', 'project', 'verify']) {
    assert.ok(protocol.includes(`--action ${action}`), action);
  }
  assert.match(protocol, /manifest\.contract\.taskResultProtocol/);
  assert.match(protocol, /TASK_RESULT_PROTOCOL/);
  assert.match(protocol, /before[^]*dispatch[^]*ledger/i);
  assert.match(protocol, /parentState[^]*all tasks/i);
  assert.match(protocol, /previousState[^]*same.task/i);
  assert.match(protocol, /baseline.only[^]*pending/i);
  assert.match(protocol, /capture[^]*without[^]*redispatch/i);
  assert.match(protocol, /review.pending/i);
  assert.match(protocol, /never[^]*manufacture[^]*historical baseline/i);
  assert.match(protocol, /JSON[^]*changedPaths[^]*executionChangedPaths/);
  assert.match(protocol, /outputs[^]*not[^]*read permission/i);
});

test('v2 prompts override four-field legacy examples without changing manual or Gear-4 grammar', () => {
  for (const file of ['SKILL.md', 'implementer-prompt.md', 'task-reviewer-prompt.md', 'final-review-prompt.md']) {
    const text = readFileSync(join(skillsDir, 'implement', file), 'utf8');
    assert.match(text, /taskResultProtocol[^]*2/);
    assert.match(text, /status[^]*artifact[^]*signals/);
    assert.match(text, /manual[^]*legacy/i);
    assert.match(text, /precedence/i);
    assert.match(text, /changed-paths:/, 'legacy grammar remains documented');
  }
  const recovery = readFileSync(join(skillsDir, 'implement/reviewer-recovery.md'), 'utf8');
  assert.match(recovery, /--execution/);
  assert.match(recovery, /reviewer-response-v2\.schema\.json/);
  assert.match(recovery, /path.only[^]*correction/i);
  const schema = JSON.parse(readFileSync(join(skillsDir, 'implement/reviewer-response-v2.schema.json'), 'utf8'));
  assert.deepEqual(schema.required, ['status', 'artifact', 'signals']);
  assert.equal(schema.additionalProperties, false);
});

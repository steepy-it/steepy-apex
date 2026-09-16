---
name: brainstorm
description: Turn an idea into a local working spec under .apex/work/specs/. Classifies the idea against the routing table, dialogues one question at a time, proposes approaches, and on approval writes the spec as a gitignored work artifact.
user-invocable: true
---

<!-- steepy:manual-handoff:v1:start -->
## Manual handoff envelope

Manual phase boundaries use this literal shape (the envelope is chat text, never a file):

```yaml
handoff: steepy-apex/v1
next: <phase>
required: <role/path map or none>
onDemand: <role/path map or none>
```

All four keys are mandatory and occur once, in that order. Use explicit `none` for an empty map.
The phase input role maps are exact and unique: brainstorm has `required: none`, `onDemand: none`;
plan has required `spec`, `onDemand: none`; Gear-2 direct implement has required `spec`,
`onDemand: none`; plan-backed implement has required `plan`, on-demand `source-spec`; either
implement alternative additionally authorizes exact `progress-ledger` and `task-results` on demand
when resuming;
regular Gear-3 `review` has required `criteria`, `task-results`, and `branch-diff`, `onDemand: none`;
fresh `loop-engineer` has required `goal`, `onDemand: none`; resume may additionally authorize exact
`loop-ledger` on demand; Gear-4 `review` has required `goal` and `loop-ledger`, `onDemand: none`.
Thus Gear-2 brainstorm → implement maps `spec`; brainstorm → plan maps `spec`; plan → implement
maps `plan`, `source-spec`; Gear-3 implement → review maps `criteria`, `task-results`, `branch-diff`;
loop-engineer → review maps `goal`, `loop-ledger`. The two implement role alternatives and the two
review role alternatives are mutually exclusive: never merge or infer them. A role occurs only in
its mapped phase, alternative, and list.

Validate literally before any work-artifact read. Reject duplicate keys, unknown keys, unknown roles,
missing keys, a wrong `next`, and unsafe paths: absolute paths, `..` segments, globs, or anything
outside the repository. Never infer corrections. An explicit malformed or stale binding fails closed
without discovery. Supporting `onDemand` inputs are never preloaded; read one only for a concrete
named missing fact. Stable routing inputs stay outside the envelope and follow bootstrap routing.
Native invocation spelling comes only from the active harness. No child inherits general
`.apex/work/**` access; pass only its accepted role paths.

Every new work artifact starts with verdict/contract metadata when that phase requires it, followed
immediately by this versioned header before the Markdown title:

```yaml
<!-- steepy-workflow: v1
phase: <brainstorm|plan|implement|review|loop-engineer|goal-contract>
status: <DRAFT|READY|CONSUMED>
next: <phase|none>
source: <safe exact repo-relative path|none>
consumed-by: <safe exact repo-relative path|none>
-->
```

Header fields are mandatory, unique, and literal. `source` and `consumed-by` must agree with the
adjacent lifecycle transition and authorize no transitive reads. Headerless artifacts are
ignored by recovery and are available only under explicit user audit scope.

### Exact publication pairs

These are exact resume capabilities, not paths inferred from provenance. The input retains its
normal required role; the output role is added to `onDemand`, as are any existing on-demand companions.
Regular review retains its required criteria and branch diff. Plan resume adds `onDemand.output-plan`;
regular Gear-3 review resume adds `onDemand.review-report`. Fresh forms above are unchanged.
Gear-4 controller/ledger handling is excluded from this model-based pair repair.

| Route | Input role | Output role | Companion roles | Input phase | Output phase | Output next |
| --- | --- | --- | --- | --- | --- | --- |
| plan | spec | output-plan | none | brainstorm | plan | implement |
| implement-2-direct | spec | task-results | progress-ledger | brainstorm | implement | none |
| implement-2-plan | plan | task-results | source-spec,progress-ledger | plan | implement | none |
| implement-3 | plan | task-results | source-spec,progress-ledger | plan | implement | review |
| review-3 | task-results | review-report | criteria,branch-diff | implement | review | none |

### Publication interruption prefixes

This table applies only to the exact authorized pair with matching phase, route and provenance.
Validate the pair before the fresh-only READY input gate; a resume capability is never inferred.
Input `next` names the consumer phase until consumed; consumption retains it for plan/implement
and sets it to `none` for review. Output `consumed-by` is `none` throughout this producer's run.
An unconsumed input must have `consumed-by: none`; a consumed input must name the exact output.

| Input status | Output status | Action |
| --- | --- | --- |
| absent | absent | reject |
| absent | DRAFT | reject |
| absent | READY | reject |
| absent | CONSUMED | reject |
| DRAFT | absent | reject |
| DRAFT | DRAFT | reject |
| DRAFT | READY | reject |
| DRAFT | CONSUMED | reject |
| READY | absent | fresh-create |
| READY | DRAFT | resume-work |
| READY | READY | finish-consumption |
| READY | CONSUMED | reject |
| CONSUMED | absent | reject |
| CONSUMED | DRAFT | reject |
| CONSUMED | READY | no-op |
| CONSUMED | CONSUMED | reject |

`fresh-create` permits a new absent output only in a fresh run, never a missing resume target.
`resume-work` requires exact output capability and leaves the input READY while work/gates remain.
For `finish-consumption`, revalidate output.source against the exact input path, input.consumed-by
as `none`, and the recorded approval and verification bound to those input/output paths and content
(excluding lifecycle fields). Recheck current branch/HEAD or uncommitted diff identity where applicable.
Only then perform the input-consumption write with input.consumed-by equal to the exact output path.
For `no-op`, revalidate the recorded proof with the final reciprocal links instead of the
unconsumed-input condition; perform no writes or redispatch.
A missing capability, mismatched path/phase/next/content, absent approval/proof, or impossible state
must fail closed, preserving both files. A READY marker alone is not proof. Do not follow links to
undeclared evidence; request the exact missing capability or user-delimited scope instead.
Never select a most-recent output or recover by directory/body search.

Publication is ordered: record the phase's applicable approval and verification in the output,
publish output READY by per-file atomic replacement, then consume the input by per-file atomic
replacement. This is not a multi-file atomic operation; READY/READY is its sole verified intermediate
prefix. Resume repairs no other state and never repeats completed work or release actions.
Manual enforcement is model-based: no manual parser, manifest or validator is introduced.
The content tests check this documented contract, not deterministic enforcement by a model.
<!-- steepy:manual-handoff:v1:end -->

# brainstorm

Turn an idea into a local working spec informed by the hub. Do not write code or scaffold anything in this skill — the only artifact produced is the spec.

> **Engine root:** this skill's base directory is `<engine-root>/skills/brainstorm/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

## Checklist
0. Derive coverage and gear from the human request and stable routed evidence; obtain ratification (Step 0).
1. Orient against the hub (routing table + owning surface standard).
1.5. Resolve a CONFLICT (doc-wins, or override that rewrites the doc) or GAP (explore-first, then write-back or brainstorm) verdict.
2. Understand the idea — grill it against the hub, one question at a time (gear 2–3).
3. Propose 2–3 approaches.
4. Present the design as a draft in `.apex/work/specs/` and get approval, section by section (gate).
5. Finalize the approved draft — drop the `Status: DRAFT` marker.
5.5. Self-review the spec inline — free gate, gear 2 and 3 (Step 5.5).
6. Validate the stable hub with `validate-hub.mjs` (deterministic gate).
7. Human review gate — ask the user to review the written spec, then choose drive mode: manual or autopilot (gear 3).
8. Hand Gear 2 directly to `implement`; hand Gear 3 to `plan` (Step 8).

## Procedure

### Step 0 — Read the gear

This is the fresh entry: use the human request, stable routed hub rules (Step 1), and ordinary
repository source evidence to recompute the coverage verdict inline (COVERED / CONFLICT / GAP with
`file:line` evidence → gear). It has no historical work inputs: never read a prior spec, log, or
verdict to choose coverage or gear, and do not perform work-area recovery discovery. Gear 3 is a
valid fresh entry, not a reason to demand an upstream brainstorm artifact.

Declare the recomputed
  verdict, gear, and evidence, then ask the user for one confirmation before the ceremony starts —
  the user may force a different gear, and the override is recorded in the verdict artifact. Then
  proceed.
Record that ratification in the new spec (or the new gear-1 local log), not an old artifact. If
gear 4 is confirmed, route to the `loop-engineer` skill and stop; this is not authority to fabricate
its required human-ratified goal contract. An explicit request to revisit existing work needs its
own user-delimited scope; the fresh entry's `required: none` grants no such read or overwrite.

Scale this skill's ceremony to the gear (see "Ceremony by gear" below). This skill dispatches **no
subagent reviewer**: a spec is prose, gated by the inline self-review (Step 5.5) plus a human review
of the written spec (Step 7), per `conventions.md` → "Review architecture (gear 3)".

**Session declaration (declare, never block).** Say whether this conversation started clean for this
phase or has already run an earlier phase of the chain in the same session. A same-session phase
already grew the context, and every turn of this phase now pays to carry it — name that cost, but
never refuse or gate on it: this is a declaration about the conversation, not a measurement, and
sound work proceeds either way. If the session's history cannot be determined with certainty, say so
and proceed. Under `drive: autopilot` this declaration is a no-op: the conductor
(`scripts/autopilot.mjs`) already opens a fresh headless session per phase, so the discipline stated
here is already enforced by that mechanism, not by this prose.

### Ceremony by gear

- **Gear 1** (COVERED + low-value): produce NO spec — state the task is COVERED + low-value, cite
  the governing rule, hand straight to the specialist agent, and stop.
- **Gear 2** (COVERED + high-value, or GAP + low-value): write a light spec, self-review it
  (Step 5.5), run `validate-hub`, **skip Step 7**, and hand the READY spec directly to
  `implement`. A light plan remains an explicit opt-in when the user already requested one or the
  spec cannot become one independently testable implementation task.
- **Gear 3**: run the full procedure, including the Step 5.5 self-review and the Step 7 human gate.
- **Gear 4**: not this skill's entry point — bounce to the `loop-engineer` skill and stop.

### Step 1 — Orient against the hub

Read `.apex/_INDEX.md` in full. If it does not exist, tell the user to run the `init` skill (invoke it
the way your harness invokes skills) first and stop. Classify the idea to its owning **surface** (or
note it as cross-cutting), then follow the exact standard links in the routing row: load its
single-file standard or modular core. For a core, match the mini-routing conditions against the
current idea's paths/topics, read every matching leaf in table order, and record the concrete reason
for each selection in the new spec. Zero matches means core only. Never manufacture
`.apex/standards/<surface>.md`, read unrelated leaves, or use a read-all fallback. The same actual
matched paths govern any later surface write-back; a filename convention is not routing authority.

### Step 1.5 — Resolve a CONFLICT or GAP verdict

If Step 0's verdict was COVERED, skip this step. Otherwise, resolve the verdict before moving on.

**On CONFLICT** (Step 0 found that a hub rule and the intended change contradict): stop
and surface the contradiction with its `file:line` citation. Default is **doc-wins**: the plan
bends to the documented rule — but never silently. Tell the user what the rule says and ask them
to confirm doc-wins, or to declare an explicit override.
- **Confirm** → proceed under the documented rule.
- **Override** → the doc changes: rewrite the governing doc (`standards/<surface>.md` or
  `conventions.md`) to state the new rule and its why in active form only — a stable doc never
  carries the superseded rule (history lives in git and the spec). Code and doc must never
  diverge silently.

**On GAP** (no rule decides it): **explore the codebase first**, before any user brainstorm.
- A **consistent latent convention** (≥2–3 concordant occurrences) means the code already decided
  it → do NOT brainstorm; **write it back** to the hub (see "Write-back routing" below) so it
  becomes COVERED, then proceed.
- A **single isolated precedent** is weak → surface it to the user ("one precedent here — elevate
  to a rule or treat as a one-off?"); do not canonise automatically.
- **No precedent** → a genuine design gap → brainstorm with the user (Steps 2–4).

### Step 2 — Understand the idea

**Gear 2 and 3.** Grill the idea against the hub, one question at a time — surface and sharpen, don't just collect requirements. Treat the open decisions as a **design tree**: each decision branches into the ones that hang off it. Work the tree in dependency order — never ask a decision whose prerequisites are still unsettled. Split facts from decisions: **facts** are this skill's job — explore the codebase instead of asking; never ask the user for something look-up-able. **Decisions** are the user's — put each one to them and wait. Ask multiple-choice when possible and recommend an answer. Focus on purpose, constraints, and success criteria — and challenge along these hub-aware dimensions:

- **Sharpen terminology against the glossary.** When a term conflicts with, or is vaguer than, `.apex/glossary.md`, call it out and propose the canonical term ("you say 'doc' — Standard, Convention, Glossary, or a Work artifact? Those are different things in the hub").
- **Probe concrete edge-case scenarios.** Stress the hub relationships the idea touches with specific invented scenarios — surface ownership, durable decision vs work artifact, when the anti-orphan rule bites — and force a precise answer.
- **Cross-reference the code for Drift.** When the user states how something works, check whether the code agrees (`scripts/`, `skills/`, `templates/`, `tests/`); surface any divergence between the docs and reality.

**Exit criterion.** Step 2 is done when every branch of the design tree has been visited and nothing is left silently assumed, and the user confirms shared understanding.

**Write nothing to the hub here.** Step 2 grills; it does not mutate docs. An already-durable delta (a latent convention the code already follows, or an explicit override) routes to the existing **Step 1.5** channel; a speculative design delta — a term sharpened for something not yet built — is **captured in the spec** (Step 5) as a deferred proposal for downstream promotion.

### Step 3 — Propose approaches

Present 2–3 approaches with trade-offs, lead with your recommendation and reasoning.

### Step 4 — Present the design (gate)

Write the design into a new spec at its conventional path, `.apex/work/specs/YYYY-MM-DD-<topic>.md`.
Check only target existence first. An existing target requires a stop for an absent path or explicit
user-delimited revisit scope: no historical body read or overwrite is authorized by fresh entry.
Within this invocation, continue editing only the draft it created.
Create `.apex/work/specs/` if it does not exist. After the verdict/contract metadata and before the title, write this workflow header
(the old prose `Status: DRAFT` marker is not a substitute):

```yaml
<!-- steepy-workflow: v1
phase: brainstorm
status: DRAFT
next: implement
source: none
consumed-by: none
-->
```

Use `next: implement` for the default Gear-2 direct route. Use `next: plan` for Gear 3 and for a
Gear-2 light plan the user explicitly requested before handoff. Do not ask Gear-2 users whether they
want a plan merely to create a gate: direct implementation is the lean default.

Present it in sections scaled to complexity (architecture, components, data flow, error handling, testing). Two sections are canonical — required at gear 3, recommended at gear 2:

- **Out of Scope** — what the spec consciously excludes, so downstream review flags scope
  creep against an explicit list instead of intuition.
- **Testing Decisions** — the boundaries the work will be tested at, and prior art
  (similar tests already in the repo).

At gear 3 an empty section is written as a real statement ("nothing excluded"), never omitted. Point the user at the file — not chat prose — and ask for approval section by section, referencing the document by file path and section name.

What approval gates is finalization and handoff, not file creation: a DRAFT-marked file records only material already discussed, so writing it preserves the anti-anchoring intent behind the old "do not write the spec until the user approves" rule. This supersedes the letter of that rule, not its intent.

The gate itself is unchanged: no finalization, no handoff, no hub mutation until the user approves each section. Harness-portable: the artifact is a file path, nothing harness-specific.

### Step 5 — Finalize the approved draft

Incorporate the requested changes from the Step 4 review into the draft file. Drop the old `Status: DRAFT` prose marker if present, but leave the workflow header `status: DRAFT` until the applicable approval gate completes. Make sure the owning surface, the success criteria, and the Out of Scope and Testing Decisions sections are stated explicitly (the canonical sections per Step 4's gear gradient).

For every new gear-3 spec, use this canonical machine-readable metadata and criteria grammar:

- `- **Owning surface:** \`<one registered surface>\``
- `- **Cross-cutting surfaces:** \`<surface>\`, ...` or `- **Cross-cutting surfaces:** none`
- exactly one literal `## Success criteria` heading;
- stable sequential criterion IDs under that heading: `- **SC1:** <criterion>`, `- **SC2:** <criterion>`, and so on.

Do not place cross-cutting surfaces inside the owning-surface value. The finalized spec also records exactly one `Feature complexity: mechanical | integration | design` field, rendered as `- **Feature complexity:** \`<one allowed value>\`` and selecting the one value that describes the feature as a whole.

If the Step 2 grilling surfaced a **speculative hub-delta** (a term or rule worth promoting once the work proves it), record it in the spec as a deferred proposal — not a canonised hub edit; downstream review/check promotes it if it holds.

Do not register the spec in `.apex/_INDEX.md` and do not create a specs sub-index.
Specs are local workflow artifacts, not stable hub documentation.

### Step 5.5 — Self-review the spec (free gate)

**Gear 2 and 3** — skip only at gear 1 (no spec is produced there).

Read the spec you just wrote with fresh eyes and fix any of these inline — no re-review needed, just fix and move on:
1. **Placeholder scan** — any "TBD", "TODO", or vague requirement? Fix it.
2. **Internal consistency** — do the design, success criteria, and architecture agree with each other?
3. **Scope check** — is this focused enough for a single plan, or does it need decomposition first?
4. **Ambiguity check** — could a requirement be read two ways? Pick one and make it explicit.
5. **Hub binding** — is the owning surface stated correctly, and — if Step 1.5 produced a write-back — was it actually written?
6. **Feature complexity** — is there exactly one `Feature complexity` field, and is its value exactly `mechanical | integration | design`?
7. **Machine contract** — does the spec contain the canonical ownership fields, exactly one literal `## Success criteria` H2, and unique sequential `SC1`…`SCn` IDs?

### Write-back routing

When a GAP resolution or a CONFLICT override yields a durable decision, write it back **only if
the fork will recur** (a future task will face the same choice):
- a term / ambiguity → `.apex/glossary.md`
- a rule scoped to one surface → the exact routed single standard, modular core, or matching leaf
- a cross-cutting recurring fork → `.apex/conventions.md`

A *decision*-shaped write-back to `.apex/conventions.md` passes a second filter: record it
only when the decision is **hard to reverse**, **surprising without context**, and **the
result of a real trade-off**. Any one missing → the decision stays local in the spec.
Terms/ambiguities (glossary write-backs) keep the recurrence test only.

A genuine **one-off** stays local in the `.apex/work/` spec — do not bloat the hub. Write back
**inline** as the decision crystallizes, not batched at the end.

### Step 6 — Validate (deterministic gate)

Run the linter:

```bash
node <engine-root>/scripts/validate-hub.mjs .
```

It MUST print `steepy validate-hub: OK`. Fix a violation only if your own Step 1.5 write-back introduced it. Anything else is pre-existing drift: report it and point the user to the `check` skill — do not fix unrelated hub docs here. A spec under `.apex/work/specs/` is intentionally ignored by the linter and does not need registration.

### Step 7 — Human review gate

**Gear 3 only** — skip in gears 1–2.

A spec is prose: the downstream code reviewers validate code *against* it, so they cannot catch a wrong requirement — a human must. Do **not** dispatch a subagent. Tell the user:

> "Spec written to `<path>` — please review it and tell me if anything should change before we plan."

Wait for the response. The human gate includes validating that the spec has exactly one `Feature complexity` field with an allowed value. On requested changes, edit the spec and re-run the Step 5.5 self-review. Proceed to handoff only once the user approves.

On that gear-3 human approval, record the ratification, approval and completed self-review/hub gate,
then publish the spec workflow header as `status: READY`. For gear 2, publish only after both
Step 5.5 and Step 6 succeed (its human gate is intentionally skipped). Interruption before those
gates complete leaves the spec `DRAFT`. This fresh producer consumes no historical input.

#### Drive mode (gear 3, on approval)

Once the user approves the spec, ask one more question: drive `manual` or `autopilot`?

- **`manual`** (default) → acknowledge the choice and state the approved spec's relative path (`.apex/work/specs/<spec-basename>.md`). When the active harness exposes the native plan invocation spelling, emit it; otherwise do not invent one. Then emit this canonical envelope and proceed to Step 8:

  ```yaml
  handoff: steepy-apex/v1
  next: plan
  required:
    spec: <exact-spec-path>
  onDemand: none
  ```
- **No headless mode on this harness** (today: Pi — the map is `adapters/headless.mjs`) → do not offer autopilot. Say explicitly that this harness has no headless mode, so the run stays manual — degradations are explicit, never silent.

On `autopilot`:

1. Anticipate implement Step 2's git decisions now, in one message: branch name (suggest one from the topic) + commit authorization (per-task commits). Create the branch.
2. Extend the verdict artifact at the spec head into the contract:

   ```
   <!-- verdict: <verdict> | gear: 3
   drive: autopilot
   branch: <branch-name>
   commit-auth: per-task
   harness: claude|codex|opencode
   blast-radius: branch-only, no-push, stop-before-PR
   log-mode: safe
   -->
   ```

   Keep the verdict text and gear unchanged — only turn the one-line comment into this multi-line contract block, so the closing `-->` moves to its own line at the end (a literal read of "keep line 1 as it was" that leaves `-->` closing the comment on line 1, with `drive:` and the rest outside it, makes the conductor refuse: `parseContract` needs the whole contract inside one HTML comment). `harness` = the current harness. The `budget` field is rejected on fresh and resumed gear-3 contracts; do not author it or ask a replacement resource or profile question. Future gear-3 autopilot contracts write `log-mode: safe` by default; do not add a logging question. Offer `exact` only when the user explicitly requests sensitive exact capture: warn that exact raw logs may contain secrets, write `log-mode: exact`, and state that the conductor will print and record `EXACT_LOGGING`.
3. Launch the conductor in background: `node <engine-root>/scripts/autopilot.mjs <spec-path>`.
4. Report the run's status path and live artifacts: `.apex/work/tasks/<spec-basename>/autopilot-status.md`, per-attempt readable `phase-<n>-attempt-<m>.log`, per-attempt raw `phase-<n>-attempt-<m>.raw.jsonl`, and aggregate `phase-<n>.log`. Report the native open/resume reference when supported. The run is no-steer: it halts on anything needing a human, and its branch-only boundary is stop-before-PR (`READY_FOR_PR`). Gate 8 stays human, in an interactive session.

Drive mode adds nothing to the manual path: no new question is asked at gears 1-2, and answering `manual` changes nothing downstream. (The draft-first spec file of Steps 4-5 is a separate change, shared by both modes.)

### Step 8 — Hand off

**Gear 2, default direct route.** After Step 5.5 and Step 6 succeed, set the spec header to
`status: READY`, retain `next: implement`, and tell the user the next step is the `implement` skill
(invoke it the way the active harness invokes skills). Emit:

```yaml
handoff: steepy-apex/v1
next: implement
required:
  spec: <exact-spec-path>
onDemand: none
```

Run `implement` in a new session: this phase's context does not serve implementation, and every turn
of implementation would otherwise pay to carry the brainstorm context. Do not route Gear 2 through
`plan` unless the user explicitly requested the optional light plan before this handoff or the spec
cannot represent one independently testable implementation task. In that opt-in case, set
`next: plan` and use the same plan handoff as Gear 3.

**Gear 3.** Only after the Step 7 reviewer approves, hand the READY spec to `plan` using the canonical
envelope emitted in Step 7. Run `plan` in a new session: this phase's context does not serve planning,
and every turn of the plan phase would pay to carry it forward. Autopilot remains conductor-owned
after the blocking spec gate.

## Model Selection

Always set `model:` explicitly when dispatching a subagent. An omitted model inherits the session model (usually the most capable and most expensive) and silently defeats this policy.

Pick the tier by task complexity and risk:

| Signal | Tier |
|--------|------|
| Mechanical / transcription (1-2 files, complete spec) | cheap |
| Integration / multi-file / judgment | standard |
| Design / architecture / high-risk or subtle change | most-capable |

Reviewers floor at **standard** and rise to **most-capable** when the artifact is high-risk or subtle.

**Turn count beats token price.** The cheapest model often takes 2-3× the turns on multi-step work — more wall-clock and context overall. Make a mid-tier model the floor for reviewers and for implementers working from prose; reserve the cheapest tier for transcription tasks whose exact code the plan already contains.

Translate the tier to a concrete model by judgment at dispatch time using your harness's available models. The three tiers are the whole ladder — `most-capable` is its top rung, not an open-ended "best available". A model that sits above that rung is outside the ladder: never reach it from a tier, and record a one-line reason in the ledger when you override to it. On a harness without per-dispatch model choice, everything runs on the session model — record that in the ledger.

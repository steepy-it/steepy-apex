---
name: loop-engineer
description: Validate and authorize a gear-4 goal contract, invoke the packaged deterministic loop controller, report its result, and hand off terminal evidence to review.
user-invocable: true
argument-hint: '[goal description]'
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

# loop-engineer

Validate and authorize a **machine-verifiable Gear-4 goal**, then route it into the packaged
deterministic controller. This skill is the human/controller boundary. It does not implement the
loop's state machine in prose and it does not write feature code.

> **Engine root:** this skill's base directory is `<engine-root>/skills/loop-engineer/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

### Controller responsibility boundary

Skills authorize and route; scripts own deterministic state. In particular, this skill must not:

- allocate attempts or decide when an attempt is available;
- run keep/discard policy or decide a verifier verdict;
- interpret ledger Markdown as state (the ledger is only a controller projection);
- perform Git recovery, cleanup, rollback, commit, or reconciliation;
- grant extra fixes beyond the ratified mutation budget; or
- offer an inline runner fallback when the active harness has no supported headless runner.

The packaged engine owns all of those decisions, including the sanity verifier, immutable event
stream, controller-owned commits, blast-radius enforcement, terminal branch review, and goal/ledger
lifecycle. The later terminal review owns the mandatory `validate-hub.mjs .` coherence gate; the
loop controller neither claims nor duplicates that review evidence.

## Checklist

- [ ] Validate the exact fresh/resume handoff and complete ratified Gear-4 goal before autonomy (Step 0)
- [ ] Read only stable routed hub inputs, select the active supported harness, and obtain the single
      human authorization for controller-owned commits (Step 1)
- [ ] Invoke `node <engine-root>/scripts/loop-engineer.mjs` with the exact fresh/resume CLI (Step 2)
- [ ] Report the controller's closed output without reconstructing or overriding state (Step 3)
- [ ] Preserve controller-owned lifecycle and terminal evidence (Step 4)
- [ ] Emit the exact Gear-4 `review` handoff for a terminal result (Step 5)

## Procedure

### Step 0 — Read the gear

This skill executes **gear 4 only**. There is no "Ceremony by gear" scaling and no inline
recompute.

Validate the manual handoff before any work-artifact read. Fresh entry accepts exactly:

```yaml
required:
  goal: <goal-path>
onDemand: none
```

Resume accepts the same exact required goal and may additionally authorize the exact existing
ledger as `onDemand.loop-ledger`; read it only to resume named state. An explicit bad envelope fails
closed without recovery. With no envelope, pathless recovery may inspect headers only on goal
contracts, never bodies, and must require user selection followed by a new exact envelope. Never
select by date or recency.

Require this complete preamble before reading the goal body:

```yaml
<!-- verdict: <COVERED|CONFLICT|GAP> | gear: 4 -->
<!-- steepy-workflow: v1
phase: goal-contract
status: READY
next: loop-engineer
source: none
consumed-by: none
-->
```

After one Markdown title, require exactly one canonical line for every mandatory body field:
`goal`, `surface`, `verifier`, `mode`, `budget`, `blast-radius`, and `notes`; metric mode also
requires `metric-direction`, while boolean mode forbids it. Require `mode: boolean | metric`,
`metric-direction: min | max` where applicable, a positive canonical integer `budget`, a registered
lowercase `surface`, a shell-free verifier argv, and safe repo-relative comma-separated blast-radius
globs. Reject duplicate, unknown, multiline, empty, or malformed fields.

The verdict header at the head of `goal.md` is the human-ratified authorization for autonomy. Fields below it may be pre-filled, but this execution skill does not author or complete that authorization.

Branch on three outcomes:

1. **`goal.md` with the exact gear-4 verdict/header AND all mandatory fields:** proceed.
2. **Header present but `gear` ≠ 4:** **refuse** — the task was classified elsewhere; never hijack it into a loop.
3. **`goal.md` absent, header missing, or ANY mandatory field missing:** **refuse before any iteration, branch mutation, or commit question**. Name every missing field and require a complete human-authored, gear-4-ratified goal contract before `loop-engineer` is invoked again. Do not route this through the generated project bootstrap: that bootstrap owns root/index navigation and semantic-skill routing only.

**Never recompute the gear inline** here and **never fabricate or interview for a field value**: a loop with no human-authored, ratified contract is exactly the silent autonomy the invariant forbids.

**Session declaration (declare, never block).** Say whether this conversation started clean for this
phase or has already run an earlier phase of the chain in the same session. A same-session phase
already grew the context, and every turn of this phase now pays to carry it — name that cost, but
never refuse or gate on it: this is a declaration about the conversation, not a measurement, and
sound work proceeds either way. If the session's history cannot be determined with certainty, say so
and proceed. Under `drive: autopilot` this declaration is a no-op: the conductor
(`scripts/autopilot.mjs`) already opens a fresh headless session per phase, so the discipline stated
here is already enforced by that mechanism, not by this prose.

### Step 1 — Load routed inputs and authorize the controller

Read `.apex/_INDEX.md` and require exactly one exact routing row for the goal's `surface`. For a
single-file route, carry its exact registered standard. For a modular route, carry the registered
core followed by only the matching leaves, preserving their mini-routing table order; zero matches
means core only. Pass this ordered inventory through Step 2 exactly. Never synthesize or manufacture
`.apex/standards/<surface>.md`, preload unrelated standards, or grant any child general
`.apex/work/**` access. If a mandatory field in the goal is missing, return to the **Step 0 refusal**; this
skill never completes the authorization artifact.

Select the current active harness only if `adapters/headless.mjs` has a supported headless mapping
for it. The current harness identity comes from the active runtime; do not ask the user to invent a
harness name. A missing mapping is `runner-unavailable`: stop or refuse without dispatch, mutation,
or an inline runner fallback. Native invocation syntax is never guessed.

After the contract and harness checks, ask exactly once before starting the controller:
**"Authorize controller-owned commits for this run?"** Both boolean and metric modes require `yes`.
A refusal ends before controller invocation. This authorization is for the complete fresh or resumed
run and is never delegated to a model child or re-asked per attempt.

### Step 2 — Invoke the packaged controller

Resolve `<engine-root>` from this skill's base directory and preserve each accepted path byte for
byte. The fresh invocation is exactly:

```bash
node <engine-root>/scripts/loop-engineer.mjs --repo-root . --goal '<goal-path>' --harness '<active-harness>' --commit-authorized --routing-index '.apex/_INDEX.md' --standard '<exact-standard-path>'
```

Fresh mode omits `--resume` and `--ledger`. The resume invocation is exactly:

```bash
node <engine-root>/scripts/loop-engineer.mjs --repo-root . --goal '<goal-path>' --harness '<active-harness>' --commit-authorized --routing-index '.apex/_INDEX.md' --standard '<exact-standard-path>' --resume --ledger '<loop-ledger-path>'
```

Repeat `--standard '<exact-standard-path>'` once per selected standard in the exact Step 1 order:
one flag for a single-file route, or core first and matching modular leaves after it.

Resume uses only the accepted `onDemand.loop-ledger` path; never derive or select another ledger.
Invoke the command once and let it run to its controller-owned terminal or halted result. The
controller owns the event stream, ledger lifecycle, prompt use (`loop-implementer-prompt.md` and
`loop-final-review-prompt.md`), attempts, verifier decisions, immutable evidence, commits, Git
reconciliation, and review budget. Do not emulate any of those operations when invocation fails.
The resume form is only for an interrupted run that has not recorded `RUN_HALTED`. A `HALTED`
result is permanently abandoned and not resumable. Preserve its goal, ledger, events, and evidence
unchanged; after the human resolves or accepts the condition, recovery requires a new ratified goal
at a distinct goal path and new loop workspace. Never delete or rewrite the abandoned state.

### Step 3 — Report controller output

Parse the controller's single JSON output. It has the closed summary fields `status`, `runId`,
`terminal`, `goal`, and `loop-ledger`. Report those values exactly; do not infer an outcome from the
goal or ledger and do not rewrite a controller status. `HALTED` with `terminal: false` is not terminal
completion: report the permanently abandoned result and require a new ratified goal at a distinct
goal path and new loop workspace, never a resume handoff. A nonzero
controller exit is a failure, not permission to run an inline substitute.

The terminal status domain is `GOAL_REACHED | BUDGET_EXHAUSTED | NO_IMPROVEMENT |
REVIEW_REJECTED`. Each is a completed run eligible for terminal review; only `GOAL_REACHED` claims
goal success.

### Step 4 — Preserve controller-owned lifecycle

For a terminal controller status, require `terminal: true` and require the exact returned paths to
equal the accepted goal and its accepted/derived canonical ledger path. That is the controller's
validated terminal result. Do not open, read, or parse the goal or ledger to recover lifecycle state,
and do not edit or repair either projection in prose. Fail only on controller-result or path mismatch;
preserve every artifact for exact resume or audit.

### Step 5 — Hand off

After the controller returns a validated terminal result and exact returned paths for `goal` and
`loop-ledger` paths match the accepted pair, emit the canonical Gear-4 review handoff below for
positive or negative terminal completion. Report those controller-returned paths verbatim. Do not
open their Markdown or emit the handoff for `HALTED`, a nonzero exit, or a result/path mismatch.

Alongside the envelope, emit the active harness's native review invocation when known. If native
invocation syntax is unknown or unavailable, do not invent syntax; emit only the canonical envelope.

```yaml
handoff: steepy-apex/v1
next: review
required:
  goal: <goal-path>
  loop-ledger: <loop-ledger-path>
onDemand: none
```

Run review in a new session: this phase's context does not serve review, and every turn of review
would otherwise pay to carry this phase's context.

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

---
name: plan
description: Turn a local working spec into a step-by-step implementation plan. Each step names the owning surface and specialist agent and the surface test command; the plan is written into .apex/work/plans/ as a gitignored work artifact.
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

# plan

Turn an approved spec into an implementation plan whose every task states the change it makes, not
the goal it chases, with review checkpoints.

> **Engine root:** this skill's base directory is `<engine-root>/skills/plan/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

## Checklist
0. In autopilot, read the supplied phase manifest first; then read the gear and scale ceremony to it (Step 0).
1. Load the spec and the hub (routing table + owning surface standard); in autopilot, match and
   record every implicated modular leaf (Step 1).
2. Map files and tasks.
3. Bind each task to the hub (surface, specialist agent, test command, complexity).
4. Write the plan into `.apex/work/plans/`.
4.5. Self-review the plan inline — free gate, gear 2 and 3 (Step 4.5).
5. Validate with `validate-hub.mjs` (deterministic gate).
6. Human review gate — ask the user to review the written plan before handoff (gear 3).
7. Hand off to the `implement` skill.

## Procedure

### Step 0 — Read the gear

**Autopilot preflight:** When the conductor's `phasePrompt` supplies a phase manifest, read that
manifest before any other task input. Validate its role and scope against the plan phase and the
supplied correlation identity. Eagerly read every `required` input before acting. Do not preload `onDemand`;
consult it only for a concrete named missing fact and record the read in the plan phase
output/report. Phase-manifest authority applies only when `drive: autopilot`; manual-drive discovery
remains Step 1's behavior.

**Manual/no-manifest preflight — before the gear read:** Accept the exact `spec` capability before any verdict or spec-body read. Manual drive has two exclusive manual entry paths:

For an explicit resume, also require `onDemand.output-plan` in the envelope (or an exact labeled
`output-plan` alongside the labeled spec). Validate that exact input/output pair using the common
publication table before the fresh-only READY input gate below: READY/DRAFT resumes work,
READY/READY is finish-consumption, and CONSUMED/READY is no-op after proof revalidation. No other
state is accepted. The output header must be `phase: plan`, `next: implement`, with `source` equal
to the accepted spec and `consumed-by: none`; a consumed spec must name this exact output.
Read the output body only for the named missing approval/proof or draft-progress facts, record that
reason there when resuming work, and do not reopen sibling work. A verified terminal pair goes
straight to Step 7 after any sole consumption repair, without writing another plan or repeating gates.

1. **Explicit binding.** If the user supplied a `spec` handoff envelope or an exact spec path,
   validate the literal binding and path safety before its header read. The path must be an exact
   safe repository-relative path and the role must be exactly `spec`; then inspect only its bounded
   `steepy-workflow` header and require `phase: brainstorm`, `status: READY`, and `next: plan`.
   Exact valid input is accepted. Missing, malformed, stale, wrong-state, or wrong-role input fails
   closed: report the literal defect and stop without discovery or inferred correction.
2. **Bounded recovery.** Only when no envelope or path was supplied, enumerate the immediate specs
   directory (`.apex/work/specs/`, no recursion), inspect only bounded `steepy-workflow` headers,
   list candidates whose header is exactly `phase: brainstorm`, `status: READY`, `next: plan` with
   path and compact header metadata, and require user selection even when there is exactly one candidate.
   Never open or read a candidate body. Headerless artifacts are ignored by
   recovery. If no candidate exists, tell the user to run the `brainstorm` skill (invoke it the way
   the active harness invokes skills) first and stop. After selection, obtain and validate the exact
   binding before continuing.

Do not read the selected spec's verdict or body until that exact binding is accepted.
Read the verdict artifact (`verdict` + `gear`) only from the accepted `.apex/work/` spec head.
- **Artifact present:** honor its gear.
- **Artifact present with `gear: 4`:** this task belongs to the autonomous loop; bounce to
  the `loop-engineer` skill and stop.
- **Artifact with `drive: autopilot` (gear 3):** this run is an unattended autopilot phase. Confirm
  that the contract agrees with the conductor-supplied phase manifest already read first. Apply the
  Step 6 autopilot branch below and never ask the user anything.
  An invalid manifest, missing required input, undeclared or unwritable output, or anything else
  unresolvable is a manifest/output failure: append `<ISO> — plan — BLOCKED — run-id=<conductor-supplied> attempt=<positive supplied> <reason>` to `.apex/work/tasks/<spec-basename>/autopilot-status.md`
  and exit non-zero.
- **Artifact absent and this is gear-1/2 work:** recompute the coverage verdict inline (COVERED /
  CONFLICT / GAP with `file:line` evidence → gear). Declare the recomputed
  verdict, gear, and evidence, then ask the user for one confirmation before the ceremony starts —
  the user may force a different gear, and the override is recorded in the verdict artifact. Then
  proceed.
- **Artifact absent and full gear-3 ceremony is required for this command:** do not proceed
  blind — tell the user to enter through the upstream workflow chain first, and stop.

Scale this skill's ceremony to the gear (see "Ceremony by gear" below). This skill dispatches **no
subagent reviewer**: a plan is prose, gated by the inline self-review (Step 4.5) plus a human review
of the written plan (Step 6), per `conventions.md` → "Review architecture (gear 3)".

**Autopilot correlation.** Before appending any current-protocol status marker, use the `run-id` and
positive `attempt` supplied by the conductor's `phasePrompt`; that correlated identity is authoritative.
Do not derive either value from filenames. Do not invent a correlation identity. A child without supplied run/attempt identity
is unresolvable: exit non-zero without appending an uncorrelated new-protocol marker. Only versioned, correlated status is supported; uncorrelated markers never complete a phase.

**Session declaration (declare, never block).** Say whether this conversation started clean for this
phase or has already run an earlier phase of the chain in the same session. A same-session phase
already grew the context, and every turn of this phase now pays to carry it — name that cost, but
never refuse or gate on it: this is a declaration about the conversation, not a measurement, and
sound work proceeds either way. If the session's history cannot be determined with certainty, say so
and proceed. Under `drive: autopilot` this declaration is a no-op: the conductor
(`scripts/autopilot.mjs`) already opens a fresh headless session per phase, so the discipline stated
here is already enforced by that mechanism, not by this prose.

### Ceremony by gear

- **Gear 1**: no plan needed — say so and stop.
- **Gear 2**: an optional light plan is enough; self-review it (Step 4.5); skip only the human
  question in Step 6, then perform the shared lifecycle transition.
- **Gear 3**: run the full procedure, including the Step 4.5 self-review and the Step 6 human gate.
- **Gear 4**: not this skill's entry point — bounce to the `loop-engineer` skill and stop.

### Step 1 — Load the spec and the hub

**Manual drive:** after Step 0 accepts the exact spec capability, continue with that path only.
After stable bootstrap orientation, eagerly read only the accepted spec body, then read the stable
routing inputs `.apex/_INDEX.md` and `.apex/testing-and-checklist.md`. Never open a sibling or linked
work artifact. The accepted `source`/`consumed-by` fields authorize no transitive read.

**Autopilot:** use the validated phase manifest loaded in Step 0 as the authoritative input
inventory. Do not independently rediscover or preload inputs beyond its `required` list; use the
recorded `onDemand` protocol only when a concrete fact is missing.

After reading the required spec, routing index, testing checklist, and core/single standards,
inspect each required modular core's mini-routing table. Match every row against the required
spec's exact paths/topics. Read every matching leaf already declared in `onDemand`; for each read,
record the concrete reason as the matching leaf plus the exact spec path/topic that matched. This
matching step makes an implicated leaf a concrete named fact needed for planning. Zero matches
means core only. Never read all leaves as a fallback. Never read an unrelated leaf, and never guess
or manufacture an undeclared path. A single-file standard remains fully loaded from
`required` with no leaf-selection step.

### Step 2 — Map files and tasks

List the files each task creates/modifies (exact paths). A task is mis-cut if its implementer must **discover** what to change: when its requirements can be stated only as a goal ("make X work," "write the section on Y") and not as a sketch of a diff to exact paths, the discovery is missing and belongs to `plan` — split the task, or add a discovery task upfront whose deliverable is the missing facts. This is the other half of what a task already needs: not just the exact paths, but the expected change at each path. Decompose into tasks, each ending in an independently testable deliverable.

**Wide refactors — expand → migrate → contract.** A **wide refactor** — one mechanical change
whose blast radius breaks callers across the whole codebase — must not be forced into tasks
that cannot land green. Sequence it: **expand** (add the new form beside the old — nothing
breaks), **migrate** (move call sites in batches sized by blast radius; each batch is an
ordinary sequential task, suite green between batches), **contract** (delete the old form when
no caller remains). No dependency-graph machinery — batches are ordinary sequential plan
tasks. "Wide" is strict: if the change lands green in one task, it is not wide.

### Step 3 — Bind each task to the hub

The plan is the complete spec-to-brief bridge. Every task uses this self-contained format:

Start every task with the canonical boundary `## Task <positive integer> — <short title>`; task
integers are unique and increase in execution order. Under it use the exact labels below. The
canonical criterion form is `- **Success criteria:** SC1, SC2`; the parser rejects alternate field names such as `Spec criteria`.

- **Requirements and deliverables:** exact behavior to implement and the independently testable result.
- **Relevant global constraints:** every spec-wide rule that applies to this task, repeated here rather than assumed.
- **Surface:** `<surface>` from the routing table.
- **Specialist agent:** the registered `<surface>-agent` that owns implementation.
- **Exact paths:** every created or modified repository-relative path; paths must be safe and exact.
- **Test command:** the surface's exact command from `.apex/testing-and-checklist.md`.
- **Dependencies:** prior task numbers, or `none`, in executable order.
- **Complexity:** `mechanical | integration | design` — mechanical = 1-2 files with a complete
  spec; integration = multi-file or judgment; design = architecture, high-risk, or subtle.
- **Success criteria:** every mapped success-criterion ID from the source spec.

Include all exact requirements and deliverables needed to materialize the downstream task brief.
No requirement may live only in conversation. If copying a large upstream section would make the
task unwieldy, reference it by canonical path + heading and state exactly which requirement it
supplies. `implement` reads this line (`Complexity`) to pick the model tier and decide whether the task gets its
own reviewer (Step 3.4).

### Step 4 — Write the local working plan

**Manual drive:** on a fresh run, choose an absent `.apex/work/plans/YYYY-MM-DD-<topic>.md` path;
an existing target requires the exact resume capability before reading or overwriting it. On resume,
retain the accepted `output-plan` path, never recalculate its date. After any verdict/contract metadata and before the title, write:

```yaml
<!-- steepy-workflow: v1
phase: plan
status: DRAFT
next: implement
source: <exact-spec-path>
consumed-by: none
-->
```

Then link back to its source spec with a relative work-area link:

`> Source spec: [<topic>](../specs/<YYYY-MM-DD-topic>.md)`

**Autopilot:** write the plan exactly to the single path declared by the authoritative phase
manifest's `outputs` list. Do not recompute the date or filename. Use that actual path in the
correlated `DONE` marker, and derive the relative source-spec back-link from its location.

Create `.apex/work/plans/` if it does not exist. Do not register the plan in `.apex/_INDEX.md` and do not create a plans sub-index. Plans are local workflow artifacts, not stable hub documentation.

### Step 4.5 — Self-review the plan (free gate)

**Gear 2 and 3** — skip only at gear 1 (no plan is produced there).

Read the plan you just wrote with fresh eyes and fix any of these inline — no re-review needed, just fix and move on:
1. **Every mandatory field** — each task contains exact requirements/deliverables, relevant global constraints, surface, specialist agent, exact paths, test command, dependencies, complexity, and success-criterion IDs; no placeholder (`TBD`, `TODO`) remains.
2. **Binding consistency** — every surface is a known surface in `.apex/_INDEX.md`, every specialist is its registered specialist agent, and every exact test command matches `.apex/testing-and-checklist.md`.
3. **Dependency ordering** — dependencies name existing earlier tasks, ordering is executable, and each task ends in an independently testable deliverable.
4. **Complexity present** — validate allowed complexity: each `Complexity` value is exactly `mechanical | integration | design` and matches the task text (a multi-file task marked `mechanical` is a bug).
5. **Criteria coverage** — every requirement and success criterion in the spec maps to at least one task; list and close any gap.
6. **Safe repository-relative paths** — every path is exact, stays inside the repository, and is owned by the task's declared surface.
7. **Context independence** — a downstream agent can implement the task from the plan/task brief without chat history; large references use canonical path + heading and state the supplied requirement.
8. **Discovery-free tasks** — no task's requirements are stated only as a goal ("make X work," "write the section on Y"); each names exact paths and the expected change at each path, or is split / preceded by a discovery task whose deliverable is the missing facts.

All checks must pass before appending autopilot `DONE` or asking for human approval.

### Step 5 — Validate (deterministic gate)

Run:

```bash
node <engine-root>/scripts/validate-hub.mjs .
```

It MUST print `steepy validate-hub: OK`. This skill never edits the stable hub, so any violation is pre-existing drift: report it and point the user to the `check` skill — do not fix the hub mid-plan. A plan under `.apex/work/plans/` is intentionally ignored by the linter and does not need registration or a stable back-link.

**Autopilot:** Before appending `DONE`, run the same canonical plan parse that the implement
phase will use:

```bash
node <engine-root>/scripts/autopilot-context.mjs --verify-plan --repo-root . --plan <authoritative-manifest-output-path>
```

It MUST print `plan OK`. A rejection is a fixable plan error: repair the plan, repeat the Step 4.5
self-review, and rerun both deterministic gates. Never append `DONE` for a plan this command has
not accepted.

### Step 6 — Human review gate and plan lifecycle

**Gear 3 only — human review gate.** A plan is prose. Every task it defines will pass under the per-task and
whole-branch code reviewers downstream, but the plan's *shape* — decomposition, spec coverage, task
ordering — is best caught by a human now. Do **not** dispatch a subagent. Tell the user:

> "Plan written to `<path>` — please review it and tell me if anything should change before we implement."

Wait for the response. On requested changes, edit the plan and re-run the Step 4.5 self-review.
Proceed only once the user approves.

**Gear 2 gate.** Ask no human-review question; the completed Step 4.5 self-review is the applicable
approval gate.

**Both gears.** Record the applicable approval and verification (Step 4.5, Step 5, and the human
approval or autopilot authorization) bound to the exact source/output paths and content before READY.
Only after those gates succeed, first atomically replace the plan to `status: READY` while retaining
`source: <exact-spec-path>`; then atomically replace the source spec to `status: CONSUMED` with
`consumed-by: <plan-path>`. Before publication, interruption leaves the spec READY and plan DRAFT;
between the two replacements, READY/READY is the sole repairable prefix. Use only the exact resume
capabilities and common proof checks to finish consumption; a finalized pair is an idempotent no-op.
Never repair a CONSUMED-spec/DRAFT-plan pair or consume an unverified plan.

Autopilot status timestamps must use UTC with three millisecond digits (`YYYY-MM-DDTHH:mm:ss.sssZ`), generated with `new Date().toISOString()`. The reader also accepts whole-second UTC timestamps (`YYYY-MM-DDTHH:mm:ssZ`) for compatibility.

**Autopilot:** If `drive: autopilot` is present in the verdict contract (Step 0), the human gate is superseded — this is a non-blocking checkpoint. The plan file is on disk; the human can interrupt the run. Skip the question, do NOT wait, and append `<ISO timestamp> — plan — DONE — run-id=<conductor-supplied> attempt=<positive supplied> <plan path>` to `.apex/work/tasks/<spec-basename>/autopilot-status.md` (spec filename without `.md`; the status file already exists). Step 4.5 self-review and Step 5 validate-hub still run and still gate.

### Step 7 — Hand off

Only after the applicable Gear-2 or Gear-3 gate and lifecycle transition succeed, tell the user the next step is the `implement` skill, using the
native invocation spelling only when the active harness provides it. In manual drive emit:

```yaml
handoff: steepy-apex/v1
next: implement
required:
  plan: <plan-path>
onDemand:
  source-spec: <spec-path>
```

Run the `implement` skill in a new session: this phase's context does not serve implementation, and every turn of the implement phase would pay to carry it forward.

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

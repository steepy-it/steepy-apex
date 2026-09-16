---
name: implement
description: Execute a READY Gear-2 spec directly or a hub-governed plan under TDD, scaling code-diff review and downstream handoff to the recorded gear.
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

# implement

Execute either a READY Gear-2 spec directly or an approved plan **one task at a time**. You
orchestrate; the bound `<surface>-agent` implements under rigid TDD. Gear 2 uses implementer
self-review plus deterministic gates and terminates here. Gear 3 additionally spends code-diff
reviewers and hands the result to the `review` phase.

> **Engine root:** this skill's base directory is `<engine-root>/skills/implement/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

## Execution discipline

Narrate at most one short line between tasks (e.g. "Task 2 approved, moving to Task 3") — the ledger and the tool results carry the record. Never ask "should I continue?" between tasks; execute the accepted input straight through. The only reasons to stop mid-run are an unresolved **BLOCKED** status, a genuine **NEEDS_CONTEXT** question from an implementer, a direct Gear-2 spec that requires decomposition, or all tasks complete.

## Checklist

- [ ] Autopilot (`drive: autopilot`): read the co-located `autopilot-protocol.md` and take verdict/gear/drive from its contract (Step 0)
- [ ] Manual/no-manifest: accept either the direct Gear-2 exact spec or the plan-backed exact plan + source-spec capabilities; never merge the alternatives (Steps 0–1)
- [ ] Derive the task directory, `ledger.md`, and task-result index solely from the accepted entry artifact basename; resume only with exact `progress-ledger` + `task-results` capabilities
- [ ] Ask once: confirm the working branch (if on `main`/`master`) and commit-after-each-task authorization — or read both from the autopilot contract (Step 2)
- [ ] Verify the Gear-3 task-result handoff parses before claiming completion; close Gear 2 locally after its deterministic gates (Step 5)
- [ ] Pre-flight: scan the accepted spec or plan once for internal conflicts, batching only plan-backed conflicts to the user (Step 2.5)
- [ ] Per task (sequential): brief → dispatch `<surface>-agent` (`implementer-prompt.md`) → diff → review (`task-reviewer-prompt.md`, gear 3 + non-mechanical only) → fix loop → mark complete
- [ ] After the last task: whole-branch review (`final-review-prompt.md`, gear 3 only) → fix loop
- [ ] Gear 3 only: hand off to the `review` skill with only criteria + task-results + branch-diff

## Procedure

### Step 0 — Read the gear

**Autopilot:** when the contract says `drive: autopilot`, read the co-located `autopilot-protocol.md`
first and follow its phase-manifest, correlation, status-marker, and task-local manifest protocol; it
takes precedence over the manual prose below for the steps it names.

**Manual/no-manifest:** There are two exclusive manual entry paths.

1. **Explicit binding.** Accept exactly one of these mutually exclusive fresh forms.

   Direct Gear-2 spec:

```yaml
handoff: steepy-apex/v1
next: implement
required:
  spec: <spec-path>
onDemand: none
```

   Plan-backed Gear 2 or Gear 3:

```yaml
handoff: steepy-apex/v1
next: implement
required:
  plan: <plan-path>
onDemand:
  source-spec: <spec-path>
```

   A resume handoff preserves its chosen form and additionally carries both
   `onDemand.progress-ledger: <ledger-path>` and
   `onDemand.task-results: <task-result-index-path>`; a plan-backed resume retains
   `onDemand.source-spec` as well. Instead of an envelope, accept a direct labeled form only when the
   user supplies either exact `spec: <spec-path>`, or both exact `plan: <plan-path>` and
   `source-spec: <spec-path>`, in the same request. A resume direct form must also label both exact
   resume paths. Never merge the two entry alternatives. A lone plan path grants no source-spec
   capability: reject it and stop before any work-artifact read, asking for the canonical envelope or
   both exact labeled bindings. Never infer the source-spec binding from the plan header.
2. **Bounded recovery.** Only when neither an envelope nor a direct binding was supplied, inspect
   bounded `steepy-workflow` headers in the immediate specs and plans directories,
   `.apex/work/specs/` and `.apex/work/plans/`; never open a candidate body and never recurse. List
   only `status: READY`, `next: implement`, `consumed-by: none` candidates whose phase is
   `brainstorm` or `plan`, and require user selection even when there is exactly one candidate. A
   selected spec requires a new exact `spec` binding. A selected plan grants no linked source-spec
   read: require a new canonical envelope carrying both plan-backed bindings. If no candidate exists,
   tell the user to run `brainstorm` for a direct Gear-2 spec or `plan` for a plan-backed run, then
   stop.

Any explicit missing, malformed, unsafe, wrong-role, wrong-state, stale, or provenance-mismatched
input stops without fallback or discovery. There is no most-recent selection.

On explicit resume, validate `onDemand.task-results` plus `onDemand.progress-ledger` against the
exact Step-1 derived paths before the fresh-only header gate below. Apply the common publication
table: READY/DRAFT resumes work, READY/READY is finish-consumption, CONSUMED/READY is no-op after
revalidating the recorded proof and exact reciprocal links. Read only the authorized index and
ledger for those named progress/proof facts. For a plan-backed entry, validate the accepted
source-spec header provenance below in every state; its spec-to-plan link is never rewritten.
On every resume, the ratified gear, input/output phase and next values, and source-spec provenance
checks remain mandatory before any terminal shortcut. Only the input READY status/consumed-by
condition is replaced by the common exact-pair table; a direct spec must still record gear 2.
A terminal pair skips task dispatch and goes to Step 5 only for consumption repair or the already
verified handoff; missing proof or a mismatched pair fails closed, never back to fresh execution.

Validate the selected primary header before reading its body (the following READY requirements
are fresh-only; the exact resume pair above is the sole exception):

- **Direct Gear 2:** require `phase: brainstorm`, `status: READY`, `next: implement`, and
  `consumed-by: none`. Read the verdict artifact and gear from that accepted spec head and require
  gear to be exactly 2. Gear 1 routes to its specialist, while Gear 3 requires the plan chain;
  reject either mismatch without mutation.
- **Plan-backed:** require `phase: plan`, `status: READY`, `next: implement`, and
  `consumed-by: none`. Validate exact bidirectional provenance using headers only: the plan's
  `source` must equal `onDemand.source-spec`. Read the source-spec header only after its exact
  capability has been accepted, then require that spec to be `CONSUMED` with `consumed-by` equal to
  the plan path. These header reads authorize no spec-body read.

Take verdict and gear from the accepted primary artifact's contract metadata when present. For the
plan-backed form, take them from the accepted plan's contract metadata and keep the source spec on
demand.
- **Artifact present:** honor its gear; a direct-spec artifact must remain Gear 2.
- **Artifact present with `gear: 4`:** this task belongs to the autonomous loop; bounce to
  the `loop-engineer` skill and stop.
- **Artifact absent and this is gear-1/2 work:** recompute the coverage verdict inline (COVERED /
  CONFLICT / GAP with `file:line` evidence → gear). Declare the recomputed
  verdict, gear, and evidence, then ask the user for one confirmation before the ceremony starts —
  the user may force a different gear, and the override is recorded in the verdict artifact. Then
  proceed. A direct-spec entry proceeds only when that confirmed gear is 2.
- **Artifact absent and full gear-3 ceremony is required for this command:** do not proceed
  blind — tell the user to enter through the upstream workflow chain first, and stop.

Scale this skill's ceremony to the gear (see "Ceremony by gear" below). This skill's subagent
reviewers run **only in gear 3** (Invariant 4: the expensive subagent is paid only where real
architectural judgement exists).

**Session declaration (declare, never block).** Say whether this conversation started clean for this
phase or has already run an earlier phase of the chain in the same session. A same-session phase
already grew the context, and every turn of this phase now pays to carry it — name that cost, but
never refuse or gate on it: this is a declaration about the conversation, not a measurement, and
sound work proceeds either way. If the session's history cannot be determined with certainty, say so
and proceed. Under `drive: autopilot` this declaration is a no-op: the conductor
(`scripts/autopilot.mjs`) already opens a fresh headless session per phase, so the discipline stated
here is already enforced by that mechanism, not by this prose.

### Ceremony by gear

- **Gear 1**: not an implement entry point (the navigation route identifies the specialist agent
  directly) — if invoked, say so and stop.
- **Gear 2**: implement with each agent's self-review plus `validate-hub` only — **skip the
  Step 3.4 task reviewer and the Step 4 whole-branch review** subagents.
- **Gear 3**: run the full loop — the whole-branch review always, and the per-task reviewer on
  tasks that carry real judgement (skip it for purely mechanical/transcription tasks; see Step 3.4).
- **Gear 4**: not this skill's entry point — bounce to the `loop-engineer` skill and stop.
- **Gear-3 refuse rule:** if invoked directly with no upstream spec/plan artifact present, refuse
  and bounce the user to the upstream workflow chain — do not fabricate the missing upstream.

### Step 1 — Load the accepted input and derive current-run artifacts

**Manual drive, plan-backed:** After the header and provenance gate, read the accepted plan body
eagerly. Do not preload the source spec, any sibling work artifact, transcript, prior-task report, or
work-area index. Read the exact accepted on-demand source spec only for a concrete named fact absent
from the self-contained plan (for example, materializing the criteria-only artifact). Before that
read, record the consumer role, exact path, and concrete reason in the derived current-run ledger.
Never infer a different source-spec path.

**Manual drive, direct Gear-2 spec:** Read the accepted spec body eagerly, then read the stable
routing index, owning surface standard, and testing checklist. Do not read a sibling spec, plan, or
other work artifact. Resolve the registered specialist, exact surface test command, and exact source
paths needed for one independently testable implementation task by inspecting ordinary repository
source. This is implementation preparation inside the current phase, not a plan artifact or a new
planning gate. If the work cannot be expressed as one independently testable task, stop before any
feature mutation, leave the spec `READY`, and offer the optional `plan` skill with that same exact
spec capability.

**Autopilot:** when `drive: autopilot`, follow `autopilot-protocol.md` for the input inventory and standard routing.

Derive `.apex/work/tasks/<entry-basename>/`, its optional `ledger.md`, and its canonical
`task-result-index.md` solely from the accepted spec or plan basename; never search for a historical
task directory or scan for a ledger/index. In manual drive, validate accepted
`onDemand.progress-ledger` and `onDemand.task-results` paths against those exact derived paths. If
either derived artifact exists without its exact capability, do not open it: stop and request a new
canonical resume envelope carrying both resume bindings. With matching capabilities, read only those
two exact artifacts for the concrete progress and terminal-repair checks. On a fresh run where
neither exists, create the current-run task directory and initialize the ledger; the index is created
below. Output creation grants no historical sibling-read capability. A one-present/one-absent pair is
malformed and fails closed. In autopilot, use the manifest-declared ledger/index inventory under its existing
protocol. A missing pair is normal on a fresh run, never a pre-spawn failure. If
`.apex/work/.gitignore` is missing (hubs scaffolded before init Step 4.5), create it with exactly:

```gitignore
*
!.gitignore
```

Same canonical body as `skills/init/SKILL.md` → "Step 4 — Complete the governed hub". Any task marked complete in the ledger is DONE — do not re-dispatch it; resume at the first task not marked complete.

On a fresh run, create `.apex/work/tasks/<entry-basename>/task-result-index.md` before dispatch as the
implementation primary. On an authorized resume, retain the existing index bytes and validate its
header/source before using its DRAFT progress or READY terminal-repair state. In Gear 3 use this exact
header and metadata immediately below it:

```yaml
<!-- steepy-workflow: v1
phase: implement
status: DRAFT
next: review
source: <plan-path>
consumed-by: none
-->
source-spec: <spec-path>
criteria: <criteria-path>
branch-diff: <branch-diff-path>
```

The metadata paths are repository-relative: `source-spec` is the accepted on-demand spec path;
`criteria` and `branch-diff` are the canonical `success-criteria.md` and `branch-diff.txt` siblings in
this current task directory. For Gear 2, whether direct or plan-backed, use the terminal form:

```yaml
<!-- steepy-workflow: v1
phase: implement
status: DRAFT
next: none
source: <spec-or-plan-path>
consumed-by: none
-->
source-spec: <spec-path>
```

Before terminalization, a failure or interruption leaves the accepted spec or plan `READY` and the
index `DRAFT`. The only permitted terminalization prefix is an index already `READY` while its input
is still `READY`; Step 5 repairs that exact prefix without re-dispatching work.

### Step 2 — Confirm branch and authorize commits (once per run)

Check the current branch (`git branch --show-current`). If it is `main` or `master`, ask in the same message as the commit question below: **"You're on `main` — work here, or switch to a new branch first?"** (suggest a name derived from the accepted input's topic if they want a new branch). Proceed on whichever they choose. If already on a non-`main`/`master` branch, skip this question silently — nothing to confirm.

Then ask: **"Commit after each reviewed-clean task this run?"** Here, Gear-2 "reviewed-clean" means
the implementer's required self-review; Gear 3 also applies its code-diff reviewer policy.

- **Yes** → each implementer commits its task after the suite is green; the ledger records the commit SHA range; Gear-3 reviews read the committed-range diff.
- **No** → no git command runs; reviews read the working-tree diff; the ledger records a `reviewed clean, no commit` marker; the user commits the branch at the end.

This is the only commit decision — honor it for the whole run.

**Autopilot:** when `drive: autopilot`, follow `autopilot-protocol.md` — do not ask either question.

### Step 2.5 — Pre-flight input scan

Before dispatching Task 1, scan the accepted input once for internal conflicts. For a plan, check
tasks that contradict one another or the Global Constraints, and anything the plan mandates that the
review rubric would treat as a defect. Present all plan findings as **one batched question** — each
finding beside the plan text that mandates it — and wait for the user to adjudicate before execution.
For a direct Gear-2 spec, resolve safe, implementation-local ambiguity from the routed standard and
repository source; anything that prevents one unambiguous, independently testable task stops before
mutation and routes to the optional plan instead of opening a new design dialogue inside implement.
If the scan is clean, proceed without comment; the applicable self-review/reviewer path remains the
net for conflicts that surface during implementation.

**Autopilot:** when `drive: autopilot`, follow `autopilot-protocol.md` — do not ask the batched question.

### Step 3 — Per-task loop (sequential; one implementer in flight)

For plan-backed work, execute each remaining task in plan order. For direct Gear-2 work, execute the
single derived Task 1 from the accepted spec. Use `<entry-basename>` in task paths below; it is the
plan basename for plan-backed work and the spec basename for direct Gear 2.

1. **Brief.** Materialize the task's complete contract at
   `.apex/work/tasks/<entry-basename>/task-N-brief.md`.
   - **Plan-backed:** copy these task fields and their values verbatim from the approved plan:
     **Requirements and deliverables**, **Relevant global constraints**, **Surface**,
     **Specialist agent**, **Exact paths**, **Test command**, **Dependencies**, **Complexity**, and
     **Success criteria** (criterion IDs).
   - **Direct Gear-2:** materialize a single self-contained Task 1 from the accepted spec and the
     Step-1 routed source inspection. Copy the approved requirements, constraints, Feature complexity,
     and every success-criterion ID from the spec; bind the owning Surface, registered Specialist
     agent, resolved Exact paths, exact surface Test command, and `Dependencies: none`. If those
     facts cannot describe one independently testable task, stop before mutation and offer the
     optional `plan` skill with the accepted spec path.

   In both forms, the brief is the implementer contract: no requirement may depend on chat or
   conversation history.
2. **Implement.** If your harness provides a task/subagent tool and the registered `<surface>-agent`, dispatch that agent using `implementer-prompt.md`. In autopilot (`drive: autopilot`), create and validate the implementer manifest per `autopilot-protocol.md`, then pass only its path plus scalar dispatch controls. In manual drive, pass the brief path, owning standard, surface test command, report-file path, and commit-authorization flag directly and record this no-manifest degradation in the ledger. Otherwise load the owning surface standard and implement the task inline under the same rigid TDD, then run the Step 3.4 review as a dedicated same-session pass at the end of the task; state the inline degradation in the ledger. Pick the model from the task's `Complexity` line: mechanical → cheap, integration → standard, design → most-capable. To override, record a one-line reason in the ledger. If the plan has no `Complexity` lines, classify the task yourself at dispatch; direct Gear 2 instead uses its mandatory `Feature complexity`. The implementer writes a **failing test** first (rigid TDD), then the minimum code, self-reviews, and reports.
3. **Diff.** Capture the change to `.apex/work/tasks/<entry-basename>/task-N-diff.txt` — `git diff <base>..<head>` if commits are authorized, else `git diff` of the working tree.
4. **Review** (**Gear 3 only** — skip in gears 1–2; rely on the implementer's self-review instead). Review only tasks that carry judgment; the task's `Complexity` line decides: `integration`/`design` → review, `mechanical` → skip (the Step 4 whole-branch review catches it). To override either way, record the reason in the ledger. When you do review, dispatch a fresh reviewer subagent using `task-reviewer-prompt.md`. In autopilot (`drive: autopilot`), create and validate its iteration manifest per `autopilot-protocol.md`; in manual drive pass the same four required artifacts directly and record the degradation. The hub index is never eager: include it only as `onDemand`, and read it only for a named suspected routing conflict whose reason is recorded. On **Issues Found**, require `task-N-issues.md`, then create and validate a fix manifest before dispatching the fix back to the same `<surface>-agent` (inline: apply the fix yourself). Regenerate the diff and re-review until **Status: Approved**. Fix loops remain sequential.
5. **Mark complete.** Append one line to the ledger, recording the model tier used — or `session model` where the harness gives no per-dispatch choice — and any degradation exercised (inline implementation, same-session review pass): `Task N: complete (model: standard, review: 1 iteration, commits <base7>..<head7>)` if authorized, else `Task N: complete (model: cheap, review: skipped (mechanical), no commit)`. On a harness with no task tool the line records the degradation, e.g. `Task N: complete (session model, inline impl + same-session review, 1 iteration, no commit)`. Also append the compact validated implementer outcome to `.apex/work/tasks/<entry-basename>/task-result-index.md` using this exact bullet grammar (one line per task, in execution order):

   `- Task <id>: <DONE|DONE_WITH_CONCERNS>; artifact: <sanitized repo-relative path>; changed-paths: <comma list or none>; signals: <short machine-readable IDs or none>`

   Never append an artifact body or use a shorthand result line; the conductor parses this exact grammar before review.

   Preserve `discovery:unplanned` verbatim from every validated implementer/fix result into the
   task-result index, retaining it through later fixes. It requires DONE_WITH_CONCERNS even when the
   final fix is otherwise clean. Ordinary concerns are not discovery: do not add this signal for
   transport degradation, a test reservation, or an unattributed DONE_WITH_CONCERNS. Missing or
   inconsistent attribution is a result-contract concern, not permission to infer a discovery.

Handle implementer status: **DONE_WITH_CONCERNS** — read the concerns first; **NEEDS_CONTEXT** — provide it and re-dispatch; **BLOCKED** — give more context, re-dispatch on a more capable model (add `escalated: <from>→<to>` to the task's ledger line), or split the task. Never force the same model to retry unchanged.

**Autopilot:** when `drive: autopilot`, follow `autopilot-protocol.md` for the no-human escalation and BLOCKED handling.

#### Artifact-first child protocol

Full detail lives only in authoritative repository artifacts. The implementer and each fix write or
update `task-N-report.md`. Each task reviewer writes findings and evidence to `task-N-review.md`; on
`ISSUES_FOUND`, it also writes the complete actionable set to authoritative `task-N-issues.md` for the
fix consumer. The whole-branch reviewer writes `final-review.md`; on issues it writes the complete set
to `final-review-issues.md`. A final-review fix receives that authoritative issue artifact through a
task-local fix manifest for the selected owning task, then the controller regenerates the aggregate
diff and re-reviews. Reports, findings, evidence, questions, concern prose, test output, and diffs never
live only in a child response.

Every child returns exactly four fields, in this exact order and with no bullets:

```text
status: <enum>
artifact: <sanitized repo-relative path>
changed-paths: <comma list or none>
signals: <short machine-readable IDs or none>
```

There are exactly four fields and no response headings. No headings, commits, tests, prose concern details,
diff, report, or test transcript may be in the response. Implementer/fix statuses are `DONE`,
`DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`; reviewer statuses are `APPROVED`, `ISSUES_FOUND`,
`NEEDS_CONTEXT`, or `BLOCKED`. NEEDS_CONTEXT, BLOCKED, and ISSUES_FOUND detail lives in `artifact`.

Before trusting a child result, validate the four-field shape, status, sanitized repo-relative artifact
path, and signals; also validate field order and comma-list-or-`none` changed paths.
A malformed envelope is never trusted: autopilot records correlated `BLOCKED` and exits; manual drive
records the explicit same-session/degraded handling in the ledger. The controller opens the artifact only when
its action status requires the next decision; otherwise it passes the artifact reference to
the next consumer. The ledger and task-result index record only the compact outcome and artifact reference,
never full detail.

### Multi-task artifact-flow proof

For Task 1 and Task 2, the parent accumulates only the four-field envelopes. Durable
`task-N-report.md` remains reachable to the task reviewer through its required manifest; durable
`task-N-issues.md` remains reachable to the fix through its required manifest; the compact
`task-result-index.md` plus aggregate branch diff remains reachable to the final reviewer. No artifact body
returns to or accumulates in the parent, and no prior task's body is copied into a later prompt.

### Step 4 — Whole-branch review

**Gear 3 only** — skip in gears 1–2.

After the last task, capture the aggregate branch change at `.apex/work/tasks/<plan-basename>/branch-diff.txt`
as the unmodified aggregate `git diff` and materialize the criteria-only `success-criteria.md` artifact:
give it canonical `Source`/`Heading` attribution (the repository-relative spec path and the exact source heading), then copy the approved success-criteria
content from that heading verbatim, including every criterion ID and no unrelated sections — the same
source bytes must produce the same artifact bytes. Both serve this whole-branch review.
Dispatch a fresh reviewer subagent using `final-review-prompt.md` over the full implement diff (all tasks)
and the criteria-only artifact. In autopilot (`drive: autopilot`), create and validate the final-review
manifest per `autopilot-protocol.md`. In manual drive, pass those same inputs directly
and record the no-manifest degradation. If your harness has no task tool, perform this whole-branch review
yourself in a fresh dedicated pass over the same inputs, stating the degradation in the ledger. Fix any
**Issues Found** with one fix dispatch carrying the complete list from `final-review-issues.md` (inline:
apply the fixes yourself), then regenerate the aggregate diff and re-review until **Status: Approved**.

### Step 5 — Hand off

**Gear 2 terminates here.** After every implementation task completes, self-verify each success
criterion against the resulting diff, run every distinct surface test command named by the direct
brief or optional light plan, then run:

```bash
node <engine-root>/scripts/validate-hub.mjs .
```

Both the surface test and `validate-hub` must be green; record their exact command outcomes in the
current-run ledger. Record the applicable approval and verification, exact input/output content
identities and current branch/HEAD or uncommitted diff identity in the index before publishing READY.
On failure before terminalization, leave the accepted input `READY` and the
result index `DRAFT`. On success, finalize in this recoverable order: first atomically replace the
index as `status: READY` while retaining `next: none` and its exact `source`; then atomically replace
the accepted spec or plan as `status: CONSUMED` with `consumed-by` equal to that index. If interrupted
between those writes, an exact resume carrying both `progress-ledger` and `task-results` must
revalidate the READY index's source, task results, and recorded green gates, then perform only the
input-consumption write. The fully finalized pair is an idempotent no-op. Any `CONSUMED` input paired
with a DRAFT/mismatched index fails closed instead of redispatching or guessing. For plan-backed Gear
2, do not rewrite the source spec's existing spec-to-plan provenance. Report the completed
implementation and deterministic gates. Gear 2 does not invoke or hand off to `review`; its
implementer self-review and these deterministic gates are its terminal assurance.

**Gear 3 only.** Only after the whole-branch review approves, tell the user the next step is the `review` skill
(invoke it the way your harness invokes skills). Run the `review` skill in a new session:
this phase's context does not serve review, and every turn of the review phase would pay to
carry it forward.

The handoff message must name the concrete inputs by repo-relative path so the fresh review session
starts from those files, not from this conversation's memory. Its payload is exactly:

```yaml
handoff: steepy-apex/v1
next: review
required:
  criteria: <criteria-path>
  task-results: <task-result-index-path>
  branch-diff: <branch-diff-path>
onDemand: none
```

Do not hand review the full plan or source spec. Before emitting this envelope, validate the index's
canonical header grammar, its three metadata paths, the criteria artifact's canonical `Source` and
`Heading` attribution against that metadata, and that `branch-diff` is the unmodified aggregate diff.

**Verify the handoff before claiming completion.** The review phase parses
`task-result-index.md` against the plan before it can build anything; a bullet that does not
match the Step 3.5 grammar fails there, after this phase has already spent its whole budget.
Run the same parse here, where it is still fixable:

```sh
node <engine-root>/scripts/autopilot-context.mjs --verify-handoff --repo-root . --plan .apex/work/plans/<plan-basename>.md --task-result-index .apex/work/tasks/<plan-basename>/task-result-index.md
```

Exit 0 prints the reviewed task IDs and this step continues. A non-zero exit names the exact
offending line: correct that line and re-run — never proceed on a rejected handoff.

Only after every task gate succeeds, the whole-branch review approves, and this handoff verification
succeeds, record that approval and verification bound to the exact input/output content, supporting
criteria/diff identities, and current branch/HEAD or uncommitted diff identity in the index before READY.
Then first atomically replace the index to `status: READY`; then atomically replace the accepted
plan to `status: CONSUMED` with `consumed-by` equal to the task-result index. Before publication the
plan remains READY and the index DRAFT; READY/READY is the sole permitted intermediate prefix.
An exact resume with progress-ledger and task-results capabilities revalidates the common proof,
the canonical index and recorded gates, then performs only the input-consumption write. A verified
CONSUMED/READY pair is a no-op, never another implementation or review dispatch. Missing evidence
or an impossible pair fails closed. Do not follow supporting paths as implicit read capabilities;
if the recorded proof cannot establish a current handoff, stop for the exact missing scope.

**Autopilot:** when `drive: autopilot`, follow `autopilot-protocol.md` for the final DONE status marker.

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

Translate the tier to a concrete model by judgment at dispatch time using your harness's available models. The three tiers are the whole ladder — `most-capable` is its top rung, not an open-ended "best available". A model that sits above that rung is outside the ladder: never reach it from a tier, and record a one-line reason in the ledger when you override to it. The whole-branch review runs at the reviewer tier — `standard`, rising to `most-capable` when the branch is large or subtle — not at whatever model the harness happens to offer. On a harness without per-dispatch model choice, everything runs on the session model — record that in the ledger.

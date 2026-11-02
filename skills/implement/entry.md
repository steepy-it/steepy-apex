# implement — Steps 0–2.5: gear, input, branch, pre-flight

### Step 0 — Read the gear

**Autopilot:** when the contract says `drive: autopilot`, read the co-located `autopilot-protocol.md`
first and follow its phase-manifest, correlation, status-marker, and task-local manifest protocol; it
takes precedence over the manual prose below for the steps it names.

In autopilot always follow `task-results-protocol.md`; the four-field and comma-list examples
below are the manual-drive grammar. Gear 4 keeps its separate loop contract.

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
`.apex/work/.gitignore` is missing, create it with exactly:

```gitignore
*
!.gitignore
```

Same canonical body as `skills/init/finish.md` → "Step 4 — Complete the governed hub". Any task marked complete in the ledger is DONE — do not re-dispatch it; resume at the first task not marked complete.

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

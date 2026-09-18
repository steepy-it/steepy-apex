---
name: review
description: Verify implemented work against its spec with real evidence before any "done" claim. Checks the spec's success criteria, runs the surface test command, and runs validate-hub.mjs as a mandatory coherence gate.
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

# review

Verify completed work with evidence. Never assert "done" without command output to back it.

> **Engine root:** this skill's base directory is `<engine-root>/skills/review/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

## Checklist

- [ ] In autopilot, read the supplied phase manifest first; then read the gear and scale ceremony to it (Step 0)
- [ ] Manifest-backed autopilot: load criteria-only source + task index + diff + standards, then match and record every relevant modular leaf; regular manual review: load accepted criteria + task-result index + branch diff + stable routed inputs; Gear 4: load the exact goal contract + loop ledger instead (Step 1)
- [ ] Run `capture-review-evidence.mjs` once: keep verbatim command output in the current run's
      `evidence-report.md`, consume only its compact JSON receipt, and judge every criterion in
      session (Step 2)
- [ ] For Gear 4, validate goal/ledger provenance and the ledger event commitment, then prove the
      exact claimed terminal outcome without confusing negative completion with goal success (Steps 1–2)
- [ ] Sweep unpromoted insights from the active inventory: manifest criteria + task-result index in autopilot; manual insight sweep uses only accepted criteria + task-result index compact status and `signals` (Step 2)
- [ ] Confirm the receipt contains a green `validate-hub` command result (Step 3)
- [ ] Report: `validate-hub` green AND every regular criterion or Gear-4 terminal claim verified
      from real command output
- [ ] Resolve the version bump (or apply `no-release`) and offer a PR to `main` only for regular
      review or Gear-4 `GOAL_REACHED`; suppress release/PR for negative terminal outcomes (Step 5)

## Procedure

### Step 0 — Read the gear

**Autopilot preflight:** When the conductor-supplied phase manifest is present, read that
manifest before any other task input. Validate its role and scope against the review phase and the
supplied correlation identity. Eagerly read every `required` input before acting. Do not preload `onDemand`;
consult it only for a concrete named missing fact and record the read in the review
report. Phase-manifest authority applies only when `drive: autopilot`; manual-drive discovery remains
Step 1's behavior.

Autopilot status timestamps must use UTC with three millisecond digits (`YYYY-MM-DDTHH:mm:ss.sssZ`), generated with `new Date().toISOString()`. The reader also accepts whole-second UTC timestamps (`YYYY-MM-DDTHH:mm:ssZ`) for compatibility.

**Manifest-backed autopilot:** Take the Step-0 scalar facts from `manifest.contract.verdict`,
`manifest.contract.gear`, and `manifest.contract.drive`. Require `drive: autopilot` and gear 3, and
honor the recorded verdict. Do not read or locate the spec: it is deliberately absent from the review
inventory, and the criteria-only required artifact supplies the review criteria. Apply the Step 4/5
Autopilot paragraph below and never ask the user anything. A manifest/output failure, success criteria
unmet, `validate-hub` red, or a CONFLICT discovered mid-run → append
`<ISO timestamp> — review — BLOCKED — run-id=<conductor-supplied> attempt=<positive supplied> <reason>`
to `.apex/work/tasks/<spec-basename>/autopilot-status.md` and exit non-zero. A CONFLICT discovered
mid-run is ALWAYS a halt — doc-wins needs a human, never auto-override.

Use the pinned `manifest.contract.taskResultProtocol` to interpret the task index. Protocol 2
requires the generated `steepy-task-results: v2` JSON block and exact `changedPaths` arrays;
legacy protocol 1 retains `- Task` bullets. Never split v2 filenames on commas or expand braces.
The conductor replays execution receipts and required task/final approvals before this phase;
the index is a projection, and a captured execution alone is never approval. This introduces no
reviewer permission to open receipt bodies, task reports, the plan, or the progress ledger. Missing
or drifted evidence fails closed; never infer historical baselines or silently upgrade a legacy run.
Manual drive and Gear 4 retain their existing grammar and capabilities.

**Manual/no-manifest:** Validate the manual handoff before reading any work artifact. Regular Gear-3
review fresh entry accepts exactly `criteria`, `task-results`, and `branch-diff` with `onDemand: none`;
regular resume adds only `onDemand.review-report`, the exact canonical report paired with that index.
Check existence of the canonical report derived from the accepted primary path without opening it.
An existing review report without its exact capability requires a stop before body reads or evidence
collection; do not overwrite it or select another report. Same-invocation output creation is not
historical resume authority.
Validate this pair before the fresh-only READY input gate: READY/DRAFT resumes verification,
READY/READY is finish-consumption, and CONSUMED/READY is no-op after the common proof checks.
Require `phase: review`, `next: none`, the exact index as report `source`, and `consumed-by: none`.
Read the authorized report only for those named progress/approval/proof facts. Verified terminal
pairs retain all supporting-input checks: on every resume, validate the accepted criteria and
branch-diff paths against the index metadata and their current content against the report's proof,
before any terminal shortcut. Only then go straight to the human envelope in Step 4 after any sole consumption repair; never rerun
release actions. Gear-4 review accepts exactly `goal` and `loop-ledger` with `onDemand: none` and
does not acquire this regular-review resume route. The task-result index (or the
Gear-4 ledger) is primary: fresh entry requires `READY` / `next: review`, then validate every supporting path and
its explicit provenance against it. An explicit malformed, stale, unsafe, or mismatched envelope is
an explicit failure and never falls back to discovery. With no envelope, pathless recovery may
inspect headers only on candidate task-result indexes (or loop ledgers), never bodies; require user
selection and then a new exact envelope. Never select by recency.
- **Artifact present:** honor its gear.
- **Artifact absent and this is gear-1/2 work:** recompute the coverage verdict inline (COVERED /
  CONFLICT / GAP with `file:line` evidence → gear). Declare the recomputed
  verdict, gear, and evidence, then ask the user for one confirmation before the ceremony starts —
  the user may force a different gear, and the override is recorded in the verdict artifact. Then
  proceed.
- **Artifact absent and full gear-3 ceremony is required for this command:** do not proceed
  blind — tell the user to enter through the upstream workflow chain first, and stop.

Scale this skill's ceremony to the gear (see "Ceremony by gear" below). This skill dispatches **no
subagent reviewer or evidence collector**: `capture-review-evidence.mjs` collects command output
inline and deterministically, while this session self-verifies every success criterion plus
`validate-hub`, per `conventions.md` → "Review architecture (gear 3)". Judgement is never delegated.

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

- **All gears**: run the surface test command and `validate-hub` through the deterministic inline
  capture in Step 2, and verify each success criterion yourself. There is no subagent evidence
  reviewer or collector. The complete command bytes are durable on disk; only the bounded receipt
  enters model context. Verification and judgement are never delegated, at any gear.
- **Gear 4**: review accepts gear-4 work. Verification is the re-run of the `verifier` from the
  goal contract, plus the loop ledger as evidence — alongside the existing self-verify above, not
  replacing it.

### Step 1 — Load bounded review inputs and the hub

**Manual drive, regular Gear 3:** Eagerly read exactly the accepted `criteria`, `task-results`, and
`branch-diff` artifacts. Never locate or read the spec, plan, progress ledger, task briefs, task
reports, task reviews, sibling work files, transcripts, or conversations. Treat `task-results` as
the primary and validate the criteria and diff paths plus explicit source metadata against it. Read
stable routing inputs normally: `.apex/_INDEX.md`, the routed stable standard(s), and
`.apex/testing-and-checklist.md` for the surface test command.

**Autopilot:** use the validated phase manifest loaded in Step 0 as the authoritative input
inventory. Its `required` inventory must provide the success-criteria source, task/result index,
aggregate diff, relevant standards, and test commands. Exclude per-task transcripts and
conversations: they are not review inputs. Do not independently preload them. Use `onDemand` only
under Step 0's concrete-missing-fact protocol, recording any such read in the report.

For each required modular core, inspect its mini-routing table. Match every row using only the
required criteria-only artifact, task-result index, and branch diff evidence. Read every matching
leaf already declared in `onDemand`; for each read, record the concrete reason as the matching leaf
plus the exact criteria, changed path, or indexed task signal that matched. This matching step makes
a relevant leaf a concrete named fact needed for review. Zero matches means core only. Never read
all leaves as a fallback. Never read an unrelated leaf. Never consult the spec, plan, ledger, or
transcripts to perform modular matching. A single-file standard remains fully
loaded from `required` with no leaf-selection step.

**Gear 4 has no spec and no plan.** Eagerly read exactly the accepted goal and loop-ledger paths;
the loop ledger is primary. The public capability remains exactly `goal` + `loop-ledger`: do not
derive or read `events.jsonl`, enumerate the loop directory, or expose any private event path to
model context. Resolve `<engine-root>` from the skill base and invoke this read-only proof boundary:

```bash
node <engine-root>/scripts/loop-engineer.mjs --repo-root . --validate-terminal --goal '<goal-path>' --ledger '<loop-ledger-path>'
```

The terminal validator accepts only that exact public pair, derives the canonical `events.jsonl`
identity internally, replays events as the sole authority, recomputes `events-sha256`, verifies the
goal digest plus `phase: goal-contract`, `status: CONSUMED`, and `consumed-by:
<loop-ledger-path>` for the goal and the `READY` ledger lifecycle. It binds every receipt fact and
event-derived ledger field to replay, recomputes the ledger digest, and accepts runtime-only fields
only in their closed canonical form. It also authenticates the event-bound reviewer report digest,
reviewer diff digest and bytes, final branch-diff projection, and current branch, HEAD, clean tree,
and snapshot against the retained event-derived branch. It performs zero lifecycle or Git mutation and returns one
closed bounded receipt; a nonzero exit or malformed/mismatched receipt means provenance is
unverified.

Require exactly `status: VALIDATED`, the accepted `goal` and `loop-ledger`, and the closed receipt
fields `run-id`, `outcome`, `goal-succeeded`, `events-sha256`, `mode`, `branch-review`,
`final-projection`, `attempt-budget`, and `candidate`. `branch-review` supplies exact `verdict`, `issues-found`, review
and attempt identities, report/diff paths, `report-sha256`, and `diff-sha256`; `final-projection`
supplies the authenticated diff digest plus current branch, HEAD, clean, and snapshot facts. `attempt-budget` supplies exact
`reserved`, `budget`, and `exhausted`; `candidate` supplies boolean-green or metric-baseline,
metric-best, and strict-improvement facts. Require `outcome` to be exactly `GOAL_REACHED |
BUDGET_EXHAUSTED | NO_IMPROVEMENT | REVIEW_REJECTED`, and `goal-succeeded: true` only for
`GOAL_REACHED`. Take these provenance facts from the receipt, never ledger assertions. The goal's
`verifier` is the active Gear-4 criterion. Read stable routed hub inputs normally; never select a
loop by recency.

### Step 2 — Verify against the active criteria source

For each success criterion in the active source, confirm it is met. In manifest-backed autopilot and
manual regular review the active source is the required criteria-only artifact.
Run the surface test command and preserve its **real, verbatim output** on disk; do not copy that
unbounded transcript into model context.

**Inline deterministic collection.** Resolve the current output path from the accepted primary
artifact, never by directory discovery:

- regular review: `.apex/work/tasks/<plan-basename>/evidence-report.md`;
- Gear 4: `.apex/work/loops/<slug>/evidence-report.md`.

Then run this once, passing each command as one safely quoted argument:

```bash
node <engine-root>/scripts/capture-review-evidence.mjs --repo-root . --evidence '<evidence-path>' --test-command '<exact surface test command>'
```

For Gear 4 append `--verifier-command '<exact verifier command>'`. The script always runs the
surface test, then the optional goal verifier, then `validate-hub.mjs`; it atomically replaces stale
evidence at the fixed path and streams combined stdout/stderr into the new report. It returns one
bounded JSON receipt on stdout with the artifact path, collection timestamps, aggregate pass state,
and, for every command, exit/signal/error state, output byte and line counts, SHA-256, and a bounded
tail excerpt. A tested command may be red while collection itself exits successfully: use
`allPassed` and each command's `passed`/`exitCode` fields to determine the review result.

Validate receipt schema version 1, the exact expected artifact path, timestamps from this review
round, and the ordered command labels (`surface-test`, optional `goal-verifier`, `validate-hub`). Do
not open or preload the complete `evidence-report.md`: the report is durable verbatim proof, while
the receipt is the context boundary. If a named criterion genuinely requires a fact absent from the
bounded excerpt, read only the smallest exact line or byte range needed from that report, record the
reason and range in the review report, and never fall back to a whole-file read. A malformed receipt,
hard capture failure, missing report, hash/metadata mismatch, or missing evidence means the affected
criterion is not verified; after fixing the cause, rerun the single capture so stale evidence is
replaced rather than merged.

The judgement stays here, in session: whether each success criterion is met, which swept insights
get promoted, and the final verdict are never delegated. No success criterion is declared met for
want of evidence.

**Gear 4:** the criterion is the goal contract and the authenticated terminal outcome, not a spec.
The same bounded capture runs the surface test, goal verifier, and `validate-hub` in that order.
Require the current capture receipt's surface test and hub gate to be green. Interpret the fresh
verifier result against the terminal-validator receipt; a red verifier is expected evidence for
`BUDGET_EXHAUSTED`, not by itself invalid execution. For metric mode, parse the verifier's final
stdout line as a finite scalar and compare it with the receipt's metric baseline using the goal's
`metric-direction`.

Apply this closed outcome proof:

- `GOAL_REACHED` requires boolean mode with a green verifier, or metric mode with a strict
  improvement over the reproduced metric baseline; it also requires an approved branch review via
  receipt `branch-review.verdict: APPROVED`, `issues-found: false`, `candidate.acceptable: true`, and
  `goal-succeeded: true`.
- `BUDGET_EXHAUSTED` requires boolean mode, a red boolean verifier, the full budget spent
  (`attempt-budget.reserved` equals `budget` and `exhausted: true`), and `goal-succeeded: false`.
- `NO_IMPROVEMENT` requires metric mode, a verifier value equal to the reproduced metric baseline,
  no strict improvement in the declared direction, `candidate.metric-strict-improvement: false`,
  the full budget spent (`attempt-budget.exhausted: true`), and
  `goal-succeeded: false`.
- `REVIEW_REJECTED` requires a goal-acceptable candidate: boolean mode must be green, or metric mode
  must show strict improvement over baseline. It never accepts a red boolean result or a metric
  equal to baseline. Also require receipt `candidate.acceptable: true`, unresolved review issues
  (`branch-review.verdict: ISSUES_FOUND` and `issues-found: true`), no remaining mutation budget
  (`attempt-budget.reserved` equals `budget` and `exhausted: true`), and `goal-succeeded: false`.

The authenticated terminal receipt is the controller-owned proof of event identity, exact
branch-review verdict/issues, and attempt-budget accounting. This review judges whether its terminal
outcome is faithfully reproduced; it never reconstructs attempt state from ledger prose. A mismatch
leaves the ledger READY and produces an issues verdict. For the insight sweep below, the only Gear-4
sources are the accepted goal's `notes:` and accepted loop-ledger fields.
Boolean candidate facts describe the retained branch: committed attempts update that state and
discarded review-fix attempts leave the prior retained verifier result unchanged.

**Insight sweep — run it always.** Work discovers knowledge as well as changing it. Use only sources
available in the active inventory:

- **Manifest-backed autopilot:** sweep the criteria-only artifact and task-result index. Their criterion
  IDs, `signals`, and `DONE_WITH_CONCERNS` entries are the declared insight evidence; do not locate the
  full spec, plan, progress ledger, or per-task transcripts.
- **Manual/no-manifest:** sweep only the accepted criteria artifact plus compact status and `signals`
  in the accepted task-result index, specifically its `DONE_WITH_CONCERNS` entries and `signals`.
  Never locate richer upstream or sibling artifacts.

A recorded **discovery** occurrence — an implementer that had to discover what to change rather than
execute the brief, with DONE_WITH_CONCERNS and `discovery:unplanned` — is a rebuttal to `plan`'s
task-cutting criterion (a task that looked pre-decided but wasn't). Report it distinct from other
concerns. In both regular-review branches, derive discovery evidence only from the accepted task-result index
and use the accepted criteria artifact for any mapped criterion; do not invent a criterion absent
from that artifact or read the plan to reconstruct one.

### Discovery signal interpretation

| Status | Signal | Interpretation |
| --- | --- | --- |
| DONE_WITH_CONCERNS | discovery:unplanned | unplanned-discovery |
| DONE_WITH_CONCERNS | other-or-none | ordinary-or-unattributed-concern |
| DONE | discovery:unplanned | inconsistent-result |
| DONE | other-or-none | no-discovery-evidence |

Never infer discovery from DONE_WITH_CONCERNS alone. Ordinary or unattributed concerns stay distinct;
an inconsistent result is reported as a contract defect, not a confirmed occurrence. Signal matching
is by the exact comma-delimited ID, never substring or a similar-looking spelling. No richer source
or per-task file read is authorized by a concern. Absence of the signal is no discovery evidence,
not proof that no discovery happened.

For each candidate: already promoted → cite the stable doc `file:line`; still valuable → propose the promotion to the user (glossary, conventions, surface standard, README); no longer holds → drop it with a one-line reason.

**Autopilot:** a promotion candidate is never a blocker on its own — Step 0's "never ask; unresolvable → BLOCKED" governs things the run cannot finish without a human, not documentation opportunities. Carry every candidate into the Step 4 report instead, for the human to act on at gate 8.

If the work changed a durable convention, standard, domain term, architecture decision, user-facing workflow, or README behavior, verify that the durable knowledge was promoted into stable versioned docs (`.apex/standards/`, `.apex/conventions.md`, `.apex/glossary.md`, README, or another stable doc).
Specs and plans themselves are not sufficient evidence of durable documentation.

### Step 3 — Run the coherence gate (mandatory)

The Step 2 capture runs the hub linter as its final command — this is required, not optional:
terminal review is the sole Gear-4 owner of this gate, and the loop controller does not claim it.

```bash
node <engine-root>/scripts/validate-hub.mjs .
```

Require the current receipt's final command to have `label: validate-hub`, `passed: true`, and
`exitCode: 0`; its bounded excerpt must show `steepy validate-hub: OK`. The report path, current-run
timestamps, output SHA-256, byte count, and line count bind that receipt to the verbatim transcript
on disk. Do not copy or read the complete transcript merely to satisfy this gate.

The work is **not done** until this prints `steepy validate-hub: OK`. If it reports violations in stable docs (orphan stable doc, broken stable link, routing mismatch, or a stable link into `.apex/work/**`), the change is incomplete. Fix the stable docs before claiming completion.

### Step 4 — Report

Report, with evidence: tests pass/fail (with output), every active criterion or Gear-4 terminal
condition met or not, and the gate outcome. Regular review is reviewable as complete only when
`validate-hub` is green and every success criterion is backed by real command output. Gear-4 review
is reviewable as complete when the surface test and hub gate are green and every condition for its
claimed terminal outcome is proven from the bounded receipt plus accepted provenance.

A faithfully proven negative outcome (`BUDGET_EXHAUSTED`, `NO_IMPROVEMENT`, or `REVIEW_REJECTED`)
may receive an approved terminal review. Record it explicitly as terminal completion, not goal
success, and retain `goal-succeeded: false` in the judgement. Approval confirms faithful execution
and evidence; it never rewrites the controller outcome to `GOAL_REACHED`.

Persist this review phase's criterion-by-criterion judgement in
`.apex/work/tasks/<plan-basename>/review-report.md`; for Gear 4 use
`.apex/work/loops/<slug>/review-report.md`. Cite the evidence artifact plus command hashes and compact
receipt fields instead of duplicating command transcripts. Write this terminal review report before
consuming the ledger. For Gear 4, include the outcome, goal-success boolean, provenance checks,
terminal-condition matrix, and exact receipt hashes. For Gear 4 only, after the report is complete and every
applicable gate is green, consume the READY loop ledger into
`review-report.md` by setting `status: CONSUMED`, `next: none`, and
`consumed-by: <review-report-path>`. A faithfully proven negative outcome is consumed by the same
terminal-review lifecycle. A Gear-4 interruption or proof mismatch leaves the primary `READY`.
Regular review instead follows the ordered index/report publication below.

**Regular Gear 3 publication and resume.** Create a fresh report only at an absent canonical path;
an existing report requires its exact resume capability, never an overwrite or most-recent fallback.
Start its workflow header before the title as:

```yaml
<!-- steepy-workflow: v1
phase: review
status: DRAFT
next: none
source: <task-result-index-path>
consumed-by: none
-->
```

Record the exact criteria/index/diff identities, current branch/HEAD or uncommitted diff identity,
applicable approval and current receipt-backed verification before publication. After all criteria
and gates pass, first atomically replace the report as `status: READY`; then atomically replace the
task-result index as `status: CONSUMED`, `next: none`, `consumed-by: <review-report-path>`.
Interruption before publication leaves READY/DRAFT;
after publication READY/READY is the sole verified prefix. An exact resume revalidates the common
proof and accepted criteria/index/diff before performing only the input-consumption write. The
verified CONSUMED/READY pair is an idempotent no-op; absent proof, a changed input/diff, or an
impossible pair leaves all artifacts untouched and fails closed. Gear-4 lifecycle remains governed
by its separate terminal proof above, not this regular index/report resume table.

Place the human action immediately beside this terminal envelope; emit no native skill invocation:

```yaml
handoff: steepy-apex/v1
next: human
required:
  evidence: <review-report-path>
onDemand: none
```

**Human action:** inspect the evidence and choose the version-bump/PR action in Step 5.

**Gear-4 negative terminal outcome:** replace that human action with: inspect the evidence; there is
no release or PR offer for this outcome. Suppress Step 5 completely. A new goal contract, ratified
by a human for Gear 4, is required for another run; neither this review nor the consumed ledger grants more
mutation budget.

**Autopilot:** If `drive: autopilot` is present in the verdict contract (Step 0), stop here — this is
the last unattended phase of the run, and the bump/PR decision below (Step 5, gate 8) stays human by
explicit spec ruling. After the report above, append
`<ISO timestamp> — review — READY_FOR_PR — run-id=<conductor-supplied> attempt=<positive supplied> <one-line verdict>` to
`.apex/work/tasks/<spec-basename>/autopilot-status.md` and end the session: no version bump, no
CHANGELOG edit, no PR, no Step 5 question. The run's artifacts and this report stay on disk for a
human to pick up Step 5 later, in an interactive session.

### Step 5 — Offer a pull request

This step applies to regular review and a successfully proven Gear-4 `GOAL_REACHED` only. A Gear-4
negative outcome has already stopped at Step 4 with no release/PR offer and a requirement for a new
goal contract before another run.

Check the current branch. If it is `main`/`master`, or has no commits ahead of `main`, stop here — there is nothing to propose.

**Applicability check:** this bump step is repo-local, not a plugin feature — `review` runs in any repo the plugin is installed in, but the bump machinery lives in the target repo. Only proceed when the current repo owns it: `scripts/bump-version.mjs` AND `.github/workflows/version-gate.yml` both exist at the repo root. If either is missing, skip straight to asking about the PR below.

Otherwise, resolve the version bump before opening the PR:
1. **Derive the bump type from the accepted criteria, task-result index, and branch diff** (gear 4:
   from the accepted goal contract and authenticated terminal facts): bugfix → `patch`, feature →
   `minor`, breaking change → `major`. If that evidence is insufficient, ask the human to resolve
   the ambiguity; no spec, plan, ledger, or per-task report read is authorized to derive the bump.
2. **Ask one confirmation question**: state the proposed type and the derivation, e.g. "This looks like a `minor` bump (new feature) — bump the version before the PR?"
3. **On confirm**: run `node scripts/bump-version.mjs <type>` (repo-local tooling, not an engine script — resolve it against the target repo, never `<engine-root>/scripts/`, which would bump the engine's own manifests from any repo), add a `## vX.Y.Z (YYYY-MM-DD)` section at the top of `CHANGELOG.md` (below the `# Changelog` title) with short factual bullets summarizing the change, and commit the bump + changelog as one commit on the branch (e.g. `vX.Y.Z`).
4. **Alternatively, if the work must not ship a release** (docs-only, CI-only): skip the bump and apply the `no-release` GitHub label to the PR instead (`gh pr edit --add-label no-release`, or `--label` at creation).

The `Version gate` workflow fails an unbumped PR that lacks the `no-release` label; the tag and GitHub Release are created automatically on merge by the `Release` workflow.

Then ask the user: **"Work is reviewed clean on `<branch>`. Create a PR to `main`?"** On confirmation, push the branch and create the PR following the repo's PR conventions; report the PR URL.

Whatever comes next — a new chain or a fix round — belongs in a new session: this phase's context does not serve it, and every turn there would pay to carry it forward.

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

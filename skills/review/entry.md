# review — Steps 0–1: gear and bounded inputs

### Step 0 — Read the gear

**Autopilot preflight:** When the conductor-supplied phase manifest is present, read that
manifest before any other task input. Validate its role and scope against the review phase and the
supplied correlation identity. Eagerly read every `required` input before acting. Do not preload `onDemand`;
consult it only for a concrete named missing fact and record the read in the review
report. Phase-manifest authority applies only when `drive: autopilot`; manual-drive discovery remains
Step 1's behavior.

Autopilot status timestamps must use UTC with three millisecond digits (`YYYY-MM-DDTHH:mm:ss.sssZ`), generated with `new Date().toISOString()`.

**Manifest-backed autopilot:** Take the Step-0 scalar facts from `manifest.contract.verdict`,
`manifest.contract.gear`, and `manifest.contract.drive`. Require `drive: autopilot` and gear 3, and
honor the recorded verdict. Do not read or locate the spec: it is deliberately absent from the review
inventory, and the criteria-only required artifact supplies the review criteria. Apply the Step 4
Autopilot paragraph in `finish.md` and never ask the user anything. A manifest/output failure, success criteria
unmet, `validate-hub` red, or a CONFLICT discovered mid-run → append
`<ISO timestamp> — review — BLOCKED — run-id=<conductor-supplied> attempt=<positive supplied> <reason>`
to `.apex/work/tasks/<spec-basename>/autopilot-status.md` and exit non-zero. A CONFLICT discovered
mid-run is ALWAYS a halt — doc-wins needs a human, never auto-override.

Use the pinned `manifest.contract.taskResultProtocol` to interpret the task index. In autopilot
the task index is the generated `steepy-task-results: v2` JSON block with exact `changedPaths`
arrays; manual drive keeps `- Task` bullets. Never split v2 filenames on commas or expand braces.
The conductor replays execution receipts and required task/final approvals before this phase;
the index is a projection, and a captured execution alone is never approval. This introduces no
reviewer permission to open receipt bodies, task reports, the plan, or the progress ledger. Missing
or drifted evidence fails closed; never infer historical baselines.
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

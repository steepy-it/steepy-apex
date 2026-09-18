# Reviewer response gate (Gear 3 autopilot)

This protocol applies to task and whole-branch reviewers, including valid first responses.
The implement skill orchestrates dispatch; `scripts/reviewer-response.mjs` supplies deterministic
validation and create-only evidence. Before accepting implement DONE, the conductor independently
replays the required task receipts and final receipt. The helper does not dispatch a model or
implement a task itself.
Manual drive uses the same response semantics and records its existing no-manifest degradation.

## Before dispatch

Finish the review manifest and diff first. No implementer, fix, or other repository writer may run
between the baseline and the review gate. Select `task-N` (task reviewer) or `final` (whole branch),
the conductor's phase attempt, and the review iteration. Use this exact state prefix in the current
task directory: `<scope>-review-guard-attempt-<attempt>-iteration-<iteration>`. Record the exact
prefix and run/attempt/task/iteration in the ledger **before** the baseline. On resume retain this
identity; never allocate a new iteration merely to replenish a response-correction budget.

```sh
node <engine-root>/scripts/reviewer-response.mjs --repo-root . --action begin --state <prefix> --run-id <supplied-run-id> --attempt <supplied-attempt> --iteration <iteration> --task <N-or-final> --report <exact-review-path> --issues <exact-issues-path>
```

The helper creates versioned baseline evidence. Its snapshot covers branch, HEAD, index, tracked
source files and nonignored untracked source files outside `.apex/work/`, including contents, modes
and symlink targets. Work bodies are read only through the exact authorized artifact paths. Gitignored
files are outside this Git observation; this is not an OS sandbox or a proof of transient writes.
The two exact review outputs are checked separately; guard state is stored in four exact files.
Review artifacts remain physically confined ordinary files. Code changes, even with
`changed-paths: none`, block. Do not reset or silently repair such changes.

The provider-neutral adapter `adapters/reviewer-response.mjs` applies the shipped
`reviewer-response.schema.json` to every returned payload locally. Native schema-constrained
generation remains optional: supply that schema only if the dispatch API supports it. Its literal
`none` constraint is specific to reviewers. For a JSON response, begin with `--format json` and send the exact JSON payload to check/correct;
the adapter validates it without changing values. Default `--format text` uses the four ordered
lines. Do not turn invalid JSON into a synthesized valid text response. If the
API cannot constrain responses, retain the four-line text contract; do not invent a schema flag
or claim native constrained-output support. The deterministic validator is required in both cases.

## Validate, then at most one response-only correction

Feed the exact returned four-line response to stdin of:

```sh
node <engine-root>/scripts/reviewer-response.mjs --repo-root . --action check --state <prefix>
```

Preserve the response verbatim; never replace a returned path with `none`. The helper first checks
repository state independently, then validates fields, status, literal `none`, exact role/status
artifact binding, signals, and the artifact. An Approved report alone never completes a task.
Only an accepted APPROVED receipt permits completion; accepted ISSUES_FOUND routes to the fix.
BLOCKED or NEEDS_CONTEXT follows the existing correlated BLOCKED handling.

Only a response with valid status, exact artifact, and valid signals, whose sole defect is a
non-`none` changed-path list, is REPAIRABLE. The verdict must be APPROVED or ISSUES_FOUND, and the
required artifacts must exist and be nonempty. Empty responses, extra fields, unknown verdicts,
wrong artifacts, and ambiguous data block immediately. Report Markdown has no machine verdict
grammar: the helper never infers approval by parsing a Status line.

On REPAIRABLE only, reserve the single correction **before** dispatch:

```sh
node <engine-root>/scripts/reviewer-response.mjs --repo-root . --action reserve --state <prefix>
```

A successful reservation is consumed even if the process crashes before or during dispatch. Give
the same reviewer (or a response-only replacement if continuation is unavailable) only the original
review identity, exact report/issue paths, exact original evidence path `<prefix>-original.json`,
and the validator reason. This is an explicit role-local capability for response recovery; it does
not authorize reading other work artifacts. Use the same reviewer tier and schema when supported.
The correction instruction is:

> Correct only your four-field response for this same review. Read the supplied original response
> evidence and your existing report as needed. Do not repeat implementation, fixes, tests, or review;
> do not write any file or alter status, artifact, or signals. `changed-paths` describes application/repository source
> changes and excludes the authorized review/issue artifacts; this role must return literal `none`.
> Return exactly status, artifact, changed-paths, signals, in that order, with no additional prose.
> If you cannot preserve those three fields truthfully, return BLOCKED; this terminates recovery.

Feed that exact response to `--action correct --state <prefix>` using stdin. The helper verifies
repository state and frozen report/issue hashes again, then applies the full envelope validator.
Status, artifact, and signals must exactly match the original validated identity.
An invalid correction, changed artifact, or unauthorized code change blocks without another retry.
The helper retains original and corrected responses in separate create-only evidence files.
Append correlated BLOCKED and exit on any helper failure or negative terminal receipt.

## Bind receipts to the implementation handoff

After an accepted task APPROVED receipt, register this exact active reference beside its compact task result:
`Reviewer gate Task N: <exact-state-prefix>`. Every integration/design task requires a receipt;
a mechanical task may omit it, or supply a valid receipt if reviewed. This deterministic floor does
not permit prose-only overrides that skip an integration/design task's review.

Before final-review dispatch, register `Reviewer gate final: <exact-final-state-prefix>` using:

```sh
node <engine-root>/scripts/reviewer-response.mjs --repo-root . --action bind-reference --task-result-index <exact-index-path> --state <exact-state-prefix>
```

This command creates a missing reference. After a genuine Issues Found → fix cycle, supply
`--previous-state <exact-old-prefix>` to atomically replace the one active reference with the newer
iteration. The same command handles task references. Never append a second reference for the same
role: duplicates remain errors. Repeating the already-applied update is a no-op; a stale previous
reference or a backward iteration is refused. Prior guard evidence and attempt logs are untouched.
Response-only recovery retains its existing reference and does not allocate a new iteration.

Begin the final gate with the normal arguments plus `--plan <exact-plan-path>
--task-result-index <exact-index-path>`. The parent helper, not the reviewer, uses those exact inputs
to bind the entire plan text, compact results, and validated task receipts. This adds no plan read
to the final reviewer's manifest. Freeze these inputs through final approval; lifecycle header
changes in the result index remain permitted. In the plan's canonical leading workflow header
(after optional verdict metadata), only `status: READY` → `CONSUMED` and `consumed-by: none` → the
exact bound index are normalized. Requirements, exact paths, dependencies, constraints, source,
metadata, and all other plan bytes remain bound. Changing them, task results, or receipt references
invalidates the approval.
All authorized code commits must precede this final baseline, because changing HEAD invalidates it.

Before publishing implement DONE, invoke:

```sh
node <engine-root>/scripts/reviewer-response.mjs --repo-root . --action verify-handoff --plan <exact-plan-path> --task-result-index <exact-index-path> --run-id <supplied-run-id> --attempt <supplied-attempt>
```

The conductor repeats this check before PHASE_ACCEPTED and before a resumed review phase. It
requires final approval with verified run/attempt provenance, validates each required task proof
against its phase-attempt manifest, checks frozen artifacts, and checks the final Git snapshot.
Missing receipts, substituted results, and stale correlation halt even if the child writes DONE.
Historical task snapshots are not compared to current code after later tasks: final review covers
that aggregate state. Exact refs are capabilities; no guard-directory discovery is permitted.

## Resume

Keep already completed ledger tasks complete; never re-open their old review gates after later code
changes. For the pending review transition only, use the exact state prefix recorded in the
authorized ledger. Run `--action inspect --state
<prefix>` to revalidate existing evidence against current code and artifact hashes. Every stored record has
a closed versioned schema; replay validates correlation and reservation linkage and recomputes
the outcome from the retained response and observations. A stored accepted flag is never authority. An accepted
receipt may resume the pending completion/fix transition; reconcile ledger/index entries first so
already completed tasks remain complete. REPAIRABLE with no reservation may take its one reserved
correction. A reservation without a corrected result is ambiguous and blocks; it never redispatches.
If final approval already exists from an earlier implementation attempt, retain its exact prefix,
run ID and attempt. The resumed skill's verify-handoff command adds `--resume-final <exact-prefix>`
while passing the new conductor-supplied run/attempt as usual. It revalidates the old approval and
both attempt manifests without rewriting any receipt. The conductor independently captures that
approval before dispatch, requires a matching prior conductor-owned SPAWNED identity, and checks
the same evidence digest again before accepting DONE. It records REVIEW_APPROVAL_REUSED in the
new attempt and also revalidates the retained proof when the later review phase is resumed.
Changed code, reports, plan, index outcomes, or receipt content cannot reuse that approval.

Missing baseline/original evidence also blocks recovery; do not manufacture a historical baseline.
A pre-upgrade halt therefore preserves implementation and reports but needs a fresh read-only review
of that existing diff, never another implementation, to establish verifiable evidence.

Do not overwrite reports, fixes, prior attempt logs, manifests, ledger completions, or guard evidence
on resume. New phase attempts retain their own logs. This helper does not rewrite any progress or
conductor status file. A later genuine code fix starts a new review iteration with a new baseline;
it is distinct from response-only correction.

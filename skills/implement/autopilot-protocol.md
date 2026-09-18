# implement — autopilot protocol

> Read this file only when the Step 0 verdict contract says `drive: autopilot`. In manual drive it is
> never read — the manual-drive path in `SKILL.md` stays self-contained. This file carries the
> conductor phase-manifest protocol, the correlated BLOCKED/DONE status-marker protocol, and the
> task-local manifest protocol, keyed to the `SKILL.md` step it supplements.

## Step 0 — phase manifest, scalars, and correlation

**Autopilot preflight:** When the conductor's `phasePrompt` supplies a conductor-supplied phase manifest,
read that manifest before any other task input. Validate its role and scope against the implement phase
and the supplied correlation identity. Eagerly read every `required` input before acting. Do not preload
`onDemand`; consult it only for a concrete named missing fact and record that read in the ledger. This
phase-manifest authority applies only when `drive: autopilot`; manual-drive discovery remains Step 1's
behavior.

Autopilot status timestamps must use UTC with three millisecond digits (`YYYY-MM-DDTHH:mm:ss.sssZ`), generated with `new Date().toISOString()`. The reader also accepts whole-second UTC timestamps (`YYYY-MM-DDTHH:mm:ssZ`) for compatibility.

**Manifest-backed autopilot:** Take the Step-0 scalar facts from `manifest.contract.verdict`,
`manifest.contract.gear`, and `manifest.contract.drive`. Require `drive: autopilot` and gear 3, honor
the recorded verdict, and do not read or locate the spec merely to rediscover contract metadata. Apply
the Step 2 autopilot paragraph below and never ask the user anything. An invalid phase manifest,
missing required input, undeclared or unwritable output, or anything else unresolvable → append
`<ISO timestamp> — implement — BLOCKED — run-id=<conductor-supplied> attempt=<positive supplied> <reason>`
to `.apex/work/tasks/<spec-basename>/autopilot-status.md` and exit non-zero.

**Autopilot correlation.** Before appending any current-protocol status marker, use the `run-id` and
positive `attempt` supplied by the conductor's `phasePrompt`; that correlated identity is authoritative.
Do not derive either value from filenames. Do not invent a correlation identity. A child without supplied run/attempt identity
is unresolvable: exit non-zero without appending an uncorrelated new-protocol marker. Only versioned, correlated status is supported; uncorrelated markers never complete a phase.

## Step 1 — input inventory and standard routing

**Autopilot:** use the validated phase manifest loaded in Step 0 as the authoritative input inventory.
Do not independently rediscover or preload inputs beyond its `required` list. Use `onDemand` only for a
concrete named missing fact and record the reason in the ledger. The plan supplied there is authoritative
for task order, the self-contained task contracts, test commands, criterion IDs, and complexity tiers.
When a task-local manifest needs its owning standards, that task's `Surface` creates the concrete missing
fact: read the manifest-declared routing index from `onDemand`, resolve the exact registered standard path
for the surface, and require that exact path to be one of the manifest's implicated-standard `onDemand`
references. If it is a modular core, read its mini-routing table and match the task's exact paths/topics;
select the core plus every matching leaf path already declared in the phase manifest, with zero matches
meaning core only. Never select or eagerly read unrelated leaves. Use those exact repository-relative
paths in every task-local `--standard` argument. Never guess or manufacture
`.apex/standards/<surface>.md`; modular and custom routing paths are authoritative. Record the routing read
once in the ledger, then reuse the resolved path set for that task's implement/review/fix loop. The spec
remains `onDemand`: read only a named section for a concrete insufficiency in the plan/brief, including
materializing the criteria-only artifact below, and record the reason; never use it as an automatic
contract read.

## Step 2 — branch and commit authorization

**Autopilot:** If `drive: autopilot` is present in the verdict contract (Step 0), do not ask either
question — the git decisions were already made by the human at the brainstorm spec gate and live in
the contract. Branch: the contract's `branch` field names the working branch — verify
`git branch --show-current` matches it; a mismatch, or being on `main`/`master`, is unresolvable →
append `<ISO timestamp> — implement — BLOCKED — run-id=<conductor-supplied> attempt=<positive supplied> <reason>` to
`.apex/work/tasks/<spec-basename>/autopilot-status.md` and exit non-zero. Commit authorization: the
contract's `commit-auth: per-task` selects the **Yes** path — commit after each reviewed-clean task
this run.

## Step 2.5 — pre-flight scan

**Autopilot:** do not ask the batched question. A conflict that cannot be resolved from authoritative
artifacts is unresolvable: append the correlated `BLOCKED` marker from Step 0 and exit non-zero.

## Step 3 — per-task loop (dispatch manifests)

When you dispatch the implementer, first create and validate the implementer manifest under the
task-local manifest protocol below, then pass only its path plus scalar dispatch controls; the child
reads the manifest's authoritative inventory. When you dispatch the task reviewer, first create and
validate its iteration manifest, then follow `reviewer-recovery.md` before dispatch and after return.
This deterministic gate also applies to the Step-4 whole-branch reviewer. On **Issues Found**, create and validate a fix manifest before
dispatching the fix back to the same `<surface>-agent`.

Preserve `discovery:unplanned` from the validated implementer/fix envelope in the compact
task-result index and retain the occurrence through later fixes, paired with DONE_WITH_CONCERNS.
Ordinary concerns are not discovery; transport or test reservations and unattributed concerns
must not acquire this signal by inference. A conflicting status/signal pair is a result-contract
defect to resolve through the authorized artifact-first protocol, not a reason to preload reports.

**Autopilot:** there is no human to answer a NEEDS_CONTEXT question or adjudicate an unresolvable
BLOCKED — exhaust the non-human remedies first (re-dispatch with more context, escalate the model,
split the task); if still stuck, append `<ISO timestamp> — implement — BLOCKED — run-id=<conductor-supplied> attempt=<positive supplied> <reason>`
to `.apex/work/tasks/<spec-basename>/autopilot-status.md` and exit non-zero. The conductor halts and a
human resumes later; the chain artifacts and ledger are the state, nothing to reconstruct.

## Step 4 — whole-branch review (final-review manifest)

In autopilot the conductor re-derives the branch diff and criteria-only artifact deterministically for
the later review phase, so this phase's copy never has to survive that far — write them for the reviewer
you are about to dispatch, not as a handoff. First create and validate `final-review-<iteration>.json`
using the canonical command below; the criteria-only success-criteria source, task-result index,
aggregate branch diff, and relevant standards are its exact required inventory.

## Step 5 — hand off

**Autopilot:** after the handoff verifies and the SKILL.md → "Step 5 — Hand off" lifecycle completes
(output READY first, input CONSUMED second), run the `reviewer-recovery.md` verify-handoff command, then append `<ISO timestamp> — implement — DONE — run-id=<conductor-supplied> attempt=<positive supplied> <commit range>` to `.apex/work/tasks/<spec-basename>/autopilot-status.md`. The session then simply ends — the conductor spawns the `review` skill next. Resume uses only manifest-authorized paths and the same exact-pair proof; manual resume capabilities do not widen an autopilot manifest or authorize scanning for prior outputs.

## Task-local manifest protocol

Before **every** implementer, task-reviewer, fix, or final-review dispatch, invoke
`node <engine-root>/scripts/autopilot-context.mjs` with only that role's strict named arguments.
Use the conductor-supplied run ID, the selected abstract tier, the brief's exact test command and
criterion IDs, and repository-relative paths. Create `.apex/work/tasks/<plan-basename>/context/` and
use these deterministic output paths:

- implementer: `task-N-implement.json`;
- task reviewer: `task-N-review-<iteration>.json`;
- fix: `task-N-fix-<iteration>.json`;
- final reviewer: `final-review-<iteration>.json`.

The canonical command shapes are:

```sh
node <engine-root>/scripts/autopilot-context.mjs --repo-root . --role implementer --run-id <supplied-run-id> --task N --model-tier <tier> --test-command '<exact-command>' --criterion <ID> --brief .apex/work/tasks/<plan-basename>/task-N-brief.md --standard <exact-standard-path-from-routing> --artifact-output .apex/work/tasks/<plan-basename>/task-N-report.md --output .apex/work/tasks/<plan-basename>/context/task-N-implement.json
node <engine-root>/scripts/autopilot-context.mjs --repo-root . --role task-reviewer --run-id <supplied-run-id> --task N --model-tier <tier> --test-command '<exact-command>' --criterion <ID> --brief .apex/work/tasks/<plan-basename>/task-N-brief.md --report .apex/work/tasks/<plan-basename>/task-N-report.md --task-diff .apex/work/tasks/<plan-basename>/task-N-diff.txt --standard <exact-standard-path-from-routing> --hub-index .apex/_INDEX.md --artifact-output .apex/work/tasks/<plan-basename>/task-N-review.md --artifact-output .apex/work/tasks/<plan-basename>/task-N-issues.md --output .apex/work/tasks/<plan-basename>/context/task-N-review-<iteration>.json
node <engine-root>/scripts/autopilot-context.mjs --repo-root . --role fix --run-id <supplied-run-id> --task N --model-tier <tier> --test-command '<exact-command>' --criterion <ID> --brief .apex/work/tasks/<plan-basename>/task-N-brief.md --issue .apex/work/tasks/<plan-basename>/task-N-issues.md --task-diff .apex/work/tasks/<plan-basename>/task-N-diff.txt --standard <exact-standard-path-from-routing> --artifact-output .apex/work/tasks/<plan-basename>/task-N-report.md --output .apex/work/tasks/<plan-basename>/context/task-N-fix-<iteration>.json
node <engine-root>/scripts/autopilot-context.mjs --repo-root . --role final-review --run-id <supplied-run-id> --model-tier <tier> --test-command '<exact-command>' --criterion <ID> --criteria .apex/work/tasks/<plan-basename>/success-criteria.md --task-result-index .apex/work/tasks/<plan-basename>/task-result-index.md --branch-diff .apex/work/tasks/<plan-basename>/branch-diff.txt --standard <exact-standard-path-from-routing> --artifact-output .apex/work/tasks/<plan-basename>/final-review.md --artifact-output .apex/work/tasks/<plan-basename>/final-review-issues.md --output .apex/work/tasks/<plan-basename>/context/final-review-<iteration>.json
```

Repeat `--standard` with `<exact-standard-path-from-routing>` once for the routed core/single standard and
once for every matching modular leaf, preserving mini-routing order. The examples show one occurrence;
plural selected paths use repeated `--standard` arguments identically for implementer, task-reviewer,
fix, and final-review manifests.

Before the first final-review manifest, materialize the deterministic criteria-only `success-criteria.md`
artifact at `.apex/work/tasks/<plan-basename>/success-criteria.md`. Give it canonical source attribution containing
the repository-relative spec path and the exact source heading, then copy verbatim the approved
success-criteria content from that heading, including every criterion ID. Include no unrelated spec sections.
The same source bytes must produce the same artifact bytes. In autopilot, the source spec is the
implement phase manifest's `onDemand` input: read only the named success-criteria heading for this
concrete missing fact and record the reason. Failure to locate one unambiguous heading or write the
artifact is correlated `BLOCKED` before dispatch. Reject any final-review `--criteria` value under
`.apex/work/specs/`; a full spec path is never a valid required input.

Repeat `--criterion` and every role's `--standard` once per value, preserving plan/mini-routing order. Do not add a
role-inapplicable option. A missing or invalid manifest is a correlated `BLOCKED` outcome: record the
reason, make no child dispatch, and exit non-zero. A child receives the validated manifest path as its
authoritative file inventory; it does not receive copied artifact bodies. For a whole-branch finding,
the one responsible task's fix command uses `--issue .apex/work/tasks/<plan-basename>/final-review-issues.md`
and the current aggregate branch diff as `--task-diff`; all other named arguments remain role-valid.

The eager inventories are exact:

- implementer `required`: task brief + exact selected owning standards (single, or core + matching leaves);
- task reviewer `required`: task brief + implementer report + task diff + exact selected owning standards; hub index
  may appear only as `onDemand` for a named suspected routing conflict, with the reason recorded;
- Fix `required` inventory is exactly the task brief, authoritative reviewer issue artifact, current task diff, and exact selected owning standards;
- final reviewer `required`: success-criteria source + task-result index + aggregate branch diff +
  relevant standards.

Never eagerly pass a full spec body, full plan body, hub index, or transcript. Never pass `_INDEX.md`
unconditionally. An `onDemand` read is allowed only when that role's inventory declares it and the
controller records a concrete reason.

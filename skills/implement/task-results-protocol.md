# Task execution receipts (Gear 3 autopilot v2)

Read this protocol only when `manifest.contract.taskResultProtocol` is `2`. The conductor records
`TASK_RESULT_PROTOCOL` once for a fresh run and pins the value in every phase manifest; propagate
`--task-result-protocol 2` to every task-role manifest. Retained legacy autopilot runs stay on
protocol 1. Never silently upgrade a run or manufacture a historical baseline. Manual drive and
Gear 4 retain their existing response and index grammar. These v2 instructions take precedence
over the four-field and comma-list examples in the implementation skill and child prompts.

## Semantic response and source evidence

Implementer and fix responses contain exactly these ordered text fields (or the same JSON keys
when `--format json` was selected before dispatch):

```text
status: <DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT>
artifact: <exact authorized task report path>
signals: <short machine-readable IDs or none>
```

The child writes the report first. No status, artifact, or signals may be inferred from report
prose, a successful process exit, or observed edits. A legacy extra `changed-paths` field is retained
as raw-only telemetry and ignored, even when it contains brace notation or Next route paths. Do
not correct, expand, split, or use that claim as authority. Malformed semantic fields fail closed.

`source-observation.mjs` observes branch, HEAD, index, tracked files, and nonignored untracked
source outside `.apex/work/`, including content, modes, and symlink targets. Git NUL-delimited
filenames are preserved exactly. JSON `changedPaths` arrays contain the cumulative union across
that task's executions; `executionChangedPaths` records each execution's observed changes.
Spaces, commas, semicolons, Unicode, and newlines are JSON strings, never comma-separated source
authority, shell expressions, or brace expansions. Source-path validation is separate from the
strict confined work-artifact path grammar. Ignored files and transient writes are outside this
observation; unsupported submodules fail closed. The helper is not an OS sandbox.

## Begin before every writer dispatch

Before an implementer, fix, or retry dispatch, record the exact state prefix and run/attempt/task/execution
identity in the authorized ledger. Use `.apex/work/tasks/<plan-basename>/task-N-execution-E`.
Each task starts at execution 1; each real fix or explicit retry increments that task's execution. `previousState`
is the same-task prior execution for a fix or retry, absent for its first implementation. `parentState`
is the immediately preceding completed execution across all tasks, absent only for the first
execution of the run. A late fix therefore uses its own previousState and the latest global
parentState even when another task ran in between. Never substitute one for the other.

```sh
node <engine-root>/scripts/task-results.mjs --repo-root . --action begin --state <exact-state-prefix> --run-id <supplied-run-id> --attempt <supplied-attempt> --task N --execution E --role <implementer-or-fix-or-retry> --report .apex/work/tasks/<plan-basename>/task-N-report.md --plan <exact-authorized-plan-path> --format text
```

Add `--previous-state <same-task-prior-state>` for a fix or retry and `--parent-state <latest-global-state>`
whenever a prior execution exists. Select `--format json` only for actual JSON transport. Require
the helper's valid READY result before dispatch. Complete all authorized source writes, including
any task commit, inside the observed execution before record. Do not mutate Git/source between
record and the next authorized execution; all commits must also precede final-review baseline.

The begin call writes immutable baseline JSON. The controller may invoke the helper on only the
exact recorded state prefix. Its machine replay capability covers the schema-authorized
`parentState` and `previousState` links confined to the same task directory, their exact baseline,
capture, frozen report and result files, and the exact bound plan/report paths. This is permission
for deterministic replay, not permission to preload those bodies into a child or search work.
Manifest outputs alone do not grant generic read permission. Do not enumerate `.apex/work/**` or
discover receipt state from filenames. Normal repository source discovery is unchanged.

## Capture, then review

Feed the exact response bytes on stdin, without normalization:

```sh
node <engine-root>/scripts/task-results.mjs --repo-root . --action record --state <exact-state-prefix>
```

The helper writes immutable capture JSON first, then the frozen execution report, then the result
JSON. Each file uses staged, fsynced, atomic publication under the exclusive cooperating-writer
lease; this is not a multi-file transaction or protection against hostile concurrent writers.
It validates semantic completion, source continuation, report identity, and prior lineage.
Earlier execution evidence remains immutable when a fix updates the canonical task report.
Retain `discovery:unplanned` through later fixes and retries; completed work carrying it requires
DONE_WITH_CONCERNS in the generated index. A valid non-success response retains the signal and report
evidence while its question or blocker is unresolved.

A completed execution is **review-pending**, never automatic task approval. Continue the existing
review policy: integration/design tasks require a task APPROVED receipt; mechanical tasks may skip
task review, and all tasks require final whole-branch approval. Follow `reviewer-recovery.md`;
task reviewer begin adds `--execution <latest-task-state>`. After any fix, obtain a new task approval
when its previous approval is obsolete, including fixes caused by whole-branch review.

## Inspect and resume without repeating implementation

Use the exact pending prefix recorded before dispatch in the authorized ledger:

```sh
node <engine-root>/scripts/task-results.mjs --repo-root . --action inspect --state <exact-state-prefix>
node <engine-root>/scripts/task-results.mjs --repo-root . --action resume --state <exact-state-prefix>
```

Inspect is read-only. Resume replays a durable capture and finishes an interrupted report/result
write without writer redispatch, provided current source and report still match. Completed
execution resumes at review-pending; reconcile its generated index and pending review transition,
never implement it again. A baseline-only pending execution has no captured semantic completion:
it cannot infer DONE from changed code or a report and cannot automatically redispatch. Missing,
corrupt, substituted, or drifted evidence blocks with existing source and reports preserved.
Do not manufacture missing evidence, reset code, replenish a review correction budget, or rerun a
review merely to handle ignored legacy path telemetry. Legacy protocol 1 recovery remains governed
by its original reviewer gate; it does not acquire historical task receipts.

## Continue a valid non-success response

A captured semantic NEEDS_CONTEXT or BLOCKED result is not task completion. Inspect its derived
`retryable` fact. If true, resolve the question from authorized context or choose a concrete remedy
such as supplying missing context or escalating the model, and record that remedy in the ledger.
Never repeat an unchanged request automatically. If there is no remedy, retain the correlated block.
The record CLI returns exit 1 for those semantic non-success statuses; inspect its structured result
before deciding recovery. Exit 1 without a valid retryable result remains a failure, never inferred
permission to dispatch.

After a remedy, begin a **new** execution with `--role retry`, execution E+1, and both
`--previous-state` and `--parent-state` naming that exact non-success execution. The source and
canonical report must still match its capture. Do not overwrite the old response, report snapshot,
or receipt. The retry preserves cumulative changed paths, discovery evidence, and the original task
baseline. A normal `fix` still requires a successful previous execution; no unrelated task may
advance past the unresolved result. A retry that returns another valid non-success may be continued
only after another explicit remedy. Baseline-only ambiguity, malformed semantics, missing/empty
reports, and drift are never made retryable by the status word BLOCKED.

`retry` is an execution-helper role, not a new task-manifest role. Dispatch the original
implementer or fix role with the same required brief/standards (and issues for a fix), supplying the
resolved context through its authorized inventory. Use a fresh exact manifest output
`context/task-N-retry-E.json`, where E is the new execution number, and preserve earlier manifests.
After successful capture, project the new receipt and obtain the applicable independent reviews.

## Project and verify

Generate the index from the latest accepted execution of each task, using a JSON array of exact
recorded state prefixes. Pass JSON as an argument without shell interpolation or expansion.

```sh
node <engine-root>/scripts/task-results.mjs --repo-root . --action project --task-result-index <exact-index-path> --states '<JSON array of latest state per task>'
node <engine-root>/scripts/task-results.mjs --repo-root . --action verify --task-result-index <exact-index-path> --expected-tasks '<JSON array of plan task ID strings>'
```

The generated Markdown index retains its lifecycle header, metadata, and reviewer references. Its
single `<!-- steepy-task-results: v2 -->` fenced JSON block contains entries with `task`, `status`,
`artifact`, `changedPaths`, `signals`, and `receipt`. JSON receipts are machine authority; Markdown
is a projection. Do not hand-author task entries or mix legacy `- Task` comma-list bullets into v2.
Projection records execution evidence even while task review is pending; only the separate review
gate permits a ledger task-complete transition. Verify checks exact task coverage, receipt lineage,
all current task reports, and the latest source observation. Keep required task/final review
references bound through `reviewer-response.mjs --action bind-reference`.

Before implement DONE, run receipt verify, canonical handoff verification, and reviewer
verify-handoff; require every applicable gate, not just the projection. The conductor independently
replays v2 task receipts and required task/final approvals before phase acceptance and resumed
review. Verification exposes bounded `executions` facts for every ancestor, including failed attempts
followed by retries. The gate checks each unique execution's runId, attempt, and protocol 2 against
its exact phase manifest; a valid latest fix cannot hide wrong or missing ancestor provenance.
A valid task receipt does not certify product correctness or native model compliance.

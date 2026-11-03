# implement — Steps 3–4: task loop and whole-branch review

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
4. **Review** (**Gear 3 only** — skip in gears 1–2; rely on the implementer's self-review instead). Review only tasks that carry judgment; the task's `Complexity` line decides: `integration`/`design` → review, `mechanical` → skip (the Step 4 whole-branch review catches it). In manual drive, to override either way, record the reason in the ledger. Autopilot requires validated receipts for every integration/design task; mechanical tasks may still opt into review. When you do review, dispatch a fresh reviewer subagent using `task-reviewer-prompt.md`. In autopilot (`drive: autopilot`), create and validate its iteration manifest per `autopilot-protocol.md`; in manual drive pass the same four required artifacts directly and record the degradation. The hub index is never eager: include it only as `onDemand`, and read it only for a named suspected routing conflict whose reason is recorded. On **Issues Found**, require `task-N-issues.md`, then create and validate a fix manifest before dispatching the fix back to the same `<surface>-agent` (inline: apply the fix yourself). Regenerate the diff and re-review until **Status: Approved**, within the fix-round cap in `SKILL.md`. Fix loops remain sequential.
5. **Mark complete.** Append one line to the ledger, recording the model tier used — or `session model` where the harness gives no per-dispatch choice — and any degradation exercised (inline implementation, same-session review pass): `Task N: complete (model: standard, review: 1 iteration, commits <base7>..<head7>)` if authorized, else `Task N: complete (model: cheap, review: skipped (mechanical), no commit)`. On a harness with no task tool the line records the degradation, e.g. `Task N: complete (session model, inline impl + same-session review, 1 iteration, no commit)`. Also append the compact validated implementer outcome to `.apex/work/tasks/<entry-basename>/task-result-index.md` using this exact bullet grammar (one line per task, in execution order):

   `- Task <id>: <DONE|DONE_WITH_CONCERNS>; artifact: <sanitized repo-relative path>; changed-paths: <comma list or none>; signals: <short machine-readable IDs or none>`

   That bullet grammar applies only to manual drive. In autopilot, use
   `task-results.mjs --action project` and verify the generated JSON receipt index;
   never append a `- Task` bullet. A captured execution is review-pending until its applicable
   reviewer gate approves; only then mark the ledger task complete.

   Never append an artifact body or use a shorthand result line; the conductor parses this exact grammar before review.

   Preserve `discovery:unplanned` verbatim from every validated implementer/fix result into the
   task-result index, retaining it through later fixes. It requires DONE_WITH_CONCERNS even when the
   final fix is otherwise clean. Ordinary concerns are not discovery: do not add this signal for
   transport degradation, a test reservation, or an unattributed DONE_WITH_CONCERNS. Missing or
   inconsistent attribution is a result-contract concern, not permission to infer a discovery.

Handle implementer status: **DONE_WITH_CONCERNS** — read the concerns first; **NEEDS_CONTEXT** — provide it and re-dispatch; **BLOCKED** — give more context, re-dispatch on a more capable model (add `escalated: <from>→<to>` to the task's ledger line), or split the task. Never force the same model to retry unchanged. A fix re-dispatched this way stays in its fix round (the fix-round cap in `SKILL.md`).

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

In manual drive, every child returns exactly four fields, in this exact order and with no bullets:

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

For manual drive, before trusting a child result, validate the four-field shape, status, sanitized repo-relative artifact
path, and signals; also validate field order and comma-list-or-`none` changed paths.
A malformed envelope is never trusted: autopilot records correlated `BLOCKED` and exits; manual drive
records the explicit same-session/degraded handling in the ledger. The controller opens the artifact only when
its action status requires the next decision; otherwise it passes the artifact reference to
the next consumer. The ledger and task-result index record only the compact outcome and artifact reference,
never full detail.

In Gear-3 autopilot, before every task or whole-branch reviewer dispatch, read and follow
`reviewer-recovery.md`: establish the deterministic baseline and gate even a valid response.
In autopilot, reviewers return exactly status, artifact, signals; a `changed-paths` field is malformed;
the gate derives no source changes only after independent unchanged-state verification. An accepted APPROVED
receipt plus independently unchanged code is required before marking complete; a report alone is
insufficient. Bind task/final receipt references in the result index per `reviewer-recovery.md`;
the conductor verifies them independently before accepting implement DONE. Preserve existing
implementation, fixes, completed tasks, and prior attempt evidence.

### Multi-task artifact-flow proof

For Task 1 and Task 2, the parent accumulates only the selected compact envelopes and, in autopilot,
bounded receipt facts; manual drive uses four-field envelopes. Durable
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
apply the fixes yourself), then regenerate the aggregate diff and re-review until **Status: Approved**,
within the fix-round cap in `SKILL.md`.

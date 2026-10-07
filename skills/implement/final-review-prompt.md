# Final Review Prompt (steepy)

After the last task, if your harness provides a task/subagent tool, dispatch a fresh reviewer for the
whole branch before handing off to the `review` skill (invoke it the way your harness invokes skills). In autopilot, pass the validated
final-review manifest path as the sole file-inventory reference. Its `required` inventory is exactly the success-criteria source, task-result index, aggregate branch diff, and relevant standards. The success-criteria source is the deterministic task-local criteria-only artifact, never the full spec.
Otherwise perform this review in a fresh dedicated pass over the same inputs and record the
no-task-tool or manual no-manifest degradation in the ledger.

Protocol selection: `manifest.contract.taskResultProtocol` equal to `2` takes precedence over
all four-field examples below. In v2 return only `status`, `artifact`, `signals`, in that text order
(or the same JSON keys when the controller selected JSON). Preserve the role's status and artifact
rules. A legacy extra `changed-paths` is raw-only telemetry ignored by the gate, never authoritative.
Manual drive and legacy autopilot protocol 1 retain the following four-field response contract:

```text
status: <enum>
artifact: <sanitized repo-relative path>
changed-paths: none
signals: <short machine-readable IDs or none>
```

There are exactly four fields and no response headings. No headings, commits, tests, prose concern details,
diff, report, or test transcript may appear in the response.

```
Subagent (reviewer):
  model: standard  # reviewer floor tier; rise to most-capable when the branch is large or subtle
  description: "Whole-branch review of the implemented plan"
  prompt: |
    You are a fresh-eyes whole-branch reviewer for a hub-governed (.apex/) project. Per-task reviews
    already gated tasks in isolation. Apply the cross-task lens: integration seams, contradictions,
    and whether the branch as a whole meets the approved success criteria.

    **Autopilot context manifest:** [MANIFEST_FILE]
    **Manual fallback inputs:** [CRITERIA_FILE], [TASK_RESULT_INDEX], [BRANCH_DIFF], [STANDARD_FILES]
    **Review artifact:** [FINAL_REVIEW_FILE]
    **Issue artifact:** [FINAL_ISSUE_FILE]

    In autopilot, read and validate the manifest first. When `manifest.contract.taskResultProtocol`
    is `2`, return only status, artifact, signals; this rule takes precedence over every legacy
    four-field example in this prompt. Do not include a source-path claim. The controller obtains
    paths from Git observations; a legacy extra changed-paths is ignored raw-only telemetry.
    Manual drive and legacy protocol 1 retain the four-field grammar below. Read all and only its `required` inputs:
    the success-criteria source, task-result index, aggregate whole-branch diff, and relevant owning or
    cross-cutting standards under `.apex/standards/`. Never preload a full plan, hub routing table,
    per-task transcript, conversation, or task report body. The criteria-only artifact contains canonical
    spec-path and heading attribution plus the verbatim approved criteria, with no unrelated spec sections.
    Never open the full source spec. The task-result index supplies compact
    outcomes and authoritative artifact references without inlining their detail. In manual drive use
    only those same role-local direct inputs and record the no-manifest degradation. Ordinary
    repository source needed to verify the branch may be read normally, but never enumerate
    `.apex/work/**` or infer another work artifact from the orchestrator's capability. Validate the
    task-result index's canonical grammar and its exact `source-spec`, `criteria`, and `branch-diff`
    metadata; validate the supporting paths and canonical criteria `Source`/`Heading` attribution
    without opening the plan or source spec.

    Read the aggregate diff once. Check that task interfaces compose, no task undoes another, all
    success criteria are met, and no cross-cutting problem escaped the task gates.

    ## What to Check
    | Category | What to look for |
    |----------|------------------|
    | Spec compliance | every success criterion has branch evidence |
    | Completeness | the tasks compose into the full deliverable, with no stubs |
    | Cross-task integration | interfaces align and no task contradicts another |
    | Tests | branch evidence covers the composed behavior |
    | Surface ownership | aggregate changes stay within the declared surfaces |
    | Standard conformance | the branch respects every relevant `.apex/standards/` document |

    ## Calibration
    Flag real cross-task, integration, and unmet-criterion problems. Do not re-litigate an approved
    task-scoped finding unless it composes into a branch-level problem. Approve when there is no real gap.

    ## Durable findings and response
    Always write complete findings, evidence, minor triage, and Status to
    `.apex/work/tasks/<plan-basename>/final-review.md` ([FINAL_REVIEW_FILE]). Status is Approved or
    Issues Found. If Issues Found, also write the complete actionable set to authoritative
    `.apex/work/tasks/<plan-basename>/final-review-issues.md` ([FINAL_ISSUE_FILE]); a fix receives that
    artifact, never inline concern prose. If BLOCKED or NEEDS_CONTEXT, write all detail to
    [FINAL_REVIEW_FILE]. The review is read-only with respect to application code and other repository sources.
    Writing the authorized review and issue artifacts is required and excluded from `changed-paths`.
    In manual drive and protocol 1, `changed-paths` must always be the literal `none`. Do not edit source, stage files, or commit.
    A legacy response-only correction must preserve the existing verdict and every artifact byte.
    Protocol 2 needs no path-only correction: the gate independently proves unchanged source.
    It never infers or repairs status, artifact, or signals.

    For manual drive or legacy protocol 1, return exactly the four unbulleted fields below and nothing else.
    For protocol 2, return only status, artifact, signals, as selected above. Allowed status values are
    APPROVED | ISSUES_FOUND | BLOCKED | NEEDS_CONTEXT. For APPROVED, BLOCKED, or NEEDS_CONTEXT,
    `artifact` is [FINAL_REVIEW_FILE]; for ISSUES_FOUND it is [FINAL_ISSUE_FILE]. `signals` contains
    short IDs such as `review:clean`, `review:integration`, or `none`.

    status: <enum>
    artifact: <sanitized repo-relative path>
    changed-paths: none
    signals: <short machine-readable IDs or none>
```

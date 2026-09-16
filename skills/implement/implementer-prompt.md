# Implementer Prompt (steepy)

If your harness provides a task/subagent tool, dispatch the task's bound **specialist agent**
(`<surface>-agent` from the brief) as a fresh implementer — **one implementer in flight at a time**,
never in parallel. In autopilot, the validated context manifest is the sole file-inventory reference
passed to the child. Its `required` inventory is exactly the task brief and selected owning standards
(a single file, or the exact modular core plus matching leaves).
Otherwise implement inline in a dedicated pass using those same inputs and record the no-task-tool or
manual no-manifest degradation in the ledger/run output.

The child response contract is exactly four fields:

```text
status: <enum>
artifact: <sanitized repo-relative path>
changed-paths: <comma list or none>
signals: <short machine-readable IDs or none>
```

There are exactly four fields and no response headings. No headings, commits, tests, prose concern details,
diff, report, or test transcript may appear in the response.

```
Subagent (<surface>-agent):
  model: <tier>  # task Complexity: cheap for transcription, standard for integration, most-capable for design/subtle; the agent's own model is the floor
  description: "Implement Task N: <task name>"
  prompt: |
    You are implementing one task of a hub-governed (.apex/) plan. Work only on this task.

    **Autopilot context manifest:** [MANIFEST_FILE]
    **Manual fallback inputs:** [BRIEF_FILE], [STANDARD_FILE]
    **Commit authorized this run:** [YES|NO]

    In autopilot, read and validate the manifest first. Treat it as authoritative for eager context.
    Read every `required` entry before acting; its inventory is exactly the task brief and selected
    owning standards. This manifest is an efficiency protocol, not repository access control or a sandbox.
    Repository source files needed to inspect, implement, test, or verify the task may be read normally.
    Do not preload a spec, plan, routing table, transcript, or prior task report. A declared `onDemand`
    upstream context document may be read only for a concrete missing fact; record that reason in the report.
    The brief is the complete implementer contract: requirements, relevant constraints, surface and
    specialist, exact paths, test command, dependencies, complexity, and criterion IDs.

    In manual drive, use only the two role-local direct documents above as eager work context, inspect
    ordinary repository source normally as needed, and record the no-manifest degradation. Never
    enumerate `.apex/work/**`, infer another work artifact, or widen the orchestrator's capability.

    ## Before you begin
    If anything is ambiguous, write the concrete question to [REPORT_FILE] and return
    `status: NEEDS_CONTEXT`; do not guess and do not put the question in the response.

    ## TDD contract (rigid)
    For every unit of behavior, in order:
    1. **Red:** write a failing test first. Run the brief's exact surface test command and confirm it
       FAILS for the expected reason.
    2. **Green:** write the minimum code to pass. Run that command and confirm it PASSES.
    3. **Refactor:** clean up while keeping the test green.
    Never write implementation code before a failing test exists.

    ### Red flag — STOP
    | Thought | Reality |
    |---------|---------|
    | "I'll write the code first, test after" | STOP. No implementation before a failing test exists. |
    | "This change is too small to test" | STOP. Small changes regress silently. Write the test. |
    | "The test obviously passes, skip running Red" | STOP. Confirm it FAILS for the expected reason first. |

    ## Keep the hub living
    If the brief requires a standard, workflow, or domain-term update, make that exact change. Do not
    broaden scope beyond the brief.

    ## Self-review and commit
    Verify the brief completely, test quality, names, and pristine output. If commit authorization is
    YES, commit tests plus implementation only after green; if NO, do not run a mutating git command.

    ## Durable report and response
    Write full implementation/fix detail to the manifest-declared [REPORT_FILE], canonically
    `.apex/work/tasks/<plan-basename>/task-N-report.md`: implementation, RED/GREEN command evidence,
    changed files, self-review, commit evidence, concerns, questions, or blockers. This file is
    authoritative; update it after every fix dispatch.

    If you had to **discover** what to change rather than execute what the brief specified, record
    that occurrence in [REPORT_FILE] and flag it as a concern: return `status: DONE_WITH_CONCERNS`.
    Include `discovery:unplanned` in `signals` and the report, identifying the brief gap and the
    repository evidence that closed it. Preserve this occurrence through fix reports and final
    envelopes, even after the code is clean. An explicitly planned discovery deliverable is not
    unplanned discovery; ordinary implementation/source inspection alone does not trigger it.
    These two routes never share a trigger: ambiguity you cannot resolve by reading the repository
    stops the task before it starts (`status: NEEDS_CONTEXT`, per "Before you begin"), while a gap
    you did close by discovering the answer in the repository finishes the task and is reported as
    the concern above (`status: DONE_WITH_CONCERNS`).
    Ordinary concerns such as transport degradation use their own signal (or `none` when
    unattributed), never `discovery:unplanned` merely because the status contains concerns.

    Return exactly the four unbulleted fields below and nothing else. Allowed status values are
    DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT. `artifact` is [REPORT_FILE].
    `changed-paths` is a comma-separated sanitized repo-relative list or `none`; `signals` contains
    short IDs such as `tdd:red-green` or `none`. All concern/question/blocker prose stays in the artifact.

    status: <enum>
    artifact: <sanitized repo-relative path>
    changed-paths: <comma list or none>
    signals: <short machine-readable IDs or none>
```

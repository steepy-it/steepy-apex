# Explore-Inception Prompt (steepy)

If your harness provides a task/subagent tool, dispatch a fresh explorer subagent for the inception
source during discovery (Step 2a). Otherwise perform the exploration yourself in a dedicated pass
over the same inputs, and state the inline degradation in the run's report. It reads the approved
documents and the verification results of one completed inception run, writes one item card per
decision-register entry to a report file, and returns a terse status the `discovery` skill drives
the interview from. It does not interview the user and never writes to the hub or the codebase —
the report file is its only write; everything else is read-only.

```
Subagent (explorer):
  model: standard  # explorer tier; the dispatcher translates the tier to a concrete model
  description: "Explore the inception source for discovery"
  prompt: |
    You are a fresh-eyes explorer for a hub-governed (.apex/) project, gathering raw material for
    the inception source of a discovery interview. A completed inception run left approved project
    documents, a decision register, and verification results. You turn each register decision into
    one item card. Your output feeds an interview — you do not conduct it. You never write to the
    hub or the codebase — the report file below is your only write.

    **Input paths:** [INPUT_PATHS]
    **Report file:** [REPORT_FILE]
    **Glossary:** [GLOSSARY_PATH]
    **Conventions:** [CONVENTIONS_PATH]
    **Current standard docs:** [STANDARD_PATHS]

    Read exactly the files in [INPUT_PATHS], [GLOSSARY_PATH], [CONVENTIONS_PATH], and
    [STANDARD_PATHS]. These paths are supplied by discovery; do not infer another run file, a
    standard filename, or a work report. Never list `.apex/inception/` or read anything else under
    it, never read under `.apex/work/`, and never write to the hub or the codebase.

    The input paths are the run descriptor, the approval record, every approved document (the
    decision register, `.apex/inception/project/decision-register.md`, among them), and the
    verification results. The glossary, conventions, and standard docs are the comparison baseline
    and the possible destinations.

    ## What to Return

    One item card per `DR-n` row of the decision register, in register order: every row gets a
    card, none merged or left out. Each card has 5 fields:

    - **Proposed doc text:** the decision, already phrased as it would read in the destination doc,
      and phrased for its Promotion class.
    - **Evidence:** `file:line` of the register row + a 1–3 line excerpt, and `file:line` of each
      `## Coverage` row for that ID in the verification results. Evidence is for the interview
      only: it never goes into the Proposed doc text.
    - **Verification status:** `verified`, `unverified`, or `future`, from the `## Coverage` rows
      for that ID: `verified` when every row says `verified`, `future` when every row says
      `future`, otherwise `unverified` (also when the ID has no row).
    - **Promotion class:** set by the Verification status.
      - `verified` → `existing component or rule`: may be written as an existing component or rule.
      - `unverified` → `design choice`: written as a design choice, not as an existing component.
      - `future` → `future context`: written as context in [CONVENTIONS_PATH], never as an
        implemented component, a spec, or a started task.
    - **Destination:** the proposed doc and section: [CONVENTIONS_PATH], one doc in
      [STANDARD_PATHS], or [GLOSSARY_PATH]. A `future context` card always goes to
      [CONVENTIONS_PATH]. The interviewer confirms or re-routes it.

    The Proposed doc text never names, cites, or links `.apex/inception/`, and never cites a `DR-n`
    ID: the hub never points into the inception run.

    ## Invent Nothing

    Do not guess or infer beyond what the input documents show. Every card carries `file:line`
    evidence from the input paths. A Proposed doc text may only assert what its evidence shows — a
    claim the evidence doesn't cover gets dropped from the text, not softened. Never drop a
    register row itself: every `DR-n` gets its card.

    ## Output Format

    Write the full report to **[REPORT_FILE]**:

    ## Inception Exploration
    **Run:** [runId from the descriptor]
    **Approval record:** [its path]
    **Decision cards:**
    - **[DR-n]**
      **Proposed doc text:** [decision, phrased as doc prose for its Promotion class]
      **Evidence:** [file:line] — `[1-3 line excerpt]`; Coverage: [file:line], [file:line]
      **Verification status:** verified | unverified | future
      **Promotion class:** existing component or rule | design choice | future context
      **Destination:** [doc path] → [section]

    Leave out `## Decision outcomes`: the interviewer records `## Decision outcomes` in this
    report after the interview.

    ## Report

    Put the card count, the run identity, and any blocker in the full report. Then return ONLY
    these four unbulleted fields, in order (**≤15 lines**); this schema is complete here and
    requires no other prompt. DONE means the report exists and holds one card per `DR-n`, not
    approval to write hub docs. BLOCKED means the report records why exploration could not finish,
    for example an unreadable input path or a missing decision register. The report is the only
    permitted write; changed-paths excludes that local report and stays none.

    status: <DONE|BLOCKED>
    artifact: [REPORT_FILE]
    changed-paths: none
    signals: <short IDs or none>
```

# discovery — Step 2a: inception source (complete run only)

### Step 2a — Inception source (complete run only)

Run this step only when the user chose the inception source in Step 1. It runs right after Step 1
and before Step 2; the run then continues with Step 2 for the selected surfaces. It turns the
decisions of a completed inception run into hub text. Read by exact path only: never list `.apex/inception/` or a
directory under it. A stop in this step ends only the inception source; Step 2, Step 3 and Step 4 still run.

1. **Verify before reading.** Before reading any source approval, document, summary, or report
   body, run:

   ```bash
   node <engine-root>/scripts/inception-state.mjs verify-complete --repo-root .
   ```

   Require exit 0 and JSON `ok: true` with `runId`, `completion`, `inputPaths`, `checks`, and
   `coverage`. The helper verifies transitive evidence and current application identity, including
   only exact certified init additions, before returning document paths. It also rejects a completion whose latest approval does not cover
   every registered decision document, naming that path. Only after this success may
   the coordinator or explorer read source bodies, and only the exact returned `inputPaths`.
   Do not traverse descriptor or approval refs, append raw evidence, infer summary/report paths, or
   choose an approval by recency. Stop this source if
   `.apex/inception/project/decision-register.md` is not among the returned `inputPaths`.

   On nonzero exit, `ok: false`, malformed output, or missing fields, stop only the inception source
   and report the returned reason (unsupported run format, tamper, application-drift, uncovered decision, or another verification failure).
   No source bodies are loaded and no source decisions are promoted. Never downgrade rejected
   source decisions into old design choices. Ordinary discovery remains available for the current
   code and surfaces already selected in Step 1; the per-surface interview and Steps 3–4 continue.
   Keep the complete run and all its evidence immutable: no reopen, repeat bootstrap, migration or
   restart. A refused source is not a request to widen the discovery scope.
2. **Explore.** Ensure `.apex/work/discovery/` exists (create it if absent), then set
   `[REPORT_FILE] = .apex/work/discovery/YYYY-MM-DD-inception.md`. If your harness provides a
   task/subagent tool, dispatch a fresh subagent using `skills/discovery/explore-inception-prompt.md`,
   and always set `model: standard` explicitly. Pass `[INPUT_PATHS]` = exactly the successful gate's
   `inputPaths` array, unchanged — no other run path. Also pass `[REPORT_FILE]`, `glossary.md` as `[GLOSSARY_PATH]`, `conventions.md` as
   `[CONVENTIONS_PATH]`, and as `[STANDARD_PATHS]` the standard docs of every surface in the routing
   table (the single `standards/<surface>.md`, or the core plus every leaf its mini-routing table
   lists). Otherwise run the same prompt inline over the same inputs, and state the inline
   degradation in the run's report (Step 4). Validate the four-field completion defined in
   `skills/discovery/explore-inception-prompt.md` → "Output Format", including the exact
   `[REPORT_FILE]`. For BLOCKED, read that report's blocker and stop the inception source. For DONE,
   read the report back from `[REPORT_FILE]` before the interview.
3. **Walk the decision register.** The report holds one item card per `DR-n`, in register order.
   For each decision, print in a plain text message its card — Proposed doc text, Evidence (the
   local file and line; it is for the interview only), Verification status (from the verified summary's
   `coverage` entries), Promotion class — immediately followed by its write-back preview:
   the destination and the exact text that would be written. Then run the same accept / correct /
   skip interview as Step 2.4 in `surface-loop.md`: decide on the preview, a correction re-renders
   the preview, one question at a time. Never use bare IDs (DR-1, DR-2, …) as option labels: the
   user decides on the printed card and preview. A skip is a rejection: ask the user for its reason.
4. **Promotion rules.** Every decision in the register is approved: Step 2a.1 verified complete
   delivery, including its approval. Use only the verified summary for coverage and check outcomes; a red source gate
   permits none of these promotions.
   - Approved and verified (`verified`) → may be written as an existing component or rule.
   - Approved but unverified (`unverified`) → written as a design choice, not as an existing
     component.
   - A future flow (`future`) → written as context in `conventions.md`, never as an implemented
     component, a spec, or a started task.
5. **Write-back, in one pass after the interview.** Unlike Step 2.5, this source batches its
   writes: write nothing to the hub until every register decision is decided. Each preview is still
   accepted, corrected or skipped on its own, so every write stays gated by the user. An
   interview interrupted before that point leaves the certified documents unchanged, so the next
   run's gate still passes and the import starts again. Then record the decision outcomes (item 6)
   and write every accepted preview in one pass, with no question in between. Destinations are
   only `conventions.md`, the routed surface standards, and `glossary.md`: no new hub document and
   no `_INDEX.md` change. Write-back text never names, cites, or links `.apex/inception/`; the
   Evidence stays in the interview. Write verbatim the approved preview, additive and diff-gated as
   in Step 2.5 in `surface-loop.md`.
6. **Decision outcomes.** Every register decision ends accepted (written) or rejected with a reason.
   Record the outcomes in `[REPORT_FILE]` under `## Decision outcomes`, one line per decision:
   `DR-n — accepted` or `DR-n — rejected: <reason>`. The import is one-time. Once a run writes to
   `conventions.md`, a standard or `glossary.md`, those documents no longer match what `init`
   certified, so a later run's gate refuses the source with `governance output drift`: report it
   and continue with ordinary discovery. The write pass is the one window left. If it is interrupted
   after its first write, a later run refuses the source the same way; the interrupted run's
   `[REPORT_FILE]` still lists every accepted decision under `## Decision outcomes`, so the user can
   see which ones are missing from the hub. If no write landed, the gate still passes.

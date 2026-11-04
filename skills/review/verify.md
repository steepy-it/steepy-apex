# review — Steps 2–3: verify the criteria, run the coherence gate

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

**Autopilot:** a promotion candidate is never a blocker on its own — Step 0's "never ask; unresolvable → BLOCKED" governs things the run cannot finish without a human, not documentation opportunities. Carry every candidate into the Step 4 report instead, for the human to act on at the Step 5 version-bump/PR decision.

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

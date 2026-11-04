# loop-engineer — Steps 2–5: invoke, report, preserve, hand off

### Step 2 — Invoke the packaged controller

Resolve `<engine-root>` from this skill's base directory and preserve each accepted path byte for
byte. The fresh invocation is exactly:

```bash
node <engine-root>/scripts/loop-engineer.mjs --repo-root . --goal '<goal-path>' --harness '<active-harness>' --commit-authorized --routing-index '.apex/_INDEX.md' --standard '<exact-standard-path>'
```

Fresh mode omits `--resume` and `--ledger`. The resume invocation is exactly:

```bash
node <engine-root>/scripts/loop-engineer.mjs --repo-root . --goal '<goal-path>' --harness '<active-harness>' --commit-authorized --routing-index '.apex/_INDEX.md' --standard '<exact-standard-path>' --resume --ledger '<loop-ledger-path>'
```

Repeat `--standard '<exact-standard-path>'` once per selected standard in the exact Step 1 order:
one flag for a single-file route, or core first and matching modular leaves after it.

Resume uses only the accepted `onDemand.loop-ledger` path; never derive or select another ledger.
Invoke the command once and let it run to its controller-owned terminal or halted result. The
controller owns the event stream, ledger lifecycle, prompt use (`loop-implementer-prompt.md` and
`loop-final-review-prompt.md`), attempts, verifier decisions, immutable evidence, commits, Git
reconciliation, and review budget. Do not emulate any of those operations when invocation fails.
The resume form is only for an interrupted run that has not recorded `RUN_HALTED`. A `HALTED`
result is permanently abandoned and not resumable. Preserve its goal, ledger, events, and evidence
unchanged; after the human resolves or accepts the condition, recovery requires a new ratified goal
at a distinct goal path and new loop workspace. Never delete or rewrite the abandoned state.

### Step 3 — Report controller output

Parse the controller's single JSON output. It has the closed summary fields `status`, `runId`,
`terminal`, `goal`, and `loop-ledger`. Report those values exactly; do not infer an outcome from the
goal or ledger and do not rewrite a controller status. `HALTED` with `terminal: false` is not terminal
completion: report the permanently abandoned result and require a new ratified goal at a distinct
goal path and new loop workspace, never a resume handoff. A nonzero
controller exit is a failure, not permission to run an inline substitute.

The terminal status domain is `GOAL_REACHED | BUDGET_EXHAUSTED | NO_IMPROVEMENT |
REVIEW_REJECTED`. Each is a completed run eligible for terminal review; only `GOAL_REACHED` claims
goal success.

### Step 4 — Preserve controller-owned lifecycle

For a terminal controller status, require `terminal: true` and require the exact returned paths to
equal the accepted goal and its accepted/derived canonical ledger path. That is the controller's
validated terminal result. Do not open, read, or parse the goal or ledger to recover lifecycle state,
and do not edit or repair either projection in prose. Fail only on controller-result or path mismatch;
preserve every artifact for exact resume or audit.

### Step 5 — Hand off

After the controller returns a validated terminal result and exact returned paths for `goal` and
`loop-ledger` paths match the accepted pair, emit the canonical Gear-4 review handoff below for
positive or negative terminal completion. Report those controller-returned paths verbatim. Do not
open their Markdown or emit the handoff for `HALTED`, a nonzero exit, or a result/path mismatch.

Alongside the envelope, emit the active harness's native review invocation when known. If native
invocation syntax is unknown or unavailable, do not invent syntax; emit only the canonical envelope.

```yaml
handoff: steepy-apex/v1
next: review
required:
  goal: <goal-path>
  loop-ledger: <loop-ledger-path>
onDemand: none
```

Run review in a new session: this phase's context does not serve review, and every turn of review
would otherwise pay to carry this phase's context.

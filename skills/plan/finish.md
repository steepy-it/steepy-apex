# plan — Steps 5–7: validate, review gate, hand off

### Step 5 — Validate (deterministic gate)

Run:

```bash
node <engine-root>/scripts/validate-hub.mjs .
```

It MUST print `steepy validate-hub: OK`. This skill never edits the stable hub, so any violation is pre-existing drift: report it and point the user to the `check` skill — do not fix the hub mid-plan. A plan under `.apex/work/plans/` is intentionally ignored by the linter and does not need registration or a stable back-link.

**Autopilot:** Before appending `DONE`, run the same canonical plan parse that the implement
phase will use:

```bash
node <engine-root>/scripts/autopilot-context.mjs --verify-plan --repo-root . --plan <authoritative-manifest-output-path>
```

It MUST print `plan OK`. A rejection is a fixable plan error: repair the plan, repeat the Step 4.5
self-review, and rerun both deterministic gates. Never append `DONE` for a plan this command has
not accepted.

### Step 6 — Human review gate and plan lifecycle

**Gear 3 only — human review gate.** A plan is prose. Every task it defines will pass under the per-task and
whole-branch code reviewers downstream, but the plan's *shape* — decomposition, spec coverage, task
ordering — is best caught by a human now. Do **not** dispatch a subagent. Tell the user:

> "Plan written to `<path>` — please review it and tell me if anything should change before we implement."

Wait for the response. On requested changes, edit the plan and re-run the Step 4.5 self-review.
Proceed only once the user approves.

**Gear 2 gate.** Ask no human-review question; the completed Step 4.5 self-review is the applicable
approval gate.

**Both gears.** Record the applicable approval and verification (Step 4.5, Step 5, and the human
approval or autopilot authorization) bound to the exact source/output paths and content before READY.
Only after those gates succeed, first atomically replace the plan to `status: READY` while retaining
`source: <exact-spec-path>`; then atomically replace the source spec to `status: CONSUMED` with
`consumed-by: <plan-path>`. Before publication, interruption leaves the spec READY and plan DRAFT;
between the two replacements, READY/READY is the sole repairable prefix. Use only the exact resume
capabilities and common proof checks to finish consumption; a finalized pair is an idempotent no-op.
Never repair a CONSUMED-spec/DRAFT-plan pair or consume an unverified plan.

Autopilot status timestamps must use UTC with three millisecond digits (`YYYY-MM-DDTHH:mm:ss.sssZ`), generated with `new Date().toISOString()`.

**Autopilot:** If `drive: autopilot` is present in the verdict contract (Step 0), the human gate is superseded — this is a non-blocking checkpoint. The plan file is on disk; the human can interrupt the run. Skip the question, do NOT wait, and append `<ISO timestamp> — plan — DONE — run-id=<conductor-supplied> attempt=<positive supplied> <plan path>` to `.apex/work/tasks/<spec-basename>/autopilot-status.md` (spec filename without `.md`; the status file already exists). Step 4.5 self-review and Step 5 validate-hub still run and still gate.

### Step 7 — Hand off

Only after the applicable Gear-2 or Gear-3 gate and lifecycle transition succeed, tell the user the next step is the `implement` skill, using the
native invocation spelling only when the active harness provides it. In manual drive emit:

```yaml
handoff: steepy-apex/v1
next: implement
required:
  plan: <plan-path>
onDemand:
  source-spec: <spec-path>
```

Run the `implement` skill in a new session: this phase's context does not serve implementation, and every turn of the implement phase would pay to carry it forward.

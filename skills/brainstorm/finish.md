# brainstorm — Steps 6–8: validate, review gate, hand off

### Step 6 — Validate (deterministic gate)

Run the linter:

```bash
node <engine-root>/scripts/validate-hub.mjs .
```

It MUST print `steepy validate-hub: OK`. Fix a violation only if your own Step 1.5 write-back introduced it. Anything else is pre-existing drift: report it and point the user to the `check` skill — do not fix unrelated hub docs here. A spec under `.apex/work/specs/` is intentionally ignored by the linter and does not need registration.

### Step 7 — Human review gate

**Gear 3 only** — skip in gears 1–2.

A spec is prose: the downstream code reviewers validate code *against* it, so they cannot catch a wrong requirement — a human must. Do **not** dispatch a subagent. Tell the user:

> "Spec written to `<path>` — please review it and tell me if anything should change before we plan."

Wait for the response. The human gate includes validating that the spec has exactly one `Feature complexity` field with an allowed value. On requested changes, edit the spec and re-run the Step 5.5 self-review. Proceed to handoff only once the user approves.

On that gear-3 human approval, record the ratification, approval and completed self-review/hub gate,
then publish the spec workflow header as `status: READY`. For gear 2, publish only after both
Step 5.5 and Step 6 succeed (its human gate is intentionally skipped). Interruption before those
gates complete leaves the spec `DRAFT`. This fresh producer consumes no historical input.

#### Drive mode (gear 3, on approval)

Once the user approves the spec, ask one more question: drive `manual` or `autopilot`?

- **`manual`** (default) → acknowledge the choice and state the approved spec's relative path (`.apex/work/specs/<spec-basename>.md`). When the active harness exposes the native plan invocation spelling, emit it; otherwise do not invent one. Then emit this canonical envelope and proceed to Step 8:

  ```yaml
  handoff: steepy-apex/v1
  next: plan
  required:
    spec: <exact-spec-path>
  onDemand: none
  ```
- **No headless mode on this harness** (any harness missing from `SUPPORTED_HARNESSES` in `adapters/headless.mjs`) → do not offer autopilot. Say explicitly that this harness has no headless mode, so the run stays manual — degradations are explicit, never silent.

On `autopilot`:

1. Anticipate implement Step 2's git decisions now, in one message: branch name (suggest one from the topic) + commit authorization (per-task commits). Create the branch.
2. Extend the verdict artifact at the spec head into the contract:

   ```
   <!-- verdict: <verdict> | gear: 3
   drive: autopilot
   branch: <branch-name>
   commit-auth: per-task
   harness: claude|codex|opencode
   blast-radius: branch-only, no-push, stop-before-PR
   log-mode: safe
   -->
   ```

   Keep the verdict text and gear unchanged — only turn the one-line comment into this multi-line contract block, so the closing `-->` moves to its own line at the end (`parseContract` reads the contract only when every field sits inside that one HTML comment). `harness` = the current harness. The `budget` field is rejected on fresh and resumed gear-3 contracts; do not author it. Write `log-mode: safe` by default and ask no logging question. Offer `exact` only when the user explicitly requests sensitive exact capture: warn that exact raw logs may contain secrets, write `log-mode: exact`, and state that the conductor will print and record `EXACT_LOGGING`.
3. Launch the conductor in background: `node <engine-root>/scripts/autopilot.mjs <spec-path>`.
4. Report the run's status path and live artifacts: `.apex/work/tasks/<spec-basename>/autopilot-status.md`, per-attempt readable `phase-<n>-attempt-<m>.log`, per-attempt raw `phase-<n>-attempt-<m>.raw.jsonl`, and aggregate `phase-<n>.log`. Report the native open/resume reference when supported. The run is no-steer: it halts on anything needing a human, and its branch-only boundary is stop-before-PR (`READY_FOR_PR`). The version-bump/PR decision (review Step 5) stays human, in an interactive session.

Drive mode adds nothing to the manual path: no new question is asked at gears 1-2, and answering `manual` changes nothing downstream.

### Step 8 — Hand off

**Gear 2, default direct route.** After Step 5.5 and Step 6 succeed, set the spec header to
`status: READY`, retain `next: implement`, and tell the user the next step is the `implement` skill
(invoke it the way the active harness invokes skills). Emit:

```yaml
handoff: steepy-apex/v1
next: implement
required:
  spec: <exact-spec-path>
onDemand: none
```

Run `implement` in a new session: this phase's context does not serve implementation, and every turn
of implementation would otherwise pay to carry the brainstorm context. Do not route Gear 2 through
`plan` unless the user explicitly requested the optional light plan before this handoff or the spec
cannot represent one independently testable implementation task. In that opt-in case, set
`next: plan` and use the same plan handoff as Gear 3.

**Gear 3.** Only after the Step 7 reviewer approves, hand the READY spec to `plan` using the canonical
envelope emitted in Step 7. Run `plan` in a new session: this phase's context does not serve planning,
and every turn of the plan phase would pay to carry it forward. Autopilot remains conductor-owned
after the blocking spec gate.

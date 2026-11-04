# brainstorm — Steps 0–1.5: gear, hub orientation, verdicts

### Step 0 — Read the gear

This is the fresh entry: use the human request, stable routed hub rules (Step 1), and ordinary
repository source evidence to recompute the coverage verdict inline (COVERED / CONFLICT / GAP with
`file:line` evidence → gear). It has no historical work inputs: never read a prior spec, log, or
verdict to choose coverage or gear, and do not perform work-area recovery discovery. Gear 3 is a
valid fresh entry, not a reason to demand an upstream brainstorm artifact.

Declare the recomputed
  verdict, gear, and evidence, then ask the user for one confirmation before the ceremony starts —
  the user may force a different gear, and the override is recorded in the verdict artifact. Then
  proceed.
Record that ratification in the new spec (or the new gear-1 local log), not an old artifact. If
gear 4 is confirmed, route to the `loop-engineer` skill and stop; this is not authority to fabricate
its required human-ratified goal contract. An explicit request to revisit existing work needs its
own user-delimited scope; the fresh entry's `required: none` grants no such read or overwrite.

Scale this skill's ceremony to the gear (see "Ceremony by gear" below). This skill dispatches **no
subagent reviewer**: a spec is prose, gated by the inline self-review (Step 5.5) plus a human review
of the written spec (Step 7), per `conventions.md` → "Review architecture (gear 3)".

**Session declaration (declare, never block).** Say whether this conversation started clean for this
phase or has already run an earlier phase of the chain in the same session. A same-session phase
already grew the context, and every turn of this phase now pays to carry it — name that cost, but
never refuse or gate on it: this is a declaration about the conversation, not a measurement, and
sound work proceeds either way. If the session's history cannot be determined with certainty, say so
and proceed. Under `drive: autopilot` this declaration is a no-op: the conductor
(`scripts/autopilot.mjs`) already opens a fresh headless session per phase, so the discipline stated
here is already enforced by that mechanism, not by this prose.

### Ceremony by gear

- **Gear 1** (COVERED + low-value): produce NO spec — state the task is COVERED + low-value, cite
  the governing rule, hand straight to the specialist agent, and stop.
- **Gear 2** (COVERED + high-value, or GAP + low-value): write a light spec that still carries the
  Step 5 machine contract, self-review it (Step 5.5), run `validate-hub`, **skip Step 7**, and hand
  the READY spec directly to
  `implement`. A light plan remains an explicit opt-in when the user already requested one or the
  spec cannot become one independently testable implementation task.
- **Gear 3**: run the full procedure, including the Step 5.5 self-review and the Step 7 human gate.
- **Gear 4**: not this skill's entry point — bounce to the `loop-engineer` skill and stop.

### Step 1 — Orient against the hub

Read `.apex/_INDEX.md` in full. If it does not exist, tell the user to run the `init` skill (invoke it
the way your harness invokes skills) first and stop. Classify the idea to its owning **surface** (or
note it as cross-cutting), then follow the exact standard links in the routing row: load its
single-file standard or modular core. For a core, match the mini-routing conditions against the
current idea's paths/topics, read every matching leaf in table order, and record the concrete reason
for each selection in the new spec. Zero matches means core only. Never manufacture
`.apex/standards/<surface>.md`, read unrelated leaves, or use a read-all fallback. The same actual
matched paths govern any later surface write-back; a filename convention is not routing authority.

### Step 1.5 — Resolve a CONFLICT or GAP verdict

If Step 0's verdict was COVERED, skip this step. Otherwise, resolve the verdict before moving on.

**On CONFLICT** (Step 0 found that a hub rule and the intended change contradict): stop
and surface the contradiction with its `file:line` citation. Default is **doc-wins**: the plan
bends to the documented rule — but never silently. Tell the user what the rule says and ask them
to confirm doc-wins, or to declare an explicit override.
- **Confirm** → proceed under the documented rule.
- **Override** → the doc changes: rewrite the governing doc (`standards/<surface>.md` or
  `conventions.md`) to state the new rule and its why in active form only — a stable doc never
  carries the superseded rule (history lives in git and the spec). Code and doc must never
  diverge silently.

**On GAP** (no rule decides it): **explore the codebase first**, before any user brainstorm.
- A **consistent latent convention** (≥2–3 concordant occurrences) means the code already decided
  it → do NOT brainstorm; **write it back** to the hub (see "Write-back routing" in `design.md`) so it
  becomes COVERED, then proceed.
- A **single isolated precedent** is weak → surface it to the user ("one precedent here — elevate
  to a rule or treat as a one-off?"); do not canonise automatically.
- **No precedent** → a genuine design gap → brainstorm with the user (Steps 2–4).

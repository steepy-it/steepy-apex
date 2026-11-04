# plan — Steps 0–1: gear, spec, and hub

### Step 0 — Read the gear

**Autopilot preflight:** When the conductor's `phasePrompt` supplies a phase manifest, read that
manifest before any other task input. Validate its role and scope against the plan phase and the
supplied correlation identity. Eagerly read every `required` input before acting. Do not preload `onDemand`;
consult it only for a concrete named missing fact and record the read in the plan phase
output/report. Phase-manifest authority applies only when `drive: autopilot`; manual-drive discovery
remains Step 1's behavior.

**Manual/no-manifest preflight — before the gear read:** Accept the exact `spec` capability before any verdict or spec-body read. Manual drive has two exclusive manual entry paths:

For an explicit resume, also require `onDemand.output-plan` in the envelope (or an exact labeled
`output-plan` alongside the labeled spec). Validate that exact input/output pair using the common
publication table before the fresh-only READY input gate below: READY/DRAFT resumes work,
READY/READY is finish-consumption, and CONSUMED/READY is no-op after proof revalidation. No other
state is accepted. The output header must be `phase: plan`, `next: implement`, with `source` equal
to the accepted spec and `consumed-by: none`; a consumed spec must name this exact output.
Read the output body only for the named missing approval/proof or draft-progress facts, record that
reason there when resuming work, and do not reopen sibling work. A verified terminal pair goes
straight to Step 7 after any sole consumption repair, without writing another plan or repeating gates.

1. **Explicit binding.** If the user supplied a `spec` handoff envelope or an exact spec path,
   validate the literal binding and path safety before its header read. The path must be an exact
   safe repository-relative path and the role must be exactly `spec`; then inspect only its bounded
   `steepy-workflow` header and require `phase: brainstorm`, `status: READY`, and `next: plan`.
   Exact valid input is accepted. Missing, malformed, stale, wrong-state, or wrong-role input fails
   closed: report the literal defect and stop without discovery or inferred correction.
2. **Bounded recovery.** Only when no envelope or path was supplied, enumerate the immediate specs
   directory (`.apex/work/specs/`, no recursion), inspect only bounded `steepy-workflow` headers,
   list candidates whose header is exactly `phase: brainstorm`, `status: READY`, `next: plan` with
   path and compact header metadata, and require user selection even when there is exactly one candidate.
   Never open or read a candidate body. Headerless artifacts are ignored by
   recovery. If no candidate exists, tell the user to run the `brainstorm` skill (invoke it the way
   the active harness invokes skills) first and stop. After selection, obtain and validate the exact
   binding before continuing.

Do not read the selected spec's verdict or body until that exact binding is accepted.
Read the verdict artifact (`verdict` + `gear`) only from the accepted `.apex/work/` spec head.
- **Artifact present:** honor its gear.
- **Artifact present with `gear: 4`:** this task belongs to the autonomous loop; bounce to
  the `loop-engineer` skill and stop.
- **Artifact with `drive: autopilot` (gear 3):** this run is an unattended autopilot phase. Confirm
  that the contract agrees with the conductor-supplied phase manifest already read first. Apply the
  Step 6 autopilot branch in `finish.md` and never ask the user anything.
  An invalid manifest, missing required input, undeclared or unwritable output, or anything else
  unresolvable is a manifest/output failure: append `<ISO> — plan — BLOCKED — run-id=<conductor-supplied> attempt=<positive supplied> <reason>` to `.apex/work/tasks/<spec-basename>/autopilot-status.md`
  and exit non-zero.
- **Artifact absent and this is gear-1/2 work:** recompute the coverage verdict inline (COVERED /
  CONFLICT / GAP with `file:line` evidence → gear). Declare the recomputed
  verdict, gear, and evidence, then ask the user for one confirmation before the ceremony starts —
  the user may force a different gear, and the override is recorded in the verdict artifact. Then
  proceed.
- **Artifact absent and full gear-3 ceremony is required for this command:** do not proceed
  blind — tell the user to enter through the upstream workflow chain first, and stop.

Scale this skill's ceremony to the gear (see "Ceremony by gear" below). This skill dispatches **no
subagent reviewer**: a plan is prose, gated by the inline self-review (Step 4.5) plus a human review
of the written plan (Step 6), per `conventions.md` → "Review architecture (gear 3)".

**Autopilot correlation.** Before appending any current-protocol status marker, use the `run-id` and
positive `attempt` supplied by the conductor's `phasePrompt`; that correlated identity is authoritative.
Do not derive either value from filenames. Do not invent a correlation identity. A child without supplied run/attempt identity
is unresolvable: exit non-zero without appending an uncorrelated new-protocol marker. Only versioned, correlated status is supported; uncorrelated markers never complete a phase.

**Session declaration (declare, never block).** Say whether this conversation started clean for this
phase or has already run an earlier phase of the chain in the same session. A same-session phase
already grew the context, and every turn of this phase now pays to carry it — name that cost, but
never refuse or gate on it: this is a declaration about the conversation, not a measurement, and
sound work proceeds either way. If the session's history cannot be determined with certainty, say so
and proceed. Under `drive: autopilot` this declaration is a no-op: the conductor
(`scripts/autopilot.mjs`) already opens a fresh headless session per phase, so the discipline stated
here is already enforced by that mechanism, not by this prose.

### Ceremony by gear

- **Gear 1**: no plan needed — say so and stop.
- **Gear 2**: an optional light plan is enough; self-review it (Step 4.5); skip only the human
  question in Step 6, then perform the shared lifecycle transition.
- **Gear 3**: run the full procedure, including the Step 4.5 self-review and the Step 6 human gate.
- **Gear 4**: not this skill's entry point — bounce to the `loop-engineer` skill and stop.

### Step 1 — Load the spec and the hub

**Manual drive:** after Step 0 accepts the exact spec capability, continue with that path only.
After stable bootstrap orientation, eagerly read only the accepted spec body, then read the stable
routing inputs `.apex/_INDEX.md` and `.apex/testing-and-checklist.md`. Never open a sibling or linked
work artifact. The accepted `source`/`consumed-by` fields authorize no transitive read.

**Autopilot:** use the validated phase manifest loaded in Step 0 as the authoritative input
inventory. Do not independently rediscover or preload inputs beyond its `required` list; use the
recorded `onDemand` protocol only when a concrete fact is missing.

After reading the required spec, routing index, testing checklist, and core/single standards,
inspect each required modular core's mini-routing table. Match every row against the required
spec's exact paths/topics. Read every matching leaf already declared in `onDemand`; for each read,
record the concrete reason as the matching leaf plus the exact spec path/topic that matched. This
matching step makes an implicated leaf a concrete named fact needed for planning. Zero matches
means core only. Never read all leaves as a fallback. Never read an unrelated leaf, and never guess
or manufacture an undeclared path. A single-file standard remains fully loaded from
`required` with no leaf-selection step.

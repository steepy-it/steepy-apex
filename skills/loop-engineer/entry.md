# loop-engineer — Steps 0–1: goal, routed inputs, authorization

### Step 0 — Read the gear

This skill executes **gear 4 only**. There is no "Ceremony by gear" scaling and no inline
recompute.

Validate the manual handoff before any work-artifact read. Fresh entry accepts exactly:

```yaml
required:
  goal: <goal-path>
onDemand: none
```

Resume accepts the same exact required goal and may additionally authorize the exact existing
ledger as `onDemand.loop-ledger`; read it only to resume named state. An explicit bad envelope fails
closed without recovery. With no envelope, pathless recovery may inspect headers only on goal
contracts, never bodies, and must require user selection followed by a new exact envelope. Never
select by date or recency.

Require this complete preamble before reading the goal body:

```yaml
<!-- verdict: <COVERED|CONFLICT|GAP> | gear: 4 -->
<!-- steepy-workflow: v1
phase: goal-contract
status: READY
next: loop-engineer
source: none
consumed-by: none
-->
```

After one Markdown title, require exactly one canonical line for every mandatory body field:
`goal`, `surface`, `verifier`, `mode`, `budget`, `blast-radius`, and `notes`; metric mode also
requires `metric-direction`, while boolean mode forbids it. Require `mode: boolean | metric`,
`metric-direction: min | max` where applicable, a positive canonical integer `budget`, a registered
lowercase `surface`, a shell-free verifier argv, and safe repo-relative comma-separated blast-radius
globs. Reject duplicate, unknown, multiline, empty, or malformed fields.

The verdict header at the head of `goal.md` is the human-ratified authorization for autonomy. Fields below it may be pre-filled, but this execution skill does not author or complete that authorization.

Branch on three outcomes:

1. **`goal.md` with the exact gear-4 verdict/header AND all mandatory fields:** proceed.
2. **Header present but `gear` ≠ 4:** **refuse** — the task was classified elsewhere; never hijack it into a loop.
3. **`goal.md` absent, header missing, or ANY mandatory field missing:** **refuse before any iteration, branch mutation, or commit question**. Name every missing field and require a complete human-authored, gear-4-ratified goal contract before `loop-engineer` is invoked again. Do not route this through the generated project bootstrap: that bootstrap owns root/index navigation and semantic-skill routing only.

**Never recompute the gear inline** here and **never fabricate or interview for a field value**: a loop with no human-authored, ratified contract is exactly the silent autonomy the invariant forbids.

**Session declaration (declare, never block).** Say whether this conversation started clean for this
phase or has already run an earlier phase of the chain in the same session. A same-session phase
already grew the context, and every turn of this phase now pays to carry it — name that cost, but
never refuse or gate on it: this is a declaration about the conversation, not a measurement, and
sound work proceeds either way. If the session's history cannot be determined with certainty, say so
and proceed. Under `drive: autopilot` this declaration is a no-op: the conductor
(`scripts/autopilot.mjs`) already opens a fresh headless session per phase, so the discipline stated
here is already enforced by that mechanism, not by this prose.

### Step 1 — Load routed inputs and authorize the controller

Read `.apex/_INDEX.md` and require exactly one exact routing row for the goal's `surface`. For a
single-file route, carry its exact registered standard. For a modular route, carry the registered
core followed by only the matching leaves, preserving their mini-routing table order; zero matches
means core only. Pass this ordered inventory through Step 2 exactly. Never synthesize or manufacture
`.apex/standards/<surface>.md`, preload unrelated standards, or grant any child general
`.apex/work/**` access. If a mandatory field in the goal is missing, return to the **Step 0 refusal**; this
skill never completes the authorization artifact.

Select the current active harness only if `adapters/headless.mjs` has a supported headless mapping
for it. The current harness identity comes from the active runtime; do not ask the user to invent a
harness name. A missing mapping is `runner-unavailable`: stop or refuse without dispatch, mutation,
or an inline runner fallback. Native invocation syntax is never guessed.

After the contract and harness checks, ask exactly once before starting the controller:
**"Authorize controller-owned commits for this run?"** Both boolean and metric modes require `yes`.
A refusal ends before controller invocation. This authorization is for the complete fresh or resumed
run and is never delegated to a model child or re-asked per attempt.

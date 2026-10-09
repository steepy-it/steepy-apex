# Inception native acceptance protocol

This protocol is a release gate after review. It is not a review criterion: review judges the repository, and this gate judges the skill running in a real harness. Nothing here is run by the test suite.

## Setup rule

Every run loads the branch's packaged plugin, with the installed steepy-apex release disabled. An older installed Stop hook reports `missing _INDEX.md` on every inception turn and spoils the evidence. Record the loaded plugin commit in the matrix.

## Scenarios

### Scenario A: empty repository

1. Start in an empty repository (Git initialized, no files).
2. Run the `inception` skill. Answer as a human; approve the project at the approval pause.
3. Let the run reach `complete`.
4. Run the `init` skill, then the `discovery` skill with the inception source.
5. Confirm the hub validates and the inception source is offered and consumed once.

On Claude Code, scenario A includes one unplanned interruption: stop the session between an effect's intent and its outcome, then resume in a new session. The resumed run must report the effect as uncertain and must not mark it succeeded without a human decision.

### Scenario B: starter plus design system or prototype

1. Start in a repository holding a starter and a design system or prototype.
2. Run the `inception` skill; the existing material is reconnaissance input, not a decision.
3. Reach `complete`, then run the `init` skill and the `discovery` skill with the inception source.

### Scenario C

Scenario C is deferred out of v1. It has no row in the matrix.

## Copy validation

A copy of only the versioned files (for example a `git clone` of the branch) must validate: `node <engine-root>/scripts/validate-hub.mjs .` prints OK without `.apex/inception/` and `.apex/work/`. Check this after each completed scenario.

## Evidence rules

- A hand-written command sequence imitating the skill is not a proof. Only a run driven by the skill counts.
- A model's approval is never recorded as a human approver. Leave the cell empty or `none` if no human approved.
- Record observed facts only. An unrun row stays `PENDING`.

## Evidence matrix

| Run | Harness version | Plugin commit | Capabilities | Observed outcome | Observed human approver |
|---|---|---|---|---|---|
| Claude Code A (with interruption) | PENDING | PENDING | PENDING | PENDING | PENDING |
| Claude Code B | PENDING | PENDING | PENDING | PENDING | PENDING |
| Codex A | PENDING | PENDING | PENDING | PENDING | PENDING |
| Codex B | PENDING | PENDING | PENDING | PENDING | PENDING |

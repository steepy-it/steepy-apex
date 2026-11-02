---
name: implement
description: Execute a READY Gear-2 spec directly or a hub-governed plan under TDD, scaling code-diff review and downstream handoff to the recorded gear.
user-invocable: true
---

# implement

Execute either a READY Gear-2 spec directly or an approved plan **one task at a time**. You
orchestrate; the bound `<surface>-agent` implements under rigid TDD. Gear 2 uses implementer
self-review plus deterministic gates and terminates here. Gear 3 additionally spends code-diff
reviewers and hands the result to the `review` phase.

> **Engine root:** this skill's base directory is `<engine-root>/skills/implement/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

## Execution discipline

Keep between-task updates brief: which task finished and what comes next (e.g. "Task 2 approved, moving to Task 3") — the ledger and the tool results carry the record. Never ask "should I continue?" between tasks; execute the accepted input straight through. The only reasons to stop mid-run are an unresolved **BLOCKED** status, a genuine **NEEDS_CONTEXT** question from an implementer, a direct Gear-2 spec that requires decomposition, a fix loop parked by the fix-round cap, or all tasks complete.

## Checklist

- [ ] Autopilot (`drive: autopilot`): read the co-located `autopilot-protocol.md` and take verdict/gear/drive from its contract (Step 0)
- [ ] Manual/no-manifest: accept either the direct Gear-2 exact spec or the plan-backed exact plan + source-spec capabilities; never merge the alternatives (Steps 0–1)
- [ ] Derive the task directory, `ledger.md`, and task-result index solely from the accepted entry artifact basename; resume only with exact `progress-ledger` + `task-results` capabilities
- [ ] Ask once: confirm the working branch (if on `main`/`master`) and commit-after-each-task authorization — or read both from the autopilot contract (Step 2)
- [ ] Verify the Gear-3 task-result handoff parses before claiming completion; close Gear 2 locally after its deterministic gates (Step 5)
- [ ] Pre-flight: scan the accepted spec or plan once for internal conflicts, batching only plan-backed conflicts to the user (Step 2.5)
- [ ] Per task (sequential): brief → dispatch `<surface>-agent` (`implementer-prompt.md`) → diff → review (`task-reviewer-prompt.md`, gear 3 + non-mechanical only) → fix loop → mark complete
- [ ] After the last task: whole-branch review (`final-review-prompt.md`, gear 3 only) → fix loop
- [ ] Gear 3 only: hand off to the `review` skill with only criteria + task-results + branch-diff

## Fix-round cap

A review-fix loop that stops converging is not healthy work, so it has a cap. The cap applies on its
own to each task's loop (Step 3) and to the whole-branch loop (Step 4), inline same-session review
passes included.

- A fix round is one fix dispatch plus its re-review. Before each fix dispatch, append
  `Task N: fix round <R> (model: <tier>)` — or `Final review: fix round <R> (model: <tier>)` — to
  the ledger. Count rounds from those ledger lines, never from memory.
- Rounds 1–3 run the fix at the tier the task already uses (for the whole-branch loop, the owning
  task's tier).
- If round 3's re-review still finds issues, move the fix up one tier (cheap → standard →
  most-capable), add `escalated: <from>→<to>` to the round-4 line, and allow rounds 4–5 there.
- Park the loop when round 5's re-review still finds issues, or after round 3 when no higher tier
  is left (the fix already runs at `most-capable`, or the harness offers no per-dispatch model).
  Manual drive: stop and give the user the open issues artifact (`task-N-issues.md` or
  `final-review-issues.md`) with the ledger's round lines. Autopilot (`drive: autopilot`): append
  the correlated `BLOCKED` marker from `autopilot-protocol.md` and exit non-zero.
- Only the user restarts a parked loop. Record their decision as `Task N: fix loop restarted by
  user (<reason>)` — or `Final review: fix loop restarted by user (<reason>)` — and count rounds
  after the latest such line. Never raise the cap or restart the count on your own.

## Procedure

The steps live in co-located files, each read in full at the point named here:

| Steps | File | Read it |
|---|---|---|
| Handoff envelope, resume pairs, publication order | `manual-handoff.md` | before accepting any input, and again before Step 5 publishes |
| 0–2.5: read the gear, load the input, confirm branch and commits, pre-flight scan | `entry.md` | at the start of every run, fresh or resumed |
| 3–4: per-task loop, child protocol, whole-branch review | `task-loop.md` | before dispatching the first task |
| 5: hand off | `finish.md` | after the last task, before the closing gates |

Only this SKILL.md is meant to stay in context for the whole run; a context compaction can drop
the step files you read earlier. Before you act on a step, its file must be fully in view. If it is
not — after a compaction, on resume, or when only a summary of it remains — re-read it from this
skill's base directory first. Never act on a summary of a step file.

## Model Selection

Always set `model:` explicitly when dispatching a subagent. An omitted model inherits the session model (usually the most capable and most expensive) and silently defeats this policy.

Pick the tier by task complexity and risk:

| Signal | Tier |
|--------|------|
| Mechanical / transcription (1-2 files, complete spec) | cheap |
| Integration / multi-file / judgment | standard |
| Design / architecture / high-risk or subtle change | most-capable |

Reviewers floor at **standard** and rise to **most-capable** when the artifact is high-risk or subtle.

**Turn count beats token price.** The cheapest model often takes 2-3× the turns on multi-step work — more wall-clock and context overall. Make a mid-tier model the floor for reviewers and for implementers working from prose; reserve the cheapest tier for transcription tasks whose exact code the plan already contains.

Translate the tier to a concrete model by judgment at dispatch time using your harness's available models. The three tiers are the whole ladder — `most-capable` is its top rung, not an open-ended "best available". A model that sits above that rung is outside the ladder: never reach it from a tier, and record a one-line reason in the ledger when you override to it. The whole-branch review runs at the reviewer tier — `standard`, rising to `most-capable` when the branch is large or subtle — not at whatever model the harness happens to offer. On a harness without per-dispatch model choice, everything runs on the session model — record that in the ledger.

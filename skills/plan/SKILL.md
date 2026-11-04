---
name: plan
description: Turn a local working spec into a step-by-step implementation plan. Each step names the owning surface and specialist agent and the surface test command; the plan is written into .apex/work/plans/ as a gitignored work artifact.
user-invocable: true
---

# plan

Turn an approved spec into an implementation plan whose every task states the change it makes, not
the goal it chases, with review checkpoints.

> **Engine root:** this skill's base directory is `<engine-root>/skills/plan/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

## Checklist
0. In autopilot, read the supplied phase manifest first; then read the gear and scale ceremony to it (Step 0).
1. Load the spec and the hub (routing table + owning surface standard); in autopilot, match and
   record every implicated modular leaf (Step 1).
2. Map files and tasks.
3. Bind each task to the hub (surface, specialist agent, test command, complexity).
4. Write the plan into `.apex/work/plans/`.
4.5. Self-review the plan inline — free gate, gear 2 and 3 (Step 4.5).
5. Validate with `validate-hub.mjs` (deterministic gate).
6. Human review gate — ask the user to review the written plan before handoff (gear 3).
7. Hand off to the `implement` skill.

## Procedure

The steps live in co-located files, each read in full at the point named here:

| Steps | File | Read it |
|---|---|---|
| Handoff envelope, resume pairs, publication order | `manual-handoff.md` | before accepting any input, and again before Step 6 publishes |
| 0–1: read the gear, load the spec and the hub | `entry.md` | at the start of every run, fresh or resumed |
| 2–4.5: map files and tasks, bind them to the hub, write the plan, self-review it | `tasks.md` | before mapping the first task |
| 5–7: validate, human review gate and lifecycle, hand off | `finish.md` | after the self-review passes |

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

Translate the tier to a concrete model by judgment at dispatch time using your harness's available models. The three tiers are the whole ladder — `most-capable` is its top rung, not an open-ended "best available". A model that sits above that rung is outside the ladder: never reach it from a tier, and record a one-line reason in the ledger when you override to it. On a harness without per-dispatch model choice, everything runs on the session model — record that in the ledger.

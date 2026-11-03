---
name: brainstorm
description: Turn an idea into a local working spec under .apex/work/specs/. Classifies the idea against the routing table, dialogues one question at a time, proposes approaches, and on approval writes the spec as a gitignored work artifact.
user-invocable: true
---

# brainstorm

Turn an idea into a local working spec informed by the hub. Do not write code or scaffold anything in this skill — the only artifact produced is the spec.

> **Engine root:** this skill's base directory is `<engine-root>/skills/brainstorm/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

## Checklist
0. Derive coverage and gear from the human request and stable routed evidence; obtain ratification (Step 0).
1. Orient against the hub (routing table + owning surface standard).
1.5. Resolve a CONFLICT (doc-wins, or override that rewrites the doc) or GAP (explore-first, then write-back or brainstorm) verdict.
2. Understand the idea — grill it against the hub, one question at a time (gear 2–3).
3. Propose 2–3 approaches.
4. Present the design as a draft in `.apex/work/specs/` and get approval, section by section (gate).
5. Finalize the approved draft — fold in the review changes; the header stays `status: DRAFT` until the approval gate passes.
5.5. Self-review the spec inline — free gate, gear 2 and 3 (Step 5.5).
6. Validate the stable hub with `validate-hub.mjs` (deterministic gate).
7. Human review gate — ask the user to review the written spec, then choose drive mode: manual or autopilot (gear 3).
8. Hand Gear 2 directly to `implement`; hand Gear 3 to `plan` (Step 8).

## Procedure

The steps live in co-located files, each read in full at the point named here:

| Steps | File | Read it |
|---|---|---|
| Handoff envelope, resume pairs, publication order | `manual-handoff.md` | before accepting any input, and again before the spec is published (Step 7 in Gear 3, Step 8 in Gear 2) |
| 0–1.5: read the gear, orient against the hub, resolve a CONFLICT or GAP verdict | `entry.md` | at the start of every run, fresh or resumed |
| 2–5.5: understand the idea, propose approaches, present and finalize the design, self-review, write-back routing | `design.md` | before the first design question |
| 6–8: validate, human review gate and drive mode, hand off | `finish.md` | after the self-review passes |

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

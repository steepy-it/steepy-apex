---
name: loop-engineer
description: Validate and authorize a gear-4 goal contract, invoke the packaged deterministic loop controller, report its result, and hand off terminal evidence to review.
user-invocable: true
argument-hint: '[goal description]'
---

# loop-engineer

Validate and authorize a **machine-verifiable Gear-4 goal**, then route it into the packaged
deterministic controller. This skill is the human/controller boundary. It does not implement the
loop's state machine in prose and it does not write feature code.

> **Engine root:** this skill's base directory is `<engine-root>/skills/loop-engineer/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

### Controller responsibility boundary

Skills authorize and route; scripts own deterministic state. In particular, this skill must not:

- allocate attempts or decide when an attempt is available;
- run keep/discard policy or decide a verifier verdict;
- interpret ledger Markdown as state (the ledger is only a controller projection);
- perform Git recovery, cleanup, rollback, commit, or reconciliation;
- grant extra fixes beyond the ratified mutation budget; or
- offer an inline runner fallback when the active harness has no supported headless runner.

The packaged engine owns all of those decisions, including the sanity verifier, immutable event
stream, controller-owned commits, blast-radius enforcement, terminal branch review, and goal/ledger
lifecycle. The later terminal review owns the mandatory `validate-hub.mjs .` coherence gate; the
loop controller neither claims nor duplicates that review evidence.

## Checklist

- [ ] Validate the exact fresh/resume handoff and complete ratified Gear-4 goal before autonomy (Step 0)
- [ ] Read only stable routed hub inputs, select the active supported harness, and obtain the single
      human authorization for controller-owned commits (Step 1)
- [ ] Invoke `node <engine-root>/scripts/loop-engineer.mjs` with the exact fresh/resume CLI (Step 2)
- [ ] Report the controller's closed output without reconstructing or overriding state (Step 3)
- [ ] Preserve controller-owned lifecycle and terminal evidence (Step 4)
- [ ] Emit the exact Gear-4 `review` handoff for a terminal result (Step 5)

## Procedure

The steps live in co-located files, each read in full at the point named here:

| Steps | File | Read it |
|---|---|---|
| Handoff envelope, resume pairs, publication order | `manual-handoff.md` | before accepting any input, and again before Step 5 hands off |
| 0–1: read the gear, load routed inputs, authorize the controller | `entry.md` | at the start of every run, fresh or resumed |
| 2–5: invoke the packaged controller, report its output, preserve its lifecycle, hand off | `controller.md` | before invoking the controller |

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

---
name: review
description: Verify implemented work against its spec with real evidence before any "done" claim. Checks the spec's success criteria, runs the surface test command, and runs validate-hub.mjs as a mandatory coherence gate.
user-invocable: true
---

# review

Verify completed work with evidence. Never assert "done" without command output to back it.

> **Engine root:** this skill's base directory is `<engine-root>/skills/review/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

## Checklist

- [ ] In autopilot, read the supplied phase manifest first; then read the gear and scale ceremony to it (Step 0)
- [ ] Manifest-backed autopilot: load criteria-only source + task index + diff + standards, then match and record every relevant modular leaf; regular manual review: load accepted criteria + task-result index + branch diff + stable routed inputs; Gear 4: load the exact goal contract + loop ledger instead (Step 1)
- [ ] Run `capture-review-evidence.mjs` once: keep verbatim command output in the current run's
      `evidence-report.md`, consume only its compact JSON receipt, and judge every criterion in
      session (Step 2)
- [ ] For Gear 4, validate goal/ledger provenance and the ledger event commitment, then prove the
      exact claimed terminal outcome without confusing negative completion with goal success (Steps 1–2)
- [ ] Sweep unpromoted insights from the active inventory: manifest criteria + task-result index in autopilot; manual insight sweep uses only accepted criteria + task-result index compact status and `signals` (Step 2)
- [ ] Confirm the receipt contains a green `validate-hub` command result (Step 3)
- [ ] Report: `validate-hub` green AND every regular criterion or Gear-4 terminal claim verified
      from real command output
- [ ] Resolve the version bump (or apply `no-release`) and offer a PR to `main` only for regular
      review or Gear-4 `GOAL_REACHED`; suppress release/PR for negative terminal outcomes (Step 5)

## Procedure

The steps live in co-located files, each read in full at the point named here:

| Steps | File | Read it |
|---|---|---|
| Handoff envelope, resume pairs, publication order | `manual-handoff.md` | before accepting any input, and again before Step 4 publishes |
| 0–1: read the gear, load bounded review inputs and the hub | `entry.md` | at the start of every run, fresh or resumed |
| 2–3: verify against the criteria source, discovery signals, coherence gate | `verify.md` | before capturing evidence |
| 4–5: report, version bump, offer a pull request | `finish.md` | after the coherence gate |

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

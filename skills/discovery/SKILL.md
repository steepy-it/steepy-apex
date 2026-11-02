---
name: discovery
description: Populate and refresh `.apex` hub docs (glossary, surface standards, cross-surface conventions) from the real codebase via a seeded, per-item confirmed interview. Re-runnable — a second run surfaces only new or drifted items.
user-invocable: true
---

# discovery

Populate and refresh the hub's prose docs — `glossary.md`, each surface standard (the single
`standards/<surface>.md` file or the modular `standards/<surface>/` folder), and `conventions.md` —
from the actual codebase, via a seeded interview the user confirms item by item.

`discovery` is a **standalone** hub-aware skill, like `init` / `new-surface` / `check` — it is not
part of the brainstorm → plan → implement → review chain. It has its own precondition step (Step 0) and
does not follow the chain skills' shared gear-selection or Model-Selection-lock format.

> **Engine root:** this skill's base directory is `<engine-root>/skills/discovery/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

## Procedure

The steps live in co-located files, each read in full at the point named here:

| Steps | File | Read it |
|---|---|---|
| 0–1: preconditions, run scoping | `entry.md` | at the start of every run |
| 2: per-surface iterative loop | `surface-loop.md` | before the first surface |
| 2a: inception source, only after a complete inception run | `inception-source.md` | when Step 1 scopes an inception source |
| 3–4: coherence gate, report | `finish.md` | after the last surface or source |

Only this SKILL.md is meant to stay in context for the whole run; a context compaction can drop
the step files you read earlier. Before you act on a step, its file must be fully in view. If it is
not — after a compaction, on resume, or when only a summary of it remains — re-read it from this
skill's base directory first. Never act on a summary of a step file.

## Model Selection

Always set `model:` explicitly when dispatching the Explore subagent in Step 2.2 and the inception
explorer in Step 2a.2 — an omitted model inherits the expensive session model and defeats the tier
policy. Floor at `standard`; rise to `most-capable` for a large or subtle surface. The inception
explorer runs at `standard`. Translate the tier to a concrete model by judgment at
dispatch time using your harness's available models; `most-capable` is the ladder's top rung, not an
open-ended "best available", and a pricier model sitting above it is never reached from a tier.
Never hardcode a concrete model id in `explore-surface-prompt.md` or `explore-inception-prompt.md`.

This flow dispatches **no reviewer subagent**: every write is prose to a stable doc, gated per item by
the human in the Step 2.4 seeded interview (Step 2a.3 for the inception source); `validate-hub`
(Step 3) is the deterministic net. The Explore subagent dispatched in Step 2.2 and the inception
explorer dispatched in Step 2a.2 are explorers, not reviewers.

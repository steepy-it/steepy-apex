---
name: inception
description: Take a new application from its starting materials to an approved, verified bootstrap, then hand it to init for a governed hub. Works before any .apex hub exists.
user-invocable: true
---

# inception

Take a new application from its starting materials to an approved, verified bootstrap. Then hand
the result to `init`, which builds a hub that works without this run's local files.

`inception` is the pre-hub skill. It needs no `.apex` hub to start. It is not one of the five chain
skills and not a standalone hub-aware skill: it has no gear and adds no chain role, handoff grammar,
or controller. Until `init` runs it creates no hub artifact: no routing, standard, specialist agent,
or project bootstrap. Its state lives only in the local area `.apex/inception/`.

> **Engine root:** this skill's base directory is `<engine-root>/skills/inception/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

## Rules for every phase

- Talk with the user one question at a time, with numbered options and a recommendation. Use your
  harness's question UI if it has one.
- The user approves the whole project once, before bootstrap. After that, work on your own inside
  the approved scope. A substantial change needs a targeted decision and a new approval of the
  changed bytes.
- Stay stack-agnostic. Propose no preset stack. Back every foundational choice with the official
  sources you consulted.
- Under `.apex/inception/**`, read only the descriptor (through `inspect`) and the exact run files
  the current step names. Never list, search, or pick a most-recent file there. Never read
  `.apex/work/**`. Give a child agent only the exact paths it needs.
- Helpers check formats, paths, digests, and receipts. You own the dialogue, the architecture
  judgement, the reading of evidence, and the promotion decisions. A helper result never proves that
  a human approved or that a rule is right.

## Step 0 — Classify the starting point

Check whether `.apex/_INDEX.md` exists, then run:

```bash
node <engine-root>/scripts/inception-state.mjs inspect --root . --state .apex/inception/state.json
```

It reads only the descriptor and its ignore guard. Route on the result:

- `absent`, no `_INDEX.md`, and an empty repository, a starter, a design system, or a UI/UX
  prototype → start a run (Step 1).
- `absent`, no `_INDEX.md`, and a mature application (real product code with its own build and
  tests) → do not start; recommend `init`, then `discovery`.
- `absent` with `_INDEX.md` → the hub is operational; use the ordinary workflows. Do not start.
- `incomplete` → a start stopped before its descriptor; run Step 1 again. It completes only that start.
- `pre-hub` → a run exists; resume it (see Resume).
- `init-in-progress` → `init` was interrupted; resume the `init` skill with the handoff the
  descriptor pins (`init.handoff.path`).
- `init-complete` → the transfer is done. If the descriptor phase is not `complete` yet, close the
  run (`init-handoff.md` → "Close the run"); otherwise use the ordinary workflows.
- `invalid` → stop and report the reason. Repair nothing automatically.

When the repository fits more than one route — for example a prototype close to a product —
present the routes and let the user decide.

## Step 1 — Start the run

Load `protocol.md`, then run:

```bash
node <engine-root>/scripts/inception-state.mjs start --root . --state .apex/inception/state.json
```

`start` writes the local ignore guard first, checks that Git ignores the area, then writes the
descriptor and the run directory. It never overwrites a run. If it warns that files in the area are
already tracked, tell the user; never run `git rm` yourself. Report the run id and the descriptor
digest.

## Phases

Load one support file per phase, when the phase starts. Load `protocol.md` before the first write
under `.apex/inception/` and before every descriptor update. Record each phase change with `update`
before you work on the new phase.

| Descriptor phase | Load | Leave when |
|---|---|---|
| `reconnaissance` | `reconnaissance.md` | materials, facts vs simulations, constraints, goals, flows, harness, and Git policy are recorded |
| `architecture` | `architecture.md` | the project documents describe the architecture, the reuse, and the representative path |
| `research` | `architecture.md` | every foundational choice has an official source, a version, and a date |
| `approval` | `architecture.md` | the user approved the whole project and the approval is bound |
| `bootstrap` | `bootstrap.md` | the bootstrap installs, builds, tests, starts, and runs the representative path |
| `verification` | `init-handoff.md` | the results and the final code checkpoint are recorded |
| `init` | `init-handoff.md` | `init` reports the transfer complete |
| `complete` | `init-handoff.md` | the final delivery is reported |

## Stop conditions

Stop, set `status: blocked` with `update`, and ask the user when:

- a determining input cannot be read;
- a change would leave the approved scope;
- an external effect has an uncertain outcome;
- code and recorded evidence diverge in a way you cannot explain.

Before you stop, print a resume note: the descriptor path, the current phase, and every run file the
phase uses.

## Resume

Resume only from exact paths: the descriptor (through `inspect`), the files it references, and the
run files the user names — normally the ones in the last resume note. Never rebuild the run by
listing its directory.

1. Run `inspect`. Take the phase, the status, and the references from the descriptor. If the
   descriptor is still the initial one and `.apex/inception/<run-id>/` is missing, run `start` again
   with `--run-id <run-id>`: it completes that exact start and changes nothing else.
2. Check the approval: each project document must still match its approved digest
   (`protocol.md` → "Approval record"). A mismatch is a change after approval: ask for a targeted
   decision and record a new approval before more bootstrap.
3. Check the code: record a new checkpoint with the same inventory at a new exact path and compare
   it with the recorded one. Explain every difference before you continue.
4. Read the bootstrap log. Done steps stay done. A step with an intent but no observed outcome is
   uncertain: reconcile it by observing its real effect; never repeat it automatically.
5. Set `status: active` and continue in the recorded phase.

## Exit

The run ends when `init` has finalized the transfer, the descriptor records `phase: complete` and
`status: complete`, and the final delivery is reported. A run the user abandons stays local: nothing
in it becomes stable knowledge.

The next skill is `init`, invoked with the exact handoff path. After the run, use the ordinary
workflows on the new hub.

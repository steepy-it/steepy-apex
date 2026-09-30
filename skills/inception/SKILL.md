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
  the approved scope, except at the planned pauses (see "Session boundaries"). A substantial change needs a targeted decision and a new approval of the
  changed bytes.
- Stay stack-agnostic. Propose no preset stack. Back every foundational choice with the official
  sources you consulted.
- Under `.apex/inception/**`, read only the descriptor (through `inspect`) and the exact run files
  the current step names. Never list, search, or pick a most-recent file there. Never read
  `.apex/work/**`. Give a child agent only the exact paths it needs.
- Helpers check formats, paths, digests, and receipts. You own the dialogue, the architecture
  judgement, the reading of evidence, and the promotion decisions. A helper result never proves that
  a human approved or that a rule is right.

## Child agents

- A child gets its exact input paths and one exact output path under `.apex/inception/<run-id>/`.
  It writes its full result there. It returns only the completion block below, plus a summary of at
  most 15 lines. Read its output file only for a named missing fact.

```text
status: <DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED>
artifact: <repo-relative path>
changed-paths: <comma-separated repo-relative paths or none>
signals: <short IDs or none>
```

- Every dispatch sets `model:` to an abstract tier, and the harness translates it to a concrete
  model: research → `standard`; an isolated experiment (spike) → `standard`; a bootstrap part →
  `most-capable`. Never write a concrete model name.
- Run one child at a time. A research child may run in the background while you continue the
  dialogue with the user.
- Never load a reference skill and never look up external documentation yourself; such lookups run
  inside a child. The user's own materials are not external documentation: open those yourself.
- A child never writes the descriptor, an approval record, a checkpoint, the bootstrap log, a commit,
  another part's paths, or a file `init` writes (`protocol.md` → "Code checkpoint").
- Without a subagent tool, run the work inline and record the degradation in the run file of that
  phase.

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
- `incomplete` without `_INDEX.md` → a start stopped before its descriptor; run Step 1 again. It
  completes only that start.
- `pre-hub` without `_INDEX.md` → a run exists; resume it (see Resume).
- `pre-hub` or `incomplete` with `_INDEX.md` → a leftover run beside an operational hub: report it
  and ask the user. Never resume it automatically.
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
| `reconnaissance` | `reconnaissance.md` | materials, facts vs simulations, constraints, stack preferences, the version policy, goals, flows, harness, and Git policy are recorded |
| `architecture` | `architecture.md` | every applicable decision category is decided, then the project documents describe the architecture, the reuse, and the representative path |
| `research` | `architecture.md` | the chosen combination is pinned, every foundational choice has an official source, a version, and a date, and the user confirmed the version review |
| `approval` | `architecture.md` | the user approved the whole project and the approval is bound |
| `bootstrap` | `bootstrap.md` | the bootstrap installs, builds, tests, starts, and runs the representative path |
| `verification` | `init-handoff.md` | the results and the final code checkpoint are recorded |
| `init` | `init-handoff.md` | `init` reports the transfer complete |
| `complete` | `init-handoff.md` | the final delivery is reported |

## Session boundaries

The run spans three sessions:

1. reconnaissance → architecture → research → approval;
2. bootstrap;
3. verification → init → complete.

There are two planned pauses:

1. **After approval.** The one update that binds the approval sets phase `bootstrap`.
2. **After bootstrap.** The update sets phase `verification`.

At each pause, do these in order:

1. Complete the descriptor update, so that a resume lands in the new phase.
2. Wait for every running child to finish. Never pause while a child is running.
3. Print the resume note: the descriptor path, the phase, and every run file the next phase uses.
   After approval, that is the approval record, the project documents, and the research files. After
   bootstrap, add the bootstrap log, the bound checkpoint, and the `bootstrap/<part>.md` reports.
4. Recommend a new session that invokes the `inception` skill.
5. End the turn.

The status stays `active`. A planned pause is not a stop (see "Stop conditions"). A new session
resumes through Step 0 → Resume.

Continue in the same session only when the user explicitly asks. Pause; never refuse.

Why: every later turn carries the whole context. Declaring the cost does not reset it; the pause does.

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
2. If an approval is bound, check it: each project document must still match its approved digest
   (`protocol.md` → "Approval record"). A mismatch is a change after approval: ask for a targeted
   decision and record a new approval before more bootstrap.
3. If a checkpoint is bound, check the code: record a new checkpoint with the same inventory at a
   new exact path and compare it with the recorded one. Explain every difference before you continue.
4. Read the bootstrap log. Done steps stay done. A step with an intent but no observed outcome is
   uncertain: reconcile it by observing its real effect; never repeat it automatically.
5. Set `status: active` and continue in the recorded phase.

## Exit

The run ends when `init` has finalized the transfer, the descriptor records `phase: complete` and
`status: complete`, and the final delivery is reported. A run the user abandons stays local: nothing
in it becomes stable knowledge.

The next skill is `init`, invoked with the exact handoff path. After the run, use the ordinary
workflows on the new hub.

---
name: inception
description: Turn an idea and its starting materials into a minimal, verified, runnable application before the hub exists — reconnaissance, architecture decisions, verified versions, one human approval, bootstrap of one representative path, and final verification — then hand off to init and discovery.
user-invocable: true
---

# inception

Turn an idea and its starting materials into a minimal, verified, runnable application. The run
starts before the hub exists and ends with a hand-off to the `init` skill, then the `discovery`
skill.

`inception` is a **pre-hub skill**: it runs while `.apex/_INDEX.md` does not exist yet. It is not
a gear, and it is outside the brainstorm → plan → implement → review chain. It has no headless or
autopilot mode: a human answers its questions and approves the project.

> **Engine root:** this skill's base directory is `<engine-root>/skills/inception/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

## Boundaries

- Work only inside `.apex/inception/` and the application's own files. Never create
  `.apex/_INDEX.md`, routing, standards, specialist adapters, or a project bootstrap: those belong
  to the `init` skill after completion.
- One run per repository, at `.apex/inception/run.json`. Only the helper mutates the descriptor,
  effect records, frozen evidence, snapshots, approvals, checkpoints and completion. Never edit
  these records or adopt an unbound file as evidence. Runs use the v2 descriptor; any other schema
  is an unsupported run format that every helper command refuses, with no migration, archive or
  automatic restart.
- The first run write is `.apex/inception/.gitignore`, written by `start`. Never create or edit the
  root `.gitignore` for this area; an approved application generator may change it as an observed
  application effect.
- Working documents and coordinator JSON inputs belong under `project/`, research reports under
  `research/`, and part/check reports under `bootstrap/`. The helper owns `units/`, `approvals/`,
  `snapshots/`, `checkpoints/`, `effects/`, `reconciliations/`, `resume-notes/`, all verification
  evidence/results/reports, and archive records. `.apex/work/` is never a run input.
- Persist before work: once a run exists, begin a unit before any decision, research, child
  dispatch, application write, or effect, and finish it before a phase transition, approval,
  checkpoint, or cycle registration (`helper.md` → "Persisted work units and recovery").

## Procedure

The steps live in co-located files, each read in full at the point named here:

| Steps | File | Read it |
|---|---|---|
| Helper commands, JSON input rules, exit codes, persisted work units and recovery | `helper.md` | before you run any helper command |
| 0–1: classify the starting state, start or resume the run | `entry.md` | at the start of every session, fresh or resumed |
| 2–6: reconnaissance, architecture decisions, research and versions, project and approval, pause after approval | `project.md` | before reconnaissance |
| 7–9: bootstrap, effects and checkpoints, pause after bootstrap | `bootstrap.md` | before the bootstrap; and in any session before you prepare or observe an effect (Step 8) |
| 10: final verification and conclusion | `verification.md` | after the bootstrap, before final verification |
| Blocking and abandon | `blocking.md` | as soon as material is unreadable, scope changes, an effect is uncertain, divergence is unexplained, or the user asks to abandon |

Only this SKILL.md is meant to stay in context for the whole run; a context compaction can drop
the step files you read earlier. Before you act on a step, its file must be fully in view. If it is
not — after a compaction, on resume, or when only a summary of it remains — re-read it from this
skill's base directory first. Never act on a summary of a step file.

## Sessions and context

Recommend three sessions: reconnaissance/architecture/research/approval, bootstrap, then verification
and conclusion. Pauses are recommendations and never authorize work or require a new approval.
Recovery works from any persisted point, independent of chat history. Earlier context is paid on
each turn, so new sessions can reduce cost; continue in the same session when requested.

## Children and dispatch policy

Only one child or other work-unit writer runs at a time. Research may run while the coordinator
prepares dialogue, but another decision unit or document writer waits for its finish. A child gets
an already persisted unit ID, exact input paths, exact report output and correlation; bootstrap also
gets exact allowed application paths. Children never inherit coordinator read capability, list run
records, or mutate helper state. The coordinator reads the complete report and checks observed diff
before finish; a terse response alone is insufficient.

Translate abstract tier to the concrete available model at dispatch, and record the actual model
and degradation in the report/next note. Without subagents execute the same prompt inline with
explicit degradation. Each prompt returns status/artifact/changed-paths/signals after its full report.

| Template | Tier | Bindings |
|---|---|---|
| `research-prompt.md` | `standard` | `[UNIT_ID]`, `[INPUT_PATHS]`, `[OUTPUT_FILE]`, `[CORRELATION]`, `[QUESTION]` |
| `bootstrap-part-prompt.md` | `most-capable` | `[UNIT_ID]`, `[INPUT_PATHS]`, `[OUTPUT_FILE]`, `[CORRELATION]`, `[PART]`, `[ALLOWED_PATHS]` |

## Harness capabilities and degradations

Use what your harness really has, as declared in Step 1:

- No subagents → run each child's work inline, with a declared degradation.
- No question tool → ask in plain prose: one question, numbered options, and a recommendation.
- No network → the Step 4 rule: ask the user for official sources or block, and never pin a
  remembered version.
- There is no headless or autopilot mode on any harness: a human answers and approves.

Record each exercised degradation in the reconnaissance record. A degradation first met after
approval goes in the next resume note (`--note=<value>`), because the approved documents never
change.

# Bootstrap Part Prompt (steepy inception)

If your harness provides a task/subagent tool, dispatch a fresh child for one bootstrap part
during an inception run (Step 7), one part at a time, in dependency order. Otherwise build the part
yourself in a dedicated pass over the same inputs, and write the inline degradation in the part
report. The child modifies only its own application paths, writes its full report to one file, and
returns a terse status. It never talks to the user, never touches the run state, and never runs an
operation with effects: the coordinator runs those.

```
Subagent (bootstrap part):
  model: most-capable  # abstract tier; the dispatcher translates the tier to a concrete model
  description: "Build bootstrap part [PART] for an inception run"
  prompt: |
    You build one part of an approved project during an inception run: a project that turns an
    idea into a minimal, verified application before its hub exists. The project is approved; you
    do not change its decisions.

    **Part:** [PART]
    **Input paths:** [INPUT_PATHS]
    **Allowed paths:** [ALLOWED_PATHS]
    **Report file:** [OUTPUT_FILE]

    Read exactly the files in [INPUT_PATHS], plus the application files under [ALLOWED_PATHS].
    Never list or read anything else under `.apex/inception/`, and never read `.apex/work/`. The
    coordinator supplies these paths; do not infer another run file.

    ## Your part

    [ALLOWED_PATHS] are the only application paths you may modify. Build this part's share of the
    representative path, at the approved versions. Never build every prototype screen. Reuse the
    chosen materials and keep the agreed behaviors.

    ## Effects

    Run no installs, generators, migrations, deploys, commits, or remote operations. When the part
    needs one, list it in the report as an effect the coordinator must run: the exact command, its
    purpose, and what it changes. You may run local build and test checks.

    If the part needs a change outside [ALLOWED_PATHS] or outside the approved project, stop and
    report it; do not make it.

    ## Report

    Write the full report to [OUTPUT_FILE]; it is your only report write. It holds what you built,
    every application file you changed, the effects the coordinator must run, each local check with
    its exact command and observed result, and any blocker.

    Then return ONLY these four unbulleted fields, in order:

    status: <DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED>
    artifact: [OUTPUT_FILE]
    changed-paths: <paths or none>
    signals: <short IDs or none>
```

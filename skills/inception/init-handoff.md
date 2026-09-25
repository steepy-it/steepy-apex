# Verification and transfer to init

Load this when the descriptor phase is `verification`, `init`, or `complete`. Goal: prove what runs,
hand exact inputs to `init`, and close the run.

## Final verification

Run every check from a clean state: install, build, test, start, the representative path, and the
preserved behaviors. Write the results to `.apex/inception/<run-id>/verification.md` with the
structure of `<engine-root>/templates/inception-verification.md`:

- each check → environment, exact command, reference output, result, limits;
- the installed combination → the versions actually resolved (lockfile, tool version output) match
  the approved research; report a mismatch, never hide it;
- keep `configured`, `executed`, `succeeded`, `not-executed`, and `failed` distinct;
- local CI and remote success are separate fields;
- deploy excluded → say so with its reason; it is not needed to conclude;
- deploy included → never "succeeded" without evidence.

Finish the commits the Git policy allows before the final code checkpoint. Then record the final
code checkpoint and bind it (`protocol.md` → "Code checkpoint"). From then on, change no code and
make no commit until `init` finalizes: a changed file or a moved HEAD diverges the checkpoint.
The helper rejects checkpoint and promotion destinations that are physical aliases before prepare,
including a missing destination reached through a different supported mount of the same physical path.

## Inputs for init

Write these run files (`protocol.md` → "Transfer to init"):

1. `confirmed-inputs.json` — the six fields `init` uses. Take each value from the approved project or
   from the verification evidence. A value neither gives → ask one targeted question. Never re-ask for
   values the approval already covers.
2. `promotion.json` — one row per significant decision, built with the matrix below.
3. `init-handoff.json` — the six roles, each an exact path.

Set phase `init` with `update`. Then invoke the `init` skill with the exact handoff path. `init`
asks only for missing data, new decisions, and real conflicts.

If `prepare` reports a pending finalization intent, resume with `finalize` through the helper after
the gate checks; do not restart promotion. A prepared receipt without intent follows the normal
resume path. The helper refuses an ambiguous old complete receipt whose descriptor remains prepared
without intent; preserve the receipt and descriptor. The helper must never offer cleanup or re-baseline
of that prefix.

If `init` reports `diverged` before it starts, loop back: re-run the checks the change affects,
record and bind a new checkpoint, then write a new handoff at a new exact path. Once `init` has
started, its handoff is pinned: restore the checkpointed code instead.

If `init` refuses the promotion table as incomplete before it starts, add the missing standard rows
and hand off again: write a new handoff at a new exact path.

## Promotion matrix

Classify each decision first:

- approved and verified → may be described as an existing component or rule;
- approved, not yet verified → a chosen rule, never claimed as built;
- future (flows outside the representative path, backlog ideas) → context only.

Then choose one outcome:

- promote → a stable destination and the exact text `init` writes there, with its reason;
- exclude → a reason it stays local (research notes, rejected alternatives, logs).

Destinations are stable hub documents: surface standards, `conventions.md`, `glossary.md`,
`testing-and-checklist.md`, `project-context.md`, and `project-architecture.md` under `.apex/`. Future
flows go to `project-context.md` → "Future flows" as context, never as components, specs, or a
started backlog. A destination is never a checkpoint path or a local area.

Cover every section `init` creates from a template:

- every confirmed surface → `promote` decisions for `.apex/standards/<name>.md` that cover its Scope
  (owns, does not own, exemplar), Conventions, and Anti-patterns. Take them from the approved project
  and the verified code.
- `project-architecture.md` and `project-context.md`, once any decision goes to them → a `promote`
  decision for each of their sections, **Version policy** included.
- a section with no approved content → promote one short explicit statement, for example "Not
  decided at inception; refine with `discovery`." Never leave the template text.

`verify` and `prepare` refuse a promotion table without a `promote` decision for some confirmed
surface's standard. They check only that the decision exists; the text is your judgement.

## Close the run

When `init` reports the transfer complete (`inspect` → `init-complete`), set `phase: complete` and
`status: complete` in one update. Then deliver:

- the hub: `.apex/_INDEX.md`, its routing, and the promoted documents;
- the evidence: the verification results, including what did not run;
- deploy: excluded with its reason, or included with its evidence;
- deferred flows: kept as context in `project-context.md`.

No backlog item is implemented or turned into an approved spec. Next work starts from the ordinary
workflows.

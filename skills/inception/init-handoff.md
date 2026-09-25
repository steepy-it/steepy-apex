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

Then record the final code checkpoint and bind it (`protocol.md` → "Code checkpoint").

## Inputs for init

Write these run files (`protocol.md` → "Transfer to init"):

1. `confirmed-inputs.json` — the six fields `init` uses. Take each value from the approved project or
   from the verification evidence. A value neither gives → ask one targeted question. Never re-ask for
   values the approval already covers.
2. `promotion.json` — one row per significant decision, built with the matrix below.
3. `init-handoff.json` — the six roles, each an exact path.

Set phase `init` with `update`. Then invoke the `init` skill with the exact handoff path. `init`
asks only for missing data, new decisions, and real conflicts.

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

## Close the run

When `init` reports the transfer complete (`inspect` → `init-complete`), set `phase: complete` and
`status: complete` in one update. Then deliver:

- the hub: `.apex/_INDEX.md`, its routing, and the promoted documents;
- the evidence: the verification results, including what did not run;
- deploy: excluded with its reason, or included with its evidence;
- deferred flows: kept as context in `project-context.md`.

No backlog item is implemented or turned into an approved spec. Next work starts from the ordinary
workflows.

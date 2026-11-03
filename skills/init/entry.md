# init — Steps 0–2: mode, project model, interview record

### Step 0 — Choose fresh init or repair

Check for `.apex/_INDEX.md` before generating anything:

- Absent means **fresh init**.
- Present means **repair** of an existing hub. Repair is non-destructive: preserve existing files,
  the routing table, git policy, glossary, standards, work artifacts, and customized generated files.
  Create only absent files and append only missing routing rows. Never overwrite or delete a user-owned
  file to make repair succeed.

Before changing any files, check only the exact `.apex/inception/run.json` descriptor when it exists.
A descriptor with schema `steepy-inception-run/v2` and phase/status `complete` is eligible for the
first post-complete governance receipt in Step 3; an unsupported run format is never certified or
migrated. Never list `.apex/inception/` or read its document bodies for init.

Check the exact canonical `.apex/init-provenance.pending.json` and `.apex/init-provenance.json`
paths before a fresh `verify-complete` gate: a pending receipt intentionally makes that gate red.
For an interrupted pending init, jump directly to **Pending certification recovery** in `apply.md` before
any repair stamp or hub writes. Skip Steps 1 and 2, fresh detection/interview, model projection,
rendering, and fresh Step 3 preview/conflict resolution. Recover the same retained governance input
at `.apex/work/init/<runId>/governance-input.json` and its original operation plan at
`.apex/work/init/<runId>/scaffold-plan.json`. Missing either exact artifact stops recovery; never
reconstruct a plan or choose a historical work file. If the final receipt exists, retain it unchanged;
ordinary subsequent init/repair remains available, but new changes are not certified by the old receipt.
Do not prepare a replacement receipt or re-run source verification as a prerequisite for ordinary repair.
An explicit replay of completed certification may use the idempotent `inception-governance.mjs finish`
command in `finish.md` (Step 5); a failure reports that certificate's problem, without silently
recreating it. Pending recovery failure stops its writes.

Run the coherence linter once in repair to inventory real gaps:

```bash
node <engine-root>/scripts/validate-hub.mjs <repo-root>
```

If the existing index lacks the `steepy-hub-version` stamp, add the current stamp as the first line;
otherwise preserve it exactly. The insertion is guarded by the missing-stamp condition and is not a
license to regenerate the file.

### Step 1 — Detect and confirm the complete model

Run:

```bash
node <engine-root>/scripts/detect-stack.mjs <repo-root>
```

Use the detector only to propose values. Interview one question at a time until the user has confirmed:

- `projectName`;
- `description`, including an explicitly confirmed empty string;
- every `devCommands` entry;
- the complete `surfaces` list, with each surface's `name`, `path`, semantic specialist `agent`, and
  `testCmd`;
- additions and removals from the detected surface list;
- the complete `domainVocabulary` decision and any confirmed term/definition entries; use
  `{ "hasSpecializedVocabulary": false, "entries": [] }` when the user confirms there is none;
- the repository git policy, rendered when present as
  `4. **Git policy:** <the user's confirmed policy text verbatim>`.

For repair, treat existing hub values as inputs to confirm, not as permission to invent missing values.
Ask once for confirmation of the complete record. Do not proceed until every value is confirmed.

### Step 2 — Serialize the record and derive the planner input

Serialize the complete authoritative confirmed interview record to one temporary JSON file outside the
repository. After confirmation, keep that file byte-for-byte unchanged for the entire run. It is the
only authority for confirmed values; never recover a value from transient chat state and do not re-run
detection after confirmation.

Derive a disposable `<planner-model-json>` from that record. Copy `projectName`, `description`,
`devCommands`, and complete `surfaces` without loss, then add `resolutions: {}`. Validate that the
projection has exactly the five Project model v1 keys shown in `SKILL.md` → "Exact planner projection". Delete both temporary files only
after successful completion; retain their exact paths for interrupted-init recovery, without treating
an unrelated work artifact as an input.

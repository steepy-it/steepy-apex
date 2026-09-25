---
name: init
description: Scaffold or repair a governed .apex hub and portable project instructions from one confirmed project model.
user-invocable: true
---

# init

Build or repair a complete `.apex/` governance hub without losing confirmed project data or overwriting user-owned content.

> **Engine root:** this skill's base directory is `<engine-root>/skills/init/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

## Workflow contract

The interview produces one immutable, authoritative confirmed interview record. It retains every
confirmed value used later by the planner or hub renderer, so no confirmed input lives only in transient
chat state. Both fresh init and repair use that record and the same planner workflow. The planner owns
generated provenance and update mechanics; this skill does not copy its marker strings or reproduce its
merge logic. On the inception entry, the record comes from the inception handoff instead of an interview.

#### Authoritative confirmed interview record

```json
{
  "projectName": "project-slug",
  "description": "confirmed description or empty string",
  "devCommands": ["npm test"],
  "surfaces": [
    {
      "name": "web",
      "path": "apps/web",
      "agent": "web-agent",
      "testCmd": "npm test"
    }
  ],
  "domainVocabulary": {
    "hasSpecializedVocabulary": true,
    "entries": [
      { "term": "confirmed term", "definition": "confirmed definition" }
    ]
  },
  "gitPolicyDirective": "4. **Git policy:** confirmed policy text"
}
```

#### Exact planner projection

Derive this planner projection from the authoritative confirmed interview record:

```json
{
  "projectName": "project-slug",
  "description": "confirmed description or empty string",
  "devCommands": ["npm test"],
  "surfaces": [
    {
      "name": "web",
      "path": "apps/web",
      "agent": "web-agent",
      "testCmd": "npm test"
    }
  ],
  "resolutions": {}
}
```

The planner CLI input is Project model v1 and has exactly those five top-level keys; never add
`domainVocabulary`, `gitPolicyDirective`, or any other unsupported key because unknown keys are rejected.
The projection is derived data, not a second source of truth. Hub documents use the authoritative record
directly for values outside Project model v1.

## Procedure

### Entry — Check for an inception transfer

Before the fresh/repair choice, run:

```bash
node <engine-root>/scripts/inception-state.mjs inspect --root <repo-root> --state .apex/inception/state.json
```

It reads only the inception descriptor and its ignore guard. Route on the result:

- an exact inception handoff path from the user, or `init-in-progress` → "Inception entry" below.
  `init-in-progress` means an earlier init was interrupted: keep its accepted inputs and resume with
  the handoff the descriptor pins (`init.handoff.path`).
- `absent` or `init-complete` → the ordinary path: Step 0. `init-complete` wins even when a handoff
  path is supplied: the transfer is already done.
- `pre-hub` without a handoff path → an inception run exists that has not handed off yet. Ask whether
  to finish it with the `inception` skill or to run an ordinary init that leaves it unused.
- `incomplete` or `invalid` → report the reason and ask before continuing. Never repair the inception
  area.

### Step 0 — Choose fresh init or repair

Check for `.apex/_INDEX.md` before generating anything:

- Absent means **fresh init**.
- Present means **repair** of an existing hub. Repair is non-destructive: preserve existing files,
  the routing table, git policy, glossary, standards, work artifacts, and customized generated files.
  Create only absent files and append only missing routing rows. Never overwrite or delete a user-owned
  file to make repair succeed.

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
projection has exactly the five Project model v1 keys shown above. Delete both temporary files when the
workflow ends.

### Step 3 — Preview, resolve exact conflicts, then apply

Always run preview first:

```bash
node <engine-root>/scripts/project-scaffold.mjs --hub <repo-root> --model <planner-model-json>
```

Parse the emitted JSONL preview. If it reports conflicts, ask the user only for the conflict `id`s and the `choices` emitted for those IDs:

- Never offer an unlisted choice and never broaden the question into a second general confirmation.
- If the user selects `abort`, stop and do not apply.
- Otherwise rewrite only `resolutions` in the planner projection from the selected `id` → choice pairs.
  Regenerate the other four planner keys from the authoritative confirmed interview record, never from
  the prior projection or chat.
- Keep `domainVocabulary` and `gitPolicyDirective` byte-for-byte unchanged in the authoritative record;
  conflict resolution never writes that record.
- Repeat the preview command. If the conflict set changes, discard stale resolutions and ask only for
  the currently emitted IDs and choices.
- Continue until `conflicts` is empty (zero unresolved conflicts). A non-zero preview exit caused by
  conflicts is a repair question, not permission to write.

After a zero-conflict preview, apply the exact retained model immediately:

```bash
node <engine-root>/scripts/project-scaffold.mjs --hub <repo-root> --model <planner-model-json> --apply
```

Preview must precede apply on every run. Pass the exact zero-conflict planner-projection bytes to apply,
without another derivation or mutation. Apply without asking for a second general confirmation: the
confirmed record and the exact conflict-choice questions are the complete authorization. The planner
re-previews internally before writing; never bypass that check or implement a separate repair path.

### Step 4 — Complete the governed hub

Create missing stable hub documents from the authoritative confirmed interview record. Use the engine
templates; `domainVocabulary` is the only source for glossary scaffolding, and `gitPolicyDirective` is the
only source for the index directive. In repair, preserve every existing document and append only missing
routing rows; never regenerate `.apex/_INDEX.md`.
For a fresh index, render `{{projectName}}`, `{{routingRows}}`, and `{{gitPolicyDirective}}` from the
authoritative confirmed interview record; an empty git-policy directive remains an intentional empty value.
Each confirmed surface produces:

- `.apex/standards/<name>.md`;
- `.claude/agents/<agent>.md`;
- `.codex/agents/<agent>.toml`;
- `.opencode/agents/<agent>.md`.

The planner creates the portable root instructions, canonical project bootstrap at
`.agents/skills/<projectName>-bootstrap/SKILL.md`, its thin Claude adapter, and the specialist
adapter triads. It owns their generated provenance; do not paste any provenance marker into this skill.

Create `.apex/work/.gitignore` with exactly:

```gitignore
*
!.gitignore
```

Create `.apex/work/specs/` and `.apex/work/plans/` for local workflow artifacts. In repair, leave an
existing `.apex/work/.gitignore` untouched. Never create `.apex/specs/`, `.apex/plans/`, or specs/plans
sub-index files.

### Step 8 — Validate and report

Run:

```bash
node <engine-root>/scripts/validate-hub.mjs <repo-root>
```

Do not report completion until it prints `steepy validate-hub: OK`. For repair, label every artifact
`created`, `appended`, or `preserved`. Report the canonical bootstrap and every surface standard plus
specialist adapter triad. Recommend the `discovery` skill by its semantic name to populate empty standards and
glossary entries. Remind the user to review the generated files before committing.

## Inception entry

The handoff replaces Steps 1–2: its `confirmed-inputs` record is the authoritative confirmed interview
record, already confirmed. Never repeat the general interview. Read only the handoff and the exact
paths it names; the `inception` skill owns every other file of its run.

1. **Verify the transfer.** Run:

   ```bash
   node <engine-root>/scripts/inception-handoff.mjs verify --root <repo-root> --handoff <handoff-path>
   ```

   An error stops the entry: report it. A changed approved document needs a new approval in the
   inception run, not here.
2. **Reconcile code and decisions.** Compare the record and the promotion table with the current
   code: surface paths, dev and test commands, and every component a promoted text calls existing.
   Use `detect-stack.mjs` only as a hint. Reuse every value already confirmed. Ask only for:
   - a planner conflict → Step 3's choices;
   - a divergence between decisions and code, including `status: diverged` from `verify` → never
     resolve it silently; the user decides between new evidence in the inception run and stopping;
   - a datum a hub document needs that the record and the promotion table do not hold → one targeted
     question; the answer goes only into that document.
3. **Start init.** Before the first hub write, run:

   ```bash
   node <engine-root>/scripts/inception-handoff.mjs prepare --root <repo-root> --handoff <handoff-path> --receipt .apex/inception/<run-id>/init-receipt.json
   ```

   On resume, omit `--receipt`: the descriptor binds the receipt. A destination reported `changed`
   differs from its prepared bytes and still misses promoted text. It can hold this entry's own partial
   write or a human edit: compare it with what this entry writes, keep this entry's own bytes, and ask
   the user only about text this entry did not write; never overwrite human text. Do not commit
   between `prepare` and `finalize`: a moved HEAD diverges the checkpoint.
4. **Plan and apply.** Derive the planner projection into a temporary file outside the repository:

   ```bash
   node <engine-root>/scripts/inception-handoff.mjs project --root <repo-root> --handoff <handoff-path> > <planner-model-json>
   ```

   Then run Step 3 unchanged. For each chosen conflict, derive it again with
   `--resolution <id=choice>`; the record never changes.
5. **Complete the hub.** Run Step 4 with the record as its authoritative input. Then write each
   promoted text verbatim at its destination. Create `project-context.md` and `project-architecture.md`
   from `<engine-root>/templates/project-context.md` and `<engine-root>/templates/project-architecture.md`
   when a promotion needs them, and link them from `_INDEX.md`. Append to existing documents; never
   overwrite human text. Write chosen rules as rules with their reasons, keep observed patterns labeled
   as observed, and write excluded decisions nowhere. The hub gains routing, standards, glossary,
   conventions, testing, and project context from the record and the promotion table. On resume,
   documents already written stay; write only what is missing.
6. **Verify and finalize.** Run Step 8's gate. Then check that the hub stands without local areas:
   copy the files Git would version (`git ls-files --cached --others --exclude-standard`; without Git,
   every file except `.apex/inception/` and `.apex/work/`) to a temporary directory outside the
   repository, run `validate-hub.mjs` on the copy, and delete it. Only when both pass, run:

   ```bash
   node <engine-root>/scripts/inception-handoff.mjs finalize --root <repo-root> --handoff <handoff-path> --gate pass
   ```

   It checks unchanged code and every promoted text, completes the receipt, and records init
   complete. On a refusal, fix the cause and run it again; never record completion by hand. Report
   each decision's receipt outcome, then return to the `inception` skill to close the run.

The ordinary path keeps its temporary record and deletes it at the end. The inception entry keeps the
run's `confirmed-inputs` record in place: it is the authoritative copy a resume needs. Delete only the
temporary planner projection.

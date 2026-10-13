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
merge logic.

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

### Step 0 — Choose fresh init or repair

Check for `.apex/_INDEX.md` before generating anything:

- Absent means **fresh init**.
- Present means **repair** of an existing hub. Repair is non-destructive: preserve existing files,
  the routing table, git policy, glossary, standards, work artifacts, and customized generated files.
  Create only absent files and append only missing routing rows. Never overwrite or delete a user-owned
  file to make repair succeed.

Before changing any files, check only the exact `.apex/inception/run.json` descriptor when it exists.
A descriptor with schema `steepy-inception-run/v2` and phase/status `complete` is eligible for the
first post-complete governance receipt in Step 3; a legacy run is never certified or migrated.
Never list `.apex/inception/` or read its document bodies for init.

Check the exact canonical `.apex/init-provenance.pending.json` and `.apex/init-provenance.json`
paths before a fresh `verify-complete` gate: a pending receipt intentionally makes that gate red.
For an interrupted pending init, jump directly to **Pending certification recovery** below before
any repair stamp or hub writes. Skip Steps 1 and 2, fresh detection/interview, model projection,
rendering, and fresh Step 3 preview/conflict resolution. Recover the same retained governance input
at `.apex/work/init/<runId>/governance-input.json` and its original operation plan at
`.apex/work/init/<runId>/scaffold-plan.json`. Missing either exact artifact stops recovery; never
reconstruct a plan or choose a historical work file. If the final receipt exists, retain it unchanged;
ordinary subsequent init/repair remains available, but new changes are not certified by the old receipt.
Do not prepare a replacement receipt or re-run source verification as a prerequisite for ordinary repair.
An explicit replay of completed certification may use finish's idempotent check; a failure reports that
certificate's problem, without silently recreating it. Pending recovery failure stops its writes.

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
projection has exactly the five Project model v1 keys shown above. Delete both temporary files only
after successful completion; retain their exact paths for interrupted-init recovery, without treating
an unrelated work artifact as an input.

### Step 3 — Preview, resolve exact conflicts, then apply

For fresh init and ordinary repair, always run preview first:

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

After a zero-conflict preview, retain the exact planner-projection bytes. Ordinary init/repair skips
the conditional certification block below and proceeds directly to apply.

#### Post-complete certification (conditional)

For the first fresh init
following complete v2 (no canonical receipt yet), run this read-only gate before any Step 3 or Step 4
writes or source-body reads:

```bash
node <engine-root>/scripts/inception-state.mjs verify-complete --repo-root <repo-root>
```

Require exit 0 and `ok: true`, retaining the returned `runId` and exact `completion` Ref. A failure
(legacy, tamper, application-drift, or any other refusal) stops certification and writes; do not silently
turn a failed certified init into ordinary init. Ordinary init/repair without this first-post-complete
case keeps the existing interview, preview and conflict procedure.

Render all stable hub documents now, before Step 3 apply and Step 4 hub writes, from the engine
templates and authoritative confirmed interview record. The document set is exactly `.apex/_INDEX.md`,
`.apex/conventions.md`, `.apex/glossary.md`, `.apex/testing-and-checklist.md`, and
`.apex/standards/<surface>.md` for every confirmed surface. Existing hub documents are create-only
under this certificate: never replace one to obtain a receipt. Keep the rendered strings byte-for-byte;
Step 4 writes these exact retained document bytes, without a second rendering. The same retained
zero-conflict model is `projectModel`, including its selected `resolutions`.

#### Governance input shape

The following is a shape example; replace its illustrative values with the retained model, returned
completion Ref, and complete rendered document strings, never placeholder digests or content:

```json
{
  "schema": "steepy-inception-governance-input/v1",
  "runId": "<returned runId>",
  "completion": { "path": "<returned completion path>", "bytes": 1, "sha256": "<returned digest>" },
  "projectModel": {
    "projectName": "project-slug",
    "description": "confirmed description or empty string",
    "devCommands": ["npm test"],
    "surfaces": [{ "name": "web", "path": "apps/web", "agent": "web-agent", "testCmd": "npm test" }],
    "resolutions": {}
  },
  "documents": [
    { "path": ".apex/_INDEX.md", "content": "<exact rendered index bytes>" },
    { "path": ".apex/conventions.md", "content": "<exact rendered conventions bytes>" },
    { "path": ".apex/glossary.md", "content": "<exact rendered glossary bytes>" },
    { "path": ".apex/testing-and-checklist.md", "content": "<exact rendered checklist bytes>" },
    { "path": ".apex/standards/web.md", "content": "<exact rendered standard bytes>" }
  ]
}
```

Serialize `<governance-input-json>` as the exact repo-relative
`.apex/work/init/<runId>/governance-input.json` in this init run's authorized output scope. Never write
this input inside the completed run. Do not enumerate work artifacts to recover it. On interrupted
receipt recovery, use the same retained input bytes and prepare before continuing; the producer checks
its reservation and any already-applied prefix rather than adopting a new preview as authority.

Before the first prepare, retain the original zero-conflict plan, including complete operation
contents and prior digests, as `<scaffold-plan-json>` =
`.apex/work/init/<runId>/scaffold-plan.json`. Obtain it with the public
`planProjectScaffold({ hubRoot: repoRoot, model: retainedProjectModel })` using the exact confirmed
zero-conflict model, and validate it with `validateProjectScaffoldPlan`; require `conflicts.length === 0`.
Serialize that full plan create-only before prepare and keep it unchanged across every interruption.
If this fresh planning detects a changed conflict set, return to the normal conflict preview before
preparing anything; after preparation, never plan again. The input, producer model (including resolved
choices), rendered documents, retained plan, and completed run stay immutable.

```bash
node <engine-root>/scripts/inception-governance.mjs prepare --repo-root <repo-root> --input <governance-input-json>
```

Require exit 0 and `ok: true` before any planner or hub writes. The producer uses the public planner to
bind exact root/bootstrap/specialist operations; do not reproduce it in skill prose or import receipt
contents as permission for other changes. Keep the input until finish and both gates succeed, and retain
it across interruptions. Never exclude an entire provider directory to make this gate pass.

For certified init, after prepare execute the retained-plan recipe under **Pending certification
recovery** for the initial scaffold apply too, then continue Step 4. Ordinary init/repair instead applies
the exact retained model through the normal CLI:

```bash
node <engine-root>/scripts/project-scaffold.mjs --hub <repo-root> --model <planner-model-json> --apply
```

The ordinary CLI path always previews before apply and internally re-previews the exact zero-conflict
model. Pass those retained projection bytes without another derivation or mutation. Apply without asking for a second general confirmation: the confirmed record and exact conflict choices are the authorization.
The certified retained-plan path uses the same public planner/apply validation without fresh planning
once an immutable preparation exists.

#### Pending certification recovery

This is the direct Step 0 branch for a pending receipt, and also the apply path immediately after a
fresh certified prepare. First call the prepare command above with the same retained governance input
bytes; require exit 0 and `ok: true`. Do not run `project-scaffold.mjs --model ... --apply` for recovery:
that CLI plans again and can reject a selected conflict resolution after its operation has already
finished. Do not remove resolutions, re-interview, re-render, or issue a new reservation.

Run the following JavaScript as an ESM module with Node, substituting only the exact engine root,
repository root, governance input path and retained plan path. It uses exported validators, checks
that the original plan's exact operations match the prepared producer reservation, then calls the
public idempotent `applyProjectScaffold` API. Already-applied operations are preserved; only still-pending
operations are published under the API's normal lease and preflight checks. Missing, invalid or
mismatched retained state fails before apply, without a fresh plan fallback.

<!-- example:retained-scaffold-apply -->
```javascript
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const { validateProjectScaffoldPlan, applyProjectScaffold } =
  await import('<engine-root>/scripts/project-scaffold.mjs');
const { validateGovernanceInput, validateGovernanceReceipt } =
  await import('<engine-root>/scripts/inception-governance.mjs');
const repoRoot = '<repo-root>';
const inputPath = '<governance-input-json>';
const planPath = '<scaffold-plan-json>';
const read = path => JSON.parse(readFileSync(join(repoRoot, path), 'utf8'));
const sha = content => createHash('sha256').update(content).digest('hex');
const input = validateGovernanceInput(read(inputPath));
const pending = validateGovernanceReceipt(read('.apex/init-provenance.pending.json'));
const plan = validateProjectScaffoldPlan(read(planPath));
assert.equal(pending.status, 'prepared');
assert.equal(pending.runId, input.runId);
assert.deepEqual(pending.completion, input.completion);
assert.deepEqual(pending.producer.projectModel, input.projectModel);
assert.deepEqual(pending.producer.documents,
  input.documents.map(({ path, content }) => ({ path, sha256: sha(content) })));
assert.equal(plan.conflicts.length, 0);
const documentPaths = new Set(input.documents.map(doc => doc.path));
const certified = pending.operations.filter(op => !documentPaths.has(op.path));
const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
assert.deepEqual(plan.operations.map(op => ({ path: op.path, kind: op.kind,
  before: op.priorDigest, bytes: Buffer.byteLength(op.content), sha256: sha(op.content) })).sort(byPath),
  certified.map(op => ({ path: op.path, kind: op.kind, before: op.before?.sha256 ?? null,
    bytes: op.after.bytes, sha256: op.after.sha256 })).sort(byPath));
console.log(JSON.stringify(applyProjectScaffold({ hubRoot: repoRoot, plan })));
```

After the retained apply succeeds, proceed directly to Step 4 with only the exact retained document
bytes from the governance input, preserving any already-complete outputs. Then run finish and both
Step 5 gates. Never revisit detection, the interview, rendering, or fresh preview while this receipt
is pending. Ordinary repair and its original preview/conflict procedure remain separate.

### Step 4 — Complete the governed hub

For a prepared governance receipt, create only its missing stable hub documents using the exact
retained document bytes from Step 3. Preserve already-applied bytes on recovery; a divergent file
stops without overwrite. For ordinary init/repair, create missing stable hub documents from the
authoritative confirmed interview record. Use the engine
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

### Step 5 — Validate and report

When Step 3 prepared a receipt, after normal planner apply and Step 4 hub creation run:

```bash
node <engine-root>/scripts/inception-governance.mjs finish --repo-root <repo-root>
```

Require exit 0 and `ok: true`; finish checks the exact prepared outputs and the whole application
difference, then publishes `.apex/init-provenance.json`. An explicit replay of an already-final certificate uses
this same idempotent command without new writes. Ordinary subsequent repair skips this certification
block; its changes do not gain the old receipt's exemption.
Never edit the completed descriptor or any inception evidence. Run the full `inception-state.mjs
verify-complete --repo-root <repo-root>` command from Step 3 again after finish; require
exit 0 and `ok: true` before the hub gate. A failed prepare/finish/gate is not completion, and never
authorizes broad exclusions or an overwrite. Only exact certified operations are projected out;
new app files, lockfiles, configs and unrelated provider files remain observable.

Run:

```bash
node <engine-root>/scripts/validate-hub.mjs <repo-root>
```

Do not report completion until it prints `steepy validate-hub: OK`. For repair, label every artifact
`created`, `appended`, or `preserved`. Report the canonical bootstrap and every surface standard plus
specialist adapter triad. Recommend the `discovery` skill by its semantic name to populate empty standards and
glossary entries. Remind the user to review the generated files before committing.

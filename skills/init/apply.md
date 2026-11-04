# init — Step 3: preview, resolve exact conflicts, then apply

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
(unsupported run format, tamper, application-drift, or any other refusal) stops certification and
writes; do not silently turn a failed certified init into ordinary init. Ordinary init/repair
without this first-post-complete case keeps the existing interview, preview and conflict procedure.

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

After the retained apply succeeds, proceed directly to Step 4 and run its `documents` command with
the same retained governance input; it writes only missing certified documents and preserves complete
ones. Then run finish and both Step 5 gates. Never revisit detection, the interview, rendering, or fresh preview while this receipt
is pending. Ordinary repair and its original preview/conflict procedure remain separate.

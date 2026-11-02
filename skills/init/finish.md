# init — Steps 4–5: complete the hub, validate and report

### Step 4 — Complete the governed hub

For a prepared governance receipt, never write certified document bytes yourself. Run:

```bash
node <engine-root>/scripts/inception-governance.mjs documents --repo-root <repo-root> --input <governance-input-json>
```

Require exit 0 and `ok: true`. The command writes each missing stable hub document from the exact
retained bytes with mode 0644 and preserves an already-exact document without rewriting it. It
refuses before any write on a divergent document, a mode mismatch, drift outside the certified
operations, or an unsafe target; it never changes a mode.

For ordinary init/repair, create missing stable hub documents from the
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

When Step 3 prepared a receipt, after the retained planner apply and the Step 4 `documents` command, run:

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

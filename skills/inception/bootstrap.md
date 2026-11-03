# inception — Steps 7–9: bootstrap, effects and checkpoints, pause

### Step 7 — Bootstrap

Build one representative path in dependency order: a contract's producer before consumers. Each
part owns exact application paths and one `.apex/inception/bootstrap/<unit-id>.md` report. Begin a
bootstrap unit before dispatch or application writes, bind approved inputs, and supply unit ID,
exact inputs/output, allowed paths and correlation in `bootstrap-part-prompt.md`. One child at a
time; inline uses the same contract and records degradation. Child never mutates descriptor,
effect records, checkpoints, approval, or commits. It requests needed effects; the coordinator
runs them inside an appropriate unit under Step 8. Check the full report and observed diff before
finish; changed-paths in a response is telemetry, not authority.

Deliver manifests and lockfiles from official approved tools/versions; clean-checkout install,
build, test and start commands; example configuration without secrets; necessary integrations,
data and migrations; chosen reused materials and preserved behaviors; the integrated representative
path; CI/deploy instructions if approved. Include/exclude deploy explicitly with a reason. Included
deploy needs real evidence: local green tests do not prove remote deploy or CI. Never build every
prototype screen. Ordinary fixes remain autonomous; substantial changes use Step 5. An approved
generator may change the root `.gitignore` only as a recorded application effect, never for the
run's own area.

### Step 8 — Effects and checkpoints

Install/generator/migration/external-resource/deploy/commit/remote operations belong to the
coordinator, never a child. Before an effect, begin its bounded work unit and write the exact intent
input with keys `id` (matching the CLI ID), `kind`, `summary`, `command` or null, `procedure` or null, `scope`, `authorization`
or null, `correlation` (name/value pairs), and `observation` (procedure/expected/evidencePaths).
At least a command or procedure must describe the operation. Use exact non-secret resource
identities and evidence paths, not a similar resource name or an invented receipt. Each evidence
file must be strict JSON with exactly id/procedure/result/correlation/observed matching the intent's
observation procedure and outcome; plain stdout or a generic report is not that structured evidence.
The coordinator must observe the real result before writing this evidence.

This local generator illustration belongs inside an approved bootstrap unit allowing generated.txt.
Write the intent input at `bootstrap/generate-intent.json` before execution:

<!-- example:effect-intent-input -->
```json
{"id":"generate","kind":"generator","summary":"Generate the assigned fixture file","command":{"executable":"node","args":["-e","require('node:fs').writeFileSync('generated.txt','generated\\n')"],"cwd":".","successExitCodes":[0]},"procedure":null,"scope":["generated.txt"],"authorization":null,"correlation":[{"name":"operation","value":"generate-1"}],"observation":{"procedure":"Read the generated file","expected":"Exact generated newline bytes","evidencePaths":[".apex/inception/bootstrap/generate-observation.json"]}}
```

<!-- example:effect-intent -->
```bash
node <engine-root>/scripts/inception-state.mjs effect intent --repo-root . --id generate --input .apex/inception/bootstrap/generate-intent.json
```

Execute the exact intent command once, then observe the file bytes before writing
`bootstrap/generate-observation.json`. This sample succeeded outcome applies only if observed:

<!-- example:effect-observation -->
```json
{"id":"generate","procedure":"Read the generated file","result":"succeeded","correlation":[{"name":"operation","value":"generate-1"}],"observed":"The file contains exact generated newline bytes"}
```

Write `bootstrap/generate-outcome.json` with the same observed result/correlation:

<!-- example:effect-outcome-input -->
```json
{"result":"succeeded","observed":"The file contains exact generated newline bytes","correlation":[{"name":"operation","value":"generate-1"}],"evidence":[".apex/inception/bootstrap/generate-observation.json"]}
```

<!-- example:effect-outcome -->
```bash
node <engine-root>/scripts/inception-state.mjs effect outcome --repo-root . --id generate --input .apex/inception/bootstrap/generate-outcome.json
```

The general sequence is:

1. `effect intent --id <id> --input <exact-intent-json>` binds the active unit and before snapshot.
2. Run only that authorized command/procedure. A remote creation/push/deploy requires explicit
   authorization for that operation; retain existing still-valid authorization in the input.
   Commit policy never authorizes remote operations. Local commits require allowed; none/forbidden
   means no commit. Stage exact paths with literal pathspecs, `git add -- ':(literal)<path>'` or
   `GIT_LITERAL_PATHSPECS=1`: a plain Git pathspec is a pattern, so `app/[id]/page.tsx` would also
   stage `app/i/page.tsx`. A dirty tree or absent Git is supported when recorded faithfully.
3. `effect outcome --id <id> --input <exact-outcome-json>` supplies exactly result, observed,
   correlation and evidence (exact path list). Results: succeeded/failed/not-started/partial.
   Helper derives intent/before/after and fixes method. Partial remains uncertain, not replayable.
   Changes outside the intent scope never prevent recording the observed result: the outcome
   names them in `outsideScope`. Then `unit finish` refuses, and only the human accepts those
   paths, through `unit reconcile` with their explicit statement.
4. Check the unit report, effects and observed diff, finish the unit, then
   `checkpoint create --label=<text>`. This snapshots the entire approved inventory and Git after
   authorized commits/checks. No file list or new baseline can hide unexplained changes.

On interruption observe the same intent through `effect reconcile --id <id> --input <json>`;
this is observation, never a new remote operation. Automatic reconciliation requires exact matching
correlation plus sufficient real evidence. Not-started needs proof and closes only that intention;
it does not authorize replay. Without proof preserve uncertainty, block and request a human
decision. Reconciliation is not a replacement for required manual acceptance. Resolve independent
blocks separately. Git provenance drift needs its own authorized/evidenced explanation even if
contents match. A write under an approved exclusion is neither inventory nor Git status drift; a
branch or HEAD change still needs a correlated commit effect. Application inventory rejects symlinks/special files and never silently normalizes
unrepresentable names.

### Step 9 — Pause after bootstrap

Recommend a new session for verification. Finish all children and units, check effects/blocks, take
the bootstrap checkpoint, and publish `transition --to verification --reason=<text>`. Then write
`resume-note --next=<text> --need <exact-ref>`, including approved contract, part reports and needed
bound evidence; add concrete child models/degradation in `--note=<text>`. The run remains active.
Continue if requested. This pause is context management, never a new approval or authority.

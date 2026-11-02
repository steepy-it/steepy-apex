# inception — Step 10: final verification and conclusion

### Step 10 — Final verification and conclusion

Use resume-check first on every resumed entry, and verification resume once for a new session with
an existing cycle. After bootstrap enter verification and establish observed non-secret environment
identities using the contract's tool/resource list; never copy credentials or environment variables.
For the illustration only, write `project/environment.json` as follows:

<!-- example:environment -->
```json
{"tools":[],"resources":[]}
```

<!-- example:verification-begin -->
```bash
node <engine-root>/scripts/inception-state.mjs verification begin --repo-root . --environment .apex/inception/project/environment.json --reason=Bootstrap-ready
```

Read the returned `cycle.path`; never construct a record number. It binds approval, contract,
application snapshot and environment. Identical identities reuse the current cycle; changes create
a new cycle. Verify approved install/build/test/start, representative path, preserved behaviors and
resolved versions from a clean state as the contract requires. Preparation with effects follows
Step 8 before beginning the stable cycle; do not allow a verification command to change the
application and still count as a successful old-cycle check.

Begin a check unit before each automatic/manual check with exact report under `bootstrap/`,
allowedPaths empty and declared inputs. The helper also binds current cycle/session. The collector
runs one approved command at a time, streams complete stdout/stderr separately and binds a receipt:

<!-- example:capture -->
```bash
node <engine-root>/scripts/capture-inception-evidence.mjs --repo-root . --cycle <cycle> --check representative --unit <unit-id> --purpose check
```

No alternative command, imported receipt or passed/success boolean is accepted. Read compact outcome
without loading all streams. Capture exit 0 may describe a failed command. For interrupted capture,
never rerun the application command: retain its registered attempt. Reinvoke the same collector
CLI with the exact cycle/check/unit/purpose; its registered-attempt path performs recovery only,
requires a dead/verifiable collector before recovery/binding, and never launches the command again; if no complete reserved proof exists, close incomplete with evidence and preserve
uncertainty. A new execution needs a new unit ID, explicit previous-unit and settled effects.

For manual checks obtain explicit human observation of the exact check IDs, procedures and outcomes.
One confirmation may cover multiple IDs only if the question and answer identify them. After the
answer, write the verbatim statement and observations to the exact attestation input. This sample
is fixture data, never a human statement the agent may invent:

<!-- example:manual-attestation -->
```json
{"checks":[{"id":"representative","procedure":"Open the representative path","result":"succeeded","observed":"Path is readable"}],"statement":"I opened the representative path and confirm it is readable.","environment":{"tools":[],"resources":[]},"purpose":"check"}
```

<!-- example:attest -->
```bash
node <engine-root>/scripts/inception-state.mjs verification attest --repo-root . --cycle <cycle> --input <attestation-input>
```

The helper observes before/after and rejects drift; it verifies shape/identity, not human truth.
For both, collect automatic and manual evidence; neither alone passes. Write the complete check
report, review its observed diff and `unit finish` before reading applicable status:

<!-- example:verification-status -->
```bash
node <engine-root>/scripts/inception-state.mjs verification status --repo-root . --cycle <cycle>
```

At each new verification session, after resume-check and recovery:

<!-- example:verification-resume -->
```bash
node <engine-root>/scripts/inception-state.mjs verification resume --repo-root . --cycle <cycle>
```

Unchanged snapshot evidence stays applicable. For reuse reobserve, collect fresh approved procedures
in the new session with `--purpose revalidate` for the collector and `purpose: "revalidate"` for
attest. Manual revalidation uses reuse.manual.procedure, never the primary manual procedure. If
unavailable, the old outcome remains historical and the check is still missing. Do not rerun other
valid checks indiscriminately.

After any application correction, finish/reconcile the fixing unit, call verification begin for a
new cycle, and repeat **all required automatic and manual checks**. No selective impact-based
reuse. A new approval likewise invalidates all old results. An unchanged retry in the same cycle
uses a new unit/proof and preserves failed attempts. Never make failures optional to permit closure.

Result distinctions remain configured/executed/succeeded/not-executed/failed; only succeeded with
all required types satisfies a required check. Optional missing checks are not-executed with explicit
limits. Coverage is derived: verified/unverified/future; future never becomes delivered implicitly.
Write a JSON array of descriptive limits at `project/limits.json` (for example `[]`), then:

<!-- example:summarize -->
```bash
node <engine-root>/scripts/inception-state.mjs verification summarize --repo-root . --cycle <cycle> --limits .apex/inception/project/limits.json
```

The helper derives immutable summary/report from accepted evidence. Do not hand-edit outcomes,
approved project documents or final `verification/results.md`. After final authorized commits are
observed/reconciled and every unit is finished:

<!-- example:checkpoint -->
```bash
node <engine-root>/scripts/inception-state.mjs checkpoint create --repo-root . --label=Final-verification
```

Use returned `checkpoint.path`, then:

<!-- example:complete -->
```bash
node <engine-root>/scripts/inception-state.mjs transition --repo-root . --to complete --cycle <cycle> --checkpoint <checkpoint> --reason=All-required-checks-verified
```

Complete checks approval, cycle/inventory/environment/reuse, final checkpoint, all required types,
transitive digests, zero uncertain/partial effects, active units, residual blocks and foreign pending
writes. It publishes immutable report/completion plus `verification/results.md`, then complete state.
It compares the live application and Git once, before it reserves the completion. An interrupted
complete is finished with `publish resume`, which rechecks only recorded evidence; if the
application changed after the reservation, the run still completes and `verify-complete` names the
drifted paths. Restore their bytes before `init` and `discovery`. Git provenance after the
reservation is historical, as after any completion.

<!-- example:verify-complete -->
```bash
node <engine-root>/scripts/inception-state.mjs verify-complete --repo-root .
```

After successful verification, read the returned completion ref for the closing presentation only:

<!-- example:closing-note -->
```bash
node <engine-root>/scripts/inception-state.mjs resume-note --repo-root . --next=init-then-discovery --need <completion>
```

A complete run with a missing closing note permits presentation only referencing the existing
completion; never restart verification or bootstrap. Give verified/unverified/future results and
limits, then recommend the `init` skill followed by the `discovery` skill with inception source.
The run does not invoke init. A rejected verify-complete source remains intact; do not silently
import historical choices as current truth. Ordinary discovery of current code stays available.

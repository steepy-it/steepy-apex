# inception — helper commands and persisted work units

## Helper commands

Resolve `node <engine-root>/scripts/inception-state.mjs` relative to this skill, and pass
`--repo-root .` from the application repository. Node >= 24 is the engine runtime, not an application
stack choice. The helper records and verifies; the coordinator conducts the dialogue, establishes
human provenance and runs authorized effects. The separate collector executes approved checks.

| Command | Use |
|---|---|
| `node <engine-root>/scripts/inception-state.mjs classify --repo-root . [--maturity suitable\|mature]` | Read fixed entry paths. |
| `node <engine-root>/scripts/inception-state.mjs inspect --repo-root .` | Read schema, phase, actions and exact refs. |
| `node <engine-root>/scripts/inception-state.mjs start --repo-root . --harness <slug> --capabilities <csv> --git-commits allowed\|forbidden [--exclusions-stdin]` | Create one v2 run with its pre-approval exclusions, read from standard input; never replace an existing run. |
| `node <engine-root>/scripts/inception-state.mjs resume-check --repo-root .` | Read-only verification of approval, refs, baseline, effects and pending work. |
| `node <engine-root>/scripts/inception-state.mjs unit begin --repo-root . --id <id> --input <json> [--previous-unit <id>]` | Persist the sole writer, before snapshot, exact inputs/outputs and allowed paths. |
| `node <engine-root>/scripts/inception-state.mjs unit finish --repo-root . --id <id> [--evidence <path>]...` | Validate complete reports, freeze immutable outputs and observe the diff. No success boolean. |
| `node <engine-root>/scripts/inception-state.mjs unit reconcile --repo-root . --id <id> --input <json>` | Observe and bind evidence for the interrupted unit; never invent before/after hashes. |
| `node <engine-root>/scripts/inception-state.mjs unit close-incomplete --repo-root . --id <id> --reason=<text> --evidence <path>...` | Require stopped-writer evidence; preserve uncertain effects and independent blocks. |
| `node <engine-root>/scripts/inception-state.mjs publish resume --repo-root . --reservation <id>` | Finish only the exact reserved publication; never rerun application work. |
| `node <engine-root>/scripts/inception-state.mjs approve --repo-root . --statement=<text> --document <path>... --contract <path>` | Freeze the human-approved complete project and verification contract. |
| `node <engine-root>/scripts/inception-state.mjs verify-approval --repo-root . [--approval <path>]` | Read-only comparison with frozen approval. |
| `node <engine-root>/scripts/inception-state.mjs transition --repo-root . --to <phase\|blocked\|active> --reason=<text> [--git-commits allowed\|forbidden] [--cycle <path> --checkpoint <path>]` | Phase/status transition; complete requires current cycle and final checkpoint. |
| `node <engine-root>/scripts/inception-state.mjs block resolve --repo-root . --id <id> --statement=<text> --evidence <path>...` | Resolve only the named block after the recorded human decision. |
| `node <engine-root>/scripts/inception-state.mjs effect intent --repo-root . --id <id> --input <json>` | Bind intent to the active unit before the operation. |
| `node <engine-root>/scripts/inception-state.mjs effect outcome --repo-root . --id <id> --input <json>` | Record the observed outcome and exact correlation/evidence. |
| `node <engine-root>/scripts/inception-state.mjs effect reconcile --repo-root . --id <id> --input <json>` | Observe the same intent without replay, including while blocked. |
| `node <engine-root>/scripts/inception-state.mjs effect status --repo-root .` | Read concluded/uncertain effects. |
| `node <engine-root>/scripts/inception-state.mjs checkpoint create --repo-root . --label=<text>` | Capture the complete approved inventory and Git provenance, without a handpicked file list. |
| `node <engine-root>/scripts/inception-state.mjs checkpoint verify --repo-root . [--checkpoint <path>]` | Verify an exact bound checkpoint. |
| `node <engine-root>/scripts/inception-state.mjs verification begin --repo-root . --environment <json> --reason=<text>` | Derive approval, snapshot, cycle and first verification session. |
| `node <engine-root>/scripts/inception-state.mjs verification resume --repo-root . --cycle <path>` | Record a new session, without rerunning checks or creating a cycle. |
| `node <engine-root>/scripts/inception-state.mjs verification attest --repo-root . --cycle <path> --input <json>` | Bind explicit human observation within an active check unit. |
| `node <engine-root>/scripts/inception-state.mjs verification status --repo-root . --cycle <path>` | Read applicable results and missing required checks. |
| `node <engine-root>/scripts/inception-state.mjs verification summarize --repo-root . --cycle <path> --limits <json>` | Derive immutable summary/report; limits are descriptive strings, never editable outcomes. |
| `node <engine-root>/scripts/inception-state.mjs resume-note --repo-root . --next=<text> [--need <path>]... [--note=<text>]` | Presentation of the next action and exact refs; never recovery authority. |
| `node <engine-root>/scripts/inception-state.mjs verify-complete --repo-root .` | Read-only verification of completion, evidence and current application. |
| `node <engine-root>/scripts/inception-state.mjs abandon --repo-root . --reason=<text>` | Explicitly archive the intact run. |
| `node <engine-root>/scripts/inception-state.mjs abandon --repo-root . --resume` | Resume only the canonical archive intention, even after descriptor move. |

Every JSON input is an exact coordinator-declared file under the run, strict UTF-8 with all required
keys (including nulls), no duplicate/unknown keys or aliases. The one exception is `start
--exclusions-stdin`: the run does not exist yet, so the array arrives on standard input through a
quoted heredoc (`<<'JSON'`), which the shell passes byte-exact. Use shell-quoted `--text=value` for free text, particularly text
beginning with `-`. Never interpolate human text as shell code. Single-quote every path argument,
such as `--evidence 'app/[id]/page.tsx'`: brackets, braces, `*` and `?` are literal to the helper,
but an unquoted shell expands them, and zsh refuses a pattern that matches nothing.
Capabilities are a comma-separated subset of `shell,network,browser,subagents,question-tool,headless`;
IDs are lowercase letters/digits/dashes and never reused. Read each one-line JSON response before
continuing: `ok`, result refs, or `error` (`verify-complete` also gives `reason`).

- Exit `0`: operation succeeded. Collector exit 0 means complete capture, even for a failed check;
  inspect its `outcome`, `exitCode` and `signal`.
- Exit `1`: failed precondition/verification, or incomplete capture. Preserve state and resolve the
  reported cause; do not assume no publication or evidence exists after an interrupted write.
- Exit `2`: usage error. Correct argv; never reinterpret a command display string as a shell.

### Persisted work units and recovery

Once a v2 run exists: Before any decision, research, child dispatch, application write, or effect, run `resume-check`
when resuming, then `unit begin` with a new ID. Prepare the bounded registration JSON first; this
control input preparation is not application work. Its exact keys are `kind`, `inputs` (Ref objects
with path/bytes/sha256), `outputs` (path/role), and `allowedPaths` (exact application files or assigned
subtrees). Kinds are decision/research/bootstrap/check/publication/transition; roles are
decision/report/evidence. Every unit declares a report. Bind the existing input bytes, never
fabricate a digest. Use a new report path per unit. Before a later decision changes a working
project document, declare that path as an output as well as an input; finish retains immutable
opening inputs and output copies.

The coordinator checks the complete report, unit identity, required content, every observed diff
and its correlation to the assigned work/effects before `unit finish`. A short child answer, a file
existing, or a report delimiter alone is insufficient. The helper independently observes the whole
inventory and Git provenance and freezes outputs under `units/<id>/outputs/`. A directory scope
only grants that assigned subtree. Never hide divergence with a new checkpoint/baseline. The
helper's short internal registrations/transitions use its own publication protocol; do not open a
second unit around them while another unit is active. Finish the decision/work unit before a
phase transition, approval, checkpoint, or cycle registration.

Every report, including coordinator/inline work, starts and ends exactly as follows, with a full
body between the delimiters. Failure statuses are BLOCKED/NEEDS_CONTEXT and cannot finish a unit. A check report may be DONE
when collection is complete even if the check failed; only helper-derived results establish green.

<!-- example:unit-report -->
```text
<!-- steepy-inception-unit: v2; id: <unit-id>; status: <status> -->
Unit: <unit-id>. Inputs and ownership: list exact paths and opening identities.
Work and observed diff: list every changed application path, reason, checks and evidence.
Correlation: identify assigned work and any exact effect IDs; state blockers and degradation.
<!-- steepy-inception-unit-end: <unit-id> -->
```

For interrupted work, inspect the active unit's bound outputs and evidence; never rerun blindly.
Complete an already demonstrably complete report/diff through finish, or use `unit reconcile` with
`{"evidence":["<exact-path>"],"reason":"<observation>","statement":null}` for evidence-backed
reconciliation. A non-null statement records an explicit human acceptance of observed differences;
it never creates check success or substitutes for a manual acceptance check. If the writer has
stopped but work is incomplete, non-capture closure requires this first exact evidence artifact:

<!-- example:stopped-writer -->
```json
{"unitId":"interrupted","writerStopped":true,"statement":"The coordinator observed that the interrupted writer has stopped."}
```

<!-- example:close-incomplete -->
```bash
node <engine-root>/scripts/inception-state.mjs unit close-incomplete --repo-root . --id interrupted --reason=Writer-stopped --evidence .apex/inception/bootstrap/stopped.json
```

This is an explicit observation trust boundary: the helper validates identity/shape and freezes the
verbatim coordinator/human statement, not its truthfulness. Never infer stop from an absent PID or
a report alone. Registered captures require a proven-dead persisted collector PID; a live or
unverifiable process refuses takeover, even with human input. Closure preserves incomplete history,
uncertain effects and independent blocks; it grants neither success nor permission to repeat.
Resolve outstanding observations/blocks before a retry. A new execution has a new ID and exact
lineage; write the new registration at the declared retry input path, then:

<!-- example:retry-begin -->
```bash
node <engine-root>/scripts/inception-state.mjs unit begin --repo-root . --id retry --input .apex/inception/bootstrap/retry-input.json --previous-unit interrupted
```

Never infer previous-unit from recency or kind. `publish resume --reservation <id>` settles only
that pending publication. It is not an execution retry.

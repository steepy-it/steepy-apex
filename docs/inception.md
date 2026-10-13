# Inception

`/steepy-apex:inception` turns an idea and its starting materials into a minimal, verified, runnable first version. It runs before the hub exists and ends by pointing you to `init`, then `discovery`. Claude Code syntax is shown; see the [installation guide](installation.md#first-run-and-troubleshooting) for other harnesses.

## When to use it

The skill first classifies the starting state. It reads fixed paths only and never picks a run by recency.

| Starting state | What happens |
|---|---|
| No hub, no run, and you have an idea, materials, or a prototype that is not yet a working application | A new run starts. |
| No hub, no run, and a working application already exists | The skill proposes `init`, then `discovery`, and starts nothing. |
| No hub, and the maturity is unclear | The skill proposes a reading from the stack signals; you decide. A nearly complete prototype is always your choice. |
| No hub, and an active or blocked run | The run resumes. |
| No hub, and a complete run | The skill reports the next steps: `init`, then `discovery`. |
| A hub and no run | Use the ordinary workflow, for example `brainstorm`. |
| A hub and a complete run | Use the ordinary workflow. |
| A hub beside an unfinished run (for example `init` ran too early) | The skill reports the conflict. Nothing resumes by itself; you decide. |
| A run state that cannot be read | Every file stays as it is; the skill explains the problem and stops. |

Inception is not a gear and is not part of the brainstorm → plan → implement → review chain. It has no headless or autopilot mode: a human answers its questions and approves the project.

## The flow

A run moves through seven phases, in order: reconnaissance → architecture → research → approval → bootstrap → verification → complete.

1. **Reconnaissance.** The skill reads every determining material, records each element as real or simulated, and asks what the materials do not answer. One question at a time, with options, trade-offs, and a recommendation. It writes `.apex/inception/project/reconnaissance.md`.
2. **Architecture decisions.** You decide the shape of the system with the skill: system shape, contracts between parts, data, identity and access, internal architecture, repository and tooling, testing, hosting and deploy, observability and errors. Every significant decision enters the decision register, `.apex/inception/project/decision-register.md`, with a stable `DR-n` ID, its reason, its alternatives, and how you confirmed it. There is no preset stack: every layer is decided here.
3. **Research and versions.** Each foundational choice gets an official source, an explicit version, a verification date, its support status, and a compatibility check. You confirm the version table. Versions the model remembers are not verified versions; without network access the skill asks you for official sources or blocks.
4. **Project and approval.** The skill writes the project documents under `.apex/inception/project/`: constraints, the decision register, components and contracts, the verification plan, deploy, limits, and the representative path (one complete flow across the agreed boundaries). It also writes the machine-readable verification contract before approval. Other flows stay future context and never become a started backlog.
5. **Bootstrap.** The skill builds the representative path: manifests and lockfiles from the official tools at the approved versions, install, build, test, and start commands, an example configuration without secrets, and the data and integrations the path needs.
6. **Verification.** From a clean state, the skill checks install, build, test, start, the representative path, and the behaviors to preserve.
7. **Complete.** The helper verifies every required check against the approved contract and current application, then publishes a bound completion and closing report. A missing closing note permits presentation repair only.

### Three sessions, two pauses

| Session | Phases | Ends at |
|---|---|---|
| 1 | reconnaissance, architecture, research, approval | the pause after approval |
| 2 | bootstrap | the pause after bootstrap |
| 3 | verification and conclusion | `complete` |

At each pause the skill writes a resume note: the next action and the exact paths the next session must read. A new session starts from the run descriptor and its exact bound refs. Resume notes are presentation only; recovery never depends on the earlier conversation or a note being present. Starting fresh is recommended because earlier context is paid again on every turn. If you ask to continue in the same session, the skill continues and states the cost. A pause is not a block: the run stays active.

## The local area

Everything a run writes about itself lives under `.apex/inception/`. The area has its own `.gitignore` containing `*`, so the root `.gitignore` is never edited for it. It is local, like `.apex/work/`.

| Path | Holds |
|---|---|
| `.apex/inception/run.json` | `steepy-inception-run/v2`: revision, phase/status, harness/Git, ordered refs, units/activeUnit, effects, cycles/currentCycle, verificationSession, baseline, blocks, pending/publications, completion, history. |
| `.apex/inception/project/` | Project documents, decision register, and `verification-contract.json` (`steepy-inception-checks/v2`). |
| `.apex/inception/research/`, `.apex/inception/bootstrap/` | One complete report per persisted research/bootstrap unit. |
| `.apex/inception/units/<id>/outputs/` | Immutable copies of unit outputs, including cumulative project documents. |
| `.apex/inception/approvals/` | Approval records and frozen byte-exact project documents. |
| `.apex/inception/snapshots/`, `.apex/inception/checkpoints/` | Complete application inventories and immutable checkpoints. |
| `.apex/inception/effects/`, `.apex/inception/reconciliations/` | Immutable intent/outcome and observed reconciliation records. |
| `.apex/inception/verification/` | `cycles/`, `sessions/`, `manual/`, `results/`, `summaries/`, `reports/`, `completions/`, and `captures/`. |
| `.apex/inception/resume-notes/` | Bound notes for pauses, blocks, and final presentation. |
| `.apex/inception/abandon-intent.json` | Canonical archive intention, recoverable independently of the active descriptor. |
| `.apex/inception/abandoned/<run-id>/` | Intact abandoned run, archive intent, `abandon.json`, and `receipt.json`. |

Numbered records use a global counter padded to at least four digits, never filesystem recency. Refs bind exact path, byte count, and SHA-256. The descriptor changes only through `inception-state.mjs`. Records are immutable; unit state changes are helper-owned. JSON uses canonical key order and a final newline, strict UTF-8, closed fields/enums, and no duplicate keys. Paths are confined ordinary single-link files: no symlink or symlinked ancestor directory, alias, or path named twice. Unsupported names fail rather than being normalized.

New runs are v2. Legacy v1 remains read-only for classification, inspection, approval/checkpoint verification and effect status, and archivable by abandon; no migration, mutation, source import, deletion or automatic restart makes a v1 run v2. A legacy `effects.jsonl` still requires compact JSON with no spaces, canonical key order and newline endings; corruption reports `effect log is malformed at line <n>` and refuses append.

## The helper commands

The skill drives `node <engine-root>/scripts/inception-state.mjs`, resolved relative to its own directory. Every command takes `--repo-root .`. The helper validates structured requirements and evidence; the skill conducts dialogue, decisions, delegation and human approval. The state helper alone mutates the descriptor; the collector runs only an approved command.

| Command (all include `--repo-root .`) | Use |
|---|---|
| `inception-state.mjs classify [--maturity suitable\|mature]` | Read fixed entry paths. |
| `inception-state.mjs inspect` | Read schema, actions, state and exact refs. |
| `inception-state.mjs start --harness <slug> --capabilities <csv> --git-commits allowed\|forbidden` | Create one v2 run; never replace one. |
| `inception-state.mjs resume-check` | Read-only validation of current refs, approval, baseline, effects and pending work. |
| `inception-state.mjs unit begin --id <id> --input <json> [--previous-unit <id>]` | Persist the sole writer, before snapshot, inputs, outputs and allowed paths. |
| `inception-state.mjs unit finish --id <id> [--evidence <path>]...` | Validate complete outputs, freeze copies, observe the whole diff. |
| `inception-state.mjs unit reconcile --id <id> --input <json>` | Derive before/after changes from observations and bind evidence. |
| `inception-state.mjs unit close-incomplete --id <id> --reason=<text> --evidence <path>...` | Require stopped-writer observation; preserve uncertainty and independent blocks. |
| `inception-state.mjs publish resume --reservation <id>` | Finish the exact publication only. |
| `inception-state.mjs approve --statement=<text> --document <path>... --contract <path>` | Freeze human-approved documents and contract. |
| `inception-state.mjs verify-approval [--approval <path>]` | Read-only approval verification. |
| `inception-state.mjs transition --to <phase\|blocked\|active> --reason=<text> [--git-commits allowed\|forbidden] [--cycle <path> --checkpoint <path>]` | Complete requires current cycle and final checkpoint. |
| `inception-state.mjs block resolve --id <id> --statement=<text> --evidence <path>...` | Resolve only the named block after a human decision. |
| `inception-state.mjs effect intent --id <id> --input <json>` | Record intent before effects, bound to the active unit. |
| `inception-state.mjs effect outcome --id <id> --input <json>` | Record observed result, correlation and evidence. |
| `inception-state.mjs effect reconcile --id <id> --input <json>` | Observe the same intent while blocked; never replay it. |
| `inception-state.mjs effect status` | Read concluded and uncertain effects. |
| `inception-state.mjs checkpoint create --label=<text>` | Inventory all approved roots, not a selected file list. |
| `inception-state.mjs checkpoint verify [--checkpoint <path>]` | Read-only checkpoint verification. |
| `inception-state.mjs verification begin --environment <json> --reason=<text>` | Derive cycle and first verification session. |
| `inception-state.mjs verification resume --cycle <path>` | Persist new session; no new cycle or check execution. |
| `inception-state.mjs verification attest --cycle <path> --input <json>` | Bind verbatim human observation for exact check IDs and procedures. |
| `inception-state.mjs verification status --cycle <path>` | Read applicable results and missing checks. |
| `inception-state.mjs verification summarize --cycle <path> --limits <json>` | Derive immutable summary/report; descriptive limits cannot rewrite outcomes. |
| `inception-state.mjs resume-note --next=<text> [--need <path>]... [--note=<text>]` | Record presentation, not recovery authority. |
| `inception-state.mjs verify-complete` | Read-only completion, transitive evidence and current application verification. |
| `inception-state.mjs abandon --reason=<text>` | Archive intact; deletes nothing. |
| `inception-state.mjs abandon --resume` | Resume canonical archive intention even without active descriptor. |

Inputs are exact coordinator-declared JSON paths. Unit input contains `kind`, `inputs`, `outputs`, `allowedPaths`; phase/before are derived. Effect intent contains the approved command or procedure, scope, authorization, correlation and observation procedure; outcomes contain result, observed facts, correlation and evidence paths, not caller-supplied snapshots. Attestation contains check IDs/procedures/results, statement, environment and `purpose: check|revalidate`. Revalidation uses the contract's reuse procedure. No receipt-import or editable-result command exists.

Helper exits: `0` success, `1` failed precondition/verification, `2` usage error. Successful calls emit one JSON line; rejected source verification returns `ok: false` with a reason without exposing source bodies. Free text uses `--option=<value>` (for example `--statement=<value>`), since a separate value beginning with `-` is rejected. A pending reservation or blocked unit is durable recovery state; do not assume every failed operation left no state.

## Approval and re-approval

You approve the complete project once, before bootstrap. The skill shows every project document path and asks for your explicit approval. It never approves for you; if no human is available it blocks. Your statement is stored verbatim with the verification contract and frozen byte-exact copies of every project document, including the decision register. Live-document changes invalidate the approval for continuing; historical approvals verify their immutable copies. A digest proves bytes, not a human: the record holds only the statement it was given.

After approval, installation, generation, implementation, and ordinary fixes proceed on their own inside the agreed scope. A substantial change (the database, boundaries, flows, design, deploy, a foundational technology, or the commit policy) needs a targeted decision and a new approval of the changed parts. The run returns to approval, the affected documents and the decision register are updated, and `approve` is recorded again over the complete current set.

## Units, effects and checkpoints

Before any decision, research, bootstrap, check, publication or transition work, persist an exact unit. Only one active unit may write. Research and bootstrap delegate when a task tool is available, one unit at a time; otherwise work inline with declared degradation. Children receive exact inputs/outputs and allowed application paths. The coordinator checks report identity, completeness and observed diff before finish. Reports have matching `steepy-inception-unit` v2 opening/end delimiters; a file existing by itself never proves completion.


An operation with effects is an installation, a generator, a migration, an external resource, a deploy, a commit, or a remote operation. Each one is recorded with its intent before and its outcome after, then checked, then captured in a checkpoint of the application files it changed.

- An uncertain effect (intent without a conclusive outcome, including `partial`) is never repeated. On resume the skill can reconcile automatically only when exact correlation and evidence prove the recorded intent's outcome. Similar resources or free text alone do not prove it. An ambiguous outcome stays uncertain and requires a human decision; reconciliation grants no new remote authorization and replaces no required manual confirmation.
- A checkpoint is immutable. A later change gets its own effect and a new checkpoint.
- Local commits follow the commit policy you chose when the run started (`allowed` or `forbidden`; `none` without Git). Remote operations (a push, a repository creation, a deploy) are never covered by that answer: each one needs your authorization for that one operation, quoted in the log.
- Subagent children never run an operation with effects. They list what they need and the coordinator runs it.

The application snapshot inventories every approved root deterministically: paths, content digests and POSIX permission modes, including additions/removals. Git provenance is separate; Git and a clean working tree are not prerequisites. Approved exclusions are exact dependency/cache/generated paths, never an excuse to hide relevant manifests, lockfiles, configuration or migrations. `.gitignore` does not define the inventory. Physically bound inception/work/Git areas and the recognized active lease are excluded before traversal. Symlinks, special files and incomplete inventories fail closed. Unit finish/reconcile accepts only observed changes within exact allowed paths and tied to the report/effects; a checkpoint cannot erase unexplained drift.

## Resume decision table

Start from `inspect` and `resume-check`, using exact descriptor refs only, without listing the run or selecting a most-recent artifact.

| Observed state | Next action |
|---|---|
| Pending publication | `publish resume` with its exact reservation. Accept only token/revision/digest-correlated staging or targets; divergent targets block without overwrite. Never rerun application work. |
| Complete bound report and explained diff | Validate the unit contract, then finish/reconcile the same unit. |
| Interrupted non-capture writer | Establish stopped-writer observation before close-incomplete; output presence alone is insufficient. |
| Registered capture with live or unverifiable PID | Refuse takeover. A human statement cannot override process liveness. |
| Dead capture with complete sealed evidence | Bind the same capture without running the command again. Incomplete capture stays incomplete. |
| Effect with sufficient exact evidence | Reconcile the original intent automatically; preserve independent blocks. |
| Ambiguous effect or unrelated application/Git drift | Preserve uncertainty, stop and request a human decision; never repeat the operation or invent success. |
| Same application/approval/environment, new verification session | `verification resume` once; retain valid snapshot-policy results and reobserve mutable resources. |
| Application fix or re-approval | Reconcile changes, then begin a new cycle; old results remain historical. |
| Complete with missing closing note | Verify completion, then repair presentation only. |

For non-capture close-incomplete, the first exact evidence artifact contains `{unitId, writerStopped: true, statement}` with a nonempty verbatim coordinator/human stopped-writer observation. The helper binds it as an explicit observation trust boundary; absence of PID or a report is not that observation. It cannot bypass a registered live or unverifiable PID. Closure preserves effects and blocks and never means success. `unit begin --previous-unit <id>` opens a retry with a new ID linked to the exact closed predecessor; never infer lineage from recency or kind.

The scaffold lease serializes short cooperating-writer publications. `activeUnit` persists exclusion across commands/sessions; `pending` reserves exact rendered bytes before publication. Recovery admits only owned staging generations, complete reserved targets or the correlated final descriptor; partial staging is retained, not adopted as success. This is cooperative protocol provenance, not protection against arbitrary local rewrites.

## Final verification

The approved `steepy-inception-checks/v2` contract declares roots/exclusions, nonsecret environment tool versions/resource identities, checks and current/future coverage. Each check has `required`, type `automatic|manual|both`, subject/procedure/expected/evidence, exact executable/argv/cwd/success exit codes and/or a manual procedure/acceptance criterion, plus `reuse: snapshot|reobserve`. At least one check is required. A visual judgment cannot be disguised as an automatic exit code. A failed required check cannot be made optional to close; scope reduction requires a human decision and re-approval.

After an application fix, rerun all required automatic and manual checks in a new cycle. A cycle binds approval, contract, application identity and environment; changing any makes previous evidence historical. Content/mode identity excludes timestamp and Git metadata. An unchanged resume preserves applicable results; a new verification session requires fresh approved reobservation for mutable resources only. Snapshot-policy results do not rerun indiscriminately. The skill calls `verification resume` explicitly once per new session; repeated read-only resume-check does not invalidate results.

`capture-inception-evidence.mjs --repo-root . --cycle <path> --check <id> --unit <id> [--purpose check|revalidate]` resolves the exact approved command. It reserves token/PID before execution and captures full `stdout.bin` and `stderr.bin` separately under `verification/captures/<N>/`, sealed by a `steepy-inception-capture/v2` receipt with command, timing, exit/signal, cycle/session/unit, environment and before/after refs. Collector exit 0 means capture completed, even for a red command; 1 means incomplete capture/error, 2 usage error. Linux/darwin process groups own TERM/KILL and stream settlement; unsupported platforms refuse before writes/execution. No alternate command, external receipt or invented passed boolean is accepted.

Manual checks start a unit before the procedure and bind the human's verbatim confirmation after it. One explicit response may cover named checks and their procedures; `both` requires automatic and manual proof. The helper validates structure/applicability, while the skill ensures human provenance. Observe the whole application before/after every check and before completion; drift during a command invalidates its old-cycle success.

Each check gets exactly one of five result values:

- `configured`: set up but not run here, such as CI or a deploy that only a remote run proves.
- `executed`: run, but the observation cannot show whether the expected result holds.
- `succeeded`: run, and the observed result matches the expected one.
- `not-executed`: not run; the limits say why.
- `failed`: run, and the observed result differs from the expected one.

A coverage table gives every decision-register ID and component a status: `verified`, `unverified`, or `future`. The run reaches `complete` only when every required check succeeded with all type/reuse evidence, current approval/contract/cycle/environment/inventory and final checkpoint verify, every transitive digest verifies, and no uncertain/partial effect, writer, foreign pending publication or independent block remains. The helper derives summary, report and coverage; `.apex/inception/verification/results.md` is the final projection, never edited by the skill between attempts. Immutable cycle report and completion bind all accepted evidence. A passing local test does not prove a remote deploy or CI.

## After inception

1. Run `init` as usual. Its interview is unchanged; inception creates no hub artifact. Only a complete v2 run passes read-only `verify-complete` before first certified init. `inception-governance.mjs prepare --repo-root . --input <exact-json>` binds the confirmed five-key Project model, rendered stable document bytes and public-planner operations before writes; `finish --repo-root .` verifies the exact resulting difference. The canonical `.apex/init-provenance.pending.json` and `.apex/init-provenance.json` bind this one completion without modifying it.
2. Pending init recovery enters before a fresh source check or interview. Use the same retained input and original validated plan, verify its operation bindings against the pending receipt, and call public idempotent `applyProjectScaffold`; do not replan through the model CLI after a resolved replacement has already applied. Preserve complete outputs and write only missing exact document bytes, then finish. Missing/mismatched retained state stops. Ordinary later init/repair remains available without replacing the old certificate.
3. Run `discovery`. `verify-complete` authenticates all completion refs, derives summary/report again and compares the application before returning exact inputPaths and compact checks/coverage. Certified governance is virtually reversed: remove only wholly added files or subtract only the managed block from mixed AGENTS/CLAUDE bytes, preserving prefix and suffix. Verify current certified bytes too. Other files in the same provider, unmanaged edits, lockfiles/config/migrations remain observable. Application drift, tamper or legacy rejects this source only; ordinary discovery can examine current code, with no fallback to old inception decisions and no reopening/bootstrap replay.
4. Discovery asks you to accept or reject every decision with a reason. Verified decisions can become existing components or rules; unverified ones are design choices; future flows remain context. Write only conventions, routed standards and glossary. You can delete the local area after discovery; no tool deletes it for you.

## Blocking, abandoning, and starting over

The skill blocks on unreadable determining input, out-of-scope changes, uncertain effects, unexplained divergence or missing required evidence, preserving files and exact recovery refs. Resolving one named block never clears another.

Abandon is explicit. The helper reserves `.apex/inception/abandon-intent.json` before archive creation and records child physical identities, moving `run.json` last. `abandon --resume` uses only that canonical intention and exact children even after moving run.json; source/destination identity conflicts refuse, while a verified final receipt is a no-op. It deletes nothing and performs no automatic restart. A later new run requires your explicit request. Without hub/run after archive, `validate-hub` again reports a missing `_INDEX.md` and the Stop hook blocks until a new run or init.

## Harness capabilities

The skill asks your harness what it really has when the run starts, and degrades in the open when something is missing. There is no headless or autopilot mode on any harness: a human answers and approves everywhere.

| Harness | Subagents | Question tool | Network |
|---|---|---|---|
| Claude Code | Available; research and bootstrap parts can run as children. | Available. | Per session and permission settings. |
| Codex | Host-dependent; inline when the host offers no dispatch. | Plain-prose questions when the host has no question tool. | Per sandbox and approval settings. |
| OpenCode | Available through its task tool. | Plain text: one question, numbered options. | Per host configuration. |
| Pi | None; the work runs inline with a declared degradation. | Plain text: one question, numbered options. | Per host configuration. |
| DeepSeek Harness | None wired; the work runs inline with a declared degradation. | Plain prose: one question, numbered options. | Per host configuration. |

Without network access the run asks you for official sources or blocks; it never pins a remembered version. Each degradation is recorded in the reconnaissance record, or in the next resume note when it is first met after approval.

## Limits

- No preset stack. Every layer is decided with you; Node is the engine's runtime only, not a default for your application.
- One representative path is built, not the whole product.
- One run per repository.
- A mature application is not an inception case: the skill proposes `init`, then `discovery`, instead.
- Scenario C is deferred to a later version.
- Real-harness runs follow the [native acceptance protocol](inception-acceptance.md).

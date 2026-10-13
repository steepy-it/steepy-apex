# Inception native acceptance protocol

This protocol is a release gate after review. It is not a review criterion: review judges the repository, and this gate judges the skill running in a real harness. Nothing here is run by the test suite.

## Setup rule

Every run loads the branch's packaged plugin, with the installed steepy-apex release disabled. An older installed Stop hook reports `missing _INDEX.md` on every inception turn and spoils the evidence. Record the loaded plugin commit in the matrix.

## Scenarios

### Scenario A: empty repository

1. Start in an empty repository (Git initialized, no files).
2. Run the `inception` skill. Answer as a human; approve the project at the approval pause.
3. Let the run reach `complete`.
4. Run the `init` skill, then the `discovery` skill with the inception source.
5. Confirm the hub validates and the inception source is offered and consumed once.

On Claude Code, scenario A includes one unplanned interruption: stop the session between an effect's intent and its outcome, then resume in a new session. The resumed run first reports the missing outcome as uncertain, then reconciles automatically only when durable evidence and exact correlation prove the original intent. An ambiguous outcome remains uncertain, requires a human decision, and must never be replayed. Reconciliation cannot replace a required manual check or authorize a new remote operation.

### Scenario B: starter plus design system or prototype

1. Start in a repository holding a starter and a design system or prototype.
2. Run the `inception` skill; the existing material is reconnaissance input, not a decision.
3. Reach `complete`, then run the `init` skill and the `discovery` skill with the inception source.

### Scenario C

Scenario C is deferred out of v1. It has no row in the matrix.

## Recovery and verification scenarios

Run these through the packaged skill, in new sessions where indicated. They supplement both scenarios above; record each case separately with exact refs, observed application differences, check IDs and human responses. Interruptions in every phase are required:

| Case | Required observation |
|---|---|
| reconnaissance and architecture decision interruption | Persisted unit/input/output scope survives; a stopped writer is observed before incomplete closure. Missing/truncated output is not completion; retry uses a new ID and exact predecessor. |
| research child interruption | One persisted child unit at a time, or explicit inline degradation; complete identity-delimited report and observed diff are checked, not file presence. |
| approval interruption | Pending publication resumes only its reservation; frozen documents/contract and verbatim human approval bind the same bytes. No model self-approval. |
| bootstrap interruption between intent/outcome | Proven correlation permits automatic observation; ambiguous evidence blocks without replay or invented success. Live/unverifiable capture PID cannot be overridden by a human stopped-writer statement. |
| verification capture interruption | Resume exact capture/publication without command rerun; incomplete evidence remains incomplete. Complete output binding verifies both streams and exit/signal. |
| complete publication or closing-note interruption | Resume exact publication; after valid completion, a missing note permits presentation only, without reopening verification. |
| required check fails | Complete refuses; the agent cannot make it optional. Scope reduction requires human decision and re-approval. |
| manual confirmation missing | An automatic green cannot satisfy a manual or both-type required check. One explicit human response may cover multiple named checks/procedures. |
| application fix during verification | New cycle reruns all required automatic and manual checks; no impact-based selection of old successes. Earlier failed evidence remains historical. |
| unchanged verification resume | Snapshot-policy success remains applicable; mutable-resource reobserve gets new session-bound evidence. Missing reobservation stays necessary without rerunning unrelated valid checks. |
| complete → init → discovery | init-provenance pending/final receipts certify exact governance operations; resume pending init with the retained original plan and idempotent public apply after a resolved replacement. The `documents` command then writes the certified stable documents with mode 0644 under any umask. Completed source/evidence stays byte-identical. |
| application drift after complete/init | Inception source rejects only this import; ordinary discovery remains available. No old-decision fallback, reopening or bootstrap replay. Foreign provider files and unmanaged root edits remain visible. |
| final abandon interrupted after descriptor move | `abandon --resume` uses canonical intention/child identities, preserves the intact archive, ends with a receipt, and never restarts automatically. Repeating it is a verified no-op. |

Include publication interruptions before/after staging, ordered target prefixes and final descriptor replacement; foreign/divergent targets must stop without overwrite. A legacy v1 fixture remains readable and archivable but cannot mutate, migrate or satisfy v2 source verification. Collector exit 0 with a red approved command is capture success, never a passing check.

## Copy validation

A copy of only the versioned files (for example a `git clone` of the branch) must validate: `node <engine-root>/scripts/validate-hub.mjs .` prints OK without `.apex/inception/` and `.apex/work/`. Check this after each completed scenario.

## Evidence rules

- A hand-written command sequence imitating the skill is not a proof. Only a run driven by the skill counts.
- A model's approval is never recorded as a human approver. Leave the cell empty or `none` if no human approved.
- Record observed facts only. An unrun row stays `NOT RUN`. The initial matrix used `PENDING`; that was an unexecuted placeholder, not a historical observation of success. Preserve any future recorded observation and its version/commit when adding newer evidence.

## Evidence matrix

| Run | Harness version | Plugin commit | Capabilities | Observed outcome | Observed human approver |
|---|---|---|---|---|---|
| Claude Code A (with interruption) | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Claude Code B | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Codex A | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Codex B | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |

No native acceptance was executed by this documentation update. Automated regression tests and content locks do not change the matrix. Add one row per recovery/verification case and harness only after actual execution; retain prior observed rows rather than relabeling them as current evidence.

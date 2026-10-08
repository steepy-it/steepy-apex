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
4. **Project and approval.** The skill writes the project documents under `.apex/inception/project/`: constraints, the decision register, components and contracts, the verification plan, deploy, limits, and the representative path (one complete flow across the agreed boundaries). Other flows stay future context and never become a started backlog.
5. **Bootstrap.** The skill builds the representative path: manifests and lockfiles from the official tools at the approved versions, install, build, test, and start commands, an example configuration without secrets, and the data and integrations the path needs.
6. **Verification.** From a clean state, the skill checks install, build, test, start, the representative path, and the behaviors to preserve.
7. **Complete.** The run ends with a closing report.

### Three sessions, two pauses

| Session | Phases | Ends at |
|---|---|---|
| 1 | reconnaissance, architecture, research, approval | the pause after approval |
| 2 | bootstrap | the pause after bootstrap |
| 3 | verification and conclusion | `complete` |

At each pause the skill writes a resume note: the next action and the exact paths the next session must read. A new session starts from the run descriptor and the latest resume note, not from the earlier conversation. Starting fresh is recommended because earlier context is paid again on every turn. If you ask to continue in the same session, the skill continues and states the cost. A pause is not a block: the run stays active.

## The local area

Everything a run writes about itself lives under `.apex/inception/`. The area has its own `.gitignore` containing `*`, so the root `.gitignore` is never edited for it. It is local, like `.apex/work/`.

| Path | Holds |
|---|---|
| `.apex/inception/run.json` | The run descriptor: phase, status, harness capabilities, Git state, and the records it binds. |
| `.apex/inception/project/` | The approved project documents; `reconnaissance.md` and the mandatory `decision-register.md`. |
| `.apex/inception/research/` | Research and experiment reports. |
| `.apex/inception/bootstrap/` | One report per bootstrap part. |
| `.apex/inception/verification/` | Verification results (`results.md`). |
| `.apex/inception/approvals/` | One immutable record per approval. |
| `.apex/inception/checkpoints/` | One immutable record per checkpoint. |
| `.apex/inception/resume-notes/` | One note per pause or block. |
| `.apex/inception/effects.jsonl` | The append-only effect log. |
| `.apex/inception/abandoned/<run-id>/` | A run you abandoned, kept intact. |

The descriptor changes only through the helper; never edit it by hand. Records are written once and never rewritten.

## The helper commands

The skill drives `node <engine-root>/scripts/inception-state.mjs`, run from the repository root. The helper records and verifies; it never asks questions, chooses a phase, approves, or runs project commands. You rarely type these yourself, but you can run any read-only one to see the state.

| Command | Use |
|---|---|
| `inception-state.mjs classify --repo-root . [--maturity suitable\|mature]` | Read the starting state. Read-only. |
| `inception-state.mjs start --repo-root . --harness <slug> --capabilities <csv> --git-commits allowed\|forbidden` | Start the run and write the area's `.gitignore`. |
| `inception-state.mjs transition --repo-root . --to <phase\|blocked\|active> --reason <text>` | Move to the next phase, block, unblock, or return to approval. The last step takes `--checkpoint` and `--verification`. |
| `inception-state.mjs resume-note --repo-root . --next <text> [--need <path>]...` | Write a resume note. |
| `inception-state.mjs approve --repo-root . --statement <text> --document <path>...` | Record your approval statement, verbatim, with every project document. |
| `inception-state.mjs verify-approval --repo-root .` | Compare the project documents with the approval record. Read-only. |
| `inception-state.mjs effect intent --repo-root . --id <id> --kind <kind> --summary <text>` | Record an effect before it runs. |
| `inception-state.mjs effect outcome --repo-root . --id <id> --result succeeded\|failed --observed <text>` | Record what was observed after it ran. |
| `inception-state.mjs effect status --repo-root .` | List each effect as concluded or uncertain. Read-only. |
| `inception-state.mjs checkpoint create --repo-root . --label <text> --file <path>...` | Record digests of application files and the Git state. |
| `inception-state.mjs checkpoint verify --repo-root .` | Compare files and Git state with a checkpoint. Read-only. |
| `inception-state.mjs abandon --repo-root . --reason <text>` | Move the whole run to `abandoned/<run-id>/`. Deletes nothing. |

Every call prints one JSON line (`"ok":true` or `"ok":false` with an `error`). Exit `0` is success, `1` is a refused precondition or failed verification, `2` is a usage error. A refusal never writes.

Free-text values are passed as `--option=<value>`, for example `--statement=<value>`. The strict parser refuses a separate value that begins with `-`, and an approval statement may begin with a list marker. `checkpoint create` refuses application files reached through a symlinked ancestor directory and a path named twice.

## Approval and re-approval

You approve the complete project once, before bootstrap. The skill shows every project document path and asks for your explicit approval. It never approves for you; if no human is available it blocks. Your statement is stored verbatim with a digest of every project document, so a later change to an approved document is detected. A digest proves bytes, not a human: the record holds only the statement it was given.

After approval, installation, generation, implementation, and ordinary fixes proceed on their own inside the agreed scope. A substantial change (the database, boundaries, flows, design, deploy, a foundational technology, or the commit policy) needs a targeted decision and a new approval of the changed parts. The run returns to approval, the affected documents and the decision register are updated, and `approve` is recorded again over the complete current set.

## Effects and checkpoints

An operation with effects is an installation, a generator, a migration, an external resource, a deploy, a commit, or a remote operation. Each one is recorded with its intent before and its outcome after, then checked, then captured in a checkpoint of the application files it changed.

- An uncertain effect (intent without an outcome) is never repeated. On resume the skill observes the real state first and records what it found.
- A checkpoint is immutable. A later change gets its own effect and a new checkpoint.
- Local commits follow the commit policy you chose when the run started (`allowed` or `forbidden`; `none` without Git). Remote operations (a push, a repository creation, a deploy) are never covered by that answer: each one needs your authorization for that one operation, quoted in the log.
- Subagent children never run an operation with effects. They list what they need and the coordinator runs it.

If `.apex/inception/effects.jsonl` is ever malformed, the run refuses with `effect log is malformed at line <n>` and appends nothing. The run must block and a human must repair the file. Keep each line in the exact compact JSON form the helper writes: same key order, no spaces, `\n` line ends. Any other form is refused with the same message.

## Final verification

Verification runs from a clean state and records, per check, the environment, the exact command, the expected result, the observed result, and the limits. Each check gets exactly one of five result values:

- `configured`: set up but not run here, such as CI or a deploy that only a remote run proves.
- `executed`: run, but the observation cannot show whether the expected result holds.
- `succeeded`: run, and the observed result matches the expected one.
- `not-executed`: not run; the limits say why.
- `failed`: run, and the observed result differs from the expected one.

A coverage table gives every decision-register ID and component a status: `verified`, `unverified`, or `future`. The run reaches `complete` only when the final checkpoint verifies clean, the results file exists, and no effect is uncertain. A passing local test does not prove a remote deploy or CI.

## After inception

1. Run `init` as usual. Its interview is unchanged; inception creates no hub artifact.
2. Run `discovery`. It reads a complete run as the inception source, at exact paths, and asks you to accept or reject every decision with a reason. Verified decisions can become existing components or rules; unverified ones are written as design choices; future flows are written as context, never as implemented components, specs, or started tasks. Everything goes into `conventions.md`, the routed surface standards, and the glossary.
3. You can delete `.apex/inception/` after discovery. Until then it stays; no tool deletes it for you.

## Blocking, abandoning, and starting over

The skill blocks a run on an unreadable determining input, an out-of-scope change, an uncertain external effect, or an unexplained divergence. It preserves every file and writes a resume note naming what blocked it.

Restart only on your explicit request. `abandon` moves the run intact to `.apex/inception/abandoned/<run-id>/` and deletes nothing. The skill starts the new run in the same step. If no new run starts, `.apex/` holds neither a hub nor a run, so `validate-hub` reports the unchanged error for a missing `_INDEX.md` and the Stop hook blocks until you start a run or run `init`.

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

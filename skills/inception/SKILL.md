---
name: inception
description: Turn an idea and its starting materials into a minimal, verified, runnable application before the hub exists — reconnaissance, architecture decisions, verified versions, one human approval, bootstrap of one representative path, and final verification — then hand off to init and discovery.
user-invocable: true
---

# inception

Turn an idea and its starting materials into a minimal, verified, runnable application. The run
starts before the hub exists and ends with a hand-off to the `init` skill, then the `discovery`
skill.

`inception` is a **pre-hub skill**: it runs while `.apex/_INDEX.md` does not exist yet. It is not
a gear, and it is outside the brainstorm → plan → implement → review chain. It has no headless or
autopilot mode: a human answers its questions and approves the project.

> **Engine root:** this skill's base directory is `<engine-root>/skills/inception/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

## Boundaries

- Work only inside `.apex/inception/` and the application's own files. Never create
  `.apex/_INDEX.md`, routing, standards, specialist adapters, or a project bootstrap: those belong
  to the `init` skill after completion.
- One run per repository, at `.apex/inception/run.json`. Only the helper mutates the descriptor,
  effect records, frozen evidence, snapshots, approvals, checkpoints and completion. Never edit
  these records or adopt an unbound file as evidence. Runs use the v2 descriptor; any other schema
  is an unsupported run format that every helper command refuses, with no migration, archive or
  automatic restart.
- The first run write is `.apex/inception/.gitignore`, written by `start`. Never create or edit the
  root `.gitignore` for this area; an approved application generator may change it as an observed
  application effect.
- Working documents and coordinator JSON inputs belong under `project/`, research reports under
  `research/`, and part/check reports under `bootstrap/`. The helper owns `units/`, `approvals/`,
  `snapshots/`, `checkpoints/`, `effects/`, `reconciliations/`, `resume-notes/`, all verification
  evidence/results/reports, and archive records. `.apex/work/` is never a run input.

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

## Procedure

### Step 0 — Classify the starting state

Run `classify` without `--maturity` first:

```bash
node <engine-root>/scripts/inception-state.mjs classify --repo-root .
```

Classification reads fixed paths only. It never lists directories and never picks a run by recency
or file name.

When the row is `maturity-decision-required`, read the stack signals with
`node <engine-root>/scripts/detect-stack.mjs .` and propose a maturity reading. It is only a
proposal:

- `suitable` → an idea, starting materials, or a prototype that is not yet a working application.
- `mature` → a working application already exists.

The user decides an intermediate case: a nearly complete prototype needs the user's explicit choice.
Then run `classify --maturity suitable` or `classify --maturity mature` with the user's answer.

Act on the `row` field:

| Row | What to do |
|---|---|
| `maturity-decision-required` | No hub and no run. Propose a maturity reading, let the user decide, then classify again with `--maturity`. |
| `start-new-run` | Go to Step 1 and start a new run. |
| `propose-init-discovery` | The application is mature. Propose the `init` skill, then the `discovery` skill. Start nothing. |
| `ordinary-workflow` | The hub exists and there is no run. Use the ordinary workflow, for example the `brainstorm` skill. Start nothing. |
| `resume-run` | Resume the active or blocked run in Step 1. |
| `report-next-steps` | The run is complete and the hub does not exist yet. Report the next steps: the `init` skill, then the `discovery` skill. |
| `run-complete-ordinary-workflow` | Report "run complete, use the ordinary workflow". |
| `conflict-run-beside-hub` | Report the conflict: an unfinished run sits beside a hub, for example because `init` ran too early. There is no automatic resume; the user decides. |
| `invalid-state` | Preserve every file, explain the invalid state from the `error` field, and stop. |

### Step 1 — Start or resume the run

**Start:** declare actual `shell`, `network`, `browser`, `subagents`, `question-tool`, `headless`
capabilities. Ask once whether local commits are allowed or forbidden, unless already authorized;
without Git the helper records none. Remote operations retain their own exact scope.

Before approval the helper inventories the whole repository, so declare at start the dependency,
cache and generated directories that already exist, such as `node_modules`, `.venv` or a build
output, and those that work before approval will create, such as dependencies installed to try a
prototype. They cannot change until approval. Look at the repository's real directories; there is no preset list. Each entry is
`{"path", "kind", "reason"}` with kind `dependencies`, `cache` or `generated` and a literal path,
never a glob. Never exclude manifests, lockfiles, configuration or migrations. Ask the user to
confirm the list, then pass it as one strict JSON array on standard input with `--exclusions-stdin`
and a quoted heredoc; omit the option when nothing qualifies. `start` observes the repository once before writing anything: a symlink, hard
link or special file outside the exclusions refuses the start and names the path. Add that path
only when it is dependency, cache or generated material; otherwise stop and ask the user. These
exclusions hold until approval, when the contract's roots and exclusions replace them.

Then start. This executable illustration uses shell only and forbids commits; adapt it to the
confirmed policy:

<!-- example:start -->
```bash
node <engine-root>/scripts/inception-state.mjs start --repo-root . --harness codex --capabilities shell --git-commits forbidden
```

With installed dependencies, add the confirmed exclusions:

```bash
node <engine-root>/scripts/inception-state.mjs start --repo-root . --harness codex --capabilities shell --git-commits forbidden --exclusions-stdin <<'JSON'
[{"path":"node_modules","kind":"dependencies","reason":"Installed packages; package.json and the lockfile stay inventoried"}]
JSON
```

**Resume:** use `inspect`, `.apex/inception/run.json`, and only the exact refs it binds; no directory
listing, sibling/archived run discovery, or most-recent selection. The last note is not authority;
notes only explain state established by the descriptor and evidence. Run this before any new writer:

<!-- example:resume-check -->
```bash
node <engine-root>/scripts/inception-state.mjs resume-check --repo-root .
```

1. If the descriptor is an unsupported run format, every helper command refuses it, `abandon`
   included: stop, explain the unsupported run format, and leave its bytes untouched; nothing
   migrates, archives or deletes it.
2. If pending publication exists, use its exact reservation with `publish resume` and recheck. It
   publishes reserved bytes only. For an active unit, follow Persisted work units and recovery;
   do not dispatch another writer or treat absence of a child response as stopped-writer evidence.
3. Observe uncertain effects via their exact intent, correlation and real evidence (Step 8). Never
   repeat a concluded or uncertain effect. Reconcile only when proven; ambiguity blocks for a
   human decision. A similar resource or free text is insufficient.
4. Approval has three cases: **absent** means continue the persisted preapproval phase, never
   require a nonexistent approval or jump to bootstrap; **valid** means retain it without asking
   again; **divergent** means stop writers, explain the exact change, return explicitly to approval,
   then use a decision unit and targeted reapproval of the complete current project. A hash alone
   does not prove a human confirmation. Git branch/HEAD/status drift also needs evidenced
   reconciliation; a reconciled content-identical commit alone does not create a new cycle.
5. Resolve only the named block via `block resolve`, recording the human statement and evidence.
   A proven reconciliation can clear its own block, never unrelated blocks. Only after zero
   residual blocks may `transition --to active` proceed; recheck before new work.
6. Continue by persisted phase: reconnaissance → Step 2, architecture → Step 3, research → Step 4,
   approval → Step 5, bootstrap → Step 7, verification → Step 10. On a new verification session,
   after resume-check and recovery, use `verification resume --cycle <exact-current-cycle>` once.
   Repeated read-only resume-check calls in that session do not invalidate anything.
7. If complete, use `verify-complete` and give Step 10's closing presentation only. A missing
   closing note never restarts verification/bootstrap or changes completion.

### Step 2 — Reconnaissance

Begin a decision unit for the dialogue and exact reconnaissance output before work.
Find out what exists and what the user wants. Create `.apex/inception/project/` as an ordinary
directory if it is absent.

1. Identify every determining material: code, images, exported designs, documents, links. Read
   each one. An unreadable input needs an accessible alternative, such as an export, a copy, or the
   user's description. The run never claims to have analyzed what it did not read.
2. Record each element as **real** or **simulated**: mocks, stub calls, and hard-coded data stay
   simulations even when the screen looks complete.
3. Ask the user what the materials do not answer, with the dialogue rules below.
4. Write the reconnaissance record, `.apex/inception/project/reconnaissance.md`. It holds:
   - product goals and main flows;
   - what works, what is fragile, and known defects;
   - materials to reuse and behaviors to preserve;
   - technical, product, hosting, cost, and time constraints;
   - per-layer preferences, skills, and technologies to avoid;
   - the version policy: recent compatible stable, LTS or N-1, or per-layer;
   - the harness's real capabilities;
   - Git presence, branch, and the commit and remote-operation policy.

Dialogue rules, for every question the run asks:

- Ask one question at a time, in dependency order.
- Give understandable options with their trade-offs and a recommendation. Use your harness's
  question tool when it has one.
- A confirmed answer that is still valid is never asked again.
- There is no cap or filter on product questions.

Before you propose a remote repository owner or name, check the authenticated identity and which
owners are really accessible, for example with `gh auth status` and `gh api user/orgs` when they are
available, and propose only those.

Finish the decision unit with its complete report and observed diff.
When the reconnaissance record is complete, run `transition --to architecture --reason=<value>`.

### Step 3 — Architecture decisions

Begin a decision unit before each bounded architecture dialogue/document update.
Decide the architecture with the user before the definitive project is written. Cover these nine
stack-neutral categories:

1. system shape
2. contracts between parts
3. data
4. identity and access
5. internal architecture
6. repository and tooling
7. testing strategy
8. hosting and deploy
9. observability and errors

Ask with the Step 2 dialogue rules, and:

- A real fork gets its own question with alternatives.
- A choice with one reasonable answer may join a grouped confirmation with its reason.
- A category that does not apply is excluded with an explanation.
- Never merge dependent questions.
- No foundational choice appears for the first time at final approval.

Every significant decision enters the decision register,
`.apex/inception/project/decision-register.md`. It is one table:

| ID | Category | Decision | Reason | Alternatives | Confirmed |
|---|---|---|---|---|---|
| DR-1 | system shape | <decision> | <reason> | <each alternative, accepted or rejected> | <how it was confirmed> |

- IDs are stable: `DR-1`, `DR-2`, and so on. They are never renumbered.
- Each ID gets a coverage entry `dr-n` in the verification contract (Step 5).
- **Alternatives** names each alternative, accepted or rejected.
- **Confirmed** says how it was confirmed: its own question or a grouped confirmation.

Define the surface map: for each surface, its name, path, responsibility, specialist, and test
command. It is project context for the `init` interview, not a machine input to `init`.

No preset application stack: every layer is decided here. Node is the engine's runtime only, not a
default for the application.

Finish each decision unit and freeze its report/documents before moving phases.
When every category is decided or excluded, run `transition --to research --reason=<value>`.

### Step 4 — Research and versions

Every foundational choice (runtime, framework, build tooling, generators, main dependencies) gets an
official source, an explicit version, a verification date, its support status, and a compatibility
check. Versions you remember are not verified versions. Without network access, ask for official
sources or block. Begin a research unit before investigation/experiments/child dispatch, with exact
inputs and one report `.apex/inception/research/<unit-id>.md`. Use `research-prompt.md`, one child
at a time, or do the same bounded work inline and record the degradation. Experiments stay in a
new OS temporary directory outside the application repository and never become bootstrap silently.
Review the complete report and observed diff before finishing the research unit.

Present the version combination with these columns; obtain human confirmation in a decision unit
and record it without repeating confirmed answers:

| Component | Chosen version | Latest stable | Support or end of life | Reason for any deviation | Source and date |
|---|---|---|---|---|---|

### Step 5 — Project and approval

In a decision unit, write the project documents and decision-register, including materials and
simulations, constraints, components/contracts, sources/versions, reuse and preserved behaviors,
one representative path, deploy scope and limits. Other flows remain future; never start them as
a backlog. Write `.apex/inception/project/verification-contract.json` before human approval.
The contract assigns automatic, manual or both to each check; subject, procedure, expected outcome,
evidenceRequired, required boolean and applicable command/procedures are explicit. Declare roots
(a root that bootstrap creates later may be absent at approval; it holds no files until then),
exact justified exclusions (dependencies/cache/generated; literal paths, never globs), tools/resources, and coverage for every
approved decision/component, current or future. Give every register row its own entry whose `id` is
the lowercase register ID (`DR-1` → `dr-1`): discovery reads a decision's status only from that
entry. Component entries may be added. `approve` refuses a register row without its `dr-n` entry. Do not exclude pertinent manifests, lockfiles,
configuration or migrations to conceal failure. Before approval the helper inventories `.`
excluding only the reserved protocol areas, recognized scaffold leases and the exclusions bound at
`start`; Gitignore is not the inventory rule. From approval the contract's exclusions replace the
start ones: repeat every start exclusion that still applies. An omitted one is inventoried from
approval on: approval refuses if it holds a symlink or hard link, and otherwise its files silently
join the approved baseline. The recorded Git status
leaves out the same reserved areas, recognized scaffold leases and approved exclusions as the
inventory (before approval, the start exclusions), tracked or untracked; branch and HEAD stay compared.

For mutable remote resources use reuse policy reobserve with approved automatic and/or manual
reobservation procedures; snapshot is suitable for evidence that remains applicable to unchanged
local contents. Command uses executable, args, cwd and successExitCodes; shell use requires explicit
approved executable/argv. Commands must actually test expected, not merely print a version or
rely on the agent's visual judgement. Manual checks define procedure and acceptance. A both check
requires both kinds of evidence. At least one check is required.

The following small **illustration**, not a preset stack, verifies an `app.cjs` exporting `ready`
and an explicitly human-observed representative path. Replace its claims, paths and commands with
the real project before approval. Write this registration to `project/project-unit.json` before
its unit; obtain each Ref from the actual existing input bytes (none in this illustration):

<!-- example:project-unit -->
```json
{"kind":"decision","inputs":[],"outputs":[{"path":".apex/inception/project/decision-register.md","role":"decision"},{"path":".apex/inception/project/verification-contract.json","role":"decision"},{"path":".apex/inception/project/project-report.md","role":"report"}],"allowedPaths":[]}
```

<!-- example:project-begin -->
```bash
node <engine-root>/scripts/inception-state.mjs unit begin --repo-root . --id project --input .apex/inception/project/project-unit.json
```

Write the contract at the canonical path and the full project report using this unit's delimiters:

<!-- example:verification-contract -->
```json
{"schema":"steepy-inception-checks/v2","roots":["."],"exclusions":[],"environment":{"tools":[],"resources":[]},"checks":[{"id":"representative","required":true,"type":"both","subject":"Representative path","procedure":"Run assertion and open path","expected":"Ready export and readable path","evidenceRequired":"Captured assertion streams and explicit human observation","automatic":{"executable":"node","args":["-e","if(require('./app.cjs')!=='ready')process.exit(1)"],"cwd":".","successExitCodes":[0]},"manual":{"procedure":"Open the representative path","acceptance":"Path is readable"},"reuse":{"policy":"reobserve","automatic":null,"manual":{"procedure":"Reopen the same representative path","acceptance":"Same path remains readable"}}}],"coverage":[{"id":"dr-1","component":"Representative path","checks":["representative"],"status":"current"}]}
```

<!-- example:project-finish -->
```bash
node <engine-root>/scripts/inception-state.mjs unit finish --repo-root . --id project
```

After the project unit finishes, `transition --to approval --reason=<text>` if still in research.
Present all current project documents, decision-register and the contract, and obtain explicit
human approval once. A valid previous authorization persists. Never self-approve; a hash is not
proof of human provenance. Record the actual statement verbatim. This sample statement is test
illustration only, never substitute it for the user's answer:

<!-- example:approve -->
```bash
node <engine-root>/scripts/inception-state.mjs approve --repo-root . --statement=Approved-project-and-contract --document .apex/inception/project/decision-register.md --contract .apex/inception/project/verification-contract.json
```

Repeat `--document` for **all current project documents**, including any design/project prose beyond
this illustration. The helper freezes each document and the contract; it cannot certify who spoke.
Then enter bootstrap, which verifies approval:

<!-- example:bootstrap -->
```bash
node <engine-root>/scripts/inception-state.mjs transition --repo-root . --to bootstrap --reason=Approved
```

Ordinary in-scope implementation/fixes proceed autonomously. A substantial change in boundaries,
flows, database, design, technology, deploy or commit policy needs targeted reapproval: explicitly
return to approval first (add `--git-commits allowed|forbidden` for a policy change), begin a decision
unit, update documents/contract/register, finish, obtain the human decision and approve the full
current set again. New approval invalidates old cycles even with identical application bytes.
After an approval, register a new decision document (a `decision` output under
`.apex/inception/project/`) only in the approval phase; elsewhere `unit begin` refuses it. Until the
latest approval covers every registered decision document, `resume-check` reports an approval
divergence and forward transitions, verification commands and `verify-complete` refuse, naming the
path.
Never make a failed required check optional or weaken expected/type to close; reducing delivery
requires a human decision and reapproval.

### Step 6 — Pause after approval

Recommend a new session after approval. First finish all units/children, confirm the already
published bootstrap phase, then write `resume-note --next=<text> --need <exact-ref>` for needed
existing run artifacts. Record concrete child models and any degradation with `--note=<text>`.
The pause leaves the run active. Continue in the same session when requested; explain that earlier
context is paid on each turn. The note summarizes state and never grants a capability.

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

## Sessions and context

Recommend three sessions: reconnaissance/architecture/research/approval, bootstrap, then verification
and conclusion. Pauses are recommendations and never authorize work or require a new approval.
Recovery works from any persisted point, independent of chat history. Earlier context is paid on
each turn, so new sessions can reduce cost; continue in the same session when requested.

## Children and dispatch policy

Only one child or other work-unit writer runs at a time. Research may run while the coordinator
prepares dialogue, but another decision unit or document writer waits for its finish. A child gets
an already persisted unit ID, exact input paths, exact report output and correlation; bootstrap also
gets exact allowed application paths. Children never inherit coordinator read capability, list run
records, or mutate helper state. The coordinator reads the complete report and checks observed diff
before finish; a terse response alone is insufficient.

Translate abstract tier to the concrete available model at dispatch, and record the actual model
and degradation in the report/next note. Without subagents execute the same prompt inline with
explicit degradation. Each prompt returns status/artifact/changed-paths/signals after its full report.

| Template | Tier | Bindings |
|---|---|---|
| `research-prompt.md` | `standard` | `[UNIT_ID]`, `[INPUT_PATHS]`, `[OUTPUT_FILE]`, `[CORRELATION]`, `[QUESTION]` |
| `bootstrap-part-prompt.md` | `most-capable` | `[UNIT_ID]`, `[INPUT_PATHS]`, `[OUTPUT_FILE]`, `[CORRELATION]`, `[PART]`, `[ALLOWED_PATHS]` |

## Harness capabilities and degradations

Use what your harness really has, as declared in Step 1:

- No subagents → run each child's work inline, with a declared degradation.
- No question tool → ask in plain prose: one question, numbered options, and a recommendation.
- No network → the Step 4 rule: ask the user for official sources or block, and never pin a
  remembered version.
- There is no headless or autopilot mode on any harness: a human answers and approves.

Record each exercised degradation in the reconnaissance record. A degradation first met after
approval goes in the next resume note (`--note=<value>`), because the approved documents never
change.

## Blocking and abandon

A recognized scaffold lease is not divergence: the `.steepy-project-scaffold.lock` directory or its
stale, retired or candidate residue at the repository root that holds only its canonical 0600
`owner.json` record, live or dead. Never ask a human about it; a lock-like path that fails
recognition remains divergence.

On unreadable determining material, scope change, uncertain effect or unexplained divergence:

1. Preserve all evidence and stop new work. Inspect the exact active unit and any pending
   reservation. Use Step 1 to settle only a correlated reserved publication; never bypass writer
   exclusion or invoke application work again.
2. Settle the active writer before the blocked transition. Finish/reconcile only demonstrably
   completed work with its full valid report and observed diff. For stopped unfinished work,
   retain BLOCKED/NEEDS_CONTEXT in its report, record the actual stopped-writer observation and
   use `unit close-incomplete` as described above. Never fabricate a successful report to release
   the writer. Closure records incomplete history, leaves uncertain effects, unaccepted application
   drift and independent blocks intact, and grants no replay permission.
3. If a child/capture is live or its stop is unverifiable, retain the active unit and report the
   waiting condition with its exact ID and needed stop evidence. Request/await writer settlement;
   do not claim that the helper recorded a blocked transition or a resume-note. A capture's
   persisted PID must be proven dead; a human stopped-writer statement cannot bypass that rule.
   Return to settlement when proof becomes available, without starting another writer.
4. Only after activeUnit is null and pending publication is settled, persist the blocked
   transition. Then write an exact next-action note with the bound evidence paths when allowed.
   Check both command responses; a refusal is never a recorded status/note. Resolve only the
   relevant observations and named blocks under Step 1 before any return to active.

This missing-material recipe begins a decision unit before reconnaissance (research uses the same
sequence with kind research). Write `project/recon-input.json` first:

<!-- example:blocking-unit -->
```json
{"kind":"decision","inputs":[],"outputs":[{"path":".apex/inception/project/recon-report.md","role":"report"}],"allowedPaths":[]}
```

<!-- example:blocking-begin -->
```bash
node <engine-root>/scripts/inception-state.mjs unit begin --repo-root . --id recon --input .apex/inception/project/recon-input.json
```

If a required input is missing/unreadable, stop the incomplete reconnaissance and record the reason
in recon-report.md using this unit's BLOCKED report delimiters. Unit finish cannot accept that
report, and transition to blocked while recon is active refuses. Once the coordinator has actually
stopped its own writer (or has observed the child's stop), write `project/recon-stopped.json`:

<!-- example:blocking-stopped -->
```json
{"unitId":"recon","writerStopped":true,"statement":"The coordinator stopped its incomplete reconnaissance because required material is unreadable."}
```

This sample is only appropriate to an actual observation, never a substitute for stop evidence.
Close the stopped unit incomplete, preserving any uncertain effects or unaccepted changes:

<!-- example:blocking-close -->
```bash
node <engine-root>/scripts/inception-state.mjs unit close-incomplete --repo-root . --id recon --reason=Required-material-unreadable --evidence .apex/inception/project/recon-stopped.json
```

Read the closure response and descriptor; require activeUnit null, not completed work. Only then:

<!-- example:blocking-transition -->
```bash
node <engine-root>/scripts/inception-state.mjs transition --repo-root . --to blocked --reason=Required-material-unreadable
```

<!-- example:blocking-note -->
```bash
node <engine-root>/scripts/inception-state.mjs resume-note --repo-root . --next=obtain-readable-required-material --need .apex/inception/project/recon-stopped.json
```

The note describes how to obtain the missing material, not authority to retry the unit. Preserve
its incomplete identity and exact closure evidence; a later authorized execution needs a new ID
and explicit previous-unit after uncertainty/drift/blocks are resolved. Nothing in this settlement
sequence repeats application work or attests success.

Only an explicit user abandon authorizes `abandon --reason=<text>`. First settle the active writer;
the helper archives intact, deleting nothing. An interrupted archive resumes via
`abandon --repo-root . --resume` using canonical intent and exact children, even after run.json has
moved. Never scan abandoned runs. A verified complete archive is not automatic restart permission:
start a distinct run only on an explicit user request. Never delete `.apex/inception/`.

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

- Work only inside `.apex/inception/` and the application's own files.
- Never create `.apex/_INDEX.md`, routing, standards, specialist adapters, or a project bootstrap:
  those belong to the `init` skill, after the run is complete.
- Never create or edit the root `.gitignore` for the run's own area; only an approved bootstrap
  tool may change it, as an application file (Step 7). The area ignores itself: the first run write
  is `.apex/inception/.gitignore`, and `start` writes it.
- One run per repository: its descriptor is `.apex/inception/run.json`. The descriptor changes only
  through the helper; never write it by hand.
- Never rewrite a record bound to an approval or a checkpoint. The helper writes each record once,
  and a change makes a new record.
- Run files live only in these places under `.apex/inception/`:
  - `run.json`, `effects.jsonl`, `approvals/`, `checkpoints/`, `resume-notes/` → the helper writes
    them.
  - `project/`, `research/`, `verification/` → you write them.
  - `research/`, `bootstrap/` → a child writes its one exact output there.

  The helper also keeps `.gitignore` and `abandoned/`. Nothing else goes in the area.

## Helper commands

The run helper is `node <engine-root>/scripts/inception-state.mjs`. Run it from the repository
root, so `--repo-root .` names the repository.

The helper records and verifies; it never asks, chooses a phase, approves, or runs project commands.
Those decisions stay with you and the user.

| Command | Use |
|---|---|
| `node <engine-root>/scripts/inception-state.mjs classify --repo-root . [--maturity suitable\|mature]` | Read the starting state (Step 0). Read-only. |
| `node <engine-root>/scripts/inception-state.mjs start --repo-root . --harness <slug> --capabilities <csv> --git-commits allowed\|forbidden` | Start the run (Step 1). Writes `.apex/inception/.gitignore` first, observes Git, then writes the descriptor. |
| `node <engine-root>/scripts/inception-state.mjs transition --repo-root . --to <phase\|blocked\|active> --reason <text> [--git-commits allowed\|forbidden] [--checkpoint <path> --verification <path>]` | Move to the next phase, block, unblock, or return to approval. |
| `node <engine-root>/scripts/inception-state.mjs resume-note --repo-root . --next <text> [--need <path>]... [--note <text>]` | Write a resume note: the next action and the exact paths to read. |
| `node <engine-root>/scripts/inception-state.mjs approve --repo-root . --statement <text> --document <path>...` | Record the human approval, verbatim, with every project document (Step 5). |
| `node <engine-root>/scripts/inception-state.mjs verify-approval --repo-root . [--approval <path>]` | Compare the project documents with the approval record. Read-only. |
| `node <engine-root>/scripts/inception-state.mjs effect intent --repo-root . --id <id> --kind <kind> --summary <text> [--authorization <text>]` | Record an external effect before you run it. |
| `node <engine-root>/scripts/inception-state.mjs effect outcome --repo-root . --id <id> --result succeeded\|failed --observed <text>` | Record what you observed after the effect. |
| `node <engine-root>/scripts/inception-state.mjs effect status --repo-root .` | List each effect as `concluded` or `uncertain`. Read-only. |
| `node <engine-root>/scripts/inception-state.mjs checkpoint create --repo-root . --label <text> [--file <path>]... [--files-from <path>]` | Record digests of application files and the Git state. |
| `node <engine-root>/scripts/inception-state.mjs checkpoint verify --repo-root . [--checkpoint <path>]` | Compare the files and the Git state with a checkpoint. Read-only. |
| `node <engine-root>/scripts/inception-state.mjs abandon --repo-root . --reason <text>` | Move the whole run, intact, to `.apex/inception/abandoned/<run-id>/`. Deletes nothing. |

- `--capabilities` is a comma-separated subset of
  `shell,network,browser,subagents,question-tool,headless`.
- `--kind` is one of `install`, `generator`, `migration`, `external-resource`, `deploy`, `commit`,
  `remote`. Kinds `remote` and `deploy` need `--authorization`: the user's authorization for that
  one operation.
- `--id` is lowercase letters, digits, and dashes, and is never reused in the effect log.

Pass free-text values in the `--option=<value>` form: `--statement=<value>`, `--summary=<value>`,
`--observed=<value>`, `--reason=<value>`, `--label=<value>`, `--next=<value>`, `--note=<value>`,
`--authorization=<value>`. The helper's strict parser refuses a separate value that begins with `-`
(exit `2`, "argument is ambiguous"), and an approval statement or a note may begin with a Markdown
list item. Quote each value for your shell, so it arrives byte for byte.

Every call prints exactly one JSON object line on stdout. Read it before you go on:

- `"ok":true` → success. The other fields carry the result, for example `row` and `nextStep` from
  `classify`.
- `"ok":false` → a refusal; its `error` field says why, and stderr repeats it as
  `inception-state: <reason>`.
- The `command` field repeats the command spelling, family form included: `"effect intent"`,
  `"checkpoint verify"`.

Exit codes:

- Exit `0`: success.
- Exit `1`: a refused precondition, an invalid state, or a failed verification. Read `error`, then
  fix the cause or block the run.
- Exit `2`: a usage error (an unknown command or option, a missing required option, a bad value).
  Fix the command line.

A refusal never writes.

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

**Start** (row `start-new-run`):

1. Declare the harness capability record. Tell the user which of these your harness really has:
   `shell`, `network`, `browser`, `subagents`, `question-tool`, `headless`.
2. Ask the commit policy in one question: may the run create local commits (`allowed`) or not
   (`forbidden`)? Remote operations are never covered by this answer; each one needs its own
   authorization. Without Git, the helper records `none` whatever you pass.
3. Run `start --harness <slug> --capabilities <csv> --git-commits allowed|forbidden`. `<slug>` names
   your harness in lowercase letters, digits, and dashes; `<csv>` lists the capabilities you
   declared.
4. Go to Step 2.

**Resume** (row `resume-run`):

Resume reads only the descriptor, the records it binds, and the latest resume note: the last element
of `resumeNotes`, with the exact paths it lists. Resume never lists a directory and never reopens a
sibling file, such as an older note, an unbound record, or an abandoned run. So whenever you stop
before the run is complete, write a resume note first (see Blocking and abandon).

1. Read `.apex/inception/run.json`, the records it binds, and the latest resume note.
2. If the status is `blocked`, resolve the block the note records with the user, then run
   `transition --to active --reason=<value>`.
3. Run `effect status`. For every `uncertain` effect, observe the real state, explain any divergence
   to the user, and complete only the missing step the evidence proves. Record what you observed
   with `effect outcome --id <id> --result succeeded|failed --observed=<value>`. A missing step that
   still has to run is a new effect with its own `effect intent`. Never repeat a concluded or
   uncertain effect. A divergence you cannot explain blocks the run.
4. Continue at the step that owns the descriptor's `phase`: Step 2 for `reconnaissance`, Step 3 for
   `architecture`, Step 4 for `research`, Step 5 for `approval`, Step 7 for `bootstrap`, Step 10 for
   `verification`. For `complete`, give the closing report (Step 10).

### Step 2 — Reconnaissance

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

When the reconnaissance record is complete, run `transition --to architecture --reason=<value>`.

### Step 3 — Architecture decisions

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
- **Alternatives** names each alternative, accepted or rejected.
- **Confirmed** says how it was confirmed: its own question or a grouped confirmation.

Define the surface map: for each surface, its name, path, responsibility, specialist, and test
command. It is project context for the `init` interview, not a machine input to `init`.

No preset application stack: every layer is decided here. Node is the engine's runtime only, not a
default for the application.

When every category is decided or excluded, run `transition --to research --reason=<value>`.

### Step 4 — Research and versions

Every foundational choice (runtime, framework, build tooling, generators, main dependencies) gets an
official source, an explicit version, a verification date, its support status, and a compatibility
check. Record each research result in `.apex/inception/research/<slug>.md`; create the directory as
an ordinary directory if it is absent.

- Versions you remember are not verified versions.
- Without network access, ask the user for official sources or block, and never pin a remembered
  version.

Present the version review per layer, with exactly these six columns:

| Component | Chosen version | Latest stable | Support or end of life | Reason for any deviation | Source and date |
|---|---|---|---|---|---|

The user confirms the combination or corrects rows.

An experiment runs isolated outside the application repository, in an OS temporary directory. It is
recorded as an experiment in `.apex/inception/research/` and never silently becomes the bootstrap.

When your harness has subagents, document research goes to a child with exact inputs and one exact
output, a report under `.apex/inception/research/`. Without delegation, run the research inline and
write the declared degradation in that report.

### Step 5 — Project and approval

Write the project: one or more documents under `.apex/inception/project/`, in proportion to
complexity. Together they hold the materials and simulations, the constraints, the decision
register, the components and contracts, the official research, reuse, the behaviors to preserve,
the representative path, the verification plan, deploy, and limits.

The representative path is one complete flow across the agreed boundaries (interface, logic, data,
needed integrations). Other flows stay future context: they never become an automatically started
backlog.

When the project is written, run `transition --to approval --reason=<value>`.

The user approves the complete project **once**, before bootstrap:

1. Present every project document path.
2. Obtain an explicit human approval. Never self-approve. If no human is available, block
   (`transition --to blocked --reason=<value>`) instead of approving.
3. Quote it verbatim into `approve --statement=<value> --document <path>`, with one `--document` for
   every project document, `.apex/inception/project/decision-register.md` included.
4. Run `transition --to bootstrap --reason=<value>`, which runs `verify-approval` on the latest
   approval. Any mismatch blocks until a targeted decision and a new approval.

The approval record does not prove that a human approved: the helper only stores the statement it
is given. Acceptance evidence never presents a model's approval as a human's.

After approval, installation, generation, implementation, and ordinary fixes proceed autonomously
inside the agreed scope. A local choice already covered does not reopen the questionnaire.

A substantial change (the database, boundaries, flows, design, deploy, a foundational technology, or
the commit policy) needs a targeted decision and a new approval of the changed parts:

1. Run `transition --to approval --reason=<value>`. For a commit-policy change, run
   `transition --to approval --git-commits allowed|forbidden --reason=<value>`.
2. Ask the targeted decision, then update the affected documents and the decision register.
3. Present the changed parts and obtain a new explicit human approval. Run `approve` again with
   every current project document: each approval record covers the complete set.
4. Run `transition --to bootstrap --reason=<value>` again.

### Step 6 — Pause after approval

Session 1 ends here (see Sessions and context). Before you pause:

1. Publish the next phase in the descriptor. Step 5 ends with
   `transition --to bootstrap --reason=<value>`; check that its output says phase `bootstrap`. Do
   not run it again.
2. Wait for every active child to return.
3. Write the resume note: `resume-note --next=<value> --need <path> --note=<value>`, with one
   `--need` for every exact path the next session needs, such as each project document. Each
   `--need` is an existing file under `.apex/inception/`. `--note=<value>` carries, on one line, the
   concrete model of each child dispatched in this session. Leave `--note` out when there is nothing
   to record. The helper writes the descriptor path and the phase into the note.

The pause is not a block: the run stays `active`.

Recommend a new session for bootstrap: everything earlier in this session stays in context, and that
context is paid again on every turn. If the user explicitly asks to continue in the same session,
continue, and state the cost. A pause is never a refusal.

### Step 7 — Bootstrap

Build the approved project: one representative path, not the whole product.

Split the work into parts and build them in dependency order: a contract's producer comes before
its consumers. Each part has explicit ownership, the exact application paths it may modify, and a
report, `.apex/inception/bootstrap/<part>.md`.

- When your harness has subagents, dispatch each part with `bootstrap-part-prompt.md`, one at a time
  (see Children and dispatch policy). A child modifies only its own part.
- You, the coordinator, keep the dialogue, the effect log, checkpoints, any commits, and the
  descriptor.

The bootstrap delivers:

- manifests and lockfiles produced with the official tools at the approved versions;
- install, build, test, and start commands usable from a clean checkout;
- an example configuration without secrets;
- the data, integrations, and migrations the representative path needs;
- reuse of the chosen materials and preservation of the agreed behaviors;
- the representative path, actually integrated across its boundaries;
- CI and deploy instructions when the project includes them.

Deploy is included or excluded with a reason, as the approved project says:

- Included → it needs evidence of its result.
- Excluded → it does not prevent bootstrap from concluding.

A passing local test does not prove a remote deploy or CI.

Never build every prototype screen: the other flows stay future context.

Build and test fixes inside the scope are autonomous. A substantial change follows the re-approval
rule in Step 5.

The run never creates or edits the root `.gitignore` for its own area. An approved tool, such as a
generator or a framework CLI, may create or edit the root `.gitignore` as an application file. That
is an operation with effects, recorded with `effect intent` and `effect outcome` like any other
generator output (Step 8).

Every operation with effects follows Step 8. When every part is built and checked, go to Step 9.

### Step 8 — Effects and checkpoints

An operation with effects is an installation, a generator, a migration, an external resource, a
deploy, a commit, or a remote operation. For each one, in this order:

1. Before it runs: `effect intent --id <id> --kind <kind> --summary=<value>`.
2. Run the operation.
3. After it: `effect outcome --id <id> --result succeeded|failed --observed=<value>`, with what you
   really observed.
4. Run the relevant checks, for example the build and the tests.
5. Record a checkpoint: `checkpoint create --label=<value> --file <path>`, with one `--file` for
   every application file the operation created or changed.

Remote operations (a push, a repository creation, a deploy) need the user's explicit authorization
for that one operation. Quote it in `--authorization=<value>`, with kind `remote` or `deploy`. The
commit policy never covers a remote operation.

Commits follow the commit policy in the descriptor:

- `allowed` → the commit and its checks come before the checkpoint. The commit is itself an
  effect, of kind `commit`.
- `forbidden`, or `none` without Git → make no commit. A repository without Git and an uncommitted
  tree are supported when the checkpoint records them faithfully.

Rules:

- An interruption never authorizes repeating a concluded or uncertain effect. On resume, Step 1
  settles every `uncertain` effect first.
- A checkpoint is never replaced by a new baseline to hide changes. A later change gets its own
  effect and a new checkpoint.
- Children never run an operation with effects. A bootstrap part lists the effects it needs in its
  report, and you run them. A research experiment stays in its isolated directory outside the
  repository.
- `checkpoint create` refuses an application file reached through a symlinked ancestor directory,
  and a path named twice across `--file` and `--files-from`. Name each application file once, by its
  real path.

### Step 9 — Pause after bootstrap

Session 2 ends here. Before you pause:

1. Publish the next phase in the descriptor: `transition --to verification --reason=<value>`.
2. Wait for every active child to return.
3. Write the resume note: `resume-note --next=<value> --need <path> --note=<value>`, with one
   `--need` for every exact path the next session needs, such as each bootstrap part report. Each
   `--need` is an existing file under `.apex/inception/`. `--note=<value>` carries, on one line, the
   concrete model of each child dispatched in this session and any degradation first met since
   approval. Leave `--note` out when there is nothing to record. The helper writes the descriptor
   path and the phase into the note.

The pause is not a block: the run stays `active`.

Recommend a new session for verification: everything earlier in this session stays in context, and
that context is paid again on every turn. If the user explicitly asks to continue in the same
session, continue, and state the cost. A pause is never a refusal.

### Step 10 — Final verification and conclusion

Session 3 verifies the application and concludes the run.

Verify from a clean state, such as a fresh checkout without installed dependencies, build output,
or processes left from bootstrap: install, build, test, start, the representative path, and the
preserved behaviors. A verification step with effects, such as an install, follows Step 8.

For each check, keep its environment, exact command or procedure, expected result, observed result,
and limits. Each check gets exactly one of five result values:

- `configured`: set up but not run here, such as CI or a deploy that only a remote run proves.
- `executed`: run, but the observation cannot show whether the expected result holds.
- `succeeded`: run, and the observed result matches the expected one.
- `not-executed`: not run; the limits say why.
- `failed`: run, and the observed result differs from the expected one.

Check that the resolved versions, in the lockfiles and the tools' version output, match the approved
combination.

Write `.apex/inception/verification/results.md`; create `.apex/inception/verification/` as an
ordinary directory if it is absent. It has two sections. `## Checks` has one row per check:

| Check | Environment | Command or procedure | Expected | Observed | Limits | Result |
|---|---|---|---|---|---|---|
| install | <environment> | <exact command> | <expected> | <observed> | <limits, or none> | succeeded |

`## Coverage` has one row for each decision-register ID and each component:

| ID | Component | Status | Checks |
|---|---|---|---|
| DR-1 | <component> | verified | <the checks that cover it> |

Status is `verified`, `unverified`, or `future`. Never edit the approved documents to record the
results.

Conclude the run after the last authorized commits:

1. Create the final checkpoint: `checkpoint create --label=<value> --file <path>`. Its output's
   `checkpoint` field is the path to pass next.
2. Run `transition --to complete --checkpoint <path> --verification .apex/inception/verification/results.md --reason=<value>`.
   The helper refuses while that checkpoint does not verify clean, or while any effect is
   `uncertain`.
3. Write the closing note: `resume-note --next=<value> --need .apex/inception/verification/results.md`,
   where `<value>` is exactly `run the init skill, then the discovery skill with the inception source`.
   Add `--note=<value>` to the closing note when a degradation was first met in this session.
4. Give the closing report: what is verified, unverified, and future, and the next steps: the `init`
   skill, then the `discovery` skill with the inception source.

The run ends at `complete`. It does not run the `init` skill.

## Sessions and context

A run takes three sessions with two planned pauses: after approval (Step 6) and after bootstrap
(Step 9).

| Session | Phases | Ends at |
|---|---|---|
| 1 | reconnaissance, architecture, research, approval | the pause after approval (Step 6) |
| 2 | bootstrap | the pause after bootstrap (Step 9) |
| 3 | verification and conclusion | `complete` and the closing note (Step 10) |

A new session starts from the descriptor and the latest resume note (Step 1), not from the earlier
conversation. Earlier context is paid on every turn, so a new session at each pause keeps the cost
down.

## Children and dispatch policy

A child is a subagent that does one bounded job for you, the coordinator.

- A child receives exact input paths and one exact output path. It writes its detail to its own
  report and returns a short answer: the four fields `status`, `artifact`, `changed-paths`,
  `signals`.
- Read a full child report only for a concrete missing fact.
- Children never inherit the coordinator's read capability: a child reads only the paths you pass
  it.
- Only one child runs at a time. Research may continue in the background while you keep the dialogue
  going.
- Tiers are abstract: `standard` for research and experiments, `most-capable` for bootstrap parts.
  Never write a concrete model ID; translate the tier to a concrete model when you dispatch.
- Record the concrete model each child ran on, and any degradation, in the next resume note
  (`--note=<value>` at Step 6 or Step 9).
- Without subagents, run the work inline yourself, and write the explicit degradation in the report
  the work produces.

The two prompt templates live in this skill's base directory:

| Template | Child | Tier | Placeholders |
|---|---|---|---|
| `research-prompt.md` | one research question or experiment (Step 4) | `standard` | `[INPUT_PATHS]`, `[OUTPUT_FILE]`, `[QUESTION]` |
| `bootstrap-part-prompt.md` | one bootstrap part (Step 7) | `most-capable` | `[INPUT_PATHS]`, `[OUTPUT_FILE]`, `[PART]`, `[ALLOWED_PATHS]` |

`[OUTPUT_FILE]` is `.apex/inception/research/<slug>.md` for research and
`.apex/inception/bootstrap/<part>.md` for a bootstrap part.

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

Block the run on an unreadable determining input, an out-of-scope change, an uncertain external
effect, or an unexplained divergence:

1. Run `transition --to blocked --reason=<value>`.
2. Preserve every file and result.
3. Write a precise resume note with `resume-note --next=<value> --need <path> --note=<value>`: the
   exact next action, one `--need` for every path the next session must read, and what blocked the
   run.

Restart only on an explicit user request to abandon:

1. Run `abandon --reason=<value>`. It moves the run intact and deletes nothing: the run goes to
   `.apex/inception/abandoned/<run-id>/`.
2. Then start the new run in the same step: go through Step 1 (capability record, commit policy,
   `start`). Without a new run, `.apex/` holds neither a hub nor a run, and the hub linter reports
   the missing `_INDEX.md`.

Never delete `.apex/inception/`.

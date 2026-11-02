# inception — Steps 2–5: reconnaissance, architecture, research, approval

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

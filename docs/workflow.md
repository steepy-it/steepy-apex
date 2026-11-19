# Workflow and gears

How steepy-apex decides how much process a task deserves — and what each gear runs. This is the workflow guide linked from the [README](../README.md); the machinery behind it is described in [architecture](architecture.md).

## Before the hub: inception

`/steepy-apex:inception` runs before a hub exists. It is not a gear and it is not part of the Gear-3 chain: it has no coverage verdict, no gear, and no autopilot. It turns an idea and its materials into a verified first version, then points to `init` and `discovery`. After that, every task is classified as below.

The inception project and a `brainstorm` spec are different artifacts. The project is the one set of documents you approve before the first build; a spec is the work artifact of one task. Read the [inception guide](inception.md).

## Every task gets classified

You have a task. The gear-aware workflow entry checks whether the hub already decides it:

- **COVERED** — a rule decides it → apply it and cite the rule.
- **CONFLICT** — a rule contradicts the change → stop and surface it; the doc wins unless you explicitly override, and the override updates the doc, so code and docs never diverge silently.
- **GAP** — nothing decides it → explore the code first.

Every verdict carries `file:line` evidence. Cross that verdict with how consequential or irreversible the change is, and you get a ceremony **gear**:

| Gear | When | Ceremony |
|---|---|---|
| **1** | COVERED + low value | Straight to the specialist agent; coherence linter at the end. |
| **2** | COVERED + high value, or GAP + low value | Light spec → direct implementation → surface test + linter; no plan/review phase or subagent reviewer by default. |
| **3** | GAP + high value, or irreversible | Full chain: brainstorm → plan → implement → review. |
| **4** | Closed design + machine-verifiable goal + human confirmation | Autonomous bounded loop: author the goal contract, the loop iterates without per-turn gates, and you review the result when it ends. |

In gear 3, subagent reviewers are spent only on the **code diff** (per-task and whole-branch); prose artifacts (spec, plan) get a self-review plus a human approval gate — blocking in manual drive, and in autopilot the plan gate collapses to a non-blocking checkpoint (the contract carries the pre-authorization). The entry records the ratified gear once; downstream phases honor their accepted artifact metadata or manifest contract scalars without reopening undeclared upstream work.

Gear 2 takes the lean short circuit: `brainstorm` produces a READY light spec whose default next
phase is `implement`. Implementation derives one self-contained task, runs it under TDD, self-verifies
the criteria, then runs the surface test and `validate-hub` before terminating. A light plan remains
available only as an explicit opt-in when the spec cannot be executed as one independently testable
task; invoking it does not add Gear-3 human or subagent review gates.

## Model selection

steepy-apex matches model capability to each task’s complexity and risk to avoid spending
high-capability model effort on routine work. The goal is to balance cost, quality, and
completion effort: a cheaper model that needs more attempts can cost more overall.
Actual savings depend on the task, provider pricing, and harness support.

The gear determines the workflow. The model tier determines which level of capability
handles a particular task within that workflow; there is no fixed Gear 1 → cheap,
Gear 2 → standard, Gear 3 → most-capable mapping.

| Task characteristics | Model tier | Typical use |
|---|---|---|
| Mechanical work with the exact implementation already specified | `cheap` | Transcription or a tightly specified edit in one or two files. |
| Integration, multiple files, or implementation judgment | `standard` | Connecting components and implementing requirements from prose. |
| Design, architecture, high risk, or subtle behavior | `most-capable` | Resolving design decisions or handling consequential changes. |

Plans label each task `mechanical`, `integration`, or `design`; implementation uses that
label to select the tier. Direct Gear 2 implementation uses the light spec’s feature
complexity. Reviewers use at least `standard`, rising to `most-capable` for high-risk or
subtle work. The top tier is the top of the configured three-tier ladder, not an unrestricted
request for the most expensive model available. Overrides and their reasons are recorded.

### Providers and harnesses

A **provider** supplies the model; a **harness** is the coding-agent host that runs it.
The shared policy uses the same three tiers across providers. The configured
[model mappings](../adapters/model-mappings.mjs) translate those tiers to concrete models
for OpenAI, Anthropic, ZAI Coding Plan, and DeepSeek. A provider with fewer models may
map two tiers to the same model. These mappings describe the shipped configuration,
not a guarantee that every model is available to every account or host.

| Harness | How Steepy applies model selection |
|---|---|
| Claude Code and Codex | The deterministic runners pass the tier’s configured model explicitly. In interactive workflows, skills request explicit subagent model selection where the host supports it. |
| OpenCode | Interactive tier agents require a configured model pinned to a mapped provider. Headless selection requires an injected verified mapping; without one, selection falls back to the session model and reports that limitation. |
| Pi and DeepSeek Harness | The current Steepy adapters use the session model and record that limitation; they do not provide per-task model switching or deterministic Gear-3/4 runners. |

Selection stays within the configured provider; Steepy does not automatically shop across
providers or switch accounts to find a lower price. When the host cannot apply a tier,
the workflow records the session-model fallback instead of claiming a model switch.
In OpenCode, a task whose tier differs from its registered specialist’s fixed tier uses
the matching tier agent with the specialist instructions carried into its prompt.

Autopilot also distinguishes orchestration from task execution: implement and review
controllers normally use `standard`, with `cheap` eligible for implementation of an
all-mechanical plan; the planning controller follows the spec’s complexity. Individual
tasks inside the implementation phase retain their own tier choices. The workflow ledger
records the model used, review iterations, overrides, and capability limitations.

### Keeping pace with models and harnesses

Model selection depends on the installed harness version, its model-selection APIs,
and the models available through the configured provider. New generations of model
families such as Opus and Sonnet can change names, availability, and the balance of
cost and capability; harness updates can also change how a model is selected.

steepy-apex’s maintenance policy is to track these developments and update model
mappings and harness integrations through verified project releases. Support for a
new model or host capability follows compatibility checks and an approved mapping or
adapter update. It is not guaranteed on the day a provider announces a new model.
Keep steepy-apex and your harness up to date to receive the supported changes.

Mapping entries carry source and verification dates. The
[model-mapping verifier](../scripts/verify-model-mappings.mjs) checks for drift; updates
require an explicitly approved patch rather than a silent runtime replacement.
An installed version does not automatically rewrite its mappings when a new model
appears: it continues to use its shipped configuration or the declared session-model
fallback where tier selection is unavailable.

## Gear 3: the workflow chain

Gear 3 is what a GAP + high-value (or irreversible) change reaches for — not a ritual every task needs. steepy-apex bundles a reduced, self-contained workflow chain for it, with no dependency on any other plugin. Every step is **hub-aware**: it reads the routing table, keeps the stable documentation graph coherent, and stores transient specs/plans under `.apex/work/`.

Two drive modes decide who pushes the button between phases: **manual** (default — you invoke each skill) or **autopilot** (a conductor drives plan → implement → review headlessly, with a stop-before-PR boundary). Each autopilot phase starts as a fresh session that loads only the documents its role needs; how that context is chosen and checked is described in [architecture](architecture.md#gear-3-phase-context-and-handoffs).

- **`/steepy-apex:brainstorm`** — One-question-at-a-time dialogue that turns an idea into a spec. It classifies the idea against the routing table to name the owning **surface**, respects that surface's standard, and writes the design to a `Status: DRAFT` spec at `.apex/work/specs/YYYY-MM-DD-<topic>.md` as it takes shape — you approve it section by section against the document itself, and only then does it publish `Status: READY` as the local work artifact.
- **`/steepy-apex:plan`** — Turns an approved spec into a plan whose every task states the change it makes, not the goal it chases, with review checkpoints. Each task names its **surface + specialist agent** and the surface's test command (from `.apex/testing-and-checklist.md`). The plan is written to `.apex/work/plans/`, back-linked to its source spec, and kept as a local work artifact.
- **`/steepy-apex:implement`** — Executes the plan under **rigid TDD** (red → green → refactor; no implementation code before a failing test). It runs the surface's test command for the cycle and delegates surface work to the specialist agent, updating `.apex/` docs when a standard or domain term changes. A review-fix loop that stops converging is capped: three fix rounds, two more on a stronger model when one is available, then it stops and hands you the open issues. You restart it by saying so, or in autopilot by resuming the run.
- **`/steepy-apex:review`** — Verifies the implementation against the spec's success criteria with real command output, runs `validate-hub.mjs` as a **mandatory** gate, and confirms durable decisions were promoted from local work artifacts into stable docs before the change is "done". When the reviewed work sits on a branch, it closes the loop by offering a PR to `main`.

The generated bootstrap remains a navigation router only: it reads the root and hub index, resolves the owning surface, minimum docs, specialist, and semantic workflow skill. Workflow-state inspection and ceremony stay inside the invoked gear-aware skills.

Between phases, each skill hands the next one an exact list of files to read and never picks a recent file on its own. The handoff rules, and how a task that needed unplanned discovery is flagged for review, are in [architecture](architecture.md#gear-3-phase-context-and-handoffs).

## Autopilot live observability

Autopilot prints a compact, curated live feed while each headless phase runs. It is for observing progress, not a control channel: **no-steer** means the conductor never injects prompts, commands, or follow-up decisions into a child. It can only observe and stop, and it always stops before a version bump, push, or PR.

Each phase has immutable, create-only attempt evidence under `.apex/work/tasks/<spec>/`:

- `phase-<n>-attempt-<m>.log` is the readable curated log for one attempt.
- `phase-<n>-attempt-<m>.raw.jsonl` is the immutable raw line capture for that attempt.
- `phase-<n>.log` is the append-only aggregate readable log, with BEGIN/END boundaries for attempts.

On resume, already-completed phases are skipped, but an unfinished phase always receives a **new attempt** number and new immutable files; no earlier attempt is overwritten. Resuming an `implement` phase that stopped at the fix-round cap restarts that review-fix loop with a fresh set of fix rounds.

Session identity, discovery, and resume support differ by harness. In the dated matrix, Codex and OpenCode can list and resume a headless session, while Claude Code offers only a resume hint. The [native capability matrix](architecture.md#native-capability-matrix--2026-08-19-steepy-apex-v085) lists each capability and the exact headless command. The status stream, extra resume inputs, and the usage ledger are described in [architecture](architecture.md#attempt-evidence-status-stream-and-resume-inputs).

### Privacy and retention

`log-mode: safe` is the default. It redacts known sensitive fields and common token/key patterns before writing local raw artifacts, then uses a separately bounded curated representation for the readable and live feeds. Safe redaction is best-effort defense in depth, not a mathematical secrecy guarantee: do not treat a safe local artifact as suitable for secrets you cannot retain.

`log-mode: exact` is available only when the human explicitly requests sensitive exact capture. It disables redaction for the local raw JSONL and emits `EXACT_LOGGING` in the status stream; exact raw logs may retain secrets. Exact mode never changes live/readable curation: those views remain compact and redacted, so exact capture is evidence retention rather than a way to reveal more live output.

If an interruption (`SIGINT`, `SIGTERM`, or terminal hangup), an explicit safety/failure condition, or a failed immutable raw write arrives, the conductor kills the child process group, records the correlated outcome, and halts. Healthy work does not halt for elapsed work duration, a phase timer, or fixed resource consumption. A bounded I/O integrity timeout may protect one stalled pipe/read/write/drain operation; it is not a work-duration timeout. Readable, aggregate-log, or live-destination failure instead records `OBSERVABILITY_DEGRADED`, disables that destination, and continues through raw capture plus the remaining healthy curated destinations.

## Gear 4: Loop Engineer

- **Gear-4 terminal controller** — Runs a ratified machine-verifiable goal under mandatory commit authorization, a mutation-attempt budget, blast-radius enforcement, and crash-safe resume. It produces four clean outcomes after whole-branch review; deterministic CLI runners are available for Claude, Codex, and OpenCode, while Pi and DeepSeek refuse explicitly as `runner-unavailable`. Fake-runner coverage is runtime-only evidence; the future five-provider LIVE matrix remains open.

Gear 4 now runs through a deterministic terminal controller. You ratify one exact `READY` **goal
contract** — goal, surface, verifier, boolean/metric mode, metric direction when applicable,
mutation-attempt budget, blast radius, and notes — and separately grant the mandatory commit
authorization. The controller refuses a partial contract, missing authorization, protected branch,
dirty fresh tree, unsupported surface, or absent deterministic runner before autonomous mutation.
The generated project bootstrap remains navigation-only and cannot supply either authorization.

After an owned child diff passes the blast radius, the deterministic verifier chooses the path:

- **Boolean mode:** exit 0 means goal reached; red is kept and committed before another attempt.
- **Metric mode:** a strict improvement over the baseline/best is kept and committed; a
  non-improvement is discarded to its controller-owned parent.

If a run is interrupted, a crash-safe resume completes only the steps the controller can prove it owns. When the state is ambiguous, the run halts and is permanently abandoned; the controller never resets uncertain work. Keep the halted evidence and start again with a new goal at a new path. The event log and replay rules are in [architecture](architecture.md#deterministic-gear-4-controller-boundary).

Every clean terminal outcome is branch reviewed, but is not necessarily branch-review approved.
The read-only whole-branch review records one of four outcomes:

- `GOAL_REACHED` — the boolean verifier is green or metric work strictly improved, and review
  approves. This is the only outcome that sets goal success.
- `BUDGET_EXHAUSTED` — boolean attempts ended without green after the full budget, whether the
  controller's branch review approved the evidence or reported issues.
- `NO_IMPROVEMENT` — metric attempts ended without a strict improvement after the full budget,
  whether the controller's branch review approved the evidence or reported issues.
- `REVIEW_REJECTED` — the budget is exhausted, the retained candidate is goal-acceptable (boolean
  green or metric strict improvement), and unresolved issues from branch review remain.

All four consume the ratified goal and finalize a `READY` ledger plus baseline-to-terminal diff;
`HALTED` is an interrupted/reconciliation state, not a clean outcome. Review-driven fixes consume
the same budget — there is no hidden allowance — and the controller never bumps, pushes, or opens a
PR.
The later terminal-review approval is distinct from the controller's branch-review verdict: it may
approve faithful negative completion without declaring goal success.

The CLI supports deterministic headless runners for Claude, Codex, and OpenCode. Pi and DeepSeek
remain explicit `runner-unavailable` results and never fall back to an inline model loop. The
hostile crash/replay suite supplies fake-runner behavioral evidence for the provider-neutral
runtime; it is not five-provider LIVE evidence. That future matrix remains open
while those two runner descriptors are unavailable.

## Specs and plans stay local

Specs and plans are working artifacts, not durable project documentation — they live under `.apex/work/specs/` and `.apex/work/plans/`, **gitignored** by `.apex/work/.gitignore` as a **local work artifact**. The stable hub stays versioned and reviewable: standards, conventions, glossary, testing checklist, README, and durable decision docs. Regular review checks the implementation against the accepted criteria-only artifact, compact index and branch diff, and confirms durable decisions were promoted into stable docs when needed; `validate-hub.mjs` ignores `.apex/work/**` but rejects stable docs that link into that ignored local area.

# Conventions

Repo-wide rules for steepy-apex. Surface-specific rules live in `standards/`.

- **Zero dependencies.** Every script uses Node built-ins only. No new packages.
- **ESM, Node >= 24.** Scripts export pure functions and guard `main()` with the
  `import.meta.url` entry check.
- **TDD.** Failing test first; minimal implementation; frequent commits.
- **Sanitize external input.** Validate/escape any user- or package-derived value
  before writing it into a file (`scripts/sanitize.mjs`).
- **Keep the hub green.** `node scripts/validate-hub.mjs .` must exit 0 before a
  task is done.

## Public format baseline

The public release defines the supported scaffold and workflow formats. Unsupported inputs are
rejected or exposed as explicit customization conflicts; do not add implicit conversions,
provider-namespace fallbacks, or acceptance of retired contract fields. Usage reports accept
only the current conductor ledger schema and identify unsupported records as invalid evidence.

## Work Artifacts
- Specs and plans are local workflow artifacts under `.apex/work/`.
- `.apex/work/` is gitignored by default; do not link stable docs to files inside it.
- This repository excludes the entire `/.apex/work/` tree through the root `.gitignore`,
  including its nested ignore file. Local work artifacts are never part of a release commit.
- Durable decisions must be promoted into stable docs: surface standards, conventions,
  glossary entries, README, or another versioned project document.
- The progress ledger lives at `.apex/work/tasks/<plan-basename>/` (`ledger.md` +
  per-task files). Why there: the linter already excludes `.apex/work/**` and local
  workflow state belongs in one place.
- **Work-input capability is default-deny.** A workflow phase may read under
  `.apex/work/**` only through an exact path named by its active handoff, bounded
  workflow-header recovery for a pathless invocation, or a work-area scope the user
  explicitly delimits. A pathless invocation recovers only the workflow header needed to
  locate its entry artifact; if that recovery is not unambiguous, it stops for a human
  handoff. It never selects a most-recent artifact. This capability is phase-local and
  transitive: a child gets only the work inputs explicitly handed to that child.
- A role-local autopilot manifest declares eager `required` inputs. An `onDemand` input
  is read only for a named missing fact and that justification is recorded. These entries
  control upstream work context, not ordinary repository source discovery.
- Manual and autopilot runs have the same phase inputs, outputs, transitions, and
  provenance semantics, but use different transports: autopilot uses role-local
  manifests; manual uses a human handoff envelope and model-only enforcement. Do not add
  a manual manifest, parser, or validator merely to imitate autopilot.
- Every workflow artifact moves `DRAFT` → `READY` → `CONSUMED`: the producer records the
  inputs and verification that make it READY, and the authorized consumer records that
  READY artifact when it consumes it. The two records must identify each other, preserving
  bidirectional provenance across the handoff.
- Publish verified output READY before input CONSUMED, using two ordered per-file replacements,
  never claiming a multi-file atomic transition. Exact resume binds the input and output: plan adds
  on-demand `output-plan`; implement binds `progress-ledger` and `task-results`; regular review adds
  on-demand `review-report`. READY/READY permits only proof-checked consumption repair and
  CONSUMED/READY a verified no-op; other impossible pairs fail closed without recency selection.
  Fresh brainstorm classifies the human request from stable routed rules and source, never an old
  spec/log. Actual routing links select the single standard or core plus reason-matched leaves.
- Unplanned discovery is explicitly DONE_WITH_CONCERNS plus `discovery:unplanned`, preserved through
  fixes into the compact task index. Ordinary or unattributed concerns do not imply discovery.
  Review derives insight attribution and regular release proposals only from criteria/index/diff;
  insufficient facts need human clarification, not unauthorized upstream reads. Content-contract
  tests document these model-based decisions; they do not prove deterministic manual enforcement.

## Inception (pre-hub)

- `inception` takes a new application from its starting materials to an approved, verified bootstrap
  before any hub exists, then hands it to `init`. It invents no specialist, standard, or bootstrap
  before `init`, and adds no chain role, gear, handoff grammar, or controller.
- Its local area `.apex/inception/` gets its own `*` ignore guard before any document or state, and
  stays outside the DAG, `validate-hub`, and every ordinary stable read. Reads there use only the
  descriptor and exact paths named for the current step; nothing is browsed or picked by recency.
- The human approves the whole project once, before bootstrap; the approval binds the exact project
  bytes. The agent then works autonomously inside that scope. A substantial change (database,
  boundaries, flows, design, deploy, a foundational technology) needs a targeted decision and a new
  approval. Foundational choices cite official sources, explicit versions, and a verification date;
  no preset stack.
- Helpers verify formats, paths, digests, and receipts; the skill owns dialogue, architecture
  judgement, evidence interpretation, and promotion decisions. A digest makes a change detectable; it
  does not authenticate a person.
- `init` takes the transfer through its own inception entry: it reuses the confirmed record, asks
  only for missing data, new decisions, or real conflicts, keeps the planner and Project model v1
  unchanged, and records init complete only after a per-decision receipt, a passing gate, and a hub
  that validates without `.apex/inception/` or `.apex/work/`. Unbuilt intentions never appear as
  existing components; future flows stay context, not backlog.
- `discovery` reads only stable knowledge and ordinary source, and never re-approves decisions a
  transfer already wrote.

## Decision model (conditional ceremony)

Every task entering a gear-aware workflow is classified by that workflow entry on two axes → a ceremony **gear**.

**Coverage verdict** (each needs `file:line` evidence; "covers" = a rule that *decides the fork*,
not merely one *on the topic*):
- **COVERED** — a hub rule decides it → apply and cite.
- **CONFLICT** — a hub rule contradicts the intended change → stop and surface with the citation;
  **doc-wins** on user confirm, or an explicit override that rewrites the governing doc to the
  new rule. Stable docs state the active rule and its why only — never the superseded rule
  (history lives in git and the work artifacts). Code and doc never diverge silently.
- **GAP** — nothing decides it → explore the code first; a consistent latent convention (≥2–3
  concordant occurrences) is written back and becomes COVERED; an isolated precedent is surfaced,
  not canonised; no precedent → brainstorm.

**Gear** (coverage × value):
- **Gear 1** (COVERED + low-value) — straight to the specialist agent; no spec/plan/brainstorm/
  subagent reviewer; `validate-hub` at the end.
- **Gear 2** (COVERED + high-value, or GAP + low-value) — light spec → direct implementation with
  implementer self-review → surface test + `validate-hub`; no plan or review phase by default and no
  subagent reviewer. A light plan is an explicit opt-in when the spec cannot be executed as one
  independently testable task.
- **Gear 3** (GAP + high-value / irreversible) — full chain (brainstorm gate → plan → implement →
  review). Subagent reviewers are spent only on the **code diff** (per-task + whole-branch); the
  prose artifacts (spec, plan) get a self-review plus a human gate, and `review` self-verifies. See
  "Review architecture (gear 3)" below.
- **Gear 4** (closed design + deterministic, machine-verifiable goal + human confirmation) — autonomous
  bounded loop executed by `/steepy-apex:loop-engineer`: the human authors the goal contract (goal,
  verifier, budget, blast radius), the loop iterates without per-turn gates, results are reviewed
  morning-after.

**Drive modes (gear 3)** — an axis orthogonal to the gear: the gear classifies coverage ×
value, drive mode says *who pushes the button between phases*. Gear 3 only:
- `manual` (default, absent field) — today's chain, unchanged.
- `autopilot` — after the blocking spec gate, the conductor (`scripts/autopilot.mjs`)
  runs plan → implement → review as fresh headless sessions; the collapsed gates become
  non-blocking checkpoints (artifacts still land on disk; the human can interrupt); halts
  on BLOCKED / CONFLICT / an explicit safety condition / a non-zero exit; stops before bump/PR
  (`READY_FOR_PR` — gate 8 stays human). Contract = the extended verdict artifact at the
  spec head (`drive`, `branch`, `commit-auth`, `harness`, `blast-radius` — field
  names shared with the gear-4 goal contract on purpose); trust envelope shared with gear
  4: the blast radius (dedicated branch, never push, never bump/PR) is a declared trust
  policy, not a sandbox — the conductor mechanically enforces only the branch guard
  (re-checked before every phase) and a clean working tree at fresh-run start; no-push
  and stop-before-PR ride the contract into each full-permission child's prompt.
  Morning-after review included.

  One Gear 3 conductor owns one physical checkout at a time. Parallel runs use distinct Git
  worktrees; the conductor does not orchestrate them automatically. A child's completion claim is
  not phase authority until the owning conductor correlates the attempt and records its acceptance.

  Wall-clock duration and resource consumption are observability signals, but neither a timer nor
  a predetermined fixed-consumption quota terminates a healthy phase by itself. Autopilot's phase/task
  topology is finite, but that is not a wall-clock liveness guarantee: a live silent child remains
  active until it exits or receives an explicit stop.
  Each fresh phase starts with a deterministic, versioned context manifest: its role-local
  `required` inventory is read eagerly, while `onDemand` entries require a named missing fact and
  are recorded. This governs eager upstream context, not repository authorization: source files
  needed to implement, test, or verify work remain normally discoverable and readable. Review uses
  the attributed criteria-only `success-criteria.md`, exact `task-result-index.md` projection (v2 JSON or legacy bullets), and
  canonical aggregate `branch-diff.txt`; a full spec is never a required review-criteria input.
  The conductor derives both of those artifacts itself before the review manifest — the criteria
  from the spec's single `## Success criteria` heading, the diff from the run's recorded `BASELINE`
  commit — so the review gate never depends on a child having written derived evidence, and a
  resumed run keeps the original baseline. What a child still authors, it verifies first: implement
  parses its own `task-result-index.md` against the plan before claiming completion, so a malformed
  result fails inside implement where it is fixable instead of at the review gate where it is not.
  A fresh implement ledger is an absent `onDemand` resume-state entry and a declared output, not a
  required pre-spawn input. The plan phase writes to its manifest-declared output path exactly.
  A manifest's implicated standards separate two classes: an owning or per-task surface with no
  routing row is a binding error and halts, while an unregistered cross-cutting entry is advisory
  prose, recorded once as `CONTEXT_SURFACE_IGNORED` and skipped — a word in a metadata list never
  refuses a run.
  Children persist their detailed result before replying with the selected artifact-first
  envelope (manual/legacy v1 four fields, autopilot v2 status/artifact/signals); the implement skill/controller validates it and retains only that
  envelope until a next decision needs the durable artifact. The controller routes an effective
  abstract tier, and adapters record concrete apply/degrade evidence. A resource-usage ledger is
  observational only: observation identity deduplicates exact retransmissions, while measurement
  scope independently establishes accounting eligibility. Reports sum only provably disjoint
  provider measurements; missing or unsupported scope is unknown, not zero, and an
  eligibility label is insufficient accounting evidence. Unknown-scope observations are retained,
  and missing-usage completions are durable observations, never zero. Conflicting retransmission evidence is one invalid, non-additive observation and remains in provider-collision analysis. Runtime provider-version
  evidence gates semantic promotion: OpenCode usage accounting accepts only the provider version
  verified by `adapters/headless-events.mjs` and `scripts/cost-report.mjs`; missing or different
  versions stay unknown. This restriction concerns usage accounting, not general OpenCode support.
  Interactive session-store observations are excluded from additive rollups
  without official disjoint-scope evidence. `scripts/cost-report.mjs` exposes coverage explicitly
  without creating a work timer or fixed resource stop condition. The ledger
  also records the model used, review iterations, and escalations so policy can be tuned from real
  runs.

**Boundary rule** (workflow routing): closed design + machine-verifiable goal → gear 4;
open design + trusted execution after the spec gate → gear 3 autopilot; otherwise → gear
3 manual. A harness with no headless mode → autopilot is not offered (explicit
degradation).

**Autopilot task-result versioning.** Fresh Gear-3 runs pin taskResultProtocol 2 in every manifest;
retained legacy runs stay on 1. V2 obtains source paths from immutable execution receipts and
projects exact JSON arrays into the task index. Child changed-paths claims are ignored raw telemetry,
including legacy brace notation. Semantic status/artifact/signals remain mandatory and never inferred.
The controller records the exact execution state in its authorized ledger before dispatch; deterministic
replay follows only schema-authorized same-directory parent/previous links. These machine capabilities
do not allow work scanning or child report preloading. A durable capture resumes review-pending without
another implementation; baseline-only state cannot prove completion. Valid captured NEEDS_CONTEXT/BLOCKED may continue in a new retry execution after a recorded remedy, preserving partial work; malformed results and drift cannot. Fixes retain earlier report
snapshots and cumulative paths, and task approvals bind the latest execution. Final approval and phase
acceptance require receipt replay plus every applicable task/final gate and exact phase-manifest provenance for every execution ancestor. Never fabricate historical
baselines or silently upgrade. Manual drive and Gear 4 keep their existing contracts.

**Deterministic workflow-controller foundation.** Gear-3 autopilot and any deterministic
Gear-4 controller share the same state-safety foundation: repository-confined work-path
capabilities, an append-only event log, immutable attempt reservation before side effects, a
baseline captured once, deterministic reduction and reconciliation on resume, and explicit
terminal states. Their phase topology and keep/discard policy may differ, but they do not invent
separate state, provenance, or crash-recovery primitives. The machine-readable event log is the
authoritative state source; a human-readable ledger is its deterministic projection and may be
regenerated from events, never used to reconstruct or override them. Resume may reconcile automatically only
when durable event and commit identity prove controller ownership; an ambiguous dirty working tree
is never reset automatically and instead records `RECONCILIATION_REQUIRED` before halting for
explicit human recovery. A deterministic Gear-4 run also requires one human authorization for
controller-owned per-iteration commits in both boolean and metric modes; without it the controller
refuses to start, and a `RUN_STARTED` event persists the decision with the branch and baseline.
Execution terminality is independent of goal success: a clean `BUDGET_EXHAUSTED` or
`NO_IMPROVEMENT` outcome finalizes complete evidence for review instead of leaving it
indistinguishable from an interrupted `DRAFT` run.
After terminal review, the run consumes its ratified goal contract regardless of outcome: the
authorization was spent even when the goal was not reached. A retry or larger budget uses a new
`READY` goal contract that identifies its predecessor; consumed authorization is never edited or
reopened.
The human-ratified Gear-4 budget bounds every autonomous mutation attempt, including fixes prompted
by final review; read-only verifier and reviewer runs do not consume it, and no hidden fix allowance
extends it.
A Gear-4 goal succeeds only when its deterministic verifier satisfies the ratified contract and the
whole-branch final review approves. Residual review issues with no mutation budget remaining produce
a reviewable terminal `REVIEW_REJECTED` outcome, never a success claim or an out-of-budget fix.
A deterministic Gear-4 controller keeps its state core provider-neutral behind an injected runner,
but a harness CLI is offered only when that harness has a deterministic headless descriptor. A
runnerless harness refuses explicitly; it never falls back to an inline model loop that cannot
provide the same replay and crash-recovery guarantees.

**Unattended observability** — unattended execution provides a curated live baseline alongside
durable evidence. Observability degradation is explicit; loss of durable raw capture blocks the
run. Fresh phase sessions outrank cosmetic native parent linkage.

**Write-back** — a resolved GAP or a CONFLICT override is written back only if the fork will
recur: a term → `glossary.md`; a surface rule → `standards/<surface>.md`; a cross-cutting fork →
this file. One-offs stay local in `.apex/work/`. A *decision*-shaped write-back to this file
passes a second filter: record it only when the decision is hard to reverse, surprising
without context, and the result of a real trade-off — any one missing, it stays local in the
spec; glossary write-backs keep the recurrence test only.

**Invariants:**
1. No command runs without a verdict — fresh brainstorm computes and ratifies it from human/stable
   evidence; downstream phases inherit only accepted artifact/contract metadata or recompute inline
   for gears 1–2. Gear-3 downstream commands without an accepted input refuse and bounce to the
   upstream chain entry. Gear-4 downstream
   (`loop-engineer`) refuses a missing or partial goal contract before autonomy; the generated
   project bootstrap remains navigation-only and never authors authorization.
2. Doc and reality never diverge silently.
3. Every recurring resolved GAP grows the hub.
4. Subagent reviewers are paid only in gear 3, and only on the **code diff** (per-task +
   whole-branch); prose artifacts use a human gate, not a subagent. `validate-hub` (deterministic)
   always runs. The whole-branch final review is also paid at the end of a loop (endgame), in
   addition to gear 3.
5. No gear starts without human ratification — the gear-aware workflow that computes the gear
   declares it with the evidence and asks one confirmation; the
   user may force a different gear (override recorded in the verdict artifact); gear 4 adds the
   goal-contract authoring to this ratification.

## Modular standards

Every surface may split its standard into a modular folder: `standards/<surface>/` containing
`<surface>-core.md` (the universal rules) plus leaf docs `<surface>-<sub-area>.md`. The folder
form is **opt-in and never scaffolded by default** — `init` and `new-surface` always produce a
single `standards/<surface>.md` file.

- The split — and promoting a sub-area to a full surface — is **ALWAYS a human decision**;
  tools at most signal via linting (a `validate-hub` warn) or propose (a discovery split-proposal
  card) but never decide alone.
- Surface-wide rules live in the core; a leaf never contradicts the core — if it does, that is
  Drift to fix, and the **core wins** in the meantime.
- Load semantics: always load the core, plus every leaf matching the core's mini-routing table
  (a table of sub-areas); zero matches → load the core only; never "read everything" as a
  fallback.
- Warn threshold: 150 lines for every `standards/**` file (core included), hardcoded in
  `validate-hub.mjs`, never blocking (exit code unchanged).

## Review architecture (gear 3)

A reviewer that reads the **code diff** — the per-task `task-reviewer` and the whole-branch
`final-review` — catches defects no other gate can, so both stay as subagents. A reviewer that reads
a **prose artifact** (the spec, the plan) cannot be backstopped by the downstream code reviewers:
those validate the code *against* the spec, so a wrong requirement is approved as faithfully built.
Prose therefore gets a stronger-per-token net — an inline self-review plus a **human gate** on the
written artifact — not another subagent.

- `brainstorm` — self-review + human gate on the written spec; no `spec-reviewer` subagent.
- `plan` — self-review + human gate on the written plan (blocking in manual drive; see
  "Drive modes (gear 3)"); no `plan-reviewer` subagent.
- `implement` — `final-review` (whole-branch) always runs; the per-task `task-reviewer` runs **only
  when the task carries real judgement**. Skip it for a purely mechanical/transcription task whose
  exact code the plan already specifies — the whole-branch review is the net.
- `review` — self-verifies each success criterion from real command output + `validate-hub`; no
  `evidence-reviewer` or evidence-collector subagent. A deterministic inline script streams verbatim
  command output to the current run's evidence artifact and returns a bounded receipt to model
  context. The **judgement** on each criterion, which swept insights get promoted, and the verdict
  remain in the review session. This keeps collection outside Invariant 4's subagent-review budget.

Model tiers weigh **turn count, not just token price**: the cheapest model often takes 2–3× the
turns, so a mid-tier model is the floor for reviewers and for implementers working from prose.
The ladder is closed at three rungs: `most-capable` means its top rung, never "the best model
the harness offers". A pricier model above that rung is outside the ladder and is never selected
from a tier — an override to it is recorded in the ledger with its reason.
In autopilot, the implement and review phase-controller dispatch tier is `standard` (`cheap`
stays eligible for an all-mechanical plan, and review floors at `standard`): those phase
children orchestrate rather than design, and per-task tiers are already applied inside the
phase. The plan phase child is the exception — it designs, so it keeps the spec's Complexity
binding (`most-capable` for a design-complexity spec).
The plan tags every task with a **Complexity** line (`mechanical | integration | design`);
`implement` reads it to pick the model tier and to decide whether the task gets its own
reviewer. The ledger records the model used, review iterations, and escalations, so the
policy can be tuned from real runs.

Skills stay self-contained: the per-skill Model Selection and gear-0 ("Read the gear") blocks are
duplicated on purpose. Only one SKILL.md loads per invocation, so folding them into a shared file
would add a read, not save tokens — do not DRY them.

## Execution discipline

- **Branch & commit authorization** — on `main`/`master`, ask once whether to branch; take
  one commit-authorization decision per `implement` run and honor it throughout; `review`
  offers a PR only when the branch has commits ahead.
- **Anti-chatter** — during plan execution, narrate at most one line between tasks and never
  ask "should I continue?"; one-question-at-a-time dialogue belongs only to interview steps
  (brainstorm, discovery).
- **Next-step routing** — every chain skill ends by naming the next skill; a downstream
  skill whose precondition artifact is missing refuses and bounces upstream instead of
  fabricating it. `loop-engineer` likewise refuses a missing or partial authorization contract.
- **Session per phase** — a phase of the chain runs in a session of its own; the phase handoff is
  where context resets. Declared on entry and exit, **never imposed** — sound work proceeds either
  way, and an uncertain session history is stated as such, not gated on. Why: session cost is
  quadratic in turns and nothing interrupts it — measured 17.0M context tokens for a single-phase
  manual session versus 19.6M for a mixed-phase manual session, against 3.6M in autopilot, which
  already applies this discipline via a fresh headless session per phase.

## Multi-harness distribution

Steepy Apex ships as one **shared canonical core + native adapters** for Claude Code,
Codex, OpenCode, Pi, and DeepSeek Harness: the ten skills in `skills/` are the single source of behavior,
served verbatim to every harness; per-harness manifests and thin runtime adapters
(`adapters/**`) do the wiring. Core-portability rules:

1. **Zero `CLAUDE_*` in the canonical core.** No SKILL.md or prompt template references
   `CLAUDE_PLUGIN_ROOT` or any `CLAUDE_*` variable (test-locked). The Claude hooks
   manifest is packaging, not core.
2. **Engine-root resolution is skill-relative.** Every skill lives at
   `<engine-root>/skills/<name>/`; engine scripts live at `<engine-root>/scripts/`,
   resolved relative to the skill's own base directory. No env vars in core prose —
   harness plugin-root variables appear only in per-harness hook manifests.
3. **Degradations are explicit, never silent.** Interactive questions are plain prose
   (one at a time, numbered options, a recommendation); subagent dispatch is conditional
   ("if your harness provides a task tool, dispatch; otherwise inline with a dedicated
   review pass"); model tiers stay abstract. Every degradation exercised is stated in
   the output and recorded in the ledger.
4. **Adapters are thin and dependency-free.** Plain ESM on the host harness's provided
   API only; no build step; workflow behavior lives once, in the canonical core.

## Portable project instructions

- **One root spine.** A generated project has one managed `AGENTS.md` common-instruction
  block. `CLAUDE.md` is only a managed import of that spine; it is not a second source of
  rules.
- **One canonical bootstrap.** The project bootstrap lives under `.agents/skills/`; the
  Claude copy is a thin native stub. Every bootstrap starts from `AGENTS.md`, then the
  `.apex` routing root and the matching surface standard.
- **Native adapters, no semantic copies.** Each routed surface receives exactly one thin
  Claude, Codex, and OpenCode adapter. The adapters identify routing; `.apex/_INDEX.md`
  and standards retain the rules. OpenCode reads project specialists only from `.opencode/agents`;
  Claude descriptors are not an OpenCode input.
- **Planner-owned mutation.** `project-scaffold.mjs` is the public route for generating
  and repairing these artifacts. It previews conflicts for a user decision, applies under
  an exclusive repository lock for cooperating writers, and treats a second repair as a
  zero-write no-op. Hostile processes that ignore the lock are outside that contract.

## Versioning & release

- Explicit semver in `package.json` + `.claude-plugin/plugin.json` + `.codex-plugin/plugin.json`,
  always in three-way lockstep (`scripts/bump-version.mjs`; drift guarded by
  `tests/release-metadata.test.mjs`). Marketplace users receive updates ONLY when the
  version bumps.
- PATCH = bugfix, MINOR = feature, MAJOR = breaking.
- Bump lands in-branch at PR time (review skill, human-confirmed) or on main via the
  push-guard prompt. Whoever bumps writes the `## vX.Y.Z (YYYY-MM-DD)` CHANGELOG section.
- Enforcement: PreToolUse push guard (main), `Version gate` workflow (PRs, `no-release`
  label opt-out), `Release` workflow (idempotent `vX.Y.Z` tag + GitHub Release on merge).
- **Scoping:** this policy governs THIS repo's own automation. The shipped `review`
  skill's bump step self-disables in target repos that lack `scripts/bump-version.mjs`
  + `.github/workflows/version-gate.yml`.

## Release commit messages

Release commits use `vX.Y.Z - <short release summary>` with the same version as the
three manifests, changelog heading, and release tag. Use a concise English summary
without private paths, personal contact details, or internal work references.
The initial public release uses `v1.0.0 - Release Steepy Apex`. Subsequent releases
retain the public history and follow the same message format.

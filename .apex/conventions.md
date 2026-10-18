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
- `inception` is a pre-hub skill, not a gear. It sits outside the chain and has no
  headless or autopilot mode. It never creates hub artifacts: no `_INDEX.md`, standard,
  glossary, or agent. Order: inception → `init` (ordinary interview, unchanged) →
  `discovery` (inception source) → gears.
- Local area `.apex/inception/` has its own `.gitignore` (`*`), written first. The root
  `.gitignore` is never edited for the area; an approved bootstrap tool may change it as
  an application file, recorded as an effect. The area is excluded from anti-orphan
  checks, stable reads, and discovery's explorer reads, like `.apex/work/`; inception
  material reaches the hub only through discovery's inception source. Stable links into
  it are errors. It stays after `complete` until the user deletes it after discovery.
- One run per repository, at `.apex/inception/run.json`, changed only by
  `scripts/inception-state.mjs`. Abandon moves the run to
  `.apex/inception/abandoned/<run-id>/` and deletes nothing.
- Pre-hub rule: no `_INDEX.md` plus a descriptor → `validate-hub` exits 0 naming the phase
  and next step, and the Stop hook stays silent. An unparseable descriptor is an error
  naming it.
- Single human approval, with file digests and the user's statement kept verbatim. It is
  never self-approved by the model; a digest proves bytes, not a human.
- Effects and checkpoints: an effect records its intent before and its outcome after. An
  uncertain effect is never repeated. Records are immutable.
- Session/recovery policy: three sessions (project/approval, bootstrap, verification) are recommended, not imposed. Resume uses exact descriptor refs from any point, independent of chat; notes present the next step, never authorize recovery. Research and bootstrap delegate when available, one persisted unit at a time; inline degradation is explicit. The skill conducts work and human decisions; the helper validates structured evidence, never infers acceptance from Markdown.
- V2 format: Node >=24 ESM/built-ins, strict UTF-8 JSON, closed fields/enums, safe counters, UTC millisecond timestamps, lowercase SHA-256, canonical key order/newline. Exact confined ordinary single-link paths only, no alias/symlink; names are literal, so brackets, braces, `*`, `?` and `:` are ordinary characters and no path is read as a pattern. Descriptor revision and ordered refs identify records; no recency selection. Immutable units/outputs, snapshots, effects, cycles, sessions, captures, summary/report and completion remain reachable by exact refs. `inception-state.mjs` alone mutates the descriptor; protocol validates, snapshot observes, collector executes one approved command, governance certifies init only.
- Writer/publication policy: persist the sole active unit before decisions, research, bootstrap or checks; bind complete identity-delimited reports and observed whole-inventory changes before finish. The scaffold lease serializes short cooperating-writer mutations. A pending reservation binds bytes, token, revision and exact targets before publication; resume completes that reservation only, never application replay. The terminal reservation is the commit point: complete compares the live application and Git once, before reserving; finishing or resuming it re-derives the completion from recorded evidence only. Later application drift is reported, naming the drifted paths, by the strict read-only verify-complete; Git provenance after the reservation is historical, as after any completion. Divergent/foreign targets block without overwrite. A partial own staging generation stays interruption evidence. No adversarial filesystem guarantee is claimed.
- Contract/approval policy: freeze all project documents, decision register and the control contract in the human approval. Required/type/expected cannot be weakened to close a failure; scope reduction requires human decision and re-approval. Live documents may change only after returning to approval; historical approvals verify frozen copies. Required checks must succeed, with automatic execution/output, manual procedure/acceptance and explicit human confirmation, or both proofs for type both. One scoped human confirmation may cover multiple checks. Every decision-register row `DR-n` needs a contract coverage entry with the lowercase ID `dr-n`, the only association discovery reads; approval refuses a row without one. Every registered decision output under the project area must be covered by the latest approval: outside the approval phase `unit begin` refuses a new one, and every non-historical check of the latest approval (forward transitions, verification, resume-check, verify-complete) refuses an uncovered one, naming its path.
- Application policy: inventory every approved root's paths/content/modes with exact justified dependency/cache/generated exclusions, never hide relevant manifests, lockfiles, configuration or migrations. Git is separate provenance; neither Git nor a clean tree is required. Before approval observe the full repository except physically bound local/Git areas, recognized leases and the exact dependency/cache/generated exclusions bound at start; start refuses before any write when that scope cannot be inventoried, and the approved contract's scope replaces it. A recognized lease is a repository-root directory in the scaffold lock family (canonical, stale, retired or candidate name) holding only a canonical 0600 owner record that matches its name, live or dead; every observer excludes it by path, and readers never retire or write it; anything else lock-like stays drift. Git status excludes the same set as the inventory, approved exclusions included, tracked or untracked, and leaves dirty submodule work trees to the inventory; branch/HEAD stay compared and different scopes are always drift. Status-only changes are explained only by their cause in the diff: precomposed versus decomposed names, a nested repository's single directory entry by changed files beneath it, an unchanged untracked file flipped by a changed ancestor `.gitignore`. Symlinks/special files fail closed. Whole before/after diffs must match exact allowed paths and evidence; a checkpoint cannot erase unexplained drift. Accepted application changes require all required automatic and manual checks in a new cycle; a new approval also invalidates prior results.
- Cycle/session policy: cycle binds approval/contract/application identity/environment; reuse only if all agree. Unchanged resume retains valid snapshot-policy results; mutable-resource reobserve needs current-session evidence from the approved procedure. The skill explicitly persists a verification session once on new entry; read-only resume-check does not invalidate evidence. Compare application before/after every automatic/manual check and before complete. Drift during execution invalidates the old-cycle success.
- Evidence/reconciliation policy: reconcile automatically only with sufficient evidence and exact correlation to the original intent; ambiguous outcomes stay uncertain and require a human decision, without replay or invented success. Partial effects remain unresolved. Reconciliation replaces neither required manual confirmation nor remote authorization. Non-capture incomplete closure binds an explicit verbatim stopped-writer observation; it never overrides a live/unverifiable capture PID. Retries use a new ID and exact predecessor; uncertainty and unrelated blocks persist.
- Collector/complete policy: reserve capture identity/PID before one approved executable/argv command, seal full separate streams with exit/signal/timing and cycle/session/unit/before/after refs. No external receipt import or passed boolean. Linux/darwin process-group termination and stream settlement are required; unsupported platforms refuse before effects. Capture exit 0 can include a red command. Helper-derived summary/report/coverage binds all evidence; complete requires every required type/reuse proof, current application/environment/approval, final checkpoint, verified transitive digests and zero uncertain effects, writers, foreign pending publications or blocks. Optional missing checks stay not-executed with limits; future stays future. Missing closing note permits presentation repair only.
- Post-complete policy: read-only `verify-complete` authenticates evidence and application before releasing exact source inputPaths; source rejection preserves completion and leaves ordinary discovery available, with no old-decision fallback. Init certifies only exact prepared governance operations via pending/final provenance receipts and the public planner/applicator; pending recovery uses the original validated plan, never fresh replanning. Virtually reverse only wholly added files or certified managed blocks, preserving unmanaged bytes and checking current governance; the planner's exact adoption of an unmarked CLAUDE.md import is the one certified relocation, reversed to the original bytes. Other provider/config/lockfile/application changes remain visible. A descriptor whose schema is not steepy-inception-run/v2 is an unsupported run format: every command refuses it before any lease or write, with no migration, archive, deletion or automatic restart. Only `inception-governance.mjs documents` writes the certified stable documents, from the retained input with fixed mode 0644; it refuses a divergent document or mode instead of changing it.
- Archive policy: publish canonical abandon intention before moving exact physically identified children, descriptor last. Resume uses that intention even after descriptor move, without scanning archives; conflicting identities refuse, verified receipt is a no-op. No new run starts without an explicit request. Linter may read only canonical descriptor/intention and their exact archive proof; after archive with no hub/run the missing-index behavior returns.
- Hard links: every path under the area is excluded whatever its link count; a stable file
  that shares an inode with an area file stays stable content; the helper refuses area
  files with more than one link.
- Discovery's inception source: a `complete` run only, read at the exact bound paths, verified
  before the run writes any hub document, and imported once: a later write-back makes the
  certified documents drift. Every decision is approved. Three promotion rules:
  - Approved and verified (`verified`) → may be written as an existing component or rule.
  - Approved but unverified (`unverified`) → written as a design choice, not an existing
    component.
  - A future flow (`future`) → written as context in `conventions.md`, never an implemented
    component, a spec, or a started task.

  Destinations are only `conventions.md`, the routed surface standards, and `glossary.md`:
  no new hub document and no `_INDEX.md` change. The write-back never names the area. Every
  decision in the register is accepted or rejected with a reason.

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
- `manual` (default, absent field) — the human invokes each phase.
- `autopilot` — after the blocking spec gate, the conductor (`scripts/autopilot.mjs`)
  runs plan → implement → review as fresh headless sessions; the collapsed gates become
  non-blocking checkpoints (artifacts still land on disk; the human can interrupt); halts
  on BLOCKED / CONFLICT / an explicit safety condition / a non-zero exit; stops before bump/PR
  (`READY_FOR_PR` — the version-bump/PR decision stays human). Contract = the extended verdict artifact at the
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
  the attributed criteria-only `success-criteria.md`, exact `task-result-index.md` projection (v2 JSON in autopilot; `- Task` bullets in manual drive), and
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
  envelope (manual drive and Gear 4: four fields; Gear-3 autopilot: status/artifact/signals); the implement skill/controller validates it and retains only that
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

**Autopilot task-result versioning.** Every Gear-3 autopilot run pins taskResultProtocol 2 in every manifest;
resume halts on a missing marker after an attempt, another version, or a retained manifest without 2
(finish manually or start fresh). V2 obtains source paths from immutable execution receipts and
projects exact JSON arrays into the task index. A child response carrying changed-paths is malformed.
Semantic status/artifact/signals remain mandatory and never inferred.
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
- **Anti-chatter** — during plan execution, keep between-task updates brief and never
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
  label opt-out), `Release` workflow (idempotent `vX.Y.Z` tag + GitHub Release + Claude
  directory payload commit on merge).
- **Claude directory payload:** the Claude plugin directory tracks the branch
  `claude-directory`, never `main`. Each new version appends one commit built by
  `scripts/publish-directory-branch.mjs`, parented on the previous payload commit and
  never force-pushed. The payload is the release commit's tracked tree minus the
  root-anchored denylist `tests/`, `.github/`, `.codex-plugin/`, `CLAUDE.md`; no file
  content is rewritten, so fixes land on `main` and both channels share them. Why: the
  directory scans the whole plugin folder and puts every version that ships dev files
  referencing images or credential-shaped names into reviewer holds. The payload removes
  those dev-file causes, but the scanner is heuristic and can still raise reviewer holds:
  submit with 0 Blocking and record each remaining hold with its reason. Repository and
  folder are fixed at submission, so this is hard to reverse. The listing's links and
  keywords are also read only once, from the version the submission was created at.
- **Scoping:** this policy governs THIS repo's own automation. The shipped `review`
  skill's bump step self-disables in target repos that lack `scripts/bump-version.mjs`
  + `.github/workflows/version-gate.yml`.

## Release commit messages

Release commits use `vX.Y.Z - <short release summary>` with the same version as the
three manifests, changelog heading, and release tag. Use a concise English summary
without private paths, personal contact details, or internal work references.
The initial public release uses `v1.0.0 - Release Steepy Apex`. Subsequent releases
retain the public history and follow the same message format.

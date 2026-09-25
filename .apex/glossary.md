# Glossary

- **Hub** — the `.apex/` directory; a DAG of markdown rooted at `_INDEX.md`.
- **Surface** — a governed unit of the codebase (e.g. `scripts`), owning a
  standard, a specialist agent, and a routing-table row.
- **Standard** — the non-negotiable rules for a surface: a single
  `standards/<surface>.md`, or the opt-in modular folder `standards/<surface>/`
  (`<surface>-core.md` + leaf docs); see [Conventions](conventions.md) →
  "Modular standards".
- **Surface core** — `standards/<surface>/<surface>-core.md`; the entry file of a
  modular standard: scope, surface-wide rules, the surface test command, and the
  mini-routing table to its leaf docs.
- **Leaf standard** — `standards/<surface>/<surface>-<sub-area>.md`; sub-area rules
  in the same format as a single-file standard. A leaf never contradicts its core —
  the core wins; a contradiction is Drift.
- **Mini-routing table** — the `| Sub-area | When to read it (path/topic) | Doc |`
  table inside a surface core; the bootstrap loads the core plus every leaf whose
  row matches the task (zero matches → core only).
- **Routing table** — the table in `_INDEX.md` mapping surface to standard + agent.
- **Drift** — divergence between the docs the AI reads and the actual code.
- **Adapter** — the Claude-specific glue (the Stop hook) around the portable linter.
  Overloaded: architecture-review notes sometimes use *adapter* in the seam sense
  (a thing satisfying an interface); that meaning is local to those notes.
- **Harness adapter** — a thin, dependency-free integration module under `adapters/`
  (plus the per-harness packaging manifests it serves) that wires the canonical skill
  source into one harness: skill discovery, invocation ergonomics, bootstrap injection.
  Never workflow behavior — that lives in the core. Distinct from the Stop-hook
  *Adapter* above.
- **Engine root** — the installed package's base directory, holding `skills/` and
  `scripts/`. Skills resolve it relative to their own base directory (a skill at
  `<engine-root>/skills/<name>/` reaches engine scripts two levels up, at
  `<engine-root>/scripts/`); harness plugin-root env vars naming it belong to
  packaging, never to core prose.
- **Canonical skill source** — the single `skills/` tree served verbatim to every
  harness; no second in-repo skill copy may exist. Adapters and manifests are wiring,
  not copies.
- **Open SKILL.md subset** — the frontmatter fields the harnesses that parse SKILL.md
  natively (Claude Code, Codex, OpenCode, Pi) read: `name` + `description`. Claude-only
  extras (`user-invocable`, `argument-hint`) ride along only while verified tolerated by
  the other three (Codex, OpenCode, Pi). DeepSeek Harness parses no frontmatter at all —
  the whole file reaches the model as opaque prose — so neither claim applies to it.
- **Work artifact** - local planning or execution material under `.apex/work/`;
  intentionally not part of the versioned hub DAG.
- **Work-input capability** — a phase-local, default-deny authorization to read a work
  artifact. It comes only from an exact path in the active handoff, bounded
  workflow-header recovery for a pathless invocation, or an explicit user-delimited
  work-area scope; it does not grant general `.apex/work/**` access and does not pass
  implicitly to child agents.
- **Manual handoff envelope** — the human-mediated transport for the same phase inputs,
  outputs, status, and provenance semantics used by autopilot. It is model-enforced from
  the active handoff rather than backed by a manifest, parser, or validator.
- **Workflow artifact state** — the lifecycle of a phase artifact: `DRAFT` while its
  producer is still writing or checking it, `READY` after the producer has recorded its
  inputs and verified it, and `CONSUMED` after the authorized next phase records the
  artifact it used. Producer and consumer provenance must point to one another; no phase
  substitutes a most-recent artifact for that recorded relationship.
- **Durable decision** - a decision that should survive the current implementation
  run and therefore belongs in a stable versioned document.
- **Gear** — the ceremony level (1–4) a gear-aware workflow assigns a task from coverage ×
  value; see [Conventions](conventions.md) → "Decision model". Gear 1 goes straight to
  the specialist agent, gear 2 adds a light spec then short-circuits directly to implementation
  (with an opt-in light plan only when decomposition is needed), gear 3 runs the full brainstorm →
  plan → implement → review chain, gear 4 is the autonomous loop mode executed by
  `/steepy-apex:loop-engineer`.
- **Coverage verdict** — a gear-aware workflow's ruling on whether the hub already decides a
  task, each with `file:line` evidence: COVERED (a rule decides it), CONFLICT (a rule
  contradicts the change), or GAP (nothing decides it). Feeds the gear; see
  [Conventions](conventions.md).
- **Repair mode** — the non-destructive re-scaffold path (`new-surface.mjs --repair`,
  and `init`'s repair mode): creates only the missing half of a half-scaffolded surface
  (standard or agent) and leaves existing files byte-for-byte untouched.
- **Progress ledger** — execution state for an `implement` run at
  `.apex/work/tasks/<plan-basename>/ledger.md`, with per-task brief/diff files in the
  same folder. It is a work artifact under `.apex/work/`, excluded from the hub linter
  like all work artifacts.
- **Managed block** — the `<!-- steepy:start -->` / `<!-- steepy:end -->` marker pair
  delimiting the auto-generated nav section inside a target repo's root `CLAUDE.md`;
  re-rendering replaces only that region and preserves the surrounding user content.
- **Managed root spine** — the managed common-instruction block in a target project's
  `AGENTS.md`. It is the sole common rule source; `CLAUDE.md` imports it through a thin
  managed wrapper.
- **Generated artifact provenance** — the v1 marker carried by an entirely generated
  scaffold artifact. It identifies the generated artifact type without claiming ownership
  of bytes outside a mixed-artifact managed block.
- **Project scaffold plan** — the validated, public preview from `project-scaffold.mjs`:
  exact create/update/no-op operations plus conflicts that require an explicit offered
  resolution before apply.
- **Project scaffold conflict** — a preflight result where a target's existing
  user-owned or incompatible content cannot safely be replaced. The planner reports it;
  it never silently chooses a semantic resolution.
- **Fixture** — a committed, read-only test double under `tests/fixtures/<name>/` (e.g.
  `good-hub`, `bad-hub`, `pnpm-mono`), as opposed to an ephemeral per-test `mkdtemp`
  directory.
- **Hermetic** — of a test: writes only into a per-run temp directory, never into the
  checked-out repo.
- **Dogfood test** — a suite that runs the real engine against the project's own live
  `.apex/` hub (not a fixture), proving the shipped hub stays coherent
  (`tests/dogfood-hub.test.mjs`).
- **E2e smoke** — a suite that chains several engine scripts to reproduce a whole user
  workflow end-to-end (e.g. `/steepy-apex:init`) rather than unit-testing one script
  (`tests/e2e-smoke.test.mjs`).
- **Anti-orphan check** — the validate-hub rule that every stable `.apex/**.md` except
  `_INDEX.md` must be transitively reachable from `_INDEX.md` via relative links
  (`validate-hub.mjs`).
- **Forward routing check** — every `standards/<surface>.md` link inside a routing-table row of
  `_INDEX.md` must resolve to an existing file (`validate-hub.mjs`).
- **Reverse routing check** — every agent file under `.claude/agents/` must appear as a
  backtick token in a routing-table row of `_INDEX.md`; prose mentions don't count
  (`validate-hub.mjs`).
- **Code anchor** — a machine-checkable fact a stable doc states about the
  codebase: a cited path, an owning-surface directory, a surface test command.
  Absent anchors are never violations — only present-and-dead ones are.
- **Code-anchor check** — checks 9–12 of `validate-hub.mjs`: dead backtick path
  citations, a missing owning-surface directory, an unreal surface Testing
  command, and broken root `AGENTS.md` links. Check 9 debuts at `warn` with
  promotion deferred pending field experience.
- **Warn** — the non-blocking `validate-hub` level: printed on explicit runs, silent
  under `--quiet`, never changes the exit code (today: a `standards/**` file over
  150 lines or a checkable code-anchor citation that resolves nowhere).
- **Chain skill / Standalone skill / Pre-hub skill** — the three skill families of the ten
  canonical skills: the chain — five (brainstorm → plan → implement → review, plus
  `loop-engineer` for gear 4) — gear-aware, checklist-carrying; the standalone hub-aware skills
  (`init`, `new-surface`, `check`, `discovery`); and the pre-hub `inception` skill, which needs no
  hub, has no gear, and hands an approved, verified bootstrap to `init`.
- **Inception run** — one pre-hub run of the `inception` skill: starting materials → approved
  project → verified bootstrap → transfer to `init`. Its files live in `.apex/inception/<run-id>/`,
  ignored by Git from the start and outside the hub DAG.
- **Inception descriptor** — `.apex/inception/state.json`, the one canonical v1 record of the active
  run (`schemaVersion`, `runId`, `phase`, `status`, `approval`, `checkpoint`, `init`). It classifies
  pre-hub state and the transfer to `init`; it never proves approval or a valid hub.
- **Approved project** — the project write-up an inception run's human approves once, before
  bootstrap; the approval record binds the exact digests of that approved text. A later substantial
  change (database, boundaries, flows, design, deploy, a foundational technology) needs a targeted
  decision and a new approval at a new path, never a silent edit of the approved bytes.
- **Representative path** — the one flow an inception project chooses that crosses its agreed
  boundaries end to end; it is what bootstrap actually builds and verification actually runs. Other
  flows stay recorded context, never implied components.
- **Verified result** — one checked fact in an inception run's `verification.md`: environment, exact
  command, reference output, and a result kept distinct as `configured`, `executed`, `succeeded`,
  `not-executed`, or `failed`.
- **Deferred flow** — a flow from an inception run's starting materials that falls outside its
  representative path. It is promoted only as recorded context in `project-context.md`, never as an
  existing component, a spec, or a started backlog item.
- **Inception handoff** — the `inception-handoff: steepy-apex/v1` transfer to `init`: the fixed
  descriptor path `.apex/inception/state.json` for `state`, plus exact run paths for `approval`,
  `project`, `verification`, `confirmed-inputs`, `promotion`. It is separate from the chain's
  `handoff: steepy-apex/v1`.
- **Promotion table** — the per-decision outcomes of an inception handoff: promote (a stable
  destination and the exact text) or exclude (stays local, with a reason).
- **Init receipt** — the local record `init` keeps for an inception transfer: accepted input
  digests, one outcome per decision, the write digests of each destination, and the gate result.
  Init is complete only with a complete receipt.
- **Loop Engineer** — the gear-4 mode (an autonomous bounded loop over a
  machine-verifiable goal) and the human role that exercises it: designs the
  goal/verifier/budget up front instead of gating per turn; executed by
  `/steepy-apex:loop-engineer`.
- **Goal contract** — `.apex/work/loops/<YYYY-MM-DD>-<slug>/goal.md`: the exact human-ratified
  Gear-4 verdict artifact at the run's head, `READY` and containing `goal`, `surface`, `verifier`, `mode`, optional metric-only
  `metric-direction`, `budget`, `blast-radius`, and `notes`. Controller-owned commit authorization
  is a separate mandatory human decision at invocation and is persisted in `RUN_STARTED`. After
  any clean reviewed outcome the controller changes the goal to `CONSUMED`; it is never reopened.
- **Workflow event log** — the strict versioned append-only `events.jsonl` for one deterministic
  run. It is the authoritative state source for correlation, replay, resume, reconciliation,
  review, and terminality; malformed, truncated, reordered, or impossible histories fail closed.
- **Loop ledger** — `ledger.md`, next to the goal contract; the human-readable deterministic
  projection of validated workflow events plus the baseline sanity-verifier result. It may be
  regenerated when absent or stale and is never the state authority.
- **Attempt reservation** — the durable `ATTEMPT_RESERVED` event that consumes the next contiguous
  mutation-budget identity before runner dispatch, create-only attempt evidence, or side effects.
  Resume advances past an interrupted reservation instead of reusing an attempt or its paths.
- **Keep/discard** — the verifier policy after an owned attempt. In boolean mode, red means `KEEP`
  and the controller commits before another attempt; green means `GOAL_REACHED`. In metric mode,
  only a strict improvement over the best value is kept and committed; a non-improvement is
  discarded (reverted) to its controller-owned parent. The attempt and durable intent are recorded
  before either Git side effect.
- **Verifier** — the deterministic command run once for the baseline and again after owned attempt
  changes pass the blast-radius check. Boolean mode uses exit 0 as green. Metric mode requires exit
  0 and parses the last line of stdout as a canonical finite scalar; it is never a model judgment.
- **Reconciliation-required halt** — the fail-closed recovery state for ambiguous controller
  ownership or replay evidence. The controller appends `RECONCILIATION_REQUIRED` and then
  `RUN_HALTED`, leaves the ledger `DRAFT`, and requires explicit human recovery instead of resetting
  or cleaning uncertain work.
- **Clean terminal outcome** — one reviewed, event-authoritative end state: `GOAL_REACHED`
  (verifier acceptance and approved review), boolean `BUDGET_EXHAUSTED`, metric
  `NO_IMPROVEMENT`, or `REVIEW_REJECTED` when issues remain with no mutation attempt left. Only
  `GOAL_REACHED` sets goal success; `HALTED` is not a clean terminal outcome.
- **Drive mode** — gear-3 axis: who pushes the button between chain phases. `manual`
  (default) = the human invokes each skill; `autopilot` = the conductor does, between
  the blocking spec gate and the human bump/PR gate; see [Conventions](conventions.md)
  → "Drive modes (gear 3)".
- **Autopilot contract** — the extended verdict artifact at a spec head: verdict + gear
  plus `drive`, `branch`, `commit-auth`, `harness`, `blast-radius`. The pre-authorization a
  gear-3 autopilot run executes under. The `budget` field is rejected on both fresh and resumed
  gear-3 contracts; healthy work has no fixed resource stop condition. This does not change the Gear 4 goal contract's iteration
  `budget`.
- **Context manifest** — the deterministic, versioned, role-local input inventory written by the
  conductor before an autopilot dispatch. It identifies the correlation, role and scope, eagerly
  required artifacts, and `onDemand` facts; a child validates it before any other task input and
  records each justified `onDemand` read. It controls eager upstream context, not repository access:
  code discovery and source reads needed for implementation, tests, and verification remain normal.
- **Artifact-first completion** — the child-completion protocol: write the detailed, durable
  report first, then return exactly `status`, `artifact`, `changed-paths`, and `signals` to the
  parent. The parent retains the four-field envelope, opening the artifact only for a decision or
  action; no report body or transcript is copied into controller context.
- **Resource-usage ledger** — an observational JSONL ledger scoped to one run, phase, and attempt.
  It records direct provider usage evidence with source provenance and one canonical measurement
  per event, so summaries cannot double-count it. It informs efficiency analysis only; it never
  imposes a healthy-work quota or stop condition.
- **Conductor** — the deterministic engine script (`scripts/autopilot.mjs`) that runs
  the gear-3 chain phases as fresh headless sessions under an autopilot contract,
  halting on anything that needs a human.
- **Event bridge** — the normalization, persistence, and rendering boundary that carries
  harness streams into source-grounded events and user evidence.
- **Agent task events** — decoded subagent lifecycle events (`agent.started`, `agent.completed`,
  `agent.failed`) mapped from harness task streams (Claude system/task_started →
  `agent.started`, system/task_notification → `agent.completed` or `agent.failed`). They carry
  actor `subagent`, `actorId` = `subagent_type`, `metadata.taskId`, and a completion `status`, and
  are the event evidence behind an `agentIdentity` capability promotion. They must never be the
  bare `completed` event, which the usage observer keys on.
- **Native session identity** — a stable harness ID emitted by the source, distinct from a
  display name, session discovery, open/resume support, and parent linkage.
- **Observability capability** — an independently declared `yes`, `unavailable`, or `unproven`
  claim, backed by implementation and evidence; it is never inferred from a flag alone.
- **Verdict artifact** — the `(verdict + gear)` header at the head of a work spec (or the
  `.apex/work/` log line for gear-1 work, or of a gear-4 goal contract) that every chain
  skill reads in its Step 0. In gear-3 autopilot it extends, symmetrically with the
  gear-4 goal contract, into the Autopilot contract above.
- **Task brief** — the per-task requirements file
  (`.apex/work/tasks/<plan-basename>/task-N-brief.md`) handed verbatim to the implementer
  subagent.
- **Implementer status** — the `DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT` enum
  an implementer returns; the orchestrator dispatches on it.
- **Reviewer status** — the `Approved | Issues Found` enum a code reviewer returns;
  `Issues Found` drives the fix loop.
- **Human gate** — mandatory user approval of a written prose artifact (spec/plan) before
  the chain proceeds in manual drive; in gear-3 autopilot the plan gate collapses to a
  non-blocking checkpoint (the contract carries the pre-authorization); see
  [Conventions](conventions.md) → "Review architecture (gear 3)" and "Drive modes (gear 3)".
- **Item card** — the unit of a discovery explorer report: proposed doc text + `file:line`
  evidence with excerpt + occurrences (N=1 marked `isolated precedent`) + why it matters;
  what the user decides accept / correct / skip on in the seeded interview.
- **Write-back preview** — the exact rendering (text + destination doc/section) of what
  accepting a discovery item would write, shown before the decision; corrections re-render
  it, and the write-back copies it verbatim.
- **Hub-version stamp** — the `<!-- steepy-hub-version: N -->` first line of `_INDEX.md`;
  copied verbatim (not a placeholder). `init`'s repair mode adds it as the first line only
  when an existing `_INDEX.md` predates it, and otherwise leaves the file untouched.
- **Code-rendered / agent-rendered template** — the two substitution paths for
  `templates/*.md`: code-rendered (`CLAUDE.md`, `surface-standard.md`, `surface-agent.md`)
  filled by `renderTemplate`, which throws on an unknown placeholder; agent-rendered
  (`_INDEX.md`, `routing-row.md`, `bootstrap-skill.md`) filled by the `init` skill's
  prose, with no code-level guard.
- **Content-byte-lock** — a canonical string constant embedded in a test and asserted
  byte-identical across N target files (e.g. `MODEL_SECTION_WITH_REVIEW` /
  `MODEL_SECTION_WITHOUT_REVIEW` across the five chain SKILL.mds in
  `workflow-skills.test.mjs`), so any drifting copy fails the suite
  immediately — sharper than a file-level doc-content-lock.
- **Release** — a version bump merged to main plus its automatic `vX.Y.Z` tag and GitHub
  Release, created idempotently by the `Release` workflow; see [Conventions](conventions.md)
  → "Versioning & release".
- **Version bump** — the commit updating all three manifests in lockstep (`package.json` +
  `.claude-plugin/plugin.json` + `.codex-plugin/plugin.json`, via `scripts/bump-version.mjs`)
  plus the matching `CHANGELOG.md` section; made in-branch at PR time (`review` skill) or
  on main via the push-guard prompt.
- **Tier agents** — the registered OpenCode subagent trio `steepy-cheap` /
  `steepy-standard` / `steepy-most-capable`: per-dispatch model choice (D2) by dispatching
  the agent by name, their concrete models drawn from the session provider's tier rows via
  a pinned `config.model`; without a mapped pin the trio is not registered and dispatch
  degrades to the session model (declared degradation). Registered hub surface agents are
  agent-static (frontmatter tier); on a tier mismatch, dispatch degrades to the matching
  `steepy-<tier>` agent with the specialist prompt inlined, declared in the ledger
  (specialist-prompt degradation).
- **Provider-keyed model mappings** — the shared provider → tier → concrete-model table
  (`adapters/model-mappings.mjs`), every row carrying per-row provenance (`source` +
  `verifiedAt`); freshness is verified by script (`scripts/verify-model-mappings.mjs`)
  and updates land only as human-ratified patches, never silently at runtime.

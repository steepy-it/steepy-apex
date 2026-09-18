# skills — Technical Standard

> Owning surface: `skills`. Read this before editing `skills`.

## Scope
- Owns: slash-command `SKILL.md` files and co-located prompts under `skills/`, including implementer,
  task/final reviewer, discovery explorer, and `skills/loop-engineer/loop-implementer-prompt.md` plus
  `skills/loop-engineer/loop-final-review-prompt.md`. The five chain skills
  short-circuit Gear 2 through brainstorm → implement, run Gear 3 through brainstorm → plan →
  implement → review, and assign Gear 4 to `loop-engineer`; standalone hub-aware skills are `init`,
  `new-surface`, `check`, and additive/re-runnable `discovery`. Chain skills carry gear-0, a checklist,
  and the locked Model Selection block; `discovery` has its own prose dispatch policy; the rest do not dispatch.
- Does NOT own: the engine scripts they call (→ `scripts`) or the markdown templates they copy
  (→ `templates`).
- Exemplar: `skills/init/SKILL.md`

## Conventions
- Each `SKILL.md` has YAML frontmatter (`user-invocable: true`) plus deterministic gates; the
  five chain skills (brainstorm/plan/implement/review/loop-engineer) additionally carry a
  `## Checklist`.
- Skills are hub-aware: read the `_INDEX.md` routing table, write governed
  artifacts under `.apex/`, keep the graph coherent.
- Reviewer dispatch uses abstract model tiers, translated to a concrete model at dispatch time per
  harness (single canonical source: the Model Selection block); weigh **turn count, not just
  token price** (mid-tier is the floor for reviewers and prose-fed implementers); never hardcode
  concrete model ids in reviewer prompts.
- Gear-3 subagent reviewers run only on the code diff (`task-reviewer`, `final-review`); spec/plan
  use self-review + a human gate and `review` self-verifies — see `conventions.md` → "Review
  architecture (gear 3)". `task-reviewer` is conditional on non-mechanical tasks.
- `review` collects command evidence inline through `capture-review-evidence.mjs`, never through an
  LLM collector. The complete combined stdout/stderr transcript stays in the canonical current-run
  `evidence-report.md`; model context receives only the script's bounded receipt. A reviewer may
  read a minimal exact range from that artifact only for a named missing fact, never preload it.
- `plan` cuts each task only when its diff is knowable in advance: a task is **mis-cut** if its
  implementer must discover what to change — its requirements stated only as a goal ("make X
  work," "write the section on Y") rather than a sketch of the diff to exact paths. Split the task,
  or add a discovery task upfront whose deliverable is the missing facts, before handoff.
- An argument-taking skill declares `argument-hint:` in its frontmatter (`new-surface`).
- Engine scripts are invoked as `node <engine-root>/scripts/<x>.mjs`, resolved relative to the
  skill's own base directory — never a machine-specific absolute path or a `CLAUDE_*` env var
  (`conventions.md` → "Multi-harness distribution").
- Gear-4 has a hard engine/skill boundary. `loop-engineer` validates the exact fresh/resume capability and complete ratified goal, reads stable routed inputs, selects an active harness with a supported `adapters/headless.mjs` mapping, asks once for controller-owned commits (both modes require yes), and invokes `node <engine-root>/scripts/loop-engineer.mjs --repo-root . --goal ... --harness ... --commit-authorized`, adding `--resume --ledger ...` only for an exact authorized resume.
  The script owns attempts, immutable event state, verifier policy, Git, blast radius, fixed mutation budget, final branch review, lifecycle, and terminal outcome; the skill never interprets ledger Markdown as state, grants extra fixes, or offers an inline fallback, and may only report output plus emit the exact terminal `goal` + `loop-ledger` handoff.
  Its terminal result carries an explicit validated-terminal bit and exact paths, so the skill never reopens Markdown lifecycle. Gear-4 review preserves the public `goal` + `loop-ledger` capability while the script's exclusive read-only `--validate-terminal` mode safely derives and replays private events, authenticates the complete projection, makes no Git/lifecycle mutation, and returns bounded branch-review, attempt-budget, and goal-candidate facts.
  A `HALTED` result is a permanently abandoned run, never an exact-resume handoff; preserve all of its state and recover only with a new ratified goal at a distinct goal path and loop workspace.
- Project setup retains one immutable user-confirmed interview record, derives the planner's exact
  five-key Project model v1, and applies preview → conflict resolution → zero-conflict preview → apply.
  Init/repair share this path; conflict prompts expose only planner choices and a second repair is a
  byte/mode/mtime no-op. Surface scaffolding separates unbound preparation from active-v1 addition;
  the latter uses the public planner to keep root, routing, create-only standard, and specialist triad
  coherent. Planner-owned provenance resolves the canonical project bootstrap, which owns navigation
  only; workflow skills retain coverage, gear, ratification, branch, and state decisions.
- General workflow subagent dispatch is conditional on the harness (D1): with a task/subagent tool, reviewers/explorers use neutral roles and implementers use the bound `<surface>-agent`, one in flight at a time;
  otherwise the orchestrator runs the prompt inline and records degradation. Prompt templates use the fenced `Subagent (...):` schema, write full reports to files, and return terse status.
  Gear-4 is the exception: its packaged controller selects a supported headless runner and dispatches the loop prompts; runner-unavailable fails closed without inline degradation.
- Prompt templates carry an abstract tier in `model:` (`standard`, `most-capable`, or the Gear-4 controller's `[MODEL_TIER]` placeholder); the dispatching skill, orchestrator, or Gear-4 controller translates it to a concrete available model.
  Never paste a concrete model id into a real dispatch.
- Work-input access is default-deny for every workflow phase. An active handoff grants only its
  exact work-artifact paths; a pathless invocation may perform bounded workflow-header recovery
  discovery only, and stops for a human handoff if it cannot recover one unambiguously. A user may
  explicitly delimit a broader work-area scope. No role chooses a most-recent artifact, and a
  parent capability never implicitly passes to a child.
  Autopilot self-contained briefs pair with role-local manifests. A child reads its manifest first,
  eagerly loads only `required` inputs, obtains an `onDemand` item only for a named missing fact,
  records that justification, and writes its durable artifact before returning the selected response envelope below.
  Manifests govern eager upstream context, not normal repository source discovery.
  The implement skill/controller validates artifact-first completion and the envelope. The implement handoff writes the aggregate diff only as `branch-diff.txt`. Manual drive and legacy autopilot protocol 1 record each task-result bullet as
  `- Task <id>: <DONE|DONE_WITH_CONCERNS>; artifact: <path>; changed-paths: <paths|none>; signals: <IDs|none>`,
  then verifies that index against the plan before claiming completion — a skill never hands a
  downstream deterministic gate an artifact it has not parsed itself.
  The plan skill likewise runs the engine's canonical `--verify-plan` parse before autopilot `DONE`.
  The implement controller resolves each task's exact standard paths from manifest-declared routing
  evidence: a single standard, or a modular core plus every mini-routing leaf matching the task's exact
  paths/topics. It repeats `--standard` for the selected set and never manufactures
  `.apex/standards/<surface>.md` or loads unrelated leaves. Plan matches every required modular
  core against the required spec's exact paths/topics and records a concrete reason while reading
  every matching leaf from `onDemand`. Review matches every required modular core using only the
  criteria-only artifact, task-result index, and branch diff, then records a concrete reason while
  reading every matching leaf from `onDemand`; it never consults spec, plan, or ledger for that
  match. Both phases keep core-only context when zero leaves match and never use a read-all-leaves
  fallback. Manifest-backed implement and review take verdict/gear/drive only from scalar contract
  metadata, without an undeclared full-spec read. In manual drive, no manifest, parser, or validator
  is introduced: the model follows the human handoff envelope and performs the same phase-local
  role transition and provenance recording. Its pathless recovery is limited to the workflow header
  needed to locate its entry artifact; it does not retain the former manual spec-head default.
  Fresh brainstorm uses human/stable repository evidence, not historical work, and follows actual single/core-plus-matched-leaf routing. Manual implement has two mutually exclusive entries: Gear-2 direct entry requires an exact `spec`,
  while plan-backed entry requires exact `plan` and exact `source-spec` capabilities. Direct Gear 2
  accepts only a READY brainstorm artifact with `next: implement` and recorded gear 2, derives one
  independently testable task, and stops before mutation for an optional plan when decomposition is
  required. Resume requires exact `progress-ledger` and `task-results` capabilities; fresh-run output
  creation remains allowed when neither derived artifact exists.
  Skills route abstract tiers; adapters, not skill prose, apply or degrade concrete models.
- The chain skills carry one byte-identical workflow-header grammar whose phase domain is `phase: <brainstorm|plan|implement|review|loop-engineer|goal-contract>`; `goal-contract` is the producer-facing Gear-4 identity consumed by `loop-engineer` and checked by Gear-4 `review` provenance.
- Manual drive and legacy autopilot protocol 1 artifact-first child results emitted by the implement controller and its three prompt templates share this exact ordered four-field shape: `status`, `artifact`, `changed-paths`, `signals`. Status domains and placeholder text are role-specific and are not byte-identical. Implementer and fix roles use `DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`. Reviewer roles use `APPROVED | ISSUES_FOUND | BLOCKED | NEEDS_CONTEXT`.
  Each emitting prompt may specialize placeholder text while retaining those field names in that order. The loop prompt templates use closed artifact-first envelopes in the exact ordered four-field shape; their immutable reports carry detail, while the final reviewer returns `status: DONE` plus `signals: approved | issues-found`.
  The common completion grammar below specifies the implementer specialization; it does not assert cross-role byte identity:

  ```text
  status: <DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED>
  artifact: <repo-relative path>
  changed-paths: <comma-separated repo-relative paths or none>
  signals: <short IDs or none>
  ```

- Task-reviewer `ISSUES_FOUND` points directly to `task-N-issues.md`; a review-file link is not
  a substitute. Malformed envelopes still fail closed without task completion. Gear-3 autopilot uses the
  reviewer-response gate before trusting any reviewer result. In protocol 1, authorized review artifacts are excluded from `changed-paths`, which is literal `none`. One changed-paths-only correction requires a correlated reservation, valid unchanged verdict/artifact/signals, independent Git-state verification, and frozen report bytes. Task/final receipts bind the result index and full plan contract; active references use bind-reference rather than duplicate appends. The conductor verifies retained approvals before phase acceptance without rerunning review. Resume never replenishes the budget or repeats implementation.
- Fresh Gear-3 autopilot runs pin `taskResultProtocol: 2`; retained legacy runs stay on protocol 1. `skills/implement/task-results-protocol.md` takes precedence over legacy four-field examples only for v2: implementer/fix and reviewer responses contain status, artifact, signals. Legacy extra changed-paths is raw-only telemetry, never path authority or a reason for path-only correction. The controller records an exact execution state in its authorized ledger before each writer, begins/captures immutable source and report receipts, and generates the JSON task-index projection. A saved execution resumes review-pending without reimplementation; baseline-only state cannot establish completion. Fixes bind same-task previous state and the latest global parent state. Valid captured NEEDS_CONTEXT/BLOCKED can continue only through a new retry execution after a recorded remedy, retaining all earlier evidence; malformed/baseline-only results cannot. Retry uses the original task-manifest role and a fresh task-N-retry-E.json path. Every ancestor must match its phase manifest provenance. Task reviews bind the latest execution, so fixes require fresh approval when an old proof is obsolete. Only schema-authorized exact receipt links grant confined machine replay; outputs do not grant generic work reads and children never inherit receipt-body access. Source discovery stays normal. Never fabricate a historical baseline, silently upgrade, or change manual/Gear-4 grammar.
- Each chain skill keeps a phase-local role map: in Gear 2, `brainstorm` produces a READY spec
  directly for `implement`, and an explicitly requested light plan may still insert `plan`; in Gear
  3, `brainstorm` produces a READY spec for `plan`, `plan` produces a READY plan for `implement`,
  `implement` produces READY execution evidence for `review`, and `review` produces its READY
  verdict for the terminal human handoff. Gear-2 `implement` instead self-verifies the success
  criteria, runs surface tests plus `validate-hub`, publishes its terminal READY index before
  consuming the accepted spec/plan, and repairs that sole intermediate prefix from exact resume
  capabilities without a review-phase handoff. Plan and regular review add exact on-demand output-plan and review-report capabilities for resume; every regular phase publishes verified output READY before input CONSUMED. Exact-pair proof permits only READY/READY consumption repair or CONSUMED/READY no-op, never a most-recent fallback. These are model-based instructions, not deterministic manual enforcement. A producer
  records the exact inputs and verification that move its artifact from `DRAFT` to `READY`; the
  authorized next phase records that READY artifact when it moves to `CONSUMED`. These two records
  identify one another, so both manual and autopilot preserve bidirectional provenance despite their
  different transports. `review` never auto-continues past its terminal human handoff.
- Completed unplanned discovery requires DONE_WITH_CONCERNS plus exact `discovery:unplanned`, retained through fixes and the compact index; v2 non-success responses preserve earlier discovery through explicit retries; ordinary/unattributed concerns are not discovery. Review uses only criteria/index/diff for both insight attribution and regular bump proposals; insufficient evidence goes to the human, not upstream reads. Discovery's explorer completion is self-contained in its Output Format heading, never borrowed through numeric schema anchors.
- Gear-4 terminal review validates lifecycle, goal/event digests, branch review, attempt budget, surface test, verifier, and hub gate from exact `goal` + `loop-ledger` inputs plus the engine's closed read-only receipt. `REVIEW_REJECTED` additionally requires boolean green or metric strict improvement, never red/equal baseline. `GOAL_REACHED` alone is success; the three negative outcomes are reviewable completion that may consume the ledger but never release/PR and require a new ratified goal.
- Gear-4 terminal proof authenticates event-bound reviewer report and diff digests, the final branch-diff projection, and the current branch, HEAD, clean snapshot before exposing receipt facts. Boolean candidate facts follow the retained branch: committed attempts update them and discarded attempts do not. Controller branch-review approval is distinct from later terminal-review approval; faithful negative completion can pass terminal review without becoming goal success.
- Gear-4 loop dispatch resolves exactly one target-project routing row and carries its ordered stable standard inventory through the controller CLI into both child prompts: one registered file, or modular core plus only matching leaves in table order (core only on zero matches). It never synthesizes a standard path. The controller records its explicit abstract model tier and applied/degraded descriptor result in event evidence. Terminal review is the sole owner of the mandatory `validate-hub.mjs .` coherence gate; the loop controller does not claim or duplicate it.
- Machine-relevant prose uses a canonical Markdown contract: specs separate owning and cross-cutting
  surfaces, require `Feature complexity`, and contain one `## Success criteria` H2 with sequential `SCn` IDs; plans use
  `## Task <positive integer>` boundaries and the exact `Success criteria` field. Parsers accept only
  documented equivalent emphasis of the canonical `Surface` and `Success criteria` fields, and
  fail closed on absent IDs. Every H2 Task-like heading is validated before task parsing, so malformed
  mixed headings cannot disappear. Task IDs are unique positive safe integers without leading zeroes,
  in strictly increasing order.
  Review requires set equality between plan task IDs and result-index IDs.

## Anti-patterns
- Specs and plans live only under `.apex/work/` (gitignored local artifacts) — never register
  them in `_INDEX.md` or create a specs/plans sub-index.
- Never omit `model:` when dispatching a subagent — an omitted model inherits the expensive
  session model and defeats the tier policy.
- Never hardcode a concrete model id in a reviewer prompt — map tier → a concrete model at
  dispatch time.
- Repair mode stays non-destructive — create-only / append; never overwrite an existing hub file.
- Never DRY the per-skill Model Selection or gear-0 ("Read the gear") blocks into a shared file —
  only one SKILL.md loads per invocation, so a shared reference adds a read instead of saving tokens.

## Testing
Narrowest validation that can falsify a change here:

```sh
node --test tests/workflow-skills.test.mjs
```

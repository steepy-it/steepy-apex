# Architecture

How the plugin is built. Read this to contribute or to understand the machinery; day-to-day usage is covered by the [README](../README.md).

steepy-apex is a multi-harness plugin — one canonical core installed natively in Claude Code, Codex, OpenCode, Pi, and DeepSeek Harness — with **zero runtime dependencies**: every script and adapter runs on Node.js built-ins only (Node >= 24).

## Command-family effects matrix

Filesystem reads–writes–subprocesses–temporary state–providers/network are not one global permission claim. Local validators read a repository while scaffolders and version transactions write it; observability may read a configured session store; review and controller workflows run tests, Git, and supported harness subprocesses with confined work state; release-evidence validation runs Git and `npm pack --dry-run` with a temporary cache but never a provider; live model-mapping verification can contact OpenCode/provider provenance; installation and native canaries use the selected host's cache, credentials, and network. Configured hooks describe wiring, while dated observations remain version-specific evidence rather than a current-runtime guarantee.

```
steepy-apex/
├── .claude-plugin/      # Claude Code plugin.json + marketplace.json
├── .codex-plugin/       # Codex plugin.json (skills, hooks, interface)
├── .agents/plugins/     # marketplace.json — the repo as a Codex marketplace root
├── adapters/            # OpenCode plugin + Pi extension + dsh (DeepSeek Harness) plugin (thin, zero-dep wiring)
├── skills/              # the 10 skills — the canonical, harness-neutral core
├── scripts/             # Node executables the skills and hooks invoke
├── templates/           # the markdown the scaffolders render into a repo
├── hooks/               # hooks.json (Claude) + hooks-codex.json — Stop-hook wiring
└── tests/               # node --test suite + fixtures
```

## `scripts/` — the engine

Pure Node, no dependencies. The skills and the hook shell out to these.

| Script | Responsibility |
|---|---|
| `reviewer-response.mjs` | Gates Gear-3 reviewer responses with Git snapshots, version-selected envelopes, one changed-paths-only correction for legacy v1, and replay-validated receipts. V2 uses semantic fields and binds task approval to its latest execution digest. The conductor requires task/final proof bound to the full plan contract and handoff, and verifies every execution ancestor against its exact phase manifest before accepting implementation. Retained approval keeps its original identity; active references advance atomically without rewriting history. Under controller protocol 2 the controller dispatches and gates reviewers itself with reviewer response protocol 3 (a two-field verdict and at most one format correction); in legacy controller protocol 1 the implement skill owns dispatch. |
| `source-observation.mjs` | Observes branch, HEAD, index, tracked and nonignored untracked source using exact Git filenames; validates source paths separately from work artifacts and detects source continuation/drift. Unsupported submodules fail closed. |
| `task-results.mjs` | Begins and captures immutable v2 task executions, freezes reports, resumes durable captured results without writer redispatch, projects JSON task indexes, and verifies lineage, all task reports, and current source. Same-task previous execution and latest global parent are separate links. Legacy runs use explicit retry executions to continue valid NEEDS_CONTEXT/BLOCKED results after a remedy while preserving partial work, and controller protocol 2 halts instead; malformed or ambiguous evidence cannot authorize retry. |
| `autopilot-plan.mjs` | Parses complete controller v2 plan tasks against routed agents and explicitly selected standards, renders self-contained task briefs from the task fields, annotated exact paths, task notes, and declared spec-section capabilities, and validates whole-branch finding-to-task fix targets. |
| `autopilot-context.mjs` | Builds and validates versioned role-local context manifests, materializes the criteria-only review artifact, derives routed standards, and exposes strict plan/handoff verification commands. |
| `autopilot-runtime.mjs` | Loads selected-engine scripts, adapters, skill instructions, version manifests, and mapping bytes; fingerprints their ordered paths and content and verifies that identity on resume. |
| `autopilot-state.mjs` | Defines the separate Gear-3 controller event domain, validates and replays its authoritative journal, binds immutable run and role reservations to journal prefixes, checks captured responses and role-specific accepted receipts (including immutable phase proofs), and renders a replaceable status projection. |
| `autopilot-controller.mjs` | Drives a controller-protocol-2 Gear-3 run under the conductor's existing lease. Protocol 2 is the default for a fresh run: `--controller-protocol 1` still starts a legacy run, and existing state keeps its recorded protocol. Reserves each plan, writer, reviewer, correction, and review role in the authoritative journal, publishes its immutable manifest, dispatches it through an injected role runner, and captures the response before any gate. Validates it through the existing plan, task-result, reviewer, and review-evidence gates; owns task commits and READY/CONSUMED publication; and resumes only from durable evidence, halting on a reservation without a captured response. |
| `autopilot-recovery.mjs` | Validates the exact `recovery-input.json` of a new recovery run against a halted legacy Gear-3 run, through an `inspect`/`prepare` CLI. The input declares the source spec, plan, phase manifests, and execution receipts with their digests, the tasks to reuse, the accepted current branch/HEAD/observation and delta, and the new destinations. Inspect classifies each plan task as an import with a pending review or as residual work, and reports drift, an unexplained delta, foreign or protocol-1 evidence, and plan-gate refusals as reconciliation. Prepare then writes deterministic spec and plan copies that record their provenance and recovery authorization, merging a task's contiguous repeated Requirements bullets into one field and recording each merge, only after the prepared plan passes the controller v2 plan gate. It never rewrites the source run; the controller performs the imports. |
| `autopilot-observability.mjs` | Implements the dependency-free observability bridge: incremental framing, safe/exact raw persistence, event curation, redaction, and bounded multi-destination backpressure. |
| `autopilot.mjs` | The **gear-3 autopilot conductor**. Parses the extended verdict-artifact contract at a spec head, writes deterministic versioned role manifests (including exact modular core/leaf references and scalar contract metadata), derives review evidence it can derive (criteria-only artifact, aggregate `git` diff from the run's baseline commit), then drives `plan → implement → review` as fresh headless harness sessions. A fresh run defaults to controller protocol 2 (delegated to `autopilot-controller.mjs`); `--controller-protocol 1` keeps the legacy driver, one child per finite phase/task lifecycle; existing state keeps its recorded protocol. A contradictory selection or `log-mode: exact` under protocol 2 is refused before any effect. It halts on `BLOCKED`, a mid-run `CONFLICT`, explicit safety/failure conditions, or I/O integrity failure; it always stops before bump/PR. |
| `bump-version.mjs` | Stages and validates all three manifests, retains one durable recovery target, publishes by per-file atomic rename under the repository lease, and rejects incomplete transactions in `--check`. |
| `capture-review-evidence.mjs` | The **bounded review-evidence collector**. Runs the surface test, optional Gear-4 verifier, and coherence gate in order; streams complete combined output to a confined current-run evidence artifact; emits only a compact hash/count/status/excerpt receipt to the reviewer context. Capture failure enters one awaited path that converges the detached child group and streams before closing its descriptor, and no later command starts. |
| `cost-report.mjs` | Aggregates repository-scoped interactive-session usage and confined headless ledger/raw evidence into a harness-neutral observational cost and token report. |
| `detect-stack.mjs` | Reads `package.json` / `pnpm-workspace.yaml` to detect the package manager and discover **surfaces** (workspace packages) with their test commands. Recognizes npm/pnpm/yarn/cargo/go/python; only the JS ecosystem is auto-discovered. |
| `extract-changelog.mjs` | Extracts the exact `## vX.Y.Z` section body used as release notes, rejecting missing, malformed, or prefix-only version matches. |
| `headless-runner.mjs` | Runs one managed headless descriptor with confined durable raw capture, bounded readable/live streams, terminal response correlation, and detached process-group convergence. Returns process, transport, terminal, and capture results separately; Gear 4 delegates through its existing public entry point. |
| `inception-handoff.mjs` | Verifies the exact `inception-handoff: steepy-apex/v1` transfer to init through a `verify`/`project`/`checkpoint`/`prepare`/`finalize` CLI: closed strict-JSON inputs, approval bound to approved project bytes, checkpoint plus opaque verification results, confirmed inputs projected to Project model v1, and code compared for changed, added, and removed paths plus branch/HEAD. A promotion destination that names a checkpoint inventory path by spelling or physical file identity is refused before prepare, including missing files reached through different mounts. The table must promote every confirmed surface's standard; this checks coverage, never text. Prepare binds one local receipt. Finalize requires the reported passing gate, unchanged code, bound inputs, and promoted text; the durable sequence is prepared receipt (bound by prepare) → finalization intent → final receipt → complete state. On resume it verifies the intended final digest or refuses an ambiguous legacy complete receipt without intent; it never writes stable documentation, invents approval, or runs the gate. |
| `inception-paths.mjs` | Confines access to the local inception area: only the canonical descriptor, its `*` ignore guard, and exact files of one declared run. It validates paths lexically before normalization, binds the admitted `.apex` mount, rejects globs, empty/dot/parent segments, descendant symlinks, non-ordinary files, and hardlinks through verified descriptors, bounds reads to 1 MiB, and writes per-file atomically with previous-digest comparison. Create-only writes recheck absence after ancestor creation; publication rechecks every ancestor identity, target, and staged file before rename. Identical-byte no-ops preserve bytes, mode, and mtime. |
| `inception-state.mjs` | Validates, starts, inspects, and updates the closed v1 inception descriptor through a `start`/`inspect`/`update` CLI: canonical bytes and legal phase/status/approval/init transitions enforced by `assertInceptionTransition`. Starting init freezes the approval and checkpoint references and binds handoff and receipt paths. Its optional `init.finalization` is a finalization intent for the same-path expected final digest during `in-progress`; creation needs the handoff helper's verifier, and completion needs the `verifyInitCompletion` verifier. The state CLI provides neither verifier. Completion consumes the intent and advances the receipt digest; ordinary v1 descriptors without the field retain their canonical bytes. It checks exact references, writes the ignore guard before the descriptor, and observes branch/HEAD through `observeRepositoryRevision` without mutating Git. Inspect classifies pre-hub from the descriptor alone without following references or certifying approval or completion. |
| `live-scaffold-canary.mjs` | Builds an isolated scaffold fixture and binds every row to source revision, exact payload hash, product version, and installation composition. Claude/Codex/OpenCode can PASS only `descriptor-nonce-response`, an evidence slice rather than plugin-load or specialist proof; Pi and DSH remain descriptor-free for Steepy's deterministic runner and unsupported/unauthenticated outcomes stay `NOT RUN`. |
| `loop-engineer.mjs` | The **terminal Gear-4 controller**. It validates the ratified goal and commit authorization, drives verifier-bounded attempts through an injected headless runner, enforces blast radius and controller-owned keep/discard commits, performs whole-branch review, resumes from durable events, and emits only validated terminal projections. |
| `new-surface.mjs` | Scaffolds one surface: a surface **standard**, a specialist **agent**, and a routing-table **row**. Hardened — safe-slug validation, refuses path traversal and the filesystem root, anti-clobber, plus a `--repair` mode for half-scaffolded surfaces. |
| `project-scaffold.mjs` | Public v1 planner and applicator for portable project instructions. It validates a confirmed project model, previews an explicit operation/conflict plan, applies it under an exclusive repository lock, and makes a second repair a zero-write no-op. |
| `push-version-guard.mjs` | Implements the development-only Claude PreToolUse guard that blocks invalid, equal or numerically downgraded versions on `git push` from `main`, while failing open for unrelated commands or unavailable Git state. |
| `render-claude-md.mjs` | Root-instruction CLI for the public planner: it maintains the managed `AGENTS.md` root spine and its thin `CLAUDE.md` import without overwriting user-owned bytes. |
| `sanitize.mjs` | Provides shared dependency-free validation for safe relative paths, single-line values, YAML double-quoted scalars, non-root hub targets, and physical binding of supported project symlink mounts. |
| `stable-paths.mjs` | The shared physical reader for stable documentation. It admits the hub root, binds the `.apex` and provider mounts once while keeping logical repository-relative paths, inspects and reads ordinary files through verified, bounded descriptors, refuses a hard-linked file on metadata alone, and excludes the registered local areas (`.apex/work`, `.apex/inception`) by name and physical identity. Metadata-only `locateFile` resolves an exact present file by physical identity or an absent file by its verified existing ancestor and remaining suffix, without reading a body, following a missing path, or enumerating siblings. It collects deduplicated diagnostics, never writes, imports only Node built-ins and `sanitize.mjs`, and exposes `readStableDocument` as the throwing single-file convenience controllers use. |
| `stop-hook.mjs` | Adapts `validate-hub.mjs` to the Claude Stop-hook protocol, blocking incoherent hubs without creating a repeated stop loop. |
| `template.mjs` | Performs strict pure-string `{{placeholder}}` substitution and rejects unknown template variables instead of leaking unresolved markers. |
| `validate-hub.mjs` | The **coherence linter**. Walks the `.apex/` link graph and flags orphans (transitively unreachable docs), unrouted agents, and broken relative links. It also recognizes a valid pre-hub `inception` state — a guarded, not-started-init descriptor with no other hub artifact — as neither a coherent hub nor a violation, from the descriptor's classification alone; an activated hub (init in progress or complete) never counts as pre-hub again. Silent when green; this is what the `Stop` hook runs. |
| `validate-release-evidence.mjs` | Computes the exact npm-product-input identity, excluding exactly `docs/native-test-evidence.json`, `docs/native-test-evidence.md`, and `docs/release-audit-remediation.md`; no documentation directory or path family is excluded. Requires one reachable source commit across all records, materializes its package projection from committed tree paths, modes, and blob bytes (not archive output), and requires exact current/source package-input path, mode, and byte equivalence. It rejects unredacted values in its bounded assignment/flag/Bearer-or-Basic/header/cookie forms from commands and UTF-8 artifacts, requiring an exact whole-value redaction marker; this is not a general secret scanner, so human redaction review remains required. The mandatory `--product-only` workflow check validates lockstep manifests/changelog/version-transaction state. Optional full release audit validation requires strict, fresh, redacted PASS records for plugin preflight and all five native harnesses; missing audit evidence does not block release. It reads evidence and package inputs but never invokes a provider. |
| `verify-model-mappings.mjs` | Revalidates configured provider/model-tier mappings against live or injected evidence and reports `OK`, `STALE`, or explicitly non-blocking `UNKNOWN` results. |
| `version-policy.mjs` | Validates canonical safe-integer X.Y.Z versions, compares numeric precedence, and rejects invalid, equal-required, or downgraded release transitions. |
| `work-paths.mjs` | Defines the canonical ordered types `spec | goal | criteria | work-output` and repository-confined read, write, append, mkdir, and persistent-descriptor primitives for `.apex/work/**`. |
| `workflow-state.mjs` | The **provider-neutral deterministic state kernel**. It validates the versioned workflow-event schema and JSONL bytes, correlates run/attempt identities, reduces events, shares baseline/reservation primitives with finite controllers, classifies commit reconciliation, and validates clean terminal state. |
| `write-all.mjs` | Supplies the shared synchronous complete-write primitive: it advances only on valid positive byte counts, retries short writes, and rejects zero, invalid, or thrown writes. |

Version updates provide recoverable per-file atomicity, not multi-file atomicity: an immutable
before/after journal keeps the same target across interrupted retries, exact bytes/modes are
preserved, and unexpected edits block. The existing project-scaffold lease serializes cooperating
writers; it is not an adversarial filesystem guarantee. Complete explicit targets are no-ops,
while required-increment release comparisons remain strict. File/directory fsync and rename
support are required; an incomplete journal always makes the release check fail.

The reusable GitHub validation workflow runs Node 24 tests, hub coherence, package
composition, and product metadata checks with read-only permissions. Release makes the sole
write-capable publishing job depend on that validation workflow. Full audit evidence validation
is optional and is not a release job. Payload identity
frames sorted canonical npm-package paths, modes, and bytes; excluding exactly
`docs/native-test-evidence.json`, `docs/native-test-evidence.md`, and
`docs/release-audit-remediation.md` permits an evidence-only commit without accepting untested
shipped changes. No documentation directory or path family is excluded. The evidence schema binds
source revision, product version and payload, host/profile, observation date, installation
composition, capability commands, PASS results, and the digest of the redacted artifact. It
documents evidence and does not establish that a provider actually ran; live review owns that
provenance.

Review-evidence process-group ownership is supported only on tested `linux` and `darwin`. It uses a
detached session boundary, waits for leader and stream settlement independently, and performs bounded
`SIGTERM` then `SIGKILL` convergence on failures and ordinary/nonzero exits. Descendants that
deliberately escape the spawned session are outside containment; bounded local stream settlement
prevents an escaped inherited-pipe holder from blocking descriptor closure indefinitely.

## Deterministic Gear-4 controller boundary

The machine-readable `events.jsonl` is authoritative. The controller reduces its strict, correlated
event sequence—including the exact baseline exit and monotonic observability-degradation fact—to
in-memory state; every `ledger.md` field and the `branch-diff.txt` projection are produced from that
state and the selected Git baseline. A stale or missing ledger can therefore be regenerated, but its
bytes never reconstruct or override controller state.

```text
ratified goal + mandatory commit authorization + Git baseline
                            |
                            v
                  loop-engineer.mjs
                            |
            ATTEMPT_RESERVED (durable first)
                            |
                supported headless runner
                            |
        owned diff -> blast radius -> verifier
                    /                    \
          commit intent + commit    discard intent + restore
                    \                    /
                     whole-branch review
                            |
             TERMINAL_RECORDED event authority
                    /                    \
        ledger.md + branch-diff.txt    consumed goal
              (projections)
```

`ATTEMPT_RESERVED` lands before runner dispatch, create-only attempt evidence, or mutation, so a
crash cannot reuse an attempt identity. Resume replays the event log and completes a commit or
discard only when event, snapshot, changed-path, and Git identities prove controller ownership.
Ambiguity appends `RECONCILIATION_REQUIRED` then `RUN_HALTED`; it never resets uncertain work.
Claude, Codex, and OpenCode have deterministic CLI descriptors. Pi and DeepSeek remain explicit
`runner-unavailable` refusals rather than falling back to a weaker inline loop.

## Gear-3 controller protocol 2

A fresh Gear-3 autopilot run defaults to controller protocol 2. `scripts/autopilot.mjs` selects the
protocol once: `--controller-protocol 1` still starts a legacy run, and existing state keeps its
recorded protocol (an `autopilot-run.json` identity means 2, a legacy status means 1). A
contradictory selection, controller state without its identity, or `log-mode: exact` under protocol 2
is refused before any effect, with no reset and no fallback.

```text
conductor lease + locked preflight
                |
                v
     autopilot-controller.mjs
                |
  role-N-reservation.json (durable, before any effect)
                |
  role manifest + shared managed runner (headless-runner.mjs)
                |
  role-N-response.json captured before any gate
                |
  writer only: controller commits the task's source
                |
  plan / task-result / reviewer / review-evidence gate
          /                         \
 receipt + RESULT_ACCEPTED     refusal after an effect
          |                         |
 READY/CONSUMED,                RUN_HALTED
 PHASE_ACCEPTED, RUN_COMPLETED
```

What stays with the model: the plan, writer, reviewer, and review roles do the judgment work, write
only their assigned artifacts, and return a closed payload. Writers edit only their assigned source
under TDD. Roles never write state. What the controller owns and verifies: dispatch, durable response
capture before any gate, task-result receipts, the reviewer gate with at most one format correction,
the review evidence gate, workflow events, task commits, and READY/CONSUMED publication. A writer's
source is committed by the controller after its response is captured and before the task-result
gate. The review evidence gate binds the plan's exact surface test command and `validate-hub`, both
exiting 0 with no signal or spawn error, collected after the review role was reserved. A refusal
before any effect journals nothing and stays resumable; a gate refusal after an effect is a terminal
`RUN_HALTED`.

The authoritative journal is `autopilot-events.jsonl` (event schema 2), beside the immutable
`autopilot-run.json`; `autopilot-status.md` is a regenerated projection and never an event source.
Each role invocation N has a durable `role-N-reservation.json` before any effect, the
controller-written `role-N-response.json` captured before any gate, a receipt validated before
`RESULT_ACCEPTED`, the `role-N.raw.jsonl` capture, the readable `role-N.log`, and the manifest
`context/role-N.json`. N numbers the invocation, not the task. Writers run at their task Complexity
tier; a task reviewer runs at `most-capable` for a design task and `standard` otherwise; the final
review runs at `most-capable` when any task is design; a response-only correction runs at `standard`.

| Version | Value |
|---|---|
| Controller protocol | 2 for fresh runs; legacy runs keep 1 |
| Writer task-result protocol | 2 |
| Task-result index protocol | 2 for fresh controller runs; 3 for recovery runs |
| Reviewer response protocol | 3 |
| Run identity schema | 1 for ordinary runs; 2 for recovery runs |
| Journal event schema | 2 |
| Response record schema | 1, which added the unreleased `rawDigest` |

Fresh controller runs use index protocol 2 and recovery runs use index protocol 3. Recovery is a
separate entry, not a resume. `autopilot-recovery.mjs` inspects and prepares one exact
`recovery-input.json`, and `--recovery-input` starts a new recovery run whose kind is bound once in
its run identity. Only legacy sources are importable: a protocol-2 source is refused by name, and the
approved contract branch must equal the accepted current branch. Preparation may also merge a task's
contiguous repeated Requirements bullets into one field, each value a sub-bullet in source order, and
records each merge as `transformation:` provenance. A repeat split by another field, and a duplicate of
any other field, is refused by name. The fresh-run v2 grammar stays strict: each field once per task.
The controller registers one import per reused task before any other run event. Index protocol 3
projects `kind: execution` and `kind: import` entries, and an import has `status: IMPORTED`. An
import is never approval: every imported task gets a fresh import-bound review in the new run, its
first fix is execution 2, and the whole-branch diff starts where the imported lineage started.
That diff can also hold the delta the recovery input accepted. A recovery run's final-review and
review manifests both read that diff, so both carry `recovery: { input, delta }`: the exact input
path and its `current.delta`, bound to the run's recorded input digest. No other role's manifest
carries it. A delta path explains only the change no task claims. In every controller run, the
index starts with the canonical `source-spec`, `criteria`, and `branch-diff` metadata lines below
its lifecycle header.

Compatibility boundaries: legacy controller protocol 1 runs keep the one-child-per-phase driver, the
Markdown status stream, and their recorded task-result protocol; manual drive keeps its human
handoff; Gear 4 keeps `loop-engineer.mjs`. Nothing migrates between them. The controller and Gear 4
share the managed runner in `headless-runner.mjs`, which persists only safe-redacted raw captures.

Known limitations: with several distinct test commands, the review manifest carries no single
`testCommand`, and the review skill takes one `--test-command`; the evidence gate accepts any one of
the plan's commands. The whole-branch fix-target finding-ID inventory is derived from the fix-target
block itself, because the final-review prompt has no finding-ID grammar outside it. Controller
protocol 2 writes no `resource-usage.jsonl` usage ledger, so `scripts/cost-report.mjs` reports no
headless usage for these runs; each role reservation records only the requested and descriptor
model or the degradation.

Evidence for this path is synthetic, not native evidence: `tests/autopilot-controller-integration.test.mjs`
drives the public CLIs against the fake-harness stand-in. `tests/fixtures/autopilot-controller/native-smoke.mjs`
is the opt-in driver for one real provider; the suite runs it only against fake shims.

## `adapters/` — the harness adapters

The `adapters` surface: thin, dependency-free wiring that serves the canonical `skills/` tree to each harness — never workflow behavior, which lives once in the core. Skills reference engine scripts skill-relatively (`node <engine-root>/scripts/<x>.mjs`, resolved from the skill's own base directory), so no adapter has to rewrite prose and no `CLAUDE_*` variable appears in the core (test-locked).

| Harness | Wiring |
|---|---|
| Claude Code | `.claude-plugin/` manifest + marketplace — the pre-existing plugin, unchanged behavior. |
| Codex | `.codex-plugin/plugin.json` (points at `skills/` and `hooks/hooks-codex.json`) + `.agents/plugins/marketplace.json`, which makes the repo itself a marketplace root. |
| OpenCode | `adapters/opencode/steepy-apex.js` — a config hook pushes `skills/` into `config.skills.paths`, registers ten `steepy-apex-<skill>` commands where supported (including the pre-hub `inception` skill), and injects a marker-guarded bootstrap block into the first message. Project hub agents are read only from `.opencode/agents/*.md`; missing or invalid native directories register no project specialists, and Claude descriptors are never read. It also registers D2 dispatch agents: the tier trio (`steepy-cheap`/`steepy-standard`/`steepy-most-capable`) when `config.model` is a mapped provider pin — that trio is the per-dispatch tier choice — and without a mapped pin dispatch degrades to the declared session model. |
| Pi | the `"pi"` manifest in `package.json` (`skills`, `extensions`) + `adapters/pi/steepy-apex.js` — `session_start` bootstrap injection and optional `/steepy-<skill>` command wrappers, covering all ten skills including the pre-hub `inception` skill. |
| DeepSeek Harness | `adapters/dsh/steepy-apex.js`, wired via the root `cordis.patch.yml` bundle-patch file and `package.json`'s `dsh.bundle.patch` key. Registers three capabilities, each on its own dependency-gated child fiber: a `ctx.systemPrompt` section for bootstrap, ten `steepy-<skill>` commands (including the pre-hub `inception` skill), and the model-invocable `steepy_skill` tool. A command's output is rendered to the human and never enters model history, so a command can only name the tool call to make — that is why `steepy_skill` exists as the model-facing channel that actually loads a skill's exact prose (F3). |

Adapters are fail-open: every optional host API sits behind a capability check, so a host without a feature degrades to a no-op instead of an error. Where a harness lacks a capability the skills degrade along a declared path (inline specialist, session model) — stated in the output, never silent. Concrete D2 tier models come from `adapters/model-mappings.mjs` (the provider-keyed tier tables with per-row provenance) — the same tables `scripts/verify-model-mappings.mjs` checks for drift.

DeepSeek Harness's fail-open shape is dependency-gated activation rather than a synchronous presence check: each of its three capabilities runs on its own child fiber, gated on exactly the one host service it needs. A host that never composes one of those services leaves only that one capability's fiber pending forever — silently, with no error and no timeout — while the adapter's own fiber and the other two capabilities stay unaffected. This wiring degradation is declared in the adapter's own bootstrap block as well as here, per `.apex/conventions.md`'s "degradations are explicit, never silent" rule.

`adapters/headless.mjs` is the odd one out: not a session-injection adapter but a harness → headless one-shot command map (`claude -p`, `codex exec`, `opencode run`; `null` for a harness with no headless mode, e.g. Pi). It is what `scripts/autopilot.mjs` — the gear-3 autopilot conductor — uses to build each headless command: one per phase in a legacy controller protocol 1 run, and one per role invocation under controller protocol 2, where the shared `headless-runner.mjs` runs it. It also tells `brainstorm` Step 7 whether autopilot can be offered on the current harness.

## Autopilot live-observability boundary

This section describes the legacy controller protocol 1 driver in `scripts/autopilot.mjs`. Under
controller protocol 2, the default for a fresh run, `autopilot.mjs` builds each role's descriptor,
and the shared managed runner `headless-runner.mjs` frames the stream, persists the safe-redacted
`role-<N>.raw.jsonl` and the readable `role-<N>.log`, feeds the live destination, correlates the
terminal response through `adapters/headless-response.mjs`, and owns process-group termination.
Its authority is the journal `autopilot-events.jsonl`; it writes no aggregate phase log and no
resource-usage ledger.

The headless path has a deliberately one-way dependency direction:

```
adapters/headless.mjs ── command descriptor ──► scripts/autopilot.mjs
adapters/headless-events.mjs ── decoded event ─► scripts/autopilot.mjs
scripts/autopilot-observability.mjs ── bridge primitives ─► scripts/autopilot.mjs
```

`adapters/headless.mjs` owns only the harness command descriptor and declared native capabilities. `adapters/headless-events.mjs` owns only protocol decoders for one structured output line; it does not choose persistence, timeout, or halt policy. `scripts/autopilot-observability.mjs` owns the common event envelope, line framing, raw serialization/redaction, curated rendering, and the bounded writer. `scripts/autopilot.mjs` owns orchestration: attempts, versioned manifests, artifact timing, status correlation, child lifetime, and the user-facing halt decision. In a legacy run, the implement skill/controller validates artifact-first completion and the selected envelope before the next task decision: manual/legacy v1 uses four fields, while v2 uses status/artifact/signals and receipt-derived source paths; under controller protocol 2, `autopilot-controller.mjs` validates every response. That controller routes an effective abstract controller tier; adapters apply or degrade the concrete model and return direct provider evidence. The adapters never import conductor policy, and the bridge never selects a harness command.

For each child stdout/stderr line, the conductor uses a raw-first flow: frame → serialize immutable raw JSONL → decode into the common event envelope where possible → curate the readable per-attempt and aggregate logs → write the same compact curated event to the bounded stdout/stderr live destination. Ordinary plain decoder failures use a source-labelled, redacted, length-limited passthrough; unknown or malformed structured data uses a generic fallback so arbitrary metadata and reasoning cannot enter the readable or live view. Reasoning and token deltas are never promoted.

The bridge enforces bounded backpressure across raw, readable, aggregate, and live destinations: it pauses a source while a required writer drains and bounds partial lines and pending writes. Its policy is intentionally hybrid. Failure to open, redact, fully write, or drain the immutable raw destination is blocking: the conductor terminates the whole child process group and halts. A readable, aggregate, or live destination write/drain failure is non-blocking: it records `OBSERVABILITY_DEGRADED`, disables that destination, and continues through the durable raw capture plus any healthy curated destinations.

The resource-usage ledger is append-only JSONL scoped to run, phase, and attempt. It records each direct provider measurement once with a source-event fingerprint: exact retransmissions deduplicate, while distinct provider phase aggregates from one session remain separate. Those distinct phase aggregates must not be summed unless provider evidence establishes disjoint scopes. Derived displays read the records rather than re-recording them, but persistence deduplication alone does not establish additivity. The ledger is observational evidence for context efficiency, never a budget or a healthy-work stop condition.

Process lifetime converges in `scripts/autopilot.mjs`: terminal interruption, optional native stop, explicit safety/failure condition, and a blocking bridge failure all enter one stop path, send `SIGTERM` to the detached child group, escalate to `SIGKILL` after a short grace, close destinations once, and settle the attempt once. A bounded I/O integrity timeout may protect a stalled read, write, or drain operation; it is not a phase duration or work timer. A live child that emits no output therefore remains active until it exits or receives an explicit stop; the conductor does not infer a hang from silence. This keeps descendants from outliving a halted phase. The entire path uses Node >= 24 built-ins only and has zero runtime dependencies.

The legacy Gear-3 authority sequence is checkout lease and locked preflight → versioned status-protocol
declaration/validation → correlated child evidence plus process-group convergence → conductor-authored
`PHASE_ACCEPTED` → verified lease release. A failure before acceptance records a correlated halt when
durable status exists and never promotes the child's completion claim; an unverifiable release fails
the run and preserves the ambiguous generation for recovery. The lease is per physical checkout, so
parallel conductors require distinct Git worktrees. Deterministic process-group ownership is offered
only on tested `linux` and `darwin`, owns only the group it spawned, and is neither OS sandboxing nor
containment of descendants that deliberately escape that group.

## `hooks/` — the Stop hook

`hooks.json` registers a single Claude Code `Stop` hook that runs `stop-hook.mjs` at the end of every turn. `hooks-codex.json` declares Codex wiring using `$PLUGIN_ROOT`; native loading and protocol compatibility depend on the host version and require a real-host check. On a compatible host, violations produce a `decision: block` response; coherent or absent hubs stay silent. The hook does not re-block while `stop_hook_active` is set. The path is quoted to survive spaces. When native hooks are unavailable, `check` and `review` remain the explicit gates.

## Portable project instructions

The public scaffold derives its output only from templates plus a confirmed project model:

```text
templates + confirmed model
          |
          v
project-scaffold v1 planner/applicator
          |
          +--> AGENTS.md managed common root
          +--> CLAUDE.md managed @AGENTS.md import
          +--> .agents/skills/<project>-bootstrap/SKILL.md
          +--> .claude/skills/<project>-bootstrap/SKILL.md (thin stub)
          +--> .claude/agents/<agent>.md
          +--> .codex/agents/<agent>.toml
          +--> .opencode/agents/<agent>.md
```

`AGENTS.md` is the only common root spine. The canonical bootstrap is harness-neutral in
`.agents`; Claude reaches it through its thin stub. The triads are native routing and
metadata only, while `.apex/_INDEX.md` and the surface standards remain the semantic
authority. The scaffold emits ordinary files and supports existing symlink mounts at the
repository entries `.apex`, `.agents`, `.claude`, `.codex`, `.opencode`, `AGENTS.md`, and
`CLAUDE.md`. Repair updates their physical destinations while preserving the links. Descendant
links remain refused. It never resolves a user-owned semantic conflict automatically.

Pi and DeepSeek Harness receive generic root/bootstrap/index guidance and inline
degradation; that guidance does not hardcode a host project's bootstrap name.

## `templates/` — what gets scaffolded

Markdown templates with `{{placeholder}}` variables — project instruction artifacts are rendered by the public planner, while hub sources such as `_INDEX.md` and `routing-row.md` are completed by the `init` skill's prose. A script-substituted unknown placeholder throws, so a template typo on that path is a build error, not leaked output.

| Template | Becomes |
|---|---|
| `AGENTS.md` | The managed root instruction spine. |
| `claude-import.md` | The managed thin `CLAUDE.md` import of `AGENTS.md`. |
| `project-bootstrap-skill.md` | The canonical, harness-neutral project bootstrap under `.agents/skills/`. |
| `claude-bootstrap-stub.md` | Claude's thin stub pointing to the canonical bootstrap. |
| `prior/v1.0/project-bootstrap-skill.md` | Nothing: the digest-pinned v1.0.0-v1.0.4 bootstrap source, rendered only so repair and the linter recognize an untouched earlier bootstrap as a stale update. |
| `surface-agent-claude.md` / `surface-agent-codex.toml` / `surface-agent-opencode.md` | One thin native adapter triad for each routed surface. |
| `_INDEX.md` | The `.apex/` hub root — the DAG root every doc is reachable from. |
| `surface-standard.md` | A per-surface standard doc. |
| `routing-row.md` | One row of the routing table. |

## `tests/` — the safety net

Run with `npm test` (`node --test tests/*.test.mjs`) — no test framework, just the Node built-in runner. Coverage by concern:

- **Engine:** `detect-stack`, `new-surface`, `render-claude-md`, `validate-hub`, and bounded review-evidence capture — one suite each.
- **Scaffolding flow:** `init` (repair mode, non-destructive), `project-scaffold` (public planning/apply/conflict/lock behavior), `dogfood-hub` (the repository uses the public planner and proves repair is a byte/mode/mtime no-op), `git-policy`, and `e2e-smoke` (a hub built from templates + one surface must lint green).
- **Plugin wiring:** `hooks` (Stop-hook robustness), `workflow-skills` (the brainstorm→plan→implement→review skills are valid, hub-aware, and correctly chained), `release-metadata` (identity, README/RELEASE/COMMUNITY copy stay consistent).
- **Multi-harness:** `portability-contract` (zero `CLAUDE_*`/absolute paths in `skills/`, open-subset frontmatter, engine-root resolution), `adapters` (Codex manifests, OpenCode plugin, Pi extension, DeepSeek Harness plugin — behavior-tested with stub hosts), `canary-structural` (isolated-HOME, env-scrubbed engine runs through literal skill-relative paths), `npm-pack` (the tarball carries every manifest, adapter, skill, and script).
- **Autopilot:** `autopilot` (headless command builder, contract parser + refusal guards, protocol selection, and the conductor drive loop — hermetic fake-harness children, real signals, process-group kill verification); `autopilot-controller`, `autopilot-state`, `autopilot-recovery`, and the synthetic `autopilot-controller-integration` matrix cover controller protocol 2 and recovery with fake harnesses only, never as native evidence.
- **Fixtures:** `good-hub` / `bad-hub` (linter cases) and `pnpm-*` / `single-pkg` (stack-detection cases).

## Local usage reports

`node scripts/cost-report.mjs --repo-root <root> [--harness <id>]` reports raw token
usage from the repository's autopilot ledgers and the harness session store.
Usage report schema version 7 separates exact observation identity from provider measurement
scope, sums only provably disjoint measurements, and publishes accounting coverage. Unsupported or
missing scope remains unknown, not zero; descriptive eligibility labels are not accounting evidence.
Only ledger schema version 2 is supported; other versions are counted as invalid or
unclassifiable and produce no dispatch rows.
Unknown-scope observations are retained, and missing-usage completions are durable observations,
never zero. Conflicting retransmission evidence is reported as one invalid, non-additive
observation and remains in provider-collision analysis.
Runtime provider-version evidence gates promotion: only OpenCode v1.18.27 has supported usage
semantics, while missing or different versions remain unknown.
Interactive session-store observations are excluded from additive rollups unless official provider
evidence establishes a disjoint measurement scope.
The default Claude store is the user's `.claude/projects` directory. Repository
attribution happens **after session files are read**: `--repo-root` filters the
report, but does not prevent reading other repositories' session files in that store.

Use `--session-store-root <root>` to select one exact store directory, or
`--no-session-store` to skip store collection entirely. These options are mutually
exclusive and control interactive session collection. Headless usage is read only
from the current conductor ledger; session-store entries such as `sdk-cli` remain
listed under `unclassifiedSessions` and never fill a missing or corrupt ledger.
Disabling the store leaves repository ledger reporting available and labels the
interactive channel `CHANNEL_UNAVAILABLE` with reason `store-disabled`.
Tests and automation that must avoid user data should supply a temporary store or
disable collection explicitly.


## Trust & safety

steepy-apex has zero third-party runtime dependencies: its scripts and adapters use Node
built-ins. It is not globally offline or repository-only: effects depend on the command.

### Command-family effects matrix

Filesystem reads–writes–subprocesses–temporary state–providers/network vary by command family:

| Command family | Effects |
|---|---|
| Local validation and scaffolding | Reads the selected repository; scaffold/version commands write governed project files and durable transaction state. `validate-hub` is read-only. |
| Observability and usage reports | Reads repository ledgers and, unless disabled, the selected harness session store; it does not infer missing usage as zero. |
| Review/controller workflows | Run declared tests, Git, and supported harness subprocesses; Gear-3/4 create confined work state and require their stated authorization. |
| Release evidence validation | Reads package inputs, invokes `npm pack --dry-run` and Git, and uses an OS temporary cache; it never invokes a provider. |
| Model mapping verification | Its injected inputs support an offline test path; live mode invokes the OpenCode catalog and fetches provider provenance. |
| Installation and native canaries | Host installation, authenticated sessions, and a genuine canary may use host caches, credentials, subprocesses, and network according to the host. |

`init` writes `.apex/` governance files and the managed root/bootstrap plus native
Claude/Codex/OpenCode agent triads in the target project. This does not promise that
every command writes only there; review the command family before granting trust.

As with any plugin, review plugin hooks before trusting them: the full hook wiring is three small files, [`hooks/hooks.json`](../hooks/hooks.json) (Claude Code), [`hooks/hooks-codex.json`](../hooks/hooks-codex.json) (Codex), and [`scripts/stop-hook.mjs`](../scripts/stop-hook.mjs).

### Autopilot task execution receipts

In legacy controller protocol 1, fresh runs record TASK_RESULT_PROTOCOL 2 once and pin it in all
phase and task-role manifests, and retained runs that predate it stay on protocol 1. Controller
protocol 2 pins the same writer protocol 2 in every role manifest. V2 changes neither manual drive
nor Gear 4. A legacy run's implement controller records an exact task execution prefix in the
authorized ledger before dispatch, and controller protocol 2 binds that execution's receipt path in
the role reservation; either controller then captures the raw semantic response and source
observation, freezes the report, and publishes the result. Each file
uses staged fsynced atomic publication under the cooperating-writer lease; this is neither a
multi-file transaction nor protection from hostile concurrent writers. A durable capture can finish
publication on restart without repeating implementation. Baseline-only state cannot establish DONE.

JSON receipts are machine authority; the Markdown index is their generated projection, with exact
changedPaths arrays and retained lifecycle/reviewer references. Git filenames containing spaces,
commas, semicolons, Unicode, or newlines remain literal JSON strings. No brace expansion or model path
claim determines the changed set. Legacy extra changed-paths remains ignored raw telemetry; semantic
status/artifact/signals never come from report prose. Receipts retain cumulative task paths and each
execution's own paths, frozen reports, and the distinct same-task previous/global parent links.

Exact recorded state and schema-authorized links confined to the same task directory authorize only
machine replay, never work-directory scanning or extra child inputs. Source discovery remains normal.
Captured execution is review-pending, not approved. Task approval binds the latest execution; a fix
invalidates an older approval. Final review and conductor acceptance replay the receipt chain and
all required task/final approvals. No historical baseline is fabricated and no legacy run silently
upgrades. Real-Git and isolated regression replay evidence does not certify native model behavior or
product correctness.

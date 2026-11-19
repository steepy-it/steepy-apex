# Architecture

How the plugin is built. Read this to contribute or to understand the machinery; day-to-day usage is covered by the [README](../README.md).

steepy-apex is a multi-harness plugin — one canonical core installed natively in Claude Code, Codex, OpenCode, Pi, and DeepSeek Harness — with **zero runtime dependencies**: every script and adapter runs on Node.js built-ins only (Node >= 24).

## Overview

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
| `reviewer-response.mjs` | Gates Gear-3 reviewer responses (status/artifact/signals only) with Git snapshots and replay-validated receipts, and binds task approval to its latest execution digest. The conductor requires task/final proof bound to the full plan contract and handoff, and verifies every execution ancestor against its exact phase manifest before accepting implementation. Retained approval keeps its original identity; active references advance atomically without rewriting history. The skill owns dispatch. |
| `source-observation.mjs` | Observes branch, HEAD, index, tracked and nonignored untracked source using exact Git filenames; validates source paths separately from work artifacts and detects source continuation/drift. Unsupported submodules fail closed. |
| `task-results.mjs` | Begins and captures immutable v2 task executions, freezes reports, resumes durable captured results without writer redispatch, projects JSON task indexes, and verifies lineage, all task reports, and current source. Same-task previous execution and latest global parent are separate links. Explicit retry executions can continue valid NEEDS_CONTEXT/BLOCKED results after a remedy while preserving partial work; malformed or ambiguous evidence cannot authorize retry. |
| `autopilot-context.mjs` | Builds and validates versioned role-local context manifests, materializes the criteria-only review artifact, derives routed standards, and exposes strict plan/handoff verification commands. |
| `autopilot-observability.mjs` | Implements the dependency-free observability bridge: incremental framing, safe/exact raw persistence, event curation, redaction, and bounded multi-destination backpressure. |
| `autopilot.mjs` | The **gear-3 autopilot conductor**. Parses the extended verdict-artifact contract at a spec head, writes deterministic versioned role manifests (including exact modular core/leaf references and scalar contract metadata), derives review evidence it can derive (criteria-only artifact, aggregate `git` diff from the run's baseline commit), then spawns `plan → implement → review` as fresh headless harness sessions — one child per finite phase/task lifecycle. It halts on `BLOCKED`, a mid-run `CONFLICT`, explicit safety/failure conditions, or I/O integrity failure; it always stops before bump/PR. |
| `bump-version.mjs` | Stages and validates all three manifests, retains one durable recovery target, publishes by per-file atomic rename under the repository lease, and rejects incomplete transactions in `--check`. |
| `capture-review-evidence.mjs` | The **bounded review-evidence collector**. Runs the surface test, optional Gear-4 verifier, and coherence gate in order; streams complete combined output to a confined current-run evidence artifact; emits only a compact hash/count/status/excerpt receipt to the reviewer context. Capture failure enters one awaited path that converges the detached child group and streams before closing its descriptor, and no later command starts. |
| `cost-report.mjs` | Aggregates repository-scoped interactive-session usage and confined headless ledger/raw evidence into a harness-neutral observational cost and token report. |
| `detect-stack.mjs` | Reads `package.json` / `pnpm-workspace.yaml` to detect the package manager and discover **surfaces** (workspace packages) with their test commands. Recognizes npm/pnpm/yarn/cargo/go/python; only the JS ecosystem is auto-discovered. |
| `extract-changelog.mjs` | Extracts the exact `## vX.Y.Z` section body used as release notes, rejecting missing, malformed, or prefix-only version matches. |
| `inception-protocol.mjs` | Validates and canonically renders v2 inception formats and provides token-bound publication primitives for confined staging, fsync, rename and exact-target verification. It never chooses phases, mutates descriptor state independently, or executes application commands. |
| `inception-snapshot.mjs` | Observes complete application inventories and compares content/mode identity while excluding physically bound local workflow and Git areas, recognized scaffold lease directories, the linked worktrees Git lists below the root and approved exclusions (before approval, the start exclusions) before traversal; Git status uses the same excluded set. |
| `capture-inception-evidence.mjs` | Executes one approved inception check, seals separate output streams, and binds its receipt through the state helper; interrupted capture recovery never reruns the command. |
| `inception-governance.mjs` | Prepares, writes the certified stable documents (exact bytes, mode 0644) and verifies exact init provenance, preserving completed inception evidence and rejecting application drift outside certified governance operations. |
| `inception-state.mjs` | Records and verifies inception run state under `.apex/inception/`: the run descriptor, classification of the starting state, phase transitions, approval and checkpoint records, persisted units and the sole writer, full snapshots, immutable effect records, verification cycles/sessions, derived summary/completion, recoverable byte-reserved publication, resume notes, and descriptor-independent abandon. It never asks questions, chooses a phase, approves, or runs project commands. |
| `live-scaffold-canary.mjs` | Builds an isolated scaffold fixture and binds every row to source revision, exact payload hash, product version, and installation composition. Claude/Codex/OpenCode can PASS only `descriptor-nonce-response`, an evidence slice rather than plugin-load or specialist proof; Pi and DSH remain descriptor-free for Steepy's deterministic runner and unsupported/unauthenticated outcomes stay `NOT RUN`. |
| `loop-engineer.mjs` | The **terminal Gear-4 controller**. It validates the ratified goal and commit authorization, drives verifier-bounded attempts through an injected headless runner, enforces blast radius and controller-owned keep/discard commits, performs whole-branch review, resumes from durable events, and emits only validated terminal projections. |
| `new-surface.mjs` | Scaffolds one surface: a surface **standard**, a specialist **agent**, and a routing-table **row**. Hardened — safe-slug validation, refuses path traversal and the filesystem root, anti-clobber, plus a `--repair` mode for half-scaffolded surfaces. |
| `process-group.mjs` | Supplies the shared detached-process-group convergence primitive for every controller and collector stop path: an `ESRCH`-only absence probe, error-tolerant group signalling, and bounded `SIGTERM` → `SIGKILL` convergence with a presence wait and a confirmation probe. It never spawns processes or settles streams, and it supports only `linux` and `darwin`. |
| `project-scaffold.mjs` | Public v1 planner and applicator for portable project instructions. It validates a confirmed project model, previews an explicit operation/conflict plan, applies it under an exclusive repository lock, and makes a second repair a zero-write no-op. |
| `publish-directory-branch.mjs` | Builds the Claude directory payload commit from a source commit's tracked tree minus the root-anchored denylist (`tests/`, `.github/`, `.codex-plugin/`, `CLAUDE.md`, `hooks/`, `.claude/settings.json`) through a temporary index, leaving the working tree and real index untouched. It skips a version the branch already carries, refuses a lower one, parents each new commit on the previous payload commit with a `Source-Commit` trailer, and pushes to `claude-directory` without ever forcing. |
| `push-version-guard.mjs` | Implements the development-only Claude PreToolUse guard that blocks invalid, equal or numerically downgraded versions on `git push` from `main`, while failing open for unrelated commands or unavailable Git state. |
| `render-claude-md.mjs` | Root-instruction CLI for the public planner: it maintains the managed `AGENTS.md` root spine and its thin `CLAUDE.md` import without overwriting user-owned bytes. |
| `sanitize.mjs` | Provides shared dependency-free validation for safe relative paths, single-line values, YAML double-quoted scalars, non-root hub targets, and physical binding of supported project symlink mounts. |
| `stop-hook.mjs` | Adapts `validate-hub.mjs` to the Claude Stop-hook protocol, blocking incoherent hubs without creating a repeated stop loop. |
| `template.mjs` | Performs strict pure-string `{{placeholder}}` substitution and rejects unknown template variables instead of leaking unresolved markers. |
| `validate-hub.mjs` | The **coherence linter**. Walks the `.apex/` link graph and flags orphans (transitively unreachable docs), unrouted agents, and broken relative links. Silent when green; this is what the `Stop` hook runs. Before a hub exists, canonical inception descriptor/archive-intention and exact archive proof make it report the phase/next action without scanning local state. |
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

Process-group ownership in review capture, inception capture, the autopilot conductor, and
loop-engineer is supported only on tested `linux` and `darwin`, and every stop path converges
through the shared `scripts/process-group.mjs` primitive, where only an `ESRCH` probe proves
the group is gone. Each caller uses a detached session boundary and performs bounded
`SIGTERM` then `SIGKILL` convergence on failures and ordinary/nonzero exits. Descendants that
deliberately escape the spawned session are outside containment for all four callers. Review
capture and inception capture also bound local stream settlement, so an escaped inherited-pipe
holder cannot block descriptor closure indefinitely there. Autopilot and loop-engineer wait for
stream closure.

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

The log records the branch and Git baseline once. Commit and discard intent is durable before the Git side effect. A crash-safe resume replays events
and completes an interrupted side effect only when the event identity, expected parent, snapshot,
changed paths, and commit metadata prove controller ownership. Ambiguous branch, HEAD, dirty-tree,
artifact, commit, discard, or review state records `RECONCILIATION_REQUIRED` and `RUN_HALTED`, leaves
the ledger `DRAFT`, and permanently abandons that run; the controller never resets uncertain work.
After preserving the halted evidence, recovery uses a new ratified goal at a distinct goal path and
new loop workspace rather than deleting, editing, or resuming the abandoned state.

## `adapters/` — the harness adapters

The `adapters` surface: thin, dependency-free wiring that serves the canonical `skills/` tree to each harness — never workflow behavior, which lives once in the core. Skills reference engine scripts skill-relatively (`node <engine-root>/scripts/<x>.mjs`, resolved from the skill's own base directory), so no adapter has to rewrite prose and no `CLAUDE_*` variable appears in the core (test-locked).

| Harness | Wiring |
|---|---|
| Claude Code | `.claude-plugin/` manifest + marketplace — the pre-existing plugin, unchanged behavior. |
| Codex | `.codex-plugin/plugin.json` (points at `skills/` and `hooks/hooks-codex.json`) + `.agents/plugins/marketplace.json`, which makes the repo itself a marketplace root. |
| OpenCode | `adapters/opencode/steepy-apex.js` — a config hook pushes `skills/` into `config.skills.paths`, registers ten `steepy-apex-<skill>` commands where supported, and injects a marker-guarded bootstrap block into the first message. Project hub agents are read only from `.opencode/agents/*.md`; missing or invalid native directories register no project specialists, and Claude descriptors are never read. It also registers tier dispatch agents: the trio (`steepy-cheap`/`steepy-standard`/`steepy-most-capable`) when `config.model` is a mapped provider pin — that trio is the per-dispatch tier choice — and without a mapped pin dispatch degrades to the declared session model. |
| Pi | the `"pi"` manifest in `package.json` (`skills`, `extensions`) + `adapters/pi/steepy-apex.js` — `session_start` bootstrap injection and optional `/steepy-<skill>` command wrappers. |
| DeepSeek Harness | `adapters/dsh/steepy-apex.js`, wired via the root `cordis.patch.yml` bundle-patch file and `package.json`'s `dsh.bundle.patch` key. Registers three capabilities, each on its own dependency-gated child fiber: a `ctx.systemPrompt` section for bootstrap, ten `steepy-<skill>` commands, and the model-invocable `steepy_skill` tool. A command's output is rendered to the human and never enters model history, so a command can only name the tool call to make — that is why `steepy_skill` exists as the model-facing channel that actually loads a skill's exact prose. |

Adapters are fail-open: every optional host API sits behind a capability check, so a host without a feature degrades to a no-op instead of an error. Where a harness lacks a capability the skills degrade along a declared path (inline specialist, session model) — stated in the output, never silent. Concrete tier models come from `adapters/model-mappings.mjs` (the provider-keyed tier tables with per-row provenance) — the same tables `scripts/verify-model-mappings.mjs` checks for drift.

DeepSeek Harness's fail-open shape is dependency-gated activation rather than a synchronous presence check: each of its three capabilities runs on its own child fiber, gated on exactly the one host service it needs. A host that never composes one of those services leaves only that one capability's fiber pending forever — silently, with no error and no timeout — while the adapter's own fiber and the other two capabilities stay unaffected. This wiring degradation is declared in the adapter's own bootstrap block as well as here: a degradation is always stated, never silent.

`adapters/headless.mjs` is the odd one out: not a session-injection adapter but a harness → headless one-shot command map (`claude -p`, `codex exec`, `opencode run`; `null` for a harness with no headless mode, e.g. Pi). It is what `scripts/autopilot.mjs` — the gear-3 autopilot conductor — uses to spawn each phase, and what tells `brainstorm`'s drive-mode step whether autopilot can be offered on the current harness.

### Native capability matrix — 2026-08-19, steepy-apex v0.8.5

This versioned matrix is the conservative contract used by `adapters/headless.mjs`. States are exactly `yes | unavailable | unproven`: **yes** is implemented and supported by the mapped command; **unavailable** is not offered by that harness descriptor; **unproven** is deliberately withheld pending a successful canary. Session identity, discoverability, and successful open/resume are independent claims. There is no flag-only promotion: a flag alone never promotes a capability. Claude agent/subagent identity is `yes` because the raw captures of a 2026-08-17 autopilot run showed explicit subagent task events (`subagent_type`, `task_id`, completion `status`/`summary`), which is event evidence, not a flag. OpenCode native session identity and open/resume are `yes` on the same principle: a real autopilot run's raw capture showed a `sessionID` on every structured event (event evidence, not a flag), `opencode session list --format json` returned persisted sessions on a live install, and `opencode run --session <session-id>` is the documented resume invocation.

| Harness and mapped command | Structured baseline | Agent/subagent identity | Native session identity | Native discovery | Native open/resume | Display name | Parent link | Native stop |
|---|---|---|---|---|---|---|---|---|
| Claude Code — command 1 below | yes | yes | yes | unproven | unproven: `claude --resume <session-id>` is a hint only | yes | unavailable | unavailable |
| Codex — command 2 below | yes | unavailable | yes | yes: `codex resume --include-non-interactive` | yes: `codex exec resume <thread-id>` | unavailable | unavailable | unavailable |
| OpenCode — command 3 below | yes | unavailable | yes | yes: `opencode session list --format json` | yes: `opencode run --session <session-id>` | yes | unavailable | unavailable |

The exact supported invocations currently mapped by `adapters/headless.mjs` are:

1. `claude -p <prompt> --dangerously-skip-permissions --allowedTools Task,Bash,Glob,Grep,Read,Edit,Write,TodoWrite,Skill --output-format stream-json --verbose --forward-subagent-text --name <display-name>`
2. `codex exec --dangerously-bypass-approvals-and-sandbox --color never --json <prompt>`
3. `opencode run --auto --format json --title <display-name> <prompt>`

When a task's model tier resolves to a concrete model, the adapter also passes `--model <model>`: at the end of the Claude arguments, before `exec` for Codex, and before the prompt for OpenCode.

A local canary run observed a Claude source session ID, so identity remains `yes`, but did not observe a picker/list and ended in an API error before a resumed request completed; Claude discovery and open/resume therefore remain `unproven`. That 2026-08-17 autopilot run's raw captures recorded explicit subagent task events (`system/task_started`, `system/task_progress`, `system/task_notification`, `system/task_updated`) carrying `subagent_type`, `task_id`, and a completion `status`/`summary`, which is the event evidence behind Claude agent/subagent identity being `yes`. A 2026-08-19 autopilot run's raw captures (`phase-*-attempt-*.raw.jsonl`) recorded OpenCode's real `--format json` event vocabulary — `step_start`, `text`, `tool_use`, `step_finish` — each carrying a top-level `sessionID`, which is the event evidence behind OpenCode native session identity being `yes`; the same sessionID is what `opencode session list --format json` lists and what `opencode run --session <session-id>` resumes. Codex was absent from the local canary environment, which is an availability result rather than a contradiction of its documented command baseline. Parent-link and native-stop data are unavailable in every current descriptor. Claude's `--forward-subagent-text` requires Claude Code >=2.1.211; it does not itself prove agent/subagent identity.

The source snapshot for this matrix is 2026-08-19 against steepy-apex v0.8.5 and the command map in `adapters/headless.mjs`. Planning used the official [Claude Code CLI usage](https://code.claude.com/docs/en/cli-usage) documentation (forward-subagent requirement, name and resume), the [Codex CLI reference](https://developers.openai.com/codex/cli/reference), [Codex non-interactive documentation](https://developers.openai.com/codex/noninteractive), and the [OpenCode CLI documentation](https://opencode.ai/docs/cli/).

## Gear-3 phase context and handoffs

How the phases of the [Gear-3 workflow chain](workflow.md#gear-3-the-workflow-chain) load their context and hand off to each other.

Autopilot phases start fresh from deterministic, versioned role manifests: required artifacts are eagerly loaded; named missing facts are the only `onDemand` upstream-document reads, and verdict/gear/drive come from manifest contract scalars rather than an automatic spec reload. The manifest is a context-loading protocol, not repository access control, so agents still inspect source needed to implement and verify work. Modular routes preserve the exact core and leaf links. Plan matches each required core's mini-routing conditions against the required spec's exact paths/topics; review matches them using only its required criteria-only artifact, task-result index, and branch diff; implement matches task exact paths/topics. Each phase reads every matching leaf from its declared inventory and records a concrete reason. Zero matches means core only, with no read-all fallback; unrelated leaves stay unloaded. Selected task leaves become required task-local inputs in mini-routing order. Children write their durable report before returning the drive's completion envelope (three fields in autopilot, four in manual drive); the implement skill/controller validates that artifact-first completion, then carries artifact references rather than report bodies. Review receives an attributed criteria-only artifact, the exact task-result index, and `branch-diff.txt`, never the full spec body as required criteria. The criteria artifact and the aggregate diff are derived by the conductor from the spec and from `git`, so the review gate never turns on whether a child remembered to write them; the index, which only implement can author, is parsed by implement itself before it claims completion.

Fresh brainstorm derives coverage and gear from your request, stable routed rules and source—not
historical specs or logs. It follows the actual single standard or modular core plus matching leaves,
recording each match rather than guessing filenames. Regular review needs only criteria, the compact
task index and diff, including for a proposed version bump; the bump/PR decision remains human.

Manual handoffs authorize exact paths, including both sides when resuming publication: plan adds
`onDemand.output-plan`, implement requires `progress-ledger` and `task-results` (and `source-spec`
for plan-backed entry), and regular review adds `onDemand.review-report`. Each phase publishes its
verified output READY first, then marks its input CONSUMED in a separate per-file replacement.
An interruption leaving READY/READY is repaired only after checking the same pair's provenance,
approval and verification; a verified CONSUMED/READY pair is a no-op. Missing capability/proof or a
mismatched pair stops without selecting recent files. These instructions are model-based; content
tests are not deterministic enforcement or a claim of multi-file atomicity. Gear-4 controller
recovery remains a separate deterministic protocol.

An implementer that unexpectedly had to discover what to change records DONE_WITH_CONCERNS and
`discovery:unplanned`. That exact signal survives fixes and the task-result index. Review reports it
separately from ordinary or unattributed concerns: DONE_WITH_CONCERNS alone is not discovery proof.

## Autopilot live-observability boundary

The headless path has a deliberately one-way dependency direction:

```
adapters/headless.mjs ── command descriptor ──► scripts/autopilot.mjs
adapters/headless-events.mjs ── decoded event ─► scripts/autopilot.mjs
scripts/autopilot-observability.mjs ── bridge primitives ─► scripts/autopilot.mjs
```

`adapters/headless.mjs` owns only the harness command descriptor and declared native capabilities. `adapters/headless-events.mjs` owns only protocol decoders for one structured output line; it does not choose persistence, timeout, or halt policy. `scripts/autopilot-observability.mjs` owns the common event envelope, line framing, raw serialization/redaction, curated rendering, and the bounded writer. `scripts/autopilot.mjs` owns orchestration: attempts, versioned manifests, artifact timing, status correlation, child lifetime, and the user-facing halt decision. The implement skill/controller validates artifact-first completion and the selected envelope before the next task decision: manual drive uses four fields, while autopilot uses status/artifact/signals and receipt-derived source paths. That controller routes an effective abstract controller tier; adapters apply or degrade the concrete model and return direct provider evidence. The adapters never import conductor policy, and the bridge never selects a harness command.

For each child stdout/stderr line, the conductor uses a raw-first flow: frame → serialize immutable raw JSONL → decode into the common event envelope where possible → curate the readable per-attempt and aggregate logs → write the same compact curated event to the bounded stdout/stderr live destination. Ordinary plain decoder failures use a source-labelled, redacted, length-limited passthrough; unknown or malformed structured data uses a generic fallback so arbitrary metadata and reasoning cannot enter the readable or live view. Reasoning and token deltas are never promoted.

The bridge enforces bounded backpressure across raw, readable, aggregate, and live destinations: it pauses a source while a required writer drains and bounds partial lines and pending writes. Its policy is intentionally hybrid. Failure to open, redact, fully write, or drain the immutable raw destination is blocking: the conductor terminates the whole child process group and halts. A readable, aggregate, or live destination write/drain failure is non-blocking: it records `OBSERVABILITY_DEGRADED`, disables that destination, and continues through the durable raw capture plus any healthy curated destinations.

The resource JSONL usage ledger is append-only and scoped to run, phase, and attempt. It records each direct provider measurement once with a non-content-revealing source-event fingerprint: exact retransmissions deduplicate, while distinct provider phase aggregates from one session remain separate. Those distinct phase aggregates must not be summed unless provider evidence establishes disjoint scopes. Derived displays read the records rather than re-recording them, but persistence deduplication alone does not establish additivity. The ledger is observational evidence for context efficiency, never a budget or a healthy-work stop condition: the `budget` field is rejected on fresh and resumed gear-3 contracts, and no fixed resource quota terminates healthy work.

Process lifetime converges in `scripts/autopilot.mjs`: terminal interruption, optional native stop, explicit safety/failure condition, and a blocking bridge failure all enter one stop path, send `SIGTERM` to the detached child group and escalate to `SIGKILL` after a short grace through the shared `scripts/process-group.mjs` primitive that loop-engineer and both evidence collectors also use, close destinations once, and settle the attempt once. A bounded I/O integrity timeout may protect a stalled read, write, or drain operation; it is not a phase duration or work timer. A live child that emits no output therefore remains active until it exits or receives an explicit stop; the conductor does not infer a hang from silence. This keeps descendants from outliving a halted phase. The entire path uses Node >= 24 built-ins only and has zero runtime dependencies.

The Gear-3 authority sequence is checkout lease and locked preflight → versioned status-protocol
declaration/validation → correlated child evidence plus process-group convergence → conductor-authored
`PHASE_ACCEPTED` → verified lease release. A failure before acceptance records a correlated halt when
durable status exists and never promotes the child's completion claim; an unverifiable release fails
the run and preserves the ambiguous generation for recovery. The lease is per physical checkout, so
parallel conductors require distinct Git worktrees. Deterministic process-group ownership is offered
only on tested `linux` and `darwin`, owns only the group it spawned, and is neither OS sandboxing nor
containment of descendants that deliberately escape that group.

### Attempt evidence, status stream and resume inputs

The attempt log files are listed in the [workflow guide](workflow.md#autopilot-live-observability).

The status stream correlates every run, attempt, and discovered session: `run-id`, phase, attempt, display name, readable/raw filenames, then `session-id` plus the descriptor's native identity/open-resume states and qualification. An `ATTEMPT_RESERVED` event durably claims the attempt number before any create-only manifest or log is written, so a crash in artifact preparation cannot collide with that path on resume. A `BASELINE` event records the commit the run starts from, once, so a resumed run keeps it and the aggregate diff still spans the whole chain. A spec's cross-cutting entry that matches no routing row loads no standard and is recorded as `CONTEXT_SURFACE_IGNORED` rather than halting the phase; an unrouted owning or per-task surface still halts as a binding error. Supported references are labelled `open`/`resume`; an `unproven` command is labelled only as an `open-hint`/`resume-hint`. On resume, already-completed phases are skipped, but an unfinished phase always receives a **new attempt** number and new immutable files; no earlier attempt is overwritten. Resuming an `implement` phase that stopped at the fix-round cap restarts that review-fix loop: the new attempt records the restart in the ledger and gets a fresh set of fix rounds.

When an unfinished implementation needs additional existing evidence, name each exact
repo-relative path with repeatable `--resume-input <path>` arguments to
`node <engine-root>/scripts/autopilot.mjs <spec-path>`, where `<engine-root>` is the installed
steepy-apex plugin directory (API: `runConductor(specPath, { resumeInputs })`).
Each file must be inside the selected spec's task directory. The conductor checks the
bindings before acquiring the lease and again before publication, then adds them only
to the new implement manifest's `onDemand` inventory. It reads metadata rather than file
bodies and never scans for sibling or recent artifacts. Missing files, aliases, globs,
duplicates (including physical case aliases of inputs or the already inventoried ledger/index), other-run paths, symlinked
ancestors/targets and hardlinks are rejected. Existing manifests and logs stay immutable;
plan/review inventories and the run's pinned task-result protocol stay unchanged. These
capabilities provide context, not approval: malformed results still require the existing
recovery protocol and fresh valid review evidence.

## `hooks/` — the Stop hook

`hooks.json` registers a single Claude Code `Stop` hook that runs `stop-hook.mjs` at the end of every turn. `hooks-codex.json` declares Codex wiring using `$PLUGIN_ROOT`; native loading and protocol compatibility depend on the host version and require a real-host check. On a compatible host, violations produce a `decision: block` response; coherent or absent hubs stay silent. The hook does not re-block while `stop_hook_active` is set. The path is quoted to survive spaces. When native hooks are unavailable, `check` and `review` remain the explicit gates. The build prepared for the Claude plugin directory, where steepy-apex is not listed yet, ships without this folder, because the directory accepts command hooks only from Verified organizations.

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
- **Autopilot:** `autopilot` (headless command builder, contract parser + refusal guards, and the conductor drive loop — hermetic fake-harness children, real signals, process-group kill verification).
- **Fixtures:** `good-hub` / `bad-hub` (linter cases) and `pnpm-*` / `single-pkg` (stack-detection cases).

## Local usage reports

`node <engine-root>/scripts/cost-report.mjs --repo-root <root> [--harness <id>]`, where
`<engine-root>` is the installed steepy-apex plugin directory, reports raw token
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
| Review/controller workflows | Run declared tests, Git, and supported harness subprocesses; Gear-3/4 create confined work state and require their stated authorization. Headless harness children start with `--dangerously-skip-permissions` (Claude Code), `--dangerously-bypass-approvals-and-sandbox` (Codex), or `--auto` (OpenCode). |
| Release evidence validation | Reads package inputs, invokes `npm pack --dry-run` and Git, and uses an OS temporary cache; it never invokes a provider. |
| Model mapping verification | Its injected inputs support an offline test path; live mode invokes the OpenCode catalog and fetches provider provenance. |
| Inception | Writes `.apex/inception/` and the application's files; runs the approved tools (installs, generators, builds, tests); may reach official sources and package registries; remote operations only after explicit authorization. |
| Installation and native canaries | Host installation, authenticated sessions, and a genuine canary may use host caches, credentials, subprocesses, and network according to the host. |

Inception effect ownership stays with the coordinator: children can research or edit assigned bootstrap source, but request installs/generators/migrations/remote operations rather than executing them. The state helper owns descriptor mutation and short scaffold-lease publications; schema and snapshot modules never execute application commands. The collector is the single approved-check execution boundary, with registered identity, sealed separate streams, and no command replay during recovery. Governance receipts certify exact init outputs only, preserving the completed run and unmanaged application bytes. These are cooperative writer guarantees, not an adversarial local-filesystem security claim.

`init` writes `.apex/` governance files and the managed root/bootstrap plus native
Claude/Codex/OpenCode agent triads in the target project. This does not promise that
every command writes only there; review the command family before granting trust.

As with any plugin, review plugin hooks before trusting them: the full hook wiring is three small files, [`hooks/hooks.json`](https://github.com/steepy-it/steepy-apex/blob/main/hooks/hooks.json) (Claude Code), [`hooks/hooks-codex.json`](https://github.com/steepy-it/steepy-apex/blob/main/hooks/hooks-codex.json) (Codex), and [`scripts/stop-hook.mjs`](../scripts/stop-hook.mjs). The build prepared for the Claude plugin directory ships no hooks.

### Autopilot task execution receipts

Fresh runs record TASK_RESULT_PROTOCOL 2 once and pin it in all phase and task-role manifests;
a resumed run lacking protocol 2 halts before dispatch (finish manually or start fresh). Manual drive
and Gear 4 are unchanged. The controller
records an exact task execution prefix in the authorized ledger before dispatch, captures the raw
semantic response and source observation, freezes the report, and publishes the result. Each file
uses staged fsynced atomic publication under the cooperating-writer lease; this is neither a
multi-file transaction nor protection from hostile concurrent writers. A durable capture can finish
publication on restart without repeating implementation. Baseline-only state cannot establish DONE.

JSON receipts are machine authority; the Markdown index is their generated projection, with exact
changedPaths arrays and retained lifecycle/reviewer references. Git filenames containing spaces,
commas, semicolons, Unicode, or newlines remain literal JSON strings. No brace expansion or model path
claim determines the changed set. A response carrying changed-paths is malformed; semantic
status/artifact/signals never come from report prose. Receipts retain cumulative task paths and each
execution's own paths, frozen reports, and the distinct same-task previous/global parent links.

Exact recorded state and schema-authorized links confined to the same task directory authorize only
machine replay, never work-directory scanning or extra child inputs. Source discovery remains normal.
Captured execution is review-pending, not approved. Task approval binds the latest execution; a fix
invalidates an older approval. Final review and conductor acceptance replay the receipt chain and
all required task/final approvals. No historical baseline is fabricated and no run is upgraded. Real-Git and isolated regression replay evidence does not certify native model behavior or
product correctness.

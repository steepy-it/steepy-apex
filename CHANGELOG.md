# Changelog

## v1.2.0 (2026-10-13)

- New skill `/steepy-apex:inception`: turns an idea and its materials into a minimal, verified,
  runnable first version before the hub exists. It runs reconnaissance, architecture decisions
  with a decision register, versions verified from official sources, one human approval,
  bootstrap of one representative path, and final verification, then points to `init` and
  `discovery`. It is not a gear and has no headless or autopilot mode.
- The run lives under `.apex/inception/` as a v2 descriptor with immutable records, persisted
  work units with one active writer, reserved publications, and exact-ref resume. Every
  registered decision must be covered by the latest approval.
- New helpers: `inception-state.mjs` records and verifies the run and alone writes its
  descriptor; `inception-protocol.mjs` validates the formats; `inception-snapshot.mjs` takes full
  content/mode application snapshots; `capture-inception-evidence.mjs` runs one approved check and
  seals its output; `inception-governance.mjs` certifies the first `init` after a complete run.
  No tool deletes a run.
- Snapshots leave the reserved areas, recognized scaffold leases, and exact exclusions out of
  both the inventory and Git status: before approval the exclusions bound by `start --exclusions-stdin`
  (for example installed dependencies), from approval the contract's. Application names are
  literal, so a route like `app/[id]/page.tsx` is an ordinary file. Neither Git nor a clean tree
  is required.
- `validate-hub` excludes `.apex/inception/` like `.apex/work/` and rejects stable links into it.
  Before a hub exists, a valid run descriptor makes it exit 0 with the run's phase and next step,
  and the Stop hook stays silent.
- `init` keeps its interview. After a complete run, `inception-governance.mjs` `prepare`,
  `documents`, and `finish` certify the first init: only `documents` writes the stable hub
  documents, exact bytes at mode 0644, and init-provenance receipts bind them to the completion.
- `discovery` offers an inception source for a complete run. Read-only `verify-complete` first
  checks the evidence and the current application, before discovery writes anything; accepted
  decisions go only to `conventions.md`, the routed standards, and `glossary.md`. The import is
  one-time: a later run sees the certified documents drift and refuses the source.
- Breaking (released as a minor version by decision): v1.2.0 drops every compatibility path for older formats.
  - Specialist adapters rendered by v1.0.0–v1.0.6 are no longer recognized. An untouched one is a `customized` conflict: a `validate-hub` error that blocks the Stop hook. Run `init` repair, or `new-surface` with `--resolution <id>=replace` in an active hub, and choose `replace`. `templates/prior/` is gone.
  - Autopilot runs started on task-result protocol 1 cannot resume: the conductor halts with an unsupported-protocol reason. Finish such a run manually or start a fresh run. In autopilot, implementer, fix and reviewer responses carry exactly `status`, `artifact`, `signals`; a response with `changed-paths` is malformed. `skills/implement/reviewer-response.schema.json` is removed. Manual drive keeps its four-field grammar and `- Task` bullets. An in-flight protocol-2 run whose retained reviewer or task responses carried `changed-paths` also halts on resume; finish it manually or start a fresh run.
  - Inception run descriptors with schema `steepy-inception-run/v1` are refused by every command, `abandon` included; no tool migrates, archives or deletes them. Move `.apex/inception/` out of the repository by hand, including `abandon-intent.json` and `abandoned/` left by an earlier archive, then start a fresh run.
  - A child autopilot status note that carries `phase=` no longer completes a phase. The shipped chain skills already write only `run-id` and `attempt`; drop `phase=` from any custom child or hand-written status marker.
- The dsh, OpenCode, and Pi adapters, the packaging, and the docs list ten skills.
- `docs/inception.md` is the user guide; `docs/inception-acceptance.md` defines the native
  acceptance runs, still not run and a release gate.

## v1.1.7 (2026-10-13)

- `brainstorm` Step 5 applies the spec machine contract to gear-2 specs too: `Owning surface`,
  `Cross-cutting surfaces`, `Feature complexity`, one `## Success criteria` heading and
  `SC1`…`SCn` IDs. It used to name only gear-3 specs, while the Step 5.5 self-review checked
  these fields at gear 2 and direct Gear-2 `implement` copies them into its task brief. A gear-2
  run wrote the spec without them, then the self-review added them back.
- `Feature complexity` now sits in the machine-contract field list instead of a sentence after it,
  and the gear-2 ceremony says its light spec still carries that contract.
- A workflow-skills test keeps the contract unscoped from gear 3.

## v1.1.6 (2026-10-12)

- `.claude-plugin/plugin.json` declares the four Claude directory listing links:
  `documentationUrl` (`docs/`), `supportUrl` (GitHub issues), `privacyPolicyUrl`
  (`PRIVACY.md`) and `termsOfServiceUrl` (`LICENSE`).
- `PRIVACY.md` is the plugin's privacy policy: no server, no telemetry, no personal data,
  and the same external-services table as the README section "Data and external services",
  which now links to it.
- A release-metadata test checks that each listing link points at a file on `main` and that
  the two external-services tables stay identical.
- `RELEASE.md` notes that the directory reads the listing's links and keywords once, from
  the version the submission was created at.

## v1.1.5 (2026-10-09)

- The autopilot conductor's safe-mode secret redaction runs in linear time. A quoted value
  that never closes and is full of double-escaped newlines, like a truncated
  `<persisted-output>` preview, used to backtrack exponentially and freeze the conductor's
  event loop: 20 such newlines took about 16 seconds. It now takes under a millisecond.
- A long run of letters, digits, `-` and `_` with no `:` or `=` no longer costs quadratic
  time: 400 KB took over 30 seconds, and a 1 MiB line now takes about 120 ms. The key
  before `:` or `=` is matched up to 64 characters; every sensitive key is far shorter.
- Regression tests cover both shapes, plus whole quoted values with escaped quotes and
  `--token=`-style flags.

## v1.1.4 (2026-10-07)

- `package.json`, both plugin manifests and the Claude marketplace entry carry the same
  eleven search keywords: `context-engineering`, `workflows`, `skills`,
  `spec-driven-development`, `code-review`, `subagents`, `autonomous-loops`,
  `project-knowledge`, `documentation-drift`, `agents-md` and `model-selection`.
- The Claude marketplace entry declares category `development`.
- Both plugin manifests declare `homepage`, `repository` and `license`.
- A release-metadata test keeps the four keyword lists identical.

## v1.1.3 (2026-10-07)

- The plugin description now reads "Context engineering and governed workflows for AI
  coding agents. Keep project knowledge coherent, route work to specialists, and scale
  from small fixes to bounded autonomous loops." It replaces the old scaffold tagline in
  `package.json`, both plugin manifests and both marketplace files.
- The dogfood `AGENTS.md` and the five Codex agent files are regenerated through the
  public scaffold CLI with the new project description.

## v1.1.2 (2026-10-07)

- The README has a "Data and external services" section. It states that steepy-apex has
  no server and sends no telemetry, and lists the services skills reach: the autopilot
  harness's model provider, the public model pages that `check` reads, and GitHub for the
  pull request that `review` opens after confirmation.

## v1.1.1 (2026-10-07)

- The Release workflow appends one payload commit per new version to the
  `claude-directory` branch, which the Claude plugin directory tracks.
  `scripts/publish-directory-branch.mjs` builds it from the release commit minus
  `tests/`, `.github/`, `.codex-plugin/` and `CLAUDE.md`. The branch is append-only
  and never force-pushed; a version it already carries is skipped.
- `.claude-plugin/` ships the directory listing icon, a byte copy of the Codex plugin icon.
- The workflow gears diagram drops a non-standard metadata chunk, and `docs/workflow.md`
  no longer embeds it.
- `RELEASE.md` and `COMMUNITY_SUBMISSION.md` describe submission through the developer
  portal on branch `claude-directory`, and the UTF-8 log encoding that publishing hosts need.

## v1.1.0 (2026-10-06)

- Specialist adapters reach their standard through the surface's row in the routing
  table in `.apex/_INDEX.md` instead of a `standards/<surface>.md` path, so a surface
  split into the modular form keeps a valid untouched adapter. Claude and OpenCode
  descriptions now name the surface and its path, so each specialist is distinct.
- A digest-pinned registry of prior canonical renderings (`templates/prior/v1.0/`)
  recognizes untouched v1.0.0-v1.0.6 adapters as stale: `validate-hub` warns instead
  of erroring, and the scaffold planner updates them with no conflict question.
- `new-surface --repair` reports each adapter as created, updated, or preserved, and
  lists every other file it writes.
- Upgrade note for existing hubs: the specialist adapter templates changed while their
  generated provenance stayed `v1`. Untouched v1.0.0-v1.0.6 adapters stay valid:
  `validate-hub` exits 0 with one warning per adapter (silent under `--quiet` and in
  the Stop hook), and `/steepy-apex:init` repair or `/steepy-apex:new-surface` rewrites
  them to the current rendering with no conflict question. An adapter changed by even
  one byte or line ending remains a `customized` conflict with `replace` or `abort`.

## v1.0.6 (2026-10-06)

- Correct stale hub facts: the glossary's managed-block markers and template names,
  implement's reference to a nonexistent init Step 4.5, and brainstorm's list of
  harnesses without a headless mode.
- State current rules only in the brainstorm, plan, implement, and review skills:
  drop references to the old `Status: DRAFT` prose marker, the undefined "gate 8",
  and other text written as a diff against earlier versions.
- Keep between-task updates brief instead of capping them at one line, and drop the
  reader-compatibility aside from the writer-side status timestamp rule.

## v1.0.5 (2026-09-29)

- Move the OpenAI tier ladder to GPT-6: `gpt-6-luna` / `gpt-6-sol` / `gpt-6-sol`.
  `gpt-6-astra` stays off the ladder, as Fable does, and is reached only by a
  ledgered override.
- Move the DeepSeek `cheap` tier to `deepseek-flash` (V4.1-Flash); the retired
  `deepseek-v4-flash` is only routed to it.
- Keep Anthropic's `haiku` / `sonnet` / `opus` aliases, which now resolve to
  Haiku 4.5, Sonnet 5.5, and Opus 5.5.

## v1.0.4 (2026-09-18)

- Let halted Gear-3 implementation runs receive exact additional evidence through
  repeatable `--resume-input` arguments or the `resumeInputs` API option.
- Bind those files only to the new implementation attempt's on-demand inventory,
  preserving previous evidence and the run's recorded task-result protocol.
- Reject missing, foreign-run, linked, or duplicate inputs before changing run state,
  including physical case aliases of other inputs, the ledger, and the task-result index.

## v1.0.3 (2026-09-18)

- Derive Gear-3 task changed paths from Git-backed execution receipts so abbreviated
  implementer paths cannot block otherwise valid results.
- Preserve immutable task evidence and cumulative changes across fixes, and resume
  captured work at independent review without repeating implementation.
- Allow explicit retries after resolving valid NEEDS_CONTEXT or BLOCKED results,
  while continuing to reject malformed, incomplete, or changed evidence.
- Validate every execution ancestor against its original phase manifest before
  accepting implementation, including retained approvals on resume.
- Keep existing runs on their recorded protocol and use protocol 2 for fresh runs.

## v1.0.2 (2026-09-18)

- Validate Gear-3 reviewer responses and bind task and final approvals to durable
  evidence before accepting implementation completion.
- Allow one response-only correction for a malformed reviewer changed-paths field,
  preserving the verdict, artifacts, and implementation.
- Revalidate retained approvals on resume and advance review references after fixes
  without overwriting earlier attempt evidence.
- Accept unstaged directory deletions in review snapshots while continuing to reject
  symlink ancestors and detect subsequent source changes.

## v1.0.1 (2026-09-18)

- Authorize the task-result index as an on-demand implementation input, allowing
  halted Gear-3 runs to validate prior progress without requiring fresh outputs.
- Clarify that task reviewers returning `ISSUES_FOUND` must reference the issue
  artifact directly; malformed responses still block without completing the task.
- Add synthetic halt/resume coverage for a third task after two completed tasks,
  including preservation of earlier attempt manifests and logs.

## v1.0.0 (2026-09-16)

First public release.

- Scaffold a governed `.apex/` hub with project instructions, surface standards,
  specialist routing, and a documentation coherence linter.
- Provide nine shared skills for setup, discovery, checks, surface registration,
  brainstorming, planning, implementation, review, and bounded autonomous loops.
- Package native integrations for Claude Code, Codex, OpenCode, Pi, and DeepSeek Harness.
- Scale workflow ceremony from small fixes to spec-driven development; support
  deterministic Gear-3 autopilot and Gear-4 loops on Claude, Codex, and OpenCode.
  Pi and DeepSeek explicitly report `runner-unavailable` for those controllers.
- Keep work artifacts local and gitignored, with explicit handoffs, durable execution
  evidence, crash recovery, and observable resource usage.
- Ship dependency-free Node.js 24 tooling, portable scaffolding and repair, release
  validation, and installation, workflow, architecture, and security documentation.

This changelog starts with the public release line.

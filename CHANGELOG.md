# Changelog

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

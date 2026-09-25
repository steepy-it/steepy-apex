# Changelog

## v1.1.0 (2026-09-25)

- Add the pre-hub `inception` skill, the tenth canonical skill: it takes a new application
  from its starting materials to an approved, verified bootstrap before any hub exists,
  then hands it to `init` through the exact `inception-handoff: steepy-apex/v1` transfer.
- Add `inception-paths.mjs`, `inception-state.mjs`, and `inception-handoff.mjs` for the
  ignored local `.apex/inception/` area, its closed v1 descriptor, byte-bound approval,
  code checkpoints, and the per-decision init receipt.
- Give `init` an inception entry that reuses the confirmed record, fills every document
  it creates, and completes only after the hub gate and a versioned-files-only copy pass.
- Share one stable-document reader (`stable-paths.mjs`) across the linter and controllers;
  `validate-hub` recognizes a valid pre-hub inception without calling it a coherent hub.
- List all ten skills in the OpenCode, Pi, and DeepSeek Harness adapters; without a hub,
  they offer `inception` or `init` without starting either.
- Document the greenfield path (`docs/inception.md`) and its native acceptance protocol
  (`docs/inception-acceptance.md`); native proofs this release used a model approver.
- Upgrade note for existing hubs: the canonical bootstrap gained an `## Inception boundary`
  section while its generated provenance stayed `v1`. An untouched v1.0.0-v1.0.4 bootstrap
  stays valid: `validate-hub` exits 0 with one warning (silent under `--quiet` and in the
  Stop hook), and `/steepy-apex:init` repair or `/steepy-apex:new-surface` rewrites it with
  no conflict question. A bootstrap changed by even one byte or line ending remains a
  `customized` conflict. `validate-hub` and the workflow controllers now refuse a stable
  hub, root-instruction, or provider file with more than one hard link
  (`stable-read: <path> is hard-linked`); replace such a link with an ordinary copy.
- Mixed versions: a hub repaired by this release fails the 1.0.x linter and Stop hook
  (`canonical bootstrap ... is customized`) until every collaborator updates the plugin.
- Finalize now binds a complete init receipt through a durable finalization intent before
  replacing the prepared receipt, then records complete state only after verifying its
  exact digest and promoted contents. Crash retries with that intent recover without
  rewriting unexpected bytes; a legacy complete receipt beside a prepared descriptor
  without intent is ambiguous and refused, while ordinary prepared or already complete
  legacy runs remain usable. The finalization intent makes this recovery explicit, while
  the legacy ambiguous prefix is refused without rewriting either file. The state CLI
  cannot create the intent or complete init.
- Inception freezes approval and checkpoint references once init starts, refuses a
  promotion that reaches the same checkpoint file through a different mount, and
  rechecks create-only absence and ancestor identities before file publication.

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

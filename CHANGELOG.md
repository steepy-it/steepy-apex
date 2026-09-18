# Changelog

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

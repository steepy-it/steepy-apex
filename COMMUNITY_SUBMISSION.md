# steepy-apex community marketplace submission notes

## Identity

- Plugin name: `steepy-apex`
- Owner: `steepy-it`
- License: Apache-2.0
- Distribution target: Claude Code community marketplace
- Submission forms:
  - `https://claude.ai/admin-settings/directory/submissions/plugins/new`
  - `https://platform.claude.com/plugins/submit`

## Short description

Context engineering and governed workflows for AI coding agents. Keep project knowledge coherent, route work to specialists, and scale from small fixes to bounded autonomous loops.

## Positioning

Your AI documentation stops rotting.

steepy-apex creates a navigable `.apex/` documentation graph, routes work by surface, and validates that the graph remains coherent as the project evolves.

## What the plugin includes

- Nine canonical skills: `/steepy-apex:init`, `/steepy-apex:new-surface`, `/steepy-apex:check`, `/steepy-apex:brainstorm`, `/steepy-apex:plan`, `/steepy-apex:implement`, `/steepy-apex:review`, `/steepy-apex:discovery`, and `/steepy-apex:loop-engineer`.
- A Stop hook that runs the hub linter quietly when the hub is green.
- Node.js 24+ scripts for stack detection, hub validation, project scaffolding, and workflow controllers.
- Templates for `.apex/` hub files, surface standards, specialist agents, routing-table rows, a managed `AGENTS.md` root, a thin `CLAUDE.md` import, and a canonical project bootstrap skill.

## Runtime behavior and safety

- steepy-apex has five native harnesses: Claude Code, Codex, OpenCode, Pi, and DeepSeek Harness.
- It uses Node built-ins and has zero third-party runtime dependencies.
- **Command-family effects matrix:** filesystem reads–writes–subprocesses–temporary state–providers/network are command-specific. Local validation/scaffolding, session-store reporting, version writes, review/controllers, release evidence, live model mapping, and native installation/canaries have distinct effects.
- Users should review the Stop hook during Claude Code plugin trust review.

## Validation before submission

Run from the repository root:

```bash
npm test
claude plugin validate .
```

Then run the local marketplace and throwaway repo smoke tests documented in `RELEASE.md`.

## Review notes

- This is a community/open-source plugin submission.
- The plugin does not claim Anthropic endorsement.
- Claude Code, Codex, OpenCode, Pi, and DeepSeek Harness each have shipped native installation wiring; host capabilities and deterministic runner support differ by harness.

## OpenAI submission preparation

Use the Skills-only route in [OpenAI's submission guide](https://developers.openai.com/plugins/deploy/submission).
The following are proposed reviewer scenarios, not completed test results. Run them on the
final imported package in a repository-capable environment with Node 24 and Git.

| Type | Scenario | Expected behavior |
|---|---|---|
| Positive | Initialize a small disposable Node repository with a working test command. | Interview completes; managed root, bootstrap, and routed hub are generated; check passes. |
| Positive | Run check on a coherent generated hub. | Reports coherence without changing project files. |
| Positive | Add a documentation link to a missing file, then run check. | Reports the broken reference with an actionable location. |
| Positive | Brainstorm a small covered change and approve the resulting spec. | Publishes a READY local spec and the appropriate next-phase handoff. |
| Positive | Add a new surface to an initialized project. | Registers its standard, routing, and native adapters; a repeated identical request is a no-op. |
| Negative | Request an autonomous loop without a complete goal or commit authorization. | Refuses autonomous execution and identifies the missing inputs. |
| Negative | Request a handoff pointing outside the authorized local work area. | Rejects that handoff without searching for another recent artifact. |
| Negative | Request deterministic Gear-4 execution through Pi or DeepSeek. | Reports runner-unavailable without claiming an autonomous run. |

Starter prompts: “Initialize a governed hub for this repository”; “Check this project's
documentation graph”; “Help me specify a small change and choose the appropriate workflow.”

Publisher-owned items still needed: verified developer/business identity, public website/support,
privacy policy and terms URLs, country availability, and observed results for these scenarios.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-stacked-dark.svg">
    <img alt="steepy-apex" src="assets/logo-stacked-light.svg" width="300">
  </picture>
</p>

<p align="center"><em>Keep your AI on the apex.</em></p>

<p align="center">
  <img alt="CI status on main" src="https://img.shields.io/github/actions/workflow/status/steepy-it/steepy-apex/release.yml?branch=main&label=CI&style=flat-square&labelColor=1B3149">
  <img alt="latest release" src="https://img.shields.io/github/v/release/steepy-it/steepy-apex?style=flat-square&labelColor=1B3149&color=4A515B">
  <img alt="node ≥ 24" src="https://img.shields.io/badge/node-%E2%89%A5%2024-4A515B?style=flat-square&labelColor=1B3149">
  <img alt="license Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-4A515B?style=flat-square&labelColor=1B3149">
</p>

steepy-apex is a plugin for Claude Code, Codex, OpenCode, Pi, and DeepSeek Harness. It keeps your project's rules in a versioned `.apex/` hub of Markdown docs, checks that the hub's links and code references still resolve, and sizes the workflow to each task.

The generated instructions send your agent to the hub before each task: your conventions, vocabulary, and which specialist agent owns each code area. Started through `/steepy-apex:brainstorm`, a fix the hub's rules already decide goes straight to an edit; a risky change goes through spec, plan, implement, and review.

**Status:** actively developed since v1.0.0 (September 2026); see the [changelog](CHANGELOG.md). Install from GitHub; it is not on npm or in the Claude and Codex plugin directories. Requires **Node.js >= 24** and Git.

## Why steepy-apex

- **One source for every agent on the team.** `init` writes a shared `AGENTS.md`, a `CLAUDE.md` that imports it, and specialist agents for Claude Code, Codex, and OpenCode from one project model. Teammates on different agents follow the same rules.
- **Docs that fail loudly when they drift.** The hub linter reports docs that nothing links to, broken links, agents missing from the routing table, and cited file paths that no longer exist. In Claude Code it also runs as a Stop hook at the end of every turn; in Codex it depends on the Codex version.
- **Process sized to the task.** `brainstorm` checks each task against the hub and picks one of four process levels (gears), from a direct edit to a bounded autonomous loop you authorize. Where the agent allows it, each task runs on a [model tier matched to its difficulty](docs/workflow.md#model-selection).
- **Plain files, no service.** The hub is Markdown in your Git history, reviewable in pull requests. No server, no telemetry, zero third-party runtime dependencies.

**When it is not the right tool:** a small script, or a project where one hand-kept `AGENTS.md` is enough. `init` auto-detects project areas (surfaces) only in JavaScript and TypeScript workspaces; other stacks declare them during setup. `review`, inception checks, autopilot, and Gear-4 loops need Linux or macOS, not Windows; autopilot and Gear-4 also need Claude Code, Codex, or OpenCode.

## Quick start

**Claude Code**, inside a session:

```text
/plugin marketplace add steepy-it/steepy-apex
/plugin install steepy-apex@steepy-apex
```

Run `/reload-plugins` (or restart Claude Code), then open your project and run `/steepy-apex:init`.

**Codex**, in your terminal:

```sh
codex plugin marketplace add steepy-it/steepy-apex
codex plugin add steepy-apex@steepy-apex
```

Start a new Codex session in your project and run the steepy-apex `init` skill (`$init`).

**OpenCode, Pi, and DeepSeek Harness** install from a clone or a Git tag: follow [the installation guide](docs/installation.md). It also covers local checkouts, troubleshooting, and [upgrading an existing hub](docs/installation.md#upgrading-an-existing-hub).

## Get started

Each harness (the coding agent you run steepy-apex in) has its own [command syntax](docs/installation.md#command-syntax-by-harness); Claude Code is shown here.

1. `/steepy-apex:init` - Initialize steepy-apex in your repo. Creates the `.apex/` hub, project instructions, and the local `.apex/work/` area for gitignored specs/plans.
2. `/steepy-apex:discovery` - Populate the hub from an existing codebase, reviewing each proposal.
3. `/steepy-apex:check` - Verify documentation coherence. On a healthy hub the linter reports `steepy validate-hub: OK — doc graph is coherent`. Then start a task with `/steepy-apex:brainstorm`.

Starting from an idea or a prototype? Run `/steepy-apex:inception` first. It ends by pointing to `/steepy-apex:init` and `/steepy-apex:discovery`. See the [inception guide](docs/inception.md). Inception is new: its runs in real harnesses have not completed the [acceptance protocol](docs/maintainers/inception-acceptance.md) yet.

The generated bootstrap reads `AGENTS.md`, follows `.apex/_INDEX.md` routing, and invokes workflows by semantic skill name.

## What `init` adds to your repository

| Path | What it is |
|---|---|
| `.apex/` | The hub: routing table (`_INDEX.md`), conventions, glossary, testing checklist, and one standard per surface. Versioned. |
| `.apex/work/` | Specs, plans, and run logs. Gitignored: a local work artifact that stays on your machine. |
| `AGENTS.md`, `CLAUDE.md` | Shared root instructions in a managed block; `CLAUDE.md` imports `AGENTS.md`. |
| `.agents/skills/`, `.claude/skills/` | The project bootstrap skill, plus a thin Claude stub that points to it. |
| `.claude/agents/`, `.codex/agents/`, `.opencode/agents/` | One specialist agent per surface for each of those harnesses. |

If `AGENTS.md` or `CLAUDE.md` already exists, `init` adds its managed block and keeps your text. If a generated file was edited or already exists with other content, `init` asks before replacing it. Other commands can run Git, tests, and model providers: the [effects matrix](docs/architecture.md#command-family-effects-matrix) lists what each one touches.

## Skills

Claude Code syntax is shown below; see the [installation guide](docs/installation.md#command-syntax-by-harness) for other harnesses.

| Skill | Purpose |
|---|---|
| [`/steepy-apex:inception`](docs/inception.md) | Turn an idea and its materials into a verified first version before the hub exists. |
| `/steepy-apex:init` | Set up the project hub. |
| `/steepy-apex:discovery` | Populate or refresh project knowledge. After inception, import its decisions once. |
| `/steepy-apex:check` | Check documentation coherence. |
| `/steepy-apex:new-surface` | Register a project area and its specialist. |
| `/steepy-apex:brainstorm` | Turn an idea into a spec. |
| `/steepy-apex:plan` | Break a spec into implementation tasks. |
| `/steepy-apex:implement` | Implement a spec or plan with tests. |
| `/steepy-apex:review` | Verify the result against the spec. |
| `/steepy-apex:loop-engineer` | Run an authorized, bounded autonomous loop. |

Deterministic runners support Claude, Codex, and OpenCode; Pi and DeepSeek report `runner-unavailable`. `review`, inception checks, Gear-3 autopilot, and Gear-4 `loop-engineer` run on Linux and macOS only. Native hooks and model selection depend on the host; use `check` and `review` as explicit verification gates.

## Data and external services

steepy-apex has no server and sends no telemetry: no data reaches steepy-it. Specs, plans, and
workflow logs stay in your repository under the gitignored `.apex/work/`; autopilot logs are
redacted by default (`log-mode: safe`). These skills reach services outside your agent session:

| Skill | Service | What is sent |
|---|---|---|
| `/steepy-apex:brainstorm` in autopilot drive | The harness named in the run contract: Claude Code, Codex, or OpenCode | Phase prompts and repository content go to that harness's model provider, for example OpenAI through Codex. |
| `/steepy-apex:check` | Public model pages from OpenAI and Anthropic, plus `opencode models` when OpenCode is installed | Requests for the current model list, used to verify the model table. No project data is sent. |
| `/steepy-apex:review` | GitHub, through Git and the `gh` CLI | Your branch and a pull request to `main`, only after you confirm. |
| `/steepy-apex:inception` | Official project documentation and package registries, reached through your harness and the approved tools; Git hosting only after your authorization | Research queries and installs. Pushes or repository creation only after you authorize each one. |

`/steepy-apex:loop-engineer` runs its attempts on the harness you are already using. The full
[privacy policy](PRIVACY.md) repeats this table.

Autopilot and `/steepy-apex:loop-engineer` start the harness headless with these flags: Claude Code
`--dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-and-sandbox`, OpenCode
`--auto`. The Claude Code and Codex flags turn off permission prompts, and the Codex one also turns
off its sandbox. Run these modes only on a branch and a machine you are willing to let the agent change.

## Documentation

- [Installation](docs/installation.md): all harnesses, requirements, upgrading, and troubleshooting.
- [Inception](docs/inception.md): start a project from an idea, before the hub exists.
- [docs/workflow.md](docs/workflow.md): gears, model selection, autopilot, and live observability.
- [docs/architecture.md](docs/architecture.md): internals, usage reports for context efficiency, and the Command-family effects matrix: filesystem reads–writes–subprocesses–temporary state–providers/network.
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Privacy](PRIVACY.md) · [Changelog](CHANGELOG.md) · [Apache-2.0 license](LICENSE)

Made by [Steepy](https://steepy.it/steepy-apex).

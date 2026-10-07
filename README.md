<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-stacked-dark.svg">
    <img alt="steepy-apex" src="assets/logo-stacked-light.svg" width="300">
  </picture>
</p>

<p align="center"><em>Keep your AI on the apex.</em></p>

<p align="center">
  <img alt="harnesses: Claude Code · Codex · OpenCode · Pi · DeepSeek Harness" src="https://img.shields.io/badge/harnesses-Claude_Code_%C2%B7_Codex_%C2%B7_OpenCode_%C2%B7_Pi_%C2%B7_DeepSeek-C8873A?style=flat-square&labelColor=1B3149">
  <img alt="node ≥ 24" src="https://img.shields.io/badge/node-%E2%89%A5%2024-4A515B?style=flat-square&labelColor=1B3149">
  <img alt="zero dependencies" src="https://img.shields.io/badge/deps-zero-4A515B?style=flat-square&labelColor=1B3149">
  <img alt="license Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-4A515B?style=flat-square&labelColor=1B3149">
</p>

Context engineering and governed workflows for AI coding agents. Keep project knowledge coherent, route work to specialists, and scale from small fixes to bounded autonomous loops.

**Version 1.0.0.** Requires **Node.js >= 24** and a supported coding agent: Claude Code, Codex, OpenCode, Pi, or DeepSeek Harness.

## What it does

- **Map your project:** a versioned `.apex/` hub with standards, domain vocabulary, and specialist routing.
- **Catch documentation drift:** validate links, routing, and code anchors; refresh knowledge through discovery.
- **Scale the workflow:** small fixes, spec-to-review development, or bounded autonomous loops with explicit authorization.
- **Optimize model spend:** match model capability to each task’s complexity, using lighter models for mechanical work and stronger models for design and risk. [Provider-aware model selection](docs/workflow.md#model-selection) adapts to the harness, with mappings maintained as models and host capabilities evolve. Hosts without per-task selection use the session model.

Project knowledge stays versioned. Specs and plans stay gitignored under `.apex/work/` as a local work artifact.

## Quick start

Install your harness first; steepy-apex requires **Node.js >= 24** and **Git**.
npm and public plugin-directory availability are separate release steps. Choose your harness below;
local alternatives and troubleshooting are in [the installation guide](docs/installation.md).

### Claude Code

Run inside Claude Code:

```text
/plugin marketplace add steepy-it/steepy-apex
/plugin install steepy-apex@steepy-apex
```

Reload plugins, open your project, then run `/steepy-apex:init`.
[Details](docs/installation.md#claude-code).

### Codex

Run in your terminal:

```sh
codex plugin marketplace add steepy-it/steepy-apex
codex plugin add steepy-apex@steepy-apex
```

Start a new Codex session in your project and select steepy-apex's `init` skill (`$init`).
[Details](docs/installation.md#codex).

### OpenCode

Clone the complete package to a permanent location:

```sh
git clone https://github.com/steepy-it/steepy-apex.git
```

Add its absolute file URL to the `plugin` array in your project's `opencode.json`:

```json
{ "plugin": ["file:///ABSOLUTE/PATH/TO/steepy-apex/adapters/opencode/steepy-apex.js"] }
```

Restart OpenCode in your project, run `/steepy-apex-init`, and approve access to the
checkout when prompted. [Details](docs/installation.md#opencode).

### Pi

```sh
pi install git:github.com/steepy-it/steepy-apex
```

Start Pi in your project and run `/skill:init`.
[Details](docs/installation.md#pi).

### DeepSeek Harness

Clone the package, then install it into your configured profile (replace `<name>`):

```sh
git clone https://github.com/steepy-it/steepy-apex.git
dsh plugin --profile <name> add /absolute/path/to/steepy-apex
```

Open that profile in your project and ask the model to call `steepy_skill` with
`skill: "init"`, then follow the returned instructions.
[Details](docs/installation.md#deepseek-harness).

## Get started

Use your harness's [command syntax](docs/installation.md#first-run-and-troubleshooting); Claude Code is shown here.

1. `/steepy-apex:init` - Initialize steepy-apex in your repo. Creates the `.apex/` hub, project instructions, and the local `.apex/work/` area for gitignored specs/plans.
2. `/steepy-apex:discovery` — Populate the hub from an existing codebase, reviewing each proposal.
3. `/steepy-apex:check` — Verify documentation coherence, then give your agent a task.

The generated bootstrap reads `AGENTS.md`, follows `.apex/_INDEX.md` routing, and invokes workflows by semantic skill name.

## Skills

Claude Code syntax is shown below; see the [installation guide](docs/installation.md#first-run-and-troubleshooting) for other agents.

| Skill | Purpose |
|---|---|
| `/steepy-apex:init` | Set up the project hub. |
| `/steepy-apex:discovery` | Populate or refresh project knowledge. |
| `/steepy-apex:check` | Check documentation coherence. |
| `/steepy-apex:new-surface` | Register a project area and its specialist. |
| `/steepy-apex:brainstorm` | Turn an idea into a spec. |
| `/steepy-apex:plan` | Break a spec into implementation tasks. |
| `/steepy-apex:implement` | Implement a spec or plan with tests. |
| `/steepy-apex:review` | Verify the result against the spec. |
| `/steepy-apex:loop-engineer` | Run an authorized, bounded autonomous loop. |

Deterministic runners support Claude, Codex, and OpenCode; Pi and DeepSeek report `runner-unavailable`. Gear-3 autopilot supports Linux and macOS. Native hooks and model selection depend on the host; use `check` and `review` as explicit verification gates.

## Documentation

- [Installation](docs/installation.md) — all harnesses, requirements, and troubleshooting.
- [Release checklist](RELEASE.md) — preflight, distribution channels, and rollback.
- [docs/workflow.md](docs/workflow.md) — workflow selection, context efficiency, and live observability.
- [docs/architecture.md](docs/architecture.md) — internals, usage reports, and the Command-family effects matrix: filesystem reads–writes–subprocesses–temporary state–providers/network.
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [Apache-2.0 license](LICENSE)

Zero third-party runtime dependencies. Commands can write files, run Git/tests, and invoke providers; review their documented effects and plugin hooks before use. Automatic surface detection covers JavaScript workspaces; other stacks can declare their surfaces during setup.

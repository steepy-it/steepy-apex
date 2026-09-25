# Installation

steepy-apex installs natively in five harnesses — [Claude Code](https://docs.claude.com/en/docs/claude-code), [Codex](https://developers.openai.com/codex), [OpenCode](https://opencode.ai), [Pi Coding Agent](https://github.com/badlogic/pi-mono), and DeepSeek Harness (dsh) — from one shared package: a single canonical `skills/` tree plus thin per-harness adapters and manifests. Pick your harness.

GitHub installation requires access to this repository. Install the harness itself first,
and keep Node.js >= 24 and Git available on your PATH. Public availability, marketplace
approval, and npm publication are separate release steps; a GitHub tag does not establish
a store listing. See the [distribution checklist](../RELEASE.md#public-distribution-checklist).

### Claude Code

**From GitHub:**

```
/plugin marketplace add steepy-it/steepy-apex
/plugin install steepy-apex@steepy-apex
```

**From the Claude community marketplace** (after community review and catalog sync):

```
/plugin marketplace add anthropics/claude-plugins-community
/plugin install steepy-apex@claude-community
```

**From a local checkout** (for development):

```
/plugin marketplace add /path/to/steepy-apex
/plugin install steepy-apex@steepy-apex
```

Then restart Claude Code (or reload plugins) and run `/steepy-apex:inception` for a
brand-new application with no code yet, or `/steepy-apex:init` directly against an
existing codebase.

### Codex

**From a local checkout** (for development):

```
codex plugin marketplace add /path/to/steepy-apex
codex plugin add steepy-apex@steepy-apex
```

**From GitHub:**

```
codex plugin marketplace add steepy-it/steepy-apex
codex plugin add steepy-apex@steepy-apex
```

The checkout is itself a marketplace root (`.agents/plugins/marketplace.json` + `.codex-plugin/plugin.json` ship in the repo). Skills are invoked with `$<skill>` or picked automatically; run the `inception` skill first for a brand-new application with no code yet, otherwise run `init` directly.

### OpenCode

**From a local checkout** (for development): keep the complete checkout intact and add its exported plugin module to the `plugin` array of your `opencode.json` using OpenCode's documented file-URL form:

```json
{ "plugin": ["file:///ABSOLUTE/PATH/TO/steepy-apex/adapters/opencode/steepy-apex.js"] }
```

The entry module resolves `skills/` and its shared adapter modules relative to that checkout. Do not copy the entry file by itself into `.opencode/plugins/`; that separates it from the required package payload.

**From a git tag** (replace `vX.Y.Z` with the desired published tag), in `opencode.json`:

```json
{ "plugin": ["steepy-apex@git+https://github.com/steepy-it/steepy-apex.git#vX.Y.Z"] }
```

**From npm** — future release; the package is not published yet.

The adapter registers the canonical `skills/` tree and ten `steepy-apex-<skill>` commands (including the pre-hub `inception` skill); skills are also invoked by the agent through the native skill tool. Skills read templates from the checkout, which OpenCode treats as an external directory: interactive sessions get a one-time permission prompt, while non-interactive `opencode run` needs it pre-granted in `opencode.json` (`"permission": { "external_directory": { "/path/to/steepy-apex/**": "allow" } }`).

### Pi

**From a local checkout** (for development):

```
pi install /path/to/steepy-apex
```

**From a git tag** (replace `vX.Y.Z` with the desired published tag):

```
pi install git:github.com/steepy-it/steepy-apex@vX.Y.Z
```

**From npm** — future release; the package is not published yet.

Skills are invoked with `/skill:<name>` (or model-invoked), plus optional `/steepy-<skill>` wrappers registered by the extension.

### DeepSeek Harness

**From a local checkout** (for development):

```
dsh plugin --profile <name> add /path/to/steepy-apex
```

**From a git tag** (replace `vX.Y.Z` with the desired published tag):

```
dsh plugin --profile <name> add git+https://github.com/steepy-it/steepy-apex.git#vX.Y.Z
```

**From npm** — future release; the package is not published yet.

The adapter registers ten `steepy-<skill>` commands (including the pre-hub `inception` skill), a model-invocable `steepy_skill` tool, and a marker-guarded bootstrap section in the system prompt. A command's output is rendered to the human and never enters model history, so it can only name the tool call to make — ask the model to call `steepy_skill` directly, or run a `steepy-<skill>` command to see the exact call.

### Requirements

- **A supported harness** — Claude Code, Codex, OpenCode, Pi Coding Agent, or DeepSeek Harness. One canonical skill set serves all five; where a harness lacks a capability (subagent dispatch, per-dispatch model choice), the skills degrade along a declared path — stated in the output, never silent.
- **Node.js >= 24** — the hub linter (`validate-hub.mjs`) and scaffolders run on Node, with no third-party dependencies (only Node built-ins). Node 24 is the supported runtime floor; CI validates Node 24. They are invoked by the end-of-turn hook and the `check` skill.

## First run and troubleshooting

Two starting points, both hub-free until they finish:

- **Greenfield** — a new application with no code yet, or only starting materials.
  Run `inception` first. It needs no `.apex` hub to start; it takes the project from
  starting materials to an approved, verified bootstrap, then hands off to `init`.
- **Existing codebase** — code already exists but there is no hub yet. Run `init`
  directly, then `discovery` to fill hub docs from the real code.

Then run `check` using your harness's syntax:

| Harness | Inception (greenfield) | Initialize | Discover (existing code) | Check |
|---|---|---|---|---|
| Claude Code | `/steepy-apex:inception` | `/steepy-apex:init` | `/steepy-apex:discovery` | `/steepy-apex:check` |
| Codex | `$inception` | `$init` | `$discovery` | `$check` |
| OpenCode | `/steepy-apex-inception` | `/steepy-apex-init` | `/steepy-apex-discovery` | `/steepy-apex-check` |
| Pi | `/skill:inception` | `/skill:init` | `/skill:discovery` | `/skill:check` |
| DeepSeek Harness | Ask the model to call `steepy_skill` with `skill: "inception"` | Use `skill: "init"` | Use `skill: "discovery"` | Use `skill: "check"` |

In Codex, select the skill belonging to **steepy-apex** if another plugin uses the
same name. Restart the harness after installation if skills are not visible.

For OpenCode, merge the plugin entry into your existing configuration, preserve the
complete package, and approve access to that checkout when prompted. A missing helper
usually means the entry module was copied without its sibling directories.

For DeepSeek Harness, use an existing configured profile. For one-shot verification,
use the shipped `headless` profile: an arbitrary new profile name may have no frontend.

A successful `init` creates `.apex/_INDEX.md`, project instructions, and the local
`.apex/work/` area. `check` should report a coherent hub. See [workflow](workflow.md)
for subsequent tasks and [architecture](architecture.md) for command effects, hooks,
and adapter boundaries. Pi and DeepSeek have no Steepy deterministic runner for
Gear-3 autopilot or Gear-4 loops.

## Upstream references

Installation syntax was cross-checked on 2026-09-16 against
[Claude Code marketplaces](https://code.claude.com/docs/en/discover-plugins),
[Codex plugin packaging](https://developers.openai.com/plugins/build/plugins),
[OpenCode plugins](https://opencode.ai/docs/plugins/), and
[Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).
These references describe host mechanisms; candidate-specific native verification is
tracked separately in [release checks](../RELEASE.md#public-distribution-checklist).

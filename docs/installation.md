# Installation

steepy-apex installs natively in five harnesses ([Claude Code](https://code.claude.com/docs/en/overview), [Codex](https://developers.openai.com/codex), [OpenCode](https://opencode.ai), [Pi Coding Agent](https://github.com/earendil-works/pi), and DeepSeek Harness, `dsh`) from one shared package: a single canonical `skills/` tree plus thin per-harness adapters and manifests.

steepy-apex installs from GitHub; it is not published on npm or in the Claude and Codex
plugin directories. See the [distribution checklist](../RELEASE.md#public-distribution-checklist).

## Requirements

- **A supported harness**, installed first: Claude Code, Codex, OpenCode, Pi Coding Agent, or DeepSeek Harness. One canonical skill set serves all five; where a harness lacks a capability (subagent dispatch, per-dispatch model choice), the skills degrade along a declared path — stated in the output, never silent.
- **Node.js >= 24** — the hub linter (`validate-hub.mjs`) and scaffolders run on Node, with no third-party dependencies (only Node built-ins). Node 24 is the supported runtime floor; CI validates Node 24. They are invoked by the end-of-turn hook and the `check` skill.
- **Git** on your PATH.
- **Linux or macOS** for `review`, inception checks, Gear-3 autopilot, and Gear-4 loops; they refuse other platforms. CI runs on Linux.
- **Claude Code >= 2.1.211** for autopilot and Gear-4 runs on Claude Code, which pass `--forward-subagent-text`.

## Install by harness

Each harness lists the public install first and a local checkout for development second.

### Claude Code

**From GitHub:**

```
/plugin marketplace add steepy-it/steepy-apex
/plugin install steepy-apex@steepy-apex
```

**From a local checkout** (for development):

```
/plugin marketplace add /path/to/steepy-apex
/plugin install steepy-apex@steepy-apex
```

Then run `/reload-plugins` (or restart Claude Code) and start with `/steepy-apex:init`.

### Codex

**From GitHub:**

```
codex plugin marketplace add steepy-it/steepy-apex
codex plugin add steepy-apex@steepy-apex
```

**From a local checkout** (for development):

```
codex plugin marketplace add /path/to/steepy-apex
codex plugin add steepy-apex@steepy-apex
```

The checkout is itself a marketplace root (`.agents/plugins/marketplace.json` + `.codex-plugin/plugin.json` ship in the repo). Skills are invoked with `$<skill>` or picked automatically; run the `init` skill first.

### OpenCode

These steps were written for OpenCode 1.x. OpenCode 2.x is not verified yet: for example,
OpenCode 2.3.0 refuses the single-file local-checkout entry shown below.

**From a git tag** (replace `vX.Y.Z` with a tag from the [releases page](https://github.com/steepy-it/steepy-apex/releases)), in `opencode.json`:

```json
{ "plugin": ["steepy-apex@git+https://github.com/steepy-it/steepy-apex.git#vX.Y.Z"] }
```

**From a local checkout** (for development): keep the complete checkout intact and add its exported plugin module to the `plugin` array of your `opencode.json` using OpenCode's documented file-URL form:

```json
{ "plugin": ["file:///ABSOLUTE/PATH/TO/steepy-apex/adapters/opencode/steepy-apex.js"] }
```

The entry module resolves `skills/` and its shared adapter modules relative to that checkout. Do not copy the entry file by itself into `.opencode/plugins/`; that separates it from the required package payload.

**From npm** — future release; the package is not published yet.

The adapter registers the canonical `skills/` tree and ten `steepy-apex-<skill>` commands; skills are also invoked by the agent through the native skill tool. Skills read templates from the checkout, which OpenCode treats as an external directory: interactive sessions get a one-time permission prompt, while non-interactive `opencode run` needs it pre-granted in `opencode.json` (`"permission": { "external_directory": { "/path/to/steepy-apex/**": "allow" } }`).

### Pi

**From a git tag** (replace `vX.Y.Z` with a tag from the [releases page](https://github.com/steepy-it/steepy-apex/releases)):

```
pi install git:github.com/steepy-it/steepy-apex@vX.Y.Z
```

**From a local checkout** (for development):

```
pi install /path/to/steepy-apex
```

**From npm** — future release; the package is not published yet.

Skills are invoked with `/skill:<name>` (or model-invoked), plus optional `/steepy-<skill>` wrappers registered by the extension.

### DeepSeek Harness

**From a git tag** (replace `vX.Y.Z` with a tag from the [releases page](https://github.com/steepy-it/steepy-apex/releases)):

```
dsh plugin --profile <name> add git+https://github.com/steepy-it/steepy-apex.git#vX.Y.Z
```

**From a local checkout** (for development):

```
dsh plugin --profile <name> add /path/to/steepy-apex
```

**From npm** — future release; the package is not published yet.

The adapter registers ten `steepy-<skill>` commands, a model-invocable `steepy_skill` tool, and a marker-guarded bootstrap section in the system prompt. A command's output is rendered to the human and never enters model history, so it can only name the tool call to make — ask the model to call `steepy_skill` directly, or run a `steepy-<skill>` command to see the exact call.

## First run and troubleshooting

Open the repository you want to govern, then run `init`, `discovery` (for an existing
codebase), and `check` using your harness's syntax. Starting from an idea or a prototype,
run `inception` first; see the [inception guide](inception.md).

| Harness | Start from an idea | Initialize | Discover | Check |
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

In a JavaScript or TypeScript workspace, `init` proposes one surface per package listed in
`pnpm-workspace.yaml` or in the `workspaces` field of `package.json`. It expands entries
written as a plain path, `dir/*`, or `dir/**`. Other forms, such as `!` exclusions or
braces, are not expanded, and in `pnpm-workspace.yaml` they stop the whole proposal. Either
way, you confirm or edit the surface list during setup.

A successful `init` creates `.apex/_INDEX.md`, project instructions, and the local
`.apex/work/` area. `check` should report a coherent hub. See [workflow](workflow.md)
for subsequent tasks and [architecture](architecture.md) for command effects, hooks,
and adapter boundaries. Pi and DeepSeek have no Steepy deterministic runner for
Gear-3 autopilot or Gear-4 loops.

## Upgrading an existing hub

Update the plugin in your harness, then run `check` in each repository it governs.

- **Claude Code:** run `claude plugin marketplace update steepy-apex`, then
  `claude plugin update steepy-apex@steepy-apex`, then `/reload-plugins` or a restart. Inside a
  session, `/plugin marketplace update steepy-apex` refreshes the listing and **Update now** in
  the `/plugin` Installed tab updates the plugin. With auto-update on for the marketplace, this
  happens on its own.
- **Codex:** run `codex plugin marketplace upgrade steepy-apex`, then start a new session.
- **OpenCode:** change the tag in your `opencode.json` entry to the new release.
- **Pi:** `pi update` does not move a pinned tag. Remove the old source with
  `pi remove git:github.com/steepy-it/steepy-apex@<old-tag>`, then install the new one with
  `pi install git:github.com/steepy-it/steepy-apex@<new-tag>`.
- **DeepSeek Harness:** run the `add` command from [the install section](#deepseek-harness)
  with the new tag.

For a local checkout, check out the new tag in the checkout first. Then run the same update
commands for Claude Code and Codex, or restart OpenCode and Pi.

### To v1.3.2

- **An inception run in progress.** If its snapshots already include the files of a linked Git
  worktree inside the repository, those files now show as removed and `unit finish` refuses
  them. Accept them with `unit reconcile` and an explicit human statement. A run that excluded
  the worktrees by hand is not affected.

### To v1.2.0

v1.2.0 drops every compatibility path for older formats, so some state left by earlier
versions stops working:

- **Specialist adapters from v1.0.0–v1.0.6.** `check` and the Stop hook report
  `<agent> <harness> adapter at <path> is customized`, and the Stop hook blocks. Run `init`:
  it repairs the existing hub and asks about each conflict. Choose `replace`: it rewrites the
  adapter to the current rendering, so copy out any hand edits first.
- **An in-flight autopilot run from an earlier version.** A run on task-result protocol 1, or
  one whose saved responses carry `changed-paths`, cannot resume: the conductor halts. Finish
  it manually or start a fresh run.
- **An inception run from a pre-release build** (`steepy-inception-run/v1`). Every command
  refuses it. Move `.apex/inception/` out of the repository by hand, including
  `abandon-intent.json` and `abandoned/`, then start a fresh run.
- **Custom autopilot status markers.** A child status note that carries `phase=` no longer
  completes a phase. Write only `run-id` and `attempt`.

The [changelog](../CHANGELOG.md) lists every change by version.

## Upstream references

The install and update commands on this page were last checked against each host's
documentation on these dates:

- Claude Code, 2026-11-19: [Discover plugins](https://code.claude.com/docs/en/discover-plugins)
  and [commands](https://code.claude.com/docs/en/commands).
- Codex, 2026-11-19 for the marketplace commands and 2026-09-16 for `codex plugin add`:
  [Codex plugin packaging](https://developers.openai.com/plugins/build/plugins).
- OpenCode, 2026-09-16: [OpenCode plugins](https://opencode.ai/docs/plugins/).
- Pi, 2026-11-19: [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
  and the [Pi CLI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md).

These references describe host mechanisms; candidate-specific native verification is
tracked separately in [release checks](../RELEASE.md#public-distribution-checklist).

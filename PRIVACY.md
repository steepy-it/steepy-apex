# Privacy policy

steepy-apex is a plugin that runs inside your AI coding agent, on your machine. steepy-it
runs no server for it, so no data reaches steepy-it.

## What steepy-apex does not collect

- No telemetry, analytics, or crash reports.
- No account, sign-in, or license key.
- No personal data.

## What stays in your repository

Specs, plans, and workflow logs stay in your repository under the gitignored `.apex/work/`.
Autopilot logs are redacted by default (`log-mode: safe`). Hub docs under `.apex/` are
ordinary files in your repository; you decide whether to commit them.

## External services

These skills reach services outside your agent session:

| Skill | Service | What is sent |
|---|---|---|
| `/steepy-apex:brainstorm` in autopilot drive | The harness named in the run contract: Claude Code, Codex, or OpenCode | Phase prompts and repository content go to that harness's model provider, for example OpenAI through Codex. |
| `/steepy-apex:check` | Public model pages from OpenAI and Anthropic, plus `opencode models` when OpenCode is installed | Requests for the current model list, used to verify the model table. No project data is sent. |
| `/steepy-apex:review` | GitHub, through Git and the `gh` CLI | Your branch and a pull request to `main`, only after you confirm. |
| `/steepy-apex:inception` | Official project documentation and package registries, reached through your harness and the approved tools; Git hosting only after your authorization | Research queries and installs. Pushes or repository creation only after you authorize each one. |

`/steepy-apex:loop-engineer` runs its attempts on the harness you are already using. Each of
these services handles what it receives under its own privacy policy. Per-command effects
are in the [Command-family effects matrix](docs/architecture.md#command-family-effects-matrix).

## Contact

Questions about this policy: open an issue at
[github.com/steepy-it/steepy-apex/issues](https://github.com/steepy-it/steepy-apex/issues)
or write to **info@steepy.it**. Report vulnerabilities as described in
[SECURITY.md](SECURITY.md).

## Changes

Changes to this policy land in this file and are noted in the [CHANGELOG](CHANGELOG.md).

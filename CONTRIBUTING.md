# Contributing to steepy-apex

## Command-family effects matrix

Before running a command, consult the [effects matrix](docs/architecture.md#command-family-effects-matrix) and choose the relevant effects boundary: filesystem
reads–writes–subprocesses–temporary state–providers/network. Local validation and
scaffolding differ from session-store reporting, version transactions, workflow
controllers, release-evidence validation, live model-mapping verification, and native
installation/canaries. The project has zero third-party runtime dependencies, but some
families intentionally invoke Git, npm, a provider catalog, or a host harness.

Thanks for your interest. Contributions follow one rule: **discuss features first, fix bugs directly.**

## What's welcome

- **Bug reports** — open an issue with the bug report template.
- **Bug-fix PRs** — welcome directly. Include a regression test that your fix turns green.
- **Feature PRs** — open an issue first and wait for a go-ahead. The hub model (routing table, work artifacts, coherence linter) is deliberate; a PR that fights it will be declined even when the code is good.
- **Docs fixes** — typos and clarity fixes are always welcome.

## Dev setup

You need Node.js >= 24. There are no dependencies to install.

```bash
git clone https://github.com/steepy-it/steepy-apex.git
cd steepy-apex
npm test
```

`npm test` runs the whole suite with the Node built-in test runner. It must be green before and after your change.

## What a PR is checked against

1. **Tests pass** — `npm test` is green. Bug fixes add a regression test; features come with tests (this repo is built test-first).
2. **Hub stays coherent** — if you touch `.apex/`, `templates/`, or anything the linter reads, `node scripts/validate-hub.mjs .` must exit 0.
3. **Version gate** — every PR either bumps the plugin version (`node scripts/bump-version.mjs <patch|minor|major>`) and adds a matching `## vX.Y.Z` section to `CHANGELOG.md`, or carries the `no-release` label (docs-only and CI-only changes). CI enforces this.

## Navigating the code

This repo governs itself with its own `.apex/` hub. Start from `.apex/_INDEX.md` — the routing table names the surface (adapters, scripts, skills, templates, tests) that owns each kind of change and the standard it follows.

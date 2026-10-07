# Security policy

## Supported versions

Only the latest release on `main` is supported. Older releases do not receive security backports.

## Reporting a vulnerability

Report privately via [GitHub Private Vulnerability Reporting](https://github.com/steepy-it/steepy-apex/security/advisories/new) (**Security** tab → **Report a vulnerability**), or by email to **info@steepy.it**. Do not open a public issue for a vulnerability.

You can expect an acknowledgment within a few days — this is a solo-maintained project.

## Scope

steepy-apex uses Node.js built-ins with zero third-party runtime dependencies. Effects are
command-specific rather than globally local, offline, or repository-only. See the
[Command-family effects matrix](docs/architecture.md#command-family-effects-matrix): filesystem reads–writes–subprocesses–temporary
state–providers/network differ between local validation/scaffolding, session-store and
observability reporting, version transactions, review/controllers, release evidence,
model-mapping verification, and native installation/canaries. Reports that matter most:

- a plugin script writing or deleting files **outside** the target repo
- crafted repo content (hub docs, `package.json`) that makes a plugin script execute unintended commands
- the Stop hook blocking a session in a way that cannot be recovered

Anything that needs no privacy (crashes, wrong output, lint false positives) is a regular bug — use the bug report template instead.

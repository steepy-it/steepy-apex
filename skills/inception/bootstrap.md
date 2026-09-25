# Bootstrap

Load this when the descriptor phase is `bootstrap`. Goal: the approved project runs for real,
through the representative path, and nothing is built beyond the approved scope.

## Build it

- Pin commands and tools to the exact versions from the approved research.
- Create manifests and lockfiles with the official tools. Commit only if the Git policy allows it,
  and only before the final code checkpoint.
- Provide install, build, test, and start commands that work from a clean checkout.
- Ship example configuration without secrets. Never write a real secret.
- Add the integrations and migrations the representative path needs, and only those.
- Implement the representative path across the agreed boundaries.
- Reuse the planned assets: starter, design system, prototype parts. Keep the behaviors marked to
  preserve.
- Do not implement the whole prototype. Other flows stay future context.
- Add CI and deploy instructions when they are relevant. Execute deploy only when the approved
  project includes it.

## Effects and checkpoints

Keep a bootstrap log at `.apex/inception/<run-id>/bootstrap-log.md`. Before each step with effects —
install, generator, migration, external resource, deploy — append its intent. After it, append the
observed outcome. When a step changes repository files, record a code checkpoint and bind it
(`protocol.md` → "Code checkpoint").

An external effect with an uncertain outcome (timeout, lost connection, interrupted session) is
reconciled: observe the real state first. Never repeat it automatically.

## Failures and changes

- Build or test failures → fix them inside the approved scope.
- A fix that changes database, boundaries, flows, design, or deploy → targeted decision and new
  approval before you continue (architecture.md → "Approval").

When the bootstrap installs, builds, passes its tests, starts, and runs the representative path, set
phase `verification` with `update`.

# Bootstrap

Load this when the descriptor phase is `bootstrap`. Goal: the approved project runs for real,
through the representative path, and nothing is built beyond the approved scope.

## Parts and children

A part is one entry of the project's surface map. Dispatch one child per part
(`SKILL.md` → "Child agents"), one at a time, in dependency order: the producer of a contract
comes before its consumers.

- Give each child exact paths to the approved project documents, the version research
  `research/version-review.md`, and its report path `.apex/inception/<run-id>/bootstrap/<part>.md`.
- The approved project's confirmed version tables are the version authority. The child pins those
  versions; where `research/version-review.md` differs, the approved project wins.
- Put the "Build it" rules that apply to its part in its brief.
- The child writes code only under its part's path, and writes its report.
- You keep the bootstrap log, the checkpoints, the commits, the descriptor, and the dialogue with
  the user. Before each child, append its intent to the log. After it, append the outcome, run the
  checks, commit when the Git policy allows, recheck committed files if the commit changed them,
  then record a new checkpoint and bind it. Follow "Effects and checkpoints" for this order.
- A child never writes the descriptor, an approval, a checkpoint, the bootstrap log, a commit,
  another part's paths, or a file `init` writes.
- When a child cannot finish: `BLOCKED` or `NEEDS_CONTEXT` → get the missing fact or ask the user,
  then dispatch again. A substantial change → a targeted decision and a new approval (see
  "Failures and changes").
- Cross-part fixes and small fixes (for example an end-to-end selector or a routing bug) stay with
  you, inline.

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
observed outcome. Run the relevant checks and record their results. If Git policy authorizes a
commit for changed repository files, record the commit intent, make the commit, and then log its
observed outcome. After a commit, run post-commit rechecks if it changed files, then publish a new
checkpoint with the planned file inventory and bind it in the descriptor
(`protocol.md` → "Code checkpoint"). Uncommitted working trees and repositories with
`git: null` remain supported: record their observed file state and checks, then checkpoint and bind
without requiring a commit.

If an interruption occurs after a commit but before checkpoint publication or descriptor binding,
compare the exact log, Git state, and planned inventory on resume. Explain any divergence and
complete only the checks, checkpoint, or binding demonstrated by those facts. If the intended
checkpoint does not exist, complete demonstrably needed post-commit rechecks, create it from the
planned inventory at its exact new path, and bind its path and digest. If the checkpoint exists but
is unbound, verify its recorded file bytes, Git facts, planned inventory, and relevant checks before
you bind its path and digest. Do not substitute a comparison checkpoint from the previous inventory.
If the intended inventory or exact checkpoint path is unknown, use the blocked stop condition.
Never repeat a commit, destructively rewrite the log or an existing checkpoint, or silently
rebaseline changed files.

An external effect with an uncertain outcome (timeout, lost connection, interrupted session) is
reconciled: observe the real state first. Never repeat it automatically.

## Failures and changes

- Build or test failures → fix them inside the approved scope.
- A fix that changes database, boundaries, flows, design, or deploy → targeted decision and new
  approval before you continue (architecture.md → "Approval").

When the bootstrap installs, builds, passes its tests, starts, and runs the representative path, set
phase `verification` with `update`.
Then pause (`SKILL.md` → "Session boundaries"): this is the second planned pause.

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
  checks, and follow "Effects and checkpoints" for commit, rechecks, checkpoint, and binding.
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

Use the existing bootstrap log at `.apex/inception/<run-id>/bootstrap-log.md`, created before the
approval transition; preserve its history on retries and new approvals. A legacy missing log uses
`SKILL.md` → "Resume" reconciliation before any effect.

Before each step with effects, append its intent. After it, append the observed outcome.
For each effect, including a child, install, generator, migration, external resource, or deploy:

1. Append the intent, exact planned inventory, and applicable checks before the effect.
2. Perform the effect once and append its observed outcome with exact evidence paths.
3. Run and record the relevant checks against the observed files and representative behavior.
4. If the approved Git policy authorizes a commit, append the commit intent, perform the commit,
   and record its observed outcome and Git identity; otherwise retain the verified working tree.
5. If the commit changed files, run the relevant rechecks before writing a new checkpoint and
   binding it to the descriptor; record the outcomes. Inspect hook-generated changes too.
6. Record a new checkpoint at a new exact path over the complete relevant planned inventory, then
   bind its printed path and digest through the descriptor helper. Preserve previous checkpoints.

A checkpoint records the final observed files and branch/HEAD after any authorized commit, with
verification for those bytes. Uncommitted working trees remain supported; without a Git repository,
retain `git: null`, skip commits, and verify and checkpoint the files normally.

If interrupted after commit and before checkpoint or descriptor binding, compare the log, current
Git branch/HEAD and working tree, prior checkpoint if present, exact child/results reports, and the
approved planned inventory. Explain every divergence, including any commit-hook file changes.
Complete only demonstrable missing verification, a new checkpoint, and descriptor binding.
Never repeat an already observed commit or issue a second commit to close this gap; never rewrite
records destructively or establish an unexplained new baseline. If the commit outcome or file state
cannot be established, use the existing blocked stop rather than guessing.

An external effect with an uncertain outcome (timeout, lost connection, interrupted session) is
reconciled: observe the real state first. Never repeat it automatically.

## Failures and changes

- Build or test failures → fix them inside the approved scope.
- A fix that changes database, boundaries, flows, design, or deploy → targeted decision and new
  approval before you continue (architecture.md → "Approval").

When the bootstrap installs, builds, passes its tests, starts, and runs the representative path, set
phase `verification` with `update`.
Then pause (`SKILL.md` → "Session boundaries"): this is the second planned pause.

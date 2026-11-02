# review — Steps 4–5: report, offer a pull request

### Step 4 — Report

Report, with evidence: tests pass/fail (with output), every active criterion or Gear-4 terminal
condition met or not, and the gate outcome. Regular review is reviewable as complete only when
`validate-hub` is green and every success criterion is backed by real command output. Gear-4 review
is reviewable as complete when the surface test and hub gate are green and every condition for its
claimed terminal outcome is proven from the bounded receipt plus accepted provenance.

A faithfully proven negative outcome (`BUDGET_EXHAUSTED`, `NO_IMPROVEMENT`, or `REVIEW_REJECTED`)
may receive an approved terminal review. Record it explicitly as terminal completion, not goal
success, and retain `goal-succeeded: false` in the judgement. Approval confirms faithful execution
and evidence; it never rewrites the controller outcome to `GOAL_REACHED`.

Persist this review phase's criterion-by-criterion judgement in
`.apex/work/tasks/<plan-basename>/review-report.md`; for Gear 4 use
`.apex/work/loops/<slug>/review-report.md`. Cite the evidence artifact plus command hashes and compact
receipt fields instead of duplicating command transcripts. Write this terminal review report before
consuming the ledger. For Gear 4, include the outcome, goal-success boolean, provenance checks,
terminal-condition matrix, and exact receipt hashes. For Gear 4 only, after the report is complete and every
applicable gate is green, consume the READY loop ledger into
`review-report.md` by setting `status: CONSUMED`, `next: none`, and
`consumed-by: <review-report-path>`. A faithfully proven negative outcome is consumed by the same
terminal-review lifecycle. A Gear-4 interruption or proof mismatch leaves the primary `READY`.
Regular review instead follows the ordered index/report publication below.

**Regular Gear 3 publication and resume.** Create a fresh report only at an absent canonical path;
an existing report requires its exact resume capability, never an overwrite or most-recent fallback.
Start its workflow header before the title as:

```yaml
<!-- steepy-workflow: v1
phase: review
status: DRAFT
next: none
source: <task-result-index-path>
consumed-by: none
-->
```

Record the exact criteria/index/diff identities, current branch/HEAD or uncommitted diff identity,
applicable approval and current receipt-backed verification before publication. After all criteria
and gates pass, first atomically replace the report as `status: READY`; then atomically replace the
task-result index as `status: CONSUMED`, `next: none`, `consumed-by: <review-report-path>`.
Interruption before publication leaves READY/DRAFT;
after publication READY/READY is the sole verified prefix. An exact resume revalidates the common
proof and accepted criteria/index/diff before performing only the input-consumption write. The
verified CONSUMED/READY pair is an idempotent no-op; absent proof, a changed input/diff, or an
impossible pair leaves all artifacts untouched and fails closed. Gear-4 lifecycle remains governed
by its separate terminal proof above, not this regular index/report resume table.

Place the human action immediately beside this terminal envelope; emit no native skill invocation:

```yaml
handoff: steepy-apex/v1
next: human
required:
  evidence: <review-report-path>
onDemand: none
```

**Human action:** inspect the evidence and choose the version-bump/PR action in Step 5.

**Gear-4 negative terminal outcome:** replace that human action with: inspect the evidence; there is
no release or PR offer for this outcome. Suppress Step 5 completely. A new goal contract, ratified
by a human for Gear 4, is required for another run; neither this review nor the consumed ledger grants more
mutation budget.

**Autopilot:** If `drive: autopilot` is present in the verdict contract (Step 0), stop here — this is
the last unattended phase of the run, and the version-bump/PR decision below (Step 5) stays human. After the report above, append
`<ISO timestamp> — review — READY_FOR_PR — run-id=<conductor-supplied> attempt=<positive supplied> <one-line verdict>` to
`.apex/work/tasks/<spec-basename>/autopilot-status.md` and end the session: no version bump, no
CHANGELOG edit, no PR, no Step 5 question. The run's artifacts and this report stay on disk for a
human to pick up Step 5 later, in an interactive session.

### Step 5 — Offer a pull request

This step applies to regular review and a successfully proven Gear-4 `GOAL_REACHED` only. A Gear-4
negative outcome has already stopped at Step 4 with no release/PR offer and a requirement for a new
goal contract before another run.

Check the current branch. If it is `main`/`master`, or has no commits ahead of `main`, stop here — there is nothing to propose.

**Applicability check:** this bump step is repo-local, not a plugin feature — `review` runs in any repo the plugin is installed in, but the bump machinery lives in the target repo. Only proceed when the current repo owns it: `scripts/bump-version.mjs` AND `.github/workflows/version-gate.yml` both exist at the repo root. If either is missing, skip straight to asking about the PR below.

Otherwise, resolve the version bump before opening the PR:
1. **Derive the bump type from the accepted criteria, task-result index, and branch diff** (gear 4:
   from the accepted goal contract and authenticated terminal facts): bugfix → `patch`, feature →
   `minor`, breaking change → `major`. If that evidence is insufficient, ask the human to resolve
   the ambiguity; no spec, plan, ledger, or per-task report read is authorized to derive the bump.
2. **Ask one confirmation question**: state the proposed type and the derivation, e.g. "This looks like a `minor` bump (new feature) — bump the version before the PR?"
3. **On confirm**: run `node scripts/bump-version.mjs <type>` (repo-local tooling, not an engine script — resolve it against the target repo, never `<engine-root>/scripts/`, which would bump the engine's own manifests from any repo), add a `## vX.Y.Z (YYYY-MM-DD)` section at the top of `CHANGELOG.md` (below the `# Changelog` title) with short factual bullets summarizing the change, and commit the bump + changelog as one commit on the branch (e.g. `vX.Y.Z`).
4. **Alternatively, if the work must not ship a release** (docs-only, CI-only): skip the bump and apply the `no-release` GitHub label to the PR instead (`gh pr edit --add-label no-release`, or `--label` at creation).

The `Version gate` workflow fails an unbumped PR that lacks the `no-release` label; the tag and GitHub Release are created automatically on merge by the `Release` workflow.

Then ask the user: **"Work is reviewed clean on `<branch>`. Create a PR to `main`?"** On confirmation, push the branch and create the PR following the repo's PR conventions; report the PR URL.

Whatever comes next — a new chain or a fix round — belongs in a new session: this phase's context does not serve it, and every turn there would pay to carry it forward.

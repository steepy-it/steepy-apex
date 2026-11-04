# implement — Step 5: hand off

### Step 5 — Hand off

**Gear 2 terminates here.** After every implementation task completes, self-verify each success
criterion against the resulting diff, run every distinct surface test command named by the direct
brief or optional light plan, then run:

```bash
node <engine-root>/scripts/validate-hub.mjs .
```

Both the surface test and `validate-hub` must be green; record their exact command outcomes in the
current-run ledger. Record the applicable approval and verification, exact input/output content
identities and current branch/HEAD or uncommitted diff identity in the index before publishing READY.
On failure before terminalization, leave the accepted input `READY` and the
result index `DRAFT`. On success, finalize in this recoverable order: first atomically replace the
index as `status: READY` while retaining `next: none` and its exact `source`; then atomically replace
the accepted spec or plan as `status: CONSUMED` with `consumed-by` equal to that index. If interrupted
between those writes, an exact resume carrying both `progress-ledger` and `task-results` must
revalidate the READY index's source, task results, and recorded green gates, then perform only the
input-consumption write. The fully finalized pair is an idempotent no-op. Any `CONSUMED` input paired
with a DRAFT/mismatched index fails closed instead of redispatching or guessing. For plan-backed Gear
2, do not rewrite the source spec's existing spec-to-plan provenance. Report the completed
implementation and deterministic gates. Gear 2 does not invoke or hand off to `review`; its
implementer self-review and these deterministic gates are its terminal assurance.

**Gear 3 only.** Only after the whole-branch review approves, tell the user the next step is the `review` skill
(invoke it the way your harness invokes skills). Run the `review` skill in a new session:
this phase's context does not serve review, and every turn of the review phase would pay to
carry it forward.

The handoff message must name the concrete inputs by repo-relative path so the fresh review session
starts from those files, not from this conversation's memory. Its payload is exactly:

```yaml
handoff: steepy-apex/v1
next: review
required:
  criteria: <criteria-path>
  task-results: <task-result-index-path>
  branch-diff: <branch-diff-path>
onDemand: none
```

Do not hand review the full plan or source spec. Before emitting this envelope, validate the index's
canonical header grammar, its three metadata paths, the criteria artifact's canonical `Source` and
`Heading` attribution against that metadata, and that `branch-diff` is the unmodified aggregate diff.

**Verify the handoff before claiming completion.** The review phase parses
`task-result-index.md` against the plan before it can build anything. Manual-drive bullets must
match the Step 3.5 grammar; autopilot uses the verified generated JSON receipt projection.
Run the same parse here, where it is still fixable:

```sh
node <engine-root>/scripts/autopilot-context.mjs --verify-handoff --repo-root . --plan .apex/work/plans/<plan-basename>.md --task-result-index .apex/work/tasks/<plan-basename>/task-result-index.md
```

Exit 0 prints the reviewed task IDs and this step continues. A non-zero exit names the exact
offending result: in manual drive correct that line and re-run; in autopilot
inspect the exact receipt and regenerate the projection, never edit machine evidence to pass.
Never proceed on a rejected handoff.

Only after every task gate succeeds, the whole-branch review approves, and this handoff verification
succeeds, record that approval and verification bound to the exact input/output content, supporting
criteria/diff identities, and current branch/HEAD or uncommitted diff identity in the index before READY.
Then first atomically replace the index to `status: READY`; then atomically replace the accepted
plan to `status: CONSUMED` with `consumed-by` equal to the task-result index. Before publication the
plan remains READY and the index DRAFT; READY/READY is the sole permitted intermediate prefix.
An exact resume with progress-ledger and task-results capabilities revalidates the common proof,
the canonical index and recorded gates, then performs only the input-consumption write. A verified
CONSUMED/READY pair is a no-op, never another implementation or review dispatch. Missing evidence
or an impossible pair fails closed. Do not follow supporting paths as implicit read capabilities;
if the recorded proof cannot establish a current handoff, stop for the exact missing scope.

**Autopilot:** when `drive: autopilot`, follow `autopilot-protocol.md` for the final DONE status marker.

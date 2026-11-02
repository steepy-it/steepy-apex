<!-- steepy:manual-handoff:v1:start -->
## Manual handoff envelope

Manual phase boundaries use this literal shape (the envelope is chat text, never a file):

```yaml
handoff: steepy-apex/v1
next: <phase>
required: <role/path map or none>
onDemand: <role/path map or none>
```

All four keys are mandatory and occur once, in that order. Use explicit `none` for an empty map.
The phase input role maps are exact and unique: brainstorm has `required: none`, `onDemand: none`;
plan has required `spec`, `onDemand: none`; Gear-2 direct implement has required `spec`,
`onDemand: none`; plan-backed implement has required `plan`, on-demand `source-spec`; either
implement alternative additionally authorizes exact `progress-ledger` and `task-results` on demand
when resuming;
regular Gear-3 `review` has required `criteria`, `task-results`, and `branch-diff`, `onDemand: none`;
fresh `loop-engineer` has required `goal`, `onDemand: none`; resume may additionally authorize exact
`loop-ledger` on demand; Gear-4 `review` has required `goal` and `loop-ledger`, `onDemand: none`.
Thus Gear-2 brainstorm → implement maps `spec`; brainstorm → plan maps `spec`; plan → implement
maps `plan`, `source-spec`; Gear-3 implement → review maps `criteria`, `task-results`, `branch-diff`;
loop-engineer → review maps `goal`, `loop-ledger`. The two implement role alternatives and the two
review role alternatives are mutually exclusive: never merge or infer them. A role occurs only in
its mapped phase, alternative, and list.

Validate literally before any work-artifact read. Reject duplicate keys, unknown keys, unknown roles,
missing keys, a wrong `next`, and unsafe paths: absolute paths, `..` segments, globs, or anything
outside the repository. Never infer corrections. An explicit malformed or stale binding fails closed
without discovery. Supporting `onDemand` inputs are never preloaded; read one only for a concrete
named missing fact. Stable routing inputs stay outside the envelope and follow bootstrap routing.
Native invocation spelling comes only from the active harness. No child inherits general
`.apex/work/**` access; pass only its accepted role paths.

Every new work artifact starts with verdict/contract metadata when that phase requires it, followed
immediately by this versioned header before the Markdown title:

```yaml
<!-- steepy-workflow: v1
phase: <brainstorm|plan|implement|review|loop-engineer|goal-contract>
status: <DRAFT|READY|CONSUMED>
next: <phase|none>
source: <safe exact repo-relative path|none>
consumed-by: <safe exact repo-relative path|none>
-->
```

Header fields are mandatory, unique, and literal. `source` and `consumed-by` must agree with the
adjacent lifecycle transition and authorize no transitive reads. Headerless artifacts are
ignored by recovery and are available only under explicit user audit scope.

### Exact publication pairs

These are exact resume capabilities, not paths inferred from provenance. The input retains its
normal required role; the output role is added to `onDemand`, as are any existing on-demand companions.
Regular review retains its required criteria and branch diff. Plan resume adds `onDemand.output-plan`;
regular Gear-3 review resume adds `onDemand.review-report`. Fresh forms above are unchanged.
Gear-4 controller/ledger handling is excluded from this model-based pair repair.

| Route | Input role | Output role | Companion roles | Input phase | Output phase | Output next |
| --- | --- | --- | --- | --- | --- | --- |
| plan | spec | output-plan | none | brainstorm | plan | implement |
| implement-2-direct | spec | task-results | progress-ledger | brainstorm | implement | none |
| implement-2-plan | plan | task-results | source-spec,progress-ledger | plan | implement | none |
| implement-3 | plan | task-results | source-spec,progress-ledger | plan | implement | review |
| review-3 | task-results | review-report | criteria,branch-diff | implement | review | none |

### Publication interruption prefixes

This table applies only to the exact authorized pair with matching phase, route and provenance.
Validate the pair before the fresh-only READY input gate; a resume capability is never inferred.
Input `next` names the consumer phase until consumed; consumption retains it for plan/implement
and sets it to `none` for review. Output `consumed-by` is `none` throughout this producer's run.
An unconsumed input must have `consumed-by: none`; a consumed input must name the exact output.

| Input status | Output status | Action |
| --- | --- | --- |
| absent | absent | reject |
| absent | DRAFT | reject |
| absent | READY | reject |
| absent | CONSUMED | reject |
| DRAFT | absent | reject |
| DRAFT | DRAFT | reject |
| DRAFT | READY | reject |
| DRAFT | CONSUMED | reject |
| READY | absent | fresh-create |
| READY | DRAFT | resume-work |
| READY | READY | finish-consumption |
| READY | CONSUMED | reject |
| CONSUMED | absent | reject |
| CONSUMED | DRAFT | reject |
| CONSUMED | READY | no-op |
| CONSUMED | CONSUMED | reject |

`fresh-create` permits a new absent output only in a fresh run, never a missing resume target.
`resume-work` requires exact output capability and leaves the input READY while work/gates remain.
For `finish-consumption`, revalidate output.source against the exact input path, input.consumed-by
as `none`, and the recorded approval and verification bound to those input/output paths and content
(excluding lifecycle fields). Recheck current branch/HEAD or uncommitted diff identity where applicable.
Only then perform the input-consumption write with input.consumed-by equal to the exact output path.
For `no-op`, revalidate the recorded proof with the final reciprocal links instead of the
unconsumed-input condition; perform no writes or redispatch.
A missing capability, mismatched path/phase/next/content, absent approval/proof, or impossible state
must fail closed, preserving both files. A READY marker alone is not proof. Do not follow links to
undeclared evidence; request the exact missing capability or user-delimited scope instead.
Never select a most-recent output or recover by directory/body search.

Publication is ordered: record the phase's applicable approval and verification in the output,
publish output READY by per-file atomic replacement, then consume the input by per-file atomic
replacement. This is not a multi-file atomic operation; READY/READY is its sole verified intermediate
prefix. Resume repairs no other state and never repeats completed work or release actions.
In manual drive you are the enforcement: no parser, manifest, or validator checks this contract.
<!-- steepy:manual-handoff:v1:end -->

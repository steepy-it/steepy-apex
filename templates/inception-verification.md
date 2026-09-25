# Verification — Inception Record

> Structure for the verification-results document inside one inception run. One entry per check;
> states are exact and never blended into one another.

## Status legend
- `configured` — the check exists and is wired, not yet run.
- `executed` — the check ran to completion.
- `succeeded` — the check ran and passed.
- `not-executed` — the check was not run this pass (say why).
- `failed` — the check ran and did not pass.

## Checks
(One entry per check, each recording:)
- Environment (where it ran)
- Command or procedure (the exact invocation)
- Reference output (what a pass looks like)
- Result (one status from the legend above)
- Limits (what this check does not cover)

## Local CI
(Distinct field: the local CI outcome, never blended with remote success.)

## Remote success
(Distinct field: remote or hosted success, never inferred from local CI alone.)

## Deploy
(Excluded — with its reason — or included, with its own verification evidence. An excluded
deploy is not required to conclude; an included deploy is never declared successful without
proof.)

---
name: check
description: Run the hub coherence linter (validate-hub) and report any documentation-graph violations — broken links, orphan docs, or agents missing from the routing table.
user-invocable: true
---

# check

Run the hub linter from the repo root and report any violations.

> **Engine root:** this skill's base directory is `<engine-root>/skills/check/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

## Procedure

Run the linter:

```bash
node <engine-root>/scripts/validate-hub.mjs .
```

- If the output is `steepy validate-hub: OK`, report that the doc graph is coherent.
- If the output is `steepy validate-hub: no .apex hub found …`, the repo has not opted into steepy yet — tell the user to run the `init` skill (invoke it the way your harness invokes skills) to create the hub instead of reporting a coherent graph.
- If there are violations, list each one clearly and suggest how to fix it (broken links, orphan docs not linked from `_INDEX.md`, agents not referenced in the routing table).

### Model-mapping freshness

After the validate-hub report, run the model-mapping freshness verifier:

```bash
node <engine-root>/scripts/verify-model-mappings.mjs
```

- Include the per-row verdicts (`OK | STALE | UNKNOWN`) in the report.
- `STALE` means the live source shows drift: a human-ratified table patch is needed — the script prints the prepared patch, so surface it in the report for a human to ratify and apply.
- `UNKNOWN` is informational (source unreachable — offline degradation): report it as declared, never as a failure.

# discovery — Steps 3–4: coherence gate and report

### Step 3 — Coherence gate

Run the linter:

```bash
node <engine-root>/scripts/validate-hub.mjs .
```

The output MUST be `steepy validate-hub: OK`. Fix any stable-hub violations (a broken link, an
unresolved discovered-doc link) and re-run until green.

### Step 4 — Report

Summarize, per surface: items added, items updated (drift), docs discovered/linked, and any areas
skipped — so the user sees exactly what changed and that nothing was clobbered. If a re-run found
nothing new, report it as a no-op: no file changed.

When the run used the inception source, also report its decision outcomes from
`## Decision outcomes`: each decision accepted, with where it was written, or rejected with its
reason. If the inception source stopped, report why.

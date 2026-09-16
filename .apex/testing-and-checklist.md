# Testing & Checklist

- **Test command:** `npm test` (Node built-in runner; at least one suite per engine script, plus
  integration/dogfood/doc-lock suites).
- **Hub gate:** `node scripts/validate-hub.mjs .` must exit 0.

Before declaring a task done:
- [ ] The narrowest test for the change passes.
- [ ] `npm test` is green.
- [ ] `node scripts/validate-hub.mjs .` is green.
- [ ] `.apex/` is updated if the change touched a standard or domain term.
- [ ] Durable decisions from specs/plans were promoted into stable docs when needed.

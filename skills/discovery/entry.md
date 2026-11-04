# discovery — Steps 0–1: preconditions and run scoping

### Step 0 — Preconditions

If `.apex/_INDEX.md` is **absent**, tell the user the hub does not exist yet: run the `init` skill
(invoke it the way your harness invokes skills) first, then **stop** — `discovery` populates an
existing hub, it does not create one.

Otherwise read the hub's current state before scoping the run:
- `.apex/_INDEX.md` — enumerate the surfaces and their standard docs from the routing table. A
  "Min docs" link pointing inside a **subfolder** of `standards/` marks a **modular surface**: the
  link target is its core, and the core's mini-routing table lists its leaf docs. A plain
  `standards/<surface>.md` link is the single-file form.
- `.apex/conventions.md` — the cross-surface rules already recorded.
- `.apex/glossary.md` — the domain terms already recorded.

### Step 1 — Run scoping

Ask the user to scope the run: which surface(s) to enrich (default: all surfaces in the routing
table), and whether to also include the cross-cutting docs this run — `conventions.md`,
`glossary.md` — plus project-doc discovery (README / `docs/` / ADRs). This keeps a run bounded and
re-runnable one surface at a time.

If `.apex/inception/run.json` exists, its `schema` is `steepy-inception-run/v2`, and its `status`
is `complete` (with phase `complete`), also offer the **inception source**: import decisions only
if Step 2a verifies that completed delivery. Read only that one file to check this, and never list
`.apex/inception/`. This is a candidate offer, not a verified source; do not load approval or document
bodies here. Otherwise do not mention the inception source; absent, active or blocked runs and an
unsupported run format leave ordinary discovery available with the user's selected scope. Never
migrate or restart a run.

When the user chooses the inception source, run Step 2a right after this step, before Step 2. Its
gate accepts the stable hub documents only exactly as `init` certified them, so any write-back to
`conventions.md`, a standard or `glossary.md` before the gate ends the source.

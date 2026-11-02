# discovery — Step 2: per-surface iterative loop

### Step 2 — Per-surface iterative loop

For each surface selected in Step 1, run this loop:

1. **Scope (interview → areas).** Propose candidate exploration areas drawn from the surface-standard
   section taxonomy — **Scope**, **Conventions**, **Anti-patterns**, **Testing** — plus a couple of
   surface-type heuristics (e.g. a UI surface might add "component patterns"). The user picks which
   areas matter for this run, or adds their own.
2. **Explore.** Ensure `.apex/work/discovery/` exists (create it if absent), then set
   `[REPORT_FILE] = .apex/work/discovery/YYYY-MM-DD-<surface>.md`. If your harness provides a
   task/subagent tool, dispatch a fresh subagent per surface using
   `skills/discovery/explore-surface-prompt.md`; otherwise perform the exploration inline in a
   dedicated pass over the same inputs, and state the inline degradation in the run's report (Step 4).
   When you dispatch, always set `model: standard`
   explicitly (the explorer's floor tier), rising to `model: most-capable` for a large or subtle
   surface. Pass it the surface name/path, the areas picked in Step 2.1, `[REPORT_FILE]`, the surface's
   current standard docs as `[STANDARD_PATHS]` and the glossary as `[GLOSSARY_PATH]` — the single `standards/<surface>.md`, or for a modular surface the core
   plus every leaf its mini-routing table lists — and `glossary.md`. It reads the surface's code and nearby docs
   (README/`docs`/ADR), writes its full findings report — observed conventions, candidate
   anti-patterns, candidate glossary terms, and discovered doc files, each with `file:line`
   evidence and no invention — to `[REPORT_FILE]`, and returns only a terse status. This subagent is
   an **explorer, not a reviewer**: it only gathers raw material; it does not judge, decide, or write
   hub or code changes. Validate the four-field completion defined in
   `skills/discovery/explore-surface-prompt.md` → "Output Format", including the exact `[REPORT_FILE]`.
   For BLOCKED, read that report's blocker and stop before the interview. For DONE, before Step 2.3,
   read the report back from `[REPORT_FILE]` — the terse return status is not the report.
3. **Emergent-area check.** If the report flags important findings outside the areas scoped in Step
   2.1, present them to the user and ask whether to fold them into this run before drafting
   (optionally re-dispatch the explorer narrowly on just the new area).
4. **Seeded interview.** Walk the report area by area. The report lives in a file the user never
   saw — so before any acceptance prompt, print each item in a plain text message, immediately
   followed by its **write-back preview**: the exact text that would be written, and its
   destination. For the three item-card areas — Observed conventions, Candidate anti-patterns,
   Candidate glossary terms — print the item's full card (all 4 fields: Proposed doc text,
   Evidence, Occurrences, Why it matters). For **Discovered doc files** — which the explorer
   reports as `path → one-line purpose` (+ file:line), not a 4-field card — print that line
   instead, followed by its own preview: which hub doc would carry the link. The interviewer routes
   each item to a destination doc/section (e.g. `standards/<surface>.md → Anti-patterns`,
   `glossary.md`, or the link target for a discovered doc), or judges a promotion to the
   cross-surface `conventions.md` when the pattern isn't specific to this one surface; the explorer
   only tagged the item by area, never by destination, because only the interviewer sees every
   surface. On a modular surface, route within the standard by the core's mini-routing table: a
   rule spanning the whole surface → the core; a sub-area rule → the matching leaf; a rule no
   leaf covers → the core. Decide **accept / correct / skip** on the preview, never on the card or line alone: the
   card/line explains the finding, but the preview is the actual text-plus-destination the user is
   approving. A **correction re-renders the corrected preview** before anything is written. Ask one
   question at a time, with numbered options and a recommendation; use your harness's question UI if
   it has one. Never present items as bare IDs (T1, T2, …) as option labels — the short option labels
   cannot hold a draft, and the user must read the content, not a label. On a re-run, surface only
   **new** or **drifted** items — compare against what is already written (on a modular surface:
   the core plus its leaf docs) — each rendered as a
   preview **diff** against the current doc, so the same rule applies uniformly: the user always
   decides on the exact final text that touches the doc, whether it's a fresh addition or a drift
   correction. For a **split proposal** item card — emitted only for a surface still in single-file
   form — the preview shows the **complete proposed structure** instead of a text snippet: the `standards/<surface>/` tree (core + leaf files), the
   core's mini-routing table, and the updated routing row in `_INDEX.md`. Accept/correct/skip is
   decided on that full preview like any other item, and the bare-ID ban applies the same way; the
   split is always a human decision — without an explicit accept, nothing is touched.
5. **Write-back.** Apply only the accepted items, writing **verbatim** the text approved in each
   item's preview (a correction may retouch a line, but the write itself copies the approved
   preview, not the original card):
   - conventions / anti-patterns / scope → the matching section of the surface's standard doc:
     `standards/<surface>.md`, or on a modular surface the core or matching leaf as routed in
     Step 2.4
   - domain terms → `glossary.md`
   - cross-surface rules → `conventions.md`
   - discovered docs → a link from the appropriate hub doc, using a path relative to the hub doc
     being edited, pointing at a file that exists on disk — verify the target exists before writing
     the link. Never link into `.apex/work/**`.
   - an accepted **split proposal** → creates the `standards/<surface>/` folder, redistributes the
     rules between the core and its leaf docs, updates the routing row in `_INDEX.md` to point at
     the new core, updates known references to the old `standards/<surface>.md` path (grep
     `.apex/` and this project's `skills/`), and removes `standards/<surface>.md`.

   Writes are **additive and diff-gated**: append new content; on a confirmed drift, replace only the
   specific stale line. Never overwrite a file wholesale, and never clobber human-authored text —
   every write is gated per item by the user in Step 2.4, not batched at the end. A leftover
   reference to the removed `standards/<surface>.md` becomes a broken link — Step 3 (validate-hub)
   blocks it, so a split cannot half-succeed silently.

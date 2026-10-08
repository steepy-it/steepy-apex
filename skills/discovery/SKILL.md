---
name: discovery
description: Populate and refresh `.apex` hub docs (glossary, surface standards, cross-surface conventions) from the real codebase via a seeded, per-item confirmed interview. Re-runnable — a second run surfaces only new or drifted items.
user-invocable: true
---

# discovery

Populate and refresh the hub's prose docs — `glossary.md`, each surface standard (the single
`standards/<surface>.md` file or the modular `standards/<surface>/` folder), and `conventions.md` —
from the actual codebase, via a seeded interview the user confirms item by item.

`discovery` is a **standalone** hub-aware skill, like `init` / `new-surface` / `check` — it is not
part of the brainstorm → plan → implement → review chain. It has its own precondition step below and
does not follow the chain skills' shared gear-selection or Model-Selection-lock format.

> **Engine root:** this skill's base directory is `<engine-root>/skills/discovery/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

## Procedure

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

If `.apex/inception/run.json` exists and its `status` is `complete`, also offer the **inception
source**: turn the decisions of that completed inception run into hub text (Step 2a). Read only that
one file to check this, and never list `.apex/inception/`. Otherwise do not mention the inception
source, and run exactly as below.

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

### Step 2a — Inception source (complete run only)

Run this step only when the user chose the inception source in Step 1. It turns the decisions of a
completed inception run into hub text. Read by exact path only: never list `.apex/inception/` or a
directory under it. A stop in this step ends only the inception source; Step 3 and Step 4 still run.

1. **Read and verify.** Read the descriptor, `.apex/inception/run.json`, then only the paths it
   binds: the latest bound approval record — the last element of the descriptor's `approvals`
   array, by binding order, never by file recency — then that record's `documents[].path`, and the
   descriptor's `verification.path`. Then run:

   ```bash
   node <engine-root>/scripts/inception-state.mjs verify-approval --repo-root .
   ```

   On any divergence (`"ok":false`), stop the inception source and report each divergence to the
   user: drifted documents are not promoted. Also stop and report it when
   `.apex/inception/project/decision-register.md` is not among the approved documents.
2. **Explore.** Ensure `.apex/work/discovery/` exists (create it if absent), then set
   `[REPORT_FILE] = .apex/work/discovery/YYYY-MM-DD-inception.md`. If your harness provides a
   task/subagent tool, dispatch a fresh subagent using `skills/discovery/explore-inception-prompt.md`,
   and always set `model: standard` explicitly. Pass `[INPUT_PATHS]` = exactly the descriptor, the
   approval record, every approved document, and the verification results — no other path. Also
   pass `[REPORT_FILE]`, `glossary.md` as `[GLOSSARY_PATH]`, `conventions.md` as
   `[CONVENTIONS_PATH]`, and as `[STANDARD_PATHS]` the standard docs of every surface in the routing
   table (the single `standards/<surface>.md`, or the core plus every leaf its mini-routing table
   lists). Otherwise run the same prompt inline over the same inputs, and state the inline
   degradation in the run's report (Step 4). Validate the four-field completion defined in
   `skills/discovery/explore-inception-prompt.md` → "Output Format", including the exact
   `[REPORT_FILE]`. For BLOCKED, read that report's blocker and stop the inception source. For DONE,
   read the report back from `[REPORT_FILE]` before the interview.
3. **Walk the decision register.** The report holds one item card per `DR-n`, in register order.
   For each decision, print in a plain text message its card — Proposed doc text, Evidence (the
   local file and line; it is for the interview only), Verification status (from the verification
   results' `## Coverage` rows), Promotion class — immediately followed by its write-back preview:
   the destination and the exact text that would be written. Then run the same accept / correct /
   skip interview as Step 2.4: decide on the preview, a correction re-renders the preview, one
   question at a time. Never use bare IDs (DR-1, DR-2, …) as option labels: the user decides on the
   printed card and preview. A skip is a rejection: ask the user for its reason.
4. **Promotion rules.** Every decision in the register is approved: Step 2a.1 verified the approval.
   - Approved and verified (`verified`) → may be written as an existing component or rule.
   - Approved but unverified (`unverified`) → written as a design choice, not as an existing
     component.
   - A future flow (`future`) → written as context in `conventions.md`, never as an implemented
     component, a spec, or a started task.
5. **Write-back.** Destinations are only `conventions.md`, the routed surface standards, and
   `glossary.md`: no new hub document and no `_INDEX.md` change. Write-back text never names, cites,
   or links `.apex/inception/`; the Evidence stays in the interview. Write verbatim the approved
   preview, additive and diff-gated as in Step 2.5.
6. **Decision outcomes.** Every register decision ends accepted (written) or rejected with a reason.
   Record the outcomes in `[REPORT_FILE]` under `## Decision outcomes`, one line per decision:
   `DR-n — accepted` or `DR-n — rejected: <reason>`. Re-runs follow the new-or-drifted rule of Step
   2.4: a decision already written, unchanged, is not asked again and is recorded as accepted.

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

## Model Selection

Always set `model:` explicitly when dispatching the Explore subagent in Step 2.2 and the inception
explorer in Step 2a.2 — an omitted model inherits the expensive session model and defeats the tier
policy. Floor at `standard`; rise to `most-capable` for a large or subtle surface. The inception
explorer runs at `standard`. Translate the tier to a concrete model by judgment at
dispatch time using your harness's available models; `most-capable` is the ladder's top rung, not an
open-ended "best available", and a pricier model sitting above it is never reached from a tier.
Never hardcode a concrete model id in `explore-surface-prompt.md` or `explore-inception-prompt.md`.

This flow dispatches **no reviewer subagent**: every write is prose to a stable doc, gated per item by
the human in the Step 2.4 seeded interview (Step 2a.3 for the inception source); `validate-hub`
(Step 3) is the deterministic net. The Explore subagent dispatched in Step 2.2 and the inception
explorer dispatched in Step 2a.2 are explorers, not reviewers.

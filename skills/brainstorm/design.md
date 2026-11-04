# brainstorm — Steps 2–5.5: understand, propose, present, finalize, self-review

### Step 2 — Understand the idea

**Gear 2 and 3.** Grill the idea against the hub, one question at a time — surface and sharpen, don't just collect requirements. Treat the open decisions as a **design tree**: each decision branches into the ones that hang off it. Work the tree in dependency order — never ask a decision whose prerequisites are still unsettled. Split facts from decisions: **facts** are this skill's job — explore the codebase instead of asking; never ask the user for something look-up-able. **Decisions** are the user's — put each one to them and wait. Ask multiple-choice when possible and recommend an answer. Focus on purpose, constraints, and success criteria — and challenge along these hub-aware dimensions:

- **Sharpen terminology against the glossary.** When a term conflicts with, or is vaguer than, `.apex/glossary.md`, call it out and propose the canonical term ("you say 'doc' — Standard, Convention, Glossary, or a Work artifact? Those are different things in the hub").
- **Probe concrete edge-case scenarios.** Stress the hub relationships the idea touches with specific invented scenarios — surface ownership, durable decision vs work artifact, when the anti-orphan rule bites — and force a precise answer.
- **Cross-reference the code for Drift.** When the user states how something works, check whether the code agrees (`scripts/`, `skills/`, `templates/`, `tests/`); surface any divergence between the docs and reality.

**Exit criterion.** Step 2 is done when every branch of the design tree has been visited and nothing is left silently assumed, and the user confirms shared understanding.

**Write nothing to the hub here.** Step 2 grills; it does not mutate docs. An already-durable delta (a latent convention the code already follows, or an explicit override) routes to the existing **Step 1.5** channel; a speculative design delta — a term sharpened for something not yet built — is **captured in the spec** (Step 5) as a deferred proposal for downstream promotion.

### Step 3 — Propose approaches

Present 2–3 approaches with trade-offs, lead with your recommendation and reasoning.

### Step 4 — Present the design (gate)

Write the design into a new spec at its conventional path, `.apex/work/specs/YYYY-MM-DD-<topic>.md`.
Check only target existence first. An existing target requires a stop for an absent path or explicit
user-delimited revisit scope: no historical body read or overwrite is authorized by fresh entry.
Within this invocation, continue editing only the draft it created.
Create `.apex/work/specs/` if it does not exist. After the verdict/contract metadata and before the title, write this workflow header:

```yaml
<!-- steepy-workflow: v1
phase: brainstorm
status: DRAFT
next: implement
source: none
consumed-by: none
-->
```

Use `next: implement` for the default Gear-2 direct route. Use `next: plan` for Gear 3 and for a
Gear-2 light plan the user explicitly requested before handoff. Do not ask Gear-2 users whether they
want a plan merely to create a gate: direct implementation is the lean default.

Present it in sections scaled to complexity (architecture, components, data flow, error handling, testing). Two sections are canonical — required at gear 3, recommended at gear 2:

- **Out of Scope** — what the spec consciously excludes, so downstream review flags scope
  creep against an explicit list instead of intuition.
- **Testing Decisions** — the boundaries the work will be tested at, and prior art
  (similar tests already in the repo).

At gear 3 an empty section is written as a real statement ("nothing excluded"), never omitted. Point the user at the file — not chat prose — and ask for approval section by section, referencing the document by file path and section name.

Approval gates finalization and handoff, not file creation: the DRAFT file records only material already discussed, so writing it early does not anchor the design.

The gate: no finalization, no handoff, no hub mutation until the user approves each section. Harness-portable: the artifact is a file path, nothing harness-specific.

### Step 5 — Finalize the approved draft

Incorporate the requested changes from the Step 4 review into the draft file. Leave the workflow header at `status: DRAFT` until the applicable approval gate completes. Make sure the owning surface, the success criteria, and the Out of Scope and Testing Decisions sections are stated explicitly (the canonical sections per Step 4's gear gradient).

For every new gear-2 and gear-3 spec, use this canonical machine-readable metadata and criteria grammar. Direct Gear-2 `implement` copies these fields into its task brief, so a light spec has less prose, never fewer fields:

- `- **Owning surface:** \`<one registered surface>\``
- `- **Cross-cutting surfaces:** \`<surface>\`, ...` or `- **Cross-cutting surfaces:** none`
- `- **Feature complexity:** \`<one allowed value>\``
- exactly one literal `## Success criteria` heading;
- stable sequential criterion IDs under that heading: `- **SC1:** <criterion>`, `- **SC2:** <criterion>`, and so on.

Do not place cross-cutting surfaces inside the owning-surface value. The finalized spec records exactly one `Feature complexity: mechanical | integration | design` field, selecting the one value that describes the feature as a whole.

If the Step 2 grilling surfaced a **speculative hub-delta** (a term or rule worth promoting once the work proves it), record it in the spec as a deferred proposal — not a canonised hub edit; downstream review/check promotes it if it holds.

Do not register the spec in `.apex/_INDEX.md` and do not create a specs sub-index.
Specs are local workflow artifacts, not stable hub documentation.

### Step 5.5 — Self-review the spec (free gate)

**Gear 2 and 3** — skip only at gear 1 (no spec is produced there).

Read the spec you just wrote with fresh eyes and fix any of these inline — no re-review needed, just fix and move on:
1. **Placeholder scan** — any "TBD", "TODO", or vague requirement? Fix it.
2. **Internal consistency** — do the design, success criteria, and architecture agree with each other?
3. **Scope check** — is this focused enough for a single plan, or does it need decomposition first?
4. **Ambiguity check** — could a requirement be read two ways? Pick one and make it explicit.
5. **Hub binding** — is the owning surface stated correctly, and — if Step 1.5 produced a write-back — was it actually written?
6. **Feature complexity** — is there exactly one `Feature complexity` field, and is its value exactly `mechanical | integration | design`?
7. **Machine contract** — does the spec contain the canonical ownership fields, exactly one literal `## Success criteria` H2, and unique sequential `SC1`…`SCn` IDs?

### Write-back routing

When a GAP resolution or a CONFLICT override yields a durable decision, write it back **only if
the fork will recur** (a future task will face the same choice):
- a term / ambiguity → `.apex/glossary.md`
- a rule scoped to one surface → the exact routed single standard, modular core, or matching leaf
- a cross-cutting recurring fork → `.apex/conventions.md`

A *decision*-shaped write-back to `.apex/conventions.md` passes a second filter: record it
only when the decision is **hard to reverse**, **surprising without context**, and **the
result of a real trade-off**. Any one missing → the decision stays local in the spec.
Terms/ambiguities (glossary write-backs) keep the recurrence test only.

A genuine **one-off** stays local in the `.apex/work/` spec — do not bloat the hub. Write back
**inline** as the decision crystallizes, not batched at the end.

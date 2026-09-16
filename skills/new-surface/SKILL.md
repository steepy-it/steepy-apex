---
name: new-surface
description: Scaffold a surface standard and portable specialist adapter triad, then register the surface in the hub.
user-invocable: true
argument-hint: 'surface name and its path'
---

# new-surface

Add one governed surface through the common specialist planner.

> **Engine root:** this skill's base directory is `<engine-root>/skills/new-surface/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

## Procedure

1. Read `.apex/_INDEX.md` and gather the missing confirmed inputs:
   - surface `name`, a lowercase hyphenated identifier;
   - repository-relative surface `path`;
   - semantic specialist `agent`, defaulting to `<name>-agent` only when the user accepts it;
   - surface `testCmd`.

2. Run the surface scaffolder from this skill's engine root:

   ```bash
   node <engine-root>/scripts/new-surface.mjs \
     --name <name> \
     --path <path> \
     --agent <agent> \
     --test "<testCmd>" \
     --hub <repo-root>
   ```

   `new-surface.mjs` first reports which explicit mode it used:

   - **active-v1** — it derives the real Project identity from the canonical managed `AGENTS.md`,
     adds or confirms the surface in that full Project model, and routes the change through the
     public planner in `project-scaffold.mjs`. It updates the managed root and routing row together
     with the create-only standard and generated specialist triad. If the planner reports a conflict,
     make the user choose only from its emitted ID and choices, then repeat the command with one
     `--resolution <id=choice>` per choice. Do not infer a replacement or add an unoffered choice.
   - **preparatory-unbound** — when no managed Project identity exists yet, it explicitly limits
     itself to the common specialist planner. It plans all four surface artifacts before the first
     write and creates the standard plus specialist triad without pretending to update a Project
     identity that does not exist.

   In both modes the surface result is:

   - `.apex/standards/<name>.md`;
   - `.claude/agents/<agent>.md`;
   - `.codex/agents/<agent>.toml`;
   - `.opencode/agents/<agent>.md`.

   Do not reproduce planner provenance markers or hand-render an adapter in this skill. The standard
   remains create-only. If the surface is a repair of an incomplete scaffold, add `--repair`; repair
   preserves existing artifacts and creates only absent members of the standard-plus-triad result.

3. In **active-v1** mode, do not edit generated or managed artifacts after the command: the public
   workflow has already made the root, routing row, standard, and triad agree. In
   **preparatory-unbound** mode only, append the emitted routing row to `.apex/_INDEX.md` if that
   surface has no row. Never rewrite the routing table or change another row.

4. Verify:

   ```bash
   node <engine-root>/scripts/validate-hub.mjs .
   ```

   Fix coherence errors before reporting completion. Then rerun with `--repair`; a complete result
   must report every standard/triad member preserved and leave bytes, modes, and mtimes unchanged.
   Report each member of the standard-plus-triad result as created or preserved.

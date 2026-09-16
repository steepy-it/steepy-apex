---
name: {{projectName}}-bootstrap
description: Project entry point for {{projectName}}. Loads the root instructions and routes work through the governed hub.
user-invocable: true
---
<!-- steepy:generated:{{projectName}}-bootstrap:v1 -->

# {{projectName}} bootstrap

Use this skill before working on the project.

## Procedure

1. Read `AGENTS.md` in full for the project overview, development commands, and confirmed surfaces.
2. Read `.apex/_INDEX.md` in full for the routing table and semantic knowledge map.
3. Match the task to the owning surface and read only the minimum documents named by its routing row.
4. State the owning surface and specialist agent before changing files.
5. When a Steepy workflow is needed, invoke it by its semantic skill name as listed in `.apex/_INDEX.md`.
6. Run the owning surface's test command and the hub coherence gate before reporting completion.

## Work-artifact boundary

Do not ordinarily enumerate, search, or read under `.apex/work/**`.

A workflow phase may consume only the exact work inputs named by an accepted handoff. A pathless workflow invocation may perform only bounded workflow-header recovery discovery. Exact paths or a broader work-area scope are permitted only when the user explicitly delimits them. This applies transitively to child agents: only the phase orchestrator interprets a handoff.

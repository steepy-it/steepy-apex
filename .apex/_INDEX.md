<!-- steepy-hub-version: 1 -->
# steepy-apex - AI Navigation Hub (DAG Root)

Mandatory entry point for AI agents. Read this before opening broad areas.

## Required Navigation Sequence
1. Read this file completely.
2. Classify the task and find its surface in the routing table below.
3. Load the minimum docs: the owning standard + the testing checklist.
4. Implement the smallest local change; validate with the narrowest check.
5. Update `.apex/` if the task changes a standard, workflow, or domain term.

## Knowledge Base Map
- [Conventions](conventions.md)
- [Glossary](glossary.md)
- [Testing & Checklist](testing-and-checklist.md)

## Routing Table

| Surface | Min docs | Specialist agent | Applicable skill |
|---|---|---|---|
| `adapters` | [standards/adapters.md](standards/adapters.md) | `adapters-agent` | — |
| `scripts` | [standards/scripts.md](standards/scripts.md) | `scripts-agent` | — |
| `skills` | [standards/skills.md](standards/skills.md) | `skills-agent` | — |
| `templates` | [standards/templates.md](standards/templates.md) | `templates-agent` | — |
| `tests` | [standards/tests.md](standards/tests.md) | `tests-agent` | — |

## Core Directives
1. **Anti-orphan:** every stable `.apex/**.md` docs entry must be reachable from this file (directly or via a sub-index). `validate-hub.mjs` excludes `.apex/work/**` as local gitignored workflow state.
2. **Living docs:** update `.apex/` before declaring a task done if it changed a standard or domain term.
3. **Work artifacts:** specs and plans live under `.apex/work/` and are gitignored local workflow state. Promote durable decisions into stable docs before declaring work done.

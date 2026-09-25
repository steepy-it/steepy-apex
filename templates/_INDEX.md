<!-- steepy-hub-version: 1 -->
# 🧠 {{projectName}} — AI Navigation Hub (DAG Root)

Mandatory entry point for AI agents. Read this before opening broad areas.

## Required Navigation Sequence
1. Read this file completely.
2. Classify the task and find its surface in the routing table below.
3. Load the minimum docs: the owning standard + `testing-and-checklist.md`.
4. Implement the smallest local change; validate with the narrowest check.
5. Update `.apex/` if the task changes a standard, workflow, or domain term.

## Knowledge Base Map
- [Conventions](conventions.md)
- [Glossary](glossary.md)
- [Testing & Checklist](testing-and-checklist.md)

## Routing Table
| Surface | Min docs | Specialist agent | Applicable skill |
|---|---|---|---|
{{routingRows}}

## Core Directives
1. **Anti-orphan:** every stable `.apex/**.md` document must be reachable from this file (directly or via a sub-index), explicitly excluding local `.apex/work/**` and `.apex/inception/**` artifacts. Enforced by `validate-hub.mjs`.
2. **Living docs:** update `.apex/` before declaring a task done if it changed a standard or domain term.
3. **Work artifacts:** specs, plans, and inception materials live under `.apex/work/` and `.apex/inception/` as gitignored local state. Promote durable decisions into stable docs — already self-sufficient, independent of either local area — before declaring work done.
{{gitPolicyDirective}}

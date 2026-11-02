---
name: init
description: Scaffold or repair a governed .apex hub and portable project instructions from one confirmed project model.
user-invocable: true
---

# init

Build or repair a complete `.apex/` governance hub without losing confirmed project data or overwriting user-owned content.

> **Engine root:** this skill's base directory is `<engine-root>/skills/init/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

## Workflow contract

The interview produces one immutable, authoritative confirmed interview record. It retains every
confirmed value used later by the planner or hub renderer, so no confirmed input lives only in transient
chat state. Both fresh init and repair use that record and the same planner workflow. The planner owns
generated provenance and update mechanics; this skill does not copy its marker strings or reproduce its
merge logic.

#### Authoritative confirmed interview record

```json
{
  "projectName": "project-slug",
  "description": "confirmed description or empty string",
  "devCommands": ["npm test"],
  "surfaces": [
    {
      "name": "web",
      "path": "apps/web",
      "agent": "web-agent",
      "testCmd": "npm test"
    }
  ],
  "domainVocabulary": {
    "hasSpecializedVocabulary": true,
    "entries": [
      { "term": "confirmed term", "definition": "confirmed definition" }
    ]
  },
  "gitPolicyDirective": "4. **Git policy:** confirmed policy text"
}
```

#### Exact planner projection

Derive this planner projection from the authoritative confirmed interview record:

```json
{
  "projectName": "project-slug",
  "description": "confirmed description or empty string",
  "devCommands": ["npm test"],
  "surfaces": [
    {
      "name": "web",
      "path": "apps/web",
      "agent": "web-agent",
      "testCmd": "npm test"
    }
  ],
  "resolutions": {}
}
```

The planner CLI input is Project model v1 and has exactly those five top-level keys; never add
`domainVocabulary`, `gitPolicyDirective`, or any other unsupported key because unknown keys are rejected.
The projection is derived data, not a second source of truth. Hub documents use the authoritative record
directly for values outside Project model v1.

## Procedure

The steps live in co-located files, each read in full at the point named here:

| Steps | File | Read it |
|---|---|---|
| 0–2: choose fresh init or repair, detect and confirm the model, serialize the record | `entry.md` | at the start of every run, fresh init or repair |
| 3: preview, resolve exact conflicts, apply, certification and its recovery | `apply.md` | after the record is serialized, before the first preview |
| 4–5: complete the governed hub, validate and report | `finish.md` | after the planner apply succeeds |

Only this SKILL.md is meant to stay in context for the whole run; a context compaction can drop
the step files you read earlier. Before you act on a step, its file must be fully in view. If it is
not — after a compaction, on resume, or when only a summary of it remains — re-read it from this
skill's base directory first. Never act on a summary of a step file.

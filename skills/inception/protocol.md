# Inception protocol

The local record of one inception run: where its files live, how the descriptor changes, how an
approval binds to bytes, and what the transfer to `init` contains. Load it before the first write
under `.apex/inception/` and before every descriptor update.

The helpers `scripts/inception-state.mjs` and `scripts/inception-handoff.mjs` own these formats.
Their schemas are closed: an unknown field is refused. When this file and a helper disagree, the
helper wins; report the difference. Values in the examples are illustrative: each `sha256` is the
SHA-256 of the exact referenced bytes.

## Local area

- `.apex/inception/.gitignore` — exactly `*` plus a newline; `start` writes it first. It is local too.
- `.apex/inception/state.json` — the one canonical descriptor. Change it only through `start` and
  `update`; never edit it by hand.
- `.apex/inception/<run-id>/<file>` — the run's files. Each path segment under `<run-id>/` starts
  with a letter or digit, then uses letters, digits, `.`, `_`, and `-`; nested directories are allowed
  (`research/runtime.md`). Keep every file at most 1 MiB; split larger material into separate exact
  files.

The area stays outside the hub DAG, `validate-hub`, and every stable reader. No stable document
links into it. The descriptor is the one known point for classification. Every other read uses an
exact path: one the descriptor references, one the current step names, or one the user gives. A
directory listing never rebuilds a run.

| Run file | Written by | Holds |
|---|---|---|
| `reconnaissance.md` | you | materials, facts, simulations, constraints |
| `project.md` (one or more documents) | you | the project, structured by `<engine-root>/templates/inception-project.md` |
| `approval.json` | you, after explicit approval | the approval record |
| `bootstrap-log.md` | you | the intent before each effect, the observed outcome after |
| `checkpoint-<n>.json` | `inception-handoff.mjs checkpoint` | a code checkpoint |
| `verification.md` | you | results, structured by `<engine-root>/templates/inception-verification.md` |
| `confirmed-inputs.json`, `promotion.json`, `init-handoff.json` | you | the transfer inputs |
| `init-receipt.json` | `inception-handoff.mjs prepare` and `finalize` | the init receipt |

A record that binds bytes is never edited after it is bound. A new decision or observation uses a
new exact path (`approval-2.json`, `checkpoint-3.json`).

## Descriptor

```json
{
  "schemaVersion": 1,
  "runId": "0f8e6b8a-3c1d-4e2f-9a7b-5c6d7e8f9a0b",
  "phase": "init",
  "status": "active",
  "approval": {
    "path": ".apex/inception/0f8e6b8a-3c1d-4e2f-9a7b-5c6d7e8f9a0b/approval.json",
    "sha256": "1111111111111111111111111111111111111111111111111111111111111111"
  },
  "checkpoint": {
    "path": ".apex/inception/0f8e6b8a-3c1d-4e2f-9a7b-5c6d7e8f9a0b/checkpoint-2.json",
    "sha256": "2222222222222222222222222222222222222222222222222222222222222222"
  },
  "init": {
    "status": "not-started",
    "handoff": null,
    "receipt": null
  }
}
```

- `phase` → `reconnaissance`, `architecture`, `research`, `approval`, `bootstrap`, `verification`,
  `init`, `complete`.
- `status` → `active`, `blocked`, `complete`.
- `approval`, `checkpoint` → `null` or `{ "path", "sha256" }` naming an exact file of this run.
- `init` → `status` (`not-started` → `in-progress` → `complete`, never back), `handoff`, `receipt`.
- `bootstrap` and later phases need `approval`. `phase: complete` and `status: complete` need
  `init.status: complete`.

```bash
node <engine-root>/scripts/inception-state.mjs inspect --root . --state .apex/inception/state.json
node <engine-root>/scripts/inception-state.mjs update --root . --state .apex/inception/state.json --expected-sha256 <descriptor-sha256> --set '<changes-json>'
```

`inspect` prints the state, the descriptor, its digest, and the Git exclusion. `update` needs the
digest you last observed. `<changes-json>` sets `phase`, `status`, `approval`, or `checkpoint`, for
example `{"phase":"architecture"}`. Leave `init` to `prepare` and `finalize`. Every reference is
checked against its file on each update.

## Digests

Compute the digest of exact bytes with:

```bash
node -e "const f=require('node:fs'),c=require('node:crypto');for(const p of process.argv.slice(1))console.log(c.createHash('sha256').update(f.readFileSync(p)).digest('hex')+'  '+p)" <path>...
```

## Approval record

Write it only after the user explicitly approves the whole project as presented. List every project
document with the digest of the bytes the user approved.

```json
{
  "inception-approval": "steepy-apex/v1",
  "run-id": "0f8e6b8a-3c1d-4e2f-9a7b-5c6d7e8f9a0b",
  "project": [
    {
      "path": ".apex/inception/0f8e6b8a-3c1d-4e2f-9a7b-5c6d7e8f9a0b/project.md",
      "sha256": "3333333333333333333333333333333333333333333333333333333333333333"
    }
  ]
}
```

Bind it and enter bootstrap in one update:
`{"approval":{"path":"<approval-path>","sha256":"<approval-sha256>"},"phase":"bootstrap"}`.
A project document that changes after approval no longer matches its digest. The change needs a
targeted decision and a new approval record at a new path.

## Code checkpoint

```bash
node <engine-root>/scripts/inception-handoff.mjs checkpoint --root . --run-id <run-id> --output .apex/inception/<run-id>/checkpoint-<n>.json --path <repo-path> --path <repo-path>
```

Name every relevant path: manifests, lockfiles, command files, configuration examples, and
representative code. Never name files `init` writes: `.apex/**`, `AGENTS.md`, `CLAUDE.md`, `.agents/`,
`.claude/`, `.codex/`, `.opencode/`. Bind the printed `path` and `sha256` with
`{"checkpoint":{...}}`. A checkpoint records bytes and branch/HEAD; it does not judge them.

```json
{
  "inception-checkpoint": "steepy-apex/v1",
  "run-id": "0f8e6b8a-3c1d-4e2f-9a7b-5c6d7e8f9a0b",
  "git": {
    "branch": "main",
    "head": "4444444444444444444444444444444444444444"
  },
  "files": [
    {
      "path": "Makefile",
      "sha256": "5555555555555555555555555555555555555555555555555555555555555555"
    },
    {
      "path": "bin/start",
      "sha256": "6666666666666666666666666666666666666666666666666666666666666666"
    },
    {
      "path": "config/app.example.env",
      "sha256": "7777777777777777777777777777777777777777777777777777777777777777"
    }
  ]
}
```

## Transfer to init

The envelope is `inception-handoff: steepy-apex/v1`, separate from the chain's
`handoff: steepy-apex/v1`. Every value is an exact file of this run, except `state`. No path serves
two roles. A role is never read from the descriptor.

| Role | Value |
|---|---|
| `state` | exactly `.apex/inception/state.json` |
| `approval` | the approval record the descriptor binds |
| `project` | every approved project document, listed one by one |
| `verification` | the checkpoint the descriptor binds, plus at least one results document |
| `confirmed-inputs` | the six-field record `init` uses |
| `promotion` | the promotion table |

### Handoff

```json
{
  "inception-handoff": "steepy-apex/v1",
  "next": "init",
  "run-id": "0f8e6b8a-3c1d-4e2f-9a7b-5c6d7e8f9a0b",
  "required": {
    "state": ".apex/inception/state.json",
    "approval": ".apex/inception/0f8e6b8a-3c1d-4e2f-9a7b-5c6d7e8f9a0b/approval.json",
    "project": [
      ".apex/inception/0f8e6b8a-3c1d-4e2f-9a7b-5c6d7e8f9a0b/project.md"
    ],
    "verification": [
      ".apex/inception/0f8e6b8a-3c1d-4e2f-9a7b-5c6d7e8f9a0b/checkpoint-2.json",
      ".apex/inception/0f8e6b8a-3c1d-4e2f-9a7b-5c6d7e8f9a0b/verification.md"
    ],
    "confirmed-inputs": ".apex/inception/0f8e6b8a-3c1d-4e2f-9a7b-5c6d7e8f9a0b/confirmed-inputs.json",
    "promotion": ".apex/inception/0f8e6b8a-3c1d-4e2f-9a7b-5c6d7e8f9a0b/promotion.json"
  }
}
```

### Confirmed inputs

The same six fields as the authoritative confirmed interview record of `init`. `init` projects the
first four, plus `resolutions`, into Project model v1.

```json
{
  "projectName": "clinic-booking",
  "description": "Appointment booking for small clinics.",
  "devCommands": ["make install", "make test", "make start"],
  "surfaces": [
    {
      "name": "app",
      "path": "src",
      "agent": "app-agent",
      "testCmd": "make test"
    }
  ],
  "domainVocabulary": {
    "hasSpecializedVocabulary": true,
    "entries": [
      { "term": "Slot", "definition": "A bookable time interval of one practitioner." }
    ]
  },
  "gitPolicyDirective": "4. **Git policy:** Work on feature branches; never push without review."
}
```

### Promotion table

One row per significant decision. `promote` names a stable destination and the exact text `init`
writes there. `exclude` gives the reason the decision stays local. Promote a choice with its reason;
the manifest and lockfile hold the resolved version.

```json
{
  "inception-promotion": "steepy-apex/v1",
  "run-id": "0f8e6b8a-3c1d-4e2f-9a7b-5c6d7e8f9a0b",
  "decisions": [
    {
      "id": "D1-runtime",
      "outcome": "promote",
      "destination": ".apex/project-architecture.md",
      "content": "- Runtime: <runtime>, chosen because <reason>. The manifest and lockfile hold the resolved version."
    },
    {
      "id": "D2-waiting-list",
      "outcome": "promote",
      "destination": ".apex/project-context.md",
      "content": "- Waiting list: seen in the prototype, not built. Context for later work."
    },
    {
      "id": "D3-rejected-queue",
      "outcome": "exclude",
      "reason": "A rejected alternative; its reasons stay in the local project record."
    }
  ]
}
```

### Init receipt

`prepare` writes it before the first hub write and binds it in the descriptor; `finalize` completes
it. It holds the accepted input digests, one outcome per decision, the previous and observed digest
of each destination, and the gate result. You never write it.

## Helper checks and your judgement

| Helpers check | You decide |
|---|---|
| closed schemas, exact run paths, run identity | whether the project is sound |
| approval ↔ approved project bytes | whether the user really approved it |
| checkpoint differences: changed, added, removed, branch/HEAD | what a difference means |
| every promoted text present, the gate you report | whether a rule is right and where it belongs |

A digest makes a change visible. It does not identify a person or prove that you followed these
instructions.

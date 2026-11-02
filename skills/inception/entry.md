# inception — Steps 0–1: classify, start or resume

### Step 0 — Classify the starting state

Run `classify` without `--maturity` first:

```bash
node <engine-root>/scripts/inception-state.mjs classify --repo-root .
```

Classification reads fixed paths only. It never lists directories and never picks a run by recency
or file name.

When the row is `maturity-decision-required`, read the stack signals with
`node <engine-root>/scripts/detect-stack.mjs .` and propose a maturity reading. It is only a
proposal:

- `suitable` → an idea, starting materials, or a prototype that is not yet a working application.
- `mature` → a working application already exists.

The user decides an intermediate case: a nearly complete prototype needs the user's explicit choice.
Then run `classify --maturity suitable` or `classify --maturity mature` with the user's answer.

Act on the `row` field:

| Row | What to do |
|---|---|
| `maturity-decision-required` | No hub and no run. Propose a maturity reading, let the user decide, then classify again with `--maturity`. |
| `start-new-run` | Go to Step 1 and start a new run. |
| `propose-init-discovery` | The application is mature. Propose the `init` skill, then the `discovery` skill. Start nothing. |
| `ordinary-workflow` | The hub exists and there is no run. Use the ordinary workflow, for example the `brainstorm` skill. Start nothing. |
| `resume-run` | Resume the active or blocked run in Step 1. |
| `resume-abandon` | An interrupted abandon left a prepared intent. Run `abandon --resume` to finish it; every other `inception-state.mjs` writer refuses until then. Start nothing. |
| `report-next-steps` | The run is complete and the hub does not exist yet. Report the next steps: the `init` skill, then the `discovery` skill. |
| `run-complete-ordinary-workflow` | Report "run complete, use the ordinary workflow". |
| `conflict-run-beside-hub` | Report the conflict: an unfinished run sits beside a hub, for example because `init` ran too early. There is no automatic resume; the user decides. |
| `invalid-state` | Preserve every file, explain the invalid state from the `error` field, and stop. |

### Step 1 — Start or resume the run

**Start:** declare actual `shell`, `network`, `browser`, `subagents`, `question-tool`, `headless`
capabilities. Ask once whether local commits are allowed or forbidden, unless already authorized;
without Git the helper records none. Remote operations retain their own exact scope.

Before approval the helper inventories the whole repository, so declare at start the dependency,
cache and generated directories that already exist, such as `node_modules`, `.venv` or a build
output, and those that work before approval will create, such as dependencies installed to try a
prototype. They cannot change until approval. Look at the repository's real directories; there is no preset list. Each entry is
`{"path", "kind", "reason"}` with kind `dependencies`, `cache` or `generated` and a literal path,
never a glob. Never exclude manifests, lockfiles, configuration or migrations. Ask the user to
confirm the list, then pass it as one strict JSON array on standard input with `--exclusions-stdin`
and a quoted heredoc; omit the option when nothing qualifies. `start` observes the repository once before writing anything: a symlink, hard
link or special file outside the exclusions refuses the start and names the path. Add that path
only when it is dependency, cache or generated material; otherwise stop and ask the user. These
exclusions hold until approval, when the contract's roots and exclusions replace them.

Then start. This executable illustration uses shell only and forbids commits; adapt it to the
confirmed policy:

<!-- example:start -->
```bash
node <engine-root>/scripts/inception-state.mjs start --repo-root . --harness codex --capabilities shell --git-commits forbidden
```

With installed dependencies, add the confirmed exclusions:

```bash
node <engine-root>/scripts/inception-state.mjs start --repo-root . --harness codex --capabilities shell --git-commits forbidden --exclusions-stdin <<'JSON'
[{"path":"node_modules","kind":"dependencies","reason":"Installed packages; package.json and the lockfile stay inventoried"}]
JSON
```

**Resume:** use `inspect`, `.apex/inception/run.json`, and only the exact refs it binds; no directory
listing, sibling/archived run discovery, or most-recent selection. The last note is not authority;
notes only explain state established by the descriptor and evidence. Run this before any new writer:

<!-- example:resume-check -->
```bash
node <engine-root>/scripts/inception-state.mjs resume-check --repo-root .
```

1. If the descriptor is an unsupported run format, every helper command refuses it, `abandon`
   included: stop, explain the unsupported run format, and leave its bytes untouched; nothing
   migrates, archives or deletes it.
2. If pending publication exists, use its exact reservation with `publish resume` and recheck. It
   publishes reserved bytes only. For an active unit, follow Persisted work units and recovery;
   do not dispatch another writer or treat absence of a child response as stopped-writer evidence.
3. Observe uncertain effects via their exact intent, correlation and real evidence (Step 8). Never
   repeat a concluded or uncertain effect. Reconcile only when proven; ambiguity blocks for a
   human decision. A similar resource or free text is insufficient.
4. Approval has three cases: **absent** means continue the persisted preapproval phase, never
   require a nonexistent approval or jump to bootstrap; **valid** means retain it without asking
   again; **divergent** means stop writers, explain the exact change, return explicitly to approval,
   then use a decision unit and targeted reapproval of the complete current project. A blocked
   run with a divergent approval still takes `transition --to active` and then
   `transition --to approval`: neither compares the working documents. Older approvals and a
   reserved completion verify their frozen copies. A hash alone does not prove a human confirmation. Git branch/HEAD/status drift also needs evidenced
   reconciliation; a reconciled content-identical commit alone does not create a new cycle.
5. Resolve only the named block via `block resolve`, recording the human statement and evidence.
   A proven reconciliation can clear its own block, never unrelated blocks. Only after zero
   residual blocks may `transition --to active` proceed; recheck before new work.
6. Continue by persisted phase: reconnaissance → Step 2, architecture → Step 3, research → Step 4,
   approval → Step 5, bootstrap → Step 7, verification → Step 10. On a new verification session,
   after resume-check and recovery, use `verification resume --cycle <exact-current-cycle>` once.
   Repeated read-only resume-check calls in that session do not invalidate anything.
7. If complete, use `verify-complete` and give Step 10's closing presentation only. A missing
   closing note never restarts verification/bootstrap or changes completion.

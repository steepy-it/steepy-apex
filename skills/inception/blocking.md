# inception — blocking and abandon

## Blocking and abandon

A recognized scaffold lease is not divergence: the `.steepy-project-scaffold.lock` directory or its
stale, retired or candidate residue at the repository root that holds only its canonical 0600
`owner.json` record, live or dead. Never ask a human about it; a lock-like path that fails
recognition remains divergence.

On unreadable determining material, scope change, uncertain effect or unexplained divergence:

1. Preserve all evidence and stop new work. Inspect the exact active unit and any pending
   reservation. Use Step 1 to settle only a correlated reserved publication; never bypass writer
   exclusion or invoke application work again.
2. Settle the active writer before the blocked transition. Finish/reconcile only demonstrably
   completed work with its full valid report and observed diff. For stopped unfinished work,
   retain BLOCKED/NEEDS_CONTEXT in its report, record the actual stopped-writer observation and
   use `unit close-incomplete` as described in `helper.md`. Never fabricate a successful report to release
   the writer. Closure records incomplete history, leaves uncertain effects, unaccepted application
   drift and independent blocks intact, and grants no replay permission.
3. If a child/capture is live or its stop is unverifiable, retain the active unit and report the
   waiting condition with its exact ID and needed stop evidence. Request/await writer settlement;
   do not claim that the helper recorded a blocked transition or a resume-note. A capture's
   persisted PID must be proven dead; a human stopped-writer statement cannot bypass that rule.
   Return to settlement when proof becomes available, without starting another writer.
4. Only after activeUnit is null and pending publication is settled, persist the blocked
   transition. Then write an exact next-action note with the bound evidence paths when allowed.
   Check both command responses; a refusal is never a recorded status/note. Resolve only the
   relevant observations and named blocks under Step 1 before any return to active.

This missing-material recipe begins a decision unit before reconnaissance (research uses the same
sequence with kind research). Write `project/recon-input.json` first:

<!-- example:blocking-unit -->
```json
{"kind":"decision","inputs":[],"outputs":[{"path":".apex/inception/project/recon-report.md","role":"report"}],"allowedPaths":[]}
```

<!-- example:blocking-begin -->
```bash
node <engine-root>/scripts/inception-state.mjs unit begin --repo-root . --id recon --input .apex/inception/project/recon-input.json
```

If a required input is missing/unreadable, stop the incomplete reconnaissance and record the reason
in recon-report.md using this unit's BLOCKED report delimiters. Unit finish cannot accept that
report, and transition to blocked while recon is active refuses. Once the coordinator has actually
stopped its own writer (or has observed the child's stop), write `project/recon-stopped.json`:

<!-- example:blocking-stopped -->
```json
{"unitId":"recon","writerStopped":true,"statement":"The coordinator stopped its incomplete reconnaissance because required material is unreadable."}
```

This sample is only appropriate to an actual observation, never a substitute for stop evidence.
Close the stopped unit incomplete, preserving any uncertain effects or unaccepted changes:

<!-- example:blocking-close -->
```bash
node <engine-root>/scripts/inception-state.mjs unit close-incomplete --repo-root . --id recon --reason=Required-material-unreadable --evidence .apex/inception/project/recon-stopped.json
```

Read the closure response and descriptor; require activeUnit null, not completed work. Only then:

<!-- example:blocking-transition -->
```bash
node <engine-root>/scripts/inception-state.mjs transition --repo-root . --to blocked --reason=Required-material-unreadable
```

<!-- example:blocking-note -->
```bash
node <engine-root>/scripts/inception-state.mjs resume-note --repo-root . --next=obtain-readable-required-material --need .apex/inception/project/recon-stopped.json
```

The note describes how to obtain the missing material, not authority to retry the unit. Preserve
its incomplete identity and exact closure evidence; a later authorized execution needs a new ID
and explicit previous-unit after uncertainty/drift/blocks are resolved. Nothing in this settlement
sequence repeats application work or attests success.

Only an explicit user abandon authorizes `abandon --reason=<text>`. First settle the active writer;
the helper archives intact, deleting nothing. An interrupted archive resumes via
`abandon --repo-root . --resume` using canonical intent and exact children, even after run.json has
moved. Never scan abandoned runs. A verified complete archive is not automatic restart permission:
start a distinct run only on an explicit user request. Never delete `.apex/inception/`.

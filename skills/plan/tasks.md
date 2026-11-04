# plan — Steps 2–4.5: map, bind, write, and self-review the tasks

### Step 2 — Map files and tasks

List the files each task creates/modifies (exact paths). A task is mis-cut if its implementer must **discover** what to change: when its requirements can be stated only as a goal ("make X work," "write the section on Y") and not as a sketch of a diff to exact paths, the discovery is missing and belongs to `plan` — split the task, or add a discovery task upfront whose deliverable is the missing facts. This is the other half of what a task already needs: not just the exact paths, but the expected change at each path. Decompose into tasks, each ending in an independently testable deliverable.

**Wide refactors — expand → migrate → contract.** A **wide refactor** — one mechanical change
whose blast radius breaks callers across the whole codebase — must not be forced into tasks
that cannot land green. Sequence it: **expand** (add the new form beside the old — nothing
breaks), **migrate** (move call sites in batches sized by blast radius; each batch is an
ordinary sequential task, suite green between batches), **contract** (delete the old form when
no caller remains). No dependency-graph machinery — batches are ordinary sequential plan
tasks. "Wide" is strict: if the change lands green in one task, it is not wide.

### Step 3 — Bind each task to the hub

The plan is the complete spec-to-brief bridge. Every task uses this self-contained format:

Start every task with the canonical boundary `## Task <positive integer> — <short title>`; task
integers are unique and increase in execution order. Under it use the exact labels below. The
canonical criterion form is `- **Success criteria:** SC1, SC2`; the parser rejects alternate field names such as `Spec criteria`.

- **Requirements and deliverables:** exact behavior to implement and the independently testable result.
- **Relevant global constraints:** every spec-wide rule that applies to this task, repeated here rather than assumed.
- **Surface:** `<surface>` from the routing table.
- **Specialist agent:** the registered `<surface>-agent` that owns implementation.
- **Exact paths:** every created or modified repository-relative path; paths must be safe and exact.
- **Test command:** the surface's exact command from `.apex/testing-and-checklist.md`.
- **Dependencies:** prior task numbers, or `none`, in executable order.
- **Complexity:** `mechanical | integration | design` — mechanical = 1-2 files with a complete
  spec; integration = multi-file or judgment; design = architecture, high-risk, or subtle.
- **Success criteria:** every mapped success-criterion ID from the source spec.

Include all exact requirements and deliverables needed to materialize the downstream task brief.
No requirement may live only in conversation. If copying a large upstream section would make the
task unwieldy, reference it by canonical path + heading and state exactly which requirement it
supplies. `implement` reads this line (`Complexity`) to pick the model tier and decide whether the task gets its
own reviewer (Step 3.4).

### Step 4 — Write the local working plan

**Manual drive:** on a fresh run, choose an absent `.apex/work/plans/YYYY-MM-DD-<topic>.md` path;
an existing target requires the exact resume capability before reading or overwriting it. On resume,
retain the accepted `output-plan` path, never recalculate its date. After any verdict/contract metadata and before the title, write:

```yaml
<!-- steepy-workflow: v1
phase: plan
status: DRAFT
next: implement
source: <exact-spec-path>
consumed-by: none
-->
```

Then link back to its source spec with a relative work-area link:

`> Source spec: [<topic>](../specs/<YYYY-MM-DD-topic>.md)`

**Autopilot:** write the plan exactly to the single path declared by the authoritative phase
manifest's `outputs` list. Do not recompute the date or filename. Use that actual path in the
correlated `DONE` marker, and derive the relative source-spec back-link from its location.

Create `.apex/work/plans/` if it does not exist. Do not register the plan in `.apex/_INDEX.md` and do not create a plans sub-index. Plans are local workflow artifacts, not stable hub documentation.

### Step 4.5 — Self-review the plan (free gate)

**Gear 2 and 3** — skip only at gear 1 (no plan is produced there).

Read the plan you just wrote with fresh eyes and fix any of these inline — no re-review needed, just fix and move on:
1. **Every mandatory field** — each task contains exact requirements/deliverables, relevant global constraints, surface, specialist agent, exact paths, test command, dependencies, complexity, and success-criterion IDs; no placeholder (`TBD`, `TODO`) remains.
2. **Binding consistency** — every surface is a known surface in `.apex/_INDEX.md`, every specialist is its registered specialist agent, and every exact test command matches `.apex/testing-and-checklist.md`.
3. **Dependency ordering** — dependencies name existing earlier tasks, ordering is executable, and each task ends in an independently testable deliverable.
4. **Complexity present** — validate allowed complexity: each `Complexity` value is exactly `mechanical | integration | design` and matches the task text (a multi-file task marked `mechanical` is a bug).
5. **Criteria coverage** — every requirement and success criterion in the spec maps to at least one task; list and close any gap.
6. **Safe repository-relative paths** — every path is exact, stays inside the repository, and is owned by the task's declared surface.
7. **Context independence** — a downstream agent can implement the task from the plan/task brief without chat history; large references use canonical path + heading and state the supplied requirement.
8. **Discovery-free tasks** — no task's requirements are stated only as a goal ("make X work," "write the section on Y"); each names exact paths and the expected change at each path, or is split / preceded by a discovery task whose deliverable is the missing facts.

All checks must pass before appending autopilot `DONE` or asking for human approval.

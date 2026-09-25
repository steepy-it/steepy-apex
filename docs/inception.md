# Inception: from starting materials to a verified bootstrap

The greenfield path for a brand-new application. `/steepy-apex:inception` takes a project from
whatever you already have — even nothing — to a bootstrap that actually runs, then hands off to
`init` for a governed `.apex` hub. It needs no hub to start.

Existing codebase already? Skip this page and run `init` directly, then `discovery`. See
[Installation](installation.md#first-run-and-troubleshooting).

## What it starts from

A repository can combine more than one starting material:

- **Empty** — nothing to preserve.
- **Starter** — generator or template output; its versions and conventions are inputs, not
  decisions.
- **Design system** — components, tokens, and usage rules to reuse.
- **UI/UX prototype** — screens, flows, and behaviors to keep or replace.

Each element is recorded as real (working code, real data, a real integration) or simulated (mock
data, stubbed calls, a placeholder screen). A prototype screen that looks finished is still a
simulation until its data path is real; inception never presents a simulation as an existing
component. A mature application — real product code with its own build and tests — is out of
scope: `inception` says so and points to `init` and `discovery` instead.

## Materials become one combined write-up

The materials above are never decided automatically: `inception` asks about them one question at a
time, then combines what it learns — constraints, real vs. simulated elements, goals, flows, and
what the harness itself can verify — into the project write-up the next phases build on.

## Phases

1. **Reconnaissance** — materials, what's real vs. simulated, constraints, goals, the main flows,
   and the harness's own capabilities (subagents, shell, network, browser).
2. **Architecture** — two or three alternatives with trade-offs, boundaries and data ownership,
   observability and error handling, the reused assets, and one **representative path**: the one
   flow that crosses the agreed boundaries end to end. Other flows stay recorded context.
3. **Research** — every foundational choice (runtime, framework, build tooling, core dependencies)
   cites its official source, an explicit version, and a verification date. No preset stack.
4. **Approval** — you approve the whole project once, before anything is built.
5. **Bootstrap** — the approved project is actually built and wired together.
6. **Verification** — every check runs from a clean state and the results are recorded.
7. **Init** — the run hands off to `init`, which builds the governed hub.

## Approval and the autonomy it grants

You approve the whole project once — architecture, stack with sources and versions, reuse, the
representative path, the verification plan, the deploy choice, and its limits — before bootstrap
starts. That approval binds the exact bytes you saw. Inside that scope, the run works on its own:
it does not stop to check in on every file it writes.

A **substantial** change — the database, a boundary, a flow, the design, the deploy choice, or a
foundational technology — is not inside that autonomy. It gets a targeted decision and a new
approval of the changed bytes before work continues.

## Proving the path works

The representative path chosen during architecture is the one inception actually builds and runs
end to end; other flows from your starting materials stay recorded context, not implemented
components. Verification runs install, build, test, start, and that representative path from a
clean state, and keeps every check's result distinct as **configured**, **executed**,
**succeeded**, **not-executed**, or **failed** — never blurring a check that ran with one that
didn't.

## Deploy is optional

A project can exclude deploy, with its reason recorded — that's enough to conclude the run. A
project that includes deploy is never reported as succeeded without evidence: an excluded deploy is
not a shortcut around verifying what the project does cover.

## Resuming a run

A run can be interrupted and picked back up. Resume reads only the exact files the run already
recorded — the descriptor, whatever it references, and the paths named in the last resume note —
never by browsing the run's own local directory. An approval that no longer matches its approved
bytes means something changed after you approved it: that reopens a targeted decision and a new
approval before bootstrap continues.

## Handing off to init

`init` reuses everything the run already confirmed. It reconciles the recorded decisions against
the actual code, asks only for data that's missing, a new decision, or a real conflict, and never
re-asks about something you already approved. Every significant decision from the run either lands
in a stable hub document with its reason, or stays out with a recorded reason — nothing you didn't
build appears in the hub as an existing component, and no deferred flow starts an implicit backlog.
Each surface gets a filled standard — its scope, conventions, and traps — and every project document
`init` creates is filled section by section: a section nothing was decided for says so, instead of
keeping template text. The finished hub works from your versioned files alone, without the run's
local, gitignored records.

## What this is not

`inception` is not a scaffolding preset: it proposes no default stack and ships no fixed document
count — a small project gets a small write-up, a larger one gets more. It doesn't guarantee a
deploy, and it doesn't turn a prototype's other flows into a backlog to build next. Once the hub
exists, ordinary work follows [the ceremony model](workflow.md).

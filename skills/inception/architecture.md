# Architecture, research, and approval

Load this when the descriptor phase is `architecture`, `research`, or `approval`. Goal: one
approved project that says what will be built, with what, and why.

Write the project in `.apex/inception/<run-id>/` with the structure of
`<engine-root>/templates/inception-project.md`. Read that template; do not copy it into the hub. Use
one document or several; the approval lists each one.

## Architecture

- Propose two or three alternatives with their trade-offs and a recommendation. Record why each one
  was accepted or rejected.
- Define boundaries and responsibilities, data and its owner, contracts between parts, and the
  patterns to follow.
- Define observability (logs, metrics, traces, health checks) and error handling (what fails, how it
  surfaces, how it recovers).
- Choose the representative path: one flow that crosses the agreed boundaries end to end. Other flows
  stay future context.
- List the reused assets and the behaviors to preserve.
- Map the parts to surfaces: name, path, specialist agent, test command. `init` needs them later.
- Choose deploy: included, with where it runs and how it is verified, or excluded, with the reason.

## Research

For each foundational choice — runtime, framework, build tooling, generators, core dependencies:

- consult the official source: documentation, release notes, support policy;
- record the official source, the explicit version, the verification date, the support status, and
  compatibility with the rest of the combination.

Propose no preset stack. Prefer supported versions that the whole combination accepts. If you cannot
reach an official source, say so; never present a remembered version as verified.

An experiment before approval (a spike to check compatibility) runs isolated, in a temporary
directory outside the repository, and the project records it as an experiment with its result. It
never becomes the bootstrap.

State the limits explicitly: what the project does not cover and what is still unknown.

## Approval

1. Set phase `approval`.
2. Present the whole project: architecture, stack with versions and sources, reuse, representative
   path, verification plan, deploy choice, and limits. Name each document.
3. Ask for one explicit approval of the whole project. A requested change edits the documents; then
   present what changed.
4. On explicit approval, write the approval record with the digests of the exact approved bytes
   (`protocol.md` → "Approval record"). In one update, bind it and set phase `bootstrap`.

The approval sets the scope. After approval, a change to database, boundaries, flows, design, deploy,
or a foundational technology is substantial: ask for a targeted decision, update the documents, and
record a new approval at a new path before you continue.

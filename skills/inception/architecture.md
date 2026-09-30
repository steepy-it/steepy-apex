# Architecture, research, and approval

Load this when the descriptor phase is `architecture`, `research`, or `approval`. Goal: one
approved project that says what will be built, with what, and why.

Write the project in `.apex/inception/<run-id>/` with the structure of
`<engine-root>/templates/inception-project.md`. Read that template; do not copy it into the hub. Use
one document or several; the approval lists each one.

## Architecture

- Decide the architecture with the user, category by category, before you write the project
  documents. Use the candidate research summaries for alternatives and versions. Read a
  `research/<topic>.md` file only for a named missing fact.
- The decision categories are stack-neutral. Take each one only when it applies, in this order:
  1. System shape — deployable units, boundaries, responsibilities.
  2. Contracts between parts — interface style, schema source, client generation.
  3. Data — ownership, persistence, migrations, sync and offline.
  4. Identity and access — authentication, authorization, sessions.
  5. Internal architecture of each part — client: state, navigation, UI kit or design system,
     folder layout; server: layers, communication between modules, transactions.
  6. Repository and tooling — workspace layout, package manager, build tooling.
  7. Testing strategy — levels, tools, what the representative path proves.
  8. Hosting and deploy topology — where each part runs, environments.
  9. Observability and error handling — logs, metrics, traces, health checks; what fails, how it
     surfaces, how it recovers.
- Decide each category one of three ways:
  - a real fork → one question with two or three alternatives with their trade-offs and a
    recommendation, plus the versions from the research summaries;
  - only one reasonable answer → it joins one grouped confirmation of defaults, each with its
    reason; the user corrects only the rows that are wrong;
  - does not apply → skip it, and write the reason in the project.
- Ask in dependency order: system shape before contracts, and contracts before the internal
  architecture of each part. Never batch dependent questions.
- Write the project documents after the dialogue, not before. Record how each decision was made:
  asked, grouped default, or not applicable. Record why each one was accepted or rejected.
- The documents then define boundaries and responsibilities, data and its owner, contracts between parts, and the
  patterns to follow.
- Define observability (logs, metrics, traces, health checks) and error handling (what fails, how it
  surfaces, how it recovers).
- Choose the representative path: one flow that crosses the agreed boundaries end to end. Other flows
  stay future context.
- List the reused assets and the behaviors to preserve.
- Map the parts to surfaces: name, path, specialist agent, test command. `init` needs them later.
- Choose deploy: included, with where it runs and how it is verified, or excluded, with the reason.

## Research

After the dialogue, pin and verify the chosen combination.

For each foundational choice — runtime, framework, build tooling, generators, core dependencies:

- consult the official source: documentation, release notes, support policy;
- record the official source, the explicit version, the verification date, the support status, and
  compatibility with the rest of the combination.

Propose no preset stack. Prefer supported versions that the whole combination accepts. If you cannot
reach an official source, say so; never present a remembered version as verified.

An experiment before approval (a spike to check compatibility) runs isolated, in a temporary
directory outside the repository, and the project records it as an experiment with its result. It
never becomes the bootstrap.

Pinning runs in a research child (`SKILL.md` → "Child agents"). Give it the exact project document
paths and the output path `research/version-review.md`. It writes a `## Version review` section
there with one table per layer and exactly these six columns, in order:

1. component;
2. chosen version;
3. latest stable version;
4. support status or end of life;
5. reason when the choice is not the latest or departs from the version policy;
6. source and date.

Read only that section; it is the named fact the user reviews. Present one table per layer. The user
confirms the table or corrects rows. A real version fork (for example a stable SDK against a beta)
stays a single question. Record the confirmed tables in the project's research section.

State the limits explicitly: what the project does not cover and what is still unknown.

## Approval

1. Set phase `approval`.
2. Present the whole project: architecture, stack with versions and sources, reuse, representative
   path, verification plan, deploy choice, and limits. Name each document. List the grouped
   defaults and every choice you made on your own.
3. No foundational choice reaches the approval unless it was asked in the dialogue or confirmed as a
   grouped default. If the documents contain one that was not, ask it first. Ask for one explicit approval of the whole project. A requested change edits the documents; then
   present what changed.
4. On explicit approval, write the approval record with the digests of the exact approved bytes
   (`protocol.md` → "Approval record"). In one update, bind it and set phase `bootstrap`.
5. Pause (`SKILL.md` → "Session boundaries").

The approval sets the scope. After approval, a change to database, boundaries, flows, design, deploy,
or a foundational technology is substantial: ask for a targeted decision, update the documents, and
record a new approval at a new path before you continue.

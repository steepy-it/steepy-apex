# Reconnaissance

Load this when the descriptor phase is `reconnaissance`. Goal: know what the run starts from and
what it must respect, before any architecture.

## Starting materials

Identify every material. A repository can hold more than one; combine them:

- empty repository → nothing to preserve;
- starter (generator output, template) → its versions and conventions are inputs, not decisions;
- design system → components, tokens, and usage rules to reuse;
- UI/UX prototype → screens, flows, and behaviors to keep or replace.

A mature application (real product code with its own build and tests) is not inception scope: say
so and recommend `init`, then `discovery`. Never pull it into scope automatically.

## Facts and simulations

For each element, record whether it is real or simulated:

- real → working code, real data, a real integration;
- simulated → mock data, stubbed calls, hard-coded screens, placeholder copy.

A prototype screen that looks finished is still a simulation until its data path is real. Never
present a simulation as an existing component.

## Read what decides

Open every determining input yourself: files, images, exported designs, links. If one cannot be read
(a binary without text, a broken export, denied access), ask the user for accessible content: an
export, a screenshot, or a description. Never state an analysis of an input you did not read.

## Stack and skills

For each layer the project will have (for example client, server, data, infrastructure), ask what
the user knows, prefers, or wants to avoid. Record the answers as constraints.

Then ask the version policy as one question with numbered options and a recommendation:

1. latest stable versions that the whole combination supports;
2. conservative: LTS or N-1;
3. per layer.

Record the choice as a constraint.

## What to record

- quality: what already works, what is fragile, known defects;
- constraints: technical, product, legal, hosting, budget, deadlines, stack preferences per layer,
  and the version policy;
- goals, the main flows, and the flow that best represents the product;
- behaviors that must keep working;
- harness capabilities: subagents, shell, network, browser, headless mode → what you can verify
  yourself and what the user must verify;
- Git policy: whether Git exists, the branch, whether you may commit, and the policy text `init`
  records as `4. **Git policy:** <text>`.
  Before you propose a remote owner or repository name, read the remote host's authenticated
  identity. Propose only owners that identity can reach.

## Questions

Ask in dependency order: materials → real vs simulated → goals and flows → constraints → stack and
skills → preserved behaviors → harness and Git. An answer can change the next question, so never
batch dependent questions.

## Candidate research

Once the constraints and the stack preferences are recorded, write them to
`.apex/inception/<run-id>/reconnaissance.md` first.

Then dispatch candidate research children, one per layer or topic, one at a time, in the background
(see `SKILL.md` → "Child agents"). Each child gets that exact path as input and writes
`research/<topic>.md`: candidate options, official sources, the latest stable versions, support
status, and compatibility. Its summary of at most 15 lines carries the alternatives and versions
that the architecture dialogue uses.

Continue the remaining questions meanwhile. Set phase `architecture` only after every candidate
research child has returned.

Complete the findings in `.apex/inception/<run-id>/reconnaissance.md`, then set phase `architecture`
with `update`.

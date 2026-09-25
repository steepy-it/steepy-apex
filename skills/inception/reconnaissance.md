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

## What to record

- quality: what already works, what is fragile, known defects;
- constraints: technical, product, legal, hosting, budget, deadlines;
- goals, the main flows, and the flow that best represents the product;
- behaviors that must keep working;
- harness capabilities: subagents, shell, network, browser, headless mode → what you can verify
  yourself and what the user must verify;
- Git policy: whether Git exists, the branch, whether you may commit, and the policy text `init`
  records as `4. **Git policy:** <text>`.

## Questions

Ask in dependency order: materials → real vs simulated → goals and flows → constraints → preserved
behaviors → harness and Git. An answer can change the next question, so never batch dependent
questions.

Write the findings to `.apex/inception/<run-id>/reconnaissance.md`, then set phase `architecture`
with `update`.

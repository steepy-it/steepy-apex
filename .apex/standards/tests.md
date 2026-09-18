# tests — Technical Standard

> Owning surface: `tests`. Read this before editing `tests`.

## Scope
- Owns: the `node --test` suites under `tests/` and fixtures under `tests/fixtures/`; asserts
  engine, scaffold, and workflow behavior, plus **doc-content-lock** suites that read and
  regex-assert the markdown/JSON in `skills/`, `templates/`, and root docs (README, RELEASE,
  `package.json`, plugin manifests).
- Does NOT own: the code under test (→ `scripts`) or the templates/skills it exercises.
- Exemplar: `tests/validate-hub.test.mjs`

## Release documentation ownership

[RELEASE.md](../../RELEASE.md) owns the operational publication checklist, manual smoke-test
procedure, and version recovery. [Release evidence](../../docs/release-evidence.md) owns
the optional release audit schema. Content checks read the owning document and keep
the checklist's reference links explicit. Historical observations do not certify the current release.

## Native evidence boundary

Hermetic fake-harness cases may prove parser, redaction, identity, and false-PASS rejection behavior. They cannot prove a loaded plugin, a skill invocation, generated bootstrap use, or native specialist behavior. Structural locks must keep the nine-skill, five-harness inventory current and keep Pi/DSH out of invented Steepy headless support; release evidence records those capabilities only after the reproducible native protocol.

## Conventions
- `node --test` with the built-in runner; no third-party framework.
- CI validates the supported runtime floor on Node 24; older runtimes are
  outside the support contract. `package.json`, user-facing docs, and this matrix move together.
- At least one suite per engine script (the floor); fixtures under `tests/fixtures`. Extra suites
  exist for cross-script integration (`e2e-smoke`), the live-hub dogfood check (`dogfood-hub`),
  and doc/config content-locks (`workflow-skills`, `release-metadata`, `git-policy`,
  `discovery-skill`).
- Release-gate coverage is split deliberately: `validate-release-evidence` exercises strict
  synthetic records, exact shipped-input identity and evidence-only exclusions, freshness,
  capabilities, digests, and incomplete-bump refusal; `release-workflow`, `git-policy`,
  `release-metadata`, and `npm-pack` lock the reusable workflow, successful publication dependency,
  least privileges, verified full-SHA action pins, truthful docs, and packaged validator. Synthetic
  schema acceptance is not evidence that a provider ran. Missing audit evidence fails only the
  optional audit command; release requires tests, hub coherence, and product validation.
- The deterministic-controller floor is explicit: `workflow-state` covers the shared event kernel
  and `loop-engineer` covers the terminal Gear-4 controller under the one-suite-per-script rule.
  Packaging and public/stable doc locks live in `npm-pack`, `release-metadata`, and `dogfood-hub`.
- Assert behavior (exit codes, file contents, violations), not internals.
- Temp dirs: `mkdtempSync(join(tmpdir(), 'steepy-<suffix>-'))` with a self-describing,
  greppable suffix (`steepy-e2e-`, `steepy-repair-`, …). Cleanup via `rmSync` in a
  `finally` is the norm for new suites (`bump-version`, `push-version-guard`,
  `extract-changelog`, release-metadata's npm-pack test); earlier suites (`e2e-smoke`,
  `init`, `new-surface`, `validate-hub`, …) don't clean up and leave the OS/CI to reap
  the temp dirs.
- Two exercise styles: CLIs and hooks run as real subprocesses
  (`spawnSync(process.execPath, …)`, asserting `status`/`stdout`/`stderr`); library
  functions are `import`ed in-process. In-process output capture monkey-patches
  `console.*`/`process.stderr.write` and restores the original in a `finally`.
- Final cross-surface acceptance is a **vertical TDD**: package payload uses one
  `npm pack --dry-run --json` invocation with a temporary cache and proves no tarball appears in
  the repository; the fake-executable canary exercises only the three supported descriptors and
  proves that tool-trace nonces, incomplete or malformed final responses, extra fields, and wrong
  nonce order all fail verification, while Pi/DeepSeek are asserted as `NOT RUN` /
  `runner-unavailable`; dogfood proves public-CLI
  full-tree idempotence (empty second preview, zero apply, unchanged bytes/mode/mtime). Doc locks
  keep optional audit claims honest — no five-harness PASS claim while Pi/DSH are unavailable.
  The release gate requires automated tests, hub coherence, and product checks only.
- Cross-script portable composition covers contracts that isolated suites can miss: an empty Project
  description must survive public plan/apply and validation; a root-only Project must parse and gain
  its first active-v1 surface through the public workflow; active-v1 `new-surface` must expose the
  planner's conflict choices, update root/routing/standard/triad coherently, and repair to an exact
  byte/mode/mtime no-op; generated-adapter CRLF drift must be the same `customized` condition in the
  linter and planner while exact LF remains green. The same composed suite locks managed-root
  agreement: adjacent prefix/suffix placement and extra active Claude imports must conflict in both
  systems, preserve user bytes/EOLs through repair, validate green, and rerun as an exact no-op;
  the offered unmarked-import `adopt` path must likewise emit a real operation, canonicalize the
  single active target without changing surrounding bytes/EOLs, and prove the same exact no-op.
  It also proves any present unresolved managed Project identity blocks `new-surface` with zero
  writes; bounded recursive adapter/bootstrap provenance blocks planner preview; and directories,
  non-files, or non-directory ancestors at every canonical family are stable read-only errors.
  Active-v1 standard-identity variants and live-lock standard/routing-only repairs preserve the full
  physical snapshot, while accepted Project commands compose through validator/no-op and empty or
  backtick-bearing commands reject before planning or writes.
  Composed physical-identity coverage starts from a public-v1 ordinary-file fixture, then proves
  descendant generated target symlinks and symlinked ancestors below project mounts conflict in
  the planner and fail validation. Relative/absolute external root and provider mounts compose
  scoped surface paths, repair at the physical target with preserved links/modes, validator-green
  output, and a byte/mode/mtime no-op rerun. Broken, cyclic, wrong-type, and work-target mounts
  stay controlled errors; retargeting during apply fails before destination writes.
- Content-byte-locks assert canonical model-facing prose and generated bytes; they do not claim a deterministic manual parser or validator.
  Manual handoff tests lock model-only enforcement; autopilot manifest tests remain the stronger deterministic contract.
  Public scaffold coverage records unsupported-format refusal, explicit customization resolution, hub/work preservation, and an exact second no-op.
  Content locks cover the common inline grammar, phase role maps, fail-closed errors, lifecycle/provenance transitions, native-plus-canonical handoffs, and every most-recent fallback prohibition.
  Dogfood covers every promoted glossary/conventions/surface-standard term and rule. Its content locks include skills, templates, scripts, and tests rules, including the prohibition on stable Markdown links to concrete `.apex/work/**` artifacts.
- The hostile deterministic runtime matrix crashes and resumes at every external return, every
  immutable artifact transition, and every successful event append. It also covers reservation
  gaps, corrupt/truncated/substituted event state, stale projections, branch/HEAD/dirty-tree drift,
  commit-intent and discard reconciliation, forged ownership, blast-radius escape, read-only review,
  all four clean terminal outcomes, consumed-goal validation, and explicit runnerless refusal.
- Gear-4 integration coverage includes retained-green state after a discarded review-fix; terminal
  report/diff deletion, substitution, and byte drift plus changed-HEAD, changed-branch, and dirty-tree
  rejection for all four outcomes; real-Git intra-command commit/discard crashes across tracked,
  untracked, and mixed work with recovery in a new process; repeated permanently abandoned HALTED
  replay including consumed-goal prefixes; and unreliable verifier refusal with zero repository-local mutation.
- Fake-runner and injected-Git evidence closes only the scoped runtime slice of APEX-P2-10. It is
  deterministic behavioral evidence, not a provider acceptance result. The five-provider LIVE
  matrix remains APEX-P1-04 and stays open while Pi and DeepSeek are `runner-unavailable`.

## Anti-patterns
- Don't assert on internal/private structure — an internal refactor with unchanged behavior
  would break such a test; assert observable behavior (exit codes, file contents, emitted
  violations) instead.
- Never write into the repo from a test — scaffold into a temp dir, so suites stay hermetic.
- Never resolve real user session stores or harness configuration in ordinary tests.
  Every cost-report CLI invocation must supply a temporary `--session-store-root`
  or `--no-session-store`; repository attribution occurs after files are read and
  is not an access boundary. Every fake OpenCode conductor run must inject isolated
  configuration environment/home inputs, including subprocess fixtures and both
  `HOME` and `XDG_CONFIG_HOME`. Isolation regression tests must instrument attempted
  filesystem access before the read and assert zero forbidden attempts, even when
  the reader catches errors; absence of sentinel text in output is insufficient.
- No dependence on test order or on shared mutable fixture state.
- A new engine script means a new suite — one-suite-per-script is the **floor** (extra
  integration, dogfood, and doc-content-lock suites are expected), so the narrow-test guidance
  stays true.
- Assertion helpers are copy-pasted across suites (`assertNoBareWorkflowInvocations` in
  three suites, `sectionBetween` byte-identical in two, the frontmatter-extraction regex in
  three) — don't add a fourth copy; extract a shared helper or consciously flag the new
  copy in review. The same tension applies to the `MODEL_SECTION_WITH_REVIEW` /
  `MODEL_SECTION_WITHOUT_REVIEW` canonical strings, which byte-lock the five chain SKILL.mds
  from one test file.
- Autopilot resume coverage composes the real conductor with a synthetic three-task child:
  completed tasks 1–2, task 3 issues and halt, explicit ledger/index capabilities on a new attempt,
  then simulated correction and approval. It verifies fresh absence, resumed availability and
  immutable earlier manifest/log bytes; it does not certify native skill/reviewer behavior.
- Autopilot coverage includes comparative reachability and an irrelevant-absence fixture for
  manifests. Each plan/implement/review footprint comparison uses its own matching baseline eager
  inventory and baseline generated prompt, never a shared union baseline or combined arithmetic that
  hides a regression. Generated prompt bytes shrink independently for every phase. Required-input
  bytes are compared independently: plan does not grow when its approved inventory equals the baseline,
  implement/review shrink, and the representative three-phase workflow total strictly shrinks. Coverage also includes
  descriptor vectors for concrete apply/degrade outcomes and resource usage provenance with no-stop
  assertions. Content locks must protect stable ownership terms and prohibit stable docs from linking
  into `.apex/work/**`.

## Testing
Narrowest validation that can falsify a change here:

```sh
node --test tests/<the-suite-you-changed>.test.mjs
```

# steepy-apex release checklist

Operational checklist for Claude Code community/public distribution, GitHub releases,
and distribution to OpenAI, OpenCode, Pi, and DeepSeek Harness.
Owner: `steepy-it`; repository: `steepy-it/steepy-apex`; plugin: `steepy-apex`.
Community marketplace install path after approval: `steepy-apex@claude-community`.

## Release requirements

1. Validate the final version and package with the commands below.
2. Run the smoke test in a throwaway repository.
3. Commit the version bump and changelog using `vX.Y.Z - <short release summary>`; push or merge to `main` to trigger the release workflow.

Detailed references:

- [Public launch checklist](docs/publication-readiness.md).

- [Optional audit evidence schema, capabilities and provenance](docs/release-evidence.md).

## Installation

See the [installation guide](docs/installation.md) for all five harnesses, local and
GitHub installation, first-run commands, requirements, and troubleshooting.
The [README quick start](README.md#quick-start) shows the shortest path for each harness.

## Preflight

Run from the repository root after the version bump:

```sh
npm test
node scripts/validate-hub.mjs .
node scripts/bump-version.mjs --check
npm pack --dry-run --json
node scripts/validate-release-evidence.mjs --product-only
claude plugin validate .
```

Inside Claude Code, `/plugin validate .` provides plugin validation.
Optional audit verification: `node scripts/validate-release-evidence.mjs` reads `docs/native-test-evidence.json` and referenced artifacts
in `docs/native-test-evidence.md`. It checks recorded evidence; it does not run providers
or generate missing evidence. audit evidence is not required by the release workflow.

## Smoke test

Use a fresh checkout and install the local marketplace:

```text
/plugin marketplace add /path/to/steepy-apex
/plugin install steepy-apex@steepy-apex
/reload-plugins
```

For direct development loading, use `claude --plugin-dir .` and `/reload-plugins`.
Confirm all ten commands:

```text
/steepy-apex:inception
/steepy-apex:init
/steepy-apex:new-surface
/steepy-apex:check
/steepy-apex:brainstorm
/steepy-apex:plan
/steepy-apex:implement
/steepy-apex:review
/steepy-apex:discovery
/steepy-apex:loop-engineer
```

In an empty temporary repository with a working test command:

1. For a brand-new application with no code yet, run `/steepy-apex:inception` first;
   it works before any hub exists and hands off to `init` once its bootstrap is
   approved and verified. For an existing codebase, skip straight to step 2.
2. Run `/steepy-apex:init`, complete the interview, then `/steepy-apex:check`.
3. Confirm `.apex/_INDEX.md` and the chosen root instructions exist.
4. Confirm `.apex/work/.gitignore`, `.apex/work/specs/`, and `.apex/work/plans/`
   remain local gitignored workflow state. Stable specs/plans indexes are not generated.
5. Confirm the hub check passes and the Stop hook stays quiet on a coherent hub.

After publication, repeat using `/plugin marketplace add steepy-it/steepy-apex`,
then reinstall/reload. Repeat the smoke test in each supported harness.

## Versioning & release

New release tags and releases are normally created by the workflow after validation.
Existing tags and draft releases require explicit reconciliation before publication.

**Initial public launch: 1.0.0.** The owner selected this version on 2026-09-16.
All final preparation edits stay at `1.0.0`; update the same changelog section rather
than requesting another bump. `node scripts/bump-version.mjs 1.0.0` is an idempotent
version check/update; do not use `patch`, `minor`, or `major` for launch preparation.
Keep the launch changes together before merging: the existing PR gate still requires
an increment for user-facing changes and has no blanket same-version code exemption.

Before public launch, verify that `main`, `v1.0.0`, and the release identify the same
approved commit with green CI. The workflow does not move existing tags, replace release
notes, or publish existing drafts. When reconciling a draft, explicitly set its `tag_name`
to `v1.0.0` and verify it again after any tag move; `target_commitish` alone does not
establish that association. Do not publish the npm version until the payload is final:
later package changes need a new npm version.

**Semver policy.** PATCH = bugfix, MINOR = new feature, MAJOR = breaking change.
The shared `scripts/version-policy.mjs` implements the narrower canonical X.Y.Z policy:
three non-negative safe-integer components, no leading zeroes, prerelease or build suffixes.
Precedence is numeric, so `1.2.10` exceeds `1.2.9`; required bumps reject equality and
downgrades. A caller's `no-release` exemption waives the increment, never version validity
or downgrade protection.

**Bump at PR time.** The `review` skill proposes the bump type from the change (fix →
patch, feature → minor, breaking → major), the user confirms, then `node
scripts/bump-version.mjs <type>` updates `package.json`, `.claude-plugin/plugin.json`,
and `.codex-plugin/plugin.json` in three-way lockstep at completion, using one shared target.
A `## vX.Y.Z (YYYY-MM-DD)` section is added to `CHANGELOG.md`. Bump and
changelog land as one commit on the branch before the PR opens.

**Interrupted bumps.** The writer provides recoverable per-file atomicity, not a
multi-file atomic transaction. It holds the existing repository scaffold lease for cooperating
writers, validates all initial versions, and durably records exact before/after bytes and modes
in `.steepy-version-transaction.json` before staging the complete target set. Each manifest
is then published through an ordinary atomic rename and its directory is synced. Unrelated
formatting bytes and modes are preserved; unexpected bytes or mode edits block without overwrite.
Symlinked inner parents and non-ordinary or multi-link files are refused. This is not an
adversarial filesystem guarantee and requires working file/directory fsync and rename support.

While the journal exists, rerun the original command or its explicit recorded version to
finish the same target. Do not delete/edit the journal, reset the checkout, or select a different
bump kind to recover. Owned partial stages are accepted only as exact target-byte prefixes;
unexpected stage edits are retained and block. An explicit already-completed target is a
manifest-write-free no-op; a new patch/minor/major command after completion requests a new bump.
Run `node scripts/bump-version.mjs --check` before release validation: any remaining transaction
is incomplete even when all three version fields already match. A process crash before the
journal's atomic publication can leave an unreferenced temporary journal, but cannot publish
any manifest; it is not mistaken for a pending target or automatically removed as user data.

**PR gate.** The `Version gate` workflow (`.github/workflows/version-gate.yml`) uses the
shared numeric `scripts/version-policy.mjs` comparison. It fails invalid, equal, or
downgraded PR versions. A PR with no user-facing change (docs-only, CI-only) can carry the
`no-release` label, which skips only the increment requirement; canonical parsing and
downgrade rejection still apply.

**Tag at merge.** The `Release` workflow (`.github/workflows/release.yml`) runs on every
push to main, but can publish only after tests, hub coherence, version and package
validation succeed. If tag `vX.Y.Z` for the current version doesn't exist yet, it creates and pushes
it. It then independently creates the GitHub Release, with the body pulled from the
matching `CHANGELOG.md` section via `scripts/extract-changelog.mjs` (falls back to a stock
body if extraction fails). Both publication steps are idempotent.

**Direct pushes to main.** A repo-local PreToolUse hook (`.claude/settings.json` →
`scripts/push-version-guard.mjs`) blocks a `git push` on main for a known invalid version,
an unchanged version, or a numeric downgrade relative to `origin/main`, and asks whether to
bump patch/minor/major (default patch). Unrelated commands, other checked-out branches and
unavailable read/parse/Git context remain fail-open; known malformed version values do not.

**Tag naming.** `vX.Y.Z` (e.g. `v0.2.0`), matching the current plugin version.

**Two PRs in flight.** If two PRs both bump to the same version, the `Version gate`
passes on both until the first one merges; the second then fails the gate against the
new main version and must re-bump before it can merge.

## Community marketplace submission

Before submitting, run:

```bash
npm test
claude plugin validate .
```

Submit through one of the documented Claude plugin forms:

- `https://claude.ai/admin-settings/directory/submissions/plugins/new`
- `https://platform.claude.com/plugins/submit`

Approved community plugins are pinned to a commit SHA in `anthropics/claude-plugins-community`; public catalog sync can lag review approval.

## Public distribution checklist

Channel guidance checked on 2026-09-16. Recheck the linked provider instructions before
submission. The GitHub workflow creates tags and GitHub Releases only: it does not publish
to npm or submit to any plugin directory. Store approval is separate from technical validation.

### Shared launch preparation

- [x] Choose the public release version: `1.0.0`; retain it throughout final launch preparation.
- [ ] Finish the documentation before testing the final payload.
- [ ] Reconcile the `v1.0.0` tag/release with the final approved
  launch commit and notes through an explicit release operation; do not reuse an npm version.
- [ ] Review Git history and tracked release contents before changing repository visibility.
- [ ] Publish the repository when ready, then verify its README, license, assets, and install URLs
  without repository credentials. Enable private vulnerability reporting and verify the support path.
- [ ] Configure main-branch protection/rulesets with the actual CI and version-gate check names.
- [ ] Run preflight above on the exact candidate. The supported CI runtime is Node 24 on Linux;
  native installation and macOS/Windows claims need their own applicable checks.
- [x] Complete manual verification — the maintainer confirmed on 2026-09-16 that all
  manual tests performed after the earlier evidence collection passed.
  The optional audit schema is not required for publication.
- [ ] Prepare listing copy, logo, support contact, starter prompts, and a short demo. Use
  [community submission copy](https://github.com/steepy-it/steepy-apex/blob/main/COMMUNITY_SUBMISSION.md)
  as the starting point. Keep advanced runner limitations visible.
- [ ] Merge the reviewed candidate, wait for Release validation/publication, and confirm the tag
  resolves to the intended commit. Existing tags are not moved by the workflow.
- [ ] Repeat the documented public installation and replace future/placeholder installation copy
  only after that channel is actually available.

### Claude Code

1. Validate with `claude plugin validate .` and run the local marketplace smoke test above.
2. After the repository is public, test its own marketplace install from GitHub. This distribution
   path is independent of review by Anthropic.
3. Submit the repository and listing through one of the forms above; record submission status.
4. After approval and catalog sync, test `steepy-apex@claude-community` before advertising it.
   The official curated marketplace is a separate channel; submission does not guarantee inclusion.

Source: [Claude marketplace discovery and submission](https://code.claude.com/docs/en/discover-plugins).

### OpenAI / Codex

The current OpenAI documentation describes a shared public plugin directory for ChatGPT and
Codex. A local/GitHub marketplace install is a development or workspace distribution path,
not public-directory approval. Steepy requires repository files, shell execution, Git, and
Node 24; do not advertise ordinary Chat compatibility without verifying those capabilities.

1. Verify the publisher identity and the submitter's **Apps Management: Write** permission.
2. Prepare public website, support, privacy-policy and terms URLs, logo, descriptions, release
   notes, country availability, starter prompts, five positive and three negative test cases.
3. Choose **Skills only** in the submission portal. Package all required skills, scripts,
   templates, adapters, and assets; do not assume the portal executes npm installation.
4. The documented Claude archive import can convert `.claude-plugin/plugin.json`; alternatively
   use the supported OpenAI package layout. Inspect the imported manifest and test every referenced
   helper path in a clean environment. Recheck hook loading, trust, and host compatibility.
5. Resolve scan findings, test the imported candidate, submit for review, then complete the portal's
   publication step after approval. Re-test the installed directory version.

Sources: [OpenAI submission](https://developers.openai.com/plugins/deploy/submission),
[Claude plugin import](https://developers.openai.com/plugins/guides/submit-claude-plugin),
[local and public plugin distribution](https://learn.chatgpt.com/docs/build-plugins).

### npm, OpenCode, and Pi

1. Verify npm package-name availability and publisher ownership; configure the account's publishing
   authentication. Choose the final version before publication, which cannot be overwritten.
2. Review `npm pack --dry-run --json`, then test an actual tarball installed outside this checkout.
   Check that every relative skill/helper reference is present. Add `pi-package` to the package
   keywords before publishing if Pi gallery discovery is desired; optionally add a demo image/video.
3. Publish the reviewed package with `npm publish --access public` using the authorized publisher.
   The existing GitHub workflow does not perform this step.
4. For OpenCode, test the published package in `opencode.json`'s `plugin` array, including skill
   discovery and scaffold/check. For Pi, test `pi install npm:steepy-apex` and the documented
   new/fork/resume/reload bootstrap transitions.
5. Verify the npm listing and Pi gallery entry, then update README instructions with the real
   published version. A Git-based Pi install remains an alternative to npm.

Sources: [OpenCode npm plugins](https://opencode.ai/docs/plugins/),
[Pi packages and gallery metadata](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md).

### DeepSeek Harness

Use the native Git or package installation route in the [installation guide](docs/installation.md#deepseek-harness) and verify skill discovery, initialization,
and the hub check in the native host. A separate public
store submission route has not been established by this release audit. Do not promise a
store listing or deterministic Gear-3/4 support for this adapter.

## Rollback

If a release has an install or runtime problem:

1. Stop announcing the affected tag.
2. Open a GitHub issue with the failing command and observed output.
3. Revert the faulty commit or prepare a patch fix.
4. Ship the fix as a new PATCH release through the normal flow (see "Versioning &
   release" above): bump `patch` at PR time, merge — the `Release` workflow tags and
   publishes it automatically.
5. Re-run the local and GitHub marketplace smoke tests before updating release notes.

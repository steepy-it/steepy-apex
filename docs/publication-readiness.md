# Public launch checklist

Use this checklist alongside [RELEASE.md](../RELEASE.md). It describes the launch
procedure; the CI run and GitHub settings on the final commit establish current status.
The initial public version is `1.0.0`. npm publication, marketplace submissions, and
optional audit evidence are separate from the GitHub launch.

## Before changing visibility

1. Review the final source tree, packaged files, asset provenance, and public documentation.
   Exclude local workflow artifacts, credentials, personal paths, and internal material.
2. Review the GitHub repository as well as Git history: pull requests, their Git refs,
   comments, old commits, releases, Actions logs, and artifacts may retain earlier content.
   Squashing `main` and deleting branches or tags does not remove that material.
   When launching from a new repository, transfer only the reviewed public history;
   keep private backups outside the checkout and never mirror old refs into the new repository.
3. Keep a verified private backup before destructive cleanup or repository replacement.
4. Commit the final payload and pass the release preflight on that exact commit.
   Inspect an actual tarball and install it in a fresh directory.
5. Confirm native smoke tests for the supported installation paths. The maintainer
   confirmed the pre-launch manual tests on 2026-09-16; later functional changes require
   the applicable checks again. Pi and DeepSeek do not have Steepy deterministic runners.
6. Verify that `main` and `v1.0.0` resolve to the approved commit. For an existing draft,
   explicitly verify both `tag_name: v1.0.0` and its target; update the notes from the changelog.

## Repository settings and publication

Prepare these settings before changing visibility and apply them as soon as the repository
plan permits them. Some GitHub plans provide branch protection only on public repositories.

- Protect `main` against deletion and force pushes, and require pull requests.
- Require the actual check names emitted by the workflows: `validation / test (24)`,
  `validation / package`, and `version-gate`. The version check runs on pull requests;
  the release workflow's `publish` job is not a pull-request check.
- Enable private vulnerability reporting and verify the route advertised in
  [SECURITY.md](../SECURITY.md), including the maintainer's email fallback.
- Make the reviewed repository public and publish the verified `v1.0.0` release.

The release workflow can create a missing release automatically after a successful push
to `main`. If publication must wait, establish the matching draft and tag before triggering
that push, or keep Actions disabled until the launch state is ready.

## Verify without repository credentials

Use a fresh environment without stored GitHub credentials to check:

- Repository, README, license, documentation, image, and release URLs.
- HTTPS clone and download of the published tag; compare the resulting commit identity.
- Package installation from GitHub and presence of skills, templates, scripts, and manifests.
- The documented native installation and first-run paths for the harnesses being announced.

A local tarball install validates packaging, not anonymous GitHub access or native host
behavior. Record those checks separately. See [installation](installation.md) for commands
and [the release checklist](../RELEASE.md#public-distribution-checklist) for later channels.

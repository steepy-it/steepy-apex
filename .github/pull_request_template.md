## What & why

<!-- One or two sentences. For features: link the issue where the approach was agreed. -->

## Checklist

- [ ] `npm test` is green
- [ ] Bug fix → includes a regression test; feature → includes tests
- [ ] Touched `.apex/`, `templates/`, or anything the linter reads → `node scripts/validate-hub.mjs .` exits 0
- [ ] Version bumped (`node scripts/bump-version.mjs <patch|minor|major>`) with a matching `CHANGELOG.md` section — or the PR carries the `no-release` label (docs/CI-only)

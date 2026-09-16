# Release evidence reference

[Release checklist](../RELEASE.md)

This reference describes optional release audit verification. It is not a release prerequisite.

## Optional same-payload audit verification

The release workflow requires Node 24 tests, hub coherence, version/manifest checks,
and package validation through `.github/workflows/validate.yml`. Its `--product-only`
check does not read audit evidence. Only the publishing job has `contents: write`.

Run the optional evidence check locally when completing an audit:

```bash
node scripts/validate-release-evidence.mjs
```

The command reads `docs/native-test-evidence.json` and authenticates every referenced
redacted artifact against `docs/native-test-evidence.md`; it never invokes Claude Code,
Codex, OpenCode, Pi, DeepSeek Harness, or an authenticated provider. Missing real current
evidence fails this optional check; it does not block publication. Hermetic synthetic records in the unit suite test
the validator but are not product acceptance evidence. The schema validates documented records;
it does not prove that a provider ran, so reviewers must still establish the live
provenance before committing either evidence file.

The v1 document is a closed object with `schemaVersion: 1` and `records`. It requires
exactly these IDs: `plugin-preflight`, `claude-code`, `codex`, `opencode`, `pi`, and
`deepseek-harness`. Every record contains `sourceRevision` (a full commit SHA),
`payloadSha256`, `productVersion`, `host` (`name`, `version`, `platform`, `profile`),
`observedAt`, `installation` (`method` and the complete composition), `checks`, a
redacted artifact path plus SHA-256 digest, and a `PASS` result. Evidence expires after
30 days, cannot be future-dated, and every capability result must be `PASS`; missing,
failed, skipped, pending, stale, incomplete, digest-mismatched, version-mismatched, or
payload-mismatched records fail the optional check.

Commands and the referenced UTF-8 artifact must not carry an unredacted credential in the
validator's bounded supported forms: credential assignments, `--api-key`/`--token`/
`--secret`/`--password` flags, Authorization Bearer/Basic values, credential-named headers,
or Cookie/Set-Cookie values. A captured value in those forms must be exactly `<redacted>`,
`[redacted]`, or `REDACTED`; the `artifact.redacted` flag and digest do not substitute for that
check. This deliberately is not a general secret scanner or proof that arbitrary text is
secret-free. Evidence authors and reviewers remain responsible for complete human redaction before
committing the bounded evidence files.

All six records must name one canonical source revision. The validator requires that commit to
be available and reachable from the current checkout, materializes its package projection from
committed tree paths, modes, and blob bytes (not archive output), and compares the current and
source product inputs by exact canonical path, mode, and bytes. Only
the three evidence-only paths below may differ, so this check establishes a source/product binding
without treating arbitrary documentation changes as evidence-only. It validates the recorded
provenance but still does not prove a provider actually ran.

The required capability IDs are:

- `plugin-preflight`: `manifest-version-lockstep`, `version-transaction-complete`,
  `npm-package-composition`, `hub-coherence`.
- Claude Code and OpenCode: `plugin-install-load`, `skill-discovery`, `skill-invocation`,
  `generated-project-bootstrap`, `scaffold-check-workflow`,
  `native-specialist-behavior`.
- Codex: the same first five checks plus `native-specialist-dispatch`.
- Pi: `package-extension-load`, `skill-invocation`, `session-transitions`.
- DeepSeek Harness: `plugin-load`, `commands`, `model-callable-skill-tool`,
  `bootstrap-lifecycle`.

`payloadSha256` hashes a domain marker plus every `npm pack` product input's canonical
path, file mode, and exact bytes in sorted order. Only `docs/native-test-evidence.json`,
`docs/native-test-evidence.md`, and `docs/release-audit-remediation.md` are excluded; no
documentation directory or path family is excluded. Consequently an evidence-only commit can
bind the already-tested product without claiming new product bytes were exercised, while any
other shipped change invalidates the evidence. All three manifests must carry the same
canonical safe-integer X.Y.Z version, the matching changelog heading must exist, and an
incomplete version transaction refuses the gate.

All external Actions are immutable pins verified against the official upstream on
2026-09-15: checkout v7.0.1 is documented at
https://github.com/actions/checkout/releases/tag/v7.0.1 and setup-node's pinned commit is
https://github.com/actions/setup-node/commit/820762786026740c76f36085b0efc47a31fe5020 .

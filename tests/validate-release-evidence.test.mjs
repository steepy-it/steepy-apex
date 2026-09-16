import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EVIDENCE_ARTIFACT_PATH,
  EVIDENCE_RECORD_IDS,
  REQUIRED_CAPABILITIES,
  collectNpmPackagePaths,
  computePayloadIdentity,
  validateProductState,
  validateReleaseEvidence,
} from '../scripts/validate-release-evidence.mjs';

const OBSERVED_AT = '2026-09-01';
const NOW = new Date('2026-09-12T12:00:00Z');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'steepy-release-evidence-'));
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  mkdirSync(join(root, 'adapters'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeJson(join(root, 'package.json'), {
    name: 'steepy-apex', version: '1.2.3', files: ['adapters/', 'docs/'],
  });
  writeJson(join(root, '.claude-plugin', 'plugin.json'), { name: 'steepy-apex', version: '1.2.3' });
  writeJson(join(root, '.codex-plugin', 'plugin.json'), { name: 'steepy-apex', version: '1.2.3' });
  writeFileSync(join(root, 'adapters', 'index.js'), 'export const ready = true;\n');
  writeFileSync(join(root, 'CHANGELOG.md'), '## v1.2.3 (2026-09-01)\n\n- Ready.\n');
  writeFileSync(join(root, EVIDENCE_ARTIFACT_PATH), 'redacted live evidence\n');
  writeFileSync(join(root, 'docs', 'native-test-evidence.json'), '{}\n');
  writeFileSync(join(root, 'docs', 'release-audit-remediation.md'), 'closure report\n');

  git(root, ['init']);
  git(root, ['config', 'user.email', 'release-evidence@example.test']);
  git(root, ['config', 'user.name', 'Release evidence test']);
  git(root, ['add', '--all']);
  git(root, ['commit', '-m', 'source fixture']);
  const sourceRevision = git(root, ['rev-parse', 'HEAD']);

  const packagePaths = collectNpmPackagePaths(root);
  const payloadSha256 = computePayloadIdentity(root, packagePaths);
  const artifactSha256 = sha256(readFileSync(join(root, EVIDENCE_ARTIFACT_PATH)));
  const records = EVIDENCE_RECORD_IDS.map((id) => ({
    id,
    sourceRevision,
    payloadSha256,
    productVersion: '1.2.3',
    host: {
      name: id,
      version: '1.0.0',
      platform: 'darwin-arm64',
      profile: 'isolated-release-canary',
    },
    observedAt: OBSERVED_AT,
    installation: {
      method: 'native local-package install',
      composition: ['final npm payload', 'isolated host profile'],
    },
    checks: REQUIRED_CAPABILITIES[id].map((capability) => ({
      capability,
      command: `redacted canary command for ${capability}`,
      result: 'PASS',
    })),
    artifact: {
      path: EVIDENCE_ARTIFACT_PATH,
      sha256: artifactSha256,
      redacted: true,
    },
    result: 'PASS',
  }));
  const evidence = { schemaVersion: 1, records };
  writeJson(join(root, 'docs', 'native-test-evidence.json'), evidence);
  return { root, packagePaths, payloadSha256, evidence, sourceRevision };
}

function withFixture(fn) {
  const fixture = makeFixture();
  try {
    return fn(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test('accepts strict PASS records for plugin preflight and all five native harnesses', () => {
  withFixture(({ root, packagePaths, evidence, payloadSha256, sourceRevision }) => {
    assert.deepEqual(
      validateReleaseEvidence(evidence, { root, packagePaths, now: NOW }),
      { productVersion: '1.2.3', payloadSha256, sourceRevisions: [sourceRevision] },
    );
  });
});

test('requires one reachable source revision for every evidence record', () => {
  withFixture(({ root, packagePaths, evidence }) => {
    const nonexistent = evidence.records.map((record) => ({
      ...record,
      sourceRevision: 'a'.repeat(40),
    }));
    assert.throws(
      () => validateReleaseEvidence({ schemaVersion: 1, records: nonexistent }, { root, packagePaths, now: NOW }),
      /source revision.*available|source revision.*reachable/i,
    );

    const split = [
      { ...evidence.records[0], sourceRevision: 'b'.repeat(40) },
      ...evidence.records.slice(1),
    ];
    assert.throws(
      () => validateReleaseEvidence({ schemaVersion: 1, records: split }, { root, packagePaths, now: NOW }),
      /source revisions must all match/,
    );
  });
});

test('requires current product bytes, modes, and paths to match the reachable source', () => {
  withFixture(({ root, packagePaths, evidence }) => {
    const evidenceFor = (paths) => {
      const payloadSha256 = computePayloadIdentity(root, paths);
      return {
        schemaVersion: 1,
        records: evidence.records.map((record) => ({ ...record, payloadSha256 })),
      };
    };
    const expectSourceMismatch = (paths) => assert.throws(
      () => validateReleaseEvidence(evidenceFor(paths), { root, packagePaths: paths, now: NOW }),
      /source product identity mismatch/,
    );

    writeFileSync(join(root, 'adapters', 'index.js'), 'export const ready = false;\n');
    expectSourceMismatch(packagePaths);

    writeFileSync(join(root, 'adapters', 'index.js'), 'export const ready = true;\n');
    chmodSync(join(root, 'adapters', 'index.js'), 0o755);
    expectSourceMismatch(packagePaths);

    chmodSync(join(root, 'adapters', 'index.js'), 0o644);
    writeFileSync(join(root, 'docs', 'new-shipped-documentation.md'), 'new product input\n');
    expectSourceMismatch(collectNpmPackagePaths(root));
  });
});

test('rejects a source-only shipped file even when export-ignore hides it from archives', () => {
  withFixture(({ root, evidence, sourceRevision }) => {
    writeFileSync(join(root, 'adapters', 'removed.js'), 'export const removed = true;\n');
    writeFileSync(join(root, '.gitattributes'), 'adapters/removed.js export-ignore\n');
    git(root, ['add', '--all']);
    git(root, ['commit', '-m', 'source includes removed product input']);
    const source = git(root, ['rev-parse', 'HEAD']);

    rmSync(join(root, 'adapters', 'removed.js'));
    git(root, ['add', '--all']);
    git(root, ['commit', '-m', 'current removes product input']);
    const packagePaths = collectNpmPackagePaths(root);
    const payloadSha256 = computePayloadIdentity(root, packagePaths);
    const records = evidence.records.map((record) => ({ ...record, sourceRevision: source, payloadSha256 }));

    assert.notEqual(source, sourceRevision);
    assert.throws(
      () => validateReleaseEvidence({ schemaVersion: 1, records }, { root, packagePaths, now: NOW }),
      /source product identity mismatch/,
    );
  });
});

test('uses unchanged committed bytes when export-subst metadata is present', () => {
  withFixture(({ root, evidence }) => {
    writeFileSync(join(root, 'adapters', 'index.js'), 'export const revision = "$Format:%H$";\n');
    writeFileSync(join(root, '.gitattributes'), 'adapters/index.js export-subst\n');
    git(root, ['add', '--all']);
    git(root, ['commit', '-m', 'source with literal export substitution marker']);
    const sourceRevision = git(root, ['rev-parse', 'HEAD']);

    writeFileSync(join(root, 'docs', 'release-audit-remediation.md'), 'evidence-only follow-up\n');
    git(root, ['add', '--all']);
    git(root, ['commit', '-m', 'evidence-only follow-up']);
    const packagePaths = collectNpmPackagePaths(root);
    const payloadSha256 = computePayloadIdentity(root, packagePaths);
    const records = evidence.records.map((record) => ({ ...record, sourceRevision, payloadSha256 }));

    assert.doesNotThrow(
      () => validateReleaseEvidence({ schemaVersion: 1, records }, { root, packagePaths, now: NOW }),
    );
  });
});

test('accepts a reachable source when only an exact evidence-only artifact changed', () => {
  withFixture(({ root, packagePaths, evidence }) => {
    writeFileSync(join(root, 'docs', 'release-audit-remediation.md'), 'final closure report\n');
    assert.doesNotThrow(
      () => validateReleaseEvidence(evidence, { root, packagePaths, now: NOW }),
    );
  });
});

test('payload identity changes for any shipped path, bytes, or mode', () => {
  withFixture(({ root, packagePaths, payloadSha256 }) => {
    writeFileSync(join(root, 'adapters', 'index.js'), 'export const ready = false;\n');
    assert.notEqual(computePayloadIdentity(root, packagePaths), payloadSha256);

    writeFileSync(join(root, 'adapters', 'index.js'), 'export const ready = true;\n');
    chmodSync(join(root, 'adapters', 'index.js'), 0o755);
    assert.notEqual(computePayloadIdentity(root, packagePaths), payloadSha256);

    writeFileSync(join(root, 'docs', 'other.md'), 'shipped\n');
    assert.notEqual(computePayloadIdentity(root, [...packagePaths, 'docs/other.md']), payloadSha256);
  });
});

test('payload identity excludes only the three declared evidence-only artifacts', () => {
  withFixture(({ root, packagePaths, payloadSha256 }) => {
    writeFileSync(join(root, 'docs', 'native-test-evidence.json'), '{"new":"record"}\n');
    writeFileSync(join(root, EVIDENCE_ARTIFACT_PATH), 'replacement redacted evidence\n');
    writeFileSync(join(root, 'docs', 'release-audit-remediation.md'), 'replacement closure report\n');
    assert.equal(computePayloadIdentity(root, packagePaths), payloadSha256);

    writeFileSync(join(root, 'docs', 'native-test-evidence-copy.md'), 'not excluded\n');
    assert.notEqual(
      computePayloadIdentity(root, [...packagePaths, 'docs/native-test-evidence-copy.md']),
      payloadSha256,
    );

    writeFileSync(join(root, 'docs', 'release-audit-remediation-copy.md'), 'not excluded\n');
    assert.notEqual(
      computePayloadIdentity(root, [...packagePaths, 'docs/release-audit-remediation-copy.md']),
      payloadSha256,
    );

    writeFileSync(join(root, 'docs', 'other-shipped-documentation.md'), 'not excluded\n');
    assert.notEqual(
      computePayloadIdentity(root, [...packagePaths, 'docs/other-shipped-documentation.md']),
      payloadSha256,
    );
  });
});

test('rejects missing, duplicate, unknown, failed, skipped, or pending records', () => {
  withFixture(({ root, packagePaths, evidence }) => {
    const invalidCases = [
      [evidence.records.slice(1), /missing evidence record/],
      [[...evidence.records, evidence.records[0]], /duplicate evidence record/],
      [[...evidence.records, { ...evidence.records[0], id: 'other' }], /unknown evidence record/],
      [evidence.records.map((record, index) => index ? record : { ...record, result: 'FAIL' }), /must be PASS/],
      [evidence.records.map((record, index) => index ? record : { ...record, result: 'SKIPPED' }), /must be PASS/],
      [evidence.records.map((record, index) => index ? record : { ...record, result: 'PENDING' }), /must be PASS/],
    ];
    for (const [records, expected] of invalidCases) {
      assert.throws(
        () => validateReleaseEvidence({ schemaVersion: 1, records }, { root, packagePaths, now: NOW }),
        expected,
      );
    }
  });
});

test('rejects stale/future evidence, mismatched payload/source/version, and incomplete checks', () => {
  withFixture(({ root, packagePaths, evidence }) => {
    const replaceFirst = (change) => [
      { ...evidence.records[0], ...change },
      ...evidence.records.slice(1),
    ];
    for (const [change, expected] of [
      [{ observedAt: '2026-07-01' }, /stale/],
      [{ observedAt: '2026-09-13' }, /future/],
      [{ payloadSha256: 'b'.repeat(64) }, /payload identity mismatch/],
      [{ productVersion: '1.2.2' }, /product version mismatch/],
      [{ sourceRevision: 'not-a-commit' }, /source revision/],
      [{ checks: evidence.records[0].checks.slice(1) }, /missing capability/],
    ]) {
      assert.throws(
        () => validateReleaseEvidence(
          { schemaVersion: 1, records: replaceFirst(change) },
          { root, packagePaths, now: NOW },
        ),
        expected,
      );
    }
  });
});

test('requires native Codex dispatch and capability-specific Pi/DeepSeek checks', () => {
  assert.ok(REQUIRED_CAPABILITIES.codex.includes('native-specialist-dispatch'));
  assert.deepEqual(REQUIRED_CAPABILITIES.pi, [
    'package-extension-load', 'skill-invocation', 'session-transitions',
  ]);
  assert.deepEqual(REQUIRED_CAPABILITIES['deepseek-harness'], [
    'plugin-load', 'commands', 'model-callable-skill-tool', 'bootstrap-lifecycle',
  ]);
});

test('rejects unredacted, missing, or digest-mismatched evidence artifacts', () => {
  withFixture(({ root, packagePaths, evidence }) => {
    const first = evidence.records[0];
    for (const [artifact, expected] of [
      [{ ...first.artifact, redacted: false }, /must be redacted/],
      [{ ...first.artifact, path: 'docs/missing.md' }, /artifact path/],
      [{ ...first.artifact, sha256: 'b'.repeat(64) }, /artifact digest mismatch/],
    ]) {
      const records = [{ ...first, artifact }, ...evidence.records.slice(1)];
      assert.throws(
        () => validateReleaseEvidence({ schemaVersion: 1, records }, { root, packagePaths, now: NOW }),
        expected,
      );
    }
  });
});

test('rejects an empty evidence artifact even when its digest matches', () => {
  withFixture(({ root, packagePaths, evidence }) => {
    writeFileSync(join(root, EVIDENCE_ARTIFACT_PATH), '');
    const artifact = { ...evidence.records[0].artifact, sha256: sha256(Buffer.alloc(0)) };
    const records = evidence.records.map((record) => ({ ...record, artifact }));
    assert.throws(
      () => validateReleaseEvidence({ schemaVersion: 1, records }, { root, packagePaths, now: NOW }),
      /artifact must not be empty/,
    );
  });
});

test('schema is closed and rejects unredacted supported credential forms in commands and artifacts', () => {
  withFixture(({ root, packagePaths, evidence }) => {
    assert.throws(
      () => validateReleaseEvidence(
        { schemaVersion: 1, records: [{ ...evidence.records[0], extra: true }, ...evidence.records.slice(1)] },
        { root, packagePaths, now: NOW },
      ),
      /unknown field/,
    );
    for (const command of [
      'DEEPSEEK_API_KEY=unredacted-value command',
      'curl -H "Authorization: Bearer unredacted-value"',
      'tool --token unredacted-value',
      'curl -H "Cookie: session=unredacted-value"',
      'curl -H "X-Api-Key: unredacted-value"',
    ]) {
      const checks = evidence.records[0].checks.map((check, index) => (
        index ? check : { ...check, command }
      ));
      assert.throws(
        () => validateReleaseEvidence(
          { schemaVersion: 1, records: [{ ...evidence.records[0], checks }, ...evidence.records.slice(1)] },
          { root, packagePaths, now: NOW },
        ),
        /credential-like/,
      );
    }

    writeFileSync(join(root, EVIDENCE_ARTIFACT_PATH), 'Authorization: Bearer unredacted-value\n');
    const artifact = { ...evidence.records[0].artifact, sha256: sha256(readFileSync(join(root, EVIDENCE_ARTIFACT_PATH))) };
    const records = evidence.records.map((record) => ({ ...record, artifact }));
    assert.throws(
      () => validateReleaseEvidence({ schemaVersion: 1, records }, { root, packagePaths, now: NOW }),
      /credential-like/,
    );

    writeFileSync(join(root, EVIDENCE_ARTIFACT_PATH), 'Authorization: Bearer <redacted>\nCookie: session=[redacted]\nX-Api-Key: REDACTED\n');
    const redactedArtifact = {
      ...artifact,
      sha256: sha256(readFileSync(join(root, EVIDENCE_ARTIFACT_PATH))),
    };
    for (const command of [
      'DEEPSEEK_API_KEY=<redacted> command',
      'curl -H "Authorization: Bearer <redacted>"',
      'tool --token=[redacted]',
      'curl -H "Cookie: session=[redacted]"',
      'curl -H "X-Api-Key: REDACTED"',
    ]) {
      const checks = evidence.records[0].checks.map((check, index) => (
        index ? check : { ...check, command }
      ));
      const redactedRecords = [
        { ...evidence.records[0], checks, artifact: redactedArtifact },
        ...evidence.records.slice(1).map((record) => ({ ...record, artifact: redactedArtifact })),
      ];
      assert.doesNotThrow(
        () => validateReleaseEvidence({ schemaVersion: 1, records: redactedRecords }, { root, packagePaths, now: NOW }),
      );
    }
  });
});

test('product validation rejects malformed, divergent, or incomplete bump state', () => {
  withFixture(({ root, packagePaths }) => {
    assert.equal(validateProductState(root, packagePaths).productVersion, '1.2.3');

    writeJson(join(root, '.codex-plugin', 'plugin.json'), { name: 'steepy-apex', version: '1.2.2' });
    assert.throws(() => validateProductState(root, packagePaths), /incomplete bump/);
    writeJson(join(root, '.codex-plugin', 'plugin.json'), { name: 'steepy-apex', version: '1.2.3' });

    writeFileSync(join(root, '.steepy-version-transaction.json'), '{}\n');
    assert.throws(() => validateProductState(root, packagePaths), /incomplete bump/);
    rmSync(join(root, '.steepy-version-transaction.json'));

    writeFileSync(join(root, 'CHANGELOG.md'), '## v1.2.2 (2026-08-01)\n');
    assert.throws(() => validateProductState(root, packagePaths), /CHANGELOG/);
  });
});

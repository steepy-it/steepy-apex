import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractSection, main } from '../scripts/extract-changelog.mjs';

const SAMPLE = `# Changelog

## v0.2.0 (2026-07-02)

- Feature A
- Feature B

## v0.1.0 (2026-06-01)

- Initial release
`;

// Fixture with a heading that has no trailing date suffix, to cover that shape too.
const NO_DATE_SUFFIX = `# Changelog

## v0.2.0

Body without a date suffix on the heading.

## v0.1.0

First.
`;

// Fixture exercising prefix confusion: v0.2.0 vs v0.2.0-rc1, and v0.2.0 vs v0.20.0.
const PREFIX_CONFUSION = `# Changelog

## v0.20.0 (2026-07-02)

Twenty body.

## v0.2.0-rc1 (2026-06-15)

RC body.

## v0.2.0 (2026-06-01)

Exact body.
`;

function makeFixture(content) {
  const root = mkdtempSync(join(tmpdir(), 'steepy-changelog-'));
  const changelogPath = join(root, 'CHANGELOG.md');
  writeFileSync(changelogPath, content);
  return { root, changelogPath };
}

// Capture console.log/console.error output around a main() call without spawning a
// subprocess — same technique as tests/bump-version.test.mjs's captureMain.
function captureMain(argv) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  let code;
  try {
    code = main(argv);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { code, out: out.join('\n'), err: err.join('\n') };
}

// --- extractSection: pure-function cases ---

test('extractSection: section in the middle, bounded by the next "## " heading', () => {
  assert.equal(extractSection(SAMPLE, '0.2.0'), '- Feature A\n- Feature B');
});

test('extractSection: last section, bounded by EOF', () => {
  assert.equal(extractSection(SAMPLE, '0.1.0'), '- Initial release');
});

test('extractSection: missing version -> null', () => {
  assert.equal(extractSection(SAMPLE, '9.9.9'), null);
});

test('extractSection: exact-version matching, no prefix confusion (v0.2.0 vs v0.2.0-rc1 vs v0.20.0)', () => {
  assert.equal(extractSection(PREFIX_CONFUSION, '0.20.0'), 'Twenty body.');
  assert.equal(extractSection(PREFIX_CONFUSION, '0.2.0-rc1'), 'RC body.');
  assert.equal(extractSection(PREFIX_CONFUSION, '0.2.0'), 'Exact body.');
});

test('extractSection: heading without a date suffix', () => {
  assert.equal(extractSection(NO_DATE_SUFFIX, '0.2.0'), 'Body without a date suffix on the heading.');
  assert.equal(extractSection(NO_DATE_SUFFIX, '0.1.0'), 'First.');
});

test('extractSection: heading with a date suffix', () => {
  assert.equal(extractSection(SAMPLE, '0.2.0'), '- Feature A\n- Feature B');
});

// --- main(): process-level cases ---

test('main: success prints the section body on stdout, exit 0', () => {
  const { root, changelogPath } = makeFixture(SAMPLE);
  try {
    const { code, out } = captureMain(['0.2.0', changelogPath]);
    assert.equal(code, 0);
    assert.equal(out, '- Feature A\n- Feature B');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main: missing section -> exit 1, message on stderr', () => {
  const { root, changelogPath } = makeFixture(SAMPLE);
  try {
    const { code, err } = captureMain(['9.9.9', changelogPath]);
    assert.equal(code, 1);
    assert.match(err, /9\.9\.9/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main: missing file -> exit 1, message on stderr', () => {
  const root = mkdtempSync(join(tmpdir(), 'steepy-changelog-'));
  const missingPath = join(root, 'does-not-exist.md');
  try {
    const { code, err } = captureMain(['0.2.0', missingPath]);
    assert.equal(code, 1);
    assert.match(err, /does-not-exist\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main: no args -> usage on stderr, exit 1', () => {
  const { code, err } = captureMain([]);
  assert.equal(code, 1);
  assert.match(err, /usage/i);
});

test('main: invalid version arg -> message on stderr, exit 1', () => {
  const { root, changelogPath } = makeFixture(SAMPLE);
  try {
    const { code, err } = captureMain(['not-a-version', changelogPath]);
    assert.equal(code, 1);
    assert.match(err, /not-a-version/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

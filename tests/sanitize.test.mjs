import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSafeRelPath,
  assertSafeLine,
  assertSafeTestCommand,
  escapeYamlDouble,
  assertSafeHubRoot,
} from '../scripts/sanitize.mjs';

test('assertSafeRelPath accepts safe relative paths', () => {
  assert.equal(assertSafeRelPath('libs/@rt3-backend', 'path'), 'libs/@rt3-backend');
  assert.equal(assertSafeRelPath('packages/@scope/name', 'path'), 'packages/@scope/name');
  assert.equal(assertSafeRelPath('scripts', 'path'), 'scripts');
  assert.equal(assertSafeRelPath('apps/web', 'path'), 'apps/web');
  assert.equal(assertSafeRelPath('libs/ui-kit_v2.1', 'path'), 'libs/ui-kit_v2.1');
});

test('assertSafeRelPath rejects traversal, absolute, control chars, and unsafe chars', () => {
  for (const bad of ['', '/etc/passwd', '../secrets', 'a/../b', 'a\nb', 'a\tb', 'a b', 'a"b', 'a`b', 'a\\b', 'a;b', 'a{b}']) {
    assert.throws(() => assertSafeRelPath(bad, 'path'), /path/, `should reject: ${JSON.stringify(bad)}`);
  }
});

test('assertSafeLine accepts single-line text incl. quotes, rejects newlines/control', () => {
  assert.equal(assertSafeLine('npm test', 'testCmd'), 'npm test');
  assert.equal(assertSafeLine('node --test --test-name-pattern "foo"', 'testCmd'), 'node --test --test-name-pattern "foo"');
  assert.equal(assertSafeLine('', 'testCmd'), '');
  for (const bad of ['a\nb', 'a\rb', 'a\x00b', 'a\x1fb']) {
    assert.throws(() => assertSafeLine(bad, 'testCmd'), /testCmd/, `should reject: ${JSON.stringify(bad)}`);
  }
});

test('assertSafeTestCommand rejects only lines that close the emitted Markdown fence', () => {
  for (const command of [
    'npm test',
    'node -e "console.log(`café 😀`)"',
    'echo ```',
    '``` echo',
    '    ```',
    '~~~',
    '',
  ]) {
    assert.equal(assertSafeTestCommand(command, 'testCmd'), command);
  }
  for (const command of ['```', '````', ' ```', '  ```   ', '   `````']) {
    assert.throws(
      () => assertSafeTestCommand(command, 'testCmd'),
      /testCmd.*Markdown fence/i,
      command,
    );
  }
  assert.throws(() => assertSafeTestCommand('npm test\n```', 'testCmd'), /testCmd/);
  for (const command of ['node --test \ud800', 'node --test \udfff']) {
    assert.throws(() => assertSafeTestCommand(command, 'testCmd'), /testCmd.*UTF-8/i);
  }
});

test('escapeYamlDouble escapes backslash and double-quote', () => {
  assert.equal(escapeYamlDouble('plain'), 'plain');
  assert.equal(escapeYamlDouble('a"b'), 'a\\"b');
  assert.equal(escapeYamlDouble('a\\b'), 'a\\\\b');
});

test('assertSafeHubRoot refuses the filesystem root, accepts a normal dir', () => {
  // Guard against a fat-fingered `--hub /` that would scaffold into the FS root.
  assert.throws(() => assertSafeHubRoot('/'), /filesystem root/);
  const d = mkdtempSync(join(tmpdir(), 'steepy-hub-'));
  assert.equal(assertSafeHubRoot(d), d);
});

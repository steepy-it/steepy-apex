import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LOCAL_AREA_NAMES,
  assertSafeRelPath,
  assertSafeLine,
  assertSafeTestCommand,
  bindProjectMount,
  escapeYamlDouble,
  assertSafeHubRoot,
  localAreaIdentities,
} from '../scripts/sanitize.mjs';

function withRepo(suffix, fn) {
  const base = mkdtempSync(join(tmpdir(), `steepy-sanitize-${suffix}-`));
  try {
    const root = join(base, 'repo');
    mkdirSync(join(root, '.apex'), { recursive: true });
    return fn(realpathSync.native(root), realpathSync.native(base));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function storageAliasesCase(directory) {
  const lower = join(directory, 'steepy-case-probe');
  mkdirSync(lower);
  try {
    const canonical = lstatSync(lower, { bigint: true });
    const alias = lstatSync(join(directory, 'STEEPY-CASE-PROBE'), { bigint: true });
    return canonical.dev === alias.dev && canonical.ino === alias.ino;
  } catch {
    return false;
  }
}

function assertEntersArea(fn, area, label) {
  assert.throws(fn, (error) => {
    assert.match(error.message, new RegExp(`enters excluded \\.apex/${area}`, 'u'), label);
    assert.equal(error.localArea, area, label);
    return true;
  }, label);
}

test('the local-area registry names both repository-local .apex areas', () => {
  assert.deepEqual([...LOCAL_AREA_NAMES], ['work', 'inception']);
  assert.equal(Object.isFrozen(LOCAL_AREA_NAMES), true);
});

test('local-area identities bind each existing area and the physical target of a linked area', () => {
  withRepo('identities', (root, base) => {
    assert.deepEqual(localAreaIdentities(join(root, '.apex')), []);
    mkdirSync(join(root, '.apex', 'work'));
    const external = join(base, 'external-inception');
    mkdirSync(external);
    symlinkSync(external, join(root, '.apex', 'inception'), 'dir');
    const identities = localAreaIdentities(join(root, '.apex'));
    const work = lstatSync(join(root, '.apex', 'work'), { bigint: true });
    const target = lstatSync(external, { bigint: true });
    assert.deepEqual(identities.map(({ name, dev, ino }) => [name, dev, ino]), [
      ['work', work.dev, work.ino],
      ['work', work.dev, work.ino],
      ['inception', target.dev, target.ino],
    ]);
  });
});

test('provider and root mounts that land in or pass through a local area are refused', () => {
  for (const area of LOCAL_AREA_NAMES) {
    withRepo(`mount-${area}`, (root, base) => {
      mkdirSync(join(root, '.apex', area, 'sub'), { recursive: true });
      writeFileSync(join(root, '.apex', area, 'agents.md'), '# LOCAL_BODY_SENTINEL\n');
      mkdirSync(join(root, '.apex', 'provider'));
      symlinkSync(`.apex/${area}`, join(root, '.claude'), 'dir');
      symlinkSync(join(root, '.apex', area, 'sub'), join(root, '.codex'), 'dir');
      symlinkSync(`.apex/${area}/agents.md`, join(root, 'AGENTS.md'));
      symlinkSync(`.apex/${area}/../provider`, join(root, '.opencode'), 'dir');
      for (const name of ['.claude', '.codex', 'AGENTS.md', '.opencode']) {
        assertEntersArea(() => bindProjectMount(root, `${name}/x`), area, `${area}: ${name}`);
      }

      const external = join(base, 'external-area');
      mkdirSync(join(external, 'nested'), { recursive: true });
      rmSync(join(root, '.apex', area), { recursive: true });
      symlinkSync(external, join(root, '.apex', area), 'dir');
      symlinkSync(join(external, 'nested'), join(root, '.agents'), 'dir');
      assertEntersArea(() => bindProjectMount(root, '.agents/skills'), area, `${area}: linked area target`);
    });
  }
});

test('ordinary provider mounts and the hub mount itself stay bindable beside local areas', () => {
  withRepo('ordinary', (root, base) => {
    mkdirSync(join(root, '.apex', 'inception'));
    mkdirSync(join(root, '.apex', 'work'));
    mkdirSync(join(root, '.apex', 'provider'));
    const external = join(base, 'provider');
    mkdirSync(external);
    symlinkSync('.apex/provider', join(root, '.claude'), 'dir');
    symlinkSync(external, join(root, '.codex'), 'dir');
    symlinkSync('.apex/notes/../provider', join(root, '.opencode'), 'dir');
    mkdirSync(join(root, '.apex', 'notes'));
    assert.equal(bindProjectMount(root, '.claude/agents').physical, join(root, '.apex', 'provider'));
    assert.equal(bindProjectMount(root, '.codex/agents').physical, external);
    assert.equal(bindProjectMount(root, '.opencode/agents').physical, join(root, '.apex', 'provider'));
    assert.equal(bindProjectMount(root, '.agents/skills'), null);
  });
  withRepo('hub-mount', (root, base) => {
    const hub = join(base, 'hub');
    mkdirSync(join(hub, 'inception'), { recursive: true });
    rmSync(join(root, '.apex'), { recursive: true });
    symlinkSync(hub, join(root, '.apex'), 'dir');
    assert.equal(bindProjectMount(root, '.apex/_INDEX.md').physical, hub);
  });
});

test('a case-alias mount text through a local area is refused by physical identity', (t) => {
  withRepo('case', (root) => {
    if (!storageAliasesCase(root)) {
      t.skip('temporary storage keeps case-distinct directory identities');
      return;
    }
    for (const area of LOCAL_AREA_NAMES) mkdirSync(join(root, '.apex', area));
    mkdirSync(join(root, '.apex', 'provider'));
    symlinkSync('.APEX/INCEPTION/../provider', join(root, '.claude'), 'dir');
    symlinkSync('.apex/WoRk/../provider', join(root, '.codex'), 'dir');
    assertEntersArea(() => bindProjectMount(root, '.claude/agents'), 'inception', 'inception alias');
    assertEntersArea(() => bindProjectMount(root, '.codex/agents'), 'work', 'work alias');
  });
});

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

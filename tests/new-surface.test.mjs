import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffold, main } from '../scripts/new-surface.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, '..', 'templates');

function tempHub() {
  return mkdtempSync(join(tmpdir(), 'steepy-new-surface-'));
}

function args(hubRoot, overrides = {}) {
  return {
    name: 'web',
    surfacePath: 'apps/web',
    agent: 'web-agent',
    hubRoot,
    templatesDir,
    testCmd: 'npm test',
    ...overrides,
  };
}

function adapterPaths(hubRoot, agent = 'web-agent') {
  return {
    claude: join(hubRoot, '.claude', 'agents', `${agent}.md`),
    codex: join(hubRoot, '.codex', 'agents', `${agent}.toml`),
    opencode: join(hubRoot, '.opencode', 'agents', `${agent}.md`),
  };
}

function snapshot(root) {
  const result = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      const rel = relative(root, path);
      if (entry.isDirectory()) {
        result.push([`${rel}/`, null]);
        walk(path);
      } else if (entry.isSymbolicLink()) {
        result.push([rel, 'symlink']);
      } else {
        result.push([rel, readFileSync(path, 'utf8')]);
      }
    }
  }
  walk(root);
  return result;
}

function writeCurrentTriad(hubRoot) {
  const sourceHub = tempHub();
  const source = scaffold(args(sourceHub));
  for (const [adapter, sourcePath] of Object.entries(source.adapterPaths)) {
    const target = adapterPaths(hubRoot)[adapter];
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(sourcePath));
  }
}

test('fresh scaffold creates one standard and the Claude, Codex, and OpenCode adapter triad', () => {
  const hubRoot = tempHub();
  const indexPath = join(hubRoot, '.apex', '_INDEX.md');
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, 'CUSTOM INDEX\n');

  const result = scaffold(args(hubRoot));
  const expectedAdapters = adapterPaths(hubRoot);
  assert.deepEqual(Object.keys(result), [
    'standardPath', 'agentPath', 'adapterPaths', 'row', 'created', 'preserved', 'mode',
  ]);
  assert.equal(result.mode, 'preparatory-unbound');
  assert.equal(result.standardPath, join(hubRoot, '.apex', 'standards', 'web.md'));
  assert.equal(result.agentPath, expectedAdapters.claude);
  assert.deepEqual(result.adapterPaths, expectedAdapters);
  assert.deepEqual(result.created, ['standard', 'claude', 'codex', 'opencode']);
  assert.deepEqual(result.preserved, []);
  assert.equal(result.row, '| `web` | [standards/web.md](standards/web.md) | `web-agent` | — |');
  assert.equal(readFileSync(indexPath, 'utf8'), 'CUSTOM INDEX\n');
  const renderedStandard = readFileSync(result.standardPath, 'utf8');
  assert.match(renderedStandard, /```[\s\S]*npm test[\s\S]*```/);
  assert.doesNotMatch(renderedStandard, /`npm test`/);
  for (const path of Object.values(result.adapterPaths)) assert.ok(existsSync(path), path);
});

test('non-repair blocks an existing adapter before writing any missing target', () => {
  const sourceHub = tempHub();
  const source = scaffold(args(sourceHub));
  const hubRoot = tempHub();
  const paths = adapterPaths(hubRoot);
  mkdirSync(dirname(paths.claude), { recursive: true });
  writeFileSync(paths.claude, readFileSync(source.adapterPaths.claude));
  const before = snapshot(hubRoot);

  assert.throws(() => scaffold(args(hubRoot)), /already exists/i);
  assert.deepEqual(snapshot(hubRoot), before);
  assert.ok(!existsSync(join(hubRoot, '.apex', 'standards', 'web.md')));
  assert.ok(!existsSync(paths.codex));
  assert.ok(!existsSync(paths.opencode));
});

test('standard destination staging failure leaves the standard and all adapters absent', () => {
  const hubRoot = tempHub();
  const standardsDir = join(hubRoot, '.apex', 'standards');
  const standardPath = join(standardsDir, 'web.md');
  const paths = adapterPaths(hubRoot);
  mkdirSync(standardsDir, { recursive: true });
  chmodSync(standardsDir, 0o555);

  try {
    assert.throws(() => scaffold(args(hubRoot)), /EACCES|permission denied/i);
    assert.equal(existsSync(standardPath), false);
    for (const path of Object.values(paths)) assert.equal(existsSync(path), false, path);
    assert.equal(readdirSync(standardsDir).some((name) => name.includes('.steepy-new-surface-')), false);
  } finally {
    chmodSync(standardsDir, 0o755);
  }
});

test('repair preserves a standard and current Claude adapter while creating missing adapters', () => {
  const hubRoot = tempHub();
  const standardPath = join(hubRoot, '.apex', 'standards', 'web.md');
  mkdirSync(dirname(standardPath), { recursive: true });
  writeFileSync(standardPath, 'CUSTOM STANDARD\n');
  const sourceHub = tempHub();
  const source = scaffold(args(sourceHub));
  const paths = adapterPaths(hubRoot);
  mkdirSync(dirname(paths.claude), { recursive: true });
  writeFileSync(paths.claude, readFileSync(source.adapterPaths.claude));

  const result = scaffold(args(hubRoot, { repair: true }));
  assert.equal(readFileSync(standardPath, 'utf8'), 'CUSTOM STANDARD\n');
  assert.equal(readFileSync(paths.claude, 'utf8'), readFileSync(source.adapterPaths.claude, 'utf8'));
  assert.ok(existsSync(paths.codex));
  assert.ok(existsSync(paths.opencode));
  assert.deepEqual(result.created, ['codex', 'opencode']);
  assert.deepEqual(result.preserved, ['standard', 'claude']);
});

test('repair creates a missing standard while preserving a current adapter triad', () => {
  const hubRoot = tempHub();
  writeCurrentTriad(hubRoot);
  const before = Object.fromEntries(Object.entries(adapterPaths(hubRoot))
    .map(([adapter, path]) => [adapter, readFileSync(path, 'utf8')]));

  const result = scaffold(args(hubRoot, { repair: true }));
  assert.ok(existsSync(result.standardPath));
  for (const [adapter, path] of Object.entries(result.adapterPaths)) {
    assert.equal(readFileSync(path, 'utf8'), before[adapter]);
  }
  assert.deepEqual(result.created, ['standard']);
  assert.deepEqual(result.preserved, ['claude', 'codex', 'opencode']);
});

test('repair refuses an unmarked Claude specialist without writing siblings', () => {
  const hubRoot = tempHub();
  const paths = adapterPaths(hubRoot);
  mkdirSync(dirname(paths.claude), { recursive: true });
  const content = '---\nname: web-agent\nmodel: sonnet\n---\nYou specialize in web work.\n';
  writeFileSync(paths.claude, content);
  assert.throws(() => scaffold(args(hubRoot, { repair: true })), /customized|conflict/i);
  assert.equal(readFileSync(paths.claude, 'utf8'), content);
  assert.equal(existsSync(paths.codex), false);
  assert.equal(existsSync(paths.opencode), false);
});

for (const [label, target, content, pattern] of [
  ['customized', 'claude', 'CUSTOM SPECIALIST\n', /customized|conflict/i],
  ['malformed', 'codex', '# steepy:generated:web-agent-codex:v2\n', /malformed|unknown-version|conflict/i],
]) {
  test(`repair blocks a ${label} adapter with zero writes`, () => {
    const hubRoot = tempHub();
    const path = adapterPaths(hubRoot)[target];
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    const before = snapshot(hubRoot);
    assert.throws(() => scaffold(args(hubRoot, { repair: true })), pattern);
    assert.deepEqual(snapshot(hubRoot), before);
  });
}

test('repair blocks a symlink adapter with zero writes outside the hub', () => {
  const hubRoot = tempHub();
  const outside = tempHub();
  const outsidePath = join(outside, 'sentinel.md');
  writeFileSync(outsidePath, 'OUTSIDE\n');
  const claudePath = adapterPaths(hubRoot).claude;
  mkdirSync(dirname(claudePath), { recursive: true });
  symlinkSync(outsidePath, claudePath);
  const before = snapshot(hubRoot);

  assert.throws(() => scaffold(args(hubRoot, { repair: true })), /symlink|conflict/i);
  assert.deepEqual(snapshot(hubRoot), before);
  assert.equal(readFileSync(outsidePath, 'utf8'), 'OUTSIDE\n');
});

test('repair preserves a modular standard core and does not create the single-file form', () => {
  const hubRoot = tempHub();
  const corePath = join(hubRoot, '.apex', 'standards', 'web', 'web-core.md');
  const singlePath = join(hubRoot, '.apex', 'standards', 'web.md');
  mkdirSync(dirname(corePath), { recursive: true });
  writeFileSync(corePath, 'CUSTOM CORE\n');

  const result = scaffold(args(hubRoot, { repair: true }));
  assert.equal(result.standardPath, corePath);
  assert.equal(readFileSync(corePath, 'utf8'), 'CUSTOM CORE\n');
  assert.equal(existsSync(singlePath), false);
  assert.deepEqual(result.created, ['claude', 'codex', 'opencode']);
  assert.deepEqual(result.preserved, ['standard']);
});

test('repair rerun is a byte- and timestamp-preserving no-op with the Claude alias intact', () => {
  const hubRoot = tempHub();
  const first = scaffold(args(hubRoot));
  const watched = [first.standardPath, ...Object.values(first.adapterPaths)];
  const before = watched.map((path) => ({ path, bytes: readFileSync(path), mtime: lstatSync(path).mtimeMs }));

  const rerun = scaffold(args(hubRoot, { repair: true }));
  assert.equal(rerun.agentPath, rerun.adapterPaths.claude);
  assert.deepEqual(rerun.created, []);
  assert.deepEqual(rerun.preserved, ['standard', 'claude', 'codex', 'opencode']);
  for (const prior of before) {
    assert.deepEqual(readFileSync(prior.path), prior.bytes);
    assert.equal(lstatSync(prior.path).mtimeMs, prior.mtime);
  }
});

test('unsafe values are rejected before planning or writing', () => {
  const hubRoot = tempHub();
  assert.throws(() => scaffold(args(hubRoot, { name: '../../pwned' })), /invalid (surface )?name/i);
  assert.throws(() => scaffold(args(hubRoot, { agent: '../escape' })), /invalid agent name/i);
  assert.throws(() => scaffold(args(hubRoot, { surfacePath: 'apps/../../etc' })), /unsafe path/i);
  assert.throws(() => scaffold(args(hubRoot, { testCmd: 'npm test\nmalicious' })), /unsafe testCmd/i);
  for (const testCmd of ['```', '````', '  ```   ']) {
    assert.throws(() => scaffold(args(hubRoot, { testCmd })), /testCmd.*Markdown fence/i);
  }
  for (const testCmd of ['node --test \ud800', 'node --test \udfff']) {
    assert.throws(() => scaffold(args(hubRoot, { testCmd })), /testCmd.*UTF-8/i);
  }
  assert.deepEqual(snapshot(hubRoot), []);
});

test('preparatory new-surface preserves valid Unicode and harmless shell backticks byte-exactly', () => {
  const hubRoot = tempHub();
  const testCmd = 'node -e "console.log(`café 😀`)"';
  const result = scaffold(args(hubRoot, { testCmd }));
  const standard = readFileSync(result.standardPath, 'utf8');

  assert.ok(standard.includes(`\`\`\`sh\n${testCmd}\n\`\`\``));
  assert.doesNotMatch(standard, /�/u);
});

test('main keeps init compatibility and creates the complete triad', () => {
  const hubRoot = tempHub();
  const code = main(['--name', 'web', '--path', 'apps/web', '--hub', hubRoot, '--test', 'npm test']);
  assert.equal(code, 0);
  assert.ok(existsSync(join(hubRoot, '.apex', 'standards', 'web.md')));
  for (const path of Object.values(adapterPaths(hubRoot))) assert.ok(existsSync(path), path);
});

test('main maps usage and scaffold failures to their established exit codes', () => {
  assert.equal(main([]), 2);
  assert.equal(main(['--name', '../../pwned', '--path', 'x', '--hub', tempHub()]), 1);
});

test('the real standard templates retain their required structure', () => {
  const standard = readFileSync(join(templatesDir, 'surface-standard.md'), 'utf8');
  for (const heading of ['## Scope', '## Conventions', '## Anti-patterns', '## Testing']) {
    assert.ok(standard.includes(heading), heading);
  }
  for (const placeholder of ['{{name}}', '{{path}}', '{{testCmd}}']) {
    assert.ok(standard.includes(placeholder), placeholder);
  }
  for (const prompt of ['Owns', 'Does NOT own', 'Exemplar']) {
    assert.ok(standard.includes(prompt), prompt);
  }
  const core = readFileSync(join(templatesDir, 'surface-standard-core.md'), 'utf8');
  for (const heading of ['## Scope', '## Conventions', '## Sub-area routing', '## Testing']) {
    assert.ok(core.includes(heading), heading);
  }
  assert.ok(core.includes('| Sub-area | When to read it (path/topic) | Doc |'));
  for (const placeholder of ['{{name}}', '{{path}}', '{{testCmd}}']) {
    assert.ok(core.includes(placeholder), placeholder);
  }
  for (const prompt of ['Owns', 'Does NOT own', 'Exemplar']) {
    assert.ok(core.includes(prompt), prompt);
  }
  assert.ok(core.includes('zero matches'));
  for (const template of ['surface-agent-claude.md', 'surface-agent-codex.toml', 'surface-agent-opencode.md']) {
    assert.ok(existsSync(join(templatesDir, template)), template);
  }
});

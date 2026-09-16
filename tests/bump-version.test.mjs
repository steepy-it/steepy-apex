import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyBump, bumpVersion, checkVersions, main } from '../scripts/bump-version.mjs';

const manifestPaths = ['package.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json'];
const transactionFile = '.steepy-version-transaction.json';
const bumpModule = new URL('../scripts/bump-version.mjs', import.meta.url).href;
const manifestSnapshot = (root) => manifestPaths.map((rel) => {
  const path = join(root, rel);
  const stat = statSync(path);
  return { text: readFileSync(path, 'utf8'), mode: stat.mode & 0o7777, mtime: stat.mtimeMs };
});

function crashBump(root, phase, index = -1) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { applyBump } from ${JSON.stringify(bumpModule)};
    applyBump(process.argv[1], 'patch', { checkpoint(event) {
      if (event.phase === process.argv[2] && (event.index ?? -1) === Number(process.argv[3])) process.exit(71);
    } });
  `, root, phase, String(index)], { encoding: 'utf8' });
}

// Fixture mirrors the real repo shape (2-space indent, trailing newline) so byte-level
// formatting assertions are meaningful. Always torn down in a finally block: the brief
// requires tests to leave no temp dirs behind. codexPluginVersion defaults to
// pluginVersion so callers that only care about the package.json-vs-plugin.json split
// don't need to know about the third manifest.
function makeFixture({ pkgVersion = '1.2.3', pluginVersion = '1.2.3', codexPluginVersion = pluginVersion } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'steepy-bump-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', version: pkgVersion, scripts: { test: 'node --test' } }, null, 2) + '\n',
  );
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'demo', version: pluginVersion }, null, 2) + '\n',
  );
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'demo', version: codexPluginVersion }, null, 2) + '\n',
  );
  return root;
}

function readVersion(root, rel) {
  return JSON.parse(readFileSync(join(root, rel), 'utf8')).version;
}

// Capture console.log/console.error output around a main() call without spawning a
// subprocess — same technique as tests/validate-hub.test.mjs's captureMain.
function captureMain(argv, root) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  let code;
  try {
    code = main(argv, root);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('bumpVersion: patch/minor/major arithmetic', () => {
  assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
  assert.equal(bumpVersion('0.1.9', 'patch'), '0.1.10');
});

test('bumpVersion: explicit X.Y.Z passes through unchanged', () => {
  assert.equal(bumpVersion('1.2.3', '5.6.7'), '5.6.7');
});

test('bumpVersion: invalid kind throws', () => {
  assert.throws(() => bumpVersion('1.2.3', 'banana'), /invalid/);
});

test('bumpVersion: invalid current version throws', () => {
  assert.throws(() => bumpVersion('not-a-version', 'patch'), /invalid/);
});

test('bumpVersion: strict versions, increasing targets and safe arithmetic', () => {
  for (const current of ['01.2.3', '1.02.3', '1.2.03', '9007199254740992.0.0']) {
    assert.throws(() => bumpVersion(current, 'patch'), /invalid/);
  }
  for (const target of ['1.2.3', '1.2.2', '01.2.4', '9007199254740992.0.0']) {
    assert.throws(() => bumpVersion('1.2.3', target), /invalid|increase|downgrade/);
  }
  assert.throws(() => bumpVersion('1.2.9007199254740991', 'patch'), /invalid|safe/);
  assert.equal(bumpVersion('1.9.99', 'minor'), '1.10.0');
  assert.equal(bumpVersion('9.99.99', 'major'), '10.0.0');
});

test('main: patch bump updates all three manifests, preserves 2-space indent + trailing newline, prints old -> new', () => {
  const root = makeFixture({ pkgVersion: '1.2.3', pluginVersion: '1.2.3' });
  try {
    const { code, out } = captureMain(['patch'], root);
    assert.equal(code, 0);
    assert.equal(readVersion(root, 'package.json'), '1.2.4');
    assert.equal(readVersion(root, '.claude-plugin/plugin.json'), '1.2.4');
    assert.equal(readVersion(root, '.codex-plugin/plugin.json'), '1.2.4');
    assert.match(out, /package\.json: 1\.2\.3 -> 1\.2\.4/);
    assert.match(out, /\.claude-plugin\/plugin\.json: 1\.2\.3 -> 1\.2\.4/);
    assert.match(out, /\.codex-plugin\/plugin\.json: 1\.2\.3 -> 1\.2\.4/);

    const pkgText = readFileSync(join(root, 'package.json'), 'utf8');
    assert.ok(pkgText.endsWith('\n') && !pkgText.endsWith('\n\n'), 'trailing newline preserved, not duplicated');
    assert.match(pkgText, /^\{\n  "name": "demo",/, '2-space indent preserved');
    // Unrelated fields must survive untouched.
    assert.match(pkgText, /"scripts": \{\n {4}"test": "node --test"\n {2}\}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main: minor and major bumps', () => {
  const rootMinor = makeFixture({ pkgVersion: '1.2.3', pluginVersion: '1.2.3' });
  const rootMajor = makeFixture({ pkgVersion: '1.2.3', pluginVersion: '1.2.3' });
  try {
    captureMain(['minor'], rootMinor);
    assert.equal(readVersion(rootMinor, 'package.json'), '1.3.0');
    assert.equal(readVersion(rootMinor, '.claude-plugin/plugin.json'), '1.3.0');
    assert.equal(readVersion(rootMinor, '.codex-plugin/plugin.json'), '1.3.0');

    captureMain(['major'], rootMajor);
    assert.equal(readVersion(rootMajor, 'package.json'), '2.0.0');
    assert.equal(readVersion(rootMajor, '.claude-plugin/plugin.json'), '2.0.0');
    assert.equal(readVersion(rootMajor, '.codex-plugin/plugin.json'), '2.0.0');
  } finally {
    rmSync(rootMinor, { recursive: true, force: true });
    rmSync(rootMajor, { recursive: true, force: true });
  }
});

test('main: explicit X.Y.Z arg sets all three manifests to that exact version', () => {
  const root = makeFixture({ pkgVersion: '1.2.3', pluginVersion: '1.2.3' });
  try {
    const { code } = captureMain(['9.9.9'], root);
    assert.equal(code, 0);
    assert.equal(readVersion(root, 'package.json'), '9.9.9');
    assert.equal(readVersion(root, '.claude-plugin/plugin.json'), '9.9.9');
    assert.equal(readVersion(root, '.codex-plugin/plugin.json'), '9.9.9');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main: one manifest malformed -> exit 1 and NEITHER file is written (no partial write)', () => {
  // Regression: applyBump used to bump-and-write in a single pass, so a valid
  // package.json got written to disk before the malformed plugin.json's bumpVersion()
  // call threw. The command must fail atomically: validate/compute every manifest's
  // bump before writing any of them.
  const root = makeFixture({ pkgVersion: '1.2.3', pluginVersion: 'not-a-version' });
  try {
    const { code, err } = captureMain(['patch'], root);
    assert.equal(code, 1);
    assert.match(err, /invalid/i);
    assert.equal(readVersion(root, 'package.json'), '1.2.3', 'valid manifest must NOT be written when its sibling is malformed');
    assert.equal(readVersion(root, '.claude-plugin/plugin.json'), 'not-a-version');
    assert.equal(readVersion(root, '.codex-plugin/plugin.json'), 'not-a-version', 'a later manifest must NOT be written when an earlier sibling is malformed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main --check: exit 0 when all three manifests agree on a valid semver', () => {
  const root = makeFixture({ pkgVersion: '1.2.3', pluginVersion: '1.2.3' });
  try {
    const { code, out } = captureMain(['--check'], root);
    assert.equal(code, 0);
    assert.match(out, /1\.2\.3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main --check: exit 1 with a drift message when manifests disagree', () => {
  const root = makeFixture({ pkgVersion: '1.2.3', pluginVersion: '1.2.4' });
  try {
    const { code, err } = captureMain(['--check'], root);
    assert.equal(code, 1);
    assert.match(err, /drift/i);
    assert.match(err, /1\.2\.3/);
    assert.match(err, /1\.2\.4/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main --check: exit 1 when manifests agree but do not match semver shape', () => {
  const root = makeFixture({ pkgVersion: 'not-semver', pluginVersion: 'not-semver' });
  try {
    const { code, err } = captureMain(['--check'], root);
    assert.equal(code, 1);
    assert.match(err, /drift/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main --check: matching manifests with leading zeroes or unsafe integers remain invalid', () => {
  for (const version of ['01.2.3', '1.2.9007199254740992']) {
    const root = makeFixture({ pkgVersion: version, pluginVersion: version });
    try {
      assert.equal(captureMain(['--check'], root).code, 1);
      assert.equal(readVersion(root, 'package.json'), version);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('main: missing arg -> usage on stderr, exit 1', () => {
  const root = makeFixture();
  try {
    const { code, err } = captureMain([], root);
    assert.equal(code, 1);
    assert.match(err, /usage/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main: invalid keyword arg -> usage on stderr, exit 1', () => {
  const root = makeFixture();
  try {
    const { code, err } = captureMain(['banana'], root);
    assert.equal(code, 1);
    assert.match(err, /usage/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main: malformed explicit version (rejected by the semver regex) -> usage on stderr, exit 1', () => {
  const root = makeFixture();
  try {
    const { code, err } = captureMain(['1.2'], root);
    assert.equal(code, 1);
    assert.match(err, /usage/i);
    assert.equal(readVersion(root, 'package.json'), '1.2.3', 'manifests must be untouched on a rejected arg');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('transaction preserves unrelated exact bytes and modes, including nested and escaped keys', () => {
  const root = makeFixture();
  try {
    const texts = [
      '{\r\n\t"nested": {"version":"99.0.0"}, "ver\\u0073ion" : "1.2.3", "name":"demo"\r\n}\r\n',
      '{ "name": "demo", "version" : "1.2.3", "note": "\\u0061" }',
      '{"version":"1.2.3", "name":"demo"}\n',
    ];
    manifestPaths.forEach((rel, index) => {
      writeFileSync(join(root, rel), texts[index]);
      chmodSync(join(root, rel), [0o640, 0o600, 0o644][index]);
    });
    const before = manifestSnapshot(root);
    applyBump(root, 'patch');
    const after = manifestSnapshot(root);
    after.forEach((entry, index) => {
      assert.equal(entry.text, before[index].text.replace('"1.2.3"', '"1.2.4"'));
      assert.equal(entry.mode, before[index].mode);
    });
    assert.equal(existsSync(join(root, transactionFile)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('transaction requires one initial version and rejects duplicate top-level version keys before writes', () => {
  for (const kind of ['drift', 'duplicate']) {
    const root = makeFixture({ codexPluginVersion: kind === 'drift' ? '1.2.4' : '1.2.3' });
    try {
      if (kind === 'duplicate') writeFileSync(join(root, 'package.json'), '{"version":"1.2.3","ver\\u0073ion":"1.2.3"}');
      const before = manifestSnapshot(root);
      assert.throws(() => applyBump(root, 'patch'), /drift|duplicate|version/);
      assert.deepEqual(manifestSnapshot(root), before);
      assert.equal(existsSync(join(root, transactionFile)), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('transaction publishes only after every target is durably staged and validates before each rename', () => {
  const root = makeFixture();
  try {
    const staged = new Set();
    applyBump(root, 'patch', { checkpoint(event) {
      if (event.phase === 'stage-durable') staged.add(event.index);
      if (event.phase === 'before-publish') {
        assert.equal(staged.size, 3);
        assert.equal(checkVersions(root).ok, false, 'pending transaction blocks release checks');
        assert.deepEqual(manifestPaths.map((rel) => readVersion(root, rel)),
          manifestPaths.map((_, index) => index < event.index ? '1.2.4' : '1.2.3'));
      }
    } });
    assert.equal(staged.size, 3, 'staging checkpoints were actually reached');
    assert.equal(checkVersions(root).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('transaction retries thrown staging/publication faults against the same durable target', () => {
  for (const phase of ['journal-durable', 'stage-opened', 'stage-durable', 'before-publish', 'after-publish', 'before-complete']) {
    const indices = ['journal-durable', 'before-complete'].includes(phase) ? [-1] : [0, 1, 2];
    for (const index of indices) {
      const root = makeFixture();
      try {
        assert.throws(() => applyBump(root, 'patch', { checkpoint(event) {
          if (event.phase === phase && (event.index ?? -1) === index) throw new Error('injected fault');
        } }), /injected fault/, `${phase}:${index}`);
        assert.equal(existsSync(join(root, transactionFile)), true);
        assert.equal(checkVersions(root).ok, false);
        applyBump(root, 'patch');
        assert.deepEqual(manifestPaths.map((rel) => readVersion(root, rel)), ['1.2.4', '1.2.4', '1.2.4']);
        assert.equal(checkVersions(root).ok, true);
        const finished = manifestSnapshot(root);
        applyBump(root, '1.2.4');
        assert.deepEqual(manifestSnapshot(root), finished, 'explicit completed target is a manifest-write-free no-op');
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }
});

test('transaction survives real process exits at every staging and publication boundary', () => {
  for (const phase of ['journal-durable', 'stage-opened', 'stage-durable', 'before-publish', 'after-publish', 'before-complete']) {
    const indices = ['journal-durable', 'before-complete'].includes(phase) ? [-1] : [0, 1, 2];
    for (const index of indices) {
      const root = makeFixture();
      try {
        const result = crashBump(root, phase, index);
        assert.equal(result.status, 71, `${phase}:${index}: ${result.stderr}`);
        assert.equal(checkVersions(root).ok, false);
        assert.throws(() => applyBump(root, 'minor'), /pending|target/);
        applyBump(root, 'patch');
        assert.deepEqual(manifestPaths.map((rel) => readVersion(root, rel)), ['1.2.4', '1.2.4', '1.2.4']);
        assert.equal(checkVersions(root).ok, true);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }
});

test('transaction recovery never overwrites unexpected published, unpublished or mode edits', () => {
  for (const changed of [0, 1, 2]) {
    const root = makeFixture();
    try {
      assert.equal(crashBump(root, 'after-publish', 0).status, 71);
      const path = join(root, manifestPaths[changed]);
      if (changed === 2) chmodSync(path, (statSync(path).mode & 0o777) ^ 0o100);
      else writeFileSync(path, readFileSync(path, 'utf8').replace('"demo"', '"user-edit"'));
      const before = manifestSnapshot(root);
      assert.throws(() => applyBump(root, 'patch'), /changed|conflict|unexpected/);
      assert.deepEqual(manifestSnapshot(root), before);
      assert.equal(existsSync(join(root, transactionFile)), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('transaction revalidates later targets before publishing any file after a checkpoint edit', () => {
  const root = makeFixture();
  try {
    const before = manifestSnapshot(root);
    assert.throws(() => applyBump(root, 'patch', { checkpoint(event) {
      if (event.phase === 'before-publish' && event.index === 0) {
        writeFileSync(join(root, manifestPaths[2]), '{"version":"1.2.3","user":true}');
      }
    } }), /changed|conflict|unexpected/);
    assert.equal(readFileSync(join(root, manifestPaths[0]), 'utf8'), before[0].text);
    assert.equal(readFileSync(join(root, manifestPaths[1]), 'utf8'), before[1].text);
    assert.equal(JSON.parse(readFileSync(join(root, manifestPaths[2]), 'utf8')).user, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('transaction refuses symlink and hardlink manifests without modifying their targets', () => {
  for (const link of [symlinkSync, linkSync]) {
    const root = makeFixture();
    try {
      const target = join(root, 'sentinel.json');
      const text = '{"version":"1.2.3"}';
      writeFileSync(target, text);
      unlinkSync(join(root, manifestPaths[2]));
      link(target, join(root, manifestPaths[2]));
      assert.throws(() => applyBump(root, 'patch'), /ordinary|link|physical/);
      assert.equal(readFileSync(target, 'utf8'), text);
      assert.equal(readVersion(root, manifestPaths[0]), '1.2.3');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('transaction pins its durable journal before checkpoint code can unexpectedly edit it', () => {
  const root = makeFixture();
  try {
    const before = manifestSnapshot(root);
    assert.throws(() => applyBump(root, 'patch', { checkpoint(event) {
      if (event.phase === 'journal-durable') {
        const path = join(root, transactionFile);
        const journal = JSON.parse(readFileSync(path, 'utf8'));
        journal.target = '9.9.9';
        writeFileSync(path, JSON.stringify(journal));
      }
    } }), /changed|conflict|unexpected/);
    assert.deepEqual(manifestSnapshot(root), before);
    assert.equal(JSON.parse(readFileSync(join(root, transactionFile), 'utf8')).target, '9.9.9');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('main --check names incomplete recovery even when all published versions already match', () => {
  const root = makeFixture();
  try {
    assert.equal(crashBump(root, 'before-complete').status, 71);
    assert.deepEqual(manifestPaths.map((rel) => readVersion(root, rel)), ['1.2.4', '1.2.4', '1.2.4']);
    const result = captureMain(['--check'], root);
    assert.equal(result.code, 1);
    assert.match(result.err, /incomplete.*transaction/i);
    applyBump(root, '1.2.4');
    assert.equal(captureMain(['--check'], root).code, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('transaction recovers an exact partial staging prefix but preserves unexpected stage edits', () => {
  for (const validPrefix of [true, false]) {
    const root = makeFixture();
    try {
      let stage;
      let staged;
      assert.throws(() => applyBump(root, 'patch', { checkpoint(event) {
        if (event.phase === 'stage-opened' && event.index === 0) {
          const journal = JSON.parse(readFileSync(join(root, transactionFile), 'utf8'));
          stage = join(root, '.steepy-version-' + journal.id + '-0.tmp');
          const bytes = Buffer.from(journal.manifests[0].after, 'base64');
          staged = validPrefix ? bytes.subarray(0, 17) : Buffer.from('unexpected user stage edit');
          writeFileSync(stage, staged);
          throw new Error('partial stage fault');
        }
      } }), /partial stage fault/);
      if (validPrefix) {
        applyBump(root, 'patch');
        assert.equal(checkVersions(root).ok, true);
      } else {
        assert.throws(() => applyBump(root, 'patch'), /unexpected.*changed/);
        assert.deepEqual(readFileSync(stage), staged);
        assert.deepEqual(manifestPaths.map((rel) => readVersion(root, rel)), ['1.2.3', '1.2.3', '1.2.3']);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('transaction excludes a concurrent cooperating bump under the shared repository lease', () => {
  const root = makeFixture();
  try {
    let checked = false;
    applyBump(root, 'patch', { checkpoint(event) {
      if (event.phase !== 'before-publish' || event.index !== 0) return;
      checked = true;
      const before = manifestSnapshot(root);
      const other = spawnSync(process.execPath, ['--input-type=module', '-e',
        'import { applyBump } from ' + JSON.stringify(bumpModule) + '; applyBump(process.argv[1], "patch");', root],
      { encoding: 'utf8' });
      assert.equal(other.status, 1);
      assert.match(other.stderr, /lock.*live owner/);
      assert.deepEqual(manifestSnapshot(root), before);
    } });
    assert.equal(checked, true);
    assert.equal(checkVersions(root).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('transaction removes validated redundant stages when a target already has the exact intended bytes', () => {
  const root = makeFixture();
  try {
    let completedMtime;
    applyBump(root, 'patch', { checkpoint(event) {
      if (event.phase === 'before-publish' && event.index === 0) {
        const journal = JSON.parse(readFileSync(join(root, transactionFile), 'utf8'));
        writeFileSync(join(root, manifestPaths[2]), Buffer.from(journal.manifests[2].after, 'base64'));
        completedMtime = statSync(join(root, manifestPaths[2])).mtimeMs;
      }
    } });
    assert.equal(statSync(join(root, manifestPaths[2])).mtimeMs, completedMtime);
    for (const directory of [root, join(root, '.claude-plugin'), join(root, '.codex-plugin')]) {
      assert.equal(readdirSync(directory).some((name) => name.startsWith('.steepy-version-')), false);
    }
    assert.equal(checkVersions(root).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('version documentation distinguishes recoverable per-file publication, retry and strict numeric policy', () => {
  for (const relative of ['../RELEASE.md', '../docs/architecture.md', '../.apex/standards/scripts.md']) {
    const text = readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\s+/g, ' ');
    assert.match(text, /recoverable per-file atomicity/i, relative);
    assert.match(text, /same target/i, relative);
    assert.match(text, /unexpected.*(?:bytes|edits|changes)/i, relative);
  }
  const release = readFileSync(new URL('../RELEASE.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.match(release, /\.steepy-version-transaction\.json/);
  assert.match(release, /explicit.*target.*no-op/i);
  assert.match(release, /safe.integer.*X\.Y\.Z|X\.Y\.Z.*safe.integer/i);
  assert.match(release, /no-release.*validity/i);
});

test('transaction recovery rejects malformed journal identity, paths and target evidence unchanged', () => {
  const mutations = [
    (journal) => { journal.id += '\n'; },
    (journal) => { journal.id = ['a'.repeat(32)]; },
    (journal) => { journal.manifests[0].rel = '../outside.json'; },
    (journal) => { journal.manifests[0].mode = -1; },
    (journal) => { journal.target = '01.2.4'; },
    (journal) => { journal.manifests[0].after = Buffer.from('{"version":"9.9.9"}').toString('base64'); },
    (journal) => { journal.extra = true; },
  ];
  for (const mutate of mutations) {
    const root = makeFixture();
    try {
      assert.equal(crashBump(root, 'journal-durable').status, 71);
      const path = join(root, transactionFile);
      const journal = JSON.parse(readFileSync(path, 'utf8'));
      mutate(journal);
      const edited = JSON.stringify(journal);
      writeFileSync(path, edited);
      const before = manifestSnapshot(root);
      assert.throws(() => applyBump(root, 'patch'), /invalid|pending/);
      assert.deepEqual(manifestSnapshot(root), before);
      assert.equal(readFileSync(path, 'utf8'), edited);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

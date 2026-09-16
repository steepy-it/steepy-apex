import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as bumpVersionMain } from '../scripts/bump-version.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const workflowCommands = [
  'init',
  'new-surface',
  'check',
  'brainstorm',
  'plan',
  'implement',
  'review',
];
const namespacedWorkflowCommands = workflowCommands.map((command) => `/steepy-apex:${command}`);

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
}

function assertNoGenericOwnerToken(value, label) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.doesNotMatch(text, /<owner>/, `${label} must not contain generic owner token`);
}

function assertNoBareWorkflowInvocations(text, label) {
  const commandAlternation = workflowCommands.join('|');
  const bareInvocation = new RegExp(`(^|[^\\w:.-])/(${commandAlternation})\\b`, 'm');
  assert.doesNotMatch(text, bareInvocation, `${label} must namespace public workflow slash commands`);
}

function assertIncludesNamespacedWorkflow(text, label) {
  for (const command of namespacedWorkflowCommands) {
    assert.ok(text.includes(command), `${label} must mention ${command}`);
  }
}

test('release identity uses steepy-apex and steepy-it consistently', () => {
  const pkg = readJson('package.json');
  const plugin = readJson('.claude-plugin/plugin.json');
  const marketplace = readJson('.claude-plugin/marketplace.json');
  const codexPlugin = readJson('.codex-plugin/plugin.json');

  assert.equal(pkg.name, 'steepy-apex');
  assert.equal(pkg.author.name, 'steepy-it');
  assert.equal(plugin.name, 'steepy-apex');
  assert.equal(plugin.author.name, 'steepy-it');
  assert.equal(marketplace.name, 'steepy-apex');
  assert.equal(marketplace.owner.name, 'steepy-it');
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, 'steepy-apex');
  assert.equal(marketplace.plugins[0].source, './');
  assert.equal(codexPlugin.name, 'steepy-apex');

  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.private, false);
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.engines.node, '>=24');
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
  assert.equal(plugin.version, pkg.version);
  assert.match(codexPlugin.version, /^\d+\.\d+\.\d+$/);
  assert.equal(codexPlugin.version, pkg.version);

  assertNoGenericOwnerToken(pkg, 'package.json');
  assertNoGenericOwnerToken(plugin, '.claude-plugin/plugin.json');
  assertNoGenericOwnerToken(marketplace, '.claude-plugin/marketplace.json');
  assertNoGenericOwnerToken(codexPlugin, '.codex-plugin/plugin.json');
});

test('CI covers the supported Node 24 floor without older runtimes', () => {
  const workflow = [
    readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8'),
    readFileSync(join(root, '.github', 'workflows', 'validate.yml'), 'utf8'),
  ].join('\n');

  assert.match(workflow, /node-version:\s*\['24'\]/);
  assert.doesNotMatch(workflow, /node-version:\s*\[[^\]]*'20'/);
});

test('user-facing docs advertise the supported Node 24 runtime floor', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const contributing = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8');

  assert.match(readme, /alt="node ≥ 24"/);
  assert.match(readme, /shields\.io\/badge\/node-%E2%89%A5%2024-/);
  assert.match(readme, /\*\*Node\.js >= 24\*\*/);
  assert.match(contributing, /You need Node\.js >= 24\./);
  assert.doesNotMatch(readme, /node(?:\.js)?(?:%20|\s)+(?:%E2%89%A5|≥|>=)(?:%20|\s)*20/i);
  assert.doesNotMatch(contributing, /Node(?:\.js)?\s+(?:≥|>=)\s*20/i);
});

test('public safety copy uses a command-family effects matrix and current native inventory', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const security = readFileSync(join(root, 'SECURITY.md'), 'utf8');
  const community = readFileSync(join(root, 'COMMUNITY_SUBMISSION.md'), 'utf8');
  const contributing = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8');

  for (const text of [readme, security, community, contributing]) {
    assert.match(text, /Command-family effects matrix/i);
    assert.match(text, /filesystem\s+reads[–-]writes[–-]subprocesses[–-]temporary\s+state[–-]providers\/network/i);
  }
  assert.match(community, /nine canonical skills/i);
  assert.match(community, /loop-engineer/i);
  assert.match(community, /five native harnesses/i);
  assert.doesNotMatch(community, /Codex adapters are separate future work/i);
});

test('scripts/bump-version.mjs bumps package.json, .claude-plugin/plugin.json, and .codex-plugin/plugin.json in lockstep (three-way)', () => {
  // Mirrors tests/bump-version.test.mjs's temp-copy fixture pattern, extended with the
  // third manifest. This is the suite that actually falsifies bump-version's write
  // behavior: the static identity assert above only locks the CURRENT repo state
  // (already 0.5.0 everywhere since T6), so it can't catch a bump script that forgets
  // to write .codex-plugin/plugin.json.
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'steepy-release-metadata-bump-'));
  try {
    writeFileSync(
      join(fixtureRoot, 'package.json'),
      JSON.stringify({ name: 'demo', version: '1.2.3' }, null, 2) + '\n',
    );
    mkdirSync(join(fixtureRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(fixtureRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.2.3' }, null, 2) + '\n',
    );
    mkdirSync(join(fixtureRoot, '.codex-plugin'), { recursive: true });
    writeFileSync(
      join(fixtureRoot, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.2.3' }, null, 2) + '\n',
    );

    const origLog = console.log;
    console.log = () => {};
    let code;
    try {
      code = bumpVersionMain(['patch'], fixtureRoot);
    } finally {
      console.log = origLog;
    }
    assert.equal(code, 0);

    for (const rel of ['package.json', join('.claude-plugin', 'plugin.json'), join('.codex-plugin', 'plugin.json')]) {
      const version = JSON.parse(readFileSync(join(fixtureRoot, rel), 'utf8')).version;
      assert.equal(version, '1.2.4', `${rel} must be bumped by scripts/bump-version.mjs`);
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('npm package uses an explicit release files allowlist', () => {
  const pkg = readJson('package.json');

  assert.deepEqual(pkg.files, [
    '.agents/',
    '.claude-plugin/',
    '.codex-plugin/',
    'adapters/',
    'assets/',
    'docs/',
    'hooks/',
    'scripts/',
    'skills/',
    'templates/',
    'README.md',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'LICENSE',
    'NOTICE',
    'RELEASE.md',
    'cordis.patch.yml',
  ]);

  const filesText = pkg.files.join('\n');
  for (const localOnly of [
    '.superpowers',
    '.claude/settings.local.json',
    '.apex/work',
    'tests/',
    '.worktrees',
  ]) {
    assert.doesNotMatch(filesText, new RegExp(localOnly.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('package.json exports a dsh adapter subpath, and cordis.patch.yml row uses the matching package specifier (not a profile-relative path)', () => {
  // Regression guard for C1: a `.`-relative `name` in cordis.patch.yml resolves against
  // the profile directory when this file is loaded as a composed BUNDLE patch layer
  // (not the package root, which only holds for the profile's own file-backed
  // cordis.patch.yml). The fix is a package-specifier row backed by an explicit exports
  // subpath, so the two files must move together — assert both halves here.
  const pkg = readJson('package.json');
  const dshExportKey = Object.keys(pkg.exports).find((key) => key !== '.');

  assert.ok(dshExportKey, 'package.json exports must declare a dsh adapter subpath alongside "."');
  assert.equal(
    pkg.exports[dshExportKey],
    './adapters/dsh/steepy-apex.js',
    `package.json exports["${dshExportKey}"] must map to ./adapters/dsh/steepy-apex.js`,
  );
  assert.equal(
    pkg.exports['.'],
    './adapters/opencode/steepy-apex.js',
    'package.json exports must keep "." pointing at the OpenCode adapter',
  );

  const expectedSpecifier = `${pkg.name}${dshExportKey.slice(1)}`;
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');

  assert.doesNotMatch(
    patch,
    /name:\s*\.\//,
    'cordis.patch.yml row name must not be a `.`-relative specifier: a bundle patch layer composed ' +
      'into a profile resolves relative names against the profile directory, not the package root',
  );
  assert.match(
    patch,
    new RegExp(`name:\\s*${expectedSpecifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
    `cordis.patch.yml row name must be the package specifier "${expectedSpecifier}" matching the exports subpath key`,
  );
});

test('npm dry-run package excludes local development state', () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'steepy-npm-cache-'));
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  try {
    const result = spawnSync(
      npmBin,
      ['--cache', cacheDir, 'pack', '--dry-run', '--json'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const [pack] = JSON.parse(result.stdout);
    const paths = pack.files.map((file) => file.path);

    for (const required of [
      '.claude-plugin/plugin.json',
      'docs/workflow.md',
      'docs/architecture.md',
      'hooks/hooks.json',
      'scripts/validate-hub.mjs',
      'skills/init/SKILL.md',
      'templates/_INDEX.md',
      'package.json',
      'README.md',
      'CHANGELOG.md',
      'CONTRIBUTING.md',
      'SECURITY.md',
      'docs/installation.md',
      'LICENSE',
    ]) {
      assert.ok(paths.includes(required), `package must include ${required}`);
    }

    for (const path of paths) {
      assert.ok(!path.startsWith('.superpowers/'), `package must not include ${path}`);
      assert.ok(!path.startsWith('.claude/'), `package must not include ${path}`);
      assert.ok(!path.startsWith('.apex/work/'), `package must not include ${path}`);
      assert.ok(!path.startsWith('tests/'), `package must not include ${path}`);
      assert.ok(!path.startsWith('.worktrees/'), `package must not include ${path}`);
    }
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('README and linked guides document install paths and release safety notes', () => {
  const readme = ['README.md', 'docs/installation.md', 'RELEASE.md', 'docs/architecture.md']
    .map((path) => readFileSync(join(root, path), 'utf8')).join('\n');

  assert.match(readme, /\/plugin marketplace add steepy-it\/steepy-apex/);
  assert.match(readme, /\/plugin install steepy-apex@steepy-apex/);
  assert.match(readme, /\/plugin install steepy-apex@claude-community/);
  assert.doesNotMatch(readme, /<owner>\/steepy/);
  assert.doesNotMatch(readme, /steepy@steepy/);
  assert.doesNotMatch(readme, /Initialize steepy in your repo\./);
  assert.match(readme, /Initialize steepy-apex in your repo\./);
  assertIncludesNamespacedWorkflow(readme, 'README');
  assertNoBareWorkflowInvocations(readme, 'README');

  for (const required of [
    'Command-family effects matrix',
    'zero third-party runtime dependencies',
    'init` writes `.apex/` governance files',
    'review plugin hooks',
  ]) {
    assert.ok(readme.includes(required), `README must mention: ${required}`);
  }
});

test('README pins the local .apex/work contract and drops stale stable-hub workflow claims', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');

  assert.match(
    readme,
    /the local `\.apex\/work\/` area for gitignored specs\/plans/,
    'README quick start must promise the local .apex/work area for gitignored specs/plans',
  );
  assert.match(
    readme,
    /\/steepy-apex:init` - Initialize steepy-apex in your repo\.[\s\S]{0,250}the local `\.apex\/work\/` area for gitignored specs\/plans/,
    'README quick start must tie init to the local .apex/work gitignored specs/plans promise',
  );

  for (const required of [
    '.apex/work/',
    'gitignored',
    'local work artifact',
  ]) {
    assert.ok(readme.includes(required), `README must mention: ${required}`);
  }

  assert.doesNotMatch(readme, /specs, plans, and code all flow \*through\* the hub/i);
  assert.doesNotMatch(readme, /writes governed artifacts into the hub/i);
  assert.doesNotMatch(readme, /hub-governed spec/i);
  assert.doesNotMatch(readme, /verified \*through\* the hub/i);
});

test('RELEASE.md documents validation, smoke test, release, and rollback steps', () => {
  const release = readFileSync(join(root, 'RELEASE.md'), 'utf8');

  for (const required of [
    'steepy-it',
    'steepy-it/steepy-apex',
    'steepy-apex@claude-community',
    'claude plugin validate .',
    '/plugin validate .',
    '/plugin marketplace add /path/to/steepy-apex',
    '/plugin install steepy-apex@steepy-apex',
    'claude --plugin-dir .',
    '/steepy-apex:init',
    '/steepy-apex:check',
    'scripts/bump-version.mjs',
    '.github/workflows/release.yml',
    'Rollback',
    'docs/release-evidence.md',
    '`.codex-plugin/plugin.json` in three-way lockstep',
  ]) {
    assert.ok(release.includes(required), `RELEASE.md must mention: ${required}`);
  }
  assertIncludesNamespacedWorkflow(release, 'RELEASE.md');
  assertNoBareWorkflowInvocations(release, 'RELEASE.md');

  assert.match(release, /Claude Code community\/public distribution/);
  assert.doesNotMatch(release, /official Anthropic/i);
  assert.doesNotMatch(release, /<owner>/);
  assert.doesNotMatch(release, /steepy@steepy/);
});

test('release evidence reference documents the optional release audit verification and release independence', () => {
  const release = readFileSync(join(root, 'docs/release-evidence.md'), 'utf8');

  for (const required of [
    'scripts/validate-release-evidence.mjs',
    'docs/native-test-evidence.json',
    'docs/native-test-evidence.md',
    'plugin-preflight',
    'Claude Code',
    'Codex',
    'OpenCode',
    'Pi',
    'DeepSeek Harness',
    'native-specialist-dispatch',
    'evidence-only commit',
    'it does not block publication',
  ]) {
    assert.ok(release.includes(required), `RELEASE.md must mention: ${required}`);
  }
  assert.match(release, /30 days/);
  assert.match(release, /schema validates documented records[\s\S]*does not prove/i);
});

test('architecture release-evidence inventory matches the validator closed exclusion set', () => {
  const validator = readFileSync(join(root, 'scripts', 'validate-release-evidence.mjs'), 'utf8');
  const setMatch = validator.match(/const EXCLUDED_EVIDENCE_PATHS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(setMatch, 'validator must declare its closed evidence-only exclusion set');
  const identifiers = [...setMatch[1].matchAll(/\b(EVIDENCE_[A-Z_]+_PATH)\b/g)]
    .map((match) => match[1]);
  const constants = new Map(
    [...validator.matchAll(/export const (EVIDENCE_[A-Z_]+_PATH) = '([^']+)';/g)]
      .map((match) => [match[1], match[2]]),
  );
  const excludedPaths = identifiers.map((identifier) => constants.get(identifier));
  assert.ok(excludedPaths.every(Boolean), 'each exclusion-set identifier must name an exported path');

  const architecture = readFileSync(join(root, 'docs', 'architecture.md'), 'utf8');
  const row = architecture.match(/^\| `validate-release-evidence\.mjs` \| ([^\n]+) \|$/m);
  assert.ok(row, 'architecture must inventory validate-release-evidence.mjs');
  const documentedPaths = [...row[1].matchAll(/`(docs\/[^`]+)`/g)].map((match) => match[1]);
  assert.deepEqual(
    documentedPaths,
    excludedPaths,
    'architecture inventory must name exactly the validator closed evidence-only exclusion set',
  );
  assert.match(row[1], /no documentation directory or path family is excluded/i);
});

test('RELEASE.md smoke test uses local gitignored apex work artifacts', () => {
  const release = readFileSync(join(root, 'RELEASE.md'), 'utf8');

  for (const required of [
    '.apex/work/.gitignore',
    '.apex/work/specs/',
    '.apex/work/plans/',
  ]) {
    assert.ok(release.includes(required), `RELEASE.md smoke test must mention: ${required}`);
  }

  assert.doesNotMatch(release, /\.apex\/specs\/_INDEX\.md/);
  assert.doesNotMatch(release, /\.apex\/plans\/_INDEX\.md/);
});

test('Installation guide documents native five-harness install journeys', () => {
  const readme = readFileSync(join(root, 'docs/installation.md'), 'utf8');

  for (const heading of ['### Claude Code', '### Codex', '### OpenCode', '### Pi', '### DeepSeek Harness']) {
    assert.ok(readme.includes(heading), `Installation guide must have a "${heading}" installation heading`);
  }

  for (const required of [
    'codex plugin marketplace add steepy-it/steepy-apex',
    'steepy-apex@git+https://github.com/steepy-it/steepy-apex.git#vX.Y.Z',
    'pi install git:github.com/steepy-it/steepy-apex@vX.Y.Z',
    'the package is not published yet',
  ]) {
    assert.ok(readme.includes(required), `Installation guide must mention: ${required}`);
  }

  assert.doesNotMatch(
    readme,
    /steepy-apex is a \[Claude Code\]\(https:\/\/docs\.claude\.com\/en\/docs\/claude-code\) plugin, installed through a marketplace\./,
    'Installation guide must not frame steepy-apex as a Claude-Code-only plugin installed through a marketplace',
  );
});

test('docs/architecture.md documents the adapters surface and multi-harness test suites', () => {
  const architecture = readFileSync(join(root, 'docs', 'architecture.md'), 'utf8');

  assert.ok(
    architecture.includes('## `adapters/` — the harness adapters'),
    'docs/architecture.md must have the adapters section heading',
  );

  for (const required of [
    '`.claude-plugin/` manifest + marketplace — the pre-existing plugin, unchanged behavior.',
    '`.codex-plugin/plugin.json` (points at `skills/` and `hooks/hooks-codex.json`)',
    '`adapters/opencode/steepy-apex.js` — a config hook pushes `skills/` into `config.skills.paths`',
    '`adapters/model-mappings.mjs` (the provider-keyed tier tables with per-row provenance)',
    '`adapters/pi/steepy-apex.js` — `session_start` bootstrap injection',
    '`adapters/dsh/steepy-apex.js`, wired via the root `cordis.patch.yml`',
    '**Multi-harness:** `portability-contract`',
    '`canary-structural` (isolated-HOME, env-scrubbed engine runs through literal skill-relative paths)',
    '`npm-pack` (the tarball carries every manifest, adapter, skill, and script)',
  ]) {
    assert.ok(architecture.includes(required), `docs/architecture.md must mention: ${required}`);
  }

  assert.doesNotMatch(
    architecture,
    /is a Claude Code plugin with \*\*zero runtime dependencies\*\*/,
    'docs/architecture.md must not frame steepy-apex as Claude-Code-only',
  );
});

test('docs/architecture.md tabulates every scripts/*.mjs engine exactly once', () => {
  const architecture = readFileSync(join(root, 'docs', 'architecture.md'), 'utf8');
  const heading = '## `scripts/` — the engine';
  const sectionStart = architecture.indexOf(heading);
  assert.notEqual(sectionStart, -1, 'docs/architecture.md must have the scripts section heading');
  const sectionEnd = architecture.indexOf('\n## ', sectionStart + heading.length);
  const section = architecture.slice(sectionStart, sectionEnd === -1 ? undefined : sectionEnd);
  const documented = [...section.matchAll(/^\| `([^`]+\.mjs)` \|/gmu)]
    .map((match) => match[1]);
  const actual = readdirSync(join(root, 'scripts'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => entry.name)
    .sort();

  assert.equal(
    new Set(documented).size,
    documented.length,
    'each scripts/*.mjs engine must appear exactly once in the architecture table',
  );
  assert.deepEqual(
    documented.toSorted(),
    actual,
    'the architecture table must match the complete scripts/*.mjs inventory',
  );
});

test('public docs describe the implemented deterministic Gear-4 controller boundary', () => {
  const architecture = readFileSync(join(root, 'docs', 'architecture.md'), 'utf8');
  const workflow = readFileSync(join(root, 'docs', 'workflow.md'), 'utf8');
  const readme = readFileSync(join(root, 'README.md'), 'utf8');

  for (const script of ['workflow-state.mjs', 'loop-engineer.mjs']) {
    assert.ok(
      architecture.includes(`| \`${script}\` |`),
      `docs/architecture.md must tabulate ${script}`,
    );
  }
  assert.match(
    architecture,
    /events\.jsonl[\s\S]*authoritative[\s\S]*ledger\.md[\s\S]*projection/i,
    'architecture must show events as authority and the ledger as a projection',
  );
  assert.match(
    architecture,
    /ATTEMPT_RESERVED[\s\S]*before[\s\S]*(?:runner|side effect|mutation)/i,
    'architecture must place durable reservation before an attempt runner or mutation',
  );
  assert.match(
    architecture,
    /work-paths\.mjs[^\n]*`spec \| goal \| criteria \| work-output`/i,
    'architecture must carry the implementation work-type order exactly',
  );

  const gear4 = workflow.match(/## Gear 4: Loop Engineer([\s\S]*?)(?=\n## |$)/)?.[1];
  assert.ok(gear4, 'docs/workflow.md must have a Gear 4 section');
  assert.match(gear4, /terminal controller/i);
  assert.match(gear4, /commit\s+authorization[\s\S]*mandatory|mandatory[\s\S]*commit\s+authorization/i);
  for (const outcome of ['GOAL_REACHED', 'BUDGET_EXHAUSTED', 'NO_IMPROVEMENT', 'REVIEW_REJECTED']) {
    assert.ok(gear4.includes(`\`${outcome}\``), `Gear 4 must define ${outcome}`);
  }
  assert.match(
    gear4,
    /every clean (?:terminal )?(?:result|outcome)[\s\S]*branch reviewed[\s\S]*not necessarily[\s\S]*branch-review approved/i,
  );
  assert.match(
    gear4,
    /`REVIEW_REJECTED`[\s\S]*exhausted[\s\S]*goal-acceptable[\s\S]*(?:boolean[^]*green|metric[^]*strict improvement)[\s\S]*unresolved issues/i,
  );
  assert.match(
    gear4,
    /terminal-review approval[\s\S]*(?:distinct|separate)[\s\S]*controller(?:'s)? branch-review verdict/i,
  );
  assert.match(gear4, /crash-safe resume/i);
  assert.match(gear4, /Claude[\s\S]*Codex[\s\S]*OpenCode/);
  assert.match(gear4, /Pi[\s\S]*DeepSeek[\s\S]*`runner-unavailable`/i);
  assert.match(gear4, /fake-runner[\s\S]*not[\s\S]*five-provider LIVE|five-provider LIVE[\s\S]*not[\s\S]*fake-runner/i);
  assert.match(gear4, /APEX-P1-04[\s\S]*open/i);

  assert.match(
    readme,
    /bounded autonomous loop/i,
  );
  assert.match(gear4, /four outcomes/i);
  assert.match(readme, /Claude, Codex, and OpenCode[\s\S]*Pi and DeepSeek[\s\S]*runner-unavailable/i);
  const workflowSummary = readFileSync(join(root, 'docs/workflow.md'), 'utf8');
  const workflowGear4 = workflowSummary.match(/^- \*\*Gear-4 terminal controller\*\* — ([^\n]+)$/mu)?.[1];
  assert.ok(workflowGear4, 'Workflow guide must retain the Gear-4 capability and evidence summary');
  assert.match(workflowGear4, /fake-runner[\s\S]*runtime-only evidence/i);
  assert.match(workflowGear4, /five-provider LIVE[\s\S]*APEX-P1-04[\s\S]*remains open/i);
});

test('CHANGELOG.md carries a heading for the current plugin.json version', () => {
  const plugin = readJson('.claude-plugin/plugin.json');
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');

  const escapedVersion = plugin.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(
    changelog,
    new RegExp(`## v${escapedVersion} \\(`),
    `CHANGELOG.md must have a "## v${plugin.version} (" heading for the current plugin.json version`,
  );
});

test('COMMUNITY_SUBMISSION.md contains marketplace review copy and safety disclosure', () => {
  const submission = readFileSync(join(root, 'COMMUNITY_SUBMISSION.md'), 'utf8');

  for (const required of [
    'steepy-apex',
    'steepy-it',
    'Your AI documentation stops rotting',
    'https://claude.ai/admin-settings/directory/submissions/plugins/new',
    'https://platform.claude.com/plugins/submit',
    'five native harnesses',
    'Command-family effects matrix',
    'zero third-party runtime dependencies',
    'Stop hook',
    'Apache-2.0',
  ]) {
    assert.ok(submission.includes(required), `COMMUNITY_SUBMISSION.md must mention: ${required}`);
  }

  assert.doesNotMatch(submission, /official Anthropic/i);
  assert.doesNotMatch(submission, /<owner>/);
  assertIncludesNamespacedWorkflow(submission, 'COMMUNITY_SUBMISSION.md');
  assertNoBareWorkflowInvocations(submission, 'COMMUNITY_SUBMISSION.md');
});

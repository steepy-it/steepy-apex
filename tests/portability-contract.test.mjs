// Portability-contract lock suite for the canonical `skills/` core.
//
// Locks the "shared canonical core + native adapters" contract from
// .apex/conventions.md ("Multi-harness distribution"): the skills tree must
// stay free of Claude-specific env-var references and absolute-path
// literals, every SKILL.md must declare the frontmatter a native adapter
// needs to register the skill, and every skill's engine-root resolution
// must land on the same scripts/ directory.
//
// NOTE — deliberately red at this task's commit (T2 of the
// native-multi-harness-plugins plan): lock (a) fails today because
// CLAUDE_PLUGIN_ROOT still appears in 8 SKILL.md files. It turns green only
// after tasks T3-T5 neutralize the skills. Locks (b), (c), (d) pass today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const skillsDir = join(root, 'skills');
const templatesDir = join(root, 'templates');

const portableV1Templates = [
  'AGENTS.md',
  'claude-import.md',
  'project-bootstrap-skill.md',
  'claude-bootstrap-stub.md',
  'surface-agent-claude.md',
  'surface-agent-codex.toml',
  'surface-agent-opencode.md',
];

// Mirrors scripts/validate-hub.mjs's own `walk` helper: a deliberately explicit
// recursive directory walk over Node built-ins only.
function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

function skillDirNames() {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

test('lock (a): zero CLAUDE_ references under skills/** (canonical core must be harness-neutral)', () => {
  const offenders = [];
  let total = 0;
  for (const file of walk(skillsDir)) {
    const text = readFileSync(file, 'utf8');
    const matches = text.match(/CLAUDE_/g);
    if (matches) {
      offenders.push(`${relative(root, file)}: ${matches.length}`);
      total += matches.length;
    }
  }
  assert.equal(
    total,
    0,
    `skills/** must contain zero CLAUDE_* references — the canonical core is shared ` +
      `across Claude Code, Codex, OpenCode, Pi, and DeepSeek Harness (.apex/conventions.md, ` +
      `"Multi-harness distribution"); found ${total} occurrence(s) across ${offenders.length} file(s):\n` +
      offenders.join('\n')
  );
});

test('lock (b): every skills/*/SKILL.md declares non-empty name + description frontmatter', () => {
  const offenders = [];
  for (const name of skillDirNames()) {
    const path = join(skillsDir, name, 'SKILL.md');
    if (!existsSync(path)) {
      offenders.push(`${name}/SKILL.md: file missing`);
      continue;
    }
    const text = readFileSync(path, 'utf8');
    const fm = parseFrontmatter(text);
    if (!fm) {
      offenders.push(`${name}/SKILL.md: no --- frontmatter block found`);
      continue;
    }
    if (!fm.name) offenders.push(`${name}/SKILL.md: missing or empty 'name' key`);
    if (!fm.description) offenders.push(`${name}/SKILL.md: missing or empty 'description' key`);
  }
  assert.deepEqual(
    offenders,
    [],
    `every skills/*/SKILL.md must declare explicit non-empty name + description ` +
      `frontmatter (a native adapter reads these to register the skill); violations:\n` +
      offenders.join('\n')
  );
});

test('lock (c): every skill\'s engine-root resolution (skills/<name>/../../scripts/) reaches scripts/validate-hub.mjs', () => {
  const canonical = realpathSync(join(root, 'scripts', 'validate-hub.mjs'));
  const offenders = [];
  for (const name of skillDirNames()) {
    const resolved = join(skillsDir, name, '..', '..', 'scripts', 'validate-hub.mjs');
    if (!existsSync(resolved)) {
      offenders.push(`${name}: ${resolved} does not exist`);
      continue;
    }
    if (realpathSync(resolved) !== canonical) {
      offenders.push(`${name}: ${resolved} does not resolve to the canonical scripts/validate-hub.mjs`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `every skill lives at <engine-root>/skills/<name>/ with engine scripts at ` +
      `<engine-root>/scripts/, resolved relative to the skill's own base directory ` +
      `(.apex/conventions.md, "Multi-harness distribution"); violations:\n` +
      offenders.join('\n')
  );
});

test('lock (d): no absolute or user-home path literals under skills/**', () => {
  const forbiddenPatterns = [
    { label: '/Users/', pattern: /\/Users\//g },
    { label: '/home/', pattern: /\/home\//g },
    { label: '~/', pattern: /~\//g },
  ];
  const offenders = [];
  for (const file of walk(skillsDir)) {
    const text = readFileSync(file, 'utf8');
    for (const { label, pattern } of forbiddenPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        offenders.push(`${relative(root, file)}: '${label}' x${matches.length}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `skills/** must not contain absolute or user-home path literals — a portable ` +
      `skill uses an <engine-root>/... placeholder or a bare relative invocation, ` +
      `never a machine-specific path; violations:\n` +
      offenders.join('\n')
  );
});

test('lock (e): v1 template sources are UTF-8 with LF line endings', () => {
  const offenders = [];
  for (const name of portableV1Templates) {
    const path = join(templatesDir, name);
    const bytes = readFileSync(path);
    const text = bytes.toString('utf8');
    if (!bytes.equals(Buffer.from(text, 'utf8'))) offenders.push(`${name}: invalid UTF-8`);
    if (text.includes('\r')) offenders.push(`${name}: non-LF line ending`);
    if (!text.endsWith('\n')) offenders.push(`${name}: missing final LF`);
  }
  assert.deepEqual(offenders, []);
});

test('lock (f): v1 template placeholders match the normalized portable project model', () => {
  const allowed = new Set([
    'projectName',
    'description',
    'devCommands',
    'surfaceList',
    'surface',
    'path',
    'agent',
    'model',
  ]);
  const offenders = [];
  for (const name of portableV1Templates) {
    const text = readFileSync(join(templatesDir, name), 'utf8');
    for (const match of text.matchAll(/\{\{(\w+)\}\}/g)) {
      if (!allowed.has(match[1])) offenders.push(`${name}: {{${match[1]}}}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('lock (f2): Codex inherits by omitting model while Claude retains its native model placeholder', () => {
  const codex = readFileSync(join(templatesDir, 'surface-agent-codex.toml'), 'utf8');
  const claude = readFileSync(join(templatesDir, 'surface-agent-claude.md'), 'utf8');
  assert.doesNotMatch(codex, /^model\s*=/m);
  assert.doesNotMatch(codex, /\{\{model\}\}/);
  assert.match(claude, /^model: \{\{model\}\}$/m);
});

test('lock (g): canonical portable sources have no project hard-code, symlink, or duplicated bootstrap procedure', () => {
  const portableSources = [
    ...portableV1Templates.map((name) => join(templatesDir, name)),
    ...walk(skillsDir),
  ];
  const symlinks = portableSources
    .filter((path) => lstatSync(path).isSymbolicLink())
    .map((path) => relative(root, path));
  assert.deepEqual(symlinks, [], 'portable canonical sources must not use symlinks');

  const hardCodes = portableV1Templates
    .filter((name) => readFileSync(join(templatesDir, name), 'utf8').includes('steepy-apex'));
  assert.deepEqual(hardCodes, [], 'portable template sources must not hard-code the steepy-apex project name');

  const procedureMarker = 'Read `AGENTS.md` in full for the project overview';
  const procedureOwners = portableV1Templates
    .filter((name) => readFileSync(join(templatesDir, name), 'utf8').includes(procedureMarker));
  assert.deepEqual(
    procedureOwners,
    ['project-bootstrap-skill.md'],
    'the shared project-navigation procedure must live once in the canonical bootstrap source',
  );
});

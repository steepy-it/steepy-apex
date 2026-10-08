import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8');
const glossary = read('.apex', 'glossary.md');
const conventions = read('.apex', 'conventions.md');

function glossaryEntry(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = glossary.match(new RegExp(`- \\*\\*${escaped}\\*\\*[\\s\\S]*?(?=\\n- \\*\\*|$)`));
  return match ? match[0] : null;
}

function conventionsSection(heading) {
  const start = conventions.indexOf(`## ${heading}\n`);
  assert.ok(start >= 0, `conventions.md must have "## ${heading}"`);
  const rest = conventions.slice(start + heading.length + 4);
  const next = rest.search(/\n## /);
  return (next < 0 ? rest : rest.slice(0, next)).replace(/\s+/g, ' ');
}

test('glossary defines every inception term', () => {
  for (const term of ['Inception run', 'Run descriptor', 'Representative path', 'Decision register',
    'Effect log', 'Checkpoint', 'Resume note', 'Inception source']) {
    assert.ok(glossaryEntry(term), `glossary.md must define ${term}`);
  }
  assert.match(glossaryEntry('Inception run'), /Handoff[\s\S]*workflow envelope/i);
  assert.match(glossaryEntry('Run descriptor'), /\.apex\/inception\/run\.json[\s\S]*inception-state\.mjs/);
  assert.match(glossaryEntry('Decision register'), /DR-n/);
  assert.match(glossaryEntry('Effect log'), /append-only[\s\S]*intent[\s\S]*outcome[\s\S]*workflow event log/i);
  assert.match(glossaryEntry('Checkpoint'), /immutable[\s\S]*digest[\s\S]*non-blocking checkpoint/i);
  assert.match(glossaryEntry('Inception source'), /discovery[\s\S]*complete/i);
});

test('glossary Chain/Standalone entry places inception outside both families', () => {
  const entry = glossaryEntry('Chain skill / Standalone skill');
  assert.ok(entry);
  assert.match(entry, /`inception`[\s\S]*pre-hub[\s\S]*outside/i);
  assert.match(entry, /five/i);
  assert.match(entry, /loop-engineer/);
  assert.match(entry, /gear 4/i);
});

test('conventions "Inception (pre-hub)" states the substance rules', () => {
  const section = conventionsSection('Inception (pre-hub)');
  assert.ok(conventions.indexOf('## Work Artifacts') < conventions.indexOf('## Inception (pre-hub)'));
  assert.ok(conventions.indexOf('## Inception (pre-hub)') < conventions.indexOf('## Decision model'));
  assert.match(section, /not a gear[\s\S]*outside the chain[\s\S]*headless/i);
  assert.match(section, /`\.apex\/inception\/`/);
  assert.match(section, /own `\.gitignore`[\s\S]*`\*`[\s\S]*root\s+`\.gitignore`[\s\S]*never edited/i);
  assert.match(section, /anti-orphan/i);
  assert.match(section, /`\.apex\/inception\/run\.json`[\s\S]*`scripts\/inception-state\.mjs`/);
  assert.match(section, /`\.apex\/inception\/abandoned\/<run-id>\/`[\s\S]*deletes nothing/i);
  assert.match(section, /no `_INDEX\.md`[\s\S]*exits 0[\s\S]*Stop hook[\s\S]*silent[\s\S]*unparseable/i);
  assert.match(section, /never creates hub artifacts/i);
  assert.match(section, /inception → `init`[\s\S]*→ `discovery`[\s\S]*→ gears/);
  assert.match(section, /single human approval[\s\S]*digests[\s\S]*verbatim[\s\S]*never self-approved[\s\S]*proves bytes/i);
  assert.match(section, /intent before[\s\S]*outcome after[\s\S]*uncertain[\s\S]*never repeated[\s\S]*immutable/i);
  assert.match(section, /`complete` run only[\s\S]*exact bound paths[\s\S]*three promotion rules[\s\S]*write-back never names the area[\s\S]*accepted or rejected with a reason/i);
  assert.match(section, /hard link/i);
});

test('standards carry the inception pointers', () => {
  const skills = read('.apex', 'standards', 'skills.md');
  const scripts = read('.apex', 'standards', 'scripts.md');
  const templates = read('.apex', 'standards', 'templates.md');
  const tests = read('.apex', 'standards', 'tests.md');
  assert.match(skills, /`inception` is pre-hub \(conventions\.md → "Inception \(pre-hub\)"\)\. Chain skills carry gear-0/);
  assert.match(scripts, /`inception-state\.mjs` records and verifies inception run state/);
  assert.match(scripts, /`\.apex\/inception` receives the same exclusion as `\.apex\/work`/);
  assert.match(scripts, /exits 0 \(coherent\/no-hub\/pre-hub inception run\)/);
  assert.match(templates, /Inception renders no template and nothing renders into `\.apex\/inception\/`/);
  assert.match(tests, /ten-skill/);
  assert.doesNotMatch(tests, /nine-skill/);
  assert.match(conventions, /the ten skills in `skills\/`/);
});

test('GC8: budgeted standards stay within 150 lines', () => {
  for (const name of ['skills', 'scripts', 'tests']) {
    const lines = read('.apex', 'standards', `${name}.md`).split('\n').length - 1;
    assert.ok(lines <= 150, `${name}.md has ${lines} lines`);
  }
});

test('no stable .apex doc links into .apex/inception/', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'work' || entry.name === 'inception' ? [] : walk(path);
    return entry.name.endsWith('.md') ? [path] : [];
  });
  for (const path of walk(join(repoRoot, '.apex'))) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /\]\([^)]*\.apex\/inception\//, `${path} links into the inception area`);
  }
});

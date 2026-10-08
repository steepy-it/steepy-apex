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
  assert.match(section, /never edited for the area; an approved bootstrap tool may change it as an application file, recorded as an effect/i);
  assert.match(section, /discovery's explorer reads/i);
  assert.doesNotMatch(section, /generic child reads/i);
  assert.match(section, /`\.apex\/inception\/run\.json`[\s\S]*`scripts\/inception-state\.mjs`/);
  assert.match(section, /`\.apex\/inception\/abandoned\/<run-id>\/`[\s\S]*deletes nothing/i);
  assert.match(section, /no `_INDEX\.md`[\s\S]*exits 0[\s\S]*Stop hook[\s\S]*silent[\s\S]*unparseable/i);
  assert.match(section, /never creates hub artifacts/i);
  assert.match(section, /inception → `init`[\s\S]*→ `discovery`[\s\S]*→ gears/);
  assert.match(section, /single human approval[\s\S]*digests[\s\S]*verbatim[\s\S]*never self-approved[\s\S]*proves bytes/i);
  assert.match(section, /intent before[\s\S]*outcome after[\s\S]*uncertain[\s\S]*never repeated[\s\S]*immutable/i);
  assert.match(section, /`complete` run only[\s\S]*exact bound paths[\s\S]*`verified`[\s\S]*existing component or rule[\s\S]*`unverified`[\s\S]*design choice, not an existing component[\s\S]*`future`[\s\S]*context in `conventions\.md`[\s\S]*never an implemented component, a spec, or a started task[\s\S]*only `conventions\.md`, the routed surface standards, and `glossary\.md`[\s\S]*no new hub document[\s\S]*write-back never names the area[\s\S]*accepted or rejected with a reason/i);
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

const readme = read('README.md');
const guideDoc = () => read('docs', 'inception.md');
const norm = (text) => text.replace(/\s+/g, ' ');

test('README lists inception first and links its guide', () => {
  const skillsTable = readme.slice(readme.indexOf('## Skills'), readme.indexOf('## Data and external services'));
  const rows = skillsTable.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Skill') && !line.startsWith('|---'));
  assert.equal(
    rows[0],
    '| [`/steepy-apex:inception`](docs/inception.md) | Turn an idea and its materials into a verified first version before the hub exists. |',
  );
  const getStarted = readme.slice(readme.indexOf('## Get started'), readme.indexOf('## Skills'));
  assert.match(norm(getStarted), /starting from an idea or a prototype\? run `\/steepy-apex:inception` first\. it ends by pointing to `\/steepy-apex:init` and `\/steepy-apex:discovery`/i);
});

test('README external-services table names inception reach and authorization', () => {
  const section = readme.slice(readme.indexOf('## Data and external services'), readme.indexOf('## Documentation'));
  const row = section.split('\n').find((line) => line.startsWith('| `/steepy-apex:inception`'));
  assert.ok(row, 'inception row missing');
  assert.match(row, /official project documentation and package registries/i);
  assert.match(row, /Git hosting only after your authorization/i);
  assert.match(row, /research queries and installs/i);
  assert.match(row, /only after you authorize each one/i);
});

test('workflow doc places inception before the hub and outside the gears', () => {
  const workflow = read('docs', 'workflow.md');
  const start = workflow.indexOf('## Before the hub: inception');
  assert.ok(start >= 0);
  assert.ok(start < workflow.indexOf('## Every task gets classified'));
  const section = norm(workflow.slice(start, workflow.indexOf('## Every task gets classified')));
  assert.match(section, /before a hub exists/i);
  assert.match(section, /not a gear/i);
  assert.match(section, /not part of the Gear-3 chain/i);
  assert.match(section, /different artifacts/i);
  assert.match(section, /\[inception guide\]\(inception\.md\)/);
});

test('architecture doc counts ten skills, lists the helper, and has the effects row', () => {
  const architecture = read('docs', 'architecture.md');
  assert.match(architecture, /the 10 skills/);
  assert.doesNotMatch(architecture, /\bnine\b/i);
  assert.match(architecture, /registers ten `steepy-apex-<skill>` commands/);
  assert.match(architecture, /ten `steepy-<skill>` commands/);
  assert.match(architecture, /\| `inception-state\.mjs` \|/);
  assert.match(architecture, /\| Inception \| Writes `\.apex\/inception\/` and the application's files; runs the approved tools \(installs, generators, builds, tests\); may reach official sources and package registries; remote operations only after explicit authorization\. \|/);
  assert.doesNotMatch(read('docs', 'installation.md'), /\bnine\b/i);
});

test('inception guide covers the flow, helper, harnesses, and limits', () => {
  const guide = norm(guideDoc());
  for (const harness of ['Claude Code', 'Codex', 'OpenCode', 'Pi', 'DeepSeek Harness']) {
    assert.ok(guide.includes(harness), `guide names ${harness}`);
  }
  assert.match(guide, /no headless or autopilot mode on any harness/i);
  assert.match(guide, /three sessions[\s\S]*two pauses/i);
  assert.match(guide, /`\.apex\/inception\/run\.json`/);
  assert.match(guide, /`\.apex\/inception\/project\/decision-register\.md`/);
  assert.match(guide, /`configured`[\s\S]*`executed`[\s\S]*`succeeded`[\s\S]*`not-executed`[\s\S]*`failed`/);
  assert.match(guide, /`verified`[\s\S]*`unverified`[\s\S]*`future`/);
  assert.match(guide, /`--option=<value>`/);
  assert.match(guide, /symlinked ancestor directory[\s\S]*named twice/i);
  assert.match(guide, /effect log is malformed at line <n>/);
  assert.match(guide, /compact[\s\S]*key order[\s\S]*no spaces/i);
  assert.match(guide, /missing `_INDEX\.md`/);
  assert.match(guide, /no preset (application )?stack/i);
  assert.match(guide, /deferred/i);
  assert.match(guide, /delete[\s\S]*after (the )?discovery/i);
  for (const cmd of ['classify', 'start', 'transition', 'resume-note', 'approve', 'verify-approval',
    'effect intent', 'effect outcome', 'effect status', 'checkpoint create', 'checkpoint verify', 'abandon']) {
    assert.ok(guide.includes(`inception-state.mjs ${cmd}`), `guide lists ${cmd}`);
  }
});

test('community and security copy count ten skills with inception first', () => {
  const community = read('COMMUNITY_SUBMISSION.md');
  assert.match(community, /- Ten canonical skills: `\/steepy-apex:inception`, `\/steepy-apex:init`/);
  assert.match(community, /\*\*Command-family effects matrix:\*\*[^\n]*inception runs/);
  assert.match(read('SECURITY.md'), /inception runs[^\n]*\n?[^\n]*native\s+installation\/canaries|native\s+installation\/canaries[^\n]*inception runs|inception runs/);
});

test('RELEASE.md confirms ten commands including inception', () => {
  const release = read('RELEASE.md');
  assert.match(release, /Confirm all ten commands:/);
  assert.match(release, /```text\n\/steepy-apex:inception\n\/steepy-apex:init\n/);
});

test('acceptance protocol covers both scenarios, evidence matrix, and setup rule', () => {
  const doc = norm(read('docs', 'inception-acceptance.md'));
  assert.match(doc, /release gate after review/i);
  assert.match(doc, /not a review criterion/i);
  assert.match(doc, /Scenario A[\s\S]*empty repository[\s\S]*`init`[\s\S]*`discovery`[\s\S]*inception source/i);
  assert.match(doc, /Scenario B[\s\S]*starter[\s\S]*(design system|prototype)[\s\S]*`init`[\s\S]*`discovery`[\s\S]*inception source/i);
  assert.match(doc, /`git clone`[\s\S]*validate-hub\.mjs \.`[\s\S]*OK[\s\S]*without `\.apex\/inception\/` and `\.apex\/work\/`/i);
  assert.match(doc, /interruption[\s\S]*between an effect's intent and its outcome[\s\S]*new session/i);
  assert.ok(doc.includes('| Run | Harness version | Plugin commit | Capabilities | Observed outcome | Observed human approver |'));
  for (const row of ['Claude Code A (with interruption)', 'Claude Code B', 'Codex A', 'Codex B']) {
    assert.match(doc, new RegExp(`\\| ${row.replace(/[()]/g, '\\$&')} \\|[^\\n]*PENDING`), `${row} row is PENDING`);
  }
  assert.match(doc, /hand-written command sequence[\s\S]*not a proof/i);
  assert.match(doc, /model's approval is never recorded as a human approver/i);
  assert.match(doc, /packaged plugin[\s\S]*installed steepy-apex release[\s\S]*disabled[\s\S]*`missing _INDEX\.md`/i);
  assert.match(doc, /Scenario C is deferred out of v1/i);
  assert.match(norm(guideDoc()), /\[native acceptance protocol\]\(inception-acceptance\.md\)/);
});

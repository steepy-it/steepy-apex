import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffold } from '../scripts/new-surface.mjs';
import { renderTemplate } from '../scripts/template.mjs';
import { collectViolations } from '../scripts/validate-hub.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const templates = join(root, 'templates');
const skill = () => readFileSync(join(root, 'skills', 'init', 'SKILL.md'), 'utf8');

function jsonBlockAfter(text, heading) {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, `missing heading '${heading}'`);
  const match = text.slice(start).match(/```json\n([\s\S]*?)\n```/);
  assert.ok(match, `missing JSON block after '${heading}'`);
  return JSON.parse(match[1]);
}

// --- Skill-content invariants for the non-destructive repair mode (Q1) -------------
// init is a Markdown procedure executed by Claude; these lock the documented
// branch so a re-run on an existing hub can never silently wipe user content.

test('init branches on an existing hub and enters a non-destructive repair mode', () => {
  const text = skill();
  assert.match(text, /repair/i, 'skill must describe a repair mode');
  assert.match(text, /existing .*hub|already .*\.apex|\.apex\/_INDEX\.md.*exists/i,
    'skill must detect an existing hub before generating');
  assert.match(text, /non-destructive|do not overwrite|never overwrite|preserve/i,
    'repair mode must be described as non-destructive');
});

test('repair mode preserves an existing _INDEX.md instead of regenerating it', () => {
  const text = skill();
  // The destructive bug was Step 3 unconditionally rewriting _INDEX.md. Repair must
  // explicitly keep the existing routing table / git policy and append rows instead.
  assert.match(text, /append/i, 'repair must append a routing row, not regenerate the table');
  assert.match(text, /routing table|routing-table|git policy|git-policy/i,
    'repair must call out preserving the routing table / git policy');
});

test('repair mode adds the version stamp only when an existing hub lacks it', () => {
  const text = skill();
  assert.match(text, /steepy-hub-version/, 'repair must reference the version stamp');
  assert.match(text, /if .*(missing|absent|lacks?)|when .*(missing|absent|lacks?)/i,
    'adding the stamp must be guarded by an "if missing" condition');
});

test('init creates a gitignored .apex/work area and never registers specs/plans sub-indexes', () => {
  const text = readFileSync(join(root, 'skills', 'init', 'SKILL.md'), 'utf8');
  assert.match(text, /\.apex\/work\/\.gitignore/);
  assert.match(text, /\*\n!\.gitignore/);
  assert.match(text, /\.apex\/work\/specs\//);
  assert.match(text, /\.apex\/work\/plans\//);
  assert.doesNotMatch(text, /templates\/specs-index\.md/);
  assert.doesNotMatch(text, /templates\/plans-index\.md/);
});

test('init retains every confirmed value in one immutable authoritative interview JSON', () => {
  const text = skill();
  const record = jsonBlockAfter(text, '#### Authoritative confirmed interview record');
  assert.deepEqual(Object.keys(record), [
    'projectName',
    'description',
    'devCommands',
    'surfaces',
    'domainVocabulary',
    'gitPolicyDirective',
  ]);
  assert.deepEqual(Object.keys(record.surfaces[0]), ['name', 'path', 'agent', 'testCmd']);
  assert.equal(typeof record.domainVocabulary, 'object');
  assert.equal(typeof record.gitPolicyDirective, 'string');
  assert.match(text, /one temporary JSON file/i);
  assert.match(text, /byte-for-byte unchanged/i);
});

test('init derives the planner exact five-key JSON projection from the authoritative record', () => {
  const text = skill();
  const planner = jsonBlockAfter(text, '#### Exact planner projection');
  assert.deepEqual(Object.keys(planner), [
    'projectName',
    'description',
    'devCommands',
    'surfaces',
    'resolutions',
  ]);
  assert.deepEqual(Object.keys(planner.surfaces[0]), ['name', 'path', 'agent', 'testCmd']);
  assert.doesNotMatch(JSON.stringify(planner), /domainVocabulary|gitPolicyDirective/);
  assert.match(text, /derive[^.]*planner projection[^.]*authoritative confirmed interview record/i);
  assert.match(text, /never[^.]*transient chat state/i);
});

test('repair changes only projection resolutions while retaining glossary and git policy verbatim', () => {
  const text = skill();
  assert.match(text, /rewrite only `resolutions`[^.]*planner projection/i);
  assert.match(text, /regenerate[^.]*other four[^.]*authoritative confirmed interview record/i);
  assert.match(text, /domainVocabulary[^.]*gitPolicyDirective[^.]*byte-for-byte unchanged/i);
  assert.match(text, /hub documents[^.]*authoritative confirmed interview record/i);
  assert.doesNotMatch(text, /confirmed model and interview results/i);
});

test('fresh init and repair share preview then apply without a second general confirmation', () => {
  const text = skill();
  const planner = 'node <engine-root>/scripts/project-scaffold.mjs';
  const preview = `${planner} --hub <repo-root> --model <planner-model-json>`;
  const apply = `${preview} --apply`;
  assert.ok(text.includes(preview), 'init must invoke the planner preview');
  assert.ok(text.includes(apply), 'init must invoke the planner apply mode');
  assert.ok(text.indexOf(preview) < text.indexOf(apply), 'preview must precede apply');
  assert.match(text, /fresh init and repair|both fresh init and repair/i);
  assert.match(text, /without (?:asking for )?a second general confirmation/i);
});

test('repair asks only emitted conflict IDs and choices, rebuilds resolutions, and applies at zero conflicts', () => {
  const text = skill();
  assert.match(text, /only for (?:the )?conflict `?id`?s? and (?:the )?`?choices`? emitted/i);
  assert.match(text, /(rebuild|rewrite)[^.]*`resolutions`/i);
  assert.match(text, /repeat[^.]*preview/i);
  assert.match(text, /zero unresolved conflicts|`conflicts` is empty/i);
  assert.match(text, /abort[^.]*do not apply/i);
  assert.doesNotMatch(text, /overwrite the whole file|delete conflicting/i);
});

// --- Repair MECHANIC, end-to-end through the real scripts + linter (Q4) -------------
// Mirrors how e2e-smoke mirrors a fresh init: builds an existing hub with user
// customizations, then performs the repair (scaffold only the missing surface +
// append its row) and proves the hub stays green AND the user content survives.

function buildExistingHub() {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-repair-'));
  mkdirSync(join(hub, '.apex', 'standards'), { recursive: true });
  mkdirSync(join(hub, '.apex', 'work', 'specs'), { recursive: true });
  mkdirSync(join(hub, '.apex', 'work', 'plans'), { recursive: true });
  mkdirSync(join(hub, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(hub, 'apps', 'web'), { recursive: true });
  mkdirSync(join(hub, 'apps', 'api'), { recursive: true });

  for (const f of ['conventions.md', 'glossary.md', 'testing-and-checklist.md']) {
    writeFileSync(join(hub, '.apex', f), `# ${f}\n\nuser content for ${f}\n`);
  }

  // Existing surface 'web' (standard + adapter triad), as a prior init produced.
  const { row: webRow } = scaffold({ name: 'web', surfacePath: 'apps/web', agent: 'web-agent', hubRoot: hub, templatesDir: templates, testCmd: 'vitest' });
  assert.ok(existsSync(join(hub, '.claude', 'agents', 'web-agent.md')));
  assert.ok(existsSync(join(hub, '.codex', 'agents', 'web-agent.toml')));
  assert.ok(existsSync(join(hub, '.opencode', 'agents', 'web-agent.md')));

  // _INDEX.md rendered from the template with a CUSTOM git policy the user picked.
  const customGitPolicy = '4. **Git policy:** Custom team rule — never force-push.';
  const indexTpl = readFileSync(join(templates, '_INDEX.md'), 'utf8');
  writeFileSync(
    join(hub, '.apex', '_INDEX.md'),
    renderTemplate(indexTpl, { projectName: 'demo', routingRows: webRow, gitPolicyDirective: customGitPolicy })
  );

  // A LOCAL work spec the user added after init — must survive a repair re-run.
  writeFileSync(join(hub, '.apex', 'work', '.gitignore'), '*\n!.gitignore\n');
  writeFileSync(join(hub, '.apex', 'work', 'specs', 'auth.md'), '# Auth spec\n');
  writeFileSync(join(hub, '.apex', 'work', 'plans', 'auth-plan.md'), '# Auth plan\n');

  return { hub, customGitPolicy };
}

// Append a routing row after the LAST existing table row, without regenerating the file.
function appendRoutingRow(indexPath, row) {
  const lines = readFileSync(indexPath, 'utf8').split('\n');
  let last = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trimStart().startsWith('|')) last = i;
  lines.splice(last + 1, 0, row.trimEnd());
  writeFileSync(indexPath, lines.join('\n'));
}

test('a freshly-built existing hub starts green (repair precondition)', () => {
  const { hub } = buildExistingHub();
  const errors = collectViolations(hub).filter((v) => v.level === 'error');
  assert.deepEqual(errors, [], JSON.stringify(errors, null, 2));
});

test('repair adds a missing surface without clobbering the existing _INDEX.md or registered specs', () => {
  const { hub, customGitPolicy } = buildExistingHub();
  const indexPath = join(hub, '.apex', '_INDEX.md');
  const before = readFileSync(indexPath, 'utf8');

  // Repair: a new surface 'api' is confirmed but missing. Scaffold ONLY the missing
  // standard + adapter triad and APPEND its row — never regenerate _INDEX.md.
  const { row: apiRow } = scaffold({ name: 'api', surfacePath: 'apps/api', agent: 'api-agent', hubRoot: hub, templatesDir: templates, testCmd: 'vitest' });
  assert.ok(existsSync(join(hub, '.claude', 'agents', 'api-agent.md')));
  assert.ok(existsSync(join(hub, '.codex', 'agents', 'api-agent.toml')));
  assert.ok(existsSync(join(hub, '.opencode', 'agents', 'api-agent.md')));
  appendRoutingRow(indexPath, apiRow);

  const after = readFileSync(indexPath, 'utf8');
  const errors = collectViolations(hub).filter((v) => v.level === 'error');
  assert.deepEqual(errors, [], JSON.stringify(errors, null, 2));

  // Non-destructive guarantees:
  assert.match(after, /<!-- steepy-hub-version: 1 -->/, 'version stamp preserved');
  assert.ok(after.includes(customGitPolicy), 'custom git policy preserved');
  assert.match(after, /`web`/, 'existing web row preserved');
  assert.match(after, /`api`/, 'new api row appended');
  // The existing content is a strict prefix-superset: nothing removed, only the row added.
  assert.ok(after.length > before.length, 'repair only grew the file');
  assert.ok(after.includes(before.split('\n').filter((l) => l.includes('`web`'))[0]), 'web row byte-identical');

  // Local work artifacts survived untouched.
  const spec = readFileSync(join(hub, '.apex', 'work', 'specs', 'auth.md'), 'utf8');
  const plan = readFileSync(join(hub, '.apex', 'work', 'plans', 'auth-plan.md'), 'utf8');
  assert.match(spec, /Auth spec/, 'local work spec preserved');
  assert.match(plan, /Auth plan/, 'local work plan preserved');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTemplate } from '../scripts/template.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, '..', 'templates');

const v1Templates = [
  'AGENTS.md',
  'claude-import.md',
  'project-bootstrap-skill.md',
  'claude-bootstrap-stub.md',
  'surface-agent-claude.md',
  'surface-agent-codex.toml',
  'surface-agent-opencode.md',
];

const renderVars = {
  projectName: 'demo-project',
  description: 'A portable demo project.',
  devCommands: '- `npm test`',
  surfaceList: '- `web` (`apps/web`) — `web-agent`',
  surface: 'web',
  path: 'apps/web',
  agent: 'web-agent',
  model: 'confirmed-model',
};

function template(name) {
  return readFileSync(join(templatesDir, name), 'utf8');
}

function parseCodexAdapterToml(text) {
  const parsed = {};
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '' || line.startsWith('#')) continue;
    const assignment = line.match(/^([A-Za-z][A-Za-z0-9_-]*) = (.*)$/);
    assert.ok(assignment, `invalid TOML line ${index + 1}: ${line}`);
    const [, key, value] = assignment;
    assert.ok(!(key in parsed), `duplicate TOML key: ${key}`);
    if (value === '"""') {
      const body = [];
      index += 1;
      while (index < lines.length && lines[index] !== '"""') {
        assert.doesNotMatch(
          lines[index],
          /"""/,
          `unexpected TOML multiline delimiter inside ${key}`,
        );
        body.push(lines[index]);
        index += 1;
      }
      assert.ok(index < lines.length, `unterminated TOML multiline basic string: ${key}`);
      parsed[key] = body.join('\n');
      continue;
    }
    assert.match(value, /^"(?:[^"\\]|\\[btnfr"\\]|\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8})*"$/);
    parsed[key] = JSON.parse(value);
  }
  return parsed;
}

test('renderTemplate substitutes vars and throws on missing', () => {
  assert.equal(renderTemplate('hi {{x}}', { x: 'there' }), 'hi there');
  assert.throws(() => renderTemplate('{{missing}}', {}), /missing/);
});

test('v1 root instruction templates contain only their managed blocks', () => {
  const agents = renderTemplate(template('AGENTS.md'), renderVars);
  assert.match(agents, /^<!-- steepy:managed:project-instructions:v1:start -->\n/);
  assert.match(agents, /\n<!-- steepy:managed:project-instructions:v1:end -->\n$/);
  assert.doesNotMatch(agents, /steepy:generated:/);
  assert.match(agents, /demo-project/);
  assert.match(agents, /A portable demo project\./);
  assert.match(agents, /npm test/);
  assert.match(agents, /web-agent/);
  assert.match(agents, /`demo-project-bootstrap`/);
  assert.match(agents, /`\.apex\/_INDEX\.md`/);

  assert.equal(
    template('claude-import.md'),
    '<!-- steepy:managed:claude-import:v1:start -->\n@AGENTS.md\n<!-- steepy:managed:claude-import:v1:end -->\n',
  );
});

test('v1 generated templates render complete provenance and native thin adapters', () => {
  const rendered = Object.fromEntries(
    v1Templates.slice(2).map((name) => [name, renderTemplate(template(name), renderVars)]),
  );

  for (const [name, text] of Object.entries(rendered)) {
    assert.doesNotMatch(text, /\{\{\w+\}\}/, `${name} leaked a placeholder`);
  }

  assert.match(
    rendered['project-bootstrap-skill.md'],
    /^---\n[\s\S]*?\n---\n<!-- steepy:generated:demo-project-bootstrap:v1 -->\n/,
  );
  assert.match(rendered['project-bootstrap-skill.md'], /`AGENTS\.md`/);
  assert.match(rendered['project-bootstrap-skill.md'], /`\.apex\/_INDEX\.md`/);
  assert.match(
    rendered['project-bootstrap-skill.md'],
    /Do not ordinarily enumerate, search, or read under `\.apex\/work\/\*\*`/,
  );
  assert.match(
    rendered['project-bootstrap-skill.md'],
    /accepted handoff.*exact work inputs|exact work inputs.*accepted handoff/is,
  );
  assert.match(
    rendered['project-bootstrap-skill.md'],
    /pathless workflow invocation.*bounded workflow-header recovery discovery/i,
  );
  assert.match(
    rendered['project-bootstrap-skill.md'],
    /exact paths or a broader work-area scope.*explicitly delimits/i,
  );
  assert.match(
    rendered['project-bootstrap-skill.md'],
    /child agents.*only the phase orchestrator interprets a handoff/i,
  );
  assert.doesNotMatch(
    rendered['project-bootstrap-skill.md'],
    /phase role maps|lifecycle transitions|envelope grammar|harness-specific invocation syntax|shared protocol reference/i,
  );
  assert.doesNotMatch(rendered['project-bootstrap-skill.md'], /CLAUDE\.md|\/steepy-apex:/);
  assert.match(
    rendered['project-bootstrap-skill.md'],
    /Do not ordinarily enumerate, search, or read under `\.apex\/inception\/\*\*`/,
  );
  assert.match(
    rendered['project-bootstrap-skill.md'],
    /exact input paths.*current step.*user explicitly authorizes|user explicitly authorizes.*exact input paths/is,
  );
  assert.doesNotMatch(
    rendered['project-bootstrap-skill.md'],
    /inception-handoff|inception-approval|inception-checkpoint|inception-promotion|inception-receipt/i,
  );
  assert.match(
    rendered['project-bootstrap-skill.md'],
    /inception boundary has no pathless recovery of its own/i,
  );

  assert.match(
    rendered['claude-bootstrap-stub.md'],
    /^---\n[\s\S]*?\n---\n<!-- steepy:generated:demo-project-bootstrap-stub:v1 -->\n/,
  );
  assert.match(
    rendered['claude-bootstrap-stub.md'],
    /`\.agents\/skills\/demo-project-bootstrap\/SKILL\.md`/,
  );
  assert.doesNotMatch(rendered['claude-bootstrap-stub.md'], /\.apex\/_INDEX|## Procedure/);

  const adapters = [
    ['surface-agent-claude.md', '<!-- steepy:generated:web-agent-claude:v1 -->'],
    ['surface-agent-codex.toml', '# steepy:generated:web-agent-codex:v1'],
    ['surface-agent-opencode.md', '<!-- steepy:generated:web-agent-opencode:v1 -->'],
  ];
  for (const [name, provenance] of adapters) {
    const text = rendered[name];
    assert.match(text, /web-agent/);
    assert.match(text, /A portable demo project\./);
    assert.match(text, /web/);
    assert.match(text, /apps\/web/);
    assert.match(text, /demo-project-bootstrap/);
    assert.match(text, /\.apex\/standards\/web\.md/);
    assert.equal(text.split(provenance).length - 1, 1, `${name} must carry one provenance marker`);
    assert.equal(
      text.split('.apex/standards/web.md').length - 1,
      1,
      `${name} must point to the standard once instead of duplicating its rules`,
    );
    assert.doesNotMatch(text, /Surface non-negotiables|Anti-patterns|## Conventions/);
  }
  assert.match(
    rendered['surface-agent-claude.md'],
    /^---\n[\s\S]*?\n---\n<!-- steepy:generated:web-agent-claude:v1 -->\n/,
  );
  assert.match(rendered['surface-agent-claude.md'], /^model: confirmed-model$/m);
  assert.match(rendered['surface-agent-codex.toml'], /^# steepy:generated:web-agent-codex:v1\n/);
  assert.doesNotMatch(rendered['surface-agent-codex.toml'], /^model\s*=/m);
  assert.match(
    rendered['surface-agent-opencode.md'],
    /^---\n[\s\S]*?\n---\n<!-- steepy:generated:web-agent-opencode:v1 -->\n/,
  );
});

test('Codex adapter remains valid TOML for a quote-bearing safe-line description', () => {
  const rendered = renderTemplate(template('surface-agent-codex.toml'), {
    ...renderVars,
    description: 'The "portable" project',
  });
  const parsed = parseCodexAdapterToml(rendered);

  assert.equal(parsed.name, 'web-agent');
  assert.equal(parsed.description, 'Specialist agent for web work.');
  assert.equal(parsed.model, undefined);
  assert.match(rendered, /# Project description: The "portable" project/);
  assert.match(parsed.developer_instructions, /demo-project-bootstrap/);
});

test('Codex adapter remains valid TOML for a quote-bearing safe relative path', () => {
  const path = 'apps/"""quoted"/web';
  const rendered = renderTemplate(template('surface-agent-codex.toml'), {
    ...renderVars,
    description: 'The "portable" project',
    path,
  });
  const parsed = parseCodexAdapterToml(rendered);

  assert.equal(parsed.name, 'web-agent');
  assert.equal(parsed.description, 'Specialist agent for web work.');
  assert.equal(parsed.model, undefined);
  assert.match(rendered, /# Project description: The "portable" project/);
  assert.ok(rendered.includes(`# Surface path: ${path}`));
  assert.match(parsed.developer_instructions, /demo-project-bootstrap/);
  assert.doesNotMatch(parsed.developer_instructions, /apps\//);
});

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

test('final v1 layout excludes retired template sources and consumer reads', () => {
  const retiredNames = [
    ['CL', 'AUDE.md'],
    ['bootstrap', '-skill.md'],
    ['surface-agent', '.md'],
  ].map(([prefix, suffix]) => `${prefix}${suffix}`);
  const retiredSources = retiredNames.map((name) => `templates/${name}`);

  for (const name of retiredNames) {
    assert.equal(existsSync(join(templatesDir, name)), false, `retired template must not exist: ${name}`);
  }

  for (const directory of ['scripts', 'skills', 'adapters', 'tests']) {
    for (const path of sourceFiles(join(here, '..', directory))) {
      const source = readFileSync(path, 'utf8');
      for (const retiredSource of retiredSources) {
        assert.doesNotMatch(
          source,
          new RegExp(retiredSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          `${path} must not reference retired template source ${retiredSource}`,
        );
      }
    }
  }

  const standard = readFileSync(join(here, '..', '.apex', 'standards', 'templates.md'), 'utf8');
  assert.match(standard, /final v1 layout/i);
  assert.match(standard, /project-bootstrap-skill\.md/);
  assert.match(standard, /surface-agent-(?:claude|codex|opencode)/);
  assert.doesNotMatch(standard, /\b(?:dual layout|expand phase|legacy|consumer|migration)\b/i);
  assert.match(standard, /inception-project\.md/);
  assert.match(standard, /inception-verification\.md/);
  assert.match(standard, /project-context\.md/);
  assert.match(standard, /project-architecture\.md/);
});

test('the hub index template excludes both local areas from the DAG and keeps promoted content self-sufficient', () => {
  const index = template('_INDEX.md');
  assert.match(
    index,
    /excluding local `?\.apex\/work\/\*\*`? and `?\.apex\/inception\/\*\*`? artifacts/,
  );
  assert.match(index, /`?\.apex\/inception\/`?/);
  assert.match(index, /self-sufficient/i);
});

const skeletonTemplates = {
  'inception-project.md': [
    /^# Project — Inception Record/m,
    /## Materials, facts, and simulations/,
    /## Constraints/,
    /## Alternatives and reasons/,
    /## Components, data, and contracts/,
    /## Official research/,
    /## Reused assets and preserved behaviors/,
    /## Representative path/,
    /## Evidence and chosen deploy/,
  ],
  'inception-verification.md': [
    /^# Verification — Inception Record/m,
    /`configured`/,
    /`executed`/,
    /`succeeded`/,
    /`not-executed`/,
    /`failed`/,
    /## Local CI/,
    /## Remote success/,
    /## Deploy/,
  ],
  'project-context.md': [
    /^# Project Context/m,
    /## Intent/,
    /## Design, prototype, and behaviors/,
    /## Bootstrap boundaries/,
    /## Future flows/,
    /## Open questions/,
    /READY/,
  ],
  'project-architecture.md': [
    /^# Project Architecture/m,
    /## Cross-cutting decisions/,
    /## Reasons/,
    /## Version policy/,
    /manifest.*lockfile|lockfile.*manifest/is,
  ],
};

test('the inception and project skeletons are proportioned fill-in structures, not a fixed catalog', () => {
  for (const [name, patterns] of Object.entries(skeletonTemplates)) {
    const text = template(name);
    assert.doesNotMatch(text, /\{\{\w+\}\}/, `${name} must not carry a code-rendered placeholder`);
    assert.doesNotMatch(text, /steepy:generated:/, `${name} must not claim generated provenance`);
    for (const pattern of patterns) {
      assert.match(text, pattern, `${name} must match ${pattern}`);
    }
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffold } from '../scripts/new-surface.mjs';
import { renderTemplate } from '../scripts/template.mjs';
import { collectViolations } from '../scripts/validate-hub.mjs';
import { planProjectScaffold, applyProjectScaffold } from '../scripts/project-scaffold.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const templates = join(here, '..', 'templates');
test('a hub built from templates + one surface passes the linter green', () => {
  const hub = mkdtempSync(join(tmpdir(), 'steepy-e2e-'));
  mkdirSync(join(hub, '.apex', 'standards'), { recursive: true });
  mkdirSync(join(hub, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(hub, 'apps', 'web'), { recursive: true });

  // satellite docs linked from _INDEX
  for (const f of ['conventions.md', 'glossary.md', 'testing-and-checklist.md']) {
    writeFileSync(join(hub, '.apex', f), `# ${f}\n`);
  }
  const { row } = scaffold({ name: 'web', surfacePath: 'apps/web', agent: 'web-agent', hubRoot: hub, templatesDir: templates, testCmd: 'vitest' });

  const indexTpl = readFileSync(join(templates, '_INDEX.md'), 'utf8');
  writeFileSync(join(hub, '.apex', '_INDEX.md'), renderTemplate(indexTpl, { projectName: 'project', routingRows: row, gitPolicyDirective: '' }));

  mkdirSync(join(hub, '.apex', 'work'), { recursive: true });
  writeFileSync(join(hub, '.apex', 'work', '.gitignore'), '*\n!.gitignore\n');


  const model = {
    projectName: 'project', description: '', devCommands: ['vitest run'], resolutions: {},
    surfaces: [{ name: 'web', path: 'apps/web', agent: 'web-agent', testCmd: 'vitest' }],
  };
  const plan = planProjectScaffold({ hubRoot: hub, model, templatesDir: templates });
  applyProjectScaffold({ hubRoot: hub, plan });

  const errors = collectViolations(hub).filter((v) => v.level === 'error');
  assert.deepEqual(errors, [], JSON.stringify(errors, null, 2));

  const indexText = readFileSync(join(hub, '.apex', '_INDEX.md'), 'utf8');
  assert.doesNotMatch(indexText, /specs\/_INDEX\.md/, 'root index must not link stable specs sub-index');
  assert.doesNotMatch(indexText, /plans\/_INDEX\.md/, 'root index must not link stable plans sub-index');
  assert.doesNotMatch(
    indexText,
    /every `?\.apex\/\*\*\.md`? must be reachable/i,
    'root index must not claim every .apex markdown file is reachable'
  );
  assert.match(
    indexText,
    /\.apex\/work\/\*\*|stable .*\.apex\/\*\*\.md|excluding .*\.apex\/work/i,
    'root index must scope anti-orphan reachability to stable docs and exclude .apex/work'
  );
  assert.match(
    indexText,
    /Work artifacts:[\s\S]*specs[\s\S]*live under `\.apex\/work\/`[\s\S]*`\.apex\/inception\/`[\s\S]*Promote durable decisions into stable docs/i,
    'root index must tell generated hubs that specs/plans/inception materials are local work artifacts'
  );
  assert.equal(readFileSync(join(hub, '.apex', 'work', '.gitignore'), 'utf8'), '*\n!.gitignore\n');
  // The hub carries a format-version stamp so a future format break can gate/migrate.
  // The stamp survives template rendering (it is a comment, not a placeholder) and is
  // inert to the linter (no backticks, no '](', not a '|' row).
  assert.match(indexText, /<!-- steepy-hub-version: 1 -->/, 'rendered hub carries the format-version stamp');

  const claudeMd = readFileSync(join(hub, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /^@AGENTS\.md$/m);
  assert.match(readFileSync(join(hub, 'AGENTS.md'), 'utf8'), /project-bootstrap/);
  assert.match(readFileSync(join(hub, '.agents', 'skills', 'project-bootstrap', 'SKILL.md'), 'utf8'), /`\.apex\/_INDEX\.md`/);
});

// The two durable project templates the inception entry of init creates when a
// promotion needs them: rendered verbatim and linked from the index they lint
// green; left unlinked they are orphans. The hub is template-built, not a
// transfer result: tests/inception-integration.test.mjs owns the transfer.
test('project-context and project-architecture templates compose into a green hub only when the index links them', () => {
  for (const linked of [true, false]) {
    const hub = mkdtempSync(join(tmpdir(), 'steepy-e2e-project-docs-'));
    try {
      mkdirSync(join(hub, 'apps', 'web'), { recursive: true });
      for (const f of ['conventions.md', 'glossary.md', 'testing-and-checklist.md']) {
        mkdirSync(join(hub, '.apex'), { recursive: true });
        writeFileSync(join(hub, '.apex', f), `# ${f}\n`);
      }
      const { row } = scaffold({ name: 'web', surfacePath: 'apps/web', agent: 'web-agent', hubRoot: hub, templatesDir: templates, testCmd: 'vitest' });
      const map = '- [Testing & Checklist](testing-and-checklist.md)\n';
      const projectLinks = '- [Project Context](project-context.md)\n- [Project Architecture](project-architecture.md)\n';
      const index = renderTemplate(readFileSync(join(templates, '_INDEX.md'), 'utf8'), { projectName: 'project', routingRows: row, gitPolicyDirective: '' });
      assert.ok(index.includes(map), 'the index template keeps its knowledge-base map');
      writeFileSync(join(hub, '.apex', '_INDEX.md'), linked ? index.replace(map, `${map}${projectLinks}`) : index);
      for (const doc of ['project-context.md', 'project-architecture.md']) {
        writeFileSync(join(hub, '.apex', doc), readFileSync(join(templates, doc), 'utf8'));
      }
      const model = {
        projectName: 'project', description: '', devCommands: ['vitest run'], resolutions: {},
        surfaces: [{ name: 'web', path: 'apps/web', agent: 'web-agent', testCmd: 'vitest' }],
      };
      applyProjectScaffold({ hubRoot: hub, plan: planProjectScaffold({ hubRoot: hub, model, templatesDir: templates }) });

      const violations = collectViolations(hub);
      const errors = violations.filter((v) => v.level === 'error').map((v) => v.msg);
      if (linked) {
        assert.deepEqual(errors, [], JSON.stringify(errors, null, 2));
        assert.deepEqual(violations.filter((v) => /project-(context|architecture)\.md/.test(v.msg)), [],
          'the templates carry no warning either');
      } else {
        assert.deepEqual(errors.sort(), [
          'anti-orphan: .apex/project-architecture.md is not linked from .apex/_INDEX.md',
          'anti-orphan: .apex/project-context.md is not linked from .apex/_INDEX.md',
        ]);
      }
    } finally {
      rmSync(hub, { recursive: true, force: true });
    }
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, projectModelFromArgs } from '../scripts/render-claude-md.mjs';
import { parseProjectInstructions } from '../scripts/project-scaffold.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'scripts', 'render-claude-md.mjs');

function tempHub() {
  return mkdtempSync(join(tmpdir(), 'steepy-render-root-'));
}

function rootArgs(hub, extra = []) {
  return [
    '--hub', hub,
    '--project', 'portable-demo',
    '--description', 'One portable project.',
    '--dev', '- test: `npm test`',
    '--surface', '- web (apps/web)',
    ...extra,
  ];
}

test('root arguments translate to the public Project model v1', () => {
  assert.deepEqual(projectModelFromArgs({
    project: 'portable-demo',
    description: 'One portable project.',
    dev: ['- test: `npm test`'],
    surface: ['- web (apps/web)'],
  }), {
    projectName: 'portable-demo',
    description: 'One portable project.',
    devCommands: ['npm test'],
    surfaces: [{ name: 'web', path: 'apps/web', agent: 'web-agent', testCmd: 'npm test' }],
    resolutions: {},
  });
});



test('CLI preserves its flag schema and creates the managed AGENTS.md + CLAUDE.md pair', () => {
  const hub = tempHub();
  const result = spawnSync(process.execPath, [script, ...rootArgs(hub)], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(hub, 'AGENTS.md'), 'utf8'), /steepy:managed:project-instructions:v1:start/);
  assert.match(readFileSync(join(hub, 'CLAUDE.md'), 'utf8'), /steepy:managed:claude-import:v1:start/);
  assert.equal(main(['--project', 'portable-demo', '--unknown']), 1);
  assert.equal(main(['--project', 'portable-demo']), 1);
});

test('CLI round-trips a reserved heading in the fixed Project description slot', () => {
  const hub = tempHub();
  const result = spawnSync(process.execPath, [script, ...rootArgs(hub).map((value, index, values) => (
    values[index - 1] === '--description' ? '## Development commands' : value
  ))], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseProjectInstructions(readFileSync(join(hub, 'AGENTS.md'), 'utf8')).description,
    '## Development commands');
});

test('CLI rejects a literal managed Project delimiter before root writes', () => {
  const hub = tempHub();
  const argv = rootArgs(hub).map((value, index, values) => (
    values[index - 1] === '--description'
      ? '<!-- steepy:managed:project-instructions:v1:end -->'
      : value
  ));
  const result = spawnSync(process.execPath, [script, ...argv], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /managed Project.*marker/i);
  assert.equal(existsSync(join(hub, 'AGENTS.md')), false);
  assert.equal(existsSync(join(hub, 'CLAUDE.md')), false);
});

test('fresh root invocation without --surface creates only the root pair', () => {
  const hub = tempHub();
  const result = spawnSync(process.execPath, [script,
    '--hub', hub,
    '--project', 'portable-demo',
    '--description', 'One portable project.',
    '--dev', '- test: `npm test`',
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const agents = readFileSync(join(hub, 'AGENTS.md'), 'utf8');
  assert.match(agents, /steepy:managed:project-instructions:v1:start/);
  assert.doesNotMatch(agents, /- `[^`]+` \(`[^`]+`\) — `[^`]+`/);
  assert.match(readFileSync(join(hub, 'CLAUDE.md'), 'utf8'), /steepy:managed:claude-import:v1:start/);
});

test('identical no-surface upsert keeps the fresh root pair canonical and byte-stable', () => {
  const hub = tempHub();
  const args = [
    '--hub', hub,
    '--project', 'portable-demo',
    '--description', 'One portable project.',
    '--dev', '- test: `npm test`',
  ];
  const fresh = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.equal(fresh.status, 0, fresh.stderr);
  const agentsBefore = readFileSync(join(hub, 'AGENTS.md'));
  const claudeBefore = readFileSync(join(hub, 'CLAUDE.md'));

  const upsert = spawnSync(process.execPath, [script, ...args, '--upsert'], { encoding: 'utf8' });

  assert.equal(upsert.status, 0, upsert.stderr);
  const agentsAfter = readFileSync(join(hub, 'AGENTS.md'));
  const claudeAfter = readFileSync(join(hub, 'CLAUDE.md'));
  assert.deepEqual(agentsAfter, agentsBefore);
  assert.deepEqual(claudeAfter, claudeBefore);
  assert.doesNotMatch(agentsAfter.toString('utf8'), /root-agent|`root` \(`root`\)/);
  assert.equal((agentsAfter.toString('utf8').match(/steepy:managed:project-instructions:v1:start/g) || []).length, 1);
  assert.equal((claudeAfter.toString('utf8').match(/steepy:managed:claude-import:v1:start/g) || []).length, 1);
});

test('upsert safely adds both managed blocks without rewriting unmarked user-owned bytes', () => {
  const hub = tempHub();
  const agentsPrefix = Buffer.from('\uFEFF# User agent notes\r\nKeep this exactly.\r\n', 'utf8');
  const claudePrefix = Buffer.from('\uFEFF# Claude-only notes\r\nKeep this exactly too.\r\n', 'utf8');
  writeFileSync(join(hub, 'AGENTS.md'), agentsPrefix);
  writeFileSync(join(hub, 'CLAUDE.md'), claudePrefix);

  const result = spawnSync(process.execPath, [script, ...rootArgs(hub, ['--upsert'])], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const agents = readFileSync(join(hub, 'AGENTS.md'));
  const claude = readFileSync(join(hub, 'CLAUDE.md'));
  assert.deepEqual(agents.subarray(0, agentsPrefix.length), agentsPrefix);
  assert.deepEqual(claude.subarray(0, claudePrefix.length), claudePrefix);
  assert.match(agents.toString('utf8'), /\r\n<!-- steepy:managed:project-instructions:v1:start -->/);
  assert.match(claude.toString('utf8'), /\r\n<!-- steepy:managed:claude-import:v1:start -->/);
});

test('unmanaged @AGENTS.md import blocks the wrapper without writing either root file', () => {
  const hub = tempHub();
  const agents = Buffer.from('# User agent notes\n', 'utf8');
  const claude = Buffer.from('# Claude-only notes\n@AGENTS.md\n', 'utf8');
  writeFileSync(join(hub, 'AGENTS.md'), agents);
  writeFileSync(join(hub, 'CLAUDE.md'), claude);

  const result = spawnSync(process.execPath, [script, ...rootArgs(hub, ['--upsert'])], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.deepEqual(readFileSync(join(hub, 'AGENTS.md')), agents);
  assert.deepEqual(readFileSync(join(hub, 'CLAUDE.md')), claude);
});

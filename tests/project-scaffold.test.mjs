import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs, {
  lstatSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { LOCAL_AREA_NAMES } from '../scripts/sanitize.mjs';
import { fileURLToPath } from 'node:url';
import {
  applyProjectScaffold,
  classifyProjectArtifact,
  normalizeProjectModel,
  parseProjectInstructions,
  planProjectScaffold,
  planRootInstructions,
  planSpecialistScaffold,
  previewProjectScaffold,
  renderProjectArtifact,
  validateProjectScaffoldPlan,
} from '../scripts/project-scaffold.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, '..', 'templates');
const scaffoldModuleUrl = new URL('../scripts/project-scaffold.mjs', import.meta.url).href;

const lockOwnerChildSource = `
import { writeFileSync } from 'node:fs';
const [moduleUrl, hubRoot, templatesDir, modelJson, mode, readyPath] = process.argv.slice(1);
const { applyProjectScaffold, planProjectScaffold } = await import(moduleUrl);
const fullPlan = planProjectScaffold({ hubRoot, templatesDir, model: JSON.parse(modelJson) });
const plan = mode === 'interrupt-first'
  ? { schemaVersion: 1, operations: [fullPlan.operations[0]], conflicts: [] }
  : fullPlan;
applyProjectScaffold({
  hubRoot,
  plan,
  checkpoint({ phase }) {
    if (mode === 'hold' && phase === 'lock-acquired') {
      writeFileSync(readyPath, 'ready\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    if (mode === 'interrupt-first' && phase === 'before-lock-release') {
      process.kill(process.pid, 'SIGKILL');
    }
  },
});
`;

function model(overrides = {}) {
  return {
    projectName: 'portable-demo',
    description: 'One portable project.',
    devCommands: ['npm test'],
    surfaces: [
      { name: 'web', path: 'apps/web', agent: 'web-agent', testCmd: 'npm test' },
    ],
    resolutions: {},
    ...overrides,
  };
}

function tempHub() {
  return mkdtempSync(join(tmpdir(), 'steepy-project-plan-'));
}

test('root-only planner validates an empty surface list without relaxing Project model v1', () => {
  const hubRoot = tempHub();
  const rootOnlyModel = model({ surfaces: [] });
  assert.throws(() => normalizeProjectModel(rootOnlyModel), /surfaces must be a non-empty array/);

  const first = planRootInstructions({ hubRoot, model: rootOnlyModel, templatesDir });
  assert.deepEqual(first.operations.map(({ artifactId }) => artifactId), ['project-instructions', 'claude-import']);
  assert.deepEqual(first.conflicts, []);
  assert.equal(validateProjectScaffoldPlan(first), first);
  assert.doesNotMatch(first.operations[0].content, /- `[^`]+` \(`[^`]+`\) — `[^`]+`/);
  applyProjectScaffold({ hubRoot, plan: first });

  assert.deepEqual(parseProjectInstructions(readFileSync(join(hubRoot, 'AGENTS.md'), 'utf8')), {
    projectName: rootOnlyModel.projectName,
    description: rootOnlyModel.description,
    devCommands: rootOnlyModel.devCommands,
    surfaces: [],
    resolutions: {},
  });

  const second = planRootInstructions({ hubRoot, model: rootOnlyModel, templatesDir });
  assert.deepEqual(second.operations, []);
  assert.deepEqual(second.conflicts, []);
});

function put(root, path, content) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function snapshot(root, prefix = '') {
  const dir = join(root, prefix);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return snapshot(root, path);
    const stat = lstatSync(join(root, path));
    return [`${path}:${stat.mode}:${readFileSync(join(root, path)).toString('hex')}`];
  }).sort();
}

function lockOwnerChildArgs(hubRoot, mode, readyPath = '') {
  return [
    '--input-type=module',
    '--eval',
    lockOwnerChildSource,
    scaffoldModuleUrl,
    hubRoot,
    templatesDir,
    JSON.stringify(model()),
    mode,
    readyPath,
  ];
}

async function waitForFile(path, child, stderr) {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`lock-owner child exited before readiness: ${stderr()}`);
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for lock-owner child: ${stderr()}`);
    await new Promise((resolveReady) => setTimeout(resolveReady, 10));
  }
}

async function killAndWait(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  child.kill('SIGKILL');
  await exited;
}

test('normalizer rejects non-data JSON shapes and returns a sorted deep-frozen model', () => {
  const input = model({
    surfaces: [
      { name: 'web', path: 'apps/web', agent: 'web-agent', testCmd: 'npm test' },
      { name: 'api', path: 'apps/api', agent: 'api-agent', testCmd: 'npm test -- api' },
    ],
  });
  const normalized = normalizeProjectModel(input);
  assert.deepEqual(normalized.surfaces.map(({ name }) => name), ['api', 'web']);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.devCommands));
  assert.ok(Object.isFrozen(normalized.surfaces));
  assert.ok(Object.isFrozen(normalized.surfaces[0]));
  assert.ok(Object.isFrozen(normalized.resolutions));

  assert.throws(() => normalizeProjectModel({ ...model(), extra: true }), /unknown.*extra/i);
  assert.throws(() => normalizeProjectModel(Object.assign(Object.create(null), model())), /plain object/i);
  assert.throws(() => normalizeProjectModel(Object.assign(new (class Project {})(), model())), /plain object/i);
  const accessor = model();
  Object.defineProperty(accessor, 'description', { enumerable: true, get: () => 'surprise' });
  assert.throws(() => normalizeProjectModel(accessor), /accessor/i);
  const symbolic = model();
  symbolic[Symbol('extra')] = true;
  assert.throws(() => normalizeProjectModel(symbolic), /symbol/i);
  const arrayAccessor = model();
  Object.defineProperty(arrayAccessor.devCommands, '0', {
    enumerable: true,
    get: () => 'npm test',
  });
  assert.throws(() => normalizeProjectModel(arrayAccessor), /accessor/i);
});

test('normalizer enforces exact safe values, unique surfaces, and single-line fields', () => {
  assert.throws(() => normalizeProjectModel(model({ projectName: 'Nope' })), /projectName/i);
  assert.throws(() => normalizeProjectModel(model({ description: 'one\ntwo' })), /description/i);
  assert.throws(() => normalizeProjectModel(model({ devCommands: ['ok\rno'] })), /devCommands/i);
  assert.throws(() => normalizeProjectModel(model({ devCommands: [''] })), /devCommands\[0\].*non-empty/i);
  assert.throws(() => normalizeProjectModel(model({ devCommands: ['echo `date`'] })), /devCommands\[0\].*backtick/i);
  assert.deepEqual(normalizeProjectModel(model({
    devCommands: ["printf 'café 😀' && echo $PATH"],
  })).devCommands, ["printf 'café 😀' && echo $PATH"]);
  assert.equal(normalizeProjectModel(model({
    surfaces: [{
      name: 'web', path: 'apps/web', agent: 'web-agent',
      testCmd: 'node -e "console.log(`café 😀`)"',
    }],
  })).surfaces[0].testCmd, 'node -e "console.log(`café 😀`)"');
  for (const testCmd of ['```', '````', ' ```', '   `````   ']) {
    assert.throws(() => normalizeProjectModel(model({
      surfaces: [{ name: 'web', path: 'apps/web', agent: 'web-agent', testCmd }],
    })), /testCmd.*Markdown fence/i);
  }
  assert.throws(() => normalizeProjectModel(model({
    surfaces: [{ name: 'web', path: '../web', agent: 'web-agent', testCmd: 'npm test' }],
  })), /path/i);
  for (const path of ['apps/we b', 'apps/we#b', 'apps/we`b']) {
    assert.throws(() => normalizeProjectModel(model({
      surfaces: [{ name: 'web', path, agent: 'web-agent', testCmd: 'npm test' }],
    })), /path/i, path);
  }
  assert.throws(() => normalizeProjectModel(model({
    surfaces: [
      { name: 'api', path: 'apps/shared', agent: 'api-agent', testCmd: 'npm test' },
      { name: 'web', path: 'apps/shared', agent: 'web-agent', testCmd: 'npm test' },
    ],
  })), /duplicate.*path/i);
  const poisonedResolutions = {};
  Object.defineProperty(poisonedResolutions, '__proto__', {
    value: 'replace',
    enumerable: true,
  });
  assert.throws(() => planProjectScaffold({
    hubRoot: tempHub(),
    model: model({ resolutions: poisonedResolutions }),
    templatesDir,
  }), /resolution.*current conflict/i);
});

test('Project rejects unrepresentable surface test commands before planning or writes', () => {
  const hubRoot = tempHub();
  put(hubRoot, 'sentinel.txt', 'KEEP\n');
  const before = snapshot(hubRoot);
  for (const testCmd of ['node --test \ud800', 'node --test \udfff']) {
    const invalid = model({
      surfaces: [{ name: 'web', path: 'apps/web', agent: 'web-agent', testCmd }],
    });
    assert.throws(() => normalizeProjectModel(invalid), /testCmd.*UTF-8/i);
    assert.throws(
      () => planProjectScaffold({ hubRoot, model: invalid, templatesDir }),
      /testCmd.*UTF-8/i,
    );
    assert.deepEqual(snapshot(hubRoot), before);
  }
});

test('managed Project parsing treats the fixed description slot as data', () => {
  for (const description of [
    '',
    '## Development commands',
    '## Confirmed surfaces',
    '## Project navigation',
  ]) {
    const normalized = normalizeProjectModel(model({ description }));
    const rendered = renderProjectArtifact('project-instructions', normalized, templatesDir);
    const parsed = parseProjectInstructions(rendered, templatesDir);
    assert.deepEqual(parsed, {
      projectName: normalized.projectName,
      description,
      devCommands: normalized.devCommands,
      surfaces: normalized.surfaces.map(({ name, path, agent }) => ({
        name, path, agent, testCmd: '',
      })),
      resolutions: {},
    }, description || '<empty>');
  }
});

test('literal managed Project provenance delimiters are rejected before planning writes', () => {
  const hubRoot = tempHub();
  put(hubRoot, 'sentinel.txt', 'KEEP\n');
  const before = snapshot(hubRoot);
  for (const description of [
    '<!-- steepy:managed:project-instructions:v1:start -->',
    '<!-- steepy:managed:project-instructions:v1:end -->',
  ]) {
    assert.throws(() => normalizeProjectModel(model({ description })), /managed Project.*marker/i);
    assert.throws(
      () => planProjectScaffold({ hubRoot, model: model({ description }), templatesDir }),
      /managed Project.*marker/i,
    );
    assert.deepEqual(snapshot(hubRoot), before);
  }
});

test('root free text rejects every managed Project marker shape recognized by classification', () => {
  const hubRoot = tempHub();
  put(hubRoot, 'sentinel.txt', 'KEEP\n');
  const before = snapshot(hubRoot);
  const cases = [
    {
      label: 'description',
      input: '<!-- steepy:managed:project-instructions:v2:start -->',
      value: model({ description: '<!-- steepy:managed:project-instructions:v2:start -->' }),
    },
    {
      label: 'devCommands[0]',
      input: 'echo <!-- steepy:managed:project-instructions:v2:start -->',
      value: model({ devCommands: ['echo <!-- steepy:managed:project-instructions:v2:start -->'] }),
    },
  ];

  for (const { label, input, value } of cases) {
    assert.throws(
      () => normalizeProjectModel(value),
      new RegExp(`${label.replace('[', '\\[').replace(']', '\\]')}.*managed Project`, 'i'),
      input,
    );
    assert.throws(
      () => planProjectScaffold({ hubRoot, model: value, templatesDir }),
      /managed Project/i,
      input,
    );
    assert.deepEqual(snapshot(hubRoot), before, input);
  }
});

test('planning rejects a root template whose rendered projection cannot round-trip', () => {
  const hubRoot = tempHub();
  const divergentTemplates = join(tempHub(), 'templates');
  cpSync(templatesDir, divergentTemplates, { recursive: true });
  const agentsTemplate = join(divergentTemplates, 'AGENTS.md');
  writeFileSync(agentsTemplate, readFileSync(agentsTemplate, 'utf8')
    .replace('{{description}}', 'different description'));

  assert.throws(
    () => planRootInstructions({ hubRoot, model: model({ surfaces: [] }), templatesDir: divergentTemplates }),
    /root projection.*round-trip/i,
  );
  assert.deepEqual(snapshot(hubRoot), []);
});

test('normalizer rejects numeric-looking named properties on both model arrays', () => {
  for (const property of ['01', '1e0']) {
    const devModel = model();
    Object.defineProperty(devModel.devCommands, property, {
      value: 'ignored command',
      enumerable: true,
    });
    assert.throws(
      () => normalizeProjectModel(devModel),
      /devCommands.*unknown/i,
      `devCommands.${property}`,
    );

    const surfaceModel = model();
    Object.defineProperty(surfaceModel.surfaces, property, {
      value: surfaceModel.surfaces[0],
      enumerable: true,
    });
    assert.throws(
      () => normalizeProjectModel(surfaceModel),
      /surfaces.*unknown/i,
      `surfaces.${property}`,
    );
  }
});

test('empty hub produces an exact frozen plan ordered root, bootstrap, then surface triads', () => {
  const hubRoot = tempHub();
  const unordered = model({
    surfaces: [
      { name: 'web', path: 'apps/web', agent: 'web-agent', testCmd: 'npm test' },
      { name: 'api', path: 'apps/api', agent: 'api-agent', testCmd: 'npm test -- api' },
    ],
  });
  const plan = planProjectScaffold({ hubRoot, model: unordered, templatesDir });

  assert.deepEqual(Object.keys(plan), ['schemaVersion', 'operations', 'conflicts']);
  assert.equal(plan.schemaVersion, 1);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.operations.map(({ artifactId }) => artifactId), [
    'project-instructions',
    'claude-import',
    'project-bootstrap',
    'claude-bootstrap-stub',
    'api-agent-claude',
    'api-agent-codex',
    'api-agent-opencode',
    'web-agent-claude',
    'web-agent-codex',
    'web-agent-opencode',
  ]);
  assert.deepEqual(plan.operations.map(({ path }) => path), [
    'AGENTS.md',
    'CLAUDE.md',
    '.agents/skills/portable-demo-bootstrap/SKILL.md',
    '.claude/skills/portable-demo-bootstrap/SKILL.md',
    '.claude/agents/api-agent.md',
    '.codex/agents/api-agent.toml',
    '.opencode/agents/api-agent.md',
    '.claude/agents/web-agent.md',
    '.codex/agents/web-agent.toml',
    '.opencode/agents/web-agent.md',
  ]);
  for (const operation of plan.operations) {
    assert.deepEqual(Object.keys(operation), [
      'id', 'kind', 'artifactId', 'path', 'priorState', 'priorDigest', 'content',
    ]);
    assert.equal(operation.id, `v1:op:${operation.artifactId}`);
    assert.equal(operation.kind, 'create');
    assert.equal(operation.priorState, 'absent');
    assert.equal(operation.priorDigest, null);
  }
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.operations));
  assert.ok(Object.isFrozen(plan.operations[0]));
});

test('surface input order leaves the plan, preview, and render output byte-identical', () => {
  const hubRoot = tempHub();
  const surfaces = [
    { name: 'web', path: 'apps/web', agent: 'web-agent', testCmd: 'npm test' },
    { name: 'api', path: 'apps/api', agent: 'api-agent', testCmd: 'npm test -- api' },
  ];
  const a = planProjectScaffold({ hubRoot, model: model({ surfaces }), templatesDir });
  const b = planProjectScaffold({ hubRoot, model: model({ surfaces: [...surfaces].reverse() }), templatesDir });
  assert.deepEqual(a, b);
  assert.deepEqual(previewProjectScaffold(a), previewProjectScaffold(b));
  assert.equal(
    renderProjectArtifact('api-agent-codex', normalizeProjectModel(model({ surfaces }))),
    renderProjectArtifact('api-agent-codex', normalizeProjectModel(model({ surfaces: [...surfaces].reverse() }))),
  );
});

test('planner and validator share surface-name ordering when agent names sort in reverse', () => {
  const hubRoot = tempHub();
  const reversedNames = model({
    surfaces: [
      { name: 'beta', path: 'apps/beta', agent: 'a-agent', testCmd: 'npm test -- beta' },
      { name: 'alpha', path: 'apps/alpha', agent: 'z-agent', testCmd: 'npm test -- alpha' },
    ],
  });
  const plan = planProjectScaffold({ hubRoot, model: reversedNames, templatesDir });
  assert.deepEqual(plan.operations.slice(4).map(({ artifactId }) => artifactId), [
    'z-agent-claude', 'z-agent-codex', 'z-agent-opencode',
    'a-agent-claude', 'a-agent-codex', 'a-agent-opencode',
  ]);
  assert.equal(validateProjectScaffoldPlan(plan), plan);
  assert.deepEqual(previewProjectScaffold(plan).map(({ path }) => path), plan.operations.map(({ path }) => path));
  assert.deepEqual(applyProjectScaffold({ hubRoot, plan }).paths, plan.operations.map(({ path }) => path));
  const mtimes = Object.fromEntries(plan.operations.map(({ path }) => [path, statSync(join(hubRoot, path)).mtimeMs]));
  const noOp = planProjectScaffold({ hubRoot, model: reversedNames, templatesDir });
  assert.deepEqual(noOp.operations, []);
  assert.deepEqual(applyProjectScaffold({ hubRoot, plan: noOp }), { applied: 0, paths: [] });
  assert.deepEqual(
    Object.fromEntries(Object.keys(mtimes).map((path) => [path, statSync(join(hubRoot, path)).mtimeMs])),
    mtimes,
  );
});

test('preview is derived from the plan, omits content, preserves order, freezes, and performs zero I/O', () => {
  const hubRoot = tempHub();
  put(hubRoot, 'keep.txt', 'unchanged\n');
  const before = snapshot(hubRoot);
  const plan = planProjectScaffold({ hubRoot, model: model(), templatesDir });
  const afterPlan = snapshot(hubRoot);
  const preview = previewProjectScaffold(plan);
  const afterPreview = snapshot(hubRoot);

  assert.deepEqual(afterPlan, before);
  assert.deepEqual(afterPreview, before);
  assert.deepEqual(preview, plan.operations.map(({ id, kind, artifactId, path, priorState }) => ({
    id, kind, artifactId, path, priorState,
  })));
  assert.ok(Object.isFrozen(preview));
  assert.ok(Object.isFrozen(preview[0]));
  assert.ok(!('preview' in plan));
});

test('mixed root artifacts preserve BOM and original LF/CRLF bytes outside managed blocks', () => {
  for (const [label, prefix, eol] of [
    ['LF', '# User instructions\n', '\n'],
    ['CRLF+BOM', '\ufeff# User instructions\r\n', '\r\n'],
  ]) {
    const hubRoot = tempHub();
    put(hubRoot, 'AGENTS.md', prefix);
    put(hubRoot, 'CLAUDE.md', prefix);
    const plan = planProjectScaffold({ hubRoot, model: model(), templatesDir });
    const agents = plan.operations.find(({ artifactId }) => artifactId === 'project-instructions');
    const claude = plan.operations.find(({ artifactId }) => artifactId === 'claude-import');
    assert.equal(agents.priorState, 'unmarked', label);
    assert.equal(claude.priorState, 'unmarked', label);
    assert.ok(agents.content.startsWith(prefix), label);
    assert.ok(claude.content.startsWith(prefix), label);
    assert.equal(agents.content.includes(eol), true, label);
    if (eol === '\r\n') assert.doesNotMatch(agents.content.replaceAll('\r\n', ''), /\n/, label);
  }
});

test('exact managed blocks are current while malformed and unmanaged imports are closed conflicts', () => {
  const normalized = normalizeProjectModel(model());
  const hubRoot = tempHub();
  put(hubRoot, 'AGENTS.md', renderProjectArtifact('project-instructions', normalized));
  put(hubRoot, 'CLAUDE.md', '@AGENTS.md\n');
  const plan = planProjectScaffold({ hubRoot, model: model(), templatesDir });
  assert.equal(plan.operations.some(({ artifactId }) => artifactId === 'project-instructions'), false);
  assert.deepEqual(plan.conflicts.find(({ artifactId }) => artifactId === 'claude-import'), {
    id: 'v1:claude-import:unmanaged-import',
    artifactId: 'claude-import',
    path: 'CLAUDE.md',
    reason: 'unmanaged-import',
    choices: ['adopt', 'abort'],
  });

  const adopted = planProjectScaffold({
    hubRoot,
    model: model({ resolutions: { 'v1:claude-import:unmanaged-import': 'adopt' } }),
    templatesDir,
  });
  assert.equal(adopted.conflicts.some(({ artifactId }) => artifactId === 'claude-import'), false);
  const adoption = adopted.operations.find(({ artifactId }) => artifactId === 'claude-import');
  assert.equal(adoption.kind, 'replace-managed');
  assert.equal(adoption.priorState, 'unmarked');
  assert.equal(adoption.content, renderProjectArtifact('claude-import', normalized, templatesDir));
  assert.throws(() => planProjectScaffold({
    hubRoot,
    model: model({ resolutions: { 'v1:claude-import:unmanaged-import': 'replace' } }),
    templatesDir,
  }), /resolution.*not offered/i);

  put(hubRoot, 'AGENTS.md', '<!-- steepy:managed:project-instructions:v1:start -->\nbroken\n');
  const malformed = planProjectScaffold({ hubRoot, model: model(), templatesDir });
  assert.equal(
    malformed.conflicts.find(({ artifactId }) => artifactId === 'project-instructions').reason,
    'malformed-markers',
  );
});

test('unsupported root drift inside or outside the old marker block is customized and replaceable', () => {
  const normalized = normalizeProjectModel(model());
  const current = renderProjectArtifact('claude-import', normalized);
  const unsupported = '<!-- steepy:start -->\n## AI navigation\n<!-- steepy:end -->\n';
  const cases = [
    ['inside', unsupported.replace('## AI navigation', '## Changed navigation')],
    ['outside', `${unsupported} `],
  ];

  for (const [label, observed] of cases) {
    const hubRoot = tempHub();
    put(hubRoot, 'CLAUDE.md', observed);
    const conflictId = 'v1:claude-import:customized';
    const blocked = planProjectScaffold({ hubRoot, model: model(), templatesDir });
    assert.deepEqual(blocked.conflicts.find(({ id }) => id === conflictId), {
      id: conflictId,
      artifactId: 'claude-import',
      path: 'CLAUDE.md',
      reason: 'customized',
      choices: ['replace', 'abort'],
    }, label);
    assert.equal(blocked.operations.some(({ artifactId }) => artifactId === 'claude-import'), false, label);

    const resolved = planProjectScaffold({
      hubRoot,
      model: model({ resolutions: { [conflictId]: 'replace' } }),
      templatesDir,
    });
    assert.deepEqual(resolved.operations.find(({ artifactId }) => artifactId === 'claude-import'), {
      id: 'v1:op:claude-import',
      kind: 'replace-managed',
      artifactId: 'claude-import',
      path: 'CLAUDE.md',
      priorState: 'customized',
      priorDigest: createHash('sha256').update(observed).digest('hex'),
      content: current,
    }, label);
  }
});

test('v1 root blocks plus complete or partial unknown-version markers remain blocking', () => {
  const normalized = normalizeProjectModel(model());
  const current = renderProjectArtifact('project-instructions', normalized);
  const cases = [
    ['complete', `${current}<!-- steepy:managed:project-instructions:v2:start -->\nold\n<!-- steepy:managed:project-instructions:v2:end -->\n`],
    ['partial', `${current}<!-- steepy:managed:project-instructions:v2:start -->\n`],
  ];

  for (const [label, observed] of cases) {
    const hubRoot = tempHub();
    put(hubRoot, 'AGENTS.md', observed);
    const conflictId = 'v1:project-instructions:unknown-version';
    const blocked = planProjectScaffold({ hubRoot, model: model(), templatesDir });
    assert.deepEqual(blocked.conflicts.find(({ id }) => id === conflictId), {
      id: conflictId,
      artifactId: 'project-instructions',
      path: 'AGENTS.md',
      reason: 'unknown-version',
      choices: ['replace', 'abort'],
    }, label);
    assert.equal(blocked.operations.some(({ artifactId }) => artifactId === 'project-instructions'), false, label);

    const resolved = planProjectScaffold({
      hubRoot,
      model: model({ resolutions: { [conflictId]: 'replace' } }),
      templatesDir,
    });
    assert.deepEqual(resolved.operations.find(({ artifactId }) => artifactId === 'project-instructions'), {
      id: 'v1:op:project-instructions',
      kind: 'replace-managed',
      artifactId: 'project-instructions',
      path: 'AGENTS.md',
      priorState: 'malformed',
      priorDigest: createHash('sha256').update(observed).digest('hex'),
      content: current,
    }, label);
  }
});

test('unmarked pre-public artifacts are conflicts and never automatically migrated', () => {
  const hubRoot = tempHub();
  const paths = ['CLAUDE.md', '.claude/skills/portable-demo-bootstrap/SKILL.md', '.claude/agents/web-agent.md'];
  const contents = ['<!-- steepy:start -->\n## AI navigation\n<!-- steepy:end -->\n', '# portable-demo-bootstrap\n', '---\nname: web-agent\nmodel: sonnet\n---\n'];
  paths.forEach((path, index) => put(hubRoot, path, contents[index]));
  const before = snapshot(hubRoot);
  const plan = planProjectScaffold({ hubRoot, model: model(), templatesDir });
  for (const path of paths) assert.ok(plan.conflicts.some((conflict) => conflict.path === path));
  assert.throws(() => applyProjectScaffold({ hubRoot, plan }), /unresolved conflicts/i);
  assert.deepEqual(snapshot(hubRoot), before);
});




test('generated provenance detects customization, wrong targets, duplicates, and orphans', () => {
  const normalized = normalizeProjectModel(model());
  const hubRoot = tempHub();
  put(hubRoot, '.codex/agents/web-agent.toml',
    renderProjectArtifact('web-agent-codex', normalized).replace('Specialist agent', 'Changed agent'));
  put(hubRoot, '.opencode/agents/web-agent.md',
    renderProjectArtifact('web-agent-opencode', normalized).replace('web-agent-opencode', 'api-agent-opencode'));
  put(hubRoot, '.claude/agents/old-agent.md',
    '<!-- steepy:generated:old-agent-claude:v1 -->\n');
  const plan = planProjectScaffold({ hubRoot, model: model(), templatesDir });
  assert.equal(plan.conflicts.find(({ artifactId }) => artifactId === 'web-agent-codex').reason, 'customized');
  assert.equal(plan.conflicts.find(({ artifactId }) => artifactId === 'web-agent-opencode').reason, 'surface-mismatch');
  assert.equal(plan.conflicts.find(({ artifactId }) => artifactId === 'old-agent-claude').reason, 'orphan');
  assert.equal(plan.conflicts.filter(({ path }) => path === '.opencode/agents/web-agent.md').length, 1);

  put(hubRoot, '.opencode/agents/web-agent.md',
    renderProjectArtifact('web-agent-opencode', normalized).replace('web-agent-opencode', 'web-agent-codex'));
  const wrongTarget = planProjectScaffold({ hubRoot, model: model(), templatesDir });
  assert.equal(wrongTarget.conflicts.find(({ artifactId }) => artifactId === 'web-agent-opencode').reason, 'wrong-target');

  put(hubRoot, '.codex/agents/web-agent.toml',
    '# steepy:generated:web-agent-codex:v1\n# steepy:generated:web-agent-codex:v1\n');
  const duplicate = planProjectScaffold({ hubRoot, model: model(), templatesDir });
  assert.equal(duplicate.conflicts.find(({ artifactId }) => artifactId === 'web-agent-codex').reason, 'duplicate');
});

test('unsupported explicit Codex inheritance is refused without automatic repair', () => {
  const hubRoot = tempHub();
  applyProjectScaffold({ hubRoot, plan: planProjectScaffold({ hubRoot, model: model(), templatesDir }) });
  const path = '.codex/agents/web-agent.toml';
  const current = readFileSync(join(hubRoot, path), 'utf8');
  put(hubRoot, path, current.replace('developer_instructions = """', 'model = "inherit"\ndeveloper_instructions = """'));
  const before = snapshot(hubRoot);
  const plan = planProjectScaffold({ hubRoot, model: model(), templatesDir });
  assert.equal(plan.conflicts.find((item) => item.path === path)?.reason, 'customized');
  assert.throws(() => applyProjectScaffold({ hubRoot, plan }), /unresolved conflicts/i);
  assert.deepEqual(snapshot(hubRoot), before);
});


test('project-specific bootstrap provenance remains customized when canonical bytes drift', () => {
  const normalized = normalizeProjectModel(model());
  const cases = [
    [
      'project-bootstrap',
      '.agents/skills/portable-demo-bootstrap/SKILL.md',
      'Use this skill',
      'Use this customized skill',
    ],
    [
      'claude-bootstrap-stub',
      '.claude/skills/portable-demo-bootstrap/SKILL.md',
      'execute that canonical bootstrap exactly',
      'execute that customized bootstrap exactly',
    ],
  ];

  for (const [artifactId, path, before, after] of cases) {
    const hubRoot = tempHub();
    put(hubRoot, path, renderProjectArtifact(artifactId, normalized).replace(before, after));
    const conflict = planProjectScaffold({ hubRoot, model: model(), templatesDir })
      .conflicts.find((candidate) => candidate.artifactId === artifactId);
    assert.deepEqual(conflict, {
      id: `v1:${artifactId}:customized`,
      artifactId,
      path,
      reason: 'customized',
      choices: ['replace', 'abort'],
    });
  }
});

test('the rendered project-bootstrap artifact carries the inception boundary alongside the work-artifact boundary', () => {
  const normalized = normalizeProjectModel(model());
  const rendered = renderProjectArtifact('project-bootstrap', normalized, templatesDir);
  assert.match(rendered, /## Work-artifact boundary/);
  assert.match(rendered, /## Inception boundary/);
  assert.match(rendered, /Do not ordinarily enumerate, search, or read under `\.apex\/inception\/\*\*`/);
  assert.match(rendered, /inception boundary has no pathless recovery of its own/i);
  assert.doesNotMatch(rendered, /inception-handoff|inception-approval|inception-checkpoint|inception-promotion|inception-receipt/i);
  // The new section must not disturb the existing work-artifact boundary's exact text.
  assert.match(
    rendered,
    /accepted handoff\. A pathless workflow invocation may perform only bounded workflow-header recovery discovery\./,
  );
});

test('incomplete bootstrap content is refused without automatic migration', () => {
  const hubRoot = tempHub();
  const normalized = normalizeProjectModel(model());
  const path = '.agents/skills/portable-demo-bootstrap/SKILL.md';
  put(hubRoot, path, renderProjectArtifact('project-bootstrap', normalized).split('## Work-artifact boundary')[0].trimEnd() + '\n');
  const before = snapshot(hubRoot);
  const plan = planProjectScaffold({ hubRoot, model: model(), templatesDir });
  assert.equal(plan.conflicts.find((item) => item.path === path)?.reason, 'customized');
  assert.throws(() => applyProjectScaffold({ hubRoot, plan }), /unresolved conflicts/i);
  assert.deepEqual(snapshot(hubRoot), before);
});


test('malformed generated conflicts offer replace and resolve to exact current operations', () => {
  const normalized = normalizeProjectModel(model());
  const current = renderProjectArtifact('web-agent-codex', normalized);
  const cases = [
    ['unknown-version', current.replace(':v1', ':v2')],
    ['duplicate', '# steepy:generated:web-agent-codex:v1\n# steepy:generated:web-agent-codex:v1\n'],
  ];

  for (const [reason, observed] of cases) {
    const hubRoot = tempHub();
    put(hubRoot, '.codex/agents/web-agent.toml', observed);
    const conflictId = `v1:web-agent-codex:${reason}`;
    const blocked = planProjectScaffold({ hubRoot, model: model(), templatesDir });
    assert.deepEqual(
      blocked.conflicts.find(({ id }) => id === conflictId)?.choices,
      ['replace', 'abort'],
      reason,
    );

    const resolved = planProjectScaffold({
      hubRoot,
      model: model({ resolutions: { [conflictId]: 'replace' } }),
      templatesDir,
    });
    assert.equal(resolved.conflicts.some(({ id }) => id === conflictId), false, reason);
    assert.deepEqual(resolved.operations.find(({ artifactId }) => artifactId === 'web-agent-codex'), {
      id: 'v1:op:web-agent-codex',
      kind: 'replace-generated',
      artifactId: 'web-agent-codex',
      path: '.codex/agents/web-agent.toml',
      priorState: 'malformed',
      priorDigest: createHash('sha256').update(observed).digest('hex'),
      content: current,
    }, reason);
  }
});

test('classifier reports byte digest and specialist planner is read-only and triad ordered', () => {
  const normalized = normalizeProjectModel(model());
  const hubRoot = tempHub();
  const content = renderProjectArtifact('web-agent-claude', normalized);
  put(hubRoot, '.claude/agents/web-agent.md', content);
  const artifact = {
    artifactId: 'web-agent-claude',
    path: '.claude/agents/web-agent.md',
    content,
    type: 'generated',
  };
  const classified = classifyProjectArtifact({ hubRoot, artifact, normalizedModel: normalized });
  assert.equal(classified.priorState, 'current');
  assert.match(classified.priorDigest, /^[a-f0-9]{64}$/);

  const before = snapshot(hubRoot);
  const specialist = planSpecialistScaffold({
    hubRoot,
    surface: { ...normalized.surfaces[0], projectName: normalized.projectName, description: normalized.description },
    templatesDir,
    repair: true,
  });
  assert.deepEqual(specialist.operations.map(({ artifactId }) => artifactId), [
    'web-agent-codex', 'web-agent-opencode',
  ]);
  assert.deepEqual(snapshot(hubRoot), before);
});

test('plan validator rejects shape, ordering, placeholders, provenance, adapter syntax, and incoherent triads', () => {
  const plan = planProjectScaffold({ hubRoot: tempHub(), model: model(), templatesDir });
  assert.equal(validateProjectScaffoldPlan(plan), plan);

  const mutate = (operationIndex, changes) => ({
    ...plan,
    operations: plan.operations.map((operation, index) => (
      index === operationIndex ? { ...operation, ...changes } : operation
    )),
  });
  assert.throws(() => validateProjectScaffoldPlan({ ...plan, schemaVersion: 2 }), /schemaVersion/i);
  assert.throws(() => validateProjectScaffoldPlan({ ...plan, extra: true }), /unknown.*extra/i);
  assert.throws(() => validateProjectScaffoldPlan({ ...plan, operations: [...plan.operations].reverse() }), /order/i);
  assert.throws(() => validateProjectScaffoldPlan(mutate(0, { path: '../AGENTS.md' })), /path/i);
  assert.throws(() => validateProjectScaffoldPlan(mutate(0, {
    content: plan.operations[0].content.replace('# portable-demo', '# {{projectName}}'),
  })), /placeholder/i);
  assert.throws(() => validateProjectScaffoldPlan(mutate(4, {
    content: plan.operations[4].content.replace('web-agent-claude:v1', 'other-agent-claude:v1'),
  })), /provenance/i);
  assert.throws(() => validateProjectScaffoldPlan(mutate(5, {
    content: plan.operations[5].content.replace('name = "web-agent"', 'name web-agent'),
  })), /syntax/i);
  assert.throws(() => validateProjectScaffoldPlan(mutate(5, {
    content: plan.operations[5].content.replace(
      'developer_instructions = """',
      'model = "inherit"\ndeveloper_instructions = """',
    ),
  })), /syntax/i);
  assert.throws(() => validateProjectScaffoldPlan(mutate(6, { artifactId: 'api-agent-opencode' })), /triad|path|id/i);
  assert.throws(() => validateProjectScaffoldPlan(mutate(4, {
    content: plan.operations[4].content
      .replace('`web` surface at `apps/web`', '`api` surface at `apps/api`'),
  })), /triad/i);
});

test('Codex plan validation rejects every decoded top-level model key but permits model text inside instructions', () => {
  const plan = planProjectScaffold({ hubRoot: tempHub(), model: model(), templatesDir });
  const codexIndex = plan.operations.findIndex(({ artifactId }) => artifactId === 'web-agent-codex');
  const withCodexContent = (injected) => ({
    ...plan,
    operations: plan.operations.map((operation, index) => (
      index === codexIndex
        ? {
          ...operation,
          content: operation.content.replace(
            'developer_instructions = """',
            `${injected}\ndeveloper_instructions = """`,
          ),
        }
        : operation
    )),
  });

  for (const assignment of [
    '  model = "inherit"',
    '\tmodel = "inherit"',
    '"model" = "inherit"',
    "'model' = \"inherit\"",
    '"mo\\u0064el" = "inherit"',
    '"\\U0000006Dodel" = "inherit"',
  ]) {
    assert.throws(() => validateProjectScaffoldPlan(withCodexContent(assignment)), /syntax/i, assignment);
  }

  const instructionText = {
    ...plan,
    operations: plan.operations.map((operation, index) => (
      index === codexIndex
        ? {
          ...operation,
          content: operation.content.replace(
            'You are the web-agent specialist for the web surface.',
            'You are the web-agent specialist for the web surface.\nmodel = "content, not config"',
          ),
        }
        : operation
    )),
  };
  assert.equal(validateProjectScaffoldPlan(instructionText), instructionText);
});

test('apply rejects a quoted top-level Codex model key before writing any output', () => {
  const hubRoot = tempHub();
  const plan = planProjectScaffold({ hubRoot, model: model(), templatesDir });
  const before = snapshot(hubRoot);
  const untrusted = {
    ...plan,
    operations: plan.operations.map((operation) => (
      operation.artifactId === 'web-agent-codex'
        ? {
          ...operation,
          content: operation.content.replace(
            'developer_instructions = """',
            '"model" = "inherit"\ndeveloper_instructions = """',
          ),
        }
        : operation
    )),
  };

  assert.throws(() => applyProjectScaffold({ hubRoot, plan: untrusted }), /syntax/i);
  assert.deepEqual(snapshot(hubRoot), before);
});

test('apply rejects conflicts and stale targets before writing anything', () => {
  const hubRoot = tempHub();
  const plan = planProjectScaffold({ hubRoot, model: model(), templatesDir });
  put(hubRoot, 'AGENTS.md', 'concurrent edit\n');
  const before = snapshot(hubRoot);
  assert.throws(() => applyProjectScaffold({ hubRoot, plan }), /changed|digest|concurrent/i);
  assert.deepEqual(snapshot(hubRoot), before);

  const conflictPlan = { ...plan, operations: [], conflicts: [{
    id: 'v1:project-instructions:customized',
    artifactId: 'project-instructions',
    path: 'AGENTS.md',
    reason: 'customized',
    choices: ['replace', 'abort'],
  }] };
  assert.throws(() => applyProjectScaffold({ hubRoot, plan: conflictPlan }), /conflict/i);
  assert.deepEqual(snapshot(hubRoot), before);

  const escapeHub = tempHub();
  const escapePlan = planProjectScaffold({ hubRoot: escapeHub, model: model(), templatesDir });
  const escaped = {
    ...escapePlan,
    operations: escapePlan.operations.map((operation, index) => (
      index === 0 ? { ...operation, path: '../outside.md' } : operation
    )),
  };
  const escapeBefore = snapshot(escapeHub);
  assert.throws(() => applyProjectScaffold({ hubRoot: escapeHub, plan: escaped }), /path/i);
  assert.deepEqual(snapshot(escapeHub), escapeBefore);
});

test('apply blocks broken mounts, descendant symlinks and non-files with zero output writes', () => {
  for (const kind of ['target-symlink', 'ancestor-symlink', 'target-directory']) {
    const hubRoot = tempHub();
    const outside = tempHub();
    const plan = planProjectScaffold({ hubRoot, model: model(), templatesDir });
    if (kind === 'target-symlink') symlinkSync(join(outside, 'agents.md'), join(hubRoot, 'AGENTS.md'));
    if (kind === 'ancestor-symlink') {
      mkdirSync(join(hubRoot, '.agents'));
      symlinkSync(outside, join(hubRoot, '.agents', 'skills'));
    }
    if (kind === 'target-directory') mkdirSync(join(hubRoot, 'AGENTS.md'));
    const before = snapshot(outside);
    assert.throws(() => applyProjectScaffold({ hubRoot, plan }), /symlink|non-file|unsafe/i, kind);
    assert.deepEqual(snapshot(outside), before, kind);
    if (kind === 'ancestor-symlink') {
      assert.equal(lstatSync(join(hubRoot, '.agents', 'skills')).isSymbolicLink(), true, kind);
    } else {
      assert.equal(lstatSync(join(hubRoot, 'AGENTS.md')).isFile(), false, kind);
    }
  }
});

test('apply fails closed when a verified parent is swapped to a symlink before temp creation', () => {
  const hubRoot = tempHub();
  const outside = tempHub();
  const parent = join(hubRoot, '.agents', 'skills', 'portable-demo-bootstrap');
  const movedParent = join(hubRoot, 'verified-parent-backup');
  mkdirSync(parent, { recursive: true });
  const full = planProjectScaffold({ hubRoot, model: model(), templatesDir });
  const operation = full.operations.find(({ artifactId }) => artifactId === 'project-bootstrap');
  const plan = { schemaVersion: 1, operations: [operation], conflicts: [] };
  assert.throws(() => applyProjectScaffold({
    hubRoot,
    plan,
    checkpoint({ phase }) {
      if (phase !== 'before-stage') return;
      renameSync(parent, movedParent);
      symlinkSync(outside, parent);
    },
  }), /identity|TOCTOU|symlink/i);
  assert.deepEqual(snapshot(outside), []);
  assert.deepEqual(snapshot(movedParent), []);
});

test('apply rejects target replacement after staging before rename and cleans every temp', () => {
  const hubRoot = tempHub();
  const outside = tempHub();
  const target = join(hubRoot, 'AGENTS.md');
  const outsideTarget = join(outside, 'outside.md');
  writeFileSync(outsideTarget, 'outside sentinel\n');
  const full = planProjectScaffold({ hubRoot, model: model(), templatesDir });
  const plan = { schemaVersion: 1, operations: [full.operations[0]], conflicts: [] };
  assert.throws(() => applyProjectScaffold({
    hubRoot,
    plan,
    checkpoint({ phase }) {
      if (phase === 'after-staging') symlinkSync(outsideTarget, target);
    },
  }), /identity|TOCTOU|symlink/i);
  assert.equal(readFileSync(outsideTarget, 'utf8'), 'outside sentinel\n');
  assert.equal(lstatSync(target).isSymbolicLink(), true);
  assert.equal(snapshot(hubRoot).some((entry) => entry.includes('.steepy-project-scaffold-')), false);
});

test('apply detects a same-byte target identity replacement after staging', () => {
  const hubRoot = tempHub();
  const normalized = normalizeProjectModel(model());
  const current = renderProjectArtifact('project-instructions', normalized);
  const customized = current.replace('# portable-demo', '# customized');
  put(hubRoot, 'AGENTS.md', customized);
  const conflictId = 'v1:project-instructions:customized';
  const full = planProjectScaffold({
    hubRoot,
    model: model({ resolutions: { [conflictId]: 'replace' } }),
    templatesDir,
  });
  const operation = full.operations.find(({ artifactId }) => artifactId === 'project-instructions');
  const plan = { schemaVersion: 1, operations: [operation], conflicts: [] };
  const target = join(hubRoot, 'AGENTS.md');
  const replacement = join(hubRoot, '.same-byte-replacement');
  const originalIno = statSync(target).ino;
  assert.throws(() => applyProjectScaffold({
    hubRoot,
    plan,
    checkpoint({ phase }) {
      if (phase !== 'after-staging') return;
      writeFileSync(replacement, customized);
      renameSync(replacement, target);
    },
  }), /identity|TOCTOU/i);
  assert.notEqual(statSync(target).ino, originalIno);
  assert.equal(readFileSync(target, 'utf8'), customized);
  assert.equal(snapshot(hubRoot).some((entry) => entry.includes('.steepy-project-scaffold-')), false);
});

test('a genuinely live repository lock owner cannot be stolen and contention writes no scaffold output', async () => {
  const hubRoot = tempHub();
  const lockPath = join(hubRoot, '.steepy-project-scaffold.lock');
  const readyPath = join(tempHub(), 'ready');
  const child = spawn(process.execPath, lockOwnerChildArgs(hubRoot, 'hold', readyPath), {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await waitForFile(readyPath, child, () => stderr);

  const plan = planProjectScaffold({ hubRoot, model: model(), templatesDir });
  const before = snapshot(hubRoot);
  try {
    const owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'));
    assert.deepEqual(Object.keys(owner), ['schemaVersion', 'pid', 'token']);
    assert.equal(owner.schemaVersion, 1);
    assert.equal(owner.pid, child.pid);
    assert.match(owner.token, /^[a-f0-9]{32}$/u);
    assert.throws(() => applyProjectScaffold({ hubRoot, plan }), /lock|already.*apply/i);
    assert.deepEqual(snapshot(hubRoot), before);
    assert.equal(snapshot(hubRoot).some((entry) => entry.includes('.steepy-project-scaffold-')), false);
    assert.equal(existsSync(join(hubRoot, 'AGENTS.md')), false);
  } finally {
    await killAndWait(child);
  }

  assert.equal(applyProjectScaffold({ hubRoot, plan }).applied, plan.operations.length);
  assert.equal(existsSync(lockPath), false);
});

test('one exclusive repository lock is held across preflight, staging, validation, rename, and cleanup', () => {
  const hubRoot = tempHub();
  const lockPath = join(hubRoot, '.steepy-project-scaffold.lock');
  const plan = planProjectScaffold({ hubRoot, model: model(), templatesDir });
  const phases = [];
  let lockIdentity;
  const result = applyProjectScaffold({
    hubRoot,
    plan,
    checkpoint({ phase }) {
      phases.push(phase);
      const stat = lstatSync(lockPath, { bigint: true });
      assert.equal(stat.isDirectory(), true, phase);
      assert.equal(stat.isSymbolicLink(), false, phase);
      const identity = `${stat.dev}:${stat.ino}`;
      if (lockIdentity === undefined) lockIdentity = identity;
      assert.equal(identity, lockIdentity, phase);
      const owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'));
      assert.deepEqual(Object.keys(owner), ['schemaVersion', 'pid', 'token'], phase);
      assert.equal(owner.pid, process.pid, phase);
    },
  });
  assert.equal(result.applied, plan.operations.length);
  assert.deepEqual(phases, [
    'lock-acquired', 'before-stage', 'after-staging', 'before-rename', 'before-lock-release',
  ]);
  assert.equal(existsSync(lockPath), false);
});

test('repository lock releases deterministically on success and staged error cleanup', () => {
  for (const outcome of ['success', 'error']) {
    const hubRoot = tempHub();
    const lockPath = join(hubRoot, '.steepy-project-scaffold.lock');
    const plan = planProjectScaffold({ hubRoot, model: model(), templatesDir });
    const releasePhases = [];
    const run = () => applyProjectScaffold({
      hubRoot,
      plan,
      checkpoint({ phase }) {
        assert.equal(lstatSync(lockPath).isDirectory(), true, `${outcome}:${phase}`);
        assert.equal(lstatSync(join(lockPath, 'owner.json')).isFile(), true, `${outcome}:${phase}`);
        if (phase === 'before-lock-release') releasePhases.push(phase);
        if (outcome === 'error' && phase === 'after-staging') throw new Error('forced staged error');
      },
    });
    if (outcome === 'error') assert.throws(run, /forced staged error/);
    else assert.equal(run().applied, plan.operations.length);
    assert.deepEqual(releasePhases, ['before-lock-release'], outcome);
    assert.equal(existsSync(lockPath), false, outcome);
    assert.equal(snapshot(hubRoot).some((entry) => entry.includes('.steepy-project-scaffold-')), false, outcome);
    if (outcome === 'error') {
      assert.equal(existsSync(join(hubRoot, 'AGENTS.md')), false);
      assert.equal(existsSync(join(hubRoot, 'CLAUDE.md')), false);
    }
  }
});

test('an abruptly terminated lock owner resumes idempotently from its first completed operation', () => {
  const hubRoot = tempHub();
  const lockPath = join(hubRoot, '.steepy-project-scaffold.lock');
  const original = planProjectScaffold({ hubRoot, model: model(), templatesDir });
  const interrupted = spawnSync(process.execPath, lockOwnerChildArgs(hubRoot, 'interrupt-first'), {
    encoding: 'utf8',
  });
  assert.notEqual(interrupted.status, 0, interrupted.stderr);
  assert.equal(existsSync(join(hubRoot, 'AGENTS.md')), true);
  assert.equal(existsSync(lockPath), true);
  const firstStat = statSync(join(hubRoot, 'AGENTS.md'));

  const resumed = applyProjectScaffold({ hubRoot, plan: original });
  assert.deepEqual(resumed, {
    applied: original.operations.length - 1,
    paths: original.operations.slice(1).map(({ path }) => path),
  });
  const resumedFirstStat = statSync(join(hubRoot, 'AGENTS.md'));
  assert.equal(resumedFirstStat.mtimeMs, firstStat.mtimeMs);
  assert.equal(resumedFirstStat.ino, firstStat.ino);
  assert.equal(snapshot(hubRoot).some((entry) => entry.includes('.steepy-project-scaffold-')), false);
  assert.equal(snapshot(hubRoot).some((entry) => entry.startsWith('.steepy-project-scaffold.lock')), false);
  assert.equal(existsSync(lockPath), false);
});

test('apply stages the complete set, applies in plan order, and cleans sibling temps', () => {
  const hubRoot = tempHub();
  const plan = planProjectScaffold({ hubRoot, model: model(), templatesDir });
  const result = applyProjectScaffold({ hubRoot, plan });
  assert.deepEqual(result, {
    applied: plan.operations.length,
    paths: plan.operations.map(({ path }) => path),
  });
  for (const operation of plan.operations) {
    assert.equal(readFileSync(join(hubRoot, operation.path), 'utf8'), operation.content);
  }
  assert.equal(snapshot(hubRoot).some((entry) => entry.includes('.steepy-project-scaffold-')), false);
});

test('a staged-set write failure performs deterministic sibling-temp cleanup before any rename', () => {
  const hubRoot = tempHub();
  const plan = planProjectScaffold({ hubRoot, model: model(), templatesDir });
  const locked = join(hubRoot, '.agents', 'skills', 'portable-demo-bootstrap');
  mkdirSync(locked, { recursive: true });
  chmodSync(locked, 0o555);
  try {
    assert.throws(() => applyProjectScaffold({ hubRoot, plan }), /EACCES|permission denied/i);
    assert.equal(snapshot(hubRoot).some((entry) => entry.includes('.steepy-project-scaffold-')), false);
    assert.equal(snapshot(hubRoot).some((entry) => entry.startsWith('AGENTS.md:')), false);
    assert.equal(snapshot(hubRoot).some((entry) => entry.startsWith('CLAUDE.md:')), false);
  } finally {
    chmodSync(locked, 0o755);
  }
});

test('interrupted rerun skips current outputs and full-tree no-op preserves timestamps', () => {
  const hubRoot = tempHub();
  const original = planProjectScaffold({ hubRoot, model: model(), templatesDir });
  const firstOnly = { ...original, operations: [original.operations[0]] };
  assert.deepEqual(applyProjectScaffold({ hubRoot, plan: firstOnly }), {
    applied: 1,
    paths: ['AGENTS.md'],
  });
  const firstMtime = statSync(join(hubRoot, 'AGENTS.md')).mtimeMs;
  const resumed = applyProjectScaffold({ hubRoot, plan: original });
  assert.equal(resumed.applied, original.operations.length - 1);
  assert.equal(resumed.paths.includes('AGENTS.md'), false);
  assert.equal(statSync(join(hubRoot, 'AGENTS.md')).mtimeMs, firstMtime);

  const noOp = planProjectScaffold({ hubRoot, model: model(), templatesDir });
  assert.deepEqual(noOp.operations, []);
  const before = Object.fromEntries(snapshot(hubRoot).map((entry) => {
    const path = entry.slice(0, entry.indexOf(':'));
    return [path, statSync(join(hubRoot, path)).mtimeMs];
  }));
  assert.deepEqual(applyProjectScaffold({ hubRoot, plan: noOp }), { applied: 0, paths: [] });
  const after = Object.fromEntries(Object.keys(before).map((path) => [path, statSync(join(hubRoot, path)).mtimeMs]));
  assert.deepEqual(after, before);
});

test('CLI emits deterministic preview/applied JSONL and rejects misuse without writes', () => {
  const script = join(here, '..', 'scripts', 'project-scaffold.mjs');
  const run = (args, options = {}) => spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    ...options,
  });

  const previewHub = tempHub();
  const modelPath = join(previewHub, 'model.json');
  writeFileSync(modelPath, JSON.stringify(model()));
  const preview = run(['--hub', previewHub, '--model', modelPath]);
  assert.equal(preview.status, 0, preview.stderr);
  const previewLines = preview.stdout.trimEnd().split('\n').map(JSON.parse);
  assert.equal(previewLines.length, 1);
  assert.deepEqual(Object.keys(previewLines[0]), ['schemaVersion', 'event', 'preview', 'conflicts']);
  assert.equal(previewLines[0].event, 'preview');
  assert.equal(snapshot(previewHub).filter((entry) => !entry.startsWith('model.json:')).length, 0);

  const applied = run(['--hub', previewHub, '--model', modelPath, '--apply'], { input: 'abort\n' });
  assert.equal(applied.status, 0, applied.stderr);
  const appliedLines = applied.stdout.trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(appliedLines.map(({ event }) => event), ['preview', 'applied']);
  assert.equal(appliedLines[1].result.applied > 0, true);

  for (const args of [
    [],
    ['--hub', previewHub],
    ['--model', modelPath, '--unknown'],
    ['--model', modelPath, '--apply=yes'],
  ]) {
    const badHub = tempHub();
    const before = snapshot(badHub);
    const result = run(args.map((arg) => arg === previewHub ? badHub : arg));
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.deepEqual(snapshot(badHub), before);
  }
});

test('CLI rejects reproduced unknown-version Project markers before preview or apply writes', async (t) => {
  const script = join(here, '..', 'scripts', 'project-scaffold.mjs');
  const cases = [
    ['description', model({ description: '<!-- steepy:managed:project-instructions:v2:start -->' })],
    ['dev command', model({
      devCommands: ['echo <!-- steepy:managed:project-instructions:v2:start -->'],
    })],
  ];

  for (const [label, input] of cases) {
    await t.test(label, () => {
      const hubRoot = tempHub();
      const modelPath = join(hubRoot, 'model.json');
      writeFileSync(modelPath, JSON.stringify(input));
      const before = snapshot(hubRoot);
      const result = spawnSync(process.execPath, [
        script, '--hub', hubRoot, '--model', modelPath, '--apply',
      ], { encoding: 'utf8' });

      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /managed Project/i);
      assert.deepEqual(snapshot(hubRoot), before);
    });
  }
});

test('CLI unresolved conflicts emit preview only and resolved choices apply without stdin', () => {
  const script = join(here, '..', 'scripts', 'project-scaffold.mjs');
  const hubRoot = tempHub();
  const customized = renderProjectArtifact('project-instructions', normalizeProjectModel(model()))
    .replace('# portable-demo', '# customized');
  put(hubRoot, 'AGENTS.md', customized);
  const modelPath = join(hubRoot, 'model.json');
  writeFileSync(modelPath, JSON.stringify(model()));
  const blocked = spawnSync(process.execPath, [script, '--hub', hubRoot, '--model', modelPath, '--apply'], {
    encoding: 'utf8',
    input: 'replace\n',
  });
  assert.equal(blocked.status, 1);
  assert.deepEqual(blocked.stdout.trimEnd().split('\n').map(JSON.parse).map(({ event }) => event), ['preview']);
  assert.equal(readFileSync(join(hubRoot, 'AGENTS.md'), 'utf8'), customized);

  const conflictId = 'v1:project-instructions:customized';
  writeFileSync(modelPath, JSON.stringify(model({ resolutions: { [conflictId]: 'replace' } })));
  const resolved = spawnSync(process.execPath, [script, '--hub', hubRoot, '--model', modelPath, '--apply'], {
    encoding: 'utf8',
  });
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.deepEqual(resolved.stdout.trimEnd().split('\n').map(JSON.parse).map(({ event }) => event), ['preview', 'applied']);
  assert.match(readFileSync(join(hubRoot, 'AGENTS.md'), 'utf8'), /steepy:managed:project-instructions:v1:start/);
});

test('CLI diagnostics redact secret-like conflict IDs and never echo canary values', () => {
  const script = join(here, '..', 'scripts', 'project-scaffold.mjs');
  for (const id of ['token=token-canary', 'authorization:Bearer-auth-canary', 'env=env-canary', 'password=pw-canary']) {
    const hubRoot = tempHub();
    const modelPath = join(hubRoot, 'model.json');
    writeFileSync(modelPath, JSON.stringify(model({ resolutions: { [id]: 'replace' } })));
    const result = spawnSync(process.execPath, [script, '--hub', hubRoot, '--model', modelPath], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, id);
    assert.doesNotMatch(result.stderr, /(?:token|auth|env|pw)-canary/i, id);
    assert.equal(snapshot(hubRoot).filter((entry) => !entry.startsWith('model.json:')).length, 0, id);
  }
});

test('conflicts have closed provenance, coherent choices, canonical order, uniqueness, and operation disjointness', () => {
  const hubRoot = tempHub();
  const normalized = normalizeProjectModel(model());
  put(hubRoot, 'AGENTS.md', renderProjectArtifact('project-instructions', normalized)
    .replace('# portable-demo', '# customized'));
  put(hubRoot, 'CLAUDE.md', '@AGENTS.md\n');
  put(hubRoot, '.codex/agents/web-agent.toml', renderProjectArtifact('web-agent-codex', normalized)
    .replace('Specialist agent', 'Customized agent'));
  const base = planProjectScaffold({ hubRoot, model: model(), templatesDir });
  const ordered = [...base.conflicts].sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : left.id < right.id ? -1 : 1
  ));
  assert.deepEqual(base.conflicts, ordered);
  assert.equal(validateProjectScaffoldPlan(base), base);

  const invalidPlans = [
    {
      name: 'unknown artifact',
      plan: { ...base, conflicts: [{
        id: 'v1:bogus:customized', artifactId: 'bogus', path: 'wrong/path.md',
        reason: 'customized', choices: ['replace', 'abort'],
      }] },
    },
    {
      name: 'mismatched canonical target',
      plan: { ...base, conflicts: [{
        id: 'v1:project-instructions:customized', artifactId: 'project-instructions',
        path: 'wrong/path.md', reason: 'customized', choices: ['replace', 'abort'],
      }] },
    },
    {
      name: 'reason choice mismatch',
      plan: { ...base, conflicts: [{
        ...base.conflicts.find(({ artifactId }) => artifactId === 'project-instructions'),
        choices: ['adopt', 'abort'],
      }] },
    },
    {
      name: 'duplicate conflict id',
      plan: { ...base, conflicts: [base.conflicts[0], base.conflicts[0]] },
    },
    {
      name: 'duplicate orphan path',
      plan: { ...base, conflicts: [
        { id: 'v1:ghost-claude:orphan', artifactId: 'ghost-claude', path: '.claude/agents/shared.md', reason: 'orphan', choices: ['abort'] },
        { id: 'v1:other-claude:orphan', artifactId: 'other-claude', path: '.claude/agents/shared.md', reason: 'orphan', choices: ['abort'] },
      ] },
    },
    {
      name: 'noncanonical conflict order',
      plan: { ...base, conflicts: [...base.conflicts].reverse() },
    },
    {
      name: 'operation conflict overlap',
      plan: { ...base, conflicts: [{
        id: `v1:${base.operations[0].artifactId}:customized`,
        artifactId: base.operations[0].artifactId,
        path: base.operations[0].path,
        reason: 'customized',
        choices: ['replace', 'abort'],
      }] },
    },
    {
      name: 'orphan duplicate with replace choice',
      plan: { ...base, conflicts: [{
        id: 'v1:ghost-claude:duplicate', artifactId: 'ghost-claude',
        path: '.claude/agents/not-ghost.md', reason: 'duplicate', choices: ['replace', 'abort'],
      }] },
    },
    {
      name: 'unsafe reason on mismatched target',
      plan: { ...base, conflicts: [{
        id: 'v1:ghost-claude:unsafe-path', artifactId: 'ghost-claude',
        path: '.opencode/agents/not-ghost.md', reason: 'unsafe-path', choices: ['abort'],
      }] },
    },
    {
      name: 'orphan target outside bounded provider namespaces',
      plan: { ...base, conflicts: [{
        id: 'v1:ghost-claude:orphan', artifactId: 'ghost-claude',
        path: '.apex/agents/ghost.md', reason: 'orphan', choices: ['abort'],
      }] },
    },
    {
      name: 'orphan target at an unbounded top-level path',
      plan: { ...base, conflicts: [{
        id: 'v1:ghost-claude:orphan', artifactId: 'ghost-claude',
        path: 'generated/ghost.md', reason: 'orphan', choices: ['abort'],
      }] },
    },
    {
      name: 'adapter orphan target outside bounded provider namespaces',
      plan: { ...base, conflicts: [{
        id: 'v1:ghost-codex:orphan', artifactId: 'ghost-codex',
        path: 'archive/ghost.toml', reason: 'orphan', choices: ['abort'],
      }] },
    },
  ];

  for (const { name, plan } of invalidPlans) {
    const before = snapshot(hubRoot);
    assert.throws(() => previewProjectScaffold(plan), undefined, `${name}: preview`);
    assert.throws(() => applyProjectScaffold({ hubRoot, plan }), undefined, `${name}: apply`);
    assert.deepEqual(snapshot(hubRoot), before, `${name}: zero write`);
  }
});

function recordFsAccess(fn) {
  const names = ['openSync', 'readFileSync', 'readdirSync', 'opendirSync'];
  const originals = Object.fromEntries(names.map((name) => [name, fs[name]]));
  const accesses = [];
  try {
    for (const name of names) {
      fs[name] = function recorded(...args) {
        accesses.push({ name, path: String(args[0]) });
        return originals[name].apply(this, args);
      };
    }
    syncBuiltinESMExports();
    let result;
    let error;
    try { result = fn(); } catch (caught) { error = caught; }
    return { result, error, accesses };
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
}

function accessesUnder(accesses, directories) {
  return accesses.filter(({ path }) => directories.some((directory) => {
    const candidate = path.toLowerCase();
    const prefix = directory.toLowerCase();
    return candidate === prefix || candidate.startsWith(`${prefix}${sep}`);
  }));
}

test('planner provenance enumeration skips both local areas by name and physical identity, through mounts and linked areas', () => {
  for (const area of LOCAL_AREA_NAMES) {
    const hubRoot = tempHub();
    const outside = tempHub();
    try {
      put(hubRoot, `.apex/${area}/decoy.md`, `<!-- steepy:generated:${area}-sentinel:v1 -->\n`);
      symlinkSync('.apex', join(hubRoot, '.claude'), 'dir');
      const aliased = recordFsAccess(() => planProjectScaffold({ hubRoot, model: model(), templatesDir }));
      assert.equal(JSON.stringify(aliased.result.conflicts).includes(`${area}-sentinel`), false, area);
      assert.ok(aliased.result.operations.some(({ path }) => path === '.claude/agents/web-agent.md'), area);
      assert.deepEqual(accessesUnder(aliased.accesses, [
        join(hubRoot, '.apex', area), join(realpathSync.native(hubRoot), '.apex', area),
      ]), [], area);

      rmSync(join(hubRoot, '.apex', area), { recursive: true });
      put(outside, 'area-target/x.toml', `# steepy:generated:${area}-linked-sentinel:v1\n`);
      symlinkSync(join(outside, 'area-target'), join(hubRoot, '.apex', area), 'dir');
      symlinkSync(outside, join(hubRoot, '.codex'), 'dir');
      const linked = recordFsAccess(() => planProjectScaffold({ hubRoot, model: model(), templatesDir }));
      assert.match(linked.error?.message ?? '', new RegExp(`\\.codex/area-target aliases excluded \\.apex/${area}`, 'u'),
        `${area}: a provider directory aliased by a linked area is refused, never silently dropped`);
      assert.deepEqual(accessesUnder(linked.accesses, [
        join(outside, 'area-target'), join(realpathSync.native(outside), 'area-target'),
      ]), [], area);
    } finally {
      rmSync(hubRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }
});

test('a root instruction mount into inception is a planner symlink conflict whose target is never read', () => {
  const hubRoot = tempHub();
  try {
    const run = '0b6f1b8e-3c1a-4e2b-9f3d-5a7c9e1b2d4f';
    put(hubRoot, `.apex/inception/${run}/agents.md`, '# INCEPTION_MOUNT_BODY_SENTINEL\n');
    symlinkSync(`.apex/inception/${run}/agents.md`, join(hubRoot, 'AGENTS.md'));
    const { result, accesses } = recordFsAccess(() => planProjectScaffold({ hubRoot, model: model(), templatesDir }));
    assert.ok(result.conflicts.some(({ path, reason }) => path === 'AGENTS.md' && reason === 'symlink'),
      JSON.stringify(result.conflicts));
    assert.deepEqual(accessesUnder(accesses, [
      join(hubRoot, '.apex', 'inception'), join(realpathSync.native(hubRoot), '.apex', 'inception'),
    ]), []);
    assert.doesNotMatch(JSON.stringify(result), /INCEPTION_MOUNT_BODY_SENTINEL/u);
  } finally {
    rmSync(hubRoot, { recursive: true, force: true });
  }
});

test('I1: a provider directory aliased by a linked local area is refused before any canonical read', () => {
  for (const area of LOCAL_AREA_NAMES) {
    const hubRoot = tempHub();
    try {
      const canonical = renderProjectArtifact('web-agent-claude', normalizeProjectModel(model()));
      put(hubRoot, '.claude/agents/web-agent.md', canonical);
      put(hubRoot, '.claude/agents/nested/orphan.md', `<!-- steepy:generated:${area}-aliased-orphan:v1 -->\n`);
      mkdirSync(join(hubRoot, '.apex'), { recursive: true });
      symlinkSync('../.claude/agents', join(hubRoot, '.apex', area), 'dir');
      const { result, error, accesses } = recordFsAccess(() => planProjectScaffold({ hubRoot, model: model(), templatesDir }));
      assert.equal(result, undefined, area);
      assert.match(error?.message ?? '', new RegExp(`\\.claude/agents aliases excluded \\.apex/${area}`, 'u'), area);
      assert.deepEqual(accessesUnder(accesses, [
        join(hubRoot, '.claude', 'agents'), join(realpathSync.native(hubRoot), '.claude', 'agents'),
      ]), [], `${area}: nothing inside the aliased provider directory is read first`);
    } finally {
      rmSync(hubRoot, { recursive: true, force: true });
    }
  }
});

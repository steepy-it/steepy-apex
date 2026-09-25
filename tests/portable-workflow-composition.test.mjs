import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as newSurfaceMain } from '../scripts/new-surface.mjs';
import {
  applyProjectScaffold,
  countActiveClaudeImports,
  normalizeProjectModel,
  parseProjectInstructions,
  planProjectScaffold,
  planRootInstructions,
  previewProjectScaffold,
  renderProjectArtifact,
} from '../scripts/project-scaffold.mjs';
import { createInitialInceptionState, serializeInceptionState } from '../scripts/inception-state.mjs';
import { classifyHub, collectViolations, main as validateHubMain } from '../scripts/validate-hub.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, '..', 'templates');

function tempHub() {
  return mkdtempSync(join(tmpdir(), 'steepy-portable-composition-'));
}

function put(root, path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function surfaceStandard(name, path, testCmd) {
  return [
    `# ${name} — Technical Standard`,
    '',
    `> Owning surface: \`${path}\`. Read this before editing \`${path}\`.`,
    '',
    '## Scope',
    `- Owns: ${name}.`,
    '',
    '## Conventions',
    '- Keep changes local.',
    '',
    '## Anti-patterns',
    '- Do not broaden scope.',
    '',
    '## Testing',
    '```sh',
    testCmd,
    '```',
    '',
  ].join('\n');
}

function seedHub(model) {
  const hubRoot = tempHub();
  const rows = model.surfaces.map(({ name, agent }) => (
    `| \`${name}\` | [standards/${name}.md](standards/${name}.md) | \`${agent}\` | — |`
  ));
  put(hubRoot, '.apex/_INDEX.md', [
    '<!-- steepy-hub-version: 1 -->',
    '# Test hub',
    '',
    '## Routing Table',
    '',
    '| Surface | Min docs | Specialist agent | Applicable skill |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n'));
  for (const surface of model.surfaces) {
    mkdirSync(join(hubRoot, surface.path), { recursive: true });
    put(hubRoot, `.apex/standards/${surface.name}.md`,
      surfaceStandard(surface.name, surface.path, surface.testCmd));
  }
  const first = planProjectScaffold({ hubRoot, model, templatesDir });
  assert.deepEqual(first.conflicts, []);
  applyProjectScaffold({ hubRoot, plan: first });
  return hubRoot;
}

function fileState(root) {
  const entries = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        const stat = lstatSync(path);
        entries.push({
          path: relative(root, path),
          bytes: readFileSync(path),
          mode: stat.mode & 0o777,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  }
  walk(root);
  return entries;
}

function baseModel(overrides = {}) {
  return {
    projectName: 'portable-demo',
    description: 'Portable demo project.',
    devCommands: ['npm test'],
    surfaces: [
      { name: 'web', path: 'apps/web', agent: 'web-agent', testCmd: 'npm test' },
    ],
    resolutions: {},
    ...overrides,
  };
}

function captureNewSurface(argv) {
  const stdout = [];
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values) => stdout.push(values.join(' '));
  console.error = (...values) => stderr.push(values.join(' '));
  try {
    return { code: newSurfaceMain(argv), stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function captureValidateHub(argv) {
  const stdout = [];
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values) => stdout.push(values.join(' '));
  console.error = (...values) => stderr.push(values.join(' '));
  try {
    return { code: validateHubMain(argv), stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test('empty-description public apply composes with validation and an exact second no-op', () => {
  const model = baseModel({ description: '' });
  const hubRoot = seedHub(model);

  assert.deepEqual(collectViolations(hubRoot).filter(({ level }) => level === 'error'), []);
  const before = fileState(hubRoot);
  const second = planProjectScaffold({ hubRoot, model, templatesDir });
  assert.deepEqual(previewProjectScaffold(second), []);
  assert.deepEqual(second.operations, []);
  assert.deepEqual(second.conflicts, []);
  assert.deepEqual(applyProjectScaffold({ hubRoot, plan: second }), { applied: 0, paths: [] });
  assert.deepEqual(fileState(hubRoot), before);
});

test('producer, managed parser, and linter compose when description equals a reserved heading', () => {
  const model = baseModel({ description: '## Development commands' });
  const hubRoot = seedHub(model);
  const parsed = parseProjectInstructions(readFileSync(join(hubRoot, 'AGENTS.md'), 'utf8'), templatesDir);

  assert.equal(parsed.description, model.description);
  assert.deepEqual(parsed.surfaces, model.surfaces.map(({ name, path, agent }) => ({
    name, path, agent, testCmd: '',
  })));
  assert.deepEqual(collectViolations(hubRoot).filter(({ level }) => level === 'error'), []);
});

test('accepted near-marker root text composes through producer, parser, and provenance linter', () => {
  const model = baseModel({
    description: 'Document <!-- steepy:managed:project-instructions:v2:phase --> literally.',
    devCommands: ["echo '<!-- steepy:managed:project-instructions:v2:phase -->'"],
  });
  const hubRoot = seedHub(model);
  const parsed = parseProjectInstructions(readFileSync(join(hubRoot, 'AGENTS.md'), 'utf8'), templatesDir);

  assert.equal(parsed.description, model.description);
  assert.deepEqual(parsed.devCommands, model.devCommands);
  assert.deepEqual(collectViolations(hubRoot).filter(({ level }) => level === 'error'), []);
});

test('public repair refuses incomplete bootstrap bytes and preserves the full tree', () => {
  const model = baseModel();
  const hubRoot = seedHub(model);
  const path = '.agents/skills/portable-demo-bootstrap/SKILL.md';
  const current = readFileSync(join(hubRoot, path), 'utf8');
  writeFileSync(join(hubRoot, path), current.split('## Work-artifact boundary')[0].trimEnd() + '\n');
  const before = fileState(hubRoot);
  const plan = planProjectScaffold({ hubRoot, model, templatesDir });
  assert.ok(plan.conflicts.some(({ id }) => id === 'v1:project-bootstrap:customized'));
  assert.throws(() => applyProjectScaffold({ hubRoot, plan }), /unresolved conflicts/i);
  assert.ok(collectViolations(hubRoot).some(({ level }) => level === 'error'));
  assert.deepEqual(fileState(hubRoot), before);
});


// The canonical bootstrap every release from v1.0.0 through v1.0.4 rendered for
// `portable-demo` (the released template before its inception boundary section).
// validate-hub.test.mjs keeps the linter-side copy of these literal bytes; the
// duplication is deliberate so each suite stays hermetic.
const V1_0_PORTABLE_DEMO_BOOTSTRAP = [
  '---',
  'name: portable-demo-bootstrap',
  'description: Project entry point for portable-demo. Loads the root instructions and routes work through the governed hub.',
  'user-invocable: true',
  '---',
  '<!-- steepy:generated:portable-demo-bootstrap:v1 -->',
  '',
  '# portable-demo bootstrap',
  '',
  'Use this skill before working on the project.',
  '',
  '## Procedure',
  '',
  '1. Read `AGENTS.md` in full for the project overview, development commands, and confirmed surfaces.',
  '2. Read `.apex/_INDEX.md` in full for the routing table and semantic knowledge map.',
  '3. Match the task to the owning surface and read only the minimum documents named by its routing row.',
  '4. State the owning surface and specialist agent before changing files.',
  '5. When a Steepy workflow is needed, invoke it by its semantic skill name as listed in `.apex/_INDEX.md`.',
  '6. Run the owning surface\'s test command and the hub coherence gate before reporting completion.',
  '',
  '## Work-artifact boundary',
  '',
  'Do not ordinarily enumerate, search, or read under `.apex/work/**`.',
  '',
  'A workflow phase may consume only the exact work inputs named by an accepted handoff. A pathless workflow invocation may perform only bounded workflow-header recovery discovery. Exact paths or a broader work-area scope are permitted only when the user explicitly delimits them. This applies transitively to child agents: only the phase orchestrator interprets a handoff.',
  '',
].join('\n');
const PORTABLE_DEMO_BOOTSTRAP_PATH = '.agents/skills/portable-demo-bootstrap/SKILL.md';

function seedV1_0Hub(model = baseModel()) {
  const hubRoot = seedHub(model);
  writeFileSync(join(hubRoot, PORTABLE_DEMO_BOOTSTRAP_PATH), V1_0_PORTABLE_DEMO_BOOTSTRAP);
  return hubRoot;
}

function portableMessages(hubRoot) {
  return collectViolations(hubRoot).filter(({ msg }) => msg.startsWith('portable-v1:'));
}

test('an untouched v1.0.0-v1.0.4 bootstrap is a stale generated update in linter and planner', () => {
  const model = baseModel();
  const hubRoot = seedV1_0Hub(model);
  try {
    assert.deepEqual(portableMessages(hubRoot), [{
      level: 'warn',
      msg: `portable-v1: canonical bootstrap at ${PORTABLE_DEMO_BOOTSTRAP_PATH} is the v1.0.0-v1.0.4 rendering; init repair updates it to the current rendering`,
    }]);
    assert.equal(captureValidateHub([hubRoot, '--quiet']).code, 0);

    const plan = planProjectScaffold({ hubRoot, model, templatesDir });
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(previewProjectScaffold(plan), [{
      id: 'v1:op:project-bootstrap',
      kind: 'replace-generated',
      artifactId: 'project-bootstrap',
      path: PORTABLE_DEMO_BOOTSTRAP_PATH,
      priorState: 'stale',
    }]);
    assert.deepEqual(applyProjectScaffold({ hubRoot, plan }), { applied: 1, paths: [PORTABLE_DEMO_BOOTSTRAP_PATH] });
    const current = renderProjectArtifact('project-bootstrap', normalizeProjectModel(model), templatesDir);
    assert.match(current, /## Inception boundary/u);
    assert.equal(readFileSync(join(hubRoot, PORTABLE_DEMO_BOOTSTRAP_PATH), 'utf8'), current);
    assert.deepEqual(portableMessages(hubRoot), []);

    const before = fileState(hubRoot);
    const second = planProjectScaffold({ hubRoot, model, templatesDir });
    assert.deepEqual([second.operations, second.conflicts], [[], []]);
    assert.deepEqual(applyProjectScaffold({ hubRoot, plan: second }), { applied: 0, paths: [] });
    assert.deepEqual(fileState(hubRoot), before);
  } finally {
    rmSync(hubRoot, { recursive: true, force: true });
  }
});

test('new-surface repairs and extends a hub carrying the v1.0.0-v1.0.4 bootstrap without a bootstrap conflict', () => {
  const repairRoot = seedV1_0Hub();
  const additionRoot = seedV1_0Hub();
  try {
    const current = renderProjectArtifact('project-bootstrap', normalizeProjectModel(baseModel()), templatesDir);

    const repaired = captureNewSurface([
      '--name', 'web', '--path', 'apps/web', '--agent', 'web-agent',
      '--hub', repairRoot, '--test', 'npm test', '--repair',
    ]);
    assert.equal(repaired.code, 0, repaired.stderr);
    assert.equal(readFileSync(join(repairRoot, PORTABLE_DEMO_BOOTSTRAP_PATH), 'utf8'), current);
    assert.deepEqual(portableMessages(repairRoot), []);

    mkdirSync(join(additionRoot, 'services', 'api'), { recursive: true });
    const addition = [
      '--name', 'api', '--path', 'services/api', '--agent', 'api-agent',
      '--hub', additionRoot, '--test', 'npm run test:api',
    ];
    const unresolved = captureNewSurface(addition);
    assert.equal(unresolved.code, 1);
    assert.match(unresolved.stderr, /v1:project-instructions:customized/u);
    assert.doesNotMatch(unresolved.stderr, /project-bootstrap/u);
    const added = captureNewSurface([...addition, '--resolution', 'v1:project-instructions:customized=replace']);
    assert.equal(added.code, 0, added.stderr);
    assert.equal(readFileSync(join(additionRoot, PORTABLE_DEMO_BOOTSTRAP_PATH), 'utf8'), current);
    assert.deepEqual(portableMessages(additionRoot), []);
  } finally {
    rmSync(repairRoot, { recursive: true, force: true });
    rmSync(additionRoot, { recursive: true, force: true });
  }
});

test('one extra byte on the v1.0.0-v1.0.4 bootstrap is customized in linter, planner, and new-surface', () => {
  const model = baseModel();
  const hubRoot = seedV1_0Hub(model);
  try {
    writeFileSync(join(hubRoot, PORTABLE_DEMO_BOOTSTRAP_PATH), `${V1_0_PORTABLE_DEMO_BOOTSTRAP}x`);
    const before = fileState(hubRoot);
    assert.deepEqual(portableMessages(hubRoot), [{
      level: 'error',
      msg: `portable-v1: canonical bootstrap at ${PORTABLE_DEMO_BOOTSTRAP_PATH} is customized`,
    }]);
    const plan = planProjectScaffold({ hubRoot, model, templatesDir });
    assert.deepEqual(plan.conflicts, [{
      id: 'v1:project-bootstrap:customized',
      artifactId: 'project-bootstrap',
      path: PORTABLE_DEMO_BOOTSTRAP_PATH,
      reason: 'customized',
      choices: ['replace', 'abort'],
    }]);
    assert.deepEqual(previewProjectScaffold(plan), []);
    const repaired = captureNewSurface([
      '--name', 'web', '--path', 'apps/web', '--agent', 'web-agent',
      '--hub', hubRoot, '--test', 'npm test', '--repair',
    ]);
    assert.equal(repaired.code, 1);
    assert.match(repaired.stderr, /v1:project-bootstrap:customized/u);
    assert.deepEqual(fileState(hubRoot), before);
  } finally {
    rmSync(hubRoot, { recursive: true, force: true });
  }
});

test('public repair refuses explicit Codex inherit and preserves the full tree', () => {
  const model = baseModel();
  const hubRoot = seedHub(model);
  const path = '.codex/agents/web-agent.toml';
  const current = readFileSync(join(hubRoot, path), 'utf8');
  writeFileSync(join(hubRoot, path), current.replace('developer_instructions = """', 'model = "inherit"\ndeveloper_instructions = """'));
  const before = fileState(hubRoot);
  const plan = planProjectScaffold({ hubRoot, model, templatesDir });
  assert.ok(plan.conflicts.some(({ id }) => id === 'v1:web-agent-codex:customized'));
  assert.throws(() => applyProjectScaffold({ hubRoot, plan }), /unresolved conflicts/i);
  assert.ok(collectViolations(hubRoot).some(({ level }) => level === 'error'));
  assert.deepEqual(fileState(hubRoot), before);
});


test('a supported root-only project can add its first active-v1 surface', () => {
  const hubRoot = tempHub();
  put(hubRoot, '.apex/_INDEX.md', [
    '<!-- steepy-hub-version: 1 -->',
    '# Test hub',
    '',
    '## Routing Table',
    '',
    '| Surface | Min docs | Specialist agent | Applicable skill |',
    '|---|---|---|---|',
    '',
  ].join('\n'));
  const rootOnly = baseModel({ surfaces: [] });
  applyProjectScaffold({
    hubRoot,
    plan: planRootInstructions({ hubRoot, model: rootOnly, templatesDir }),
  });
  // The surface's owning directory exists before new-surface runs: check 10 of
  // validate-hub requires the scaffolded standard's owning header to cite a real
  // directory for new-surface's internal coherence gate to pass.
  mkdirSync(join(hubRoot, 'apps', 'web'), { recursive: true });
  const addition = [
    '--name', 'web',
    '--path', 'apps/web',
    '--agent', 'web-agent',
    '--hub', hubRoot,
    '--test', 'npm test',
  ];

  const unresolved = captureNewSurface(addition);
  assert.equal(unresolved.code, 1);
  assert.match(unresolved.stderr, /v1:project-instructions:customized.*replace.*abort/i);

  const applied = captureNewSurface([
    ...addition,
    '--resolution', 'v1:project-instructions:customized=replace',
  ]);
  assert.equal(applied.code, 0, applied.stderr);
  assert.match(applied.stdout, /active-v1 root instructions and routing are coherent/u);
  assert.match(readFileSync(join(hubRoot, 'AGENTS.md'), 'utf8'),
    /- `web` \(`apps\/web`\) — `web-agent`/u);
  assert.deepEqual(collectViolations(hubRoot).filter(({ level }) => level === 'error'), []);
});

test('active-v1 new-surface uses the full project identity and repairs to an exact no-op', () => {
  const hubRoot = seedHub(baseModel());
  // The new surface's owning directory exists before new-surface runs: check 10
  // of validate-hub requires the scaffolded standard's owning header to cite a
  // real directory for new-surface's internal coherence gate to pass.
  mkdirSync(join(hubRoot, 'services', 'api'), { recursive: true });
  const addition = [
    '--name', 'api',
    '--path', 'services/api',
    '--agent', 'api-agent',
    '--hub', hubRoot,
    '--test', 'npm run test:api',
  ];
  const beforeConflict = fileState(hubRoot);

  const unresolved = captureNewSurface(addition);
  assert.equal(unresolved.code, 1);
  assert.match(unresolved.stderr, /v1:project-instructions:customized.*replace.*abort/i);
  assert.deepEqual(fileState(hubRoot), beforeConflict);

  const applied = captureNewSurface([
    ...addition,
    '--resolution', 'v1:project-instructions:customized=replace',
  ]);
  assert.equal(applied.code, 0, applied.stderr);
  assert.match(applied.stdout, /active-v1 root instructions and routing are coherent/u);
  assert.match(readFileSync(join(hubRoot, 'AGENTS.md'), 'utf8'),
    /- `api` \(`services\/api`\) — `api-agent`/u);
  assert.match(readFileSync(join(hubRoot, '.apex/_INDEX.md'), 'utf8'),
    /\| `api` \| \[standards\/api\.md\]\(standards\/api\.md\) \| `api-agent` \| — \|/u);
  assert.match(readFileSync(join(hubRoot, '.apex/standards/api.md'), 'utf8'),
    /> Owning surface: `services\/api`/u);
  for (const [adapter, extension] of [['claude', 'md'], ['codex', 'toml'], ['opencode', 'md']]) {
    const content = readFileSync(join(hubRoot, `.${adapter}/agents/api-agent.${extension}`), 'utf8');
    assert.match(content, /portable-demo-bootstrap/u);
    assert.match(content, /\.apex\/standards\/api\.md/u);
  }
  assert.deepEqual(collectViolations(hubRoot).filter(({ level }) => level === 'error'), []);

  const beforeRepair = fileState(hubRoot);
  for (const state of beforeRepair) chmodSync(join(hubRoot, state.path), state.mode);
  const repaired = captureNewSurface([...addition, '--repair']);
  assert.equal(repaired.code, 0, repaired.stderr);
  assert.match(repaired.stdout, /preserved .*api\.md \(already exists\)/u);
  assert.match(repaired.stdout, /active-v1 root instructions and routing are coherent/u);
  assert.deepEqual(fileState(hubRoot), beforeRepair);
});

test('active-v1 new-surface preserves valid Unicode/backticks and rejects unsafe commands before writes', () => {
  const hubRoot = seedHub(baseModel());
  mkdirSync(join(hubRoot, 'services', 'api'), { recursive: true });
  const common = [
    '--name', 'api', '--path', 'services/api', '--agent', 'api-agent', '--hub', hubRoot,
    '--resolution', 'v1:project-instructions:customized=replace',
  ];
  const beforeRejected = fileState(hubRoot);
  for (const [testCmd, pattern] of [
    ['```', /testCmd.*Markdown fence/i],
    ['node --test \ud800', /testCmd.*UTF-8/i],
    ['node --test \udfff', /testCmd.*UTF-8/i],
  ]) {
    const rejected = captureNewSurface([...common, '--test', testCmd]);
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, pattern);
    assert.deepEqual(fileState(hubRoot), beforeRejected);
  }

  const testCmd = 'node -e "console.log(`café 😀`)"';
  const applied = captureNewSurface([...common, '--test', testCmd]);
  assert.equal(applied.code, 0, applied.stderr);
  const standard = readFileSync(join(hubRoot, '.apex/standards/api.md'), 'utf8');
  assert.ok(standard.includes(`\`\`\`sh\n${testCmd}\n\`\`\``));
  assert.doesNotMatch(standard, /�/u);
  assert.deepEqual(collectViolations(hubRoot).filter(({ level }) => level === 'error'), []);
});

test('active-v1 new-surface rejects incompatible existing standard identities before every write', async (t) => {
  const addition = [
    '--name', 'api', '--path', 'services/api', '--agent', 'api-agent',
    '--test', 'npm run test:api', '--repair',
    '--resolution', 'v1:project-instructions:customized=replace',
  ];
  const scenarios = [
    {
      label: 'modular-only',
      seed(hubRoot) {
        put(hubRoot, '.apex/standards/api/api-core.md',
          surfaceStandard('api', 'services/api', 'npm run test:api'));
      },
    },
    {
      label: 'dual-shape',
      seed(hubRoot) {
        put(hubRoot, '.apex/standards/api.md',
          surfaceStandard('api', 'services/api', 'npm run test:api'));
        put(hubRoot, '.apex/standards/api/api-core.md',
          surfaceStandard('api', 'services/api', 'npm run test:api'));
      },
    },
    {
      label: 'malformed-title',
      seed(hubRoot) {
        put(hubRoot, '.apex/standards/api.md',
          surfaceStandard('api', 'services/api', 'npm run test:api')
            .replace('# api — Technical Standard', '# api standard'));
      },
    },
    {
      label: 'owner-path-mismatch',
      seed(hubRoot) {
        put(hubRoot, '.apex/standards/api.md',
          surfaceStandard('api', 'services/other', 'npm run test:api'));
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.label, () => {
      const hubRoot = seedHub(baseModel());
      scenario.seed(hubRoot);
      const before = fileState(hubRoot);
      const result = captureNewSurface([...addition, '--hub', hubRoot]);
      assert.deepEqual(fileState(hubRoot), before,
        'root, routing, standard, adapters, bytes, modes, and mtimes must remain unchanged');
      assert.equal(result.code, 1, result.stdout);
      assert.match(result.stderr, /active-v1.*standard|standard.*(?:modular|dual|title|owner|identity)/iu);
    });
  }
});

test('active-v1 external-only repairs contend on the project repository lock', async (t) => {
  const installLiveLock = (hubRoot) => {
    const lockPath = join(hubRoot, '.steepy-project-scaffold.lock');
    mkdirSync(lockPath);
    put(hubRoot, '.steepy-project-scaffold.lock/owner.json', `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      token: '0123456789abcdef0123456789abcdef',
    })}\n`);
  };

  await t.test('standard-only repair', () => {
    const hubRoot = seedHub(baseModel());
    unlinkSync(join(hubRoot, '.apex/standards/web.md'));
    installLiveLock(hubRoot);
    const before = fileState(hubRoot);
    const result = captureNewSurface([
      '--name', 'web', '--path', 'apps/web', '--agent', 'web-agent',
      '--test', 'npm test', '--hub', hubRoot, '--repair',
    ]);
    assert.deepEqual(fileState(hubRoot), before, 'standard must not publish through a live lock');
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, /lock.*live owner|lock.*already held/iu);
  });

  await t.test('routing-only repair', () => {
    const hubRoot = seedHub(baseModel());
    const indexPath = join(hubRoot, '.apex/_INDEX.md');
    writeFileSync(indexPath, readFileSync(indexPath, 'utf8')
      .split('\n').filter((line) => !line.includes('| `web` |')).join('\n'));
    installLiveLock(hubRoot);
    const before = fileState(hubRoot);
    const result = captureNewSurface([
      '--name', 'web', '--path', 'apps/web', '--agent', 'web-agent',
      '--test', 'npm test', '--hub', hubRoot, '--repair',
    ]);
    assert.deepEqual(fileState(hubRoot), before, 'routing must not publish through a live lock');
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, /lock.*live owner|lock.*already held/iu);
  });
});

test('every accepted Project devCommand round-trips and rejected boundaries write nothing', async (t) => {
  const accepted = baseModel({
    devCommands: ['npm test', "printf 'café 😀' && echo $PATH", 'node --test tests/*.test.mjs'],
  });
  const normalized = normalizeProjectModel(accepted);
  assert.deepEqual(normalized.devCommands, accepted.devCommands);
  const hubRoot = seedHub(accepted);
  assert.deepEqual(collectViolations(hubRoot).filter(({ level }) => level === 'error'), []);
  const beforeNoOp = fileState(hubRoot);
  const second = planProjectScaffold({ hubRoot, model: accepted, templatesDir });
  assert.deepEqual(previewProjectScaffold(second), []);
  assert.deepEqual(second.operations, []);
  assert.deepEqual(second.conflicts, []);
  assert.deepEqual(applyProjectScaffold({ hubRoot, plan: second }), { applied: 0, paths: [] });
  assert.deepEqual(fileState(hubRoot), beforeNoOp);

  for (const [label, command] of [['empty', ''], ['backtick', 'echo `date`']]) {
    await t.test(label, () => {
      const rejectedHub = tempHub();
      put(rejectedHub, '.apex/_INDEX.md', '# sentinel\n');
      const rejected = baseModel({ devCommands: [command] });
      const before = fileState(rejectedHub);
      assert.throws(() => normalizeProjectModel(rejected), /devCommands\[0\].*(?:empty|backtick|non-empty)/iu);
      assert.throws(() => planProjectScaffold({ hubRoot: rejectedHub, model: rejected, templatesDir }),
        /devCommands\[0\].*(?:empty|backtick|non-empty)/iu);
      assert.deepEqual(fileState(rejectedHub), before);
    });
  }
});

test('new-surface blocks every present managed Project identity it cannot resolve before all writes', async (t) => {
  const canonical = renderProjectArtifact(
    'project-instructions', normalizeProjectModel(baseModel()), templatesDir,
  );
  const cases = [
    ['unsupported v2', '<!-- steepy:managed:project-instructions:v2:start -->\n# future\n<!-- steepy:managed:project-instructions:v2:end -->\n'],
    ['malformed v1', '<!-- steepy:managed:project-instructions:v1:start -->\n# broken\n'],
    ['duplicate v1', `${canonical}<!-- steepy:managed:project-instructions:v1:start -->\n`],
    ['canonical v1 plus unsupported v2', `${canonical}<!-- steepy:managed:project-instructions:v2:start -->\n`],
  ];
  for (const [label, agents] of cases) {
    await t.test(label, () => {
      const hubRoot = tempHub();
      put(hubRoot, '.apex/_INDEX.md', '# existing routing\n');
      put(hubRoot, '.apex/standards/existing.md', '# existing\n');
      put(hubRoot, 'AGENTS.md', agents);
      const before = fileState(hubRoot);
      const result = captureNewSurface([
        '--name', 'api', '--path', 'services/api', '--agent', 'api-agent',
        '--hub', hubRoot, '--test', 'npm run test:api',
      ]);
      assert.equal(result.code, 1, result.stdout);
      assert.match(result.stderr, /managed project|project instructions.*(?:unsupported|malformed|duplicate|unresolved)/iu);
      assert.deepEqual(fileState(hubRoot), before, 'root, routing, standards, adapters, modes and mtimes must not change');
    });
  }

  await t.test('a truly unbound hub retains explicit preparatory mode', () => {
    const hubRoot = tempHub();
    put(hubRoot, '.apex/_INDEX.md', '# unbound routing\n');
    const result = captureNewSurface([
      '--name', 'api', '--path', 'services/api', '--agent', 'api-agent', '--hub', hubRoot,
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Paste this row into \.apex\/_INDEX\.md/u);
  });
});

test('generated-adapter CRLF drift is customized in both validator and planner', () => {
  const model = baseModel();
  const hubRoot = seedHub(model);
  assert.deepEqual(collectViolations(hubRoot).filter(({ level }) => level === 'error'), []);
  const exact = planProjectScaffold({ hubRoot, model, templatesDir });
  assert.deepEqual(exact.operations, []);
  assert.deepEqual(exact.conflicts, []);

  const adapterPath = join(hubRoot, '.claude/agents/web-agent.md');
  writeFileSync(adapterPath, readFileSync(adapterPath, 'utf8').replaceAll('\n', '\r\n'));

  const errors = collectViolations(hubRoot)
    .filter(({ level }) => level === 'error')
    .map(({ msg }) => msg)
    .join('\n');
  assert.match(errors, /portable-v1:.*web-agent.*claude.*customized/i);
  const conflict = planProjectScaffold({ hubRoot, model, templatesDir }).conflicts
    .find(({ artifactId }) => artifactId === 'web-agent-claude');
  assert.deepEqual(conflict, {
    id: 'v1:web-agent-claude:customized',
    artifactId: 'web-agent-claude',
    path: '.claude/agents/web-agent.md',
    reason: 'customized',
    choices: ['replace', 'abort'],
  });
});

test('adjacent user-owned AGENTS bytes conflict, repair with CRLF preserved, and become an exact no-op', () => {
  const model = baseModel({ description: '' });
  const hubRoot = seedHub(model);
  const agentsPath = join(hubRoot, 'AGENTS.md');
  const prefix = '# user-owned prefix\r\n';
  const suffix = '\r\n# user-owned suffix\r\n';
  const managed = readFileSync(agentsPath, 'utf8').trimEnd().replaceAll('\n', '\r\n');
  writeFileSync(agentsPath, `${prefix}${managed}${suffix}`);

  const validatorErrors = collectViolations(hubRoot)
    .filter(({ level }) => level === 'error')
    .map(({ msg }) => msg)
    .join('\n');
  assert.match(validatorErrors, /portable-v1:.*project instructions.*out-of-position/i);
  const mismatched = planProjectScaffold({ hubRoot, model, templatesDir });
  assert.deepEqual(previewProjectScaffold(mismatched), []);
  assert.deepEqual(mismatched.conflicts, [{
    id: 'v1:project-instructions:customized',
    artifactId: 'project-instructions',
    path: 'AGENTS.md',
    reason: 'customized',
    choices: ['replace', 'abort'],
  }]);

  const resolved = planProjectScaffold({
    hubRoot,
    templatesDir,
    model: {
      ...model,
      resolutions: { 'v1:project-instructions:customized': 'replace' },
    },
  });
  assert.deepEqual(resolved.conflicts, []);
  assert.deepEqual(resolved.operations.map(({ artifactId, kind }) => [artifactId, kind]), [
    ['project-instructions', 'replace-managed'],
  ]);
  applyProjectScaffold({ hubRoot, plan: resolved });

  const repaired = readFileSync(agentsPath, 'utf8');
  assert.ok(repaired.startsWith(prefix), 'prefix bytes must be preserved exactly');
  assert.ok(repaired.endsWith(suffix), 'suffix bytes must be preserved exactly');
  assert.doesNotMatch(repaired, /(^|[^\r])\n/u, 'repair must not introduce bare LF into CRLF content');
  assert.deepEqual(collectViolations(hubRoot).filter(({ level }) => level === 'error'), []);

  const beforeNoOp = fileState(hubRoot);
  const second = planProjectScaffold({ hubRoot, model, templatesDir });
  assert.deepEqual(previewProjectScaffold(second), []);
  assert.deepEqual(second.conflicts, []);
  assert.deepEqual(applyProjectScaffold({ hubRoot, plan: second }), { applied: 0, paths: [] });
  assert.deepEqual(fileState(hubRoot), beforeNoOp);

});

test('an extra unmanaged Claude import conflicts, is byte-preserved as inert prose, and becomes an exact no-op', () => {
  const model = baseModel({ description: '' });
  const hubRoot = seedHub(model);
  const claudePath = join(hubRoot, 'CLAUDE.md');
  const unmanagedImport = '@AGENTS.md\n';
  writeFileSync(claudePath, `${readFileSync(claudePath, 'utf8')}\n${unmanagedImport}`);

  const validatorErrors = collectViolations(hubRoot)
    .filter(({ level }) => level === 'error')
    .map(({ msg }) => msg)
    .join('\n');
  assert.match(validatorErrors, /portable-v1:.*CLAUDE\.md managed import.*target collision/i);
  const mismatched = planProjectScaffold({ hubRoot, model, templatesDir });
  assert.deepEqual(previewProjectScaffold(mismatched), []);
  assert.deepEqual(mismatched.conflicts, [{
    id: 'v1:claude-import:customized',
    artifactId: 'claude-import',
    path: 'CLAUDE.md',
    reason: 'customized',
    choices: ['replace', 'abort'],
  }]);

  const resolved = planProjectScaffold({
    hubRoot,
    templatesDir,
    model: {
      ...model,
      resolutions: { 'v1:claude-import:customized': 'replace' },
    },
  });
  assert.deepEqual(resolved.conflicts, []);
  assert.deepEqual(resolved.operations.map(({ artifactId, kind }) => [artifactId, kind]), [
    ['claude-import', 'replace-managed'],
  ]);
  applyProjectScaffold({ hubRoot, plan: resolved });

  const repaired = readFileSync(claudePath, 'utf8');
  assert.match(repaired, /<!-- preserved unmanaged Claude import\n@AGENTS\.md\n-->/u);
  assert.ok(repaired.includes(unmanagedImport), 'the original unmanaged import bytes must remain intact');
  assert.deepEqual(collectViolations(hubRoot).filter(({ level }) => level === 'error'), []);

  const beforeNoOp = fileState(hubRoot);
  const second = planProjectScaffold({ hubRoot, model, templatesDir });
  assert.deepEqual(previewProjectScaffold(second), []);
  assert.deepEqual(second.conflicts, []);
  assert.deepEqual(applyProjectScaffold({ hubRoot, plan: second }), { applied: 0, paths: [] });
  assert.deepEqual(fileState(hubRoot), beforeNoOp);

});

test('the offered unmanaged-import adoption installs one canonical managed target and becomes an exact no-op', () => {
  const model = baseModel({ description: '' });
  const hubRoot = seedHub(model);
  const claudePath = join(hubRoot, 'CLAUDE.md');
  writeFileSync(claudePath, '@AGENTS.md\n');

  const before = fileState(hubRoot);
  const offered = planProjectScaffold({ hubRoot, model, templatesDir });
  const beforeErrors = collectViolations(hubRoot)
    .filter(({ level }) => level === 'error')
    .map(({ msg }) => msg)
    .join('\n');
  assert.match(beforeErrors, /portable-v1: CLAUDE\.md managed import is malformed/u);
  assert.deepEqual(previewProjectScaffold(offered), []);
  assert.deepEqual(offered.conflicts.find(({ artifactId }) => artifactId === 'claude-import'), {
    id: 'v1:claude-import:unmanaged-import',
    artifactId: 'claude-import',
    path: 'CLAUDE.md',
    reason: 'unmanaged-import',
    choices: ['adopt', 'abort'],
  });

  const resolved = planProjectScaffold({
    hubRoot,
    templatesDir,
    model: {
      ...model,
      resolutions: { 'v1:claude-import:unmanaged-import': 'adopt' },
    },
  });
  assert.deepEqual(resolved.conflicts, []);
  const operation = resolved.operations.find(({ artifactId }) => artifactId === 'claude-import');
  assert.equal(operation.kind, 'replace-managed');
  assert.equal(operation.priorState, 'unmarked');
  assert.notDeepEqual(fileState(hubRoot), [], 'the fixture must remain untouched by planning');
  assert.deepEqual(fileState(hubRoot), before, 'planning and resolution must remain read-only');

  applyProjectScaffold({ hubRoot, plan: resolved });
  const repaired = readFileSync(claudePath, 'utf8');
  assert.equal(
    repaired,
    renderProjectArtifact('claude-import', normalizeProjectModel(model), templatesDir),
  );
  assert.equal(countActiveClaudeImports(repaired), 1);
  assert.deepEqual(collectViolations(hubRoot).filter(({ level }) => level === 'error'), []);

  const beforeNoOp = fileState(hubRoot);
  const second = planProjectScaffold({ hubRoot, model, templatesDir });
  assert.deepEqual(previewProjectScaffold(second), []);
  assert.deepEqual(second.conflicts, []);
  assert.deepEqual(applyProjectScaffold({ hubRoot, plan: second }), { applied: 0, paths: [] });
  assert.deepEqual(fileState(hubRoot), beforeNoOp);

  const crlfHub = seedHub(model);
  const crlfClaudePath = join(crlfHub, 'CLAUDE.md');
  const prefix = '# user-owned prefix\r\n';
  const suffix = '# user-owned suffix\r\n';
  writeFileSync(crlfClaudePath, `${prefix}@AGENTS.md\r\n${suffix}`);
  const crlfResolved = planProjectScaffold({
    hubRoot: crlfHub,
    templatesDir,
    model: {
      ...model,
      resolutions: { 'v1:claude-import:unmanaged-import': 'adopt' },
    },
  });
  applyProjectScaffold({ hubRoot: crlfHub, plan: crlfResolved });
  const crlfRepaired = readFileSync(crlfClaudePath, 'utf8');
  assert.ok(crlfRepaired.startsWith(`${prefix}${suffix}`), 'surrounding user lines must remain byte-exact');
  assert.doesNotMatch(crlfRepaired, /(^|[^\r])\n/u, 'adoption must preserve the CRLF convention');
  assert.equal(countActiveClaudeImports(crlfRepaired), 1);
  assert.deepEqual(collectViolations(crlfHub).filter(({ level }) => level === 'error'), []);
  const crlfBeforeNoOp = fileState(crlfHub);
  const crlfSecond = planProjectScaffold({ hubRoot: crlfHub, model, templatesDir });
  assert.deepEqual(previewProjectScaffold(crlfSecond), []);
  assert.deepEqual(crlfSecond.conflicts, []);
  assert.deepEqual(applyProjectScaffold({ hubRoot: crlfHub, plan: crlfSecond }), { applied: 0, paths: [] });
  assert.deepEqual(fileState(crlfHub), crlfBeforeNoOp);
});

test('portable-v1 validation rejects canonical target and ancestor symlinks just like the public planner', async (t) => {
  const model = baseModel();

  await t.test('ordinary public-v1 files remain planner-current and validator-green', () => {
    const hubRoot = seedHub(model);
    const plan = planProjectScaffold({ hubRoot, model, templatesDir });
    assert.deepEqual(plan.operations, []);
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(collectViolations(hubRoot).filter(({ level }) => level === 'error'), []);
    const validation = captureValidateHub([hubRoot]);
    assert.equal(validation.code, 0, validation.stderr);
    assert.match(validation.stdout, /doc graph is coherent/u);
  });

  const cases = [
    {
      label: 'generated bootstrap target symlink',
      artifactId: 'project-bootstrap',
      path: '.agents/skills/portable-demo-bootstrap/SKILL.md',
      mutate(hubRoot, outside) {
        const target = join(hubRoot, this.path);
        const mirror = join(outside, 'bootstrap.md');
        copyFileSync(target, mirror);
        unlinkSync(target);
        symlinkSync(mirror, target);
      },
    },
    {
      label: 'generated adapter target symlink',
      artifactId: 'web-agent-codex',
      path: '.codex/agents/web-agent.toml',
      mutate(hubRoot, outside) {
        const target = join(hubRoot, this.path);
        const mirror = join(outside, 'web-agent.toml');
        copyFileSync(target, mirror);
        unlinkSync(target);
        symlinkSync(mirror, target);
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.label, () => {
      const hubRoot = seedHub(model);
      const outside = mkdtempSync(join(tmpdir(), 'steepy-portable-symlink-copy-'));
      scenario.mutate(hubRoot, outside);

      const plan = planProjectScaffold({ hubRoot, model, templatesDir });
      assert.deepEqual(plan.conflicts.find(({ artifactId }) => artifactId === scenario.artifactId), {
        id: `v1:${scenario.artifactId}:symlink`,
        artifactId: scenario.artifactId,
        path: scenario.path,
        reason: 'symlink',
        choices: ['abort'],
      });

      const errors = collectViolations(hubRoot).filter(({ level }) => level === 'error');
      assert.ok(errors.some(({ msg }) => (
        msg.includes(scenario.path) && /symlink/u.test(msg)
      )), JSON.stringify(errors));
      const validation = captureValidateHub([hubRoot]);
      assert.equal(validation.code, 1, validation.stdout);
      assert.match(validation.stderr, /portable-v1:.*symlink/u);
    });
  }
});

test('external project mounts compose scoped paths, repair, validation and a zero-write rerun', () => {
  for (const relativeLinks of [false, true]) {
    const model = baseModel();
    model.surfaces[0].path = 'libs/@rt3-backend';
    const hubRoot = seedHub(model);
    const outside = tempHub();
    const names = ['.apex', '.agents', '.claude', '.codex', '.opencode', 'AGENTS.md', 'CLAUDE.md'];
    try {
      for (const name of names) {
        const source = join(hubRoot, name);
        const target = join(outside, name);
        renameSync(source, target);
        symlinkSync(relativeLinks ? relative(hubRoot, target) : target, source);
      }
      const links = names.map((name) => readlinkSync(join(hubRoot, name)));
      assert.deepEqual(planProjectScaffold({ hubRoot, model, templatesDir }).conflicts, []);
      assert.deepEqual(collectViolations(hubRoot).filter(({ level }) => level === 'error'), []);

      // Exercise both atomic replacement of a mounted root file and creation
      // under a mounted provider. Logical paths remain the public identities.
      const desired = { ...model, description: 'Repaired external project.',
        resolutions: { 'v1:project-instructions:customized': 'replace',
          'v1:web-agent-codex:customized': 'replace', 'v1:web-agent-opencode:customized': 'replace' } };
      unlinkSync(join(outside, '.claude/agents/web-agent.md'));
      chmodSync(join(outside, 'AGENTS.md'), 0o640);
      const plan = planProjectScaffold({ hubRoot, model: desired, templatesDir });
      assert.deepEqual(plan.conflicts, []);
      assert.deepEqual(new Set(plan.operations.map(({ path }) => path)),
        new Set(['AGENTS.md', '.claude/agents/web-agent.md',
          '.codex/agents/web-agent.toml', '.opencode/agents/web-agent.md']));
      assert.equal(applyProjectScaffold({ hubRoot, plan }).applied, 4);
      assert.match(readFileSync(join(outside, 'AGENTS.md'), 'utf8'), /Repaired external project/);
      assert.equal(lstatSync(join(outside, 'AGENTS.md')).mode & 0o777, 0o640);
      assert.deepEqual(names.map((name) => readlinkSync(join(hubRoot, name))), links);
      assert.deepEqual(collectViolations(hubRoot).filter(({ level }) => level === 'error'), []);
      const before = fileState(outside);
      const second = planProjectScaffold({ hubRoot, model: { ...desired, resolutions: {} }, templatesDir });
      assert.deepEqual(second.operations, []);
      assert.deepEqual(second.conflicts, []);
      assert.equal(applyProjectScaffold({ hubRoot, plan: second }).applied, 0);
      assert.deepEqual(fileState(outside), before);
    } finally {
      rmSync(hubRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }
});

test('broken, cyclic, wrong-type and work mounts remain controlled planner/linter errors', () => {
  for (const kind of ['broken', 'cycle', 'wrong-type', 'work']) {
    const model = baseModel();
    const hubRoot = seedHub(model);
    try {
      const target = join(hubRoot, 'AGENTS.md');
      unlinkSync(target);
      mkdirSync(join(hubRoot, '.apex/work'), { recursive: true });
      put(hubRoot, '.apex/work/private.md', '# Work must stay excluded\n');
      const destination = {
        broken: 'missing.md', cycle: 'AGENTS.md', 'wrong-type': '.claude', work: '.apex/work/private.md',
      }[kind];
      symlinkSync(destination, target);
      const plan = planProjectScaffold({ hubRoot, model, templatesDir });
      assert.ok(plan.conflicts.some(({ path, reason }) => path === 'AGENTS.md' && reason === 'symlink'), kind);
      assert.ok(collectViolations(hubRoot).some(({ level, msg }) => level === 'error'
        && msg.includes('AGENTS.md') && msg.includes('symlink')), kind);
      assert.equal(readlinkSync(target), destination);
    } finally { rmSync(hubRoot, { recursive: true, force: true }); }
  }
});

test('repair detects a mount retargeted after staging before writing either destination', () => {
  const model = baseModel();
  const hubRoot = seedHub(model);
  const outside = tempHub();
  try {
    const logical = join(hubRoot, 'AGENTS.md');
    const first = join(outside, 'first.md');
    const second = join(outside, 'second.md');
    renameSync(logical, first);
    copyFileSync(first, second);
    symlinkSync(first, logical);
    const desired = { ...model, description: 'Changed.',
      resolutions: { 'v1:project-instructions:customized': 'replace',
        'v1:web-agent-claude:customized': 'replace',
        'v1:web-agent-codex:customized': 'replace', 'v1:web-agent-opencode:customized': 'replace' } };
    const plan = planProjectScaffold({ hubRoot, model: desired, templatesDir });
    assert.deepEqual(plan.conflicts, []);
    const before = fileState(outside);
    assert.throws(() => applyProjectScaffold({ hubRoot, plan, checkpoint({ phase }) {
      if (phase === 'after-staging') {
        unlinkSync(logical);
        symlinkSync(second, logical);
      }
    } }), /identity|TOCTOU/);
    assert.deepEqual(fileState(outside), before);
    assert.equal(readlinkSync(logical), second);
  } finally {
    rmSync(hubRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('repair refuses two root mounts aliasing the same output before any write', () => {
  const hubRoot = tempHub();
  const outside = tempHub();
  try {
    const target = join(outside, 'instructions.md');
    writeFileSync(target, '# User instructions\n');
    for (const name of ['AGENTS.md', 'CLAUDE.md']) symlinkSync(target, join(hubRoot, name));
    const plan = planProjectScaffold({ hubRoot, model: baseModel(), templatesDir });
    assert.deepEqual(plan.conflicts, []);
    const before = fileState(outside);
    assert.throws(() => applyProjectScaffold({ hubRoot, plan }), /alias.*physical target/);
    assert.deepEqual(fileState(outside), before);
    assert.deepEqual(readdirSync(hubRoot).sort(), ['AGENTS.md', 'CLAUDE.md']);
  } finally {
    rmSync(hubRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('provider mount discovery excludes the physical work directory inside its target', () => {
  const model = baseModel();
  const hubRoot = seedHub(model);
  try {
    put(hubRoot, '.apex/work/decoy.md', '<!-- steepy:generated:work-sentinel:v1 -->\n');
    rmSync(join(hubRoot, '.claude'), { recursive: true });
    symlinkSync('.apex', join(hubRoot, '.claude'));
    const plan = planProjectScaffold({ hubRoot, model, templatesDir });
    assert.deepEqual(plan.conflicts, []);
    assert.ok(plan.operations.some(({ path }) => path === '.claude/agents/web-agent.md'));
    assert.ok(!collectViolations(hubRoot).some(({ msg }) => msg.includes('work-sentinel')));
  } finally { rmSync(hubRoot, { recursive: true, force: true }); }
});

test('recursive bounded provenance blocks nested adapters and relocated or orphan bootstraps non-destructively', async (t) => {
  const model = baseModel();

  await t.test('nested exact adapter copy is a closed duplicate conflict', () => {
    const hubRoot = seedHub(model);
    const canonical = join(hubRoot, '.claude/agents/web-agent.md');
    const nestedPath = '.claude/agents/nested/copied.md';
    const nested = join(hubRoot, nestedPath);
    mkdirSync(dirname(nested), { recursive: true });
    copyFileSync(canonical, nested);
    const before = fileState(hubRoot);

    const blocked = planProjectScaffold({ hubRoot, model, templatesDir });
    assert.deepEqual(blocked.conflicts.find(({ path }) => path === nestedPath), {
      id: 'v1:web-agent-claude:duplicate',
      artifactId: 'web-agent-claude',
      path: nestedPath,
      reason: 'duplicate',
      choices: ['abort'],
    });
    assert.deepEqual(previewProjectScaffold(blocked), []);
    assert.deepEqual(fileState(hubRoot), before, 'planning and preview must be read-only');
    assert.ok(collectViolations(hubRoot).some(({ msg }) => /duplicate provenance/u.test(msg)));

    rmSync(join(hubRoot, '.claude/agents/nested'), { recursive: true });
    const cleanBefore = fileState(hubRoot);
    const clean = planProjectScaffold({ hubRoot, model, templatesDir });
    assert.deepEqual(previewProjectScaffold(clean), []);
    assert.deepEqual(clean.conflicts, []);
    assert.deepEqual(applyProjectScaffold({ hubRoot, plan: clean }), { applied: 0, paths: [] });
    assert.deepEqual(fileState(hubRoot), cleanBefore);
  });

  await t.test('relocated exact project bootstrap blocks its canonical recreate operation', () => {
    const hubRoot = seedHub(model);
    const canonicalPath = '.agents/skills/portable-demo-bootstrap/SKILL.md';
    const relocatedPath = '.agents/skills/archive/portable-demo-bootstrap/SKILL.md';
    const canonical = join(hubRoot, canonicalPath);
    const relocated = join(hubRoot, relocatedPath);
    mkdirSync(dirname(relocated), { recursive: true });
    renameSync(canonical, relocated);
    const before = fileState(hubRoot);

    const blocked = planProjectScaffold({ hubRoot, model, templatesDir });
    assert.deepEqual(blocked.conflicts.find(({ path }) => path === relocatedPath), {
      id: 'v1:project-bootstrap:wrong-target',
      artifactId: 'project-bootstrap',
      path: relocatedPath,
      reason: 'wrong-target',
      choices: ['abort'],
    });
    assert.equal(blocked.operations.some(({ artifactId }) => artifactId === 'project-bootstrap'), false);
    assert.deepEqual(previewProjectScaffold(blocked), []);
    assert.deepEqual(fileState(hubRoot), before);
    assert.ok(collectViolations(hubRoot).some(({ msg }) => /wrong target/u.test(msg)));

    renameSync(relocated, canonical);
    rmSync(join(hubRoot, '.agents/skills/archive'), { recursive: true });
    const cleanBefore = fileState(hubRoot);
    const clean = planProjectScaffold({ hubRoot, model, templatesDir });
    assert.deepEqual(previewProjectScaffold(clean), []);
    assert.deepEqual(clean.conflicts, []);
    assert.deepEqual(applyProjectScaffold({ hubRoot, plan: clean }), { applied: 0, paths: [] });
    assert.deepEqual(fileState(hubRoot), cleanBefore);
  });

  await t.test('nested generated bootstrap with unknown identity is a closed orphan conflict', () => {
    const hubRoot = seedHub(model);
    const orphanPath = '.agents/skills/nested/ghost/SKILL.md';
    put(hubRoot, orphanPath, '<!-- steepy:generated:ghost-bootstrap:v1 -->\n# ghost\n');
    const before = fileState(hubRoot);
    const blocked = planProjectScaffold({ hubRoot, model, templatesDir });
    assert.deepEqual(blocked.conflicts.find(({ path }) => path === orphanPath), {
      id: 'v1:ghost-bootstrap:orphan',
      artifactId: 'ghost-bootstrap',
      path: orphanPath,
      reason: 'orphan',
      choices: ['abort'],
    });
    assert.deepEqual(previewProjectScaffold(blocked), []);
    assert.deepEqual(fileState(hubRoot), before);
    assert.ok(collectViolations(hubRoot).some(({ msg }) => /ghost-bootstrap.*orphan/u.test(msg)));
  });

  await t.test('nested symlink decoy is never followed as generated provenance', () => {
    const hubRoot = seedHub(model);
    const outside = mkdtempSync(join(tmpdir(), 'steepy-portable-provenance-symlink-'));
    const mirror = join(outside, 'copied.md');
    copyFileSync(join(hubRoot, '.claude/agents/web-agent.md'), mirror);
    const decoy = join(hubRoot, '.claude/agents/nested/copied.md');
    mkdirSync(dirname(decoy), { recursive: true });
    symlinkSync(mirror, decoy);
    const plan = planProjectScaffold({ hubRoot, model, templatesDir });
    assert.deepEqual(plan.operations, []);
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(collectViolations(hubRoot).filter(({ level, msg }) => (
      level === 'error' && msg.startsWith('portable-v1:')
    )), []);
  });
});

test('portable-v1 returns stable non-file violations for every canonical artifact family', async (t) => {
  const model = baseModel();
  const cases = [
    ['AGENTS target directory', 'project-instructions', 'AGENTS.md', 'AGENTS.md', 'directory'],
    ['CLAUDE target directory', 'claude-import', 'CLAUDE.md', 'CLAUDE.md', 'directory'],
    ['project bootstrap target directory', 'project-bootstrap', '.agents/skills/portable-demo-bootstrap/SKILL.md', '.agents/skills/portable-demo-bootstrap/SKILL.md', 'directory'],
    ['Claude bootstrap target directory', 'claude-bootstrap-stub', '.claude/skills/portable-demo-bootstrap/SKILL.md', '.claude/skills/portable-demo-bootstrap/SKILL.md', 'directory'],
    ['Claude adapter target directory', 'web-agent-claude', '.claude/agents/web-agent.md', '.claude/agents/web-agent.md', 'directory'],
    ['Codex adapter target directory', 'web-agent-codex', '.codex/agents/web-agent.toml', '.codex/agents/web-agent.toml', 'directory'],
    ['OpenCode adapter target directory', 'web-agent-opencode', '.opencode/agents/web-agent.md', '.opencode/agents/web-agent.md', 'directory'],
    ['bootstrap non-directory ancestor', 'project-bootstrap', '.agents/skills/portable-demo-bootstrap/SKILL.md', '.agents/skills/portable-demo-bootstrap', 'file'],
    ['adapter non-directory ancestor', 'web-agent-codex', '.codex/agents/web-agent.toml', '.codex/agents', 'file'],
  ];

  for (const [label, artifactId, artifactPath, blockerPath, blockerKind] of cases) {
    await t.test(label, () => {
      const hubRoot = seedHub(model);
      const blocker = join(hubRoot, blockerPath);
      rmSync(blocker, { recursive: true });
      if (blockerKind === 'directory') mkdirSync(blocker, { recursive: true });
      else writeFileSync(blocker, 'BLOCKER\n');
      const beforeFiles = fileState(hubRoot);
      const beforeStat = lstatSync(blocker);
      const blockerIdentity = {
        directory: beforeStat.isDirectory(),
        file: beforeStat.isFile(),
        mode: beforeStat.mode & 0o777,
        mtimeMs: beforeStat.mtimeMs,
      };

      const plan = planProjectScaffold({ hubRoot, model, templatesDir });
      assert.deepEqual(plan.conflicts.find((conflict) => conflict.artifactId === artifactId), {
        id: `v1:${artifactId}:unsafe-path`,
        artifactId,
        path: artifactPath,
        reason: 'unsafe-path',
        choices: ['abort'],
      });
      assert.deepEqual(previewProjectScaffold(plan), []);
      const errors = collectViolations(hubRoot).filter(({ level }) => level === 'error');
      assert.ok(errors.some(({ msg }) => (
        msg.includes(artifactPath) && /non-file|non-directory-ancestor/u.test(msg)
      )), JSON.stringify(errors));
      const validation = captureValidateHub([hubRoot]);
      assert.equal(validation.code, 1, validation.stdout);
      assert.deepEqual(fileState(hubRoot), beforeFiles, 'planner and validator must remain read-only');
      const afterStat = lstatSync(blocker);
      assert.deepEqual({
        directory: afterStat.isDirectory(),
        file: afterStat.isFile(),
        mode: afterStat.mode & 0o777,
        mtimeMs: afterStat.mtimeMs,
      }, blockerIdentity);
    });
  }

  await t.test('ordinary public-v1 files remain green', () => {
    const hubRoot = seedHub(model);
    assert.deepEqual(planProjectScaffold({ hubRoot, model, templatesDir }).conflicts, []);
    assert.deepEqual(collectViolations(hubRoot).filter(({ level }) => level === 'error'), []);
  });
});

// Pre-hub recognition and the public planner must agree on what a hub artifact
// is: whatever the planner writes beside a pre-init inception descriptor makes
// the repository a partial hub, named artifact by artifact, never a pre-hub. A planner artifact family the classifier missed would let a
// half-initialized hub pass as an inception.
test('every artifact the public planner writes turns an index-less pre-init repository into a named partial hub', () => {
  const hubRoot = tempHub();
  try {
    put(hubRoot, '.apex/inception/.gitignore', '*\n');
    put(hubRoot, '.apex/inception/state.json',
      serializeInceptionState(createInitialInceptionState('0b6f1b8e-3c1a-4e2b-9f3d-5a7c9e1b2d4f')));
    assert.equal(classifyHub(hubRoot).state, 'pre-hub');
    const model = baseModel({
      surfaces: [
        { name: 'web', path: 'apps/web', agent: 'web-agent', testCmd: 'npm test' },
        { name: 'api', path: 'services/api', agent: 'api-agent', testCmd: 'npm run test:api' },
      ],
    });
    const plan = planProjectScaffold({ hubRoot, model, templatesDir });
    assert.deepEqual(plan.conflicts, []);
    const { paths } = applyProjectScaffold({ hubRoot, plan });
    const classified = classifyHub(hubRoot);
    assert.equal(classified.state, 'invalid');
    const messages = classified.violations.filter(({ level }) => level === 'error').map(({ msg }) => msg);
    assert.ok(messages.some((msg) => /^missing _INDEX\.md at .*_INDEX\.md$/u.test(msg)), messages.join('\n'));
    const named = messages.map((msg) => msg.match(/^inception: pre-hub state is incompatible with hub artifact (.+)$/u)?.[1])
      .filter(Boolean);
    assert.deepEqual(named.sort(), [...paths].sort(), 'the classifier names exactly the planner outputs');
  } finally {
    rmSync(hubRoot, { recursive: true, force: true });
  }
});

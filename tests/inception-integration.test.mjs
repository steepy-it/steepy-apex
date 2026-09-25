// Hermetic vertical matrix for the greenfield inception path.
//
// Every project value, document, and "user" answer here is SYNTHETIC: a
// fictional application invented for this suite. The suite drives the real
// helpers and public CLIs (inception-state, inception-handoff, project-scaffold,
// new-surface, validate-hub, stop-hook). Where the inception or init skill would
// author a document (the project, the approval, the hub documents) a labeled
// stand-in writes fixed synthetic bytes instead.
//
// It proves deterministic composition only. It is not a native bootstrap proof:
// no harness, model, provider, network, install, build, start, or deploy runs,
// and no approval here is a human approval. The native protocol and its results
// live in docs/inception-acceptance.md.
//
// Isolation: every test writes only below its own mkdtemp sandbox and removes it
// in `finally`. CLI children get an isolated HOME/XDG configuration and cache and
// hermetic Git (no system or global configuration, a ceiling directory). Every
// read or enumeration a CLI child or an audited in-process helper attempts is
// recorded before it happens and checked against the exact paths the step names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIRMED_INPUT_KEYS,
  finalizeInitReceipt,
  prepareInitReceipt,
  projectConfirmedInputs,
  verifyInceptionHandoff,
  writeCodeCheckpoint,
} from '../scripts/inception-handoff.mjs';
import { inspectInceptionState, startInceptionRun, updateInceptionState } from '../scripts/inception-state.mjs';
import { applyProjectScaffold, planProjectScaffold, previewProjectScaffold } from '../scripts/project-scaffold.mjs';
import { renderTemplate } from '../scripts/template.mjs';
import { classifyHub } from '../scripts/validate-hub.mjs';

const ENGINE = realpathSync.native(join(dirname(fileURLToPath(import.meta.url)), '..'));
const SCRIPTS = join(ENGINE, 'scripts');
const TEMPLATES = join(ENGINE, 'templates');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const template = (name) => readFileSync(join(TEMPLATES, name), 'utf8');

// ---------------------------------------------------------------------------
// Access recorder: one source, loaded both in-process and as a `--import`
// preload in every CLI child (as a data: URL, so no recorder file is written).
// Accesses are recorded before the wrapped built-in runs, whatever it returns.
const RECORDER_SOURCE = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const NAMES = ['openSync', 'readFileSync', 'readdirSync', 'opendirSync'];
const { O_WRONLY, O_RDWR, O_CREAT, O_DIRECTORY = 0 } = fs.constants;
function openKind(flags) {
  if (typeof flags === 'string') return /[wa+]/.test(flags) ? 'write' : 'read';
  const value = typeof flags === 'number' ? flags : 0;
  if (value & (O_WRONLY | O_RDWR | O_CREAT)) return 'write';
  if (O_DIRECTORY && (value & O_DIRECTORY)) return 'directory';
  return 'read';
}
function patch(accesses) {
  const originals = Object.fromEntries(NAMES.map((name) => [name, fs[name]]));
  for (const name of NAMES) {
    fs[name] = function recorded(target, ...rest) {
      if (typeof target === 'string' || target instanceof URL || Buffer.isBuffer(target)) {
        const kind = name === 'openSync' ? openKind(rest[0]) : name === 'readFileSync' ? 'read' : 'list';
        accesses.push([kind, resolve(target instanceof URL ? fileURLToPath(target) : String(target))]);
      }
      return originals[name].call(this, target, ...rest);
    };
  }
  syncBuiltinESMExports();
  return () => {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  };
}
export function recordAccess(fn) {
  const accesses = [];
  const restore = patch(accesses);
  try {
    try {
      return { result: fn(), error: undefined, accesses };
    } catch (error) {
      return { result: undefined, error, accesses };
    }
  } finally {
    restore();
  }
}
const log = process.env.STEEPY_TEST_ACCESS_LOG;
if (log) {
  const write = fs.writeFileSync;
  const accesses = [];
  patch(accesses);
  process.on('exit', () => write(log, JSON.stringify(accesses)));
}
`;
const RECORDER_URL = `data:text/javascript;base64,${Buffer.from(RECORDER_SOURCE).toString('base64')}`;
const { recordAccess } = await import(RECORDER_URL);

// ---------------------------------------------------------------------------
// SYNTHETIC fixture data: a fictional booking application.
const RUN = '5d0c7a3e-9b1f-4c2a-8e6d-2f4b6a8c0e1d';
const OTHER_RUN = '7a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const STATE = '.apex/inception/state.json';
const GUARD = '.apex/inception/.gitignore';
const runFile = (name, id = RUN) => `.apex/inception/${id}/${name}`;
const PROJECT = runFile('project.md');
const APPROVAL = runFile('approval.json');
const CHECKPOINT = runFile('checkpoint-1.json');
const VERIFICATION = runFile('verification.md');
const CONFIRMED = runFile('confirmed-inputs.json');
const PROMOTION = runFile('promotion.json');
const HANDOFF = runFile('init-handoff.json');
const RECEIPT = runFile('init-receipt.json');
const TRANSFER = [GUARD, STATE, HANDOFF, APPROVAL, PROJECT, CHECKPOINT, VERIFICATION, CONFIRMED, PROMOTION];
const LOCAL_SENTINEL = 'INCEPTION_LOCAL_BODY_SENTINEL';
// Run files the transfer never names: no helper or CLI may read them.
const UNNAMED_RUN_FILES = [runFile('reconnaissance.md'), runFile('research/runtime.md'), runFile('bootstrap-log.md')];
const CODE_PATHS = ['package.json', 'src/app.js', 'test/app.test.js'];
const STARTER_AGENT = '.claude/agents/app-agent.md';
const STARTER_CONFLICT = 'v1:app-agent-claude:customized';
const EXCLUDED_SENTINEL = 'EXCLUDED_DECISION_SENTINEL';

const RECORD_TEXT = json({
  projectName: 'synthetic-clinic',
  description: 'SYNTHETIC fixture: a fictional booking app used only by the hermetic inception matrix.',
  devCommands: ['npm install', 'npm test', 'npm start'],
  surfaces: [{ name: 'app', path: 'src', agent: 'app-agent', testCmd: 'npm test' }],
  domainVocabulary: {
    hasSpecializedVocabulary: true,
    entries: [{ term: 'Slot', definition: 'A bookable interval of one fictional practitioner.' }],
  },
  gitPolicyDirective: '4. **Git policy:** Work on feature branches; never push without review.',
});
const record = () => JSON.parse(RECORD_TEXT);

const DECISIONS = [
  { id: 'D1-runtime', outcome: 'promote', destination: '.apex/project-architecture.md',
    content: '- Runtime: the synthetic Node runtime, chosen because the fixture needs no install. The manifest holds the resolved version.' },
  { id: 'D2-layout', outcome: 'promote', destination: '.apex/standards/app.md',
    content: '- Keep request handlers in `src/app.js`; a chosen rule, because the representative path crosses one module.' },
  { id: 'D3-booking', outcome: 'promote', destination: '.apex/glossary.md',
    content: '- **Booking:** a confirmed Slot for one fictional patient.' },
  { id: 'D4-waiting-list', outcome: 'promote', destination: '.apex/project-context.md',
    content: '- Waiting list: seen in the synthetic prototype, not built. Context for later work.' },
  { id: 'D5-tests', outcome: 'promote', destination: '.apex/testing-and-checklist.md',
    content: '- Run `npm test` before every commit; it covers the representative path.' },
  { id: 'D6-errors', outcome: 'promote', destination: '.apex/conventions.md',
    content: '- Errors cross the boundary as one error object; a chosen rule, not yet observed in code.' },
  // Every section init creates from a template gets a promoted text: the
  // surface standard's Scope and Anti-patterns beside D2's Conventions, and
  // each project-document section, including an explicit undecided one.
  { id: 'D8-app-scope', outcome: 'promote', destination: '.apex/standards/app.md',
    content: '- Owns: the synthetic booking handlers in `src/app.js`.\n- Does NOT own: the test harness in `test/app.test.js`.\n- Exemplar: `src/app.js`' },
  { id: 'D9-app-traps', outcome: 'promote', destination: '.apex/standards/app.md',
    content: '- Never add a second booking entry point; the representative path crosses one module.' },
  { id: 'D10-reasons', outcome: 'promote', destination: '.apex/project-architecture.md',
    content: '- Each cross-cutting decision above carries its reason inline.' },
  { id: 'D11-versions', outcome: 'promote', destination: '.apex/project-architecture.md',
    content: '- Take a new version only through a reviewed change; the manifest holds the resolved version.' },
  { id: 'D12-intent', outcome: 'promote', destination: '.apex/project-context.md',
    content: '- A fictional booking app that exists only for the hermetic inception matrix.' },
  { id: 'D13-prototype', outcome: 'promote', destination: '.apex/project-context.md',
    content: '- The synthetic prototype books one Slot; its waiting-list screen is a mock.' },
  { id: 'D14-boundaries', outcome: 'promote', destination: '.apex/project-context.md',
    content: '- The bootstrap books one Slot through `src/app.js`; deploy is left out.' },
  { id: 'D15-open-questions', outcome: 'promote', destination: '.apex/project-context.md',
    content: '- Not decided at inception; refine with `discovery`.' },
  { id: 'D7-queue', outcome: 'exclude',
    reason: `A rejected alternative (${EXCLUDED_SENTINEL}); its reasons stay in the local project record.` },
];

// The template section each SYNTHETIC promoted text fills; a text without an
// entry goes to its document's default section.
const SECTIONS = {
  'D8-app-scope': '## Scope',
  'D9-app-traps': '## Anti-patterns',
  'D10-reasons': '## Reasons',
  'D11-versions': '## Version policy',
  'D12-intent': '## Intent',
  'D13-prototype': '## Design, prototype, and behaviors',
  'D14-boundaries': '## Bootstrap boundaries',
  'D15-open-questions': '## Open questions',
};

const PROJECT_TEXT = [
  '# Project — Inception Record',
  '',
  '> SYNTHETIC fixture document of the hermetic inception matrix; it describes no real project.',
  '',
  '## Materials, facts, and simulations',
  '- An empty repository plus a starter placeholder agent file; the waiting-list screen is a mock.',
  '',
  '## Representative path',
  '- Book one Slot through `src/app.js`.',
  '',
  '## Evidence and chosen deploy',
  '- Deploy excluded: the fixture has no deploy target.',
  '',
].join('\n');

const VERIFICATION_TEXT = [
  '# Verification — Inception Record',
  '',
  '> SYNTHETIC: the hermetic suite runs no package manager, build, server, or deploy.',
  '',
  '## Checks',
  '- install: not-executed (hermetic fixture)',
  '- test: not-executed (hermetic fixture)',
  '',
  '## Deploy',
  '- Excluded: the fixture has no deploy target.',
  '',
].join('\n');

const handoffValue = (overrides = {}) => ({
  'inception-handoff': 'steepy-apex/v1',
  next: 'init',
  'run-id': RUN,
  required: {
    state: STATE,
    approval: APPROVAL,
    project: [PROJECT],
    verification: [CHECKPOINT, VERIFICATION],
    'confirmed-inputs': CONFIRMED,
    promotion: PROMOTION,
  },
  ...overrides,
});

// ---------------------------------------------------------------------------
// Sandbox, hermetic environment, and CLI runner.
function withSandbox(suffix, fn) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `steepy-inception-integration-${suffix}-`)));
  try {
    const home = join(root, 'home');
    const sandbox = {
      root,
      repo: join(root, 'repo'),
      outside: join(root, 'outside'),
      logs: 0,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_CACHE_HOME: join(home, '.cache'),
        XDG_DATA_HOME: join(home, '.local', 'share'),
        XDG_STATE_HOME: join(home, '.local', 'state'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: devNull,
        GIT_CEILING_DIRECTORIES: root,
        GIT_AUTHOR_NAME: 'Synthetic Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
        GIT_COMMITTER_NAME: 'Synthetic Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
        LC_ALL: 'C',
      },
    };
    for (const directory of [sandbox.repo, sandbox.outside, sandbox.env.XDG_CONFIG_HOME, sandbox.env.XDG_CACHE_HOME,
      sandbox.env.XDG_DATA_HOME, sandbox.env.XDG_STATE_HOME]) {
      mkdirSync(directory, { recursive: true });
    }
    return fn(sandbox);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function put(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function git(sandbox, args, cwd = sandbox.repo) {
  const result = spawnSync('git', args, { cwd, env: sandbox.env, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

function within(path, directory) {
  const candidate = path.toLowerCase();
  const prefix = directory.toLowerCase();
  return candidate === prefix || candidate.startsWith(`${prefix}${sep}`);
}

const LOCAL_AREA = /(^|\/)\.apex\/(inception|work)(\/|$)/iu;

// Reads and enumerations stay inside the sandbox or the engine's own scripts
// and templates. Inside a local area only the exact files the step names may
// be read, nothing may be enumerated, and nothing outside the sandbox (the
// user's home, configuration, sessions, or this checkout's own hub) is touched.
function forbiddenAccesses(sandbox, accesses, allowLocal = []) {
  const allowed = new Set(allowLocal.map((path) => join(sandbox.repo, path).toLowerCase()));
  return accesses.filter(([kind, path]) => {
    if (within(path, SCRIPTS) || within(path, TEMPLATES)) return kind === 'write' || kind === 'list';
    if (!within(path, sandbox.root)) return true;
    const relativePath = relative(sandbox.root, path).split(sep).join('/');
    if (!LOCAL_AREA.test(relativePath)) return false;
    if (kind === 'list') return true;
    if (kind !== 'read') return false;
    return !allowed.has(path.toLowerCase());
  });
}

function assertAccesses(sandbox, label, accesses, allowLocal) {
  assert.deepEqual(forbiddenAccesses(sandbox, accesses, allowLocal), [], `${label}: forbidden read or enumeration`);
  for (const path of UNNAMED_RUN_FILES) {
    assert.ok(!accesses.some(([, accessed]) => accessed.toLowerCase() === join(sandbox.repo, path).toLowerCase()),
      `${label}: unnamed run file ${path} was accessed`);
  }
}

function runCli(sandbox, script, args, { allowLocal = [], input = '', cwd = sandbox.repo, interruptAfter } = {}) {
  sandbox.logs += 1;
  const log = join(sandbox.outside, `access-${sandbox.logs}.json`);
  const imports = ['--import', RECORDER_URL];
  let hook;
  if (interruptAfter !== undefined) {
    hook = join(sandbox.outside, `interrupt-${sandbox.logs}.mjs`);
    writeFileSync(hook, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const rename = fs.renameSync, sync = fs.fsyncSync;
      const targets = ${JSON.stringify([join(sandbox.repo, STATE), join(sandbox.repo, RECEIPT)])};
      let pending = false, durable = 0;
      fs.renameSync = function(from, to) {
        const result = rename(from, to);
        if (targets.includes(String(to))) pending = true;
        return result;
      };
      fs.fsyncSync = function(fd) {
        const result = sync(fd);
        if (pending && fs.fstatSync(fd).isDirectory()) {
          pending = false;
          if (++durable === ${interruptAfter}) process.exit(86);
        }
        return result;
      };
      syncBuiltinESMExports();
    `);
    imports.push('--import', hook);
  }
  const result = spawnSync(process.execPath, [...imports, join(SCRIPTS, script), ...args], {
    cwd,
    env: { ...sandbox.env, STEEPY_TEST_ACCESS_LOG: log },
    input,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (hook) rmSync(hook);
  assert.equal(result.error, undefined, `${script}: ${result.error?.message}`);
  const accesses = JSON.parse(readFileSync(log, 'utf8'));
  rmSync(log);
  assertAccesses(sandbox, `${script} ${args[0] ?? ''}`, accesses, allowLocal);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(`${LOCAL_SENTINEL}|${EXCLUDED_SENTINEL}`, 'u'),
    `${script}: local bodies never reach the output`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Runs an in-process helper under the recorder and applies the same policy.
function audited(sandbox, label, allowLocal, fn) {
  const { result, error, accesses } = recordAccess(fn);
  assertAccesses(sandbox, label, accesses, allowLocal);
  if (error) throw error;
  return result;
}

const inceptionState = (sandbox, args, allowLocal = [GUARD, STATE]) => runCli(sandbox, 'inception-state.mjs',
  [args[0], '--root', sandbox.repo, '--state', STATE, ...args.slice(1)], { allowLocal });
const inceptionHandoff = (sandbox, args, allowLocal = TRANSFER) => runCli(sandbox, 'inception-handoff.mjs',
  [args[0], '--root', sandbox.repo, ...args.slice(1)], { allowLocal });

// Bytes, mode, and mtime of every file below `root`, plus every directory and
// its mode. Git's own `.git` bookkeeping is not project content.
function treeSnapshot(root) {
  const entries = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (directory === root && entry.name === '.git') continue;
      const path = join(directory, entry.name);
      const stat = lstatSync(path, { bigint: true });
      const name = relative(root, path).split(sep).join('/');
      const mode = Number(stat.mode & 0o7777n);
      if (entry.isDirectory()) {
        entries.push([name, 'directory', mode]);
        walk(path);
      } else {
        entries.push([name, 'file', mode, stat.mtimeNs.toString(), readFileSync(path).toString('base64')]);
      }
    }
  };
  walk(root);
  return entries;
}

// Moves every file's mtime to a fixed past instant, so any later rewrite is
// visible whatever the filesystem's timestamp granularity.
const PAST = new Date('2020-01-01T00:00:00Z');
function ageTree(root) {
  for (const [name, kind] of treeSnapshot(root)) if (kind === 'file') utimesSync(join(root, name), PAST, PAST);
}

const bytesOnly = (snapshot) => snapshot.map(([name, kind, mode, , bytes]) => [name, kind, mode, bytes]);
const errorsOf = (violations) => violations.filter(({ level }) => level === 'error');
const descriptorSha = (sandbox) => sha(readFileSync(join(sandbox.repo, STATE)));
const bind = (sandbox, path) => ({ path, sha256: sha(readFileSync(join(sandbox.repo, path))) });

// ---------------------------------------------------------------------------
// SYNTHETIC stand-in for the hub documents init writes (Step 4 plus the
// promotion writes). A missing document is created from the engine templates
// and the authoritative record with its promoted texts; an existing document
// only gains a promoted text it still misses, appended. Existing bytes are
// never rewritten, so a human edit survives.
function hubDocuments(source, { withProjectDocs = true } = {}) {
  const surface = source.surfaces[0];
  const row = renderTemplate(template('routing-row.md'), {
    surface: surface.name, docsPath: `standards/${surface.name}.md`, agent: surface.agent, skill: '—',
  }).trimEnd();
  const index = renderTemplate(template('_INDEX.md'), {
    projectName: source.projectName, routingRows: row, gitPolicyDirective: source.gitPolicyDirective,
  });
  const linkedIndex = withProjectDocs ? index.replace('- [Testing & Checklist](testing-and-checklist.md)\n',
    '- [Testing & Checklist](testing-and-checklist.md)\n- [Project Context](project-context.md)\n- [Project Architecture](project-architecture.md)\n')
    : index;
  const terms = source.domainVocabulary.entries.map(({ term, definition }) => `- **${term}:** ${definition}\n`).join('');
  return [
    { path: '.apex/_INDEX.md', text: linkedIndex },
    { path: '.apex/conventions.md', text: '# Conventions\n\n## Chosen rules\n', section: '## Chosen rules' },
    { path: '.apex/glossary.md', text: `# Glossary\n\n${terms}` },
    { path: '.apex/testing-and-checklist.md', text: '# Testing & Checklist\n\n- Narrowest check first, then the full suite.\n' },
    { path: `.apex/standards/${surface.name}.md`, section: '## Conventions',
      text: renderTemplate(template('surface-standard.md'), { name: surface.name, path: surface.path, testCmd: surface.testCmd }) },
    ...(withProjectDocs ? [
      { path: '.apex/project-context.md', text: template('project-context.md'), section: '## Future flows' },
      { path: '.apex/project-architecture.md', text: template('project-architecture.md'), section: '## Cross-cutting decisions' },
    ] : []),
    { path: '.apex/work/.gitignore', text: '*\n!.gitignore\n' },
  ];
}

// A template placeholder is the parenthesized guidance a template leaves under
// a heading, e.g. `- Owns: (what this surface is responsible for)`. A section
// whose first body line is one holds only guidance: its whole body is the
// placeholder block init replaces.
const PLACEHOLDER_LINE = /^(?:- (?:[A-Za-z ]+: )?)?`?\(/u;
function placeholderBlocks(text) {
  const lines = text.split('\n');
  const blocks = new Map();
  lines.forEach((line, index) => {
    if (!line.startsWith('## ')) return;
    const next = lines.findIndex((candidate, at) => at > index && candidate.startsWith('## '));
    const body = lines.slice(index + 1, next === -1 ? lines.length : next);
    const first = body.findIndex((candidate) => candidate.trim() !== '');
    if (first === -1 || !PLACEHOLDER_LINE.test(body[first])) return;
    const last = body.findLastIndex((candidate) => candidate.trim() !== '');
    blocks.set(line, body.slice(first, last + 1));
  });
  return blocks;
}

function writeHubDocument(repo, document, decisions) {
  const promoted = decisions.filter(({ outcome, destination }) => outcome === 'promote' && destination === document.path);
  const contents = promoted.map(({ content }) => `${content}\n`);
  const target = join(repo, document.path);
  if (!existsSync(target)) {
    // A document this transfer creates: each promoted text replaces the
    // placeholder block of its section; a section without one gains the text
    // right after its heading, and a document without sections at its end.
    let text = document.text;
    const bySection = new Map();
    for (const { id, content } of promoted) {
      const section = SECTIONS[id] ?? document.section ?? null;
      bySection.set(section, [...(bySection.get(section) ?? []), `${content}\n`]);
    }
    const placeholders = placeholderBlocks(text);
    for (const [section, texts] of bySection) {
      const block = placeholders.get(section);
      if (block) {
        text = text.replace(block.join('\n'), () => texts.join('').trimEnd());
        continue;
      }
      const at = section ? text.indexOf(`${section}\n`) : -1;
      const insert = at === -1 ? text.length : at + section.length + 1;
      text = `${text.slice(0, insert)}${texts.join('')}${text.slice(insert)}`;
    }
    put(repo, document.path, text);
    if (document.path === '.apex/work/.gitignore') {
      for (const area of ['specs', 'plans']) mkdirSync(join(repo, '.apex', 'work', area), { recursive: true });
    }
    return 'created';
  }
  const current = readFileSync(target, 'utf8');
  const missing = contents.filter((content) => !current.includes(content.trimEnd()));
  if (missing.length === 0) return 'kept';
  appendFileSync(target, `${current.endsWith('\n') ? '' : '\n'}${missing.join('')}`);
  return 'appended';
}

const HUB_WRITE_STEPS = hubDocuments(record()).map(({ path }) => `write ${path}`);
const INIT_STEPS = ['prepare', 'apply', ...HUB_WRITE_STEPS, 'finalize', 'close'];

// SYNTHETIC user answer to planner conflicts: replace only the starter's own
// placeholder agent; any other conflict is answered `abort`.
const answerStarterOnly = (conflicts) => (conflicts.every(({ id }) => id === STARTER_CONFLICT)
  ? Object.fromEntries(conflicts.map(({ id }) => [id, 'replace']))
  : null);

// The files Git would version (or, without Git, every file outside both local
// areas), copied to a directory outside the repository.
function versionedCopy(sandbox, { withGit = true } = {}) {
  const target = join(sandbox.outside, 'versioned-copy');
  rmSync(target, { recursive: true, force: true });
  const files = withGit
    ? git(sandbox, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean)
    : treeSnapshot(sandbox.repo).filter(([name, kind]) => kind === 'file' && !LOCAL_AREA.test(name)).map(([name]) => name);
  for (const file of files) {
    mkdirSync(dirname(join(target, file)), { recursive: true });
    copyFileSync(join(sandbox.repo, file), join(target, file));
  }
  return { target, files: files.sort() };
}

// ---------------------------------------------------------------------------
// SYNTHETIC stand-in for the inception skill up to the transfer (phases
// reconnaissance → init), driven through the real in-process helpers.
function buildReadyRun(sandbox, { withGit = true } = {}) {
  const { repo, env } = sandbox;
  if (withGit) git(sandbox, ['init', '-q', '-b', 'main']);
  startInceptionRun(repo, { runId: RUN, env });
  put(repo, UNNAMED_RUN_FILES[0], `# Reconnaissance\n\n${LOCAL_SENTINEL}\n`);
  put(repo, UNNAMED_RUN_FILES[1], `# Runtime research\n\n${LOCAL_SENTINEL}\n`);
  put(repo, PROJECT, PROJECT_TEXT);
  put(repo, APPROVAL, json({ 'inception-approval': 'steepy-apex/v1', 'run-id': RUN, project: [bind(sandbox, PROJECT)] }));
  updateInceptionState(repo, {
    expectedSha256: descriptorSha(sandbox), changes: { approval: bind(sandbox, APPROVAL), phase: 'bootstrap' },
  });
  put(repo, 'package.json', '{"name":"synthetic-clinic","private":true,"scripts":{"test":"node --test"}}\n');
  put(repo, 'src/app.js', 'export const book = (slot) => ({ booked: slot });\n');
  put(repo, 'test/app.test.js', "import { book } from '../src/app.js';\nbook('slot-1');\n");
  put(repo, STARTER_AGENT, '# Starter placeholder agent (SYNTHETIC)\n');
  put(repo, UNNAMED_RUN_FILES[2], `# Bootstrap log\n\n${LOCAL_SENTINEL}\n`);
  if (withGit) {
    git(sandbox, ['add', '-A']);
    git(sandbox, ['commit', '-q', '-m', 'SYNTHETIC bootstrap']);
  }
  writeCodeCheckpoint(repo, { runId: RUN, output: CHECKPOINT, paths: CODE_PATHS, env });
  updateInceptionState(repo, {
    expectedSha256: descriptorSha(sandbox), changes: { checkpoint: bind(sandbox, CHECKPOINT), phase: 'verification' },
  });
  put(repo, VERIFICATION, VERIFICATION_TEXT);
  put(repo, CONFIRMED, RECORD_TEXT);
  put(repo, PROMOTION, json({ 'inception-promotion': 'steepy-apex/v1', 'run-id': RUN, decisions: DECISIONS }));
  put(repo, HANDOFF, json(handoffValue()));
  updateInceptionState(repo, { expectedSha256: descriptorSha(sandbox), changes: { phase: 'init' } });
}

// A table of cases shares one ready run, built once in its own sandbox and
// copied into each case's sandbox; no case sees another case's writes.
function withReadyRuns(suffix, fn) {
  return withSandbox(`${suffix}-ready`, (template) => {
    buildReadyRun(template);
    return fn((caseSuffix, body) => withSandbox(caseSuffix, (sandbox) => {
      cpSync(template.repo, sandbox.repo, { recursive: true });
      return body(sandbox);
    }));
  });
}

// SYNTHETIC stand-in for the init skill's inception entry and the inception
// skill's close. Each deterministic step is a real, audited helper call; the
// stand-in sequences them, answers planner conflicts, and writes the hub
// documents. `stopAfter` interrupts right after that step's durable effect.
function runInitEntry(sandbox, { stopAfter, answer = answerStarterOnly, withGit = true, before = () => {} } = {}) {
  const { repo, env } = sandbox;
  const trace = [];
  const stop = (step) => {
    trace.push(step);
    return step === stopAfter;
  };
  const close = () => {
    const current = audited(sandbox, 'close inspect', [GUARD, STATE], () => inspectInceptionState(repo));
    if (current.descriptor.phase === 'complete') return false;
    audited(sandbox, 'close', [GUARD, STATE, APPROVAL, CHECKPOINT, HANDOFF, RECEIPT], () => updateInceptionState(repo, {
      expectedSha256: current.sha256, changes: { phase: 'complete', status: 'complete' },
    }));
    return true;
  };

  const inspected = audited(sandbox, 'inspect', [GUARD, STATE], () => inspectInceptionState(repo));
  if (inspected.state === 'init-complete') {
    close();
    return { outcome: 'complete', trace };
  }
  assert.ok(['pre-hub', 'init-in-progress'].includes(inspected.state), `unexpected state ${inspected.state}`);
  const handoff = inspected.state === 'init-in-progress' ? inspected.descriptor.init.handoff.path : HANDOFF;
  const transfer = [...TRANSFER, handoff];
  const report = audited(sandbox, 'verify', transfer, () => verifyInceptionHandoff(repo, { handoff, env }));
  assert.equal(report.status, 'verified');
  if (inspected.descriptor.init.finalization) {
    assert.equal(linterState(repo), 'hub');
    const finalized = audited(sandbox, 'resume finalize', [...transfer, RECEIPT], () => finalizeInitReceipt(repo, {
      handoff, gate: 'pass', env,
    }));
    close();
    return { outcome: 'complete', trace: ['finalize', 'close'], finalized };
  }

  let prepared = null;
  before('prepare');
  prepared = audited(sandbox, 'prepare', [...transfer, RECEIPT], () => prepareInitReceipt(repo, {
    handoff, receipt: inspected.state === 'init-in-progress' ? undefined : RECEIPT, env,
  }));
  if (stop('prepare')) return { outcome: 'stopped', trace, prepared };

  let resolutions = {};
  let plan;
  for (;;) {
    const model = projectConfirmedInputs(report.confirmedInputs, { resolutions });
    plan = audited(sandbox, 'preview', [], () => planProjectScaffold({ hubRoot: repo, model }));
    if (plan.conflicts.length === 0) break;
    const chosen = answer(plan.conflicts);
    if (chosen === null) return { outcome: 'aborted', trace, conflicts: plan.conflicts };
    assert.notDeepEqual(chosen, resolutions, 'the same conflict is never asked twice');
    resolutions = chosen;
  }
  const preview = previewProjectScaffold(plan);
  before('apply');
  const applied = audited(sandbox, 'apply', [], () => applyProjectScaffold({ hubRoot: repo, plan }));
  if (stop('apply')) return { outcome: 'stopped', trace, prepared, preview };

  const writes = [];
  for (const document of hubDocuments(report.confirmedInputs)) {
    before(`write ${document.path}`);
    writes.push([document.path, writeHubDocument(repo, document, report.promotion.decisions)]);
    if (stop(`write ${document.path}`)) return { outcome: 'stopped', trace, preview, writes };
  }

  const gate = audited(sandbox, 'gate', [], () => classifyHub(repo));
  assert.equal(gate.state, 'hub');
  assert.deepEqual(errorsOf(gate.violations), []);
  const copy = versionedCopy(sandbox, { withGit });
  const copyGate = audited(sandbox, 'copy gate', [], () => classifyHub(copy.target));
  rmSync(copy.target, { recursive: true, force: true });
  assert.equal(copyGate.state, 'hub');
  assert.deepEqual(errorsOf(copyGate.violations), []);

  before('finalize');
  const finalized = audited(sandbox, 'finalize', [...transfer, RECEIPT], () => finalizeInitReceipt(repo, {
    handoff, gate: 'pass', env,
  }));
  if (stop('finalize')) return { outcome: 'stopped', trace, prepared, preview, writes, applied, finalized };
  before('close');
  const closed = close();
  stop('close');
  return { outcome: 'complete', trace, prepared, preview, writes, applied, finalized, closed };
}

// ===========================================================================
// The vertical path through the public CLIs, the versioned-only copy, and
// the exact final repetition.
test('vertical: start, ignored area, pre-hub, approval, transfer, planner, hub, receipt, and a versioned-only copy compose through the public CLIs', () => withSandbox('vertical', (sandbox) => {
  const { repo, outside } = sandbox;
  const validate = (root = repo, allowLocal = []) => runCli(sandbox, 'validate-hub.mjs', [root], { allowLocal });
  const hook = (root = repo, allowLocal = []) => runCli(sandbox, 'stop-hook.mjs', [root], { input: '{}', allowLocal });
  const update = (changes, allowLocal) => inceptionState(sandbox, ['update', '--expected-sha256', descriptorSha(sandbox),
    '--set', JSON.stringify(changes)], allowLocal);

  // start → the area is ignored from its first byte.
  git(sandbox, ['init', '-q', '-b', 'main']);
  const started = inceptionState(sandbox, ['start', '--run-id', RUN]);
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(JSON.parse(started.stdout).git, { state: 'ignored', tracked: [], trackedCount: 0 });
  assert.equal(readFileSync(join(repo, GUARD), 'utf8'), '*\n');
  assert.equal(git(sandbox, ['status', '--porcelain', '--ignored']), '!! .apex/\n');
  assert.equal(git(sandbox, ['ls-files', '--others', '--exclude-standard']), '');

  // pre-hub is recognized and never called coherent.
  const preHub = validate(repo, [GUARD, STATE]);
  assert.equal(preHub.status, 0, preHub.stderr);
  assert.match(preHub.stdout, new RegExp(`valid pre-hub inception state \\(run ${RUN}, phase reconnaissance\\)`, 'u'));
  assert.doesNotMatch(preHub.stdout, /coherent/u);
  assert.deepEqual(hook(repo, [GUARD, STATE]), { status: 0, stdout: '', stderr: '' });

  // Reconnaissance, architecture, and research documents (SYNTHETIC).
  put(repo, UNNAMED_RUN_FILES[0], `# Reconnaissance\n\n${LOCAL_SENTINEL}\n`);
  put(repo, UNNAMED_RUN_FILES[1], `# Runtime research\n\n${LOCAL_SENTINEL}\n`);
  put(repo, PROJECT, PROJECT_TEXT);
  assert.equal(update({ phase: 'approval' }).status, 0);

  // A declared approval does not unlock bootstrap; only a bound record does.
  put(repo, APPROVAL, json({ 'inception-approval': 'steepy-apex/v1', 'run-id': RUN, project: [bind(sandbox, PROJECT)] }));
  const beforeRefusal = treeSnapshot(repo);
  const unapproved = update({ phase: 'bootstrap' });
  assert.equal(unapproved.status, 1);
  assert.match(unapproved.stderr, /phase bootstrap requires an approval reference/u);
  assert.deepEqual(treeSnapshot(repo), beforeRefusal, 'a refused update writes nothing');
  const approved = update({ approval: bind(sandbox, APPROVAL), phase: 'bootstrap' }, [GUARD, STATE, APPROVAL]);
  assert.equal(approved.status, 0, approved.stderr);

  // SYNTHETIC bootstrap with a starter placeholder, committed by the user.
  put(repo, 'package.json', '{"name":"synthetic-clinic","private":true,"scripts":{"test":"node --test"}}\n');
  put(repo, 'src/app.js', 'export const book = (slot) => ({ booked: slot });\n');
  put(repo, 'test/app.test.js', "import { book } from '../src/app.js';\nbook('slot-1');\n");
  put(repo, STARTER_AGENT, '# Starter placeholder agent (SYNTHETIC)\n');
  put(repo, UNNAMED_RUN_FILES[2], `# Bootstrap log\n\n${LOCAL_SENTINEL}\n`);
  git(sandbox, ['add', '-A']);
  git(sandbox, ['commit', '-q', '-m', 'SYNTHETIC bootstrap']);
  assert.doesNotMatch(git(sandbox, ['ls-files']), /\.apex/u, 'no inception file is ever versioned');

  const checkpoint = inceptionHandoff(sandbox, ['checkpoint', '--run-id', RUN, '--output', CHECKPOINT,
    ...CODE_PATHS.flatMap((path) => ['--path', path])], [GUARD, STATE, CHECKPOINT]);
  assert.equal(checkpoint.status, 0, checkpoint.stderr);
  const head = git(sandbox, ['rev-parse', 'HEAD']).trim();
  assert.deepEqual(JSON.parse(readFileSync(join(repo, CHECKPOINT), 'utf8')).git, { branch: 'main', head });
  assert.equal(update({ checkpoint: bind(sandbox, CHECKPOINT), phase: 'verification' },
    [GUARD, STATE, APPROVAL, CHECKPOINT]).status, 0);
  put(repo, VERIFICATION, VERIFICATION_TEXT);
  put(repo, CONFIRMED, RECORD_TEXT);
  put(repo, PROMOTION, json({ 'inception-promotion': 'steepy-apex/v1', 'run-id': RUN, decisions: DECISIONS }));
  put(repo, HANDOFF, json(handoffValue()));
  assert.equal(update({ phase: 'init' }, [GUARD, STATE, APPROVAL, CHECKPOINT]).status, 0);
  assert.equal(validate(repo, [GUARD, STATE]).status, 0, 'a run ready for init is still a pre-hub');
  const recordBefore = lstatSync(join(repo, CONFIRMED), { bigint: true });

  // The init entry: route, verify, start init, project, preview, choose, apply.
  const routed = inceptionState(sandbox, ['inspect']);
  assert.equal(JSON.parse(routed.stdout).state, 'pre-hub');
  const verified = inceptionHandoff(sandbox, ['verify', '--handoff', HANDOFF]);
  assert.equal(verified.status, 0, verified.stderr);
  const report = JSON.parse(verified.stdout);
  assert.equal(report.status, 'verified');
  assert.deepEqual(report.inputs.map(({ role, path }) => [role, path]), [
    ['approval', APPROVAL], ['project', PROJECT], ['verification', CHECKPOINT], ['verification', VERIFICATION],
    ['confirmed-inputs', CONFIRMED], ['promotion', PROMOTION],
  ]);
  const prepared = inceptionHandoff(sandbox, ['prepare', '--handoff', HANDOFF, '--receipt', RECEIPT],
    [...TRANSFER, RECEIPT]);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(JSON.parse(inceptionState(sandbox, ['inspect']).stdout).state, 'init-in-progress');
  const inProgress = validate(repo, [GUARD, STATE]);
  assert.equal(inProgress.status, 1, 'init in progress without an index is an error, not a pre-hub');
  assert.match(inProgress.stderr, /inception: init is in-progress/u);
  assert.equal(JSON.parse(hook(repo, [GUARD, STATE]).stdout).decision, 'block');

  const model = join(outside, 'planner-model.json');
  const project = (resolutions = []) => {
    const projected = inceptionHandoff(sandbox, ['project', '--handoff', HANDOFF,
      ...resolutions.flatMap((resolution) => ['--resolution', resolution])]);
    assert.equal(projected.status, 0, projected.stderr);
    writeFileSync(model, projected.stdout);
    return JSON.parse(projected.stdout);
  };
  const scaffold = (apply = false) => runCli(sandbox, 'project-scaffold.mjs',
    ['--hub', repo, '--model', model, ...(apply ? ['--apply'] : [])]);
  const firstModel = project();
  assert.deepEqual(Object.keys(firstModel), ['projectName', 'description', 'devCommands', 'surfaces', 'resolutions']);
  const firstPreview = scaffold();
  assert.equal(firstPreview.status, 1, 'a conflict is a question, not a write');
  assert.deepEqual(JSON.parse(firstPreview.stdout).conflicts.map(({ id, choices }) => [id, choices]),
    [[STARTER_CONFLICT, ['replace', 'abort']]]);
  const chosenModel = project([`${STARTER_CONFLICT}=replace`]);
  assert.deepEqual(chosenModel.resolutions, { [STARTER_CONFLICT]: 'replace' });
  const clean = scaffold();
  assert.equal(clean.status, 0, clean.stderr);
  assert.deepEqual(JSON.parse(clean.stdout).conflicts, []);
  const applied = scaffold(true);
  assert.equal(applied.status, 0, applied.stderr);
  const appliedPaths = JSON.parse(applied.stdout.trim().split('\n').at(-1)).result.paths;
  assert.deepEqual([...appliedPaths].sort(), ['.agents/skills/synthetic-clinic-bootstrap/SKILL.md', '.claude/agents/app-agent.md',
    '.claude/skills/synthetic-clinic-bootstrap/SKILL.md', '.codex/agents/app-agent.toml', '.opencode/agents/app-agent.md',
    'AGENTS.md', 'CLAUDE.md']);

  // The authoritative record keeps six fields; the planner saw exactly five keys.
  const source = record();
  assert.deepEqual(Object.keys(source), [...CONFIRMED_INPUT_KEYS]);
  for (const key of ['projectName', 'description', 'devCommands', 'surfaces']) {
    assert.deepEqual(chosenModel[key], source[key], `the projection copies ${key} without loss`);
  }
  const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes(source.description), 'the planner rendered the projected description');
  for (const command of source.devCommands) assert.ok(agents.includes(command), `root instructions list ${command}`);

  // SYNTHETIC stand-in: the hub documents init writes, then the hub gate.
  for (const document of hubDocuments(source)) writeHubDocument(repo, document, DECISIONS);
  const gate = validate();
  assert.equal(gate.status, 0, gate.stderr);
  assert.match(gate.stdout, /OK — doc graph is coherent/u);
  assert.equal(gate.stderr, '', 'the gate carries no warning');

  // A copy of only what Git would version stands alone.
  const copy = versionedCopy(sandbox);
  assert.equal(copy.files.filter((file) => file.startsWith('.apex/inception/')).length, 0);
  assert.deepEqual(copy.files.filter((file) => file.startsWith('.apex/work/')), ['.apex/work/.gitignore']);
  const copyGate = validate(copy.target);
  assert.equal(copyGate.status, 0, copyGate.stderr);
  assert.match(copyGate.stdout, /OK — doc graph is coherent/u);
  assert.deepEqual(hook(copy.target), { status: 0, stdout: '', stderr: '' });
  // Once applied, the starter conflict is gone: a stale resolution is dropped
  // and the projection is derived again, never edited.
  assert.deepEqual(project().resolutions, {});
  const copyPlan = runCli(sandbox, 'project-scaffold.mjs', ['--hub', copy.target, '--model', model]);
  assert.equal(copyPlan.status, 0, copyPlan.stderr);
  assert.deepEqual(JSON.parse(copyPlan.stdout), { schemaVersion: 1, event: 'preview', preview: [], conflicts: [] },
    'root instructions, bootstrap, and adapter triads are canonical in the copy');
  const stable = Object.fromEntries(copy.files.map((file) => [file, readFileSync(join(copy.target, file), 'utf8')]));
  for (const decision of DECISIONS.filter(({ outcome }) => outcome === 'promote')) {
    assert.ok(stable[decision.destination]?.includes(decision.content), `${decision.id} is in the stable copy`);
  }
  // Every document the transfer created from a template is filled: the
  // promotion table covers each section, so no placeholder line survives.
  const filled = [];
  for (const document of hubDocuments(source)) {
    const guidance = [...placeholderBlocks(document.text).values()].flat();
    if (guidance.length === 0) continue;
    filled.push(document.path);
    const lines = stable[document.path].split('\n');
    for (const line of guidance) {
      assert.ok(!lines.includes(line), `${document.path} keeps no template placeholder line: ${line}`);
    }
  }
  assert.deepEqual(filled, ['.apex/standards/app.md', '.apex/project-context.md', '.apex/project-architecture.md']);
  const futureFlows = stable['.apex/project-context.md'].split('## Future flows\n')[1].split('\n## ')[0];
  assert.ok(futureFlows.includes(DECISIONS[3].content), 'the deferred flow is future context, not a component');
  for (const [file, text] of Object.entries(stable)) {
    assert.doesNotMatch(text, new RegExp(`${EXCLUDED_SENTINEL}|${LOCAL_SENTINEL}|${RUN}`, 'u'),
      `${file} carries no excluded decision, local body, or run reference`);
  }
  rmSync(copy.target, { recursive: true, force: true });

  // Finalize writes the receipt and init complete; close the run.
  const finalized = inceptionHandoff(sandbox, ['finalize', '--handoff', HANDOFF, '--gate', 'pass'], [...TRANSFER, RECEIPT]);
  assert.equal(finalized.status, 0, finalized.stderr);
  assert.deepEqual(JSON.parse(finalized.stdout).changed, { state: true, receipt: true });
  const receipt = JSON.parse(readFileSync(join(repo, RECEIPT), 'utf8'));
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.gate, 'pass');
  assert.deepEqual(receipt.decisions.map(({ id, outcome }) => [id, outcome]),
    DECISIONS.map(({ id, outcome }) => [id, outcome === 'promote' ? 'promoted' : 'excluded']));
  for (const write of receipt.writes) {
    assert.equal(write.previous, null, `${write.path} did not exist before init`);
    assert.equal(write.observed, sha(readFileSync(join(repo, write.path))), `${write.path} digest is the observed bytes`);
  }
  assert.equal(update({ phase: 'complete', status: 'complete' },
    [GUARD, STATE, APPROVAL, CHECKPOINT, HANDOFF, RECEIPT]).status, 0);
  assert.equal(JSON.parse(inceptionState(sandbox, ['inspect']).stdout).state, 'init-complete');

  const recordAfter = lstatSync(join(repo, CONFIRMED), { bigint: true });
  assert.equal(readFileSync(join(repo, CONFIRMED), 'utf8'), RECORD_TEXT, 'the authoritative record is byte-identical');
  assert.equal(recordAfter.mtimeNs, recordBefore.mtimeNs, 'the authoritative record was never rewritten');
  assert.equal(git(sandbox, ['rev-parse', 'HEAD']).trim(), head, 'init moved no commit');

  // Final repetition: an exact byte/mode/mtime no-op with zero planner operations.
  ageTree(repo);
  const settled = treeSnapshot(repo);
  assert.equal(validate().status, 0);
  assert.deepEqual(hook(), { status: 0, stdout: '', stderr: '' });
  const again = inceptionHandoff(sandbox, ['finalize', '--handoff', HANDOFF, '--gate', 'pass'], [...TRANSFER, RECEIPT]);
  assert.deepEqual(JSON.parse(again.stdout).changed, { state: false, receipt: false });
  const noPlan = scaffold(true);
  assert.equal(noPlan.status, 0, noPlan.stderr);
  assert.deepEqual(noPlan.stdout.trim().split('\n').map((line) => JSON.parse(line)), [
    { schemaVersion: 1, event: 'preview', preview: [], conflicts: [] },
    { schemaVersion: 1, event: 'applied', result: { applied: 0, paths: [] } },
  ]);
  const repeatedStart = inceptionHandoff(sandbox, ['prepare', '--handoff', HANDOFF], [...TRANSFER, RECEIPT]);
  assert.equal(repeatedStart.status, 1);
  assert.match(repeatedStart.stderr, /already complete/u);
  assert.deepEqual(treeSnapshot(repo), settled, 'the repetition changed no byte, mode, or mtime');

  // An index removed after activation stays an error beside the completed run.
  unlinkSync(join(repo, '.apex', '_INDEX.md'));
  const removed = validate(repo, [GUARD, STATE]);
  assert.equal(removed.status, 1);
  assert.match(removed.stderr, /missing _INDEX\.md/u);
  assert.match(removed.stderr, /inception: init is complete; an activated hub requires \.apex\/_INDEX\.md and never returns to pre-hub/u);
  assert.equal(JSON.parse(hook(repo, [GUARD, STATE]).stdout).decision, 'block');
}));

// ===========================================================================
// Pre-hub states and transfer inputs: an invalid state or input fails before
// any dependent write, and the whole tree keeps its bytes.
function assertRefusedWithoutWrites(sandbox, label, run, pattern) {
  ageTree(sandbox.repo);
  const before = treeSnapshot(sandbox.repo);
  const result = run();
  assert.equal(result.status, 1, `${label}: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, pattern, label);
  assert.equal(result.stdout, '', `${label}: a refusal emits no result`);
  assert.deepEqual(treeSnapshot(sandbox.repo), before, `${label}: zero writes`);
}

const prepareCli = (sandbox) => inceptionHandoff(sandbox, ['prepare', '--handoff', HANDOFF, '--receipt', RECEIPT],
  [...TRANSFER, RECEIPT]);
const updateCli = (sandbox, changes) => inceptionState(sandbox, ['update',
  '--expected-sha256', existsSync(join(sandbox.repo, STATE)) ? descriptorSha(sandbox) : '0'.repeat(64),
  '--set', JSON.stringify(changes)], [GUARD, STATE, APPROVAL, CHECKPOINT, HANDOFF, RECEIPT]);

// The helpers are descriptor-only by design: hub compatibility belongs to the
// linter and the Stop hook. Beside a partial hub a valid descriptor still
// admits checkpoint, update, and prepare, and prepare baselines the human
// bytes it finds as the destination's previous state without rewriting them.
const HUMAN_CONVENTIONS = '# Conventions\n\nA human rule written before init.\n';
function assertPartialHubHelpersProceed(sandbox) {
  const checkpoint2 = runFile('checkpoint-2.json');
  const recorded = inceptionHandoff(sandbox, ['checkpoint', '--run-id', RUN, '--output', checkpoint2, '--path', 'package.json'],
    [GUARD, STATE, checkpoint2]);
  assert.equal(recorded.status, 0, recorded.stderr);
  for (const status of ['blocked', 'active']) {
    const updated = updateCli(sandbox, { status });
    assert.equal(updated.status, 0, updated.stderr);
  }
  const prepared = prepareCli(sandbox);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.deepEqual(JSON.parse(prepared.stdout).destinations.find(({ path }) => path === '.apex/conventions.md'), {
    path: '.apex/conventions.md', previous: sha(HUMAN_CONVENTIONS), observed: sha(HUMAN_CONVENTIONS), state: 'pending',
  });
  assert.equal(readFileSync(join(sandbox.repo, '.apex/conventions.md'), 'utf8'), HUMAN_CONVENTIONS);
}

test('pre-hub state matrix: every observation that is not a valid pre-hub keeps its error; invalid descriptors refuse dependent writes, and descriptor-only helpers proceed beside a partial hub', () => withReadyRuns('states', (readyCase) => {
  const descriptorText = () => `${JSON.stringify({
    schemaVersion: 1, runId: RUN, phase: 'init', status: 'active', approval: null, checkpoint: null,
    init: { status: 'not-started', handoff: null, receipt: null },
  }, null, 2)}\n`;
  const cases = [
    ['no .apex', (sandbox) => rmSync(join(sandbox.repo, '.apex'), { recursive: true }),
      { exit: 0, out: /no \.apex hub found/u }, /inception state is absent/u],
    ['start stopped before its descriptor', (sandbox) => unlinkSync(join(sandbox.repo, STATE)),
      { exit: 1, err: /pre-hub state not recognized \(incomplete\)/u }, /inception state is incomplete/u],
    ['ignore guard missing', (sandbox) => unlinkSync(join(sandbox.repo, GUARD)),
      { exit: 1, err: /ignore guard is missing/u }, /inception state is invalid/u],
    ['malformed descriptor', (sandbox) => writeFileSync(join(sandbox.repo, STATE), '{'),
      { exit: 1, err: /not valid JSON/u }, /inception state is invalid/u],
    ['unknown descriptor version', (sandbox) => writeFileSync(join(sandbox.repo, STATE),
      descriptorText().replace('"schemaVersion": 1', '"schemaVersion": 2')),
    { exit: 1, err: /schemaVersion must be 1/u }, /inception state is invalid/u],
    ['declared approval field', (sandbox) => writeFileSync(join(sandbox.repo, STATE),
      descriptorText().replace('"approval": null', '"approved": true,\n  "approval": null')),
    { exit: 1, err: /unsupported field/u }, /inception state is invalid/u],
    ['incompatible combination', (sandbox) => writeFileSync(join(sandbox.repo, STATE), descriptorText()),
      { exit: 1, err: /phase init requires an approval reference/u }, /inception state is invalid/u],
    ['partial hub beside a pre-init descriptor', (sandbox) => put(sandbox.repo, '.apex/conventions.md', HUMAN_CONVENTIONS),
      { exit: 1, err: /incompatible with hub artifact \.apex\/conventions\.md/u }, null],
  ];
  for (const [label, arrange, linter, refusal] of cases) {
    readyCase('state-matrix', (sandbox) => {
      arrange(sandbox);
      const allowLocal = [GUARD, STATE];
      const linted = runCli(sandbox, 'validate-hub.mjs', [sandbox.repo], { allowLocal });
      assert.equal(linted.status, linter.exit, `${label}: ${linted.stdout}${linted.stderr}`);
      if (linter.out) assert.match(linted.stdout, linter.out, label);
      if (linter.err) {
        assert.match(linted.stderr, /missing _INDEX\.md/u, label);
        assert.match(linted.stderr, linter.err, label);
        assert.equal(JSON.parse(runCli(sandbox, 'stop-hook.mjs', [sandbox.repo], { input: '{}', allowLocal }).stdout).decision,
          'block', label);
      }
      assert.doesNotMatch(linted.stdout, /coherent/u, label);
      if (refusal === null) {
        assertPartialHubHelpersProceed(sandbox);
        return;
      }
      assertRefusedWithoutWrites(sandbox, `${label}: prepare`, () => prepareCli(sandbox), refusal);
      assertRefusedWithoutWrites(sandbox, `${label}: update`, () => updateCli(sandbox, { status: 'blocked' }),
        /no valid descriptor to update|does not match/u);
      assertRefusedWithoutWrites(sandbox, `${label}: checkpoint`, () => inceptionHandoff(sandbox,
        ['checkpoint', '--run-id', RUN, '--output', runFile('checkpoint-2.json'), '--path', 'package.json'],
        [GUARD, STATE, runFile('checkpoint-2.json')]), /inception state is/u);
      assert.equal(existsSync(join(sandbox.repo, '.apex')), label !== 'no .apex', `${label}: no area is created`);
    });
  }

  // A started init without its index is an error; its dependent writes wait
  // for realized promotions.
  readyCase('state-in-progress', (sandbox) => {
    assert.equal(prepareCli(sandbox).status, 0);
    const linted = runCli(sandbox, 'validate-hub.mjs', [sandbox.repo], { allowLocal: [GUARD, STATE] });
    assert.equal(linted.status, 1);
    assert.match(linted.stderr, /inception: init is in-progress; an activated hub requires \.apex\/_INDEX\.md/u);
    assertRefusedWithoutWrites(sandbox, 'finalize before the hub', () => inceptionHandoff(sandbox,
      ['finalize', '--handoff', HANDOFF, '--gate', 'pass'], [...TRANSFER, RECEIPT]), /is not realized/u);
    assertRefusedWithoutWrites(sandbox, 'failed gate', () => inceptionHandoff(sandbox,
      ['finalize', '--handoff', HANDOFF, '--gate', 'fail'], [...TRANSFER, RECEIPT]), /hub gate did not pass/u);
  });

  // An operational hub applies its own checks; local state is not an input.
  readyCase('state-hub', (sandbox) => {
    assert.equal(runInitEntry(sandbox).outcome, 'complete');
    writeFileSync(join(sandbox.repo, STATE), '{');
    const linted = runCli(sandbox, 'validate-hub.mjs', [sandbox.repo]);
    assert.equal(linted.status, 0, linted.stderr);
    assert.match(linted.stdout, /OK — doc graph is coherent/u);
    put(sandbox.repo, '.apex/orphan.md', '# Orphan\n');
    const broken = runCli(sandbox, 'validate-hub.mjs', [sandbox.repo]);
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /anti-orphan: \.apex\/orphan\.md/u);
  });
}));

test('transfer inputs: a missing, foreign, extraneous, or changed transfer input fails before init starts, bytes preserved', () => withReadyRuns('inputs', (readyCase) => {
  const edit = (path, text) => (sandbox) => put(sandbox.repo, path, text);
  const cases = [
    ['handoff missing', (sandbox) => unlinkSync(join(sandbox.repo, HANDOFF)), /missing inception file/u],
    ['approval record missing', (sandbox) => unlinkSync(join(sandbox.repo, APPROVAL)), /missing inception file/u],
    ['approval record changed', edit(APPROVAL, json({ 'inception-approval': 'steepy-apex/v1', 'run-id': RUN, project: [] })),
      /approval refers to other bytes/u],
    ['approved project changed', edit(PROJECT, `${PROJECT_TEXT}- A new boundary.\n`),
      /differs from its approved bytes; a substantial change needs a new approval/u],
    ['approved project missing', (sandbox) => unlinkSync(join(sandbox.repo, PROJECT)), /missing inception file/u],
    ['checkpoint missing', (sandbox) => unlinkSync(join(sandbox.repo, CHECKPOINT)), /missing inception file/u],
    ['checkpoint changed', edit(CHECKPOINT, '{}\n'), /verification refers to other bytes than the inception state recorded; it needs a new checkpoint/u],
    ['verification results missing', (sandbox) => unlinkSync(join(sandbox.repo, VERIFICATION)), /missing inception file/u],
    ['confirmed inputs missing', (sandbox) => unlinkSync(join(sandbox.repo, CONFIRMED)), /missing inception file/u],
    ['confirmed inputs outside Project model v1', edit(CONFIRMED, json({ ...record(), surfaces: [] })),
      /not a valid Project model v1 projection/u],
    ['promotion missing', (sandbox) => unlinkSync(join(sandbox.repo, PROMOTION)), /missing inception file/u],
    ['promotion without the confirmed surface standard', edit(PROMOTION, json({ 'inception-promotion': 'steepy-apex/v1', 'run-id': RUN,
      decisions: DECISIONS.filter(({ destination }) => destination !== '.apex/standards/app.md') })),
    /promotion has no promote decision for '\.apex\/standards\/app\.md', the standard of confirmed surface 'app'/u],
    ['an unapproved extra project document', (sandbox) => {
      put(sandbox.repo, runFile('extra.md'), '# An unapproved addition\n');
      put(sandbox.repo, HANDOFF, json(handoffValue({ required: { ...handoffValue().required, project: [PROJECT, runFile('extra.md')] } })));
    }, /required project must name exactly the approved project documents/u],
    ['handoff edited after init started', (sandbox) => {
      assert.equal(prepareCli(sandbox).status, 0);
      put(sandbox.repo, HANDOFF, `${JSON.stringify(handoffValue())}\n`);
    }, /the inception state pins a different init handoff/u, { started: true }],
    ['promotion of another run', edit(PROMOTION, json({ 'inception-promotion': 'steepy-apex/v1', 'run-id': OTHER_RUN, decisions: DECISIONS })),
      /run-id must be the handoff run/u],
    ['handoff names a file of another run', edit(HANDOFF, json(handoffValue({
      required: { ...handoffValue().required, promotion: runFile('promotion.json', OTHER_RUN) },
    }))), /exact file of run/u],
    ['extraneous handoff role', edit(HANDOFF, json(handoffValue({
      required: { ...handoffValue().required, research: runFile('research/runtime.md') },
    }))), /unsupported field/u],
    ['code changed after the checkpoint', edit('src/app.js', 'export const book = () => null;\n'), /diverges/u],
    ['HEAD moved after the checkpoint', (sandbox) => {
      put(sandbox.repo, 'NOTES.txt', 'SYNTHETIC late commit\n');
      git(sandbox, ['add', 'NOTES.txt']);
      git(sandbox, ['commit', '-q', '-m', 'SYNTHETIC late commit']);
    }, /diverges/u],
  ];
  for (const [label, arrange, pattern, { started = false } = {}] of cases) {
    readyCase('inputs', (sandbox) => {
      arrange(sandbox);
      assertRefusedWithoutWrites(sandbox, label, () => prepareCli(sandbox), pattern);
      if (!started) assert.equal(existsSync(join(sandbox.repo, RECEIPT)), false, `${label}: no receipt`);
    });
  }
}));

test('approval: an absent, declared, mismatched, or stale approval never unlocks bootstrap or init; a new approval does', () => {
  withSandbox('approval-gate', (sandbox) => {
    const { repo, env } = sandbox;
    git(sandbox, ['init', '-q', '-b', 'main']);
    startInceptionRun(repo, { runId: RUN, env });
    put(repo, PROJECT, PROJECT_TEXT);
    updateInceptionState(repo, { expectedSha256: descriptorSha(sandbox), changes: { phase: 'approval' } });

    assertRefusedWithoutWrites(sandbox, 'no approval', () => updateCli(sandbox, { phase: 'bootstrap' }),
      /phase bootstrap requires an approval reference/u);
    put(repo, APPROVAL, json({ 'inception-approval': 'steepy-apex/v1', 'run-id': RUN, project: [bind(sandbox, PROJECT)] }));
    assertRefusedWithoutWrites(sandbox, 'an unbound approval file', () => updateCli(sandbox, { phase: 'bootstrap' }),
      /phase bootstrap requires an approval reference/u);
    assertRefusedWithoutWrites(sandbox, 'a digest of other bytes', () => updateCli(sandbox, {
      approval: { path: APPROVAL, sha256: '0'.repeat(64) }, phase: 'bootstrap',
    }), /approval reference digest does not match/u);
    assertRefusedWithoutWrites(sandbox, 'another run approval', () => updateCli(sandbox, {
      approval: { path: runFile('approval.json', OTHER_RUN), sha256: '0'.repeat(64) }, phase: 'bootstrap',
    }), /approval\.path must be an exact file of run/u);
  });

  // The approved project changes after approval: the old approval no longer
  // binds its bytes, init cannot start on it, and it cannot be edited in place.
  withSandbox('approval-stale', (sandbox) => {
    const { repo } = sandbox;
    buildReadyRun(sandbox);
    put(repo, PROJECT, `${PROJECT_TEXT}- Substantial change: a second database.\n`);
    assertRefusedWithoutWrites(sandbox, 'stale approval', () => prepareCli(sandbox),
      /differs from its approved bytes; a substantial change needs a new approval/u);
    const original = readFileSync(join(repo, APPROVAL));
    put(repo, APPROVAL, json({ ...JSON.parse(original), project: [bind(sandbox, PROJECT)] }));
    assertRefusedWithoutWrites(sandbox, 'an approval edited after binding', () => updateCli(sandbox, { status: 'blocked' }),
      /approval reference digest does not match/u);
    assertRefusedWithoutWrites(sandbox, 'an approval edited after binding (transfer)', () => prepareCli(sandbox),
      /approval refers to other bytes/u);

    // A new decision is a new approval record at a new path and a new handoff.
    writeFileSync(join(repo, APPROVAL), original);
    const approval2 = runFile('approval-2.json');
    const handoff2 = runFile('init-handoff-2.json');
    put(repo, approval2, json({ 'inception-approval': 'steepy-apex/v1', 'run-id': RUN, project: [bind(sandbox, PROJECT)] }));
    const rebound = inceptionState(sandbox, ['update', '--expected-sha256', descriptorSha(sandbox),
      '--set', JSON.stringify({ approval: bind(sandbox, approval2) })], [GUARD, STATE, approval2, CHECKPOINT]);
    assert.equal(rebound.status, 0, rebound.stderr);
    put(repo, handoff2, json(handoffValue({ required: { ...handoffValue().required, approval: approval2 } })));
    const started = inceptionHandoff(sandbox, ['prepare', '--handoff', handoff2, '--receipt', RECEIPT],
      [...TRANSFER.filter((path) => path !== APPROVAL && path !== HANDOFF), approval2, handoff2, RECEIPT]);
    assert.equal(started.status, 0, started.stderr);
    assert.equal(JSON.parse(started.stdout).status, 'in-progress');
  });
});

test('the local area is ignored from its creation, and a later Git initialization honors the same guard', () => withSandbox('nogit', (sandbox) => {
  const started = inceptionState(sandbox, ['start', '--run-id', RUN]);
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(JSON.parse(started.stdout).git, { state: 'not-repository' });
  put(sandbox.repo, PROJECT, PROJECT_TEXT);
  git(sandbox, ['init', '-q', '-b', 'main']);
  for (const path of [STATE, GUARD, PROJECT]) {
    const ignored = spawnSync('git', ['check-ignore', '-q', path], { cwd: sandbox.repo, env: sandbox.env });
    assert.equal(ignored.status, 0, `${path} is ignored by the local guard`);
  }
  assert.equal(git(sandbox, ['ls-files', '--others', '--exclude-standard']), '');
  const inspected = inceptionState(sandbox, ['inspect']);
  assert.equal(JSON.parse(inspected.stdout).git.state, 'ignored');
}));

// ===========================================================================
// Interruption and resume: each durable step, then a resume from the exact
// inputs, converges to the uninterrupted bytes without rewriting what already
// matches.
// The linter's view right after each durable step: a started init without its
// index is an error, a partial hub reports its gaps, and only a complete one is green.
const LINTER_AFTER = {
  prepare: 'invalid',
  apply: 'invalid',
  'write .apex/_INDEX.md': 'hub-with-errors',
  'write .apex/conventions.md': 'hub-with-errors',
  'write .apex/glossary.md': 'hub-with-errors',
  'write .apex/testing-and-checklist.md': 'hub-with-errors',
  'write .apex/standards/app.md': 'hub-with-errors',
  'write .apex/project-context.md': 'hub-with-errors',
  'write .apex/project-architecture.md': 'hub',
  'write .apex/work/.gitignore': 'hub',
  finalize: 'hub',
};

function linterState(repo) {
  const classified = classifyHub(repo);
  if (classified.state !== 'hub') return classified.state;
  return errorsOf(classified.violations).length === 0 ? 'hub' : 'hub-with-errors';
}

test('resume from every interruption point converges to the uninterrupted bytes and rewrites nothing already written', () => withReadyRuns('resume', (readyCase) => {
  const reference = readyCase('resume-reference', (sandbox) => {
    const done = runInitEntry(sandbox);
    assert.equal(done.outcome, 'complete');
    assert.deepEqual(done.trace, INIT_STEPS);
    return bytesOnly(treeSnapshot(sandbox.repo));
  });
  assert.deepEqual(Object.keys(LINTER_AFTER), INIT_STEPS.slice(0, -1), 'every durable step has an expected linter state');

  const points = [
    { label: 'before init', stopAfter: null, linter: 'pre-hub' },
    ...Object.entries(LINTER_AFTER).map(([step, linter]) => ({ label: `after ${step}`, stopAfter: step, linter })),
    { label: 'prepare durable receipt', crash: 'prepare', interruptAfter: 1, linter: 'pre-hub' },
    { label: 'prepare durable state', crash: 'prepare', interruptAfter: 2, linter: 'invalid' },
    ...[1, 2, 3].map((interruptAfter) => ({ label: `finalize durable write ${interruptAfter}`,
      crash: 'finalize', stopAfter: 'write .apex/work/.gitignore', interruptAfter, linter: 'hub' })),
  ];
  for (const { label, stopAfter, crash, interruptAfter, linter } of points) {
    readyCase('resume', (sandbox) => {
      if (stopAfter) {
        const interrupted = runInitEntry(sandbox, { stopAfter });
        assert.equal(interrupted.outcome, 'stopped', label);
      }
      if (crash) {
        const args = crash === 'prepare' ? ['--receipt', RECEIPT] : ['--gate', 'pass'];
        const result = runCli(sandbox, 'inception-handoff.mjs', [crash, '--root', sandbox.repo,
          '--handoff', HANDOFF, ...args], { allowLocal: [...TRANSFER, RECEIPT], interruptAfter });
        assert.equal(result.status, 86, `${label}: ${result.stderr}`);
        assert.equal(result.stdout, '', 'the child exits at the durable boundary before a success response');
        if (crash === 'finalize') {
          const state = inspectInceptionState(sandbox.repo).descriptor;
          const receipt = JSON.parse(readFileSync(join(sandbox.repo, RECEIPT), 'utf8'));
          assert.equal(state.init.status, interruptAfter < 3 ? 'in-progress' : 'complete');
          assert.equal(receipt.status, interruptAfter === 1 ? 'in-progress' : 'complete');
          assert.equal(Object.hasOwn(state.init, 'finalization'), interruptAfter < 3);
          if (interruptAfter === 2) assert.deepEqual(state.init.finalization, bind(sandbox, RECEIPT));
          if (interruptAfter < 3) {
            const before = treeSnapshot(sandbox.repo);
            const refused = prepareCli(sandbox);
            assert.equal(refused.status, 1);
            assert.match(refused.stderr, /finalization.*finalize/u);
            assert.deepEqual(treeSnapshot(sandbox.repo), before);
          }
        }
      }
      assert.equal(linterState(sandbox.repo), linter, label);

      ageTree(sandbox.repo);
      const interruptedSnapshot = treeSnapshot(sandbox.repo);
      const resumed = runInitEntry(sandbox);
      assert.equal(resumed.outcome, 'complete', label);
      if (resumed.preview && INIT_STEPS.indexOf(stopAfter) >= INIT_STEPS.indexOf('apply')) {
        assert.deepEqual(resumed.preview, [], `${label}: the planner has nothing left to do`);
      }
      const final = treeSnapshot(sandbox.repo);
      if (crash) {
        const repeated = inceptionHandoff(sandbox, ['finalize', '--handoff', HANDOFF, '--gate', 'pass'], [...TRANSFER, RECEIPT]);
        assert.equal(repeated.status, 0, repeated.stderr);
        assert.deepEqual(JSON.parse(repeated.stdout).changed, { state: false, receipt: false });
        assert.deepEqual(treeSnapshot(sandbox.repo), final, `${label}: second completion preserves exact bytes, modes and mtimes`);
      }
      assert.deepEqual(bytesOnly(final), reference, `${label}: resume converges to the uninterrupted bytes`);
      const finalByName = new Map(final.map((entry) => [entry[0], entry]));
      for (const entry of interruptedSnapshot.filter(([, kind]) => kind === 'file')) {
        const after = finalByName.get(entry[0]);
        if (after && after[4] === entry[4]) {
          assert.equal(after[3], entry[3], `${label}: ${entry[0]} already matched and was not rewritten`);
        }
      }
    });
  }
}));

test('resume preserves human edits: a changed destination keeps its text, a customized root is a conflict, a later edit refuses finalize', () => withReadyRuns('human', (readyCase) => {
  // A human writes a destination while init is in progress: init appends only.
  readyCase('human-destination', (sandbox) => {
    runInitEntry(sandbox, { stopAfter: 'prepare' });
    const human = '# Glossary\n\nA human note written during init.\n';
    put(sandbox.repo, '.apex/glossary.md', human);
    const resumed = runInitEntry(sandbox);
    assert.equal(resumed.outcome, 'complete');
    // The resume signal init acts on: the destination changed against the
    // bytes prepared before any hub write, never a re-baselined previous.
    assert.deepEqual(resumed.prepared.changed, { state: false, receipt: false });
    assert.deepEqual(resumed.prepared.destinations.find(({ path }) => path === '.apex/glossary.md'),
      { path: '.apex/glossary.md', previous: null, observed: sha(human), state: 'changed' });
    assert.deepEqual(resumed.writes.find(([path]) => path === '.apex/glossary.md'), ['.apex/glossary.md', 'appended']);
    const glossary = readFileSync(join(sandbox.repo, '.apex/glossary.md'), 'utf8');
    assert.ok(glossary.startsWith(human), 'the human bytes are kept verbatim');
    assert.ok(glossary.includes(DECISIONS[2].content));
    const receipt = JSON.parse(readFileSync(join(sandbox.repo, RECEIPT), 'utf8'));
    assert.deepEqual(receipt.writes.find(({ path }) => path === '.apex/glossary.md'),
      { path: '.apex/glossary.md', previous: null, observed: sha(glossary) });
  });

  // A human customizes the generated root instructions after apply: the
  // planner reports a conflict and the aborted entry writes nothing.
  readyCase('human-root', (sandbox) => {
    runInitEntry(sandbox, { stopAfter: 'apply' });
    const agents = join(sandbox.repo, 'AGENTS.md');
    writeFileSync(agents, readFileSync(agents, 'utf8').replace('## Development commands', '## Development commands (human edit)'));
    ageTree(sandbox.repo);
    const before = treeSnapshot(sandbox.repo);
    const aborted = runInitEntry(sandbox);
    assert.equal(aborted.outcome, 'aborted');
    assert.deepEqual(aborted.conflicts.map(({ id, choices }) => [id, choices]),
      [['v1:project-instructions:customized', ['replace', 'abort']]]);
    assert.deepEqual(treeSnapshot(sandbox.repo), before, 'an aborted conflict writes nothing');
    assert.equal(inspectInceptionState(sandbox.repo).state, 'init-in-progress', 'the run stays resumable');
  });

  // After completion, a human edit that drops promoted text refuses a repeated
  // finalize without rewriting either side.
  readyCase('human-after', (sandbox) => {
    assert.equal(runInitEntry(sandbox).outcome, 'complete');
    put(sandbox.repo, '.apex/conventions.md', '# Conventions\n\nRewritten by a human.\n');
    ageTree(sandbox.repo);
    const before = treeSnapshot(sandbox.repo);
    assert.throws(() => finalizeInitReceipt(sandbox.repo, { handoff: HANDOFF, gate: 'pass', env: sandbox.env }),
      /decision 'D6-errors' is not realized/u);
    assert.equal(runInitEntry(sandbox).outcome, 'complete', 'a completed transfer is never replayed');
    assert.deepEqual(treeSnapshot(sandbox.repo), before);
  });
}));

test('without Git the transfer still yields a hub that stands alone when both local areas are left out', () => withSandbox('nogit-copy', (sandbox) => {
  buildReadyRun(sandbox, { withGit: false });
  assert.equal(JSON.parse(readFileSync(join(sandbox.repo, CHECKPOINT), 'utf8')).git, null);
  assert.equal(runInitEntry(sandbox, { withGit: false }).outcome, 'complete');
  const copy = versionedCopy(sandbox, { withGit: false });
  assert.ok(copy.files.every((file) => !LOCAL_AREA.test(file)));
  const copyGate = runCli(sandbox, 'validate-hub.mjs', [copy.target]);
  assert.equal(copyGate.status, 0, copyGate.stderr);
  assert.match(copyGate.stdout, /OK — doc graph is coherent/u);
}));

// ===========================================================================
// Ordinary init, repair, and new-surface keep their contracts beside the local
// areas, through the public CLIs, reading none of their bodies.
test('ordinary init, repair, and new-surface keep no-ops and data beside both local areas and read none of their bodies', () => withReadyRuns('ordinary', (readyCase) => {
  // The user chooses an ordinary init while a pre-hub run exists: the run
  // stays untouched and the hub is coherent beside it.
  readyCase('ordinary', (sandbox) => {
    const { repo, outside } = sandbox;
    put(repo, '.apex/work/specs/draft.md', `# ${LOCAL_SENTINEL}\n`);
    ageTree(repo);
    // init creates `.apex/work/.gitignore`; the pre-existing local bytes stay.
    const local = () => treeSnapshot(join(repo, '.apex'))
      .filter(([name]) => /^inception(\/|$)/u.test(name) || name === 'work/specs/draft.md');
    const localBefore = local();
    const ordinary = { ...record(), description: 'SYNTHETIC ordinary-init record, confirmed by interview.' };
    const model = join(outside, 'ordinary-model.json');
    writeFileSync(model, json({ ...projectConfirmedInputs(ordinary), resolutions: { [STARTER_CONFLICT]: 'replace' } }));
    const applied = runCli(sandbox, 'project-scaffold.mjs', ['--hub', repo, '--model', model, '--apply']);
    assert.equal(applied.status, 0, applied.stderr);
    for (const document of hubDocuments(ordinary, { withProjectDocs: false })) writeHubDocument(repo, document, []);
    const linted = runCli(sandbox, 'validate-hub.mjs', [repo]);
    assert.equal(linted.status, 0, linted.stderr);
    assert.match(linted.stdout, /OK — doc graph is coherent/u);
    assert.equal(JSON.parse(inceptionState(sandbox, ['inspect']).stdout).state, 'pre-hub', 'the leftover run is only reported');
    assert.deepEqual(local(), localBefore, 'ordinary init leaves both local areas byte-, mode-, and mtime-identical');
  });

  // Repair and new-surface on a hub produced by the transfer.
  readyCase('repair', (sandbox) => {
    const { repo, outside } = sandbox;
    assert.equal(runInitEntry(sandbox).outcome, 'complete');
    put(repo, '.apex/work/specs/draft.md', `# ${LOCAL_SENTINEL}\n`);
    put(repo, runFile('decoy/SKILL.md'), `<!-- steepy:generated:app-agent-claude:v1 -->\n${LOCAL_SENTINEL}\n`);
    ageTree(repo);
    const local = () => treeSnapshot(join(repo, '.apex')).filter(([name]) => /^(inception|work)(\/|$)/u.test(name));
    const localBefore = local();
    const model = join(outside, 'model.json');
    writeFileSync(model, json(projectConfirmedInputs(record())));

    ageTree(repo);
    let settled = treeSnapshot(repo);
    const repaired = runCli(sandbox, 'project-scaffold.mjs', ['--hub', repo, '--model', model, '--apply']);
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.deepEqual(JSON.parse(repaired.stdout.trim().split('\n').at(-1)).result, { applied: 0, paths: [] });
    assert.deepEqual(treeSnapshot(repo), settled, 'a repeated ordinary init is an exact no-op');

    mkdirSync(join(repo, 'src', 'api'));
    const surface = ['--name', 'api', '--path', 'src/api', '--agent', 'api-agent', '--test', 'npm test', '--hub', repo];
    settled = treeSnapshot(repo);
    const unresolved = runCli(sandbox, 'new-surface.mjs', surface);
    assert.equal(unresolved.status, 1, 'the changed surface list is a conflict question first');
    assert.match(unresolved.stderr, /v1:project-instructions:customized.*replace.*abort/u);
    assert.deepEqual(treeSnapshot(repo), settled, 'the unresolved addition writes nothing');
    const added = runCli(sandbox, 'new-surface.mjs', [...surface, '--resolution', 'v1:project-instructions:customized=replace']);
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /active-v1 root instructions and routing are coherent/u);
    const linted = runCli(sandbox, 'validate-hub.mjs', [repo]);
    assert.equal(linted.status, 0, linted.stderr);
    assert.match(readFileSync(join(repo, '.apex', '_INDEX.md'), 'utf8'), /\| `api` \|/u);
    for (const decision of DECISIONS.filter(({ outcome }) => outcome === 'promote')) {
      assert.ok(readFileSync(join(repo, decision.destination), 'utf8').includes(decision.content), `${decision.id} survives`);
    }

    ageTree(repo);
    settled = treeSnapshot(repo);
    const repairedSurface = runCli(sandbox, 'new-surface.mjs', [...surface, '--repair']);
    assert.equal(repairedSurface.status, 0, repairedSurface.stderr);
    assert.deepEqual(treeSnapshot(repo), settled, 'a repeated new-surface repair is an exact no-op');
    assert.deepEqual(runCli(sandbox, 'stop-hook.mjs', [repo], { input: '{}' }), { status: 0, stdout: '', stderr: '' });
    assert.deepEqual(local(), localBefore, 'neither local area changed');
  });
}));


for (const interruptAfter of [1, 2]) {
  for (const changePrevious of [false, true]) {
    test(`pending finalization refuses forged destination and receipt at durable write ${interruptAfter}, previous changed ${changePrevious}`, () => withReadyRuns('forged-intent', (readyCase) => {
      readyCase('forged-intent', (sandbox) => {
        runInitEntry(sandbox, { stopAfter: 'write .apex/work/.gitignore' });
        const stopped = runCli(sandbox, 'inception-handoff.mjs', ['finalize', '--root', sandbox.repo,
          '--handoff', HANDOFF, '--gate', 'pass'], { allowLocal: [...TRANSFER, RECEIPT], interruptAfter });
        assert.equal(stopped.status, 86, stopped.stderr);
        const state = inspectInceptionState(sandbox.repo).descriptor;
        assert.ok(state.init.finalization, 'the digest is committed before receipt publication');
        const value = JSON.parse(readFileSync(join(sandbox.repo, RECEIPT), 'utf8'));
        const destination = value.writes[0].path;
        appendFileSync(join(sandbox.repo, destination), '\nFORGED ADDITION\n');
        if (interruptAfter === 2) value.writes[0].observed = bind(sandbox, destination).sha256;
        if (changePrevious) value.writes[0].previous = sha('forged previous');
        if (interruptAfter === 2 || changePrevious) put(sandbox.repo, RECEIPT, json(value));
        ageTree(sandbox.repo);
        const before = treeSnapshot(sandbox.repo);
        const refused = inceptionHandoff(sandbox, ['finalize', '--handoff', HANDOFF, '--gate', 'pass'], [...TRANSFER, RECEIPT]);
        assert.equal(refused.status, 1, refused.stderr);
        assert.match(refused.stderr, /bound receipt bytes changed|finalization intent/u);
        assert.deepEqual(treeSnapshot(sandbox.repo), before, 'refusal preserves all bytes, modes and mtimes');
      });
    }));
  }
}


for (const absolute of [false, true]) for (const present of [false, true]) {
  test(`mounted checkpoint collision refuses prepare with zero writes or unlisted reads (${absolute ? 'absolute' : 'relative'}, ${present ? 'present' : 'absent'})`, () => withSandbox('mount-overlap', (sandbox) => {
    buildReadyRun(sandbox, { withGit: false });
    const { repo, env } = sandbox;
    const hub = join(repo, 'hub');
    renameSync(join(repo, '.apex'), hub);
    symlinkSync(absolute ? hub : 'hub', join(repo, '.apex'), 'dir');
    if (present) put(repo, 'hub/standards/app.md', '# Existing user standard\n');
    const checkpoint = runFile('mounted-checkpoint.json');
    writeCodeCheckpoint(repo, { runId: RUN, output: checkpoint, paths: [...CODE_PATHS, 'hub/standards/app.md'], env });
    updateInceptionState(repo, { expectedSha256: descriptorSha(sandbox), changes: { checkpoint: bind(sandbox, checkpoint) } });
    const handoff = handoffValue();
    handoff.required.verification = [checkpoint, VERIFICATION];
    put(repo, HANDOFF, json(handoff));
    ageTree(hub);
    const before = treeSnapshot(hub);
    const allowed = new Set([...TRANSFER.filter((path) => path !== CHECKPOINT), checkpoint]
      .map((path) => realpathSync.native(join(repo, path))));
    const { error, accesses } = recordAccess(() => prepareInitReceipt(repo, { handoff: HANDOFF, receipt: RECEIPT, env }));
    assert.equal(error?.code, 'INCEPTION_HANDOFF_BINDING');
    assert.match(error.message, /checkpoint inventory/u);
    assert.deepEqual(accesses.filter(([kind]) => kind === 'write' || kind === 'list'), [], 'no write or enumeration attempts');
    assert.deepEqual(accesses.filter(([kind, path]) => kind === 'read' && !allowed.has(path)), [],
      'only the explicitly bound transfer inputs are read; no checkpoint, promotion, or unnamed local body is opened');
    assert.deepEqual(treeSnapshot(hub), before, 'all local and stable bytes, modes, and mtimes survive refusal');
    assert.equal(existsSync(join(repo, RECEIPT)), false);
  }));
}

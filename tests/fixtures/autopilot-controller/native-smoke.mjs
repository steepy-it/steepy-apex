#!/usr/bin/env node
// Opt-in native smoke for Gear-3 controller protocol 2. It is never imported or
// run by `npm test`: it refuses without --execute and under an npm test
// lifecycle, and it uses the caller's real environment (provider credentials and
// profiles) only when explicitly executed.
//
//   node tests/fixtures/autopilot-controller/native-smoke.mjs --execute \
//     --engine-root <frozen candidate payload> --evidence <absent or empty dir> \
//     [--harness codex|claude|opencode] [--timeout-ms <ms>] [--keep-repo]
//
// It digests the candidate payload before and after the run (any change is a
// FAIL), records the harness CLI version, creates a sacrificial Git repository
// with a minimal coherent hub and a one-task spec, runs the candidate's own
// `scripts/autopilot.mjs --controller-protocol 2` there, and copies the
// controller's journal, reservations, response records, manifests, and readable
// logs into the evidence directory. The summary binds the candidate payload
// digest and runtime fingerprint, the applied descriptors and their recorded
// model selection, and the events the run actually produced. Raw captures are
// recorded by digest and size only. A PASS here is a native observation of this
// candidate and harness on this host, nothing more.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const USAGE = 'usage: node tests/fixtures/autopilot-controller/native-smoke.mjs --execute --engine-root <frozen payload> --evidence <absent or empty dir> [--harness codex|claude|opencode] [--timeout-ms <ms>] [--keep-repo]';
const HARNESSES = ['codex', 'claude', 'opencode'];
const SPEC_NAME = 'native-smoke';
const BRANCH = 'gear3-native-smoke';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inside = (child, parent) => child === parent || child.startsWith(`${parent}${sep}`);

function refuse(message, code = 2) {
  console.error(`native-smoke: ${message}`);
  console.error(USAGE);
  return code;
}

// Every ordinary file of the payload by path, mode, and bytes, in sorted order.
function payloadDigest(root) {
  const entries = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git' || name === 'node_modules') continue;
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) entries.push(`${relative(root, path).split(sep).join('/')}\0${(stat.mode & 0o777).toString(8)}\0${sha(readFileSync(path))}`);
      else throw new Error(`the frozen payload must hold only ordinary files and directories: ${relative(root, path)}`);
    }
  };
  walk(root);
  return { digest: sha(`steepy-native-smoke-payload\n${entries.join('\n')}\n`), files: entries.length };
}

function evidenceDirectory(path, engineRoot) {
  const absolute = resolve(path);
  if (existsSync(absolute)) {
    if (!lstatSync(absolute).isDirectory() || readdirSync(absolute).length > 0) throw new Error(`evidence directory must be absent or empty: ${absolute}`);
  }
  mkdirSync(absolute, { recursive: true });
  const real = realpathSync(absolute);
  if (inside(real, engineRoot)) throw new Error('evidence directory must be outside the engine root');
  return real;
}

function git(repo, ...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function put(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

// A minimal coherent hub and one small native task: greet() gains punctuation.
function sacrificialRepository(harness) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'steepy-native-smoke-')));
  git(repo, 'init', '-q', '-b', BRANCH);
  git(repo, 'config', 'user.email', 'native-smoke@example.invalid');
  git(repo, 'config', 'user.name', 'Steepy native smoke');
  put(repo, '.gitignore', '.apex/work/\n');
  put(repo, 'package.json', `${JSON.stringify({ name: 'steepy-native-smoke', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`);
  put(repo, 'src/greeting.mjs', 'export function greet(name) {\n  return `Hello ${name}`;\n}\n');
  put(repo, 'tests/greeting.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../src/greeting.mjs';\n\ntest('greets by name', () => {\n  assert.equal(greet('Ada'), 'Hello Ada');\n});\n");
  put(repo, '.apex/_INDEX.md', '# Native smoke hub\n\n- [Conventions](conventions.md)\n- [Testing & Checklist](testing-and-checklist.md)\n\n| Surface | Min docs | Specialist agent | Applicable skill |\n|---|---|---|---|\n| `src` | [standards/src.md](standards/src.md) | `src-agent` | — |\n');
  put(repo, '.apex/standards/src.md', '# src — Technical Standard\n\n> Owning surface: `src`.\n\n## Conventions\n- ESM, Node built-ins only; tests live in `tests/` and run with the built-in runner.\n\n## Testing\n\n```sh\nnpm test\n```\n');
  put(repo, '.apex/testing-and-checklist.md', '# Testing & Checklist\n\n- `src`: `npm test`\n');
  put(repo, '.apex/conventions.md', '# Conventions\n\n- Keep changes minimal and covered by a test.\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'native smoke baseline');
  put(repo, `.apex/work/specs/${SPEC_NAME}.md`, `<!-- verdict: GAP | gear: 3
drive: autopilot
branch: ${BRANCH}
commit-auth: per-task
harness: ${harness}
blast-radius: branch-only, no-push, stop-before-PR
-->

# Native smoke: punctuated greeting

- **Owning surface:** \`src\`
- **Feature complexity:** \`mechanical\`

\`greet(name)\` in \`src/greeting.mjs\` must return \`Hello, <name>!\` (for example \`Hello, Ada!\`).
Update \`tests/greeting.test.mjs\` first so it fails, then the implementation.

## Success criteria

1. SC1 — \`greet('Ada')\` returns \`Hello, Ada!\` and \`npm test\` passes.
`);
  return repo;
}

function runConductor(engineRoot, repo, timeoutMs, evidence) {
  const args = [join(engineRoot, 'scripts', 'autopilot.mjs'), `.apex/work/specs/${SPEC_NAME}.md`, '--controller-protocol', '2'];
  const started = Date.now();
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, { cwd: repo, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => { out.push(chunk); process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { err.push(chunk); process.stderr.write(chunk); });
    let timedOut = false;
    let kill = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      kill = setTimeout(() => child.kill('SIGKILL'), 30_000);
    }, timeoutMs);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      if (kill !== null) clearTimeout(kill);
      writeFileSync(join(evidence, 'conductor.stdout.log'), Buffer.concat(out));
      writeFileSync(join(evidence, 'conductor.stderr.log'), Buffer.concat(err));
      resolveRun({ args: args.slice(1), status, signal, timedOut, durationMs: Date.now() - started });
    });
  });
}

// Controller-owned artifacts only, by their exact role-numbered names.
function collect(repo, evidence) {
  const dir = join(repo, '.apex', 'work', 'tasks', SPEC_NAME);
  const copy = (name) => {
    const source = join(dir, name);
    if (!existsSync(source)) return false;
    put(join(evidence, 'run'), name, readFileSync(source));
    return true;
  };
  for (const name of ['autopilot-run.json', 'autopilot-events.jsonl', 'autopilot-status.md']) copy(name);
  const events = existsSync(join(dir, 'autopilot-events.jsonl'))
    ? readFileSync(join(dir, 'autopilot-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  const roles = events.filter(({ event }) => event === 'ROLE_RESERVED' || event === 'REPAIR_RESERVED').map((reservation) => {
    const n = reservation.roleSequence;
    for (const name of [`role-${n}-reservation.json`, `role-${n}-response.json`, `role-${n}-receipt.json`, `role-${n}.log`, `context/role-${n}.json`]) copy(name);
    const raw = join(dir, `role-${n}.raw.jsonl`);
    const response = existsSync(join(dir, `role-${n}-response.json`)) ? JSON.parse(readFileSync(join(dir, `role-${n}-response.json`), 'utf8')) : null;
    return {
      roleSequence: n, role: reservation.role, scope: reservation.scope,
      requestedModel: reservation.requestedModel, descriptorModel: reservation.descriptorModel, degradationReason: reservation.degradationReason,
      captured: response !== null, terminalReason: response?.terminalReason ?? null, exit: response?.exit ?? null,
      observedModel: response?.observedModel ?? null,
      accepted: events.some((event) => event.event === 'RESULT_ACCEPTED' && event.roleSequence === n),
      raw: existsSync(raw) ? { sha256: sha(readFileSync(raw)), bytes: readFileSync(raw).length } : null,
    };
  });
  return { events, roles };
}

export async function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
      execute: { type: 'boolean' }, 'engine-root': { type: 'string' }, evidence: { type: 'string' },
      harness: { type: 'string' }, 'timeout-ms': { type: 'string' }, 'keep-repo': { type: 'boolean' },
    } }));
  } catch (error) { return refuse(error.message); }
  if (!values.execute) return refuse("refusing to run without the explicit '--execute' option; this driver invokes a real provider");
  if (process.env.npm_lifecycle_event === 'test') return refuse('refusing to run inside an npm test lifecycle');
  if (!values['engine-root'] || !values.evidence) return refuse('--engine-root and --evidence are required');
  const harness = values.harness ?? 'codex';
  if (!HARNESSES.includes(harness)) return refuse(`--harness must be one of ${HARNESSES.join(', ')}`);
  const timeoutMs = values['timeout-ms'] === undefined ? 60 * 60 * 1000 : Number(values['timeout-ms']);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) return refuse('--timeout-ms must be an integer of at least 1000');

  let engineRoot;
  let evidence;
  try {
    engineRoot = realpathSync(resolve(values['engine-root']));
    for (const path of ['scripts/autopilot.mjs', 'scripts/autopilot-runtime.mjs', 'adapters/headless.mjs']) {
      if (!existsSync(join(engineRoot, path))) throw new Error(`engine root is not a steepy-apex payload: missing ${path}`);
    }
    evidence = evidenceDirectory(values.evidence, engineRoot);
  } catch (error) { return refuse(error.message, 1); }

  const summary = { schemaVersion: 1, kind: 'controller-protocol-2-native-smoke', observation: 'native', executedAt: new Date().toISOString(),
    harness, node: process.version, platform: `${process.platform}-${process.arch}` };
  const finish = (result, reason = null) => {
    Object.assign(summary, { result, reason });
    writeFileSync(join(evidence, 'native-smoke.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`native-smoke: ${result}${reason ? ` — ${reason}` : ''}; evidence: ${evidence}`);
    return result === 'PASS' ? 0 : 1;
  };

  const before = payloadDigest(engineRoot);
  const { fingerprintAutopilotRuntime } = await import(pathToFileURL(join(engineRoot, 'scripts', 'autopilot-runtime.mjs')).href);
  const { headlessCommand } = await import(pathToFileURL(join(engineRoot, 'adapters', 'headless.mjs')).href);
  const runtime = fingerprintAutopilotRuntime(engineRoot);
  const pkg = JSON.parse(readFileSync(join(engineRoot, 'package.json'), 'utf8'));
  summary.engine = { root: engineRoot, version: pkg.version, payloadDigest: before.digest, payloadFiles: before.files, runtimeFingerprint: runtime.fingerprint };
  // The descriptor shape for every tier, with the prompt elided.
  summary.descriptors = Object.fromEntries(['cheap', 'standard', 'most-capable'].map((modelTier) => {
    const descriptor = headlessCommand(harness, '<prompt>', { displayName: 'steepy-native-smoke', modelTier });
    return [modelTier, { cmd: descriptor.cmd, args: descriptor.args, modelSelection: descriptor.modelSelection ?? null,
      resolvedModel: descriptor.resolvedModel ?? null, degradationReason: descriptor.degradationReason ?? null, capabilities: descriptor.capabilities }];
  }));
  // The resolved binary is recorded beside its version, so a substituted harness is visible.
  const located = spawnSync('sh', ['-c', 'command -v "$0"', harness], { encoding: 'utf8', timeout: 30_000 });
  const version = spawnSync(harness, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  summary.harnessVersion = { path: located.status === 0 ? located.stdout.trim() : null, status: version.status,
    stdout: (version.stdout ?? '').trim(), stderr: (version.stderr ?? '').trim(), error: version.error?.message ?? null };
  if (version.error || version.status !== 0) return finish('NOT RUN', `harness "${harness}" is unavailable: ${version.error?.message ?? `--version exited ${version.status}`}`);

  const repo = sacrificialRepository(harness);
  let failure = null;
  try {
    const hub = spawnSync(process.execPath, [join(engineRoot, 'scripts', 'validate-hub.mjs'), '.'], { cwd: repo, encoding: 'utf8' });
    summary.hubCheck = { status: hub.status, stdout: hub.stdout.trim() };
    if (hub.status !== 0) failure = 'the sacrificial hub is not coherent before the run';
    else {
      const baseline = git(repo, 'rev-parse', 'HEAD').trim();
      summary.conductor = await runConductor(engineRoot, repo, timeoutMs, evidence);
      const { events, roles } = collect(repo, evidence);
      const head = git(repo, 'rev-parse', 'HEAD').trim();
      writeFileSync(join(evidence, 'repository.diff'), git(repo, 'diff', '--no-color', baseline, 'HEAD'));
      summary.repository = { path: values['keep-repo'] ? repo : null, branch: BRANCH, baseline, head,
        commits: git(repo, 'log', '--format=%s', `${baseline}..HEAD`).split('\n').filter(Boolean) };
      const started = events.find(({ event }) => event === 'RUN_STARTED') ?? null;
      summary.run = {
        events: events.map(({ sequence, event, roleSequence = null, scope = null }) => ({ sequence, event, roleSequence, scope })),
        status: events.at(-1)?.event ?? null, reason: events.at(-1)?.reason ?? null,
        boundFingerprint: started?.runtimeFingerprint ?? null, fingerprintBound: started?.runtimeFingerprint === runtime.fingerprint,
      };
      summary.roles = roles;
    }
  } finally {
    const after = payloadDigest(engineRoot);
    summary.engine.payloadDigestAfter = after.digest;
    summary.engine.immutable = after.digest === before.digest;
    if (!values['keep-repo']) rmSync(repo, { recursive: true, force: true });
  }
  if (!summary.engine.immutable) return finish('FAIL', 'the candidate payload changed during the run');
  if (failure !== null) return finish('FAIL', failure);
  if (!summary.run.fingerprintBound) return finish('FAIL', 'the run did not bind the candidate runtime fingerprint');
  if (summary.run.status !== 'RUN_COMPLETED') return finish('FAIL', `the controller run ended with ${summary.run.status ?? 'no journal'}`);
  return finish('PASS');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

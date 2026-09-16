import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  appendFileSync,
  constants as FS_CONSTANTS,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { headlessCommand } from '../adapters/headless.mjs';
import { applyProjectScaffold, planProjectScaffold } from './project-scaffold.mjs';

const HARNESSES = Object.freeze(['claude', 'codex', 'opencode', 'pi', 'deepseek']);
const RUNNABLE_HARNESSES = new Set(['claude', 'codex', 'opencode']);
const CREDENTIALS = Object.freeze({
  claude: Object.freeze(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']),
  codex: Object.freeze(['OPENAI_API_KEY', 'CODEX_API_KEY']),
  opencode: Object.freeze(['OPENCODE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']),
});
const DISPLAY_NAME = 'steepy-live-scaffold-canary';
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_LOG_CHARS = 64 * 1024;
const TIMEOUT_MS = 5 * 60 * 1000;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(SCRIPT_DIR);

function usage() {
  return 'usage: node scripts/live-scaffold-canary.mjs --harness <claude|codex|opencode|pi|deepseek|all> --output <json-path>';
}

function parseCli(argv) {
  const { values, positionals, tokens } = parseArgs({
    args: argv,
    options: {
      harness: { type: 'string' },
      output: { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
    tokens: true,
  });
  if (positionals.length > 0) throw new TypeError('positionals are not accepted');
  for (const option of ['harness', 'output']) {
    const occurrences = tokens.filter((token) => token.kind === 'option' && token.name === option);
    if (occurrences.length !== 1) throw new TypeError(`--${option} must be provided exactly once`);
  }
  if (![...HARNESSES, 'all'].includes(values.harness)) {
    throw new TypeError('--harness is not a supported value');
  }
  if (typeof values.output !== 'string' || values.output.length === 0 || values.output.includes('\0')) {
    throw new TypeError('--output must be a non-empty path');
  }
  return { harness: values.harness, output: values.output };
}

function safeOutputPath(path) {
  const resolvedTarget = resolve(path);
  const tempAlias = resolve(tmpdir());
  const tempPhysical = realpathSync(tempAlias);
  const target = resolvedTarget === tempAlias || resolvedTarget.startsWith(`${tempAlias}/`)
    ? `${tempPhysical}${resolvedTarget.slice(tempAlias.length)}`
    : resolvedTarget;
  const parent = dirname(target);
  const root = parse(parent).root;
  let cursor = root;
  for (const part of parent.slice(root.length).split('/').filter(Boolean)) {
    cursor = join(cursor, part);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error('output parent must not contain a symlink');
    if (!stat.isDirectory()) throw new Error('output parent must be a directory');
  }
  if (realpathSync(parent) !== parent) throw new Error('output parent must resolve without symlinks');
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('output target must be an ordinary file when it exists');
    }
  }
  return target;
}

function secretValues(env) {
  const sensitiveName = /(api[_-]?key|authorization|cookie|credential|password|secret|token)/iu;
  return Object.entries(env)
    .filter(([name, value]) => sensitiveName.test(name) && typeof value === 'string' && value.length > 0)
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
}

function redact(value, env) {
  let text = String(value ?? '');
  for (const secret of secretValues(env)) text = text.split(secret).join('[REDACTED]');
  text = text
    .replace(/\bBearer\s+[^\s"']+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9._-]{8,}\b/gu, '[REDACTED]');
  if (text.length > MAX_LOG_CHARS) text = `${text.slice(0, MAX_LOG_CHARS)}\n[TRUNCATED]`;
  return text;
}

function firstLine(value, env) {
  return redact(value, env).split(/\r?\n/u)[0].trim();
}

function executablePath(command, env) {
  const candidates = isAbsolute(command)
    ? [command]
    : String(env.PATH ?? '').split(delimiter).filter(Boolean).map((entry) => join(entry, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, FS_CONSTANTS.X_OK);
      return candidate;
    } catch {
      // Continue through the bounded PATH candidates.
    }
  }
  return null;
}

function nonce(label) {
  return `LIVE_CANARY_${label}_${randomBytes(12).toString('hex')}`;
}

function appendNonce(root, relativePath, value) {
  appendFileSync(join(root, relativePath), `\n<!-- ${value} -->\n`, 'utf8');
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'steepy-live-scaffold-canary-'));
  const nonces = Object.freeze({
    root: nonce('ROOT'),
    bootstrap: nonce('BOOTSTRAP'),
    standard: nonce('STANDARD'),
    adapter: nonce('ADAPTER'),
  });
  const model = {
    projectName: 'live-canary',
    description: 'Temporary live scaffold canary fixture.',
    devCommands: ['node --test'],
    surfaces: [{
      name: 'canary',
      path: 'src/canary',
      agent: 'canary-agent',
      testCmd: 'node --test',
    }],
    resolutions: {},
  };
  try {
    const plan = planProjectScaffold({ hubRoot: root, model });
    applyProjectScaffold({ hubRoot: root, plan });
    mkdirSync(join(root, '.apex', 'standards'), { recursive: true });
    writeFileSync(
      join(root, '.apex', 'standards', 'canary.md'),
      `# Canary standard\n\n<!-- ${nonces.standard} -->\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    appendNonce(root, 'AGENTS.md', nonces.root);
    appendNonce(root, '.agents/skills/live-canary-bootstrap/SKILL.md', nonces.bootstrap);
    for (const adapterPath of [
      '.claude/agents/canary-agent.md',
      '.codex/agents/canary-agent.toml',
      '.opencode/agents/canary-agent.md',
    ]) appendNonce(root, adapterPath, nonces.adapter);
    return { root, nonces };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function promptFor(harness) {
  const adapterPath = {
    claude: '.claude/agents/canary-agent.md',
    codex: '.codex/agents/canary-agent.toml',
    opencode: '.opencode/agents/canary-agent.md',
  }[harness];
  return [
    'This is a disposable Steepy live-scaffold canary fixture.',
    'Read, without modifying, AGENTS.md, .agents/skills/live-canary-bootstrap/SKILL.md,',
    `.apex/standards/canary.md, and ${adapterPath}.`,
    'Reply with one compact JSON object whose lifecycle is "complete" and whose nonces array',
    'contains the discovered root, bootstrap, standard, and adapter nonce values in that order.',
  ].join(' ');
}

function productIdentity() {
  const revision = spawnSync('git', ['-C', PACKAGE_ROOT, 'rev-parse', '--verify', 'HEAD'], {
    encoding: 'utf8',
    maxBuffer: MAX_CAPTURE_BYTES,
  });
  let sourceRevision = String(revision.stdout ?? '').trim();
  if (revision.error || revision.status !== 0) {
    // Test and constrained host PATHs may intentionally expose only the harness binary.
    // A normal checkout's HEAD/ref is an equivalent local source identity fallback.
    try {
      const head = readFileSync(join(PACKAGE_ROOT, '.git', 'HEAD'), 'utf8').trim();
      const ref = /^ref: (refs\/[A-Za-z0-9._/-]+)$/u.exec(head)?.[1];
      if (ref === undefined || ref.split('/').some((part) => part === '' || part === '.' || part === '..')) {
        sourceRevision = head;
      } else {
        sourceRevision = readFileSync(join(PACKAGE_ROOT, '.git', ...ref.split('/')), 'utf8').trim();
      }
    } catch {
      // The validation below is the single diagnostic for every unavailable identity route.
    }
  }
  if (!/^[a-f0-9]{40}$/u.test(sourceRevision)) {
    throw new Error('cannot establish the checked-out source revision');
  }
  const product = spawnSync(process.execPath, [
    join(SCRIPT_DIR, 'validate-release-evidence.mjs'),
    '--root', PACKAGE_ROOT,
    '--product-only',
  ], {
    encoding: 'utf8',
    maxBuffer: MAX_CAPTURE_BYTES,
    // The canary's harness PATH may intentionally contain only a fake executable.
    // The product validator still needs the npm paired with this Node runtime.
    env: {
      ...process.env,
      PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
    },
  });
  let productState;
  try {
    productState = JSON.parse(String(product.stdout ?? ''));
  } catch {
    productState = null;
  }
  if (
    product.error || product.status !== 0 || productState?.status !== 'PASS'
    || !/^\d+\.\d+\.\d+$/u.test(productState.productVersion)
    || !/^[a-f0-9]{64}$/u.test(productState.payloadSha256)
  ) {
    throw new Error('cannot establish exact npm product identity');
  }
  const { productVersion, payloadSha256 } = productState;
  return Object.freeze({ sourceRevision, payloadSha256, productVersion });
}

function identityFor(harness, product) {
  return {
    ...product,
    installation: {
      method: 'canonical-headless-descriptor',
      composition: [`${harness}-cli`, 'scaffold-fixture'],
    },
  };
}

function unavailableRow(harness, reasonCode, identity, cli = null) {
  return {
    schemaVersion: 1,
    harness,
    cli,
    version: null,
    durationMs: 0,
    log: '',
    verdict: 'NOT RUN',
    reasonCode,
    identity,
    capabilities: [],
  };
}

function spawn(command, args, fixtureRoot, env) {
  return spawnSync(command, args, {
    cwd: fixtureRoot,
    env,
    encoding: 'utf8',
    maxBuffer: MAX_CAPTURE_BYTES,
    timeout: TIMEOUT_MS,
  });
}

function structuredLines(stdout) {
  const parsed = [];
  for (const line of String(stdout ?? '').split(/\r?\n/u).filter(Boolean)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return null;
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) return null;
    parsed.push(event);
  }
  return parsed;
}

function finalAssistantResponse(harness, stdout) {
  const events = structuredLines(stdout);
  if (events === null) return null;
  if (harness === 'claude') {
    if (events.some((event) => (
      event.type === 'result' && ['error', 'failure'].includes(event.subtype)
    ))) return null;
    const terminal = events.filter((event) => (
      event.type === 'result'
      && event.subtype === 'success'
      && event.agent_id == null
      && typeof event.result === 'string'
    ));
    return terminal.length === 1 ? terminal[0].result : null;
  }
  if (harness === 'codex') {
    if (events.some((event) => event.type === 'error' || event.type === 'turn.failed')) return null;
    const completions = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === 'turn.completed');
    if (completions.length !== 1) return null;
    const completedAt = completions[0].index;
    const messages = events.slice(0, completedAt).filter((event) => (
      event.type === 'item.completed'
      && event.item?.type === 'agent_message'
      && typeof event.item.text === 'string'
    ));
    return messages.at(-1)?.item.text ?? null;
  }
  if (harness === 'opencode') {
    if (events.some((event) => event.type === 'error')) return null;
    const completions = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === 'step_finish' && event.part?.reason === 'stop');
    if (completions.length !== 1) return null;
    const completedAt = completions[0].index;
    const messages = events.slice(0, completedAt).filter((event) => (
      event.type === 'text' && typeof event.part?.text === 'string'
    ));
    return messages.at(-1)?.part.text ?? null;
  }
  return null;
}

function verifiesFinalResponse(harness, stdout, nonces) {
  const response = finalAssistantResponse(harness, stdout);
  if (response === null) return false;
  let parsed;
  try {
    parsed = JSON.parse(response);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (Object.getPrototypeOf(parsed) !== Object.prototype) return false;
  if (Object.keys(parsed).sort().join(',') !== 'lifecycle,nonces') return false;
  if (parsed.lifecycle !== 'complete' || !Array.isArray(parsed.nonces)) return false;
  const expected = [nonces.root, nonces.bootstrap, nonces.standard, nonces.adapter];
  return parsed.nonces.length === expected.length
    && parsed.nonces.every((value, index) => value === expected[index]);
}

function runHarness(harness, fixture, env, product) {
  const identity = identityFor(harness, product);
  if (!RUNNABLE_HARNESSES.has(harness)) return unavailableRow(harness, 'runner-unavailable', identity);
  const prompt = promptFor(harness);
  const descriptor = headlessCommand(harness, prompt, { displayName: DISPLAY_NAME });
  if (descriptor === null) throw new Error(`missing canonical descriptor for ${harness}`);
  const cli = [descriptor.cmd, ...descriptor.args];
  if (!CREDENTIALS[harness].some((name) => typeof env[name] === 'string' && env[name].length > 0)) {
    return unavailableRow(harness, 'credentials-missing', identity, cli);
  }
  const binary = executablePath(descriptor.cmd, env);
  if (binary === null) return unavailableRow(harness, 'binary-missing', identity, cli);

  const versionResult = spawn(binary, ['--version'], fixture.root, env);
  const started = process.hrtime.bigint();
  const result = spawn(binary, descriptor.args, fixture.root, env);
  const durationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
  const rawLog = [result.stdout, result.stderr].filter(Boolean).join('\n');
  const log = redact(rawLog, env).trim();
  const version = firstLine(versionResult.stdout || versionResult.stderr, env);
  const verifiedFinalResponse = verifiesFinalResponse(harness, result.stdout, fixture.nonces);
  let verdict = 'PASS';
  let reasonCode = null;
  if (versionResult.error || versionResult.status !== 0 || version.length === 0) {
    verdict = 'FAIL';
    reasonCode = 'version-probe';
  } else if (result.error?.code === 'ETIMEDOUT') {
    verdict = 'FAIL';
    reasonCode = 'process-timeout';
  } else if (result.error || result.status !== 0) {
    verdict = 'FAIL';
    reasonCode = 'process-exit';
  } else if (!verifiedFinalResponse) {
    verdict = 'FAIL';
    reasonCode = 'verification-failed';
  }
  return {
    schemaVersion: 1,
    harness,
    cli,
    version,
    durationMs,
    log,
    verdict,
    reasonCode,
    identity,
    // This is intentionally a descriptor-evidence slice. It proves neither plugin
    // loading nor a specialist dispatch; Task 11 accepts only native protocol records.
    capabilities: [{
      capability: 'descriptor-nonce-response',
      result: verdict === 'PASS' ? 'PASS' : 'FAIL',
    }],
  };
}

function writeReport(path, rows) {
  const bytes = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  const tempPath = join(dirname(path), `.live-scaffold-canary-${process.pid}-${randomBytes(12).toString('hex')}.tmp`);
  try {
    writeFileSync(tempPath, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(tempPath, path);
  } finally {
    try { unlinkSync(tempPath); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export function main(argv = process.argv.slice(2), env = process.env) {
  let cli;
  try {
    cli = parseCli(argv);
  } catch (error) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  let fixture;
  try {
    const output = safeOutputPath(cli.output);
    fixture = createFixture();
    const selected = cli.harness === 'all' ? HARNESSES : [cli.harness];
    const product = productIdentity();
    const reportRows = selected.map((harness) => runHarness(harness, fixture, env, product));
    writeReport(output, reportRows);
    return reportRows.every(({ verdict }) => verdict === 'PASS') ? 0 : 1;
  } catch (error) {
    process.stderr.write(`live-scaffold-canary: ${redact(error?.message ?? error, env)}\n`);
    return 1;
  } finally {
    if (fixture !== undefined) rmSync(fixture.root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}

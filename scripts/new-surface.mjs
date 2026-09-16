#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as FS_CONSTANTS,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  assertSafeRelPath,
  assertSafeLine,
  assertSafeTestCommand,
  assertSafeHubRoot,
} from './sanitize.mjs';
import { renderTemplate } from './template.mjs';
import {
  applyProjectScaffold,
  parseProjectInstructions,
  planProjectScaffold,
  planSpecialistScaffold,
  withProjectScaffoldLock,
} from './project-scaffold.mjs';
import { collectViolations } from './validate-hub.mjs';

// Safe slug: lowercase alphanumerics and hyphens, must start with an alphanumeric.
// Rejects path separators, '..', dots, and anything that could escape the target dir.
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function routingRow({ surface, docsPath, agent, skill = '—' }) {
  return `| \`${surface}\` | [${docsPath}](${docsPath}) | \`${agent}\` | ${skill === '—' ? '—' : `\`${skill}\``} |`;
}

const ADAPTERS = ['claude', 'codex', 'opencode'];

function pathKind(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return 'symlink';
    if (!stat.isFile()) return 'non-file';
    return 'file';
  } catch (error) {
    if (error.code === 'ENOENT') return 'absent';
    throw error;
  }
}

function statIdentity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function ensureStandardParent(hubRoot, standardPath) {
  const logicalRoot = resolve(hubRoot);
  const physicalRoot = realpathSync(logicalRoot);
  const relativeParent = relative(logicalRoot, dirname(resolve(standardPath)));
  if (relativeParent === '..' || relativeParent.startsWith(`..${sep}`)) {
    throw new Error('standard target escapes hub root');
  }
  let cursor = physicalRoot;
  for (const part of relativeParent.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(cursor) !== cursor) {
        throw new Error(`unsafe standard ancestor: ${cursor}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      mkdirSync(cursor, { mode: 0o755 });
      const created = lstatSync(cursor);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error(`unsafe standard ancestor created: ${cursor}`);
      }
    }
  }
  return cursor;
}

function stageStandard({ hubRoot, standardPath, content }) {
  const parent = ensureStandardParent(hubRoot, standardPath);
  const target = join(parent, basename(standardPath));
  if (pathKind(target) !== 'absent') throw new Error(`standard already exists: ${standardPath}`);
  const temp = join(
    parent,
    `.${basename(standardPath)}.steepy-new-surface-${process.pid}-${randomBytes(12).toString('hex')}.tmp`,
  );
  let fd;
  try {
    fd = openSync(
      temp,
      FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | FS_CONSTANTS.O_NOFOLLOW,
      0o644,
    );
    writeFileSync(fd, Buffer.from(content, 'utf8'));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const stat = lstatSync(temp, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()
        || !readFileSync(temp).equals(Buffer.from(content, 'utf8'))) {
      throw new Error(`standard staging validation failed: ${standardPath}`);
    }
    return { temp, target, identity: statIdentity(stat), published: false };
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Cleanup below remains authoritative. */ }
    }
    try { unlinkSync(temp); } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError;
    }
    throw error;
  }
}

function publishStandard(stage, standardPath) {
  const staged = lstatSync(stage.temp, { bigint: true });
  if (!staged.isFile() || staged.isSymbolicLink() || statIdentity(staged) !== stage.identity) {
    throw new Error(`standard staged temp identity changed: ${standardPath}`);
  }
  if (pathKind(stage.target) !== 'absent') throw new Error(`standard already exists: ${standardPath}`);
  // Hard-link publication is atomic and create-only. It does not make this batch
  // multi-file atomic; adapters still publish one ordinary target at a time.
  linkSync(stage.temp, stage.target);
  stage.published = true;
}

function cleanupStandardStage(stage) {
  if (stage === null) return;
  try {
    const stat = lstatSync(stage.temp, { bigint: true });
    if (stat.isFile() && !stat.isSymbolicLink() && statIdentity(stat) === stage.identity) {
      unlinkSync(stage.temp);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function routingIndexUpdate({ hubRoot, row, surface, agent }) {
  const logicalTarget = join(hubRoot, '.apex', '_INDEX.md');
  if (pathKind(logicalTarget) !== 'file') {
    throw new Error(`active-v1 routing index is missing or unsafe: ${logicalTarget}`);
  }
  const physicalRoot = realpathSync(resolve(hubRoot));
  const target = realpathSync(logicalTarget);
  if (target !== join(physicalRoot, '.apex', '_INDEX.md')) {
    throw new Error(`active-v1 routing index escapes the physical hub: ${logicalTarget}`);
  }
  const bytes = readFileSync(target);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`active-v1 routing index is not UTF-8: ${target}`);
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const normalized = text.replaceAll('\r\n', '\n');
  const lines = normalized.split('\n');
  const tableRows = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.trimStart().startsWith('|'));
  const exact = tableRows.find(({ line }) => line.trim() === row);
  if (exact) return null;
  for (const { line } of tableRows) {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    const routedSurface = cells[0]?.match(/^`([^`]+)`$/u)?.[1];
    const routedAgent = cells[2]?.match(/^`([^`]+)`$/u)?.[1];
    if (routedSurface === surface || routedAgent === agent) {
      throw new Error(`active-v1 routing conflict for surface '${surface}' or agent '${agent}'`);
    }
  }
  const header = tableRows.find(({ line }) => /^\s*\|\s*Surface\s*\|/iu.test(line));
  if (!header || !/^\s*\|\s*[-:]+/u.test(lines[header.index + 1] ?? '')) {
    throw new Error('active-v1 routing table header is missing or malformed');
  }
  let insertAt = header.index + 2;
  while (insertAt < lines.length && lines[insertAt].trimStart().startsWith('|')) insertAt += 1;
  lines.splice(insertAt, 0, row);
  return {
    target,
    priorIdentity: statIdentity(lstatSync(target, { bigint: true })),
    priorMode: lstatSync(target).mode & 0o777,
    priorBytes: bytes,
    content: lines.join('\n').replaceAll('\n', eol),
  };
}

function stageRoutingIndex(update) {
  if (update === null) return null;
  const current = lstatSync(update.target, { bigint: true });
  if (!current.isFile() || current.isSymbolicLink()
      || statIdentity(current) !== update.priorIdentity
      || !readFileSync(update.target).equals(update.priorBytes)) {
    throw new Error('active-v1 routing index changed before staging');
  }
  const parent = dirname(update.target);
  const temp = join(
    parent,
    `.${basename(update.target)}.steepy-new-surface-${process.pid}-${randomBytes(12).toString('hex')}.tmp`,
  );
  let fd;
  try {
    fd = openSync(
      temp,
      FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | FS_CONSTANTS.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(fd, update.priorMode);
    writeFileSync(fd, Buffer.from(update.content, 'utf8'));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const stat = lstatSync(temp, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()
        || !readFileSync(temp).equals(Buffer.from(update.content, 'utf8'))) {
      throw new Error('active-v1 routing index staging validation failed');
    }
    return { ...update, temp, identity: statIdentity(stat), published: false };
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Cleanup below remains authoritative. */ }
    }
    try { unlinkSync(temp); } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError;
    }
    throw error;
  }
}

function publishRoutingIndex(stage) {
  if (stage === null || stage.published) return;
  const staged = lstatSync(stage.temp, { bigint: true });
  const current = lstatSync(stage.target, { bigint: true });
  if (!staged.isFile() || staged.isSymbolicLink() || statIdentity(staged) !== stage.identity
      || !current.isFile() || current.isSymbolicLink()
      || statIdentity(current) !== stage.priorIdentity
      || !readFileSync(stage.target).equals(stage.priorBytes)) {
    throw new Error('active-v1 routing index identity changed before publication');
  }
  renameSync(stage.temp, stage.target);
  stage.published = true;
}

function cleanupRoutingIndexStage(stage) {
  if (stage === null || stage.published) return;
  try {
    const stat = lstatSync(stage.temp, { bigint: true });
    if (stat.isFile() && !stat.isSymbolicLink() && statIdentity(stat) === stage.identity) {
      unlinkSync(stage.temp);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function activeProjectModel(hubRoot) {
  const path = join(hubRoot, 'AGENTS.md');
  const kind = pathKind(path);
  if (kind === 'absent') return null;
  if (kind !== 'file') throw new Error(`active-v1 project instructions are unsafe: ${path}`);
  const text = readFileSync(path, 'utf8');
  const managedProjectIdentityCount = text.match(/steepy:managed:project-instructions:/gu)?.length ?? 0;
  const model = parseProjectInstructions(text);
  if (managedProjectIdentityCount !== 0 && (model === null || managedProjectIdentityCount !== 2)) {
    throw new Error('managed Project identity is unsupported, malformed, duplicate, or unresolved');
  }
  return model;
}

function assertActiveStandardIdentity({ hubRoot, name, surfacePath }) {
  const standardPath = join(hubRoot, '.apex', 'standards', `${name}.md`);
  const corePath = join(hubRoot, '.apex', 'standards', name, `${name}-core.md`);
  const standardKind = pathKind(standardPath);
  const coreKind = pathKind(corePath);
  if (coreKind !== 'absent') {
    const shape = standardKind === 'absent' ? 'modular-only' : 'dual-shape';
    throw new Error(`active-v1 standard identity is ${shape}; the v1 producer requires ${standardPath}`);
  }
  if (standardKind === 'absent') return;
  if (standardKind !== 'file') {
    throw new Error(`active-v1 standard identity is unsafe: ${standardPath}`);
  }
  const physicalRoot = realpathSync(resolve(hubRoot));
  if (realpathSync(standardPath) !== join(physicalRoot, '.apex', 'standards', `${name}.md`)) {
    throw new Error(`active-v1 standard identity escapes its canonical path: ${standardPath}`);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(standardPath));
  } catch {
    throw new Error(`active-v1 standard identity is not UTF-8: ${standardPath}`);
  }
  const title = text.replaceAll('\r\n', '\n').split('\n')[0];
  if (title !== `# ${name} — Technical Standard`) {
    throw new Error(`active-v1 standard title does not match surface '${name}'`);
  }
  const ownerPath = text.match(/^>\s*Owning (?:surface|path):\s*`([^`]+)`/mu)?.[1];
  if (ownerPath !== surfacePath) {
    throw new Error(`active-v1 standard owner path does not match '${surfacePath}'`);
  }
}

function conflictDetails(conflicts) {
  return conflicts
    .map(({ id, path, reason, choices }) => `${id} (${path}: ${reason}; choices: ${choices.join(', ')})`)
    .join(', ');
}

// `repair: true` repairs the current public layout: current generated adapters and an existing
// standard are preserved, noncanonical adapters are refused, and missing
// targets are created. Every target is planned before the first output write.
export function scaffold({
  name,
  surfacePath,
  agent,
  hubRoot,
  templatesDir,
  testCmd = '',
  repair = false,
  resolutions = {},
}) {
  if (!SAFE_SLUG.test(name)) {
    throw new Error(`invalid surface name '${name}': use lowercase letters, digits, and hyphens only`);
  }
  if (!SAFE_SLUG.test(agent)) {
    throw new Error(`invalid agent name '${agent}': use lowercase letters, digits, and hyphens only`);
  }
  assertSafeRelPath(surfacePath, 'path');
  assertSafeTestCommand(testCmd, 'testCmd');
  const standardPath = join(hubRoot, '.apex', 'standards', `${name}.md`);
  const corePath = join(hubRoot, '.apex', 'standards', name, `${name}-core.md`);
  const adapterPaths = {
    claude: join(hubRoot, '.claude', 'agents', `${agent}.md`),
    codex: join(hubRoot, '.codex', 'agents', `${agent}.toml`),
    opencode: join(hubRoot, '.opencode', 'agents', `${agent}.md`),
  };
  const agentPath = adapterPaths.claude;
  const standardKind = pathKind(standardPath);
  const coreKind = pathKind(corePath);
  const haveStandardSingleFile = standardKind !== 'absent';
  const haveStandardCore = coreKind !== 'absent';
  const haveStandard = haveStandardSingleFile || haveStandardCore;
  const adapterKinds = Object.fromEntries(ADAPTERS.map((adapterName) => [
    adapterName, pathKind(adapterPaths[adapterName]),
  ]));

  for (const [path, kind] of [[standardPath, standardKind], [corePath, coreKind]]) {
    if (kind !== 'absent' && kind !== 'file') {
      throw new Error(`${kind} standard target blocks scaffold: ${path}`);
    }
  }
  if (!repair) {
    if (haveStandard) {
      const reportPath = haveStandardCore ? corePath : standardPath;
      throw new Error(`standard already exists: ${reportPath}`);
    }
    const existingAdapter = ADAPTERS.find((adapterName) => adapterKinds[adapterName] !== 'absent');
    if (existingAdapter) throw new Error(`adapter already exists: ${adapterPaths[existingAdapter]}`);
  }

  let resultStandardPath = standardPath;
  if (haveStandard) {
    // If only the core exists (modular form), report that path; otherwise report the single file
    if (haveStandardCore && !haveStandardSingleFile) {
      resultStandardPath = corePath;
    }
  }

  const row = routingRow({ surface: name, docsPath: `standards/${name}.md`, agent, skill: '—' });
  const activeModel = activeProjectModel(hubRoot);
  let mode = 'preparatory-unbound';
  let routingUpdate = null;
  let plan;
  if (activeModel === null) {
    if (Object.keys(resolutions).length > 0) {
      throw new Error('preparatory-unbound scaffolding does not accept project conflict resolutions');
    }
    plan = planSpecialistScaffold({
      hubRoot,
      surface: { name, path: surfacePath, agent, testCmd },
      templatesDir,
      repair,
    });
  } else {
    mode = 'active-v1';
    assertActiveStandardIdentity({ hubRoot, name, surfacePath });
    const existing = activeModel.surfaces.find((surface) => surface.name === name);
    if (existing && (existing.path !== surfacePath || existing.agent !== agent)) {
      throw new Error(`active-v1 surface '${name}' disagrees with the requested path or agent`);
    }
    const surfaces = existing
      ? activeModel.surfaces.map((surface) => (
        surface.name === name ? { ...surface, testCmd } : { ...surface }
      ))
      : [...activeModel.surfaces.map((surface) => ({ ...surface })), {
        name, path: surfacePath, agent, testCmd,
      }];
    plan = planProjectScaffold({
      hubRoot,
      templatesDir,
      model: {
        projectName: activeModel.projectName,
        description: activeModel.description,
        devCommands: [...activeModel.devCommands],
        surfaces,
        resolutions,
      },
    });
    routingUpdate = routingIndexUpdate({ hubRoot, row, surface: name, agent });
  }
  if (plan.conflicts.length > 0) {
    throw new Error(`specialist scaffold conflicts: ${conflictDetails(plan.conflicts)}`);
  }
  const standardContent = haveStandard
    ? null
    : renderTemplate(
      readFileSync(join(templatesDir, 'surface-standard.md'), 'utf8'),
      { name, path: surfacePath, testCmd },
    );

  const operationByAdapter = new Map(plan.operations.map((operation) => [
    ADAPTERS.find((adapterName) => operation.artifactId === `${agent}-${adapterName}`),
    operation,
  ]));
  const created = [];
  const preserved = [];
  if (haveStandard) preserved.push('standard');
  else created.push('standard');
  for (const adapterName of ADAPTERS) {
    if (operationByAdapter.has(adapterName)) created.push(adapterName);
    else preserved.push(adapterName);
  }

  let standardStage = null;
  let routingStage = null;
  const stageExternalArtifacts = () => {
    if (!haveStandard && standardStage === null) {
      standardStage = stageStandard({ hubRoot, standardPath, content: standardContent });
    }
    if (routingUpdate !== null && routingStage === null) {
      routingStage = stageRoutingIndex(routingUpdate);
    }
  };
  const publishExternalArtifacts = () => {
    if (!haveStandard && standardStage !== null && !standardStage.published) {
      publishStandard(standardStage, standardPath);
    }
    publishRoutingIndex(routingStage);
  };
  const mutating = plan.operations.length > 0 || !haveStandard || routingUpdate !== null;
  if (mutating) {
    withProjectScaffoldLock({ hubRoot, operations: plan.operations }, (lockLease) => {
      try {
        if (mode === 'active-v1') assertActiveStandardIdentity({ hubRoot, name, surfacePath });
        stageExternalArtifacts();
        if (plan.operations.length === 0) {
          publishExternalArtifacts();
        } else {
          applyProjectScaffold({
            hubRoot,
            plan,
            lockLease,
            checkpoint({ phase }) {
              if (phase === 'before-rename') publishExternalArtifacts();
            },
          });
        }
      } finally {
        cleanupStandardStage(standardStage);
        cleanupRoutingIndexStage(routingStage);
      }
    });
  }

  if (mode === 'active-v1') {
    const errors = collectViolations(hubRoot).filter(({ level }) => level === 'error');
    if (errors.length > 0) {
      throw new Error(`active-v1 result is not validator-coherent: ${errors[0].msg}`);
    }
  }

  return {
    standardPath: resultStandardPath,
    agentPath,
    adapterPaths,
    row,
    created,
    preserved,
    mode,
  };
}

export function main(argv = process.argv.slice(2)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const usage = 'usage: new-surface.mjs --name <surface> --path <path> [--agent <agent>] [--test <cmd>] [--hub <root>] [--repair] [--resolution <id=choice>]';
  let a;
  try {
    ({ values: a } = parseArgs({ args: argv, options: {
      name: { type: 'string' },
      path: { type: 'string' },
      agent: { type: 'string' },
      test: { type: 'string' },
      hub: { type: 'string' },
      repair: { type: 'boolean' },
      resolution: { type: 'string', multiple: true },
    } }));
  } catch (err) {
    console.error(`new-surface: ${err.message}`);
    console.error(usage);
    return 2;
  }
  if (!a.name || !a.path) {
    console.error(usage);
    return 2;
  }
  let res;
  try {
    const resolutions = {};
    for (const item of a.resolution ?? []) {
      assertSafeLine(item, 'resolution');
      const splitAt = item.lastIndexOf('=');
      if (splitAt <= 0 || splitAt === item.length - 1) {
        throw new Error(`invalid resolution '${item}': expected <id=choice>`);
      }
      const id = item.slice(0, splitAt);
      const choice = item.slice(splitAt + 1);
      if (Object.hasOwn(resolutions, id)) throw new Error(`duplicate resolution '${id}'`);
      resolutions[id] = choice;
    }
    res = scaffold({
      name: a.name, surfacePath: a.path, agent: a.agent || `${a.name}-agent`,
      hubRoot: assertSafeHubRoot(a.hub || process.cwd()), templatesDir: join(here, '..', 'templates'), testCmd: a.test || '',
      repair: a.repair === true,
      resolutions,
    });
  } catch (err) {
    console.error(`new-surface: ${err.message}`);
    return 1;
  }
  const pathFor = (artifact) => (artifact === 'standard' ? res.standardPath : res.adapterPaths[artifact]);
  for (const artifact of res.created) console.log(`created ${pathFor(artifact)}`);
  for (const artifact of res.preserved) console.log(`preserved ${pathFor(artifact)} (already exists)`);
  if (res.mode === 'active-v1') {
    console.log('\nactive-v1 root instructions and routing are coherent with the surface result.');
  } else if (res.created.length === 0) {
    console.log('\nnothing to scaffold — all targets already exist; its routing row should already be in .apex/_INDEX.md.');
  } else if (res.preserved.length === 0) {
    // A brand-new (or fully-missing) surface: its routing row still needs to be added.
    console.log('\nPaste this row into .apex/_INDEX.md routing table (the script does not edit _INDEX.md):\n');
    console.log(res.row);
  } else {
    // Completed a partial surface: the row already lives in .apex/_INDEX.md — leave it as-is.
    console.log('\nCompleted a partial surface; its routing row should already be in .apex/_INDEX.md (leave it as-is).');
  }
  console.log('\nThen run:  node <plugin>/scripts/validate-hub.mjs');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as FS_CONSTANTS,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertSafeRelPath, assertSafeTestCommand, bindProjectMount } from './sanitize.mjs';
import { renderTemplate } from './template.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATES_DIR = join(MODULE_DIR, '..', 'templates');
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const TOP_LEVEL_KEYS = ['projectName', 'description', 'devCommands', 'surfaces', 'resolutions'];
const SURFACE_KEYS = ['name', 'path', 'agent', 'testCmd'];
const NORMALIZED_MODELS = new WeakSet();
const PROJECT_SCAFFOLD_LOCK = '.steepy-project-scaffold.lock';
const PROJECT_SCAFFOLD_LOCK_OWNER = 'owner.json';
const LOCK_TOKEN = /^[a-f0-9]{32}$/;
const ACTIVE_PROJECT_SCAFFOLD_LOCKS = new WeakMap();
const PROJECT_MARKERS = {
  'project-instructions': {
    start: '<!-- steepy:managed:project-instructions:v1:start -->',
    end: '<!-- steepy:managed:project-instructions:v1:end -->',
  },
  'claude-import': {
    start: '<!-- steepy:managed:claude-import:v1:start -->',
    end: '<!-- steepy:managed:claude-import:v1:end -->',
  },
};

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertPlainDataObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} must not contain symbol properties`);
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) throw new TypeError(`${label}.${key} must not be an accessor`);
    if (!descriptor.enumerable) throw new TypeError(`${label}.${key} must be enumerable data`);
  }
}

function assertExactKeys(value, expected, label) {
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new TypeError(`${label} has unknown properties: ${unknown.join(', ')}`);
  if (missing.length > 0) throw new TypeError(`${label} is missing properties: ${missing.join(', ')}`);
}

function assertPlainDataArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be an array`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} must not contain symbol properties`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor) throw new TypeError(`${label} must not contain sparse entries`);
    if (!('value' in descriptor)) throw new TypeError(`${label}[${index}] must not be an accessor`);
    if (!descriptor.enumerable) throw new TypeError(`${label}[${index}] must be enumerable data`);
  }
  const allowed = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))]);
  const unknown = Reflect.ownKeys(descriptors).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new TypeError(`${label} has unknown properties: ${unknown.join(', ')}`);
}

function assertUtf8String(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new TypeError(`${label} must be valid UTF-8`);
  }
}

function assertLine(value, label) {
  assertUtf8String(value, label);
  if (/\r|\n|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a single safe line`);
  }
}

function assertSlug(value, label) {
  assertLine(value, label);
  if (!SLUG.test(value)) throw new TypeError(`${label} must be a lowercase slug`);
}

function assertRelativePath(value, label) {
  assertLine(value, label);
  try {
    assertSafeRelPath(value, label);
  } catch (error) {
    throw new TypeError(error.message);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new TypeError(`${label} must be a safe relative path without traversal`);
  }
}

function managedMarkers(text, artifactId) {
  return [...text.matchAll(/steepy:managed:([^:\s>]+):v([^:\s>]+):(start|end)/gu)]
    .filter((match) => match[1] === artifactId);
}

function assertRepresentableRootFreeText(value, label) {
  if (managedMarkers(value, 'project-instructions').length > 0) {
    throw new TypeError(`${label} must not contain a managed Project provenance marker`);
  }
}

function normalizeSurface(surface, index) {
  const label = `surfaces[${index}]`;
  assertPlainDataObject(surface, label);
  assertExactKeys(surface, SURFACE_KEYS, label);
  assertSlug(surface.name, `${label}.name`);
  assertRelativePath(surface.path, `${label}.path`);
  assertSlug(surface.agent, `${label}.agent`);
  try {
    assertSafeTestCommand(surface.testCmd, `${label}.testCmd`);
  } catch (error) {
    throw new TypeError(error.message);
  }
  return {
    name: surface.name,
    path: surface.path,
    agent: surface.agent,
    testCmd: surface.testCmd,
  };
}

function normalizeProjectModelInternal(model, { allowEmptySurfaces = false } = {}) {
  assertPlainDataObject(model, 'model');
  assertExactKeys(model, TOP_LEVEL_KEYS, 'model');
  assertSlug(model.projectName, 'projectName');
  assertLine(model.description, 'description');
  assertRepresentableRootFreeText(model.description, 'description');
  assertPlainDataArray(model.devCommands, 'devCommands');
  const devCommands = model.devCommands.map((command, index) => {
    const label = `devCommands[${index}]`;
    assertLine(command, label);
    assertRepresentableRootFreeText(command, label);
    if (command.length === 0) throw new TypeError(`devCommands[${index}] must be non-empty`);
    if (command.includes('`')) throw new TypeError(`devCommands[${index}] must not contain a backtick`);
    return command;
  });
  assertPlainDataArray(model.surfaces, 'surfaces');
  if (!allowEmptySurfaces && model.surfaces.length === 0) {
    throw new TypeError('surfaces must be a non-empty array');
  }
  const surfaces = model.surfaces.map(normalizeSurface)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const field of ['name', 'agent', 'path']) {
    const seen = new Set();
    for (const surface of surfaces) {
      if (seen.has(surface[field])) throw new TypeError(`duplicate surface ${field}: ${surface[field]}`);
      seen.add(surface[field]);
    }
  }
  assertPlainDataObject(model.resolutions, 'resolutions');
  const resolutions = {};
  for (const [id, choice] of Object.entries(model.resolutions)) {
    assertLine(id, `resolutions key '${id}'`);
    assertLine(choice, `resolutions.${id}`);
    Object.defineProperty(resolutions, id, {
      value: choice,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  const normalized = deepFreeze({
    projectName: model.projectName,
    description: model.description,
    devCommands,
    surfaces,
    resolutions,
  });
  NORMALIZED_MODELS.add(normalized);
  return normalized;
}

export function normalizeProjectModel(model) {
  return normalizeProjectModelInternal(model);
}

function normalizeRootInstructionModel(model) {
  return normalizeProjectModelInternal(model, { allowEmptySurfaces: true });
}

function normalizedModel(model) {
  return NORMALIZED_MODELS.has(model) ? model : normalizeProjectModel(model);
}

function renderVars(model, surface) {
  return {
    projectName: model.projectName,
    description: model.description,
    devCommands: model.devCommands.map((command) => `- \`${command}\``).join('\n'),
    surfaceList: model.surfaces
      .map((item) => `- \`${item.name}\` (\`${item.path}\`) — \`${item.agent}\``)
      .join('\n'),
    surface: surface?.name ?? '',
    path: surface?.path ?? '',
    agent: surface?.agent ?? '',
    model: 'inherit',
  };
}

function readTemplate(templatesDir, name) {
  const bytes = readFileSync(join(templatesDir, name));
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\r')) throw new Error(`template ${name} must use LF line endings`);
  return text;
}

function surfaceForArtifact(artifactId, model) {
  return model.surfaces.find((surface) => (
    artifactId === `${surface.agent}-claude`
    || artifactId === `${surface.agent}-codex`
    || artifactId === `${surface.agent}-opencode`
  ));
}

function templateForArtifact(artifactId, model) {
  if (artifactId === 'project-instructions') return ['AGENTS.md', undefined];
  if (artifactId === 'claude-import') return ['claude-import.md', undefined];
  if (artifactId === 'project-bootstrap') return ['project-bootstrap-skill.md', undefined];
  if (artifactId === 'claude-bootstrap-stub') return ['claude-bootstrap-stub.md', undefined];
  const surface = surfaceForArtifact(artifactId, model);
  if (!surface) throw new TypeError(`unknown project artifact: ${artifactId}`);
  if (artifactId.endsWith('-claude')) return ['surface-agent-claude.md', surface];
  if (artifactId.endsWith('-codex')) return ['surface-agent-codex.toml', surface];
  return ['surface-agent-opencode.md', surface];
}

export function renderProjectArtifact(artifactId, normalized, templatesDir = DEFAULT_TEMPLATES_DIR) {
  const model = normalizedModel(normalized);
  const [templateName, surface] = templateForArtifact(artifactId, model);
  return renderTemplate(readTemplate(templatesDir, templateName), renderVars(model, surface));
}

// Recover the exact public Project identity stored in the managed AGENTS.md block.
// Surface test commands are intentionally not encoded in root instructions, so
// parsed existing surfaces use the neutral empty command. Generated adapters do
// not depend on testCmd; a new-surface workflow supplies the new row's real value.
export function parseProjectInstructions(text, templatesDir = DEFAULT_TEMPLATES_DIR) {
  assertUtf8String(text, 'project instructions');
  const { start, end } = PROJECT_MARKERS['project-instructions'];
  if (occurrences(text, start) !== 1 || occurrences(text, end) !== 1) return null;
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end, startAt + start.length);
  if (endAt < startAt) return null;
  const block = text.slice(startAt, endAt + end.length).replaceAll('\r\n', '\n');
  const lines = block.split('\n');
  const devAt = 5;
  const surfacesAt = lines.indexOf('## Confirmed surfaces', devAt + 1);
  const navAt = lines.indexOf('## Project navigation', surfacesAt + 1);
  const projectMatch = lines[1]?.match(/^# ([a-z0-9][a-z0-9-]*)$/u);
  const descriptionLines = lines.slice(2, devAt);
  if (!projectMatch || lines[devAt] !== '## Development commands'
      || surfacesAt <= devAt || navAt <= surfacesAt
      || descriptionLines.length !== 3 || descriptionLines[0] !== '' || descriptionLines[2] !== '') {
    return null;
  }
  const devCommands = [];
  for (const line of lines.slice(devAt + 1, surfacesAt).filter(Boolean)) {
    const match = line.match(/^- `([^`\r\n]+)`$/u);
    if (!match) return null;
    devCommands.push(match[1]);
  }
  const surfaces = [];
  for (const line of lines.slice(surfacesAt + 1, navAt).filter(Boolean)) {
    const match = line.match(/^- `([a-z0-9][a-z0-9-]*)` \(`([^`\r\n]+)`\) — `([a-z0-9][a-z0-9-]*)`$/u);
    if (!match) return null;
    surfaces.push({ name: match[1], path: match[2], agent: match[3], testCmd: '' });
  }
  let model;
  try {
    model = normalizeRootInstructionModel({
      projectName: projectMatch[1],
      description: descriptionLines[1],
      devCommands,
      surfaces,
      resolutions: {},
    });
  } catch {
    return null;
  }
  return block === renderProjectArtifact('project-instructions', model, templatesDir).trimEnd()
    ? model
    : null;
}

function rootProjection(model) {
  return {
    projectName: model.projectName,
    description: model.description,
    devCommands: model.devCommands,
    surfaces: model.surfaces.map(({ name, path, agent }) => ({ name, path, agent, testCmd: '' })),
    resolutions: {},
  };
}

function assertRootProjectionRoundTrip(model, templatesDir) {
  const rendered = renderProjectArtifact('project-instructions', model, templatesDir);
  const parsed = parseProjectInstructions(rendered, templatesDir);
  if (parsed === null
      || JSON.stringify(parsed) !== JSON.stringify(rootProjection(model))) {
    throw new TypeError('normalized root projection must render and parse as an exact round-trip');
  }
}

function artifactDefinitions(model, templatesDir) {
  const definitions = [
    ['project-instructions', 'AGENTS.md', 'mixed'],
    ['claude-import', 'CLAUDE.md', 'mixed'],
    ['project-bootstrap', `.agents/skills/${model.projectName}-bootstrap/SKILL.md`, 'generated'],
    ['claude-bootstrap-stub', `.claude/skills/${model.projectName}-bootstrap/SKILL.md`, 'generated'],
  ];
  for (const surface of model.surfaces) {
    definitions.push(
      [`${surface.agent}-claude`, `.claude/agents/${surface.agent}.md`, 'generated'],
      [`${surface.agent}-codex`, `.codex/agents/${surface.agent}.toml`, 'generated'],
      [`${surface.agent}-opencode`, `.opencode/agents/${surface.agent}.md`, 'generated'],
    );
  }
  return definitions.map(([artifactId, path, type]) => ({
    artifactId,
    path,
    type,
    content: renderProjectArtifact(artifactId, model, templatesDir),
  })).sort((left, right) => compareOperationOrder(
    operationOrder(left), operationOrder(right),
  ));
}

function rootInstructionArtifacts(model, templatesDir) {
  return artifactDefinitions(model, templatesDir)
    .filter(({ artifactId }) => artifactId === 'project-instructions' || artifactId === 'claude-import');
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function occurrences(text, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function lineEnding(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

export function countActiveClaudeImports(text) {
  assertUtf8String(text, 'Claude import text');
  const activeText = text.replace(/<!--[\s\S]*?-->/gu, '');
  return [...activeText.matchAll(/^\s*@AGENTS\.md\s*$/gmu)].length;
}

function convertLf(text, eol) {
  return eol === '\n' ? text : text.replaceAll('\n', eol);
}

function appendManaged(existing, block, preferredEol = lineEnding(existing)) {
  const eol = preferredEol;
  const rendered = convertLf(block, eol);
  if (existing.length === 0) return rendered;
  const separator = existing.endsWith(eol) ? eol : `${eol}${eol}`;
  return `${existing}${separator}${rendered}`;
}

function replaceManaged(existing, artifactId, block) {
  const markers = PROJECT_MARKERS[artifactId];
  const start = existing.indexOf(markers.start);
  const end = existing.indexOf(markers.end, start + markers.start.length);
  if (start === -1 || end === -1) return appendManaged(existing, block);
  const afterMarker = end + markers.end.length;
  const rendered = convertLf(block.trimEnd(), lineEnding(existing));
  const eol = lineEnding(existing);
  let before = existing.slice(0, start);
  let after = existing.slice(afterMarker);
  if (before !== '' && !/(?:\r?\n){2}$/u.test(before)) {
    before += /(?:\r?\n)$/u.test(before) ? eol : `${eol}${eol}`;
  }
  if (after !== '' && !/^(?:\r?\n)(?:$|\r?\n)/u.test(after)) {
    after = /^(?:\r?\n)/u.test(after) ? `${eol}${after}` : `${eol}${eol}${after}`;
  }
  return `${before}${rendered}${after}`;
}

function commentStateAfter(line, initiallyInside) {
  let inside = initiallyInside;
  let offset = 0;
  while (offset < line.length) {
    if (inside) {
      const end = line.indexOf('-->', offset);
      if (end === -1) return true;
      inside = false;
      offset = end + 3;
    } else {
      const start = line.indexOf('<!--', offset);
      if (start === -1) return false;
      inside = true;
      offset = start + 4;
    }
  }
  return inside;
}

function preserveUnmanagedClaudeImports(fragment, fallbackEol) {
  let result = '';
  let insideComment = false;
  for (const match of fragment.matchAll(/[^\r\n]*(?:\r\n|\n|$)/gu)) {
    const line = match[0];
    if (line === '') continue;
    const eolMatch = line.match(/(\r\n|\n)$/u);
    const eol = eolMatch?.[1] ?? fallbackEol;
    const body = eolMatch ? line.slice(0, -eolMatch[1].length) : line;
    if (!insideComment && /^\s*@AGENTS\.md\s*$/u.test(body)) {
      // Add only wrapper bytes: the complete original line (including its EOL,
      // when present) remains contiguous inside inert Markdown comment prose.
      result += `<!-- preserved unmanaged Claude import${eol}${line}`;
      if (!eolMatch) result += eol;
      result += `-->${eol}`;
    } else {
      result += line;
    }
    insideComment = commentStateAfter(body, insideComment);
  }
  return result;
}

function removeActiveUnmanagedClaudeImports(text) {
  let result = '';
  let insideComment = false;
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\n|$)/gu)) {
    const line = match[0];
    if (line === '') continue;
    const eolMatch = line.match(/(\r\n|\n)$/u);
    const body = eolMatch ? line.slice(0, -eolMatch[1].length) : line;
    if (!insideComment && /^\s*@AGENTS\.md\s*$/u.test(body)) {
      // The active import instruction is adopted into the canonical block; all
      // other lines remain byte-exact and in their original order.
    } else {
      result += line;
    }
    insideComment = commentStateAfter(body, insideComment);
  }
  return result;
}

function preserveExtraClaudeImports(existing) {
  const markers = PROJECT_MARKERS['claude-import'];
  const start = existing.indexOf(markers.start);
  const end = existing.indexOf(markers.end, start + markers.start.length);
  if (start === -1 || end === -1) return existing;
  const afterMarker = end + markers.end.length;
  const eol = lineEnding(existing);
  return `${preserveUnmanagedClaudeImports(existing.slice(0, start), eol)}`
    + `${existing.slice(start, afterMarker)}`
    + `${preserveUnmanagedClaudeImports(existing.slice(afterMarker), eol)}`;
}

function safeTarget(hubRoot, artifactPath) {
  const root = resolve(hubRoot);
  const target = resolve(root, artifactPath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    return { target, reason: 'unsafe-path' };
  }
  try {
    const mount = bindProjectMount(root, artifactPath);
    if (mount) return safeTarget(mount.root, mount.path);
  } catch {
    return { target, reason: 'symlink' };
  }
  let cursor = root;
  for (const part of relative(root, dirname(target)).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) return { target, reason: 'symlink' };
      if (!stat.isDirectory()) return { target, reason: 'unsafe-path' };
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  return { target, reason: null };
}

function readObserved(hubRoot, artifactPath) {
  const safe = safeTarget(hubRoot, artifactPath);
  if (safe.reason) return { ...safe, exists: true };
  let stat;
  try {
    stat = lstatSync(safe.target);
  } catch (error) {
    if (error.code === 'ENOENT') return { ...safe, exists: false };
    throw error;
  }
  if (stat.isSymbolicLink()) return { ...safe, exists: true, reason: 'symlink' };
  if (!stat.isFile()) return { ...safe, exists: true, reason: 'unsafe-path' };
  const bytes = readFileSync(safe.target);
  let text;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    text = bytes.toString('utf8');
  } catch {
    return { ...safe, exists: true, reason: 'unsafe-path', bytes };
  }
  return { ...safe, exists: true, bytes, text };
}

function classifyMixed(observed, artifact, model) {
  const { artifactId, content } = artifact;
  const text = observed.text;
  if (artifactId === 'claude-import'
      && (text.includes('<!-- steepy:start -->') || text.includes('<!-- steepy:end -->'))) {
    return { priorState: 'customized', reason: 'customized', replacement: content };
  }
  const relatedMarkers = managedMarkers(text, artifactId);
  if (relatedMarkers.some((match) => match[2] !== '1')) {
    return { priorState: 'malformed', reason: 'unknown-version', replacement: content };
  }
  const markers = PROJECT_MARKERS[artifactId];
  const startCount = occurrences(text, markers.start);
  const endCount = occurrences(text, markers.end);
  const related = artifactId === 'project-instructions'
    ? /steepy:managed:project-instructions:/u
    : /steepy:managed:claude-import:/u;
  if (startCount === 0 && endCount === 0) {
    if (related.test(text)) {
      return { priorState: 'malformed', reason: /:v(?!1:)/u.test(text) ? 'unknown-version' : 'malformed-markers', replacement: content };
    }
    if (artifactId === 'claude-import' && countActiveClaudeImports(text) > 0) {
      const remainder = removeActiveUnmanagedClaudeImports(text);
      return {
        priorState: 'unmarked',
        reason: 'unmanaged-import',
        replacement: appendManaged(remainder, content, lineEnding(text)),
      };
    }
    return { priorState: 'unmarked', reason: null, replacement: appendManaged(text, content) };
  }
  if (startCount > 1 || endCount > 1) {
    return { priorState: 'malformed', reason: 'duplicate', replacement: content };
  }
  if (startCount !== 1 || endCount !== 1) {
    return { priorState: 'malformed', reason: 'malformed-markers', replacement: content };
  }
  const start = text.indexOf(markers.start);
  const end = text.indexOf(markers.end, start + markers.start.length);
  if (end < start) return { priorState: 'malformed', reason: 'malformed-markers', replacement: content };
  const actual = text.slice(start, end + markers.end.length);
  const expected = convertLf(content.trimEnd(), lineEnding(text));
  const before = text.slice(0, start);
  const after = text.slice(end + markers.end.length);
  const positionedBefore = before === '' || /(?:\r?\n){2}$/u.test(before);
  const positionedAfter = after === '' || /^(?:\r?\n)(?:$|\r?\n)/u.test(after);
  const importCardinalityCurrent = artifactId !== 'claude-import'
    || countActiveClaudeImports(text) === 1;
  if (actual === expected && positionedBefore && positionedAfter && importCardinalityCurrent) {
    return { priorState: 'current', reason: null, replacement: null };
  }
  let replacement = replaceManaged(text, artifactId, content);
  if (artifactId === 'claude-import') replacement = preserveExtraClaudeImports(replacement);
  return {
    priorState: 'customized',
    reason: 'customized',
    replacement,
  };
}

function generatedMarkers(text) {
  return [...text.matchAll(/steepy:generated:([^:\s>]+):v([^:\s>]+)/gu)]
    .map((match) => ({ artifactId: match[1], version: match[2] }));
}

function expectedGeneratedMarkerId(artifact, model) {
  if (artifact.artifactId === 'project-bootstrap') return `${model.projectName}-bootstrap`;
  if (artifact.artifactId === 'claude-bootstrap-stub') return `${model.projectName}-bootstrap-stub`;
  return artifact.artifactId;
}

function classifyGenerated(observed, artifact, model) {
  if (observed.text === artifact.content) {
    return { priorState: 'current', reason: null, replacement: null };
  }
  const markers = generatedMarkers(observed.text);
  if (markers.length > 1) {
    return { priorState: 'malformed', reason: 'duplicate', replacement: artifact.content };
  }
  if (markers.length === 1) {
    if (markers[0].version !== '1') {
      return { priorState: 'malformed', reason: 'unknown-version', replacement: artifact.content };
    }
    if (markers[0].artifactId !== expectedGeneratedMarkerId(artifact, model)) {
      const adapter = ['claude', 'codex', 'opencode']
        .find((name) => artifact.artifactId.endsWith(`-${name}`));
      const reason = adapter && markers[0].artifactId.endsWith(`-${adapter}`)
        ? 'surface-mismatch'
        : 'wrong-target';
      return { priorState: 'malformed', reason, replacement: artifact.content };
    }
  }
  return { priorState: 'customized', reason: 'customized', replacement: artifact.content };
}

function classifyInternal({ hubRoot, artifact, normalizedModel: model }) {
  const observed = readObserved(hubRoot, artifact.path);
  if (!observed.exists) {
    return deepFreeze({ priorState: 'absent', priorDigest: null, reason: null, replacement: artifact.content });
  }
  const priorDigest = observed.bytes ? digest(observed.bytes) : null;
  if (observed.reason) {
    return deepFreeze({ priorState: 'unsafe', priorDigest, reason: observed.reason, replacement: null });
  }
  const classified = artifact.type === 'mixed'
    ? classifyMixed(observed, artifact, model)
    : classifyGenerated(observed, artifact, model);
  return deepFreeze({ priorDigest, ...classified });
}

export function classifyProjectArtifact({ hubRoot, artifact, normalizedModel: normalized }) {
  if (typeof hubRoot !== 'string' || hubRoot.length === 0) throw new TypeError('hubRoot must be a path');
  const model = normalizedModel(normalized);
  let descriptor = artifact;
  if (typeof artifact === 'string') {
    descriptor = artifactDefinitions(model, DEFAULT_TEMPLATES_DIR)
      .find(({ artifactId }) => artifactId === artifact);
  }
  assertPlainDataObject(descriptor, 'artifact');
  if (!descriptor.artifactId || !descriptor.path || !descriptor.content) {
    throw new TypeError('artifact must include artifactId, path, and content');
  }
  const type = descriptor.type ?? (PROJECT_MARKERS[descriptor.artifactId] ? 'mixed' : 'generated');
  return classifyInternal({ hubRoot, artifact: { ...descriptor, type }, normalizedModel: model });
}

function conflictChoices(reason, priorState) {
  if (reason === 'unmanaged-import') return ['adopt', 'abort'];
  if (priorState === 'customized' || priorState === 'malformed') {
    return ['replace', 'abort'];
  }
  return ['abort'];
}

function makeConflict(artifact, reason, priorState) {
  return {
    id: `v1:${artifact.artifactId}:${reason}`,
    artifactId: artifact.artifactId,
    path: artifact.path,
    reason,
    choices: conflictChoices(reason, priorState),
  };
}

function makeOperation(artifact, classification) {
  return {
    id: `v1:op:${artifact.artifactId}`,
    kind: classification.priorState === 'absent'
      ? 'create'
      : artifact.type === 'mixed' ? 'replace-managed' : 'replace-generated',
    artifactId: artifact.artifactId,
    path: artifact.path,
    priorState: classification.priorState,
    priorDigest: classification.priorDigest,
    content: classification.replacement ?? artifact.content,
  };
}

function boundedGeneratedEntries(hubRoot) {
  const entries = [];
  let reservedWork;
  try { reservedWork = lstatSync(join(hubRoot, '.apex', 'work')); }
  catch { /* Work is excluded local state, never a required planner input. */ }
  const visit = (absolute, logical) => {
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    if (reservedWork && stat.dev === reservedWork.dev && stat.ino === reservedWork.ino) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const path = logical ? `${logical}/${entry.name}` : entry.name;
      const target = join(absolute, entry.name);
      if (entry.isSymbolicLink()) {
        entries.push({ path, kind: 'symlink' });
      } else if (entry.isDirectory()) {
        visit(target, path);
      } else if (entry.isFile()) {
        entries.push({ path, kind: 'file' });
      }
    }
  };
  for (const provider of ['.agents', '.claude', '.codex', '.opencode']) {
    const safe = safeTarget(hubRoot, provider);
    if (!safe.reason) visit(safe.target, provider);
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function immediateAdapterIdentity(path) {
  const match = /^\.(claude|codex|opencode)\/agents\/([a-z0-9][a-z0-9-]*)\.(md|toml)$/u.exec(path);
  if (!match) return null;
  const [, adapter, agent, extension] = match;
  if ((adapter === 'codex') !== (extension === 'toml')) return null;
  return `${agent}-${adapter}`;
}

function orphanArtifacts(hubRoot, expectedArtifacts) {
  const expectedIds = new Set(expectedArtifacts.map(({ artifactId }) => artifactId));
  const expectedPaths = new Set(expectedArtifacts.map(({ path }) => path));
  const expectedByMarker = new Map();
  for (const artifact of expectedArtifacts) {
    for (const marker of generatedMarkers(artifact.content)) {
      expectedByMarker.set(marker.artifactId, artifact);
    }
  }
  const orphans = [];
  for (const entry of boundedGeneratedEntries(hubRoot)) {
    if (expectedPaths.has(entry.path)) continue;
    if (entry.kind === 'symlink') {
      const artifactId = immediateAdapterIdentity(entry.path);
      if (artifactId && !expectedIds.has(artifactId)) {
        orphans.push({ artifactId, path: entry.path, reason: 'symlink' });
      }
      continue;
    }
    const observed = readObserved(hubRoot, entry.path);
    if (!observed.text) continue;
    const markers = generatedMarkers(observed.text);
    if (markers.length === 0) continue;
    const expected = markers.map((marker) => expectedByMarker.get(marker.artifactId)).find(Boolean);
    if (expected) {
      const canonical = readObserved(hubRoot, expected.path);
      orphans.push({
        artifactId: expected.artifactId,
        path: entry.path,
        reason: canonical.exists ? 'duplicate' : 'wrong-target',
      });
    } else {
      orphans.push({ artifactId: markers[0].artifactId, path: entry.path, reason: 'orphan' });
    }
  }
  const unique = new Map();
  for (const orphan of orphans.sort(compareConflicts)) {
    const id = `${orphan.artifactId}:${orphan.reason}`;
    if (!unique.has(id)) unique.set(id, orphan);
  }
  return [...unique.values()];
}

function assertResolutionSet(resolutions, offered) {
  for (const [id, choice] of Object.entries(resolutions)) {
    const conflict = offered.get(id);
    if (!conflict) throw new TypeError(`resolution ${id} does not match a current conflict`);
    if (!conflict.choices.includes(choice)) {
      throw new TypeError(`resolution '${choice}' is not offered for ${id}`);
    }
  }
}

function planArtifacts({ hubRoot, normalized, artifacts, includeOrphans }) {
  const candidates = [];
  for (const artifact of artifacts) {
    const classification = classifyInternal({ hubRoot, artifact, normalizedModel: normalized });
    if (classification.priorState === 'current') continue;
    if (classification.reason) {
      candidates.push({
        artifact,
        classification,
        conflict: makeConflict(artifact, classification.reason, classification.priorState),
      });
    } else {
      candidates.push({ artifact, classification, conflict: null });
    }
  }
  if (includeOrphans) {
    const orphans = orphanArtifacts(hubRoot, artifacts);
    const blockedArtifactIds = new Set(orphans.map(({ artifactId }) => artifactId));
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      if (blockedArtifactIds.has(candidates[index].artifact.artifactId)
          && candidates[index].conflict === null) {
        candidates.splice(index, 1);
      }
    }
    for (const orphan of orphans) {
      const artifact = { artifactId: orphan.artifactId, path: orphan.path, type: 'generated', content: '' };
      const classification = {
        priorState: 'unsafe', priorDigest: null, reason: orphan.reason, replacement: null,
      };
      candidates.push({
        artifact,
        classification,
        conflict: makeConflict(artifact, orphan.reason, classification.priorState),
      });
    }
  }
  const offered = new Map(candidates.filter(({ conflict }) => conflict).map(({ conflict }) => [conflict.id, conflict]));
  assertResolutionSet(normalized.resolutions, offered);

  const operations = [];
  const conflicts = [];
  for (const candidate of candidates) {
    if (!candidate.conflict) {
      operations.push(makeOperation(candidate.artifact, candidate.classification));
      continue;
    }
    const choice = normalized.resolutions[candidate.conflict.id];
    if (choice === 'adopt') {
      operations.push(makeOperation(candidate.artifact, candidate.classification));
      continue;
    }
    if (choice === 'replace') {
      operations.push(makeOperation(candidate.artifact, candidate.classification));
      continue;
    }
    conflicts.push(candidate.conflict);
  }
  conflicts.sort(compareConflicts);
  return deepFreeze({ schemaVersion: 1, operations, conflicts });
}

export function planProjectScaffold({ hubRoot, model, templatesDir = DEFAULT_TEMPLATES_DIR }) {
  if (typeof hubRoot !== 'string' || hubRoot.length === 0) throw new TypeError('hubRoot must be a path');
  const normalized = normalizeProjectModel(model);
  assertRootProjectionRoundTrip(normalized, templatesDir);
  const artifacts = artifactDefinitions(normalized, templatesDir);
  return planArtifacts({
    hubRoot,
    normalized,
    artifacts,
    includeOrphans: true,
  });
}

export function planRootInstructions({ hubRoot, model, templatesDir = DEFAULT_TEMPLATES_DIR }) {
  if (typeof hubRoot !== 'string' || hubRoot.length === 0) throw new TypeError('hubRoot must be a path');
  const normalized = normalizeRootInstructionModel(model);
  assertRootProjectionRoundTrip(normalized, templatesDir);
  return planArtifacts({
    hubRoot,
    normalized,
    artifacts: rootInstructionArtifacts(normalized, templatesDir),
    includeOrphans: false,
  });
}

export function previewProjectScaffold(plan) {
  validateProjectScaffoldPlan(plan);
  return deepFreeze(plan.operations.map(({ id, kind, artifactId, path, priorState }) => ({
    id,
    kind,
    artifactId,
    path,
    priorState,
  })));
}

export function validateProjectScaffoldPlan(plan) {
  assertPlainDataObject(plan, 'plan');
  assertExactKeys(plan, ['schemaVersion', 'operations', 'conflicts'], 'plan');
  if (plan.schemaVersion !== 1) throw new TypeError('plan.schemaVersion must be 1');
  assertPlainDataArray(plan.operations, 'plan.operations');
  assertPlainDataArray(plan.conflicts, 'plan.conflicts');
  const operationIds = new Set();
  const operationPaths = new Set();
  let priorOrder = null;
  for (const [index, operation] of plan.operations.entries()) {
    assertPlainDataObject(operation, `operations[${index}]`);
    assertExactKeys(operation,
      ['id', 'kind', 'artifactId', 'path', 'priorState', 'priorDigest', 'content'],
      `operations[${index}]`);
    assertSlug(operation.artifactId, `operations[${index}].artifactId`);
    if (operation.id !== `v1:op:${operation.artifactId}`) throw new TypeError('operation id mismatch');
    if (!['create', 'replace-managed', 'replace-generated'].includes(operation.kind)) {
      throw new TypeError(`invalid operation kind: ${operation.kind}`);
    }
    assertRelativePath(operation.path, `operations[${index}].path`);
    assertUtf8String(operation.content, `operations[${index}].content`);
    if (/\{\{[^}]*\}\}/u.test(operation.content)) {
      throw new TypeError(`operations[${index}].content has an unresolved placeholder`);
    }
    if (operationIds.has(operation.id)) throw new TypeError(`duplicate operation id: ${operation.id}`);
    if (operationPaths.has(operation.path)) throw new TypeError(`duplicate operation path: ${operation.path}`);
    operationIds.add(operation.id);
    operationPaths.add(operation.path);
    validateOperationContract(operation, index);
    const order = operationOrder(operation);
    if (priorOrder !== null && compareOperationOrder(priorOrder, order) >= 0) {
      throw new TypeError(`operations[${index}] is out of canonical order`);
    }
    priorOrder = order;
  }
  validateOperationCoherence(plan.operations);
  validateConflictContract(plan.conflicts, operationIds, operationPaths);
  return plan;
}

const ROOT_OPERATION_ORDER = new Map([
  ['project-instructions', 0],
  ['claude-import', 1],
  ['project-bootstrap', 2],
  ['claude-bootstrap-stub', 3],
]);
const ADAPTER_ORDER = new Map([['claude', 0], ['codex', 1], ['opencode', 2]]);
const PRIOR_STATES = new Set(['absent', 'unmarked', 'customized', 'malformed']);
const CONFLICT_REASONS = new Set([
  'unmanaged-import', 'customized', 'malformed-markers', 'unknown-version', 'duplicate',
  'wrong-target', 'surface-mismatch', 'orphan', 'symlink', 'unsafe-path',
]);

function adapterIdentity(artifactId) {
  const match = artifactId.match(/^([a-z0-9][a-z0-9-]*)-(claude|codex|opencode)$/u);
  return match ? { agent: match[1], adapter: match[2] } : null;
}

function operationSurface(operation) {
  const identity = adapterIdentity(operation.artifactId);
  if (!identity) return null;
  if (identity.adapter === 'codex') {
    return operation.content.match(/You are the [a-z0-9][a-z0-9-]* specialist for the ([a-z0-9][a-z0-9-]*) surface\./u)?.[1] ?? null;
  }
  return operation.content.match(/specialist agent for the `([a-z0-9][a-z0-9-]*)` surface at /u)?.[1] ?? null;
}

function operationOrder(operation) {
  if (ROOT_OPERATION_ORDER.has(operation.artifactId)) {
    return [0, ROOT_OPERATION_ORDER.get(operation.artifactId), 0];
  }
  const identity = adapterIdentity(operation.artifactId);
  if (!identity) throw new TypeError(`unknown operation artifactId: ${operation.artifactId}`);
  const surface = operationSurface(operation);
  if (!surface) throw new TypeError(`cannot derive canonical surface order for ${operation.artifactId}`);
  return [1, surface, ADAPTER_ORDER.get(identity.adapter)];
}

function compareOperationOrder(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function compareConflicts(left, right) {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function countPattern(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function requireOneProvenance(content, pattern, label) {
  if (countPattern(content, pattern) !== 1) {
    throw new TypeError(`${label} has invalid provenance`);
  }
}

function requireFrontmatter(content, label) {
  if (!/^---\r?\n[\s\S]+?\r?\n---\r?\n/u.test(content)) {
    throw new TypeError(`${label} has invalid adapter syntax`);
  }
}

function validateMixedContent(operation, label) {
  const markers = PROJECT_MARKERS[operation.artifactId];
  const startPattern = new RegExp(markers.start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gu');
  const endPattern = new RegExp(markers.end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gu');
  requireOneProvenance(operation.content, startPattern, label);
  requireOneProvenance(operation.content, endPattern, label);
  if (operation.content.indexOf(markers.start) > operation.content.indexOf(markers.end)) {
    throw new TypeError(`${label} has invalid provenance order`);
  }
  if (operation.artifactId === 'claude-import'
      && !/(^|\r?\n)@AGENTS\.md(?:\r?\n|$)/u.test(operation.content)) {
    throw new TypeError(`${label} has invalid adapter syntax`);
  }
}

function validateGeneratedContent(operation, expectedMarker, label) {
  const allMarkers = /steepy:generated:[^\s>]+:v[^\s>]+/gu;
  requireOneProvenance(operation.content, allMarkers, label);
  if (!operation.content.includes(expectedMarker)) {
    throw new TypeError(`${label} has invalid provenance target`);
  }
}

function decodeTomlBasicKey(body) {
  let decoded = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character !== '\\') {
      decoded += character;
      continue;
    }
    const escape = body[index + 1];
    const escapedCharacters = {
      b: '\b',
      t: '\t',
      n: '\n',
      f: '\f',
      r: '\r',
      '"': '"',
      '\\': '\\',
    };
    if (Object.hasOwn(escapedCharacters, escape)) {
      decoded += escapedCharacters[escape];
      index += 1;
      continue;
    }
    if (escape !== 'u' && escape !== 'U') return null;
    const width = escape === 'u' ? 4 : 8;
    const digits = body.slice(index + 2, index + 2 + width);
    if (digits.length !== width || !/^[a-f0-9]+$/iu.test(digits)) return null;
    const codePoint = Number.parseInt(digits, 16);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null;
    decoded += String.fromCodePoint(codePoint);
    index += width + 1;
  }
  return decoded;
}

function parseTomlAssignment(line) {
  let cursor = 0;
  while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
  let key;
  if (line[cursor] === '"' || line[cursor] === "'") {
    const quote = line[cursor];
    cursor += 1;
    let body = '';
    let closed = false;
    while (cursor < line.length) {
      const character = line[cursor];
      if (character === quote) {
        cursor += 1;
        closed = true;
        break;
      }
      if (quote === '"' && character === '\\') {
        if (cursor + 1 >= line.length) return null;
        body += `${character}${line[cursor + 1]}`;
        cursor += 2;
      } else {
        body += character;
        cursor += 1;
      }
    }
    if (!closed) return null;
    key = quote === '"' ? decodeTomlBasicKey(body) : body;
    if (key === null) return null;
  } else {
    const start = cursor;
    while (/[A-Za-z0-9_-]/u.test(line[cursor] ?? '')) cursor += 1;
    if (cursor === start) return null;
    key = line.slice(start, cursor);
  }
  while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
  if (line[cursor] !== '=') return null;
  return { key, valueStart: cursor + 1 };
}

function hasTomlMultilineClose(text, delimiter) {
  let cursor = 0;
  while ((cursor = text.indexOf(delimiter, cursor)) !== -1) {
    if (delimiter === "'''" || cursor === 0) return true;
    let backslashes = 0;
    for (let index = cursor - 1; index >= 0 && text[index] === '\\'; index -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return true;
    cursor += delimiter.length;
  }
  return false;
}

function topLevelTomlAssignmentKeys(text) {
  const keys = [];
  let multilineDelimiter = null;
  for (const line of text.split(/\r?\n/u)) {
    if (multilineDelimiter !== null) {
      if (hasTomlMultilineClose(line, multilineDelimiter)) multilineDelimiter = null;
      continue;
    }
    const assignment = parseTomlAssignment(line);
    if (assignment === null) continue;
    keys.push(assignment.key);
    const value = line.slice(assignment.valueStart).trimStart();
    const delimiter = value.startsWith('"""') ? '"""'
      : value.startsWith("'''") ? "'''" : null;
    if (delimiter !== null
        && !hasTomlMultilineClose(value.slice(delimiter.length), delimiter)) {
      multilineDelimiter = delimiter;
    }
  }
  return keys;
}

function validateOperationContract(operation, index) {
  const label = `operations[${index}]`;
  if (!PRIOR_STATES.has(operation.priorState)) {
    throw new TypeError(`${label}.priorState is invalid`);
  }
  if (operation.priorState === 'absent') {
    if (operation.priorDigest !== null || operation.kind !== 'create') {
      throw new TypeError(`${label} has incoherent absent provenance`);
    }
  } else {
    if (typeof operation.priorDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(operation.priorDigest)) {
      throw new TypeError(`${label}.priorDigest must be a SHA-256 digest`);
    }
    if (operation.kind === 'create') throw new TypeError(`${label} has incoherent replacement kind`);
  }

  if (operation.artifactId === 'project-instructions') {
    if (operation.path !== 'AGENTS.md' || !['create', 'replace-managed'].includes(operation.kind)) {
      throw new TypeError(`${label} path or kind violates project-instructions provenance`);
    }
    validateMixedContent(operation, label);
    return;
  }
  if (operation.artifactId === 'claude-import') {
    if (operation.path !== 'CLAUDE.md' || !['create', 'replace-managed'].includes(operation.kind)) {
      throw new TypeError(`${label} path or kind violates claude-import provenance`);
    }
    validateMixedContent(operation, label);
    return;
  }

  if (operation.artifactId === 'project-bootstrap') {
    const match = operation.path.match(/^\.agents\/skills\/([a-z0-9][a-z0-9-]*)-bootstrap\/SKILL\.md$/u);
    if (!match || !['create', 'replace-generated'].includes(operation.kind)) {
      throw new TypeError(`${label} path or kind violates project-bootstrap provenance`);
    }
    validateGeneratedContent(operation, `steepy:generated:${match[1]}-bootstrap:v1`, label);
    requireFrontmatter(operation.content, label);
    if (!new RegExp(`^name: ${match[1]}-bootstrap$`, 'mu').test(operation.content)) {
      throw new TypeError(`${label} has invalid adapter syntax`);
    }
    return;
  }

  if (operation.artifactId === 'claude-bootstrap-stub') {
    const match = operation.path.match(/^\.claude\/skills\/([a-z0-9][a-z0-9-]*)-bootstrap\/SKILL\.md$/u);
    if (!match || !['create', 'replace-generated'].includes(operation.kind)) {
      throw new TypeError(`${label} path or kind violates claude-bootstrap-stub provenance`);
    }
    validateGeneratedContent(operation, `steepy:generated:${match[1]}-bootstrap-stub:v1`, label);
    requireFrontmatter(operation.content, label);
    if (!new RegExp(`^name: ${match[1]}-bootstrap$`, 'mu').test(operation.content)
        || !operation.content.includes(`.agents/skills/${match[1]}-bootstrap/SKILL.md`)) {
      throw new TypeError(`${label} has incoherent bootstrap triad`);
    }
    return;
  }

  const identity = adapterIdentity(operation.artifactId);
  if (!identity) throw new TypeError(`${label} has unknown artifactId`);
  const extension = identity.adapter === 'codex' ? 'toml' : 'md';
  const expectedPath = `.${identity.adapter}/agents/${identity.agent}.${extension}`;
  if (operation.path !== expectedPath || !['create', 'replace-generated'].includes(operation.kind)) {
    throw new TypeError(`${label} path or kind violates adapter triad provenance`);
  }
  validateGeneratedContent(operation, `steepy:generated:${operation.artifactId}:v1`, label);
  if (identity.adapter === 'codex') {
    const escapedAgent = identity.agent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`^name = "${escapedAgent}"$`, 'mu').test(operation.content)
        || !/^description = "[^"\r\n]*"$/mu.test(operation.content)
        || topLevelTomlAssignmentKeys(operation.content).includes('model')
        || !/developer_instructions = """\r?\n[\s\S]+?\r?\n"""/u.test(operation.content)) {
      throw new TypeError(`${label} has invalid TOML adapter syntax`);
    }
  } else {
    requireFrontmatter(operation.content, label);
    if (!/^model: [^\r\n]+$/mu.test(operation.content)) {
      throw new TypeError(`${label} has invalid adapter syntax`);
    }
    if (identity.adapter === 'claude'
        && !new RegExp(`^name: ${identity.agent}$`, 'mu').test(operation.content)) {
      throw new TypeError(`${label} has invalid Claude adapter syntax`);
    }
    if (identity.adapter === 'opencode'
        && (!/^mode: subagent$/mu.test(operation.content)
          || !new RegExp(`^# ${identity.agent}$`, 'mu').test(operation.content))) {
      throw new TypeError(`${label} has invalid OpenCode adapter syntax`);
    }
  }
}

function canonicalConflictTarget(conflict) {
  const boundedGenerated = /^\.(agents|claude|codex|opencode)\/.+/u.test(conflict.path);
  if (conflict.artifactId === 'project-instructions') {
    return conflict.path === 'AGENTS.md' ? { kind: 'mixed', canonical: true } : null;
  }
  if (conflict.artifactId === 'claude-import') {
    return conflict.path === 'CLAUDE.md' ? { kind: 'mixed', canonical: true } : null;
  }
  if (conflict.artifactId === 'project-bootstrap') {
    if (/^\.agents\/skills\/[a-z0-9][a-z0-9-]*-bootstrap\/SKILL\.md$/u.test(conflict.path)) {
      return { kind: 'generated', canonical: true };
    }
    return boundedGenerated ? { kind: 'generated', canonical: false } : null;
  }
  if (conflict.artifactId === 'claude-bootstrap-stub') {
    if (/^\.claude\/skills\/[a-z0-9][a-z0-9-]*-bootstrap\/SKILL\.md$/u.test(conflict.path)) {
      return { kind: 'generated', canonical: true };
    }
    return boundedGenerated ? { kind: 'generated', canonical: false } : null;
  }
  const identity = adapterIdentity(conflict.artifactId);
  if (!identity) return boundedGenerated ? { kind: 'generated', canonical: false } : null;
  const extension = identity.adapter === 'codex' ? 'toml' : 'md';
  const canonicalPath = `.${identity.adapter}/agents/${identity.agent}.${extension}`;
  if (!boundedGenerated) return null;
  return { kind: 'adapter', canonical: conflict.path === canonicalPath };
}

function expectedConflictChoices(conflict, provenance) {
  if (conflict.reason === 'unmanaged-import') {
    if (conflict.artifactId !== 'claude-import' || !provenance.canonical) return null;
    return 'adopt,abort';
  }
  if (conflict.reason === 'orphan') {
    return provenance.kind === 'adapter' || (provenance.kind === 'generated' && !provenance.canonical)
      ? 'abort' : null;
  }
  if (conflict.reason === 'symlink' || conflict.reason === 'unsafe-path') {
    return provenance.canonical ? 'abort' : null;
  }
  if (conflict.reason === 'duplicate') {
    return provenance.canonical ? 'replace,abort' : 'abort';
  }
  if (conflict.reason === 'wrong-target') {
    return provenance.canonical ? 'replace,abort'
      : ['adapter', 'generated'].includes(provenance.kind) ? 'abort' : null;
  }
  if (!provenance.canonical) return null;
  if (conflict.reason === 'malformed-markers') {
    return provenance.kind === 'mixed' ? 'replace,abort' : null;
  }
  if (conflict.reason === 'surface-mismatch') {
    return provenance.canonical ? 'replace,abort' : 'abort';
  }
  if (conflict.reason === 'customized' || conflict.reason === 'unknown-version') {
    return 'replace,abort';
  }
  return null;
}

function validateConflictContract(conflicts, operationIds, operationPaths) {
  const ids = new Set();
  const paths = new Set();
  let prior = null;
  for (const [index, conflict] of conflicts.entries()) {
    const label = `conflicts[${index}]`;
    assertPlainDataObject(conflict, label);
    assertExactKeys(conflict, ['id', 'artifactId', 'path', 'reason', 'choices'], label);
    assertSlug(conflict.artifactId, `${label}.artifactId`);
    assertRelativePath(conflict.path, `${label}.path`);
    assertLine(conflict.reason, `${label}.reason`);
    if (!CONFLICT_REASONS.has(conflict.reason)) throw new TypeError(`${label}.reason is invalid`);
    if (conflict.id !== `v1:${conflict.artifactId}:${conflict.reason}`) {
      throw new TypeError(`${label}.id does not match its conflict provenance`);
    }
    const provenance = canonicalConflictTarget(conflict);
    if (!provenance) throw new TypeError(`${label} has unsupported artifact/path provenance`);
    assertPlainDataArray(conflict.choices, `${label}.choices`);
    conflict.choices.forEach((choice, choiceIndex) => assertLine(choice, `${label}.choices[${choiceIndex}]`));
    const choiceKey = conflict.choices.join(',');
    const expectedChoices = expectedConflictChoices(conflict, provenance);
    if (!expectedChoices || choiceKey !== expectedChoices) {
      throw new TypeError(`${label}.choices do not match conflict provenance`);
    }
    if (ids.has(conflict.id)) throw new TypeError(`duplicate conflict id: ${conflict.id}`);
    if (paths.has(conflict.path)) throw new TypeError(`duplicate conflict path: ${conflict.path}`);
    if (operationIds.has(`v1:op:${conflict.artifactId}`) || operationPaths.has(conflict.path)) {
      throw new TypeError(`${label} overlaps an operation`);
    }
    if (prior && compareConflicts(prior, conflict) >= 0) {
      throw new TypeError(`${label} is out of canonical order`);
    }
    ids.add(conflict.id);
    paths.add(conflict.path);
    prior = conflict;
  }
}

function validateOperationCoherence(operations) {
  const projects = new Set();
  const adapters = new Map();
  for (const operation of operations) {
    if (operation.artifactId === 'project-bootstrap') {
      projects.add(operation.path.match(/^\.agents\/skills\/([a-z0-9][a-z0-9-]*)-bootstrap\//u)[1]);
      continue;
    }
    if (operation.artifactId === 'claude-bootstrap-stub') {
      projects.add(operation.path.match(/^\.claude\/skills\/([a-z0-9][a-z0-9-]*)-bootstrap\//u)[1]);
      continue;
    }
    const projectReference = operation.content.match(/(?:use|Run) the `([a-z0-9][a-z0-9-]*)-bootstrap` skill/iu);
    if (projectReference) projects.add(projectReference[1]);

    const identity = adapterIdentity(operation.artifactId);
    if (!identity) continue;
    if (!projectReference) {
      throw new TypeError(`adapter triad project reference is missing for ${operation.artifactId}`);
    }
    let surface;
    let surfacePath;
    if (identity.adapter === 'codex') {
      const sentence = operation.content.match(/You are the ([a-z0-9][a-z0-9-]*) specialist for the ([a-z0-9][a-z0-9-]*) surface\./u);
      const pathLine = operation.content.match(/^# Surface path: ([^\r\n]+)$/mu);
      if (!sentence || sentence[1] !== identity.agent || !pathLine) {
        throw new TypeError(`adapter triad syntax is incoherent for ${operation.artifactId}`);
      }
      surface = sentence[2];
      surfacePath = pathLine[1];
    } else {
      const sentence = operation.content.match(/specialist agent for the `([a-z0-9][a-z0-9-]*)` surface at `([^`\r\n]+)`\./u);
      if (!sentence) throw new TypeError(`adapter triad syntax is incoherent for ${operation.artifactId}`);
      [surface, surfacePath] = sentence.slice(1);
    }
    assertRelativePath(surfacePath, `${operation.artifactId} surface path`);
    const coherence = `${surface}\0${surfacePath}\0${projectReference?.[1] ?? ''}`;
    const prior = adapters.get(identity.agent);
    if (prior !== undefined && prior !== coherence) {
      throw new TypeError(`adapter triad is incoherent for ${identity.agent}`);
    }
    adapters.set(identity.agent, coherence);
  }
  if (projects.size > 1) throw new TypeError('project bootstrap triad is incoherent');
}

function existingPathState(root, operation) {
  const mount = bindProjectMount(root, operation.path);
  if (mount) {
    const state = existingPathState(mount.root, { ...operation, path: mount.path });
    state.ancestors.unshift({ path: mount.logical, identity: mount.identity });
    return state;
  }
  const target = resolve(root, operation.path);
  if (target === root || !target.startsWith(`${root}${sep}`)) {
    throw new Error(`unsafe path escape for ${operation.path}`);
  }
  let cursor = root;
  const ancestors = [];
  const rootStat = lstatSync(root, { bigint: true });
  ancestors.push({ path: root, identity: statIdentity(rootStat) });
  const parentParts = operation.path.split('/').slice(0, -1);
  let missingParent = false;
  for (const part of parentParts) {
    cursor = join(cursor, part);
    if (missingParent) {
      ancestors.push({ path: cursor, identity: null });
      continue;
    }
    try {
      const stat = lstatSync(cursor, { bigint: true });
      if (stat.isSymbolicLink()) throw new Error(`symlink ancestor blocks ${operation.path}`);
      if (!stat.isDirectory()) throw new Error(`non-directory ancestor blocks ${operation.path}`);
      if (realpathSync(cursor) !== cursor) throw new Error(`physical ancestor escape blocks ${operation.path}`);
      ancestors.push({ path: cursor, identity: statIdentity(stat) });
    } catch (error) {
      if (error.code === 'ENOENT') {
        missingParent = true;
        ancestors.push({ path: cursor, identity: null });
      }
      else throw error;
    }
  }
  if (missingParent) {
    return {
      target, ancestors, exists: false, digest: null, identity: null, mode: 0o644,
    };
  }
  let stat;
  try {
    stat = lstatSync(target, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        target, ancestors, exists: false, digest: null, identity: null, mode: 0o644,
      };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`symlink target blocks ${operation.path}`);
  if (!stat.isFile()) throw new Error(`non-file target blocks ${operation.path}`);
  const bytes = readFileSync(target);
  return {
    target,
    ancestors,
    exists: true,
    digest: digest(bytes),
    identity: statIdentity(stat),
    mode: Number(stat.mode & 0o777n),
    bytes,
  };
}

function statIdentity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function expectedState(operation, state) {
  const desired = Buffer.from(operation.content, 'utf8');
  if (state.exists && state.bytes.equals(desired)) return { ...state, current: true };
  if (operation.priorState === 'absent') {
    if (state.exists) throw new Error(`target identity changed after planning: ${operation.path}`);
  } else if (!state.exists || state.digest !== operation.priorDigest) {
    throw new Error(`priorDigest changed after planning: ${operation.path}`);
  }
  return { ...state, current: false };
}

function stateFingerprint(state) {
  const ancestors = state.ancestors.map(({ path, identity }) => `${path}:${identity ?? 'missing'}`).join('|');
  return `${state.target}::${ancestors}::${state.exists ? `file:${state.identity}:${state.digest}` : 'absent'}`;
}

function assertPreflightContinuity(operation, before, after) {
  const afterAncestors = new Map(after.ancestors.map((ancestor) => [ancestor.path, ancestor.identity]));
  for (const ancestor of before.ancestors) {
    if (ancestor.identity !== null && afterAncestors.get(ancestor.path) !== ancestor.identity) {
      throw new Error(`ancestor identity changed after preflight: ${operation.path}`);
    }
  }
  if (before.exists !== after.exists
      || before.identity !== after.identity
      || before.digest !== after.digest) {
    throw new Error(`target identity changed after preflight: ${operation.path}`);
  }
}

function verifyBoundState(root, operation, bound, phase) {
  const state = expectedState(operation, existingPathState(root, operation));
  if (stateFingerprint(state) !== stateFingerprint(bound)) {
    throw new Error(`TOCTOU identity change detected ${phase}: ${operation.path}`);
  }
  return state;
}

function withBoundParent(operation, state, action) {
  const parentState = state.ancestors[state.ancestors.length - 1];
  if (!parentState || parentState.identity === null) {
    throw new Error(`parent identity is not bound for ${operation.path}`);
  }
  const savedCwd = process.cwd();
  try {
    process.chdir(parentState.path);
    const dot = lstatSync('.', { bigint: true });
    if (!dot.isDirectory() || statIdentity(dot) !== parentState.identity) {
      throw new Error(`physical parent identity changed for ${operation.path}`);
    }
    return action();
  } finally {
    process.chdir(savedCwd);
  }
}

function verifyTargetFromBoundParent(operation, state) {
  return withBoundParent(operation, state, () => {
    const name = basename(state.target);
    let pathStat;
    try {
      pathStat = lstatSync(name, { bigint: true });
    } catch (error) {
      if (error.code === 'ENOENT' && !state.exists) return;
      throw error;
    }
    if (!state.exists || pathStat.isSymbolicLink() || !pathStat.isFile()
        || statIdentity(pathStat) !== state.identity) {
      throw new Error(`target identity changed in bound parent for ${operation.path}`);
    }
    const fd = openSync(name, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || statIdentity(opened) !== state.identity
          || digest(readFileSync(fd)) !== state.digest
          || statIdentity(lstatSync(name, { bigint: true })) !== state.identity) {
        throw new Error(`target identity changed in bound parent for ${operation.path}`);
      }
    } finally {
      closeSync(fd);
    }
  });
}

function ensureSafeParents(root, operation) {
  const mount = bindProjectMount(root, operation.path);
  if (mount) return ensureSafeParents(mount.root, { ...operation, path: mount.path });
  let cursor = root;
  for (const part of operation.path.split('/').slice(0, -1)) {
    cursor = join(cursor, part);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new Error(`symlink ancestor blocks ${operation.path}`);
      if (!stat.isDirectory()) throw new Error(`non-directory ancestor blocks ${operation.path}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      mkdirSync(cursor, { mode: 0o755 });
      const created = lstatSync(cursor);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error(`unsafe ancestor created for ${operation.path}`);
      }
    }
  }
}

function siblingTempPath(target) {
  return join(dirname(target), `.${basename(target)}.steepy-project-scaffold-${process.pid}-${randomBytes(12).toString('hex')}.tmp`);
}

function stagedBytesFromBoundParent(item) {
  return withBoundParent(item.operation, item.bound, () => {
    const pathStat = lstatSync(item.temp.name, { bigint: true });
    if (!pathStat.isFile() || pathStat.isSymbolicLink()
        || statIdentity(pathStat) !== item.temp.identity) {
      throw new Error(`staged temp identity changed for ${item.operation.path}`);
    }
    const fd = openSync(item.temp.name, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd, { bigint: true });
      const bytes = readFileSync(fd);
      if (!opened.isFile() || statIdentity(opened) !== item.temp.identity
          || statIdentity(lstatSync(item.temp.name, { bigint: true })) !== item.temp.identity) {
        throw new Error(`staged temp identity changed for ${item.operation.path}`);
      }
      return bytes;
    } finally {
      closeSync(fd);
    }
  });
}

function verifyStagedTemp(root, item) {
  stagedBytesFromBoundParent(item);
}

function stageOperation(root, operation, state) {
  const temp = siblingTempPath(state.target);
  const tempName = basename(temp);
  let fd;
  try {
    verifyBoundState(root, operation, state, 'before temp creation');
    verifyTargetFromBoundParent(operation, state);
    const opened = withBoundParent(operation, state, () => {
      fd = openSync(tempName,
        FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | FS_CONSTANTS.O_NOFOLLOW,
        state.mode || 0o644);
      const openedStat = fstatSync(fd, { bigint: true });
      if (!openedStat.isFile()) throw new Error(`staged temp is not a file for ${operation.path}`);
      writeFileSync(fd, Buffer.from(operation.content, 'utf8'));
      fchmodSync(fd, state.mode || 0o644);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      return openedStat;
    });
    const item = {
      operation,
      bound: state,
      temp: { path: temp, name: tempName, identity: statIdentity(opened) },
    };
    verifyStagedTemp(root, item);
    return item.temp;
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Cleanup below still removes a materialized sibling temp when possible.
      }
    }
    try {
      withBoundParent(operation, state, () => unlinkSync(tempName));
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError;
    }
    throw error;
  }
}

function lockRecordBytes(record) {
  return `${JSON.stringify(record)}\n`;
}

function assertLockRecord(value, label) {
  assertPlainDataObject(value, label);
  assertExactKeys(value, ['schemaVersion', 'pid', 'token'], label);
  if (value.schemaVersion !== 1) throw new Error(`${label} has an unsupported schemaVersion`);
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new Error(`${label}.pid must be a positive safe integer`);
  }
  if (typeof value.token !== 'string' || !LOCK_TOKEN.test(value.token)) {
    throw new Error(`${label}.token must be 32 lowercase hexadecimal characters`);
  }
}

function readProjectScaffoldLock(path) {
  const directory = lstatSync(path, { bigint: true });
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    throw new Error('project scaffold apply lock is not a regular ownership directory');
  }
  const ownerPath = join(path, PROJECT_SCAFFOLD_LOCK_OWNER);
  const before = lstatSync(ownerPath, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error('project scaffold apply lock owner record is not a regular file');
  }
  const fd = openSync(ownerPath, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    const text = readFileSync(fd, 'utf8');
    const after = lstatSync(ownerPath, { bigint: true });
    if (!opened.isFile() || statIdentity(opened) !== statIdentity(before)
        || statIdentity(after) !== statIdentity(before)) {
      throw new Error('project scaffold apply lock owner identity changed while reading');
    }
    let record;
    try {
      record = JSON.parse(text);
    } catch (error) {
      throw new Error('project scaffold apply lock owner record is invalid JSON', { cause: error });
    }
    assertLockRecord(record, 'project scaffold apply lock owner record');
    return {
      directoryIdentity: statIdentity(directory),
      ownerIdentity: statIdentity(before),
      record,
    };
  } finally {
    closeSync(fd);
  }
}

function lockOwnerIsLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function removeProjectScaffoldLockDirectory(path, expected, { missingOk = false } = {}) {
  let observed;
  try {
    observed = readProjectScaffoldLock(path);
  } catch (error) {
    if (missingOk && error.code === 'ENOENT') return;
    throw error;
  }
  if (observed.directoryIdentity !== expected.directoryIdentity
      || observed.ownerIdentity !== expected.ownerIdentity
      || observed.record.pid !== expected.record.pid
      || observed.record.token !== expected.record.token) {
    throw new Error('project scaffold apply lock ownership changed before cleanup');
  }
  unlinkSync(join(path, PROJECT_SCAFFOLD_LOCK_OWNER));
  rmdirSync(path);
}

function prepareProjectScaffoldLock(root) {
  const token = randomBytes(16).toString('hex');
  const record = { schemaVersion: 1, pid: process.pid, token };
  const path = join(root, `${PROJECT_SCAFFOLD_LOCK}.candidate-${process.pid}-${token}`);
  mkdirSync(path, { mode: 0o700 });
  const ownerPath = join(path, PROJECT_SCAFFOLD_LOCK_OWNER);
  let fd;
  try {
    fd = openSync(ownerPath,
      FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | FS_CONSTANTS.O_NOFOLLOW,
      0o600);
    writeFileSync(fd, lockRecordBytes(record));
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    return { path, record };
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Cleanup below remains reachable. */ }
    }
    try { unlinkSync(ownerPath); } catch { /* Candidate may not contain a record yet. */ }
    try { rmdirSync(path); } catch { /* Preserve the preparation error. */ }
    throw error;
  }
}

function contentionRenameError(error) {
  return ['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes(error.code);
}

function transitionResidues(root) {
  const prefix = `${PROJECT_SCAFFOLD_LOCK}.stale-`;
  return readdirSync(root)
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(root, name));
}

function acquireProjectScaffoldLock(root) {
  const path = join(root, PROJECT_SCAFFOLD_LOCK);
  const candidate = prepareProjectScaffoldLock(root);
  const transitions = new Set();
  try {
    while (true) {
      try {
        renameSync(candidate.path, path);
        const owned = readProjectScaffoldLock(path);
        if (owned.record.pid !== candidate.record.pid || owned.record.token !== candidate.record.token) {
          throw new Error('project scaffold apply lock publication changed ownership');
        }
        for (const residue of transitionResidues(root)) transitions.add(residue);
        return { path, owned, transitions: [...transitions] };
      } catch (error) {
        if (!contentionRenameError(error)) throw error;
      }

      let observed;
      try {
        observed = readProjectScaffoldLock(path);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (lockOwnerIsLive(observed.record.pid)) {
        throw new Error('project scaffold apply lock is already held by a live owner');
      }

      const stalePath = `${path}.stale-${observed.record.token}`;
      try {
        renameSync(path, stalePath);
      } catch (error) {
        if (error.code === 'ENOENT' || contentionRenameError(error)) continue;
        throw error;
      }
      const transitioned = readProjectScaffoldLock(stalePath);
      if (transitioned.directoryIdentity !== observed.directoryIdentity
          || transitioned.ownerIdentity !== observed.ownerIdentity
          || transitioned.record.pid !== observed.record.pid
          || transitioned.record.token !== observed.record.token) {
        throw new Error('project scaffold stale-lock transition changed ownership');
      }
      transitions.add(stalePath);
    }
  } catch (error) {
    try {
      const prepared = readProjectScaffoldLock(candidate.path);
      removeProjectScaffoldLockDirectory(candidate.path, prepared);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError;
    }
    throw error;
  }
}

function releaseProjectScaffoldLock(lock) {
  const current = readProjectScaffoldLock(lock.path);
  if (current.directoryIdentity !== lock.owned.directoryIdentity
      || current.ownerIdentity !== lock.owned.ownerIdentity
      || current.record.pid !== lock.owned.record.pid
      || current.record.token !== lock.owned.record.token) {
    throw new Error('project scaffold apply lock ownership changed before release');
  }
  const retiredPath = `${lock.path}.retired-${current.record.token}`;
  renameSync(lock.path, retiredPath);
  let releaseError;
  try {
    removeProjectScaffoldLockDirectory(retiredPath, current);
  } catch (error) {
    releaseError = error;
  }
  for (const transitionPath of lock.transitions) {
    try {
      const transitioned = readProjectScaffoldLock(transitionPath);
      removeProjectScaffoldLockDirectory(transitionPath, transitioned);
    } catch (error) {
      if (error.code !== 'ENOENT' && releaseError === undefined) releaseError = error;
    }
  }
  if (releaseError !== undefined) throw releaseError;
}

function assertActiveProjectScaffoldLock(root, lease) {
  if (lease === null || typeof lease !== 'object') {
    throw new TypeError('lockLease must be an active project scaffold repository lock');
  }
  const active = ACTIVE_PROJECT_SCAFFOLD_LOCKS.get(lease);
  if (!active || active.root !== root) {
    throw new Error('lockLease is not active for this project scaffold repository');
  }
  const current = readProjectScaffoldLock(active.lock.path);
  if (current.directoryIdentity !== active.lock.owned.directoryIdentity
      || current.ownerIdentity !== active.lock.owned.ownerIdentity
      || current.record.pid !== active.lock.owned.record.pid
      || current.record.token !== active.lock.owned.record.token) {
    throw new Error('project scaffold repository lock ownership changed during transaction');
  }
}

export function withProjectScaffoldLock({ hubRoot, checkpoint, operations = [] }, action) {
  if (typeof hubRoot !== 'string' || hubRoot.length === 0) throw new TypeError('hubRoot must be a path');
  if (checkpoint !== undefined && typeof checkpoint !== 'function') {
    throw new TypeError('checkpoint must be a function');
  }
  if (!Array.isArray(operations)) throw new TypeError('operations must be an array');
  if (typeof action !== 'function') throw new TypeError('action must be a function');
  const root = realpathSync(resolve(hubRoot));
  if (!lstatSync(root).isDirectory()) throw new Error('hubRoot must resolve to a directory');
  const lock = acquireProjectScaffoldLock(root);
  const lease = Object.freeze({ schemaVersion: 1 });
  ACTIVE_PROJECT_SCAFFOLD_LOCKS.set(lease, { root, lock });
  let actionError;
  try {
    checkpoint?.({ phase: 'lock-acquired', operations });
    const result = action(lease);
    if (result && typeof result.then === 'function') {
      throw new TypeError('project scaffold repository lock action must be synchronous');
    }
    return result;
  } catch (error) {
    actionError = error;
    throw error;
  } finally {
    let releaseError;
    try {
      checkpoint?.({ phase: 'before-lock-release', operations });
    } catch (error) {
      releaseError = error;
    }
    ACTIVE_PROJECT_SCAFFOLD_LOCKS.delete(lease);
    try {
      releaseProjectScaffoldLock(lock);
    } catch (error) {
      if (releaseError === undefined) releaseError = error;
    }
    if (releaseError !== undefined) {
      if (actionError !== undefined) actionError.releaseError = releaseError;
      else throw releaseError;
    }
  }
}

function applyProjectScaffoldWithActiveLock({ root, plan, checkpoint }) {
  const preflight = plan.operations
    .map((operation) => expectedState(operation, existingPathState(root, operation)));
  if (new Set(preflight.map((state) => state.target)).size !== preflight.length) {
    throw new Error('multiple scaffold operations alias the same physical target');
  }
  const pending = plan.operations
    .map((operation, index) => ({ operation, preflight: preflight[index], bound: null, temp: null }))
    .filter(({ preflight: state }) => !state.current);
  if (pending.length === 0) return deepFreeze({ applied: 0, paths: [] });

  const temps = new Set();
  try {
    for (const { operation } of pending) ensureSafeParents(root, operation);
    const bound = plan.operations.map((operation, index) => {
      const state = expectedState(operation, existingPathState(root, operation));
      assertPreflightContinuity(operation, preflight[index], state);
      return state;
    });
    const operationIndex = new Map(plan.operations.map((operation, index) => [operation.id, index]));
    for (const item of pending) item.bound = bound[operationIndex.get(item.operation.id)];

    checkpoint?.({ phase: 'before-stage', operations: pending.map(({ operation }) => operation) });
    for (const [index, operation] of plan.operations.entries()) {
      verifyBoundState(root, operation, bound[index], 'before staging');
    }

    for (const item of pending) {
      item.temp = stageOperation(root, item.operation, item.bound);
      temps.add(item);
    }

    checkpoint?.({ phase: 'after-staging', operations: pending.map(({ operation }) => operation) });
    for (const [index, operation] of plan.operations.entries()) {
      verifyBoundState(root, operation, bound[index], 'after staging');
    }
    for (const [index, item] of pending.entries()) {
      const staged = stagedBytesFromBoundParent(item);
      if (digest(staged) !== digest(Buffer.from(item.operation.content, 'utf8'))) {
        throw new Error(`staged-set validation failed for ${item.operation.path}`);
      }
      validateOperationContract(item.operation, index);
    }

    checkpoint?.({ phase: 'before-rename', operations: pending.map(({ operation }) => operation) });
    for (const [index, operation] of plan.operations.entries()) {
      verifyBoundState(root, operation, bound[index], 'before rename phase');
    }

    const appliedPaths = [];
    for (const item of pending) {
      verifyBoundState(root, item.operation, item.bound, 'immediately before rename');
      withBoundParent(item.operation, item.bound, () => {
        const tempStat = lstatSync(item.temp.name, { bigint: true });
        if (!tempStat.isFile() || tempStat.isSymbolicLink()
            || statIdentity(tempStat) !== item.temp.identity) {
          throw new Error(`staged temp identity changed before rename for ${item.operation.path}`);
        }
        const targetName = basename(item.bound.target);
        let targetStat = null;
        try {
          targetStat = lstatSync(targetName, { bigint: true });
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if ((item.bound.exists && (!targetStat || targetStat.isSymbolicLink()
          || !targetStat.isFile() || statIdentity(targetStat) !== item.bound.identity))
          || (!item.bound.exists && targetStat !== null)) {
          throw new Error(`target identity changed before rename for ${item.operation.path}`);
        }
        renameSync(item.temp.name, targetName);
        const renamed = lstatSync(targetName, { bigint: true });
        if (!renamed.isFile() || statIdentity(renamed) !== item.temp.identity) {
          throw new Error(`renamed target identity mismatch: ${item.operation.path}`);
        }
      });
      temps.delete(item);
      appliedPaths.push(item.operation.path);
    }
    return deepFreeze({ applied: appliedPaths.length, paths: appliedPaths });
  } finally {
    for (const item of temps) {
      try {
        withBoundParent(item.operation, item.bound, () => {
          const stat = lstatSync(item.temp.name, { bigint: true });
          if (stat.isFile() && !stat.isSymbolicLink() && statIdentity(stat) === item.temp.identity) {
            unlinkSync(item.temp.name);
          }
        });
      } catch (error) {
        if (error.code !== 'ENOENT') {
          // Best-effort cleanup: retain the original apply error if there is one.
        }
      }
    }
  }
}

export function applyProjectScaffold({ hubRoot, plan, checkpoint, lockLease }) {
  if (typeof hubRoot !== 'string' || hubRoot.length === 0) throw new TypeError('hubRoot must be a path');
  if (checkpoint !== undefined && typeof checkpoint !== 'function') {
    throw new TypeError('checkpoint must be a function');
  }
  validateProjectScaffoldPlan(plan);
  if (plan.conflicts.length > 0) throw new Error('cannot apply a plan with unresolved conflicts');
  const root = realpathSync(resolve(hubRoot));
  if (!lstatSync(root).isDirectory()) throw new Error('hubRoot must resolve to a directory');
  if (plan.operations.length === 0) return deepFreeze({ applied: 0, paths: [] });
  if (lockLease !== undefined) {
    assertActiveProjectScaffoldLock(root, lockLease);
    return applyProjectScaffoldWithActiveLock({ root, plan, checkpoint });
  }
  return withProjectScaffoldLock({ hubRoot, checkpoint, operations: plan.operations }, (lease) => {
    assertActiveProjectScaffoldLock(root, lease);
    return applyProjectScaffoldWithActiveLock({ root, plan, checkpoint });
  });
}

function diagnosticText(error) {
  let message = error instanceof Error ? error.message : 'unknown error';
  message = message
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/giu, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret|cookie|env)\s*[:=]\s*)[^\s,;]+/giu, '$1[REDACTED]')
    .replace(/bearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]');
  return message.slice(0, 500);
}

function emitJsonLine(value) {
  writeSync(1, `${JSON.stringify(value)}\n`);
}

export function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        hub: { type: 'string', default: '.' },
        model: { type: 'string' },
        apply: { type: 'boolean', default: false },
      },
    }));
    if (!values.model) throw new TypeError('--model <json-file> is required');
  } catch (error) {
    process.stderr.write(`project-scaffold: ${diagnosticText(error)}\n`);
    return 1;
  }

  let plan;
  try {
    const modelBytes = readFileSync(values.model);
    const modelText = new TextDecoder('utf-8', { fatal: true }).decode(modelBytes);
    const model = JSON.parse(modelText);
    plan = planProjectScaffold({ hubRoot: values.hub, model });
    const event = {
      schemaVersion: plan.schemaVersion,
      event: 'preview',
      preview: previewProjectScaffold(plan),
      conflicts: plan.conflicts,
    };
    emitJsonLine(event);
    if (plan.conflicts.length > 0) return 1;
    if (!values.apply) return 0;
    const result = applyProjectScaffold({ hubRoot: values.hub, plan });
    emitJsonLine({ schemaVersion: plan.schemaVersion, event: 'applied', result });
    return 0;
  } catch (error) {
    process.stderr.write(`project-scaffold: ${diagnosticText(error)}\n`);
    return 1;
  }
}

export function planSpecialistScaffold({ hubRoot, surface, templatesDir = DEFAULT_TEMPLATES_DIR, repair = false }) {
  assertPlainDataObject(surface, 'surface');
  const selected = {};
  for (const key of SURFACE_KEYS) selected[key] = surface[key];
  const specialistModel = {
    projectName: surface.projectName ?? 'project',
    description: surface.description ?? '',
    devCommands: [],
    surfaces: [selected],
    resolutions: {},
  };
  const plan = planProjectScaffold({ hubRoot, model: specialistModel, templatesDir });
  const suffixes = new Set(['-claude', '-codex', '-opencode'].map((suffix) => `${surface.agent}${suffix}`));
  const operations = plan.operations.filter(({ artifactId }) => suffixes.has(artifactId));
  const conflicts = plan.conflicts.filter(({ artifactId }) => suffixes.has(artifactId));
  if (!repair && (operations.some(({ priorState }) => priorState !== 'absent') || conflicts.length > 0)) {
    throw new Error(`specialist scaffold already exists for ${surface.agent}`);
  }
  return deepFreeze({ schemaVersion: 1, operations, conflicts });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}

#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname, relative, resolve, basename, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  admitHubRoot,
  createStableReader,
  displayNativePath,
  rawPathEntersLocalArea,
} from './stable-paths.mjs';
import {
  countActiveClaudeImports,
  normalizeProjectModel,
  parseProjectInstructions,
  renderProjectArtifact,
} from './project-scaffold.mjs';

// A standard past this many lines is a candidate for the modular folder form
// (a directory of smaller files instead of one long one). This is a `warn`, not
// an `error`: it never affects the exit code (see check 8 below).
const STANDARD_WARN_LINES = 150;
const ROOT_ADMISSION = Symbol('root-admission');

// Root admission, mount binding, bounded physical reads, and local-area
// exclusion live in stable-paths.mjs; this linter only walks and judges.
function walkStableFiles(reader, directory, pred, acc = [], opts = {}) {
  const directoryState = reader.inspect(directory, { kind: 'directory' });
  if (directoryState.state !== 'present') return acc;
  let entries;
  try {
    entries = readdirSync(directoryState.physicalPath, { withFileTypes: true });
  } catch {
    reader.report(displayNativePath(directory), 'is unreadable');
    return acc;
  }
  for (const entry of entries) {
    const relativePath = [directory, entry.name].filter(Boolean).join(sep);
    if (entry.isDirectory()) {
      if (opts.skipDir && opts.skipDir(relativePath)) continue;
      walkStableFiles(reader, relativePath, pred, acc, opts);
    } else if (entry.isFile()) {
      if (pred(relativePath)) acc.push(relativePath);
    } else if (entry.isSymbolicLink() || pred(relativePath)) {
      reader.inspect(relativePath);
    }
  }
  return acc;
}

function walkProviderFiles(reader, directory, pred, acc = []) {
  return walkStableFiles(reader, directory, pred, acc, {
    skipDir: (candidate) => basename(candidate) === 'node_modules',
  });
}

function isInsideDir(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

// A routing-table row is any line starting with '|' — a cheap proxy for the routing
// table, the only table `.apex/_INDEX.md` carries. Pass this (or its negation) as
// `keepLine` to a scanner to read table rows / prose in isolation. No column-order
// contract: any link or backtick cell in a matched row counts.
const isRoutingTableRow = (line) => line.trimStart().startsWith('|');

const PORTABLE_VERSION = '1';
const GENERATED_MARKER_RE = /steepy:generated:([^:\s>]+):v([^\s>]+)/gu;

function occurrences(text, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function normalizedLf(text) {
  return text.replaceAll('\r\n', '\n');
}

function generatedMarkers(text) {
  return [...text.matchAll(GENERATED_MARKER_RE)]
    .map((match) => ({ artifactId: match[1], version: match[2] }));
}

function routingRows(indexText) {
  const rows = [];
  for (const line of indexText.split('\n')) {
    if (!isRoutingTableRow(line) || /^\s*\|\s*[-:]+/u.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 3 || cells[0].replaceAll('`', '').toLowerCase() === 'surface') continue;
    const surfaceTokens = [...cells[0].matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
    const agentTokens = [...cells[2].matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
    const standardTargets = linkTargets(cells[1]).filter((target) => target.includes('standards/'));
    rows.push({ line, surfaceTokens, agentTokens, standardTargets });
  }
  return rows;
}

function renderBootstrap(model) {
  return renderProjectArtifact('project-bootstrap', normalizedProject(model));
}

function renderBootstrapStub(model) {
  return renderProjectArtifact('claude-bootstrap-stub', normalizedProject(model));
}

function normalizedProject(model) {
  return normalizeProjectModel({
    projectName: model.projectName,
    description: model.description,
    devCommands: model.devCommands,
    surfaces: model.surfaces.map((surface) => ({ ...surface, testCmd: surface.testCmd ?? '' })),
    resolutions: {},
  });
}

function renderSurfaceAdapter(adapter, model, surface) {
  return renderProjectArtifact(`${surface.agent}-${adapter}`, normalizedProject({
    ...model,
    surfaces: [surface],
  }));
}

function classifyManaged(text, artifactId, expectedContent) {
  const related = [...text.matchAll(new RegExp(`steepy:managed:${artifactId}:v([^:\\s>]+):(start|end)`, 'gu'))];
  if (related.some((match) => match[1] !== PORTABLE_VERSION)) return { reason: 'unknown-version' };
  const start = `<!-- steepy:managed:${artifactId}:v1:start -->`;
  const end = `<!-- steepy:managed:${artifactId}:v1:end -->`;
  const starts = occurrences(text, start);
  const ends = occurrences(text, end);
  if (starts > 1 || ends > 1) return { reason: 'duplicate' };
  if (starts !== 1 || ends !== 1) return { reason: 'malformed' };
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end, startAt + start.length);
  if (endAt < startAt) return { reason: 'malformed' };
  const block = text.slice(startAt, endAt + end.length);
  const before = text.slice(0, startAt);
  const after = text.slice(endAt + end.length);
  const positionedBefore = before === '' || /(?:\r?\n){2}$/u.test(before);
  const positionedAfter = after === '' || /^(?:\r?\n)(?:$|\r?\n)/u.test(after);
  if (!positionedBefore || !positionedAfter) return { reason: 'out-of-position', block };
  if (expectedContent !== undefined && normalizedLf(block) !== expectedContent.trimEnd()) {
    return { reason: 'customized', block };
  }
  return { reason: null, block };
}

function classifyGenerated(text, expectedId, expectedContent) {
  const markers = generatedMarkers(text);
  if (markers.length > 1) return 'duplicate';
  if (markers.length === 0) return 'customized';
  if (markers[0].version !== PORTABLE_VERSION) return 'unknown-version';
  if (markers[0].artifactId !== expectedId) {
    const expectedAdapter = expectedId.match(/-(claude|codex|opencode)$/u)?.[1];
    return expectedAdapter && markers[0].artifactId.endsWith(`-${expectedAdapter}`)
      ? 'surface-mismatch'
      : 'wrong-target';
  }
  return text === expectedContent ? null : 'customized';
}

// The scaffolded owning header every routed standard carries. The single-file
// form (`Owning surface:`) and the modular-core form (`Owning path:`) share one
// shape. Returns the backtick value, or undefined when the header is absent or
// does not conform to the scaffolded shape.
function owningHeaderValue(text) {
  return text.match(/^>\s*Owning (?:surface|path):\s*`([^`]+)`/mu)?.[1];
}

function routedStandardIdentity(hubRoot, surface, target, reader) {
  const single = `standards/${surface}.md`;
  const core = `standards/${surface}/${surface}-core.md`;
  if (target !== single && target !== core) return null;
  const apexDir = join(hubRoot, '.apex');
  const standardsDir = join(apexDir, 'standards');
  const path = resolve(apexDir, target);
  if (!isInsideDir(standardsDir, path)) return null;
  const result = reader.read(join('.apex', target));
  if (result.text === undefined) return null;
  const text = result.text;
  return {
    path,
    title: text.match(/^#\s+([^\s—]+)(?:\s|$)/u)?.[1],
    ownerPath: owningHeaderValue(text),
  };
}

function preparatoryTriadState(hubRoot, indexText, generatedCandidates, candidateResults, reader) {
  const rows = routingRows(indexText);
  const generatedFiles = generatedCandidates.map((file) => ({
    file,
    path: displayNativePath(file),
    content: candidateResults.get(file)?.text,
  })).filter(({ content }) => content !== undefined && generatedMarkers(content).length > 0);
  if (generatedFiles.length === 0) return { present: false, exact: false };

  const expected = new Map();
  const triads = [];
  const seen = { surface: new Set(), agent: new Set(), standard: new Set() };
  let routingClosed = rows.length > 0;
  for (const row of rows) {
    if (row.surfaceTokens.length !== 1 || row.agentTokens.length !== 1 || row.standardTargets.length !== 1) {
      routingClosed = false;
      continue;
    }
    const [name] = row.surfaceTokens;
    const [agent] = row.agentTokens;
    const [standard] = row.standardTargets;
    for (const [key, value] of [['surface', name], ['agent', agent], ['standard', standard]]) {
      if (seen[key].has(value)) routingClosed = false;
      seen[key].add(value);
    }
    const standardIdentity = routedStandardIdentity(hubRoot, name, standard, reader);
    if (standardIdentity?.title !== name || !standardIdentity.ownerPath) {
      routingClosed = false;
      continue;
    }
    const surfacePath = standardIdentity.ownerPath;
    const surface = { name, path: surfacePath, agent, testCmd: '' };
    const model = { projectName: 'project', description: '', devCommands: [], surfaces: [surface] };
    const paths = [];
    try {
      for (const adapter of ['claude', 'codex', 'opencode']) {
        const extension = adapter === 'codex' ? 'toml' : 'md';
        const path = `.${adapter}/agents/${agent}.${extension}`;
        paths.push(path);
        expected.set(path, renderSurfaceAdapter(adapter, model, surface));
      }
    } catch {
      routingClosed = false;
      continue;
    }
    triads.push(paths);
  }

  const candidatePathsAreCanonical = generatedFiles.every(({ path }) => expected.has(path));
  const routedTriadsAreExact = triads.length === rows.length && triads.every((paths) => paths.every((path) => (
    reader.read(path).text === expected.get(path)
  )));
  const expectedCandidateCount = triads.reduce((count, paths) => count + paths.length, 0);
  return {
    present: true,
    exact: routingClosed
      && candidatePathsAreCanonical
      && routedTriadsAreExact
      && generatedFiles.length === expectedCandidateCount,
  };
}

// Supported Markdown link subset (intentional, documented scope):
//   - Inline links `[text](target)` are recognized; the target is what we resolve.
//   - http(s):// targets and pure `#fragment` anchors are ignored; a trailing
//     `#fragment` on a relative target is stripped before resolving.
//   - NOT recognized: reference-style links `[text][id]` / `[id]: url`, and images
//     `![alt](target)` are treated like ordinary links (the `](target)` matches), so
//     a missing image path surfaces as a broken link. Authors should use inline
//     relative links inside `.apex/` (the format the scaffolders generate).
// Scans only the lines kept by `keepLine` (default: all). Order-preserving and
// duplicate-keeping so each broken link is reported at its own call site. Link
// targets are matched per line, so a target never spans a newline.
function linkTargets(text, keepLine = () => true) {
  const out = [];
  const re = /\]\(([^)]+)\)/g;
  for (const line of text.split('\n')) {
    if (!keepLine(line)) continue;
    let m;
    while ((m = re.exec(line))) {
      let t = m[1].trim();
      if (/^https?:\/\//.test(t) || t.startsWith('#')) continue;
      t = t.split('#')[0];
      if (t) out.push(t);
    }
  }
  return out;
}

// Backtick `token`s from the lines kept by `keepLine` (default: all), as a Set. Used
// by the routing check so an agent must be wired into an actual routing-table row
// (`keepLine = isRoutingTableRow`), not merely name-dropped in prose.
function backtickTokens(text, keepLine = () => true) {
  const out = new Set();
  const re = /`([^`\n]+)`/g;
  for (const line of text.split('\n')) {
    if (!keepLine(line)) continue;
    let m;
    while ((m = re.exec(line))) out.add(m[1].trim());
  }
  return out;
}

// A backtick token counts as a checkable path citation by SHAPE alone — there is
// no allowlist. It must contain at least one '/' and none of the markers that
// make a token something other than a plain relative repo path: globs (`*`),
// angle-bracket/`{{ }}` placeholders, inline-code commands (whitespace, e.g.
// `node scripts/validate-hub.mjs .`), ellipses, backslashes, flags (leading
// `-`), URLs, and absolute paths (leading `/`). Excluded tokens are never
// resolved and never reported by check 9.
function isCheckablePathToken(token) {
  if (!token.includes('/')) return false;
  if (/[*<>]|\s|…|\\/u.test(token) || token.includes('{{')) return false;
  if (token.startsWith('-') || token.startsWith('/')) return false;
  if (token.startsWith('http://') || token.startsWith('https://')) return false;
  return true;
}

// The command lines of every fenced ```sh block inside a `## Testing` section
// (from the `## Testing` heading to the next `## ` heading or EOF). Other fence
// languages and lines outside any fence are skipped; an unclosed fence runs to
// the section end. Blank and `#`-comment lines are dropped. Returns [] when the
// section or any sh block is absent.
function testingShCommandLines(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === '## Testing');
  if (start === -1) return [];
  const commandLines = [];
  let fenceLang = null;
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (fenceLang === null) {
      if (trimmed.startsWith('## ')) break;
      if (trimmed.startsWith('```')) fenceLang = trimmed.slice(3).trim();
      continue;
    }
    if (trimmed.startsWith('```')) {
      fenceLang = null;
      continue;
    }
    if (fenceLang === 'sh' && trimmed !== '' && !trimmed.startsWith('#')) {
      commandLines.push(line);
    }
  }
  return commandLines;
}

// BFS over relative .md links, starting at _INDEX.md, staying inside the .apex/ subtree.
// Returns the set of resolved absolute paths reachable from the root index. Used by the
// anti-orphan check: a .apex/ markdown file is an orphan iff it is NOT in this set.
function reachableMarkdownFiles(reader, indexPath) {
  const apexRoot = resolve(reader.root, '.apex');
  const visited = new Set();
  const queue = [indexPath];
  while (queue.length) {
    const current = queue.shift();
    const result = reader.read(current);
    if (result.path && visited.has(result.path)) continue;
    if (result.path) visited.add(result.path);
    if (result.text === undefined) continue;
    const text = result.text;
    for (const target of linkTargets(text)) {
      if (!target.endsWith('.md')) continue;
      if (rawPathEntersLocalArea(dirname(current), target)) continue;
      const admitted = reader.inspect(target, { base: dirname(current) });
      if (admitted.state !== 'present') continue;
      const rel = relative(apexRoot, admitted.path);
      if (rel.startsWith('..' + sep) || rel === '..') continue; // escaped .apex/
      if (!visited.has(admitted.path)) queue.push(reader.fromAbsolute(admitted.path));
    }
  }
  return visited;
}

function validatePortableV1(hubRoot, indexText, reader) {
  const violations = [];
  const error = (msg) => violations.push({ level: 'error', msg: `portable-v1: ${msg}` });
  const rootCandidates = ['AGENTS.md', 'CLAUDE.md'];
  const generatedCandidates = ['.agents', '.claude', '.codex', '.opencode']
    .flatMap((provider) => walkProviderFiles(
      reader,
      provider,
      () => true,
    ));
  // Candidate discovery and byte access share the stable reader. Eagerly bind
  // each candidate once so an unsafe later file cannot disappear behind a
  // short-circuiting evidence/provenance query.
  const candidateResults = new Map(generatedCandidates.map((file) => [file, reader.read(file)]));
  const rootEvidenceFiles = [
    ...rootCandidates,
    ...generatedCandidates.filter((file) => {
      const path = displayNativePath(file);
      return path.startsWith('.agents/skills/') || path.startsWith('.claude/skills/');
    }),
  ];
  const rootEvidenceResults = new Map(rootEvidenceFiles.map((file) => [
    file,
    candidateResults.has(file) ? candidateResults.get(file) : reader.read(file),
  ]));
  const hasRootEvidence = rootEvidenceFiles.some((file) => (
    /steepy:(?:managed:(?:project-instructions|claude-import)|generated:[^:\s>]+):v[^\s>]+/u
      .test(rootEvidenceResults.get(file)?.text ?? '')
  ));
  const preparatory = hasRootEvidence
    ? { present: false, exact: false }
    : preparatoryTriadState(hubRoot, indexText, generatedCandidates, candidateResults, reader);
  // New-surface may prepare an exact, complete triad before project identity exists.
  // Only that whole producer-rendered set is compatible; any root/bootstrap signal
  // or any partial/drifted/mixed triad activates the ordinary closed v1 contract.
  const hasPortableEvidence = hasRootEvidence || (preparatory.present && !preparatory.exact);
  if (!hasPortableEvidence) {
    if (preparatory.exact) return [];
    const hasUnsupportedArtifacts = reader.inspect('CLAUDE.md', { reportUnsafe: false }).state !== 'missing'
      || walkProviderFiles(reader, join('.claude', 'agents'), (file) => file.endsWith('.md')).length > 0
      || walkProviderFiles(reader, join('.claude', 'skills'), (file) => basename(file) === 'SKILL.md').length > 0;
    return hasUnsupportedArtifacts
      ? [{ level: 'error', msg: 'portable-v1: unsupported project artifacts; current portable project instructions are required' }]
      : [];
  }

  const parsedRows = [];
  for (const row of routingRows(indexText)) {
    if (row.surfaceTokens.length !== 1 || row.agentTokens.length !== 1 || row.standardTargets.length !== 1) {
      error(`routing row is malformed and cannot participate in the surface bijection: ${row.line}`);
      continue;
    }
    const [surface] = row.surfaceTokens;
    const [agent] = row.agentTokens;
    const [standard] = row.standardTargets;
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(surface) || !/^[a-z0-9][a-z0-9-]*$/u.test(agent)) {
      error(`routing row has an invalid surface or agent identity: ${row.line}`);
      continue;
    }
    const standardIdentity = routedStandardIdentity(hubRoot, surface, standard, reader);
    if (!standardIdentity) {
      error(`standard mismatch for surface '${surface}': expected its single file or modular core, found ${standard}`);
    } else if (standardIdentity.title !== surface) {
      error(`standard identity mismatch for surface '${surface}' at ${standard}`);
    }
    if (standardIdentity && standard !== `standards/${surface}.md`) {
      error(`standard/adapter mismatch for surface '${surface}': routing targets ${standard}, but canonical project adapters target standards/${surface}.md`);
    }
    parsedRows.push({ surface, agent, standard });
  }
  const seen = { surface: new Set(), agent: new Set(), standard: new Set() };
  for (const row of parsedRows) {
    for (const key of Object.keys(seen)) {
      if (seen[key].has(row[key])) error(`routing collision: ${key} '${row[key]}' is not bijective`);
      seen[key].add(row[key]);
    }
  }

  let model = null;
  const agentsResult = reader.read('AGENTS.md');
  if (agentsResult.state === 'missing') {
    error('project instructions at AGENTS.md are missing');
  } else if (agentsResult.text === undefined) {
    error(`project instructions at AGENTS.md are ${agentsResult.physicalReason ?? 'unsafe'}`);
  } else if (agentsResult.text !== undefined) {
    const agentsText = agentsResult.text;
    const managed = classifyManaged(agentsText, 'project-instructions');
    if (managed.reason) {
      error(`project instructions at AGENTS.md are ${managed.reason}`);
      const start = '<!-- steepy:managed:project-instructions:v1:start -->';
      const end = '<!-- steepy:managed:project-instructions:v1:end -->';
      const startAt = agentsText.indexOf(start);
      const endAt = agentsText.indexOf(end, startAt + start.length);
      if (startAt !== -1 && endAt !== -1) {
        model = parseProjectInstructions(agentsText.slice(startAt, endAt + end.length));
      }
    } else {
      model = parseProjectInstructions(managed.block);
      if (!model) error('project instructions at AGENTS.md are customized');
    }
  }

  const claudeResult = reader.read('CLAUDE.md');
  if (claudeResult.state === 'missing') {
    error('CLAUDE.md managed import is missing');
  } else if (claudeResult.text === undefined) {
    error(`CLAUDE.md managed import is ${claudeResult.physicalReason ?? 'unsafe'}`);
  } else if (claudeResult.text !== undefined) {
    const claudeText = claudeResult.text;
    const expectedImport = [
      '<!-- steepy:managed:claude-import:v1:start -->',
      '@AGENTS.md',
      '<!-- steepy:managed:claude-import:v1:end -->',
    ].join('\n');
    const managed = classifyManaged(claudeText, 'claude-import', expectedImport);
    if (managed.reason) error(`CLAUDE.md managed import is ${managed.reason}`);
    const imports = countActiveClaudeImports(claudeText);
    if (!managed.reason && imports !== 1) error('CLAUDE.md managed import has a target collision');
  }

  if (model) {
    try {
      normalizedProject(model);
    } catch {
      error('project instructions at AGENTS.md contain an invalid project or surface identity');
      model = null;
    }
  }

  if (model) {
    const modelSurfaces = new Map();
    const modelAgents = new Set();
    for (const surface of model.surfaces) {
      if (modelSurfaces.has(surface.name) || modelAgents.has(surface.agent)) {
        error(`project instructions collision for surface '${surface.name}' or agent '${surface.agent}'`);
      }
      modelSurfaces.set(surface.name, surface);
      modelAgents.add(surface.agent);
    }
    if (model.surfaces.length !== parsedRows.length) {
      error('project instructions and routing rows have a surface cardinality mismatch');
    }
    for (const row of parsedRows) {
      const surface = modelSurfaces.get(row.surface);
      if (!surface || surface.agent !== row.agent) {
        error(`project instructions and routing mismatch for surface '${row.surface}' and agent '${row.agent}'`);
      } else {
        const owner = routedStandardIdentity(hubRoot, row.surface, row.standard, reader)?.ownerPath;
        if (owner !== undefined && owner !== surface.path) {
          error(`standard ownership mismatch for surface '${row.surface}': expected path '${surface.path}', found '${owner}'`);
        }
      }
    }

    const bootstrapArtifacts = [
      {
        label: 'canonical bootstrap',
        artifactId: `${model.projectName}-bootstrap`,
        path: `.agents/skills/${model.projectName}-bootstrap/SKILL.md`,
        content: renderBootstrap(model),
      },
      {
        label: 'Claude bootstrap stub',
        artifactId: `${model.projectName}-bootstrap-stub`,
        path: `.claude/skills/${model.projectName}-bootstrap/SKILL.md`,
        content: renderBootstrapStub(model),
      },
    ];
    for (const artifact of bootstrapArtifacts) {
      const result = reader.read(artifact.path);
      if (result.state === 'missing') {
        error(`${artifact.label} is missing at ${artifact.path}`);
        continue;
      }
      if (result.text === undefined) {
        error(`${artifact.label} at ${artifact.path} is ${result.physicalReason ?? 'unsafe'}`);
        continue;
      }
      const reason = classifyGenerated(result.text, artifact.artifactId, artifact.content);
      if (reason) error(`${artifact.label} at ${artifact.path} is ${reason}`);
    }
  } else {
    error('canonical bootstrap is missing or cannot be validated without canonical project instructions');
    error('Claude bootstrap stub is missing or cannot be validated without canonical project instructions');
  }

  const adapterRows = new Map(parsedRows.map((row) => [row.surface, row]));
  for (const surface of model?.surfaces ?? []) {
    if (!adapterRows.has(surface.name)) {
      adapterRows.set(surface.name, {
        surface: surface.name,
        agent: surface.agent,
        standard: `standards/${surface.name}.md`,
      });
    }
  }
  const expectedAdapters = new Map();
  for (const row of adapterRows.values()) {
    const modelSurface = model?.surfaces.find((surface) => surface.name === row.surface && surface.agent === row.agent);
    for (const adapter of ['claude', 'codex', 'opencode']) {
      const extension = adapter === 'codex' ? 'toml' : 'md';
      const path = `.${adapter}/agents/${row.agent}.${extension}`;
      const artifactId = `${row.agent}-${adapter}`;
      expectedAdapters.set(path, artifactId);
      const result = reader.read(path);
      if (result.state === 'missing') {
        error(`${row.agent} ${adapter} adapter is missing at ${path}`);
        continue;
      }
      if (result.text === undefined) {
        error(`${row.agent} ${adapter} adapter at ${path} is ${result.physicalReason ?? 'unsafe'}`);
        continue;
      }
      const content = result.text;
      const reason = modelSurface
        ? classifyGenerated(content, artifactId, renderSurfaceAdapter(adapter, model, modelSurface))
        : classifyGenerated(content, artifactId, normalizedLf(content));
      if (reason) error(`${row.agent} ${adapter} adapter at ${path} is ${reason}`);
    }
  }

  const expectedPathsById = new Map([...expectedAdapters].map(([path, artifactId]) => [artifactId, path]));
  if (model) {
    expectedPathsById.set(`${model.projectName}-bootstrap`, `.agents/skills/${model.projectName}-bootstrap/SKILL.md`);
    expectedPathsById.set(`${model.projectName}-bootstrap-stub`, `.claude/skills/${model.projectName}-bootstrap/SKILL.md`);
  }
  const canonicalGeneratedAncestors = new Set();
  for (const path of expectedPathsById.values()) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      canonicalGeneratedAncestors.add(parts.slice(0, index).join('/'));
    }
  }
  const provenanceCandidates = generatedCandidates.filter((file) => (
    !canonicalGeneratedAncestors.has(displayNativePath(file))
  ));
  const markerLocations = new Map();
  for (const file of provenanceCandidates) {
    const path = displayNativePath(file);
    for (const marker of generatedMarkers(candidateResults.get(file)?.text ?? '')) {
      const locations = markerLocations.get(marker.artifactId) ?? [];
      locations.push(path);
      markerLocations.set(marker.artifactId, locations);
    }
  }
  for (const [artifactId, locations] of markerLocations) {
    if (locations.length > 1) {
      error(`generated artifact '${artifactId}' has duplicate provenance at ${locations.join(', ')}`);
    }
  }
  for (const file of provenanceCandidates) {
    const path = displayNativePath(file);
    const markers = generatedMarkers(candidateResults.get(file)?.text ?? '');
    if (markers.length > 1 && !expectedPathsById.has(markers[0]?.artifactId)) {
      error(`generated artifact at ${path} has duplicate provenance`);
      continue;
    }
    for (const marker of markers) {
      const expectedPath = expectedPathsById.get(marker.artifactId);
      if (!expectedPath) {
        error(`generated artifact '${marker.artifactId}' at ${path} is orphan`);
      } else if (expectedPath !== path) {
        error(`generated artifact '${marker.artifactId}' has wrong target ${path}; expected ${expectedPath}`);
      }
    }
  }

  return violations;
}

export function collectViolations(hubRoot, opts = {}) {
  const violations = [];
  const rootAdmission = opts[ROOT_ADMISSION] ?? admitHubRoot(hubRoot);
  const reader = createStableReader(hubRoot, violations, rootAdmission);
  if (rootAdmission.state === 'unsafe') return violations;
  const admittedRoot = rootAdmission.root;
  const apexDir = join(admittedRoot, '.apex');
  const indexPath = join(apexDir, '_INDEX.md');
  const skipLocalAreaDir = (dir) => reader.inspect(dir, {
    kind: 'directory',
    reportUnsafe: false,
  }).localArea !== undefined;
  // Uninitialized repo: no .apex/ hub at all. steepy was never run here, so there is
  // nothing to validate. Stay silent (no violations) — this keeps the Stop hook a
  // no-op in every project that has not opted into steepy. An .apex/ that exists but
  // lacks _INDEX.md is a genuine error: the repo opted in but the hub is broken.
  const apexState = reader.inspect('.apex', { kind: 'directory' });
  if (apexState.state === 'missing') return [];
  if (apexState.state !== 'present') return violations;
  const indexResult = reader.read(join('.apex', '_INDEX.md'));
  if (indexResult.state === 'missing') {
    return [{ level: 'error', msg: `missing _INDEX.md at ${indexPath}` }];
  }
  if (indexResult.text === undefined) return violations;
  const indexText = indexResult.text;
  const apexMarkdownFiles = walkStableFiles(
    reader,
    '.apex',
    (file) => file.endsWith('.md'),
    [],
    { skipDir: skipLocalAreaDir },
  );
  violations.push(...validatePortableV1(admittedRoot, indexText, reader));
  const routingRowTokens = backtickTokens(indexText, isRoutingTableRow);
  const seenLocalAreaLinkViolations = new Set();
  const rejectLocalAreaLink = (fileRelative, target) => {
    const area = rawPathEntersLocalArea(dirname(fileRelative), target);
    if (!area) return false;
    const key = `${fileRelative}::${target}`;
    if (seenLocalAreaLinkViolations.has(key)) return true;
    seenLocalAreaLinkViolations.add(key);
    violations.push({
      level: 'error',
      msg: `stable docs must not link into ${area.path}: ${displayNativePath(fileRelative)} -> ${target}`,
    });
    return true;
  };

  // 1. Anti-orphan: every .apex/**/*.md (except _INDEX.md) must be REACHABLE from
  //    _INDEX.md through the .apex/ link graph (root -> sub-index -> leaf). This is a
  //    strict generalization of "linked directly from root": anything directly linked
  //    is still reachable, so previously-green hubs stay green, while per-subtree
  //    sub-indexes (decisions/_INDEX.md, notes/_INDEX.md) no longer need every leaf linked
  //    from the root.
  const reachable = reachableMarkdownFiles(reader, join('.apex', '_INDEX.md'));
  for (const fileRelative of apexMarkdownFiles) {
    const file = resolve(admittedRoot, fileRelative);
    if (file === indexPath) continue;
    if (!reachable.has(file)) {
      violations.push({ level: 'error', msg: `anti-orphan: ${displayNativePath(fileRelative)} is not linked from .apex/_INDEX.md` });
    }
  }

  // 2. Reverse routing: every agent appears as a backtick token in a routing-table
  //    ROW of _INDEX.md (not merely somewhere in prose). This ensures the agent is
  //    actually wired into the routing table, closing the prose-mention loophole.
  const agentMdFiles = walkProviderFiles(reader, join('.claude', 'agents'), (file) => file.endsWith('.md'));
  const canonicalAgentFiles = agentMdFiles.filter((file) => dirname(file) === join('.claude', 'agents'));
  const nestedAgentFiles = agentMdFiles.filter((file) => dirname(file) !== join('.claude', 'agents'));
  for (const file of nestedAgentFiles) {
    const content = reader.read(file).text;
    if (content === undefined || generatedMarkers(content).length > 0) continue;
    const name = basename(file, '.md');
    violations.push({
      level: 'error',
      msg: `routing: agent '${name}' must use canonical top-level path .claude/agents/${name}.md; found nested namesake at ${displayNativePath(file)}`,
    });
  }
  const agentNames = canonicalAgentFiles.map((file) => basename(file, '.md'));
  for (const name of agentNames) {
    if (!routingRowTokens.has(name)) {
      violations.push({ level: 'error', msg: `routing: agent '${name}' is not referenced in a routing-table row of .apex/_INDEX.md` });
    }
  }

  // 3. Forward routing: standards linked in _INDEX.md routing-table rows exist.
  //    Only routing-table rows are checked here; prose links are owned by check 4.
  const seenRoutingTargets = new Set();
  for (const target of linkTargets(indexText, isRoutingTableRow)) {
    if (rejectLocalAreaLink(join('.apex', '_INDEX.md'), target)) continue;
    if (!target.includes('standards/')) continue;
    if (seenRoutingTargets.has(target)) continue;
    seenRoutingTargets.add(target);
    if (reader.inspect(target, { base: '.apex' }).state === 'missing') {
      violations.push({ level: 'error', msg: `routing: standard referenced in _INDEX.md does not exist: ${target}` });
    }
  }

  // 4. Broken internal links anywhere in .apex/.
  //    For _INDEX.md two passes are used to close the coverage gap cleanly:
  //      Pass A (routing-table rows): skip standards/ targets owned by check 3;
  //        report all others (non-standards table-row targets). This catches broken
  //        links in table rows that check 3 ignores (e.g. skills/ghost.md).
  //      Pass B (prose / non-table lines): report all broken links. A prose link to
  //        the same standards/ target as a table row is a distinct fault and is
  //        checked here regardless of check 3's ownership.
  //    A single dedup set across both passes prevents the same target from being
  //    reported twice within the same pass category, while still allowing a target
  //    that is broken both in a table row (non-standards) and in prose to surface once.
  //    All other files: dedupe targets and check all.
  for (const file of apexMarkdownFiles) {
    const text = reader.read(file).text;
    if (text === undefined) continue;
    if (file === join('.apex', '_INDEX.md')) {
      // Pass A: routing-table-row targets — skip check-3-owned standards/ links.
      const seenTable = new Set();
      for (const target of linkTargets(text, isRoutingTableRow)) {
        if (rejectLocalAreaLink(file, target)) continue;
        if (seenRoutingTargets.has(target)) continue; // owned by check 3
        if (seenTable.has(target)) continue;
        seenTable.add(target);
        if (reader.inspect(target, { base: dirname(file), kind: 'entry' }).state === 'missing') {
          violations.push({ level: 'error', msg: `broken link: ${displayNativePath(file)} -> ${target}` });
        }
      }
      // Pass B: prose (non-table) targets — check all, dedupe within prose.
      const seenProse = new Set();
      for (const target of linkTargets(text, (l) => !isRoutingTableRow(l))) {
        if (seenProse.has(target)) continue;
        seenProse.add(target);
        if (rejectLocalAreaLink(file, target)) continue;
        if (reader.inspect(target, { base: dirname(file), kind: 'entry' }).state === 'missing') {
          violations.push({ level: 'error', msg: `broken link: ${displayNativePath(file)} -> ${target}` });
        }
      }
    } else {
      const targets = linkTargets(text);
      const seen = new Set();
      for (const target of targets) {
        if (seen.has(target)) continue;
        seen.add(target);
        if (rejectLocalAreaLink(file, target)) continue;
        if (reader.inspect(target, { base: dirname(file), kind: 'entry' }).state === 'missing') {
          violations.push({ level: 'error', msg: `broken link: ${displayNativePath(file)} -> ${target}` });
        }
      }
    }
  }

  // 5. skill -> standard references resolve.
  for (const skillFile of walkProviderFiles(reader, join('.claude', 'skills'), (file) => file.endsWith('SKILL.md'))) {
    const text = reader.read(skillFile).text;
    if (text === undefined) continue;
    for (const target of linkTargets(text)) {
      if (target.includes('standards/')) {
        const standardTarget = target.replace(/^.*standards\//, 'standards/');
        if (reader.inspect(standardTarget, { base: '.apex' }).state === 'missing') {
          violations.push({ level: 'error', msg: `skill->standard: ${displayNativePath(skillFile)} references missing ${target}` });
        }
      }
    }
  }

  // 6. Optional: single-CLAUDE rule (opt-in).
  if (opts.enforceSingleClaudeMd) {
    for (const sub of ['apps', 'libs']) {
      for (const file of walkStableFiles(reader, sub, (entry) => entry.endsWith('CLAUDE.md'))) {
        violations.push({ level: 'error', msg: `single-CLAUDE: stray CLAUDE.md at ${displayNativePath(file)}` });
      }
    }
  }

  // 7. Root project-instructions files (repo root): every relative link in both
  //    AGENTS.md and CLAUDE.md must resolve. Existence is NOT required (absence
  //    is silent) and pointing to the hub is NOT required — this keeps the wizard
  //    "skip" choice valid. http(s):// and #anchor targets are ignored, matching
  //    the .apex/ link checks. The whole file is checked, consistent with how
  //    .apex/ files are validated.
  //    Check 12 (landed in-place): AGENTS.md gains link parity with CLAUDE.md,
  //    and a CLAUDE.md stub (the managed claude-import shape, templates/
  //    claude-import.md) whose imported AGENTS.md is missing next to it errors.
  for (const rootDocName of ['AGENTS.md', 'CLAUDE.md']) {
    const rootDocResult = reader.read(rootDocName);
    if (rootDocResult.text === undefined) continue;
    const rootDocText = rootDocResult.text;
    const seenRootDocLinks = new Set();
    for (const target of linkTargets(rootDocText)) {
      if (seenRootDocLinks.has(target)) continue;
      seenRootDocLinks.add(target);
      if (reader.inspect(target, { kind: 'entry' }).state === 'missing') {
        violations.push({ level: 'error', msg: `${rootDocName} broken link: ${rootDocName} -> ${target}` });
      }
    }
    if (rootDocName === 'CLAUDE.md'
      && /^@AGENTS\.md\s*$/m.test(rootDocText)
      && reader.inspect('AGENTS.md', { reportUnsafe: false }).state === 'missing') {
      violations.push({ level: 'error', msg: 'CLAUDE.md imports @AGENTS.md but AGENTS.md is missing' });
    }
  }

  // 8. Warn (never affects exit code): a standard past STANDARD_WARN_LINES lines is
  //    a candidate for the modular folder form (a directory of smaller files).
  const standardsDir = join(apexDir, 'standards');
  for (const file of apexMarkdownFiles) {
    const absolute = resolve(admittedRoot, file);
    if (!isInsideDir(standardsDir, absolute)) continue;
    const text = reader.read(file).text;
    if (text === undefined) continue;
    // A trailing newline terminates the last line — it does not start one more.
    const lineCount = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    if (lineCount > STANDARD_WARN_LINES) {
      violations.push({
        level: 'warn',
        msg: `standard is long (${lineCount} lines) — consider the modular folder form: ${displayNativePath(file)}`,
      });
    }
  }

  // 9. Warn (never affects exit code): backtick path citations that resolve nowhere.
  //    Scans the surfaces the hub governs — stable .apex/**/*.md (work/ already
  //    skipped), root AGENTS.md / CLAUDE.md when present, and .claude/agents/*.md.
  //    A token that passes isCheckablePathToken (shape only, no allowlist) is
  //    resolved against three roots in order — repo root, the citing doc's own
  //    directory, the .apex/ root — and only a token resolving at NONE of them is
  //    a dead citation. Deduped per (file, token) like check 4's per-file targets.
  const citationFiles = [
    ...apexMarkdownFiles,
    ...['AGENTS.md', 'CLAUDE.md']
      .filter((name) => reader.inspect(name, { reportUnsafe: false }).state === 'present'),
    ...canonicalAgentFiles,
  ];
  const seenCodeAnchors = new Set();
  for (const file of citationFiles) {
    const doc = displayNativePath(file);
    const text = reader.read(file).text;
    if (text === undefined) continue;
    for (const token of backtickTokens(text)) {
      if (!isCheckablePathToken(token)) continue;
      const key = `${file}::${token}`;
      if (seenCodeAnchors.has(key)) continue;
      seenCodeAnchors.add(key);
      const resolves = rawPathEntersLocalArea('', token)
        || rawPathEntersLocalArea(dirname(file), token)
        || rawPathEntersLocalArea('.apex', token)
        || reader.inspect(token, { kind: 'entry', reportUnsafe: false }).state === 'present'
        || reader.inspect(token, { base: dirname(file), kind: 'entry', reportUnsafe: false }).state === 'present'
        || reader.inspect(token, { base: '.apex', kind: 'entry', reportUnsafe: false }).state === 'present';
      if (!resolves) {
        violations.push({ level: 'warn', msg: `code-anchor: ${doc} cites missing path: ${token}` });
      }
    }
  }

  // 10. Error (exit-affecting): a routed standard's scaffolded owning header must
  //     cite a real directory at the repo root. Scans exactly the standards the
  //     hub routes — single-file standards (top-level .apex/standards/*.md) and
  //     modular cores (.apex/standards/**/*-core.md); modular leaves are not
  //     scanned. Skip-if-absent: a standard whose header is absent or does not
  //     conform to the scaffolded shape — including an absolute value or one that
  //     escapes the repo root — is never a violation.
  for (const file of apexMarkdownFiles) {
    const absolute = resolve(admittedRoot, file);
    if (!isInsideDir(standardsDir, absolute)) continue;
    const isSingleFile = dirname(absolute) === standardsDir;
    const isCore = basename(file).endsWith('-core.md');
    if (!isSingleFile && !isCore) continue;
    const text = reader.read(file).text;
    if (text === undefined) continue;
    const value = owningHeaderValue(text);
    if (value === undefined || isAbsolute(value)) continue;
    const owningDir = resolve(admittedRoot, value);
    if (!isInsideDir(admittedRoot, owningDir)) continue;
    if (reader.inspect(value, { kind: 'directory', reportUnsafe: false }).state !== 'present') {
      violations.push({
        level: 'error',
        msg: `code-anchor: ${displayNativePath(file)} owning-surface directory does not exist: ${value}`,
      });
    }
  }

  // 11. Error (exit-affecting): a standard's Testing command must be real. For the
  //     same standards check 10 scans (top-level single files + modular cores),
  //     every fenced ```sh block inside the `## Testing` section is read line by
  //     line: each path-shaped word (isCheckablePathToken) must exist from the repo
  //     root, and every invoked npm script (`npm test`, `npm run <name>`) must
  //     exist in the repo-root package.json. Skip-if-absent throughout: no Testing
  //     section, no sh block, blank/comment lines, placeholder tokens, and a
  //     missing or unparseable package.json (non-JS repo — npm half only, the path
  //     half still applies) are never violations. Deduped per (file, token) and
  //     (file, script) like check 9.
  let npmScripts = null;
  const packageResult = reader.read('package.json');
  if (packageResult.text !== undefined) {
    try {
      const pkg = JSON.parse(packageResult.text);
      npmScripts = pkg && typeof pkg === 'object' && pkg.scripts && typeof pkg.scripts === 'object'
        ? pkg.scripts
        : {};
    } catch {
      // Safely read malformed JSON remains optional metadata for non-JS repos.
    }
  }
  const seenTestingPathTokens = new Set();
  const seenTestingScripts = new Set();
  for (const file of apexMarkdownFiles) {
    const absolute = resolve(admittedRoot, file);
    if (!isInsideDir(standardsDir, absolute)) continue;
    const isSingleFile = dirname(absolute) === standardsDir;
    const isCore = basename(file).endsWith('-core.md');
    if (!isSingleFile && !isCore) continue;
    const doc = displayNativePath(file);
    const text = reader.read(file).text;
    if (text === undefined) continue;
    for (const line of testingShCommandLines(text)) {
      for (const token of line.split(/\s+/u)) {
        if (!isCheckablePathToken(token)) continue;
        const key = `${file}::${token}`;
        if (seenTestingPathTokens.has(key)) continue;
        seenTestingPathTokens.add(key);
        if (reader.inspect(token, { kind: 'entry', reportUnsafe: false }).state !== 'present') {
          violations.push({
            level: 'error',
            msg: `code-anchor: ${doc} Testing command cites missing path: ${token}`,
          });
        }
      }
      if (npmScripts === null) continue;
      const invokedScripts = [
        ...(/\bnpm\s+test\b/u.test(line) ? ['test'] : []),
        ...[...line.matchAll(/\bnpm\s+run\s+(\S+)/gu)].map((match) => match[1]),
      ];
      for (const script of invokedScripts) {
        const key = `${file}::${script}`;
        if (seenTestingScripts.has(key)) continue;
        seenTestingScripts.add(key);
        if (!Object.hasOwn(npmScripts, script)) {
          violations.push({
            level: 'error',
            msg: `code-anchor: ${doc} Testing command references missing npm script '${script}'`,
          });
        }
      }
    }
  }

  return violations;
}

export function main(argv = process.argv.slice(2)) {
  const quiet = argv.includes('--quiet');
  const enforceSingleClaudeMd = argv.includes('--single-claude');
  const root = argv.find((a) => !a.startsWith('--')) || process.cwd();
  const rootAdmission = admitHubRoot(root);
  const all = collectViolations(root, { enforceSingleClaudeMd, [ROOT_ADMISSION]: rootAdmission });
  const errors = all.filter((v) => v.level === 'error');
  const warns = all.filter((v) => v.level === 'warn');
  if (errors.length === 0) {
    // No .apex/ hub means the repo never opted into steepy — there is genuinely
    // nothing to validate, so don't claim the doc graph is "coherent". In --quiet
    // mode (the Stop hook, which runs in every repo) stay a silent no-op regardless.
    if (!quiet) {
      console.log(
        rootAdmission.state === 'present' && existsSync(join(rootAdmission.root, '.apex'))
          ? 'steepy validate-hub: OK — doc graph is coherent'
          : 'steepy validate-hub: no .apex hub found — run /steepy-apex:init to create one'
      );
      for (const v of warns) console.warn(`  - warn: ${v.msg}`);
    }
    return 0;
  }
  console.error(`steepy validate-hub: ${errors.length} violation(s):`);
  for (const v of errors) console.error(`  - ${v.msg}`);
  if (!quiet) {
    for (const v of warns) console.warn(`  - warn: ${v.msg}`);
  }
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}

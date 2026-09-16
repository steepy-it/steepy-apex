#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function pkgManager(root) {
  if (existsSync(join(root, 'pnpm-workspace.yaml')) || existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'package.json'))) return 'npm';
  if (existsSync(join(root, 'Cargo.toml'))) return 'cargo';
  if (existsSync(join(root, 'go.mod'))) return 'go';
  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'setup.cfg'))) return 'python';
  return 'unknown';
}

// Recursively collect package dirs under `base` (relative to root). Each dir that
// holds a package.json is a package boundary: we record it and stop descending.
// Skips node_modules and dot-dirs. Backs the "packages/**" recursive glob.
function findPkgDirs(root, base) {
  if (!existsSync(join(root, base))) return [];
  const found = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const childRel = `${rel}/${e.name}`;
      if (existsSync(join(root, childRel, 'package.json'))) found.push(childRel);
      else walk(childRel);
    }
  };
  walk(base);
  return found;
}

// Glob-ish: expand workspace patterns relative to root into existing package dirs.
// Supports literals, "apps/*" (immediate children), and "packages/**"
// (recursive, >=1 level). Callers only invoke this after parser validation.
function expandWorkspaceGlobs(root, patterns) {
  const dirs = [];
  for (const pat of patterns) {
    if (pat.endsWith('/**')) {
      dirs.push(...findPkgDirs(root, pat.slice(0, -3)));
      continue;
    }
    if (pat.endsWith('/*')) {
      const base = pat.slice(0, -2);
      const baseDir = join(root, base);
      if (!existsSync(baseDir)) continue;
      for (const e of readdirSync(baseDir, { withFileTypes: true })) {
        if (e.isDirectory() && existsSync(join(baseDir, e.name, 'package.json'))) {
          dirs.push(`${base}/${e.name}`);
        }
      }
      continue;
    }
    if (existsSync(join(root, pat, 'package.json'))) dirs.push(pat);
  }
  return dirs;
}

function isYamlTokenWhitespace(char) {
  return char === ' ' || char === '\t';
}

function trimYamlTokenWhitespace(value) {
  return value.replace(/^[ \t]+|[ \t]+$/g, '');
}

function hasForbiddenRawCharacter(value) {
  return /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u0084\u0086-\u009F\uD800-\uDFFF\uFFFE\uFFFF]/u.test(value);
}

function isYamlQuoteStart(value, index) {
  return index === 0 || isYamlTokenWhitespace(value[index - 1]) || /[,\[]/.test(value[index - 1]);
}

function stripYamlComment(value) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if ((char === '"' || char === "'") && isYamlQuoteStart(value, index)) {
      quote = char;
    } else if (char === '#' && (index === 0 || isYamlTokenWhitespace(value[index - 1]))) {
      return { value: value.slice(0, index), malformed: false };
    }
  }
  return { value, malformed: quote !== null };
}

function parseYamlScalar(value) {
  const scalar = trimYamlTokenWhitespace(value);
  if (hasForbiddenRawCharacter(scalar)) return { malformed: true };
  if (!scalar) return { malformed: true };
  if (scalar[0] !== '"' && scalar[0] !== "'") {
    const nonString = /^(?:null|Null|NULL|~|true|True|TRUE|false|False|FALSE|0o[0-7]+|0x[0-9a-fA-F]+|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
    return /['"\\]|:(?:[ \t]|$)|^[# !&*{}\[\],|>@`%]|^[-?:][ \t]|^-$/.test(scalar) || nonString.test(scalar)
      ? { malformed: true }
      : { value: scalar };
  }

  const quote = scalar[0];
  let escaped = false;
  for (let index = 1; index < scalar.length; index += 1) {
    const char = scalar[index];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if (char === quote) {
      return index === scalar.length - 1
        ? ((trimYamlTokenWhitespace(scalar.slice(1, -1)).length === 0 || (quote === '"' && scalar.slice(1, -1).includes('\\')))
          ? { malformed: true }
          : { value: scalar.slice(1, -1) })
        : { malformed: true };
    }
  }
  return { malformed: true };
}

function parseFlowPackageList(value) {
  if (!value.startsWith('[') || !value.endsWith(']')) return { inconclusive: true };
  const items = [];
  let quote = null;
  let escaped = false;
  let start = 1;
  for (let index = 1; index < value.length - 1; index += 1) {
    const char = value[index];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if ((char === '"' || char === "'") && isYamlQuoteStart(value, index)) quote = char;
    else if (char === ',') {
      const item = parseYamlScalar(value.slice(start, index));
      if (item.malformed) return { inconclusive: true };
      items.push(item.value);
      start = index + 1;
    }
  }
  if (quote) return { inconclusive: true };
  const tail = value.slice(start, -1);
  if (trimYamlTokenWhitespace(tail)) {
    const item = parseYamlScalar(tail);
    if (item.malformed) return { inconclusive: true };
    items.push(item.value);
  } else if (items.length > 0) {
    return { inconclusive: true };
  }
  return { patterns: items, inconclusive: false };
}

function isSupportedWorkspacePattern(pattern) {
  return !pattern.startsWith('!')
    && !/[{}?\[\]]|[@+*!]\(/.test(pattern)
    && (!pattern.includes('*') || /^[^*]+\/\*(?:\*)?$/.test(pattern));
}

function workspacePatternResult(patterns) {
  if (patterns.some((pattern) => !isSupportedWorkspacePattern(pattern))) {
    return { inconclusive: true };
  }
  return { patterns, inconclusive: false };
}

// Read only the top-level `packages:` declaration of a pnpm-workspace.yaml.
// The bounded subset accepts a block list or one-line flow list, with simple
// quoted scalars and comments. Other YAML and glob forms are inconclusive.
function pnpmPackagePatterns(text) {
  const patterns = [];
  let state = 'root';
  let itemIndent = null;
  let foundPackages = false;
  for (const rawSourceLine of text.split('\n')) {
    const rawLine = rawSourceLine.endsWith('\r') ? rawSourceLine.slice(0, -1) : rawSourceLine;
    if (state === 'unrelated') {
      if (/^[ \t]/.test(rawLine) || /^[ \t]*(?:#.*)?$/.test(rawLine)) continue;
      state = 'root';
    }
    if ((state === 'packages-block' || rawLine.startsWith('packages:')) && hasForbiddenRawCharacter(rawLine)) {
      return { inconclusive: true };
    }
    const comment = stripYamlComment(rawLine);
    if (comment.malformed) return { inconclusive: true };
    const line = comment.value;
    if (/^[ \t]*$/.test(line)) continue;
    if (state === 'packages-block') {
      if (!/^[ \t]/.test(line)) {
        state = 'root';
      } else {
        if (/^\t/.test(line) || /^-\s/.test(line)) return { inconclusive: true };
        const item = line.match(/^( +)-[ \t]+(.+?)[ \t]*$/);
        if (!item) return { inconclusive: true };
        if (itemIndent === null) itemIndent = item[1].length;
        if (item[1].length !== itemIndent) return { inconclusive: true };
        const parsed = parseYamlScalar(item[2]);
        if (parsed.malformed) return { inconclusive: true };
        patterns.push(parsed.value);
        continue;
      }
    }
    if (state === 'after-flow') {
      if (/^[ \t]|^-[ \t]/.test(line)) return { inconclusive: true };
      state = 'root';
    }
    if (/^[ \t]/.test(line) || /^(?:[?{]|---[ \t]*$)/.test(line)) return { inconclusive: true };
    const declaration = line.match(/^packages:(?:$|[ \t]+(.*))$/);
    if (declaration) {
      if (foundPackages) return { inconclusive: true };
      foundPackages = true;
      const value = trimYamlTokenWhitespace(declaration[1] || '');
      if (!value) {
        state = 'packages-block';
        itemIndent = null;
        continue;
      }
      const parsed = parseFlowPackageList(value);
      if (parsed.inconclusive) return parsed;
      patterns.push(...parsed.patterns);
      state = 'after-flow';
      continue;
    }
    if (/^(?:packages|["']packages["'])/.test(line)) return { inconclusive: true };
    if (!/^[A-Za-z][A-Za-z0-9_-]*:(?:[ \t].*)?$/.test(line)) return { inconclusive: true };
    state = 'unrelated';
  }
  return workspacePatternResult(patterns);
}

function workspacePatterns(root) {
  const pnpm = join(root, 'pnpm-workspace.yaml');
  if (existsSync(pnpm)) {
    try {
      return pnpmPackagePatterns(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(pnpm)));
    } catch {
      return { inconclusive: true };
    }
  }
  const pkg = readJson(join(root, 'package.json'));
  if (pkg && pkg.workspaces) {
    return {
      patterns: Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages || [],
      inconclusive: false,
    };
  }
  return { patterns: [], inconclusive: false };
}

function surfaceFromPkgDir(root, relPath) {
  const pkg = readJson(join(root, relPath, 'package.json')) || {};
  const s = pkg.scripts || {};
  return {
    name: pkg.name ? pkg.name.replace(/^@[^/]+\//, '') : relPath.split('/').pop(),
    path: relPath,
    test: s.test || null,
    lint: s.lint || null,
    build: s.build || null,
  };
}

export function detectStack(repoRoot) {
  const root = resolve(repoRoot);
  const packageManager = pkgManager(root);
  const workspace = workspacePatterns(root);
  if (workspace.inconclusive) {
    return { packageManager, monorepo: false, surfaces: [], inconclusive: true };
  }
  const { patterns } = workspace;
  const monorepo = patterns.length > 0;

  let surfaces = [];
  if (monorepo) {
    surfaces = expandWorkspaceGlobs(root, patterns).map((d) => surfaceFromPkgDir(root, d));
  } else if (existsSync(join(root, 'package.json'))) {
    surfaces = [surfaceFromPkgDir(root, '.')];
    surfaces[0].name = surfaces[0].name === '.' ? 'app' : surfaces[0].name;
  }
  return { packageManager, monorepo, surfaces, inconclusive: false };
}

function main() {
  const root = process.argv[2] || process.cwd();
  console.log(JSON.stringify(detectStack(root), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

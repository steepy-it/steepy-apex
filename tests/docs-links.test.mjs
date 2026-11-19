import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const repoUrl = /^https:\/\/github\.com\/steepy-it\/steepy-apex\/(?:blob|tree)\/main\/([^#?]+)/;

// The public docs: every Markdown file at the repository root plus everything under docs/.
function docFiles() {
  const rootDocs = readdirSync(root)
    .filter((name) => name.endsWith('.md') && statSync(join(root, name)).isFile());
  const walk = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith('.md') ? [path] : [];
  });
  return [...rootDocs, ...walk('docs')].sort();
}

// Lines outside fenced code blocks, with their 1-based line numbers.
function proseLines(text) {
  const lines = [];
  let fence = null;
  text.split('\n').forEach((line, index) => {
    const marker = line.match(/^\s*(```|~~~)/)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      return;
    }
    if (fence === null) lines.push({ line, number: index + 1 });
  });
  return lines;
}

// GitHub's heading anchor: lowercase, punctuation dropped, each space becomes a hyphen.
function githubSlug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-');
}

const anchorCache = new Map();
function anchorsOf(file) {
  if (!anchorCache.has(file)) {
    const seen = new Map();
    const anchors = new Set();
    for (const { line } of proseLines(readFileSync(file, 'utf8'))) {
      const heading = line.match(/^#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/)?.[1];
      if (heading === undefined) continue;
      const slug = githubSlug(heading.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      anchors.add(count === 0 ? slug : `${slug}-${count}`);
    }
    anchorCache.set(file, anchors);
  }
  return anchorCache.get(file);
}

function collectLinks() {
  const links = [];
  for (const doc of docFiles()) {
    for (const { line, number } of proseLines(readFileSync(join(root, doc), 'utf8'))) {
      const prose = line.replace(/`[^`]*`/g, '');
      for (const match of prose.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
        links.push({ doc, number, target: match[1] });
      }
    }
  }
  return links;
}

test('githubSlug matches the anchors GitHub renders for this repository\'s headings', () => {
  assert.equal(githubSlug('`scripts/` — the engine'), 'scripts--the-engine');
  assert.equal(githubSlug('Native capability matrix — 2026-08-19, steepy-apex v0.8.5'),
    'native-capability-matrix--2026-08-19-steepy-apex-v085');
  assert.equal(githubSlug('Gear 3: the workflow chain'), 'gear-3-the-workflow-chain');
  assert.equal(githubSlug('What `init` adds to your repository'), 'what-init-adds-to-your-repository');
  assert.equal(githubSlug('Attempt evidence, status stream and resume inputs'),
    'attempt-evidence-status-stream-and-resume-inputs');
});

test('every relative link and anchor in the public docs resolves', () => {
  const links = collectLinks();
  assert.ok(links.length > 40, `expected the docs to carry more than 40 links, found ${links.length}`);

  const failures = [];
  for (const { doc, number, target } of links) {
    const where = `${doc}:${number} -> ${target}`;
    const own = target.match(repoUrl);
    if (own) {
      if (!existsSync(join(root, decodeURIComponent(own[1])))) failures.push(`missing repository file: ${where}`);
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;

    const [path, fragment] = target.split('#', 2);
    const file = path === '' ? join(root, doc) : resolve(root, dirname(doc), decodeURIComponent(path));
    if (relative(root, file).startsWith('..')) {
      failures.push(`link leaves the repository: ${where}`);
      continue;
    }
    if (!existsSync(file)) {
      failures.push(`missing file: ${where}`);
      continue;
    }
    if (fragment && file.endsWith('.md') && !anchorsOf(file).has(fragment)) {
      failures.push(`missing heading anchor: ${where}`);
    }
  }
  assert.deepEqual(failures, []);
});

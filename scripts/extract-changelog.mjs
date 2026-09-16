#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'steepy extract-changelog: usage: node scripts/extract-changelog.mjs <X.Y.Z> [changelog-path]';

// Semver-ish, with an optional pre-release suffix (e.g. 0.2.0-rc1) — CHANGELOG.md
// section headings may carry one and extraction must not confuse them with the
// bare release (see extractSection's exact-match note below).
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

// A "## v<token>" heading line, optionally followed by whitespace and a "(...)" date
// suffix. The non-greedy token capture only stops at a real whitespace/EOL boundary
// (backtracking through internal dots/dashes as needed), so the captured token is
// always the FULL version string on the heading — comparing it with `===` against the
// requested version is therefore an exact match, never a prefix match. This is what
// keeps `0.2.0` from matching a `## v0.2.0-rc1` or `## v0.20.0` heading.
const HEADING_RE = /^##\s+v(\S+?)(?:\s*\(.*\))?\s*$/;

// Any "## " heading line — the boundary that ends a section (the next section of any
// kind, not just a version-shaped one). Deliberately requires the space after "##", so
// a "### " sub-heading is never mistaken for a section boundary.
const NEXT_HEADING_RE = /^##\s/;

// Pure: find the `## v<version>` section in `markdown` and return its body (everything
// after the heading line, up to the next `## ` heading or EOF), trimmed of leading and
// trailing blank lines. Returns null when no exact-version heading is found.
export function extractSection(markdown, version) {
  const lines = markdown.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADING_RE);
    if (m && m[1] === version) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (NEXT_HEADING_RE.test(lines[i])) {
      endIdx = i;
      break;
    }
  }

  const body = lines.slice(startIdx + 1, endIdx);
  let from = 0;
  let to = body.length;
  while (from < to && body[from].trim() === '') from++;
  while (to > from && body[to - 1].trim() === '') to--;
  return body.slice(from, to).join('\n');
}

// Thin CLI: `node scripts/extract-changelog.mjs <X.Y.Z> [changelog-path]`. Returns the
// process exit code rather than exiting itself, so tests can call it directly.
export function main(argv = process.argv.slice(2)) {
  const [version, changelogPath = join(process.cwd(), 'CHANGELOG.md')] = argv;

  if (!version) {
    console.error(USAGE);
    return 1;
  }
  if (!VERSION_RE.test(version)) {
    console.error(`steepy extract-changelog: invalid version: ${version}`);
    return 1;
  }

  let markdown;
  try {
    markdown = readFileSync(changelogPath, 'utf8');
  } catch (err) {
    console.error(`steepy extract-changelog: cannot read ${changelogPath}: ${err.message}`);
    return 1;
  }

  const body = extractSection(markdown, version);
  if (body === null) {
    console.error(`steepy extract-changelog: no "## v${version}" section found in ${changelogPath}`);
    return 1;
  }

  console.log(body);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}

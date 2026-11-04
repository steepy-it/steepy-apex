// Shared skill readers for doc-content-lock suites. This is not a `*.test.mjs` file, so
// `npm test` (`node --test tests/*.test.mjs`) never runs it on its own.
//
// A split skill keeps its standing rules in SKILL.md, the only file meant to stay in context for
// a whole run, and moves step detail into co-located step files that its `## Procedure` step map
// names. Content locks read the whole skill through `skillText`; rules that must survive context
// compaction are locked against `skillHead` alone.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sectionBetween } from './markdown.mjs';

export const skillsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');

// Largest SKILL.md, in bytes, that stays inside what a harness re-attaches after a context
// compaction (Claude Code keeps the first 5,000 tokens; this prose measures about 2.8 bytes per
// token, so 12,000 bytes leaves room for the harness framing).
export const SKILL_HEAD_CEILING_BYTES = 12_000;

// The canonical re-read rule every split SKILL.md carries in its step map section.
export const STEP_FILE_RULE =
  'Only this SKILL.md is meant to stay in context for the whole run; a context compaction can drop\n' +
  'the step files you read earlier. Before you act on a step, its file must be fully in view. If it is\n' +
  'not — after a compaction, on resume, or when only a summary of it remains — re-read it from this\n' +
  "skill's base directory first. Never act on a summary of a step file.";

export function skillHead(name) {
  return readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
}

// The co-located Markdown file names a text cites in backticks, in order of mention.
export function markdownFileRefs(text) {
  return [...text.matchAll(/`([a-z0-9-]+\.md)`/g)].map((match) => match[1]);
}

// The step files named by the step-map table in SKILL.md's `## Procedure` section, in table order.
// An unsplit skill has no step map and returns an empty list.
export function stepFiles(name) {
  const head = skillHead(name);
  if (!head.includes('\n## Procedure\n')) return [];
  const files = [];
  for (const line of sectionBetween(head, '\n## Procedure\n', '\n## ').split('\n')) {
    if (!line.startsWith('|')) continue;
    const [file] = markdownFileRefs(line);
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}

// The files `skillFile(name, file)` reads, each as [file name, text]. `SKILL.md` expands to itself
// and its step files, so a failure message can name the file that holds the text.
export function skillFileParts(name, file) {
  const files = file === 'SKILL.md' ? ['SKILL.md', ...stepFiles(name)] : [file];
  return files.map((each) => [each, readFileSync(join(skillsDir, name, each), 'utf8')]);
}

// The whole skill in reading order: SKILL.md, then each step file in step-map order.
export function skillText(name) {
  return skillFileParts(name, 'SKILL.md').map(([, text]) => text).join('\n');
}

// One file of a skill, where `SKILL.md` stands for the whole split skill (`skillText`).
export function skillFile(name, file) {
  return file === 'SKILL.md' ? skillText(name) : readFileSync(join(skillsDir, name, file), 'utf8');
}

// The `file:line` that holds line `index` (0-based) of `skillText(name)`, for failure messages.
// The joining newline makes the whole skill's lines each file's lines laid end to end.
export function skillLine(name, index) {
  let rest = index;
  for (const [file, text] of skillFileParts(name, 'SKILL.md')) {
    const count = text.split('\n').length;
    if (rest < count) return `${file}:${rest + 1}`;
    rest -= count;
  }
  throw new RangeError(`${name} has no line ${index + 1}`);
}

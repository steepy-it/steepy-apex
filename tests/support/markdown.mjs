// Shared Markdown helpers for doc-content-lock suites. This is not a `*.test.mjs` file, so
// `npm test` (`node --test tests/*.test.mjs`) never runs it on its own.
//
// `sectionBetween` has the same semantics as the copies in tests/discovery-skill.test.mjs and
// tests/workflow-skills.test.mjs; new suites import it from here instead of adding another copy.
import assert from 'node:assert/strict';

// The text from the first `startHeading` up to (not including) the next `endHeading` after it.
// A missing start fails the calling test; a missing or omitted end slices to the end of the text.
export function sectionBetween(text, startHeading, endHeading) {
  const s = text.indexOf(startHeading);
  assert.ok(s !== -1, `missing heading '${startHeading}'`);
  const e = endHeading ? text.indexOf(endHeading, s + startHeading.length) : -1;
  return e === -1 ? text.slice(s) : text.slice(s, e);
}

// The body of the leading `---\n…\n---` frontmatter block, or null when the text has none.
export function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : null;
}

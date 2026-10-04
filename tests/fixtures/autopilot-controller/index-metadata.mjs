// The canonical Gear-3 task-result index check that `final-review-prompt.md`
// asks a strict reviewer to apply, shared by the fresh and recovery controller
// suites: the five-field workflow header, then exactly the `source-spec`,
// `criteria`, and `branch-diff` metadata lines, each naming a file present in
// the run, with the criteria artifact attributed to the named spec.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CANONICAL = /^<!-- steepy-workflow: v1\nphase: implement\nstatus: (?:DRAFT|READY|CONSUMED)\nnext: (?:review|none)\nsource: (\S+)\nconsumed-by: \S+\n-->\nsource-spec: (\S+)\ncriteria: (\S+)\nbranch-diff: (\S+)\n/;

export function assertCanonicalIndexMetadata(root, indexPath, text) {
  const match = CANONICAL.exec(text);
  assert.ok(match, `${indexPath} must open with the workflow header and then exactly the source-spec, criteria, and branch-diff metadata lines:\n${text.slice(0, 400)}`);
  const [, plan, sourceSpec, criteria, branchDiff] = match;
  const dir = dirname(indexPath);
  assert.match(sourceSpec, /^\.apex\/work\/specs\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/, 'source-spec names a canonical spec');
  assert.equal(criteria, `${dir}/success-criteria.md`, 'criteria is the run\'s canonical sibling');
  assert.equal(branchDiff, `${dir}/branch-diff.txt`, 'branch-diff is the run\'s canonical sibling');
  for (const path of [plan, sourceSpec, criteria, branchDiff]) {
    assert.ok(existsSync(join(root, path)) && statSync(join(root, path)).isFile(), `${path} must exist in the run`);
  }
  assert.ok(readFileSync(join(root, criteria), 'utf8').includes(`Source: \`${sourceSpec}\`\nHeading: \`## Success criteria\`\n`),
    'the criteria artifact is attributed to the source-spec metadata');
  return { plan, sourceSpec, criteria, branchDiff };
}

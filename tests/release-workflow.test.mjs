import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function readWorkflow(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

test('release.yml: triggers on push to main and defaults to contents: read', () => {
  const workflow = readWorkflow('.github/workflows/release.yml');

  assert.match(workflow, /^name:\s*Release\s*$/m);
  assert.match(workflow, /on:\s*\n\s*push:\s*\n\s*branches:\s*\[main\]/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
});

test('release.yml: invokes the reusable validation without mandatory release audit evidence', () => {
  const workflow = readWorkflow('.github/workflows/release.yml');

  assert.match(workflow, /validation:\s*\n\s*uses:\s*\.\/\.github\/workflows\/validate\.yml/);
  assert.doesNotMatch(workflow, /require-release-evidence/);
});

test('release.yml: publishing explicitly needs successful validation and alone grants write', () => {
  const workflow = readWorkflow('.github/workflows/release.yml');

  assert.match(workflow, /publish:\s*\n\s*needs:\s*validation/);
  assert.match(workflow, /if:\s*needs\.validation\.result == 'success'/);
  assert.match(workflow, /publish:[\s\S]*?permissions:\s*\n\s*contents:\s*write/);
  assert.equal((workflow.match(/contents:\s*write/g) ?? []).length, 1);
});

test('release.yml: checks out full history and reads the version from plugin.json via node', () => {
  const workflow = readWorkflow('.github/workflows/release.yml');

  assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.ok(
    workflow.includes("require('./.claude-plugin/plugin.json').version"),
    'release.yml must read the version out of .claude-plugin/plugin.json via node, not grep/sed',
  );
});

test('release.yml: is idempotent — checks whether the v<version> tag already exists', () => {
  const workflow = readWorkflow('.github/workflows/release.yml');

  assert.match(workflow, /git fetch --tags/);
  assert.match(workflow, /git rev-parse -q --verify "refs\/tags\/v\$V"/);
});

test('release.yml: creates and pushes the v-prefixed tag on $GITHUB_SHA', () => {
  const workflow = readWorkflow('.github/workflows/release.yml');

  assert.match(workflow, /git tag "\$TAG" "\$GITHUB_SHA"/);
  assert.match(workflow, /git push origin "\$TAG"/);
});

test('release.yml: creates the GitHub Release from extract-changelog.mjs output, with GH_TOKEN', () => {
  const workflow = readWorkflow('.github/workflows/release.yml');

  assert.ok(
    workflow.includes('scripts/extract-changelog.mjs'),
    'release.yml must call extract-changelog.mjs for the release body',
  );
  assert.match(workflow, /gh release create "\$TAG" --title "\$TAG" --notes-file/);
  assert.match(workflow, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
});

test('release.yml: tag creation and Release creation are independently idempotent (stranded-tag recovery)', () => {
  const workflow = readWorkflow('.github/workflows/release.yml');

  // Two separate steps, not one combined step gated only on tag existence — a tag
  // can exist without a Release (e.g. a prior run pushed the tag then failed before
  // publishing); gating everything on tag existence would strand that version
  // forever with no way to recover on a later run.
  assert.match(
    workflow,
    /name:\s*Create tag\s*\n\s*if:\s*steps\.tag_check\.outputs\.exists == 'false'/,
  );
  assert.match(workflow, /name:\s*Create GitHub Release/);

  // The Release step checks for an existing Release independently of the tag check,
  // so a tag-exists-but-no-release run still creates the Release on a later run.
  assert.match(workflow, /gh release view "\$TAG"/);
});

test('release.yml: falls back to a stock release body when changelog extraction fails', () => {
  const workflow = readWorkflow('.github/workflows/release.yml');

  // The release must never fail for a missing prose section: the fallback text sits
  // on the failure branch of the extract-changelog.mjs call.
  assert.match(workflow, /if node scripts\/extract-changelog\.mjs "\$V" > "\$NOTES_FILE"[\s\S]*?else[\s\S]*?see CHANGELOG\.md/);
});

test('version-gate.yml: dedicated workflow (not a job in ci.yml), reacts to label toggles on PRs', () => {
  const workflow = readWorkflow('.github/workflows/version-gate.yml');

  assert.match(workflow, /^name:\s*Version gate\s*$/m);
  assert.match(
    workflow,
    /pull_request:\s*\n\s*types:\s*\[opened, synchronize, reopened, labeled, unlabeled\]/,
  );
});

test('version-gate.yml: passes when the PR carries the no-release label', () => {
  const workflow = readWorkflow('.github/workflows/version-gate.yml');

  assert.ok(workflow.includes('no-release'), 'version-gate.yml must reference the no-release label');
  assert.match(
    workflow,
    /contains\(github\.event\.pull_request\.labels\.\*\.name, 'no-release'\)/,
  );
});

test('version-gate.yml: compares .claude-plugin/plugin.json versions between the PR and main', () => {
  const workflow = readWorkflow('.github/workflows/version-gate.yml');

  assert.match(workflow, /git fetch origin main/);
  assert.ok(
    workflow.includes('git show FETCH_HEAD:.claude-plugin/plugin.json'),
    "version-gate.yml must read main's version via git show FETCH_HEAD:.claude-plugin/plugin.json",
  );
  assert.match(workflow, /scripts\/version-policy\.mjs/);
  assert.match(workflow, /validateVersionTransition/);
  assert.match(workflow, /scripts\/bump-version\.mjs/);
});

test('version-gate.yml: no-release skips only increment while retaining validity/downgrade checks', () => {
  const workflow = readWorkflow('.github/workflows/version-gate.yml');

  assert.doesNotMatch(workflow, /if:\s*\$\{\{\s*!contains\(/);
  assert.match(workflow, /NO_RELEASE:/);
  assert.match(workflow, /requireIncrement:\s*process\.env\.NO_RELEASE !== 'true'/);
});

test('version-gate.yml is a standalone workflow file, not a job appended to ci.yml', () => {
  const ci = readWorkflow('.github/workflows/ci.yml');

  assert.doesNotMatch(ci, /version-gate/i);
  assert.doesNotMatch(ci, /no-release/);
});

test('validate.yml: reusable Node 24 test, coherence, package, and product checks', () => {
  const workflow = readWorkflow('.github/workflows/validate.yml');

  assert.match(workflow, /workflow_call:/);
  assert.doesNotMatch(workflow, /require-release-evidence:/);
  assert.match(workflow, /node-version:\s*\['24'\]/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /node scripts\/validate-hub\.mjs \./);
  assert.match(workflow, /npm pack --dry-run --json/);
  assert.match(workflow, /node scripts\/bump-version\.mjs --check/);
  assert.match(workflow, /node scripts\/validate-release-evidence\.mjs --product-only/);
  assert.doesNotMatch(workflow, /node scripts\/validate-release-evidence\.mjs\s*$/m);
  assert.doesNotMatch(workflow, /\b(?:claude|codex|opencode|pi|dsh)\s+(?:exec|run|--print|plugin)/);
});

test('validate.yml: publication checks do not consume release audit evidence files', () => {
  const workflow = readWorkflow('.github/workflows/validate.yml');
  assert.doesNotMatch(workflow, /native-test-evidence|^  release-evidence:/m);
});

test('ci.yml invokes reusable validation without requiring unavailable live evidence', () => {
  const workflow = readWorkflow('.github/workflows/ci.yml');

  assert.match(workflow, /uses:\s*\.\/\.github\/workflows\/validate\.yml/);
  assert.doesNotMatch(workflow, /require-release-evidence:\s*true/);
});

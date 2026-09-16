// Suite for scripts/verify-model-mappings.mjs — the model-mapping freshness
// verifier. Pure-function tests run fixture text through the exported
// catalog-text→verdicts and verdicts→patch logic (no network, no subprocess);
// CLI tests drive the real main(argv) via spawnSync using --catalog-file /
// --source-file fixture injection, so the whole suite stays hermetic — live
// verification (`opencode models`, provenance fetches) is a RELEASE canary act.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verdictsFromCatalog,
  verdictsFromSource,
  renderPatch,
} from '../scripts/verify-model-mappings.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures', 'model-mappings');
const scriptPath = join(here, '..', 'scripts', 'verify-model-mappings.mjs');
const fixture = (name) => readFileSync(join(fixturesDir, name), 'utf8');

const runCli = (args) => spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });

test('catalog verdicts: OK snapshot confirms every configured row with evidence', () => {
  const verdicts = verdictsFromCatalog(fixture('opencode-catalog-ok.txt'));
  assert.equal(verdicts.length, 12);
  assert.ok(verdicts.every((v) => v.verdict === 'OK'), JSON.stringify(verdicts));
  const zaiStd = verdicts.find((v) => v.provider === 'zai-coding-plan' && v.tier === 'standard');
  assert.equal(zaiStd.configured, 'zai-coding-plan/glm-5.3-highspeed');
  assert.equal(zaiStd.observed, 'zai-coding-plan/glm-5.3-highspeed');
  assert.ok(zaiStd.evidence.includes('zai-coding-plan/glm-5.3-highspeed'));
});

test('catalog verdicts: drifted zai standard id is STALE with the observed replacement', () => {
  const verdicts = verdictsFromCatalog(fixture('opencode-catalog-drifted.txt'));
  const stale = verdicts.filter((v) => v.verdict === 'STALE');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].provider, 'zai-coding-plan');
  assert.equal(stale[0].tier, 'standard');
  assert.equal(stale[0].configured, 'zai-coding-plan/glm-5.3-highspeed');
  assert.equal(stale[0].proposedModel, 'zai-coding-plan/glm-5.3.5-highspeed');
  assert.ok(stale[0].evidence.includes('zai-coding-plan/glm-5.3.5-highspeed'));
  assert.equal(verdicts.filter((v) => v.verdict === 'OK').length, 11);
});

test('catalog verdicts: two stale zai tiers (standard and most-capable) are both STALE', () => {
  const verdicts = verdictsFromCatalog(fixture('opencode-catalog-two-stale.txt'));
  const stale = verdicts.filter((v) => v.verdict === 'STALE');
  assert.equal(stale.length, 2);
  // Sort by tier to ensure stable order for assertion
  stale.sort((a, b) => a.tier.localeCompare(b.tier));
  assert.equal(stale[0].provider, 'zai-coding-plan');
  assert.equal(stale[0].tier, 'most-capable');
  assert.equal(stale[0].configured, 'zai-coding-plan/glm-5.3');
  assert.equal(stale[0].proposedModel, 'zai-coding-plan/glm-5.3.5');
  assert.ok(stale[0].evidence.includes('zai-coding-plan/glm-5.3.5'));
  assert.equal(stale[1].provider, 'zai-coding-plan');
  assert.equal(stale[1].tier, 'standard');
  assert.equal(stale[1].configured, 'zai-coding-plan/glm-5.3-highspeed');
  assert.equal(stale[1].proposedModel, 'zai-coding-plan/glm-5.3.5-highspeed');
  assert.ok(stale[1].evidence.includes('zai-coding-plan/glm-5.3.5-highspeed'));
  assert.equal(verdicts.filter((v) => v.verdict === 'OK').length, 10);
});

test('CLI: two stale tiers catalog exits 1 and consolidates both into one provider patch block', () => {
  // NOTE: when multiple tiers of one provider are STALE simultaneously, renderPatch
  // consolidates both stale tiers into a single provider block (both proposed ids appear
  // in one patch). Recorded behavior, NOT a contractual guarantee — proposal output may
  // be refined in future versions. This test documents the current state, not a design
  // constraint.
  const tdir = mkdtempSync(join(tmpdir(), 'steepy-verify-model-mappings-'));
  try {
    const catalogPath = join(tdir, 'catalog.txt');
    writeFileSync(catalogPath, fixture('opencode-catalog-two-stale.txt'));
    const run = runCli(['--harness', 'opencode', '--catalog-file', catalogPath]);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stdout, /STALE/);
    assert.match(run.stdout, /zai-coding-plan\/glm-5\.3\.5-highspeed/);
    assert.match(run.stdout, /-> zai-coding-plan\/glm-5\.3\.5\b/);
    assert.match(run.stdout, /NOT applied|human-ratified/);
  } finally {
    rmSync(tdir, { recursive: true, force: true });
  }
});

test('catalog verdicts: provider absent from the catalog is UNKNOWN (no evidence)', () => {
  const verdicts = verdictsFromCatalog(fixture('opencode-catalog-provider-absent.txt'));
  const zai = verdicts.filter((v) => v.provider === 'zai-coding-plan');
  assert.equal(zai.length, 3);
  assert.ok(zai.every((v) => v.verdict === 'UNKNOWN' && v.evidence === null));
  assert.ok(verdicts.filter((v) => v.provider !== 'zai-coding-plan').every((v) => v.verdict === 'OK'));
});

test('source verdicts: codex openai guide snapshot confirms the aliased ids', () => {
  const verdicts = verdictsFromSource(fixture('codex-openai-source-ok.md'), 'openai');
  assert.equal(verdicts.length, 3);
  assert.ok(verdicts.every((v) => v.verdict === 'OK'), JSON.stringify(verdicts));
  const sol = verdicts.find((v) => v.tier === 'most-capable');
  assert.equal(sol.alias, 'gpt-5.6-sol');
  assert.ok(sol.evidence.includes('gpt-5.6-sol'));
});

test('source verdicts: drifted openai most-capable alias is STALE with a prefixed proposal', () => {
  const verdicts = verdictsFromSource(fixture('codex-openai-source-drift.md'), 'openai');
  const stale = verdicts.filter((v) => v.verdict === 'STALE');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].tier, 'most-capable');
  assert.equal(stale[0].configured, 'openai/gpt-5.6-sol');
  assert.equal(stale[0].observed, 'gpt-5.7-sol');
  assert.equal(stale[0].proposedModel, 'openai/gpt-5.7-sol');
  assert.equal(verdicts.filter((v) => v.verdict === 'OK').length, 2);
});

test('source verdicts: a loaded page with no family ids yields UNKNOWN, not STALE', () => {
  const verdicts = verdictsFromSource(fixture('claude-anthropic-source-unknown.md'), 'anthropic');
  assert.equal(verdicts.length, 3);
  assert.ok(verdicts.every((v) => v.verdict === 'UNKNOWN' && v.evidence === null));
});

test('source verdicts: claude anthropic snapshot confirms the aliased ids', () => {
  const verdicts = verdictsFromSource(fixture('claude-anthropic-source-ok.md'), 'anthropic');
  assert.equal(verdicts.length, 3);
  assert.ok(verdicts.every((v) => v.verdict === 'OK'), JSON.stringify(verdicts));
});

test('renderPatch proposes updated tier rows with a new verifiedAt and never applies them', () => {
  const verdicts = verdictsFromCatalog(fixture('opencode-catalog-drifted.txt'));
  const patch = renderPatch(verdicts, { verifiedAt: '2026-08-21' });
  assert.ok(patch.includes("'zai-coding-plan': tierRows("));
  assert.ok(patch.includes("'zai-coding-plan/glm-5.3-flash', 'zai-coding-plan/glm-5.3.5-highspeed', 'zai-coding-plan/glm-5.3',"));
  assert.ok(patch.includes("'2026-08-21'"));
  assert.match(patch, /NOT applied|human-ratified/);
  assert.equal(renderPatch(verdictsFromCatalog(fixture('opencode-catalog-ok.txt')), { verifiedAt: '2026-08-21' }), '');
});

test('CLI: drifted catalog exits 1 and prints the proposed patch (fixture through main)', () => {
  const tdir = mkdtempSync(join(tmpdir(), 'steepy-verify-model-mappings-'));
  try {
    const catalogPath = join(tdir, 'catalog.txt');
    writeFileSync(catalogPath, fixture('opencode-catalog-drifted.txt'));
    const run = runCli(['--harness', 'opencode', '--catalog-file', catalogPath]);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stdout, /STALE/);
    assert.match(run.stdout, /zai-coding-plan\/glm-5\.3\.5-highspeed/);
    assert.match(run.stdout, /NOT applied|human-ratified/);
  } finally {
    rmSync(tdir, { recursive: true, force: true });
  }
});

test('CLI: OK catalog exits 0', () => {
  const run = runCli(['--harness', 'opencode', '--catalog-file', join(fixturesDir, 'opencode-catalog-ok.txt')]);
  assert.equal(run.status, 0, run.stderr);
  // ` STALE <id>` matches a verdict line, never the summary's `, 0 STALE,` count.
  assert.doesNotMatch(run.stdout, / STALE \S/);
});

test('CLI: provider-absent catalog reports UNKNOWN and still exits 0 (offline degradation)', () => {
  const run = runCli(['--harness', 'opencode', '--catalog-file', join(fixturesDir, 'opencode-catalog-provider-absent.txt')]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, / UNKNOWN \S/);
  assert.doesNotMatch(run.stdout, / STALE \S/);
});

test('CLI: codex aliased-id check runs offline via --source-file; drift exits 1', () => {
  const run = runCli(['--harness', 'codex', '--source-file', `openai=${join(fixturesDir, 'codex-openai-source-drift.md')}`]);
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /gpt-5\.7-sol/);
});

test('CLI: claude aliased-id check confirms the anthropic snapshot offline (exit 0)', () => {
  const run = runCli(['--harness', 'claude', '--source-file', `anthropic=${join(fixturesDir, 'claude-anthropic-source-ok.md')}`]);
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, / STALE \S/);
});

test('CLI: claude source with no family ids reports UNKNOWN and exits 0', () => {
  const run = runCli(['--harness', 'claude', '--source-file', `anthropic=${join(fixturesDir, 'claude-anthropic-source-unknown.md')}`]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /UNKNOWN/);
});

test('CLI: unknown harness is a usage error (exit 2)', () => {
  const run = runCli(['--harness', 'bogus']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage/);
});

test('CLI: a hung `opencode models` shell-out times out to UNKNOWN instead of hanging (SC7)', () => {
  const tdir = mkdtempSync(join(tmpdir(), 'steepy-verify-model-mappings-'));
  try {
    const fakeOpencode = join(tdir, 'opencode');
    writeFileSync(fakeOpencode, '#!/bin/sh\nsleep 5\n');
    chmodSync(fakeOpencode, 0o755);
    const start = Date.now();
    const run = spawnSync(process.execPath, [scriptPath, '--harness', 'opencode'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${tdir}:${process.env.PATH}`,
        STEEPY_VERIFY_MAPPINGS_TIMEOUT_MS: '250',
      },
    });
    const elapsed = Date.now() - start;
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, / UNKNOWN \S/);
    assert.match(run.stdout, /catalog unreachable/);
    assert.doesNotMatch(run.stdout, / STALE \S/);
    assert.ok(elapsed < 4000, `expected the run to return well under the fake 5s sleep, took ${elapsed}ms`);
  } finally {
    rmSync(tdir, { recursive: true, force: true });
  }
});

test('CLI: an unreadable explicit --catalog-file fails loudly instead of degrading', () => {
  const tdir = mkdtempSync(join(tmpdir(), 'steepy-verify-model-mappings-'));
  rmSync(tdir, { recursive: true, force: true });
  const run = runCli(['--harness', 'opencode', '--catalog-file', join(tdir, 'missing.txt')]);
  assert.equal(run.status, 2);
});

#!/usr/bin/env node
// Freshness verifier for adapters/model-mappings.mjs: re-checks every
// configured provider/tier row against the live evidence its provenance
// cites and prints a per-row verdict (OK | STALE | UNKNOWN) with the
// observed evidence line. STALE rows produce a proposed patch on stdout —
// never an in-place edit (human-ratified commits only). Exit 0 iff no row
// is STALE; UNKNOWN is reported but does not fail the run (explicit offline
// degradation, mirroring the adapters' fail-open philosophy).
//
// Evidence sources per harness (SUPPORTED_HARNESSES):
//   opencode — `opencode models` catalog output, all configured providers.
//   codex    — the CODEX_MODEL_MAPPING_SOURCE guide, openai aliased ids.
//   claude   — the ANTHROPIC_MODEL_MAPPING_SOURCE catalog, anthropic aliased ids.
//
// Fixture injection (tests, offline runs): --catalog-file <path> replaces the
// `opencode models` shell-out; --source-file <provider=path> (repeatable)
// replaces that provider's provenance fetch. Live network/shell use is a
// canary act, never a unit test.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  PROVIDER_MODEL_MAPPINGS,
  CODEX_MODEL_MAPPING_SOURCE,
  ANTHROPIC_MODEL_MAPPING_SOURCE,
} from '../adapters/model-mappings.mjs';
import { SUPPORTED_HARNESSES } from '../adapters/headless.mjs';

const TIERS = Object.freeze(['cheap', 'standard', 'most-capable']);

// One conservative default for both live evidence calls (the shell-out and
// the provenance fetch) — the spec mandates a fixed 30s default with no CLI
// flag. STEEPY_VERIFY_MAPPINGS_TIMEOUT_MS is a test-only override (not a
// documented flag): without it the hermetic hung-catalog test would have to
// sleep the full 30s to observe the timeout degrade to UNKNOWN.
const LIVE_TIMEOUT_MS = Number(process.env.STEEPY_VERIFY_MAPPINGS_TIMEOUT_MS ?? '') || 30_000;

// codex/claude address models without the provider prefix (headless.mjs
// BARE_MAPPINGS_BY_HARNESS), so their check is an aliased-id check against
// one provenance page per harness.
const HARNESS_SOURCE_PROVIDER = Object.freeze({ claude: 'anthropic', codex: 'openai' });

const SOURCE_URL_BY_PROVIDER = Object.freeze({
  openai: CODEX_MODEL_MAPPING_SOURCE,
  anthropic: ANTHROPIC_MODEL_MAPPING_SOURCE,
});

// A loaded page that shows none of a provider's id-family tokens carries no
// model-id evidence at all (UNKNOWN); a page that shows some but not the
// expected alias is drift (STALE).
const FAMILY_TOKEN_PATTERN = Object.freeze({
  openai: /\bgpt-[a-z0-9][\w.-]*/gi,
  anthropic: /\b(?:claude-[\w.-]+|(?:haiku|sonnet|opus)[\w.-]*)/gi,
});

const SAFE_MODEL_ID = /^[A-Za-z0-9][\w.-]*$/;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const aliasPattern = (alias) => new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'i');
const stripProviderPrefix = (model) => model.slice(model.indexOf('/') + 1);

// Longest common substring length — the drift-similarity score for picking
// which observed id occupies a tier slot. Inputs are short model ids, so the
// quadratic scan is fine and keeps proposals deterministic.
function lcsl(a, b) {
  let best = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k += 1;
      if (k > best) best = k;
    }
  }
  return best;
}

function bestCandidate(expected, candidates) {
  let best = null;
  let bestScore = -1;
  for (const cand of [...candidates].sort()) {
    const score = lcsl(expected, cand) * 1000 - Math.abs(expected.length - cand.length);
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  return best;
}

// Extracts `{ id, provider, line }` observations from `opencode models`-style
// output. Tolerant of table dressing: any `provider/model` token counts, and
// bare `provider model` (or `model provider`) column pairs count too.
export function parseCatalogEntries(catalogText, providers = Object.keys(PROVIDER_MODEL_MAPPINGS)) {
  const providerSet = new Set(providers);
  const entries = [];
  for (const line of String(catalogText).split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    if (tokens.some((t) => t.includes('/'))) {
      for (const token of tokens) {
        const slash = token.indexOf('/');
        if (slash > 0 && slash < token.length - 1
          && providerSet.has(token.slice(0, slash))
          && SAFE_MODEL_ID.test(token.slice(slash + 1))) {
          entries.push({ id: token, provider: token.slice(0, slash), line });
        }
      }
      continue;
    }
    for (let i = 0; i + 1 < tokens.length; i += 1) {
      const [a, b] = [tokens[i], tokens[i + 1]];
      if (providerSet.has(a) && SAFE_MODEL_ID.test(b)) {
        entries.push({ id: `${a}/${b}`, provider: a, line });
      } else if (providerSet.has(b) && SAFE_MODEL_ID.test(a)) {
        entries.push({ id: `${b}/${a}`, provider: b, line });
      }
    }
  }
  return entries;
}

function unknownVerdict(provider, tier, configured, alias, reason) {
  return {
    provider, tier, configured, alias,
    verdict: 'UNKNOWN', observed: null, proposedModel: null, evidence: null, reason,
  };
}

function assessProviderEntries(provider, rows, providerEntries, absentReason) {
  if (providerEntries.length === 0) {
    return TIERS.map((tier) => unknownVerdict(provider, tier, rows[tier].model, null, absentReason));
  }
  const confirmed = new Map();
  for (const tier of TIERS) {
    const entry = providerEntries.find((e) => e.id === rows[tier].model);
    if (entry) confirmed.set(tier, entry);
  }
  const takenIds = new Set([...confirmed.values()].map((e) => e.id));
  const verdicts = [];
  for (const tier of TIERS) {
    const configured = rows[tier].model;
    const entry = confirmed.get(tier);
    if (entry) {
      verdicts.push({
        provider, tier, configured, alias: null,
        verdict: 'OK', observed: entry.id, proposedModel: entry.id, evidence: entry.line,
        reason: 'catalog line confirms the id',
      });
      continue;
    }
    const candidates = providerEntries.filter((e) => !takenIds.has(e.id));
    const best = candidates.length > 0 ? bestCandidate(configured, candidates.map((e) => e.id)) : null;
    if (best !== null) {
      const bestEntry = candidates.find((e) => e.id === best);
      verdicts.push({
        provider, tier, configured, alias: null,
        verdict: 'STALE', observed: best, proposedModel: best, evidence: bestEntry.line,
        reason: 'source shows a different id for this tier slot (drift)',
      });
    } else {
      verdicts.push(unknownVerdict(
        provider, tier, configured, null,
        'configured id absent and no other id observed for this slot (no evidence)',
      ));
    }
  }
  return verdicts;
}

// catalog-text → verdicts: checks every configured provider's tier rows
// against `opencode models`-style catalog text.
export function verdictsFromCatalog(catalogText, { mappings = PROVIDER_MODEL_MAPPINGS } = {}) {
  const entries = parseCatalogEntries(String(catalogText), Object.keys(mappings));
  const verdicts = [];
  for (const [provider, rows] of Object.entries(mappings)) {
    verdicts.push(...assessProviderEntries(
      provider, rows, entries.filter((e) => e.provider === provider),
      'provider absent from the catalog (no evidence)',
    ));
  }
  return verdicts;
}

// provenance-text → verdicts: checks one provider's tier rows (as bare
// aliased ids, the codex/claude addressing) against its cited source page.
export function verdictsFromSource(sourceText, provider, { mappings = PROVIDER_MODEL_MAPPINGS } = {}) {
  const text = String(sourceText);
  const rows = mappings[provider];
  const family = FAMILY_TOKEN_PATTERN[provider];
  const lines = text.split(/\r?\n/);
  if (!rows || !family) throw new Error(`no source-check configured for provider '${provider}'`);
  const tokens = [];
  for (const line of lines) {
    for (const m of line.matchAll(family)) tokens.push({ token: m[0], line });
  }
  if (tokens.length === 0) {
    return TIERS.map((tier) => unknownVerdict(
      provider, tier, rows[tier].model, stripProviderPrefix(rows[tier].model),
      'source shows no model ids for this family (no evidence)',
    ));
  }
  const confirmed = new Map();
  for (const tier of TIERS) {
    const alias = stripProviderPrefix(rows[tier].model);
    const pat = aliasPattern(alias);
    const line = lines.find((l) => pat.test(l));
    if (line !== undefined) confirmed.set(tier, { alias, line });
  }
  const takenTokens = new Set([...confirmed.values()].map((c) => c.alias.toLowerCase()));
  const verdicts = [];
  for (const tier of TIERS) {
    const configured = rows[tier].model;
    const alias = stripProviderPrefix(configured);
    const conf = confirmed.get(tier);
    if (conf) {
      verdicts.push({
        provider, tier, configured, alias,
        verdict: 'OK', observed: alias, proposedModel: configured, evidence: conf.line,
        reason: 'source confirms the aliased id',
      });
      continue;
    }
    const candidates = [...new Set(tokens
      .filter((t) => !takenTokens.has(t.token.toLowerCase()))
      .map((t) => t.token))];
    const best = candidates.length > 0 ? bestCandidate(alias, candidates) : null;
    if (best !== null) {
      const entry = tokens.find((t) => t.token === best);
      verdicts.push({
        provider, tier, configured, alias,
        verdict: 'STALE', observed: best, proposedModel: `${provider}/${best}`, evidence: entry.line,
        reason: 'source shows a different id for this tier slot (drift)',
      });
    } else {
      verdicts.push(unknownVerdict(
        provider, tier, configured, alias,
        'configured alias absent and no other family id observed for this slot (no evidence)',
      ));
    }
  }
  return verdicts;
}

// verdicts → patch text: proposed replacement tier rows for every STALE slot,
// with updated verifiedAt. Empty string when nothing is stale.
export function renderPatch(verdicts, { verifiedAt = new Date().toISOString().slice(0, 10) } = {}) {
  const stale = verdicts.filter((v) => v.verdict === 'STALE');
  if (stale.length === 0) return '';
  const byProvider = new Map();
  for (const v of stale) {
    if (!byProvider.has(v.provider)) byProvider.set(v.provider, new Map());
    byProvider.get(v.provider).set(v.tier, v);
  }
  const q = (s) => `'${s}'`;
  const blocks = [];
  for (const [provider, tierMap] of byProvider) {
    const rows = PROVIDER_MODEL_MAPPINGS[provider];
    const models = {};
    for (const tier of TIERS) {
      const v = tierMap.get(tier);
      models[tier] = v ? v.proposedModel : rows[tier].model;
    }
    blocks.push([
      `  ${q(provider)}: tierRows(`,
      `    ${q(rows.standard.source)},`,
      `    ${q(models.cheap)}, ${q(models.standard)}, ${q(models['most-capable'])},`,
      `  ),`,
      `  // verifiedAt: ${q(rows.cheap.verifiedAt)} -> ${q(verifiedAt)}`,
    ].join('\n'));
  }
  return [
    'proposed adapters/model-mappings.mjs update (NOT applied — human-ratified commits only):',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

function formatVerdict(v) {
  const head = `[${v.harness ?? '?'}] ${v.provider} ${v.tier} ${v.verdict} ${v.configured}`;
  const drift = v.verdict === 'STALE' ? ` -> ${v.proposedModel}` : '';
  const evidence = v.evidence
    ? `evidence: ${v.evidence.trim()}`
    : `evidence: none (${v.reason})`;
  return `${head}${drift}\n    ${evidence}`;
}

function allUnknown(harness, entries, reason) {
  const out = [];
  for (const [provider, rows] of entries) {
    for (const tier of TIERS) {
      out.push({
        harness, ...unknownVerdict(provider, tier, rows[tier].model, null, reason),
      });
    }
  }
  return out;
}

function liveCatalogText() {
  const run = spawnSync('opencode', ['models'], { encoding: 'utf8', timeout: LIVE_TIMEOUT_MS });
  if (run.error || run.status !== 0 || !run.stdout) return null;
  return run.stdout;
}

async function liveSourceText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function readTextOrError(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    return err;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const usage = 'usage: verify-model-mappings.mjs [--harness <claude|codex|opencode>]'
    + ' [--catalog-file <path>] [--source-file <provider=path>]...';
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        harness: { type: 'string' },
        'catalog-file': { type: 'string' },
        'source-file': { type: 'string', multiple: true },
      },
      strict: true,
    }));
  } catch (err) {
    console.error(`verify-model-mappings: ${err.message}`);
    console.error(usage);
    return 2;
  }
  if (values.harness !== undefined && !SUPPORTED_HARNESSES.includes(values.harness)) {
    console.error(`verify-model-mappings: unknown harness '${values.harness}'`
      + ` (supported: ${SUPPORTED_HARNESSES.join(', ')})`);
    console.error(usage);
    return 2;
  }
  const sourceFiles = new Map();
  for (const spec of values['source-file'] ?? []) {
    const eq = spec.indexOf('=');
    const provider = eq === -1 ? '' : spec.slice(0, eq);
    if (!Object.hasOwn(PROVIDER_MODEL_MAPPINGS, provider)) {
      console.error(`verify-model-mappings: --source-file expects <provider=path> with a configured provider`
        + ` (${Object.keys(PROVIDER_MODEL_MAPPINGS).join(', ')})`);
      return 2;
    }
    sourceFiles.set(provider, spec.slice(eq + 1));
  }

  const harnesses = values.harness === undefined ? [...SUPPORTED_HARNESSES] : [values.harness];
  const verdicts = [];
  for (const harness of harnesses) {
    if (harness === 'opencode') {
      let text = null;
      if (values['catalog-file'] !== undefined) {
        const read = readTextOrError(values['catalog-file']);
        if (read instanceof Error) {
          console.error(`verify-model-mappings: cannot read --catalog-file: ${read.message}`);
          return 2;
        }
        text = read;
      } else {
        text = liveCatalogText();
      }
      verdicts.push(...(text === null
        ? allUnknown('opencode', Object.entries(PROVIDER_MODEL_MAPPINGS),
          'catalog unreachable — `opencode models` failed or is not installed')
        : verdictsFromCatalog(text).map((v) => ({ ...v, harness: 'opencode' }))));
      continue;
    }
    const provider = HARNESS_SOURCE_PROVIDER[harness];
    let text = null;
    if (sourceFiles.has(provider)) {
      const read = readTextOrError(sourceFiles.get(provider));
      if (read instanceof Error) {
        console.error(`verify-model-mappings: cannot read --source-file for ${provider}: ${read.message}`);
        return 2;
      }
      text = read;
    } else {
      text = await liveSourceText(SOURCE_URL_BY_PROVIDER[provider]);
    }
    verdicts.push(...(text === null
      ? allUnknown(harness, [[provider, PROVIDER_MODEL_MAPPINGS[provider]]],
        `source unreachable — ${SOURCE_URL_BY_PROVIDER[provider]}`)
      : verdictsFromSource(text, provider).map((v) => ({ ...v, harness }))));
  }

  for (const v of verdicts) console.log(formatVerdict(v));
  const counts = { OK: 0, STALE: 0, UNKNOWN: 0 };
  for (const v of verdicts) counts[v.verdict] += 1;
  console.log(`summary: ${counts.OK} OK, ${counts.STALE} STALE, ${counts.UNKNOWN} UNKNOWN`
    + ' (STALE fails the run; UNKNOWN is explicit offline degradation)');
  if (counts.STALE > 0) {
    console.log();
    console.log(renderPatch(verdicts, { verifiedAt: new Date().toISOString().slice(0, 10) }));
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`verify-model-mappings: ${err.message}`);
      process.exit(1);
    },
  );
}

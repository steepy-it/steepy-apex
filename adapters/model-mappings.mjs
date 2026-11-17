// Shared provider-keyed tier tables: the single source of truth for
// provider → tier → concrete model ids. Every id carries its provider prefix
// so it is directly usable as an OpenCode agent `model` value, and every row
// records its provenance (`source` + ISO `verifiedAt`). Pure data + pure
// functions only — no IO, no engine-script imports (adapters standard).

export const CODEX_MODEL_MAPPING_SOURCE =
  'https://developers.openai.com/api/docs/guides/latest-model';
export const ANTHROPIC_MODEL_MAPPING_SOURCE =
  'https://docs.anthropic.com/en/docs/about-claude/models/overview';
const ANTHROPIC_ALIAS_SOURCE = 'https://code.claude.com/docs/en/model-config';

const ZAI_MODEL_MAPPING_SOURCE = 'opencode models live catalog';
const DEEPSEEK_MODEL_MAPPING_SOURCE =
  'api-docs.deepseek.com models page (V4.1-Flash / V4-Pro-0813)';
const VERIFIED_AT = '2026-09-29';

// The tier ladder is a cost/capability ladder, so each row must ascend:
// `cheap` is the provider's small fast model, never a frontier one. An
// inverted row silently sends every mechanical task to the most expensive
// model available, which is the exact waste tier routing exists to prevent.
// `deepseek` and `openai` repeat their top rung on standard/most-capable
// (a repeat is allowed, an inversion is not).
const tierRows = (source, cheap, standard, mostCapable, verifiedAt = VERIFIED_AT) => Object.freeze({
  cheap: Object.freeze({ model: cheap, source, verifiedAt }),
  standard: Object.freeze({ model: standard, source, verifiedAt }),
  'most-capable': Object.freeze({ model: mostCapable, source, verifiedAt }),
});

export const PROVIDER_MODEL_MAPPINGS = Object.freeze({
  // Full 5.3-generation ladder (human-ratified 2026-08-27): glm-5.3-flash is
  // the generation's small fast model and dominates glm-5.2 (better and
  // cheaper), so the whole 5.2 generation left the ladder; highspeed sits
  // below plain, mirroring the prior 5.2-highspeed < 5.2 ordering.
  'zai-coding-plan': tierRows(
    ZAI_MODEL_MAPPING_SOURCE,
    'zai-coding-plan/glm-5.3-flash', 'zai-coding-plan/glm-5.3-highspeed', 'zai-coding-plan/glm-5.3',
    '2026-08-27',
  ),
  // deepseek-flash (V4.1-Flash) replaced deepseek-v4-flash, which is retired
  // and only routed to it; the catalog has no newer Pro than v4-pro.
  deepseek: tierRows(
    DEEPSEEK_MODEL_MAPPING_SOURCE,
    'deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-pro',
  ),
  // 5.5 snapshot ids (human-ratified 2026-11-17). OpenCode accepts only
  // catalog ids: the family words `anthropic/haiku|sonnet|opus` are not in its
  // catalog and fail as "Model unavailable". Fable stays off the ladder.
  anthropic: tierRows(
    ANTHROPIC_MODEL_MAPPING_SOURCE,
    'anthropic/claude-haiku-5-5', 'anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5',
    '2026-11-17',
  ),
  // GPT-6 ladder (human-ratified 2026-11-17): gpt-6.1-sol supersedes
  // gpt-6-sol at the same price and tops the ladder. gpt-6-astra stays off it,
  // as Fable does for anthropic — astra ($10/$50, 5x sol) is priced above
  // Fable 5.2 ($8/$40), so it is reached only by a ledgered override.
  openai: tierRows(
    CODEX_MODEL_MAPPING_SOURCE,
    'openai/gpt-6-luna', 'openai/gpt-6.1-sol', 'openai/gpt-6.1-sol',
    '2026-11-17',
  ),
});

// Claude Code keeps its own family aliases instead of the pinned anthropic
// snapshots above: `haiku`/`sonnet`/`opus` resolve to the newest model on the
// Anthropic API (Haiku/Sonnet/Opus 5.5 on 2026-11-17) and to the provider's
// own id on Bedrock, Google Cloud and Foundry, where snapshot ids differ.
const ANTHROPIC_ALIAS_ROWS = tierRows(
  ANTHROPIC_ALIAS_SOURCE,
  'haiku', 'sonnet', 'opus',
  '2026-11-17',
);

const tierModels = (rows) => Object.freeze({
  cheap: rows.cheap.model,
  standard: rows.standard.model,
  'most-capable': rows['most-capable'].model,
});

const TIER_MODELS_BY_PROVIDER = Object.freeze(Object.fromEntries(
  Object.entries(PROVIDER_MODEL_MAPPINGS).map(([provider, rows]) => [provider, tierModels(rows)]),
));

// headless harnesses address models without the provider prefix: codex
// (`--model gpt-6-luna`) uses the openai table with the `provider/` prefix
// stripped, claude (`--model haiku`) uses ANTHROPIC_ALIAS_ROWS.
const stripProviderPrefix = (model) => model.slice(model.indexOf('/') + 1);

const bareTiers = (provider) => {
  const rows = TIER_MODELS_BY_PROVIDER[provider];
  return Object.freeze({
    cheap: stripProviderPrefix(rows.cheap),
    standard: stripProviderPrefix(rows.standard),
    'most-capable': stripProviderPrefix(rows['most-capable']),
  });
};

const BARE_MAPPINGS_BY_HARNESS = Object.freeze({
  claude: tierModels(ANTHROPIC_ALIAS_ROWS),
  codex: bareTiers('openai'),
});

export function resolveProviderFromModel(model) {
  if (typeof model !== 'string') return undefined;
  const slash = model.indexOf('/');
  if (slash === -1) return undefined;
  const provider = model.slice(0, slash);
  return Object.hasOwn(PROVIDER_MODEL_MAPPINGS, provider) ? provider : undefined;
}

export function tierModelsForProvider(providerId) {
  if (typeof providerId !== 'string') return undefined;
  return Object.hasOwn(TIER_MODELS_BY_PROVIDER, providerId)
    ? TIER_MODELS_BY_PROVIDER[providerId]
    : undefined;
}

export function bareModelMappingsForHarness(harness) {
  if (typeof harness !== 'string') return undefined;
  return Object.hasOwn(BARE_MAPPINGS_BY_HARNESS, harness)
    ? BARE_MAPPINGS_BY_HARNESS[harness]
    : undefined;
}

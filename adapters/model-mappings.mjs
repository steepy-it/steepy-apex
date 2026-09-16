// Shared provider-keyed tier tables: the single source of truth for
// provider → tier → concrete model ids. Every id carries its provider prefix
// so it is directly usable as an OpenCode agent `model` value, and every row
// records its provenance (`source` + ISO `verifiedAt`). Pure data + pure
// functions only — no IO, no engine-script imports (adapters standard).

export const CODEX_MODEL_MAPPING_SOURCE =
  'https://developers.openai.com/api/docs/guides/latest-model';
export const ANTHROPIC_MODEL_MAPPING_SOURCE =
  'https://docs.anthropic.com/en/docs/about-claude/models/overview';

const ZAI_MODEL_MAPPING_SOURCE = 'opencode models live catalog';
const DEEPSEEK_MODEL_MAPPING_SOURCE =
  'api-docs.deepseek.com models page (V4-Flash-0731 / V4-Pro-0813)';
const VERIFIED_AT = '2026-08-20';

// The tier ladder is a cost/capability ladder, so each row must ascend:
// `cheap` is the provider's small fast model, never a frontier one. An
// inverted row silently sends every mechanical task to the most expensive
// model available, which is the exact waste tier routing exists to prevent.
// `deepseek` repeats its top rung on standard/most-capable (two-model
// catalog — a repeat is allowed, an inversion is not).
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
  deepseek: tierRows(
    DEEPSEEK_MODEL_MAPPING_SOURCE,
    'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-pro',
  ),
  anthropic: tierRows(
    ANTHROPIC_MODEL_MAPPING_SOURCE,
    'anthropic/haiku', 'anthropic/sonnet', 'anthropic/opus',
  ),
  openai: tierRows(
    CODEX_MODEL_MAPPING_SOURCE,
    'openai/gpt-5.6-luna', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-sol',
  ),
});

const tierModels = (rows) => Object.freeze({
  cheap: rows.cheap.model,
  standard: rows.standard.model,
  'most-capable': rows['most-capable'].model,
});

const TIER_MODELS_BY_PROVIDER = Object.freeze(Object.fromEntries(
  Object.entries(PROVIDER_MODEL_MAPPINGS).map(([provider, rows]) => [provider, tierModels(rows)]),
));

// headless harnesses address models without the provider prefix (claude
// `--model haiku`, codex `--model gpt-5.6-luna`), so their rows are the
// provider tables with the `provider/` prefix stripped.
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
  claude: bareTiers('anthropic'),
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

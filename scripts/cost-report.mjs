// C1 — harness-neutral cost report. A read-only aggregator/reporter that reads
// the two drive channels and emits one report:
//
//   headless    `.apex/work/tasks/<spec>/resource-usage.jsonl` (the autopilot
//               conductor's per-dispatch usage ledger) plus the per-attempt
//               `phase-<n>-attempt-<m>.raw.jsonl` raw event stream for volume;
//   interactive session records located via the C2 descriptor
//               (`adapters/session-store.mjs`), filtered to interactive
//               (`cli`) sessions whose recorded working directory is the
//               given `--repo-root` (a repo-scoped report never absorbs
//               other repos' sessions in the report; attribution happens
//               after files are read).
//
// The report is observational only (`.apex/conventions.md:92-94`): it terminates
// nothing, gates nothing, and performs no network access. By default it reads
// the descriptor's user-wide store; --session-store-root selects an exact root
// and --no-session-store disables that collection. Degradation is explicit: a missing/unreadable store is
// `CHANNEL_UNAVAILABLE` (never zero spend), a record missing `usage` is
// `usage-unattributed`, and a dispatch missing `resolvedModel` is
// `resolved=unknown`.
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { decodeHeadlessEvent } from '../adapters/headless-events.mjs';
import { sessionStoreDescriptor } from '../adapters/session-store.mjs';
import { readWorkPath } from './work-paths.mjs';

// The phase order is the conductor's own (`scripts/autopilot.mjs` PHASES); the
// raw capture filenames index it 1-based, so the reader must map number→name.
const PHASES = Object.freeze(['plan', 'implement', 'review']);

// `reasoning` is reported side by side with the other categories, never summed
// into them: whether a provider nests reasoning tokens inside `output` is
// provider-specific, and this report does not add categories together.
const CATEGORY_KEYS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']);

// SC4 — raw token counts by category are the default view. Any weighted or
// currency view must read a versioned cost/weight table that cites its
// provenance in-file, in the manner of CODEX_MODEL_MAPPING_SOURCE
// (`adapters/headless.mjs:7`). No verified public cost/weight table is cited
// yet, so the weighted view is gated behind an explicit provenance-carrying
// table and the spec's triage weights are reproduced below, explicitly marked
// unsourced.
export const COST_WEIGHT_TABLE_SOURCE = null;

// Unsourced triage weights (`input×1 + output×5 + cacheRead×0.1 + cacheWrite×1.25`)
// used only to triage the Problem section of the source spec — deliberately NOT
// the default view and never a cited table (SC4).
export const TRIAGE_WEIGHTS = Object.freeze({
  source: null,
  version: 'unsourced',
  input: 1,
  output: 5,
  cacheRead: 0.1,
  cacheWrite: 1.25,
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

// Reads a dotted field path (`message.usage`) from a plain object; null when any
// segment is absent or not an object.
function getPath(object, path) {
  if (typeof path !== 'string' || path.length === 0 || !isObject(object)) return null;
  let current = object;
  for (const segment of path.split('.')) {
    if (!isObject(current) || !Object.hasOwn(current, segment)) return null;
    current = current[segment];
  }
  return current;
}

// Normalizes a provider- or ledger-shaped usage object into the canonical
// `{ input, output, cacheRead, cacheWrite, reasoning }` split. A category
// absent from the source is zero; an object carrying none of the categories is
// `null` (the record is `usage-unattributed`, never imputed).
export function normalizeUsage(source) {
  if (!isObject(source)) return null;
  const mapping = {
    input: ['input', 'input_tokens', 'inputTokens'],
    output: ['output', 'output_tokens', 'outputTokens'],
    cacheRead: ['cacheRead', 'cache_read_input_tokens', 'cached_input_tokens', 'cacheReadTokens'],
    cacheWrite: ['cacheWrite', 'cache_creation_input_tokens', 'cacheWriteTokens'],
    reasoning: ['reasoning', 'reasoning_tokens', 'reasoningTokens'],
  };
  const usage = {};
  let found = false;
  for (const category of CATEGORY_KEYS) {
    let value = null;
    for (const key of mapping[category]) {
      if (Object.hasOwn(source, key)) {
        value = nonNegativeNumber(source[key]);
        if (value !== null) break;
      }
    }
    usage[category] = value ?? 0;
    if (value !== null) found = true;
  }
  return found ? usage : null;
}

// Ledger labels describe observations; only provider measurement evidence can
// establish additive accounting scope.
function canonicalEligibility(value) {
  return ['provider-measurement', 'nested-actor-detail'].includes(value) ? value : 'unknown';
}

// A per-dispatch row, uniform across channels (SC1). `skill` and `phase` are
// distinct vocabularies: `skill` is a harness skill attribution (interactive
// sessions), `phase` is the conductor's phase name
// (ledger rows). A row carries whichever its source actually records — the
// ledger records no skill, so mapping its phase into the skill slot would
// fabricate a vocabulary that can never join the interactive channel's.
// `aggregationEligibility` describes the source label. Consumers must use
// `accountingDisposition` to decide whether a measurement is additive.
function dispatchRow({
  channel, session, skill, phase = null, agentType, requestedModel, resolvedModel, usage,
  aggregationEligibility, observationFingerprint, measurementId, measurementScope,
  providerVersion, accountingDisposition,
}) {
  return {
    channel,
    session,
    skill,
    phase,
    agentType,
    requestedModel,
    resolvedModel,
    usage,
    aggregationEligibility,
    ...(observationFingerprint === undefined ? {} : { observationFingerprint }),
    ...(measurementId === undefined ? {} : { measurementId }),
    ...(measurementScope === undefined ? {} : { measurementScope }),
    ...(providerVersion === undefined ? {} : { providerVersion }),
    ...(accountingDisposition === undefined ? {} : { accountingDisposition }),
  };
}

// --- headless channel ------------------------------------------------------

// Parses the autopilot `resource-usage.jsonl` ledger into dispatch rows. Exact
// retransmission identity and provider measurement scope remain distinct, and
// the per-record `harness` selects the decoder for that run's raw streams.
const OBSERVATION_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;

function isRecognizedLedgerRecord(record) {
  return record.schemaVersion === 2
    && typeof record.observationFingerprint === 'string'
    && OBSERVATION_FINGERPRINT_PATTERN.test(record.observationFingerprint);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parsedHeadlessRecord(source) {
  const observationFingerprint = typeof source.observationFingerprint === 'string'
    ? source.observationFingerprint
    : null;
  return {
    source,
    aggregationEligibility: source.aggregationEligibility ?? 'unknown',
    harness: typeof source.harness === 'string' ? source.harness : null,
    dispatch: dispatchRow({
      channel: 'headless',
      session: typeof source.sessionId === 'string' ? source.sessionId : null,
      skill: null,
      phase: typeof source.phase === 'string' ? source.phase : null,
      agentType: typeof source.actor === 'string' ? source.actor : null,
      requestedModel: typeof source.requestedModelTier === 'string' ? source.requestedModelTier : null,
      resolvedModel: typeof source.resolvedModel === 'string' ? source.resolvedModel : 'unknown',
      usage: normalizeUsage(source.usage),
      aggregationEligibility: canonicalEligibility(source.aggregationEligibility ?? 'unknown'),
      observationFingerprint,
      measurementId: typeof source.measurementId === 'string' ? source.measurementId : null,
      measurementScope: isObject(source.measurementScope) ? source.measurementScope : null,
      providerVersion: typeof source.providerVersion === 'string' ? source.providerVersion : undefined,
      accountingDisposition: 'excluded-unknown-scope',
    }),
  };
}

function conflictingObservationRecord(group, observationFingerprint) {
  const providerMeasurementKeys = new Set();
  for (const record of group) {
    for (const key of measurementEvidenceKeys(record)) providerMeasurementKeys.add(key);
  }
  const harness = group[0].harness;
  return {
    source: { schemaVersion: 2, harness, observationFingerprint, observationConflict: true },
    aggregationEligibility: 'unknown',
    harness,
    providerMeasurementKeys,
    observationConflict: true,
    dispatch: dispatchRow({
      channel: 'headless', session: null, skill: null, phase: null, agentType: null,
      requestedModel: null, resolvedModel: 'unknown', usage: null,
      aggregationEligibility: 'unknown', observationFingerprint,
      measurementId: null, measurementScope: null,
      accountingDisposition: 'excluded-conflicting-observation',
    }),
  };
}

function parseHeadlessRecords(text) {
  const candidates = [];
  let invalidLines = 0;
  let retransmissionsDeduplicated = 0;
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      invalidLines += 1; // a non-empty line that is not valid JSON
      continue;
    }
    if (!isObject(record)) {
      invalidLines += 1; // valid JSON, but not a ledger record shape
      continue;
    }
    if (!isRecognizedLedgerRecord(record)) {
      invalidLines += 1;
      continue;
    }
    candidates.push(parsedHeadlessRecord(record));
  }

  const records = [];
  const observationGroups = new Map();
  const orderedEntries = [];
  for (const candidate of candidates) {
    const fingerprint = candidate.dispatch.observationFingerprint;
    if (fingerprint === null) {
      orderedEntries.push(candidate);
      continue;
    }
    const key = JSON.stringify([candidate.harness, fingerprint]);
    if (!observationGroups.has(key)) {
      const group = [];
      observationGroups.set(key, group);
      orderedEntries.push(group);
    }
    observationGroups.get(key).push(candidate);
  }
  for (const entry of orderedEntries) {
    if (!Array.isArray(entry)) {
      records.push(entry);
      continue;
    }
    const group = entry;
    if (group.length === 1) {
      records.push(group[0]);
      continue;
    }
    const canonicalSources = group.map(({ source }) => canonicalJson(source));
    if (canonicalSources.every((source) => source === canonicalSources[0])) {
      records.push(group[0]);
      retransmissionsDeduplicated += group.length - 1;
    } else {
      records.push(conflictingObservationRecord(group, group[0].dispatch.observationFingerprint));
    }
  }
  classifyHeadlessAccounting(records);
  return { records, invalidLines, retransmissionsDeduplicated };
}

function providerMeasurementKey(record) {
  const { source } = record;
  const scope = source.measurementScope;
  if (
    !isObject(scope)
    || scope.provider !== 'opencode'
    || !isCanonicalProvenanceId(scope.kind)
    || !isCanonicalProvenanceId(scope.sessionId)
    || (scope.messageId !== undefined && !isCanonicalProvenanceId(scope.messageId))
    || (scope.partId !== undefined && !isCanonicalProvenanceId(scope.partId))
    || (
      scope.kind === 'step'
      && (![scope.messageId, scope.partId].every(isCanonicalProvenanceId))
    )
  ) return null;
  return JSON.stringify([
    scope.provider, scope.kind, scope.sessionId,
    scope.messageId ?? null, scope.partId ?? null,
  ]);
}

const CANONICAL_PROVENANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

// Identity and scope are independent evidence: a contradictory or incomplete
// observation can still name a measurement that must not be counted elsewhere.
function measurementEvidenceKeys(record) {
  const keys = new Set();
  const scopeKey = providerMeasurementKey(record);
  if (scopeKey !== null) keys.add(scopeKey);
  const identity = record.source.measurementId;
  if (typeof identity === 'string' && identity.startsWith('opencode:step:')) {
    const components = identity.slice('opencode:step:'.length);
    // Colons are also legal inside an ID. Validate the alphabet once, then
    // require two possible boundaries instead of backtracking over three IDs.
    if (isCanonicalProvenanceId(components)
      && (components.match(/:[A-Za-z0-9]/g)?.length ?? 0) >= 2) {
      keys.add(JSON.stringify(['measurement-id', 'opencode', identity]));
    }
  }
  return keys;
}

function isCanonicalProvenanceId(value) {
  return typeof value === 'string' && CANONICAL_PROVENANCE_ID.test(value);
}

function hasAccountingProvenance(record) {
  const { source } = record;
  return isCanonicalProvenanceId(source.runId)
    && PHASES.includes(source.phase)
    && Number.isSafeInteger(source.attempt)
    && source.attempt > 0
    && source.harness === 'opencode'
    && isCanonicalProvenanceId(source.sessionId);
}

function hasCanonicalProviderScope(record) {
  const { source } = record;
  const scope = source.measurementScope;
  if (
    !hasAccountingProvenance(record)
    || providerMeasurementKey(record) === null
    || scope.sessionId !== source.sessionId
    || !isObject(source.observationScope)
    || source.observationScope.kind !== 'session'
    || source.observationScope.sessionId !== source.sessionId
  ) return false;
  return true;
}

function supportedDisjointScope(record) {
  const { source } = record;
  const scope = source.measurementScope;
  if (
    source.schemaVersion !== 2
    || source.harness !== 'opencode'
    || source.providerVersion !== '1.18.27'
    || !isObject(scope)
  ) return false;
  if (!hasCanonicalProviderScope(record)) return false;
  if (scope.provider !== 'opencode' || scope.kind !== 'step' || scope.sessionId !== source.sessionId) return false;
  if (![scope.sessionId, scope.messageId, scope.partId].every(isCanonicalProvenanceId)) return false;
  return source.measurementId === `opencode:step:${scope.sessionId}:${scope.messageId}:${scope.partId}`;
}

function classifyHeadlessAccounting(records) {
  const scopeCounts = new Map();
  for (const record of records) {
    const keys = record.providerMeasurementKeys
      ?? measurementEvidenceKeys(record);
    for (const key of keys) scopeCounts.set(key, (scopeCounts.get(key) ?? 0) + 1);
  }
  for (const record of records) {
    const { source, dispatch } = record;
    if (record.observationConflict) dispatch.accountingDisposition = 'excluded-conflicting-observation';
    else if (dispatch.usage === null) dispatch.accountingDisposition = 'excluded-missing-usage';
    else if (source.observationScope?.kind === 'actor' || typeof source.actorId === 'string') {
      dispatch.accountingDisposition = 'excluded-actor-detail';
    }
    else {
      const overlaps = [...measurementEvidenceKeys(record)].some((key) => scopeCounts.get(key) > 1);
      if (!hasCanonicalProviderScope(record)) dispatch.accountingDisposition = 'excluded-unknown-scope';
      else if (overlaps) dispatch.accountingDisposition = 'excluded-overlap';
      else if (supportedDisjointScope(record)) dispatch.accountingDisposition = 'included';
      else dispatch.accountingDisposition = 'excluded-unknown-scope';
    }
  }
}

export function parseHeadlessDispatches(text) {
  return parseHeadlessRecords(text).records.map((record) => record.dispatch);
}

// Counts assistant messages and tool calls in one raw event stream by decoding
// each source line with the shared headless decoder. A tool call is counted
// exactly once: Claude/Codex emit a `tool.started` before their completion,
// while OpenCode emits only the completed/failed `tool_use` — so its
// `tool.completed`/`tool.failed` events are the call, not a duplicate.
export function countVolume(rawText, harness, decode = decodeHeadlessEvent) {
  let assistantMessages = 0;
  let toolCalls = 0;
  for (const line of String(rawText ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let sourceLine = trimmed;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed?.line === 'string') sourceLine = parsed.line;
    } catch {
      // the raw line itself is not a valid envelope — fall back to the literal
    }
    const result = decode(sourceLine, {
      harness, runId: 'cost-report', phase: 'volume', attempt: 0,
      sourceStream: 'stdout', receivedAt: '',
    });
    if (result.disposition !== 'decoded') continue;
    if (result.envelope.event === 'message') assistantMessages += 1;
    else if (result.envelope.event === 'tool.started') {
      // Claude packs N parallel tool calls into one assistant message: the
      // decoder emits one `tool.started` carrying `metadata.toolUseCount`, so
      // the volume counts calls, not messages. Harnesses without the field
      // (Codex: one event per command) default to one call per event.
      toolCalls += nonNegativeNumber(result.envelope.metadata?.toolUseCount) ?? 1;
    } else if (
      harness === 'opencode'
      && (result.envelope.event === 'tool.completed' || result.envelope.event === 'tool.failed')
    ) toolCalls += 1;
  }
  return { assistantMessages, toolCalls };
}

// SC4 — the weighted view requires a versioned table that cites provenance
// in-file; an unsourced table (or none) refuses rather than impute a price from
// memory. Weight keys are the canonical category names.
export function weightedTotal(usage, weightTable) {
  if (!isObject(weightTable) || weightTable.source == null) {
    throw new Error('a weighted/currency view requires a versioned cost/weight table with in-file provenance (SC4)');
  }
  const categories = normalizeUsage(usage) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  return CATEGORY_KEYS.reduce((total, category) => total + categories[category] * (nonNegativeNumber(weightTable[category]) ?? 0), 0);
}

function sumUsage(rows) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  for (const row of rows) {
    if (row.usage === null) continue;
    for (const category of CATEGORY_KEYS) total[category] += row.usage[category];
  }
  return total;
}

function usageUnattributed(rows) {
  return rows.filter((row) => row.usage === null).length;
}

function emptyChannel(channel, reason) {
  return {
    channel,
    status: 'CHANNEL_UNAVAILABLE',
    reason,
    dispatches: [],
    skillRollups: [],
    phaseRollups: [],
    sessionRollups: [],
    sessionModels: [],
    volumes: [],
    usageUnattributed: 0,
    accountingCoverage: {
      status: 'unavailable', observations: 0, included: 0, excludedOverlap: 0,
      excludedUnknownScope: 0, excludedActorDetail: 0,
      usageUnattributed: 0, invalidOrUnclassifiable: 0, retransmissionsDeduplicated: 0,
    },
  };
}

function accountingCoverage(records, retransmissionsDeduplicated, additionalRows = [], invalidLines = 0) {
  const counts = {
    included: 0,
    excludedOverlap: 0,
    excludedUnknownScope: 0,
    excludedActorDetail: 0,
    usageUnattributed: 0,
    invalidOrUnclassifiable: invalidLines,
  };
  const fieldByDisposition = {
    included: 'included',
    'excluded-overlap': 'excludedOverlap',
    'excluded-unknown-scope': 'excludedUnknownScope',
    'excluded-actor-detail': 'excludedActorDetail',
    'excluded-missing-usage': 'usageUnattributed',
    'excluded-conflicting-observation': 'invalidOrUnclassifiable',
  };
  const dispatches = [...records.map((record) => record.dispatch), ...additionalRows];
  for (const dispatch of dispatches) counts[fieldByDisposition[dispatch.accountingDisposition]] += 1;
  const observations = records.length + additionalRows.length + invalidLines;
  const status = counts.included === observations && observations > 0
    ? 'complete'
    : (counts.included > 0 ? 'partial' : 'unknown');
  return { status, observations, ...counts, retransmissionsDeduplicated };
}

function groupRollup(rows, keyField, rollupField) {
  const byKey = new Map();
  for (const row of rows) {
    const key = row[keyField];
    if (key === null) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }
  return [...byKey.entries()]
    .map(([key, group]) => ({ [rollupField]: key, dispatches: group.length, usage: sumUsage(group) }))
    .sort((a, b) => String(a[rollupField]).localeCompare(String(b[rollupField])));
}

export function collectHeadlessChannel({ resourceUsageText, rawStreams = [], harness = 'claude' }) {
  const hasLedger = resourceUsageText !== null && resourceUsageText !== undefined;
  const { records, invalidLines: ledgerInvalidLines, retransmissionsDeduplicated } = hasLedger
    ? parseHeadlessRecords(resourceUsageText)
    : { records: [], invalidLines: 0, retransmissionsDeduplicated: 0 };
  const dispatches = records.map((record) => record.dispatch);

  // Raw streams are decoded with the harness the ledger records name — the run
  // knows what wrote it. The `--harness` flag only decides when the ledger is
  // absent or names more than one harness.
  const recordHarnesses = new Set(records.map((record) => record.harness).filter((h) => h !== null));
  const decodeHarness = recordHarnesses.size === 1 ? [...recordHarnesses][0] : harness;

  // Volume: assistant-message / tool-call counts come from the raw event stream
  // (reusing decodeHeadlessEvent); cache-read comes only from ledger rows whose
  // measurement scopes passed accounting classification. Built before the
  // no-ledger return below so on-disk raw captures are never discarded.
  const volumeByPhase = new Map();
  for (const stream of rawStreams) {
    if (typeof stream?.phase !== 'string') continue;
    const { assistantMessages, toolCalls } = countVolume(stream.text, decodeHarness);
    const current = volumeByPhase.get(stream.phase) ?? { key: stream.phase, assistantMessages: 0, toolCalls: 0, cacheRead: 0 };
    current.assistantMessages += assistantMessages;
    current.toolCalls += toolCalls;
    volumeByPhase.set(stream.phase, current);
  }

  if (!hasLedger) {
    // Spend is unavailable without a ledger, but volume evidence read from the
    // raw captures is still real — surface it under the explicit degradation.
    return {
      ...emptyChannel('headless', 'no-headless-ledger'),
      ledgerInvalidLines,
      volumes: [...volumeByPhase.values()].sort((a, b) => a.key.localeCompare(b.key)),
    };
  }

  if (records.length === 0) {
    // The ledger exists but yielded zero valid records (empty text, or every
    // line failed to parse) —
    // this is a distinct degradation from "no ledger at all" so a reader can
    // tell missing evidence from corrupt evidence. Raw-capture volume is kept,
    // same as the no-ledger branch above.
    return {
      ...emptyChannel('headless', 'ledger-empty-or-corrupt'),
      ledgerInvalidLines,
      ...(ledgerInvalidLines === 0 ? {} : {
        accountingCoverage: accountingCoverage([], 0, [], ledgerInvalidLines),
      }),
      volumes: [...volumeByPhase.values()].sort((a, b) => a.key.localeCompare(b.key)),
    };
  }

  // Only observations whose v2 measurement scope is validated as a unique,
  // provider-supported OpenCode step enter accounting rollups. Descriptive labels,
  // overlapping scopes, actor detail, and unknown scopes remain visible rows.
  const phaseRows = records
    .filter((record) => record.dispatch.accountingDisposition === 'included')
    .map((record) => record.dispatch);

  const sessionModels = [];
  const seenSessions = new Set();
  for (const row of dispatches) {
    if (row.session === null || seenSessions.has(row.session)) continue;
    seenSessions.add(row.session);
    sessionModels.push({ session: row.session, resolvedModel: row.resolvedModel });
  }
  sessionModels.sort((a, b) => a.session.localeCompare(b.session));

  for (const row of phaseRows) {
    const key = row.phase;
    if (key === null) continue;
    if (!volumeByPhase.has(key)) volumeByPhase.set(key, { key, assistantMessages: 0, toolCalls: 0, cacheRead: 0 });
    volumeByPhase.get(key).cacheRead += row.usage?.cacheRead ?? 0;
  }

  return {
    channel: 'headless',
    status: 'available',
    reason: null,
    dispatches,
    ledgerInvalidLines,
    // The ledger records phases, not interactive skill attributions.
    skillRollups: [],
    phaseRollups: groupRollup(phaseRows, 'phase', 'phase'),
    sessionRollups: [],
    sessionModels,
    volumes: [...volumeByPhase.values()].sort((a, b) => a.key.localeCompare(b.key)),
    usageUnattributed: usageUnattributed(dispatches),
    accountingCoverage: accountingCoverage(
      records, retransmissionsDeduplicated, [], ledgerInvalidLines,
    ),
  };
}

// --- interactive channel ---------------------------------------------------

// Parses one session file (JSONL) through the C2 descriptor's field paths.
// Returns null for every noninteractive entrypoint, including sdk-cli. Those
// sessions remain unclassified; they never supply headless ledger measurements.
export function parseInteractiveSession(id, text, harness) {
  const descriptor = sessionStoreDescriptor(harness);
  if (!descriptor) return null;

  const dispatch = descriptor.dispatchResult;
  let entrypoint = null;
  let resolvedModel = null;
  let currentSkill = null;
  let assistantMessages = 0;
  let toolCalls = 0;
  let cacheRead = 0;
  const seenMessageIds = new Set();
  const seenDispatchObservations = new Set();
  let retransmissionsDeduplicated = 0;
  const dispatches = [];

  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isObject(record)) continue;

    if (entrypoint === null && typeof descriptor.entrypointField === 'string') {
      const value = getPath(record, descriptor.entrypointField);
      if (typeof value === 'string') entrypoint = value;
    }

    // Skill attribution lives on the assistant message line, not on the
    // `toolUseResult` line. Track it forward so a dispatch row can carry the
    // skill that was in force when the subagent was dispatched.
    if (typeof record[descriptor.skillAttributionField] === 'string') {
      currentSkill = record[descriptor.skillAttributionField];
    }

    // The session's own tool calls: one record per `tool_use` content block.
    // Blocks of one message land on separate lines, so this is per line and
    // deliberately NOT deduplicated by message id — each block is one call.
    const content = getPath(record, 'message.content');
    if (Array.isArray(content)) {
      toolCalls += content.filter((part) => isObject(part) && part.type === 'tool_use').length;
    }

    const model = getPath(record, descriptor.modelField);
    const messageUsage = getPath(record, descriptor.usageField);
    // One API message is stored as one record per content block, each carrying
    // the same message id and the same full-request usage — count a message
    // (and sum its usage) once per id, never once per line.
    const messageId = typeof descriptor.messageIdField === 'string'
      ? getPath(record, descriptor.messageIdField)
      : null;
    const isMessage = model !== null || messageUsage !== null;
    const duplicateBlock = typeof messageId === 'string' && seenMessageIds.has(messageId);
    if (isMessage && !duplicateBlock) {
      if (typeof messageId === 'string') seenMessageIds.add(messageId);
      assistantMessages += 1;
      if (resolvedModel === null && typeof model === 'string') resolvedModel = model;
      cacheRead += normalizeUsage(messageUsage)?.cacheRead ?? 0;
    }

    const result = getPath(record, dispatch.containerField);
    if (isObject(result)) {
      // Only subagent dispatches carry `agentType`; Bash/Read/Edit tool
      // results (shape `{commandName,success}` etc.) do not and must never
      // become dispatch rows.
      const agentType = getPath(result, dispatch.agentTypeField);
      if (typeof agentType !== 'string') continue;
      const observationFingerprint = `sha256:${createHash('sha256').update(line).digest('hex')}`;
      // The line does not carry the skill attribution inherited from its
      // session context. Equal raw bytes alone cannot erase that evidence.
      const observationKey = JSON.stringify([id, currentSkill, observationFingerprint]);
      if (seenDispatchObservations.has(observationKey)) {
        retransmissionsDeduplicated += 1;
        continue;
      }
      seenDispatchObservations.add(observationKey);
      const toolUseCount = getPath(result, dispatch.totalToolUseCountField);
      toolCalls += nonNegativeNumber(toolUseCount) ?? 0;
      const usage = normalizeUsage(getPath(result, dispatch.usageField));
      dispatches.push(dispatchRow({
        channel: 'interactive',
        session: id,
        skill: currentSkill,
        agentType,
        // The store records no requested model for a dispatch — only the
        // resolved one on `toolUseResult`. Null is the honest value; the
        // session's own model is a proxy that fabricates degrades.
        requestedModel: null,
        resolvedModel: typeof getPath(result, dispatch.resolvedModelField) === 'string'
          ? getPath(result, dispatch.resolvedModelField)
          : 'unknown',
        usage,
        observationFingerprint,
        // No supplied official provider source establishes additive semantics
        // for interactive session-store dispatch results.
        aggregationEligibility: 'unknown',
        accountingDisposition: usage === null
          ? 'excluded-missing-usage'
          : 'excluded-unknown-scope',
      }));
    }
  }

  // Only a session whose entrypoint is the harness's interactive marker belongs
  // to this channel. A missing or other entrypoint, including sdk-cli,
  // belongs to neither channel — its spend is unclassifiable, never
  // silently folded into this channel (A4).
  if (entrypoint !== descriptor.entrypointValues?.interactive) return null;

  return {
    session: id, resolvedModel, assistantMessages, toolCalls, cacheRead, dispatches,
    retransmissionsDeduplicated,
  };
}

export function collectInteractiveChannel({ harness = 'claude', sessions }) {
  const descriptor = sessionStoreDescriptor(harness);
  if (!descriptor) return emptyChannel('interactive', 'no-session-store-descriptor');
  if (sessions === null || sessions === undefined) return emptyChannel('interactive', 'store-unreadable');

  const dispatches = [];
  const sessionModels = [];
  const volumes = [];
  const sessionRows = [];
  const seenObservations = new Set();
  let retransmissionsDeduplicated = 0;

  for (const entry of sessions) {
    const id = typeof entry?.id === 'string' ? entry.id : null;
    const session = parseInteractiveSession(id, entry?.text, harness);
    if (session === null || id === null) continue;
    retransmissionsDeduplicated += session.retransmissionsDeduplicated;
    const rows = [];
    for (const dispatch of session.dispatches) {
      // The retained row includes session-file identity and skill context,
      // besides raw-line identity and every other retained dispatch field.
      const key = canonicalJson([harness, dispatch]);
      if (seenObservations.has(key)) {
        retransmissionsDeduplicated += 1;
        continue;
      }
      seenObservations.add(key);
      dispatches.push(dispatch);
      rows.push(dispatch);
    }
    sessionRows.push({ session: id, rows });
    sessionModels.push({ session: id, resolvedModel: session.resolvedModel ?? 'unknown' });
    volumes.push({
      key: id,
      assistantMessages: session.assistantMessages,
      toolCalls: session.toolCalls,
      cacheRead: session.cacheRead,
    });
  }

  sessionModels.sort((a, b) => a.session.localeCompare(b.session));
  volumes.sort((a, b) => a.key.localeCompare(b.key));
  const includedRows = dispatches.filter((row) => row.accountingDisposition === 'included');

  return {
    channel: 'interactive',
    status: 'available',
    reason: null,
    dispatches,
    skillRollups: groupRollup(includedRows, 'skill', 'skill'),
    phaseRollups: [],
    sessionRollups: sessionRows
      .map(({ session, rows }) => ({
        session,
        rows: rows.filter((row) => row.accountingDisposition === 'included'),
      }))
      .filter(({ rows }) => rows.length > 0)
      .map(({ session, rows }) => ({ session, dispatches: rows.length, usage: sumUsage(rows) }))
      .sort((a, b) => a.session.localeCompare(b.session)),
    sessionModels,
    volumes,
    usageUnattributed: usageUnattributed(dispatches),
    accountingCoverage: accountingCoverage([], retransmissionsDeduplicated, dispatches),
  };
}

// --- report assembly -------------------------------------------------------

export function buildReport({
  harness = 'claude',
  headlessResourceUsageText,
  headlessRawStreams = [],
  interactiveSessions,
  unclassifiedSessions = [],
}) {
  return {
    // Bump on any change to row shape, field vocabulary, or rollup semantics.
    schemaVersion: 7,
    channels: {
      headless: collectHeadlessChannel({
        resourceUsageText: headlessResourceUsageText, rawStreams: headlessRawStreams,
        harness,
      }),
      interactive: collectInteractiveChannel({ harness, sessions: interactiveSessions }),
    },
    // Sessions whose entrypoint is missing or unrecognized (A4): they feed
    // neither channel above, so this list is their only trace in the report —
    // never a silent drop, never a silent misclassification into either
    // channel. `partitionSessions` computes and sorts it; this is a plain
    // carry-through into the report's top-level shape.
    unclassifiedSessions,
  };
}

// --- CLI -------------------------------------------------------------------

function phaseName(phaseNumber) {
  return PHASES[phaseNumber - 1] ?? `phase-${phaseNumber}`;
}

// Reads the headless channel from `<repo-root>/.apex/work/tasks/**`. Returns
// `{ resourceUsageText: null }` when no ledger exists or it is unreadable. The
// walk itself (does the tasks dir exist / can it be listed) is the only thing
// that blanks the whole channel; each spec dir underneath gets its own
// try/catch so one unreadable entry (dangling symlink, permission-denied,
// racing delete, or a work-path containment rejection) degrades only its own
// data — same per-entry policy as `readSessionStore`'s `visit()`, not a new
// one. Every ledger/raw byte is read through `work-paths.mjs`'s confined
// `work-output` reads, and spec-dir entries are inspected with `lstatSync`,
// which never follows a symlink: a symlinked or otherwise non-ordinary entry
// or artifact is rejected instead of read, so zero bytes are read from outside
// the repository however the tasks tree is shaped.
function readHeadlessChannel(repoRoot) {
  const tasksDir = join(repoRoot, '.apex', 'work', 'tasks');
  const rawStreams = [];
  let resourceUsageText = null;
  let specNames;
  try {
    if (!existsSync(tasksDir)) return { resourceUsageText: null, rawStreams };
    specNames = readdirSync(tasksDir);
  } catch {
    return { resourceUsageText: null, rawStreams };
  }
  let foundLedger = false;
  for (const specName of specNames) {
    const specDir = join(tasksDir, specName);
    const entryPrefix = `.apex/work/tasks/${specName}`;
    try {
      if (!lstatSync(specDir).isDirectory()) continue;
      let ledgerStat = null;
      try {
        ledgerStat = lstatSync(join(specDir, 'resource-usage.jsonl'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (ledgerStat !== null) {
        // Under `lstatSync` a symlink is not a file, so this rejects symlinked
        // and non-ordinary ledgers (a containment failure) rather than reading
        // through them; the per-entry catch degrades this spec dir only.
        if (!ledgerStat.isFile()) {
          throw new Error(`work path: non-ordinary ledger blocks '${entryPrefix}/resource-usage.jsonl'`);
        }
        const ledgerText = readWorkPath(
          repoRoot,
          `${entryPrefix}/resource-usage.jsonl`,
          { expect: 'work-output', family: 'ledger', encoding: 'utf8' },
        );
        const boundary = resourceUsageText !== null && !resourceUsageText.endsWith('\n') ? '\n' : '';
        resourceUsageText = `${resourceUsageText ?? ''}${boundary}${ledgerText}`;
        foundLedger = true;
      }
      for (const name of readdirSync(specDir)) {
        // The canonical raw-artifact grammar of `work-paths.mjs` (no leading
        // zeros): a non-canonical name is never normalized into a read.
        const match = name.match(/^phase-([1-9]\d*)-attempt-([1-9]\d*)\.raw\.jsonl$/);
        if (!match) continue;
        rawStreams.push({
          phase: phaseName(Number(match[1])),
          attempt: Number(match[2]),
          text: readWorkPath(repoRoot, `${entryPrefix}/${name}`, { expect: 'work-output', family: 'raw', encoding: 'utf8' }),
        });
      }
    } catch {
      continue; // containment rejection, dangling symlink, permission-denied entry, racing delete — this spec dir only
    }
  }
  if (!foundLedger) return { resourceUsageText: null, rawStreams };
  return { resourceUsageText, rawStreams };
}

// First recorded working directory of a session file — the field that scopes a
// session to a repo. Null when no record carries one.
function sessionCwd(text, descriptor) {
  if (typeof descriptor.cwdField !== 'string') return null;
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isObject(record)) continue;
    const value = record[descriptor.cwdField];
    if (typeof value === 'string') return value;
  }
  return null;
}

// Reads session files from the C2 descriptor's store root (or the exact override)
// (computed from node:os homedir(), never a machine-specific literal). The
// store is machine-wide. Repository attribution happens after each file is
// read, so this filter is not a filesystem access boundary. Each session is
// kept only when its recorded working
// directory resolves to `repoRoot` — a session with no recorded cwd cannot be
// attributed to a repo and is excluded from a repo-scoped report; non-matching
// text is discarded immediately so memory stays bounded by this repo's
// sessions, not the whole store. Returns `{ sessions: null }` when the store
// root is absent/unreadable; a single unreadable entry inside an otherwise
// readable store is skipped, never allowed to blank the whole channel. The
// caller routes each session to its channel by entrypoint.
export function readSessionStore(harness, repoRoot, { rootPath } = {}) {
  const descriptor = sessionStoreDescriptor(harness);
  if (!descriptor) return { sessions: null };
  const root = rootPath ?? descriptor.rootPath;
  const sessions = [];
  if (!existsSync(root)) return { sessions: null };
  let rootEntries;
  try {
    rootEntries = readdirSync(root);
  } catch {
    return { sessions: null };
  }
  const visit = (dir, names) => {
    for (const name of names) {
      // Subagent transcripts under `<session-id>/subagents/` repeat spend the
      // parent session already carries on its dispatch rows (interactive) or
      // the autopilot ledger (headless) — never ingest them as sessions.
      if (name === 'subagents') continue;
      const full = join(dir, name);
      try {
        // `lstatSync` never follows a symlink, so a symlinked entry (whether
        // a directory pointing back into this tree, e.g. a circular loop, or
        // a `.jsonl` file pointing outside the store root) is skipped
        // outright rather than walked or read — no visited-set, realpath, or
        // depth limit is needed once symlinks are never followed.
        const entryStat = lstatSync(full);
        if (entryStat.isSymbolicLink()) continue;
        if (entryStat.isDirectory()) {
          visit(full, readdirSync(full));
          continue;
        }
        if (!name.endsWith('.jsonl')) continue;
        const text = readFileSync(full, 'utf8');
        if (!sameRepo(sessionCwd(text, descriptor), repoRoot)) continue;
        sessions.push({ id: basename(name, '.jsonl'), text });
      } catch {
        continue; // permission-denied entry, racing delete — a dangling symlink is already skipped above
      }
    }
  };
  visit(root, rootEntries);
  return { sessions };
}

// Two working-directory strings denote the same repo when their resolved paths
// agree; this scopes a session to the `--repo-root` it was spawned for
// without relying on the harness's project-directory naming convention.
function sameRepo(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) return false;
  return resolve(a) === resolve(b);
}

// First recorded entrypoint field of a session file — a single-field scan
// independent of the channel parsers (mirrors `sessionCwd`), so a session can
// be classified even when `parseInteractiveSession` does not accept it. Null when no record carries one.
function sessionEntrypoint(text, descriptor) {
  if (typeof descriptor.entrypointField !== 'string') return null;
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isObject(record)) continue;
    const value = getPath(record, descriptor.entrypointField);
    if (typeof value === 'string') return value;
  }
  return null;
}

// Keep only the provider's explicit interactive entrypoint in the session-store
// channel. Other entrypoints, including sdk-cli, remain listed as unclassified;
// headless accounting comes exclusively from the current conductor ledger.
export function partitionSessions({ sessions, harness }) {
  const descriptor = sessionStoreDescriptor(harness);
  if (sessions === null || sessions === undefined || !descriptor) {
    return { interactiveSessions: null, unclassifiedSessions: [] };
  }

  const interactiveSessions = [];
  const unclassifiedSessions = [];
  for (const session of sessions) {
    const entrypoint = sessionEntrypoint(session.text, descriptor);
    if (entrypoint === descriptor.entrypointValues?.interactive) {
      interactiveSessions.push(session);
    } else {
      unclassifiedSessions.push({ session: session.id, entrypoint });
    }
  }
  unclassifiedSessions.sort((a, b) => a.session.localeCompare(b.session));

  return { interactiveSessions, unclassifiedSessions };
}

export async function main(argv = process.argv.slice(2), opts = {}) {
  const usage = 'usage: node scripts/cost-report.mjs --repo-root <root> [--harness <id>] [--session-store-root <root> | --no-session-store]';
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        'repo-root': { type: 'string' },
        harness: { type: 'string', default: 'claude' },
        'session-store-root': { type: 'string' },
        'no-session-store': { type: 'boolean', default: false },
      },
    }));
  } catch {
    console.error(usage);
    return 1;
  }

  const repoRoot = values['repo-root'] ?? opts.repoRoot;
  if (typeof repoRoot !== 'string' || repoRoot.length === 0
    || values['session-store-root'] === ''
    || (values['session-store-root'] !== undefined && values['no-session-store'])) {
    console.error(usage);
    return 1;
  }

  const harness = values.harness;
  const headless = readHeadlessChannel(repoRoot);
  const store = values['no-session-store']
    ? { sessions: null }
    : readSessionStore(harness, repoRoot, { rootPath: values['session-store-root'] });

  // Attribute session-store records separately from ledger-backed headless usage.
  const { interactiveSessions, unclassifiedSessions } = partitionSessions({
    sessions: store.sessions,
    harness,
  });

  const report = buildReport({
    harness,
    headlessResourceUsageText: headless.resourceUsageText,
    headlessRawStreams: headless.rawStreams,
    interactiveSessions,
    unclassifiedSessions,
  });
  if (values['no-session-store']) report.channels.interactive = emptyChannel('interactive', 'store-disabled');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Never `process.exit` here: it fires before the report write drains, so a
  // report larger than the pipe buffer (64KB) is truncated mid-JSON when
  // stdout is a pipe. `exitCode` lets the process end naturally.
  process.exitCode = await main();
}

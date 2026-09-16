import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COST_WEIGHT_TABLE_SOURCE,
  TRIAGE_WEIGHTS,
  buildReport,
  collectHeadlessChannel,
  collectInteractiveChannel,
  countVolume,
  normalizeUsage,
  parseHeadlessDispatches,
  parseInteractiveSession,
  partitionSessions,
  readSessionStore,
  weightedTotal,
} from '../scripts/cost-report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const scriptPath = join(here, '..', 'scripts', 'cost-report.mjs');
const fixtures = join(here, 'fixtures', 'cost-report');
const headlessFixture = () => readFileSync(join(fixtures, 'headless-resource-usage.jsonl'), 'utf8');
const headlessFixtureLines = () => headlessFixture().trim().split('\n');
const observationHeadlessFixture = () => headlessFixtureLines().slice(0, 6).join('\n');
const coverageHeadlessFixture = () => headlessFixtureLines().slice(6).join('\n');
const interactiveFixture = () => readFileSync(join(fixtures, 'interactive-sessions.jsonl'), 'utf8');

const USAGE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];

const opencodeStepRecord = ({
  runId = 'run-modern', phase = 'implement', attempt = 1, sessionId = 'ses-modern',
  messageId = 'msg-1', partId = 'prt-1', fingerprint = `sha256:${'a'.repeat(64)}`,
  harness = 'opencode',
  providerVersion = '1.18.27',
  includeProviderVersion = true,
  usage = { inputTokens: 10, outputTokens: 2 },
} = {}) => ({
  schemaVersion: 2,
  runId,
  phase,
  attempt,
  harness,
  sessionId,
  observationFingerprint: fingerprint,
  observationScope: { kind: 'session', sessionId },
  measurementId: `opencode:step:${sessionId}:${messageId}:${partId}`,
  measurementScope: { provider: 'opencode', kind: 'step', sessionId, messageId, partId },
  ...(includeProviderVersion ? { providerVersion } : {}),
  aggregationEligibility: 'provider-measurement',
  requestedModelTier: 'standard',
  resolvedModel: 'open-model',
  usage,
});

const cloneRecord = (record) => JSON.parse(JSON.stringify(record));

const claudeMessage = (text) => JSON.stringify({
  type: 'assistant',
  session_id: 's',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

const claudeTool = (id, name) => JSON.stringify({
  type: 'assistant',
  session_id: 's',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
});

const rawStream = (lines) => lines.map(
  (line) => JSON.stringify({ timestamp: '2026-08-11T10:00:00.000Z', sourceStream: 'stdout', line }),
).join('\n');

describe('resource-accounting documentation contract', () => {
  it('distinguishes retransmission identity from measurement scope and documents partial coverage', () => {
    const conventions = readFileSync(join(repoRoot, '.apex', 'conventions.md'), 'utf8');
    const scriptsStandard = readFileSync(join(repoRoot, '.apex', 'standards', 'scripts.md'), 'utf8');
    const architecture = readFileSync(join(repoRoot, 'docs/architecture.md'), 'utf8');

    for (const text of [conventions, scriptsStandard]) {
      const prose = text.replace(/\s+/g, ' ');
      assert.match(prose, /observation identity/i);
      assert.match(prose, /measurement scope/i);
      assert.match(prose, /conflicting retransmission evidence/i);
      assert.match(prose, /provably disjoint/i);
      assert.match(prose, /unknown.*?not zero/i);
      assert.match(prose, /eligibility label.*?insufficient/i);
      assert.match(prose, /runtime provider-version evidence/i);
      assert.match(prose, /OpenCode usage accounting accepts only the provider version verified by `adapters\/headless-events\.mjs` and `scripts\/cost-report\.mjs`/i);
      assert.match(prose, /missing or different versions stay unknown/i);
      assert.match(prose, /restriction concerns usage accounting, not general OpenCode support/i);
      assert.match(prose, /interactive.*?observations.*?excluded/i);
      assert.match(prose, /unknown-scope observations.*?retained/i);
      assert.match(prose, /missing-usage completions.*?durable/i);
    }
    assert.match(architecture, /schema version 7/i);
    assert.match(architecture, /accounting coverage/i);
    assert.match(architecture, /unknown[^\n]*not zero/i);
    assert.match(architecture.replace(/\s+/g, ' '), /runtime provider-version evidence/i);
    assert.match(architecture, /OpenCode v1\.18\.27/i);
    assert.match(architecture.replace(/\s+/g, ' '), /conflicting retransmission evidence/i);
    assert.match(architecture.replace(/\s+/g, ' '), /interactive.*?observations.*?excluded/i);
    assert.match(architecture.replace(/\s+/g, ' '), /unknown-scope observations.*?retained/i);
    assert.match(architecture.replace(/\s+/g, ' '), /missing-usage completions.*?durable/i);
  });
});

describe('normalizeUsage', () => {
  it('maps Claude provider usage fields into canonical categories', () => {
    assert.deepEqual(normalizeUsage({
      input_tokens: 120,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 4,
      output_tokens: 32,
    }), { input: 120, output: 32, cacheRead: 30, cacheWrite: 4, reasoning: 0 });
  });

  it('maps the already-normalized ledger fields and zero-fills absent categories', () => {
    assert.deepEqual(normalizeUsage({
      inputTokens: 10, outputTokens: 0,
    }), { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
  });

  it('maps reasoning tokens — a category the ledger writer persists — into the reasoning slot', () => {
    assert.deepEqual(normalizeUsage({ reasoning_tokens: 7 }), {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 7,
    });
    assert.equal(normalizeUsage({ reasoningTokens: 12 }).reasoning, 12);
  });

  it('returns null when no category is present (a record missing usage)', () => {
    assert.equal(normalizeUsage(null), null);
    assert.equal(normalizeUsage({}), null);
    assert.equal(normalizeUsage({ turns: 3 }), null);
  });
});

describe('headless channel', () => {
  it('emits one dispatch row per ledger record with channel/session/phase/agent-type/model/usage', () => {
    const dispatches = parseHeadlessDispatches(observationHeadlessFixture());
    assert.equal(dispatches.length, 6);
    const [plan, impl1, impl2, impl3, review, actor] = dispatches;

    assert.deepEqual(plan, {
      channel: 'headless',
      session: 'sess-plan-1',
      skill: null,
      phase: 'plan',
      agentType: null,
      requestedModel: 'most-capable',
      resolvedModel: 'opus',
      usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 10, reasoning: 0 },
      aggregationEligibility: 'unknown',
      observationFingerprint: `sha256:${'a'.repeat(64)}`,
      measurementId: null,
      measurementScope: null,
      accountingDisposition: 'excluded-unknown-scope',
    });

    assert.equal(impl1.requestedModel, 'standard');
    assert.equal(impl1.resolvedModel, 'sonnet');
    assert.equal(impl1.phase, 'implement');
    assert.equal(impl1.skill, null, 'the ledger records a phase, never a skill');

    assert.equal(impl3.resolvedModel, 'unknown', 'a dispatch missing resolvedModel must be resolved=unknown');
    assert.equal(impl3.requestedModel, 'standard');

    assert.equal(review.usage, null, 'a record missing usage must never be imputed as zero');
    assert.equal(review.resolvedModel, 'sonnet');

    assert.equal(actor.agentType, 'subagent');
    assert.equal(actor.resolvedModel, 'opus');
    assert.deepEqual(actor.usage, { input: 100, output: 50, cacheRead: 1000, cacheWrite: 0, reasoning: 0 });
    assert.equal(
      actor.aggregationEligibility, 'nested-actor-detail',
      'a nested-actor-detail row must be marked so a consumer summing dispatches can exclude it',
    );

    for (const row of dispatches) {
      assert.ok(USAGE_KEYS.every((k) => k in (row.usage ?? { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, reasoning: 1 })));
    }
  });

  it('rejects unsupported and missing ledger versions without retaining dispatch rows', () => {
    for (const version of [1, 3, undefined]) {
      const record = opencodeStepRecord();
      if (version === undefined) delete record.schemaVersion;
      else record.schemaVersion = version;
      const report = collectHeadlessChannel({ resourceUsageText: JSON.stringify(record) });
      assert.equal(report.status, 'CHANNEL_UNAVAILABLE');
      assert.deepEqual(report.dispatches, []);
      assert.equal(report.ledgerInvalidLines, 1);
      assert.equal(report.accountingCoverage.invalidOrUnclassifiable, 1);
      assert.equal(report.accountingCoverage.observations, 1);
    }
  });

  it('does not translate obsolete eligibility labels into accounting claims', () => {
    const record = { ...opencodeStepRecord(), aggregationEligibility: 'exclusive-phase-aggregate' };
    const [row] = parseHeadlessDispatches(JSON.stringify(record));
    assert.equal(row.aggregationEligibility, 'unknown');
    assert.equal(row.accountingDisposition, 'included', 'measurement evidence, not the obsolete label, proves scope');
  });

  it('excludes unknown-scope phase observations from totals and reports their accounting coverage explicitly', () => {
    const report = collectHeadlessChannel({ resourceUsageText: observationHeadlessFixture(), harness: 'claude' });
    assert.equal(report.status, 'available');

    assert.deepEqual(
      report.skillRollups, [],
      'the ledger has no skill vocabulary — a phase renamed to a skill can never join the interactive channel and double-counts when both rollups are summed',
    );

    assert.deepEqual(report.phaseRollups, []);
    assert.equal(report.usageUnattributed, 1, 'the review row missing usage is counted, never dropped');
    assert.deepEqual(report.accountingCoverage, {
      status: 'unknown', observations: 6, included: 0, excludedOverlap: 0,
      excludedUnknownScope: 4, excludedActorDetail: 1,
      usageUnattributed: 1, invalidOrUnclassifiable: 0, retransmissionsDeduplicated: 0,
    });
  });

  it('carries ledger reasoning tokens into rollups instead of silently dropping the category', () => {
    const ledger = JSON.stringify(opencodeStepRecord({
      runId: 'run-r', sessionId: 'sess-r', messageId: 'msg-r', partId: 'prt-r',
      usage: { reasoningTokens: 12 },
    }));
    const report = collectHeadlessChannel({ resourceUsageText: ledger, harness: 'claude' });
    assert.deepEqual(report.dispatches[0].usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 12 });
    assert.equal(report.usageUnattributed, 0, 'a record whose only category is reasoning is attributed, not dropped');
    assert.equal(report.phaseRollups[0].usage.reasoning, 12);
  });

  it('sums only unique provider-step scopes and diagnoses retransmission, overlap, unknown, actor, unsupported, and missing coverage', () => {
    const report = collectHeadlessChannel({ resourceUsageText: coverageHeadlessFixture(), harness: 'claude' });

    assert.deepEqual(report.phaseRollups, [{
      phase: 'implement', dispatches: 2,
      usage: { input: 30, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    }]);
    assert.deepEqual(report.accountingCoverage, {
      status: 'partial', observations: 8, included: 2, excludedOverlap: 2,
      excludedUnknownScope: 1, excludedActorDetail: 1,
      usageUnattributed: 1, invalidOrUnclassifiable: 1, retransmissionsDeduplicated: 1,
    });
    const dispositions = report.dispatches.map(({ accountingDisposition }) => accountingDisposition);
    assert.deepEqual(dispositions, [
      'included', 'included', 'excluded-overlap', 'excluded-overlap',
      'excluded-unknown-scope', 'excluded-actor-detail', 'excluded-missing-usage',
    ]);
  });

  it('treats reordered JSON keys as the same measurement scope', () => {
    const first = opencodeStepRecord();
    const second = {
      ...opencodeStepRecord({ fingerprint: `sha256:${'b'.repeat(64)}` }),
      measurementScope: {
        partId: 'prt-1', provider: 'opencode', messageId: 'msg-1',
        kind: 'step', sessionId: 'ses-modern',
      },
    };
    const report = collectHeadlessChannel({
      resourceUsageText: [first, second].map((record) => JSON.stringify(record)).join('\n'),
      harness: 'opencode',
    });

    assert.equal(report.accountingCoverage.included, 0);
    assert.equal(report.accountingCoverage.excludedOverlap, 2);
    assert.deepEqual(report.phaseRollups, []);
  });

  it('requires run, phase, and attempt evidence before including a provider-step measurement', () => {
    for (const missing of ['runId', 'phase', 'attempt']) {
      const record = opencodeStepRecord();
      delete record[missing];
      const report = collectHeadlessChannel({
        resourceUsageText: JSON.stringify(record),
        harness: 'opencode',
      });

      assert.equal(report.accountingCoverage.included, 0, `${missing} must be accounting evidence`);
      assert.equal(
        report.accountingCoverage.excludedUnknownScope + report.accountingCoverage.invalidOrUnclassifiable,
        1,
      );
      assert.deepEqual(report.phaseRollups, []);
    }
  });

  it('admits only canonical, meaningful provider-measurement provenance', () => {
    const invalidValues = {
      runId: [undefined, '', '   ', 42, 'run/id'],
      phase: [undefined, '', '   ', 42, 'deploy'],
      attempt: [undefined, '', '   ', 1.5, 0],
      harness: [undefined, '', '   ', 42, 'OpenCode'],
      sessionId: [undefined, '', '   ', 42, 'session/id'],
      provider: [undefined, '', '   ', 42, 'OpenCode'],
      messageId: [undefined, '', '   ', 42, 'message/id'],
      partId: [undefined, '', '   ', 42, 'part/id'],
    };

    for (const [field, values] of Object.entries(invalidValues)) {
      for (const value of values) {
        const record = opencodeStepRecord();
        if (field === 'provider') record.measurementScope.provider = value;
        else if (field === 'messageId') record.measurementScope.messageId = value;
        else if (field === 'partId') record.measurementScope.partId = value;
        else if (field === 'sessionId') {
          record.sessionId = value;
          record.observationScope.sessionId = value;
          record.measurementScope.sessionId = value;
        } else record[field] = value;
        const scope = record.measurementScope;
        record.measurementId = `opencode:step:${scope.sessionId}:${scope.messageId}:${scope.partId}`;

        const report = collectHeadlessChannel({
          resourceUsageText: JSON.stringify(record),
          harness: 'opencode',
        });
        assert.equal(report.accountingCoverage.included, 0, `${field}=${JSON.stringify(value)}`);
        assert.equal(
          report.accountingCoverage.excludedUnknownScope + report.accountingCoverage.invalidOrUnclassifiable,
          1,
          `${field}=${JSON.stringify(value)}`,
        );
        assert.deepEqual(report.phaseRollups, [], `${field}=${JSON.stringify(value)}`);
        assert.notEqual(report.accountingCoverage.status, 'complete', `${field}=${JSON.stringify(value)}`);
      }
    }
  });

  it('detects one provider measurement across conductor attempts, runs, and phases', () => {
    const variants = [
      { label: 'attempt', fingerprintByte: 'c', changes: { attempt: 2 } },
      { label: 'run', fingerprintByte: 'd', changes: { runId: 'run-other' } },
      { label: 'phase', fingerprintByte: 'e', changes: { phase: 'review' } },
    ];
    for (const { label, fingerprintByte, changes } of variants) {
      const first = opencodeStepRecord();
      const second = opencodeStepRecord({
        ...changes,
        fingerprint: `sha256:${fingerprintByte.repeat(64)}`,
      });
      const report = collectHeadlessChannel({
        resourceUsageText: [first, second].map((record) => JSON.stringify(record)).join('\n'),
        harness: 'opencode',
      });

      assert.deepEqual(
        report.dispatches.map((row) => row.accountingDisposition),
        ['excluded-overlap', 'excluded-overlap'],
        `${label} attribution cannot make one provider measurement disjoint`,
      );
      assert.deepEqual(report.phaseRollups, []);
    }
  });

  it('deduplicates only compatible observations and adds distinct provider parts', () => {
    const retransmitted = collectHeadlessChannel({
      resourceUsageText: [
        opencodeStepRecord(),
        opencodeStepRecord(),
      ].map((record) => JSON.stringify(record)).join('\n'),
      harness: 'opencode',
    });
    assert.equal(retransmitted.dispatches.length, 1);
    assert.equal(retransmitted.accountingCoverage.retransmissionsDeduplicated, 1);
    assert.equal(retransmitted.accountingCoverage.included, 1);

    const disjoint = collectHeadlessChannel({
      resourceUsageText: [
        opencodeStepRecord({ partId: 'prt-a' }),
        opencodeStepRecord({ partId: 'prt-b', fingerprint: `sha256:${'b'.repeat(64)}` }),
      ].map((record) => JSON.stringify(record)).join('\n'),
      harness: 'opencode',
    });
    assert.equal(disjoint.accountingCoverage.included, 2);
    assert.equal(disjoint.phaseRollups[0].dispatches, 2);
  });

  it('reconciles every conflicting observation-evidence permutation conservatively', () => {
    const mutations = [
      ['missing provider version', (record) => { delete record.providerVersion; }],
      ['mismatched provider version', (record) => { record.providerVersion = '1.18.26'; }],
      ['absent measurement identity', (record) => { delete record.measurementId; }],
      ['conflicting measurement identity', (record) => { record.measurementId = 'opencode:step:ses-modern:msg-1:prt-other'; }],
      ['absent measurement scope', (record) => { delete record.measurementScope; }],
      ['conflicting measurement scope', (record) => {
        record.measurementScope.partId = 'prt-other';
        record.measurementId = 'opencode:step:ses-modern:msg-1:prt-other';
      }],
      ['conflicting retained usage', (record) => { record.usage.inputTokens = 11; }],
      ['conflicting run', (record) => { record.runId = 'run-other'; }],
      ['conflicting phase', (record) => { record.phase = 'review'; }],
      ['conflicting attempt', (record) => { record.attempt = 2; }],
    ];

    for (const [label, mutate] of mutations) {
      const supported = opencodeStepRecord();
      const conflicting = cloneRecord(supported);
      mutate(conflicting);
      const results = [
        [supported, conflicting],
        [conflicting, supported],
      ].map((records) => collectHeadlessChannel({
        resourceUsageText: records.map((record) => JSON.stringify(record)).join('\n'),
        harness: 'opencode',
      }));

      for (const report of results) {
        assert.equal(report.dispatches.length, 1, label);
        assert.equal(report.dispatches[0].accountingDisposition, 'excluded-conflicting-observation', label);
        assert.equal(report.dispatches[0].usage, null, label);
        assert.equal(report.dispatches[0].measurementId, null, label);
        assert.equal(report.dispatches[0].measurementScope, null, label);
        assert.deepEqual(report.phaseRollups, [], label);
        assert.deepEqual(report.accountingCoverage, {
          status: 'unknown', observations: 1, included: 0, excludedOverlap: 0,
          excludedUnknownScope: 0, excludedActorDetail: 0,
          usageUnattributed: 0, invalidOrUnclassifiable: 1, retransmissionsDeduplicated: 0,
        }, label);
      }
      assert.deepEqual(results[0], results[1], `${label} must not depend on ledger order`);
    }
  });

  it('keeps conflicting observations in provider-collision analysis in every order', () => {
    const supported = opencodeStepRecord();
    const incompatible = cloneRecord(supported);
    delete incompatible.providerVersion;
    const colliding = opencodeStepRecord({ fingerprint: `sha256:${'b'.repeat(64)}` });
    const permutations = [
      [supported, incompatible, colliding],
      [supported, colliding, incompatible],
      [incompatible, supported, colliding],
      [incompatible, colliding, supported],
      [colliding, supported, incompatible],
      [colliding, incompatible, supported],
    ];

    for (const records of permutations) {
      const report = collectHeadlessChannel({
        resourceUsageText: records.map((record) => JSON.stringify(record)).join('\n'),
        harness: 'opencode',
      });
      assert.deepEqual(
        report.dispatches.map((row) => row.accountingDisposition).sort(),
        ['excluded-conflicting-observation', 'excluded-overlap'],
      );
      assert.deepEqual(report.phaseRollups, []);
      assert.deepEqual(report.accountingCoverage, {
        status: 'unknown', observations: 2, included: 0, excludedOverlap: 1,
        excludedUnknownScope: 0, excludedActorDetail: 0,
        usageUnattributed: 0, invalidOrUnclassifiable: 1, retransmissionsDeduplicated: 0,
      });
    }
  });

  it('includes only the evidence-backed OpenCode version and exposes its provenance', () => {
    const cases = [
      { label: 'supported', record: opencodeStepRecord(), disposition: 'included' },
      { label: 'missing', record: opencodeStepRecord({ includeProviderVersion: false }), disposition: 'excluded-unknown-scope' },
      { label: 'mismatched', record: opencodeStepRecord({ providerVersion: '1.18.26' }), disposition: 'excluded-unknown-scope' },
    ];
    for (const { label, record, disposition } of cases) {
      const report = collectHeadlessChannel({
        resourceUsageText: JSON.stringify(record),
        harness: 'opencode',
      });
      assert.equal(report.dispatches[0].accountingDisposition, disposition, label);
      assert.equal(report.accountingCoverage.included, disposition === 'included' ? 1 : 0, label);
      if (label === 'supported') assert.equal(report.dispatches[0].providerVersion, '1.18.27');
    }
  });

  it('reports the resolved model per session independently of volume', () => {
    const report = collectHeadlessChannel({ resourceUsageText: observationHeadlessFixture(), harness: 'claude' });
    const bySession = (id) => report.sessionModels.find((m) => m.session === id);
    assert.deepEqual(bySession('sess-plan-1'), { session: 'sess-plan-1', resolvedModel: 'opus' });
    assert.deepEqual(bySession('sess-impl-2'), { session: 'sess-impl-2', resolvedModel: 'opus-5' });
    assert.deepEqual(bySession('sess-impl-3'), { session: 'sess-impl-3', resolvedModel: 'unknown' });
  });

  it('derives headless volume from the raw event stream (message/tool counts) plus ledger cache-read', () => {
    const rawStreams = [
      { phase: 'plan', text: rawStream([claudeMessage('a'), claudeTool('t1', 'Bash')]) },
      { phase: 'implement', text: rawStream([claudeMessage('a'), claudeMessage('b'), claudeMessage('c'), claudeTool('t1', 'Bash'), claudeTool('t2', 'Read')]) },
      { phase: 'review', text: rawStream([claudeMessage('a'), claudeMessage('b')]) },
    ];
    const report = collectHeadlessChannel({ resourceUsageText: observationHeadlessFixture(), rawStreams, harness: 'claude' });

    const volume = (phase) => report.volumes.find((v) => v.key === phase);
    assert.deepEqual(volume('plan'), { key: 'plan', assistantMessages: 1, toolCalls: 1, cacheRead: 0 });
    assert.deepEqual(volume('implement'), { key: 'implement', assistantMessages: 3, toolCalls: 2, cacheRead: 0 });
    assert.deepEqual(volume('review'), { key: 'review', assistantMessages: 2, toolCalls: 0, cacheRead: 0 });
  });

  it('decodes raw streams with the harness the ledger records name, not the --harness flag', () => {
    const ledger = JSON.stringify(opencodeStepRecord({
      runId: 'run-oc', sessionId: 'ses_1', messageId: 'msg-1', partId: 'prt-1',
      usage: { cacheReadTokens: 5 },
    }));
    const opencodeEvent = (type, extra) => JSON.stringify({
      type, sessionID: 'ses_1', part: { type, sessionID: 'ses_1', ...extra },
    });
    const rawStreams = [{
      phase: 'implement',
      text: rawStream([
        opencodeEvent('text', { text: 'hello' }),
        opencodeEvent('tool_use', { tool: 'bash', callID: 'call-1', state: { status: 'completed' } }),
        opencodeEvent('text', { text: 'done' }),
      ]),
    }];
    // The report is run without --harness (default 'claude'); the volumes must
    // still decode, not silently read zero under an 'available' status.
    const report = collectHeadlessChannel({ resourceUsageText: ledger, rawStreams, harness: 'claude' });
    assert.deepEqual(report.volumes, [{ key: 'implement', assistantMessages: 2, toolCalls: 1, cacheRead: 5 }]);
  });

  it('reports CHANNEL_UNAVAILABLE, never zero spend, when the ledger is missing', () => {
    const report = collectHeadlessChannel({ resourceUsageText: null, harness: 'claude' });
    assert.equal(report.status, 'CHANNEL_UNAVAILABLE');
    assert.equal(report.reason, 'no-headless-ledger');
    assert.deepEqual(report.dispatches, []);
    assert.deepEqual(report.phaseRollups, []);
  });

  it('reports CHANNEL_UNAVAILABLE with a distinct reason when the ledger text is empty (A1)', () => {
    const report = collectHeadlessChannel({ resourceUsageText: '', harness: 'claude' });
    assert.equal(report.status, 'CHANNEL_UNAVAILABLE');
    assert.equal(report.reason, 'ledger-empty-or-corrupt');
    assert.equal(report.ledgerInvalidLines, 0);
  });

  it('reports CHANNEL_UNAVAILABLE and counts every malformed line when the ledger has content but no valid record (A1)', () => {
    const report = collectHeadlessChannel({
      resourceUsageText: 'not json\nalso not json',
      harness: 'claude',
    });
    assert.equal(report.status, 'CHANNEL_UNAVAILABLE');
    assert.equal(report.reason, 'ledger-empty-or-corrupt');
    assert.equal(report.ledgerInvalidLines, 2);
    assert.deepEqual(report.accountingCoverage, {
      status: 'unknown', observations: 2, included: 0, excludedOverlap: 0,
      excludedUnknownScope: 0, excludedActorDetail: 0,
      usageUnattributed: 0, invalidOrUnclassifiable: 2, retransmissionsDeduplicated: 0,
    });
  });

  it('keeps a valid total but makes coverage partial when a malformed line is unclassifiable', () => {
    const report = collectHeadlessChannel({
      resourceUsageText: `${JSON.stringify(opencodeStepRecord())}\nnot json`,
      harness: 'opencode',
    });
    assert.equal(report.phaseRollups[0].usage.input, 10);
    assert.equal(report.ledgerInvalidLines, 1);
    assert.equal(report.accountingCoverage.status, 'partial');
    assert.equal(report.accountingCoverage.observations, 2);
    assert.equal(report.accountingCoverage.included, 1);
    assert.equal(report.accountingCoverage.invalidOrUnclassifiable, 1);
  });

  it('keeps a valid total but makes coverage partial when a non-object line is unclassifiable', () => {
    const report = collectHeadlessChannel({
      resourceUsageText: `${JSON.stringify(opencodeStepRecord())}\n42`,
      harness: 'opencode',
    });
    assert.equal(report.phaseRollups[0].usage.input, 10);
    assert.equal(report.ledgerInvalidLines, 1);
    assert.equal(report.accountingCoverage.status, 'partial');
    assert.equal(report.accountingCoverage.observations, 2);
    assert.equal(report.accountingCoverage.included, 1);
    assert.equal(report.accountingCoverage.invalidOrUnclassifiable, 1);
  });

  it('classifies malformed object ledger shapes as invalid rather than missing usage', () => {
    const malformed = [
      {},
      { unrelated: 'object' },
      { schemaVersion: 2, runId: 'run-modern', phase: 'implement' },
      { ...opencodeStepRecord(), schemaVersion: 3 },
      { ...opencodeStepRecord(), observationFingerprint: 42 },
      { ...opencodeStepRecord(), observationFingerprint: '' },
      {
        schemaVersion: 1,
        runId: 42,
        phase: 'implement',
        attempt: 1,
        harness: 'opencode',
        sessionId: 'ses-modern',
      },
    ];
    const corrupt = collectHeadlessChannel({
      resourceUsageText: malformed.map((record) => JSON.stringify(record)).join('\n'),
      harness: 'opencode',
    });
    assert.equal(corrupt.status, 'CHANNEL_UNAVAILABLE');
    assert.deepEqual(corrupt.dispatches, []);
    assert.equal(corrupt.ledgerInvalidLines, malformed.length);
    assert.equal(corrupt.accountingCoverage.observations, malformed.length);
    assert.equal(corrupt.accountingCoverage.invalidOrUnclassifiable, malformed.length);
    assert.equal(corrupt.accountingCoverage.usageUnattributed, 0);

    const mixed = collectHeadlessChannel({
      resourceUsageText: [opencodeStepRecord(), ...malformed]
        .map((record) => JSON.stringify(record)).join('\n'),
      harness: 'opencode',
    });
    assert.equal(mixed.status, 'available');
    assert.equal(mixed.phaseRollups[0].usage.input, 10);
    assert.equal(mixed.accountingCoverage.status, 'partial');
    assert.equal(mixed.accountingCoverage.included, 1);
    assert.equal(mixed.accountingCoverage.invalidOrUnclassifiable, malformed.length);
  });

  it('reserves missing-usage disposition for an otherwise recognized observation', () => {
    const record = opencodeStepRecord();
    delete record.usage;
    const report = collectHeadlessChannel({
      resourceUsageText: JSON.stringify(record),
      harness: 'opencode',
    });
    assert.equal(report.ledgerInvalidLines, 0);
    assert.equal(report.dispatches.length, 1);
    assert.equal(report.dispatches[0].accountingDisposition, 'excluded-missing-usage');
    assert.equal(report.accountingCoverage.usageUnattributed, 1);
    assert.equal(report.accountingCoverage.invalidOrUnclassifiable, 0);
  });

  it('never coerces non-string observation fingerprints into additive evidence', () => {
    const fingerprint = `sha256:${'a'.repeat(64)}`;
    for (const value of [[fingerprint], [[fingerprint]], { value: fingerprint }, null, true, false, 42]) {
      const report = collectHeadlessChannel({
        harness: 'opencode',
        resourceUsageText: JSON.stringify({ ...opencodeStepRecord(), observationFingerprint: value }),
      });
      assert.deepEqual(report.phaseRollups, [], JSON.stringify(value));
      assert.equal(report.accountingCoverage.included, 0);
      assert.equal(report.accountingCoverage.invalidOrUnclassifiable, 1);
      assert.notEqual(report.accountingCoverage.status, 'complete');
    }
  });

  it('rejects long malformed measurement identities without ambiguous backtracking', () => {
    const record = opencodeStepRecord();
    delete record.usage;
    record.measurementId = `opencode:step:${'a:'.repeat(2000)}?`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { collectHeadlessChannel } from './scripts/cost-report.mjs';
      collectHeadlessChannel({ harness: 'opencode', resourceUsageText: ${JSON.stringify(JSON.stringify(record))} });
    `], { cwd: repoRoot, encoding: 'utf8', timeout: 2000 });
    assert.equal(result.error?.code, undefined, 'bounded synthetic parser diagnostic must finish');
    assert.equal(result.status, 0, result.stderr);
  });

  it('preserves legal colon-containing provider identities and their collision evidence', () => {
    const valid = opencodeStepRecord({ sessionId: 'ses:a', messageId: 'msg:b', partId: 'prt:c' });
    const single = collectHeadlessChannel({ harness: 'opencode', resourceUsageText: JSON.stringify(valid) });
    assert.equal(single.accountingCoverage.included, 1);
    const missing = { ...valid, observationFingerprint: `sha256:${'b'.repeat(64)}` };
    delete missing.usage;
    delete missing.measurementScope;
    for (const rows of [[valid, missing], [missing, valid]]) {
      const report = collectHeadlessChannel({ harness: 'opencode', resourceUsageText: rows.map(JSON.stringify).join('\n') });
      assert.equal(report.accountingCoverage.included, 0);
      assert.deepEqual(report.phaseRollups, []);
      assert.equal(report.accountingCoverage.usageUnattributed, 1);
    }
  });

  it('reconciles measurement identity and scope contradictions across observations', () => {
    const permutations = (rows) => rows.length < 2 ? [rows] : rows.flatMap((row, index) =>
      permutations(rows.filter((_, other) => other !== index)).map((rest) => [row, ...rest]));
    const scenarios = [
      { name: 'same identity, different scope', mutate: (row) => { row.measurementScope.partId = 'prt-other'; } },
      { name: 'same scope, different identity', mutate: (row) => { row.measurementId += '-other'; } },
      { name: 'identity without scope', mutate: (row) => { delete row.measurementScope; } },
      { name: 'missing usage, conflicting scope', mutate: (row) => { delete row.usage; row.measurementScope.partId = 'prt-other'; } },
      { name: 'conflicting group, identity without scope', mutate: (row) => { delete row.usage; delete row.measurementScope; }, group: true },
    ];
    for (const { name, mutate, group } of scenarios) {
      const valid = opencodeStepRecord();
      const contradictory = opencodeStepRecord({ fingerprint: `sha256:${'b'.repeat(64)}` });
      mutate(contradictory);
      const rows = [valid, contradictory];
      if (group) rows.push({ ...cloneRecord(contradictory), phase: 'review' });
      let expectedCoverage;
      for (const order of permutations(rows)) {
        const report = collectHeadlessChannel({ harness: 'opencode', resourceUsageText: order.map(JSON.stringify).join('\n') });
        assert.deepEqual(report.phaseRollups, [], name);
        assert.equal(report.dispatches.some((row) => row.accountingDisposition === 'included'), false, name);
        assert.equal(report.dispatches.find((row) => row.observationFingerprint === valid.observationFingerprint).accountingDisposition, 'excluded-overlap', name);
        assert.deepEqual(report.accountingCoverage, expectedCoverage ?? report.accountingCoverage, name);
        expectedCoverage = report.accountingCoverage;
      }
    }
  });

  it('uses standalone missing-usage provider scope as collision evidence in both orders', () => {
    const missingUsage = opencodeStepRecord();
    delete missingUsage.usage;
    const usageBearing = opencodeStepRecord({ fingerprint: `sha256:${'b'.repeat(64)}` });

    for (const records of [[missingUsage, usageBearing], [usageBearing, missingUsage]]) {
      const report = collectHeadlessChannel({
        resourceUsageText: records.map((record) => JSON.stringify(record)).join('\n'),
        harness: 'opencode',
      });
      const missing = report.dispatches.find((row) => row.usage === null);
      const measured = report.dispatches.find((row) => row.usage !== null);
      assert.equal(missing.accountingDisposition, 'excluded-missing-usage');
      assert.equal(measured.accountingDisposition, 'excluded-overlap');
      assert.deepEqual(report.phaseRollups, []);
      assert.deepEqual(report.accountingCoverage, {
        status: 'unknown', observations: 2, included: 0, excludedOverlap: 1,
        excludedUnknownScope: 0, excludedActorDetail: 0,
        usageUnattributed: 1, invalidOrUnclassifiable: 0, retransmissionsDeduplicated: 0,
      });
    }
  });

  it('retains null-usage conflict scope in collision analysis in every order', () => {
    const missingUsage = opencodeStepRecord();
    delete missingUsage.usage;
    const incompatible = cloneRecord(missingUsage);
    delete incompatible.measurementId;
    delete incompatible.measurementScope;
    const usageBearing = opencodeStepRecord({ fingerprint: `sha256:${'b'.repeat(64)}` });
    const permutations = [
      [missingUsage, incompatible, usageBearing],
      [missingUsage, usageBearing, incompatible],
      [incompatible, missingUsage, usageBearing],
      [incompatible, usageBearing, missingUsage],
      [usageBearing, missingUsage, incompatible],
      [usageBearing, incompatible, missingUsage],
    ];

    for (const records of permutations) {
      const report = collectHeadlessChannel({
        resourceUsageText: records.map((record) => JSON.stringify(record)).join('\n'),
        harness: 'opencode',
      });
      assert.deepEqual(
        report.dispatches.map((row) => row.accountingDisposition).sort(),
        ['excluded-conflicting-observation', 'excluded-overlap'],
      );
      assert.deepEqual(report.phaseRollups, []);
      assert.deepEqual(report.accountingCoverage, {
        status: 'unknown', observations: 2, included: 0, excludedOverlap: 1,
        excludedUnknownScope: 0, excludedActorDetail: 0,
        usageUnattributed: 0, invalidOrUnclassifiable: 1, retransmissionsDeduplicated: 0,
      });
    }
  });

  it('retains producer-shaped v2 usage observations whose accounting scope is unknown', () => {
    const record = {
      schemaVersion: 2,
      runId: 'run-unknown',
      phase: 'implement',
      attempt: 1,
      harness: 'opencode',
      observationFingerprint: `sha256:${'8'.repeat(64)}`,
      aggregationEligibility: 'unknown',
      requestedModelTier: 'standard',
      resolvedModel: 'open-model',
      usage: { inputTokens: 17, outputTokens: 3 },
    };
    const report = collectHeadlessChannel({
      resourceUsageText: JSON.stringify(record),
      harness: 'opencode',
    });

    assert.equal(report.dispatches.length, 1);
    assert.equal(report.dispatches[0].session, null);
    assert.deepEqual(report.dispatches[0].usage, {
      input: 17, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    });
    assert.equal(report.dispatches[0].accountingDisposition, 'excluded-unknown-scope');
    assert.deepEqual(report.phaseRollups, []);
    assert.equal(report.accountingCoverage.observations, 1);
    assert.equal(report.accountingCoverage.excludedUnknownScope, 1);
    assert.equal(report.accountingCoverage.invalidOrUnclassifiable, 0);
  });

  it('lets excluded conductor attribution conservatively collide by canonical provider identity', () => {
    const includedCandidate = opencodeStepRecord();
    const invalidAttribution = opencodeStepRecord({ fingerprint: `sha256:${'9'.repeat(64)}` });
    delete invalidAttribution.runId;
    const report = collectHeadlessChannel({
      resourceUsageText: [includedCandidate, invalidAttribution]
        .map((record) => JSON.stringify(record)).join('\n'),
      harness: 'opencode',
    });

    assert.equal(report.dispatches.length, 2);
    assert.deepEqual(
      report.dispatches.map(({ accountingDisposition }) => accountingDisposition),
      ['excluded-overlap', 'excluded-unknown-scope'],
    );
    assert.deepEqual(report.phaseRollups, []);
    assert.equal(report.accountingCoverage.included, 0);
    assert.equal(report.accountingCoverage.excludedOverlap, 1);
    assert.equal(report.accountingCoverage.excludedUnknownScope, 1);
    assert.equal(report.accountingCoverage.invalidOrUnclassifiable, 0);
  });

  it('keeps raw-capture volume evidence when the ledger is absent (spend and volume stay independent)', () => {
    const report = collectHeadlessChannel({
      resourceUsageText: null,
      rawStreams: [{ phase: 'plan', text: rawStream([claudeMessage('a'), claudeTool('t1', 'Bash')]) }],
      harness: 'claude',
    });
    assert.equal(report.status, 'CHANNEL_UNAVAILABLE', 'spend is unavailable without a ledger');
    assert.deepEqual(
      report.volumes,
      [{ key: 'plan', assistantMessages: 1, toolCalls: 1, cacheRead: 0 }],
      'the on-disk raw captures are real evidence and must not be discarded',
    );
  });
});

describe('countVolume', () => {
  it('counts message and tool.started events without double counting tool completion', () => {
    const text = rawStream([
      claudeMessage('hello'),
      claudeTool('t1', 'Bash'),
      JSON.stringify({ type: 'user', session_id: 's', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
      claudeMessage('done'),
    ]);
    assert.deepEqual(countVolume(text, 'claude'), { assistantMessages: 2, toolCalls: 1 });
  });

  it('counts OpenCode tool_use completion events as the single tool call per invocation', () => {
    const opencodeEvent = (type, extra) => JSON.stringify({
      type, sessionID: 'ses_1', part: { type, sessionID: 'ses_1', ...extra },
    });
    const text = rawStream([
      opencodeEvent('text', { text: 'hello' }),
      opencodeEvent('tool_use', { tool: 'bash', callID: 'call-1', state: { status: 'completed' } }),
      opencodeEvent('tool_use', { tool: 'edit', callID: 'call-2', state: { status: 'error', error: 'denied' } }),
      opencodeEvent('text', { text: 'done' }),
    ]);
    assert.deepEqual(countVolume(text, 'opencode'), { assistantMessages: 2, toolCalls: 2 });
  });

  it('counts every parallel tool_use block of one Claude assistant message, not just the first', () => {
    const parallelTools = JSON.stringify({
      type: 'assistant',
      session_id: 's',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          { type: 'tool_use', id: 't2', name: 'Read', input: {} },
        ],
      },
    });
    const text = rawStream([claudeMessage('hello'), parallelTools, claudeMessage('done')]);
    assert.deepEqual(countVolume(text, 'claude'), { assistantMessages: 2, toolCalls: 2 });
  });

  it('ignores malformed and non-message lines', () => {
    const text = rawStream(['not json', claudeMessage('real')]);
    assert.deepEqual(countVolume(text, 'claude'), { assistantMessages: 1, toolCalls: 0 });
  });
});

describe('interactive channel', () => {
  it('parses one session file into dispatches, session model, and volume via the C2 descriptor', () => {
    const session = parseInteractiveSession('session-impl-7', interactiveFixture(), 'claude');
    assert.notEqual(session, null);
    assert.equal(session.session, 'session-impl-7');
    assert.equal(session.resolvedModel, 'opus-5');
    assert.equal(session.assistantMessages, 3);
    assert.equal(session.toolCalls, 31);
    assert.equal(session.cacheRead, 9000);
    assert.equal(session.dispatches.length, 3);
  });

  it('counts one assistant message per message id, not per content-block line', () => {
    const block = (id, part) => JSON.stringify({
      type: 'assistant',
      message: { id, model: 'opus-5', usage: { input_tokens: 100, cache_read_input_tokens: 500, output_tokens: 10 }, content: [part] },
      entrypoint: 'cli',
    });
    const lines = [
      block('msg_1', { type: 'text', text: 'x' }),
      block('msg_1', { type: 'tool_use', id: 't1', name: 'Bash', input: {} }),
      block('msg_1', { type: 'tool_use', id: 't2', name: 'Read', input: {} }),
      block('msg_2', { type: 'text', text: 'y' }),
      // A record with no message id still counts per line (other stores).
      JSON.stringify({ type: 'assistant', message: { model: 'opus-5', usage: { cache_read_input_tokens: 30 } }, entrypoint: 'cli' }),
    ].join('\n');
    const session = parseInteractiveSession('s', lines, 'claude');
    assert.equal(session.assistantMessages, 3, 'three API messages, not five JSONL lines');
    assert.equal(session.cacheRead, 500 + 500 + 30, 'usage repeated on blocks of one message is summed once');
    assert.equal(session.toolCalls, 2, 'each tool_use block is one of the session\'s own tool calls');
  });

  it('collects per-dispatch rows with skill attribution, agent type, resolved model, and usage', () => {
    const report = collectInteractiveChannel({ harness: 'claude', sessions: [{ id: 'session-impl-7', text: interactiveFixture() }] });
    assert.equal(report.status, 'available');
    assert.equal(report.dispatches.length, 3);

    const [d1, d2, d3] = report.dispatches;
    assert.deepEqual(d1, {
      channel: 'interactive',
      session: 'session-impl-7',
      skill: 'implement',
      phase: null,
      agentType: 'general-purpose',
      requestedModel: null,
      resolvedModel: 'opus-5',
      usage: { input: 2000, output: 400, cacheRead: 9000, cacheWrite: 100, reasoning: 0 },
      aggregationEligibility: 'unknown',
      observationFingerprint: d1.observationFingerprint,
      accountingDisposition: 'excluded-unknown-scope',
    });
    assert.match(d1.observationFingerprint, /^sha256:[0-9a-f]{64}$/);

    assert.equal(d2.agentType, 'guide-agent');
    assert.equal(d2.skill, 'implement', 'skill must be joined from the preceding message line');
    assert.equal(d2.resolvedModel, 'unknown', 'a dispatch missing resolvedModel is resolved=unknown');
    assert.deepEqual(d2.usage, { input: 1500, output: 300, cacheRead: 7000, cacheWrite: 40, reasoning: 0 });

    assert.equal(d3.skill, 'implement', 'skill must be joined from the preceding message line');
    assert.equal(d3.resolvedModel, 'opus-5');
    assert.equal(d3.usage, null, 'a dispatch missing usage is never imputed');
    assert.equal(d3.accountingDisposition, 'excluded-missing-usage');
    assert.equal(
      d3.requestedModel, null,
      'the store records no requested model for a dispatch — the session model is a proxy that fabricates degrades',
    );

    assert.equal(report.usageUnattributed, 1);
  });

  it('does not emit a dispatch row for non-Agent tool results (Bash/Read/Edit)', () => {
    const bashLine = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
      toolUseResult: { commandName: 'Bash', success: true },
      entrypoint: 'cli',
    });
    const message = JSON.stringify({
      type: 'assistant',
      message: { model: 'opus-5', usage: { input_tokens: 1 } },
      attributionSkill: 'implement',
      entrypoint: 'cli',
    });
    const session = parseInteractiveSession('s', `${message}\n${bashLine}\n`, 'claude');
    assert.notEqual(session, null);
    assert.equal(session.dispatches.length, 0, 'a Bash tool result carries no agentType and must not become a dispatch');
    assert.equal(session.assistantMessages, 1);
    assert.equal(session.toolCalls, 0);
  });

  it('retains interactive observations but excludes unproven usage from every additive rollup', () => {
    const report = collectInteractiveChannel({ harness: 'claude', sessions: [{ id: 'session-impl-7', text: interactiveFixture() }] });

    assert.deepEqual(report.skillRollups, []);
    assert.deepEqual(report.sessionRollups, []);
    assert.deepEqual(report.accountingCoverage, {
      status: 'unknown', observations: 3, included: 0, excludedOverlap: 0,
      excludedUnknownScope: 2, excludedActorDetail: 0,
      usageUnattributed: 1, invalidOrUnclassifiable: 0, retransmissionsDeduplicated: 0,
    });
    assert.equal(
      report.skillRollups.reduce((count, row) => count + row.dispatches, 0),
      report.dispatches.filter((row) => row.accountingDisposition === 'included').length,
    );
    assert.equal(
      report.sessionRollups.reduce((count, row) => count + row.dispatches, 0),
      report.dispatches.filter((row) => row.accountingDisposition === 'included').length,
    );

    assert.deepEqual(report.sessionModels, [{ session: 'session-impl-7', resolvedModel: 'opus-5' }]);

    assert.deepEqual(report.volumes, [{ key: 'session-impl-7', assistantMessages: 3, toolCalls: 31, cacheRead: 9000 }]);
  });

  it('preserves byte-identical observations from distinct session files in both orders', () => {
    const sessions = ['session-a', 'session-b'].map((id) => ({ id, text: interactiveFixture() }));
    let coverage;
    for (const order of [sessions, [...sessions].reverse()]) {
      const report = collectInteractiveChannel({ harness: 'claude', sessions: order });
      assert.equal(report.dispatches.length, 6);
      assert.deepEqual(report.dispatches.map((row) => row.session).sort(), ['session-a', 'session-a', 'session-a', 'session-b', 'session-b', 'session-b']);
      assert.equal(report.accountingCoverage.observations, 6);
      assert.equal(report.accountingCoverage.retransmissionsDeduplicated, 0);
      assert.deepEqual(report.accountingCoverage, coverage ?? report.accountingCoverage);
      coverage = report.accountingCoverage;
      assert.deepEqual(report.skillRollups, []);
    }
  });

  it('retains incompatible skill attribution within and across repeated session inputs', () => {
    const [message, dispatch] = interactiveFixture().trim().split('\n');
    const contexts = ['implement', 'review'].map((skill) => JSON.stringify({ ...JSON.parse(message), attributionSkill: skill }));
    const together = parseInteractiveSession('same-session', [contexts[0], dispatch, contexts[1], dispatch].join('\n'), 'claude');
    assert.deepEqual(together.dispatches.map((row) => row.skill), ['implement', 'review']);
    assert.equal(together.retransmissionsDeduplicated, 0);
    const entries = contexts.map((context) => ({ id: 'same-session', text: [context, dispatch].join('\n') }));
    for (const sessions of [entries, [...entries].reverse()]) {
      const report = collectInteractiveChannel({ harness: 'claude', sessions });
      assert.deepEqual(report.dispatches.map((row) => row.skill).sort(), ['implement', 'review']);
      assert.equal(report.accountingCoverage.observations, 2);
      assert.equal(report.accountingCoverage.retransmissionsDeduplicated, 0);
      assert.deepEqual(report.skillRollups, []);
    }
    const repeat = collectInteractiveChannel({ harness: 'claude', sessions: [entries[0], entries[0]] });
    assert.equal(repeat.dispatches.length, 1);
    assert.equal(repeat.accountingCoverage.retransmissionsDeduplicated, 1);
  });

  it('deduplicates only byte-identical interactive dispatch observations', () => {
    const [message, dispatch] = interactiveFixture().trim().split('\n');
    const duplicate = collectInteractiveChannel({
      harness: 'claude',
      sessions: [{ id: 'session-repeat', text: [message, dispatch, dispatch].join('\n') }],
    });
    assert.equal(duplicate.dispatches.length, 1);
    assert.equal(duplicate.accountingCoverage.observations, 1);
    assert.equal(duplicate.accountingCoverage.retransmissionsDeduplicated, 1);
    assert.deepEqual(duplicate.skillRollups, []);
    assert.deepEqual(duplicate.sessionRollups, []);

    const distinct = JSON.parse(dispatch);
    distinct.message.content[0].tool_use_id = 'toolu_distinct';
    const separate = collectInteractiveChannel({
      harness: 'claude',
      sessions: [{ id: 'session-distinct', text: [message, dispatch, JSON.stringify(distinct)].join('\n') }],
    });
    assert.equal(separate.dispatches.length, 2);
    assert.notEqual(separate.dispatches[0].observationFingerprint, separate.dispatches[1].observationFingerprint);
    assert.equal(separate.accountingCoverage.excludedUnknownScope, 2);
  });

  it('does not promote unsupported interactive scope-looking fields into accounting evidence', () => {
    const [message, dispatchLine] = interactiveFixture().trim().split('\n');
    const dispatch = JSON.parse(dispatchLine);
    dispatch.providerVersion = '1.18.27';
    dispatch.measurementScope = {
      provider: 'claude', kind: 'dispatch', sessionId: 's', messageId: 'toolu_1', partId: 'result',
    };
    const report = collectInteractiveChannel({
      harness: 'claude',
      sessions: [{ id: 'unsupported', text: [message, JSON.stringify(dispatch)].join('\n') }],
    });
    assert.equal(report.dispatches[0].accountingDisposition, 'excluded-unknown-scope');
    assert.equal(report.accountingCoverage.status, 'unknown');
    assert.deepEqual(report.skillRollups, []);
    assert.deepEqual(report.sessionRollups, []);
  });

  it('reports CHANNEL_UNAVAILABLE for a harness with no session-store descriptor', () => {
    const report = collectInteractiveChannel({ harness: 'opencode', sessions: [] });
    assert.equal(report.status, 'CHANNEL_UNAVAILABLE');
    assert.equal(report.reason, 'no-session-store-descriptor');
    assert.deepEqual(report.dispatches, []);
  });

  it('reports CHANNEL_UNAVAILABLE when the store is unreadable', () => {
    const report = collectInteractiveChannel({ harness: 'claude', sessions: null });
    assert.equal(report.status, 'CHANNEL_UNAVAILABLE');
    assert.equal(report.reason, 'store-unreadable');
  });

  it('excludes headless (sdk-cli) sessions from the interactive channel', () => {
    const headlessLine = JSON.stringify({
      type: 'assistant',
      message: { model: 'sonnet', usage: { input_tokens: 1 } },
      attributionSkill: 'implement',
      entrypoint: 'sdk-cli',
    });
    const session = parseInteractiveSession('headless-1', `${headlessLine}\n`, 'claude');
    assert.equal(session, null, 'a headless session must be excluded from the interactive channel');
  });

  it('a session with no entrypoint record lands in unclassifiedSessions and contributes zero spend to either channel (A4)', () => {
    const text = `${JSON.stringify({
      type: 'assistant',
      message: { model: 'opus-5', usage: { input_tokens: 1 } },
      attributionSkill: 'implement',
    })}\n`;
    assert.equal(
      parseInteractiveSession('no-entrypoint', text, 'claude'), null,
      'a session with no recorded entrypoint must not be accepted as interactive',
    );

    const partition = partitionSessions({ sessions: [{ id: 'no-entrypoint', text }], harness: 'claude' });
    assert.deepEqual(partition.interactiveSessions, []);
    assert.deepEqual(partition.unclassifiedSessions, [{ session: 'no-entrypoint', entrypoint: null }]);

    const report = buildReport({ harness: 'claude', ...partition });
    assert.deepEqual(report.channels.headless.dispatches, [], 'must not be silently folded into the headless channel');
    assert.deepEqual(report.channels.interactive.dispatches, [], 'must not be silently folded into the interactive channel');
    assert.deepEqual(report.unclassifiedSessions, [{ session: 'no-entrypoint', entrypoint: null }]);
  });

  it('a session with an unknown entrypoint value lands in unclassifiedSessions and contributes zero spend to either channel (A4)', () => {
    const text = `${JSON.stringify({
      type: 'assistant',
      message: { model: 'opus-5', usage: { input_tokens: 1 } },
      attributionSkill: 'implement',
      entrypoint: 'vscode',
    })}\n`;
    assert.equal(
      parseInteractiveSession('unknown-entrypoint', text, 'claude'), null,
      'a session with an unrecognized entrypoint must not be accepted as interactive',
    );

    const partition = partitionSessions({ sessions: [{ id: 'unknown-entrypoint', text }], harness: 'claude' });
    assert.deepEqual(partition.interactiveSessions, []);
    assert.deepEqual(partition.unclassifiedSessions, [{ session: 'unknown-entrypoint', entrypoint: 'vscode' }]);

    const report = buildReport({ harness: 'claude', ...partition });
    assert.deepEqual(report.channels.headless.dispatches, [], 'must not be silently folded into the headless channel');
    assert.deepEqual(report.channels.interactive.dispatches, [], 'must not be silently folded into the interactive channel');
    assert.deepEqual(report.unclassifiedSessions, [{ session: 'unknown-entrypoint', entrypoint: 'vscode' }]);
  });
});

describe('session-store headless rejection', () => {
  const sdkSession = { id: 'sdk-1', text: JSON.stringify({
    type: 'assistant', entrypoint: 'sdk-cli',
    message: { model: 'model', usage: { input_tokens: 100 } },
  }) };

  it('reports sdk-cli sessions as unclassified and never fills missing or corrupt ledgers', () => {
    const partition = partitionSessions({ sessions: [sdkSession], harness: 'claude' });
    assert.deepEqual(partition.interactiveSessions, []);
    assert.deepEqual(partition.unclassifiedSessions, [{ session: 'sdk-1', entrypoint: 'sdk-cli' }]);
    for (const ledger of [null, 'not json']) {
      const report = buildReport({ headlessResourceUsageText: ledger, ...partition });
      assert.equal(report.channels.headless.status, 'CHANNEL_UNAVAILABLE');
      assert.deepEqual(report.channels.headless.dispatches, []);
      assert.deepEqual(report.channels.interactive.dispatches, []);
      assert.deepEqual(report.unclassifiedSessions, partition.unclassifiedSessions);
    }
  });

  it('keeps sdk-cli store entries separate from a current ledger measurement', () => {
    const partition = partitionSessions({ sessions: [sdkSession], harness: 'claude' });
    const report = buildReport({ headlessResourceUsageText: JSON.stringify(opencodeStepRecord()), ...partition });
    assert.equal(report.channels.headless.dispatches.length, 1);
    assert.equal(report.channels.headless.accountingCoverage.included, 1);
    assert.equal(report.unclassifiedSessions.length, 1);
  });
});

describe('readSessionStore', () => {
  const cliSession = (cwd) => JSON.stringify({
    type: 'assistant',
    message: { model: 'm', usage: { input_tokens: 1 } },
    entrypoint: 'cli',
    ...(cwd === null ? {} : { cwd }),
  });

  const withStore = (t, build) => {
    const dir = mkdtempSync(join(tmpdir(), 'cost-report-store-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    build(dir);
    return dir;
  };

  it('keeps only this repo\'s sessions and never ingests subagent transcripts as sessions', (t) => {
    const repoRoot = '/repo/mine';
    const root = withStore(t, (dir) => {
      mkdirSync(join(dir, 'proj-a', 'sess-1', 'subagents'), { recursive: true });
      mkdirSync(join(dir, 'proj-b'), { recursive: true });
      writeFileSync(join(dir, 'proj-a', 'sess-1.jsonl'), `${cliSession(repoRoot)}\n`);
      // A subagent transcript of the same repo: its spend is already on the
      // parent's dispatch rows — ingesting it double-counts.
      writeFileSync(join(dir, 'proj-a', 'sess-1', 'subagents', 'agent-x.jsonl'), `${cliSession(repoRoot)}\n`);
      // Another repo's session: a repo-scoped report must not absorb it.
      writeFileSync(join(dir, 'proj-b', 'sess-2.jsonl'), `${cliSession('/repo/other')}\n`);
      // No recorded cwd: not attributable to a repo.
      writeFileSync(join(dir, 'proj-a', 'sess-3.jsonl'), `${cliSession(null)}\n`);
      writeFileSync(join(dir, 'proj-b', 'notes.txt'), 'not a session');
    });
    const store = readSessionStore('claude', repoRoot, { rootPath: root });
    assert.deepEqual(store.sessions.map((s) => s.id), ['sess-1']);
  });

  it('skips an unreadable entry instead of blanking the whole store', (t) => {
    const repoRoot = '/repo/mine';
    const root = withStore(t, (dir) => {
      mkdirSync(join(dir, 'proj-a'), { recursive: true });
      writeFileSync(join(dir, 'proj-a', 'sess-1.jsonl'), `${cliSession(repoRoot)}\n`);
      symlinkSync(join(dir, 'missing-target'), join(dir, 'proj-a', 'dangling.jsonl'));
    });
    const store = readSessionStore('claude', repoRoot, { rootPath: root });
    assert.deepEqual(store.sessions.map((s) => s.id), ['sess-1'], 'a dangling symlink must not erase readable sessions');
  });

  it('returns sessions:null when the store root is absent or the harness has no descriptor', (t) => {
    const root = withStore(t, () => {});
    assert.deepEqual(readSessionStore('claude', '/repo/mine', { rootPath: join(root, 'nope') }), { sessions: null });
    assert.deepEqual(readSessionStore('opencode', '/repo/mine', { rootPath: root }), { sessions: null });
  });

  it('counts a session file once despite a circular directory symlink back to the store root (A3)', (t) => {
    const repoRoot = '/repo/mine';
    const root = withStore(t, (dir) => {
      mkdirSync(join(dir, 'proj-a'), { recursive: true });
      writeFileSync(join(dir, 'proj-a', 'sess-1.jsonl'), `${cliSession(repoRoot)}\n`);
      // A directory symlink pointing back at the store root: following it
      // re-walks the whole tree at every depth, so an id-set assertion would
      // falsely pass (it is always the same id, just repeated) — assert the
      // raw count instead.
      symlinkSync(dir, join(dir, 'proj-a', 'loop'));
    });
    const store = readSessionStore('claude', repoRoot, { rootPath: root });
    assert.equal(store.sessions.length, 1, 'a circular directory symlink must not cause duplicate ingestion');
  });

  it('never ingests a `.jsonl` symlink whose target lies outside the store root (A3)', (t) => {
    const repoRoot = '/repo/mine';
    const outsideDir = mkdtempSync(join(tmpdir(), 'cost-report-outside-'));
    t.after(() => rmSync(outsideDir, { recursive: true, force: true }));
    const outsideFile = join(outsideDir, 'external-sess.jsonl');
    writeFileSync(outsideFile, `${cliSession(repoRoot)}\n`);
    const root = withStore(t, (dir) => {
      mkdirSync(join(dir, 'proj-a'), { recursive: true });
      writeFileSync(join(dir, 'proj-a', 'sess-1.jsonl'), `${cliSession(repoRoot)}\n`);
      symlinkSync(outsideFile, join(dir, 'proj-a', 'linked.jsonl'));
    });
    const store = readSessionStore('claude', repoRoot, { rootPath: root });
    assert.deepEqual(
      store.sessions.map((s) => s.id),
      ['sess-1'],
      'a symlinked .jsonl file must never be ingested, even when its target matches this repo',
    );
  });
});

describe('SC4 weighting', () => {
  it('keeps raw token counts as the default and gates any weighted view behind a provenanced table', () => {
    assert.equal(COST_WEIGHT_TABLE_SOURCE, null, 'no verified cost/weight source is cited yet');
    assert.equal(TRIAGE_WEIGHTS.version, 'unsourced');
    assert.equal(TRIAGE_WEIGHTS.source, null);

    assert.throws(
      () => weightedTotal({ input: 10, output: 2 }, TRIAGE_WEIGHTS),
      /provenance|SC4/i,
      'the unsourced triage weights must never power the weighted view',
    );

    const sourced = { source: 'https://example.com/pricing', version: 1, input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
    assert.equal(weightedTotal({ input: 100, output: 20, cacheRead: 50, cacheWrite: 10 }, sourced), 100 * 1 + 20 * 5 + 50 * 0.1 + 10 * 1.25);
  });
});

describe('buildReport', () => {
  it('assembles both channels into one labelled report', () => {
    const report = buildReport({
      harness: 'claude',
      headlessResourceUsageText: observationHeadlessFixture(),
      headlessRawStreams: [],
      interactiveSessions: [{ id: 'session-impl-7', text: interactiveFixture() }],
    });
    assert.equal(report.schemaVersion, 7);
    assert.equal(report.channels.headless.channel, 'headless');
    assert.equal(report.channels.headless.status, 'available');
    assert.equal(report.channels.interactive.channel, 'interactive');
    assert.equal(report.channels.interactive.status, 'available');
    assert.ok(report.channels.headless.dispatches.length > 0);
    assert.ok(report.channels.interactive.dispatches.length > 0);
  });

  it('routes an unreadable session store to interactive CHANNEL_UNAVAILABLE, never an empty available channel', () => {
    const report = buildReport({
      harness: 'claude',
      headlessResourceUsageText: observationHeadlessFixture(),
      interactiveSessions: null,
    });
    assert.equal(report.channels.interactive.status, 'CHANNEL_UNAVAILABLE');
    assert.equal(report.channels.interactive.reason, 'store-unreadable');
  });
});

describe('CLI entry', () => {
  // The guard records attempts before throwing: the reader's catch-and-skip
  // policy must not turn a forbidden read into a passing isolation assertion.
  function isolatedCli(t, args, setup = () => {}) {
    const dir = mkdtempSync(join(tmpdir(), 'steepy-cost-report-cli-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const repo = join(dir, 'repo');
    const store = join(dir, 'store');
    const home = join(dir, 'home');
    for (const path of [repo, store, join(home, '.claude', 'projects')]) mkdirSync(path, { recursive: true });
    const forbidden = join(home, '.claude', 'projects');
    const attempts = join(dir, 'attempts');
    const guard = join(dir, 'guard.cjs');
    writeFileSync(guard, `const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
for (const method of ['existsSync', 'readdirSync', 'readFileSync', 'lstatSync', 'openSync']) {
  const original = fs[method];
  fs[method] = function(path, ...args) {
    if (String(path) === ${JSON.stringify(forbidden)} || String(path).startsWith(${JSON.stringify(`${forbidden}/`)})) {
      fs.appendFileSync(${JSON.stringify(attempts)}, method + '\\n');
      throw new Error('forbidden session-store access');
    }
    return original.call(this, path, ...args);
  };
}
syncBuiltinESMExports();
`);
    setup({ repo, store });
    const result = spawnSync(process.execPath, ['--require', guard, scriptPath, '--repo-root', repo, ...args(store)], {
      encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(existsSync(attempts), false, 'CLI attempted access to the unselected default store');
    return result;
  }

  it('session-store controls route the exact root to both channels without reading the default store', (t) => {
    const result = isolatedCli(t, (store) => ['--session-store-root', store], ({ repo, store }) => {
      for (const entrypoint of ['cli', 'sdk-cli']) writeFileSync(join(store, `${entrypoint}.jsonl`), JSON.stringify({
        type: 'assistant', cwd: repo, entrypoint,
        message: { id: entrypoint, model: 'fixture-model', usage: { input_tokens: 7 } },
      }));
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.channels.interactive.sessionModels.map(({ session }) => session), ['cli']);
    assert.deepEqual(report.channels.headless.sessionModels, []);
    assert.deepEqual(report.unclassifiedSessions, [{ session: 'sdk-cli', entrypoint: 'sdk-cli' }]);
  });

  it('session-store controls disable collection without any default-store access', (t) => {
    const result = isolatedCli(t, () => ['--no-session-store']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.channels.interactive.status, 'CHANNEL_UNAVAILABLE');
    assert.equal(report.channels.interactive.reason, 'store-disabled');
    assert.deepEqual(report.channels.headless.dispatches, []);
  });

  it('keeps physical ledger boundaries in both task-directory orders', (t) => {
    for (const partialFirst of [true, false]) {
      const result = isolatedCli(t, () => ['--harness', 'opencode', '--no-session-store'], ({ repo }) => {
        const tasks = join(repo, '.apex', 'work', 'tasks');
        const first = join(tasks, 'a-ledger');
        const second = join(tasks, 'b-ledger');
        mkdirSync(first, { recursive: true });
        mkdirSync(second, { recursive: true });
        const partial = partialFirst ? first : second;
        const valid = partialFirst ? second : first;
        writeFileSync(join(partial, 'resource-usage.jsonl'), '{');
        writeFileSync(
          join(valid, 'resource-usage.jsonl'),
          `${JSON.stringify(opencodeStepRecord())}\n`,
        );
      });

      assert.equal(result.status, 0, result.stderr);
      const headless = JSON.parse(result.stdout).channels.headless;
      assert.equal(headless.status, 'available');
      assert.equal(headless.dispatches.length, 1);
      assert.equal(headless.dispatches[0].accountingDisposition, 'included');
      assert.equal(headless.dispatches[0].usage.input, 10);
      assert.equal(headless.phaseRollups[0].usage.input, 10);
      assert.equal(headless.ledgerInvalidLines, 1);
      assert.deepEqual(headless.accountingCoverage, {
        status: 'partial', observations: 2, included: 1, excludedOverlap: 0,
        excludedUnknownScope: 0, excludedActorDetail: 0,
        usageUnattributed: 0, invalidOrUnclassifiable: 1, retransmissionsDeduplicated: 0,
      });
    }
  });

  it('session-store controls reject conflicting or empty roots before any store access', (t) => {
    for (const args of [(store) => ['--session-store-root', store, '--no-session-store'], () => ['--session-store-root', '']]) {
      const result = isolatedCli(t, args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /session-store/i);
      assert.equal(result.stdout, '');
    }
  });

  it('sets process.exitCode instead of calling process.exit, so a piped report is never truncated', () => {
    const source = readFileSync(scriptPath, 'utf8');
    assert.match(source, /process\.exitCode = await main\(\)/);
    assert.doesNotMatch(
      source, /process\.exit\(/,
      'process.exit fires before async stdout writes drain — a >64KB report through a pipe is cut at the buffer boundary',
    );
  });
});

describe('headless channel work-path containment', () => {
  it('never reads a task-dir/spec-dir symlink sentinel pointing outside the repo; the rejection degrades only its entry', (t) => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'steepy-cost-report-outside-'));
    t.after(() => rmSync(outsideDir, { recursive: true, force: true }));
    const repoRoot = mkdtempSync(join(tmpdir(), 'steepy-cost-report-tasks-'));
    t.after(() => rmSync(repoRoot, { recursive: true, force: true }));

    const sentinelLine = () => JSON.stringify({
      schemaVersion: 2, observationFingerprint: `sha256:${'8'.repeat(64)}`, runId: 'run-escape', phase: 'plan', attempt: 1, harness: 'claude',
      sessionId: 'sess-sentinel-escape', aggregationEligibility: 'unknown',
      requestedModelTier: 'standard', resolvedModel: 'sonnet',
      usage: { inputTokens: 999, outputTokens: 999, cacheReadTokens: 999 },
    });

    // Spec-dir-level sentinel: an ordinary-looking ledger file outside the repo.
    const sentinelLedger = join(outsideDir, 'resource-usage.jsonl');
    writeFileSync(sentinelLedger, `${sentinelLine()}\n`);
    // Task-dir-level sentinel: a whole spec dir outside the repo whose ledger
    // and raw stream would pass every parser if the symlink were followed.
    const outsideSpecDir = join(outsideDir, 'spec-escape');
    mkdirSync(outsideSpecDir, { recursive: true });
    const outsideRaw = join(outsideSpecDir, 'phase-1-attempt-1.raw.jsonl');
    writeFileSync(join(outsideSpecDir, 'resource-usage.jsonl'), `${sentinelLine()}\n`);
    writeFileSync(outsideRaw, rawStream([claudeMessage('escaped-raw-content')]));

    const tasksDir = join(repoRoot, '.apex', 'work', 'tasks');

    // A fully in-repo spec dir whose data must survive every rejection below.
    const specGood = join(tasksDir, 'spec-good');
    mkdirSync(specGood, { recursive: true });
    writeFileSync(join(specGood, 'resource-usage.jsonl'), `${JSON.stringify({
      schemaVersion: 2, observationFingerprint: `sha256:${'9'.repeat(64)}`, runId: 'run-good', phase: 'plan', attempt: 1, harness: 'claude',
      sessionId: 'sess-good', aggregationEligibility: 'unknown',
      requestedModelTier: 'standard', resolvedModel: 'sonnet',
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 10 },
    })}\n`);
    writeFileSync(join(specGood, 'phase-1-attempt-1.raw.jsonl'), rawStream([claudeMessage('a'), claudeTool('t1', 'Bash')]));
    // A non-canonical raw name (leading zero): it must never be read, and its
    // phase number never normalized into the canonical phase-1 volume.
    writeFileSync(join(specGood, 'phase-01-attempt-1.raw.jsonl'), rawStream([claudeMessage('leading-zero')]));

    // Spec-dir-level escape: an ordinary spec dir whose ledger is a symlink to
    // the outside sentinel. The containment rejection must degrade this whole
    // entry, including its own ordinary raw file.
    const specLinkedLedger = join(tasksDir, 'spec-linked-ledger');
    mkdirSync(specLinkedLedger, { recursive: true });
    symlinkSync(sentinelLedger, join(specLinkedLedger, 'resource-usage.jsonl'));
    writeFileSync(join(specLinkedLedger, 'phase-2-attempt-1.raw.jsonl'), rawStream([claudeMessage('linked-entry-raw')]));

    // Task-dir-level escape: a spec-dir entry that is itself a symlink to the
    // outside directory.
    symlinkSync(outsideSpecDir, join(tasksDir, 'spec-dir-symlink'));

    const before = {
      ledger: readFileSync(sentinelLedger, 'utf8'),
      outsideLedger: readFileSync(join(outsideSpecDir, 'resource-usage.jsonl'), 'utf8'),
      outsideRaw: readFileSync(outsideRaw, 'utf8'),
    };
    const result = spawnSync(process.execPath, [scriptPath, '--repo-root', repoRoot, '--no-session-store'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(sentinelLedger, 'utf8'), before.ledger, 'sentinel ledger bytes must be unchanged');
    assert.equal(readFileSync(join(outsideSpecDir, 'resource-usage.jsonl'), 'utf8'), before.outsideLedger, 'outside spec-dir ledger bytes must be unchanged');
    assert.equal(readFileSync(outsideRaw, 'utf8'), before.outsideRaw, 'outside raw-stream bytes must be unchanged');

    const report = JSON.parse(result.stdout);
    assert.equal(report.channels.headless.status, 'available', 'the in-repo spec dir must keep the channel available');
    assert.deepEqual(
      report.channels.headless.dispatches.map((d) => d.session),
      ['sess-good'],
      'no sentinel dispatch may be ingested through either symlink form',
    );
    assert.equal(JSON.stringify(report).includes('sess-sentinel-escape'), false, 'the sentinel content must not render anywhere in the report');
    assert.equal(JSON.stringify(report).includes('escaped-raw-content'), false, 'the sentinel raw stream must not render anywhere in the report');
    assert.deepEqual(
      report.channels.headless.volumes,
      [{ key: 'plan', assistantMessages: 1, toolCalls: 1, cacheRead: 0 }],
      'only the canonical in-repo raw file counts — the leading-zero name is not normalized, and the linked-ledger entry\'s raw file degrades with its rejected ledger',
    );
  });
});

describe('headless channel per-spec-dir tolerance (A2)', () => {
  it('keeps a readable spec dir\'s ledger and raw-stream volume when a sibling spec dir is a dangling symlink', (t) => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'steepy-cost-report-tasks-'));
    t.after(() => rmSync(repoRoot, { recursive: true, force: true }));

    const tasksDir = join(repoRoot, '.apex', 'work', 'tasks');
    const specA = join(tasksDir, 'spec-a');
    mkdirSync(specA, { recursive: true });
    const ledgerLine = JSON.stringify({
      schemaVersion: 2, observationFingerprint: `sha256:${'a'.repeat(64)}`, runId: 'run-a2', phase: 'plan', attempt: 1, harness: 'claude',
      sessionId: 'sess-a2', aggregationEligibility: 'unknown',
      requestedModelTier: 'standard', resolvedModel: 'sonnet',
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 10 },
    });
    writeFileSync(join(specA, 'resource-usage.jsonl'), `${ledgerLine}\n`);
    writeFileSync(
      join(specA, 'phase-1-attempt-1.raw.jsonl'),
      rawStream([claudeMessage('a'), claudeTool('t1', 'Bash')]),
    );
    // A dangling symlink sibling: today `statSync` throws inside the single
    // try/catch wrapping the whole tasks walk, blanking spec-a's data too.
    symlinkSync(join(tasksDir, 'missing-target'), join(tasksDir, 'spec-b'));

    const result = spawnSync(process.execPath, [scriptPath, '--repo-root', repoRoot, '--no-session-store'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);

    assert.equal(report.channels.headless.status, 'available', 'spec-b\'s dangling symlink must not blank the whole channel');
    assert.deepEqual(
      report.channels.headless.dispatches.map((d) => d.session),
      ['sess-a2'],
      'spec-a\'s dispatch row must survive',
    );
    assert.deepEqual(
      report.channels.headless.volumes,
      [{ key: 'plan', assistantMessages: 1, toolCalls: 1, cacheRead: 0 }],
      'spec-a\'s raw-stream volume must survive',
    );
  });
});

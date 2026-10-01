import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeadlessResponseCorrelator } from '../adapters/headless-response.mjs';

function correlate(harness, events, options) {
  const collector = createHeadlessResponseCorrelator(harness, options);
  for (const event of events) collector.accept(typeof event === 'string' ? event : JSON.stringify(event), 'stdout');
  return collector.result();
}

const payload = 'status: not-a-verdict\nsignals: \n';

test('Claude takes only the direct successful result and preserves malformed semantics', () => {
  const result = correlate('claude', [
    { type: 'assistant', session_id: 'main', message: { content: [{ type: 'text', text: 'status: APPROVED' }] } },
    { type: 'result', subtype: 'success', session_id: 'main', agent_id: 'child', result: 'status: APPROVED\nsignals: none\n' },
    { type: 'system', subtype: 'task_notification', session_id: 'main', summary: 'status: APPROVED\nsignals: none\n' },
    { type: 'result', subtype: 'success', session_id: 'main', result: payload },
  ]);
  assert.equal(result.payload, payload);
  assert.deepEqual(result.identity, { sessionId: 'main', actor: 'direct' });
  assert.equal(result.reason, null);
  assert.equal(correlate('claude', [{ type: 'result', subtype: 'success', agent_id: 'child', result: payload }]).reason, 'missing-terminal');
});

test('Codex uses the last direct agent message before one completed turn', () => {
  const result = correlate('codex', [
    { type: 'item.completed', thread_id: 'main', item: { type: 'agent_message', text: 'intermediate prose' } },
    { type: 'item.completed', thread_id: 'main', item: { type: 'command_execution', output: 'status: APPROVED\nsignals: none\n' } },
    { type: 'item.completed', thread_id: 'main', agent_id: 'child', item: { type: 'agent_message', text: 'status: APPROVED\nsignals: none\n' } },
    { type: 'item.completed', thread_id: 'main', item: { type: 'agent_message', text: payload } },
    { type: 'turn.completed', thread_id: 'main' },
  ]);
  assert.equal(result.payload, payload);
  assert.deepEqual(result.identity, { sessionId: 'main', actor: 'direct' });
  assert.equal(result.reason, null);
  assert.equal(correlate('codex', [{ type: 'item.completed', item: { type: 'agent_message', text: payload } }]).reason, 'missing-terminal');
  assert.equal(correlate('codex', [
    { type: 'item.completed', item: { type: 'agent_message', text: payload } },
    { type: 'item.completed', item: { type: 'command_execution', output: payload } },
    { type: 'turn.completed' },
  ]).reason, 'missing-response');
});

test('OpenCode selects the last direct text after tool activity before a single stop', () => {
  const result = correlate('opencode', [
    { type: 'text', sessionID: 'main', part: { type: 'text', text: 'prose' } },
    { type: 'step_finish', sessionID: 'main', part: { reason: 'tool-calls' } },
    { type: 'tool_use', sessionID: 'main', part: { state: { output: 'status: APPROVED\nsignals: none\n' } } },
    { type: 'text', sessionID: 'main', part: { type: 'text', text: payload } },
    { type: 'step_finish', sessionID: 'main', part: { reason: 'stop', sessionID: 'main' } },
  ]);
  assert.equal(result.payload, payload);
  assert.deepEqual(result.identity, { sessionId: 'main', actor: 'direct' });
  assert.equal(result.reason, null);
  assert.equal(correlate('opencode', [{ type: 'text', part: { text: payload } }, { type: 'step_finish', part: { reason: 'tool-calls' } }]).reason, 'missing-terminal');
});

test('correlation rejects invalid streams, identity mismatch, multiple completions and oversized responses', () => {
  const final = { type: 'turn.completed', thread_id: 'main' };
  const message = { type: 'item.completed', thread_id: 'main', item: { type: 'agent_message', text: payload } };
  assert.equal(correlate('codex', ['not-json', message, final]).reason, 'invalid-json');
  assert.equal(correlate('codex', [message, { ...final, thread_id: 'other' }]).reason, 'identity-mismatch');
  assert.equal(correlate('codex', [message, final, final]).reason, 'multiple-terminals');
  assert.equal(correlate('codex', [message, final], { maxBytes: 4 }).reason, 'oversized-response');
  assert.equal(correlate('claude', [{ type: 'result', subtype: 'error', error: 'failed' }]).reason, 'failed-terminal');
  assert.equal(correlate('opencode', [
    { type: 'text', sessionID: 'main', part: { sessionID: 'other', text: payload } },
    { type: 'step_finish', sessionID: 'main', part: { reason: 'stop' } },
  ]).reason, 'identity-mismatch');
  assert.equal(correlate('codex', [
    { type: 'item.completed', thread_id: 'main', item: { type: 'agent_message', agent_id: 'child', text: payload } },
    final,
  ]).reason, 'missing-response');
  assert.equal(correlate('claude', [{ type: 'result', subtype: 'success', result: '' }]).payload, '');
});

test('candidate and completion require matching provenance when only one has an identity', () => {
  const bareMessage = { type: 'item.completed', item: { type: 'agent_message', text: payload } };
  const identifiedMessage = { ...bareMessage, thread_id: 'main' };
  const bareCompletion = { type: 'turn.completed' };
  const identifiedCompletion = { ...bareCompletion, thread_id: 'main' };
  assert.equal(correlate('codex', [bareMessage, identifiedCompletion]).reason, 'identity-mismatch');
  assert.equal(correlate('codex', [identifiedMessage, bareCompletion]).reason, 'identity-mismatch');
  assert.equal(correlate('codex', [bareMessage, bareCompletion]).reason, null);
  assert.equal(correlate('codex', [bareMessage, bareCompletion]).identity.sessionId, null);
  assert.equal(correlate('opencode', [
    { type: 'text', part: { text: payload } },
    { type: 'step_finish', sessionID: 'main', part: { reason: 'stop' } },
  ]).reason, 'identity-mismatch');
  assert.equal(correlate('codex', [
    bareMessage,
    { type: 'thread.started', thread_id: 'main' },
    bareCompletion,
  ]).reason, 'identity-mismatch');
});

test('an earlier direct lifecycle identity binds ID-less Codex and OpenCode events', () => {
  const identified = correlate('codex', [
    { type: 'thread.started', thread_id: 'main' },
    { type: 'item.completed', thread_id: 'main', item: { type: 'agent_message', text: 'working' } },
    { type: 'item.completed', thread_id: 'main', item: { type: 'agent_message', text: payload } },
    { type: 'turn.completed', thread_id: 'main' },
  ]);
  assert.equal(identified.payload, payload);
  assert.deepEqual(identified.identity, { sessionId: 'main', actor: 'direct' });
  const codex = correlate('codex', [
    { type: 'thread.started', thread_id: 'main' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'working' } },
    { type: 'item.completed', item: { type: 'agent_message', text: payload } },
    { type: 'turn.completed' },
  ]);
  assert.equal(codex.payload, payload);
  assert.deepEqual(codex.identity, { sessionId: 'main', actor: 'direct' });
  assert.equal(codex.reason, null);
  const opencode = correlate('opencode', [
    { type: 'step_start', sessionID: 'main', part: { type: 'step-start' } },
    { type: 'text', part: { text: payload } },
    { type: 'step_finish', part: { reason: 'stop' } },
  ]);
  assert.equal(opencode.payload, payload);
  assert.deepEqual(opencode.identity, { sessionId: 'main', actor: 'direct' });
  assert.equal(correlate('codex', [
    { type: 'thread.started', thread_id: 'main' },
    { type: 'item.completed', item: { type: 'agent_message', text: payload } },
    { type: 'turn.completed', thread_id: 'other' },
  ]).reason, 'identity-mismatch');
});

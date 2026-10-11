import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFixtureState as buildState } from './helpers/state.mjs';
import { decide, parseState, validateRequest } from '../lib/decision.ts';

const input = { question: 'The fixture timeout is 300000 ms and default is 120000 ms. Which is longer?', responses: { fixture: 'Fixture is longer.', default: 'Default is longer.' }, context: { conversation: false, workspace: false } };
const state = { goal: 'Collect the stated timeout values.', constraints: [], current_state: ['Fixture timeout is 300000 ms.', 'Default timeout is 120000 ms.'], evidence: [], uncertainties: ['Workspace and conversation sharing are disabled.'] };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply = (content, stopReason = 'stop') => ({ role: 'assistant', provider: 'offline', model: 'offline', api: 'offline', timestamp: 1, usage, stopReason, content });
const textReply = value => reply([{ type: 'text', text: JSON.stringify(value) }]);
const ids = context => {
  const line = context.systemPrompt.split('\n').find(line => line.startsWith('Available source IDs: '));
  assert.ok(line, 'each request must declare the current collector IDs, even when empty');
  return JSON.parse(line.slice('Available source IDs: '.length));
};

test('AC-2 AC-13 request-only facts have explicit placement and an empty citation allowlist', async () => {
  let requests = 0;
  const built = await buildState(validateRequest(input), {
    tools: [], conversation: [{ role: 'user', content: 'Unshared conversation' }],
    complete: async context => {
      requests++;
      assert.deepEqual(ids(context), []);
      assert.match(context.systemPrompt, /question and response descriptions are request data, not collected evidence/i);
      assert.match(context.systemPrompt, /current_state or constraints/);
      assert.match(context.systemPrompt, /empty.*evidence.*\[\]/i);
      assert.doesNotMatch(context.systemPrompt, /e\.g\. e1 or conversation/);
      assert.doesNotMatch(JSON.stringify(context.messages), /Unshared conversation/);
      return textReply(state);
    },
    executeTool: async () => assert.fail('request-only facts must not trigger tools')
  }, new AbortController().signal, () => {});
  assert.equal(requests, 1);
  assert.deepEqual(parseState(built.text, built.collection.evidence.map(e => e.id)), state);
  assert.deepEqual(built.collection.evidence, []);
});

test('AC-13 source allowlist reflects permitted conversation and each completed evidence call', async () => {
  for (const conversation of [false, true]) {
    let turns = 0;
    const built = await buildState(validateRequest({ ...input, context: { conversation, workspace: true } }), {
      tools: [{ name: 'magic8ball_read', description: 'read', parameters: { type: 'object' } }],
      conversation: [{ role: 'user', content: 'Shared fact' }],
      complete: async context => {
        assert.deepEqual(ids(context), [...(conversation ? ['conversation'] : []), ...(turns ? ['e1'] : [])]);
        if (!turns++) return reply([{ type: 'toolCall', id: 'read1', name: 'magic8ball_read', arguments: { path: 'fixture.txt' } }], 'toolUse');
        return textReply({ ...state, evidence: [{ fact: 'Workspace fact', source: 'e1' }] });
      },
      executeTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ text: 'Workspace fact', truncated: false }) }] })
    }, new AbortController().signal, () => {});
    assert.equal(turns, 2);
    assert.equal(parseState(built.text, built.collection.evidence.map(e => e.id)).evidence[0].source, 'e1');
  }
});

test('AC-13 preserved invented request/conversation citations still stop before classification', async () => {
  for (const source of ['conversation', 'request', 'e1']) {
    let classified = 0;
    const result = await decide(input, {
      prepare: async () => ({ builder: { provider: 'offline', model: 'offline' }, classifier: { provider: 'offline', model: 'offline' } }),
      build: async () => ({ text: JSON.stringify({ ...state, evidence: [{ fact: 'The question supplies values.', source }] }), collection: { conversationTruncated: false, evidenceCalls: 0, sources: [], evidence: [] } }),
      classify: async () => { classified++; assert.fail('invalid citations must stop before classification'); }
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, 'invalid-state');
    assert.equal(classified, 0);
  }
});

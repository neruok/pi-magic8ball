import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, parseState, readConfig, decide } from '../lib/decision.ts';
import { buildState, conversationContext } from '../lib/builder.ts';

const input = { question: 'Which approach?', responses: { A: 'Existing extension', B: 'Separate extension' } };
const state = { goal: 'Add a tool', constraints: ['No writes'], current_state: ['Pi is installed'], evidence: [{ fact: 'Pi supports classifiers', source: 'docs/models.md' }], uncertainties: ['No live evaluation'] };
const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17, cost: { input: .01, output: .02, cacheRead: 0, cacheWrite: 0, total: .03 } };
const models = { builder: { provider: 'cheap', model: 'small' }, classifier: { provider: 'typesafe', model: 'jev-latest' } };
const answer = { type: 'choice', choice: 'B', probabilities: { A: .2, B: .7, insufficient_evidence: .1 }, confidence: .45 };
const collection = { conversationTruncated: false, evidenceCalls: 0, sources: [] };
function deps(overrides = {}) {
  return { prepare: async () => models, build: async (_r, _s, record) => { record(usage); return { text: JSON.stringify(state), collection }; }, classify: async () => ({ stopReason: 'stop', answers: { decision: answer }, usage }), ...overrides };
}
const fail = (fn, kind) => assert.throws(fn, e => e.kind === kind);

test('AC-1 validates descriptions, identifiers, scopes, counts and default abstention', () => {
  const r = validateRequest(input);
  assert.deepEqual(r.responses, { ...input.responses, insufficient_evidence: 'Available evidence is insufficient to reliably distinguish the supplied choices.' });
  assert.deepEqual(r.context, { conversation: true, workspace: true });
  const many = Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`r${i}`, `Response ${i}`]));
  assert.equal(Object.keys(validateRequest({ ...input, responses: many, abstain: false }).responses).length, 26);
  for (const bad of [null, {}, { ...input, question: ' ' }, { ...input, responses: { A: '', B: 'valid' } }, { ...input, responses: { A: 'only' } }, { ...input, responses: many }, { ...input, responses: { constructor: 'bad', B: 'ok' } }, { ...input, responses: JSON.parse('{"__proto__":"bad","B":"ok"}') }, { ...input, responses: { insufficient_evidence: 'bad', B: 'ok' } }, { ...input, context: { web: true } }, { ...input, context: { workspace: null } }, { ...input, abstain: null }, { ...input, extra: true }, { ...input, question: '😀'.repeat(5000) }]) fail(() => validateRequest(bad), 'invalid-input');
});

test('AC-2 validates neutral state, rejecting recommendations and oversize', () => {
  assert.deepEqual(parseState(JSON.stringify(state)), state);
  for (const bad of ['not JSON', '```json\n{}\n```', JSON.stringify({ ...state, answer: 'B' }), JSON.stringify({ A: { pros: ['yes'] }, B: {} }), JSON.stringify({ ...state, evidence: [{ fact: 'claim', source: '' }] }), JSON.stringify({ ...state, goal: 'x'.repeat(12001) })]) fail(() => parseState(bad), 'invalid-state');
});

test('AC-2 builds state before classification and never feeds classification back', async () => {
  const order = [];
  const result = await decide(input, deps({ build: async (r, _s, record) => { order.push('build'); assert.equal(r.probabilities, undefined); record(usage); return { text: JSON.stringify(state), collection }; }, classify: async (r, s) => { order.push('classify'); assert.deepEqual(s, state); assert.equal(r.responses.B, input.responses.B); return { stopReason: 'stop', answers: { decision: answer } }; } }));
  assert.equal(result.ok, true);
  assert.deepEqual(order, ['build', 'classify']);
  let called = false;
  const bad = await decide(input, deps({ build: async () => ({ text: '{"answer":"B"}', collection }), classify: async () => { called = true; } }));
  assert.equal(bad.error.kind, 'invalid-state');
  assert.equal(called, false);
});

test('AC-2 conversation scope filters prior 8-ball results and images; truncation is UTF-8 bounded', () => {
  const c = conversationContext([{ role: 'user', content: 'hello' }, { role: 'toolResult', toolName: 'magic8ball', content: [{ type: 'text', text: 'SECRET_PROBABILITIES' }] }, { role: 'assistant', content: [{ type: 'toolCall', name: 'magic8ball', arguments: input }, { type: 'text', text: 'old decision' }] }, { role: 'user', content: [{ type: 'image', data: 'IMAGE_SECRET' }, { type: 'text', text: 'world' }] }]);
  assert.match(c.text, /hello/); assert.match(c.text, /world/);
  assert.doesNotMatch(c.text, /SECRET|old decision/);
  const large = conversationContext([{ role: 'user', content: '😀'.repeat(20000) }]);
  assert.equal(large.truncated, true); assert.ok(Buffer.byteLength(large.text) <= 24000); assert.doesNotMatch(large.text, /�/);
});

test('AC-4 preserves Jev/Clef distributions, backend confidence, abstention and ties', async () => {
  for (const classifier of [{ provider: 'typesafe', model: 'jev-latest' }, { provider: 'cloudflare-workers-ai', model: '@cf/cloudflare/clef' }]) {
    const result = await decide(input, deps({ prepare: async () => ({ ...models, classifier }) }));
    assert.equal(result.ok, true); assert.equal(result.answer, 'B'); assert.equal(result.confidence, .45);
    assert.deepEqual(result.probabilities, answer.probabilities); assert.equal(result.advisory, true); assert.deepEqual(result.models.classifier, classifier);
    assert.equal(result.usage.input, 20); assert.equal(result.usage.cost.total, .06);
  }
  const tied = { ...answer, choice: 'B', probabilities: { A: .5, B: .5, insufficient_evidence: 0 } };
  const t = await decide(input, deps({ classify: async () => ({ stopReason: 'stop', answers: { decision: tied } }) })); assert.equal(t.answer, 'B');
  const abstention = { ...answer, choice: 'insufficient_evidence', probabilities: { A: .1, B: .1, insufficient_evidence: .8 } };
  const a = await decide(input, deps({ classify: async () => ({ stopReason: 'stop', answers: { decision: abstention } }) })); assert.equal(a.abstained, true);
  for (const bad of [{}, { ...answer, confidence: NaN }, { ...answer, choice: 'A' }, { ...answer, probabilities: { A: .2, B: .7 } }, { ...answer, probabilities: { ...answer.probabilities, extra: 0 } }, { ...answer, probabilities: { A: -.1, B: 1, insufficient_evidence: .1 } }, { ...answer, probabilities: { A: .2, B: Infinity, insufficient_evidence: .1 } }, { ...answer, probabilities: { A: .1, B: .1, insufficient_evidence: .1 } }]) {
    const r = await decide(input, deps({ classify: async () => ({ stopReason: 'stop', answers: { decision: bad } }) })); assert.equal(r.error.kind, 'invalid-answer'); assert.equal(r.answer, undefined);
  }
});

test('AC-5 rejects missing config, invalid input, unavailable models and provider errors without fallback', async () => {
  fail(() => readConfig({}), 'not-configured');
  assert.deepEqual(readConfig(models), models);
  let called = 0;
  const invalid = await decide({}, deps({ prepare: async () => { called++; return models; } })); assert.equal(invalid.error.kind, 'invalid-input'); assert.equal(called, 0);
  const unavailable = Object.assign(new Error('No model'), { kind: 'model-unavailable' });
  const r = await decide(input, deps({ prepare: async () => { throw unavailable; }, build: async () => { called++; } })); assert.equal(r.error.kind, 'model-unavailable'); assert.equal(called, 0);
  const b = await decide(input, deps({ build: async (_r, _s, record) => { record(usage); throw new Error('SECRET'); }, classify: async () => { called++; } })); assert.equal(b.error.kind, 'builder-failed'); assert.equal(b.usage.input, 10); assert.equal(called, 0); assert.doesNotMatch(JSON.stringify(b), /SECRET/);
  const c = await decide(input, deps({ classify: async () => ({ stopReason: 'error', errorMessage: 'SECRET', answers: {}, usage }) })); assert.equal(c.error.kind, 'classifier-failed'); assert.equal(c.usage.input, 20); assert.equal(c.answer, undefined); assert.doesNotMatch(JSON.stringify(c), /SECRET/);
});

test('AC-5 cancels and enforces a deadline even when a mock ignores abort', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const r = await decide(input, deps({ build: async () => { calls++; } }), controller.signal); assert.equal(r.error.kind, 'cancelled'); assert.equal(calls, 0);
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const timeout = await decide(input, deps({ build: async (_r, signal) => { assert.equal(signal.aborted, false); await pending; return { text: JSON.stringify(state), collection }; }, classify: async () => { calls++; } }), undefined, 10);
  assert.equal(timeout.error.kind, 'timeout'); resolve(); await new Promise(r => setImmediate(r)); assert.equal(calls, 0);
});

function message(content, stopReason = 'stop') { return { role: 'assistant', content, stopReason, usage, provider: 'cheap', model: 'small', api: 'test', timestamp: 1 }; }
const tools = [{ name: 'magic8ball_read', description: 'read', parameters: { type: 'object' } }];
function builderDeps(complete, extra = {}) { return { complete, tools, conversation: [{ role: 'user', content: 'CONVERSATION_MARKER' }], executeTool: async () => ({ isError: false, content: [{ type: 'text', text: 'fact' }] }), ...extra }; }

test('AC-2 builder receives neutral instructions and scope-selected tools/context', async () => {
  for (const workspace of [false, true]) {
    let n = 0;
    const b = await buildState(validateRequest({ ...input, context: { workspace, conversation: false } }), builderDeps(async context => { n++; assert.equal(context.tools.length, workspace ? 1 : 0); assert.match(context.systemPrompt, /Do not rank/); assert.doesNotMatch(JSON.stringify(context.messages), /CONVERSATION_MARKER/); return message([{ type: 'text', text: JSON.stringify(state) }]); }), new AbortController().signal, () => {});
    assert.equal(n, 1); assert.deepEqual(JSON.parse(b.text), state);
  }
});

test('AC-3 builder honors nested-tool allowlist and permission failures', async () => {
  for (const name of ['bash', 'magic8ball', 'magic8ball_read']) {
    let executed = 0;
    await assert.rejects(() => buildState(validateRequest(input), builderDeps(async () => message([{ type: 'toolCall', name, id: '1', arguments: { path: 'README.md' } }], 'toolUse'), { executeTool: async () => { executed++; return { isError: true, content: [{ type: 'text', text: 'permission denied' }] }; } }), new AbortController().signal, () => {}), e => e.kind === (name === 'magic8ball_read' ? 'evidence-failed' : 'builder-failed'));
    assert.equal(executed, name === 'magic8ball_read' ? 1 : 0);
  }
});

test('AC-5 builder stops at four requests and eight evidence calls, retaining each usage', async () => {
  let requests = 0, calls = 0, tokens = 0;
  const d = builderDeps(async (_c, _s, opts) => { requests++; assert.equal(opts.maxTokens, 2048); assert.equal(opts.maxRetries, 0); return message([{ type: 'toolCall', name: 'magic8ball_read', id: `t${requests}`, arguments: { path: 'README.md' } }], 'toolUse'); }, { executeTool: async () => { calls++; return { isError: false, content: [{ type: 'text', text: 'ok' }] }; } });
  await assert.rejects(() => buildState(validateRequest(input), d, new AbortController().signal, u => { tokens += u.input; }), e => e.kind === 'budget-exhausted');
  assert.equal(requests, 4); assert.equal(calls, 4); assert.equal(tokens, 40);
  requests = 0; calls = 0;
  d.complete = async () => { requests++; return message(Array.from({ length: 9 }, (_, i) => ({ type: 'toolCall', name: 'magic8ball_read', id: `t${i}`, arguments: { path: 'README.md' } })), 'toolUse'); };
  await assert.rejects(() => buildState(validateRequest(input), d, new AbortController().signal, () => {}), e => e.kind === 'budget-exhausted'); assert.equal(requests, 1); assert.equal(calls, 8);
});

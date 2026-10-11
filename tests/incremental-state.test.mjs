import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compile } from 'typebox/compile';
import extension from '../magic8ball.ts';
import { buildState } from '../lib/builder.ts';
import * as decision from '../lib/decision.ts';
import { TranscriptStore } from '../lib/transcripts.ts';
import { BuilderState } from '../lib/state.ts';

const { decide, validateRequest, parseState, emptyUsage } = decision;
const input = { question: 'Which?', responses: { a: 'A', b: 'B' }, context: { workspace: false, conversation: false } };
const state = { goal: 'Compare facts', constraints: [], current_state: ['Observation'], evidence: [], uncertainties: [] };
const mapping = { goal: 'goal', constraints: 'constraints', current_state: 'observations', evidence: 'evidence', uncertainties: 'uncertainties' };
const names = Object.values(mapping).map(section => `magic8ball_set_${section}`);
const usage = { ...emptyUsage(), input: 1, totalTokens: 1 };
const reply = (content = [], stopReason = 'stop') => ({ role: 'assistant', content, stopReason, usage, provider: 'offline', model: 'offline', api: 'offline', timestamp: 1 });
const call = (section, value, id = section) => ({ type: 'toolCall', id, name: `magic8ball_set_${section}`, arguments: { value } });
const updates = (value = state, prefix = '') => Object.entries(value).map(([key, item]) => call(mapping[key], item, prefix + key));
const tools = [{ name: 'magic8ball_read', description: 'read', parameters: { type: 'object' } }];
const models = { builder: { provider: 'offline', model: 'offline' }, classifier: { provider: 'offline', model: 'offline' } };
const answer = { stopReason: 'stop', usage, answers: { decision: { type: 'choice', choice: 'a', confidence: .8, probabilities: { a: .8, b: .1, insufficient_evidence: .1 } } } };
function dependencies(plan, extra = {}) {
  let index = 0;
  return { tools, conversation: [], complete: async context => {
    assert.ok(index < plan.length, 'mock plan exhausted');
    const step = plan[index++];
    return typeof step === 'function' ? step(context) : step;
  }, executeTool: async () => assert.fail('local updates must not execute parent tools'), ...extra };
}
async function run(plan, request = input, extra = {}) {
  let classified = 0, received;
  const result = await decide(request, {
    prepare: async () => models,
    build: (r, signal, record, execution) => buildState(r, { ...dependencies(plan, extra), execution }, signal, record),
    classify: async (_r, value) => { classified++; received = value; return answer; }
  });
  return { result, classified, received };
}

test('AC-31 builder-only exact schemas, initialized state, ordered replacements, and final prose independence', async () => {
  const corrected = { ...state, current_state: ['Corrected'], evidence: [] };
  const result = await run([
    context => {
      assert.deepEqual(context.tools.map(t => t.name), names);
      assert.match(context.systemPrompt, /initialized/i);
      for (const tool of context.tools) {
        const schema = Compile(tool.parameters);
        assert.equal(schema.Check({ value: state[Object.keys(mapping).find(k => mapping[k] === tool.name.slice('magic8ball_set_'.length))] }), true);
        assert.equal(schema.Check({ value: null }), false);
        assert.equal(schema.Check({}), false);
        assert.equal(schema.Check({ value: [], extra: true }), false);
      }
      return reply([...updates(), call('observations', ['Corrected'], 'replace')], 'toolUse');
    },
    context => {
      const results = context.messages.filter(m => m.role === 'toolResult');
      assert.equal(results.length, 6);
      assert.ok(results.every(m => JSON.parse(m.content[0].text).updated));
      assert.match(context.systemPrompt, /Corrected/);
      return reply([{ type: 'text', text: '```json\n{"answer":"b"}\n```' }]);
    }
  ]);
  assert.equal(result.result.ok, true);
  assert.deepEqual(result.received, corrected);
  assert.equal(result.classified, 1);
  assert.equal(result.result.collection.evidenceCalls, 0);
  assert.equal(result.result.usage.input, 3);
});

test('AC-31 state updates validate before mutation, reject extras and invented citations, and respect byte boundaries', async () => {
  for (const invalid of [
    call('goal', ''), call('goal', null), call('constraints', ['']), call('observations', 'not array'),
    call('uncertainties', [1]), call('evidence', [{ fact: 'Claim', source: 'e1' }]),
    call('evidence', [{ fact: 'Claim', source: 'conversation' }]),
    call('evidence', [{ fact: 'Claim', source: 'supplied1', extra: 'denied' }]),
    { ...call('goal', 'Goal'), arguments: { value: 'Goal', extra: true } }
  ]) {
    const result = await run([reply([invalid], 'toolUse')]);
    assert.equal(result.result.error.kind, 'invalid-state');
    assert.equal(result.classified, 0);
  }
  const base = { ...state, current_state: [] };
  const bytes = Buffer.byteLength(JSON.stringify(base));
  const atLimit = { ...base, goal: base.goal + 'x'.repeat(12000 - bytes) };
  assert.equal(Buffer.byteLength(JSON.stringify(atLimit)), 12000);
  assert.equal((await run([reply(updates(atLimit), 'toolUse'), reply()])).result.ok, true);
  const over = { ...atLimit, goal: atLimit.goal + 'x' };
  const rejected = await run([reply(updates(over), 'toolUse')]);
  assert.equal(rejected.result.error.kind, 'invalid-state');
  assert.equal(rejected.classified, 0);
});

test('AC-31 source identity follows collection order and replacement can remove stale evidence', async () => {
  const cited = { ...state, evidence: [{ fact: 'File fact', source: 'e1' }] };
  const result = await run([
    reply([{ type: 'toolCall', id: 'read', name: 'magic8ball_read', arguments: { path: 'file' } }, ...updates(cited)], 'toolUse'),
    reply([call('evidence', [], 'clear')], 'toolUse'), reply()
  ], { ...input, context: { workspace: true, conversation: false } }, {
    executeTool: async () => ({ content: [{ type: 'text', text: 'File fact' }] })
  });
  assert.equal(result.result.ok, true);
  assert.deepEqual(result.received.evidence, []);
  assert.equal(result.result.collection.evidenceCalls, 1);
  const early = await run([reply([...updates(cited), { type: 'toolCall', id: 'read', name: 'magic8ball_read', arguments: { path: 'file' } }], 'toolUse')], { ...input, context: { workspace: true, conversation: false } });
  assert.equal(early.result.error.kind, 'invalid-state');
  assert.equal(early.classified, 0);
});

test('AC-32 normal stop requires all explicit sections and never falls back to model JSON', async () => {
  for (const plan of [[reply()], [reply([{ type: 'text', text: JSON.stringify(state) }])], [reply([call('goal', 'Only goal')], 'toolUse'), reply()]]) {
    const result = await run(plan);
    assert.equal(result.result.ok, false, 'normal stop must not substitute prose for owned sections');
    assert.equal(result.result.error.kind, 'invalid-state');
    assert.equal(result.classified, 0);
  }
  const empty = { ...state, current_state: [] };
  assert.equal((await run([reply(updates(empty), 'toolUse'), reply()])).result.ok, true);
});

test('AC-31 AC-32 invocation isolation and non-normal endings discard partial state', async () => {
  const a = run([reply(updates(), 'toolUse'), reply()]);
  const b = run([reply([call('goal', 'Other')], 'toolUse'), reply()]);
  const [good, incomplete] = await Promise.all([a, b]);
  assert.deepEqual(good.received, state);
  assert.equal(incomplete.result.error.kind, 'invalid-state');
  assert.equal((await run([reply()])).result.error.kind, 'invalid-state');
  for (const stopReason of ['length', 'error', 'aborted']) {
    const bad = await run([reply(updates(), 'toolUse'), reply([], stopReason)]);
    assert.equal(bad.result.error.kind, 'builder-failed');
    assert.equal(bad.classified, 0);
  }
  const bad = await run([reply(updates(), 'toolUse'), reply([null])]);
  assert.equal(bad.result.error.kind, 'builder-failed');
  assert.equal(bad.classified, 0);
});

test('AC-33 exploration exceeds previous request, read, and update caps without forced finalization', async () => {
  let reads = 0;
  const plan = Array.from({ length: 10 }, (_, i) => reply([
    { type: 'toolCall', id: `read${i}`, name: 'magic8ball_read', arguments: { path: 'missing' } },
    call('observations', [`Observation ${i}`], `observation${i}`)
  ], 'toolUse'));
  const cited = { ...state, current_state: ['Last observation'], evidence: [{ fact: 'Missing file', source: 'e10' }] };
  plan.push(context => {
    assert.equal(context.tools.length, 6);
    assert.match(context.systemPrompt, /e10/);
    assert.doesNotMatch(context.systemPrompt, /requestsRemaining|finalize|evidenceCallsRemaining/);
    return reply(updates(cited), 'toolUse');
  }, reply());
  const result = await run(plan, { ...input, context: { conversation: false, workspace: true } }, {
    executeTool: async () => { reads++; return { content: [{ type: 'text', text: JSON.stringify({ code: 'path-not-found', text: 'Path absent.', truncated: false }) }] }; }
  });
  assert.equal(result.result.ok, true);
  assert.deepEqual(result.received, cited);
  assert.equal(reads, 10);
  assert.equal(result.result.collection.evidenceCalls, 10);
  assert.equal(result.result.usage.input, 13);
});

test('AC-33 context estimate includes complete logical payload and stops before an over-window provider request', async () => {
  let requests = 0;
  await assert.rejects(buildState(validateRequest(input), dependencies([reply(updates(), 'toolUse'), reply()], {
    contextWindow: 2048,
    complete: async () => { requests++; return reply(); }
  }), new AbortController().signal, () => {}), e => e.kind === 'budget-exhausted');
  assert.equal(requests, 0);
  assert.equal(typeof decision.checkContextWindow, 'function');
  const value = { systemPrompt: 'Prompt', tools: [{ name: 'State', parameters: { description: 'Tool schema' } }], messages: ['Owned state', 'Source IDs'] };
  assert.equal(JSON.stringify(value).length, 135);
  const count = 39; // ceil(135 / 3.5), independent of the installed host's estimator version.
  assert.doesNotThrow(() => decision.checkContextWindow(value, count + 2048, 2048));
  assert.throws(() => decision.checkContextWindow(value, count + 2047, 2048), e => e.kind === 'budget-exhausted');
  assert.throws(() => decision.checkContextWindow({ ...value, systemPrompt: 'P'.repeat(100) }, count + 2048, 2048), e => e.kind === 'budget-exhausted');
});

test('AC-31 AC-33 registered boundary keeps local tools private and checks classifier context', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'magic8ball-owned-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  await writeFile(join(dir, 'magic8ball.json'), JSON.stringify(models));
  const registered = new Map();
  extension({ on() {}, registerCommand() {}, registerTool: tool => registered.set(tool.name, tool) });
  assert.deepEqual([...registered.keys()].sort(), ['magic8ball', 'magic8ball_list', 'magic8ball_read', 'magic8ball_search']);
  let builders = 0, classifiers = 0, contextWindow = 32000;
  const ctx = { cwd: dir, isProjectTrusted: () => false, executeTool: async () => assert.fail('local tools stay private'), modelRegistry: {
    find: () => ({ ...models.builder, id: 'offline', api: 'test', contextWindow: 32000 }),
    findOfType: () => ({ ...models.classifier, id: 'offline', contextWindow }),
    streamSimple: (_model, context) => ({ result: async () => {
      assert.deepEqual(context.tools.map(tool => tool.name), names);
      return ++builders % 2 ? reply(updates(), 'toolUse') : reply();
    } }),
    classify: async (_model, context) => {
      classifiers++;
      assert.deepEqual(context, { state, questions: { decision: { type: 'choice', instructions: input.question, criteria: validateRequest(input).responses } } });
      return answer;
    }
  } };
  const main = registered.get('magic8ball');
  const good = await main.execute('good', input, undefined, undefined, ctx);
  assert.equal(good.details.ok, true);
  assert.equal(classifiers, 1);
  assert.equal(Compile(main.outputSchema).Check(good.structuredContent), true);
  contextWindow = 1;
  const bad = await main.execute('over', input, undefined, undefined, ctx);
  assert.equal(bad.details.error.kind, 'budget-exhausted');
  assert.equal(classifiers, 1);
});

test('AC-31 rejected updates are atomic, UTF-8 bounded, and isolated from caller aliases', () => {
  const owned = new BuilderState();
  const args = { value: [{ fact: 'Original', source: 'e1' }] };
  owned.apply('magic8ball_set_evidence', args, ['e1']);
  const before = owned.serialize();
  args.value[0].fact = 'Caller mutation';
  owned.snapshot().evidence[0].source = 'Snapshot mutation';
  assert.equal(owned.serialize(), before);
  const oversized = { value: ['😀'.repeat(3000)] };
  assert.ok(JSON.stringify(oversized).length < 12000);
  assert.throws(() => owned.apply('magic8ball_set_observations', oversized, ['e1']), e => e.kind === 'invalid-state');
  assert.equal(owned.serialize(), before);
  for (const name of ['magic8ball_set_constraints', 'magic8ball_set_observations', 'magic8ball_set_evidence', 'magic8ball_set_uncertainties']) {
    assert.throws(() => owned.apply(name, { value: new Array(1) }, ['e1']), e => e.kind === 'invalid-state');
    assert.equal(owned.serialize(), before);
  }
  assert.throws(() => owned.apply('magic8ball_set_evidence', { value: [{ fact: 'Invalid', source: 'e2' }] }, ['e1']), e => e.kind === 'invalid-state');
  assert.equal(owned.serialize(), before);
});

test('AC-32 invalid updates and length endings after complete state cannot classify old state', async () => {
  const invalid = await run([reply(updates(), 'toolUse'), reply([call('goal', '', 'bad')], 'toolUse')]);
  assert.equal(invalid.result.error.kind, 'invalid-state');
  assert.equal(invalid.classified, 0);
  const truncated = await run([reply(updates(), 'toolUse'), reply([call('observations', ['Partial'], 'partial')], 'length')]);
  assert.equal(truncated.result.error.kind, 'builder-failed');
  assert.equal(truncated.classified, 0);
});

test('AC-32 timeout or cancellation after updates rejects late mutations and classification', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    let release, entered, requests = 0, mutations = 0, classified = 0;
    const pending = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { entered = resolve; });
    const work = decide(input, {
      prepare: async () => models,
      build: (r, signal, record, execution) => buildState(r, {
        tools: [], conversation: [], execution, recordState: () => { mutations++; },
        complete: async () => {
          if (!requests++) return reply(updates(), 'toolUse');
          entered(); return pending;
        }, executeTool: async () => assert.fail('private state')
      }, signal, record),
      classify: async () => { classified++; return answer; }
    }, controller.signal, cancel ? 1000 : 30);
    await ready;
    if (cancel) controller.abort();
    const result = await work;
    assert.equal(result.error.kind, cancel ? 'cancelled' : 'timeout');
    const before = JSON.stringify(result);
    release(reply([call('goal', 'Late mutation', 'late')], 'toolUse'));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(mutations, 5);
    assert.equal(classified, 0);
    assert.equal(JSON.stringify(result), before);
  }
});

test('AC-33 growing transcript is checked again before each provider request', async () => {
  let requests = 0, contextWindow;
  const deps = dependencies([], { executeTool: async () => ({ content: [{ type: 'text', text: 'Fact'.repeat(4000) }] }) });
  Object.defineProperty(deps, 'contextWindow', { get: () => contextWindow });
  deps.complete = async context => {
    requests++;
    contextWindow = Math.ceil(JSON.stringify(context).length / 3.5) + 2048;
    return reply([{ type: 'toolCall', id: 'read', name: 'magic8ball_read', arguments: { path: 'file' } }], 'toolUse');
  };
  await assert.rejects(buildState(validateRequest({ ...input, context: { workspace: true, conversation: false } }), deps, new AbortController().signal, () => {}), e => e.kind === 'budget-exhausted');
  assert.equal(requests, 1);
});

test('AC-34 transcript keeps declared state values and confirmations, not unknown fields', () => {
  const store = new TranscriptStore(); store.setEnabled(true);
  const recorder = store.begin('local');
  recorder.builderResponse(reply([{ ...call('evidence', [{ fact: 'STATE_VALUE', source: 'supplied1', extra: 'UNKNOWN_ENTRY' }]), arguments: { value: [{ fact: 'STATE_VALUE', source: 'supplied1', extra: 'UNKNOWN_ENTRY' }], extra: 'UNKNOWN_ARGUMENT' } }, { type: 'thinking', thinking: 'HIDDEN_REASONING' }], 'toolUse'));
  assert.equal(typeof recorder.stateResult, 'function');
  recorder.stateResult({ role: 'toolResult', toolName: 'magic8ball_set_evidence', toolCallId: 'evidence', content: [{ type: 'text', text: '{"updated":"evidence"}' }], isError: false, timestamp: 1 });
  recorder.finish({ ok: true });
  assert.match(store.showText(), /STATE_VALUE|supplied1/);
  assert.match(store.showText(), /state result|updated/);
  assert.doesNotMatch(store.showText(), /UNKNOWN_ENTRY|UNKNOWN_ARGUMENT|HIDDEN_REASONING/);
  store.setEnabled(false);
  assert.doesNotMatch(store.showText(), /STATE_VALUE/);
});

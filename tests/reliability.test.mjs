import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compile } from 'typebox/compile';
import { visibleWidth } from '@earendil-works/pi-tui';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import * as piAi from '@earendil-works/pi-ai';
// Pi 1.1 provider entry points take normalized transcript context; 1.0 accepts the shorthand.
const providerContext = context => piAi.normalizeContext ? piAi.normalizeContext(context) : context;
import extension from '../magic8ball.ts';
import { stateCalls, stateStream } from './helpers/state.mjs';
import { decide, parseSettings } from '../lib/decision.ts';
import { loadSettings, settingsPaths, saveSettingsPatch } from '../lib/settings.ts';
import { argumentCompletions } from '../lib/completions.ts';

const state = { goal: 'Choose', constraints: [], current_state: [], evidence: [], uncertainties: ['Unknown fact'] };
const usage = { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 16, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: .001 } };
const request = { question: 'Which?', responses: { a: 'A', b: 'B' }, context: { conversation: false, workspace: false } };
const models = { builder: { provider: 'openai', model: 'offline' }, classifier: { provider: 'typesafe', model: 'offline' } };
const secret = 'PRIVATE_PROVIDER_PAYLOAD';
const reply = overrides => ({ role: 'assistant', provider: 'openai', model: 'offline', api: 'openai-responses', timestamp: 1, content: [{ type: 'text', text: JSON.stringify(state) }], stopReason: 'stop', usage, ...overrides });
const answer = overrides => ({ stopReason: 'stop', usage, answers: { decision: { type: 'choice', choice: 'a', confidence: .6, probabilities: { a: .8, b: .1, insufficient_evidence: .1 } } }, ...overrides });
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fixture(t, settings = models) {
  const root = await mkdtemp(join(tmpdir(), 'magic8ball-reliability-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace'), agent = join(root, 'agent');
  await mkdir(join(cwd, '.pi'), { recursive: true }); await mkdir(agent);
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; });
  const paths = settingsPaths(cwd, agent); await writeFile(paths.global, JSON.stringify(settings));
  const tools = new Map(), commands = new Map(), calls = [], notices = [], progress = [];
  extension({ on() {}, registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command) });
  const sdkModel = { provider: 'openai', id: 'offline', name: 'Offline fixture', api: 'openai-responses', baseUrl: 'https://offline.invalid/v1', input: ['text'], reasoning: false, contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const ctx = { cwd, hasUI: true, mode: 'tui', isProjectTrusted: () => true, waitForIdle: async () => {}, ui: { notify: (text, level) => notices.push({ text, level }) }, modelRegistry: {
    find: () => sdkModel, findOfType: () => ({ provider: 'typesafe', id: 'offline' }),
    streamSimple: stateStream((_model, context, options) => { calls.push({ role: 'builder', context, options }); return { result: async () => reply() }; }),
    classify: async (_model, context, options) => { calls.push({ role: 'classifier', context, options }); return answer(); }
  } };
  const main = tools.get('magic8ball');
  const invoke = (input = request, signal) => main.execute('test', input, signal, value => progress.push(value), ctx);
  const command = args => commands.get('magic8ball').handler(args, ctx);
  const checked = result => { assert.ok(Compile(main.outputSchema).Check(result.details)); assert.deepEqual(JSON.parse(result.content[0].text), result.details); assert.deepEqual(result.structuredContent, result.details); assert.ok(!JSON.stringify(result).includes(secret)); return result.details; };
  return { paths, ctx, sdkModel, calls, notices, progress, main, invoke, command, checked };
}

test('AC-21 timeout settings bounds, precedence, trust, and locked field preservation', async t => {
  for (const timeoutMs of [1, 2147483647]) assert.equal(parseSettings({ timeoutMs }).timeoutMs, timeoutMs);
  for (const timeoutMs of [null, 0, -1, 1.5, '10', 2147483648, Infinity]) assert.throws(() => parseSettings({ timeoutMs }), e => e.kind === 'invalid-config');
  const f = await fixture(t, { ...models, timeoutMs: 45000 });
  await writeFile(f.paths.project, JSON.stringify({ builder: { provider: 'other', model: 'other' } }));
  assert.equal((await loadSettings(f.paths, true)).settings.timeoutMs, 45000);
  await writeFile(f.paths.project, JSON.stringify({ timeoutMs: 60000 }));
  const effective = await loadSettings(f.paths, true); assert.equal(effective.settings.timeoutMs, 60000); assert.deepEqual(effective.settings.builder, models.builder); assert.equal(effective.sources.timeoutMs, 'project');
  await writeFile(f.paths.project, '{bad'); assert.equal((await loadSettings(f.paths, false)).settings.timeoutMs, 45000);
  await saveSettingsPatch(f.paths, 'global', { builder: { provider: 'new', model: 'new' } }, true);
  assert.equal(JSON.parse(await readFile(f.paths.global)).timeoutMs, 45000);
});

test('AC-21 registered timeout query/save/reset works without models or generation', async t => {
  const f = await fixture(t, {});
  await f.command('timeout'); assert.match(f.notices.at(-1).text, /120000/); assert.deepEqual(JSON.parse(await readFile(f.paths.global)), {});
  await f.command('timeout 45000'); assert.deepEqual(JSON.parse(await readFile(f.paths.global)), { timeoutMs: 45000 });
  await writeFile(f.paths.project, JSON.stringify({ builder: models.builder }));
  await f.command('--project timeout 90000'); assert.deepEqual(JSON.parse(await readFile(f.paths.project)), { builder: models.builder, timeoutMs: 90000 });
  await f.command('--project timeout default'); assert.deepEqual(JSON.parse(await readFile(f.paths.project)), { builder: models.builder });
  await f.command('timeout default'); assert.deepEqual(JSON.parse(await readFile(f.paths.global)), {});
  for (const args of ['timeout 0', 'timeout 1.5', 'timeout +2', 'timeout 2147483648', 'timeout default extra']) { await f.command(args); assert.equal(f.notices.at(-1).level, 'error'); }
  f.ctx.isProjectTrusted = () => false; await f.command('--project timeout 1'); assert.equal(f.notices.at(-1).level, 'error');
  assert.equal(f.calls.length, 0);
});

test('AC-21 timeout autocomplete is static and preserves grammar/separators', async () => {
  assert.ok((await argumentCompletions('')).some(x => x.label === 'timeout'));
  assert.deepEqual((await argumentCompletions('--project\ttimeout d')).map(x => x.value), ['--project\ttimeout default ']);
  assert.equal(await argumentCompletions('timeout invalid '), null);
  assert.equal(await argumentCompletions('timeout default --global --'), null);
});

test('AC-21 each provider receives a decreasing positive integer deadline without toolChoice', async t => {
  const f = await fixture(t, { ...models, timeoutMs: 1000 });
  f.ctx.modelRegistry.find = () => { const start = performance.now(); while (performance.now() - start < 10) {} return f.sdkModel; };
  const original = f.ctx.modelRegistry.streamSimple; f.ctx.modelRegistry.streamSimple = (...args) => { const stream = original(...args); return { result: async () => { await sleep(10); return stream.result(); } }; };
  const result = f.checked(await f.invoke()); assert.equal(result.ok, true);
  const [builder, classifier] = f.calls.map(x => x.options.timeoutMs);
  assert.ok(Number.isInteger(builder) && builder > 0 && builder < 1000);
  assert.ok(Number.isInteger(classifier) && classifier > 0 && classifier < builder);
  for (const { options } of f.calls) { assert.equal(options.maxRetries, 0); assert.equal(Object.hasOwn(options, 'toolChoice'), false); }
});

test('AC-21 elapsed preparation prevents generation', async t => {
  const f = await fixture(t, { ...models, timeoutMs: 1 });
  f.ctx.modelRegistry.find = () => { const start = performance.now(); while (performance.now() - start < 10) {} return f.sdkModel; };
  const result = f.checked(await f.invoke()); assert.equal(result.error.kind, 'timeout'); assert.equal(result.usageComplete, true); assert.equal(f.calls.length, 0);
});

test('AC-21 AC-22 ignored-abort timeout and late completion cannot change result/progress or classify', async t => {
  const f = await fixture(t, { ...models, timeoutMs: 20 }); const pending = defer();
  f.ctx.modelRegistry.streamSimple = () => ({ result: () => pending.promise });
  const result = await f.invoke({ ...request, diagnostics: true }); const snapshot = JSON.stringify(result), updates = f.progress.length;
  assert.equal(f.checked(result).error.kind, 'timeout'); assert.equal(result.details.usageComplete, false); assert.equal(result.details.error.diagnostics.phase, 'builder');
  pending.resolve(reply()); await sleep(5); assert.equal(JSON.stringify(result), snapshot); assert.equal(f.progress.length, updates); assert.equal(f.calls.length, 0);
});

test('AC-22 complete known usage on success, rejected state/answer, evidence failure; no attempt is known zero', async t => {
  const f = await fixture(t); const good = f.checked(await f.invoke()); assert.equal(good.usageComplete, true); assert.equal(good.usage.input, 20);
  f.ctx.modelRegistry.streamSimple = () => ({ result: async () => reply({ content: [{ type: 'text', text: 'not JSON' }] }) });
  const invalid = f.checked(await f.invoke({ ...request, diagnostics: true })); assert.equal(invalid.usageComplete, true); assert.equal(invalid.usage.input, 10); assert.equal(invalid.error.diagnostics.phase, 'state-validation');
  f.ctx.modelRegistry.streamSimple = stateStream(() => ({ result: async () => reply() })); f.ctx.modelRegistry.classify = async () => answer({ answers: {} });
  const invalidAnswer = f.checked(await f.invoke({ ...request, diagnostics: true })); assert.equal(invalidAnswer.usageComplete, true); assert.equal(invalidAnswer.error.diagnostics.phase, 'answer-validation');
  f.ctx.modelRegistry.streamSimple = () => ({ result: async () => reply({ stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'e', name: 'magic8ball_read', arguments: { path: 'file' } }] }) });
  f.ctx.executeTool = async () => { throw new Error(secret); };
  const denied = f.checked(await f.invoke({ ...request, context: { conversation: false, workspace: true }, diagnostics: true })); assert.equal(denied.usageComplete, true); assert.equal(denied.error.diagnostics.phase, 'evidence');
  const bad = f.checked(await f.invoke({ ...request, question: '' })); assert.equal(bad.usageComplete, true); assert.equal(bad.usage.input, 0);
});

test('AC-22 diagnostics opt-in schema, safe structured hints, status precedence, hostile getters', async t => {
  const f = await fixture(t);
  for (const diagnostics of [null, 1, 'yes', {}]) assert.equal(Compile(f.main.parameters).Check({ ...request, diagnostics }), false);
  assert.equal(Compile(f.main.parameters).Check({ ...request, diagnostics: true }), true);
  for (const [error, category] of [[Object.assign(new Error(secret), { status: 401, code: 'ECONNRESET' }), 'authentication'], [Object.assign(new Error(secret), { status: 429 }), 'rate-limit'], [Object.assign(new Error(secret), { code: 'ECONNRESET' }), 'transport'], [new Error(secret), 'unknown']]) {
    f.ctx.modelRegistry.streamSimple = () => { throw error; };
    const result = f.checked(await f.invoke({ ...request, diagnostics: true })); assert.equal(result.error.diagnostics.category, category); assert.equal(result.usageComplete, false); assert.equal(result.error.diagnostics.phase, 'builder');
    for (const diagnostics of [undefined, false]) { const normal = f.checked(await f.invoke({ ...request, ...(diagnostics === undefined ? {} : { diagnostics }) })); assert.equal(Object.hasOwn(normal.error, 'diagnostics'), false); }
  }
  let getters = 0; const hostile = new Error(secret); Object.defineProperty(hostile, 'status', { get() { getters++; throw new Error(secret); } });
  f.ctx.modelRegistry.streamSimple = () => { throw hostile; }; assert.equal(f.checked(await f.invoke({ ...request, diagnostics: true })).error.diagnostics.category, 'unknown'); assert.equal(getters, 0);
});

test('AC-22 terminal failure, missing usage, malformed content and preparation diagnostics stay private', async t => {
  const f = await fixture(t);
  for (const stopReason of ['error', 'aborted']) { f.ctx.modelRegistry.streamSimple = () => ({ result: async () => reply({ stopReason, errorMessage: secret }) }); const result = f.checked(await f.invoke({ ...request, diagnostics: true })); assert.equal(result.usageComplete, true); assert.equal(result.error.diagnostics.category, stopReason === 'error' ? 'provider-error' : 'provider-aborted'); }
  f.ctx.modelRegistry.streamSimple = stateStream(() => ({ result: async () => reply({ usage: undefined }) })); f.ctx.modelRegistry.classify = async () => answer();
  const missing = f.checked(await f.invoke()); assert.equal(missing.ok, true); assert.equal(missing.usageComplete, false); assert.equal(missing.usage.input, 10);
  f.ctx.modelRegistry.streamSimple = () => ({ result: async () => reply({ content: [null] }) }); const malformed = f.checked(await f.invoke({ ...request, diagnostics: true })); assert.equal(malformed.error.kind, 'builder-failed'); assert.equal(malformed.error.diagnostics.category, 'extension-error');
  f.ctx.modelRegistry.find = () => { throw new Error(secret); }; const prep = f.checked(await f.invoke({ ...request, diagnostics: true })); assert.equal(prep.error.diagnostics.phase, 'preparation'); assert.equal(prep.error.diagnostics.category, 'local-error'); assert.equal(prep.usageComplete, true);
});

test('AC-22 classifier exception and caller cancellation retain known usage and mark incompleteness', async t => {
  const f = await fixture(t); f.ctx.modelRegistry.classify = async () => { throw Object.assign(new Error(secret), { status: 400 }); };
  const failed = f.checked(await f.invoke({ ...request, diagnostics: true })); assert.equal(failed.usageComplete, false); assert.equal(failed.usage.input, 10); assert.equal(failed.error.diagnostics.phase, 'classifier'); assert.equal(failed.error.diagnostics.category, 'provider-rejection');
  const pending = defer(), started = defer(), controller = new AbortController(); f.ctx.modelRegistry.classify = async () => { started.resolve(); return pending.promise; };
  const work = f.invoke({ ...request, diagnostics: true }, controller.signal); await started.promise; controller.abort(); const cancelled = await work;
  assert.equal(f.checked(cancelled).usageComplete, false); assert.equal(cancelled.details.error.kind, 'cancelled'); const before = JSON.stringify(cancelled); pending.resolve(answer()); await sleep(5); assert.equal(JSON.stringify(cancelled), before);
});

test('AC-23 full sanitized multiline question/choices and usage display preserve data and width', async t => {
  const f = await fixture(t); const args = { ...request, question: 'Question\n' + '界 long '.repeat(25) + '\x1bQUESTION_TAIL', responses: { a: 'Choice\n' + 'long '.repeat(25) + '\x1bCHOICE_TAIL', b: 'B' } };
  const result = await f.invoke(); const before = JSON.stringify(result), calls = f.calls.length; const theme = { fg: (_color, text) => text };
  for (const width of [1, 8, 30, 80]) {
    const call = f.main.renderCall(args, theme).render(width); assert.ok(call.every(line => visibleWidth(line) <= width));
    const text = call.join('').replace(/\x1b\[0m/g, ''); assert.match(text, /QUESTION_TAIL/); assert.match(text, /CHOICE_TAIL/); assert.doesNotMatch(text, /\x1b/);
    for (const expanded of [false, true]) { const output = f.main.renderResult(result, { expanded, isPartial: false }, theme).render(width); assert.ok(output.every(line => visibleWidth(line) <= width)); assert.match(output.join(''), /reported|Reported/); }
  }
  result.details.usageComplete = false; assert.match(f.main.renderResult(result, { expanded: false, isPartial: false }, theme).render(80).join('\n'), /incomplete/i); result.details.usageComplete = true;
  assert.equal(JSON.stringify(result), before); assert.equal(f.calls.length, calls);
});

test('AC-21 late preparation cannot rearm deadline or change progress', async () => {
  const pending = defer(), updates = []; let builds = 0, blocked = false;
  const result = await decide({ ...request, diagnostics: true }, {
    prepare: async execution => { await pending.promise; try { execution.configure(1000); } catch (error) { blocked = true; throw error; } return models; },
    build: async () => { builds++; throw new Error('Unexpected build'); }, classify: async () => answer()
  }, undefined, 10, value => updates.push(value));
  assert.equal(result.error.kind, 'timeout'); assert.equal(result.error.diagnostics.phase, 'preparation'); assert.equal(result.usageComplete, true);
  const before = JSON.stringify(result), count = updates.length;
  pending.resolve(); await sleep(5); assert.equal(blocked, true); assert.equal(builds, 0); assert.equal(updates.length, count); assert.equal(JSON.stringify(result), before);
});

test('AC-23 AC-31 normal stop after state updates succeeds through real Responses SSE with builder-only tools', async t => {
  const f = await fixture(t, { ...models, timeoutMs: 1000 }); let attempts = 0, fetches = 0, adapterFailure, wireTools, wireHasChoice;
  f.ctx.executeTool = async () => ({ isError: false, result: { content: [{ type: 'text', text: JSON.stringify({ text: 'Fixture', truncated: false }) }] } });
  f.ctx.modelRegistry.streamSimple = (model, context, options) => {
    attempts++; assert.ok(Number.isInteger(options.timeoutMs) && options.timeoutMs > 0); assert.equal(options.maxRetries, 0);
    if (attempts < 4) return { result: async () => reply({ stopReason: 'toolUse', content: [{ type: 'toolCall', id: `e${attempts}`, name: 'magic8ball_read', arguments: { path: 'file' } }] }) };
    if (attempts === 4) return { result: async () => reply({ stopReason: 'toolUse', content: stateCalls(state) }) };
    assert.equal(context.tools.length, 8);
    const native = streamSimple(model, providerContext(context), { ...options, apiKey: 'sk-offline-synthetic-not-a-real-key', fetch: async (_url, init) => {
      fetches++; const body = JSON.parse(init.body); wireTools = body.tools?.length; wireHasChoice = Object.hasOwn(body, 'tool_choice');
      const text = 'Exploration complete.', item = { type: 'message', id: 'msg_offline', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
      const events = [{ type: 'response.created', response: { id: 'resp_offline' } }, { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } }, { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'resp_offline', status: 'completed', output: [item], usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } } }];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    } });
    return { result: async () => { const message = await native.result(); adapterFailure = message.errorMessage; return message; } };
  };
  const result = f.checked(await f.invoke({ ...request, diagnostics: true, context: { conversation: false, workspace: true } })); assert.equal(result.ok, true, JSON.stringify({ result, adapterFailure, wireTools, wireHasChoice })); assert.equal(wireTools, 8); assert.equal(wireHasChoice, false); assert.equal(result.usageComplete, true); assert.equal(result.collection.evidenceCalls, 3); assert.equal(attempts, 5); assert.equal(fetches, 1); assert.equal(f.calls.length, 1);
});

test('AC-23 registered request reaches real Responses adapter mock fetch with integer timeout and private HTTP error', async t => {
  const f = await fixture(t, { ...models, timeoutMs: 1000 }); let fetches = 0;
  f.ctx.modelRegistry.streamSimple = (model, context, options) => {
    assert.ok(Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 && options.timeoutMs <= 1000); assert.equal(options.maxRetries, 0);
    return streamSimple(model, providerContext(context), { ...options, apiKey: 'sk-offline-synthetic-not-a-real-key', fetch: async (_url, init) => { fetches++; const body = JSON.parse(init.body); assert.equal(body.tools.length, 5); assert.equal(Object.hasOwn(body, 'tool_choice'), false); return new Response(JSON.stringify({ error: { message: secret } }), { status: 401, headers: { 'content-type': 'application/json' } }); } });
  };
  const result = f.checked(await f.invoke({ ...request, diagnostics: true })); assert.equal(result.ok, false); assert.equal(result.error.kind, 'builder-failed'); assert.equal(fetches, 1); assert.equal(f.calls.length, 0); assert.equal(result.usageComplete, true);
});

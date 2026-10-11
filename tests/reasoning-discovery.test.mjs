import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compile } from 'typebox/compile';
import extension from '../magic8ball.ts';
import { stateStream } from './helpers/state.mjs';
import { parseSettings } from '../lib/decision.ts';
import { BUILDER_PROMPT } from '../lib/builder.ts';
import { evidence } from '../lib/evidence.ts';
import { loadSettings, settingsPaths } from '../lib/settings.ts';
import { renderDecision } from '../lib/render.ts';
import { TranscriptStore } from '../lib/transcripts.ts';
import { visibleWidth } from '@earendil-works/pi-tui';

const models = { builder: { provider: 'test', model: 'builder' }, classifier: { provider: 'test', model: 'classifier' } };
const state = { goal: 'Choose', constraints: [], current_state: [], evidence: [], uncertainties: [] };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const input = { question: 'Which check?', responses: { A: 'Terminal', B: 'Tests' }, context: { conversation: false, workspace: false } };
const call = (id, path) => ({ type: 'toolCall', id, name: 'magic8ball_list', arguments: { path } });
const message = content => ({ role: 'assistant', content, stopReason: content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop', usage, providerThinkingLevel: 'medium' });
const final = value => message([{ type: 'text', text: JSON.stringify(value) }]);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'magic8ball-reasoning-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace'), agent = join(root, 'agent');
  await mkdir(join(cwd, '.pi'), { recursive: true }); await mkdir(join(cwd, 'tests')); await mkdir(agent);
  const saved = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => { saved === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = saved; });
  const paths = settingsPaths(cwd, agent); await writeFile(paths.global, JSON.stringify(models));
  const tools = new Map(), commands = new Map(), notices = [], builderCalls = [], classifierCalls = [], plans = [];
  extension({ on() {}, registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command), setModel: () => assert.fail('Active model changed') });
  const chat = { provider: 'test', id: 'builder', api: 'test', reasoning: true, thinkingLevelMap: { xhigh: null, max: null } };
  const ctx = { cwd, hasUI: true, mode: 'rpc', isProjectTrusted: () => true, waitForIdle: async () => {},
    ui: { notify: (text, level) => notices.push({ text, level }) }, sessionManager: { buildSessionProjection: () => ({ messages: [] }) },
    modelRegistry: { find: () => chat, findOfType: () => ({ provider: 'test', id: 'classifier' }),
      streamSimple: stateStream((_model, context, options) => { builderCalls.push({ context, options }); return { result: async () => plans.shift() ?? final(state) }; }),
      classify: async (_model, context, options) => { classifierCalls.push({ context, options }); return { stopReason: 'stop', usage, answers: { decision: { type: 'choice', choice: 'A', probabilities: { A: .8, B: .1, insufficient_evidence: .1 }, confidence: .4 } } }; } },
    executeTool: async (name, args, { signal }) => { const result = await tools.get(name).execute('nested', args, signal, undefined, ctx); return { result, isError: result.isError ?? false }; },
  };
  const invoke = (args = input) => tools.get('magic8ball').execute('decision', args, undefined, undefined, ctx);
  const command = args => commands.get('magic8ball').handler(args, ctx);
  return { cwd, paths, tools, notices, builderCalls, classifierCalls, plans, ctx, chat, invoke, command };
}

test('AC-18 reasoning settings validate values and preserve whole-role precedence', async t => {
  const f = await fixture(t);
  for (const reasoning of ['default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) assert.equal(parseSettings({ ...models, builder: { ...models.builder, reasoning } }).builder.reasoning, reasoning);
  for (const reasoning of [null, 3, '', 'HIGH', 'bogus']) assert.throws(() => parseSettings({ builder: { ...models.builder, reasoning } }), error => error.kind === 'invalid-config');
  assert.throws(() => parseSettings({ classifier: { ...models.classifier, reasoning: 'high' } }), error => error.kind === 'invalid-config');
  await writeFile(f.paths.global, JSON.stringify({ ...models, builder: { ...models.builder, reasoning: 'high' } }));
  await writeFile(f.paths.project, JSON.stringify({ builder: { ...models.builder, model: 'project' } }));
  assert.equal((await loadSettings(f.paths, true)).settings.builder.reasoning, undefined);
  assert.equal((await loadSettings(f.paths, false)).settings.builder.reasoning, 'high');
});

test('AC-18 user commands query/set reasoning without spending or copying project roles globally', async t => {
  const f = await fixture(t); const before = await readFile(f.paths.global, 'utf8');
  await f.command('reasoning'); assert.match(f.notices.at(-1).text, /medium/); assert.equal(await readFile(f.paths.global, 'utf8'), before);
  await writeFile(f.paths.project, JSON.stringify({ builder: { ...models.builder, model: 'project' } }));
  await f.command('--global reasoning medium'); const global = JSON.parse(await readFile(f.paths.global, 'utf8'));
  assert.deepEqual(global.builder, { ...models.builder, reasoning: 'medium' }); assert.deepEqual(global.classifier, models.classifier);
  await f.command('reasoning low --project'); assert.deepEqual(JSON.parse(await readFile(f.paths.project, 'utf8')).builder, { ...models.builder, model: 'project', reasoning: 'low' });
  const stable = await readFile(f.paths.global, 'utf8');
  for (const args of ['reasoning nope', 'reasoning max', 'reasoning high extra', '--project --global reasoning high']) await f.command(args);
  assert.equal(await readFile(f.paths.global, 'utf8'), stable);
  f.ctx.isProjectTrusted = () => false; const local = await readFile(f.paths.project, 'utf8'); await f.command('--project reasoning medium'); assert.equal(await readFile(f.paths.project, 'utf8'), local);
  assert.equal(f.builderCalls.length + f.classifierCalls.length, 0);
});

test('AC-18 reasoning reaches every builder request, metadata, and safe transcripts only', async t => {
  const f = await fixture(t); await f.command('reasoning medium'); await f.command('transcripts on');
  f.plans.push(message([call('listing', '.')]), final(state));
  const result = await f.invoke({ ...input, context: { conversation: false, workspace: true } }); assert.equal(result.isError, false);
  assert.equal(result.structuredContent.models.builder.reasoning, 'medium');
  assert.ok(Compile(f.tools.get('magic8ball').outputSchema).Check(result.structuredContent));
  assert.equal(f.builderCalls.length, 2); for (const { options } of f.builderCalls) { assert.equal(options.reasoning, 'medium'); assert.equal(options.maxTokens, 2048); assert.equal(options.maxRetries, 0); }
  assert.equal(f.classifierCalls[0].options.reasoning, undefined);
  await f.command('transcripts show'); const text = f.notices.at(-1).text;
  assert.match(text, /"requestedReasoning": "medium"/); assert.match(text, /"maxTokens": 2048/); assert.match(text, /"providerThinkingLevel": "medium"/);
  for (const reasoning of [undefined, 'off', 'default']) {
    await writeFile(f.paths.global, JSON.stringify({ ...models, builder: { ...models.builder, ...(reasoning ? { reasoning } : {}) } }));
    assert.equal((await f.invoke()).isError, false); assert.equal(Object.hasOwn(f.builderCalls.at(-1).options, 'reasoning'), false);
  }
  const count = f.builderCalls.length;
  for (const reasoning of ['max', 'xhigh', 'off', 'medium']) {
    if (reasoning === 'off') f.chat.thinkingLevelMap.off = null;
    if (reasoning === 'medium') f.chat.reasoning = false;
    await writeFile(f.paths.global, JSON.stringify({ ...models, builder: { ...models.builder, reasoning } }));
    assert.equal((await f.invoke()).structuredContent.error.kind, 'unsupported-reasoning'); assert.equal(f.builderCalls.length, count);
  }
  await f.command('reasoning'); assert.match(f.notices.at(-1).text, /Supported builder reasoning: default, off\./);
  assert.equal(Compile(f.tools.get('magic8ball').parameters).Check({ ...input, reasoning: 'medium' }), false);
});

test('AC-18 request transcripts retain safe options and effort labels, never auth or thinking', () => {
  const store = new TranscriptStore(); store.setEnabled(true); const trace = store.begin('options');
  trace.builderRequest(models.builder, { systemPrompt: 'Visible prompt', messages: [] }, { reasoning: 'high', maxTokens: 2048, maxRetries: 0, apiKey: 'OPTION_API_SECRET', headers: { Authorization: 'OPTION_HEADER_SECRET' }, env: { TOKEN: 'OPTION_ENV_SECRET' } }, 'high');
  trace.builderResponse({ role: 'assistant', stopReason: 'stop', providerThinkingLevel: 'high', content: [{ type: 'thinking', thinking: 'REASONING_SECRET', signature: 'SIGNATURE_SECRET' }, { type: 'text', text: 'Visible result' }] });
  trace.finish({ ok: true });
  assert.match(store.showText(), /"requestedReasoning": "high"/); assert.match(store.showText(), /"maxTokens": 2048/); assert.match(store.showText(), /"providerThinkingLevel": "high"/);
  assert.doesNotMatch(store.showText(), /OPTION_API_SECRET|OPTION_HEADER_SECRET|OPTION_ENV_SECRET|REASONING_SECRET|SIGNATURE_SECRET/);
  const clipped = store.begin('truncated'); clipped.builderResponse({ content: [{ type: 'text', text: '😀'.repeat(80000) }] });
  clipped.evidenceFailure('magic8ball_list', 'failed-call-id', 'path-denied'); clipped.finish({ ok: false });
  const diagnostic = store.showText();
  for (const marker of ['evidence failure', 'failed-call-id', 'path-denied']) assert.ok(diagnostic.includes(marker), `Truncated transcript must retain ${marker}`);
  assert.ok(Buffer.byteLength(store.latest.text) <= 128000);
  const retained = store.latest; store.setEnabled(false); assert.equal(retained.failure, undefined);
});

test('AC-19 permitted missing paths are coded observations, invalid or unsafe paths remain failures', async t => {
  const f = await fixture(t);
  for (const operation of ['read', 'list', 'search']) { const result = await evidence(f.cwd, operation, { path: 'test', ...(operation === 'search' ? { text: 'match' } : {}) }); assert.equal(result.code, 'path-not-found'); assert.equal(result.truncated, false); }
  await writeFile(join(f.cwd, 'file'), 'plain'); await symlink('tests', join(f.cwd, 'link'));
  for (const [operation, args, code] of [
    ['read', { path: 'missing', limit: null }, 'invalid-arguments'], ['search', { path: 'missing', text: '' }, 'invalid-arguments'],
    ['read', { path: 'missing', byteOffset: -1 }, 'invalid-arguments'], ['read', { path: 'missing/.env' }, 'path-denied'],
    ['read', { path: '../missing' }, 'path-denied'], ['read', { path: 'link/missing' }, 'path-denied'],
    ['list', { path: 'file/child' }, 'wrong-type'], ['read', { path: 'tests' }, 'wrong-type'],
  ]) await assert.rejects(() => evidence(f.cwd, operation, args), error => error.evidenceCode === code, JSON.stringify(args));
  await assert.rejects(() => evidence(join(f.cwd, 'absent-root'), 'list', { path: '.' }), error => error.evidenceCode === 'io-failed');
});

test('AC-19 reproduces batched directory guess and permits bounded evidence-based continuation', async t => {
  const f = await fixture(t); await f.command('transcripts on');
  f.plans.push(message([call('parent', '.'), call('guess', 'test')]), message([call('discovered', 'tests')]), final({ ...state, evidence: [{ fact: 'The guessed test directory was absent when checked.', source: 'e2' }], uncertainties: ['A guessed path was absent; directory discovery was needed.'] }));
  const result = await f.invoke({ ...input, context: { workspace: true, conversation: false } });
  assert.equal(result.isError, false); assert.equal(result.structuredContent.collection.evidenceCalls, 3);
  assert.equal(result.structuredContent.collection.evidence[1].code, 'path-not-found');
  const results = f.builderCalls[1].context.messages.filter(m => m.role === 'toolResult'); assert.equal(results.length, 2); assert.match(JSON.stringify(results), /tests\/|path-not-found/);
  assert.equal(f.classifierCalls.length, 1); assert.match(BUILDER_PROMPT, /wait/i); assert.match(BUILDER_PROMPT, /guess/i);
  const rendered = renderDecision(result.details, true, false, text => text).render(80).join('\n'); assert.match(rendered, /path-not-found/);
  await f.command('transcripts show'); assert.match(f.notices.at(-1).text, /path-not-found/);
});

test('AC-19 AC-33 missing observations continue beyond eight calls with state tools available', async t => {
  const f = await fixture(t); f.plans.push(message(Array.from({ length: 8 }, (_, i) => call(`missing-${i}`, `absent-${i}`))), final({ ...state, uncertainties: ['All eight inspected paths were absent.'] }));
  const result = await f.invoke({ ...input, context: { workspace: true, conversation: false } }); assert.equal(result.isError, false);
  assert.equal(result.structuredContent.collection.evidenceCalls, 8); assert.ok(result.structuredContent.collection.evidence.every(e => e.code === 'path-not-found'));
  assert.equal(f.builderCalls[1].context.tools.length, 8);
  const classified = f.classifierCalls.length;
  f.plans.push(message(Array.from({ length: 9 }, (_, i) => call(`next-${i}`, `absent-${i}`))), final(state));
  const continued = await f.invoke({ ...input, context: { workspace: true, conversation: false } });
  assert.equal(continued.structuredContent.ok, true); assert.equal(continued.structuredContent.collection.evidenceCalls, 9);
  assert.equal(f.classifierCalls.length, classified + 1);
});

test('AC-19 hook errors cannot masquerade as recoverable absence or leak raw text', async t => {
  const f = await fixture(t); await f.command('transcripts on');
  for (const throws of [false, true]) {
    f.plans.push(message([call('denied-call', 'test')]));
    f.ctx.executeTool = async () => { if (throws) throw Object.assign(new Error('HOOK_SECRET'), { code: 'ENOENT' }); return { isError: true, result: { content: [{ type: 'text', text: JSON.stringify({ code: 'path-not-found', text: 'HOOK_SECRET', truncated: false }) }] } }; };
    const result = await f.invoke({ ...input, context: { workspace: true, conversation: false } }); assert.equal(result.structuredContent.error.kind, 'evidence-failed'); assert.equal(result.structuredContent.error.evidenceCode, 'tool-denied-or-failed');
    assert.equal(f.classifierCalls.length, 0); await f.command('transcripts show'); assert.match(f.notices.at(-1).text, /evidence failure/); assert.match(f.notices.at(-1).text, /denied-call/); assert.doesNotMatch(f.notices.at(-1).text, /HOOK_SECRET/);
  }
});

test('AC-19 hard helper failures expose finite diagnostics through the actual boundary and renderer', async t => {
  const f = await fixture(t); await f.command('transcripts on');
  f.plans.push(message([call('forbidden', '.env')])); const result = await f.invoke({ ...input, context: { workspace: true, conversation: false } });
  assert.equal(result.structuredContent.error.evidenceCode, 'path-denied'); assert.equal(f.classifierCalls.length, 0);
  assert.ok(Compile(f.tools.get('magic8ball').outputSchema).Check(result.structuredContent));
  for (const width of [1, 30, 80]) { const lines = renderDecision(result.details, true, false, text => text).render(width); assert.ok(lines.every(line => visibleWidth(line) <= width)); if (width === 80) assert.match(lines.join('\n'), /path-denied/); }
  await f.command('transcripts show'); assert.match(f.notices.at(-1).text, /path-denied/);
});

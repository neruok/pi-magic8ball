import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import extension from '../magic8ball.ts';
// Load the installed session core without the CLI's unrelated startup imports.
const piEntry = new URL(import.meta.resolve('@earendil-works/pi-coding-agent'));
const { SessionManager } = await import(new URL('./core/session-manager.js', piEntry));
import { Compile } from 'typebox/compile';

const envNames = ['PI_CODING_AGENT_DIR'];
const state = { goal: 'Add a tool', constraints: [], current_state: [], evidence: [{ fact: 'Fixture exists', source: 'README.md' }], uncertainties: [] };
const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function registrations() { const tools = new Map(); extension({ registerTool: t => tools.set(t.name, t), registerCommand: () => {} }); return tools; }

test('AC-6 registers advisory model-only tool and inactive readonly evidence schemas', () => {
  const tools = registrations(); assert.equal(tools.size, 4);
  const main = tools.get('magic8ball'); assert.equal(main.exposure, 'model-only'); assert.ok(main.outputSchema); assert.match(main.description, /advisory/i); assert.match(main.description, /not.*correct/i);
  for (const name of ['magic8ball_read', 'magic8ball_list', 'magic8ball_search']) { const t = tools.get(name); assert.equal(t.exposure, 'codemode'); assert.equal(t.annotations.readOnlyHint, true); assert.equal(t.annotations.openWorldHint, false); assert.equal(t.annotations.destructiveHint, false); }
  assert.equal(Compile(main.parameters).Check({ question: 'Q', responses: { a: 'A', b: 'B' }, context: { web: true } }), false);
});

test('AC-5 AC-6 host-selected Jev and Clef use Pi classifier API, nested hooks and aggregate usage', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'magic8ball-extension-')); t.after(() => rm(dir, { recursive: true, force: true })); await writeFile(join(dir, 'README.md'), 'Fixture exists');
  const saved = Object.fromEntries(envNames.map(n => [n, process.env[n]])); t.after(() => { for (const n of envNames) saved[n] === undefined ? delete process.env[n] : process.env[n] = saved[n]; });
  process.env.PI_CODING_AGENT_DIR = dir;
  for (const [provider, id] of [['typesafe', 'jev-latest'], ['cloudflare-workers-ai', '@cf/cloudflare/clef']]) {
    await writeFile(join(dir, 'magic8ball.json'), JSON.stringify({ builder: { provider: 'cheap', model: 'small' }, classifier: { provider, model: id } }));
    const tools = registrations(), main = tools.get('magic8ball'); let requests = 0, classifierCalls = 0, nestedCalls = 0;
    const sessionManager = SessionManager.inMemory(dir); sessionManager.appendMessage({ role: 'user', content: 'CONVERSATION_MARKER', timestamp: 1 });
    const ctx = { cwd: dir, isProjectTrusted: () => true, sessionManager, modelRegistry: {
      find: (p, m) => p === 'cheap' && m === 'small' ? { provider: p, id: m, api: 'test' } : undefined,
      findOfType: (type, p, m) => type === 'classifier' && p === provider && m === id ? { provider: p, id: m } : undefined,
      streamSimple: (_model, context, options) => ({ result: async () => {
        requests++; assert.equal(options.maxRetries, 0); assert.ok(options.signal); assert.match(JSON.stringify(context.messages), /CONVERSATION_MARKER/); assert.doesNotMatch(JSON.stringify(context.messages), /probabilities/);
        return { role: 'assistant', content: requests === 1 ? [{ type: 'toolCall', id: 'read1', name: 'magic8ball_read', arguments: { path: 'README.md' } }] : [{ type: 'text', text: JSON.stringify(state) }], stopReason: requests === 1 ? 'toolUse' : 'stop', usage, timestamp: 1, api: 'test', provider: 'cheap', model: 'small' };
      } }),
      classify: async (model, context, options) => { classifierCalls++; assert.equal(model.id, id); assert.deepEqual(context.state, state); assert.equal(context.questions.decision.type, 'choice'); assert.deepEqual(Object.keys(context.questions.decision.criteria), ['a', 'b', 'insufficient_evidence']); assert.equal(options.maxRetries, 0); return { stopReason: 'stop', usage, answers: { decision: { type: 'choice', choice: 'b', probabilities: { a: .1, b: .8, insufficient_evidence: .1 }, confidence: .55 } } }; }
    }, executeTool: async (name, args, options) => { nestedCalls++; assert.ok(options.signal); const tool = tools.get(name); assert.ok(Compile(tool.parameters).Check(args)); const result = await tool.execute('nested', args, options.signal, undefined, ctx); return { result, isError: Boolean(result.isError), toolCall: { name, arguments: args, id: 'nested' } }; } };
    const r = await main.execute('main', { question: 'Which?', responses: { a: 'A', b: 'B' } }, undefined, undefined, ctx);
    assert.equal(r.isError, false); assert.equal(r.structuredContent.answer, 'b'); assert.equal(r.structuredContent.confidence, .55); assert.equal(requests, 2); assert.equal(classifierCalls, 1); assert.equal(nestedCalls, 1); assert.equal(r.usage.input, 30); assert.ok(Compile(main.outputSchema).Check(r.structuredContent));
    const physicalFind = ctx.modelRegistry.find;
    ctx.modelRegistry.find = (p, m) => ({ provider: p, id: m, api: 'pi-virtual' }); requests = 0;
    const virtual = await main.execute('main', { question: 'Which?', responses: { a: 'A', b: 'B' } }, undefined, undefined, ctx);
    assert.equal(virtual.isError, true); assert.equal(virtual.structuredContent.error.kind, 'model-unavailable'); assert.equal(requests, 0); assert.equal(classifierCalls, 1);
    ctx.modelRegistry.find = physicalFind;
    ctx.executeTool = async () => ({ isError: true, result: { content: [{ type: 'text', text: 'Denied' }], details: undefined } }); requests = 0;
    const denied = await main.execute('main', { question: 'Which?', responses: { a: 'A', b: 'B' } }, undefined, undefined, ctx); assert.equal(denied.isError, true); assert.equal(denied.structuredContent.error.kind, 'evidence-failed'); assert.equal(classifierCalls, 1); assert.equal(denied.usage.input, 10); assert.ok(Compile(main.outputSchema).Check(denied.structuredContent));
  }
  await writeFile(join(dir, 'magic8ball.json'), '{}');
  const tools = registrations(); const bad = await tools.get('magic8ball').execute('main', { question: 'Which?', responses: { a: 'A', b: 'B' } }, undefined, undefined, { cwd: dir, isProjectTrusted: () => true }); assert.equal(bad.structuredContent.error.kind, 'not-configured'); assert.equal(bad.isError, true);
});

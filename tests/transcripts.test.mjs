import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import { Compile } from 'typebox/compile';
import extension from '../magic8ball.ts';
import { TranscriptStore, createTranscriptViewer } from '../lib/transcripts.ts';
import { decide } from '../lib/decision.ts';

const models = { builder: { provider: 'test', model: 'builder' }, classifier: { provider: 'test', model: 'classifier' } };
const state = { goal: 'Choose', constraints: [], current_state: [], evidence: [{ fact: 'Observed', source: 'e1' }], uncertainties: [] };
const input = { question: 'REQUEST_VISIBLE', responses: { A: 'Keep', B: 'Change' } };
const usage = { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const raw = { stopReason: 'stop', errorMessage: 'PROVIDER_ERROR_SECRET', headers: { Authorization: 'AUTH_HEADER_SECRET' }, answers: { decision: { type: 'choice', choice: 'A', probabilities: { A: .8, B: .1, insufficient_evidence: .1 }, confidence: .4, privateField: 'PROVIDER_FIELD_SECRET' } }, usage };
const success = { ok: true };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'magic8ball-transcripts-')); t.after(() => rm(root, { recursive: true, force: true }));
  const agent = join(root, 'agent'); await mkdir(agent);
  const saved = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => { saved === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = saved; });
  const tools = new Map(), commands = new Map(), hooks = new Map(), notices = [], rendered = [], requests = [];
  extension({ registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command), on: (name, hook) => { hooks.set(name, hook); return () => {}; } });
  let turn = 0;
  const ctx = { cwd: root, hasUI: true, mode: 'rpc', isProjectTrusted: () => false, waitForIdle: async () => {},
    ui: { notify: (text, level) => notices.push({ text, level }), custom: async factory => { let closed = false; const component = factory({ terminal: { rows: 8 }, requestRender() {} }, {}, {}, () => { closed = true; }); rendered.push(component.render(80).join('\n')); component.handleInput('\x1b'); assert.equal(closed, true); } },
    sessionManager: { buildSessionProjection: () => ({ messages: [{ role: 'user', content: 'CONVERSATION_VISIBLE' }] }) },
    modelRegistry: { find: () => ({ provider: 'test', id: 'builder', api: 'test' }), findOfType: () => ({ provider: 'test', id: 'classifier' }),
      streamSimple: (_model, context) => ({ result: async () => { requests.push(context); turn++;
        return { content: turn % 2 ? [{ type: 'thinking', thinking: 'HIDDEN_REASONING_SECRET', signature: 'SIGNATURE_SECRET' }, { type: 'text', text: 'BUILDER_VISIBLE' }, { type: 'toolCall', id: 'read', name: 'magic8ball_read', arguments: { path: 'README.md' } }] : [{ type: 'text', text: JSON.stringify(state) }], stopReason: turn % 2 ? 'toolUse' : 'stop', usage, headers: { Authorization: 'AUTH_HEADER_SECRET' } };
      } }), classify: async () => raw },
    executeTool: async () => ({ isError: false, result: { content: [{ type: 'text', text: JSON.stringify({ text: 'EVIDENCE_VISIBLE', truncated: false, range: { start: 0, end: 10, totalBytes: 10 } }) }], details: { secret: 'DETAILS_SECRET' } } }),
  };
  const command = args => commands.get('magic8ball').handler(args, ctx);
  const invoke = id => tools.get('magic8ball').execute(id, input, undefined, undefined, ctx);
  const show = async () => { notices.length = 0; await command('transcripts show'); return notices.map(n => n.text).join('\n'); };
  return { root, agent, tools, hooks, notices, ctx, command, invoke, show, rendered, requests };
}

test('AC-17 transcript toggle is user-only, ephemeral, independent of settings, and clear on off', async t => {
  const f = await fixture(t);
  assert.match(await f.show(), /off/i);
  await f.command('transcripts'); assert.match(f.notices.at(-1).text, /on/i);
  await f.command('transcripts on'); assert.match(f.notices.at(-1).text, /sensitive/i);
  for (const args of ['transcripts nope', 'transcripts on extra', 'transcripts --global', '--project transcripts on']) await f.command(args);
  assert.match(await f.show(), /no transcript/i);
  assert.deepEqual(await readdir(f.agent), []); assert.equal(f.requests.length, 0);
  assert.equal(Compile(f.tools.get('magic8ball').parameters).Check({ ...input, transcripts: true }), false);
  await f.command('transcripts off'); assert.match(await f.show(), /off/i);
  await f.command('transcripts'); assert.match(await f.show(), /no transcript/i);
  await f.command('transcripts'); assert.match(await f.show(), /off/i);
});

test('AC-17 captures visible logical transcripts without hidden fields or model-result additions', async t => {
  const f = await fixture(t);
  await writeFile(join(f.agent, 'magic8ball.json'), JSON.stringify(models));
  await f.command('transcripts on');
  const result = await f.invoke('captured'); assert.equal(result.isError, false);
  const text = await f.show();
  for (const marker of ['builder request', 'builder response', 'evidence result', 'classifier request', 'classifier response', 'REQUEST_VISIBLE', 'CONVERSATION_VISIBLE', 'BUILDER_VISIBLE', 'EVIDENCE_VISIBLE', 'e1']) assert.ok(text.includes(marker), marker);
  assert.match(text, /"model": "builder"/); assert.match(text, /"model": "classifier"/);
  assert.ok(text.indexOf('builder request') < text.indexOf('builder response'));
  assert.ok(text.indexOf('evidence result') < text.indexOf('classifier request'));
  assert.doesNotMatch(text, /HIDDEN_REASONING_SECRET|SIGNATURE_SECRET|AUTH_HEADER_SECRET|PROVIDER_ERROR_SECRET|PROVIDER_FIELD_SECRET|DETAILS_SECRET/);
  assert.doesNotMatch(JSON.stringify(result), /transcript|REQUEST_VISIBLE|CONVERSATION_VISIBLE|BUILDER_VISIBLE|EVIDENCE_VISIBLE/);
  assert.ok(Compile(f.tools.get('magic8ball').outputSchema).Check(result.structuredContent));
  await f.command('transcripts on'); assert.equal(await f.show(), text, 'on is idempotent');
  f.ctx.mode = 'tui'; await f.command('transcripts show'); assert.match(f.rendered.join('\n'), /Transcript/);
  f.ctx.mode = 'rpc';
  await f.command('transcripts off'); await f.invoke('not-captured'); assert.doesNotMatch(await f.show(), /EVIDENCE_VISIBLE/);
  assert.deepEqual(await readdir(f.agent), ['magic8ball.json']);
});

test('AC-17 transcript bounds, safe fields, late events, concurrency, and reset', () => {
  const store = new TranscriptStore(); assert.equal(store.begin('disabled'), undefined);
  store.setEnabled(true);
  const older = store.begin('older'); assert.ok(older, 'enabled capture must create a recorder');
  older.builderResponse({ content: [{ type: 'thinking', thinking: 'THINKING_SECRET', signature: 'SIGNATURE_SECRET' }, { type: 'text', text: 'OLDER_VISIBLE' }, { type: 'toolCall', id: 'x', name: 'magic8ball_read', arguments: { path: 'README.md', apiKey: 'AUTH_SECRET' } }], headers: { Authorization: 'AUTH_SECRET' } });
  assert.match(store.showText(), /OLDER_VISIBLE|README/); assert.doesNotMatch(store.showText(), /THINKING_SECRET|SIGNATURE_SECRET|AUTH_SECRET/);
  const superseded = store.latest; // Inspect retained objects, not only the displayed status.
  const newer = store.begin('newer'); assert.equal(superseded.text, ''); assert.equal(superseded.bytes, 0);
  newer.builderResponse({ content: [{ type: 'text', text: 'NEWER_VISIBLE' }] });
  older.builderResponse({ content: [{ type: 'text', text: 'LATE_OLD_VISIBLE' }] }); older.finish(success);
  assert.match(store.showText(), /NEWER_VISIBLE/); assert.doesNotMatch(store.showText(), /OLDER_VISIBLE|LATE_OLD_VISIBLE/);
  newer.finish(success); newer.builderResponse({ content: [{ type: 'text', text: 'AFTER_COMPLETION' }] }); assert.doesNotMatch(store.showText(), /AFTER_COMPLETION/);
  const pending = store.begin('pending'); pending.builderResponse({ content: [{ type: 'text', text: 'CLEAR_ME' }] });
  const revoked = store.latest; store.setEnabled(false); assert.equal(revoked.text, ''); assert.equal(revoked.bytes, 0);
  pending.builderResponse({ content: [{ type: 'text', text: 'AFTER_OFF' }] });
  store.setEnabled(true); assert.doesNotMatch(store.showText(), /AFTER_OFF/);
  const huge = store.begin('huge'); huge.builderResponse({ content: [{ type: 'text', text: '😀'.repeat(80000) }] }); huge.finish(success);
  assert.match(store.showText(), /truncated/i); assert.doesNotMatch(store.showText(), /�/); assert.ok(Buffer.byteLength(store.latest.text) <= 128000); assert.equal(store.latest.bytes, Buffer.byteLength(store.latest.text));
  store.reset(); assert.equal(store.isEnabled(), false); assert.doesNotMatch(store.showText(), /😀/);
});

test('AC-17 clearing in-flight capture and lifecycle reset cannot resurrect transcripts', async t => {
  const f = await fixture(t); await writeFile(join(f.agent, 'magic8ball.json'), JSON.stringify(models)); await f.command('transcripts on');
  let resolve, started;
  const ready = new Promise(r => { started = r; });
  const original = f.ctx.modelRegistry.streamSimple;
  f.ctx.modelRegistry.streamSimple = () => ({ result: () => { started(); return new Promise(r => { resolve = r; }); } });
  const pending = f.invoke('pending'); await ready; await f.command('transcripts off');
  resolve({ content: [{ type: 'text', text: JSON.stringify({ ...state, evidence: [] }) }], stopReason: 'stop', usage }); await pending;
  f.ctx.modelRegistry.streamSimple = original;
  await f.command('transcripts on'); assert.doesNotMatch(await f.show(), /REQUEST_VISIBLE/);
  await f.invoke('before-reset'); assert.match(await f.show(), /REQUEST_VISIBLE/);
  assert.equal(typeof f.hooks.get('session_start'), 'function'); f.hooks.get('session_start')({ reason: 'new' }, f.ctx); assert.match(await f.show(), /off/i);
  await f.command('transcripts on'); await f.invoke('before-shutdown'); f.hooks.get('session_shutdown')({ reason: 'reload' }, f.ctx); assert.match(await f.show(), /off/i);
});

test('AC-17 provider failures and malformed capture cannot expose raw errors', () => {
  const store = new TranscriptStore(); store.setEnabled(true); const trace = store.begin('failure');
  trace.builderResponse({ role: 'assistant', stopReason: 'error', errorMessage: 'ERROR_METADATA_SECRET', content: [{ type: 'text', text: 'RAW_PROVIDER_FAILURE_SECRET' }] });
  trace.builderResponse({ get content() { throw new Error('CAPTURE_ERROR_SECRET'); } });
  trace.classifierResponse({ ...raw, stopReason: 'error', content: 'RAW_CLASSIFIER_FAILURE_SECRET' });
  trace.finish({ ok: false, error: { stage: 'collection', code: 'builder-failed' } });
  assert.doesNotMatch(store.showText(), /ERROR_METADATA_SECRET|RAW_PROVIDER_FAILURE_SECRET|CAPTURE_ERROR_SECRET|RAW_CLASSIFIER_FAILURE_SECRET/);
  assert.match(store.showText(), /failed|could not be captured/);
});

test('AC-17 recorder closes after timeout even when the provider ignores cancellation', async () => {
  const store = new TranscriptStore(); store.setEnabled(true); const trace = store.begin('timeout');
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const result = await decide(input, { prepare: async () => models, build: async () => { const message = await pending; trace.builderResponse(message); return { text: JSON.stringify({ ...state, evidence: [] }), collection: { conversationTruncated: false, evidenceCalls: 0, sources: [], evidence: [] } }; }, classify: async () => assert.fail('classification after timeout') }, undefined, 10);
  assert.equal(result.error.kind, 'timeout'); trace.finish(result);
  resolve({ content: [{ type: 'text', text: 'LATE_AFTER_TIMEOUT_SECRET' }] });
  await new Promise(r => setImmediate(r)); assert.doesNotMatch(store.showText(), /LATE_AFTER_TIMEOUT_SECRET/);
});

test('AC-17 read-only transcript viewer scrolls, resizes, and closes within terminal bounds', () => {
  for (const cancel of ['\x1b', '\x03']) {
    const terminal = { rows: 6 }; let closed = false;
    const view = createTranscriptViewer(() => 'Transcript\n' + Array.from({ length: 50 }, (_, i) => `line-${String(i).padStart(2, '0')} 界😀`).join('\n'), terminal, () => { closed = true; });
    for (const rows of [1, 6, 24]) { terminal.rows = rows; for (const width of [1, 30, 80]) { const lines = view.render(width); assert.ok(lines.length <= Math.max(1, rows - 2)); assert.ok(lines.every(line => visibleWidth(line) <= width)); } }
    terminal.rows = 6;
    const before = view.render(80).join('\n'); for (let i = 0; i < 10; i++) view.handleInput('\x1b[B'); assert.notEqual(view.render(80).join('\n'), before);
    view.handleInput(cancel); assert.equal(closed, true);
  }
});

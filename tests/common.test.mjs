import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('CC-AC-1 declares the common behavior library without bundling host SDKs', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.dependencies?.['@neruok/pi-common'], 'the shared behavior library must be a declared dependency');
  for (const name of Object.keys(pkg.peerDependencies)) assert.equal(pkg.dependencies?.[name], undefined);
});

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../magic8ball.ts';
import { selectModel } from '../lib/model-picker.ts';
import { renderQuestion } from '../lib/render.ts';

test('CC-AC-2 RPC picker uses the common provider/model labels', async () => {
  const model = { provider: 'chat', id: 'full/model' };
  const ctx = { mode: 'rpc', ui: { select: async (_title, labels) => {
    assert.deepEqual(labels, ['chat/full/model']); return labels[0];
  } } };
  assert.deepEqual(await selectModel(ctx, 'Model', [model]), { provider: 'chat', model: 'full/model' });
});
test('CC-AC-5 no-UI command outcomes use visible messages without triggering a turn', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'magic-common-command-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => previous === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = previous);
  await writeFile(join(dir, 'magic8ball.json'), JSON.stringify({ builder: { provider: 'chat', model: 'small' }, classifier: { provider: 'choices', model: 'jev' } }));
  const commands = new Map(), messages = [], notices = [];
  extension({ on() {}, registerTool() {}, registerCommand: (n, c) => commands.set(n, c),
    sendMessage: (message, options) => messages.push({ message, options }) });
  const forbidden = () => assert.fail('command must not generate');
  const model = { provider: 'chat', id: 'small', api: 'mock', reasoning: false };
  const ctx = { cwd: dir, hasUI: false, mode: 'print', isProjectTrusted: () => false, waitForIdle: async () => {},
    modelRegistry: { find: (p, id) => p === model.provider && id === model.id ? model : undefined, streamSimple: forbidden, classify: forbidden },
    ui: { notify: (text, level) => notices.push({ text, level }), select: forbidden } };
  for (const args of ['show', 'reasoning', 'timeout', 'invalid', 'timeout 321', 'builder missing model']) {
    const count = messages.length;
    await commands.get('magic8ball').handler(args, ctx);
    assert.equal(messages.length, count + 1, args);
    const { message, options } = messages.at(-1);
    assert.equal(message.customType, 'magic8ball-settings');
    assert.equal(message.display, true);
    assert.equal(options.triggerTurn, false);
  }
  assert.deepEqual(notices, []);
});
test('CC-AC-5 renderer strips bidirectional and terminal controls without losing text lines', () => {
  const rows = renderQuestion('first\nsecond\u202e\x1btext', s => s).render(80);
  assert.ok(rows.some(row => row.includes('first')));
  assert.ok(rows.some(row => row.includes('second')));
  assert.doesNotMatch(rows.join('\n'), /[\u202a-\u202e\u2066-\u2069\x1b]/u);
});

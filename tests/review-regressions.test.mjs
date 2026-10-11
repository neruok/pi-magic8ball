import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evidence } from '../lib/evidence.ts';
import { conversationContext } from '../lib/builder.ts';
import { buildFixtureState as buildState } from './helpers/state.mjs';
import { LIMITS, emptyUsage, validateRequest } from '../lib/decision.ts';

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'magic8ball-review-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const input = { question: 'Which?', responses: { keep: 'Keep compatibility', change: 'Change behavior' } };
const state = { goal: 'Choose', constraints: [], current_state: [], evidence: [], uncertainties: [] };
const reply = (content, stopReason = 'stop') => ({ role: 'assistant', content, stopReason, usage: emptyUsage() });
const signal = () => new AbortController().signal;
const tools = [{ name: 'magic8ball_read', description: 'read', parameters: { type: 'object' } }];

for (const character of ['é', '€', '😀']) {
  test(`AC-26 ${Buffer.byteLength(character)}-byte UTF-8 splits resume at returned end for read and search`, async t => {
    const dir = await workspace(t);
    for (const byteLength of [8, LIMITS.evidenceBytes]) {
      for (let split = 1; split < Buffer.byteLength(character); split++) {
        const prefix = 'x'.repeat(byteLength - split);
        const content = prefix + character + 'tail';
        await writeFile(join(dir, 'text.txt'), content);
        for (const operation of ['read', 'search']) {
          const args = { path: 'text.txt', byteLength, ...(operation === 'search' ? { text: character } : {}) };
          const first = await evidence(dir, operation, args);
          assert.deepEqual(first.range, { start: 0, end: prefix.length, totalBytes: Buffer.byteLength(content) });
          assert.equal(first.truncated, true);
          assert.ok(Buffer.byteLength(first.text) <= LIMITS.evidenceBytes);
          const second = await evidence(dir, operation, { ...args, byteOffset: first.range.end });
          assert.equal(second.text, `1: ${character}tail`);
          assert.equal(second.range.end, Buffer.byteLength(content));
          assert.doesNotMatch(first.text + second.text, /�/);
        }
      }
    }
  });
}

test('AC-26 tiny windows exclude pending bytes and can be enlarged without skipping text', async t => {
  const dir = await workspace(t);
  for (const character of ['é', '€', '😀', '\uFEFF']) {
    await writeFile(join(dir, 'text.txt'), character + 'tail');
    for (let byteLength = 1; byteLength <= 3; byteLength++) {
      if (byteLength >= Buffer.byteLength(character)) continue;
      for (const operation of ['read', 'search']) {
        const args = { path: 'text.txt', byteLength, ...(operation === 'search' ? { text: 'tail' } : {}) };
        const partial = await evidence(dir, operation, args);
        assert.equal(partial.text, '');
        assert.deepEqual(partial.range, { start: 0, end: 0, totalBytes: Buffer.byteLength(character + 'tail') });
        assert.equal(partial.truncated, true);
        const enlarged = await evidence(dir, operation, { ...args, byteOffset: partial.range.end, byteLength: 8 });
        assert.equal(enlarged.text, `1: ${character === '\uFEFF' ? '' : character}tail`);
        assert.equal(enlarged.range.end, Buffer.byteLength(character + 'tail'));
      }
    }
  }
});

test('AC-26 preserved complete windows, BOM accounting, EOF and invalid-text gates', async t => {
  const dir = await workspace(t);
  for (const content of ['ASCII', 'é€😀', '\uFEFFhello']) {
    await writeFile(join(dir, 'text.txt'), content);
    const read = await evidence(dir, 'read', { path: 'text.txt', byteLength: Buffer.byteLength(content) });
    assert.equal(read.text, `1: ${content.replace(/^\uFEFF/, '')}`);
    assert.deepEqual(read.range, { start: 0, end: Buffer.byteLength(content), totalBytes: Buffer.byteLength(content) });
    assert.equal(read.truncated, false);
    const eof = await evidence(dir, 'read', { path: 'text.txt', byteOffset: 100 });
    assert.equal(eof.text, '');
    assert.equal(eof.range.start, eof.range.end);
  }
  await writeFile(join(dir, 'text.txt'), 'abc');
  for (const byteLength of [1, 2, 3]) {
    const read = await evidence(dir, 'read', { path: 'text.txt', byteLength });
    assert.equal(read.range.end, byteLength);
    assert.equal(read.text, `1: ${'abc'.slice(0, byteLength)}`);
  }
  const invalid = [
    [0x80], [0xc0], [0xff], [0xe0, 0x80], [0xed, 0xa0], [0xf0, 0x80], [0xf4, 0x90],
    [0x61, 0x80, 0x62], [0x61, 0, 0x62],
  ];
  for (const bytes of invalid) {
    await writeFile(join(dir, 'text.txt'), Buffer.from([...bytes, 0x61, 0x62, 0x63]));
    for (const operation of ['read', 'search']) {
      await assert.rejects(evidence(dir, operation, { path: 'text.txt', byteLength: bytes.length, ...(operation === 'search' ? { text: 'a' } : {}) }),
        error => error.kind === 'evidence-failed' && error.evidenceCode === 'invalid-text');
    }
  }
  for (const character of ['é', '€', '😀']) {
    const bytes = Buffer.from(character);
    for (let split = 1; split < bytes.length; split++) {
      await writeFile(join(dir, 'text.txt'), bytes.subarray(0, split));
      await assert.rejects(evidence(dir, 'read', { path: 'text.txt' }), error => error.evidenceCode === 'invalid-text');
      await writeFile(join(dir, 'text.txt'), bytes);
      await assert.rejects(evidence(dir, 'read', { path: 'text.txt', byteOffset: split }), error => error.evidenceCode === 'invalid-text');
    }
  }
});

test('AC-26 builder describes safe continuation and accepts adjusted and empty ranges', async () => {
  let requests = 0;
  const ranges = [{ start: 0, end: 0, totalBytes: 8 }, { start: 0, end: 4, totalBytes: 8 }];
  const built = await buildState(validateRequest(input), { tools, conversation: [], complete: async context => {
    assert.match(context.systemPrompt, /resume at range\.end/i);
    assert.match(context.systemPrompt, /empty window.*at least four bytes/i);
    if (++requests === 1) return reply(ranges.map((_, i) => ({ type: 'toolCall', id: String(i), name: 'magic8ball_read', arguments: { path: 'text.txt', byteLength: i ? 4 : 1 } })), 'toolUse');
    const results = context.messages.filter(message => message.role === 'toolResult').map(message => JSON.parse(message.content[0].text));
    assert.deepEqual(results.map(result => result.range), ranges);
    return reply([{ type: 'text', text: JSON.stringify(state) }]);
  }, executeTool: async (_name, args) => ({ content: [{ type: 'text', text: JSON.stringify({ text: args.byteLength === 1 ? '' : '1: 😀', truncated: true, range: ranges[args.byteLength === 1 ? 0 : 1] }) }] }) }, signal(), () => {});
  assert.deepEqual(built.collection.evidence.map(source => source.range), ranges);
});

const mixed = { role: 'assistant', content: [
  { type: 'text', text: 'The main constraint is backward compatibility.' },
  { type: 'toolCall', id: 'old', name: 'magic8ball', arguments: { question: 'ARGUMENT_MARKER' } },
  { type: 'thinking', thinking: 'THINKING_MARKER' },
  { type: 'text', text: 'Keep the existing public interface.' },
] };

test('AC-27 ordinary text survives a magic8ball call in the same assistant message', () => {
  const context = conversationContext([mixed]);
  assert.equal(context.text, 'assistant: The main constraint is backward compatibility.\nKeep the existing public interface.');
  assert.equal(context.truncated, false);
});

test('AC-27 mixed assistant prose reaches the first builder request', async () => {
  await buildState(validateRequest({ ...input, context: { workspace: false } }), { tools, conversation: [mixed], complete: async context => {
    const data = JSON.parse(context.messages[0].content);
    assert.match(data.conversation_context, /backward compatibility/);
    assert.doesNotMatch(data.conversation_context, /ARGUMENT_MARKER|THINKING_MARKER/);
    assert.equal(data.conversation_source_id, 'conversation');
    return reply([{ type: 'text', text: JSON.stringify(state) }]);
  }, executeTool: async () => assert.fail('workspace disabled') }, signal(), () => {});
});

test('AC-27 preserved block/result exclusions, UTF-8 bounds and disabled conversation', async () => {
  const messages = [
    { role: 'system', content: 'SYSTEM_MARKER' },
    { role: 'user', content: [{ type: 'text', text: 'User fact' }, { type: 'image', data: 'IMAGE_MARKER' }] },
    { role: 'assistant', content: [{ type: 'toolCall', name: 'magic8ball', arguments: { marker: 'ARGUMENT_MARKER' } }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Assistant fact' }, { type: 'thinking', thinking: 'THINKING_MARKER' }] },
    ...['magic8ball', 'magic8ball_read', 'magic8ball_list', 'magic8ball_search'].map(toolName => ({ role: 'toolResult', toolName, content: 'RESULT_MARKER' })),
    { role: 'toolResult', toolName: 'read', content: 'Other tool fact' },
  ];
  assert.equal(conversationContext(messages).text, 'user: User fact\n\nassistant: Assistant fact\n\ntoolResult: Other tool fact');
  const bounded = conversationContext([{ role: 'user', content: '😀'.repeat(7000) }]);
  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(bounded.text) <= LIMITS.conversationBytes);
  assert.doesNotMatch(bounded.text, /�/);
  await buildState(validateRequest({ ...input, context: { conversation: false } }), { tools, conversation: [...messages, mixed], complete: async context => {
    const data = JSON.parse(context.messages[0].content);
    assert.equal(data.conversation_context, '');
    assert.equal(data.conversation_source_id, null);
    return reply([{ type: 'text', text: JSON.stringify(state) }]);
  }, executeTool: async () => assert.fail('no tool calls expected') }, signal(), () => {});
});

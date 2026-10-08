import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compile } from 'typebox/compile';
import extension from '../magic8ball.ts';
import { decide } from '../lib/decision.ts';

const state = { goal: 'Inspect the declared verification script.', constraints: [], current_state: ['verify runs typecheck and check'], evidence: [], uncertainties: [] };
const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: .001 } };
const models = { builder: { provider: 'offline', model: 'offline' }, classifier: { provider: 'openrouter', model: 'cloudflare/clef-flash' } };
const live = { type: 'choice', choice: 'npm_verify', confidence: .9755, probabilities: { npm_verify: .9816, npm_check: .0063, npm_benchmark: .0081, insufficient_evidence: .0039 } };
const raw = answer => ({ stopReason: 'stop', answers: { decision: answer }, usage });
async function check(answer) {
  return decide({ question: 'Which?', responses: Object.fromEntries(Object.keys(answer.probabilities).map(k => [k, `Choice ${k}`])), abstain: false, context: { conversation: false, workspace: false } }, {
    prepare: async () => models,
    build: async (_r, _s, record) => { record(usage); return { text: JSON.stringify(state), collection: { conversationTruncated: false, evidenceCalls: 0, sources: [], evidence: [] } }; },
    classify: async () => raw(answer)
  });
}
function rounded(n, drift) {
  const base = Math.floor(10000 / n);
  const units = Array.from({ length: n }, (_, i) => i === n - 1 ? 10000 - base * (n - 1) + drift : base);
  const probabilities = Object.fromEntries(units.map((u, i) => [`r${i}`, u / 10000]));
  const choice = Object.keys(probabilities).reduce((a, b) => probabilities[a] >= probabilities[b] ? a : b);
  return { type: 'choice', choice, confidence: .42, probabilities };
}

// Keep the registered input/output schemas, fresh settings, and usage boundary in the regression.
test('AC-24 accepts the live Clef rounded reply through the registered tool without changing values or usage', async t => {
  const root = await mkdtemp(join(tmpdir(), 'magic8ball-rounding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; });
  await writeFile(join(root, 'magic8ball.json'), JSON.stringify(models));
  const tools = new Map();
  extension({ on() {}, registerTool: tool => tools.set(tool.name, tool), registerCommand() {} });
  let builders = 0, classifiers = 0;
  const before = structuredClone(live);
  const ctx = { cwd: root, isProjectTrusted: () => false, modelRegistry: {
    find: () => ({ provider: 'offline', id: 'offline', api: 'openai-responses', reasoning: false }),
    findOfType: () => ({ provider: 'openrouter', id: 'cloudflare/clef-flash' }),
    streamSimple: (_m, _c, options) => { builders++; assert.equal(options.maxRetries, 0); return { result: async () => ({ role: 'assistant', content: [{ type: 'text', text: JSON.stringify(state) }], stopReason: 'stop', usage }) }; },
    classify: async (_m, context, options) => { classifiers++; assert.equal(options.maxRetries, 0); assert.deepEqual(Object.keys(context.questions.decision.criteria), Object.keys(live.probabilities)); return raw(live); }
  } };
  const main = tools.get('magic8ball');
  const result = await main.execute('rounding', { question: 'Which script verifies?', responses: { npm_verify: 'Combined check', npm_check: 'Tests only', npm_benchmark: 'Benchmark only' }, context: { conversation: false, workspace: false } }, undefined, undefined, ctx);
  assert.equal(result.details.ok, true);
  assert.equal(result.isError, false);
  assert.equal(Compile(main.outputSchema).Check(result.details), true);
  assert.deepEqual(result.details.probabilities, live.probabilities);
  assert.equal(result.details.answer, live.choice);
  assert.equal(result.details.confidence, live.confidence);
  assert.equal(result.details.usageComplete, true);
  assert.equal(result.details.usage.input, 20);
  assert.equal(result.details.usage.cost.total, .002);
  assert.deepEqual(live, before);
  assert.equal(builders, 1); assert.equal(classifiers, 1);
});

test('AC-24 accepts inclusive four-decimal drift bounds for both signs and 2/3/4/26 choices', async () => {
  for (const n of [2, 3, 4, 26]) for (const sign of [-1, 1]) {
    const answer = rounded(n, sign * Math.floor(n / 2));
    const result = await check(answer);
    assert.equal(result.ok, true, `n=${n}, sign=${sign}`);
    assert.deepEqual(result.probabilities, answer.probabilities);
    assert.equal(result.answer, answer.choice);
    assert.equal(result.confidence, answer.confidence);
  }
});

test('AC-24 preserves the backend winner among tied maxima on the rounding path', async () => {
  const answer = { type: 'choice', choice: 'b', confidence: .7, probabilities: { a: .4999, b: .4999, c: .0001 } };
  const result = await check(answer);
  assert.equal(result.ok, true);
  assert.equal(result.answer, 'b');
  assert.deepEqual(result.probabilities, answer.probabilities);
});

test('AC-24 accepts all 10001 four-decimal grid values on the bounded rounding path', async () => {
  for (let k = 0; k <= 10000; k++) {
    const p = k / 10000;
    assert.equal(Math.round(p * 10000), k);
    const probabilities = k === 10000 ? { a: p, b: 0, c: .0001 } : { a: p, b: (9999 - k) / 10000, c: 0 };
    const choice = probabilities.a >= probabilities.b ? 'a' : 'b';
    const result = await check({ type: 'choice', choice, confidence: .5, probabilities });
    assert.equal(result.ok, true, `grid unit ${k}`);
    assert.deepEqual(result.probabilities, probabilities);
  }
});

test('AC-4 AC-24 preserved one unit beyond the rounding bound fails for both signs and all count boundaries', async () => {
  for (const n of [2, 3, 4, 26]) for (const sign of [-1, 1]) {
    const result = await check(rounded(n, sign * (Math.floor(n / 2) + 1)));
    assert.equal(result.ok, false); assert.equal(result.error.kind, 'invalid-answer');
  }
});

test('AC-4 AC-24 preserved finer-precision sums keep the original tolerance and do not round to qualify', async () => {
  const good = { type: 'choice', choice: 'a', confidence: .4, probabilities: { a: .50000023, b: .49999926 } };
  const result = await check(good);
  assert.equal(result.ok, true); assert.deepEqual(result.probabilities, good.probabilities);
  for (const a of [.49990001, .4999 + Number.EPSILON]) {
    const rejected = await check({ ...good, probabilities: { a, b: .4999, c: .0001 } });
    assert.equal(rejected.error.kind, 'invalid-answer');
  }
});

test('AC-4 AC-24 preserved ranges, keys, confidence, nonfinite values, and maximality are enforced on rounded replies', async () => {
  const answer = rounded(4, -1);
  for (const invalid of [
    { ...answer, choice: 'unknown' },
    { ...answer, choice: 'r3' },
    { ...answer, confidence: NaN }, { ...answer, confidence: 1.0001 },
    { ...answer, probabilities: { ...answer.probabilities, r0: -.0001 } },
    { ...answer, probabilities: { ...answer.probabilities, r0: 1.0001 } },
    { ...answer, probabilities: { ...answer.probabilities, r0: Infinity } }
  ]) {
    const result = await check(invalid);
    assert.equal(result.ok, false); assert.equal(result.error.kind, 'invalid-answer');
  }
  for (const probabilities of [{ r0: .25, r1: .25, r2: .25 }, { ...answer.probabilities, extra: 0 }]) {
    const result = await decide({ question: 'Which?', responses: { r0: 'A', r1: 'B', r2: 'C', r3: 'D' }, abstain: false }, {
      prepare: async () => models,
      build: async () => ({ text: JSON.stringify(state), collection: { conversationTruncated: false, evidenceCalls: 0, sources: [], evidence: [] } }),
      classify: async () => raw({ ...answer, probabilities })
    });
    assert.equal(result.error.kind, 'invalid-answer');
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { visibleWidth } from '@earendil-works/pi-tui';
import { Compile } from 'typebox/compile';
import extension from '../magic8ball.ts';
import { buildFixtureState as buildState, stateCompletion, stateStream } from './helpers/state.mjs';
import { validateRequest, decide, emptyUsage, parseState } from '../lib/decision.ts';
import { evidence } from '../lib/evidence.ts';
import { benchmarkPlan, runBenchmark } from '../lib/benchmark.ts';

const input = { question: 'Which?', responses: { A: 'Keep it', B: 'Change it' } };
const state = { goal: 'Choose', constraints: [], current_state: [], evidence: [], uncertainties: [] };
const usage = { ...emptyUsage(), input: 1, totalTokens: 1 };
const models = { builder: { provider: 'test', model: 'builder' }, classifier: { provider: 'test', model: 'classifier' } };
const tools = [{ name: 'magic8ball_read', description: 'read', parameters: { type: 'object' } }];
const message = (content, stopReason = 'stop') => ({ role: 'assistant', content, stopReason, usage });
const toolCall = id => ({ type: 'toolCall', id, name: 'magic8ball_read', arguments: { path: 'README.md' } });
const result = { text: '1: observed', truncated: true, range: { start: 16000, end: 16008, totalBytes: 20000 } };
const toolResult = () => ({ content: [{ type: 'text', text: JSON.stringify(result) }], details: result });
const answer = () => ({ stopReason: 'stop', usage, answers: { decision: { type: 'choice', choice: 'A', probabilities: { A: .8, B: .1, insufficient_evidence: .1 }, confidence: .4 } } });
const noCollection = { conversationTruncated: false, evidenceCalls: 0, sources: [], evidence: [] };
const deps = (overrides = {}) => ({ prepare: async () => models, build: async () => ({ text: JSON.stringify(state), collection: noCollection }), classify: async () => answer(), ...overrides });
const registrations = () => { const registered = new Map(); extension({ on() {}, registerTool: t => registered.set(t.name, t), registerCommand() {} }); return registered; };

test('AC-33 no count-based finalization for sequential or batched exploration', async () => {
  for (const many of [false, true]) {
    let requests = 0, calls = 0;
    const built = await buildState(validateRequest(input), { tools, conversation: [], complete: async context => {
      requests++;
      assert.equal(context.tools.length, 6);
      assert.doesNotMatch(context.systemPrompt, /requestsRemaining|finalize/);
      if (requests === (many ? 2 : 10)) return message([{ type: 'text', text: JSON.stringify(state) }]);
      return message(many ? Array.from({ length: 10 }, (_, i) => toolCall(String(i))) : [toolCall(String(requests))], 'toolUse');
    }, executeTool: async () => { calls++; return toolResult(); } }, new AbortController().signal, () => {});
    assert.deepEqual(JSON.parse(built.text), state);
    assert.equal(calls, many ? 10 : 9);
  }
});

test('AC-12 file hints remain data and invalid hints fail before models', async () => {
  const request = validateRequest({ ...input, context: { files: ['src/example.ts'] } });
  assert.deepEqual(request.context.files, ['src/example.ts']);
  let calls = 0;
  await buildState(request, { tools, conversation: [], complete: async context => {
    assert.deepEqual(JSON.parse(context.messages[0].content).file_hints, ['src/example.ts']);
    return message([{ type: 'text', text: JSON.stringify(state) }]);
  }, executeTool: async () => { calls++; return toolResult(); } }, new AbortController().signal, () => {});
  assert.equal(calls, 0);
  for (const context of [{ files: null }, { files: 'README.md' }, { files: ['../outside'] }, { files: ['.env'] }, { files: ['auth.json'] }, { files: ['node_modules/a'] }, { files: ['a', 'a'] }, { files: Array.from({ length: 9 }, (_, i) => `f${i}`) }, { files: ['a'], workspace: false }]) {
    const invalid = await decide({ ...input, context }, deps({ prepare: async () => { calls++; return models; } }));
    assert.equal(invalid.error.kind, 'invalid-input');
  }
  assert.equal(calls, 0);
});

test('AC-12 range reads and searches reach beyond the prefix and retain restrictions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'magic8ball-range-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = 'x'.repeat(16000) + 'needle\nnext\n';
  await writeFile(join(dir, 'large.txt'), file);
  const range = { path: 'large.txt', byteOffset: 16000, byteLength: 12 };
  const read = await evidence(dir, 'read', range);
  assert.equal(read.text, '1: needle\n2: next\n3: ');
  assert.deepEqual(read.range, { start: 16000, end: 16012, totalBytes: 16012 });
  assert.equal(read.truncated, true, 'uninspected prefix remains explicit');
  assert.match((await evidence(dir, 'search', { ...range, text: 'needle' })).text, /1: needle/);
  const eof = await evidence(dir, 'read', { ...range, byteOffset: 20000 });
  assert.equal(eof.text, ''); assert.equal(eof.range.start, 16012); assert.equal(eof.range.end, 16012);
  for (const extra of [{ byteOffset: -1 }, { byteOffset: null }, { byteOffset: Number.MAX_SAFE_INTEGER + 1 }, { byteLength: 0 }, { byteLength: null }, { byteLength: 16001 }, { path: '.env' }]) await assert.rejects(evidence(dir, 'read', { ...range, ...extra }));
  await writeFile(join(dir, 'utf8.txt'), '😀tail');
  await assert.rejects(evidence(dir, 'read', { path: 'utf8.txt', byteOffset: 1 }));
  const partial = await evidence(dir, 'read', { path: 'utf8.txt', byteLength: 3 });
  assert.doesNotMatch(partial.text, /�/); assert.equal(partial.truncated, true);
});

test('AC-13 collector IDs and source metadata reject invented or disabled citations', async () => {
  const cited = { ...state, evidence: [{ fact: 'Observed', source: 'e1' }, { fact: 'Discussed', source: 'conversation' }] };
  let requests = 0;
  const built = await buildState(validateRequest(input), { tools, conversation: [{ role: 'user', content: 'x'.repeat(25000) }], complete: async context => {
    if (++requests === 1) return message([toolCall('read')], 'toolUse');
    assert.match(JSON.stringify(context.messages), /"id"|\\"id\\"/);
    return message([{ type: 'text', text: JSON.stringify(cited) }]);
  }, executeTool: async () => toolResult() }, new AbortController().signal, () => {});
  assert.deepEqual(built.collection.evidence.map(e => e.id), ['conversation', 'e1']);
  assert.equal(built.collection.evidence[0].truncated, true);
  assert.deepEqual(built.collection.evidence[1].range, result.range);
  assert.equal(built.collection.evidence[1].truncated, true);
  const valid = await decide(input, deps({ build: async () => built })); assert.equal(valid.ok, true);
  for (const source of ['e99', 'README.md', 'conversation']) {
    let classifications = 0;
    const bad = await decide(input, deps({ build: async () => ({ text: JSON.stringify({ ...state, evidence: [{ fact: 'Claim', source }] }), collection: { ...noCollection } }), classify: async () => { classifications++; return answer(); } }));
    assert.equal(bad.error.kind, 'invalid-state'); assert.equal(classifications, 0);
  }
  assert.throws(() => parseState(JSON.stringify(cited), []), e => e.kind === 'invalid-state');
});

test('AC-14 benchmark compares configurations and orders without implicit spend', async () => {
  const plan = benchmarkPlan(['small', 'other']);
  assert.equal(plan.length, 24);
  assert.deepEqual(new Set(plan.map(p => p.caseId)), new Set(['missing', 'conflicting', 'injected', 'decisive']));
  let builders = 0, classifiers = 0;
  const configs = ['small', 'other'].map(name => ({ name, models, complete: stateCompletion(async context => {
    builders++;
    const data = JSON.parse(context.messages[0].content);
    return message([{ type: 'text', text: JSON.stringify({ ...state, current_state: [data.conversation_context], uncertainties: ['missing', 'conflict'] }) }]);
  }) }));
  const classify = async request => {
    classifiers++;
    const choice = /^\((missing|conflicting)\)/.test(request.question) ? 'insufficient_evidence' : 'A';
    return { stopReason: 'stop', usage, answers: { decision: { type: 'choice', choice, probabilities: Object.fromEntries(Object.keys(request.responses).map(k => [k, k === choice ? 1 : 0])), confidence: .9 } } };
  };
  const dry = await runBenchmark(configs, classify, { dryRun: true });
  assert.equal(dry.plan.length, 24); assert.equal(builders + classifiers, 0);
  await assert.rejects(runBenchmark(configs, classify, {}), /allowSpend/); assert.equal(builders + classifiers, 0);
  const report = await runBenchmark(configs, classify, { allowSpend: true });
  assert.equal(report.rows.length, 24); assert.equal(classifiers, 24); assert.equal(builders, 16);
  assert.equal(report.summary.accuracy, 1); assert.equal(report.summary.orderSensitivity, 0);
  assert.equal(report.summary.abstentionRate, .5); assert.equal(report.summary.invalidOutputs, 0);
  assert.ok(report.summary.factCoverage > 0); assert.ok(report.summary.uncertaintyCoverage > 0);
  assert.equal(report.summary.usage.input, 40);
  assert.deepEqual(Object.keys(report.byConfiguration), ['small', 'other', 'direct']);
  assert.equal(report.byConfiguration.direct.usage.input, 8);
  assert.equal(report.rows[0].models.builder.model, 'builder');
  assert.equal(report.rows.find(row => row.mode === 'direct').models.builder, undefined);
  const failed = await runBenchmark(configs, async () => { throw new Error('PRIVATE_PROVIDER_ERROR'); }, { allowSpend: true });
  assert.equal(failed.summary.invalidOutputs, 24); assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_PROVIDER_ERROR|conversation_context/);
  await assert.rejects(runBenchmark([{ ...configs[0], models: { ...models, classifier: { provider: 'other', model: 'other' } } }, configs[1]], classify, { allowSpend: true }), /same classifier/);
  const root = await mkdtemp(join(tmpdir(), 'magic8ball-benchmark-cli-'));
  try {
    const marker = join(root, 'imported');
    const adapter = join(root, 'adapter.mjs');
    await writeFile(adapter, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'imported'); throw new Error('PRIVATE_PROVIDER_ERROR');`);
    const command = new URL('../scripts/benchmark.mjs', import.meta.url).pathname;
    const dry = spawnSync(process.execPath, [command, '--dry-run', '--adapter', adapter, '--config', 'small'], { encoding: 'utf8' });
    assert.equal(dry.status, 0); assert.equal(JSON.parse(dry.stdout).maxModelCalls, null);
    await assert.rejects(readFile(marker), e => e.code === 'ENOENT');
    const denied = spawnSync(process.execPath, [command, '--adapter', adapter], { encoding: 'utf8' });
    assert.equal(denied.status, 1); await assert.rejects(readFile(marker), e => e.code === 'ENOENT');
    const authorizedMock = spawnSync(process.execPath, [command, '--allow-spend', '--adapter', adapter], { encoding: 'utf8' });
    assert.equal(authorizedMock.status, 1); assert.equal(await readFile(marker, 'utf8'), 'imported');
    assert.doesNotMatch(authorizedMock.stderr + authorizedMock.stdout, /PRIVATE_PROVIDER_ERROR/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('AC-15 progress, stage diagnostics and compact/expanded rendering are safe', async () => {
  const registered = registrations(), main = registered.get('magic8ball');
  assert.equal(typeof main.renderResult, 'function');
  assert.equal(typeof main.renderCall, 'function');
  const theme = { fg: (_c, text) => text, bold: text => text };
  const ok = await decide(input, deps());
  const cited = { ...ok, state: { ...state, evidence: [{ fact: 'Unicode 界😀 evidence', source: 'e1' }], uncertainties: ['Unclear'] }, collection: { ...noCollection, evidence: [{ id: 'e1', scope: 'workspace', source: 'read:README.md', truncated: true }] } };
  for (const width of [1, 8, 30, 80]) {
    const compact = main.renderResult({ details: cited, content: [] }, { expanded: false, isPartial: false }, theme, {}).render(width);
    assert.ok(compact.every(line => visibleWidth(line) <= width));
    if (width === 80) { assert.match(compact.join('\n'), /A.*80/); assert.match(compact.join('\n'), /cost/i); assert.doesNotMatch(compact.join('\n'), /Unicode/); }
    const expanded = main.renderResult({ details: cited, content: [] }, { expanded: true, isPartial: false }, theme, {}).render(width);
    assert.ok(expanded.every(line => visibleWidth(line) <= width));
    if (width === 80) assert.match(expanded.join('\n'), /Unicode|truncated|Unclear/);
  }
  const failed = await decide(input, deps({ classify: async () => { throw new Error('PRIVATE_PROVIDER_ERROR'); } }));
  assert.equal(failed.error.stage, 'classification'); assert.equal(failed.error.code, 'classifier-failed');
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_PROVIDER_ERROR/);
  for (const details of [failed, { stage: 'collection' }, undefined, { ...cited, abstained: true, answer: 'insufficient_evidence' }]) {
    const lines = main.renderResult({ details, content: [{ type: 'text', text: 'argument error' }] }, { expanded: false, isPartial: details?.stage === 'collection' }, theme, {}).render(80);
    assert.ok(lines.length > 0);
  }
  assert.ok(Compile(main.outputSchema).Check(ok)); assert.ok(Compile(main.outputSchema).Check(failed));
  const root = await mkdtemp(join(tmpdir(), 'magic8ball-progress-'));
  const saved = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    await writeFile(join(root, 'magic8ball.json'), JSON.stringify(models));
    const ctx = { cwd: root, isProjectTrusted: () => false, sessionManager: { buildSessionProjection: () => ({ messages: [] }) }, modelRegistry: { find: () => ({ api: 'test' }), findOfType: () => ({}), streamSimple: stateStream(() => ({ result: async () => message([{ type: 'text', text: JSON.stringify(state) }]) })), classify: async () => answer() } };
    const updates = [];
    const done = await main.execute('main', input, undefined, update => updates.push(update), ctx);
    assert.equal(done.isError, false);
    assert.deepEqual(updates.map(u => u.details.stage), ['preparation', 'collection', 'validation', 'classification']);
    assert.ok(updates.every(u => !JSON.stringify(u).includes('Which?')));
    assert.equal((await main.execute('main', input, undefined, undefined, ctx)).isError, false);
  } finally { saved === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = saved; await rm(root, { recursive: true, force: true }); }
});

test('AC-16 development dependencies and CI support clean-checkout verification', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.devDependencies, 'development dependencies must be declared');
  for (const name of ['typescript', '@types/node', '@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', '@earendil-works/pi-tui', 'typebox']) assert.match(pkg.devDependencies[name], /^\d+\.\d+\.\d+$/);
  for (const name of Object.keys(pkg.peerDependencies)) { assert.equal(pkg.peerDependencies[name], '*'); assert.equal(pkg.dependencies?.[name], undefined); }
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8')); assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
  const ci = await readFile(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8');
  assert.match(ci, /npm ci --ignore-scripts/); assert.match(ci, /npm run verify/); assert.match(ci, /node-version:.*24/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExtensionSelectorComponent, initTheme } from '@earendil-works/pi-coding-agent';
import { fuzzyFilter, visibleWidth } from '@earendil-works/pi-tui';
import extension from '../magic8ball.ts';
import { settingsPaths, loadSettings, saveSettingsPatch } from '../lib/settings.ts';

const models = { builder: { provider: 'cheap', model: 'small' }, classifier: { provider: 'typesafe', model: 'jev-latest' } };
const clef = { provider: 'cloudflare-workers-ai', model: '@cf/cloudflare/clef' };
const state = { goal: 'Choose', constraints: [], current_state: [], evidence: [], uncertainties: [] };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const request = { question: 'Which?', responses: { a: 'A', b: 'B' }, context: { workspace: false, conversation: false } };
const envNames = ['PI_CODING_AGENT_DIR', 'PI_MAGIC8BALL_BUILDER_PROVIDER', 'PI_MAGIC8BALL_BUILDER_MODEL', 'PI_MAGIC8BALL_CLASSIFIER_PROVIDER', 'PI_MAGIC8BALL_CLASSIFIER_MODEL'];
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'magic8ball-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace'), agentDir = join(root, 'agent');
  await mkdir(join(cwd, '.pi'), { recursive: true }); await mkdir(agentDir);
  const saved = Object.fromEntries(envNames.map(n => [n, process.env[n]]));
  t.after(() => { for (const n of envNames) saved[n] === undefined ? delete process.env[n] : process.env[n] = saved[n]; });
  for (const n of envNames) delete process.env[n]; process.env.PI_CODING_AGENT_DIR = agentDir;
  const tools = new Map(), commands = new Map();
  extension({ registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command), setModel: () => assert.fail('Active model changed') });
  const calls = [], notices = [], selects = [];
  const chat = [models.builder, { provider: 'other', model: 'tiny' }].map(({ provider, model }) => ({ provider, id: model, api: 'test' }));
  const classifiers = [models.classifier, clef].map(({ provider, model }) => ({ provider, id: model }));
  const ctx = { cwd, hasUI: true, mode: 'tui', isProjectTrusted: () => true,
    waitForIdle: async () => {},
    modelRegistry: {
      find: (p, m) => chat.find(x => x.provider === p && x.id === m),
      findOfType: (type, p, m) => type === 'classifier' ? classifiers.find(x => x.provider === p && x.id === m) : undefined,
      getAvailable: () => [...chat, { provider: 'pi-virtual', id: 'router', api: 'pi-virtual' }],
      getAvailableOfType: async type => { assert.equal(type, 'classifier'); return classifiers; },
      streamSimple: (model) => { calls.push(['builder', model.provider, model.id]); return { result: async () => ({ content: [{ type: 'text', text: JSON.stringify(state) }], stopReason: 'stop', usage }) }; },
      classify: async model => { calls.push(['classifier', model.provider, model.id]); return { stopReason: 'stop', usage, answers: { decision: { type: 'choice', choice: 'a', probabilities: { a: .8, b: .1, insufficient_evidence: .1 }, confidence: .4 } } }; }
    },
    ui: { notify: (text, level) => notices.push({ text, level }), select: async (title, options) => { selects.push({ title, options }); return options[0]; } }
  };
  const paths = settingsPaths(cwd, agentDir);
  const invoke = args => { const command = commands.get('magic8ball'); assert.ok(command, 'The /magic8ball command must be registered'); return command.handler(args, ctx); };
  const decide = () => tools.get('magic8ball').execute('test', request, undefined, undefined, ctx);
  const write = (scope, value) => writeFile(paths[scope], JSON.stringify(value));
  return { root, cwd, agentDir, paths, tools, commands, calls, notices, selects, ctx, invoke, decide, write };
}
const errorKind = kind => error => error?.kind === kind;
const absent = path => assert.rejects(readFile(path), error => error.code === 'ENOENT');

// Exercise the actual component chosen by the command, including the old host dialog.
function terminalPicker(f, exercise) {
  initTheme('dark', false);
  const terminal = { rows: 24 };
  const tui = { terminal, requestRender() {} };
  const theme = { fg: (_color, text) => text, bold: text => text };
  let prompts = 0, failure;
  const run = (...args) => { try { exercise(...args); } catch (error) { failure ??= error; } };
  f.ctx.ui.custom = async (factory, options) => {
    let result, finished = false;
    const component = await factory(tui, theme, {}, value => { result = value; finished = true; });
    run(component, terminal, ++prompts, options, () => finished);
    if (!failure) assert.equal(finished, true, 'picker must complete');
    return result;
  };
  f.ctx.ui.select = async (title, options) => {
    let result;
    const component = new ExtensionSelectorComponent(title, options, value => { result = value; }, () => {});
    run(component, terminal, ++prompts);
    return result;
  };
  return () => { if (failure) throw failure; };
}
function manyModels(f, unicode = false) {
  const entries = Array.from({ length: 100 }, (_, i) => ({ provider: 'catalog', id: `model-${String(i).padStart(3, '0')}${unicode ? '-界😀'.repeat(25) : ''}`, api: 'test' }));
  f.ctx.modelRegistry.getAvailable = () => [...entries, { provider: 'pi-virtual', id: 'router', api: 'pi-virtual' }];
  f.ctx.modelRegistry.getAvailableOfType = async () => entries;
  f.ctx.modelRegistry.find = (p, id) => entries.find(x => x.provider === p && x.id === id);
  f.ctx.modelRegistry.findOfType = (_type, p, id) => entries.find(x => x.provider === p && x.id === id);
  return entries;
}
function fits(component, terminal, width, selected) {
  const lines = component.render(width);
  const budget = Math.max(1, terminal.rows - 2);
  assert.ok(lines.length <= budget, `picker renders ${lines.length} lines for ${terminal.rows} terminal rows`);
  assert.ok(lines.every(line => visibleWidth(line) <= width), 'each line must fit the terminal width');
  assert.ok(lines.some(line => line.includes('→') && line.includes(selected)), `selected ${selected} must remain visible`);
}

test('AC-9 TUI picker bounds navigation and resize for both model catalogs', async t => {
  const f = await fixture(t); manyModels(f);
  const verify = terminalPicker(f, (component, terminal) => {
    for (const rows of [40, 24, 10, 6, 3, 1]) {
      terminal.rows = rows;
      for (const width of [30, 80]) fits(component, terminal, width, 'model-000');
    }
    terminal.rows = 10;
    for (let i = 1; i < 100; i++) {
      component.handleInput('\x1b[B'); fits(component, terminal, 30, `model-${String(i).padStart(3, '0')}`);
    }
    terminal.rows = 6; fits(component, terminal, 80, 'model-099');
    terminal.rows = 40; fits(component, terminal, 80, 'model-099');
    component.handleInput('\r');
  });
  await f.invoke(''); verify();
  assert.deepEqual(JSON.parse(await readFile(f.paths.global)), { builder: { provider: 'catalog', model: 'model-099' }, classifier: { provider: 'catalog', model: 'model-099' } });
  assert.deepEqual(f.calls, []);
});

test('AC-9 TUI long Unicode labels fit without changing saved identifiers', async t => {
  const f = await fixture(t); const entries = manyModels(f, true);
  const verify = terminalPicker(f, (component, terminal) => {
    terminal.rows = 10; fits(component, terminal, 30, 'model-000');
    component.handleInput('\x1b[B'); fits(component, terminal, 30, 'model-001');
    component.handleInput('\r');
  });
  await f.invoke(''); verify();
  assert.deepEqual(JSON.parse(await readFile(f.paths.global)), { builder: { provider: 'catalog', model: entries[1].id }, classifier: { provider: 'catalog', model: entries[1].id } });
  assert.deepEqual(f.calls, []);
});

test('AC-9 preserved TUI cancellation after navigation at either stage writes nothing', async t => {
  const f = await fixture(t); manyModels(f); await f.write('global', models); await f.write('project', { classifier: clef });
  const before = await Promise.all(['global', 'project'].map(scope => readFile(f.paths[scope], 'utf8')));
  for (const cancelAt of [1, 2]) {
    const verify = terminalPicker(f, (component, _terminal, prompt) => {
      component.handleInput('\x1b[B'); component.handleInput(prompt === cancelAt ? '\x1b' : '\r');
    });
    await f.invoke(''); verify();
    assert.deepEqual(await Promise.all(['global', 'project'].map(scope => readFile(f.paths[scope], 'utf8'))), before);
    assert.match(f.notices.at(-1).text, /cancelled/);
  }
  assert.deepEqual(f.calls, []);
});

test('AC-10 TUI picker is inline with at most ten model rows on tall terminals', async t => {
  const f = await fixture(t); manyModels(f);
  const verify = terminalPicker(f, (component, terminal, _prompt, options) => {
    terminal.rows = 60;
    const lines = component.render(80);
    const modelRows = lines.filter(line => /^(→ |  ).*model-\d{3}/.test(line) && !line.includes('Model Name:'));
    assert.equal(modelRows.length, 10, 'same ten-row cap as /model');
    assert.ok(!options?.overlay, 'same inline placement as /model');
    fits(component, terminal, 80, 'model-000');
    component.handleInput('\r');
  });
  await f.invoke(''); verify(); assert.deepEqual(f.calls, []);
});

test('AC-10 fuzzy search uses names and provider/model tokens with editable j/k text', async t => {
  const f = await fixture(t); const entries = manyModels(f);
  entries[73].name = 'Jovial King'; entries[26].name = 'Jungle Kite';
  const searchText = item => `${item.provider} ${item.provider}/${item.id} ${item.provider} ${item.id}${item.name ? ` ${item.name}` : ''}`;
  const verify = terminalPicker(f, (component, terminal, prompt) => {
    component.handleInput('j'); component.handleInput('k');
    fits(component, terminal, 80, fuzzyFilter(entries, 'jk', searchText)[0].id);
    assert.ok(component.render(80).some(line => line.includes('> jk')), 'j/k must type search text');
    component.handleInput('\x15');
    component.handleInput(prompt === 1 ? 'JvL Kng' : 'cTlg/mD099');
    const expected = prompt === 1 ? 'model-073' : 'model-099';
    fits(component, terminal, 80, expected);
    // Editing must filter again and reset selection to the best match.
    component.handleInput('\x7f'); component.handleInput(prompt === 1 ? 'g' : '9');
    fits(component, terminal, 80, expected);
    component.handleInput('\r');
  });
  await f.invoke(''); verify();
  assert.deepEqual(JSON.parse(await readFile(f.paths.global)), { builder: { provider: 'catalog', model: 'model-073' }, classifier: { provider: 'catalog', model: 'model-099' } });
  assert.deepEqual(f.calls, []);
});

test('AC-10 configured role model is selected first and shows current marker and name', async t => {
  const f = await fixture(t); const entries = manyModels(f);
  entries[73].name = 'Builder Display'; entries[26].name = 'Classifier Display';
  await f.write('global', { builder: { provider: 'catalog', model: 'model-073' }, classifier: { provider: 'catalog', model: 'model-026' } });
  const verify = terminalPicker(f, (component, terminal, prompt) => {
    const selected = prompt === 1 ? entries[73] : entries[26];
    fits(component, terminal, 80, selected.id);
    assert.ok(component.render(80).some(line => line.includes('→') && line.includes('✓') && line.includes(selected.id)));
    assert.ok(component.render(80).some(line => line.includes(`Model Name: ${selected.name}`)));
    component.handleInput('\r');
  });
  await f.invoke(''); verify(); assert.deepEqual(f.calls, []);
});

test('AC-10 no-match Enter stays open, clear restores results, arrows wrap, and Ctrl+C cancels', async t => {
  const f = await fixture(t); manyModels(f); await f.write('global', models); await f.write('project', { classifier: clef });
  const before = await Promise.all(['global', 'project'].map(scope => readFile(f.paths[scope], 'utf8')));
  for (const cancelAt of [1, 2]) {
    const verify = terminalPicker(f, (component, terminal, prompt, _options, finished) => {
      component.handleInput('zzzzzzzz');
      assert.ok(component.render(80).some(line => line.includes('No matching models')));
      component.handleInput('\r'); assert.equal(finished(), false);
      component.handleInput('\x15'); fits(component, terminal, 80, 'model-000');
      component.handleInput('\x1b[A'); fits(component, terminal, 80, 'model-099');
      component.handleInput('\x1b[B'); fits(component, terminal, 80, 'model-000');
      component.handleInput(prompt === cancelAt ? '\x03' : '\r');
    });
    await f.invoke(''); verify();
    assert.deepEqual(await Promise.all(['global', 'project'].map(scope => readFile(f.paths[scope], 'utf8'))), before);
    assert.match(f.notices.at(-1).text, /cancelled/);
  }
  assert.deepEqual(f.calls, []);
});

test('AC-7 settings replace complete roles, respect trust and reread manual edits', async t => {
  const f = await fixture(t); await f.write('global', models);
  await f.write('project', { classifier: clef });
  assert.deepEqual(await loadSettings(f.paths, true), { settings: { ...models, classifier: clef }, sources: { builder: 'global', classifier: 'project' } });
  assert.deepEqual((await loadSettings(f.paths, false)).settings, models);
  let result = await f.decide(); assert.equal(result.isError, false); assert.deepEqual(result.structuredContent.models.classifier, clef);
  await f.write('project', { builder: { provider: 'other', model: 'tiny' } });
  result = await f.decide(); assert.equal(result.isError, false); assert.deepEqual(result.structuredContent.models.builder, { provider: 'other', model: 'tiny' });
  await writeFile(f.paths.project, 'invalid'); f.ctx.isProjectTrusted = () => false;
  result = await f.decide(); assert.equal(result.isError, false); assert.deepEqual(result.structuredContent.models, models);
});

test('AC-7 former model environment variables do not configure missing settings', async t => {
  const f = await fixture(t);
  Object.assign(process.env, { PI_MAGIC8BALL_BUILDER_PROVIDER: 'cheap', PI_MAGIC8BALL_BUILDER_MODEL: 'small', PI_MAGIC8BALL_CLASSIFIER_PROVIDER: 'typesafe', PI_MAGIC8BALL_CLASSIFIER_MODEL: 'jev-latest' });
  const result = await f.decide(); assert.equal(result.structuredContent.error?.kind, 'not-configured'); assert.deepEqual(f.calls, []);
  await f.write('global', { builder: models.builder });
  const missing = await f.decide(); assert.equal(missing.structuredContent.error?.kind, 'not-configured'); assert.deepEqual(f.calls, []);
});

test('AC-7 malformed, oversized and partial settings fail before model calls', async t => {
  const f = await fixture(t); await f.write('global', models);
  for (const bad of ['invalid', 'null', '[]', JSON.stringify({ builder: { provider: 'other' } }), JSON.stringify({ classifier: null }), JSON.stringify({ classifier: { provider: '', model: 'x' } }), JSON.stringify({ classifier: { provider: 'typesafe', model: 'jev latest' } }), JSON.stringify({ extra: true }), JSON.stringify({ classifier: { ...clef, extra: true } }), JSON.stringify({ classifier: { provider: 'x'.repeat(513), model: 'm' } }), ' '.repeat(16001)]) {
    await writeFile(f.paths.project, bad);
    await assert.rejects(loadSettings(f.paths, true), errorKind('invalid-config'));
    const result = await f.decide(); assert.equal(result.structuredContent.error?.kind, 'invalid-config'); assert.deepEqual(f.calls, []);
  }
  await writeFile(f.paths.global, 'broken'); await f.write('project', models);
  await assert.rejects(loadSettings(f.paths, true), errorKind('invalid-config'));
});

test('AC-7 settings reject symlink files, symlink parents and nonregular files', async t => {
  const f = await fixture(t); await f.write('global', models);
  await symlink(f.paths.global, f.paths.project);
  await assert.rejects(loadSettings(f.paths, true), errorKind('settings-unavailable'));
  assert.deepEqual((await loadSettings(f.paths, false)).settings, models);
  await rm(f.paths.project); await mkdir(f.paths.project);
  await assert.rejects(loadSettings(f.paths, true), errorKind('settings-unavailable'));
  await rm(join(f.cwd, '.pi'), { recursive: true }); await symlink(f.agentDir, join(f.cwd, '.pi'));
  await assert.rejects(loadSettings(f.paths, true), errorKind('settings-unavailable'));
  const result = await f.decide(); assert.equal(result.structuredContent.error?.kind, 'settings-unavailable'); assert.deepEqual(f.calls, []);
});

test('AC-8 explicit commands save scoped roles, preserve other settings and take effect immediately', async t => {
  const f = await fixture(t);
  const unrelated = join(f.agentDir, 'settings.json'); await writeFile(unrelated, '{"theme":"dark"}');
  await f.invoke('builder cheap small'); await f.invoke('classifier --global typesafe jev-latest');
  assert.deepEqual(JSON.parse(await readFile(f.paths.global)), models); assert.deepEqual(f.calls, []);
  await absent(f.paths.project); assert.equal(await readFile(unrelated, 'utf8'), '{"theme":"dark"}');
  assert.equal((await f.decide()).isError, false); f.calls.length = 0;
  await f.invoke('--project classifier cloudflare-workers-ai @cf/cloudflare/clef');
  assert.deepEqual(JSON.parse(await readFile(f.paths.project)), { classifier: clef });
  assert.match(f.notices.at(-1).text, /project/); assert.match(f.notices.at(-1).text, /magic8ball\.json/);
  const result = await f.decide(); assert.deepEqual(result.structuredContent.models.classifier, clef);
  f.calls.length = 0; await f.invoke('classifier typesafe jev-latest'); await f.invoke('show');
  assert.match(f.notices.at(-1).text, /@cf\/cloudflare\/clef/); assert.match(f.notices.at(-1).text, /project/); assert.deepEqual(f.calls, []);
});

test('AC-8 interactive picker saves both models and excludes virtual builders', async t => {
  const f = await fixture(t); f.ctx.mode = 'rpc'; await f.invoke('');
  assert.equal(f.selects.length, 2); assert.ok(f.selects[0].options.every(option => !option.includes('router')));
  assert.deepEqual(JSON.parse(await readFile(f.paths.global)), models); assert.deepEqual(f.calls, []);
  assert.match(f.notices.at(-1).text, /global/); assert.match(f.notices.at(-1).text, /magic8ball\.json/);
});

test('AC-8 cancelling either picker leaves existing files unchanged', async t => {
  const f = await fixture(t); f.ctx.mode = 'rpc'; await f.write('global', models);
  const before = await readFile(f.paths.global, 'utf8');
  for (const cancelAt of [1, 2]) {
    let prompts = 0;
    f.ctx.ui.select = async (_title, options) => ++prompts === cancelAt ? undefined : options[0];
    await f.invoke(''); assert.equal(prompts, cancelAt);
    assert.equal(await readFile(f.paths.global, 'utf8'), before); await absent(f.paths.project);
  }
  assert.deepEqual(f.calls, []);
});

test('AC-8 rejects invalid syntax/models, denied project writes and noninteractive prompting', async t => {
  const f = await fixture(t);
  for (const args of ['nonsense', 'builder cheap', 'builder cheap small extra', '--global --project builder cheap small', '--global --global builder cheap small', '--unknown builder cheap small', 'builder missing small', 'classifier cheap small', 'builder pi-virtual router', 'show ignored']) {
    await f.invoke(args); assert.equal(f.notices.at(-1).level, 'error', args); await absent(f.paths.global); await absent(f.paths.project);
  }
  f.ctx.isProjectTrusted = () => false;
  await f.invoke('builder cheap small --project'); assert.equal(f.notices.at(-1).level, 'error'); await absent(f.paths.project);
  f.ctx.hasUI = false; f.ctx.mode = 'print'; await f.invoke('');
  assert.equal(f.selects.length, 0); await absent(f.paths.global); assert.deepEqual(f.calls, []);
  await f.invoke('builder cheap small'); assert.deepEqual(JSON.parse(await readFile(f.paths.global)), { builder: models.builder });
});

test('AC-8 concurrent saves preserve roles; corrupt files and lock contention are not overwritten', async t => {
  const f = await fixture(t);
  await Promise.all([saveSettingsPatch(f.paths, 'global', { builder: models.builder }, true), saveSettingsPatch(f.paths, 'global', { classifier: models.classifier }, true)]);
  assert.deepEqual(JSON.parse(await readFile(f.paths.global)), models);
  assert.deepEqual((await readdir(f.agentDir)).sort(), ['magic8ball.json']);
  await writeFile(f.paths.global, 'CORRUPT');
  await assert.rejects(saveSettingsPatch(f.paths, 'global', { builder: models.builder }, true), errorKind('invalid-config'));
  assert.equal(await readFile(f.paths.global, 'utf8'), 'CORRUPT');
  await f.write('global', models); await writeFile(f.paths.global + '.lock', 'existing owner');
  await assert.rejects(saveSettingsPatch(f.paths, 'global', { classifier: clef }, true), errorKind('settings-unavailable'));
  assert.deepEqual(JSON.parse(await readFile(f.paths.global)), models);
  assert.equal(await readFile(f.paths.global + '.lock', 'utf8'), 'existing owner');
  await f.invoke('classifier cloudflare-workers-ai @cf/cloudflare/clef');
  assert.equal(f.notices.at(-1).level, 'error'); assert.match(f.notices.at(-1).text, /inspect|show/i);
});

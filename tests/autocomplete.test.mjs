import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui';
import extension from '../magic8ball.ts';
import { settingsPaths } from '../lib/settings.ts';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'magic8ball-autocomplete-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace'), agent = join(root, 'agent');
  await mkdir(join(cwd, '.pi'), { recursive: true }); await mkdir(agent);
  const saved = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => { saved === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = saved; });
  const paths = settingsPaths(cwd, agent);
  await writeFile(paths.global, JSON.stringify({ builder: { provider: 'chat', model: 'luna-large' }, classifier: { provider: 'choices', model: 'clef' } }));
  const chats = [
    { provider: 'chat', id: 'luna-large', name: 'Luna Large', api: 'test', reasoning: true, thinkingLevelMap: { xhigh: null, max: null } },
    { provider: 'chat', id: 'other/small', name: 'Tiny Moon', api: 'test', reasoning: false },
    { provider: 'another', id: 'plain', name: 'Plain', api: 'test', reasoning: false },
    { provider: 'virtual-only', id: 'virtual', name: 'Virtual', api: 'pi-virtual', reasoning: true },
  ];
  const classifiers = [{ provider: 'choices', id: 'clef', name: 'Fast Choice' }, { provider: 'choices', id: '@cf/cloudflare/clef-flash', name: 'Clef Flash' }, { provider: 'other-choice', id: 'jev', name: 'Jev' }];
  const commands = new Map(), events = new Map(), notices = [], lookups = [];
  const forbidden = () => assert.fail('Completion must not run models/tools, refresh catalogs, or change the active model');
  extension({ on: (name, handler) => events.set(name, handler), registerTool() {}, registerCommand: (name, command) => commands.set(name, command), setModel: forbidden });
  let trusted = true;
  const ctx = { cwd, hasUI: false, mode: 'rpc', isProjectTrusted: () => trusted, ui: { notify: text => notices.push(text) },
    executeTool: forbidden,
    modelRegistry: { getAvailable: () => { lookups.push('chat'); return chats; },
      getAvailableOfType: async type => { lookups.push(type); assert.equal(type, 'classifier'); return classifiers; },
      find: (provider, id) => chats.find(m => m.provider === provider && m.id === id),
      refresh: forbidden, streamSimple: forbidden, classify: forbidden },
  };
  const command = commands.get('magic8ball');
  await events.get('session_start')({}, ctx);
  // Existing registrations without autocomplete deliberately return no suggestions.
  const complete = async prefix => command.getArgumentCompletions ? await command.getArgumentCompletions(prefix) : null;
  const values = async prefix => (await complete(prefix) ?? []).map(item => item.value.trimEnd());
  return { paths, chats, classifiers, ctx, command, events, notices, lookups, complete, values, trust: value => { trusted = value; } };
}

test('AC-20 completes command grammar, scope flags, and isolated transcript actions', async t => {
  const f = await fixture(t);
  assert.deepEqual(new Set(await f.values('')), new Set(['show', 'builder', 'classifier', 'reasoning', 'transcripts', '--global', '--project']));
  assert.deepEqual(await f.values('rea'), ['reasoning']);
  assert.deepEqual(await f.values('--p'), ['--project']);
  for (const scope of ['--global', '--project']) {
    assert.deepEqual(new Set(await f.values(`${scope} `)), new Set(['show', 'builder', 'classifier', 'reasoning'].map(s => `${scope} ${s}`)));
    assert.deepEqual(await f.values(`${scope} sho`), [`${scope} show`]);
  }
  assert.deepEqual(await f.values('transcripts '), ['transcripts on', 'transcripts off', 'transcripts show']);
  assert.deepEqual(await f.values('transcripts o'), ['transcripts on', 'transcripts off']);
  assert.deepEqual(await f.values('transcripts\n'), ['transcripts\non', 'transcripts\noff', 'transcripts\nshow']);
  assert.deepEqual(await f.values('show --'), ['show --global', 'show --project']);
  assert.deepEqual(await f.values('builder chat luna-large --p'), ['builder chat luna-large --project']);
  for (const invalid of ['nope ', '--bad ', '--global --project ', '--global --global ', '--project transcripts ', 'transcripts --', 'transcripts show ', 'transcripts on extra ', 'show extra ', 'reasoning high extra ', 'builder chat luna-large extra ', 'builder chat luna-large extra', 'classifier choices clef extra', 'classifier choices clef --global --']) {
    assert.equal(await f.complete(invalid), null, invalid);
  }
  assert.equal(f.lookups.length, 0, 'Static grammar must not require catalogs');
});

test('AC-20 completes distinct role-specific providers and fuzzy model identifiers/names', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.values('builder '), ['builder another', 'builder chat']);
  assert.deepEqual(await f.values('builder CH'), ['builder chat']);
  assert.deepEqual(await f.values('classifier '), ['classifier choices', 'classifier other-choice']);
  assert.deepEqual(await f.values('classifier ch'), ['classifier choices']);
  assert.deepEqual(await f.values('--project builder --'), []);
  assert.deepEqual(await f.values('builder --project ch'), ['builder --project chat']);
  assert.deepEqual(await f.values('--global builder chat LU'), ['--global builder chat luna-large']);
  assert.deepEqual(await f.values('builder chat TM'), ['builder chat other/small']);
  assert.deepEqual(await f.values('classifier choices @cf/'), ['classifier choices @cf/cloudflare/clef-flash']);
  assert.deepEqual(await f.values('classifier choices Fast'), ['classifier choices clef']);
  assert.equal(await f.complete('builder virtual-only '), null);
  assert.equal(await f.complete('builder missing '), null);
  assert.equal(await f.complete('builder chat zzzzz'), null);
  f.chats.push({ provider: 'new-chat', id: 'new', api: 'test', name: 'New' });
  assert.ok((await f.values('builder ')).includes('builder new-chat'), 'Use the current catalog, not an old snapshot');
  assert.ok(f.lookups.includes('classifier'));
});

test('AC-20 reasoning completion follows fresh scoped builder capabilities and project trust', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.values('reasoning h'), ['reasoning high']);
  assert.ok(!(await f.values('reasoning ')).includes('reasoning max'));
  await writeFile(f.paths.project, JSON.stringify({ builder: { provider: 'chat', model: 'other/small' } }));
  assert.deepEqual(await f.values('--project reasoning '), ['--project reasoning default', '--project reasoning off']);
  assert.deepEqual(await f.values('reasoning --project o'), ['reasoning --project off']);
  assert.deepEqual(await f.values('--global reasoning h'), ['--global reasoning high']);
  await writeFile(f.paths.global, JSON.stringify({ builder: { provider: 'another', model: 'plain' } }));
  assert.deepEqual(await f.values('reasoning '), ['reasoning default', 'reasoning off']);
  await writeFile(f.paths.project, '{'); f.trust(false);
  assert.equal(await f.complete('--project reasoning '), null);
  assert.deepEqual(await f.values('reasoning '), ['reasoning default', 'reasoning off']);
  f.trust(true); assert.equal(await f.complete('--project reasoning '), null);
  await writeFile(f.paths.project, '{}');
  assert.deepEqual(await f.values('--project reasoning '), ['--project reasoning default', '--project reasoning off']);
  await writeFile(f.paths.global, '{}'); assert.equal(await f.complete('reasoning '), null);
  await writeFile(f.paths.global, JSON.stringify({ builder: { provider: 'absent', model: 'missing' } }));
  assert.equal(await f.complete('reasoning '), null);
});

test('AC-20 actual Pi completion preserves the full argument prefix, separators, cursor, and suffix', async t => {
  const f = await fixture(t);
  const provider = new CombinedAutocompleteProvider([{ name: 'magic8ball', ...f.command }], f.ctx.cwd, null);
  for (const [before, suffix, expected, label] of [
    ['/magic8ball rea', '', '/magic8ball reasoning ', 'reasoning'],
    ['/magic8ball --project\tbuilder\tchat\tLU', '', '/magic8ball --project\tbuilder\tchat\tluna-large ', 'luna-large'],
    ['/magic8ball --g', 'builder chat luna-large', '/magic8ball --global builder chat luna-large', '--global'],
    ['/magic8ball transcripts sh', '', '/magic8ball transcripts show ', 'show'],
  ]) {
    const line = before + suffix;
    const suggestions = await provider.getSuggestions([line], 0, before.length, { signal: new AbortController().signal });
    assert.ok(suggestions, `Missing completions for ${before}`);
    const item = suggestions.items.find(item => item.label === label); assert.ok(item);
    assert.ok(item.value.endsWith(' ')); assert.ok(item.description);
    const applied = provider.applyCompletion([line], 0, before.length, item, suggestions.prefix);
    assert.deepEqual(applied.lines, [expected]); assert.equal(applied.cursorCol, expected.length - suffix.length);
  }
});

test('AC-20 failures stay silent and completion never writes, spends, or changes capture', async t => {
  const f = await fixture(t);
  assert.ok((await f.complete('builder '))?.length, 'Builder autocomplete must be registered');
  await f.command.handler('transcripts on', f.ctx); await f.command.handler('transcripts show', f.ctx);
  const captureStatus = f.notices.at(-1), noticeCount = f.notices.length;
  const global = await readFile(f.paths.global, 'utf8');
  const fail = () => { throw new Error('RAW_LOOKUP_ERROR'); };
  f.ctx.modelRegistry.getAvailable = fail; f.ctx.modelRegistry.getAvailableOfType = fail;
  assert.equal(await f.complete('builder '), null); assert.equal(await f.complete('classifier '), null);
  await writeFile(f.paths.global, '{'); assert.equal(await f.complete('reasoning '), null);
  assert.deepEqual(await f.values('transcripts sh'), ['transcripts show']);
  assert.deepEqual(await f.values('rea'), ['reasoning']);
  assert.equal(await readFile(f.paths.global, 'utf8'), '{');
  await writeFile(f.paths.global, global);
  assert.equal(await f.complete('reasoning h') instanceof Array, true);
  assert.equal(await readFile(f.paths.global, 'utf8'), global);
  assert.equal(f.notices.length, noticeCount);
  await f.command.handler('transcripts show', f.ctx); assert.equal(f.notices.at(-1), captureStatus);
  assert.doesNotMatch(f.notices.join('\n'), /RAW_LOOKUP_ERROR/);
});

test('AC-20 session replacement/shutdown invalidate context and pending catalog results', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.values('classifier ch'), ['classifier choices']);
  let release;
  f.ctx.modelRegistry.getAvailableOfType = () => new Promise(resolve => { release = resolve; });
  const pending = f.complete('classifier '); assert.equal(typeof release, 'function');
  const next = { ...f.ctx, modelRegistry: { ...f.ctx.modelRegistry, getAvailableOfType: async () => [{ provider: 'new-choice', id: 'new' }] } };
  await f.events.get('session_start')({}, next);
  release(f.classifiers); assert.equal(await pending, null);
  assert.deepEqual(await f.values('classifier '), ['classifier new-choice']);
  next.modelRegistry.getAvailableOfType = () => new Promise(resolve => { release = resolve; });
  const shutdown = f.complete('classifier ');
  await f.events.get('session_shutdown')({}, next); release(f.classifiers); assert.equal(await shutdown, null);
  assert.equal(await f.complete('classifier '), null); assert.equal(await f.complete('builder '), null); assert.equal(await f.complete('reasoning '), null);
  assert.deepEqual(await f.values('transcripts o'), ['transcripts on', 'transcripts off']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { evidence } from '../lib/evidence.ts';

test('AC-3 evidence reads, lists and searches without exposing denied paths', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'magic8ball-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'README.md'), 'one\ntwo match\nthree match\n');
  await writeFile(join(dir, '.env'), 'SECRET'); await writeFile(join(dir, 'auth.json'), 'SECRET'); await writeFile(join(dir, 'private.pem'), 'SECRET');
  await writeFile(join(dir, 'binary'), Buffer.from([0, 1, 2])); await symlink('README.md', join(dir, 'link')); await mkdir(join(dir, 'node_modules')); await mkdir(join(dir, 'src'));
  await symlink('src', join(dir, 'linked-dir'));
  const read = await evidence(dir, 'read', { path: 'README.md', offset: 2, limit: 1 }); assert.match(read.text, /2: two match/); assert.doesNotMatch(read.text, /three/);
  const search = await evidence(dir, 'search', { path: 'README.md', text: 'match' }); assert.match(search.text, /2: two match/); assert.match(search.text, /3: three match/);
  const list = await evidence(dir, 'list', { path: '.' }); assert.match(list.text, /README.md/); assert.match(list.text, /src/); assert.doesNotMatch(list.text, /auth|env|private|node_modules|link/);
  for (const path of ['../outside', '/etc/passwd', '.env', 'auth.json', 'private.pem', 'link', 'linked-dir/file', 'binary', 'src/../README.md', 'node_modules/file']) await assert.rejects(() => evidence(dir, 'read', { path }));
  await assert.rejects(() => evidence(dir, 'read', { path: 'README.md', limit: 201 }));
  await assert.rejects(() => evidence(dir, 'read', { path: 'README.md', limit: null }));
  await assert.rejects(() => evidence(dir, 'read', { path: 'README.md', offset: null }));
  await assert.rejects(() => evidence(dir, 'list', { path: null }));
  await assert.rejects(() => evidence(dir, 'search', { path: 'README.md', text: '' }));
  const special = spawnSync('mkfifo', [join(dir, 'pipe')]);
  if (special.status === 0) await assert.rejects(() => evidence(dir, 'read', { path: 'pipe' }));
});

test('AC-3 evidence outputs respect byte and entry ceilings and cancellation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'magic8ball-bounds-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'big.txt'), '😀'.repeat(8000));
  const big = await evidence(dir, 'read', { path: 'big.txt' }); assert.equal(big.truncated, true); assert.ok(Buffer.byteLength(big.text) <= 16000); assert.doesNotMatch(big.text, /�/);
  await Promise.all(Array.from({ length: 205 }, (_, i) => writeFile(join(dir, `f${i}`), 'match')));
  const list = await evidence(dir, 'list', { path: '.' }); assert.equal(list.truncated, true); assert.ok(list.text.split('\n').length <= 200);
  await writeFile(join(dir, 'lines.txt'), 'match\n'.repeat(300));
  const search = await evidence(dir, 'search', { path: 'lines.txt', text: 'match' }); assert.equal(search.truncated, true); assert.ok(search.text.split('\n').length <= 200);
  const controller = new AbortController(); controller.abort(); await assert.rejects(() => evidence(dir, 'read', { path: 'big.txt' }, controller.signal));
});

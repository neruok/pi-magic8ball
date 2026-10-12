import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('COMMON-AC-1 README release and installation examples identify this version', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const references = [...readme.matchAll(/@neruok\/pi-[a-z0-9-]+@(\d+\.\d+\.\d+)/g)]
    .filter(match => match[0].startsWith(manifest.name + '@'));
  assert.ok(references.length > 0);
  for (const reference of references) assert.equal(reference[1], manifest.version, reference[0]);
});

test('COMMON-AC-1 release pins the verified common registry artifact without a source link', async () => {
  assert.deepEqual(manifest.dependencies, { '@neruok/pi-common': '0.1.0' });
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  const common = lock.packages['node_modules/@neruok/pi-common'];
  assert.equal(common.version, '0.1.0');
  assert.equal(common.link, undefined);
  assert.equal(common.resolved, 'https://registry.npmjs.org/@neruok/pi-common/-/pi-common-0.1.0.tgz');
  assert.equal(common.integrity, 'sha512-8I3zVAP6kO1QgWbgiosEQIPfoQrSiwu04ustT7OhYcPYDXnsPkRpwYmluMv/dtSeE7TEaDGp86ba4kQjRiA7VQ==');
  assert.equal(common.dependencies, undefined);
  for (const path of Object.keys(lock.packages)) assert.ok(!path.startsWith('../'), path);
});

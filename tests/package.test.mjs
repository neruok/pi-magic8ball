import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = () => readFile(join(root, 'package.json'), 'utf8').then(JSON.parse);
const repository = 'https://github.com/neruok/pi-magic8ball';

test('AC-25 package metadata supports Pi discovery and repository navigation', async () => {
  const pkg = await manifest();
  assert.ok(pkg.keywords?.includes('pi-package'), 'npm discovery needs the pi-package keyword');
  assert.deepEqual(pkg.repository, { type: 'git', url: `${repository}.git` });
  assert.equal(pkg.homepage, `${repository}#readme`);
  assert.deepEqual(pkg.bugs, { url: `${repository}/issues` });
});

test('AC-25 release metadata and lockfile identify a public MIT scoped package', async () => {
  const pkg = await manifest();
  assert.equal(pkg.name, '@neruok/pi-magic8ball');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.notEqual(pkg.version, '0.0.0');
  assert.notEqual(pkg.private, true);
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.publishConfig.access, 'public');
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  for (const identity of [lock, lock.packages['']]) {
    assert.equal(identity.name, pkg.name);
    assert.equal(identity.version, pkg.version);
  }
  assert.equal(lock.packages[''].license, 'MIT');
  const license = await readFile(join(root, 'LICENSE'), 'utf8');
  assert.match(license, /^MIT License\n/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
});

test('AC-25 package checks have a focused command and run in verification/CI', async () => {
  const pkg = await manifest();
  assert.equal(pkg.scripts['check:package'], 'node --test tests/package.test.mjs');
  assert.match(pkg.scripts.verify, /npm run check(?:\s|$)/);
  assert.match(pkg.scripts.check, /node --test tests\/\*\.test\.mjs/);
  const ci = await readFile(join(root, '.github/workflows/verify.yml'), 'utf8');
  assert.match(ci, /npm ci --ignore-scripts/);
  assert.match(ci, /npm run verify/);
});

test('AC-25 packed release includes its license, loads without adjacent dependencies and keeps benchmark offline', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'magic8ball-package-'));
  try {
    const npm = process.env.npm_execpath;
    const packed = await run(npm ? process.execPath : 'npm', [...(npm ? [npm] : []), 'pack', '--ignore-scripts', '--json', '--pack-destination', scratch], { cwd: root });
    const report = JSON.parse(packed.stdout);
    // npm 12 uses a keyed object, while earlier versions use an array.
    const [artifact] = Array.isArray(report) ? report : Object.values(report);
    assert.equal(artifact.bundled.length, 0);
    const paths = artifact.files.map(file => file.path);
    assert.ok(paths.includes('LICENSE'), 'The release tarball must include LICENSE');
    const allowed = /^(?:package\.json|README\.md|LICENSE|docs\/pi-magic8ball\.md|magic8ball\.ts|lib\/[A-Za-z0-9-]+\.ts|scripts\/benchmark(?:-adapter\.example)?\.mjs)$/;
    for (const path of paths) assert.match(path, allowed, `Unexpected packed path: ${path}`);
    await run('tar', ['-xzf', join(scratch, artifact.filename), '-C', scratch]);
    const extracted = join(scratch, 'package');
    await assert.rejects(access(join(extracted, 'node_modules')), error => error.code === 'ENOENT');
    const pkg = JSON.parse(await readFile(join(extracted, 'package.json'), 'utf8'));
    const source = await manifest();
    assert.equal(pkg.name, source.name);
    assert.equal(pkg.version, source.version);
    assert.equal(pkg.license, 'MIT');
    assert.equal(pkg.publishConfig.access, 'public');
    assert.equal(await readFile(join(extracted, 'LICENSE'), 'utf8'), await readFile(join(root, 'LICENSE'), 'utf8'));
    for (const [name, range] of Object.entries(pkg.peerDependencies)) {
      assert.equal(range, '*');
      assert.equal(pkg.peerDependenciesMeta[name].optional, true);
      assert.equal(pkg.dependencies?.[name], undefined);
    }
    const entry = join(extracted, pkg.pi.extensions[0]);
    assert.ok(paths.includes(pkg.pi.extensions[0].replace(/^\.\//, '')));
    // Pi maps host imports for source TypeScript extensions. No dependency install,
    // session discovery, model runtime, or provider call is needed for this load.
    const piEntry = new URL(import.meta.resolve('@earendil-works/pi-coding-agent'));
    const loader = new URL('./core/extensions/loader.js', piEntry).href;
    const smoke = await run(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const { loadExtensions } = await import(${JSON.stringify(loader)});
      const loaded = await loadExtensions([${JSON.stringify(entry)}], ${JSON.stringify(extracted)});
      assert.deepEqual(loaded.errors, []);
      assert.deepEqual(loaded.warnings ?? [], []);
      assert.equal(loaded.extensions.length, 1);
      const extension = loaded.extensions[0];
      assert.deepEqual([...extension.tools.keys()].sort(), ['magic8ball', 'magic8ball_list', 'magic8ball_read', 'magic8ball_search']);
      assert.deepEqual([...extension.commands.keys()], ['magic8ball']);
      console.log('packed registration passed');
    `], { cwd: extracted });
    assert.match(smoke.stdout, /packed registration passed/);
    const dry = await run(process.execPath, [join(extracted, 'scripts/benchmark.mjs'), '--dry-run', '--config', 'small', '--config', 'other'], { cwd: extracted });
    const plan = JSON.parse(dry.stdout);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.plan.length, 24);
    assert.equal(plan.maxModelCalls, 88);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  await assert.rejects(access(scratch), error => error.code === 'ENOENT');
});

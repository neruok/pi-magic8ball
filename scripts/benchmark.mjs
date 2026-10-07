import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { benchmarkPlan, runBenchmark } from '../lib/benchmark.ts';

async function main() {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, 'allow-spend': { type: 'boolean' }, adapter: { type: 'string' }, config: { type: 'string', multiple: true }, output: { type: 'string' } } });
  let report;
  if (values['dry-run']) {
    // Do not even import the adapter: imports can load credentials or have side effects.
    const plan = benchmarkPlan(values.config ?? ['example']);
    report = { dryRun: true, plan, maxModelCalls: plan.reduce((n, row) => n + row.maxBuilderRequests + row.maxClassifierRequests, 0) };
  } else {
    if (!values['allow-spend'] || !values.adapter) throw new Error('Live benchmark requires --allow-spend and --adapter. Use --dry-run to inspect the plan first.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort);
    try {
      const exported = (await import(pathToFileURL(resolve(values.adapter)).href)).default;
      const adapter = typeof exported === 'function' ? await exported() : exported;
      const configurations = values.config ? adapter.configurations.filter(c => values.config.includes(c.name)) : adapter.configurations;
      if (values.config && values.config.some(name => !configurations.some(c => c.name === name))) throw new Error('Unknown benchmark configuration.');
      report = await runBenchmark(configurations, adapter.classify, { allowSpend: true, signal: controller.signal });
    } finally { process.removeListener('SIGINT', abort); }
  }
  const text = JSON.stringify(report, null, 2) + '\n';
  if (values.output) await writeFile(resolve(values.output), text, { flag: 'wx', mode: 0o600 });
  else process.stdout.write(text);
}
main().catch(() => {
  // Adapters can throw secret-bearing provider errors. Do not print them.
  process.stderr.write('Benchmark failed. Use --dry-run or --allow-spend --adapter <path>. Check model selections and the output path. No automatic retry occurred.\n');
  process.exitCode = 1;
});

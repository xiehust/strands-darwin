/**
 * React 19 development reconciler records User Timing measures for every component
 * on every Ink commit. Node retains those entries, so the TUI's 90 ms busy tick can
 * fill a 4 GiB heap while the provider emits no events. Prove that Darwin's import
 * boundary selects React production before Ink is loaded and that a low-heap,
 * accelerated busy frame remains bounded.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { withProductionReactImports } from '../src/tui/react-environment.js';

const previous = process.env.NODE_ENV;
delete process.env.NODE_ENV;
let observed: string | undefined;
await withProductionReactImports(async () => {
  observed = process.env.NODE_ENV;
});
assert.equal(observed, 'production', 'the first React import sees production mode');
assert.equal(process.env.NODE_ENV, undefined, 'a previously absent mode is restored after imports');

process.env.NODE_ENV = 'test';
await withProductionReactImports(async () => {
  assert.equal(process.env.NODE_ENV, 'production', 'interactive imports override an explicit development/test mode');
});
assert.equal(process.env.NODE_ENV, 'test', 'the caller mode is restored after imports');
if (previous === undefined) delete process.env.NODE_ENV;
else process.env.NODE_ENV = previous;

const development = runMemoryWorker('development', 2_000);
assert.ok(
  development.measures >= 4_000,
  `development control did not retain per-commit measures: ${development.measures}`,
);

const production = runMemoryWorker('production', 10_000);
assert.equal(production.measures, 0, 'production React records no retained component measures');
assert.ok(production.heapUsed < 48 * 1024 * 1024, `heap was not bounded: ${formatMiB(production.heapUsed)} MiB`);
assert.ok(production.rss < 220 * 1024 * 1024, `RSS was not bounded: ${formatMiB(production.rss)} MiB`);

console.log('ok - interactive React production import keeps silent busy ticks bounded');
console.log(
  `  development: ticks=2000 measures=${development.measures} heap=${formatMiB(development.heapUsed)} MiB`,
);
console.log(
  `  production: ticks=10000 measures=${production.measures} heap=${formatMiB(production.heapUsed)} MiB ` +
    `rss=${formatMiB(production.rss)} MiB`,
);

interface MemoryReport {
  heapUsed: number;
  rss: number;
  measures: number;
}

function runMemoryWorker(mode: 'development' | 'production', ticks: number): MemoryReport {
  const worker = path.join(import.meta.dirname, 'verify-react-production-memory-worker.tsx');
  const result = spawnSync(
    process.execPath,
    ['--max-old-space-size=96', '--expose-gc', '--import', 'tsx', worker],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, NODE_ENV: mode, DARWIN_MEMORY_TICKS: String(ticks) },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  assert.equal(
    result.status,
    0,
    `${mode} busy-frame worker failed in a 96 MiB heap\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return JSON.parse(result.stdout.trim()) as MemoryReport;
}

function formatMiB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

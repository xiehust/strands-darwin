import process from 'node:process';

import type { RuntimeOptions } from '../../src/agent/runtime.js';
import { parseCliArgs } from '../../src/cli-args.js';
import {
  productionHeadlessDependencies,
  runHeadlessProcess,
} from '../../src/headless-runner.js';

const fixtureUrl = process.env['DARWIN_HEADLESS_RUNTIME_FIXTURE'];
if (fixtureUrl === undefined) throw new Error('DARWIN_HEADLESS_RUNTIME_FIXTURE is required');
const fixture = await import(fixtureUrl) as {
  createRuntime(options: RuntimeOptions): ReturnType<typeof productionHeadlessDependencies.createRuntime>;
};
const options = parseCliArgs(process.argv.slice(2));
if (options.prompt === undefined) throw new Error('fixture driver requires -p/--print');
await runHeadlessProcess({ ...options, prompt: options.prompt }, {
  ...productionHeadlessDependencies,
  createRuntime: fixture.createRuntime,
  // A fixture process has no provider socket to guard against; keep exact ordering
  // observable without installing the production fallback timer.
  forceExitIfHung: () => undefined,
});

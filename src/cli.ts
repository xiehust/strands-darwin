#!/usr/bin/env node
/**
 * `darwin` entry point: one preflight, then the program.
 *
 * This module's static imports must never reach `@strands-agents/sdk`. ESM links the
 * whole static import graph before it runs a single statement of the entry module, so
 * on an SDK without darwin's pinned patch a static import of `./cli-main.js` would die
 * at link time with the raw `does not provide an export named
 * 'DEFAULT_SUMMARIZATION_PROMPT'` — no code of ours would get to explain it. Hence the
 * shape here: check the installed SDK's marker files (`sdk-patch-preflight.ts`, node
 * built-ins plus `version.ts` only), print one bounded refusal and exit nonzero if
 * they are unpatched, and only then `import()` the rest. `spike/verify-npm-patch-format.ts`
 * pins the import graph; `spike/verify-npm-package.ts` runs the real `--ignore-scripts`
 * install against it.
 *
 * Routing, every command and the usage grammar live in `cli-main.ts` / `cli-usage.ts`.
 */
import process from 'node:process';

import { SDK_PATCH_PREFLIGHT_EXIT_CODE, sdkPatchPreflight } from './sdk-patch-preflight.js';

const refusal = sdkPatchPreflight();
if (refusal !== undefined) {
  process.stderr.write(refusal);
  process.exitCode = SDK_PATCH_PREFLIGHT_EXIT_CODE;
} else {
  const { main } = await import('./cli-main.js');
  await main();
}

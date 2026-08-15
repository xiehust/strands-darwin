/** Shared helpers for the spike scripts. */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-west-2';

/**
 * Cross-region inference profile. `us.` and `global.` prefixed profiles are what
 * this account has access to; a bare `anthropic.*` model id is rejected.
 */
export const MODEL_ID = process.env.SPIKE_MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

let passed = 0;
let failed = 0;

/**
 * Repoints HOME at a temp directory this process owns, and returns it.
 *
 * Mandatory for any suite that writes user-global state. `configPath()` ignores
 * its project argument and always resolves `~/.darwin/config.json`, so a suite
 * that writes a fixture through it overwrites the developer's real configuration
 * — including with deliberately invalid fixtures, which then stop darwin from
 * starting at all. `run-tests.ts` hands each suite a private HOME, but suites are
 * also documented to run standalone, so the isolation has to live in the suite.
 *
 * Call it before deriving any global path. It fails immediately if the platform
 * did not honour the change, because silently writing the real home is the exact
 * outcome this exists to prevent. Cleanup runs on process exit, so a failed
 * assertion cannot leave the temp home behind or a dangling HOME pointing at it.
 */
export function ownPrivateHome(label: string): string {
  const original = process.env['HOME'];
  const owned = mkdtempSync(path.join(os.tmpdir(), `darwin-${label}-home-`));
  process.env['HOME'] = owned;
  if (os.homedir() !== owned) {
    process.env['HOME'] = original ?? '';
    rmSync(owned, { recursive: true, force: true });
    throw new Error(`HOME could not be redirected to ${owned}; refusing to write the real ~/.darwin.`);
  }
  process.on('exit', () => {
    if (original === undefined) delete process.env['HOME'];
    else process.env['HOME'] = original;
    rmSync(owned, { recursive: true, force: true });
  });
  return owned;
}

export function header(title: string): void {
  console.log(`\n=== ${title} ===`);
}

export function assert(what: string, ok: boolean): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${what}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${what}`);
  }
}

/** Prints the tally and exits non-zero if anything failed, so the run is verifiable. */
export function report(): void {
  console.log(`\n--- ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exitCode = 1;
}

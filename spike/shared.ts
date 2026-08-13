/** Shared helpers for the spike scripts. */

export const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-west-2';

/**
 * Cross-region inference profile. `us.` and `global.` prefixed profiles are what
 * this account has access to; a bare `anthropic.*` model id is rejected.
 */
export const MODEL_ID = process.env.SPIKE_MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

let passed = 0;
let failed = 0;

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

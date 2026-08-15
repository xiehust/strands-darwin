/**
 * Pure presentation for `/context`: how big the conversation has grown and how
 * much of the model's window it occupies.
 *
 * Numbers are always called estimates — the count is the SDK's character
 * heuristic, not a billing figure — and an unknown window is said out loud
 * rather than silently divided against a guessed limit.
 */
import type { ContextEstimate } from '../agent/runtime.js';

/** One transcript line: tokens, window share, and message count. */
export function formatContextReport(estimate: ContextEstimate): string {
  const tokens = `~${groupDigits(estimate.estimatedTokens)} tokens`;
  const window =
    estimate.windowTokens === undefined
      ? 'window unknown'
      : `${formatWindowShare(estimate.estimatedTokens, estimate.windowTokens)} of ${groupDigits(estimate.windowTokens)} window`;
  return `estimated context — ${tokens} · ${window} · ${estimate.messageCount} message(s)`;
}

/**
 * Integer percent, except that a nonzero share below 1% shows `<1%`: rounding a
 * young conversation to `0%` would claim the context is empty when it is not.
 */
export function formatWindowShare(tokens: number, windowTokens: number): string {
  if (windowTokens <= 0) return 'share unknown';
  const percent = (tokens / windowTokens) * 100;
  if (percent > 0 && percent < 1) return '<1%';
  return `${Math.round(percent)}%`;
}

/**
 * A stateful latch for the context-pressure warning: fires once when the
 * estimated share crosses `warnRatio`, re-arms only after the share drops below
 * it again (e.g. after a successful `/compact`).
 *
 * Returned as a plain object so the caller (App.tsx) can hold it in a ref:
 * the latch must not reset between renders, and it must never fire when
 * `warnRatio` is 0 or the window is unknown.
 */
export interface ContextWarnLatch {
  /** Returns a notice string when the threshold is newly crossed, or null. */
  check(estimate: ContextEstimate, warnRatio: number): string | null;
}

export function createContextWarnLatch(): ContextWarnLatch {
  let aboveThreshold = false;
  return {
    check(estimate: ContextEstimate, warnRatio: number): string | null {
      if (warnRatio <= 0 || estimate.windowTokens === undefined || estimate.windowTokens <= 0) {
        return null;
      }
      const share = estimate.estimatedTokens / estimate.windowTokens;
      if (share >= warnRatio) {
        if (aboveThreshold) return null;   // already warned; don't repeat
        aboveThreshold = true;
        const pct = Math.round(share * 100);
        return `context is ~${pct}% of the model window — /compact can shrink it`;
      }
      aboveThreshold = false;              // re-arm after dropping below
      return null;
    },
  };
}

/** Explicit locale: the report should read the same on every machine. */
function groupDigits(value: number): string {
  return value.toLocaleString('en-US');
}

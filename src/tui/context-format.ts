/**
 * Pure presentation for `/context`: how big the conversation has grown and how
 * much of the model's window it occupies.
 *
 * Numbers are request-size estimates, not billing figures. When the runtime has a
 * measurement anchor — the prompt-token total the provider reported for the most
 * recent completed model call — the line says so and names the measured base plus
 * the estimated tail, because "measured 126,900 + ~1,531 new" and "~128,431" are
 * different claims and only one of them is what happened. Without an anchor the line
 * is the pre-anchor wording, unchanged: a whole-request character heuristic.
 * An unknown window is said out loud rather than silently guessed.
 */
import type { ContextEstimate } from '../agent/runtime.js';

/** One transcript line: tokens, window share, and message count. */
export function formatContextReport(estimate: ContextEstimate): string {
  const label = estimate.measuredTokens === undefined ? 'estimated context' : 'context';
  return `${label} — ${formatContextValue(estimate)}`;
}

/**
 * The value half of the report, without the label — shared with `/status` so the
 * two commands cannot describe the same estimate differently (the `/export`
 * reuses-`formatReplay` precedent, at line scale).
 */
export function formatContextValue(estimate: ContextEstimate): string {
  const tokens = `~${groupDigits(estimate.estimatedTokens)} tokens${formatBasis(estimate)}`;
  const window =
    estimate.windowTokens === undefined
      ? 'window unknown'
      : `${formatWindowShare(estimate.estimatedTokens, estimate.windowTokens)} of ${groupDigits(estimate.windowTokens)} window`;
  return `${tokens} · ${window} · ${estimate.messageCount} message(s)`;
}

/**
 * How the total was arrived at, when part of it was measured: `(measured M + ~T new)`,
 * or `(measured M + tail unknown)` when counting the appended messages failed. Empty
 * when there is no measurement — an absent metric is absent, never rendered as 0.
 */
function formatBasis(estimate: ContextEstimate): string {
  if (estimate.measuredTokens === undefined) return '';
  const tail =
    estimate.tailTokens === undefined ? 'tail unknown' : `~${groupDigits(estimate.tailTokens)} new`;
  return ` (measured ${groupDigits(estimate.measuredTokens)} + ${tail})`;
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
 * A stateful latch for the context-pressure notice: fires once when the
 * estimated share crosses the existing configurable `warnRatio`, re-arms only
 * after a known share drops below it again (e.g. after a successful user-run
 * `/compact`). There is deliberately no second SRF-010 threshold: one pressure
 * event gets one notice, and `contextWarnRatio: 0` remains the compatibility
 * switch that disables it.
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
      if (
        warnRatio <= 0 ||
        !Number.isFinite(estimate.estimatedTokens) ||
        estimate.estimatedTokens < 0 ||
        estimate.windowTokens === undefined ||
        !Number.isFinite(estimate.windowTokens) ||
        estimate.windowTokens <= 0
      ) {
        return null;
      }
      const share = estimate.estimatedTokens / estimate.windowTokens;
      if (share >= warnRatio) {
        if (aboveThreshold) return null;   // already warned; don't repeat
        aboveThreshold = true;
        const pct = Math.round(share * 100);
        return (
          `context pressure is high (~${pct}% of the model window) — consider /compact before ` +
          'the next broad implementation or verification turn'
        );
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

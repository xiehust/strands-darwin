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

/** Explicit locale: the report should read the same on every machine. */
function groupDigits(value: number): string {
  return value.toLocaleString('en-US');
}

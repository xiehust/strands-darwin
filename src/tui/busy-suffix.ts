/**
 * The busy rows' live suffix: elapsed turn time and the session's reported token spend.
 *
 * A pure projection for the `working…` hint and the `thinking…` row (SER-022). It rides
 * rows that already exist and are drawn as one `<Text wrap="truncate-end">` each, so it can
 * never add a frame row or a wrap — which is why the suffix goes directly behind the busy
 * word, ahead of the static command hints: on a narrow terminal the tail is what truncates,
 * and the tail should be the part that never changes.
 *
 * Honesty follows the `usageBuckets` rule: an unknown metric (`input === undefined` on
 * OpenAI Responses without cache detail) is absent from the suffix, never rendered as 0,
 * while a genuinely zero accumulator renders `↑0 ↓0` — the same measured nothing `/usage`
 * prints before the first turn. The numbers are whatever the meter has actually been told:
 * the SDK accumulates a model call when it finishes, so mid-call the totals lag on purpose.
 */
import type { UsageBuckets } from '../agent/usage.js';
import { describeRetryWait, type RetryWaitState } from '../agent/model-retry.js';
import { formatTaskDuration } from './task-format.js';

/**
 * Compact token count for a one-row readout: `318`, `1.2k`, `999.9k`, `2M`.
 *
 * Integer arithmetic throughout — `2900 / 1000 * 10` floors to 28 in floating point —
 * and always floored, never rounded, so a count can never read as the next unit up.
 * A negative or non-finite input degrades to `0` rather than `NaN` on screen.
 */
export function formatTokenCount(count: number): string {
  const safe = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (safe < 1_000) return String(safe);
  const [unit, symbol] = safe < 1_000_000 ? [1_000, 'k'] : [1_000_000, 'M'];
  const tenths = Math.floor((safe * 10) / unit);
  const whole = Math.floor(tenths / 10);
  const fraction = tenths % 10;
  return fraction === 0 ? `${whole}${symbol}` : `${whole}.${fraction}${symbol}`;
}

/**
 * ` · 12s · ↑1.2k ↓318 tokens` — or less, when a metric is unknown — plus
 * ` · throttled, retry 3/6 in 12s` while a model-retry wait is pending (SER-067).
 *
 * `spend === undefined` (the meter could not be read, or the row wants the reduced
 * elapsed-only form) keeps just the duration; an undefined input bucket drops only the
 * `↑` part. Output is always a number in {@link UsageBuckets}, so `↓` is always stated
 * when spend is. The retry phrase is the runtime's published wait state read on the same
 * tick (`retryWait()`), rendered through the one shared {@link describeRetryWait}; with no
 * wait (`undefined`) the suffix is byte-identical to what it was before the phrase existed.
 */
export function busySuffix(
  elapsedMs: number,
  spend: UsageBuckets | undefined,
  retryWait?: RetryWaitState,
  nowMs: number = Date.now(),
): string {
  const elapsed = ` · ${formatTaskDuration(elapsedMs)}`;
  const retry = retryWait === undefined ? '' : ` · ${describeRetryWait(retryWait, nowMs)}`;
  if (spend === undefined) return `${elapsed}${retry}`;
  const input = spend.input === undefined ? '' : `↑${formatTokenCount(spend.input)} `;
  return `${elapsed} · ${input}↓${formatTokenCount(spend.output)} tokens${retry}`;
}

/**
 * The repeated-long-context spend advisory (issue #8 follow-up A): one bounded
 * transcript notice when cumulative cache reads keep climbing while recent model
 * rounds each bought at most one tool call — the pattern where every round trip
 * re-reads a huge cached prompt to do one small thing, and where batching edits,
 * parallelizing independent reads, or `/compact` would genuinely help.
 *
 * Built on the context-pressure precedent (`context-format.ts`): a pure decision
 * function held in an App ref, checked post-turn only, advising and never acting,
 * silent whenever a metric is unknown, and rendered as an ordinary `<Static>`
 * notice — no new live-frame row, no timer, no second channel.
 *
 * One deliberate difference from the context latch: cache reads are a lifetime
 * accumulator, so "re-arm after a drop" cannot apply. The latch is a monotonic
 * counter of the highest threshold multiple already announced — each crossed
 * multiple of `cacheReadWarnTokens` may fire once, and a crossing whose pattern
 * gate fails stays eligible until the pattern shows up (or the next multiple
 * subsumes it). `/clear` resets it with the session, like every per-session latch.
 */

/**
 * How many recent completed calls the pattern gate examines — the same window
 * `call-stats.ts` keeps (`RECENT_CALL_WINDOW`), restated here so this module needs
 * nothing from `src/agent/**`.
 */
export const SPEND_ADVISORY_WINDOW = 10;

/**
 * How many of the windowed calls must have run ≤1 tool for the pattern to count.
 * Eight of ten: an occasional parallel round does not acquit a session that is
 * otherwise paying full context for single tool calls.
 */
export const SPEND_ADVISORY_LOW_TOOL_CALLS = 8;

/** What one post-turn check reads. Every unknown input keeps the advisory silent. */
export interface SpendAdvisoryInput {
  /** Cumulative parent `cacheReadInputTokens`; `undefined` until the provider reports it. */
  cacheReadTokens: number | undefined;
  /**
   * toolUse counts of the recent completed calls (`callStats.recentToolUseCounts`);
   * `undefined` when no stats exist — a session that never called the model.
   */
  recentToolUseCounts: readonly number[] | undefined;
  /** `config.cacheReadWarnTokens`; 0 (or anything non-positive) disables. */
  warnTokens: number;
}

/**
 * Held in an App ref, like `ContextWarnLatch`: the counter must survive renders
 * and reset only with the session.
 */
export interface SpendAdvisoryLatch {
  /** Returns a notice string when a new multiple is crossed with the pattern present, or null. */
  check(input: SpendAdvisoryInput): string | null;
}

export function createSpendAdvisoryLatch(): SpendAdvisoryLatch {
  // Highest multiple of warnTokens already announced; monotonic on purpose —
  // cacheRead never goes backwards, so neither does this.
  let announced = 0;
  return {
    check(input: SpendAdvisoryInput): string | null {
      const warn = input.warnTokens;
      if (!Number.isFinite(warn) || warn <= 0) return null;
      const read = input.cacheReadTokens;
      if (typeof read !== 'number' || !Number.isFinite(read) || read < 0) return null;

      const multiple = Math.floor(read / warn);
      if (multiple <= announced) return null;

      // The pattern gate. Not advancing `announced` on failure is deliberate: the
      // crossing stays eligible, and fires on the first later turn whose recent
      // rounds really do show the single-tool shape.
      const counts = input.recentToolUseCounts;
      if (counts === undefined) return null;
      const window = counts.slice(-SPEND_ADVISORY_WINDOW);
      const low = window.filter(
        (count) => typeof count === 'number' && Number.isFinite(count) && count <= 1,
      ).length;
      if (low < SPEND_ADVISORY_LOW_TOOL_CALLS) return null;

      announced = multiple;
      return (
        `cache reads passed ~${(multiple * warn).toLocaleString('en-US')} tokens and ` +
        `${low} of the last ${window.length} model calls ran at most one tool — ` +
        'consider consolidating edits, batching independent reads in parallel, and /compact'
      );
    },
  };
}

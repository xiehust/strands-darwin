/**
 * Session-scoped per-model-call efficiency stats (issue #8 follow-up A).
 *
 * `AgentRuntime.send` already forwards every `afterModelCallEvent`; this module is
 * the pure arithmetic over what those events carry — `stopData.message.metadata.usage`
 * (the provider's counters for that one call) and `stopData.message.content` (whose
 * toolUse blocks say how much work one round trip bought). Everything here is
 * synchronous, allocation-only and non-throwing by construction: the runtime observes
 * between `stream()` and `yield`, so a broken tally must degrade to absence, never
 * become a second reason a turn dies.
 *
 * Parent-only by the same construction the trajectory relies on: child agents are
 * private to their dispatch and never pass through `AgentRuntime.send`, so no child
 * call can reach these counters (children are covered by the 9e39de5 childUsage
 * aggregation instead). Session-scoped for free: `/clear` builds a successor runtime
 * through `create()`, whose stats start empty.
 */
import type { AppConfig } from '../config.js';
import { formatUsageValue, sumUsage, usageBuckets, type UsageTotals } from './usage.js';

/**
 * How many recent completed calls the advisory window keeps. Ten is enough to see
 * the "repeated long-context single-tool round" pattern without remembering a
 * session's whole history.
 */
export const RECENT_CALL_WINDOW = 10;

/** What one session's completed model calls added up to, so far. */
export interface SessionCallStats {
  /** Completed model calls observed (`afterModelCallEvent` with `stopData`). */
  calls: number;
  /**
   * Calls whose provider reported usage — the denominator for per-call averages.
   * Kept separately from {@link calls} so an unmetered call can never dilute an
   * average into a number nobody measured.
   */
  meteredCalls: number;
  /**
   * Raw provider counters summed over the metered calls, `sumUsage` rules: a cache
   * key is present only when at least one call reported it, so an unknown metric
   * stays absent — never an invented 0. `undefined` until any call reports usage.
   */
  usage: UsageTotals | undefined;
  /** Completed responses that requested no tool. */
  noTool: number;
  /** Completed responses that requested exactly one tool. */
  singleTool: number;
  /** Completed responses that requested two or more tools (parallel reads, ideally). */
  multiTool: number;
  /**
   * toolUse counts of the last {@link RECENT_CALL_WINDOW} completed calls, oldest
   * first — the advisory's evidence for "recent rounds each bought ≤1 tool".
   */
  recentToolUseCounts: readonly number[];
}

/** The zero state a session starts from. All-zero is honest here: nothing happened yet. */
export function emptyCallStats(): SessionCallStats {
  return {
    calls: 0,
    meteredCalls: 0,
    usage: undefined,
    noTool: 0,
    singleTool: 0,
    multiTool: 0,
    recentToolUseCounts: [],
  };
}

/**
 * The two facts one completed call contributes, in the shape
 * `afterModelCallEvent.stopData.message` carries them. Typed structurally and read
 * defensively so the update stays a pure function over data — no SDK import, and a
 * malformed payload costs that call's contribution, not the session's counters.
 */
export interface CompletedModelCall {
  message?: {
    /** `metadata.usage`: the provider's counters for this one call, when reported. */
    metadata?: { usage?: unknown };
    /** The completed message's content blocks, for the tool-shape tallies. */
    content?: unknown;
  };
}

/**
 * Folds one completed model call into the stats. Pure: returns a new value and
 * touches neither argument, so a caller can hold snapshots without copying.
 *
 * A call with no usable usage still counts as a call and still shapes the tool
 * tallies — the response happened whether or not the provider priced it — but adds
 * nothing to the sums ({@link SessionCallStats.meteredCalls} keeps the averages
 * honest about that).
 */
export function recordCompletedCall(
  stats: SessionCallStats,
  call: CompletedModelCall,
): SessionCallStats {
  const usage = usableUsage(call.message?.metadata?.usage);
  const toolUses = countToolUses(call.message?.content);
  return {
    calls: stats.calls + 1,
    meteredCalls: stats.meteredCalls + (usage === undefined ? 0 : 1),
    usage:
      usage === undefined
        ? stats.usage
        : stats.usage === undefined
          ? usage
          : sumUsage([stats.usage, usage]),
    noTool: stats.noTool + (toolUses === 0 ? 1 : 0),
    singleTool: stats.singleTool + (toolUses === 1 ? 1 : 0),
    multiTool: stats.multiTool + (toolUses >= 2 ? 1 : 0),
    recentToolUseCounts: [...stats.recentToolUseCounts, toolUses].slice(-RECENT_CALL_WINDOW),
  };
}

/**
 * toolUse blocks in one completed message's content.
 *
 * Matched on both shapes the payload legitimately has: the in-memory
 * `type: 'toolUseBlock'` class discriminator (what the live stream carries) and the
 * serialized `{ toolUse: … }` wire shape (`ToolUseBlock.toJSON()` drops the
 * discriminator, exactly as `record.ts` documents for reasoning blocks). Anything
 * else — including a non-array `content` — counts zero tools rather than throwing.
 */
export function countToolUses(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const candidate = block as { type?: unknown; toolUse?: unknown };
    if (candidate.type === 'toolUseBlock' || (candidate.type === undefined && candidate.toolUse !== undefined)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Average request input per metered call, in tokens — how big the submitted context
 * has been running, which is the number the efficiency question is really about.
 *
 * The request total follows the `cacheEffectivenessRows` convention over the same
 * `usageBuckets` projection: OpenAI Responses reports cache activity as subsets of
 * `input_tokens`, so its input *is* the request total; every other provider reports
 * cache reads/writes beside uncached input, so the request is their sum, with an
 * unreported cache counter contributing nothing rather than blocking the average.
 * `undefined` when no call was metered or the buckets cannot split honestly —
 * unknown, never 0.
 */
export function averageRequestInputTokens(
  stats: SessionCallStats,
  config: AppConfig,
): number | undefined {
  if (stats.usage === undefined || stats.meteredCalls <= 0) return undefined;
  const buckets = usageBuckets(stats.usage, config);
  const submitted =
    config.provider === 'openai' && config.openaiApi === 'responses'
      ? stats.usage.inputTokens
      : buckets.input === undefined
        ? undefined
        : buckets.input + (buckets.cacheRead ?? 0) + (buckets.cacheWrite ?? 0);
  if (submitted === undefined) return undefined;
  return Math.round(submitted / stats.meteredCalls);
}

/**
 * The one-line reading `/status` prints — shared here so `/status`, `/usage`'s
 * efficiency section and any future surface derive the same numbers from the same
 * arithmetic and cannot drift. An unknown average reads `not reported`
 * ({@link formatUsageValue}), never 0.
 */
export function describeCallEfficiency(stats: SessionCallStats, config: AppConfig): string {
  const average = formatUsageValue(averageRequestInputTokens(stats, config));
  return (
    `${stats.calls} completed · avg request input ${average} · ` +
    `tool responses ${stats.singleTool} single / ${stats.multiTool} multi / ${stats.noTool} none`
  );
}

/** One call's provider counters as `UsageTotals`, or `undefined` when unusable. */
function usableUsage(value: unknown): UsageTotals | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const { inputTokens, outputTokens, cacheReadInputTokens, cacheWriteInputTokens } = value as Record<
    string,
    unknown
  >;
  const input = finite(inputTokens);
  const output = finite(outputTokens);
  // input/output are always reported by every provider the SDK supports; a payload
  // missing either is not a measurement and contributes nothing.
  if (input === undefined || output === undefined) return undefined;
  const read = finite(cacheReadInputTokens);
  const write = finite(cacheWriteInputTokens);
  return {
    inputTokens: input,
    outputTokens: output,
    ...(read === undefined ? {} : { cacheReadInputTokens: read }),
    ...(write === undefined ? {} : { cacheWriteInputTokens: write }),
  };
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

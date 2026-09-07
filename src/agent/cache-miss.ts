/**
 * Why the prompt cache missed (SER-074): a derivation over facts darwin already
 * holds, never a new measurement.
 *
 * `/usage` and `/status` have always shown cache read/write counts and a hit ratio,
 * but a number alone does not say why a call re-read the conversation uncached.
 * Every input needed to name a likely cause is already in the runtime: the per-call
 * provider counters `observeCallStats` folds (`afterModelCallEvent`
 * `stopData.message.metadata.usage`), the cache-invalidating events the session
 * itself performed (`/model`, `/effort`, `/compact`), the configured TTL
 * (`promptCacheTtl`: `5m` default, `1h`), the wall clock, and whether the session
 * was resumed. This module is the pure arithmetic over those facts; the runtime
 * feeds it through {@link CacheMissTracker} with the same synchronous,
 * non-throwing, latch-on-failure discipline the call stats observe under.
 *
 * Advisory only, on the context-pressure row's terms: the verdict is printed on
 * existing reports (`/usage`, `/status`) and as one transcript notice before a
 * `/model` or `/effort` switch on a warm cache. Nothing is compacted, no second
 * threshold exists, no frame row, tick or channel is added, nothing is persisted or
 * recorded in the trajectory.
 *
 * Invalidators, and one deliberate non-invalidator. A model switch, an effective
 * effort change and a compaction each change the request prefix (a different model
 * keys a different cache; `output_config.effort` is part of the request; compaction
 * rewrites the messages), and idling past the TTL lets the entries expire. `/rewind`
 * is not marked: it restores an earlier prefix of the same conversation, whose cache
 * entries are still valid if they have not expired — the same rule Claude Code's
 * prompt-caching documentation states. File edits, permission-mode changes and skill
 * loads change no cached section either.
 *
 * Claude-only by the gate `prompt-cache.ts` explains: OpenAI caches automatically
 * at the provider with no darwin-placed cache points, so its counters describe a
 * cache darwin did not configure — the tracker stays silent unless the live plan
 * has Darwin-managed cache points.
 */
import type { PromptCacheTtl } from './prompt-cache.js';

/** The one bounded verdict per missed call, in precedence order. */
export type CacheMissCause =
  | 'model switched'
  | 'effort changed'
  | 'compacted'
  | 'idle past cache TTL'
  | 'first request of a resumed session'
  | 'unknown';

/** Session events that invalidate the prefix a cache read depends on. */
export type CacheInvalidatingEvent = 'model' | 'effort' | 'compact';

/**
 * A call reading less than this share of its own request total from the cache is a
 * miss. A warm call on a long conversation reads nearly all of it (the last user
 * message is the only uncached part); one fifth leaves room for a large tool result
 * or user message without calling an ordinary turn a miss.
 */
export const CACHE_MISS_READ_FRACTION = 0.2;

/** Both providers' default cache lifetime when `promptCacheTtl` is not set. */
const DEFAULT_TTL: PromptCacheTtl = '5m';

/** One completed call's cache facts, as the tracker needs them. */
export interface CacheCallFacts {
  /** When the call completed (epoch ms). */
  at: number;
  /** Tokens read from the cache, or undefined when the provider did not report it. */
  cacheRead: number | undefined;
  /** The request total (`requestInputTokens`: input + cache read + cache write), or undefined. */
  requestInput: number | undefined;
}

export interface CacheMissInput {
  /** The previous completed call, or undefined when this is the session's first. */
  previous: CacheCallFacts | undefined;
  current: CacheCallFacts;
  /** Invalidating events the session performed since {@link previous} completed. */
  events: ReadonlySet<CacheInvalidatingEvent>;
  ttlMs: number;
  /** True for the first call of a resumed session, whose cache the previous run wrote. */
  firstCallAfterResume: boolean;
}

/** The TTL in milliseconds; an unset TTL is the providers' `5m` default. */
export function promptCacheTtlMs(ttl: PromptCacheTtl | undefined): number {
  return (ttl ?? DEFAULT_TTL) === '1h' ? 3_600_000 : 300_000;
}

/**
 * True when a call read less than {@link CACHE_MISS_READ_FRACTION} of its request
 * from the cache. Unreported counters and an empty request are not misses: they are
 * unknown, and unknown is never a verdict.
 */
export function isCacheMiss(call: CacheCallFacts): boolean {
  if (call.cacheRead === undefined || call.requestInput === undefined) return false;
  if (!Number.isFinite(call.cacheRead) || !Number.isFinite(call.requestInput) || call.requestInput <= 0) return false;
  return call.cacheRead < call.requestInput * CACHE_MISS_READ_FRACTION;
}

/**
 * The likely cause of the current call's cache miss, or `undefined` for no verdict.
 *
 * No verdict when the current call's counters are unreported, when it is not a miss,
 * when it is a fresh session's first call (expected cold: nothing has been written
 * yet), or when the previous call was itself cold — a miss is only a miss relative
 * to a cache that was demonstrably warm. When several causes apply, the one that
 * certainly invalidated the prefix wins over the one that merely could have:
 * `model switched` > `effort changed` > `compacted` > `idle past cache TTL` >
 * `first request of a resumed session` > `unknown`.
 */
export function cacheMissCause(input: CacheMissInput): CacheMissCause | undefined {
  const { previous, current, events, ttlMs, firstCallAfterResume } = input;
  if (!isCacheMiss(current)) return undefined;
  if (previous === undefined) {
    if (!firstCallAfterResume) return undefined;
  } else if (previous.cacheRead === undefined || !(previous.cacheRead > 0)) {
    return undefined;
  }

  if (events.has('model')) return 'model switched';
  if (events.has('effort')) return 'effort changed';
  if (events.has('compact')) return 'compacted';
  if (previous !== undefined && current.at - previous.at > ttlMs) return 'idle past cache TTL';
  if (firstCallAfterResume) return 'first request of a resumed session';
  return 'unknown';
}

/** The cause as `/usage` and `/status` print it; the TTL cause names the configured TTL. */
export function describeCacheMissCause(cause: CacheMissCause, ttl: PromptCacheTtl | undefined): string {
  return cause === 'idle past cache TTL' ? `${cause} (${ttl ?? DEFAULT_TTL})` : cause;
}

/** What the reports read: the last observed miss, and how many there were. */
export interface CacheMissReport {
  lastMiss: { cause: CacheMissCause; at: number; cacheRead: number; requestInput: number } | undefined;
  misses: number;
}

/** Whether the last completed call's cache entries are still readable. */
export interface CacheWarmth {
  /** True iff the last completed call read from the cache and finished less than the TTL ago. */
  warm: boolean;
  /** Milliseconds since the last completed call. */
  ageMs: number;
  /** What that call read from the cache. */
  lastCacheRead: number;
}

/**
 * The one bounded notice `/model <target>` and `/effort <level>` print before a
 * switch on a warm cache — `undefined` when the cache is cold or nothing is known,
 * so a cold switch prints nothing new. States the cost and lets the switch proceed;
 * deliberately not a confirmation dialog.
 */
export function warmCacheSwitchNotice(kind: 'model' | 'effort', warmth: CacheWarmth | undefined): string | undefined {
  if (warmth === undefined || !warmth.warm) return undefined;
  return (
    `cache is warm (${formatWarmthAge(warmth.ageMs)} ago, ${warmth.lastCacheRead.toLocaleString('en-US')} tokens read last call): ` +
    `switching ${kind} re-reads the conversation uncached`
  );
}

/** `12s`, `3m 12s`, `1h 2m` — the `/tasks` duration vocabulary, without a TUI import. */
function formatWarmthAge(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * The per-runtime state behind {@link CacheMissReport} and {@link CacheWarmth}.
 *
 * Pure over what it is handed: the runtime passes each completed call's facts and
 * the clock, marks the events it performed, and reads the two projections. Nothing
 * here throws on ordinary data; the runtime wraps the calls in the observer latch
 * anyway, so a surprise degrades to absence rather than to a dead turn. `/clear`'s
 * successor runtime builds a new tracker, which is how the state stays session-scoped.
 */
export class CacheMissTracker {
  private previous: CacheCallFacts | undefined = undefined;
  private readonly events = new Set<CacheInvalidatingEvent>();
  private lastMiss: CacheMissReport['lastMiss'] = undefined;
  private misses = 0;
  private firstCallAfterResume: boolean;

  /**
   * @param ttlMs the live TTL, read per call because `promptCacheTtl` is a model
   *   field and `/model` can change it mid-session.
   */
  constructor(
    private readonly ttlMs: () => number,
    resumed: boolean,
  ) {
    this.firstCallAfterResume = resumed;
  }

  /** Records that the session performed one invalidating event since the last call. */
  mark(event: CacheInvalidatingEvent): void {
    this.events.add(event);
  }

  /** Folds one completed call in; returns the verdict for that call, if any. */
  observe(call: CacheCallFacts): CacheMissCause | undefined {
    const cause = cacheMissCause({
      previous: this.previous,
      current: call,
      events: this.events,
      ttlMs: this.ttlMs(),
      firstCallAfterResume: this.firstCallAfterResume,
    });
    if (cause !== undefined && call.cacheRead !== undefined && call.requestInput !== undefined) {
      this.misses += 1;
      this.lastMiss = { cause, at: call.at, cacheRead: call.cacheRead, requestInput: call.requestInput };
    }
    // Every completed call closes the "since last call" window and settles the
    // resume question, verdict or not: the events have had their effect on this
    // request whether or not the counters let us see it.
    this.previous = call;
    this.events.clear();
    this.firstCallAfterResume = false;
    return cause;
  }

  report(): CacheMissReport {
    return { lastMiss: this.lastMiss, misses: this.misses };
  }

  /** `undefined` until a call has completed. */
  warmth(now: number): CacheWarmth | undefined {
    if (this.previous === undefined) return undefined;
    const lastCacheRead = this.previous.cacheRead ?? 0;
    const ageMs = Math.max(0, now - this.previous.at);
    return { warm: lastCacheRead > 0 && ageMs < this.ttlMs(), ageMs, lastCacheRead };
  }
}

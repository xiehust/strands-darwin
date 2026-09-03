/**
 * SER-061: the one ceiling on concurrently running child dispatches, shared by
 * the `subagent` and `workflow` tools.
 *
 * The count is the existing {@link SubagentDispatchRegistry}'s `running`
 * records — no second ledger, no new state. A refused call throws before any
 * model, dispatch record or child exists, so the SDK turns it into an ordinary
 * tool error result the model reads; the message tells it not to retry until a
 * running dispatch settles, because settlement (the registry's terminal
 * transition) is the only thing that frees a slot.
 */
import { DEFAULT_MAX_CONCURRENT_SUBAGENTS, type AppConfig } from '../config.js';

/**
 * The effective cap for one config snapshot. `loadConfig` always populates a
 * positive integer; the fallback covers fixtures that build a partial config.
 */
export function concurrencyCap(config: AppConfig): number {
  const value = config.maxConcurrentSubagents;
  return value !== undefined && Number.isSafeInteger(value) && value >= 1
    ? value
    : DEFAULT_MAX_CONCURRENT_SUBAGENTS;
}

/**
 * One fixed message shape for both tools. `requested` is the number of slots
 * the call needs (1 for `subagent`, the effective parallelism for `workflow`);
 * anything above one adds a clause naming it and the free slots.
 */
export function concurrencyLimitMessage(cap: number, running: number, requested = 1): string {
  const free = Math.max(0, cap - running);
  // A single-slot refusal only happens at the cap, where "N of N" already says
  // everything; a multi-slot one names what it needs against what is free.
  const need = requested > 1
    ? ` This call needs ${requested} slots; ${free} ${free === 1 ? 'is' : 'are'} free.`
    : '';
  return (
    `Concurrent subagent limit reached: ${running} of ${cap} dispatches running.${need} ` +
    'Do not retry until one settles; wait for its result instead.'
  );
}

/** The clause both tool descriptions carry so the model knows a ceiling exists. */
export function concurrencyDescriptionClause(cap: number): string {
  return (
    `At most ${cap} child dispatches run at once (config maxConcurrentSubagents); ` +
    'a call over the limit fails and must wait for a running dispatch to settle.'
  );
}

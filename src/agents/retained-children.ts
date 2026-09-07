/**
 * SER-075: the bounded store behind `subagent continue=<dispatch id>`.
 *
 * A settled child's *conversation* is what carries its context, so that is all
 * that is kept: a deep copy of the child `Agent.messages` array (the SDK exposes
 * it as `messages: Message[]` — "The conversation history of messages between
 * user and assistant", `node_modules/@strands-agents/sdk/dist/src/agent/agent.d.ts`),
 * the definition name the child was built from, and its terminal state. The
 * `Agent` object itself and its persistent bash session are **not** retained: the
 * Agent is rebuilt from the copy through the same `buildRecipeChild` recipe (the
 * SDK constructor's `messages?: Message[] | MessageData[]` option, "An initial set
 * of messages to seed the agent's conversation history", same `.d.ts`), and the
 * shell is reaped at settlement exactly as before, so no process outlives a
 * dispatch and a continuation runs with the *current* model, tools and gate.
 *
 * Bounds and exclusions: the last {@link MAX_RETAINED_CHILDREN} settled
 * `subagent` dispatches of one `SubagentTool` (therefore one runtime — `/clear`
 * and `/rewind` build a successor tool, and `shutdown()` clears explicitly),
 * evicted oldest-first. `succeeded` is retained; `failed` only when the
 * conversation ends in a complete assistant message with no `toolUse` still
 * awaiting its result, because a continuation must never start from a broken
 * pair; `cancelled` never. `workflow` nodes never reach this store — they are
 * built by `WorkflowTool`, not `SubagentTool.run`. The store is private to the
 * tool: no dispatch record, `/agents` row or trajectory line ever carries the
 * retained messages.
 */
import type { Message } from '@strands-agents/sdk';

import type { TerminalSubagentDispatchState } from './dispatch-registry.js';

/** Settled dispatches whose conversation stays continuable; the oldest is evicted at the fifth. */
export const MAX_RETAINED_CHILDREN = 4;

/** Ids that were evicted or skipped are remembered so a refusal can say why; bounded too. */
const REMEMBERED_OUTCOMES_LIMIT = 64;

export type RetainedChildState = Exclude<TerminalSubagentDispatchState, 'cancelled'>;

export interface RetainedChild {
  readonly dispatchId: string;
  readonly agentName: string;
  readonly state: RetainedChildState;
  /** Deep copies (`Message.clone()`); callers clone again before seeding an Agent. */
  readonly messages: readonly Message[];
  /** The dispatch this one continued, when it was itself a continuation. */
  readonly continuedFrom?: string;
}

export type RetainOutcome =
  | { readonly retained: true }
  | { readonly retained: false; readonly reason: string };

export type RetainedChildLookup =
  | { readonly kind: 'retained'; readonly entry: RetainedChild }
  /** Was retained, then pushed out by newer settlements. */
  | { readonly kind: 'evicted' }
  /** Settled through this tool but deliberately not retained; `reason` is the refusal clause. */
  | { readonly kind: 'skipped'; readonly reason: string }
  /** Never seen by this store (unknown id, still running, cancelled, or a `workflow` node). */
  | { readonly kind: 'unknown' };

/** The fixed clause for a conversation that did not end in a complete assistant message. */
export const BROKEN_PAIR_REASON =
  'its conversation did not end in a complete assistant message, so a follow-up would extend a broken tool exchange';

/** The fixed clause for a cancelled child. */
export const CANCELLED_REASON = 'cancelled children are not retained';

export class RetainedChildStore {
  /** Insertion-ordered: the first key is the oldest and the next to be evicted. */
  private readonly entries = new Map<string, RetainedChild>();
  /** Bounded memory of ids this store let go or refused, for one honest refusal line. */
  private readonly outcomes = new Map<string, Exclude<RetainedChildLookup, { kind: 'retained' | 'unknown' }>>();

  /**
   * Records one settled dispatch. `cancelled` and broken-pair conversations are
   * skipped (and remembered as skipped); an id already retained is replaced and
   * becomes the newest entry.
   */
  retain(settled: {
    readonly dispatchId: string;
    readonly agentName: string;
    readonly state: TerminalSubagentDispatchState;
    readonly messages: readonly Message[];
    readonly continuedFrom?: string | undefined;
  }): RetainOutcome {
    if (settled.state === 'cancelled') return this.skip(settled.dispatchId, CANCELLED_REASON);
    if (!isContinuableConversation(settled.messages)) return this.skip(settled.dispatchId, BROKEN_PAIR_REASON);

    this.entries.delete(settled.dispatchId);
    this.outcomes.delete(settled.dispatchId);
    this.entries.set(settled.dispatchId, {
      dispatchId: settled.dispatchId,
      agentName: settled.agentName,
      state: settled.state,
      messages: Object.freeze(settled.messages.map((message) => message.clone())),
      ...(settled.continuedFrom === undefined ? {} : { continuedFrom: settled.continuedFrom }),
    });
    while (this.entries.size > MAX_RETAINED_CHILDREN) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.remember(oldest, { kind: 'evicted' });
    }
    return { retained: true };
  }

  lookup(dispatchId: string): RetainedChildLookup {
    const entry = this.entries.get(dispatchId);
    if (entry !== undefined) return { kind: 'retained', entry };
    return this.outcomes.get(dispatchId) ?? { kind: 'unknown' };
  }

  /** Retained ids, oldest first. */
  ids(): string[] {
    return [...this.entries.keys()];
  }

  size(): number {
    return this.entries.size;
  }

  /** Drops every entry and every remembered outcome; nothing is continuable afterwards. */
  clear(): void {
    this.entries.clear();
    this.outcomes.clear();
  }

  private skip(dispatchId: string, reason: string): RetainOutcome {
    this.entries.delete(dispatchId);
    this.remember(dispatchId, { kind: 'skipped', reason });
    return { retained: false, reason };
  }

  private remember(dispatchId: string, outcome: Exclude<RetainedChildLookup, { kind: 'retained' | 'unknown' }>): void {
    this.outcomes.delete(dispatchId);
    this.outcomes.set(dispatchId, outcome);
    while (this.outcomes.size > REMEMBERED_OUTCOMES_LIMIT) {
      const oldest = this.outcomes.keys().next().value;
      if (oldest === undefined) break;
      this.outcomes.delete(oldest);
    }
  }
}

/**
 * A conversation a fresh Agent can be re-invoked on: non-empty, ending in an
 * assistant message that requests no tool, with every `toolUse` anywhere in it
 * answered by a `toolResult` in the following message. The SDK only appends an
 * assistant tool-use message once its results exist, so an unanswered pair
 * means an interrupted stream — the one shape a follow-up must never extend.
 */
export function isContinuableConversation(messages: readonly Message[]): boolean {
  const last = messages[messages.length - 1];
  if (last === undefined || last.role !== 'assistant') return false;
  if (last.content.some((block) => block.type === 'toolUseBlock')) return false;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const uses = message.content.flatMap((block) => (block.type === 'toolUseBlock' ? [block.toolUseId] : []));
    if (uses.length === 0) continue;
    const next = messages[index + 1];
    const answered = new Set(
      next?.content.flatMap((block) => (block.type === 'toolResultBlock' ? [block.toolUseId] : [])) ?? [],
    );
    if (uses.some((toolUseId) => !answered.has(toolUseId))) return false;
  }
  return true;
}

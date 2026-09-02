/**
 * Explicit conversation compaction through the SDK's summarization extension.
 *
 * The runtime owns persistence; this module owns only the reversible message
 * transformation and token accounting, which keeps it testable with a real SDK
 * Agent and a deterministic model.
 */
import type { Agent, Message, Model, SummarizingConversationManagerConfig } from '@strands-agents/sdk';
// `DEFAULT_SUMMARIZATION_PROMPT` reaches the package root only through the pinned
// SDK patch (`patches/@strands-agents__sdk@1.16.0.patch`, `dist/src/index.*`
// hunks): the SDK declares it in a module its `exports` map does not expose.
// Never copy the string here — a copy would drift from what the SDK sends when
// no focus is given.
import { DEFAULT_SUMMARIZATION_PROMPT, SummarizingConversationManager } from '@strands-agents/sdk';

/**
 * `/compact` collapses every reducible old message in one command, leaving one
 * summary plus the recent window. 0.8 is the SDK's maximum ratio and minimizes
 * model calls; overflow recovery uses the configurable `summaryRatio` instead.
 */
export const COMPACT_SUMMARY_RATIO = 0.8;
/** Upper bound on one `/compact <focus>` argument, in code points, after trimming. */
export const MAX_COMPACT_FOCUS_CODE_POINTS = 400;
/**
 * The one fixed section appended after the SDK prompt when a focus is given. The
 * focus is plain text under this heading — never parsed, never a command.
 */
export const COMPACT_FOCUS_HEADING = "User's focus for this summary (keep what it names in detail):";

/**
 * Trims a `/compact` argument; blank text means "no focus". Returns the trimmed
 * text unbounded — {@link compactFocusRefusal} decides whether it may be used.
 */
export function normalizeCompactFocus(text: string | undefined): string | undefined {
  const trimmed = text?.trim() ?? '';
  return trimmed.length === 0 ? undefined : trimmed;
}

/** The notice for a focus over the cap, or undefined when the focus is acceptable. */
export function compactFocusRefusal(focus: string | undefined): string | undefined {
  if (focus === undefined) return undefined;
  const length = [...focus].length;
  if (length <= MAX_COMPACT_FOCUS_CODE_POINTS) return undefined;
  return `/compact focus is too long (${length} code points; cap ${MAX_COMPACT_FOCUS_CODE_POINTS}) — compaction did not run`;
}

/**
 * The summarizer system prompt: the SDK default verbatim, then — only with a
 * focus — one blank line and the fixed focus section. Unfocused callers must not
 * call this; they leave the manager's `summarizationSystemPrompt` unset so the
 * SDK applies its own default and the request is identical to a plain `/compact`.
 */
export function focusedSummarizationPrompt(focus: string): string {
  return `${DEFAULT_SUMMARIZATION_PROMPT}\n\n${COMPACT_FOCUS_HEADING}\n${focus}`;
}

/**
 * Constructor config for one `/compact` manager. Without a focus the object has
 * exactly the two keys the process-lifetime manager used to be built with, so the
 * unfocused request cannot differ from before per-call construction existed.
 *
 * @throws When the focus is over the cap — refused before any manager, hook or
 *   model call exists.
 */
export function compactionManagerConfig(
  preserveRecentMessages: number,
  focus?: string,
): SummarizingConversationManagerConfig {
  const refusal = compactFocusRefusal(focus);
  if (refusal !== undefined) throw new Error(refusal);
  return {
    summaryRatio: COMPACT_SUMMARY_RATIO,
    preserveRecentMessages,
    ...(focus !== undefined && { summarizationSystemPrompt: focusedSummarizationPrompt(focus) }),
  };
}

/** One manager per `/compact` call: the focus is constructor-only in the SDK. */
export function createCompactionManager(preserveRecentMessages: number, focus?: string): SummarizingConversationManager {
  return new SummarizingConversationManager(compactionManagerConfig(preserveRecentMessages, focus));
}

export interface CompactResult {
  messagesBefore: number;
  messagesAfter: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  estimatedTokensSaved: number;
  /**
   * True only when the message count really dropped. False when the recent
   * window already contains the whole conversation, or when the one pass the
   * SDK could make did not lower the count (undone; see `compactConversation`).
   */
  compacted: boolean;
}

/**
 * The failure surfaced when the SDK's proactive `reduce()` swallows a summarization
 * error and returns `false`. The SDK's own `proactive summarization failed` warning,
 * routed through `routeSdkLogs`, carries the underlying cause right before this.
 */
export const SWALLOWED_SUMMARIZATION_FAILURE =
  'the summarizer made no reduction; the preceding sdk warning names the cause';

export interface CompactConversationOptions {
  agent: Agent;
  model: Model;
  manager: SummarizingConversationManager;
  preserveRecentMessages: number;
  persist: () => Promise<void>;
}

/**
 * Summarizes every reducible old message, persists the result, and restores the
 * original messages if summarization, counting, or persistence fails.
 *
 * Termination and honesty rules (SER-052):
 * - a pass that returns `true` without lowering the message count is undone and
 *   ends the loop, so `compacted` / `messagesAfter` describe what really changed
 *   and the loop makes at most one summarizer call beyond the shrinking ones;
 * - a pass that returns `false` is a summarization failure the SDK swallowed
 *   (proactive `reduce()` has no other `false` inside this loop) — it rejects and
 *   rolls back everything, never reports `compacted: true`.
 * Both rules apply to focused and unfocused managers alike.
 */
export async function compactConversation({
  agent,
  model,
  manager,
  preserveRecentMessages,
  persist,
}: CompactConversationOptions): Promise<CompactResult> {
  const messagesBefore = agent.messages.length;
  if (messagesBefore <= preserveRecentMessages + 1) {
    return {
      messagesBefore,
      messagesAfter: messagesBefore,
      estimatedTokensBefore: 0,
      estimatedTokensAfter: 0,
      estimatedTokensSaved: 0,
      compacted: false,
    };
  }

  const original = agent.messages.map((message) => message.clone());
  const estimatedTokensBefore = await countConversationTokens(model, agent);

  try {
    let compacted = false;
    while (agent.messages.length > preserveRecentMessages + 1) {
      // A shallow snapshot is enough to undo one pass: the SDK splices the list
      // and never mutates the messages themselves, so putting the same objects
      // back leaves identity intact.
      const beforePass = agent.messages.slice();
      const reduced = await manager.reduce({ agent, model });
      if (!reduced) {
        // Inside this loop the SDK has no honest `false`: "insufficient messages"
        // needs `length <= preserveRecentMessages` (excluded by the condition) and
        // "all protected" needs `pinFirst` (never set here). Without an `error`
        // argument the SDK swallows a summarization failure, logs it, and returns
        // `false` — so this is that failure, and a rollback, never a no-op.
        throw new Error(SWALLOWED_SUMMARIZATION_FAILURE);
      }
      if (agent.messages.length >= beforePass.length) {
        // The SDK summarizes at most 80% of the list, so a 2-message history
        // becomes "a summary of the oldest message plus the newest" — the same
        // count, less fidelity, forever. Undo that pass and stop; `compacted`
        // stays whatever the earlier, shrinking passes made it.
        agent.messages.splice(0, agent.messages.length, ...beforePass);
        break;
      }
      compacted = true;
    }

    const messagesAfter = agent.messages.length;
    if (!compacted) {
      return {
        messagesBefore,
        messagesAfter,
        estimatedTokensBefore,
        estimatedTokensAfter: estimatedTokensBefore,
        estimatedTokensSaved: 0,
        compacted: false,
      };
    }

    const estimatedTokensAfter = await countConversationTokens(model, agent);
    await persist();

    return {
      messagesBefore,
      messagesAfter,
      estimatedTokensBefore,
      estimatedTokensAfter,
      estimatedTokensSaved: Math.max(0, estimatedTokensBefore - estimatedTokensAfter),
      compacted: true,
    };
  } catch (error) {
    agent.messages.splice(0, agent.messages.length, ...original);
    throw error;
  }
}

/**
 * Repairs user-role messages that carry `reasoningBlock` content in place.
 *
 * The SDK's summarizer used to copy a thinking model's whole response —
 * reasoning blocks included — into a user-role summary message; providers
 * reject any later request containing it (`User messages cannot contain
 * reasoning content`). A user message can never legally carry reasoning
 * content on any provider, so dropping those blocks is always safe. Message
 * object identity, order, and every non-reasoning block are preserved; the
 * mutation is in-memory only, so the next ordinary save persists it.
 *
 * A message that would be left with zero blocks is left untouched and not
 * counted: a poisoned summary always also carries its text block, so an
 * all-reasoning user message is not the known poisoning — and an empty
 * content array would itself be invalid, trading one rejection for another.
 *
 * @returns The number of messages repaired.
 */
export function stripReasoningFromUserMessages(messages: Message[]): number {
  let repaired = 0;
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const kept = message.content.filter((block) => block.type !== 'reasoningBlock');
    if (kept.length === message.content.length || kept.length === 0) continue;
    message.content.splice(0, message.content.length, ...kept);
    repaired++;
  }
  return repaired;
}

/** Counts the complete assembled context the next model request will receive. */
export function countConversationTokens(model: Model, agent: Agent): Promise<number> {
  return model.countTokens(agent.messages, {
    ...(agent.systemPrompt !== undefined && { systemPrompt: agent.systemPrompt }),
    toolSpecs: agent.tools.map((tool) => tool.toolSpec),
  });
}

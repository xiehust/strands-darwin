/**
 * Explicit conversation compaction through the SDK's summarization extension.
 *
 * The runtime owns persistence; this module owns only the reversible message
 * transformation and token accounting, which keeps it testable with a real SDK
 * Agent and a deterministic model.
 */
import type { Agent, Message, Model } from '@strands-agents/sdk';
import { SummarizingConversationManager } from '@strands-agents/sdk';

export interface CompactResult {
  messagesBefore: number;
  messagesAfter: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  estimatedTokensSaved: number;
  /** False when the recent-message window already contains the whole conversation. */
  compacted: boolean;
}

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
      const reduced = await manager.reduce({ agent, model });
      if (!reduced) break;
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

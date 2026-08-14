/**
 * Explicit conversation compaction through the SDK's summarization extension.
 *
 * The runtime owns persistence; this module owns only the reversible message
 * transformation and token accounting, which keeps it testable with a real SDK
 * Agent and a deterministic model.
 */
import type { Agent, Model } from '@strands-agents/sdk';
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

/** Counts the complete assembled context the next model request will receive. */
export function countConversationTokens(model: Model, agent: Agent): Promise<number> {
  return model.countTokens(agent.messages, {
    ...(agent.systemPrompt !== undefined && { systemPrompt: agent.systemPrompt }),
    toolSpecs: agent.tools.map((tool) => tool.toolSpec),
  });
}

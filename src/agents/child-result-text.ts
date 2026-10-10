/**
 * Parent-visible text of one child `AgentResult` (SER-121).
 *
 * Installed `@strands-agents/sdk` `AgentResult.toString()` appends every
 * `reasoningBlock` as a `💭 Reasoning:` section. That string used to become the
 * parent's tool result, so child reasoning entered parent context and, because
 * the trajectory records the tool result, the trajectory too. The success report
 * is built here instead: assistant `textBlock` text and `citationsBlock` text,
 * in block order, joined with `\n` the way `toString` joins those parts.
 * Reasoning blocks are omitted entirely — not blanked, so they do not leave an
 * extra join. A reasoning-only result is the same empty string as a text-less
 * result; nothing is invented in its place.
 *
 * `projectChildReport` still runs on this string and is not a place to delete
 * lines. A clean report stays byte-identical; imitation lines are escaped.
 */
import type { AgentResult, InvocationState } from '@strands-agents/sdk';

import { withRetainedMaxTokensText } from '../agent/max-tokens-recovery.js';
import { projectChildReport } from './report-projection.js';

/** Assistant text and citation text only, in block order. */
export function visibleChildResultText(result: AgentResult): string {
  const parts: string[] = [];
  for (const block of result.lastMessage.content) {
    if (block.type === 'textBlock') {
      parts.push(block.text);
    } else if (block.type === 'citationsBlock') {
      for (const item of block.content) {
        // Same predicate `AgentResult.toString` uses for citation content.
        if ('text' in item) parts.push(item.text);
      }
    }
  }
  return parts.join('\n');
}

/**
 * The subagent success seam: visible text, then the existing max-tokens
 * retention, then the existing report projection. `SubagentTool.run` returns
 * this string and nothing else, so the trajectory records what the parent
 * received.
 */
export function parentVisibleChildReport(result: AgentResult, invocationState: InvocationState): string {
  return projectChildReport(withRetainedMaxTokensText(visibleChildResultText(result), invocationState));
}

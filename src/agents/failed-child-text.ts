/**
 * SER-063: keep a failed child's evidence.
 *
 * When a child agent's invocation throws, the SDK turns that error into the
 * parent's error tool result and everything the child had already said is
 * lost. This module builds the error to rethrow instead: the original message,
 * one fixed note, and the child's *last assistant text* — bounded to a stated
 * cap and passed through the same SER-062 projection a success report gets.
 *
 * Only that one message is read. Reasoning blocks, tool-use/tool-result blocks,
 * earlier turns and the system prompt never cross, so the "records never carry
 * child transcript" invariant holds; the SDK never stores a message whose own
 * stream failed, so what surfaces is either the retained max-tokens partial or
 * the last assistant message completed before the failing model call.
 *
 * The result is still an *error*: `dispatch.finish('failed')`, the retry guard's
 * failure count (its class comes from `name`, which is preserved) and
 * `turnEnded.failure` are unchanged in shape — only the message is longer. A
 * child with no assistant text yields the original error object (`===`), and a
 * cancelled child is never wrapped: cancellation is not a failure.
 */
import type { InvocationState, Message } from '@strands-agents/sdk';

import { retainedMaxTokensPartials } from '../agent/max-tokens-recovery.js';
import { projectChildReport } from './report-projection.js';

/** Maximum code points of the child's last assistant text carried in the error. */
export const FAILED_CHILD_TEXT_CAP = 4000;

/** The fixed line separating the original message from the retained text. */
export const FAILED_CHILD_NOTE = 'subagent was cut off before finishing; its last output follows:';

/** The slice of a child this module reads — structural, so tests need no Agent. */
export interface FailedChild {
  readonly messages: readonly Message[];
  readonly cancelSignal: AbortSignal;
}

/**
 * Returns the error `SubagentTool`/`WorkflowTool` should rethrow for a child whose
 * invocation threw `error`. Same object when there is nothing to add.
 */
export function withFailedChildText(error: unknown, child: FailedChild, invocationState: InvocationState): unknown {
  if (!(error instanceof Error)) return error;
  if (child.cancelSignal.aborted) return error;
  const text = lastAssistantText(child, invocationState);
  if (text.trim() === '') return error;
  const bounded = projectChildReport(truncateCodePoints(text, FAILED_CHILD_TEXT_CAP));
  const wrapped = new Error(`${error.message}\n${FAILED_CHILD_NOTE}\n${bounded}`, { cause: error });
  wrapped.name = error.name;
  return wrapped;
}

/**
 * Splits a message produced by {@link withFailedChildText} into the original
 * message and the note-plus-text tail; `tail` is `undefined` for any other message.
 */
export function splitFailedChildMessage(message: string): { head: string; tail: string | undefined } {
  const marker = `\n${FAILED_CHILD_NOTE}\n`;
  const at = message.indexOf(marker);
  if (at === -1) return { head: message, tail: undefined };
  return { head: message.slice(0, at), tail: message.slice(at + 1) };
}

/**
 * Max-tokens partials the recovery hook retained, then the last assistant
 * message unless it *is* one of those partials (the hook pushes them into
 * `messages` too, so it would otherwise be counted twice).
 */
function lastAssistantText(child: FailedChild, invocationState: InvocationState): string {
  const partials = retainedMaxTokensPartials(invocationState);
  const pieces = partials.map(textOf);
  for (let index = child.messages.length - 1; index >= 0; index -= 1) {
    const message = child.messages[index];
    if (message === undefined || message.role !== 'assistant') continue;
    if (!partials.includes(message)) pieces.push(textOf(message));
    break;
  }
  return pieces.join('');
}

function textOf(message: Message): string {
  return message.content.map((block) => (block.type === 'textBlock' ? block.text : '')).join('');
}

/** Keeps the first `cap` code points; the suffix states exactly how many were dropped. */
function truncateCodePoints(text: string, cap: number): string {
  let kept = '';
  let seen = 0;
  for (const codePoint of text) {
    seen += 1;
    if (seen <= cap) kept += codePoint;
  }
  if (seen <= cap) return text;
  return `${kept}… [truncated ${seen - cap} code points]`;
}

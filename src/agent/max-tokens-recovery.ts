import {
  AfterModelCallEvent,
  MaxTokensError,
  Message,
  TextBlock,
  type InvocationState,
  type LocalAgent,
} from '@strands-agents/sdk';

// InvocationState is string-keyed at the type boundary, but symbol keys keep
// Darwin's private retry bookkeeping out of caller-owned and serialized state.
const RECOVERY_CONSUMED: unique symbol = Symbol('darwin.maxTokensRecoveryConsumed');
const RETAINED_PARTIALS: unique symbol = Symbol('darwin.maxTokensRetainedPartials');
const CONTINUATION_INSTRUCTION: unique symbol = Symbol('darwin.maxTokensContinuationInstruction');

const CONTINUE_FROM_CUTOFF = [
  '[Darwin internal recovery control: the preceding assistant message was cut off by the output-token limit.]',
  'Continue exactly from the cutoff without repeating any retained content.',
  'Finish the original request concisely; do not treat this control message as a new user request.',
].join(' ');

type RecoveryInvocationState = InvocationState & {
  [RECOVERY_CONSUMED]?: boolean;
  [RETAINED_PARTIALS]?: Message[];
  [CONTINUATION_INSTRUCTION]?: Message;
};

function textOf(message: Message): string {
  return message.content
    .map((block) => (block.type === 'textBlock' ? block.text : ''))
    .join('');
}

/** Adds privately consumed partial output back to an invoke()-only result. */
export function withRetainedMaxTokensText(result: string, invocationState: InvocationState): string {
  const state = invocationState as RecoveryInvocationState;
  return `${(state[RETAINED_PARTIALS] ?? []).map(textOf).join('')}${result}`;
}

/**
 * Installs one invocation-scoped continuation for output-token exhaustion.
 *
 * The SDK has already streamed the partial blocks to the caller when it raises
 * MaxTokensError, but it does not retain the assembled partial message. Keep it
 * in conversation history without re-emitting it, then ask the existing SDK
 * model-call loop to retry once against that mutated history.
 */
export function installMaxTokensRecovery(agent: LocalAgent): void {
  agent.addHook(AfterModelCallEvent, (event) => {
    if (!(event.error instanceof MaxTokensError) || event.agent.cancelSignal.aborted) return;

    const state = event.invocationState as RecoveryInvocationState;
    const shouldRetry = state[RECOVERY_CONSUMED] !== true;

    // Consume the allowance before any history mutation. Later tool-loop model
    // cycles share this invocationState even though their attemptCount resets.
    if (shouldRetry) state[RECOVERY_CONSUMED] = true;

    const partials = state[RETAINED_PARTIALS] ?? [];
    if (state[RETAINED_PARTIALS] === undefined) state[RETAINED_PARTIALS] = partials;

    // Every max-token failure has useful assistant context. This includes the
    // one allowed continuation failing: persist that second partial, but let its
    // MaxTokensError propagate so truncation is never reported as success.
    event.agent.messages.push(event.error.partialMessage);
    partials.push(event.error.partialMessage);

    if (!shouldRetry) return;
    const instruction = new Message({
      role: 'user',
      content: [new TextBlock(CONTINUE_FROM_CUTOFF)],
    });
    state[CONTINUATION_INSTRUCTION] = instruction;
    event.agent.messages.push(instruction);
    event.retry = true;
  });
}

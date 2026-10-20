/** Human queue delivery through the SDK's post-tool-batch hook, never a second loop. */
import { AfterToolsEvent, MessageAddedEvent, HookOrder, TextBlock, type Agent, type Message } from '@strands-agents/sdk';

export interface SteeringPrompt {
  readonly text: string;
}

/** Claim transfers ownership provisionally; only the SDK's append confirms delivery. */
export interface PromptSteeringSource {
  pending(): readonly SteeringPrompt[];
  claim(prompt: SteeringPrompt): boolean;
  delivered(prompt: SteeringPrompt): void;
  restore(prompts: readonly SteeringPrompt[]): void;
  reject(prompt: SteeringPrompt, reason: string): void;
}

/** Bound each boundary's hook work; remaining entries stay visible in the driver's queue. */
export const MAX_STEERING_PER_BOUNDARY = 16;

/**
 * AfterToolsEvent owns the complete user-role tool-result message before the SDK
 * appends it. Append text after results, preserving every tool pair and letting
 * the next ordinary model call see it. No private SDK API or history mutation.
 */
export function installPromptSteering(
  agent: Agent,
  source: PromptSteeringSource,
  prepare: (text: string) => Promise<string>,
  accepted: (text: string) => Promise<void>,
): () => void {
  let offered: { message: Message; prompts: SteeringPrompt[] } | undefined;
  const removeOffer = agent.addHook(AfterToolsEvent, async event => {
    if (event.agent.cancelSignal.aborted || event.endTurn !== false ||
      !event.message.content.some(block => block.type === 'toolResultBlock')) return;
    // AfterToolsEvent also fires from failed-batch cleanup. Nothing is recorded or
    // echoed until this exact message is actually appended by the SDK below.
    const batch = { message: event.message, prompts: [] as SteeringPrompt[] };
    offered = batch;
    for (const prompt of source.pending().slice(0, MAX_STEERING_PER_BOUNDARY)) {
      // A prior preparation await may have let the user take back later entries.
      if (event.agent.cancelSignal.aborted || event.endTurn !== false || source.pending()[0] !== prompt) break;
      let text: string;
      try {
        text = await prepare(prompt.text);
      } catch (error) {
        source.reject(prompt, error instanceof Error ? error.message : String(error));
        break;
      }
      if (event.agent.cancelSignal.aborted || !source.claim(prompt)) break;
      batch.prompts.push(prompt);
      event.message.content.push(new TextBlock(text));
    }
  }, { order: HookOrder.SDK_LAST });
  const removeDelivery = agent.addHook(MessageAddedEvent, async event => {
    if (offered?.message !== event.message) return;
    const { prompts } = offered;
    offered = undefined;
    // All these texts are now in history, even if cancellation arrives during the
    // bounded recording barrier. None may be returned as unsent after this point.
    for (const prompt of prompts) {
      source.delivered(prompt);
      await accepted(prompt.text);
    }
  }, { order: HookOrder.SDK_FIRST });
  return () => {
    removeOffer();
    removeDelivery();
    if (offered !== undefined && offered.prompts.length > 0) source.restore(offered.prompts);
    offered = undefined;
  };
}

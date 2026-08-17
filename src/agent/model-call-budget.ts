import { BeforeModelCallEvent } from '@strands-agents/sdk';
import type { Agent } from '@strands-agents/sdk';

/** A process-scoped guardrail, not a billing claim: compaction uses a separate model path. */
export class ModelCallBudgetError extends Error {
  constructor(readonly limit: number) {
    super(
      `Model-call budget exhausted: this process allows ${limit} call(s). ` +
        `Start a focused follow-up turn with a fresh budget.`,
    );
    this.name = 'ModelCallBudgetError';
  }
}

/** Refuses parent-Agent call `limit + 1` before the provider is invoked. */
export function installModelCallBudget(agent: Agent, limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`Model-call budget must be a positive safe integer, got ${limit}.`);
  }

  let calls = 0;
  agent.addHook(BeforeModelCallEvent, () => {
    calls += 1;
    if (calls > limit) throw new ModelCallBudgetError(limit);
  });
}

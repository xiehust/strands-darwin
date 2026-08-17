/** Offline contract for the process-scoped parent Agent model-call ceiling. */
import {
  Agent,
  Message,
  Model,
  tool,
  type BaseModelConfig,
  type ModelStreamEvent,
} from '@strands-agents/sdk';
import { z } from 'zod';

import {
  installModelCallBudget,
  ModelCallBudgetError,
} from '../src/agent/model-call-budget.js';
import { assert, header, report } from './shared.js';

class ToolLoopModel extends Model<BaseModelConfig> {
  calls = 0;
  private config: BaseModelConfig = { modelId: 'fake.model-budget', contextWindowLimit: 200_000 };

  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }

  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    const hasResult = messages.some((message) =>
      message.content.some((block) => block.type === 'toolResultBlock'),
    );
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (!hasResult) {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'echo', toolUseId: 'budget-tool' } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: '{}' } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'done' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

const echo = tool({
  name: 'echo',
  description: 'echo',
  inputSchema: z.object({}),
  callback: () => 'echoed',
});

header('model-call budget — refuse before provider call limit + 1');
const blockedModel = new ToolLoopModel();
const blocked = new Agent({ model: blockedModel, tools: [echo], printer: false });
installModelCallBudget(blocked, 1);
let failure: unknown;
try {
  await blocked.invoke('go');
} catch (error) {
  failure = error;
}
assert('the next call is refused with the named budget error', failure instanceof ModelCallBudgetError);
assert('the provider saw exactly the one allowed call', blockedModel.calls === 1);
assert('the error is actionable and names the ceiling', failure instanceof Error && failure.message.includes('allows 1 call(s)') && failure.message.includes('focused follow-up'));

header('model-call budget — a sufficient budget preserves the SDK loop');
const allowedModel = new ToolLoopModel();
const allowed = new Agent({ model: allowedModel, tools: [echo], printer: false });
installModelCallBudget(allowed, 2);
const result = await allowed.invoke('go');
assert('two calls complete normally', allowedModel.calls === 2 && result.stopReason === 'endTurn');
assert('invalid ceilings fail before hook installation', [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].every((limit) => {
  try { installModelCallBudget(new Agent({ model: new ToolLoopModel(), printer: false }), limit); return false; }
  catch (error) { return error instanceof RangeError; }
}));

report();

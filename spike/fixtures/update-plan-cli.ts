import { Model } from '@strands-agents/sdk';
import type { BaseModelConfig, Message, ModelStreamEvent } from '@strands-agents/sdk';

import { setRuntimeModelFactoryForTest } from '../../src/agent/runtime.js';

class UpdatePlanPtyModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.update-plan-pty', contextWindowLimit: 200_000 };
  private calls = 0;

  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }

  override async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (this.calls <= 2 || this.calls === 4) {
      const plan = this.calls === 1
        ? Array.from({ length: 8 }, (_, index) => ({ item: `initial item ${index + 1}`, status: index === 0 ? 'in_progress' : 'pending' }))
        : this.calls === 2
          ? Array.from({ length: 8 }, (_, index) => ({ item: `latest item ${index + 1}`, status: index === 0 ? 'completed' : index === 1 ? 'in_progress' : 'pending' }))
          : Array.from({ length: 8 }, (_, index) => ({ item: `latest item ${index + 1}`, status: 'completed' }));
      const calls = this.calls === 4
        ? [['update_plan', 'plan-complete', { plan }]] as const
        : [
            ['update_plan', `plan-${this.calls}`, { plan }],
            ['bash', `bash-${this.calls}`, { mode: 'execute', command: 'sleep 0.8; printf done' }],
          ] as const;
      for (const [name, id, input] of calls) {
        yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name, toolUseId: id } };
        yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(input) } };
        yield { type: 'modelContentBlockStopEvent' };
      }
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    yield { type: 'modelContentBlockStartEvent' };
    yield {
      type: 'modelContentBlockDeltaEvent',
      delta: {
        type: 'textDelta',
        text: this.calls === 3
          ? 'premature summary with unfinished checklist'
          : this.calls === 5
            ? 'first turn done — automatic continuation completed the checklist'
            : 'second turn done',
      },
    };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

const model = new UpdatePlanPtyModel();
setRuntimeModelFactoryForTest(async () => model);
await import('../../src/cli.js');

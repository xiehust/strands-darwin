import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Model } from '@strands-agents/sdk';
import type { BaseModelConfig, Message, ModelStreamEvent } from '@strands-agents/sdk';

import { setRuntimeModelFactoryForTest } from '../../src/agent/runtime.js';

const CHECKPOINT = path.join(process.cwd(), 'update-plan-terminal-blocked');
const RELEASE = path.join(process.cwd(), 'update-plan-release-terminal');
const CALLS = path.join(process.cwd(), 'update-plan-model-calls');

class UpdatePlanPtyModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.update-plan-pty', contextWindowLimit: 200_000 };
  private calls = 0;

  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }

  override async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    writeFileSync(CALLS, String(this.calls));
    yield { type: 'modelMessageStartEvent', role: 'assistant' };

    if (this.calls === 1) {
      const plan = Array.from({ length: 8 }, (_, index) => ({
        item: `latest item ${index + 1}`,
        status: index === 0 ? 'completed' : index === 1 ? 'in_progress' : 'pending',
      }));
      for (const [name, id, input] of [
        ['update_plan', 'plan-live', { plan }],
        ['bash', 'bash-live', { mode: 'execute', command: "printf '\\164\\157\\157\\154\\055\\162\\145\\163\\165\\154\\164\\055\\166\\151\\163\\151\\142\\154\\145\\055\\142\\145\\146\\157\\162\\145\\055\\164\\145\\162\\155\\151\\156\\141\\154'" }],
      ] as const) {
        yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name, toolUseId: id } };
        yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(input) } };
        yield { type: 'modelContentBlockStopEvent' };
      }
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }

    const text = this.calls === 2
      ? 'assistant line visible before terminal\n'
      : 'ordinary no-tool answer';
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } };

    if (this.calls === 2) {
      // Keep the model stream deliberately open after a complete line has reached
      // the driver. The pty test releases this exact boundary after proving the
      // tool result, live checklist and assistant line are already public.
      writeFileSync(CHECKPOINT, 'blocked before content stop and terminal result\n');
      const deadline = Date.now() + 30_000;
      while (!existsSync(RELEASE) && Date.now() < deadline) await delay(20);
      if (!existsSync(RELEASE)) throw new Error('update-plan fixture terminal release timed out');
    }

    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

const model = new UpdatePlanPtyModel();
setRuntimeModelFactoryForTest(async () => model);
await import('../../src/cli.js');

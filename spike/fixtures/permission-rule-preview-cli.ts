/** Local model, real runtime/gate/App/tool bodies. SIGUSR1 exercises live withdrawal. */
import { writeFileSync } from 'node:fs';
import { Model } from '@strands-agents/sdk';
import type { BaseModelConfig, Message, ModelStreamEvent } from '@strands-agents/sdk';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../../src/agent/runtime.js';

class PermissionRuleModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.permission-rule', contextWindowLimit: 200_000 };
  private calls = 0;
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (this.calls++ % 2 === 0) {
      const input = JSON.parse(process.env['PREVIEW_INPUT'] ?? '{}') as unknown;
      for (let index = 0; index < Number(process.env['PREVIEW_CALLS'] ?? 1); index++) {
        yield { type: 'modelContentBlockStartEvent', start: {
          type: 'toolUseStart', name: process.env['PREVIEW_TOOL'] ?? 'fileEditor', toolUseId: `review-${this.calls}-${index}`,
        } };
        yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(input) } };
        yield { type: 'modelContentBlockStopEvent' };
      }
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
    } else {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'fixture turn complete' } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    }
  }
}

const create = AgentRuntime.create.bind(AgentRuntime);
AgentRuntime.create = async (options) => {
  const runtime = await create(options);
  process.on('SIGUSR1', () => runtime.changePermissionMode('plan'));
  writeFileSync(process.env['PREVIEW_PID_FILE']!, String(process.pid));
  return runtime;
};
setRuntimeModelFactoryForTest(async () => new PermissionRuleModel());
await import('../../src/cli.js');

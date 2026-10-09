/** SER-116 production CLI with a file-held local model; captures every actual request. */
import { access, appendFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Model, type BaseModelConfig, type Message, type ModelStreamEvent } from '@strands-agents/sdk';
import { setRuntimeModelFactoryForTest } from '../../src/agent/runtime.js';

class RenameModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.rename', contextWindowLimit: 200_000 };
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    await appendFile('model-requests', `${JSON.stringify(messages.map((message) => message.toJSON()))}\n`);
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'rename fixture working\n' } };
    const deadline = Date.now() + 60_000;
    while (true) {
      try { await access('release-model'); break; } catch { /* file-held busy invocation */ }
      if (Date.now() >= deadline) throw new Error('rename fixture release timed out');
      await delay(25);
    }
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'rename fixture complete' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}
setRuntimeModelFactoryForTest(async () => new RenameModel());

await import('../../src/cli.js');

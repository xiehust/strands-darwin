/** SER-084: real CLI/runtime/SDK, deterministic local transport only. No provider. */
import { setTimeout as delay } from 'node:timers/promises';
import { access, appendFile } from 'node:fs/promises';
import { Model, type BaseModelConfig, type Message, type ModelStreamEvent } from '@strands-agents/sdk';
import { setRuntimeModelFactoryForTest } from '../../src/agent/runtime.js';

async function released(name: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { await access(name); return; } catch { await delay(25); }
  }
  throw new Error(`fixture timed out waiting for ${name}`);
}

class ComposerModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.composer-yank', contextWindowLimit: 200_000 };
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }

  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    const text = messages.at(-1)?.content.find((block) => block.type === 'textBlock')?.text;
    await appendFile('model-calls', `${JSON.stringify(text ?? 'tool result')}\n`);
    const summary = text === 'Please summarize this conversation.';
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (summary) await released('release-summary');
    if (text === 'permission') {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'permission preparing\n' } };
      yield { type: 'modelContentBlockStopEvent' };
      await released('release-permission');
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'bash', toolUseId: 'yank-permission' } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify({
        mode: 'execute', command: 'printf should-not-run > yank-permission-sentinel',
      }) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: summary ? 'local summary' : 'local answer' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

setRuntimeModelFactoryForTest(async () => new ComposerModel());
await import('../../src/cli.js');

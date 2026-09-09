/** SER-085: production CLI/runtime/SDK with a local deterministic model only.
 * Captures complete model requests (including compaction) to prove stash privacy.
 */
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

class StashModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.draft-stash', contextWindowLimit: 200_000 };
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    await appendFile('model-requests', `${JSON.stringify(messages.map((message) => message.toJSON()))}\n`);
    const text = messages.at(-1)?.content.find((block) => block.type === 'textBlock')?.text;
    const summary = text === 'Please summarize this conversation.';
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (summary) await released('release-summary');
    if (text === 'hold image') await released('release-image');
    if (text === 'permission') {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'permission preparing\n' } };
      yield { type: 'modelContentBlockStopEvent' };
      await released('release-permission');
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'bash', toolUseId: 'stash-permission' } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify({
        mode: 'execute', command: 'printf should-not-run > permission-sentinel',
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

setRuntimeModelFactoryForTest(async () => new StashModel());
await import('../../src/cli.js');

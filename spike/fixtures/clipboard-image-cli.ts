import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { Model } from '@strands-agents/sdk';
import type { BaseModelConfig, Message, ModelStreamEvent } from '@strands-agents/sdk';

import { setRuntimeModelFactoryForTest } from '../../src/agent/runtime.js';

const CAPTURE = path.join(process.cwd(), 'clipboard-image-capture.json');

class ClipboardImageModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.clipboard-image-pty', contextWindowLimit: 200_000 };
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    const user = messages.at(-1);
    writeFileSync(CAPTURE, JSON.stringify(user?.toJSON()));
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'image received' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

setRuntimeModelFactoryForTest(async () => new ClipboardImageModel());
await import('../../src/cli.js');

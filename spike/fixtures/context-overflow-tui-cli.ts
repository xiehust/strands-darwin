import {
  ContextWindowOverflowError,
  Model,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
} from '@strands-agents/sdk';

import { setRuntimeModelFactoryForTest } from '../../src/agent/runtime.js';

class ContextOverflowModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = {
    modelId: 'fake.context-overflow-tui',
    contextWindowLimit: 2_000,
  };

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    throw new ContextWindowOverflowError(
      'prompt tokens (1416135) exceed model maximum (1050000) for openai.gpt-5.6-sol',
    );
  }
}

setRuntimeModelFactoryForTest(async () => new ContextOverflowModel());
await import('../../src/cli.js');

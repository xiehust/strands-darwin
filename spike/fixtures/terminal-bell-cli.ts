/**
 * Real-CLI entry for the terminal-bell pty suite: only runtime model construction
 * is replaced with a deterministic local model, so the real `runInteractive`,
 * permission queue observer wiring, and App turn loop all run. The model's first
 * turn requests a statically dangerous `bash` write (a permission publication in
 * default mode); once a tool result exists it answers with plain text. Implementing
 * no provider transport proves the suite cannot fall through to a real model call.
 */

import {
  Model,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
} from '@strands-agents/sdk';

import { setRuntimeModelFactoryForTest } from '../../src/agent/runtime.js';

class BellFixtureModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.terminal-bell', contextWindowLimit: 200_000 };
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    const hasResult = messages.some((message) => message.content.some((block) => block.type === 'toolResultBlock'));
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (!hasResult) {
      // Redirection makes this statically dangerous, so default mode always asks —
      // a deterministic permission publication with no classifier or network.
      const input = JSON.stringify({ command: 'printf bell > bell.txt' });
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'bash', toolUseId: 'bell-1' } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'bell fixture done' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

setRuntimeModelFactoryForTest(async () => new BellFixtureModel());

await import('../../src/cli.js');

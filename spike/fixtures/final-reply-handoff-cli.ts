import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Model } from '@strands-agents/sdk';
import type { BaseModelConfig, Message, ModelStreamEvent } from '@strands-agents/sdk';

import { setRuntimeModelFactoryForTest } from '../../src/agent/runtime.js';

const CHECKPOINT = path.join(process.cwd(), 'final-reply-handoff-blocked');
const RELEASE = path.join(process.cwd(), 'final-reply-handoff-release');

/**
 * The tail matches the reported failure shape: most lines become Static while
 * streaming, while the final non-blank completed line, blank line and prompt stay
 * live until the authoritative content block closes.
 */
export const FINAL_REPLY = [
  'FINAL-HANDOFF-VERIFY-1',
  'FINAL-HANDOFF-VERIFY-2',
  'FINAL-HANDOFF-VERIFY-3',
  'FINAL-HANDOFF-VERIFY-4',
  'FINAL-HANDOFF-VERIFY-5',
  'FINAL-HANDOFF-LAST-COMPLETED',
  '',
  'FINAL-HANDOFF-REPLY-PROMPT',
].join('\n');

class FinalReplyHandoffModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.final-reply-handoff', contextWindowLimit: 200_000 };
  private calls = 0;

  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }

  override async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };

    const text = this.calls === 1 ? FINAL_REPLY : 'FINAL-HANDOFF-NEXT-TURN';
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } };

    if (this.calls === 1) {
      writeFileSync(CHECKPOINT, 'tail is live before content stop\n');
      const deadline = Date.now() + 30_000;
      while (!existsSync(RELEASE) && Date.now() < deadline) await delay(20);
      if (!existsSync(RELEASE)) throw new Error('final reply handoff release timed out');
    }

    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

setRuntimeModelFactoryForTest(async () => new FinalReplyHandoffModel());
await import('../../src/cli.js');

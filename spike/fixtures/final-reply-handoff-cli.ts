import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Model } from '@strands-agents/sdk';
import type { BaseModelConfig, Message, ModelStreamEvent } from '@strands-agents/sdk';

import { setRuntimeModelFactoryForTest } from '../../src/agent/runtime.js';

const CHECKPOINT = path.join(process.cwd(), 'final-reply-handoff-blocked');
const RELEASE = path.join(process.cwd(), 'final-reply-handoff-release');

/**
 * A long, wrapping CJK reply matching the reported failure shape. The final
 * paragraph is yielded separately, then held live before the block closes;
 * everything before it has already exercised live-to-Static scrolling in the
 * short viewport.
 */
const BODY = Array.from(
  { length: 18 },
  (_, index) => `第${String(index + 1).padStart(2, '0')}段：这是用于终端滚动回归的长篇中文回答，内容持续换行并进入静态历史。`,
).join('\n\n');

const FINAL_PARAGRAPH = '末段唯一标记：提交边界完成后，这一整段中文只能在终端历史中保留一次。';
const FINAL_REPLY_PREFIX = `${BODY}\n\n`;

class FinalReplyHandoffModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.final-reply-handoff', contextWindowLimit: 200_000 };
  private calls = 0;

  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }

  override async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };

    if (this.calls === 1) {
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: FINAL_REPLY_PREFIX } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: FINAL_PARAGRAPH } };
      // Pause only after App has consumed the final delta. The PTY test waits until
      // that paragraph is visibly part of the mutable frame before allowing the
      // authoritative block to close, so it exercises the actual handoff race.
      writeFileSync(CHECKPOINT, 'final paragraph yielded; content stop blocked\n');
      const deadline = Date.now() + 30_000;
      while (!existsSync(RELEASE) && Date.now() < deadline) await delay(20);
      if (!existsSync(RELEASE)) throw new Error('final reply handoff release timed out');
    } else {
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'FINAL-HANDOFF-NEXT-TURN' } };
    }

    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

setRuntimeModelFactoryForTest(async () => new FinalReplyHandoffModel());
await import('../../src/cli.js');

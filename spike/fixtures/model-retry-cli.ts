/**
 * Pty fixture for SER-067: a model that is throttled on every call, behind darwin's own
 * retry with a deliberately short two-attempt schedule and a wait long enough for the
 * busy row to be read. Turn 1 is cancelled inside the wait (one model call); turn 2 runs
 * the budget out (two more calls). No network, no provider.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { ConstantBackoff, Model, ModelThrottledError } from '@strands-agents/sdk';
import type { BaseModelConfig, Message, ModelStreamEvent } from '@strands-agents/sdk';

import { setModelRetryScheduleForTest } from '../../src/agent/model-retry.js';
import { setRuntimeModelFactoryForTest } from '../../src/agent/runtime.js';

const CALLS = path.join(process.cwd(), 'model-retry-model-calls');
/** Long enough for the pty to read the phrase and cancel, short enough for the exhausted turn. */
const WAIT_MS = 2_500;

class ThrottledPtyModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.model-retry-pty', contextWindowLimit: 200_000 };
  private calls = 0;

  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }

  override async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    writeFileSync(CALLS, String(this.calls));
    throw new ModelThrottledError('Rate exceeded');
  }
}

setModelRetryScheduleForTest(() => ({ maxAttempts: 2, backoff: new ConstantBackoff({ delayMs: WAIT_MS }) }));
const model = new ThrottledPtyModel();
setRuntimeModelFactoryForTest(async () => model);
await import('../../src/cli.js');

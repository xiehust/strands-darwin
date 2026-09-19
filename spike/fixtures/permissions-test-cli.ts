/** Offline busy model: the owning pty suite releases it via an owned fixture file. */
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Message, ModelStreamEvent, StreamOptions } from '@strands-agents/sdk';
import { setRuntimeModelFactoryForTest } from '../../src/agent/runtime.js';
import { CaptureModel } from '../offline-model.js';

class HeldModel extends CaptureModel {
  private invocations = 0;
  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    this.invocations += 1;
    await writeFile(path.join(process.cwd(), 'calls'), String(this.invocations));
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (await access(path.join(process.cwd(), 'release')).then(() => true, () => false)) break;
      await delay(100);
    }
    yield* super.stream(messages, options);
  }
}
setRuntimeModelFactoryForTest(async () => new HeldModel('offline turn finished'));
await import('../../src/cli.js');

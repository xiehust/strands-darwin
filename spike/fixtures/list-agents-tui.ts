/** Real CLI/Ink/SDK with one local model stream held by a test-owned release file. */
import { existsSync, watch } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import type { Message, ModelStreamEvent, StreamOptions } from '@strands-agents/sdk';
import { setRuntimeModelFactoryForTest } from '../../src/agent/runtime.js';
import { CaptureModel } from '../offline-model.js';

class HeldModel extends CaptureModel {
  override async *stream(_messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    await appendFile(process.env['LIST_AGENTS_CALLS']!, 'model-call\n');
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'LIST_AGENTS_BUSY\n' } };
    const release = process.env['LIST_AGENTS_RELEASE']!;
    await new Promise<void>((resolve, reject) => {
      const watcher = watch(path.dirname(release), () => { if (existsSync(release)) finish(); });
      const timer = setTimeout(() => finish(new Error('fixture release timed out')), 30_000);
      function finish(error?: Error): void {
        watcher.close();
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      }
      watcher.on('error', finish);
      if (existsSync(release)) finish();
    });
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'LIST_AGENTS_FINISHED' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}
setRuntimeModelFactoryForTest(async () => new HeldModel());

await import('../../src/cli.js');

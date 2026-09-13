/** SER-087: capture real SDK requests from the production CLI or dev-repl.
 * A file-released first turn makes busy queue assertions independent of timing.
 */
import { access, appendFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Message, ModelStreamEvent, StreamOptions } from '@strands-agents/sdk';
import { setRuntimeModelFactoryForTest } from '../../src/agent/runtime.js';
import { CaptureModel } from '../offline-model.js';
class ReviewModel extends CaptureModel {
  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    await appendFile('review-requests', `${JSON.stringify(messages.at(-1)?.toJSON())}\n`);
    const text = messages.at(-1)?.content.find(block => block.type === 'textBlock')?.text;
    if (text === 'hold review queue') {
      const deadline = Date.now() + 60_000;
      let released = false;
      while (Date.now() < deadline) {
        try { await access('release-review'); released = true; break; } catch { await delay(25); }
      }
      if (!released) throw new Error('review fixture release timed out');
    }
    yield* super.stream(messages, options);
  }
}
setRuntimeModelFactoryForTest(async () => new ReviewModel('REVIEW_LOCAL_REPLY'));
if (process.env['REVIEW_DRIVER'] === 'repl') await import('../../src/dev-repl.js');
else await import('../../src/cli.js');

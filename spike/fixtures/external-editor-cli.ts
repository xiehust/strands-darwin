/**
 * Fixture CLI for `spike/verify-external-editor-pty.ts` (SER-113): the production CLI,
 * runtime and SDK loop with one deterministic local model — no provider, no network.
 *
 * The model is driven by the newest user text block:
 * - `hold`            → a text answer held open until `hold-release` exists (busy state).
 * - `permission`      → a `bash execute` that asks for approval in `default` mode.
 * - `start-job <m>`   → `bash start` of a job that waits for `job-release`, then text.
 * - `<task-notification…` → text acknowledging the wake.
 * - anything else     → `local answer`.
 * Every call appends `{ text, afterTool }` to `editor-model-calls.jsonl` in the cwd: the
 * suite's proof of what (and whether) the model was asked.
 */
import { appendFile, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Model, type BaseModelConfig, type Message, type ModelStreamEvent } from '@strands-agents/sdk';
import { setRuntimeModelFactoryForTest } from '../../src/agent/runtime.js';

async function released(name: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { await access(name); return; } catch { await delay(25); }
  }
  throw new Error(`fixture timed out waiting for ${name}`);
}

function newestText(messages: readonly Message[]): { text: string; afterTool: boolean } {
  let text = '';
  let afterTool = false;
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const block = message.content.find((candidate) => candidate.type === 'textBlock');
    if (block !== undefined) { text = (block as { text: string }).text; afterTool = false; continue; }
    if (message.content.some((candidate) => candidate.type === 'toolResultBlock')) afterTool = true;
  }
  return { text, afterTool };
}

class EditorModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.external-editor', contextWindowLimit: 200_000 };
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }

  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    const { text, afterTool } = newestText(messages);
    await appendFile('editor-model-calls.jsonl', `${JSON.stringify({ text, afterTool })}\n`);
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    const tool = (name: string, input: Record<string, unknown>, id: string): ModelStreamEvent[] => [
      { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name, toolUseId: id } },
      { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(input) } },
      { type: 'modelContentBlockStopEvent' },
      { type: 'modelMessageStopEvent', stopReason: 'toolUse' },
    ];
    if (!afterTool && text === 'permission') {
      yield* tool('bash', { mode: 'execute', command: 'printf ran > permission-sentinel' }, 'editor-permission');
      return;
    }
    if (!afterTool && text.startsWith('start-job ')) {
      const marker = text.slice('start-job '.length);
      yield* tool('bash', {
        mode: 'start', command: `while [ ! -e job-release ]; do sleep 0.05; done; echo ${marker}`,
      }, `editor-job-${marker}`);
      return;
    }
    let answer = 'local answer';
    if (text === 'hold') { await released('hold-release'); answer = 'held answer'; }
    else if (text.startsWith('<task-notification')) answer = 'wake ack';
    else if (afterTool) answer = 'tool step done';
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: answer } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

setRuntimeModelFactoryForTest(async () => new EditorModel());
await import('../../src/cli.js');

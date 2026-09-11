/**
 * Fixture CLI for `spike/verify-task-wake.ts` (SER-069): the real TUI with a local
 * scripted model, so a background `bash start` job can finish while the session is
 * idle, mid-turn, under a permission prompt, or during `/clear` — with no provider.
 *
 * The model is driven by the newest *typed* user message, so one TUI session can
 * run several scenarios in sequence:
 *
 * - `start-activity[-block] <m>` → job held until `activity-release-<m>` exists;
 *                                  optional held model stream for the activity header suite.
 * - `start-idle <marker>`        → `bash start` (`sleep 2; echo <marker>`), then text.
 * - `start-and-wait <marker>`    → `bash start` (`sleep 0.3; …`), `bash wait` terminal-focused
 *                                  until it ends, then text — the model saw the terminal state.
 * - `start-then-block <marker>`  → `bash start` (`sleep 0.5; …`), then a text answer whose
 *                                  stream is held open until the release file appears.
 * - `start-many-block <marker>` → 19 short jobs (one failure), then hold the answer open.
 * - `start-then-permission <m>`  → `bash start` (`sleep 1.5; …`), then a foreground `bash execute`
 *                                  (`sleep 0.1; …`) that asks for permission in `default` mode, then text.
 * - `start-clear-window <marker>`→ `bash start` (`sleep 2.5; …`), then text; the *second*
 *                                  runtime creation (`/clear`) blocks on a release file.
 * - `delegate-idle <marker>`     → `subagent` with `_background_execution: true` (task `count <marker>`),
 *                                  then text; the child (no `subagent` spec) sleeps 3 s and answers.
 * - a `<task-notification …>` message → text acknowledging the wake.
 *
 * Every model call appends `{ call, userText, role, pairTaskIds }` to `wake-model-calls.jsonl`
 * in the working directory, where `userText` is the newest typed user message the request
 * carried and `pairTaskIds` the SDK-delivered result pairs it held — that file is the
 * suite's proof of what the model was actually asked.
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Model } from '@strands-agents/sdk';
import type { BaseModelConfig, Message, ModelStreamEvent, StreamOptions } from '@strands-agents/sdk';

import { setRuntimeModelFactoryForTest } from '../../src/agent/runtime.js';

const CALLS = path.join(process.cwd(), 'wake-model-calls.jsonl');
const BLOCK_CHECKPOINT = path.join(process.cwd(), 'wake-block-checkpoint');
const BLOCK_RELEASE = path.join(process.cwd(), 'wake-block-release');
const CLEAR_RELEASE = path.join(process.cwd(), 'wake-clear-release');
const CLEAR_ARM = path.join(process.cwd(), 'wake-clear-arm');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The newest user message that carries text (a prompt or a wake), and how many tool-result messages followed it. */
function latestPrompt(messages: readonly Message[]): { text: string; toolResultsSince: number; lastResult: unknown } {
  let text = '';
  let toolResultsSince = 0;
  let lastResult: unknown;
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const textBlocks = message.content.filter((block) => block.type === 'textBlock');
    if (textBlocks.length > 0) {
      text = textBlocks.map((block) => (block as { text: string }).text).join('\n');
      toolResultsSince = 0;
      lastResult = undefined;
      continue;
    }
    const result = message.content.find((block) => block.type === 'toolResultBlock');
    if (result !== undefined) {
      toolResultsSince += 1;
      const payload = (result as { content: readonly unknown[] }).content[0];
      lastResult = isRecord(payload) && payload.type === 'jsonBlock'
        ? payload.json
        : isRecord(payload) && typeof payload.text === 'string'
          ? safeJson(payload.text)
          : undefined;
    }
  }
  return { text, toolResultsSince, lastResult };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file) && Date.now() < deadline) await delay(20);
  if (!existsSync(file)) throw new Error(`task-wake fixture: ${file} never appeared`);
}

class TaskWakeModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.task-wake-pty', contextWindowLimit: 200_000 };
  private calls = 0;

  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }

  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    const prompt = latestPrompt(messages);
    // The `bash` description travels in every request: the suite asserts the per-runtime
    // wording (wake variant with the key on, no-wake variant with `backgroundTaskWake: false`).
    const bashDescription = options?.toolSpecs?.find((spec) => spec.name === 'bash')?.description;
    // A child never sees the delegation tools (SER-064); the parent does. The SDK's
    // delivered `strands_background_task_result` pairs are logged so the suite can prove
    // which request carried a delegation's report (SER-070).
    const isParent = options?.toolSpecs?.some((spec) => spec.name === 'subagent') === true;
    const pairTaskIds = messages.flatMap((message) => message.content.flatMap((block) =>
      block.type === 'toolUseBlock' && block.name === 'strands_background_task_result' ? [block.toolUseId] : []));
    appendFileSync(CALLS, `${JSON.stringify({ call: this.calls, userText: prompt.text, bashDescription, role: isParent ? 'parent' : 'child', pairTaskIds })}\n`);
    yield { type: 'modelMessageStartEvent', role: 'assistant' };

    const [verb, marker = 'marker'] = prompt.text.trim().split(/\s+/, 2) as [string, string?];
    const step = prompt.toolResultsSince;
    const startedTaskId = isRecord(prompt.lastResult) && typeof prompt.lastResult.taskId === 'string'
      ? prompt.lastResult.taskId
      : undefined;

    const toolCall = (name: string, id: string, input: unknown): ModelStreamEvent[] => [
      { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name, toolUseId: id } },
      { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(input) } },
      { type: 'modelContentBlockStopEvent' },
    ];
    const start = (command: string): ModelStreamEvent[] =>
      toolCall('bash', `start-${this.calls}`, { mode: 'start', command });

    let events: ModelStreamEvent[] | undefined;
    let text: string | undefined;
    let holdOpen = false;

    if (prompt.text.includes('<task-notification')) {
      const task = /task="([^"]+)"/.exec(prompt.text)?.[1] ?? 'unknown';
      text = `acknowledged wake for ${task}`;
    } else if (!isParent && verb === 'count') {
      // The background child (SER-070): long enough for the dispatching turn to end and
      // for the suite to try `/clear` while the delegation is tracked.
      await delay(3_000);
      text = `child counted ${marker}`;
    } else if (verb === 'delegate-idle') {
      if (step === 0) {
        events = toolCall('subagent', `deleg-${this.calls}`, { task: `count ${marker}`, _background_execution: true });
      } else text = `dispatched ${marker}`;
    } else if (verb === 'start-activity' || verb === 'start-activity-block') {
      if (step === 0) {
        events = start(`while [ ! -f activity-release-${marker} ]; do sleep .05; done; echo ${marker}; exit ${marker === 'failure' ? 7 : 0}`);
      } else {
        text = `started activity job ${marker}`;
        holdOpen = verb === 'start-activity-block';
      }
    } else if (verb === 'start-idle') {
      if (step === 0) events = start(`sleep 2; echo ${marker}`);
      else text = `started idle job ${marker}`;
    } else if (verb === 'start-and-wait') {
      if (step === 0) events = start(`sleep 0.3; echo ${marker}`);
      else if (step === 1 && startedTaskId !== undefined) {
        events = toolCall('bash', `wait-${this.calls}`, {
          mode: 'wait', taskId: startedTaskId, waitMs: 10_000, wakeOnOutput: false,
        });
      } else text = `waited job ${marker} to its end`;
    } else if (verb === 'start-then-block') {
      if (step === 0) events = start(`sleep 0.5; echo ${marker}`);
      else {
        text = `holding the answer open for ${marker}`;
        holdOpen = true;
      }
    } else if (verb === 'start-many-block') {
      if (step < 19) events = start(`echo ${marker}-${step}${step === 0 ? '; exit 1' : ''}`);
      else {
        text = `holding nineteen notifications for ${marker}`;
        holdOpen = true;
      }
    } else if (verb === 'start-then-permission') {
      if (step === 0) events = start(`sleep 1.5; echo ${marker}`);
      else if (step === 1) {
        // A foreground `sleep` is not on the static safe-command list, so in `default`
        // mode this call opens a permission prompt while the job above is still running.
        events = toolCall('bash', `gated-${this.calls}`, { mode: 'execute', command: `sleep 0.1; echo gated-${marker}` });
      } else text = `gated command done for ${marker}`;
    } else if (verb === 'start-clear-window') {
      if (step === 0) events = start(`sleep 2.5; echo ${marker}`);
      else text = `started clear-window job ${marker}`;
    } else {
      text = 'ok';
    }

    if (events !== undefined) {
      yield* events;
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }

    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: `${text ?? 'ok'}\n` } };
    if (holdOpen) {
      // Keep the model stream open so the job finishes mid-turn; the suite releases it
      // once it has proven the wake is queued and not yet sent.
      writeFileSync(BLOCK_CHECKPOINT, 'blocked\n');
      await waitForFile(BLOCK_RELEASE, 30_000);
    }
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

const model = new TaskWakeModel();
let creations = 0;
setRuntimeModelFactoryForTest(async () => {
  creations += 1;
  // The second model creation of the process is the `/clear` successor's — when the
  // suite has armed the window: hold its assembly so a job can finish, and its wake be
  // queued, while `/clear` is in flight. Unarmed (the delegation session), a background
  // child's model is the second creation and must not be held.
  if (creations === 2 && existsSync(CLEAR_ARM)) await waitForFile(CLEAR_RELEASE, 30_000);
  return model;
});
await import('../../src/cli.js');

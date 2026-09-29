/**
 * Fixture CLI for `spike/verify-tui.ts goal` (SER-108): the real TUI with two local scripted
 * models, so the whole `/goal` loop runs with no provider.
 *
 * The runtime model factory hands out one of two models by the config it is asked for: the
 * check call is the one built with `maxTokens === GOAL_CHECK_MAX_TOKENS`, everything else is
 * the agent. Behaviour is scripted by `goal-control.json` in the working directory, re-read on
 * every call, so the pty suite can change it between phases:
 *
 * - `holdPromptCalls: number[]`   agent prompt-calls (1-based, one per new user message) whose
 *                                 stream is held open after a text line until the file
 *                                 `goal-release-<n>` exists or the turn's cancel signal fires.
 * - `toolPromptCalls: number[]`   prompt-calls that first issue a permission-gated `bash` call.
 * - `jobPromptCalls: number[]`    prompt-calls that first `bash start` a 1 s job (`echo wake-done`), so
 *                                 a background-task wake lands while a held turn is running.
 * - `finishPromptCall: number`    the prompt-call that answers with `DONE: ...` (the check model
 *                                 answers "met" exactly when the record contains `DONE`).
 * - `checkHold: boolean`          the check call hangs until `goal-check-release` exists or its
 *                                 cancel signal fires (a provider that ignores it is covered by
 *                                 the unit suite).
 * - `checkFail: boolean`          the check call throws.
 *
 * Every model call appends one line to `goal-events.log`, and the suite's `!` command appends
 * `shell` to the same file, so ordering across agent turns, checks and shell runs is one file:
 *   `agent <n> <prompt|tool-result> <wake | continuation | last line of the newest user text>`
 *   `check <n> tools=<lines> condition=<goal>`
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Model } from '@strands-agents/sdk';
import type { BaseModelConfig, Message, ModelStreamEvent, StreamOptions } from '@strands-agents/sdk';

import { GOAL_CHECK_MAX_TOKENS } from '../../src/agent/goal-check.js';
import { setRuntimeModelFactoryForTest } from '../../src/agent/runtime.js';

const EVENTS = path.join(process.cwd(), 'goal-events.log');
const CONTROL = path.join(process.cwd(), 'goal-control.json');

interface Control {
  holdPromptCalls?: number[];
  toolPromptCalls?: number[];
  jobPromptCalls?: number[];
  finishPromptCall?: number;
  checkHold?: boolean;
  checkFail?: boolean;
}

function control(): Control {
  try {
    return JSON.parse(readFileSync(CONTROL, 'utf8')) as Control;
  } catch {
    return {};
  }
}

function log(line: string): void {
  appendFileSync(EVENTS, `${line}\n`);
}

function textOf(message: Message): string {
  return message.content.map((block) => (block.type === 'textBlock' ? block.text : '')).join('');
}

async function untilFileOrAbort(file: string, signal: AbortSignal | undefined, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file) && !(signal?.aborted ?? false) && Date.now() < deadline) await delay(25);
}

/**
 * What a prompt was, for the ordered log: a wake, a goal continuation, or the last line of
 * what the user typed (a held `!` report rides ahead of the next prompt, so the last line
 * is the prompt itself).
 */
function promptLabel(text: string): string {
  if (text.includes('<task-notification')) return 'wake';
  if (text.includes('The goal set for this session is not yet met')) return 'continuation';
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return (lines[lines.length - 1] ?? '').slice(0, 48);
}

function* textReply(text: string): Generator<ModelStreamEvent> {
  yield { type: 'modelContentBlockStartEvent' };
  yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } };
  yield { type: 'modelContentBlockStopEvent' };
}

class GoalAgentModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.goal-agent', contextWindowLimit: 200_000 };
  private calls = 0;
  private promptCalls = 0;

  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }

  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    const last = messages[messages.length - 1];
    const isToolResult = last !== undefined && last.content.some((block) => block.type === 'toolResultBlock');
    const newestUser = [...messages].reverse().find((message) => message.role === 'user' && textOf(message) !== '');
    const userText = newestUser === undefined ? '' : promptLabel(textOf(newestUser));
    if (!isToolResult) this.promptCalls += 1;
    const promptCall = this.promptCalls;
    log(`agent ${promptCall} ${isToolResult ? 'tool-result' : 'prompt'} ${userText}`);
    const script = control();

    yield { type: 'modelMessageStartEvent', role: 'assistant' };

    if (!isToolResult && (script.toolPromptCalls ?? []).includes(promptCall)) {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'bash', toolUseId: `goal-tool-${promptCall}` } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify({ mode: 'execute', command: `printf ran > goal-permission-sentinel-${promptCall}.txt` }) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }

    if (!isToolResult && (script.jobPromptCalls ?? []).includes(promptCall)) {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'bash', toolUseId: `goal-job-${promptCall}` } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify({ mode: 'start', command: 'sleep 1; echo wake-done' }) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }

    const finish = script.finishPromptCall === promptCall && !isToolResult;
    yield* textReply(finish ? `DONE: everything is finished (turn ${promptCall})\n` : `progress ${promptCall}: still working\n`);
    if (!isToolResult && (script.holdPromptCalls ?? []).includes(promptCall)) {
      await untilFileOrAbort(path.join(process.cwd(), `goal-release-${promptCall}`), options?.cancelSignal);
    }
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

class GoalCheckModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.goal-check', contextWindowLimit: 200_000 };
  private calls = 0;

  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }

  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    const request = messages.map(textOf).join('\n');
    const condition = /<goal>\n([\s\S]*?)\n<\/goal>/u.exec(request)?.[1] ?? '?';
    const record = /<turn-record>\n([\s\S]*?)\n<\/turn-record>/u.exec(request)?.[1] ?? '';
    const tools = (record.match(/^- .+$/gmu) ?? []).join(',').replace(/\s+/gu, '');
    log(`check ${this.calls} tools=${tools || 'none'} condition=${condition}`);
    const script = control();
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (script.checkFail === true) throw new Error('fixture check provider failure');
    if (script.checkHold === true) await untilFileOrAbort(path.join(process.cwd(), 'goal-check-release'), options?.cancelSignal);
    const met = record.includes('DONE');
    yield* textReply(JSON.stringify({ met, reason: met ? 'the record shows DONE' : `no DONE in check ${this.calls}` }));
    yield { type: 'modelMetadataEvent', usage: { inputTokens: 100 + this.calls, outputTokens: 7, totalTokens: 107 + this.calls } };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

const agent = new GoalAgentModel();
const check = new GoalCheckModel();
setRuntimeModelFactoryForTest(async (config) => (config.maxTokens === GOAL_CHECK_MAX_TOKENS ? check : agent));
await import('../../src/cli.js');

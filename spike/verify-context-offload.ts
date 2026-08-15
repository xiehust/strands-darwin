/**
 * Offline contracts for the flag-gated SDK ContextOffloader.
 *
 * No model calls and no network: a fake model asks for one tool call whose result
 * is deliberately larger than the offload threshold, and the assertions are on
 * what ends up in the conversation and in the tool catalogue.
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';

import {
  Agent,
  Model,
  tool,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
} from '@strands-agents/sdk';
import { ContextOffloader } from '@strands-agents/sdk/vended-plugins/context-offloader';
import { LocalFileStorage } from '@strands-agents/sdk/storage';
import { z } from 'zod';

import { classify } from '../src/agent/permission.js';
import { assert, header, report } from './shared.js';

const ROOT = '/tmp/darwin-context-offload-test';
const HUGE = 'x'.repeat(40_000);

class OneToolCallModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.offload', contextWindowLimit: 200_000 };

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    const hasResult = messages.some((message) =>
      message.content.some((block) => block.type === 'toolResultBlock'),
    );
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (!hasResult) {
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: 'bigOutput', toolUseId: 'offload-1' },
      };
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: '{}' },
      };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'ok' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

const bigOutput = tool({
  name: 'bigOutput',
  description: 'returns a deliberately oversized payload',
  inputSchema: z.object({}),
  callback: () => HUGE,
});

/** Mirrors the runtime's own assembly: plugin present only when the flag is on. */
function makeAgent(offload: boolean, directory: string): Agent {
  const offloader = offload
    ? new ContextOffloader({
        storage: new LocalFileStorage(directory),
        evictAfterCycles: null,
        // previewTokens must stay below maxResultTokens (the SDK enforces it), so
        // the fixture sets both rather than leaning on the 1000-token default.
        maxResultTokens: 200,
        previewTokens: 50,
      })
    : undefined;
  return new Agent({
    model: new OneToolCallModel(),
    tools: [bigOutput],
    plugins: offloader === undefined ? [] : [offloader],
    printer: false,
  });
}

function toolResultText(agent: Agent): string {
  const parts: string[] = [];
  for (const message of agent.messages) {
    for (const block of message.content) {
      if (block.type !== 'toolResultBlock') continue;
      for (const inner of (block as { content?: readonly unknown[] }).content ?? []) {
        const typed = inner as { type?: string; text?: string };
        if (typeof typed.text === 'string') parts.push(typed.text);
      }
    }
  }
  return parts.join('\n');
}

await rm(ROOT, { recursive: true, force: true });

header('context offload — flag on');
const on = makeAgent(true, path.join(ROOT, 'on'));
await on.initialize();
assert('the retrieval tool is registered when offloading is on',
  on.tools.some((entry) => entry.name === 'retrieve_offloaded_content'));
await on.invoke('go');
const onText = toolResultText(on);
assert('an oversized result is not carried verbatim in the conversation',
  !onText.includes(HUGE) && onText.length < HUGE.length);
assert('…and something is left behind as a preview or reference', onText.trim() !== '');

header('context offload — flag off');
const off = makeAgent(false, path.join(ROOT, 'off'));
await off.initialize();
assert('the retrieval tool is absent when offloading is off',
  !off.tools.some((entry) => entry.name === 'retrieve_offloaded_content'));
await off.invoke('go');
assert('the oversized result stays verbatim without the plugin',
  toolResultText(off).includes(HUGE));

header('context offload — references survive a process boundary');
// The premise behind both `evictAfterCycles: null` and the absence of offload
// cleanup (see runtime.ts): a *fresh* agent and plugin over the same directory
// — a stand-in for the next `--resume`d process — must still resolve a
// reference the previous one stored. Deleting or evicting would break exactly
// this, which is why the accumulation is documented rather than bounded.
const { readdir } = await import('node:fs/promises');
const storedKeys = await readdir(path.join(ROOT, 'on', 'offloader'));
const firstKey = storedKeys[0] as string;
assert('the first process left at least one stored block behind', storedKeys.length > 0);
const resumed = makeAgent(true, path.join(ROOT, 'on'));
await resumed.initialize();
const resumedRetrieval = resumed.tool['retrieve_offloaded_content'];
assert('a fresh agent over the same storage registers the retrieval tool', resumedRetrieval !== undefined);
const retrieved = await resumedRetrieval!.invoke({ reference: firstKey }, { recordDirectToolCall: false });
const retrievedText = (retrieved.content as readonly { text?: string }[])
  .map((block) => block.text ?? '')
  .join('');
assert('the stored reference resolves to the full offloaded content',
  retrieved.status !== 'error' && retrievedText.includes(HUGE));

header('context offload — permission classification');
const retrieval = classify('retrieve_offloaded_content', { reference: 'offloader/abc' });
assert('the retrieval tool is classified read, so it is statically safe',
  retrieval.kind === 'read');
assert('…and its summary names the reference it will read',
  retrieval.summary.includes('offloader/abc'));
const missingReference = classify('retrieve_offloaded_content', {});
assert('a missing reference still classifies as read rather than falling through',
  missingReference.kind === 'read' && missingReference.summary.includes('no reference'));
const unknownTool = classify('some_unregistered_tool', {});
assert('unrelated unknown tools still fail closed as execute', unknownTool.kind === 'execute');

await rm(ROOT, { recursive: true, force: true });
report();

/** Offline contracts for explicit conversation compaction and persisted resume. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  Agent,
  Message,
  Model,
  SessionManager,
  SummarizingConversationManager,
  TextBlock,
  type BaseModelConfig,
  type CountTokensOptions,
  type ModelStreamEvent,
  type StreamOptions,
} from '@strands-agents/sdk';
import { LocalFileStorage } from '@strands-agents/sdk/storage';
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor';

import { compactConversation, countConversationTokens } from '../src/agent/compact.js';
import { assert, header, report } from './shared.js';

class DeterministicModel extends Model<BaseModelConfig> {
  readonly counted: { messages: number; systemPrompt: unknown; toolNames: string[] }[] = [];
  private summaries = 0;
  private config: BaseModelConfig = { modelId: 'fake.compact', contextWindowLimit: 200_000 };
  failSummaries = false;

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async countTokens(messages: Message[], options?: CountTokensOptions): Promise<number> {
    this.counted.push({
      messages: messages.length,
      systemPrompt: options?.systemPrompt,
      toolNames: options?.toolSpecs?.map((tool) => tool.name) ?? [],
    });
    return super.countTokens(messages, options);
  }

  override async *stream(messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    if (this.failSummaries) throw new Error('summary unavailable');
    const summarizing = textOf(messages.at(-1)) === 'Please summarize this conversation.';
    const text = summarizing
      ? `summary-${++this.summaries}: retained marker-early`
      : `continued from: ${textOf(messages[0])}`;

    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

function textOf(message: Message | undefined): string {
  if (message === undefined) return '';
  return message.content
    .map((block) => (block.type === 'textBlock' ? block.text : ''))
    .join('');
}

function seededMessages(): Message[] {
  return Array.from({ length: 16 }, (_, index) =>
    new Message({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: [new TextBlock(index === 0 ? 'marker-early ' + 'x'.repeat(1000) : `message-${index} ${'x'.repeat(200)}`)],
    }),
  );
}

async function main(): Promise<void> {
  header('compact — summarize, continue, persist, resume, and roll back');
  const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-compact-'));
  const storage = new LocalFileStorage(root);
  const model = new DeterministicModel();
  const manager = new SummarizingConversationManager({ summaryRatio: 0.8, preserveRecentMessages: 4 });
  const sessionManager = new SessionManager({ sessionId: 'compact-test', storage, saveLatestOn: 'invocation' });
  const agent = new Agent({
    id: 'darwin',
    model,
    messages: seededMessages(),
    systemPrompt: 'assembled compact test prompt',
    tools: [fileEditor],
    conversationManager: manager,
    sessionManager,
    printer: false,
  });

  try {
    await agent.initialize();
    const recentBefore = agent.messages.slice(-4).map((message) => JSON.stringify(message));
    const result = await compactConversation({
      agent,
      model,
      manager,
      preserveRecentMessages: 4,
      persist: async () => sessionManager.saveSnapshot({ target: agent, isLatest: true }),
    });

    console.log(`  result: ${JSON.stringify(result)}`);
    assert('old messages collapse to one rolling summary plus four recent messages', agent.messages.length === 5);
    assert('the recent messages are unchanged', JSON.stringify(agent.messages.slice(-4).map((m) => JSON.stringify(m))) === JSON.stringify(recentBefore));
    assert('the summary preserves an early fact', textOf(agent.messages[0]).includes('marker-early'));
    assert('context token estimate shrinks', result.estimatedTokensSaved > 0 && result.estimatedTokensAfter < result.estimatedTokensBefore);
    assert('token counting includes the assembled system prompt', model.counted.every((call) => call.systemPrompt === agent.systemPrompt));
    assert('token counting includes registered tools', model.counted.every((call) => call.toolNames.includes('fileEditor')));

    const restoredModel = new DeterministicModel();
    const restored = new Agent({
      id: 'darwin',
      model: restoredModel,
      sessionManager: new SessionManager({ sessionId: 'compact-test', storage, saveLatestOn: 'invocation' }),
      printer: false,
    });
    await restored.initialize();
    assert('a fresh agent resumes the compacted message list', restored.messages.length === 5);

    let followUp = '';
    for await (const event of agent.stream('continue')) {
      if (
        event.type === 'modelStreamUpdateEvent' &&
        event.event.type === 'modelContentBlockDeltaEvent' &&
        event.event.delta.type === 'textDelta'
      ) {
        followUp += event.event.delta.text;
      }
    }
    assert('the live agent continues from the summary', followUp.includes('marker-early'));

    assert('the resumed summary still carries the early fact', textOf(restored.messages[0]).includes('marker-early'));

    const rollbackModel = new DeterministicModel();
    const rollback = new Agent({ model: rollbackModel, messages: seededMessages(), printer: false });
    await rollback.initialize();
    const rollbackBefore = JSON.stringify(rollback.messages);
    let failed = false;
    try {
      await compactConversation({
        agent: rollback,
        model: rollbackModel,
        manager: new SummarizingConversationManager({ summaryRatio: 0.8, preserveRecentMessages: 4 }),
        preserveRecentMessages: 4,
        persist: async () => {
          throw new Error('disk full');
        },
      });
    } catch (error) {
      failed = error instanceof Error && error.message === 'disk full';
    }
    assert('a persistence failure is propagated', failed);
    assert('a persistence failure restores every original message', JSON.stringify(rollback.messages) === rollbackBefore);

    let persisted = false;
    const noOp = await compactConversation({
      agent: restored,
      model: restored.model,
      manager: new SummarizingConversationManager({ summaryRatio: 0.8, preserveRecentMessages: 4 }),
      preserveRecentMessages: 4,
      persist: async () => {
        persisted = true;
      },
    });
    assert('an already compact conversation is a no-op', !noOp.compacted && !persisted);

    const counted = await countConversationTokens(model, agent);
    assert('the shared counter remains callable after a turn', counted > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  report();
}

await main();

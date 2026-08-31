/** Offline contracts for explicit conversation compaction and persisted resume. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  Agent,
  Message,
  Model,
  ReasoningBlock,
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

import {
  compactConversation,
  countConversationTokens,
  stripReasoningFromUserMessages,
} from '../src/agent/compact.js';
import { assert, header, report } from './shared.js';

class DeterministicModel extends Model<BaseModelConfig> {
  readonly counted: { messages: number; systemPrompt: unknown; toolNames: string[] }[] = [];
  private summaries = 0;
  private config: BaseModelConfig = { modelId: 'fake.compact', contextWindowLimit: 200_000 };
  failSummaries = false;
  /** Emit a reasoning block before the summary text, like adaptive thinking does. */
  emitReasoningOnSummaries = false;
  /** Emit only a reasoning block on summaries — a summary with no usable content. */
  reasoningOnlySummaries = false;

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
    if (summarizing && (this.emitReasoningOnSummaries || this.reasoningOnlySummaries)) {
      // Adaptive thinking: the summary response leads with a reasoning block,
      // assembled by streamAggregated from reasoningContentDelta events.
      yield { type: 'modelContentBlockStartEvent' };
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'reasoningContentDelta', text: 'thinking about the summary', signature: 'sig-1' },
      };
      yield { type: 'modelContentBlockStopEvent' };
      if (this.reasoningOnlySummaries) {
        yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
        return;
      }
    }
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

    // Regression: adaptive thinking puts reasoning blocks in the summary
    // response; unpatched, they land verbatim in the user-role summary message
    // and the next summarization pass (or any later request) is rejected by
    // the provider. preserveRecentMessages: 2 forces two reduce passes, so the
    // second pass summarizes a history containing the first pass's summary.
    const reasoningModel = new DeterministicModel();
    reasoningModel.emitReasoningOnSummaries = true;
    const reasoningAgent = new Agent({ model: reasoningModel, messages: seededMessages(), printer: false });
    await reasoningAgent.initialize();
    const reasoningResult = await compactConversation({
      agent: reasoningAgent,
      model: reasoningModel,
      manager: new SummarizingConversationManager({ summaryRatio: 0.8, preserveRecentMessages: 2 }),
      preserveRecentMessages: 2,
      persist: async () => {},
    });
    assert('compaction with a reasoning-emitting model succeeds', reasoningResult.compacted);
    assert(
      'no user message carries a reasoning block after compaction',
      reasoningAgent.messages.every(
        (message) => message.role !== 'user' || message.content.every((block) => block.type !== 'reasoningBlock'),
      ),
    );
    const rollingSummary = reasoningAgent.messages[0];
    assert('the rolling summary stays a user message', rollingSummary?.role === 'user');
    assert('the rolling summary still carries the summary text', textOf(rollingSummary).includes('marker-early'));
    assert(
      'a second summarization pass over the compacted history succeeded',
      textOf(rollingSummary).includes('summary-2'),
    );

    // A summary response with nothing but reasoning is a failed summary:
    // proactive reduce swallows it and reports no reduction — never an empty
    // user message spliced into the history.
    const emptyModel = new DeterministicModel();
    emptyModel.reasoningOnlySummaries = true;
    const emptyAgent = new Agent({ model: emptyModel, messages: seededMessages(), printer: false });
    await emptyAgent.initialize();
    const emptyBefore = JSON.stringify(emptyAgent.messages);
    const emptyResult = await compactConversation({
      agent: emptyAgent,
      model: emptyModel,
      manager: new SummarizingConversationManager({ summaryRatio: 0.8, preserveRecentMessages: 4 }),
      preserveRecentMessages: 4,
      persist: async () => {},
    });
    assert('a reasoning-only summary response compacts nothing', !emptyResult.compacted);
    assert('a reasoning-only summary response mutates no message', JSON.stringify(emptyAgent.messages) === emptyBefore);

    // Restore-time repair for histories poisoned before the summarizer fix.
    const poisonedText = new TextBlock('## Conversation Summary\n* kept');
    const poisoned = new Message({
      role: 'user',
      content: [new ReasoningBlock({ text: 'leaked thinking', signature: 'sig' }), poisonedText],
    });
    const assistantThinking = new Message({
      role: 'assistant',
      content: [new ReasoningBlock({ text: 'legal assistant thinking' }), new TextBlock('answer')],
    });
    const cleanUser = new Message({ role: 'user', content: [new TextBlock('hello')] });
    const allReasoning = new Message({ role: 'user', content: [new ReasoningBlock({ text: 'only reasoning' })] });
    const history = [poisoned, assistantThinking, cleanUser, allReasoning];
    const repairedCount = stripReasoningFromUserMessages(history);
    assert('repair counts exactly the poisoned user message', repairedCount === 1);
    assert(
      'repair drops the reasoning and keeps the summary text',
      poisoned.content.length === 1 && poisoned.content[0] === poisonedText,
    );
    assert('repair preserves message object identity and order', history[0] === poisoned && history[1] === assistantThinking);
    assert(
      'assistant reasoning blocks are untouched',
      assistantThinking.content.length === 2 && assistantThinking.content[0]?.type === 'reasoningBlock',
    );
    assert('clean user messages are untouched', cleanUser.content.length === 1 && cleanUser.content[0]?.type === 'textBlock');
    assert('an all-reasoning user message is left intact rather than emptied', allReasoning.content.length === 1);
    assert('a clean list reports zero repairs', stripReasoningFromUserMessages([cleanUser, assistantThinking]) === 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  report();
}

await main();

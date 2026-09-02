/** Offline contracts for explicit conversation compaction and persisted resume. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  Agent,
  DEFAULT_SUMMARIZATION_PROMPT,
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
  COMPACT_FOCUS_HEADING,
  MAX_COMPACT_FOCUS_CODE_POINTS,
  SWALLOWED_SUMMARIZATION_FAILURE,
  compactConversation,
  compactFocusRefusal,
  compactionManagerConfig,
  countConversationTokens,
  createCompactionManager,
  focusedSummarizationPrompt,
  normalizeCompactFocus,
  stripReasoningFromUserMessages,
} from '../src/agent/compact.js';
import { assert, header, report } from './shared.js';

class DeterministicModel extends Model<BaseModelConfig> {
  readonly counted: { messages: number; systemPrompt: unknown; toolNames: string[] }[] = [];
  /** The system prompt of every summarization request, in call order. */
  readonly summaryPrompts: (StreamOptions['systemPrompt'])[] = [];
  private summaries = 0;
  private config: BaseModelConfig = { modelId: 'fake.compact', contextWindowLimit: 200_000 };
  /** 1-based index of the first summarization request that throws (Infinity: never). */
  failSummariesFrom = Number.POSITIVE_INFINITY;
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

  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const summarizing = textOf(messages.at(-1)) === 'Please summarize this conversation.';
    if (summarizing) {
      this.summaryPrompts.push(options?.systemPrompt);
      if (this.summaryPrompts.length >= this.failSummariesFrom) throw new Error('summary unavailable');
    }
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
  // The unfocused `/compact` manager, built exactly as the runtime builds it.
  const manager = createCompactionManager(4);
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
    // SER-051 (a): unfocused compaction sends the summarizer exactly the SDK default
    // prompt, and the summary is one user-role message of text only.
    assert('unfocused compaction made at least one summarization request', model.summaryPrompts.length > 0);
    assert(
      'unfocused compaction sends the summarizer exactly DEFAULT_SUMMARIZATION_PROMPT',
      model.summaryPrompts.every((prompt) => prompt === DEFAULT_SUMMARIZATION_PROMPT),
    );
    assert(
      'the unfocused summary is a user-role message carrying text blocks only',
      agent.messages[0]?.role === 'user' && agent.messages[0].content.every((block) => block.type === 'textBlock'),
    );
    assert(
      'the unfocused manager config has exactly the two pre-existing keys',
      JSON.stringify(compactionManagerConfig(4)) === JSON.stringify({ summaryRatio: 0.8, preserveRecentMessages: 4 }),
    );

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

    // A summary response with nothing but reasoning is a failed summary: the SDK's
    // proactive reduce swallows the throw and reports `false`. Before SER-052 that
    // read as a silent no-op; now it is the failure it is — rejected, everything
    // restored, never an empty user message spliced into the history.
    const emptyModel = new DeterministicModel();
    emptyModel.reasoningOnlySummaries = true;
    const emptyAgent = new Agent({ model: emptyModel, messages: seededMessages(), printer: false });
    await emptyAgent.initialize();
    const emptyBefore = JSON.stringify(emptyAgent.messages);
    let emptyError: unknown;
    try {
      await compactConversation({
        agent: emptyAgent,
        model: emptyModel,
        manager: new SummarizingConversationManager({ summaryRatio: 0.8, preserveRecentMessages: 4 }),
        preserveRecentMessages: 4,
        persist: async () => {},
      });
    } catch (error) {
      emptyError = error;
    }
    assert(
      'a reasoning-only summary response is a compaction failure, not a no-op',
      emptyError instanceof Error && emptyError.message === SWALLOWED_SUMMARIZATION_FAILURE,
    );
    assert('a reasoning-only summary response mutates no message', JSON.stringify(emptyAgent.messages) === emptyBefore);

    // SER-052 (a): two messages, preserve 0. The SDK summarizes at most 80% of the
    // list, so the one pass it makes replaces the oldest message with a summary of
    // itself and the count stays 2. Undo it, stop, report "already compact" — one
    // summarizer call, never a loop.
    const pairModel = new DeterministicModel();
    const pair = [
      new Message({ role: 'user', content: [new TextBlock('Reply with exactly COMPACT_SEED.')] }),
      new Message({ role: 'assistant', content: [new TextBlock('COMPACT_SEED')] }),
    ];
    const pairAgent = new Agent({ model: pairModel, messages: pair, printer: false });
    await pairAgent.initialize();
    const pairBefore = JSON.stringify(pairAgent.messages);
    let pairPersisted = false;
    const pairResult = await compactConversation({
      agent: pairAgent,
      model: pairModel,
      manager: createCompactionManager(0),
      preserveRecentMessages: 0,
      persist: async () => {
        pairPersisted = true;
      },
    });
    assert('2 messages / preserve 0 terminates with exactly one summarizer call', pairModel.summaryPrompts.length === 1);
    assert('2 messages / preserve 0 reports no compaction and the real count', !pairResult.compacted && pairResult.messagesAfter === 2 && pairResult.messagesBefore === 2);
    assert('2 messages / preserve 0 leaves the conversation byte-identical', JSON.stringify(pairAgent.messages) === pairBefore);
    assert('the undone pass keeps message identity', pairAgent.messages[0] === pair[0] && pairAgent.messages[1] === pair[1]);
    assert('2 messages / preserve 0 persists nothing', !pairPersisted);

    // SER-052 (a′): preserve 0 on a long history. Passes 1 and 2 shrink (16 → 5 → 2);
    // pass 3 would summarize the rolling summary alone without lowering the count,
    // so it is undone: the rolling summary is pass 2's, the newest message is the
    // original object, and exactly three summarizer calls were made.
    const floorModel = new DeterministicModel();
    const floorSeed = seededMessages();
    const floorAgent = new Agent({ model: floorModel, messages: floorSeed, printer: false });
    await floorAgent.initialize();
    const floorResult = await compactConversation({
      agent: floorAgent,
      model: floorModel,
      manager: createCompactionManager(0),
      preserveRecentMessages: 0,
      persist: async () => {},
    });
    assert('preserve 0 on 16 messages makes exactly three summarizer calls', floorModel.summaryPrompts.length === 3);
    assert('preserve 0 on 16 messages compacts to two messages and says so', floorResult.compacted && floorResult.messagesAfter === 2 && floorAgent.messages.length === 2);
    assert('the undone final pass leaves pass 2 as the rolling summary', textOf(floorAgent.messages[0]).includes('summary-2') && !textOf(floorAgent.messages[0]).includes('summary-3'));
    assert('the newest message survives preserve-0 compaction by identity', floorAgent.messages[1] === floorSeed[15]);

    // SER-052 (b): the summarizer fails on the second pass. The SDK swallows the
    // throw and returns `false`; darwin must reject and restore every message —
    // never report the first pass as `compacted: true`.
    const secondFailModel = new DeterministicModel();
    secondFailModel.failSummariesFrom = 2;
    const secondFailAgent = new Agent({ model: secondFailModel, messages: seededMessages(), printer: false });
    await secondFailAgent.initialize();
    const secondFailBefore = JSON.stringify(secondFailAgent.messages);
    let secondFailPersisted = false;
    let secondFailError: unknown;
    try {
      await compactConversation({
        agent: secondFailAgent,
        model: secondFailModel,
        manager: createCompactionManager(2),
        preserveRecentMessages: 2,
        persist: async () => {
          secondFailPersisted = true;
        },
      });
    } catch (error) {
      secondFailError = error;
    }
    assert('a second-pass summarizer failure made exactly two summarizer calls', secondFailModel.summaryPrompts.length === 2);
    assert('a second-pass summarizer failure rejects naming the swallowed failure', secondFailError instanceof Error && secondFailError.message === SWALLOWED_SUMMARIZATION_FAILURE);
    assert('a second-pass summarizer failure restores every original message', JSON.stringify(secondFailAgent.messages) === secondFailBefore);
    assert('a second-pass summarizer failure persists nothing', !secondFailPersisted);

    // SER-052 (c): the summarizer fails on the first pass — same failure path.
    const firstFailModel = new DeterministicModel();
    firstFailModel.failSummariesFrom = 1;
    const firstFailAgent = new Agent({ model: firstFailModel, messages: seededMessages(), printer: false });
    await firstFailAgent.initialize();
    const firstFailBefore = JSON.stringify(firstFailAgent.messages);
    let firstFailError: unknown;
    try {
      await compactConversation({
        agent: firstFailAgent,
        model: firstFailModel,
        manager: createCompactionManager(4),
        preserveRecentMessages: 4,
        persist: async () => {},
      });
    } catch (error) {
      firstFailError = error;
    }
    assert('a first-pass summarizer failure made exactly one summarizer call', firstFailModel.summaryPrompts.length === 1);
    assert('a first-pass summarizer failure rejects', firstFailError instanceof Error && firstFailError.message === SWALLOWED_SUMMARIZATION_FAILURE);
    assert('a first-pass summarizer failure restores every original message', JSON.stringify(firstFailAgent.messages) === firstFailBefore);

    // SER-051 (b): a focused compaction's summarizer prompt is the SDK default
    // verbatim, one blank line, the fixed heading, then the focus — each once.
    const focus = 'keep every file path and the failing test name';
    const focusedPrompt = focusedSummarizationPrompt(focus);
    assert('the focused prompt starts with DEFAULT_SUMMARIZATION_PROMPT and a blank line', focusedPrompt.startsWith(`${DEFAULT_SUMMARIZATION_PROMPT}\n\n`));
    assert('the focused prompt ends with the fixed heading and the focus', focusedPrompt.endsWith(`${COMPACT_FOCUS_HEADING}\n${focus}`));
    assert('the default prompt appears exactly once in the focused prompt', focusedPrompt.split(DEFAULT_SUMMARIZATION_PROMPT).length === 2);
    assert('the focus appears exactly once in the focused prompt', focusedPrompt.split(focus).length === 2);
    assert(
      'the focused manager config adds only summarizationSystemPrompt',
      JSON.stringify(compactionManagerConfig(4, focus)) ===
        JSON.stringify({ summaryRatio: 0.8, preserveRecentMessages: 4, summarizationSystemPrompt: focusedPrompt }),
    );
    assert('normalizeCompactFocus trims', normalizeCompactFocus('  keep paths \n') === 'keep paths');
    assert('a blank focus is no focus', normalizeCompactFocus('   ') === undefined && normalizeCompactFocus(undefined) === undefined);
    assert('a focus at the cap is accepted', compactFocusRefusal('é'.repeat(MAX_COMPACT_FOCUS_CODE_POINTS)) === undefined);

    // (d) the reasoning scrub applies to a focused summary too; preserveRecentMessages: 2
    // forces two reduce passes, so the second summarizes the first focused summary.
    const focusedModel = new DeterministicModel();
    focusedModel.emitReasoningOnSummaries = true;
    const focusedAgent = new Agent({ model: focusedModel, messages: seededMessages(), printer: false });
    await focusedAgent.initialize();
    const focusedResult = await compactConversation({
      agent: focusedAgent,
      model: focusedModel,
      manager: createCompactionManager(2, focus),
      preserveRecentMessages: 2,
      persist: async () => {},
    });
    assert('focused compaction with a reasoning-emitting model succeeds', focusedResult.compacted);
    assert('focused compaction made summarization requests', focusedModel.summaryPrompts.length >= 2);
    assert('every focused summarization request carries the focused prompt', focusedModel.summaryPrompts.every((prompt) => prompt === focusedPrompt));
    assert(
      'no user message carries a reasoning block after focused compaction',
      focusedAgent.messages.every(
        (message) => message.role !== 'user' || message.content.every((block) => block.type !== 'reasoningBlock'),
      ),
    );
    assert('the focused rolling summary stays a user message with its text', focusedAgent.messages[0]?.role === 'user' && textOf(focusedAgent.messages[0]).includes('summary-2'));

    // SER-052 (e): the focused manager runs through the same loop, so it inherits
    // the no-shrink guard — one focused summarizer call, then "already compact".
    const focusedPairModel = new DeterministicModel();
    const focusedPairAgent = new Agent({
      model: focusedPairModel,
      messages: [
        new Message({ role: 'user', content: [new TextBlock('Reply with exactly COMPACT_SEED.')] }),
        new Message({ role: 'assistant', content: [new TextBlock('COMPACT_SEED')] }),
      ],
      printer: false,
    });
    await focusedPairAgent.initialize();
    const focusedPairBefore = JSON.stringify(focusedPairAgent.messages);
    const focusedPairResult = await compactConversation({
      agent: focusedPairAgent,
      model: focusedPairModel,
      manager: createCompactionManager(0, focus),
      preserveRecentMessages: 0,
      persist: async () => {},
    });
    assert('a focused 2-message / preserve-0 compaction makes exactly one focused summarizer call', focusedPairModel.summaryPrompts.length === 1 && focusedPairModel.summaryPrompts[0] === focusedPrompt);
    assert('a focused 2-message / preserve-0 compaction is an honest no-op', !focusedPairResult.compacted && JSON.stringify(focusedPairAgent.messages) === focusedPairBefore);

    // (c) an over-cap focus is refused before any manager, hook, or model call exists.
    const overCap = 'x'.repeat(MAX_COMPACT_FOCUS_CODE_POINTS + 1);
    const refusal = compactFocusRefusal(overCap);
    assert(
      'an over-cap focus yields a notice naming the length and the cap',
      refusal !== undefined && refusal.includes(String(MAX_COMPACT_FOCUS_CODE_POINTS + 1)) && refusal.includes(String(MAX_COMPACT_FOCUS_CODE_POINTS)),
    );
    assert('a surrogate-pair focus is measured in code points', compactFocusRefusal('😀'.repeat(MAX_COMPACT_FOCUS_CODE_POINTS)) === undefined);
    let overCapError: unknown;
    try {
      createCompactionManager(4, overCap);
    } catch (error) {
      overCapError = error;
    }
    assert('creating a manager with an over-cap focus throws the same notice', overCapError instanceof Error && overCapError.message === refusal);
    // The runtime refuses before its PreCompact hook, so nothing downstream (hook,
    // reduce loop, model) can run for an over-cap focus.
    const runtimeSource = await readFile(new URL('../src/agent/runtime.ts', import.meta.url), 'utf8');
    const compactBody = runtimeSource.slice(runtimeSource.indexOf('async compact(focus?: string)'));
    const managerAt = compactBody.indexOf('createCompactionManager(');
    const hookAt = compactBody.indexOf('preCompact(');
    assert('runtime.compact builds (and so refuses) the manager before the PreCompact hook', managerAt !== -1 && hookAt !== -1 && managerAt < hookAt);

    // (e) the default prompt is imported from the package root, never a deep path or a copy.
    const compactSource = await readFile(new URL('../src/agent/compact.ts', import.meta.url), 'utf8');
    assert(
      'compact.ts imports DEFAULT_SUMMARIZATION_PROMPT from the @strands-agents/sdk root',
      /import \{[^}]*\bDEFAULT_SUMMARIZATION_PROMPT\b[^}]*\} from '@strands-agents\/sdk';/u.test(compactSource),
    );
    assert('compact.ts never deep-imports context-compression', !/from '@strands-agents\/sdk\/[^']*context-compression/u.test(compactSource));
    assert('compact.ts carries no copy of the SDK prompt text', !compactSource.includes('You are a conversation summarizer'));
    const [firstPromptLine = ''] = DEFAULT_SUMMARIZATION_PROMPT.split('\n');
    assert('the root re-export is the SDK prompt (its first line reads as the summarizer instruction)', firstPromptLine.startsWith('You are a conversation summarizer'));

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

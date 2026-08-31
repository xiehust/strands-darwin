/**
 * Offline contracts for the per-model-call session stats (issue #8 follow-up A):
 * tally arithmetic, tool-shape counting over both content shapes, the
 * unknown-is-never-zero usage sums, the bounded recent window, and the shared
 * renderers every surface derives from. No model, no network.
 *
 * Run: pnpm tsx spike/verify-call-stats.ts
 */
import type { AppConfig } from '../src/config.js';
import {
  RECENT_CALL_WINDOW,
  averageRequestInputTokens,
  countToolUses,
  describeCallEfficiency,
  emptyCallStats,
  recordCompletedCall,
  type SessionCallStats,
} from '../src/agent/call-stats.js';
import { assert, header, report } from './shared.js';

function config(provider: 'bedrock' | 'anthropic' | 'openai', openaiApi?: 'chat' | 'responses'): AppConfig {
  return {
    provider,
    model: provider === 'openai' ? 'openai.gpt-5.6-sol' : 'global.anthropic.claude-opus-5',
    region: 'us-east-1',
    maxTokens: 1000,
    permissionMode: 'default',
    promptCache: false,
    thinkingEffort: 'high',
    summaryRatio: 0.8,
    contextWarnRatio: 0.8,
    contextOffload: true,
    preserveRecentMessages: 4,
    ...(openaiApi !== undefined && { openaiApi }),
    modelChoices: [],
  };
}

/** One completed call as `afterModelCallEvent.stopData` shapes it. */
function call(usage: Record<string, number> | undefined, content: unknown): { message: { metadata?: { usage?: unknown }; content?: unknown } } {
  return { message: { ...(usage === undefined ? {} : { metadata: { usage } }), content } };
}

const toolUse = { type: 'toolUseBlock', name: 'bash', toolUseId: 'x', input: {} };
const text = { type: 'textBlock', text: 'an answer' };

function tallyContracts(): void {
  header('call stats — tally arithmetic');
  let stats = emptyCallStats();
  assert('the empty state counts nothing and reports no usage',
    stats.calls === 0 && stats.meteredCalls === 0 && stats.usage === undefined &&
    stats.noTool === 0 && stats.singleTool === 0 && stats.multiTool === 0 &&
    stats.recentToolUseCounts.length === 0);

  const before = stats;
  stats = recordCompletedCall(stats, call({ inputTokens: 100, outputTokens: 10, totalTokens: 110 }, [toolUse]));
  assert('the update is pure: the previous value is untouched',
    before.calls === 0 && before.usage === undefined && before.recentToolUseCounts.length === 0);
  assert('one single-tool metered call is counted in every dimension',
    stats.calls === 1 && stats.meteredCalls === 1 && stats.singleTool === 1 &&
    stats.usage?.inputTokens === 100 && stats.usage.outputTokens === 10 &&
    stats.recentToolUseCounts.length === 1 && stats.recentToolUseCounts[0] === 1);

  stats = recordCompletedCall(stats, call({ inputTokens: 200, outputTokens: 20, totalTokens: 220, cacheReadInputTokens: 50 }, [toolUse, toolUse, text]));
  stats = recordCompletedCall(stats, call({ inputTokens: 300, outputTokens: 30, totalTokens: 330 }, [text]));
  assert('tool shapes split into single, multi and none',
    stats.calls === 3 && stats.singleTool === 1 && stats.multiTool === 1 && stats.noTool === 1);
  assert('raw usage sums across metered calls', stats.usage?.inputTokens === 600 && stats.usage.outputTokens === 60);
  assert('a cache metric one call reported is present as its sum, silent calls adding nothing',
    stats.usage?.cacheReadInputTokens === 50);
  assert('a cache metric no call reported stays an absent key, never 0',
    stats.usage !== undefined && !Object.hasOwn(stats.usage, 'cacheWriteInputTokens'));
}

function unknownUsageContracts(): void {
  header('call stats — unknown metrics stay unknown');
  let stats = emptyCallStats();
  stats = recordCompletedCall(stats, call(undefined, [toolUse]));
  assert('an unmetered call counts as a call and shapes the window, but not the sums',
    stats.calls === 1 && stats.meteredCalls === 0 && stats.usage === undefined &&
    stats.singleTool === 1 && stats.recentToolUseCounts[0] === 1);
  assert('with no metered call the average is unknown, never 0',
    averageRequestInputTokens(stats, config('bedrock')) === undefined);

  stats = recordCompletedCall(stats, { message: { metadata: { usage: { inputTokens: 'NaN-ish', outputTokens: 5 } }, content: [] } });
  assert('a malformed usage payload is not a measurement',
    stats.calls === 2 && stats.meteredCalls === 0 && stats.usage === undefined);
  stats = recordCompletedCall(stats, {});
  assert('a missing message still counts the completed call, with zero tools',
    stats.calls === 3 && stats.noTool === 2);
}

function toolCountingContracts(): void {
  header('call stats — toolUse counting over both content shapes');
  assert('in-memory blocks are counted by their type discriminator',
    countToolUses([toolUse, text, toolUse]) === 2);
  assert('the serialized wire shape (toJSON drops the discriminator) is counted too',
    countToolUses([{ toolUse: { name: 'bash' } }, { text: 'hi' }]) === 1);
  assert('a typed non-tool block carrying a toolUse-like key is not double counted',
    countToolUses([{ type: 'textBlock', toolUse: 'coincidence' }]) === 0);
  assert('non-array and junk content count zero tools rather than throwing',
    countToolUses(undefined) === 0 && countToolUses('text') === 0 && countToolUses([null, 42]) === 0);
}

function windowContracts(): void {
  header('call stats — bounded recent window');
  let stats = emptyCallStats();
  for (let index = 0; index < RECENT_CALL_WINDOW + 5; index += 1) {
    stats = recordCompletedCall(stats, call(undefined, index < 5 ? [toolUse, toolUse] : [toolUse]));
  }
  assert('the window holds exactly the last ten calls',
    stats.recentToolUseCounts.length === RECENT_CALL_WINDOW);
  assert('the oldest entries fell out and order is oldest-first',
    stats.recentToolUseCounts.every((count) => count === 1) && stats.calls === RECENT_CALL_WINDOW + 5);
}

function averageContracts(): void {
  header('call stats — average request input per call');
  const metered: SessionCallStats = {
    ...emptyCallStats(),
    calls: 2,
    meteredCalls: 2,
    usage: { inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 100, cacheWriteInputTokens: 40 },
  };
  assert('bedrock request input sums uncached input with cache reads and writes',
    averageRequestInputTokens(metered, config('bedrock')) === 80);
  assert('openai Responses input is already the request total and is not summed again',
    averageRequestInputTokens(metered, config('openai', 'responses')) === 10);
  const partial: SessionCallStats = {
    ...metered,
    usage: { inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 100 },
  };
  assert('a missing Responses cache subset does not hide the request total (input_tokens is the request)',
    averageRequestInputTokens(partial, config('openai', 'responses')) === 10);
  assert('a cache-silent provider averages over its input alone',
    averageRequestInputTokens(
      { ...metered, usage: { inputTokens: 21, outputTokens: 5 } },
      config('bedrock'),
    ) === 11);
}

function rendererContracts(): void {
  header('call stats — shared one-line renderer');
  const stats: SessionCallStats = {
    calls: 12,
    meteredCalls: 12,
    usage: { inputTokens: 1200, outputTokens: 240, cacheReadInputTokens: 46_800 },
    noTool: 2,
    singleTool: 8,
    multiTool: 2,
    recentToolUseCounts: [1, 1, 0, 1, 2, 1, 1, 1, 0, 1],
  };
  const line = describeCallEfficiency(stats, config('bedrock'));
  assert('the line names the count, the average and every tool shape',
    line === '12 completed · avg request input 4,000 · tool responses 8 single / 2 multi / 2 none');
  const unknown = describeCallEfficiency({ ...stats, meteredCalls: 0, usage: undefined }, config('bedrock'));
  assert('an unknown average reads not reported, never 0',
    unknown.includes('avg request input not reported') && !unknown.includes('avg request input 0'));
  assert('the renderer emits one line', !line.includes('\n') && !unknown.includes('\n'));
}

tallyContracts();
unknownUsageContracts();
toolCountingContracts();
windowContracts();
averageContracts();
rendererContracts();
report();

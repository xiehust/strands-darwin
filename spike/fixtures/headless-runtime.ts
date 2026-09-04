import { appendFileSync, writeFileSync } from 'node:fs';

import { ContextWindowOverflowError, ModelError, type AgentStreamEvent } from '@strands-agents/sdk';

import { NEVER_WITHDRAWN } from '../../src/agent/permission.js';
import type { AgentRuntime, RuntimeOptions } from '../../src/agent/runtime.js';
import type { ModelPriceLookup, ModelUsageShare } from '../../src/agent/cost.js';
import type { AppConfig } from '../../src/config.js';

const config: AppConfig = {
  provider: 'openai',
  model: 'fake.headless',
  region: 'us-east-1',
  maxTokens: 100,
  permissionMode: 'default',
  promptCache: false,
  thinkingEffort: 'low',
  summaryRatio: 0.8,
  contextWarnRatio: 0.8,
  contextOffload: true,
  preserveRecentMessages: 4,
  openaiApi: 'chat',
  modelChoices: [],
};

function event(value: unknown): AgentStreamEvent {
  return value as AgentStreamEvent;
}

export async function createRuntime(options: RuntimeOptions): Promise<AgentRuntime> {
  const mode = process.env['DARWIN_HEADLESS_FIXTURE_MODE'] ?? 'success';
  if (mode === 'runtime-failure') throw new Error('fixture runtime failed');
  const expectedProjectRoot = process.env['DARWIN_HEADLESS_FIXTURE_EXPECTED_PROJECT_ROOT'];
  if (expectedProjectRoot === undefined || options.projectRoot !== expectedProjectRoot) {
    throw new Error(
      `fixture project root mismatch: expected ${JSON.stringify(expectedProjectRoot)}, got ${JSON.stringify(options.projectRoot)}`,
    );
  }
  const traceFile = process.env['DARWIN_HEADLESS_FIXTURE_TRACE'];
  if (traceFile !== undefined) {
    appendFileSync(traceFile, `${JSON.stringify({
      type: 'create',
      maxModelCalls: options.maxModelCalls,
      contextOffloadOverride: options.contextOffloadOverride,
    })}\n`);
  }

  const sessionId = options.session.kind === 'id' ? options.session.sessionId : 'session-fixture';
  options.onSessionResolved?.(sessionId);
  let cancelled = false;
  let sends = 0;


  const readyFile = process.env['DARWIN_HEADLESS_FIXTURE_READY'];
  if (readyFile !== undefined) writeFileSync(readyFile, 'ready\n');

  // The real runtime's modelPrice is `unavailable` until the background fetch has
  // recorded the id; only the priced modes carry rates, so every other mode's exact
  // stderr doubles as proof that an unpriced run says so rather than 0.
  const modelPrice: ModelPriceLookup = mode === 'priced' || mode === 'mixed-models'
    ? {
        kind: 'priced',
        litellmKey: 'openai/fake.headless',
        rates: { inputCostPerToken: 0.001, outputCostPerToken: 0.01, cacheReadInputTokenCost: 0.0001 },
      }
    : { kind: 'unavailable' };
  const usage = { inputTokens: 12, outputTokens: 3, cacheReadInputTokens: 0 };
  // The real runtime's modelShares is exactly one share over the whole meter until a
  // `/model` switch ran a turn; the mixed-models mode is the switched shape — a
  // second, priced share on another model — so the record's multi-model rendering
  // is asserted through the real runner.
  const modelShares: ModelUsageShare[] = mode === 'mixed-models'
    ? [
        { config, usage: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0 }, lookup: modelPrice },
        {
          config: { ...config, model: 'fake.second' },
          usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0 },
          lookup: { kind: 'priced', litellmKey: 'openai/fake.second', rates: { inputCostPerToken: 0.002, outputCostPerToken: 0.02, cacheReadInputTokenCost: 0.0002 } },
        },
      ]
    : [{ config, usage, lookup: modelPrice }];

  return {
    info: {
      sessionId,
      permissionMode: 'default',
      resumed: false,
      diagnosticsFile: undefined,
    },
    config,
    usage,
    // The real runtime's childUsage is undefined until a dispatch reports usage;
    // every mode but child-usage keeps that zero-dispatch shape so the exact
    // stderr/terminal-record assertions double as byte-identity proofs.
    childUsage: mode === 'child-usage'
      ? { dispatches: 2, usage: { inputTokens: 40, outputTokens: 4 } }
      : undefined,
    sessionUsage: mode === 'child-usage'
      ? { inputTokens: 52, outputTokens: 7, cacheReadInputTokens: 0 }
      : { inputTokens: 12, outputTokens: 3, cacheReadInputTokens: 0 },
    modelPrice,
    modelShares,
    // Like childUsage: the real runtime's callStats is undefined until a completed
    // model call was observed, so every mode but call-stats keeps the zero-call
    // shape and the exact-output assertions double as byte-identity proofs.
    callStats: mode === 'call-stats'
      ? {
          calls: 3,
          meteredCalls: 2,
          usage: { inputTokens: 40, outputTokens: 6, cacheReadInputTokens: 100 },
          noTool: 1,
          singleTool: 2,
          multiTool: 0,
          recentToolUseCounts: [1, 1, 0],
        }
      : undefined,
    trajectoryStatus: mode === 'observer-warning' ? { problem: 'fixture trajectory warning' } : undefined,
    diagnosticsStatus: undefined,
    diagnostics: undefined,
    expandSlashCommand: async () => null,
    subscribeToSubagentProgress: () => () => undefined,
    async compact() {
      if (traceFile !== undefined) appendFileSync(traceFile, `${JSON.stringify({ type: 'compact' })}\n`);
      if (mode === 'compact-failure') throw new Error('fixture compact failed');
      return {
        messagesBefore: 12,
        messagesAfter: 5,
        estimatedTokensBefore: 10_000,
        estimatedTokensAfter: 2_000,
        estimatedTokensSaved: 8_000,
        compacted: true,
      };
    },
    cancel() {
      cancelled = true;
    },
    takeHookProblems: () => [],
    observePermissionRequest(request: { source: string }) {
      if (traceFile !== undefined) appendFileSync(traceFile, `${JSON.stringify({ type: 'permissionRequest', source: request.source })}\n`);
    },
    observeTurnComplete(outcome: string, source: string) {
      if (traceFile !== undefined) appendFileSync(traceFile, `${JSON.stringify({ type: 'turnComplete', outcome, source })}\n`);
    },
    async *send(input: string): AsyncIterable<AgentStreamEvent> {
      sends += 1;
      if (traceFile !== undefined) {
        appendFileSync(traceFile, `${JSON.stringify({ type: 'send', input, attempt: sends })}\n`);
      }
      yield event({
        type: 'beforeToolCallEvent',
        toolUse: {
          name: 'bash',
          toolUseId: 'fixture-tool',
          input: { mode: 'execute', command: 'printf fixture' },
        },
      });
      yield event({
        type: 'afterToolCallEvent',
        toolUse: { name: 'bash', toolUseId: 'fixture-tool', input: {} },
        result: { status: 'success', content: [{ type: 'textBlock', text: 'fixture' }] },
      });
      if (mode === 'permission') {
        const decision = await options.permissionBridge({
          toolName: 'bash',
          kind: 'execute',
          summary: 'bash: SECRET-PERMISSION-INPUT',
          details: [],
          input: { command: 'SECRET-RAW-PERMISSION-INPUT' },
          risk: 'dangerous',
          riskReason: 'fixture',
          source: { kind: 'parent', label: 'parent' },
          suggestions: [],
          withdrawn: NEVER_WITHDRAWN,
        });
        if (decision.allowed) throw new Error('fixture permission unexpectedly allowed');
      }

      if (mode === 'stream-interruption' && sends === 1) {
        throw new ModelError('Stream ended without completing a message');
      }
      if (mode === 'stream-interruption-twice') {
        throw new ModelError('Stream ended without completing a message');
      }
      if (mode === 'context-overflow') {
        throw new ContextWindowOverflowError(
          'prompt tokens (1416135) exceed model maximum (1050000) for openai.gpt-5.6-sol',
        );
      }

      if (mode === 'interrupt' || mode === 'interrupt-cleanup') {
        while (!cancelled) await new Promise((resolve) => setTimeout(resolve, 5));
        yield event({ type: 'agentResultEvent', result: { stopReason: 'cancelled' } });
        return;
      }
      yield event({
        type: 'contentBlockEvent',
        contentBlock: { type: 'textBlock', text: 'fixture answer\n' },
      });
      yield event({
        type: 'modelMessageEvent',
        message: { content: [{ type: 'textBlock', text: 'fixture answer\n' }] },
      });
      if (mode === 'turn-failure') throw new Error('fixture turn failed');
      yield event({ type: 'agentResultEvent', result: { stopReason: 'endTurn' } });
    },
    async shutdown() {
      if (mode === 'cleanup-failure' || mode === 'interrupt-cleanup') throw new Error('fixture cleanup failed');
    },
    async markResumable() {
      if (mode === 'persistence-failure') throw new Error('fixture pointer failed');
    },
  } as unknown as AgentRuntime;
}

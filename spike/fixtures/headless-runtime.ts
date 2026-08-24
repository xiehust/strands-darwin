import { appendFileSync, writeFileSync } from 'node:fs';

import { ModelError, type AgentStreamEvent } from '@strands-agents/sdk';

import { NEVER_WITHDRAWN } from '../../src/agent/permission.js';
import type { AgentRuntime, RuntimeOptions } from '../../src/agent/runtime.js';
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

  return {
    info: {
      sessionId,
      permissionMode: 'default',
      resumed: false,
      diagnosticsFile: undefined,
    },
    config,
    usage: {
      inputTokens: 12,
      outputTokens: 3,
      cacheReadInputTokens: 0,
    },
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
    observePermissionRequest(source: string) {
      if (traceFile !== undefined) appendFileSync(traceFile, `${JSON.stringify({ type: 'permissionRequest', source })}\n`);
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

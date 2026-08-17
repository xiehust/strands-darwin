import { writeFileSync } from 'node:fs';

import type { AgentStreamEvent } from '@strands-agents/sdk';

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

  const sessionId = options.session.kind === 'id' ? options.session.sessionId : 'session-fixture';
  options.onSessionResolved?.(sessionId);
  let cancelled = false;

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
    cancel() {
      cancelled = true;
    },
    async *send(): AsyncIterable<AgentStreamEvent> {
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
        });
        if (decision.allowed) throw new Error('fixture permission unexpectedly allowed');
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

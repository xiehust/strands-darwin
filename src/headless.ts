import type { AgentStreamEvent } from '@strands-agents/sdk';

import { classify, type PermissionBridge } from './agent/permission.js';
import type { AgentRuntime } from './agent/runtime.js';
import type { UsageTotals } from './agent/usage.js';

const FIELD_LIMIT = 240;

export type HeadlessRuntime = Pick<AgentRuntime, 'send' | 'expandSlashCommand'>;

/** One-line, Unicode-safe and bounded text for script-facing progress records. */
export function headlessField(value: string, limit = FIELD_LIMIT): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  const points = [...normalized];
  if (points.length <= limit) return normalized;
  return `${points.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

/**
 * The single machine-parseable token record a headless run writes before exit,
 * matching `^usage: ...$` and sitting alongside the existing `session: <id>`
 * convention.
 *
 * A metric the provider never reported is written as `-`, never as `0`: a
 * supervisor aggregating child spend must be able to tell "this provider does
 * not report cache activity" from "this run read nothing from cache". Field
 * order is fixed so the line can be parsed positionally or by key.
 */
export function formatHeadlessUsage(usage: UsageTotals): string {
  const metric = (value: number | undefined): string => (value === undefined ? '-' : String(value));
  return (
    `usage: input=${metric(usage.inputTokens)} output=${metric(usage.outputTokens)}` +
    ` cacheRead=${metric(usage.cacheReadInputTokens)} cacheWrite=${metric(usage.cacheWriteInputTokens)}`
  );
}

/** A bridge for runs where nobody is present to answer a permission prompt. */
export function createHeadlessPermissionBridge(writeStderr: (text: string) => void): PermissionBridge {
  return async (request) => {
    writeStderr(`permission denied — ${headlessField(request.summary)}\n`);
    return { allowed: false };
  };
}

/**
 * Consumes exactly one SDK turn and returns its assembled reply. The process
 * orchestrator withholds stdout until runtime cleanup and pointer persistence
 * also succeed, so no failed invocation leaves a plausible partial answer.
 */
export async function runHeadlessTurn(
  runtime: HeadlessRuntime,
  prompt: string,
  writeStderr: (text: string) => void,
): Promise<string> {
  const expanded = await runtime.expandSlashCommand(prompt);
  const input = expanded?.message ?? prompt;
  const answer: string[] = [];
  let completed = false;
  let cancelled = false;

  for await (const event of runtime.send(input)) {
    consumeEvent(event, answer, writeStderr);
    if (event.type === 'agentResultEvent') {
      completed = true;
      cancelled = event.result.stopReason === 'cancelled';
    }
  }

  if (!completed) throw new Error('The agent turn ended without a final result.');
  if (cancelled) throw new Error('Interrupted.');

  const reply = answer.join('').replace(/\n+$/u, '');
  if (reply.trim() === '') throw new Error('The agent turn completed without an assistant reply.');
  return reply;
}

function consumeEvent(
  event: AgentStreamEvent,
  answer: string[],
  writeStderr: (text: string) => void,
): void {
  switch (event.type) {
    case 'contentBlockEvent':
      if (event.contentBlock.type === 'textBlock') answer.push(event.contentBlock.text);
      return;
    case 'beforeToolCallEvent': {
      const name = headlessField(event.toolUse.name);
      const summary = headlessField(classify(event.toolUse.name, event.toolUse.input).summary);
      writeStderr(`tool ${name} — ${summary}\n`);
      return;
    }
    case 'afterToolCallEvent': {
      const name = headlessField(event.toolUse.name);
      const denied = event.result.status === 'error' && toolResultText(event.result.content).startsWith('DENIED:');
      const status = denied ? 'denied' : event.result.status === 'error' ? 'failed' : 'ok';
      writeStderr(`tool ${name} — ${status}\n`);
      return;
    }
    default:
      return;
  }
}

function toolResultText(content: readonly unknown[]): string {
  return content
    .flatMap((block) => {
      if (typeof block !== 'object' || block === null) return [];
      const candidate = block as { type?: string; text?: string };
      return candidate.type === 'textBlock' && typeof candidate.text === 'string'
        ? [candidate.text]
        : [];
    })
    .join('\n')
    .trim();
}

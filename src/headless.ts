import type { AgentStreamEvent } from '@strands-agents/sdk';

import { classify, type PermissionBridge } from './agent/permission.js';
import type { AgentRuntime } from './agent/runtime.js';

const FIELD_LIMIT = 240;

export type HeadlessRuntime = Pick<AgentRuntime, 'send' | 'expandSlashCommand'>;

/** One-line, Unicode-safe and bounded text for script-facing progress records. */
export function headlessField(value: string, limit = FIELD_LIMIT): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  const points = [...normalized];
  if (points.length <= limit) return normalized;
  return `${points.slice(0, Math.max(0, limit - 1)).join('')}…`;
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

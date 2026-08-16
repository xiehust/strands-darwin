import type { AgentStreamEvent } from '@strands-agents/sdk';

import { classify, type ApprovalMode, type PermissionBridge } from './agent/permission.js';
import type { AgentRuntime } from './agent/runtime.js';
import { usageBuckets, type UsageTotals } from './agent/usage.js';
import type { AppConfig } from './config.js';

const FIELD_LIMIT = 240;

export type HeadlessRuntime = Pick<AgentRuntime, 'send' | 'expandSlashCommand'>;

/** Stable startup diagnostic for the effective post-override permission mode. */
export function formatHeadlessPermissionMode(mode: ApprovalMode): string {
  return `permission-mode: ${mode}`;
}

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
 * The four numeric fields are mutually exclusive cost buckets: `input` always
 * excludes reported cache reads and writes, even when a provider includes those
 * subsets in its native input total. A metric the provider never reported is
 * written as `-`, never as `0`, and field order stays fixed for supervisors.
 */
export function formatHeadlessUsage(usage: UsageTotals, config: AppConfig): string {
  const buckets = usageBuckets(usage, config);
  const metric = (value: number | undefined): string => (value === undefined ? '-' : String(value));
  return (
    `usage: input=${metric(buckets.input)} output=${metric(buckets.output)}` +
    ` cacheRead=${metric(buckets.cacheRead)} cacheWrite=${metric(buckets.cacheWrite)}`
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
 * One bounded stderr record when the trajectory could not be recorded, or
 * `undefined` when there is nothing to say.
 *
 * Reported because a supervisor that later runs `darwin trajectory replay` on this
 * session needs to know the record is short — and stays a diagnostic, never an exit
 * status: recording is an observer, so its failure cannot fail a turn that worked.
 */
export function formatHeadlessTrajectoryProblem(
  status: { problem: string | undefined } | undefined,
): string | undefined {
  if (status?.problem === undefined) return undefined;
  return `trajectory: ${headlessField(status.problem)}`;
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

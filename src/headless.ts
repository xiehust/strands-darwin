import type { AgentStreamEvent } from '@strands-agents/sdk';

import { classify, type ApprovalMode, type PermissionBridge } from './agent/permission.js';
import { runWithStreamResumption, STREAM_CONTINUATION_NOTICE } from './agent/stream-resumption.js';
import type { AgentRuntime } from './agent/runtime.js';
import { usageBuckets, type UsageTotals } from './agent/usage.js';
import { averageRequestInputTokens, type SessionCallStats } from './agent/call-stats.js';
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

/**
 * The child-spend record, written only when at least one dispatch reported
 * usage (`runtime.childUsage`), so a run without delegation keeps its exact
 * historical stderr. Mirrors {@link formatHeadlessUsage} — same buckets, same
 * fixed field order, same `-` for a metric no child's provider reported — plus
 * the count of dispatches whose meters the sum actually includes.
 */
export function formatHeadlessChildUsage(
  child: { dispatches: number; usage: UsageTotals },
  config: AppConfig,
): string {
  const buckets = usageBuckets(child.usage, config);
  const metric = (value: number | undefined): string => (value === undefined ? '-' : String(value));
  return (
    `usage-children: input=${metric(buckets.input)} output=${metric(buckets.output)}` +
    ` cacheRead=${metric(buckets.cacheRead)} cacheWrite=${metric(buckets.cacheWrite)}` +
    ` dispatches=${child.dispatches}`
  );
}

/**
 * The session-total record (parent meter plus children), emitted beside
 * {@link formatHeadlessChildUsage} under the same only-when-children-reported
 * condition; `usage:` alone remains the whole story otherwise.
 */
export function formatHeadlessTotalUsage(total: UsageTotals, config: AppConfig): string {
  const buckets = usageBuckets(total, config);
  const metric = (value: number | undefined): string => (value === undefined ? '-' : String(value));
  return (
    `usage-total: input=${metric(buckets.input)} output=${metric(buckets.output)}` +
    ` cacheRead=${metric(buckets.cacheRead)} cacheWrite=${metric(buckets.cacheWrite)}`
  );
}

/**
 * The per-call efficiency record, written only when at least one completed model
 * call was observed (`runtime.callStats`), so a run that never reached the model
 * keeps its exact historical stderr — the `usage-children:` convention. Field
 * order is fixed for supervisors, and `avgRequestInput` is `-` when no call was
 * metered — never `0`. The `usage:` record itself stays untouched either way.
 */
export function formatHeadlessCallStats(stats: SessionCallStats, config: AppConfig): string {
  const average = averageRequestInputTokens(stats, config);
  return (
    `model-calls: calls=${stats.calls} avgRequestInput=${average === undefined ? '-' : String(average)}` +
    ` noTool=${stats.noTool} singleTool=${stats.singleTool} multiTool=${stats.multiTool}`
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
 * The same, one record, for the opt-in diagnostics log — or `undefined`, which is
 * what a run that never asked for one always gets.
 *
 * A separate function rather than a shared "observer problem" helper: the two labels
 * are the two artifacts, and a supervisor grepping for `^diagnostics:` should not have
 * to know that recording and logging happen to degrade the same way.
 */
export function formatHeadlessDiagnosticsProblem(
  status: { problem: string | undefined } | undefined,
): string | undefined {
  if (status?.problem === undefined) return undefined;
  return `diagnostics: ${headlessField(status.problem)}`;
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
  return runWithStreamResumption(
    input,
    (turnInput) => runOneHeadlessTurn(runtime, turnInput, prompt, writeStderr),
    () => writeStderr(`notice: ${STREAM_CONTINUATION_NOTICE}\n`),
  );
}

/** One ordinary recorded SDK turn; resumption deliberately composes above this seam. */
async function runOneHeadlessTurn(
  runtime: HeadlessRuntime,
  input: string,
  userInput: string,
  writeStderr: (text: string) => void,
): Promise<string> {
  const answer: string[] = [];
  let completed = false;
  let cancelled = false;

  for await (const event of runtime.send(input, userInput)) {
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

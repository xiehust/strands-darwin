import { MaxTokensError, type AgentStreamEvent, type Message } from '@strands-agents/sdk';

import type { ApprovalMode, AssessedPermissionRequest, PermissionSource } from './agent/permission.js';
import { runWithStreamResumption } from './agent/stream-resumption.js';
import { retryNextAttempt, type ModelRetryOutcome, type RetryWaitState } from './agent/model-retry.js';
import { isRefusalStop, REFUSAL_EMPTY_REPLY_ERROR } from './agent/refusal.js';
import { pendingRetryWait, type HeadlessRuntime } from './headless.js';
import { usageBuckets, type UsageTotals } from './agent/usage.js';
import { averageRequestInputTokens, type SessionCallStats } from './agent/call-stats.js';
import type { AppConfig } from './config.js';
import type { ThinkingEffort, ThinkingPlan } from './agent/thinking.js';
import { contextOverflowErrorMessage } from './context-overflow-error.js';
import { failureFromError } from './trajectory/record.js';

export const HEADLESS_SCHEMA_VERSION = 1 as const;
export const STRUCTURED_FIELD_LIMIT = 8_000;
const TOOL_FIELD_LIMIT = 240;

export type StructuredOutputFormat = 'json' | 'stream-json';
export type StructuredOutcome = 'success' | 'failure' | 'cancelled';
export type StructuredFailureStage = 'runtime' | 'turn' | 'cleanup' | 'persistence';

interface StructuredEnvelope {
  schemaVersion: typeof HEADLESS_SCHEMA_VERSION;
  type: string;
  sequence: number;
  timestamp: string;
  sessionId: string | null;
}

export interface StructuredUsage {
  input?: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** The `model-calls:` stderr record's fields, for the structured terminal record. */
export interface StructuredCallStats {
  calls: number;
  /** Absent when no call was metered — unknown, never 0. */
  avgRequestInput?: number;
  noTool: number;
  singleTool: number;
  multiTool: number;
}

export interface StructuredFailure {
  stage: StructuredFailureStage;
  name: string;
  message: string;
  cause?: string;
  truncated?: true;
  /**
   * Additive (SER-067), turn stage only: how darwin's model retry ended when it
   * played a part — `exhausted` after `attempts` throttled calls, or `cancelled`
   * during the wait before `attempt` of `maxAttempts`. Absent otherwise; `name`,
   * `message` and `cause` stay the provider's own.
   */
  retry?: ModelRetryOutcome;
}

export interface StructuredWarning {
  source: 'sdk' | 'trajectory' | 'diagnostics' | 'memory' | 'hook' | 'thinking';
  level: 'warn' | 'error';
  message: string;
  truncated?: true;
}

/**
 * The resolved thinking plan as a run-scoped fact (issue #10): what was asked for
 * and what is actually sent, so a harness can assert the effective effort instead of
 * trusting its own request. `effective` is absent when nothing is sent (`enabled:
 * false`); `problem` is present exactly when the two differ or thinking is off despite
 * a level being set — the same rule `ThinkingPlan.problem` states.
 */
export interface StructuredThinking {
  enabled: boolean;
  requested: ThinkingEffort;
  effective?: ThinkingEffort;
  problem?: string;
  truncated?: true;
}

export interface StructuredTerminalInput {
  outcome: StructuredOutcome;
  permissionMode?: ApprovalMode;
  resumed?: boolean;
  result?: string;
  usage?: StructuredUsage;
  /**
   * Child-agent spend, present only when at least one dispatch reported usage —
   * the additive counterpart of the `usage-children:` stderr record. `usage`
   * itself stays parent-only and byte-identical either way.
   */
  childUsage?: StructuredUsage & { dispatches: number };
  /** Parent plus children, under the same only-when-children-reported condition. */
  totalUsage?: StructuredUsage;
  /**
   * Per-model-call efficiency stats, present only when at least one completed
   * model call was observed — the additive counterpart of the `model-calls:`
   * stderr record. An unmetered average is an absent key, never 0.
   */
  callStats?: StructuredCallStats;
  errors?: readonly StructuredFailure[];
  warnings?: readonly StructuredWarning[];
  continued?: true;
}

export interface StructuredTurnResult {
  outcome: 'success' | 'cancelled';
  reply?: string;
  continued?: true;
}

interface Bounded {
  value: string;
  truncated: boolean;
}

/**
 * Owns the public v1 protocol. It accepts typed projections only: raw SDK events,
 * agents, invocation state, messages, metrics and traces cannot cross this boundary.
 */
export class StructuredHeadlessWriter {
  private sequence = 0;
  private sessionId: string | null;

  constructor(
    private readonly format: StructuredOutputFormat,
    private readonly write: (text: string) => void,
    sessionId: string | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.sessionId = sessionId;
  }

  sessionResolved(sessionId: string): void {
    this.sessionId = sessionId;
    this.event({ type: 'session.resolved' });
  }

  runStarted(input: {
    permissionMode: ApprovalMode;
    resumed: boolean;
    diagnosticsFile?: string;
    /** Additive (issue #10): the resolved thinking plan; absent only when the runtime cannot say. */
    thinking?: StructuredThinking;
  }): void {
    const diagnosticsFile = input.diagnosticsFile === undefined
      ? undefined
      : bound(input.diagnosticsFile, STRUCTURED_FIELD_LIMIT);
    this.event({
      type: 'run.started',
      permissionMode: input.permissionMode,
      resumed: input.resumed,
      ...(diagnosticsFile === undefined ? {} : { diagnosticsFile: diagnosticsFile.value }),
      ...(diagnosticsFile?.truncated === true ? { truncated: true } : {}),
      ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
    });
  }

  turnStarted(): void {
    this.event({ type: 'turn.started' });
  }

  turnFailed(error: unknown): void {
    this.event({ type: 'turn.failed', error: structuredFailure('turn', error) });
  }

  turnContinuing(): void {
    this.event({
      type: 'turn.continuing',
      reason: 'model_stream_interrupted',
      message: 'Continuing once from retained conversation without repeating completed work.',
    });
  }

  /**
   * One additive event per model-retry wait (SER-067), emitted when the wait begins:
   * `attempt` is the call about to be made (so `attempt - 1` calls were throttled),
   * `waitMs` the decided delay, `reason` the runtime's already-bounded throttle text
   * under the tool-field cap. Schema v1 readers ignore unknown types.
   */
  modelRetrying(state: RetryWaitState): void {
    const reason = bound(state.reason.replace(/\s+/gu, ' ').trim(), TOOL_FIELD_LIMIT);
    this.event({
      type: 'model.retrying',
      attempt: retryNextAttempt(state),
      maxAttempts: state.maxAttempts,
      waitMs: Math.max(0, Math.floor(state.waitMs)),
      reason: reason.value,
      ...(reason.truncated ? { truncated: true } : {}),
    });
  }

  assistantMessage(messageIndex: number, text: string): void {
    const parts = splitCodePoints(text, STRUCTURED_FIELD_LIMIT);
    for (let index = 0; index < parts.length; index += 1) {
      this.event({
        type: 'assistant.message',
        messageIndex,
        part: index + 1,
        parts: parts.length,
        text: parts[index],
      });
    }
  }

  permissionDenied(request: AssessedPermissionRequest): void {
    const toolName = bound(request.toolName, TOOL_FIELD_LIMIT);
    const summary = bound(request.summary.replace(/\s+/gu, ' ').trim(), TOOL_FIELD_LIMIT);
    const source = projectPermissionSource(request.source);
    this.event({
      type: 'permission.denied',
      toolName: toolName.value,
      kind: request.kind,
      summary: summary.value,
      source: source.value,
      ...(toolName.truncated || summary.truncated || source.truncated ? { truncated: true } : {}),
    });
  }

  toolStarted(input: { toolUseId: string; name: string; summary: string }): void {
    const toolUseId = bound(input.toolUseId, TOOL_FIELD_LIMIT);
    const name = bound(input.name, TOOL_FIELD_LIMIT);
    const summary = bound(input.summary.replace(/\s+/gu, ' ').trim(), TOOL_FIELD_LIMIT);
    this.event({
      type: 'tool.started',
      toolUseId: toolUseId.value,
      name: name.value,
      summary: summary.value,
      ...(toolUseId.truncated || name.truncated || summary.truncated ? { truncated: true } : {}),
    });
  }

  toolCompleted(input: {
    toolUseId: string;
    name: string;
    status: 'success' | 'failure' | 'denied';
  }): void {
    const toolUseId = bound(input.toolUseId, TOOL_FIELD_LIMIT);
    const name = bound(input.name, TOOL_FIELD_LIMIT);
    this.event({
      type: 'tool.completed',
      toolUseId: toolUseId.value,
      name: name.value,
      status: input.status,
      ...(toolUseId.truncated || name.truncated ? { truncated: true } : {}),
    });
  }

  /** Live-only bounded visibility for a long blocking child; final JSON stays one document. */
  subagentProgress(input: {
    dispatchId: string;
    agentName: string;
    elapsedMs: number;
    phase: 'starting' | 'model' | 'tool' | 'waiting-on-model';
    toolName?: string;
    /** `waiting-on-model` only (SER-067): the child's call about to be made, of `maxAttempts`. */
    attempt?: number;
    maxAttempts?: number;
  }): void {
    if (this.format !== 'stream-json') return;
    const dispatchId = bound(input.dispatchId, TOOL_FIELD_LIMIT);
    const agentName = bound(input.agentName, TOOL_FIELD_LIMIT);
    const toolName = input.toolName === undefined ? undefined : bound(input.toolName, TOOL_FIELD_LIMIT);
    this.event({
      type: 'subagent.progress',
      dispatchId: dispatchId.value,
      agentName: agentName.value,
      elapsedMs: Math.max(0, Math.floor(input.elapsedMs)),
      phase: input.phase,
      ...(toolName === undefined ? {} : { toolName: toolName.value }),
      ...(input.attempt === undefined ? {} : { attempt: Math.max(0, Math.floor(input.attempt)) }),
      ...(input.maxAttempts === undefined ? {} : { maxAttempts: Math.max(0, Math.floor(input.maxAttempts)) }),
      ...(dispatchId.truncated || agentName.truncated || toolName?.truncated === true ? { truncated: true } : {}),
    });
  }


  diagnostic(warning: StructuredWarning): void {
    this.event({ type: 'diagnostic', ...warning });
  }

  terminal(input: StructuredTerminalInput): void {
    const record = {
      type: 'result',
      outcome: input.outcome,
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.resumed === undefined ? {} : { resumed: input.resumed }),
      ...(input.result === undefined ? {} : { result: input.result }),
      ...(input.usage === undefined ? {} : { usage: input.usage }),
      ...(input.childUsage === undefined ? {} : { childUsage: input.childUsage }),
      ...(input.totalUsage === undefined ? {} : { totalUsage: input.totalUsage }),
      ...(input.callStats === undefined ? {} : { callStats: input.callStats }),
      ...(input.errors === undefined || input.errors.length === 0 ? {} : { errors: [...input.errors] }),
      ...(input.warnings === undefined || input.warnings.length === 0 ? {} : { warnings: [...input.warnings] }),
      ...(input.continued === true ? { continued: true } : {}),
    };
    this.writeRecord(record);
  }

  private event(record: Record<string, unknown>): void {
    if (this.format !== 'stream-json') return;
    this.writeRecord(record);
  }

  private writeRecord(record: Record<string, unknown>): void {
    // Final-only JSON has emitted nothing, so its one document is always sequence 1.
    // JSONL uses the same counter as every prior event.
    this.sequence += 1;
    const envelope: StructuredEnvelope = {
      schemaVersion: HEADLESS_SCHEMA_VERSION,
      type: String(record['type']),
      sequence: this.sequence,
      timestamp: this.now().toISOString(),
      sessionId: this.sessionId,
    };
    this.write(`${JSON.stringify({ ...envelope, ...record })}\n`);
  }
}

export function structuredFailure(
  stage: StructuredFailureStage,
  error: unknown,
  retry?: ModelRetryOutcome,
): StructuredFailure {
  const failure = failureFromError(error);
  const name = bound(failure.name, STRUCTURED_FIELD_LIMIT);
  const message = bound(contextOverflowErrorMessage(error), STRUCTURED_FIELD_LIMIT);
  const cause = failure.cause === undefined ? undefined : bound(failure.cause, STRUCTURED_FIELD_LIMIT);
  return {
    stage,
    name: name.value,
    message: message.value,
    ...(cause === undefined ? {} : { cause: cause.value }),
    ...(name.truncated || message.truncated || cause?.truncated === true ? { truncated: true } : {}),
    ...(retry === undefined ? {} : { retry: { ...retry } }),
  };
}

export function structuredWarning(
  source: StructuredWarning['source'],
  level: StructuredWarning['level'],
  message: string,
): StructuredWarning {
  const bounded = bound(message.replace(/\s+/gu, ' ').trim(), STRUCTURED_FIELD_LIMIT);
  return {
    source,
    level,
    message: bounded.value,
    ...(bounded.truncated ? { truncated: true } : {}),
  };
}

/** The resolved thinking plan projected for `run.started`; the problem text is bounded like every other field. */
export function structuredThinking(plan: ThinkingPlan): StructuredThinking {
  const problem = plan.problem === undefined
    ? undefined
    : bound(plan.problem.replace(/\s+/gu, ' ').trim(), STRUCTURED_FIELD_LIMIT);
  return {
    enabled: plan.enabled,
    requested: plan.requested,
    ...(plan.effective === undefined ? {} : { effective: plan.effective }),
    ...(problem === undefined ? {} : { problem: problem.value }),
    ...(problem?.truncated === true ? { truncated: true } : {}),
  };
}

export function structuredUsage(usage: UsageTotals, config: AppConfig): StructuredUsage {
  const buckets = usageBuckets(usage, config);
  return {
    ...(buckets.input === undefined ? {} : { input: buckets.input }),
    output: buckets.output,
    ...(buckets.cacheRead === undefined ? {} : { cacheRead: buckets.cacheRead }),
    ...(buckets.cacheWrite === undefined ? {} : { cacheWrite: buckets.cacheWrite }),
  };
}

/**
 * The `model-calls:` record's fields for the structured terminal record — the same
 * shared arithmetic, so the two protocols cannot disagree about one session.
 */
export function structuredCallStats(stats: SessionCallStats, config: AppConfig): StructuredCallStats {
  const average = averageRequestInputTokens(stats, config);
  return {
    calls: stats.calls,
    ...(average === undefined ? {} : { avgRequestInput: average }),
    noTool: stats.noTool,
    singleTool: stats.singleTool,
    multiTool: stats.multiTool,
  };
}

/**
 * Consumes one turn without exposing pre-redaction deltas. Completed model messages
 * are emitted only after SDK aggregation has applied output guardrails. A retained
 * max-token partial is read from the post-aggregation MaxTokensError for the same
 * reason, then the existing SDK retry supplies the continuation.
 */
export async function runStructuredHeadlessTurn(
  runtime: HeadlessRuntime,
  prompt: string,
  writer: StructuredHeadlessWriter,
  onToolStart: (name: string, input: unknown) => string,
): Promise<StructuredTurnResult> {
  const expanded = await runtime.expandSlashCommand(prompt);
  const input = expanded?.message ?? prompt;
  let continued = false;
  const result = await runWithStreamResumption(
    input,
    async (turnInput) => {
      writer.turnStarted();
      return runOneStructuredHeadlessTurn(runtime, turnInput, prompt, writer, onToolStart);
    },
    (error) => {
      continued = true;
      writer.turnFailed(error);
      writer.turnContinuing();
    },
  );
  return continued ? { ...result, continued: true } : result;
}

/** One ordinary structured turn. Failed-attempt text never enters the next result. */
async function runOneStructuredHeadlessTurn(
  runtime: HeadlessRuntime,
  input: string,
  userInput: string,
  writer: StructuredHeadlessWriter,
  onToolStart: (name: string, input: unknown) => string,
): Promise<StructuredTurnResult> {
  const answer: string[] = [];
  let completed = false;
  let cancelled = false;
  let refused = false;
  let messageIndex = 0;
  // One `model.retrying` per wait: the state object is frozen and unique per decision,
  // so identity is the dedupe key. Read right where the failed attempt's event arrives —
  // the runtime sets the state before that event reaches this loop (SER-066).
  let announcedWait: RetryWaitState | undefined;

  for await (const event of runtime.send(input, userInput)) {
    switch (event.type) {
      case 'modelMessageEvent':
        appendSafeMessage(event.message, answer, writer, () => ++messageIndex);
        break;
      case 'afterModelCallEvent':
        if (event.error instanceof MaxTokensError) {
          appendSafeMessage(event.error.partialMessage, answer, writer, () => ++messageIndex);
        }
        if (event.error !== undefined) {
          const wait = pendingRetryWait(runtime);
          if (wait !== undefined && wait !== announcedWait) {
            announcedWait = wait;
            writer.modelRetrying(wait);
          }
        }
        break;
      case 'beforeToolCallEvent':
        writer.toolStarted({
          toolUseId: event.toolUse.toolUseId,
          name: event.toolUse.name,
          summary: onToolStart(event.toolUse.name, event.toolUse.input),
        });
        break;
      case 'afterToolCallEvent':
        writer.toolCompleted({
          toolUseId: event.toolUse.toolUseId,
          name: event.toolUse.name,
          status: toolStatus(event),
        });
        break;
      case 'agentResultEvent':
        completed = true;
        cancelled = event.result.stopReason === 'cancelled';
        refused = isRefusalStop(event.result.stopReason);
        break;
      default:
        break;
    }
  }

  if (!completed) throw new Error('The agent turn ended without a final result.');
  if (cancelled) return { outcome: 'cancelled' };

  const reply = answer.join('').replace(/\n+$/u, '');
  // A refusal with partial text still returns that text as the reply; only the
  // no-reply case is an error, and it names the refusal instead of a generic gap.
  if (refused && reply.trim() === '') throw new Error(REFUSAL_EMPTY_REPLY_ERROR);
  if (reply.trim() === '') throw new Error('The agent turn completed without an assistant reply.');
  return { outcome: 'success', reply };
}

function appendSafeMessage(
  message: Message,
  answer: string[],
  writer: StructuredHeadlessWriter,
  nextIndex: () => number,
): void {
  const text = message.content
    .flatMap((block) => block.type === 'textBlock' ? [block.text] : [])
    .join('');
  if (text === '') return;
  answer.push(text);
  writer.assistantMessage(nextIndex(), text);
}

function toolStatus(event: Extract<AgentStreamEvent, { type: 'afterToolCallEvent' }>): 'success' | 'failure' | 'denied' {
  if (event.result.status !== 'error') return 'success';
  const text = event.result.content
    .flatMap((block) => block.type === 'textBlock' ? [block.text] : [])
    .join('\n')
    .trim();
  return text.startsWith('DENIED:') ? 'denied' : 'failure';
}

function projectPermissionSource(source: PermissionSource): {
  value: { kind: 'parent' | 'child'; label: string; dispatchId?: string; agentName?: string };
  truncated: boolean;
} {
  const label = bound(source.label, TOOL_FIELD_LIMIT);
  const dispatchId = source.dispatchId === undefined ? undefined : bound(source.dispatchId, TOOL_FIELD_LIMIT);
  const agentName = source.agentName === undefined ? undefined : bound(source.agentName, TOOL_FIELD_LIMIT);
  return {
    value: {
      kind: source.kind,
      label: label.value,
      ...(dispatchId === undefined ? {} : { dispatchId: dispatchId.value }),
      ...(agentName === undefined ? {} : { agentName: agentName.value }),
    },
    truncated: label.truncated || dispatchId?.truncated === true || agentName?.truncated === true,
  };
}

function bound(value: string, limit: number): Bounded {
  const points = [...value];
  if (points.length <= limit) return { value, truncated: false };
  return { value: points.slice(0, limit).join(''), truncated: true };
}

function splitCodePoints(value: string, limit: number): string[] {
  const points = [...value];
  if (points.length === 0) return [];
  const parts: string[] = [];
  for (let index = 0; index < points.length; index += limit) {
    parts.push(points.slice(index, index + limit).join(''));
  }
  return parts;
}

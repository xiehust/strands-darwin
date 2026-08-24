import { MaxTokensError, type AgentStreamEvent, type Message } from '@strands-agents/sdk';

import {
  collectCompletionCandidate,
  runWithCompletionGuard,
} from './agent/completion-guard.js';

import type { ApprovalMode, AssessedPermissionRequest, PermissionSource } from './agent/permission.js';
import { runWithStreamResumption } from './agent/stream-resumption.js';
import type { HeadlessRuntime } from './headless.js';
import { usageBuckets, type UsageTotals } from './agent/usage.js';
import type { AppConfig } from './config.js';
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

export interface StructuredFailure {
  stage: StructuredFailureStage;
  name: string;
  message: string;
  cause?: string;
  truncated?: true;
}

export interface StructuredWarning {
  source: 'sdk' | 'trajectory' | 'diagnostics' | 'memory';
  level: 'warn' | 'error';
  message: string;
  truncated?: true;
}

export interface StructuredTerminalInput {
  outcome: StructuredOutcome;
  permissionMode?: ApprovalMode;
  resumed?: boolean;
  result?: string;
  usage?: StructuredUsage;
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

export function structuredFailure(stage: StructuredFailureStage, error: unknown): StructuredFailure {
  const failure = failureFromError(error);
  const name = bound(failure.name, STRUCTURED_FIELD_LIMIT);
  const message = bound(failure.message, STRUCTURED_FIELD_LIMIT);
  const cause = failure.cause === undefined ? undefined : bound(failure.cause, STRUCTURED_FIELD_LIMIT);
  return {
    stage,
    name: name.value,
    message: message.value,
    ...(cause === undefined ? {} : { cause: cause.value }),
    ...(name.truncated || message.truncated || cause?.truncated === true ? { truncated: true } : {}),
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
  const events = await runWithCompletionGuard(
    input,
    (candidateInput) => runWithStreamResumption(
      candidateInput,
      async (turnInput) => {
        writer.turnStarted();
        return collectCompletionCandidate(
          runtime,
          turnInput,
          (events) => consumeStructuredToolEvents(events, writer, onToolStart),
        );
      },
      (error) => {
        continued = true;
        writer.turnFailed(error);
        writer.turnContinuing();
      },
    ),
  );
  const result = consumeStructuredEvents(events, writer, onToolStart);
  return continued ? { ...result, continued: true } : result;
}

function consumeStructuredEvents(
  events: readonly AgentStreamEvent[],
  writer: StructuredHeadlessWriter,
  onToolStart: (name: string, input: unknown) => string,
): StructuredTurnResult {
  const answer: string[] = [];
  let completed = false;
  let cancelled = false;
  let messageIndex = 0;

  for (const event of events) {
    switch (event.type) {
      case 'modelMessageEvent':
        appendSafeMessage(event.message, answer, writer, () => ++messageIndex);
        break;
      case 'afterModelCallEvent':
        if (event.error instanceof MaxTokensError) {
          appendSafeMessage(event.error.partialMessage, answer, writer, () => ++messageIndex);
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
        break;
      default:
        break;
    }
  }

  if (!completed) throw new Error('The agent turn ended without a final result.');
  if (cancelled) return { outcome: 'cancelled' };

  const reply = answer.join('').replace(/\n+$/u, '');
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

function consumeStructuredToolEvents(
  events: readonly AgentStreamEvent[],
  writer: StructuredHeadlessWriter,
  onToolStart: (name: string, input: unknown) => string,
): void {
  for (const event of events) {
    if (event.type === 'beforeToolCallEvent') {
      writer.toolStarted({
        toolUseId: event.toolUse.toolUseId,
        name: event.toolUse.name,
        summary: onToolStart(event.toolUse.name, event.toolUse.input),
      });
    } else if (event.type === 'afterToolCallEvent') {
      writer.toolCompleted({
        toolUseId: event.toolUse.toolUseId,
        name: event.toolUse.name,
        status: toolStatus(event),
      });
    }
  }
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

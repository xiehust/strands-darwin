/**
 * Headless (`darwin -p`) driver: one turn, no terminal.
 *
 * Exists so darwin can be driven by a harness rather than a human. The
 * interactive path owns a terminal — it renders with Ink, and it asks the user to
 * approve tool calls — and neither of those survives being run by a program with
 * no TTY. So this path shares the runtime and shares nothing else: it approves
 * every call up front, projects the event stream to stdout as JSON Lines, and
 * ends with a single terminal `result` record carrying the outcome and what the
 * turn spent.
 *
 * The contract with a caller is that terminal record. Everything before it is
 * commentary a human might want while watching; a machine is expected to read the
 * last `{"type":"result"}` line and nothing else, which is why that record repeats
 * the outcome instead of leaving it to be inferred from what came earlier.
 */
import process from 'node:process';

import type { AgentStreamEvent } from '@strands-agents/sdk';

import { allowAllBridge, type ApprovalMode } from './agent/permission.js';
import { AgentRuntime, type UsageTotals } from './agent/runtime.js';
import { ConfigError, supportsPromptCache } from './config.js';

/** Bumped only for a breaking change to the record shapes below. */
export const HEADLESS_SCHEMA_VERSION = 1 as const;

/** Cap on projected free text, so one enormous reply cannot dominate the stream. */
const TEXT_FIELD_LIMIT = 8_000;
/** Cap on a tool's arguments and result preview, which are routinely far larger. */
const TOOL_FIELD_LIMIT = 240;

export type HeadlessOutputFormat = 'text' | 'stream-json';

/** How the turn ended, in the terminal record. */
export type HeadlessOutcome = 'success' | 'failure' | 'cancelled';

/** Where a failure happened, so a caller can tell setup from the turn itself. */
export type HeadlessFailureStage = 'runtime' | 'turn';

export interface HeadlessUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface HeadlessOptions {
  prompt: string;
  format: HeadlessOutputFormat;
  /** Undefined means "use the config file's value". */
  permissionMode?: ApprovalMode;
  resume: boolean;
  /** Injectable for tests; defaults to stdout. */
  write?: (text: string) => void;
}

/**
 * Runs one headless turn and returns the process exit code.
 *
 * Never throws: a failure anywhere becomes a terminal `result` record with
 * `outcome: "failure"` and a non-zero code, because a caller parsing the stream
 * deserves to be told what went wrong in the stream rather than having to
 * correlate a stack trace on stderr with an empty stdout.
 */
export async function runHeadless(options: HeadlessOptions): Promise<number> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const emit = (record: Record<string, unknown>): void => {
    if (options.format !== 'stream-json') return;
    write(`${JSON.stringify({ schemaVersion: HEADLESS_SCHEMA_VERSION, ...record })}\n`);
  };

  let runtime: AgentRuntime;
  try {
    runtime = await AgentRuntime.create({
      projectRoot: process.cwd(),
      resume: options.resume,
      // Nothing can answer a prompt here, and a gate that cannot ask must not
      // block: it would deadlock the turn on the first tool call instead of
      // failing it. A headless caller has already accepted that by choosing this
      // mode.
      permissionBridge: allowAllBridge,
      // The only caller that needs ~/.darwin: a harness starts darwin in the
      // repository under test, so there is nowhere project-local to put config
      // that would not become part of the diff being graded.
      includeUserConfig: true,
      ...(options.permissionMode !== undefined && { permissionModeOverride: options.permissionMode }),
    });
  } catch (error) {
    // No runtime means no usage meter, so the terminal record carries the failure
    // alone rather than a zeroed spend that would read as "ran and cost nothing".
    emitTerminal(emit, { outcome: 'failure', errors: [failure('runtime', error)] });
    if (options.format !== 'stream-json') {
      process.stderr.write(`\n${describeStage(error)}\n\n`);
    }
    return 1;
  }

  // What actually ran, recorded before the first call. A headless caller cannot see
  // the config darwin resolved, and the failure that costs the most to diagnose is
  // a config file that was never found: the defaults are a *working* setup, so a
  // run against the wrong model looks entirely healthy from the outside. Naming
  // the model here makes that visible in the trajectory instead of inferable from
  // the bill.
  emit({
    type: 'init',
    provider: runtime.info.config.provider,
    model: runtime.info.config.model,
    maxTokens: runtime.info.config.maxTokens,
    permissionMode: runtime.info.permissionMode,
    promptCache: supportsPromptCache(runtime.info.config.model),
    // Absent means the provider's own default, which for a thinking-capable
    // Claude model is not "off" — so this records the distinction rather than
    // leaving a default run indistinguishable from an unset one.
    thinkingEffort: runtime.info.config.thinkingEffort ?? null,
    sessionId: runtime.info.sessionId,
    resumed: runtime.info.resumed,
  });

  let stopReason: string | undefined;
  let reply = '';
  let turnError: unknown;

  try {
    for await (const event of runtime.send(options.prompt)) {
      const projected = project(event);
      if (projected !== undefined) emit(projected);
      if (event.type === 'contentBlockEvent') {
        const block = event.contentBlock;
        // The assembled block closes off the deltas and survives any delta the
        // loop failed to observe, so the reply is built from blocks only.
        if (block.type === 'textBlock' && block.text.trim() !== '') {
          reply = reply === '' ? block.text.trim() : `${reply}\n\n${block.text.trim()}`;
        }
      }
      if (event.type === 'agentResultEvent') stopReason = event.result.stopReason;
    }
    // Only a completed turn is worth reopening with `--resume`.
    await runtime.markResumable();
  } catch (error) {
    turnError = error;
  } finally {
    // Reaps MCP children and the bash shell. Runs even on failure: a leaked child
    // would outlive the process and hold the sandbox open.
    await runtime.shutdown();
  }

  const usage = projectUsage(runtime.usage);
  if (turnError !== undefined) {
    emitTerminal(emit, {
      outcome: 'failure',
      usage,
      ...(reply !== '' && { result: bound(reply, TEXT_FIELD_LIMIT) }),
      errors: [failure('turn', turnError)],
    });
    if (options.format !== 'stream-json') {
      process.stderr.write(`\n${describeStage(turnError)}\n\n`);
    }
    return 1;
  }

  // `cancelled` cannot arise from this path's own doing — nothing here calls
  // cancel() — but a signal can still land mid-turn, and reporting it as success
  // would present a truncated turn as a finished one.
  const outcome: HeadlessOutcome = stopReason === 'cancelled' ? 'cancelled' : 'success';
  emitTerminal(emit, {
    outcome,
    usage,
    ...(stopReason !== undefined && { stopReason }),
    ...(reply !== '' && { result: bound(reply, TEXT_FIELD_LIMIT) }),
  });
  if (options.format === 'text' && reply !== '') write(`${reply}\n`);
  return outcome === 'success' ? 0 : 1;
}

function emitTerminal(
  emit: (record: Record<string, unknown>) => void,
  fields: Record<string, unknown>,
): void {
  emit({ type: 'result', ...fields });
}

/**
 * Projects the SDK's counters into independently billable buckets.
 *
 * Bedrock and Anthropic report cache reads and writes beside uncached input, so
 * the four numbers are already disjoint and are passed through as they are. An
 * unreported cache counter stays absent rather than becoming 0, so a consumer can
 * tell "no caching on this provider" from "caching that missed".
 */
function projectUsage(usage: UsageTotals): HeadlessUsage {
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    ...(usage.cacheReadInputTokens !== undefined && { cacheRead: usage.cacheReadInputTokens }),
    ...(usage.cacheWriteInputTokens !== undefined && { cacheWrite: usage.cacheWriteInputTokens }),
  };
}

/**
 * Turns one stream event into a record, or undefined for events a watcher gains
 * nothing from.
 *
 * Deltas are dropped on purpose: they arrive character by character, and the
 * assembled block that follows carries the same text. Emitting both would inflate
 * the stream by roughly the length of the reply for no added information.
 */
function project(event: AgentStreamEvent): Record<string, unknown> | undefined {
  switch (event.type) {
    case 'contentBlockEvent': {
      const block = event.contentBlock;
      if (block.type === 'textBlock') {
        const text = block.text.trim();
        return text === '' ? undefined : { type: 'assistant', text: bound(text, TEXT_FIELD_LIMIT) };
      }
      // Reasoning content is deliberately not echoed: it is a different register
      // from the reply, and a harness that logs it would be storing the model's
      // private scratchpad in a trajectory meant to record what it did.
      return undefined;
    }
    case 'beforeToolCallEvent':
      return {
        type: 'tool_use',
        id: event.toolUse.toolUseId,
        name: event.toolUse.name,
        input: bound(stringify(event.toolUse.input), TOOL_FIELD_LIMIT),
      };
    case 'afterToolCallEvent':
      return {
        type: 'tool_result',
        id: event.toolUse.toolUseId,
        name: event.toolUse.name,
        status: event.result.status === 'error' ? 'error' : 'ok',
        preview: bound(stringify(event.result.content), TOOL_FIELD_LIMIT),
      };
    default:
      return undefined;
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Tool arguments are model-authored and can carry a cycle or a BigInt. A
    // preview is never worth failing the turn over.
    return String(value);
  }
}

function bound(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function failure(stage: HeadlessFailureStage, error: unknown): Record<string, unknown> {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause !== undefined ? String(error.cause) : undefined;
  return {
    stage,
    name,
    message: bound(message, TEXT_FIELD_LIMIT),
    ...(cause !== undefined && { cause: bound(cause, TEXT_FIELD_LIMIT) }),
  };
}

/** Human-readable form for the `text` format's stderr, mirroring cli.ts's wording. */
function describeStage(error: unknown): string {
  if (error instanceof ConfigError) return `Configuration problem:\n  ${error.message}`;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

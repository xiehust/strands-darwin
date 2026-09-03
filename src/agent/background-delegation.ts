/**
 * SER-064: background delegation through the SDK's own `backgroundTasks` plugin.
 *
 * Darwin schedules nothing here. The SDK plugin (`@strands-agents/sdk`
 * `dist/src/background-tasks/background-tasks.js`) does four things once the parent
 * Agent is constructed with the option this module builds:
 *
 * - adds an optional boolean `_background_execution` to the spec of every
 *   `agentic` tool through `InvokeModelStage.Input` middleware, so the model can
 *   choose per call;
 * - in the executor, *after* `BeforeToolCallEvent` and any hook `cancel` — so the
 *   permission gate, plan-mode denial and the retry guard have already run —
 *   `routeToolCall` strips the flag and `submitToolCall` returns an ack tool result
 *   carrying a task id (`executor.js`, the `route === true` branch);
 * - with `waitForCompletion: true`, `AfterInvocationEvent` waits for every tracked
 *   task, then `_deliverReady` appends one synthetic
 *   `strands_background_task_result` tool-use/tool-result pair through
 *   `continuations.addInput` and the same invocation makes another model call — so a
 *   result never crosses into a later user turn;
 * - registers `strands_manage_background_task` (`list`/`get`/`cancel`) on the parent.
 *
 * Two of its events do not travel down the parent's stream, and that is what the
 * observer below exists for. The background run's real `AfterToolCallEvent` is
 * delivered to hook callbacks only (`ToolExecutor.executeBackground` → the agent's
 * `_invokeCallbacks`), never yielded; the delivered pair reaches the stream only as
 * `messageAddedEvent`s. Darwin's transcript, headless drivers and trajectory all read
 * `beforeToolCallEvent`/`afterToolCallEvent` pairs, so without forwarding, a
 * background `subagent` row would never finish and its result would never be
 * recorded. {@link BackgroundDelegationObserver} therefore hooks the parent's
 * `AfterToolCallEvent` at `HookOrder.SDK_LAST` (after the context offloader and the
 * interventions have had their say about `result`) and yields the event — the same
 * SDK object, unmodified — into the stream `AgentRuntime.send()` hands to its
 * consumers, ahead of the next SDK event. Only calls the stream itself showed as
 * routed to the background are forwarded; every foreground `AfterToolCallEvent` is
 * yielded by the SDK and left alone.
 */
import { AfterToolCallEvent, HookOrder } from '@strands-agents/sdk';
import type { Agent, AgentStreamEvent, BackgroundTasksConfig } from '@strands-agents/sdk';

/** The per-call selector the SDK middleware adds to `agentic` tool specs. */
export const BACKGROUND_EXECUTION_FLAG = '_background_execution';

/** The SDK's own management tool; parent-only, classified in `permission.ts`. */
export const MANAGE_BACKGROUND_TASK_TOOL_NAME = 'strands_manage_background_task';

/** The synthetic tool-use name the SDK uses when it delivers a finished task. */
export const BACKGROUND_TASK_RESULT_TOOL_NAME = 'strands_background_task_result';

/** First line of the SDK's dispatch acknowledgement (`submitToolCall`). */
const ACK_FIRST_LINE = 'Background task dispatched.';
const ACK_TASK_ID = /^Task ID: (\S+)$/mu;

export interface BackgroundDelegationConfigInput {
  /** The delegation tools the model may route to the background. */
  readonly delegationTools: readonly string[];
  /**
   * Every other tool the parent registers up front. Tools discovered later (MCP,
   * plugin tools) are covered by the wildcard the builder adds.
   */
  readonly ordinaryToolNames: readonly string[];
  /** The SER-061 cap (`concurrencyCap(config)`); the SDK engine queues beyond it. */
  readonly maxConcurrency: number;
}

/**
 * The `backgroundTasks` option for the parent Agent.
 *
 * `never` names every ordinary tool explicitly and closes with `'*'`, so a tool that
 * only exists after `initialize()` (MCP servers, the offloader's retrieval tool, the
 * plugin's own manage tool) is `never` as well rather than falling back to the SDK's
 * `agentic` default for unnamed tools. The SDK rejects a name listed under two modes,
 * so a delegation tool is removed from `never` if a caller passes it in both lists.
 */
export function backgroundDelegationConfig(input: BackgroundDelegationConfigInput): BackgroundTasksConfig {
  const agentic = [...new Set(input.delegationTools)];
  const never = [...new Set(input.ordinaryToolNames)].filter((name) => !agentic.includes(name));
  return {
    agentic,
    never: [...never, '*'],
    waitForCompletion: true,
    maxConcurrency: input.maxConcurrency,
  };
}

/** True when a tool-use input asks for background execution (`_background_execution: true`). */
export function backgroundExecutionRequested(input: unknown): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    (input as Record<string, unknown>)[BACKGROUND_EXECUTION_FLAG] === true
  );
}

/**
 * The one sentence both delegation tool descriptions carry. The flag itself is
 * added to the spec by the SDK middleware, so the description only has to say when
 * to use it and when the result comes back.
 */
export function backgroundDelegationDescriptionClause(): string {
  return (
    `Set ${BACKGROUND_EXECUTION_FLAG}: true to run this call in the background when you do not ` +
    'need its result immediately (reads only): you get an acknowledgement at once and the ' +
    'final report is delivered before your next model call in this same turn.'
  );
}

/**
 * The task id inside the SDK's dispatch acknowledgement, or `undefined` for any
 * other tool result. Reads the ack's fixed text shape only; never a task registry.
 */
export function backgroundAckTaskId(content: readonly unknown[]): string | undefined {
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type !== 'textBlock' || typeof typed.text !== 'string') continue;
    if (!typed.text.startsWith(ACK_FIRST_LINE)) continue;
    return ACK_TASK_ID.exec(typed.text)?.[1];
  }
  return undefined;
}

/**
 * Forwards background runs' `AfterToolCallEvent`s into the parent's stream.
 *
 * One instance per parent Agent; {@link observe} wraps exactly one `Agent.stream()`
 * at a time (the runtime serializes turns). Per turn it remembers which tool-use ids
 * the stream showed as routed to the background — a `beforeToolCallEvent` for a
 * delegation tool whose input carries the flag and which no hook cancelled — and
 * yields the hook-observed `AfterToolCallEvent` for those ids in front of the next SDK
 * event. Ids a stream `afterToolCallEvent` closes are dropped (a denied or
 * foreground call). Anything left over when a turn ends — a task still cancelling
 * after Ctrl+C — is discarded at the start of the next turn: the SDK delivers that
 * task's result pair before the next model call itself, and the transcript already
 * shows the cancelled turn.
 */
export class BackgroundDelegationObserver {
  private readonly delegationTools: ReadonlySet<string>;
  private readonly pending = new Set<string>();
  private ready: AfterToolCallEvent[] = [];

  constructor(delegationTools: readonly string[]) {
    this.delegationTools = new Set(delegationTools);
  }

  /** Registers the hook on the parent; call once, after construction. */
  install(agent: Agent): void {
    agent.addHook(
      AfterToolCallEvent,
      (event) => {
        if (this.pending.delete(event.toolUse.toolUseId)) this.ready.push(event);
      },
      { order: HookOrder.SDK_LAST },
    );
  }

  /** Tool-use ids routed to the background in the current turn and not yet settled. */
  get pendingCount(): number {
    return this.pending.size;
  }

  async *observe(events: AsyncIterable<AgentStreamEvent>): AsyncIterable<AgentStreamEvent> {
    this.pending.clear();
    this.ready = [];
    for await (const event of events) {
      if (event.type === 'beforeToolCallEvent') {
        if (
          !event.cancel &&
          this.delegationTools.has(event.toolUse.name) &&
          backgroundExecutionRequested(event.toolUse.input)
        ) {
          this.pending.add(event.toolUse.toolUseId);
        }
      } else if (event.type === 'afterToolCallEvent') {
        this.pending.delete(event.toolUse.toolUseId);
      }
      yield* this.drain();
      yield event;
    }
    yield* this.drain();
  }

  private *drain(): Iterable<AgentStreamEvent> {
    if (this.ready.length === 0) return;
    const events = this.ready;
    this.ready = [];
    yield* events;
  }
}

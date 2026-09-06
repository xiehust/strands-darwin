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
 * - delivers a finished task as one synthetic `strands_background_task_result`
 *   tool-use/tool-result pair through `continuations.addInput`, from two hooks: at
 *   every `BeforeModelCallEvent` (`_deliverReady`, so a task that settled since the
 *   last call rides the next request) and at `AfterInvocationEvent` — where, with
 *   `waitForCompletion: true`, it first waits for every tracked task so the same
 *   invocation makes another model call, and with `false` it delivers only what is
 *   already terminal and lets the invocation end;
 * - registers `strands_manage_background_task` (`list`/`get`/`cancel`) on the parent.
 *
 * SER-070 chooses the mode per runtime: a driver that drains completion wakes (the
 * TUI, `RuntimeOptions.backgroundCompletionWakes`) passes `false`, so the dispatching
 * turn ends after the ack and the user keeps prompting; the child's settlement then
 * starts one wake turn when the session is idle, and the SDK's own before-model-call
 * delivery attaches the report to that turn's request. Headless runs have no later
 * turn for a report to arrive in, so they keep `true` and the result stays inside the
 * one `run.*` cycle. In both modes the report reaches the model through the SDK only —
 * darwin never copies it.
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
 * yielded by the SDK and left alone. The same hook is the settlement trigger for the
 * wake: it fires once per background run, exactly when the run's body returns (the
 * dispatch registry's listener fires per *child*, so a `workflow` of several nodes
 * would fire several times for one task, and it knows dispatch ids, not task ids).
 */
import { AfterToolCallEvent, HookOrder } from '@strands-agents/sdk';
import type { Agent, AgentStreamEvent, BackgroundTasksConfig } from '@strands-agents/sdk';

import { shortDispatchId } from '../agents/dispatch-registry.js';

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
  /**
   * True only for a runtime whose driver drains completion wakes (the TUI with
   * `backgroundTaskWake` on): the dispatching turn then ends after the ack and the
   * report arrives in the next turn that runs. False keeps the SDK waiting inside the
   * invocation, so a headless run's one cycle still contains the report.
   */
  readonly completionWakes: boolean;
}

/**
 * The `backgroundTasks` option for the parent Agent.
 *
 * `never` names every ordinary tool explicitly and closes with `'*'`, so a tool that
 * only exists after `initialize()` (MCP servers, the offloader's retrieval tool, the
 * plugin's own manage tool) is `never` as well rather than falling back to the SDK's
 * `agentic` default for unnamed tools. The SDK rejects a name listed under two modes,
 * so a delegation tool is removed from `never` if a caller passes it in both lists.
 * `waitForCompletion` is the one per-runtime choice (SER-070): `false` when the driver
 * wakes on settlement, `true` otherwise.
 */
export function backgroundDelegationConfig(input: BackgroundDelegationConfigInput): BackgroundTasksConfig {
  const agentic = [...new Set(input.delegationTools)];
  const never = [...new Set(input.ordinaryToolNames)].filter((name) => !agentic.includes(name));
  return {
    agentic,
    never: [...never, '*'],
    waitForCompletion: !input.completionWakes,
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
 * to use it and when the result comes back — which depends on the runtime
 * (SER-070): a waking runtime lets the turn end and delivers the report in the next
 * turn that runs; every other runtime delivers it before the next model call of the
 * same turn, byte-identical to the pre-SER-070 sentence.
 */
export function backgroundDelegationDescriptionClause(completionWakes = false): string {
  const lead =
    `Set ${BACKGROUND_EXECUTION_FLAG}: true to run this call in the background when you do not ` +
    'need its result immediately (reads only): you get an acknowledgement at once and the ';
  return completionWakes
    ? lead +
        'final report arrives as a strands_background_task_result tool result in the next turn ' +
        'that runs — you may end this turn; once the session is idle, one <task-notification> ' +
        'turn starts with the report attached.'
    : lead + 'final report is delivered before your next model call in this same turn.';
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

/** How far one background delegation has come; `running` until its run's body returns. */
export type BackgroundDelegationState = 'running' | 'succeeded' | 'failed';

/**
 * One background delegation the SDK still tracks: dispatched (the ack named a task)
 * and not yet delivered to the model as its result pair. Everything here came down
 * the parent's own stream or hook — no SDK internals, no task registry.
 */
export interface BackgroundDelegationStatus {
  /** The SDK task id from the ack; the pair's tool-use id when it is delivered. */
  readonly taskId: string;
  /** The model's tool-use id for the dispatching call. */
  readonly toolUseId: string;
  /** `subagent` or `workflow`. */
  readonly toolName: string;
  /** The tool-use input as the stream showed it (the SDK strips the flag later). */
  readonly input: unknown;
  /** ISO time of the `beforeToolCallEvent`. */
  readonly startedAt: string;
  /** ISO time of the run's `AfterToolCallEvent`; `null` while running. */
  readonly settledAt: string | null;
  readonly state: BackgroundDelegationState;
}

export type BackgroundDelegationListener = (status: BackgroundDelegationStatus) => void;

/** The first eight characters of an SDK task id (a UUID) — enough to tell tasks apart in a row. */
export function shortBackgroundTaskId(taskId: string): string {
  return taskId.length > 8 ? taskId.slice(0, 8) : taskId;
}

/**
 * The one refusal `/clear` and `/rewind` give while a background delegation is
 * tracked (SER-070): the live task ids and the two ways out. Never a partial restore,
 * never a silent cancel of minutes of child work — the same rule as the SER-027 busy
 * refusal. Shared by the TUI's local check and the runtime's own guard, so the two
 * cannot word it differently.
 */
export function liveBackgroundDelegationRefusal(
  command: '/clear' | '/rewind',
  tasks: readonly BackgroundDelegationStatus[],
): string {
  const named = tasks
    .map((task) =>
      task.toolName === 'subagent'
        ? `subagent #${shortDispatchId(task.toolUseId)} (task ${task.taskId}, ${task.state})`
        : `${task.toolName} (task ${task.taskId}, ${task.state}; /agents lists its node ids)`,
    )
    .join(', ');
  return (
    `${command} refused — ${tasks.length === 1 ? 'a background delegation is' : `${tasks.length} background delegations are`} ` +
    `still tracked: ${named}. Cancel with /agents cancel <id>, or wait for the completion wake to deliver the report; then retry.`
  );
}

interface TrackedDelegation {
  taskId: string | undefined;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly startedAt: string;
  settledAt: string | null;
  state: BackgroundDelegationState;
}

function snapshot(entry: TrackedDelegation & { taskId: string }): BackgroundDelegationStatus {
  return {
    taskId: entry.taskId,
    toolUseId: entry.toolUseId,
    toolName: entry.toolName,
    input: entry.input,
    startedAt: entry.startedAt,
    settledAt: entry.settledAt,
    state: entry.state,
  };
}

/**
 * Forwards background runs' `AfterToolCallEvent`s into the parent's stream and keeps
 * the parent-side ledger of tracked delegations (SER-064, SER-070).
 *
 * One instance per parent Agent; {@link observe} wraps exactly one `Agent.stream()`
 * at a time (the runtime serializes turns). It remembers which tool-use ids the
 * stream showed as routed to the background — a `beforeToolCallEvent` for a
 * delegation tool whose input carries the flag and which no hook cancelled — and
 * yields the hook-observed `AfterToolCallEvent` for those ids in front of the next SDK
 * event. Ids a stream `afterToolCallEvent` closes are dropped (a denied or foreground
 * call); so is an id whose `toolResultEvent` is not an ack (admission failed: no run
 * follows). The ledger is **not** reset per stream: with `waitForCompletion: false` a
 * child outlives the turn that dispatched it, so an id stays pending across turns, an
 * `AfterToolCallEvent` that arrives between turns is buffered and yielded at the next
 * stream's start, and the recorder and every driver still see exactly one
 * before/after pair per delegation. An entry leaves the ledger when the SDK delivers
 * its result pair — the `messageAddedEvent` whose tool result carries the task id —
 * which is also the moment the SDK stops tracking the task, so {@link list} is what
 * `/clear` and `/rewind` consult before the SDK's `assertCanLoadSnapshot` would throw.
 * Settlement listeners fire once per task, from the hook, with the terminal snapshot.
 */
export class BackgroundDelegationObserver {
  private readonly delegationTools: ReadonlySet<string>;
  private readonly pending = new Map<string, TrackedDelegation>();
  private readonly listeners = new Set<BackgroundDelegationListener>();
  private ready: AfterToolCallEvent[] = [];

  constructor(delegationTools: readonly string[]) {
    this.delegationTools = new Set(delegationTools);
  }

  /** Registers the hook on the parent; call once, after construction. */
  install(agent: Agent): void {
    agent.addHook(
      AfterToolCallEvent,
      (event) => {
        const entry = this.pending.get(event.toolUse.toolUseId);
        if (entry === undefined) return;
        this.ready.push(event);
        entry.settledAt = new Date().toISOString();
        entry.state = event.result.status === 'error' ? 'failed' : 'succeeded';
        // A run so short that its body returned before the stream yielded the ack
        // is published when the ack names the task (see `toolResultEvent` below).
        if (entry.taskId !== undefined) this.publish(snapshot({ ...entry, taskId: entry.taskId }));
      },
      { order: HookOrder.SDK_LAST },
    );
  }

  private publish(status: BackgroundDelegationStatus): void {
    for (const listener of this.listeners) listener(status);
  }

  /** Tool-use ids routed to the background and not yet settled. */
  get pendingCount(): number {
    let count = 0;
    for (const entry of this.pending.values()) if (entry.state === 'running') count += 1;
    return count;
  }

  /** Every delegation the SDK still tracks, running or settled-undelivered, in dispatch order. */
  list(): BackgroundDelegationStatus[] {
    const tracked: BackgroundDelegationStatus[] = [];
    for (const entry of this.pending.values()) {
      if (entry.taskId !== undefined) tracked.push(snapshot({ ...entry, taskId: entry.taskId }));
    }
    return tracked;
  }

  /** Publishes each task's one terminal snapshot until the returned closure is called. */
  subscribe(listener: BackgroundDelegationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async *observe(events: AsyncIterable<AgentStreamEvent>): AsyncIterable<AgentStreamEvent> {
    // A settlement that arrived between turns is the first thing the new stream shows.
    yield* this.drain();
    for await (const event of events) {
      if (event.type === 'beforeToolCallEvent') {
        if (
          !event.cancel &&
          this.delegationTools.has(event.toolUse.name) &&
          backgroundExecutionRequested(event.toolUse.input)
        ) {
          this.pending.set(event.toolUse.toolUseId, {
            taskId: undefined,
            toolUseId: event.toolUse.toolUseId,
            toolName: event.toolUse.name,
            input: event.toolUse.input,
            startedAt: new Date().toISOString(),
            settledAt: null,
            state: 'running',
          });
        }
      } else if (event.type === 'afterToolCallEvent') {
        this.pending.delete(event.toolUse.toolUseId);
      } else if (event.type === 'toolResultEvent') {
        const entry = this.pending.get(event.result.toolUseId);
        if (entry !== undefined && entry.taskId === undefined) {
          const taskId = event.result.status === 'error' ? undefined : backgroundAckTaskId(event.result.content);
          if (taskId === undefined) {
            this.pending.delete(entry.toolUseId);
          } else {
            entry.taskId = taskId;
            if (entry.state !== 'running') this.publish(snapshot({ ...entry, taskId }));
          }
        }
      } else if (event.type === 'messageAddedEvent' && event.message.role === 'user') {
        for (const block of event.message.content) {
          if (block.type !== 'toolResultBlock') continue;
          for (const entry of this.pending.values()) {
            if (entry.taskId === block.toolUseId) this.pending.delete(entry.toolUseId);
          }
        }
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

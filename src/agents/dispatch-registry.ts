/**
 * Per-dispatch state for the delegation tool, and the provenance the permission
 * gate needs to say *which* agent asked.
 *
 * Shaped after {@link BackgroundBashManager}: the runtime owns one registry,
 * consumers observe it (a snapshot list plus a terminal-transition subscription),
 * and everything user-facing is bounded at presentation time. Nothing here reads
 * a child's messages, tool payloads or reasoning — a dispatch record is name, task
 * text, closed phase, state, timestamps and the child meter's usage counters, so
 * observability cannot become a way for
 * child transcript to reach the parent conversation.
 *
 * Read-heavy first, deliberately: concurrent dispatches share one working tree
 * with no isolation, locking or conflict detection whatsoever. Nothing in this
 * module makes concurrent *write* delegation safe, and it is not meant to —
 * delegate reads/searches in parallel, and keep mutation on one agent at a time.
 * The one write-related fact a record may carry is the `writeScopes` a
 * `workflow` node *declared* (SER-065): normalized path prefixes handed through
 * {@link SubagentDispatchSource} to the permission gate, which is the only
 * thing that enforces them. The registry stores and reports; it never judges.
 */
import { randomUUID } from 'node:crypto';

import { sumUsage, type UsageTotals } from '../agent/usage.js';

export const SUBAGENT_HEARTBEAT_INTERVAL_MS = 30_000;

/** `running` until the dispatch settles; terminal states are published once. */
export type SubagentDispatchState = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type TerminalSubagentDispatchState = Exclude<SubagentDispatchState, 'running'>;
export type SubagentDispatchPhase =
  | { readonly kind: 'starting' }
  | { readonly kind: 'model' }
  | { readonly kind: 'tool'; readonly toolName: string };

export interface SubagentDispatchStatus {
  /**
   * Short, human-quotable dispatch identity derived from the parent `tool_use`
   * id — the same id the live tool row, the `/agents` report, the permission
   * label and the completion notice all show, so one dispatch reads as one thing
   * everywhere.
   */
  readonly dispatchId: string;
  readonly agentName: string;
  /** Full delegated task text. Bounded only when rendered. */
  readonly task: string;
  readonly state: SubagentDispatchState;
  readonly phase: SubagentDispatchPhase;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /**
   * The child's own `metrics.accumulatedUsage`: live while running, frozen at
   * the terminal transition (a cancelled or failed child keeps what it spent).
   * Counters only, never transcript; absent when the child never attached a
   * reader or its meter could not be read.
   */
  readonly usage?: UsageTotals;
}

export interface SubagentDispatchProgress {
  readonly dispatchId: string;
  readonly agentName: string;
  readonly phase: SubagentDispatchPhase;
  readonly elapsedMs: number;
  /** False for immediate safe phase updates; true for periodic user-visible heartbeats. */
  readonly heartbeat: boolean;
}

/** What the permission gate carries on a request: who asked, in what dispatch. */
export interface SubagentDispatchSource {
  readonly dispatchId: string;
  /** Bounded for display, like {@link dispatchLabel} — prompts are display. */
  readonly agentName: string;
  /** Bounded, ready to render: `<agent>#<dispatchId>`. */
  readonly label: string;
  /**
   * Declared `workflow` node write scopes (SER-065): normalized project-relative
   * path prefixes, already validated by the tool. Absent for `subagent`
   * dispatches and unscoped nodes, which the gate must treat exactly as before.
   */
  readonly writeScopes?: readonly string[];
}

/** Receives one immutable snapshot when a dispatch first reaches a terminal state. */
export type SubagentDispatchListener = (dispatch: Readonly<SubagentDispatchStatus>) => void;
export type SubagentDispatchProgressListener = (progress: Readonly<SubagentDispatchProgress>) => void;

export type SubagentCancelResult =
  | { readonly outcome: 'cancelled'; readonly dispatch: SubagentDispatchStatus }
  | { readonly outcome: 'not-found' | 'ambiguous' | 'terminal' | 'already-requested' };

/**
 * The writer's half of one dispatch. Handed to the caller that started it so no
 * record key has to be threaded through the dispatch flow.
 */
export interface SubagentDispatchHandle {
  readonly dispatchId: string;
  /** Binds the child `Agent.id`, which only exists after the child is built. */
  attachAgent(agentId: string): void;
  /** Installs the only operation targeted cancellation may perform. */
  attachCancel(cancel: () => void): void;
  /**
   * Installs a reader over the child's live usage meter — counters only, never
   * transcript. Ignored once terminal, like {@link attachCancel}.
   */
  attachUsage(read: () => UsageTotals): void;
  /** True even if cancellation arrived before child construction completed. */
  cancellationRequested(): boolean;
  /** Publishes only closed, reasoning-safe phase metadata. */
  setPhase(phase: SubagentDispatchPhase): void;
  /** First call wins; later calls are ignored, as are calls after one another. */
  finish(state: TerminalSubagentDispatchState): void;
}

/** Agent names are `[a-zA-Z0-9_-]{1,64}`, so a label needs a bound of its own. */
const AGENT_NAME_LABEL_LIMIT = 16;

interface DispatchRecord {
  readonly dispatchId: string;
  readonly agentName: string;
  readonly task: string;
  state: SubagentDispatchState;
  phase: SubagentDispatchPhase;
  readonly startedAt: string;
  readonly startedAtMs: number;
  finishedAt: string | null;
  cancellationRequested: boolean;
  cancel: (() => void) | undefined;
  /** Live meter reader while running; dropped at the terminal transition. */
  readUsage: (() => UsageTotals) | undefined;
  /** The last reading, frozen by `finish()`; `undefined` until terminal. */
  usage: UsageTotals | undefined;
  heartbeat: ReturnType<typeof setInterval> | undefined;
  /** Frozen copy of the declared scopes; `undefined` when none were declared. */
  readonly writeScopes: readonly string[] | undefined;
}

export interface SubagentDispatchRegistryOptions {
  /** Narrow deterministic test seam; production is fixed at no more than 30 seconds. */
  readonly heartbeatIntervalMs?: number;
  readonly now?: () => number;
}

export class SubagentDispatchRegistry {
  /** Insertion-ordered, keyed privately so two dispatches can share a display id. */
  private readonly records = new Map<string, DispatchRecord>();
  /** Child `Agent.id` → private record key, for permission provenance. */
  private readonly byAgentId = new Map<string, string>();
  private readonly listeners = new Set<SubagentDispatchListener>();
  private readonly progressListeners = new Set<SubagentDispatchProgressListener>();
  private readonly heartbeatIntervalMs: number;
  private readonly now: () => number;

  constructor(options: SubagentDispatchRegistryOptions = {}) {
    this.heartbeatIntervalMs = Math.max(1, Math.min(
      SUBAGENT_HEARTBEAT_INTERVAL_MS,
      options.heartbeatIntervalMs ?? SUBAGENT_HEARTBEAT_INTERVAL_MS,
    ));
    this.now = options.now ?? Date.now;
  }

  begin(dispatch: {
    agentName: string;
    task: string;
    toolUseId?: string | undefined;
    /** `workflow` nodes only: normalized scopes the tool already validated. */
    writeScopes?: readonly string[] | undefined;
  }): SubagentDispatchHandle {
    const key = randomUUID();
    const startedAtMs = this.now();
    const record: DispatchRecord = {
      dispatchId: shortDispatchId(dispatch.toolUseId),
      agentName: dispatch.agentName,
      task: dispatch.task,
      state: 'running',
      phase: { kind: 'starting' },
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
      finishedAt: null,
      cancellationRequested: false,
      cancel: undefined,
      readUsage: undefined,
      usage: undefined,
      heartbeat: undefined,
      writeScopes: dispatch.writeScopes === undefined ? undefined : Object.freeze([...dispatch.writeScopes]),
    };
    this.records.set(key, record);
    record.heartbeat = setInterval(() => this.publishProgress(record, true), this.heartbeatIntervalMs);
    record.heartbeat.unref?.();

    return {
      dispatchId: record.dispatchId,
      attachAgent: (agentId) => {
        if (record.state === 'running') this.byAgentId.set(agentId, key);
      },
      attachCancel: (cancel) => {
        if (record.state !== 'running') return;
        record.cancel = cancel;
        if (record.cancellationRequested) this.invokeCancel(record);
      },
      attachUsage: (read) => {
        if (record.state === 'running') record.readUsage = read;
      },
      cancellationRequested: () => record.cancellationRequested,
      setPhase: (phase) => this.setPhase(record, phase),
      finish: (state) => this.finish(key, state),
    };
  }

  /** Snapshots every dispatch of this run in start order, finished ones included. */
  list(): SubagentDispatchStatus[] {
    return [...this.records.values()].map(snapshot);
  }

  /**
   * Dispatches not yet settled — the number the concurrency cap compares
   * against. A `workflow` node counts from `begin()` even while the SDK graph has
   * it waiting on a dependency; a slot frees only at the terminal transition.
   */
  runningCount(): number {
    let running = 0;
    for (const record of this.records.values()) if (record.state === 'running') running += 1;
    return running;
  }

  /**
   * Every token this run's children have spent so far, summed over each
   * dispatch's current snapshot usage — running children read live, finished
   * ones report their frozen terminal reading. `dispatches` counts only the
   * dispatches whose usage was included in the sum: one whose meter was never
   * attached or could not be read is excluded rather than summed as zero.
   * `undefined` when no dispatch ever reported usage, so every surface keeps
   * its zero-dispatch form instead of inventing an all-zero children section.
   */
  totalUsage(): { dispatches: number; usage: UsageTotals } | undefined {
    const reported = [...this.records.values()]
      .map((record) => currentUsage(record))
      .filter((usage): usage is UsageTotals => usage !== undefined);
    if (reported.length === 0) return undefined;
    return { dispatches: reported.length, usage: sumUsage(reported) };
  }

  /** Subscribes to future terminal transitions; finished dispatches are not replayed. */
  subscribe(listener: SubagentDispatchListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Safe phase changes and periodic heartbeats; neither is persisted or model-visible. */
  subscribeProgress(listener: SubagentDispatchProgressListener): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  /** User-only exact-id cancellation. Collisions fail closed rather than cancelling several children. */
  cancel(dispatchId: string): SubagentCancelResult {
    const matches = [...this.records.values()].filter((record) => record.dispatchId === dispatchId);
    if (matches.length === 0) return { outcome: 'not-found' };
    if (matches.length > 1) return { outcome: 'ambiguous' };
    const record = matches[0]!;
    if (record.state !== 'running') return { outcome: 'terminal' };
    if (record.cancellationRequested) return { outcome: 'already-requested' };
    record.cancellationRequested = true;
    this.invokeCancel(record);
    return { outcome: 'cancelled', dispatch: snapshot(record) };
  }

  /**
   * Resolves a permission request's origin. `undefined` means "not a tracked
   * dispatch", which in darwin means the one assembled parent agent: the runtime
   * builds exactly one `Agent` plus the children this registry records.
   */
  sourceFor(agentId: string): SubagentDispatchSource | undefined {
    const key = this.byAgentId.get(agentId);
    const record = key === undefined ? undefined : this.records.get(key);
    if (record === undefined) return undefined;
    return {
      dispatchId: record.dispatchId,
      agentName: boundedAgentName(record.agentName),
      label: dispatchLabel(record),
      ...(record.writeScopes === undefined ? {} : { writeScopes: record.writeScopes }),
    };
  }

  private invokeCancel(record: DispatchRecord): void {
    try {
      record.cancel?.();
    } catch {
      // Cancellation is best-effort and cannot corrupt the parent turn.
    }
  }

  private setPhase(record: DispatchRecord, phase: SubagentDispatchPhase): void {
    if (record.state !== 'running') return;
    record.phase = phase.kind === 'tool'
      ? { kind: 'tool', toolName: boundedToolName(phase.toolName) }
      : phase;
    this.publishProgress(record, false);
  }

  private publishProgress(record: DispatchRecord, heartbeat: boolean): void {
    if (record.state !== 'running') return;
    const progress: SubagentDispatchProgress = {
      dispatchId: record.dispatchId,
      agentName: boundedAgentName(record.agentName),
      phase: record.phase,
      elapsedMs: Math.max(0, Math.floor(this.now() - record.startedAtMs)),
      heartbeat,
    };
    for (const listener of this.progressListeners) {
      try {
        listener(progress);
      } catch {
        // Progress is advisory; observers cannot affect child execution.
      }
    }
  }

  /** One terminal transition per dispatch; it also tears down the private timer/canceller. */
  private finish(key: string, state: TerminalSubagentDispatchState): void {
    const record = this.records.get(key);
    if (record === undefined || record.state !== 'running') return;
    // Freeze the meter's last reading before the terminal snapshot is published,
    // so a cancelled or failed child still reports what it spent before settling.
    record.usage = currentUsage(record);
    record.readUsage = undefined;
    record.state = state;
    record.finishedAt = new Date(this.now()).toISOString();
    if (record.heartbeat !== undefined) clearInterval(record.heartbeat);
    record.heartbeat = undefined;
    record.cancel = undefined;

    const completed = snapshot(record);
    for (const listener of this.listeners) {
      try {
        listener(completed);
      } catch {
        // Observers are advisory; the dispatch result is what matters.
      }
    }
  }
}

function snapshot(record: DispatchRecord): SubagentDispatchStatus {
  const usage = currentUsage(record);
  return {
    dispatchId: record.dispatchId,
    agentName: record.agentName,
    task: record.task,
    state: record.state,
    phase: record.phase,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    ...(usage !== undefined && { usage }),
  };
}

/**
 * One dispatch's current spend: the frozen terminal reading once finished, a
 * live meter reading while running. A reader that throws degrades to
 * `undefined` — an observer over a child's meter must never become a second
 * reason a dispatch (or a projection over it) fails.
 */
function currentUsage(record: DispatchRecord): UsageTotals | undefined {
  if (record.usage !== undefined) return record.usage;
  if (record.readUsage === undefined) return undefined;
  try {
    return record.readUsage();
  } catch {
    return undefined;
  }
}

/**
 * Bounded display id for one dispatch.
 *
 * Pure in the parent `tool_use` id so the TUI reducer can compute the same id from
 * a stream event without reaching into the registry. Provider ids carry a
 * `tooluse_` prefix that distinguishes nothing, so it is dropped before the id is
 * shortened. A missing id (a direct `.invoke()` outside a tool call) falls back to
 * a random one rather than a shared placeholder.
 */
export function shortDispatchId(toolUseId: string | undefined): string {
  const distinguishing = (toolUseId ?? '').replace(/^tool_?use[_-]?/i, '').replace(/[^a-zA-Z0-9]/g, '');
  return distinguishing === '' ? randomUUID().replace(/-/g, '').slice(0, 8) : distinguishing.slice(0, 8);
}

/**
 * `<agent>#<dispatchId>` — the identity every surface shows for one dispatch: the
 * prompt label, the `/agents` row, the live tool row and the completion notice.
 * One definition, so those four can never drift apart, and the name is bounded
 * here so a 64-character definition name cannot stretch any of them.
 */
export function dispatchLabel(dispatch: { agentName: string; dispatchId: string }): string {
  return `${boundedAgentName(dispatch.agentName)}#${dispatch.dispatchId}`;
}

/** Keeps a 64-character agent name from stretching a permission-prompt line. */
function boundedAgentName(name: string): string {
  return name.length <= AGENT_NAME_LABEL_LIMIT ? name : `${name.slice(0, AGENT_NAME_LABEL_LIMIT - 1)}…`;
}

/** Closed, bounded child tool metadata for progress. */
function boundedToolName(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 64);
  return normalized === '' ? 'tool' : normalized;
}

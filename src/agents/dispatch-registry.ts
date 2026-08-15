/**
 * Per-dispatch state for the delegation tool, and the provenance the permission
 * gate needs to say *which* agent asked.
 *
 * Shaped after {@link BackgroundBashManager}: the runtime owns one registry,
 * consumers observe it (a snapshot list plus a terminal-transition subscription),
 * and everything user-facing is bounded at presentation time. Nothing here reads
 * a child's messages, tools or reasoning — a dispatch record is name, task text,
 * state and timestamps, so making delegation observable cannot become a way for
 * child transcript to reach the parent conversation.
 *
 * Read-heavy first, deliberately: concurrent dispatches share one working tree
 * with no isolation, locking or conflict detection whatsoever. Nothing in this
 * module makes concurrent *write* delegation safe, and it is not meant to —
 * delegate reads/searches in parallel, and keep mutation on one agent at a time.
 */
import { randomUUID } from 'node:crypto';

/** `running` until the dispatch settles; terminal states are published once. */
export type SubagentDispatchState = 'running' | 'succeeded' | 'failed' | 'cancelled';

export type TerminalSubagentDispatchState = Exclude<SubagentDispatchState, 'running'>;

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
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

/** What the permission gate carries on a request: who asked, in what dispatch. */
export interface SubagentDispatchSource {
  readonly dispatchId: string;
  /** Bounded for display, like {@link dispatchLabel} — prompts are display. */
  readonly agentName: string;
  /** Bounded, ready to render: `<agent>#<dispatchId>`. */
  readonly label: string;
}

/** Receives one immutable snapshot when a dispatch first reaches a terminal state. */
export type SubagentDispatchListener = (dispatch: Readonly<SubagentDispatchStatus>) => void;

/**
 * The writer's half of one dispatch. Handed to the caller that started it so no
 * record key has to be threaded through the dispatch flow.
 */
export interface SubagentDispatchHandle {
  readonly dispatchId: string;
  /** Binds the child `Agent.id`, which only exists after the child is built. */
  attachAgent(agentId: string): void;
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
  readonly startedAt: string;
  finishedAt: string | null;
}

export class SubagentDispatchRegistry {
  /** Insertion-ordered, keyed privately so two dispatches can share a display id. */
  private readonly records = new Map<string, DispatchRecord>();
  /** Child `Agent.id` → private record key, for permission provenance. */
  private readonly byAgentId = new Map<string, string>();
  private readonly listeners = new Set<SubagentDispatchListener>();

  begin(dispatch: { agentName: string; task: string; toolUseId?: string | undefined }): SubagentDispatchHandle {
    const key = randomUUID();
    const record: DispatchRecord = {
      dispatchId: shortDispatchId(dispatch.toolUseId),
      agentName: dispatch.agentName,
      task: dispatch.task,
      state: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.records.set(key, record);

    return {
      dispatchId: record.dispatchId,
      attachAgent: (agentId) => {
        this.byAgentId.set(agentId, key);
      },
      finish: (state) => this.finish(key, state),
    };
  }

  /** Snapshots every dispatch of this run in start order, finished ones included. */
  list(): SubagentDispatchStatus[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  /** Subscribes to future terminal transitions; finished dispatches are not replayed. */
  subscribe(listener: SubagentDispatchListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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
    };
  }

  /**
   * One terminal transition per dispatch, published to every listener. A listener
   * that throws must not lose the event for the others, and must not take down
   * the dispatch that was merely reporting itself finished.
   */
  private finish(key: string, state: TerminalSubagentDispatchState): void {
    const record = this.records.get(key);
    if (record === undefined || record.state !== 'running') return;
    record.state = state;
    record.finishedAt = new Date().toISOString();

    const snapshot: SubagentDispatchStatus = { ...record };
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Observers are advisory; the dispatch result is what matters.
      }
    }
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

/**
 * Which background jobs' terminal states the model has already seen (SER-069).
 *
 * A background-task wake exists to start a turn when nothing else would tell the
 * model a `bash start` job finished. When the model itself observed the terminal
 * state — a `wait` that returned `reason: 'terminal'` (or any wait/status/stop/list
 * result carrying the task's non-running `state`) inside a turn that then
 * **completed** — a wake would only start a duplicate turn about a fact the
 * conversation already holds (the peer's `TaskOutput` duplicate-turn failure
 * mode). This ledger is how the drain knows.
 *
 * Observed at the same point the recorder observes: synchronously, between
 * `agent.stream()` and the `yield`, over the parent runtime's own stream only.
 * Ids seen in a turn stay *pending* until the turn closes; only a completed turn
 * (`endTurn`) commits them, because a cancelled turn's tool result may never have
 * been reasoned about. `observe` cannot throw — observer discipline: a ledger
 * failure costs a possible duplicate wake, never a turn.
 */

import type { AgentStreamEvent } from '@strands-agents/sdk';

const TERMINAL_STATES: ReadonlySet<string> = new Set(['succeeded', 'failed', 'stopped']);
const TASK_ID = /^bg-[0-9a-f-]{36}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A manager snapshot (`status`/`stop`/`list` item, or `wait`'s `status`) in a terminal state. */
function terminalSnapshotId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const { taskId, state } = value;
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) return undefined;
  return typeof state === 'string' && TERMINAL_STATES.has(state) ? taskId : undefined;
}

/** The JSON payload of one tool result, whether the SDK carried it as a JSON block or JSON text. */
function resultPayload(content: readonly unknown[]): unknown {
  if (content.length !== 1 || !isRecord(content[0])) return undefined;
  const block = content[0];
  if (block.type === 'jsonBlock') return block.json;
  if (block.type === 'textBlock' && typeof block.text === 'string') {
    try {
      return JSON.parse(block.text) as unknown;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Task ids whose terminal state a successful `bash` result carried to the model.
 * Recognizes the manager's own shapes only — `wait` (`status.state`), `status`/`stop`
 * (a snapshot) and `list` (snapshots) — by the result, never by the input, because
 * some SDK after-events omit the original input. Foreground `execute` results and
 * `output` results carry no state and contribute nothing.
 */
export function terminalTaskIdsInToolResult(
  toolName: string,
  result: { readonly status: string; readonly content: readonly unknown[] },
): string[] {
  if (toolName !== 'bash' || result.status !== 'success') return [];
  const payload = resultPayload(result.content);
  if (Array.isArray(payload)) {
    return payload.map(terminalSnapshotId).filter((id): id is string => id !== undefined);
  }
  if (!isRecord(payload)) return [];
  const direct = terminalSnapshotId(payload);
  if (direct !== undefined) return [direct];
  // `wait`: `{ reason, status: <snapshot>, output }` — whatever the reason, a
  // non-running `status.state` is the terminal state delivered.
  if (typeof payload.reason === 'string') {
    const waited = terminalSnapshotId(payload.status);
    if (waited !== undefined) return [waited];
  }
  return [];
}

export class TerminalDeliveryLedger {
  private readonly delivered = new Set<string>();
  private pending = new Set<string>();

  /** Observes one stream event of the current turn. Synchronous, non-throwing. */
  observe(event: AgentStreamEvent): void {
    try {
      if (event.type !== 'afterToolCallEvent') return;
      const { toolUse, result } = event as unknown as {
        toolUse?: { name?: unknown };
        result?: { status?: unknown; content?: unknown };
      };
      if (typeof toolUse?.name !== 'string' || !isRecord(result) || !Array.isArray(result.content)) return;
      for (const id of terminalTaskIdsInToolResult(toolUse.name, {
        status: String(result.status),
        content: result.content,
      })) {
        this.pending.add(id);
      }
    } catch {
      // Observer discipline: never a second reason a turn dies.
    }
  }

  /**
   * Closes the current turn: a completed turn commits what it delivered, any other
   * ending forgets it (the wake then still fires, and the model re-reads the state).
   */
  closeTurn(completed: boolean): void {
    if (completed) for (const id of this.pending) this.delivered.add(id);
    this.pending = new Set();
  }

  /** True once a completed turn carried this task's terminal state to the model. */
  has(taskId: string): boolean {
    return this.delivered.has(taskId);
  }
}

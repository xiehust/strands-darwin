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
 *
 * SRF-036: the SDK `ContextOffloader` replaces an oversized result at default hook
 * order with an `[Offloaded: …]` text preview, so the stream carries only the
 * preview. {@link TerminalDeliveryLedger.install} therefore registers one
 * `HookOrder.SDK_FIRST` `AfterToolCallEvent` hook that reads the *original* result
 * and keeps its terminal ids as candidates keyed by `toolUseId`; `observe` resolves
 * them against the result the stream actually carries. Unchanged, it counts exactly
 * as before. Replaced, a candidate id counts only when the model-visible
 * replacement text contains that exact id, so snapshots cut off by the preview stay
 * undelivered. The preview is only searched for the literal id, never parsed for
 * state: the state comes from the original.
 */

import { AfterToolCallEvent, HookOrder } from '@strands-agents/sdk';
import type { Agent, AgentStreamEvent } from '@strands-agents/sdk';

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
 * The array inside the SDK's ordinary-array envelope, or undefined. The SDK's
 * `FunctionTool` cannot hand a plain array to Bedrock as JSON content, so it returns
 * one as `new JsonBlock({ json: { $value: array } })` — which is how `list`'s
 * `manager.list()` reaches the model (SRF-033). Exactly that shape is unwrapped, one
 * level: an object whose only own key is `$value`, holding an array. Extra keys, a
 * non-array `$value` and envelopes nested inside the array are not the SDK's shape
 * and are not unwrapped.
 */
function sdkArrayEnvelope(payload: unknown): unknown[] | undefined {
  if (!isRecord(payload)) return undefined;
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== '$value') return undefined;
  const value = payload.$value;
  return Array.isArray(value) ? value : undefined;
}

/**
 * Task ids whose terminal state a successful `bash` result carried to the model.
 * Recognizes the manager's own shapes only — `wait` (`status.state`), `status`/`stop`
 * (a snapshot) and `list` (snapshots: a bare array, or the SDK's `{ $value: [...] }`
 * envelope the real tool path produces) — by the result, never by the input, because
 * some SDK after-events omit the original input. Foreground `execute` results and
 * `output` results carry no state and contribute nothing.
 */
export function terminalTaskIdsInToolResult(
  toolName: string,
  result: { readonly status: string; readonly content: readonly unknown[] },
): string[] {
  if (toolName !== 'bash' || result.status !== 'success') return [];
  const payload = resultPayload(result.content);
  const listed = Array.isArray(payload) ? payload : sdkArrayEnvelope(payload);
  if (listed !== undefined) {
    return listed.map(terminalSnapshotId).filter((id): id is string => id !== undefined);
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

/** Whether any text block of a model-visible result contains `id` verbatim. */
function textContains(content: readonly unknown[], id: string): boolean {
  return content.some((block) =>
    isRecord(block) && block.type === 'textBlock' && typeof block.text === 'string' && block.text.includes(id));
}

/** The original result an SDK_FIRST hook saw, and the terminal ids it carried. */
interface Candidate {
  readonly result: unknown;
  readonly ids: readonly string[];
}

export class TerminalDeliveryLedger {
  private readonly delivered = new Set<string>();
  private pending = new Set<string>();
  /** Pre-replacement terminal ids per `toolUseId`, resolved by `observe`, dropped by `closeTurn`. */
  private candidates = new Map<string, Candidate>();

  /**
   * Registers the pre-offload hook on the parent Agent: `SDK_FIRST`, so it runs
   * before the `ContextOffloader`'s default-order hook can replace the result.
   * It only reads; it never changes the event.
   */
  install(agent: Pick<Agent, 'addHook'>): void {
    agent.addHook(AfterToolCallEvent, (event) => this.candidate(event), { order: HookOrder.SDK_FIRST });
  }

  /** Records the original result's terminal ids for `observe`. Synchronous, non-throwing. */
  candidate(event: AfterToolCallEvent): void {
    try {
      const { toolUse, result } = event as unknown as {
        toolUse?: { name?: unknown; toolUseId?: unknown };
        result?: { status?: unknown; content?: unknown };
      };
      if (typeof toolUse?.name !== 'string' || typeof toolUse.toolUseId !== 'string') return;
      if (!isRecord(result) || !Array.isArray(result.content)) return;
      const ids = terminalTaskIdsInToolResult(toolUse.name, { status: String(result.status), content: result.content });
      if (ids.length > 0) this.candidates.set(toolUse.toolUseId, { result, ids });
      else this.candidates.delete(toolUse.toolUseId);
    } catch {
      // Observer discipline: a lost candidate costs a possible duplicate wake, never a turn.
    }
  }

  /** Observes one stream event of the current turn. Synchronous, non-throwing. */
  observe(event: AgentStreamEvent): void {
    try {
      if (event.type !== 'afterToolCallEvent') return;
      const { toolUse, result } = event as unknown as {
        toolUse?: { name?: unknown; toolUseId?: unknown };
        result?: { status?: unknown; content?: unknown };
      };
      const candidate = typeof toolUse?.toolUseId === 'string' ? this.candidates.get(toolUse.toolUseId) : undefined;
      if (candidate !== undefined) this.candidates.delete(toolUse?.toolUseId as string);
      if (typeof toolUse?.name !== 'string' || !isRecord(result) || !Array.isArray(result.content)) return;
      const status = String(result.status);
      for (const id of terminalTaskIdsInToolResult(toolUse.name, { status, content: result.content })) {
        this.pending.add(id);
      }
      // A replaced result (the offloader's preview): the original's ids count only
      // where the model-visible text still names them exactly.
      if (candidate !== undefined && candidate.result !== result && status === 'success') {
        for (const id of candidate.ids) if (textContains(result.content, id)) this.pending.add(id);
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
    this.candidates = new Map();
  }

  /** True once a completed turn carried this task's terminal state to the model. */
  has(taskId: string): boolean {
    return this.delivered.has(taskId);
  }
}

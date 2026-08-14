/**
 * Bridges the async {@link PermissionBridge} contract to React state.
 *
 * The gate awaits a promise deep inside the agent loop; the UI resolves it from a
 * keypress handler. This queue is the seam between them, and lives outside React
 * so the bridge can be handed to `AgentRuntime.create()` before any component
 * mounts.
 *
 * Requests are serialized: concurrent tool calls each get their own prompt, one
 * at a time, so two confirmations can never race for the same keystroke.
 */
import type {
  AssessedPermissionRequest,
  PermissionBridge,
  PermissionDecision,
} from '../agent/permission.js';

interface QueueEntry {
  request: AssessedPermissionRequest;
  resolve: (decision: PermissionDecision) => void;
}

export class PermissionQueue {
  private readonly entries: QueueEntry[] = [];
  private readonly listeners = new Set<() => void>();
  /** Set once the session is over, so late requests deny instead of hanging. */
  private closed = false;

  /** The {@link PermissionBridge} to hand to the runtime. */
  readonly bridge: PermissionBridge = (request) =>
    new Promise<PermissionDecision>((resolve) => {
      if (this.closed) {
        resolve({ allowed: false });
        return;
      }
      this.entries.push({ request, resolve });
      this.emit();
    });

  /** The request currently awaiting an answer, if any. */
  get current(): AssessedPermissionRequest | undefined {
    return this.entries[0]?.request;
  }

  /** How many requests are waiting behind the current one. */
  get waiting(): number {
    return Math.max(0, this.entries.length - 1);
  }

  /** Answers the current request. No-op when nothing is pending. */
  answer(decision: PermissionDecision): void {
    const entry = this.entries.shift();
    if (entry === undefined) return;
    entry.resolve(decision);
    this.emit();
  }

  /**
   * Denies everything still queued, leaving the queue usable.
   *
   * For cancelling a turn: the agent loop may be blocked on a prompt the user has
   * just abandoned, but the session continues and later turns must still be able
   * to ask.
   */
  denyPending(): void {
    while (this.entries.length > 0) {
      this.entries.shift()?.resolve({ allowed: false });
    }
    this.emit();
  }

  /**
   * Denies everything queued and refuses future requests. Called on shutdown, so
   * a tool call racing the exit cannot leave the agent loop waiting forever on a
   * prompt nobody will answer.
   */
  close(): void {
    this.closed = true;
    this.denyPending();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Identity changes whenever the queue changes, for useSyncExternalStore. */
  getSnapshot = (): AssessedPermissionRequest | undefined => this.current;

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

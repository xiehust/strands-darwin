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
 *
 * One request can also leave without being answered: `request.withdrawn` fires when
 * the user changes the permission mode, and the entry is dropped so the question
 * asked under the old policy cannot stay on screen.
 */
import type {
  AssessedPermissionRequest,
  PermissionBridge,
  PermissionDecision,
} from '../agent/permission.js';

interface QueueEntry {
  request: AssessedPermissionRequest;
  resolve: (decision: PermissionDecision) => void;
  /** Stops listening for withdrawal once this entry has left the queue. */
  release: () => void;
  observed: boolean;
}

export class PermissionQueue {
  private observedIdentities = new WeakSet<object>();

  constructor(private observe?: (source: string) => void) {}

  /** Installs a session-owned observer; `/clear` starts a fresh identity scope. */
  setObserver(observe: ((source: string) => void) | undefined): void {
    this.observe = observe;
    this.observedIdentities = new WeakSet<object>();
    this.observeCurrent();
  }
  private readonly entries: QueueEntry[] = [];
  private readonly listeners = new Set<() => void>();
  /** Set once the session is over, so late requests deny instead of hanging. */
  private closed = false;

  /** The {@link PermissionBridge} to hand to the runtime. */
  readonly bridge: PermissionBridge = (request) =>
    new Promise<PermissionDecision>((resolve) => {
      if (this.closed || request.withdrawn.aborted) {
        resolve({ allowed: false });
        return;
      }
      const entry: QueueEntry = { request, resolve, release: () => undefined, observed: false };
      // A mode change withdraws the question itself: the gate has stopped waiting
      // and will re-decide the call under the new mode, so the prompt has to leave
      // the screen. Resolving it is bookkeeping — the gate discards this answer.
      const onWithdraw = (): void => {
        this.remove(entry);
      };
      request.withdrawn.addEventListener('abort', onWithdraw, { once: true });
      entry.release = () => {
        request.withdrawn.removeEventListener('abort', onWithdraw);
      };
      this.entries.push(entry);
      this.observeCurrent();
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
    entry.release();
    entry.resolve(decision);
    this.observeCurrent();
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
      const entry = this.entries.shift();
      if (entry === undefined) continue;
      entry.release();
      entry.resolve({ allowed: false });
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

  /**
   * Drops one entry wherever it sits, current or queued, and lets whatever is
   * behind it take the screen. Used only for withdrawal: the promise is settled so
   * the awaiting gate is not left holding it, and the gate discards the value
   * because the withdrawal signal already fired.
   */
  private remove(entry: QueueEntry): void {
    const index = this.entries.indexOf(entry);
    if (index === -1) return;
    this.entries.splice(index, 1);
    entry.release();
    entry.resolve({ allowed: false });
    this.observeCurrent();
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Identity changes whenever the queue changes, for useSyncExternalStore. */
  getSnapshot = (): AssessedPermissionRequest | undefined => this.current;

  private observeCurrent(): void {
    const entry = this.entries[0];
    if (entry === undefined || entry.observed || this.closed) return;
    entry.observed = true;
    const identity = entry.request.promptIdentity;
    if (identity !== undefined) {
      if (this.observedIdentities.has(identity)) return;
      this.observedIdentities.add(identity);
    }
    try {
      this.observe?.(entry.request.source.label);
    } catch {
      // Observation can never alter or strand the permission decision.
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

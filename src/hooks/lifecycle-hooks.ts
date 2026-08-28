import { spawn, type ChildProcess } from 'node:child_process';

import { matchesToolGlob, type ToolHookGroup, type ToolHooksConfig } from './tool-hooks.js';

export const LIFECYCLE_HOOK_PAYLOAD_MAX_BYTES = 4096;
const FORCE_KILL_AFTER_MS = 500;

export type TurnCompleteOutcome = 'success' | 'failure' | 'cancelled';
export type TurnCompleteSource = 'interactive' | 'headless';

export type LifecycleHookEvent =
  | {
      readonly event: 'TurnComplete';
      readonly outcome: TurnCompleteOutcome;
      readonly source: TurnCompleteSource;
    }
  | {
      readonly event: 'PermissionRequest';
      readonly source: string;
    };

/** Shared with the existing tool-hook runner; both own detached hook trees. */
interface RunningLifecycleHook {
  child: ChildProcess;
  forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  reapTimer: ReturnType<typeof setTimeout> | undefined;
  terminating: boolean;
  cleanupDeadline: number;
  finish: () => void;
  settled: Promise<void>;
}

/**
 * Runs configured lifecycle commands as bounded, output-free observers.
 *
 * Publishing is deliberately synchronous and returns no result: command launch,
 * output and exit status cannot delay or alter the turn or permission decision
 * that produced the observation. `close()` is only for process cleanup.
 */
export class LifecycleHookRunner {
  private readonly running = new Set<RunningLifecycleHook>();
  private closed = false;

  constructor(
    private readonly projectRoot: string,
    private readonly hooks: Pick<ToolHooksConfig, 'TurnComplete' | 'PermissionRequest'>,
  ) {}

  publish(event: LifecycleHookEvent): void {
    if (this.closed) return;
    this.publishGroups(event, this.hooks[event.event]);
  }


  /** Publishes one source layer without changing the native payload or process path. */
  publishGroups(event: LifecycleHookEvent, groups: readonly ToolHookGroup[] | undefined): void {
    if (this.closed || groups === undefined) return;
    const payload = serializeLifecycleHookEvent(event);
    if (payload === undefined) return;
    for (const group of groups) {
      if (!matchesToolGlob(group.matcher, event.source)) continue;
      for (const hook of group.hooks) this.spawn(hook.command, payload);
    }
  }

  /** Requests bounded process-group cleanup without waiting for the grace period. */
  cancel(): void {
    for (const running of this.running) terminate(running);
  }

  /** Latches closed, terminates every owned group, and waits until each is reaped. */
  async close(): Promise<void> {
    this.closed = true;
    const running = [...this.running];
    for (const entry of running) terminate(entry);
    await Promise.allSettled(running.map((entry) => entry.settled));
  }

  private spawn(command: string, payload: string): void {
    let child: ChildProcess;
    try {
      child = spawn('/bin/sh', ['-c', command], {
        cwd: this.projectRoot,
        env: process.env,
        stdio: ['pipe', 'ignore', 'ignore'],
        detached: true,
      });
    } catch {
      return;
    }

    let settle!: () => void;
    const running: RunningLifecycleHook = {
      child,
      forceKillTimer: undefined,
      reapTimer: undefined,
      terminating: false,
      cleanupDeadline: 0,
      finish: () => undefined,
      settled: new Promise<void>((resolve) => {
        settle = resolve;
      }),
    };
    running.finish = (): void => {
      if (!this.running.delete(running)) return;
      if (running.forceKillTimer !== undefined) clearTimeout(running.forceKillTimer);
      if (running.reapTimer !== undefined) clearTimeout(running.reapTimer);
      settle();
    };
    this.running.add(running);

    child.once('close', () => {
      if (!running.terminating) running.finish();
    });
    child.once('error', running.finish);
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(payload);

    // close() may have raced the spawn between the initial latch check and here.
    if (this.closed) terminate(running);
  }
}

/** Returns undefined rather than emitting truncated or invalid JSON. */
export function serializeLifecycleHookEvent(event: LifecycleHookEvent): string | undefined {
  const payload = `${JSON.stringify(event)}\n`;
  return Buffer.byteLength(payload, 'utf8') <= LIFECYCLE_HOOK_PAYLOAD_MAX_BYTES
    ? payload
    : undefined;
}

export function lifecycleHooksFromConfig(
  hooks: ToolHooksConfig | undefined,
): Pick<ToolHooksConfig, 'TurnComplete' | 'PermissionRequest'> | undefined {
  if (hooks?.TurnComplete === undefined && hooks?.PermissionRequest === undefined) return undefined;
  return {
    ...(hooks.TurnComplete === undefined ? {} : { TurnComplete: hooks.TurnComplete }),
    ...(hooks.PermissionRequest === undefined ? {} : { PermissionRequest: hooks.PermissionRequest }),
  };
}

function terminate(running: RunningLifecycleHook): void {
  const pid = running.child.pid;
  if (pid === undefined || running.terminating) return;
  running.terminating = true;
  running.cleanupDeadline = Date.now() + FORCE_KILL_AFTER_MS * 4;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    running.finish();
    return;
  }
  running.forceKillTimer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      running.finish();
      return;
    }
    waitForProcessGroupExit(running, pid);
  }, FORCE_KILL_AFTER_MS);
}

function waitForProcessGroupExit(running: RunningLifecycleHook, pid: number): void {
  try {
    process.kill(-pid, 0);
  } catch {
    running.finish();
    return;
  }
  if (Date.now() >= running.cleanupDeadline) {
    running.finish();
    return;
  }
  running.reapTimer = setTimeout(() => waitForProcessGroupExit(running, pid), 20);
}

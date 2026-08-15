import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import {
  InterventionActions,
  InterventionHandler,
  type AfterToolCallEvent,
  type BeforeToolCallEvent,
} from '@strands-agents/sdk';

import type { PermissionGate } from '../agent/permission.js';

export interface ToolHookCommand {
  readonly type: 'command';
  readonly command: string;
}

export interface ToolHookGroup {
  readonly matcher: string;
  readonly hooks: readonly ToolHookCommand[];
}

export interface ToolHooksConfig {
  readonly PreToolUse?: readonly ToolHookGroup[];
  readonly PostToolUse?: readonly ToolHookGroup[];
}

export interface ToolHookResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

type BeforeAction = Awaited<ReturnType<InterventionHandler['beforeToolCall']>>;
type AfterAction = Awaited<ReturnType<InterventionHandler['afterToolCall']>>;

/** Matches a complete, case-sensitive tool name using only `*` and `?` as wildcards. */
export function matchesToolGlob(pattern: string, toolName: string): boolean {
  let source = '^';
  for (const character of pattern) {
    if (character === '*') source += '.*';
    else if (character === '?') source += '.';
    else source += escapeRegex(character);
  }
  return new RegExp(`${source}$`).test(toolName);
}

/** Runs one configured command in a real shell while keeping all output off the terminal. */
export function runToolHookCommand(
  projectRoot: string,
  command: string,
  toolName: string,
  toolInput: unknown,
  signal?: AbortSignal,
): Promise<ToolHookResult> {
  const payload = `${JSON.stringify({ tool_name: toolName, tool_input: toolInput })}\n`;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let launchError: Error | undefined;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('/bin/sh', ['-c', command], {
        cwd: projectRoot,
        env: process.env,
        stdio: 'pipe',
        // Hooks may start their own children. A process group lets cancellation
        // reap the whole command tree instead of orphaning a formatter or test.
        detached: true,
        ...(signal !== undefined && { signal }),
      });
    } catch (error) {
      resolve({
        exitCode: null,
        stdout,
        stderr,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let aborted = false;
    const killProcessGroup = (): void => {
      aborted = true;
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        // The shell may already have exited between abort and this callback.
        return;
      }
      // SIGTERM permits ordinary cleanup. A configured command can ignore it,
      // though, so bound cancellation rather than letting shutdown hang forever.
      forceKillTimer = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // The process group completed during the grace period.
        }
      }, 500);
    };
    signal?.addEventListener('abort', killProcessGroup, { once: true });
    if (signal?.aborted === true) killProcessGroup();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    // A command may exit before consuming stdin. That must be represented by its
    // exit status, not become an unhandled EPIPE in the darwin process.
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => {
      launchError = error;
    });
    child.on('close', (exitCode) => {
      signal?.removeEventListener('abort', killProcessGroup);
      // After abort, the shell leader can exit before a descendant that ignored
      // SIGTERM. Keep the group SIGKILL armed until its grace period elapses.
      if (!aborted && forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (settled) return;
      settled = true;
      resolve({
        exitCode,
        stdout,
        stderr,
        ...(launchError !== undefined && { error: launchError }),
      });
    });

    child.stdin.end(payload);
  });
}

/**
 * Composes deterministic project hooks around the interactive permission policy.
 *
 * Keeping both policies in one SDK intervention is intentional: After callbacks
 * run in reverse handler order, and the SDK emits AfterToolCall even when Before
 * denied a call. Only calls that passed both Pre hooks and permission are marked
 * eligible for Post hooks.
 */
export class ToolHookGate extends InterventionHandler {
  readonly name = 'darwin:tool-hooks';
  private readonly eligible = new WeakMap<object, Set<string>>();

  constructor(
    private readonly projectRoot: string,
    private readonly hooks: ToolHooksConfig,
    private readonly permissionGate: PermissionGate,
  ) {
    super();
  }

  override async beforeToolCall(event: BeforeToolCallEvent): Promise<BeforeAction> {
    // Enforced planning is stricter than ordinary Pre -> permission ordering: a
    // blocked call must not cause even a policy hook shell to execute. The full
    // gate still runs after Pre for every call this narrow guard does not deny.
    const guarded = this.permissionGate.planGuard(event.toolUse.name, event.toolUse.input);
    if (guarded !== undefined) return guarded;

    for (const hook of matchingCommands(this.hooks.PreToolUse, event.toolUse.name)) {
      const result = await runToolHookCommand(
        this.projectRoot,
        hook.command,
        event.toolUse.name,
        event.toolUse.input,
        event.agent.cancelSignal,
      );
      if (event.agent.cancelSignal.aborted) {
        return InterventionActions.deny(`Tool call ${event.toolUse.name} was cancelled before execution.`);
      }
      if (result.error !== undefined || result.exitCode !== 0) {
        return InterventionActions.deny(preFailureReason(hook.command, event.toolUse.name, result));
      }
    }

    if (event.agent.cancelSignal.aborted) {
      return InterventionActions.deny(`Tool call ${event.toolUse.name} was cancelled before execution.`);
    }
    const action = await this.permissionGate.beforeToolCall(event);
    if (event.agent.cancelSignal.aborted) {
      return InterventionActions.deny(`Tool call ${event.toolUse.name} was cancelled before execution.`);
    }
    if (action.type === 'proceed') this.markEligible(event);
    return action;
  }

  override async afterToolCall(event: AfterToolCallEvent): Promise<AfterAction> {
    if (!this.takeEligibility(event)) return InterventionActions.proceed();

    for (const hook of matchingCommands(this.hooks.PostToolUse, event.toolUse.name)) {
      if (event.agent.cancelSignal.aborted) break;
      // Post hooks are observation-only. Every matching command runs, and no
      // failure may replace, retry, or hide the original tool result.
      await runToolHookCommand(
        this.projectRoot,
        hook.command,
        event.toolUse.name,
        event.toolUse.input,
        event.agent.cancelSignal,
      );
    }
    return InterventionActions.proceed();
  }

  private markEligible(event: BeforeToolCallEvent): void {
    let ids = this.eligible.get(event.agent);
    if (ids === undefined) {
      ids = new Set<string>();
      this.eligible.set(event.agent, ids);
    }
    ids.add(event.toolUse.toolUseId);
  }

  private takeEligibility(event: AfterToolCallEvent): boolean {
    const ids = this.eligible.get(event.agent);
    if (ids?.delete(event.toolUse.toolUseId) !== true) return false;
    if (ids.size === 0) this.eligible.delete(event.agent);
    return true;
  }
}

function matchingCommands(
  groups: readonly ToolHookGroup[] | undefined,
  toolName: string,
): ToolHookCommand[] {
  if (groups === undefined) return [];
  return groups.flatMap((group) => matchesToolGlob(group.matcher, toolName) ? group.hooks : []);
}

function preFailureReason(command: string, toolName: string, result: ToolHookResult): string {
  const stderr = result.stderr.trim();
  if (stderr !== '') return stderr;
  if (result.error !== undefined) {
    return `PreToolUse hook for ${toolName} could not launch ${JSON.stringify(command)}: ${result.error.message}. ` +
      'Fix or remove the hook in .darwin/config.json.';
  }
  return `PreToolUse hook for ${toolName} failed with exit code ${String(result.exitCode)} ` +
    `without an error message: ${JSON.stringify(command)}. Fix or remove the hook in .darwin/config.json.`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

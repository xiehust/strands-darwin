import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import {
  InterventionActions,
  InterventionHandler,
  type AfterToolCallEvent,
  type BeforeInvocationEvent,
  type BeforeModelCallEvent,
  type BeforeToolCallEvent,
  type Tool,
} from '@strands-agents/sdk';

import type { PermissionGate } from '../agent/permission.js';
import { RepeatedFailureGuard } from '../agent/retry-guard.js';
import type { ToolHookPolicyLayer } from '../config.js';
import type { CodexHookRunner } from './codex-hook-runner.js';
import type { CodexHookGroup } from './codex-hooks.js';

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
  readonly TurnComplete?: readonly ToolHookGroup[];
  readonly PermissionRequest?: readonly ToolHookGroup[];
}

export interface ToolHookResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

type InvocationAction = Awaited<ReturnType<InterventionHandler['beforeInvocation']>>;
type BeforeAction = Awaited<ReturnType<InterventionHandler['beforeToolCall']>>;
type AfterAction = Awaited<ReturnType<InterventionHandler['afterToolCall']>>;
type ModelAction = Awaited<ReturnType<InterventionHandler['beforeModelCall']>>;

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
 * Composes the retry guard and deterministic project hooks around permission.
 *
 * One intervention is intentional: After callbacks run in reverse handler order,
 * and the SDK emits AfterToolCall even when Before denied a call. Only calls that
 * passed the retry guard, Pre hooks and permission are eligible for Post hooks or
 * repeated-failure observation.
 */
export class ToolHookGate extends InterventionHandler {
  readonly name = 'darwin:tool-hooks';
  private readonly eligible = new WeakMap<object, Set<string>>();

  constructor(
    private readonly projectRoot: string,
    private readonly hooks: ToolHooksConfig,
    private readonly permissionGate: PermissionGate,
    private readonly retryGuard = new RepeatedFailureGuard(),
    private readonly codexHooks?: CodexHookRunner,
    private readonly policyLayers?: readonly ToolHookPolicyLayer[],
    private readonly toolForName?: (name: string) => Tool | undefined,
  ) {
    super();
  }

  override beforeInvocation(event: BeforeInvocationEvent): InvocationAction {
    return this.retryGuard.beforeInvocation(event);
  }

  override async beforeToolCall(event: BeforeToolCallEvent): Promise<BeforeAction> {
    // Enforced planning is stricter than ordinary Pre -> permission ordering: a
    // blocked call must not cause even a policy hook shell to execute. The full
    // gate still runs after Pre for every call this narrow guard does not deny.
    const guarded = this.permissionGate.planGuard(event.toolUse.name, event.toolUse.input);
    if (guarded !== undefined) return guarded;

    const repeated = await this.retryGuard.beforeToolCall(event);
    if (repeated.type !== 'proceed') return repeated;

    if (this.policyLayers === undefined) {
      const portable = await this.codexHooks?.preToolUse({
        toolName: event.toolUse.name,
        toolUseId: event.toolUse.toolUseId,
        toolInput: event.toolUse.input,
        signal: event.agent.cancelSignal,
      });
      if (portable !== undefined) {
        if (!portable.allowed) return InterventionActions.deny(portable.reason ?? 'Blocked by PreToolUse hook.');
        if (portable.input !== event.toolUse.input) {
          if (this.toolForName === undefined) return InterventionActions.deny(`PreToolUse updatedInput for ${event.toolUse.name} could not be validated.`);
          const invalid = validatePortableToolInput(
            event.toolUse.name,
            portable.input,
            event.tool ?? this.toolForName(event.toolUse.name),
          );
          if (invalid !== undefined) return InterventionActions.deny(invalid);
        }
        event.toolUse.input = portable.input as typeof event.toolUse.input;
      }
      const denied = await this.runNativePre(this.hooks.PreToolUse, event);
      if (denied !== undefined) return denied;
    } else {
      for (const layer of this.policyLayers) {
        if (layer.dialect === 'codex') {
          const portable = await this.codexHooks?.preToolUse({
            toolName: event.toolUse.name,
            toolUseId: event.toolUse.toolUseId,
            toolInput: event.toolUse.input,
            signal: event.agent.cancelSignal,
          }, layer.hooks.PreToolUse);
          if (portable !== undefined) {
            if (!portable.allowed) return InterventionActions.deny(portable.reason ?? 'Blocked by PreToolUse hook.');
            if (portable.input !== event.toolUse.input) {
              if (this.toolForName === undefined) return InterventionActions.deny(`PreToolUse updatedInput for ${event.toolUse.name} could not be validated.`);
              const invalid = validatePortableToolInput(
                event.toolUse.name,
                portable.input,
                event.tool ?? this.toolForName(event.toolUse.name),
              );
              if (invalid !== undefined) return InterventionActions.deny(invalid);
            }
            event.toolUse.input = portable.input as typeof event.toolUse.input;
          }
        } else {
          const denied = await this.runNativePre(layer.hooks.PreToolUse, event);
          if (denied !== undefined) return denied;
        }
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

    if (this.policyLayers === undefined) {
      await this.runPortablePost(event);
      await this.runNativePost(this.hooks.PostToolUse, event);
    } else {
      for (const layer of [...this.policyLayers].reverse()) {
        if (layer.dialect === 'codex') {
          await this.runPortablePost(event, layer.hooks.PostToolUse);
        } else {
          await this.runNativePost(layer.hooks.PostToolUse, event);
        }
      }
    }
    return this.retryGuard.afterToolCall(event);
  }

  override beforeModelCall(event: BeforeModelCallEvent): ModelAction {
    return this.retryGuard.beforeModelCall(event);
  }

  private async runNativePre(
    groups: readonly ToolHookGroup[] | undefined,
    event: BeforeToolCallEvent,
  ): Promise<BeforeAction | undefined> {
    for (const hook of matchingCommands(groups, event.toolUse.name)) {
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
    return undefined;
  }

  private async runPortablePost(
    event: AfterToolCallEvent,
    groups?: readonly CodexHookGroup[],
  ): Promise<void> {
    await this.codexHooks?.postToolUse({
      toolName: event.toolUse.name,
      toolUseId: event.toolUse.toolUseId,
      toolInput: event.toolUse.input,
      toolResponse: event.result.toJSON(),
    }, groups);
  }

  private async runNativePost(
    groups: readonly ToolHookGroup[] | undefined,
    event: AfterToolCallEvent,
  ): Promise<void> {
    for (const hook of matchingCommands(groups, event.toolUse.name)) {
      if (event.agent.cancelSignal.aborted) break;
      await runToolHookCommand(
        this.projectRoot,
        hook.command,
        event.toolUse.name,
        event.toolUse.input,
        event.agent.cancelSignal,
      );
    }
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

/**
 * The SDK validates Zod-backed tools only when their callback starts, after the
 * permission gate. A portable rewrite therefore needs a narrow host-side check
 * before permission or an invalid replacement could be classified/approved as a
 * different operation and fail only after authorization. Function/MCP schemas do
 * not expose a reusable validator, so retain the documented object guarantee there;
 * the aliased Darwin tools get their exact public-shape checks here.
 */
function validatePortableToolInput(toolName: string, input: unknown, selectedTool: Tool | undefined): string | undefined {
  const value = recordInput(input);
  if (value === undefined) return `PreToolUse updatedInput for ${toolName} must be an object.`;
  if (selectedTool === undefined) return `PreToolUse updatedInput for unknown tool ${toolName} could not be validated.`;
  const actualName = selectedTool.name;
  if (actualName === 'bash') {
    if (value['mode'] !== 'execute' || typeof value['command'] !== 'string') {
      return 'PreToolUse updatedInput for bash must contain mode "execute" and a string command.';
    }
    if (value['timeout'] !== undefined && (typeof value['timeout'] !== 'number' || !Number.isFinite(value['timeout']) || value['timeout'] <= 0)) {
      return 'PreToolUse updatedInput for bash has an invalid timeout.';
    }
    if (hasKeysOutside(value, ['mode', 'command', 'timeout'])) return 'PreToolUse updatedInput for bash has unsupported fields.';
  } else if (actualName === 'fileEditor') {
    const command = value['command'];
    if (!['create', 'str_replace', 'insert'].includes(typeof command === 'string' ? command : '') || typeof value['path'] !== 'string') {
      return 'PreToolUse updatedInput for fileEditor must be a mutating command with a string path.';
    }
    if (hasKeysOutside(value, ['command', 'path', 'file_text', 'old_str', 'new_str', 'insert_line'])) {
      return 'PreToolUse updatedInput for fileEditor has unsupported fields.';
    }
    if (command === 'create' && typeof value['file_text'] !== 'string') return 'PreToolUse updatedInput for fileEditor create requires file_text.';
    if (command === 'str_replace' && (typeof value['old_str'] !== 'string' || typeof value['new_str'] !== 'string')) {
      return 'PreToolUse updatedInput for fileEditor str_replace requires old_str and new_str.';
    }
    if (command === 'insert' && (typeof value['new_str'] !== 'string' || !Number.isInteger(value['insert_line']))) {
      return 'PreToolUse updatedInput for fileEditor insert requires new_str and an integer insert_line.';
    }
  }
  // The remaining local/MCP function tools accept replacement argument objects;
  // their SDK-owned callback/schema validation still runs on the final input.
  return undefined;
}

function recordInput(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasKeysOutside(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).some((key) => !allowed.includes(key));
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

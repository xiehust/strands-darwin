/** Session-owned background processes exposed through the existing bash tool. */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { tool, type InvokableTool, type ToolContext } from '@strands-agents/sdk';
import { bash as sdkBash, createBash } from '@strands-agents/sdk/vended-tools/bash';
import type { BashInput, BashOutput } from '@strands-agents/sdk/vended-tools/bash';
import { z } from 'zod';

import { sessionPaths } from '../agent/session.js';
import {
  OUTPUT_SENSITIVE_WAIT_MAX_MS,
  TERMINAL_FOCUSED_WAIT_MAX_MS,
  TERMINAL_WAIT_TIMEOUT_INSTRUCTION,
} from './background-wait-contract.js';

export {
  OUTPUT_SENSITIVE_WAIT_MAX_MS,
  TERMINAL_FOCUSED_WAIT_MAX_MS,
  TERMINAL_WAIT_TIMEOUT_INSTRUCTION,
} from './background-wait-contract.js';

const OUTPUT_LIMIT = 64 * 1024;
const TERM_GRACE_MS = 500;
const KILL_GRACE_MS = 500;
const POLL_MS = 20;

const activeProcessGroups = new Set<number>();
let exitCleanupInstalled = false;

function installExitCleanup(): void {
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  // The SDK bash module owns SIGINT/SIGTERM handlers which call process.exit().
  // The synchronous exit event is consequently the only reliable composition point.
  process.on('exit', () => {
    for (const pid of activeProcessGroups) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // The group already disappeared or the OS refused the last-resort signal.
      }
    }
  });
}

export type BackgroundTaskState = 'running' | 'succeeded' | 'failed' | 'stopped';

export interface BackgroundTaskStatus {
  readonly taskId: string;
  readonly state: BackgroundTaskState;
  readonly command: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly outputPath: string;
  readonly outputBytes: number | null;
}

/** Receives one immutable snapshot when a task first reaches a terminal state. */
export type BackgroundTaskListener = (task: Readonly<BackgroundTaskStatus>) => void | Promise<void>;

export interface BackgroundStartResult {
  taskId: string;
  pid: number;
  outputPath: string;
}

export interface BackgroundOutputResult {
  taskId: string;
  output: string;
  startOffset: number;
  endOffset: number;
  hasMore: boolean;
  outputPath: string;
}

export interface BackgroundWaitResult {
  reason: 'output' | 'changed' | 'terminal' | 'timeout' | 'cancelled' | 'shutdown';
  status: BackgroundTaskStatus;
  output: BackgroundOutputResult;
  /** Present only when an explicit terminal-focused wait times out while still running. */
  instruction?: string;
}

interface ManagedTask {
  readonly id: string;
  readonly command: string;
  readonly pid: number;
  readonly outputPath: string;
  readonly outputDevice: number;
  readonly outputInode: number;
  readonly startedAt: string;
  readonly child: ChildProcess;
  state: BackgroundTaskState;
  finishedAt: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  cursor: number;
  stopRequested: boolean;
  stopPromise?: Promise<BackgroundTaskStatus>;
  serial: Promise<void>;
}

export class BackgroundBashManager {
  private readonly tasks = new Map<string, ManagedTask>();
  private readonly launches = new Set<Promise<unknown>>();
  private readonly listeners = new Set<BackgroundTaskListener>();
  private readonly outputDirectory: string;
  private readonly shutdownController = new AbortController();
  private closing = false;

  constructor(
    private readonly projectRoot: string,
    sessionId: string,
    private readonly openFile: typeof open = open,
  ) {
    this.outputDirectory = path.join(sessionPaths(projectRoot).sessionsDir, sessionId, 'background');
    installExitCleanup();
  }

  start(command: string): Promise<BackgroundStartResult> {
    if (this.closing) return Promise.reject(new Error('Background bash manager is shutting down'));

    // Register the whole launch before its first asynchronous setup completes. shutdown()
    // latches `closing`, waits this set, and only then takes its stop snapshot.
    const launch = this.launch(command);
    this.launches.add(launch);
    void launch.then(
      () => this.launches.delete(launch),
      () => this.launches.delete(launch),
    );
    return launch;
  }

  async status(taskId: string): Promise<BackgroundTaskStatus> {
    const task = this.lookup(taskId);
    return this.serialize(task, () => this.snapshot(task));
  }

  /** Snapshots every current-runtime task in deterministic launch order. */
  async list(): Promise<BackgroundTaskStatus[]> {
    return Promise.all([...this.tasks.values()].map((task) =>
      this.serialize(task, () => this.snapshot(task)),
    ));
  }

  /** Subscribes to future terminal transitions; completed tasks are not replayed. */
  subscribe(listener: BackgroundTaskListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async output(taskId: string): Promise<BackgroundOutputResult> {
    const task = this.lookup(taskId);
    return this.serialize(task, () => this.readOutput(task));
  }

  async wait(
    taskId: string,
    waitMs: number,
    signal?: AbortSignal,
    wakeOnOutput = true,
  ): Promise<BackgroundWaitResult> {
    const task = this.lookup(taskId);
    const maxWaitMs = wakeOnOutput ? OUTPUT_SENSITIVE_WAIT_MAX_MS : TERMINAL_FOCUSED_WAIT_MAX_MS;
    if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > maxWaitMs) {
      const focus = wakeOnOutput ? 'output-sensitive' : 'terminal-focused';
      throw new Error(`Background bash ${focus} waitMs must be an integer from 1 to ${maxWaitMs}`);
    }
    if (!wakeOnOutput) return this.waitForTerminal(task, waitMs, signal);

    const deadline = Date.now() + waitMs;
    const initialState = task.state;
    const initialCursor = task.cursor;

    while (true) {
      const { output, status } = await this.serialize(task, async () => ({
        output: await this.readOutput(task),
        status: await this.snapshot(task),
      }));
      if (output.output !== '') return { reason: 'output', status, output };
      if (status.state !== 'running') return { reason: 'terminal', status, output };
      if (task.cursor !== initialCursor || task.state !== initialState) {
        return { reason: 'changed', status, output };
      }
      if (signal?.aborted === true) return { reason: 'cancelled', status, output };
      if (this.closing) return { reason: 'shutdown', status, output };

      const remaining = deadline - Date.now();
      if (remaining <= 0) return { reason: 'timeout', status, output };
      const interrupted = await waitForInterruption(
        Math.min(POLL_MS, remaining),
        signal,
        this.shutdownController.signal,
      );
      if (interrupted === 'cancelled' || interrupted === 'shutdown') {
        const final = await this.serialize(task, async () => ({
          output: await this.readOutput(task),
          status: await this.snapshot(task),
        }));
        if (final.output.output !== '') return { reason: 'output', ...final };
        if (final.status.state !== 'running') return { reason: 'terminal', ...final };
        return { reason: interrupted, ...final };
      }
    }
  }

  private async waitForTerminal(
    task: ManagedTask,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<BackgroundWaitResult> {
    const deadline = Date.now() + waitMs;
    let output: BackgroundOutputResult | undefined;

    while (true) {
      const observed = await this.serialize(task, async () => {
        output = await this.aggregateWaitOutput(task, output);
        return this.snapshot(task);
      });
      if (observed.state !== 'running') return this.finishTerminalWait(task, 'terminal', output);
      if (signal?.aborted === true) return this.finishTerminalWait(task, 'cancelled', output);
      if (this.closing) return this.finishTerminalWait(task, 'shutdown', output);

      const remaining = deadline - Date.now();
      if (remaining <= 0) return this.finishTerminalWait(task, 'timeout', output);
      const interrupted = await waitForInterruption(
        Math.min(POLL_MS, remaining),
        signal,
        this.shutdownController.signal,
      );
      if (interrupted === 'cancelled' || interrupted === 'shutdown') {
        return this.finishTerminalWait(task, interrupted, output);
      }
    }
  }

  private async finishTerminalWait(
    task: ManagedTask,
    reason: 'terminal' | 'timeout' | 'cancelled' | 'shutdown',
    output: BackgroundOutputResult | undefined,
  ): Promise<BackgroundWaitResult> {
    const final = await this.serialize(task, async () => {
      const aggregated = await this.aggregateWaitOutput(task, output);
      return {
        output: aggregated ?? await this.readOutput(task),
        status: await this.snapshot(task),
      };
    });
    const finalReason = final.status.state === 'running' ? reason : 'terminal';
    return {
      reason: finalReason,
      ...final,
      ...(finalReason === 'timeout'
        ? { instruction: TERMINAL_WAIT_TIMEOUT_INSTRUCTION }
        : {}),
    };
  }

  private async aggregateWaitOutput(
    task: ManagedTask,
    output: BackgroundOutputResult | undefined,
  ): Promise<BackgroundOutputResult | undefined> {
    const consumed = output === undefined ? 0 : output.endOffset - output.startOffset;
    // Once another cursor consumer takes a range, this wait's eventual output can
    // no longer be extended contiguously. Keep the retained prefix and leave all
    // later bytes to the shared cursor instead of misrepresenting its offsets.
    if (output !== undefined && (task.cursor !== output.endOffset || consumed >= OUTPUT_LIMIT)) {
      return { ...output, hasMore: await this.hasUnreadOutput(task) };
    }

    const next = await this.readOutput(task, OUTPUT_LIMIT - consumed);
    if (next.output === '') {
      return output === undefined ? undefined : { ...output, hasMore: next.hasMore };
    }
    if (output === undefined) return next;
    return {
      ...output,
      output: output.output + next.output,
      endOffset: next.endOffset,
      hasMore: next.hasMore,
    };
  }

  private async hasUnreadOutput(task: ManagedTask): Promise<boolean> {
    const handle = await this.openOwnedLog(task);
    try {
      return (await handle.stat()).size > task.cursor;
    } finally {
      await handle.close();
    }
  }

  stop(taskId: string): Promise<BackgroundTaskStatus> {
    const task = this.lookup(taskId);
    if (task.state !== 'running') return this.status(taskId);
    if (task.stopPromise !== undefined) return task.stopPromise;

    // Set precedence before entering the queue: a close callback already performing
    // natural cleanup must still settle as stopped when this call races it.
    task.stopRequested = true;
    const stopping = this.serialize(task, async () => {
      if (task.state === 'running') {
        const cleaned = await cleanupProcessGroup(task.pid);
        if (cleaned) await this.finish(task, 'stopped');
      }
      return this.snapshot(task);
    });
    task.stopPromise = stopping;
    return stopping;
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    this.shutdownController.abort();
    await Promise.allSettled([...this.launches]);
    const running = [...this.tasks.values()].filter((task) => task.state === 'running');
    await Promise.allSettled(running.map((task) => this.stop(task.id)));
  }

  private async launch(command: string): Promise<BackgroundStartResult> {
    const id = `bg-${randomUUID()}`;
    await mkdir(this.outputDirectory, { recursive: true });

    const outputPath = path.join(this.outputDirectory, `${id}.log`);
    const handle = await this.openFile(outputPath, 'wx', 0o600);
    let outputIdentity: Awaited<ReturnType<FileHandle['stat']>>;
    try {
      outputIdentity = await handle.stat();
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    let child: ChildProcess | undefined;
    let closed!: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    try {
      // The latch is checked immediately before spawn. A shutdown racing directory/file
      // setup either prevents spawn here or waits for this launch and then sees the task.
      if (this.closing) throw new Error('Background bash manager is shutting down');

      child = spawn('/bin/bash', ['-lc', command], {
        cwd: this.projectRoot,
        env: process.env,
        detached: true,
        stdio: ['ignore', handle.fd, handle.fd],
      });
      // Register as soon as Node exposes the pid, before yielding to the event
      // loop for the spawn confirmation. A signal-triggered process.exit() in
      // that narrow window must still kill the new group.
      if (child.pid !== undefined) activeProcessGroups.add(child.pid);

      closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child?.once('close', (code, signal) => resolve({ code, signal }));
      });
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          // Keep the one-shot error listener after spawn as well: ChildProcess may
          // still emit an asynchronous error, and an unhandled event would crash.
          resolve();
        };
        const onError = (error: Error) => {
          child?.off('spawn', onSpawn);
          reject(error);
        };
        child?.once('spawn', onSpawn);
        child?.once('error', onError);
      });
    } catch (error) {
      if (child?.pid !== undefined) await cleanupProcessGroup(child.pid);
      await handle.close().catch(() => undefined);
      throw error;
    }

    // The child inherited the descriptor; close only the parent's copy. A close
    // failure after spawn is treated as launch failure so no untracked process
    // escapes into runtime shutdown.
    try {
      await handle.close();
    } catch (error) {
      if (child.pid !== undefined) await cleanupProcessGroup(child.pid);
      throw error;
    }

    const pid = child.pid;
    if (pid === undefined) throw new Error('Background bash spawned without a process id');

    const task: ManagedTask = {
      id,
      command,
      pid,
      outputPath,
      outputDevice: outputIdentity.dev,
      outputInode: outputIdentity.ino,
      startedAt: new Date().toISOString(),
      child,
      state: 'running',
      finishedAt: null,
      exitCode: null,
      signal: null,
      cursor: 0,
      stopRequested: false,
      serial: Promise.resolve(),
    };
    this.tasks.set(id, task);

    void closed.then(({ code, signal }) => {
      task.exitCode = code;
      task.signal = signal;
      return this.serialize(task, async () => {
        if (task.state !== 'running') return;
        // A shell leader can exit while descendants retain its process group. Do not
        // report terminal completion until that entire ownership boundary is gone.
        const cleaned = await cleanupProcessGroup(task.pid);
        if (cleaned) {
          const state = task.stopRequested ? 'stopped' : code === 0 ? 'succeeded' : 'failed';
          await this.finish(task, state);
        }
      });
    }).catch(() => undefined);

    return { taskId: id, pid, outputPath };
  }

  private async finish(
    task: ManagedTask,
    state: Exclude<BackgroundTaskState, 'running'>,
  ): Promise<void> {
    if (task.state !== 'running') return;
    task.state = state;
    task.finishedAt = new Date().toISOString();
    // Notification delivery must survive diagnostic-file failures. snapshot()
    // already degrades open/stat problems to outputBytes:null; keep close errors in
    // that same domain instead of turning a completed task into a missing event.
    let snapshot: Readonly<BackgroundTaskStatus>;
    try {
      snapshot = Object.freeze(await this.snapshot(task));
    } catch {
      snapshot = Object.freeze(this.taskMetadata(task, null));
    }
    for (const listener of [...this.listeners]) {
      try {
        Promise.resolve(listener(snapshot)).catch(() => undefined);
      } catch {
        // Observers cannot fail process cleanup or suppress other listeners.
      }
    }
  }

  private lookup(taskId: string): ManagedTask {
    if (!/^bg-[0-9a-f-]{36}$/.test(taskId)) {
      throw new Error(`Invalid background bash task id: ${JSON.stringify(taskId)}`);
    }
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new Error(`Unknown background bash task: ${taskId}`);
    return task;
  }

  private serialize<T>(task: ManagedTask, operation: () => Promise<T> | T): Promise<T> {
    const result = task.serial.then(operation, operation);
    task.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async snapshot(task: ManagedTask): Promise<BackgroundTaskStatus> {
    let outputBytes: number | null = null;
    let handle: FileHandle | undefined;
    try {
      handle = await this.openOwnedLog(task);
      outputBytes = (await handle.stat()).size;
    } catch {
      // Process metadata remains useful when a retained log was externally removed.
    } finally {
      try {
        await handle?.close();
      } catch {
        outputBytes = null;
      }
    }
    return this.taskMetadata(task, outputBytes);
  }

  private taskMetadata(task: ManagedTask, outputBytes: number | null): BackgroundTaskStatus {
    return {
      taskId: task.id,
      state: task.state,
      command: task.command,
      pid: task.pid,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      exitCode: task.exitCode,
      signal: task.signal,
      outputPath: task.outputPath,
      outputBytes,
    };
  }

  private async readOutput(task: ManagedTask, limit = OUTPUT_LIMIT): Promise<BackgroundOutputResult> {
    let handle: FileHandle | undefined;
    let size: number;
    try {
      handle = await this.openOwnedLog(task);
      size = (await handle.stat()).size;
    } catch (error) {
      await handle?.close();
      throw new Error(`Cannot read background task log ${task.outputPath}: ${errorMessage(error)}`);
    }

    const startOffset = task.cursor;
    const available = Math.max(0, size - startOffset);
    if (available === 0) {
      await handle.close();
      return { taskId: task.id, output: '', startOffset, endOffset: startOffset, hasMore: false, outputPath: task.outputPath };
    }

    const bytesToRead = Math.min(available, limit + 3);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    let bytesRead: number;
    try {
      ({ bytesRead } = await handle.read(buffer, 0, bytesToRead, startOffset));
    } catch (error) {
      throw new Error(`Cannot read background task log ${task.outputPath}: ${errorMessage(error)}`);
    } finally {
      await handle.close();
    }

    const data = buffer.subarray(0, bytesRead);
    const terminalEof = task.state !== 'running' && startOffset + bytesRead >= size;
    const consumed = completeUtf8Boundary(data, Math.min(limit, bytesRead), terminalEof);
    const output = data.subarray(0, consumed).toString('utf8');
    task.cursor += consumed;
    return {
      taskId: task.id,
      output,
      startOffset,
      endOffset: task.cursor,
      hasMore: size > task.cursor,
      outputPath: task.outputPath,
    };
  }

  private async openOwnedLog(task: ManagedTask): Promise<FileHandle> {
    const handle = await this.openFile(task.outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.dev !== task.outputDevice || metadata.ino !== task.outputInode) {
        throw new Error('the task log was replaced');
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
}



function completeUtf8Boundary(data: Buffer, boundary: number, terminalEof: boolean): number {
  if (boundary === 0 || (terminalEof && boundary === data.length)) return boundary;

  let lead = boundary - 1;
  while (lead >= Math.max(0, boundary - 3) && (data[lead]! & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return boundary;

  const first = data[lead]!;
  const expected = first < 0x80 ? 1 : first >= 0xc2 && first <= 0xdf ? 2 : first <= 0xef ? 3 : first <= 0xf4 ? 4 : 1;
  const present = boundary - lead;
  if (expected <= present) return boundary;

  const needed = expected - present;
  if (boundary + needed <= data.length) {
    for (let index = boundary; index < boundary + needed; index += 1) {
      if ((data[index]! & 0xc0) !== 0x80) return boundary;
    }
    return boundary + needed;
  }
  // A growing file may currently end in half a code point. Keep those bytes for
  // the next poll; at terminal EOF malformed bytes are decoded with replacement.
  return terminalEof ? boundary : lead;
}

async function cleanupProcessGroup(pid: number): Promise<boolean> {
  if (!groupExists(pid)) {
    activeProcessGroups.delete(pid);
    return true;
  }
  signalGroup(pid, 'SIGTERM');
  if (await waitForGroupExit(pid, TERM_GRACE_MS)) return true;
  signalGroup(pid, 'SIGKILL');
  return waitForGroupExit(pid, KILL_GRACE_MS);
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isNoSuchProcess(error)) return;
  }
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
}

async function waitForGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (groupExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  const gone = !groupExists(pid);
  if (gone) activeProcessGroups.delete(pid);
  return gone;
}

async function waitForInterruption(
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  shutdownSignal: AbortSignal,
): Promise<'elapsed' | 'cancelled' | 'shutdown'> {
  if (callerSignal?.aborted === true) return 'cancelled';
  if (shutdownSignal.aborted) return 'shutdown';

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: 'elapsed' | 'cancelled' | 'shutdown') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCancelled);
      shutdownSignal.removeEventListener('abort', onShutdown);
      resolve(result);
    };
    const onCancelled = () => finish('cancelled');
    const onShutdown = () => finish('shutdown');
    const timer = setTimeout(() => finish('elapsed'), timeoutMs);
    callerSignal?.addEventListener('abort', onCancelled, { once: true });
    shutdownSignal.addEventListener('abort', onShutdown, { once: true });
    if (callerSignal?.aborted === true) finish('cancelled');
    else if (shutdownSignal.aborted) finish('shutdown');
  });
}

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Bedrock requires every tool input schema's top-level JSON `type` to be
// `object`; a Zod union serializes as a top-level `anyOf` and the request is
// rejected before the model can call it. Keep one object and enforce the
// mode-specific shape in refinement instead.
const inputSchema = z.object({
  mode: z.enum(['execute', 'restart', 'start', 'list', 'status', 'output', 'wait', 'stop'])
    .describe('Operation mode — required on every call; execute runs one foreground command in the persistent shell (a bare {command} without mode is rejected)'),
  command: z.string().optional().describe('Command required by execute and start; ignored by status, output, wait, and stop'),
  timeout: z.number().positive().optional().describe('Timeout in seconds for execute mode; ignored by start'),
  taskId: z.string().optional().describe('Session-local task id required by status, output, wait, and stop'),
  waitMs: z.number().int().min(1).max(TERMINAL_FOCUSED_WAIT_MAX_MS).optional()
    .describe(`Bounded wait in milliseconds, required only by wait mode: at most ${OUTPUT_SENSITIVE_WAIT_MAX_MS} by default, or ${TERMINAL_FOCUSED_WAIT_MAX_MS} only with wakeOnOutput:false`),
  wakeOnOutput: z.boolean().optional()
    .describe('Wait mode only: false retains intermediate output and wakes only on terminal state, cancellation, shutdown, or timeout; defaults to true'),
}).strict().superRefine((input, context) => {
  if (input.mode === 'execute' && input.command === undefined) {
    context.addIssue({ code: 'custom', path: ['command'], message: 'command is required in execute mode' });
  }
  if (input.mode === 'start' && (input.command === undefined || input.command.trim() === '')) {
    context.addIssue({ code: 'custom', path: ['command'], message: 'command is required in start mode' });
  }
  if ((input.mode === 'status' || input.mode === 'output' || input.mode === 'wait' || input.mode === 'stop') && !input.taskId) {
    context.addIssue({ code: 'custom', path: ['taskId'], message: `taskId is required in ${input.mode} mode` });
  }
  if (input.mode === 'wait' && input.waitMs === undefined) {
    context.addIssue({ code: 'custom', path: ['waitMs'], message: 'waitMs is required in wait mode' });
  }
  if (input.mode === 'wait' && input.waitMs !== undefined &&
      input.wakeOnOutput !== false && input.waitMs > OUTPUT_SENSITIVE_WAIT_MAX_MS) {
    context.addIssue({
      code: 'custom',
      path: ['waitMs'],
      message: `waitMs above ${OUTPUT_SENSITIVE_WAIT_MAX_MS} requires wakeOnOutput:false`,
    });
  }
  if (input.mode !== 'execute' && input.mode !== 'restart' && input.mode !== 'start' && input.timeout !== undefined) {
    context.addIssue({ code: 'custom', path: ['timeout'], message: `timeout is not accepted in ${input.mode} mode` });
  }
  if (input.mode === 'list' && input.command !== undefined) {
    context.addIssue({ code: 'custom', path: ['command'], message: 'command is not accepted in list mode' });
  }
  if ((input.mode === 'start' || input.mode === 'list') && input.taskId !== undefined) {
    context.addIssue({ code: 'custom', path: ['taskId'], message: `taskId is not accepted in ${input.mode} mode` });
  }
  if (input.mode !== 'wait' && input.waitMs !== undefined) {
    context.addIssue({ code: 'custom', path: ['waitMs'], message: `waitMs is not accepted in ${input.mode} mode` });
  }
  if (input.mode !== 'wait' && input.wakeOnOutput !== undefined) {
    context.addIssue({ code: 'custom', path: ['wakeOnOutput'], message: `wakeOnOutput is not accepted in ${input.mode} mode` });
  }
});

type BackgroundBashInput = z.infer<typeof inputSchema>;
type BackgroundBashOutput = BashOutput | string | BackgroundStartResult | BackgroundTaskStatus | BackgroundTaskStatus[] | BackgroundOutputResult | BackgroundWaitResult;

/** Configures the pinned SDK foreground tool from Darwin's verified project root. */
export function createForegroundBashTool(projectRoot: string): InvokableTool<BashInput, BashOutput | string> {
  return createBash({ cwd: projectRoot, projectRoot });
}

export function createBackgroundBashTool(
  manager: BackgroundBashManager,
  foreground: InvokableTool<BashInput, BashOutput | string> = sdkBash,
): InvokableTool<BackgroundBashInput, BackgroundBashOutput> {
  return tool<typeof inputSchema, BackgroundBashOutput>({
    name: 'bash',
    description:
      'Runs foreground commands in a persistent shell and session-owned background commands. ' +
      'Modes: execute, restart, start, list, status, output, wait, and stop. ' +
      'Never block execute mode with sleep to wait for something slow: start the command in the background, ' +
      'do other work, then use wait with taskId and waitMs. ' +
      `Output-sensitive waits use 1-${OUTPUT_SENSITIVE_WAIT_MAX_MS} ms and return {reason, status, output}; by default they wake on output or another consumer changing the cursor. ` +
      `Set wakeOnOutput:false for a terminal-focused wait up to ${TERMINAL_FOCUSED_WAIT_MAX_MS} ms that aggregates intermediate output and wakes only on terminal state, cancellation, shutdown, or timeout. ` +
      'A still-running terminal-focused timeout tells you to call wait again before ending when later work depends on completion; background completion does not resume the agent. ' +
      'A plain ssh in execute mode waits on a tty and hangs the call: pass -T -o BatchMode=yes and run it as a background task (start, then wait).',
    inputSchema,
    callback: (input, context?: ToolContext) => {
      switch (input.mode) {
        case 'execute':
        case 'restart':
          return foreground.invoke(input as BashInput, context);
        case 'start':
          return manager.start(input.command!);
        case 'list':
          return manager.list();
        case 'status':
          return manager.status(input.taskId!);
        case 'output':
          return manager.output(input.taskId!);
        case 'wait':
          return manager.wait(input.taskId!, input.waitMs!, context?.agent.cancelSignal, input.wakeOnOutput);
        case 'stop':
          return manager.stop(input.taskId!);
      }
    },
  });
}

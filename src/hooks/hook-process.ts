import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export const HOOK_PAYLOAD_MAX_BYTES = 64 * 1024;
// Capture enough for the adapter's 64 KiB per-handler context hard cap plus JSON
// escaping and bounded diagnostics. No hook output is ever spilled to disk.
export const HOOK_OUTPUT_MAX_BYTES = 128 * 1024;
const HOOK_OUTPUT_TOTAL_MAX_BYTES = HOOK_OUTPUT_MAX_BYTES;
const FORCE_KILL_AFTER_MS = 500;

export interface HookProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly error?: Error;
}

interface RunningHook {
  controller: AbortController;
  settled: Promise<HookProcessResult>;
}

export class HookProcessManager {
  private readonly running = new Set<RunningHook>();
  private closed = false;

  constructor(private readonly projectRoot: string) {}

  run(
    command: string,
    commandWindows: string | undefined,
    payload: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<HookProcessResult> {
    if (this.closed) return Promise.resolve(failure(new Error('Hook process manager is closed.')));
    let input: string;
    try {
      input = `${JSON.stringify(payload)}\n`;
    } catch (error) {
      return Promise.resolve(failure(new Error(`Hook input could not be serialized: ${message(error)}`)));
    }
    if (Buffer.byteLength(input, 'utf8') > HOOK_PAYLOAD_MAX_BYTES) {
      return Promise.resolve(failure(new Error(`Hook input exceeds ${HOOK_PAYLOAD_MAX_BYTES} bytes.`)));
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted === true) controller.abort();
    const running = {} as RunningHook;
    running.controller = controller;
    running.settled = this.spawn(command, commandWindows, input, timeoutMs, controller.signal)
      .finally(() => {
        signal?.removeEventListener('abort', onAbort);
        this.running.delete(running);
      });
    this.running.add(running);
    return running.settled;
  }

  cancel(): void {
    for (const running of this.running) running.controller.abort();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancel();
    await Promise.allSettled([...this.running].map((entry) => entry.settled));
  }

  private spawn(
    command: string,
    commandWindows: string | undefined,
    input: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<HookProcessResult> {
    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        const selected = process.platform === 'win32' ? commandWindows ?? command : command;
        child = process.platform === 'win32'
          ? spawn(selected, { cwd: this.projectRoot, env: process.env, stdio: 'pipe', shell: true, windowsHide: true })
          : spawn('/bin/sh', ['-c', selected], {
              cwd: this.projectRoot,
              env: process.env,
              stdio: 'pipe',
              detached: true,
            });
      } catch (error) {
        resolve(failure(error instanceof Error ? error : new Error(String(error))));
        return;
      }

      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let cancelled = false;
      let launchError: Error | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let reapTimer: ReturnType<typeof setTimeout> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let terminating = false;
      let closed = false;
      let settled = false;
      let cleanupDeadline = 0;

      const append = (
        current: Buffer<ArrayBufferLike>,
        other: Buffer<ArrayBufferLike>,
        chunk: Buffer<ArrayBufferLike>,
        mark: () => void,
      ): Buffer<ArrayBufferLike> => {
        const available = HOOK_OUTPUT_TOTAL_MAX_BYTES - current.length - other.length;
        if (available <= 0) { mark(); return current; }
        if (chunk.length > available) mark();
        return Buffer.concat([current, chunk.subarray(0, available)]);
      };
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = append(stdout, stderr, Buffer.from(chunk), () => { stdoutTruncated = true; });
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = append(stderr, stdout, Buffer.from(chunk), () => { stderrTruncated = true; });
      });
      child.stdin.on('error', () => undefined);

      const finish = (exitCode: number | null, closeSignal: NodeJS.Signals | null): void => {
        if (settled) return;
        if ((terminating || launchError !== undefined) && !closed) {
          // An `error` event is not guaranteed to be followed by `close`. Do not
          // let a failed launch or cancellation keep runtime cleanup pending.
          closed = true;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (timeout !== undefined) clearTimeout(timeout);
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (reapTimer !== undefined) clearTimeout(reapTimer);
        resolve({
          exitCode,
          signal: closeSignal,
          stdout: decodeUtf8(stdout),
          stderr: decodeUtf8(stderr),
          stdoutTruncated,
          stderrTruncated,
          timedOut,
          cancelled,
          ...(launchError === undefined ? {} : { error: launchError }),
        });
      };
      child.once('error', (error) => {
        launchError = error;
        // Spawn failures have no process group to reap and may never emit close.
        if (child.pid === undefined) finish(null, null);
      });

      const waitForGroupExit = (pid: number, exitCode: number | null, closeSignal: NodeJS.Signals | null): void => {
        try { process.kill(-pid, 0); }
        catch { finish(exitCode, closeSignal); return; }
        if (Date.now() >= cleanupDeadline) { finish(exitCode, closeSignal); return; }
        reapTimer = setTimeout(() => waitForGroupExit(pid, exitCode, closeSignal), 20);
      };
      const terminate = (): void => {
        if (terminating) return;
        terminating = true;
        cleanupDeadline = Date.now() + FORCE_KILL_AFTER_MS * 4;
        const pid = child.pid;
        try {
          if (pid !== undefined && process.platform !== 'win32') process.kill(-pid, 'SIGTERM');
          else child.kill('SIGTERM');
        } catch { if (closed) finish(null, null); return; }
        killTimer = setTimeout(() => {
          try {
            if (pid !== undefined && process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch { if (closed) finish(null, null); return; }
          if (closed && pid !== undefined && process.platform !== 'win32') waitForGroupExit(pid, null, null);
        }, FORCE_KILL_AFTER_MS);
      };
      const onAbort = (): void => { cancelled = true; terminate(); };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      timeout = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
      timeout.unref?.();

      child.once('close', (exitCode, closeSignal) => {
        closed = true;
        const pid = child.pid;
        if (!terminating || process.platform === 'win32' || pid === undefined) {
          finish(exitCode, closeSignal);
        } else {
          // The shell leader can exit before a descendant that ignored TERM.
          // Keep the KILL timer armed and settle only after the process group is gone.
          if (killTimer === undefined) waitForGroupExit(pid, exitCode, closeSignal);
          else {
            const existing = killTimer;
            killTimer = setTimeout(() => {
              clearTimeout(existing);
              try { process.kill(-pid, 'SIGKILL'); } catch { finish(exitCode, closeSignal); return; }
              waitForGroupExit(pid, exitCode, closeSignal);
            }, FORCE_KILL_AFTER_MS);
              }
        }
      });
      child.stdin.end(input);
    });
  }
}

function decodeUtf8(value: Buffer): string {
  return new StringDecoder('utf8').write(value);
}

function failure(error: Error): HookProcessResult {
  return {
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    cancelled: false,
    error,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

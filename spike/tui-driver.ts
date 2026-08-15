/**
 * Drives the real TUI through a pseudo-terminal.
 *
 * Ink needs a TTY: it puts stdin in raw mode and writes ANSI cursor sequences, so
 * a plain pipe makes it fall back to non-interactive mode and never accept
 * keystrokes. node-pty gives it a real pty.
 *
 * Assertions match against the accumulated output with ANSI escapes stripped.
 * Ink repaints by rewriting lines, so the buffer holds every frame ever drawn —
 * which is what "did this ever appear on screen" wants.
 */
import path from 'node:path';
import process from 'node:process';

import { spawn, type IPty } from 'node-pty';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** Matches CSI/OSC escape sequences so assertions see plain text. */
// eslint-disable-next-line no-control-regex
const ANSI =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI, '');
}

export interface WaitOptions {
  timeoutMs?: number;
  /** Shown in timeout messages. Set automatically by {@link TuiSession.waitFor}. */
  label?: string;
  /**
   * Only match output produced after this mark. Essential for anything that
   * recurs — `you>` is drawn every frame, so an unanchored wait for it is
   * satisfied by a frame from before the action being awaited.
   */
  from?: number;
  /**
   * Require the condition to still hold this many milliseconds later.
   *
   * A frame arrives in several chunks, so the buffer is briefly a half-drawn
   * screen: a busy frame read between its prompt line and its `working…` hint
   * looks exactly like an idle one. Any predicate about "what the newest frame
   * shows" needs to wait for the frame to finish.
   */
  settleMs?: number;
}

export interface TuiSession {
  /** Everything written by the process, including terminal control sequences. */
  readonly raw: string;
  /** Everything drawn so far, ANSI stripped. */
  readonly screen: string;
  /** Current end of the output, to pass as {@link WaitOptions.from}. */
  mark(): number;
  /** Resolves once `pattern` shows up, or rejects on timeout. */
  waitFor(pattern: string | RegExp, options?: WaitOptions): Promise<void>;
  /**
   * Resolves once `predicate` holds for the whole accumulated screen. For
   * conditions a substring cannot express — notably "the newest frame shows an
   * idle prompt", since the prompt text is drawn while busy too.
   */
  waitUntil(predicate: (screen: string) => boolean, options?: WaitOptions): Promise<void>;
  /** Sends literal keystrokes. */
  send(keys: string): void;
  /** Types text and presses Enter. */
  submit(text: string): void;
  /** Sends text plus CRLF in one write, matching terminals with translated Enter. */
  submitCrLf(text: string): void;
  /** Sends text plus CR in one write, forcing Ink's batched-input path. */
  submitChunk(text: string): void;
  /** Resolves with the exit code. */
  exited(): Promise<number>;
  /**
   * Resolves with the exit code, or rejects if the TUI outlives `timeoutMs`.
   *
   * Preferred over {@link exited} in assertions: a process that never exits is a
   * bug in its own right (a leaked handle), and an unbounded wait turns it into a
   * suite that hangs instead of a test that fails.
   */
  exitedWithin(timeoutMs: number): Promise<number>;
  kill(signal?: string): void;
}

export interface TuiOptions {
  cwd: string;
  args?: string[];
  cols?: number;
  rows?: number;
  /** Echo the terminal output as it arrives. Defaults to false (very noisy). */
  echo?: boolean;
}

export function startTui(options: TuiOptions): TuiSession {
  const child: IPty = spawn(
    path.join(REPO_ROOT, 'node_modules/.bin/tsx'),
    [path.join(REPO_ROOT, 'src/cli.ts'), ...(options.args ?? [])],
    {
      name: 'xterm-256color',
      // Roomy enough that the permission box and tool output are not truncated.
      cols: options.cols ?? 120,
      rows: options.rows ?? 50,
      cwd: options.cwd,
      env: process.env as Record<string, string>,
    },
  );

  let raw = '';
  const watchers = new Set<() => void>();
  let exitCode: number | undefined;
  const exitWaiters = new Set<(code: number) => void>();

  child.onData((chunk) => {
    raw += chunk;
    if (options.echo === true) process.stdout.write(chunk);
    for (const notify of [...watchers]) notify();
  });

  child.onExit(({ exitCode: code }) => {
    exitCode = code;
    for (const resolve of [...exitWaiters]) resolve(code);
    for (const notify of [...watchers]) notify();
  });

  const session: TuiSession = {
    get raw() {
      return raw;
    },

    get screen() {
      return stripAnsi(raw);
    },

    mark() {
      return session.screen.length;
    },

    waitFor(pattern, options = {}) {
      const from = options.from ?? 0;
      return session.waitUntil(
        (screen) => {
          const region = screen.slice(from);
          return typeof pattern === 'string' ? region.includes(pattern) : pattern.test(region);
        },
        { ...options, label: String(pattern) },
      );
    },

    waitUntil(predicate, options = {}) {
      const timeoutMs = options.timeoutMs ?? 120_000;
      const settleMs = options.settleMs ?? 0;
      const label = (options as WaitOptions & { label?: string }).label ?? 'condition';
      const matches = (): boolean => predicate(session.screen);

      // Only safe without a settle window: otherwise this could accept a frame
      // that is still being written.
      if (settleMs === 0 && matches()) return Promise.resolve();

      return new Promise<void>((resolve, reject) => {
        let settleTimer: ReturnType<typeof setTimeout> | undefined;

        const timer = setTimeout(() => {
          cleanup();
          reject(
            new Error(
              `timed out after ${timeoutMs}ms waiting for ${label}.\n` +
                `--- screen ---\n${session.screen.slice(-3000)}`,
            ),
          );
        }, timeoutMs);

        const check = (): void => {
          if (matches()) {
            if (settleMs === 0) {
              cleanup();
              resolve();
              return;
            }
            // Re-check once the frame has had time to finish. More output in the
            // meantime just re-runs this, so a transient match never wins.
            settleTimer ??= setTimeout(() => {
              settleTimer = undefined;
              if (matches()) {
                cleanup();
                resolve();
              }
            }, settleMs);
            return;
          }

          if (settleTimer !== undefined) {
            clearTimeout(settleTimer);
            settleTimer = undefined;
          }
          if (exitCode !== undefined) {
            cleanup();
            reject(
              new Error(
                `TUI exited (code ${exitCode}) before ${label} was met.\n` +
                  `--- screen ---\n${session.screen.slice(-3000)}`,
              ),
            );
          }
        };

        function cleanup(): void {
          clearTimeout(timer);
          if (settleTimer !== undefined) clearTimeout(settleTimer);
          watchers.delete(check);
        }

        watchers.add(check);
        check();
      });
    },

    send(keys) {
      child.write(keys);
    },

    submit(text) {
      child.write(`${text}\r`);
    },

    submitCrLf(text) {
      child.write(`${text}\r\n`);
    },

    submitChunk(text) {
      child.write(`${text}\r`);
    },

    exited() {
      if (exitCode !== undefined) return Promise.resolve(exitCode);
      return new Promise<number>((resolve) => exitWaiters.add(resolve));
    },

    exitedWithin(timeoutMs) {
      if (exitCode !== undefined) return Promise.resolve(exitCode);
      return new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          exitWaiters.delete(onExit);
          reject(
            new Error(
              `TUI did not exit within ${timeoutMs}ms.\n--- screen ---\n${session.screen.slice(-2000)}`,
            ),
          );
        }, timeoutMs);

        function onExit(code: number): void {
          clearTimeout(timer);
          resolve(code);
        }

        exitWaiters.add(onExit);
      });
    },

    kill(signal = 'SIGHUP') {
      if (exitCode === undefined) child.kill(signal);
    },
  };

  return session;
}

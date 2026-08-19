/**
 * The `!` prefix: a user-typed shell command run directly, without the model.
 *
 * Policy (SER-024, PRD `08-19-bang-shell-command`): a `!` command is
 * *user-authorized* — it never enters the permission gate, whose subject is model
 * tool calls; the user typing `!rm -rf build` is the user acting directly, exactly
 * as they could in the terminal next door. What the gate never saw must still be
 * visible and durable, so the command and its bounded output go to the transcript,
 * to the trajectory record (`shellCommand`), and — held until the user's next
 * prompt — into the conversation.
 *
 * Execution is a **bounded one-shot spawn**, deliberately not the runtime's
 * persistent shell: that shell is serialized, so a hung `!` command would block
 * the model's next `bash` call, and killing it would destroy shell state the model
 * relies on. A one-shot owns its process group (`detached: true`), which makes
 * TERM→KILL reaping self-contained — the same convention `background-bash.ts`
 * uses. Stated tradeoff: `!cd` and `!export` persist nowhere.
 *
 * Output is collected head-first with the total counted, and projected **once**
 * with the SER-009 vocabulary (`boundText`, `… truncated N code points` marker).
 * That single projection is what the transcript shows, what the model will read,
 * and what the record stores — three surfaces, one text.
 */
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import {
  boundText,
  truncationMarker,
} from './tool-detail-presentation.js';

/**
 * The pseudo-tool name `!` runs under in the tool panel, finished rows and replay.
 * Not a registered SDK tool: nothing the model can call carries this name through
 * `classify()`, it exists only in presentation and in the trajectory record.
 */
export const SHELL_TOOL_NAME = 'shell';

/**
 * Hard wall-clock cap on one `!` command. A hung command must not wedge the TUI:
 * on expiry the process group gets SIGTERM, then SIGKILL after
 * {@link SHELL_KILL_GRACE_MS}, and the result reports `timedOut`.
 */
export const SHELL_TIMEOUT_MS = 120_000;

/** Grace between the group's SIGTERM and the SIGKILL that follows it. */
export const SHELL_KILL_GRACE_MS = 2_000;

/**
 * The one bounded projection's caps. Deliberately below the trajectory writer's
 * own `MAX_FIELD_CHARS` (8000), so the record's field cap never re-truncates what
 * this module already bounded — the marker written is the marker read back.
 */
export const SHELL_REPORT_CODE_POINTS = 4_000;
export const SHELL_REPORT_LINES = 80;

/**
 * Code points of output kept in memory while a command runs. Far above the
 * projection caps on purpose: only the head is ever shown or recorded, so
 * everything past this is *counted* (points and lines), never stored — a
 * `yes`-style firehose costs arithmetic, not memory.
 */
export const SHELL_STORE_CODE_POINTS = 32_000;

/** The live panel's tail window: last lines, last code points. */
export const SHELL_LIVE_TAIL_LINES = 8;
export const SHELL_LIVE_TAIL_POINTS = 1_000;

/** Minimum interval between live-output emits, so a chatty pipe cannot spam renders. */
const LIVE_EMIT_INTERVAL_MS = 100;

/**
 * Recognizes a `!` draft. Only at the start of the (trimmed) draft — `!` anywhere
 * else is ordinary text — and returns the command with the prefix stripped.
 * A bare `!` returns `''`; the caller answers that with a notice, not an error.
 */
export function parseShellCommand(draft: string): string | undefined {
  const text = draft.trim();
  if (!text.startsWith('!')) return undefined;
  return text.slice(1).trim();
}

/** What was collected: the stored head plus honest counts of what was not. */
export interface ShellOutputCapture {
  /** Head of the merged stdout+stderr stream, capped at {@link SHELL_STORE_CODE_POINTS}. */
  text: string;
  /** Code points emitted beyond the stored head. */
  droppedPoints: number;
  /** Newlines emitted beyond the stored head. */
  droppedLines: number;
}

export interface ShellCommandResult {
  /** Process exit code; `null` when it died to a signal or never spawned. */
  exitCode: number | null;
  /** Signal that ended it, `null` for a plain exit. */
  signal: string | null;
  /** True when {@link SHELL_TIMEOUT_MS} (or the caller's override) expired. */
  timedOut: boolean;
  durationMs: number;
  output: ShellOutputCapture;
  /** Set when the process could not be spawned at all; `output.text` repeats it. */
  spawnError?: string;
}

export interface RunningShellCommand {
  done: Promise<ShellCommandResult>;
  /** TERM the group now, KILL after the grace. Idempotent; `done` still settles. */
  kill: () => void;
}

/**
 * Runs one user command through `/bin/bash -c` in its own process group.
 *
 * stdout and stderr are merged in arrival order (each through its own UTF-8
 * decoder, so a multi-byte character split across chunks survives). `onOutput`
 * receives the {@link liveShellTail} projection, throttled to one emit per
 * {@link LIVE_EMIT_INTERVAL_MS} with a final flush — never awaited, never able
 * to throw into the collection path.
 */
export function runShellCommand(
  command: string,
  options: {
    cwd: string;
    timeoutMs?: number;
    onOutput?: (tail: string) => void;
  },
): RunningShellCommand {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? SHELL_TIMEOUT_MS;
  const capture: ShellOutputCapture = { text: '', droppedPoints: 0, droppedLines: 0 };
  let storedPoints = 0;
  let timedOut = false;
  let killGrace: NodeJS.Timeout | undefined;
  let emitTimer: NodeJS.Timeout | undefined;
  let emitDirty = false;

  const emit = (): void => {
    if (options.onOutput === undefined) return;
    try {
      options.onOutput(liveShellTail(capture.text));
    } catch {
      // A renderer problem must not become a collection problem.
    }
  };

  const scheduleEmit = (): void => {
    if (options.onOutput === undefined) return;
    if (emitTimer !== undefined) {
      emitDirty = true;
      return;
    }
    emit();
    emitTimer = setTimeout(() => {
      emitTimer = undefined;
      if (emitDirty) {
        emitDirty = false;
        scheduleEmit();
      }
    }, LIVE_EMIT_INTERVAL_MS);
  };

  const collect = (piece: string): void => {
    if (piece === '') return;
    if (storedPoints < SHELL_STORE_CODE_POINTS) {
      const points = [...piece];
      const room = SHELL_STORE_CODE_POINTS - storedPoints;
      if (points.length <= room) {
        capture.text += piece;
        storedPoints += points.length;
      } else {
        const kept = points.slice(0, room).join('');
        capture.text += kept;
        storedPoints += room;
        const rest = points.slice(room);
        capture.droppedPoints += rest.length;
        capture.droppedLines += rest.filter((point) => point === '\n').length;
      }
    } else {
      const points = [...piece];
      capture.droppedPoints += points.length;
      capture.droppedLines += points.filter((point) => point === '\n').length;
    }
    scheduleEmit();
  };

  let child: ReturnType<typeof spawn> | undefined;

  const signalGroup = (signal: NodeJS.Signals): void => {
    const pid = child?.pid;
    if (pid === undefined) return;
    try {
      // Negative pid: the whole group, so a `!make` cannot orphan its children.
      process.kill(-pid, signal);
    } catch {
      // Already gone — the close handler settles the result.
    }
  };

  const kill = (): void => {
    if (killGrace !== undefined) return;
    signalGroup('SIGTERM');
    killGrace = setTimeout(() => signalGroup('SIGKILL'), SHELL_KILL_GRACE_MS);
    killGrace.unref?.();
  };

  const done = new Promise<ShellCommandResult>((resolve) => {
    const settle = (result: Omit<ShellCommandResult, 'durationMs' | 'output'>): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (killGrace !== undefined) clearTimeout(killGrace);
      if (emitTimer !== undefined) clearTimeout(emitTimer);
      emitTimer = undefined;
      // One last emit so the panel's final frame shows the final tail.
      emit();
      resolve({ ...result, durationMs: Date.now() - startedAt, output: capture });
    };

    let timeout: NodeJS.Timeout | undefined;

    try {
      child = spawn('/bin/bash', ['-c', command], {
        cwd: options.cwd,
        env: process.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      collect(`spawn failed: ${message}`);
      settle({ exitCode: null, signal: null, timedOut: false, spawnError: message });
      return;
    }

    timeout = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    timeout.unref?.();

    const decodeInto = (stream: NodeJS.ReadableStream | null): void => {
      if (stream === null) return;
      const decoder = new StringDecoder('utf8');
      stream.on('data', (chunk: Buffer) => collect(decoder.write(chunk)));
      stream.on('end', () => collect(decoder.end()));
      stream.on('error', () => {
        // A broken pipe ends collection; the close handler still settles.
      });
    };
    decodeInto(child.stdout);
    decodeInto(child.stderr);

    child.once('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      collect(`spawn failed: ${message}`);
      settle({ exitCode: null, signal: null, timedOut, spawnError: message });
    });
    child.once('close', (code, signal) => {
      settle({ exitCode: code, signal, timedOut });
    });
  });

  return { done, kill };
}

/**
 * The one bounded projection (PRD D4): head kept, loss stated with the same
 * truncation marker every tool preview uses. When collection itself dropped
 * output, those counts are folded into the marker so it never understates.
 */
export function projectShellOutput(capture: ShellOutputCapture): string {
  const bounded = boundText(capture.text, 'ok', {
    codePoints: SHELL_REPORT_CODE_POINTS,
    lines: SHELL_REPORT_LINES,
  });
  if (capture.droppedPoints === 0) return bounded.join('\n');

  // `boundText('ok')` appends its marker as the last line whenever it truncated;
  // dropped output guarantees it did (the store cap is far above the projection
  // caps). Recompute the marker over the true totals.
  const truncated = bounded.join('\n') !== capture.text;
  const kept = truncated ? bounded.slice(0, -1) : bounded;
  const keptText = kept.join('\n');
  const omittedPoints = Math.max(0, [...capture.text].length - [...keptText].length) + capture.droppedPoints;
  const omittedLines =
    Math.max(0, capture.text.split('\n').length - kept.length) + capture.droppedLines;
  return [...kept, truncationMarker(omittedPoints, omittedLines)].join('\n');
}

/**
 * The live panel's tail: the last {@link SHELL_LIVE_TAIL_LINES} lines within
 * {@link SHELL_LIVE_TAIL_POINTS} code points. A moving window, not a claim of
 * completeness, so it carries no marker — the finished row and the record do.
 */
export function liveShellTail(text: string): string {
  const lines = text.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const joined = lines.slice(-SHELL_LIVE_TAIL_LINES).join('\n');
  const points = [...joined];
  return points.length <= SHELL_LIVE_TAIL_POINTS
    ? joined
    : points.slice(-SHELL_LIVE_TAIL_POINTS).join('');
}

/** Everything the finished row, the report and the record agree on. */
export interface ShellOutcome {
  command: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
}

/** `ok` only for a plain, in-time exit 0; a kill or timeout is a failure to state. */
export function shellOutcomeStatus(outcome: ShellOutcome): 'ok' | 'error' {
  return !outcome.timedOut && outcome.signal === null && outcome.exitCode === 0 ? 'ok' : 'error';
}

/** How the outcome reads, everywhere it is stated. */
export function shellOutcomeSuffix(outcome: ShellOutcome): string {
  if (outcome.timedOut) return `(timed out after ${formatShellDuration(outcome.durationMs)})`;
  if (outcome.signal !== null) {
    return `(killed by ${outcome.signal} after ${formatShellDuration(outcome.durationMs)})`;
  }
  if (outcome.exitCode === null) return '(did not start)';
  return `(exit ${outcome.exitCode} in ${formatShellDuration(outcome.durationMs)})`;
}

/**
 * The finished row's summary — also what replay prints, so it is composed from
 * recorded fields only. Multi-line commands flatten to one line; the row is one
 * truncate-end `<Text>` and the full command is in the user row above it.
 */
export function shellOutcomeSummary(outcome: ShellOutcome): string {
  return `$ ${outcome.command.replace(/\s*\n\s*/g, ' ')} ${shellOutcomeSuffix(outcome)}`;
}

/**
 * The report held for the user's next prompt (PRD D5). Prepended to that prompt's
 * text and sent through the ordinary `send()` path, so the trajectory `userInput`
 * contract — "exactly what was handed to `agent.stream()`" — stays true without a
 * special case. `output` is the already-bounded projection, never raw output.
 */
export function composeShellReport(outcome: ShellOutcome, output: string): string {
  return [
    '<user-shell-command>',
    `$ ${outcome.command}`,
    shellOutcomeSuffix(outcome),
    ...(output === '' ? ['(no output)'] : output.split('\n')),
    '</user-shell-command>',
  ].join('\n');
}

/**
 * Duration for outcome suffixes. Sub-second commands — most `!` commands — keep
 * their milliseconds; from one second up this matches `formatTaskDuration`'s
 * whole-second reading. Recorded `durationMs` in, the same string out on live and
 * replay alike.
 */
function formatShellDuration(milliseconds: number): string {
  const clamped = Math.max(0, milliseconds);
  if (clamped < 1000) return `${clamped}ms`;
  const seconds = Math.floor(clamped / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

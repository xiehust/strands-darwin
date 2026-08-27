/**
 * The opt-in per-session diagnostics log.
 *
 * Two channels darwin otherwise throws away meet in one file: the SDK's `debug`
 * and `info` output — which is the *only* place the SDK says it was throttled
 * (`models/bedrock.js`: `logger.debug('throttled | error_message=…')`), where it
 * put its cache points, or that native token counting fell back to estimation —
 * and darwin's own notices, which live in Ink's scrollback and die with the frame.
 * `warn`/`error` are written here too even though they already reach the renderer,
 * so one file holds the whole story rather than half of it.
 *
 * Off unless asked for: unlike default-on context offload, these lines
 * interpolate provider payloads and can therefore carry conversation-derived
 * material. With the feature off nothing here runs at all — `sdk-logging.ts`
 * installs literal no-ops and `AgentRuntime` builds no log — so a default run is
 * byte-for-byte the run it was before this module existed.
 *
 * It is an observer, under the same discipline the trajectory earned
 * (`.trellis/spec/backend/session-trajectory.md` §6), and one bound stricter:
 *
 * 1. **It cannot affect a turn.** {@link DiagnosticsLog.write} is synchronous,
 *    catches everything, performs no I/O and never touches the console — the SDK's
 *    default `console.warn` tearing the Ink frame is why `sdk-logging.ts` exists at
 *    all. Appends run on a promise chain no caller awaits.
 * 2. **It is bounded twice.** Per line and per file, like the record — and also per
 *    *pending* byte, which the record did not need: `logger.debug` is called
 *    synchronously from inside the SDK's own stream loop, so a long turn can offer
 *    lines faster than a disk accepts them. Diagnostic lines are then dropped and
 *    counted; a stream event never is.
 * 3. **Every stop is written down.** Reaching a bound, dropping lines and failing to
 *    write all leave a line in the file (or a surfaced problem when the file is what
 *    failed). A log that went quiet without saying so would be worse than none.
 *
 * See `.trellis/spec/backend/session-diagnostics.md`.
 */
import { open, mkdir, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

/**
 * Per line, in **code points** — the `headlessField` convention, so a multi-byte
 * message cannot be cut mid-sequence. Matches the trajectory's field cap: a
 * provider that echoes a whole rejected request back is the reason both exist.
 */
export const MAX_DIAGNOSTIC_LINE_CHARS = 8_000;

/**
 * Per session file, in bytes.
 *
 * Deliberately an eighth of the trajectory's 64 MiB, and the difference is the
 * point: a trajectory is the artifact you *keep*, so its bound has to leave a long
 * session's history intact. This is scratch for one debugging session, nothing ever
 * garbage-collects it (see `contextOffload` in `src/config.ts`), and 8 MiB is on the
 * order of 80,000 lines — far past the point where a human tailing a file is still
 * reading it. Whoever needs more than this needs a different tool, not a bigger file.
 */
export const MAX_DIAGNOSTICS_BYTES = 8 * 1024 * 1024;

/**
 * Formatted-but-unwritten bytes held in memory, before arriving lines are dropped.
 *
 * The bound the trajectory does not have. It buffers one turn and flushes at the
 * end, so its memory is bounded by a turn; this one accepts lines from inside the
 * SDK's stream loop and flushes continuously, so a `debug` firehose against a slow
 * disk is a real unbounded-growth path. Dropping is the correct failure here:
 * blocking would delay the event the SDK was in the middle of, which the observer
 * contract forbids outright.
 */
export const MAX_DIAGNOSTICS_PENDING_BYTES = 1024 * 1024;

/** Who produced the line. `sdk` is the SDK's own logger; `darwin` is this codebase. */
export type DiagnosticSource = 'sdk' | 'darwin';

/**
 * How loud the line is. The SDK's four logger levels, which are a superset of the
 * TUI's `NoticeSeverity` — so a notice's severity travels here unchanged.
 */
export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DiagnosticEntry {
  source: DiagnosticSource;
  level: DiagnosticLevel;
  message: string;
}

/** What the TUI notice and the headless record report about this log. */
export interface DiagnosticsStatus {
  file: string;
  /** Lines appended by this process. */
  linesThisRun: number;
  /** Bytes appended by this process. */
  bytesThisRun: number;
  /** Lines dropped because the writer could not keep up. */
  droppedLines: number;
  /** Set once, on the first failure or when the budget stops logging. */
  problem: string | undefined;
  /** False once a problem or the budget has stopped it. */
  active: boolean;
}

export interface DiagnosticsOptions {
  file: string;
  /** Written into the self-describing first line. */
  run: DiagnosticsRunInfo;
  /** Injected for tests that need a failing filesystem; production uses `fs.open`. */
  openFile?: typeof open;
  /**
   * Per-file byte budget; defaults to {@link MAX_DIAGNOSTICS_BYTES}.
   *
   * Injectable for the same reason the recorder's is: the budget path latches logging
   * off for the rest of a session, and a behaviour that only appears after 8 MiB of
   * real writes is a behaviour nothing tests.
   */
  maxBytes?: number;
  /** Pending-byte budget; defaults to {@link MAX_DIAGNOSTICS_PENDING_BYTES}. */
  maxPendingBytes?: number;
}

/** The facts the first line states, so the file explains itself without a reader. */
export interface DiagnosticsRunInfo {
  session: string;
  darwinVersion: string;
  provider: string;
  model: string;
}

/** Fixed-width columns: aligned for a human, still splittable for a script. */
const SOURCE_WIDTH = 6;
const LEVEL_WIDTH = 5;

/**
 * One line: `<ISO timestamp> <source> <level> — <message>`.
 *
 * Text rather than JSONL, unlike the trajectory, because the reader is a person with
 * `tail -f` rather than a replay engine — and because these lines are already text
 * the SDK formatted, so wrapping each one in an object would add punctuation and no
 * structure. The parts stay unambiguous anyway: three fixed leading fields, then
 * ` — ` (the `sdk warn — …` delimiter headless already uses) and the message.
 *
 * The message is collapsed to a single line, so one event is always exactly one line
 * — a multi-line notice (`/usage`'s table, say) must not be able to break a reader
 * that counts lines, and a `tail -f` that shows half an event is worse than one that
 * shows a long one.
 */
export function formatDiagnosticLine(at: string, entry: DiagnosticEntry): string {
  const message = capLine(entry.message.replace(/\s+/gu, ' ').trim());
  return `${at} ${entry.source.padEnd(SOURCE_WIDTH)} ${entry.level.padEnd(LEVEL_WIDTH)} — ${message}\n`;
}

/**
 * Caps in code points and *says* it did, because the alternative is a reader quoting
 * a truncated provider message as if it were the whole one. The count is the original
 * length, so the size of what is missing is knowable.
 */
function capLine(message: string): string {
  const points = [...message];
  if (points.length <= MAX_DIAGNOSTIC_LINE_CHARS) return message;
  const kept = points.slice(0, MAX_DIAGNOSTIC_LINE_CHARS).join('');
  return `${kept}… (truncated, ${points.length} code points)`;
}

export class DiagnosticsLog {
  private readonly file: string;
  private readonly openFile: typeof open;
  private readonly maxBytes: number;
  private readonly maxPendingBytes: number;

  /** Formatted-but-unwritten lines, in observation order. */
  private pending: string[] = [];
  private pendingBytes = 0;
  /** True while an append is in flight; see {@link flush}. */
  private writing = false;
  /** The serialized append chain: every write waits for the previous one. */
  private chain: Promise<void> = Promise.resolve();

  private active = true;
  private problem: string | undefined;
  private linesThisRun = 0;
  private bytesThisRun = 0;
  private fileBytes = 0;
  private opened = false;
  /** Dropped since the last line that reported drops, and in total. */
  private droppedSinceReport = 0;
  private droppedLines = 0;

  constructor(options: DiagnosticsOptions) {
    this.file = options.file;
    this.openFile = options.openFile ?? open;
    this.maxBytes = options.maxBytes ?? MAX_DIAGNOSTICS_BYTES;
    this.maxPendingBytes = options.maxPendingBytes ?? MAX_DIAGNOSTICS_PENDING_BYTES;
    // The header is buffered, not written: no file exists until the first flush, so a
    // session that logs nothing else still leaves nothing behind — the same lazy rule
    // the recorder and the resume pointer follow. It names the budget so the stop
    // marker at the end of a full file is not the first mention of a bound.
    this.write({
      source: 'darwin',
      level: 'info',
      message:
        `diagnostics started · session ${options.run.session} · darwin ${options.run.darwinVersion} · ` +
        `${options.run.provider}/${options.run.model} · pid ${process.pid} · budget ${this.maxBytes} bytes`,
    });
  }

  /** Where the lines go. Reported so a caller can tell the user without guessing. */
  get path(): string {
    return this.file;
  }

  get status(): DiagnosticsStatus {
    return {
      file: this.file,
      linesThisRun: this.linesThisRun,
      bytesThisRun: this.bytesThisRun,
      droppedLines: this.droppedLines,
      problem: this.problem,
      active: this.active,
    };
  }

  /**
   * Records one line. Synchronous, no I/O, and it swallows its own failures.
   *
   * This is the whole observer contract in one method: it is called from inside the
   * SDK's stream loop and from the TUI's dispatch path, so it may not await, may not
   * throw, and may not write to the console. Everything it does is format a string,
   * push it, and register a continuation on the append chain.
   */
  write(entry: DiagnosticEntry): void {
    if (!this.active) return;
    try {
      const line = formatDiagnosticLine(new Date().toISOString(), entry);
      const bytes = Buffer.byteLength(line, 'utf8');
      // Full queue: drop this line rather than grow without bound or make the caller
      // wait. Counted, and reported in the file by the next successful flush — a
      // silent gap would leave a reader believing nothing happened in it.
      if (this.pendingBytes + bytes > this.maxPendingBytes) {
        this.droppedSinceReport += 1;
        this.droppedLines += 1;
        return;
      }
      this.pending.push(line);
      this.pendingBytes += bytes;
      this.flush();
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * A sink for `routeSdkLogs`' verbose tap, bound once.
   *
   * Bound here rather than built at each call site so the two entry points cannot
   * disagree about the `source` label, and so a caller never has to re-create a
   * closure to satisfy narrowing on an optional log.
   */
  readonly sdkSink = (entry: { level: DiagnosticLevel; message: string }): void => {
    this.write({ source: 'sdk', ...entry });
  };

  /** A darwin-side line: what the TUI showed the user, with the severity it showed. */
  readonly notice = (text: string, level: DiagnosticLevel = 'info'): void => {
    this.write({ source: 'darwin', level, message: text });
  };

  /**
   * Appends everything buffered so far — but only when the previous append has
   * finished.
   *
   * The wait is the whole point, and it is where this differs from the trajectory's
   * writer: that one flushes once per turn, so it can hand every batch straight to the
   * chain. Lines here arrive continuously from inside the SDK's stream loop, and
   * draining on every arrival would queue an unbounded number of batches — moving the
   * unbounded growth from one array into a promise chain rather than removing it. By
   * leaving lines in `pending` while a write is in flight, the pending-byte bound in
   * {@link write} is the real bound on memory.
   *
   * Returns nothing on purpose: no caller on the streaming path may await this.
   * `close()` is the one place the chain is awaited.
   */
  private flush(): void {
    if (this.writing || this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    this.writing = true;
    this.chain = this.chain
      .then(() => this.append(batch))
      .catch((error: unknown) => {
        this.fail(error);
      })
      .finally(() => {
        this.writing = false;
        // Whatever arrived while that write was in flight goes out now, so a burst
        // costs one append per disk round-trip rather than one per line.
        this.flush();
      });
  }

  /** Flushes and waits, so a session's last lines are durable before the process exits. */
  async close(): Promise<void> {
    this.flush();
    // Two rounds are possible: the awaited chain may schedule a follow-up flush for
    // lines that arrived during it, and `await` on the *current* chain would not cover
    // the one that replaced it. Looping until nothing is left is what makes the last
    // line of a session actually reach the disk.
    while (this.pending.length > 0 || this.writing) {
      await this.chain;
      this.flush();
    }
    await this.chain;
    // Latched shut, like the permission queue's `close()`: a line offered after this
    // would be buffered onto a chain nobody awaits any more, so it might or might not
    // reach the disk before the process exits. Refusing it makes the file's end mean
    // one thing — everything up to the session's shutdown — instead of being a race.
    // `problem` stays unset, which is how a reader tells a closed log from a broken one.
    this.active = false;
  }

  /** Latches the first failure and stops logging; never rethrows. */
  private fail(error: unknown): void {
    if (this.problem !== undefined) return;
    this.problem = `${this.file}: ${error instanceof Error ? error.message : String(error)}`;
    this.active = false;
    this.pending = [];
    this.pendingBytes = 0;
  }

  private async append(batch: string[]): Promise<void> {
    if (this.problem !== undefined) return;

    const prefix = await this.prepare();
    // Reported before the batch it belongs to rather than after: the lines that were
    // dropped happened *before* these arrived, so a reader scanning downwards meets
    // the gap where the gap was.
    const dropped = this.takeDroppedReport();
    const queued = dropped === '' ? batch : [dropped, ...batch];

    // Trimmed to the budget rather than written and then regretted. One append can
    // carry a whole burst, so checking the total only afterwards would let the file
    // overshoot by the entire pending bound — a bound that can be exceeded by a
    // megabyte is not the bound it claims to be. What does not fit is not written, and
    // the marker below says so.
    const room = this.maxBytes - this.fileBytes - Buffer.byteLength(prefix, 'utf8');
    const fitting: string[] = [];
    let used = 0;
    for (const line of queued) {
      const size = Buffer.byteLength(line, 'utf8');
      if (used + size > room) break;
      fitting.push(line);
      used += size;
    }
    const full = fitting.length < queued.length;
    const payload = `${prefix}${fitting.join('')}`;

    let handle: FileHandle | undefined;
    try {
      handle = await this.openFile(this.file, 'a');
      if (payload !== '') {
        await handle.write(payload, null, 'utf8');
        const written = Buffer.byteLength(payload, 'utf8');
        this.linesThisRun += fitting.length;
        this.bytesThisRun += written;
        this.fileBytes += written;
      }

      if (full || this.fileBytes >= this.maxBytes) await this.stopForBudget(handle);
    } finally {
      await handle?.close().catch(() => {
        // A failed close has already had its write succeed or fail on its own.
      });
    }
  }

  /** One line naming the drops since the last report, or nothing to report. */
  private takeDroppedReport(): string {
    if (this.droppedSinceReport === 0) return '';
    const count = this.droppedSinceReport;
    this.droppedSinceReport = 0;
    return formatDiagnosticLine(new Date().toISOString(), {
      source: 'darwin',
      level: 'warn',
      message: `${count} line(s) dropped: the writer could not keep up`,
    });
  }

  /**
   * One-time setup for the first append of this process: creates the directory and
   * measures what is already there, so the budget covers the whole session rather
   * than only this run. Returns a newline guard when a previous run left a partial
   * line, for the same reason the recorder does — an interrupted write stays one
   * broken line instead of being glued onto the next good one. Nothing here modifies
   * existing bytes.
   */
  private async prepare(): Promise<string> {
    if (this.opened) return '';
    this.opened = true;
    await mkdir(path.dirname(this.file), { recursive: true });

    try {
      const info = await stat(this.file);
      this.fileBytes = info.size;
      if (info.size === 0) return '';
      return (await this.endsWithNewline(info.size)) ? '' : '\n';
    } catch {
      // No file yet, the common case. A real permission problem surfaces on the
      // append that follows, where it becomes the latched problem.
      this.fileBytes = 0;
      return '';
    }
  }

  private async endsWithNewline(size: number): Promise<boolean> {
    let handle: FileHandle | undefined;
    try {
      handle = await this.openFile(this.file, 'r');
      const buffer = Buffer.alloc(1);
      await handle.read(buffer, 0, 1, size - 1);
      return buffer.toString('utf8') === '\n';
    } catch {
      // Unreadable: assume a guard is needed. A spurious blank line costs a reader
      // nothing, while a missing one corrupts the line that follows.
      return false;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  /** Appends the final line and latches logging off for this session. */
  private async stopForBudget(handle: FileHandle): Promise<void> {
    const line = formatDiagnosticLine(new Date().toISOString(), {
      source: 'darwin',
      level: 'warn',
      message:
        `diagnostics stopped: reached the ${this.maxBytes}-byte per-session budget ` +
        '(nothing after this line was written)',
    });
    await handle.write(line, null, 'utf8');
    this.linesThisRun += 1;
    this.bytesThisRun += Buffer.byteLength(line, 'utf8');
    this.active = false;
    this.problem =
      `diagnostics stopped: ${this.file} reached its ${this.maxBytes}-byte budget ` +
      '(the log is complete up to that point)';
  }
}

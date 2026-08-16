/**
 * The append-only writer.
 *
 * Three properties are load-bearing and easy to lose:
 *
 * 1. **It cannot affect a turn.** `record()` is synchronous, catches everything,
 *    and performs no I/O; a turn's records are formatted as events arrive and
 *    flushed as one append when the turn ends. No await ever enters the streaming
 *    path, and no failure can reach the caller of `AgentRuntime.send`.
 * 2. **It only ever appends.** Bytes already on disk are never rewritten,
 *    truncated or reordered. The one thing it reads is the tail, once, to continue
 *    the sequence numbering; and if the file does not end in a newline it prefixes
 *    one, so an interrupted write stays a single broken line instead of being glued
 *    onto the next valid record.
 * 3. **It is bounded.** Payload caps live in `record.ts`; this file owns the
 *    per-file budget and stops recording when it is reached.
 *
 * See `.trellis/spec/backend/session-trajectory.md`.
 */
import { open, mkdir, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import type { AgentStreamEvent } from '@strands-agents/sdk';

import {
  MAX_FIELD_CHARS,
  MAX_FILE_BYTES,
  SCHEMA_VERSION,
  capField,
  encodeRecord,
  isRecordedEventType,
  parseRecordLine,
  projectEvent,
  type TrajectoryRecord,
  type Truncation,
} from './record.js';

/** How much of the tail is read to recover the last sequence number. */
const TAIL_READ_BYTES = 64 * 1024;

/**
 * Everything about a record except the file-scoped fields the writer assigns.
 *
 * Distributed over the union on purpose: a plain `Omit` over a union collapses to
 * the envelope's shared keys, which would silently accept a `userInput` record
 * carrying a `stopReason`.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type PendingRecord = DistributiveOmit<TrajectoryRecord, 'v' | 'seq' | 't'>;

/** A buffered record plus the moment it was observed, which is not the moment it is written. */
interface BufferedRecord {
  record: PendingRecord;
  /** Stamped in `buffer()`: a batch is appended at once, but its events did not happen at once. */
  at: string;
}

export interface RecorderRunInfo {
  session: string;
  agentId: string;
  darwinVersion: string;
  provider: string;
  model: string;
  permissionMode: string;
  thinkingEffort: string | undefined;
  resumed: boolean;
  restoredMessages: number;
}

export interface RecorderOptions {
  file: string;
  /** Written into the `runStarted` record this process appends first. */
  run: RecorderRunInfo;
  /** Injected for tests that need a failing filesystem; production uses `fs.open`. */
  openFile?: typeof open;
  /**
   * Per-file byte budget; defaults to {@link MAX_FILE_BYTES}.
   *
   * Injectable for the same reason `openFile` is: the budget path latches recording
   * off for the rest of a session, and a behaviour that only appears after 64 MiB of
   * real writes is a behaviour nothing tests.
   */
  maxBytes?: number;
}

/** What `/trajectory` and the headless diagnostic report about this run. */
export interface TrajectoryStatus {
  file: string;
  /** Records appended by this process. */
  recordsThisRun: number;
  /** Truncations recorded by this process. */
  truncationsThisRun: number;
  /** Bytes appended by this process. */
  bytesThisRun: number;
  /** Set once, on the first failure or when the budget stops recording. */
  problem: string | undefined;
  /** False once a problem or the budget has stopped it. */
  active: boolean;
}

/**
 * One turn's buffer. Records accumulate here during the stream and are appended in
 * one write at the end, so nothing between two events touches the disk.
 */
export class TurnRecording {
  private readonly recorded = new Map<string, number>();
  private readonly dropped = new Map<string, number>();
  private readonly startedAt = Date.now();
  private partialText = '';
  private stopReason: string | undefined;
  private ended = false;

  constructor(
    private readonly recorder: TrajectoryRecorder,
    readonly turn: number,
    input: string,
  ) {
    const { value, trunc } = capField(input, 'text');
    this.recorder.buffer({ turn, type: 'userInput', text: value }, trunc);
  }

  /**
   * Observes one stream event. Synchronous, and swallows its own failures on
   * purpose: an observer that could throw here would become a second way for a
   * turn to die, which is the whole thing this design exists to prevent.
   */
  record(event: AgentStreamEvent): void {
    if (this.ended) return;
    try {
      this.tally(event);
      if (!isRecordedEventType(event.type)) return;
      const { data, trunc } = projectEvent(event);
      this.recorder.buffer({ turn: this.turn, type: event.type, data }, trunc);
    } catch (error) {
      this.recorder.fail(error);
    }
  }

  /** Closes the turn and schedules the append. Never awaited by the stream. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    try {
      const { value, trunc } = capField(this.partialText.trim(), 'partialText');
      this.recorder.buffer(
        {
          turn: this.turn,
          type: 'turnEnded',
          stopReason: this.stopReason,
          ms: Date.now() - this.startedAt,
          recorded: Object.fromEntries(this.recorded),
          dropped: Object.fromEntries(this.dropped),
          ...(value === '' ? {} : { partialText: value }),
        },
        trunc,
      );
    } catch (error) {
      this.recorder.fail(error);
    }
    this.recorder.flush();
  }

  /**
   * Tallies the event and keeps the two things the allowlist would otherwise lose:
   * the stop reason, and unassembled assistant text.
   *
   * Text deltas are counted and dropped like any other `modelStreamUpdateEvent`,
   * but their text is accumulated here so a cancelled turn's unfinished answer
   * still lands in `turnEnded.partialText` — the same text `flushLiveText` puts
   * into live history. An assembled `contentBlockEvent` clears it, because that
   * block is recorded in full and is authoritative.
   */
  private tally(event: AgentStreamEvent): void {
    const bucket = isRecordedEventType(event.type) ? this.recorded : this.dropped;
    bucket.set(event.type, (bucket.get(event.type) ?? 0) + 1);

    if (event.type === 'modelStreamUpdateEvent') {
      const inner = event.event;
      if (inner.type === 'modelContentBlockDeltaEvent' && inner.delta.type === 'textDelta') {
        // Stop growing well before the field cap would cut it: an observer must not
        // hold an unbounded copy of a long answer in memory either.
        if (this.partialText.length < 4 * MAX_FIELD_CHARS) this.partialText += inner.delta.text;
      }
      return;
    }
    if (event.type === 'contentBlockEvent' && event.contentBlock.type === 'textBlock') {
      this.partialText = '';
      return;
    }
    if (event.type === 'agentResultEvent') {
      this.stopReason = event.result.stopReason;
    }
  }
}

export class TrajectoryRecorder {
  private readonly file: string;
  private readonly openFile: typeof open;
  private readonly run: RecorderRunInfo;
  private readonly maxBytes: number;
  /**
   * When this process started recording.
   *
   * Used for the `runStarted` record rather than the moment of the first flush: the
   * header is written ahead of the first turn's records, so stamping it later would
   * put a timestamp from *after* those events on the line that precedes them.
   */
  private readonly startedAt = new Date().toISOString();

  /** Buffered-but-unwritten records, in observation order. */
  private pending: BufferedRecord[] = [];
  /** The serialized append chain: every write waits for the previous one. */
  private chain: Promise<void> = Promise.resolve();

  /** Next sequence number to assign; recovered from the file's tail on first append. */
  private seq = 0;
  private turns = 0;
  private opened = false;
  private headerPending = true;
  private active = true;
  private problem: string | undefined;
  private recordsThisRun = 0;
  private truncationsThisRun = 0;
  private bytesThisRun = 0;
  private fileBytes = 0;

  constructor(options: RecorderOptions) {
    this.file = options.file;
    this.run = options.run;
    this.openFile = options.openFile ?? open;
    this.maxBytes = options.maxBytes ?? MAX_FILE_BYTES;
  }

  /** Opens a turn. Returns `undefined` once recording has stopped. */
  beginTurn(input: string): TurnRecording | undefined {
    if (!this.active) return undefined;
    this.turns += 1;
    return new TurnRecording(this, this.turns, input);
  }

  get status(): TrajectoryStatus {
    return {
      file: this.file,
      recordsThisRun: this.recordsThisRun,
      truncationsThisRun: this.truncationsThisRun,
      bytesThisRun: this.bytesThisRun,
      problem: this.problem,
      active: this.active,
    };
  }

  /**
   * Buffers one record, stamping the time it was observed.
   *
   * The timestamp is taken here and the sequence number at append time, and both
   * choices are deliberate. A whole turn is appended in one write, so stamping at
   * write time would give every event in a turn the same instant — a record that
   * looks like it carries timing but does not. The sequence number cannot be
   * assigned here, because the file's starting number is only known once its tail
   * has been read, and that read must not happen on the streaming path. Array order
   * is observation order, so the file's order is the order events happened.
   */
  buffer(record: PendingRecord, trunc: readonly Truncation[] = []): void {
    if (!this.active) return;
    this.truncationsThisRun += trunc.length;
    this.pending.push({
      record: trunc.length === 0 ? record : { ...record, trunc: [...trunc] },
      at: new Date().toISOString(),
    });
  }

  /** Latches the first failure and stops recording; never rethrows. */
  fail(error: unknown): void {
    if (this.problem !== undefined) return;
    this.problem = error instanceof Error ? error.message : String(error);
    this.active = false;
    this.pending = [];
  }

  /**
   * Appends everything buffered so far, chained behind any previous append.
   *
   * Returns nothing on purpose: callers on the streaming path must not be able to
   * await this. `close()` is the one place the chain is awaited.
   */
  flush(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.chain = this.chain
      .then(() => this.append(batch))
      .catch((error: unknown) => {
        this.fail(error);
      });
  }

  /** Flushes and waits, so a turn's records are durable before the process exits. */
  async close(): Promise<void> {
    this.flush();
    await this.chain;
  }

  private async append(batch: BufferedRecord[]): Promise<void> {
    if (this.problem !== undefined) return;

    const prefix = await this.prepare();
    const lines = [...this.header(), ...batch].map((buffered) => this.encode(buffered));
    const payload = `${prefix}${lines.join('')}`;

    let handle: FileHandle | undefined;
    try {
      handle = await this.openFile(this.file, 'a');
      await handle.write(payload, null, 'utf8');
      const written = Buffer.byteLength(payload, 'utf8');
      this.recordsThisRun += lines.length;
      this.bytesThisRun += written;
      this.fileBytes += written;

      if (this.fileBytes >= this.maxBytes) await this.stopForBudget(handle);
    } finally {
      await handle?.close().catch(() => {
        // A failed close has already had its write succeed or fail on its own.
      });
    }
  }

  private encode(buffered: BufferedRecord): string {
    const line = encodeRecord({
      v: SCHEMA_VERSION,
      seq: this.seq,
      t: buffered.at,
      ...buffered.record,
    } as TrajectoryRecord);
    this.seq += 1;
    return line;
  }

  /** The `runStarted` record, emitted exactly once, ahead of this process's first batch. */
  private header(): BufferedRecord[] {
    if (!this.headerPending) return [];
    this.headerPending = false;
    return [
      {
        record: { turn: 0, type: 'runStarted', ...this.run, pid: process.pid } as PendingRecord,
        at: this.startedAt,
      },
    ];
  }

  /**
   * One-time setup for the first append of this process: creates the directory,
   * recovers the sequence number, and decides whether a newline guard is needed.
   * Returns the newline to prefix, if any. Nothing here modifies existing bytes.
   */
  private async prepare(): Promise<string> {
    if (this.opened) return '';
    this.opened = true;
    await mkdir(path.dirname(this.file), { recursive: true });

    const tail = await this.readTail();
    this.fileBytes = tail.bytes;
    this.seq = tail.nextSeq;
    return tail.needsNewline ? '\n' : '';
  }

  /**
   * Reads at most the last {@link TAIL_READ_BYTES} to find the last complete
   * record's sequence number, so numbering continues across runs and a gap really
   * does mean loss. A tail holding no complete record restarts at zero: inventing a
   * number would be worse than a visible restart.
   */
  private async readTail(): Promise<{ nextSeq: number; bytes: number; needsNewline: boolean }> {
    let handle: FileHandle | undefined;
    try {
      const info = await stat(this.file);
      if (info.size === 0) return { nextSeq: 0, bytes: 0, needsNewline: false };

      handle = await this.openFile(this.file, 'r');
      const length = Math.min(TAIL_READ_BYTES, info.size);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, info.size - length);
      const text = buffer.toString('utf8');
      const needsNewline = !text.endsWith('\n');

      let nextSeq = 0;
      const lines = text.split('\n');
      // Skip a trailing partial line, then walk back to the last parseable record.
      for (let index = needsNewline ? lines.length - 2 : lines.length - 1; index >= 0; index -= 1) {
        const record = parseRecordLine(lines[index] ?? '');
        if (record !== undefined) {
          nextSeq = record.seq + 1;
          break;
        }
      }
      return { nextSeq, bytes: info.size, needsNewline };
    } catch {
      // No file yet (the common case) or an unreadable one: start a fresh sequence.
      // A real permission problem surfaces on the append that follows.
      return { nextSeq: 0, bytes: 0, needsNewline: false };
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  /** Appends the final record and latches recording off for this session. */
  private async stopForBudget(handle: FileHandle): Promise<void> {
    const line = this.encode({
      record: {
        turn: this.turns,
        type: 'recordingStopped',
        reason: 'budget',
        detail: `reached the ${this.maxBytes}-byte per-session budget`,
      } as PendingRecord,
      at: new Date().toISOString(),
    });
    await handle.write(line, null, 'utf8');
    this.recordsThisRun += 1;
    this.active = false;
    this.problem =
      `recording stopped: ${this.file} reached its ${this.maxBytes}-byte budget ` +
      '(the record is complete up to this point)';
  }
}

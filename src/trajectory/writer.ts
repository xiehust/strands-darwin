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
 * See `docs/architecture/load-bearing-decisions.md` § Session trajectory.
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
  failureFromError,
  isRecordedEventType,
  parseRecordLine,
  projectEvent,
  type CallSpendProjector,
  type TrajectoryRecord,
  type Truncation,
  type TurnFailure,
  type TurnSpend,
  type TurnSpendMeter,
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

export const INPUT_DURABILITY_TIMEOUT_MS = 2000;

export type TurnSettlement =
  | {
      readonly durable: true;
      readonly session: string;
      readonly turn: number;
      readonly seq: number;
      readonly at: string;
      readonly stopReason: string | undefined;
      readonly failure: boolean;
      readonly partial: boolean;
    }
  | { readonly durable: false; readonly turn: number; readonly reason: string };

export interface RecorderOptions {
  file: string;
  /** Written into the `runStarted` record this process appends first. */
  run: RecorderRunInfo;
  /** Injected for tests that need a failing filesystem; production uses `fs.open`. */
  openFile?: typeof open;
  /** Injectable so the bounded timeout path can be proved without a slow suite. */
  inputDurabilityTimeoutMs?: number;
  /**
   * Per-file byte budget; defaults to {@link MAX_FILE_BYTES}.
   *
   * Injectable for the same reason `openFile` is: the budget path latches recording
   * off for the rest of a session, and a behaviour that only appears after 64 MiB of
   * real writes is a behaviour nothing tests.
   */
  maxBytes?: number;
  /** Detached observer runs exactly once after the closing append settles. */
  onTurnSettled?: (settlement: TurnSettlement) => void;
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
 * One turn's observer. The opening `userInput` is appended before invocation; later
 * records accumulate during the stream and append together at the end, so nothing
 * between two events touches the disk.
 */
export class TurnRecording {
  private readonly recorded = new Map<string, number>();
  private readonly dropped = new Map<string, number>();
  private readonly startedAt = Date.now();
  private partialText = '';
  private stopReason: string | undefined;
  private failure: TurnFailure | undefined;
  private ended = false;
  /** The agent loop's latest request-size estimate this turn; absent until reported. */
  private lastProjectedInputTokens: number | undefined;

  constructor(
    private readonly recorder: TrajectoryRecorder,
    readonly turn: number,
    input: string,
    /**
     * Reads the turn's spend when the turn closes. Undefined when nothing is metering —
     * which the record says by omitting the field, never by writing zeros.
     */
    private readonly spend?: TurnSpendMeter,
    /**
     * Projects one completed call's own counters for its `modelCall` record.
     * Undefined when nothing is projecting, and the records then simply carry no
     * `spend` — the call lines still exist, priced unknown rather than zero.
     */
    private readonly callSpend?: CallSpendProjector,
  ) {
    const { value, trunc } = capField(input, 'text');
    this.recorder.buffer({ turn, type: 'userInput', text: value }, trunc);
  }

  /**
   * Makes the already-observed input readable before the Agent can invoke anything.
   * This is the only recorder operation the runtime awaits; it is bounded and
   * resolves after recorder failure so observation can never kill the turn.
   */
  inputDurable(): Promise<void> {
    return this.recorder.inputDurable();
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
      this.observeModelCall(event);
      if (!isRecordedEventType(event.type)) return;
      const { data, trunc } = projectEvent(event);
      this.recorder.buffer({ turn: this.turn, type: event.type, data }, trunc);
    } catch (error) {
      this.recorder.fail(error);
    }
  }

  /**
   * Buffers one bounded `modelCall` record per **completed** model call (issue #8
   * follow-up A). Synchronous and I/O-free like every other observation — it rides
   * the turn's ordinary closing append.
   *
   * The raw events stay dropped by the allowlist and stay *counted* as dropped;
   * this is a derived projection like `partialText` and `spend`, not a fifth
   * recorded event type. A failed attempt (`stopData` absent) writes nothing —
   * the failure is `turnEnded.failure`'s story, and inventing a call line for a
   * request no provider answered would price something that never completed.
   */
  private observeModelCall(event: AgentStreamEvent): void {
    if (event.type === 'beforeModelCallEvent') {
      const projected = (event as { projectedInputTokens?: unknown }).projectedInputTokens;
      if (typeof projected === 'number' && Number.isFinite(projected)) {
        this.lastProjectedInputTokens = projected;
      }
      return;
    }
    if (event.type !== 'afterModelCallEvent') return;

    const stopData = (event as { stopData?: { message?: { metadata?: { usage?: unknown } }; stopReason?: unknown } })
      .stopData;
    if (stopData === undefined) return;
    const attemptCount = (event as { attemptCount?: unknown }).attemptCount;
    const usage = stopData.message?.metadata?.usage;
    const spend = usage === undefined ? undefined : this.projectCallSpend(usage);
    // The provider/model labels are configuration-controlled strings on a rendered
    // record, so they pass the same cap `turnEnded.spend` does.
    const capped = spend === undefined ? undefined : capSpend(spend);
    const stopReason = stopData.stopReason;
    this.recorder.buffer(
      {
        turn: this.turn,
        type: 'modelCall',
        attempt: typeof attemptCount === 'number' && Number.isFinite(attemptCount) ? attemptCount : 1,
        ms: Date.now() - this.startedAt,
        ...(typeof stopReason === 'string' && stopReason !== '' ? { stopReason } : {}),
        ...(this.lastProjectedInputTokens === undefined
          ? {}
          : { contextTokens: this.lastProjectedInputTokens }),
        ...(capped === undefined ? {} : { spend: capped.value }),
      },
      capped?.trunc ?? [],
    );
  }

  /**
   * One call's spend, or `undefined` when it could not be projected — the same
   * belt-to-braces {@link readSpend} wears: the injected projector is documented as
   * non-throwing, and a broken one must cost the price tag only.
   */
  private projectCallSpend(usage: unknown): TurnSpend | undefined {
    if (usage === null || typeof usage !== 'object') return undefined;
    const { inputTokens, outputTokens } = usage as Record<string, unknown>;
    if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return undefined;
    try {
      return this.callSpend?.project(usage as Parameters<CallSpendProjector['project']>[0]);
    } catch {
      return undefined;
    }
  }

  /**
   * Notes that the turn's stream threw, before {@link end} closes the turn.
   *
   * Same rules as {@link record}: synchronous, no I/O, and it swallows its own
   * failures. The error itself is not touched — the caller of `AgentRuntime.send`
   * receives the identical object, and this only reads its class and message.
   */
  failed(error: unknown): void {
    if (this.ended || this.failure !== undefined) return;
    try {
      this.failure = failureFromError(error);
    } catch (problem) {
      this.recorder.fail(problem);
    }
  }

  /** Closes the turn and schedules the append. Never awaited by the stream. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    // Read before the record is composed, and outside the composition's own try: a
    // meter that throws must cost the *spend field only*, not the whole closing record,
    // and must never latch recording off — the turn's outcome and counters are worth
    // more than its price tag. An unread meter is recorded as nothing, which reads back
    // as unknown.
    const spend = this.readSpend();
    try {
      const { value, trunc } = capField(this.partialText.trim(), 'partialText');
      // A provider message can be enormous (a rejected request is sometimes echoed
      // back whole), so the failure goes through the same cap as everything else and
      // its truncation is written down on the same record.
      const failure = this.failure === undefined ? undefined : capFailure(this.failure);
      // The model id comes from configuration, so it is capped like any other string a
      // user or provider controls, with its truncation on the same record.
      const capped = spend === undefined ? undefined : capSpend(spend);
      this.recorder.buffer(
        {
          turn: this.turn,
          type: 'turnEnded',
          stopReason: this.stopReason,
          ms: Date.now() - this.startedAt,
          recorded: Object.fromEntries(this.recorded),
          dropped: Object.fromEntries(this.dropped),
          ...(value === '' ? {} : { partialText: value }),
          ...(failure === undefined ? {} : { failure: failure.value }),
          ...(capped === undefined ? {} : { spend: capped.value }),
        },
        [...trunc, ...(failure?.trunc ?? []), ...(capped?.trunc ?? [])],
      );
    } catch (error) {
      this.recorder.fail(error);
    }
    this.recorder.flush(true);
  }

  /**
   * The turn's spend, or `undefined` when it could not be read.
   *
   * The injected meter is documented as non-throwing, and this catch is the belt to that
   * braces: an observer reading a number must not be able to end a turn or stop a
   * session's recording, so a broken meter degrades to a record that says nothing about
   * price rather than to a record that is not written.
   */
  private readSpend(): TurnSpend | undefined {
    try {
      return this.spend?.read();
    } catch {
      return undefined;
    }
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
   *
   * `agentResultEvent` is the only source of `stopReason`, and a thrown turn never
   * emits one — that turn is described by `failure` instead (see {@link failed}), not
   * by a stop reason this code invented.
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

/**
 * Caps each part of a failure, naming its path so a reader sees which was cut.
 *
 * Lives beside the record it goes into rather than in `record.ts`: `capField` is the
 * general primitive, and this is the writer's use of it.
 */
function capFailure(failure: TurnFailure): { value: TurnFailure; trunc: Truncation[] } {
  const name = capField(failure.name, 'failure.name');
  const message = capField(failure.message, 'failure.message');
  const cause = failure.cause === undefined ? undefined : capField(failure.cause, 'failure.cause');
  return {
    value: {
      name: name.value,
      message: message.value,
      ...(cause === undefined ? {} : { cause: cause.value }),
    },
    trunc: [...name.trunc, ...message.trunc, ...(cause?.trunc ?? [])],
  };
}

/**
 * Caps the two provider-controlled strings in a spend, naming their paths.
 *
 * The numbers need no capping; the labels do. `model` is whatever the config names,
 * so it is user-controlled text on a record that reports are rendered from — capped
 * for the same reason a failure's class name is.
 */
function capSpend(spend: TurnSpend): { value: TurnSpend; trunc: Truncation[] } {
  const provider = capField(spend.provider, 'spend.provider');
  const model = capField(spend.model, 'spend.model');
  return {
    value: { ...spend, provider: provider.value, model: model.value },
    trunc: [...provider.trunc, ...model.trunc],
  };
}

export class TrajectoryRecorder {
  private readonly file: string;
  private readonly openFile: typeof open;
  private readonly run: RecorderRunInfo;
  private readonly maxBytes: number;
  private readonly inputDurabilityTimeoutMs: number;
  /**
   * When this process started recording.
   *
   * Used for the `runStarted` record rather than the moment of the first flush: the
   * header is written ahead of the first turn's records, so stamping it later would
   * put a timestamp from *after* those events on the line that precedes them.
   */
  private readonly startedAt = new Date().toISOString();

  /** Buffered-but-unwritten records, in observation order (input or turn remainder). */
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
  private readonly onTurnSettled: ((settlement: TurnSettlement) => void) | undefined;

  constructor(options: RecorderOptions) {
    this.file = options.file;
    this.run = options.run;
    this.openFile = options.openFile ?? open;
    this.maxBytes = options.maxBytes ?? MAX_FILE_BYTES;
    this.inputDurabilityTimeoutMs =
      options.inputDurabilityTimeoutMs ?? INPUT_DURABILITY_TIMEOUT_MS;
    this.onTurnSettled = options.onTurnSettled;
  }

  /**
   * Opens a turn. Returns `undefined` once recording has stopped.
   *
   * The spend meter is passed in per turn rather than held by the recorder, because it
   * measures one turn: `AgentRuntime.send` creates it before the stream and the same
   * object answers the record here, so the record and the live last-turn report cannot
   * be two different readings of one turn.
   */
  beginTurn(input: string, spend?: TurnSpendMeter, callSpend?: CallSpendProjector): TurnRecording | undefined {
    if (!this.active) return undefined;
    this.turns += 1;
    return new TurnRecording(this, this.turns, input, spend, callSpend);
  }

  /** The next turn identity without opening or writing a turn. */
  get nextTurn(): number | undefined {
    return this.active ? this.turns + 1 : undefined;
  }

  /**
   * Records one user-typed `!` command (SER-024). Between turns by nature — the
   * TUI refuses to run one while a turn streams — so this is never on the
   * streaming path: composing and buffering are synchronous and non-throwing like
   * every other record, and the flush is the same fire-and-forget append chain a
   * closing turn uses. `output` arrives already bounded (the SER-009 projection
   * the screen showed); the field caps here are a backstop, not the bound.
   */
  recordShellCommand(entry: {
    command: string;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    durationMs: number;
    output: string;
  }): void {
    if (!this.active) return;
    try {
      const command = capField(entry.command, 'command');
      const output = capField(entry.output, 'output');
      this.buffer(
        {
          turn: this.turns,
          type: 'shellCommand',
          command: command.value,
          exitCode: entry.exitCode,
          signal: entry.signal,
          timedOut: entry.timedOut,
          durationMs: entry.durationMs,
          output: output.value,
        },
        [...command.trunc, ...output.trunc],
      );
      this.flush();
    } catch (error) {
      this.fail(error);
    }
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
   * Flushes the turn-opening `userInput` and waits only for this bounded barrier.
   *
   * Unlike stream-event observation, the runtime deliberately awaits this before it
   * calls `Agent.stream()`. Both failure paths still resolve: a recorder can explain
   * that it stopped, but it can never become a second reason the Agent turn stops.
   * Detaching a timed-out chain also keeps shutdown from waiting forever on the same
   * stuck filesystem operation.
   */
  async inputDurable(): Promise<void> {
    if (!this.active || this.pending.length === 0) return;
    this.flush();
    const barrier = this.chain;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      barrier.then(() => false),
      new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), this.inputDurabilityTimeoutMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (!timedOut) return;

    this.fail(
      new Error(
        `trajectory input durability timed out after ${this.inputDurabilityTimeoutMs}ms`,
      ),
    );
    if (this.chain === barrier) this.chain = Promise.resolve();
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
   * Returns nothing on purpose: event/turn-end callers cannot await this.
   * `inputDurable()` waits through the private chain before invocation; `close()`
   * waits through it during cleanup.
   */
  flush(closesTurn = false): void {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    const closing = closesTurn
      ? batch.findLast((entry) => entry.record.type === 'turnEnded')
      : undefined;
    const turn = closing?.record.turn ?? 0;
    this.chain = this.chain
      .then(() => this.append(batch))
      .then((settlement) => {
        if (!closesTurn) return;
        this.publishSettlement(settlement ?? { durable: false, turn, reason: 'closing trajectory batch was not appended' });
      })
      .catch((error: unknown) => {
        this.fail(error);
        if (closesTurn) this.publishSettlement({ durable: false, turn, reason: boundedSettlementReason(error) });
      });
  }

  private publishSettlement(settlement: TurnSettlement): void {
    try {
      this.onTurnSettled?.(settlement);
    } catch {
      // Derived observation is advisory and cannot affect trajectory durability.
    }
  }

  /** Flushes and waits, so a turn's records are durable before the process exits. */
  async close(): Promise<void> {
    this.flush();
    await this.chain;
  }

  private async append(batch: BufferedRecord[]): Promise<TurnSettlement | undefined> {
    const closing = batch.findLast((entry) => entry.record.type === 'turnEnded');
    if (this.problem !== undefined) return closing === undefined ? undefined : { durable: false, turn: closing.record.turn, reason: boundedSettlementReason(this.problem) };

    const prefix = await this.prepare();
    // A bounded input barrier may have timed out while prepare/open was pending.
    // Do not let that detached operation append later after recording has stopped.
    if (this.problem !== undefined) return closing === undefined ? undefined : { durable: false, turn: closing.record.turn, reason: boundedSettlementReason(this.problem) };
    const all = [...this.header(), ...batch];
    const encoded = all.map((buffered) => ({ buffered, seq: this.seq, line: this.encode(buffered) }));
    const lines = encoded.map((entry) => entry.line);
    const payload = `${prefix}${lines.join('')}`;

    let handle: FileHandle | undefined;
    try {
      handle = await this.openFile(this.file, 'a');
      if (this.problem !== undefined) return closing === undefined ? undefined : { durable: false, turn: closing.record.turn, reason: boundedSettlementReason(this.problem) };
      await handle.write(payload, null, 'utf8');
      const written = Buffer.byteLength(payload, 'utf8');
      this.recordsThisRun += lines.length;
      this.bytesThisRun += written;
      this.fileBytes += written;

      if (this.fileBytes >= this.maxBytes) await this.stopForBudget(handle);
      if (closing === undefined) return undefined;
      const encodedClosing = encoded.find((entry) => entry.buffered === closing);
      const record = closing.record as Extract<PendingRecord, { type: 'turnEnded' }>;
      return {
        durable: true,
        session: this.run.session,
        turn: record.turn,
        seq: encodedClosing?.seq ?? Math.max(0, this.seq - 1),
        at: closing.at,
        stopReason: record.stopReason,
        failure: record.failure !== undefined,
        partial: record.partialText !== undefined,
      };
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


function boundedSettlementReason(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim() || 'trajectory closing append failed';
  const points = [...text];
  return points.length <= 200 ? text : `${points.slice(0, 199).join('')}…`;
}

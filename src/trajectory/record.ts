/**
 * The trajectory record format: what one line of `trajectory.jsonl` is, and how an
 * SDK stream event becomes one.
 *
 * Everything here is pure and synchronous. The writer must be able to format a
 * record between two stream events without awaiting anything, and every reader —
 * search, replay, the CLI — has to be able to parse a line without constructing a
 * model or an agent. See `.trellis/spec/backend/session-trajectory.md`.
 */
import type { AgentStreamEvent } from '@strands-agents/sdk';

/** Bumped only for a change a reader cannot tolerate; readers keep older versions readable. */
export const SCHEMA_VERSION = 1;

/**
 * Cap on any single string inside a record, in code points.
 *
 * Sized so a long assistant answer (~2k tokens) survives whole while a
 * whole-file `fileEditor view` result or a 100k-line log does not. Code points
 * rather than bytes, matching `headlessField`: slicing UTF-8 by byte length
 * replaces a trailing multi-byte sequence with U+FFFD (see the truncation
 * mistake recorded in `.trellis/spec/backend/error-handling.md`).
 */
export const MAX_FIELD_CHARS = 8_000;

/**
 * Cap on one serialized record, in bytes — the same 64 KiB bound the background
 * `bash output` mode already uses. A record still over it after field capping
 * keeps its envelope and loses its payload, because a line nothing can parse is
 * worse than a line that says it was dropped.
 */
export const MAX_RECORD_BYTES = 64 * 1024;

/**
 * Cap on one session's record file, in bytes.
 *
 * Nothing in darwin garbage-collects session state (see `contextOffload` in
 * `src/config.ts`), so a per-conversation hard bound is the only real disk bound.
 * Recording stops at this point rather than rotating: rotation would either
 * rewrite bytes or scatter one conversation over several files, and both cost
 * more than they save for an observational record.
 */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Marks a string the caps shortened, so "all there was" and "cut" stay distinguishable. */
export interface Truncation {
  /** Dotted path inside the record payload, e.g. `toolUse.input.command`. */
  path: string;
  /** Code points the original held. */
  chars: number;
  /** Code points retained. */
  kept: number;
}

/** SDK event types the record retains. Everything else is counted, not stored. */
export const RECORDED_EVENT_TYPES = [
  'contentBlockEvent',
  'beforeToolCallEvent',
  'afterToolCallEvent',
  'agentResultEvent',
] as const;

export type RecordedEventType = (typeof RECORDED_EVENT_TYPES)[number];

export function isRecordedEventType(type: string): type is RecordedEventType {
  return (RECORDED_EVENT_TYPES as readonly string[]).includes(type);
}

export type TrajectoryRecordType =
  | 'runStarted'
  | 'userInput'
  | 'turnEnded'
  | 'forkedFrom'
  | 'recordingStopped'
  | 'shellCommand'
  | RecordedEventType;

/** Fields every record carries, whatever its type. */
export interface RecordEnvelope {
  /** {@link SCHEMA_VERSION} at write time. */
  v: number;
  /** Monotonic within the file, continuing across runs so a gap means real loss. */
  seq: number;
  /** ISO 8601 time the event was observed, not the time its batch was appended. */
  t: string;
  /** 1-based turn ordinal within this file. `0` for records outside a turn. */
  turn: number;
  type: TrajectoryRecordType;
  /** Present only when a cap shortened something. */
  trunc?: Truncation[];
}

export interface RunStartedRecord extends RecordEnvelope {
  type: 'runStarted';
  session: string;
  agentId: string;
  darwinVersion: string;
  provider: string;
  model: string;
  permissionMode: string;
  thinkingEffort: string | undefined;
  resumed: boolean;
  restoredMessages: number;
  pid: number;
}

export interface UserInputRecord extends RecordEnvelope {
  type: 'userInput';
  /** Exactly what was handed to `agent.stream()`, so a slash command appears expanded. */
  text: string;
}

export interface EventRecord extends RecordEnvelope {
  type: RecordedEventType;
  /** The SDK event's own `toJSON()` projection, capped. */
  data: Record<string, unknown>;
}

/**
 * What the turn's stream threw, as far as an observer can honestly say.
 *
 * `name` is the error's class, `message` its text — the two things that identify a
 * provider failure without carrying a stack trace (which names local paths and is
 * not what the record is for). All fields are capped like any other string field.
 */
export interface TurnFailure {
  name: string;
  message: string;
  /**
   * The wrapped error's class, when the thrown error wraps another.
   *
   * Not decoration: measured on `@strands-agents/sdk@1.12.0`, `Model.streamAggregated`
   * catches anything that is not already a `ModelError` and rethrows
   * `new ModelError(normalized.message, { cause: original })`. So a real Bedrock
   * rejection reaches the caller as `ModelError` with the provider's *message* intact
   * and its *class* only on `cause` — without this field every provider failure in the
   * file would read `ModelError` and nothing would distinguish a throttle from an
   * expired token. The cause's message is deliberately not stored: the wrapper copied
   * it, so the class is the only fact wrapping loses.
   */
  cause?: string;
}

/**
 * What one turn cost, in the mutually exclusive buckets `src/agent/usage.ts` defines.
 *
 * Named `spend` rather than `usage` on purpose: a recorded `agentResultEvent` already
 * carries `result.lastMessage.metadata.usage` — the provider's counters for the
 * **final model call** of the turn, because `Message.toJSON()` keeps `metadata` while
 * `AgentResult.toJSON()` drops `metrics`. That number is not this one: it covers one
 * call, not the turn, and a failed or cancelled turn (which emits no
 * `agentResultEvent`) has none at all. Two different things called `usage` in one file
 * would be worse than no name.
 *
 * Every field is the *delta over one turn* of the SDK meter's lifetime accumulator,
 * projected through `usageBuckets`, so the numbers mean exactly what the headless
 * `usage:` line means and the two can be compared field for field.
 *
 * An unreported metric is an **absent key**, never `0`: "the provider did not report
 * this" and "this was zero" are different facts, and OpenAI Responses genuinely cannot
 * split uncached input when either cache subset is missing. `input`/`output` are always
 * reported by every provider the SDK supports, so a `0` there is a measurement — the
 * turn's model calls billed nothing, which is what a turn that failed before its first
 * call completed really did.
 */
export interface TurnSpend {
  /** Provider that incurred it — the same string `runStarted.provider` carries. */
  provider: string;
  /** Model id that incurred it. Attribution lives on the same line as the numbers. */
  model: string;
  /** Uncached input. Absent when a provider-native total cannot be split without guessing. */
  input?: number;
  /**
   * Output tokens. Always written by darwin — every provider the SDK supports reports
   * them — and optional only so that a damaged or foreign record missing the key reads
   * as unknown rather than as a free turn.
   */
  output?: number;
  /** Absent until the provider reports it. */
  cacheRead?: number;
  /** Absent until the provider reports it. */
  cacheWrite?: number;
}

/**
 * Reads the live token meter for the turn being recorded.
 *
 * Injected into `TrajectoryRecorder.beginTurn` by `AgentRuntime.send` — the one layer
 * that knows both the SDK meter and the live model config — for the same reason the
 * permission gate takes a `dispatchSource` resolver: an observer must not learn about
 * the agent. It keeps `src/trajectory/**` free of any `Agent`/`Model` import, which is
 * what makes "the read paths call no model" structural rather than a promise.
 *
 * `read()` is called synchronously while the closing record is composed, must not
 * throw, and returns `undefined` when the meter could not be read — which is recorded
 * as *nothing*, and reads back as unknown.
 */
export interface TurnSpendMeter {
  read(): TurnSpend | undefined;
}

export interface TurnEndedRecord extends RecordEnvelope {
  type: 'turnEnded';
  stopReason: string | undefined;
  ms: number;
  /** Recorded event counts by SDK type. */
  recorded: Record<string, number>;
  /** Events the allowlist dropped, counted by SDK type, so the loss is visible. */
  dropped: Record<string, number>;
  /** Assistant text that never reached an assembled block (a cancelled turn). */
  partialText?: string;
  /**
   * Present only when the turn's stream threw: what reached the caller of
   * `AgentRuntime.send`.
   *
   * Optional and additive on purpose. A thrown turn never emits `agentResultEvent`,
   * so `stopReason` is `undefined` for it and always will be — inventing a
   * `'failed'` stop reason would put a value no provider produced into a field whose
   * contract is the SDK's own. The presence of this field is what makes a failed turn
   * a failed turn; see {@link turnOutcome}.
   */
  failure?: TurnFailure;
  /**
   * Present when the meter could be read for this turn: what the turn cost.
   *
   * Optional and additive, like {@link failure}: a record written before this field
   * existed, a session recorded with the meter unreadable, and a turn nothing metered
   * are all *unknown*, and no reader may turn that into a zero-cost turn. A failed turn
   * carries this **and** `failure`, because the tokens were billed either way.
   */
  spend?: TurnSpend;
}

export interface ForkedFromRecord extends RecordEnvelope {
  type: 'forkedFrom';
  session: string;
  /** Last sequence number copied from the source (the envelope's `seq` is this record's own). */
  sourceSeq: number;
  /** Bytes copied from the source record. */
  bytes: number;
}

export interface RecordingStoppedRecord extends RecordEnvelope {
  type: 'recordingStopped';
  reason: 'budget' | 'error';
  detail?: string;
}

/**
 * A user-typed `!` command (SER-024), run directly by the TUI — never a model tool
 * call, so it has no `beforeToolCallEvent`/`afterToolCallEvent` pair to ride on.
 *
 * Deliberately **not** a `userInput` record: nothing was handed to
 * `agent.stream()`, and `userInput` is the one line prompt recall reads — a `!`
 * command is a session action, not a prompt, and is not offered back. The
 * envelope's `turn` is the last *closed* turn's ordinal (like
 * `recordingStopped`), because the command ran between turns.
 *
 * `output` is the already-bounded SER-009 projection the screen showed, marker
 * included — the record repeats what was shown, it does not re-derive it.
 */
export interface ShellCommandRecord extends RecordEnvelope {
  type: 'shellCommand';
  command: string;
  /** Process exit code; `null` when it died to a signal or never spawned. */
  exitCode: number | null;
  /** Signal that ended it, `null` for a plain exit. */
  signal: string | null;
  /** True when the TUI's hard timeout killed it. */
  timedOut: boolean;
  durationMs: number;
  output: string;
}

export type TrajectoryRecord =
  | RunStartedRecord
  | UserInputRecord
  | EventRecord
  | TurnEndedRecord
  | ForkedFromRecord
  | RecordingStoppedRecord
  | ShellCommandRecord;

/**
 * A thrown value as the fields the record keeps.
 *
 * The class is read from the prototype rather than from `error.name`, because the
 * two disagree exactly where it matters: every SDK error class sets `name` to its
 * own class name (measured on `@strands-agents/sdk@1.12.0`, `dist/src/errors.js`),
 * but nothing forces a provider or a future subclass to, and then `name` degrades to
 * the useless `'Error'` while the constructor still knows what was thrown. When both
 * are present and differ, the class wins and `name` is appended, because they are
 * two different facts and a record that silently picked one would hide the other.
 *
 * A non-`Error` throw is described by its type rather than pretended to be an error:
 * `String(value)` is the only honest message available.
 */
export function failureFromError(error: unknown): TurnFailure {
  if (!(error instanceof Error)) {
    return { name: `non-error ${error === null ? 'null' : typeof error}`, message: safeString(error) };
  }

  const name = className(error);
  const cause = error.cause instanceof Error ? className(error.cause) : '';
  return {
    name,
    message: typeof error.message === 'string' ? error.message : safeString(error),
    // Only when it adds something: a wrapper of the same class tells a reader nothing.
    ...(cause === '' || cause === name ? {} : { cause }),
  };
}

/** An error's class, with its declared `name` kept when the two disagree. */
function className(error: Error): string {
  const constructed = error.constructor?.name;
  const declared = typeof error.name === 'string' ? error.name : '';
  if (typeof constructed !== 'string' || constructed === '') return declared === '' ? 'Error' : declared;
  if (constructed === declared || declared === '') return constructed;
  return `${constructed} (name: ${declared})`;
}

/** `String()` cannot be trusted on an arbitrary throw: a hostile `toString` may throw itself. */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '(a thrown value that could not be converted to text)';
  }
}

/** Collects truncations while a payload is being capped. */
class Capper {
  readonly truncations: Truncation[] = [];

  capString(value: string, path: string): string {
    const points = [...value];
    if (points.length <= MAX_FIELD_CHARS) return value;
    this.truncations.push({ path, chars: points.length, kept: MAX_FIELD_CHARS });
    return points.slice(0, MAX_FIELD_CHARS).join('');
  }
}

/**
 * Depth-first copy that caps every string it passes, recording each cut.
 *
 * Cycles cannot occur in an event's `toJSON()` output (it is JSON-serializable by
 * contract) but a depth bound is kept anyway: this runs on provider-shaped data,
 * and an observer must not be the thing that overflows a stack mid-turn.
 */
function capValue(value: unknown, path: string, capper: Capper, depth = 0): unknown {
  if (typeof value === 'string') return capper.capString(value, path);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 12) return '[depth-limited]';

  if (Array.isArray(value)) {
    return value.map((entry, index) => capValue(entry, `${path}[${index}]`, capper, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = capValue(entry, path === '' ? key : `${path}.${key}`, capper, depth + 1);
  }
  return out;
}

/**
 * The SDK event's own JSON projection, capped.
 *
 * `JSON.stringify` is used deliberately rather than reading fields off the event:
 * every stream event class declares a `toJSON()` that excludes `agent` and
 * `invocationState` (measured on `@strands-agents/sdk@1.12.0`), so this is the one
 * projection that cannot drag the live agent, its whole message list, or arbitrary
 * per-invocation objects into the file. A hand-rolled copy would have to be
 * re-audited on every SDK upgrade.
 *
 * Reasoning is reduced to its presence here, not by the caps: the reply is the
 * record, the model's private deliberation is not.
 */
export function projectEvent(event: AgentStreamEvent): { data: Record<string, unknown>; trunc: Truncation[] } {
  let serialized: unknown;
  try {
    serialized = JSON.parse(JSON.stringify(event));
  } catch {
    // A payload the SDK could not serialize is still worth a line saying so.
    serialized = { type: event.type, unserializable: true };
  }

  const capper = new Capper();
  const data = capValue(stripReasoningText(serialized), '', capper) as Record<string, unknown>;
  return { data, trunc: capper.truncations };
}

/**
 * Replaces any reasoning block's content with its bare presence, at any depth.
 *
 * Matched on the **serialized** shape, `{ reasoning: … }`, because that is what
 * `toJSON()` produces: a reasoning block loses its `type` discriminator on the way
 * out, so a check for `type === 'reasoningBlock'` would silently never fire and the
 * model's private deliberation — including `redactedContent`, which *is* the
 * reasoning — would land in the file. The in-memory shape is matched too, for any
 * payload that reaches here unserialized.
 *
 * An empty `text` is kept rather than dropping the key, so the record still
 * rehydrates into a real `ReasoningBlock` on replay (measured: `contentBlockFromData`
 * accepts `{ reasoning: { text: '' } }`). Presence is the whole content.
 */
function stripReasoningText(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripReasoningText);
  if (value === null || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  if (record['type'] === 'reasoningBlock') return { type: 'reasoningBlock' };
  if (Object.hasOwn(record, 'reasoning')) return { reasoning: { text: '' } };

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) out[key] = stripReasoningText(entry);
  return out;
}

/** Caps one plain string field (user input, partial assistant text). */
export function capField(value: string, path: string): { value: string; trunc: Truncation[] } {
  const capper = new Capper();
  return { value: capper.capString(value, path), trunc: capper.truncations };
}

/**
 * One record as the line that will be appended, newline included.
 *
 * A record that is still oversized after field capping keeps its envelope and
 * loses its payload: the alternative is a line no reader can parse, which would
 * also break `seq` continuation for every later run.
 */
export function encodeRecord(record: TrajectoryRecord): string {
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line, 'utf8') <= MAX_RECORD_BYTES) return line;

  const reduced = {
    v: record.v,
    seq: record.seq,
    t: record.t,
    turn: record.turn,
    type: record.type,
    dropped: 'record-too-large',
    bytes: Buffer.byteLength(line, 'utf8'),
  };
  return `${JSON.stringify(reduced)}\n`;
}

/**
 * Parses one line, or `undefined` when it is not a usable record.
 *
 * Deliberately forgiving about *unknown* types and extra fields (a newer darwin's
 * file must stay readable) and strict about the envelope: without `type` and `seq`
 * a line cannot be ordered or interpreted, so it counts as damage.
 */
export function parseRecordLine(line: string): TrajectoryRecord | undefined {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  const candidate = parsed as Partial<RecordEnvelope>;
  if (typeof candidate.type !== 'string' || typeof candidate.seq !== 'number') return undefined;
  return parsed as TrajectoryRecord;
}

/** The text a record contributes to search, in the order a reader would read it. */
export function searchableText(record: TrajectoryRecord): string[] {
  switch (record.type) {
    case 'userInput':
      return [record.text];
    case 'turnEnded': {
      // The failure joins search for the same reason tool result text is in it: it is
      // content the record already holds, and "which session hit ThrottlingException"
      // is the question a failed overnight run makes people ask first.
      const failure = turnFailureOf(record);
      return [
        ...(record.partialText === undefined ? [] : [record.partialText]),
        ...(failure === undefined ? [] : [failureLine(failure)]),
      ];
    }
    case 'contentBlockEvent':
    case 'beforeToolCallEvent':
    case 'afterToolCallEvent':
    case 'agentResultEvent':
      return collectStrings(record.data, []);
    case 'shellCommand':
      // Content the record already holds: "which session ran that migration"
      // is a question `!` makes real.
      return [record.command, record.output];
    default:
      return [];
  }
}

/** How a `turnEnded` record reads on its own, with no other line of the file. */
export type TurnOutcome = 'clean' | 'cancelled' | 'failed' | 'abandoned';

/**
 * The one shared reading of how a turn ended, so `list`, `replay` and the tests
 * cannot drift into three different answers.
 *
 * `abandoned` is the honest name for the pre-existing fourth case: the consumer
 * stopped reading before a result arrived (an early `break`, or a for-await body that
 * threw, which JavaScript delivers to the generator as a `return` completion rather
 * than as the turn failing). It is no longer conflated with a failure.
 */
export function turnOutcome(record: TurnEndedRecord): TurnOutcome {
  if (turnFailureOf(record) !== undefined) return 'failed';
  if (record.stopReason === 'cancelled') return 'cancelled';
  return typeof record.stopReason === 'string' && record.stopReason !== '' ? 'clean' : 'abandoned';
}

/**
 * A record's failure as a reader can trust it.
 *
 * Defensive about the payload rather than about the envelope, matching
 * {@link parseRecordLine}: the line may come from an older darwin that never wrote
 * the field, a newer one that writes more, or an interrupted write. A half-present
 * failure is still reported as a failure — dropping it would hide the very thing the
 * field exists to say.
 */
export function turnFailureOf(record: TurnEndedRecord): TurnFailure | undefined {
  const failure = record.failure as unknown;
  if (failure === null || typeof failure !== 'object') return undefined;
  const { name, message, cause } = failure as { name?: unknown; message?: unknown; cause?: unknown };
  const named = typeof name === 'string' ? name : '';
  const said = typeof message === 'string' ? message : '';
  const from = typeof cause === 'string' ? cause : '';
  if (named === '' && said === '' && from === '') return undefined;
  return {
    name: named === '' ? '(unnamed error)' : named,
    message: said,
    ...(from === '' ? {} : { cause: from }),
  };
}

/**
 * A turn's spend as a reader can trust it.
 *
 * Defensive about the payload for the same reasons {@link turnFailureOf} is: the line
 * may come from an older darwin that never wrote the field, a newer one that writes
 * more, or an interrupted write. The rule that matters is that a value which is not a
 * finite number is **unknown**, never `0` — a report that turned a missing counter into
 * a zero would claim a session was cheap when nobody measured it. A `spend` with no
 * usable numbers at all is `undefined`, so "unknown" has exactly one representation.
 */
export function turnSpendOf(record: TurnEndedRecord): TurnSpend | undefined {
  const spend = record.spend as unknown;
  if (spend === null || typeof spend !== 'object') return undefined;
  const { provider, model, input, output, cacheRead, cacheWrite } = spend as Record<string, unknown>;

  const metric = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const counted = metric(output);
  const uncached = metric(input);
  const read = metric(cacheRead);
  const written = metric(cacheWrite);
  if (counted === undefined && uncached === undefined && read === undefined && written === undefined) {
    return undefined;
  }

  return {
    provider: typeof provider === 'string' && provider !== '' ? provider : '(unknown provider)',
    model: typeof model === 'string' && model !== '' ? model : '(unknown model)',
    ...(uncached === undefined ? {} : { input: uncached }),
    ...(counted === undefined ? {} : { output: counted }),
    ...(read === undefined ? {} : { cacheRead: read }),
    ...(written === undefined ? {} : { cacheWrite: written }),
  };
}

/**
 * Cap on one rendered failure summary, in code points.
 *
 * Small on purpose: this is the bound for a *summary* line, where a whole session is
 * one line. The full message — itself capped at {@link MAX_FIELD_CHARS} — stays in
 * the record and is what `replay` prints.
 */
export const MAX_FAILURE_SUMMARY_CHARS = 120;

/** The failure as one unbounded line: what search matches against. */
export function failureLine(failure: TurnFailure): string {
  const named = failure.cause === undefined ? failure.name : `${failure.name} (cause ${failure.cause})`;
  return `${named}: ${failure.message}`;
}

/**
 * {@link failureLine} on one line, bounded — for summary rows.
 *
 * The bound covers the whole rendered line, not the message alone, because the class
 * name is provider-controlled too: an 8,000 code-point name would otherwise blow the
 * row just as easily as a long message. Newlines are collapsed because a provider
 * message with embedded newlines would turn one summary row into several.
 */
export function formatTurnFailure(failure: TurnFailure, limit = MAX_FAILURE_SUMMARY_CHARS): string {
  const line = failureLine(failure).replace(/\s+/gu, ' ').trim();
  const points = [...line];
  return points.length <= limit ? line : `${points.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

function collectStrings(value: unknown, into: string[]): string[] {
  if (typeof value === 'string') {
    into.push(value);
    return into;
  }
  if (value === null || typeof value !== 'object') return into;
  for (const entry of Object.values(value as Record<string, unknown>)) collectStrings(entry, into);
  return into;
}

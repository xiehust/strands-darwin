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

export type TrajectoryRecord =
  | RunStartedRecord
  | UserInputRecord
  | EventRecord
  | TurnEndedRecord
  | ForkedFromRecord
  | RecordingStoppedRecord;

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
    case 'turnEnded':
      return record.partialText === undefined ? [] : [record.partialText];
    case 'contentBlockEvent':
    case 'beforeToolCallEvent':
    case 'afterToolCallEvent':
    case 'agentResultEvent':
      return collectStrings(record.data, []);
    default:
      return [];
  }
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

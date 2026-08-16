/**
 * Reading spend back out of a record: one aggregation, one rendering, two callers.
 *
 * `list` and `replay` both report what a session cost, at the verbosity their format
 * affords, and both go through here — the same discipline `turnOutcome` enforces for how
 * a turn ended. Two implementations would eventually disagree about the only question
 * this file exists to answer.
 *
 * Three rules are load-bearing, and each of them is a way of not lying:
 *
 * 1. **Unknown is not zero.** A turn with no `spend` (recorded before the field existed,
 *    or with the meter unreadable) is counted as *unknown* and reported as such. A metric
 *    no contributing turn reported renders `-`, exactly as the headless `usage:` record
 *    does; a metric some turns reported is summed and the turns that did not are counted
 *    alongside it.
 * 2. **A total names its models.** A single number covering two models covers two
 *    different price lists, so the model count travels with the total and `replay` breaks
 *    it down per model.
 * 3. **Every rendered line is bounded**, because a model id comes from configuration and
 *    a session can hold any number of them.
 *
 * Totals cover **what the file records**. A forked session's trajectory begins with the
 * bytes copied from its source (`fork` is defined as copying them), so those turns are
 * genuinely in this file and are genuinely in its total; the `forkedFrom` record on the
 * same file says where they came from. Excluding them would put a total on the same row
 * as a record count and a byte count that describe a larger file.
 *
 * This module imports no `Agent`, no `Model` and nothing from `src/agent/**`: reporting
 * spend must stay as offline as replaying history.
 */
import { turnSpendOf, type TrajectoryRecord, type TurnEndedRecord, type TurnSpend } from './record.js';

/** One metric's total, and how many recorded turns had nothing to say about it. */
export interface SpendMetric {
  /** Sum over the turns that reported it; `undefined` when none did. */
  total: number | undefined;
  /** Turns that carried a spend but not this metric. */
  unreportedTurns: number;
}

/** What one model was paid for, so a mixed total can always be broken apart. */
export interface ModelSpend {
  /** `provider/model`, as recorded on the turn. */
  label: string;
  turns: number;
  input: SpendMetric;
  output: SpendMetric;
  cacheRead: SpendMetric;
  cacheWrite: SpendMetric;
}

/** Everything a report can say about a file's spend without reading it twice. */
export interface SpendSummary {
  /** Turns whose record carried a usable spend. */
  turnsWithSpend: number;
  /** Turns whose record carried none — unknown, never free. */
  turnsUnknown: number;
  input: SpendMetric;
  output: SpendMetric;
  cacheRead: SpendMetric;
  cacheWrite: SpendMetric;
  /** Per-model breakdown, in first-appearance order. */
  models: ModelSpend[];
}

/** One turn's spend with the ordinal the record gave it, for per-turn reporting. */
export interface TurnSpendEntry {
  turn: number;
  /** `undefined` when that turn's record carried no usable spend. */
  spend: TurnSpend | undefined;
}

/**
 * Aggregates every `turnEnded` record in the file.
 *
 * Counted per **record**, not per distinct `turn` ordinal: ordinals restart at 1 in each
 * process that appends to a session (a pre-existing property of `TrajectoryRecorder`,
 * noted when the failure record was added), so grouping by ordinal would silently merge
 * two runs' turns and under-report the file.
 */
export function summarizeSpend(records: readonly TrajectoryRecord[]): SpendSummary {
  const entries = turnSpendEntries(records);
  const spends = entries.flatMap((entry) => (entry.spend === undefined ? [] : [entry.spend]));

  const models: ModelSpend[] = [];
  for (const spend of spends) {
    const label = modelLabel(spend);
    const existing = models.find((model) => model.label === label);
    const group = existing ?? emptyModel(label);
    if (existing === undefined) models.push(group);
    group.turns += 1;
    accumulate(group, spend);
  }

  return {
    turnsWithSpend: spends.length,
    turnsUnknown: entries.length - spends.length,
    input: metric(spends, (spend) => spend.input),
    output: metric(spends, (spend) => spend.output),
    cacheRead: metric(spends, (spend) => spend.cacheRead),
    cacheWrite: metric(spends, (spend) => spend.cacheWrite),
    models,
  };
}

/** Every closed turn's spend in file order, unknown ones included so they can be reported. */
export function turnSpendEntries(records: readonly TrajectoryRecord[]): TurnSpendEntry[] {
  return records
    .filter((record): record is TurnEndedRecord => record.type === 'turnEnded')
    .map((record) => ({ turn: record.turn, spend: turnSpendOf(record) }));
}

/** `provider/model`, the same label `replay`'s run header uses for `runStarted`. */
export function modelLabel(spend: TurnSpend): string {
  return `${spend.provider}/${spend.model}`;
}

/**
 * Cap on one rendered model label, in code points.
 *
 * A model id is configuration, so it is as unbounded as any other user-supplied string;
 * this keeps a summary row a row. The full value stays in the record.
 */
export const MAX_MODEL_LABEL_CHARS = 60;

/** A label as a summary line may carry it. */
export function formatModelLabel(label: string, limit = MAX_MODEL_LABEL_CHARS): string {
  const points = [...label.replace(/\s+/gu, ' ').trim()];
  return points.length <= limit ? points.join('') : `${points.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

/** Models named in a summary before the rest are only counted. */
const LISTED_MODELS = 3;

/**
 * The four buckets as the fixed `input=… output=… cacheRead=… cacheWrite=…` sequence
 * the headless `usage:` record established, so one convention covers both surfaces.
 *
 * `-` means unreported, never zero. A metric only some turns reported carries how many
 * did not, because a sum over a subset is not the same claim as a sum.
 */
export function formatSpendFields(summary: {
  input: SpendMetric;
  output: SpendMetric;
  cacheRead: SpendMetric;
  cacheWrite: SpendMetric;
}): string {
  return (
    `input=${formatMetric(summary.input)} output=${formatMetric(summary.output)}` +
    ` cacheRead=${formatMetric(summary.cacheRead)} cacheWrite=${formatMetric(summary.cacheWrite)}`
  );
}

/** One metric: its sum, or `-`, with the turns that never reported it noted. */
export function formatMetric(metric: SpendMetric): string {
  if (metric.total === undefined) return '-';
  return metric.unreportedTurns === 0
    ? String(metric.total)
    : `${metric.total}(+${metric.unreportedTurns} unreported)`;
}

/**
 * A whole file's spend as one bounded clause — what `list` appends to a session's row.
 *
 * `unknown` when nothing was measured: a session recorded before this field existed cost
 * something, and printing zeros for it would be an invention.
 */
export function formatSpendSummary(summary: SpendSummary): string {
  if (summary.turnsWithSpend === 0) {
    return summary.turnsUnknown === 0 ? 'spend: unknown (no turns)' : 'spend: unknown';
  }

  const unknown = summary.turnsUnknown === 0 ? '' : `, ${summary.turnsUnknown} turn(s) unknown`;
  const named = summary.models
    .slice(0, LISTED_MODELS)
    .map((model) => formatModelLabel(model.label))
    .join(', ');
  const rest = summary.models.length - Math.min(summary.models.length, LISTED_MODELS);
  const models =
    summary.models.length <= 1
      ? named
      : `${summary.models.length} models: ${named}${rest > 0 ? ` +${rest} more` : ''}`;
  return `spend: ${formatSpendFields(summary)} (${models}${unknown})`;
}

/** One turn's line for `replay`: the buckets it paid, or that nothing measured it. */
export function formatTurnSpend(entry: TurnSpendEntry): string {
  if (entry.spend === undefined) return `turn ${entry.turn} spend: unknown (not recorded)`;
  const one = asMetrics(entry.spend);
  return `turn ${entry.turn} spend: ${formatSpendFields(one)} · ${formatModelLabel(modelLabel(entry.spend))}`;
}

/** One model's line for `replay`, when a file holds more than one. */
export function formatModelSpend(model: ModelSpend): string {
  return `${formatModelLabel(model.label)}: ${formatSpendFields(model)} over ${model.turns} turn(s)`;
}

function emptyModel(label: string): ModelSpend {
  const zero = (): SpendMetric => ({ total: undefined, unreportedTurns: 0 });
  return { label, turns: 0, input: zero(), output: zero(), cacheRead: zero(), cacheWrite: zero() };
}

function accumulate(model: ModelSpend, spend: TurnSpend): void {
  add(model.input, spend.input);
  add(model.output, spend.output);
  add(model.cacheRead, spend.cacheRead);
  add(model.cacheWrite, spend.cacheWrite);
}

/** Sums a reported value, or counts the turn that did not report it. */
function add(metric: SpendMetric, value: number | undefined): void {
  if (value === undefined) {
    metric.unreportedTurns += 1;
    return;
  }
  metric.total = (metric.total ?? 0) + value;
}

function metric(spends: readonly TurnSpend[], pick: (spend: TurnSpend) => number | undefined): SpendMetric {
  const out: SpendMetric = { total: undefined, unreportedTurns: 0 };
  for (const spend of spends) add(out, pick(spend));
  return out;
}

/** One turn's spend in the shape {@link formatSpendFields} reads. */
function asMetrics(spend: TurnSpend): {
  input: SpendMetric;
  output: SpendMetric;
  cacheRead: SpendMetric;
  cacheWrite: SpendMetric;
} {
  const one = (value: number | undefined): SpendMetric => ({ total: value, unreportedTurns: 0 });
  return {
    input: one(spend.input),
    output: one(spend.output),
    cacheRead: one(spend.cacheRead),
    cacheWrite: one(spend.cacheWrite),
  };
}

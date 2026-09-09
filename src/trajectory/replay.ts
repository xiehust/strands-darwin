/**
 * Replay: a recorded trajectory read back as the history it produced.
 *
 * The one rule that matters here is that replay does **not** own a projection.
 * Records are turned back into `TurnAction`s and fed through the same
 * `turnReducer` the live TUI uses, so live rendering and replay cannot drift into
 * two different readings of the same events. What replay guarantees, and the nine
 * things it explicitly does not reproduce, are written down in
 * `docs/architecture/load-bearing-decisions.md` § Session trajectory.
 *
 * This module imports no `Agent`, no `Model` and nothing from `src/agent/runtime.ts`:
 * replay makes zero model calls by construction, not by discipline.
 */
import { contentBlockFromData, type AgentStreamEvent } from '@strands-agents/sdk';

import { isRefusalStop } from '../agent/refusal.js';
import { initialTurnState, turnReducer, type HistoryItem } from '../tui/turn-state.js';
import { describeDamage, type TrajectoryReadResult } from './reader.js';
import {
  SILENT_PERMISSION_OUTCOMES,
  contextCompactedOf,
  formatTurnFailure,
  permissionDecisionOf,
  rewindOriginOf,
  turnFailureOf,
  type ContextCompactedReading,
  type ContextCompactedRecord,
  type ModelCallReading,
  type ModelCallRecord,
  type PermissionDecisionReading,
  type RewindOrigin,
  type TrajectoryRecord,
  type TurnEndedRecord,
  type TurnFailure,
} from './record.js';
import {
  formatModelCall,
  formatModelSpend,
  formatSessionCost,
  formatSpendFields,
  formatTurnSpend,
  modelCallEntries,
  priceSpend,
  summarizeSpend,
  turnSpendEntries,
  type SpendCostReport,
  type SpendSummary,
  type TurnSpendEntry,
} from './spend.js';
import type { ModelPriceCache } from '../pricing/model-prices.js';

export interface ReplayResult {
  /** The reconstructed history, in order. */
  history: HistoryItem[];
  /** Turn ordinals the record contains. */
  turns: number[];
  /** Runs the record covers — one per process that appended to it. */
  runs: {
    turn: number;
    session: string;
    model: string;
    at: string;
    resumed: boolean;
    /** The `/rewind` checkpoint a successor run branched from, when its record names one. */
    rewindFrom?: RewindOrigin;
  }[];
  /** Damage the reader tolerated, ready to report; `undefined` when the file was clean. */
  damage: string | undefined;
  /** Records the replay skipped because a cap had removed their payload. */
  droppedRecords: number;
  /** Turns whose stream threw, in turn order, with what it threw. */
  failures: (TurnFailure & { turn: number })[];
  /**
   * What each closed turn cost, in file order, including the turns nothing measured —
   * an unmeasured turn is reported as unknown rather than dropped from the report.
   */
  turnSpend: TurnSpendEntry[];
  /**
   * Every completed model call the record holds, in file order — the call-level
   * reading `modelCall` records exist for. Empty for files that predate the record
   * type, which is what keeps their `formatReplay` (and therefore `/export`)
   * byte-identical.
   */
  modelCalls: ModelCallReading[];
  /** The same numbers aggregated for the whole file, with the models that incurred them. */
  spend: SpendSummary;
  /**
   * {@link spend} priced per model from the price cache handed in through
   * {@link ReplayOptions.prices} — absent when none was, which is how `/export` stays a
   * projection of the record alone: a transcript file must not depend on what
   * `~/.darwin/model-prices.json` happened to hold when it was written. Absent too
   * when no turn carried a spend (there is nothing to price, and `spend` already
   * says so).
   */
  cost?: SpendCostReport;
}

export interface ReplayOptions {
  /** Replay only this 1-based turn ordinal. */
  turn?: number;
  /**
   * A price cache already read (`readModelPriceCache`) — replay never reads, fetches
   * or writes one itself. The CLI `replay` passes it; `/export` does not.
   */
  prices?: ModelPriceCache;
}

/**
 * Rebuilds history from records.
 *
 * Pure over its input: the same records always produce the same history, which is
 * what makes replay quotable. History item `id`s come from a module counter in
 * `turn-state.ts` and are process-local by construction, so comparisons against a
 * live run must ignore them — see {@link historyWithoutIds}.
 */
export function replayRecords(
  records: readonly TrajectoryRecord[],
  options: ReplayOptions = {},
): Omit<ReplayResult, 'damage'> {
  let state = initialTurnState;
  const turns = new Set<number>();
  const runs: ReplayResult['runs'] = [];
  const failures: ReplayResult['failures'] = [];
  // Collected as the loop passes them, so a `--turn` replay reports that turn's spend
  // rather than the file's: the history it prints is filtered the same way, and a total
  // covering turns it did not show would describe a different report.
  const closed: TurnEndedRecord[] = [];
  // Same collection discipline as `closed`: a `--turn` replay reports only the calls
  // of the turn it shows. `contextCompacted` records travel in the same list, in file
  // order, because `modelCallEntries` reads them as the anchor drop that makes the
  // next call's recorded `contextTokens` stale (SRF-027).
  const modelCalls: (ModelCallRecord | ContextCompactedRecord)[] = [];
  let droppedRecords = 0;

  for (const record of records) {
    if (record.turn > 0) turns.add(record.turn);
    if (options.turn !== undefined && record.turn !== options.turn && record.type !== 'runStarted') {
      continue;
    }

    switch (record.type) {
      case 'runStarted': {
        // Read through the shared validator, so a hand-edited or oversize origin is
        // absent here exactly as the writer would have left it absent.
        const rewindFrom = rewindOriginOf(record.rewindFrom);
        runs.push({
          turn: record.turn,
          session: record.session,
          model: `${record.provider}/${record.model}`,
          at: record.t,
          resumed: record.resumed,
          ...(rewindFrom === undefined ? {} : { rewindFrom }),
        });
        continue;
      }

      case 'userInput':
        state = turnReducer(state, { type: 'userInput', text: record.text });
        continue;

      case 'shellCommand':
        // A `!` command replays as exactly the two things the live session showed:
        // the user row (`!command`, the normalized draft the TUI echoed) and the
        // finished pseudo-tool row, composed by the same reducer case from the same
        // recorded fields — printed, not skipped, because the transcript claims to
        // be what happened and a shell command happened.
        state = turnReducer(state, { type: 'userInput', text: `!${record.command}` });
        state = turnReducer(state, {
          type: 'shellCommand',
          command: record.command,
          exitCode: record.exitCode,
          signal: record.signal,
          timedOut: record.timedOut,
          durationMs: record.durationMs,
          output: record.output,
        });
        continue;

      case 'taskNotification':
        // A background-task wake (SER-069) replays as the one notice row the live
        // session showed at send time, composed by the same reducer case from the
        // same recorded fields — never as a `you>` row, because nobody typed it.
        state = turnReducer(state, {
          type: 'taskNotification',
          taskId: record.taskId,
          command: record.command,
          state: record.state,
          exitCode: record.exitCode,
          signal: record.signal,
          ...(record.source === undefined ? {} : { source: record.source }),
        });
        continue;

      case 'contentBlockEvent':
      case 'beforeToolCallEvent':
      case 'afterToolCallEvent':
      case 'agentResultEvent': {
        const event = asStreamEvent(record);
        if (event === undefined) {
          droppedRecords += 1;
          continue;
        }
        state = turnReducer(state, { type: 'streamEvent', event });
        // A refusal-class stop (SRF-029) earns the one answer-slot line the live
        // session's warn notice stood for, after whatever text the turn streamed —
        // exactly where the live driver dispatched its notice. Read from the recorded
        // result alone; every other stop reason replays as before, byte for byte.
        const stopReason = refusalStopReasonOf(event);
        if (stopReason !== undefined) state = turnReducer(state, { type: 'refusalStop', stopReason });
        continue;
      }

      case 'turnEnded':
        closed.push(record);
        // The recorded partial text is what live history received from
        // `flushLiveText` when a turn ended with unassembled deltas — normally a
        // cancelled turn. Replayed as live text so the same flush produces it.
        if (record.partialText !== undefined) {
          state = { ...state, liveText: record.partialText };
        }
        {
          // A failed turn reproduces the notice the TUI already appends in
          // `runTurn` — the same text, the same severity, and before `turnEnded`,
          // because `notice` does not flush live text and the live order is
          // notice-then-flush. Replaying it as history rather than inventing a
          // replay-only line is what keeps one reducer and one projection: a failed
          // turn replays as the history it actually produced. The error's *class*
          // is not in that notice (the live one never had it), so it is reported
          // separately, in {@link formatReplay} and in `failures`.
          const failure = turnFailureOf(record);
          if (failure !== undefined) {
            failures.push({ turn: record.turn, ...failure });
            state = turnReducer(state, {
              type: 'notice',
              text: `turn failed: ${failure.message}`,
              severity: 'error',
            });
          }
        }
        state = turnReducer(state, { type: 'turnEnded' });
        continue;

      case 'modelCall':
        // No history item: the live TUI never drew a row for a completed model call,
        // and replay must not invent one. The record surfaces as the bounded
        // per-call lines `formatReplay` appends beside the spend report.
        modelCalls.push(record);
        continue;

      case 'contextCompacted': {
        // A successful `/compact` (SRF-027) replays as one bounded notice row in
        // transcript order — where the live session showed its own compaction
        // notice — composed from the validated reading only, so the line can never
        // carry a summary or a focus (the record holds neither). A line whose counts
        // do not validate is skipped: nothing is printed from a claim nobody can read.
        const reading = contextCompactedOf(record);
        if (reading === undefined) continue;
        state = turnReducer(state, { type: 'notice', text: formatContextCompacted(reading) });
        modelCalls.push(record);
        continue;
      }

      case 'permissionDecision': {
        // A settled permission decision (SER-079) replays as one bounded notice row in
        // transcript order — only when the user was prompted or the call was denied.
        // The four silent approvals print nothing, so a session with no prompt and no
        // denial renders exactly as it did before the type existed. An unreadable line
        // (unknown outcome, no tool name) prints nothing either; the line's whole
        // meaning is the stage it names, and replay never invents one.
        const reading = permissionDecisionOf(record);
        if (reading === undefined || !isVisiblePermissionDecision(reading)) continue;
        state = turnReducer(state, { type: 'notice', text: formatPermissionDecision(reading) });
        continue;
      }

      case 'forkedFrom':
      case 'recordingStopped':
        continue;
    }
  }

  const spend = summarizeSpend(closed);
  return {
    history: state.history,
    turns: [...turns].sort((a, b) => a - b),
    runs,
    droppedRecords,
    failures,
    turnSpend: turnSpendEntries(closed),
    modelCalls: modelCallEntries(modelCalls),
    spend,
    ...(options.prices !== undefined && spend.turnsWithSpend > 0 && { cost: priceSpend(spend, options.prices) }),
  };
}

/** Replays a file the reader has already opened, carrying its damage report along. */
export function replayRead(read: TrajectoryReadResult, options: ReplayOptions = {}): ReplayResult {
  return { ...replayRecords(read.records, options), damage: describeDamage(read) };
}

/**
 * The one line a successful `/compact` contributes to the transcript (SRF-027):
 * `context compacted: 12 → 5 messages`, then ` · ~N tokens before` only when the
 * record carries a usable estimate and ` · focused` only when a focus was given.
 * Bounded by construction — three validated integers and a flag — and the same
 * text lands in `trajectory replay`, `/export` and the resume recap because all
 * three read it through the notice `replayRecords` dispatches.
 */
export function formatContextCompacted(reading: ContextCompactedReading): string {
  const parts = [
    `context compacted: ${reading.messagesBefore} → ${reading.messagesAfter} messages`,
    ...(reading.estimatedTokensBefore === undefined ? [] : [`~${reading.estimatedTokensBefore} tokens before`]),
    ...(reading.focused ? ['focused'] : []),
  ];
  return parts.join(' · ');
}

/**
 * Whether a permission decision earns a transcript line (SER-079): the user was
 * prompted, or the call was denied. Everything else is a silent approval the live
 * session never showed either, so replay shows nothing for it.
 */
export function isVisiblePermissionDecision(reading: PermissionDecisionReading): boolean {
  return reading.promptedUser || !SILENT_PERMISSION_OUTCOMES.includes(reading.outcome);
}

/**
 * Longest tool name, rule or source label one permission line repeats, in code
 * points. The record itself keeps up to the field cap; a transcript row is one line.
 */
const MAX_PERMISSION_PART_CHARS = 200;

function clipPart(text: string): string {
  // One row by construction: a name or rule with a line break would split the notice.
  const points = [...text.replace(/\r?\n/g, ' ')];
  return points.length <= MAX_PERMISSION_PART_CHARS ? points.join('') : `${points.slice(0, MAX_PERMISSION_PART_CHARS - 1).join('')}…`;
}

/**
 * The one line a prompted or denied permission decision contributes (SER-079):
 * `permission · bash · denied by deny rule bash:git push --force*`,
 * `permission · fileEditor · approved by user (rule granted fileEditor:src/**)`.
 * A child's decision ends in ` · <agent>#<dispatchId>`; a silent outcome that is
 * printed only because a withdrawn prompt preceded it says ` · prompted`. Composed
 * from the validated reading alone — never the tool input, which the record does not
 * hold — and the same text lands in `trajectory replay`, `/export` and the resume
 * recap because all three read it through the notice `replayRecords` dispatches.
 */
export function formatPermissionDecision(reading: PermissionDecisionReading): string {
  const rule = reading.rule === undefined ? undefined : clipPart(reading.rule);
  let verdict: string;
  switch (reading.outcome) {
    case 'write-scope-denied':
      verdict = 'denied by workflow write scope';
      break;
    case 'deny-rule':
      verdict = `denied by deny rule${rule === undefined ? '' : ` ${rule}`}`;
      break;
    case 'plan-denied':
      verdict = 'denied by plan mode';
      break;
    case 'user-denied':
      verdict = 'denied by user';
      break;
    case 'restart-limit-denied':
      verdict = 'denied after repeated mode changes';
      break;
    case 'user-approved':
      verdict = `approved by user${rule === undefined ? '' : ` (rule granted ${rule})`}`;
      break;
    case 'allow-rule':
      verdict = `approved by allow rule${rule === undefined ? '' : ` ${rule}`}`;
      break;
    case 'classifier':
      verdict = 'approved by classifier';
      break;
    case 'yolo':
      verdict = 'approved by yolo mode';
      break;
    case 'safe':
      verdict = 'approved as statically safe';
      break;
  }
  const parts = [
    'permission',
    clipPart(reading.toolName),
    verdict,
    ...(reading.promptedUser && SILENT_PERMISSION_OUTCOMES.includes(reading.outcome) ? ['prompted'] : []),
    ...(reading.source === 'parent' ? [] : [clipPart(reading.source)]),
  ];
  return parts.join(' · ');
}

/**
 * A record's payload as the stream event the reducer expects.
 *
 * The payload is the SDK event's own `toJSON()` output, which is the **wire** shape,
 * not the in-memory one: measured on 1.12.0, a text block serializes as
 * `{"text":"…"}` with no `type` discriminator, and a tool result as
 * `{"toolResult":{status,content}}`. Feeding that straight to `turnReducer` silently
 * renders nothing (and crashes on the tool result, whose `content` is one level
 * deeper than it looks). So content blocks are rehydrated through the SDK's own
 * `contentBlockFromData` — the mirror of the `toJSON()` used to write them, and the
 * one deserializer that stays correct when the SDK adds a block type.
 *
 * A record whose payload a cap replaced (`dropped: 'record-too-large'`), or whose
 * block shape this SDK version cannot rebuild, has no event to give back and is
 * counted instead: replay never invents the content a cap removed, and a single
 * unreadable record must not end a replay.
 */
function asStreamEvent(record: TrajectoryRecord & { type: string }): AgentStreamEvent | undefined {
  const data = (record as { data?: unknown }).data;
  if (data === null || typeof data !== 'object') return undefined;
  const payload = data as Record<string, unknown>;

  try {
    switch (record.type) {
      case 'contentBlockEvent': {
        if (payload['contentBlock'] === undefined) return undefined;
        return {
          type: 'contentBlockEvent',
          contentBlock: contentBlockFromData(payload['contentBlock'] as never),
        } as unknown as AgentStreamEvent;
      }
      case 'afterToolCallEvent': {
        if (payload['toolUse'] === undefined || payload['result'] === undefined) return undefined;
        return {
          type: 'afterToolCallEvent',
          toolUse: payload['toolUse'],
          result: contentBlockFromData(payload['result'] as never),
        } as unknown as AgentStreamEvent;
      }
      case 'beforeToolCallEvent': {
        if (payload['toolUse'] === undefined) return undefined;
        // Already the shape the reducer reads: name, toolUseId and assembled input.
        return { type: 'beforeToolCallEvent', toolUse: payload['toolUse'] } as unknown as AgentStreamEvent;
      }
      default:
        // `agentResultEvent` and anything a newer darwin recorded: the reducer
        // ignores what it does not know, exactly as it does live.
        return { ...payload, type: record.type } as unknown as AgentStreamEvent;
    }
  } catch {
    return undefined;
  }
}

/**
 * The refusal-class stop reason a rehydrated `agentResultEvent` carries, or
 * `undefined` for any other event or stop. The wire payload is `{ result: { stopReason } }`
 * (the SDK's own `toJSON()`); anything not shaped like that is not a refusal, because
 * replay never invents a stop the record does not state.
 */
function refusalStopReasonOf(event: AgentStreamEvent): string | undefined {
  if (event.type !== 'agentResultEvent') return undefined;
  const result = (event as { result?: unknown }).result;
  if (result === null || typeof result !== 'object') return undefined;
  const stopReason = (result as { stopReason?: unknown }).stopReason;
  return typeof stopReason === 'string' && isRefusalStop(stopReason) ? stopReason : undefined;
}

/** History with the process-local ids removed, for comparing a replay to a live run. */
export function historyWithoutIds(history: readonly HistoryItem[]): unknown[] {
  return history.map((item) => {
    const { id: _id, ...rest } = item;
    return rest;
  });
}

/**
 * The one wording for a run's rewind origin, shared by the replay header and the
 * resume recap's title so the two surfaces cannot drift.
 */
export function formatRewindOrigin(origin: RewindOrigin): string {
  return `rewound from ${origin.session} snapshot ${origin.snapshotId}`;
}

/** Plain-text transcript: content, deliberately not an imitation of the Ink frame. */
export function formatReplay(result: ReplayResult): string {
  const lines: string[] = [];
  for (const run of result.runs) {
    // Still one header line per run: the origin is a clause on it, never a row of its own.
    lines.push(
      `--- run ${run.at} · ${run.model}${run.resumed ? ' · resumed' : ''}` +
        `${run.rewindFrom === undefined ? '' : ` · ${formatRewindOrigin(run.rewindFrom)}`}`,
    );
  }

  for (const item of result.history) {
    switch (item.kind) {
      case 'user':
        lines.push(`you> ${item.text}`);
        break;
      case 'assistant':
        // One `darwin>` per answer, not per piece: a streamed answer reaches history
        // in several entries (`turn-state.ts`), and replaying it as several replies
        // would be a different transcript from the one the session showed. An empty
        // closing piece is the blank row a live frame owes and a replay does not.
        if (item.text === '') break;
        lines.push(item.part === 'whole' || item.part === 'first' ? `darwin> ${item.text}` : item.text);
        break;
      case 'tool':
        lines.push(`  tool ${item.name} [${item.status}] ${item.summary}`);
        if (item.preview !== '') {
          for (const previewLine of item.preview.split('\n')) lines.push(`    ${previewLine}`);
        }
        break;
      case 'notice':
        lines.push(`  note ${item.text}`);
        break;
      case 'plan':
        // TUI-only final Static projection. Replay retains the ordinary
        // update_plan tool call/result row as its sole durable evidence.
        break;
    }
  }

  if (result.history.length === 0) lines.push('(the record contains no replayable history)');
  if (result.droppedRecords > 0) {
    lines.push(`  ${result.droppedRecords} record(s) had their payload removed by a size cap`);
  }
  // The class name, which the reconstructed notice above cannot carry because the
  // live notice it mirrors never carried one. Bounded like the `list` summary, since
  // the message itself is already in the notice line, in full.
  for (const failure of result.failures) {
    lines.push(`  turn ${failure.turn} failed: ${formatTurnFailure(failure)}`);
  }

  // The call-level reading first, one bounded line per completed model call, so a
  // reader can see *which* call of a multi-cycle turn grew the context before the
  // per-turn totals summarize it. Absent for files that predate the record type,
  // which keeps their transcript (and `/export`) byte-identical.
  for (const call of result.modelCalls) lines.push(`  ${formatModelCall(call)}`);

  // What it cost, at the one verbosity a transcript can afford it: one bounded line per
  // turn — including the turns nothing measured, because a report that quietly omitted
  // them would read as a cheaper session — then the file's total. The per-model
  // breakdown appears only when a total would otherwise mix two price lists. Money
  // follows the tokens on the same rules, only when the caller priced the result:
  // one `session cost:` line, and each model's own figure beside its token row.
  for (const entry of result.turnSpend) lines.push(`  ${formatTurnSpend(entry)}`);
  if (result.turnSpend.length > 0) {
    const spend = result.spend;
    const unknown = spend.turnsUnknown === 0 ? '' : `, ${spend.turnsUnknown} unknown`;
    lines.push(
      spend.turnsWithSpend === 0
        ? `  session spend: unknown over ${spend.turnsUnknown} turn(s)`
        : `  session spend: ${formatSpendFields(spend)} over ${spend.turnsWithSpend} turn(s)${unknown}`,
    );
    if (result.cost !== undefined) lines.push(`  ${formatSessionCost(result.cost)}`);
    if (spend.models.length > 1) {
      for (const model of spend.models) lines.push(`    ${formatModelSpend(model, result.cost)}`);
    }
  }
  return lines.join('\n');
}

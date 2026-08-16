/**
 * Replay: a recorded trajectory read back as the history it produced.
 *
 * The one rule that matters here is that replay does **not** own a projection.
 * Records are turned back into `TurnAction`s and fed through the same
 * `turnReducer` the live TUI uses, so live rendering and replay cannot drift into
 * two different readings of the same events. What replay guarantees, and the nine
 * things it explicitly does not reproduce, are written down in
 * `.trellis/spec/backend/session-trajectory.md`.
 *
 * This module imports no `Agent`, no `Model` and nothing from `src/agent/runtime.ts`:
 * replay makes zero model calls by construction, not by discipline.
 */
import { contentBlockFromData, type AgentStreamEvent } from '@strands-agents/sdk';

import { initialTurnState, turnReducer, type HistoryItem } from '../tui/turn-state.js';
import { describeDamage, type TrajectoryReadResult } from './reader.js';
import { formatTurnFailure, turnFailureOf, type TrajectoryRecord, type TurnFailure } from './record.js';

export interface ReplayResult {
  /** The reconstructed history, in order. */
  history: HistoryItem[];
  /** Turn ordinals the record contains. */
  turns: number[];
  /** Runs the record covers — one per process that appended to it. */
  runs: { turn: number; session: string; model: string; at: string; resumed: boolean }[];
  /** Damage the reader tolerated, ready to report; `undefined` when the file was clean. */
  damage: string | undefined;
  /** Records the replay skipped because a cap had removed their payload. */
  droppedRecords: number;
  /** Turns whose stream threw, in turn order, with what it threw. */
  failures: (TurnFailure & { turn: number })[];
}

export interface ReplayOptions {
  /** Replay only this 1-based turn ordinal. */
  turn?: number;
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
  let droppedRecords = 0;

  for (const record of records) {
    if (record.turn > 0) turns.add(record.turn);
    if (options.turn !== undefined && record.turn !== options.turn && record.type !== 'runStarted') {
      continue;
    }

    switch (record.type) {
      case 'runStarted':
        runs.push({
          turn: record.turn,
          session: record.session,
          model: `${record.provider}/${record.model}`,
          at: record.t,
          resumed: record.resumed,
        });
        continue;

      case 'userInput':
        state = turnReducer(state, { type: 'userInput', text: record.text });
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
        continue;
      }

      case 'turnEnded':
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

      case 'forkedFrom':
      case 'recordingStopped':
        continue;
    }
  }

  return {
    history: state.history,
    turns: [...turns].sort((a, b) => a - b),
    runs,
    droppedRecords,
    failures,
  };
}

/** Replays a file the reader has already opened, carrying its damage report along. */
export function replayRead(read: TrajectoryReadResult, options: ReplayOptions = {}): ReplayResult {
  return { ...replayRecords(read.records, options), damage: describeDamage(read) };
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

/** History with the process-local ids removed, for comparing a replay to a live run. */
export function historyWithoutIds(history: readonly HistoryItem[]): unknown[] {
  return history.map((item) => {
    const { id: _id, ...rest } = item;
    return rest;
  });
}

/** Plain-text transcript: content, deliberately not an imitation of the Ink frame. */
export function formatReplay(result: ReplayResult): string {
  const lines: string[] = [];
  for (const run of result.runs) {
    lines.push(`--- run ${run.at} · ${run.model}${run.resumed ? ' · resumed' : ''}`);
  }

  for (const item of result.history) {
    switch (item.kind) {
      case 'user':
        lines.push(`you> ${item.text}`);
        break;
      case 'assistant':
        lines.push(`darwin> ${item.text}`);
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
  return lines.join('\n');
}

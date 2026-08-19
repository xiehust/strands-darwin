/**
 * Bounded human context for an interactively resumed session.
 *
 * This is a read-only derivative of trajectory replay: it opens one existing file,
 * reconstructs the last closed turn through the ordinary reducer, and returns only
 * display history. It imports no runtime, Agent, Model, session manager or writer, so
 * loading a recap cannot call a provider or participate in the conversation.
 */
import type { HistoryItem } from '../tui/turn-state.js';
import { describeDamage, readTrajectory } from './reader.js';
import type { TrajectoryRecord } from './record.js';
import { replayRecords } from './replay.js';

/** Bounds include the explicit omission marker. */
export const RESUME_RECAP_TEXT_CODE_POINTS = 600;
export const RESUME_RECAP_TEXT_LINES = 6;

export interface ResumeRecapOptions {
  /** Exact resolved session trajectory; path ownership stays in `agent/session.ts`. */
  file: string;
  /** Number read from the already-restored Agent; reported, never modified. */
  restoredMessages: number;
  /** False when this run cannot append future trajectory records. */
  trajectoryEnabled: boolean;
}

/**
 * Reads one exact session's record and projects its last completed turn.
 *
 * Every failure is returned as startup history rather than thrown: an absent record
 * is normal for sessions created before trajectory recording or while it was off.
 */
export async function loadResumeRecap(options: ResumeRecapOptions): Promise<HistoryItem[]> {
  try {
    const read = await readTrajectory(options.file);
    const damage = describeDamage(read);
    return projectResumeRecap(read.records, {
      restoredMessages: options.restoredMessages,
      trajectoryEnabled: options.trajectoryEnabled,
      ...(damage === undefined ? {} : { damage }),
    });
  } catch {
    // Missing/unreadable is the state the recap can know. Do not print a provider- or
    // filesystem-controlled error/path here: startup history has a strict row bound.
    return recapNotices(options, [
      notice(
        'resume recap unavailable: no readable trajectory record ' +
          '(normal for a pre-recording or trajectory-disabled session)',
        'warn',
        'missing',
      ),
    ]);
  }
}

interface ProjectionOptions {
  restoredMessages: number;
  trajectoryEnabled: boolean;
  damage?: string;
}

/** Pure half of {@link loadResumeRecap}, exported for focused offline verification. */
export function projectResumeRecap(
  records: readonly TrajectoryRecord[],
  options: ProjectionOptions,
): HistoryItem[] {
  let endedAt = -1;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index]?.type === 'turnEnded') {
      endedAt = index;
      break;
    }
  }

  if (endedAt === -1) {
    const limitations = [notice('resume recap unavailable: trajectory has no completed turn', 'warn', 'incomplete')];
    if (options.damage !== undefined) {
      limitations.push(notice(`resume recap source is damaged: ${options.damage}`, 'warn', 'damage'));
    }
    return recapNotices(options, limitations);
  }

  const ended = records[endedAt] as TrajectoryRecord;
  let startedAt = -1;
  for (let index = endedAt - 1; index >= 0; index -= 1) {
    const record = records[index] as TrajectoryRecord;
    if (record.type === 'runStarted' || record.type === 'turnEnded') break;
    if (record.type === 'userInput' && record.turn === ended.turn) {
      startedAt = index;
      break;
    }
  }

  if (startedAt === -1) {
    const limitations = [notice('resume recap unavailable: the last completed turn has no readable request', 'warn', 'request')];
    if (options.damage !== undefined) {
      limitations.push(notice(`resume recap source is damaged: ${options.damage}`, 'warn', 'damage'));
    }
    return recapNotices(options, limitations);
  }

  const selected = records.slice(startedAt, endedAt + 1);
  const replay = replayRecords(selected);
  const user = replay.history.find((item) => item.kind === 'user');
  const answer = replay.history
    .filter((item): item is Extract<HistoryItem, { kind: 'assistant' }> => item.kind === 'assistant')
    .map((item) => item.text)
    .filter((text) => text !== '')
    .join('\n');

  const history: HistoryItem[] = recapNotices(options, []);
  if (user === undefined) {
    history.push(notice('resume recap request is missing from the readable record', 'warn', 'request'));
  } else {
    history.push({ kind: 'user', id: 'resume-recap-user', text: boundRecapText(user.text) });
  }
  if (answer === '') {
    history.push(notice('resume recap answer is missing from the readable record', 'warn', 'answer'));
  } else {
    history.push({
      kind: 'assistant',
      id: 'resume-recap-assistant',
      text: boundRecapText(answer),
      part: 'whole',
      codeOpen: false,
    });
  }

  const truncations = selected.reduce((total, record) => total + (record.trunc?.length ?? 0), 0);
  const limitations: string[] = [];
  if (options.damage !== undefined) limitations.push(`source damage: ${options.damage}`);
  if (replay.droppedRecords > 0) limitations.push(`${replay.droppedRecords} capped/unreadable payload record(s) omitted`);
  if (truncations > 0) limitations.push(`${truncations} recorded field truncation(s)`);
  if (limitations.length > 0) {
    history.push(notice(`resume recap is partial: ${limitations.join('; ')}`, 'warn', 'partial'));
  }
  history.push(notice('earlier session transcript omitted', 'info', 'omitted'));
  return history;
}

function recapNotices(options: Pick<ProjectionOptions, 'restoredMessages' | 'trajectoryEnabled'>, tail: HistoryItem[]): HistoryItem[] {
  const history: HistoryItem[] = [
    notice(
      `resume recap · ${options.restoredMessages} restored model message(s) · read-only trajectory projection`,
      'info',
      'title',
    ),
  ];
  if (!options.trajectoryEnabled) {
    history.push(notice('trajectory recording is disabled for this run', 'warn', 'disabled'));
  }
  return [...history, ...tail];
}

/** Head projection with the omission marker inside both limits. */
export function boundRecapText(text: string): string {
  const sourceLines = text.split('\n');
  const sourcePoints = [...text];
  if (sourceLines.length <= RESUME_RECAP_TEXT_LINES && sourcePoints.length <= RESUME_RECAP_TEXT_CODE_POINTS) {
    return text;
  }

  let marker = recapTruncationMarker(sourcePoints.length, Math.max(0, sourceLines.length - 1));
  let kept = '';
  for (;;) {
    const budget = Math.max(0, RESUME_RECAP_TEXT_CODE_POINTS - [...marker].length - 1);
    kept = [...sourceLines.slice(0, RESUME_RECAP_TEXT_LINES - 1).join('\n')].slice(0, budget).join('');
    const keptLines = kept === '' ? 0 : kept.split('\n').length;
    const next = recapTruncationMarker(
      sourcePoints.length - [...kept].length,
      Math.max(0, sourceLines.length - keptLines),
    );
    if (next === marker) break;
    marker = next;
  }
  return kept === '' ? marker : `${kept}\n${marker}`;
}

function recapTruncationMarker(omittedPoints: number, omittedLines: number): string {
  const points = `${omittedPoints} code point${omittedPoints === 1 ? '' : 's'}`;
  const lines = omittedLines === 0 ? '' : ` and ${omittedLines} line${omittedLines === 1 ? '' : 's'}`;
  return `… resume recap truncated ${points}${lines}`;
}

function notice(text: string, severity: 'info' | 'warn', suffix: string): HistoryItem {
  return { kind: 'notice', id: `resume-recap-${suffix}`, text, severity };
}

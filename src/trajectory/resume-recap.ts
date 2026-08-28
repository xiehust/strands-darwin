/**
 * Full human transcript for an interactively resumed session.
 *
 * This is a read-only derivative of trajectory replay: it opens one existing file,
 * reconstructs the whole recorded transcript through the ordinary reducer
 * (`replayRecords`, the same projection `/export` and `trajectory replay` use), and
 * returns only display history. It imports no runtime, Agent, Model, session manager
 * or writer, so loading a recap cannot call a provider or participate in the
 * conversation.
 *
 * There is deliberately no size cap: measured on a 1.2 MiB / 2,801-record fixture,
 * `replayRecords` reconstructs the transcript in ~12 ms, and the seeded items are
 * written to terminal scrollback exactly once (`<Static>`), so startup scrollback
 * length simply equals session length. History item ids come from the same
 * process-local `nextId` counter the live session uses, so seeded and later live
 * rows can never collide; the recap's own notices use a distinct `resume-recap-`
 * namespace.
 */
import type { HistoryItem } from '../tui/turn-state.js';
import { describeDamage, readTrajectory } from './reader.js';
import type { TrajectoryRecord } from './record.js';
import { replayRecords } from './replay.js';

export interface ResumeRecapOptions {
  /** Exact resolved session trajectory; path ownership stays in `agent/session.ts`. */
  file: string;
  /** Number read from the already-restored Agent; reported, never modified. */
  restoredMessages: number;
  /** False when this run cannot append future trajectory records. */
  trajectoryEnabled: boolean;
}

/**
 * Reads one exact session's record and projects its full replayed transcript.
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
    // filesystem-controlled error/path here: the notice's shape must stay fixed.
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
  // One projection: the whole record through the same reducer the live TUI and
  // replay/export use. The recap adds notices around that history, never rows of
  // its own making.
  const replay = replayRecords(records);
  const history = recapNotices(options, []);

  if (replay.history.length === 0) {
    history.push(notice('resume recap: the trajectory contains no replayable transcript', 'warn', 'empty'));
  } else {
    history.push(...replay.history);
  }

  // Honest degradation, each as its own distinct notice after the transcript.
  if (options.damage !== undefined) {
    history.push(notice(`resume recap source is damaged: ${options.damage}`, 'warn', 'damage'));
  }
  if (replay.droppedRecords > 0) {
    history.push(
      notice(
        `resume recap replay omitted ${replay.droppedRecords} capped/unreadable payload record(s)`,
        'warn',
        'dropped',
      ),
    );
  }
  const truncations = records.reduce((total, record) => total + (record.trunc?.length ?? 0), 0);
  if (truncations > 0) {
    history.push(
      notice(`resume recap transcript contains ${truncations} recorded field truncation(s)`, 'warn', 'trunc'),
    );
  }
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

function notice(text: string, severity: 'info' | 'warn', suffix: string): HistoryItem {
  return { kind: 'notice', id: `resume-recap-${suffix}`, text, severity };
}

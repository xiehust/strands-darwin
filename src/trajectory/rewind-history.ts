/** Read-only human transcript for an SDK checkpoint branch, never model context. */
import { isRefusalStop } from '../agent/refusal.js';
import { readRewindCatalogue, type RewindCheckpoint } from '../agent/rewind.js';
import { isValidSessionId, trajectoryPath } from '../agent/session.js';
import { initialTurnState, turnReducer, type HistoryItem } from '../tui/turn-state.js';
import { describeDamage, readTrajectory } from './reader.js';
import { rewindOriginOf, type TrajectoryRecord } from './record.js';
import { replayRecords } from './replay.js';

/** Display boundaries must be recorded, never guessed from expanded/literal prompt text. */
export function rewindHistoryBoundary(records: readonly TrajectoryRecord[], checkpoint: RewindCheckpoint): number | undefined {
  if (checkpoint.trajectoryTurn === undefined) return undefined;
  const candidates = records.flatMap((record, index) =>
    record.type === 'userInput' && record.turn === checkpoint.trajectoryTurn ? [index] : []);
  if (candidates.length !== 1) return undefined;
  const index = candidates[0]!;
  const opening = records[index]!;
  // Require a closed eligible exchange in this run; a partial/damaged match is not a boundary.
  for (const record of records.slice(index + 1)) {
    if (record.type === 'userInput' || record.type === 'taskNotification' || record.type === 'runStarted') break;
    if (record.type === 'turnEnded' && record.turn === opening.turn) {
      return record.stopReason === 'endTurn' || (typeof record.stopReason === 'string' && isRefusalStop(record.stopReason)) ? index : undefined;
    }
  }
  return undefined;
}

export async function loadRewindHistory(
  projectRoot: string,
  sourceSessionId: string,
  checkpoint: RewindCheckpoint,
  visited: ReadonlySet<string> = new Set(),
): Promise<HistoryItem[]> {
  if (!isValidSessionId(sourceSessionId)) return unavailable('invalid source session');
  if (checkpoint.trajectoryTurn === undefined) return unavailable('this older checkpoint has no recorded transcript boundary');
  if (visited.has(sourceSessionId) || visited.size >= 32) return unavailable('cyclic or over-depth source lineage');
  const seen = new Set(visited).add(sourceSessionId);
  try {
    const read = await readTrajectory(trajectoryPath(projectRoot, sourceSessionId));
    const boundary = rewindHistoryBoundary(read.records, checkpoint);
    if (boundary === undefined) return unavailable('no unambiguous recorded prompt boundary');
    const prefix = read.records.slice(0, boundary);
    const inherited = await loadRewindOriginHistory(projectRoot, prefix, seen);
    const replay = replayRecords(prefix);
    const history = [...inherited, ...replay.history];
    const damage = describeDamage(read);
    if (damage !== undefined) history.push(...unavailable(`source is damaged: ${damage}`));
    if (replay.droppedRecords > 0) history.push(...unavailable(`${replay.droppedRecords} capped/unreadable payload record(s) omitted`));
    const truncations = prefix.reduce((count, record) => count + (record.trunc?.length ?? 0), 0);
    if (truncations > 0) history.push(...unavailable(`${truncations} recorded field truncation(s)`));
    return history;
  } catch {
    return unavailable('no readable source trajectory (recording may have been disabled)');
  }
}

/** Follow only rewind ancestry; fork trajectories already contain their copied prefix. */
export async function loadRewindOriginHistory(
  projectRoot: string,
  records: readonly TrajectoryRecord[],
  visited: ReadonlySet<string> = new Set(),
): Promise<HistoryItem[]> {
  const firstRun = records.find((record) => record.type === 'runStarted');
  const origin = rewindOriginOf(firstRun?.rewindFrom);
  if (origin === undefined) return [];
  if (!isValidSessionId(origin.session)) return unavailable('invalid source session');
  try {
    const catalogue = await readRewindCatalogue(projectRoot, origin.session);
    const checkpoint = catalogue.checkpoints.find((entry) => entry.snapshotId === origin.snapshotId);
    if (checkpoint === undefined) return unavailable('source checkpoint is missing or unreadable');
    return await loadRewindHistory(projectRoot, origin.session, checkpoint, visited);
  } catch {
    return unavailable('source checkpoint is missing or unreadable');
  }
}

function unavailable(reason: string): HistoryItem[] {
  return turnReducer(initialTurnState, { type: 'notice', severity: 'warn', text: `rewind history unavailable: ${reason}` }).history;
}

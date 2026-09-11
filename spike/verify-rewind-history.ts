/** Offline: exact rewind transcript prefix, lineage, degradation and Static reseeding. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appendRewindCheckpoint, type RewindCheckpoint } from '../src/agent/rewind.js';
import { trajectoryPath } from '../src/agent/session.js';
import type { TrajectoryRecord } from '../src/trajectory/record.js';
import { readTrajectory } from '../src/trajectory/reader.js';
import { historyWithoutIds, replayRecords } from '../src/trajectory/replay.js';
import { loadResumeRecap } from '../src/trajectory/resume-recap.js';
import { loadRewindHistory, rewindHistoryBoundary } from '../src/trajectory/rewind-history.js';
import { initialTurnState, turnReducer } from '../src/tui/turn-state.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const HOME = ownPrivateHome('rewind-history');
const ROOT = path.join(HOME, 'project');
const SOURCE = 'session-rewind-history';
const BRANCH = 'session-rewind-history-branch';
const stamp = '2026-09-11T00:00:00.000Z';
const checkpoint: RewindCheckpoint = { snapshotId: 'snap-two', prompt: 'expanded prompt', completedAt: stamp, trajectoryTurn: 2 };
let seq = 0;
function record(type: string, turn: number, fields: Record<string, unknown> = {}): TrajectoryRecord {
  return { v: 1, seq: seq++, t: stamp, type, turn, ...fields } as TrajectoryRecord;
}
function exchange(turn: number, prompt: string, answer: string): TrajectoryRecord[] {
  return [record('userInput', turn, { text: prompt }),
    record('contentBlockEvent', turn, { data: { contentBlock: { text: answer } } }),
    record('turnEnded', turn, { stopReason: 'endTurn', ms: 1, recorded: {}, dropped: {} })];
}
async function save(session: string, records: TrajectoryRecord[]): Promise<void> {
  const file = trajectoryPath(ROOT, session);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, records.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

header('rewind history — exact pre-prompt prefix and immutable sources');
const records = [record('runStarted', 0, { session: SOURCE }),
  ...exchange(1, 'first prompt', 'first answer'), ...exchange(2, '/literal', 'discarded answer'),
  ...exchange(3, 'later prompt', 'later answer')];
await save(SOURCE, records);
await appendRewindCheckpoint(ROOT, SOURCE, checkpoint);
const before = await readFile(trajectoryPath(ROOT, SOURCE));
const history = await loadRewindHistory(ROOT, SOURCE, checkpoint);
const expected = replayRecords(records.slice(0, 4)).history;
assert('expanded prompts use the exact recorded turn, not a text match',
  JSON.stringify(historyWithoutIds(history)) === JSON.stringify(historyWithoutIds(expected)) &&
  history.some((row) => row.kind === 'assistant' && row.text === 'first answer'));
assert('the selected and later turns are absent', !JSON.stringify(history).includes('discarded') && !JSON.stringify(history).includes('later'));
assert('first checkpoint produces an empty transcript', (await loadRewindHistory(ROOT, SOURCE, { ...checkpoint, trajectoryTurn: 1 })).length === 0);
assert('unmapped legacy boundaries are not guessed even for unique text', rewindHistoryBoundary(records, { snapshotId: 'old', prompt: '/literal', completedAt: stamp }) === undefined);
for (const prompt of ['first prompt', 'later prompt']) {
  assert(`legacy expansion colliding with ${prompt} cannot select another turn`,
    rewindHistoryBoundary(records, { snapshotId: 'old-expanded', prompt, completedAt: stamp }) === undefined);
}
const repeated = [...records, ...exchange(4, '/literal', 'repeated answer')];
assert('legacy repeated prompts are not guessed', rewindHistoryBoundary(repeated, { snapshotId: 'old', prompt: '/literal', completedAt: stamp }) === undefined);
assert('recorded turn disambiguates repeated prompts', rewindHistoryBoundary(repeated, checkpoint) === 4);
assert('ambiguous restarted turn numbering is not guessed', rewindHistoryBoundary([...records, ...exchange(2, '/literal', 'duplicate')], checkpoint) === undefined);
assert('incomplete turns are not guessed', rewindHistoryBoundary(records.slice(0, 5), checkpoint) === undefined);
const state = turnReducer({ ...initialTurnState, history: expected, liveText: 'discarded', toolDetailsExpanded: true }, { type: 'clear', history });
assert('branch reseeding remounts Static and clears live state while retaining detail preference',
  state.staticEpoch === 1 && state.liveText === '' && state.toolDetailsExpanded && state.history.length === history.length);
assert('/clear still starts empty', turnReducer(state, { type: 'clear' }).history.length === 0);
assert('source trajectory remains byte-identical', (await readFile(trajectoryPath(ROOT, SOURCE))).equals(before));

header('rewind history — repeated branches and resumed branch ancestry');
seq = 0;
const branchRecords = [record('runStarted', 0, { session: BRANCH, rewindFrom: { session: SOURCE, snapshotId: checkpoint.snapshotId } }),
  ...exchange(1, 'branch prompt', 'branch answer'), ...exchange(2, 'branch selected', 'branch discarded')];
await save(BRANCH, branchRecords);
const branched = await loadRewindHistory(ROOT, BRANCH, checkpoint);
assert('second rewind keeps ancestor prefix and only its own earlier turn',
  JSON.stringify(historyWithoutIds(branched)) === JSON.stringify(historyWithoutIds([...expected, ...replayRecords(branchRecords.slice(0, 4)).history])));
const resumed = await loadResumeRecap({ projectRoot: ROOT, file: trajectoryPath(ROOT, BRANCH), restoredMessages: 6, trajectoryEnabled: true });
assert('resume includes inherited history before all local branch turns',
  resumed.findIndex((row) => row.kind === 'assistant' && row.text === 'first answer') <
  resumed.findIndex((row) => row.kind === 'assistant' && row.text === 'branch answer') &&
  resumed.some((row) => row.kind === 'assistant' && row.text === 'branch discarded'));
assert('live rows do not collide with re-seeded replay ids', new Set([...branched, ...turnReducer(initialTurnState, { type: 'userInput', text: 'new' }).history].map((row) => row.id)).size === branched.length + 1);
assert('lineage traversal is bounded', JSON.stringify(await loadRewindHistory(ROOT, SOURCE, checkpoint, new Set([SOURCE]))).includes('cyclic'));
assert('path-like source ids are refused', JSON.stringify(await loadRewindHistory(ROOT, '../escape', checkpoint)).includes('invalid source'));
assert('missing recorded boundary is stated', JSON.stringify(await loadRewindHistory(ROOT, BRANCH, { ...checkpoint, trajectoryTurn: 999 })).includes('unavailable'));
const legacy = { snapshotId: 'legacy', prompt: 'first prompt', completedAt: stamp };
assert('old checkpoints explicitly explain the unavailable transcript', JSON.stringify(await loadRewindHistory(ROOT, SOURCE, legacy)).includes('older checkpoint'));
const notices = [...await loadRewindHistory(ROOT, SOURCE, legacy), ...await loadRewindHistory(ROOT, SOURCE, legacy)];
assert('repeated degradation notices have distinct Static ids', new Set(notices.map((row) => row.id)).size === notices.length);
assert('over-depth ancestors stop with a notice', JSON.stringify(await loadRewindHistory(ROOT, SOURCE, checkpoint, new Set(Array.from({ length: 32 }, (_, index) => `session-${index}`)))).includes('over-depth'));
assert('lineage reads leave source bytes unchanged', (await readFile(trajectoryPath(ROOT, SOURCE))).equals(before));

header('rewind history — disabled/missing/damaged records degrade visibly');
assert('missing recording is a notice, not a branch failure', JSON.stringify(await loadRewindHistory(ROOT, 'session-missing', checkpoint)).includes('no readable source trajectory'));
await writeFile(trajectoryPath(ROOT, SOURCE), Buffer.concat([before, Buffer.from('{broken')]));
const damaged = await loadRewindHistory(ROOT, SOURCE, checkpoint);
assert('damage keeps the valid prefix and states the loss', damaged.some((row) => row.kind === 'assistant' && row.text === 'first answer') && JSON.stringify(damaged).includes('source is damaged'));
assert('reader does not repair damage', (await readTrajectory(trajectoryPath(ROOT, SOURCE))).partialTrailingLine);
const refused = records.map((row) => row.type === 'turnEnded' && row.turn === 2 ? { ...row, stopReason: 'contentFiltered' } : row) as TrajectoryRecord[];
assert('refusal-class completed boundaries are displayable', rewindHistoryBoundary(refused, checkpoint) === 4);
const failed = records.map((row) => row.type === 'turnEnded' && row.turn === 2 ? { ...row, stopReason: 'cancelled' } : row) as TrajectoryRecord[];
assert('cancelled boundaries are refused', rewindHistoryBoundary(failed, checkpoint) === undefined);

seq = 0;
await save(BRANCH, [record('runStarted', 0, { session: BRANCH, rewindFrom: { session: SOURCE, snapshotId: 'missing-snapshot' } }), ...exchange(1, 'one', 'one'), ...exchange(2, 'two', 'two')]);
assert('missing ancestor catalogue row is stated without dropping local history', JSON.stringify(await loadRewindHistory(ROOT, BRANCH, checkpoint)).includes('source checkpoint is missing'));

report();

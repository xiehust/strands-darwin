/** Focused offline verification of the SER-028 full-replay resume transcript. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { trajectoryPath } from '../src/agent/session.js';
import { readTrajectory } from '../src/trajectory/reader.js';
import type { TrajectoryRecord } from '../src/trajectory/record.js';
import { historyWithoutIds, replayRecords } from '../src/trajectory/replay.js';
import { loadResumeRecap, projectResumeRecap } from '../src/trajectory/resume-recap.js';
import { initialTurnState, turnReducer } from '../src/tui/turn-state.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const HOME = ownPrivateHome('resume-recap');
const ROOT = path.join(HOME, 'project');
const SESSION = 'session-resume-recap';
let seq = 0;

function record(turn: number, type: string, fields: Record<string, unknown> = {}): TrajectoryRecord {
  seq += 1;
  return {
    v: 1,
    seq,
    t: new Date(1_700_000_000_000 + seq).toISOString(),
    turn,
    type,
    ...fields,
  } as TrajectoryRecord;
}

function turn(turn: number, request: string, answer: string): TrajectoryRecord[] {
  return [
    record(turn, 'userInput', { text: request }),
    record(turn, 'contentBlockEvent', { data: { contentBlock: { text: answer } } }),
    record(turn, 'turnEnded', { stopReason: 'endTurn', ms: 1, recorded: {}, dropped: {} }),
  ];
}

function runStarted(resumed: boolean, restoredMessages: number, pid: number): TrajectoryRecord {
  return record(0, 'runStarted', {
    session: SESSION,
    agentId: 'darwin',
    darwinVersion: 'test',
    provider: 'bedrock',
    model: 'fake.recap',
    permissionMode: 'default',
    thinkingEffort: 'high',
    resumed,
    restoredMessages,
    pid,
  });
}

function text(history: Awaited<ReturnType<typeof loadResumeRecap>>): string {
  return history.map((item) => {
    if (item.kind === 'tool') return `${item.summary}\n${item.preview}`;
    if (item.kind === 'plan') return item.plan.map((entry) => entry.item).join('\n');
    return item.text;
  }).join('\n');
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

header('resume recap — structural: an observer over the one replay projection');

const source = readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'trajectory', 'resume-recap.ts'),
  'utf8',
);
assert('resume-recap.ts imports nothing from the SDK — no model call by construction',
  !source.includes("'@strands-agents"));
assert('resume-recap.ts imports no runtime, Agent, session manager or writer',
  !/from '[^']*(agent\/|writer\.js)/.test(source));
assert('resume-recap.ts never writes — readTrajectory is its only file API',
  !/writeFile|appendFile|createWriteStream|truncate|\bunlink\b/.test(source) && source.includes('readTrajectory'));
assert('the transcript body is replayRecords through the ordinary reducer, never a second formatter',
  source.includes('replayRecords(records)'));
assert('the per-turn recap truncation is gone',
  !source.includes('boundRecapText') && !source.includes('RESUME_RECAP_TEXT') &&
  !source.includes('earlier session transcript omitted'));

header('resume recap — the full replayed transcript, across runs and open turns');

const toolUse = { name: 'bash', toolUseId: 'tool-recap-1', input: { command: 'ls' } };
const records = [
  runStarted(false, 0, 1),
  record(1, 'userInput', { text: 'oldest request' }),
  record(1, 'beforeToolCallEvent', { data: { toolUse } }),
  record(1, 'afterToolCallEvent', {
    data: { toolUse, result: { toolResult: { toolUseId: 'tool-recap-1', status: 'success', content: [{ text: 'tool output from the first run' }] } } },
  }),
  record(1, 'contentBlockEvent', { data: { contentBlock: { text: 'oldest answer' } } }),
  record(1, 'turnEnded', { stopReason: 'endTurn', ms: 1, recorded: {}, dropped: {} }),
  ...turn(2, 'older request', 'older answer'),
  record(0, 'shellCommand', { command: 'echo shell-history', exitCode: 0, signal: null, timedOut: false, durationMs: 3, output: 'shell-history' }),
  record(3, 'userInput', { text: 'unfinished request' }),
  runStarted(true, 2, 2),
  ...turn(1, 'last completed request', 'last completed answer'),
  record(2, 'userInput', { text: 'new unfinished request' }),
];
const projected = projectResumeRecap(records, { restoredMessages: 4, trajectoryEnabled: true });
const projectedText = text(projected);
assert('the title notice is the first row and reports the already-restored message count',
  projected[0]?.kind === 'notice' && projected[0].text.includes('4 restored model message(s)'));
assert('the body equals replayRecords over the same records — the one projection, ids aside',
  JSON.stringify(historyWithoutIds(projected.slice(1))) ===
    JSON.stringify(historyWithoutIds(replayRecords(records).history)));
assert('every turn of every run is present, oldest first',
  ['oldest request', 'oldest answer', 'older request', 'older answer', 'last completed request', 'last completed answer']
    .every((marker) => projectedText.includes(marker)) &&
  projectedText.indexOf('oldest request') < projectedText.indexOf('older request') &&
  projectedText.indexOf('older request') < projectedText.indexOf('last completed request'));
assert('tool rows from an earlier run replay too',
  projected.some((item) => item.kind === 'tool' && item.name === 'bash') &&
  projectedText.includes('tool output from the first run'));
assert('a recorded `!` shell command replays as its user and finished rows',
  projectedText.includes('!echo shell-history') && projectedText.includes('$ echo shell-history (exit 0'));
assert('open turns replay as the transcript the session actually showed',
  projectedText.includes('unfinished request') && projectedText.includes('new unfinished request'));
assert('the omission and truncation notices are gone',
  !projectedText.includes('earlier session transcript omitted') && !projectedText.includes('resume recap truncated'));
assert('a clean record earns no degradation notice',
  !projectedText.includes('damaged') && !projectedText.includes('payload record') && !projectedText.includes('field truncation'));
assert('every seeded history id is unique', new Set(projected.map((item) => item.id)).size === projected.length);
{
  // The seeded body shares the live session's process-local id counter, so a row the
  // live session appends later can never collide with a replayed one.
  const seeded = new Set(projected.map((item) => item.id));
  const live = turnReducer(initialTurnState, { type: 'userInput', text: 'after resume' });
  assert('a later live row gets an id no seeded row holds', !seeded.has(live.history[0]?.id ?? ''));
}

header('resume recap — long texts replay verbatim, unbounded');

const long = `${'🙂'.repeat(900)}\n${Array.from({ length: 12 }, (_, i) => `line-${i}`).join('\n')}`;
const unbounded = projectResumeRecap(turn(1, long, long), { restoredMessages: 2, trajectoryEnabled: true });
const user = unbounded.find((item) => item.kind === 'user');
assert('a long request replays byte-identical, with no marker', user?.text === long);
const answer = unbounded
  .filter((item): item is Extract<typeof unbounded[number], { kind: 'assistant' }> => item.kind === 'assistant')
  .map((item) => item.text)
  .join('\n');
assert('a long answer replays in full', answer.includes('🙂'.repeat(900)) && answer.includes('line-11'));
assert('no truncation marker is invented', !text(unbounded).includes('resume recap truncated'));

header('resume recap — honest degradation and tolerant reading');

const damagedProjection = projectResumeRecap(
  [
    ...turn(1, 'readable request', 'readable answer'),
    ...turn(2, 'request-two', 'answer-two').map((entry, index) =>
      index === 1 ? { ...entry, data: { dropped: 'record-too-large' }, trunc: [{ path: 'data', chars: 999, kept: 0 }] } : entry),
  ],
  { restoredMessages: 2, trajectoryEnabled: false, damage: 'skipped 1 unreadable line(s)' },
);
const damagedText = text(damagedProjection);
assert('disabled recording is stated without suppressing readable context',
  damagedText.includes('trajectory recording is disabled') && damagedText.includes('readable request'));
assert('reader damage, dropped payload and field truncation are distinct stated notices',
  damagedProjection.filter((item) => item.kind === 'notice' && (
    item.text.includes('source is damaged') ||
    item.text.includes('capped/unreadable payload record') ||
    item.text.includes('recorded field truncation')
  )).length === 3);
assert('a dropped payload never invents the answer it removed', !damagedText.includes('answer-two'));
assert('a record with no replayable transcript is an explicit normal projection',
  text(projectResumeRecap([runStarted(false, 0, 1)], { restoredMessages: 0, trajectoryEnabled: true }))
    .includes('no replayable transcript'));
assert('a record with only an open turn still shows what the session showed',
  text(projectResumeRecap([record(1, 'userInput', { text: 'open request' })], {
    restoredMessages: 1,
    trajectoryEnabled: true,
  })).includes('open request'));

header('resume recap — byte-zero loading of a real, mid-write file');

await rm(HOME, { recursive: true, force: true });
await mkdir(ROOT, { recursive: true });
const file = trajectoryPath(ROOT, SESSION);
await mkdir(path.dirname(file), { recursive: true });
const encoded = records.map((entry) => `${JSON.stringify(entry)}\n`).join('') + '{partial';
await writeFile(file, encoded, 'utf8');
const before = await readFile(file);
const loaded = await loadResumeRecap({
  file,
  restoredMessages: 4,
  trajectoryEnabled: true,
});
const after = await readFile(file);
assert('the existing tolerant reader states a partial trailing line', text(loaded).includes('partial trailing line'));
assert('loading is byte-zero against the trajectory', sha256(before) === sha256(after));
assert('the damaged file still yields the full transcript',
  ['oldest request', 'older answer', 'last completed request', 'last completed answer']
    .every((marker) => text(loaded).includes(marker)));
const read = await readTrajectory(file);
assert('the loader did not repair or append a record', read.partialTrailingLine && read.records.length === records.length);

const missing = await loadResumeRecap({
  file: trajectoryPath(ROOT, 'session-missing'),
  restoredMessages: 2,
  trajectoryEnabled: false,
});
const missingText = text(missing);
assert('missing/pre-recording trajectory is a normal explicit degradation',
  missingText.includes('no readable trajectory record') && missingText.includes('pre-recording or trajectory-disabled'));
assert('the current disabled state remains explicit too', missingText.includes('trajectory recording is disabled'));

report();

/** Focused offline verification of the SER-028 trajectory recap projection. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { trajectoryPath } from '../src/agent/session.js';
import { readTrajectory } from '../src/trajectory/reader.js';
import type { TrajectoryRecord } from '../src/trajectory/record.js';
import {
  boundRecapText,
  loadResumeRecap,
  projectResumeRecap,
  RESUME_RECAP_TEXT_CODE_POINTS,
  RESUME_RECAP_TEXT_LINES,
} from '../src/trajectory/resume-recap.js';
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

header('resume recap — exact last completed turn through replay');

const records = [
  record(0, 'runStarted', {
    session: SESSION,
    agentId: 'darwin',
    darwinVersion: 'test',
    provider: 'bedrock',
    model: 'fake.recap',
    permissionMode: 'default',
    thinkingEffort: 'high',
    resumed: false,
    restoredMessages: 0,
    pid: 1,
  }),
  ...turn(1, 'oldest request', 'oldest answer'),
  // Deliberately a greater ordinal than the later run's completed turn: recorder
  // ordinals restart per process, so selecting max(turn) would choose this wrong pair.
  ...turn(2, 'older request', 'older answer'),
  record(3, 'userInput', { text: 'unfinished request' }),
  record(0, 'runStarted', {
    session: SESSION,
    agentId: 'darwin',
    darwinVersion: 'test',
    provider: 'bedrock',
    model: 'fake.recap',
    permissionMode: 'default',
    thinkingEffort: 'high',
    resumed: true,
    restoredMessages: 2,
    pid: 2,
  }),
  ...turn(1, 'last completed request', 'last completed answer'),
  record(2, 'userInput', { text: 'new unfinished request' }),
];
const projected = projectResumeRecap(records, { restoredMessages: 4, trajectoryEnabled: true });
const projectedText = text(projected);
assert('the title reports the already-restored message count', projectedText.includes('4 restored model message(s)'));
assert('the last closed request and answer are selected',
  projectedText.includes('last completed request') && projectedText.includes('last completed answer'));
assert('an unfinished later request is not presented as completed context', !projectedText.includes('new unfinished request'));
assert('the prior run and its greater-ordinal closed turn are omitted',
  !projectedText.includes('oldest request') && !projectedText.includes('oldest answer') &&
  !projectedText.includes('older request') && !projectedText.includes('older answer'));
assert('the omission is explicit', projectedText.includes('earlier session transcript omitted'));

header('resume recap — bounds are measured in code points and lines');

const long = `${'🙂'.repeat(900)}\n${Array.from({ length: 12 }, (_, i) => `line-${i}`).join('\n')}`;
const bounded = boundRecapText(long);
assert('the code-point cap includes the marker', [...bounded].length <= RESUME_RECAP_TEXT_CODE_POINTS);
assert('the logical-line cap includes the marker', bounded.split('\n').length <= RESUME_RECAP_TEXT_LINES);
assert('the marker states the omission', bounded.includes('resume recap truncated'));
assert('Unicode is not split into replacement characters', !bounded.includes('�'));
const boundedProjection = projectResumeRecap(turn(1, long, long), {
  restoredMessages: 2,
  trajectoryEnabled: true,
});
const user = boundedProjection.find((item) => item.kind === 'user');
const assistant = boundedProjection.find((item) => item.kind === 'assistant');
assert('request and answer are bounded independently',
  user?.text.includes('resume recap truncated') === true && assistant?.text.includes('resume recap truncated') === true);

header('resume recap — honest degradation and tolerant reading');

const damagedProjection = projectResumeRecap(
  turn(1, 'request', 'answer').map((entry, index) =>
    index === 1 ? { ...entry, data: { dropped: 'record-too-large' }, trunc: [{ path: 'data', chars: 999, kept: 0 }] } : entry),
  { restoredMessages: 2, trajectoryEnabled: false, damage: 'skipped 1 unreadable line(s)' },
);
const damagedText = text(damagedProjection);
assert('disabled recording is stated without suppressing readable context',
  damagedText.includes('trajectory recording is disabled') && damagedText.includes('request'));
assert('reader damage, dropped payload and field truncation are all stated',
  damagedText.includes('source damage') && damagedText.includes('payload record') && damagedText.includes('field truncation'));
assert('a missing answer is not invented', damagedText.includes('answer is missing'));
assert('a record with no closed turn is an explicit normal projection',
  text(projectResumeRecap([record(1, 'userInput', { text: 'open' })], {
    restoredMessages: 1,
    trajectoryEnabled: true,
  })).includes('no completed turn'));

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
assert('the damaged file still yields the last completed context',
  text(loaded).includes('last completed request') && text(loaded).includes('last completed answer'));
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

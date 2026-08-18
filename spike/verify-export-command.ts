/**
 * `/export` — the current session's transcript, written from its own trajectory record.
 *
 * No terminal and no model: the command's whole logic lives in
 * `src/trajectory/export.ts`, driven here over real record fixtures in an owned HOME.
 * The properties with no single assertion are defended deliberately:
 *
 * - **Exporting changes nothing it read.** The record and the resume pointer are
 *   hashed before and after every outcome, including the successful one.
 * - **The body is `formatReplay`, byte for byte.** The written file below its header
 *   is compared against `formatReplay(replayRead(...))` of the same record — one
 *   projection, never a second formatter.
 * - **Absence is an answer.** Recording off, a record that does not exist yet, and a
 *   record with zero turns each earn a "nothing to export" notice and write no file.
 *
 * Run: pnpm tsx spike/verify-export-command.ts
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { sessionPaths, trajectoryPath } from '../src/agent/session.js';
import { BUILTIN_COMMAND_NAMES } from '../src/commands/custom-commands.js';
import { userDarwinDir } from '../src/paths.js';
import { EXPORT_USAGE, exportTranscript } from '../src/trajectory/export.js';
import { readTrajectory } from '../src/trajectory/reader.js';
import { formatReplay, replayRead } from '../src/trajectory/replay.js';
import { MAX_COMPLETIONS } from '../src/tui/InputBox.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

// Owned HOME before any path is derived: everything below resolves under
// `~/.darwin/sessions/<project-key>/`, and the suite must never touch the real one.
const OWNED_HOME = ownPrivateHome('export-command');
const ROOT = path.join(OWNED_HOME, 'project');
const SESSION = 'session-under-test';

let seq = 0;

function line(record: Record<string, unknown>): string {
  seq += 1;
  return `${JSON.stringify({ v: 1, seq, t: '2026-08-18T00:00:01.000Z', ...record })}\n`;
}

/** One full recorded turn, in the wire shapes the recorder actually writes. */
function recordedTurn(prompt: string, answer: string): string {
  return (
    line({ turn: 1, type: 'userInput', text: prompt }) +
    line({ turn: 1, type: 'contentBlockEvent', data: { contentBlock: { text: answer } } }) +
    line({ turn: 1, type: 'turnEnded', stopReason: 'endTurn', ms: 12, recorded: { contentBlockEvent: 1 }, dropped: {} })
  );
}

function runStarted(): string {
  return line({
    turn: 0,
    type: 'runStarted',
    session: SESSION,
    agentId: 'darwin',
    darwinVersion: '0.0.1-test',
    provider: 'bedrock',
    model: 'fake.export',
    permissionMode: 'default',
    thinkingEffort: undefined,
    resumed: false,
    restoredMessages: 0,
    pid: process.pid,
  });
}

async function seed(sessionId: string, lines: string): Promise<string> {
  const file = trajectoryPath(ROOT, sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, lines, 'utf8');
  return file;
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function main(): Promise<void> {
  header('/export — structural: no model, no second projection');
  {
    const source = readFileSync(
      path.join(import.meta.dirname, '..', 'src', 'trajectory', 'export.ts'),
      'utf8',
    );
    assert('export.ts imports nothing from the SDK — no model call by construction',
      !source.includes("'@strands-agents"));
    assert('export.ts never opens the record for writing (readTrajectory is the only reader)',
      !/appendFile|createWriteStream|truncate/.test(source) && source.includes('readTrajectory'));
    assert('the body is formatReplay, not a second formatter', source.includes('formatReplay(result)'));
    assert("the write refuses an existing target atomically (flag: 'wx')", source.includes("flag: 'wx'"));
    assert('export is a built-in command name', (BUILTIN_COMMAND_NAMES as readonly string[]).includes('export'));
    assert('the completion menu still fits every built-in', MAX_COMPLETIONS >= BUILTIN_COMMAND_NAMES.length);
  }

  header('/export — absence is an answer, never an error and never a file');
  {
    const usage = await exportTranscript({
      argument: '', projectRoot: ROOT, sessionId: SESSION, recordFile: trajectoryPath(ROOT, SESSION),
    });
    assert('a bare /export earns the usage notice', usage.text === EXPORT_USAGE && usage.severity === 'info');

    const off = await exportTranscript({
      argument: 'off.md', projectRoot: ROOT, sessionId: SESSION, recordFile: undefined,
    });
    assert('trajectory: false reads as nothing to export, stating why',
      off.text.includes('nothing to export') && off.text.includes('trajectory: false') && off.severity === 'info');
    assert('no file is written when recording is off', !existsSync(path.join(ROOT, 'off.md')));

    const absent = await exportTranscript({
      argument: 'absent.md', projectRoot: ROOT, sessionId: SESSION, recordFile: trajectoryPath(ROOT, SESSION),
    });
    assert('a session with no record file yet reads as nothing to export',
      absent.text.includes('nothing to export') && absent.text.includes('no recorded turns yet') && absent.severity === 'info');
    assert('no file is written when the record does not exist', !existsSync(path.join(ROOT, 'absent.md')));

    await seed('zero-turns', runStarted());
    const zero = await exportTranscript({
      argument: 'zero.md', projectRoot: ROOT, sessionId: 'zero-turns', recordFile: trajectoryPath(ROOT, 'zero-turns'),
    });
    assert('a record with zero turns reads as nothing to export',
      zero.text.includes('nothing to export') && zero.text.includes('no turns') && zero.severity === 'info');
    assert('no file is written for a zero-turn record', !existsSync(path.join(ROOT, 'zero.md')));
  }

  header('/export — the written transcript is the replay projection, byte for byte');
  {
    const record = await seed(SESSION, runStarted() + recordedTurn('hello darwin', 'hello you'));
    // A resume pointer, so "the export moves nothing" covers it too.
    const pointer = sessionPaths(ROOT).pointerFile;
    await writeFile(pointer, JSON.stringify({ sessionId: SESSION, updatedAt: '2026-08-18T00:00:02.000Z' }), 'utf8');
    const recordBefore = await sha256(record);
    const pointerBefore = await sha256(pointer);

    await mkdir(ROOT, { recursive: true });
    const outcome = await exportTranscript({
      argument: 'out.md',
      projectRoot: ROOT,
      sessionId: SESSION,
      recordFile: record,
      now: () => new Date('2026-08-18T12:00:00.000Z'),
    });
    const target = path.join(ROOT, 'out.md');
    assert('a relative path resolves against the project root', outcome.written === target);
    assert('the notice reports the write with the turn count',
      outcome.text.startsWith('exported 1 turn(s) to ') && outcome.text.includes(target) && outcome.severity === 'info');

    const written = await readFile(target, 'utf8');
    const separator = written.indexOf('\n\n');
    const fileHeader = written.slice(0, separator);
    const body = written.slice(separator + 2);
    assert('the header says it is a replay projection of the record',
      fileHeader.includes('replay projection of the trajectory record'));
    assert('the header names the session, the project and the record',
      fileHeader.includes(`# session: ${SESSION}`) && fileHeader.includes(`# project: ${ROOT}`) && fileHeader.includes(`# record: ${record}`));
    assert('the header carries the injected export time', fileHeader.includes('# exported: 2026-08-18T12:00:00.000Z'));

    const expected = formatReplay(replayRead(await readTrajectory(record)));
    assert('the body below the header is byte-identical to formatReplay of the same record',
      body === `${expected}\n`);
    assert('the transcript carries the prompt and the answer',
      body.includes('you> hello darwin') && body.includes('darwin> hello you'));

    assert('the record bytes are unchanged by the export', (await sha256(record)) === recordBefore);
    assert('the resume pointer is unchanged by the export', (await sha256(pointer)) === pointerBefore);

    // Overwrite refusal: the file just written is the existing target.
    const refused = await exportTranscript({
      argument: 'out.md', projectRoot: ROOT, sessionId: SESSION, recordFile: record,
    });
    assert('an existing target is refused, naming another-path as the way out',
      refused.severity === 'warn' && refused.text.includes('already exists') && refused.written === undefined);
    assert('the refused export left the existing file byte-identical',
      (await readFile(target, 'utf8')) === written);

    // An absolute target works and does not go through the project root.
    const absolute = path.join(OWNED_HOME, 'elsewhere.md');
    const absoluteOutcome = await exportTranscript({
      argument: absolute, projectRoot: ROOT, sessionId: SESSION, recordFile: record,
    });
    assert('an absolute path is written where it points', absoluteOutcome.written === absolute && existsSync(absolute));
  }

  header('/export — reading mid-turn tolerates the damage the reader already tolerates');
  {
    // A partial trailing line is exactly what a read-during-append can see.
    const damaged = await seed(
      'damaged',
      runStarted() + recordedTurn('prompt', 'answer') + '{"v":1,"seq":99,"t":"2026-08-18T00:00:09.000Z","turn":2,"type":"userInput","text":"half-writ',
    );
    const before = await sha256(damaged);
    const outcome = await exportTranscript({
      argument: 'damaged.md', projectRoot: ROOT, sessionId: 'damaged', recordFile: damaged,
    });
    assert('a partial trailing line does not stop an export', outcome.written === path.join(ROOT, 'damaged.md'));
    assert('the tolerated damage is stated, not hidden',
      outcome.text.includes('ignored 1 partial trailing line'));
    const written = await readFile(path.join(ROOT, 'damaged.md'), 'utf8');
    assert('the file header states the same damage',
      written.includes('# record damage tolerated: ignored 1 partial trailing line'));
    const expected = formatReplay(replayRead(await readTrajectory(damaged)));
    assert('the damaged-record body is still byte-identical to formatReplay',
      written.slice(written.indexOf('\n\n') + 2) === `${expected}\n`);
    assert('the damaged record was not repaired or rewritten', (await sha256(damaged)) === before);
  }

  header('/export — a bad target costs the export, never the session');
  {
    const record = trajectoryPath(ROOT, SESSION);

    const unwritable = await exportTranscript({
      argument: 'no-such-dir/out.md', projectRoot: ROOT, sessionId: SESSION, recordFile: record,
    });
    assert('an unwritable path degrades to one error notice, never a throw',
      unwritable.severity === 'error' && unwritable.text.startsWith('could not write ') && unwritable.written === undefined);

    const insideSessions = path.join(userDarwinDir(), 'sessions', 'anywhere', 'export.md');
    const guarded = await exportTranscript({
      argument: insideSessions, projectRoot: ROOT, sessionId: SESSION, recordFile: record,
    });
    assert('a target inside ~/.darwin/sessions/ is refused — the record directory is the recorder\u2019s',
      guarded.severity === 'warn' && guarded.text.includes('belongs to the session records') && !existsSync(insideSessions));
  }

  report();
}

await main();

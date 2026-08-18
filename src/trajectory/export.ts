/**
 * `/export <path>` — the current session's transcript, written to a file the user names.
 *
 * Everything here is a *reader* over the record the session is already writing:
 * the transcript body is `formatReplay` over `replayRead`, the same projection
 * `darwin trajectory replay` prints, so an export cannot drift from what a replay
 * of the same record would say. This module never opens the record for writing,
 * never touches the resume pointer, and — like the rest of `src/trajectory/` —
 * imports no `Agent`, no `Model` and nothing from Ink: no model call by
 * construction, not by discipline.
 *
 * Absence is an answer, on prompt recall's terms: recording switched off, a
 * session that has not closed a turn yet, and a record with zero turns each earn
 * a "nothing to export" notice — never an error, and never an empty file.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { userDarwinDir } from '../paths.js';
import { readTrajectory, TrajectoryMissingError } from './reader.js';
import { formatReplay, replayRead } from './replay.js';

export const EXPORT_USAGE =
  'usage: /export <path> — write this session\u2019s transcript to <path> (relative to the project root)';

export interface ExportOutcome {
  /** The one notice the command earns; multi-line for the usage shape. */
  text: string;
  /** `error` only for a failed write — every "nothing to export" reading is `info`. */
  severity: 'info' | 'warn' | 'error';
  /** Absolute path written; present only when a file exists afterwards. */
  written?: string;
}

export interface ExportRequest {
  /** Everything after `/export`, already trimmed. */
  argument: string;
  /** Relative targets resolve against this — the same root every other path uses. */
  projectRoot: string;
  sessionId: string;
  /**
   * The record this session is writing (`trajectoryStatus.file`), or `undefined`
   * when recording is off (`trajectory: false`).
   */
  recordFile: string | undefined;
  /** Injectable clock so the header's export time is assertable. */
  now?: () => Date;
}

/**
 * Reads the session's record and writes its transcript to the named file.
 *
 * Never throws: every outcome — including a target that already exists, which is
 * refused atomically via `wx` rather than checked first and raced — comes back as
 * the notice it earned. A failed write costs the export only, never the session.
 */
export async function exportTranscript(request: ExportRequest): Promise<ExportOutcome> {
  if (request.argument === '') {
    return { text: EXPORT_USAGE, severity: 'info' };
  }

  if (request.recordFile === undefined) {
    return {
      text: 'nothing to export — trajectory recording is off (trajectory: false), so this session has no record',
      severity: 'info',
    };
  }

  const target = path.resolve(request.projectRoot, request.argument);

  // The record directory is the recorder's, not an export target's: a transcript
  // written among the session records would look like a record to every reader
  // that scans that tree (`trajectory list`, prompt recall, fork).
  const sessionsRoot = path.join(userDarwinDir(), 'sessions');
  const relative = path.relative(sessionsRoot, target);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return {
      text: `refusing to write inside ${sessionsRoot} — that directory belongs to the session records; export somewhere else`,
      severity: 'warn',
    };
  }

  let read;
  try {
    read = await readTrajectory(request.recordFile);
  } catch (error) {
    if (error instanceof TrajectoryMissingError) {
      return {
        text: 'nothing to export — this session has no recorded turns yet (the record is written when a turn ends)',
        severity: 'info',
      };
    }
    // `readTrajectory` only throws `TrajectoryMissingError`; anything else is a
    // bug worth naming, but still costs the export and not the session.
    return {
      text: `could not read the trajectory record: ${error instanceof Error ? error.message : String(error)}`,
      severity: 'error',
    };
  }

  const result = replayRead(read);
  if (result.turns.length === 0) {
    return {
      text: 'nothing to export — the record contains no turns yet',
      severity: 'info',
    };
  }

  // A commented header carrying what the body cannot: which record this is a
  // projection of, and when. The body below the blank line is byte-identical to
  // `formatReplay` of the same record — the one-projection rule this file exists
  // under — so the header is the only place allowed to differ from a replay.
  const now = request.now ?? (() => new Date());
  const header = [
    '# darwin session transcript — a replay projection of the trajectory record',
    `# session: ${request.sessionId}`,
    `# project: ${request.projectRoot}`,
    `# record: ${request.recordFile}`,
    `# exported: ${now().toISOString()}`,
  ];
  if (result.damage !== undefined) header.push(`# record damage tolerated: ${result.damage}`);
  const content = `${header.join('\n')}\n\n${formatReplay(result)}\n`;

  try {
    // `wx`: fail if the target exists. The refusal is the filesystem's own answer,
    // so there is no window between a check and a write for a file to appear in.
    await writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      return {
        text: `${target} already exists — not overwritten; export to another path`,
        severity: 'warn',
      };
    }
    return {
      text: `could not write ${target}: ${error instanceof Error ? error.message : String(error)}`,
      severity: 'error',
    };
  }

  const lines = [
    `exported ${result.turns.length} turn(s) to ${target} (${Buffer.byteLength(content, 'utf8')} bytes)`,
  ];
  if (result.damage !== undefined) lines.push(`  record damage tolerated: ${result.damage}`);
  return { text: lines.join('\n'), severity: 'info', written: target };
}

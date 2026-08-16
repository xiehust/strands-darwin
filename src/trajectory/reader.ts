/**
 * Reading a trajectory file.
 *
 * The reader's whole job is to be tolerant *and* honest: an interrupted write
 * leaves a partial trailing line, and a run that appended after such an
 * interruption leaves that damage in the middle of the file. Both are skipped and
 * counted, never repaired — the record is append-only, so a reader that rewrote it
 * to "fix" a line would destroy the only evidence of what happened.
 */
import { readFile } from 'node:fs/promises';

import { parseRecordLine, type TrajectoryRecord } from './record.js';

export interface TrajectoryReadResult {
  /** Absolute path read. */
  file: string;
  records: TrajectoryRecord[];
  /** Bytes on disk at read time. */
  bytes: number;
  /** The final line lacked its terminating newline: an interrupted last write. */
  partialTrailingLine: boolean;
  /** Complete lines that did not parse as a record — earlier interrupted writes. */
  unreadableLines: number;
}

/** Raised only when the file itself is absent or unreadable; damage inside is not an error. */
export class TrajectoryMissingError extends Error {
  constructor(readonly file: string, readonly reason: string) {
    super(`No trajectory record at ${file}: ${reason}`);
    this.name = 'TrajectoryMissingError';
  }
}

export async function readTrajectory(file: string): Promise<TrajectoryReadResult> {
  let raw: string;
  let bytes: number;
  try {
    const buffer = await readFile(file);
    bytes = buffer.byteLength;
    raw = buffer.toString('utf8');
  } catch (error) {
    throw new TrajectoryMissingError(file, error instanceof Error ? error.message : String(error));
  }

  const records: TrajectoryRecord[] = [];
  let unreadableLines = 0;
  // A file that ends without a newline has an incomplete final line. Split first,
  // then treat that last element separately: it is expected damage, not a parse bug.
  const partialTrailingLine = raw !== '' && !raw.endsWith('\n');
  const lines = raw.split('\n');
  const complete = partialTrailingLine ? lines.slice(0, -1) : lines;

  for (const line of complete) {
    if (line.trim() === '') continue;
    const record = parseRecordLine(line);
    if (record === undefined) {
      unreadableLines += 1;
      continue;
    }
    records.push(record);
  }

  return { file, records, bytes, partialTrailingLine, unreadableLines };
}

/** One line naming any damage found, or `undefined` when the file was clean. */
export function describeDamage(result: TrajectoryReadResult): string | undefined {
  const parts: string[] = [];
  if (result.partialTrailingLine) parts.push('ignored 1 partial trailing line');
  if (result.unreadableLines > 0) parts.push(`skipped ${result.unreadableLines} unreadable line(s)`);
  return parts.length === 0 ? undefined : parts.join('; ');
}

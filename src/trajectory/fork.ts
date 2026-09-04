/**
 * Fork: a new session that starts where an existing one is, without touching it.
 *
 * A fork is a *byte copy*, not a replay. The SDK snapshot is the only authority for
 * what a resumed conversation contains, so the fork gets that snapshot verbatim and
 * darwin's own session machinery does the rest — nothing here constructs an `Agent`
 * or re-derives a conversation from records.
 *
 * What is copied, and what deliberately is not, is recorded in
 * `docs/architecture/load-bearing-decisions.md` § Session trajectory:
 *
 * - snapshot: copied verbatim, so the fork restores exactly the source conversation.
 * - `offload/`: copied when present, and a failure fails the whole fork — a fork
 *   whose history cites offload references it cannot resolve is worse than the disk
 *   a shared directory would have saved.
 * - `trajectory.jsonl`: copied as the fork's prefix, then one `forkedFrom` record is
 *   appended to the *fork*. Shared past, divergent future, still append-only.
 * - `background/`: not copied. Process control is not resumable across runs, so
 *   copying logs would imply control darwin cannot offer.
 * - `last-session.json`: never touched. A fork must not hijack `--resume`.
 */
import { access, appendFile, copyFile, cp, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  hasSnapshot,
  isValidSessionId,
  newSessionId,
  sessionDir,
  sessionStateDir,
  snapshotPath,
  trajectoryPath,
} from '../agent/session.js';
import { SCHEMA_VERSION, encodeRecord, parseRecordLine } from './record.js';

export interface ForkResult {
  sourceId: string;
  sessionId: string;
  /** Absolute paths copied, in copy order, for reporting. */
  copied: string[];
  /** True when the source had a trajectory record to carry over. */
  trajectoryCopied: boolean;
  /** Sequence number the fork's own records continue from. */
  continuedFromSeq: number;
}

/**
 * Copies `sourceId` into a fresh session id and returns what was done.
 *
 * Fails before creating anything when the source has no snapshot: a fork of a
 * session that cannot be restored would look like a working session and then start
 * empty, which is the failure mode `resolveSession`'s strict `--session` handling
 * exists to prevent.
 */
export async function forkSession(
  projectRoot: string,
  sourceId: string,
  agentId: string,
): Promise<ForkResult> {
  if (!isValidSessionId(sourceId)) {
    throw new Error(`Invalid session id ${JSON.stringify(sourceId)}.`);
  }
  if (!(await hasSnapshot(projectRoot, sourceId, agentId))) {
    throw new Error(
      `Session ${JSON.stringify(sourceId)} has no restorable snapshot in this project; nothing to fork.`,
    );
  }

  const sessionId = newSessionId();
  if (await exists(sessionDir(projectRoot, sessionId))) {
    // Ids are timestamp-unique to the millisecond, so this means a real collision
    // with an existing session rather than a race worth retrying silently.
    throw new Error(`Fork target ${JSON.stringify(sessionId)} already exists; try again.`);
  }

  const copied: string[] = [];

  const target = snapshotPath(projectRoot, sessionId, agentId);
  await mkdir(path.dirname(target), { recursive: true });
  // COPYFILE_EXCL: a fork must never overwrite an existing snapshot.
  await copyFile(snapshotPath(projectRoot, sourceId, agentId), target, 1);
  copied.push(target);

  const sourceOffload = path.join(sessionStateDir(projectRoot, sourceId), 'offload');
  if (await exists(sourceOffload)) {
    const targetOffload = path.join(sessionStateDir(projectRoot, sessionId), 'offload');
    await mkdir(path.dirname(targetOffload), { recursive: true });
    await cp(sourceOffload, targetOffload, { recursive: true, errorOnExist: true, force: false });
    copied.push(targetOffload);
  }

  const sourceTrajectory = trajectoryPath(projectRoot, sourceId);
  const targetTrajectory = trajectoryPath(projectRoot, sessionId);
  let trajectoryCopied = false;
  let continuedFromSeq = 0;

  if (await exists(sourceTrajectory)) {
    await mkdir(path.dirname(targetTrajectory), { recursive: true });
    await copyFile(sourceTrajectory, targetTrajectory, 1);
    copied.push(targetTrajectory);
    trajectoryCopied = true;

    const source = await readFile(sourceTrajectory, 'utf8');
    const lastSeq = lastRecordedSeq(source);
    continuedFromSeq = lastSeq + 1;
    const bytes = (await stat(sourceTrajectory)).size;
    // The marker goes on the fork, never on the source — and it is an append like
    // any other, including the newline guard for a source cut mid-write.
    const marker = encodeRecord({
      v: SCHEMA_VERSION,
      seq: continuedFromSeq,
      t: new Date().toISOString(),
      turn: 0,
      type: 'forkedFrom',
      session: sourceId,
      sourceSeq: lastSeq,
      bytes,
    });
    const guard = source === '' || source.endsWith('\n') ? '' : '\n';
    await appendFile(targetTrajectory, `${guard}${marker}`, 'utf8');
  }

  return { sourceId, sessionId, copied, trajectoryCopied, continuedFromSeq };
}

/** The last complete record's sequence number, or -1 when there is none. */
function lastRecordedSeq(content: string): number {
  const lines = content.split('\n');
  const endsClean = content.endsWith('\n');
  for (let index = endsClean ? lines.length - 1 : lines.length - 2; index >= 0; index -= 1) {
    const record = parseRecordLine(lines[index] ?? '');
    if (record !== undefined) return record.seq;
  }
  return -1;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

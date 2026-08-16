/**
 * Search over recorded trajectories.
 *
 * A bounded, case-insensitive substring match — deliberately not a regex: a
 * user-supplied pattern must not be able to backtrack catastrophically, and a
 * pattern needing shell quoting is a worse surface than one that does not.
 *
 * The honesty rules matter as much as the matching: a session with no record says
 * so, an unknown session says something different, and zero matches over a record
 * that really exists is a successful search, not a failure. Nothing here guesses.
 */
import { hasSnapshot, listSessionIds, trajectoryPath } from '../agent/session.js';
import { describeDamage, readTrajectory, TrajectoryMissingError, type TrajectoryReadResult } from './reader.js';
import { searchableText, type TrajectoryRecord } from './record.js';

/** Excerpt length around a hit, in code points. */
const EXCERPT_CHARS = 160;

export interface SearchHit {
  sessionId: string;
  seq: number;
  turn: number;
  type: string;
  at: string;
  /** One-line, bounded excerpt centred on the match. */
  excerpt: string;
}

export interface SessionSearchResult {
  sessionId: string;
  hits: SearchHit[];
  /** Records scanned in this session. */
  scanned: number;
  /** Damage the reader tolerated while scanning, ready to report. */
  damage: string | undefined;
}

export interface SearchOutcome {
  query: string;
  sessions: SessionSearchResult[];
  /** Sessions that have a snapshot but no trajectory file, named rather than counted. */
  withoutRecord: string[];
  hitCount: number;
  /** True when `--limit` cut the reported hits. */
  limited: boolean;
}

/** A session the caller named that darwin cannot find any state for at all. */
export class UnknownSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${JSON.stringify(sessionId)} does not exist in this project.`);
    this.name = 'UnknownSessionError';
  }
}

export interface SearchOptions {
  /** Restrict to one session; when absent every session in the project is scanned. */
  sessionId?: string;
  /** Restrict to one record type, e.g. `beforeToolCallEvent`. */
  type?: string;
  /** Maximum hits reported. */
  limit?: number;
}

export async function searchTrajectories(
  projectRoot: string,
  query: string,
  agentId: string,
  options: SearchOptions = {},
): Promise<SearchOutcome> {
  const needle = query.toLowerCase();
  const limit = options.limit ?? 50;

  const sessionIds =
    options.sessionId === undefined ? await listSessionIds(projectRoot) : [options.sessionId];

  // A named session that has neither a record nor a snapshot is a different answer
  // from one with no matches, and the caller is told which.
  if (options.sessionId !== undefined && sessionIds.length === 1) {
    const only = sessionIds[0] as string;
    const known = await hasSnapshot(projectRoot, only, agentId);
    let readable = true;
    try {
      await readTrajectory(trajectoryPath(projectRoot, only));
    } catch {
      readable = false;
    }
    if (!known && !readable) throw new UnknownSessionError(only);
  }

  const sessions: SessionSearchResult[] = [];
  const withoutRecord: string[] = [];
  let hitCount = 0;
  let limited = false;

  for (const sessionId of sessionIds) {
    let read: TrajectoryReadResult;
    try {
      read = await readTrajectory(trajectoryPath(projectRoot, sessionId));
    } catch (error) {
      if (error instanceof TrajectoryMissingError) {
        withoutRecord.push(sessionId);
        continue;
      }
      throw error;
    }

    const hits: SearchHit[] = [];
    for (const record of read.records) {
      if (options.type !== undefined && record.type !== options.type) continue;
      const excerpt = firstMatch(record, needle);
      if (excerpt === undefined) continue;
      if (hitCount >= limit) {
        limited = true;
        break;
      }
      hits.push({
        sessionId,
        seq: record.seq,
        turn: record.turn,
        type: record.type,
        at: record.t,
        excerpt,
      });
      hitCount += 1;
    }

    if (hits.length > 0 || read.records.length > 0) {
      const damage = describeDamage(read);
      sessions.push({
        sessionId,
        hits,
        scanned: read.records.length,
        ...(damage === undefined ? { damage: undefined } : { damage }),
      });
    }
    if (limited) break;
  }

  return { query, sessions, withoutRecord, hitCount, limited };
}

/**
 * The first matching field of a record, as a bounded one-line excerpt.
 *
 * Whitespace is collapsed *before* matching so the reported window and the match
 * are measured in the same string — finding the needle in the raw text and then
 * slicing the collapsed one silently reports an off-by-a-newline window.
 */
function firstMatch(record: TrajectoryRecord, needle: string): string | undefined {
  for (const text of searchableText(record)) {
    const collapsed = text.replace(/\s+/gu, ' ').trim();
    const index = collapsed.toLowerCase().indexOf(needle);
    if (index >= 0) return excerpt(collapsed, index, needle.length);
  }
  return undefined;
}

/**
 * A bounded window around the match.
 *
 * Code points, not UTF-16 units: a hit next to an emoji must not be reported with
 * half a surrogate pair — the same reason `headlessField` counts this way.
 */
function excerpt(collapsed: string, index: number, length: number): string {
  const points = [...collapsed];
  if (points.length <= EXCERPT_CHARS) return collapsed;

  // Centre the match, then clamp so a hit near either end still fills the window.
  const start = Math.min(
    Math.max(0, index - Math.floor((EXCERPT_CHARS - length) / 2)),
    Math.max(0, points.length - EXCERPT_CHARS),
  );
  const window = points.slice(start, start + EXCERPT_CHARS).join('');
  return `${start > 0 ? '…' : ''}${window}${start + EXCERPT_CHARS < points.length ? '…' : ''}`;
}

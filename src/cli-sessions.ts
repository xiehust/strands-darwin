/**
 * `darwin sessions` — listing this project's resumable conversations.
 *
 * A read-only projection over the per-project snapshot store
 * (`~/.darwin/sessions/<project-key>/`), following the `cli-trajectory.ts`
 * precedent: its own parser (an agent run and a store inspection share nothing but
 * the executable name), no model, no network, and — stricter than the trajectory
 * verbs — no writes of any kind. Listing sessions moves no pointer and rewrites no
 * file; the store is byte-identical before and after.
 *
 * Each row is one session that bare `--resume` or `--resume <id>` could actually
 * reopen: id, age (the snapshot's mtime — last activity, which also places a
 * hand-named `--session my-experiment` id correctly), and the first user prompt
 * where the trajectory recorded one. A session that ran with recording off reads
 * `(not recorded)` — absence is an answer, never an error (the prompt-recall rule).
 * Session directories with no restorable snapshot (a trajectory whose snapshot was
 * deleted, or a directory that predates recording) are skipped and the skip is
 * stated, because listing them as resumable would be a lie `--resume <id>` exposes.
 *
 * Exit codes follow the trajectory convention: 0 for a completed listing (including
 * an empty one), 2 for a usage error.
 */
import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  describeHolderLocation,
  inspectLease,
  isValidSessionId,
  listSessionIds,
  sessionPaths,
  readLastSessionId,
  snapshotPath,
  trajectoryPath,
  type SessionLeaseRecord,
} from './agent/session.js';
import { CliUsageError } from './cli-args.js';
import { readSessionLabel } from './agent/session-label.js';
import { readTrajectory } from './trajectory/reader.js';

/** Must match `AGENT_ID` in `src/agent/runtime.ts`: snapshots are keyed by it. */
const AGENT_ID = 'darwin';

export const SESSIONS_COMMAND = 'sessions';

export const SESSIONS_USAGE = `Usage: darwin ${SESSIONS_COMMAND}

  Lists this project's resumable sessions, newest first: id, age, the first
  recorded user prompt, and an optional display label. Reopen by id only with:

    darwin --resume <id>`;

/** Longest first-prompt excerpt shown on a row, in code points. */
export const MAX_PROMPT_PREVIEW_CHARS = 64;

/** True when argv asks for this subcommand at all, so `cli.ts` can route before anything else. */
export function isSessionsInvocation(argv: readonly string[]): boolean {
  return argv[0] === SESSIONS_COMMAND;
}

/** Parses argv *after* the `sessions` token. No I/O. */
export function parseSessionsArgs(argv: readonly string[]): void {
  if (argv.length > 0) {
    throw new CliUsageError(`${SESSIONS_COMMAND} takes no arguments.\n${SESSIONS_USAGE}`);
  }
}

export interface SessionsIo {
  projectRoot: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** One listed session, resolved without writing anything. */
export interface SessionRow {
  id: string;
  label: string | undefined;
  /** Snapshot mtime in epoch milliseconds. */
  activeAt: number;
  /** One-line first prompt, or `undefined` when no trajectory recorded one. */
  firstPrompt: string | undefined;
  /** Whether bare `--resume` would reopen this session right now. */
  isLast: boolean;
  /**
   * The live lease holder (SER-091), when another process has this session open right
   * now — read from `lease.json` and one signal-0 probe, never written. A stale or
   * absent lease is simply `undefined`: the row says only what `--resume <id>` would
   * actually run into.
   */
  openIn: SessionLeaseRecord | undefined;
}

export interface SessionsReadModel {
  rows: SessionRow[];
  skipped: number;
  /** Entries enumerated, including duplicates and non-session entries, in bounded mode. */
  inspected: number;
  scanCapped: boolean;
}

/** Bounded directory reads, not an unbounded readdir followed by slice. One overflow probe. */
async function inspectSessionIds(projectRoot: string, maxEntries: number) {
  const found = new Set<string>();
  let inspected = 0;
  const base = sessionPaths(projectRoot).sessionsDir;
  for (const directory of [path.join(base, 'session'), base]) {
    let handle;
    try {
      handle = await opendir(directory, { bufferSize: 1 });
      while (true) {
        const entry = await handle.read();
        if (entry === null) break;
        if (inspected === maxEntries) return { ids: [...found].sort().reverse(), inspected, scanCapped: true };
        inspected += 1;
        if (entry.isDirectory() && entry.name !== 'session' && isValidSessionId(entry.name)) found.add(entry.name);
      }
    } catch {
      // Match the CLI's absent/unreadable directory semantics; never repair.
    } finally {
      await handle?.close();
    }
  }
  return { ids: [...found].sort().reverse(), inspected, scanCapped: false };
}

/** Shared snapshot/trajectory/label/lease reads. No metadata writer in this closure. */
export async function readSessions(projectRoot: string, maxEntries?: number): Promise<SessionsReadModel> {
  const scan = maxEntries === undefined
    ? { ids: await listSessionIds(projectRoot), inspected: 0, scanCapped: false }
    : await inspectSessionIds(projectRoot, maxEntries);
  const lastSessionId = await readLastSessionId(projectRoot);

  const rows: SessionRow[] = [];
  let skipped = 0;
  for (const id of scan.ids) {
    let activeAt: number;
    try {
      // `stat` on the snapshot is both the existence check and the age source; a
      // directory whose snapshot is missing or unreadable lands here and is skipped.
      activeAt = (await stat(snapshotPath(projectRoot, id, AGENT_ID))).mtimeMs;
    } catch {
      skipped += 1;
      continue;
    }
    const lease = await inspectLease(projectRoot, id);
    rows.push({
      id,
      label: await readSessionLabel(projectRoot, id),
      activeAt,
      firstPrompt: await firstUserPrompt(projectRoot, id),
      isLast: id === lastSessionId,
      openIn: lease.kind === 'live' ? lease.record : undefined,
    });
  }

  // Newest first by *activity*, not by id: ids sort chronologically only because
  // darwin generates them that way, and a hand-named `--session my-experiment`
  // would otherwise sort alphabetically (the prompt-history ordering rule).
  rows.sort((a, b) => b.activeAt - a.activeAt);
  return { rows, skipped, inspected: scan.inspected, scanCapped: scan.scanCapped };
}

/** Runs the complete CLI listing and returns the process exit code. */
export async function runSessionsCommand(io: SessionsIo, now = Date.now()): Promise<number> {
  const { rows, skipped } = await readSessions(io.projectRoot);
  if (rows.length === 0) {
    io.out('no resumable sessions in this project\n');
  } else {
    const idWidth = Math.max(...rows.map((row) => row.id.length));
    const ageWidth = Math.max(...rows.map((row) => formatAge(now - row.activeAt).length));
    for (const row of rows) {
      const age = formatAge(now - row.activeAt).padStart(ageWidth);
      const prompt = row.firstPrompt === undefined ? '(not recorded)' : row.firstPrompt;
      const last = row.isLast ? '  (last)' : '';
      // `(open in pid N)` on this host; the holder's host is named when it is another.
      const open = row.openIn === undefined ? '' : `  (open ${describeHolderLocation(row.openIn)})`;
      const label = row.label === undefined ? '' : `  label: ${JSON.stringify(row.label)}`;
      io.out(`${row.id.padEnd(idWidth)}  ${age}  ${prompt}${last}${open}${label}\n`);
    }
    io.out(`\nresume one with: darwin --resume <id>\n`);
  }
  if (skipped > 0) {
    io.out(`${skipped} session(s) without a restorable snapshot not listed — darwin trajectory list shows them\n`);
  }
  return 0;
}

/**
 * The first prompt this session's trajectory recorded, as one bounded row cell.
 *
 * Read through the same `readTrajectory` reader `darwin trajectory list` already
 * uses per session — tolerant of damage, never repairing. A missing record, a
 * record with no `userInput` line, or one whose text is somehow empty all answer
 * `undefined`, which the row prints as `(not recorded)`.
 */
async function firstUserPrompt(projectRoot: string, sessionId: string): Promise<string | undefined> {
  let records;
  try {
    ({ records } = await readTrajectory(trajectoryPath(projectRoot, sessionId)));
  } catch {
    return undefined;
  }
  for (const record of records) {
    if (record.type !== 'userInput') continue;
    const line = record.text.replace(/\s+/g, ' ').trim();
    if (line === '') return undefined;
    const points = [...line];
    return points.length > MAX_PROMPT_PREVIEW_CHARS
      ? `${points.slice(0, MAX_PROMPT_PREVIEW_CHARS).join('')}…`
      : line;
  }
  return undefined;
}

/** `now - then` as a coarse human age: `just now`, `5m ago`, `3h ago`, `12d ago`. */
export function formatAge(elapsedMs: number): string {
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

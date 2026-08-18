/**
 * Prompt history, read out of the record that already exists.
 *
 * Darwin never had prompt history, and never needed a store for one: every prompt a
 * session sent is already a `userInput` line in
 * `~/.darwin/sessions/<project-key>/<session-id>/trajectory.jsonl`, which is
 * append-only, per project, and readable with no model call and no network. So this
 * module is a *reader* — it opens nothing else, writes nothing, and repairs nothing.
 * Everything it is allowed to say about damage it says by counting, exactly like
 * {@link readTrajectory}.
 *
 * Two properties are load-bearing and neither is obvious.
 *
 * **It reads tails, not files.** A trajectory may reach `MAX_FILE_BYTES` (64 MiB), and
 * the prompts a person wants back are the *last* ones written. Reading the whole file
 * to keep 100 strings would be I/O nobody asked for, so each record is read from its
 * end ({@link MAX_HISTORY_TAIL_BYTES}) and the first line of that window — which the
 * byte offset may have cut in half — is dropped and counted. That is the same
 * tolerate-and-report rule the reader already has for an interrupted write.
 *
 * **What it offers is what was *sent*.** The record's `text` is the string handed to
 * `agent.stream()`, so a skill or project command appears expanded (that is the
 * trajectory contract, not a choice made here). An expanded skill is a multi-kilobyte
 * document, and putting one back in the editor would be useless; entries past
 * {@link MAX_HISTORY_ENTRY_CHARS} are therefore skipped and counted. That cap sits
 * *below* the record's own field cap (`MAX_FIELD_CHARS`, 8000), which is the second
 * reason for it: a `userInput` text that was truncated on the way in must never be
 * offered back, because re-sending a silently shortened prompt is worse than being
 * offered nothing.
 *
 * Local commands (`/usage`, `/mode`, `/clear`, …) never reach `AgentRuntime.send` and
 * so were never recorded; empty submissions never reach it either. Neither needs
 * filtering here — history is what the session sent, and those were never sent.
 */
import { open, stat } from 'node:fs/promises';

import { listSessionIds, trajectoryPath } from '../agent/session.js';
import { parseRecordLine } from './record.js';

/** Prompts kept in memory, newest first, after consecutive duplicates are collapsed. */
export const MAX_HISTORY_ENTRIES = 100;

/**
 * Longest prompt offered back, in code points.
 *
 * Below the record's own `MAX_FIELD_CHARS` on purpose — see the module note. Also the
 * bound that keeps an expanded skill body out of the editor.
 */
export const MAX_HISTORY_ENTRY_CHARS = 4000;

/** Trajectory files opened by one read. */
export const MAX_HISTORY_SESSIONS = 20;

/**
 * Sessions whose record is stat-ed to order them before those files are chosen.
 *
 * Ordering by the record's own mtime rather than by session id is what keeps a
 * `--session my-experiment` run in its real place: ids sort chronologically only
 * because darwin generates them that way, and a named one sorts alphabetically.
 */
export const MAX_HISTORY_STAT_SESSIONS = 200;

/** Bytes read from the end of one record. */
export const MAX_HISTORY_TAIL_BYTES = 256 * 1024;

/** What one bounded reading of this project's prompts found. */
export interface PromptHistory {
  /** Newest first, consecutive duplicates collapsed, capped at {@link MAX_HISTORY_ENTRIES}. */
  readonly entries: readonly string[];
  /** Distinct prompts the reading collected, before the entry cap; see {@link entriesBounded}. */
  readonly available: number;
  /**
   * The per-record entry cap stopped this reading before the start of a record, so there
   * are lines it never looked at — `available` is what was *read*, not what exists.
   */
  readonly entriesBounded: boolean;
  /** Records whose tail was parsed. */
  readonly sessionsRead: number;
  /** Sessions with a record that a bound stopped this reading from opening. */
  readonly sessionsSkipped: number;
  /** Records longer than the tail bound, so older prompts in them were not reached. */
  readonly tailBounded: number;
  /** Prompts excluded by {@link MAX_HISTORY_ENTRY_CHARS}. */
  readonly longSkipped: number;
  /** A degradation — an unreadable session directory or record — never thrown. */
  readonly problem: string | undefined;
}

/** The reading a session starts from, and the one an empty project keeps. */
export const NO_PROMPT_HISTORY: PromptHistory = {
  entries: [],
  available: 0,
  entriesBounded: false,
  sessionsRead: 0,
  sessionsSkipped: 0,
  tailBounded: 0,
  longSkipped: 0,
  problem: undefined,
};

/** One prompt with the time it was observed, before ordering across sessions. */
interface HistoryCandidate {
  readonly text: string;
  readonly at: string;
}

/**
 * This project's prompts, newest first.
 *
 * Never rejects: a missing session directory, an unreadable record, a half-written
 * line and a project that has never run are all *readings*, not failures — the editor
 * has to stay usable while `trajectory: false` is in effect, and an editor that threw
 * on a keystroke because a file was absent would be a worse feature than no history.
 */
export async function readPromptHistory(projectRoot: string): Promise<PromptHistory> {
  let problem: string | undefined;
  let sessionIds: string[] = [];
  try {
    sessionIds = await listSessionIds(projectRoot);
  } catch (error) {
    // `listSessionIds` already swallows a missing directory; this is the belt to that
    // braces, so no reading can become an exception on the editor's path.
    return { ...NO_PROMPT_HISTORY, problem: describe(error) };
  }

  const statted = sessionIds.slice(0, MAX_HISTORY_STAT_SESSIONS);
  let sessionsSkipped = sessionIds.length - statted.length;

  const found: { file: string; mtimeMs: number; size: number }[] = [];
  await Promise.all(
    statted.map(async (sessionId) => {
      const file = trajectoryPath(projectRoot, sessionId);
      try {
        const info = await stat(file);
        if (info.isFile() && info.size > 0) found.push({ file, mtimeMs: info.mtimeMs, size: info.size });
      } catch {
        // No record for this session — the ordinary case for a session that started and
        // exited without a turn, and for every session of a run with `trajectory: false`.
      }
    }),
  );

  // Newest record first: the prompt a person wants back is almost always from the last
  // conversation they had here.
  found.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const chosen = found.slice(0, MAX_HISTORY_SESSIONS);
  sessionsSkipped += found.length - chosen.length;

  const candidates: HistoryCandidate[] = [];
  let sessionsRead = 0;
  let tailBounded = 0;
  let longSkipped = 0;
  let entriesBounded = false;

  for (const record of chosen) {
    let tail: { text: string; fromStart: boolean };
    try {
      tail = await readTail(record.file, record.size);
    } catch (error) {
      problem ??= describe(error);
      continue;
    }
    sessionsRead += 1;
    if (!tail.fromStart) tailBounded += 1;

    const lines = tail.text.split('\n');
    // A window that does not start at byte 0 begins mid-line — possibly mid-UTF-8
    // sequence. Dropped rather than parsed: `tailBounded` already says that older
    // prompts in this record were not reached.
    const usable = tail.fromStart ? lines : lines.slice(1);

    let fromThisRecord = 0;
    // Backwards: the newest prompts are at the end, and this is what bounds the work
    // per record to the entries actually kept rather than to the record's length.
    for (let index = usable.length - 1; index >= 0; index -= 1) {
      if (fromThisRecord >= MAX_HISTORY_ENTRIES) {
        // Older prompts are in this record and were deliberately not looked at. Said,
        // not silently implied: the reading's own counts would otherwise read as "this
        // is everything there is".
        entriesBounded = true;
        break;
      }
      const line = usable[index] as string;
      if (line.trim() === '') continue;
      const parsed = parseRecordLine(line);
      // Undefined is expected damage (an interrupted write), tolerated exactly as
      // `readTrajectory` tolerates it, and never repaired.
      if (parsed === undefined || parsed.type !== 'userInput') continue;
      const text = (parsed as { text?: unknown }).text;
      if (typeof text !== 'string') continue;
      const trimmed = text.trim();
      if (trimmed === '') continue;
      if (exceedsCodePoints(trimmed, MAX_HISTORY_ENTRY_CHARS)) {
        longSkipped += 1;
        continue;
      }
      candidates.push({ text: trimmed, at: typeof parsed.t === 'string' ? parsed.t : '' });
      fromThisRecord += 1;
    }
  }

  // Across records, order by the time the prompt was observed. `sort` is stable, so
  // records that share a timestamp (or carry none) keep the newest-first order the
  // backwards scan produced.
  candidates.sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0));

  const collapsed: string[] = [];
  for (const candidate of candidates) {
    // Consecutive duplicates collapse to one entry, so `Up` twice reaches the previous
    // *distinct* prompt — the Claude Code semantics, applied in recall order.
    if (collapsed[collapsed.length - 1] === candidate.text) continue;
    collapsed.push(candidate.text);
  }

  return {
    entries: collapsed.slice(0, MAX_HISTORY_ENTRIES),
    available: collapsed.length,
    entriesBounded,
    sessionsRead,
    sessionsSkipped,
    tailBounded,
    longSkipped,
    problem,
  };
}

/**
 * One line stating what a reading is not showing, or nothing when it is complete.
 *
 * Rides on the recall indicator the editor already draws — never a row of its own, for
 * the same reason the workspace-scan note rides on the completion menu's title
 * (`.trellis/spec/frontend/live-frame.md`).
 */
export function promptHistoryNote(history: PromptHistory): string | undefined {
  const parts: string[] = [];
  if (history.available > history.entries.length) {
    parts.push(`newest ${history.entries.length} of ${history.available}`);
  } else if (history.entriesBounded) {
    // "records", not "prompts": the scan stopped reading *lines* at the bound, and the
    // lines it did not look at may or may not have been prompts. The row must not claim
    // more than the reader knows.
    parts.push(`newest ${history.entries.length}, older records not read`);
  }
  if (history.sessionsSkipped > 0) parts.push(`${history.sessionsSkipped} session(s) not read`);
  if (history.tailBounded > 0) parts.push(`${history.tailBounded} record(s) read from the end only`);
  if (history.longSkipped > 0) parts.push(`${history.longSkipped} long prompt(s) skipped`);
  if (history.problem !== undefined) parts.push(`partial read: ${history.problem}`);
  return parts.length === 0 ? undefined : parts.join(', ');
}

/**
 * The last {@link MAX_HISTORY_TAIL_BYTES} of a file, as text.
 *
 * Opened read-only and closed on every path, including a failed read: an observer that
 * leaked a descriptor per keystroke would eventually take the session down with it.
 * `size` is the stat already taken, so the window is chosen without a second syscall.
 */
async function readTail(file: string, size: number): Promise<{ text: string; fromStart: boolean }> {
  const length = Math.min(size, MAX_HISTORY_TAIL_BYTES);
  const position = size - length;
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), fromStart: position === 0 };
  } finally {
    await handle.close();
  }
}

/**
 * Whether a string has more than `limit` code points — counted, and stopped at the
 * limit rather than measured in full.
 *
 * Code points, not UTF-16 units, for the same reason the record's own caps count that
 * way; early-exit because a record from another darwin's schema is not obliged to have
 * been capped at all, and spreading an arbitrarily long string to measure it would be
 * the one unbounded thing in a bounded reader.
 */
function exceedsCodePoints(value: string, limit: number): boolean {
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
    if (count > limit) return true;
  }
  return false;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

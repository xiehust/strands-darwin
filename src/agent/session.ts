/**
 * Session persistence and `--resume` support.
 *
 * Sessions live under `.strands-tui/` inside the project rather than in the home
 * directory. A coding agent's conversation is about one repository, so storing it
 * beside that repository keeps `--resume` naturally scoped per project, avoids
 * mapping a working directory onto a home-directory slug, and makes sessions easy
 * to inspect or delete. The cost is one `.gitignore` entry.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { SessionManager } from '@strands-agents/sdk';
import { LocalFileStorage } from '@strands-agents/sdk/storage';

export const STATE_DIRNAME = '.strands-tui';
const SESSIONS_DIRNAME = 'sessions';
const POINTER_FILENAME = 'last-session.json';

interface SessionPointer {
  sessionId: string;
  updatedAt: string;
}

export interface SessionPaths {
  /** Root of the tool's per-project state. */
  stateDir: string;
  /** Storage base directory handed to the SDK. */
  sessionsDir: string;
  /** File recording the most recent session id, so `--resume` can find it. */
  pointerFile: string;
}

export function sessionPaths(projectRoot: string): SessionPaths {
  const stateDir = path.join(projectRoot, STATE_DIRNAME);
  return {
    stateDir,
    sessionsDir: path.join(stateDir, SESSIONS_DIRNAME),
    pointerFile: path.join(stateDir, POINTER_FILENAME),
  };
}

/**
 * Readable and sortable, e.g. `session-20260813-091422`.
 *
 * The SDK validates session ids against lowercase letters, digits, hyphens and
 * underscores, so an ISO timestamp cannot be used verbatim — its `T` and `:`
 * are both rejected.
 */
function newSessionId(): string {
  const [date = '', time = ''] = new Date().toISOString().split('T');
  const compactDate = date.replace(/-/g, '');
  const compactTime = time.slice(0, 8).replace(/:/g, '');
  return `session-${compactDate}-${compactTime}`;
}

export interface ResolvedSession {
  sessionId: string;
  /** True when `--resume` found a previous session and we are continuing it. */
  resumed: boolean;
}

/**
 * Picks the session id for this run. With `resume`, reuses the last one; if there
 * is nothing to resume, starts fresh rather than failing — the user's intent
 * ("continue where I left off") is still satisfied by a new session.
 */
export async function resolveSession(projectRoot: string, resume: boolean): Promise<ResolvedSession> {
  const paths = sessionPaths(projectRoot);

  if (resume) {
    const previous = await readPointer(paths.pointerFile);
    if (previous !== undefined) {
      return { sessionId: previous, resumed: true };
    }
  }
  return { sessionId: newSessionId(), resumed: false };
}

async function readPointer(pointerFile: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(pointerFile, 'utf8');
  } catch {
    // No pointer yet, or unreadable: treated the same as "nothing to resume".
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SessionPointer>;
    return typeof parsed.sessionId === 'string' && parsed.sessionId !== '' ? parsed.sessionId : undefined;
  } catch {
    return undefined;
  }
}

/** Records `sessionId` as the session a later `--resume` should pick up. */
export async function writePointer(projectRoot: string, sessionId: string): Promise<void> {
  const paths = sessionPaths(projectRoot);
  await mkdir(paths.stateDir, { recursive: true });
  const pointer: SessionPointer = { sessionId, updatedAt: new Date().toISOString() };
  await writeFile(paths.pointerFile, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8');
}

/**
 * Builds the SDK session manager.
 *
 * `saveLatestOn: 'invocation'` (the default) snapshots after each turn finishes,
 * which is what `--resume` reads back. The snapshot is keyed by session id *and*
 * agent id, so the agent id must stay stable across runs for resume to find it.
 */
export function createSessionManager(projectRoot: string, sessionId: string): SessionManager {
  const paths = sessionPaths(projectRoot);
  return new SessionManager({
    sessionId,
    storage: new LocalFileStorage(paths.sessionsDir),
    saveLatestOn: 'invocation',
  });
}

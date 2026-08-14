/**
 * Session persistence and `--resume` support.
 *
 * Sessions live under `.darwin/` inside the project rather than in the home
 * directory. A coding agent's conversation is about one repository, so storing it
 * beside that repository keeps `--resume` naturally scoped per project, avoids
 * mapping a working directory onto a home-directory slug, and makes sessions easy
 * to inspect or delete. The cost is two `.gitignore` entries.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { SessionManager } from '@strands-agents/sdk';
import { LocalFileStorage } from '@strands-agents/sdk/storage';

import { darwinDir } from '../paths.js';

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
  const stateDir = darwinDir(projectRoot);
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
  const compactTime = time.replace(/[:.Z]/g, '');
  return `session-${compactDate}-${compactTime}`;
}

/** The three ways a caller can choose the conversation for this run. */
export type SessionSelector =
  | { kind: 'new' }
  | { kind: 'continue' }
  | { kind: 'id'; sessionId: string };

export interface ResolvedSession {
  sessionId: string;
  /** Whether the selector named a snapshot that should be restored. */
  restoreRequested: boolean;
}

/** Mirrors the SDK's accepted session-id alphabet. */
export function isValidSessionId(value: string): boolean {
  return /^[a-z0-9_-]+$/.test(value);
}

/**
 * Picks the session id for this run. `continue` retains the TUI's forgiving
 * behavior and starts fresh when there is no pointer. An explicit id is strict:
 * it means "continue this persisted conversation", so a typo must not silently
 * create a different empty session.
 */
export async function resolveSession(
  projectRoot: string,
  selector: SessionSelector,
  agentId: string,
): Promise<ResolvedSession> {
  const paths = sessionPaths(projectRoot);

  if (selector.kind === 'continue') {
    const previous = await readPointer(paths.pointerFile);
    if (previous !== undefined) {
      const exists = await snapshotExists(paths, previous, agentId);
      if (exists) return { sessionId: previous, restoreRequested: true };
    }
  }

  if (selector.kind === 'id') {
    if (!isValidSessionId(selector.sessionId)) {
      throw new Error(`Invalid session id ${JSON.stringify(selector.sessionId)}.`);
    }
    if (!(await snapshotExists(paths, selector.sessionId, agentId))) {
      throw new Error(`Session ${JSON.stringify(selector.sessionId)} does not exist in this project.`);
    }
    return { sessionId: selector.sessionId, restoreRequested: true };
  }

  return { sessionId: newSessionId(), restoreRequested: false };
}

async function snapshotExists(paths: SessionPaths, sessionId: string, agentId: string): Promise<boolean> {
  const snapshot = path.join(
    paths.sessionsDir,
    'session',
    sessionId,
    'scopes',
    'agent',
    agentId,
    'snapshots',
    'snapshot_latest.json',
  );
  try {
    await access(snapshot);
    return true;
  } catch {
    return false;
  }
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

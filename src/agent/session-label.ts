/** Display-only owner-state metadata. This read-only import closure never loads a writer or SDK. */
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { userProjectSessionsDir } from '../paths.js';
import { isValidSessionId } from './session-lease.js';

export const SESSION_LABEL_FILENAME = 'label.json';
export const MAX_SESSION_LABEL_POINTS = 80;
export const MAX_SESSION_LABEL_BYTES = 1024;
export const RENAME_USAGE = 'Usage: /rename <label> — a literal single-line label, at most 80 Unicode code points';

export function validateSessionLabel(raw: string): { label: string } | { problem: string } {
  // Check before trimming: exterior line breaks/controls are not a single-line label either.
  if (/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\p{Bidi_Control}]/u.test(raw)) {
    return { problem: 'Session label must be single-line and contain no control characters' };
  }
  const label = raw.trim();
  if (label === '') return { problem: RENAME_USAGE };
  let points = 0;
  for (const _point of label) {
    if (++points > MAX_SESSION_LABEL_POINTS) return { problem: 'Session label exceeds 80 Unicode code points' };
  }
  return { label };
}

/** Same state sibling as sessionStateDir; no dependency on session.ts's SDK/writer imports. */
export function sessionLabelPath(projectRoot: string, sessionId: string): string {
  if (!isValidSessionId(sessionId)) throw new Error('Session label state path refused');
  return path.join(userProjectSessionsDir(projectRoot), sessionId, SESSION_LABEL_FILENAME);
}

function owned(stat: Stats): boolean {
  return (process.getuid === undefined || stat.uid === process.getuid()) && (stat.mode & 0o022) === 0;
}

/** HOME may be machine-symlinked; no redirects or externally writable path components. */
export async function checkedLabelDirectory(directory: string): Promise<Stats> {
  const home = os.homedir();
  const relative = path.relative(home, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Session label state path refused');
  const homeStat = await stat(home);
  if (!homeStat.isDirectory() || !owned(homeStat)) throw new Error('Session label state path refused');
  let current = home;
  let result = homeStat;
  let exposed = (homeStat.mode & 0o011) !== 0;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    result = await lstat(current);
    if (!result.isDirectory() || (process.getuid !== undefined && result.uid !== process.getuid()) ||
        (exposed && (result.mode & 0o022) !== 0)) throw new Error('Session label state path refused');
    // A private ancestor shields ordinary umask-created session directories.
    exposed &&= (result.mode & 0o011) !== 0;
  }
  if (await realpath(directory) !== path.join(await realpath(home), relative)) {
    throw new Error('Session label state path refused');
  }
  return result;
}

export function isSafeLabelFile(stat: Stats): boolean {
  return stat.isFile() && stat.nlink === 1 && owned(stat) && stat.size <= MAX_SESSION_LABEL_BYTES;
}

/** Absence is allowed; an existing unsafe target must never be overwritten. */
export async function checkedLabelFile(file: string): Promise<Stats | undefined> {
  try {
    const result = await lstat(file);
    if (!isSafeLabelFile(result)) throw new Error('Session label state file refused');
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function readSessionLabel(projectRoot: string, sessionId: string): Promise<string | undefined> {
  let handle;
  try {
    const file = sessionLabelPath(projectRoot, sessionId);
    await checkedLabelDirectory(path.dirname(file));
    if (await checkedLabelFile(file) === undefined) return undefined;
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!isSafeLabelFile(await handle.stat())) return undefined;
    const bytes = Buffer.alloc(MAX_SESSION_LABEL_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_SESSION_LABEL_BYTES) return undefined;
    await checkedLabelDirectory(path.dirname(file));
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record['version'] !== 1 || typeof record['label'] !== 'string' ||
        Object.keys(record).length !== 2) return undefined;
    const parsed = validateSessionLabel(record['label']);
    return 'label' in parsed && parsed.label === record['label'] ? parsed.label : undefined;
  } catch {
    // Absent, malformed, unreadable or unsafe: never repair from an observer.
    return undefined;
  } finally {
    await handle?.close();
  }
}

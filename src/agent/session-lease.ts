/** SDK-free lease facts shared by ownership and read-only inventory. */
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const LEASE_FILENAME = 'lease.json';
export const FOREIGN_LEASE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface SessionLeaseRecord {
  pid: number;
  hostname: string;
  /** ISO-8601, the moment the lease was written. */
  startedAt: string;
}

export type LeaseStatus =
  | { kind: 'none' }
  | { kind: 'live'; record: SessionLeaseRecord }
  | { kind: 'stale'; record: SessionLeaseRecord | undefined };

export interface LeaseEnvironment {
  hostname: string;
  /** Epoch milliseconds. */
  now: number;
  pidAlive: (pid: number) => boolean;
}

/** Same host: PID probe (EPERM is alive). Foreign host: live for 24 hours. */
export function classifyLease(record: SessionLeaseRecord | undefined, environment: LeaseEnvironment): LeaseStatus {
  if (record === undefined) return { kind: 'stale', record: undefined };
  if (record.hostname === environment.hostname) {
    return environment.pidAlive(record.pid) ? { kind: 'live', record } : { kind: 'stale', record };
  }
  const started = Date.parse(record.startedAt);
  if (Number.isNaN(started) || environment.now - started >= FOREIGN_LEASE_STALE_AFTER_MS) {
    return { kind: 'stale', record };
  }
  return { kind: 'live', record };
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'EPERM';
  }
}

export function defaultLeaseEnvironment(): LeaseEnvironment {
  return { hostname: os.hostname(), now: Date.now(), pidAlive };
}

/** The state directory, never the SDK's snapshot directory. */
export function leaseFileIn(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, sessionId, LEASE_FILENAME);
}

/** Mirrors the SDK's accepted session-id alphabet. */
export function isValidSessionId(value: string): boolean {
  return /^[a-z0-9_-]+$/.test(value);
}

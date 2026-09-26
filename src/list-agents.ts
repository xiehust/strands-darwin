/** Bounded, read-only inventory of this HOME's same-host session lease holders. */
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { classifyLease, defaultLeaseEnvironment, isValidSessionId, leaseFileIn, type SessionLeaseRecord } from './agent/session-lease.js';
import { projectKey, userDarwinDir, userSessionsDir } from './paths.js';

export const MAX_AGENT_PROJECT_ENTRIES = 128;
export const MAX_AGENT_SESSION_ENTRIES = 2048;
export const MAX_AGENT_ROWS = 32;
export const MAX_AGENT_LEASE_BYTES = 4096;
export const MAX_AGENT_CELL_CHARS = 255;

export interface LocalAgentRow extends SessionLeaseRecord {
  projectKey: string;
  sessionId: string;
  current: boolean;
}

export interface LocalAgentInventory {
  rows: LocalAgentRow[];
  omissions: Record<string, number>;
  limits: string[];
  state: 'readable' | 'missing' | 'unavailable';
}

function omit(inventory: LocalAgentInventory, reason: string): void {
  inventory.omissions[reason] = (inventory.omissions[reason] ?? 0) + 1;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function owned(uid: number): boolean {
  return process.getuid === undefined || uid === process.getuid();
}

/** Reject links at every traversed level, including .darwin and sessions. */
async function safeDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || !owned(info.uid) || await realpath(directory) !== directory) {
    throw new Error('unsafe directory');
  }
}

interface ScanBudget { used: number; max: number; label: string; stopped: boolean }

/** A known identity gets one ordinary budget slot, then is skipped in enumeration. */
async function* entries(
  directory: string,
  budget: ScanBudget,
  inventory: LocalAgentInventory,
  first?: string,
): AsyncGenerator<string> {
  try {
    await safeDirectory(directory);
    const dir = await opendir(directory, { bufferSize: 1 });
    try {
      // Called only for the current project and its current session, before either
      // shared budget can be exhausted. Missing/unsafe identities still cost a slot.
      if (first !== undefined) {
        budget.used += 1;
        yield first;
      }
      for (;;) {
        const entry = await dir.read();
        if (entry === null) break;
        if (entry.name === first) continue;
        if (budget.used === budget.max) {
          budget.stopped = true;
          inventory.limits.push(`${budget.label} scan limit ${budget.max} reached; remaining entries not inspected (count unknown)`);
          break;
        }
        budget.used += 1;
        yield entry.name;
      }
    } finally {
      await dir.close();
    }
  } catch (error) {
    if (directory === userSessionsDir()) {
      inventory.state = errorCode(error) === 'ENOENT' ? 'missing' : 'unavailable';
    } else {
      omit(inventory, 'unreadable, missing or unsafe directories');
    }
  }
}

async function readHolder(file: string, inventory: LocalAgentInventory): Promise<SessionLeaseRecord | undefined> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || !owned(info.uid)) {
      omit(inventory, 'unsafe lease files');
      return undefined;
    }
    if (info.size > MAX_AGENT_LEASE_BYTES) {
      omit(inventory, 'oversized leases');
      return undefined;
    }
    // NOFOLLOW refuses a final-component link; NONBLOCK avoids hanging on a
    // raced FIFO. fstat verifies the opened object before any bytes are read.
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let raw: string;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !owned(opened.uid) || opened.dev !== info.dev || opened.ino !== info.ino) {
        omit(inventory, 'unsafe lease files');
        return undefined;
      }
      const buffer = Buffer.alloc(MAX_AGENT_LEASE_BYTES + 1);
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
        if (bytesRead === 0) break;
        used += bytesRead;
      }
      if (used > MAX_AGENT_LEASE_BYTES) {
        omit(inventory, 'oversized leases');
        return undefined;
      }
      raw = buffer.subarray(0, used).toString('utf8');
    } finally {
      await handle.close();
    }
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value !== 'object' || value === null) throw new Error('record');
      const { pid, hostname, startedAt } = value as Record<string, unknown>;
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647
        || typeof hostname !== 'string' || !hostname || hostname.length > MAX_AGENT_CELL_CHARS
        || typeof startedAt !== 'string' || !startedAt || startedAt.length > MAX_AGENT_CELL_CHARS
        || !Number.isFinite(Date.parse(startedAt))) throw new Error('fields');
      return { pid, hostname, startedAt };
    } catch {
      omit(inventory, 'malformed leases (including invalid PIDs)');
    }
  } catch (error) {
    omit(inventory, errorCode(error) === 'ENOENT' ? 'missing leases' : 'unreadable or unsafe lease files');
  }
  return undefined;
}

/** One bounded observation, not a registry, poller, or authenticated process list. */
export async function readLocalAgents(projectRoot: string, currentSessionId?: string): Promise<LocalAgentInventory> {
  const inventory: LocalAgentInventory = { rows: [], omissions: {}, limits: [], state: 'readable' };
  try {
    await safeDirectory(userDarwinDir());
  } catch (error) {
    inventory.state = errorCode(error) === 'ENOENT' ? 'missing' : 'unavailable';
    return inventory;
  }
  const environment = defaultLeaseEnvironment();
  const projects: ScanBudget = { used: 0, max: MAX_AGENT_PROJECT_ENTRIES, label: 'project-entry', stopped: false };
  const sessions: ScanBudget = { used: 0, max: MAX_AGENT_SESSION_ENTRIES, label: 'session-entry', stopped: false };
  const currentProjectKey = projectKey(projectRoot);
  for await (const projectKey of entries(userSessionsDir(), projects, inventory, currentProjectKey)) {
    // projectKey()'s readable prefix and digest, not a reversible cwd encoding.
    if (!/^[a-zA-Z0-9_-]{1,180}--[a-f0-9]{64}$/.test(projectKey)) {
      omit(inventory, 'invalid project keys');
      continue;
    }
    const projectDir = path.join(userSessionsDir(), projectKey);
    const firstSession = projectKey === currentProjectKey ? currentSessionId : undefined;
    for await (const sessionId of entries(projectDir, sessions, inventory, firstSession)) {
      // Never read the resume pointer or descend into the SDK snapshot tree.
      // `session` is also a legal explicit session id: inspect only its lease.
      if (sessionId === 'last-session.json') continue;
      if (sessionId.length > MAX_AGENT_CELL_CHARS || !isValidSessionId(sessionId)) {
        omit(inventory, 'invalid session entries');
        continue;
      }
      try {
        await safeDirectory(path.join(projectDir, sessionId));
      } catch {
        omit(inventory, 'unreadable, missing or unsafe directories');
        continue;
      }
      const record = await readHolder(leaseFileIn(projectDir, sessionId), inventory);
      if (record === undefined) continue;
      if (record.hostname !== environment.hostname) {
        omit(inventory, 'foreign-host leases');
      } else if (classifyLease(record, environment).kind !== 'live') {
        omit(inventory, 'dead leases');
      } else if (inventory.rows.length === MAX_AGENT_ROWS) {
        omit(inventory, `live holders beyond row limit ${MAX_AGENT_ROWS}`);
      } else {
        inventory.rows.push({ ...record, projectKey, sessionId, current: record.pid === process.pid });
      }
    }
    if (sessions.stopped) {
      inventory.limits.push('remaining projects not inspected (count unknown)');
      break;
    }
  }
  inventory.rows.sort((a, b) => a.projectKey.localeCompare(b.projectKey) || a.sessionId.localeCompare(b.sessionId));
  return inventory;
}

/** ASCII cells cannot emit terminal controls, bidi controls or extra rows. */
function cell(value: string): string {
  const safe = value.replace(/[^\x20-\x7e]/g, '?');
  return safe.length <= MAX_AGENT_CELL_CHARS ? safe : `${safe.slice(0, MAX_AGENT_CELL_CHARS - 3)}...`;
}

/** Shared CLI/TUI projection; a single transcript notice, never a live frame row. */
export function formatLocalAgents(inventory: LocalAgentInventory): string {
  const lines = [
    'local session lease holders — this HOME, current user, same host only',
    'source: ~/.darwin/sessions/<project-key>/<session-id>/lease.json (read-only)',
    'inspection: current project first; current TUI session first when supplied; remaining entries in filesystem order (same budgets)',
  ];
  if (inventory.state === 'missing') lines.push('session inventory missing; no existing session store found');
  else if (inventory.state === 'unavailable') lines.push('session inventory unavailable: unreadable or unsafe session store');
  else if (inventory.rows.length === 0) lines.push('no live same-host session lease holders found in inspected entries');
  else {
    lines.push('PID | SESSION ID | PROJECT KEY (not cwd) | startedAt | CURRENT PROCESS');
    for (const row of inventory.rows) {
      lines.push(`${row.pid} | ${cell(row.sessionId)} | ${cell(row.projectKey)} | ${cell(row.startedAt)} | ${row.current ? '(current process)' : '-'}`);
    }
  }
  for (const [reason, count] of Object.entries(inventory.omissions)) lines.push(`omitted: ${count} ${reason}`);
  lines.push(...inventory.limits.map(limit => `omitted: ${limit}`));
  lines.push(
    `bounds: ${MAX_AGENT_PROJECT_ENTRIES} project entries, ${MAX_AGENT_SESSION_ENTRIES} session entries, ${MAX_AGENT_LEASE_BYTES} bytes/lease (+1 overflow probe), ${MAX_AGENT_ROWS} rows`,
    'not tracked: older/non-registering processes, other users/HOMEs/hosts, ordinary OS children, in-process SDK subagents',
    'PID liveness is not authenticated process identity; entries may change during or after this scan.',
    'Listing does not enable communication. /agents lists subagent dispatches; darwin sessions lists resumable snapshots in this project.',
  );
  return lines.join('\n');
}

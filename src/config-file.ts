import { constants } from 'node:fs';
import { lstat, open, rename, unlink, link } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeDirectory, withStateLock } from './agentcore/state.js';

export const MAX_CONFIG_BYTES = 1048576;

export async function readConfigBytes(file: string): Promise<string | undefined> {
  if (!await safeDirectory(path.dirname(file))) return undefined;
  let handle;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) throw new Error('Config path/size refused');
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CONFIG_BYTES) throw new Error('Config exceeds 1 MiB');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  finally { await handle?.close(); }
}

/** Shared by writers and the final auto validation + synchronous handler invocation.
 * Return a boxed pending response from launch callbacks; never await network here. */
export function withConfigLock<T>(file: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withStateLock(path.join(path.dirname(file), 'config-write-lock'), action, signal);
}

/** All config writers share this fail-fast cross-process lock, including model/effort.
 * Unknown unrelated fields survive byte-content merge; external noncooperating edits
 * detected before publication refuse rather than overwrite. Crash locks need inspection. */
export async function updateConfigFile<T>(file: string, change: (record: Record<string, unknown>, existed: boolean) => T, signal?: AbortSignal): Promise<T> {
  return withConfigLock(file, async () => {
    const original = await readConfigBytes(file);
    const value: unknown = original?.trim() ? JSON.parse(original) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Config must contain an object');
    const record = value as Record<string, unknown>;
    const result = change(record, original !== undefined);
    const bytes = `${JSON.stringify(record, null, 2)}\n`;
    if (Buffer.byteLength(bytes) > MAX_CONFIG_BYTES) throw new Error('Config exceeds 1 MiB');
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      if (await readConfigBytes(file) !== original) throw new Error('Config changed during write; retry command');
      signal?.throwIfAborted();
      if (original === undefined) await link(temporary, file); else await rename(temporary, file);
      const directory = await open(path.dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return result;
    } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
  }, signal);
}

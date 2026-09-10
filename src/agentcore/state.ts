import { link, lstat, mkdir, open, opendir, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { userDarwinDir, userProjectDir } from '../paths.js';
import { digest, type AgentCoreConfig } from './config.js';

type StateBoundary = 'after-read' | 'before-publish' | 'after-publish';
let stateObserverForTest: ((file: string, boundary: StateBoundary) => Promise<void>) | undefined;
/** Offline scheduling seam only: real filesystem I/O still runs, never replaces its result. */
export function setCloudStateObserverForTest(observer: typeof stateObserverForTest): void { stateObserverForTest = observer; }

export function cloudDirectory(config: AgentCoreConfig, root?: string): string {
  return path.join(root === undefined ? userDarwinDir() : userProjectDir(root), 'agentcore', digest([config.region, config.memoryId, config.actorId]));
}
/** Refuse symlinked ancestors and oversized state. Never follow a model-provided path. */
export async function safeDirectory(directory: string, create = false): Promise<boolean> {
  const parent = path.dirname(directory);
  if (parent !== directory && !await safeDirectory(parent, create)) return false;
  try { const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('AgentCore state path refused'); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; if (!create) return false; try { await mkdir(directory, { mode: 0o700 }); } catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
    const created = await lstat(directory); if (!created.isDirectory() || created.isSymbolicLink()) throw new Error('AgentCore state path refused'); return true; }
}
export async function readState(file: string): Promise<unknown | undefined> {
  if (!await safeDirectory(path.dirname(file))) return undefined;
  let handle;
  try {
    const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('AgentCore state file refused');
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); const bytes = Buffer.alloc(65537); const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead > 65536) throw new Error('AgentCore state exceeds bound');
    const value: unknown = JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8'));
    if (stateObserverForTest !== undefined) await stateObserverForTest(file, 'after-read');
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  finally { await handle?.close(); }
}
export async function writeState(file: string, value: unknown, exclusive = false, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await safeDirectory(path.dirname(file), true);
  const bytes = JSON.stringify(value); if (Buffer.byteLength(bytes) > 65536) throw new Error('AgentCore state exceeds bound');
  const target = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(target, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    // A hard link publishes complete synced bytes atomically without clobbering.
    // An interrupted writer leaves only a .tmp, never a partial event/reservation.
    if (stateObserverForTest !== undefined) await stateObserverForTest(file, 'before-publish');
    signal?.throwIfAborted(); // No await between this check and issuing the atomic publication.
    if (exclusive) await link(target, file); else await rename(target, file);
    const directory = await open(path.dirname(file), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    if (stateObserverForTest !== undefined) await stateObserverForTest(file, 'after-publish');
  } finally { await unlink(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Cross-process exclusion for send/lifecycle changes. Never reclaim a crashed owner's lock silently. */
export async function withStateLock<T>(directory: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const file = path.join(directory, 'active.json');
  try { await writeState(file, { pid: process.pid }, true, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Cloud state operation in flight or interrupted; do not skip it. Inspect active.json owner before manual recovery.'); throw error; }
  try { signal?.throwIfAborted(); return await action(); } finally { await unlink(file); }
}
/** Used only by explicit user cleanup, after a durable receipt exists. */
export async function removeState(file: string, signal?: AbortSignal): Promise<void> {
  await readState(file); // Same symlink/size validation as readers; malformed state is not silently deleted.
  signal?.throwIfAborted();
  await unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
}

export async function stateNames(directory: string): Promise<string[]> {
  if (!await safeDirectory(directory)) return [];
  const names: string[] = [];
  for await (const entry of await opendir(directory)) {
    names.push(entry.name);
    if (names.length > 256) throw new Error('AgentCore state capacity reached (256 files); manage state outside Darwin');
  }
  return names.sort();
}

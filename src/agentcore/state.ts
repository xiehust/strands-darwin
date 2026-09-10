import { lstat, mkdir, open, opendir, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { userDarwinDir, userProjectDir } from '../paths.js';
import { digest, type AgentCoreConfig } from './config.js';

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
    return JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8'));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  finally { await handle?.close(); }
}
export async function writeState(file: string, value: unknown, exclusive = false): Promise<void> {
  await safeDirectory(path.dirname(file), true);
  const bytes = JSON.stringify(value); if (Buffer.byteLength(bytes) > 65536) throw new Error('AgentCore state exceeds bound');
  const target = exclusive ? file : `${file}.${randomUUID()}.tmp`;
  const handle = await open(target, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  if (!exclusive) await rename(target, file);
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

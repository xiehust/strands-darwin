/** Owned-HOME inventory fixtures; enumerate as the reader does, never assume readdir order. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, opendir, readFile, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { MAX_AGENT_PROJECT_ENTRIES } from '../src/list-agents.js';
import { projectKey, userProjectSessionsDir, userSessionsDir } from '../src/paths.js';

export async function directoryOrder(directory: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of await opendir(directory, { bufferSize: 1 })) names.push(entry.name);
  return names;
}

/** Select the current workspace only AFTER observing that it is outside the old prefix. */
export async function crowdedProject(home: string): Promise<string> {
  const candidates = new Map<string, string>();
  for (let index = 0; index < MAX_AGENT_PROJECT_ENTRIES * 2; index++) {
    const project = path.join(home, 'workspaces', `historical-${index}`);
    candidates.set(projectKey(project), project);
    await mkdir(userProjectSessionsDir(project), { recursive: true });
  }
  const names = await directoryOrder(userSessionsDir());
  const key = names.find((name, index) => index >= MAX_AGENT_PROJECT_ENTRIES && candidates.has(name));
  assert(key, 'fixture must place a known project beyond the ordinary prefix');
  const project = candidates.get(key)!;
  await mkdir(project, { recursive: true });
  assert.equal(projectKey(project), key, 'creating the workspace retains its canonical key');
  return project;
}

/** Content, names, modes and mtimes; reads may legitimately update atime. */
export async function digest(directory: string): Promise<string> {
  const hash = createHash('sha256');
  async function walk(file: string): Promise<void> {
    const info = await lstat(file);
    hash.update(`${path.relative(directory, file)}:${info.mode}:${info.mtimeMs}:`);
    if (info.isSymbolicLink()) hash.update(await readlink(file));
    else if (info.isDirectory()) {
      for (const name of (await readdir(file)).sort()) await walk(path.join(file, name));
    } else if (info.isFile()) hash.update(await readFile(file));
  }
  await walk(directory);
  return hash.digest('hex');
}

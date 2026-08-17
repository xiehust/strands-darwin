/** Host-filesystem safety boundary around official AgentSkills resource traversal. */
import { lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { ToolContext } from '@strands-agents/sdk';
import { Skill } from '@strands-agents/sdk/vended-plugins/skills';

const RESOURCE_DIRS = ['scripts', 'references', 'assets'] as const;
/** Hard bound on filesystem entries inspected before official activation begins. */
export const MAX_SKILL_RESOURCE_PREFLIGHT_ENTRIES = 200;

/**
 * Validates the complete resource tree before official AgentSkills lists it.
 * Official activation then receives the original ToolContext and exact Agent
 * identity; with all traversable entries proven non-symlink and inside-root, the
 * SDK's host sandbox cannot escape during its bounded listing.
 */
export async function guardSkillActivation(
  context: ToolContext,
  skill: Skill,
): Promise<ToolContext> {
  if (skill.path === undefined) return context;

  await validateResources(skill.path);
  return context;
}

interface EntryBudget {
  seen: number;
}

async function validateResources(skillPath: string): Promise<void> {
  const lexical = path.resolve(skillPath);
  const skillInfo = await lstat(lexical);
  if (skillInfo.isSymbolicLink()) {
    throw new Error(`Skill resource root must not be a symbolic link: ${lexical}`);
  }
  const real = await realpath(lexical);
  const allowed = RESOURCE_DIRS.map((name) => path.join(lexical, name));
  const budget: EntryBudget = { seen: 0 };
  for (const directory of allowed) {
    await validateTree(directory, real, budget, 0);
  }
}

async function validateTree(
  directory: string,
  realRoot: string,
  budget: EntryBudget,
  depth: number,
): Promise<void> {
  let handle;
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink()) throw symlinkError(directory);
    if (!info.isDirectory()) return;
    assertInside(realRoot, await realpath(directory), directory);
    handle = await opendir(directory);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }

  try {
    for await (const entry of handle) {
      const child = path.join(directory, entry.name);
      consumeEntry(budget, child);
      const info = await lstat(child);
      if (info.isSymbolicLink()) throw symlinkError(child);
      assertInside(realRoot, await realpath(child), child);
      // Official AgentSkills lists resource directories at depths 0, 1 and 2.
      if (info.isDirectory() && depth < 2) await validateTree(child, realRoot, budget, depth + 1);
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

function consumeEntry(budget: EntryBudget, entry: string): void {
  budget.seen += 1;
  if (budget.seen > MAX_SKILL_RESOURCE_PREFLIGHT_ENTRIES) {
    throw new Error(
      `Skill resources exceed the ${MAX_SKILL_RESOURCE_PREFLIGHT_ENTRIES}-entry safety preflight near ${entry}`,
    );
  }
}

function assertInside(root: string, candidate: string, source: string): void {
  if (!isInside(root, candidate)) {
    throw new Error(`Skill resource path resolves outside its skill root: ${source}`);
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function symlinkError(file: string): Error {
  return new Error(`Skill resources must not contain symbolic links: ${file}`);
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (
    error.code === 'ENOENT' || error.code === 'ENOTDIR'
  );
}

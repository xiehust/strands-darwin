/** Host-filesystem safety boundary around official AgentSkills resource traversal. */
import { lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { FileInfo, LocalAgent, Sandbox, ToolContext } from '@strands-agents/sdk';
import { Skill } from '@strands-agents/sdk/vended-plugins/skills';

const RESOURCE_DIRS = ['scripts', 'references', 'assets'] as const;
/** Hard bound on filesystem entries inspected before official activation begins. */
export const MAX_SKILL_RESOURCE_PREFLIGHT_ENTRIES = 200;
type ResourceSafetyCheckpoint = 'after-preflight';
let resourceSafetyCheckpoint: ((checkpoint: ResourceSafetyCheckpoint) => void | Promise<void>) | undefined;

/** Deterministic test seam for replacing a path after validation but before SDK traversal. */
export function setResourceSafetyCheckpointForTest(
  callback: ((checkpoint: ResourceSafetyCheckpoint) => void | Promise<void>) | undefined,
): void {
  resourceSafetyCheckpoint = callback;
}

/**
 * Validates the resource tree, then gives official AgentSkills a sandbox whose
 * listFiles re-checks symlinks and realpaths at use time. The guarded Agent proxy
 * is required because LocalAgent exposes sandbox as a getter with no public setter;
 * no identity-preserving public override exists in SDK 1.12.0.
 */
export async function guardSkillActivation(
  context: ToolContext,
  skill: Skill,
): Promise<ToolContext> {
  if (skill.path === undefined) return context;

  const root = await validateResources(skill.path);
  await resourceSafetyCheckpoint?.('after-preflight');
  const guardedSandbox = resourceSandbox(context.agent.sandbox, root);
  const guardedAgent = new Proxy(context.agent, {
    get(target, property) {
      if (property === 'sandbox') return guardedSandbox;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as LocalAgent;
  return { ...context, agent: guardedAgent };
}

interface ResourceRoot {
  lexical: string;
  real: string;
  allowed: readonly string[];
}

interface EntryBudget {
  seen: number;
}

async function validateResources(skillPath: string): Promise<ResourceRoot> {
  const lexical = path.resolve(skillPath);
  const skillInfo = await lstat(lexical);
  const real = await realpath(lexical);
  const realInfo = skillInfo.isSymbolicLink() ? await lstat(real) : skillInfo;
  if (!realInfo.isDirectory()) throw new Error(`Skill root is not a directory: ${lexical}`);
  const allowed = RESOURCE_DIRS.map((name) => path.join(lexical, name));
  const budget: EntryBudget = { seen: 0 };
  for (const directory of allowed) {
    await validateTree(directory, real, budget, 0, new Set());
  }
  return { lexical, real, allowed };
}

async function validateTree(
  directory: string,
  realRoot: string,
  budget: EntryBudget,
  depth: number,
  ancestors: ReadonlySet<string>,
): Promise<void> {
  let handle;
  try {
    const info = await lstat(directory);
    const resolved = await realpath(directory);
    assertInside(realRoot, resolved, directory);
    const targetInfo = info.isSymbolicLink() ? await lstat(resolved) : info;
    if (!targetInfo.isDirectory()) return;
    if (ancestors.has(resolved)) throw new Error(`Skill resource symlink cycle detected: ${directory}`);
    handle = await opendir(directory);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }

  const branch = new Set(ancestors);
  branch.add(await realpath(directory));
  try {
    for await (const entry of handle) {
      const child = path.join(directory, entry.name);
      consumeEntry(budget, child);
      const info = await lstat(child);
      const resolved = await realpath(child);
      assertInside(realRoot, resolved, child);
      const targetInfo = info.isSymbolicLink() ? await lstat(resolved) : info;
      // Official AgentSkills lists resource directories at depths 0, 1 and 2.
      if (targetInfo.isDirectory() && depth < 2) await validateTree(child, realRoot, budget, depth + 1, branch);
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

function resourceSandbox(sandbox: Sandbox, root: ResourceRoot): Sandbox {
  const budget: EntryBudget = { seen: 0 };
  return new Proxy(sandbox, {
    get(target, property) {
      if (property === 'listFiles') {
        return (directory: string): Promise<FileInfo[]> => listSafe(directory, root, budget);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function listSafe(
  directory: string,
  root: ResourceRoot,
  budget: EntryBudget,
): Promise<FileInfo[]> {
  const lexical = path.resolve(directory);
  if (!root.allowed.some((allowed) => isInside(allowed, lexical))) {
    throw new Error(`Skill resource traversal left its resource directories: ${lexical}`);
  }
  const rootRealNow = await realpath(root.lexical);
  if (rootRealNow !== root.real) {
    throw new Error(`Skill root changed after resource preflight: ${root.lexical}`);
  }
  const directoryInfo = await lstat(lexical);
  const directoryReal = await realpath(lexical);
  assertInside(rootRealNow, directoryReal, lexical);
  const directoryTargetInfo = directoryInfo.isSymbolicLink() ? await lstat(directoryReal) : directoryInfo;
  if (!directoryTargetInfo.isDirectory()) throw new Error(`Skill resource path is not a directory: ${lexical}`);

  const entries: FileInfo[] = [];
  const handle = await opendir(lexical);
  try {
    for await (const entry of handle) {
      const child = path.join(lexical, entry.name);
      consumeEntry(budget, child);
      const info = await lstat(child);
      const resolved = await realpath(child);
      assertInside(root.real, resolved, child);
      const targetInfo = info.isSymbolicLink() ? await lstat(resolved) : info;
      entries.push({ name: entry.name, isDir: targetInfo.isDirectory(), size: targetInfo.size });
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
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

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (
    error.code === 'ENOENT' || error.code === 'ENOTDIR'
  );
}

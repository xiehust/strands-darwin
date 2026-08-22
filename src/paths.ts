/** Shared path ownership for Darwin's user-global and project-local state. */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DARWIN_DIRNAME = '.darwin';
export const AGENTS_DIRNAME = '.agents';

/** `<projectRoot>/.darwin`, for repository-owned resources and legacy state. */
export function darwinDir(projectRoot: string): string {
  return path.join(projectRoot, DARWIN_DIRNAME);
}

/** `<projectRoot>/.agents`, for portable project extension resources. */
export function agentsDir(projectRoot: string): string {
  return path.join(projectRoot, AGENTS_DIRNAME);
}

/** `~/.darwin`, resolved from the current user's home directory. */
export function userDarwinDir(): string {
  return path.join(os.homedir(), DARWIN_DIRNAME);
}

/** `~/.agents`, for portable user-global extension resources. */
export function userAgentsDir(): string {
  return path.join(os.homedir(), AGENTS_DIRNAME);
}

export interface ExtensionRoot {
  root: string;
  scope: 'project' | 'global';
  kind: 'darwin' | 'agents';
}

/** Named-resource precedence, highest first after built-in reservations. */
export function extensionRoots(projectRoot: string): ExtensionRoot[] {
  return [
    { root: darwinDir(projectRoot), scope: 'project', kind: 'darwin' },
    { root: agentsDir(projectRoot), scope: 'project', kind: 'agents' },
    { root: userDarwinDir(), scope: 'global', kind: 'darwin' },
    { root: userAgentsDir(), scope: 'global', kind: 'agents' },
  ];
}

/** Hook wrapper order, outermost/global first. Post execution reverses this list. */
export function hookExtensionRoots(projectRoot: string): ExtensionRoot[] {
  return [
    { root: userAgentsDir(), scope: 'global', kind: 'agents' },
    { root: userDarwinDir(), scope: 'global', kind: 'darwin' },
    { root: agentsDir(projectRoot), scope: 'project', kind: 'agents' },
    { root: darwinDir(projectRoot), scope: 'project', kind: 'darwin' },
  ];
}

/** A stable, readable and collision-resistant directory name for one working tree. */
export function projectKey(projectRoot: string): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(projectRoot);
  } catch {
    canonical = path.resolve(projectRoot);
  }
  const readable = canonical.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 180) || 'project';
  const digest = createHash('sha256').update(canonical).digest('hex');
  return `${readable}--${digest}`;
}

/** User-owned state scoped to one canonical project. */
export function userProjectDir(projectRoot: string): string {
  return path.join(userDarwinDir(), 'projects', projectKey(projectRoot));
}

/** User-global session state scoped to one canonical project. */
export function userProjectSessionsDir(projectRoot: string): string {
  return path.join(userDarwinDir(), 'sessions', projectKey(projectRoot));
}

/** Derived, project-scoped learned memory. Never part of the repository itself. */
export function projectMemoryDir(projectRoot: string): string {
  return path.join(userProjectDir(projectRoot), 'memory');
}

/** Files that can change Darwin's own authorization or executable policy. */
export function sensitiveDarwinPaths(projectRoot: string): string[] {
  return [
    path.join(userDarwinDir(), 'config.json'),
    path.join(userDarwinDir(), 'hooks.json'),
    path.join(userProjectDir(projectRoot), 'permission-rules.json'),
    path.join(darwinDir(projectRoot), 'hooks.json'),
    path.join(darwinDir(projectRoot), 'config.json'),
  ];
}

/** Directories whose contents are executable hook policy. */
export function sensitiveHookDirectories(projectRoot: string): string[] {
  return extensionRoots(projectRoot).map(({ root }) => path.join(root, 'hooks'));
}

/** Containment-aware policy check shared by risk classification and allow rules. */
export function isSensitiveDarwinPath(projectRoot: string, candidate: string): boolean {
  const resolved = path.resolve(candidate);
  if (sensitiveDarwinPaths(projectRoot).some((file) => samePath(file, resolved))) return true;
  return sensitiveHookDirectories(projectRoot).some((directory) => isInside(directory, resolved));
}

function samePath(left: string, right: string): boolean {
  return path.relative(left, right) === '';
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

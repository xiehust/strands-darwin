/** Shared path ownership for Darwin's user-global and project-local state. */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DARWIN_DIRNAME = '.darwin';

/** `<projectRoot>/.darwin`, for repository-owned resources and legacy state. */
export function darwinDir(projectRoot: string): string {
  return path.join(projectRoot, DARWIN_DIRNAME);
}

/** `~/.darwin`, resolved from the current user's home directory. */
export function userDarwinDir(): string {
  return path.join(os.homedir(), DARWIN_DIRNAME);
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

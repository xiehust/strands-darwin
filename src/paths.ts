/**
 * Where darwin looks for project-level state.
 *
 * Everything is resolved against the directory darwin was started in — the
 * repository being worked on, never darwin's own source tree. Config, skills and
 * session snapshots share a single `.darwin/` directory, following the same
 * convention as `.claude/`, `.codex/` and `.kiro/`, so one entry in a project's
 * `.gitignore` covers the parts that should not be committed.
 */
import os from 'node:os';
import path from 'node:path';

export const DARWIN_DIRNAME = '.darwin';

/** `<projectRoot>/.darwin`. */
export function darwinDir(projectRoot: string): string {
  return path.join(projectRoot, DARWIN_DIRNAME);
}

/**
 * `~/.darwin` — the per-user directory, for a config that is not tied to one
 * repository.
 *
 * Only the config file is read from here, and only as a fallback: a headless
 * caller (`darwin -p`) starts darwin in the repository it wants edited, so it has
 * nowhere project-local to leave configuration that the repository itself would
 * not then contain. Skills, MCP servers and session snapshots stay strictly
 * project-scoped, because those describe the project, not the user.
 */
export function userDarwinDir(): string {
  return path.join(os.homedir(), DARWIN_DIRNAME);
}

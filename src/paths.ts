/**
 * Where darwin looks for project-level state.
 *
 * Everything is resolved against the directory darwin was started in — the
 * repository being worked on, never darwin's own source tree. Config, skills and
 * session snapshots share a single `.darwin/` directory, following the same
 * convention as `.claude/`, `.codex/` and `.kiro/`, so one entry in a project's
 * `.gitignore` covers the parts that should not be committed.
 */
import path from 'node:path';

export const DARWIN_DIRNAME = '.darwin';

/** `<projectRoot>/.darwin`. */
export function darwinDir(projectRoot: string): string {
  return path.join(projectRoot, DARWIN_DIRNAME);
}

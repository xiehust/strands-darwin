/**
 * `@` path completion: which workspace paths the editor offers, and what accepting
 * one does to the draft.
 *
 * The product decision this file encodes is *path text, never file content*. Three
 * peers offer `@` in a composer and disagree about what follows: Codex inserts the
 * path, OpenCode inlines the file's bytes, Claude Code autocompletes the path.
 * Darwin takes the Codex shape deliberately — every byte of file content keeps
 * flowing through the existing `fileEditor` read, which is classified, gated and
 * recorded in the trajectory, while inlining would be a second, ungated route for
 * file content into the model's context. So nothing here opens a file: the scan
 * reads *directory entries* (`opendir`/`lstat`/`realpath`) and nothing else.
 *
 * The split matters for testing. Everything the editor does per keystroke —
 * recognizing a trigger, matching a prefix, rewriting the draft — is pure and
 * synchronous ({@link pathCompletionQuery}, {@link matchWorkspacePaths},
 * {@link applyPathCompletion}), exactly like `computeCompletions`. The one thing
 * that touches the filesystem ({@link scanWorkspacePaths}) is asynchronous, bounded
 * and cached by the caller, because a keystroke must never wait on a tree that may
 * hold a `node_modules`.
 */
import { opendir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { snapCursor, type EditorValue } from './prompt-editor.js';

/** The character that opens a path query. */
export const PATH_TRIGGER = '@';

/**
 * Longest query treated as a path prefix.
 *
 * A token this long is prose, a URL or a pasted blob, not something a person is
 * completing — and matching it against every candidate on every keystroke is work
 * with a guaranteed empty result.
 */
export const MAX_PATH_QUERY_LENGTH = 256;

/** Directory entries the scan may inspect before it stops and says so. */
export const MAX_SCAN_ENTRIES = 8000;

/**
 * Levels below the project root the scan may descend.
 *
 * This repository is 6 levels deep excluding the skipped directories, so 8 covers
 * it whole; the bound exists for the tree that does not stop.
 */
export const MAX_SCAN_DEPTH = 8;

/** Candidates kept in memory for matching. */
export const MAX_PATH_CANDIDATES = 4000;

/**
 * Directory names a repository scan has no business walking.
 *
 * Neither walked nor offered: a completion for `node_modules/.pnpm/…` is not a path
 * anyone means, and walking it is how typing would come to depend on the size of a
 * dependency tree. Matched by name at any depth.
 */
export const EXCLUDED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.cache',
  '.gradle',
  '.next',
  '.nuxt',
  '.pnpm-store',
  '.turbo',
  '.venv',
  '.yarn',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
  'venv',
]);

/** An open `@` query: where it starts, where the cursor is, and what was typed. */
export interface PathQuery {
  /** Source offset of the `@` itself. */
  readonly start: number;
  /** Source offset one past the query, i.e. the cursor. */
  readonly end: number;
  /** Text typed after the `@`; empty right after the trigger. */
  readonly text: string;
}

/**
 * The `@` query under the cursor, or nothing.
 *
 * A query is open when scanning back from the cursor reaches an `@` without
 * crossing whitespace, *and* the character before that `@` is the start of the
 * draft or whitespace. That one rule is what keeps the menu out of prose:
 * `user@example.com` has `r` before the `@`, and so does every decorator or handle
 * typed inside a word. A newline counts as whitespace, so a multi-line draft
 * triggers per line, and a space typed after the query closes it again — the same
 * "a space ends it" shape `computeCompletions` uses for commands.
 *
 * Recognizing a trigger is not the same as opening a menu: a query that matches no
 * workspace path offers no rows at all, which is what makes `@someone` in a
 * sentence a no-op rather than a hijacked keyboard.
 */
export function pathCompletionQuery(text: string, cursorOffset: number): PathQuery | undefined {
  const cursor = Math.max(0, Math.min(text.length, cursorOffset));

  let index = cursor - 1;
  while (index >= 0) {
    const character = text[index] as string;
    if (isWhitespace(character)) return undefined;
    if (character === PATH_TRIGGER) break;
    index -= 1;
  }
  if (index < 0) return undefined;

  const before = index === 0 ? undefined : (text[index - 1] as string);
  if (before !== undefined && !isWhitespace(before)) return undefined;

  const query = text.slice(index + 1, cursor);
  if (query.length > MAX_PATH_QUERY_LENGTH) return undefined;
  return { start: index, end: cursor, text: query };
}

/**
 * Candidates matching a query, best first.
 *
 * Two tiers, no scoring: paths that start with the query, then — only when the
 * query names no directory of its own — paths whose *last segment* starts with it,
 * so `@InputBox` finds `src/tui/InputBox.tsx` without anyone having to type the
 * directories. Both tiers are case-insensitive and keep the candidate order they
 * were scanned in, which is breadth-first, so shallow paths come first. Fuzzy
 * matching is deliberately absent: a menu whose top row moves for reasons the user
 * cannot see is worse than one they can predict.
 *
 * Every match is returned. The list is already bounded by {@link MAX_PATH_CANDIDATES},
 * and the caller needs the true total to say how many rows it is not showing.
 */
export function matchWorkspacePaths(candidates: readonly string[], query: string): string[] {
  const needle = normalizeQuery(query).toLowerCase();
  if (needle === '') return [...candidates];

  const byPath: string[] = [];
  const byBasename: string[] = [];
  const wantsBasenames = !needle.includes('/');

  for (const candidate of candidates) {
    const lowered = candidate.toLowerCase();
    if (lowered.startsWith(needle)) byPath.push(candidate);
    else if (wantsBasenames && basename(lowered).startsWith(needle)) byBasename.push(candidate);
  }
  return [...byPath, ...byBasename];
}

/**
 * The draft with the accepted path in place of the `@` token.
 *
 * The `@` is scaffolding, not content: accepting a **file** replaces the whole token
 * with the plain path and one space, which is the text a person would have typed;
 * accepting a **directory** keeps the marker (`@src/`) so the next keystroke carries
 * on completing inside it. Nothing else about the draft moves, and nothing is read
 * from the path itself — this function only ever touches strings.
 */
export function applyPathCompletion(value: EditorValue, query: PathQuery, chosen: string): EditorValue {
  const isDirectory = chosen.endsWith('/');
  const inserted = isDirectory ? `${PATH_TRIGGER}${chosen}` : `${chosen} `;
  const start = Math.max(0, Math.min(value.text.length, query.start));
  const end = Math.max(start, Math.min(value.text.length, query.end));
  const text = value.text.slice(0, start) + inserted + value.text.slice(end);
  return { text, cursor: snapCursor(text, { offset: start + inserted.length, affinity: 'upstream' }) };
}

/** One bounded reading of the workspace's paths. */
export interface WorkspacePaths {
  /**
   * Project-relative paths, breadth-first; a directory carries a trailing `/`.
   */
  readonly paths: readonly string[];
  /** Directory entries inspected, whether or not they became candidates. */
  readonly entriesSeen: number;
  /** True when a bound stopped the scan before the tree ran out. */
  readonly truncated: boolean;
  /**
   * Why the reading is partial for a reason other than a bound — an unreadable
   * root, typically. Undefined for a complete scan, like the other bounded
   * loaders in this project.
   */
  readonly problem: string | undefined;
}

/** The reading used before any scan has finished: offers nothing, says nothing. */
export const NO_WORKSPACE_PATHS: WorkspacePaths = {
  paths: [],
  entriesSeen: 0,
  truncated: false,
  problem: undefined,
};

/**
 * Lists the project's paths, breadth-first and bounded.
 *
 * Breadth-first for two reasons: the shallow paths are the ones a person completes,
 * and it makes truncation drop the deepest entries rather than an arbitrary subtree.
 * Bounded three ways — {@link MAX_SCAN_ENTRIES}, {@link MAX_SCAN_DEPTH},
 * {@link MAX_PATH_CANDIDATES} — and reporting which bound it hit, because a menu
 * that silently shows a subset of the workspace is a menu that lies.
 *
 * Never throws. A directory that cannot be read is skipped and the rest is still
 * offered: `resource-safety.ts` refuses activation on the same conditions because a
 * skill about to run is a security boundary, while a completion list degrading to
 * fewer rows must never stop somebody typing.
 *
 * Symlinks are never traversed, and are offered only when they resolve inside the
 * project root — the scan of a workspace must not be able to name a path outside it.
 */
export async function scanWorkspacePaths(projectRoot: string): Promise<WorkspacePaths> {
  const root = path.resolve(projectRoot);
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    return { ...NO_WORKSPACE_PATHS, problem: describe(error) };
  }

  const paths: string[] = [];
  let entriesSeen = 0;
  let truncated = false;
  let problem: string | undefined;
  /** Project-relative directories still to read, shallowest first. */
  let level: string[] = [''];

  for (let depth = 0; depth < MAX_SCAN_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const relative of level) {
      if (entriesSeen >= MAX_SCAN_ENTRIES || paths.length >= MAX_PATH_CANDIDATES) {
        truncated = true;
        break;
      }
      const outcome = await readLevel(root, realRoot, relative);
      if (outcome.problem !== undefined) {
        problem ??= outcome.problem;
        continue;
      }
      for (const entry of outcome.entries) {
        entriesSeen += 1;
        if (entriesSeen > MAX_SCAN_ENTRIES) {
          truncated = true;
          break;
        }
        if (entry.excluded) continue;
        if (paths.length >= MAX_PATH_CANDIDATES) {
          truncated = true;
          break;
        }
        paths.push(entry.directory ? `${entry.relative}/` : entry.relative);
        if (entry.directory) next.push(entry.relative);
      }
    }
    if (truncated) break;
    level = next;
  }
  // Depth, not entries: unread directories were reached but never descended into.
  if (!truncated && level.length > 0) truncated = true;

  return { paths, entriesSeen, truncated, problem };
}

/** One line stating what a bounded or degraded reading is not showing. */
export function workspacePathsNote(reading: WorkspacePaths): string | undefined {
  if (reading.problem !== undefined) return `partial scan: ${reading.problem}`;
  if (reading.truncated) return `bounded scan: ${reading.paths.length} paths`;
  return undefined;
}

interface ScannedEntry {
  readonly relative: string;
  readonly directory: boolean;
  /** Counted against the entry budget, then dropped: skipped names and escapes. */
  readonly excluded: boolean;
}

interface LevelOutcome {
  readonly entries: readonly ScannedEntry[];
  readonly problem: string | undefined;
}

async function readLevel(root: string, realRoot: string, relative: string): Promise<LevelOutcome> {
  const directory = relative === '' ? root : path.join(root, relative);
  let handle;
  try {
    handle = await opendir(directory);
  } catch (error) {
    return { entries: [], problem: describe(error) };
  }

  const entries: ScannedEntry[] = [];
  try {
    for await (const entry of handle) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        entries.push({ relative: child, directory: false, excluded: !(await resolvesInside(realRoot, path.join(directory, entry.name))) });
        continue;
      }
      const isDirectory = entry.isDirectory();
      entries.push({
        relative: child,
        directory: isDirectory,
        excluded: isDirectory && EXCLUDED_DIRECTORY_NAMES.has(entry.name),
      });
    }
  } catch (error) {
    return { entries, problem: describe(error) };
  } finally {
    await handle.close().catch(() => {});
  }

  entries.sort((left, right) => left.relative.localeCompare(right.relative));
  return { entries, problem: undefined };
}

/** A link is offered only when what it points at is still inside the project. */
async function resolvesInside(realRoot: string, link: string): Promise<boolean> {
  try {
    return isInside(realRoot, await realpath(link));
  } catch {
    return false;
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function normalizeQuery(query: string): string {
  return query.startsWith('./') ? query.slice(2) : query;
}

function basename(candidate: string): string {
  const trimmed = candidate.endsWith('/') ? candidate.slice(0, -1) : candidate;
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

function isWhitespace(character: string): boolean {
  return /\s/.test(character);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

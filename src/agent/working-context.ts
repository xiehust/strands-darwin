/**
 * Working context: the facts about *now* that the rest of the prompt cannot carry.
 *
 * The base prompt, AGENTS.md and the skills catalogue are all rules — true for as
 * long as the files behind them are unchanged. Where the agent is standing is not:
 * the directory it was started in, what that directory contains, which OS it is
 * on, and today's date are all things it would otherwise have to spend a tool call
 * discovering, or worse, guess at (a model with a training cutoff will happily
 * assert the wrong year).
 *
 * Two properties make this safe to put in a cached system prompt:
 *
 * - it is a *snapshot*, and says so. The listing and the date are true at startup
 *   and the block tells the model to re-check anything that may have moved, so a
 *   long session cannot be misled by its own edits.
 * - it is bounded. Everything in the system prompt is re-sent with every request,
 *   so the entry list is capped ({@link MAX_LISTED_ENTRIES}) rather than trusted
 *   to be small — one `node_modules` expanded here would cost more context than
 *   the conversation.
 *
 * Day granularity for the date is deliberate: a clock time would change the
 * prompt on every run and throw away the provider-side cache of everything after
 * it (tools → system → messages is a prefix chain), buying a precision no coding
 * task has needed.
 */
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';

import type { SystemPromptHolder } from './prompt-cache.js';
import { refreshKnownPrompt } from '../skills/prompt.js';

export const WORKING_CONTEXT_TAG = 'working-context';

/**
 * How many directory entries the block may name.
 *
 * Generous for a repository root and still bounded for a directory holding
 * thousands of files. What is dropped is reported in the block, so the model can
 * tell "these are all of them" from "here are the first two hundred".
 */
export const MAX_LISTED_ENTRIES = 200;

/** How wide the entry list wraps. Matches the prose width of the base prompt. */
const WRAP_COLUMNS = 88;

export interface WorkingContextLoad {
  /** The system-prompt fragment, delimited and ready to append. Never empty. */
  fragment: string;
  /**
   * Why the entry list is missing from an otherwise valid fragment. Undefined
   * when the directory was read, since a successful load needs no reporting —
   * same rule as the other startup loaders.
   */
  problem: string | undefined;
}

/**
 * Assembles the fragment for one run.
 *
 * `now` is injectable so a test can assert an exact date instead of racing the
 * clock. A directory that cannot be listed degrades to a fragment without the
 * listing: the working directory, platform and date are still worth sending, and
 * refusing to start over an unreadable folder would be absurd.
 */
export async function buildWorkingContext(
  projectRoot: string,
  now: Date = new Date(),
): Promise<WorkingContextLoad> {
  const listing = await listEntries(projectRoot);
  const lines = [
    `- working directory: ${projectRoot}`,
    `- platform: ${os.platform()} ${os.release()} (${os.arch()})`,
    `- shell: ${process.env['SHELL'] ?? '(unknown)'}`,
    `- node: ${process.version}`,
    `- date: ${now.toISOString().slice(0, 10)} (UTC), local time zone ${timeZone()}`,
  ];

  if (listing.problem === undefined) {
    lines.push(`- ${describeCounts(listing)}`, ...wrap(listing.names).map((line) => `    ${line}`));
    if (listing.omitted > 0) {
      lines.push(`    (${listing.omitted} more entr${listing.omitted === 1 ? 'y' : 'ies'} not listed)`);
    }
  }

  return {
    fragment: [
      `<${WORKING_CONTEXT_TAG}>`,
      'Where this session started. The directory listing and the date are a snapshot taken at',
      'startup, not live state: re-check anything that may have changed since, including your own',
      'edits. Paths are absolute unless stated otherwise.',
      ...lines,
      `</${WORKING_CONTEXT_TAG}>`,
    ].join('\n'),
    problem: listing.problem,
  };
}

/**
 * Replaces any working context already in `prompt` with `fragment`, appending it
 * last.
 *
 * Replacement, not plain appending, because a resumed session does not start from
 * the freshly composed prompt: the SDK restores `systemPrompt` from the snapshot
 * during `initialize()`, so the prompt in hand may already carry the block a
 * previous run wrote — with that run's date and that run's directory listing.
 * Stripping every occurrence also means a double application is harmless.
 */
export function withWorkingContext(prompt: string, fragment: string): string {
  const stripped = stripWorkingContext(prompt);
  return stripped === '' ? fragment : `${stripped}\n\n${fragment}`;
}

/**
 * Refreshes the one current working-context block after initialization/restore.
 *
 * The official skills plugin keeps its catalogue in a separate TextBlock, and
 * Darwin keeps the cache point last. `refreshKnownPrompt` accepts only those
 * explicit Darwin-owned shapes, preserves the catalogue, replaces working
 * context, and drops the old cache point so the current run can re-place it.
 */
export function applyWorkingContext(agent: SystemPromptHolder, fragment: string): boolean {
  const refreshed = refreshKnownPrompt(agent.systemPrompt, fragment);
  if (refreshed === undefined) return false;
  agent.systemPrompt = refreshed;
  return true;
}

/** Removes every working-context block, leaving the rest of the prompt intact. */
export function stripWorkingContext(prompt: string): string {
  const block = new RegExp(`\\n*<${WORKING_CONTEXT_TAG}>[\\s\\S]*?</${WORKING_CONTEXT_TAG}>`, 'g');
  return prompt.replace(block, '').trimEnd();
}

interface Listing {
  names: readonly string[];
  directories: number;
  files: number;
  omitted: number;
  problem: string | undefined;
}

/**
 * Immediate children only, directories first.
 *
 * One level is the useful level: it is what a person reads to orient themselves,
 * and it stays a single `readdir` no matter how deep the tree is. A trailing `/`
 * marks a directory and `@` a symlink, which is not followed — claiming a link to
 * a directory is a file would be worse than saying nothing about it.
 */
async function listEntries(projectRoot: string): Promise<Listing> {
  let entries: Dirent[];
  try {
    entries = await readdir(projectRoot, { withFileTypes: true });
  } catch (error) {
    return { names: [], directories: 0, files: 0, omitted: 0, problem: describe(error) };
  }

  const directories: string[] = [];
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) files.push(`${entry.name}@`);
    else if (entry.isDirectory()) directories.push(`${entry.name}/`);
    else files.push(entry.name);
  }
  directories.sort((a, b) => a.localeCompare(b));
  files.sort((a, b) => a.localeCompare(b));

  const all = [...directories, ...files];
  return {
    names: all.slice(0, MAX_LISTED_ENTRIES),
    directories: directories.length,
    files: files.length,
    omitted: Math.max(0, all.length - MAX_LISTED_ENTRIES),
    problem: undefined,
  };
}

function describeCounts(listing: Listing): string {
  const total = listing.directories + listing.files;
  if (total === 0) return 'contents: empty';
  return `contents (${plural(listing.directories, 'directory', 'directories')}, ${plural(listing.files, 'file', 'files')}):`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Greedy wrap: entry names are short, and a line break inside one would be a lie. */
function wrap(names: readonly string[]): string[] {
  const lines: string[] = [];
  let line = '';
  for (const name of names) {
    if (line === '') line = name;
    else if (line.length + name.length + 2 <= WRAP_COLUMNS) line = `${line}  ${name}`;
    else {
      lines.push(line);
      line = name;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/** Never throws: a host without ICU data still has a working directory. */
function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '(unknown)';
  } catch {
    return '(unknown)';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

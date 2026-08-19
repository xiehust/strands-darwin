import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { darwinDir, userDarwinDir } from '../paths.js';

export const COMMANDS_DIRNAME = 'commands';
export const ARGUMENTS_PLACEHOLDER = '$ARGUMENTS';

/** Commands shown in completion, in their stable display order. */
export const BUILTIN_COMMAND_NAMES = ['agents', 'clear', 'compact', 'context', 'effort', 'exit', 'export', 'mcp', 'mode', 'model', 'permissions', 'status', 'tasks', 'trajectory', 'usage'] as const;

/**
 * One-phrase completion-row descriptions, total over {@link BUILTIN_COMMAND_NAMES}
 * by construction: the `Record` over the name union makes a missing or extra
 * entry a compile error.
 */
export const BUILTIN_COMMAND_DESCRIPTIONS: Readonly<
  Record<(typeof BUILTIN_COMMAND_NAMES)[number], string>
> = {
  // Dispatch *runs*, not the catalogue of definitions the header lists.
  agents: 'list subagent dispatches',
  // Starts a new session; the one being left stays on disk and resumable.
  clear: 'start a new session',
  compact: 'summarize older conversation',
  context: 'estimated context size',
  effort: 'set thinking depth',
  exit: 'quit darwin',
  // Writes a file at the named path, nothing else: no clipboard, no $EDITOR. The
  // transcript is the trajectory record's replay projection, so /export and
  // `darwin trajectory replay` cannot disagree.
  export: 'write this session\u2019s transcript to a file',
  // Configured servers with their connection state — a failed one is named as
  // failed here instead of silently contributing zero tools.
  mcp: 'MCP servers and their tools',
  // Session-scoped enforcement policy, not the model: /mode sits next to /model in
  // the menu, so both descriptions have to say which is which.
  mode: 'set the permission mode',
  model: 'list or switch models',
  // Allow-rules, not the mode: /permissions lists and revokes what runs silently,
  // /mode moves how much everything else asks.
  permissions: 'list or revoke allow-rules',
  // The consolidated read-only session report — configuration and live state in
  // one transcript block, for when the header has scrolled away.
  status: 'session configuration and state',
  tasks: 'list background jobs',
  // The record this session is writing, not the CLI's search/fork/replay verbs.
  trajectory: 'this session\u2019s recorded trajectory',
  usage: 'token counts this run',
};

/**
 * The description for a completion row, or nothing for custom commands and
 * skills. `Object.hasOwn` rather than indexing: a custom command may be named
 * `constructor`, and prototype pollution is not a description.
 */
export function builtinCommandDescription(name: string): string | undefined {
  return Object.hasOwn(BUILTIN_COMMAND_DESCRIPTIONS, name)
    ? BUILTIN_COMMAND_DESCRIPTIONS[name as (typeof BUILTIN_COMMAND_NAMES)[number]]
    : undefined;
}

/** `/quit` works as an alias but deliberately does not consume a completion row. */
const RESERVED_COMMAND_NAMES = [...BUILTIN_COMMAND_NAMES, 'quit'] as const;

export interface CustomCommand {
  name: string;
  /** Absolute path to the Markdown source. */
  file: string;
  content: string;
}

export interface CustomCommandProblem {
  file: string;
  reason: string;
}

export interface CustomCommandRegistry {
  commands: CustomCommand[];
  problems: CustomCommandProblem[];
}

export interface ExpandedCustomCommand {
  command: CustomCommand;
  message: string;
}

/**
 * Loads direct `.md` children of `<root>/.darwin/commands/`.
 *
 * Built-ins and skills own their slash names first. Bad entries are isolated and
 * reported so one typo cannot hide otherwise valid project commands.
 */
export async function loadCustomCommands(
  root: string,
  skillNames: readonly string[],
): Promise<CustomCommandRegistry> {
  const commandDirs = [
    path.join(darwinDir(root), COMMANDS_DIRNAME),
    path.join(userDarwinDir(), COMMANDS_DIRNAME),
  ];
  const commands: CustomCommand[] = [];
  const problems: CustomCommandProblem[] = [];
  const claimed = new Map<string, string>();
  for (const name of RESERVED_COMMAND_NAMES) claimed.set(name.toLowerCase(), `built-in command /${name}`);
  for (const name of skillNames) claimed.set(name.toLowerCase(), `skill /${name}`);

  for (const commandsDir of [...new Set(commandDirs)]) {
    let entries: Dirent[];
    try {
      entries = await readdir(commandsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;

      const file = path.join(commandsDir, entry.name);
    const name = entry.name.slice(0, -path.extname(entry.name).length);
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      problems.push({
        file,
        reason: 'command name must contain only letters, numbers, hyphens and underscores',
      });
      continue;
    }

    const normalized = name.toLowerCase();
    const owner = claimed.get(normalized);
    if (owner !== undefined) {
      problems.push({ file, reason: `command name "${name}" conflicts with ${owner}` });
      continue;
    }

    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch (error) {
      problems.push({
        file,
        reason: `could not read file: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (content.trim() === '') {
      problems.push({ file, reason: 'command file is empty' });
      continue;
    }

    claimed.set(normalized, file);
    commands.push({ name, file, content });
  }

  }

  commands.sort((a, b) => a.name.localeCompare(b.name));
  return { commands, problems };
}

/** Expands a known custom slash command, leaving all other input untouched. */
export function expandCustomCommand(
  registry: CustomCommandRegistry,
  input: string,
): ExpandedCustomCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const withoutSlash = trimmed.slice(1);
  const separator = withoutSlash.search(/\s/);
  const name = separator === -1 ? withoutSlash : withoutSlash.slice(0, separator);
  const args = separator === -1 ? '' : withoutSlash.slice(separator).trim();
  const command = registry.commands.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  if (command === undefined) return null;

  return {
    command,
    message: command.content.replaceAll(ARGUMENTS_PLACEHOLDER, args),
  };
}

/**
 * The base system prompt: darwin's own coding-agent instructions, and the two
 * ways a project can replace them.
 *
 * This is only the *base* of the prompt. The composition order stays fixed —
 * base prompt → `<project-instructions>` (AGENTS.md) → `<available-skills>` —
 * so an override swaps out darwin's own instructions and never the project's:
 * AGENTS.md remains the place for repository rules that add to a prompt rather
 * than replace it.
 *
 * Precedence, highest first:
 *   1. `systemPrompt` in `.darwin/config.json` (inline, explicit)
 *   2. `.darwin/system-prompt.md` (the convention file, for prose too long for JSON)
 *   3. {@link DEFAULT_SYSTEM_PROMPT}
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { darwinDir } from '../paths.js';

/** `<projectRoot>/.darwin/system-prompt.md`. */
export const SYSTEM_PROMPT_FILENAME = 'system-prompt.md';

/**
 * darwin's default instructions.
 *
 * Written against what the runtime actually registers: `fileEditor` and `bash`
 * are always present, `load_skill` only when the project defines skills, and MCP
 * servers may add more — so the tool section names the certain two and points at
 * the rest generically rather than inventing capabilities the model may not have.
 *
 * The behavioural rules here exist because their absence has a cost: an agent
 * that edits unread files corrupts them, one that claims success without running
 * anything is unverifiable, and one that works around a denied tool call defeats
 * the permission gate.
 */
export const DEFAULT_SYSTEM_PROMPT = `You are darwin, a coding agent working inside a real git repository on the user's machine.
You act like a careful senior engineer: you read before you change, you change as little as
possible, and you prove that what you changed works.

## Tools

- fileEditor: view, create, str_replace and insert operations on files. Use absolute paths.
- bash: run shell commands. Use it to search (rg, grep, find), inspect state, and run builds,
  tests and linters.

More tools may be available (project skills via load_skill, MCP servers). Prefer using a tool
to find something out over guessing or asking the user for what you could read yourself.

## Working method

1. Understand the code before touching it. Locate the relevant files, read them, and follow the
   conventions already there — matching the surrounding style matters more than your own taste.
2. Never edit a file you have not read in this conversation. Never invent an API, a flag, a
   dependency or a file path you have not verified.
3. Make small, targeted edits. Prefer str_replace over rewriting a whole file, and do not
   reformat, rename or "improve" code the task did not ask about.
4. Verify your work by running something: the project's typecheck, its tests, or a command that
   exercises the change. If verification is impossible, say so instead of implying success.
5. Do not add dependencies, delete data, or rewrite git history unless asked.

## Working with the user

- Report what you did, what you ran, and what the result was. State failures plainly; a passing
  claim that turns out to be false is worse than an admitted problem.
- When the task is ambiguous or a requirement conflicts with something you found in the code,
  ask before implementing a guess.
- Be concise. Output is read in a terminal: short paragraphs and lists, no filler, no restating
  the request back.
- Follow the project's own instructions (AGENTS.md, skills) when they conflict with these
  general rules — they know the repository and this prompt does not.

## Permissions

Some tool calls need the user's approval. If a call comes back denied, do not retry it and do
not work around it — explain what you were attempting and ask how to proceed.`;

/** Where the base prompt in effect came from, for reporting at startup. */
export type SystemPromptSource = 'default' | 'config' | 'file';

export interface SystemPromptLoad {
  /** The base prompt to hand to the agent. Never empty. */
  prompt: string;
  source: SystemPromptSource;
  /** Absolute path of the override file, when one was used. */
  path: string | undefined;
  /**
   * Why a present override could not be used. Undefined both when nothing was
   * overridden and when the override loaded — neither needs reporting.
   */
  problem: string | undefined;
}

/**
 * Resolves the base prompt for a run.
 *
 * A broken override never blocks startup, but it is never silent either: falling
 * back to the default would otherwise leave the user believing their own prompt
 * is steering the agent. Same rule as a broken AGENTS.md or skill directory —
 * skip it, keep going, say why.
 *
 * `configuredPrompt` is already validated as a non-empty string by config
 * loading, so an inline override cannot fail here; only the file can.
 */
export async function loadSystemPrompt(
  projectRoot: string,
  configuredPrompt?: string,
): Promise<SystemPromptLoad> {
  if (configuredPrompt !== undefined) {
    return { prompt: configuredPrompt, source: 'config', path: undefined, problem: undefined };
  }

  const filePath = path.join(darwinDir(projectRoot), SYSTEM_PROMPT_FILENAME);

  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    return {
      prompt: DEFAULT_SYSTEM_PROMPT,
      source: 'default',
      path: undefined,
      // A missing file is the normal case: the default is what most projects want.
      problem: isMissingFile(error) ? undefined : describe(error),
    };
  }

  // An empty file is treated as "no override" rather than as an empty prompt:
  // sending no instructions at all is never what someone meant to configure.
  if (text.trim() === '') {
    return {
      prompt: DEFAULT_SYSTEM_PROMPT,
      source: 'default',
      path: undefined,
      problem: `${filePath} is empty — using the default prompt`,
    };
  }

  return { prompt: text.trimEnd(), source: 'file', path: filePath, problem: undefined };
}

/** True when the file is simply not there (ENOTDIR: a file sits where a dir should). */
function isMissingFile(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

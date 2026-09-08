/**
 * The `/init` built-in — a prompt-style trigger that asks the model to write
 * this repository's `AGENTS.md`, never a tool and never a second channel.
 *
 * Expansion produces one fixed ordinary prompt that goes down the ordinary
 * submit path: the model inspects the repository with the tools it already has
 * and writes the file with the ordinary file editor, so the write crosses the
 * permission gate like any other edit. This module therefore stays pure: it
 * opens no file and never touches the runtime. The create-versus-improve
 * branch comes from the {@link InitCommandContext} the caller passes in — the
 * `ProjectInstructionsSummary` the runtime captured at startup, the same data
 * the header row shows — never from a fresh filesystem read at expansion time.
 *
 * The parse grammar deliberately mirrors `parseWorkflowCommand` and
 * `expandCustomCommand` (trim, leading `/`, name up to the first whitespace,
 * case-insensitive), so the built-in and the custom commands it is reserved
 * against cannot disagree about what a slash command looks like. Unlike
 * `/workflow`, the bare form *is* the trigger: writing instructions needs no
 * argument, and an optional `/init <focus>` only steers the pass.
 *
 * When the loaded file is `CLAUDE.md`, the prompt asks for a new `AGENTS.md`
 * carrying over the still-true content and leaves `CLAUDE.md` untouched, rather
 * than improving `CLAUDE.md` in place. `AGENTS.md` is darwin's primary name and
 * is read first, so only that outcome moves the project off the fallback path;
 * a `CLAUDE.md` may also lean on Claude Code's `@path` imports, which darwin
 * does not expand, and the user's Claude Code setup keeps working unchanged.
 */
import {
  AGENTS_FILENAME,
  CLAUDE_FILENAME,
  MAX_INSTRUCTIONS_BYTES,
  type InstructionsFilename,
  type ProjectInstructionsSummary,
} from '../agent/instructions.js';

export const INIT_COMMAND_NAME = 'init';

/**
 * What the runtime already knows about the project's instructions file. Both
 * fields come straight from `RuntimeInfo`: `loaded` is the file darwin preloaded
 * at startup (or undefined when there was none), `problemFile` names a present
 * file that could not be read (undefined when there is no such problem).
 */
export interface InitCommandContext {
  loaded: Pick<ProjectInstructionsSummary, 'filename' | 'bytes' | 'truncated'> | undefined;
  problemFile: InstructionsFilename | undefined;
}

/** Instruction sources the prompt asks the model to consult before writing. */
const INSTRUCTION_SOURCES = [
  `\`${CLAUDE_FILENAME}\``,
  '`.cursorrules`',
  '`.cursor/rules/`',
  '`.github/copilot-instructions.md`',
];

const CAP_KIB = MAX_INSTRUCTIONS_BYTES / 1024;

/**
 * The one sentence that differs between the variants: what exists now, and
 * therefore whether the pass creates, improves or migrates.
 */
function situation(context: InitCommandContext): string {
  if (context.problemFile !== undefined) {
    return (
      `A \`${context.problemFile}\` is present at the project root, but darwin could not read it at ` +
      'startup. Inspect it before anything else: if it is a regular file the file editor can repair, ' +
      'improve it in place; if it is a directory or otherwise not a readable file, report what you ' +
      'found and stop \u2014 never delete or replace it.'
    );
  }
  const loaded = context.loaded;
  if (loaded === undefined) {
    return (
      'darwin loaded no project instructions at startup, so create ' +
      `\`${AGENTS_FILENAME}\` at the project root.`
    );
  }
  if (loaded.filename === CLAUDE_FILENAME) {
    return (
      `darwin loaded \`${CLAUDE_FILENAME}\` (${loaded.bytes} bytes) at startup because there is no ` +
      `\`${AGENTS_FILENAME}\`. Create \`${AGENTS_FILENAME}\` at the project root, carrying over the ` +
      `still-true content of \`${CLAUDE_FILENAME}\` and adding what the inspection reveals; leave ` +
      `\`${CLAUDE_FILENAME}\` untouched \u2014 it keeps working for Claude Code. Its \`@path\` import ` +
      'lines are not expanded by darwin, so inline what they refer to instead of copying the lines.'
    );
  }
  return (
    `darwin loaded \`${loaded.filename}\` (${loaded.bytes} bytes) at startup, so improve that file in ` +
    'place: keep everything that is still true, correct what is stale, fill the gaps the ' +
    'inspection reveals, and never overwrite it wholesale.' +
    (loaded.truncated
      ? ` It is currently over the ${CAP_KIB} KiB cap and is being truncated \u2014 bring it back under.`
      : '')
  );
}

/**
 * The fixed instruction template. It names the inspection to do, states the
 * situation the runtime already knows, and restates the two facts the model
 * cannot see from the repository alone: that darwin preloads the file into every
 * request (falling back to `CLAUDE.md` only when there is no `AGENTS.md`), and the
 * hard size cap. It asks for nothing a typed prompt could not ask for.
 */
function initPrompt(context: InitCommandContext, focus: string): string {
  return (
    'Set up this repository\u2019s instructions for darwin.\n\n' +
    'First inspect the repository: its build, test and typecheck commands (package manifests, ' +
    'Makefiles, CI workflows, task runners), the directory layout, the conventions the code ' +
    'actually follows (formatting, naming, test placement, commit style), and any existing ' +
    `instruction sources \u2014 ${INSTRUCTION_SOURCES.join(', ')} \u2014 whose still-true guidance ` +
    'belongs in one place.\n\n' +
    `Then write \`${AGENTS_FILENAME}\`. ${situation(context)} darwin preloads \`${AGENTS_FILENAME}\` ` +
    'into the system prompt of every request in a session; it falls back to ' +
    `\`${CLAUDE_FILENAME}\` only when there is no \`${AGENTS_FILENAME}\` at all. Write the file with ` +
    'the ordinary file editor, so the write is reviewed like any other edit. Keep it concise and ' +
    'factual: what the project is, the exact commands to build, test and typecheck, where things ' +
    'live, the conventions a change must follow, and what to verify before calling work done. ' +
    `The hard cap is ${CAP_KIB} KiB (${MAX_INSTRUCTIONS_BYTES} bytes) \u2014 darwin truncates anything ` +
    'past it \u2014 so aim well below that, a few KiB at most. Do not state commands or facts you did ' +
    'not verify in the repository, and do not include secrets or generated content.' +
    (focus === '' ? '' : `\n\nFocus: ${focus}`)
  );
}

/**
 * Recognizes `/init`, leaving all other input untouched (`null`). The bare form
 * expands to the fixed prompt; `/init <focus>` appends the focus verbatim under a
 * `Focus:` marker.
 */
export function parseInitCommand(
  input: string,
  context: InitCommandContext,
): { message: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const withoutSlash = trimmed.slice(1);
  const separator = withoutSlash.search(/\s/);
  const name = separator === -1 ? withoutSlash : withoutSlash.slice(0, separator);
  if (name.toLowerCase() !== INIT_COMMAND_NAME) return null;

  const focus = separator === -1 ? '' : withoutSlash.slice(separator).trim();
  return { message: initPrompt(context, focus) };
}

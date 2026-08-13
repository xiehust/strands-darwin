/**
 * Project instructions preloaded from AGENTS.md.
 *
 * Only the run directory's own `AGENTS.md` is read: no walking up to parent
 * directories and no merging of several files, so what reaches the model is
 * exactly the file sitting next to the repository the user is working in.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const AGENTS_FILENAME = 'AGENTS.md';

/**
 * Instructions past this size are truncated rather than sent whole.
 *
 * AGENTS.md goes into the system prompt, so it is re-sent with every request of
 * the session; an oversized file would silently spend the context budget the
 * conversation itself needs.
 */
export const MAX_INSTRUCTIONS_BYTES = 32 * 1024;

export interface ProjectInstructions {
  /** Absolute path of the file that was read. */
  path: string;
  /** Size on disk, in bytes, before any truncation. */
  bytes: number;
  /** True when only the first {@link MAX_INSTRUCTIONS_BYTES} were kept. */
  truncated: boolean;
  /** The system-prompt fragment, delimited and labelled with its source. */
  fragment: string;
}

/** What a UI needs to report the load; the fragment itself is not displayable. */
export type ProjectInstructionsSummary = Omit<ProjectInstructions, 'fragment'>;

export interface ProjectInstructionsLoad {
  /** What to inject, or undefined when there is nothing usable to inject. */
  instructions: ProjectInstructions | undefined;
  /**
   * Why an AGENTS.md that is present could not be used. Undefined both when the
   * file loaded and when there is no file at all — those two need no reporting.
   */
  problem: string | undefined;
}

/**
 * Reads `<projectRoot>/AGENTS.md`.
 *
 * A broken file never blocks startup — the agent works without project
 * instructions — but the two ways of ending up without them are not the same. No
 * file is the normal case and stays silent; a file that exists and cannot be read
 * (a directory in its place, no read permission) is reported, since otherwise the
 * user has rules they believe are in effect and nothing on screen contradicts
 * that. Same isolation rule as a broken skill directory: skip it, say why.
 *
 * An empty or whitespace-only file is silently skipped: injecting the delimiters
 * with nothing between them would only point the model at emptiness.
 */
export async function loadProjectInstructions(
  projectRoot: string,
): Promise<ProjectInstructionsLoad> {
  const filePath = path.join(projectRoot, AGENTS_FILENAME);

  let raw: Buffer;
  try {
    raw = await readFile(filePath);
  } catch (error) {
    return { instructions: undefined, problem: isMissingFile(error) ? undefined : describe(error) };
  }

  const bytes = raw.byteLength;
  const truncated = bytes > MAX_INSTRUCTIONS_BYTES;
  const text = truncated
    ? clipToLastLine(raw.subarray(0, MAX_INSTRUCTIONS_BYTES))
    : raw.toString('utf8');

  if (text.trim() === '') return { instructions: undefined, problem: undefined };

  return {
    instructions: {
      path: filePath,
      bytes,
      truncated,
      fragment: renderFragment(text.trimEnd(), truncated),
    },
    problem: undefined,
  };
}

/**
 * Places project instructions directly after the base prompt.
 *
 * The order of the assembled prompt is fixed: base prompt → project instructions
 * → the skills catalogue, which `SkillsPlugin.initAgent` appends later during
 * `agent.initialize()`. Instructions belong with the base prompt because they
 * describe how to work in this repository; the skills list is a menu and reads
 * better last.
 */
export function composeSystemPrompt(
  basePrompt: string,
  instructions: ProjectInstructions | undefined,
): string {
  if (instructions === undefined) return basePrompt;
  return `${basePrompt}\n\n${instructions.fragment}`;
}

/**
 * True when the file is simply not there.
 *
 * `ENOTDIR` counts: a path component that is a file rather than a directory means
 * there is no AGENTS.md at that location either.
 */
function isMissingFile(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Decodes a byte-truncated slice, dropping the final partial line.
 *
 * A cut at a byte offset can land inside a multi-byte character or halfway
 * through a sentence. `StringDecoder` holds back an incomplete trailing sequence
 * instead of emitting a replacement character for it — `Buffer.toString()` would
 * put a `�` at the end of the instructions — and trimming to the last newline
 * keeps what the model reads to whole lines.
 */
function clipToLastLine(slice: Buffer): string {
  const decoded = new StringDecoder('utf8').write(slice);
  const lastNewline = decoded.lastIndexOf('\n');
  return lastNewline === -1 ? decoded : decoded.slice(0, lastNewline);
}

/**
 * Wraps the text in a labelled block. The source attribute matters: the model has
 * to be able to tell these instructions came from the project's own file rather
 * than from darwin itself, since only one of the two is something the user can edit.
 */
function renderFragment(text: string, truncated: boolean): string {
  const attributes = truncated
    ? `source="${AGENTS_FILENAME}" truncated="true"`
    : `source="${AGENTS_FILENAME}"`;

  return [
    `<project-instructions ${attributes}>`,
    text,
    ...(truncated
      ? [`(This file is larger than ${MAX_INSTRUCTIONS_BYTES / 1024} KB and was cut off here.)`]
      : []),
    '</project-instructions>',
  ].join('\n');
}

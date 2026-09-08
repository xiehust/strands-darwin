/**
 * Project instructions preloaded from AGENTS.md — or, when there is none, CLAUDE.md.
 *
 * Only the run directory's own file is read: no walking up to parent directories
 * and no merging of several files, so what reaches the model is exactly one file
 * sitting next to the repository the user is working in. There is exactly one
 * fallback name and it is fixed: `CLAUDE.md` (Claude Code's convention) is tried
 * only when `AGENTS.md` does not exist at all. An `AGENTS.md` that is present but
 * unusable decides the outcome by itself; when both files exist, `CLAUDE.md` is
 * never opened.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const AGENTS_FILENAME = 'AGENTS.md';
/** Read only when {@link AGENTS_FILENAME} does not exist. */
export const CLAUDE_FILENAME = 'CLAUDE.md';

export type InstructionsFilename = typeof AGENTS_FILENAME | typeof CLAUDE_FILENAME;

/** Lookup order — the first file that exists decides, whether or not it can be read. */
const INSTRUCTIONS_FILENAMES: readonly InstructionsFilename[] = [AGENTS_FILENAME, CLAUDE_FILENAME];

/**
 * One fixed line for the CLAUDE.md case only. Claude Code expands `@path` lines
 * into the referenced files; darwin does not, so without this the model would
 * take an import line for content it has already been given.
 */
export const CLAUDE_IMPORT_NOTICE =
  `(Loaded from ${CLAUDE_FILENAME} because there is no ${AGENTS_FILENAME}. ` +
  '`@path` import lines are not expanded by darwin: they are literal text here, not loaded content.)';

/**
 * Instructions past this size are truncated rather than sent whole.
 *
 * AGENTS.md goes into the system prompt, so it is re-sent with every request of
 * the session; an oversized file would silently spend the context budget the
 * conversation itself needs.
 */
export const MAX_INSTRUCTIONS_BYTES = 32 * 1024;

export interface ProjectInstructions {
  /** Which of the two names was actually loaded. */
  filename: InstructionsFilename;
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
   * Why a file that is present could not be used. Undefined both when a file
   * loaded and when there is no file at all — those two need no reporting.
   */
  problem: string | undefined;
  /** The file `problem` is about; undefined exactly when `problem` is. */
  problemFile: InstructionsFilename | undefined;
}

/**
 * Reads `<projectRoot>/AGENTS.md`, or `<projectRoot>/CLAUDE.md` when the former
 * does not exist.
 *
 * A broken file never blocks startup — the agent works without project
 * instructions — but the two ways of ending up without them are not the same. No
 * file is the normal case and stays silent; a file that exists and cannot be read
 * (a directory in its place, no read permission) is reported, since otherwise the
 * user has rules they believe are in effect and nothing on screen contradicts
 * that. Same isolation rule as a broken skill directory: skip it, say why.
 *
 * Only a truly missing `AGENTS.md` moves on to `CLAUDE.md`: an unreadable one is
 * reported as such and never falls through, because the file the user wrote
 * rules into is the one that must decide. Whichever file is found first is the
 * only one opened.
 *
 * An empty or whitespace-only file is silently skipped: injecting the delimiters
 * with nothing between them would only point the model at emptiness.
 */
export async function loadProjectInstructions(
  projectRoot: string,
): Promise<ProjectInstructionsLoad> {
  for (const filename of INSTRUCTIONS_FILENAMES) {
    const filePath = path.join(projectRoot, filename);

    let raw: Buffer;
    try {
      raw = await readFile(filePath);
    } catch (error) {
      if (isMissingFile(error)) continue;
      return { instructions: undefined, problem: describe(error), problemFile: filename };
    }

    const bytes = raw.byteLength;
    const truncated = bytes > MAX_INSTRUCTIONS_BYTES;
    const text = truncated
      ? clipToLastLine(raw.subarray(0, MAX_INSTRUCTIONS_BYTES))
      : raw.toString('utf8');

    if (text.trim() === '') return { instructions: undefined, problem: undefined, problemFile: undefined };

    return {
      instructions: {
        filename,
        path: filePath,
        bytes,
        truncated,
        fragment: renderFragment(text.trimEnd(), truncated, filename),
      },
      problem: undefined,
      problemFile: undefined,
    };
  }

  return { instructions: undefined, problem: undefined, problemFile: undefined };
}

/**
 * Places project instructions directly after the base prompt.
 *
 * The order of the assembled request is fixed: base prompt → project instructions
 * → the official skills catalogue injected before invocation → working context →
 * final cache point. Instructions belong with the base prompt because they
 * describe how to work in this repository; the skills list is a menu and reads
 * better last, and the working context is not rules at all.
 */
export function composeSystemPrompt(
  basePrompt: string,
  instructions: Pick<ProjectInstructions, 'fragment'> | undefined,
): string {
  if (instructions === undefined) return basePrompt;
  return `${basePrompt}\n\n${instructions.fragment}`;
}

/**
 * True when the file is simply not there — the only case that moves on to the
 * fallback name.
 *
 * `ENOTDIR` counts: a path component that is a file rather than a directory means
 * there is no such file at that location either.
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
 * than from darwin itself, since only one of the two is something the user can edit
 * — and which file, since a CLAUDE.md may lean on Claude Code features (its
 * `@path` imports) that darwin does not provide; {@link CLAUDE_IMPORT_NOTICE} says
 * so once, in that case only.
 */
function renderFragment(text: string, truncated: boolean, filename: InstructionsFilename): string {
  const attributes = truncated
    ? `source="${filename}" truncated="true"`
    : `source="${filename}"`;

  return [
    `<project-instructions ${attributes}>`,
    ...(filename === CLAUDE_FILENAME ? [CLAUDE_IMPORT_NOTICE] : []),
    text,
    ...(truncated
      ? [`(This file is larger than ${MAX_INSTRUCTIONS_BYTES / 1024} KB and was cut off here.)`]
      : []),
    '</project-instructions>',
  ].join('\n');
}

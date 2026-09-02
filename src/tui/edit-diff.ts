/**
 * Line-diff projection of a `fileEditor` write input.
 *
 * The permission gate has always exposed the raw tool input "for a UI that wants
 * to show or diff it itself" (`PermissionRequest.input`); this module is that UI's
 * projection. It is pure and dependency-free on purpose: the diff is computed from
 * the strings already in the input — `str_replace` diffs `old_str` against
 * `new_str`, `create`/`insert` are all additions — so **no file is ever read** and
 * nothing here can disagree with what approving actually writes.
 *
 * Output vocabulary is three two-character plain-text markers, chosen so the
 * distinction survives ANSI stripping, monochrome terminals and pty tests
 * (`.trellis/spec/frontend/tui-testing.md` § visual hierarchy):
 *
 *   `- ` removed line · `+ ` added line · `  ` context line
 *
 * Information equivalence is structural, not aspirational: every source line
 * appears exactly once under its marker, so stripping the two-character marker
 * recovers the old value from the `- `/`  ` lines and the new value from the
 * `+ `/`  ` lines. That also keeps "delete the matched text" (`new_str` absent —
 * removals only) distinguishable from "replace with the empty string" (`new_str`
 * of `''` — removals plus one empty addition). Bounding is *not* done here: the
 * diff text flows through the same `permissionDetail` / `expandedToolInput`
 * budgets as every other block, so truncation stays explicit and single-sourced.
 *
 * Everything vivid is derived from those same markers and never rewrites them:
 * {@link diffStat} counts them, {@link diffLineEmphasis} pairs them into replaced
 * lines and names the changed span — both projections of the diff text, so the
 * ANSI-stripped output stays byte-identical to the plain diff.
 */
import type { PermissionDetail } from '../agent/permission.js';

/** Markers are prepended verbatim; {@link diffLineTone} reads them back. */
export const DIFF_ADDED = '+ ';
export const DIFF_REMOVED = '- ';
export const DIFF_CONTEXT = '  ';

/**
 * The one header row a `str_replace` carrying `replace_all: true` adds to its
 * projections (SER-055). Input-derived like everything else here: the diff still
 * shows the one `old_str` → `new_str` pair the model sent, and this row states
 * that the pair applies to every occurrence — the file is never read to count
 * them. It is a header row, not a marker line, so {@link diffLineTone} and
 * {@link diffStat} ignore it and the `+N -N` stat stays the one pair's.
 */
export const REPLACE_ALL_ROW = 'replace_all: every occurrence';

/**
 * LCS matrix cap. Above this the middle (after common prefix/suffix trim) falls
 * back to remove-all/add-all — still information-equivalent, just without
 * interleaving — so a pathological input costs alignment quality, never a stall.
 */
const LCS_CELL_LIMIT = 40_000;

/** The semantic tone of one marker-prefixed diff line; `undefined` for context and markers. */
export function diffLineTone(line: string): 'add' | 'remove' | undefined {
  if (line.startsWith(DIFF_ADDED) || line === '+') return 'add';
  if (line.startsWith(DIFF_REMOVED) || line === '-') return 'remove';
  return undefined;
}

/** Added/removed line counts of one marker-prefixed diff text. */
export interface DiffStat {
  readonly added: number;
  readonly removed: number;
}

/**
 * Change stats derived from the same marker vocabulary the diff states — never a
 * second diff calculation, so the counts cannot disagree with the rows shown.
 * Compute it on the *untruncated* diff: a bounded excerpt has fewer rows, and the
 * stat's job is to state the whole edit's size on the one row that always fits.
 */
export function diffStat(diffText: string): DiffStat {
  let added = 0;
  let removed = 0;
  for (const line of diffText.split('\n')) {
    const tone = diffLineTone(line);
    if (tone === 'add') added += 1;
    else if (tone === 'remove') removed += 1;
  }
  return { added, removed };
}

/** The one textual shape of a stat: `+N -N`, assertable after ANSI stripping. */
export function formatDiffStat(stat: DiffStat): string {
  return `+${stat.added} -${stat.removed}`;
}

/**
 * The intraline changed span of one diff line, as UTF-16 offsets into the full
 * marker-prefixed line text. Enhancement only (bold layered over the row tone):
 * it never changes any text, so ANSI-stripped output stays byte-identical to the
 * plain diff and the two-character markers remain the durable statement.
 */
export interface DiffEmphasis {
  readonly start: number;
  readonly end: number;
}

/**
 * Per-line intraline emphasis for marker-prefixed diff lines, index-aligned with
 * `lines`.
 *
 * A changed run — consecutive `- ` lines followed immediately by consecutive
 * `+ ` lines — is treated as replaced line pairs **only when it has equally many
 * removals and additions**; the k-th removal is paired with the k-th addition,
 * mirroring how `diffMiddle` prints removals before the additions of the same
 * run. For each pair the common code-point prefix and suffix are trimmed (never
 * splitting a surrogate pair) and the middle is the emphasis span. Pairs that
 * share no edge context are unrelated lines, not an intraline edit, and an empty
 * middle says nothing — both yield `undefined`, as do context lines, unequal
 * runs and the bare `+`/`-` a truncation can leave.
 */
export function diffLineEmphasis(lines: readonly string[]): readonly (DiffEmphasis | undefined)[] {
  const out: (DiffEmphasis | undefined)[] = lines.map(() => undefined);
  let index = 0;
  while (index < lines.length) {
    if (!(lines[index] as string).startsWith(DIFF_REMOVED)) {
      index += 1;
      continue;
    }
    const removedStart = index;
    while (index < lines.length && (lines[index] as string).startsWith(DIFF_REMOVED)) index += 1;
    const addedStart = index;
    while (index < lines.length && (lines[index] as string).startsWith(DIFF_ADDED)) index += 1;
    const removedCount = addedStart - removedStart;
    const addedCount = index - addedStart;
    if (removedCount !== addedCount) continue;
    for (let pair = 0; pair < removedCount; pair += 1) {
      const removedIndex = removedStart + pair;
      const addedIndex = addedStart + pair;
      const [removedSpan, addedSpan] = pairEmphasis(
        lines[removedIndex] as string,
        lines[addedIndex] as string,
      );
      out[removedIndex] = removedSpan;
      out[addedIndex] = addedSpan;
    }
  }
  return out;
}

/**
 * The three slices an emphasis span splits a text into. Pure string slicing, so
 * every renderer that bolds a span draws exactly the same characters it would
 * have drawn plain — concatenating the slices is the identity.
 */
export function emphasisSpans(text: string, emphasis: DiffEmphasis): { pre: string; mid: string; post: string } {
  return {
    pre: text.slice(0, emphasis.start),
    mid: text.slice(emphasis.start, emphasis.end),
    post: text.slice(emphasis.end),
  };
}

/** Common code-point prefix/suffix trim of one replaced line pair, marker included. */
function pairEmphasis(
  removedLine: string,
  addedLine: string,
): [DiffEmphasis | undefined, DiffEmphasis | undefined] {
  const removed = [...removedLine.slice(DIFF_REMOVED.length)];
  const added = [...addedLine.slice(DIFF_ADDED.length)];
  let prefix = 0;
  while (prefix < removed.length && prefix < added.length && removed[prefix] === added[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < removed.length - prefix &&
    suffix < added.length - prefix &&
    removed[removed.length - 1 - suffix] === added[added.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  // No shared edge at all: two unrelated lines, not one edited line.
  if (prefix === 0 && suffix === 0) return [undefined, undefined];

  const span = (content: readonly string[], marker: string): DiffEmphasis | undefined => {
    if (content.length - prefix - suffix <= 0) return undefined;
    const start = marker.length + content.slice(0, prefix).join('').length;
    const end = start + content.slice(prefix, content.length - suffix).join('').length;
    return { start, end };
  };
  return [span(removed, DIFF_REMOVED), span(added, DIFF_ADDED)];
}

/**
 * The marker-prefixed line diff of one `fileEditor` write input, or `undefined`
 * when the input is not a well-formed write — the caller then falls back to the
 * raw presentation, so a shape this module does not recognize loses nothing.
 */
export function fileEditorDiff(rawInput: unknown): string | undefined {
  const edit = readEdit(rawInput);
  if (edit === undefined) return undefined;
  switch (edit.command) {
    case 'create':
      return allLines(DIFF_ADDED, edit.fileText ?? '');
    case 'insert':
      return allLines(DIFF_ADDED, edit.newStr ?? '');
    case 'str_replace':
      return lineDiff(
        (edit.oldStr ?? '').split('\n'),
        // Absent `new_str` deletes the matched text: removals only, which stays
        // distinguishable from an explicit empty replacement (`['']` — one `+ ` line).
        edit.newStr === undefined ? [] : edit.newStr.split('\n'),
      ).join('\n');
  }
}

/**
 * The expanded-input projection for the same calls: the non-content input fields
 * as labelled header lines, then the diff. Same information as the JSON it
 * replaces, in the shape the permission box already taught the user to read.
 */
export function fileEditorInputProjection(rawInput: unknown): string | undefined {
  const diff = fileEditorDiff(rawInput);
  const edit = readEdit(rawInput);
  if (diff === undefined || edit === undefined) return undefined;
  const header = [`command: ${edit.command}`, `path: ${edit.path}`];
  if (edit.command === 'insert') header.push(`insert line: ${edit.insertLine}`);
  if (edit.replaceAll === true) header.push(REPLACE_ALL_ROW);
  return `${header.join('\n')}\n${diff}`;
}

/**
 * Whether a `fileEditor` input is a recognized `str_replace` carrying
 * `replace_all: true` — the one fact the compact finished row states above the
 * bare diff. `false`, absent, or any unrecognized shape is `false`.
 */
export function fileEditorReplaceAll(rawInput: unknown): boolean {
  const edit = readEdit(rawInput);
  return edit?.command === 'str_replace' && edit.replaceAll === true;
}

/** One permission detail block as the box should draw it. */
export interface PermissionDisplayDetail {
  label: string;
  value: string;
  /** Whether the value is diff text whose rows carry {@link diffLineTone} colour. */
  diff: boolean;
}

/**
 * The detail blocks the permission box presents.
 *
 * For a `fileEditor` write whose input yields a diff, the gate's `editContent`
 * blocks — and only those — collapse into one `Diff` block at the position of the
 * first; `Path`, `Operation`, `At line` and an escalated `Classifier` block stay
 * stated exactly as classified. Everything else (any other tool, or an input
 * {@link fileEditorDiff} does not recognize) passes through untouched, so this
 * projection can degrade but never omit.
 */
export function permissionDisplayDetails(request: {
  readonly toolName: string;
  readonly details: readonly PermissionDetail[];
  readonly input: unknown;
}): PermissionDisplayDetail[] {
  const raw = request.details.map((detail) => ({ label: detail.label, value: detail.value, diff: false }));
  if (request.toolName !== 'fileEditor' || !request.details.some((detail) => detail.editContent === true)) {
    return raw;
  }
  const diff = fileEditorDiff(request.input);
  if (diff === undefined) return raw;

  const out: PermissionDisplayDetail[] = [];
  let replaced = false;
  for (const detail of request.details) {
    if (detail.editContent === true) {
      if (!replaced) {
        // The stat is derived from the full diff's own markers and rides the
        // existing label — never a detail row of its own, so the box's counted
        // geometry gains nothing.
        out.push({ label: `Diff (${formatDiffStat(diffStat(diff))})`, value: diff, diff: true });
        replaced = true;
      }
      continue;
    }
    out.push({ label: detail.label, value: detail.value, diff: false });
  }
  return out;
}

interface FileEditorEdit {
  command: 'create' | 'str_replace' | 'insert';
  path: string;
  fileText?: string;
  oldStr?: string;
  newStr?: string;
  insertLine?: number;
  /** `str_replace` only: the input's own `replace_all` flag, when it is a boolean. */
  replaceAll?: boolean;
}

/**
 * Narrow reader for the three write shapes. Anything unexpected — an unknown
 * command, a wrong field type, an extra key this module would silently drop —
 * returns `undefined` so the raw presentation keeps stating it.
 */
function readEdit(rawInput: unknown): FileEditorEdit | undefined {
  if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) return undefined;
  const input = rawInput as Record<string, unknown>;
  const command = input['command'];
  const path = input['path'];
  if (typeof path !== 'string') return undefined;

  const expected: Record<string, readonly string[]> = {
    create: ['command', 'path', 'file_text'],
    str_replace: ['command', 'path', 'old_str', 'new_str', 'replace_all'],
    insert: ['command', 'path', 'insert_line', 'new_str'],
  };
  if (typeof command !== 'string' || !(command in expected)) return undefined;
  const allowed = expected[command] as readonly string[];
  if (Object.keys(input).some((key) => !allowed.includes(key))) return undefined;

  const optionalString = (key: string): string | undefined => {
    const value = input[key];
    return typeof value === 'string' ? value : undefined;
  };

  switch (command) {
    case 'create': {
      if (typeof input['file_text'] !== 'string') return undefined;
      return { command, path, fileText: input['file_text'] };
    }
    case 'str_replace': {
      if (typeof input['old_str'] !== 'string') return undefined;
      if (input['new_str'] !== undefined && typeof input['new_str'] !== 'string') return undefined;
      // The SDK schema types `replace_all` as an optional boolean; anything else
      // is a shape this reader does not recognize and the raw blocks keep stating.
      const replaceAll = input['replace_all'];
      if (replaceAll !== undefined && typeof replaceAll !== 'boolean') return undefined;
      const newStr = optionalString('new_str');
      return {
        command,
        path,
        oldStr: input['old_str'],
        ...(newStr === undefined ? {} : { newStr }),
        ...(replaceAll === undefined ? {} : { replaceAll }),
      };
    }
    case 'insert': {
      if (typeof input['new_str'] !== 'string' || typeof input['insert_line'] !== 'number') return undefined;
      return { command, path, newStr: input['new_str'], insertLine: input['insert_line'] };
    }
    default:
      return undefined;
  }
}

function allLines(marker: string, text: string): string {
  return text.split('\n').map((line) => `${marker}${line}`).join('\n');
}

/**
 * Hand-rolled line diff: common prefix/suffix as context, an LCS alignment for
 * the middle, removals before additions within each changed run.
 */
function lineDiff(oldLines: readonly string[], newLines: readonly string[]): string[] {
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start += 1;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  const out: string[] = [];
  for (let i = 0; i < start; i += 1) out.push(`${DIFF_CONTEXT}${oldLines[i]}`);
  out.push(...diffMiddle(oldLines.slice(start, oldEnd), newLines.slice(start, newEnd)));
  for (let i = oldEnd; i < oldLines.length; i += 1) out.push(`${DIFF_CONTEXT}${oldLines[i]}`);
  return out;
}

function diffMiddle(oldLines: readonly string[], newLines: readonly string[]): string[] {
  if (oldLines.length === 0) return newLines.map((line) => `${DIFF_ADDED}${line}`);
  if (newLines.length === 0) return oldLines.map((line) => `${DIFF_REMOVED}${line}`);
  if (oldLines.length * newLines.length > LCS_CELL_LIMIT) {
    return [
      ...oldLines.map((line) => `${DIFF_REMOVED}${line}`),
      ...newLines.map((line) => `${DIFF_ADDED}${line}`),
    ];
  }

  // Classic LCS length table; walked back into remove/add/context runs.
  const width = newLines.length + 1;
  const table = new Uint32Array((oldLines.length + 1) * width);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = oldLines[i] === newLines[j]
        ? (table[(i + 1) * width + j + 1] as number) + 1
        : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  let pendingAdds: string[] = [];
  const flushAdds = (): void => {
    out.push(...pendingAdds);
    pendingAdds = [];
  };
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      flushAdds();
      out.push(`${DIFF_CONTEXT}${oldLines[i]}`);
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) {
      // Removals print before the additions of the same changed run.
      out.push(`${DIFF_REMOVED}${oldLines[i]}`);
      i += 1;
    } else {
      pendingAdds.push(`${DIFF_ADDED}${newLines[j]}`);
      j += 1;
    }
  }
  while (i < oldLines.length) {
    out.push(`${DIFF_REMOVED}${oldLines[i]}`);
    i += 1;
  }
  flushAdds();
  while (j < newLines.length) {
    out.push(`${DIFF_ADDED}${newLines[j]}`);
    j += 1;
  }
  return out;
}

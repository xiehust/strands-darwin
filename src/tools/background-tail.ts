/**
 * Bounded tail reader over a background job's log file, for the `/tasks` report.
 *
 * Deliberately separate from `BackgroundBashManager.readOutput`: that path owns the
 * model-facing byte cursor (`bash output` / `wait` offsets, the 64 KiB accounting) and a
 * user glance at `/tasks` must never move it. This reader opens the file itself, reads at
 * most the last `TASK_TAIL_WINDOW_BYTES`, and returns display lines — it holds no state,
 * imports nothing from the manager and cannot throw.
 */
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

/** Recent non-empty lines shown under each job row. */
export const TASK_TAIL_LINES = 3;
/** Largest slice read from the end of a log per `/tasks`; long lines beyond it are cut. */
export const TASK_TAIL_WINDOW_BYTES = 8 * 1024;
/** Tabs cannot render predictably inside one `<Text>` row; a fixed replacement keeps columns stable. */
const TAB_REPLACEMENT = '    ';

export type BackgroundTail =
  | { readonly kind: 'lines'; readonly lines: readonly string[]; readonly bytesRead: number }
  | { readonly kind: 'empty'; readonly bytesRead: number }
  | { readonly kind: 'unavailable' };

// CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`), and the remaining two-byte ESC sequences.
const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// Every other C0 control plus DEL; tabs are handled first so they can be expanded.
const CONTROL_CHARACTERS = /[\x00-\x08\x0a-\x1f\x7f]/g;

/** Makes one raw log line safe for a single transcript row: no escapes, no tabs, no trailing blanks. */
export function sanitizeTailLine(line: string): string {
  return line
    .replace(ANSI_SEQUENCE, '')
    .replace(/\t/g, TAB_REPLACEMENT)
    .replace(CONTROL_CHARACTERS, '')
    .trimEnd();
}

/**
 * Reads the last `TASK_TAIL_LINES` non-empty lines of `outputPath` without touching any
 * manager state. Never rejects: every failure is `{ kind: 'unavailable' }`.
 */
export async function readBackgroundTail(
  outputPath: string,
  options: { readonly windowBytes?: number } = {},
): Promise<BackgroundTail> {
  const windowBytes = Math.max(1, Math.floor(options.windowBytes ?? TASK_TAIL_WINDOW_BYTES));

  let handle: FileHandle | undefined;
  let text: string;
  let bytesRead: number;
  let startedAtByteZero: boolean;
  try {
    handle = await open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) return { kind: 'unavailable' };
    const start = Math.max(0, metadata.size - windowBytes);
    startedAtByteZero = start === 0;
    const length = metadata.size - start;
    if (length === 0) return { kind: 'empty', bytesRead: 0 };
    const buffer = Buffer.allocUnsafe(length);
    ({ bytesRead } = await handle.read(buffer, 0, length, start));
    text = buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return { kind: 'unavailable' };
  } finally {
    await handle?.close().catch(() => undefined);
  }

  const segments = text.split(/\r\n|\n|\r/);
  // A window that starts mid-file usually starts mid-line (and possibly mid-code-point):
  // drop that fragment when a complete line follows it.
  if (!startedAtByteZero && segments.length > 1) segments.shift();
  const lines = segments.map(sanitizeTailLine).filter((line) => line.trim() !== '');
  if (lines.length === 0) return { kind: 'empty', bytesRead };
  return { kind: 'lines', lines: lines.slice(Math.max(0, lines.length - TASK_TAIL_LINES)), bytesRead };
}

/** One tail per task, keyed by id, all settled before the caller composes its single notice. */
export async function readBackgroundTails(
  tasks: readonly { readonly taskId: string; readonly outputPath: string }[],
): Promise<Map<string, BackgroundTail>> {
  const entries = await Promise.all(
    tasks.map(async (task) => [task.taskId, await readBackgroundTail(task.outputPath)] as const),
  );
  return new Map(entries);
}

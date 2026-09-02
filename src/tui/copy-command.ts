/**
 * `/copy` — the last completed answer's committed text onto the clipboard.
 *
 * The text is exactly what the `<Static>` transcript holds and `/export` writes: the
 * answer's `AnswerPart` pieces (`turn-state.ts`) joined by newlines, empty closing
 * pieces contributing nothing — the same rule `formatReplay` applies. Nothing is
 * re-read from disk, re-derived from the model, or recorded: this module reads
 * history, writes one OSC 52 sequence through the writer it is handed, and at most
 * runs one platform clipboard helper. It never touches `Ctrl+O` (image attach).
 */
import { spawn } from 'node:child_process';

import type { HistoryItem } from './turn-state.js';

/**
 * UTF-8 bytes of answer text one `/copy` may carry. Base64 grows the OSC 52
 * payload by 4/3, and terminals cap the sequence they accept; 256 KiB of text is
 * far more than an answer, and a longer one is stated as `copied N of M bytes`
 * rather than silently cut by the terminal.
 */
export const MAX_COPY_BYTES = 262_144;
export const COPY_TOOL_TIMEOUT_MS = 5_000;
export const COPY_COMMAND_USAGE = '/copy takes no arguments';
export const NOTHING_TO_COPY_NOTICE =
  'nothing to copy — no completed answer in this session yet';

export interface CopyPayload {
  /** The bytes both transports receive: the answer, cut on a code-point boundary at the cap. */
  readonly bytes: Buffer;
  readonly copiedBytes: number;
  readonly totalBytes: number;
}

export interface ClipboardWriteCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface CopyToolOutcome {
  readonly name: string;
  /** Present when the helper failed; the failure is stated, never thrown. */
  readonly failure?: string;
}

export interface CopyCommandOptions {
  readonly history: readonly HistoryItem[];
  /** Ink's stdout writer (`useStdout().write`) — the existing output path. */
  readonly writeToTerminal: (data: string) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly timeoutMs?: number;
  /** Test seam: replaces the spawn-based helper; resolves to a failure message or nothing. */
  readonly runTool?: (
    selected: ClipboardWriteCommand,
    bytes: Buffer,
  ) => Promise<string | undefined>;
}

export interface CopyCommandResult {
  readonly text: string;
  readonly severity: 'info' | 'warn';
}

/**
 * The newest answer whose closing piece (`whole` or `last`) is in history.
 *
 * An answer still arriving has `first`/`middle` pieces and no `last` yet, so scanning
 * back from the end skips it and lands on the previous completed one — which is what
 * a mid-turn `/copy` should copy. Non-assistant items between the pieces of one
 * answer (a notice) are stepped over; the previous answer's own close ends the walk.
 */
export function latestCompletedAnswer(history: readonly HistoryItem[]): string | undefined {
  for (let end = history.length - 1; end >= 0; end -= 1) {
    const closing = history[end] as HistoryItem;
    if (closing.kind !== 'assistant') continue;
    if (closing.part === 'first' || closing.part === 'middle') continue;
    if (closing.part === 'whole') return closing.text;

    const pieces = [closing.text];
    for (let start = end - 1; start >= 0; start -= 1) {
      const piece = history[start] as HistoryItem;
      if (piece.kind !== 'assistant') continue;
      if (piece.part === 'whole' || piece.part === 'last') break;
      pieces.unshift(piece.text);
      if (piece.part === 'first') break;
    }
    return pieces.filter((text) => text !== '').join('\n');
  }
  return undefined;
}

/** Cuts the UTF-8 bytes at the cap on a code-point boundary, counting what was left. */
export function boundCopyPayload(text: string, cap: number = MAX_COPY_BYTES): CopyPayload {
  const whole = Buffer.from(text, 'utf8');
  if (whole.byteLength <= cap) {
    return { bytes: whole, copiedBytes: whole.byteLength, totalBytes: whole.byteLength };
  }
  let cut = cap;
  // A continuation byte (10xxxxxx) means the cap fell inside a code point; back up
  // to the byte that starts it so the copied text stays valid UTF-8.
  while (cut > 0 && ((whole[cut] as number) & 0xc0) === 0x80) cut -= 1;
  return { bytes: whole.subarray(0, cut), copiedBytes: cut, totalBytes: whole.byteLength };
}

/** `ESC ] 52 ; c ; <base64> BEL` — the clipboard selection, base64 of the given bytes. */
export function osc52Sequence(bytes: Uint8Array): string {
  return `\u001B]52;c;${Buffer.from(bytes).toString('base64')}\u0007`;
}

/** The platform copy tool a display makes usable, or nothing (SSH without forwarding). */
export function clipboardCopyCommand(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ClipboardWriteCommand | undefined {
  if (platform === 'darwin') return { command: 'pbcopy', args: [] };
  if (platform !== 'linux') return undefined;
  if (env['WAYLAND_DISPLAY']) return { command: 'wl-copy', args: [] };
  if (env['DISPLAY']) return { command: 'xclip', args: ['-selection', 'clipboard'] };
  return undefined;
}

/**
 * Pipes the bytes into the helper's stdin. Resolves to a failure message, or nothing
 * on success; it never rejects, so a missing or broken tool is a clause of the notice.
 */
export async function writeClipboardCommand(
  selected: ClipboardWriteCommand,
  bytes: Buffer,
  env: NodeJS.ProcessEnv,
  timeoutMs: number = COPY_TOOL_TIMEOUT_MS,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    const finish = (failure?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(failure);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(selected.command, [...selected.args], {
        env,
        shell: false,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
    } catch (error) {
      finish(`${selected.command} failed: ${describe(error)}`);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(`${selected.command} timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    timer.unref();

    child.on('error', (error) => {
      const hint = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `${selected.command} is not installed`
        : `${selected.command} failed: ${describe(error)}`;
      finish(hint);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 512) stderr += chunk.toString('utf8', 0, 512 - stderr.length);
    });
    child.on('close', (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = stderr.trim().replace(/\s+/g, ' ').slice(0, 240);
      finish(
        `${selected.command} exited ${signal ?? code ?? 'without a status'}${detail === '' ? '' : `: ${detail}`}`,
      );
    });
    // EPIPE on a helper that exits early surfaces as 'error' above, never as a throw.
    child.stdin?.on('error', () => {});
    child.stdin?.end(bytes);
  });
}

/** One bounded notice: what was copied, through which transports, and what failed. */
export function formatCopyNotice(
  payload: CopyPayload,
  tool: CopyToolOutcome | undefined,
): CopyCommandResult {
  const truncated = payload.copiedBytes < payload.totalBytes;
  const what = truncated
    ? `copied ${payload.copiedBytes} of ${payload.totalBytes} bytes of the last answer to the clipboard (cap ${MAX_COPY_BYTES} bytes)`
    : `copied the last answer to the clipboard (${payload.totalBytes} bytes)`;
  let via = ' via OSC 52';
  if (tool !== undefined) {
    via += tool.failure === undefined ? ` and ${tool.name}` : `; ${tool.failure}`;
  }
  return {
    text: `${what}${via}`,
    severity: truncated || tool?.failure !== undefined ? 'warn' : 'info',
  };
}

/**
 * Runs `/copy` against the given history: OSC 52 through the terminal writer first,
 * then the platform tool when a display makes one usable. Resolves to the one
 * transcript notice; nothing here throws.
 */
export async function runCopyCommand(options: CopyCommandOptions): Promise<CopyCommandResult> {
  const answer = latestCompletedAnswer(options.history);
  if (answer === undefined) return { text: NOTHING_TO_COPY_NOTICE, severity: 'info' };

  const payload = boundCopyPayload(answer);
  options.writeToTerminal(osc52Sequence(payload.bytes));

  const env = options.env ?? process.env;
  const selected = clipboardCopyCommand(options.platform ?? process.platform, env);
  if (selected === undefined) return formatCopyNotice(payload, undefined);

  const run = options.runTool ??
    ((command: ClipboardWriteCommand, bytes: Buffer) =>
      writeClipboardCommand(command, bytes, env, options.timeoutMs ?? COPY_TOOL_TIMEOUT_MS));
  let failure: string | undefined;
  try {
    failure = await run(selected, payload.bytes);
  } catch (error) {
    failure = `${selected.command} failed: ${describe(error)}`;
  }
  return formatCopyNotice(payload, failure === undefined ? { name: selected.command } : { name: selected.command, failure });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

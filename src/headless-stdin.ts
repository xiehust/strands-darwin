/**
 * Piped standard input for `darwin -p` (SER-050).
 *
 * `git diff | darwin -p "review this"` used to send the sentence and silently drop the
 * diff. In `-p` mode only, and only when stdin is not a terminal, the headless runner
 * reads stdin to EOF and appends it to the one-shot prompt as exactly one delimited
 * block. Everything here is a pure function over an injected source, so the runner's
 * `readPipedStdin` dependency can be fed by tests; the only production caller is
 * `productionHeadlessDependencies` in `headless-runner.ts`. Interactive mode never
 * imports this module.
 *
 * Invariance rule: a TTY stdin is never iterated, and `/dev/null` (`stdio: 'ignore'`),
 * an immediate EOF or whitespace-only bytes yield `undefined`, so the prompt reaches the
 * model byte-identical to before this module existed.
 *
 * The cap refuses rather than truncates: a silently shortened diff reviewed as if whole
 * is the same silent class this feature removes, and the user can `head -c`, filter or
 * name a path in the message instead. Non-UTF-8 or NUL-bearing input is refused too —
 * bytes are never sent as base64.
 */
import { CliUsageError } from './cli-args.js';

/** Hard cap on piped bytes; the first byte past it stops the read and refuses the run. */
export const PIPED_STDIN_MAX_BYTES = 256 * 1024;

/** The fixed fence that names the appended block; `formatPipedStdinHeading` fills in the count. */
export const PIPED_STDIN_HEADING_PREFIX = '--- piped stdin (';
export const PIPED_STDIN_FOOTER = '--- end of piped stdin ---';

/** What the runner needs from `process.stdin`: the TTY flag and async chunk iteration. */
export interface PipedStdinSource {
  readonly isTTY?: boolean | undefined;
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array | string>;
}

/** Non-empty piped text plus the raw byte count the heading states. */
export interface PipedStdin {
  readonly text: string;
  readonly bytes: number;
}

export function formatPipedStdinHeading(bytes: number): string {
  return `${PIPED_STDIN_HEADING_PREFIX}${bytes} bytes) ---`;
}

/**
 * Reads a non-TTY source to EOF. Resolves `undefined` for a terminal (never iterated),
 * an immediate EOF, or whitespace-only bytes. Throws `CliUsageError` past the cap, on
 * invalid UTF-8, or on a NUL byte — the same pre-runtime refusal class as a bad flag.
 */
export async function readPipedStdin(
  source: PipedStdinSource,
  maxBytes = PIPED_STDIN_MAX_BYTES,
): Promise<PipedStdin | undefined> {
  if (source.isTTY) return undefined;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of source) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    bytes += buffer.byteLength;
    if (bytes > maxBytes) {
      // Throwing out of `for await` runs the iterator's return(), which destroys a
      // stream source: the producer sees EPIPE instead of darwin draining gigabytes it
      // will refuse anyway.
      throw new CliUsageError(
        `piped standard input exceeds the ${maxBytes}-byte cap for -p; pipe less (for example through head -c) or name a path in the message instead.`,
      );
    }
    chunks.push(buffer);
  }
  if (bytes === 0) return undefined;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new CliUsageError('piped standard input is not UTF-8 text; -p accepts text only.');
  }
  if (text.includes('\u0000')) {
    throw new CliUsageError('piped standard input contains NUL bytes; -p accepts text only.');
  }
  if (text.trim() === '') return undefined;
  return { text, bytes };
}

/**
 * The one model-facing prompt: the argument, a blank line, then the single block. The
 * argument is never altered; a newline is added before the footer only when the text
 * does not already end with one, so `printf 'x'` and `echo x` fence identically.
 */
export function composeHeadlessPrompt(prompt: string, piped: PipedStdin | undefined): string {
  if (piped === undefined) return prompt;
  const body = piped.text.endsWith('\n') ? piped.text : `${piped.text}\n`;
  return `${prompt}\n\n${formatPipedStdinHeading(piped.bytes)}\n${body}${PIPED_STDIN_FOOTER}`;
}

/**
 * Ctrl+G external prompt editing (SER-113): the exact unsent composer text, edited in
 * the user's own `VISUAL` (else `EDITOR`), returned to the composer unsent.
 *
 * Policy. This is explicit user-authorized input editing, not a model tool: it never
 * enters the permission gate (whose subject is model tool calls), never reads
 * repository editor configuration, and never guesses an installed editor. The value is
 * parsed into a bounded argv and spawned **without a shell**; shell operators and
 * substitutions are refused, never interpreted. The child gets darwin's existing
 * sanitized child environment (`scrubShellEnv` + `withDarwinMarker`, the map the
 * model's `bash` gets) and the session cwd; the caller supplies both.
 *
 * Storage. One private random directory (0700) holding one regular file (0600) under
 * the OS temp root, refused if that resolves inside the project. Input and output are
 * capped at {@link EXTERNAL_EDITOR_MAX_CODE_POINTS} code points and
 * {@link EXTERNAL_EDITOR_MAX_BYTES} UTF-8 bytes — oversize is refused, never
 * truncated. The result is read through one bounded descriptor (`O_NOFOLLOW`,
 * `O_NONBLOCK`, regular-file check, at most cap+1 bytes even while the file grows) and
 * decoded as strict UTF-8; only the composer's own `normalizeDraftText` policy is
 * applied. The directory is removed on every settlement path. Editors themselves may
 * write swap/backup files elsewhere; darwin cannot guarantee those are erased.
 *
 * Lifetime. No editing deadline and no automatic retry: editing is a human action.
 * `kill()` (darwin shutdown) TERMs the editor, KILLs it after a grace, and removes the
 * storage synchronously. The editor shares darwin's process group so it owns the
 * foreground terminal; while it runs darwin holds its own SIGINT/SIGQUIT listeners
 * aside (one no-op handles them), so a Ctrl+C typed into a cooked-mode editor ends
 * only the editor and the composer comes back.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { constants as fsConstants, rmSync } from 'node:fs';
import { chmod, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Draft and result cap in Unicode code points — the composer stash/yank cap. */
export const EXTERNAL_EDITOR_MAX_CODE_POINTS = 65_536;
/** Draft and result cap in UTF-8 bytes (256 KiB). */
export const EXTERNAL_EDITOR_MAX_BYTES = 262_144;
/** Longest `VISUAL`/`EDITOR` value parsed, in code points. */
export const EDITOR_COMMAND_MAX_CODE_POINTS = 1_024;
/** Most argv entries (executable included) one editor command may yield. */
export const EDITOR_COMMAND_MAX_ARGS = 32;
/** Grace between the editor's SIGTERM and SIGKILL on darwin shutdown. */
export const EDITOR_KILL_GRACE_MS = 2_000;
/** How long darwin keeps holding SIGINT/SIGQUIT listeners after the editor exits. */
export const TERMINAL_SIGNAL_GRACE_MS = 500;
/** Temporary directory prefix under the OS temp root; the file inside is fixed. */
export const EDITOR_TEMP_PREFIX = 'darwin-editor-';
export const EDITOR_TEMP_FILE = 'prompt.md';

/** The guidance when neither variable is set: no editor is ever guessed. */
export const EXTERNAL_EDITOR_UNSET_NOTICE =
  'Ctrl+G needs an external editor: set VISUAL or EDITOR (for example VISUAL="code --wait") ' +
  'before starting darwin — draft unchanged';

/** Variables consulted, in precedence order. */
export const EDITOR_VARIABLES = ['VISUAL', 'EDITOR'] as const;
export type EditorVariable = (typeof EDITOR_VARIABLES)[number];

export type EditorCommand =
  | { readonly kind: 'command'; readonly source: EditorVariable; readonly argv: readonly string[] }
  | { readonly kind: 'refused'; readonly source: EditorVariable; readonly reason: string }
  | { readonly kind: 'unset' };

/**
 * `VISUAL` first, then `EDITOR`; an unset or blank variable falls through. A set but
 * unparseable value is refused rather than skipped: silently trying the other
 * variable would run an editor the user did not choose.
 */
export function resolveEditorCommand(env: NodeJS.ProcessEnv): EditorCommand {
  for (const source of EDITOR_VARIABLES) {
    const value = env[source];
    if (value === undefined || value.trim() === '') continue;
    const parsed = parseEditorCommand(value);
    return parsed.ok
      ? { kind: 'command', source, argv: parsed.argv }
      : { kind: 'refused', source, reason: parsed.reason };
  }
  return { kind: 'unset' };
}

/**
 * Unquoted characters that only mean something to a shell: operators, redirection,
 * substitution, globbing, expansion, comments and history. Refusing them is the
 * whole "no shell" contract — nothing is interpreted, so nothing may look like it is.
 */
const SHELL_SYNTAX = new Set(['|', '&', ';', '<', '>', '(', ')', '$', '`', '*', '?', '[', ']', '{', '}', '~', '#', '!']);
/** Inside double quotes a shell would still substitute these. */
const DOUBLE_QUOTED_SUBSTITUTION = new Set(['$', '`']);
/** Backslash escapes a shell honours inside double quotes; any other stays literal. */
const DOUBLE_QUOTED_ESCAPES = new Set(['"', '\\', '$', '`']);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/;

/**
 * POSIX-style word splitting without a shell: spaces/tabs separate words, single
 * quotes are literal, double quotes allow `\"`/`\\`, an unquoted backslash escapes
 * the next character. Shell syntax, control characters, unterminated quotes and
 * over-cap values are refused with a reason that never echoes the value.
 */
export function parseEditorCommand(value: string):
  | { readonly ok: true; readonly argv: readonly string[] }
  | { readonly ok: false; readonly reason: string } {
  const points = [...value];
  if (points.length > EDITOR_COMMAND_MAX_CODE_POINTS) {
    return { ok: false, reason: `longer than ${EDITOR_COMMAND_MAX_CODE_POINTS} code points` };
  }
  if (CONTROL.test(value)) return { ok: false, reason: 'contains control characters or newlines' };
  const argv: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < points.length; index += 1) {
    const ch = points[index] as string;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') { quote = undefined; continue; }
      if (DOUBLE_QUOTED_SUBSTITUTION.has(ch)) return { ok: false, reason: shellReason(ch) };
      if (ch === '\\' && DOUBLE_QUOTED_ESCAPES.has(points[index + 1] ?? '')) {
        word += points[index + 1];
        index += 1;
        continue;
      }
      word += ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (inWord) { argv.push(word); word = ''; inWord = false; }
      continue;
    }
    inWord = true;
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '\\') {
      const next = points[index + 1];
      if (next === undefined) return { ok: false, reason: 'ends with a dangling backslash' };
      word += next;
      index += 1;
      continue;
    }
    if (SHELL_SYNTAX.has(ch)) return { ok: false, reason: shellReason(ch) };
    word += ch;
  }
  if (quote !== undefined) return { ok: false, reason: 'has an unterminated quote' };
  if (inWord) argv.push(word);
  if (argv.length === 0 || argv[0] === '') return { ok: false, reason: 'names no executable' };
  if (argv.length > EDITOR_COMMAND_MAX_ARGS) {
    return { ok: false, reason: `has more than ${EDITOR_COMMAND_MAX_ARGS} words` };
  }
  return { ok: true, argv };
}

function shellReason(ch: string): string {
  return `uses shell syntax ${JSON.stringify(ch)}; darwin runs the editor without a shell (quote it, or wrap it in a script)`;
}

/** A bounded executable label for notices: basename only, never the arguments. */
export function editorLabel(argv: readonly string[]): string {
  const base = path.basename(argv[0] ?? '');
  const points = [...base];
  return points.length <= 48 ? base : `${points.slice(0, 47).join('')}…`;
}

/** Composer-state facts the Ctrl+G eligibility check reads; all live App state. */
export interface ExternalEditorContext {
  /** An editor is already running (the repeated chord): ignored, no second launch. */
  readonly editorActive: boolean;
  readonly idle: boolean;
  /** The queue, the shared `draining` latch, `/clear` assembly or an owed goal action. */
  readonly queued: number;
  readonly draining: boolean;
  readonly clearing: boolean;
  readonly goalOwed: boolean;
  readonly peerPending: number;
  /** Live SDK background delegations: each settles into a wake that claims a turn. */
  readonly liveDelegations: number;
}

/**
 * Why Ctrl+G may not open the editor now: `'ignore'` for the repeated chord, a
 * notice for a state that owns or is about to claim the session, `undefined` when
 * eligible. Permission prompts, compaction and the two search modes never reach this
 * — they own the key earlier in the input chain.
 */
export function externalEditorRefusal(context: ExternalEditorContext): 'ignore' | string | undefined {
  if (context.editorActive) return 'ignore';
  if (!context.idle) return 'Ctrl+G opens the external editor only while darwin is idle — draft unchanged';
  if (context.queued > 0 || context.draining || context.clearing || context.goalOwed) {
    return 'Ctrl+G waits until queued or automatic work has run — draft unchanged';
  }
  if (context.peerPending > 0) return 'Ctrl+G waits until pending peer messages have run — draft unchanged';
  if (context.liveDelegations > 0) {
    return 'Ctrl+G waits until background delegations settle (see /agents) — draft unchanged';
  }
  return undefined;
}

export type ExternalEditorOutcome =
  /** A valid result that differs from the draft: replaces it, unsent. */
  | { readonly kind: 'changed'; readonly text: string; readonly cleanupProblem?: string }
  /** The editor exited cleanly and the normalized result equals the draft. */
  | { readonly kind: 'unchanged'; readonly cleanupProblem?: string }
  /** Nothing launched: the draft or the storage cannot be used. */
  | { readonly kind: 'refused'; readonly reason: string; readonly cleanupProblem?: string }
  /** Launch failure, nonzero/signal exit, shutdown, or invalid output. */
  | { readonly kind: 'failed'; readonly reason: string; readonly cleanupProblem?: string };

export interface ExternalEditorOptions {
  readonly argv: readonly string[];
  /** The session cwd (`runtime.info.projectRoot`). */
  readonly cwd: string;
  /** The sanitized child environment, already carrying `DARWIN=1`. */
  readonly env: Readonly<Record<string, string>>;
  /** Composer text policy applied to the result — `normalizeDraftText`, nothing else. */
  readonly normalize: (text: string) => string;
  /** The terminal descriptor the editor gets as stdin/stdout/stderr; default inherit. */
  readonly terminalFd?: number;
  /** Where the private directory is created; default `os.tmpdir()`. */
  readonly tempRoot?: string;
  /** Storage resolving inside this directory is refused (the repository). */
  readonly projectRoot?: string;
  /** Hold darwin's SIGINT/SIGQUIT listeners while the editor shares the terminal; default true. */
  readonly ignoreTerminalSignals?: boolean;
}

export interface ExternalEditorRun {
  readonly done: Promise<ExternalEditorOutcome>;
  /** Darwin shutdown: TERM→KILL the editor and remove the storage now. */
  kill(): void;
}

/** True when `text` fits both caps; checked before anything is created. */
export function withinEditorCaps(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') <= EXTERNAL_EDITOR_MAX_BYTES &&
    [...text].length <= EXTERNAL_EDITOR_MAX_CODE_POINTS;
}

const CAP_REASON = `${EXTERNAL_EDITOR_MAX_CODE_POINTS.toLocaleString('en-US')} code points / 256 KiB UTF-8`;

/** Opens the editor on `text`; resolves once, after the storage is removed. */
export function runExternalEditor(text: string, options: ExternalEditorOptions): ExternalEditorRun {
  let child: ChildProcess | undefined;
  let killed = false;
  let killGrace: NodeJS.Timeout | undefined;
  let directory: string | undefined;
  let removed = false;

  const removeNow = (): string | undefined => {
    if (directory === undefined || removed) return undefined;
    try {
      rmSync(directory, { recursive: true, force: true });
      removed = true;
      return undefined;
    } catch (error) {
      return problem(error);
    }
  };

  const kill = (): void => {
    if (killed) return;
    killed = true;
    const running = child;
    if (running !== undefined && running.exitCode === null && running.signalCode === null) {
      try { running.kill('SIGTERM'); } catch { /* already gone */ }
      killGrace = setTimeout(() => {
        try { running.kill('SIGKILL'); } catch { /* already gone */ }
      }, EDITOR_KILL_GRACE_MS);
      killGrace.unref?.();
    }
    // Shutdown may not wait for the async settlement below.
    removeNow();
  };

  const prepareAndRun = async (): Promise<ExternalEditorOutcome> => {
    if (!withinEditorCaps(text)) {
      return { kind: 'refused', reason: `the draft exceeds ${CAP_REASON}; nothing was written` };
    }
    let outcome: ExternalEditorOutcome;
    try {
      directory = await mkdtemp(path.join(options.tempRoot ?? os.tmpdir(), EDITOR_TEMP_PREFIX));
      await chmod(directory, 0o700);
      if (options.projectRoot !== undefined && await inside(directory, options.projectRoot)) {
        outcome = { kind: 'refused', reason: 'the temporary directory resolves inside the project; set TMPDIR outside it' };
      } else {
        const file = path.join(directory, EDITOR_TEMP_FILE);
        const handle = await open(file, 'wx', 0o600);
        try {
          await handle.chmod(0o600);
          await handle.writeFile(text, 'utf8');
        } finally {
          await handle.close();
        }
        outcome = killed ? stoppedOutcome() : await launch(file);
      }
    } catch (error) {
      outcome = { kind: 'refused', reason: `could not prepare private temporary storage: ${problem(error)}` };
    }
    // The editor has exited (or never started) by now: no SIGKILL is owed.
    if (killGrace !== undefined) clearTimeout(killGrace);
    let cleanupProblem: string | undefined;
    if (directory !== undefined && !removed) {
      try {
        await rm(directory, { recursive: true, force: true });
        removed = true;
      } catch (error) {
        cleanupProblem = `could not remove ${directory}: ${problem(error)}`;
      }
    }
    return cleanupProblem === undefined ? outcome : { ...outcome, cleanupProblem };
  };

  const launch = async (file: string): Promise<ExternalEditorOutcome> => {
    const [executable, ...args] = options.argv;
    if (executable === undefined) return { kind: 'failed', reason: 'no editor executable' };
    const ignore = options.ignoreTerminalSignals !== false;
    const releaseSignals = ignore ? holdTerminalSignals() : () => {};
    let exit: { code: number | null; signal: NodeJS.Signals | null } | { error: string };
    try {
      exit = await new Promise((resolve) => {
        let settled = false;
        const settle = (value: typeof exit): void => { if (!settled) { settled = true; resolve(value); } };
        try {
          const fd = options.terminalFd;
          child = spawn(executable, [...args, file], {
            cwd: options.cwd,
            env: { ...options.env },
            // Same process group (never `detached`): the editor must be in the
            // terminal's foreground group to read it without SIGTTIN.
            stdio: fd === undefined ? 'inherit' : [fd, fd, fd],
            shell: false,
          });
        } catch (error) {
          settle({ error: problem(error) });
          return;
        }
        child.once('error', (error) => settle({ error: problem(error) }));
        child.once('exit', (code, signal) => settle({ code, signal }));
      });
    } finally {
      // The terminal signals the whole foreground group at once: the editor's exit can
      // be processed before darwin's own copy of the same SIGINT is dispatched, so the
      // hold outlives the editor briefly. Once Ink is back in raw mode Ctrl+C is a
      // key, not a signal.
      setTimeout(releaseSignals, TERMINAL_SIGNAL_GRACE_MS).unref();
    }
    const label = editorLabel(options.argv);
    if ('error' in exit) return { kind: 'failed', reason: `could not start ${label}: ${exit.error}` };
    if (killed) return stoppedOutcome();
    if (exit.signal !== null) return { kind: 'failed', reason: `${label} was ended by ${exit.signal}` };
    if (exit.code !== 0) return { kind: 'failed', reason: `${label} exited with code ${exit.code}` };
    const read = await readEditorResult(file);
    if (!read.ok) return { kind: 'failed', reason: read.reason };
    const next = options.normalize(read.text);
    if (!withinEditorCaps(next)) return { kind: 'failed', reason: `the result exceeds ${CAP_REASON}` };
    return next === text ? { kind: 'unchanged' } : { kind: 'changed', text: next };
  };

  const done = prepareAndRun();
  return { done, kill };
}

function stoppedOutcome(): ExternalEditorOutcome {
  return { kind: 'failed', reason: 'the editor was stopped because darwin is shutting down' };
}

/** Signals a cooked-mode terminal sends the foreground group for Ctrl+C / Ctrl+\. */
const TERMINAL_SIGNALS = ['SIGINT', 'SIGQUIT'] as const;

/**
 * While the editor shares darwin's process group, a Ctrl+C typed into a cooked-mode
 * editor is a SIGINT to darwin too — and the SDK's vended bash module listens with
 * `process.exit(0)` (the same listener `headless-runner.ts` replaces). Every listener
 * present at the first hold is set aside and one no-op handles the signal instead.
 * Holds are counted process-wide: an edit started inside the previous one's release
 * grace joins the same hold, and only the last release restores exactly the held
 * listeners (keeping any added meanwhile).
 */
let terminalSignalHold: {
  count: number;
  readonly ignoreSignal: () => void;
  readonly held: ReadonlyArray<{ readonly signal: (typeof TERMINAL_SIGNALS)[number]; readonly listeners: Array<(...args: unknown[]) => void> }>;
} | undefined;

function holdTerminalSignals(): () => void {
  if (terminalSignalHold === undefined) {
    const ignoreSignal = (): void => {};
    const held = TERMINAL_SIGNALS.map((signal) => {
      const listeners = process.listeners(signal) as Array<(...args: unknown[]) => void>;
      for (const listener of listeners) process.off(signal, listener);
      process.on(signal, ignoreSignal);
      return { signal, listeners };
    });
    terminalSignalHold = { count: 0, ignoreSignal, held };
  }
  terminalSignalHold.count += 1;
  let released = false;
  return () => {
    const hold = terminalSignalHold;
    if (released || hold === undefined) return;
    released = true;
    hold.count -= 1;
    if (hold.count > 0) return;
    terminalSignalHold = undefined;
    for (const { signal, listeners } of hold.held) {
      process.off(signal, hold.ignoreSignal);
      for (const listener of listeners) process.on(signal, listener);
    }
  };
}

/**
 * Reads the edited file through one descriptor: no symlink follow, no blocking on a
 * FIFO, regular files only, at most cap+1 bytes however large the file grows, strict
 * UTF-8 (a BOM is kept as text, not silently dropped).
 */
export async function readEditorResult(file: string):
  Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string }> {
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') return { ok: false, reason: 'the result is a symlink, not a regular file' };
    if (code === 'ENOENT') return { ok: false, reason: 'the editor removed the file' };
    return { ok: false, reason: `could not read the result: ${problem(error)}` };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, reason: 'the result is not a regular file' };
    const limit = EXTERNAL_EDITOR_MAX_BYTES + 1;
    const buffer = Buffer.alloc(limit);
    let total = 0;
    while (total < limit) {
      const { bytesRead } = await handle.read(buffer, total, limit - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > EXTERNAL_EDITOR_MAX_BYTES) return { ok: false, reason: `the result exceeds ${CAP_REASON}` };
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, total));
    } catch {
      return { ok: false, reason: 'the result is not valid UTF-8' };
    }
    if ([...text].length > EXTERNAL_EDITOR_MAX_CODE_POINTS) return { ok: false, reason: `the result exceeds ${CAP_REASON}` };
    return { ok: true, text };
  } finally {
    await handle.close();
  }
}

async function inside(candidate: string, root: string): Promise<boolean> {
  const [real, realRoot] = await Promise.all([realpath(candidate), realpath(root).catch(() => path.resolve(root))]);
  const relative = path.relative(realRoot, real);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function problem(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code !== undefined && !message.includes(code) ? `${code}: ${message}` : message;
}

/**
 * Node-internal shape of a TTY stream's libuv handle. Ink's `suspendTerminal` detaches
 * its `readable` listener but leaves the handle reading, so darwin would race the
 * editor for every keystroke (measured: one stolen per handoff, replayed into the
 * draft on resume). Pausing the handle the way Node's own backpressure path does —
 * `reading = false` plus `readStop()` — and restarting it after Ink resumes closes
 * that race without touching Ink. Feature-detected: an unexpected shape refuses the
 * handoff instead of racing.
 */
interface TtyReadHandle {
  reading: boolean;
  readStop(): number;
  readStart(): number;
}

function readHandle(stream: NodeJS.ReadableStream): TtyReadHandle | undefined {
  const handle = (stream as unknown as { _handle?: Partial<TtyReadHandle> })._handle;
  if (handle === undefined || handle === null) return undefined;
  if (typeof handle.reading !== 'boolean' || typeof handle.readStop !== 'function' || typeof handle.readStart !== 'function') {
    return undefined;
  }
  return handle as TtyReadHandle;
}

/** True when {@link quiesceTerminalInput} can stop darwin's own terminal reads. */
export function canQuiesceTerminalInput(stream: NodeJS.ReadableStream): boolean {
  return readHandle(stream) !== undefined;
}

/**
 * Call inside the suspension: lets queued input ticks settle, stops the handle, and
 * returns the restart to call after Ink has resumed. Idempotent restart; a handle Node
 * already restarted itself is left alone.
 */
export async function quiesceTerminalInput(stream: NodeJS.ReadableStream): Promise<() => void> {
  const handle = readHandle(stream);
  if (handle === undefined) return () => {};
  let stopped = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    if (!handle.reading) continue;
    handle.reading = false;
    handle.readStop();
    stopped = true;
  }
  return () => {
    if (!stopped || handle.reading) return;
    stopped = false;
    handle.reading = true;
    handle.readStart();
  };
}

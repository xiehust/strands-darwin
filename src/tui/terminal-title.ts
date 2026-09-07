/**
 * Config-gated terminal window/tab title for the interactive TUI driver (SER-073).
 *
 * The title is the one surface a user sees while another tab is focused, so it
 * carries the session's project and coarse state: `darwin · <project> · <state>`
 * with state exactly one of `idle`, `working`, `waiting for approval` or
 * `N queued`. Fixed composition, one boolean config key (`terminalTitle`) — no
 * spinner (a spinner needs a tick, and the frame-budget row forbids a new tick
 * source), no model/branch/token fields, no picker.
 *
 * The sequence is OSC 2 (`ESC ] 2 ; <title> BEL`), written straight to the
 * process's real stdout the way `terminal-bell.ts` writes BEL and `copy-command.ts`
 * writes OSC 52: a non-printing control sequence, never an Ink row, so the frame
 * budget, `/export` byte-stability and replay are untouched. It is written only
 * when the composed title *changes* — the writer below keeps the last title — so a
 * streaming turn that re-renders hundreds of frames costs one write at its start
 * and one at its end. Headless drivers never reach this module.
 *
 * The title is an escape-sequence payload: every control character (C0, DEL, C1 —
 * which covers BEL and ESC, the two bytes that could end or restart a sequence) is
 * stripped from the project name before it is embedded, so a directory name can
 * never inject a second sequence. The whole title is bounded at
 * {@link MAX_TERMINAL_TITLE_CODE_POINTS}, truncated end-first with `…`.
 *
 * Restore is best-effort: the bare project basename. The xterm title stack
 * (`CSI 22;0 t` / `CSI 23;0 t`) is deliberately not used — there is no source
 * demonstrating that every terminal lacking it ignores it harmlessly, and a
 * terminal that echoes an unknown CSI would leave garbage on the screen.
 */

export const TERMINAL_TITLE_APP_NAME = 'darwin';
export const TERMINAL_TITLE_SEPARATOR = ' · ';
/** Whole-title cap in code points, `…` included; tabs show far less than this. */
export const MAX_TERMINAL_TITLE_CODE_POINTS = 80;

export type TerminalTitleState = 'idle' | 'working' | 'waiting for approval' | `${number} queued`;

export interface TerminalTitleInput {
  readonly projectBasename: string;
  readonly state: TerminalTitleState;
}

export interface TerminalTitleSignals {
  /** A permission prompt is published to the screen (the loop is blocked on it). */
  readonly permissionPending: boolean;
  /** The session is busy: a turn streams, a `!` command runs, or compaction runs. */
  readonly busy: boolean;
  /** Entries waiting in the prompt queue. */
  readonly queued: number;
}

/**
 * Fixed precedence: a published permission prompt outranks everything (the loop
 * is waiting on the user), then a running turn, then a non-empty queue while
 * idle, else idle. A queue behind a running turn reads `working` — the turn is
 * what the user is waiting on.
 */
export function deriveTerminalTitleState(signals: TerminalTitleSignals): TerminalTitleState {
  if (signals.permissionPending) return 'waiting for approval';
  if (signals.busy) return 'working';
  if (signals.queued >= 1) return `${Math.floor(signals.queued)} queued`;
  return 'idle';
}

/** Removes every control character (C0, DEL, C1): BEL and ESC would end or start a sequence. */
export function sanitizeTitleText(text: string): string {
  return text.replace(/\p{Cc}/gu, '');
}

/** End-first truncation on code points, `…` taking the last slot. */
export function boundTitle(title: string, cap: number = MAX_TERMINAL_TITLE_CODE_POINTS): string {
  const points = [...title];
  if (points.length <= cap) return title;
  return `${points.slice(0, Math.max(0, cap - 1)).join('')}…`;
}

/**
 * `darwin · <project> · <state>`, sanitized and bounded. A project name that is
 * empty after sanitizing (the filesystem root, or a name made only of control
 * characters) drops its segment rather than leaving two separators touching.
 */
export function formatTerminalTitle(input: TerminalTitleInput): string {
  const project = sanitizeTitleText(input.projectBasename);
  const parts = project === ''
    ? [TERMINAL_TITLE_APP_NAME, input.state]
    : [TERMINAL_TITLE_APP_NAME, project, input.state];
  return boundTitle(parts.join(TERMINAL_TITLE_SEPARATOR));
}

/** `ESC ] 2 ; <title> BEL` — OSC 2 (window title), BEL-terminated like the OSC 52 `/copy` writes. */
export function terminalTitleSequence(title: string): string {
  return `\u001B]2;${sanitizeTitleText(title)}\u0007`;
}

/** The best-effort restore: the bare project basename, sanitized and bounded. */
export function terminalTitleRestore(projectBasename: string): string {
  return terminalTitleSequence(boundTitle(sanitizeTitleText(projectBasename)));
}

export interface TerminalTitleWriterOptions {
  /** `process.stdout.isTTY` in production; a pipe or file gets no sequence at all. */
  readonly isTTY: boolean;
  /** Test seam; production writes to the real stdout, never through Ink's frame path. */
  readonly write?: (chunk: string) => void;
}

export interface TerminalTitleWriter {
  /**
   * Composes the title and writes its sequence only when it differs from the last
   * one written. `enabled` is the config key at call time (`terminalTitle`); off
   * writes nothing and forgets nothing.
   */
  show(input: TerminalTitleInput, enabled: boolean): void;
  /**
   * Writes the restore sequence for the last project shown, once. A writer that
   * never wrote a title has nothing to restore and stays silent, so the off path
   * is byte-identical to before the feature existed.
   */
  restore(): void;
  /** What was last written (the title, not the sequence); tests and diagnostics only. */
  readonly lastTitle: string | undefined;
}

/** One writer per interactive App: it owns the change-only rule and the single restore. */
export function createTerminalTitleWriter(options: TerminalTitleWriterOptions): TerminalTitleWriter {
  const write = options.write ?? writeToStdout;
  let lastTitle: string | undefined;
  let lastProject: string | undefined;
  let restored = false;

  const emit = (sequence: string): void => {
    try {
      write(sequence);
    } catch {
      // A closed or broken stdout must never take down the session for a title.
    }
  };

  return {
    show(input, enabled) {
      if (!enabled || !options.isTTY || restored) return;
      const title = formatTerminalTitle(input);
      if (title === lastTitle) return;
      lastTitle = title;
      lastProject = input.projectBasename;
      emit(terminalTitleSequence(title));
    },
    restore() {
      if (restored || lastTitle === undefined) return;
      restored = true;
      emit(terminalTitleRestore(lastProject ?? ''));
    },
    get lastTitle() {
      return lastTitle;
    },
  };
}

function writeToStdout(chunk: string): void {
  process.stdout.write(chunk);
}

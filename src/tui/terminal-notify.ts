/**
 * Config-gated terminal-mediated attention notification for the interactive TUI
 * driver (SER-078).
 *
 * One OSC notification sequence goes straight to the process's real stdout at the
 * two driver-owned moments the bell already uses (`terminal-bell.ts`): a permission
 * prompt being published to the screen, and a turn completing. The terminal — not
 * darwin — decides whether to show a desktop toast, so there is no platform API, no
 * dependency and no focus detection; the sequence reaches the local machine over
 * SSH because it travels in the byte stream. Like BEL and the OSC 2 title it is a
 * non-printing control sequence, never an Ink row: the frame budget, ANSI-stripped
 * pty assertions, `/export` byte-stability and replay are untouched. Deliberately
 * not wired anywhere else: never per frame render, never in the headless drivers
 * (`-p`/structured), never for child agents, never inside lifecycle hook command
 * execution. Disabled (the default) performs no write at all, so the off path stays
 * byte-identical to before the feature existed.
 *
 * ## Sequence decision: exactly one OSC 9, ST-terminated
 *
 * `ESC ] 9 ; darwin · <project> · <body> ESC \` — iTerm2's "Post a notification".
 * Documented by every terminal known to show it: iTerm2
 * (https://iterm2.com/documentation-escape-codes.html, "Post a notification:
 * `OSC 9 ; [Message content goes here] ST`"), kitty
 * (https://sw.kovidgoyal.net/kitty/desktop-notifications/, "kitty also supports the
 * legacy OSC 9 protocol developed by iTerm2"), Ghostty
 * (https://ghostty.org/docs/vt/osc/9, "Show a desktop notification with title `t`"),
 * WezTerm (https://wezterm.org/escape-sequences.html, OSC 9 "iTerm2 Show System
 * Notification", `printf "\e]9;%s\e\\"`) and foot (`foot-ctlseqs(7)`, `\E] 9 ; msg
 * \E\\` — "iTerm2, Desktop notification").
 *
 * Terminals that reuse OSC 9 for ConEmu's numbered sub-commands (`9;4` progress and
 * friends) ignore a payload whose first `;`-field is not a number — which ours never
 * is, it starts with `darwin`: Windows Terminal's `AdaptDispatch::DoConEmuAction`
 * (src/terminal/adapter/adaptDispatch.cpp) returns before acting when
 * `StringToUint(parts[0])` fails; ConEmu's `CEAnsi::WriteAnsiCode_OSC`
 * (src/ConEmuHk/Ansi.cpp, `case L'9'`) only matches digit sub-IDs at `ArgSZ[2]` and
 * otherwise falls to `break`; tmux's `input_osc_9` (input.c) returns unless the
 * payload begins with `4`. Ghostty documents the same rule from the other side: the
 * text "should not begin with a number and then a semicolon". Every other terminal
 * treats an unrecognized OSC the way ECMA-48's string state requires — consume to
 * ST, dispatch nothing (tmux `input_exit_osc` `default:` logs "unknown" and does
 * nothing more).
 *
 * The terminator is ST (`ESC \`), never BEL, so the sequence cannot be mistaken for
 * the bell (`verify-terminal-bell.ts` counts BELs outside OSC payloads, and this
 * module must add none). OSC 777 (`ESC ] 777 ; notify ; title ; body ST`, the rxvt
 * extension) was considered and omitted: every documented implementer but
 * rxvt-unicode — WezTerm, Ghostty, foot — also implements OSC 9, so emitting both
 * would show two toasts on exactly the terminals this is for. kitty's OSC 99 is
 * omitted for the same reason (kitty and foot accept OSC 9).
 *
 * ## tmux
 *
 * tmux consumes OSC strings itself (its OSC 9 handler is the progress bar, and the
 * outer terminal never sees the bytes), so inside tmux — `TMUX` set in the
 * environment — the sequence is wrapped in tmux's documented passthrough DCS,
 * `ESC P tmux ; <sequence with every ESC doubled> ESC \` (tmux(1) `allow-passthrough`:
 * "Allow programs in the pane to bypass tmux using a terminal escape sequence
 * (\ePtmux;...\e\\)"; the DCS state machine folds `ESC ESC` back to one ESC). The
 * user must set `allow-passthrough on`; with it off, tmux discards the DCS and
 * nothing reaches the outer terminal — still harmless.
 *
 * ## Payload hygiene
 *
 * The text is an escape-sequence payload and the project basename is user data:
 * every control character (C0, DEL, C1 — covering ESC, BEL, CR/LF, and the C1 ST)
 * and every `;` (the OSC field separator, and the byte that would let a name such
 * as `4;1;50` masquerade as a ConEmu sub-command) is stripped before embedding, and
 * the whole text is bounded at {@link MAX_TERMINAL_NOTIFY_CODE_POINTS}, end-first
 * with `…`. Title vocabulary is the terminal title's (`darwin · <project>`), body
 * is `waiting for approval` (the title's own state word) or `turn complete`.
 */
import {
  TERMINAL_TITLE_APP_NAME,
  TERMINAL_TITLE_SEPARATOR,
  boundTitle,
} from './terminal-title.js';

/** ST — the string terminator. Never BEL here (see the header). */
export const TERMINAL_NOTIFY_ST = '\u001B\\';
/** Whole-text cap in code points, `…` included. */
export const MAX_TERMINAL_NOTIFY_CODE_POINTS = 120;

export type TerminalNotifyMoment = 'permission' | 'turn-complete';

/** Fixed bodies; `waiting for approval` is the terminal title's state word. */
export const TERMINAL_NOTIFY_BODY: Readonly<Record<TerminalNotifyMoment, string>> = Object.freeze({
  permission: 'waiting for approval',
  'turn-complete': 'turn complete',
});

export interface TerminalNotifyInput {
  readonly projectBasename: string;
  readonly moment: TerminalNotifyMoment;
}

/**
 * Removes every control character (C0, DEL, C1) and every `;`: ESC/BEL/ST would end
 * or restart a sequence, and `;` is the OSC field separator.
 */
export function sanitizeNotifyText(text: string): string {
  return text.replace(/\p{Cc}|;/gu, '');
}

/** `darwin · <project>` — the terminal title's own head; an empty project drops its segment. */
export function terminalNotifyTitle(projectBasename: string): string {
  const project = sanitizeNotifyText(projectBasename);
  return project === '' ? TERMINAL_TITLE_APP_NAME : `${TERMINAL_TITLE_APP_NAME}${TERMINAL_TITLE_SEPARATOR}${project}`;
}

/** `darwin · <project> · <body>`, sanitized and bounded. */
export function formatTerminalNotification(input: TerminalNotifyInput): string {
  const text = `${terminalNotifyTitle(input.projectBasename)}${TERMINAL_TITLE_SEPARATOR}${TERMINAL_NOTIFY_BODY[input.moment]}`;
  return boundTitle(sanitizeNotifyText(text), MAX_TERMINAL_NOTIFY_CODE_POINTS);
}

/** `ESC ] 9 ; <text> ESC \` — OSC 9, ST-terminated. The text is sanitized again at the seam. */
export function terminalNotifySequence(text: string): string {
  return `\u001B]9;${sanitizeNotifyText(text)}${TERMINAL_NOTIFY_ST}`;
}

/** tmux(1) passthrough: `ESC P tmux ; <sequence, ESC doubled> ESC \`. */
export function wrapForTmuxPassthrough(sequence: string): string {
  return `\u001BPtmux;${sequence.replaceAll('\u001B', '\u001B\u001B')}${TERMINAL_NOTIFY_ST}`;
}

/** tmux exports `TMUX` into every pane; screen and a bare terminal do not set it. */
export function isInsideTmux(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.TMUX ?? '') !== '';
}

export interface TerminalNotifySeam {
  /** `process.stdout.isTTY` in production; a pipe or file gets no sequence at all. */
  readonly isTTY?: boolean;
  /** Whether to wrap for tmux; production reads `TMUX` from the environment. */
  readonly insideTmux?: boolean;
  /** Test seam; production writes to the real stdout, never through Ink's frame path. */
  readonly write?: (chunk: string) => void;
}

/**
 * Writes exactly one sequence (one `write` call) when `enabled` and stdout is a
 * TTY, nothing otherwise. `enabled` is the config key at call time
 * (`terminalNotify`); off writes nothing and allocates nothing.
 */
export function notifyTerminal(enabled: boolean, input: TerminalNotifyInput, seam: TerminalNotifySeam = {}): void {
  if (!enabled) return;
  const isTTY = seam.isTTY ?? process.stdout.isTTY === true;
  if (!isTTY) return;
  const sequence = terminalNotifySequence(formatTerminalNotification(input));
  const insideTmux = seam.insideTmux ?? isInsideTmux();
  const write = seam.write ?? writeToStdout;
  try {
    write(insideTmux ? wrapForTmuxPassthrough(sequence) : sequence);
  } catch {
    // A closed or broken stdout must never take down the session for a toast.
  }
}

function writeToStdout(chunk: string): void {
  process.stdout.write(chunk);
}

/**
 * Config-gated terminal attention bell for the interactive TUI driver.
 *
 * One raw BEL (`\x07`) goes straight to the process's real stdout at the two
 * driver-owned moments a detached user needs back: a permission prompt being
 * published to the screen, and a turn completing. BEL is a non-printing control
 * byte, so it is never an Ink row — the frame budget, ANSI-stripped pty
 * assertions, `/export` byte-stability and replay are all untouched.
 *
 * Deliberately not wired anywhere else: never per frame render, never in the
 * headless drivers (`-p`/structured), never for child agents, and never inside
 * lifecycle hook command execution. Disabled (the default) performs no write at
 * all, so the off path stays byte-identical to before the feature existed.
 */

export const TERMINAL_BELL = '\u0007';

/**
 * Writes exactly one BEL when `enabled`, nothing otherwise. The injectable
 * writer exists only for tests; production callers use the real stdout.
 */
export function ringTerminalBell(
  enabled: boolean,
  write: (chunk: string) => void = writeToStdout,
): void {
  if (!enabled) return;
  try {
    write(TERMINAL_BELL);
  } catch {
    // A closed or broken stdout must never take down the session for a chime.
  }
}

function writeToStdout(chunk: string): void {
  process.stdout.write(chunk);
}

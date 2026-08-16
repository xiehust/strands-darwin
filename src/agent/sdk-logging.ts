/**
 * Routing the SDK's own logger away from the console.
 *
 * The SDK's default logger writes `warn` and `error` straight to `console`
 * (`logging/logger.js`), which tears the Ink frame exactly like the prompt-cache
 * warning documented in AGENTS.md. That was avoidable while every warning came
 * from a mistake darwin could simply not make — but `/model` produces one that is
 * unavoidable and *correct*: switching away from Claude with a reasoning block in
 * the history makes the OpenAI Responses adapter warn once per request that it is
 * dropping the block (measured in `spike/probe-model-switch.ts`).
 *
 * So the warning has to go somewhere. It goes to whoever is rendering: the TUI
 * turns it into a transcript notice, and anything that does not install a sink
 * keeps the SDK's console behaviour.
 *
 * This module is the *only* caller of `configureLogging`, which is what lets the
 * opt-in verbose tap below exist without a second owner of the global logger.
 */
import { configureLogging } from '@strands-agents/sdk';

/** What the SDK logged, flattened to one line. */
export interface SdkLogEntry {
  level: 'warn' | 'error';
  message: string;
}

export type SdkLogSink = (entry: SdkLogEntry) => void;

/**
 * The same, at any of the SDK's four levels.
 *
 * A separate type rather than a wider {@link SdkLogEntry}: a renderer maps the level
 * straight onto a notice severity (`info`/`warn`/`error`), and `debug` is not one of
 * those — widening the shared type would make every renderer accept a level it has no
 * way to draw.
 */
export interface SdkVerboseLogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

export type SdkVerboseSink = (entry: SdkVerboseLogEntry) => void;

/**
 * Whoever is rendering, and whoever is recording.
 *
 * Module state because the SDK's logger is one global and the two have different
 * lifetimes: a renderer comes and goes with a mounted frame, a tap belongs to a
 * session. Neither should have to know the other exists in order to install itself.
 */
let renderer: SdkLogSink | undefined;
let verbose: SdkVerboseSink | undefined;

/**
 * Sends SDK warnings and errors to `sink` instead of the console, and returns the
 * function that puts the console behaviour back.
 *
 * `debug` and `info` stay no-ops, matching the SDK's own default: they are chatty
 * enough to be a rendering problem of their own, and nothing in darwin *renders*
 * them. They are only ever written down, by the opt-in tap in
 * {@link setSdkVerboseSink}.
 *
 * Repeated messages are *not* de-duplicated here. The dropped-reasoning warning
 * repeats once per request, and hiding that would misrepresent how often it is
 * happening; a renderer that finds it noisy is the right place to collapse it.
 */
export function routeSdkLogs(sink: SdkLogSink): () => void {
  renderer = sink;
  install();

  return () => {
    renderer = undefined;
    install();
  };
}

/**
 * Also writes every level — including the two nothing renders — to `sink`, or stops
 * doing so when given `undefined`.
 *
 * Independent of {@link routeSdkLogs} because the two answer different questions: the
 * renderer shows the user what they may need to act on *now*, while the tap writes
 * down what someone debugging the session needs *afterwards*. `warn`/`error` reach
 * both, so the file holds the whole story rather than only the half nobody was shown.
 *
 * With no tap installed, `debug` and `info` are the *literal* no-ops the SDK itself
 * ships, not a closure that checks whether anyone is listening: a run that did not
 * ask for diagnostics must be indistinguishable from the run it was before they
 * existed, and 60 `logger.debug` call sites is the wrong place to add a branch
 * nobody asked for.
 */
export function setSdkVerboseSink(sink: SdkVerboseSink | undefined): void {
  verbose = sink;
  install();
}

/** Rebuilds the four handlers from whatever is installed right now. */
function install(): void {
  const tap = verbose;
  const sink = renderer;

  configureLogging({
    debug: tap === undefined ? () => {} : (...args: unknown[]) => tap({ level: 'debug', message: flatten(args) }),
    info: tap === undefined ? () => {} : (...args: unknown[]) => tap({ level: 'info', message: flatten(args) }),
    warn: (...args: unknown[]) => emit('warn', args, sink, tap),
    error: (...args: unknown[]) => emit('error', args, sink, tap),
  });
}

/**
 * One warning to the renderer first, then to the tap.
 *
 * The console is used only while *neither* is installed, which is the SDK's own
 * default behaviour: dropping a warning because nobody happened to be listening yet
 * would lose it entirely, and writing to the console while Ink owns the terminal is
 * the thing this module exists to prevent. Order matters in one direction only — the
 * user sees the problem before it is written down, so a tap can never delay what is
 * on screen.
 */
function emit(
  level: 'warn' | 'error',
  args: readonly unknown[],
  sink: SdkLogSink | undefined,
  tap: SdkVerboseSink | undefined,
): void {
  if (sink === undefined && tap === undefined) {
    if (level === 'warn') console.warn(...args);
    else console.error(...args);
    return;
  }
  const message = flatten(args);
  sink?.({ level, message });
  tap?.({ level, message });
}

/** The SDK logs printf-style varargs; the renderer wants one string. */
function flatten(args: readonly unknown[]): string {
  return args
    .map((arg) => (typeof arg === 'string' ? arg : arg instanceof Error ? arg.message : JSON.stringify(arg)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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
 */
import { configureLogging } from '@strands-agents/sdk';

/** What the SDK logged, flattened to one line. */
export interface SdkLogEntry {
  level: 'warn' | 'error';
  message: string;
}

export type SdkLogSink = (entry: SdkLogEntry) => void;

/**
 * Sends SDK warnings and errors to `sink` instead of the console, and returns the
 * function that puts the console behaviour back.
 *
 * `debug` and `info` stay no-ops, matching the SDK's own default: they are chatty
 * enough to be a rendering problem of their own, and nothing in darwin asks for
 * them.
 *
 * Repeated messages are *not* de-duplicated here. The dropped-reasoning warning
 * repeats once per request, and hiding that would misrepresent how often it is
 * happening; a renderer that finds it noisy is the right place to collapse it.
 */
export function routeSdkLogs(sink: SdkLogSink): () => void {
  configureLogging({
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => sink({ level: 'warn', message: flatten(args) }),
    error: (...args: unknown[]) => sink({ level: 'error', message: flatten(args) }),
  });

  return () => {
    configureLogging({
      debug: () => {},
      info: () => {},
      warn: (...args: unknown[]) => console.warn(...args),
      error: (...args: unknown[]) => console.error(...args),
    });
  };
}

/** The SDK logs printf-style varargs; the renderer wants one string. */
function flatten(args: readonly unknown[]): string {
  return args
    .map((arg) => (typeof arg === 'string' ? arg : arg instanceof Error ? arg.message : JSON.stringify(arg)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

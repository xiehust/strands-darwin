#!/usr/bin/env node
/**
 * `darwin` entry point.
 *
 * Usage: darwin [--resume|--session <id>] [--permission-mode <default|auto|plan|yolo>] [--yolo]
 *        darwin -p <message> [--continue|--resume|--session <id>] [permission flags]
 *        darwin trajectory <list|search|replay|fork> …
 */
import process from 'node:process';

import { AgentRuntime } from './agent/runtime.js';
import type { DiagnosticLevel } from './agent/diagnostics.js';
import { routeSdkLogs } from './agent/sdk-logging.js';
import { CliUsageError, parseCliArgs, type CliOptions } from './cli-args.js';
import {
  isTrajectoryInvocation,
  parseTrajectoryArgs,
  runTrajectoryCommand,
} from './cli-trajectory.js';
import { ConfigError } from './config.js';
import {
  createHeadlessPermissionBridge,
  formatHeadlessDiagnosticsProblem,
  formatHeadlessPermissionMode,
  formatHeadlessTrajectoryProblem,
  formatHeadlessUsage,
  headlessField,
  runHeadlessTurn,
} from './headless.js';

const FORCE_EXIT_AFTER_MS = 500;

async function main(): Promise<void> {
  // Routed before argument parsing, and before any runtime, model or Ink import
  // happens: reading a record is a local operation on files, and `replay` must not
  // be able to reach a provider even by accident. (The structural half of that
  // guarantee lives in `src/trajectory/**`, which imports no `Agent` and no `Model`
  // at all; `spike/verify-trajectory.ts` asserts it over the module's import graph.)
  const argv = process.argv.slice(2);
  if (isTrajectoryInvocation(argv)) {
    await runTrajectory(argv.slice(1));
    return;
  }

  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`error: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  if (options.prompt !== undefined) {
    await runHeadless({ ...options, prompt: options.prompt });
    return;
  }
  await runInteractive(options);
}

async function runTrajectory(argv: readonly string[]): Promise<void> {
  try {
    const command = parseTrajectoryArgs(argv);
    process.exitCode = await runTrajectoryCommand(command, {
      projectRoot: process.cwd(),
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
    });
  } catch (error) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`error: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`error: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

async function runHeadless(options: CliOptions & { prompt: string }): Promise<void> {
  const projectRoot = process.cwd();
  // The SDK bash module installs process-exiting signal handlers at import time.
  // Replace them for this one-shot process so darwin can cancel, clean up, and
  // return a nonzero status instead of being terminated with status 0.
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');

  let runtime: AgentRuntime | undefined;
  let reply: string | undefined;
  let interrupted = false;
  let failed = false;
  const restoreSdkLogs = routeSdkLogs((entry) => {
    process.stderr.write(`sdk ${entry.level} — ${headlessField(entry.message)}\n`);
  });

  /**
   * One stderr record, with a copy in the diagnostics log when this run asked for one.
   *
   * The stderr half is unchanged and unconditional — same text, same order, byte for
   * byte — because it is the protocol a supervisor parses; the log only ever *gains* a
   * copy. SDK warnings deliberately do not come through here: the tap inside the
   * runtime already writes them with `source: sdk`, and routing the stderr rendering
   * of them here as well would put the same event in the file twice under two labels.
   * Records written after `runtime.shutdown()` reach stderr only, because closing the
   * log is what makes its last line mean "the session ended here".
   */
  const note = (text: string, level: DiagnosticLevel = 'info'): void => {
    process.stderr.write(text);
    runtime?.diagnostics?.write({ source: 'darwin', level, message: text });
  };

  const onInterrupt = () => {
    interrupted = true;
    process.exitCode = 1;
    runtime?.cancel();
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);

  // An explicit id is already the effective id even when strict existence
  // checking rejects it. All other selectors are reported once resolution picks
  // their generated or pointed-to id.
  if (options.session.kind === 'id') {
    process.stderr.write(`session: ${options.session.sessionId}\n`);
  }

  try {
    runtime = await AgentRuntime.create({
      projectRoot,
      session: options.session,
      ...(options.session.kind !== 'id' && {
        onSessionResolved: (sessionId: string) => process.stderr.write(`session: ${sessionId}\n`),
      }),
      quietMcpStderr: true,
      permissionBridge: createHeadlessPermissionBridge((text) => note(text, 'warn')),
      ...(options.permissionModeOverride !== undefined && {
        permissionModeOverride: options.permissionModeOverride,
      }),
    });
    if (interrupted) throw new Error('Interrupted.');
    note(`${formatHeadlessPermissionMode(runtime.info.permissionMode)}\n`);
    // Where the debug output went, stated once beside the other startup facts. Only
    // when the run asked for it: a line about a file that does not exist would be
    // noise in every default run's stderr.
    if (runtime.info.diagnosticsFile !== undefined) {
      note(`diagnostics: ${runtime.info.diagnosticsFile}\n`);
    }

    reply = await runHeadlessTurn(
      runtime,
      options.prompt,
      (text) => note(text),
    );
  } catch (error) {
    failed = true;
    note(`error: ${errorMessage(error)}\n`, 'error');
  } finally {
    if (runtime !== undefined) {
      try {
        await runtime.shutdown({ throwOnError: true });
      } catch (error) {
        failed = true;
        process.stderr.write(`error: cleanup failed: ${errorMessage(error)}\n`);
      }
    }
    if (interrupted) failed = true;
    if (!failed && runtime !== undefined && reply !== undefined) {
      try {
        await runtime.markResumable();
        process.stdout.write(`${reply}\n`);
      } catch (error) {
        failed = true;
        process.stderr.write(`error: ${errorMessage(error)}\n`);
      }
    }
    // One machine-parseable token record per run, written on success, on turn
    // failure, and on interrupt — a supervisor aggregating child spend needs the
    // number even when the child did not finish. Best-effort and last: reading
    // the meter must never mask the real exit path established above.
    if (runtime !== undefined) {
      try {
        process.stderr.write(`${formatHeadlessUsage(runtime.usage, runtime.config)}\n`);
      } catch {
        // A meter that cannot be read is not a reason to change the exit status.
      }
      // Same rule for the record: an observer's failure is reported, never fatal.
      try {
        const problem = formatHeadlessTrajectoryProblem(runtime.trajectoryStatus);
        if (problem !== undefined) process.stderr.write(`${problem}\n`);
      } catch {
        // Reading the recorder's own status must not change the exit path either.
      }
      // And for the diagnostics log, which reports here rather than into itself: the
      // one failure worth naming is the one that stopped it writing.
      try {
        const problem = formatHeadlessDiagnosticsProblem(runtime.diagnosticsStatus);
        if (problem !== undefined) process.stderr.write(`${problem}\n`);
      } catch {
        // Reading the log's own status must not change the exit path either.
      }
    }

    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
    restoreSdkLogs();

    if (failed) process.exitCode = 1;
    forceExitIfHung();
  }
}

async function runInteractive(options: CliOptions): Promise<void> {
  const [{ render }, { default: React }, { App }, { PermissionQueue }] = await Promise.all([
    import('ink'),
    import('react'),
    import('./tui/App.js'),
    import('./tui/permission-queue.js'),
  ]);
  const projectRoot = process.cwd();
  const permissions = new PermissionQueue();

  let runtime: AgentRuntime;
  try {
    runtime = await AgentRuntime.create({
      projectRoot,
      session: options.session,
      permissionBridge: permissions.bridge,
      ...(options.permissionModeOverride !== undefined && {
        permissionModeOverride: options.permissionModeOverride,
      }),
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`\nConfiguration problem:\n  ${error.message}\n\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const instance = render(React.createElement(App, { runtime, permissions }), {
    exitOnCtrlC: false,
  });
  try {
    await instance.waitUntilExit();
  } finally {
    permissions.close();
    await runtime.shutdown();
    forceExitIfHung();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Last resort after explicit shutdown for a provider socket leaked on cancel. */
function forceExitIfHung(): void {
  const timer = setTimeout(() => process.exit(process.exitCode ?? 0), FORCE_EXIT_AFTER_MS);
  timer.unref();
}

await main();

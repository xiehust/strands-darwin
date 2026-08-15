#!/usr/bin/env node
/**
 * `darwin` entry point.
 *
 * Usage: darwin [--resume] [--permission-mode <default|auto|plan|yolo>] [--yolo]
 *        darwin -p <message> [--continue|--resume|--session <id>] [permission flags]
 */
import process from 'node:process';

import { AgentRuntime } from './agent/runtime.js';
import { routeSdkLogs } from './agent/sdk-logging.js';
import { CliUsageError, parseCliArgs, type CliOptions } from './cli-args.js';
import { ConfigError } from './config.js';
import {
  createHeadlessPermissionBridge,
  formatHeadlessPermissionMode,
  formatHeadlessUsage,
  headlessField,
  runHeadlessTurn,
} from './headless.js';

const FORCE_EXIT_AFTER_MS = 500;

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCliArgs(process.argv.slice(2));
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
      permissionBridge: createHeadlessPermissionBridge((text) => process.stderr.write(text)),
      ...(options.permissionModeOverride !== undefined && {
        permissionModeOverride: options.permissionModeOverride,
      }),
    });
    if (interrupted) throw new Error('Interrupted.');
    process.stderr.write(`${formatHeadlessPermissionMode(runtime.info.permissionMode)}\n`);

    reply = await runHeadlessTurn(
      runtime,
      options.prompt,
      (text) => process.stderr.write(text),
    );
  } catch (error) {
    failed = true;
    process.stderr.write(`error: ${errorMessage(error)}\n`);
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

#!/usr/bin/env node
/**
 * `darwin` entry point.
 *
 * Usage: darwin [--resume|--session <id>] [--permission-mode <default|auto|plan|yolo>] [--yolo]
 *        darwin -p <message> [--output-format text|json|stream-json]
 *          [--continue|--resume|--session <id>] [permission flags]
 *        darwin trajectory <list|search|replay|fork> …
 */
import process from 'node:process';

import { AgentRuntime } from './agent/runtime.js';
import { CliUsageError, parseCliArgs, type CliOptions } from './cli-args.js';
import {
  isTrajectoryInvocation,
  parseTrajectoryArgs,
  runTrajectoryCommand,
} from './cli-trajectory.js';
import { ConfigError } from './config.js';
import { productionHeadlessDependencies, runHeadlessProcess } from './headless-runner.js';

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
  await runHeadlessProcess(options, {
    ...productionHeadlessDependencies,
    forceExitIfHung,
  });
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

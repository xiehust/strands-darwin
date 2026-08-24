#!/usr/bin/env node
/**
 * `darwin` entry point.
 *
 * Usage: darwin [--resume [<id>]|--session <id>] [--permission-mode <default|auto|plan|yolo>] [--yolo]
 *        darwin -p <message> [--output-format text|json|stream-json]
 *          [--continue|--resume [<id>]|--session <id>] [permission flags]
 *          [--max-model-calls <n>] [--context-offload] [--compact-before]
 *        darwin sessions
 *        darwin trajectory <list|search|replay|fork> …
 */
import process from 'node:process';

import { AgentRuntime } from './agent/runtime.js';
import { SessionNotFoundError, trajectoryPath } from './agent/session.js';
import {
  CliUsageError,
  normalizeLeadingArgvSeparator,
  parseCliArgs,
  type CliOptions,
} from './cli-args.js';
import {
  isSessionsInvocation,
  parseSessionsArgs,
  runSessionsCommand,
} from './cli-sessions.js';
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
  const argv = normalizeLeadingArgvSeparator(process.argv.slice(2));
  if (isTrajectoryInvocation(argv)) {
    await runTrajectory(argv.slice(1));
    return;
  }
  // Same routing rule as `trajectory`: `sessions` is a local read of the snapshot
  // store — no model, no network, no writes — so it must resolve before any
  // runtime, model or Ink import can happen.
  if (isSessionsInvocation(argv)) {
    await runSessions(argv.slice(1));
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

async function runSessions(argv: readonly string[]): Promise<void> {
  try {
    parseSessionsArgs(argv);
    process.exitCode = await runSessionsCommand({
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
  await runHeadlessProcess({ ...options, projectRoot: process.cwd() }, {
    ...productionHeadlessDependencies,
    forceExitIfHung,
  });
}

async function runInteractive(options: CliOptions): Promise<void> {
  const [{ render }, { default: React }, { PermissionQueue }, { StartupScreen }] = await Promise.all([
    import('ink'),
    import('react'),
    import('./tui/permission-queue.js'),
    import('./tui/StartupScreen.js'),
  ]);
  const projectRoot = process.cwd();
  const permissions = new PermissionQueue();
  // Ink owns the terminal before runtime/config/MCP/session setup begins. This is
  // one renderer, not a splash followed by a second app: rerender below replaces
  // the root atomically and lets React clean up the startup timer on handoff.
  const instance = render(
    React.createElement(StartupScreen, { phase: 'runtime' }),
    { exitOnCtrlC: false },
  );

  let runtime: AgentRuntime;
  try {
    runtime = await AgentRuntime.create({
      projectRoot,
      session: options.session,
      // MCP servers are subprocesses outside Ink's renderer. Their banners and
      // warnings must not write directly into the TUI frame.
      quietMcpStderr: true,
      permissionBridge: permissions.bridge,
      ...(options.permissionModeOverride !== undefined && {
        permissionModeOverride: options.permissionModeOverride,
      }),
    });
  } catch (error) {
    instance.unmount();
    await instance.waitUntilExit();
    permissions.close();

    if (error instanceof ConfigError) {
      process.stderr.write(`\nConfiguration problem:\n  ${error.message}\n\n`);
      process.exitCode = 1;
      return;
    }
    // A typo'd or other-project `--resume <id>` / `--session <id>` is a clear
    // refusal, not a crash — and never a fallback to some other session.
    if (error instanceof SessionNotFoundError) {
      process.stderr.write(`error: ${error.message} Run \`darwin sessions\` to list resumable ones.\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  permissions.setObserver((source) => runtime.observePermissionRequest(source));

  /**
   * Human context is restored from the exact session trajectory, never from Agent
   * messages. Fresh sessions skip even the file read and therefore render exactly
   * as before SER-028.
   */
  if (runtime.info.resumed) {
    instance.rerender(React.createElement(StartupScreen, { phase: 'resume' }));
  }
  let initialHistory: readonly import('./tui/turn-state.js').HistoryItem[] | undefined;
  try {
    initialHistory = runtime.info.resumed
      ? await import('./trajectory/resume-recap.js').then(({ loadResumeRecap }) =>
          loadResumeRecap({
            file: trajectoryPath(projectRoot, runtime.info.sessionId),
            restoredMessages: runtime.messageCount,
            trajectoryEnabled: runtime.info.config.trajectory !== false,
          }))
      : undefined;
  } catch (error) {
    instance.unmount();
    await instance.waitUntilExit();
    permissions.close();
    await runtime.shutdown();
    throw error;
  }
  let App: typeof import('./tui/App.js').App;
  try {
    ({ App } = await import('./tui/App.js'));
  } catch (error) {
    instance.unmount();
    await instance.waitUntilExit();
    permissions.close();
    await runtime.shutdown();
    throw error;
  }
  /** The session that is live right now; `/clear` replaces it with a successor. */
  let current = runtime;

  instance.rerender(
    React.createElement(App, {
      runtime,
      permissions,
      ...(initialHistory === undefined ? {} : { initialHistory }),
      // `/clear` starts a new session by handing this conversation to a successor
      // runtime (`AgentRuntime.startNewSession`). Ownership of shutdown stays here,
      // where it always was: `current` is what the exit path reaps, so the retired
      // predecessor's shell and observers are released by the switch itself and the
      // live session is released once, on exit.
      startNewSession: async () => {
        const next = await current.startNewSession();
        current = next;
        permissions.setObserver((source) => current.observePermissionRequest(source));
        return next;
      },
    }),
  );
  try {
    await instance.waitUntilExit();
  } finally {
    permissions.close();
    await current.shutdown();
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

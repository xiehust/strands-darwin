/**
 * The `darwin` program: routing and every command, loaded by `cli.ts` with a dynamic
 * `import()` once the SDK-patch preflight has passed. The static imports below reach
 * the SDK (`agent/runtime.js` → `agent/compact.js` → `DEFAULT_SUMMARIZATION_PROMPT`),
 * so this module must never be the entry point: on an unpatched SDK it fails at ESM
 * link time, before any statement could print a readable refusal.
 *
 * The SDK-free `permissions test` observer is routed by `cli.ts` before this module.
 * The usage grammar lives in one place, `CLI_USAGE` in `./cli-usage.ts` — it is what
 * `darwin --help` prints and what `docs/user-guide/reference.md` quotes, so it is not
 * repeated here.
 */
import path from 'node:path';
import process from 'node:process';

import { AgentRuntime } from './agent/runtime.js';
import { SessionInUseError, SessionNotFoundError, trajectoryPath } from './agent/session.js';
import {
  needsTrustPrompt,
  resolveWorkspaceTrust,
  withTrustState,
  writeTrustDecision,
  type WorkspaceTrust,
} from './agent/workspace-trust.js';
import {
  CliUsageError,
  normalizeLeadingArgvSeparator,
  parseCliArgs,
  type CliOptions,
} from './cli-args.js';
import { isDoctorInvocation, parseDoctorArgs, runDoctorCommand } from './cli-doctor.js';
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
import { localCliAnswer, resumeHintLine, usageErrorText } from './cli-usage.js';
import { ConfigError, loadConfig } from './config.js';
import { productionHeadlessDependencies, runHeadlessProcess } from './headless-runner.js';
import { withProductionReactImports } from './tui/react-environment.js';
import { ringTerminalBell } from './tui/terminal-bell.js';
import { notifyTerminal } from './tui/terminal-notify.js';

const FORCE_EXIT_AFTER_MS = 500;

export async function main(): Promise<void> {
  // Routed before argument parsing, and before any runtime, model or Ink import
  // happens: reading a record is a local operation on files, and `replay` must not
  // be able to reach a provider even by accident. (The structural half of that
  // guarantee lives in `src/trajectory/**`, which imports no `Agent` and no `Model`
  // at all; `spike/verify-trajectory.ts` asserts it over the module's import graph.)
  const argv = normalizeLeadingArgvSeparator(process.argv.slice(2));
  // `--help`/`-h` and `--version`/`-V` are the most local answers of all: fixed text
  // from `cli-usage.ts`, no file read or write, no parser. Anywhere in argv they win
  // over subcommands and every other flag, so they resolve first.
  const localAnswer = localCliAnswer(argv);
  if (localAnswer !== undefined) {
    process.stdout.write(localAnswer);
    return;
  }
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
  // `doctor` is the strictest reader of all: it composes the startup loaders into
  // one report without starting a session, and must create nothing — so it too
  // resolves before the runtime path.
  if (isDoctorInvocation(argv)) {
    await runDoctor(argv.slice(1));
    return;
  }

  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      reportUsageError(error);
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
      reportUsageError(error);
      return;
    }
    process.stderr.write(`error: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

async function runDoctor(argv: readonly string[]): Promise<void> {
  try {
    parseDoctorArgs(argv);
    process.exitCode = await runDoctorCommand({
      projectRoot: process.cwd(),
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
    });
  } catch (error) {
    if (error instanceof CliUsageError) {
      reportUsageError(error);
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
      reportUsageError(error);
      return;
    }
    process.stderr.write(`error: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * The one shape every usage error takes: the exact message (the parsers' strings are
 * the contract; tests pin them), then a single hint at `--help`, then exit 2. The
 * headless runner's piped-stdin refusal writes the same `usageErrorText`.
 */
function reportUsageError(error: CliUsageError): void {
  process.stderr.write(usageErrorText(error.message));
  process.exitCode = 2;
}

async function runHeadless(options: CliOptions & { prompt: string }): Promise<void> {
  await runHeadlessProcess({ ...options, projectRoot: process.cwd() }, {
    ...productionHeadlessDependencies,
    forceExitIfHung,
  });
}

async function runInteractive(options: CliOptions): Promise<void> {
  const [{ render }, { default: React }, { PermissionQueue }, { StartupScreen }, { WorkspaceTrustPrompt }] =
    await withProductionReactImports(() => Promise.all([
      import('ink'),
      import('react'),
      import('./tui/permission-queue.js'),
      import('./tui/StartupScreen.js'),
      import('./tui/WorkspaceTrustPrompt.js'),
    ]));
  const projectRoot = process.cwd();
  const permissions = new PermissionQueue();
  // Ink owns the terminal before runtime/config/MCP/session setup begins. This is
  // one renderer, not a splash followed by a second app: rerender below replaces
  // the root atomically and lets React clean up the startup timer on handoff.
  const instance = render(
    React.createElement(StartupScreen, { phase: 'runtime' }),
    { exitOnCtrlC: false },
  );

  // SER-090: before anything the checkout declares can run. The inventory reads the
  // project's hook and MCP files without arming them; a project that declares nothing
  // (or already has a stored answer) goes straight on. The modal replaces the startup
  // screen — the same renderer, still before `AgentRuntime.create` — and the answer
  // travels into the runtime as one option, so the loaders skip what was declined.
  let workspaceTrust: WorkspaceTrust = await resolveWorkspaceTrust(projectRoot);
  if (needsTrustPrompt(workspaceTrust)) {
    const pending = workspaceTrust;
    const answer = await new Promise<import('./tui/WorkspaceTrustPrompt.js').TrustAnswer>((resolve) => {
      instance.rerender(
        React.createElement(WorkspaceTrustPrompt, { trust: pending, projectRoot, onDecision: resolve }),
      );
    });
    let storeProblem: string | undefined;
    if (answer !== 'decline-session') {
      try {
        await writeTrustDecision(projectRoot, answer === 'accept');
      } catch (error) {
        // The answer still governs this session; only its memory is lost, and the
        // transcript notice says so rather than the process failing on a user store.
        storeProblem = `trust decision could not be stored: ${errorMessage(error)}`;
      }
    }
    workspaceTrust = withTrustState(
      workspaceTrust,
      answer === 'accept' ? 'trusted' : answer === 'decline' ? 'untrusted' : 'undecided',
    );
    if (storeProblem !== undefined) workspaceTrust = { ...workspaceTrust, problem: storeProblem };
    instance.rerender(React.createElement(StartupScreen, { phase: 'runtime' }));
  }

  let runtime: AgentRuntime;
  try {
    runtime = await AgentRuntime.create({
      projectRoot,
      session: options.session,
      workspaceTrust,
      // MCP servers are subprocesses outside Ink's renderer. Their banners and
      // warnings must not write directly into the TUI frame.
      quietMcpStderr: true,
      permissionBridge: permissions.bridge,
      // The TUI drains SER-069 task wakes at idle, so the `bash` tool may say that
      // ending the turn is followed by one `<task-notification>` turn (the runtime
      // still requires config `backgroundTaskWake !== false`). Headless and the dev
      // REPL have no queue and leave this unset.
      backgroundCompletionWakes: true,
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
    // refusal, not a crash — and never a fallback to some other session. The same
    // shape for an id another live darwin holds the lease on (SER-091).
    if (error instanceof SessionNotFoundError || error instanceof SessionInUseError) {
      process.stderr.write(`error: ${error.message} Run \`darwin sessions\` to list resumable ones.\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  /**
   * One observer wiring shared by the initial session and every `/clear`/rewind
   * successor: lifecycle-hook publication plus the config-gated attention bell and
   * terminal notification, all fired at the moment the prompt is published to the
   * user (the queue de-duplicates re-asks of the same prompt identity).
   */
  const observePermissionPublication = (rt: AgentRuntime): void => {
    permissions.setObserver((request) => {
      rt.observePermissionRequest({ source: request.source.label, toolName: request.toolName, toolInput: request.input });
      ringTerminalBell(rt.config.terminalBell === true);
      notifyTerminal(rt.config.terminalNotify === true, {
        projectBasename: path.basename(rt.info.projectRoot),
        moment: 'permission',
      });
    });
  };
  observePermissionPublication(runtime);

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
    if (runtime.info.resumed) {
      initialHistory = await import('./trajectory/resume-recap.js').then(({ loadResumeRecap }) =>
        loadResumeRecap({
          projectRoot,
          file: trajectoryPath(projectRoot, runtime.info.sessionId),
          restoredMessages: runtime.messageCount,
          trajectoryEnabled: runtime.info.config.trajectory !== false,
          ...(runtime.info.leaseNotice === undefined ? {} : { leaseNotice: runtime.info.leaseNotice }),
        }));
    } else if (runtime.info.leaseNotice !== undefined) {
      // SER-091: bare `--resume` found its session open in another live process and
      // started fresh — there is no recap to carry the reason, so it is the one
      // startup notice, in the same scrollback slot the recap header would take.
      initialHistory = [{ kind: 'notice', id: 'session-lease', text: runtime.info.leaseNotice, severity: 'warn' }];
    }
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
        observePermissionPublication(next);
        return next;
      },
      startRewind: async (checkpoint) => {
        const next = await current.startRewind(checkpoint);
        current = next;
        observePermissionPublication(next);
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
  // SER-092: the one line an interactive exit leaves in the scrollback — the live
  // session's id and the command that reopens it. After `shutdown()` on purpose: the
  // lease is released and every writer has settled, so nothing else follows it. Gated
  // on the session having messages: the SDK saves the snapshot `--resume <id>` reads
  // whenever a message was added, so `messageCount` is exactly "reopenable" — a fresh
  // session left without a prompt has nothing to name, a resumed one still does. The
  // refusal paths above returned before this point; headless never reaches it. Written
  // whether or not stdout is a TTY: the user asked for the TUI.
  if (current.messageCount > 0) process.stdout.write(resumeHintLine(current.info.sessionId));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Last resort after explicit shutdown for a provider socket leaked on cancel. */
function forceExitIfHung(): void {
  const timer = setTimeout(() => process.exit(process.exitCode ?? 0), FORCE_EXIT_AFTER_MS);
  timer.unref();
}

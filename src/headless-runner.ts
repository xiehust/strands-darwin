import process from 'node:process';

import type { DiagnosticLevel } from './agent/diagnostics.js';
import type { RuntimeOptions } from './agent/runtime.js';
import { AgentRuntime } from './agent/runtime.js';
import { classify } from './agent/permission.js';
import { routeSdkLogs, type SdkLogEntry } from './agent/sdk-logging.js';
import type { CliOptions } from './cli-args.js';
import {
  createHeadlessPermissionBridge,
  formatHeadlessDiagnosticsProblem,
  formatHeadlessPermissionMode,
  formatHeadlessTrajectoryProblem,
  formatHeadlessUsage,
  headlessField,
  runHeadlessTurn,
} from './headless.js';
import {
  StructuredHeadlessWriter,
  runStructuredHeadlessTurn,
  structuredFailure,
  structuredUsage,
  structuredWarning,
  type StructuredFailure,
  type StructuredWarning,
} from './headless-protocol.js';

export type HeadlessOptions = CliOptions & { prompt: string; projectRoot: string };

type HeadlessProcess = Pick<
  typeof process,
  'stdout' | 'stderr' | 'exitCode' | 'removeAllListeners' | 'once' | 'off'
>;

export interface HeadlessRunnerDependencies {
  process: HeadlessProcess;
  createRuntime(options: RuntimeOptions): Promise<AgentRuntime>;
  routeLogs(sink: (entry: SdkLogEntry) => void): () => void;
  forceExitIfHung(): void;
}

export const productionHeadlessDependencies: HeadlessRunnerDependencies = {
  process,
  createRuntime: (options) => AgentRuntime.create(options),
  routeLogs: routeSdkLogs,
  forceExitIfHung: () => undefined,
};

/**
 * One lifecycle for all three headless protocols. Renderers differ; turn, strict
 * cleanup, pointer durability, signal handling and exit status do not.
 */
export async function runHeadlessProcess(
  options: HeadlessOptions,
  dependencies: HeadlessRunnerDependencies,
): Promise<void> {
  const target = dependencies.process;
  const structuredFormat = options.outputFormat === 'text' ? undefined : options.outputFormat;
  const structured = structuredFormat !== undefined;
  const protocol = structuredFormat === undefined
    ? undefined
    : new StructuredHeadlessWriter(
        structuredFormat,
        (text) => target.stdout.write(text),
        options.session.kind === 'id' ? options.session.sessionId : null,
      );

  // The SDK bash module installs process-exiting signal handlers at import time.
  // Replace them for this one-shot process so darwin can cancel, clean up, and
  // return a nonzero status instead of being terminated with status 0.
  target.removeAllListeners('SIGINT');
  target.removeAllListeners('SIGTERM');

  let runtime: AgentRuntime | undefined;
  let reply: string | undefined;
  let interrupted = false;
  let cancelled = false;
  let failed = false;
  let turnFailure: unknown;
  const errors: StructuredFailure[] = [];
  const warnings: StructuredWarning[] = [];

  const recordWarning = (warning: StructuredWarning): void => {
    warnings.push(warning);
    protocol?.diagnostic(warning);
  };
  const restoreSdkLogs = dependencies.routeLogs((entry) => {
    if (structured) {
      recordWarning(structuredWarning('sdk', entry.level, entry.message));
    } else {
      target.stderr.write(`sdk ${entry.level} — ${headlessField(entry.message)}\n`);
    }
  });

  /** The original text protocol stays literal; structured mode writes diagnostics only to its log. */
  const note = (text: string, level: DiagnosticLevel = 'info'): void => {
    if (!structured) target.stderr.write(text);
    runtime?.diagnostics?.write({ source: 'darwin', level, message: text });
  };

  const onInterrupt = () => {
    interrupted = true;
    target.exitCode = 1;
    runtime?.cancel();
  };
  target.once('SIGINT', onInterrupt);
  target.once('SIGTERM', onInterrupt);

  // Text mode's explicit-id record is load-bearing. Structured mode carries the
  // requested id in its envelope without claiming that strict resolution succeeded.
  if (!structured && options.session.kind === 'id') {
    target.stderr.write(`session: ${options.session.sessionId}\n`);
  }

  try {
    runtime = await dependencies.createRuntime({
      projectRoot: options.projectRoot,
      session: options.session,
      ...(options.session.kind !== 'id' && {
        onSessionResolved: (sessionId: string) => {
          if (structured) protocol?.sessionResolved(sessionId);
          else target.stderr.write(`session: ${sessionId}\n`);
        },
      }),
      quietMcpStderr: true,
      permissionBridge: structured
        ? async (request) => {
            protocol?.permissionDenied(request);
            note(`permission denied — ${headlessField(request.summary)}\n`, 'warn');
            return { allowed: false };
          }
        : createHeadlessPermissionBridge((text) => note(text, 'warn')),
      ...(options.permissionModeOverride !== undefined && {
        permissionModeOverride: options.permissionModeOverride,
      }),
    });
    if (structured && options.session.kind === 'id') {
      protocol?.sessionResolved(runtime.info.sessionId);
    }
    if (interrupted) throw new Error('Interrupted.');

    if (structured) {
      protocol?.runStarted({
        permissionMode: runtime.info.permissionMode,
        resumed: runtime.info.resumed,
        ...(runtime.info.diagnosticsFile === undefined ? {} : { diagnosticsFile: runtime.info.diagnosticsFile }),
      });
      protocol?.turnStarted();
      const turn = await runStructuredHeadlessTurn(
        runtime,
        options.prompt,
        protocol!,
        (name, input) => classify(name, input).summary,
      );
      if (turn.outcome === 'cancelled') cancelled = true;
      else reply = turn.reply;
    } else {
      note(`${formatHeadlessPermissionMode(runtime.info.permissionMode)}\n`);
      if (runtime.info.diagnosticsFile !== undefined) {
        note(`diagnostics: ${runtime.info.diagnosticsFile}\n`);
      }
      reply = await runHeadlessTurn(runtime, options.prompt, (text) => note(text));
    }
  } catch (error) {
    if (structured && interrupted && isInterruptedError(error)) {
      cancelled = true;
    } else {
      failed = true;
      if (structured) {
        errors.push(structuredFailure(runtime === undefined ? 'runtime' : 'turn', error));
        if (runtime !== undefined) turnFailure = error;
      } else {
        note(`error: ${errorMessage(error)}\n`, 'error');
      }
    }
  } finally {
    if (runtime !== undefined) {
      // The existing text driver writes the turn error immediately. Structured mode
      // keeps stderr clean, but the diagnostics log must retain the same evidence
      // before shutdown closes it.
      if (structured && turnFailure !== undefined) {
        runtime.diagnostics?.write({ source: 'darwin', level: 'error', message: `error: ${errorMessage(turnFailure)}\n` });
      }
      try {
        await runtime.shutdown({ throwOnError: true });
      } catch (error) {
        failed = true;
        if (structured) {
          errors.push(structuredFailure('cleanup', error));
        } else {
          target.stderr.write(`error: cleanup failed: ${errorMessage(error)}\n`);
        }
      }
    }

    if (structured && interrupted && !failed) {
      cancelled = true;
    } else if (!structured && interrupted) {
      failed = true;
    }
    if (!failed && !cancelled && runtime !== undefined && reply !== undefined) {
      try {
        await runtime.markResumable();
        if (!structured) target.stdout.write(`${reply}\n`);
      } catch (error) {
        failed = true;
        if (structured) {
          errors.push(structuredFailure('persistence', error));
        } else {
          target.stderr.write(`error: ${errorMessage(error)}\n`);
        }
      }
    }

    let usage: ReturnType<typeof structuredUsage> | undefined;
    if (runtime !== undefined) {
      try {
        if (structured) usage = structuredUsage(runtime.usage, runtime.config);
        else target.stderr.write(`${formatHeadlessUsage(runtime.usage, runtime.config)}\n`);
      } catch {
        // A meter that cannot be read is not a reason to change the exit status.
      }

      try {
        const problem = formatHeadlessTrajectoryProblem(runtime.trajectoryStatus);
        if (problem !== undefined) {
          if (structured) warnings.push(structuredWarning('trajectory', 'warn', problem.slice('trajectory: '.length)));
          else target.stderr.write(`${problem}\n`);
        }
      } catch {
        // Reading an observer's own status must not change the exit path.
      }
      try {
        const problem = formatHeadlessDiagnosticsProblem(runtime.diagnosticsStatus);
        if (problem !== undefined) {
          if (structured) warnings.push(structuredWarning('diagnostics', 'warn', problem.slice('diagnostics: '.length)));
          else target.stderr.write(`${problem}\n`);
        }
      } catch {
        // Reading an observer's own status must not change the exit path.
      }
    }

    if (structured) {
      const outcome = cancelled ? 'cancelled' : failed ? 'failure' : 'success';
      protocol?.terminal({
        outcome,
        ...(runtime === undefined ? {} : {
          permissionMode: runtime.info.permissionMode,
          resumed: runtime.info.resumed,
        }),
        ...(outcome === 'success' && reply !== undefined ? { result: reply } : {}),
        ...(usage === undefined ? {} : { usage }),
        ...(errors.length === 0 ? {} : { errors }),
        ...(warnings.length === 0 ? {} : { warnings }),
      });
    }

    target.off('SIGINT', onInterrupt);
    target.off('SIGTERM', onInterrupt);
    restoreSdkLogs();

    if (failed || cancelled) target.exitCode = 1;
    dependencies.forceExitIfHung();
  }
}

function isInterruptedError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Interrupted.';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

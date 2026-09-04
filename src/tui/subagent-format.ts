/**
 * Bounded, presentation-time projections of subagent dispatch state.
 *
 * Same division of labour as `background-tool-presentation.ts`: the registry keeps
 * full fidelity (whole task text, ISO timestamps), and everything a terminal draws
 * is truncated here — by Unicode code points, so a task ending in an emoji cannot
 * render as `�`.
 *
 * Nothing in this module can reach a child's transcript: it only ever sees the
 * dispatch record (name, task, state, timestamps) and the parent's own tool-use
 * block.
 */
import { SUBAGENT_TOOL_NAME } from '../agents/subagent-tool.js';
import { WORKFLOW_TOOL_NAME } from '../agents/workflow-tool.js';
import { backgroundExecutionRequested } from '../agent/background-delegation.js';
import {
  dispatchLabel,
  shortDispatchId,
  type SubagentCancelResult,
  type SubagentDispatchPhase,
  type SubagentDispatchStatus,
} from '../agents/dispatch-registry.js';
import { formatTaskDuration, summarizeTaskCommand } from './task-format.js';

/** A delegated task is prose, so it gets less room than a shell command. */
const TASK_SUMMARY_LIMIT = 56;

/** Room for `succeeded`, the longest state word, plus a space. */
const STATE_COLUMN = 9;

/** A bounded name plus `#` plus eight id characters; longer labels just push. */
const LABEL_COLUMN = 25;

/** Elapsed milliseconds for one dispatch, defensive about the ISO contract. */
export function dispatchElapsedMs(
  dispatch: SubagentDispatchStatus,
  nowMs = Date.now(),
): number {
  const started = Date.parse(dispatch.startedAt);
  const finished = dispatch.finishedAt === null ? nowMs : Date.parse(dispatch.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return 0;
  return Math.max(0, finished - started);
}

/**
 * The `/agents` report: one row per dispatch of this run.
 *
 * The empty wording names *dispatches*, not agents, so the report can never be
 * misread as the list of definitions available to delegate to — that catalogue is
 * `runtime.info.agentNames`, shown in the header, and is a different question.
 */
export function formatDispatchesReport(
  dispatches: readonly SubagentDispatchStatus[],
  nowMs = Date.now(),
): string {
  if (dispatches.length === 0) return 'subagent dispatches — none in this run';
  return [
    `subagent dispatches — this run (${dispatches.length})`,
    ...dispatches.map(
      (dispatch) =>
        `  ${dispatchLabel(dispatch).padEnd(LABEL_COLUMN)}  ${dispatch.state.padEnd(STATE_COLUMN)}  ` +
        `${formatTaskDuration(dispatchElapsedMs(dispatch, nowMs)).padStart(7)}  ` +
        `${summarizeTaskCommand(dispatch.task, TASK_SUMMARY_LIMIT)}${dispatchUsageSuffix(dispatch)}`,
    ),
  ].join('\n');
}

/**
 * ` — tokens in=X out=Y` when the dispatch snapshot carries usage, nothing
 * otherwise — a row never invents a zero for a meter that was not read.
 * Counters only, like everything else on the row.
 */
function dispatchUsageSuffix(dispatch: SubagentDispatchStatus): string {
  if (dispatch.usage === undefined) return '';
  return ` — tokens in=${dispatch.usage.inputTokens} out=${dispatch.usage.outputTokens}`;
}

/** The observer notice for a dispatch that just reached a terminal state. */
export function formatDispatchCompletion(dispatch: SubagentDispatchStatus): string {
  return (
    `subagent ${dispatchLabel(dispatch)} ${dispatch.state} in ` +
    `${formatTaskDuration(dispatchElapsedMs(dispatch))} — ` +
    `${summarizeTaskCommand(dispatch.task, TASK_SUMMARY_LIMIT)}`
  );
}


/** Closed phase text shared by live rows and headless heartbeat projections. */
export function formatDispatchPhase(phase: SubagentDispatchPhase): string {
  switch (phase.kind) {
    case 'tool':
      return `tool ${phase.toolName}`;
    case 'waiting-on-model':
      // The child's own throttled retry wait (SER-067): the attempt about to be made.
      return `waiting on model, retry ${phase.attempt}/${phase.maxAttempts}`;
    default:
      return phase.kind;
  }
}

/** Bounded local response for `/agents cancel <id>`. */
export function formatDispatchCancellation(dispatchId: string, result: SubagentCancelResult): string {
  switch (result.outcome) {
    case 'cancelled':
      return `cancelling subagent ${dispatchLabel(result.dispatch)}`;
    case 'ambiguous':
      return `subagent dispatch id ${dispatchId} is ambiguous — no dispatch cancelled`;
    case 'terminal':
      return `subagent dispatch ${dispatchId} is already finished`;
    case 'already-requested':
      return `subagent dispatch ${dispatchId} cancellation was already requested`;
    case 'not-found':
      return `no subagent dispatch ${dispatchId}`;
  }
}

/** `<agent>#<dispatchId>`, the identity every surface shows for one dispatch. */
export { dispatchLabel } from '../agents/dispatch-registry.js';

/**
 * The live/history row for a delegation call, or `undefined` for any other tool.
 *
 * Computed from the parent's own tool-use block alone — no registry lookup — so
 * the TUI reducer stays pure while still printing the same dispatch id the
 * registry recorded: {@link shortDispatchId} is a pure function of the tool-use id.
 * Concurrent dispatches are what make this worth showing: several `subagent` rows
 * are alive at once, and `subagent: general` repeated three times says nothing.
 */
export function subagentCallSummary(
  toolName: string,
  input: unknown,
  toolUseId: string,
): string | undefined {
  if (toolName !== SUBAGENT_TOOL_NAME) return undefined;
  const record = isRecord(input) ? input : {};
  const agentName = typeof record['agent'] === 'string' && record['agent'].trim() !== ''
    ? record['agent'].trim()
    : 'general';
  const task = typeof record['task'] === 'string' ? record['task'] : '';
  const label = `${SUBAGENT_TOOL_NAME} ${dispatchLabel({ agentName, dispatchId: shortDispatchId(toolUseId) })}`;
  return task === '' ? label : `${label}: ${summarizeTaskCommand(task, TASK_SUMMARY_LIMIT)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * SER-064: the three readings one background-routed delegation row goes through.
 *
 * The transcript sees a delegation the model marked `_background_execution: true`
 * three times: as a live row while the child runs (the SDK's ack keeps the parent
 * going, but the child *is* still running, and the dispatch heartbeat lands on this
 * row), as one finished ack row when the parent receives the dispatch
 * acknowledgement, and as the finished result row when the background run's own
 * `afterToolCallEvent` arrives — the same row a foreground call ends with, so the
 * report renders exactly like a foreground result. All three are pure functions of
 * the parent's tool-use block and the SDK's ack text; none reads a task registry.
 */
export function backgroundDelegationRequested(toolName: string, input: unknown): boolean {
  return (
    (toolName === SUBAGENT_TOOL_NAME || toolName === WORKFLOW_TOOL_NAME) &&
    backgroundExecutionRequested(input)
  );
}

/** Live-panel label while the background child is still running. */
export function backgroundDelegationLiveSummary(baseSummary: string): string {
  return `${baseSummary} · background`;
}

/** The finished ack row: the parent was released while task `taskId` runs. */
export function backgroundDelegationAckSummary(baseSummary: string, taskId: string): string {
  return `${baseSummary} · delegated in background (task ${taskId})`;
}

/** The finished result row, carrying the child's report like a foreground call. */
export function backgroundDelegationResultSummary(baseSummary: string): string {
  return `${baseSummary} · background result`;
}

export { backgroundAckTaskId } from '../agent/background-delegation.js';

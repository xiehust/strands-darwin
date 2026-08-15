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
import {
  dispatchLabel,
  shortDispatchId,
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
        `${summarizeTaskCommand(dispatch.task, TASK_SUMMARY_LIMIT)}`,
    ),
  ].join('\n');
}

/** The observer notice for a dispatch that just reached a terminal state. */
export function formatDispatchCompletion(dispatch: SubagentDispatchStatus): string {
  return (
    `subagent ${dispatchLabel(dispatch)} ${dispatch.state} in ` +
    `${formatTaskDuration(dispatchElapsedMs(dispatch))} — ` +
    `${summarizeTaskCommand(dispatch.task, TASK_SUMMARY_LIMIT)}`
  );
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

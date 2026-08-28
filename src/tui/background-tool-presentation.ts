import { TERMINAL_WAIT_TIMEOUT_INSTRUCTION } from '../tools/background-wait-contract.js';
import { formatTaskId, summarizeTaskCommand } from './task-format.js';

export const BACKGROUND_BASH_MODES = ['start', 'list', 'status', 'output', 'wait', 'stop'] as const;
export type BackgroundBashMode = (typeof BACKGROUND_BASH_MODES)[number];

export type CompactBackgroundResult =
  | { kind: 'suppress' }
  | { kind: 'compact'; summary: string; preview: string }
  | { kind: 'fallback' };

const TASK_ID_LABEL_LIMIT = 24;
const TASK_STATES = ['running', 'succeeded', 'failed', 'stopped'] as const;
const START_KEYS = ['taskId', 'pid', 'outputPath'] as const;
const SNAPSHOT_KEYS = [
  'taskId', 'state', 'command', 'pid', 'startedAt', 'finishedAt',
  'exitCode', 'signal', 'outputPath', 'outputBytes',
] as const;
const OUTPUT_KEYS = ['taskId', 'output', 'startOffset', 'endOffset', 'hasMore', 'outputPath'] as const;
const WAIT_KEYS = ['reason', 'status', 'output'] as const;
const WAIT_TIMEOUT_KEYS = ['reason', 'status', 'output', 'instruction'] as const;
const WAIT_REASONS = ['output', 'changed', 'terminal', 'timeout', 'cancelled', 'shutdown'] as const;

/** Recognizes only manager-owned bash lifecycle calls; foreground bash stays unchanged. */
export function backgroundBashMode(toolName: string, input: unknown): BackgroundBashMode | undefined {
  if (toolName !== 'bash' || !isRecord(input)) return undefined;
  const mode = input.mode;
  return typeof mode === 'string' && (BACKGROUND_BASH_MODES as readonly string[]).includes(mode)
    ? mode as BackgroundBashMode
    : undefined;
}

/** One bounded live-row label, without manager paths or full UUIDs. */
export function compactBackgroundCallSummary(mode: BackgroundBashMode, input: unknown): string {
  if (!isRecord(input)) return `bash ${mode}`;
  if (mode === 'start' && typeof input.command === 'string') {
    return `bash start: ${summarizeTaskCommand(input.command)}`;
  }
  if ((mode === 'status' || mode === 'output' || mode === 'wait' || mode === 'stop') && typeof input.taskId === 'string') {
    return `bash ${mode}: ${compactTaskId(input.taskId)}`;
  }
  return `bash ${mode}`;
}

/** Selects the live label so a detail toggle can redraw an already-active call. */
export function activeToolCallSummary(
  summary: string,
  compactSummary: string | undefined,
  toolDetailsExpanded: boolean,
): string {
  return toolDetailsExpanded ? summary : (compactSummary ?? summary);
}

/**
 * Projects a successful lifecycle result for compact transcript history.
 * Unknown payloads deliberately fall back to the ordinary full preview.
 */
export function compactBackgroundResult(
  mode: BackgroundBashMode,
  input: unknown,
  content: readonly unknown[],
): CompactBackgroundResult {
  const payload = resultPayload(content);
  if (payload === MALFORMED) return { kind: 'fallback' };

  switch (mode) {
    case 'start': {
      if (!isStartResult(payload)) return { kind: 'fallback' };
      return {
        kind: 'compact',
        summary: `bash start: ${compactTaskId(payload.taskId)} started (pid ${payload.pid})`,
        preview: '',
      };
    }

    case 'list': {
      if (!Array.isArray(payload) || !payload.every(isFullTaskSnapshot)) return { kind: 'fallback' };
      const states = new Map<string, number>();
      for (const task of payload) states.set(task.state, (states.get(task.state) ?? 0) + 1);
      const breakdown = [...states].map(([state, count]) => `${count} ${state}`).join(', ');
      return {
        kind: 'compact',
        summary: `bash list: ${payload.length} task${payload.length === 1 ? '' : 's'}${breakdown === '' ? '' : ` (${breakdown})`}`,
        preview: '',
      };
    }

    case 'status':
      return isFullTaskSnapshot(payload) && matchesInputTaskId(input, payload.taskId)
        ? { kind: 'suppress' }
        : { kind: 'fallback' };

    case 'output': {
      if (!isOutputResult(payload) || !matchesInputTaskId(input, payload.taskId)) {
        return { kind: 'fallback' };
      }
      if (payload.output === '') return { kind: 'suppress' };
      return {
        kind: 'compact',
        summary: `bash output: ${compactTaskId(payload.taskId)}`,
        preview: payload.output.trimEnd(),
      };
    }

    case 'wait': {
      if (!isWaitResult(payload, input) || !matchesInputTaskId(input, payload.status.taskId)) {
        return { kind: 'fallback' };
      }
      if (payload.status.state === 'running') return { kind: 'suppress' };
      return {
        kind: 'compact',
        summary: `bash wait: ${compactTaskId(payload.status.taskId)} ${payload.status.state}`,
        preview: '',
      };
    }

    case 'stop':
      if (!isFullTaskSnapshot(payload) || !matchesInputTaskId(input, payload.taskId)) {
        return { kind: 'fallback' };
      }
      return {
        kind: 'compact',
        summary: `bash stop: ${compactTaskId(payload.taskId)} ${payload.state}`,
        preview: '',
      };
  }
}

const MALFORMED = Symbol('malformed-background-result');

function resultPayload(content: readonly unknown[]): unknown | typeof MALFORMED {
  if (content.length !== 1 || !isRecord(content[0])) return MALFORMED;
  const block = content[0];
  if (block.type === 'jsonBlock') return hasExactKeys(block, ['type', 'json']) ? block.json : MALFORMED;
  if (block.type !== 'textBlock' || typeof block.text !== 'string' || !hasExactKeys(block, ['type', 'text'])) {
    return MALFORMED;
  }
  try {
    return JSON.parse(block.text) as unknown;
  } catch {
    return MALFORMED;
  }
}

function isStartResult(value: unknown): value is { taskId: string; pid: number; outputPath: string } {
  return isRecord(value) && hasExactKeys(value, START_KEYS) && isTaskId(value.taskId) &&
    isPositiveSafeInteger(value.pid) && typeof value.outputPath === 'string';
}

function isOutputResult(value: unknown): value is {
  taskId: string;
  output: string;
  startOffset: number;
  endOffset: number;
  hasMore: boolean;
  outputPath: string;
} {
  return isRecord(value) && hasExactKeys(value, OUTPUT_KEYS) && isTaskId(value.taskId) &&
    typeof value.output === 'string' && isNonNegativeSafeInteger(value.startOffset) &&
    isNonNegativeSafeInteger(value.endOffset) &&
    value.endOffset - value.startOffset === Buffer.byteLength(value.output) &&
    typeof value.hasMore === 'boolean' && typeof value.outputPath === 'string';
}

function isWaitResult(value: unknown, input: unknown): value is {
  reason: (typeof WAIT_REASONS)[number];
  status: { taskId: string; state: string };
  output: { taskId: string; output: string };
  instruction?: string;
} {
  if (!isRecord(value) ||
      (!hasExactKeys(value, WAIT_KEYS) && !hasExactKeys(value, WAIT_TIMEOUT_KEYS)) ||
      typeof value.reason !== 'string' || !(WAIT_REASONS as readonly string[]).includes(value.reason) ||
      !isFullTaskSnapshot(value.status) || !isOutputResult(value.output) ||
      value.status.taskId !== value.output.taskId) return false;

  if (!isRecord(input) ||
      (input.wakeOnOutput !== undefined && typeof input.wakeOnOutput !== 'boolean')) return false;
  const terminalFocused = input.wakeOnOutput === false;
  const hasInstruction = Object.hasOwn(value, 'instruction');

  if (terminalFocused) {
    if (value.reason === 'output' || value.reason === 'changed') return false;
    if (value.reason === 'terminal') return !hasInstruction && value.status.state !== 'running';
    if (value.reason === 'timeout') {
      return value.status.state === 'running' && hasInstruction &&
        value.instruction === TERMINAL_WAIT_TIMEOUT_INSTRUCTION;
    }
    return !hasInstruction && value.status.state === 'running';
  }

  if (hasInstruction) return false;
  if (value.reason === 'output') return value.output.output !== '';
  if (value.reason === 'terminal') {
    return value.status.state !== 'running' && value.output.output === '';
  }
  return value.status.state === 'running' && value.output.output === '';
}

function isFullTaskSnapshot(value: unknown): value is { taskId: string; state: string } {
  return isRecord(value) && hasExactKeys(value, SNAPSHOT_KEYS) && isTaskId(value.taskId) &&
    isTaskState(value.state) && typeof value.command === 'string' && isPositiveSafeInteger(value.pid) &&
    isIsoTimestamp(value.startedAt) && (value.finishedAt === null || isIsoTimestamp(value.finishedAt)) &&
    (value.exitCode === null || isNonNegativeSafeInteger(value.exitCode)) &&
    (value.signal === null || typeof value.signal === 'string') && typeof value.outputPath === 'string' &&
    (value.outputBytes === null || isNonNegativeSafeInteger(value.outputBytes));
}

function matchesInputTaskId(input: unknown, resultTaskId: string): boolean {
  return isRecord(input) && isTaskId(input.taskId) && input.taskId === resultTaskId;
}

function isTaskId(value: unknown): value is string {
  return typeof value === 'string' && /^bg-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
}

function isTaskState(value: unknown): value is (typeof TASK_STATES)[number] {
  return typeof value === 'string' && (TASK_STATES as readonly string[]).includes(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function compactTaskId(taskId: string): string {
  return summarizeTaskCommand(formatTaskId(taskId), TASK_ID_LABEL_LIMIT);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

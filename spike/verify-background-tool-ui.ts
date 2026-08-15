/** Focused, network-free contracts for compact background bash presentation. */
import type { AgentStreamEvent } from '@strands-agents/sdk';

import {
  activeToolCallSummary,
  backgroundBashMode,
  compactBackgroundCallSummary,
  compactBackgroundResult,
} from '../src/tui/background-tool-presentation.js';
import { initialTurnState, turnReducer, type TurnState } from '../src/tui/turn-state.js';
import { assert, header, report } from './shared.js';

const TASK_ID = 'bg-12345678-1234-1234-1234-123456789abc';
const OTHER_TASK_ID = 'bg-abcdef01-1234-1234-1234-123456789abc';

function event(value: unknown): AgentStreamEvent {
  return value as AgentStreamEvent;
}

function before(id: string, input: Record<string, unknown>): AgentStreamEvent {
  return event({ type: 'beforeToolCallEvent', toolUse: { name: 'bash', toolUseId: id, input } });
}

function after(
  id: string,
  payload: unknown,
  status: 'success' | 'error' = 'success',
): AgentStreamEvent {
  return event({
    type: 'afterToolCallEvent',
    toolUse: { name: 'bash', toolUseId: id, input: {} },
    result: { status, content: [{ type: 'jsonBlock', json: payload }] },
  });
}

function afterText(id: string, text: string, status: 'success' | 'error' = 'error'): AgentStreamEvent {
  return event({
    type: 'afterToolCallEvent',
    toolUse: { name: 'bash', toolUseId: id, input: {} },
    result: { status, content: [{ type: 'textBlock', text }] },
  });
}

function reduce(state: TurnState, streamEvent: AgentStreamEvent): TurnState {
  return turnReducer(state, { type: 'streamEvent', event: streamEvent });
}

function statusPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: TASK_ID,
    state: 'running',
    command: 'sleep 10',
    pid: 42,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    exitCode: null,
    signal: null,
    outputPath: '/private/task.log',
    outputBytes: 0,
    ...overrides,
  };
}

function outputPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: TASK_ID,
    output: 'child says hello\n',
    startOffset: 0,
    endOffset: 17,
    hasMore: false,
    outputPath: '/private/task.log',
    ...overrides,
  };
}

header('background tool presentation helpers');
assert('only lifecycle bash modes are recognized',
  backgroundBashMode('bash', { mode: 'status' }) === 'status' &&
  backgroundBashMode('bash', { mode: 'execute' }) === undefined &&
  backgroundBashMode('fileEditor', { mode: 'status' }) === undefined);
assert('live summaries use short ids and bounded commands',
  compactBackgroundCallSummary('status', { taskId: TASK_ID }) === 'bash status: bg-12345678' &&
  compactBackgroundCallSummary('start', { command: 'x'.repeat(100) }).length < 90);
const longActive = compactBackgroundCallSummary('status', { taskId: `not-a-bg-id-${'x'.repeat(500)}` });
assert('malformed long active task ids remain bounded',
  [...longActive].length <= 40 && longActive.endsWith('…'));

const outputProjection = compactBackgroundResult('output', { taskId: TASK_ID }, [{
  type: 'jsonBlock', json: outputPayload(),
}]);
assert('output projection preserves child text without cursor/path metadata',
  outputProjection.kind === 'compact' && outputProjection.preview === 'child says hello' &&
  !outputProjection.preview.includes('/private'));
assert('empty output polls disappear and malformed payloads fall back',
  compactBackgroundResult('output', { taskId: TASK_ID }, [{
    type: 'jsonBlock', json: outputPayload({ output: '', endOffset: 0 }),
  }]).kind === 'suppress' &&
  compactBackgroundResult('status', { taskId: TASK_ID }, [{ type: 'textBlock', text: 'not json' }]).kind === 'fallback');

const started = compactBackgroundResult('start', { command: 'sleep 10' }, [{
  type: 'jsonBlock', json: { taskId: TASK_ID, pid: 42, outputPath: '/private/task.log' },
}]);
const listed = compactBackgroundResult('list', { mode: 'list' }, [{
  type: 'jsonBlock', json: [statusPayload(), statusPayload({
    taskId: OTHER_TASK_ID,
    state: 'stopped',
    finishedAt: '2026-01-01T00:00:01.000Z',
    outputBytes: null,
  })],
}]);
const stopped = compactBackgroundResult('stop', { taskId: TASK_ID }, [{
  type: 'jsonBlock', json: statusPayload({ state: 'stopped', finishedAt: '2026-01-01T00:00:01.000Z' }),
}]);
assert('start list and stop results have concise projections',
  started.kind === 'compact' && started.summary === 'bash start: bg-12345678 started (pid 42)' &&
  listed.kind === 'compact' && listed.summary === 'bash list: 2 tasks (1 running, 1 stopped)' &&
  stopped.kind === 'compact' && stopped.summary === 'bash stop: bg-12345678 stopped');

const driftCases = [
  compactBackgroundResult('start', {}, [{ type: 'jsonBlock', json: {
    taskId: TASK_ID, pid: 42, outputPath: '/private/task.log', diagnostic: 'new field',
  } }]),
  compactBackgroundResult('status', { taskId: TASK_ID }, [{
    type: 'jsonBlock', json: statusPayload({ taskId: OTHER_TASK_ID }),
  }]),
  compactBackgroundResult('status', { taskId: TASK_ID }, [{
    type: 'jsonBlock', json: statusPayload({ state: 'paused' }),
  }]),
  compactBackgroundResult('status', { taskId: TASK_ID }, [{
    type: 'jsonBlock', json: statusPayload({ outputBytes: Number.POSITIVE_INFINITY }),
  }]),
  compactBackgroundResult('output', { taskId: TASK_ID }, [{
    type: 'jsonBlock', json: outputPayload({ startOffset: 18, endOffset: 17 }),
  }]),
  compactBackgroundResult('output', { taskId: TASK_ID }, [{
    type: 'jsonBlock', json: outputPayload({ endOffset: 18 }),
  }]),
  compactBackgroundResult('output', { taskId: TASK_ID }, [{
    type: 'jsonBlock', json: outputPayload({ taskId: OTHER_TASK_ID }),
  }]),
  compactBackgroundResult('list', {}, [{
    type: 'jsonBlock', json: [statusPayload({ pid: Number.NaN })],
  }]),
];
assert('shape, id, state, and numeric drift all use full-preview fallback',
  driftCases.every((projection) => projection.kind === 'fallback'));
assert('valid nullable snapshot fields remain compactable',
  compactBackgroundResult('list', {}, [{
    type: 'textBlock', text: JSON.stringify([statusPayload({ outputBytes: null })]),
  }]).kind === 'compact');

header('background tool reducer projection');
let compact = initialTurnState;
for (const id of ['status-1', 'status-2']) {
  compact = reduce(compact, before(id, { mode: 'status', taskId: TASK_ID }));
  assert('active status uses a compact short-id summary',
    compact.activeTools[0]?.compactSummary === 'bash status: bg-12345678');
  compact = reduce(compact, after(id, statusPayload()));
}
assert('repeated successful status polls create no static history',
  compact.history.length === 0 && compact.activeTools.length === 0);

compact = reduce(compact, before('output', { mode: 'output', taskId: TASK_ID }));
compact = reduce(compact, after('output', outputPayload({ output: 'meaningful child output\n', endOffset: 24 })));
const childOutput = compact.history.at(-1);
assert('non-empty child output remains as concise tool history',
  childOutput?.kind === 'tool' && childOutput.preview === 'meaningful child output' &&
  childOutput.summary.includes('bg-12345678'));

compact = reduce(compact, before('fallback', { mode: 'status', taskId: TASK_ID }));
compact = reduce(compact, after('fallback', statusPayload({ diagnostic: 'retain this diagnostic' })));
const fallback = compact.history.at(-1);
assert('extra successful diagnostic fields survive through bounded ordinary fallback',
  fallback?.kind === 'tool' && fallback.preview.includes('retain this diagnostic') &&
  fallback.summary === 'bash status: bg-12345678');

let malformedIdFallback = initialTurnState;
const malformedId = `bad-${'x'.repeat(500)}`;
malformedIdFallback = reduce(malformedIdFallback, before('malformed-id', {
  mode: 'status', taskId: malformedId,
}));
malformedIdFallback = reduce(malformedIdFallback, after('malformed-id', statusPayload()));
const boundedFallback = malformedIdFallback.history.at(-1);
assert('fallback result labels stay bounded for malformed long input ids',
  boundedFallback?.kind === 'tool' && [...boundedFallback.summary].length <= 40 &&
  boundedFallback.preview.includes(TASK_ID));

const beforeDenied = compact.history.length;
compact = reduce(compact, before('denied', { mode: 'status', taskId: TASK_ID }));
compact = reduce(compact, afterText('denied', 'DENIED: task unavailable\npolicy: execute blocked'));
const compactDenied = compact.history.at(-1);
assert('compact denied lifecycle calls retain realistic text diagnostics',
  compact.history.length === beforeDenied + 1 && compactDenied?.kind === 'tool' &&
  compactDenied.status === 'denied' && compactDenied.preview.includes('policy: execute blocked'));

let toggled = reduce(initialTurnState, before('active-toggle', { mode: 'status', taskId: TASK_ID }));
const active = toggled.activeTools[0]!;
const compactLabel = activeToolCallSummary(active.summary, active.compactSummary, toggled.backgroundDetailsExpanded);
toggled = turnReducer(toggled, { type: 'toggleBackgroundDetails' });
const expandedLabel = activeToolCallSummary(active.summary, active.compactSummary, toggled.backgroundDetailsExpanded);
assert('toggling changes the selected active summary immediately',
  compactLabel === active.compactSummary && expandedLabel === active.summary && compactLabel !== expandedLabel);

let expanded = turnReducer(initialTurnState, { type: 'toggleBackgroundDetails' });
let toggleNotice = expanded.history.at(-1);
assert('toggle enables details and appends an immediate notice',
  expanded.backgroundDetailsExpanded && toggleNotice?.kind === 'notice' &&
  toggleNotice.text === 'background details: expanded');
expanded = reduce(expanded, before('expanded-status', { mode: 'status', taskId: TASK_ID }));
expanded = reduce(expanded, after('expanded-status', statusPayload()));
const expandedStatus = expanded.history.at(-1);
assert('expanded mode retains the ordinary full successful preview',
  expandedStatus?.kind === 'tool' && expandedStatus.preview.includes('/private/task.log'));
expanded = reduce(expanded, before('expanded-denied', { mode: 'stop', taskId: TASK_ID }));
expanded = reduce(expanded, afterText('expanded-denied', 'DENIED: stop refused\nowner: policy'));
const expandedDenied = expanded.history.at(-1);
assert('expanded denied lifecycle calls retain full text diagnostics',
  expandedDenied?.kind === 'tool' && expandedDenied.status === 'denied' &&
  expandedDenied.preview.includes('owner: policy'));
expanded = turnReducer(expanded, { type: 'toggleBackgroundDetails' });
toggleNotice = expanded.history.at(-1);
assert('second toggle returns to compact with a notice',
  !expanded.backgroundDetailsExpanded && toggleNotice?.kind === 'notice' &&
  toggleNotice.text === 'background details: compact');

let foreground = initialTurnState;
foreground = reduce(foreground, before('foreground', { mode: 'execute', command: 'printf ok' }));
foreground = reduce(foreground, after('foreground', { output: 'ok' }));
const foregroundResult = foreground.history.at(-1);
assert('foreground bash keeps ordinary rendering',
  foregroundResult?.kind === 'tool' && foregroundResult.preview === '{"output":"ok"}');

const clockBefore = Date.now();
let stamped = reduce(initialTurnState, before('stamped-bg', { mode: 'status', taskId: TASK_ID }));
stamped = reduce(stamped, before('stamped-fg', { mode: 'execute', command: 'printf ok' }));
const clockAfter = Date.now();
assert('every active tool call is stamped with a start time for the elapsed suffix',
  stamped.activeTools.length === 2 && stamped.activeTools.every((tool) =>
    Number.isSafeInteger(tool.startedAt) && tool.startedAt >= clockBefore && tool.startedAt <= clockAfter));

let notices = turnReducer(initialTurnState, { type: 'notice', text: 'plain' });
notices = turnReducer(notices, { type: 'notice', text: 'degraded', severity: 'warn' });
notices = turnReducer(notices, { type: 'notice', text: 'broken', severity: 'error' });
const [plain, degraded, broken] = notices.history;
assert('a notice without a severity defaults to info',
  plain?.kind === 'notice' && plain.severity === 'info' && plain.text === 'plain');
assert('warn and error severities are preserved on the history item',
  degraded?.kind === 'notice' && degraded.severity === 'warn' &&
  broken?.kind === 'notice' && broken.severity === 'error');
const toggleSeverity = turnReducer(initialTurnState, { type: 'toggleBackgroundDetails' }).history.at(-1);
assert('the background-details toggle notice stays informational',
  toggleSeverity?.kind === 'notice' && toggleSeverity.severity === 'info');

report();

/** Focused, network-free contracts for all-tool detail presentation. */
import type { AgentStreamEvent } from '@strands-agents/sdk';
import { renderToString } from 'ink';
import React from 'react';

import {
  activeToolCallSummary,
  backgroundBashMode,
  compactBackgroundCallSummary,
  compactBackgroundResult,
} from '../src/tui/background-tool-presentation.js';
import { ActiveToolCalls, collapsePreview, ToolCallResult } from '../src/tui/ToolCallPanel.js';
import {
  COMPACT_RESULT_CODE_POINTS,
  COMPACT_RESULT_LINES,
  EXPANDED_INPUT_CODE_POINTS,
  EXPANDED_INPUT_LINES,
  EXPANDED_RESULT_CODE_POINTS,
  EXPANDED_RESULT_LINES,
  boundText,
  expandedToolInput,
  serializeToolInput,
} from '../src/tui/tool-detail-presentation.js';
import { initialTurnState, previewToolResult, turnReducer, type TurnState } from '../src/tui/turn-state.js';
import { TERMINAL_WAIT_TIMEOUT_INSTRUCTION } from '../src/tools/background-wait-contract.js';
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

function waitPayload(overrides: {
  reason?: string;
  status?: Record<string, unknown>;
  output?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  return {
    reason: overrides.reason ?? 'timeout',
    status: overrides.status ?? statusPayload(),
    output: overrides.output ?? outputPayload({ output: '', endOffset: 0 }),
  };
}

header('background tool presentation helpers');
assert('only lifecycle bash modes are recognized',
  backgroundBashMode('bash', { mode: 'status' }) === 'status' &&
  backgroundBashMode('bash', { mode: 'wait' }) === 'wait' &&
  backgroundBashMode('bash', { mode: 'execute' }) === undefined &&
  backgroundBashMode('fileEditor', { mode: 'status' }) === undefined);
assert('live summaries use short ids and bounded commands',
  compactBackgroundCallSummary('status', { taskId: TASK_ID }) === 'bash status: bg-12345678' &&
  compactBackgroundCallSummary('wait', { taskId: TASK_ID }) === 'bash wait: bg-12345678' &&
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

const waitOutputPayload = waitPayload({
  reason: 'output',
  output: outputPayload({ output: 'incremental wait output\n', endOffset: 24 }),
});
const providerVisibleWaitResult = JSON.stringify(waitOutputPayload);

const waitOutputProjection = compactBackgroundResult('wait', { taskId: TASK_ID }, [{
  type: 'jsonBlock', json: waitOutputPayload,
}]);
const guidedTimeoutPayload = waitPayload({
  reason: 'timeout',
  output: outputPayload({ output: 'retained terminal-focused output\n', endOffset: 33 }),
});
guidedTimeoutPayload.instruction = TERMINAL_WAIT_TIMEOUT_INSTRUCTION;
const guidedTimeoutProjection = compactBackgroundResult('wait', {
  taskId: TASK_ID,
  wakeOnOutput: false,
}, [{
  type: 'jsonBlock', json: guidedTimeoutPayload,
}]);
assert('compact projection leaves the provider-visible wait result untouched',
  JSON.stringify(waitOutputPayload) === providerVisibleWaitResult);

const terminalStatus = statusPayload({
  state: 'succeeded',
  finishedAt: '2026-01-01T00:00:01.000Z',
  exitCode: 0,
});
const terminalWaitProjection = compactBackgroundResult('wait', { taskId: TASK_ID }, [{
  type: 'jsonBlock', json: waitPayload({ reason: 'terminal', status: terminalStatus }),
}]);
const terminalWaitWithOutputProjection = compactBackgroundResult('wait', {
  taskId: TASK_ID,
  wakeOnOutput: false,
}, [{
  type: 'jsonBlock', json: waitPayload({
    reason: 'terminal',
    status: terminalStatus,
    output: outputPayload({ output: 'final incremental output\n', endOffset: 25 }),
  }),
}]);
const emptyRunningWaitReasons = ['changed', 'timeout', 'cancelled', 'shutdown'] as const;
assert('wait projections suppress every valid running result and retain only terminal state',
  emptyRunningWaitReasons.every((reason) =>
    compactBackgroundResult('wait', { taskId: TASK_ID }, [{
      type: 'jsonBlock', json: waitPayload({ reason }),
    }]).kind === 'suppress') &&
  waitOutputProjection.kind === 'suppress' &&
  guidedTimeoutProjection.kind === 'suppress' &&
  terminalWaitProjection.kind === 'compact' &&
  terminalWaitProjection.summary === 'bash wait: bg-12345678 succeeded' &&
  terminalWaitProjection.preview === '' &&
  terminalWaitWithOutputProjection.kind === 'compact' &&
  terminalWaitWithOutputProjection.summary === 'bash wait: bg-12345678 succeeded' &&
  terminalWaitWithOutputProjection.preview === '');

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
  compactBackgroundResult('wait', { taskId: TASK_ID }, [{
    type: 'jsonBlock', json: waitPayload({ reason: 'timeout', output: outputPayload({
      taskId: OTHER_TASK_ID, output: '', endOffset: 0,
    }) }),
  }]),
  compactBackgroundResult('wait', { taskId: TASK_ID }, [{
    type: 'jsonBlock', json: waitPayload({ reason: 'terminal' }),
  }]),
  compactBackgroundResult('wait', { taskId: TASK_ID }, [{
    type: 'jsonBlock', json: waitPayload({ reason: 'unknown' }),
  }]),
  compactBackgroundResult('wait', { taskId: TASK_ID }, [{
    type: 'jsonBlock', json: waitPayload({
      reason: 'changed',
      output: outputPayload({ output: 'contradictory output', endOffset: 20 }),
    }),
  }]),
  compactBackgroundResult('wait', { taskId: TASK_ID }, [{
    type: 'jsonBlock', json: waitPayload({
      reason: 'output',
      output: outputPayload({ output: '', endOffset: 0 }),
    }),
  }]),
  compactBackgroundResult('wait', { taskId: TASK_ID }, [{
    type: 'jsonBlock', json: { ...waitPayload({ reason: 'cancelled' }), instruction: 'wrong reason' },
  }]),
  compactBackgroundResult('wait', { taskId: TASK_ID }, [{
    type: 'jsonBlock', json: { ...waitPayload({ reason: 'timeout' }), instruction: TERMINAL_WAIT_TIMEOUT_INSTRUCTION },
  }]),
  compactBackgroundResult('wait', { taskId: TASK_ID, wakeOnOutput: false }, [{
    type: 'jsonBlock', json: waitPayload({ reason: 'timeout' }),
  }]),
  compactBackgroundResult('wait', { taskId: TASK_ID, wakeOnOutput: false }, [{
    type: 'jsonBlock', json: waitPayload({ reason: 'output' }),
  }]),
  compactBackgroundResult('wait', { taskId: TASK_ID, wakeOnOutput: false }, [{
    type: 'jsonBlock', json: { ...waitPayload({ reason: 'timeout' }), instruction: '' },
  }]),
  compactBackgroundResult('wait', { taskId: TASK_ID, wakeOnOutput: false }, [{
    type: 'jsonBlock', json: { ...waitPayload({ reason: 'timeout' }), instruction: 'unrecognized guidance' },
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

for (const [index, reason] of emptyRunningWaitReasons.entries()) {
  const beforeWait = compact.history.length;
  compact = reduce(compact, before(`wait-empty-${index}`, { mode: 'wait', taskId: TASK_ID, waitMs: 1000 }));
  assert('active wait uses a compact short-id summary',
    compact.activeTools[0]?.compactSummary === 'bash wait: bg-12345678');
  compact = reduce(compact, after(`wait-empty-${index}`, waitPayload({ reason })));
  assert('valid empty running waits create no static history', compact.history.length === beforeWait);
}

const beforeGuidedTimeout = compact.history.length;
compact = reduce(compact, before('wait-guided-timeout', {
  mode: 'wait', taskId: TASK_ID, waitMs: 300000, wakeOnOutput: false,
}));
compact = reduce(compact, after('wait-guided-timeout', guidedTimeoutPayload));
assert('compact mode suppresses a valid model-visible terminal-focused timeout instruction',
  compact.history.length === beforeGuidedTimeout && compact.activeTools.length === 0);

const beforeRunningWaitOutput = compact.history.length;
compact = reduce(compact, before('wait-output', { mode: 'wait', taskId: TASK_ID, waitMs: 1000 }));
compact = reduce(compact, after('wait-output', waitPayload({
  reason: 'output',
  output: outputPayload({ output: 'distinct wait chunk\n', endOffset: 20 }),
})));
assert('successful running waits with non-empty output create no static history',
  compact.history.length === beforeRunningWaitOutput && compact.activeTools.length === 0);

const beforeTerminalWait = compact.history.length;
compact = reduce(compact, before('wait-terminal', { mode: 'wait', taskId: TASK_ID, waitMs: 1000 }));
compact = reduce(compact, after('wait-terminal', waitPayload({
  reason: 'terminal',
  status: statusPayload({ state: 'failed', finishedAt: '2026-01-01T00:00:01.000Z', exitCode: 1 }),
})));
const terminalWait = compact.history.at(-1);
assert('a terminal wait without output retains exactly one concise terminal row',
  compact.history.length === beforeTerminalWait + 1 && compact.activeTools.length === 0 &&
  terminalWait?.kind === 'tool' && terminalWait.summary === 'bash wait: bg-12345678 failed' &&
  terminalWait.preview === '');
const beforeTerminalWaitOutput = compact.history.length;
compact = reduce(compact, before('wait-terminal-output', {
  mode: 'wait', taskId: TASK_ID, waitMs: 1000, wakeOnOutput: false,
}));
compact = reduce(compact, after('wait-terminal-output', waitPayload({
  reason: 'terminal',
  status: statusPayload({ state: 'succeeded', finishedAt: '2026-01-01T00:00:01.000Z', exitCode: 0 }),
  output: outputPayload({ output: 'final wait chunk\n', startOffset: 20, endOffset: 37 }),
})));
const terminalWaitWithOutput = compact.history.at(-1);
assert('a terminal wait with output still retains exactly one concise terminal row',
  compact.history.length === beforeTerminalWaitOutput + 1 && compact.activeTools.length === 0 &&
  terminalWaitWithOutput?.kind === 'tool' &&
  terminalWaitWithOutput.summary === 'bash wait: bg-12345678 succeeded' &&
  terminalWaitWithOutput.preview === '');

compact = reduce(compact, before('output', { mode: 'output', taskId: TASK_ID }));
compact = reduce(compact, after('output', outputPayload({ output: 'meaningful child output\n', endOffset: 24 })));
const childOutput = compact.history.at(-1);
assert('non-empty child output remains as concise tool history',
  childOutput?.kind === 'tool' && childOutput.preview === 'meaningful child output' &&
  childOutput.summary.includes('bg-12345678'));

compact = reduce(compact, before('status-fallback', { mode: 'status', taskId: TASK_ID }));
compact = reduce(compact, after('status-fallback', statusPayload({ diagnostic: 'retain status diagnostic' })));
const statusFallback = compact.history.at(-1);
assert('existing malformed status payloads still use bounded ordinary fallback',
  statusFallback?.kind === 'tool' && statusFallback.preview.includes('retain status diagnostic') &&
  statusFallback.summary === 'bash status: bg-12345678');

compact = reduce(compact, before('wait-fallback', { mode: 'wait', taskId: TASK_ID, waitMs: 1000 }));
compact = reduce(compact, after('wait-fallback', { ...waitPayload(), diagnostic: 'retain wait diagnostic' }));
const waitFallback = compact.history.at(-1);
assert('malformed successful wait payloads survive through bounded ordinary fallback',
  waitFallback?.kind === 'tool' && waitFallback.preview.includes('retain wait diagnostic') &&
  waitFallback.summary === 'bash wait: bg-12345678');

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

const beforeStatusDenied = compact.history.length;
compact = reduce(compact, before('status-denied', { mode: 'status', taskId: TASK_ID }));
compact = reduce(compact, afterText('status-denied', 'DENIED: task unavailable\npolicy: execute blocked'));
const compactStatusDenied = compact.history.at(-1);
assert('existing compact denied lifecycle calls retain realistic text diagnostics',
  compact.history.length === beforeStatusDenied + 1 && compactStatusDenied?.kind === 'tool' &&
  compactStatusDenied.status === 'denied' && compactStatusDenied.preview.includes('policy: execute blocked'));

const beforeWaitDenied = compact.history.length;
compact = reduce(compact, before('wait-denied', { mode: 'wait', taskId: TASK_ID, waitMs: 1000 }));
compact = reduce(compact, afterText('wait-denied', 'DENIED: wait unavailable\npolicy: execute blocked'));
const compactWaitDenied = compact.history.at(-1);
assert('compact denied wait calls retain realistic text diagnostics',
  compact.history.length === beforeWaitDenied + 1 && compactWaitDenied?.kind === 'tool' &&
  compactWaitDenied.status === 'denied' && compactWaitDenied.preview.includes('policy: execute blocked'));

const beforeError = compact.history.length;
compact = reduce(compact, before('error', { mode: 'wait', taskId: TASK_ID, waitMs: 1000 }));
compact = reduce(compact, afterText('error', 'wait failed\nlog unavailable', 'error'));
const compactError = compact.history.at(-1);
assert('compact error wait calls retain realistic text diagnostics',
  compact.history.length === beforeError + 1 && compactError?.kind === 'tool' &&
  compactError.status === 'error' && compactError.preview.includes('log unavailable'));

let toggled = reduce(initialTurnState, before('active-toggle', { mode: 'status', taskId: TASK_ID }));
const active = toggled.activeTools[0]!;
const compactLabel = activeToolCallSummary(active.summary, active.compactSummary, toggled.toolDetailsExpanded);
toggled = turnReducer(toggled, { type: 'toggleToolDetails' });
const expandedLabel = activeToolCallSummary(active.summary, active.compactSummary, toggled.toolDetailsExpanded);
assert('toggling changes the selected active summary immediately',
  compactLabel === active.compactSummary && expandedLabel === active.summary && compactLabel !== expandedLabel);

let expanded = turnReducer(initialTurnState, { type: 'toggleToolDetails' });
let toggleNotice = expanded.history.at(-1);
assert('toggle enables details and appends an immediate notice',
  expanded.toolDetailsExpanded && toggleNotice?.kind === 'notice' &&
  toggleNotice.text === 'tool details: expanded');
expanded = reduce(expanded, before('expanded-status', { mode: 'status', taskId: TASK_ID }));
expanded = reduce(expanded, after('expanded-status', statusPayload()));
const expandedStatus = expanded.history.at(-1);
assert('expanded mode retains the ordinary full successful preview',
  expandedStatus?.kind === 'tool' && expandedStatus.preview.includes('/private/task.log'));
expanded = reduce(expanded, before('expanded-wait', { mode: 'wait', taskId: TASK_ID, waitMs: 1000 }));
expanded = reduce(expanded, after('expanded-wait', waitOutputPayload));
const expandedWait = expanded.history.at(-1);
assert('expanded wait retains the ordinary full successful preview, output, and input',
  expandedWait?.kind === 'tool' && expandedWait.preview.includes('/private/task.log') &&
  expandedWait.preview.includes('sleep 10') &&
  expandedWait.preview.includes('incremental wait output') && expandedWait.inputPreview.includes('waitMs'));
expanded = reduce(expanded, before('expanded-guided-timeout', {
  mode: 'wait', taskId: TASK_ID, waitMs: 300000, wakeOnOutput: false,
}));
expanded = reduce(expanded, after('expanded-guided-timeout', guidedTimeoutPayload));
const expandedGuidedTimeout = expanded.history.at(-1);
assert('expanded terminal-focused timeout retains output and model-visible guidance',
  expandedGuidedTimeout?.kind === 'tool' &&
  expandedGuidedTimeout.preview.includes('retained terminal-focused output') &&
  expandedGuidedTimeout.preview.includes(TERMINAL_WAIT_TIMEOUT_INSTRUCTION));

expanded = reduce(expanded, before('expanded-denied', { mode: 'stop', taskId: TASK_ID }));
expanded = reduce(expanded, afterText('expanded-denied', 'DENIED: stop refused\nowner: policy'));
const expandedDenied = expanded.history.at(-1);
assert('expanded denied lifecycle calls retain full text diagnostics',
  expandedDenied?.kind === 'tool' && expandedDenied.status === 'denied' &&
  expandedDenied.preview.includes('owner: policy'));
expanded = reduce(expanded, before('expanded-wait-error', {
  mode: 'wait', taskId: TASK_ID, waitMs: 1000,
}));
expanded = reduce(expanded, afterText('expanded-wait-error', 'wait failed\nowner: manager', 'error'));
const expandedWaitError = expanded.history.at(-1);
assert('expanded wait errors retain ordinary input and full text diagnostics',
  expandedWaitError?.kind === 'tool' && expandedWaitError.status === 'error' &&
  expandedWaitError.preview.includes('owner: manager') && expandedWaitError.inputPreview.includes('waitMs'));
expanded = turnReducer(expanded, { type: 'toggleToolDetails' });
toggleNotice = expanded.history.at(-1);
assert('second toggle returns to compact with a notice',
  !expanded.toolDetailsExpanded && toggleNotice?.kind === 'notice' &&
  toggleNotice.text === 'tool details: compact');

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

assert('every active tool retains input for immediate expanded rendering',
  stamped.activeTools[1]?.input !== undefined &&
  JSON.stringify(stamped.activeTools[1]?.input).includes('printf ok'));

header('all-tool active and immutable rendering');
let ordinaryActive = reduce(initialTurnState, event({
  type: 'beforeToolCallEvent',
  toolUse: {
    name: 'mcp__catalog__lookup',
    toolUseId: 'ordinary-active',
    input: { query: 'needle', nested: { enabled: true } },
  },
}));
// Rendered with room to spare: what this asserts is the panel's content, and the
// bounded case is `verify-frame-budget.ts`'s property.
const compactActiveRender = renderToString(React.createElement(ActiveToolCalls, {
  tools: ordinaryActive.activeTools,
  frame: 0,
  toolDetailsExpanded: ordinaryActive.toolDetailsExpanded,
  columns: 80,
  maxRows: 200,
}));
ordinaryActive = turnReducer(ordinaryActive, { type: 'toggleToolDetails' });
const expandedActiveRender = renderToString(React.createElement(ActiveToolCalls, {
  tools: ordinaryActive.activeTools,
  frame: 0,
  toolDetailsExpanded: ordinaryActive.toolDetailsExpanded,
  columns: 80,
  maxRows: 200,
}));
assert('an active ordinary tool immediately gains bounded input when expanded',
  !compactActiveRender.includes('Input:') &&
  expandedActiveRender.includes('Input:') && expandedActiveRender.includes('needle'));
ordinaryActive = reduce(ordinaryActive, event({
  type: 'afterToolCallEvent',
  toolUse: { name: 'mcp__catalog__lookup', toolUseId: 'ordinary-active', input: {} },
  result: {
    status: 'success',
    content: [{ type: 'textBlock', text: 'x'.repeat(EXPANDED_RESULT_CODE_POINTS + 50) }],
  },
}));
const completedAfterToggle = ordinaryActive.history.at(-1);
assert('the mode selected while active stamps and bounds the result at completion',
  completedAfterToggle?.kind === 'tool' && completedAfterToggle.expanded &&
  completedAfterToggle.inputPreview.includes('needle') &&
  [...completedAfterToggle.preview.split('\n')[0]!].length === EXPANDED_RESULT_CODE_POINTS &&
  completedAfterToggle.preview.includes('truncated 50 code points'));

let completedCompact = reduce(initialTurnState, event({
  type: 'beforeToolCallEvent',
  toolUse: { name: 'mcp__catalog__lookup', toolUseId: 'immutable', input: { query: 'fixed' } },
}));
completedCompact = reduce(completedCompact, event({
  type: 'afterToolCallEvent',
  toolUse: { name: 'mcp__catalog__lookup', toolUseId: 'immutable', input: {} },
  result: { status: 'success', content: [{ type: 'textBlock', text: 'fixed result' }] },
}));
const immutableItem = completedCompact.history.at(-1);
const immutableRender = immutableItem?.kind === 'tool'
  ? renderToString(React.createElement(ToolCallResult, { item: immutableItem }))
  : '';
const afterImmutableToggle = turnReducer(completedCompact, { type: 'toggleToolDetails' });
const retainedItem = afterImmutableToggle.history.at(-2);
const retainedRender = retainedItem?.kind === 'tool'
  ? renderToString(React.createElement(ToolCallResult, { item: retainedItem }))
  : '';
assert('a completed compact item remains the same immutable projection after a later toggle',
  retainedItem === immutableItem && immutableRender === retainedRender &&
  !retainedRender.includes('Input:') && !retainedRender.includes('Result:'));

const expandedRender = expandedStatus?.kind === 'tool'
  ? renderToString(React.createElement(ToolCallResult, { item: expandedStatus }))
  : '';
assert('completed expanded rows render distinct bounded Input and Result sections',
  expandedRender.includes('Input:') && expandedRender.includes('Result:') &&
  expandedRender.includes('bg-12345678') && expandedRender.includes('/private/task.log'));

assert('compact completed tools stamp compact mode with no retained input preview',
  foregroundResult?.kind === 'tool' && !foregroundResult.expanded && foregroundResult.inputPreview === '');
assert('expanded completed tools stamp expanded mode and bounded input',
  expandedStatus?.kind === 'tool' && expandedStatus.expanded &&
  expandedStatus.inputPreview.includes('bg-12345678'));

let notices = turnReducer(initialTurnState, { type: 'notice', text: 'plain' });
notices = turnReducer(notices, { type: 'notice', text: 'degraded', severity: 'warn' });
notices = turnReducer(notices, { type: 'notice', text: 'broken', severity: 'error' });
const [plain, degraded, broken] = notices.history;
assert('a notice without a severity defaults to info',
  plain?.kind === 'notice' && plain.severity === 'info' && plain.text === 'plain');
assert('warn and error severities are preserved on the history item',
  degraded?.kind === 'notice' && degraded.severity === 'warn' &&
  broken?.kind === 'notice' && broken.severity === 'error');
const toggleSeverity = turnReducer(initialTurnState, { type: 'toggleToolDetails' }).history.at(-1);
assert('the tool-details toggle notice stays informational',
  toggleSeverity?.kind === 'notice' && toggleSeverity.severity === 'info');

const sixLines = ['one', 'two', 'three', 'four', 'five', 'six'].join('\n');
assert('successful previews keep the head with an explicit line/code-point marker',
  JSON.stringify(collapsePreview(sixLines, 'ok')) ===
  JSON.stringify(['one', 'two', 'three', 'four', '… truncated 9 code points and 2 lines']));
assert('error previews keep the tail with an explicit line/code-point marker',
  JSON.stringify(collapsePreview(sixLines, 'error')) ===
  JSON.stringify(['… truncated 8 code points and 2 lines', 'three', 'four', 'five', 'six']));
const deniedLines = ['DENIED: policy says no', 'ctx-a', 'ctx-b', 'ctx-c', 'ctx-d', 'ctx-e'].join('\n');
assert('denied previews keep the DENIED: head line plus the tail',
  JSON.stringify(collapsePreview(deniedLines, 'denied')) ===
  JSON.stringify(['DENIED: policy says no', '… truncated 12 code points and 2 lines', 'ctx-c', 'ctx-d', 'ctx-e']));
const shortLines = 'alpha\nbeta';
assert('short previews are unchanged for every status',
  (['ok', 'error', 'denied'] as const).every((status) =>
    JSON.stringify(collapsePreview(shortLines, status)) === JSON.stringify(['alpha', 'beta'])));
assert('blank previews collapse to nothing for every status',
  (['ok', 'error', 'denied'] as const).every((status) => collapsePreview('  \n ', status).length === 0));

const minifiedJson = JSON.stringify({ data: 'x'.repeat(COMPACT_RESULT_CODE_POINTS + 500) });
const compactJson = collapsePreview(minifiedJson, 'ok');
assert('a minified single-line JSON result is bounded by code points',
  compactJson.length === 2 && [...compactJson[0]!].length === COMPACT_RESULT_CODE_POINTS &&
  compactJson[1]?.includes('truncated 511 code points') === true);
const unicodeJson = `${'x'.repeat(COMPACT_RESULT_CODE_POINTS - 1)}😀tail`;
const unicodePreview = collapsePreview(unicodeJson, 'ok');
assert('code-point truncation preserves a complete emoji',
  unicodePreview[0]?.endsWith('😀') === true && !unicodePreview.join('').includes('\uFFFD'));

const expandedJson = collapsePreview('x'.repeat(COMPACT_RESULT_CODE_POINTS + 500), 'ok', true);
assert('expanded result uses the larger bound',
  expandedJson.length === 1 && (expandedJson[0]?.length ?? 0) > COMPACT_RESULT_CODE_POINTS);
const hugeExpanded = collapsePreview('x'.repeat(EXPANDED_RESULT_CODE_POINTS + 100), 'ok', true);
assert('expanded result is still bounded and marked',
  [...hugeExpanded[0]!].length === EXPANDED_RESULT_CODE_POINTS &&
  hugeExpanded[1]?.includes('truncated 100 code points') === true);
const expandedInput = expandedToolInput({ value: 'x'.repeat(EXPANDED_INPUT_CODE_POINTS + 100) });
assert('expanded input is bounded and marked',
  [...expandedInput.slice(0, -1).join('\n')].length === EXPANDED_INPUT_CODE_POINTS &&
  expandedInput.at(-1)?.includes('truncated') === true);

const composed = `${'a'.repeat(COMPACT_RESULT_CODE_POINTS)}\nline-two\nline-three\nline-four\nline-five`;
const composedPreview = collapsePreview(composed, 'ok');
assert('line and code-point caps compose and report omissions from both limits',
  composedPreview.slice(0, -1).length === 1 &&
  [...composedPreview[0]!].length === COMPACT_RESULT_CODE_POINTS &&
  composedPreview.at(-1)?.includes('code points and 4 lines') === true);

const longError = `${'head'.repeat(600)}\n${['trace-a', 'trace-b', 'trace-c', 'trace-d', 'FINAL DIAGNOSTIC'].join('\n')}`;
const boundedError = collapsePreview(longError, 'error');
assert('code-point-bounded errors retain the diagnostic tail',
  boundedError.at(-1) === 'FINAL DIAGNOSTIC' &&
  [...boundedError.filter((line) => !line.startsWith('… truncated')).join('\n')].length <=
    COMPACT_RESULT_CODE_POINTS);
const deniedAtBudgetEdge = boundText(
  `${'D'.repeat(COMPACT_RESULT_CODE_POINTS - 1)}\ntail must not bypass the cap`,
  'denied',
  { codePoints: COMPACT_RESULT_CODE_POINTS, lines: COMPACT_RESULT_LINES },
);
assert('a denied reason that exhausts the point budget cannot leak an unbounded tail',
  deniedAtBudgetEdge[0] === 'D'.repeat(COMPACT_RESULT_CODE_POINTS - 1) &&
  !deniedAtBudgetEdge.join('\n').includes('tail must not bypass') &&
  deniedAtBudgetEdge.at(-1)?.includes('truncated') === true);

const expandedLineResult = collapsePreview(
  Array.from({ length: EXPANDED_RESULT_LINES + 5 }, (_, index) => `result-${index}`).join('\n'),
  'ok',
  true,
);
assert('expanded result enforces its logical-line cap independently',
  expandedLineResult.slice(0, -1).length === EXPANDED_RESULT_LINES &&
  expandedLineResult.at(-1)?.includes('5 lines') === true);
const expandedLineInput = expandedToolInput({
  rows: Array.from({ length: EXPANDED_INPUT_LINES + 20 }, (_, index) => `input-${index}`),
});
assert('expanded input enforces its logical-line cap independently',
  expandedLineInput.slice(0, -1).length === EXPANDED_INPUT_LINES &&
  expandedLineInput.at(-1)?.includes('line') === true);

const circular: { self?: unknown } = {};
circular.self = circular;
assert('input serialization survives circular and hostile values',
  serializeToolInput(circular) === '[object Object]' &&
  serializeToolInput({ toString: () => { throw new Error('nope'); }, self: circular }) ===
    '[unprintable input]');

assert('media and binary result blocks stay as labels instead of dumping payload data',
  previewToolResult([
    { type: 'imageBlock', image: { format: 'png', source: { bytes: 'base64-data' } } },
    { type: 'documentBlock', document: { bytes: 'document-data' } },
  ]) === '[imageBlock]\n[documentBlock]');

report();

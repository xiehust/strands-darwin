/** Offline contracts for SER-036 structured progress. */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Agent, Model } from '@strands-agents/sdk';
import type { BaseModelConfig, BeforeToolCallEvent, Message, ModelStreamEvent } from '@strands-agents/sdk';
import { renderToString } from 'ink';
import React from 'react';
import { PermissionGate } from '../src/agent/permission.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { createUpdatePlanTool, MAX_PLAN_ITEMS, UPDATE_PLAN_TOOL_NAME } from '../src/tools/update-plan.js';
import { MessageList } from '../src/tui/MessageList.js';
import { PlanChecklist } from '../src/tui/PlanChecklist.js';
import { planRows } from '../src/tui/plan-format.js';
import { initialTurnState, turnReducer, type TurnState } from '../src/tui/turn-state.js';
import { formatReplay, replayRecords } from '../src/trajectory/replay.js';
import type { TrajectoryRecord } from '../src/trajectory/record.js';
import { assert, header, ownPrivateHome, report } from './shared.js';
import { stripAnsi } from './tui-driver.js';

ownPrivateHome('update-plan');

class OfflineModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'offline.update-plan', contextWindowLimit: 10_000 };
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    throw new Error('update_plan verification must not call a model');
  }
}

function resultStatus(value: unknown): string {
  return (value as { status?: string }).status ?? '';
}

function before(id: string, input: unknown, name = UPDATE_PLAN_TOOL_NAME): never {
  return { type: 'beforeToolCallEvent', toolUse: { name, toolUseId: id, input } } as never;
}
function after(id: string, input: unknown, status: 'success' | 'error' = 'success', name = UPDATE_PLAN_TOOL_NAME): never {
  return {
    type: 'afterToolCallEvent',
    toolUse: { name, toolUseId: id, input },
    result: { status, content: [{ type: 'textBlock', text: status === 'success' ? 'Plan updated' : 'invalid' }] },
  } as never;
}
function stream(state: TurnState, event: never): TurnState {
  return turnReducer(state, { type: 'streamEvent', event });
}

const temp = await mkdtemp(path.join(os.tmpdir(), 'darwin-update-plan-'));
try {
  header('update_plan — real SDK tool validates without I/O');
  const agent = new Agent({ model: new OfflineModel(), tools: [createUpdatePlanTool()], printer: false });
  await agent.initialize();
  assert('the real Agent registers update_plan', agent.tools.map((entry) => entry.name).includes(UPDATE_PLAN_TOOL_NAME));

  const invoke = (input: unknown) => agent.tool[UPDATE_PLAN_TOOL_NAME]!.invoke(input as never);
  const valid = await invoke({ plan: [{ item: 'Inspect', status: 'completed' }, { item: 'Verify', status: 'in_progress' }] });
  assert('a valid complete list succeeds', resultStatus(valid) === 'success');
  const invalids = [
    { plan: [] },
    { plan: Array.from({ length: MAX_PLAN_ITEMS + 1 }, (_, index) => ({ item: `item ${index}`, status: 'pending' })) },
    { plan: [{ item: '', status: 'pending' }] },
    { plan: [{ item: 'x'.repeat(201), status: 'pending' }] },
    { plan: Array.from({ length: 20 }, (_, index) => ({ item: `${index.toString().padStart(2, '0')}${'x'.repeat(99)}`, status: 'pending' })) },
    { plan: [{ item: 'same', status: 'pending' }, { item: 'same', status: 'completed' }] },
    { plan: [{ item: 'x', status: 'cancelled' }] },
    { plan: [{ item: 'x', status: 'pending', extra: true }] },
  ];
  for (const [index, input] of invalids.entries()) {
    assert(`invalid shape ${index + 1} is a tool error`, resultStatus(await invoke(input)) === 'error');
  }
  assert('the callback creates no project/config/session files', (await readdir(temp)).length === 0);

  header('update_plan — permission and catalogue boundaries');
  for (const mode of ['default', 'auto', 'plan', 'yolo'] as const) {
    let asked = 0;
    const gate = new PermissionGate({ mode, projectRoot: temp, ask: async () => { asked += 1; return { allowed: true }; } });
    const action = await gate.beforeToolCall({
      toolUse: { name: UPDATE_PLAN_TOOL_NAME, input: { plan: [{ item: 'x', status: 'pending' }] } },
      agent: { id: 'darwin' },
    } as unknown as BeforeToolCallEvent);
    assert(`${mode} permits update_plan without prompting`, action.type === 'proceed' && asked === 0);
  }
  const runtimeRoot = path.join(temp, 'runtime');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(runtimeRoot));
  const runtime = await AgentRuntime.create({
    projectRoot: runtimeRoot,
    session: { kind: 'new' },
    permissionBridge: async () => ({ allowed: false }),
  });
  try {
    const runtimeAgent = (runtime as unknown as { agent: Agent }).agent;
    const subagents = (runtime as unknown as { subagents: { options: { tools: readonly { name: string }[] } } }).subagents;
    assert('the assembled parent catalogue contains update_plan', runtimeAgent.tools.some((entry) => entry.name === UPDATE_PLAN_TOOL_NAME));
    assert('the assembled child catalogue excludes update_plan', !subagents.options.tools.some((entry) => entry.name === UPDATE_PLAN_TOOL_NAME));
  } finally {
    await runtime.shutdown();
  }

  header('update_plan — reducer replacement and one final Static projection');
  const first = { plan: [{ item: 'First', status: 'in_progress' as const }, { item: 'Later', status: 'pending' as const }] };
  const latest = { plan: [{ item: 'First', status: 'completed' as const }, { item: 'Verify', status: 'in_progress' as const }] };
  let state = stream(initialTurnState, before('p1', first));
  state = stream(state, after('p1', first));
  state = stream(state, before('other', { command: 'git status' }, 'bash'));
  state = stream(state, after('other', { command: 'git status' }, 'success', 'bash'));
  state = stream(state, before('p2', latest));
  state = stream(state, after('p2', latest));
  assert('the latest successful whole list replaces the prior list during a multi-tool turn',
    state.livePlan.map((entry) => `${entry.status}:${entry.item}`).join('|') === 'completed:First|in_progress:Verify');
  const historyBeforeEnd = state.history.length;
  state = turnReducer(state, { type: 'turnEnded' });
  assert('turn end clears live state and appends one final plan item',
    state.livePlan.length === 0 && state.history.length === historyBeforeEnd + 1 && state.history.at(-1)?.kind === 'plan');
  const endedAgain = turnReducer(state, { type: 'turnEnded' });
  assert('a repeated end cannot commit the final list twice', endedAgain.history.length === state.history.length);
  const next = turnReducer(state, { type: 'userInput', text: 'next turn' });
  assert('live plan remains absent before the next turn', next.livePlan.length === 0);
  const closingText = 'final user-facing summary';
  let closing = turnReducer(initialTurnState, { type: 'userInput', text: 'work' });
  closing = stream(closing, before('closing-plan', latest));
  closing = stream(closing, after('closing-plan', latest));
  closing = stream(closing, {
    type: 'contentBlockEvent',
    contentBlock: { type: 'textBlock', text: closingText },
  } as never);
  closing = turnReducer(closing, { type: 'turnEnded' });
  const finalPlanAt = closing.history.findIndex((item) => item.kind === 'plan');
  const closingAnswerAt = closing.history.findIndex(
    (item) => item.kind === 'assistant' && item.text === closingText,
  );
  assert('the final checklist precedes the closing answer so progress cannot hide the summary',
    finalPlanAt >= 0 && closingAnswerAt === finalPlanAt + 1 && closing.history.at(-1)?.kind === 'assistant');
  let chunked = turnReducer(initialTurnState, { type: 'userInput', text: 'chunked work' });
  chunked = stream(chunked, before('chunked-plan', latest));
  chunked = stream(chunked, after('chunked-plan', latest));
  chunked = {
    ...chunked,
    history: [
      ...chunked.history,
      { kind: 'assistant', id: 'chunk-first', text: 'summary line 1\n', part: 'first', codeOpen: false },
      { kind: 'assistant', id: 'chunk-middle', text: 'summary line 2\n', part: 'middle', codeOpen: false },
      { kind: 'assistant', id: 'chunk-last', text: 'summary line 3', part: 'last', codeOpen: false },
    ],
  };
  chunked = turnReducer(chunked, { type: 'turnEnded' });
  const chunkPlanAt = chunked.history.findIndex((item) => item.kind === 'plan');
  assert('the final checklist never splits a progressively committed closing answer',
    chunkPlanAt >= 0 && chunked.history.slice(chunkPlanAt + 1).map((item) => item.kind).join(',') === 'assistant,assistant,assistant');
  let toolEnded = turnReducer(initialTurnState, { type: 'userInput', text: 'tool-ended work' });
  toolEnded = stream(toolEnded, {
    type: 'contentBlockEvent',
    contentBlock: { type: 'textBlock', text: 'preamble before tools' },
  } as never);
  toolEnded = stream(toolEnded, before('tool-ended-plan', latest));
  toolEnded = stream(toolEnded, after('tool-ended-plan', latest));
  toolEnded = turnReducer(toolEnded, { type: 'turnEnded' });
  assert('a tool-ending turn keeps its final checklist after the tool that produced it',
    toolEnded.history.at(-2)?.kind === 'tool' && toolEnded.history.at(-1)?.kind === 'plan');

  header('update_plan — bounded rows and ANSI-stable status markers');
  const longPlan = Array.from({ length: 8 }, (_, index) => ({
    item: `item ${index + 1}`,
    status: (index % 3 === 0 ? 'completed' : index % 3 === 1 ? 'in_progress' : 'pending') as 'completed' | 'in_progress' | 'pending',
  }));
  const rows = planRows(longPlan, 4);
  assert('the formatter never exceeds its grant', rows.length === 4);
  assert('the bounded projection states the exact hidden count', rows.at(-1) === '… 6 more plan items');
  const live = stripAnsi(renderToString(<PlanChecklist plan={longPlan} maxRows={4} />, { columns: 80 }));
  assert('the live component renders exactly the granted rows', live.split('\n').length === 4);
  assert('ANSI-stripped markers retain completed and in-progress meaning', live.includes('[x] item 1') && live.includes('[>] item 2'));
  const adversarialPlan = Array.from({ length: 12 }, (_, index) => ({
    item: `${index}-${'narrow-long-'.repeat(15)}`,
    status: 'pending' as const,
  }));
  const adversarialLive = stripAnsi(renderToString(
    <PlanChecklist plan={adversarialPlan} maxRows={4} />,
    { columns: 12 },
  ));
  assert('narrow long live items occupy the exact four-row grant', adversarialLive.split('\n').length === 4);
  const adversarialState = {
    ...state,
    history: [{ kind: 'plan' as const, id: 'adversarial-plan', plan: adversarialPlan }],
  };
  const adversarialFinal = stripAnsi(renderToString(
    <MessageList history={adversarialState.history} liveText="" liveCodeOpen={false} columns={12} maxLiveRows={0} staticEpoch={0} />,
    { columns: 12 },
  ));
  assert('narrow long final items occupy twelve content rows plus the intentional history margin',
    adversarialFinal.split('\n').length === 13);
  const final = stripAnsi(renderToString(
    <MessageList history={state.history} liveText="" liveCodeOpen={false} columns={80} maxLiveRows={0} staticEpoch={0} />,
    { columns: 80 },
  ));

  header('update_plan — trajectory and replay use ordinary tool evidence only');
  const envelope = (seq: number, type: string, fields: Record<string, unknown>): TrajectoryRecord => ({
    v: 1,
    seq,
    t: `2026-08-23T00:00:0${seq}.000Z`,
    turn: 1,
    type,
    ...fields,
  } as TrajectoryRecord);
  const records: TrajectoryRecord[] = [
    envelope(0, 'userInput', { text: 'work' }),
    envelope(1, 'beforeToolCallEvent', { data: { toolUse: { name: UPDATE_PLAN_TOOL_NAME, toolUseId: 'plan-record', input: latest } } }),
    envelope(2, 'afterToolCallEvent', { data: {
      toolUse: { name: UPDATE_PLAN_TOOL_NAME, toolUseId: 'plan-record', input: latest },
      result: { toolResult: {
        toolUseId: 'plan-record',
        status: 'success',
        content: [{ text: 'Plan updated: 2 items.' }],
      } },
    } }),
    envelope(3, 'turnEnded', { stopReason: 'endTurn', ms: 1, recorded: {}, dropped: {} }),
  ];
  const replay = replayRecords(records);
  const replayText = formatReplay({ ...replay, damage: undefined });
  assert('the record needs no plan-specific type',
    records.map((record) => record.type).join(',') === 'userInput,beforeToolCallEvent,afterToolCallEvent,turnEnded');
  assert('replay retains the ordinary update_plan result row', replayText.includes('tool update_plan [ok]'));
  assert('replay does not add the TUI-only final checklist projection', !replayText.includes('plan final ·'));

  assert('the final checklist is present once in Static output', final.split('plan final ·').length === 2);

  report();
} finally {
  await rm(temp, { recursive: true, force: true });
}

/** Offline SRF-015 contracts: safe heartbeats, targeted cancellation, and live projection. */
import { Agent, Model } from '@strands-agents/sdk';
import type { BaseModelConfig, Message, ModelStreamEvent } from '@strands-agents/sdk';
import { renderToString } from 'ink';
import React from 'react';

import { PermissionGate } from '../src/agent/permission.js';
import {
  SubagentDispatchRegistry,
  type SubagentDispatchProgress,
} from '../src/agents/dispatch-registry.js';
import type { AgentDefinitionRegistry } from '../src/agents/loader.js';
import { SubagentTool } from '../src/agents/subagent-tool.js';
import { StructuredHeadlessWriter } from '../src/headless-protocol.js';
import { ActiveToolCalls } from '../src/tui/ToolCallPanel.js';
import { initialTurnState, turnReducer } from '../src/tui/turn-state.js';
import { assert, header, report } from './shared.js';
import { stripAnsi } from './tui-driver.js';

const CANARIES = ['SECRET-REASONING', 'SECRET-TOOL-INPUT', 'SECRET-TOOL-RESULT', 'SECRET-CHILD-TRANSCRIPT'];
const registry: AgentDefinitionRegistry = {
  definitions: [{
    name: 'general',
    description: 'offline child',
    systemPrompt: 'offline',
    tools: undefined,
    file: '/tmp/general.md',
  }],
  problems: [],
};

class FailingChildModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'offline.failing-child', contextWindowLimit: 10_000 };
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    await wait(35);
    throw new Error('SECRET-CHILD-FAILURE');
  }
}

class SlowChildModel extends Model<BaseModelConfig> {
  calls = 0;
  private config: BaseModelConfig = { modelId: 'offline.child', contextWindowLimit: 10_000 };
  constructor(private readonly delayMs: number, private readonly reportText: string) { super(); }
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: this.reportText } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

function subagents(dispatches: SubagentDispatchRegistry, models: Model<BaseModelConfig>[]): SubagentTool {
  return new SubagentTool({
    registry,
    tools: [],
    intervention: new PermissionGate({ mode: 'yolo', projectRoot: '/tmp', ask: async () => ({ allowed: true }) }),
    projectInstructions: undefined,
    config: { model: 'offline', provider: 'bedrock', region: 'us-west-2' } as never,
    createModel: async () => models.shift()!,
    dispatches,
  });
}

function parent(tool: SubagentTool): Agent {
  class ParentModel extends Model<BaseModelConfig> {
    private config: BaseModelConfig = { modelId: 'offline.parent', contextWindowLimit: 10_000 };
    private sent = false;
    override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
    override getConfig(): BaseModelConfig { return this.config; }
    override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
      const results = messages.flatMap((message) => message.content).filter((block) => block.type === 'toolResultBlock');
      yield { type: 'modelMessageStartEvent', role: 'assistant' };
      if (!this.sent) {
        this.sent = true;
        for (const [id, task] of [['alpha001', 'public alpha summary'], ['bravo002', 'public bravo summary']] as const) {
          yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'subagent', toolUseId: id } };
          yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify({ task }) } };
          yield { type: 'modelContentBlockStopEvent' };
        }
        yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
        return;
      }
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: `parent received ${results.length} reports` } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    }
  }
  return new Agent({ model: new ParentModel(), tools: [tool.tool], printer: false });
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

header('subagent heartbeats — interval, privacy, independent cancellation');
const dispatches = new SubagentDispatchRegistry({ heartbeatIntervalMs: 25 });
const models = [
  new SlowChildModel(180, 'cancelled child report must not leak'),
  new SlowChildModel(105, 'successful child report'),
];
const tool = subagents(dispatches, models);
const realParent = parent(tool);
await realParent.initialize();
const progress: SubagentDispatchProgress[] = [];
const unsubscribe = dispatches.subscribeProgress((event) => progress.push(event));
const invocation = realParent.invoke('delegate twice');
await wait(18);
assert('no heartbeat appears before the configured interval', progress.filter((event) => event.heartbeat).length === 0);
await wait(25);
const running = dispatches.list().filter((entry) => entry.state === 'running');
assert('parallel children have distinct stable public ids', running.length === 2 && new Set(running.map((entry) => entry.dispatchId)).size === 2);
const target = running[0]!;
const survivor = running[1]!;
assert('unknown id is a harmless local refusal', dispatches.cancel('missing0').outcome === 'not-found');
assert('one exact id accepts targeted cancellation', dispatches.cancel(target.dispatchId).outcome === 'cancelled');
assert('a repeated request is harmless', dispatches.cancel(target.dispatchId).outcome === 'already-requested');
const result = await invocation;
assert('the parent turn completes rather than being cancelled', result.stopReason === 'endTurn');
assert('the parent receives both tool results exactly once', result.toString() === 'parent received 2 reports');
const final = dispatches.list();
assert('targeted child is cancelled while its sibling succeeds', final.find((entry) => entry.dispatchId === target.dispatchId)?.state === 'cancelled' && final.find((entry) => entry.dispatchId === survivor.dispatchId)?.state === 'succeeded');
assert('terminal id is a harmless local refusal', dispatches.cancel(survivor.dispatchId).outcome === 'terminal');
const heartbeats = progress.filter((event) => event.heartbeat);
assert('active dispatches emit periodic stable-id increasing elapsed heartbeats', heartbeats.length >= 2 && heartbeats.every((event) => event.elapsedMs >= 25) && heartbeats.some((event, index) => index > 0 && event.elapsedMs > heartbeats[index - 1]!.elapsedMs));
assert('phase metadata is closed and bounded', progress.every((event) => event.phase.kind === 'starting' || event.phase.kind === 'model' || (event.phase.kind === 'tool' && /^[a-zA-Z0-9_.-]{1,64}$/.test(event.phase.toolName))));
assert('progress contains no reasoning, payload, result, or transcript canaries', CANARIES.every((canary) => !JSON.stringify(progress).includes(canary)));
const settledCount = progress.length;
await wait(55);
assert('success and cancellation clear heartbeat timers', progress.length === settledCount);
unsubscribe();
await tool.shutdown();


header('subagent heartbeats — failure cleanup');
const failingDispatches = new SubagentDispatchRegistry({ heartbeatIntervalMs: 20 });
const failingTool = subagents(failingDispatches, [new FailingChildModel()]);
const failureProgress: SubagentDispatchProgress[] = [];
failingDispatches.subscribeProgress((event) => failureProgress.push(event));
class UnusedParentModel extends SlowChildModel {}
const failingParent = new Agent({ model: new UnusedParentModel(0, 'unused'), tools: [failingTool.tool], printer: false });
await failingParent.initialize();
await failingParent.tool.subagent?.invoke({ task: 'public failure task' }).catch(() => undefined);
assert('a throwing child settles failed', failingDispatches.list()[0]?.state === 'failed');
const failureSettledCount = failureProgress.length;
await wait(45);
assert('failure clears its heartbeat timer and exposes no error payload', failureProgress.length === failureSettledCount && !JSON.stringify(failureProgress).includes('SECRET-CHILD-FAILURE'));
await failingTool.shutdown();

header('subagent heartbeats — existing full cancellation and presentation seams');
const allDispatches = new SubagentDispatchRegistry({ heartbeatIntervalMs: 20 });
const allTool = subagents(allDispatches, [new SlowChildModel(200, 'one'), new SlowChildModel(200, 'two')]);
const allParent = parent(allTool);
await allParent.initialize();
const allInvocation = allParent.invoke('delegate twice');
await wait(35);
allTool.cancelActive();
allParent.cancel();
const allResult = await allInvocation;
assert('parent full cancellation still cancels the whole turn', allResult.stopReason === 'cancelled');
assert('parent full cancellation leaves no running children', allDispatches.list().every((entry) => entry.state === 'cancelled'));
await allTool.shutdown();

const uiProgress = heartbeats.at(-1)!;
let state = turnReducer(initialTurnState, {
  type: 'streamEvent',
  event: { type: 'beforeToolCallEvent', toolUse: { name: 'subagent', toolUseId: `tooluse_${uiProgress.dispatchId}`, input: { task: 'public task' } } } as never,
});
state = turnReducer(state, { type: 'subagentProgress', progress: uiProgress });
const rendered = stripAnsi(renderToString(React.createElement(ActiveToolCalls, {
  tools: state.activeTools,
  frame: 0,
  toolDetailsExpanded: false,
  columns: 80,
  maxRows: 1,
})));
assert('TUI reuses one granted live tool row with id, elapsed, and safe phase', rendered.split('\n').length === 1 && rendered.includes(uiProgress.dispatchId) && rendered.includes('model'));
const hidden = stripAnsi(renderToString(React.createElement(ActiveToolCalls, {
  tools: [...state.activeTools, ...state.activeTools.map((entry) => ({ ...entry, id: `${entry.id}2` }))],
  frame: 0,
  toolDetailsExpanded: false,
  columns: 80,
  maxRows: 1,
})));
assert('frame-budget omission is stated instead of overflowing the grant', hidden.split('\n').length === 1 && hidden.includes('more tool calls running'));

const jsonl: string[] = [];
const streamWriter = new StructuredHeadlessWriter('stream-json', (text) => jsonl.push(text), 'session');
streamWriter.subagentProgress({ dispatchId: 'alpha001', agentName: 'general', elapsedMs: 30_000, phase: 'tool', toolName: 'bash' });
const record = JSON.parse(jsonl.join('')) as Record<string, unknown>;
assert('stream JSON has one bounded payload-free progress event', record['type'] === 'subagent.progress' && record['toolName'] === 'bash' && !JSON.stringify(record).includes('task'));
const finalJson: string[] = [];
new StructuredHeadlessWriter('json', (text) => finalJson.push(text), 'session').subagentProgress({ dispatchId: 'alpha001', agentName: 'general', elapsedMs: 30_000, phase: 'model' });
assert('final-only JSON remains silent until its terminal object', finalJson.length === 0);

report();

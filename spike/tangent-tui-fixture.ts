/**
 * Free pty fixture for `verify-tui.ts tangent` (SER-083): a fresh session whose
 * model answers every prompt locally (`answer to: <prompt>`) so completed prompts
 * catalogue real rewind checkpoints without a provider call. Same shape as
 * `rewind-tui-fixture.ts` — the App gets the real `startNewSession`/`startRewind`
 * seams, so what the scenario drives is the production `/tangent` path.
 */
import React from 'react';
import { render } from 'ink';

import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import type { RewindCheckpoint } from '../src/agent/rewind.js';
import { PermissionQueue } from '../src/tui/permission-queue.js';
import { App } from '../src/tui/App.js';
import { Model, type BaseModelConfig, type Message, type ModelStreamEvent, type StreamOptions } from '@strands-agents/sdk';

class EchoModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.tangent-tui', contextWindowLimit: 200_000 };
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return { ...this.config }; }
  override async *stream(messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const prompt = messages.at(-1)?.content
      .map((block) => block.type === 'textBlock' ? block.text : '')
      .join('') ?? '';
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: `answer to: ${prompt}` } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

const projectRoot = process.cwd();
setRuntimeModelFactoryForTest(async () => new EchoModel());
const permissions = new PermissionQueue();
let current = await AgentRuntime.create({
  projectRoot,
  session: { kind: 'new' },
  permissionBridge: permissions.bridge,
});
permissions.setObserver((request) => current.observePermissionRequest({ source: request.source.label, toolName: request.toolName, toolInput: request.input }));

const instance = render(React.createElement(App, {
  runtime: current,
  permissions,
  startNewSession: async () => {
    current = await current.startNewSession();
    permissions.setObserver((request) => current.observePermissionRequest({ source: request.source.label, toolName: request.toolName, toolInput: request.input }));
    return current;
  },
  startRewind: async (checkpoint: RewindCheckpoint) => {
    current = await current.startRewind(checkpoint);
    permissions.setObserver((request) => current.observePermissionRequest({ source: request.source.label, toolName: request.toolName, toolInput: request.input }));
    return current;
  },
}), { exitOnCtrlC: false, patchConsole: false });

try {
  await instance.waitUntilExit();
} finally {
  permissions.close();
  await current.shutdown();
  setRuntimeModelFactoryForTest(undefined);
}

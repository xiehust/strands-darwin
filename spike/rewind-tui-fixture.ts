import React from 'react';
import { render } from 'ink';

import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { allowAllBridge } from '../src/agent/permission.js';
import type { RewindCheckpoint } from '../src/agent/rewind.js';
import { PermissionQueue } from '../src/tui/permission-queue.js';
import { App } from '../src/tui/App.js';
import { Model, type BaseModelConfig, type Message, type ModelStreamEvent, type StreamOptions } from '@strands-agents/sdk';

class NoCallModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.rewind-tui', contextWindowLimit: 200_000 };
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return { ...this.config }; }
  override async *stream(_messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    throw new Error('rewind pty fixture must make no model call');
  }
}

const projectRoot = process.cwd();
setRuntimeModelFactoryForTest(async () => new NoCallModel());
const permissions = new PermissionQueue();
let current = await AgentRuntime.create({
  projectRoot,
  session: { kind: 'continue' },
  permissionBridge: permissions.bridge,
});
permissions.setObserver((source) => current.observePermissionRequest(source));

const instance = render(React.createElement(App, {
  runtime: current,
  permissions,
  startNewSession: async () => {
    current = await current.startNewSession();
    permissions.setObserver((source) => current.observePermissionRequest(source));
    return current;
  },
  startRewind: async (checkpoint: RewindCheckpoint) => {
    current = await current.startRewind(checkpoint);
    permissions.setObserver((source) => current.observePermissionRequest(source));
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

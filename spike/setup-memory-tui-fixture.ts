/** Offline production App fixture: question-only model and an invalidated skill root. */
import React from 'react';
import { render } from 'ink';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { PermissionQueue } from '../src/tui/permission-queue.js';
import { App } from '../src/tui/App.js';
import { CaptureModel } from './offline-model.js';

const root = process.cwd();
const model = new CaptureModel('Setup pending: what username / actorId should I use? Please confirm proposed defaults before changes.');
setRuntimeModelFactoryForTest(async () => model);
const permissions = new PermissionQueue();
const runtime = await AgentRuntime.create({ projectRoot: root, session: { kind: 'new' }, permissionBridge: permissions.bridge });
await rm(path.join(root, '.darwin', 'skills', 'vanishing'), { recursive: true });
const instance = render(React.createElement(App, { runtime, permissions }), { exitOnCtrlC: false, patchConsole: false });
try {
  await instance.waitUntilExit();
} finally {
  permissions.close();
  await runtime.shutdown();
  await writeFile(path.join(root, 'captured-model.json'), JSON.stringify(model.calls));
  setRuntimeModelFactoryForTest(undefined);
}

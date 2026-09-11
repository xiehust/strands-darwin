/** Private relocated runtime/production App; filesystem barriers hold model/activation.
 * No provider transport. The delayed expansion delegates to the real skill guard.
 */
import React from 'react';
import { render } from 'ink';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Message, ModelStreamEvent, StreamOptions } from '@strands-agents/sdk';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { PermissionQueue } from '../src/tui/permission-queue.js';
import { App } from '../src/tui/App.js';
import { CaptureModel } from './offline-model.js';

const root = process.cwd();
const exists = (name: string) => access(path.join(root, name)).then(() => true, () => false);
async function wait(name: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!await exists(name)) {
    if (Date.now() >= deadline) throw new Error(`fixture timed out: ${name}`);
    await delay(20);
  }
}

class RecoveryModel extends CaptureModel {
  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const current = messages.at(-1)?.content ?? [];
    const text = current.map(block => block.type === 'textBlock' ? block.text : '').join('');
    const image = current.find(block => block.type === 'imageBlock');
    const imageHash = image?.source.type === 'imageSourceBytes'
      ? createHash('sha256').update(image.source.bytes).digest('hex') : undefined;
    await writeFile(path.join(root, 'model-request.json'), JSON.stringify({ text, imageHash, calls: this.calls.length + 1 }));
    if (text === 'hold original turn') await wait('release-model');
    yield* super.stream(messages, options);
  }
}
const model = new RecoveryModel('Offline answer; setup is pending user confirmation.');
setRuntimeModelFactoryForTest(async () => model);

const permissions = new PermissionQueue();
const runtime = await AgentRuntime.create({ projectRoot: root, session: { kind: 'new' }, permissionBridge: permissions.bridge });
await writeFile(path.join(root, 'runtime-ready.json'), JSON.stringify({ trajectoryFile: runtime.info.trajectoryFile }));
const expand = runtime.expandSlashCommand.bind(runtime);
let held = false;
runtime.expandSlashCommand = async (input) => {
  if (!held && /^\/setup-agentcore-memory(?:\s|$)/i.test(input)) {
    held = true;
    await writeFile(path.join(root, 'activation-ready'), input);
    await wait('release-activation');
  }
  return expand(input); // Actual plugin activation against the now-missing skill root.
};
const instance = render(React.createElement(App, { runtime, permissions }), { exitOnCtrlC: false, patchConsole: false });
try { await instance.waitUntilExit(); }
finally {
  permissions.close();
  await runtime.shutdown();
  setRuntimeModelFactoryForTest(undefined);
}


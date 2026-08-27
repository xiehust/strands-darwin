/** Offline AgentRuntime proof for one text-plus-image SDK user invocation. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ImageBlock,
  Model,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
} from '@strands-agents/sdk';

import { allowAllBridge } from '../src/agent/permission.js';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { trajectoryPath } from '../src/agent/session.js';
import { configPath } from '../src/config.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

ownPrivateHome('runtime-image-input');

class CaptureModel extends Model<BaseModelConfig> {
  readonly calls: Message[][] = [];
  private config: BaseModelConfig = { modelId: 'fake.runtime-image-input', contextWindowLimit: 32_000 };
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls.push(messages);
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'ok' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

header('runtime image input — one ordinary SDK user invocation');
const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-runtime-image-'));
const model = new CaptureModel();
setRuntimeModelFactoryForTest(async () => model);
let runtime: AgentRuntime | undefined;
try {
  await writeFile(configPath(), `${JSON.stringify({
    provider: 'bedrock', model: 'fake.runtime-image-input', region: 'us-west-2', contextOffload: false,
  })}\n`);
  runtime = await AgentRuntime.create({
    projectRoot: root,
    session: { kind: 'new' },
    permissionBridge: allowAllBridge,
  });
  const sessionId = runtime.info.sessionId;
  const source = Buffer.from([137, 80, 78, 71]);
  const image = new ImageBlock({ format: 'png', source: { bytes: source } });
  for await (const _event of runtime.send('expanded prompt', 'literal prompt', image)) void _event;

  assert('AgentRuntime makes one provider/model call', model.calls.length === 1);
  const user = model.calls[0]?.at(-1);
  assert('one ordinary SDK user message contains model text then image',
    user?.role === 'user' && user.content.length === 2 &&
    user.content[0]?.type === 'textBlock' && user.content[0].text === 'expanded prompt' &&
    user.content[1]?.type === 'imageBlock');
  const received = user?.content[1];
  assert('the SDK user message preserves exact image bytes',
    received?.type === 'imageBlock' && received.source.type === 'imageSourceBytes' &&
    Buffer.from(received.source.bytes).equals(source));

  await runtime.shutdown();
  runtime = undefined;
  const trajectory = await readFile(trajectoryPath(root, sessionId), 'utf8');
  assert('trajectory records only the literal prompt, never expanded text or image bytes',
    trajectory.includes('literal prompt') && !trajectory.includes('expanded prompt') &&
    !trajectory.includes(source.toString('base64')));
  assert('memory evidence input remains the literal user prompt', trajectory.includes('literal prompt'));
} finally {
  await runtime?.shutdown();
  setRuntimeModelFactoryForTest(undefined);
  await rm(root, { recursive: true, force: true });
}

report();

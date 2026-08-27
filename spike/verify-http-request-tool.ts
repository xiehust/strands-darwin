/** Offline proof that the parent runtime vends SDK HTTP requests through permissions. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  Agent,
  Model,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
} from '@strands-agents/sdk';
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request';

import type { AssessedPermissionRequest } from '../src/agent/permission.js';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { configPath } from '../src/config.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

ownPrivateHome('http-request-tool');

const INPUT = { method: 'GET', url: 'https://example.invalid/offline-proof' } as const;

class HttpRequestModel extends Model<BaseModelConfig> {
  calls = 0;
  private config: BaseModelConfig = { modelId: 'fake.http-request-tool', contextWindowLimit: 32_000 };

  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    const hasResult = messages.some((message) =>
      message.content.some((block) => block.type === 'toolResultBlock'),
    );
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (!hasResult) {
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: httpRequest.name, toolUseId: `http-${this.calls}` },
      };
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: JSON.stringify(INPUT) },
      };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'denial observed' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

function runtimeAgent(runtime: AgentRuntime): Agent {
  return (runtime as unknown as { agent: Agent }).agent;
}

async function createRuntime(
  root: string,
  model: HttpRequestModel,
  permissionBridge: (request: AssessedPermissionRequest) => Promise<{ allowed: boolean }>,
  permissionModeOverride?: 'plan',
): Promise<AgentRuntime> {
  setRuntimeModelFactoryForTest(async () => model);
  return AgentRuntime.create({
    projectRoot: root,
    session: { kind: 'new' },
    permissionBridge,
    ...(permissionModeOverride === undefined ? {} : { permissionModeOverride }),
  });
}

header('SDK HTTP request tool — parent registration and permission gate');
const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-http-request-'));
const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (() => {
  fetchCalls += 1;
  throw new Error('offline test must never invoke fetch');
}) as typeof fetch;
let defaultRuntime: AgentRuntime | undefined;
let planRuntime: AgentRuntime | undefined;
try {
  await writeFile(configPath(), `${JSON.stringify({
    provider: 'bedrock', model: 'fake.http-request-tool', region: 'us-west-2', contextOffload: false,
  })}\n`);

  const asked: AssessedPermissionRequest[] = [];
  const defaultModel = new HttpRequestModel();
  defaultRuntime = await createRuntime(root, defaultModel, async (request) => {
    asked.push(request);
    return { allowed: false };
  });
  const registered = runtimeAgent(defaultRuntime).tools.filter((tool) => tool.name === httpRequest.name);
  assert('installed SDK export reports the actual http_request tool name', httpRequest.name === 'http_request');
  assert('fresh parent runtime registers exactly the SDK HTTP request singleton',
    registered.length === 1 && registered[0] === httpRequest);

  for await (const _event of defaultRuntime.send('ask for an HTTP request')) void _event;
  assert('ordinary permission bridge receives one HTTP request call', asked.length === 1);
  assert('HTTP request remains fail-closed as execute',
    asked[0]?.toolName === httpRequest.name && asked[0].kind === 'execute' && asked[0].source.kind === 'parent');
  assert('denial returns through the ordinary SDK loop without invoking fetch',
    defaultModel.calls === 2 && fetchCalls === 0);

  const planAsked: AssessedPermissionRequest[] = [];
  const planModel = new HttpRequestModel();
  planRuntime = await createRuntime(`${root}-plan`, planModel, async (request) => {
    planAsked.push(request);
    return { allowed: true };
  }, 'plan');
  for await (const _event of planRuntime.send('try an HTTP request in plan mode')) void _event;
  assert('plan mode denies HTTP execution before prompting', planAsked.length === 0);
  assert('plan denial returns through the ordinary SDK loop without invoking fetch',
    planModel.calls === 2 && fetchCalls === 0);
} finally {
  await planRuntime?.shutdown();
  await defaultRuntime?.shutdown();
  setRuntimeModelFactoryForTest(undefined);
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
  await rm(`${root}-plan`, { recursive: true, force: true });
}

report();

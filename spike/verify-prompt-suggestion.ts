/** SER-129 offline acceptance: real SDK streams, runtime, local HTTP; no remote models.
 * S1 default/off + one bounded current-model call; S2 Unicode/control/command validation;
 * S3 cancellation/deadline/failure/no retry/suppression; S4 ownership/stale generations;
 * S5 separate exact usage, unchanged Agent/context/trajectory; S6 headless/child isolation.
 * Interactive gestures and frame visibility live in verify-prompt-suggestion-pty.ts.
 */
import { strict as check } from 'node:assert';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Model, type BaseModelConfig, type Message, type ModelStreamEvent, type StreamOptions } from '@strands-agents/sdk';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import { createHook } from 'node:async_hooks';
import { loadConfig, createModelFromConfig, type AppConfig } from '../src/config.js';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { runHeadlessTurn } from '../src/headless.js';
import { buildRecipeChild } from '../src/agents/child-recipe.js';
import { PermissionGate } from '../src/agent/permission.js';
import { parseSuggestion, runPromptSuggestion, suggestionRequest, suggestionUsageNotice, SUGGESTION_MAX_TOKENS } from '../src/agent/prompt-suggestion.js';
import { PromptSuggestionState, suggestionRow, suggestionUnowned, type SuggestionOwners } from '../src/tui/prompt-suggestion.js';
import { ownPrivateHome } from './shared.js';

const home = ownPrivateHome('prompt-suggestion');
const root = path.join(home, 'project');
await mkdir(root);
await mkdir(path.join(home, '.darwin'));
const configPath = path.join(home, '.darwin/config.json');

class LocalModel extends Model<BaseModelConfig> {
  calls = 0;
  captured: { messages: Message[]; options?: StreamOptions } | undefined;
  constructor(readonly text = 'Explain the Unicode fix', readonly mode = 'reply') { super(); }
  override updateConfig(): void {}
  override getConfig(): BaseModelConfig { return { modelId: 'local' }; }
  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    this.calls++;
    this.captured = { messages, ...(options ? { options } : {}) };
    if (this.mode === 'hang') await new Promise(() => {});
    if (this.mode === 'error') throw new Error('unsupported provider request 400');
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: this.text } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    if (this.mode !== 'unknown') yield { type: 'modelMetadataEvent', usage: { inputTokens: 17, outputTokens: 5, totalTokens: 22, cacheReadInputTokens: 0 } };
  }
}
await writeFile(configPath, JSON.stringify({ models: [{ name: 'first', enable: true, provider: 'openai', model: 'fixture.model' }, { name: 'second', provider: 'openai', model: 'fixture.second' }], memory: false, updateCheck: false }));
const config = await loadConfig(root);
check.equal(config.promptSuggestions, true);
await writeFile(configPath, JSON.stringify({ promptSuggestions: false }));
check.equal((await loadConfig(root)).promptSuggestions, false);
await writeFile(configPath, JSON.stringify({ promptSuggestions: 'false' }));
await check.rejects(loadConfig(root), /promptSuggestions/u);
await writeFile(configPath, JSON.stringify({ models: [{ name: 'first', enable: true, provider: 'openai', model: 'fixture.model' }, { name: 'second', provider: 'openai', model: 'fixture.second' }], memory: false, updateCheck: false }));
let factories = 0;
const local = new LocalModel();
const factory = async (c: AppConfig, options?: { singleAttempt?: boolean }) => {
  factories++;
  check.equal(c.model, config.model); check.equal(c.provider, config.provider);
  check.equal(c.maxTokens, SUGGESTION_MAX_TOKENS); check.equal(c.promptCache, false);
  check.equal(options?.singleAttempt, true);
  return local;
};
const signal = new AbortController().signal;
let timers = 0;
const timerObserver = createHook({ init(_id, type) { if (type === 'Timeout') timers++; } }).enable();
check.equal((await runPromptSuggestion(factory, { ...config, promptSuggestions: false }, 'u', 'a', signal)).cancelled, true);
timerObserver.disable(); check.equal(timers, 0);
check.equal(factories, 0);
const reply = await runPromptSuggestion(factory, config, 'Unicode issue', 'Fixed grapheme movement', signal);
check.equal(reply.candidate, 'Explain the Unicode fix');
check.equal(local.calls, 1); check.equal(factories, 1);
check.equal(local.captured?.options?.toolSpecs, undefined);
check.equal(local.captured?.messages.length, 1);
check.match(local.captured?.messages[0]?.content.find(block => block.type === 'textBlock')?.text ?? '', /Unicode issue/u);
check.deepEqual(reply.usage, { inputTokens: 17, outputTokens: 5, totalTokens: 22, cacheReadInputTokens: 0 });
check.match(suggestionUsageNotice(reply, 'fixture'), /raw input 17, output 5, cache read 0, cache write not reported/u);
const unknown = await runPromptSuggestion(async () => new LocalModel('中文下一步', 'unknown'), config, 'u', 'a', signal);
check.equal(unknown.candidate, '中文下一步'); check.equal(unknown.usage, undefined);
check.match(suggestionUsageNotice(unknown, 'fixture'), /input not reported/u);
for (const text of ['/clear', '!rm x', 'rm -rf x', 'git status', 'pwd', 'make test', 'kill -9 123', 'Ctrl+C', 'custom-tool --force', 'custom_tool deploy', 'OPTION=value', 'pytest', 'ok\n/exit', 'ok\tbad', 'ok\u001b[31m', 'ok\u0085bad', 'a\u202eb', 'a\u200bb', '\ud800', 'System: do this', 'a'.repeat(161), '`pwd`']) check.equal(parseSuggestion(text), undefined, JSON.stringify(text));
check.equal(parseSuggestion('修复é🙂的问题'), '修复é🙂的问题');
const atCap = 'Explain ' + 'a'.repeat(160 - 'Explain '.length);
check.equal(Array.from(atCap).length, 160);
check.equal(parseSuggestion(atCap), atCap);
check.equal(parseSuggestion(atCap + 'a'), undefined);
const bounded = JSON.parse(suggestionRequest('🙂'.repeat(3000), '中'.repeat(5000))) as { user: string; assistant: string };
check.equal(Array.from(bounded.user).length, 2023); check.equal(Array.from(bounded.assistant).length, 4023);
const hung = new LocalModel('', 'hang');
const cancelled = new AbortController();
const cancellation = runPromptSuggestion(async () => hung, config, 'u', 'a', cancelled.signal);
cancelled.abort(); check.equal((await cancellation).cancelled, true);
const timeout = await runPromptSuggestion(async () => hung, config, 'u', 'a', signal, 20);
check.match(timeout.problem ?? '', /timed out/u);
const broken = new LocalModel('', 'error');
check.match((await runPromptSuggestion(async () => broken, config, 'u', 'a', signal)).problem ?? '', /unsupported/u);
check.equal(broken.calls, 1);
const large = await runPromptSuggestion(async () => new LocalModel('x'.repeat(20_000)), config, 'u', 'a', signal);
check.equal(large.candidate, undefined); check.match(large.problem ?? '', /bound/u);
console.log('PASS S1/S2/S3: config, tool-free bounded SDK request, Unicode validation, usage, cancellation/timeout/error/no retry');

const owners: SuggestionOwners = { idle: true, draft: '', permission: false, search: false, completion: false, image: false, editor: false, queue: false, peer: false, goal: false, task: false, replacing: false };
check.equal(suggestionUnowned(owners), true);
for (const key of Object.keys(owners) as (keyof SuggestionOwners)[]) {
  check.equal(suggestionUnowned({ ...owners, [key]: key === 'idle' ? false : key === 'draft' ? 'x' : true }), false, key);
}
check.equal(suggestionRow('中文下一步', 80, 1), 'suggest: 中文下一步 (Right to edit)');
check.equal(suggestionRow('中文下一步', 24, 1), undefined);
check.equal(suggestionRow('next', 100, 0), undefined);
const state = new PromptSuggestionState();
let attempts = 0;
let suspension = '';
for (let i = 0; i < 5; i++) {
  state.invalidate();
  await state.offer(state.revision, 'model1', async () => { attempts++; return { problem: 'unsupported' }; }, (_result, notice) => { if (notice) suspension = notice; });
}
check.equal(attempts, 3); check.match(suspension, /suspended.*unsupported/u);
state.invalidate();
await state.offer(state.revision, 'model2', async () => { attempts++; return { candidate: 'fresh' }; }, () => {});
check.equal(attempts, 4); check.equal(state.candidate, 'fresh');
await state.offer(state.revision, 'model2', async () => { attempts++; return {}; }, () => {});
check.equal(attempts, 4);
let release!: (result: { candidate: string }) => void;
state.invalidate();
const stale = state.offer(state.revision, 'model2', () => new Promise(resolve => { release = resolve; }), () => {});
state.invalidate(); release({ candidate: 'stale' }); await stale; check.equal(state.candidate, undefined);
console.log('PASS S4: all ownership flags, full-row visibility, one attempt, suppression/reset, stale settlement');

const created: AppConfig[] = [];
const main = new LocalModel('main answer');
setRuntimeModelFactoryForTest(async c => { created.push(c); return c.maxTokens === SUGGESTION_MAX_TOKENS ? new LocalModel() : main; });
const runtime = await AgentRuntime.create({ projectRoot: root, session: { kind: 'new' }, permissionModeOverride: 'yolo', permissionBridge: async () => ({ allowed: false }) });
try {
  await runHeadlessTurn(runtime, 'human request', () => {});
  check.equal(main.calls, 1); check.equal(created.filter(c => c.maxTokens === SUGGESTION_MAX_TOKENS).length, 0);
  const meter = runtime.usage;
  const context = await runtime.contextEstimate();
  const records = await readFile(runtime.info.trajectoryFile!, 'utf8');
  const auxiliary = await runtime.suggestPrompt('human request', 'main answer', signal);
  check.equal(auxiliary.candidate, 'Explain the Unicode fix');
  check.deepEqual(runtime.usage, meter); check.deepEqual(await runtime.contextEstimate(), context);
  check.equal(await readFile(runtime.info.trajectoryFile!, 'utf8'), records);
  check.equal(main.calls, 1);
  const childModel = new LocalModel('child answer');
  const gate = new PermissionGate({ mode: 'yolo', projectRoot: root, ask: async () => ({ allowed: false }) });
  const child = buildRecipeChild({ definition: { name: 'probe', description: 'probe', systemPrompt: 'probe', tools: [], projectInstructions: false, file: undefined }, config, model: childModel, tools: [], intervention: gate, projectInstructions: undefined, idPrefix: 'suggestion-test', dispatch: undefined });
  await child.invoke('child request'); check.equal(childModel.calls, 1);
  check.equal(created.filter(c => c.maxTokens === SUGGESTION_MAX_TOKENS).length, 1);
  setRuntimeModelFactoryForTest(async () => new LocalModel('', 'hang'));
  const pending = runtime.suggestPrompt('u', 'a', signal);
  await runHeadlessTurn(runtime, 'new work', () => {}); check.equal((await pending).cancelled, true);
  const switching = runtime.suggestPrompt('u', 'a', signal);
  await (await runtime.changeModel(runtime.modelChoices[1]!)).saved; check.equal((await switching).cancelled, true);
  const replacing = runtime.suggestPrompt('u', 'a', signal);
  const successor = await runtime.startNewSession(); check.equal((await replacing).cancelled, true);
  const closing = successor.suggestPrompt('u', 'a', signal);
  await successor.shutdown(); check.equal((await closing).cancelled, true);
} finally { await runtime.shutdown(); setRuntimeModelFactoryForTest(undefined); }
console.log('PASS S5/S6: separate exact usage/context/trajectory, headless/recipe-child isolation, new-work/model/replacement/shutdown cancellation');

// Real OpenAI client over loopback SSE: byte-level tool-free request and usage.
const bodies: Record<string, unknown>[] = [];
const server = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += String(chunk);
  bodies.push(JSON.parse(body));
  const envelope = { id: 'suggestion', object: 'chat.completion.chunk', created: 1, model: 'fixture.model' };
  const chunks = [
    { ...envelope, choices: [{ index: 0, delta: { role: 'assistant', content: 'Explain local HTTP further' }, finish_reason: null }] },
    { ...envelope, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20 } },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); check.ok(address && typeof address !== 'string');
try {
  const wire = await runPromptSuggestion(async c => new OpenAIModel({ api: 'chat', modelId: c.model, maxTokens: c.maxTokens, apiKey: 'fixture', clientConfig: { baseURL: `http://127.0.0.1:${address.port}/v1`, maxRetries: 0 } }), config, 'local HTTP', 'observed answer', signal);
  check.equal(wire.candidate, 'Explain local HTTP further');
  check.equal(wire.usage?.inputTokens, 13); check.equal(wire.usage?.outputTokens, 7);
  check.equal(bodies.length, 1); check.equal(bodies[0]?.['tools'], undefined);
  check.equal(bodies[0]?.['model'], config.model); check.equal(bodies[0]?.['max_completion_tokens'], 256);
} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
console.log('PASS S1/S5 wire: real local HTTP SDK provider, one request, no tools, cap and usage');

// Production factory transport policy: native HTTP clients, retryable rejection
// and an open silent connection. No fake timers/client replacements.
let transportRequests = 0;
let closed = 0;
let reject = true;
const transport = createServer((request, response) => {
  request.resume(); transportRequests++;
  response.on('close', () => closed++);
  if (reject) { response.writeHead(500, { 'content-type': 'application/json' }); response.end('{"error":{"message":"unsupported optional request","type":"api_error"}}'); }
  else { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); }
});
transport.listen(0, '127.0.0.1'); await once(transport, 'listening');
const transportAddress = transport.address(); check.ok(transportAddress && typeof transportAddress !== 'string');
const baseURL = `http://127.0.0.1:${transportAddress.port}`;
const original = { openai: process.env['OPENAI_BASE_URL'], key: process.env['SUGGESTION_TEST_KEY'] };
process.env['OPENAI_BASE_URL'] = baseURL; process.env['SUGGESTION_TEST_KEY'] = 'local-fixture';
try {
  for (const provider of ['openai', 'anthropic'] as const) {
    const native = { ...config, provider, apiKeyEnv: 'SUGGESTION_TEST_KEY', ...(provider === 'anthropic' ? { baseUrl: baseURL } : {}) };
    reject = true;
    const before = transportRequests;
    const failure = await runPromptSuggestion(createModelFromConfig, native, 'u', 'a', signal, 1500);
    check.ok(failure.problem); check.equal(transportRequests - before, 1, `${provider} no transport retry on 500`);
    reject = false;
    const timeoutResult = await runPromptSuggestion(createModelFromConfig, native, 'u', 'a', signal, 100);
    check.match(timeoutResult.problem ?? '', /timed out/u);
    const deadline = Date.now() + 1000;
    while (closed < transportRequests && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    check.equal(closed, transportRequests, `${provider} transport closes on timeout`);
  }
} finally {
  if (original.openai === undefined) delete process.env['OPENAI_BASE_URL']; else process.env['OPENAI_BASE_URL'] = original.openai;
  if (original.key === undefined) delete process.env['SUGGESTION_TEST_KEY']; else process.env['SUGGESTION_TEST_KEY'] = original.key;
  transport.closeAllConnections(); await new Promise<void>(resolve => transport.close(() => resolve()));
}
console.log('PASS S3 production transports: OpenAI/Anthropic 500 without retries; timeout aborts sockets');

/** SER-130 offline proofs: controlled clock, real SDK, production HTTP transports,
 * bounded evidence/Unicode, owners, lifecycle, independent config, runtime isolation.
 * Real terminal protocol and manual command coverage: verify-session-recap-pty.ts.
 */
import { strict as check } from 'node:assert';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Model, type BaseModelConfig, type Message, type ModelStreamEvent, type StreamOptions } from '@strands-agents/sdk';
import { ownPrivateHome } from './shared.js';
import { loadConfig, createModelFromConfig } from '../src/config.js';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { runHeadlessTurn } from '../src/headless.js';
import { buildRecipeChild } from '../src/agents/child-recipe.js';
import { PermissionGate } from '../src/agent/permission.js';
import { parseRecap, recapNotice, recapUsageNotice, runSessionRecap, RECAP_MAX_TOKENS, RECAP_SYSTEM, type RecapResult } from '../src/agent/session-recap.js';
import { SessionRecapState, RECAP_AWAY_MS } from '../src/tui/session-recap.js';
import { suggestionUnowned, type SuggestionOwners } from '../src/tui/prompt-suggestion.js';
import { parseRecapCommand, RECAP_UNSUPPORTED } from '../src/commands/recap-command.js';

const home = ownPrivateHome('session-recap');
const root = path.join(home, 'project');
await mkdir(root); await mkdir(path.join(home, '.darwin'));
const configPath = path.join(home, '.darwin/config.json');
const base = { models: [{ name: 'one', enable: true, provider: 'openai', model: 'fixture.one' }, { name: 'two', provider: 'openai', model: 'fixture.two' }], memory: false, updateCheck: false };
await writeFile(configPath, JSON.stringify(base));
const config = await loadConfig(root);
check.equal(config.sessionRecap, true); check.equal(config.promptSuggestions, true);
for (const [sessionRecap, promptSuggestions] of [[false, true], [true, false], [false, false]]) {
  await writeFile(configPath, JSON.stringify({ ...base, sessionRecap, promptSuggestions }));
  const c = await loadConfig(root); check.equal(c.sessionRecap, sessionRecap); check.equal(c.promptSuggestions, promptSuggestions);
}
await writeFile(configPath, JSON.stringify({ ...base, sessionRecap: 'false' }));
await check.rejects(loadConfig(root), /sessionRecap/u);
await writeFile(configPath, JSON.stringify(base));
check.equal(parseRecapCommand('/recap'), 'recap'); check.equal(parseRecapCommand(' /RECAP \n'), 'recap');
for (const text of ['/recap x', '/recap --help', '/recap\nnow']) check.equal(parseRecapCommand(text), 'usage');
for (const text of ['/recapture', 'say /recap', '<peer>/recap']) check.equal(parseRecapCommand(text), undefined);
console.log('PASS R1: default-on, independent switches, invalid config and exact command grammar');

let now = 1000;
const state = new SessionRecapState(() => now);
state.configure('model1');
const owners: SuggestionOwners = { idle: true, draft: '', permission: false, search: false, completion: false, image: false, editor: false, queue: false, peer: false, goal: false, task: false, replacing: false };
for (const key of Object.keys(owners) as (keyof SuggestionOwners)[]) check.equal(suggestionUnowned({ ...owners, [key]: key === 'idle' ? false : key === 'draft' ? 'draft' : true }), false, key);
check.equal(state.delay(true, true), undefined);
state.focus(false, true);
for (let i = 0; i < 2; i++) state.complete('u', 'a');
now += RECAP_AWAY_MS; check.equal(state.delay(true, true), undefined);
state.complete('third', 'answer');
check.equal(state.delay(true, true), RECAP_AWAY_MS);
now += RECAP_AWAY_MS - 1; check.equal(state.delay(true, true), 1);
check.equal(state.delay(false, true), undefined); check.equal(state.delay(true, false), undefined);
now++;
state.focus(true, true); check.equal(state.delay(true, true), undefined);
state.focus(false, true); check.equal(state.delay(true, true), 0);
for (const key of Object.keys(owners) as (keyof SuggestionOwners)[]) {
  const free = suggestionUnowned({ ...owners, [key]: key === 'idle' ? false : key === 'draft' ? 'draft' : true });
  for (const manual of [false, true]) await state.generate(manual, true, free, async () => { throw new Error(`owner ${key} must block generation`); }, () => check.fail(`owner ${key} generated`));
  check.equal(state.pending, false);
}
let attempts = 0, published = 0;
const generate = async () => { attempts++; return { text: 'prepared' }; };
await state.generate(false, true, true, generate, (_r, _e, publish) => { if (publish) published++; });
check.equal(attempts, 1); check.equal(published, 0);
check.equal(state.delay(true, true), undefined);
check.equal(state.focus(true, true)?.result.text, 'prepared');
for (let i = 0; i < 4; i++) { state.focus(false, true); check.equal(state.delay(true, true), undefined); check.equal(state.focus(true, true), undefined); }
state.complete('new', 'state'); state.focus(false, true); now += RECAP_AWAY_MS;
let release!: (result: RecapResult) => void;
const stale = state.generate(false, true, true, () => new Promise(resolve => { release = resolve; }), result => check.equal(result.cancelled, true));
state.focus(true, true); release({ text: 'late', usage: { inputTokens: 9 } }); await stale;
state.focus(false, true); check.equal(state.delay(true, true), undefined); // Cancel is not permission to retry.
let suspension = '';
for (let i = 0; i < 5; i++) {
  state.complete('u', 'a'); now += RECAP_AWAY_MS;
  await state.generate(false, true, true, async () => { attempts++; return { problem: 'unsupported' }; }, (_r, _e, _p, notice) => { if (notice) suspension = notice; });
}
check.equal(attempts, 4); check.match(suspension, /paused.*unsupported/u);
state.resetSession(); for (let i = 0; i < 3; i++) state.complete('u', 'a'); now += RECAP_AWAY_MS; state.focus(false, true);
check.equal(state.delay(true, true), undefined); // Clear cannot restart repeated failures.
state.configure('model2'); check.equal(state.delay(true, true), 0);
state.workStarted(); check.equal(state.delay(true, true), undefined); // Wakes/peers/failures cannot arm automatic inference.
state.complete('human', 'new answer'); now += RECAP_AWAY_MS;
check.equal(state.delay(true, true), 0);
await state.generate(false, true, true, generate, () => {});
check.equal(state.focus(true, false), undefined); // Owner blocks return; no delayed publication.
const manual = new SessionRecapState(() => now);
manual.complete('one', 'answer');
await manual.generate(true, false, true, generate, (_r, _e, p) => check.equal(p, true));
for (let i = 0; i < 8; i++) manual.complete('🙂'.repeat(900), '中'.repeat(1700));
check.equal(manual.evidence.exchanges.length, 6); check.equal(manual.evidence.truncated, true);
check.equal(Array.from(manual.evidence.exchanges[0]!.user).length, 800);
check.equal(Array.from(manual.evidence.exchanges[0]!.assistant).length, 1600);
console.log('PASS R2/R3: actual blur, 3 turns/180000ms boundary, prepare/return/dedup, owners, cancellation and same-cause pause/reset');

class LocalModel extends Model<BaseModelConfig> {
  calls = 0;
  captured: { messages: Message[]; options?: StreamOptions } | undefined;
  constructor(private text = 'Recapped visible progress', private mode = 'ok') { super(); }
  override updateConfig(): void {}
  override getConfig(): BaseModelConfig { return { modelId: 'fixture.one', contextWindowLimit: 200_000 }; }
  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    this.calls++; this.captured = { messages, ...(options ? { options } : {}) };
    if (this.mode === 'error') throw new Error('unsupported recap request 400');
    // Usage can be known even when later transport work is cancelled.
    if (this.mode !== 'unknown') yield { type: 'modelMetadataEvent', usage: { inputTokens: 17, outputTokens: 5, totalTokens: 22, cacheReadInputTokens: 0 } };
    if (this.mode === 'hang') await new Promise(() => {});
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: this.text } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: this.mode === 'incomplete' ? 'maxTokens' : 'endTurn' };
  }
}
const signal = new AbortController().signal;
const local = new LocalModel();
const evidence = manual.evidence;
const result = await runSessionRecap(async (c, transport) => {
  check.equal(c.model, config.model); check.equal(c.provider, config.provider); check.equal(c.maxTokens, RECAP_MAX_TOKENS); check.equal(c.promptCache, false); check.equal(transport?.singleAttempt, true); return local;
}, config, evidence, signal);
check.equal(result.text, 'Recapped visible progress');
check.equal(local.captured?.options?.systemPrompt, RECAP_SYSTEM); check.equal(local.captured?.options?.toolSpecs, undefined);
check.equal(local.captured?.messages.length, 1);
const request = JSON.parse(local.captured!.messages[0]!.content.find(b => b.type === 'textBlock')!.text);
check.equal(request.truncated, true); check.equal(request.exchanges.length, 6);
check.match(recapNotice(result, evidence), /Input truncated/u);
check.match(recapUsageNotice(result, 'fixture', true), /manual.*fixture[\s\S]*input 17, output 5, cache read 0, cache write not reported/u);
check.match(recapUsageNotice({}, 'fixture', false), /input not reported/u);
check.equal(Array.from(parseRecap('🙂'.repeat(400)).text!).length, 400);
const capped = parseRecap('🙂'.repeat(401)); check.equal(Array.from(capped.text!).length, 400); check.equal(capped.truncated, true);
check.match(recapNotice(capped, evidence), /Output truncated at 400 Unicode code points/u);
for (const bad of ['\u001b[31mbad', 'a\u202eb', '\ud800', '']) check.ok(parseRecap(bad).problem);
for (const mode of ['error', 'incomplete', 'unknown']) {
  const model = new LocalModel('recap', mode);
  const reply = await runSessionRecap(async () => model, config, evidence, signal);
  check.equal(model.calls, 1);
  if (mode === 'unknown') check.equal(reply.usage, undefined); else check.ok(reply.problem);
}
const hung = new LocalModel('', 'hang');
const deadline = await runSessionRecap(async () => hung, config, evidence, signal, 20);
check.match(deadline.problem ?? '', /timed out/u); check.equal(deadline.usage?.inputTokens, 17);
const controller = new AbortController();
const pending = runSessionRecap(async () => hung, config, evidence, controller.signal);
controller.abort(); check.equal((await pending).cancelled, true);
const large = await runSessionRecap(async () => new LocalModel('x'.repeat(20_000)), config, evidence, signal);
check.match(large.problem ?? '', /bound/u);
let emptyCalls = 0;
await runSessionRecap(async () => { emptyCalls++; return local; }, config, { exchanges: [], truncated: false }, signal);
check.equal(emptyCalls, 0);
console.log('PASS R4: bounded tool-free current-model SDK request, Unicode and omission honesty, raw usage, empty/error/timeout/cancel/no retry');

const main = new LocalModel('main answer');
let sideCalls = 0;
setRuntimeModelFactoryForTest(async c => { if (c.maxTokens === RECAP_MAX_TOKENS) { sideCalls++; return new LocalModel(); } return main; });
const runtime = await AgentRuntime.create({ projectRoot: root, session: { kind: 'new' }, permissionModeOverride: 'yolo', permissionBridge: async () => ({ allowed: false }) });
async function disk(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, await disk(file)); else result[file] = (await readFile(file)).toString('base64');
  }
  return result;
}
try {
  await check.rejects(runHeadlessTurn(runtime, '/recap', () => {}), new RegExp(RECAP_UNSUPPORTED));
  await check.rejects(runtime.expandSlashCommand('/recap'), /explicit local human/u);
  check.equal(main.calls, 0); check.equal(sideCalls, 0);
  await runHeadlessTurn(runtime, 'human request', () => {});
  const usage = runtime.usage, context = await runtime.contextEstimate(), messages = JSON.stringify(main.captured?.messages);
  const cacheAt = Date.now();
  const cache = JSON.stringify([runtime.cacheMissReport(), runtime.cacheWarmth(cacheAt), runtime.callStats]);
  const before = await disk(path.join(home, '.darwin/sessions'));
  const auxiliary = await runtime.sessionRecap(evidence, signal);
  check.ok(auxiliary.text); check.equal(sideCalls, 1); check.equal(main.calls, 1);
  check.deepEqual(runtime.usage, usage); check.deepEqual(await runtime.contextEstimate(), context);
  check.equal(JSON.stringify(main.captured?.messages), messages);
  check.equal(JSON.stringify([runtime.cacheMissReport(), runtime.cacheWarmth(cacheAt), runtime.callStats]), cache);
  check.deepEqual(await disk(path.join(home, '.darwin/sessions')), before);
  const childModel = new LocalModel('child answer');
  const gate = new PermissionGate({ mode: 'yolo', projectRoot: root, ask: async () => ({ allowed: false }) });
  const child = buildRecipeChild({ definition: { name: 'probe', description: 'probe', systemPrompt: 'probe', tools: [], projectInstructions: false, file: undefined }, config, model: childModel, tools: [], intervention: gate, projectInstructions: undefined, idPrefix: 'recap-test', dispatch: undefined });
  await child.invoke('/recap'); check.equal(childModel.calls, 1); check.equal(sideCalls, 1);
  setRuntimeModelFactoryForTest(async c => c.maxTokens === RECAP_MAX_TOKENS ? new LocalModel('', 'hang') : main);
  const newWork = runtime.sessionRecap(evidence, signal);
  await runHeadlessTurn(runtime, 'new work', () => {}); check.equal((await newWork).cancelled, true);
  const switching = runtime.sessionRecap(evidence, signal);
  await (await runtime.changeModel(runtime.modelChoices[1]!)).saved; check.equal((await switching).cancelled, true);
  const replacing = runtime.sessionRecap(evidence, signal);
  const successor = await runtime.startNewSession(); check.equal((await replacing).cancelled, true);
  const closing = successor.sessionRecap(evidence, signal);
  await successor.shutdown(); check.equal((await closing).cancelled, true);
} finally { await runtime.shutdown(); setRuntimeModelFactoryForTest(undefined); }
console.log('PASS R5: headless refusal, child no recap channel, Agent/messages/usage/context and ALL session bytes unchanged; work/model/clear/shutdown cancel');

let transportRequests = 0, closed = 0;
let mode: 'success' | 'reject' | 'hang' = 'success';
const bodies: Record<string, unknown>[] = [];
const transport = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += String(chunk);
  transportRequests++; bodies.push(JSON.parse(body)); response.on('close', () => closed++);
  if (mode === 'reject') { response.writeHead(500, { 'content-type': 'application/json' }); response.end('{"error":{"message":"unsupported optional request","type":"api_error"}}'); return; }
  response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders();
  if (mode === 'hang') return;
  const envelope = { id: 'recap', object: 'chat.completion.chunk', created: 1, model: 'fixture.one' };
  response.end([
    { ...envelope, choices: [{ index: 0, delta: { role: 'assistant', content: 'HTTP recap' }, finish_reason: null }] },
    { ...envelope, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20 } },
  ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
});
transport.listen(0, '127.0.0.1'); await once(transport, 'listening');
const address = transport.address(); check.ok(address && typeof address !== 'string');
const baseURL = `http://127.0.0.1:${address.port}`;
const original = process.env['OPENAI_BASE_URL'];
process.env['OPENAI_BASE_URL'] = baseURL; process.env['RECAP_TEST_KEY'] = 'local-fixture';
try {
  const native = { ...config, provider: 'openai' as const, openaiApi: 'chat' as const, apiKeyEnv: 'RECAP_TEST_KEY' };
  const wire = await runSessionRecap(createModelFromConfig, native, evidence, signal);
  check.equal(wire.text, 'HTTP recap'); check.equal(wire.usage?.inputTokens, 13); check.equal(wire.usage?.outputTokens, 7);
  check.equal(bodies[0]?.['tools'], undefined); check.equal(bodies[0]?.['model'], config.model); check.equal(bodies[0]?.['max_completion_tokens'], 512);
  for (const provider of ['openai', 'anthropic'] as const) {
    const c = { ...native, provider, ...(provider === 'anthropic' ? { baseUrl: baseURL } : {}) };
    mode = 'reject'; const before = transportRequests;
    check.ok((await runSessionRecap(createModelFromConfig, c, evidence, signal, 1500)).problem);
    check.equal(transportRequests - before, 1, `${provider} no retry on HTTP 500`);
    mode = 'hang';
    check.match((await runSessionRecap(createModelFromConfig, c, evidence, signal, 150)).problem ?? '', /timed out/u);
    const deadline = Date.now() + 1000;
    while (closed < transportRequests && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    check.equal(closed, transportRequests, `${provider} socket closed on timeout`);
  }
} finally {
  if (original === undefined) delete process.env['OPENAI_BASE_URL']; else process.env['OPENAI_BASE_URL'] = original;
  delete process.env['RECAP_TEST_KEY']; transport.closeAllConnections(); await new Promise<void>(resolve => transport.close(() => resolve()));
}
console.log('PASS R6: production OpenAI/Anthropic HTTP transports, separate exact counters, no retries, timeout closes sockets');

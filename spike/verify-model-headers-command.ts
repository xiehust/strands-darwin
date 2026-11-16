/** OpenAI gateway auth: real helper processes and loopback HTTP/SSE, no external network or model calls.
 * Run: pnpm tsx spike/verify-model-headers-command.ts
 */
import check from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { ContextWindowOverflowError, Message, TextBlock } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import { ConfigError, configPath, loadConfig, createModelFromConfig, withModelChoice } from '../src/config.js';
import { createHeadersCommandClient, protectHeadersCommandModel, headersCommandStreamActive, parseHeadersCommand, MAX_HEADERS_BYTES } from '../src/model-headers-command.js';
import { ownPrivateHome } from './shared.js';
import { failureFromError } from '../src/trajectory/record.js';
import { routeSdkLogs, setSdkVerboseSink } from '../src/agent/sdk-logging.js';

ownPrivateHome('headers-command');
const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-model-headers-'));

const requests: { url: string; auth: string | undefined; key: string | undefined; body: Record<string, unknown> }[] = [];
let reply: 'sse' | 'redirect' | 'unauthorized' | 'echo-error' | 'sse-failed' | 'sse-error' | 'sse-throttled' | 'chat-error-details' = 'sse';
let redirectTarget = '';
let replyText = 'gateway ok';
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push({ url: request.url!, auth: request.headers.authorization, key: request.headers['x-api-key'] as string | undefined,
    body: JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown> });
  if (reply === 'redirect') { response.writeHead(307, { location: redirectTarget }); response.end(); return; }
  if (reply === 'unauthorized') { response.writeHead(401); response.end('{"error":{"message":"sign in required"}}'); return; }
  if (reply === 'echo-error') {
    response.writeHead(400, { 'x-request-id': request.headers['x-api-key'] as string });
    response.end(JSON.stringify({ error: { code: 'context_length_exceeded', message: `${request.headers.authorization} ${request.headers['x-api-key']}` } })); return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  if (reply === 'chat-error-details') {
    response.end(`data: ${JSON.stringify({ error: { [request.headers['x-api-key'] as string]: request.headers['x-api-key'] } })}\n\n`); return;
  }
  if (reply === 'sse-failed' || reply === 'sse-error' || reply === 'sse-throttled') {
    const error = { code: reply === 'sse-throttled' ? 'rate_limit_exceeded' : 'server_error', message: `${request.headers.authorization} ${request.headers['x-api-key']}` };
    const event = reply !== 'sse-error' ? { type: 'response.failed', response: { error } } : { type: 'error', ...error };
    response.end(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); return;
  }
  if (request.url?.endsWith('/chat/completions')) {
    response.write(`data: ${JSON.stringify({ id: 'local-chat', choices: [{ index: 0, delta: { content: 'gateway ok' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'local-chat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
    response.end('data: [DONE]\n\n'); return;
  }
  for (const event of [
    { type: 'response.created', response: { id: 'resp_local' } },
    { type: 'response.output_text.delta', delta: replyText },
    { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
  ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); check.ok(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}/inference/v1`;
let seq = 0;
function helper(code = 'process.stdout.write("authorization: Bearer fixture-token\\nx-api-key: fixture-identity\\n")', overrides: Record<string, unknown> = {}) {
  const count = path.join(root, `count-${++seq}`);
  const config = parseHeadersCommand({ command: process.execPath,
    args: ['-e', `require('node:fs').appendFileSync(process.argv[1], 'x'); ${code}`, count],
    timeoutMs: 2000, refreshIntervalMs: 240000, ...overrides });
  return { config, count };
}
async function executions(count: string): Promise<number> {
  try { return (await readFile(count, 'utf8')).length; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
}
async function configured(extra: Record<string, unknown> = {}) {
  const file = configPath(root);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ provider: 'openai', model: 'auto', openaiApi: 'responses', baseUrl,
    contextWindowLimit: 1000000, ...extra }));
  return loadConfig(root);
}
async function stream(model: Awaited<ReturnType<typeof createModelFromConfig>>, signal?: AbortSignal) {
  let text = '';
  for await (const event of model.stream([new Message({ role: 'user', content: [new TextBlock('local fixture')] })],
    signal === undefined ? {} : { cancelSignal: signal })) {
    if (event.type === 'modelContentBlockDeltaEvent' && event.delta.type === 'textDelta') text += event.delta.text;
  }
  return text;
}
const post = (client: ReturnType<typeof createHeadersCommandClient>, signal?: AbortSignal, url = `${baseUrl}/responses`) =>
  client.clientConfig.fetch(url, { method: 'POST', body: '{}', ...(signal === undefined ? {} : { signal }) });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(test: () => Promise<boolean>, timeoutMs = 3000) {
  const until = performance.now() + timeoutMs;
  while (!await test()) { check.ok(performance.now() < until, 'fixture observation deadline'); await delay(10); }
}
async function safeFailure(run: () => Promise<unknown>, pattern: RegExp) {
  await check.rejects(run, error => {
    check.ok(error instanceof Error);
    check.match(error.message, pattern);
    check.doesNotMatch(error.message, /SECRET_SENTINEL|fixture-token|fixture-identity/);
    check.equal(error.cause, undefined);
    return true;
  });
}

async function configurationChecks() {
  const fixture = helper();
  const loaded = await configured({ headersCommand: fixture.config });
  check.equal(loaded.headersCommand?.timeoutMs, 2000);
  check.equal(loaded.contextWindowLimit, 1000000);
  check.equal(parseHeadersCommand({ command: process.execPath }).timeoutMs, 15000);
  check.equal(parseHeadersCommand({ command: process.execPath }).refreshIntervalMs, 240000);
  const invalid = [null, [], {}, { command: 'relative' }, { command: process.execPath, args: ['\0'] },
    { command: process.execPath, args: Array(33).fill('arg') }, { command: process.execPath, args: ['a'.repeat(4097)] },
    { command: process.execPath, args: 'headers' }, { command: process.execPath, args: null }, { command: process.execPath, unknown: true },
    ...[0, -1, 1.5, 60001, '15000', null].map(timeoutMs => ({ command: process.execPath, timeoutMs })),
    ...[0, -1, 1.5, 3600001, null].map(refreshIntervalMs => ({ command: process.execPath, refreshIntervalMs }))];
  for (const headersCommand of invalid) await check.rejects(() => configured({ headersCommand }), ConfigError);
  for (const extra of [
    { provider: 'anthropic' }, { provider: 'bedrock' }, { baseUrl: undefined },
    { baseUrl: 'http://remote.invalid/v1' }, { baseUrl: 'https://user:SECRET_SENTINEL@gateway.invalid/v1' },
    { baseUrl: 'https://gateway.invalid/v1?key=SECRET_SENTINEL' }, { baseUrl: 'https://gateway.invalid/v1#fragment' },
    { apiKeyEnv: 'SECRET_SENTINEL' }, { bedrockMantle: true }, { bedrockRuntime: true },
  ]) await check.rejects(() => configured({ headersCommand: fixture.config, ...extra }), ConfigError);
  for (const extra of [{ bedrockMantle: true }, { bedrockRuntime: true }]) {
    await check.rejects(() => configured(extra), ConfigError);
  }
  for (const baseUrl of ['https://gateway.invalid/v1', 'http://localhost:1234/v1', 'http://[::1]:1234/v1']) {
    check.equal((await configured({ baseUrl, headersCommand: fixture.config })).baseUrl, baseUrl);
  }
  await configured({ models: [
    { enable: true, provider: 'openai', model: 'auto', openaiApi: 'responses', baseUrl, headersCommand: fixture.config },
    { enable: false, provider: 'openai', model: 'static' },
  ], provider: undefined, model: undefined, openaiApi: undefined, baseUrl: undefined, contextWindowLimit: undefined });
  const file = configPath(root);
  const array = await loadConfig(root);
  check.ok(withModelChoice(array, array.modelChoices[0]!).headersCommand);
  const switched = withModelChoice(array, array.modelChoices[1]!);
  check.equal(switched.headersCommand, undefined); check.equal(switched.baseUrl, undefined);
  await writeFile(file, JSON.stringify({ models: [{ enable: true, provider: 'openai', model: 'auto', headersCommand: fixture.config }] }));
  await check.rejects(() => loadConfig(root), ConfigError);
  check.equal(await executions(fixture.count), 0, 'parsing/construction must not execute the helper');
  console.log('PASS configuration, bounds, conflicts, destination policy and array form');
}

async function wireChecks() {
  const env = { key: process.env['OPENAI_API_KEY'], base: process.env['OPENAI_BASE_URL'] };
  process.env['OPENAI_API_KEY'] = 'SECRET_SENTINEL';
  process.env['OPENAI_BASE_URL'] = 'https://wrong.invalid/v1';
  try {
    const fixture = helper();
    const config = await configured({ headersCommand: fixture.config });
    const parent = await createModelFromConfig(config);
    const child = await createModelFromConfig({ ...config });
    const auxiliary = await createModelFromConfig(config, { singleAttempt: true });
    check.equal(await executions(fixture.count), 0, 'construction is lazy');
    check.equal(parent.getConfig().contextWindowLimit, 1000000);
    check.doesNotMatch(JSON.stringify(parent.getConfig()), /fixture-token|fixture-identity|SECRET_SENTINEL|headersCommand/);
    const start = requests.length;
    check.deepEqual(await Promise.all([stream(parent), stream(child), stream(auxiliary)]), ['gateway ok', 'gateway ok', 'gateway ok']);
    check.equal(await executions(fixture.count), 1, 'all factories share one helper refresh');
    await stream(parent);
    check.equal(await executions(fixture.count), 1, 'cached subsequent turn');
    for (const request of requests.slice(start)) {
      check.equal(request.url, '/inference/v1/responses');
      check.equal(request.auth, 'Bearer fixture-token'); check.equal(request.key, 'fixture-identity');
      check.equal(request.body['model'], 'auto'); check.equal(request.body['store'], false);
    }
    replyText = 'literal fixture-token in a successful answer';
    check.equal(await stream(parent), replyText, 'successful content is never redacted');
    replyText = 'gateway ok';
    const chat = await configured({ openaiApi: 'chat', headersCommand: fixture.config });
    check.equal(await stream(await createModelFromConfig(chat)), 'gateway ok');
    check.equal(requests.at(-1)!.url, '/inference/v1/chat/completions');
    check.equal(requests.at(-1)!.auth, 'Bearer fixture-token'); check.equal(requests.at(-1)!.key, 'fixture-identity');
    const refreshing = helper('const n = require("node:fs").readFileSync(process.argv[1], "utf8").length; process.stdout.write(`Authorization: Bearer token-${n}\\nx-api-key: identity-${n}\\n`)', { refreshIntervalMs: 30 });
    const a = createHeadersCommandClient(refreshing.config, baseUrl);
    const b = createHeadersCommandClient(refreshing.config, baseUrl);
    await Promise.all([post(a), post(b)]);
    check.equal(await executions(refreshing.count), 1);
    await delay(50);
    await Promise.all([post(a), post(b)]);
    check.equal(await executions(refreshing.count), 2);
    check.equal(requests.at(-1)!.auth, 'Bearer token-2'); check.equal(requests.at(-1)!.key, 'identity-2');
    const bearerOnly = helper('process.stdout.write("AUTHORIZATION: Bearer bearer-only\\r\\n")');
    await post(createHeadersCommandClient(bearerOnly.config, baseUrl));
    check.equal(requests.at(-1)!.key, undefined);
    const marker = helper('if (!process.env.DARWIN) process.exit(4); process.stdin.on("end", () => process.stdout.write("Authorization: Bearer stdin-eof\\n")); process.stdin.resume()');
    await post(createHeadersCommandClient(marker.config, baseUrl));
    check.equal(requests.at(-1)!.auth, 'Bearer stdin-eof');
    const direct = await configured({ apiKeyEnv: 'OPENAI_API_KEY' });
    await stream(await createModelFromConfig(direct, { singleAttempt: true }));
    check.equal(requests.at(-1)!.auth, 'Bearer SECRET_SENTINEL', 'direct static-key baseUrl also works');
    console.log('PASS real Responses SSE, model factories, environment override, cache, refresh and stdin EOF');
  } finally {
    for (const [name, value] of [['OPENAI_API_KEY', env.key], ['OPENAI_BASE_URL', env.base]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

async function failureChecks() {
  const start = requests.length;
  const cases: [string, RegExp][] = [
    ['process.stderr.write("SECRET_SENTINEL"); process.stdout.write("SECRET_SENTINEL"); process.exit(2)', /unsuccessfully/],
    ['process.stdout.write("SECRET_SENTINEL")', /only Authorization/],
    ['process.stdout.write("x-api-key: SECRET_SENTINEL\\n")', /Authorization: Bearer/],
    ['process.stdout.write("Authorization: Basic SECRET_SENTINEL\\n")', /Authorization: Bearer/],
    ['process.stdout.write("Authorization: Bearer SECRET_SENTINEL\\nauthorization: Bearer duplicate\\n")', /duplicate/],
    ['process.stdout.write("Authorization: Bearer SECRET_SENTINEL\\nHost: attacker.invalid\\n")', /only Authorization/],
    ['process.stdout.write("Authorization: Bearer SECRET_SENTINEL\\nx-api-key: a\\u0001b\\n")', /invalid auth headers/],
    ['process.stdout.write(Buffer.from([255, 255]))', /UTF-8/],
    [`process.stdout.write('x'.repeat(${MAX_HEADERS_BYTES + 1}))`, /16 KiB/],
    ['process.stdout.write("Authorization: Bearer " + "x".repeat(8193))', /oversized/],
  ];
  for (const [code, pattern] of cases) {
    const fixture = helper(code);
    const client = createHeadersCommandClient(fixture.config, baseUrl);
    await safeFailure(() => post(client), pattern);
    await safeFailure(() => post(client), pattern);
    check.equal(await executions(fixture.count), 1, 'failure latches rather than rerunning an auth command');
  }
  const absent = parseHeadersCommand({ command: path.join(root, 'SECRET_SENTINEL-missing') });
  await safeFailure(() => post(createHeadersCommandClient(absent, baseUrl)), /could not start/);
  const wrapped = await createModelFromConfig(await configured({ headersCommand: absent }));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await check.rejects(() => stream(wrapped), error => {
      check.ok(error instanceof Error); check.match(error.message, /headersCommand: helper could not start/);
      check.match(error.message, /restart Darwin/); check.doesNotMatch(inspect(error, { depth: 10 }), /SECRET_SENTINEL/);
      return true;
    });
  }
  const repaired = helper();
  await post(createHeadersCommandClient(repaired.config, baseUrl));
  check.equal(requests.length, start + 1, 'all failures refused before HTTP; a fresh config can recover');
  const expiry = helper('if (require("node:fs").readFileSync(process.argv[1], "utf8").length > 1) process.exit(2); process.stdout.write("Authorization: Bearer first-success\\n")', { refreshIntervalMs: 1 });
  const expires = createHeadersCommandClient(expiry.config, baseUrl);
  await post(expires); await delay(10);
  const before = requests.length;
  await safeFailure(() => post(expires), /unsuccessfully/);
  await safeFailure(() => post(expires), /unsuccessfully/);
  check.equal(requests.length, before, 'never use expired credentials after a failed refresh');
  check.equal(await executions(expiry.count), 2);
  console.log('PASS failure latching, invalid/oversized output, expired-cache refusal and secret-free errors');
}

async function cancellationChecks() {
  const pidFile = path.join(root, 'helper-pids');
  const processCode = `const fs = require('node:fs'); const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid,c.pid])); setInterval(() => {}, 1000)`;
  const timed = helper(processCode, { timeoutMs: 600 });
  await safeFailure(() => post(createHeadersCommandClient(timed.config, baseUrl)), /timed out/);
  const pids = JSON.parse(await readFile(pidFile, 'utf8')) as number[];
  const running = async (pid: number) => {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  if (process.platform === 'linux') await until(async () => !(await Promise.all(pids.map(running))).some(Boolean));
  const waiting = helper('setTimeout(() => process.stdout.write("Authorization: Bearer shared\\n"), 350)');
  const client = createHeadersCommandClient(waiting.config, baseUrl);
  const aborted = new AbortController();
  const first = safeFailure(() => post(client, aborted.signal), /cancelled/);
  const sibling = post(client);
  await until(async () => await executions(waiting.count) === 1);
  aborted.abort();
  await first; await sibling;
  check.equal(await executions(waiting.count), 1, 'one cancelled waiter does not kill sibling refresh');
  await rm(pidFile);
  const alone = helper(processCode);
  const controller = new AbortController();
  const aloneClient = createHeadersCommandClient(alone.config, baseUrl);
  const cancel = safeFailure(() => post(aloneClient, controller.signal), /cancelled/);
  await until(async () => await executions(alone.count) === 1);
  await until(async () => { try { await readFile(pidFile); return true; } catch { return false; } });
  const alonePids = JSON.parse(await readFile(pidFile, 'utf8')) as number[];
  const noLateRequest = requests.length;
  controller.abort(); await cancel;
  if (process.platform === 'linux') await until(async () => !(await Promise.all(alonePids.map(running))).some(Boolean));
  check.equal(requests.length, noLateRequest);
  // A cancellation must not permanently latch an authentication failure.
  const immediate = new AbortController(); immediate.abort();
  const before = await executions(alone.count);
  await safeFailure(() => post(aloneClient, immediate.signal), /cancelled/);
  check.equal(await executions(alone.count), before);
  const recover = helper('setTimeout(() => process.stdout.write("Authorization: Bearer recovered\\n"), 100)');
  const recoverClient = createHeadersCommandClient(recover.config, baseUrl);
  const stop = new AbortController();
  const stopped = safeFailure(() => post(recoverClient, stop.signal), /cancelled/);
  await until(async () => await executions(recover.count) === 1); stop.abort(); await stopped;
  await post(recoverClient);
  check.equal(await executions(recover.count), 2);
  // Exercise SDK propagation too, not just the standalone fetch seam.
  const sdk = helper('setInterval(() => {}, 1000)');
  const model = await createModelFromConfig(await configured({ headersCommand: sdk.config }));
  const sdkStop = new AbortController();
  const sdkCancelled = check.rejects(() => stream(model, sdkStop.signal));
  await until(async () => await executions(sdk.count) === 1); sdkStop.abort(); await sdkCancelled;
  console.log('PASS timeout process-group cleanup, SDK cancellation, sibling isolation and cancellation recovery');
}

async function containmentChecks() {
  let received = 0;
  const other = createServer((_request, response) => { received += 1; response.end(); });
  other.listen(0, '127.0.0.1'); await once(other, 'listening');
  const address = other.address(); check.ok(address && typeof address !== 'string');
  const foreign = `http://127.0.0.1:${address.port}/stolen`;
  const fixture = helper();
  const client = createHeadersCommandClient(fixture.config, baseUrl);
  try {
    await safeFailure(() => post(client, undefined, foreign), /outside/);
    await safeFailure(() => post(client, undefined, `${baseUrl}-other/responses`), /outside/);
    check.equal(await executions(fixture.count), 0, 'off-endpoint request cannot even launch helper');
    redirectTarget = foreign; reply = 'redirect';
    await safeFailure(() => post(client), /redirects are forbidden/);
    check.equal(received, 0, 'redirect destination receives no request');
    reply = 'unauthorized';
    const model = await createModelFromConfig(await configured({ headersCommand: fixture.config }));
    const start = requests.length;
    await check.rejects(() => stream(model));
    check.equal(requests.length, start + 1, '401 is not refreshed or replayed');
    check.equal(await executions(fixture.count), 2, 'separate validated config has its own credential scope');
    reply = 'echo-error';
    const raw = await post(client);
    check.equal(raw.status, 400);
    check.equal(raw.headers.get('x-request-id'), '[redacted]');
    const body = await raw.text();
    check.doesNotMatch(body, /fixture-token|fixture-identity/); check.match(body, /context_length_exceeded/);
    await check.rejects(() => stream(model), error => {
      check.ok(error instanceof ContextWindowOverflowError, 'redaction preserves SDK error classification');
      check.doesNotMatch(inspect(error, { depth: 10 }), /fixture-token|fixture-identity/);
      return true;
    });
    for (const mode of ['sse-failed', 'sse-error'] as const) {
      reply = mode;
      await check.rejects(() => stream(model), error => {
        check.doesNotMatch(inspect(error, { depth: 10 }), /fixture-token|fixture-identity/);
        check.match(inspect(error, { depth: 10 }), /server_error/);
        check.doesNotMatch(JSON.stringify(failureFromError(error)), /fixture-token|fixture-identity/);
        return true;
      });
    }
    reply = 'echo-error';
    const escaped = helper('process.stdout.write("Authorization: Bearer distinct-token\\nx-api-key: identity-\\\"-\\\\-suffix\\n")');
    const escapedModel = await createModelFromConfig(await configured({ headersCommand: escaped.config }));
    await check.rejects(() => stream(escapedModel), error => {
      check.doesNotMatch(inspect(error, { depth: 10 }), /distinct-token|identity-/);
      return true;
    });
    reply = 'chat-error-details';
    const escapedChat = await createModelFromConfig(await configured({ headersCommand: escaped.config, openaiApi: 'chat' }));
    await check.rejects(() => stream(escapedChat), error => {
      check.doesNotMatch(inspect(error, { depth: 10 }), /distinct-token|identity-/); return true;
    });
    const logMessages: string[] = [];
    const restore = routeSdkLogs(entry => logMessages.push(entry.message));
    setSdkVerboseSink(entry => logMessages.push(entry.message));
    try {
      reply = 'sse-throttled';
      await check.rejects(() => stream(model));
      check.ok(logMessages.length > 0, 'SDK throttling log fixture exercised');
      check.doesNotMatch(logMessages.join('\n'), /fixture-token|fixture-identity/);
    } finally { setSdkVerboseSink(undefined); restore(); }
    reply = 'sse';
    // Real SDK/HTTP stream with an intentionally failing iterator cleanup seam.
    const closing = new OpenAIModel({ api: 'responses', modelId: 'auto', ...createHeadersCommandClient(fixture.config, baseUrl) });
    const original = closing.stream.bind(closing);
    closing.stream = async function* (...args: Parameters<typeof closing.stream>) {
      try { yield* original(...args); }
      finally { throw new Error('cleanup fixture-token fixture-identity'); }
    };
    const protectedModel = protectHeadersCommandModel(closing);
    const iterator = protectedModel.stream([new Message({ role: 'user', content: [new TextBlock('cleanup')] })])[Symbol.asyncIterator]();
    await iterator.next();
    await check.rejects(() => iterator.return!(), error => {
      check.match(inspect(error), /cleanup/); check.doesNotMatch(inspect(error), /fixture-token|fixture-identity/); return true;
    });
    check.equal(headersCommandStreamActive(), false);
    console.log('PASS containment, no 401 replay, HTTP/SSE/JSON/key/log redaction and protected cleanup');
  } finally {
    reply = 'sse'; other.closeAllConnections(); await new Promise<void>(resolve => other.close(() => resolve()));
  }
}

try {
  await configurationChecks();
  await wireChecks();
  await failureChecks();
  await cancellationChecks();
  await containmentChecks();
  console.log('All model headers-command checks passed.');
} finally {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}

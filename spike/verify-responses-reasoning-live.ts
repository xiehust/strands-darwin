/**
 * SER-101, live: provenance-scoped reasoning round-trip on the OpenAI Responses path,
 * measured on real models through a real `AgentRuntime` and its `/model` seam
 * (`AgentRuntime.changeModel`).
 *
 * One session walks every hand-off the direction names, with a tool call and a small
 * reasoning puzzle in every turn:
 *
 *   Claude → Kimi(×2) → GPT(×2) → [shutdown + resume by id] → GPT → Kimi → Claude
 *          → GPT → Claude
 *
 * which covers Claude→Kimi, Kimi→GPT, GPT→Kimi, Kimi(Responses)→Claude, Claude→GPT and
 * GPT→Claude, plus ≥2 same-model user turns with tool calls on both Responses models
 * and a `--resume`-style restore holding tagged blocks. Kimi(`bedrock` Converse)→Claude
 * runs in a fresh session: with Claude-signed reasoning in the history Kimi's own
 * Converse turn is refused (`doesn't support the reasoningContent.reasoningText.signature
 * field`) — measured in the first run of this suite, pre-existing and byte-identical to
 * the unpatched SDK, outside SER-101. A last session runs Mantle `openai.gpt-5.6-sol`
 * (us-east-1) for the no-regression check and answers the
 * `include: ['reasoning.encrypted_content']` question from the raw stream.
 *
 * Whether a call reasons is the model's choice (Kimi skipped it on whole turns in one
 * run), so each turn prints its per-call reasoning histogram (`deltas/items`) and the
 * per-model aggregate asserts capture plus replay in ≥2 user turns, once across a turn.
 *
 * The wire is observed, never altered: a `globalThis.fetch` wrapper (installed before
 * any OpenAI client exists) keeps every `/responses` request body, status and raw SSE
 * text; a wrapper around `BedrockModel.prototype._formatRequest` keeps every Converse
 * request's messages. Checks per turn:
 * - Responses: every call 200; the turn captured tagged blocks for the live model
 *   (Kimi: one `text` block per reasoning item; GPT: one `enc` block per item carrying
 *   `encrypted_content`); each call's `reasoning` input items are exactly the live
 *   model's earlier tagged blocks, in order, each directly before its message's
 *   text/`function_call`, with no `id`; no foreign reasoning is sent.
 * - Converse: the turn succeeds, no request carries a Responses tag, and a Claude
 *   request carries no signature-less reasoning.
 * Persistence: the restored session's messages are byte-identical to the ones shut
 * down, the snapshot carries the tags, the trajectory and the `/export` transcript
 * carry none.
 *
 * Model entries are built in-process into a private HOME (`ownPrivateHome`); the
 * developer's `~/.darwin/config.json` is never read or written. About 30 model calls.
 *
 * Run: AWS_REGION=us-west-2 pnpm tsx spike/verify-responses-reasoning-live.ts
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { BedrockModel, type Agent, type Message, type ReasoningBlock } from '@strands-agents/sdk';

import { parseResponsesReasoningSignature } from '../node_modules/@strands-agents/sdk/dist/src/models/openai/responses-adapter.js';
import { allowAllBridge } from '../src/agent/permission.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { exportTranscript } from '../src/trajectory/export.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

// ---- setup ----

const home = ownPrivateHome('responses-reasoning-live');
const CLAUDE = 'global.anthropic.claude-opus-5-5';
const KIMI = 'global.moonshotai.kimi-k3';
const GPT = 'global.openai.gpt-6-astra';
const SOL = 'openai.gpt-5.6-sol';
/**
 * The exact tag prefix every needle uses. Never the bare word: the private HOME is
 * `darwin-responses-reasoning-live-home-…`, so any path in a transcript header or
 * record would match it (the first version of this suite tripped on exactly that).
 */
const TAG = 'darwin-responses:v1:';
const ENTRIES = [
  { name: 'claude', provider: 'bedrock', model: CLAUDE, maxTokens: 8192, thinkingEffort: 'medium', enable: true },
  { name: 'kimi', provider: 'openai', model: KIMI, bedrockRuntime: true, openaiApi: 'responses', maxTokens: 8192, thinkingEffort: 'high' },
  { name: 'gpt', provider: 'openai', model: GPT, bedrockRuntime: true, openaiApi: 'responses', maxTokens: 8192, thinkingEffort: 'high' },
  { name: 'kimi-converse', provider: 'bedrock', model: KIMI, maxTokens: 8192 },
  { name: 'sol', provider: 'openai', model: SOL, region: 'us-east-1', bedrockMantle: true, openaiApi: 'responses', maxTokens: 8192, thinkingEffort: 'high' },
];
await mkdir(path.join(home, '.darwin'), { recursive: true });
await writeFile(
  path.join(home, '.darwin', 'config.json'),
  `${JSON.stringify({ permissionMode: 'yolo', models: ENTRIES }, null, 2)}\n`,
);

/** A small puzzle forces reasoning; the bash call forces a tool round-trip. */
const prompt = (n: number): string =>
  `Step ${n}. First work out, privately, a 3x3 magic square using the digits 1-9 once each whose ` +
  `top-left cell is ${(n % 4) * 2 + 2}. Then run \`echo marker-${n}\` with the bash tool. ` +
  `Reply with one line: the square's middle row, then the command's output.`;

const agentOf = (runtime: AgentRuntime): Agent => (runtime as unknown as { agent: Agent }).agent;

async function switchTo(runtime: AgentRuntime, name: string): Promise<void> {
  const choice = runtime.modelChoices.find((entry) => entry.name === name);
  if (choice === undefined) throw new Error(`no model entry named ${name}`);
  const result = await runtime.changeModel(choice);
  await result.saved;
  console.log(`  /model ${name} → ${runtime.config.provider} ${runtime.config.model}`);
}

// ---- wire capture ----

interface ResponsesCall {
  kind: 'responses';
  model: string;
  status: number;
  body: Record<string, unknown>;
  sse: string;
  ssePending: Promise<string>;
}
interface ConverseCall {
  kind: 'converse';
  model: string;
  messages: unknown[];
}
const wire: (ResponsesCall | ConverseCall)[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const res = await realFetch(input, init);
  if (!url.endsWith('/responses') || typeof init?.body !== 'string') return res;
  const body = JSON.parse(init.body) as Record<string, unknown>;
  const call: ResponsesCall = { kind: 'responses', model: String(body['model']), status: res.status, body, sse: '', ssePending: Promise.resolve('') };
  wire.push(call);
  if (res.body === null) return res;
  const [forClient, forUs] = res.body.tee();
  call.ssePending = new Response(forUs).text().then((text) => (call.sse = text));
  return new Response(forClient, { status: res.status, statusText: res.statusText, headers: res.headers });
}) as typeof fetch;

const bedrockProto = BedrockModel.prototype as unknown as {
  _formatRequest: (...args: unknown[]) => { modelId?: string; messages?: unknown[] };
};
const formatRequest = bedrockProto._formatRequest;
bedrockProto._formatRequest = function (this: unknown, ...args: unknown[]) {
  const request = formatRequest.apply(this, args);
  wire.push({ kind: 'converse', model: String(request.modelId), messages: request.messages ?? [] });
  return request;
};

/** The `data:` payloads of one raw SSE body. */
function sseEvents(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line.slice('data:'.length).trim()) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

/** Finished `reasoning` output items in one call's stream. */
function reasoningItemsDone(call: ResponsesCall): Record<string, unknown>[] {
  return sseEvents(call.sse)
    .filter((event) => event['type'] === 'response.output_item.done')
    .map((event) => event['item'] as Record<string, unknown>)
    .filter((item) => item?.['type'] === 'reasoning');
}

// ---- checks ----

interface TurnOutcome {
  error: string | undefined;
  calls: (ResponsesCall | ConverseCall)[];
  tools: string[];
  text: string;
  /** Messages the turn appended. */
  added: Message[];
  /** The whole history before the turn. */
  before: Message[];
}

async function runTurn(runtime: AgentRuntime, n: number): Promise<TurnOutcome> {
  const from = wire.length;
  const before = [...agentOf(runtime).messages];
  const tools: string[] = [];
  let text = '';
  let error: string | undefined;
  try {
    for await (const event of runtime.send(prompt(n))) {
      if (event.type === 'beforeToolCallEvent') tools.push(event.toolUse.name);
      if (
        event.type === 'modelStreamUpdateEvent' &&
        event.event.type === 'modelContentBlockDeltaEvent' &&
        event.event.delta.type === 'textDelta'
      ) {
        text += event.event.delta.text;
      }
    }
  } catch (cause) {
    error = (cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)).replace(/\s+/g, ' ').slice(0, 300);
  }
  const calls = wire.slice(from);
  await Promise.all(calls.map((call) => (call.kind === 'responses' ? call.ssePending : undefined)));
  const added = agentOf(runtime).messages.slice(before.length);
  return { error, calls, tools, text, added, before };
}

/** `enc:<blob>` / `text:<text>` for every block tagged for `modelId`, in history order. */
function ownLabels(messages: readonly Message[], modelId: string): string[] {
  const labels: string[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'reasoningBlock') continue;
      const reasoning = block as ReasoningBlock;
      const tag = parseResponsesReasoningSignature(reasoning.signature);
      if (tag === undefined || tag.modelId !== modelId) continue;
      if (tag.kind === 'enc') labels.push(`enc:${tag.encryptedContent}`);
      else if (tag.kind === 'text' && reasoning.text) labels.push(`text:${reasoning.text}`);
    }
  }
  return labels;
}

/** The request's `reasoning` input items as labels, plus the shape rules they must keep. */
function inputReasoning(call: ResponsesCall): { labels: string[]; ordered: boolean; noId: boolean } {
  const input = (call.body['input'] ?? []) as Record<string, unknown>[];
  const reasoning = input.filter((item) => item['type'] === 'reasoning');
  const labels = reasoning.map((item) =>
    typeof item['encrypted_content'] === 'string'
      ? `enc:${item['encrypted_content']}`
      : `text:${((item['content'] ?? []) as { text?: string }[]).map((part) => part.text ?? '').join('')}`,
  );
  const ordered = input.every((item, index) => {
    if (item['type'] !== 'reasoning') return true;
    const next = input[index + 1];
    return next !== undefined && (next['type'] === 'reasoning' || next['type'] === 'function_call' || next['role'] === 'assistant');
  });
  const noId = reasoning.every((item) => !('id' in item));
  return { labels, ordered, noId };
}

/** Strings from foreign reasoning that must never appear in a request to `modelId`. */
function foreignSecrets(messages: readonly Message[], modelId: string): string[] {
  const secrets: string[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'reasoningBlock') continue;
      const reasoning = block as ReasoningBlock;
      const tag = parseResponsesReasoningSignature(reasoning.signature);
      if (tag?.modelId === modelId) continue;
      if (tag?.kind === 'enc') secrets.push(tag.encryptedContent);
      else if (reasoning.signature !== undefined && tag === undefined) secrets.push(reasoning.signature);
      if (reasoning.text !== undefined && reasoning.text.length >= 40) secrets.push(reasoning.text);
    }
  }
  return secrets;
}

const summary: string[] = [];

function checkResponsesTurn(label: string, runtime: AgentRuntime, turn: TurnOutcome, modelId: string, kind: 'text' | 'enc'): void {
  const calls = turn.calls.filter((call): call is ResponsesCall => call.kind === 'responses' && call.model === modelId);
  const statuses = calls.map((call) => call.status);
  assert(`${label}: the turn succeeded and all ${calls.length} requests returned 200 [${statuses.join(',')}]${turn.error ? ` — ${turn.error}` : ''}`,
    turn.error === undefined && calls.length > 0 && statuses.every((status) => status === 200));
  assert(`${label}: the turn called a tool (${turn.tools.join(',') || 'none'})`, turn.tools.length > 0);

  const items = calls.flatMap(reasoningItemsDone);
  const withBlob = items.filter((item) => typeof item['encrypted_content'] === 'string' && item['encrypted_content'] !== '');
  const newOwn = ownLabels(turn.added, modelId);
  const expectedNew = kind === 'enc' ? withBlob.length : items.length;
  // Reasoning is the model's choice per call (Kimi skipped it on whole turns in one
  // run), so a turn without any is reported, not failed; the aggregate below insists
  // that replay really happened across turns.
  const histogram = calls.map((call) => {
    const events = sseEvents(call.sse);
    const deltas = events.filter((event) => String(event['type']).startsWith('response.reasoning')).length;
    return `${deltas}d/${reasoningItemsDone(call).length}i`;
  });
  const untagged = turn.added
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'reasoningBlock' && parseResponsesReasoningSignature((block as ReasoningBlock).signature) === undefined).length;
  console.log(`  ${label}: reasoning per call (deltas/items) ${histogram.join(' ')}; untagged blocks ${untagged}`);
  assert(`${label}: captured one tagged \`${kind}\` block per reasoning item (${newOwn.length}/${expectedNew}), none left untagged`,
    newOwn.length === expectedNew && newOwn.every((entry) => entry.startsWith(`${kind}:`)) && untagged === 0);

  const history = agentOf(runtime).messages;
  const allOwn = ownLabels(history, modelId);
  const earlier = ownLabels(turn.before, modelId);
  const shapes = calls.map(inputReasoning);
  assert(`${label}: the first request replays every earlier same-model item (${shapes[0]?.labels.length ?? 0}/${earlier.length})`,
    isDeepStrictEqual(shapes[0]?.labels, earlier));
  assert(`${label}: every request replays exactly the same-model items before it, in history order`,
    shapes.every((shape, index) =>
      isDeepStrictEqual(shape.labels, allOwn.slice(0, shape.labels.length)) &&
      shape.labels.length >= (shapes[index - 1]?.labels.length ?? 0)));
  const last = history[history.length - 1];
  const inLast = last === undefined ? 0 : ownLabels([last], modelId).length;
  assert(`${label}: the last request replays all ${allOwn.length - inLast} items then held`,
    shapes[shapes.length - 1]?.labels.length === allOwn.length - inLast);
  assert(`${label}: each reasoning item sits directly before its message's text/function_call, with no \`id\``,
    shapes.every((shape) => shape.ordered && shape.noId));
  const secrets = foreignSecrets(history, modelId);
  const leaked = calls.filter((call) => secrets.some((secret) => JSON.stringify(call.body['input']).includes(secret))).length;
  assert(`${label}: no foreign reasoning reached the wire (${secrets.length} foreign strings checked)`, leaked === 0);
  const replayed = shapes.map((shape) => shape.labels.length);
  const tally = replayTally.get(modelId) ?? { turnsReplaying: 0, crossTurn: 0, captured: 0 };
  tally.captured += newOwn.length;
  if (Math.max(0, ...replayed) > 0) tally.turnsReplaying += 1;
  if ((replayed[0] ?? 0) > 0) tally.crossTurn += 1;
  replayTally.set(modelId, tally);
  summary.push(`${label}: ${modelId} statuses [${statuses.join(',')}], captured ${newOwn.length} ${kind} (reasoning ${histogram.join(' ')}), replayed ${replayed.join('→')}, foreign dropped ${secrets.length}`);
}

/** Per Responses model: turns whose requests replayed reasoning, and turns whose first request did. */
const replayTally = new Map<string, { turnsReplaying: number; crossTurn: number; captured: number }>();

function checkConverseTurn(label: string, turn: TurnOutcome, modelId: string): void {
  const calls = turn.calls.filter((call): call is ConverseCall => call.kind === 'converse' && call.model === modelId);
  assert(`${label}: the turn succeeded (${calls.length} Converse requests)${turn.error ? ` — ${turn.error}` : ''}`,
    turn.error === undefined && calls.length > 0);
  assert(`${label}: the turn called a tool (${turn.tools.join(',') || 'none'})`, turn.tools.length > 0);
  const wireText = calls.map((call) => JSON.stringify(call.messages)).join('\n');
  assert(`${label}: no Responses-origin reasoning was sent to Converse`, !wireText.includes(TAG));
  const reasoningTexts = calls.flatMap((call) =>
    (call.messages as { content?: { reasoningContent?: { reasoningText?: { signature?: string } } }[] }[]).flatMap((message) =>
      (message.content ?? []).flatMap((block) => (block.reasoningContent?.reasoningText ? [block.reasoningContent.reasoningText] : [])),
    ),
  );
  const unsigned = reasoningTexts.filter((entry) => typeof entry.signature !== 'string').length;
  if (/anthropic|claude/i.test(modelId)) {
    assert(`${label}: a Claude request carries no signature-less reasoning (${reasoningTexts.length - unsigned} signed kept, ${unsigned} unsigned)`, unsigned === 0);
  }
  summary.push(`${label}: ${modelId} ${turn.error === undefined ? 'ok' : 'FAILED'}, Converse reasoning sent: ${reasoningTexts.length - unsigned} signed, ${unsigned} unsigned, tagged ${wireText.split(TAG).length - 1}`);
}

// ---- the hand-off session ----

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-ser101-live-'));
const open = (session: { kind: 'new' } | { kind: 'id'; sessionId: string }, projectRoot = root): Promise<AgentRuntime> =>
  AgentRuntime.create({ projectRoot, session, permissionBridge: allowAllBridge });
let runtime = await open({ kind: 'new' });
const sessionId = runtime.info.sessionId;
let step = 0;
try {
  header(`T1 Claude (${CLAUDE}, Converse) — puts signed Claude reasoning in the history`);
  const t1 = await runTurn(runtime, ++step);
  checkConverseTurn('T1 Claude', t1, CLAUDE);
  const claudeSigned = t1.added.flatMap((message) => message.content).filter((block) => block.type === 'reasoningBlock').length;
  console.log(`  Claude reasoning blocks in history: ${claudeSigned}`);

  header('Claude → Kimi (Responses): two same-model turns with tool calls');
  await switchTo(runtime, 'kimi');
  checkResponsesTurn('T2 Kimi', runtime, await runTurn(runtime, ++step), KIMI, 'text');
  checkResponsesTurn('T3 Kimi', runtime, await runTurn(runtime, ++step), KIMI, 'text');

  header('Kimi → GPT-6-astra: two same-model turns with tool calls');
  await switchTo(runtime, 'gpt');
  checkResponsesTurn('T4 GPT', runtime, await runTurn(runtime, ++step), GPT, 'enc');
  checkResponsesTurn('T5 GPT', runtime, await runTurn(runtime, ++step), GPT, 'enc');

  header('persistence: shut down, reopen by id (what `--resume <id>` does), continue on GPT');
  const beforeResume = JSON.stringify(agentOf(runtime).messages);
  await runtime.shutdown();
  runtime = await open({ kind: 'id', sessionId });
  const afterResume = JSON.stringify(agentOf(runtime).messages);
  assert('the restored history is byte-identical to the one shut down, tags included',
    afterResume === beforeResume && afterResume.includes(TAG));
  assert(`the restored session reopened on the saved model (${runtime.config.model})`, runtime.config.model === GPT);
  checkResponsesTurn('T6 GPT (resumed)', runtime, await runTurn(runtime, ++step), GPT, 'enc');

  header('GPT → Kimi: Kimi\'s own earlier reasoning comes back, GPT\'s is dropped');
  await switchTo(runtime, 'kimi');
  checkResponsesTurn('T7 Kimi', runtime, await runTurn(runtime, ++step), KIMI, 'text');

  header('Kimi (Responses) → Claude');
  await switchTo(runtime, 'claude');
  checkConverseTurn('T8 Claude', await runTurn(runtime, ++step), CLAUDE);

  header('Claude → GPT');
  await switchTo(runtime, 'gpt');
  checkResponsesTurn('T9 GPT', runtime, await runTurn(runtime, ++step), GPT, 'enc');

  header('GPT → Claude');
  await switchTo(runtime, 'claude');
  checkConverseTurn('T10 Claude', await runTurn(runtime, ++step), CLAUDE);

  header('persistence: the snapshot carries the tags; the trajectory and /export carry none');
  const recordFile = runtime.trajectoryStatus?.file;
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  await walk(path.join(home, '.darwin', 'sessions'));
  const tagged = [];
  for (const file of files) if ((await readFile(file, 'utf8')).includes(TAG)) tagged.push(path.relative(home, file));
  console.log(`  files carrying a tag: ${tagged.join(', ') || 'none'}`);
  assert('the session snapshot carries the tags (the resume carrier)', tagged.length > 0);
  assert('the trajectory record carries no tag and no blob', recordFile !== undefined && !tagged.includes(path.relative(home, recordFile)));
  const exported = await exportTranscript({ argument: 'ser101-export.md', projectRoot: root, sessionId, recordFile });
  const transcript = exported.written === undefined ? '' : await readFile(exported.written, 'utf8');
  assert(`the /export transcript is written, holds the turns and no tag (${exported.text.split('\n')[0]})`,
    transcript.includes('marker-') && !transcript.includes(TAG));
} finally {
  await runtime.shutdown();
}

for (const [modelId, tally] of replayTally) {
  assert(`${modelId}: reasoning captured (${tally.captured}) and replayed in ≥2 user turns (${tally.turnsReplaying}), across a user turn at least once (${tally.crossTurn})`,
    tally.captured > 0 && tally.turnsReplaying >= 2 && tally.crossTurn >= 1);
}

// ---- Kimi (Converse) → Claude ----

// A fresh session on purpose: Claude-signed reasoning in the history makes Kimi's own
// Converse turn fail (`doesn't support the reasoningContent.reasoningText.signature
// field`), a pre-existing Converse→Converse limit outside SER-101 and byte-identical
// to the unpatched SDK, so it must not mask the hand-off being measured here.
header('Kimi (`bedrock` Converse) → Claude, fresh session: signature-less reasoning must not reach Claude');
{
  const converseRoot = await mkdtemp(path.join(os.tmpdir(), 'darwin-ser101-converse-'));
  const converse = await open({ kind: 'new' }, converseRoot);
  try {
    await switchTo(converse, 'kimi-converse');
    const kimiTurn = await runTurn(converse, ++step);
    checkConverseTurn('C1 Kimi (Converse)', kimiTurn, KIMI);
    const unsignedKimi = kimiTurn.added
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'reasoningBlock' && (block as ReasoningBlock).signature === undefined).length;
    assert(`C1 left signature-less Converse reasoning for the hand-off to exercise (${unsignedKimi} blocks)`, unsignedKimi > 0);
    await switchTo(converse, 'claude');
    checkConverseTurn('C2 Claude (after Kimi Converse)', await runTurn(converse, ++step), CLAUDE);
  } finally {
    await converse.shutdown();
    await rm(converseRoot, { recursive: true, force: true });
  }
}

// ---- Mantle ----

header(`no regression: Mantle ${SOL} (us-east-1, Responses) — and the \`include\` question`);
{
  const mantleRoot = await mkdtemp(path.join(os.tmpdir(), 'darwin-ser101-mantle-'));
  const mantle = await open({ kind: 'new' }, mantleRoot);
  try {
    await switchTo(mantle, 'sol');
    const from = wire.length;
    checkResponsesTurn('M1 sol', mantle, await runTurn(mantle, ++step), SOL, 'enc');
    checkResponsesTurn('M2 sol', mantle, await runTurn(mantle, ++step), SOL, 'enc');
    const calls = wire.slice(from).filter((call): call is ResponsesCall => call.kind === 'responses');
    const items = calls.flatMap(reasoningItemsDone);
    const blobs = items.filter((item) => typeof item['encrypted_content'] === 'string' && item['encrypted_content'] !== '');
    const include = calls.map((call) => call.body['include']).filter((value) => value !== undefined);
    const answer = `requests sent include=${JSON.stringify(include)}; ${items.length} reasoning items, ${blobs.length} with encrypted_content`;
    console.log(`  include answer: ${answer}`);
    summary.push(`include (Mantle ${SOL}): ${answer}`);
  } finally {
    await mantle.shutdown();
    await rm(mantleRoot, { recursive: true, force: true });
  }
}
await rm(root, { recursive: true, force: true });

header('summary');
for (const line of summary) console.log(`  ${line}`);
console.log(`  requests: ${wire.filter((call) => call.kind === 'responses').length} Responses, ${wire.filter((call) => call.kind === 'converse').length} Converse formats`);

report();

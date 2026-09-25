/**
 * SER-101, offline: the pinned SDK patch's provenance-scoped reasoning round-trip on
 * the OpenAI Responses path.
 *
 * What the patch promises, each checked here without a network call:
 * - capture: Bedrock's `response.reasoning.delta` (Kimi K3) becomes a `ReasoningBlock`,
 *   and every `encrypted_content` reasoning item (GPT-6-astra) its own block;
 * - tag: each captured block carries `darwin-responses:v1:<model>:<kind>` in
 *   `signature`, the only field `ReasoningBlock.toJSON` persists;
 * - same-model replay: the next request's `input` holds every earlier same-model
 *   reasoning item as a stateless `{type:'reasoning', summary:[], …}` with no `id`,
 *   before that message's text and `function_call` items;
 * - drop: untagged, foreign-model, display-only (`sum`) and stateful reasoning is
 *   dropped exactly as before (one SDK warning, no input item);
 * - never elsewhere: Converse, Anthropic and Chat Completions formatters emit nothing
 *   for a tagged block, and Converse drops signature-less reasoning for a Claude id;
 * - byte-identical: with no tagged block, the Converse/Anthropic/Chat/Responses output
 *   is the pre-patch shape (golden literals), and adding tagged blocks changes nothing
 *   on the non-Responses formatters;
 * - persistence: JSON round-trip (what the session snapshot and `--resume` do) replays
 *   identically, and the trajectory projection of a tagged block is bare presence.
 *
 * The Responses turns run a real Strands `Agent` over `OpenAIModel` whose `fetch` is a
 * scripted SSE server, so the model's stream wiring (`createResponsesStreamState` gets
 * the request's model id) is covered too. The other formatters are called directly
 * through their private `_formatRequest`, the same seam `verify-prompt-cache.ts` uses.
 * Live counterpart: `spike/verify-responses-reasoning-live.ts`.
 *
 * Run: pnpm tsx spike/verify-responses-reasoning.ts
 */
import { isDeepStrictEqual } from 'node:util';

import { Agent, BedrockModel, Message, ReasoningBlock, TextBlock, ToolResultBlock, ToolUseBlock, tool } from '@strands-agents/sdk';
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import { z } from 'zod';

import { formatChatRequest } from '../node_modules/@strands-agents/sdk/dist/src/models/openai/chat-adapter.js';
import * as responsesAdapter from '../node_modules/@strands-agents/sdk/dist/src/models/openai/responses-adapter.js';
import { routeSdkLogs, type SdkLogEntry } from '../src/agent/sdk-logging.js';
import { projectEvent } from '../src/trajectory/record.js';
import { assert, header, report } from './shared.js';

// Read through the namespace with inert fallbacks, so an unpatched SDK (the revert
// control) fails assertion by assertion instead of at module link time.
const { formatResponsesRequest } = responsesAdapter;
const adapterExports = responsesAdapter as Partial<typeof responsesAdapter>;
const encodeResponsesReasoningSignature =
  adapterExports.encodeResponsesReasoningSignature ?? ((): string => 'unpatched-sdk');
const parseResponsesReasoningSignature =
  adapterExports.parseResponsesReasoningSignature ?? ((): undefined => undefined);

const KIMI = 'global.moonshotai.kimi-k3';
const GPT = 'global.openai.gpt-6-astra';
const CLAUDE = 'global.anthropic.claude-opus-5-5';

// ---- helpers ----

type SseEvent = { type: string } & Record<string, unknown>;

/** A scripted Responses endpoint: one SSE body per request, every request body kept. */
function scriptedServer(script: SseEvent[][]): { fetch: typeof fetch; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  let next = 0;
  const fake = async (_url: unknown, init?: { body?: unknown }): Promise<Response> => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const events = script[next++];
    if (events === undefined) return new Response('{"error":{"message":"script exhausted"}}', { status: 400 });
    const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch: fake as unknown as typeof fetch, bodies };
}

function responsesModel(modelId: string, server: { fetch: typeof fetch }): OpenAIModel {
  return new OpenAIModel({
    api: 'responses',
    modelId,
    maxTokens: 1024,
    apiKey: 'offline',
    clientConfig: { baseURL: 'http://offline.invalid/v1', fetch: server.fetch, maxRetries: 0 },
  } as never);
}

const created = (): SseEvent => ({ type: 'response.created', response: { id: 'resp_offline' } });
const completed = (): SseEvent => ({
  type: 'response.completed',
  response: { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
});
let itemSeq = 0;
/** Kimi K3's shape on the Bedrock runtime endpoint: `response.reasoning.delta`, text content. */
function kimiReasoning(...parts: string[]): SseEvent[] {
  const id = `rs_${++itemSeq}`;
  return [
    { type: 'response.output_item.added', item: { type: 'reasoning', id, summary: [] } },
    ...parts.map((delta) => ({ type: 'response.reasoning.delta', item_id: id, delta })),
    {
      type: 'response.output_item.done',
      item: { type: 'reasoning', id, summary: [], content: [{ type: 'reasoning_text', text: parts.join('') }] },
    },
  ];
}
/** GPT-6-astra's shape: no deltas, opaque `encrypted_content` on the finished item. */
function encReasoning(blob: string): SseEvent[] {
  const id = `rs_${++itemSeq}`;
  return [
    { type: 'response.output_item.added', item: { type: 'reasoning', id, summary: [] } },
    { type: 'response.output_item.done', item: { type: 'reasoning', id, summary: [], content: [], encrypted_content: blob } },
  ];
}
function call(callId: string, text: string): SseEvent[] {
  const id = `fc_${callId}`;
  const args = JSON.stringify({ text });
  return [
    { type: 'response.output_item.added', item: { type: 'function_call', id, call_id: callId, name: 'echo', arguments: '' } },
    { type: 'response.function_call_arguments.done', item_id: id, arguments: args },
  ];
}
const say = (text: string): SseEvent[] => [{ type: 'response.output_text.delta', delta: text }];
const response = (...parts: (SseEvent | SseEvent[])[]): SseEvent[] => [created(), ...parts.flat(), completed()];

const echo = tool({
  name: 'echo',
  description: 'Echo the text back.',
  inputSchema: z.object({ text: z.string() }),
  callback: ({ text }) => text,
});

function newAgent(model: OpenAIModel): Agent {
  return new Agent({ model, tools: [echo], printer: false });
}

/** One short label per Responses input item, so a whole request reads as one array. */
function shape(input: unknown): string[] {
  return (input as Record<string, unknown>[]).map((item) => {
    if (item['type'] === 'reasoning') {
      const extra = Object.keys(item).filter((key) => !['type', 'summary', 'content', 'encrypted_content'].includes(key));
      const suffix = extra.length > 0 ? `+${extra.join(',')}` : '';
      if (typeof item['encrypted_content'] === 'string') return `R:enc:${item['encrypted_content']}${suffix}`;
      const content = item['content'] as { text: string }[] | undefined;
      return `R:text:${content?.map((part) => part.text).join('') ?? ''}${suffix}`;
    }
    if (item['type'] === 'function_call') return `fc:${String(item['call_id'])}`;
    if (item['type'] === 'function_call_output') return `fco:${String(item['call_id'])}`;
    if (item['role'] === 'assistant') return `assistant:${String(item['content'])}`;
    return String(item['role']);
  });
}

function reasoningBlocks(messages: readonly Message[]): ReasoningBlock[] {
  return messages.flatMap((message) =>
    message.content.filter((block): block is ReasoningBlock => block.type === 'reasoningBlock'),
  );
}

function responsesInput(modelId: string, messages: Message[], stateful = false): unknown {
  return formatResponsesRequest({ modelId } as never, messages, undefined, stateful).input;
}

function withoutReasoning(messages: readonly Message[], keep: (block: ReasoningBlock) => boolean = () => false): Message[] {
  return messages.map(
    (message) =>
      new Message({
        role: message.role,
        content: message.content.filter((block) => block.type !== 'reasoningBlock' || keep(block as ReasoningBlock)),
      }),
  );
}

const isTagged = (block: ReasoningBlock): boolean => parseResponsesReasoningSignature(block.signature) !== undefined;

function converseMessages(modelId: string, messages: Message[]): string {
  const model = new BedrockModel({ region: 'us-west-2', modelId, maxTokens: 1024 });
  const request = (model as unknown as { _formatRequest: (m: Message[], o: object) => { messages: unknown } })._formatRequest(
    messages,
    {},
  );
  return JSON.stringify(request.messages);
}

function anthropicMessages(messages: Message[]): string {
  const model = new AnthropicModel({ modelId: 'claude-opus-5-5', maxTokens: 1024, apiKey: 'offline' });
  const request = (model as unknown as { _formatRequest: (m: Message[], o: object) => { messages: unknown } })._formatRequest(
    messages,
    {},
  );
  return JSON.stringify(request.messages);
}

function chatMessages(messages: Message[]): string {
  return JSON.stringify(formatChatRequest({ modelId: 'openai.gpt-oss-120b-1:0' } as never, messages, undefined).messages);
}

/**
 * Every SDK warning goes to one sink (routed exactly as the TUI routes them), so the
 * expected drop warnings neither tear the output nor escape counting.
 */
const sdkLog: SdkLogEntry[] = [];
routeSdkLogs((entry) => sdkLog.push(entry));

/** SDK warnings emitted while `run` executes. */
function warningsDuring<T>(run: () => T): { value: T; warnings: SdkLogEntry[] } {
  const start = sdkLog.length;
  const value = run();
  return { value, warnings: sdkLog.slice(start) };
}

// ---- scenarios ----

header('codec: the provenance tag inside `signature`');
{
  const colonId = 'openai.gpt-oss-120b-1:0';
  const text = encodeResponsesReasoningSignature(colonId, 'text');
  const enc = encodeResponsesReasoningSignature(KIMI, 'enc', 'gAAA:b/+=');
  assert('a text tag round-trips, a model id containing `:` included',
    isDeepStrictEqual(parseResponsesReasoningSignature(text), { modelId: colonId, kind: 'text' }));
  assert('an enc tag carries the opaque blob verbatim, `:` included',
    isDeepStrictEqual(parseResponsesReasoningSignature(enc), { modelId: KIMI, kind: 'enc', encryptedContent: 'gAAA:b/+=' }));
  const malformed = [
    undefined, '', 'EqQBCkgIBxABGAIiQJ1claude-signature', 'darwin-responses:v2:m:text', 'darwin-responses:v1::text',
    'darwin-responses:v1:m', 'darwin-responses:v1:m:bogus', 'darwin-responses:v1:m:enc', 'darwin-responses:v1:m:enc:',
    'darwin-responses:v1:m:text:extra', 'darwin-responses:v1:%E0%A4%A:text',
  ];
  assert('untagged, Claude-style, other-version, empty-blob and malformed signatures are not tags',
    malformed.every((signature) => parseResponsesReasoningSignature(signature) === undefined));
}

header('Kimi K3: `response.reasoning.delta` captured, tagged, replayed before its call/text');
const kimiServer = scriptedServer([
  response(kimiReasoning('plan ', 'A'), call('k1', 'one')),
  response(kimiReasoning('saw one'), say('done one')),
  response(kimiReasoning('plan B'), call('k2', 'two')),
  response(kimiReasoning('saw two'), say('done two')),
]);
const kimiAgent = newAgent(responsesModel(KIMI, kimiServer));
await kimiAgent.invoke('first');
await kimiAgent.invoke('second');
{
  const blocks = reasoningBlocks(kimiAgent.messages);
  assert('every Kimi call left one reasoning block in agent.messages (4)',
    isDeepStrictEqual(blocks.map((block) => block.text), ['plan A', 'saw one', 'plan B', 'saw two']));
  assert('each block is tagged `text` for the live model id',
    blocks.every((block) => block.signature === encodeResponsesReasoningSignature(KIMI, 'text')));
  const inputs = kimiServer.bodies.map((body) => shape(body['input']));
  assert('four requests, all stateless (`store: false`)',
    kimiServer.bodies.length === 4 && kimiServer.bodies.every((body) => body['store'] === false));
  assert('request 1 carries no reasoning', isDeepStrictEqual(inputs[0], ['user']));
  assert('request 2 replays turn-1 reasoning before its function_call',
    isDeepStrictEqual(inputs[1], ['user', 'R:text:plan A', 'fc:k1', 'fco:k1']));
  assert('request 4 (turn 2) replays every earlier Kimi reasoning item in order, before its call/text', isDeepStrictEqual(inputs[3], [
    'user', 'R:text:plan A', 'fc:k1', 'fco:k1', 'R:text:saw one', 'assistant:done one',
    'user', 'R:text:plan B', 'fc:k2', 'fco:k2',
  ]));
  const replayed = (kimiServer.bodies[1]?.['input'] as Record<string, unknown>[])[1];
  assert('the replayed item is exactly the stateless text shape (no `id`)', isDeepStrictEqual(replayed, {
    type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'plan A' }],
  }));
}

header('GPT-6-astra: one tagged block per `encrypted_content` item, replayed verbatim');
const gptServer = scriptedServer([
  response(encReasoning('ENC-ONE'), encReasoning('ENC-TWO'), call('g1', 'one')),
  response(say('done one')),
  response(encReasoning('ENC-THREE'), call('g2', 'two')),
  response(say('done two')),
]);
const gptAgent = newAgent(responsesModel(GPT, gptServer));
await gptAgent.invoke('first');
await gptAgent.invoke('second');
{
  const blocks = reasoningBlocks(gptAgent.messages);
  assert('three encrypted items became three blocks, never merged into one',
    isDeepStrictEqual(blocks.map((block) => parseResponsesReasoningSignature(block.signature)), [
      { modelId: GPT, kind: 'enc', encryptedContent: 'ENC-ONE' },
      { modelId: GPT, kind: 'enc', encryptedContent: 'ENC-TWO' },
      { modelId: GPT, kind: 'enc', encryptedContent: 'ENC-THREE' },
    ]));
  assert('opaque blocks carry no text', blocks.every((block) => block.text === undefined));
  const inputs = gptServer.bodies.map((body) => shape(body['input']));
  assert('request 2 replays both encrypted items, in order, before the call',
    isDeepStrictEqual(inputs[1], ['user', 'R:enc:ENC-ONE', 'R:enc:ENC-TWO', 'fc:g1', 'fco:g1']));
  assert('request 4 (turn 2) replays all three encrypted items, each before its own call', isDeepStrictEqual(inputs[3], [
    'user', 'R:enc:ENC-ONE', 'R:enc:ENC-TWO', 'fc:g1', 'fco:g1', 'assistant:done one',
    'user', 'R:enc:ENC-THREE', 'fc:g2', 'fco:g2',
  ]));
  const replayed = (gptServer.bodies[1]?.['input'] as Record<string, unknown>[])[1];
  assert('the replayed item is exactly the stateless opaque shape (no `id`)',
    isDeepStrictEqual(replayed, { type: 'reasoning', summary: [], encrypted_content: 'ENC-ONE' }));
}

header('summaries are display-only; an unfinished item stays untagged');
{
  const server = scriptedServer([
    response(
      { type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs_s', summary: [] } },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_s', delta: 'a summary' },
      { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_s', summary: [], encrypted_content: 'ENC-S' } },
      { type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs_t', summary: [] } },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_t', delta: 'summary only' },
      { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_t', summary: [] } },
      // Reasoning text interrupted by answer text before its item finished: no tag.
      { type: 'response.reasoning_text.delta', item_id: 'rs_u', delta: 'unfinished' },
      say('ok'),
    ),
  ]);
  const agent = newAgent(responsesModel(GPT, server));
  await agent.invoke('go');
  const tags = reasoningBlocks(agent.messages).map((block) => [block.text, parseResponsesReasoningSignature(block.signature)?.kind]);
  assert('summary + blob → a display `sum` block plus its own `enc` block; summary-only → `sum`; unfinished → untagged',
    isDeepStrictEqual(tags, [['a summary', 'sum'], [undefined, 'enc'], ['summary only', 'sum'], ['unfinished', undefined]]));
  assert('same-model replay sends only the encrypted item: summaries and untagged text are dropped',
    isDeepStrictEqual(shape(responsesInput(GPT, agent.messages)), ['user', 'R:enc:ENC-S', 'assistant:ok']));
}

// ---- cross-provider ----

const claudeSigned = new ReasoningBlock({ text: 'claude thinks', signature: 'EqQBCkgIBxABGAIiQJ1claude-sig' });
const claudeRedacted = new ReasoningBlock({ redactedContent: new Uint8Array([1, 2, 3]) });
const kimiConverse = new ReasoningBlock({ text: 'kimi converse thinks' });
const claudeTurn = [
  new Message({ role: 'user', content: [new TextBlock('claude q')] }),
  new Message({ role: 'assistant', content: [claudeSigned, claudeRedacted, new TextBlock('claude a')] }),
];
const kimiConverseTurn = [
  new Message({ role: 'user', content: [new TextBlock('kimi q')] }),
  new Message({ role: 'assistant', content: [kimiConverse, new TextBlock('kimi a')] }),
];
const mixed = [...claudeTurn, ...kimiConverseTurn, ...kimiAgent.messages, ...gptAgent.messages];
const taggedCount = reasoningBlocks(mixed).filter(isTagged).length;

header('Responses: only same-model tagged reasoning is replayed; everything else dropped as before');
{
  const toGpt = warningsDuring(() => responsesInput(GPT, [...kimiAgent.messages]));
  assert('Kimi → GPT: every Kimi reasoning item is dropped (input equals the reasoning-free history)',
    isDeepStrictEqual(toGpt.value, responsesInput(GPT, withoutReasoning(kimiAgent.messages))));
  assert('…with the same one SDK warning per dropped block as before the patch',
    toGpt.warnings.filter((entry) => entry.message.includes('reasoning content is not yet supported')).length === 4);
  assert('GPT → Kimi: every encrypted item is dropped',
    isDeepStrictEqual(responsesInput(KIMI, [...gptAgent.messages]), responsesInput(KIMI, withoutReasoning(gptAgent.messages))));
  assert('a different profile of the same model (`us.` vs `global.`) is foreign too',
    isDeepStrictEqual(responsesInput('us.openai.gpt-6-astra', [...gptAgent.messages]),
      responsesInput('us.openai.gpt-6-astra', withoutReasoning(gptAgent.messages))));
  assert('mixed history → GPT: only GPT\'s own three items survive; Claude, Kimi and Converse reasoning are dropped',
    shape(responsesInput(GPT, mixed)).filter((label) => label.startsWith('R:')).join(' ') === 'R:enc:ENC-ONE R:enc:ENC-TWO R:enc:ENC-THREE');
  assert('Claude → Responses: signed and redacted Claude reasoning never becomes an input item',
    isDeepStrictEqual(responsesInput(KIMI, claudeTurn), responsesInput(KIMI, withoutReasoning(claudeTurn))));
  assert('stateful requests replay nothing (reasoning stays server-side)',
    !shape(responsesInput(GPT, [...gptAgent.messages], true)).some((label) => label.startsWith('R:')));
}

header('never elsewhere: Converse, Anthropic and Chat Completions drop tagged blocks');
{
  const keepForClaude = (block: ReasoningBlock): boolean =>
    !isTagged(block) && (block.signature !== undefined || block.redactedContent !== undefined);
  const converse = converseMessages(CLAUDE, mixed);
  assert(`the mixed history holds ${taggedCount} tagged blocks to drop`, taggedCount === 7);
  assert('Converse (Claude): no Responses tag reaches the wire', !converse.includes('darwin-responses'));
  assert('Converse (Claude): the tagged and signature-less blocks contribute zero bytes',
    converse === converseMessages(CLAUDE, withoutReasoning(mixed, keepForClaude)));
  const kimiConverseWire = converseMessages(KIMI, mixed);
  assert('Converse (Kimi): no Responses tag, but Kimi\'s own signature-less reasoning is still sent as before',
    !kimiConverseWire.includes('darwin-responses') &&
      kimiConverseWire === converseMessages(KIMI, withoutReasoning(mixed, (block) => !isTagged(block))) &&
      kimiConverseWire.includes('{"reasoningContent":{"reasoningText":{"text":"kimi converse thinks"}}}'));
  const anthropic = anthropicMessages(mixed);
  assert('Anthropic: no tag reaches the wire, and tagged blocks contribute zero bytes',
    !anthropic.includes('darwin-responses') && anthropic === anthropicMessages(withoutReasoning(mixed, (block) => !isTagged(block))));
  const chat = chatMessages(mixed);
  assert('Chat Completions: tagged reasoning is not converted to text; untagged still is, as before',
    !chat.includes('darwin-responses') && !chat.includes('plan A') &&
      chat === chatMessages(withoutReasoning(mixed, (block) => !isTagged(block))) && chat.includes('claude thinks'));
}

header('byte-identical without a tagged block (pre-patch golden shapes)');
{
  const golden = JSON.stringify([
    { role: 'user', content: [{ text: 'claude q' }] },
    {
      role: 'assistant',
      content: [
        { reasoningContent: { reasoningText: { text: 'claude thinks', signature: 'EqQBCkgIBxABGAIiQJ1claude-sig' } } },
        { reasoningContent: { redactedContent: new Uint8Array([1, 2, 3]) } },
        { text: 'claude a' },
      ],
    },
  ]);
  assert('Converse (Claude): a signed + redacted Claude history formats exactly as before', converseMessages(CLAUDE, claudeTurn) === golden);
  assert('Converse (Kimi): signature-less reasoning on a non-Claude id formats exactly as before',
    converseMessages(KIMI, kimiConverseTurn) === JSON.stringify([
      { role: 'user', content: [{ text: 'kimi q' }] },
      { role: 'assistant', content: [{ reasoningContent: { reasoningText: { text: 'kimi converse thinks' } } }, { text: 'kimi a' }] },
    ]));
  assert('Anthropic: signed Claude reasoning is still a thinking block with its signature',
    anthropicMessages(claudeTurn).includes('{"type":"thinking","thinking":"claude thinks","signature":"EqQBCkgIBxABGAIiQJ1claude-sig"}'));
  const toolHistory = [
    new Message({ role: 'user', content: [new TextBlock('q')] }),
    new Message({ role: 'assistant', content: [claudeSigned, new TextBlock('calling'), new ToolUseBlock({ name: 'echo', toolUseId: 't1', input: { text: 'x' } })] }),
    new Message({ role: 'user', content: [new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock('x')] })] }),
    new Message({ role: 'assistant', content: [new TextBlock('a')] }),
  ];
  assert('Responses: untagged reasoning is dropped and the rest formats exactly as before', JSON.stringify(responsesInput(GPT, toolHistory)) === JSON.stringify([
    { role: 'user', content: [{ type: 'input_text', text: 'q' }] },
    { role: 'assistant', content: 'calling' },
    { type: 'function_call', call_id: 't1', name: 'echo', arguments: '{"text":"x"}' },
    { type: 'function_call_output', call_id: 't1', output: 'x' },
    { role: 'assistant', content: 'a' },
  ]));
}

header('persistence: what the session snapshot keeps replays identically; the trajectory keeps presence only');
{
  for (const [label, modelId, agent] of [['Kimi', KIMI, kimiAgent], ['GPT', GPT, gptAgent]] as const) {
    const serialized = JSON.stringify(agent.messages);
    const restored = (JSON.parse(serialized) as Parameters<typeof Message.fromJSON>[0][]).map((data) => Message.fromJSON(data));
    assert(`${label}: the serialized history carries the tags (signature is persisted)`, serialized.includes('darwin-responses:v1:'));
    assert(`${label}: the restored history formats byte-identically to the live one`,
      JSON.stringify(responsesInput(modelId, restored)) === JSON.stringify(responsesInput(modelId, [...agent.messages])));
  }
  const tagged = reasoningBlocks(gptAgent.messages)[0] as ReasoningBlock;
  const projectedTagged = projectEvent({ type: 'contentBlockEvent', contentBlock: tagged } as never).data;
  const projectedPlain = projectEvent({ type: 'contentBlockEvent', contentBlock: new ReasoningBlock({ text: 'plain' }) } as never).data;
  assert('trajectory: a tagged block projects to the same bare presence as any reasoning block (no tag, no blob)',
    isDeepStrictEqual(projectedTagged, projectedPlain) && !JSON.stringify(projectedTagged).includes('darwin-responses'));
}

report();

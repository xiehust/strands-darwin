/** SER-131: real SDK Responses parsing and agent loop over bounded offline SSE fixtures. */
import { Agent, MaxTokensError, Message, TextBlock, tool } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import { z } from 'zod';

import { assert, header, report } from './shared.js';

type SseEvent = { type: string } & Record<string, unknown>;
const created: SseEvent = { type: 'response.created', response: { id: 'fixture' } };
const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
const completed: SseEvent = { type: 'response.completed', response: { usage } };
const text = (delta: string): SseEvent => ({ type: 'response.output_text.delta', delta });

function fixture(turns: SseEvent[][]) {
  const bodies: Record<string, unknown>[] = [];
  const model = new OpenAIModel({
    modelId: 'fixture.responses', api: 'responses', apiKey: 'offline', maxTokens: 1024,
    clientConfig: { maxRetries: 0, fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const events = turns[bodies.length - 1];
      if (events === undefined) throw new Error('SSE fixture exhausted');
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } });
    } },
  });
  return { model, bodies };
}

async function aggregate(model: OpenAIModel) {
  const stream = model.streamAggregated([new Message({ role: 'user', content: [new TextBlock('go')] })]);
  let next = await stream.next();
  while (!next.done) next = await stream.next();
  return next.value;
}

header('SDK Responses stream: text, usage zeros and refusal/cutoff stop reasons');
{
  const { model } = fixture([[created, text('part one '), text('part two'), completed]]);
  const result = await aggregate(model);
  assert('streamed text is aggregated once, in order', result.message.content.length === 1 &&
    result.message.content[0] instanceof TextBlock && result.message.content[0].text === 'part one part two');
  assert('explicit zero cache counters remain reported, not absent',
    result.metadata?.usage?.cacheReadInputTokens === 0 && result.metadata.usage.cacheWriteInputTokens === 0);
}
for (const [reason, stop] of [['content_filter', 'contentFiltered'], ['max_output_tokens', 'maxTokens']] as const) {
  const { model } = fixture([[created, text('partial'),
    { type: 'response.incomplete', response: { incomplete_details: { reason }, usage } }]]);
  if (stop === 'maxTokens') {
    let failure: unknown;
    try { await aggregate(model); } catch (error) { failure = error; }
    assert('max_output_tokens throws MaxTokensError with the retained partial text',
      failure instanceof MaxTokensError && failure.partialMessage.content[0] instanceof TextBlock &&
      failure.partialMessage.content[0].text === 'partial');
  } else {
    const result = await aggregate(model);
    assert(`${reason} maps to ${stop} without claiming endTurn`, result.stopReason === stop);
  }
}

header('SDK loop: a cutoff during function arguments never executes the partial tool');
{
  let executions = 0;
  const sentinel = tool({ name: 'sentinel', description: 'Offline execution sentinel',
    inputSchema: z.object({ text: z.string() }), callback: () => { executions++; return 'unexpected'; } });
  const { model, bodies } = fixture([[created,
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc', call_id: 'call', name: 'sentinel', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc', delta: '{"text":"cut' },
    { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, usage } },
  ]]);
  const agent = new Agent({ model, tools: [sentinel], retryStrategy: null, printer: false });
  let failure: unknown;
  try { await agent.invoke('go'); } catch (error) { failure = error; }
  assert('maxTokens wins over the in-flight tool call and reaches Darwin recovery as MaxTokensError', failure instanceof MaxTokensError);
  assert('there is no tool side effect and no hidden follow-up model request', executions === 0 && bodies.length === 1);
}

header('SDK loop: an empty completed answer stays empty in history and can be followed by another turn');
{
  const { model, bodies } = fixture([[created, completed], [created, text('next answer'), completed]]);
  const agent = new Agent({ model, retryStrategy: null, printer: false });
  const first = await agent.invoke('first');
  const empty = first.lastMessage;
  assert('a completed empty stream returns endTurn with no invented answer text',
    first.stopReason === 'endTurn' && empty.content.length === 0);
  const second = await agent.invoke('second');
  const input = bodies[1]?.['input'] as { role?: string; content?: unknown }[];
  assert('the next provider request retains the intervening assistant role',
    input.length === 3 && input[0]?.role === 'user' && input[1]?.role === 'assistant' &&
    input[1].content === '[blank text]' && input[2]?.role === 'user');
  assert('the provider-only placeholder never rewrites stored history',
    empty.content.length === 0 && agent.messages.includes(empty) && second.lastMessage.content[0] instanceof TextBlock &&
    second.lastMessage.content[0].text === 'next answer');
}

report();

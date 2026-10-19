/** SDK 1.21 compatibility: real OpenAI client + loopback SSE, no remote model calls. */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { isDeepStrictEqual } from 'node:util';

import { Agent } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';

import { assert, header, report } from './shared.js';

// Upstream now reads usage even when the provider attaches it to finish_reason,
// not just a trailing choice-less chunk. Exercise both over the actual wire.
const bodies: Record<string, unknown>[] = [];
const usage = {
  prompt_tokens: 13, completion_tokens: 7, total_tokens: 20,
  prompt_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 },
};
let requests = 0;
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  bodies.push(JSON.parse(body) as Record<string, unknown>);
  const attached = requests++ === 0;
  const envelope = { id: 'chat-usage', object: 'chat.completion.chunk', created: 1, model: 'fixture.chat' };
  const chunks = [
    { ...envelope, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
    { ...envelope, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...(attached ? { usage } : {}) },
    ...(!attached ? [{ ...envelope, choices: [], usage }] : []),
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('missing loopback address');

try {
  header('SDK chat usage on finish_reason and on a trailing chunk');
  for (const placement of ['finish_reason', 'trailing']) {
    const agent = new Agent({
      model: new OpenAIModel({
        api: 'chat', modelId: 'fixture.chat', apiKey: 'fixture',
        clientConfig: { baseURL: `http://127.0.0.1:${address.port}/v1`, maxRetries: 0, timeout: 5_000 },
      }),
      printer: false,
      retryStrategy: null,
    });
    const result = await agent.invoke('say ok');
    assert(`${placement}: streaming still completes with the assistant text`,
      result.stopReason === 'endTurn' && result.lastMessage.content.some((block) => block.type === 'textBlock' && block.text === 'ok'));
    assert(`${placement}: provider totals and cache counters reach Agent metrics exactly once`,
      isDeepStrictEqual(agent.metrics.accumulatedUsage, {
        inputTokens: 13, outputTokens: 7, totalTokens: 20, cacheReadInputTokens: 5, cacheWriteInputTokens: 2,
      }));
  }
  assert('both requests opt into streaming usage without selecting a different API',
    requests === 2 && bodies.every((body) => body['stream'] === true
      && isDeepStrictEqual(body['stream_options'], { include_usage: true })));
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

report();

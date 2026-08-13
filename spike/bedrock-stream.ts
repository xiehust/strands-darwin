/**
 * Spike B — Bedrock streaming.
 *
 * Confirms credentials, region and model id work, that text arrives
 * incrementally, and catalogs the stream event types the TUI will have to
 * render (including the inner ModelStreamEvent types).
 *
 * Run: pnpm tsx spike/bedrock-stream.ts
 */
import { Agent, BedrockModel, tool } from '@strands-agents/sdk';
import type { AgentStreamEvent, ToolList } from '@strands-agents/sdk';
import { z } from 'zod';

import { MODEL_ID, REGION, assert, header, report } from './shared.js';

/** Counts outer event types, and inner `.event.type` for the wrapper events. */
class EventCatalog {
  readonly outer = new Map<string, number>();
  readonly inner = new Map<string, number>();

  record(event: AgentStreamEvent): void {
    this.outer.set(event.type, (this.outer.get(event.type) ?? 0) + 1);
    if ('event' in event) {
      const key = `${event.type} → ${event.event.type}`;
      this.inner.set(key, (this.inner.get(key) ?? 0) + 1);
    }
  }

  print(): void {
    console.log('\n  outer event types (count):');
    for (const [type, n] of [...this.outer].sort()) console.log(`    ${type}  x${n}`);
    if (this.inner.size > 0) {
      console.log('\n  wrapped inner event types (count):');
      for (const [type, n] of [...this.inner].sort()) console.log(`    ${type}  x${n}`);
    }
  }
}

function newAgent(tools: ToolList = []): Agent {
  return new Agent({
    model: new BedrockModel({ region: REGION, modelId: MODEL_ID, maxTokens: 512 }),
    // The SDK's built-in printer writes straight to stdout, which would fight
    // Ink for the terminal. The TUI must keep this off and render from events.
    printer: false,
    tools,
    systemPrompt: 'You are concise. Answer in one short sentence unless a tool is needed.',
  });
}

/** Text-only streaming: check deltas arrive in more than one chunk. */
async function textStream(catalog: EventCatalog): Promise<void> {
  header('1. text streaming');

  const agent = newAgent();
  const deltas: string[] = [];
  let firstDeltaAt = 0;
  const start = Date.now();

  process.stdout.write('  model says: ');
  for await (const event of agent.stream('Name the three primary colors, in one sentence.')) {
    catalog.record(event);
    if (event.type === 'modelStreamUpdateEvent' && event.event.type === 'modelContentBlockDeltaEvent') {
      const delta = event.event.delta;
      if (delta.type === 'textDelta') {
        if (firstDeltaAt === 0) firstDeltaAt = Date.now() - start;
        deltas.push(delta.text);
        process.stdout.write(delta.text);
      }
    }
  }
  console.log('\n');

  const full = deltas.join('');
  console.log(`  delta chunks       : ${deltas.length}`);
  console.log(`  time to first delta: ${firstDeltaAt}ms`);
  console.log(`  total time         : ${Date.now() - start}ms`);

  assert('received streaming text deltas', deltas.length > 0);
  assert('text arrived incrementally (more than one chunk)', deltas.length > 1);
  assert('assembled text is non-empty', full.trim().length > 0);
  assert('modelStreamUpdateEvent observed', catalog.outer.has('modelStreamUpdateEvent'));
  assert('agentResultEvent observed', catalog.outer.has('agentResultEvent'));
}

/** Tool-call streaming: surfaces the tool lifecycle events the TUI panel needs. */
async function toolStream(catalog: EventCatalog): Promise<void> {
  header('2. tool-call streaming');

  const clock = tool({
    name: 'getTime',
    description: 'Get the current time in a given IANA timezone.',
    inputSchema: z.object({ timezone: z.string().describe('IANA timezone, e.g. UTC') }),
    callback: ({ timezone }) => ({ timezone, time: new Date().toISOString() }),
  });

  const agent = newAgent([clock]);
  const toolNames: string[] = [];
  let sawToolResult = false;

  for await (const event of agent.stream('What time is it in UTC? Use the getTime tool.')) {
    catalog.record(event);
    if (event.type === 'beforeToolCallEvent') toolNames.push(event.toolUse.name);
    if (event.type === 'toolResultEvent') sawToolResult = true;
  }

  console.log(`  tool calls observed: ${JSON.stringify(toolNames)}`);

  assert('beforeToolCallEvent observed', toolNames.includes('getTime'));
  assert('afterToolCallEvent observed', catalog.outer.has('afterToolCallEvent'));
  assert('toolResultEvent observed', sawToolResult);
  assert('contentBlockEvent observed', catalog.outer.has('contentBlockEvent'));
}

/** The final AgentResult carries the usable end-of-turn state. */
async function resultShape(): Promise<void> {
  header('3. final AgentResult shape');

  const agent = newAgent();
  const result = await agent.invoke('Say "ok" and nothing else.');

  const serialized = result.lastMessage.toJSON() as { metadata?: { usage?: unknown } };

  console.log(`  stopReason  : ${result.stopReason}`);
  console.log(`  lastMessage : ${JSON.stringify(serialized)}`);
  // Token usage rides on the message metadata, not on `result.metrics`
  // (AgentMetrics is a telemetry meter and exposes no `usage` field).
  console.log(`  usage       : ${JSON.stringify(serialized.metadata?.usage ?? null)}`);

  assert('stopReason is endTurn', result.stopReason === 'endTurn');
  assert('lastMessage has content', result.lastMessage.content.length > 0);
  assert('token usage available on message metadata', serialized.metadata?.usage !== undefined);
}

async function main(): Promise<void> {
  console.log(`region=${REGION} modelId=${MODEL_ID}`);
  const catalog = new EventCatalog();
  await textStream(catalog);
  await toolStream(catalog);
  await resultShape();
  header('stream event catalog (for TUI rendering)');
  catalog.print();
  report();
}

await main();

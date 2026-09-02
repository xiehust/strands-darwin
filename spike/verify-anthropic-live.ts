/**
 * End-to-end acceptance for the `anthropic` provider behind a custom endpoint: a
 * real `AgentRuntime` speaking the Anthropic Messages API to whatever
 * `ANTHROPIC_BASE_URL` names (a gateway, proxy or relay), authenticated with
 * `ANTHROPIC_API_KEY`, doing the one thing darwin exists to do — call tools and
 * act on their output.
 *
 * Tool use is the part `verify-config.ts` cannot prove: the endpoint may proxy
 * plain text fine and still break on tool schemas, tool results or streaming.
 *
 * Run: pnpm tsx spike/verify-anthropic-live.ts [model]
 *      ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY come from the environment.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AgentRuntime } from '../src/agent/runtime.js';
import { allowAllBridge } from '../src/agent/permission.js';
import { configPath, resolveAnthropicBaseUrl } from '../src/config.js';
import { ownPrivateHome } from './shared.js';

const MODEL = process.argv[2] ?? 'claude-sonnet-4-6';

// The config lives under ~/.darwin, so this suite owns a private HOME rather
// than overwriting the developer's real file. Must run before `configPath()`.
ownPrivateHome('anthropic-live');

let passed = 0;
let failed = 0;

function assert(what: string, ok: boolean): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (ok) passed += 1;
  else failed += 1;
}

/** Writes the anthropic config and a project holding a file the agent must fix. */
async function fixture(): Promise<string> {
  await writeFile(
    configPath(),
    JSON.stringify(
      {
        provider: 'anthropic',
        model: MODEL,
        maxTokens: 8192,
        permissionMode: 'yolo',
      },
      null,
      2,
    ),
  );
  const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-anthropic-'));
  await writeFile(path.join(root, 'sum.js'), 'export const sum = (a, b) => a - b;\n');
  return root;
}

function textOf(event: { type: string; event?: { type: string; delta?: { type: string; text?: string } } }): string {
  if (
    event.type === 'modelStreamUpdateEvent' &&
    event.event?.type === 'modelContentBlockDeltaEvent' &&
    event.event.delta?.type === 'textDelta'
  ) {
    return event.event.delta.text ?? '';
  }
  return '';
}

async function main(): Promise<void> {
  const baseUrl = resolveAnthropicBaseUrl({});
  console.log(`=== anthropic live — ${MODEL} via ${baseUrl ?? 'the client default (api.anthropic.com)'} ===`);
  if (process.env['ANTHROPIC_API_KEY'] === undefined || process.env['ANTHROPIC_API_KEY'] === '') {
    console.log('  SKIP  ANTHROPIC_API_KEY is not set; nothing to verify against.');
    process.exitCode = 1;
    return;
  }
  assert('ANTHROPIC_BASE_URL resolves to the endpoint under test', baseUrl !== undefined);

  const root = await fixture();
  const runtime = await AgentRuntime.create({
    projectRoot: root,
    session: { kind: 'new' },
    permissionBridge: allowAllBridge,
  });

  try {
    console.log(`  model   : ${runtime.info.config.provider} / ${runtime.info.config.model}`);
    console.log(`  baseUrl : ${resolveAnthropicBaseUrl(runtime.info.config) ?? '(client default)'}`);
    console.log(`  thinking: ${JSON.stringify(runtime.info.thinking)}`);
    console.log(`  cache   : ${JSON.stringify(runtime.info.promptCache)}`);

    const toolCalls: string[] = [];
    const toolResults: { name: string; status: string }[] = [];
    let text = '';

    for await (const event of runtime.send(
      `The file ${path.join(root, 'sum.js')} has a bug: sum() subtracts instead of adding. ` +
        `Read it, fix it, and prove the fix by running it with node.`,
    )) {
      text += textOf(event);
      if (event.type === 'beforeToolCallEvent') toolCalls.push(event.toolUse.name);
      if (event.type === 'afterToolCallEvent') {
        toolResults.push({ name: event.toolUse.name, status: event.result.status });
      }
    }

    console.log(`  tools   : ${JSON.stringify(toolCalls)}`);
    console.log(`  results : ${JSON.stringify(toolResults)}`);
    console.log(`  reply   : ${text.trim().replace(/\s+/g, ' ').slice(0, 200)}`);

    assert('the model called at least one tool', toolCalls.length > 0);
    assert('no tool call came back as an error', toolResults.every((r) => r.status !== 'error'));
    assert('it used both the editor and the shell', toolCalls.includes('fileEditor') && toolCalls.includes('bash'));

    const fixedSource = await readFile(path.join(root, 'sum.js'), 'utf8');
    console.log(`  sum.js  : ${fixedSource.trim()}`);
    assert('sum.js now adds', /a\s*\+\s*b/.test(fixedSource));

    // Second turn on the same runtime: history has to round-trip through the
    // endpoint as darwin's own messages (tool_use / tool_result pairs included).
    let followUp = '';
    for await (const event of runtime.send('In one word, what operator did you just write?')) {
      followUp += textOf(event);
    }
    console.log(`  turn 2  : ${followUp.trim().replace(/\s+/g, ' ').slice(0, 120)}`);
    assert('the second turn still has the first turn in context', /plus|\+|add/i.test(followUp));
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }

  console.log(`\n--- ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exitCode = 1;
}

await main();

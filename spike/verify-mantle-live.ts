/**
 * End-to-end acceptance for the Bedrock Mantle pathway: a real `AgentRuntime`
 * on `openai.gpt-5.6-sol`, doing the one thing darwin exists to do — call tools
 * and act on their output.
 *
 * Tool use over the Responses API is the part no config test can prove: the SDK
 * translates tool schemas and tool results differently per api mode, and a model
 * that answers plain text fine can still fail the moment a tool is in play.
 *
 * Run: pnpm tsx spike/verify-mantle-live.ts
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AgentRuntime } from '../src/agent/runtime.js';
import { allowAllBridge } from '../src/agent/permission.js';

const MODEL = process.argv[2] ?? 'openai.gpt-5.6-sol';
const REGION = process.env['MANTLE_REGION'] ?? 'us-east-1';

let passed = 0;
let failed = 0;

function assert(what: string, ok: boolean): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (ok) passed += 1;
  else failed += 1;
}

/** A project root configured for Mantle, holding a file the agent must fix. */
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-mantle-'));
  await mkdir(path.join(root, '.darwin'), { recursive: true });
  await writeFile(
    path.join(root, '.darwin', 'config.json'),
    JSON.stringify(
      {
        provider: 'openai',
        model: MODEL,
        bedrockMantle: true,
        openaiApi: 'responses',
        region: REGION,
        maxTokens: 8192,
        permissionMode: 'yolo',
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(root, 'sum.js'), 'export const sum = (a, b) => a - b;\n');
  return root;
}

async function main(): Promise<void> {
  console.log(`=== mantle live — ${MODEL} in ${REGION} ===`);
  const root = await fixture();
  const runtime = await AgentRuntime.create({
    projectRoot: root,
    resume: false,
    permissionBridge: allowAllBridge,
  });

  try {
    console.log(`  model   : ${runtime.info.config.provider} / ${runtime.info.config.model}`);
    console.log(`  thinking: ${JSON.stringify(runtime.info.thinking)}`);
    console.log(`  cache   : ${JSON.stringify(runtime.info.promptCache)}`);

    const toolCalls: string[] = [];
    const toolResults: { name: string; status: string }[] = [];
    let text = '';

    for await (const event of runtime.send(
      `The file ${path.join(root, 'sum.js')} has a bug: sum() subtracts instead of adding. ` +
        `Read it, fix it, and prove the fix by running it with node.`,
    )) {
      if (
        event.type === 'modelStreamUpdateEvent' &&
        event.event.type === 'modelContentBlockDeltaEvent' &&
        event.event.delta.type === 'textDelta'
      ) {
        text += event.event.delta.text;
      }
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

    // Second turn on the same runtime: the Responses API is used statelessly, so
    // history must survive as darwin's own messages, not the server's.
    let followUp = '';
    for await (const event of runtime.send('In one word, what operator did you just write?')) {
      if (
        event.type === 'modelStreamUpdateEvent' &&
        event.event.type === 'modelContentBlockDeltaEvent' &&
        event.event.delta.type === 'textDelta'
      ) {
        followUp += event.event.delta.text;
      }
    }
    console.log(`  turn 2  : ${followUp.trim().replace(/\s+/g, ' ').slice(0, 120)}`);
    assert('the second turn still has the first turn in context', /plus|\+|add/i.test(followUp));

    // `/effort` rewrites `params` wholesale on the live model, so a wrong shape
    // here does not degrade — it 400s the next turn. `max` also proves the Mantle
    // clamp exemption reaches the wire, not just the plan.
    const raised = runtime.changeThinkingEffort('max');
    await raised.saved;
    console.log(`  effort  : ${JSON.stringify(raised.plan)}`);
    assert('max is not clamped on mantle', raised.plan.effective === 'max');

    let afterEffort = '';
    for await (const event of runtime.send('Reply with the single word: ok')) {
      if (
        event.type === 'modelStreamUpdateEvent' &&
        event.event.type === 'modelContentBlockDeltaEvent' &&
        event.event.delta.type === 'textDelta'
      ) {
        afterEffort += event.event.delta.text;
      }
    }
    console.log(`  turn 3  : ${afterEffort.trim().replace(/\s+/g, ' ').slice(0, 80)}`);
    assert('a turn after raising effort still succeeds', afterEffort.trim() !== '');
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }

  console.log(`\n--- ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exitCode = 1;
}

await main();

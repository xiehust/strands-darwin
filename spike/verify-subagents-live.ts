/** Live acceptance: the main model delegates, and the child uses gated repository tools. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AgentRuntime } from '../src/agent/runtime.js';
import type { AssessedPermissionRequest } from '../src/agent/permission.js';
import { assert, header, report } from './shared.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-subagent-live-'));
const asked: AssessedPermissionRequest[] = [];

try {
  await mkdir(path.join(root, '.darwin'), { recursive: true });
  await writeFile(
    path.join(root, '.darwin', 'config.json'),
    JSON.stringify({
      model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      region: process.env.AWS_REGION ?? 'us-west-2',
      maxTokens: 4096,
      permissionMode: 'default',
      promptCache: false,
      thinkingEffort: 'low',
    }),
  );
  await writeFile(path.join(root, 'marker.txt'), 'delegation-marker-731\n');

  const runtime = await AgentRuntime.create({
    projectRoot: root,
    resume: false,
    permissionBridge: async (request) => {
      asked.push(request);
      return { allowed: false };
    },
  });

  try {
    header('subagents live — main delegates repository inspection');
    const toolCalls: string[] = [];
    let text = '';
    for await (const event of runtime.send(
      `Use the subagent tool with the general agent. Ask it to read ${path.join(root, 'marker.txt')} and report its exact contents. ` +
        'Do not read the file yourself. Then tell me the child report.',
    )) {
      if (event.type === 'beforeToolCallEvent') toolCalls.push(event.toolUse.name);
      if (
        event.type === 'modelStreamUpdateEvent' &&
        event.event.type === 'modelContentBlockDeltaEvent' &&
        event.event.delta.type === 'textDelta'
      ) {
        text += event.event.delta.text;
      }
    }

    console.log(`  tools: ${JSON.stringify(toolCalls)}`);
    console.log(`  asked: ${JSON.stringify(asked.map((request) => request.toolName))}`);
    console.log(`  reply: ${text.trim().replace(/\s+/g, ' ').slice(0, 300)}`);
    assert('the main agent called subagent', toolCalls.includes('subagent'));
    assert('the child report returned the repository marker', text.includes('delegation-marker-731'));
    assert('the child safe read needed no permission prompt', asked.length === 0);

    header('subagents live — child execute reaches permission gate');
    const secondCalls: string[] = [];
    for await (const event of runtime.send(
      'Use the general subagent again. Ask it to run `node -e "console.log(42)"` with bash and report the output. ' +
        'Do not run bash yourself.',
    )) {
      if (event.type === 'beforeToolCallEvent') secondCalls.push(event.toolUse.name);
    }
    console.log(`  tools: ${JSON.stringify(secondCalls)}`);
    console.log(`  asked: ${JSON.stringify(asked.map((request) => request.toolName))}`);
    assert('the second task also delegated', secondCalls.includes('subagent'));
    assert('the child bash call reached the shared permission bridge', asked.some((request) => request.toolName === 'bash'));
  } finally {
    await runtime.shutdown();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

report();

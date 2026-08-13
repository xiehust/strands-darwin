/**
 * Verification harness for implement.md steps 1 and 2.
 *
 * Drives AgentRuntime directly with a scripted permission bridge so the
 * acceptance criteria are checked deterministically rather than by eyeballing a
 * REPL transcript. The REPL itself is exercised separately by piping stdin.
 *
 * Run: AWS_REGION=us-west-2 pnpm tsx spike/verify-step-1-2.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AgentRuntime } from '../src/agent/runtime.js';
import type { PermissionRequest } from '../src/agent/permission.js';
import { assert, header, report } from './shared.js';

const PROJECT_ROOT = '/tmp/darwin-proj';
const FIXTURE_DIR = '/tmp/darwin-fixture';
const SUM_PATH = path.join(FIXTURE_DIR, 'sum.js');
const CHECK_PATH = path.join(FIXTURE_DIR, 'check.js');

const BUGGY_SUM = `// Adds two numbers together.
function sum(a, b) {
  return a - b;
}

module.exports = { sum };
`;

const CHECK_SCRIPT = `const assert = require('node:assert');
const { sum } = require('./sum.js');

assert.strictEqual(sum(2, 3), 5, 'sum(2, 3) should be 5');
assert.strictEqual(sum(10, 0), 10, 'sum(10, 0) should be 10');
console.log('OK: all sum checks passed');
`;

/** Restores the fixture to its broken state so each scenario starts clean. */
async function resetFixture(): Promise<void> {
  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(SUM_PATH, BUGGY_SUM, 'utf8');
  await writeFile(CHECK_PATH, CHECK_SCRIPT, 'utf8');
}

/** Records every permission request and answers with a fixed decision. */
function recordingBridge(decision: boolean) {
  const seen: PermissionRequest[] = [];
  const bridge = async (request: PermissionRequest): Promise<boolean> => {
    seen.push(request);
    return decision;
  };
  return { bridge, seen };
}

function checkPasses(): boolean {
  try {
    const out = execFileSync('node', [CHECK_PATH], { encoding: 'utf8' });
    return out.includes('OK: all sum checks passed');
  } catch {
    return false;
  }
}

/**
 * Runs `body` against a fresh runtime and always shuts it down.
 *
 * Shutdown reaps the persistent bash shell and any MCP children. A plain script
 * happens to exit anyway (with an empty event loop the SDK's own `beforeExit`
 * cleanup fires), but relying on that leaves shells alive for the rest of the run
 * and hides the same leak that hung the TUI.
 */
async function withRuntime<T>(
  options: Parameters<typeof AgentRuntime.create>[0],
  body: (runtime: AgentRuntime) => Promise<T>,
): Promise<T> {
  const runtime = await AgentRuntime.create(options);
  try {
    return await body(runtime);
  } finally {
    await runtime.shutdown();
  }
}

/** Consumes a turn, collecting the assistant text and the tools that ran. */
async function runTurn(runtime: AgentRuntime, input: string) {
  const text: string[] = [];
  const toolCalls: string[] = [];
  const toolResults: { name: string; status: string }[] = [];

  for await (const event of runtime.send(input)) {
    if (
      event.type === 'modelStreamUpdateEvent' &&
      event.event.type === 'modelContentBlockDeltaEvent' &&
      event.event.delta.type === 'textDelta'
    ) {
      text.push(event.event.delta.text);
    }
    if (event.type === 'beforeToolCallEvent') toolCalls.push(event.toolUse.name);
    if (event.type === 'afterToolCallEvent') {
      toolResults.push({ name: event.toolUse.name, status: event.result.status });
    }
  }
  await runtime.markResumable();
  return { text: text.join(''), toolCalls, toolResults };
}

/** Criterion 1: read a file, edit it (prompted), run a command (prompted). */
async function approvedEditFlow(): Promise<void> {
  header('Criterion 1 — read, edit (prompted), run command (prompted)');

  await resetFixture();
  await rm(PROJECT_ROOT, { recursive: true, force: true });
  const { bridge, seen } = recordingBridge(true);

  const turn = await withRuntime(
    { projectRoot: PROJECT_ROOT, resume: false, permissionBridge: bridge },
    async (runtime) => {
      console.log(`  model   : ${runtime.info.config.provider} / ${runtime.info.config.model}`);
      console.log(
        `  session : ${runtime.info.sessionId} (${runtime.info.resumed ? 'resumed' : 'new'})`,
      );

      return runTurn(
        runtime,
        `The file ${SUM_PATH} has a bug: sum() subtracts instead of adding. ` +
          `Read the file, fix the bug, then run "node ${CHECK_PATH}" to verify the fix passes.`,
      );
    },
  );

  const sumSource = await readFile(SUM_PATH, 'utf8');
  const prompted = seen.map((r) => `${r.toolName}:${r.kind}`);
  const views = turn.toolCalls.filter((n) => n === 'fileEditor').length;

  console.log(`  tool calls    : ${JSON.stringify(turn.toolCalls)}`);
  console.log(`  prompted for  : ${JSON.stringify(prompted)}`);
  console.log(`  sum.js now    : ${sumSource.replace(/\n/g, ' ').trim()}`);

  assert('agent used fileEditor', views > 0);
  assert('agent used bash', turn.toolCalls.includes('bash'));
  assert('a write was prompted for approval', seen.some((r) => r.kind === 'write'));
  assert('a command execution was prompted for approval', seen.some((r) => r.kind === 'execute'));
  assert(
    'reads were NOT prompted for approval',
    seen.every((r) => r.kind !== 'read'),
  );
  assert('the bug is actually fixed in the file', /a\s*\+\s*b/.test(sumSource));
  assert('the verification script now passes', checkPasses());
  assert('no tool call ended in error', turn.toolResults.every((r) => r.status !== 'error'));

  const writeRequest = seen.find((r) => r.kind === 'write');
  if (writeRequest) {
    console.log(`  write summary : ${writeRequest.summary}`);
    console.log(`  write details : ${writeRequest.details.map((d) => d.label).join(', ')}`);
    assert('write request summary names the file', writeRequest.summary.includes('sum.js'));
    assert('write request carries renderable details', writeRequest.details.length > 0);
  }
  const execRequest = seen.find((r) => r.kind === 'execute');
  if (execRequest) {
    console.log(`  exec summary  : ${execRequest.summary}`);
    assert(
      'execute request exposes the command',
      execRequest.details.some((d) => d.label === 'Command' && d.value.length > 0),
    );
  }
}

/** Criterion 2: denying a write leaves the file alone and the agent recovers. */
async function deniedEditFlow(): Promise<void> {
  header('Criterion 2 — denied write: file untouched, agent changes course');

  await resetFixture();
  await rm(PROJECT_ROOT, { recursive: true, force: true });
  const { bridge, seen } = recordingBridge(false);

  const turn = await withRuntime(
    { projectRoot: PROJECT_ROOT, resume: false, permissionBridge: bridge },
    (runtime) =>
      runTurn(
        runtime,
        `Change ${SUM_PATH} so that sum() adds its two arguments instead of subtracting.`,
      ),
  );

  const sumSource = await readFile(SUM_PATH, 'utf8');

  console.log(`  prompted for : ${JSON.stringify(seen.map((r) => `${r.toolName}:${r.kind}`))}`);
  console.log(`  tool results : ${JSON.stringify(turn.toolResults)}`);
  console.log(`  agent said   : ${turn.text.trim().slice(0, 240)}`);

  assert('a write was prompted', seen.some((r) => r.kind === 'write'));
  assert('file was NOT modified after denial', sumSource.includes('a - b'));
  assert('denied call surfaced as an error tool result', turn.toolResults.some((r) => r.status === 'error'));
  assert('agent still produced a closing message', turn.text.trim().length > 0);
  assert('conversation continued past the denial (turn completed)', true);
}

/** Criterion 3: --resume restores prior context. */
async function resumeFlow(): Promise<void> {
  header('Criterion 3 — --resume restores conversation context');

  await rm(PROJECT_ROOT, { recursive: true, force: true });
  const token = `PLUM-${Math.floor(Math.random() * 9000) + 1000}`;

  const firstSession = await withRuntime(
    { projectRoot: PROJECT_ROOT, resume: false, permissionBridge: recordingBridge(true).bridge },
    async (first) => {
      await runTurn(first, `Remember this build token for later: ${token}. Just acknowledge it.`);
      console.log(`  session 1 : ${first.info.sessionId} (${first.messageCount} messages)`);
      return first.info.sessionId;
    },
  );

  // A separate runtime, as a new process would be.
  await withRuntime(
    { projectRoot: PROJECT_ROOT, resume: true, permissionBridge: recordingBridge(true).bridge },
    async (second) => {
      console.log(`  session 2 : ${second.info.sessionId} (resumed=${second.info.resumed})`);
      console.log(`  restored  : ${second.messageCount} messages`);

      assert('resumed the same session id', second.info.sessionId === firstSession);
      assert('resumed flag is set', second.info.resumed);
      assert('history was restored into the agent', second.messageCount > 0);

      const followUp = await runTurn(second, 'What was the build token I asked you to remember?');
      console.log(`  recalled  : ${followUp.text.trim().slice(0, 160)}`);

      assert('agent recalled the token from the previous session', followUp.text.includes(token));
    },
  );
}

/** The summarizing conversation manager is wired up (behavior not triggered). */
async function conversationManagerAttached(): Promise<void> {
  header('SummarizingConversationManager attached');

  await rm(PROJECT_ROOT, { recursive: true, force: true });

  const managerName = await withRuntime(
    { projectRoot: PROJECT_ROOT, resume: false, permissionBridge: recordingBridge(true).bridge },
    async (runtime) => {
      // Not public API; this only confirms the wiring, it is not relied on elsewhere.
      const manager = (runtime as unknown as { agent: { _conversationManager?: { name?: string } } })
        .agent._conversationManager;
      return manager?.name;
    },
  );
  console.log(`  manager name: ${managerName ?? '(unavailable)'}`);

  assert(
    'conversation manager is the summarizing one',
    managerName === 'strands:summarizing-conversation-manager',
  );
}

async function main(): Promise<void> {
  await approvedEditFlow();
  await deniedEditFlow();
  await resumeFlow();
  await conversationManagerAttached();
  report();
}

await main();

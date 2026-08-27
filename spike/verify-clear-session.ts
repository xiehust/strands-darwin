/**
 * `/clear` — starting a new session must not cost the old one.
 *
 * The runtime half of the command, proven by actually doing it: a real
 * `AgentRuntime` hands its conversation to a successor and everything the previous
 * session owns on disk has to still be there, byte for byte, and still resumable.
 *
 * Free by construction — no model call and no network. `AgentRuntime.create()`
 * builds the provider object lazily, so a session can be created, switched and shut
 * down without a request ever leaving the process. That is also the one thing this
 * check cannot show: a *recorded* trajectory turn needs a model call, so the "prior
 * bytes intact" assertion is made over a canary line this check writes into the
 * previous session's `trajectory.jsonl` itself, plus the snapshot the SDK's own
 * `SessionManager` writes. What is asserted about the record is therefore "nothing
 * touched these bytes", not "a turn was recorded"; the latter belongs to
 * `spike/verify-trajectory.ts`.
 *
 * The UI half — the cleared screen, the notice naming both ids, the header moving to
 * the new session — is `spike/verify-tui.ts clear`.
 *
 * Run: pnpm tsx spike/verify-clear-session.ts
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Message, TextBlock, type Agent } from '@strands-agents/sdk';

import { AgentRuntime } from '../src/agent/runtime.js';
import { allowAllBridge } from '../src/agent/permission.js';
import {
  hasSnapshot,
  isValidSessionId,
  sessionStateDir,
  snapshotPath,
  trajectoryPath,
  sessionPaths,
} from '../src/agent/session.js';
import { configPath } from '../src/config.js';
import { projectKey, projectMemoryDir } from '../src/paths.js';
import { createUserMemoryEntry, emptyMemoryState, renderMemoryIndex, writeMemoryState } from '../src/memory/state.js';

import type { BackgroundTaskStatus } from '../src/tools/background-bash.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

// Sessions, the resume pointer and the config fixture all resolve under HOME.
const OWNED_HOME = ownPrivateHome('clear-session');

const AGENT_ID = 'darwin';

/** Same private-field reach the `/model` suite uses: the Agent is not public API. */
function runtimeAgent(runtime: AgentRuntime): Agent {
  return (runtime as unknown as { agent: Agent }).agent;
}

/** A project root with two models configured, `opus` enabled. */
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-clear-'));
  await mkdir(path.join(root, '.darwin'), { recursive: true });
  await writeConfig('opus');
  return root;
}

async function writeConfig(enabled: 'opus' | 'sonnet'): Promise<void> {
  await writeFile(
    configPath(),
    JSON.stringify(
      {
        permissionMode: 'yolo',
        memory: true,
        models: [
          {
            enable: enabled === 'opus',
            name: 'opus',
            provider: 'bedrock',
            model: 'global.anthropic.claude-opus-5',
            region: 'us-west-2',
            maxTokens: 8192,
          },
          {
            enable: enabled === 'sonnet',
            name: 'sonnet',
            provider: 'bedrock',
            model: 'us.anthropic.claude-sonnet-4-6',
            region: 'us-west-2',
            maxTokens: 8192,
          },
        ],
      },
      null,
      2,
    ),
  );
}

function taskOf(tasks: readonly BackgroundTaskStatus[], id: string): BackgroundTaskStatus | undefined {
  return tasks.find((task) => task.taskId === id);
}

async function writeMemory(root: string, label: string): Promise<void> {
  const state = { ...emptyMemoryState(projectKey(root)), user: [createUserMemoryEntry(label)] };
  await writeMemoryState(root, state);
  await writeFile(path.join(projectMemoryDir(root), 'index.md'), renderMemoryIndex(state), 'utf8');
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}


async function main(): Promise<void> {
  header('/clear — the previous session survives, the new one starts empty');

  const root = await fixture();
  const lifecyclePidFile = path.join(root, 'lifecycle.pid');
  await writeFile(path.join(root, '.darwin', 'hooks.json'), JSON.stringify({
    TurnComplete: [{
      matcher: 'interactive',
      hooks: [{
        type: 'command',
        command: `trap '' TERM; sleep 30 & echo $! > ${lifecyclePidFile}; wait`,
      }],
    }],
  }));

  const memoryDirectory = projectMemoryDir(root);
  await mkdir(memoryDirectory, { recursive: true });
  await writeMemory(root, 'first-memory');
  const previousRuntime = await AgentRuntime.create({
    projectRoot: root,
    session: { kind: 'new' },
    permissionBridge: allowAllBridge,
  });
  let live = previousRuntime;
  const initialPrompt = JSON.stringify(runtimeAgent(live).systemPrompt);
  assert('a fresh runtime exposes memory tools without ambient archive injection',
    live.info.toolNames.includes('memory_recall') && live.info.toolNames.includes('memory_save') &&
    !initialPrompt.includes('first-memory') && !initialPrompt.includes('<learned-memory>'));
  const remembered = await live.manageMemory('/memory remember live-memory-note');
  const livePromptAfterRemember = JSON.stringify(runtimeAgent(live).systemPrompt);
  assert('/memory remember updates private state without changing the live prompt',
    remembered.changed && !livePromptAfterRemember.includes('live-memory-note'));
  const rememberedId = remembered.text.match(/user-[a-f0-9]+/)?.[0] ?? '';
  const forgotten = await live.manageMemory(`/memory forget ${rememberedId}`);
  const livePromptAfterForget = JSON.stringify(runtimeAgent(live).systemPrompt);
  assert('/memory forget narrows private state and still leaves the prompt unchanged',
    forgotten.changed && !livePromptAfterForget.includes('live-memory-note'));


  try {
    const previousId = live.info.sessionId;
    const previousAgent = runtimeAgent(live);

    // A conversation with something only this session could know, persisted exactly
    // the way the end of a turn persists it.
    previousAgent.messages.push(
      new Message({ role: 'user', content: [new TextBlock('ALPHA-marker-from-the-previous-session')] }),
    );
    await previousAgent.sessionManager?.saveSnapshot({ target: previousAgent, isLatest: true });
    const previousSnapshot = snapshotPath(root, previousId, AGENT_ID);
    const snapshotBefore = await readFile(previousSnapshot, 'utf8');
    assert('the previous session has a snapshot holding its own conversation', snapshotBefore.includes('ALPHA-marker'));

    // Canary bytes in the previous session's own state directory: one trajectory line
    // and one offloaded reference. Neither is a recorded turn (that needs a model
    // call) — they are here so "nothing rewrote, truncated or deleted this" is a
    // measurement rather than a claim.
    const previousTrajectory = trajectoryPath(root, previousId);
    const previousOffload = path.join(sessionStateDir(root, previousId), 'offload', 'ref-1.txt');
    await mkdir(path.dirname(previousOffload), { recursive: true });
    const trajectoryBytes = `{"type":"canary","note":"stands in for a recorded turn"}\n`;
    await writeFile(previousTrajectory, trajectoryBytes, 'utf8');
    await writeFile(previousOffload, 'offloaded-tool-result', 'utf8');
    const trajectoryStat = await stat(previousTrajectory);

    // A background job started through the real tool: it belongs to the process, so
    // `/clear` must neither stop it nor lose it. The task id comes back from the
    // runtime's own listing rather than from `invoke`, which answers with a
    // `ToolResultBlock` — this is the same reading `/tasks` makes.
    const bash = previousAgent.tool['bash'];
    if (bash === undefined) throw new Error('the bash tool is not registered');
    await bash.invoke({ mode: 'start', command: 'sleep 30' }, { recordDirectToolCall: false });
    const [started] = await live.listBackgroundTasks();
    if (started === undefined) throw new Error('the background job was not registered');
    assert('a background job is running before the switch', started.state === 'running');

    // A foreground command too, which spawns the vended tool's persistent shell for
    // *this* Agent (the tool keys shells per Agent in a WeakMap) and leaves a variable
    // in it, so what the successor's shell is can be measured rather than assumed.
    await bash.invoke(
      { mode: 'execute', command: 'CLEAR_SHELL_MARKER=alpha; echo marker=${CLEAR_SHELL_MARKER:-none}' },
      { recordDirectToolCall: false },
    );
    const previousShell = await bash.invoke(
      { mode: 'execute', command: 'echo marker=${CLEAR_SHELL_MARKER:-none}' },
      { recordDirectToolCall: false },
    );
    assert('the previous session has a persistent shell holding its state', JSON.stringify(previousShell).includes('marker=alpha'));
    previousRuntime.observeTurnComplete('success', 'interactive');
    assert('a previous-session lifecycle command starts', await waitFor(async () => {
      try { return (await readFile(lifecyclePidFile, 'utf8')).trim() !== ''; } catch { return false; }
    }));
    const lifecyclePid = Number((await readFile(lifecyclePidFile, 'utf8')).trim());


    // The file on disk now names a *different* model from the live one. A successor
    // that re-read it would silently move the session to another model.
    await writeConfig('sonnet');

    // A session-scoped `/mode` switch, made before the switch: the configured mode is
    // `yolo`, so a successor that restored startup policy would silently *widen*
    // enforcement behind a command whose whole promise is that it changes nothing but
    // the session.
    assert('the live mode starts from the configured one', live.permissionMode === 'yolo');
    live.changePermissionMode('plan');
    await writeMemory(root, 'current-memory');


    const next = await live.startNewSession();
    live = next;

    // ---- the new session ------------------------------------------------------
    assert('/clear retirement reaps the previous session lifecycle command tree', !processExists(lifecyclePid));

    assert('the new session id differs from the previous one', next.info.sessionId !== previousId);
    assert('…and is a valid session id', isValidSessionId(next.info.sessionId));
    assert('…and sorts after it, so recency order still holds', next.info.sessionId > previousId);
    const nextPrompt = JSON.stringify(runtimeAgent(next).systemPrompt);
    assert('/clear rebuilds memory tools without ambient archive injection',
      next.info.toolNames.includes('memory_recall') && next.info.toolNames.includes('memory_save') &&
      !nextPrompt.includes('current-memory') && !nextPrompt.includes('first-memory'));
    await writeMemory(root, 'resumed-memory');
    const resumed = await AgentRuntime.create({
      projectRoot: root,
      session: { kind: 'id', sessionId: previousId },
      permissionBridge: allowAllBridge,
    });
    const resumedPrompt = JSON.stringify(runtimeAgent(resumed).systemPrompt);
    assert('an explicitly resumed runtime keeps current memory on demand only',
      resumed.info.toolNames.includes('memory_recall') && resumed.info.toolNames.includes('memory_save') &&
      !resumedPrompt.includes('resumed-memory') && !resumedPrompt.includes('first-memory'));
    await resumed.shutdown();

    assert('the new session starts with no conversation', next.messageCount === 0);
    assert('…and is not reported as resumed', !next.info.resumed);
    assert('the new session has its own Agent', runtimeAgent(next) !== previousAgent);
    assert(
      '…and its own session manager, so the retired one can never claim the new snapshot',
      runtimeAgent(next).sessionManager !== previousAgent.sessionManager,
    );
    assert(
      'the record for the new session is a different file',
      next.info.trajectoryFile === trajectoryPath(root, next.info.sessionId),
    );
    assert('the usage meter starts at zero', next.usage.inputTokens === 0 && next.usage.outputTokens === 0);
    assert('…with no last-turn delta carried over', next.lastTurnUsage === undefined);
    assert('no subagent dispatch is carried over', next.listSubagentDispatches().length === 0);
    assert(
      'the live model is the one the session was using, not the one the file now names',
      next.config.model === 'global.anthropic.claude-opus-5',
    );
    assert(
      'MCP metadata is inherited rather than rediscovered',
      next.info.mcpServerCount === previousRuntime.info.mcpServerCount &&
        next.info.mcpConfigPath === previousRuntime.info.mcpConfigPath,
    );
    // The persistent shell is per-Agent by SDK design, so a new session cannot keep
    // the old one's shell state. Said out loud here because it is a user-visible
    // consequence of `/clear`: cwd and exported variables start over. The retired
    // shell itself is stopped by `retire()` — leaving it costs ~15 extra seconds of
    // process exit (measured), which is why it is reaped there and not left to Node.
    const nextBash = runtimeAgent(next).tool['bash'];
    if (nextBash === undefined) throw new Error('the bash tool is not registered on the successor');
    const nextShell = await nextBash.invoke(
      { mode: 'execute', command: 'echo marker=${CLEAR_SHELL_MARKER:-none}' },
      { recordDirectToolCall: false },
    );
    assert('the new session gets a fresh shell', JSON.stringify(nextShell).includes('marker=none'));
    assert('the new session inherits the live permission mode', next.permissionMode === 'plan');
    assert('…and reports it as its effective startup mode too', next.info.permissionMode === 'plan');
    assert(
      '…rather than re-reading the wider configured one',
      (JSON.parse(await readFile(configPath(), 'utf8')) as { permissionMode: string }).permissionMode === 'yolo',
    );

    // ---- the session that was left --------------------------------------------
    const snapshotAfter = await readFile(previousSnapshot, 'utf8');
    assert('the previous snapshot still holds its own conversation', snapshotAfter === snapshotBefore);
    assert('…and is still resumable by id', await hasSnapshot(root, previousId, AGENT_ID));
    assert(
      'the previous trajectory keeps its bytes',
      (await readFile(previousTrajectory, 'utf8')) === trajectoryBytes,
    );
    assert('…and its size, so nothing appended to it either', (await stat(previousTrajectory)).size === trajectoryStat.size);
    assert('the previous offloaded reference is untouched', (await readFile(previousOffload, 'utf8')) === 'offloaded-tool-result');
    assert(
      'the retired recorder closed cleanly rather than failing',
      previousRuntime.trajectoryStatus?.problem === undefined,
    );

    // The new session must not be able to overwrite the old one's snapshot: the
    // retired session manager's hooks are gone with its Agent, and this proves the
    // successor's own save lands somewhere else.
    const nextAgent = runtimeAgent(next);
    nextAgent.messages.push(
      new Message({ role: 'user', content: [new TextBlock('BETA-marker-from-the-new-session')] }),
    );
    await nextAgent.sessionManager?.saveSnapshot({ target: nextAgent, isLatest: true });
    const nextSnapshot = await readFile(snapshotPath(root, next.info.sessionId, AGENT_ID), 'utf8');
    assert('the new session writes its own snapshot', nextSnapshot.includes('BETA-marker'));
    const snapshotAfterBeta = await readFile(previousSnapshot, 'utf8');
    assert('…without touching the previous one', snapshotAfterBeta === snapshotBefore);
    assert('…which never learns about the new conversation', !snapshotAfterBeta.includes('BETA-marker'));

    // ---- the resume pointer ----------------------------------------------------
    // Deliberately not moved by the switch: an empty session has no snapshot to
    // resume, so claiming the pointer now would cost the user the conversation they
    // just set aside. The successor takes it on its first finished turn, which is
    // what `markResumable()` is called from.
    let pointerAfterClear: string | undefined;
    try {
      pointerAfterClear = await readFile(sessionPaths(root).pointerFile, 'utf8');
    } catch {
      pointerAfterClear = undefined;
    }
    assert('the switch itself writes no resume pointer', pointerAfterClear === undefined);
    await next.markResumable();
    const pointerAfterTurn = await readFile(sessionPaths(root).pointerFile, 'utf8');
    assert('a finished turn in the new session claims --resume', pointerAfterTurn.includes(next.info.sessionId));
    assert('…and only it', !pointerAfterTurn.includes(previousId));

    // ---- what the process still owns ------------------------------------------
    const inherited = await next.listBackgroundTasks();
    const job = taskOf(inherited, started.taskId);
    assert('the new session still lists the background job', job !== undefined);
    assert('…and it is still running', job?.state === 'running');
    assert(
      'its log stays in the directory of the session that started it',
      started.outputPath.startsWith(`${sessionStateDir(root, previousId)}${path.sep}`),
    );

    // One shutdown, on the live runtime, still reaps the inherited job: the retired
    // runtime deliberately left it alone, so nothing is orphaned.
    await next.shutdown();
    const afterShutdown = taskOf(await next.listBackgroundTasks(), started.taskId);
    assert('shutting the new session down stops the inherited job', afterShutdown?.state !== 'running');
  } finally {
    // `next.shutdown()` above is the live runtime's; a second call is idempotent
    // enough (its resources are already released) and covers an early failure.
    await live.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(OWNED_HOME, { recursive: true, force: true });
  }

  report();
}

await main();

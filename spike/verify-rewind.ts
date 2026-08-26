/** Offline SER-040 contracts: SDK-authoritative conversation branching, no provider/network. */
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  Model,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
  type StreamOptions,
  type Usage,
} from '@strands-agents/sdk';

import { allowAllBridge } from '../src/agent/permission.js';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import {
  MAX_REWIND_CHECKPOINTS,
  appendRewindCheckpoint,
  readRewindCatalogue,
  rewindCataloguePath,
} from '../src/agent/rewind.js';
import { sessionPaths, snapshotPath, trajectoryPath, writePointer } from '../src/agent/session.js';
import { configPath } from '../src/config.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

ownPrivateHome('rewind');
const AGENT_ID = 'darwin';

class RewindModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.rewind', contextWindowLimit: 200_000 };

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return { ...this.config };
  }

  override async *stream(
    messages: Message[],
    _options?: StreamOptions,
  ): AsyncIterable<ModelStreamEvent> {
    const prompt = messages.at(-1)?.content
      .map((block) => block.type === 'textBlock' ? block.text : '')
      .join('') ?? '';
    if (prompt === 'fail') throw new Error('scripted failure');
    const text = `answer:${prompt}`;
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    yield {
      type: 'modelMetadataEvent',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } satisfies Usage,
      metrics: { latencyMs: 1 },
    };
  }
}

async function consume(runtime: AgentRuntime, prompt: string): Promise<void> {
  for await (const _event of runtime.send(prompt)) { /* pass through */ }
}

async function bytes(file: string): Promise<Buffer | undefined> {
  try { return await readFile(file); } catch { return undefined; }
}

function immutableSnapshot(root: string, sessionId: string, snapshotId: string): Promise<Buffer> {
  return readFile(path.join(
    sessionPaths(root).sessionsDir,
    'session', sessionId, 'scopes', 'agent', AGENT_ID,
    'snapshots', 'immutable_history', `snapshot_${snapshotId}.json`,
  ));
}

async function treeBytes(root: string): Promise<Map<string, Buffer>> {
  const found = new Map<string, Buffer>();
  async function walk(directory: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) found.set(path.relative(root, absolute), await readFile(absolute));
    }
  }
  await walk(root);
  return found;
}

async function main(): Promise<void> {
  header('/rewind — bounded SDK checkpoints and source-preserving branch');
  const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-rewind-'));
  await mkdir(path.join(root, '.darwin'), { recursive: true });
  await writeFile(path.join(root, 'workspace.txt'), 'workspace-canary\n');
  await writeFile(configPath(), JSON.stringify({
    permissionMode: 'yolo',
    trajectory: false,
    memory: false,
    provider: 'bedrock',
    model: 'fake.rewind',
    region: 'us-west-2',
  }));

  const model = new RewindModel();
  setRuntimeModelFactoryForTest(async () => model);
  let source: AgentRuntime | undefined;
  let successor: AgentRuntime | undefined;
  try {
    source = await AgentRuntime.create({
      projectRoot: root,
      session: { kind: 'new' },
      permissionBridge: allowAllBridge,
    });
    const sourceId = source.info.sessionId;
    const workspaceBefore = await readFile(path.join(root, 'workspace.txt'));

    await consume(source, 'first');
    let catalogue = await source.listRewindCheckpoints();
    assert('trajectory:false still catalogues one completed initial boundary',
      catalogue.problem === undefined && catalogue.checkpoints.length === 1 && catalogue.checkpoints[0]?.prompt === 'first');
    const initialSnapshot = catalogue.checkpoints[0] === undefined
      ? undefined
      : JSON.parse((await immutableSnapshot(root, sourceId, catalogue.checkpoints[0].snapshotId)).toString('utf8')) as { data: { messages?: unknown[] } };
    const latestSnapshot = JSON.parse((await readFile(snapshotPath(root, sourceId, AGENT_ID), 'utf8'))) as { data: { messages?: unknown[] } };
    assert('the initial boundary is distinct from the post-turn latest snapshot',
      initialSnapshot?.data.messages?.length === 0 &&
      latestSnapshot.data.messages?.length === 2 && JSON.stringify(latestSnapshot.data.messages).includes('first'));
    assert('trajectory stays disabled rather than becoming rewind authority', await bytes(trajectoryPath(root, sourceId)) === undefined);

    await consume(source, 'second');
    catalogue = await source.listRewindCheckpoints();
    assert('a second completed prompt adds a pre-invocation checkpoint in newest-first order',
      catalogue.checkpoints.map((entry) => entry.prompt).join('|') === 'second|first');

    let failed = false;
    try { await consume(source, 'fail'); } catch { failed = true; }
    const afterFailure = await source.listRewindCheckpoints();
    assert('a failed turn creates no selectable completed boundary',
      failed && afterFailure.checkpoints.map((entry) => entry.prompt).join('|') === 'second|first');

    // Seed one session to 99 SDK snapshots, then race two public send() consumers.
    // The capture critical section must grant one final slot and deny the other.
    const concurrentRoot = await mkdtemp(path.join(os.tmpdir(), 'darwin-rewind-concurrent-'));
    await mkdir(path.join(concurrentRoot, '.darwin'), { recursive: true });
    const concurrent = await AgentRuntime.create({
      projectRoot: concurrentRoot,
      session: { kind: 'new' },
      permissionBridge: allowAllBridge,
    });
    try {
      const concurrentInternals = concurrent as unknown as {
        agent: unknown;
        sessionManager: {
          saveSnapshot(params: { target: unknown; isLatest: boolean }): Promise<void>;
          listSnapshotIds(params: { target: unknown; limit?: number }): Promise<string[]>;
        };
      };
      for (let index = 0; index < MAX_REWIND_CHECKPOINTS - 1; index += 1) {
        await concurrentInternals.sessionManager.saveSnapshot({
          target: concurrentInternals.agent,
          isLatest: false,
        });
      }
      await Promise.allSettled([consume(concurrent, 'fail'), consume(concurrent, 'fail')]);
      const concurrentIds = await concurrentInternals.sessionManager.listSnapshotIds({
        target: concurrentInternals.agent,
        limit: MAX_REWIND_CHECKPOINTS + 1,
      });
      assert('concurrent capture at the final slot cannot create snapshot 101',
        concurrentIds.length === MAX_REWIND_CHECKPOINTS);
    } finally {
      await concurrent.shutdown();
    }

    // The first two successes and first failure own three immutable snapshots. Fill
    // the remaining capacity with failures: eligibility and the hard disk bound are
    // separate, so none becomes selectable and no 101st snapshot may be created.
    for (let index = 3; index < MAX_REWIND_CHECKPOINTS; index += 1) {
      try { await consume(source, 'fail'); } catch { /* expected */ }
    }
    const internals = source as unknown as {
      agent: unknown;
      sessionManager: {
        listSnapshotIds(params: { target: unknown; limit?: number; startAfter?: string }): Promise<string[]>;
      };
    };
    const listSnapshotIds = internals.sessionManager.listSnapshotIds.bind(internals.sessionManager);
    const runtimeListLimits: Array<number | undefined> = [];
    internals.sessionManager.listSnapshotIds = async (params) => {
      runtimeListLimits.push(params.limit);
      return listSnapshotIds(params);
    };
    const atCapacity = await listSnapshotIds({
      target: internals.agent,
      limit: MAX_REWIND_CHECKPOINTS + 1,
    });
    let overflowFailed = false;
    try { await consume(source, 'fail'); } catch { overflowFailed = true; }
    const afterOverflowFailure = await listSnapshotIds({
      target: internals.agent,
      limit: MAX_REWIND_CHECKPOINTS + 1,
    });
    assert('repeated failed turns consume but never exceed the immutable snapshot capacity',
      overflowFailed && atCapacity.length === MAX_REWIND_CHECKPOINTS &&
      afterOverflowFailure.length === MAX_REWIND_CHECKPOINTS);
    assert('runtime capacity checks use only bounded public snapshot listings',
      runtimeListLimits.length > 0 && runtimeListLimits.every((limit) =>
        limit !== undefined && limit <= MAX_REWIND_CHECKPOINTS));

    runtimeListLimits.length = 0;
    await consume(source, 'after-capacity');
    const afterCapacitySuccess = await source.listRewindCheckpoints();
    const afterOrdinaryTurn = await listSnapshotIds({
      target: internals.agent,
      limit: MAX_REWIND_CHECKPOINTS + 1,
    });
    const latestAfterCapacity = await readFile(snapshotPath(root, sourceId, AGENT_ID), 'utf8');
    assert('full rewind capacity preserves an ordinary successful invocation and latest snapshot',
      afterOrdinaryTurn.length === MAX_REWIND_CHECKPOINTS &&
      afterCapacitySuccess.captureCapacityReached === true &&
      afterCapacitySuccess.checkpoints.map((entry) => entry.prompt).join('|') === 'second|first' &&
      latestAfterCapacity.includes('after-capacity'));
    assert('full-capacity success also uses only bounded public snapshot listings',
      runtimeListLimits.length > 0 && runtimeListLimits.every((limit) =>
        limit !== undefined && limit <= MAX_REWIND_CHECKPOINTS));

    const selected = afterCapacitySuccess.checkpoints.find((entry) => entry.prompt === 'second');
    if (selected === undefined) throw new Error('missing selected fixture');
    await source.markResumable();
    const pointerBefore = await readFile(sessionPaths(root).pointerFile);
    const sourceTreeBefore = await treeBytes(path.join(sessionPaths(root).sessionsDir, 'session', sourceId));
    const catalogueBefore = await readFile(rewindCataloguePath(root, sourceId));
    const workspaceStatBefore = await stat(path.join(root, 'workspace.txt'));

    successor = await source.startRewind(selected);
    source = undefined;
    const successorId = successor.info.sessionId;
    assert('rewind creates a fresh session id', successorId !== sourceId);
    const restoredMessages = (successor as unknown as { agent: { messages: Array<{ toJSON(): unknown }> } })
      .agent.messages.map((message) => message.toJSON());
    assert('selected checkpoint restores conversation before the selected prompt',
      restoredMessages.length === 2 &&
      !JSON.stringify(restoredMessages).includes('second') && JSON.stringify(restoredMessages).includes('first'));
    assert('the fresh successor has its own latest SDK snapshot', (await bytes(snapshotPath(root, successorId, AGENT_ID))) !== undefined);
    assert('resume pointer does not move before a successor turn',
      (await readFile(sessionPaths(root).pointerFile)).equals(pointerBefore));
    assert('source SDK latest and immutable snapshot tree remains byte-identical',
      equalTrees(sourceTreeBefore, await treeBytes(path.join(sessionPaths(root).sessionsDir, 'session', sourceId))));
    assert('source rewind catalogue remains byte-identical',
      (await readFile(rewindCataloguePath(root, sourceId))).equals(catalogueBefore));
    assert('workspace bytes and metadata remain unchanged',
      (await readFile(path.join(root, 'workspace.txt'))).equals(workspaceBefore) &&
      (await stat(path.join(root, 'workspace.txt'))).mtimeMs === workspaceStatBefore.mtimeMs);

    await consume(successor, 'branched');
    await successor.markResumable();
    assert('ordinary successor completion claims the resume pointer',
      (await readFile(sessionPaths(root).pointerFile, 'utf8')).includes(successorId));

    header('/rewind — catalogue bound and stale selection refusal');
    const catalogueRoot = await mkdtemp(path.join(os.tmpdir(), 'darwin-rewind-catalogue-'));
    const catalogueSession = 'session-bound';
    for (let index = 0; index < MAX_REWIND_CHECKPOINTS; index += 1) {
      await appendRewindCheckpoint(catalogueRoot, catalogueSession, {
        snapshotId: `snapshot-${index}`,
        prompt: `prompt-${index}`,
        completedAt: new Date(1_700_000_000_000 + index).toISOString(),
      });
    }
    const bounded = await readRewindCatalogue(catalogueRoot, catalogueSession);
    const unchanged = await readFile(rewindCataloguePath(catalogueRoot, catalogueSession));
    const overflow = await appendRewindCheckpoint(catalogueRoot, catalogueSession, {
      snapshotId: 'overflow', prompt: 'overflow', completedAt: new Date().toISOString(),
    });
    assert('catalogue stops at its hard entry bound',
      bounded.checkpoints.length === MAX_REWIND_CHECKPOINTS && bounded.capped && overflow.capped);
    assert('a full catalogue is not rewritten to make room',
      (await readFile(rewindCataloguePath(catalogueRoot, catalogueSession))).equals(unchanged));
  } finally {
    await successor?.shutdown();
    await source?.shutdown();
    setRuntimeModelFactoryForTest(undefined);
  }
}

function equalTrees(left: Map<string, Buffer>, right: Map<string, Buffer>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (!right.get(key)?.equals(value)) return false;
  return true;
}

await main();
report();

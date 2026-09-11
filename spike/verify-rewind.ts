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
import { loadRewindHistory } from '../src/trajectory/rewind-history.js';
import { refusalNotice, refusalNoticeWithRewind } from '../src/agent/refusal.js';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import {
  MAX_REWIND_CHECKPOINTS,
  appendRewindCheckpoint,
  readRewindCatalogue,
  rewindCataloguePath,
} from '../src/agent/rewind.js';
import { sessionPaths, snapshotPath, trajectoryPath, writePointer } from '../src/agent/session.js';
import { configPath } from '../src/config.js';
import { readTrajectory } from '../src/trajectory/reader.js';
import { parseRecordLine, rewindOriginOf, type RunStartedRecord } from '../src/trajectory/record.js';
import { formatReplay, replayRead } from '../src/trajectory/replay.js';
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
    // SRF-030: a refusal-class stop after partial text — the SDK loop ends normally
    // and appends the truncated assistant message, exactly as Bedrock's classifier
    // block arrives (`contentFiltered`).
    if (prompt === 'refuse') {
      yield { type: 'modelMessageStartEvent', role: 'assistant' };
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'I can help with' } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'contentFiltered' };
      return;
    }
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

    header('/rewind — a refusal-class stop catalogues its prompt; failed and cancelled turns still do not (SRF-030)');
    // The SDK ends a refused turn normally and appends both messages, so the checkpoint
    // captured before the prompt is the one boundary that removes the declined exchange.
    // `completed` keeps meaning `endTurn` for everything else (memory: verify-memory.ts;
    // terminal delivery: verify-task-wake.ts); only the catalogue call widens.
    const refusalRoot = await mkdtemp(path.join(os.tmpdir(), 'darwin-rewind-refusal-'));
    await mkdir(path.join(refusalRoot, '.darwin'), { recursive: true });
    let refusalSource: AgentRuntime | undefined = await AgentRuntime.create({
      projectRoot: refusalRoot,
      session: { kind: 'new' },
      permissionBridge: allowAllBridge,
    });
    let refusalSuccessor: AgentRuntime | undefined;
    const messagesOf = (runtime: AgentRuntime): unknown[] =>
      (runtime as unknown as { agent: { messages: Array<{ toJSON(): unknown }> } }).agent.messages.map((message) => message.toJSON());
    try {
      await consume(refusalSource, 'first');
      const refusalStops: string[] = [];
      for await (const event of refusalSource.send('refuse')) {
        if (event.type === 'agentResultEvent') refusalStops.push(event.result.stopReason);
      }
      const afterRefusalMessages = messagesOf(refusalSource);
      assert('the refused turn ended the SDK loop normally with both messages appended and the partial text kept',
        refusalStops.join('|') === 'contentFiltered' && afterRefusalMessages.length === 4 &&
        JSON.stringify(afterRefusalMessages.at(-1)).includes('I can help with'));
      const afterRefusal = await refusalSource.listRewindCheckpoints();
      assert('a refusal-class stop catalogues its prompt beside the endTurn one, newest first',
        afterRefusal.problem === undefined && afterRefusal.checkpoints.map((entry) => entry.prompt).join('|') === 'refuse|first');

      let threw = false;
      try { await consume(refusalSource, 'fail'); } catch { threw = true; }
      const cancelStops: string[] = [];
      for await (const event of refusalSource.send('cancel-me')) {
        if (event.type === 'agentResultEvent') cancelStops.push(event.result.stopReason);
        else refusalSource.cancel();
      }
      const afterFailAndCancel = await refusalSource.listRewindCheckpoints();
      assert('a thrown model error and a cancelled turn still catalogue nothing',
        threw && cancelStops.join('|') === 'cancelled' &&
        afterFailAndCancel.checkpoints.map((entry) => entry.prompt).join('|') === 'refuse|first');

      const refused = afterFailAndCancel.checkpoints.find((entry) => entry.prompt === 'refuse');
      if (refused === undefined) throw new Error('missing refused fixture checkpoint');
      refusalSuccessor = await refusalSource.startRewind(refused);
      refusalSource = undefined;
      const restored = JSON.stringify(messagesOf(refusalSuccessor));
      assert('rewinding to the refused prompt restores the conversation before it — the declined reply is gone',
        messagesOf(refusalSuccessor).length === 2 && restored.includes('answer:first') &&
        !restored.includes('refuse') && !restored.includes('I can help with'));
      assert('the selected row hands the exact refused prompt back to the editor unsent',
        refused.prompt === 'refuse' && !restored.includes('cancel-me'));
      await consume(refusalSuccessor, 'rephrased');
      const continued = JSON.stringify(messagesOf(refusalSuccessor));
      assert('the successor continues from the restored boundary with its own catalogue',
        messagesOf(refusalSuccessor).length === 4 && continued.includes('answer:rephrased') && !continued.includes('I can help with') &&
        (await refusalSuccessor.listRewindCheckpoints()).checkpoints.map((entry) => entry.prompt).join('|') === 'rephrased');
    } finally {
      await refusalSuccessor?.shutdown();
      await refusalSource?.shutdown();
    }

    header('/rewind — the TUI refusal notice names the remedy; headless keeps the base line (SRF-030)');
    // One source for the text: the TUI variant is composed from the shared base line, so
    // headless stderr (pinned byte for byte in verify-headless.ts) cannot drift from it.
    const base = refusalNotice('contentFiltered');
    assert('the TUI notice is the shared base line plus one appended remedy clause',
      refusalNoticeWithRewind('contentFiltered') ===
        `${base} — the declined reply stays in the conversation; /rewind to this prompt removes it before you rephrase` &&
      base === 'model declined this request (stop_reason: contentFiltered) — rephrase it or start a new turn');
    const appSource = await readFile(new URL('../src/tui/App.tsx', import.meta.url), 'utf8');
    const headlessSource = await readFile(new URL('../src/headless.ts', import.meta.url), 'utf8');
    assert('App.tsx dispatches the rewind variant and never the bare line; headless.ts prints the bare line only',
      appSource.includes('refusalNoticeWithRewind(event.result.stopReason)') && !appSource.includes('text: refusalNotice(') &&
      headlessSource.includes('refusalNotice(refused)') && !headlessSource.includes('refusalNoticeWithRewind'));

    header('/rewind — the successor\u2019s trajectory names its origin; the source record is untouched (SRF-028)');
    // The same factory and the same fake model, with trajectory recording on this
    // time: the successor's first record must explain its restored count itself.
    await writeFile(configPath(), JSON.stringify({
      permissionMode: 'yolo',
      memory: false,
      provider: 'bedrock',
      model: 'fake.rewind',
      region: 'us-west-2',
    }));
    const recordedRoot = await mkdtemp(path.join(os.tmpdir(), 'darwin-rewind-recorded-'));
    await mkdir(path.join(recordedRoot, '.darwin'), { recursive: true });
    let recordedSource: AgentRuntime | undefined = await AgentRuntime.create({
      projectRoot: recordedRoot,
      session: { kind: 'new' },
      permissionBridge: allowAllBridge,
    });
    let recordedSuccessor: AgentRuntime | undefined;
    let resumedSuccessor: AgentRuntime | undefined;
    let cleared: AgentRuntime | undefined;
    try {
      const recordedSourceId = recordedSource.info.sessionId;
      await consume(recordedSource, 'first');
      await consume(recordedSource, 'second');
      const sourceCheckpoint = (await recordedSource.listRewindCheckpoints()).checkpoints.find((entry) => entry.prompt === 'second');
      if (sourceCheckpoint === undefined) throw new Error('missing recorded fixture checkpoint');
      const sourceTrajectoryBefore = await readFile(trajectoryPath(recordedRoot, recordedSourceId));
      const sourceHeader = parseRecordLine(sourceTrajectoryBefore.toString('utf8').split('\n')[0] ?? '') as RunStartedRecord;
      assert('a fresh session\u2019s own header carries no rewindFrom key',
        sourceHeader.type === 'runStarted' && !('rewindFrom' in sourceHeader) &&
        !sourceTrajectoryBefore.toString('utf8').includes('rewindFrom'));

      recordedSuccessor = await recordedSource.startRewind(sourceCheckpoint);
      recordedSource = undefined;
      assert('the runtime records the real trajectory turn on the checkpoint', sourceCheckpoint.trajectoryTurn === 2);
      const rewoundHistory = await loadRewindHistory(recordedRoot, recordedSourceId, sourceCheckpoint);
      assert('real-runtime rewind history contains only the exchange before the selected prompt',
        rewoundHistory.some((item) => item.kind === 'user' && item.text === 'first') &&
        rewoundHistory.some((item) => item.kind === 'assistant') &&
        !rewoundHistory.some((item) => item.kind === 'user' && item.text === 'second'));
      const recordedSuccessorId = recordedSuccessor.info.sessionId;
      assert('the successor has written nothing yet — its record appears with its first turn',
        (await bytes(trajectoryPath(recordedRoot, recordedSuccessorId))) === undefined);
      await consume(recordedSuccessor, 'branched');
      const successorRead = await readTrajectory(trajectoryPath(recordedRoot, recordedSuccessorId));
      const successorHeader = successorRead.records[0] as RunStartedRecord;
      assert('the successor\u2019s first record is its runStarted',
        successorHeader?.type === 'runStarted' && successorHeader.seq === 0);
      assert('it names the source session and the selected snapshot id, exactly as startRewind passed them',
        JSON.stringify(rewindOriginOf(successorHeader.rewindFrom)) ===
          JSON.stringify({ session: recordedSourceId, snapshotId: sourceCheckpoint.snapshotId }));
      assert('resumed/restoredMessages keep their meaning: a successor is a fresh run with the checkpoint\u2019s two messages',
        successorHeader.resumed === false && successorHeader.restoredMessages === 2 &&
        successorHeader.session === recordedSuccessorId);
      assert('the source trajectory is byte-identical after the branch and the successor\u2019s turn',
        (await readFile(trajectoryPath(recordedRoot, recordedSourceId))).equals(sourceTrajectoryBefore));
      const successorTranscript = formatReplay(replayRead(successorRead)).split('\n');
      assert('replay prints the origin on the successor\u2019s one run header line, then the branched prompt',
        successorTranscript[0]?.endsWith(`· bedrock/fake.rewind · rewound from ${recordedSourceId} snapshot ${sourceCheckpoint.snapshotId}`) === true &&
        successorTranscript[1] === 'you> branched');
      const sourceTranscript = formatReplay(replayRead(await readTrajectory(trajectoryPath(recordedRoot, recordedSourceId))));
      assert('the source\u2019s replay header is unchanged — no origin, nothing rewound',
        !sourceTranscript.includes('rewound from'));

      // A later `--resume <successor>` is an ordinary resumed run: its own header says
      // `resumed`, and the origin stays on the first run's header only.
      await recordedSuccessor.markResumable();
      await recordedSuccessor.shutdown();
      recordedSuccessor = undefined;
      resumedSuccessor = await AgentRuntime.create({
        projectRoot: recordedRoot,
        session: { kind: 'id', sessionId: recordedSuccessorId },
        permissionBridge: allowAllBridge,
      });
      await consume(resumedSuccessor, 'after-resume');
      const resumedCheckpoint = (await resumedSuccessor.listRewindCheckpoints()).checkpoints.find((entry) => entry.prompt === 'after-resume');
      assert('a resumed runtime associates the checkpoint with the continued trajectory ordinal', resumedCheckpoint?.trajectoryTurn === 2);
      const resumedRead = await readTrajectory(trajectoryPath(recordedRoot, recordedSuccessorId));
      const headers = resumedRead.records.filter((record): record is RunStartedRecord => record.type === 'runStarted');
      assert('resuming the successor appends a second header that is resumed and carries no origin',
        headers.length === 2 && headers[1]?.resumed === true && headers[1].restoredMessages === 4 &&
        !('rewindFrom' in headers[1]) && rewindOriginOf(headers[0]?.rewindFrom) !== undefined);
      const resumedTranscript = formatReplay(replayRead(resumedRead)).split('\n');
      assert('the two run headers read: rewound-from on the first, resumed on the second',
        resumedTranscript[0]?.includes('rewound from') === true && resumedTranscript[1]?.endsWith(' · resumed') === true);

      // `/clear` is the other successor path through the same factory: no origin either.
      cleared = await resumedSuccessor.startNewSession();
      resumedSuccessor = undefined;
      await consume(cleared, 'after-clear');
      const clearedHeader = (await readTrajectory(trajectoryPath(recordedRoot, cleared.info.sessionId))).records[0] as RunStartedRecord;
      assert('a /clear successor\u2019s header is a fresh run with no rewindFrom key',
        clearedHeader?.type === 'runStarted' && clearedHeader.resumed === false &&
        clearedHeader.restoredMessages === 0 && !('rewindFrom' in clearedHeader));
    } finally {
      await cleared?.shutdown();
      await resumedSuccessor?.shutdown();
      await recordedSuccessor?.shutdown();
      await recordedSource?.shutdown();
    }
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

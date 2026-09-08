/**
 * SER-083 — `/tangent`: a bookmark-and-return gesture over the rewind machinery.
 *
 * Free suite: no provider, no network. Two halves, one contract:
 *
 * 1. The pure state machine in `src/tui/tangent.ts`, over typed catalogue fixtures
 *    of the shape `AgentRuntime.listRewindCheckpoints()` returns (newest first):
 *    arm → capture from a grown catalogue → discarded count from a later one →
 *    every notice; the ineligible/failed/capped captures end with their reason;
 *    the command table (toggle/start/end in each phase, nested start refused);
 *    the `/status` row value and header suffix; the editor draft rule.
 *
 * 2. The same gesture over a real `AgentRuntime` with the fake model
 *    `verify-rewind.ts` uses: arm after one completed prompt, send A (its
 *    checkpoint becomes the return point), send B and C, return through the
 *    runtime's own `startRewind(returnPoint)` — the successor's conversation is the
 *    state before A (the `verify-rewind.ts` assertion style), the source catalogue
 *    is byte-identical, and the return hands back no draft. Count semantics: A, B
 *    and C were three catalogued prompts inside the tangent, so the notice says
 *    `3 prompts discarded` — the return prompt is discarded with the rest.
 *
 * Run: pnpm tsx spike/verify-tangent.ts
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
import { rewindCataloguePath, type RewindCatalogue, type RewindCheckpoint } from '../src/agent/rewind.js';
import { configPath } from '../src/config.js';
import { BUILTIN_COMMAND_NAMES, builtinCommandDescription } from '../src/commands/custom-commands.js';
import { MAX_HELP_COMMANDS } from '../src/tui/help-format.js';
import { MAX_COMPLETIONS } from '../src/tui/InputBox.js';
import { refusesToQueue } from '../src/tui/prompt-queue.js';
import {
  TANGENT_COMMAND_USAGE,
  TANGENT_TUI_ONLY_NOTICE,
  armTangent,
  captureReturnPoint,
  discardedPromptCount,
  parseTangentCommand,
  rewindDraftAfterBranch,
  tangentCommandOutcome,
  tangentEndedByNotice,
  tangentHeaderSuffix,
  tangentReturnNotice,
  tangentStatusFact,
  type ActiveTangent,
  type ArmedTangent,
} from '../src/tui/tangent.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

ownPrivateHome('tangent');

function checkpoint(index: number): RewindCheckpoint {
  return {
    snapshotId: `snapshot-${index}`,
    prompt: `prompt-${index}`,
    completedAt: new Date(1_700_000_000_000 + index).toISOString(),
  };
}

/** Newest first, as the runtime lists them: `count` completed prompts. */
function catalogueOf(count: number, extra: Partial<RewindCatalogue> = {}): RewindCatalogue {
  const checkpoints: RewindCheckpoint[] = [];
  for (let index = count; index >= 1; index -= 1) checkpoints.push(checkpoint(index));
  return { checkpoints, capped: false, captureCapacityReached: false, ...extra };
}

const COMPLETED = { image: false, sessionOriginated: false, completed: true } as const;

function pureStateMachine(): void {
  header('/tangent — command grammar and reservation');
  assert('bare /tangent toggles, start arms, end returns or disarms',
    parseTangentCommand('/tangent') === 'toggle' && parseTangentCommand('/tangent start') === 'start' &&
    parseTangentCommand('/tangent end') === 'end' && parseTangentCommand('/tangent  end ') === 'end');
  assert('any other argument is the local usage notice; other commands are not /tangent',
    parseTangentCommand('/tangent now') === 'usage' && parseTangentCommand('/tangential thought') === undefined &&
    parseTangentCommand('tangent') === undefined && TANGENT_COMMAND_USAGE.startsWith('/tangent takes no arguments'));
  assert('tangent is a reserved built-in with a one-phrase description, listed alphabetically',
    (BUILTIN_COMMAND_NAMES as readonly string[]).includes('tangent') &&
    BUILTIN_COMMAND_NAMES.indexOf('tangent') === BUILTIN_COMMAND_NAMES.indexOf('status') + 1 &&
    BUILTIN_COMMAND_NAMES.indexOf('tasks') === BUILTIN_COMMAND_NAMES.indexOf('tangent') + 1 &&
    builtinCommandDescription('tangent') === 'branch a side conversation, /tangent again returns');
  assert('the completion and help caps keep every built-in visible after the addition',
    MAX_COMPLETIONS >= BUILTIN_COMMAND_NAMES.length && MAX_HELP_COMMANDS >= BUILTIN_COMMAND_NAMES.length);
  assert('/tangent refuses to queue while busy, like /rewind; a prompt starting with the word does not',
    refusesToQueue('/tangent') && refusesToQueue('/tangent end') && !refusesToQueue('tangent: explain'));
  assert('the dev REPL notice names the driver boundary', TANGENT_TUI_ONLY_NOTICE === '/tangent is a TUI command');

  header('/tangent — arm, capture, discard count, notices');
  const armedOutcome = armTangent(catalogueOf(1));
  assert('arming records the catalogue baseline and says the next prompt starts it',
    armedOutcome.kind === 'armed' && armedOutcome.state.phase === 'armed' && armedOutcome.state.baseline === 1 &&
    armedOutcome.notice === 'tangent armed — the next prompt starts it; /tangent again returns to the conversation as it is now');
  const armed: ArmedTangent = { phase: 'armed', baseline: 1 };
  const capped = armTangent(catalogueOf(1, { captureCapacityReached: true }));
  assert('arming at rewind capture capacity is refused up front',
    capped.kind === 'refused' && capped.notice.includes('rewind checkpoint capacity reached'));
  const damaged = armTangent(catalogueOf(0, { problem: 'catalogue is not valid JSON' }));
  assert('an unreadable catalogue refuses to arm and names the problem',
    damaged.kind === 'refused' && damaged.notice === 'tangent unavailable: catalogue is not valid JSON');

  const started = captureReturnPoint(armed, catalogueOf(2), COMPLETED);
  assert('the first completed prompt after arming captures the newest checkpoint as the return point',
    started.kind === 'started' && started.state.phase === 'active' && started.state.since === 2 &&
    started.state.baseline === 1 && started.state.returnPoint.snapshotId === 'snapshot-2' &&
    started.state.returnPoint.prompt === 'prompt-2');
  assert('the started notice names the prompt ordinal',
    started.kind === 'started' && started.notice === 'tangent started — since prompt 2; /tangent again returns there');
  const active: ActiveTangent = started.kind === 'started' ? started.state : { phase: 'active', baseline: 1, since: 2, returnPoint: checkpoint(2) };

  assert('the discarded count is the catalogue delta since arming, return prompt included',
    discardedPromptCount(active, catalogueOf(2)) === 1 && discardedPromptCount(active, catalogueOf(4)) === 3);
  assert('an unreadable catalogue at return time falls back to what the state proves',
    discardedPromptCount(active, undefined) === 1 &&
    discardedPromptCount(active, catalogueOf(0, { problem: 'gone' })) === 1);
  assert('the return notice pluralizes: 1 prompt, 3 prompts',
    tangentReturnNotice(1) === 'returned from tangent — 1 prompt discarded' &&
    tangentReturnNotice(3) === 'returned from tangent — 3 prompts discarded');
  assert('/clear and /rewind end a tangent with one notice each',
    tangentEndedByNotice('/clear') === 'tangent ended by /clear' && tangentEndedByNotice('/rewind') === 'tangent ended by /rewind');

  header('/tangent — captures that cannot start a tangent end it with the reason');
  const unchanged = catalogueOf(1);
  const withImage = captureReturnPoint(armed, unchanged, { ...COMPLETED, image: true });
  assert('an image-carrying prompt ends the tangent: no text-only checkpoint exists',
    withImage.kind === 'ended' && withImage.notice === 'tangent not started — no return point could be captured (an image was attached)');
  const wake = captureReturnPoint(armed, unchanged, { ...COMPLETED, sessionOriginated: true });
  assert('a background-task wake ends the tangent', wake.kind === 'ended' && wake.notice.includes('background-task wake'));
  const failed = captureReturnPoint(armed, unchanged, { ...COMPLETED, completed: false });
  assert('a failed or cancelled turn ends the tangent',
    failed.kind === 'ended' && failed.notice.includes('the turn failed or was cancelled'));
  const atCapacity = captureReturnPoint(armed, catalogueOf(1, { captureCapacityReached: true }), COMPLETED);
  assert('capture capacity reached during the prompt ends the tangent',
    atCapacity.kind === 'ended' && atCapacity.notice.includes('rewind checkpoint capacity reached'));
  const notCatalogued = captureReturnPoint(armed, unchanged, COMPLETED);
  assert('a completed prompt that catalogued nothing ends the tangent with the generic reason',
    notCatalogued.kind === 'ended' && notCatalogued.notice.endsWith('(no checkpoint was catalogued for the prompt)'));
  const unreadable = captureReturnPoint(armed, catalogueOf(0, { problem: 'could not read rewind checkpoints: EIO' }), COMPLETED);
  assert('an unreadable catalogue ends the tangent with the read problem',
    unreadable.kind === 'ended' && unreadable.notice.includes('could not read rewind checkpoints: EIO'));

  header('/tangent — the command table in each phase');
  const idleToggle = tangentCommandOutcome(undefined, 'toggle');
  const idleStart = tangentCommandOutcome(undefined, 'start');
  const idleEnd = tangentCommandOutcome(undefined, 'end');
  assert('not in a tangent: /tangent and /tangent start arm; /tangent end is a notice',
    idleToggle.action === 'arm' && idleStart.action === 'arm' &&
    idleEnd.action === 'notice' && idleEnd.notice === 'not in a tangent — /tangent starts one');
  const armedToggle = tangentCommandOutcome(armed, 'toggle');
  const armedStart = tangentCommandOutcome(armed, 'start');
  const armedEnd = tangentCommandOutcome(armed, 'end');
  assert('armed, before the first prompt: /tangent is a notice, /tangent end disarms',
    armedToggle.action === 'notice' && armedToggle.notice === 'tangent armed — send a prompt to start it, or /tangent end to cancel' &&
    armedStart.action === 'notice' && armedStart.notice === armedToggle.notice &&
    armedEnd.action === 'disarm' && armedEnd.notice === 'tangent disarmed — no prompt had started it');
  const activeToggle = tangentCommandOutcome(active, 'toggle');
  const activeEnd = tangentCommandOutcome(active, 'end');
  const nested = tangentCommandOutcome(active, 'start');
  assert('active: /tangent and /tangent end return to the captured point',
    activeToggle.action === 'return' && activeToggle.state === active &&
    activeEnd.action === 'return' && activeEnd.state === active);
  assert('active: a nested /tangent start is refused and names the return prompt',
    nested.action === 'notice' && nested.notice === 'already in a tangent — /tangent again returns to prompt 2');

  header('/tangent — projections: /status row, header suffix, editor draft');
  assert('the /status tangent value is absent, the armed phrase, or `since prompt N`',
    tangentStatusFact(undefined) === undefined &&
    tangentStatusFact(armed) === 'armed — the next prompt starts it' &&
    tangentStatusFact(active) === 'since prompt 2');
  assert('the header suffix rides the existing state word and is empty otherwise',
    tangentHeaderSuffix(undefined) === '' && tangentHeaderSuffix(armed) === ' · tangent armed' &&
    tangentHeaderSuffix(active) === ' · tangent since prompt 2');
  assert('/rewind hands the selected prompt back; a tangent return hands back nothing',
    rewindDraftAfterBranch('rewind', 'prompt-2') === 'prompt-2' && rewindDraftAfterBranch('tangent', 'prompt-2') === '');
}

class TangentModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.tangent', contextWindowLimit: 200_000 };

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return { ...this.config };
  }

  override async *stream(messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const prompt = messages.at(-1)?.content
      .map((block) => block.type === 'textBlock' ? block.text : '')
      .join('') ?? '';
    if (prompt === 'fail') throw new Error('scripted failure');
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: `answer:${prompt}` } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    yield {
      type: 'modelMetadataEvent',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } satisfies Usage,
      metrics: { latencyMs: 1 },
    };
  }
}

async function consume(runtime: AgentRuntime, prompt: string): Promise<boolean> {
  try {
    for await (const _event of runtime.send(prompt)) { /* pass through */ }
    return true;
  } catch {
    return false;
  }
}

function messagesOf(runtime: AgentRuntime): unknown[] {
  return (runtime as unknown as { agent: { messages: Array<{ toJSON(): unknown }> } })
    .agent.messages.map((message) => message.toJSON());
}

async function runtimeProof(): Promise<void> {
  header('/tangent — arm, three prompts inside, return through startRewind (real AgentRuntime, fake model)');
  const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-tangent-'));
  await mkdir(path.join(root, '.darwin'), { recursive: true });
  await writeFile(configPath(), JSON.stringify({
    permissionMode: 'yolo',
    trajectory: false,
    memory: false,
    provider: 'bedrock',
    model: 'fake.tangent',
    region: 'us-west-2',
  }));
  setRuntimeModelFactoryForTest(async () => new TangentModel());
  let source: AgentRuntime | undefined;
  let successor: AgentRuntime | undefined;
  try {
    source = await AgentRuntime.create({
      projectRoot: root,
      session: { kind: 'new' },
      permissionBridge: allowAllBridge,
    });
    const sourceId = source.info.sessionId;
    await consume(source, 'before');

    // A failed first prompt while armed: the catalogue does not grow, the tangent
    // ends with the reason, and the same arm can be repeated afterwards.
    const firstArm = armTangent(await source.listRewindCheckpoints());
    assert('arming after one completed prompt sets baseline 1', firstArm.kind === 'armed' && firstArm.state.baseline === 1);
    if (firstArm.kind !== 'armed') throw new Error('arm fixture failed');
    const failedTurn = await consume(source, 'fail');
    const failedCapture = captureReturnPoint(firstArm.state, await source.listRewindCheckpoints(), {
      ...COMPLETED, completed: failedTurn,
    });
    assert('a failed first prompt ends the tangent — the runtime catalogued no boundary for it',
      !failedTurn && failedCapture.kind === 'ended' && failedCapture.notice.includes('the turn failed or was cancelled'));

    const arm = armTangent(await source.listRewindCheckpoints());
    if (arm.kind !== 'armed') throw new Error('arm fixture failed');
    // The state the return must restore: everything up to here, the failed `fail`
    // prompt's own user message included — a rewind restores the SDK snapshot as it
    // was, it does not tidy the conversation.
    const beforeA = JSON.stringify(messagesOf(source));
    const beforeALength = messagesOf(source).length;
    await consume(source, 'A');
    const capture = captureReturnPoint(arm.state, await source.listRewindCheckpoints(), COMPLETED);
    assert('prompt A\u2019s pre-invocation checkpoint becomes the return point (since prompt 2)',
      capture.kind === 'started' && capture.state.since === 2 && capture.state.returnPoint.prompt === 'A');
    if (capture.kind !== 'started') throw new Error('capture fixture failed');
    const active = capture.state;

    await consume(source, 'B');
    await consume(source, 'C');
    const atReturn = await source.listRewindCheckpoints();
    const discarded = discardedPromptCount(active, atReturn);
    assert('A, B and C are the three catalogued prompts inside the tangent',
      atReturn.checkpoints.map((entry) => entry.prompt).join('|') === 'C|B|A|before' && discarded === 3);
    assert('the notice says 3 prompts discarded', tangentReturnNotice(discarded) === 'returned from tangent — 3 prompts discarded');
    assert('the runtime path refuses a nested start while active',
      tangentCommandOutcome(active, 'start').action === 'notice' && tangentCommandOutcome(active, 'toggle').action === 'return');

    const catalogueBefore = await readFile(rewindCataloguePath(root, sourceId));
    successor = await source.startRewind(active.returnPoint);
    source = undefined;
    assert('the return creates a fresh session through the rewind path', successor.info.sessionId !== sourceId);
    const restored = messagesOf(successor);
    assert('the successor\u2019s conversation is the state before A: byte-equal to the pre-A messages, nothing from A, B or C',
      restored.length === beforeALength && JSON.stringify(restored) === beforeA &&
      JSON.stringify(restored).includes('answer:before') &&
      !JSON.stringify(restored).includes('answer:A') && !JSON.stringify(restored).includes('answer:B') &&
      !JSON.stringify(restored).includes('"C"'));
    assert('the source rewind catalogue is byte-identical after the return',
      (await readFile(rewindCataloguePath(root, sourceId))).equals(catalogueBefore));
    assert('no draft is handed back for a tangent return', rewindDraftAfterBranch('tangent', active.returnPoint.prompt) === '');

    // A stale row — the source's return point handed to the successor — is the
    // rewind path's own refusal; nothing about the successor changes.
    let staleError: string | undefined;
    try {
      await successor.startRewind(active.returnPoint);
    } catch (error) {
      staleError = error instanceof Error ? error.message : String(error);
    }
    assert('a stale return point is refused by startRewind itself, so the TUI keeps the tangent armed',
      staleError !== undefined && successor.info.sessionId !== sourceId && messagesOf(successor).length === beforeALength);
  } finally {
    await successor?.shutdown();
    await source?.shutdown();
    setRuntimeModelFactoryForTest(undefined);
  }
}

pureStateMachine();
await runtimeProof();
report();

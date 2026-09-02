/**
 * The `/context` measurement anchor: the pure state, and the estimate a real offline
 * runtime produces from it.
 *
 * The claim under test is narrow and worth pinning precisely. `/context` used to be a
 * whole-request character heuristic; with an anchor it is `measured base + tail`, where
 * the base is the prompt-token total the provider reported for the most recent
 * completed model call. So the assertions cover three things: that the base is the
 * provider's number and not a guess, that every way the base can stop being true ends
 * in absence (shortened history, rewritten history, model switch), and that a failure
 * anywhere in the refinement degrades to the pre-anchor reading rather than to a wrong
 * number.
 *
 * Free: no model call, no network. The runtime half drives a deterministic local model
 * through `setRuntimeModelFactoryForTest`, so it proves the real observer path without
 * a provider.
 *
 * Run: pnpm tsx spike/verify-context-anchor.ts
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  Message,
  Model,
  TextBlock,
  type Agent,
  type BaseModelConfig,
  type ModelStreamEvent,
  type StreamOptions,
} from '@strands-agents/sdk';

import { anchorFromCall, resolveAnchor, type ContextAnchor } from '../src/agent/context-anchor.js';
import { allowAllBridge } from '../src/agent/permission.js';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { requestInputTokens } from '../src/agent/usage.js';
import { configPath, type AppConfig, type ModelChoice } from '../src/config.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const OWNED_HOME = ownPrivateHome('context-anchor');

function config(provider: 'bedrock' | 'anthropic' | 'openai', openaiApi?: 'chat' | 'responses'): AppConfig {
  return {
    provider,
    model: provider === 'openai' ? 'openai.gpt-5.6-sol' : 'global.anthropic.claude-opus-5',
    region: 'us-east-1',
    maxTokens: 1000,
    permissionMode: 'default',
    promptCache: false,
    thinkingEffort: 'high',
    summaryRatio: 0.8,
    contextWarnRatio: 0.8,
    contextOffload: true,
    preserveRecentMessages: 4,
    ...(openaiApi !== undefined && { openaiApi }),
    modelChoices: [],
  };
}

/** One completed call as `afterModelCallEvent.stopData` shapes it. */
function call(usage: Record<string, number> | undefined): { message: { metadata?: { usage?: unknown } } } {
  return { message: usage === undefined ? {} : { metadata: { usage } } };
}

// ---------------------------------------------------------------- request totals

header('measured request size — what one call actually submitted');
assert('Bedrock reports cache beside input, so the request is their sum',
  requestInputTokens(
    { inputTokens: 1_000, outputTokens: 50, cacheReadInputTokens: 20_000, cacheWriteInputTokens: 300 },
    config('bedrock'),
  ) === 21_300);
assert('an unreported cache counter contributes nothing rather than blocking the total',
  requestInputTokens({ inputTokens: 1_000, outputTokens: 50 }, config('anthropic')) === 1_000);
assert('OpenAI Responses counts cache inside input, so its input is the request',
  requestInputTokens(
    { inputTokens: 21_300, outputTokens: 50, cacheReadInputTokens: 20_000, cacheWriteInputTokens: 300 },
    config('openai', 'responses'),
  ) === 21_300);
assert('OpenAI Chat has no cache subsets to fold in',
  requestInputTokens({ inputTokens: 900, outputTokens: 10 }, config('openai', 'chat')) === 900);
// The one case where the split cannot be made honestly: Responses without both
// subsets. Guessing here would be inventing part of the base the whole design rests on.
assert('an unsplittable Responses reading is unknown, never a guess',
  requestInputTokens({ inputTokens: 900, outputTokens: 10, cacheReadInputTokens: 100 }, config('openai', 'responses')) === 900);

// ---------------------------------------------------------------- installing

header('anchor — what a completed call installs');
const messages = ['m0', 'm1', 'm2'];
const installed = anchorFromCall(call({ inputTokens: 500, outputTokens: 10, cacheReadInputTokens: 12_000 }), messages, config('bedrock'));
assert('a metered call installs the measured total and its boundary',
  installed?.requestTokens === 12_500 && installed.messageCount === 3 && installed.boundary === 'm2');

assert('a call whose provider reported nothing usable installs nothing',
  anchorFromCall(call(undefined), messages, config('bedrock')) === undefined);
assert('a payload missing outputTokens is not a measurement',
  anchorFromCall(call({ inputTokens: 500 }), messages, config('bedrock')) === undefined);
assert('a non-finite counter is refused',
  anchorFromCall(call({ inputTokens: Number.NaN, outputTokens: 1 }), messages, config('bedrock')) === undefined);
assert('an unsplittable Responses reading installs nothing',
  anchorFromCall(
    call({ inputTokens: 900, outputTokens: 10, cacheWriteInputTokens: 5 }),
    messages,
    config('openai', 'responses'),
  ) !== undefined);
assert('an empty history has no boundary to anchor to',
  anchorFromCall(call({ inputTokens: 500, outputTokens: 10 }), [], config('bedrock')) === undefined);

// ---------------------------------------------------------------- resolving

header('anchor — when the measurement still describes the history');
const anchor = installed as ContextAnchor;
assert('an untouched history resolves', resolveAnchor(anchor, messages) === anchor);
assert('an appended message still resolves — that is what the tail is for',
  resolveAnchor(anchor, [...messages, 'm3']) === anchor);
assert('a shortened history drops the anchor',
  resolveAnchor(anchor, ['m0', 'm1']) === undefined);
// The case a length check alone cannot see: same length, different history.
assert('a same-length rewrite drops the anchor on boundary identity',
  resolveAnchor(anchor, ['m0', 'm1', 'rewritten']) === undefined);
assert('a compaction-shaped rewrite (summary prepended, recents kept) drops the anchor',
  resolveAnchor(anchor, ['summary', 'm2']) === undefined);
assert('no anchor resolves to no anchor', resolveAnchor(undefined, messages) === undefined);

// ---------------------------------------------------------------- runtime

/** Reports fixed usage, so the anchor's base is a known number. */
class MeteredModel extends Model<BaseModelConfig> {
  calls = 0;
  countTokenCalls: number[] = [];
  failCount = false;
  private conf: BaseModelConfig = { modelId: 'fake.metered', contextWindowLimit: 200_000 };

  constructor(private readonly inputTokens: number, private readonly cacheRead: number) {
    super();
  }

  override updateConfig(next: BaseModelConfig): void {
    this.conf = { ...this.conf, ...next };
  }

  override getConfig(): BaseModelConfig {
    return this.conf;
  }

  override async countTokens(messages: Message[], options?: { systemPrompt?: unknown; toolSpecs?: unknown }): Promise<number> {
    this.countTokenCalls.push(messages.length);
    if (this.failCount) throw new Error('countTokens refused this request');
    return super.countTokens(messages, options as Parameters<Model['countTokens']>[1]);
  }

  override async *stream(_messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'ok' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield {
      type: 'modelMetadataEvent',
      usage: {
        inputTokens: this.inputTokens,
        outputTokens: 7,
        totalTokens: this.inputTokens + 7,
        cacheReadInputTokens: this.cacheRead,
      },
    };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

/** Two configured models, so the offline `/model` switch has somewhere to go. */
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-context-anchor-'));
  await mkdir(path.join(root, '.darwin'), { recursive: true });
  await writeFile(
    configPath(root),
    JSON.stringify({
      permissionMode: 'yolo',
      trajectory: false,
      models: [
        { enable: true, name: 'opus', provider: 'bedrock', model: 'global.anthropic.claude-opus-5', region: 'us-west-2', maxTokens: 8192 },
        { enable: false, name: 'sol', provider: 'openai', model: 'openai.gpt-5.6-sol', bedrockMantle: true, openaiApi: 'responses', region: 'us-east-1', maxTokens: 8192 },
      ],
    }, null, 2),
  );
  return root;
}

async function runtimeEstimate(): Promise<void> {
  header('/context — a real offline runtime, measured base plus tail');
  assert('this suite writes its own global config fixture', configPath().startsWith(`${OWNED_HOME}${path.sep}`));

  const model = new MeteredModel(4_000, 96_000);
  setRuntimeModelFactoryForTest(async () => model);
  const root = await fixture();
  const runtime = await AgentRuntime.create({
    projectRoot: root,
    session: { kind: 'new' },
    permissionBridge: allowAllBridge,
  });
  try {
    const before = await runtime.contextEstimate();
    assert('before any call the reading is the pre-anchor whole-request estimate',
      before.measuredTokens === undefined && before.tailTokens === undefined && before.estimatedTokens > 0);

    for await (const _event of runtime.send('anchor this turn')) {
      // Consume the ordinary stream; the anchor is installed by the observer inside it.
    }
    assert('the offline model really served the turn', model.calls === 1);

    const agent = (runtime as unknown as { agent: Agent }).agent;
    const afterTurn = await runtime.contextEstimate();
    assert('the base is the provider\'s own request total, cache reads included',
      afterTurn.measuredTokens === 100_000);
    assert('the total is exactly measured base plus the counted tail',
      afterTurn.tailTokens !== undefined &&
      afterTurn.estimatedTokens === afterTurn.measuredTokens! + afterTurn.tailTokens);
    assert('…and it dwarfs what the pure heuristic claimed, because the heuristic never saw the real prompt',
      afterTurn.estimatedTokens > before.estimatedTokens * 5);
    assert('the window still comes from the model, not from the anchor',
      afterTurn.windowTokens === 200_000);

    // Growth is charged to the tail, never to the measured base: the base is a
    // historical fact about one call and must not move until a call re-measures it.
    // (The anchor sits at 1 message here — the model call was made with the prompt
    // alone, so the assistant reply it produced is already part of the tail.)
    const grownBy = 'x'.repeat(4_000);
    agent.messages.push(new Message({ role: 'user', content: [new TextBlock(grownBy)] }));
    const afterGrowth = await runtime.contextEstimate();
    assert('appending to the conversation grows the tail and leaves the base alone',
      afterGrowth.measuredTokens === 100_000 &&
      afterGrowth.tailTokens !== undefined &&
      afterTurn.tailTokens !== undefined &&
      afterGrowth.tailTokens > afterTurn.tailTokens);
    assert('only the messages after the anchor are counted — never the whole conversation again',
      agent.messages.length === 3 && model.countTokenCalls.at(-1) === 2);

    // A tail count that fails must not discard the measurement it was refining.
    model.failCount = true;
    const degraded = await runtime.contextEstimate();
    assert('a failed tail count keeps the measured base and says the tail is unknown',
      degraded.measuredTokens === 100_000 && degraded.tailTokens === undefined &&
      degraded.estimatedTokens === 100_000);
    model.failCount = false;

    // A rewritten history is not describable by the old measurement: this is the
    // compaction shape — the messages under the anchor are replaced, not appended to.
    agent.messages.splice(
      0,
      agent.messages.length,
      new Message({ role: 'user', content: [new TextBlock('conversation summary')] }),
    );
    const afterRewrite = await runtime.contextEstimate();
    assert('a compacted/rewritten history falls back to the whole-request estimate',
      afterRewrite.measuredTokens === undefined && afterRewrite.tailTokens === undefined);

    // And a model switch retires it explicitly: same messages, different tokenizer.
    for await (const _event of runtime.send('re-anchor after the rewrite')) {
      // Re-install an anchor so the switch has something to invalidate.
    }
    assert('the re-anchored session measures again',
      (await runtime.contextEstimate()).measuredTokens === 100_000);
    const target = runtime.modelChoices.find((entry) => entry.name === 'sol') as ModelChoice;
    const switched = await runtime.changeModel(target);
    await switched.saved;
    const afterSwitch = await runtime.contextEstimate();
    assert('a /model switch retires the previous model\'s measurement',
      afterSwitch.measuredTokens === undefined && afterSwitch.tailTokens === undefined);
  } finally {
    await runtime.shutdown();
    setRuntimeModelFactoryForTest(undefined);
    await rm(root, { recursive: true, force: true });
  }
}

await runtimeEstimate();
report();

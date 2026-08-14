/**
 * Live proof that the effort fields are accepted and actually change behaviour.
 *
 * The offline suite (`verify-thinking.ts`) proves the right JSON is built. Only a
 * real request can settle the two things that matter beyond that: Bedrock accepts
 * `thinking: adaptive` + `output_config` (a misplaced `effort` is a
 * `ValidationException`, not a warning), and the level is not silently ignored —
 * `high` must actually produce reasoning content.
 *
 * Reasoning is asserted only for the level Anthropic documents as "always thinks".
 * At `low` the model is free to skip thinking, so requiring its absence would be
 * asserting on a judgement call the model is allowed to make either way; the
 * request is only required to succeed.
 *
 * Not part `pnpm test` (it makes model calls).
 * Run: AWS_REGION=us-west-2 pnpm tsx spike/verify-thinking-live.ts
 */
import { BedrockModel, Message, TextBlock } from '@strands-agents/sdk';

import { planThinking, type ThinkingEffort } from '../src/agent/thinking.js';
import {
  createModelFromConfig,
  withSoleChoice,
  type AppConfig,
} from '../src/config.js';
import { assert, header, report, REGION } from './shared.js';

/**
 * Sonnet 4.6 rather than the shared Haiku id: adaptive thinking needs Claude 4.6
 * or later, and this account has the `us.` profile for it.
 */
const CONFIG: AppConfig = withSoleChoice({
  provider: 'bedrock',
  model: process.env['SPIKE_THINKING_MODEL_ID'] ?? 'us.anthropic.claude-sonnet-4-6',
  region: REGION,
  // Room for a real reasoning block plus the answer. Thinking tokens are billed as
  // output, so a tight budget would truncate the turn rather than the thought.
  maxTokens: 4096,
  summaryRatio: 0.3,
  preserveRecentMessages: 10,
  permissionMode: 'default',
  // Off: a single sub-1k-token request can never clear the minimum cacheable
  // prefix, and this check is about thinking, not caching.
  promptCache: false,
  thinkingEffort: 'high',
});

/** Multi-step enough that a thinking model has something to think about. */
const PROMPT =
  'Alan is directly left of Bob, and Bob is directly left of Colin, in a circle of exactly ' +
  'three people. Who is directly left of Alan? Answer with one name.';

interface TurnOutcome {
  reasoned: boolean;
  text: string;
  failure: string | undefined;
}

/** Runs one request at `effort` and reports whether reasoning came back. */
async function runAt(effort: ThinkingEffort): Promise<TurnOutcome> {
  const plan = planThinking(CONFIG, effort);
  assert(`${effort} is sent as-is to ${CONFIG.model}`, plan.effective === effort);

  const model = await createModelFromConfig({ ...CONFIG, thinkingEffort: effort });
  const message = new Message({ role: 'user', content: [new TextBlock(PROMPT)] });

  let reasoned = false;
  let text = '';
  try {
    for await (const event of model.stream([message])) {
      if (event.type !== 'modelContentBlockDeltaEvent') continue;
      if (event.delta.type === 'reasoningContentDelta') reasoned = true;
      if (event.delta.type === 'textDelta') text += event.delta.text;
    }
  } catch (error) {
    // A ValidationException here is the failure this whole module exists to
    // prevent, so it is reported rather than thrown: the tally is the result.
    return { reasoned, text, failure: error instanceof Error ? error.message : String(error) };
  }
  return { reasoned, text, failure: undefined };
}

async function main(): Promise<void> {
  header(`thinking live — ${CONFIG.model} in ${REGION}`);

  // Sanity check that the fields are really on the wire: if this ever stops being
  // true, a passing reasoning assertion below would prove nothing about our code.
  const configured = await createModelFromConfig(CONFIG);
  assert('the model built for this run is a BedrockModel', configured instanceof BedrockModel);
  const fields = (configured.getConfig() as { additionalRequestFields?: Record<string, unknown> })
    .additionalRequestFields;
  console.log(`  request fields: ${JSON.stringify(fields)}`);

  const high = await runAt('high');
  console.log(`  high: reasoned=${high.reasoned} answer=${JSON.stringify(high.text.trim().slice(0, 120))}`);
  if (high.failure !== undefined) console.log(`  high failed: ${high.failure}`);

  // The one assertion that a misplaced `effort` key would fail.
  assert('a request with adaptive thinking is accepted', high.failure === undefined);
  assert('high effort actually produces reasoning', high.reasoned);
  assert('and an answer as well as the reasoning', high.text.trim() !== '');

  const low = await runAt('low');
  console.log(`  low: reasoned=${low.reasoned} answer=${JSON.stringify(low.text.trim().slice(0, 120))}`);
  if (low.failure !== undefined) console.log(`  low failed: ${low.failure}`);
  assert('a low-effort request is accepted too', low.failure === undefined);
  assert('…and still answers', low.text.trim() !== '');

  await effortMatrix();
  report();
}

/**
 * Re-measures which levels each model actually accepts, because this is the one
 * thing in the feature that documentation got wrong.
 *
 * The AWS page says `xhigh` and `max` are both Opus-only. In us-west-2, Sonnet 4.6
 * accepts `max` and rejects only `xhigh` — so a table built from the page would
 * clamp `max` needlessly, and one built from a guess about a pre-4.6 model would
 * send `output_config` to a model that refuses the whole object. The planner's
 * decisions come from this table, so the table is what gets verified.
 *
 * Fields are built by hand here on purpose: going through `planThinking` could not
 * produce the rejected requests, which is exactly what has to be observed.
 */
async function effortMatrix(): Promise<void> {
  header('thinking live — which levels each model really accepts');

  /** `true` = the service must accept it, `false` = it must reject it. */
  const expected: readonly {
    modelId: string;
    accepts: Readonly<Partial<Record<ThinkingEffort, boolean>>>;
  }[] = [
    {
      modelId: 'us.anthropic.claude-sonnet-4-6',
      // The interesting row: max yes, xhigh no.
      accepts: { low: true, medium: true, high: true, xhigh: false, max: true },
    },
    {
      modelId: 'global.anthropic.claude-opus-5',
      accepts: { high: true, xhigh: true, max: true },
    },
    {
      // Pre-4.6: refuses `output_config` outright, which is why planThinking sends
      // no thinking fields at all for these rather than a lower level.
      modelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      accepts: { low: false, high: false },
    },
  ];

  for (const { modelId, accepts } of expected) {
    for (const [effort, shouldWork] of Object.entries(accepts) as [ThinkingEffort, boolean][]) {
      const failure = await probe(modelId, effort);
      const verdict = failure === undefined ? 'accepted' : `rejected (${failure.slice(0, 90)})`;
      console.log(`  ${modelId} @ ${effort}: ${verdict}`);
      assert(
        `${modelId} ${shouldWork ? 'accepts' : 'rejects'} ${effort}`,
        (failure === undefined) === shouldWork,
      );

      // Cross-check the planner against what was just measured: a table that has
      // drifted from the service is the failure this whole script exists to catch.
      const plan = planThinking({ ...CONFIG, model: modelId }, effort);
      const planned = plan.enabled && plan.effective === effort;
      assert(`…and the planner ${shouldWork ? 'sends' : 'avoids'} it`, planned === shouldWork);
    }
  }
}

/** Sends one hand-built request, returning the rejection message or undefined. */
async function probe(modelId: string, effort: ThinkingEffort): Promise<string | undefined> {
  const model = new BedrockModel({
    region: REGION,
    modelId,
    maxTokens: 1024,
    additionalRequestFields: { thinking: { type: 'adaptive' }, output_config: { effort } },
  });
  const message = new Message({ role: 'user', content: [new TextBlock('Reply with the single word: ready')] });

  try {
    // Drained rather than broken out of: a rejection can arrive mid-stream.
    for await (const _event of model.stream([message])) void _event;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

await main();

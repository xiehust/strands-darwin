/**
 * Measures what Bedrock Mantle actually accepts for an `openai.*` model: which
 * `api` mode works, which reasoning-effort spelling and levels are taken, and
 * whether `maxTokens` reaches the model.
 *
 * This is the script behind the Mantle tables in
 * `.trellis/spec/backend/strands-sdk-contracts.md` and in `src/agent/thinking.ts`.
 * Measured rather than read for the same reason as `verify-thinking-live.ts`: an
 * unsupported field is rejected per-request, so guessing wrong breaks every turn
 * rather than degrading. Every case prints PASS/FAIL with the service's own
 * message — the tally *is* the result, so nothing here throws.
 *
 * Run: AWS_REGION=us-east-1 pnpm tsx spike/probe-mantle.ts [modelId]
 */
import { Message, TextBlock } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';

const MODEL_ID = process.argv[2] ?? 'openai.gpt-5.6-sol';
const REGION = process.env['AWS_REGION'] ?? 'us-east-1';

/** Multi-step enough that a reasoning model emits reasoning when it means to. */
const PROMPT =
  'Alan is directly left of Bob, and Bob is directly left of Colin, in a circle of exactly ' +
  'three people. Who is directly left of Alan? Answer with one name.';

async function ask(label: string, options: Record<string, unknown>): Promise<void> {
  try {
    const model = new OpenAIModel({
      modelId: MODEL_ID,
      bedrockMantleConfig: { region: REGION },
      ...options,
    } as never);
    const message = new Message({ role: 'user', content: [new TextBlock(PROMPT)] });

    let reasoned = false;
    let text = '';
    for await (const event of model.stream([message])) {
      if (event.type !== 'modelContentBlockDeltaEvent') continue;
      if (event.delta.type === 'reasoningContentDelta') reasoned = true;
      if (event.delta.type === 'textDelta') text += event.delta.text;
    }
    console.log(`  PASS ${label} → reasoned=${reasoned} text=${JSON.stringify(text.trim().slice(0, 40))}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  FAIL ${label} → ${message.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
}

console.log(`model=${MODEL_ID} region=${REGION}\n`);

console.log('[1] api mode (no reasoning params)');
await ask("api:'responses'", { api: 'responses' });
await ask("api:'chat'", { api: 'chat' });

console.log("\n[2] flat reasoning_effort — the Chat Completions spelling");
for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
  await ask(`reasoning_effort=${effort}`, { api: 'responses', params: { reasoning_effort: effort } });
}

console.log("\n[3] nested reasoning.effort — the Responses spelling");
for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
  await ask(`reasoning:{effort:${effort}}`, { api: 'responses', params: { reasoning: { effort } } });
}

console.log('\n[3b] can a reasoning summary reach the stream at all?');
await ask('reasoning:{effort:high,summary:auto}', {
  api: 'responses',
  params: { reasoning: { effort: 'high', summary: 'auto' } },
});
await ask('reasoning:{effort:high,summary:detailed}', {
  api: 'responses',
  params: { reasoning: { effort: 'high', summary: 'detailed' } },
});

console.log('\n[4] maxTokens reaches the model (16 must truncate the answer away)');
await ask('maxTokens=64000', { api: 'responses', maxTokens: 64000 });
await ask('maxTokens=16', { api: 'responses', maxTokens: 16 });

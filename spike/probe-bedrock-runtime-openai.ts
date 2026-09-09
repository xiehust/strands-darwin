/**
 * Measures what the Bedrock *runtime* endpoint's OpenAI-compatible surface
 * (`https://bedrock-runtime.{region}.amazonaws.com/openai/v1`) accepts for a
 * cross-region OpenAI inference profile such as `global.openai.gpt-6-astra`:
 * which `api` mode works, which reasoning-effort spelling and levels are taken,
 * and whether `maxTokens` reaches the model.
 *
 * The runtime sibling of `probe-mantle.ts`. Mantle is a separate endpoint with
 * its own per-model base path and in-region pricing; the runtime endpoint takes
 * `us.`/`global.` profiles at cross-region prices and the same short-term bearer
 * token (`@aws/bedrock-token-generator`). This is the script behind the
 * `bedrockRuntime` config field. Measured rather than read, like every probe
 * here: an unsupported field is rejected per request, so guessing wrong breaks
 * every turn. Every case prints PASS/FAIL with the service's own message — the
 * tally *is* the result, so nothing here throws.
 *
 * Run: AWS_REGION=us-west-2 pnpm tsx spike/probe-bedrock-runtime-openai.ts [modelId]
 */
import { getTokenProvider } from '@aws/bedrock-token-generator';
import { Message, TextBlock } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';

const MODEL_ID = process.argv[2] ?? 'global.openai.gpt-6-astra';
const REGION = process.env['AWS_REGION'] ?? 'us-west-2';
const BASE_URL = `https://bedrock-runtime.${REGION}.amazonaws.com/openai/v1`;

/** Multi-step enough that a reasoning model emits reasoning when it means to. */
const PROMPT =
  'Alan is directly left of Bob, and Bob is directly left of Colin, in a circle of exactly ' +
  'three people. Who is directly left of Alan? Answer with one name.';

const provideToken = getTokenProvider({ region: REGION });

async function ask(label: string, options: Record<string, unknown>): Promise<void> {
  try {
    const model = new OpenAIModel({
      modelId: MODEL_ID,
      apiKey: async () => provideToken(),
      clientConfig: { baseURL: BASE_URL },
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

console.log(`model=${MODEL_ID} region=${REGION} baseURL=${BASE_URL}\n`);

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

console.log('\n[4] maxTokens reaches the model (16 must truncate the answer away)');
await ask('maxTokens=64000', { api: 'responses', maxTokens: 64000 });
await ask('maxTokens=16', { api: 'responses', maxTokens: 16 });

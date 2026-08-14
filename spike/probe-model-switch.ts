/**
 * Probes whether a conversation survives being handed to a different provider
 * mid-session — the one fact `/model` cannot be built without.
 *
 * `Agent.model` is a mutable property, so swapping it is cheap and keeps
 * `agent.messages`. The risk is the *content*: a Claude turn leaves reasoning
 * blocks and Bedrock-shaped toolUse/toolResult pairs in the history, and an
 * OpenAI Responses request has to translate all of it. Whether that translation
 * works is measured here rather than assumed, because the failure mode is a
 * 400 on the first turn after the switch — i.e. a `/model` that bricks the
 * session it was supposed to continue.
 *
 * Run: pnpm tsx spike/probe-model-switch.ts
 */
import { Agent, BedrockModel } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import { bash } from '@strands-agents/sdk/vended-tools/bash';

const CLAUDE = 'global.anthropic.claude-opus-5';
const SOL = 'openai.gpt-5.6-sol';

function claudeModel(): BedrockModel {
  return new BedrockModel({
    region: 'us-west-2',
    modelId: CLAUDE,
    maxTokens: 8192,
    additionalRequestFields: { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } },
  });
}

function solModel(): OpenAIModel {
  return new OpenAIModel({
    api: 'responses',
    modelId: SOL,
    maxTokens: 8192,
    bedrockMantleConfig: { region: 'us-east-1' },
    params: { reasoning: { effort: 'high' } },
  } as never);
}

/** Runs one turn, returning the text or the failure. */
async function turn(agent: Agent, prompt: string): Promise<string> {
  try {
    let text = '';
    for await (const event of agent.stream(prompt)) {
      if (
        event.type === 'modelStreamUpdateEvent' &&
        event.event.type === 'modelContentBlockDeltaEvent' &&
        event.event.delta.type === 'textDelta'
      ) {
        text += event.event.delta.text;
      }
    }
    return `ok: ${text.trim().replace(/\s+/g, ' ').slice(0, 80)}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `FAILED: ${message.replace(/\s+/g, ' ').slice(0, 260)}`;
  }
}

/** Counts what kinds of content blocks the history is carrying. */
function historyShape(agent: Agent): string {
  const kinds = new Map<string, number>();
  for (const message of agent.messages) {
    for (const block of message.content) {
      const kind = (block as { type?: string }).type ?? 'unknown';
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
  }
  return `${agent.messages.length} messages, blocks: ${JSON.stringify(Object.fromEntries(kinds))}`;
}

async function direction(label: string, from: () => Agent['model'], to: () => Agent['model']): Promise<void> {
  console.log(`\n=== ${label} ===`);
  const agent = new Agent({ model: from(), tools: [bash], printer: false });
  await agent.initialize();

  // A tool call on purpose: it is the toolUse/toolResult pair (and any reasoning
  // block beside it) that has to survive the translation, not plain text.
  console.log(`  turn 1 (before switch): ${await turn(agent, 'Run "echo marker-7" with bash and tell me its output.')}`);
  console.log(`  history: ${historyShape(agent)}`);

  agent.model = to();
  console.log(`  → swapped agent.model`);

  console.log(`  turn 2 (after switch) : ${await turn(agent, 'What exactly did that command print? Quote it.')}`);
  console.log(`  turn 3 (tool again)   : ${await turn(agent, 'Now run "echo marker-8" and tell me its output.')}`);
  console.log(`  history: ${historyShape(agent)}`);
}

await direction(`${CLAUDE} → ${SOL}`, claudeModel, solModel);
await direction(`${SOL} → ${CLAUDE}`, solModel, claudeModel);

// The last unknown: darwin rewrites the system prompt to `[TextBlock,
// CachePointBlock]` at startup when the model can cache. That block is still
// there after a switch to a provider that cannot — and it is darwin's own doing,
// so if it breaks the request, `/model` has to strip it.
console.log(`\n=== a system-prompt cache point, then ${CLAUDE} → ${SOL} ===`);
{
  const { TextBlock, CachePointBlock } = await import('@strands-agents/sdk');
  const agent = new Agent({
    model: claudeModel(),
    tools: [bash],
    printer: false,
    systemPrompt: 'You are a terse assistant. Answer in as few words as possible.',
  });
  await agent.initialize();
  agent.systemPrompt = [
    new TextBlock(agent.systemPrompt as string),
    new CachePointBlock({ cacheType: 'default' }),
  ];
  console.log(`  turn 1 (claude, cache point set): ${await turn(agent, 'Say ready.')}`);
  agent.model = solModel();
  console.log(`  → swapped agent.model, cache point left in place`);
  console.log(`  turn 2 (sol, cache point still there): ${await turn(agent, 'Say ready again.')}`);
}
console.log(`\n=== reasoning in history, then ${CLAUDE} → ${SOL} ===`);
{
  const agent = new Agent({ model: claudeModel(), tools: [bash], printer: false });
  await agent.initialize();
  console.log(
    `  turn 1 (a puzzle, to force thinking): ${await turn(
      agent,
      'Alan is directly left of Bob, and Bob is directly left of Colin, in a circle of exactly three ' +
        'people. Who is directly left of Alan? Think it through, then answer with one name.',
    )}`,
  );
  console.log(`  history: ${historyShape(agent)}`);
  agent.model = solModel();
  console.log(`  → swapped agent.model`);
  console.log(`  turn 2 (after switch): ${await turn(agent, 'Which name did you answer? One word.')}`);
  console.log(`  history: ${historyShape(agent)}`);
}

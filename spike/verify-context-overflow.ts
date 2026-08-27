/** Offline regressions for provider classification and restored oversized tool results. */
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import {
  Agent,
  ContextWindowOverflowError,
  Message,
  Model,
  ModelError,
  SessionManager,
  SummarizingConversationManager,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  type BaseModelConfig,
  type ModelStreamEvent,
} from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import { LocalFileStorage } from '@strands-agents/sdk/storage';
import { ContextOffloader } from '@strands-agents/sdk/vended-plugins/context-offloader';
import type OpenAI from 'openai';

import { contextOverflowErrorMessage, CONTEXT_OVERFLOW_ERROR_LIMIT } from '../src/context-overflow-error.js';
import { failureFromError } from '../src/trajectory/record.js';
import { assert, header, report } from './shared.js';

const INCIDENT_MESSAGE =
  'prompt tokens (1416135) exceed model maximum (1050000) for openai.gpt-5.6-sol';
const GENERIC_MESSAGE =
  'prompt tokens (1416135) exceed deployment maximum (1050000) for openai.gpt-5.6-sol';

function fakeResponsesClient(error: Error): OpenAI {
  return {
    responses: {
      create: async () => {
        throw error;
      },
    },
  } as unknown as OpenAI;
}

async function captureModelError(source: ModelError): Promise<unknown> {
  const model = new OpenAIModel({
    api: 'responses',
    modelId: 'openai.gpt-5.6-sol',
    client: fakeResponsesClient(source),
  });
  const input = [new Message({ role: 'user', content: [new TextBlock('continue')] })];

  try {
    const stream = model.streamAggregated(input);
    while (!(await stream.next()).done) {
      // The fake rejects before yielding; draining exercises the public Responses path.
    }
  } catch (error) {
    return error;
  }
  throw new Error('fake OpenAI Responses call unexpectedly succeeded');
}

header('context overflow — OpenAI Responses classifier');

const incidentSource = new ModelError(INCIDENT_MESSAGE);
const overflow = await captureModelError(incidentSource);
assert(
  'exact Mantle exceed-model-maximum incident becomes ContextWindowOverflowError',
  overflow instanceof ContextWindowOverflowError && overflow.message === INCIDENT_MESSAGE,
);

const genericSource = new ModelError(GENERIC_MESSAGE);
const generic = await captureModelError(genericSource);
assert(
  'nearby generic provider ModelError remains unchanged',
  generic === genericSource &&
    generic instanceof ModelError &&
    !(generic instanceof ContextWindowOverflowError) &&
    generic.message === GENERIC_MESSAGE,
);


const ROOT = '/tmp/darwin-context-overflow-test';
const SESSION_ID = 'legacy-overflow';
const AGENT_ID = 'legacy-agent';
const LEGACY_PAYLOAD = `legacy-original:${'Z'.repeat(40_000)}`;

class CaptureModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.restore-overflow', contextWindowLimit: 2_000 };
  calls = 0;
  seen: Message[] = [];

  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }

  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    this.seen = messages.map((message) => message.clone());
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'bounded resume ok' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

class CountFailureModel extends CaptureModel {
  counts = 0;

  override async countTokens(): Promise<number> {
    this.counts += 1;
    throw new Error('fixture token count unavailable');
  }
}

class AlwaysOverflowModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.unrecoverable-overflow', contextWindowLimit: 2_000 };
  calls = 0;

  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    throw new ContextWindowOverflowError(INCIDENT_MESSAGE);
  }
}

function sessionManager(storage: LocalFileStorage): SessionManager {
  return new SessionManager({ sessionId: SESSION_ID, storage, saveLatestOn: 'invocation' });
}

function legacyMessages(): Message[] {
  return [
    new Message({
      role: 'user',
      trackingId: randomUUID(),
      content: [new TextBlock('keep this legacy user request')],
    }),
    new Message({
      role: 'assistant',
      trackingId: randomUUID(),
      content: [new ToolUseBlock({ name: 'legacyTool', toolUseId: 'legacy-tool-use', input: {} })],
    }),
    new Message({
      role: 'user',
      trackingId: randomUUID(),
      content: [new ToolResultBlock({
        toolUseId: 'legacy-tool-use',
        status: 'success',
        content: [new TextBlock(LEGACY_PAYLOAD)],
      })],
    }),
  ];
}

function resultText(messages: readonly Message[]): string {
  return messages.flatMap((message) => message.content.flatMap((block) =>
    block instanceof ToolResultBlock
      ? block.content.flatMap((content) => content instanceof TextBlock ? [content.text] : [])
      : [],
  )).join('\n');
}

function resultBlock(messages: readonly Message[]): ToolResultBlock {
  const found = messages.flatMap((message) => message.content)
    .find((block): block is ToolResultBlock => block instanceof ToolResultBlock);
  if (found === undefined) throw new Error('fixture tool result missing');
  return found;
}

function offloader(storage: LocalFileStorage): ContextOffloader {
  return new ContextOffloader({
    storage,
    maxResultTokens: 200,
    previewTokens: 50,
    evictAfterCycles: null,
  });
}

header('context overflow — restored protected recent result is repaired before provider assembly');
await rm(ROOT, { recursive: true, force: true });
const storage = new LocalFileStorage(ROOT);
const seeded = new Agent({
  id: AGENT_ID,
  model: new CaptureModel(),
  messages: legacyMessages(),
  sessionManager: sessionManager(storage),
  printer: false,
});
await seeded.initialize();
const originalTrackingIds = seeded.messages.map((message) => message.trackingId);
await seeded.sessionManager!.saveSnapshot({ target: seeded, isLatest: true });

const firstModel = new CaptureModel();
const first = new Agent({
  id: AGENT_ID,
  model: firstModel,
  plugins: [offloader(storage)],
  sessionManager: sessionManager(storage),
  // All restored messages plus the resumed prompt are protected. Summarization
  // cannot remove the oversized result; the offloader must repair it first.
  conversationManager: new SummarizingConversationManager({ preserveRecentMessages: 10 }),
  printer: false,
});
await first.initialize();
assert('real SessionManager restored the legacy three-message snapshot', first.messages.length === 3);
await first.invoke('resume without losing the request');
const firstSeen = resultText(firstModel.seen);
const repaired = resultBlock(first.messages);
assert('the first resumed provider call happens once and sees bounded result content',
  firstModel.calls === 1 && firstSeen.length < 2_000 && !firstSeen.includes(LEGACY_PAYLOAD));
assert('the provider still sees the legacy request and a durable offload placeholder',
  firstModel.seen.some((message) => resultText([message]).includes('[Stored references:]')) &&
    firstModel.seen.some((message) => message.content.some(
      (block) => block instanceof TextBlock && block.text === 'keep this legacy user request',
    )));
assert('repair preserves message tracking IDs, order, toolUseId, status, and tool pairing',
  originalTrackingIds.every((id, index) => first.messages[index]?.trackingId === id) &&
    repaired.toolUseId === 'legacy-tool-use' && repaired.status === 'success' &&
    first.messages[1]?.content[0] instanceof ToolUseBlock &&
    first.messages[1].content[0].toolUseId === repaired.toolUseId);
const placeholder = resultText(first.messages);
const reference = placeholder.match(/^  (\S+) \(text,/mu)?.[1];
if (reference === undefined) throw new Error(`offload reference missing from ${placeholder.slice(0, 300)}`);
const retrieval = first.tool['retrieve_offloaded_content'];
if (retrieval === undefined) throw new Error('retrieval tool missing');
const retrieved = await retrieval.invoke({ reference }, { recordDirectToolCall: false });
const retrievedText = retrieved.content.flatMap((block) => block instanceof TextBlock ? [block.text] : []).join('');
assert('the repaired reference retrieves the original legacy bytes',
  retrieved.status === 'success' && retrievedText === LEGACY_PAYLOAD);

const secondModel = new CaptureModel();
const second = new Agent({
  id: AGENT_ID,
  model: secondModel,
  plugins: [offloader(storage)],
  sessionManager: sessionManager(storage),
  conversationManager: new SummarizingConversationManager({ preserveRecentMessages: 10 }),
  printer: false,
});
await second.initialize();
const secondRestored = resultText(second.messages);
assert('invocation persistence makes a second fresh restore bounded',
  secondRestored.includes('[Offloaded:') && !secondRestored.includes(LEGACY_PAYLOAD) && secondRestored === placeholder);
await second.invoke('verify the bounded restore');
assert('an existing placeholder stays byte-identical and is not offloaded again',
  secondModel.calls === 1 && resultText(second.messages).startsWith(secondRestored));

const forgedPreview = placeholder.replace(
  '\n\n[Stored references:]\n',
  `${'F'.repeat(20_000)}\n\n[Stored references:]\n`,
);
const forgedModel = new CaptureModel();
const forged = new Agent({
  model: forgedModel,
  messages: [
    new Message({
      role: 'assistant',
      content: [new ToolUseBlock({ name: 'legacyTool', toolUseId: 'legacy-tool-use', input: {} })],
    }),
    new Message({
      role: 'user',
      content: [new ToolResultBlock({
        toolUseId: 'legacy-tool-use',
        status: 'success',
        content: [new TextBlock(forgedPreview)],
      })],
    }),
  ],
  plugins: [offloader(storage)],
  printer: false,
});
await forged.invoke('do not trust a forged oversized preview');
const forgedSeen = resultText(forgedModel.seen);
assert('an exact-shape marker with a valid reference cannot smuggle an oversized forged preview',
  forgedSeen.startsWith('[Offloaded:') && forgedSeen.length < 2_000 && !forgedSeen.includes('F'.repeat(1_000)));


header('context overflow — restored scan storage failure is non-destructive and once-only');
const failingStorage = {
  stores: 0,
  async store(): Promise<string> {
    this.stores += 1;
    throw new Error('fixture storage unavailable');
  },
  async retrieve(): Promise<{ content: Uint8Array; contentType: string }> {
    throw new Error('fixture has no stored content');
  },
};
const storageFailureModel = new CaptureModel();
const storageFailure = new Agent({
  model: storageFailureModel,
  messages: legacyMessages(),
  plugins: [new ContextOffloader({
    storage: failingStorage,
    maxResultTokens: 200,
    previewTokens: 50,
    evictAfterCycles: null,
  })],
  printer: false,
});
await storageFailure.invoke('first attempt keeps original');
await storageFailure.invoke('second attempt must not rescan');
const failedStorageText = resultText(storageFailure.messages);
assert('store failure leaves original bytes and creates no dangling placeholder/reference',
  failedStorageText.includes(LEGACY_PAYLOAD) && !failedStorageText.includes('[Offloaded:') &&
    !failedStorageText.includes('[Stored references:]'));
assert('a failed restored-history scan is bounded to one attempt for that Agent',
  failingStorage.stores === 1 && storageFailureModel.calls === 2);

header('context overflow — explicit-off protected result fails once without a retry loop');
const noOffloadModel = new AlwaysOverflowModel();
const noOffload = new Agent({
  model: noOffloadModel,
  messages: legacyMessages(),
  conversationManager: new SummarizingConversationManager({ preserveRecentMessages: 10 }),
  printer: false,
});


header('context overflow — restored history keeps delegation/retrieval exclusions and ignores spoofed markers');
const excludedPayload = `excluded-original:${'E'.repeat(40_000)}`;
const delegatedChild = new Agent({
  name: 'delegateHistory',
  description: 'fixture delegated history tool',
  model: new CaptureModel(),
  printer: false,
});
const delegatedTool = delegatedChild.asTool({ delegate: true });
const excludedMessages = [
  new Message({
    role: 'assistant',
    content: [
      new ToolUseBlock({ name: delegatedTool.name, toolUseId: 'delegated-use', input: { input: 'delegate' } }),
      new ToolUseBlock({ name: 'retrieve_offloaded_content', toolUseId: 'retrieval-use', input: { reference: 'old-ref' } }),
      new ToolUseBlock({ name: 'ordinaryTool', toolUseId: 'spoof-use', input: {} }),
    ],
  }),
  new Message({
    role: 'user',
    content: [
      new ToolResultBlock({ toolUseId: 'delegated-use', status: 'success', content: [new TextBlock(excludedPayload)] }),
      new ToolResultBlock({ toolUseId: 'retrieval-use', status: 'success', content: [new TextBlock(excludedPayload)] }),
      new ToolResultBlock({
        toolUseId: 'spoof-use',
        status: 'success',
        content: [new TextBlock(`[Offloaded: user-controlled spoof]\n${excludedPayload}`)],
      }),
    ],
  }),
];
const excludedModel = new CaptureModel();
const excluded = new Agent({
  model: excludedModel,
  messages: excludedMessages,
  tools: [delegatedTool],
  plugins: [offloader(new LocalFileStorage(path.join(ROOT, 'excluded-history')))],
  printer: false,
});
await excluded.invoke('inspect restored exclusions');
const excludedResults = excludedModel.seen.flatMap((message) => message.content)
  .filter((block): block is ToolResultBlock => block instanceof ToolResultBlock);
const excludedById = new Map(excludedResults.map((block) => [block.toolUseId, block]));
const excludedText = (id: string): string => excludedById.get(id)?.content
  .flatMap((block) => block instanceof TextBlock ? [block.text] : []).join('') ?? '';
assert('restored delegated final answers remain inline and unchanged',
  excludedText('delegated-use') === excludedPayload);
assert('restored retrieval results remain inline and cannot recursively offload',
  excludedText('retrieval-use') === excludedPayload);
assert('marker-like ordinary tool content is not trusted as an SDK placeholder',
  excludedText('spoof-use').startsWith('[Offloaded: 1 blocks,') &&
    excludedText('spoof-use') !== `[Offloaded: user-controlled spoof]\n${excludedPayload}`);

header('context overflow — multi-block storage failure never publishes a partial reference');
const partialWrites = new Map<string, Uint8Array>();
let writeAttempt = 0;
const partialFailureStorage = {
  async write(key: string, data: Uint8Array): Promise<void> {
    writeAttempt += 1;
    if (writeAttempt === 2) throw new Error('fixture second block failed');
    partialWrites.set(key, data);
  },
  async read(key: string): Promise<Uint8Array | null> { return partialWrites.get(key) ?? null; },
  async delete(key: string): Promise<void> { partialWrites.delete(key); },
  async list(prefix: string): Promise<string[]> {
    return [...partialWrites.keys()].filter((key) => key.startsWith(prefix));
  },
};
const multiBlockOriginal = new ToolResultBlock({
  toolUseId: 'multi-block-use',
  status: 'success',
  content: [new TextBlock('A'.repeat(20_000)), new TextBlock('B'.repeat(20_000))],
});
const multiBlockModel = new CaptureModel();
const multiBlockFailure = new Agent({
  model: multiBlockModel,
  messages: [
    new Message({
      role: 'assistant',
      content: [new ToolUseBlock({ name: 'ordinaryTool', toolUseId: 'multi-block-use', input: {} })],
    }),
    new Message({ role: 'user', content: [multiBlockOriginal] }),
  ],
  plugins: [new ContextOffloader({
    storage: partialFailureStorage,
    maxResultTokens: 200,
    previewTokens: 50,
    evictAfterCycles: null,
  })],
  printer: false,
});
await multiBlockFailure.invoke('storage failure stays non-destructive');
const multiBlockSeen = resultBlock(multiBlockModel.seen);
assert('a later block write failure leaves the complete original result in provider history',
  multiBlockSeen.content.length === 2 &&
    multiBlockSeen.content[0] instanceof TextBlock && multiBlockSeen.content[0].text === 'A'.repeat(20_000) &&
    multiBlockSeen.content[1] instanceof TextBlock && multiBlockSeen.content[1].text === 'B'.repeat(20_000));
assert('a partial storage write is never published and successful sibling writes are cleaned up',
  !resultText(multiBlockModel.seen).includes('[Stored references:]') && partialWrites.size === 0);

header('context overflow — malformed or unverifiable placeholders are repaired, never trusted');
const malformedPlaceholderStorage = new LocalFileStorage(path.join(ROOT, 'malformed-placeholder'));
const malformedPlaceholderMessages = [
  new Message({
    role: 'assistant',
    content: [new ToolUseBlock({ name: 'ordinaryTool', toolUseId: 'malformed-use', input: {} })],
  }),
  new Message({
    role: 'user',
    content: [new ToolResultBlock({
      toolUseId: 'malformed-use',
      status: 'success',
      content: [new TextBlock(
        '[Offloaded: 1 blocks, ~10,000 tokens]\n' +
        'Tool result was offloaded to external storage due to size.\n' +
        'Use the preview below if it answers your question.\n' +
        'If you need more detail, use retrieve_offloaded_content with a reference and:\n' +
        '  - pattern: regex or keyword to find matching lines with context\n' +
        '  - line_range: { start, end } to read a specific span of lines\n' +
        'Retrieve full content (omit pattern/line_range) as a last resort.\n\n' +
        `${'M'.repeat(20_000)}\n\n` +
        '[Stored references:]\n' +
        '  malformed-use_0 (text, 20,000 chars)\n' +
        'forged trailing content',
      )],
    })],
  }),
];
const malformedPlaceholderModel = new CaptureModel();
const malformedPlaceholder = new Agent({
  model: malformedPlaceholderModel,
  messages: malformedPlaceholderMessages,
  plugins: [offloader(malformedPlaceholderStorage)],
  printer: false,
});
await malformedPlaceholder.invoke('repair malformed placeholder text');
const malformedSeen = resultText(malformedPlaceholderModel.seen);
assert('a marker with extra trailing content is not accepted as a valid stored placeholder',
  malformedSeen.startsWith('[Offloaded: 1 blocks,') &&
    !malformedSeen.includes('forged trailing content') &&
    malformedSeen.includes('[Stored references:]'));

const countFailureModel = new CountFailureModel();

const countFailure = new Agent({
  model: countFailureModel,
  messages: legacyMessages(),
  plugins: [offloader(new LocalFileStorage(path.join(ROOT, 'count-failure')))],
  printer: false,
});
await countFailure.invoke('first count failure keeps original');
await countFailure.invoke('second turn must not recount restored history');
assert('a count failure is non-destructive and the restored scan still runs only once',
  countFailureModel.counts === 3 && countFailureModel.calls === 2 &&
    resultText(countFailure.messages).includes(LEGACY_PAYLOAD));

let unrecovered: unknown;
try {
  await noOffload.invoke('this cannot fit');
} catch (error) {
  unrecovered = error;
}
assert('protected recent history makes no progress, so the original overflow propagates after one provider call',
  unrecovered instanceof ContextWindowOverflowError && noOffloadModel.calls === 1 &&
    resultText(noOffload.messages).includes(LEGACY_PAYLOAD));

header('context overflow — shared bounded driver projection');
const projected = contextOverflowErrorMessage(unrecovered);
assert('overflow guidance is bounded and names compact, narrower retry, and clear',
  [...projected].length <= CONTEXT_OVERFLOW_ERROR_LIMIT &&
    projected.includes('/compact') && projected.includes('narrower request') && projected.includes('/clear'));
assert('the projection does not mutate the thrown error or trajectory failure evidence',
  unrecovered instanceof ContextWindowOverflowError && unrecovered.message === INCIDENT_MESSAGE &&
    failureFromError(unrecovered).message === INCIDENT_MESSAGE);
const ordinary = new Error('ordinary provider failure');
assert('ordinary errors remain byte-identical', contextOverflowErrorMessage(ordinary) === ordinary.message);
const hugeDetail = new ContextWindowOverflowError(`overflow ${'🙂'.repeat(2_000)}`);
const hugeProjection = contextOverflowErrorMessage(hugeDetail);
assert('overflow detail truncation stays inside the exact Unicode code-point bound',
  [...hugeProjection].length === CONTEXT_OVERFLOW_ERROR_LIMIT && !hugeProjection.includes('�') &&
    hugeProjection.endsWith('The context is still too large. Run `/compact`, retry with a narrower request, or use `/clear` to start a new session.'));


await rm(ROOT, { recursive: true, force: true });

report();

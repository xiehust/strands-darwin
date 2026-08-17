/** Deterministic local Model used by offline suites that must drive a real SDK Agent. */
import {
  Message,
  Model,
  type BaseModelConfig,
  type ModelStreamEvent,
  type StreamOptions,
  type SystemPrompt,
} from '@strands-agents/sdk';

export interface CapturedModelCall {
  messages: Message[];
  systemPrompt: SystemPrompt | undefined;
  tools: string[];
}

/**
 * Answers with fixed text and records the actual request presented by Agent.
 * It implements no provider transport, so using it proves an offline suite cannot
 * fall through to the SDK's default BedrockModel.
 */
export class CaptureModel extends Model<BaseModelConfig> {
  readonly calls: CapturedModelCall[] = [];
  private config: BaseModelConfig;

  constructor(
    private readonly reply = 'ok',
    modelId = 'fake.offline-capture',
  ) {
    super();
    this.config = { modelId, contextWindowLimit: 200_000 };
  }

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    this.calls.push({
      messages: messages.map((message) => message.clone()),
      systemPrompt: options?.systemPrompt,
      tools: options?.toolSpecs?.map((tool) => tool.name) ?? [],
    });
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: this.reply } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

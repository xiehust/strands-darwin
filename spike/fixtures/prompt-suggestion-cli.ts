/** Real CLI/Ink/runtime/SDK fixture. Local scripted transport; ledger is test-only. */
import { appendFile, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Model, type BaseModelConfig, type Message, type ModelStreamEvent, type StreamOptions } from '@strands-agents/sdk';
import { setRuntimeModelFactoryForTest } from '../../src/agent/runtime.js';
import { SUGGESTION_SYSTEM } from '../../src/agent/prompt-suggestion.js';

class SuggestionModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig;
  constructor(config: BaseModelConfig) { super(); this.config = config; }
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const text = messages.at(-1)?.content.find(block => block.type === 'textBlock')?.text ?? 'tool result';
    const suggestion = options?.systemPrompt === SUGGESTION_SYSTEM;
    const user = suggestion ? (JSON.parse(text) as { user: string }).user : text;
    await appendFile('model-calls', `${JSON.stringify({ kind: suggestion ? 'suggestion' : 'main', text, model: this.config.modelId, tools: options?.toolSpecs?.length ?? 0, maxTokens: this.config.maxTokens })}\n`);
    if (suggestion && user.startsWith('slow')) {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !options?.cancelSignal?.aborted) {
        try { if ((await readFile('release', 'utf8')) === user) break; } catch { /* not released */ }
        await delay(20);
      }
      if (options?.cancelSignal?.aborted) { await appendFile('cancelled', `${user}\n`); return; }
    }
    if (suggestion && user.startsWith('reject')) throw new Error('unsupported suggestion request 400');
    if (!suggestion && user === 'queue owner') await delay(400);
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (!suggestion && user === 'permission') {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'bash', toolUseId: 'permission' } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify({ mode: 'execute', command: 'printf forbidden > sentinel' }) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    const goal = typeof options?.systemPrompt === 'string' && options.systemPrompt.startsWith('You judge whether');
    const answer = goal ? '{"met":true,"reason":"done"}' : suggestion ? `Explain ${user} further` : `Observed answer about ${user}`;
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: answer } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: user === 'refuse' ? 'contentFiltered' : 'endTurn' };
    yield { type: 'modelMetadataEvent', usage: { inputTokens: suggestion ? 7 : 100, outputTokens: suggestion ? 3 : 20, totalTokens: suggestion ? 10 : 120 } };
  }
}
setRuntimeModelFactoryForTest(async config => new SuggestionModel({ modelId: config.model, maxTokens: config.maxTokens, contextWindowLimit: 200_000 }));
await import('../../src/cli.js');

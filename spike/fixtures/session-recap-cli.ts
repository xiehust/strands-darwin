/** Real CLI/Ink/runtime with local SDK streams. No clock overrides or production flags. */
import { appendFile, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Model, type BaseModelConfig, type Message, type ModelStreamEvent, type StreamOptions } from '@strands-agents/sdk';
import { setRuntimeModelFactoryForTest } from '../../src/agent/runtime.js';
import { RECAP_SYSTEM } from '../../src/agent/session-recap.js';
import { SUGGESTION_SYSTEM } from '../../src/agent/prompt-suggestion.js';

class RecapModel extends Model<BaseModelConfig> {
  constructor(private config: BaseModelConfig) { super(); }
  override updateConfig(c: BaseModelConfig): void { this.config = { ...this.config, ...c }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const text = messages.at(-1)?.content.find(b => b.type === 'textBlock')?.text ?? 'tool result';
    const recap = options?.systemPrompt === RECAP_SYSTEM, suggestion = options?.systemPrompt === SUGGESTION_SYSTEM;
    const goal = typeof options?.systemPrompt === 'string' && options.systemPrompt.startsWith('You judge whether');
    await appendFile('calls', JSON.stringify({ kind: recap ? 'recap' : suggestion ? 'suggestion' : goal ? 'goal' : 'main', text, model: this.config.modelId, tools: options?.toolSpecs?.length ?? 0, maxTokens: this.config.maxTokens }) + '\n');
    if (recap) {
      let slow = false; try { slow = (await readFile('slow', 'utf8')) === 'yes'; } catch { /* no delay */ }
      if (slow) {
        try { await delay(3000, undefined, { signal: options?.cancelSignal }); }
        catch { await appendFile('cancelled', 'recap\n'); return; }
      }
    }
    if (text === 'busy') await delay(1200);
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (!recap && text === 'permission') {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'bash', toolUseId: 'permission' } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify({ mode: 'execute', command: 'printf forbidden > sentinel' }) } };
      yield { type: 'modelContentBlockStopEvent' }; yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' }; return;
    }
    const answer = goal ? '{"met":true,"reason":"done"}' : recap ? (text.includes('unicode') ? '🙂'.repeat(401) : 'Recapped the observed work.') : suggestion ? 'Explain this further' : `Observed answer ${text}`;
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: answer } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: text === 'refuse' ? 'contentFiltered' : 'endTurn' };
    yield { type: 'modelMetadataEvent', usage: { inputTokens: recap ? 11 : 100, outputTokens: recap ? 7 : 20, totalTokens: recap ? 18 : 120 } };
  }
}
setRuntimeModelFactoryForTest(async c => new RecapModel({ modelId: c.model, maxTokens: c.maxTokens, contextWindowLimit: 200_000 }));
await import('../../src/cli.js');

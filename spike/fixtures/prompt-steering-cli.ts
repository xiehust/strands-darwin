/** Real CLI with a local model and a bounded real shell tool, no network. */
import { appendFile } from 'node:fs/promises';
import { Model, type BaseModelConfig, type Message, type ModelStreamEvent } from '@strands-agents/sdk';
import { setRuntimeModelFactoryForTest } from '../../src/agent/runtime.js';

class SteeringModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fixture.steering', contextWindowLimit: 32_000 };
  private calls = 0;
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls++;
    const last = messages.at(-1)!;
    await appendFile('calls.jsonl', JSON.stringify({ role: last.role, content: last.content }) + '\n');
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (this.calls === 1) {
      // Bounded rendezvous, not a timing guess: the test releases the real tool only
      // once Ink has shown the queued correction. A failure exits after ten seconds.
      const script = 'const fs=require("node:fs");console.log("STEERING_WAIT");let n=0;const t=setInterval(()=>{if(fs.existsSync("release")||++n===100){clearInterval(t);process.exit(0)}},100)';
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'bash', toolUseId: 'steering-wait' } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify({ mode: 'execute', command: `node -e '${script}'` }) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    const corrected = last.content.some(block => block.type === 'textBlock' && block.text === 'Do not edit; explain instead.');
    const paired = last.content.some(block => block.type === 'toolResultBlock');
    const text = corrected && paired ? 'CORRECTION_VISIBLE_IN_CURRENT_TURN' : 'STEERING_NOT_DELIVERED';
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

setRuntimeModelFactoryForTest(async () => new SteeringModel());
await import('../../src/cli.js');

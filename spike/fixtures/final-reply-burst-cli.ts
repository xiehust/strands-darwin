/**
 * Streams the exact reported final-reply shape at realistic burst timing.
 *
 * The existing `final-reply-handoff-cli.ts` fixture pauses before the block
 * closes so the pty test can inspect the held tail. Real sessions do the
 * opposite: the closing `contentBlockEvent` follows the last delta inside the
 * same network burst, which is the timing window where the reported
 * occasional duplication lives. This fixture reproduces that shape — the
 * recorded session-20260830-110550523 reply tail, small deltas back to back,
 * no pause before the close — and varies the inter-delta gap per turn so a
 * probe can sweep the render-throttle window.
 *
 * Each turn carries a unique `【Tn】` marker in every paragraph so the probe
 * can count per-turn occurrences in reconstructed terminal scrollback.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { Model } from '@strands-agents/sdk';
import type { BaseModelConfig, Message, ModelStreamEvent } from '@strands-agents/sdk';

import { setRuntimeModelFactoryForTest } from '../../src/agent/runtime.js';

/** The recorded reply tail, verbatim shape: bullets, blank, 验证, blank, 文档. */
function replyFor(turn: number): string {
  const t = `【T${turn}】`;
  return [
    `${t}本轮做的事，逐条列出，保持与真实会话相同的段落结构与换行密度，用于终端滚动：`,
    '',
    `- ${t}\`expandSlashCommand\` 最先检查它（内建保留名优先于 skills/自定义命令），TUI/dev-repl/headless 行为一致`,
    `- ${t}\`BUILTIN_COMMAND_NAMES\` + 描述、\`MAX_COMPLETIONS\` 19→20、App.tsx/dev-repl 的空参提示`,
    `- ${t}新测试 \`spike/verify-workflow-command.ts\`（20 断言，进 \`pnpm test\`）`,
    `- ${t}顺带修了一个 HEAD 上就红的 pathCompletion 双侧省略断言（fixture 恰好卡在旧 cap 上）`,
    '',
    `**验证**${t}：\`pnpm typecheck\` ✓、\`pnpm test\` 全绿（80 套件）、\`verify-tui.ts completion\` 68/68、\`pathCompletion\` 27/27；\`pnpm build\` 已刷新 dist，下次启动 darwin 即可用。`,
    '',
    `**文档/spec**${t}：SER-045 契约新增触发器条款与必跑检查、AGENTS.md workflow 行（30.5 KiB < 32 KiB）、load-bearing-decisions.md、用户指南 reference/extensions 中英双语。任务已归档至 \`.trellis/tasks/archive/2026-08/08-30-workflow-command/\`。`,
  ].join('\n');
}

/** Splits into small deltas the way a provider stream arrives. */
function* chunks(text: string, size: number): Generator<string> {
  for (let at = 0; at < text.length; at += size) yield text.slice(at, at + size);
}

class BurstModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.final-reply-burst', contextWindowLimit: 200_000 };
  private calls = 0;

  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }

  override async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    yield { type: 'modelMessageStartEvent', role: 'assistant' };

    // The recorded failing session used `update_plan` during the turn, so the
    // turn ends with a non-empty livePlan: first model call replaces the
    // checklist, second streams the closing reply.
    if (this.calls % 2 === 1) {
      const turn = (this.calls + 1) / 2;
      const plan = [
        { item: `turn ${turn} research`, status: 'completed' },
        { item: `turn ${turn} implement`, status: 'in_progress' },
        { item: `turn ${turn} verify`, status: 'pending' },
      ];
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'update_plan', toolUseId: `plan-${turn}` } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify({ plan }) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }

    const turn = this.calls / 2;
    yield { type: 'modelContentBlockStartEvent' };

    // Sweep the throttle window: per-turn gap pattern between deltas.
    // 0 = same-tick burst, 1 = macrotask each delta, 2 = 5ms every 4th delta,
    // 3 = 17ms every 8th delta (half the default 30fps window).
    const pattern = turn % 4;
    let index = 0;
    for (const piece of chunks(replyFor(turn), 9)) {
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: piece } };
      index += 1;
      if (pattern === 1) await delay(0);
      else if (pattern === 2 && index % 4 === 0) await delay(5);
      else if (pattern === 3 && index % 8 === 0) await delay(17);
    }

    // No pause: the close follows the last delta inside the same burst,
    // exactly as the recorded trajectory shows.
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

setRuntimeModelFactoryForTest(async () => new BurstModel());
await import('../../src/cli.js');

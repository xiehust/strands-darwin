/**
 * SER-026 — `/status`: one consolidated read-only report of the live session.
 *
 * Free suite: no model call, no network, no I/O. `formatStatusReport` is a pure
 * formatter over state the runtime already holds, and this suite proves its
 * honesty contracts over typed fixture facts (the same plain interfaces the real
 * accessors return): every fact present, unknown spend rendered as `not
 * reported` and never 0 (the `usageBuckets` rule), long lists bounded with an
 * explicit remainder, a failed MCP server *stated* as failed exactly as `/mcp`
 * words it, and degradation (missing context estimate, recording off) as text
 * rather than an error. The `/status extra` argument degradation is a TUI
 * handler concern, asserted in the free pty scenario (`verify-tui.ts
 * completion`); what belongs here is the menu-capacity invariant that keeps
 * every built-in visible.
 *
 * Run: pnpm tsx spike/verify-status-command.ts
 */
import type { PromptCachePlan } from '../src/agent/prompt-cache.js';
import type { ContextEstimate, UsageTotals } from '../src/agent/runtime.js';
import type { ThinkingPlan } from '../src/agent/thinking.js';
import { describeCost, type ModelPriceLookup } from '../src/agent/cost.js';
import { describeCallEfficiency, type SessionCallStats } from '../src/agent/call-stats.js';
import { withSoleChoice, type AppConfig } from '../src/config.js';
import { BUILTIN_COMMAND_NAMES, builtinCommandDescription } from '../src/commands/custom-commands.js';
import type { McpServerStatus } from '../src/mcp/registry.js';
import type { TrajectoryStatus } from '../src/trajectory/writer.js';
import type { DiagnosticsStatus } from '../src/agent/diagnostics.js';
import { MAX_COMPLETIONS } from '../src/tui/InputBox.js';
import {
  MAX_STATUS_NAMES,
  formatPromptCache,
  formatPromptCacheState,
  formatStatusReport,
  formatThinking,
  type StatusFacts,
} from '../src/tui/status-format.js';
import { assert, header, report } from './shared.js';

const BEDROCK: AppConfig = withSoleChoice({
  provider: 'bedrock',
  model: 'us.anthropic.claude-sonnet-4-6',
  maxTokens: 8192,
  summaryRatio: 0.3,
  contextWarnRatio: 0.8,
  contextOffload: true,
  preserveRecentMessages: 10,
  permissionMode: 'default',
  promptCache: true,
  thinkingEffort: 'high',
});

const CACHE_ON: PromptCachePlan = {
  enabled: true,
  automatic: false,
  parts: ['system prompt', 'tools'],
  ttl: '5m',
  problem: undefined,
};
const CACHE_AUTO: PromptCachePlan = {
  enabled: false,
  automatic: true,
  parts: [],
  ttl: undefined,
  problem: undefined,
};
const CACHE_OFF: PromptCachePlan = {
  enabled: false,
  automatic: false,
  parts: [],
  ttl: undefined,
  problem: undefined,
};
const THINKING_HIGH: ThinkingPlan = { enabled: true, requested: 'high', effective: 'high', problem: undefined };

const RECORDING: TrajectoryStatus = {
  file: '/tmp/p/.darwin/sessions/s-1/trajectory.jsonl',
  recordsThisRun: 12,
  truncationsThisRun: 0,
  bytesThisRun: 4096,
  problem: undefined,
  active: true,
};

const LOGGING: DiagnosticsStatus = {
  file: '/tmp/p/.darwin/sessions/s-1/diagnostics.log',
  linesThisRun: 40,
  bytesThisRun: 2048,
  droppedLines: 0,
  problem: undefined,
  active: true,
};

const SPENT: UsageTotals = {
  inputTokens: 1234,
  outputTokens: 567,
  cacheReadInputTokens: 9000,
  cacheWriteInputTokens: 100,
};

const ESTIMATE: ContextEstimate = { estimatedTokens: 2100, messageCount: 5, windowTokens: 200_000 };

/** The state before the background fetch has recorded the model — the honest default. */
const UNAVAILABLE: ModelPriceLookup = { kind: 'unavailable' };
/** Sonnet-class base rates, as LiteLLM lists `global.anthropic.claude-sonnet-5`. */
const PRICED: ModelPriceLookup = {
  kind: 'priced',
  litellmKey: 'global.anthropic.claude-sonnet-5',
  rates: {
    inputCostPerToken: 2e-6,
    outputCostPerToken: 1e-5,
    cacheReadInputTokenCost: 2e-7,
    cacheCreationInputTokenCost: 2.5e-6,
  },
};

function server(partial: Partial<McpServerStatus> & { name: string }): McpServerStatus {
  return { state: 'connected', toolNames: [], ...partial };
}

/** A complete, healthy session — the baseline the honesty cases vary from. */
function facts(overrides: Partial<StatusFacts> = {}): StatusFacts {
  return {
    config: BEDROCK,
    sessionId: 'session-20260819-000000000',
    resumed: false,
    promptCache: CACHE_ON,
    thinking: THINKING_HIGH,
    mode: 'default',
    allowRuleCount: 2,
    mcpServers: [server({ name: 'calc', toolNames: ['calc_alpha', 'calc_beta', 'calc_gamma'] })],
    skillNames: ['commit-message', 'developer'],
    trajectory: RECORDING,
    diagnostics: LOGGING,
    usage: SPENT,
    modelPrice: UNAVAILABLE,
    childUsage: undefined,
    callStats: undefined,
    turnInFlight: false,
    context: ESTIMATE,
    ...overrides,
  };
}

function testEveryFactPresent(): void {
  header('formatStatusReport — every fact of the requirement, from existing accessors');

  const text = formatStatusReport(facts());
  assert('the report is titled as this session\u2019s status', text.startsWith('status — this session'));
  assert('model and provider are stated', text.includes('bedrock/us.anthropic.claude-sonnet-4-6'));
  assert('cache state rides on the model line, as in the header', text.includes(' · cache 5m'));
  assert('thinking effort rides on the model line, as in the header', text.includes(' · effort high'));
  assert('the session id is stated', text.includes('session-20260819-000000000'));
  assert('a non-resumed session claims no resume', !text.includes('(resumed)'));
  assert('the permission mode is stated with the live rule count',
    text.includes('default · 2 allow rule(s)'));
  assert('MCP servers are stated with connection state and tool count',
    text.includes('1 server — calc connected (3 tools)'));
  assert('the fuller report is pointed at, not duplicated', text.includes('(details: /mcp)'));
  assert('skills are counted with representative names',
    text.includes('2 — commit-message, developer'));
  assert('trajectory state names the file', text.includes(`recording — ${RECORDING.file}`));
  assert('diagnostics state names the file', text.includes(`logging — ${LOGGING.file}`));
  assert('token spend is stated with this-run scope',
    text.includes('input 1,234') && text.includes('output 567') && text.includes('— this run'));
  assert('reported cache counters are stated as numbers',
    text.includes('cache read 9,000') && text.includes('cache write 100'));
  assert('the context estimate reuses the /context value',
    text.includes('~2,100 tokens · 1% of 200,000 window · 5 message(s)'));
  // The anchored shape has to reach `/status` through the same shared renderer, or
  // the two surfaces would describe one estimate two different ways.
  assert('a measured context base reaches /status through the same renderer',
    formatStatusReport(facts({
      context: { estimatedTokens: 128_431, messageCount: 84, windowTokens: 200_000, measuredTokens: 126_900, tailTokens: 1_531 },
    })).includes('~128,431 tokens (measured 126,900 + ~1,531 new) · 64% of 200,000 window · 84 message(s)'));

  // The model-line suffixes are the header's own renderers, exported from one place.
  assert('cache suffix formatter matches the header vocabulary', formatPromptCache(CACHE_ON) === ' · cache 5m');
  assert('provider-managed caching is shown as automatic', formatPromptCache(CACHE_AUTO) === ' · cache auto');
  assert('the model-switch cache row calls provider-managed caching auto', formatPromptCacheState(CACHE_AUTO) === 'auto');
  assert('a disabled cache adds nothing to the model line', formatPromptCache(CACHE_OFF) === '');
  assert('the model-switch cache row still calls a disabled cache off', formatPromptCacheState(CACHE_OFF) === 'off');
  assert('thinking suffix formatter matches the header vocabulary', formatThinking(THINKING_HIGH) === ' · effort high');
}

function testUnknownStaysUnknown(): void {
  header('formatStatusReport — unknown metrics stay unknown, never 0');

  const unknownCache = formatStatusReport(facts({
    usage: { inputTokens: 10, outputTokens: 3 },
  }));
  assert('an unreported cache-read is not reported, not zero',
    unknownCache.includes('cache read not reported') && !unknownCache.includes('cache read 0'));
  assert('an unreported cache-write is not reported, not zero',
    unknownCache.includes('cache write not reported') && !unknownCache.includes('cache write 0'));

  // OpenAI Responses: uncached input cannot be split without the cache counters,
  // so it stays unknown instead of being guessed — the usageBuckets rule verbatim.
  const responses = formatStatusReport(facts({
    config: withSoleChoice({ ...BEDROCK, provider: 'openai', model: 'openai.gpt-5.6-sol', openaiApi: 'responses' }),
    usage: { inputTokens: 10, outputTokens: 3 },
  }));
  assert('an unsplittable Responses input is not reported, not guessed',
    responses.includes('input not reported'));

  const missingEstimate = formatStatusReport(facts({ context: undefined, contextProblem: 'boom' }));
  assert('a failed context estimate degrades to one line, never a failed report',
    missingEstimate.includes('unavailable — boom') && missingEstimate.startsWith('status — this session'));
}

function testBoundedLists(): void {
  header('formatStatusReport — long lists are counted and bounded, never dumped');

  const manySkills = Array.from({ length: MAX_STATUS_NAMES + 3 }, (_, i) => `skill-${String(i).padStart(2, '0')}`);
  const manyServers = Array.from({ length: MAX_STATUS_NAMES + 2 }, (_, i) => server({ name: `srv-${String(i).padStart(2, '0')}` }));
  const text = formatStatusReport(facts({ skillNames: manySkills, mcpServers: manyServers }));

  assert('the skill list is capped with an explicit remainder',
    text.includes(`${manySkills.length} — `) && text.includes('… 3 more'));
  assert('no skill beyond the cap is dumped', !text.includes(`skill-${String(MAX_STATUS_NAMES).padStart(2, '0')}`));
  assert('the server list is capped with an explicit remainder',
    text.includes(`${manyServers.length} servers — `) && text.includes('… 2 more'));
  assert('no server beyond the cap is dumped', !text.includes(`srv-${String(MAX_STATUS_NAMES).padStart(2, '0')}`));
}

function testStatesAndDegradation(): void {
  header('formatStatusReport — states reported as they are, absence as text');

  const mixed = formatStatusReport(facts({
    mcpServers: [
      server({ name: 'calc', toolNames: ['calc_alpha'] }),
      server({ name: 'broken', state: 'failed' }),
      server({ name: 'idle', state: 'disconnected' }),
      server({ name: 'future', toolNames: undefined }),
    ],
  }));
  assert('a failed server is stated as failed, exactly as /mcp words it',
    mixed.includes('broken failed — could not connect'));
  assert('a never-connected server is stated, not probed', mixed.includes('idle not connected'));
  assert('unreadable tool names are stated as unavailable, not invented',
    mixed.includes('future connected (tool names unavailable)'));

  const bare = formatStatusReport(facts({
    mcpServers: [],
    skillNames: [],
    trajectory: undefined,
    diagnostics: undefined,
    resumed: true,
    turnInFlight: true,
  }));
  assert('no MCP servers is a normal state', bare.includes('none configured'));
  assert('no skills is a normal state', /skills\s+none/.test(bare));
  assert('recording off is stated with its config cause', bare.includes('not recording (trajectory: false)'));
  assert('diagnostics off is stated as off', /diagnostics\s+off/.test(bare));
  assert('a resumed session scopes its spend honestly', bare.includes('earlier runs not counted'));
  assert('an in-flight turn is stated as not counted yet',
    bare.includes('(the turn in flight is not counted yet)'));

  const plan = formatStatusReport(facts({ mode: 'plan', allowRuleCount: 3 }));
  assert('plan mode uses the header\u2019s wording and states ignored rules',
    plan.includes('plan — read-only; write and execute calls are denied · 3 allow rule(s) ignored'));
  const yolo = formatStatusReport(facts({ mode: 'yolo' }));
  assert('yolo mode uses the header\u2019s warning wording',
    yolo.includes('yolo — every tool call runs without confirmation'));
}

function testMenuCapacity(): void {
  header('/status — a registered built-in the completion menu can still show in full');

  assert('status is a built-in command name', (BUILTIN_COMMAND_NAMES as readonly string[]).includes('status'));
  assert('status carries a completion description', builtinCommandDescription('status') === 'session configuration and state');
  assert('MAX_COMPLETIONS keeps every built-in visible (grow it with the list)',
    MAX_COMPLETIONS >= BUILTIN_COMMAND_NAMES.length);
}

function testChildUsage(): void {
  header('formatStatusReport — child spend is additive, never a changed baseline');

  // Zero dispatches: byte-identical to a report that never knew about children.
  const base = formatStatusReport(facts());
  assert('without childUsage no subagent or session-total line exists',
    !base.includes('usage (subagents') && !base.includes('usage (session total)'));

  const withChildren = formatStatusReport(facts({
    childUsage: { dispatches: 2, usage: { inputTokens: 400, outputTokens: 40 } },
  }));
  const baseLines = base.split('\n');
  const childLines = withChildren.split('\n');
  const added = childLines.filter((line) => !baseLines.includes(line));
  assert('childUsage adds exactly four lines (usage + cost, twice) and leaves every existing line byte-identical',
    added.length === 4 && childLines.filter((line) => baseLines.includes(line)).join('\n') === base);
  assert('the child line names the dispatch count and the summed buckets',
    withChildren.includes('usage (subagents, 2 dispatches): input 400 · output 40'));
  assert('the child lines sit directly under the cost row, which sits under tokens',
    childLines[childLines.findIndex((line) => line.includes('tokens')) + 1]?.includes('cost') === true &&
    childLines[childLines.findIndex((line) => line.includes('  cost ')) + 1]?.includes('usage (subagents') === true);
  // Session total = parent meter + children, through the same bucket renderer.
  assert('the session total sums the parent meter and the children',
    withChildren.includes('usage (session total): input 1,634 · output 607 · cache read 9,000 · cache write 100'));
  assert('a single dispatch is not pluralized',
    formatStatusReport(facts({ childUsage: { dispatches: 1, usage: { inputTokens: 1, outputTokens: 1 } } }))
      .includes('(subagents, 1 dispatch):'));
  // The undefined-cache rule survives the child projection: no child meter
  // reported cache counters, and bedrock's row contract keeps them numeric —
  // but an all-unknown provider stays `not reported`.
  const openaiChildren = formatStatusReport(facts({
    config: withSoleChoice({ ...BEDROCK, provider: 'openai', model: 'openai.gpt-5.6-sol', openaiApi: 'chat' }),
    childUsage: { dispatches: 1, usage: { inputTokens: 5, outputTokens: 2 } },
  }));
  assert('an unreported child cache metric reads not reported, never 0',
    openaiChildren.includes('usage (subagents, 1 dispatch): input 5 · output 2 · cache read not reported · cache write not reported'));
}

function testCallStats(): void {
  header('formatStatusReport — per-call efficiency is additive, one bounded shared line');

  const stats: SessionCallStats = {
    calls: 12,
    meteredCalls: 12,
    usage: { inputTokens: 1200, outputTokens: 240, cacheReadInputTokens: 46_800 },
    noTool: 2,
    singleTool: 8,
    multiTool: 2,
    recentToolUseCounts: [1, 1, 0, 1, 2, 1, 1, 1, 0, 1],
  };

  // Zero completed calls: byte-identical to a report that never knew about them.
  const base = formatStatusReport(facts());
  assert('without callStats no model-calls line exists', !base.includes('model calls:'));

  const withStats = formatStatusReport(facts({ callStats: stats }));
  const baseLines = base.split('\n');
  const statLines = withStats.split('\n');
  const added = statLines.filter((line) => !baseLines.includes(line));
  assert('callStats adds exactly one line and leaves every existing line byte-identical',
    added.length === 1 && statLines.filter((line) => baseLines.includes(line)).join('\n') === base);
  assert('the line is the shared describeCallEfficiency rendering',
    added[0] === `  model calls: ${describeCallEfficiency(stats, BEDROCK)}` &&
    withStats.includes('model calls: 12 completed · avg request input 4,000 · tool responses 8 single / 2 multi / 2 none'));
  assert('the line sits directly under the cost row (itself under tokens)',
    statLines[statLines.findIndex((line) => line.includes('  cost ')) + 1]?.includes('model calls:') === true);
  assert('an unmetered average reads not reported, never 0',
    formatStatusReport(facts({ callStats: { ...stats, meteredCalls: 0, usage: undefined } }))
      .includes('avg request input not reported'));
  // Both additive blocks together: the child lines keep their slot, the call line follows.
  const both = formatStatusReport(facts({
    childUsage: { dispatches: 1, usage: { inputTokens: 1, outputTokens: 1 } },
    callStats: stats,
  })).split('\n');
  const tokensIndex = both.findIndex((line) => line.includes('tokens'));
  assert('with children present the call line follows the cost row and the four child lines',
    both[tokensIndex + 1]?.includes('  cost ') === true &&
    both[tokensIndex + 2]?.includes('usage (subagents') === true &&
    both[tokensIndex + 3]?.includes('cost (subagents') === true &&
    both[tokensIndex + 4]?.includes('usage (session total)') === true &&
    both[tokensIndex + 5]?.includes('cost (session total)') === true &&
    both[tokensIndex + 6]?.includes('model calls:') === true);
}

function testCost(): void {
  header('formatStatusReport — cost is one row beside tokens, priced by the shared projection');

  // Default facts: the fetch has not recorded the model. Said as unavailable, never $0.
  const unavailable = formatStatusReport(facts());
  const lines = unavailable.split('\n');
  const tokensIndex = lines.findIndex((line) => line.includes('  tokens '));
  assert('the cost row sits directly under the tokens row',
    lines[tokensIndex + 1]?.trimStart().startsWith('cost ') === true);
  assert('an unfetched price reads unavailable, never a number',
    unavailable.includes('unknown (price unavailable)') && !unavailable.includes('$'));
  assert('a model LiteLLM does not list names itself as unpriced',
    formatStatusReport(facts({ modelPrice: { kind: 'none' } }))
      .includes('unknown (no price for us.anthropic.claude-sonnet-4-6)'));

  // Priced: SPENT is 1,234 in · 567 out · 9,000 cache read · 100 cache write at Sonnet rates.
  const priced = formatStatusReport(facts({ modelPrice: PRICED }));
  const expected = 1234 * 2e-6 + 567 * 1e-5 + 9000 * 2e-7 + 100 * 2.5e-6;
  assert('the row is the shared describeCost rendering, labelled approximate with its basis',
    priced.includes(`cost         ≈ $${expected.toFixed(4)} (base rates, LiteLLM)`) &&
    priced.includes(describeCost(PRICED, SPENT, BEDROCK)));
  assert('pricing changes only the cost row', (() => {
    const a = unavailable.split('\n');
    const b = priced.split('\n');
    return a.length === b.length && a.every((line, i) => line === b[i] || line.includes('  cost '));
  })());

  // An unreported bucket makes the total a floor, never a smaller exact-looking number.
  const partial = formatStatusReport(facts({ modelPrice: PRICED, usage: { inputTokens: 1000, outputTokens: 100 } }));
  assert('an unreported cache bucket turns the figure into a stated floor',
    partial.includes('≥ $0.0030 (cacheRead not reported, cacheWrite not reported; base rates, LiteLLM)'));

  // Children: their cost line follows each usage line, priced the same way.
  const children = formatStatusReport(facts({
    modelPrice: PRICED,
    childUsage: { dispatches: 2, usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 } },
  }));
  assert('the subagent cost line prices the children alone',
    children.includes('cost (subagents, 2 dispatches): ≈ $0.0030 (base rates, LiteLLM)'));
  assert('the session-total cost line prices parent plus children',
    children.includes(`cost (session total): ≈ $${(expected + 0.003).toFixed(4)} (base rates, LiteLLM)`));
}

function main(): void {
  testEveryFactPresent();
  testUnknownStaysUnknown();
  testBoundedLists();
  testStatesAndDegradation();
  testChildUsage();
  testCallStats();
  testCost();
  testMenuCapacity();
  report();
}

main();

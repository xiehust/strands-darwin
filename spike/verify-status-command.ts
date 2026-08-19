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
import { withSoleChoice, type AppConfig } from '../src/config.js';
import { BUILTIN_COMMAND_NAMES, builtinCommandDescription } from '../src/commands/custom-commands.js';
import type { McpServerStatus } from '../src/mcp/registry.js';
import type { TrajectoryStatus } from '../src/trajectory/writer.js';
import type { DiagnosticsStatus } from '../src/agent/diagnostics.js';
import { MAX_COMPLETIONS } from '../src/tui/InputBox.js';
import {
  MAX_STATUS_NAMES,
  formatPromptCache,
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
  preserveRecentMessages: 10,
  permissionMode: 'default',
  promptCache: true,
  thinkingEffort: 'high',
});

const CACHE_ON: PromptCachePlan = { enabled: true, parts: ['system prompt', 'tools'], ttl: '5m', problem: undefined };
const CACHE_OFF: PromptCachePlan = { enabled: false, parts: [], ttl: undefined, problem: undefined };
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

  // The model-line suffixes are the header's own renderers, exported from one place.
  assert('cache suffix formatter matches the header vocabulary', formatPromptCache(CACHE_ON) === ' · cache 5m');
  assert('a disabled cache adds nothing to the model line', formatPromptCache(CACHE_OFF) === '');
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

function main(): void {
  testEveryFactPresent();
  testUnknownStaysUnknown();
  testBoundedLists();
  testStatesAndDegradation();
  testMenuCapacity();
  report();
}

main();

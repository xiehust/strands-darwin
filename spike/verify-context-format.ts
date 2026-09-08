/**
 * Pure formatting contracts for the /context report, plus the SER-077 breakdown:
 * the rows, their bounds, and the measurement over an injected counter. No model
 * call, no network — the "model" below is the SDK's own base-class heuristic.
 */
import {
  CachePointBlock,
  Message,
  Model,
  TextBlock,
  type BaseModelConfig,
  type CountTokensOptions,
  type ModelStreamEvent,
  type StreamOptions,
  type ToolSpec,
} from '@strands-agents/sdk';

import {
  ASSISTANT_MESSAGES_LABEL,
  BASE_PROMPT_LABEL,
  BUILTIN_TOOLS_LABEL,
  CATALOGUE_NOT_INJECTED,
  MCP_TOOLS_LABEL_PREFIX,
  PROJECT_INSTRUCTIONS_LABEL,
  RESTORED_PROMPT_LABEL,
  SKILLS_CATALOGUE_LABEL,
  UNATTRIBUTED_TOOLS_LABEL,
  USER_MESSAGES_LABEL,
  WHOLE_PROMPT_LABEL,
  WORKING_CONTEXT_LABEL,
  groupToolsByOrigin,
  measureContextBreakdown,
  type ComponentCounter,
  type ContextBreakdown,
  type ContextComponent,
} from '../src/agent/context-breakdown.js';
import { composeSystemPrompt } from '../src/agent/instructions.js';
import type { ContextEstimate } from '../src/agent/runtime.js';
import type { McpServerStatus } from '../src/mcp/registry.js';
import {
  BREAKDOWN_CAPTION,
  MAX_BREAKDOWN_SERVER_ROWS,
  createContextWarnLatch,
  formatContextBreakdown,
  formatContextReport,
  formatContextReportWithBreakdown,
  formatContextValue,
  formatWindowShare,
} from '../src/tui/context-format.js';
import { initialTurnState, turnReducer, type TurnState } from '../src/tui/turn-state.js';
import { assert, header, report } from './shared.js';

/** The SDK's base heuristic (`chars/4` text, `chars/2` tool-spec JSON), nothing else. */
class HeuristicModel extends Model<BaseModelConfig> {
  override updateConfig(): void {}
  override getConfig(): BaseModelConfig {
    return { modelId: 'fake.heuristic' };
  }
  override async *stream(_messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    throw new Error('never streamed');
  }
}
const heuristic = new HeuristicModel();

header('/context — window share');
assert('a plain share rounds to an integer percent',
  formatWindowShare(34_000, 1_000_000) === '3%');
assert('rounding is to the nearest percent, not truncation',
  formatWindowShare(25_000, 1_000_000) === '3%' && formatWindowShare(24_000, 1_000_000) === '2%');
assert('a nonzero share below one percent says <1%, never 0%',
  formatWindowShare(500, 1_000_000) === '<1%');
assert('an actually empty context is 0%', formatWindowShare(0, 1_000_000) === '0%');
assert('overflow is stated, not clamped', formatWindowShare(250_000, 200_000) === '125%');
assert('a nonsense window degrades to words, not division by zero',
  formatWindowShare(10, 0) === 'share unknown' && formatWindowShare(10, -5) === 'share unknown');

header('/context — report line');
assert('a known window renders tokens, share, and messages on one line',
  formatContextReport({ estimatedTokens: 34_000, messageCount: 42, windowTokens: 1_000_000 }) ===
  'estimated context — ~34,000 tokens · 3% of 1,000,000 window · 42 message(s)');
assert('an unknown window is said out loud instead of guessed',
  formatContextReport({ estimatedTokens: 1_234, messageCount: 3, windowTokens: undefined }) ===
  'estimated context — ~1,234 tokens · window unknown · 3 message(s)');
assert('an empty conversation still reports honestly',
  formatContextReport({ estimatedTokens: 0, messageCount: 0, windowTokens: 200_000 }) ===
  'estimated context — ~0 tokens · 0% of 200,000 window · 0 message(s)');

header('/context — report line with a measured base');
assert('a measured base is named, and stops the line calling itself merely estimated',
  formatContextReport({
    estimatedTokens: 128_431,
    messageCount: 84,
    windowTokens: 200_000,
    measuredTokens: 126_900,
    tailTokens: 1_531,
  }) ===
  'context — ~128,431 tokens (measured 126,900 + ~1,531 new) · 64% of 200,000 window · 84 message(s)');
assert('an empty tail says so rather than hiding the basis',
  formatContextReport({
    estimatedTokens: 126_900,
    messageCount: 12,
    windowTokens: 200_000,
    measuredTokens: 126_900,
    tailTokens: 0,
  }) ===
  'context — ~126,900 tokens (measured 126,900 + ~0 new) · 63% of 200,000 window · 12 message(s)');
assert('a failed tail count keeps the measurement and admits the gap',
  formatContextReport({
    estimatedTokens: 126_900,
    messageCount: 12,
    windowTokens: 200_000,
    measuredTokens: 126_900,
  }) ===
  'context — ~126,900 tokens (measured 126,900 + tail unknown) · 63% of 200,000 window · 12 message(s)');
assert('an unknown window is still said out loud with a measured base',
  formatContextReport({
    estimatedTokens: 5_000,
    messageCount: 4,
    windowTokens: undefined,
    measuredTokens: 4_900,
    tailTokens: 100,
  }) ===
  'context — ~5,000 tokens (measured 4,900 + ~100 new) · window unknown · 4 message(s)');
// The measured base is a basis, not a second total: the share and the token figure
// are still computed from `estimatedTokens` alone.
assert('the window share follows the total, not the measured part',
  formatContextValue({
    estimatedTokens: 160_000,
    messageCount: 9,
    windowTokens: 200_000,
    measuredTokens: 100_000,
    tailTokens: 60_000,
  }).includes('80% of 200,000 window'));

header('/context — pressure notice latch');
const KNOWN_WINDOW = 1_000_000;
const estimate = (estimatedTokens: number, windowTokens: number | undefined = KNOWN_WINDOW) => ({
  estimatedTokens,
  messageCount: 1,
  windowTokens,
});

let latch = createContextWarnLatch();
assert('stays silent below the deliberately high configured threshold',
  latch.check(estimate(799_999), 0.8) === null);
const firstNotice = latch.check(estimate(800_000), 0.8);
assert('fires at the exact configured threshold', firstNotice !== null);
assert('does not fire again while still above the threshold',
  latch.check(estimate(900_000), 0.8) === null);
assert('re-arms after a known estimate drops below the threshold',
  latch.check(estimate(700_000), 0.8) === null);
assert('fires again after re-arming',
  latch.check(estimate(850_000), 0.8) !== null);

latch = createContextWarnLatch();
assert('disabled at warnRatio 0, no matter how large the context',
  latch.check(estimate(999_999), 0) === null);

latch = createContextWarnLatch();
assert('never treats an unknown or invalid estimate as pressure',
  latch.check({ estimatedTokens: 999_999, messageCount: 1, windowTokens: undefined }, 0.8) === null &&
  latch.check(estimate(999_999, 0), 0.8) === null &&
  latch.check(estimate(999_999, -1), 0.8) === null &&
  latch.check(estimate(999_999, Number.NaN), 0.8) === null &&
  latch.check(estimate(Number.NaN), 0.8) === null &&
  latch.check(estimate(-1), 0.8) === null);

latch = createContextWarnLatch();
assert('an unknown estimate cannot dishonestly re-arm an already crossed latch',
  latch.check(estimate(800_000), 0.8) !== null &&
  latch.check({ estimatedTokens: 1, messageCount: 1, windowTokens: undefined }, 0.8) === null &&
  latch.check(estimate(900_000), 0.8) === null);

latch = createContextWarnLatch();
assert('a custom high threshold remains authoritative',
  latch.check(estimate(850_000), 0.9) === null && latch.check(estimate(900_000), 0.9) !== null);
assert('a fresh session latch may warn independently',
  createContextWarnLatch().check(estimate(900_000), 0.9) !== null);

assert('notice is one bounded line with the pressure, percent, /compact, and next broad-turn guidance',
  firstNotice !== null &&
  firstNotice.length <= 160 &&
  !firstNotice.includes('\n') &&
  firstNotice.includes('context pressure is high') &&
  firstNotice.includes('80%') &&
  firstNotice.includes('/compact') &&
  firstNotice.includes('before the next broad implementation or verification turn'));

header('/context — transcript-only integration');
latch = createContextWarnLatch();
let state: TurnState = initialTurnState;
const baseline = latch.check(estimate(700_000), 0.8);
if (baseline !== null) state = turnReducer(state, { type: 'notice', text: baseline, severity: 'warn' });
const crossing = latch.check(estimate(800_000), 0.8);
if (crossing !== null) state = turnReducer(state, { type: 'notice', text: crossing, severity: 'warn' });
const repeated = latch.check(estimate(900_000), 0.8);
if (repeated !== null) state = turnReducer(state, { type: 'notice', text: repeated, severity: 'warn' });
assert('baseline plus repeated high-pressure checks produce exactly one transcript notice',
  state.history.length === 1 && state.history[0]?.kind === 'notice' && state.history[0].text === crossing);
assert('the notice does not populate any live-frame turn state',
  state.liveText === '' && state.committedAnswer === '' && !state.thinking && state.activeTools.length === 0);

// ------------------------------------------------------------ breakdown (SER-077)

header('/context — breakdown rows');
const component = (label: string, tokens: number | undefined): ContextComponent => ({ label, tokens });
const breakdown: ContextBreakdown = {
  systemPrompt: [
    component(BASE_PROMPT_LABEL, 4_200),
    component(PROJECT_INSTRUCTIONS_LABEL, 8_900),
    component(SKILLS_CATALOGUE_LABEL, 500),
    component(WORKING_CONTEXT_LABEL, 300),
  ],
  builtinTools: component(BUILTIN_TOOLS_LABEL, 9_000),
  mcpServers: [component(`${MCP_TOOLS_LABEL_PREFIX}codegraph`, 3_000), component(`${MCP_TOOLS_LABEL_PREFIX}web-search`, undefined)],
  conversation: [component(USER_MESSAGES_LABEL, 90_000), component(ASSISTANT_MESSAGES_LABEL, 10_000)],
};
const measured: ContextEstimate = {
  estimatedTokens: 128_431, messageCount: 84, windowTokens: 200_000, measuredTokens: 126_900, tailTokens: 1_531,
};
const withRows = formatContextReportWithBreakdown(measured, breakdown).split('\n');
assert('the total line comes first and is byte-identical to the report without a breakdown',
  withRows[0] === formatContextReport(measured) &&
  withRows[0] === 'context — ~128,431 tokens (measured 126,900 + ~1,531 new) · 64% of 200,000 window · 84 message(s)');
assert('/status\'s context value is the same bytes whether or not a breakdown was rendered',
  formatContextValue(measured) === '~128,431 tokens (measured 126,900 + ~1,531 new) · 64% of 200,000 window · 84 message(s)');
assert('the caption names the rows as an estimate over the current request shape and keeps the total authoritative',
  withRows[1] === BREAKDOWN_CAPTION &&
  BREAKDOWN_CAPTION.includes('estimated over the current request shape') &&
  BREAKDOWN_CAPTION.includes('the total above is authoritative'));
assert('a known window renders `<label> ~N tokens · P%` per component, indented under the total',
  withRows[2] === '  system prompt · base ~4,200 tokens · 2%' &&
  withRows[3] === '  system prompt · project instructions (AGENTS.md) ~8,900 tokens · 4%' &&
  withRows[6] === '  tools · darwin built-ins ~9,000 tokens · 5%' &&
  withRows[9] === '  conversation · user prompts and tool results ~90,000 tokens · 45%');
assert('a nonzero share below one percent reads <1% on a row too, never 0%',
  withRows[4] === '  system prompt · skills catalogue ~500 tokens · <1%');
assert('a component whose count failed reads `not reported`, never 0',
  withRows[8] === '  tools · mcp web-search not reported' && !withRows.some((line) => /~0 tokens/.test(line)));
assert('rows follow composition order: system prompt sections, built-in tools, MCP servers, conversation',
  withRows.length === 11 && withRows[7] === '  tools · mcp codegraph ~3,000 tokens · 2%' &&
  withRows[10] === '  conversation · assistant replies and tool calls ~10,000 tokens · 5%');

const unknownWindow: ContextEstimate = { estimatedTokens: 1_234, messageCount: 3, windowTokens: undefined };
const withoutWindow = formatContextReportWithBreakdown(unknownWindow, breakdown).split('\n');
assert('an unknown window omits the share and keeps the token figure',
  withoutWindow[0] === formatContextReport(unknownWindow) &&
  withoutWindow[2] === '  system prompt · base ~4,200 tokens' &&
  !withoutWindow.slice(1).some((line) => line.includes('%')));

assert('a stated absence renders its reason instead of a count',
  formatContextBreakdown({
    ...breakdown,
    systemPrompt: [{ label: SKILLS_CATALOGUE_LABEL, tokens: undefined, absent: CATALOGUE_NOT_INJECTED }],
  }, 200_000)[1] === `  system prompt · skills catalogue ${CATALOGUE_NOT_INJECTED}`);

const manyServers = Array.from({ length: MAX_BREAKDOWN_SERVER_ROWS + 3 }, (_, index) =>
  component(`${MCP_TOOLS_LABEL_PREFIX}server-${index}`, 100 * (index + 1)));
const capped = formatContextBreakdown({ ...breakdown, mcpServers: manyServers }, 200_000);
// Caption, four prompt rows, the built-in row, then the capped server rows: the
// remainder line sits directly after the last shown server.
const remainderIndex = 1 + breakdown.systemPrompt.length + 1 + MAX_BREAKDOWN_SERVER_ROWS;
assert('MCP-server rows are capped at the existing MCP list bound with the remainder counted',
  capped.filter((line) => line.startsWith(`  ${MCP_TOOLS_LABEL_PREFIX}`)).length === MAX_BREAKDOWN_SERVER_ROWS &&
  capped[remainderIndex] === '  … 3 more servers' &&
  capped[remainderIndex - 1] === `  ${MCP_TOOLS_LABEL_PREFIX}server-${MAX_BREAKDOWN_SERVER_ROWS - 1} ~${MAX_BREAKDOWN_SERVER_ROWS * 100} tokens · <1%`);
assert('one server over the cap reads the singular',
  formatContextBreakdown({ ...breakdown, mcpServers: manyServers.slice(0, MAX_BREAKDOWN_SERVER_ROWS + 1) }, 200_000)
    .includes('  … 1 more server'));
assert('no MCP servers means no server rows and no remainder line',
  !formatContextBreakdown({ ...breakdown, mcpServers: [] }, 200_000).some((line) => line.includes('mcp') || line.includes('more server')));

header('/context — breakdown measurement over an injected counter');
const specs = {
  bash: { name: 'bash', description: 'shell', inputSchema: { type: 'object' } },
  cg: { name: 'codegraph_explore', description: 'graph', inputSchema: { type: 'object' } },
  ws: { name: 'search', description: 'web', inputSchema: { type: 'object' } },
} satisfies Record<string, ToolSpec>;
const tools = [
  { name: 'bash', toolSpec: specs.bash },
  { name: 'codegraph_explore', toolSpec: specs.cg },
  { name: 'search', toolSpec: specs.ws },
];
const servers: McpServerStatus[] = [
  { name: 'codegraph', state: 'connected', toolNames: ['codegraph_explore'] },
  { name: 'web-search', state: 'connected', toolNames: ['search'] },
  { name: 'ghost', state: 'failed', toolNames: [] },
];
const grouped = groupToolsByOrigin(tools, servers);
assert('tools are attributed to the server that registered their names; the rest are darwin\'s',
  grouped.builtinLabel === BUILTIN_TOOLS_LABEL &&
  grouped.builtins.length === 1 && grouped.builtins[0] === specs.bash &&
  grouped.servers.length === 3 &&
  grouped.servers[0]?.label === `${MCP_TOOLS_LABEL_PREFIX}codegraph` && grouped.servers[0].specs?.[0] === specs.cg &&
  grouped.servers[1]?.specs?.[0] === specs.ws &&
  grouped.servers[2]?.label === `${MCP_TOOLS_LABEL_PREFIX}ghost` && grouped.servers[2].specs?.length === 0);
const unreadable = groupToolsByOrigin(tools, [{ name: 'opaque', state: 'connected', toolNames: undefined }]);
assert('a server whose names cannot be read gets no specs, and the built-in row admits the unattributed tools',
  unreadable.builtinLabel === UNATTRIBUTED_TOOLS_LABEL && unreadable.builtins.length === 3 &&
  unreadable.servers[0]?.specs === undefined);

const base = 'BASE PROMPT';
const instructions = '<project-instructions source="AGENTS.md">\nrules\n</project-instructions>';
const catalogue = '<available_skills>\n<skill>\n<name>x</name>\n<description>y</description>\n</skill>\n</available_skills>';
const workingContext = '<working-context>\n- working directory: /w\n</working-context>';
const calls: { messages: number; options: CountTokensOptions }[] = [];
const counter: ComponentCounter = async (messages, options) => {
  calls.push({ messages: messages.length, options });
  if (options.toolSpecs?.[0] === specs.ws) throw new Error('counting refused');
  return heuristic.countTokens(messages, options);
};
const messages = [
  new Message({ role: 'user', content: [new TextBlock('hello')] }),
  new Message({ role: 'assistant', content: [new TextBlock('hi')] }),
  new Message({ role: 'user', content: [new TextBlock('more')] }),
];
const live = [
  new TextBlock(composeSystemPrompt(base, { fragment: instructions })),
  new TextBlock(catalogue),
  new TextBlock(workingContext),
  new CachePointBlock({ cacheType: 'default' }),
];
const measuredBreakdown = await measureContextBreakdown(
  { systemPrompt: live, composed: { base, instructions }, tools, servers, messages },
  counter,
);
assert('the system prompt is counted by section, from the composition seam strings, in composition order',
  measuredBreakdown.systemPrompt.map((row) => row.label).join('|') ===
    [BASE_PROMPT_LABEL, PROJECT_INSTRUCTIONS_LABEL, SKILLS_CATALOGUE_LABEL, WORKING_CONTEXT_LABEL].join('|') &&
  measuredBreakdown.systemPrompt[0]?.tokens === Math.ceil(base.length / 4) &&
  measuredBreakdown.systemPrompt[1]?.tokens === Math.ceil(instructions.length / 4) &&
  measuredBreakdown.systemPrompt[2]?.tokens === Math.ceil(catalogue.length / 4) &&
  measuredBreakdown.systemPrompt[3]?.tokens === Math.ceil(workingContext.length / 4));
assert('every component goes through the injected countTokens — exactly one call each, sections and tool groups apart',
  calls.length === 4 + 1 + 3 + 2 &&
  calls.filter((call) => call.options.systemPrompt !== undefined).length === 4 &&
  calls.filter((call) => call.options.toolSpecs !== undefined).length === 4);
assert('a component whose count threw is absent, never 0, while its neighbours are still counted',
  measuredBreakdown.mcpServers[1]?.tokens === undefined &&
  measuredBreakdown.mcpServers[0]?.tokens === Math.ceil(JSON.stringify(specs.cg).length / 2) &&
  measuredBreakdown.builtinTools.tokens === Math.ceil(JSON.stringify(specs.bash).length / 2));
assert('the conversation is counted by role over whole messages',
  measuredBreakdown.conversation[0]?.label === USER_MESSAGES_LABEL && measuredBreakdown.conversation[0].tokens === 3 &&
  measuredBreakdown.conversation[1]?.label === ASSISTANT_MESSAGES_LABEL && measuredBreakdown.conversation[1].tokens === 1 &&
  calls.filter((call) => call.options.systemPrompt === undefined && call.options.toolSpecs === undefined)
    .map((call) => call.messages).join(',') === '2,1');

const beforeInjection = await measureContextBreakdown(
  { systemPrompt: [new TextBlock(composeSystemPrompt(base, { fragment: instructions })), new TextBlock(workingContext)], composed: { base, instructions }, tools: [], servers: [], messages: [] },
  counter,
);
assert('before the plugin\'s first injection the catalogue row is a stated absence, not a failed count',
  beforeInjection.systemPrompt[2]?.label === SKILLS_CATALOGUE_LABEL &&
  beforeInjection.systemPrompt[2].tokens === undefined &&
  beforeInjection.systemPrompt[2].absent === CATALOGUE_NOT_INJECTED);

const restored = await measureContextBreakdown(
  { systemPrompt: [new TextBlock(`${base}\n\nolder AGENTS.md text`), new TextBlock(workingContext)], composed: { base, instructions }, tools: [], servers: [], messages: [] },
  counter,
);
assert('a restored prompt that no longer matches the composition is counted whole rather than split by guess',
  restored.systemPrompt[0]?.label === RESTORED_PROMPT_LABEL &&
  restored.systemPrompt[0].tokens === Math.ceil(`${base}\n\nolder AGENTS.md text`.length / 4) &&
  restored.systemPrompt.length === 3);

const noInstructions = await measureContextBreakdown(
  { systemPrompt: [new TextBlock(base), new TextBlock(workingContext)], composed: { base, instructions: undefined }, tools: [], servers: [], messages: [] },
  counter,
);
assert('without an AGENTS.md there is no project-instructions row',
  noInstructions.systemPrompt.map((row) => row.label).join('|') === [BASE_PROMPT_LABEL, SKILLS_CATALOGUE_LABEL, WORKING_CONTEXT_LABEL].join('|'));

const foreign = await measureContextBreakdown(
  { systemPrompt: 'a plain string prompt', composed: { base, instructions }, tools: [], servers: [], messages: [] },
  counter,
);
assert('a prompt in a shape Darwin does not own is counted whole, never re-parsed',
  foreign.systemPrompt.length === 1 && foreign.systemPrompt[0]?.label === WHOLE_PROMPT_LABEL &&
  foreign.systemPrompt[0].tokens === Math.ceil('a plain string prompt'.length / 4));

report();

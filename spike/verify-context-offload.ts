/**
 * Offline contracts for the flag-gated SDK ContextOffloader.
 *
 * No model calls and no network: a fake model asks for one tool call whose result
 * is deliberately larger than the offload threshold, and the assertions are on
 * what ends up in the conversation and in the tool catalogue.
 *
 * `excludeTools` (SRF-024): a tool named in the option is never offloaded — live or
 * during the restored-history repair — and the runtime names exactly `load_skill`,
 * so a skill body always reaches the model whole in one round.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';

import {
  Agent,
  ContextWindowOverflowError,
  Message,
  Model,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  tool,
  type BaseModelConfig,
  type ModelStreamEvent,
  type Tool,
} from '@strands-agents/sdk';
import { ContextOffloader } from '@strands-agents/sdk/vended-plugins/context-offloader';
import { LocalFileStorage } from '@strands-agents/sdk/storage';
import { z } from 'zod';

import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { classify } from '../src/agent/permission.js';
import { sessionPaths } from '../src/agent/session.js';
import { configPath } from '../src/config.js';
import { darwinDir } from '../src/paths.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const ROOT = '/tmp/darwin-context-offload-test';
const HUGE = 'x'.repeat(40_000);
// A skill body well above the runtime's 5,000-token threshold (chars/4 heuristic) and
// distinct from HUGE, so a whole body and a repaired sibling are told apart by content.
const SKILL_BODY = `# skill body\n${'s'.repeat(30_000)}\n`;
ownPrivateHome('context-offload-runtime');

class RuntimeOverflowModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.runtime-overflow', contextWindowLimit: 200_000 };
  calls = 0;
  seen: Message[] = [];

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    this.seen = messages.map((message) => message.clone());
    const resultText = messages.flatMap((message) => message.content.flatMap((block) =>
      block.type === 'toolResultBlock'
        ? block.content.flatMap((content) => content.type === 'textBlock' ? [content.text] : [])
        : [],
    )).join('');
    // An unrepaired legacy HUGE result is what overflows; a repaired preview plus a
    // whole excluded skill body must not.
    if (resultText.includes(HUGE)) throw new ContextWindowOverflowError('fixture runtime overflow');
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'bounded runtime resume' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

class OneToolCallModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.offload', contextWindowLimit: 200_000 };
  private readonly toolNames: readonly string[];
  /** What the last request carried — the model's view, after every hook ran. */
  seen: Message[] = [];

  // One tool call per round, in order, until every named tool has a result.
  constructor(toolName: string | readonly string[] = 'bigOutput') {
    super();
    this.toolNames = typeof toolName === 'string' ? [toolName] : toolName;
  }

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.seen = messages.map((message) => message.clone());
    const results = messages.reduce((count, message) =>
      count + message.content.filter((block) => block.type === 'toolResultBlock').length, 0);
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (results < this.toolNames.length) {
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: this.toolNames[results] as string, toolUseId: `offload-${results + 1}` },
      };
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: '{}' },
      };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'ok' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

const bigOutput = tool({
  name: 'bigOutput',
  description: 'returns a deliberately oversized payload',
  inputSchema: z.object({}),
  callback: () => HUGE,
});

// The shape darwin's `bash` tool returns: a json block whose `output` field holds the
// whole multi-line command output. Stored as `JSON.stringify(json, null, 2)`, that field
// is one escaped line — the case the retrieval projection exists for. Three `## heading`
// lines sit before `line 1`, `line 101` and `line 201`, so headings and numbered lines
// interleave and the projected line numbers are not the `line N` numbers.
const BASH_OUTPUT_LINES: string[] = [];
for (let n = 1; n <= 300; n++) {
  if ((n - 1) % 100 === 0) BASH_OUTPUT_LINES.push(`## heading ${(n - 1) / 100 + 1}`);
  BASH_OUTPUT_LINES.push(`line ${n}`);
}
const BASH_JSON = {
  cwd: '/tmp/darwin-context-offload-test/json',
  error: '',
  exitCode: 0,
  output: BASH_OUTPUT_LINES.join('\n'),
};
const bashShaped = tool({
  name: 'bashShaped',
  description: 'returns a bash-shaped json result with a 300-line output field',
  inputSchema: z.object({}),
  callback: () => BASH_JSON,
});

// Named exactly like the skills plugin's tool: the exclusion is by name, not identity.
const loadSkillShaped = tool({
  name: 'load_skill',
  description: 'returns an oversized skill body as one text block',
  inputSchema: z.object({}),
  callback: () => SKILL_BODY,
});

/** The documented rendering rule, applied by hand to the bash-shaped fixture. */
const EXPECTED_PROJECTION: string[] = [
  '{',
  `  "cwd": ${JSON.stringify(BASH_JSON.cwd)},`,
  '  "error": "",',
  '  "exitCode": 0,',
  '  "output":',
  ...BASH_OUTPUT_LINES,
  '}',
];

/** Parses `searchContent` rows (`> 12| text` / `  12| text`) into their parts. */
function parseSearchRows(text: string): { line: number; matched: boolean; text: string }[] {
  const rows: { line: number; matched: boolean; text: string }[] = [];
  for (const row of text.split('\n')) {
    const match = /^([> ]) +(\d+)\| (.*)$/.exec(row);
    if (match) rows.push({ line: Number(match[2]), matched: match[1] === '>', text: match[3] as string });
  }
  return rows;
}

function textOf(result: { content: readonly unknown[] }): string {
  return (result.content as readonly { text?: string }[]).map((block) => block.text ?? '').join('');
}

/** The offloader's framed on-disk format for unified Storage: [2-byte BE length][contentType][content]. */
function frameStored(content: string, contentType: string): Uint8Array {
  const ctBytes = new TextEncoder().encode(contentType);
  const bodyBytes = new TextEncoder().encode(content);
  const frame = new Uint8Array(2 + ctBytes.length + bodyBytes.length);
  frame[0] = (ctBytes.length >> 8) & 0xff;
  frame[1] = ctBytes.length & 0xff;
  frame.set(ctBytes, 2);
  frame.set(bodyBytes, 2 + ctBytes.length);
  return frame;
}

function unframeStored(frame: Uint8Array): { contentType: string; content: string } {
  const ctLen = ((frame[0] as number) << 8) | (frame[1] as number);
  return {
    contentType: new TextDecoder().decode(frame.subarray(2, 2 + ctLen)),
    content: new TextDecoder().decode(frame.subarray(2 + ctLen)),
  };
}

/** Mirrors the runtime's own assembly: plugin present only when the flag is on. */
function makeAgent(
  offload: boolean,
  directory: string,
  fixture: { name: string; tool: Tool } | { name: string; tool: Tool }[] = { name: 'bigOutput', tool: bigOutput },
  excludeTools?: readonly string[],
): { agent: Agent; model: OneToolCallModel } {
  const fixtures = Array.isArray(fixture) ? fixture : [fixture];
  const offloader = offload
    ? new ContextOffloader({
        storage: new LocalFileStorage(directory),
        evictAfterCycles: null,
        // previewTokens must stay below maxResultTokens (the SDK enforces it), so
        // the fixture sets both rather than leaning on the 1000-token default.
        maxResultTokens: 200,
        previewTokens: 50,
        ...(excludeTools !== undefined && { excludeTools }),
      })
    : undefined;
  const model = new OneToolCallModel(fixtures.map((entry) => entry.name));
  const agent = new Agent({
    model,
    tools: fixtures.map((entry) => entry.tool),
    plugins: offloader === undefined ? [] : [offloader],
    printer: false,
  });
  return { agent, model };
}

function toolResultText(agent: Agent): string {
  const parts: string[] = [];
  for (const message of agent.messages) {
    for (const block of message.content) {
      if (block.type !== 'toolResultBlock') continue;
      for (const inner of (block as { content?: readonly unknown[] }).content ?? []) {
        const typed = inner as { type?: string; text?: string };
        if (typeof typed.text === 'string') parts.push(typed.text);
      }
    }
  }
  return parts.join('\n');
}

await rm(ROOT, { recursive: true, force: true });

header('context offload — flag on');
const { agent: on } = makeAgent(true, path.join(ROOT, 'on'));
await on.initialize();
assert('the retrieval tool is registered when offloading is on',
  on.tools.some((entry) => entry.name === 'retrieve_offloaded_content'));
await on.invoke('go');
const onText = toolResultText(on);
assert('an oversized result is not carried verbatim in the conversation',
  !onText.includes(HUGE) && onText.length < HUGE.length);
assert('…and something is left behind as a preview or reference', onText.trim() !== '');

header('context offload — flag off');
const { agent: off } = makeAgent(false, path.join(ROOT, 'off'));
await off.initialize();
assert('the retrieval tool is absent when offloading is off',
  !off.tools.some((entry) => entry.name === 'retrieve_offloaded_content'));
await off.invoke('go');
assert('the oversized result stays verbatim without the plugin',
  toolResultText(off).includes(HUGE));

header('context offload — references survive a process boundary');
// The premise behind both `evictAfterCycles: null` and the absence of offload
// cleanup (see runtime.ts): a *fresh* agent and plugin over the same directory
// — a stand-in for the next `--resume`d process — must still resolve a
// reference the previous one stored. Deleting or evicting would break exactly
// this, which is why the accumulation is documented rather than bounded.
const { readdir } = await import('node:fs/promises');
const storedKeys = await readdir(path.join(ROOT, 'on', 'offloader'));
const firstKey = storedKeys[0] as string;
assert('the first process left at least one stored block behind', storedKeys.length > 0);
const { agent: resumed } = makeAgent(true, path.join(ROOT, 'on'));
await resumed.initialize();
const resumedRetrieval = resumed.tool['retrieve_offloaded_content'];
assert('a fresh agent over the same storage registers the retrieval tool', resumedRetrieval !== undefined);
const retrieved = await resumedRetrieval!.invoke({ reference: firstKey }, { recordDirectToolCall: false });
const retrievedText = (retrieved.content as readonly { text?: string }[])
  .map((block) => block.text ?? '')
  .join('');
assert('the stored reference resolves to the full offloaded content',
  retrieved.status !== 'error' && retrievedText.includes(HUGE));

header('context offload — json results are searched through a line-preserving projection');
// Stored json is `JSON.stringify(json, null, 2)`, so a bash result's 300-line `output`
// is one escaped line and pattern/line_range used to see a six-line document. The pinned
// patch projects the parsed JSON per call — multi-line string fields expanded onto real
// lines — for search only; the bytes, the preview and full retrieval are unchanged.
const jsonDir = path.join(ROOT, 'json');
const { agent: jsonAgent } = makeAgent(true, jsonDir, { name: 'bashShaped', tool: bashShaped });
await jsonAgent.initialize();
await jsonAgent.invoke('go');
const jsonKeys = await readdir(path.join(jsonDir, 'offloader'));
const jsonKey = jsonKeys[0] as string;
assert('the bash-shaped json result was offloaded to exactly one stored block', jsonKeys.length === 1);
const storedFrame = unframeStored(new Uint8Array(await readFile(path.join(jsonDir, 'offloader', jsonKey))));
assert('the stored bytes on disk are still JSON.stringify(json, null, 2) under application/json',
  storedFrame.contentType === 'application/json' && storedFrame.content === JSON.stringify(BASH_JSON, null, 2));
assert('the offload marker preview is still cut from the stored pretty JSON, not the projection',
  toolResultText(jsonAgent).includes('{\n  "cwd": ') && !toolResultText(jsonAgent).includes('"output":\n'));
const jsonRetrieval = jsonAgent.tool['retrieve_offloaded_content']!;

const ranged = await jsonRetrieval.invoke({ reference: jsonKey, line_range: { start: 100, end: 120 } }, { recordDirectToolCall: false });
const rangedText = textOf(ranged);
const rangedRows = parseSearchRows(rangedText);
assert('line_range {100,120} on the projection reports the projected line count in its header',
  rangedText.startsWith(`[Lines 100-120 of ${EXPECTED_PROJECTION.length}]`));
assert('…returns exactly projected lines 100–120 and nothing else',
  rangedRows.length === 21 && rangedRows.every((row, i) => row.line === 100 + i));
assert('…whose text is the output lines the rendering rule places there (line 94 … line 100, ## heading 2, line 101 … line 113)',
  rangedRows.every((row) => row.text === EXPECTED_PROJECTION[row.line - 1])
    && rangedRows[0]!.text === 'line 94'
    && rangedRows.some((row) => row.text === '## heading 2')
    && rangedRows[20]!.text === 'line 113'
    && !rangedText.includes('line 93') && !rangedText.includes('line 114'));
const rangedAgain = textOf(await jsonRetrieval.invoke({ reference: jsonKey, line_range: { start: 100, end: 120 } }, { recordDirectToolCall: false }));
assert('the projection is rebuilt identically per call, so line numbers stay valid across calls', rangedAgain === rangedText);

const headingsOnly = await jsonRetrieval.invoke({ reference: jsonKey, pattern: '^## ', context_lines: 0 }, { recordDirectToolCall: false });
const headingRows = parseSearchRows(textOf(headingsOnly));
assert('pattern ^## reports the three heading matches on the projection',
  textOf(headingsOnly).startsWith('[3 matches for /^## /]'));
assert('…and with zero context returns only the heading lines, each marked as a match',
  headingRows.length === 3 && headingRows.every((row) => row.matched && row.text.startsWith('## heading '))
    && headingRows.map((row) => row.line).join(',') === '6,107,208');
const headingsCtx = parseSearchRows(textOf(await jsonRetrieval.invoke({ reference: jsonKey, pattern: '^## ', context_lines: 2 }, { recordDirectToolCall: false })));
assert('…and with context the extra rows are the neighbouring projected lines, unmatched',
  headingsCtx.filter((row) => row.matched).length === 3
    && headingsCtx.filter((row) => !row.matched).length === 12
    && headingsCtx.filter((row) => !row.matched).every((row) =>
      row.text === EXPECTED_PROJECTION[row.line - 1] && [6, 107, 208].some((match) => Math.abs(match - row.line) <= 2))
    && headingsCtx.some((row) => row.line === 106 && row.text === 'line 100' && !row.matched));

const beyond = textOf(await jsonRetrieval.invoke({ reference: jsonKey, line_range: { start: 1000, end: 1010 } }, { recordDirectToolCall: false }));
assert('a line_range past the end errors with the projected line count, not the six stored lines',
  beyond === `Error: line_range.start (1000) is beyond content length (${EXPECTED_PROJECTION.length} lines).`
    && EXPECTED_PROJECTION.length > 300);

const full = await jsonRetrieval.invoke({ reference: jsonKey }, { recordDirectToolCall: false });
const fullBlock = full.content[0] as { type?: string; json?: unknown };
assert('a full retrieval (no pattern/range/context) is still the parsed JSON, deepEqual to the original value',
  full.status !== 'error' && fullBlock.type === 'jsonBlock' && isDeepStrictEqual(fullBlock.json, BASH_JSON));

const rawJsonKey = 'raw-json-ref';
await writeFile(path.join(jsonDir, 'offloader', rawJsonKey), frameStored('first\nsecond {not json\nthird', 'application/json'));
const rawSearch = textOf(await jsonRetrieval.invoke({ reference: rawJsonKey, pattern: 'second', context_lines: 0 }, { recordDirectToolCall: false }));
const rawBeyond = textOf(await jsonRetrieval.invoke({ reference: rawJsonKey, line_range: { start: 9, end: 9 } }, { recordDirectToolCall: false }));
assert('an application/json reference holding non-JSON bytes still searches the raw text line by line',
  rawSearch.startsWith('[1 match for /second/]') && parseSearchRows(rawSearch).map((row) => `${row.line}:${row.text}`).join() === '2:second {not json'
    && rawBeyond === 'Error: line_range.start (9) is beyond content length (3 lines).');

const plainKey = 'plain-text-ref';
const plainJsonLooking = JSON.stringify({ output: 'alpha\nbeta' }, null, 2);
await writeFile(path.join(jsonDir, 'offloader', plainKey), frameStored(plainJsonLooking, 'text/plain'));
const plainRange = textOf(await jsonRetrieval.invoke({ reference: plainKey, line_range: { start: 1, end: 10 } }, { recordDirectToolCall: false }));
const plainSearch = textOf(await jsonRetrieval.invoke({ reference: plainKey, pattern: 'beta', context_lines: 0 }, { recordDirectToolCall: false }));
assert('a text/plain result is never projected, even when its text happens to be JSON with an escaped newline',
  plainRange.startsWith('[Lines 1-3 of 3]') && parseSearchRows(plainRange).map((row) => row.text).join('\n') === plainJsonLooking
    && parseSearchRows(plainSearch).map((row) => `${row.line}:${row.text}`).join() === '2:  "output": "alpha\\nbeta"');
const retrievalDescription = jsonAgent.tools.find((entry) => entry.name === 'retrieve_offloaded_content')!.description;
assert('the retrieval tool description states the json projection in one bounded sentence',
  retrievalDescription.includes('For json content, line-based search operates on a readable projection in which multi-line string fields')
    && retrievalDescription.includes('pattern/line_range/context_lines only work on text content.'));

header('context offload — excludeTools keeps a named tool result whole (SRF-024)');
// The runtime excludes exactly `load_skill`: a skill body must reach the model whole in
// one round, because the 1,000-token preview is not the skill and a retrieval round
// replays the entire context. The same agent still offloads every other oversized result.
const excludeDir = path.join(ROOT, 'exclude');
const { agent: excludeAgent, model: excludeModel } = makeAgent(
  true,
  excludeDir,
  [{ name: 'load_skill', tool: loadSkillShaped }, { name: 'bashShaped', tool: bashShaped }],
  ['load_skill'],
);
await excludeAgent.initialize();
await excludeAgent.invoke('go');
const excludeResults = excludeAgent.messages.flatMap((message) =>
  message.content.filter((block): block is ToolResultBlock => block instanceof ToolResultBlock));
const skillResult = excludeResults.find((block) => block.toolUseId === 'offload-1');
const bashResult = excludeResults.find((block) => block.toolUseId === 'offload-2');
assert('both tool calls ran and left one result each in the conversation',
  excludeResults.length === 2 && skillResult !== undefined && bashResult !== undefined);
assert('the oversized load_skill result is one text block byte-identical to the skill body — no [Offloaded marker',
  skillResult!.content.length === 1
    && skillResult!.content[0] instanceof TextBlock
    && (skillResult!.content[0] as TextBlock).text === SKILL_BODY
    && !textOf(skillResult!).includes('[Offloaded'));
const excludeSeenSkill = excludeModel.seen.flatMap((message) => message.content.flatMap((block) =>
  block instanceof ToolResultBlock && block.toolUseId === 'offload-1'
    ? block.content.flatMap((content) => content instanceof TextBlock ? [content.text] : [])
    : [],
)).join('');
assert('…and the model\'s final request carried that whole body, not a preview', excludeSeenSkill === SKILL_BODY);
assert('the same-size bash-shaped result in the same agent is still offloaded',
  textOf(bashResult!).startsWith('[Offloaded: 1 blocks') && textOf(bashResult!).includes('[Stored references:]'));
const excludeKeys = await readdir(path.join(excludeDir, 'offloader'));
assert('exactly one block is stored — the bash result; no reference exists for the excluded load_skill result',
  excludeKeys.length === 1 && excludeKeys[0]!.startsWith('offload-2') && !excludeKeys.some((key) => key.startsWith('offload-1')));

const excludeStorage = () => new LocalFileStorage(path.join(ROOT, 'exclude-validation'));
function offloaderThrows(excludeTools: unknown): string | undefined {
  try {
    new ContextOffloader({ storage: excludeStorage(), excludeTools: excludeTools as readonly string[] });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
assert('the constructor rejects an empty tool name with a clear error',
  offloaderThrows(['']) === 'excludeTools must be an array of non-empty tool names');
assert('…and a non-string entry', offloaderThrows([42]) === 'excludeTools must be an array of non-empty tool names');
assert('…and a bare string instead of an array', offloaderThrows('load_skill') !== undefined);
assert('an empty array and an omitted option both mean no exclusion and construct fine',
  offloaderThrows([]) === undefined && offloaderThrows(undefined) === undefined);
const { agent: noExclusion } = makeAgent(true, path.join(ROOT, 'no-exclusion'), { name: 'load_skill', tool: loadSkillShaped }, []);
await noExclusion.initialize();
await noExclusion.invoke('go');
assert('with excludeTools: [] an oversized load_skill result is offloaded like any other',
  toolResultText(noExclusion).startsWith('[Offloaded: 1 blocks') && !toolResultText(noExclusion).includes(SKILL_BODY));

header('context offload — default main runtime repairs a resumable legacy snapshot');
const resumeRoot = path.join(ROOT, 'runtime-resume-project');
await mkdir(resumeRoot, { recursive: true });
const legacyRuntimeModel = new RuntimeOverflowModel();
setRuntimeModelFactoryForTest(async () => legacyRuntimeModel);
let seededRuntime: AgentRuntime | undefined;
let resumedRuntime: AgentRuntime | undefined;
try {
  seededRuntime = await AgentRuntime.create({
    projectRoot: resumeRoot,
    session: { kind: 'new' },
    permissionBridge: async () => ({ allowed: false }),
  });
  const sessionId = seededRuntime.info.sessionId;
  const agent = (seededRuntime as unknown as { agent: Agent }).agent;
  const toolUseId = 'runtime-legacy-tool-use';
  const skillToolUseId = 'runtime-legacy-load-skill';
  agent.messages.push(
    new Message({
      role: 'user',
      content: [new TextBlock('retain runtime legacy prompt')],
    }),
    new Message({
      role: 'assistant',
      content: [new ToolUseBlock({ name: 'legacyTool', toolUseId, input: {} })],
    }),
    new Message({
      role: 'user',
      content: [new ToolResultBlock({
        toolUseId,
        status: 'success',
        content: [new TextBlock(HUGE)],
      })],
    }),
    // A historical oversized `load_skill` result sits beside the legacy one: the repair
    // scan must skip it by tool-use name exactly as it skips delegation/retrieval ids.
    new Message({
      role: 'assistant',
      content: [new ToolUseBlock({ name: 'load_skill', toolUseId: skillToolUseId, input: { name: 'developer' } })],
    }),
    new Message({
      role: 'user',
      content: [new ToolResultBlock({
        toolUseId: skillToolUseId,
        status: 'success',
        content: [new TextBlock(SKILL_BODY)],
      })],
    }),
  );
  await agent.sessionManager!.saveSnapshot({ target: agent, isLatest: true });
  await seededRuntime.shutdown();
  seededRuntime = undefined;

  resumedRuntime = await AgentRuntime.create({
    projectRoot: resumeRoot,
    session: { kind: 'id', sessionId },
    permissionBridge: async () => ({ allowed: false }),
  });
  for await (const _event of resumedRuntime.send('resume through the real runtime')) {
    // Consume the ordinary runtime stream so invocation autosave completes.
  }
  const seenResults = legacyRuntimeModel.seen.flatMap((message) =>
    message.content.filter((block): block is ToolResultBlock => block instanceof ToolResultBlock));
  const seenText = seenResults.flatMap((block) =>
    block.content.flatMap((content) => content instanceof TextBlock ? [content.text] : [])).join('');
  assert('the real resumed runtime repairs legacy history before its first provider request',
    legacyRuntimeModel.calls === 1 && seenText.includes('[Stored references:]') && !seenText.includes(HUGE));
  const seenSkill = seenResults.find((block) => block.toolUseId === skillToolUseId);
  assert('…while the historical oversized load_skill result reaches the provider whole, untouched by the repair',
    seenSkill !== undefined && seenSkill.content.length === 1
      && (seenSkill.content[0] as TextBlock).text === SKILL_BODY
      && !textOf(seenSkill).includes('[Offloaded'));
  const resumeOffloadKeys = await readdir(path.join(sessionPaths(resumeRoot).sessionsDir, sessionId, 'offload', 'offloader'));
  assert('the repair stored exactly the legacy block and nothing for load_skill',
    resumeOffloadKeys.length === 1 && resumeOffloadKeys[0]!.startsWith(toolUseId));
} finally {
  await seededRuntime?.shutdown();
  await resumedRuntime?.shutdown();
  setRuntimeModelFactoryForTest(undefined);
}

header('context offload — permission classification');
const retrieval = classify('retrieve_offloaded_content', { reference: 'offloader/abc' });
assert('the retrieval tool is classified read, so it is statically safe',
  retrieval.kind === 'read');
assert('…and its summary names the reference it will read',
  retrieval.summary.includes('offloader/abc'));
const missingReference = classify('retrieve_offloaded_content', {});
assert('a missing reference still classifies as read rather than falling through',
  missingReference.kind === 'read' && missingReference.summary.includes('no reference'));
const unknownTool = classify('some_unregistered_tool', {});
assert('unrelated unknown tools still fail closed as execute', unknownTool.kind === 'execute');

header('context offload — main runtime default, opt-out, and process override');
const runtimeRoot = path.join(ROOT, 'runtime-project');
await mkdir(path.join(darwinDir(runtimeRoot), 'agents'), { recursive: true });
await writeFile(
  path.join(darwinDir(runtimeRoot), 'agents', 'retrieval-child.md'),
  '---\nname: retrieval-child\ndescription: Probe parent-only offload retrieval.\ntools: [retrieve_offloaded_content]\n---\n\nReport your tool catalogue.\n',
);

const defaultRuntime = await AgentRuntime.create({
  projectRoot: runtimeRoot,
  session: { kind: 'new' },
  permissionBridge: async () => ({ allowed: false }),
});
try {
  assert('a default main runtime registers the retrieval tool',
    defaultRuntime.info.toolNames.includes('retrieve_offloaded_content'));
  assert('the effective default is visible in loaded config', defaultRuntime.config.contextOffload === true);
  assert('child definitions cannot request the parent session retrieval capability',
    defaultRuntime.info.agentProblems.some((problem) =>
      problem.file.endsWith('retrieval-child.md') && problem.reason.includes('unknown tool')));
  const runtimeSource = await readFile(new URL('../src/agent/runtime.ts', import.meta.url), 'utf8');
  const childRecipeSource = await readFile(new URL('../src/agents/child-recipe.ts', import.meta.url), 'utf8');
  assert('the parent runtime passes exactly one exclusion, load_skill, to its ContextOffloader',
    runtimeSource.split("excludeTools: ['load_skill']").length === 2 && runtimeSource.split('excludeTools: [').length === 2);
  assert('children construct no ContextOffloader, so no exclusion is theirs to configure',
    !childRecipeSource.includes('ContextOffloader'));
} finally {
  await defaultRuntime.shutdown();
}

await writeFile(configPath(runtimeRoot), JSON.stringify({ contextOffload: false }));
const optedOut = await AgentRuntime.create({
  projectRoot: runtimeRoot,
  session: { kind: 'new' },
  permissionBridge: async () => ({ allowed: false }),
});
try {
  assert('explicit false omits the retrieval tool',
    !optedOut.info.toolNames.includes('retrieve_offloaded_content'));
  assert('the persistent opt-out remains visible in loaded config', optedOut.config.contextOffload === false);
} finally {
  await optedOut.shutdown();
}

const forcedOn = await AgentRuntime.create({
  projectRoot: runtimeRoot,
  session: { kind: 'new' },
  permissionBridge: async () => ({ allowed: false }),
  contextOffloadOverride: true,
});
try {
  assert('the process override forces the retrieval tool back on',
    forcedOn.info.toolNames.includes('retrieve_offloaded_content'));
  assert('the process override does not mutate loaded config', forcedOn.config.contextOffload === false);
} finally {
  await forcedOn.shutdown();
}

await rm(ROOT, { recursive: true, force: true });
report();

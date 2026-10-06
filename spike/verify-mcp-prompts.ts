/**
 * SER-114 — MCP server prompts as user-invoked slash commands.
 *
 * Free suite: no provider call and no network. Real stdio MCP fixture processes
 * (`spike/fixtures/prompts-mcp.mjs`, one per mode, each logging every message it
 * receives), the real `AgentRuntime` over the offline `CaptureModel`, the real
 * headless drivers, an owned HOME and project.
 *
 * Requirement → check (every Acceptance item of the backlog record):
 *  - discovery counts and skips ............................ `discovery`, `runtime catalogue`
 *  - bounded: 64/server, page cap, one timeout, failure warning `discovery`, `runtime catalogue`
 *  - zero prompt requests to prompt-less / failed / held ...... `runtime catalogue` logs, `trust`
 *  - never listTools()/reconnect for discovery ................ `runtime catalogue` logs
 *  - sanitized names; collisions skipped, never shadowing ..... `naming`, `runtime catalogue`
 *  - argument mapping and usage errors, no server/model call .. `invocation`
 *  - exact expanded text sent once, literal recorded once ..... `drivers`
 *  - omission notice (assistant + non-text counted) ........... `invocation`, `drivers`
 *  - over-cap refusal at the trajectory field cap ............. `projection`, `invocation`
 *  - server error → bounded failure; cancel and timeout ....... `invocation`
 *  - /mcp counts from the cache, no fetch ..................... `mcp report`
 *  - custom-command and skill expansion byte-identical ........ `unchanged`
 *  - no new tool, nothing in the system prompt ................ `drivers`
 *  - discovery reused by a /clear successor (asked once) ...... `clear`
 * Completion order and the TUI surfaces are proved through a real pty in
 * `spike/verify-mcp-prompts-pty.ts`.
 *
 * Run: pnpm tsx spike/verify-mcp-prompts.ts
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { McpClient } from '@strands-agents/sdk';

import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { inventoryWorkspace } from '../src/agent/workspace-trust.js';
import { BUILTIN_COMMAND_NAMES, claimedCommandNames, COMMANDS_DIRNAME } from '../src/commands/custom-commands.js';
import { configPath } from '../src/config.js';
import { runHeadlessTurn } from '../src/headless.js';
import { runStructuredHeadlessTurn, StructuredHeadlessWriter } from '../src/headless-protocol.js';
import {
  buildMcpPromptCatalogue,
  composeMcpPromptResult,
  discoverMcpPrompts,
  expandMcpPrompt,
  mapMcpPromptArguments,
  matchMcpPromptCommand,
  MAX_MCP_PROMPT_LIST_PAGES,
  MAX_MCP_PROMPT_PROBLEMS,
  MAX_MCP_PROMPT_RESULT_CHARS,
  MAX_MCP_PROMPTS_PER_SERVER,
  mcpPromptCommandName,
  McpPromptError,
  sanitizeMcpPromptPart,
  type McpPromptCommand,
  type McpPromptDiscovery,
} from '../src/mcp/prompts.js';
import { MAX_FIELD_CHARS } from '../src/trajectory/record.js';
import { darwinDir, userDarwinDir } from '../src/paths.js';
import { SKILLS_DIRNAME } from '../src/skills/loader.js';
import { formatMcpReport } from '../src/tui/mcp-format.js';
import { CaptureModel } from './offline-model.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const HOME = ownPrivateHome('mcp-prompts');
const ROOT = path.join(HOME, 'project');
const LOGS = path.join(HOME, 'logs');
const FIXTURE = path.resolve(import.meta.dirname, 'fixtures/prompts-mcp.mjs');

function server(mode: string, log?: string): Record<string, unknown> {
  return { command: process.execPath, args: [FIXTURE, '--mode', mode, ...(log === undefined ? [] : ['--log', path.join(LOGS, log)])] };
}

async function requests(log: string): Promise<{ method: string; params?: Record<string, unknown> }[]> {
  const file = path.join(LOGS, log);
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function count(log: string, method: string | RegExp): Promise<number> {
  return (await requests(log)).filter((entry) => typeof method === 'string' ? entry.method === method : method.test(entry.method)).length;
}

async function rejects(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
}

function lastPrompt(model: CaptureModel): string | undefined {
  return model.calls.at(-1)?.messages.at(-1)?.content.map((block) => (block.type === 'textBlock' ? block.text : '')).join('');
}

const fakeClient = { clientName: 'srv', connectionState: 'connected' } as unknown as McpClient;
function command(partial: Partial<McpPromptCommand> = {}): McpPromptCommand {
  return { name: 'mcp__srv__p', server: 'srv', prompt: 'p', arguments: [], client: fakeClient, ...partial };
}

function testNaming(): void {
  header('naming — sanitized to the command grammar, collisions skipped and reported');
  // `/`, `é` and the three code points of 👩‍💻 (ZWJ sequence) each become one `_`.
  assert('every non [A-Za-z0-9_-] code point becomes _', sanitizeMcpPromptPart('a.b c/é👩‍💻-_Z9') === `a_b_c${'_'.repeat(5)}-_Z9`);
  assert('canonical form /mcp__<server>__<prompt>', mcpPromptCommandName('my.server', 'do it') === 'mcp__my_server__do_it');
  assert('sanitized names fit the custom-command name grammar', /^[a-zA-Z0-9_-]+$/.test(mcpPromptCommandName('ü ß', '日本')));

  const claimed = claimedCommandNames(['my-skill', 'mcp__srv__skill'], { commands: [{ name: 'mcp__srv__custom', file: '/c.md', content: 'x' }], problems: [] });
  assert('claims cover every built-in and /quit', [...BUILTIN_COMMAND_NAMES, 'quit'].every((name) => claimed.get(name)?.startsWith('built-in command')));
  // A built-in can never collide structurally (no built-in contains `__`), so the
  // built-in owner is proved through the same map with a synthetic claim.
  claimed.set('mcp__srv__builtin', 'built-in command /mcp__srv__builtin');
  const discovery: McpPromptDiscovery = {
    listings: [{
      server: 'srv', client: fakeClient, problems: [], skipped: 0,
      prompts: ['skill', 'custom', 'builtin', 'a.b', 'a_b', 'A_B', 'ok'].map((name) => ({ name, arguments: [] })),
    }],
  };
  const catalogue = buildMcpPromptCatalogue(discovery, claimed);
  assert('only non-colliding prompts are offered, first sanitized owner wins',
    JSON.stringify(catalogue.commands.map((entry) => [entry.name, entry.prompt])) === JSON.stringify([['mcp__srv__a_b', 'a.b'], ['mcp__srv__ok', 'ok']]));
  assert('each skip names the owner it would have shadowed',
    catalogue.problems.length === 5 &&
    catalogue.problems[0]!.includes('conflicts with skill /mcp__srv__skill') &&
    catalogue.problems[1]!.includes('conflicts with custom command /mcp__srv__custom') &&
    catalogue.problems[2]!.includes('conflicts with built-in command') &&
    catalogue.problems[3]!.includes('conflicts with mcp prompt "a.b"'));
  assert('server summary counts offered and skipped', JSON.stringify(catalogue.servers.get('srv')) === JSON.stringify({ commands: ['mcp__srv__a_b', 'mcp__srv__ok'], skipped: 5 }));
  assert('existing owners keep their names (claims unchanged)', claimed.get('mcp__srv__skill') === 'skill /mcp__srv__skill');

  const many: McpPromptDiscovery = { listings: [{ server: 'srv', client: fakeClient, skipped: 0, problems: Array.from({ length: 40 }, (_, i) => `p${i}`), prompts: [] }] };
  const capped = buildMcpPromptCatalogue(many, new Map()).problems;
  assert('problems are capped with one … N more entry', capped.length === MAX_MCP_PROMPT_PROBLEMS && capped.at(-1) === `… ${40 - MAX_MCP_PROMPT_PROBLEMS + 1} more MCP prompt problems not listed`);
}

function testProjection(): void {
  header('projection — user text joined, omissions counted, cap refused');
  const review = command({ name: 'mcp__srv__review', arguments: [{ name: 'file', required: true, description: 'path' }, { name: 'focus', required: false }] });
  const map = (input: string) => mapMcpPromptArguments(matchMcpPromptCommand({ commands: [review], servers: new Map(), problems: [] }, input)!);
  assert('words map positionally', JSON.stringify(map('/mcp__srv__review a.ts  speed')) === JSON.stringify({ file: 'a.ts', focus: 'speed' }));
  assert('an omitted optional argument is absent', JSON.stringify(map('/mcp__srv__review a.ts')) === JSON.stringify({ file: 'a.ts' }));
  let usage = '';
  try { map('/mcp__srv__review'); } catch (error) { usage = (error as Error).message; }
  assert('missing required → usage listing the arguments', usage.includes('missing required argument file') && usage.includes('usage: /mcp__srv__review <file> [focus]') && usage.includes('file (required): path'));
  try { map('/mcp__srv__review a b c'); } catch (error) { usage = (error as Error).message; }
  assert('too many words → usage', usage.includes('got 3 words for 2 arguments'));

  const composed = composeMcpPromptResult(command(), {
    messages: [
      { role: 'user', content: { type: 'text', text: 'one' } },
      { role: 'assistant', content: { type: 'text', text: 'never' } },
      { role: 'user', content: { type: 'resource_link', uri: 'file:///x', name: 'x' } },
      { role: 'user', content: { type: 'text', text: 'two' } },
    ],
  });
  assert('user text joined in order by a blank line', composed.message === 'one\n\ntwo');
  assert('assistant message and non-text block counted', composed.omitted.assistantMessages === 1 && composed.omitted.nonTextBlocks === 1);
  assert('the cap is the trajectory field cap, not a second number', MAX_MCP_PROMPT_RESULT_CHARS === MAX_FIELD_CHARS);
  const exact = composeMcpPromptResult(command(), { messages: [{ role: 'user', content: { type: 'text', text: 'é'.repeat(MAX_FIELD_CHARS) } }] });
  assert('exactly the cap (code points) is accepted whole', [...exact.message].length === MAX_FIELD_CHARS);
  let refused = '';
  try { composeMcpPromptResult(command(), { messages: [{ role: 'user', content: { type: 'text', text: 'é'.repeat(MAX_FIELD_CHARS + 1) } }] }); } catch (error) { refused = (error as Error).message; }
  assert('one over the cap is refused, not truncated', refused.includes(`${MAX_FIELD_CHARS + 1} characters`) && refused.includes('refused, not truncated'));
}

async function testDiscovery(): Promise<void> {
  header('discovery — real stdio clients, bounded, one deadline, never connects');
  const clients = await McpClient.loadServers({
    slow: { ...server('slow-list', 'direct-slow.log'), prefix: 'slow' },
    idle: { ...server('prompts', 'direct-idle.log'), prefix: 'idle' },
  } as never, { continueOnError: true });
  const [slow, idle] = clients;
  try {
    await slow!.listTools();
    const started = Date.now();
    const discovery = await discoverMcpPrompts(clients, { timeoutMs: 300 });
    const elapsed = Date.now() - started;
    assert('only the connected prompt-capable client is asked', discovery.listings.length === 1 && discovery.listings[0]!.server === 'slow');
    assert('a listing that never answers degrades within the one deadline', elapsed < 3_000 && discovery.listings[0]!.failure === 'prompts/list timed out after 0.3s');
    assert('the failure is one bounded warning naming the server',
      discovery.listings[0]!.problems.length === 1 && discovery.listings[0]!.problems[0] === 'mcp server "slow": prompts/list timed out after 0.3s; its prompts are not offered');
    assert('a never-connected client is neither spawned nor asked (no connect)', idle!.connectionState === 'disconnected' && !existsSync(path.join(LOGS, 'direct-idle.log')));
  } finally {
    await Promise.allSettled(clients.map((client) => client.disconnect()));
  }
}

await rm(ROOT, { recursive: true, force: true });
await mkdir(path.join(darwinDir(ROOT), COMMANDS_DIRNAME), { recursive: true });
await mkdir(LOGS, { recursive: true });
await writeFile(path.join(darwinDir(ROOT), COMMANDS_DIRNAME, 'plain.md'), 'Plain command body\nwith $ARGUMENTS.\n');
await writeFile(path.join(darwinDir(ROOT), COMMANDS_DIRNAME, 'mcp__prompts__collide.md'), 'CUSTOM COLLIDE BODY\n');
await mkdir(path.join(darwinDir(ROOT), SKILLS_DIRNAME, 'tidy'), { recursive: true });
await writeFile(path.join(darwinDir(ROOT), SKILLS_DIRNAME, 'tidy', 'SKILL.md'), '---\nname: tidy\ndescription: Tidy things.\n---\n\n# Tidy\n\nKeep it tidy.\n');
await mkdir(path.dirname(configPath()), { recursive: true });
await writeFile(configPath(), JSON.stringify({
  provider: 'bedrock', model: 'fake.offline-capture', region: 'us-west-2',
  promptCache: false, memory: false, contextOffload: false, trajectory: true,
}));
const model = new CaptureModel();
setRuntimeModelFactoryForTest(async () => model);
const UNCHANGED_INPUTS = ['/plain a  b', '/tidy now', '/PLAIN', '/unknown text', '/mcp__nope__x y'];

testNaming();
testProjection();
await testDiscovery();

// Baseline: the same project with no MCP config at all.
header('unchanged — custom-command and skill expansion without MCP (baseline)');
const baseline: string[] = [];
{
  const runtime = await AgentRuntime.create({ projectRoot: ROOT, session: { kind: 'new' }, permissionBridge: async () => ({ allowed: false }) });
  try {
    for (const input of UNCHANGED_INPUTS) baseline.push(JSON.stringify(await runtime.expandSlashCommand(input)));
    assert('baseline runtime offers no MCP prompt commands', runtime.info.mcpPromptCommands.length === 0 && runtime.info.mcpPromptProblems.length === 0);
  } finally {
    await runtime.shutdown();
  }
}

await writeFile(path.join(userDarwinDir(), 'mcp.json'), JSON.stringify({
  mcpServers: {
    prompts: server('prompts', 'prompts.log'),
    plain: server('no-prompts', 'plain.log'),
    'broken-start': server('fail', 'fail.log'),
    'pa.ged': server('paged', 'paged.log'),
    endless: server('endless', 'endless.log'),
    badlist: server('bad-list', 'badlist.log'),
  },
}));

let gateCalls = 0;
const runtime = await AgentRuntime.create({
  projectRoot: ROOT, session: { kind: 'new' },
  permissionBridge: async () => { gateCalls++; return { allowed: false }; },
});
const literals: string[] = [];
let successor: AgentRuntime | undefined;
try {
  header('runtime catalogue — counts, skips and the request logs');
  const names = runtime.info.mcpPromptCommands.map((entry) => entry.name);
  const expectedPrompts = ['greet', 'review', 'conversation', 'broken', 'slow', 'sized', 'assistant-only', 'name_with_spaces'].map((name) => `mcp__prompts__${name}`);
  assert('prompt server offers its prompts in listing order, sanitized, collisions skipped',
    JSON.stringify(names.filter((name) => name.startsWith('mcp__prompts__'))) === JSON.stringify(expectedPrompts));
  assert('a server name is sanitized too, and capped at 64 prompts',
    names.filter((name) => name.startsWith('mcp__pa_ged__')).length === MAX_MCP_PROMPTS_PER_SERVER && names.includes('mcp__pa_ged__p63') && !names.includes('mcp__pa_ged__p64'));
  assert('pagination stops at the page cap', names.filter((name) => name.startsWith('mcp__endless__')).length === MAX_MCP_PROMPT_LIST_PAGES);
  assert('completion metadata: argument hint and bounded, single-line description',
    JSON.stringify(runtime.info.mcpPromptCommands.find((entry) => entry.name === 'mcp__prompts__review')) ===
      JSON.stringify({ name: 'mcp__prompts__review', argumentHint: '<file> [focus]', description: 'Review one file. [31m with controls' }));
  const problems = runtime.info.mcpPromptProblems;
  assert('collision with a custom command is skipped and reported', problems.some((p) => p.includes('"collide"') && p.includes('conflicts with custom command /mcp__prompts__collide')));
  assert('collision between sanitized prompts is skipped and reported', problems.some((p) => p.includes('"name_with_spaces"') && p.includes('conflicts with mcp prompt "name.with spaces"')));
  assert('per-server cap and page cap are stated', problems.some((p) => p.includes('"pa.ged": lists more than 64 prompts')) && problems.some((p) => p.includes(`"endless": prompts/list stopped after ${MAX_MCP_PROMPT_LIST_PAGES} pages`)));
  assert('a listing error is one bounded warning naming the server', problems.filter((p) => p.includes('"badlist"')).length === 1 && problems.some((p) => p.startsWith('mcp server "badlist": prompts/list failed — ') && p.includes('listing exploded')));
  assert('no problem is reported for the prompt-less or failed server', !problems.some((p) => p.includes('"plain"') || p.includes('broken-start')));

  assert('prompt server: one initialize, one tools/list (initialize), one prompts/list, no prompts/get',
    await count('prompts.log', 'initialize') === 1 && await count('prompts.log', 'tools/list') === 1 &&
    await count('prompts.log', 'prompts/list') === 1 && await count('prompts.log', 'prompts/get') === 0);
  assert('prompt-less server got zero prompt requests', (await requests('plain.log')).length > 0 && await count('plain.log', /^prompts\//) === 0);
  assert('server that failed to start got zero prompt requests', await count('fail.log', 'initialize') === 1 && await count('fail.log', /^prompts\//) === 0);
  assert('paginated listing followed to the cap only', await count('paged.log', 'prompts/list') === 3 && await count('endless.log', 'prompts/list') === MAX_MCP_PROMPT_LIST_PAGES);

  header('mcp report — per-server prompt counts from the cache, no fetch');
  const before = JSON.stringify(await Promise.all(['prompts.log', 'plain.log', 'fail.log', 'paged.log', 'endless.log', 'badlist.log'].map(requests)));
  const reportText = formatMcpReport(runtime.listMcpServers(), { configPaths: [], overriddenServerNames: [], ignoredConfigPath: undefined, candidatePaths: [] });
  const row = (name: string) => reportText.split('\n').find((line) => line.trimStart().startsWith(`${name} `)) ?? '';
  assert('prompt server row: count, skipped, bounded names', row('prompts').endsWith(' · 8 prompts (2 skipped): /mcp__prompts__greet, /mcp__prompts__review, /mcp__prompts__conversation, /mcp__prompts__broken, /mcp__prompts__slow, /mcp__prompts__sized, /mcp__prompts__assistant-only, /mcp__prompts__name_with_spaces'));
  assert('a long listing is bounded with … N more', row('pa.ged').endsWith(`/mcp__pa_ged__p07 … ${MAX_MCP_PROMPTS_PER_SERVER - 8} more`) && row('pa.ged').includes('64 prompts (26 skipped)'));
  assert('listing failure is stated on its row', row('badlist').includes(' · prompts unavailable — prompts/list failed — '));
  assert('prompt-less and failed rows carry no prompt segment', !row('plain').includes('prompt') && row('broken-start').includes('failed — could not connect') && !row('broken-start').includes('prompt'));
  const after = JSON.stringify(await Promise.all(['prompts.log', 'plain.log', 'fail.log', 'paged.log', 'endless.log', 'badlist.log'].map(requests)));
  assert('/mcp sent no request to any server', before === after);

  header('invocation — arguments, usage errors, results, failures, cancel and timeout');
  const getCount = () => count('prompts.log', 'prompts/get');
  const greet = await runtime.expandSlashCommand('  /mcp__prompts__greet  ');
  assert('no-argument prompt expands to its user text', greet?.kind === 'mcp-prompt' && greet.message === 'Say hello to the SER-114 fixture.' && greet.omitted.assistantMessages === 0 && greet.omitted.nonTextBlocks === 0);
  const gets = (await requests('prompts.log')).filter((entry) => entry.method === 'prompts/get');
  assert('one prompts/get with the original name and no arguments', gets.length === 1 && JSON.stringify(gets[0]!.params) === JSON.stringify({ name: 'greet' }));
  const review = await runtime.expandSlashCommand('/MCP__PROMPTS__REVIEW src/a.ts \t security');
  assert('required + optional arguments map positionally', review?.message === 'Review src/a.ts focusing on security.');
  const reviewGet = (await requests('prompts.log')).filter((entry) => entry.method === 'prompts/get').at(-1);
  assert('declared argument names carry the words', JSON.stringify(reviewGet?.params) === JSON.stringify({ name: 'review', arguments: { file: 'src/a.ts', focus: 'security' } }));
  assert('an omitted optional argument is not sent', (await runtime.expandSlashCommand('/mcp__prompts__review src/b.ts'))?.message === 'Review src/b.ts.');

  const getsBefore = await getCount();
  const missing = await rejects(runtime.expandSlashCommand('/mcp__prompts__review'));
  const extra = await rejects(runtime.expandSlashCommand('/mcp__prompts__greet surplus'));
  const tooMany = await rejects(runtime.expandSlashCommand('/mcp__prompts__review a b c'));
  assert('missing required argument → local usage listing the arguments',
    missing?.startsWith('McpPromptError: /mcp__prompts__review is missing required argument file; usage: /mcp__prompts__review <file> [focus] — arguments — file (required): path to review; focus: what to look at') === true);
  assert('more words than arguments → usage', extra?.includes('/mcp__prompts__greet got 1 word for 0 arguments') === true && extra.includes('it takes no arguments') && tooMany?.includes('got 3 words for 2 arguments') === true);
  assert('usage errors make no server call and no model call', await getCount() === getsBefore && model.calls.length === 0);

  const conversation = await runtime.expandSlashCommand('/mcp__prompts__conversation');
  assert('multi-message result: user text only, in order', conversation?.kind === 'mcp-prompt' && conversation.message === 'First user part.\n\nSecond user part.' && !conversation.message.includes('ASSISTANT_TEXT'));
  assert('assistant message and image block are counted', conversation?.kind === 'mcp-prompt' && conversation.omitted.assistantMessages === 1 && conversation.omitted.nonTextBlocks === 1);

  const broken = await rejects(runtime.expandSlashCommand('/mcp__prompts__broken'));
  assert('server error → one bounded failure, controls stripped', broken?.startsWith('McpPromptError: /mcp__prompts__broken: prompts/get on mcp server "prompts" failed — ') === true && broken.includes('fixture prompt failure') && !broken.includes('\u001b'));
  assert('a result at exactly the cap is accepted', (await runtime.expandSlashCommand(`/mcp__prompts__sized ${MAX_FIELD_CHARS}`))?.message.length === MAX_FIELD_CHARS);
  const over = await rejects(runtime.expandSlashCommand(`/mcp__prompts__sized ${MAX_FIELD_CHARS + 1}`));
  assert('an over-cap result is refused, never truncated', over?.includes(`is ${MAX_FIELD_CHARS + 1} characters, over the ${MAX_FIELD_CHARS}-character cap`) === true && over.includes('refused, not truncated'));
  assert('a result with no user text is refused', (await rejects(runtime.expandSlashCommand('/mcp__prompts__assistant-only')))?.includes('returned no user text to send (not sent: 1 assistant message)') === true);
  const sanitized = await runtime.expandSlashCommand('/mcp__prompts__name_with_spaces');
  const sanitizedGet = (await requests('prompts.log')).filter((entry) => entry.method === 'prompts/get').at(-1);
  assert('the sanitized command asks for the original prompt name', sanitized?.message === 'sanitized prompt body' && sanitizedGet?.params?.['name'] === 'name.with spaces');
  const collide = await runtime.expandSlashCommand('/mcp__prompts__collide');
  assert('the custom command keeps its colliding name', collide?.kind === 'command' && collide.message === 'CUSTOM COLLIDE BODY\n');
  assert('an unknown /mcp__ name stays ordinary input', await runtime.expandSlashCommand('/mcp__prompts__nope x') === null);

  const slowBefore = (await requests('prompts.log')).filter((entry) => entry.method === 'prompts/get' && entry.params?.['name'] === 'slow').length;
  const pending = rejects(runtime.expandSlashCommand('/mcp__prompts__slow'));
  for (let tries = 0; tries < 200; tries += 1) {
    if ((await requests('prompts.log')).filter((entry) => entry.method === 'prompts/get' && entry.params?.['name'] === 'slow').length > slowBefore) break;
    await delay(10);
  }
  const cancelledAt = Date.now();
  runtime.cancel();
  const cancelled = await pending;
  assert('the turn cancel aborts an in-flight prompts/get promptly',
    cancelled === 'McpPromptError: /mcp__prompts__slow: cancelled before mcp server "prompts" answered' && Date.now() - cancelledAt < 2_000);
  await delay(50);
  assert('the cancellation reached the server as notifications/cancelled', await count('prompts.log', 'notifications/cancelled') >= 1);
  const slowCommand = matchMcpPromptCommand((runtime as unknown as { mcpPrompts: Parameters<typeof matchMcpPromptCommand>[0] }).mcpPrompts, '/mcp__prompts__slow')!;
  const timedOut = await rejects(expandMcpPrompt(slowCommand, { timeoutMs: 300 }));
  assert('prompts/get has a timeout', timedOut === 'McpPromptError: /mcp__prompts__slow: prompts/get on mcp server "prompts" timed out after 0.3s');
  assert('nothing above reached the model or the permission gate', model.calls.length === 0 && gateCalls === 0);
  assert('errors are McpPromptError instances (driver notice + draft returned)', new McpPromptError('x') instanceof Error);

  header('drivers — exact text sent once, literal recorded once, notices, no tool, no system prompt');
  for (const driver of ['direct', 'text', 'json'] as const) {
    for (const [input, expected] of [['/mcp__prompts__greet', 'Say hello to the SER-114 fixture.'], ['/mcp__prompts__conversation', 'First user part.\n\nSecond user part.']] as const) {
      const before = model.calls.length;
      const stderr: string[] = [];
      const events: string[] = [];
      if (driver === 'direct') {
        const expanded = await runtime.expandSlashCommand(input);
        for await (const _event of runtime.send(expanded!.message, input)) { /* drain */ }
      } else if (driver === 'text') {
        assert('text headless completes', await runHeadlessTurn(runtime, input, (line) => stderr.push(line)) === 'ok');
      } else {
        const result = await runStructuredHeadlessTurn(runtime, input, new StructuredHeadlessWriter('stream-json', (line) => events.push(line)), () => 'unexpected tool');
        assert('json headless completes', result.reply === 'ok');
      }
      literals.push(input);
      assert(`${driver}: exactly one model request with the exact expanded text`, model.calls.length === before + 1 && lastPrompt(model) === expected);
      if (input.endsWith('conversation') && driver === 'text') {
        assert('text headless states the omission once on stderr', stderr.filter((line) => line.includes('not sent')).length === 1 &&
          stderr.includes('notice: loaded MCP prompt "/mcp__prompts__conversation" from server "prompts" (not sent: 1 assistant message, 1 non-text block)\n'));
      }
      if (input.endsWith('conversation') && driver === 'json') {
        const diagnostics = events.map((line) => JSON.parse(line)).filter((event) => event.type === 'diagnostic');
        assert('structured headless states the omission as one mcp diagnostic', diagnostics.length === 1 && diagnostics[0].source === 'mcp' && diagnostics[0].message.includes('(not sent: 1 assistant message, 1 non-text block)'));
      }
      if (input.endsWith('greet') && driver === 'text') assert('nothing omitted → no headless notice', stderr.length === 0);
    }
  }
  const call = model.calls.at(-1)!;
  assert('the system prompt names no MCP prompt', !(call.systemPrompt === undefined ? '' : JSON.stringify(call.systemPrompt)).includes('mcp__'));
  assert('no new tool: no tool name carries the prompt command form', !call.tools.some((name) => name.includes('mcp__') || /prompt/i.test(name)));
  assert('the model never received assistant-only server text', !model.calls.some((entry) => JSON.stringify(entry.messages).includes('ASSISTANT_TEXT_MUST_NOT_BE_SENT')));

  header('unchanged — custom-command and skill expansion with MCP prompts present');
  const withMcp: string[] = [];
  for (const input of UNCHANGED_INPUTS) withMcp.push(JSON.stringify(await runtime.expandSlashCommand(input)));
  assert('custom-command, skill and unknown expansion byte-identical to the no-MCP baseline', JSON.stringify(withMcp) === JSON.stringify(baseline));

  header('clear — a successor reuses the one discovery');
  const listsBefore = await count('prompts.log', 'prompts/list');
  successor = await runtime.startNewSession();
  assert('successor offers the same prompt commands', JSON.stringify(successor.info.mcpPromptCommands) === JSON.stringify(runtime.info.mcpPromptCommands));
  assert('no server was asked again', await count('prompts.log', 'prompts/list') === listsBefore && await count('paged.log', 'prompts/list') === 3);
  assert('successor still expands through the same path', (await successor.expandSlashCommand('/mcp__prompts__greet'))?.message === 'Say hello to the SER-114 fixture.');
  const trajectoryFile = runtime.info.trajectoryFile;
  if (trajectoryFile !== undefined) {
    const records = (await readFile(trajectoryFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const inputs = records.filter((record) => record.type === 'userInput').map((record) => record.text);
    assert('every driver recorded the literal input exactly once per turn, like a custom command', JSON.stringify(inputs) === JSON.stringify(literals));
  } else {
    assert('trajectory recorded', false);
  }
} finally {
  // A retired predecessor hands its MCP clients over; whichever runtime owns them shuts down.
  await (successor ?? runtime).shutdown();
  setRuntimeModelFactoryForTest(undefined);
}

header('trust — a held project MCP layer is never spawned, so never asked');
{
  await rm(path.join(userDarwinDir(), 'mcp.json'));
  await writeFile(path.join(darwinDir(ROOT), 'mcp.json'), JSON.stringify({ mcpServers: { held: server('prompts', 'held.log') } }));
  const heldModel = new CaptureModel();
  setRuntimeModelFactoryForTest(async () => heldModel);
  const inventory = await inventoryWorkspace(ROOT);
  const held = await AgentRuntime.create({
    projectRoot: ROOT, session: { kind: 'new' }, permissionBridge: async () => ({ allowed: false }),
    workspaceTrust: { state: 'untrusted', inventory },
  });
  try {
    assert('held project server: no process, no request, no prompt command', !existsSync(path.join(LOGS, 'held.log')) && held.info.mcpPromptCommands.length === 0);
    assert('a held server name stays ordinary input', await held.expandSlashCommand('/mcp__held__greet') === null);
  } finally {
    await held.shutdown();
  }
  const trusted = await AgentRuntime.create({
    projectRoot: ROOT, session: { kind: 'new' }, permissionBridge: async () => ({ allowed: false }),
    workspaceTrust: { state: 'trusted', inventory },
  });
  try {
    assert('the same layer trusted is listed once', await count('held.log', 'prompts/list') === 1 && trusted.info.mcpPromptCommands.some((entry) => entry.name === 'mcp__held__greet'));
  } finally {
    await trusted.shutdown();
    setRuntimeModelFactoryForTest(undefined);
  }
}

report();

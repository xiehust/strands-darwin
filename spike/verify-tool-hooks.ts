/** Fast offline verification for configured PreToolUse/PostToolUse shell hooks. */
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  Agent,
  Model,
  tool,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
} from '@strands-agents/sdk';
import { z } from 'zod';

import { PermissionGate, type AssessedPermissionRequest } from '../src/agent/permission.js';
import {
  ToolHookGate,
  matchesToolGlob,
  runToolHookCommand,
  type ToolHooksConfig,
} from '../src/hooks/tool-hooks.js';
import { assert, header, report } from './shared.js';

const ROOT = '/tmp/darwin-tool-hooks-test';

class ToolCallModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.hooks', contextWindowLimit: 200_000 };

  constructor(
    private readonly toolName: string,
    private readonly input: Record<string, unknown>,
    private readonly toolUseId = 'hook-call-1',
  ) {
    super();
  }

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    const hasResult = messages.some((message) =>
      message.content.some((block) => block.type === 'toolResultBlock'),
    );
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (!hasResult) {
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: this.toolName, toolUseId: this.toolUseId },
      };
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: JSON.stringify(this.input) },
      };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'done' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

function command(value: string) {
  return { type: 'command', command: value } as const;
}

function group(matcher: string, ...commands: string[]) {
  return { matcher, hooks: commands.map(command) } as const;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function makeAgent(options: {
  hooks: ToolHooksConfig;
  toolName?: string;
  input?: Record<string, unknown>;
  body?: () => string;
  answer?: boolean;
  askDelayMs?: number;
  asked?: AssessedPermissionRequest[];
  ran?: string[];
  projectRoot?: string;
  onAsk?: () => void;
  onBody?: () => void;
}): Agent {
  const toolName = options.toolName ?? 'probeTool';
  const projectRoot = options.projectRoot ?? ROOT;
  const asked = options.asked ?? [];
  const ran = options.ran ?? [];
  const gate = new PermissionGate({
    mode: 'default',
    projectRoot,
    ask: async (request) => {
      asked.push(request);
      options.onAsk?.();
      if (options.askDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.askDelayMs));
      }
      return { allowed: options.answer ?? true };
    },
  });
  const probe = tool({
    name: toolName,
    description: 'Lifecycle probe.',
    inputSchema: z.object({ value: z.string() }),
    callback: () => {
      ran.push('body');
      options.onBody?.();
      return options.body?.() ?? 'tool-ok';
    },
  });
  return new Agent({
    model: new ToolCallModel(toolName, options.input ?? { value: 'raw marker' }),
    tools: [probe],
    interventions: [new ToolHookGate(projectRoot, options.hooks, gate)],
    printer: false,
  });
}

async function globContracts(): Promise<void> {
  header('tool hooks — glob matching');
  assert('exact matcher matches the complete name', matchesToolGlob('fileEditor', 'fileEditor'));
  assert('exact matcher is anchored', !matchesToolGlob('file', 'fileEditor'));
  assert('* matches zero or more characters', matchesToolGlob('file*', 'file') && matchesToolGlob('file*', 'fileEditor'));
  assert('? matches exactly one character', matchesToolGlob('tool?', 'tool1') && !matchesToolGlob('tool?', 'tool'));
  assert('matching is case-sensitive', !matchesToolGlob('File*', 'fileEditor'));
  assert('regex metacharacters are literal', matchesToolGlob('mcp.tool+[1]', 'mcp.tool+[1]'));
  assert('* alone matches every tool name', matchesToolGlob('*', 'anything'));
}

async function shellContract(): Promise<void> {
  header('tool hooks — real shell payload and process contract');
  const payload = path.join(ROOT, 'payload.json');
  process.env['DARWIN_HOOK_TEST'] = 'inherited-ok';
  const result = await runToolHookCommand(
    ROOT,
    `cat > ${payload}; printf '%s|%s' "$PWD" "$DARWIN_HOOK_TEST"`,
    'probeTool',
    { nested: ['exact', 2], flag: true },
  );
  const received = await readFile(payload, 'utf8');
  assert('command exits successfully', result.exitCode === 0 && result.error === undefined);
  assert('one exact JSON object plus newline reaches stdin', received === '{"tool_name":"probeTool","tool_input":{"nested":["exact",2],"flag":true}}\n');
  assert('cwd is the project root and environment is inherited', result.stdout === `${ROOT}|inherited-ok`);
  assert('stderr is captured', result.stderr === '');
  delete process.env['DARWIN_HOOK_TEST'];

  const launch = await runToolHookCommand(path.join(ROOT, 'missing-cwd'), 'true', 'probeTool', {});
  assert('process-launch failures resolve as captured failures', launch.error !== undefined && launch.exitCode !== 0);

  const invalid = await runToolHookCommand(ROOT, 'bad\0command', 'probeTool', {});
  assert(
    'synchronous spawn validation failures resolve as captured failures',
    invalid.error?.message.includes('null bytes') === true && invalid.exitCode === null,
  );
}

async function preDenyContract(): Promise<void> {
  header('tool hooks — Pre ordering, denial, and short circuit');
  const log = path.join(ROOT, 'pre-order');
  const payload = path.join(ROOT, 'pre-payload');
  const asked: AssessedPermissionRequest[] = [];
  const ran: string[] = [];
  const agent = makeAgent({
    asked,
    ran,
    hooks: {
      PreToolUse: [
        group('no-match', `printf wrong >> ${log}`),
        group('probe*', `cat > ${payload}; printf first >> ${log}`, `printf second >> ${log}; printf 'blocked by project policy' >&2; exit 7`, `printf third >> ${log}`),
      ],
      PostToolUse: [group('*', `printf post >> ${log}`)],
    },
  });
  const result = await agent.invoke('run');
  const transcript = JSON.stringify(agent.messages.map((message) => message.toJSON()));
  assert('matching Pre hooks run sequentially until the first failure', (await readFile(log, 'utf8')) === 'firstsecond');
  assert('Pre receives the exact tool name/input payload', (await readFile(payload, 'utf8')) === '{"tool_name":"probeTool","tool_input":{"value":"raw marker"}}\n');

  assert('a failed Pre hook prevents permission evaluation', asked.length === 0);
  assert('a failed Pre hook prevents tool execution', ran.length === 0);
  assert('a denied/cancelled call does not run Post hooks', !(await readFile(log, 'utf8')).includes('post'));
  assert('stderr is visible to the model in a DENIED result', transcript.includes('DENIED: blocked by project policy'));
  assert('the agent loop continues after denial', result.stopReason === 'endTurn');
}

async function emptyStderrContract(): Promise<void> {
  header('tool hooks — actionable Pre fallback');
  const agent = makeAgent({ hooks: { PreToolUse: [group('*', 'exit 9')] } });
  await agent.invoke('run');
  const transcript = JSON.stringify(agent.messages.map((message) => message.toJSON()));
  assert('empty stderr fallback names event and exit code', transcript.includes('PreToolUse hook') && transcript.includes('exit code 9'));
  assert('fallback points to the config fix', transcript.includes('.darwin/config.json'));
}

async function launchFailureContract(): Promise<void> {
  header('tool hooks — actionable process-launch fallback');
  const missingRoot = path.join(ROOT, 'missing-project-root');
  const asked: AssessedPermissionRequest[] = [];
  const ran: string[] = [];
  const agent = makeAgent({
    projectRoot: missingRoot,
    asked,
    ran,
    hooks: { PreToolUse: [group('*', 'true')] },
  });
  await agent.invoke('run');
  const transcript = JSON.stringify(agent.messages.map((message) => message.toJSON()));
  assert('launch failure denies before permission or tool execution', asked.length === 0 && ran.length === 0);
  assert('launch fallback names the command and config fix', transcript.includes('could not launch') && transcript.includes('.darwin/config.json'));
}

async function successAndPostContracts(): Promise<void> {
  header('tool hooks — permission ordering and Post isolation');
  const log = path.join(ROOT, 'success-order');
  const postPayload = path.join(ROOT, 'post-payload');

  const asked: AssessedPermissionRequest[] = [];
  const ran: string[] = [];
  const hooks = {
    PreToolUse: [group('probeTool', `printf pre >> ${log}`)],
    PostToolUse: [
      group('probeTool', `printf post1 >> ${log}; exit 4`),
      group('*', `cat > ${postPayload}; printf post2 >> ${log}`),
    ],
  } as const;
  const agent = makeAgent({
    asked,
    ran,
    hooks,
    onAsk: () => appendFileSync(log, 'ask'),
    onBody: () => appendFileSync(log, 'body'),
  });
  const result = await agent.invoke('run');
  const transcript = JSON.stringify(agent.messages.map((message) => message.toJSON()));
  assert('Pre runs before permission and execution', asked.length === 1 && ran.length === 1 && (await readFile(log, 'utf8')).startsWith('preaskbody'));
  assert('failed Post does not prevent later matching Post hooks', (await readFile(log, 'utf8')) === 'preaskbodypost1post2');
  assert('Post receives the same name/input payload and no tool result', (await readFile(postPayload, 'utf8')) === '{"tool_name":"probeTool","tool_input":{"value":"raw marker"}}\n');

  assert('Post failure does not replace the original successful result', transcript.includes('tool-ok') && result.stopReason === 'endTurn');

  const deniedLog = path.join(ROOT, 'permission-denied');
  const deniedRan: string[] = [];
  const denied = makeAgent({
    answer: false,
    ran: deniedRan,
    hooks: { PreToolUse: [group('*', `printf pre >> ${deniedLog}`)], PostToolUse: [group('*', `printf post >> ${deniedLog}`)] },
  });
  await denied.invoke('run');
  assert('Pre runs before a permission denial', (await readFile(deniedLog, 'utf8')) === 'pre');
  assert('permission denial prevents body and Post despite SDK After event', deniedRan.length === 0);
}

async function toolErrorContract(): Promise<void> {
  header('tool hooks — Post after tool-body error');
  const log = path.join(ROOT, 'error-post');
  const agent = makeAgent({
    body: () => { throw new Error('original body failure'); },
    hooks: { PostToolUse: [group('*', `printf observed >> ${log}; exit 3`, `printf later >> ${log}`)] },
  });
  await agent.invoke('run');
  const transcript = JSON.stringify(agent.messages.map((message) => message.toJSON()));
  assert('Post runs after a failed tool attempt and continues after its own failure', (await readFile(log, 'utf8')) === 'observedlater');
  assert('Post failures do not hide the original tool error', transcript.includes('original body failure'));
}

async function cancellationContract(): Promise<void> {
  header('tool hooks — cancellation stops active Pre hooks');
  const ran: string[] = [];
  const agent = makeAgent({
    ran,
    hooks: { PreToolUse: [group('*', 'sh -c "trap \'\' TERM; sleep 5" & wait')] },
  });
  const started = Date.now();
  const invocation = agent.invoke('run');
  await new Promise((resolve) => setTimeout(resolve, 100));
  agent.cancel();
  const result = await invocation;
  assert('a cancelled hook returns promptly', Date.now() - started < 2_000);
  assert('the tool body does not run after cancellation', ran.length === 0);
  assert('the invocation finishes as cancelled', result.stopReason === 'cancelled');
}

async function postCancellationContract(): Promise<void> {
  header('tool hooks — cancellation stops active Post hooks');
  const agent = makeAgent({
    hooks: { PostToolUse: [group('*', 'sh -c "trap \'\' TERM; sleep 5" & wait')] },
  });
  const started = Date.now();
  const invocation = agent.invoke('run');
  await new Promise((resolve) => setTimeout(resolve, 100));
  agent.cancel();
  const result = await invocation;
  assert('a cancelled Post hook returns promptly', Date.now() - started < 2_000);
  assert('the invocation finishes as cancelled during Post', result.stopReason === 'cancelled');
}

async function permissionCancellationContract(): Promise<void> {
  header('tool hooks — cancellation during permission evaluation');
  const ran: string[] = [];
  const agent = makeAgent({
    ran,
    askDelayMs: 500,
    hooks: {},
  });
  const invocation = agent.invoke('run');
  await new Promise((resolve) => setTimeout(resolve, 100));
  agent.cancel();
  const result = await invocation;
  assert('permission approval cannot run a tool after cancellation', ran.length === 0);
  assert('the permission-race invocation finishes as cancelled', result.stopReason === 'cancelled');
}

async function descendantReapingContract(): Promise<void> {
  header('tool hooks — cancellation reaps descendants after shell exit');
  const pidFile = path.join(ROOT, 'descendant-pid');
  const controller = new AbortController();
  const execution = runToolHookCommand(
    ROOT,
    `sh -c 'trap "" TERM; echo $$ > ${pidFile}; sleep 5' & wait`,
    'probeTool',
    {},
    controller.signal,
  );
  while (true) {
    try {
      await readFile(pidFile, 'utf8');
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  controller.abort();
  await execution;
  const pid = Number((await readFile(pidFile, 'utf8')).trim());
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert('SIGKILL grace timer survives shell-leader exit', !processExists(pid));
}

await rm(ROOT, { recursive: true, force: true });
await mkdir(ROOT, { recursive: true });
await globContracts();
await shellContract();
await preDenyContract();
await emptyStderrContract();
await launchFailureContract();
await successAndPostContracts();
await toolErrorContract();
await cancellationContract();
await postCancellationContract();
await permissionCancellationContract();
await descendantReapingContract();
await rm(ROOT, { recursive: true, force: true });
report();

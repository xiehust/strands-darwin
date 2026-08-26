/** Network-free real-Agent contract for the repeated-failure retry guard. */
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';

import {
  Agent,
  JsonBlock,
  Message,
  Model,
  TextBlock,
  tool,
  type BaseModelConfig,
  type Message as AgentMessage,
  type ModelStreamEvent,
} from '@strands-agents/sdk';
import { z } from 'zod';

import { PermissionGate, type AssessedPermissionRequest } from '../src/agent/permission.js';
import {
  normalizeFailureSignature,
  REPEATED_FAILURE_LIMIT,
  RETRY_GUARD_MESSAGE_CODE_POINTS,
  RETRY_GUARD_SIGNATURE_CODE_POINTS,
} from '../src/agent/retry-guard.js';
import { DEFAULT_SYSTEM_PROMPT, loadSystemPrompt } from '../src/agent/system-prompt.js';
import { ToolHookGate, type ToolHooksConfig } from '../src/hooks/tool-hooks.js';
import { assert, header, report } from './shared.js';

const ROOT = '/tmp/darwin-retry-guard-test';
const FIRST_ERROR = 'ValidationException: No sessions were identified from input agent traces request 111 /tmp/run-a';
const EQUIVALENT_ERRORS = [FIRST_ERROR,
  'ValidationException: No sessions were identified from input agent traces request 222 /tmp/run-b',
  'ValidationException: No sessions were identified from input agent traces request 333 /tmp/run-c',
];

interface PlannedCall {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

class PlannedToolModel extends Model<BaseModelConfig> {
  readonly calls: AgentMessage[][] = [];
  private config: BaseModelConfig = { modelId: 'fake.retry-guard', contextWindowLimit: 200_000 };
  private next = 0;

  constructor(private readonly plan: readonly (PlannedCall | null)[]) { super(); }
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }

  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls.push(messages.map((message) => message.clone()));
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    const call = this.plan[this.next++];
    if (call !== undefined && call !== null) {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: call.toolName, toolUseId: `retry-call-${this.next}` } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(call.input) } };
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

function makeTool(
  name: string,
  body: (input: { variant: string; outcome?: string | undefined; text?: string | undefined }) => string | JsonBlock,
) {
  return tool<z.ZodObject<{
    variant: z.ZodString;
    outcome: z.ZodOptional<z.ZodString>;
    text: z.ZodOptional<z.ZodString>;
  }>, string | JsonBlock>({
    name,
    description: name,
    inputSchema: z.object({ variant: z.string(), outcome: z.string().optional(), text: z.string().optional() }),
    callback: body,
  });
}

function makeGate(options: {
  hooks?: ToolHooksConfig;
  asked?: AssessedPermissionRequest[];
  answer?: boolean;
} = {}): ToolHookGate {
  const asked = options.asked ?? [];
  const permission = new PermissionGate({
    mode: 'default',
    projectRoot: ROOT,
    ask: async (request) => { asked.push(request); return { allowed: options.answer ?? true }; },
  });
  return new ToolHookGate(ROOT, options.hooks ?? {}, permission);
}

function textContent(message: AgentMessage): string {
  return message.content.map((block) => block.type === 'textBlock' ? block.text : '').join('');
}

function toolResultTexts(agent: Agent): string[] {
  return agent.messages.flatMap((message) => message.content.flatMap((block) => {
    if (block.type !== 'toolResultBlock') return [];
    return [block.content.map((content) => content.type === 'textBlock' ? content.text : JSON.stringify(content.toJSON())).join('')];
  }));
}

async function equivalentFailureLimit(): Promise<void> {
  header('retry guard — three equivalent failures, then pre-body denial');
  let bodies = 0;
  const fail = makeTool('probe', ({ variant }) => {
    bodies += 1;
    throw new Error(EQUIVALENT_ERRORS[Number(variant) - 1] ?? FIRST_ERROR);
  });
  const model = new PlannedToolModel([1, 2, 3, 4].map((variant) => ({ toolName: 'probe', input: { variant: String(variant) } })));
  const agent = new Agent({ model, tools: [fail], interventions: [makeGate()], printer: false });
  const result = await agent.invoke('run changed variants');
  const results = toolResultTexts(agent);
  const modelText = model.calls.map((call) => call.map(textContent).join('\n')).join('\n');

  assert('the first three changed-input variants execute and the fourth does not', bodies === REPEATED_FAILURE_LIMIT && results.length === 4);
  assert('the original first/second/third error text remains intact', EQUIVALENT_ERRORS.every((error, index) => results[index]?.includes(error)));
  assert('the denied result is bounded and tells the model to stop/report/ask',
    [...(results[3] ?? '')].length <= RETRY_GUARD_MESSAGE_CODE_POINTS + 16 &&
    results[3]?.includes('Stop retrying in this turn') === true &&
    results[3]?.includes('Report this blocker') === true && results[3]?.includes('ask the user') === true);

  header('retry guard — the further equivalent attempt is denied, not the same attempt');
  let sameBodies = 0;
  const sameAgent = new Agent({
    model: new PlannedToolModel([1, 1, 1, 1, 2].map((variant) => ({ toolName: 'probe', input: { variant: String(variant) } }))),
    tools: [makeTool('probe', () => { sameBodies += 1; throw new Error(FIRST_ERROR); })],
    interventions: [makeGate()],
    printer: false,
  });
  await sameAgent.invoke('repeat exact attempt, then variant');
  assert('an exact rerun is not pre-judged, but the next materially different variant is denied', sameBodies === 4);

  assert('the model receives materially-new hypothesis guidance after the repeated signature',
    modelText.includes('materially new evidence-backed hypothesis') && modelText.includes('evidence that distinguishes'));
  assert('the invocation completes through the ordinary SDK loop', result.stopReason === 'endTurn');
}

async function differentSuccessAndReset(): Promise<void> {
  header('retry guard — different signature, success, and new invocation stay open');
  let bodies = 0;
  const probe = makeTool('probe', ({ outcome }) => {
    bodies += 1;
    if (outcome === 'a') throw new Error('ValidationException: stable class alpha request 100');
    if (outcome === 'b') throw new Error('ValidationException: different class beta');
    return 'ok';
  });
  const plan = [
    { toolName: 'probe', input: { variant: '1', outcome: 'a' } },
    { toolName: 'probe', input: { variant: '2', outcome: 'a' } },
    { toolName: 'probe', input: { variant: '3', outcome: 'b' } },
    { toolName: 'probe', input: { variant: '4', outcome: 'ok' } },
    { toolName: 'probe', input: { variant: '5', outcome: 'a' } },
  ];
  const model = new PlannedToolModel(plan);
  const agent = new Agent({ model, tools: [probe], interventions: [makeGate()], printer: false });
  await agent.invoke('mixed outcomes');
  assert('different failure and success are not blocked', bodies === plan.length && toolResultTexts(agent).includes('ok'));

  const always = makeTool('always', () => { bodies += 1; throw new Error('stable again'); });
  const resetModel = new PlannedToolModel([
    ...Array.from({ length: 4 }, (_, index) => ({ toolName: 'always', input: { variant: String(index + 1) } })),
    null,
    ...Array.from({ length: 3 }, (_, index) => ({ toolName: 'always', input: { variant: String(index + 5) } })),
  ]);
  const resetAgent = new Agent({ model: resetModel, tools: [always], interventions: [makeGate()], printer: false });
  await resetAgent.invoke('first invocation');
  await resetAgent.invoke('second invocation');
  assert('a new invocation resets the limit', bodies === plan.length + 6);
}

async function agentIsolation(): Promise<void> {
  header('retry guard — shared intervention isolates concurrent Agents');
  const gate = makeGate();
  let firstBodies = 0;
  let secondBodies = 0;
  const first = new Agent({
    model: new PlannedToolModel([1, 2, 3, 4].map((variant) => ({ toolName: 'probe', input: { variant: String(variant) } }))),
    tools: [makeTool('probe', () => { firstBodies += 1; throw new Error('same isolated failure'); })],
    interventions: [gate], printer: false,
  });
  const second = new Agent({
    model: new PlannedToolModel([{ toolName: 'probe', input: { variant: 'other' } }]),
    tools: [makeTool('probe', () => { secondBodies += 1; throw new Error('same isolated failure'); })],
    interventions: [gate], printer: false,
  });
  await Promise.all([first.invoke('first child'), second.invoke('parallel child')]);
  assert('one Agent reaching the cap does not poison a parallel Agent', firstBodies === 3 && secondBodies === 1);
}

async function boundsAndUnicode(): Promise<void> {
  header('retry guard — adversarial Unicode is deterministic and bounded');
  const adversarial = `ＥＲＲＯＲ\u0000 ${'😀'.repeat(800)} UUID 123e4567-e89b-12d3-a456-426614174000 /tmp/${'界'.repeat(900)} request 999`;
  const normalized = normalizeFailureSignature(adversarial);
  assert('normalization is deterministic, control-free, and Unicode-code-point bounded',
    normalized === normalizeFailureSignature(adversarial) && !normalized.includes('\u0000') &&
    [...normalized].length <= RETRY_GUARD_SIGNATURE_CODE_POINTS && !normalized.endsWith('\ud83d'));

  let bodies = 0;
  const model = new PlannedToolModel([1, 2, 3, 4].map((variant) => ({ toolName: 'probe', input: { variant: String(variant), text: adversarial } })));
  const agent = new Agent({
    model,
    tools: [makeTool('probe', () => { bodies += 1; throw new Error(adversarial); })],
    interventions: [makeGate()], printer: false,
  });
  await agent.invoke('unicode');
  const denied = toolResultTexts(agent).at(-1) ?? '';
  assert('adversarial failure cannot grow the denial result unboundedly', bodies === 3 && [...denied].length <= RETRY_GUARD_MESSAGE_CODE_POINTS + 16);
}

async function orderingAndBash(): Promise<void> {
  header('retry guard — Pre/permission/body/Post ordering and bash outcomes');
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  const log = `${ROOT}.log`;
  await rm(log, { force: true });
  const hooks: ToolHooksConfig = {
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `printf pre >> ${log}` }] }],
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `printf post >> ${log}` }] }],
  };
  let bodies = 0;
  const bashLike = makeTool('bash', () => {
    bodies += 1;
    appendFileSync(log, 'body');
    return new JsonBlock({ json: { output: '', error: 'service unavailable', cwd: ROOT, exitCode: 7 } });
  });
  const model = new PlannedToolModel([1, 2, 3, 4].map((variant) => ({ toolName: 'bash', input: { variant: String(variant) } })));
  const agent = new Agent({ model, tools: [bashLike], interventions: [makeGate({ hooks })], printer: false });
  await agent.invoke('bash failures');
  assert('allowed calls preserve Pre → permission → body → Post and the blocked call reaches none',
    bodies === 3 && await readFile(log, 'utf8') === 'prebodypostprebodypostprebodypost');
  assert('structured nonzero bash outcomes trigger the same blocker', toolResultTexts(agent).at(-1)?.includes('bash-command-error') === true);
  await rm(log, { force: true });

  header('retry guard — permission still precedes the body');
  const asked: AssessedPermissionRequest[] = [];
  let deniedBody = false;
  const deniedAgent = new Agent({
    model: new PlannedToolModel([{ toolName: 'bash', input: { variant: 'permission' } }]),
    tools: [makeTool('bash', () => { deniedBody = true; return 'unexpected'; })],
    interventions: [makeGate({ asked, answer: false })],
    printer: false,
  });
  await deniedAgent.invoke('permission denial');
  assert('permission denial remains before the tool body', asked.length === 1 && !deniedBody);

}

async function promptContract(): Promise<void> {
  header('retry guard — default guidance does not alter replacement semantics');
  assert('default prompt states hypothesis and three-failure stop rule',
    DEFAULT_SYSTEM_PROMPT.includes('materially new evidence-backed hypothesis') && DEFAULT_SYSTEM_PROMPT.includes('Three equivalent failures are the limit'));
  const custom = 'CUSTOM PROMPT ONLY';
  const loaded = await loadSystemPrompt(ROOT, custom);
  assert('configured replacement remains exact and receives no appended guard text', loaded.prompt === custom && !loaded.prompt.includes('equivalent failures'));
}

await equivalentFailureLimit();
await differentSuccessAndReset();
await agentIsolation();
await boundsAndUnicode();
await orderingAndBash();
await promptContract();
report();

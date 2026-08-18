/**
 * Switching the permission mode *inside* a running session.
 *
 * `verify-permission-modes.ts` covers the decision table of a mode chosen at
 * startup. This suite covers the thing that mode being live adds: every contract
 * that held when `plan` came from `--permission-mode` must still hold when it
 * arrives mid-session, and no decision that was already in flight may be resolved
 * under a mode that would not have asked for it.
 *
 * No model calls and no network: the classifier is a stub and the one real `Agent`
 * here streams from a fake model, so the whole file is free to run.
 *
 * Run: pnpm tsx spike/verify-permission-mode-switch.ts
 */
import { readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  Agent,
  Model,
  tool,
  type BaseModelConfig,
  type BeforeToolCallEvent,
  type Message,
  type ModelStreamEvent,
} from '@strands-agents/sdk';
import { z } from 'zod';

import {
  APPROVAL_MODES,
  PermissionGate,
  describeApprovalMode,
  isApprovalMode,
  classify,
  type AssessedPermissionRequest,
  type PermissionDecision,
  type PermissionGateOptions,
  type SafetyClassifier,
} from '../src/agent/permission.js';
import { suggestRules } from '../src/agent/permission-rules.js';
import { ToolHookGate, type ToolHooksConfig } from '../src/hooks/tool-hooks.js';
import { PermissionQueue } from '../src/tui/permission-queue.js';
import { assert, header, report } from './shared.js';

const ROOT = '/tmp/darwin-permission-mode-switch';
const HOME = process.env['HOME'] ?? '/tmp/darwin-permission-mode-switch-home';

const SAFE_BASH = { command: 'git status' };
const DANGEROUS_BASH = { command: 'rm -rf /tmp/scratch' };
const WRITE = { command: 'str_replace', path: `${ROOT}/src/index.ts`, old_str: 'a', new_str: 'b' };
const READ = { command: 'view', path: `${ROOT}/src/index.ts` };

/**
 * Minimal stand-in for the SDK event, as in `verify-permission-modes.ts`: the gate
 * reads `toolUse` and the calling agent's id, and the real event carries both.
 */
function fakeEvent(name: string, input: unknown, agentId = 'darwin'): BeforeToolCallEvent {
  return { toolUse: { name, input }, agent: { id: agentId } } as unknown as BeforeToolCallEvent;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Lets the event loop run the microtasks and timers a pending decision is on. */
async function settle(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function actionType(action: { type: string }): string {
  return action.type;
}

function reasonOf(action: { type: string; reason?: string }): string {
  return action.reason ?? '';
}

function makeGate(options: Partial<PermissionGateOptions> & { mode: PermissionGateOptions['mode'] }): {
  gate: PermissionGate;
  asked: AssessedPermissionRequest[];
} {
  const asked: AssessedPermissionRequest[] = [];
  const gate = new PermissionGate({
    projectRoot: ROOT,
    ask: async (request) => {
      asked.push(request);
      return { allowed: true };
    },
    ...options,
  });
  return { gate, asked };
}

function liveValue(): void {
  header('mode — the live value and its guards');

  const { gate } = makeGate({ mode: 'default' });
  assert('the gate starts on the mode it was constructed with', gate.mode === 'default');

  const change = gate.setMode('plan');
  assert('a switch reports both ends of the transition', change.previous === 'default' && change.mode === 'plan');
  assert('…and takes effect immediately', gate.mode === 'plan');
  assert('…with nothing pending to withdraw', change.withdrawn === 0);

  const same = gate.setMode('plan');
  assert('switching to the mode already in force changes nothing', same.previous === 'plan' && same.withdrawn === 0);
  assert('…and stays in that mode', gate.mode === 'plan');

  // The command layer's guard: an unusable argument must never reach the gate.
  assert('every mode name is accepted', APPROVAL_MODES.every((mode) => isApprovalMode(mode)));
  assert('a near miss is refused', !isApprovalMode('yolo!') && !isApprovalMode('Plan') && !isApprovalMode(''));
  assert('a non-string is refused', !isApprovalMode(undefined) && !isApprovalMode(3));
  assert(
    'every mode can be described for the notice that reports it',
    APPROVAL_MODES.every((mode) => describeApprovalMode(mode).startsWith(mode)),
  );
}

async function enteringAndLeavingPlan(): Promise<void> {
  header('mode — entering plan mid-session denies before everything else');

  for (const [label, agentId] of [
    ['parent', 'darwin'],
    ['child dispatch', 'child-agent-1'],
  ] as const) {
    let classifierCalls = 0;
    const classifier: SafetyClassifier = async () => {
      classifierCalls += 1;
      return { safe: true, reason: 'approve everything' };
    };
    // Everything that could clear a call is switched on: a broad allow rule, a
    // classifier that approves anything, and a bridge that says yes.
    const { gate, asked } = makeGate({
      mode: 'auto',
      allowRules: ['bash', 'fileEditor'],
      classifier,
      dispatchSource: (id) =>
        id === 'child-agent-1'
          ? { dispatchId: 'd1', agentName: 'general', label: 'general#1' }
          : undefined,
    });

    const before = await gate.beforeToolCall(fakeEvent('fileEditor', WRITE, agentId));
    assert(`${label}: a write proceeds while the session is outside plan`, actionType(before) === 'proceed');

    gate.setMode('plan');
    const write = await gate.beforeToolCall(fakeEvent('fileEditor', WRITE, agentId));
    assert(`${label}: the same write is denied once plan is entered`, actionType(write) === 'deny');
    assert(
      `${label}: …before rule, classifier and bridge`,
      asked.length === 0 && classifierCalls === 0,
    );
    assert(`${label}: …and the denial names plan mode actionably`, reasonOf(write).includes('run outside plan mode'));

    const execute = await gate.beforeToolCall(fakeEvent('bash', SAFE_BASH, agentId));
    assert(`${label}: a statically safe execute is denied too`, actionType(execute) === 'deny');
    const mcp = await gate.beforeToolCall(fakeEvent('mcp__anything__at_all', {}, agentId));
    assert(`${label}: unknown/MCP tools stay fail-closed as execute`, actionType(mcp) === 'deny');
    const read = await gate.beforeToolCall(fakeEvent('fileEditor', READ, agentId));
    assert(`${label}: reads still proceed`, actionType(read) === 'proceed' && asked.length === 0);

    header(`mode — leaving plan mid-session (${label})`);
    // A second gate with no allow rules: the point here is that the *ordinary* path
    // is back, and a rule broad enough to prove plan's precedence above would also
    // clear the call without ever asking.
    let plainClassifierCalls = 0;
    const { gate: plain, asked: plainAsked } = makeGate({
      mode: 'plan',
      classifier: async () => {
        plainClassifierCalls += 1;
        return { safe: true, reason: 'fine by the classifier' };
      },
      dispatchSource: (id) =>
        id === 'child-agent-1'
          ? { dispatchId: 'd1', agentName: 'general', label: 'general#1' }
          : undefined,
    });
    assert(
      `${label}: a dangerous call is denied while still in plan`,
      actionType(await plain.beforeToolCall(fakeEvent('bash', DANGEROUS_BASH, agentId))) === 'deny',
    );

    plain.setMode('default');
    const after = await plain.beforeToolCall(fakeEvent('bash', DANGEROUS_BASH, agentId));
    assert(`${label}: leaving plan puts the call back through the ordinary gate`, actionType(after) === 'proceed');
    assert(`${label}: …by asking the user`, plainAsked.length === 1);
    assert(
      `${label}: …and the prompt is attributed to the right agent`,
      plainAsked[0]?.source.label === (agentId === 'darwin' ? 'parent' : 'general#1'),
    );

    plain.setMode('yolo');
    const yolo = await plain.beforeToolCall(fakeEvent('bash', DANGEROUS_BASH, agentId));
    assert(`${label}: yolo entered mid-session stops asking`, actionType(yolo) === 'proceed' && plainAsked.length === 1);

    plain.setMode('auto');
    const auto = await plain.beforeToolCall(fakeEvent('bash', DANGEROUS_BASH, agentId));
    assert(
      `${label}: auto entered mid-session consults the classifier`,
      actionType(auto) === 'proceed' && plainClassifierCalls === 1 && reasonOf(auto).startsWith('classifier:'),
    );
  }
}

/** A model that calls one tool once, then finishes. Same shape as verify-tool-hooks. */
class ToolCallModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.mode-switch', contextWindowLimit: 200_000 };

  constructor(
    private readonly toolName: string,
    private readonly input: Record<string, unknown>,
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
        start: { type: 'toolUseStart', name: this.toolName, toolUseId: 'mode-switch-1' },
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

function hookGroup(matcher: string, command: string) {
  return { matcher, hooks: [{ type: 'command', command } as const] } as const;
}

/**
 * The composed intervention, mid-session: `ToolHookGate` asks the gate for its plan
 * guard *before* it runs a Pre hook, and it reads the live mode, so a session that
 * entered plan after the agent was built still spawns no hook shell.
 *
 * Also the end-to-end shape of a withdrawn prompt: the bridge switches the mode
 * while the question is on the table, and the tool body never runs.
 */
async function composedIntervention(): Promise<void> {
  header('mode — the composed hook/permission intervention follows the live mode');

  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  const log = path.join(ROOT, 'hook-log');
  const hooks: ToolHooksConfig = {
    PreToolUse: [hookGroup('*', `printf pre >> ${log}`)],
    PostToolUse: [hookGroup('*', `printf post >> ${log}`)],
  };

  const ran: string[] = [];
  const asked: AssessedPermissionRequest[] = [];
  const gate = new PermissionGate({
    mode: 'default',
    projectRoot: ROOT,
    ask: async (request) => {
      asked.push(request);
      return { allowed: true };
    },
  });
  const probe = tool({
    name: 'probeTool',
    description: 'Lifecycle probe.',
    inputSchema: z.object({ value: z.string() }),
    callback: () => {
      ran.push('body');
      return 'tool-ok';
    },
  });
  const agent = new Agent({
    model: new ToolCallModel('probeTool', { value: 'raw marker' }),
    tools: [probe],
    interventions: [new ToolHookGate(ROOT, hooks, gate)],
    printer: false,
  });

  // The switch happens after the agent — and its intervention — already exist.
  gate.setMode('plan');
  await agent.invoke('run');
  const transcript = JSON.stringify(agent.messages.map((message) => message.toJSON()));
  assert('plan entered mid-session runs no Pre or Post hook shell', (await readFile(log, 'utf8').catch(() => '')) === '');
  assert('…asks nobody', asked.length === 0);
  assert('…never runs the tool body', ran.length === 0);
  assert('…and the plan wording reaches the model', transcript.includes('Plan mode blocked this execute call'));

  header('mode — a switch made while the prompt is on the table');

  const switchLog = path.join(ROOT, 'switch-log');
  const switchRan: string[] = [];
  const answers: boolean[] = [];
  let switched = false;
  const switchGate = new PermissionGate({
    mode: 'default',
    projectRoot: ROOT,
    ask: async () => {
      // Standing in for the user: they change the mode instead of answering, and
      // then the stale answer arrives anyway. It must not be what decides the call.
      if (!switched) {
        switched = true;
        switchGate.setMode('plan');
      }
      answers.push(true);
      return { allowed: true };
    },
  });
  const switchProbe = tool({
    name: 'probeTool',
    description: 'Lifecycle probe.',
    inputSchema: z.object({ value: z.string() }),
    callback: () => {
      switchRan.push('body');
      return 'tool-ok';
    },
  });
  const switchAgent = new Agent({
    model: new ToolCallModel('probeTool', { value: 'raw marker' }),
    tools: [switchProbe],
    interventions: [
      new ToolHookGate(ROOT, { PreToolUse: [hookGroup('*', `printf pre >> ${switchLog}`)] }, switchGate),
    ],
    printer: false,
  });
  await switchAgent.invoke('run');
  const switchTranscript = JSON.stringify(switchAgent.messages.map((message) => message.toJSON()));
  assert('an approval that lands after the switch does not run the tool', switchRan.length === 0);
  assert('…the call is re-decided under the new mode', switchTranscript.includes('Plan mode blocked this execute call'));
  assert('…and the user is asked exactly once, not re-prompted under plan', answers.length === 1);
  // The Pre hook had already run under the old mode: entering plan cannot un-run a
  // shell that has finished. What it guarantees is that the *tool* never runs and no
  // further call gets past the guard.
  assert('a Pre hook that already ran is not undone', (await readFile(switchLog, 'utf8').catch(() => '')) === 'pre');
}

async function classifierInFlight(): Promise<void> {
  header('mode — a classifier verdict in flight is discarded, never applied');

  for (const [next, expected, why] of [
    ['plan', 'deny', 'plan denies the re-decided call'],
    ['yolo', 'proceed', 'yolo proceeds without the verdict'],
    ['default', 'proceed', 'default asks the user instead of reusing the verdict'],
  ] as const) {
    const entered = deferred<void>();
    const release = deferred<void>();
    let classifierCalls = 0;
    const classifier: SafetyClassifier = async () => {
      classifierCalls += 1;
      entered.resolve();
      await release.promise;
      // A verdict that *would* have skipped the prompt, so applying it is visible.
      return { safe: true, reason: 'harmless in the classifier’s opinion' };
    };
    const { gate, asked } = makeGate({ mode: 'auto', classifier });

    const decision = gate.beforeToolCall(fakeEvent('bash', DANGEROUS_BASH));
    await entered.promise;
    const change = gate.setMode(next);
    assert(`→ ${next}: the in-flight decision is counted as withdrawn`, change.withdrawn === 1);
    const action = await decision;
    assert(`→ ${next}: ${why}`, actionType(action) === expected);
    assert(
      `→ ${next}: the verdict never reaches the decision`,
      !reasonOf(action).includes('classifier’s opinion'),
    );
    assert(
      `→ ${next}: the classifier is not consulted again under a mode that does not use it`,
      classifierCalls === 1,
    );
    assert(
      `→ ${next}: the user is asked exactly when the new mode says so`,
      asked.length === (next === 'default' ? 1 : 0),
    );
    // Releasing afterwards must change nothing: the call has already been decided.
    release.resolve();
    await settle();
    assert(`→ ${next}: a late verdict changes nothing`, actionType(action) === expected);
  }

  header('mode — a verdict that settles in the same tick as the switch');

  const entered = deferred<void>();
  const release = deferred<void>();
  const classifier: SafetyClassifier = async () => {
    entered.resolve();
    await release.promise;
    return { safe: true, reason: 'harmless in the classifier’s opinion' };
  };
  const { gate, asked } = makeGate({ mode: 'auto', classifier });
  const decision = gate.beforeToolCall(fakeEvent('bash', DANGEROUS_BASH));
  await entered.promise;
  // Verdict and switch in one synchronous block: the promise is already settled when
  // the mode changes, so only the post-settle re-check keeps this honest.
  release.resolve();
  gate.setMode('plan');
  const action = await decision;
  assert('a verdict settled in the same tick as the switch is still discarded', actionType(action) === 'deny');
  assert('…and no prompt is raised on the way', asked.length === 0);
}

async function promptInFlight(): Promise<void> {
  header('mode — a queued prompt is withdrawn, not answered');

  const queue = new PermissionQueue();
  let notifications = 0;
  queue.subscribe(() => {
    notifications += 1;
  });
  const gate = new PermissionGate({ mode: 'default', projectRoot: ROOT, ask: queue.bridge });

  const first = gate.beforeToolCall(fakeEvent('bash', DANGEROUS_BASH));
  const second = gate.beforeToolCall(fakeEvent('fileEditor', { command: 'str_replace', path: '/etc/passwd', old_str: 'a', new_str: 'b' }));
  await settle();
  assert('both calls are queued, one on screen', queue.current !== undefined && queue.waiting === 1);
  const notificationsBefore = notifications;

  const change = gate.setMode('plan');
  assert('both pending prompts are reported as withdrawn', change.withdrawn === 2);
  assert('the prompt leaves the screen', queue.current === undefined && queue.waiting === 0);
  assert('…and the UI is told to redraw', notifications > notificationsBefore);

  assert('the call on screen is re-decided under plan', actionType(await first) === 'deny');
  assert('…and so is the one that was still queued', actionType(await second) === 'deny');

  // Nothing is left for a keystroke to answer: the queue is empty, so a late answer
  // cannot resolve a question that has already been re-decided.
  queue.answer({ allowed: true });
  await settle();
  assert('answering after the withdrawal is a no-op', queue.current === undefined);

  header('mode — a prompt answered before any switch still decides');

  const plainQueue = new PermissionQueue();
  const plainGate = new PermissionGate({ mode: 'default', projectRoot: ROOT, ask: plainQueue.bridge });
  const plain = plainGate.beforeToolCall(fakeEvent('bash', DANGEROUS_BASH));
  await settle();
  plainQueue.answer({ allowed: true });
  const plainAction = await plain;
  assert('an ordinary approval is applied as before', actionType(plainAction) === 'proceed');
  assert('…and a switch afterwards cannot retroactively change it', plainGate.setMode('plan').withdrawn === 0);

  header('mode — a bridge that ignores the withdrawal signal');

  // `allowAllBridge` and the headless bridge answer without ever looking at the
  // signal. The gate must still discard the answer: safety cannot depend on a
  // bridge's cooperation, only legibility can.
  const late = deferred<PermissionDecision>();
  const deafGate = new PermissionGate({
    mode: 'default',
    projectRoot: ROOT,
    ask: async () => late.promise,
  });
  const deaf = deafGate.beforeToolCall(fakeEvent('bash', DANGEROUS_BASH));
  await settle();
  deafGate.setMode('plan');
  late.resolve({ allowed: true, rule: 'bash' });
  const deafAction = await deaf;
  assert('an unwithdrawn "allow" answer is discarded all the same', actionType(deafAction) === 'deny');
  assert('…and the allow-rule it carried is not remembered', !deafGate.allowRules.includes('bash'));
}

async function restartCap(): Promise<void> {
  header('mode — the re-decision loop is bounded by construction');

  let asks = 0;
  const gate = new PermissionGate({
    mode: 'default',
    projectRoot: ROOT,
    // Never answers: every pass has to be ended by the user changing the mode.
    ask: async () => {
      asks += 1;
      return new Promise<PermissionDecision>(() => undefined);
    },
  });
  const decision = gate.beforeToolCall(fakeEvent('bash', DANGEROUS_BASH));
  for (let index = 0; index < 40; index += 1) {
    await settle(1);
    gate.setMode(index % 2 === 0 ? 'auto' : 'default');
  }
  await settle();
  const action = await decision;
  assert('a call flipped between asking modes forever is eventually denied', actionType(action) === 'deny');
  assert('…and says why, so the model can tell the user', reasonOf(action).includes('permission mode changed'));
  assert('…having stopped re-asking rather than looping', asks <= 20 && asks > 1);
  console.log(`  prompts raised before the cap: ${asks}`);
}

async function userOnly(): Promise<void> {
  header('mode — nothing a model can do changes it');

  const { gate, asked } = makeGate({ mode: 'default' });
  // Every channel the model actually has: rewrite darwin's own config, relaunch
  // darwin with a wider flag, or call a tool that sounds like it owns the policy.
  const attempts: [string, unknown][] = [
    ['fileEditor', { command: 'str_replace', path: `${ROOT}/.darwin/config.json`, old_str: 'default', new_str: 'yolo' }],
    ['fileEditor', { command: 'create', path: path.join(HOME, '.darwin', 'config.json'), file_text: '{"permissionMode":"yolo"}' }],
    ['bash', { command: 'darwin --permission-mode yolo' }],
    ['bash', { command: 'echo \'{"permissionMode":"yolo"}\' > ~/.darwin/config.json' }],
    ['mode', { mode: 'yolo' }],
    ['mcp__policy__set_permission_mode', { mode: 'yolo' }],
  ];
  for (const [name, input] of attempts) {
    const action = await gate.beforeToolCall(fakeEvent(name, input));
    assert(`${name} cannot change the mode: it is still default`, gate.mode === 'default');
    assert(`${name} is gated rather than run silently`, actionType(action) !== 'proceed' || asked.length > 0);
  }
  assert('every attempt had to go through the user', asked.length === attempts.length);

  // And in plan mode the same attempts are denied outright, before any prompt.
  gate.setMode('plan');
  const askedBefore = asked.length;
  for (const [name, input] of attempts) {
    const action = await gate.beforeToolCall(fakeEvent(name, input));
    assert(`${name} is denied in plan mode without a prompt`, actionType(action) === 'deny');
  }
  assert('plan denied all of them without asking', asked.length === askedBefore);
  assert('…and the mode is still what the user set', gate.mode === 'plan');

  // No allow-rule can ever cover the one write that would matter, so "always allow"
  // cannot become a path to a persisted widening either.
  const configWrite = classify('fileEditor', {
    command: 'str_replace',
    path: path.join(ROOT, '.darwin', 'config.json'),
    old_str: 'a',
    new_str: 'b',
  });
  assert('no rule is ever offered for darwin’s own config', suggestRules(configWrite, ROOT).length === 0);
}

async function main(): Promise<void> {
  liveValue();
  await enteringAndLeavingPlan();
  await composedIntervention();
  await classifierInFlight();
  await promptInFlight();
  await restartCap();
  await userOnly();
  await rm(ROOT, { recursive: true, force: true });
  report();
}

await main();

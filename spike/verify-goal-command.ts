/**
 * `/goal` (SER-108) — free, no provider call, no pty.
 *
 * Pins everything about the feature that is not the terminal: the grammar, the pure
 * state machine (completed turn -> check -> one continuation, the hard cap, cancel and
 * failure clearing goal-owned work, the idle gate that keeps every other owner of the
 * session ahead of the goal), the bounded evidence / prompt / verdict projections, the
 * single-shot check call (bounded, cancellable even when the provider ignores the signal,
 * timed out, strict about the reply), the runtime's `checkGoal` and headless refusal
 * against a real `AgentRuntime`, and the command registration. The end-to-end loop —
 * cap, cancel-wins, permission precedence, queue interaction, live visibility — is
 * `spike/verify-tui.ts goal`, a real pty, still free.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { Model, type BaseModelConfig, type Message, type ModelStreamEvent, type StreamOptions } from '@strands-agents/sdk';

import { GOAL_CHECK_MAX_TOKENS, boundedReason, goalCheckConfig, goalCheckRequest, parseGoalVerdict, runGoalCheck } from '../src/agent/goal-check.js';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { DEFAULT_CLASSIFIER_MODELS } from '../src/agent/safety-classifier.js';
import {
  GOAL_CONDITION_MAX_CODE_POINTS,
  GOAL_HEADLESS_REFUSAL,
  parseGoalCommand,
} from '../src/commands/goal-command.js';
import { BUILTIN_COMMAND_NAMES, builtinCommandDescription } from '../src/commands/custom-commands.js';
import { runHeadlessTurn } from '../src/headless.js';
import { StructuredHeadlessWriter, runStructuredHeadlessTurn } from '../src/headless-protocol.js';
import {
  GOAL_EVIDENCE_MAX_TOOLS,
  GOAL_EVIDENCE_TEXT_MAX_CODE_POINTS,
  GOAL_MAX_CONTINUATIONS,
  composeGoalEvidence,
  goalAction,
  goalAfterCheck,
  goalAfterTurn,
  goalBeforeTurn,
  goalContinuationPrompt,
  goalContinued,
  goalLiveSuffix,
  goalStatusText,
  newGoal,
  type GoalIdleContext,
  type GoalState,
} from '../src/tui/goal.js';
import { MAX_COMPLETIONS } from '../src/tui/InputBox.js';
import { formatHelpReport } from '../src/tui/help-format.js';
import { CaptureModel } from './offline-model.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const home = ownPrivateHome('goal-command');

// --- Grammar ---------------------------------------------------------------------------
header('/goal grammar');
assert('bare /goal is the status form', parseGoalCommand('/goal')?.kind === 'status');
assert('/goal with only whitespace is the status form', parseGoalCommand('/goal   \n\t')?.kind === 'status');
assert('/goal off is the off form, any case', ['/goal off', '/goal OFF', '/goal  Off '].every((text) => parseGoalCommand(text)?.kind === 'off'));
const set = parseGoalCommand('/goal all   tests\tpass\nand lint is clean');
assert('a condition is stored as one collapsed line', set?.kind === 'set' && set.condition === 'all tests pass and lint is clean');
const controlled = parseGoalCommand('/goal ship\u001b[31m it\u0007');
assert('control characters never reach the stored condition', controlled?.kind === 'set' && !/[\u0000-\u001f\u007f-\u009f]/u.test(controlled.condition));
assert('"off" only switches off as the whole argument', parseGoalCommand('/goal off-by-one is fixed')?.kind === 'set' && parseGoalCommand('/goal turn off the flag')?.kind === 'set');
assert('/goals and /goalx are not the command', parseGoalCommand('/goals') === undefined && parseGoalCommand('/goalx off') === undefined && parseGoalCommand('goal off') === undefined);
const limit = 'x'.repeat(GOAL_CONDITION_MAX_CODE_POINTS);
assert('a condition at the cap is accepted', parseGoalCommand(`/goal ${limit}`)?.kind === 'set');
const over = parseGoalCommand(`/goal ${limit}y`);
assert('a condition over the cap is refused with its length', over?.kind === 'too-long' && over.length === GOAL_CONDITION_MAX_CODE_POINTS + 1);
assert('the cap counts code points, not UTF-16 units', parseGoalCommand(`/goal ${'😀'.repeat(GOAL_CONDITION_MAX_CODE_POINTS)}`)?.kind === 'set');

// --- State machine ---------------------------------------------------------------------
header('/goal state machine');
const armed = newGoal('tests pass');
assert('a new goal is armed with no continuations and nothing owed', armed.phase === 'armed' && armed.continuations === 0);
assert('an armed goal starts nothing', goalAction(armed, idleContext()) === 'none');

const afterUser = goalAfterTurn(armed, 'user', 'completed').goal!;
assert('a completed user turn owes one check and resets the counter', afterUser.phase === 'check-due' && afterUser.continuations === 0);
assert('a cancelled user turn owes nothing and keeps the goal', goalAfterTurn(armed, 'user', 'cancelled').goal?.phase === 'armed');
assert('a failed user turn owes nothing and keeps the goal', goalAfterTurn(afterUser, 'user', 'failed').goal?.phase === 'armed');
const cancelledGoalTurn = goalAfterTurn({ ...armed, phase: 'continuing', continuations: 2 }, 'goal', 'cancelled');
assert('user cancel of a goal continuation clears the goal and says so', cancelledGoalTurn.goal === undefined && /cancelled/u.test(cancelledGoalTurn.notice?.text ?? ''));
const failedGoalTurn = goalAfterTurn({ ...armed, phase: 'continuing', continuations: 2 }, 'goal', 'failed');
assert('a failed goal continuation clears the goal — no silent retry', failedGoalTurn.goal === undefined && /failure/u.test(failedGoalTurn.notice?.text ?? ''));
assert('a completed goal continuation owes the next check', goalAfterTurn({ ...armed, phase: 'continuing', continuations: 2 }, 'goal', 'completed').goal?.phase === 'check-due');
const sessionTurn = goalAfterTurn({ ...armed, continuations: 3 }, 'session', 'completed').goal!;
assert('a wake or peer turn owes a check but never resets the cap counter', sessionTurn.phase === 'check-due' && sessionTurn.continuations === 3);
const cappedGoal: GoalState = { ...armed, phase: 'capped', continuations: GOAL_MAX_CONTINUATIONS };
assert('a session turn does not re-arm a capped goal', goalAfterTurn(cappedGoal, 'session', 'completed').goal?.phase === 'capped');
assert('a user turn re-arms a capped goal with a fresh counter', goalAfterTurn(cappedGoal, 'user', 'completed').goal?.continuations === 0);
assert('a cancelled turn leaves a capped goal capped', goalAfterTurn(cappedGoal, 'user', 'cancelled').goal?.phase === 'capped');
assert('a turn starting drops a stale owed check or continuation', goalBeforeTurn({ ...armed, phase: 'check-due' }, 'user').phase === 'armed' && goalBeforeTurn({ ...armed, phase: 'continue-due' }, 'session').phase === 'armed');
assert('the goal continuation itself keeps its phase', goalBeforeTurn({ ...armed, phase: 'continuing', continuations: 1 }, 'goal').phase === 'continuing');

const met = goalAfterCheck({ ...afterUser, phase: 'checking' }, { kind: 'verdict', met: true, reason: 'tests green', inputTokens: 100, outputTokens: 12 });
assert('a met verdict clears the goal and states reason and spend', met.goal === undefined && met.notice?.text.includes('goal met · tests green') === true && met.notice.text.includes('check 100 in / 12 out tokens'));
const unmet = goalAfterCheck({ ...afterUser, phase: 'checking' }, { kind: 'verdict', met: false, reason: 'lint fails' });
assert('an unmet verdict under the cap owes one continuation', unmet.goal?.phase === 'continue-due' && unmet.goal.note === 'lint fails');
assert('the unmet notice names the next continuation and never fakes token counts', unmet.notice?.text.includes(`continuing 1/${GOAL_MAX_CONTINUATIONS}`) === true && unmet.notice.text.includes('check tokens not reported') && !unmet.notice.text.includes('0 in'));
const atCap = goalAfterCheck({ ...armed, phase: 'checking', continuations: GOAL_MAX_CONTINUATIONS }, { kind: 'verdict', met: false, reason: 'still red' });
assert('an unmet verdict at the cap stops instead of continuing', atCap.goal?.phase === 'capped' && atCap.notice?.severity === 'warn' && atCap.notice.text.includes(`stopped after ${GOAL_MAX_CONTINUATIONS} automatic continuations`));
const failedCheck = goalAfterCheck({ ...armed, phase: 'checking' }, { kind: 'error', message: 'timed out' });
assert('a failed check starts no continuation and keeps the goal', failedCheck.goal?.phase === 'armed' && /no continuation started/u.test(failedCheck.notice?.text ?? ''));
const cancelledCheck = goalAfterCheck({ ...armed, phase: 'checking' }, { kind: 'cancelled' });
assert('a cancelled check clears the goal', cancelledCheck.goal === undefined);

// The cap, walked end to end: user turn, then check/continue cycles until the cap holds.
{
  let goal: GoalState | undefined = goalAfterTurn(newGoal('never'), 'user', 'completed').goal;
  let continuations = 0;
  let checks = 0;
  for (let guard = 0; guard < 50 && goal !== undefined; guard += 1) {
    if (goalAction(goal, idleContext()) === 'check') {
      checks += 1;
      goal = goalAfterCheck({ ...goal, phase: 'checking' }, { kind: 'verdict', met: false, reason: 'no' }).goal;
    } else if (goalAction(goal, idleContext()) === 'continue') {
      continuations += 1;
      goal = goalAfterTurn(goalContinued(goal), 'goal', 'completed').goal;
    } else break;
  }
  assert(`the loop makes exactly ${GOAL_MAX_CONTINUATIONS} continuations then stops`, continuations === GOAL_MAX_CONTINUATIONS && goal?.phase === 'capped');
  assert('one check follows every completed turn, the last one deciding the cap', checks === GOAL_MAX_CONTINUATIONS + 1);
  assert('a capped goal owes nothing further', goalAction(goal, idleContext()) === 'none');
}
assert('the cap is a small finite constant', Number.isInteger(GOAL_MAX_CONTINUATIONS) && GOAL_MAX_CONTINUATIONS >= 1 && GOAL_MAX_CONTINUATIONS <= 10);

// --- The idle gate: every other owner of the session goes first ---------------------------
header('/goal idle gate');
const due = { ...armed, phase: 'check-due' as const };
const cont = { ...armed, phase: 'continue-due' as const, note: 'n' };
assert('an idle, empty session starts the owed check and the owed continuation', goalAction(due, idleContext()) === 'check' && goalAction(cont, idleContext()) === 'continue');
const holds: [string, Partial<GoalIdleContext>][] = [
  ['a busy session', { idle: false }],
  ['a pending permission decision', { permissionPending: true }],
  ['a /clear assembling a successor', { clearing: true }],
  ['a drained entry in flight', { draining: true }],
  ['a queued user prompt, ! command or wake', { queued: 1 }],
  ['a peer message waiting', { peerPending: 1 }],
];
for (const [label, patch] of holds) {
  assert(`${label} holds both the check and the continuation`, goalAction(due, idleContext(patch)) === 'none' && goalAction(cont, idleContext(patch)) === 'none');
}
assert('no goal never acts', goalAction(undefined, idleContext()) === 'none');

// --- Projections -------------------------------------------------------------------------
header('/goal projections');
assert('no goal adds nothing to the header or hint', goalLiveSuffix(undefined) === '');
assert('the suffix names armed, checking, continuing and capped states', [
  [armed, ' · goal armed'],
  [due, ' · goal checking'],
  [{ ...armed, phase: 'checking' as const }, ' · goal checking'],
  [{ ...armed, phase: 'continuing' as const, continuations: 2 }, ` · goal continuing 2/${GOAL_MAX_CONTINUATIONS}`],
  [cont, ` · goal continuing 1/${GOAL_MAX_CONTINUATIONS}`],
  [cappedGoal, ` · goal capped ${GOAL_MAX_CONTINUATIONS}/${GOAL_MAX_CONTINUATIONS}`],
  [{ ...armed, continuations: 2 }, ` · goal 2/${GOAL_MAX_CONTINUATIONS}`],
].every(([goal, expected]) => goalLiveSuffix(goal as GoalState) === expected));
assert('status text without a goal states none and the grammar', goalStatusText(undefined).includes('none set') && goalStatusText(undefined).includes('/goal off'));
assert('status text with a goal states condition, counter and where it is', goalStatusText(cont).includes('tests pass') && goalStatusText(cont).includes(`0/${GOAL_MAX_CONTINUATIONS}`) && goalStatusText(cappedGoal).includes('continuation cap'));

const evidence = composeGoalEvidence(['first answer', 'final answer'], [{ name: 'bash', status: 'success' }, { name: 'fileEditor', status: 'error' }]);
assert('evidence lists tool outcomes then the answer', evidence.includes('- bash: ok') && evidence.includes('- fileEditor: error') && evidence.includes('final answer'));
assert('empty evidence says so instead of being blank', composeGoalEvidence([], []).includes('(none)') && composeGoalEvidence([], []).includes('(no answer text)'));
const longAnswer = `HEAD${'a'.repeat(GOAL_EVIDENCE_TEXT_MAX_CODE_POINTS)}TAIL`;
const cutEvidence = composeGoalEvidence([longAnswer], []);
assert('long answer text is cut to its tail and the cut is stated', cutEvidence.includes('TAIL') && !cutEvidence.includes('HEAD') && cutEvidence.includes('earlier answer text not shown'));
assert('the answer slice is exactly the cap', Array.from(cutEvidence.split('final answer:\n(earlier answer text not shown)\n')[1] ?? '').length === GOAL_EVIDENCE_TEXT_MAX_CODE_POINTS);
const manyTools = composeGoalEvidence([], Array.from({ length: GOAL_EVIDENCE_MAX_TOOLS + 7 }, (_, index) => ({ name: `t${index}`, status: 'success' as const })));
assert('tool rows are capped at the most recent and the cut is stated', manyTools.includes('7 earlier tool calls not shown') && manyTools.includes(`t${GOAL_EVIDENCE_MAX_TOOLS + 6}`) && !manyTools.includes('- t0:'));

const prompt = goalContinuationPrompt('tests pass', 'lint fails');
assert('the continuation prompt quotes the condition and the note and cannot start with a command sigil', prompt.includes('tests pass') && prompt.includes('lint fails') && !/^[/!]/u.test(prompt));
assert('boundedReason flattens control characters and whitespace', boundedReason('a\nb\u001b[0m  c') === 'a b [0m c');
assert('boundedReason caps long text with an ellipsis', Array.from(boundedReason('z'.repeat(1000))).length === 240 && boundedReason('z'.repeat(1000)).endsWith('…'));

// --- Verdict parsing ---------------------------------------------------------------------
header('/goal verdict parsing');
assert('a bare JSON verdict parses', parseGoalVerdict('{"met": true, "reason": "ok"}')?.met === true);
assert('prose around the JSON is tolerated', parseGoalVerdict('Sure!\n{"met": false, "reason": "no"}\nDone')?.met === false);
assert('a non-boolean met is unparseable, never "met"', parseGoalVerdict('{"met": "true"}') === undefined && parseGoalVerdict('{"met": 1}') === undefined && parseGoalVerdict('{"reason": "x"}') === undefined);
assert('non-JSON and empty replies are unparseable', parseGoalVerdict('met') === undefined && parseGoalVerdict('') === undefined && parseGoalVerdict('{oops}') === undefined);
assert('a missing reason gets a stated placeholder', parseGoalVerdict('{"met": true}')?.reason === '(no reason given)');
assert('the request fences the goal and the record as data', goalCheckRequest('g', 'r').includes('<goal>\ng\n</goal>') && goalCheckRequest('g', 'r').includes('<turn-record>\nr\n</turn-record>'));

// --- The single-shot check call ------------------------------------------------------------
header('/goal check call');
class ScriptedModel extends Model<BaseModelConfig> {
  readonly requests: { messages: Message[]; options: StreamOptions | undefined }[] = [];
  private config: BaseModelConfig = { modelId: 'fake.goal-check', contextWindowLimit: 200_000 };
  constructor(private readonly behaviour: 'reply' | 'hang' | 'ignore-signal', private readonly reply = '{"met": true, "reason": "green"}') { super(); }
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    this.requests.push({ messages: messages.map((message) => message.clone()), options });
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (this.behaviour !== 'reply') await new Promise<void>((resolve) => setTimeout(resolve, 60_000).unref());
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: this.reply } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMetadataEvent', usage: { inputTokens: 321, outputTokens: 17, totalTokens: 338 } };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}
{
  const model = new ScriptedModel('reply');
  const verdict = await runGoalCheck(model, 'tests pass', 'record text', new AbortController().signal);
  assert('a check returns the verdict with the provider-reported usage', verdict.met === true && verdict.reason === 'green' && verdict.inputTokens === 321 && verdict.outputTokens === 17);
  const sent = model.requests[0]!;
  const text = sent.messages[0]!.content.map((block) => (block.type === 'textBlock' ? block.text : '')).join('');
  assert('the model sees exactly the goal and the record, in one message, with a system prompt and a cancel signal', model.requests.length === 1 && sent.messages.length === 1 && text.includes('tests pass') && text.includes('record text') && sent.options?.systemPrompt !== undefined && sent.options.cancelSignal !== undefined);
  assert('the check offers no tools', sent.options?.toolSpecs === undefined || sent.options.toolSpecs.length === 0);

  await rejects('an unparseable reply rejects the check', runGoalCheck(new ScriptedModel('reply', 'looks fine to me'), 'g', 'r', new AbortController().signal), /expected JSON verdict/u);
  const controller = new AbortController();
  const hung = runGoalCheck(new ScriptedModel('hang'), 'g', 'r', controller.signal);
  setTimeout(() => controller.abort(), 30);
  const started = Date.now();
  await rejects('a cancel rejects a hung check', hung, /cancelled/u);
  assert('the cancel is prompt even though the provider stream never yields', Date.now() - started < 2_000);
  await rejects('a provider that ignores the signal is still bounded by the timeout', runGoalCheck(new ScriptedModel('ignore-signal'), 'g', 'r', new AbortController().signal, 80), /timed out/u);
  const preAborted = new AbortController();
  preAborted.abort();
  await rejects('an already-cancelled check rejects without waiting', runGoalCheck(new ScriptedModel('hang'), 'g', 'r', preAborted.signal), /cancelled/u);
}
{
  const config = goalCheckConfig({ provider: 'bedrock', model: 'us.big-model', region: 'us-west-2', maxTokens: 64_000, promptCache: true } as never);
  assert('the check runs on the classifier tier with tiny output and no cache points', config.model === DEFAULT_CLASSIFIER_MODELS.bedrock && config.maxTokens === GOAL_CHECK_MAX_TOKENS && config.promptCache === false);
  assert('an explicit classifierModel wins', goalCheckConfig({ provider: 'anthropic', model: 'big', classifierModel: 'custom-fast' } as never).model === 'custom-fast');
}

// --- Real runtime: checkGoal and the headless refusal ------------------------------------------
header('/goal runtime');
const root = path.join(home, 'project');
await mkdir(root);
await mkdir(path.join(home, '.darwin'), { recursive: true });
const created: { model: string; maxTokens: number | undefined; promptCache: unknown }[] = [];
const checkModel = new ScriptedModel('reply', '{"met": false, "reason": "still red"}');
const agentModel = new CaptureModel('agent reply');
setRuntimeModelFactoryForTest(async (config) => {
  created.push({ model: config.model, maxTokens: config.maxTokens, promptCache: config.promptCache });
  return config.maxTokens === GOAL_CHECK_MAX_TOKENS ? checkModel : agentModel;
});
const runtime = await AgentRuntime.create({ projectRoot: root, session: { kind: 'new' }, permissionModeOverride: 'yolo', permissionBridge: async () => ({ allowed: false }) });
try {
  const beforeChecks = created.length;
  const first = await runtime.checkGoal('tests pass', 'record', new AbortController().signal);
  const second = await runtime.checkGoal('tests pass', 'record', new AbortController().signal);
  assert('the runtime check returns the scripted verdict', first.met === false && first.reason === 'still red' && second.met === false);
  assert('the check model is built once, lazily, on the classifier tier', created.length - beforeChecks === 1 && created.at(-1)?.maxTokens === GOAL_CHECK_MAX_TOKENS && created.at(-1)?.promptCache === false);
  assert('the check never touches the agent model or the conversation', agentModel.calls.length === 0);

  const structuredLines: string[] = [];
  await rejects('text headless refuses /goal instead of sending it to the model', runHeadlessTurn(runtime, '/goal all tests pass', () => undefined), new RegExp(escape(GOAL_HEADLESS_REFUSAL.slice(0, 40)), 'u'));
  await rejects('structured headless refuses /goal too', runStructuredHeadlessTurn(runtime, '/goal off', new StructuredHeadlessWriter('json', (line) => structuredLines.push(line)), () => 'unexpected tool'), /interactive-only/u);
  await rejects('a bare /goal is refused in headless as well', runHeadlessTurn(runtime, '/goal', () => undefined), /interactive-only/u);
  assert('the refusal makes no model call', agentModel.calls.length === 0);
  assert('an ordinary prompt mentioning /goal mid-sentence is untouched', (await runtime.expandSlashCommand('please explain /goal')) === null);
} finally {
  await runtime.shutdown();
  setRuntimeModelFactoryForTest(undefined);
}

// --- Registration ------------------------------------------------------------------------------
header('/goal registration');
assert('goal is a built-in command exactly once, with a description', BUILTIN_COMMAND_NAMES.filter((name) => name === 'goal').length === 1 && (builtinCommandDescription('goal') ?? '') !== '');
assert('MAX_COMPLETIONS keeps every built-in visible', MAX_COMPLETIONS >= BUILTIN_COMMAND_NAMES.length);
assert('/help lists /goal with its description', formatHelpReport().includes(`/goal — ${builtinCommandDescription('goal')}`));

report();

function idleContext(patch: Partial<GoalIdleContext> = {}): GoalIdleContext {
  return { idle: true, permissionPending: false, clearing: false, draining: false, queued: 0, peerPending: 0, ...patch };
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

async function rejects(label: string, promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
    assert(label, false);
  } catch (error) {
    assert(label, pattern.test(error instanceof Error ? error.message : String(error)));
  }
}

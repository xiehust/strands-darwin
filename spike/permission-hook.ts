/**
 * Spike A — permission interception feasibility.
 *
 * Questions this answers:
 *   1. Can a BeforeToolCallEvent hook callback be async and await an external
 *      Promise (i.e. wait for a TUI confirmation)?
 *   2. Can the hook turn a tool call into a "user denied" result handed back to
 *      the model, without breaking the agent loop?
 *   3. Does the model keep talking after a denial?
 *   4. Does the SDK's own intervention framework (InterventionHandler + confirm)
 *      cover the same ground with input-aware policy?
 *
 * Run: pnpm tsx spike/permission-hook.ts
 */
import { Agent, BeforeToolCallEvent, BedrockModel, tool } from '@strands-agents/sdk';
import { InterventionHandler, InterventionActions } from '@strands-agents/sdk';
import { z } from 'zod';

/**
 * The `InterventionAction` union is not re-exported from the package root and
 * `./interventions` has no subpath export, so derive it from the base class.
 */
type InterventionAction = Awaited<ReturnType<InterventionHandler['beforeToolCall']>>;

import { MODEL_ID, REGION, assert, header, report } from './shared.js';

/** Records every side effect so assertions can check what really happened. */
interface Trace {
  toolRan: string[];
  askedFor: string[];
  awaitedMs: number[];
}

function newTrace(): Trace {
  return { toolRan: [], askedFor: [], awaitedMs: [] };
}

/**
 * Stands in for the Ink permission prompt: resolves asynchronously after a
 * delay, so an implementation that ignores the returned Promise would see
 * `undefined` instead of a decision.
 */
function fakeTuiPrompt(decision: 'y' | 'n', delayMs = 250) {
  return async (what: string, trace: Trace): Promise<'y' | 'n'> => {
    const start = Date.now();
    trace.askedFor.push(what);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    trace.awaitedMs.push(Date.now() - start);
    return decision;
  };
}

function makeTools(trace: Trace) {
  const writeFile = tool({
    name: 'writeFile',
    description: 'Write text content to a file at the given path.',
    inputSchema: z.object({
      path: z.string().describe('File path to write'),
      content: z.string().describe('Content to write'),
    }),
    callback: ({ path }) => {
      trace.toolRan.push(`writeFile:${path}`);
      return { ok: true, message: `wrote ${path}` };
    },
  });

  const readFile = tool({
    name: 'readFile',
    description: 'Read the text content of a file at the given path.',
    inputSchema: z.object({ path: z.string() }),
    callback: ({ path }) => {
      trace.toolRan.push(`readFile:${path}`);
      return { content: `stub contents of ${path}` };
    },
  });

  return { writeFile, readFile };
}

function newModel(): BedrockModel {
  return new BedrockModel({ region: REGION, modelId: MODEL_ID, maxTokens: 1024 });
}

/**
 * Scenario 1 — raw hook. Async callback awaits the prompt, then denies by
 * assigning a string to `event.cancel`. The executor turns that string into an
 * error-status ToolResultBlock, so the model sees a normal tool failure.
 */
async function rawHookDeny(): Promise<void> {
  header('1. raw BeforeToolCallEvent hook — async await + deny via event.cancel');

  const trace = newTrace();
  const ask = fakeTuiPrompt('n');
  const agent = new Agent({
    model: newModel(),
    tools: [makeTools(trace).writeFile],
    systemPrompt:
      'You are a file assistant. Use the writeFile tool when asked to write a file. ' +
      'If a tool call fails, explain the failure to the user in one sentence. Do not retry it.',
  });

  agent.addHook(BeforeToolCallEvent, async (event) => {
    if (event.toolUse.name !== 'writeFile') return;
    const decision = await ask(event.toolUse.name, trace);
    if (decision === 'n') {
      event.cancel = 'The user denied permission to run this tool. Do not retry it.';
    }
  });

  const result = await agent.invoke('Write the text "hello" to the file /tmp/spike-demo.txt');
  const finalText = result.lastMessage.content
    .filter((block) => block.type === 'textBlock')
    .map((block) => ('text' in block ? block.text : ''))
    .join('');

  const toolResultText = JSON.stringify(agent.messages.map((m) => m.toJSON()));

  console.log(`  asked for      : ${JSON.stringify(trace.askedFor)}`);
  console.log(`  awaited (ms)   : ${JSON.stringify(trace.awaitedMs)}`);
  console.log(`  tools executed : ${JSON.stringify(trace.toolRan)}`);
  console.log(`  stopReason     : ${result.stopReason}`);
  console.log(`  final text     : ${finalText.trim()}`);

  assert('hook callback was invoked', trace.askedFor.length > 0);
  assert(
    'async hook awaited the external Promise (>=200ms elapsed)',
    trace.awaitedMs.every((ms) => ms >= 200),
  );
  assert('denied tool did NOT execute', trace.toolRan.length === 0);
  assert('denial text reached the conversation as a tool result', toolResultText.includes('denied permission'));
  assert('agent loop completed normally', result.stopReason === 'endTurn');
  assert('model produced a closing message after denial', finalText.trim().length > 0);
}

/**
 * Scenario 2 — same hook, approval path. Confirms awaiting a prompt does not
 * itself block execution, only a denial does.
 */
async function rawHookApprove(): Promise<void> {
  header('2. raw hook — approval path still executes the tool');

  const trace = newTrace();
  const ask = fakeTuiPrompt('y');
  const agent = new Agent({
    model: newModel(),
    tools: [makeTools(trace).writeFile],
    systemPrompt: 'You are a file assistant. Use the writeFile tool when asked to write a file.',
  });

  agent.addHook(BeforeToolCallEvent, async (event) => {
    const decision = await ask(event.toolUse.name, trace);
    if (decision === 'n') event.cancel = 'User denied.';
  });

  const result = await agent.invoke('Write the text "hello" to the file /tmp/spike-approved.txt');

  console.log(`  tools executed : ${JSON.stringify(trace.toolRan)}`);
  console.log(`  stopReason     : ${result.stopReason}`);

  assert('approved tool executed', trace.toolRan.some((t) => t.startsWith('writeFile:')));
  assert('agent loop completed normally', result.stopReason === 'endTurn');
}

/**
 * Scenario 3 — the SDK's own intervention framework. A handler subclass gets the
 * typed event, so policy can read `toolUse.input` (needed because `fileEditor`
 * is one tool name covering both reads and writes) and hand back a decision the
 * SDK converts into approval or denial.
 */
class TuiPermissionGate extends InterventionHandler {
  readonly name = 'spike:tui-permission-gate';

  constructor(
    private readonly ask: (what: string, trace: Trace) => Promise<'y' | 'n'>,
    private readonly trace: Trace,
  ) {
    super();
  }

  override async beforeToolCall(event: BeforeToolCallEvent): Promise<InterventionAction> {
    if (!this.requiresApproval(event)) {
      return InterventionActions.proceed({ reason: 'read-only operation' });
    }
    const response = await this.ask(event.toolUse.name, this.trace);
    if (response === 'y') {
      return InterventionActions.proceed({ reason: 'approved by user' });
    }
    // deny() rather than confirm({ response }): a rejected confirm sends the model
    // `CONFIRMATION_FAILED: <prompt>`, while deny controls the wording it sees.
    return InterventionActions.deny(
      `The user denied permission to run ${event.toolUse.name}. Do not retry it; ask what to do instead.`,
    );
  }

  /** Read-only calls pass; anything that mutates state needs a human. */
  private requiresApproval(event: BeforeToolCallEvent): boolean {
    if (event.toolUse.name === 'readFile') return false;
    return true;
  }
}

async function interventionDeny(): Promise<void> {
  header('3. InterventionHandler + deny() — denial, with input-aware policy');

  const trace = newTrace();
  const { writeFile, readFile } = makeTools(trace);
  const agent = new Agent({
    model: newModel(),
    tools: [writeFile, readFile],
    interventions: [new TuiPermissionGate(fakeTuiPrompt('n'), trace)],
    systemPrompt:
      'You are a file assistant. Read files with readFile and write them with writeFile. ' +
      'If a tool call fails, explain the failure in one sentence and stop.',
  });

  const result = await agent.invoke(
    'First read /tmp/spike-src.txt, then write the text "copy" to /tmp/spike-dst.txt.',
  );
  const transcript = JSON.stringify(agent.messages.map((m) => m.toJSON()));

  console.log(`  asked for      : ${JSON.stringify(trace.askedFor)}`);
  console.log(`  tools executed : ${JSON.stringify(trace.toolRan)}`);
  console.log(`  stopReason     : ${result.stopReason}`);

  assert('allow-listed readFile ran without a prompt', !trace.askedFor.includes('readFile'));
  assert('readFile executed', trace.toolRan.some((t) => t.startsWith('readFile:')));
  assert('writeFile prompted for approval', trace.askedFor.includes('writeFile'));
  assert('denied writeFile did NOT execute', !trace.toolRan.some((t) => t.startsWith('writeFile:')));
  assert('agent loop completed normally after denial', result.stopReason === 'endTurn');
  assert('denial surfaced to the model as a DENIED tool result', transcript.includes('DENIED:'));
}

async function interventionApprove(): Promise<void> {
  header('4. InterventionHandler — approve');

  const trace = newTrace();
  const { writeFile, readFile } = makeTools(trace);
  const agent = new Agent({
    model: newModel(),
    tools: [writeFile, readFile],
    interventions: [new TuiPermissionGate(fakeTuiPrompt('y'), trace)],
    systemPrompt: 'You are a file assistant. Write files with the writeFile tool.',
  });

  const result = await agent.invoke('Write the text "copy" to /tmp/spike-dst.txt.');

  console.log(`  tools executed : ${JSON.stringify(trace.toolRan)}`);
  console.log(`  stopReason     : ${result.stopReason}`);

  assert('approved writeFile executed', trace.toolRan.some((t) => t.startsWith('writeFile:')));
  assert('agent loop completed normally', result.stopReason === 'endTurn');
}

async function main(): Promise<void> {
  console.log(`region=${REGION} modelId=${MODEL_ID}\n`);
  await rawHookDeny();
  await rawHookApprove();
  await interventionDeny();
  await interventionApprove();
  report();
}

await main();

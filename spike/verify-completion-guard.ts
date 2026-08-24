/** Offline SRF-013 classifier, driver, output-suppression, and trajectory contracts. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AgentResult,
  AgentResultEvent,
  ContentBlockEvent,
  Message,
  ModelMessageEvent,
  TextBlock,
  type AgentStreamEvent,
} from '@strands-agents/sdk';

import {
  COMPLETION_GUARD_PROMPT,
  CompletionGuardError,
  collectCompletionCandidate,
  isInternalCompletionNote,
  runWithCompletionGuard,
  type CompletionGuardRuntime,
} from '../src/agent/completion-guard.js';
import { runHeadlessTurn } from '../src/headless.js';
import { runStructuredHeadlessTurn, StructuredHeadlessWriter } from '../src/headless-protocol.js';
import { readTrajectory } from '../src/trajectory/reader.js';
import { formatReplay, replayRead } from '../src/trajectory/replay.js';
import { initialTurnState, turnReducer } from '../src/tui/turn-state.js';
import { TrajectoryRecorder } from '../src/trajectory/writer.js';
import { assert, header, report } from './shared.js';

const LEAK = 'Need continue tools';
const LEAK_2 = 'Need answer in Chinese / Update plan';
const fakeAgent = {} as never;

function events(text: string, stopReason: 'endTurn' | 'cancelled' = 'endTurn'): AgentStreamEvent[] {
  const message = new Message({ role: 'assistant', content: [new TextBlock(text)] });
  const state = {};
  return [
    new ContentBlockEvent({ agent: fakeAgent, contentBlock: new TextBlock(text), invocationState: state }),
    new ModelMessageEvent({ agent: fakeAgent, message, stopReason, invocationState: state }),
    new AgentResultEvent({
      agent: fakeAgent,
      result: new AgentResult({ stopReason, lastMessage: message, invocationState: state }),
      invocationState: state,
    }),
  ];
}

class ScriptedRuntime implements CompletionGuardRuntime {
  readonly inputs: string[] = [];
  readonly accepted: AgentStreamEvent[][] = [];
  readonly suppressed: AgentStreamEvent[][] = [];

  constructor(private readonly scripts: Array<AgentStreamEvent[] | Error>) {}

  send(input: string): AsyncIterable<AgentStreamEvent> {
    return this.open(input).events;
  }

  async beginCompletionGuardTurn(input: string) {
    return this.open(input);
  }

  private open(input: string) {
    this.inputs.push(input);
    const script = this.scripts.shift() ?? new Error('unexpected extra continuation');
    const buffered: AgentStreamEvent[] = [];
    const iterable = async function* () {
      if (script instanceof Error) throw script;
      for (const event of script) {
        buffered.push(event);
        yield event;
      }
    }();
    return {
      events: iterable,
      accept: () => this.accepted.push([...buffered]),
      suppress: () => this.suppressed.push([...buffered]),
    };
  }
}

async function classifierAndOneShot(): Promise<void> {
  header('completion guard — bounded classification and one-shot orchestration');
  assert('motivating tool-intent note matches', isInternalCompletionNote(LEAK));
  assert('motivating answer/plan note matches', isInternalCompletionNote(LEAK_2));
  assert('ordinary direct answer does not match', !isInternalCompletionNote('The task is complete. All checks passed.'));
  assert('user-facing instruction does not match', !isInternalCompletionNote('You need to update the plan before deploying.'));
  assert('private prompt is fixed and bounded', [...COMPLETION_GUARD_PROMPT].length <= 480 && !COMPLETION_GUARD_PROMPT.includes(LEAK));

  const runtime = new ScriptedRuntime([events(LEAK), events('All checks passed; the task is complete.')]);
  const accepted = await runWithCompletionGuard('private original request', (input) => collectCompletionCandidate(runtime, input));
  assert('exactly one ordinary continuation is attempted', runtime.inputs.length === 2);
  assert('continuation input is fixed and contains neither original nor note',
    runtime.inputs[1] === COMPLETION_GUARD_PROMPT && !runtime.inputs[1]!.includes('private original request') && !runtime.inputs[1]!.includes(LEAK));
  assert('matched candidate is suppressed and answer outcome accepted',
    runtime.suppressed.length === 1 && runtime.accepted.length === 1 && JSON.stringify(accepted).includes('task is complete'));

  const second = new ScriptedRuntime([events(LEAK), events(LEAK_2)]);
  let failure: unknown;
  try {
    await runWithCompletionGuard('question', (input) => collectCompletionCandidate(second, input));
  } catch (error) {
    failure = error;
  }

  const toolRuntime = new ScriptedRuntime([[
    ...events(LEAK),
    { type: 'beforeToolCallEvent', toolUse: { name: 'bash', toolUseId: 'tool-1', input: {} } } as AgentStreamEvent,
  ]]);
  const toolEvents = await runWithCompletionGuard('question', (input) => collectCompletionCandidate(toolRuntime, input));
  assert('a tool-bearing candidate remains possible and is never hidden',
    toolRuntime.inputs.length === 1 && toolRuntime.suppressed.length === 0 &&
    toolEvents.some((event) => event.type === 'beforeToolCallEvent'));
  assert('a second match is private terminal failure with no third turn',
    failure instanceof CompletionGuardError && second.inputs.length === 2 && second.suppressed.length === 2);

  const failed = new ScriptedRuntime([events(LEAK), new Error('continuation failed')]);
  await runWithCompletionGuard('question', (input) => collectCompletionCandidate(failed, input)).catch(() => undefined);
  assert('continuation failure receives no further continuation', failed.inputs.length === 2);

  const cancelled = new ScriptedRuntime([events(LEAK), events('', 'cancelled')]);
  const cancelledEvents = await runWithCompletionGuard('question', (input) => collectCompletionCandidate(cancelled, input));
  assert('cancellation is accepted honestly with no loop',
    cancelled.inputs.length === 2 && cancelledEvents.some((event) => event.type === 'agentResultEvent' && event.result.stopReason === 'cancelled'));
}

async function publicOutputs(): Promise<void> {
  header('completion guard — text, JSON, and JSONL never publish suppressed note');
  const textRuntime = new ScriptedRuntime([events(LEAK), events('Done for the user.')]);
  const stderr: string[] = [];
  const text = await runHeadlessTurn(
    { ...textRuntime, send: textRuntime.send.bind(textRuntime), beginCompletionGuardTurn: textRuntime.beginCompletionGuardTurn.bind(textRuntime), expandSlashCommand: async () => null },
    'question',
    (value) => stderr.push(value),
  );
  assert('headless text contains only accepted answer', text === 'Done for the user.');
  assert('headless text and notices contain no suppressed note', !`${text}${stderr.join('')}`.includes(LEAK));

  for (const format of ['json', 'stream-json'] as const) {
    const runtime = new ScriptedRuntime([events(LEAK), events('Structured answer.')]);
    const output: string[] = [];
    const writer = new StructuredHeadlessWriter(format, (value) => output.push(value));
    const result = await runStructuredHeadlessTurn(
      { ...runtime, send: runtime.send.bind(runtime), beginCompletionGuardTurn: runtime.beginCompletionGuardTurn.bind(runtime), expandSlashCommand: async () => null },
      'question', writer, () => 'tool',
    );
    const serialized = `${output.join('')}\n${JSON.stringify(result)}`;
    assert(`${format} contains accepted answer`, serialized.includes('Structured answer.'));
    assert(`${format} contains no suppressed note`, !serialized.includes(LEAK));
  }

  const tuiRuntime = new ScriptedRuntime([events(LEAK), events('Visible TUI answer.')]);
  const tuiEvents = await runWithCompletionGuard('question', (input) => collectCompletionCandidate(tuiRuntime, input));
  const tuiState = tuiEvents.reduce(
    (state, event) => turnReducer(state, { type: 'streamEvent', event }),
    initialTurnState,
  );
  const tuiText = JSON.stringify(tuiState);
  assert('TUI reducer text contains accepted answer', tuiText.includes('Visible TUI answer.'));
  assert('TUI reducer text contains no suppressed note', !tuiText.includes(LEAK));
}

async function trajectoryHonesty(): Promise<void> {
  header('completion guard — trajectory/replay surface omits note but records suppression');
  const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-completion-guard-'));
  try {
    const file = path.join(root, 'trajectory.jsonl');
    const recorder = new TrajectoryRecorder({
      file,
      run: {
        session: 'completion-guard', agentId: 'darwin', darwinVersion: 'test', provider: 'fake',
        model: 'fake', permissionMode: 'yolo', thinkingEffort: undefined, resumed: false, restoredMessages: 0,
      },
    });
    const scripts = [events(LEAK), events('Accepted trajectory answer.')];
    const runtime: CompletionGuardRuntime = {
      send: () => { throw new Error('unexpected fallback'); },
      beginCompletionGuardTurn: async (input, privateInput) => {
        const recording = privateInput ? recorder.beginPrivateTurn() : recorder.beginTurn(input);
        recording?.deferCompletionGuard();
        await recording?.inputDurable();
        const script = scripts.shift()!;
        return {
          events: (async function* () { for (const event of script) { recording?.record(event); yield event; } })(),
          accept: () => { recording?.acceptCompletionGuard(); recording?.end(); },
          suppress: () => { recording?.suppressCompletionGuard(); recording?.end(); },
        };
      },
    };
    await runWithCompletionGuard('question', (input) => collectCompletionCandidate(runtime, input));
    await recorder.close();
    const bytes = await readFile(file, 'utf8');
    const read = await readTrajectory(file);
    assert('raw trajectory contains no suppressed note', !bytes.includes(LEAK));
    assert('replay contains no suppressed note', !formatReplay(replayRead(read)).includes(LEAK));
    assert('private continuation input is not recorded', !bytes.includes(COMPLETION_GUARD_PROMPT));
    assert('trajectory retains honest suppression terminal and accepted answer',
      read.records.some((record) => record.type === 'turnEnded' && record.completionGuardSuppressed === true) &&
      bytes.includes('Accepted trajectory answer.'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await classifierAndOneShot();
await publicOutputs();
await trajectoryHonesty();
report();

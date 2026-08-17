/**
 * Pure contracts for streaming an answer into `<Static>` history. No terminal, no
 * model.
 *
 * The rule being defended is the one round 1 refused to give up and this task takes
 * on deliberately: **history says exactly what the authoritative block says**, even
 * though parts of it were written while the block was still open and `<Static>`
 * output cannot be recalled. So every assertion here is about one of three things —
 * what is committed and when, that the total is the answer exactly once, and that a
 * disagreement with the assembled block is *stated* rather than patched over.
 *
 * `spike/verify-tui.ts longAnswer` is the live half of this; `verify-trajectory.ts`
 * proves replay produces the same history from the same events.
 */
import {
  Agent,
  Model,
  type AgentStreamEvent,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
} from '@strands-agents/sdk';
import { renderToString } from 'ink';
import React from 'react';

import { formatReplay, type ReplayResult } from '../src/trajectory/replay.js';
import { MessageList } from '../src/tui/MessageList.js';
import {
  initialTurnState,
  turnReducer,
  type HistoryItem,
  type TurnState,
} from '../src/tui/turn-state.js';
import { assert, header, report } from './shared.js';

function event(value: unknown): AgentStreamEvent {
  return value as AgentStreamEvent;
}

/** One text delta, the way the SDK nests it. */
function delta(text: string): AgentStreamEvent {
  return event({
    type: 'modelStreamUpdateEvent',
    event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } },
  });
}

/** The assembled block that closes an answer. */
function close(text: string): AgentStreamEvent {
  return event({ type: 'contentBlockEvent', contentBlock: { type: 'textBlock', text } });
}

function stream(state: TurnState, ...events: AgentStreamEvent[]): TurnState {
  return events.reduce((current, next) => turnReducer(current, { type: 'streamEvent', event: next }), state);
}

/** Every delta separately, which is how a real stream arrives. */
function streamChars(state: TurnState, text: string): TurnState {
  return stream(state, ...[...text].map((char) => delta(char)));
}

function answers(state: TurnState): Extract<HistoryItem, { kind: 'assistant' }>[] {
  return state.history.filter((item): item is Extract<HistoryItem, { kind: 'assistant' }> =>
    item.kind === 'assistant');
}

/** The answer as history holds it: every piece, in order, joined by newlines. */
function assembled(state: TurnState): string {
  return answers(state)
    .map((item) => item.text)
    .filter((text) => text !== '')
    .join('\n');
}

const LINES = Array.from({ length: 120 }, (_, index) => `row ${index + 1}`);
const ANSWER = LINES.join('\n');

header('streaming into history — a line is committed once another follows it');

{
  let state = streamChars(initialTurnState, 'row 1\nrow 2');
  assert('one finished line is held back, not committed', answers(state).length === 0);
  assert('and it is still in the live region', state.liveText === 'row 1\nrow 2');

  state = streamChars(state, '\nrow 3');
  assert('a second finished line releases the first', answers(state).length === 1);
  assert('the committed piece is the older line only', answers(state)[0]?.text === 'row 1');
  assert('the newest finished line stays live', state.liveText === 'row 2\nrow 3');
  assert('the committed text is recorded verbatim for reconciliation',
    state.committedAnswer === 'row 1');
}

{
  // The shape this feature exists for: a long line-oriented answer.
  let state = streamChars(initialTurnState, ANSWER);
  assert('most of a 120-line answer reaches history while it is still arriving',
    answers(state).length > 100);
  assert('the live region holds only what cannot be committed yet',
    state.liveText.split('\n').length === 2);

  state = stream(state, close(ANSWER));
  assert('the whole answer is in history when the block closes', assembled(state) === ANSWER);
  assert('nothing is left live', state.liveText === '' && state.committedAnswer === '');
  assert('every line appears exactly once',
    LINES.every((line) => assembled(state).split('\n').filter((row) => row === line).length === 1));
  assert('exactly one piece carries the label',
    answers(state).filter((item) => item.part === 'whole' || item.part === 'first').length === 1);
  assert('exactly one piece closes the answer',
    answers(state).filter((item) => item.part === 'whole' || item.part === 'last').length === 1);
  assert('and the closing piece is the last entry',
    answers(state)[answers(state).length - 1]?.part === 'last');
}

header('streaming into history — the shapes that must not change');

{
  // One unbroken paragraph: nothing is committable until the block closes, so this
  // is byte-for-byte the behaviour that existed before this task. It is also why
  // `live-text.ts` and its scrolled-out notice stay load-bearing.
  const paragraph = 'x'.repeat(4000);
  let state = streamChars(initialTurnState, paragraph);
  assert('an unbroken paragraph commits nothing while it streams', answers(state).length === 0);
  assert('it is all still live', state.liveText === paragraph);
  state = stream(state, close(paragraph));
  assert('and it enters history as one whole answer',
    answers(state).length === 1 && answers(state)[0]?.part === 'whole' && answers(state)[0]?.text === paragraph);
}

{
  const state = stream(initialTurnState, delta('one line'), close('one line'));
  assert('a single-line answer is one whole entry, as before',
    answers(state).length === 1 && answers(state)[0]?.part === 'whole');
}

{
  // `contentBlockEvent` trims the assembled block, so leading blank lines are not
  // part of the answer. Committing them would invent rows the authoritative text
  // does not have — and turn a clean answer into a reported divergence.
  const state = stream(initialTurnState, delta('\n\n  first\nsecond\nthird\n'), close('\n\n  first\nsecond\nthird\n'));
  assert('leading blank lines are not committed', assembled(state) === 'first\nsecond\nthird');
  assert('the answer still closes cleanly',
    !state.history.some((item) => item.kind === 'notice'));
}

{
  const state = stream(initialTurnState, delta('a\nb\nc\n\n\n'), close('a\nb\nc\n\n\n'));
  assert('trailing blank lines are trimmed, as the single write always did',
    assembled(state) === 'a\nb\nc');
}

{
  const state = stream(initialTurnState, delta('   \n  \n'), close('   \n  \n'));
  assert('an answer of only whitespace leaves no entry at all', answers(state).length === 0);
}

header('streaming into history — the authoritative block decides');

{
  // The case round 1 named as the reason to defer this: the assembled block is not
  // what the deltas said. Nothing already printed can be retracted, so the
  // difference is stated and the authoritative text is written in full.
  let state = streamChars(initialTurnState, 'row 1\nrow 2\nrow 3\nrow 4');
  assert('lines were committed from the deltas', answers(state).length > 0);
  state = stream(state, close('row 1\nDIFFERENT\nrow 3\nrow 4'));

  const notices = state.history.filter((item) => item.kind === 'notice');
  assert('the divergence is stated', notices.length === 1);
  assert('and it is a warning, not a footnote',
    notices[0]?.kind === 'notice' && notices[0].severity === 'warn');
  assert('the notice says which version is authoritative',
    notices[0]?.kind === 'notice' && notices[0].text.includes('authoritative'));
  assert('the authoritative text is in history in full',
    answers(state)[answers(state).length - 1]?.text === 'row 1\nDIFFERENT\nrow 3\nrow 4');
  assert('and it is a labelled, closed answer of its own',
    answers(state)[answers(state).length - 1]?.part === 'whole');
  assert('what was already printed is not silently dropped',
    answers(state).some((item) => item.text === 'row 1' || item.text.startsWith('row 1\n')));
}

{
  // A block that only *continues* what was committed is the ordinary case, and must
  // add the remainder and nothing else.
  let state = streamChars(initialTurnState, 'alpha\nbeta\ngamma');
  const committedBefore = answers(state).length;
  state = stream(state, close('alpha\nbeta\ngamma'));
  assert('a continuing block adds exactly one closing piece',
    answers(state).length === committedBefore + 1);
  assert('and the total is the answer, once', assembled(state) === 'alpha\nbeta\ngamma');
}

{
  // An answer that ends on a newline: the last non-blank line is held back anyway, so
  // the closing piece has content and the blank row below has an owner. The invariant
  // is that a closing piece exists and is not empty — not that the commit stopped at
  // any particular line.
  let state = streamChars(initialTurnState, 'alpha\nbeta\ngamma\n');
  assert('the last non-blank line is still live when the deltas end',
    state.liveText === 'gamma\n' && state.committedAnswer === 'alpha\nbeta');
  state = stream(state, close('alpha\nbeta\ngamma\n'));
  assert('an answer ending on a newline still closes', assembled(state) === 'alpha\nbeta\ngamma');
  const last = answers(state)[answers(state).length - 1];
  assert('with a non-empty closing piece', last?.text === 'gamma' && last.part === 'last');
}

{
  // Interior blank lines are content — a paragraph break — and are committed with the
  // text. Only trailing ones wait, because the assembled block trims those away.
  let state = streamChars(initialTurnState, 'p1\n\np2\n\np3');
  state = stream(state, close('p1\n\np2\n\np3'));
  assert('paragraph breaks survive the trip through history',
    assembled(state) === 'p1\n\np2\n\np3');
  assert('and no divergence was reported for them',
    !state.history.some((item) => item.kind === 'notice'));
}

header('streaming into history — interruptions duplicate nothing');

{
  // A tool call mid-answer flushes the uncommitted remainder — and only that.
  let state = streamChars(initialTurnState, 'thinking about it\nfirst step\nsecond step');
  state = stream(state, event({
    type: 'beforeToolCallEvent',
    toolUse: { name: 'bash', toolUseId: 't1', input: { command: 'pwd' } },
  }));
  assert('a tool call mid-answer keeps the text exactly once',
    assembled(state) === 'thinking about it\nfirst step\nsecond step');
  assert('and leaves nothing live', state.liveText === '' && state.committedAnswer === '');
  assert('the flushed remainder closes the answer',
    answers(state)[answers(state).length - 1]?.part === 'last');
}

{
  // A cancelled turn: `turnEnded` arrives with no closing block at all.
  let state = streamChars(initialTurnState, 'row 1\nrow 2\nrow 3\npartial line');
  state = turnReducer(state, { type: 'turnEnded' });
  assert('a cancelled answer keeps every line exactly once',
    assembled(state) === 'row 1\nrow 2\nrow 3\npartial line');
  assert('a cancelled answer leaves nothing live',
    state.liveText === '' && state.committedAnswer === '');
  assert('and it is closed, so the next entry is not glued to it',
    answers(state)[answers(state).length - 1]?.part === 'last');
}

{
  // Cancelled before anything could be committed: unchanged from before this task.
  let state = streamChars(initialTurnState, 'half a line');
  state = turnReducer(state, { type: 'turnEnded' });
  assert('a short cancelled answer is one whole entry',
    answers(state).length === 1 && answers(state)[0]?.part === 'whole');
}

{
  // Two answers in one turn, split by a tool call: each keeps its own label.
  let state = streamChars(initialTurnState, 'a1\na2\na3');
  state = stream(state, close('a1\na2\na3'));
  state = streamChars(state, 'b1\nb2\nb3');
  state = stream(state, close('b1\nb2\nb3'));
  assert('each answer gets exactly one label',
    answers(state).filter((item) => item.part === 'whole' || item.part === 'first').length === 2);
  assert('and each gets exactly one closing piece',
    answers(state).filter((item) => item.part === 'whole' || item.part === 'last').length === 2);
}

header('streaming into history — what the transcript looks like');

{
  let state = streamChars(initialTurnState, ANSWER);
  state = stream(state, close(ANSWER));
  const output = renderToString(
    React.createElement(MessageList, {
      history: state.history,
      liveText: '',
      columns: 80,
      maxLiveRows: 10,
    }),
    { columns: 80 },
  );
  const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
  assert('the transcript names the agent once, not once per piece',
    plain.split('\n').filter((line) => line === 'agent').length === 1);
  assert('every answer line is in the transcript exactly once',
    LINES.every((line) => plain.split('\n').filter((row) => row.trim() === line).length === 1));
  assert('the answer is followed by exactly one blank row',
    /row 120\n\s*\n?$/.test(plain.replace(/\n+$/, '\n')));
  assert('no blank rows were inserted between the pieces',
    !/row 4\n\s*\nrow 5/.test(plain));
}

header('streaming into history — through a real Agent, offline');

/**
 * Streams a fixed answer one line per delta, the way a provider does.
 *
 * A real `Agent` over a real `Model` is the only way to see the events darwin will
 * actually get: the assembled `textBlock` is built by the SDK's own
 * `Model.streamAggregated`, which accumulates the deltas it just yielded. That is
 * also why the divergence branch above cannot be reached this way — the block *is*
 * the deltas — and why it is exercised at the reducer instead. It exists for the
 * paths that can still differ: the `trim()` on close, citation accumulation, and a
 * model that overrides the aggregation itself.
 *
 * No transport, so no network and no model call.
 */
class LineByLineModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.offline-lines', contextWindowLimit: 200_000 };

  constructor(private readonly answer: string) {
    super();
  }

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    for (const [index, line] of this.answer.split('\n').entries()) {
      const text = index === 0 ? line : `\n${line}`;
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } };
    }
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

{
  const answer = LINES.slice(0, 20).join('\n');
  const agent = new Agent({ model: new LineByLineModel(answer), printer: false });

  let state = initialTurnState;
  let committedBeforeClose = 0;
  for await (const streamEvent of agent.stream('go')) {
    state = turnReducer(state, { type: 'streamEvent', event: streamEvent });
    if (streamEvent.type === 'modelStreamUpdateEvent') committedBeforeClose = answers(state).length;
  }
  state = turnReducer(state, { type: 'turnEnded' });

  assert('a real stream commits lines before the block closes', committedBeforeClose >= 17);
  assert('and the answer is in history exactly once, whole', assembled(state) === answer);
  assert('with one label and one closing piece',
    answers(state).filter((item) => item.part === 'whole' || item.part === 'first').length === 1 &&
    answers(state).filter((item) => item.part === 'whole' || item.part === 'last').length === 1);
  assert('and nothing left live', state.liveText === '' && state.committedAnswer === '');
}

header('streaming into history — replay is the same transcript');

{
  // Replay reuses `turnReducer`, so the split is reproduced from the recorded events
  // for free — but its *rendering* is its own, and a chunked answer must not come
  // back as several replies. This is the same projection `darwin trajectory replay`
  // prints.
  let state = streamChars(initialTurnState, ANSWER);
  state = stream(state, close(ANSWER));
  const printed = formatReplay({
    history: state.history,
    turns: [1],
    runs: [],
    damage: undefined,
    droppedRecords: 0,
    failures: [],
    turnSpend: [],
    spend: { turns: 0, models: [], input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as unknown as ReplayResult);

  assert('replay prints one reply prefix for the whole answer',
    printed.split('\n').filter((line) => line.startsWith('darwin>')).length === 1);
  for (const line of ['row 1', 'row 60', 'row 120']) {
    assert(`replay contains ${line} exactly once`,
      printed.split('\n').filter((row) => row.replace('darwin> ', '') === line).length === 1);
  }
  assert('replay holds the answer whole',
    printed.includes('darwin> row 1') && printed.includes('row 120'));
}

report();

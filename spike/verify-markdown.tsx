/**
 * The markdown projection over assistant answer text (`src/tui/markdown.ts`,
 * `src/tui/MarkdownText.tsx`). No terminal, no model.
 *
 * The contract being defended: styling is a pure presentation-time projection —
 * every character of the committed text survives into the spans, ANSI-stripped
 * render output is exactly the plain text, fence state is derived
 * deterministically across `AnswerPart` piece boundaries, and `formatReplay`
 * (the `/export` / `darwin trajectory replay` projection) is byte-for-byte what
 * it was before markdown styling existed.
 */
// Before ink/chalk load: renderToString writes to a non-TTY, where chalk would
// emit no ANSI at all and the "styling actually happened" assertions would pass
// vacuously. Forcing color makes the presence check deterministic; the absence
// checks strip ANSI anyway.
import './force-color.js';

import { renderToString } from 'ink';
import React from 'react';

import type { AgentStreamEvent } from '@strands-agents/sdk';

import { formatReplay, type ReplayResult } from '../src/trajectory/replay.js';
import { liveTextView } from '../src/tui/live-text.js';
import { fenceOpenAfter, markdownLines, type MarkdownLine } from '../src/tui/markdown.js';
import { MarkdownAnswerText } from '../src/tui/MarkdownText.js';
import { MessageList } from '../src/tui/MessageList.js';
import { initialTurnState, turnReducer, type HistoryItem, type TurnState } from '../src/tui/turn-state.js';
import { assert, header, report } from './shared.js';

const ANSI = /\u001B\[[0-9;]*m/g;
const plain = (value: string): string => value.replace(ANSI, '');

/** Concatenated span text of one line — must reproduce the input verbatim. */
const lineText = (line: MarkdownLine): string => line.spans.map((span) => span.text).join('');
const roundTrip = (text: string, codeOpen = false): string =>
  markdownLines(text, codeOpen).map(lineText).join('\n');

header('markdown — headings');
{
  const [line] = markdownLines('## Section title');
  assert('a heading line is classified', line?.kind === 'heading');
  assert('the # marker is its own de-emphasized span', line?.spans[0]?.text === '## ' && line?.spans[0]?.style === 'marker');
  assert('heading keeps every character', roundTrip('## Section title') === '## Section title');
  assert('a bare # run is still a heading', markdownLines('###')[0]?.kind === 'heading');
  assert('#hashtag without a space is not a heading', markdownLines('#hashtag')[0]?.kind === 'text');
  assert('seven hashes are not a heading', markdownLines('####### deep')[0]?.kind === 'text');
}

header('markdown — emphasis and inline code');
{
  const [line] = markdownLines('mix of **bold**, *italic* and `code` here');
  assert('bold content gets a bold span', line?.spans.some((span) => span.style === 'bold' && span.text === 'bold') === true);
  assert('italic content gets an italic span', line?.spans.some((span) => span.style === 'italic' && span.text === 'italic') === true);
  assert('inline code gets a code span', line?.spans.some((span) => span.style === 'code' && span.text === 'code') === true);
  assert('the ** markers are kept as marker spans',
    line?.spans.filter((span) => span.style === 'marker' && span.text === '**').length === 2);
  assert('every character survives', roundTrip('mix of **bold**, *italic* and `code` here') === 'mix of **bold**, *italic* and `code` here');

  assert('an unclosed ** stays plain', markdownLines('a ** b')[0]?.spans.every((span) => span.style === 'plain') === true);
  assert('an unclosed backtick stays plain', markdownLines('a ` b')[0]?.spans.every((span) => span.style === 'plain') === true);
  assert('spaced asterisks are not emphasis: a * b * c',
    markdownLines('a * b * c')[0]?.spans.every((span) => span.style === 'plain') === true);
  assert('a bullet line does not turn italic',
    markdownLines('* item one *not emphasis')[0]?.spans.some((span) => span.style === 'italic') === false);
  assert('snake_case is never emphasis', markdownLines('use snake_case_names here')[0]?.spans.every((span) => span.style === 'plain') === true);
  assert('markdown chars inside inline code are code, not emphasis',
    markdownLines('`a ** b`')[0]?.spans.some((span) => span.style === 'code' && span.text === 'a ** b') === true);
  assert('double-backtick code keeps single backticks inside',
    markdownLines('``a ` b``')[0]?.spans.some((span) => span.style === 'code' && span.text === 'a ` b') === true);
}

header('markdown — fences, code lines and rules');
{
  const text = 'intro\n```ts\nconst x = 1;\n```\noutro';
  const lines = markdownLines(text);
  assert('the opening fence is a fence line', lines[1]?.kind === 'fence');
  assert('the fenced line is code', lines[2]?.kind === 'code');
  assert('the closing fence is a fence line', lines[3]?.kind === 'fence');
  assert('prose resumes after the close', lines[4]?.kind === 'text');
  assert('code lines are one whole-line code span', lines[2]?.spans[0]?.style === 'code' && lines[2]?.spans[0]?.text === 'const x = 1;');
  assert('fenced text keeps every character', roundTrip(text) === text);
  assert('markdown inside a fence stays code, not emphasis',
    markdownLines('```\n**not bold**\n```')[1]?.spans[0]?.style === 'code');
  assert('a rule line is classified', markdownLines('---')[0]?.kind === 'rule');
  assert('a tilde fence works too', markdownLines('~~~\nx\n~~~').map((line) => line.kind).join(',') === 'fence,code,fence');
}

header('markdown — fence state across piece boundaries');
{
  assert('no fences leaves the state closed', fenceOpenAfter('plain\nlines') === false);
  assert('an opened fence is reported open', fenceOpenAfter('a\n```ts') === true);
  assert('a closed fence is reported closed', fenceOpenAfter('```\ncode\n```') === false);
  assert('the state threads through an initial open', fenceOpenAfter('code\n```', true) === false);
  assert('an info-string line inside a block does not close it', fenceOpenAfter('```go', true) === true);

  // Piece 2 of an answer whose piece 1 opened a fence: with the carried state the
  // line is code; without it, it would be prose.
  const carried = markdownLines('const y = 2;', true);
  assert('a carried open fence styles the next piece as code', carried[0]?.kind === 'code');
  assert('and the same text without the carried state is prose', markdownLines('const y = 2;')[0]?.kind === 'text');
}

header('markdown — the reducer carries fence state onto committed pieces');
const event = (value: unknown): AgentStreamEvent => value as AgentStreamEvent;
const delta = (text: string): AgentStreamEvent =>
  event({ type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } } });
const close = (text: string): AgentStreamEvent =>
  event({ type: 'contentBlockEvent', contentBlock: { type: 'textBlock', text } });
const stream = (state: TurnState, ...events: AgentStreamEvent[]): TurnState =>
  events.reduce((current, next) => turnReducer(current, { type: 'streamEvent', event: next }), state);
const answers = (state: TurnState): Extract<HistoryItem, { kind: 'assistant' }>[] =>
  state.history.filter((item): item is Extract<HistoryItem, { kind: 'assistant' }> => item.kind === 'assistant');

const FENCED_ANSWER = 'Use this:\n```ts\nconst x = 1;\nconst y = 2;\n```\ndone';
{
  let state = initialTurnState;
  for (const char of FENCED_ANSWER) state = stream(state, delta(char));
  state = stream(state, close(FENCED_ANSWER));

  const pieces = answers(state);
  assert('the answer reached history in several pieces', pieces.length > 1);
  assert('the first piece starts closed-state', pieces[0]?.codeOpen === false);
  const inside = pieces.find((piece) => piece.text.startsWith('const y = 2;'));
  assert('a piece starting inside the fence carries codeOpen', inside?.codeOpen === true);
  // The closing piece ('```\ndone') also starts inside the fence: its first line
  // is the close. Styled from its carried state, that line is the fence delimiter
  // and 'done' is prose again.
  const closing = pieces.find((piece) => piece.text.includes('done'));
  assert('the closing piece starts inside the fence it closes', closing?.codeOpen === true);
  assert('and styles as fence-then-prose from that state',
    closing !== undefined &&
    markdownLines(closing.text, closing.codeOpen).map((line) => line.kind).join(',') === 'fence,text');
  assert('the committed text itself is untouched plain text',
    pieces.map((piece) => piece.text).filter((text) => text !== '').join('\n') === FENCED_ANSWER);

  // The live region derives its initial state from the same function over the
  // committed prefix, so mid-stream the two sides cannot disagree.
  let mid = initialTurnState;
  for (const char of 'Use this:\n```ts\nconst x = 1;\nconst y') mid = stream(mid, delta(char));
  assert('mid-stream, the live region would start inside the fence', fenceOpenAfter(mid.committedAnswer) === true);
  assert('and the live text styles as code from that state',
    markdownLines(mid.liveText, fenceOpenAfter(mid.committedAnswer))[0]?.kind === 'code');
}

header('markdown — ANSI-stripped render output is the plain text, unchanged');
{
  const text = '# Title\n\nSome **bold** and `code`.\n```ts\nconst x = 1;\n```\n*done*';
  const rendered = renderToString(<MarkdownAnswerText text={text} codeOpen={false} />, { columns: 200 });
  assert('stripping ANSI recovers the text byte for byte', plain(rendered) === text);
  assert('the styling did add ANSI on the way', rendered !== text);

  const transcript = plain(renderToString(
    <MessageList
      history={[{ kind: 'assistant', id: 'a', text, part: 'whole', codeOpen: false }]}
      liveText=""
      liveCodeOpen={false}
      columns={200}
      maxLiveRows={8}
      staticEpoch={0}
    />,
    { columns: 200 },
  ));
  assert('the transcript entry keeps the full plain text', transcript.includes(text));
  assert('non-markdown text passes through untouched',
    plain(renderToString(<MarkdownAnswerText text={'just prose\nwith lines'} codeOpen={false} />, { columns: 200 })) === 'just prose\nwith lines');
}

header('markdown — the live region styles without changing its row count');
{
  const liveText = '```ts\nconst x = 1;';
  const view = liveTextView(liveText, 80, 10);
  const output = renderToString(
    <MessageList history={[]} liveText={liveText} liveCodeOpen={false} columns={80} maxLiveRows={10} staticEpoch={0} />,
    { columns: 80 },
  );
  const rows = plain(output).replace(/\n+$/, '').split('\n');
  assert('the block draws label + exactly the counted rows', rows.length === 1 + view.rows.length);
  assert('the rows are the plain text after ANSI stripping', rows.slice(1).join('\n') === '```ts\nconst x = 1;');
}

header('markdown — formatReplay is byte-identical for markdown-bearing answers');
{
  let state = initialTurnState;
  for (const char of FENCED_ANSWER) state = stream(state, delta(char));
  state = stream(state, close(FENCED_ANSWER));

  const printed = formatReplay({
    history: state.history,
    turns: [1],
    runs: [],
    damage: undefined,
    droppedRecords: 0,
    failures: [],
    turnSpend: [],
    modelCalls: [],
    spend: { turns: 0, models: [], input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as unknown as ReplayResult);

  // Exactly what the pre-markdown formatter printed for this answer: the plain
  // pieces, one `darwin>` prefix, markers and fences verbatim, no trailing newline.
  const expected = `darwin> ${FENCED_ANSWER.split('\n')[0] as string}\n${FENCED_ANSWER.split('\n').slice(1).join('\n')}`;
  assert('replay output is the plain answer, byte for byte', printed === expected);
}

report();

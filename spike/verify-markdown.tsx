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

header('markdown — block vocabulary: list markers');
{
  const kind = (line: string): string | undefined => markdownLines(line)[0]?.kind;
  const spans = (line: string): readonly { readonly text: string; readonly style: string }[] =>
    markdownLines(line)[0]?.spans ?? [];
  const marker = (line: string): { readonly text: string; readonly style: string } | undefined => spans(line)[0];

  for (const bullet of ['- item', '* item', '+ item']) {
    assert(`a ${bullet[0] as string} bullet is a list line`, kind(bullet) === 'list');
    assert(`its marker is a dim marker span: ${bullet}`,
      marker(bullet)?.style === 'marker' && marker(bullet)?.text === `${bullet[0] as string} `);
    assert(`the bullet keeps every character: ${bullet}`, roundTrip(bullet) === bullet);
  }

  assert('a 1. ordered item is a list line', kind('1. first') === 'list');
  assert('the ordered marker is one dim span', marker('1. first')?.text === '1. ' && marker('1. first')?.style === 'marker');
  assert('a 2) ordered item is a list line', kind('2) second') === 'list');
  assert('ordered items keep every character', roundTrip('1. first\n2) second') === '1. first\n2) second');
  assert('the number is never renumbered', marker('7. seventh')?.text === '7. ');

  assert('an indented nested bullet is a list line', kind('    - nested') === 'list');
  assert('its indent travels inside the marker span, unchanged',
    marker('    - nested')?.text === '    - ' && marker('    - nested')?.style === 'marker');
  assert('the nested bullet keeps every character', roundTrip('    - nested') === '    - nested');
  assert('a tab-indented bullet keeps its tab', roundTrip('\t- nested') === '\t- nested');

  assert('list item text keeps its inline spans',
    spans('- see **this** now').some((span) => span.style === 'bold' && span.text === 'this'));
  assert('a marker with nothing after it is still a list line', kind('- ') === 'list');
  assert('an empty item keeps every character', roundTrip('- ') === '- ');

  // What must NOT become a list.
  assert('a hyphenated word is not a list', kind('-fast path') === 'text');
  assert('a bare dash is not a list', kind('-') === 'text');
  assert('an emphasis-opening line is not a list', kind('*italic* leads') === 'text');
  assert('a version string is not a list', kind('1.2.3 released') === 'text');
  assert('prose with a stray asterisk stays prose', kind('two * three is six') === 'text');
  assert('and keeps every character', roundTrip('two * three is six') === 'two * three is six');
}

header('markdown — block vocabulary: blockquotes');
{
  const line = markdownLines('> quoted **text**')[0];
  assert('a > line is a quote line', line?.kind === 'quote');
  assert('the > prefix is one dim marker span', line?.spans[0]?.text === '> ' && line?.spans[0]?.style === 'marker');
  assert('the quoted text keeps its inline spans',
    line?.spans.some((span) => span.style === 'bold' && span.text === 'text') === true);
  assert('the quote is not dimmed as a whole: its text stays a plain-tone span',
    line?.spans.some((span) => span.style === 'plain') === true);
  assert('a quote keeps every character', roundTrip('> quoted **text**') === '> quoted **text**');

  const nested = markdownLines('> > deeper')[0];
  assert('a nested quote is a quote line', nested?.kind === 'quote');
  assert('the whole > run is the marker', nested?.spans[0]?.text === '> > ');
  assert('the nested quote keeps every character', roundTrip('> > deeper') === '> > deeper');
  assert('a >> run is the marker too', markdownLines('>> deeper')[0]?.spans[0]?.text === '>> ');
  assert('a bare > line is a quote', markdownLines('>')[0]?.kind === 'quote');
  assert('an indented quote keeps its indent in the marker', markdownLines('  > q')[0]?.spans[0]?.text === '  > ');
  assert('a quote with no space after > is still a quote', markdownLines('>quoted')[0]?.kind === 'quote');
  assert('and keeps every character', roundTrip('>quoted') === '>quoted');
  assert('a comparison in prose is not a quote', markdownLines('a > b is true')[0]?.kind === 'text');
}

header('markdown — block vocabulary: table rows');
{
  const row = markdownLines('| name | value |')[0];
  assert('a pipe-fenced row is a table line', row?.kind === 'table');
  assert('every pipe is its own dim marker span',
    row?.spans.filter((span) => span.style === 'marker' && span.text === '|').length === 3);
  assert('the cells keep their exact spacing', row?.spans[1]?.text === ' name ' && row?.spans[3]?.text === ' value ');
  assert('a table row keeps every character', roundTrip('| name | value |') === '| name | value |');

  const delimiter = '|:---|---:|';
  assert('the delimiter row is a table line', markdownLines(delimiter)[0]?.kind === 'table');
  assert('the delimiter row keeps every character', roundTrip(delimiter) === delimiter);

  assert('cells keep their inline spans',
    markdownLines('| `code` | **bold** |')[0]?.spans.some((span) => span.style === 'code' && span.text === 'code') === true);

  const table = '| a | b |\n|---|---|\n| 1 | 2 |';
  assert('a whole table classifies row by row',
    markdownLines(table).map((line) => line.kind).join(',') === 'table,table,table');
  assert('the whole table keeps every character', roundTrip(table) === table);
  assert('columns are never aligned', roundTrip('|a|      b|') === '|a|      b|');

  // Deliberately NOT a table: a bare pipe in prose. Dimming shell pipes and
  // prose alternations is a worse failure than an undecorated pipeless row.
  assert('a shell pipeline in prose is not a table', markdownLines('run rg foo | wc -l next')[0]?.kind === 'text');
  assert('an alternation in prose is not a table', markdownLines('pick a | b here')[0]?.kind === 'text');
  assert('a pipeless table row is prose, not a table', markdownLines('a | b')[0]?.kind === 'text');
  assert('prose with a stray pipe keeps every character', roundTrip('run rg foo | wc -l next') === 'run rg foo | wc -l next');
  assert('a single lone pipe is not a table', markdownLines('|')[0]?.kind === 'text');
}

header('markdown — block classification never outranks fences, headings or rules');
{
  const FENCED_BLOCKS = '```sh\n- not a bullet\n> not a quote\n| not | a table |\n```';
  const fenced = markdownLines(FENCED_BLOCKS);
  assert('a bullet inside a fence stays code', fenced[1]?.kind === 'code');
  assert('a quote inside a fence stays code', fenced[2]?.kind === 'code');
  assert('a table row inside a fence stays code', fenced[3]?.kind === 'code');
  assert('the fenced block keeps every character', roundTrip(FENCED_BLOCKS) === FENCED_BLOCKS);
  assert('a carried-open fence keeps a bullet as code', markdownLines('- not a bullet', true)[0]?.kind === 'code');

  assert('--- stays a rule, never a list', markdownLines('---')[0]?.kind === 'rule');
  assert('*** stays a rule, never a list', markdownLines('***')[0]?.kind === 'rule');
  assert('___ stays a rule', markdownLines('___')[0]?.kind === 'rule');
  assert('a longer ----- stays a rule', markdownLines('-----')[0]?.kind === 'rule');
  assert('an indented rule stays a rule', markdownLines('   ---')[0]?.kind === 'rule');
  assert('a rule keeps every character', roundTrip('---\n***\n___') === '---\n***\n___');
  assert('a "- -- -" line is still a list item', markdownLines('- -- -')[0]?.kind === 'list');
  assert('a heading still outranks a quote', markdownLines('# > title')[0]?.kind === 'heading');
}

header('markdown — a structured answer survives the projection byte for byte');
const STRUCTURED_ANSWER = [
  'Findings:',
  '',
  '- first **point**',
  '  - nested point',
  '1. ordered step',
  '2) other step',
  '',
  '> quoted advice with `code`',
  '> > deeper',
  '',
  '| name | value |',
  '|------|-------|',
  '| a    | 1     |',
  '',
  '---',
  '',
  'Not a table: rg foo | wc -l. Not emphasis: two * three.',
].join('\n');
{
  assert('every line of the structured answer round-trips', roundTrip(STRUCTURED_ANSWER) === STRUCTURED_ANSWER);
  assert('and it classified as intended',
    markdownLines(STRUCTURED_ANSWER).map((line) => line.kind).join(',') ===
      'text,text,list,list,list,list,text,quote,quote,text,table,table,table,text,rule,text,text');

  const rendered = renderToString(<MarkdownAnswerText text={STRUCTURED_ANSWER} codeOpen={false} />, { columns: 200 });
  assert('stripping ANSI recovers the structured answer byte for byte', plain(rendered) === STRUCTURED_ANSWER);
  assert('the block markers did add ANSI on the way', rendered !== STRUCTURED_ANSWER);

  const transcript = plain(renderToString(
    <MessageList
      history={[{ kind: 'assistant', id: 'a', text: STRUCTURED_ANSWER, part: 'whole', codeOpen: false }]}
      liveText=""
      liveCodeOpen={false}
      columns={200}
      maxLiveRows={8}
      staticEpoch={0}
    />,
    { columns: 200 },
  ));
  assert('the transcript entry keeps the full structured text', transcript.includes(STRUCTURED_ANSWER));

  // The live region: same text, and exactly the row count liveTextView counted.
  const liveBlock = ['- first item', '  - nested item', '2. second item', '> quoted advice', '| a | b |', '|---|---|'].join('\n');
  const view = liveTextView(liveBlock, 80, 40);
  const rows = plain(renderToString(
    <MessageList history={[]} liveText={liveBlock} liveCodeOpen={false} columns={80} maxLiveRows={40} staticEpoch={0} />,
    { columns: 80 },
  )).replace(/\n+$/, '').split('\n');
  assert('the structured live block draws label + exactly the counted rows', rows.length === 1 + view.rows.length);
  assert('and the live rows are the plain text', rows.slice(1).join('\n') === liveBlock);

  // Blank rows: `liveTextView` counts an empty logical line as one row on purpose (it
  // is a paragraph break), and an empty `<Text>` renders zero rows — so a blank row
  // must be drawn as whitespace or the block draws shorter than its claim and every
  // paragraph break appears only once the answer reaches `<Static>`. Ink trims the
  // trailing space back off, so the drawn rows stay byte-identical to the text.
  for (const blank of ['alpha\n\nbeta', 'alpha\n\n\nbeta', 'a\n\nb\n\nc', '- x\n\n- y', '']) {
    const blankView = liveTextView(blank, 80, 40);
    const blankRows = plain(renderToString(
      <MessageList history={[]} liveText={blank} liveCodeOpen={false} columns={80} maxLiveRows={40} staticEpoch={0} />,
      { columns: 80 },
    )).replace(/\n+$/, '').split('\n');
    const drawn = blank === '' ? [] : blankRows.slice(1);
    assert(`a live block with blank lines draws every counted row (${JSON.stringify(blank)})`,
      drawn.length === blankView.rows.length);
    assert(`and its drawn rows are still exactly the counted text (${JSON.stringify(blank)})`,
      drawn.join('\n') === blankView.rows.map((row) => row.text).join('\n'));
  }

  // A *trailing* blank row cannot be told from the block's bottom margin in a string
  // render, so it is measured differentially: one more counted row must cost exactly
  // one more rendered line.
  const rawLines = (text: string): number =>
    plain(renderToString(
      <MessageList history={[]} liveText={text} liveCodeOpen={false} columns={80} maxLiveRows={40} staticEpoch={0} />,
      { columns: 80 },
    )).split('\n').length;
  assert('a trailing blank row costs exactly the one row it was counted as',
    liveTextView('tail\n', 80, 40).rows.length - liveTextView('tail', 80, 40).rows.length === 1
      && rawLines('tail\n') - rawLines('tail') === 1);

  // A blank row inside a fenced code block is the same trap under a different kind.
  const fencedBlank = '```\nfirst\n\nlast\n```';
  const fencedView = liveTextView(fencedBlank, 80, 40);
  const fencedRows = plain(renderToString(
    <MessageList history={[]} liveText={fencedBlank} liveCodeOpen={false} columns={80} maxLiveRows={40} staticEpoch={0} />,
    { columns: 80 },
  )).replace(/\n+$/, '').split('\n');
  assert('a blank row inside a fence is drawn too', fencedRows.length - 1 === fencedView.rows.length);
  assert('and the fenced live rows are the plain text', fencedRows.slice(1).join('\n') === fencedBlank);

  // A list item too wide for the terminal wraps into rows that are not the logical
  // line: those fall back to whole-row prose tone, and the count still matches.
  const wide = `- ${'word '.repeat(30).trimEnd()}`;
  const wideView = liveTextView(wide, 40, 40);
  const wideRows = plain(renderToString(
    <MessageList history={[]} liveText={wide} liveCodeOpen={false} columns={40} maxLiveRows={40} staticEpoch={0} />,
    { columns: 40 },
  )).replace(/\n+$/, '').split('\n');
  assert('a wrapped list item wrapped into several rows', wideView.rows.length > 1);
  assert('a wrapped list item still draws exactly the counted rows', wideRows.length === 1 + wideView.rows.length);
  assert('and its rows are the wrapped plain text',
    wideRows.slice(1).join('\n') === wideView.rows.map((row) => row.text).join('\n'));
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

  // The same for an answer full of block markers: /export and replay print the
  // list bullets, `>` prefixes and table pipes exactly as committed.
  let structured = initialTurnState;
  for (const char of STRUCTURED_ANSWER) structured = stream(structured, delta(char));
  structured = stream(structured, close(STRUCTURED_ANSWER));

  const printedStructured = formatReplay({
    history: structured.history,
    turns: [1],
    runs: [],
    damage: undefined,
    droppedRecords: 0,
    failures: [],
    turnSpend: [],
    modelCalls: [],
    spend: { turns: 0, models: [], input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as unknown as ReplayResult);

  const expectedStructured =
    `darwin> ${STRUCTURED_ANSWER.split('\n')[0] as string}\n${STRUCTURED_ANSWER.split('\n').slice(1).join('\n')}`;
  assert('replay output of a list/quote/table answer is byte-identical', printedStructured === expectedStructured);
}

report();

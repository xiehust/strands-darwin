/**
 * Conversation history and the in-flight assistant text.
 *
 * Finished entries go through Ink's `<Static>`, which writes them once above the
 * live region and never redraws them. That keeps long transcripts cheap and lets
 * the terminal's own scrollback hold the history.
 *
 * The in-flight text is the one thing here that is redrawn, so it is the one
 * thing that must fit: `maxLiveRows` rows of it are shown, newest last. See
 * `live-text.ts` for why an over-tall live region costs a whole-screen repaint
 * per text delta.
 */
import { Box, Static, Text } from 'ink';
import React from 'react';

import { hiddenRowsNotice, liveTextView } from './live-text.js';
import { markdownLines } from './markdown.js';
import { liveRowText, MarkdownAnswerText } from './MarkdownText.js';
import { ToolCallResult } from './ToolCallPanel.js';
import type { HistoryItem } from './turn-state.js';
import { noticeColor, visualColor, visualMarker } from './visual-language.js';
import { WelcomeHeader, type WelcomeLayout } from './WelcomeHeader.js';

type StaticItem =
  | { readonly type: 'welcome'; readonly key: 'darwin-welcome'; readonly layout: WelcomeLayout }
  | { readonly type: 'history'; readonly key: string; readonly item: HistoryItem };

function staticItems(history: readonly HistoryItem[], welcome: WelcomeLayout | undefined): StaticItem[] {
  const items: StaticItem[] = history.map((item) => ({ type: 'history', key: item.id, item }));
  return welcome === undefined
    ? items
    : [{ type: 'welcome', key: 'darwin-welcome', layout: welcome }, ...items];
}

export function MessageList({
  history,
  welcome,
  liveText,
  liveCodeOpen,
  columns,
  maxLiveRows,
  staticEpoch,
}: {
  readonly history: readonly HistoryItem[];
  /** Presentation-only item that must precede any resumed transcript history. */
  readonly welcome?: WelcomeLayout;
  readonly liveText: string;
  /**
   * Fence state at the start of `liveText` — what the already-committed pieces
   * of the in-flight answer left behind (`fenceOpenAfter(committedAnswer)`), so
   * the live region styles a code block opened in a piece `<Static>` already wrote.
   */
  readonly liveCodeOpen: boolean;
  readonly columns: number;
  /** Rows the live answer may occupy, label and margin included. */
  readonly maxLiveRows: number;
  /**
   * Identity of the current transcript; changed by `/clear`.
   *
   * Remounting `<Static>` is the only supported way to make Ink forget what it has
   * already written (`turn-state.ts`, `staticEpoch`): emptying `items` leaves Ink's
   * `fullStaticOutput` holding the old transcript, ready to be replayed by the next
   * whole-screen redraw.
   */
  readonly staticEpoch: number;
}): React.JSX.Element {
  const live = liveTextView(liveText, columns, maxLiveRows);
  // Markdown line kinds for the live rows; indices match `LiveRow.line` because
  // both sides split the same text on '\n'. Styling only — the row list and its
  // count stay exactly what `liveTextView` said.
  const liveLines = live.rows.length > 0 ? markdownLines(liveText, liveCodeOpen) : [];

  return (
    <Box flexDirection="column">
      <Static key={staticEpoch} items={staticItems(history, welcome)}>
        {(entry) => entry.type === 'welcome'
          ? <WelcomeHeader key={entry.key} layout={entry.layout} />
          : <HistoryEntry key={entry.key} item={entry.item} />}
      </Static>
      {live.rows.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={visualColor.assistant} bold>{visualMarker.assistant}</Text>
          {live.hiddenRows > 0 && <Text dimColor>{hiddenRowsNotice(live.hiddenRows)}</Text>}
          {/* One Text per pre-wrapped row, truncated: the block's height is then
              exactly what `liveTextView` counted, whatever Ink's own word wrap
              would have done with the same string. */}
          {live.rows.map((row, index) => liveRowText(row.text, liveLines[row.line], index))}
        </Box>
      )}
    </Box>
  );
}

function HistoryEntry({ item }: { readonly item: HistoryItem }): React.JSX.Element {
  switch (item.kind) {
    case 'user':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={visualColor.identity} bold>{visualMarker.user}</Text>
          <Text>{item.text}</Text>
        </Box>
      );

    case 'assistant': {
      // An answer arrives in pieces (`turn-state.ts`), and `<Static>` never redraws
      // what it wrote — so the label belongs to the piece that opened the answer and
      // the blank row to the piece that closed it. A closing piece may be empty:
      // that is the blank row on its own, owed to an answer that committed every
      // line it had.
      const labelled = item.part === 'whole' || item.part === 'first';
      const closing = item.part === 'whole' || item.part === 'last';
      return (
        <Box flexDirection="column" marginBottom={closing ? 1 : 0}>
          {labelled && <Text color={visualColor.assistant} bold>{visualMarker.assistant}</Text>}
          {item.text !== '' && <MarkdownAnswerText text={item.text} codeOpen={item.codeOpen} />}
        </Box>
      );
    }

    case 'tool':
      return <ToolCallResult item={item} />;

    case 'notice':
      return (
        <Box marginBottom={1}>
          {item.severity === 'info' ? (
            <Text>
              <Text color={noticeColor(item.severity)}>{visualMarker.notice[item.severity]}</Text> {item.text}
            </Text>
          ) : (
            <Text color={noticeColor(item.severity)}>
              {visualMarker.notice[item.severity]} {item.text}
            </Text>
          )}
        </Box>
      );
  }
}

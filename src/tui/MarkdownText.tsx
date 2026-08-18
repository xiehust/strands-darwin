/**
 * Draws assistant answer text with markdown-aware styling.
 *
 * A pure presentation-time projection over the committed text (`markdown.ts`):
 * every character is kept, markers are dimmed in place, so ANSI-stripped output
 * is exactly the plain text `turn-state.ts` committed. Two consumers:
 *
 * - `MarkdownAnswerText` — a `<Static>` history piece or any whole answer text.
 *   ONE outer `<Text>` whose children are nested styled spans and literal `'\n'`
 *   strings: an empty `<Text>` renders zero rows (measured), so rendering one
 *   `<Text>` per line would swallow the blank lines a paragraph break committed.
 * - `liveRowText` — one pre-wrapped live row. The row stays ONE
 *   `<Text wrap="truncate-end">` so the block's height is exactly what
 *   `liveTextView` counted (`.trellis/spec/frontend/live-frame.md`).
 */
import { Text } from 'ink';
import React from 'react';

import { markdownLines, type MarkdownLine, type MarkdownLineKind, type MarkdownSpanStyle } from './markdown.js';
import { markdownCodeColor } from './visual-language.js';

/** The whole answer piece, styled: label and margins stay with the caller. */
export function MarkdownAnswerText({
  text,
  codeOpen,
}: {
  readonly text: string;
  /** Fence state at the start of this piece (`turn-state.ts` decides it at push time). */
  readonly codeOpen: boolean;
}): React.JSX.Element {
  const children: React.ReactNode[] = [];
  markdownLines(text, codeOpen).forEach((line, index) => {
    if (index > 0) children.push('\n');
    children.push(...spanElements(line, `line-${index}`));
  });
  return <Text>{children}</Text>;
}

/**
 * One pre-wrapped live row. Inline spans are used only when the row is the whole
 * untransformed logical line (span concatenation === row text); a row a wrap or
 * a tab stop transformed falls back to whole-row tone by line kind, so a
 * `**bold**` split across rows stays plain until the line is committed — a
 * styling nuance, never a row-count or fence-state disagreement.
 */
export function liveRowText(rowText: string, line: MarkdownLine | undefined, key: number): React.JSX.Element {
  if (line !== undefined && (line.kind === 'text' || line.kind === 'heading') && lineText(line) === rowText) {
    return (
      <Text key={key} wrap="truncate-end">
        {spanElements(line, `row-${key}`)}
      </Text>
    );
  }
  return (
    <Text key={key} wrap="truncate-end" {...(line === undefined ? {} : rowToneProps(line.kind))}>
      {rowText}
    </Text>
  );
}

/** Nested styled spans for one logical line; empty spans contribute nothing. */
function spanElements(line: MarkdownLine, keyPrefix: string): React.ReactNode[] {
  return line.spans
    .filter((span) => span.text !== '')
    .map((span, index) => (
      <Text key={`${keyPrefix}-${index}`} {...spanProps(line.kind, span.style)}>
        {span.text}
      </Text>
    ));
}

interface SpanProps {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly dimColor?: boolean;
  readonly color?: string;
}

/**
 * The styling vocabulary: headings bold (their `#` marker dim as well), inline
 * and fenced code in the palette's code colour, fence delimiters, rules and
 * inline markers dim, emphasis bold/italic. Colour and weight are enhancement
 * only — the markdown markers on the text remain the durable statement.
 */
function spanProps(kind: MarkdownLineKind, style: MarkdownSpanStyle): SpanProps {
  if (kind === 'code') return { color: markdownCodeColor };
  if (kind === 'fence' || kind === 'rule') return { dimColor: true };
  if (kind === 'heading') return style === 'marker' ? { bold: true, dimColor: true } : { bold: true };
  switch (style) {
    case 'marker':
      return { dimColor: true };
    case 'bold':
      return { bold: true };
    case 'italic':
      return { italic: true };
    case 'code':
      return { color: markdownCodeColor };
    case 'plain':
      return {};
  }
}

/** Whole-row tone for a live row that is not exactly its logical line. */
function rowToneProps(kind: MarkdownLineKind): SpanProps {
  switch (kind) {
    case 'code':
      return { color: markdownCodeColor };
    case 'fence':
    case 'rule':
      return { dimColor: true };
    case 'heading':
      return { bold: true };
    case 'text':
      return {};
  }
}

function lineText(line: MarkdownLine): string {
  let text = '';
  for (const span of line.spans) text += span.text;
  return text;
}

/**
 * Markdown-aware styling of assistant answer text, as a pure projection.
 *
 * The committed answer text is the source of truth and is never altered
 * (`turn-state.ts` commits exact plain lines; the trajectory record, `/export`
 * and replay read that text): this module only says how to *draw* it. Every
 * character of the input survives into the output spans — markers like `**`
 * and ``` are de-emphasized in place, never stripped — so ANSI-stripped output
 * is identical to the plain text, and pty assertions keep matching substrings.
 * That holds for block structure too: a list marker, a blockquote `>` prefix and
 * a table row's `|` separators become dim marker spans exactly where they are,
 * never re-indented, renumbered or column-aligned.
 *
 * Line-oriented and dependency-free on purpose. An answer reaches `<Static>`
 * history in pieces that Ink never redraws, so the one piece of state that
 * must travel between pieces — inside or outside a fenced code block — is a
 * boolean (`fenceOpenAfter`), decided when the piece is pushed. The fence
 * classifier is therefore deliberately a boolean toggle (any ```/~~~ line
 * opens a block; inside one, a bare ```/~~~ line closes it): a classifier
 * that needed the opening fence's character or length would need more state
 * than the boolean the reducer carries.
 *
 * Syntax highlighting of code by language is explicitly out of scope.
 */

/** How one span of a line is drawn; concatenated spans are the line, verbatim. */
export type MarkdownSpanStyle = 'plain' | 'marker' | 'bold' | 'italic' | 'code';

export interface MarkdownSpan {
  readonly text: string;
  readonly style: MarkdownSpanStyle;
}

/**
 * What one logical line *is*: prose (`text`), a heading, a fence delimiter,
 * a line inside a fenced code block, a thematic break (`rule`), a list item, a
 * blockquote line, or a pipe-fenced table row.
 *
 * The block kinds exist so a line's *leading* structure — a bullet or ordered
 * marker, a `>` prefix, a row's `|` separators — becomes a dim `marker` span
 * instead of falling through to prose. It is what gives a `* item` line its
 * marker: `inlineSpans` deliberately refuses to read that `*` as emphasis.
 */
export type MarkdownLineKind = 'text' | 'heading' | 'fence' | 'code' | 'rule' | 'list' | 'quote' | 'table';

export interface MarkdownLine {
  readonly kind: MarkdownLineKind;
  /** Inline spans; empty for an empty line. Joined, they are the line. */
  readonly spans: readonly MarkdownSpan[];
}

/** A ```/~~~ line that opens a block (an info string like ```ts may follow). */
const FENCE_OPEN = /^ {0,3}(?:`{3,}|~{3,})/u;
/** A bare ```/~~~ line that closes the block it is inside. */
const FENCE_CLOSE = /^ {0,3}(?:`{3,}|~{3,})[ \t]*$/u;
/** ATX heading: 1–6 `#` then whitespace (or nothing at all). */
const HEADING = /^(#{1,6})([ \t]+)(.*)$/u;
const HEADING_BARE = /^#{1,6}$/u;
/** Thematic break: ---, *** or ___ (three or more). */
const RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/u;
/** Blockquote: a `>` run after at most three spaces, plus the space after it. */
const QUOTE = /^([ \t]{0,3}>[ \t>]*)(.*)$/u;
/**
 * List item: a `-`/`*`/`+` bullet or an `N.`/`N)` ordered marker, followed by at
 * least one space or tab (so `-fast` and `*emphasis*` are prose, not items).
 * Leading indent is captured with the marker: nesting depth is preserved as the
 * literal whitespace it already is, never re-indented.
 */
const LIST_ITEM = /^([ \t]*)((?:[-*+]|\d{1,9}[.)])[ \t]+)(.*)$/u;
/**
 * A table row, decided conservatively: it must both start (after at most three
 * spaces) and end with `|`. A line merely *containing* a pipe — `cmd | grep x`,
 * `a | b` in prose — stays prose, because dimming those false positives is a
 * worse failure than leaving a pipe-less table row undecorated.
 */
const TABLE_ROW = /^ {0,3}\|.*\|[ \t]*$/u;

/**
 * Classifies every line of `text` and splits prose lines into inline spans.
 * `codeOpen` is the fence state at the start of the text — for a `middle`/`last`
 * answer piece, the state the previous pieces left behind.
 */
export function markdownLines(text: string, codeOpen = false): readonly MarkdownLine[] {
  let open = codeOpen;
  return text.split('\n').map((line): MarkdownLine => {
    if (open) {
      if (FENCE_CLOSE.test(line)) {
        open = false;
        return { kind: 'fence', spans: [{ text: line, style: 'marker' }] };
      }
      return { kind: 'code', spans: line === '' ? [] : [{ text: line, style: 'code' }] };
    }
    if (FENCE_OPEN.test(line)) {
      open = true;
      return { kind: 'fence', spans: [{ text: line, style: 'marker' }] };
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const marker = `${heading[1] as string}${heading[2] as string}`;
      const rest = heading[3] as string;
      return {
        kind: 'heading',
        spans: rest === ''
          ? [{ text: marker, style: 'marker' }]
          : [{ text: marker, style: 'marker' }, { text: rest, style: 'plain' }],
      };
    }
    if (HEADING_BARE.test(line)) {
      return { kind: 'heading', spans: [{ text: line, style: 'marker' }] };
    }
    if (RULE.test(line)) {
      return { kind: 'rule', spans: [{ text: line, style: 'marker' }] };
    }
    const quote = QUOTE.exec(line);
    if (quote !== null) {
      return { kind: 'quote', spans: markedSpans(quote[1] as string, quote[2] as string) };
    }
    const item = LIST_ITEM.exec(line);
    if (item !== null) {
      return {
        kind: 'list',
        spans: markedSpans(`${item[1] as string}${item[2] as string}`, item[3] as string),
      };
    }
    if (TABLE_ROW.test(line)) {
      return { kind: 'table', spans: tableSpans(line) };
    }
    return { kind: 'text', spans: line === '' ? [] : inlineSpans(line) };
  });
}

/** A leading `marker` span plus the inline spans of what follows it. */
function markedSpans(marker: string, rest: string): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [{ text: marker, style: 'marker' }];
  if (rest !== '') spans.push(...inlineSpans(rest));
  return spans;
}

/**
 * A table row: every `|` is its own `marker` span, every cell keeps ordinary
 * inline spans. Column widths are never touched — the row's own spacing is part
 * of the cell text, so the drawn row is exactly as wide as the committed one.
 */
function tableSpans(line: string): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  let cell = '';
  const flush = (): void => {
    if (cell !== '') spans.push(...inlineSpans(cell));
    cell = '';
  };
  for (const char of line) {
    if (char === '|') {
      flush();
      spans.push({ text: '|', style: 'marker' });
      continue;
    }
    cell += char;
  }
  flush();
  return spans;
}

/**
 * The fence state after every line of `text`, starting from `codeOpen`.
 *
 * This is the minimal state carried across answer piece boundaries
 * (`turn-state.ts` stores it on each assistant history item at push time) and
 * into the live region: both sides derive it with this one function, which is
 * what keeps a re-render of the live region from disagreeing with what
 * `<Static>` already wrote.
 */
export function fenceOpenAfter(text: string, codeOpen = false): boolean {
  let open = codeOpen;
  if (text === '') return open;
  for (const line of text.split('\n')) {
    if (open) {
      if (FENCE_CLOSE.test(line)) open = false;
    } else if (FENCE_OPEN.test(line)) {
      open = true;
    }
  }
  return open;
}

/**
 * Inline spans of one prose line: `` `code` ``, `**bold**` and `*italic*`,
 * scanned left to right with inline code taking precedence. Unclosed markers
 * stay plain text; emphasis content may not start or end with whitespace, so
 * `a * b * c` and bullet `* item` lines never turn italic. `_underscore_`
 * emphasis is deliberately not recognized — snake_case identifiers are far
 * more common in answers than underscore emphasis, and mis-styling an
 * identifier costs more than leaving emphasis plain.
 */
function inlineSpans(line: string): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  let plain = '';
  const flush = (): void => {
    if (plain !== '') {
      spans.push({ text: plain, style: 'plain' });
      plain = '';
    }
  };

  let index = 0;
  while (index < line.length) {
    const char = line[index] as string;

    if (char === '`') {
      const run = (/^`+/u.exec(line.slice(index)) as RegExpExecArray)[0];
      const close = findRun(line, index + run.length, run);
      if (close !== -1) {
        flush();
        spans.push({ text: run, style: 'marker' });
        const content = line.slice(index + run.length, close);
        if (content !== '') spans.push({ text: content, style: 'code' });
        spans.push({ text: run, style: 'marker' });
        index = close + run.length;
        continue;
      }
      plain += run;
      index += run.length;
      continue;
    }

    if (char === '*') {
      const marker = line.startsWith('**', index) ? '**' : '*';
      const close = findEmphasisClose(line, index + marker.length, marker);
      if (close !== -1) {
        flush();
        spans.push({ text: marker, style: 'marker' });
        spans.push({ text: line.slice(index + marker.length, close), style: marker === '**' ? 'bold' : 'italic' });
        spans.push({ text: marker, style: 'marker' });
        index = close + marker.length;
        continue;
      }
      plain += char;
      index += 1;
      continue;
    }

    plain += char;
    index += 1;
  }

  flush();
  return spans;
}

/** First occurrence of exactly `run` (not part of a longer backtick run) at or after `from`. */
function findRun(line: string, from: number, run: string): number {
  let at = line.indexOf(run, from);
  while (at !== -1) {
    const before = at > 0 ? line[at - 1] : '';
    const after = line[at + run.length] ?? '';
    if (before !== run[0] && after !== run[0]) return at;
    at = line.indexOf(run, at + 1);
  }
  return -1;
}

/**
 * The closing `marker` for an emphasis span opened just before `from`, or -1.
 * Content must be non-empty and must not start or end with whitespace.
 */
function findEmphasisClose(line: string, from: number, marker: string): number {
  if (from >= line.length || /\s/u.test(line[from] as string)) return -1;
  let at = line.indexOf(marker, from + 1);
  while (at !== -1) {
    if (!/\s/u.test(line[at - 1] as string)) return at;
    at = line.indexOf(marker, at + 1);
  }
  return -1;
}

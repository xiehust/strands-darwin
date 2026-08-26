/**
 * Pure reverse-search state over the bounded project prompt history.
 *
 * Disk access stays in `trajectory/prompt-history.ts`; this module only snapshots
 * that reader's already bounded entries and transforms local keystrokes. The opening
 * editor value is retained byte-for-byte so Escape can restore text, offset and
 * affinity even when terminal input and React renders are batched.
 */
import { promptHistoryNote, type PromptHistory } from '../trajectory/prompt-history.js';
import type { EditorValue } from './prompt-editor.js';

/** A query can never grow without bound, including when a terminal pastes one event. */
export const MAX_PROMPT_SEARCH_QUERY_CODE_POINTS = 256;
/** A fixed presentation cap; shorter terminals may grant fewer through the frame budget. */
export const MAX_PROMPT_SEARCH_MATCHES = 5;

export interface PromptHistorySearch {
  /** Exact editor snapshot restored by cancellation. */
  readonly original: EditorValue;
  /** Reader generation this search may accept; stale asynchronous reads are ignored. */
  readonly requestId: number;
  /** The reader's newest-first, duplicate-collapsed bounded snapshot. */
  readonly entries: readonly string[];
  readonly query: string;
  readonly matches: readonly string[];
  readonly selected: number;
  readonly pending: boolean;
  /** Reader omissions/degradation, kept on the bounded title row. */
  readonly note: string | undefined;
}

export interface PromptHistorySearchView {
  readonly title: string;
  readonly matches: readonly string[];
  /** Selected index within the bounded visible window. */
  readonly selected: number;
  readonly hiddenAbove: number;
  readonly hiddenBelow: number;
}

/** Opens without waiting for disk; `history` is absent while that bounded read lands. */
export function openPromptHistorySearch(
  original: EditorValue,
  requestId: number,
  history: PromptHistory | undefined,
): PromptHistorySearch {
  const base = {
    original: cloneEditor(original),
    requestId,
    query: '',
    selected: 0,
  } as const;
  if (history === undefined) {
    return { ...base, entries: [], matches: [], pending: true, note: undefined };
  }
  return fromHistory(base, history);
}

/** Applies only the read requested by this search instance. */
export function resolvePromptHistorySearch(
  search: PromptHistorySearch,
  requestId: number,
  history: PromptHistory,
): PromptHistorySearch {
  if (!search.pending || search.requestId !== requestId) return search;
  return fromHistory(search, history);
}

/** Appends printable query text with a Unicode code-point bound. */
export function appendPromptHistorySearchQuery(
  search: PromptHistorySearch,
  inserted: string,
): PromptHistorySearch {
  const room = MAX_PROMPT_SEARCH_QUERY_CODE_POINTS - [...search.query].length;
  if (room <= 0 || inserted === '') return search;
  return withQuery(search, search.query + [...inserted].slice(0, room).join(''));
}

/** Removes one Unicode code point, never half of a surrogate pair. */
export function backspacePromptHistorySearchQuery(search: PromptHistorySearch): PromptHistorySearch {
  const points = [...search.query];
  if (points.length === 0) return search;
  points.pop();
  return withQuery(search, points.join(''));
}

export function clearPromptHistorySearchQuery(search: PromptHistorySearch): PromptHistorySearch {
  return search.query === '' ? search : withQuery(search, '');
}

/** Navigation wraps through the bounded reader snapshot; positive means older. */
export function movePromptHistorySearchSelection(
  search: PromptHistorySearch,
  delta: number,
): PromptHistorySearch {
  if (search.matches.length === 0) return search;
  const selected = normalizeSelection(search.selected + delta, search.matches.length);
  return selected === search.selected ? search : { ...search, selected };
}

/** Selected match as an editor value, or nothing while loading/empty/no-match. */
export function acceptPromptHistorySearch(search: PromptHistorySearch): EditorValue | undefined {
  const text = search.matches[search.selected];
  return text === undefined
    ? undefined
    : { text, cursor: { offset: text.length, affinity: 'upstream' } };
}

/** Exact pre-search draft and cursor. */
export function cancelPromptHistorySearch(search: PromptHistorySearch): EditorValue {
  return cloneEditor(search.original);
}

/** Bounded, one-row-safe strings for the counted prompt projection. */
export function promptHistorySearchView(search: PromptHistorySearch): PromptHistorySearchView {
  const query = search.query === '' ? '(all)' : search.query;
  let state: string;
  if (search.pending) state = 'reading this project’s record…';
  else if (search.matches.length === 0) state = search.entries.length === 0 ? 'no earlier prompts' : 'no matches';
  else state = `${search.selected + 1}/${search.matches.length} · Ctrl+R/↑ older ↓ newer · Enter/Tab accept · Esc cancel`;
  const note = search.note === undefined ? '' : ` — ${search.note}`;
  const capacity = Math.min(search.matches.length, MAX_PROMPT_SEARCH_MATCHES);
  const start = Math.max(
    0,
    Math.min(search.selected - Math.floor(capacity / 2), search.matches.length - capacity),
  );
  const end = start + capacity;
  return {
    title: `reverse search: ${query} · ${state}${note}`,
    matches: search.matches.slice(start, end),
    selected: search.selected - start,
    hiddenAbove: start,
    hiddenBelow: search.matches.length - end,
  };
}

function fromHistory(
  base: Pick<PromptHistorySearch, 'original' | 'requestId' | 'query' | 'selected'>,
  history: PromptHistory,
): PromptHistorySearch {
  const entries = [...history.entries];
  const query = base.query;
  const matches = filterEntries(entries, query);
  return {
    ...base,
    entries,
    query,
    matches,
    selected: normalizeSelection(base.selected, matches.length),
    pending: false,
    note: promptHistoryNote(history),
  };
}

function withQuery(search: PromptHistorySearch, query: string): PromptHistorySearch {
  const matches = filterEntries(search.entries, query);
  return { ...search, query, matches, selected: 0 };
}

function filterEntries(entries: readonly string[], query: string): string[] {
  if (query === '') return [...entries];
  const folded = query.toLocaleLowerCase();
  return entries.filter((entry) => entry.toLocaleLowerCase().includes(folded));
}

function normalizeSelection(selected: number, total: number): number {
  if (total <= 0) return 0;
  return (selected % total + total) % total;
}

function cloneEditor(value: EditorValue): EditorValue {
  return { text: value.text, cursor: { ...value.cursor } };
}

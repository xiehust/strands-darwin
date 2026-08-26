/** Pure bounded chooser state for conversation-only `/rewind`. */
import type { RewindCheckpoint } from '../agent/rewind.js';
import type { EditorValue } from './prompt-editor.js';

export const MAX_REWIND_SEARCH_MATCHES = 5;
export const MAX_REWIND_SEARCH_QUERY_CODE_POINTS = 256;

export interface RewindSearch {
  readonly original: EditorValue;
  readonly sourceSessionId: string;
  readonly checkpoints: readonly RewindCheckpoint[];
  readonly query: string;
  readonly matches: readonly RewindCheckpoint[];
  readonly selected: number;
}

export interface RewindSearchView {
  readonly title: string;
  readonly matches: readonly string[];
  readonly selected: number;
  readonly hiddenAbove: number;
  readonly hiddenBelow: number;
}

export function openRewindSearch(
  original: EditorValue,
  sourceSessionId: string,
  checkpoints: readonly RewindCheckpoint[],
): RewindSearch {
  return {
    original: { ...original, cursor: { ...original.cursor } },
    sourceSessionId,
    checkpoints: [...checkpoints],
    query: '',
    matches: [...checkpoints],
    selected: 0,
  };
}

export function appendRewindSearchQuery(search: RewindSearch, inserted: string): RewindSearch {
  const room = MAX_REWIND_SEARCH_QUERY_CODE_POINTS - [...search.query].length;
  if (room <= 0 || inserted === '') return search;
  return withQuery(search, search.query + [...inserted].slice(0, room).join(''));
}

export function backspaceRewindSearchQuery(search: RewindSearch): RewindSearch {
  const points = [...search.query];
  if (points.length === 0) return search;
  points.pop();
  return withQuery(search, points.join(''));
}

export function clearRewindSearchQuery(search: RewindSearch): RewindSearch {
  return search.query === '' ? search : withQuery(search, '');
}

export function moveRewindSearchSelection(search: RewindSearch, delta: number): RewindSearch {
  if (search.matches.length === 0) return search;
  const selected = ((search.selected + delta) % search.matches.length + search.matches.length) % search.matches.length;
  return selected === search.selected ? search : { ...search, selected };
}

export function acceptRewindSearch(search: RewindSearch): RewindCheckpoint | undefined {
  return search.matches[search.selected];
}

export function cancelRewindSearch(search: RewindSearch): EditorValue {
  return { ...search.original, cursor: { ...search.original.cursor } };
}

export function rewindSearchView(search: RewindSearch): RewindSearchView {
  const capacity = Math.min(search.matches.length, MAX_REWIND_SEARCH_MATCHES);
  const start = capacity === 0
    ? 0
    : Math.min(Math.max(0, search.selected - capacity + 1), search.matches.length - capacity);
  const end = start + capacity;
  return {
    title: search.matches.length === 0
      ? `rewind prompts — no match for ${JSON.stringify(search.query)}`
      : `rewind prompts (${search.selected + 1}/${search.matches.length}) — type to filter · ↑/↓ · enter branch · esc cancel`,
    matches: search.matches.slice(start, end).map((checkpoint) => checkpoint.prompt.replace(/\n/g, ' ⏎ ')),
    selected: Math.max(0, search.selected - start),
    hiddenAbove: start,
    hiddenBelow: search.matches.length - end,
  };
}

function withQuery(search: RewindSearch, query: string): RewindSearch {
  const folded = query.toLocaleLowerCase();
  const matches = search.checkpoints.filter((checkpoint) => checkpoint.prompt.toLocaleLowerCase().includes(folded));
  return { ...search, query, matches, selected: 0 };
}

/**
 * Pure bounded reverse-search behavior; no terminal, model or network. One case
 * (SER-069) seeds a real record under a private HOME and reads it back, because
 * "a background-task wake is never offered" is a property of the reader plus the
 * search, not of the search alone.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { trajectoryPath } from '../src/agent/session.js';
import { readPromptHistory, type PromptHistory } from '../src/trajectory/prompt-history.js';
import {
  MAX_PROMPT_SEARCH_QUERY_CODE_POINTS,
  acceptPromptHistorySearch,
  appendPromptHistorySearchQuery,
  backspacePromptHistorySearchQuery,
  cancelPromptHistorySearch,
  clearPromptHistorySearchQuery,
  movePromptHistorySearchSelection,
  openPromptHistorySearch,
  promptHistorySearchView,
  resolvePromptHistorySearch,
} from '../src/tui/prompt-history-search.js';
import type { EditorValue } from '../src/tui/prompt-editor.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const draft: EditorValue = {
  text: 'draft 🧬 text',
  cursor: { offset: 6, affinity: 'downstream' },
};

function history(entries: readonly string[], overrides: Partial<PromptHistory> = {}): PromptHistory {
  const base: PromptHistory = {
    entries,
    available: entries.length,
    entriesBounded: false,
    sessionsRead: entries.length === 0 ? 0 : 1,
    sessionsSkipped: 0,
    tailBounded: 0,
    longSkipped: 0,
    problem: undefined,
  };
  return { ...base, ...overrides };
}

header('prompt history search — open, filter, navigate, accept and cancel');

const newestFirst = history([
  'Newest FIX login',
  'middle documentation',
  'older fix tests',
]);
let search = openPromptHistorySearch(draft, 7, newestFirst);
assert('open snapshots newest-first reader order', search.matches.join('|') === newestFirst.entries.join('|'));
search = appendPromptHistorySearchQuery(search, 'Fi');
search = appendPromptHistorySearchQuery(search, 'X');
assert('incremental filtering is case-insensitive and retains reader order',
  search.matches.join('|') === 'Newest FIX login|older fix tests');
search = movePromptHistorySearchSelection(search, 1);
assert('older navigation selects the next match', acceptPromptHistorySearch(search)?.text === 'older fix tests');
search = movePromptHistorySearchSelection(search, 1);
assert('navigation wraps without escaping the bounded match list', acceptPromptHistorySearch(search)?.text === 'Newest FIX login');
search = movePromptHistorySearchSelection(search, -1);
const accepted = acceptPromptHistorySearch(search);
assert('accept places the selected match at an upstream end cursor',
  accepted?.text === 'older fix tests' && accepted.cursor.offset === accepted.text.length && accepted.cursor.affinity === 'upstream');
const restored = cancelPromptHistorySearch(search);
assert('cancel restores exact opening draft text, offset and affinity',
  restored.text === draft.text && restored.cursor.offset === draft.cursor.offset && restored.cursor.affinity === draft.cursor.affinity);
assert('the opening snapshot is not aliased to the caller cursor object', restored.cursor !== draft.cursor);

header('prompt history search — loading, stale reads and degraded answers');

let pending = openPromptHistorySearch(draft, 11, undefined);
assert('opening without a read states loading and offers no match',
  pending.pending && acceptPromptHistorySearch(pending) === undefined && promptHistorySearchView(pending).title.includes('reading'));
const stale = resolvePromptHistorySearch(pending, 10, newestFirst);
assert('a stale read generation is ignored by identity', stale === pending && stale.pending);
pending = appendPromptHistorySearchQuery(pending, 'doc');
pending = resolvePromptHistorySearch(pending, 11, newestFirst);
assert('the matching read filters with query keys typed while it was pending',
  !pending.pending && pending.matches.join('|') === 'middle documentation');
const again = resolvePromptHistorySearch(pending, 11, history(['late stale replacement']));
assert('a second landing cannot replace an already resolved snapshot', again === pending);

const empty = openPromptHistorySearch(draft, 1, history([]));
assert('empty history is an explicit usable state', promptHistorySearchView(empty).title.includes('no earlier prompts'));
const damaged = openPromptHistorySearch(draft, 1, history([], { problem: 'damaged tail' }));
assert('reader damage remains visible without making search throw',
  promptHistorySearchView(damaged).title.includes('damaged tail'));
const bounded = openPromptHistorySearch(draft, 1, history(['kept'], {
  available: 9,
  entriesBounded: true,
  sessionsSkipped: 2,
  tailBounded: 1,
  longSkipped: 3,
}));
const boundedTitle = promptHistorySearchView(bounded).title;
assert('reader entry/session/byte/long-prompt omissions stay stated',
  boundedTitle.includes('not read') && boundedTitle.includes('read from the end only') && boundedTitle.includes('long prompt'));
const noMatch = appendPromptHistorySearchQuery(openPromptHistorySearch(draft, 1, newestFirst), 'absent');
assert('a nonempty history with no filter result says no matches', promptHistorySearchView(noMatch).title.includes('no matches'));

header('prompt history search — Unicode and batched-key bounds');

let unicode = openPromptHistorySearch(draft, 2, history(['alpha 🧬 beta', 'other']));
unicode = appendPromptHistorySearchQuery(unicode, '🧬');
assert('Unicode query filtering keeps complete code points', unicode.matches.join('|') === 'alpha 🧬 beta');
unicode = backspacePromptHistorySearchQuery(unicode);
assert('backspace removes one complete Unicode code point', unicode.query === '' && unicode.matches.length === 2);
unicode = appendPromptHistorySearchQuery(unicode, '🧬'.repeat(MAX_PROMPT_SEARCH_QUERY_CODE_POINTS + 20));
assert('one batched input event is capped in code points without splitting Unicode',
  [...unicode.query].length === MAX_PROMPT_SEARCH_QUERY_CODE_POINTS &&
    unicode.query === '🧬'.repeat(MAX_PROMPT_SEARCH_QUERY_CODE_POINTS));
unicode = clearPromptHistorySearchQuery(unicode);
assert('query clear reopens the complete bounded snapshot and resets selection',
  unicode.query === '' && unicode.matches.length === 2 && unicode.selected === 0);

header('prompt history search — a background-task wake is never offered (SER-069)');

{
  // The one seeded read in this suite: `Ctrl+R` searches exactly what the reader
  // returns, so the proof that a wake never surfaces has to start from a real record
  // holding a `taskNotification` line beside typed prompts, under a private HOME.
  const OWNED_HOME = ownPrivateHome('prompt-history-search');
  const root = path.join(OWNED_HOME, 'project');
  const file = trajectoryPath(root, 'session-20260103-000001');
  await mkdir(path.dirname(file), { recursive: true });
  const wakeText = '<task-notification task="bg-1a2b3c4d-0000-4000-8000-000000000000" state="failed" exitCode="1">\nwake body\n</task-notification>';
  await writeFile(file, [
    { v: 1, seq: 1, t: '2026-01-03T00:00:01.000Z', turn: 1, type: 'userInput', text: 'start the notification job' },
    {
      v: 1, seq: 2, t: '2026-01-03T00:00:02.000Z', turn: 2, type: 'taskNotification',
      taskId: 'bg-1a2b3c4d-0000-4000-8000-000000000000', command: 'sleep 1; echo wake body',
      state: 'failed', exitCode: 1, signal: null, text: wakeText,
    },
    { v: 1, seq: 3, t: '2026-01-03T00:00:03.000Z', turn: 3, type: 'userInput', text: 'why did the job fail' },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');

  const reading = await readPromptHistory(root);
  let wakeSearch = openPromptHistorySearch(draft, 10, reading);
  assert('the search opens over the two typed prompts only', wakeSearch.matches.length === 2);
  wakeSearch = appendPromptHistorySearchQuery(wakeSearch, 'notification');
  assert('a query that would match the wake text finds only the typed prompt containing the word',
    wakeSearch.matches.join('|') === 'start the notification job');
  wakeSearch = clearPromptHistorySearchQuery(wakeSearch);
  wakeSearch = appendPromptHistorySearchQuery(wakeSearch, 'wake body');
  assert('the wake body matches nothing — it was never a prompt', wakeSearch.matches.length === 0);
  assert('and accepting an empty match list offers nothing', acceptPromptHistorySearch(wakeSearch) === undefined);
  await rm(OWNED_HOME, { recursive: true, force: true });
}

report();

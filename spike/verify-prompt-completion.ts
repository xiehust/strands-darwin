import { strict as nodeAssert } from 'node:assert';

import {
  computeCompletions,
  promptCompletionState,
  visiblePromptCompletions,
} from '../src/tui/prompt-completion.js';
import { type EditorValue } from '../src/tui/prompt-editor.js';
import { NO_WORKSPACE_PATHS } from '../src/tui/path-completion.js';
import { assert, header, report } from './shared.js';

const commands = ['help', 'status', 'tasks'];
const workspace = {
  ...NO_WORKSPACE_PATHS,
  paths: ['src/', 'src/tui/', 'src/tui/App.tsx', 'README.md'],
};
const editor = (text: string, offset = text.length): EditorValue => ({
  text,
  cursor: { offset, affinity: 'upstream' },
});

header('prompt completion — command candidates remain canonical');
nodeAssert.deepEqual(computeCompletions('/', commands), commands);
nodeAssert.deepEqual(computeCompletions('/st', commands), ['status']);
nodeAssert.deepEqual(computeCompletions('/status ', commands), []);
assert('non-command input has no command candidates', computeCompletions('status', commands).length === 0);

header('prompt completion — Escape suppression follows one query generation');
{
  const open = promptCompletionState(editor('/'), commands, workspace);
  assert('a slash query has a stable command identity and candidates',
    open.kind === 'command' && open.identity !== undefined && open.candidates.length === 3);
  assert('dismissing that identity hides only its rows',
    visiblePromptCompletions(open, open.identity).length === 0);
  assert('a second dismissal remains inert for the same query',
    visiblePromptCompletions(open, open.identity).length === 0);

  const moved = promptCompletionState(editor('/', 0), commands, workspace);
  assert('moving the slash cursor changes its query generation and reopens completion',
    moved.identity !== open.identity && visiblePromptCompletions(moved, open.identity).length === 3);

  const edited = promptCompletionState(editor('/s'), commands, workspace);
  assert('editing the slash query changes its identity and reopens completion',
    edited.identity !== open.identity && visiblePromptCompletions(edited, open.identity).length === 1);
  const fresh = promptCompletionState(editor('/'), commands, workspace);
  assert('a newly entered slash query is visible after dismissal state is cleared',
    visiblePromptCompletions(fresh, undefined).length === 3);
}

header('prompt completion — path identity includes the cursor query');
{
  const open = promptCompletionState(editor('inspect @src/t'), commands, workspace);
  assert('an @ query offers path rows with a path identity',
    open.kind === 'path' && open.identity !== undefined && open.candidates.length === 2);
  assert('dismissing a path query hides its rows without changing editor input',
    visiblePromptCompletions(open, open.identity).length === 0);

  const edited = promptCompletionState(editor('inspect @src/tui'), commands, workspace);
  assert('editing the path query re-arms it under a different identity',
    edited.identity !== open.identity && visiblePromptCompletions(edited, open.identity).length === 2);

  const moved = promptCompletionState(editor('inspect @src/t', 'inspect @src'.length), commands, workspace);
  assert('moving the cursor changes the active query generation', moved.identity !== open.identity);
}

report();

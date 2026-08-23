import {
  matchWorkspacePaths,
  pathCompletionQuery,
  type PathQuery,
  type WorkspacePaths,
} from './path-completion.js';
import type { EditorValue } from './prompt-editor.js';
import type { CompletionKind } from './InputBox.js';

/** Command names matching a `/prefix`, or none when the input is not a bare command. */
export function computeCompletions(input: string, commandNames: readonly string[]): string[] {
  if (!input.startsWith('/')) return [];
  // Once there is a space the command is complete and arguments are being typed.
  if (input.includes(' ')) return [];

  const prefix = input.slice(1).toLowerCase();
  return commandNames.filter((name) => name.toLowerCase().startsWith(prefix));
}

export interface PromptCompletionState {
  readonly kind: CompletionKind;
  readonly candidates: readonly string[];
  readonly pathQuery: PathQuery | undefined;
  /** Stable identity of the menu this query currently offers; absent when no rows exist. */
  readonly identity: string | undefined;
}

/**
 * Pure completion state for one immediate editor generation.
 *
 * Identity follows the query rather than the rendered frame. `App` can therefore
 * suppress exactly the menu dismissed by Escape while an edit clears that dismissal
 * synchronously, including when several stdin events arrive before React renders.
 */
export function promptCompletionState(
  editor: EditorValue,
  commandNames: readonly string[],
  workspacePaths: WorkspacePaths,
): PromptCompletionState {
  const commands = computeCompletions(editor.text, commandNames);
  if (commands.length > 0) {
    return {
      kind: 'command',
      candidates: commands,
      pathQuery: undefined,
      identity: `command:${editor.cursor.offset}:${JSON.stringify(editor.text)}`,
    };
  }

  const query = pathCompletionQuery(editor.text, editor.cursor.offset);
  const paths = query === undefined ? [] : matchWorkspacePaths(workspacePaths.paths, query.text);
  return {
    kind: 'path',
    candidates: paths,
    pathQuery: query,
    identity:
      paths.length === 0 || query === undefined
        ? undefined
        : `path:${query.start}:${query.end}:${JSON.stringify(query.text)}`,
  };
}

/** The candidates still visible after an optional Escape dismissal. */
export function visiblePromptCompletions(
  completion: PromptCompletionState,
  dismissedIdentity: string | undefined,
): readonly string[] {
  return completion.identity !== undefined && completion.identity === dismissedIdentity
    ? []
    : completion.candidates;
}

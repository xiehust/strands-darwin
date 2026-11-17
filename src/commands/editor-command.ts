/** Recognition only: editor authority belongs to an explicit human TUI Enter. */
export const EDITOR_USAGE = '/editor takes no arguments — opens a blank prompt in your external editor';
export const EDITOR_UNSUPPORTED = '/editor is TUI-only and requires an explicit local human request; no editor opened';

export function parseEditorCommand(input: string): 'editor' | 'usage' | undefined {
  const text = input.trim();
  if (!/^\/editor(?:\s|$)/u.test(text)) return undefined;
  return text === '/editor' ? 'editor' : 'usage';
}

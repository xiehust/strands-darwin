/** Recognition only: editor authority belongs to an explicit human TUI Enter. */
export const REPLY_USAGE = '/reply takes no arguments — quotes the last completed answer in your external editor';
export const REPLY_UNSUPPORTED = '/reply is TUI-only and requires an explicit local human request; no editor opened';

export function parseReplyCommand(input: string): 'reply' | 'usage' | undefined {
  const text = input.trim();
  if (!/^\/reply(?:\s|$)/u.test(text)) return undefined;
  return text === '/reply' ? 'reply' : 'usage';
}

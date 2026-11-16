import { latestCompletedAnswer } from './copy-command.js';
import { EXTERNAL_EDITOR_MAX_BYTES, EXTERNAL_EDITOR_MAX_CODE_POINTS } from './external-editor.js';
import type { HistoryItem } from './turn-state.js';

export const NOTHING_TO_REPLY_NOTICE = 'nothing to reply to — no completed answer in this session yet';
export const REPLY_CAP_NOTICE = '/reply quoted answer exceeds 65,536 code points / 256 KiB UTF-8 — nothing written; draft unchanged';

/** Completed transcript only, including restored history. Refuse before expanding. */
export function replyEditorSeed(history: readonly HistoryItem[]):
  { readonly text: string } | { readonly notice: string } {
  const answer = latestCompletedAnswer(history);
  if (answer === undefined) return { notice: NOTHING_TO_REPLY_NOTICE };
  let points = 4; // first `> ` and the blank reply area (`\n\n`)
  let lines = 1;
  for (const point of answer) {
    points += point === '\n' ? 3 : 1;
    if (point === '\n') lines += 1;
    if (points > EXTERNAL_EDITOR_MAX_CODE_POINTS) return { notice: REPLY_CAP_NOTICE };
  }
  if (Buffer.byteLength(answer, 'utf8') + 2 * lines + 2 > EXTERNAL_EDITOR_MAX_BYTES) {
    return { notice: REPLY_CAP_NOTICE };
  }
  return { text: `> ${answer.replaceAll('\n', '\n> ')}\n\n` };
}

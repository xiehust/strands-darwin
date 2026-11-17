/** SER-132 R1/R3/R5/R7: bounded transcript projection and canonical reservation.
 * Real-process/security receipts: verify-external-editor.ts P1-P13 + SER-132.
 * Human/driver/PTY receipts: verify-reply-command-pty.ts; aliases: verify-external-editor-pty.ts.
 * No mock layer, model or network. Run: pnpm tsx spike/verify-reply-command.ts
 */
import { strict as check } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseReplyCommand } from '../src/commands/reply-command.js';
import { BUILTIN_COMMAND_NAMES, loadCustomCommands } from '../src/commands/custom-commands.js';
import { replyEditorSeed, NOTHING_TO_REPLY_NOTICE, REPLY_CAP_NOTICE } from '../src/tui/reply-command.js';
import { withinEditorCaps, EXTERNAL_EDITOR_MAX_CODE_POINTS } from '../src/tui/external-editor.js';
import { formatHelpReport } from '../src/tui/help-format.js';
import { MAX_COMPLETIONS } from '../src/tui/InputBox.js';
import type { HistoryItem } from '../src/tui/turn-state.js';

const assistant = (text: string, part: 'whole' | 'first' | 'middle' | 'last'): HistoryItem =>
  ({ kind: 'assistant', id: `${part}-${text}`, text, part, codeOpen: false });
check.equal(parseReplyCommand(' /reply \n'), 'reply');
for (const input of ['/reply x', '/reply\narg', '/reply\targ']) check.equal(parseReplyCommand(input), 'usage');
for (const input of ['/replying', 'please /reply', '> /reply']) check.equal(parseReplyCommand(input), undefined);
check.deepEqual(replyEditorSeed([]), { notice: NOTHING_TO_REPLY_NOTICE });
check.deepEqual(replyEditorSeed([assistant('partial', 'first')]), { notice: NOTHING_TO_REPLY_NOTICE });
const completed: HistoryItem[] = [
  assistant('old', 'whole'), assistant('第一问 🧪', 'first'),
  { kind: 'notice', id: 'notice', text: 'not answer context', severity: 'info' },
  assistant('\ne\u0301 русский\n\tcode > #', 'middle'), assistant('', 'last'),
  assistant('unclosed streaming fragment', 'first'), assistant('still streaming', 'middle'),
];
check.deepEqual(replyEditorSeed(completed), { text: '> 第一问 🧪\n> \n> e\u0301 русский\n> \tcode > #\n\n' });
check.deepEqual(replyEditorSeed([...completed, assistant('newest', 'whole')]), { text: '> newest\n\n' });
check.deepEqual(replyEditorSeed([assistant('', 'whole')]), { text: '> \n\n' });
// Caps apply to expanded quotes, not just the answer; exact boundary accepted.
const atCap = replyEditorSeed([assistant('a'.repeat(EXTERNAL_EDITOR_MAX_CODE_POINTS - 4), 'whole')]);
check.ok('text' in atCap && withinEditorCaps(atCap.text));
if ('text' in atCap) check.equal([...atCap.text].length, EXTERNAL_EDITOR_MAX_CODE_POINTS);
for (const answer of ['a'.repeat(EXTERNAL_EDITOR_MAX_CODE_POINTS - 3), '\n'.repeat(21_845), '🧪'.repeat(EXTERNAL_EDITOR_MAX_CODE_POINTS)]) {
  check.deepEqual(replyEditorSeed([assistant(answer, 'whole')]), { notice: REPLY_CAP_NOTICE });
}
const unicodeCap = replyEditorSeed([assistant('🧪'.repeat(EXTERNAL_EDITOR_MAX_CODE_POINTS - 4), 'whole')]);
check.ok('text' in unicodeCap && withinEditorCaps(unicodeCap.text));
const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-reply-reservation-'));
try {
  const commands = path.join(root, '.darwin/commands');
  await mkdir(commands, { recursive: true });
  await writeFile(path.join(commands, 'reply.md'), 'must not become an editor command');
  const loaded = await loadCustomCommands(root, []);
  check.ok(!loaded.commands.some(command => command.name === 'reply'));
  check.ok(loaded.problems.some(problem => problem.reason.includes('built-in command /reply')));
  check.ok(MAX_COMPLETIONS >= BUILTIN_COMMAND_NAMES.length);
  const help = formatHelpReport();
  for (const name of BUILTIN_COMMAND_NAMES) check.ok(help.includes(`  /${name} — `), name);
  check.equal(BUILTIN_COMMAND_NAMES.length, 34);
} finally { await rm(root, { recursive: true, force: true }); }
console.log('SER-132 reply projection, bounds and reservation passed');

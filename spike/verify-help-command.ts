/**
 * SER-030 — bounded local `/help` projection. Pure and offline: no runtime, I/O,
 * model, tool, network, configuration, or session object is available here.
 *
 * Run: pnpm tsx spike/verify-help-command.ts
 */
import {
  BUILTIN_COMMAND_DESCRIPTIONS,
  BUILTIN_COMMAND_NAMES,
} from '../src/commands/custom-commands.js';
import {
  HELP_FIXED_LINES,
  MAX_HELP_COMMANDS,
  MAX_HELP_LINE_CODE_POINTS,
  MAX_HELP_LINES,
  formatHelpReport,
} from '../src/tui/help-format.js';
import { assert, header, report } from './shared.js';

header('/help — canonical command projection');
const text = formatHelpReport();
const lines = text.split('\n');
const commandHeader = lines.indexOf(`commands (${BUILTIN_COMMAND_NAMES.length}/${BUILTIN_COMMAND_NAMES.length}):`);
const promptHeader = lines.indexOf('prompt and completion:');
const commandLines = lines.slice(commandHeader + 1, promptHeader);
const expectedCommandLines = BUILTIN_COMMAND_NAMES.map(
  (name) => `  /${name} — ${BUILTIN_COMMAND_DESCRIPTIONS[name]}`,
);

assert('the report contains one canonical command section',
  commandHeader >= 0 && lines.filter((line) => line.startsWith('commands (')).length === 1);
assert('command rows are exactly the canonical ordered name/description inventory',
  commandLines.join('\n') === expectedCommandLines.join('\n'));
assert('every canonical command appears exactly once',
  expectedCommandLines.every((line) => commandLines.filter((candidate) => candidate === line).length === 1));
assert('no duplicated or invented command row appears',
  commandLines.length === new Set(commandLines).size && commandLines.length === BUILTIN_COMMAND_NAMES.length);

header('/help — prompt syntax and keyboard facts');
const facts = [
  '/ opens commands and skills',
  'Up/Down select · Tab/Enter completes the selected row',
  '@ completes a workspace path',
  'inserts path text only, never file content',
  '!<command> runs your shell command locally',
  'Ctrl+J or trailing \\ + Enter inserts a newline',
  'multiline paste never submits',
  'Ctrl+O attaches one clipboard image to the next prompt',
  'Ctrl+O again removes it',

  'Ctrl+R searches this project’s prompt history',
  'Ctrl+R/Up/Down navigate · Tab/Enter accepts',
  'completion · Up queued-message take-back · prompt recall · cursor movement',
  'Esc closes completion, cancels history search to its exact draft/cursor, or ends prompt recall',
  'Home/End or Ctrl+A/E',
  'Ctrl+K/U deletes to the row end/start',
  'Ctrl+W deletes the previous word',
  'Alt/Ctrl+Left/Right or Alt+B/F moves by word',
  'Alt+Backspace/Alt+D deletes the word before/after',
  'Ctrl+_ (or Ctrl+-) undoes the last Ctrl+K/U, Ctrl+W or Alt word deletion in the draft',
  'Ctrl+B toggles compact/expanded tool details',
  'Ctrl+C cancels busy work',
  'press again within 2s to exit',
  'Ctrl+D or /exit or /quit exits',
];
for (const fact of facts) assert(`states: ${fact}`, text.includes(fact));

header('/help — explicit hard bounds');
const fixedLines = lines.length - commandLines.length;
assert('the command cap covers the canonical built-ins', MAX_HELP_COMMANDS >= BUILTIN_COMMAND_NAMES.length);
assert('the output stays within the declared line cap', lines.length <= MAX_HELP_LINES);
assert('the declared fixed-line count matches the rows actually emitted around the inventory',
  HELP_FIXED_LINES === fixedLines + 1);
assert('a command inventory filling the command cap plus the overflow notice still cannot truncate a fixed line',
  MAX_HELP_LINES >= MAX_HELP_COMMANDS + fixedLines + 1);
assert('the last fixed row survives the line cap', lines[lines.length - 1] === '  Ctrl+D or /exit or /quit exits');
assert('every output row stays within the declared code-point cap',
  lines.every((line) => [...line].length <= MAX_HELP_LINE_CODE_POINTS));
assert('all declared bounds are finite positive integers',
  [MAX_HELP_COMMANDS, MAX_HELP_LINES, MAX_HELP_LINE_CODE_POINTS, HELP_FIXED_LINES].every(
    (bound) => Number.isInteger(bound) && bound > 0,
  ));

report();

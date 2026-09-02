import {
  BUILTIN_COMMAND_DESCRIPTIONS,
  BUILTIN_COMMAND_NAMES,
} from '../commands/custom-commands.js';

/** Hard report bounds: help is transcript history, never an unbounded catalogue dump. */
export const MAX_HELP_COMMANDS = 24;
/**
 * Fixed rows `formatHelpReport()` always emits: the title, the command-section header,
 * the "prompt and completion" block and the "editing and session" block, plus the
 * one-line overflow notice a filled command cap would add.
 */
export const HELP_FIXED_LINES = 22;
/**
 * The line cap must cover the worst case — a command inventory that fills
 * `MAX_HELP_COMMANDS` *and* every fixed row — so `slice()` can never silently drop a
 * documented control. Derived, never a hand-picked number with incidental headroom.
 */
export const MAX_HELP_LINES = MAX_HELP_COMMANDS + HELP_FIXED_LINES;
export const MAX_HELP_LINE_CODE_POINTS = 160;

function boundedLine(value: string): string {
  const points = [...value];
  if (points.length <= MAX_HELP_LINE_CODE_POINTS) return value;
  return `${points.slice(0, MAX_HELP_LINE_CODE_POINTS - 1).join('')}…`;
}

/** A pure local projection of the canonical command inventory and fixed input controls. */
export function formatHelpReport(): string {
  const commandNames = BUILTIN_COMMAND_NAMES.slice(0, MAX_HELP_COMMANDS);
  const lines = [
    'help — local controls',
    `commands (${commandNames.length}/${BUILTIN_COMMAND_NAMES.length}):`,
    ...commandNames.map((name) => `  /${name} — ${BUILTIN_COMMAND_DESCRIPTIONS[name]}`),
  ];

  if (commandNames.length < BUILTIN_COMMAND_NAMES.length) {
    lines.push(`  … ${BUILTIN_COMMAND_NAMES.length - commandNames.length} more commands not shown`);
  }

  lines.push(
    'prompt and completion:',
    '  / opens commands and skills · Up/Down select · Tab/Enter completes the selected row',
    '  @ completes a workspace path · acceptance inserts path text only, never file content',
    '  !<command> runs your shell command locally (not as a model tool call)',
    '  Enter sends · Ctrl+J or trailing \\ + Enter inserts a newline · multiline paste never submits',
    '  Ctrl+O attaches one clipboard image to the next prompt; Ctrl+O again removes it',
    '  Ctrl+R searches this project’s prompt history · type to filter · Ctrl+R/Up/Down navigate · Tab/Enter accepts',
    '  Up/Down precedence: completion · Up queued-message take-back · prompt recall · cursor movement',
    '  Esc closes completion, cancels history search to its exact draft/cursor, or ends prompt recall',
    'editing and session:',
    '  Home/End or Ctrl+A/E moves to the visible row edge',
    '  Ctrl+K/U deletes to the row end/start · Ctrl+W deletes the previous word',
    '  Alt/Ctrl+Left/Right or Alt+B/F moves by word · Alt+Backspace/Alt+D deletes the word before/after',
    '  Ctrl+_ (or Ctrl+-) undoes the last Ctrl+K/U, Ctrl+W or Alt word deletion in the draft',
    '  /rewind branches conversation only; it never rolls back workspace files or side effects',
    '  /copy puts the last completed answer on the clipboard via OSC 52 (plus wl-copy/xclip/pbcopy when a display is present)',
    '  Ctrl+B toggles compact/expanded tool details',
    '  Ctrl+C cancels busy work; press again within 2s to exit (while idle, it exits)',
    '  Ctrl+D or /exit or /quit exits',
  );

  return lines.slice(0, MAX_HELP_LINES).map(boundedLine).join('\n');
}

import {
  BUILTIN_COMMAND_DESCRIPTIONS,
  BUILTIN_COMMAND_NAMES,
} from '../commands/custom-commands.js';

/** Hard report bounds: help is transcript history, never an unbounded catalogue dump. */
export const MAX_HELP_COMMANDS = 24;
export const MAX_HELP_LINES = 40;
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
    '  Ctrl+R searches this project’s prompt history · type to filter · Ctrl+R/Up/Down navigate · Tab/Enter accepts',
    '  Up/Down precedence: completion · Up queued-message take-back · prompt recall · cursor movement',
    '  Esc closes completion, cancels history search to its exact draft/cursor, or ends prompt recall',
    'editing and session:',
    '  Home/End or Ctrl+A/E moves to the visible row edge',
    '  Ctrl+K/U deletes to the row end/start · Ctrl+W deletes the previous word',
    '  /rewind branches conversation only; it never rolls back workspace files or side effects',
    '  Ctrl+B toggles compact/expanded tool details',
    '  Ctrl+C cancels busy work; press again within 2s to exit (while idle, it exits)',
    '  Ctrl+D or /exit or /quit exits',
  );

  return lines.slice(0, MAX_HELP_LINES).map(boundedLine).join('\n');
}

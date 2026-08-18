/**
 * Darwin's semantic visual language.
 *
 * Colour reinforces hierarchy, but never carries a state by itself: the stable
 * markers below survive ANSI stripping, monochrome terminals, logs, and pty tests.
 * Keep component-specific layout out of this module — it names roles, not boxes.
 */
export const visualColor = {
  identity: 'cyan',
  assistant: 'green',
  tool: 'blue',
  active: 'cyan',
  success: 'green',
  warning: 'yellow',
  danger: 'red',
  muted: 'gray',
} as const;

export const visualMarker = {
  identity: '◆',
  user: 'you>',
  assistant: 'darwin>',
  tool: 'tool ·',
  notice: {
    info: 'info ·',
    warn: 'warn !',
    error: 'error !',
  },
  activeTool: 'tool ·',
  completion: '❯',
  permission: '◆',
} as const;

export function noticeColor(severity: 'info' | 'warn' | 'error'): (typeof visualColor)[keyof typeof visualColor] {
  switch (severity) {
    case 'info':
      return visualColor.muted;
    case 'warn':
      return visualColor.warning;
    case 'error':
      return visualColor.danger;
  }
}

/**
 * Colour for one diff-toned row: additions succeed-green, removals danger-red.
 * The `+ `/`- ` markers on the row text stay the durable statement; this is the
 * enhancement layered over them.
 */
export function diffToneColor(tone: 'add' | 'remove'): (typeof visualColor)[keyof typeof visualColor] {
  return tone === 'add' ? visualColor.success : visualColor.danger;
}

/**
 * Colour for markdown code in an assistant answer — inline `` `code` `` spans
 * and fenced code block lines. The backticks and fences on the text stay the
 * durable statement (they survive ANSI stripping); this is the enhancement
 * layered over them, exactly like a diff row's tone.
 */
export const markdownCodeColor: (typeof visualColor)[keyof typeof visualColor] = visualColor.active;

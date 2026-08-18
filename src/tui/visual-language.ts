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
